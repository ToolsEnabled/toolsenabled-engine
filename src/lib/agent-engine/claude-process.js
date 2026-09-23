'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnHidden } = require('../proc/hidden-spawn');
const { ClaudeAdapter } = require('./claude-adapter');
const { deleteEnvNames, envValues } = require('../env-scrub');

const CLAUDE_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp@0.66.0';
const STDERR_LIMIT = 64 * 1024;
const DEFAULT_START_TIMEOUT_MS = 180_000;
const TEMP_CONFIG_PREFIX = 'toolsenabled-claude-acp-';

function assertSessionTransportSupported(environment = process.env) {
  if (require('../provider-session-isolation').isolationContext(environment)) {
    throw Object.assign(new Error('Use the official Claude CLI transport with a private named account in this development session.'),
      { code: 'AGENT_PROVIDER_ISOLATION_TRANSPORT_UNSUPPORTED' });
  }
}

function appendBounded(current, chunk, limit = STDERR_LIMIT) {
  const combined = current + chunk;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

function validateInvocation(command, args) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 32_768) {
    throw new TypeError('Claude ACP process command must be a bounded non-empty string');
  }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new TypeError('Claude ACP process args must be an array of strings');
  }
}

function resolveInvocation(command, args) {
  if (process.platform === 'win32' && /^npx(?:\.cmd)?$/i.test(path.basename(command))) {
    const npxEntry = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (fs.existsSync(npxEntry)) {
      return { command: process.execPath, args: [npxEntry, ...args] };
    }
    return { command: /\.cmd$/i.test(command) ? command : 'npx.cmd', args };
  }
  /* A bare, extensionless name on Windows is an npm shim family whose runnable
     member is the .cmd. Naming it beats asking for a shell: ../proc/hidden-spawn.js
     runs a .cmd through cmd.exe with an explicit argv, which is the hideable
     form and keeps the executable stateable. */
  const bare = process.platform === 'win32'
    && path.basename(command) === command
    && path.extname(command) === '';
  return { command: bare ? `${command}.cmd` : command, args };
}

/* Redact every credential VALUE reachable in `env`, found case-insensitively.
 *
 * This read only `env.ANTHROPIC_API_KEY` until 2026-08-11 -- the same exact-case
 * lookup bug as the deletes, on the OUTPUT path. The child resolves its
 * environment through the OS, which is case-insensitive, so a child handed
 * `anthropic_api_key` reads it canonically and can print it; the redactor looked
 * for a spelling that was not in the object and found nothing to replace.
 * MEASURED with real children through this transport: the canonical spelling
 * produced the redaction marker and leaked nothing, while the lowercase spelling
 * put the raw secret in front of a stderr observer with no marker at all. The
 * redaction was correct exactly when it was not needed.
 *
 * The name list is the credential set a Claude child can plausibly hold, not
 * just the API key: a redactor narrower than the environment it guards has the
 * same shape of hole, one name over. */
const REDACTED_ENV_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_BEDROCK_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
]);

function redactAnthropicApiKey(chunk, env) {
  let output = String(chunk);
  // envValues() returns values to be searched FOR, never to be logged. Longest
  // first, so a secret that contains another as a prefix is not half-replaced.
  const secrets = envValues(env, REDACTED_ENV_NAMES).sort((a, b) => b.length - a.length);
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
  return output;
}

function createClaudeAcpTransport(options = {}) {
  assertSessionTransportSupported(options.env);
  /* A MISSING `env` USED TO MEAN "the full ambient environment".
   *
   * `options.env === undefined ? process.env : options.env` handed an omitted
   * env straight to spawn(), so a caller that simply did not pass one gave the
   * Claude child every credential on the machine -- the same INHERITS_AMBIENT
   * shape tools/check-spawn-env-scrub.js exists to fail the build over, just
   * spelled as a default parameter instead of an absent option. The default is
   * now the scrubbed environment; a caller that wants an unscrubbed one has to
   * say so by constructing it. */
  const env = options.env === undefined ? scrubbedAmbientEnvironment() : options.env;
  const command = options.command === undefined
    ? ((env && env.CLAUDE_ACP_COMMAND) || process.env.CLAUDE_ACP_COMMAND || 'npx')
    : options.command;
  const args = options.args === undefined ? ['-y', CLAUDE_ACP_PACKAGE] : options.args;
  validateInvocation(command, args);

  const invocation = resolveInvocation(command, [...args]);
  /* Same defect codex-process.js carried, found there first and fixed here
   * rather than left as the odd one out. resolveInvocation() may return
   * `process.execPath` to run npx-cli.js directly, and process.execPath is only
   * `node` when the host IS node. In a PACKAGED Electron app it is the app's own
   * binary, which does not execute a script argument as Node unless
   * ELECTRON_RUN_AS_NODE is set -- so the child starts the app, ignores the
   * script, and exits 0 with no output. That reads as "ran fine, said nothing",
   * which is the hardest possible shape to diagnose from a log.
   *
   * Set only when re-entering our own binary as a script host; a plain
   * npx/npx.cmd spawn must not inherit it. */
  const childEnv = invocation.command === process.execPath
    ? { ...env, ELECTRON_RUN_AS_NODE: '1' }
    : env;
  const child = spawnHidden(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: childEnv,
    /* `env` is always treated as ambient by the shared spawn seam and scrubbed
       again. Only credentials the caller states separately may be restored
       after that scrub; presence in an env object is not evidence of intent. */
    credentialEnvironment: options.credentialEnvironment,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const dataListeners = new Set();
  const stderrListeners = new Set();
  let stderrBuffer = '';
  let exitInfo = null;
  let closing = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', chunk => {
    for (const listener of dataListeners) {
      try { listener(chunk); } catch { /* A transport observer cannot disrupt the child process. */ }
    }
  });

  child.stderr.on('data', chunk => {
    const safeChunk = redactAnthropicApiKey(chunk, env);
    stderrBuffer = appendBounded(stderrBuffer, safeChunk);
    for (const listener of stderrListeners) {
      try { listener(safeChunk); } catch { /* A stderr observer cannot disrupt the child process. */ }
    }
  });

  function notifyExit({ code = null, signal = null, error = null } = {}) {
    if (exitInfo) return;
    exitInfo = Object.freeze({ code, signal, error, stderr: stderrBuffer });
    for (const listener of dataListeners) {
      try { listener(null, exitInfo); } catch { /* Exit delivery is best effort. */ }
    }
  }

  child.once('error', error => notifyExit({ error }));
  child.once('exit', (code, signal) => notifyExit({ code, signal }));
  child.stdin.on('error', error => notifyExit({ error }));

  return {
    write(line) {
      if (typeof line !== 'string') throw new TypeError('Claude ACP process transport write() requires a string');
      if (closing || exitInfo || child.stdin.destroyed || !child.stdin.writable) {
        const detail = stderrBuffer.trim();
        throw new Error(`Claude ACP agent stdin is unavailable${detail ? `: ${detail}` : ''}`);
      }
      child.stdin.write(line);
    },

    onData(listener) {
      if (typeof listener !== 'function') throw new TypeError('Claude ACP process transport onData() requires a listener');
      dataListeners.add(listener);
      if (exitInfo) queueMicrotask(() => {
        if (dataListeners.has(listener)) listener(null, exitInfo);
      });
      return () => dataListeners.delete(listener);
    },

    close() {
      if (closing) return;
      closing = true;
      const failures = [];
      try { child.stdin.destroy(); } catch (error) { failures.push(error); }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (!child.kill()) failures.push(new Error('Claude ACP child process refused the termination signal'));
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Could not close the Claude ACP process transport');
    },

    onStderr(listener) {
      if (typeof listener !== 'function') throw new TypeError('Claude ACP process transport onStderr() requires a listener');
      stderrListeners.add(listener);
      if (stderrBuffer) listener(stderrBuffer);
      return () => stderrListeners.delete(listener);
    }
  };
}

function selectApiKeyAuthMethod(authMethods) {
  return authMethods.find(method => {
    const id = typeof method.id === 'string' ? method.id : '';
    const terminalAuth = method._meta && method._meta['terminal-auth'];
    const description = [id, method.name, method.title, method.description]
      .filter(value => typeof value === 'string')
      .join(' ');
    return !terminalAuth && /(?:api[-_ ]?key|apikey)/i.test(description) &&
      !/(?:oauth|device|subscription|claude[-_. ]?ai)/i.test(description);
  }) || null;
}

/* Everything a Claude session must not inherit, in one list so that the session
 * environment and the transport's own default cannot drift apart. */
const CLAUDE_SESSION_SCRUB_NAMES = Object.freeze([
  // Removed case-insensitively, then re-set ONLY from an explicitly stated key.
  // Deleting only `ANTHROPIC_API_KEY` would leave an `anthropic_api_key` behind
  // for the child to find -- and on this machine ANTHROPIC_API_KEY is persisted
  // in the user's own environment, so this is the variable most likely to
  // actually be there.
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // ANTHROPIC_BASE_URL redirects WHERE the session talks, and it was missing
  // while the five above were present. The list exists to force the owner's
  // Claude.ai subscription path: the three CLAUDE_CODE_USE_* variables are
  // redirectors to Bedrock/Vertex/Foundry, and this is the same class of
  // redirector -- it just points at an arbitrary host instead of a named
  // cloud. Inheriting it sends the session's prompts, its file contents, and
  // whatever credential it carries to that host, and the session still WORKS,
  // so there is no failure to notice. A redirected session and a correct one
  // look identical from inside the product.
  //
  // Not hypothetical drift: cli-provider-gateway.js and
  // subscription-launch-env.js both already strip it, and the latter's own
  // comment calls the inconsistency out. This was the one launch path of
  // three that did not.
  //
  // THE TRADE, STATED: an enterprise user fronting Anthropic with a gateway
  // cannot configure it through this variable any more. That is the same
  // trade the three CLAUDE_CODE_USE_* deletions already made, deliberately --
  // this function's whole job is "use the subscription, not a redirect" -- so
  // the cost is consistency with a policy already chosen, not a new
  // restriction.
  'ANTHROPIC_BASE_URL'
]);

/* The scrubbed ambient environment, with no credential re-added.
 *
 * Case-insensitive removal, because `delete env.X` is not sufficient on
 * Windows: the OS treats variable names case-insensitively while a plain object
 * does not, so a variable set as `anthropic_base_url` survived
 * `delete env.ANTHROPIC_BASE_URL` and the child read it anyway. Measured,
 * spawning a real child -- see src/lib/env-scrub.js for the numbers and why the
 * mechanism lives in one place instead of at each call site. */
function scrubbedAmbientEnvironment(overrides = {}) {
  return deleteEnvNames({ ...process.env, ...overrides }, CLAUDE_SESSION_SCRUB_NAMES);
}

function createSessionEnvironment(apiKey, configDir) {
  if (apiKey !== undefined && apiKey !== null && (typeof apiKey !== 'string' || apiKey.length === 0)) {
    throw new TypeError('Claude API key must be a non-empty string when provided');
  }
  const env = scrubbedAmbientEnvironment({ CLAUDE_CONFIG_DIR: configDir });
  /* RE-SET ONLY FROM A STATED KEY, NEVER FROM AMBIENT STATE.
   *
   * `apiKey` must be a value the CALLER chose. Until 2026-08-11 the public
   * wrapper startClaudeSession() defaulted it to `process.env.ANTHROPIC_API_KEY`,
   * so the ordinary path removed every casing of the ambient key above and then
   * put it straight back here. The fix removed it and then undid the fix.
   *
   * MEASURED: with only a lowercase `anthropic_api_key` in the parent, the
   * default path produced a real child reporting canonical ANTHROPIC_API_KEY
   * PRESENT; passing `undefined` explicitly produced ABSENT. Both tests of this
   * function passed `undefined`/`null` explicitly, so 29 green tests covered
   * only the path nobody takes. */
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

/* The API key a session runs with when the caller states none: NONE.
 *
 * This was `process.env.ANTHROPIC_API_KEY`, written as a default parameter on
 * startClaudeSession(). That single expression undid this module's entire
 * scrub: createSessionEnvironment() removes every casing of the ambient key and
 * then re-sets whatever the caller's `apiKey` holds, so defaulting it from
 * ambient state removed the key and immediately put it back. MEASURED with a
 * real child -- default path reported canonical ANTHROPIC_API_KEY PRESENT,
 * explicit `undefined` reported ABSENT. Both existing tests passed
 * `undefined`/`null` EXPLICITLY, so 29 green tests covered only the path no
 * production caller takes.
 *
 * It is a named function rather than a literal in the signature so that the
 * default is a VALUE A TEST CAN CALL. A default expression buried in a
 * destructuring pattern is reachable only by running the whole ACP session,
 * which is why the leak sat behind a green suite; this way
 * tests/agent-engine/claude-ambient-key-default.test.js spawns a real child
 * from exactly the value the wrapper would have used.
 *
 * A caller that genuinely wants API-key auth -- rather than the owner's
 * subscription, which is the entire point of this module -- must STATE the key. */
function defaultApiKey() {
  return null;
}

function removeTempConfigDir(configDir) {
  if (!configDir) return;
  const resolved = path.resolve(configDir);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(TEMP_CONFIG_PREFIX)) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Claude ACP start timeout must be a positive number');
  }
  let timeoutHandle;
  const timeout = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const error = new Error(`Timed out after ${timeoutMs}ms starting the Claude ACP session`);
      error.code = 'CLAUDE_ACP_START_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutHandle));
}

function attachProcessDiagnostics(error, exitInfo, stderr, cleanupErrors = []) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
  try {
    Object.defineProperty(error, 'claudeProcess', {
      configurable: true,
      value: Object.freeze({
        code: exitInfo ? exitInfo.code : null,
        signal: exitInfo ? exitInfo.signal : null,
        error: exitInfo ? exitInfo.error : null,
        stderr,
        cleanupErrors: Object.freeze([...cleanupErrors])
      })
    });
  } catch (diagnosticError) {
    if (cleanupErrors.length) {
      return new AggregateError(
        [error, ...cleanupErrors, diagnosticError],
        'Claude ACP startup and cleanup both failed',
        { cause: error }
      );
    }
    // Diagnostics must never replace the original failure.
  }
  return error;
}

function cleanupSessionResources(adapter, transport, configDir) {
  const errors = [];
  try { if (adapter) adapter.close(); } catch (error) { errors.push(error); }
  try { if (transport) transport.close(); } catch (error) { errors.push(error); }
  try { removeTempConfigDir(configDir); } catch (error) { errors.push(error); }
  return errors;
}

async function startClaudeSession({
  cwd,
  clientInfo,
  clientCapabilities,
  threadOptions = {},
  onEvent = null,
  apiKey = defaultApiKey(),
  startupTimeoutMs = DEFAULT_START_TIMEOUT_MS
} = {}) {
  assertSessionTransportSupported(process.env);
  let transport = null;
  let adapter = null;
  let configDir = null;
  let stderr = '';
  let exitInfo = null;
  try {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_CONFIG_PREFIX));
    const env = createSessionEnvironment(apiKey, configDir);
    transport = createClaudeAcpTransport({
      env,
      cwd,
      credentialEnvironment: apiKey ? { ANTHROPIC_API_KEY: apiKey } : undefined
    });
    transport.onStderr(chunk => {
      stderr = appendBounded(stderr, chunk);
    });
    transport.onData((chunk, info) => {
      if (chunk === null && info) exitInfo = info;
    });
    adapter = new ClaudeAdapter({ transport, defaultCwd: cwd, clientInfo, clientCapabilities });
    if (onEvent) adapter.onEvent(onEvent);

    const started = await withTimeout((async () => {
      await adapter.initialize();
      const authMethods = adapter.getAuthMethods();
      const sessionOptions = { ...threadOptions, cwd };
      let thread;
      try {
        thread = await adapter.startThread(sessionOptions);
      } catch (error) {
        if (!error || error.code !== 'ACP_AUTH_REQUIRED') throw error;
        const method = apiKey ? selectApiKeyAuthMethod(authMethods) : null;
        if (!method) throw error;
        await adapter.authenticate(method.id);
        thread = await adapter.startThread(sessionOptions);
      }
      return { threadId: thread.threadId, authMethods };
    })(), startupTimeoutMs);

    let closed = false;
    return {
      adapter,
      threadId: started.threadId,
      authMethods: started.authMethods,
      close() {
        if (closed) return;
        closed = true;
        const cleanupErrors = cleanupSessionResources(adapter, transport, configDir);
        if (cleanupErrors.length) {
          throw new AggregateError(cleanupErrors, 'Could not completely close the Claude ACP session');
        }
      }
    };
  } catch (error) {
    // Preserve the startup failure while carrying every cleanup failure with
    // it; cleanup uncertainty must not be reported as a completely clean exit.
    const cleanupErrors = cleanupSessionResources(adapter, transport, configDir);
    throw attachProcessDiagnostics(error, exitInfo, stderr, cleanupErrors);
  }
}

module.exports = {
  CLAUDE_SESSION_SCRUB_NAMES,
  createClaudeAcpTransport,
  // The default `apiKey` startClaudeSession() runs with. Exported so a test can
  // spawn a REAL child from the value the wrapper actually uses, instead of
  // re-typing `undefined` and testing a path production never takes.
  defaultApiKey,
  // Exported for its own test. A source-text assertion that the deletions are
  // written cannot see a caller that stopped using this function, which is the
  // failure mode that lets a "covered" scrub ship bypassed; the test asserts on
  // the object this actually returns.
  createSessionEnvironment,
  startClaudeSession
};

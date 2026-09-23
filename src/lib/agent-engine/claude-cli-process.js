'use strict';

/* SPAWNING THE OFFICIAL claude BINARY, AND NOTHING ELSE.
 *
 * This is the transport half of the first-party Claude engine; the protocol
 * mapping lives in claude-cli-adapter.js. Read that file's header first -- it
 * carries the licence reasoning and every measured event shape.
 *
 * claude-process.js spawns a third-party wrapper behind an isolated
 * configuration fence. This module instead spawns the official binary and may
 * use a caller-supplied configuration directory for a sign-in performed by the
 * customer through the official client.
 *
 * The CLAUDE_CONFIG_DIR rule has three parts:
 *
 *   a. NOTHING HERE INVENTS A DIRECTORY. `configDir` arrives from the caller or
 *      it does not arrive. This file never derives, defaults, guesses or
 *      constructs one, and never reads a configuration file to find one.
 *   b. NO DIRECTORY MEANS TODAY'S PATH, BYTE FOR BYTE. With no `configDir` the
 *      child gets exactly the environment it got before this revision and signs
 *      itself in through the normal official-client flow. That remains the
 *      default when no account-specific directory is selected.
 *   c. THE CREDENTIAL IS NEVER READ BY THIS PRODUCT. The customer signs in with
 *      `claude auth login` for the selected directory; this module names the
 *      directory and the official program performs authentication.
 *
 * All three are asserted against this file's SOURCE in
 * tests/agent-engine/claude-cli-process.test.js, in BOTH directions, because two
 * of them are absences of code and no behavioural test can observe an absence.
 */

const { spawnHidden, waitForRootSpawn } = require('../proc/hidden-spawn');
const { createStartupCleanup, DEFAULT_CLEANUP_TIMEOUT_MS, withOwnedStartupCleanup } = require('./codex-startup-cleanup');
const path = require('node:path');
const fs = require('node:fs');
const providerIsolation = require('../provider-session-isolation');
const toolchain = require('../providers/provider-toolchain');
const { ClaudeCliAdapter, ClaudeCliError, claudeArgs, claudeResumeArgs, claudeForkArgs, nativeModePolicyFor } = require('./claude-cli-adapter');
const { resumeRefusalFor } = require('./resume-provider-guard');
const { deleteEnvNames, envValues } = require('../env-scrub');
/* THE 4-SECOND BACKSTOP BELOW MUST TREE-KILL, NOT SIGNAL ONE PROCESS.
 * `--mcp-config` hands this child a tool server of its own to start, and a
 * child that ignored the polite stdin.end() is exactly a child whose own
 * children are least likely to have exited on their own either. A bare
 * child.kill() is TerminateProcess on Windows and reaches only the direct
 * child, so the tool server it started survives the session that owned it --
 * the same process-pair leak fleet-supervisor/kill-tree.js was written to
 * close for the lane/review/evidence killers. Reused here rather than
 * duplicated; see that file for why /T /F is required. */
const { killProcessTree } = require('../fleet-supervisor/kill-tree.js');

const STDERR_LIMIT = 64 * 1024;

/* WHAT THE CHILD MUST NEVER INHERIT, and this is not the same list as a scrub
 * for tidiness.
 *
 * Claude Code gives ANTHROPIC_API_KEY precedence over the claude.ai
 * subscription login. An inherited key can therefore route a session to a
 * metered account even while `claude auth status` reports a valid login.
 *
 * So this engine's entire purpose -- run on the person's own subscription --
 * depends on the key NOT reaching the child. Stripping it is not defensive
 * tidying; it is the mechanism.
 *
 * BASE_URL IS HERE FOR A DIFFERENT HARM. It redirects the conversation, and the
 * file contents it carries, to an arbitrary host. The session still starts,
 * still answers, and is indistinguishable from a correct one, so there is no
 * failure for anyone to notice.
 *
 * src/lib/providers/subscription-launch-env.js is the product's fuller answer
 * and the shell already applies it before calling in here. This list is the
 * floor, applied again locally, because an embedder or a test that calls this
 * module directly must not be able to reach a state the shell would have
 * prevented. Scrubbing twice costs nothing; scrubbing never is the whole
 * outage. */
const CREDENTIAL_ENV_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_BEDROCK_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
]);

function appendBounded(current, chunk, limit = STDERR_LIMIT) {
  const combined = current + chunk;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

/* THE CHILD'S LAST WORDS, ON DISK, WHILE IT IS STILL SPEAKING THEM.
 *
 * WHAT WAS LOST, AND HOW. `stderr` above lives in this process's memory and is
 * handed to the caller exactly once, in finish(), when the child ends. That is
 * enough when the CHILD dies. It is nothing at all when THIS process dies --
 * and on 2026-09-03 this process died about eight times between 19:30 and 21:26
 * local without ever running its will-quit path
 * (REPORT-crash-20260903/00-CONTROLLER-FINDINGS.md sections 1 and 2). Two of one
 * assistant's MCP servers had aborted out of memory at 21:11:56; the claude CLI
 * that owned them would have written that on its stderr, into this buffer, and
 * the buffer went with the app. There is no record anywhere on this machine of
 * what the CLI said about those deaths.
 *
 * So the same bytes go to a file as they arrive. Not instead of the buffer --
 * the exit path still hands the caller what it always did -- but beside it, in
 * the one place that survives a process that never gets to write anything down.
 *
 * BOUNDED THREE WAYS, because a log that fills a disk is its own incident: 256
 * KB per session, 50 files kept in the directory, and nothing written after the
 * cap. WRITTEN AFTER REDACTION, on the redacted chunk, so a credential that
 * reached the environment cannot reach the file either.
 *
 * SYNCHRONOUS, and that is a considered cost rather than an oversight: this is
 * the stderr of one child, it is silent in a healthy session, and 256 KB is the
 * most it can ever cost. An asynchronous queue would be the thing that is empty
 * at the moment the process is killed, which is the only moment this exists for.
 */
const STDERR_FILE_LIMIT = 256 * 1024;
const STDERR_FILES_KEPT = 50;
const STDERR_PREFIX = 'agent-stderr-claude-';

/* THE DIRECTORY IS ENSURED THROUGH runtime.ensureDir, NOT CREATED HERE, AND
 * THAT IS NOT A STYLE CHOICE. tests/agent-engine/claude-cli-process.test.js
 * asserts against this file's SOURCE that it never creates a directory of its
 * own, because doing so is how this module would start DERIVING a sign-in
 * folder instead of being handed one -- the security property that whole suite
 * exists to hold. Borrowing the runtime's own helper keeps the guard exactly as
 * strict as it was while still guaranteeing somewhere to write on an
 * installation whose logs/ has not been touched yet.
 *
 * The log sits beside the audit sinks already in logs/, under a prefix that
 * names it, so nobody has to be told where to look. */
function pruneStderrFiles(directory) {
  const entries = fs.readdirSync(directory).filter(name => name.startsWith(STDERR_PREFIX));
  if (entries.length <= STDERR_FILES_KEPT) return;
  const dated = entries.map(name => {
    let modified = 0;
    try { modified = fs.statSync(path.join(directory, name)).mtimeMs; } catch { modified = 0; }
    return { name, modified };
  }).sort((a, b) => a.modified - b.modified);
  for (const entry of dated.slice(0, dated.length - STDERR_FILES_KEPT)) {
    try { fs.rmSync(path.join(directory, entry.name), { force: true }); } catch { /* a log we could not prune is not a session failure */ }
  }
}

/* Returns a writer, or null when there is nowhere to write. NEVER THROWS: a
   session must not fail to start because its diagnostic log could not be
   opened. runtime is required lazily so a caller that only wants the transport
   shape does not pull the state-root resolution in. */
function durableStderrSink(childPid) {
  try {
    const { rootPath, ensureDir } = require('../runtime');
    const directory = rootPath('logs');
    ensureDir(directory);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(directory, `${STDERR_PREFIX}${childPid || 'unspawned'}-${stamp}.log`);
    let written = 0;
    fs.writeFileSync(file, `# claude CLI stderr, pid ${childPid}, opened ${new Date().toISOString()}
`, 'utf8');
    try { pruneStderrFiles(directory); } catch { /* pruning is housekeeping, not the point */ }
    return (chunk) => {
      if (written >= STDERR_FILE_LIMIT) return;
      const text = String(chunk);
      const room = STDERR_FILE_LIMIT - written;
      /* `>=` rather than `>`, so a chunk that lands exactly on the cap still
         says the log is full. Without it the last chunk fits, nothing is
         written afterwards, and the file ends mid-sentence with no sign that
         anything was dropped -- a silent truncation, which is the failure mode
         this whole change exists to end. */
      const slice = text.length >= room ? `${text.slice(0, room)}
# stderr log full; the rest is not kept.
` : text;
      written += text.length;
      try { fs.appendFileSync(file, slice, 'utf8'); } catch { /* the session outranks its log */ }
    };
  } catch {
    return null;
  }
}

/* Redact any credential VALUE that still reached the environment, before its
   text can reach an observer. Mirrors claude-process.js, including the reason
   that file gives: the lookup must be case-insensitive, because a child
   resolves environment names through a case-insensitive OS and can therefore
   print a value stored under a spelling an exact-case redactor never finds. */
function redactCredentials(chunk, env) {
  let output = String(chunk);
  const secrets = envValues(env, CREDENTIAL_ENV_NAMES).sort((a, b) => b.length - a.length);
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
  return output;
}

/* THE ENVIRONMENT THE CHILD ACTUALLY GETS.
 *
 * `env === undefined` DOES NOT MEAN "the whole ambient environment". That
 * fallback is exactly the defect codex-process.js documents and the shell had
 * to work around at every call site: a caller who simply forgot to pass an
 * environment handed the child every credential on the machine. Here an omitted
 * env means the ambient one MINUS the credentials, never the raw one, so the
 * careless path is the safe path rather than the dangerous one.
 *
 * PATH SURVIVES, and must: it is how `claude` is found at all. The scrub is a
 * named credential list, not a filter. */
function launchEnvironment(env) {
  const source = env === undefined || env === null ? process.env : env;
  const copy = { ...source };
  deleteEnvNames(copy, CREDENTIAL_ENV_NAMES);
  return copy;
}

/* WHICH SIGN-IN THE CHILD USES, when and only when a caller names one.
 *
 * ONE NAME, ONE VALUE, NOTHING ELSE TOUCHED. This is the entire mechanism by
 * which a session runs as one of the several accounts a person has, and its
 * whole surface is a single assignment. Everything that makes that safe is what
 * it does NOT do, so each is named here and asserted in the test:
 *
 *   - It does not run when `configDir` is absent, empty, or not a string. An
 *     omitted directory returns the environment IDENTICALLY, so the default path
 *     is not "the same as before in effect" but the same object contents.
 *   - It does not open, read, copy or move anything. It assigns a name.
 *   - It does not scrub, re-add, or reorder any other variable. The credential
 *     scrub above has already run and is not repeated, weakened or bypassed --
 *     ANTHROPIC_API_KEY is gone before this is reached, which is what keeps the
 *     session on the subscription rather than on a metered key.
 *   - It does not create the directory. A directory nobody has signed into is
 *     the official program's business to report, in its own words, to the person
 *     who owns the account. Making it here would manufacture a home that looks
 *     provisioned and is not.
 *
 * A RELATIVE PATH IS REFUSED rather than resolved. It would resolve against the
 * child's working directory -- the person's project folder -- and quietly create
 * a per-project sign-in nobody asked for. This is the same refusal
 * src/lib/runtime-state-root.js makes, for the same reason, in its own words:
 * "a relative value here would resolve against the process cwd, which for a
 * spawned child is not a place anyone chose."
 */
function configDirEnvironment(environment, configDir, { requireHome = true } = {}) {
  if (typeof configDir !== 'string' || configDir.trim().length === 0) {
    return providerIsolation.providerSessionEnvironment(environment, { provider: 'claude', requireHome });
  }
  const named = configDir.trim();
  if (!path.isAbsolute(named)) {
    throw new ClaudeCliError('CLAUDE_CLI_CONFIG_DIR_RELATIVE',
      'The folder for this sign-in has to be a full path, so the assistant signs in where you meant.');
  }
  environment.CLAUDE_CONFIG_DIR = path.resolve(named);
  return providerIsolation.providerSessionEnvironment(environment, { provider: 'claude', home: path.resolve(named), requireHome });
}

/* THE VERSION OF THE PROGRAM WE ACTUALLY RESOLVED.
 *
 * Provider behavior can change between client versions. Record the resolved
 * program's version at spawn time so a session receipt identifies the client
 * that actually ran rather than the one a caller assumed.
 *
 * BEST EFFORT AND NEVER FATAL. A version that cannot be read is null and the
 * session starts anyway: refusing to run because a diagnostic failed would turn
 * a record-keeping nicety into an outage. Windows retains its per-run promise
 * cache. Linux probes each launch using that launch's exact program and selected
 * account environment, without consulting an earlier session's ambient home.
 *
 * IT GOES THROUGH spawnHidden() LIKE EVERY OTHER CHILD THIS FILE STARTS, and
 * that is not a style choice: a direct child_process call here is exactly what
 * put a black console window on the desktop every time an agent started, and the
 * fence added with that fix refuses this file the direct import. There is no
 * hidden spawnSync, so this is asynchronous -- which is free here, because the
 * only caller is already inside an async start. */
let cliVersionPromise;
function claudeCliVersion({ command = 'claude', timeoutMs = 5_000, env, configDir = null } = {}) {
  // A Linux desktop can discover a different exact program after installation,
  // and each selected account has its own provider home. Do not reuse an
  // ambient probe from another launch. The Windows cache remains unchanged.
  const cache = process.platform !== 'linux' && !providerIsolation.isolationRequested(env);
  if (cache && cliVersionPromise !== undefined) return cliVersionPromise;
  const reading = new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      const environment = process.platform === 'linux' || providerIsolation.isolationRequested(env)
        ? configDirEnvironment(launchEnvironment(env), configDir, { requireHome: false })
        : launchEnvironment(undefined);
      const privateExecutable = providerIsolation.resolvePrivateProviderExecutable('claude', environment);
      const invocation = privateExecutable || resolveInvocation(command);
      child = spawnHidden(invocation.command, [...(privateExecutable?.prefixArgs || []), '--version'], {
        env: privateExecutable ? { ...environment, ...privateExecutable.env } : environment,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch { finish(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(null); }, timeoutMs);
    if (timer.unref) timer.unref();
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (text.length < 512) text += chunk; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', code => {
      clearTimeout(timer);
      const first = text.trim().split(/\r?\n/)[0];
      /* stdout from a failed probe is diagnostic text, not an established
         version. Preserve the unknown state unless --version itself
         succeeded, even when the failed program happened to print a line. */
      finish(code === 0 && first ? first.slice(0, 120) : null);
    });
  });
  if (cache) cliVersionPromise = reading;
  return reading;
}

/* WHAT THIS CLAUDE SUPPORTS, ASKED FROM ITS OWN --help (rc-0922).
 *
 * The owner: "we should really be able to handle these automatically so we
 * dont need to try to parent the codex version all the time". Nothing is
 * pinned to a Claude version: every option claude-cli-adapter.js passes is
 * listed in the provider toolchain (provider-toolchain.js, the `claude` row),
 * and this asks the program that is about to run whether it lists them.
 *   - a missing REQUIRED option refuses the start with its name, instead of a
 *     start that fails with no clear reason;
 *   - a missing OPTIONAL option (--effort) is dropped from the arguments and
 *     named on the session;
 *   - a probe that produced nothing -- timeout, crash, or a listing this cannot
 *     read -- is 'unknown', and the session starts exactly as before.
 * The answer is remembered per (realPath, size, mtime) of the program, so it is
 * asked once per copy and again after any update, including one made outside
 * the app. Same hidden-spawn seam and best-effort rules as claudeCliVersion(). */
const FEATURE_PROBE_TIMEOUT_MS = 5_000;
const FEATURE_PROBE_LIMIT = 65536;

function readableHelpResult(text) {
  const present = toolchain.featuresFromHelp('claude', text);
  if (!present) return null;
  const required = toolchain.rowFor('claude').features.list.filter(entry => entry.required);
  /* A listing that does not name --print, or names fewer than half of the
     required options, is not Claude's own help, or not one this can read:
     that is unknown, never "update needed". */
  if (!present.has('--print') || required.filter(entry => present.has(entry.name)).length < Math.ceil(required.length / 2)) return null;
  return toolchain.evaluateFeatures('claude', present);
}

function claudeCliFeatures({ command = 'claude', env, configDir = null, timeoutMs = FEATURE_PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    let child;
    let copy = null;
    try {
      const environment = configDirEnvironment(launchEnvironment(env), configDir, { requireHome: false });
      const privateExecutable = providerIsolation.resolvePrivateProviderExecutable('claude', environment);
      const invocation = privateExecutable || resolveInvocation(command);
      const target = privateExecutable ? privateExecutable.executablePath : invocation.command;
      if (typeof target === 'string' && path.isAbsolute(target)) {
        copy = toolchain.describeCopy('claude', target, { source: 'path' });
        const held = toolchain.recallProbe(copy);
        if (held) { finish(held); return; }
      }
      child = spawnHidden(invocation.command, [...(privateExecutable?.prefixArgs || []), '--help'], {
        env: { ...(privateExecutable ? { ...environment, ...privateExecutable.env } : environment), ...ownedSelfUpdateOff(target, env) },
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch { finish(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(null); }, timeoutMs);
    if (timer.unref) timer.unref();
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (text.length < FEATURE_PROBE_LIMIT) text += chunk; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', code => {
      clearTimeout(timer);
      const result = code === 0 ? readableHelpResult(text) : null;
      if (result && copy) toolchain.rememberProbe(copy, result);
      finish(result);
    });
  });
}

/* The start refuses only on a REQUIRED option the program lacks, and says
   which, so the person reads "update Claude Code" instead of a failed start. */
function refuseUnsupported(features) {
  if (!features || features.state !== 'update-needed') return;
  throw new ClaudeCliError('CLAUDE_CLI_UPDATE_NEEDED',
    `This Claude Code cannot run a ToolsEnabled session: it does not support ${features.missingRequired.join(', ')}. Update Claude Code, then start again.`);
}

/* An optional option the program lacks is left out of the arguments. */
function supportedThreadOptions(threadOptions, features) {
  if (!features || !features.missingOptional.includes('--effort') || !threadOptions || threadOptions.effort === undefined) return threadOptions;
  const { effort: _unsupported, ...rest } = threadOptions;
  return rest;
}

/* What the session handle reports, next to cliVersion: one word from the
   toolchain's closed set and the names of anything missing. */
function featureReceipt(features) {
  return features
    ? Object.freeze({ state: features.state, missingRequired: Object.freeze([...features.missingRequired]), missingOptional: Object.freeze([...features.missingOptional]) })
    : Object.freeze({ state: 'unknown', missingRequired: Object.freeze([]), missingOptional: Object.freeze([]) });
}

/* A copy ToolsEnabled installed into its own folder does not update itself
   while it runs: the version that passed its feature check is the one that
   runs, and ToolsEnabled's own Update replaces it side by side. A copy the
   person installed keeps updating itself the way they set it up. */
function ownedSelfUpdateOff(target, env) {
  const source = env === undefined || env === null ? process.env : env;
  return typeof target === 'string' && toolchain.isOwnedPath(target, { env: source })
    ? toolchain.selfUpdateEnvironment('claude', { owner: 'toolsenabled' })
    : {};
}

/* WHERE `claude` IS, resolved the way a launcher must rather than the way a
 * shell does.
 *
 * MEASURED, and it cost a probe run to learn: Node 22 refuses to spawn a `.cmd`
 * without a shell and throws EINVAL. %APPDATA%\npm ships three files per program
 * -- `claude`, `claude.cmd` and `claude.ps1` -- and the first is a bash script
 * that is not runnable here. So the npm layout's NATIVE binary is preferred, and
 * a bare command name is left for the caller's PATH with `shell` set on Windows,
 * which is the same shape resolveInvocation() takes in claude-process.js.
 *
 * It returns the invocation rather than just a path so the shell decision
 * travels with the command that needs it. */
function resolveInvocation(command, {
  platform = process.platform,
  appData = process.env.APPDATA,
  statSync = fs.statSync
} = {}) {
  if (command && command !== 'claude') {
    /* A bare, extensionless command name on Windows is an npm shim family, and
       the runnable member of it is the .cmd. Naming it here rather than asking
       for a shell keeps ../proc/hidden-spawn.js able to state what it started;
       it runs a .cmd through cmd.exe with an explicit argv, which is the
       hideable form. */
    const bare = platform === 'win32'
      && path.basename(command) === command
      && path.extname(command) === '';
    return { command: bare ? `${command}.cmd` : command };
  }
  if (platform === 'win32' && appData) {
    const native = path.join(
      appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'
    );
    try {
      if (statSync(native).isFile()) return { command: native };
    } catch (error) {
      /* A missing candidate establishes that PATH is the right fallback. Any
         other read failure establishes nothing: reporting the shim as the
         resolved command would make an unreadable installation look absent. */
      if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
        const failure = new ClaudeCliError(
          'CLAUDE_CLI_RESOLUTION_FAILED',
          'The Claude installation could not be inspected, so the program to start could not be established.'
        );
        failure.cause = error;
        throw failure;
      }
    }
  }
  return { command: platform === 'win32' ? 'claude.cmd' : 'claude' };
}

/**
 * A long-lived `claude` child, framed as newline-delimited JSON.
 *
 * `onData(handler)` delivers `(packet)` for each parsed line and `(null, exit)`
 * once when the child ends. That two-shape callback is the same contract the
 * codex transport uses, so the adapter above can be written without knowing
 * which engine it is talking to.
 */
function createClaudeCliTransport({
  command = 'claude', args = [], cwd, env, configDir = null,
  rootLaunch,
  /* Injectable so the durable-log rule can be asserted without writing into the
     running installation's own logs directory. Defaults to the real sink. */
  stderrSink = durableStderrSink,
} = {}) {
  const childEnv = configDirEnvironment(launchEnvironment(env), configDir);
  const privateExecutable = providerIsolation.resolvePrivateProviderExecutable('claude', childEnv);
  const invocation = privateExecutable || resolveInvocation(command);
  Object.assign(childEnv, ownedSelfUpdateOff(invocation.command, env));
  const child = spawnHidden(invocation.command, [...(privateExecutable?.prefixArgs || []), ...args], {
    cwd,
    env: privateExecutable ? { ...childEnv, ...privateExecutable.env } : childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    // The CLI launches workspace tools of its own. A Windows PID-tree walk
    // cannot find one after the CLI exits, so establish kernel containment
    // before the CLI runs its first instruction.
    containProcessTree: true,
    ...(rootLaunch ? { rootLaunch } : {})
  });
  const rootReady = rootLaunch ? waitForRootSpawn(child) : null;
  rootReady?.catch(() => {});
  const startupCleanup = createStartupCleanup(child);

  let buffered = '';
  let stderr = '';
  let handler = null;
  let ended = false;
  let spawnError = null;
  let closing = false;
  let childClosed = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  /* The durable copy. See durableStderrSink(): the in-memory buffer below is
     still the caller's, and this is the one that survives an app that dies
     without running its shutdown. */
  const sink = stderrSink(child.pid);
  child.stderr.on('data', chunk => {
    const redacted = redactCredentials(chunk, childEnv);
    stderr = appendBounded(stderr, redacted);
    if (sink) sink(redacted);
  });

  child.stdout.on('data', chunk => {
    if (ended) return;
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (!line || !handler) continue;
      let packet;
      try {
        packet = JSON.parse(line);
      } catch {
        /* stdout is the stream-json protocol, not a terminal. Treating text on
           it as harmless chatter can discard the result packet after a CLI
           protocol change and leave the active turn waiting for its timeout.
           End the protocol stream instead, so the adapter fails the turn now. */
        spawnError = new ClaudeCliError(
          'CLAUDE_CLI_PROTOCOL_INVALID',
          'The Claude program wrote a response that was not valid JSON.'
        );
        try { child.stdin.end(); } catch { /* protocol stream is already unusable */ }
        finish(null, null);
        return;
      }
      try {
        handler(packet);
      } catch (error) {
        /* The packet existed but its delivery could not be established. End
           the transport with that distinct answer rather than making it look
           as though no packet arrived and leaving the caller to time out. */
        spawnError = new ClaudeCliError(
          'CLAUDE_CLI_HANDLER_FAILED',
          'The Claude response arrived, but its receiver could not process it.'
        );
        spawnError.cause = error;
        try { child.stdin.end(); } catch { /* protocol stream is already unusable */ }
        finish(null, null);
        return;
      }
    }
  });

  const finish = (code, signal) => {
    if (ended) return;
    ended = true;
    if (handler) {
      try { handler(null, { code, signal, stderr, error: spawnError }); } catch { /* nothing left to tell */ }
    }
  };

  child.on('error', error => { spawnError = error; finish(null, null); });
  // A pipe write can fail asynchronously after send() has returned. Handle the
  // stream error as a session ending instead of an uncaught EventEmitter error.
  child.stdin.on('error', error => { spawnError = error; finish(null, null); });
  child.on('close', (code, signal) => { childClosed = true; finish(code, signal); });

  return {
    child,
    rootReady,
    onData(next) { handler = next; },
    send(message) {
      if (ended || !child.stdin.writable) {
        throw new ClaudeCliError('CLAUDE_CLI_CLOSED', 'The Claude program is no longer accepting input.');
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    get stderr() { return stderr; },
    closeForStartupFailure() {
      closing = true;
      return startupCleanup.confirmClosed(DEFAULT_CLEANUP_TIMEOUT_MS);
    },
    close() {
      // A protocol failure can end this transport while its OS child is alive.
      // It still needs the retained containment cleanup and its kill backstop.
      if (closing || childClosed) return;
      closing = true;
      try { child.stdin.end(); } catch { /* already gone */ }
      /* The child is asked to finish rather than killed outright: it has a
         transcript to flush, and a person who closes a tab should not lose the
         conversation they could otherwise resume. The kill is the backstop for
         a child that ignores the close, and it takes the child's own process
         tree with it -- see the require above. */
      const timer = setTimeout(() => {
        if (typeof child.terminateJob === 'function') {
          child.terminateJob().catch(() => { /* the retained wrapper still owns KILL_ON_JOB_CLOSE */ });
        } else {
          killProcessTree(child);
        }
      }, 4_000);
      if (timer.unref) timer.unref();
      child.once('close', () => clearTimeout(timer));
    }
  };
}

/* The shape the shell already knows, so a Claude session and a Codex session are
   interchangeable to everything above them: `{ adapter, threadId, close }`. */
function sessionHandle({ adapter, transport, threadId, extra = {}, cleanup = null }) {
  let closed = false;
  return {
    adapter,
    threadId,
    ...extra,
    close() {
      if (closed) return;
      closed = true;
      try { adapter.close(); } finally {
        try { transport.close(); } finally { if (cleanup) cleanup(); }
      }
    }
  };
}

/* THE PLAN IS ONE OBJECT, AND THAT IS THE JOIN. The confinement plan decides
 * what a session runs with -- WHICH tool file it reads (mcpConfig), WHICH
 * permission grant makes those tools callable (settings), WHICH permission mode
 * the recorded level maps to (claudePermissionMode), and on the withheld home
 * path WHICH home it signs in from (configDir) -- and they are only coherent
 * TOGETHER. A tool file with no grant is a session whose servers connect and then refuse
 * every call; a home with no tool file is an isolated session with zero product
 * tools. So a caller with a plan passes THE PLAN, and this reads the fields off
 * that one object; the individual options remain for embedders and tests that
 * have no plan, and passing both is refused by name rather than one silently
 * winning.
 *
 * THE SHIPPED PLAN CARRIES NO configDir, deliberately -- see
 * agent-session-confinement.js's note above prepareClaudeToolSurface(). Tools
 * arrive by argument and the session is never relocated, so nothing here can
 * reach an unrelated sign-in directory.
 *
 * Absent fields are absent flags -- a plan from an older payload that carries
 * only configDir produces exactly the session it produced before this seam
 * existed. */
function sessionFactsFrom({ plan = null, configDir = null, mcpConfig = null, settings = null, args = null }) {
  if (plan !== null && plan !== undefined) {
    if (typeof plan !== 'object' || Array.isArray(plan)) {
      throw new ClaudeCliError('CLAUDE_CLI_PLAN_INVALID',
        'The confinement plan for this session is not readable, so the session was not started.');
    }
    if (configDir !== null || mcpConfig !== null || settings !== null || (args !== null && args !== undefined)) {
      throw new ClaudeCliError('CLAUDE_CLI_PLAN_CONFLICT',
        'This session was given both a confinement plan and separate arguments or settings. One of them would silently lose, so the session was not started.');
    }
    if (plan.roleFunctionsOnly !== undefined && typeof plan.roleFunctionsOnly !== 'boolean') {
      throw new ClaudeCliError('CLAUDE_CLI_PLAN_INVALID', 'The native role-tool restriction is not a boolean.');
    }
    return {
      configDir: typeof plan.configDir === 'string' ? plan.configDir : null,
      mcpConfig: typeof plan.mcpConfig === 'string' ? plan.mcpConfig : null,
      settings: typeof plan.settings === 'string' ? plan.settings : null,
      permissionMode: typeof plan.claudePermissionMode === 'string' ? plan.claudePermissionMode : null,
      roleFunctionsOnly: plan.roleFunctionsOnly === true,
      agentApi: plan.agentApiMode ?? null
    };
  }
  /* AN EXPLICIT argv AND A TOOL FILE CANNOT BOTH WIN. `args` replaces the
     whole generated argv, so a tool file passed beside it would be silently
     discarded -- a confined home with no --mcp-config, loading whatever
     `.mcp.json` sits in the child's folder. That silence is the defect;
     the refusal is the fix. */
  if (args !== null && args !== undefined && (mcpConfig !== null || settings !== null)) {
    throw new ClaudeCliError('CLAUDE_CLI_MCP_CONFIG_CONFLICT',
      'This session was given both a complete argument list and a tool configuration. The arguments would silently drop the tools, so the session was not started.');
  }
  return { configDir, mcpConfig, settings, permissionMode: null };
}

/* A caller-supplied argv replaces the ENTIRE generated one, so an empty or
   malformed value cannot mean "the default": `[]` spawns the CLI bare -- an
   interactive session with no stream-json framing that the adapter waits on
   forever. Only undefined/null means "build the argv here". */
// Use the same launch ceiling for argv, advertised choices and adapter validation.
function nativeModePolicy(facts) {
  return nativeModePolicyFor(facts.permissionMode);
}

function explicitArgs(args) {
  if (args === null || args === undefined) return null;
  if (!Array.isArray(args) || args.length === 0 || args.some(value => typeof value !== 'string')) {
    throw new ClaudeCliError('CLAUDE_CLI_ARGS_INVALID',
      'The argument list given for this session is not a list of words, so the session was not started with it.');
  }
  return args;
}

async function cleanFailedClaudeStartup(error, adapter, transport, cleanup = null) {
  const nestedCleanup = typeof error?.retryCleanup === 'function' ? error.retryCleanup.bind(error) : null;
  let cleanupConfirmed = false;
  async function retryCleanup() {
    if (cleanupConfirmed) return;
    const errors = [];
    try { if (nestedCleanup) await nestedCleanup(); } catch (failure) { errors.push(failure); }
    try { if (adapter) adapter.close(); } catch (failure) { errors.push(failure); }
    try { if (transport) await transport.closeForStartupFailure(); } catch (failure) { errors.push(failure); }
    try { if (cleanup) cleanup(); } catch (failure) { errors.push(failure); }
    if (errors.length) {
      const failure = new AggregateError(errors, 'Claude startup cleanup could not be confirmed', { cause: error });
      failure.code = 'CLAUDE_START_CLEANUP_UNPROVEN';
      throw withOwnedStartupCleanup(failure, retryCleanup);
    }
    cleanupConfirmed = true;
  }
  await retryCleanup();
  throw withOwnedStartupCleanup(error, retryCleanup);
}

/**
 * Start a Claude session on the user's own sign-in.
 *
 * The argument shape mirrors startCodexSession() on purpose -- cwd, clientInfo,
 * threadOptions, onEvent, command, args, env -- because the shell chooses an
 * engine and then calls it, and a second calling convention would be a second
 * branch at that call site for every option.
 *
 * NOTHING IS SPENT HERE. The thread gets its id from `--session-id`, which we
 * generate, so a started session has a name before any turn and therefore
 * before any money. That was measured: `system/init` does not arrive until a
 * user message is sent, so reading the id off the stream would have required
 * spending a turn to learn what to call the thread.
 */
async function startClaudeSession({
  cwd,
  clientInfo = null,
  threadOptions = {},
  onEvent = null,
  command = 'claude',
  args = null,
  env,
  rootLaunch,
  configDir = null,
  /* The generated tool configuration for this session's tier and account, or
     null for the argv this engine has always produced. This file only FORWARDS
     it; what the flag means, and every refusal around it, is the argv
     builder's (claude-cli-adapter.js mcpConfigArgs). */
  mcpConfig = null,
  /* The permission grant that makes those tools callable (--settings). Same
     rule as mcpConfig: this file only FORWARDS it. */
  settings = null,
  /* The confinement plan, when the caller has one. See sessionFactsFrom(). */
  plan = null
} = {}) {
  let transport = null;
  let adapter = null;
  try {
    const facts = sessionFactsFrom({ plan, configDir, mcpConfig, settings, args });
    const givenArgs = explicitArgs(args);
    const seed = new ClaudeCliAdapter({ transport: NULL_TRANSPORT, clientInfo });
    const { threadId } = await seed.startThread(threadOptions);
    seed.close();
    const features = givenArgs ? null : await claudeCliFeatures({ command, env, configDir: facts.configDir });
    refuseUnsupported(features);

    transport = createClaudeCliTransport({
      command,
      args: givenArgs || claudeArgs({
        threadId,
        threadOptions: supportedThreadOptions(threadOptions, features),
        mcpConfig: facts.mcpConfig,
        settings: facts.settings,
        permissionMode: facts.permissionMode,
        roleFunctionsOnly: facts.roleFunctionsOnly,
        agentApi: facts.agentApi
      }),
      cwd,
      env,
      rootLaunch,
      configDir: facts.configDir
    });
    adapter = new ClaudeCliAdapter({ transport, clientInfo, modePolicy: nativeModePolicy(facts) });
    adapter.threadId = threadId;
    if (onEvent) adapter.onEvent(onEvent);
    if (rootLaunch) await transport.rootReady;
    return sessionHandle({
      adapter,
      transport,
      threadId,
      /* Reported so a surface can say WHICH sign-in served and WHICH version of
         the program answered, without asking a second source that could give a
         different answer. A name and a version string; never a credential. */
      extra: { configDir: facts.configDir || null, mcpConfig: facts.mcpConfig || null, settings: facts.settings || null, cliVersion: await claudeCliVersion({ command, env, configDir: facts.configDir }), cliFeatures: featureReceipt(features) }
    });
  } catch (error) {
    return cleanFailedClaudeStartup(error, adapter, transport);
  }
}

/**
 * Continue a conversation the CLI already holds.
 *
 * Its own function rather than a flag on the start above, for the reason
 * codex-process.js gives for the same split: the two build different argv, and
 * `--session-id` and `--resume` are mutually exclusive. Passing both is how a
 * resume quietly becomes a new thread wearing a familiar name.
 */
async function restoreClaudeSession({
  cwd,
  startupTimeoutMs = 60_000,
  clientInfo = null,
  threadOptions = {},
  onEvent = null,
  command = 'claude',
  args = null,
  env,
  rootLaunch,
  configDir = null,
  /* Forwarded exactly as on start: a resumed conversation continues under the
     same plan, so it keeps the same tool surface. */
  mcpConfig = null,
  /* Forwarded exactly as on start, for the same reason: a resumed conversation
     keeps the grant it had, or its tools stop being callable mid-conversation. */
  settings = null,
  /* The confinement plan, when the caller has one. See sessionFactsFrom(). */
  plan = null,
  threadId,
  /* THE PROVIDER THAT MINTED THIS THREAD, when the record has one. Absent means
     a thread from before 1.0.42 recorded it, which is permitted -- see
     resume-provider-guard.js for why absent cannot be treated as a mismatch. */
  threadProvider = null,
  forkSource = null
} = {}) {
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new TypeError('resumeClaudeSession requires the threadId of the conversation to continue');
  }
  /* BEFORE ANY SPAWN, AND THAT IS THE POINT. The obvious home for this is
     `resumeThread`, but by the time it runs the transport -- and therefore the
     child -- already exists, so a refusal there has already paid for the process
     it exists to avoid. */
  const refusal = resumeRefusalFor({ adapterProvider: 'claude', threadProvider });
  if (refusal) throw new ClaudeCliError(refusal.code, refusal.message);
  let transport = null;
  let adapter = null;
  let cleanup = null;
  try {
    const facts = sessionFactsFrom({ plan, configDir, mcpConfig, settings, args });
    const givenArgs = explicitArgs(args);
    let newThreadId = null;
    if (forkSource) {
      if (givenArgs || typeof facts.configDir !== 'string' || !path.isAbsolute(facts.configDir)
          || typeof forkSource.stageSource !== 'function' || typeof forkSource.assertSource !== 'function') {
        throw new ClaudeCliError('CLAUDE_EDITOR_FORK_INVALID', 'This copy needs a validated source and a generated confined session home.');
      }
      const seed = new ClaudeCliAdapter({ transport: NULL_TRANSPORT, clientInfo });
      newThreadId = (await seed.startThread(threadOptions)).threadId;
      seed.close();
      // The shell's private source receipt supplies this bounded operation.
      // This transport never reads a provider home or a credential itself.
      forkSource.assertSource();
      cleanup = forkSource.stageSource(facts.configDir);
      if (typeof cleanup !== 'function') throw new ClaudeCliError('CLAUDE_EDITOR_FORK_INVALID', 'The source import did not return its cleanup contract.');
      forkSource.assertSource();
    }
    const features = givenArgs ? null : await claudeCliFeatures({ command, env, configDir: facts.configDir });
    refuseUnsupported(features);
    transport = createClaudeCliTransport({
      command,
      args: givenArgs || (forkSource ? claudeForkArgs : claudeResumeArgs)({
        ...(forkSource ? { sourceThreadId: threadId } : {}),
        threadId: newThreadId || threadId,
        threadOptions: supportedThreadOptions(threadOptions, features),
        mcpConfig: facts.mcpConfig,
        settings: facts.settings,
        permissionMode: facts.permissionMode,
        roleFunctionsOnly: facts.roleFunctionsOnly,
        agentApi: facts.agentApi
      }),
      cwd,
      env,
      rootLaunch,
      configDir: facts.configDir
    });
    adapter = new ClaudeCliAdapter({ transport, clientInfo, modePolicy: nativeModePolicy(facts),
      expectedResumeThreadId: forkSource ? null : threadId,
      expectedFork: forkSource ? { sourceThreadId: threadId, threadId: newThreadId } : null });
    const resumed = await adapter.resumeThread(newThreadId || threadId, threadOptions);
    if (rootLaunch) await transport.rootReady;
    // Opening the process is not proof that --resume found its conversation.
    // The initialization acknowledgement costs no model turn and lets the
    // caller fall back before any user message is accepted by a dead child.
    if (!forkSource) await adapter.initialize({ timeoutMs: startupTimeoutMs });
    if (onEvent) adapter.onEvent(onEvent);
    return sessionHandle({
      adapter,
      transport,
      threadId: resumed.threadId,
      cleanup,
      extra: {
        ...(forkSource ? { threadCwd: cwd, sourceThreadId: threadId, forkIdentityPending: true } : {}),
        configDir: facts.configDir || null,
        mcpConfig: facts.mcpConfig || null,
        settings: facts.settings || null,
        cliVersion: await claudeCliVersion({ command, env, configDir: facts.configDir }),
        cliFeatures: featureReceipt(features)
      }
    });
  } catch (error) {
    return cleanFailedClaudeStartup(error, adapter, transport, cleanup);
  }
}

function resumeClaudeSession(options = {}) {
  return restoreClaudeSession({ ...options, forkSource: null });
}

function forkClaudeSession(options = {}) {
  return restoreClaudeSession({ ...options, forkSource: {
    stageSource: options.stageSource, assertSource: options.assertSource
  } });
}

/* A transport that goes nowhere, used only to mint a thread id before a child
   exists. It is here rather than inline so `startThread()` has exactly one
   implementation -- the adapter's -- instead of a second id-generating path
   that could drift from it. */
const NULL_TRANSPORT = Object.freeze({
  send() { throw new ClaudeCliError('CLAUDE_CLI_CLOSED', 'This session has no program behind it yet.'); },
  onData() {},
  close() {}
});

module.exports = {
  // Paired app contract: both start/resume retain the real child and await its
  // root boundary. An older engine ignoring an optional callback is NOT proof.
  ROOT_ADMISSION_CONTRACT_VERSION: 1,
  CREDENTIAL_ENV_NAMES,
  claudeCliFeatures,
  claudeCliVersion,
  configDirEnvironment,
  createClaudeCliTransport,
  durableStderrSink,
  launchEnvironment,
  resolveInvocation,
  startClaudeSession,
  resumeClaudeSession,
  forkClaudeSession
};

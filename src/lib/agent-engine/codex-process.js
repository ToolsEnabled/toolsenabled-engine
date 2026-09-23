'use strict';

const fs = require('node:fs');
const path = require('node:path');
const providerIsolation = require('../provider-session-isolation');
const { spawnHidden, resolveHiddenInvocation, waitForRootSpawn } = require('../proc/hidden-spawn');
const { CodexAdapter, CodexAdapterError, assertPinnedVersion } = require('./codex-adapter');
const { resumeRefusalFor } = require('./resume-provider-guard');
const { createStartupControl } = require('./startup-control');
const { DEFAULT_CLEANUP_TIMEOUT_MS, createStartupCleanup, cleanupFailure, validateCleanupTimeout, withOwnedStartupCleanup } = require('./codex-startup-cleanup');
/* MEASURED 2026-09-03: a session's app-server child is one half of a process
   PAIR. `codex.exe app-server` spawns its own `codex-code-mode-host.exe`
   child for tool execution, and that child is never told to end. A bare
   `child.kill()` below is TerminateProcess on Windows -- it reaches only the
   immediate child, so the code-mode host outlives the session that owned it.
   Census taken live: 24 processes -> 12 after twelve sessions ended, every
   surviving one a former pair's other half, ~110 MB each.
   fleet-supervisor/kill-tree.js already carries the fix for the identical
   defect in the lane/review/evidence child killers -- same cause, same
   platform, same remedy -- so this reuses it rather than growing a second
   copy that could drift. See kill-tree.js for why /T /F is required rather
   than a second polite signal. */
const { killProcessTree } = require('../fleet-supervisor/kill-tree.js');

const STDERR_LIMIT = 64 * 1024;
const VERSION_OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_VERSION_TIMEOUT_MS = 10_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;

function validateInvocation(command, args) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 32_768) {
    throw new TypeError('Codex process command must be a bounded non-empty string');
  }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new TypeError('Codex process args must be an array of strings');
  }
}

/* WHERE `codex` IS, and why the answer is not "the npm launcher".
 *
 * npm installs `codex` on Windows as bin/codex.js, a Node script whose last act
 * is `spawn(nativeBinary, argv, { stdio: 'inherit' })` -- no windowsHide. Run
 * that launcher from a process with no console (which is what the packaged app
 * is, and what windowsHide correctly makes this child) and Windows gives the
 * native codex.exe a NEW console WITH A WINDOW. Measured 2026-08-17: one
 * 895x518 black console window per session start, on a build that already
 * passed windowsHide: true here. A flag cannot reach a grandchild.
 *
 * So the launcher is resolved to the executable it would have started, by
 * ../proc/hidden-spawn.js, and that is what runs. The launcher contributes
 * nothing else a session needs.
 *
 * The `process.execPath` branch is still reached when the native binary cannot
 * be found on this machine's layout; ELECTRON_RUN_AS_NODE stays with it for the
 * reason documented below. */
function resolveInvocation(command, args, env) {
  if (process.platform === 'win32' && command === 'codex') {
    const appData = (env && env.APPDATA) || process.env.APPDATA;
    if (appData) {
      const entry = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(entry)) {
        return { command: process.execPath, args: [entry, ...args] };
      }
    }
    /* No npm layout to resolve, so the extension list IS the resolution -- but
       it has to be the WHOLE list, and it has to be searched. See
       resolveOnSearchPath() below for why naming `codex.cmd` was wrong. */
    const resolved = resolveOnSearchPath('codex', env);
    if (resolved) return { command: resolved, args };
    /* Nothing on this machine. The bare `.cmd` is kept as the last resort so a
       computer that genuinely has no Codex still fails the way it always has:
       cmd.exe answers 9009, detectCodexVersion() reads that as missing, and the
       person gets CODEX_CLI_NOT_FOUND with its install hint. */
    return { command: 'codex.cmd', args };
  }
  return { command, args };
}

const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function windowsPathExtensions(env) {
  const declared = (env && (env.PATHEXT || env.Pathext)) || process.env.PATHEXT || WINDOWS_DEFAULT_PATHEXT;
  const extensions = String(declared).split(';').map(value => value.trim()).filter(Boolean);
  return extensions.length > 0 ? extensions : WINDOWS_DEFAULT_PATHEXT.split(';');
}

/* WHY THE FALLBACK IS A SEARCH, AND WHY `codex.cmd` WAS NEVER THE ANSWER.
 *
 * This branch used to return the bare string `codex.cmd`, reasoning that PATH
 * resolution belongs to the spawn and that cmd.exe cannot execute a file
 * without an extension it recognises. Both halves of that are true. The
 * conclusion does not follow: `.cmd` is the shim NPM writes, and npm is exactly
 * the install the line above has already ruled out. Every other way Codex
 * reaches a Windows machine -- the winget package (OpenAI.Codex), a scoop shim,
 * a hand-placed portable copy -- lays down codex.exe and NO codex.cmd at all.
 * So the branch reached only by "not installed through npm" resolved a filename
 * that only an npm install ever creates, and could not find anything else.
 *
 * MEASURED 2026-08-23 on the owner's machine: codex-cli 0.146.1 installed
 * through winget and signed in, `codex --version` answering fine from a shell,
 * and every press of Start refused with CODEX_CLI_NOT_FOUND. cmd.exe returned
 * 9009 for `codex.cmd`, detectCodexVersion() reads 9009 as missing, and the
 * person was told to install a program they already had -- by a message whose
 * first instruction is `winget install OpenAI.Codex`, the one install shape
 * this branch could never resolve.
 *
 * PATHEXT ORDER IS CMD.EXE'S OWN ORDER, directory-major, which puts .EXE ahead
 * of .CMD. A native executable therefore wins over a shim in the same
 * directory, and spawnHidden runs it directly with no cmd.exe wrapper -- the
 * quieter path, and the one hidden-spawn's own launcher rule already prefers.
 *
 * IT ANSWERS FROM THE PATH IT IS GIVEN, deliberately, and does not go looking
 * for a second copy. On Windows a process can be holding a login-time PATH that
 * predates an install, but reconciling that against the registry is the HOST's
 * job and the host already does it: shell/agent-host.cjs composes the machine
 * search path and hands it down as this env. Reading the registry here as well
 * would put the same decision in two places and, worse, would defeat a caller
 * that pinned PATH on purpose -- which is how this module's own tests keep a
 * fixture from finding whatever Codex the test machine happens to have. */
function resolveOnSearchPath(name, env) {
  const declared = (env && (env.PATH || env.Path)) || process.env.PATH || '';
  const extensions = windowsPathExtensions(env);
  for (const directory of String(declared).split(path.delimiter)) {
    const trimmed = directory.trim().replace(/^"+|"+$/g, '');
    if (!trimmed) continue;
    for (const extension of extensions) {
      const candidate = path.join(trimmed, `${name}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (error) {
        /* ENOENT/ENOTDIR establishes that this candidate is absent. Any other
           failure establishes nothing: continuing would eventually turn an
           unreadable PATH into the definite (and user-facing) claim that
           Codex is not installed. Preserve that distinction for the caller. */
        if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
      }
    }
  }
  return null;
}

/* WHY THIS FUNCTION TOUCHES THE ENVIRONMENT AT ALL.
 *
 * resolveInvocation() runs codex.js through `process.execPath` rather than a
 * .cmd shim, which is correct and avoids a shell. But `process.execPath` is
 * only `node` when the host IS node. Inside a PACKAGED Electron app it is the
 * app's own binary -- `Mission Control.exe` -- and Electron does not execute a
 * script argument as Node unless ELECTRON_RUN_AS_NODE is set. Without it the
 * spawn becomes `"Mission Control.exe" codex.js --version`, which starts the
 * app, does nothing with the argument, and EXITS 0 WITH NO OUTPUT.
 *
 * detectCodexVersion() requires `code === 0 && output`, so an empty stdout on a
 * zero exit falls through to its failure branch and reports the self-
 * contradictory `Unable to run codex --version: exit code 0`. Measured
 * 2026-08-10 from a packaged build: that exact string, on a machine where
 * `codex --version` prints `codex-cli 0.146.0` and exits 0 from a normal shell.
 *
 * So this is a dev-only-works bug: in a checkout process.execPath is node and
 * everything passes, while every packaged install fails to start an agent. It
 * is the same ELECTRON_RUN_AS_NODE trap that produced several false findings
 * across this project, inverted -- here the flag is REQUIRED and was absent,
 * rather than present and unwanted.
 *
 * Only set when we are actually re-entering our own binary as a script host.
 * A plain `codex`/`codex.cmd` spawn must NOT inherit it: that would push the
 * flag into an unrelated child and cause the more familiar failure mode.
 */
function spawnCodex(command, args, { env, cwd, containProcessTree = false, rootLaunch, provider = 'codex' } = {}) {
  validateInvocation(command, args);
  if (!['codex', 'gemini', 'grok'].includes(provider)) {
    throw Object.assign(new Error('This shared process transport has no contract for the selected provider.'),
      { code: 'AGENT_CONFINEMENT_PROVIDER_INVALID' });
  }
  // ACP reuses the process custodian, but owns a different account and CLI.
  // Requiring CODEX_HOME here made a signed-in private Grok/Gemini session
  // fail; supplying one would instead have selected the wrong executable.
  const baseEnv = providerIsolation.providerSessionEnvironment(env === undefined ? process.env : env,
    { provider, requireHome: !args.includes('--version') });
  const privateExecutable = providerIsolation.resolvePrivateProviderExecutable(provider, baseEnv);
  const providerArgs = provider === 'codex' ? providerIsolation.codexFileCredentialArgs(args, baseEnv) : args;
  const invocation = privateExecutable
    ? { command: privateExecutable.command, args: [...privateExecutable.prefixArgs, ...providerArgs] }
    : resolveInvocation(command, providerArgs, baseEnv);
  /* ELECTRON_RUN_AS_NODE belongs ONLY to the branch that re-enters our own
     binary as a script host. hidden-spawn resolves the npm launcher to the
     native codex.exe whenever this machine has one, and that child must not
     inherit the flag -- see the note above this function for what the flag
     does to an unrelated child. So the decision is made against what will
     ACTUALLY be executed, not against what was asked for. */
  const executed = resolveHiddenInvocation(invocation.command, invocation.args, baseEnv);
  const launchedEnvironment = privateExecutable ? { ...baseEnv, ...privateExecutable.env } : baseEnv;
  const childEnv = executed.command === process.execPath
    ? { ...launchedEnvironment, ELECTRON_RUN_AS_NODE: '1' }
    : launchedEnvironment;
  return spawnHidden(invocation.command, invocation.args, {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    containProcessTree,
    ...(rootLaunch ? { rootLaunch } : {})
  });
}

function appendBounded(current, chunk, limit) {
  const combined = current + chunk;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

function createCodexProcessTransport({ command = 'codex', args = ['app-server'], env, cwd, rootLaunch, provider = 'codex' } = {}) {
  const child = spawnCodex(command, args, { env, cwd, containProcessTree: true, rootLaunch, provider });
  const rootReady = rootLaunch ? waitForRootSpawn(child) : null;
  rootReady?.catch(() => {});
  const startupCleanup = createStartupCleanup(child);
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
    stderrBuffer = appendBounded(stderrBuffer, chunk, STDERR_LIMIT);
    for (const listener of stderrListeners) {
      try { listener(chunk); } catch { /* A stderr observer cannot disrupt the child process. */ }
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
    rootReady,
    write(line) {
      if (typeof line !== 'string') throw new TypeError('Codex process transport write() requires a string');
      if (closing || exitInfo || child.stdin.destroyed || !child.stdin.writable) {
        const detail = stderrBuffer.trim();
        throw new Error(`Codex app-server stdin is unavailable${detail ? `: ${detail}` : ''}`);
      }
      child.stdin.write(line);
    },

    onData(listener) {
      if (typeof listener !== 'function') throw new TypeError('Codex process transport onData() requires a listener');
      dataListeners.add(listener);
      if (exitInfo) queueMicrotask(() => {
        if (dataListeners.has(listener)) listener(null, exitInfo);
      });
      return () => dataListeners.delete(listener);
    },

    close() {
      if (closing) return;
      closing = true;
      if (typeof child.terminateJob === 'function') {
        child.terminateJob().catch(() => {
          if (typeof child.terminateRetainedWrapper === 'function') {
            child.terminateRetainedWrapper().catch(() => {});
          }
        });
        return;
      }
      if (child.exitCode === null && child.signalCode === null) {
        // Tree kill, not a bare child.kill and not preceded by our own
        // stdin.destroy() -- see the require above and kill-tree.js.
        // MEASURED: destroying stdin here first, as this used to, gives the
        // tracked process an uncontrolled fast exit of its own (closing its
        // last active handle can be enough for it to end on its own) that
        // reliably wins the race against taskkill's own process-creation
        // time -- app-server exiting that way with exit code 0, not a
        // signal, every time it was observed. A process that ends on its
        // own like that has no more obligation to have reaped its own
        // code-mode-host child than any other exit does, so the race was
        // real, not cosmetic: it defeated the tree kill in the one case
        // this fix exists for. Killing the tree already takes this pipe
        // down with the rest of the process, so nothing here needs to
        // close it first.
        killProcessTree(child);
      } else {
        // Already gone; only our own dangling handle remains to tidy up.
        try { child.stdin.destroy(); } catch { /* already gone */ }
      }
    },

    closeForStartupFailure(timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS) {
      closing = true;
      return startupCleanup.confirm(timeoutMs);
    },

    closeForProtocolFailure() {
      closing = true;
      // Reuse authenticated whole-job closure, including retained outcomes and
      // retry custody. Root exit or a sent termination request is insufficient.
      return startupCleanup.confirm(DEFAULT_CLEANUP_TIMEOUT_MS);
    },

    onStderr(listener) {
      if (typeof listener !== 'function') throw new TypeError('Codex process transport onStderr() requires a listener');
      stderrListeners.add(listener);
      if (stderrBuffer) listener(stderrBuffer);
      return () => stderrListeners.delete(listener);
    }
  };
}

async function detectCodexVersion({
  command = 'codex', args = ['--version'], env, cwd, signal = null,
  provider = 'codex',
  timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  containProcessTree = false
} = {}) {
  validateCleanupTimeout(cleanupTimeoutMs);
  const startup = createStartupControl({
    signal, timeoutMs, label: 'Codex version detection', codePrefix: 'CODEX_VERSION_DETECTION'
  });
  let child = null;
  let cleanup = null;
  try {
    return await startup.wait(() => new Promise((resolve, reject) => {
      child = spawnCodex(command, args, { env, cwd, containProcessTree, provider });
      cleanup = createStartupCleanup(child);
      let stdout = '';
      let stderr = '';
      let spawnError = null;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout = appendBounded(stdout, chunk, VERSION_OUTPUT_LIMIT);
      });
      child.stderr.on('data', chunk => {
        stderr = appendBounded(stderr, chunk, VERSION_OUTPUT_LIMIT);
      });
      child.once('error', error => {
        spawnError = error;
      });
      child.once('close', code => {
        const output = stdout.trim() || stderr.trim();
        if (!spawnError && code === 0 && output) {
          resolve(output);
          return;
        }
        const details = (stderr.trim() || stdout.trim() || (spawnError && spawnError.message) || `exit code ${code}`);
        const missing = (spawnError && spawnError.code === 'ENOENT') || code === 127 || code === 9009 ||
          /(?:not recognized|not found|could not be found)/i.test(details);
        const error = new Error(`Unable to run ${command} --version: ${details}`);
        error.code = missing ? 'CODEX_CLI_NOT_FOUND' : 'CODEX_VERSION_DETECTION_FAILED';
        if (spawnError) error.cause = spawnError;
        reject(error);
      });
    }));
  } catch (error) {
    if (cleanup && (containProcessTree || startup.signal.aborted || !cleanup.closed)) {
      try { await cleanup.confirm(cleanupTimeoutMs); }
      catch (cleanupError) {
        throw cleanupFailure('CODEX_VERSION_CLEANUP_UNPROVEN', error, [cleanupError],
          () => cleanup.confirm(cleanupTimeoutMs));
      }
    }
    throw error;
  } finally {
    startup.dispose();
  }
}

/* A CODEX THAT CANNOT DO WHAT THIS SESSION NEEDS, SAID AS THAT.
 *
 * ToolsEnabled pins no Codex version: the adapter works with whichever Codex
 * answers the app-server protocol, and it learns optional features at runtime
 * (thread/settings/update falls back when a Codex lacks it). So the only real
 * incompatibility is a Codex whose app-server, at the start of a session,
 * either does not offer a request the session cannot do without, or answers
 * one in a shape the adapter cannot read. Both used to reach the person as the
 * generic mid-conversation CODEX_PROTOCOL_INVALID ("the agent connection
 * stopped responding correctly") or a bare JSON-RPC failure, neither of which
 * says that the installed Codex is the cause or what to do about it.
 *
 * Only these answers are translated, and only while a session is being opened:
 *   - a reply the adapter cannot read (CODEX_PROTOCOL_INVALID);
 *   - Codex's own answer for a request it does not have at all: -32600
 *     "unknown variant `<the method asked for>`" (the adapter's
 *     requestUnknown), for any start, resume or fork request;
 *   - JSON-RPC -32601 for initialize or thread/start only. Codex uses -32601
 *     for things it has but has "not supported yet" (thread/read of an
 *     unsaved thread answers it), so for resume or fork it proves nothing.
 * Everything else (timeouts, cleanup, sign-in, not-initialized) is unchanged.
 * The version is carried for the record and the log only; it is never
 * compared with a list. */
function startIncompatibility(error, codexVersion, { methodMissing }) {
  const unreadable = error?.code === 'CODEX_PROTOCOL_INVALID';
  const missing = error?.code === 'CODEX_APP_SERVER_ERROR'
    && (error.requestUnknown === true || (methodMissing && error.rpcCode === -32601));
  if (!unreadable && !missing) return error;
  const version = /(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(String(codexVersion || ''))?.[1] || null;
  const refusal = new CodexAdapterError('CODEX_CLI_INCOMPATIBLE', `The installed Codex${version ? ` ${version}` : ''} ${missing
    ? 'does not offer a request that a ToolsEnabled session needs'
    : 'answered the session start in a form this ToolsEnabled cannot read'}. Run "codex update" and start again.`);
  refusal.codexVersion = version;
  refusal.incompatibility = missing ? 'missing-request' : 'unreadable-answer';
  refusal.cause = error;
  return refusal;
}

async function cleanFailedStartup({ error, startup, adapter, transport, cleanupTimeoutMs, cleanupSource = null }) {
  const original = startup.signal.aborted && (error?.code === 'CODEX_VERSION_DETECTION_ABORTED'
    || error?.code === 'CODEX_VERSION_CLEANUP_UNPROVEN') ? startup.signal.reason : error;
  const nestedCleanup = typeof error?.retryCleanup === 'function' ? error.retryCleanup.bind(error) : null;
  let cleanupConfirmed = false;
  async function retryCleanup() {
    if (cleanupConfirmed) return;
    const errors = [];
    if (nestedCleanup) {
      try { await nestedCleanup(); } catch (cleanupError) { errors.push(cleanupError); }
    }
    try { if (adapter) adapter.close(); } catch (cleanupError) { errors.push(cleanupError); }
    try { if (transport) await transport.closeForStartupFailure(cleanupTimeoutMs); }
    catch (cleanupError) { errors.push(cleanupError); }
    try { if (cleanupSource) cleanupSource(); }
    catch (cleanupError) { errors.push(cleanupError); }
    if (errors.length) throw cleanupFailure('CODEX_START_CLEANUP_UNPROVEN', original, errors, retryCleanup);
    cleanupConfirmed = true;
  }
  // The owned version operation already attempted cleanup. Do not discard its
  // uncertainty or add another cleanup delay before telling the host to retain
  // the failed-start handle. A later Close calls the same retry function.
  if (error?.code === 'CODEX_VERSION_CLEANUP_UNPROVEN') {
    throw cleanupFailure('CODEX_START_CLEANUP_UNPROVEN', original, [error], retryCleanup);
  }
  await retryCleanup();
  throw withOwnedStartupCleanup(original, retryCleanup);
}

/* `env` exists so a caller can bind the session's CODEX_HOME.
 *
 * It is the mechanism src/lib/agent-session-confinement.js uses to keep a
 * `guided` or `standard` session out of the user's own Codex configuration --
 * measured as the only one that works, because `-c mcp_servers...` overrides on
 * the app-server argv are refused for HTTP-transport and plugin-declared servers
 * and silently ignored as a whole-table assignment. It is threaded through BOTH
 * spawns deliberately: version detection that read a different home than the
 * session would report the capabilities of a Codex the session is not running
 * under. Undefined keeps process.env, so every existing caller is unchanged. */
async function startCodexSession({
  cwd,
  clientInfo,
  threadOptions = {},
  onEvent = null,
  command = 'codex',
  args = ['app-server'],
  env,
  rootLaunch,
  signal = null,
  startupTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS
}) {
  validateCleanupTimeout(cleanupTimeoutMs);
  const startup = createStartupControl({
    signal, timeoutMs: startupTimeoutMs, label: 'Codex session startup', codePrefix: 'CODEX_START'
  });
  let transport = null;
  let adapter = null;
  try {
    startup.throwIfStopped();
    // This operation owns its child and observes startup.signal itself. Racing
    // it again would return before its cleanup outcome could reach the host.
    const codexVersion = await detectCodexVersion({ command, env, signal: startup.signal, containProcessTree: true, cleanupTimeoutMs });
    startup.throwIfStopped();
    assertPinnedVersion(codexVersion);
    transport = createCodexProcessTransport({ command, args, cwd, env, rootLaunch });
    adapter = new CodexAdapter({ transport, codexVersion, clientInfo });
    if (onEvent) adapter.onEvent(onEvent);
    if (rootLaunch) await startup.wait(() => transport.rootReady);
    await startup.wait(() => adapter.initialize())
      .catch(error => { throw startIncompatibility(error, codexVersion, { methodMissing: true }); });
    const started = await startup.wait(() => adapter.startThreadWithNativeModeSettings({ ...(cwd ? { cwd } : {}), ...threadOptions }))
      .catch(error => { throw startIncompatibility(error, codexVersion, { methodMissing: true }); });
    const { threadId } = started;
    let closed = false;
    return {
      adapter,
      threadId,
      nativeModeSettings: started.nativeModeSettings,
      nativeModeUnavailableReason: started.nativeModeUnavailableReason,
      close() {
        if (closed) return;
        closed = true;
        try { adapter.close(); } finally { transport.close(); }
      }
    };
  } catch (error) {
    await cleanFailedStartup({ error, startup, adapter, transport, cleanupTimeoutMs });
  } finally {
    startup.dispose();
  }
}

/* THE SAME SPAWN, CONTINUING A CONVERSATION INSTEAD OF OPENING ONE.
 *
 * Codex stores a thread on disk and `thread/resume` loads it back by id --
 * the whole history, the cwd it ran in, the model and the effort it had.
 * That is what "the agent restarts" means to a person: the same agent, its
 * own memory, not a summary handed to a stranger.
 *
 * This exists as its own function rather than a flag on the start above for
 * one concrete reason: startCodexSession ALWAYS calls startThread, so
 * resuming through it would materialise a throwaway thread on disk first --
 * a second rollout file, a second entry in every thread list, for a
 * conversation the person only ever had once.
 *
 * The returned shape is startCodexSession's, plus what the resume told us:
 * `turns` (the conversation, newest-bounded by the adapter), `reasoningEffort`
 * and `model` as the ENGINE reports them rather than as we requested them,
 * and the cwd the thread actually holds -- which the caller must check
 * against the folder it means to run in before trusting the session.
 */
async function restoreCodexSession({
  threadId,
  cwd,
  clientInfo,
  threadOptions = {},
  onEvent = null,
  command = 'codex',
  args = ['app-server'],
  env,
  rootLaunch,
  signal = null,
  startupTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  /* THE PROVIDER THAT MINTED THIS THREAD, when the record has one. Absent means
     a thread from before 1.0.42 recorded it, which is permitted -- see
     resume-provider-guard.js for why absent cannot be treated as a mismatch. */
  threadProvider = null,
  resumeSourcePath = null,
  resumeDatabaseHome = null,
  forkSourcePath = null,
  assertSource = null,
  stageSource = null
}) {
  validateCleanupTimeout(cleanupTimeoutMs);
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new TypeError('resumeCodexSession requires the threadId of the conversation to continue');
  }
  /* AHEAD OF detectCodexVersion, WHICH IS ITSELF A SPAWN. This path spawns
     twice -- the version probe and then the transport -- so a gate placed any
     later than this line has already started a program to run a conversation
     that does not belong to it. */
  const refusal = resumeRefusalFor({ adapterProvider: 'codex', threadProvider });
  if (refusal) throw new CodexAdapterError(refusal.code, refusal.message);
  if (forkSourcePath && (typeof stageSource !== 'function' || typeof assertSource !== 'function'
      || typeof env?.CODEX_HOME !== 'string' || !path.isAbsolute(env.CODEX_HOME))) {
    throw new CodexAdapterError('CODEX_EDITOR_FORK_INVALID', 'This copy needs a validated source and a generated confined session home.');
  }
  if (resumeSourcePath && (forkSourcePath || typeof assertSource !== 'function'
      || typeof resumeSourcePath !== 'string' || !path.isAbsolute(resumeSourcePath)
      || typeof env?.CODEX_HOME !== 'string' || !path.isAbsolute(env.CODEX_HOME))) {
    throw new CodexAdapterError('CODEX_RESUME_SOURCE_INVALID', 'Resume needs an owned rollout and a fresh confined session home.');
  }
  if (resumeDatabaseHome !== null && (!resumeSourcePath || typeof resumeDatabaseHome !== 'string'
      || !path.isAbsolute(resumeDatabaseHome) || resumeDatabaseHome.includes('\0') || resumeDatabaseHome.length > 32768)) {
    throw new CodexAdapterError('CODEX_RESUME_SOURCE_INVALID', 'Resume needs the owned native history database.');
  }
  const startup = createStartupControl({
    signal, timeoutMs: startupTimeoutMs, label: 'Codex session startup', codePrefix: 'CODEX_START'
  });
  let transport = null;
  let adapter = null;
  let sourceCleanup = null;
  let importedSourcePath = null;
  function removeImportedSource() {
    if (typeof sourceCleanup === 'function') sourceCleanup();
    sourceCleanup = null;
  }
  try {
    startup.throwIfStopped();
    if (resumeSourcePath) assertSource();
    if (forkSourcePath) {
      // The native 0.153 fork lookup needs an existing rollout in this
      // CODEX_HOME and rejects an external path as stale. The shell-issued
      // one-use receipt supplies a bounded source copy, never a provider home
      // or credential import. Validate it before the first process is spawned.
      assertSource();
      sourceCleanup = stageSource(env.CODEX_HOME);
      importedSourcePath = sourceCleanup?.sourcePath;
      const relative = typeof importedSourcePath === 'string'
        ? path.relative(env.CODEX_HOME, importedSourcePath) : null;
      if (typeof sourceCleanup !== 'function' || !relative || path.isAbsolute(relative)
          || relative === '..' || relative.startsWith('..' + path.sep)
          || !path.isAbsolute(importedSourcePath) || importedSourcePath === forkSourcePath) {
        throw new CodexAdapterError('CODEX_EDITOR_FORK_INVALID', 'The source import did not return a separate confined rollout and its cleanup contract.');
      }
      assertSource();
      startup.throwIfStopped();
    }
    const codexVersion = await detectCodexVersion({ command, env, signal: startup.signal, containProcessTree: true, cleanupTimeoutMs });
    startup.throwIfStopped();
    assertPinnedVersion(codexVersion);
    transport = createCodexProcessTransport({ command,
      args: resumeDatabaseHome ? [...args, '-c', 'sqlite_home=' + JSON.stringify(resumeDatabaseHome)] : args, cwd, env, rootLaunch });
    adapter = new CodexAdapter({ transport, codexVersion, clientInfo });
    if (onEvent) adapter.onEvent(onEvent);
    if (rootLaunch) await startup.wait(() => transport.rootReady);
    await startup.wait(() => adapter.initialize())
      .catch(error => { throw startIncompatibility(error, codexVersion, { methodMissing: true }); });
    if ((forkSourcePath || resumeSourcePath) && typeof assertSource === 'function') assertSource();
    const resumed = await startup.wait(() => forkSourcePath
      ? adapter.forkThreadFromPath(threadId, importedSourcePath, threadOptions)
      : resumeSourcePath ? adapter.resumeThreadFromPath(threadId, resumeSourcePath, threadOptions)
      : adapter.resumeThread(threadId, threadOptions))
      .catch(error => { throw startIncompatibility(error, codexVersion, { methodMissing: false }); });
    // A cleanup refusal must still enter the failed-start gate with ownership
    // of this newly forked child. Never throw it after returning the handle.
    removeImportedSource();
    let closed = false;
    return {
      adapter,
      threadId: resumed.threadId,
      nativeModeSettings: resumed.nativeModeSettings || null,
      nativeModeUnavailableReason: resumed.nativeModeSettings ? null
        : resumed.nativeModeUnavailableReason || 'CODEX_MODE_RESUMED_SETTINGS_UNAVAILABLE',
      turns: resumed.turns,
      turnCount: resumed.turnCount,
      threadCwd: resumed.cwd,
      model: resumed.model,
      reasoningEffort: resumed.reasoningEffort,
      close() {
        if (closed) return;
        closed = true;
        try { adapter.close(); } finally { transport.close(); }
      }
    };
  } catch (error) {
    await cleanFailedStartup({ error, startup, adapter, transport, cleanupTimeoutMs,
      cleanupSource: removeImportedSource });
  } finally {
    // Success removed the import above. Failure retains that same idempotent
    // removal in retryCleanup, alongside the child handle, until both finish.
    startup.dispose();
  }
}

async function resumeCodexSession(options) {
  return restoreCodexSession({ ...options, forkSourcePath: null });
}

async function forkCodexSession(options = {}) {
  if (typeof options.sourcePath !== 'string' || !path.isAbsolute(options.sourcePath)) {
    throw new TypeError('forkCodexSession requires the validated source rollout path');
  }
  return restoreCodexSession({ ...options, forkSourcePath: options.sourcePath });
}

module.exports = {
  RESUME_SOURCE_CONTRACT_VERSION: 2,
  ROOT_ADMISSION_CONTRACT_VERSION: 1,
  createCodexProcessTransport,
  detectCodexVersion,
  startCodexSession,
  resumeCodexSession,
  forkCodexSession
};

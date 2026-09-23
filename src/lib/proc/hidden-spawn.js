'use strict';

/* THE ONE PLACE A LONG-LIVED CHILD PROCESS IS STARTED, so "no console window
 * ever appears" is a property of the API rather than a habit at 40 call sites.
 *
 * WHAT WAS MEASURED, AND WHY windowsHide WAS NOT ENOUGH.
 *
 * Starting a Codex agent session from the packaged app popped a black console
 * window on the desktop, every time. `codex-process.js` already passed
 * `windowsHide: true`, so the obvious explanation -- a forgotten flag, or a
 * `.cmd` shim going through cmd.exe -- was wrong. It was attributed at the time
 * to a GRANDCHILD; see the correction below, which no longer supports that.
 *
 * THE VARIABLE EVERY ROW BELOW DEPENDS ON IS THE PARENT'S OWN CONSOLE STATE,
 * and an earlier version of this table did not name it. That omission made the
 * table read as "stdio: 'pipe' never produces a window", which is false and is
 * exactly the sentence that would talk the next author out of passing
 * windowsHide. RE-MEASURED 2026-08-18, parent state set explicitly with libuv's
 * two creation flags (`detached: true` -> DETACHED_PROCESS, no console;
 * `windowsHide: true` -> CREATE_NO_WINDOW), child reporting its own
 * GetConsoleWindow() / IsWindowVisible() / GetConsoleCP():
 *
 *   PARENT HAS NO CONSOLE (an installed GUI app started from the Start menu):
 *     spawn(exe, args, { stdio: 'pipe' })                    -> CONSOLE, VISIBLE
 *     spawn(exe, args, { stdio: 'pipe', windowsHide: true }) -> console, NO WINDOW
 *     spawn(exe, args, { stdio: 'inherit' })                 -> CONSOLE, VISIBLE
 *     spawn(exe, args, { stdio: 'inherit', windowsHide: true }) -> window exists, HIDDEN
 *     spawn('cmd string', { shell: true })                   -> CONSOLE, VISIBLE
 *     spawn('cmd string', { shell: true, windowsHide: true })-> console, NO WINDOW
 *
 *   PARENT HAS A CONSOLE WITH NO WINDOW (i.e. it was itself started with
 *   windowsHide, which is every child this module starts):
 *     all six of the above                                   -> the parent's
 *                                                               windowless
 *                                                               console,
 *                                                               inherited;
 *                                                               nothing on screen
 *
 * SO: stdio does NOT decide whether a window appears -- windowsHide does. From a
 * console-less parent, ANY console-subsystem child started without it gets a
 * brand new console WITH A VISIBLE WINDOW, whatever its stdio. `shell: true` is
 * not special either way. The two `inherit` rows differ from the `pipe` rows
 * only in HOW windowsHide suppresses the window (a hidden window rather than
 * none), which is a detail with no user-visible consequence.
 *
 * WHAT THE RE-MEASUREMENT DOES **NOT** SUPPORT, STATED BECAUSE THE NEXT READER
 * WILL OTHERWISE BUILD ON IT. The paragraph below explains the observed window
 * as a grandchild allocating a fresh console because ours gave the npm launcher
 * none. The second block of rows says otherwise: a child of a windowless-console
 * parent INHERITS that console in all six shapes, `stdio: "inherit"` and no
 * windowsHide included -- which is exactly the launcher's own spawn. So on this
 * machine, in 2026-08-18 conditions, that chain does not reproduce a visible
 * window, and the cause of the console the user still reports is NOT settled by
 * this file. What IS settled is the rule this module enforces: windowsHide is
 * the thing that decides, so every spawn gets it. Do not read the paragraph
 * below as a diagnosis; read it as the history of the change.
 *
 * `codex` on Windows is installed by npm as a Node launcher, bin/codex.js,
 * whose last act is:
 *
 *     spawn(binaryPath, process.argv.slice(2), { stdio: "inherit", env });
 *
 * -- inherited stdio, no windowsHide. That is the one row above that produces a
 * visible console. Because OUR spawn correctly gave the launcher no console,
 * the native codex.exe had none to inherit, so Windows allocated it a brand new
 * one WITH A WINDOW. Observed: a 895x518 ConsoleWindowClass window owned by
 * codex.exe, once per session start.
 *
 * A flag we pass cannot reach a grandchild. So the fix is to stop creating the
 * grandchild: resolve the launcher to the native executable it would have run
 * and start THAT directly, under our own windowsHide. The launcher does nothing
 * else that a session needs -- it resolves a path, forwards signals, and mirrors
 * an exit code, all of which the caller already does.
 *
 * THE RULES THIS MODULE ENFORCES, none of which a caller may opt out of:
 *
 *   1. `windowsHide` is always true. There is no option to turn it off; a
 *      caller that passes `windowsHide: false` is refused rather than obeyed,
 *      because "this one spawn may flash a window" is the request that put the
 *      window back last time.
 *   2. `shell: true` is refused. It DOES flash a window from a console-less
 *      parent -- see the corrected table above, where it behaves exactly like
 *      every other shape -- and it separately turns an argv array into a string
 *      cmd.exe re-parses, so this module could not state what it started. Rule 1
 *      would cover the window; rule 2 exists for the argv.
 *   3. A `.cmd`/`.bat` target is run through `cmd.exe /d /s /c call`, with
 *      shell:false and an explicit argv. Node cannot execute a batch file
 *      directly (EINVAL since Node 18.20), and this is the hideable form.
 *   4. A known Node launcher shim is resolved to its native executable, per
 *      rule 4's table below.
 *   5. With TOOLSENABLED_REFUSE_PROVIDER_SPAWN set in THIS process, every spawn
 *      is refused before anything is started. See below for why the switch is
 *      read where it is.
 *
 * STANDING-ORDERS.md class LOCAL-WORK rule 3 -- "console windows must never
 * flash" -- is the standing order this module mechanises.
 *
 * WHY A NO-PROVIDER SWITCH LIVES HERE, AND WHY IT READS process.env.
 *
 * tools/agent-dispatch-packaged-qa.mjs fenced provider spend by building a
 * child environment with no PATH, no APPDATA and no credentials. Measured
 * 2026-09-02: a real Codex worker started anyway, from the owner's roaming npm
 * install. An environment-only fence cannot work here, for two independent
 * reasons:
 *
 *   - shell/agent-host.cjs deliberately does NOT use the inherited PATH. It
 *     recomposes the machine search path from the REGISTRY (shell/
 *     machine-search-path.cjs), because a PATH inherited at login is stale.
 *     So truncating PATH in the child environment is bypassed BY DESIGN.
 *   - agent-engine/codex-process.js falls back to the ambient environment
 *     whenever a caller does not thread one through: `(env && env.APPDATA) ||
 *     process.env.APPDATA` and the same shape for PATH and PATHEXT.
 *
 * Both bypasses act on the CHILD environment being constructed. Neither can
 * touch THIS process's own process.env. That is the whole reason the switch is
 * read from process.env at call time and never from `options.env`: an option is
 * exactly what a caller can omit, which is how the codex fallbacks leak in the
 * first place. A gate that consulted the caller's environment would be
 * bypassable by the same mistake it exists to catch.
 *
 * It is read per call rather than latched at module load so a test can prove
 * both states in one process. That is not a weakness: in-process code that
 * wanted to spawn without the gate would simply call child_process.spawn
 * directly, so the boundary this defends is the caller-supplied environment,
 * not in-process good faith.
 *
 * ONLY '1' OR 'true' REFUSES. An unset, empty, or unrecognised value allows the
 * spawn, so an accidentally inherited empty variable cannot silently stop a
 * paying customer from starting an agent. The QA driver that wants the fence
 * sets it explicitly.
 *
 * THE FREE LOCAL TIER IS UNAFFECTED, because it does not come through here:
 * agent-engine/local-process.js never requires this module. The paid providers
 * do -- codex-process.js, claude-process.js and claude-cli-process.js are the
 * only requirers in src/ -- which is what makes this one function the single
 * gate every paid spawn passes through.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const {
  BILLING_TRIPWIRE,
  safeLaunchEnvironment,
} = require('../providers/subscription-launch-env');
const { spawnInJob } = require('../windows-job-control');
const { spawnLinuxOwned } = require('../linux-process-control');

const PROVIDER_SPAWN_REFUSAL_VARIABLE = 'TOOLSENABLED_REFUSE_PROVIDER_SPAWN';

/* Read from THIS process's environment, never from a caller's. See the module
   header for the two measured bypasses that make that distinction the whole
   point. Exported so a caller can ask the same question the gate asks, and so a
   test can pin the value semantics without spawning. */
function providerSpawnRefused(environment = process.env) {
  const value = environment ? environment[PROVIDER_SPAWN_REFUSAL_VARIABLE] : undefined;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

class HiddenSpawnError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HiddenSpawnError';
    this.code = code;
  }
}

/* Rule 4's table, declared rather than guessed.
 *
 * Each entry names a Node launcher script this product starts, and how to find
 * the native executable that launcher would have spawned with inherited stdio.
 * `resolve` is given the launcher's own path and returns an absolute
 * executable path, or null when this machine's layout does not have one -- in
 * which case the caller falls back to running the launcher itself, which is
 * still correct, just noisier.
 *
 * Keeping this a TABLE rather than a heuristic is deliberate: a heuristic that
 * guessed "this .js probably re-spawns something" would silently change what
 * executable the product runs, and the thing being fixed here is a window, not
 * a launcher.
 */
const WINDOWS_TARGET_TRIPLE = Object.freeze({
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc',
});

const PLATFORM_PACKAGE = Object.freeze({
  x64: '@openai/codex-win32-x64',
  arm64: '@openai/codex-win32-arm64',
});

function isMissingPathError(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function packageRootForLauncher(launcherPath) {
  const packageRoot = path.join(path.dirname(launcherPath), '..');
  try {
    return fs.realpathSync(packageRoot);
  } catch (error) {
    /* A nonexistent path is a definite "this layout is absent". Permission,
       I/O, and other failures are not: falling back to the lexical path would
       turn "could not inspect the package" into a confident resolution. */
    if (isMissingPathError(error)) return packageRoot;
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_LAUNCHER_INSPECTION_FAILED',
      `Could not inspect launcher package root ${packageRoot}: ${error.code || error.message}`,
    );
  }
}

/* Mirrors findCodexExecutable() in @openai/codex's bin/codex.js, including its
 * fallback order: the platform package's vendor directory first, then a vendor
 * directory beside the package root. Mirrored rather than imported because the
 * launcher is an ES module with top-level await that RUNS Codex on import --
 * requiring it to ask where the binary is would start a session. */
function resolveCodexNativeBinary(launcherPath) {
  if (process.platform !== 'win32') return null;
  const triple = WINDOWS_TARGET_TRIPLE[process.arch];
  const platformPackage = PLATFORM_PACKAGE[process.arch];
  if (!triple || !platformPackage) return null;

  const packageRoot = packageRootForLauncher(launcherPath);

  const candidates = [
    path.join(packageRoot, 'node_modules', ...platformPackage.split('/'), 'vendor', triple, 'bin', 'codex.exe'),
    path.join(packageRoot, 'vendor', triple, 'bin', 'codex.exe'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw new HiddenSpawnError(
        'HIDDEN_SPAWN_NATIVE_INSPECTION_FAILED',
        `Could not inspect native launcher candidate ${candidate}: ${error.code || error.message}`,
      );
    }
  }
  return null;
}

const NATIVE_LAUNCHER_SHIMS = Object.freeze([
  Object.freeze({
    id: 'openai-codex',
    /* %APPDATA%\npm\node_modules\@openai\codex\bin\codex.js and any other
       layout npm produces for the same package. */
    matches: launcher => /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i.test(launcher),
    resolve: resolveCodexNativeBinary,
    /* The launcher sets these before spawning the native binary; the native
       binary reads them to describe how it was installed. Preserved so that
       skipping the launcher does not change what Codex believes about itself. */
    env: launcher => {
      const packageRoot = packageRootForLauncher(launcher);
      return { CODEX_MANAGED_PACKAGE_ROOT: packageRoot, CODEX_MANAGED_BY_NPM: '1' };
    },
  }),
]);

function isBatchTarget(command) {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(String(command));
}

/**
 * Decide what will actually be executed, without executing it.
 *
 * Returns `{ command, args, env, resolved }`, where `resolved` names the rule
 * that fired ('native-launcher:<id>', 'batch', or null). Exported separately
 * from spawnHidden so a precondition check can ask "what would this start?"
 * and get the SAME answer the spawn will use -- a check that resolves a command
 * differently from the spawn is a check that can pass for a binary the spawn
 * will not find.
 *
 * `env` is the ADDITIONS this resolution requires, never a whole environment.
 */
function resolveHiddenInvocation(command, args = [], env = undefined) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new HiddenSpawnError('HIDDEN_SPAWN_COMMAND_INVALID', 'A command must be a non-empty string');
  }
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    throw new HiddenSpawnError('HIDDEN_SPAWN_ARGS_INVALID', 'Arguments must be an array of strings');
  }

  /* Rule 4: a Node launcher we know re-spawns a native binary with inherited
     stdio. The launcher is the FIRST argument here, not the command -- the
     command is whatever node/electron binary is hosting it. */
  if (args.length > 0) {
    const launcher = args[0];
    for (const shim of NATIVE_LAUNCHER_SHIMS) {
      if (!shim.matches(launcher)) continue;
      const native = shim.resolve(launcher);
      if (!native) break;
      return {
        command: native,
        args: args.slice(1),
        env: shim.env ? shim.env(launcher) : {},
        resolved: `native-launcher:${shim.id}`,
      };
    }
  }

  /* Rule 3: Node refuses to execute a batch file without a shell, and a shell
     is refused by rule 2. cmd.exe with an explicit argv is the hideable form
     that does not re-parse anything. `call` lets an absolute path with spaces
     work; /d skips AutoRun, /s fixes the quoting rule, /v:off keeps a `!` in
     an argument from being expanded. */
  if (isBatchTarget(command)) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', 'call', command, ...args],
      env: {},
      resolved: 'batch',
    };
  }

  return { command, args, env: {}, resolved: null };
}

/**
 * Start a child process that can never put a console window on the screen.
 *
 * Same shape as child_process.spawn(command, args, options), minus the options
 * that reintroduce the defect. Returns the ChildProcess.
 */
function spawnHidden(command, args = [], options = {}) {
  /* FIRST, ahead of every other check. A refusal must not depend on the options
     being well-formed, and nothing -- no resolution, no environment scrub, no
     filesystem probe -- should happen on a process that has been told not to
     start providers. */
  if (providerSpawnRefused()) {
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_PROVIDER_REFUSED',
      `Refusing to start ${typeof command === 'string' && command ? command : 'a provider process'}: `
        + `${PROVIDER_SPAWN_REFUSAL_VARIABLE} is set on this process, so no paid provider process was started.`,
    );
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new HiddenSpawnError('HIDDEN_SPAWN_OPTIONS_INVALID', 'Options must be a plain object');
  }
  if (options.shell) {
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_SHELL_REFUSED',
      'spawnHidden never runs a command through a shell; pass an executable and an argv array',
    );
  }
  if (Object.hasOwn(options, 'windowsHide') && options.windowsHide === false) {
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_VISIBLE_REFUSED',
      'spawnHidden cannot be asked to show a console window (STANDING-ORDERS.md LOCAL-WORK rule 3)',
    );
  }
  if (Object.hasOwn(options, 'containProcessTree') && typeof options.containProcessTree !== 'boolean') {
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_CONTAINMENT_INVALID',
      'spawnHidden containProcessTree must be true or false',
    );
  }
  const rootLaunch = options.rootLaunch;
  if (rootLaunch !== undefined && (!rootLaunch || options.containProcessTree !== true
      || typeof rootLaunch.beforeRootSpawn !== 'function' || typeof rootLaunch.spawned !== 'function')) {
    throw new HiddenSpawnError('HIDDEN_SPAWN_ROOT_GUARD_INVALID', 'A provider-root guard requires private synchronous admission and child-retention callbacks.');
  }
  const beforeRootSpawn = rootLaunch ? () => {
    const checked = rootLaunch.beforeRootSpawn();
    if (checked && typeof checked.then === 'function') {
      void Promise.resolve(checked).catch(() => {});
      throw new HiddenSpawnError('HIDDEN_SPAWN_ROOT_GUARD_INVALID', 'Provider-root admission must not yield before the OS launch.');
    }
  } : undefined;

  const invocation = resolveHiddenInvocation(command, args, options.env);

  /* THE ENVIRONMENT IS NEVER INHERITED BLIND. `spawn(cmd, args, { env: null })`
     is node's spelling of "inherit everything", so an omitted env must resolve
     to process.env explicitly rather than being passed through as undefined and
     then merged with the resolution's additions -- the merge would otherwise
     produce an env containing ONLY the additions and strip PATH, which is how
     the executable is found at all. */
  const baseEnv = options.env === undefined || options.env === null ? process.env : options.env;
  const childEnv = Object.keys(invocation.env).length
    ? { ...baseEnv, ...invocation.env }
    : baseEnv;

  /* Credentials are scrubbed from the ordinary environment even when a caller
     supplied that object. A credential that is genuinely intended for this
     child therefore travels through a separate, explicit channel and is
     overlaid only AFTER the ambient scrub. Inferring intent from presence in
     `options.env` would recreate the exact ambient-key leak the scrub prevents.

     This channel is deliberately limited to names the billing tripwire knows.
     It cannot become a generic post-scrub escape hatch, and errors name only the
     variable -- credential values never enter diagnostics. */
  const credentialEnvironment = options.credentialEnvironment === undefined
    ? {}
    : options.credentialEnvironment;
  if (
    credentialEnvironment === null
    || typeof credentialEnvironment !== 'object'
    || Array.isArray(credentialEnvironment)
  ) {
    throw new HiddenSpawnError(
      'HIDDEN_SPAWN_CREDENTIAL_ENVIRONMENT_INVALID',
      'spawnHidden credentialEnvironment must be an object of caller-stated credential variables',
    );
  }
  const allowedCredentialNames = new Set(BILLING_TRIPWIRE.map(name => name.toLowerCase()));
  for (const [name, value] of Object.entries(credentialEnvironment)) {
    if (!allowedCredentialNames.has(name.toLowerCase())) {
      throw new HiddenSpawnError(
        'HIDDEN_SPAWN_CREDENTIAL_NAME_INVALID',
        `spawnHidden credentialEnvironment cannot carry unrecognized variable ${name}`,
      );
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new HiddenSpawnError(
        'HIDDEN_SPAWN_CREDENTIAL_VALUE_INVALID',
        `spawnHidden credentialEnvironment variable ${name} must be a non-empty string`,
      );
    }
  }

  const {
    shell,
    windowsHide,
    env,
    credentialEnvironment: statedCredentials,
    containProcessTree = false,
    rootLaunch: privateRootLaunch,
    ...rest
  } = options;

  /* A PROVIDER SESSION IS A PROCESS TREE, NOT ONE PID.
   *
   * The direct CLI can exit while one of its tool processes is still walking a
   * workspace. On Windows that child is immediately orphaned, so taskkill /T
   * can no longer discover it from the dead CLI pid. Measured live on
   * 2026-09-03: one orphaned Git grep walked the development tree for 55
   * minutes, drove Defender to 223% process CPU, and survived an app restart.
   *
   * Long-lived provider transports opt into a Windows Job Object or Linux
   * subreaper/pidfd supervisor before their first instruction runs. The
   * wrapper owns the tree until it proves
   * zero active processes, including when the root exits first or this parent
   * disappears. Short probes keep the original direct-spawn path so version
   * checks do not pay for a containment supervisor.
   *
   * Explicit post-scrub credentials are not silently stripped by a second
   * scrub and are not handed to a generic containment helper as an escape
   * hatch. No current contained caller uses that channel; refuse the combined
   * shape if one ever tries. */
  if (containProcessTree && (process.platform === 'win32' || process.platform === 'linux')) {
    if (Object.keys(credentialEnvironment).length > 0) {
      throw new HiddenSpawnError(
        'HIDDEN_SPAWN_CONTAINMENT_CREDENTIALS_REFUSED',
        'A contained hidden child cannot use the post-scrub credential channel',
      );
    }
    const containedCwd = path.resolve(rest.cwd || process.cwd());
    const spawnContained = process.platform === 'win32' ? spawnInJob : spawnLinuxOwned;
    const child = spawnContained(invocation.command, invocation.args, {
      ...rest,
      cwd: containedCwd,
      env: safeLaunchEnvironment(childEnv, { context: 'hidden child process' }),
      shell: false,
      windowsHide: true,
      terminateDescendantsOnRootExit: true,
    }, { safeLaunchEnvironment, ...(beforeRootSpawn ? { beforeRootSpawn } : {}) });
    rootLaunch?.spawned(child);
    return child;
  }

  // No containment wrapper on this path. The same check runs immediately before
  // the direct root, after resolution and environment preparation, not earlier.
  // Keep the scrub and the explicitly validated credential overlay together;
  // ordinary caller env is never evidence of an intended credential.
  const directEnvironment = Object.assign(
    safeLaunchEnvironment(childEnv, { context: 'hidden child process' }),
    credentialEnvironment,
  );
  beforeRootSpawn?.();
  const child = nodeSpawn(invocation.command, invocation.args, {
    ...rest,
    env: directEnvironment,
    shell: false,
    windowsHide: true,
  });
  rootLaunch?.spawned(child);
  return child;
}

function waitForRootSpawn(child) {
  if (child.jobReady && typeof child.jobReady.then === 'function') return child.jobReady;
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('spawn', spawned); child.off('error', failed); child.off('close', ended); };
    const spawned = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const ended = () => failed(new HiddenSpawnError('HIDDEN_SPAWN_ROOT_ENDED', 'The provider root ended before its start could be observed.'));
    child.once('spawn', spawned); child.once('error', failed); child.once('close', ended);
  });
}

module.exports = {
  HiddenSpawnError,
  NATIVE_LAUNCHER_SHIMS,
  PROVIDER_SPAWN_REFUSAL_VARIABLE,
  providerSpawnRefused,
  resolveHiddenInvocation,
  spawnHidden,
  waitForRootSpawn,
};

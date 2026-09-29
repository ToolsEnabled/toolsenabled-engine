'use strict';

// THE PROBE -- step 4 of docs/design/INSTALLER-EXPERIENCE.md section 3.
//
// "Setup writes nothing and reports what it found." That sentence is the entire
// contract of this file and it is enforced by construction: nothing in this
// module creates, moves, or modifies a file. It opens listening sockets to find
// out which ports are free and closes them again, and it asks two command lines
// for their version numbers.
//
// WHY THE PROBE EXISTS SEPARATELY FROM THE PLAN. Every default that setup later
// applies has to be traceable to something observed, because `mcsetup explain
// <id>` promises to print the provenance of a value. A default with no observed
// basis is a guess, and a guess about a port or a runtime path is how a
// configuration is written that cannot start. Facts are gathered here, once;
// src/lib/setup/plan.js turns them into steps and carries the provenance forward.
//
// A PROBE MUST NOT FAIL THE SETUP. Every reading degrades to `null` with a stated
// reason rather than throwing. A machine that will not report its free disk space
// is still a machine someone can install on, and refusing to continue because a
// diagnostic was unavailable would fail a user for our convenience.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  SHELL_PORT_RANGE,
  BRIDGE_PORT_RANGE,
  LOOPBACK_HOST,
  resolveServicesRoot,
  machineRecordPath
} = require('./machine-record');

function commandVersion(command, args, { runner = spawnSync, env = process.env } = {}) {
  const result = runner(command, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000, env });
  if (result.error) {
    // ENOENT establishes absence. A timeout, permission failure, or other spawn
    // error establishes nothing about whether the command is installed, so do
    // not turn it into the confident `present: false` consumed by the plan.
    if (result.error.code === 'ENOENT') return { present: false, version: null };
    const error = new Error(
      `Could not determine whether ${command} is installed; this is NOT claiming it is absent.`,
      { cause: result.error }
    );
    error.code = 'SETUP_PROBE_COMMAND_UNMEASURED';
    throw error;
  }
  // A process that exited non-zero was necessarily present; only its version
  // could not be read. In particular, do not report the executable as absent.
  if (result.status !== 0) return { present: true, version: null };
  const text = `${result.stdout || ''}`.trim().split('\n')[0] || '';
  return { present: true, version: text.trim() || null };
}

/**
 * Is this port free RIGHT NOW, established by binding it rather than by reading a
 * list. A port table can be stale by the time it is parsed; a successful bind
 * cannot be.
 */
function portIsFree(port, { host = LOOPBACK_HOST } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const settle = (value) => {
      server.removeAllListeners();
      try { server.close(); } catch { /* already closing */ }
      resolve(value);
    };
    server.once('error', (error) => {
      // These errors establish that setup cannot bind this port. Other errors
      // (for example, an invalid/unavailable host) say nothing about the port
      // and must remain an inability to measure rather than "occupied".
      if (error && ['EADDRINUSE', 'EACCES'].includes(error.code)) settle(false);
      else settle(null);
    });
    server.once('listening', () => settle(true));
    try {
      server.listen(port, host);
    } catch (error) {
      if (error && ['EADDRINUSE', 'EACCES'].includes(error.code)) settle(false);
      else settle(null);
    }
  });
}

/**
 * The first free port in a range, or null with the range reported. Null is a real
 * answer here: nine occupied ports is a genuine condition the flow has wording
 * for, not an exception to throw at someone.
 */
async function firstFreePort(range, options = {}) {
  let notMeasured = false;
  for (let port = range.first; port <= range.last; port += 1) {
    // Sequential on purpose: binding ten sockets at once to find one free port
    // is a burst of listeners on a machine we are trying not to disturb.
    // eslint-disable-next-line no-await-in-loop
    const free = await portIsFree(port, options);
    if (free === true) return port;
    if (free === null) notMeasured = true;
  }
  // `null` means every port was measured and unavailable. `undefined` means a
  // contributing bind failed, so the range has no definite answer.
  return notMeasured ? undefined : null;
}

function pathExists(target, { stat = fs.statSync } = {}) {
  try {
    stat(target);
    return true;
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    // existsSync also returns false for access and I/O failures, collapsing
    // "could not inspect" into "missing". Refuse those failures instead.
    const unavailable = new Error(
      `Could not determine whether ${target} exists; this is NOT claiming it is absent.`,
      { cause: error }
    );
    unavailable.code = 'SETUP_PROBE_PATH_UNMEASURED';
    throw unavailable;
  }
}

function freeDiskBytes(directory, { statfs = fs.statfsSync } = {}) {
  try {
    const stats = statfs(directory);
    if (!stats || !Number.isFinite(stats.bavail) || !Number.isFinite(stats.bsize)) return null;
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * Everything setup knows about this computer before it changes anything.
 */
async function probeMachine(options = {}) {
  const {
    runner = spawnSync,
    env = process.env,
    execPath = process.execPath,
    exists = pathExists,
    homedir = os.homedir,
    servicesRoot: statedServicesRoot
  } = options;

  // Setup may be given an explicit --services-root. Probe that same directory;
  // resolving the default anyway would demand a runtime product identity for a
  // path the command will never use and would make the explicit isolation seam
  // unusable outside the Electron shell.
  const servicesRoot = statedServicesRoot || resolveServicesRoot({ env, homedir });
  const existingRecord = machineRecordPath(servicesRoot);

  const [shellPort, bridgePort] = await Promise.all([
    firstFreePort(SHELL_PORT_RANGE),
    firstFreePort(BRIDGE_PORT_RANGE)
  ]);

  return Object.freeze({
    observedAtMs: Date.now(),
    platform: process.platform,
    osRelease: os.release(),
    node: Object.freeze({ present: exists(execPath), path: execPath, version: process.version }),
    codex: Object.freeze(commandVersion('codex', ['--version'], { runner, env })),
    claude: Object.freeze(commandVersion('claude', ['--version'], { runner, env })),
    git: Object.freeze(commandVersion('git', ['--version'], { runner, env })),
    servicesRoot,
    alreadySetUp: exists(existingRecord),
    freeDiskBytes: freeDiskBytes(os.homedir()),
    shellPort: shellPort === undefined
      ? null
      : Object.freeze({ chosen: shellPort, range: SHELL_PORT_RANGE }),
    bridgePort: bridgePort === undefined
      ? null
      : Object.freeze({ chosen: bridgePort, range: BRIDGE_PORT_RANGE })
  });
}

module.exports = Object.freeze({
  probeMachine,
  portIsFree,
  firstFreePort,
  commandVersion,
  freeDiskBytes,
  pathExists
});

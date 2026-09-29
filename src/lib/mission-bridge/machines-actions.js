'use strict';

// The machines surface of the mission bridge: the direct link between two of
// the owner's computers, driven by the same single control the terminal uses
// (tools/direct-link.ps1 -On | -Off | -Status). Kept in its own file so
// actions.js does not grow another domain, exactly as research-actions.js is.
//
// WHY THIS EXISTS NOW. The owner's ruling is that the open-source Mission
// Control UI drives the product, and that the trees come together at ship time.
// This is the SERVER half of that seam, built ahead of the merge: the routes
// exist, are authenticated, kill-switch-gated and tested, so the ship-time work
// on the client is exactly four small files (mission-bridge.js ACTION_ROUTES,
// write-flags.js, write-surfaces.js, views/computers.js) and no server change.
//
// WHAT THIS LAYER OWNS, AND WHAT IT REFUSES TO OWN. It owns process bounds and
// the HTTP error shape. It deliberately owns NO link logic: direct-link.ps1 is
// the single authority for what ON, OFF and the report mean, and this file
// never re-derives or post-processes its verdicts. If a decision about the
// link is wrong, it is wrong in one file, and it is not this one.
//
// KILL SWITCH: all three actions are outward-by-default (none is added to
// NON_OUTWARD_ACTIONS in actions.js). -On enables a network listener, which is
// plainly outward. -Off and -Status could arguably join 'terminate' and
// 'status' in the kill-event carve-out — but widening that carve-out is a
// policy decision, and the safe default for a new action family is "refused
// during a kill event", which is what unknown actions already get.
//
// ELEVATION: -On may show one Windows permission prompt the first time a
// machine is set up. The bridge runs in the owner's interactive session, so
// the prompt lands on the owner's desktop, which is the intended flow ("press
// ON, approve the prompt"). If the bridge ever runs where no prompt can be
// shown, Start-Process -Verb RunAs fails, -On reports the named failure, and
// the receipt carries it — nothing hangs on a prompt nobody can see.

const path = require('node:path');
const { execFile } = require('node:child_process');
const { MissionBridgeError } = require('./errors');
const { safeLaunchEnvironment } = require('../providers/subscription-launch-env');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Bounds sized to the tool's own worst cases, with margin: -Status is a
// read-only sweep (~15s worst); -On polls up to 180s for the pair to connect
// and may wait on a permission prompt; -Off waits up to ~20s for listeners to
// drain plus one keeper tick.
const TIMEOUT_MS = Object.freeze({ status: 90_000, on: 420_000, off: 180_000 });
const OUTPUT_BUDGET_BYTES = 256 * 1024;

function refuse(code, message, { status = 400 } = {}) {
  throw new MissionBridgeError(code, message, { status });
}

function createMachinesActions(options = {}) {
  const execFileImpl = options.execFile || execFile;
  const root = options.root || ROOT;
  const policyApi = options.policy || require('../policy');
  const isOutward = options.isOutward
    || (action => require('./actions').isOutwardMissionBridgeAction(action));

  function guard(action) {
    try { policyApi.assertActive(`mission.bridge.${action}`, { outward: isOutward(action) }); }
    catch (error) { refuse('BRIDGE_GUARD_REFUSED', String(error?.message || 'The local policy refused the action.').slice(0, 300), { status: 409 }); }
  }

  function runDirectLink(args, timeoutMs) {
    return new Promise(resolve => {
      const child = execFileImpl(POWERSHELL, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(root, 'tools', 'direct-link.ps1'), ...args
      ], {
        cwd: root,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: OUTPUT_BUDGET_BYTES,
        // powershell is a general interpreter and is NEVER allowlist-exempt
        // from spawn-environment scrubbing: whatever it runs inherits this
        // environment and could reach a provider CLI.
        env: safeLaunchEnvironment(process.env, { context: 'mission-bridge:machines-link' })
      }, (error, stdout, stderr) => {
        resolve({
          // execFile reports non-zero exit as an error object; that is an
          // OUTCOME here (direct-link exits 1 for "off did not complete"),
          // not a transport failure. Transport failures have no exit code.
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          timedOut: Boolean(error && error.killed),
          spawnFailed: Boolean(error && typeof error.code === 'string'),
          stdout: String(stdout || ''),
          stderr: String(stderr || '')
        });
      });
    });
  }

  async function statusReport() {
    const run = await runDirectLink(['-Status', '-Json'], TIMEOUT_MS.status);
    if (run.spawnFailed || run.timedOut) {
      refuse('MACHINES_LINK_UNAVAILABLE', 'The direct-link control could not be run on this machine.', { status: 503 });
    }
    // -Status always exits 0 and prints exactly one JSON object; anything else
    // is a broken installation, and saying so beats guessing.
    if (run.exitCode !== 0) {
      refuse('MACHINES_LINK_UNAVAILABLE', 'The direct-link control did not complete its status check.', { status: 503 });
    }
    const text = run.stdout.trim();
    try {
      return JSON.parse(text.slice(text.indexOf('{')));
    } catch {
      refuse('MACHINES_LINK_UNAVAILABLE', 'The direct-link control did not produce a readable report.', { status: 503 });
    }
  }

  // One verb action. The receipt is the tool's own report, taken AFTER the verb
  // ran, plus the verb's exit code — the report is the state, the exit code is
  // whether the verb achieved it, and neither is inferred from the other.
  async function verb(action, flag, timeoutMs) {
    guard(action);
    const run = await runDirectLink([flag], timeoutMs);
    if (run.spawnFailed) {
      refuse('MACHINES_LINK_UNAVAILABLE', 'The direct-link control could not be run on this machine.', { status: 503 });
    }
    if (run.timedOut) {
      refuse('MACHINES_LINK_TIMEOUT', 'The direct-link control did not finish in time; run tools/direct-link.ps1 -Status in a terminal to see where it stopped.', { status: 503 });
    }
    const report = await statusReport();
    return Object.freeze({
      ok: true,
      receipt: Object.freeze({
        action,
        exitCode: run.exitCode,
        completed: run.exitCode === 0,
        report
      })
    });
  }

  return Object.freeze({
    machinesLinkStatus: async () => {
      guard('machines-link-status');
      const report = await statusReport();
      return Object.freeze({ ok: true, receipt: Object.freeze({ action: 'machines-link-status', report }) });
    },
    machinesLinkOn: () => verb('machines-link-on', '-On', TIMEOUT_MS.on),
    machinesLinkOff: () => verb('machines-link-off', '-Off', TIMEOUT_MS.off)
  });
}

module.exports = Object.freeze({ createMachinesActions, MACHINES_LINK_TIMEOUT_MS: TIMEOUT_MS });

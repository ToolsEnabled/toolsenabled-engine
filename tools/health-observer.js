#!/usr/bin/env node
'use strict';

// Health observer CLI (R93 Phase 4).
//
//   node tools/health-observer.js --once [--json]   one sweep, print, exit
//   node tools/health-observer.js --serve           sweep forever
//   node tools/health-observer.js --read [--json]   read the snapshot as a
//                                                   CONSUMER, with reader-side
//                                                   staleness applied
//
// This process is the thing that would have noticed. On 2026-07-29 the fleet
// supervisor was down for 45 minutes and the only reason anyone found out was
// that the owner asked. A monitor armed at 05:20 detected it in under 60
// seconds -- the signal was always there, nobody was looking.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const observer = require('../src/lib/supervision/observer.js');
const observerLock = require('../src/lib/supervision/lock.js');
const health = require('../src/lib/health-invariants.js');
const managedProcesses = require('../src/lib/managed-processes.js');
const directiveInbox = require('../src/lib/owner-directive-inbox.js');

const ROOT = managedProcesses.ROOT;
const LOG_FILE = path.join(ROOT, 'logs', 'health-observer.log');
const AUDIT_CHECKPOINT_DIR = path.join(ROOT, 'state', 'audit-checkpoints');
const AUDIT_CHECKPOINT_TOOL = path.join(ROOT, 'tools', 'audit-durability-check.js');
const AUDIT_CHECKPOINT_TIMEOUT_MS = 60_000;
const PROCESS_VISIBILITY_REFRESH_TOOL = path.join(ROOT, 'tools', 'process-visibility-refresh.js');
const PROCESS_VISIBILITY_REFRESH_TIMEOUT_MS = 30_000;
// Matches this observer's own repetitionMinutes in config/managed-processes.json.
// The floor is enforced from the OUTBOX rather than from a timer, so a restarted
// or double-started observer cannot turn a 15-minute cadence into a hot loop
// around a ~4s full-chain verification.
const AUDIT_CHECKPOINT_MIN_INTERVAL_MS = 15 * 60 * 1000;

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 || index === argv.length - 1 ? fallback : argv[index + 1];
};

function appendLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ atMs: Date.now(), ...entry })}\n`, 'utf8');
  } catch {
    // Logging must never take down the thing that watches everything else.
  }
}

function stateCounts(snapshot) {
  const counts = {};
  for (const verdict of Object.values(snapshot.subsystems || {})) {
    counts[verdict.state] = (counts[verdict.state] || 0) + 1;
  }
  return counts;
}

function printHuman(snapshot) {
  const order = [health.STATE.DOWN, health.STATE.DEGRADED, health.STATE.UNKNOWN,
    health.STATE.QUARANTINED, health.STATE.STOPPED, health.STATE.OK];
  const rank = state => {
    const index = order.indexOf(state);
    return index === -1 ? order.length : index;
  };
  const rows = Object.values(snapshot.subsystems || {})
    .sort((a, b) => rank(a.state) - rank(b.state) || a.id.localeCompare(b.id));

  if (snapshot.stale) {
    process.stdout.write(`STALE SNAPSHOT: ${snapshot.reason}\n\n`);
  }
  for (const verdict of rows) {
    process.stdout.write(`${verdict.state.padEnd(12)} ${verdict.id.padEnd(24)} ${verdict.reason}\n`);
  }
  const counts = stateCounts(snapshot);
  process.stdout.write(`\n${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}\n`);
}

// Escalate a transition into the owner directive inbox. The controller already
// drains this on every wake, and it touches none of the files other agents own.
// `overrides` is passed straight through to the inbox (it accepts inboxFile),
// so tests can exercise real escalation without ever writing to the owner's
// actual directive inbox. A test that pollutes the owner's inbox is a test
// nobody will run.
function escalate(transitions, nowMs, overrides = {}) {
  const appended = [];
  for (const transition of transitions) {
    if (!transition.escalate && !transition.recovered) continue;
    try {
      const result = directiveInbox.append({
        text: observer.describeTransition(transition),
        source: 'health-observer',
        submittedBy: 'health-observer',
        idempotencyKey: observer.transitionKey(transition, nowMs)
      }, overrides);
      if (!result.replayed) appended.push(transition.id);
    } catch (error) {
      appendLog({ event: 'escalation-failed', id: transition.id, error: error.message });
      // Do not return an incomplete `appended` list as though every attempted
      // directive had been measured successfully. The caller must retain the
      // previous snapshot and retry this transition on the next sweep.
      throw error;
    }
  }
  return appended;
}

// EMIT THE OFF-HOST AUDIT CHECKPOINT FROM SOMETHING THAT ALREADY RUNS.
//
// src/lib/audit-checkpoint.js was correct, tested, and invoked by nothing but
// its own test. It lives here now because this observer is already a declared
// managed process that fires every 15 minutes -- adding a new npm script or a
// new scheduled task would have been the "mechanism nobody calls" defect
// repeated one layer up. See audit.checkpoint() for why it takes the read-only
// path and can therefore still run while every audited write is refused.
//
// FAILURE IS LOUD, IN THREE PLACES, ON PURPOSE. A checkpointer that fails
// quietly is worse than none: it converts "we have no evidence" into "we
// believe we have evidence". So a failure is written to the observer log, to
// stderr (logs/health-observer.err.log, which the observer's own log rotation
// keeps), and escalated into the owner directive inbox the controller already
// drains. The inbox key is bucketed by DAY and by reason, so a persistent
// failure states itself once a day rather than 96 times -- loud enough to be
// read, quiet enough not to be filtered.
function newestCheckpointAgeMs(now, { outboxDir = AUDIT_CHECKPOINT_DIR, io = fs } = {}) {
  let names;
  try {
    names = io.readdirSync(outboxDir).filter(name => name.endsWith('.checkpoint.json'));
  } catch {
    return null;                                   // no outbox yet == never checkpointed
  }
  let newest = null;
  for (const name of names) {
    // The emitted-at millisecond is the filename prefix, so freshness never
    // depends on mtime, which a copy or a restore silently resets.
    const emittedAtMs = Number.parseInt(name.split('-')[0], 10);
    if (!Number.isSafeInteger(emittedAtMs)) continue;
    if (newest === null || emittedAtMs > newest) newest = emittedAtMs;
  }
  return newest === null ? null : now - newest;
}

function childEnvironment(baseEnvironment, context) {
  // Lazy so the observer keeps its smallest possible boot graph. This is the
  // same scrub provider callers receive through their compatibility export,
  // but the control plane never traverses provider or fleet implementation.
  return require('../src/lib/supervision/launch-environment.js')
    .safeLaunchEnvironment(baseEnvironment, { context });
}

// Audit has deliberately broad dependencies: it protects the whole product,
// including subsystems the observer watches.  Loading it into this process
// would let a broken provider or fleet edit prevent the watcher from starting.
// The checkpointer is therefore a short-lived process boundary. Its result is
// structured JSON, so an unavailable child is UNKNOWN/failed at the caller --
// never an invented successful checkpoint.
function invokeAuditCheckpoint({
  outboxDir = AUDIT_CHECKPOINT_DIR,
  nodePath = process.execPath,
  tool = AUDIT_CHECKPOINT_TOOL,
  timeoutMs = AUDIT_CHECKPOINT_TIMEOUT_MS,
  execFileApi = execFile,
  baseEnvironment = process.env
} = {}) {
  return new Promise((resolve, reject) => {
    execFileApi(nodePath, [tool, '--checkpoint', '--outbox-dir', outboxDir, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvironment(baseEnvironment, 'health observer audit checkpoint')
    }, (error, stdout, stderr) => {
      let report = null;
      try { report = JSON.parse(String(stdout || '').trim()); } catch { /* handled below */ }
      if (error || !report || report.ok !== true || !report.result || typeof report.result !== 'object') {
        const failure = new Error(
          report && typeof report.error === 'string' ? report.error
            : `The isolated audit checkpointer did not return a valid result${stderr ? '.' : ''}`
        );
        failure.code = report && typeof report.code === 'string' ? report.code : 'AUDIT_CHECKPOINT_UNAVAILABLE';
        reject(failure);
        return;
      }
      resolve(report.result);
    });
  });
}

async function emitAuditCheckpoint({
  auditApi = null,
  outboxDir = AUDIT_CHECKPOINT_DIR,
  minIntervalMs = AUDIT_CHECKPOINT_MIN_INTERVAL_MS,
  now = Date.now(),
  io = fs,
  inboxOverrides = {},
  // The log sink is injectable for exactly one reason: a test exercising the
  // failure path must not append fabricated checkpoint records -- head 4242,
  // hash aaaa... -- to the real logs/health-observer.log. This lane exists
  // because audit evidence stopped being trustworthy; seeding the operational
  // log with synthetic evidence would be the same mistake in miniature.
  log = appendLog,
  warn = message => process.stderr.write(message)
} = {}) {
  const ageMs = newestCheckpointAgeMs(now, { outboxDir, io });
  if (ageMs !== null && ageMs >= 0 && ageMs < minIntervalMs) {
    return { status: 'skipped', reason: 'recent-checkpoint', ageMs };
  }
  try {
    const result = auditApi
      ? await auditApi.checkpoint({ outboxDir })
      : await invokeAuditCheckpoint({ outboxDir });
    if (result && result.disabled) {
      return { status: 'skipped', reason: 'audit-disabled' };
    }
    const body = (result && result.checkpoint && result.checkpoint.body) || {};
    log({
      event: 'audit-checkpoint',
      headSequence: body.headSequence,
      headHash: body.headHash,
      file: result && result.file,
      pendingDelivery: Boolean(result && result.pendingDelivery)
    });
    return { status: 'emitted', headSequence: body.headSequence, file: result && result.file };
  } catch (error) {
    const code = (error && error.code) || 'AUDIT_CHECKPOINT_FAILED';
    const message = String((error && error.message) || error).slice(0, 300);
    log({ event: 'audit-checkpoint-failed', code, error: message });
    try { warn(`audit checkpoint failed: ${code}: ${message}\n`); } catch { /* stderr closed */ }
    try {
      directiveInbox.append({
        text: `The off-host audit checkpoint could not be emitted (${code}): ${message}`,
        source: 'health-observer',
        submittedBy: 'health-observer',
        idempotencyKey: `audit-checkpoint-failed:${code}:${new Date(now).toISOString().slice(0, 10)}`
      }, inboxOverrides);
    } catch (escalationError) {
      log({ event: 'audit-checkpoint-escalation-failed', error: String(escalationError && escalationError.message).slice(0, 200) });
    }
    return { status: 'failed', code, error: message };
  }
}

// The observer reads scheduled-task and cross-session process identity ONLY
// from the elevated collector's process-visibility snapshot; when that snapshot
// is missing or stale, every subsystem is honestly UNKNOWN. Nothing was
// producing it: tools/process-visibility-refresh.js existed and was allowlisted
// for UAC delegation, but no task, timer, or caller ever invoked it.
//
// MEASURED 2026-07-30: state/process-visibility.json did not exist at all, so
// all 9 subsystems reported UNKNOWN on every sweep. That is the source of the
// 450+ directive UNKNOWN/RECOVERED storm; de-escalating UNKNOWN stopped the
// spam, and this stops the blindness.
//
// Refreshed only when the snapshot is unusable, not on a timer: the refresh
// launches an elevated helper task and takes ~9s, so doing it every 60s sweep
// would cost more than it observes. Best effort by construction -- a failed
// refresh leaves the snapshot unusable and the sweep reports UNKNOWN, which is
// the same honest answer as before, never a fabricated green.
function invokeProcessVisibilityRefresh({
  nodePath = process.execPath,
  tool = PROCESS_VISIBILITY_REFRESH_TOOL,
  timeoutMs = PROCESS_VISIBILITY_REFRESH_TIMEOUT_MS,
  execFileApi = execFile,
  baseEnvironment = process.env
} = {}) {
  return new Promise((resolve, reject) => {
    execFileApi(nodePath, [tool], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvironment(baseEnvironment, 'health observer process visibility refresh')
    }, (error, stdout) => {
      let receipt = null;
      try { receipt = JSON.parse(String(stdout || '').trim()); } catch { /* handled below */ }
      const valid = receipt && typeof receipt === 'object'
        && typeof receipt.status === 'string'
        && typeof receipt.code === 'string'
        && receipt.operationId === 'collect-process-visibility';
      if (!valid) {
        const failure = new Error('The isolated process-visibility refresher did not return a valid receipt.');
        failure.code = 'PROCESS_VISIBILITY_REFRESH_UNAVAILABLE';
        reject(failure);
        return;
      }
      // A nonzero child exit is the expected representation of a fixed
      // refused/failed/unknown receipt. The receipt, not execFile's generic
      // exit error, is the measured result the observer records.
      resolve(receipt);
    });
  });
}

async function ensureProcessVisibility() {
  let consumer;
  try {
    consumer = require('../src/lib/supervision/process-visibility-consumer.js');
  } catch { return null; }
  let usable = false;
  try {
    usable = consumer.loadProcessVisibility({
      file: consumer.SNAPSHOT_FILE, now: Date.now(), maxAgeMs: consumer.DEFAULT_MAX_AGE_MS
    }).usable === true;
  } catch { usable = false; }
  if (usable) return null;
  try {
    const receipt = await invokeProcessVisibilityRefresh();
    appendLog({ event: 'process-visibility-refresh', status: receipt && receipt.status, code: receipt && receipt.code });
    return receipt;
  } catch (error) {
    appendLog({ event: 'process-visibility-refresh-failed', error: String(error && error.message).slice(0, 200) });
    return null;
  }
}

async function runSweep(previous, { escalateTransitions = true } = {}) {
  // Zero-spawn-first: resolve which declared loopback ports actually have a
  // listener with a native node:net probe BEFORE the sweep, so a down port never
  // pays for a PowerShell spawn. Only a port that answers is escalated to the
  // elevated identity probe, once, in this pre-pass -- not once per subsystem on
  // every 60s sweep as before. A pre-pass failure must never cost the sweep, so
  // it falls back to the observer's own direct probe path.
  let listenerResults = null;
  try {
    listenerResults = await observer.collectListenerProbes();
  } catch (error) {
    appendLog({ event: 'listener-prepass-failed', error: String(error && error.message).slice(0, 200) });
    listenerResults = null;
  }
  const snapshot = observer.sweep({ listenerResults });
  const transitions = observer.diffTransitions(previous, snapshot);

  observer.writeSnapshot(snapshot);

  let appended = [];
  if (escalateTransitions && transitions.length > 0) {
    // Observation is NEVER blocked by the kill switch -- suppressing it would
    // make activating the switch blind you. Only correction is blocked, and
    // this observer does not correct anything.
    appended = escalate(transitions, snapshot.observedAtMs);
  }

  if (transitions.length > 0) {
    appendLog({
      event: 'transitions',
      transitions: transitions.map(item => ({ id: item.id, from: item.from, to: item.to })),
      escalated: appended
    });
  }
  return { snapshot, transitions, appended };
}

async function main() {
  if (flag('help') || argv.length === 0) {
    process.stdout.write([
      'ToolsEnabled health observer',
      '',
      '  --once [--json]   run one sweep, print the verdicts, exit 0',
      '  --serve           sweep on an interval until stopped',
      '  --read [--json]   read the snapshot as a consumer (staleness applied)',
      '  --interval-ms N   sweep interval for --serve (default 60000)',
      '  --no-escalate     do not append directives (dry observation)',
      ''
    ].join('\n'));
    return;
  }

  if (flag('read')) {
    const snapshot = observer.readSnapshot({});
    if (flag('json')) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    else printHuman(snapshot);
    return;
  }

  if (flag('once')) {
    await ensureProcessVisibility();
    const { snapshot } = await runSweep(null, { escalateTransitions: !flag('no-escalate') });
    const checkpointResult = await emitAuditCheckpoint();
    if (flag('json')) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    else printHuman(snapshot);
    // --once is the spelling a human or a gate runs, so here the failure gets
    // the one signal --serve cannot have: a nonzero exit code.
    if (checkpointResult.status === 'failed') process.exitCode = 1;
    return;
  }

  if (flag('serve')) {
    const intervalMs = Number(option('interval-ms', observer.DEFAULT_INTERVAL_MS));
    const lock = observerLock.acquire(observer.OBSERVER_LOCK_FILE);
    if (!lock.acquired) {
      process.stderr.write(`refusing to start: ${lock.reason}\n`);
      process.exitCode = 1;
      return;
    }

    let previous = null;
    const release = () => {
      observerLock.release(observer.OBSERVER_LOCK_FILE);
      process.exit(0);
    };
    process.on('SIGINT', release);
    process.on('SIGTERM', release);

    appendLog({ event: 'observer-started', pid: process.pid, intervalMs });

    const tick = async () => {
      try {
        await ensureProcessVisibility();
        const result = await runSweep(previous, { escalateTransitions: !flag('no-escalate') });
        previous = result.snapshot;
        // After the sweep, never before it: a checkpoint failure must not cost
        // the fleet its health observation, which is this process's first duty.
        await emitAuditCheckpoint();
      } catch (error) {
        // A sweep that throws must not kill the observer; that would be the
        // watcher dying silently, which is the whole failure being fixed.
        appendLog({ event: 'sweep-failed', error: error.message, stack: error.stack });
      }
    };

    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    setInterval(() => {}, 1 << 30);          // keep the process alive
    return;
  }

  process.stderr.write('unknown arguments; try --help\n');
  process.exitCode = 2;
}

if (require.main === module) main().catch(error => { appendLog({ event: 'observer-main-failed', error: String(error && error.message).slice(0, 200) }); process.exitCode = 1; });

module.exports = Object.freeze({
  AUDIT_CHECKPOINT_MIN_INTERVAL_MS, emitAuditCheckpoint, escalate, invokeAuditCheckpoint, newestCheckpointAgeMs,
  ensureProcessVisibility, invokeProcessVisibilityRefresh, runSweep, stateCounts
});

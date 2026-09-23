'use strict';

// Bounded correction policy (R93 Phase 5).
//
// Self-healing that never gives up is not self-healing -- it is a way to make
// chronic failure silent. A crash-looping subsystem that gets restarted
// forever resets every budget on every restart, so nobody is ever told that
// something is permanently broken. That is the same class of bug as everything
// else in R93: the system looks busy and nothing is actually being managed.
//
// THE RULES THIS ENFORCES
//
//   1. PRECONDITION BEFORE CORRECTION. A restart whose resolved argv would
//      fail is REPORTED, never attempted. Incident #5: the controller restarted
//      the fleet supervisor without --project, instantly failing 9 lanes and
//      falsely parking 8 queue items. That is now a machine-checked gate.
//
//   2. BOUNDED BACKOFF, then QUARANTINE. 0s -> 30s -> 2m -> 8m, jittered.
//      3 restarts in 30 minutes and correction STOPS with one escalation.
//
//   3. QUARANTINE IS DURABLE. It survives observer restarts, because a
//      crash-looping observer that forgets its budgets is how self-healing
//      becomes silence. Exit is explicit and recorded, never automatic.
//
//   4. one_for_one ONLY. A restart may never cascade to a sibling. Nothing here
//      restarts a subsystem because a different one is unhealthy.
//
//   5. KILLSWITCH BLOCKS CORRECTION, NEVER OBSERVATION. Suppressing observation
//      when the switch is on would mean activating it blinds you, which is the
//      opposite of what a safety control is for.

const fs = require('node:fs');
const path = require('node:path');

const managedProcesses = require('../managed-processes.js');
const killSwitch = require('../kill-switch.js');

const ROOT = managedProcesses.ROOT;
const POLICY_STATE_FILE = path.join(ROOT, 'state', 'supervision-policy.json');

const BACKOFF_MS = Object.freeze([0, 30000, 120000, 480000]);
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 30 * 60 * 1000;
const JITTER_RATIO = 0.2;

const OUTCOME = Object.freeze({
  ATTEMPT: 'CORRECTION_ATTEMPT',
  PRECONDITION_FAILED: 'CORRECTION_PRECONDITION_FAILED',
  BACKOFF: 'CORRECTION_BACKOFF',
  QUARANTINED: 'CORRECTION_QUARANTINED',
  KILLSWITCH: 'CORRECTION_BLOCKED_BY_KILLSWITCH',
  NOT_CORRECTABLE: 'CORRECTION_NOT_APPLICABLE'
});

// --- Durable state ----------------------------------------------------------

function emptyState() {
  return { schemaVersion: 1, subsystems: {} };
}

function loadState(file = POLICY_STATE_FILE) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // A file that has never been created has no history to preserve. Every
    // other read failure is UNKNOWN state, not evidence of an empty budget.
    // Refusing the decision also prevents recordAttempt() from replacing the
    // unreadable durable record with a fabricated clean one.
    if (error && error.code === 'ENOENT') return emptyState();
    const failure = new Error(`supervision policy state is unreadable at ${file}: ${error.message}`);
    failure.code = 'SUPERVISION_POLICY_STATE_UNREADABLE';
    failure.cause = error;
    throw failure;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const failure = new Error(`supervision policy state is malformed at ${file}: ${error.message}`);
    failure.code = 'SUPERVISION_POLICY_STATE_MALFORMED';
    failure.cause = error;
    throw failure;
  }
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.subsystems
      || typeof parsed.subsystems !== 'object' || Array.isArray(parsed.subsystems)) {
    const failure = new Error(`supervision policy state has an unsupported shape at ${file}`);
    failure.code = 'SUPERVISION_POLICY_STATE_MALFORMED';
    throw failure;
  }
  return parsed;
}

function saveState(state, file = POLICY_STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return file;
}

function subsystemRecord(state, id) {
  if (!state.subsystems[id]) {
    state.subsystems[id] = { attempts: [], quarantined: false, quarantineReason: null, quarantinedAtMs: null };
  }
  return state.subsystems[id];
}

// --- Quarantine -------------------------------------------------------------

function isQuarantined(id, { file = POLICY_STATE_FILE, state = null } = {}) {
  const current = state || loadState(file);
  const record = current.subsystems[id];
  return Boolean(record && record.quarantined);
}

function quarantineDetail(id, { file = POLICY_STATE_FILE, state = null } = {}) {
  const current = state || loadState(file);
  const record = current.subsystems[id];
  if (!record || !record.quarantined) return null;
  return {
    reason: record.quarantineReason,
    quarantinedAtMs: record.quarantinedAtMs,
    attempts: record.attempts.length
  };
}

// Exit is explicit and recorded. There is no automatic un-quarantine: a
// subsystem that failed three times in half an hour has a problem a timer
// cannot fix, and silently retrying it is how the failure stays invisible.
function releaseQuarantine(id, { file = POLICY_STATE_FILE, releasedBy = 'unknown', nowMs = Date.now() } = {}) {
  const state = loadState(file);
  const record = subsystemRecord(state, id);
  if (!record.quarantined) return { released: false, reason: `${id} is not quarantined` };
  record.quarantined = false;
  record.quarantineReason = null;
  record.quarantinedAtMs = null;
  record.attempts = [];
  record.releasedAtMs = nowMs;
  record.releasedBy = releasedBy;
  saveState(state, file);
  return { released: true, reason: `${id} released from quarantine by ${releasedBy}` };
}

function recentAttempts(record, nowMs) {
  return record.attempts.filter(at => (nowMs - at) < RESTART_WINDOW_MS);
}

function jitter(baseMs, random) {
  if (baseMs === 0) return 0;
  const span = baseMs * JITTER_RATIO;
  return Math.round(baseMs - span + (random() * span * 2));
}

// --- The decision -----------------------------------------------------------
//
// It never performs a process correction. The sole state-changing decision is
// quarantine: that safety boundary is committed before it is returned so a
// caller cannot accidentally turn a durable stop into a transient report.

function decide(verdict, {
  file = POLICY_STATE_FILE,
  nowMs = Date.now(),
  random = Math.random,
  killSwitchActive = null,
  state = null,
  // Injectable so the incident-#5 gate can be exercised end to end without
  // corrupting the real registry to prove it works.
  resolveArgv = managedProcesses.resolveArgv,
  checkArgvPreconditions = managedProcesses.checkArgvPreconditions
} = {}) {
  const id = verdict.id;
  const current = state || loadState(file);
  const record = subsystemRecord(current, id);

  // Quarantine outranks everything except the plain fact that nothing is wrong.
  if (record.quarantined) {
    return {
      id,
      action: 'none',
      outcome: OUTCOME.QUARANTINED,
      reason: `${id} is quarantined (${record.quarantineReason}); automatic correction has stopped and a human must decide`,
      escalate: false
    };
  }

  if (!verdict.correctable) {
    return {
      id,
      action: 'none',
      outcome: OUTCOME.NOT_CORRECTABLE,
      reason: verdict.state === 'STOPPED'
        ? `${id} was stopped deliberately; restarting it would override an owner decision`
        : `${id} is ${verdict.state} and declares no correctable failure`,
      escalate: false
    };
  }

  // Observation is never blocked; correction always is. Checked HERE, before
  // any precondition or budget work, so there is no path where the switch is on
  // and something still gets spawned.
  const blocked = killSwitchActive === null
    ? Boolean(killSwitch.status && killSwitch.status().active)
    : killSwitchActive;
  if (blocked) {
    return {
      id,
      action: 'none',
      outcome: OUTCOME.KILLSWITCH,
      reason: `the kill switch is active: ${id} will NOT be corrected. Observation continues.`,
      escalate: false
    };
  }

  // PRECONDITION GATE (incident #5). Resolve the argv we would actually use and
  // refuse to spawn something that cannot work.
  let resolvedArgv;
  try {
    resolvedArgv = resolveArgv(id);
  } catch (error) {
    return {
      id,
      action: 'none',
      outcome: OUTCOME.PRECONDITION_FAILED,
      reason: `cannot resolve argv for ${id}: ${error.message}`,
      escalate: true
    };
  }
  const precondition = checkArgvPreconditions(id, resolvedArgv);
  if (!precondition.ok) {
    return {
      id,
      action: 'none',
      outcome: OUTCOME.PRECONDITION_FAILED,
      reason: `${precondition.reason}. Restarting anyway would fail every lane and falsely park queue items, so this is reported instead of attempted.`,
      missing: precondition.missing,
      escalate: true
    };
  }

  const attempts = recentAttempts(record, nowMs);

  if (attempts.length >= MAX_RESTARTS) {
    // The bounded-restart caller reports this action but does not apply it.
    // Persist before returning so the safety decision cannot evaporate when
    // timestamps age out or the observer reloads its state.
    record.attempts = attempts;
    record.quarantined = true;
    record.quarantineReason = `${id} has been corrected ${attempts.length} times in ${Math.round(RESTART_WINDOW_MS / 60000)} minutes and is still ${verdict.state}. Correction stops here; repeating it forever would hide a chronic failure.`;
    record.quarantinedAtMs = nowMs;
    saveState(current, file);
    return {
      id,
      action: 'quarantine',
      outcome: OUTCOME.QUARANTINED,
      reason: record.quarantineReason,
      escalate: true
    };
  }

  const lastAttempt = attempts.length > 0 ? Math.max(...attempts) : null;
  const waitMs = jitter(BACKOFF_MS[Math.min(attempts.length, BACKOFF_MS.length - 1)], random);
  if (lastAttempt !== null && (nowMs - lastAttempt) < waitMs) {
    return {
      id,
      action: 'none',
      outcome: OUTCOME.BACKOFF,
      reason: `${id} was corrected ${Math.round((nowMs - lastAttempt) / 1000)}s ago; waiting out a ${Math.round(waitMs / 1000)}s backoff before trying again`,
      retryAfterMs: waitMs - (nowMs - lastAttempt),
      escalate: false
    };
  }

  return {
    id,
    action: 'correct',
    outcome: OUTCOME.ATTEMPT,
    reason: `${id} is ${verdict.state} (${verdict.reason}); attempt ${attempts.length + 1} of ${MAX_RESTARTS}`,
    argv: resolvedArgv,
    attempt: attempts.length + 1,
    escalate: false
  };
}

// Record that a correction was attempted. Separate from decide() so an attempt
// is only ever counted when it really happened.
function recordAttempt(id, { file = POLICY_STATE_FILE, nowMs = Date.now() } = {}) {
  const state = loadState(file);
  const record = subsystemRecord(state, id);
  record.attempts = recentAttempts(record, nowMs);
  record.attempts.push(nowMs);
  saveState(state, file);
  return record.attempts.length;
}

function applyQuarantine(id, reason, { file = POLICY_STATE_FILE, nowMs = Date.now() } = {}) {
  const state = loadState(file);
  const record = subsystemRecord(state, id);
  record.quarantined = true;
  record.quarantineReason = reason;
  record.quarantinedAtMs = nowMs;
  saveState(state, file);
  return quarantineDetail(id, { file });
}

module.exports = Object.freeze({
  BACKOFF_MS,
  JITTER_RATIO,
  MAX_RESTARTS,
  OUTCOME,
  POLICY_STATE_FILE,
  RESTART_WINDOW_MS,
  applyQuarantine,
  decide,
  isQuarantined,
  loadState,
  quarantineDetail,
  recordAttempt,
  releaseQuarantine,
  saveState
});

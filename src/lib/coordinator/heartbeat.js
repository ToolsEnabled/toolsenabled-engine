'use strict';

// Coordinator duty-host heartbeat: the CONTRACT SURFACE between the duty host
// (writer, in this repo) and the dashboard watcher (reader, in
// AgentActivityVisualizer). Owner request R100.
//
// WHY THIS FILE IS DELIBERATELY BORING
//
// The duty host is the fragile process; the dashboard is the reliable one.
// The fragile process writes, the reliable process reads and judges. That
// inversion only works if the artefact between them is (a) atomically written
// so a reader can never see a torn JSON document, and (b) reachable from a
// cross-repo lazy require without dragging in a module graph that could break.
//
// Hence: node builtins plus a SINGLE optional require of ../runtime.js, and
// even that is wrapped -- if runtime.js is unloadable for any reason, this
// module still resolves the repo root by path arithmetic rather than
// exploding. The dashboard lazy-requires this file specifically because it is
// the thing that reports the duty host died; a broken require here would
// blind the watcher, which is the exact incident this design is written
// against.
//
// WHAT A HEARTBEAT DOES AND DOES NOT PROVE
//
// It is written at the END of a cycle, never at the start. A start-of-cycle
// heartbeat proves only that the loop is turning -- liveness wearing
// function's clothes, the same defect config/managed-processes.json's
// telegram-bridge "functioning" rung was written against (lastPollAtMs
// advances even when every poll fails). Per-duty lastRunAtMs, outcome and
// consecutiveFailures travel WITH the heartbeat so a reader can compute a
// worst-duty rollup instead of trusting a single green light.
//
// STALENESS IS NOT APPLIED HERE. readHeartbeatRaw() returns exactly what is on
// disk plus a read verdict. Deciding OK / STALE / DOWN / UNKNOWN from the age
// is the READER's job (server/duty-host-watch.js), because a rule that lives
// in the writer dies with the writer.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Optional, per the header. The contract names runtime.js as this module's one
// dependency; the fallback exists so a broken require graph cannot blind the
// dashboard, not to avoid the dependency.
function resolveRoot() {
  try {
    // eslint-disable-next-line global-require
    const runtime = require('../runtime.js');
    if (runtime && typeof runtime.ROOT === 'string' && runtime.ROOT.length > 0) return runtime.ROOT;
  } catch { /* fall through to path arithmetic */ }
  return path.resolve(__dirname, '..', '..', '..');
}

const ROOT = resolveRoot();

const HEARTBEAT_SCHEMA_VERSION = 1;
const HEARTBEAT_FILE = path.join(ROOT, 'state', 'coordinator-duty-host.heartbeat.json');

// Per-duty outcomes. Every one of these is a REPORTED fact; there is no
// outcome meaning "we did not look but assume it is fine".
const DUTY_OUTCOME = Object.freeze({
  OK: 'OK',                     // ran this cycle and completed
  FAILED: 'FAILED',             // ran and threw / returned a failure
  TIMEOUT: 'TIMEOUT',           // exceeded its per-duty budget; loop continued
  SKIPPED: 'SKIPPED',           // deliberately not run (kill switch, disabled)
  UNAVAILABLE: 'UNAVAILABLE',   // a dependency this duty needs is not present
  WAITING: 'WAITING',           // judgement duty: a human must decide
  NOT_YET_RUN: 'NOT_YET_RUN'    // registered, never executed in this boot
});

const OUTCOME_VALUES = Object.freeze(Object.values(DUTY_OUTCOME));

// Outcomes that count as a failure for consecutiveFailures / host self-state.
const FAILING_OUTCOMES = Object.freeze([
  DUTY_OUTCOME.FAILED, DUTY_OUTCOME.TIMEOUT, DUTY_OUTCOME.UNAVAILABLE
]);

const HOST_STATE = Object.freeze({
  OK: 'OK',
  DEGRADED: 'DEGRADED',
  UNKNOWN: 'UNKNOWN'
});

const ESCALATION_CHANNEL = Object.freeze({
  OK: 'OK',
  BROKEN: 'BROKEN',
  UNKNOWN: 'UNKNOWN'
});

function newBootId() {
  return crypto.randomUUID();
}

/**
 * A heartbeat for a host that has booted but not yet completed a cycle.
 * cycleSeq 0 and every duty NOT_YET_RUN is an honest statement, not a green
 * light -- a reader seeing cycleSeq 0 long after startedAtMs knows the first
 * cycle never finished.
 */
function emptyHeartbeat({
  pid = process.pid,
  bootId = newBootId(),
  startedAtMs = Date.now(),
  observedAtMs = startedAtMs,
  cycleIntervalMs = 30000
} = {}) {
  return {
    schemaVersion: HEARTBEAT_SCHEMA_VERSION,
    pid,
    bootId,
    startedAtMs,
    observedAtMs,
    cycleIntervalMs,
    cycleSeq: 0,
    // No cycle has completed, so no host-state measurement exists yet.
    // cycleSeq also exposes this fact, but hostState must not independently
    // turn "not measured" into a definite OK.
    hostState: HOST_STATE.UNKNOWN,
    duties: {},
    judgementWaiting: [],
    // null, not 0: this host has never asked the sink yet. Claiming zero
    // suppressions before counting any is a claim, not an observation.
    escalationsSuppressed: null,
    escalationChannel: {
      state: ESCALATION_CHANNEL.UNKNOWN,
      reason: 'no escalation has been attempted in this boot',
      lastErrorAtMs: null,
      lastSendAtMs: null
    }
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Structural validation only. Returns { valid, errors: [...] } and NEVER
 * throws, because both sides of this contract have to be able to describe a
 * malformed heartbeat rather than die on one.
 */
function validateHeartbeat(record) {
  const errors = [];
  if (!isPlainObject(record)) return { valid: false, errors: ['heartbeat is not an object'] };

  if (record.schemaVersion !== HEARTBEAT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${HEARTBEAT_SCHEMA_VERSION}, got ${JSON.stringify(record.schemaVersion)}`);
  }
  if (!isFiniteNumber(record.pid)) errors.push('pid must be a finite number');
  if (typeof record.bootId !== 'string' || record.bootId.length === 0) {
    errors.push('bootId must be a non-empty string (pid alone is not identity: Windows recycles pids)');
  }
  if (!isFiniteNumber(record.startedAtMs)) errors.push('startedAtMs must be a finite number');
  // observedAtMs is the field the reader ages. Without it there is no
  // staleness rule at all, so its absence is a hard validation failure.
  if (!isFiniteNumber(record.observedAtMs)) errors.push('observedAtMs must be a finite number');
  if (!isFiniteNumber(record.cycleIntervalMs) || record.cycleIntervalMs <= 0) {
    errors.push('cycleIntervalMs must be a positive finite number');
  }
  if (!isFiniteNumber(record.cycleSeq) || record.cycleSeq < 0) {
    errors.push('cycleSeq must be a non-negative finite number');
  }
  if (!Object.values(HOST_STATE).includes(record.hostState)) {
    errors.push(`hostState must be one of ${Object.values(HOST_STATE).join('|')}`);
  }
  if (!isPlainObject(record.duties)) {
    errors.push('duties must be an object keyed by duty id');
  } else {
    for (const [id, duty] of Object.entries(record.duties)) {
      if (!isPlainObject(duty)) { errors.push(`duty ${id} is not an object`); continue; }
      if (!OUTCOME_VALUES.includes(duty.outcome)) {
        errors.push(`duty ${id} has unknown outcome ${JSON.stringify(duty.outcome)}`);
      }
      if (duty.lastRunAtMs !== null && !isFiniteNumber(duty.lastRunAtMs)) {
        errors.push(`duty ${id} lastRunAtMs must be a finite number or null`);
      }
      if (!isFiniteNumber(duty.consecutiveFailures) || duty.consecutiveFailures < 0) {
        errors.push(`duty ${id} consecutiveFailures must be a non-negative finite number`);
      }
    }
  }
  if (!Array.isArray(record.judgementWaiting)) errors.push('judgementWaiting must be an array');
  // Required to be PRESENT, not optional: a suppressed escalation is
  // indistinguishable from no escalation unless it is counted and surfaced.
  //
  // null is legal and means UNKNOWN. escalation-sink.js#sinkStatus returns null
  // when its state file is corrupt or unreadable, precisely so "I could not
  // count" cannot render as "nothing was suppressed". Coercing that null to 0
  // here would re-create the false-OK the sink guards against, and refusing it
  // outright would be worse still -- writeHeartbeat would throw and the host
  // would publish NO heartbeat at all, so an accounting gap would read as a
  // dead host. The dashboard already maps a non-finite value to UNKNOWN
  // (server/duty-host-watch.js:616), so null propagates correctly.
  if (!Object.prototype.hasOwnProperty.call(record, 'escalationsSuppressed')) {
    errors.push('escalationsSuppressed must be present (null means UNKNOWN)');
  } else if (record.escalationsSuppressed !== null
    && (!isFiniteNumber(record.escalationsSuppressed) || record.escalationsSuppressed < 0)) {
    errors.push('escalationsSuppressed must be a non-negative finite number, or null for UNKNOWN');
  }
  if (!isPlainObject(record.escalationChannel)) {
    errors.push('escalationChannel must be an object');
  } else if (!Object.values(ESCALATION_CHANNEL).includes(record.escalationChannel.state)) {
    errors.push(`escalationChannel.state must be one of ${Object.values(ESCALATION_CHANNEL).join('|')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Atomic write: temp file + fs.renameSync, exactly the no-torn-read pattern at
 * src/lib/supervision/observer.js#writeSnapshot. The temp name carries the pid
 * so two hosts racing (which the pid lock should prevent, but belt and braces)
 * cannot clobber each other's partial file.
 *
 * Refuses to write an invalid record. A malformed heartbeat is worse than an
 * absent one: absent renders as a loud UNKNOWN, malformed could render as
 * anything.
 */
function writeHeartbeat(record, { file = HEARTBEAT_FILE, fsImpl = fs } = {}) {
  const verdict = validateHeartbeat(record);
  if (!verdict.valid) {
    const error = new Error(`refusing to write an invalid heartbeat: ${verdict.errors.join('; ')}`);
    error.code = 'HEARTBEAT_INVALID';
    error.errors = verdict.errors;
    throw error;
  }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${record.pid}.tmp`;
  fsImpl.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fsImpl.renameSync(temporary, file);                  // atomic: no torn reads
  return file;
}

/**
 * Read exactly what is on disk. NEVER throws and NEVER applies staleness.
 *
 * Returns { ok, record, errorCode, reason, file }. The distinct errorCodes
 * matter to the reader: "I cannot look" (ENOENT/EACCES/parse) must render as
 * UNKNOWN, never DOWN. Absence of evidence is not evidence of death.
 */
function readHeartbeatRaw({ file = HEARTBEAT_FILE, fsImpl = fs } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    const code = error && error.code === 'ENOENT' ? 'HEARTBEAT_ABSENT' : 'HEARTBEAT_UNREADABLE';
    return {
      ok: false,
      record: null,
      errorCode: code,
      reason: code === 'HEARTBEAT_ABSENT'
        ? `no heartbeat file at ${file}: the duty host has never written one in this state directory`
        : `heartbeat file at ${file} could not be read: ${error && error.message}`,
      file
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      record: null,
      errorCode: 'HEARTBEAT_CORRUPT',
      reason: `heartbeat file at ${file} is not valid JSON: ${error && error.message}`,
      file
    };
  }

  const verdict = validateHeartbeat(parsed);
  if (!verdict.valid) {
    return {
      ok: false,
      record: parsed,
      errorCode: 'HEARTBEAT_INVALID',
      reason: `heartbeat file at ${file} is structurally invalid: ${verdict.errors.join('; ')}`,
      file
    };
  }

  return { ok: true, record: parsed, errorCode: null, reason: 'heartbeat read', file };
}

module.exports = Object.freeze({
  HEARTBEAT_SCHEMA_VERSION,
  HEARTBEAT_FILE,
  DUTY_OUTCOME,
  FAILING_OUTCOMES,
  HOST_STATE,
  ESCALATION_CHANNEL,
  ROOT,
  newBootId,
  writeHeartbeat,
  readHeartbeatRaw,
  validateHeartbeat,
  emptyHeartbeat
});

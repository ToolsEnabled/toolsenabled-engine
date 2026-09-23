'use strict';

/* Puts a locally-launched agent session into the canonical signed ledger.
 *
 * WHY THIS EXISTS. Measured 2026-08-12: the newest `controller.agent.launch`
 * in state/audit.sqlite3 was four days old while six agents were running on
 * this machine. The chain was not broken -- 26,527 entries, audit.verify
 * valid, signatures good. It simply had no writer for the way agents are
 * actually started here.
 *
 * There are three launch paths on this machine and only one of them was ever
 * wired:
 *
 *   1. Controller dispatch (`/v1/actions/dispatch` -> controller-launch-record)
 *      records `controller.agent.launch` BEFORE the spawn and REFUSES to spawn
 *      if the ledger will not take the record. That path works, and is the one
 *      the product claim describes. Nobody had used it since 2026-08-08, which
 *      is exactly the date of the newest record.
 *   2. Interactive sessions (SessionStart hook -> claude-session-autoregister).
 *   3. Harness subagents (SubagentStart).
 *
 * Paths 2 and 3 registered liveness in the presence roster and wrote nothing
 * to the ledger. This module is their writer.
 *
 * IT DELIBERATELY DOES NOT CLAIM TO BE PATH 1, AND THE RECORD SAYS SO.
 * `controller.agent.launch` means "the policy kernel decided, and then the
 * process was started". For a session the harness has ALREADY started before
 * any hook can run, that sentence is false: there was no before. Writing these
 * under the controller's action name would make the ledger overstate itself,
 * which is worse than the gap it closes. So they get their own action,
 * `agent.session.launched`, and every record carries `gated: false` and
 * `observedAfterStart: true` in its details. A reader can therefore tell a
 * gated dispatch from an observed start without consulting anything else.
 *
 * WHAT THIS CANNOT DO, STATED PLAINLY: it cannot gate. By the time the hook
 * fires, the agent process exists. Making harness launches refusable is a
 * design change -- they would have to be dispatched through path 1 -- not a
 * wiring change, and this module does not pretend otherwise.
 *
 * IDEMPOTENT BY CONSTRUCTION. SessionStart re-fires for the same session (a
 * resumed session, a reconnect). Duplicate launch rows for one run would be
 * noise in an append-only chain that can never be tidied up afterwards, so the
 * write goes through audit.conditionalRecord: it takes the ledger's own writer
 * lock, looks for an existing record for this exact run, and refuses rather
 * than appending a second one. The event id is also derived from the run id,
 * so a duplicate is refused by identity even if the lookup window misses.
 *
 * Every dependency is injected so this is testable without a real ledger.
 */

const crypto = require('node:crypto');

const LAUNCH_ACTION = 'agent.session.launched';
const MAX_FIELD_LENGTH = 200;
const LOOKUP_LIMIT = 50;

/* Session/agent identifiers only. No prompt text, no brief, no environment,
   and no path outside the checkout root -- a launch record is evidence that a
   session started, not a copy of what it was asked to do. */
const STRING_FIELDS = Object.freeze([
  'runId', 'agentId', 'kind', 'provider', 'lane', 'role', 'tier', 'provenance', 'parentAgentId'
]);

class AgentLaunchAuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentLaunchAuditError';
    this.code = code;
  }
}

function cleanString(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AgentLaunchAuditError('LAUNCH_AUDIT_INVALID_FIELD', `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Control characters would ride into a signed record and out again into
  // whatever renders it. Bounded and stripped here, once.
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_FIELD_LENGTH);
}

/* The run id is the identity the whole record hangs off, so it is the one
   field that is validated rather than merely cleaned. An absent or malformed
   run id must not produce a phantom launch row -- the same defect
   claude-session-autoregister.js already fixed once, where the literal string
   'undefined' nearly became a registered seat. */
function normalizeRunId(value) {
  const cleaned = cleanString(value, 'runId');
  if (!cleaned || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(cleaned)) return null;
  return cleaned;
}

function eventIdForRun(runId) {
  const digest = crypto.createHash('sha256').update(`agent.session.launched:${runId}`, 'utf8').digest('hex');
  return `agent-session-launch-${digest.slice(0, 32)}`;
}

/**
 * Record that an agent session started on this machine.
 *
 * Returns a plain result rather than throwing for the expected outcomes, so a
 * fail-open hook can log one line and move on:
 *   { ok: true,  recorded: true,  sequence, eventId }   first record for this run
 *   { ok: true,  recorded: false, reason: 'duplicate' } already recorded
 *   { ok: false, recorded: false, reason, code }        ledger refused/unavailable
 *
 * @param {object} descriptor identifiers for the session that started.
 * @param {object} [dependencies] injected `audit` api and clock, for tests.
 */
function recordAgentSessionLaunch(descriptor = {}, dependencies = {}) {
  const runId = normalizeRunId(descriptor.runId);
  if (!runId) {
    return { ok: false, recorded: false, code: 'LAUNCH_AUDIT_NO_RUN_ID', reason: 'the session carried no usable run id' };
  }

  const audit = dependencies.audit || require('./audit');
  if (!audit || typeof audit.conditionalRecord !== 'function') {
    return { ok: false, recorded: false, code: 'LAUNCH_AUDIT_WRITER_ABSENT', reason: 'the canonical audit writer is unavailable' };
  }

  const details = { gated: false, observedAfterStart: true, runId };
  for (const field of STRING_FIELDS) {
    if (field === 'runId') continue;
    const cleaned = cleanString(descriptor[field], field);
    if (cleaned) details[field] = cleaned;
  }
  if (Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0) details.pid = descriptor.pid;

  const target = details.agentId || runId;

  try {
    const outcome = audit.conditionalRecord({
      action: LAUNCH_ACTION,
      target,
      eventId: eventIdForRun(runId),
      decide: ({ findEvents }) => {
        // Append-only means a duplicate can never be removed later, so the
        // check happens under the ledger's own writer lock, not before it.
        const prior = findEvents({ action: LAUNCH_ACTION, target, limit: LOOKUP_LIMIT });
        const already = prior.some(entry => entry
          && entry.event && entry.event.details && entry.event.details.runId === runId);
        if (already) return { kind: 'refused', refusal: 'duplicate' };
        return { kind: 'record', details };
      }
    }, dependencies);

    if (outcome && outcome.recorded === false && outcome.refusal === 'duplicate') {
      return { ok: true, recorded: false, reason: 'duplicate', runId };
    }
    if (!outcome || outcome.recorded !== true || !Number.isSafeInteger(outcome.sequence)) {
      throw new AgentLaunchAuditError(
        'LAUNCH_AUDIT_UNEXPECTED_OUTCOME',
        'The canonical audit writer returned no definite durable record or duplicate refusal.'
      );
    }
    return {
      ok: true,
      recorded: true,
      runId,
      sequence: outcome.sequence,
      eventId: eventIdForRun(runId)
    };
  } catch (error) {
    // The ledger refusing is a REPORTABLE fact, never a swallowed one: the
    // caller decides what to do with it. Nothing here retries, because a
    // launch that is already running cannot be un-launched by trying again.
    return {
      ok: false,
      recorded: false,
      runId,
      code: (error && error.code) || 'LAUNCH_AUDIT_FAILED',
      reason: (error && error.message ? String(error.message) : String(error)).slice(0, 300)
    };
  }
}

module.exports = { recordAgentSessionLaunch, eventIdForRun, LAUNCH_ACTION, AgentLaunchAuditError };

'use strict';

// The wired path from a detected coordinator failure to the product-native
// owner journal. A directive-inbox entry remains a secondary durable trail;
// appending a file alone is never treated as delivery.
//
// WHAT THIS DOES. Wraps ./owner-alarm-channel.js#sendToOwner({ text }) behind
// the pure decision layer in ./escalation-policy.js, records the outcome
// durably, and leaves a matching trail in the directive inbox. The inbox write
// is a SECONDARY record, never the delivery claim: `delivered` in the returned
// result is true only when the channel confirmed the message.
//
// The default is the product's own message fabric, which reaches the app's
// Comms page and its relayed phone surface from one journal write. See
// ./owner-alarm-channel.js for the verified route.
//
// WHAT THIS DELIBERATELY CANNOT DO.
//   * It never chooses or handles a recipient. The channel addresses the owner
//     and does not accept a recipient as a parameter.
//   * It NEVER calls ownerChat.reply(). Composing words to send back to the
//     owner is a JUDGEMENT duty and belongs to an agent, not to a loop. The
//     only owner-chat function bound in this file is acknowledgeWithoutReply,
//     which is structurally safe: it throws OWNER_CHAT_NEEDS_A_REPLY on any
//     owner-sourced item (src/lib/owner-chat.js:750). There is a test that
//     greps this file's own source for `reply(` and fails if it reappears.
//   * It never suppresses silently. Every suppression becomes a counted,
//     timestamped event that sinkStatus() and suppressedSince() surface.
//
// THE HONEST-FAILURE RULE. A send that throws is recorded as FAILED and is NOT
// marked delivered, does NOT set the dedupe stamp, and makes
// sinkStatus().channel.broken true with the error code. A sink that cannot
// deliver must never look quiet -- "no recent alerts" and "the alert channel is
// dead" render identically otherwise, and that is precisely the failure this
// whole subsystem exists to prevent.
//
// ORDERING, same rule as src/lib/owner-chat.js's reply(): reserve the attempt
// durably, THEN hit the wire, THEN record the outcome. A crash mid-send costs
// one wasted budget slot and leaves a visible `pending` attempt; it can never
// leave a delivery claim for a message that was not delivered.
//
// AND THE OUTCOME MUST ACTUALLY LAND, which is a separate claim from the
// ordering above and was the defect. The post-send lock ran bare: if it threw
// ESCALATION_STATE_BUSY after the message had ALREADY been accepted, escalate()
// threw, the dedupe stamp was never written, and duty-registry.js classifies
// that code as TRANSIENT -- correctly, for a pre-send failure -- so the next
// cycle sent the owner a message he had already received. Two things close it:
// the resolve retries on its own budget instead of the default 5x25ms, and
// escalate() never throws once the wire has been used. An outcome that still
// cannot be written is held in RESOLUTIONS_OWED and folded into the very next
// lock this module takes, before that call's own decision is made -- one file,
// one lock, one truth, no second store.
//
// Durable state: state/coordinator-escalation.json. Advisory 'wx' lock,
// temp-then-rename atomic write, mode 0600 -- the shape already reviewed in
// src/lib/owner-directive-inbox.js and src/lib/owner-chat.js. A corrupt file is
// a hard stop, never a silent reset: resetting would re-notify everything
// already sent and erase the record of what was suppressed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { rootPath } = require('../runtime');
const killSwitch = require('../kill-switch');
const directiveInbox = require('../owner-directive-inbox');
const ownerAlarmChannel = require('./owner-alarm-channel');
const policy = require('./escalation-policy');

// Deliberately narrowed, and deliberately LAZY. Only this one owner-chat
// function is reachable from here; `reply` is never referenced (see the header
// and tests/coordinator-escalation-sink.test.js's structural check).
//
// Acknowledging superseded directives is optional and lazy. Raising the alarm
// must not depend on loading the conversation-log subsystem when no directive
// ids were supplied.
function ownerChatAcknowledgeWithoutReply(...args) {
  // eslint-disable-next-line global-require
  return require('../owner-chat').acknowledgeWithoutReply(...args);
}

const ESCALATION_STATE_FILE = () => rootPath('state', 'coordinator-escalation.json');

// The message fabric's own body ceiling
// (src/lib/agent-comms/channel-contract.js DEFAULT_MAX_BODY_LENGTH).
// ./owner-alarm-channel.js enforces the same bound; truncating here is earlier
// and keeps the shortening in the one place that composes the text. The two
// reason/detail bounds below already keep a real escalation far under it.
const MAX_MESSAGE_LENGTH = 4000;
const MAX_REASON_LENGTH = 1200;
const MAX_DETAIL_LENGTH = 1200;
const MAX_ACK_IDS = 20;
const DEFAULT_STATUS_ENTRIES = 20;
// Every withLock hold here is a synchronous in-memory read/mutate/write, never
// an await -- both call sites release the lock before their owner-channel send and
// reacquire it after. A lock older than this was abandoned by a holder that
// died before reaching its own finally block, not one that is merely busy.
// Same fix and same reasoning as src/lib/owner-chat.js#withLock -- this
// function's own header comment claims the same shape but had not actually
// received the fix until now.
const STALE_LOCK_MS = 10000;

const DIRECTIVE_SOURCE = 'coordinator-escalation';
const DIRECTIVE_ACTOR = 'coordinator-escalation';

// Same best-effort credential-shaped-text backstop the inbox and owner-chat
// each keep. An escalation reason is assembled from process command lines and
// error strings, which is exactly the kind of text that can accidentally carry
// a token, and the owner journal is durable, is read by the app and by the
// relayed phone surface, and has no edit.
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+[A-Za-z0-9._-]{10,}|\b(?:password|passwd|api[-_]?key|secret[-_]?key|access[-_]?token|refresh[-_]?token)\s*[:=]\s*\S|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})/i;

const REFUSED_KILLSWITCH = 'REFUSED_KILLSWITCH';
const ESCALATION_DELIVERY_UNKNOWN = 'ESCALATION_DELIVERY_UNKNOWN';

// These failures do not establish that the channel rejected the message. In
// particular, a timeout can happen after the receiver accepted it, while the
// local EMFILE/EAGAIN/EIO/EBUSY cases mean this process could not complete the
// observation. Recording any of them as `delivered: false` would turn COULD NOT
// LOOK into NOT DELIVERED and would durably latch that invented answer in the
// policy totals/channel-health state.
function deliveryOutcomeUnknown(error) {
  const code = errorCode(error).toUpperCase();
  return ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT'].includes(code)
    || /(?:TIMEOUT|TIMEDOUT|NO_RESPONSE|NO_ANSWER)/.test(code);
}

class SinkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SinkError';
    this.code = code;
  }
}

function fail(code, message) { throw new SinkError(code, message); }

function errorCode(error) {
  if (!error) return 'ERROR';
  const code = error.code === undefined || error.code === null ? '' : String(error.code);
  if (code && /^[A-Za-z0-9_.:-]{1,80}$/.test(code)) return code;
  return 'ERROR';
}

// Current senders return a bounded opaque string receipt. Numeric ids are not
// accepted on a new send; they exist only in historical-state migration paths.
// An unreadable receipt is UNKNOWN, never invented, because its only job is to
// let a person find the message again.
function readMessageId(sent) {
  if (!sent) return null;
  if (typeof sent.messageId === 'string'
      && sent.messageId.length > 0
      && sent.messageId.length <= 512
      && !sent.messageId.includes('\u0000')) return sent.messageId;
  return null;
}

function displayMessageId(messageId) {
  return messageId === null ? 'unknown' : JSON.stringify(messageId);
}

// ------------------------------------------------------------------ durability

function readPolicyState(file = ESCALATION_STATE_FILE()) {
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return policy.emptyPolicyState();
    fail('ESCALATION_STATE_UNAVAILABLE', `The escalation state file could not be read (${errorCode(error)}).`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    fail('ESCALATION_STATE_CORRUPT',
      'The escalation state file is not valid JSON. Refusing to reset it silently: that would re-notify everything already sent and erase the record of what was suppressed. Inspect it, then move it aside deliberately.');
  }
  try { return policy.validatePolicyState(parsed); }
  catch (error) { fail('ESCALATION_STATE_CORRUPT', error.message); }
  return undefined; // unreachable
}

function writePolicyState(state, file = ESCALATION_STATE_FILE()) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* the atomic rename already consumed it */ }
  }
}

function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* a spin-free pause is a nicety, not a correctness requirement */ }
}

// OUTCOMES THAT ARE TRUE BUT NOT YET WRITTEN DOWN.
//
// Keyed by state file, because a test and the production path can be running
// against different ones in the same process. Each entry is the exact argument
// list a resolve phase needs, captured at the moment the wire answered:
// { decision, attemptId, delivered, error, now }.
//
// It is not a message store and it is not a second copy of anything the owner
// reads: the message itself is already in the journal and already in the
// directive inbox trail. This holds one BOOKKEEPING fact -- "attempt 7 was
// delivered at T" -- for as long as it takes the next lock acquisition to fold
// it into the same file it always belonged in. If the process dies first, the
// attempt stays visibly `pending` in sinkStatus(), which is the designed
// reading of "we sent something and did not learn what happened to it".
const RESOLUTIONS_OWED = new Map();

function owedFor(target) {
  const owed = RESOLUTIONS_OWED.get(target);
  return Array.isArray(owed) ? owed : [];
}

/**
 * Fold every outcome this process still owes into `state`, oldest first, and
 * return the ones that were applied. Runs INSIDE the lock and BEFORE the
 * caller's own work, so a decision made in the same acquisition sees the
 * dedupe stamp of a delivery that had not been recorded yet -- which is the
 * whole point: the re-send it prevents is exactly a decision taken against a
 * state that was missing one.
 *
 * A resolution that cannot be applied is an inconsistent state, not evidence
 * that the outcome did not matter. Refuse the acquisition and retain the owed
 * list: dropping an outcome would let later readers report definite totals and
 * channel health after one of their contributing updates was lost.
 */
function applyOwedResolutions(state, target) {
  const owed = owedFor(target);
  if (owed.length === 0) return { state, applied: [] };
  const applied = [];
  let next = state;
  for (const entry of owed) {
    try {
      next = policy.applyDecision(next, entry.decision, {
        phase: 'resolve',
        attemptId: entry.attemptId,
        delivered: entry.delivered,
        error: entry.error,
        now: entry.now
      }).state;
      applied.push(entry);
    } catch (error) {
      fail('ESCALATION_STATE_INCONSISTENT',
        `A previously observed escalation outcome could not be applied (${errorCode(error)}); refusing to report or decide from incomplete state.`);
    }
  }
  RESOLUTIONS_OWED.delete(target);
  return { state: next, applied };
}

// Advisory lock around a read-modify-write. Same shape as
// src/lib/owner-chat.js#withLock, including the retry: the sink takes the lock
// twice around one irreversible send and momentary contention must not strand
// a message the channel already accepted.
function withLock(work, file = ESCALATION_STATE_FILE(), { attempts = 5, backoffMs = 25, staleMs = STALE_LOCK_MS } = {}) {
  const target = path.resolve(file);
  const lock = `${target}.lock`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let descriptor = null;
  for (let attempt = 0; attempt < attempts && descriptor === null; attempt += 1) {
    try { descriptor = fs.openSync(lock, 'wx', 0o600); }
    catch (openError) {
      // Only EEXIST establishes contention. Treating EACCES, EIO, or any
      // other failed acquisition as "busy" would tell the caller that another
      // holder exists when the lock state could not actually be established.
      if (!openError || openError.code !== 'EEXIST') {
        fail('ESCALATION_STATE_UNAVAILABLE',
          `The escalation state lock could not be acquired (${errorCode(openError)}); whether it is held is unknown.`);
      }
      // Reclaim a lock whose holder died without reaching the finally block
      // below, rather than fail closed forever. Best-effort: if the lock
      // vanished between the failed open above and this check, do nothing --
      // the next attempt's open call is the real check. Any other failed probe
      // is not evidence of a live holder and must remain distinguishable from
      // ordinary contention.
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > staleMs) fs.unlinkSync(lock);
      } catch (probeError) {
        if (!probeError || probeError.code !== 'ENOENT') {
          fail('ESCALATION_STATE_UNAVAILABLE',
            `The escalation state lock could not be inspected (${errorCode(probeError)}); whether it is held is unknown.`);
        }
      }
      if (attempt === attempts - 1) fail('ESCALATION_STATE_BUSY', 'The escalation state file is busy; retry shortly.');
      pause(backoffMs);
    }
  }
  try {
    const read = readPolicyState(target);
    // Every acquisition pays the owed outcomes first. Doing it here rather than
    // at one call site means no future caller can take this lock and make a
    // decision against a state that is missing a delivery this process already
    // knows about.
    const folded = applyOwedResolutions(read, target);
    const result = work(folded.state);
    if (result && result.state) writePolicyState(result.state, target);
    else if (folded.applied.length) writePolicyState(folded.state, target);
    return result;
  } finally {
    try { fs.closeSync(descriptor); } catch { /* best effort */ }
    try { fs.unlinkSync(lock); } catch { /* best effort */ }
  }
}

// ------------------------------------------------------------------ the message

function assertText(value, label, max) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    fail('ESCALATION_INVALID', `${label} must be a non-blank string of at most ${max} characters.`);
  }
  if (SENSITIVE.test(value)) {
    fail('ESCALATION_LOOKS_SENSITIVE',
      `${label} looks like it contains a credential; nothing was sent. The owner journal is not a vault.`);
  }
}

/**
 * The text a human actually receives. Deliberately mechanical and boring: what,
 * which state, why, and the one command that shows the rest. It carries no
 * judgement and asks for no decision -- deciding what to DO about a detected
 * failure is an agent's job, and a notification that pretends otherwise invites
 * a reader to treat the host as if it had understood the problem.
 */
function composeMessage(candidate, nowMs) {
  const lines = [
    `COORDINATOR ESCALATION: ${candidate.subsystemId} is ${candidate.state}.`,
    candidate.reason
  ];
  if (candidate.detail) lines.push(candidate.detail);
  lines.push(`Detected ${new Date(nowMs).toISOString()} by ${candidate.detectedBy || 'coordinator-duty-host'}.`);
  lines.push('This is an automated notice about a detected condition, not a reply to a message.');
  const text = lines.filter(Boolean).join('\n');
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : text;
}

function normalizeCandidate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('ESCALATION_INVALID', 'The escalation candidate is invalid.');
  }
  // `subsystemId` is canonical. `id` is accepted as an exact alias because
  // src/lib/coordinator/duty-registry.js (a different builder's file, verified
  // at its escalateVia call sites) spells it that way, and every subsystem in
  // config/managed-processes.json is keyed on `id` too. Silently rejecting the
  // spelling the only production caller uses would have turned every real
  // escalation into ESCALATION_INVALID -- which that caller's catch converts
  // into "escalation channel BROKEN", i.e. the failure would have looked like a
  // dead owner channel rather than a field-name mismatch.
  const allowed = ['subsystemId', 'id', 'state', 'reason', 'detail', 'detectedBy', 'acknowledgeDirectiveIds'];
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length) fail('ESCALATION_INVALID', `Unknown escalation field(s): ${unknown.join(', ')}.`);
  if (input.subsystemId !== undefined && input.id !== undefined && String(input.subsystemId) !== String(input.id)) {
    fail('ESCALATION_INVALID', 'subsystemId and id are aliases; passing both with different values is ambiguous.');
  }
  if (input.subsystemId === undefined && input.id !== undefined) {
    input = { ...input, subsystemId: input.id };
  }

  // escalationIdentity does the bounded-identifier validation for both.
  const identity = policy.escalationIdentity(input);
  assertText(input.reason, 'reason', MAX_REASON_LENGTH);
  if (input.detail !== undefined && input.detail !== null) assertText(input.detail, 'detail', MAX_DETAIL_LENGTH);
  if (input.detectedBy !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(String(input.detectedBy))) {
    fail('ESCALATION_INVALID', 'detectedBy is invalid.');
  }
  const ackIds = input.acknowledgeDirectiveIds === undefined ? [] : input.acknowledgeDirectiveIds;
  if (!Array.isArray(ackIds) || ackIds.length > MAX_ACK_IDS
    || ackIds.some(id => typeof id !== 'string' || !/^owner-directive-[a-f0-9-]{36}$/.test(id))) {
    fail('ESCALATION_INVALID', `acknowledgeDirectiveIds must be an array of at most ${MAX_ACK_IDS} owner-directive ids.`);
  }
  return {
    identity,
    subsystemId: String(input.subsystemId),
    state: String(input.state).toUpperCase(),
    reason: input.reason,
    detail: input.detail === undefined || input.detail === null ? null : input.detail,
    detectedBy: input.detectedBy === undefined ? 'coordinator-duty-host' : String(input.detectedBy),
    acknowledgeDirectiveIds: ackIds
  };
}

// ------------------------------------------------------------------ escalate

/**
 * Put a detected failure in front of a human, or say exactly why it did not.
 *
 * NEVER throws for an operational condition (kill switch, suppression, a dead
 * owner channel): those are reported in the returned record so a duty loop can
 * carry on and still surface them. It DOES throw SinkError for a malformed
 * candidate or a corrupt state file, because those are defects and hiding them
 * would be the same mistake this module exists to fix. And once the wire has
 * been used it throws for NOTHING, because a caller that sees an exception
 * cannot tell whether the owner already has the message.
 *
 * Returns a frozen record:
 *   { identity, subsystemId, state, decision, channel, delivered, recorded,
 *     messageId, error, reason, attemptId, inboxItemId, acknowledged,
 *     ackRefusals, atMs }
 * `delivered === true` means and only means the channel confirmed the message:
 * for the default channel that is ./owner-alarm-channel.js having found it in
 * the owner journal on a read-back, not merely having been called.
 */
async function escalate(input = {}, dependencies = {}) {
  const candidate = normalizeCandidate(input);
  const nowFn = dependencies.now || Date.now;
  const nowMs = nowFn();
  const stateFile = path.resolve(dependencies.stateFile || ESCALATION_STATE_FILE());
  const sendFn = dependencies.sendToOwner || ownerAlarmChannel.sendToOwner;
  const appendFn = dependencies.appendDirective || directiveInbox.append;
  const ackFn = dependencies.acknowledgeWithoutReply || ownerChatAcknowledgeWithoutReply;
  const killSwitchStatus = dependencies.killSwitch || killSwitch.status;
  const decideOptions = dependencies.policyOptions || {};

  const base = {
    identity: candidate.identity,
    subsystemId: candidate.subsystemId,
    state: candidate.state,
    atMs: nowMs,
    channel: ownerAlarmChannel.CHANNEL,
    attemptId: null,
    messageId: null,
    // Uniform shape: on every path that never reaches the wire there is no
    // outcome owing, so nothing is unrecorded.
    recorded: true,
    error: null,
    inboxItemId: null,
    acknowledged: Object.freeze([]),
    ackRefusals: Object.freeze([])
  };

  // 1. THE KILL SWITCH, before any decision and before any wire.
  //    Every outward path in this repo goes through policy.assertActive (see
  //    src/lib/providers/messaging.js:185); checking here as well means the
  //    refusal is a RECORDED, typed outcome instead of a thrown provider error
  //    from three frames down. Deliberately does NOT consume budget and does
  //    NOT set the dedupe stamp: when the switch clears, this escalation is
  //    still owed.
  // An UNREADABLE kill switch refuses, exactly like an active one. The safe
  // reading of "I cannot tell whether outward actions are forbidden" is "do
  // not act" — the same rule duty-host.js applies to the same switch. The
  // previous shape here defaulted an unreadable switch to { active: false }
  // and recorded the error on a field nothing ever read, so a corrupt or
  // unreadable switch file silently re-opened the outward owner-channel path.
  let switched;
  try { switched = killSwitchStatus(); }
  catch (error) { switched = { active: true, unreadable: true, error: errorCode(error) }; }
  const switchIsReadable = switched && typeof switched === 'object'
    && (switched.active === true || switched.active === false);
  if (!switchIsReadable || switched.active === true) {
    const unreadable = !switchIsReadable || switched.unreadable === true;
    const switchError = unreadable
      ? errorCode(switched && switched.error ? { code: switched.error } : { code: 'KILLSWITCH_STATUS_INVALID' })
      : null;
    return Object.freeze({
      ...base,
      decision: REFUSED_KILLSWITCH,
      delivered: false,
      error: switchError,
      reason: unreadable
        ? `KILLSWITCH state is unreadable (${switchError}): outward escalation refused until the switch can be read. Unknown is treated as active.`
        : 'KILLSWITCH is active: outward escalation refused. The condition is unreported until the switch is cleared.'
    });
  }

  // 2. Decide, and reserve the attempt durably BEFORE the wire.
  const reserved = withLock(state => {
    const decision = policy.decide(candidate, state, { ...decideOptions, now: nowMs });
    if (decision.decision !== policy.DECISION.SEND) {
      const applied = policy.applyDecision(state, decision, { now: nowMs });
      return { state: applied.state, decision, attemptId: null };
    }
    const applied = policy.applyDecision(state, decision, { phase: 'attempt', now: nowMs });
    return { state: applied.state, decision, attemptId: applied.attemptId };
  }, stateFile);

  if (reserved.decision.decision !== policy.DECISION.SEND) {
    return Object.freeze({
      ...base,
      decision: reserved.decision.decision,
      delivered: false,
      reason: reserved.decision.reason,
      observed: Object.freeze(reserved.decision.observed)
    });
  }

  // 3. The irreversible step. The channel addresses the owner itself.
  const text = composeMessage(candidate, nowMs);
  let sent = null;
  let sendError = null;
  let sendOutcomeUnknown = false;
  try {
    sent = await sendFn({ text });
  } catch (error) {
    sendError = errorCode(error);
    sendOutcomeUnknown = deliveryOutcomeUnknown(error);
  }
  const messageId = readMessageId(sent);
  if (sendError === null && messageId === null) {
    sendError = 'OWNER_CHANNEL_RECEIPT_INVALID';
    sendOutcomeUnknown = true;
  }
  const delivered = sendOutcomeUnknown ? null : sendError === null;
  const channel = sent && typeof sent.channel === 'string' && sent.channel.length <= 40
    ? sent.channel
    : base.channel;

  // 4. The truth, durably. Only `delivered: true` sets the dedupe stamp.
  //
  // THIS STEP MAY NOT THROW, and that is the whole fix. It sits AFTER an
  // irreversible send, between a send step and an inbox step that each already
  // catch. A bare throw here escaped escalate() carrying ESCALATION_STATE_BUSY,
  // which duty-registry.js:201-211 reads as transient contention -- true of the
  // step-2 lock, where nothing has been sent and the escalation really is still
  // owed, and false here, where the owner already has the message. The next
  // cycle then re-sent it, because `delivered: true` is the only thing that
  // writes the dedupe stamp and the stamp had never been written.
  //
  // A LONGER BUDGET FIRST. Every hold on this lock is a synchronous
  // read/mutate/write, so 20 tries at 40ms is ~800ms of worst-case patience for
  // an event that happens at most MAX_SENDS_PER_HOUR times an hour, and it also
  // outlasts the two writers that realistically collide (this host's own cycle
  // and a human running tools/coordinator-escalate.js).
  const resolvedAtMs = nowFn();
  let recorded = true;
  let recordError = null;
  try {
    // An ambiguous transport failure has no truthful resolve value. Keep the
    // already-durable attempt pending rather than caching either delivery or
    // absence; sinkStatus renders pending attempts as unresolved.
    if (sendOutcomeUnknown) throw new SinkError(ESCALATION_DELIVERY_UNKNOWN,
      `The channel did not provide a delivery answer (${sendError}).`);
    withLock(state => {
      const applied = policy.applyDecision(state, reserved.decision, {
        phase: 'resolve',
        attemptId: reserved.attemptId,
        delivered,
        error: sendError,
        now: resolvedAtMs
      });
      return { state: applied.state };
    }, stateFile, { attempts: 20, backoffMs: 40 });
  } catch (error) {
    if (sendOutcomeUnknown) {
      recorded = false;
      recordError = ESCALATION_DELIVERY_UNKNOWN;
    } else {
      // Still true, still not written down. Hand it to the next acquisition
      // rather than dropping it or throwing it at a caller that would re-send.
      recorded = false;
      recordError = `STATE_${errorCode(error)}`;
      RESOLUTIONS_OWED.set(stateFile, [...owedFor(stateFile), {
        decision: reserved.decision,
        attemptId: reserved.attemptId,
        delivered,
        error: sendError,
        now: resolvedAtMs
      }]);
    }
  }

  // 5. The durable trail. SECONDARY to the send, never a substitute for it:
  //    an inbox item is only ever read by an agent that runs the drain command,
  //    which is the very assumption that broke. It exists so a delivered-and-
  //    forgotten or a FAILED escalation still leaves something on disk with the
  //    delivery outcome written into it.
  let inboxItemId = null;
  try {
    const appended = appendFn({
      text: `${text}\n\n[${channel}: ${delivered === true
        ? `delivered (message ${displayMessageId(messageId)})`
        : (sendOutcomeUnknown
          ? `DELIVERY UNKNOWN (${sendError}); this is NOT claiming absence or non-delivery`
          : `NOT DELIVERED (${sendError})`)}]`,
      source: DIRECTIVE_SOURCE,
      submittedBy: DIRECTIVE_ACTOR,
      // One inbox item per identity per re-notify window, matching the send
      // dedupe, so a stuck subsystem cannot bury the owner's own messages.
      idempotencyKey: `escalation:${candidate.subsystemId}:${candidate.state}:${Math.floor(nowMs / (decideOptions.reNotifyMs || policy.RE_NOTIFY_MS))}`.slice(0, 160)
    }, dependencies.inboxOverrides || {});
    // append() returns the flattened safe item: { id, text, status, ..., replayed }.
    inboxItemId = appended && typeof appended.id === 'string' ? appended.id : null;
  } catch (error) {
    // A failed trail write must not turn a delivered escalation into a thrown
    // error; it is recorded on the result instead.
    base.error = `INBOX_${errorCode(error)}`;
  }

  // 6. Machine-sourced directives this notice supersedes. Structurally safe:
  //    acknowledgeWithoutReply throws OWNER_CHAT_NEEDS_A_REPLY on anything the
  //    owner himself sent (src/lib/owner-chat.js:750), so this can never file
  //    away a message he is waiting on.
  const acknowledged = [];
  const ackRefusals = [];
  if (delivered) {
    for (const id of candidate.acknowledgeDirectiveIds) {
      try {
        ackFn({
          id,
          note: `Superseded by coordinator escalation ${candidate.identity} delivered to the owner over ${channel}.`,
          actor: 'coordinator'
        }, {}, dependencies.inboxOverrides || {});
        acknowledged.push(id);
      } catch (error) {
        ackRefusals.push({ id, code: errorCode(error) });
      }
    }
  }

  return Object.freeze({
    ...base,
    decision: policy.DECISION.SEND,
    channel,
    delivered,
    messageId,
    attemptId: reserved.attemptId,
    // Whether the OUTCOME reached the state file, which is a different question
    // from whether the message reached him. A reader that conflates them gets
    // the two failures the wrong way round.
    recorded,
    error: sendOutcomeUnknown
      ? ESCALATION_DELIVERY_UNKNOWN
      : (sendError === null ? (recordError === null ? base.error : recordError) : sendError),
    inboxItemId,
    acknowledged: Object.freeze(acknowledged),
    ackRefusals: Object.freeze(ackRefusals.map(Object.freeze)),
    reason: delivered === true
      ? reserved.decision.reason
      : (sendOutcomeUnknown
        ? `delivery is UNKNOWN because the channel did not answer (${sendError}); this is NOT claiming the message was absent or not delivered`
        : `the escalation was NOT delivered (${sendError}); the condition is unreported to the owner`),
    observed: Object.freeze(reserved.decision.observed)
  });
}

// ------------------------------------------------------------------ readers

/**
 * How many suppressions of each kind have happened since `sinceMs`, from the
 * durable event trail rather than a running counter, so the answer survives a
 * restart and can be checked by reading the file.
 *
 * `truncated` is honest about the bound: the trail keeps the most recent
 * MAX_EVENTS_TRACKED events, so a very old `sinceMs` may under-count.
 */
function suppressedSince(sinceMs = 0, dependencies = {}) {
  if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
    fail('ESCALATION_INVALID', 'sinceMs must be a non-negative integer millisecond timestamp.');
  }
  const stateFile = path.resolve(dependencies.stateFile || ESCALATION_STATE_FILE());
  if (owedFor(stateFile).length > 0) {
    fail('ESCALATION_STATE_INCOMPLETE',
      'Suppression counts are unavailable while an observed escalation outcome has not reached the state file.');
  }
  const state = readPolicyState(stateFile);
  const counts = { duplicate: 0, rateLimit: 0, quietHours: 0, total: 0 };
  let oldest = null;
  for (const event of state.events) {
    if (oldest === null || event.atMs < oldest) oldest = event.atMs;
    if (event.atMs < sinceMs) continue;
    if (event.decision === policy.DECISION.SUPPRESS_DUPLICATE) counts.duplicate += 1;
    else if (event.decision === policy.DECISION.SUPPRESS_RATE_LIMIT) counts.rateLimit += 1;
    else if (event.decision === policy.DECISION.SUPPRESS_QUIET_HOURS) counts.quietHours += 1;
    else continue;
    counts.total += 1;
  }
  return Object.freeze({
    sinceMs,
    ...counts,
    eventsTracked: state.events.length,
    oldestEventAtMs: oldest,
    // The trail is bounded; say so rather than implying completeness.
    truncated: state.events.length >= policy.MAX_EVENTS_TRACKED && oldest !== null && oldest > sinceMs
  });
}

/**
 * Everything a dashboard or a duty-host heartbeat needs to say whether the
 * escalation channel is working. NEVER throws: a status reader that takes down
 * its host is worse than one that reports UNAVAILABLE. A corrupt state file is
 * reported as corrupt, not hidden behind defaults.
 *
 * `channel.broken` is the field that matters. It is true when the last outbound
 * attempt failed, so "no alerts recently" and "alerts cannot be sent" are never
 * the same rendering.
 */
function sinkStatus(dependencies = {}) {
  const nowMs = (dependencies.now || Date.now)();
  const stateFile = path.resolve(dependencies.stateFile || ESCALATION_STATE_FILE());
  const status = {
    observedAtMs: nowMs,
    stateFile,
    stateCorrupt: false,
    error: null,
    killSwitchActive: null,
    channel: null,
    budget: null,
    totals: null,
    suppressed: null,
    // null means UNKNOWN, never zero. A corrupt or unreadable state file must
    // not be able to render as "nothing was suppressed".
    escalationsSuppressed: null,
    pendingAttempts: null,
    entries: null,
    headline: null
  };
  try {
    const killSwitchStatus = dependencies.killSwitch || killSwitch.status;
    status.killSwitchActive = killSwitchStatus().active === true;
  } catch (error) { status.killSwitchActive = null; status.error = errorCode(error); }

  let state;
  const owed = owedFor(stateFile);
  if (owed.length > 0) {
    // AN OUTCOME THIS PROCESS OBSERVED HAS NOT REACHED THE FILE YET.
    //
    // Two different things are true here and they must not be collapsed.
    //
    // UNKNOWN: totals, suppression counts and the per-identity entries. The
    // unapplied outcome is one of their inputs, so any definite number
    // computed now is a number computed from a state that is missing a
    // contributing update. Those stay null, as does the `broken` verdict --
    // the owed outcome IS the result of the last outbound attempt, and
    // folding it can move that verdict in either direction (a delivery clears
    // consecutiveFailures, a failure raises it), so neither true nor false is
    // a claim this file can support.
    //
    // KNOWN: the stranded attempt itself. The reserve phase wrote it to the
    // file BEFORE the wire was used, and the owed list exists precisely
    // because we remember that it is outstanding. Returning null for it would
    // erase the one fact this branch is reporting, and "we sent something and
    // did not learn what happened to it" would then render identically to "no
    // attempt was ever reserved" -- the exact indistinguishability this module
    // exists to remove. So the recorded channel facts and the pending attempts
    // are read out, and the refusal signal above them is unchanged.
    status.error = 'ESCALATION_STATE_INCOMPLETE';
    let incomplete;
    try {
      incomplete = readPolicyState(stateFile);
    } catch (error) {
      // The file is both incomplete AND unreadable. Say both; do not let the
      // second failure quietly replace the first.
      status.stateCorrupt = errorCode(error) === 'ESCALATION_STATE_CORRUPT';
      status.headline = `ESCALATION SINK UNAVAILABLE (ESCALATION_STATE_INCOMPLETE): an observed outcome has not reached the state file, and the file itself could not be read (${errorCode(error)}), so nothing about the channel is readable.`;
      return Object.freeze(status);
    }
    status.channel = {
      broken: null,
      consecutiveFailures: incomplete.consecutiveFailures,
      lastSentAtMs: incomplete.lastSentAtMs,
      lastSentAgeMs: incomplete.lastSentAtMs === null ? null : Math.max(0, nowMs - incomplete.lastSentAtMs),
      lastAttemptAtMs: incomplete.lastAttemptAtMs,
      lastFailureAtMs: incomplete.lastFailureAtMs,
      lastFailureCode: incomplete.lastFailureCode
    };
    status.pendingAttempts = incomplete.attempts
      .filter(attempt => attempt.outcome === 'pending')
      .map(attempt => Object.freeze({ id: attempt.id, atMs: attempt.atMs, identity: attempt.identity }));
    status.headline = `ESCALATION SINK UNAVAILABLE (ESCALATION_STATE_INCOMPLETE): an observed outcome has not reached the state file, so channel health and totals are UNKNOWN. ${status.pendingAttempts.length} attempt(s) are recorded as reserved and unresolved.`;
    return Object.freeze(status);
  }
  try {
    state = readPolicyState(stateFile);
  } catch (error) {
    status.stateCorrupt = errorCode(error) === 'ESCALATION_STATE_CORRUPT';
    status.error = errorCode(error);
    status.headline = `ESCALATION SINK UNAVAILABLE (${status.error}): whether a detected failure can reach the owner is UNKNOWN.`;
    return Object.freeze(status);
  }

  const inWindow = state.attempts.filter(attempt =>
    attempt.atMs > nowMs - policy.RATE_WINDOW_MS && attempt.atMs <= nowMs);
  const pending = state.attempts.filter(attempt => attempt.outcome === 'pending');
  const broken = state.consecutiveFailures > 0;

  status.channel = {
    broken,
    consecutiveFailures: state.consecutiveFailures,
    lastSentAtMs: state.lastSentAtMs,
    lastSentAgeMs: state.lastSentAtMs === null ? null : Math.max(0, nowMs - state.lastSentAtMs),
    lastAttemptAtMs: state.lastAttemptAtMs,
    lastFailureAtMs: state.lastFailureAtMs,
    lastFailureCode: state.lastFailureCode
  };
  const nextGapEligible = state.lastAttemptAtMs === null ? nowMs : state.lastAttemptAtMs + policy.MIN_SEND_GAP_MS;
  status.budget = {
    maxSendsPerHour: policy.MAX_SENDS_PER_HOUR,
    minSendGapMs: policy.MIN_SEND_GAP_MS,
    reNotifyMs: policy.RE_NOTIFY_MS,
    attemptsInLastHour: inWindow.length,
    remainingThisHour: Math.max(0, policy.MAX_SENDS_PER_HOUR - inWindow.length),
    nextEligibleAtMs: Math.max(nextGapEligible, nowMs)
  };
  status.totals = { ...state.totals };
  status.suppressed = {
    duplicate: state.totals.suppressedDuplicate,
    rateLimit: state.totals.suppressedRateLimit,
    quietHours: state.totals.suppressedQuietHours,
    total: state.totals.suppressedDuplicate + state.totals.suppressedRateLimit + state.totals.suppressedQuietHours
  };
  // Flat numeric mirror of suppressed.total. The duty host's heartbeat carries
  // `escalationsSuppressed` as a single number (verified at
  // src/lib/coordinator/duty-registry.js#runEscalationBudgetReport, which reads
  // status.suppressed-as-a-number and falls back to this field). Without it the
  // heartbeat would report the suppression count as null, and "we do not know
  // how many alerts were suppressed" renders identically to "none were" -- the
  // exact indistinguishability this module exists to remove.
  status.escalationsSuppressed = status.suppressed.total;
  // A crash between reserving an attempt and resolving it. Visible on purpose.
  status.pendingAttempts = pending.map(attempt =>
    Object.freeze({ id: attempt.id, atMs: attempt.atMs, identity: attempt.identity }));
  status.entries = Object.values(state.entries)
    .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs)
    .slice(0, dependencies.entryLimit || DEFAULT_STATUS_ENTRIES)
    .map(entry => Object.freeze({
      identity: entry.identity,
      subsystemId: entry.subsystemId,
      state: entry.state,
      lastSeenAtMs: entry.lastSeenAtMs,
      lastSentAtMs: entry.lastSentAtMs,
      sendCount: entry.sendCount,
      failureCount: entry.failureCount,
      lastFailureCode: entry.lastFailureCode,
      suppressed: Object.freeze({ ...entry.suppressed })
    }));

  if (status.killSwitchActive === true) {
    status.headline = 'ESCALATION REFUSED: KILLSWITCH is active. Detected failures are NOT reaching the owner.';
  } else if (broken) {
    status.headline = `ESCALATION CHANNEL BROKEN: ${state.consecutiveFailures} consecutive failed send(s), last ${state.lastFailureCode}. Detected failures are NOT reaching the owner.`;
  } else if (status.pendingAttempts.length > 0) {
    status.headline = `Escalation sink has ${status.pendingAttempts.length} unresolved attempt(s): a send was reserved and never recorded as delivered or failed.`;
  } else if (state.totals.sent === 0 && status.suppressed.total === 0) {
    status.headline = 'Escalation sink has never sent or suppressed anything. Untested in production.';
  } else {
    status.headline = `Escalation sink OK: ${state.totals.sent} sent, ${state.totals.failed} failed, ${status.suppressed.total} suppressed (${status.budget.remainingThisHour}/${policy.MAX_SENDS_PER_HOUR} budget left this hour).`;
  }
  return Object.freeze(status);
}

module.exports = Object.freeze({
  SinkError,
  ESCALATION_STATE_FILE,
  DIRECTIVE_SOURCE,
  REFUSED_KILLSWITCH,
  ESCALATION_DELIVERY_UNKNOWN,
  MAX_MESSAGE_LENGTH,
  composeMessage,
  escalate,
  readPolicyState,
  sinkStatus,
  suppressedSince
});

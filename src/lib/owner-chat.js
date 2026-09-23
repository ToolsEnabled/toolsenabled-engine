'use strict';

// The reverse direction of the owner-directive inbox: draining it and replying.
// Live provider relay ingestion is retired. Existing provider-stamped entries
// remain readable as historical provenance so an upgrade can inventory or
// acknowledge work without rewriting where it originally came from.
//
// This module invents no directive storage: reading and acknowledging go
// through owner-directive-inbox.js. Sending is provider-neutral and requires an
// explicitly injected sendToOwner({ text }) function. state/owner-chat.json
// stores the outbound half: intent, outcome, bounded receipt, and acknowledgement.
//
// THE ORDERING RULE, which is the whole safety argument. reply() does:
//   1. write the intent to the chat log            (state: 'sending')
//   2. await sendToOwner({ text })                  <- the irreversible step
//   3. mark the log entry 'sent' with the message id
//   4. only then acknowledge the directive
// A crash can therefore leave a reply SENT but the directive still UNREAD --
// which is recoverable and loudly visible (pending() reports it as
// deliveredButUnacknowledged) -- but it can NEVER acknowledge a directive whose
// reply was not delivered. A delivery failure marks the log entry 'failed' and
// leaves the directive unread on purpose, so the owner stays visibly waiting
// rather than being silently marked as answered.
//
// THE CONDITION. An unread directive from the owner himself is not one more
// queue item; it is a person waiting. Past STALE_UNREAD_MS it is reported as
// the named condition OWNER_WAITING_FOR_REPLY, which is the loudest state this
// module can express, and it is surfaced by every reader that embeds
// summarize() -- `tools/owner-chat.js --pending` and
// `tools/fleet-supervisor.js --status`.
//
// SENDING IS DIRECTIVE-SCOPED BY DEFAULT. `reply()` remains the normal answer
// path, but `alert()` is the deliberately explicit exception for operational
// alerts/statuses that have no inbound directive to answer. It shares the same
// durable intent -> send -> confirmed-delivery log; it never fabricates a
// directive just to make an unsolicited alert appear traceable.
//
// File-locking and atomic-write shape follows src/lib/owner-directive-inbox.js
// exactly (advisory 'wx' lock, temp-then-rename, mode 0600, bounded log),
// because that pattern is already reviewed and tested here.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { rootPath } = require('./runtime');
const directiveInbox = require('./owner-directive-inbox');

// There is deliberately no default reply transport. Only alert() and reply()
// touch the injected sender; durable reads remain available without loading an
// external provider. OWNER_SOURCES retains one removed-provider value solely to
// classify already-persisted state, never to authorize or accept new ingress.

const VERSION = 1;
const CHAT_FILE = () => rootPath('state', 'owner-chat.json');

// Ten minutes. An owner-sourced directive still unread past this is not
// "queued", it is a person who has been left on read.
const STALE_UNREAD_MS = 10 * 60 * 1000;
// A conservative channel-independent bound for owner-facing reply text.
const MAX_REPLY_LENGTH = 4096;
const MAX_NOTE_LENGTH = 1000;
const MAX_ENTRIES = 500;
const DEFAULT_PENDING_LIMIT = 20;
// Every withLock hold is a synchronous in-memory read/mutate/write, never an
// await -- reply() releases the lock before its injected send and reacquires
// it after (see the header's ORDERING RULE). A lock older than this was
// abandoned by a holder that died before reaching its own finally block, not
// one that is merely busy; ten seconds is generous margin above any
// legitimate hold while still bounding how long a crash wedges the channel.
const STALE_LOCK_MS = 10000;
const MAX_PENDING_LIMIT = 200;
const DEFAULT_TRANSCRIPT_LIMIT = 20;
const MAX_TRANSCRIPT_LIMIT = 200;
const MAX_ALSO_ACKNOWLEDGE = 20;
const DEFAULT_ACTOR = 'controller';

const DIRECTIVE_ID_RE = /^owner-directive-[a-f0-9-]{36}$/;
const ALERT_ID_RE = /^owner-alert-[a-f0-9-]{36}$/;
// Deliberately tighter than the inbox's own ACTOR_RE (no spaces): this actor is
// concatenated into the acknowledgement's `by` string below, and a space-free
// token keeps that string trivially parseable by a human reading the raw JSON.
const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ERROR_CODE_RE = /^[A-Za-z0-9_.:-]{1,60}$/;

// Sources that mean A HUMAN IS WAITING, as opposed to a machine-generated
// directive that nobody is sitting there expecting a
// chat reply to. Kept as a set rather than "everything except the known
// machine sources" so a brand-new machine lane cannot accidentally start
// raising OWNER_WAITING_FOR_REPLY.
const OWNER_SOURCES = Object.freeze(['telegram']);

// The one command a controller has to remember. Every surface that reports the
// condition also prints this, so knowing the condition and knowing what to do
// about it are never two separate pieces of knowledge.
const DRAIN_COMMAND = 'node tools/owner-chat.js --pending';

const ENTRY_KINDS = Object.freeze(['reply', 'ack', 'alert', 'status']);
const ENTRY_STATES = Object.freeze([
  'sending',              // intent recorded, delivery not yet attempted/resolved
  'sent',                 // owner channel confirmed it; acknowledgement not yet done
  'acknowledged',         // delivered AND the directive(s) were acknowledged
  'sent-unacknowledged',  // delivered but the acknowledgement failed -- recoverable
  'failed'                // NOT delivered; the directive stays unread on purpose
]);

const CONDITIONS = Object.freeze({
  CLEAR: 'CLEAR',
  DIRECTIVES_UNREAD: 'DIRECTIVES_UNREAD',
  OWNER_MESSAGE_UNREAD: 'OWNER_MESSAGE_UNREAD',
  OWNER_WAITING_FOR_REPLY: 'OWNER_WAITING_FOR_REPLY',
  UNAVAILABLE: 'UNAVAILABLE'
});

// Same best-effort heuristic backstop as owner-directive-inbox.js's SENSITIVE,
// applied to the OUTBOUND direction: a credential must never be typed into a
// reply and pushed into an owner message history where it may persist.
// Duplicated rather than imported because the inbox does not export it and the
// two are allowed to diverge (inbound and outbound risk are not identical).
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+[A-Za-z0-9._-]{10,}|\b(?:password|passwd|api[-_]?key|secret[-_]?key|access[-_]?token|refresh[-_]?token)\s*[:=]\s*\S|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})/i;

class OwnerChatError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OwnerChatError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) { throw new OwnerChatError(code, message, details); }

function errorCode(error) {
  if (!error) return 'ERROR';
  const code = error.code === undefined || error.code === null ? null : String(error.code);
  if (code && ERROR_CODE_RE.test(code)) return code;
  return 'ERROR';
}

function currentMessageId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\u0000')
    ? value
    : null;
}

function storedMessageId(value) {
  // Numeric ids exist in historical state written by the removed transport.
  // They remain readable migration data but are never accepted from a new send.
  return value === null
    || (Number.isSafeInteger(value) && value >= 0)
    || currentMessageId(value) !== null;
}

// ------------------------------------------------------------------ durable state

function emptyChat() {
  return {
    version: VERSION,
    nextSequence: 1,
    lastDrainedAtMs: null,
    lastDrainedBy: null,
    lastObservation: null,
    entries: []
  };
}

function validateChat(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION
    || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1
    || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
    || (value.lastDrainedAtMs !== null && !Number.isSafeInteger(value.lastDrainedAtMs))
    || (value.lastDrainedBy !== null && !ACTOR_RE.test(String(value.lastDrainedBy || '')))
    || (value.lastObservation !== null && (typeof value.lastObservation !== 'object' || Array.isArray(value.lastObservation)))) {
    fail('OWNER_CHAT_STATE_CORRUPT',
      'The owner chat log is invalid. Refusing to reset it silently: it is the only record of what was actually said back to the owner. Inspect state/owner-chat.json, then move it aside deliberately.');
  }
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1
      || typeof entry.directiveId !== 'string' || (!DIRECTIVE_ID_RE.test(entry.directiveId) && !ALERT_ID_RE.test(entry.directiveId))
      || !ENTRY_KINDS.includes(entry.kind) || !ENTRY_STATES.includes(entry.state)
      || !ACTOR_RE.test(String(entry.actor || ''))
      || typeof entry.text !== 'string' || entry.text.length < 1 || entry.text.length > MAX_REPLY_LENGTH
      || !Array.isArray(entry.alsoAcknowledged)
      || entry.alsoAcknowledged.some(id => typeof id !== 'string' || !DIRECTIVE_ID_RE.test(id))
      || !Number.isSafeInteger(entry.createdAtMs)
      || (entry.sentAtMs !== null && !Number.isSafeInteger(entry.sentAtMs))
      || (entry.acknowledgedAtMs !== null && !Number.isSafeInteger(entry.acknowledgedAtMs))
      || !storedMessageId(entry.messageId)
      || (entry.error !== null && (typeof entry.error !== 'string' || !ERROR_CODE_RE.test(entry.error)))) {
      fail('OWNER_CHAT_STATE_CORRUPT',
        'An owner chat log entry is invalid. Refusing to reset it silently. Inspect state/owner-chat.json, then move it aside deliberately.');
    }
  }
  return value;
}

function readChatLog(file = CHAT_FILE()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyChat();
    fail('OWNER_CHAT_STATE_UNAVAILABLE', `The owner chat log could not be read (${errorCode(error)}).`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    fail('OWNER_CHAT_STATE_CORRUPT',
      'The owner chat log is not valid JSON. Refusing to reset it silently: it is the only record of what was actually said back to the owner. Inspect state/owner-chat.json, then move it aside deliberately.');
  }
  return validateChat(parsed);
}

function writeChatLog(chat, file = CHAT_FILE()) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(chat, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* the atomic rename already consumed it */ }
  }
}

// A bounded synchronous pause. reply() takes the chat lock three times around
// one irreversible send, so a momentary contention must not be able to strand a
// message the owner channel already confirmed.
function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* a spin-free pause is a nicety, not a correctness requirement */ }
}

function withLock(work, file = CHAT_FILE(), { attempts = 5, backoffMs = 25, staleMs = STALE_LOCK_MS } = {}) {
  const target = path.resolve(file);
  const lock = `${target}.lock`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let descriptor = null;
  for (let attempt = 0; attempt < attempts && descriptor === null; attempt += 1) {
    try { descriptor = fs.openSync(lock, 'wx', 0o600); }
    catch {
      // Reclaim a lock whose holder died without reaching the finally block
      // below, rather than fail closed forever. Best-effort: if the lock
      // vanished or was recreated between the failed open above and this
      // check, do nothing -- the next attempt's open call is the real check.
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > staleMs) fs.unlinkSync(lock);
      } catch { /* best effort */ }
      if (attempt === attempts - 1) {
        fail('OWNER_CHAT_BUSY', 'The owner chat log is busy; retry shortly.');
      }
      pause(backoffMs);
    }
  }
  try {
    const chat = readChatLog(target);
    const result = work(chat);
    writeChatLog(chat, target);
    return result;
  } finally {
    try { fs.closeSync(descriptor); } catch { /* best effort */ }
    try { fs.unlinkSync(lock); } catch { /* best effort */ }
  }
}

// Never evict an entry that is still in flight or that recorded a failure --
// those are exactly the ones a reader needs to see.
function prune(chat) {
  while (chat.entries.length > MAX_ENTRIES) {
    const index = chat.entries.findIndex(entry => entry.state === 'acknowledged');
    if (index === -1) {
      chat.entries.splice(0, chat.entries.length - MAX_ENTRIES);
      return;
    }
    chat.entries.splice(index, 1);
  }
}

function updateEntry(file, sequence, mutate) {
  return withLock(chat => {
    const entry = chat.entries.find(candidate => candidate.sequence === sequence);
    if (!entry) {
      fail('OWNER_CHAT_ENTRY_MISSING',
        `Owner chat entry ${sequence} could not be found; refusing to report a durable state transition that was not recorded.`);
    }
    mutate(entry);
    return entry;
  }, file);
}

// Delivery/acknowledgement errors remain the primary error, but failure to
// record that outcome is a separate fact. Return it so the thrown error can
// distinguish "the failure was recorded" from "that could not be established".
function recordEntryFailure(file, sequence, code) {
  try {
    updateEntry(file, sequence, entry => { entry.state = 'failed'; entry.error = code; });
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

function safeEntry(entry) {
  return Object.freeze({
    sequence: entry.sequence,
    directiveId: entry.directiveId,
    alsoAcknowledged: Object.freeze([...entry.alsoAcknowledged]),
    kind: entry.kind,
    state: entry.state,
    actor: entry.actor,
    text: entry.text,
    createdAtMs: entry.createdAtMs,
    sentAtMs: entry.sentAtMs,
    acknowledgedAtMs: entry.acknowledgedAtMs,
    messageId: entry.messageId,
    error: entry.error
  });
}

// ------------------------------------------------------------------ the condition

/**
 * Classify the inbox into the one fact a reader needs: is a person waiting, and
 * for how long. Pure -- takes raw items and a clock, touches no disk.
 */
function classify(items, nowMs) {
  const unread = items.filter(item => item.status === 'unread');
  const ownerUnread = unread.filter(item => OWNER_SOURCES.includes(item.source));
  const mechanicalUnread = unread.length - ownerUnread.length;
  const oldestOwnerAtMs = ownerUnread.length
    ? Math.min(...ownerUnread.map(item => item.createdAtMs)) : null;
  const oldestUnreadAtMs = unread.length
    ? Math.min(...unread.map(item => item.createdAtMs)) : null;
  const waitingMs = oldestOwnerAtMs === null ? null : Math.max(0, nowMs - oldestOwnerAtMs);

  let condition = CONDITIONS.CLEAR;
  if (ownerUnread.length > 0) {
    condition = waitingMs >= STALE_UNREAD_MS
      ? CONDITIONS.OWNER_WAITING_FOR_REPLY
      : CONDITIONS.OWNER_MESSAGE_UNREAD;
  } else if (unread.length > 0) {
    condition = CONDITIONS.DIRECTIVES_UNREAD;
  }

  return {
    condition,
    ownerWaiting: condition === CONDITIONS.OWNER_WAITING_FOR_REPLY,
    unread: unread.length,
    ownerUnread: ownerUnread.length,
    mechanicalUnread,
    actionableUnread: ownerUnread.length,
    oldestUnreadAtMs,
    oldestOwnerUnreadAtMs: oldestOwnerAtMs,
    waitingMs,
    staleThresholdMs: STALE_UNREAD_MS
  };
}

/**
 * Cheap counts-only view for surfaces that embed this in their own status
 * output (for example fleet-supervisor --status). NEVER throws: a
 * reader that cannot look must report UNAVAILABLE loudly rather than take down
 * the surface it is embedded in. Read-only; writes nothing.
 */
function summarize(overrides = {}) {
  const nowMs = (overrides.now || Date.now)();
  const inboxFile = path.resolve(overrides.inboxFile || directiveInbox.INBOX_FILE);
  try {
    const inbox = directiveInbox.readInbox(inboxFile);
    const summary = classify(inbox.items, nowMs);
    let lastDrainedAtMs = null;
    let lastDrainedBy = null;
    let chatLogError = null;
    try {
      const chat = readChatLog(path.resolve(overrides.chatFile || CHAT_FILE()));
      lastDrainedAtMs = chat.lastDrainedAtMs;
      lastDrainedBy = chat.lastDrainedBy;
    } catch (error) {
      // The independently-read inbox condition remains measured, but the
      // drain metadata did not become a definite "never drained" answer.
      chatLogError = errorCode(error);
    }
    return Object.freeze({
      observedAtMs: nowMs,
      ...summary,
      lastDrainedAtMs,
      lastDrainedBy,
      chatLogError,
      drainCommand: DRAIN_COMMAND,
      headline: headline(summary)
    });
  } catch (error) {
    return Object.freeze({
      observedAtMs: nowMs,
      condition: CONDITIONS.UNAVAILABLE,
      ownerWaiting: false,
      unread: null,
      ownerUnread: null,
      mechanicalUnread: null,
      actionableUnread: null,
      oldestUnreadAtMs: null,
      oldestOwnerUnreadAtMs: null,
      waitingMs: null,
      staleThresholdMs: STALE_UNREAD_MS,
      lastDrainedAtMs: null,
      lastDrainedBy: null,
      chatLogError: null,
      drainCommand: DRAIN_COMMAND,
      error: errorCode(error),
      headline: `OWNER INBOX UNAVAILABLE (${errorCode(error)}) -- cannot tell whether the owner is waiting. Run ${DRAIN_COMMAND}`
    });
  }
}

function humanDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * The one line every embedding surface prints. Deliberately shouty for the
 * owner-waiting case and deliberately silent-ish otherwise, so the loud form
 * keeps its meaning.
 */
function headline(summary) {
  switch (summary.condition) {
    case CONDITIONS.OWNER_WAITING_FOR_REPLY:
      return `!! OWNER WAITING FOR A REPLY: ${summary.ownerUnread} unread message(s) from the owner, oldest ${humanDuration(summary.waitingMs)} old. Nothing outranks this. Run ${DRAIN_COMMAND}`;
    case CONDITIONS.OWNER_MESSAGE_UNREAD:
      return `Owner message unread: ${summary.ownerUnread} (oldest ${humanDuration(summary.waitingMs)} old). Run ${DRAIN_COMMAND}`;
    case CONDITIONS.DIRECTIVES_UNREAD:
      return `No owner message is waiting; ${summary.mechanicalUnread} machine-generated directive(s) remain mechanically queued and quiet.`;
    case CONDITIONS.CLEAR:
      return 'Owner directive inbox drained: nothing unread.';
    default:
      return summary.headline || 'Owner directive inbox state unknown.';
  }
}

// ------------------------------------------------------------------ pending

function replyHistoryFor(chat, directiveId) {
  const related = chat.entries.filter(entry =>
    entry.directiveId === directiveId || entry.alsoAcknowledged.includes(directiveId));
  const last = related.length ? related[related.length - 1] : null;
  return {
    attempts: related.length,
    lastState: last ? last.state : null,
    lastAtMs: last ? (last.sentAtMs || last.createdAtMs) : null,
    // A reply the owner channel already confirmed for a directive still
    // unread. Replying again would double-message the owner, so say so.
    delivered: related.some(entry => ['sent', 'sent-unacknowledged', 'acknowledged'].includes(entry.state))
  };
}

/**
 * THE DRAIN CALL. Unread directives, oldest first (the order he said them in),
 * bounded, each annotated with how long it has been waiting and whether a reply
 * was already put on the wire for it. Read-only apart from an optional,
 * best-effort drain stamp so any later reader can see when this was last done.
 */
function pending(input = {}, overrides = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('OWNER_CHAT_INVALID', 'The pending request is invalid.');
  }
  const allowed = ['limit', 'unreadOnly', 'actor', 'stamp', 'includeMachine'];
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    fail('OWNER_CHAT_INVALID', 'The pending request is invalid.');
  }
  const limit = input.limit === undefined ? DEFAULT_PENDING_LIMIT : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING_LIMIT) {
    fail('OWNER_CHAT_INVALID', `limit must be an integer between 1 and ${MAX_PENDING_LIMIT}.`);
  }
  const actor = input.actor === undefined ? DEFAULT_ACTOR : input.actor;
  if (!ACTOR_RE.test(String(actor))) fail('OWNER_CHAT_INVALID', 'actor is invalid.');
  const includeMachine = input.includeMachine === undefined ? false : input.includeMachine;
  if (typeof includeMachine !== 'boolean') fail('OWNER_CHAT_INVALID', 'includeMachine must be a boolean.');

  const nowMs = (overrides.now || Date.now)();
  const inboxFile = path.resolve(overrides.inboxFile || directiveInbox.INBOX_FILE);
  const chatFile = path.resolve(overrides.chatFile || CHAT_FILE());
  const inbox = directiveInbox.readInbox(inboxFile);
  // The owner's unread messages are measured from the INBOX, read above, so a
  // corrupt reply log must not hide them -- this view degrades the way status()
  // does. Reply history does NOT thereby become "none": every history field
  // turns null (unknown), and reply() still reads this log strictly under its
  // own lock, so the duplicate-send guard cannot be bypassed through here.
  let chat = null;
  let chatLogError = null;
  try {
    chat = readChatLog(chatFile);
  } catch (error) {
    chatLogError = errorCode(error);
  }

  const summary = classify(inbox.items, nowMs);
  const allUnread = inbox.items
    .filter(item => item.status === 'unread')
    // The controller's drain is first and foremost for the owner. Machine
    // health noise can arrive much more frequently than a historical owner message,
    // so chronological-only ordering could put every owner message beyond the
    // bounded default view. Preserve chronological order within each class,
    // but always place historical owner-sourced entries ahead of machine work.
    .sort((a, b) => {
      const aRank = a.source === 'telegram' ? 0 : 1;
      const bRank = b.source === 'telegram' ? 0 : 1;
      return (aRank - bRank) || (a.createdAtMs - b.createdAtMs);
    });
  const unread = includeMachine
    ? allUnread
    : allUnread.filter(item => OWNER_SOURCES.includes(item.source));

  const items = unread.slice(0, limit).map(item => {
    const history = chat === null
      ? { attempts: null, lastState: null, lastAtMs: null, delivered: null }
      : replyHistoryFor(chat, item.id);
    const ageMs = Math.max(0, nowMs - item.createdAtMs);
    return Object.freeze({
      id: item.id,
      // Verbatim. Never trimmed, rewrapped, or normalized on the way out --
      // same contract the inbox itself keeps on the way in.
      text: item.text,
      source: item.source,
      submittedBy: item.submittedBy,
      fromOwner: OWNER_SOURCES.includes(item.source),
      createdAtMs: item.createdAtMs,
      ageMs,
      stale: OWNER_SOURCES.includes(item.source) && ageMs >= STALE_UNREAD_MS,
      replyAttempts: history.attempts,
      lastReplyState: history.lastState,
      alreadyDelivered: history.delivered
    });
  });

  // null, not [], when the log is unreadable: an empty list would claim
  // "nothing is awaiting acknowledgement", which nobody measured.
  const deliveredButUnacknowledged = chat === null ? null : chat.entries
    .filter(entry => entry.kind === 'reply' && ['sent', 'sent-unacknowledged'].includes(entry.state))
    .map(safeEntry);

  let stampError = null;
  if (input.stamp === true) {
    // Best effort by design: failing to write a bookkeeping stamp must never
    // stop a reader from seeing that the owner is waiting.
    try {
      withLock(state => {
        state.lastDrainedAtMs = nowMs;
        state.lastDrainedBy = String(actor);
        state.lastObservation = {
          atMs: nowMs,
          condition: summary.condition,
          unread: summary.unread,
          ownerUnread: summary.ownerUnread,
          waitingMs: summary.waitingMs
        };
      }, chatFile);
      // Keep this response's metadata aligned with the write it just made;
      // previously a successful stamp still rendered as the pre-write value.
      if (chat !== null) {
        chat.lastDrainedAtMs = nowMs;
        chat.lastDrainedBy = String(actor);
      }
    } catch (error) {
      stampError = errorCode(error);
    }
  }

  return Object.freeze({
    observedAtMs: nowMs,
    ...summary,
    headline: headline(summary),
    drainCommand: DRAIN_COMMAND,
    limit,
    includeMachine,
    suppressedMachineUnread: includeMachine ? 0 : summary.mechanicalUnread,
    truncated: unread.length > items.length,
    items: Object.freeze(items),
    deliveredButUnacknowledged: deliveredButUnacknowledged === null ? null : Object.freeze(deliveredButUnacknowledged),
    // When chatLogError is set, null drain metadata means UNKNOWN, never
    // "never drained" -- the error code beside it is what says which.
    chatLogError,
    stampAttempted: input.stamp === true,
    stampRecorded: input.stamp === true ? stampError === null : null,
    stampError,
    lastDrainedAtMs: chat === null ? null : chat.lastDrainedAtMs,
    lastDrainedBy: chat === null ? null : chat.lastDrainedBy
  });
}

/**
 * Both directions in one ordered view, newest last. This is the whole of the
 * "threading" story: the owner's messages already carry their own timestamps in
 * the inbox and every reply carries the directive it answered, so a coherent
 * back-and-forth needs no conversation ids -- the merged transcript IS the
 * thread. His next message just lands as a new directive and appears here.
 */
function transcript(input = {}, overrides = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('OWNER_CHAT_INVALID', 'The transcript request is invalid.');
  }
  const allowed = ['limit'];
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    fail('OWNER_CHAT_INVALID', 'The transcript request is invalid.');
  }
  const limit = input.limit === undefined ? DEFAULT_TRANSCRIPT_LIMIT : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRANSCRIPT_LIMIT) {
    fail('OWNER_CHAT_INVALID', `limit must be an integer between 1 and ${MAX_TRANSCRIPT_LIMIT}.`);
  }
  const inboxFile = path.resolve(overrides.inboxFile || directiveInbox.INBOX_FILE);
  const chatFile = path.resolve(overrides.chatFile || CHAT_FILE());
  const inbox = directiveInbox.readInbox(inboxFile);
  // Refuse rather than return an inbound-only transcript as the complete
  // conversation when the outbound half could not be measured.
  const chat = readChatLog(chatFile);

  // 'owner' is reserved for words HE actually typed. A machine-generated
  // directive (for example a dashboard write) is 'system' -- a
  // transcript that labels a scheduled-task observation as something the owner
  // said is a transcript nobody can trust.
  const inbound = inbox.items.map(item => ({
    direction: OWNER_SOURCES.includes(item.source) ? 'owner' : 'system',
    atMs: item.createdAtMs,
    id: item.id,
    source: item.source,
    status: item.status,
    text: item.text
  }));
  const outbound = chat.entries.map(entry => ({
    direction: entry.kind === 'ack' ? 'note' : 'controller',
    atMs: entry.sentAtMs || entry.createdAtMs,
    id: entry.directiveId,
    source: 'owner_chat',
    status: entry.state,
    text: entry.text
  }));
  // Ties go inbound-first: within the same millisecond, what arrived comes
  // before what was said back about it.
  const rank = direction => (['owner', 'system'].includes(direction) ? 0 : 1);
  const merged = [...inbound, ...outbound]
    .sort((a, b) => (a.atMs - b.atMs) || (rank(a.direction) - rank(b.direction)));
  return Object.freeze({
    total: merged.length,
    items: Object.freeze(merged.slice(-limit).map(Object.freeze))
  });
}

// ------------------------------------------------------------------ reply

// The acknowledgement's `by` string. It is deliberately self-describing: read
// the raw state/owner-directive-inbox.json and you can see not just WHO
// acknowledged a directive but that it was acknowledged because a reply with
// a confirmed opaque receipt was delivered. The receipt is hashed and bounded
// to stay inside the inbox's own 120-character ACTOR_RE.
/**
 * The owner-ward transport, or a refusal naming why there is not one.
 *
 * Called BEFORE anything durable is written, so a refusal leaves no half-sent
 * entry in state/owner-chat.json -- the same ordering rule the rest of this
 * module follows for every other pre-flight check.
 */
function requireSender(dependencies) {
  const sendFn = dependencies.sendToOwner;
  if (typeof sendFn !== 'function') {
    fail('OWNER_CHAT_NO_TRANSPORT',
      'There is no reply-capable owner transport configured, so this message was NOT sent. Inject a bounded sendToOwner({ text }) dependency to deliver it.');
  }
  return sendFn;
}

function ackActor(actor, messageId) {
  const safeId = currentMessageId(messageId);
  const receiptHash = safeId === null ? null
    : crypto.createHash('sha256').update(safeId, 'utf8').digest('hex').slice(0, 24);
  const suffix = receiptHash === null ? 'reply sent' : `reply receipt-${receiptHash}`;
  return `${actor} via owner-chat ${suffix}`.slice(0, 120);
}

function noteActor(actor, sequence) {
  return `${actor} via owner-chat ack ${sequence}`.slice(0, 120);
}

function assertReplyText(text) {
  if (typeof text !== 'string' || text.length < 1 || text.length > MAX_REPLY_LENGTH) {
    fail('OWNER_CHAT_INVALID', `The reply text must be a string of 1 to ${MAX_REPLY_LENGTH} characters.`);
  }
  if (text.trim().length === 0) fail('OWNER_CHAT_INVALID', 'The reply text must not be blank.');
  if (SENSITIVE.test(text)) {
    fail('OWNER_CHAT_LOOKS_SENSITIVE',
      'This reply looks like it contains a credential; it was NOT sent. An owner message history is not a vault -- use tools/secrets.ps1 or the masked credential prompt.');
  }
}

/**
 * Send a proactive operational alert/status without inventing an inbound
 * directive. The record is intentionally written before the wire call and is
 * only marked sent after the owner channel supplies a bounded opaque receipt. A failed
 * delivery stays visible in the same transcript as normal owner replies.
 */
async function alert(input = {}, dependencies = {}, overrides = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('OWNER_CHAT_INVALID', 'The owner alert request is invalid.');
  }
  const allowed = ['text', 'actor', 'kind'];
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    fail('OWNER_CHAT_INVALID', 'The owner alert request is invalid.');
  }
  const actor = input.actor === undefined ? DEFAULT_ACTOR : input.actor;
  if (!ACTOR_RE.test(String(actor))) fail('OWNER_CHAT_INVALID', 'actor is invalid.');
  const kind = input.kind === undefined ? 'alert' : input.kind;
  if (!['alert', 'status'].includes(kind)) fail('OWNER_CHAT_INVALID', 'kind must be alert or status.');
  const text = input.text;
  // The shared detector is deliberately reused for proactive text too. An
  // owner transcript is never an acceptable credential store.
  assertReplyText(text);

  const nowFn = overrides.now || Date.now;
  const chatFile = path.resolve(overrides.chatFile || CHAT_FILE());
  const sendFn = requireSender(dependencies);
  const createdAtMs = nowFn();
  const alertId = `owner-alert-${crypto.randomUUID()}`;
  const sequence = withLock(chat => {
    const entry = {
      sequence: chat.nextSequence++,
      directiveId: alertId,
      alsoAcknowledged: [],
      kind,
      state: 'sending',
      actor: String(actor),
      text,
      createdAtMs,
      sentAtMs: null,
      acknowledgedAtMs: null,
      messageId: null,
      error: null
    };
    chat.entries.push(entry);
    prune(chat);
    return entry.sequence;
  }, chatFile);

  let sent;
  try {
    sent = await sendFn({ text });
  } catch (error) {
    const code = errorCode(error);
    const recordError = recordEntryFailure(chatFile, sequence, code);
    fail(code, `The owner ${kind} was NOT delivered (${code}).${recordError ? ` Its durable failure record could not be established (${recordError}).` : ''}`,
      { recordError });
  }

  const messageId = currentMessageId(sent && sent.messageId);
  if (messageId === null) {
    const code = 'OWNER_CHAT_DELIVERY_UNCONFIRMED';
    const recordError = recordEntryFailure(chatFile, sequence, code);
    fail(code, `The owner ${kind} was NOT confirmed delivered: the owner channel returned no durable message id.${recordError ? ` Its durable failure record could not be established (${recordError}).` : ''}`,
      { recordError });
  }

  const sentAtMs = nowFn();
  updateEntry(chatFile, sequence, entry => {
    entry.state = 'sent';
    entry.sentAtMs = sentAtMs;
    entry.messageId = messageId;
  });
  return Object.freeze({ sequence, alertId, kind, delivered: true, messageId, sentAtMs, text });
}

function resolveTargets(inbox, ids) {
  return ids.map(id => {
    const item = inbox.items.find(candidate => candidate.id === id);
    if (!item) fail('OWNER_CHAT_DIRECTIVE_NOT_FOUND', `Directive ${id} is not in the inbox.`);
    if (item.status !== 'unread') {
      fail('OWNER_CHAT_ALREADY_ACKNOWLEDGED',
        `Directive ${id} was already acknowledged by ${item.acknowledgedBy || 'someone'}; refusing to reply twice.`);
    }
    return item;
  });
}

/**
 * Reply to one unread directive over the pinned owner chat and acknowledge it.
 *
 * Order is load-bearing (see the header): intent, then send, then acknowledge.
 * A delivery failure throws OWNER_CHAT_DELIVERY_FAILED and leaves every target
 * directive UNREAD, with the failure recorded in the chat log.
 *
 * `alsoAcknowledge` acknowledges further unread directives against this same
 * delivered reply -- the honest shape for "he sent three messages and I
 * answered all three in one".
 */
async function reply(input = {}, dependencies = {}, overrides = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('OWNER_CHAT_INVALID', 'The reply request is invalid.');
  }
  const allowed = ['id', 'text', 'actor', 'alsoAcknowledge'];
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    fail('OWNER_CHAT_INVALID', 'The reply request is invalid.');
  }
  if (typeof input.id !== 'string' || !DIRECTIVE_ID_RE.test(input.id)) {
    fail('OWNER_CHAT_INVALID', 'id must be an owner-directive id.');
  }
  const actor = input.actor === undefined ? DEFAULT_ACTOR : input.actor;
  if (!ACTOR_RE.test(String(actor))) fail('OWNER_CHAT_INVALID', 'actor is invalid.');
  const text = input.text;
  assertReplyText(text);
  const also = input.alsoAcknowledge === undefined ? [] : input.alsoAcknowledge;
  if (!Array.isArray(also) || also.length > MAX_ALSO_ACKNOWLEDGE
    || also.some(id => typeof id !== 'string' || !DIRECTIVE_ID_RE.test(id))) {
    fail('OWNER_CHAT_INVALID', `alsoAcknowledge must be an array of at most ${MAX_ALSO_ACKNOWLEDGE} owner-directive ids.`);
  }
  const targetIds = [input.id, ...also.filter(id => id !== input.id)];

  const nowFn = overrides.now || Date.now;
  const inboxFile = path.resolve(overrides.inboxFile || directiveInbox.INBOX_FILE);
  const chatFile = path.resolve(overrides.chatFile || CHAT_FILE());
  const sendFn = requireSender(dependencies);
  const ackFn = dependencies.acknowledge || directiveInbox.acknowledge;

  // Refuse BEFORE anything irreversible: unknown id, or already acknowledged.
  resolveTargets(directiveInbox.readInbox(inboxFile), targetIds);

  // 1. Intent, durable, before the wire.
  const createdAtMs = nowFn();
  const sequence = withLock(chat => {
    const entry = {
      sequence: chat.nextSequence++,
      directiveId: input.id,
      alsoAcknowledged: targetIds.slice(1),
      kind: 'reply',
      state: 'sending',
      actor: String(actor),
      text,
      createdAtMs,
      sentAtMs: null,
      acknowledgedAtMs: null,
      messageId: null,
      error: null
    };
    chat.entries.push(entry);
    prune(chat);
    return entry.sequence;
  }, chatFile);

  // 2. The irreversible step. The injected sender owns destination selection;
  //    no provider address is chosen, passed, or known here.
  let sent;
  try {
    sent = await sendFn({ text });
  } catch (error) {
    const code = errorCode(error);
    const recordError = recordEntryFailure(chatFile, sequence, code);
    fail('OWNER_CHAT_DELIVERY_FAILED',
      `The reply was NOT delivered (${code}). ${targetIds.length === 1 ? 'The directive stays' : 'All target directives stay'} unread on purpose -- the owner is still waiting.${recordError ? ` Its durable failure record could not be established (${recordError}).` : ''}`,
      { recordError });
  }

  const sentAtMs = nowFn();
  const messageId = currentMessageId(sent && sent.messageId);
  if (messageId === null) {
    const code = 'OWNER_CHAT_DELIVERY_UNCONFIRMED';
    const recordError = recordEntryFailure(chatFile, sequence, code);
    fail(code, `The reply was NOT confirmed delivered: the owner channel returned no durable message id. ${targetIds.length === 1 ? 'The directive stays' : 'All target directives stay'} unread on purpose.${recordError ? ` Its durable failure record could not be established (${recordError}).` : ''}`,
      { recordError });
  }
  // 3. Delivered. Record that BEFORE acknowledging anything.
  updateEntry(chatFile, sequence, entry => {
    entry.state = 'sent';
    entry.sentAtMs = sentAtMs;
    entry.messageId = messageId;
  });

  // 4. Only now acknowledge, with the delivery as the evidence.
  const by = ackActor(String(actor), messageId);
  const acknowledged = [];
  const ackFailures = [];
  for (const id of targetIds) {
    try {
      ackFn({ id, by }, { inboxFile });
      acknowledged.push(id);
    } catch (error) {
      ackFailures.push({ id, code: errorCode(error) });
    }
  }
  const acknowledgedAtMs = nowFn();
  updateEntry(chatFile, sequence, entry => {
    entry.state = ackFailures.length ? 'sent-unacknowledged' : 'acknowledged';
    entry.acknowledgedAtMs = ackFailures.length ? null : acknowledgedAtMs;
    entry.error = ackFailures.length ? ackFailures[0].code : null;
  });

  return Object.freeze({
    sequence,
    delivered: true,
    messageId,
    sentAtMs,
    acknowledged: Object.freeze(acknowledged),
    ackFailures: Object.freeze(ackFailures.map(Object.freeze)),
    acknowledgedBy: by,
    text
  });
}

/**
 * Acknowledge a directive that needs no chat reply -- a machine-generated
 * status record, a dashboard smoke test, anything the
 * controller actioned rather than answered. SENDS NOTHING. The note is the
 * evidence and is stored in the same chat log, so "why was this acknowledged"
 * always has an answer.
 */
function acknowledgeWithoutReply(input = {}, dependencies = {}, overrides = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('OWNER_CHAT_INVALID', 'The acknowledge request is invalid.');
  }
  const allowed = ['id', 'note', 'actor'];
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    fail('OWNER_CHAT_INVALID', 'The acknowledge request is invalid.');
  }
  if (typeof input.id !== 'string' || !DIRECTIVE_ID_RE.test(input.id)) {
    fail('OWNER_CHAT_INVALID', 'id must be an owner-directive id.');
  }
  const actor = input.actor === undefined ? DEFAULT_ACTOR : input.actor;
  if (!ACTOR_RE.test(String(actor))) fail('OWNER_CHAT_INVALID', 'actor is invalid.');
  const note = input.note;
  if (typeof note !== 'string' || note.trim().length === 0 || note.length > MAX_NOTE_LENGTH) {
    fail('OWNER_CHAT_INVALID', `note must be a non-blank string of at most ${MAX_NOTE_LENGTH} characters -- an acknowledgement without a reason is how the inbox went write-only in the first place.`);
  }
  if (SENSITIVE.test(note)) {
    fail('OWNER_CHAT_LOOKS_SENSITIVE', 'That note looks like it contains a credential; nothing was stored.');
  }

  const nowFn = overrides.now || Date.now;
  const inboxFile = path.resolve(overrides.inboxFile || directiveInbox.INBOX_FILE);
  const chatFile = path.resolve(overrides.chatFile || CHAT_FILE());
  const ackFn = dependencies.acknowledge || directiveInbox.acknowledge;

  const [item] = resolveTargets(directiveInbox.readInbox(inboxFile), [input.id]);
  // Refuse to silently swallow a message the OWNER is waiting on: those are
  // answered, not filed. This is the guard that keeps --ack from becoming a
  // convenient way to make the loud condition go away.
  if (OWNER_SOURCES.includes(item.source)) {
    fail('OWNER_CHAT_NEEDS_A_REPLY',
      `Directive ${input.id} came from the owner (source ${item.source}). He is waiting for an answer, not a filing. Use --reply.`);
  }

  const atMs = nowFn();
  const sequence = withLock(chat => {
    const entry = {
      sequence: chat.nextSequence++,
      directiveId: input.id,
      alsoAcknowledged: [],
      kind: 'ack',
      state: 'sending',
      actor: String(actor),
      text: note,
      createdAtMs: atMs,
      sentAtMs: null,
      acknowledgedAtMs: null,
      messageId: null,
      error: null
    };
    chat.entries.push(entry);
    prune(chat);
    return entry.sequence;
  }, chatFile);

  try {
    ackFn({ id: input.id, by: noteActor(String(actor), sequence) }, { inboxFile });
  } catch (error) {
    const code = errorCode(error);
    const recordError = recordEntryFailure(chatFile, sequence, code);
    fail('OWNER_CHAT_ACK_FAILED', `The directive could not be acknowledged (${code}); it stays unread.${recordError ? ` Its durable failure record could not be established (${recordError}).` : ''}`,
      { recordError });
  }
  updateEntry(chatFile, sequence, entry => {
    entry.state = 'acknowledged';
    entry.acknowledgedAtMs = atMs;
  });

  return Object.freeze({ sequence, id: input.id, acknowledged: true, note });
}

module.exports = Object.freeze({
  OwnerChatError,
  VERSION,
  CHAT_FILE,
  CONDITIONS,
  DRAIN_COMMAND,
  OWNER_SOURCES,
  STALE_UNREAD_MS,
  MAX_REPLY_LENGTH,
  MAX_ENTRIES,
  acknowledgeWithoutReply,
  alert,
  classify,
  emptyChat,
  headline,
  humanDuration,
  pending,
  readChatLog,
  reply,
  summarize,
  transcript
});

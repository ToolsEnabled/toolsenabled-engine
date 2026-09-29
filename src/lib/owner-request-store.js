'use strict';

// THE ONE PLACE THE PERSON'S REQUESTS ARE FILED, EDITED, REMOVED AND DECIDED.
//
// Before this module there were two stores for the same fact: the canonical
// JSON ledger (reports/OWNER-REQUEST-LEDGER.json, written by the owner-capture
// CLI and read by every gate, digest and projection) and four markdown files
// behind /Request (src/lib/r-ledger.js). Product rule: one
// canonical ledger with scope tiers, filed by /Request*, managed on /ledger.
// This module is that ledger's single write API and its tier reader;
// src/lib/r-ledger.js is now a thin adapter over it so every existing caller
// keeps its names.
//
// WHAT IS WRITTEN, AND WHERE.
//   reports/OWNER-REQUEST-LEDGER.json          the record (one JSON document)
//   state/owner-request-record-events.jsonl    the history chain (append-only)
// Both resolve LAZILY through runtime-state-root.statePath at call time, never
// as module-load constants: the shell sets the state root before any payload
// require, the isolated test runner sets it per run, and one suite flips it in
// process. `options.rootPath` (a function, the shape r-ledger.js always took)
// overrides both.
//
// READS NEVER CREATE FILES. An absent ledger answers exists:false and empty
// lists. ensureLedger runs on the write paths only.
//
// NO AUDIT CALL HERE. audit.record() runs prepare() synchronously, which on this
// machine has blocked the shell's main thread for seconds; the person's own
// /Request must never wait on that. The hash chain below is the tamper-evident
// record. The agent tool path keeps its audit intent in r-ledger-agent-gate.js.
//
// THE FOUR DURABLE PRIMITIVES ARE LOCAL. tools/owner-capture.js exports them,
// but requiring it pulls owner-directive-notification -> agent-comms and its
// lock (src/lib/agent-digest/lock.js) probes the process identity with a
// powershell.exe launch on Windows -- 5 s cold, on the main thread, on the first
// /Request. So this file carries its own atomic write (temp + fsync +
// read-back + .bak + rename), its own shape check, its own finalize and its own
// lock. THE LOCK IS THE SAME FILE THE CLI FAMILY TAKES: `<ledger>.lock`, in the
// record shape the digest lock classifies, so a /Request typed in the app and
// an owner-capture reconcile exclude each other instead of racing one
// read-modify-write. The protocol is spelled out above acquireLock.
//
// DELETE IS A TOMBSTONE. Nothing is ever spliced out of requests[]: a removed
// record keeps its number (never reissued), its words and its history, with
// status 'removed'. Edit rewrites the words in place and keeps the words before
// in the record's history. Both, and decide, refuse any actor but 'owner'.
//
// `actor: 'owner'` IS A CONVENTION, NOT A CREDENTIAL. This module cannot tell
// who is calling it; it trusts the actor word it is handed. The product's
// person-only doors are what make that word true: the shell's personOnly
// handlers (a /Request typed in the app), the bridge's owner-ui channel, and
// the MCP transport binding that hands every agent tool call to the agent gate
// (src/lib/r-ledger-agent-gate.js), which never passes 'owner' through. The
// CLI tools/r-ledger.js edit and remove verbs run as the person by design: a
// terminal on this machine is the person's own hand, the same as the app.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { statePath } = require('./runtime-state-root');
const { isRequestId, parseRequestId } = require('./request-id');
const { normalizeProvenance } = require('./owner-request-provenance');
const { readWaitingFor, assertTaskDependencies } = require('./task-waiting');
const { THREAD_ID_RE } = require('./owner-request-scope');
const { TASK_DIFFICULTY_SETTING_ID, newTaskDifficultyFields, planTaskDifficultyReview, resolveTaskAssignment } = require('./task-difficulty');
const killSwitch = require('./kill-switch');

const LEDGER_FILE = 'reports/OWNER-REQUEST-LEDGER.json';
const HISTORY_FILE = 'state/owner-request-record-events.jsonl';
const LOCK_SUFFIX = '.lock';
const LOCK_WRITER = 'owner-request-store';

const SCOPES = Object.freeze(['global', 'session', 'tree', 'thread']);
const SCOPE_WORD = Object.freeze({
  global: 'every agent',
  session: 'this session and everything it spawns',
  tree: 'this agent and every agent below it',
  thread: 'this agent, this conversation only'
});
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_WORDS_BYTES = 16 * 1024;
const MAX_FILED_BY_CHARS = 80;
const MAX_LABEL_CHARS = 120;
const MAX_REASON_BYTES = 2048;
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 8192;
const MAX_EVENTS = 250000;
const SCHEMA_VERSION = 1;

const STATUS_VOCABULARY = Object.freeze({
  proposed: 'Filed by an agent; waiting for you.',
  open: 'Accepted, not started.',
  'in-progress': 'Actively being worked.',
  partial: 'Substantially delivered with a stated shortfall.',
  'blocked-external': 'Cannot proceed without owner action.',
  done: 'Delivered and independently verified.',
  'not-possible-as-asked': 'The literal request cannot be satisfied.',
  superseded: 'Replaced by a later rule; kept for the record.',
  declined: 'You declined it.',
  removed: 'You deleted it; kept for the record.'
});
const ACTIVE_STATUSES = Object.freeze(new Set(['open', 'in-progress', 'partial', 'blocked-external']));
const DECLINABLE_STATUSES = Object.freeze(new Set(['proposed', 'open', 'in-progress', 'partial', 'blocked-external']));
const APPROVABLE_STATUSES = Object.freeze(new Set(['proposed', 'open', 'in-progress', 'partial', 'blocked-external']));
const HIDDEN_STATUSES = Object.freeze(new Set(['declined', 'removed']));
/* THE STATUSES decide() CANNOT REACH. decide() is an approve/decline gate --
   its whole transition table yields `open`, unchanged, or `declined` -- so
   before resolve() these five had no writer anywhere in this file, `done`
   among them. A request the person had finished stayed `open` for ever and
   its only exits misdescribed it as "You declined it" or "You deleted it".
   `superseded` is new to the vocabulary rather than borrowed from a word that
   already meant something else. */
const RESOLUTION_STATUSES = Object.freeze(new Set(['in-progress', 'partial', 'blocked-external', 'done', 'not-possible-as-asked', 'superseded']));
// 'drift-observed' is informational: the store found a record that differed
// from the chain's last word on it as a write touched it, and recorded the
// two hashes before recording the write. It never speaks for the record.
/* 'resolve' joins this list with resolve(). The chain READER validates every
   line's kind against it, so a writer whose kind is missing here appends a line
   the reader then rejects -- verifyHistory reports the file as edited in place
   at that line. Measured while building resolve(): the row wrote, the chain
   broke, and a store that records an unverifiable history is worse than one
   that cannot record the status at all. A new event kind and its writer land
   together or neither lands. Union with the T/A/P kinds this branch already
   carries (complete, answer, record, supersede): membership in this list is
   all readChain/verifyHistory check, so adding one kind never disturbs another. */
const EVENT_KINDS = Object.freeze(['file', 'edit', 'remove', 'approve', 'decline', 'drift-observed', 'complete', 'answer', 'record', 'supersede', 'resolve', 'recover', 'reset', 'handoff']);
const HANDOFF_EVENT_KIND = 'handoff';
const HANDOFF_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HANDOFF_HISTORY_ID = /^handoff:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HANDOFF_OPERATION_PHASES = Object.freeze(new Set(['prepared', 'committed', 'finalized']));
const HANDOFF_DESTINATIONS = Object.freeze(new Set(['verified-parent', 'verified-no-parent']));
const HANDOFF_ACTIVE_STATUSES = Object.freeze(new Set([...ACTIVE_STATUSES, 'recurring']));
const OWNER_GONE_CLEANUP_KIND = 'owner-gone-all';
const OWNER_GONE_CLEANUP_MODES = Object.freeze(new Set(['privacy-exit', 'full-reset']));
const OWNER_GONE_CLEANUP_REASONS = Object.freeze({
  'privacy-exit': 'privacy cleanup on exit',
  'full-reset': 'full reset',
});
const TASK_LEDGER_COORDINATOR_ACTORS = Object.freeze(new Set(['human', 'agent']));
const TASK_LEDGER_POLICY_DENIED = 'T_LEDGER_WRITER_POLICY_DENIED';
const BOM = '\uFEFF';

// ---------------------------------------------------------------------------
// Kinds -- one ledger file holds four record families. R records are the
// person's standing requests. T records are work items that an agent may
// close out and delete. A records are questions or needs an agent raises
// for the person to answer. P records are purchases: a proposed spend, the
// decision on it, and the charge recorded once it is made. The three newer
// families reuse R's construction rather than inventing their own. R above
// is untouched: its ids (assertId, family 'R'), its reader (isStoreRecordId,
// family 'R' only, still exactly as written) and its vocabulary
// (STATUS_VOCABULARY) are exactly what they were. T, A and P are
// flat-numbered families sharing the same ledger file, the same lock, the
// same hash chain (coreOf below is UNCHANGED -- kind is deliberately not
// part of the hashed core, so a chain already written under the old formula,
// including any existing R ledger, keeps verifying) and the same
// atomic write.
// ---------------------------------------------------------------------------

const KIND_ID_RE = Object.freeze({
  T: /^T([1-9]\d*)$/,
  A: /^A([1-9]\d*)$/,
  P: /^P([1-9]\d*)$/
});
const KIND_LABEL = Object.freeze({ R: 'rule', T: 'task', A: 'ask', P: 'purchase' });

// Exported so a caller can show the right word for the right kind; never
// written into the ledger document (statusVocabulary on disk stays R's
// alone, built by finalize() exactly as it always was).
const TASK_STATUS_VOCABULARY = Object.freeze({
  open: 'Filed; a one-shot task, not yet done.',
  'in-progress': 'Actively being worked.',
  done: 'Completed.',
  recurring: 'A repeating task; each run logs a completion and it stays recurring.',
  'blocked-external': 'Cannot proceed without owner action.',
  superseded: 'Replaced by a newer task; terminal, like done or removed.',
  removed: 'Deleted; kept for the record.'
});
const ASK_STATUS_VOCABULARY = Object.freeze({
  open: 'Filed by an agent; waiting for you to answer.',
  answered: 'You answered it.',
  declined: 'You declined to answer it.',
  removed: 'Deleted; kept for the record.'
});
const PURCHASE_STATUS_VOCABULARY = Object.freeze({
  proposed: 'Filed by an agent; waiting for your decision.',
  approved: 'You approved it; waiting for the charge to record.',
  declined: 'You declined it.',
  recorded: 'Approved and the charge is recorded.',
  removed: 'Deleted; kept for the record.'
});
const TASK_COMPLETABLE_STATUSES = Object.freeze(new Set(['open', 'in-progress', 'recurring']));
// A task already done, removed or superseded is not a live target for a new
// supersede: each of those already ends the task's own lifecycle, and a
// terminal record cannot be terminated a second way.
const TASK_SUPERSEDE_BLOCKED_STATUSES = Object.freeze(new Set(['done', 'removed', 'superseded']));
const ASK_ANSWERABLE_STATUSES = Object.freeze(new Set(['open']));
const ASK_DECLINABLE_STATUSES = Object.freeze(new Set(['open']));
const PURCHASE_DECIDABLE_STATUSES = Object.freeze(new Set(['proposed']));
const PURCHASE_RECORDABLE_STATUSES = Object.freeze(new Set(['approved']));

/** The kind (R, T, A or P) a ledger id belongs to, read from its own spelling. Null for anything else. */
function idKind(id) {
  if (isRequestId(id, { family: 'R' })) return 'R';
  if (typeof id !== 'string') return null;
  for (const kind of ['T', 'A', 'P']) if (KIND_ID_RE[kind].test(id)) return kind;
  return null;
}

/** A record's own kind: the stored field once one is written; the id's letter for a legacy row that predates it. */
function recordKindOf(entry) {
  if (plain(entry) && typeof entry.kind === 'string' && KIND_LABEL[entry.kind]) return entry.kind;
  return plain(entry) && typeof entry.id === 'string' ? idKind(entry.id) : null;
}

function assertKindId(kind, id) {
  if (typeof id !== 'string' || !KIND_ID_RE[kind].test(id)) {
    fail('R_LEDGER_ID_INVALID', `${KIND_LABEL[kind]} ids look like ${kind}1, ${kind}2, ...`);
  }
  return id;
}

/* The next number for one kind, over the file and the chain both -- the same
   never-reissue rule childId and nextRootNumber already give R, applied to a
   flat (unrefined) family instead of a dotted one. */
function nextKindNumber(kind, document, chain) {
  let highest = 0;
  for (const entry of document.data.requests) {
    if (plain(entry) && typeof entry.id === 'string' && KIND_ID_RE[kind].test(entry.id)) {
      highest = Math.max(highest, Number(KIND_ID_RE[kind].exec(entry.id)[1]));
    }
  }
  for (const event of chain.events) {
    if (typeof event.requestId === 'string' && KIND_ID_RE[kind].test(event.requestId)) {
      highest = Math.max(highest, Number(KIND_ID_RE[kind].exec(event.requestId)[1]));
    }
  }
  return highest + 1;
}
const PERSON = 'owner';
const FILED_BY_PATTERN = /^[^\r\n\t\0]{1,80}$/;

const GENESIS_SHA256 = sha256('owner-request-record-events:genesis');
const TRANSIENT_WRITE_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const WRITE_ATTEMPTS = 8;
const LOCK_WAIT_ATTEMPTS = 10;
const LOCK_WAIT_MS = 25;

class OwnerRequestStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerRequestStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OwnerRequestStoreError(code, message);
}

/* A handoff writer is deliberately capability-shaped rather than payload-
 * shaped. The shell registers one native writer around its removal authority;
 * callers receive only the returned methods and cannot manufacture the
 * registration, principal or topology resolver from JSON. This is not an
 * authentication system by itself -- the host owns the registration boundary
 * -- but it prevents a renderer descriptor from becoming trustedOptions. */
const taskLedgerWriterRegistrations = new WeakMap();

function registeredTaskLedgerWriter(registration) {
  const config = taskLedgerWriterRegistrations.get(registration);
  if (!config) fail('T_LEDGER_WRITER_UNAVAILABLE', 'The authenticated task Ledger writer is not registered. No handoff was changed.');
  return config;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Sorted-key canonical JSON, the same formula tools/ledger-archive.js uses for
// its overlay: key order and whitespace never read as a change; content does.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function chainHash(previousSha256, event) {
  const { eventSha256, ...core } = event;
  void eventSha256;
  return sha256(`${previousSha256}\n${canonical(core)}`);
}

function todayString(now) {
  return now.toISOString().slice(0, 10);
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// ---------------------------------------------------------------------------
// Where the files are
// ---------------------------------------------------------------------------

function filesFor(options = {}) {
  const opts = plain(options) ? options : {};
  if (typeof opts.ledgerFile === 'string' && opts.ledgerFile) {
    const ledgerFile = path.resolve(opts.ledgerFile);
    const historyFile = typeof opts.historyFile === 'string' && opts.historyFile
      ? path.resolve(opts.historyFile)
      : path.join(path.dirname(path.dirname(ledgerFile)), 'state', 'owner-request-record-events.jsonl');
    return { ledgerFile, historyFile };
  }
  if (typeof opts.rootPath === 'function') {
    return {
      ledgerFile: opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'),
      historyFile: opts.rootPath('state', 'owner-request-record-events.jsonl')
    };
  }
  return {
    ledgerFile: statePath('reports', 'OWNER-REQUEST-LEDGER.json'),
    historyFile: statePath('state', 'owner-request-record-events.jsonl')
  };
}

function ledgerFileFor(options) { return filesFor(options).ledgerFile; }
function historyFileFor(options) { return filesFor(options).historyFile; }

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertScope(scope) {
  if (!SCOPES.includes(scope)) fail('R_LEDGER_SCOPE_INVALID', `scope must be one of ${SCOPES.join(', ')}.`);
  return scope;
}

function assertKey(scope, key, { strict = false } = {}) {
  if (scope === 'global') {
    if (strict && typeof key === 'string' && key.trim() !== '') {
      fail('R_LEDGER_KEY_INVALID', 'a global request takes no key; leave it out.');
    }
    return null;
  }
  if (typeof key !== 'string' || !SAFE_KEY.test(key)) {
    fail('R_LEDGER_KEY_INVALID', `a ${scope} request needs its ${scope} id (letters, digits, . _ -).`);
  }
  return key;
}

function normalizeWords(words) {
  if (typeof words !== 'string') fail('R_LEDGER_WORDS_INVALID', 'the request must be text.');
  const trimmed = words.replace(/\r\n/g, '\n').trim();
  if (!trimmed) fail('R_LEDGER_WORDS_EMPTY', 'the request is empty; nothing to file.');
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_WORDS_BYTES) fail('R_LEDGER_WORDS_TOO_LONG', `the request exceeds ${MAX_WORDS_BYTES} bytes.`);
  return trimmed;
}

function normalizeFiledBy(filedBy) {
  if (filedBy === undefined || filedBy === null) return PERSON;
  if (typeof filedBy !== 'string') fail('R_LEDGER_FILED_BY_INVALID', 'filedBy must be text.');
  const trimmed = filedBy.trim();
  if (!trimmed) return PERSON;
  if (trimmed.length > MAX_FILED_BY_CHARS || !FILED_BY_PATTERN.test(trimmed)) {
    fail('R_LEDGER_FILED_BY_INVALID', `filedBy must be one line of at most ${MAX_FILED_BY_CHARS} characters.`);
  }
  return trimmed;
}

function normalizeLabel(label) {
  if (label === undefined || label === null) return null;
  if (typeof label !== 'string') fail('R_LEDGER_LABEL_INVALID', 'the label must be text.');
  const trimmed = label.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LABEL_CHARS) fail('R_LEDGER_LABEL_INVALID', `the label must be at most ${MAX_LABEL_CHARS} characters.`);
  return trimmed;
}

function normalizeReason(reason) {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string') fail('R_LEDGER_REASON_INVALID', 'the reason must be text.');
  const trimmed = reason.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return null;
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_REASON_BYTES) fail('R_LEDGER_REASON_INVALID', `the reason exceeds ${MAX_REASON_BYTES} bytes.`);
  return trimmed;
}

function assertPerson(actor) {
  if (actor !== PERSON) fail('R_LEDGER_PERSON_REQUIRED', 'Only the person edits, deletes, approves or declines a request. Ask them to do it on the Ledger page.');
}

// src/lib/providers/pay.js journals this EXACT string as approvedBy for the
// direct auto-approved spend path: a purchase that falls within the owner's
// own standing outward.reserved_from_agents setting, decided by that setting,
// never by a person clicking. decidePurchase journals whichever actor
// actually decided -- so a setting-approved purchase is never misrecorded as
// an owner click, and (product rule: asks and purchases are
// agent-closable) an agent-decided purchase is never misrecorded as this setting
// either. R's edit/remove/decide/resolve and A/P's own remove stay
// assertPerson-only; A's answer/decline and P's decide do not, as of that
// ruling -- this is a scoped widening of those three writers, not a general
// widening of who "the person" is.
const OUTWARD_RESERVED_SETTING_ACTOR = 'setting:outward.reserved_from_agents';
// UNCALLED since a later product rule widened decidePurchase to any
// actor: kept, not deleted, as the definition of what the OLD gate was, for
// anyone tracing OUTWARD_RESERVED_SETTING_ACTOR's history. Nothing in this
// file calls it any more.
function assertPurchaseDecider(actor) {
  if (actor !== PERSON && actor !== OUTWARD_RESERVED_SETTING_ACTOR) {
    fail('R_LEDGER_PERSON_REQUIRED', 'Only the person, or the owner\'s own standing outward-spend setting, decides a purchase.');
  }
}

function assertId(id) {
  if (!isRequestId(id, { family: 'R' })) fail('R_LEDGER_ID_INVALID', 'ids look like R12, or a refinement like R12.1.');
  return id;
}

function clockOf(now) {
  if (typeof now === 'function') return () => new Date(now());
  return () => new Date();
}

// ---------------------------------------------------------------------------
// Reading the record
// ---------------------------------------------------------------------------

function emptyLedger() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: todayString(new Date()), statusVocabulary: { ...STATUS_VOCABULARY }, requests: [] };
}

function validateShape(data, ledgerFile) {
  const name = path.basename(ledgerFile);
  if (!plain(data)) fail('R_LEDGER_SHAPE_INVALID', `${name} is not a JSON object.`);
  if (!Array.isArray(data.requests)) fail('R_LEDGER_SHAPE_INVALID', `${name} has no requests list.`);
  if (data.handoffOperations !== undefined) {
    if (!Array.isArray(data.handoffOperations)) fail('R_LEDGER_SHAPE_INVALID', `${name} has an invalid handoff operation list.`);
    const operations = new Set();
    for (const operation of data.handoffOperations) {
      if (!plain(operation) || typeof operation.operationId !== 'string'
          || !HANDOFF_OPERATION_ID.test(operation.operationId)
          || operations.has(operation.operationId)
          || !HANDOFF_OPERATION_PHASES.has(operation.phase)
          || !Array.isArray(operation.taskIds)
          || !Number.isSafeInteger(operation.taskCount)
          || operation.taskCount !== operation.taskIds.length
          || (operation.sourceTombstone !== undefined && typeof operation.sourceTombstone !== 'boolean')
          || (operation.postimageSha256 !== undefined
            && (typeof operation.postimageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(operation.postimageSha256)))
          || (operation.coordinatorIdentity !== undefined && !storedCoordinatorIdentityValid(operation.coordinatorIdentity))
          || (operation.reservationBinding !== undefined && !storedReservationBindingValid(operation.reservationBinding))
          || (operation.consumedReservation !== undefined && !storedConsumedReservationValid(operation.consumedReservation))
          || (operation.journal !== undefined && (!plain(operation.journal)
            || !Number.isSafeInteger(operation.journal.sequence) || operation.journal.sequence < 1
            || !/^[a-f0-9]{64}$/.test(operation.journal.eventSha256 || '')
            || !/^[a-f0-9]{64}$/.test(operation.journal.operationSha256 || '')
            || !Number.isSafeInteger(operation.journal.ledgerRevision) || operation.journal.ledgerRevision < 1))) {
        fail('R_LEDGER_SHAPE_INVALID', `${name} has an invalid handoff operation.`);
      }
      operations.add(operation.operationId);
      if (operation.cleanupKind !== undefined) {
        const cleanupShapeOk = operation.cleanupKind === OWNER_GONE_CLEANUP_KIND
          && OWNER_GONE_CLEANUP_MODES.has(operation.mode)
          && operation.sourceNodeId === null
          && Array.isArray(operation.sourceNodeIds)
          && operation.sourceNodeIds.every(id => typeof id === 'string' && SAFE_KEY.test(id))
          && new Set(operation.sourceNodeIds).size === operation.sourceNodeIds.length
          && Array.isArray(operation.taskStatuses)
          && operation.taskStatuses.length === operation.taskCount
          && operation.taskStatuses.every(row => plain(row) && typeof row.id === 'string'
            && typeof row.status === 'string' && ['tree', 'thread'].includes(row.scope)
            && typeof row.scopeKey === 'string' && SAFE_KEY.test(row.scopeKey))
          && Array.isArray(operation.taskSnapshot)
          && operation.taskSnapshot.length === operation.taskCount
          && operation.taskSnapshot.every(row => plain(row) && typeof row.id === 'string'
            && typeof row.status === 'string' && ['tree', 'thread'].includes(row.scope)
            && typeof row.scopeKey === 'string' && SAFE_KEY.test(row.scopeKey)
            && typeof row.coreSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.coreSha256))
          && typeof operation.taskSetDigest === 'string' && /^[a-f0-9]{64}$/.test(operation.taskSetDigest)
          && typeof operation.reason === 'string'
          && operation.reason === OWNER_GONE_CLEANUP_REASONS[operation.mode]
          && plain(operation.destination) && operation.destination.kind === 'owner-gone'
          && operation.destination.parentNodeId === null;
        if (!cleanupShapeOk) fail('R_LEDGER_SHAPE_INVALID', `${name} has an invalid all-node owner-gone cleanup operation.`);
      }
    }
  }
  const seen = new Set();
  for (const entry of data.requests) {
    if (!plain(entry) || typeof entry.id !== 'string' || !entry.id) fail('R_LEDGER_SHAPE_INVALID', `${name} has a request with no id.`);
    if (seen.has(entry.id)) fail('R_LEDGER_SHAPE_INVALID', `${name} lists ${entry.id} twice.`);
    if (entry.reset !== undefined) {
      if (!plain(entry.reset) || Object.keys(entry.reset).sort().join(',') !== 'actor,at,batchId,kind,revision'
          || !/^[0-9a-f-]{36}$/i.test(entry.reset.batchId || '') || !Object.prototype.hasOwnProperty.call(KIND_LABEL, entry.reset.kind)
          || entry.reset.actor !== PERSON || entry.reset.kind !== recordKindOf(entry)
          || !Number.isInteger(entry.reset.revision) || entry.reset.revision < 0
          || !Number.isFinite(Date.parse(entry.reset.at))) {
        fail('R_LEDGER_SHAPE_INVALID', `${name} has an invalid reset marker.`);
      }
    }
    seen.add(entry.id);
  }
}

/* The document as it is on disk: { exists, raw, data }. Absent -> an empty
   document and raw ''. Unreadable bytes are a refusal, never an empty ledger:
   a caller must not file R1 over a record it could not read. `written` (only
   from readDocumentForWrite) is the document this process last wrote; it
   stands in for the parse only when the file holds exactly its text. */
function readDocument(ledgerFile, written = null) {
  let stat;
  try {
    stat = fs.statSync(ledgerFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (backupUsable(ledgerFile)) {
        fail('R_LEDGER_RESET_PARTIAL', 'the Ledger document is absent while its non-empty .bak remains; recovery must reconcile the reset before new owners can be admitted.');
      }
      return { exists: false, raw: '', data: emptyLedger() };
    }
    throw error;
  }
  if (stat.size > MAX_LEDGER_BYTES) fail('R_LEDGER_TOO_LARGE', `the ledger exceeds ${MAX_LEDGER_BYTES} bytes.`);
  const raw = fs.readFileSync(ledgerFile, 'utf8');
  if (written && raw === written.raw) return { exists: true, raw, data: written.data };
  let data;
  // An editor that saved the file with a byte-order mark did not change the record.
  try { data = JSON.parse(raw.startsWith(BOM) ? raw.slice(BOM.length) : raw); } catch {
    fail('R_LEDGER_UNREADABLE', `the ledger is not valid JSON.${backupUsable(ledgerFile) ? ' Restore it from the .bak beside it, then try again.' : ' Restore it from a backup, then try again.'}`);
  }
  validateShape(data, ledgerFile);
  return { exists: true, raw, data };
}

/* Only a .bak that exists and holds bytes is worth pointing the person at. */
function backupUsable(ledgerFile) {
  try { return fs.statSync(`${ledgerFile}.bak`).size > 0; } catch { return false; }
}

/* A LEDGER THAT HAS NOT CHANGED IS NOT PARSED AGAIN (T1763).
 *
 * Every agent Ledger lookup (ledger.read, a one-id find, a boot stack) went
 * through readAll(), which read and parsed the WHOLE document every time. The
 * owner host runs agent tool calls inside the app's main process, so on LIVE
 * .47 each of 2,306 ledger.read calls in 2.5 h held the window for the parse of
 * a 12.5 MB file: 55-60 ms each, measured offline on a same-size scrambled copy.
 *
 * So the parsed document is kept between reads, keyed by the file itself: the
 * same (dev, ino, size, mtime, ctime) stamp historyStamp() uses for the history
 * file. Any write through this store drops it (atomicWrite), and any other
 * writer -- another process, a hand edit, a restore -- changes the stamp, so
 * the next read parses the new bytes in full. Only a successful, validated
 * parse is kept; an unreadable or mis-shaped file is refused on every read.
 *
 * NOT ONE FIELD ALONE. Windows can report ino 0 and some file systems keep
 * mtime to the second or two, so no single field decides. And a file changed
 * in place within one timestamp tick of the read that cached it could keep
 * every field -- Windows moves file times on its 15.6 ms clock tick, so an
 * edit that restores the old mtime can leave even the change time as it was
 * -- so a document is only kept once BOTH its modification and its change
 * time are older than that tick: 3 s when either is reported in whole
 * milliseconds or coarser (FAT keeps 2 s), 50 ms otherwise. A read of a file
 * changed more recently than that simply parses it again. MEASURED on
 * Windows 10 (NTFS) 2026-09-24: with only the mtime aged, a same-size edit in
 * place that restored the mtime was served from the kept copy.
 *
 * NEVER SHARED MUTABLE. The kept document is deep-frozen before anyone sees
 * it, and read-only callers receive it as it is: readAll()'s records point
 * into it, so a caller that tries to change a returned record's gates,
 * decisions or history throws instead of changing what the next reader sees.
 * Writers never get it: transact() and the lock-holding previews read the
 * file fresh, exactly as before, because they change what they read.
 *
 * BOUNDED: a handful of Ledger files per process, oldest first. */
const SHARED_LEDGER_DOCUMENTS = 4;
const COARSE_LEDGER_TIMESTAMP_MS = 3000;
const FINE_LEDGER_TIMESTAMP_MS = 50;
const sharedLedgerDocuments = new Map();

function deepFreezeDocument(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreezeDocument(child);
  }
  return value;
}

function ledgerStamp(ledgerFile) {
  const stat = fs.statSync(ledgerFile, { bigint: true });
  const nanoseconds = (ns, ms) => BigInt(ns ?? Math.round(Number(ms) * 1e6));
  const mtimeNs = nanoseconds(stat.mtimeNs, stat.mtimeMs);
  const ctimeNs = nanoseconds(stat.ctimeNs, stat.ctimeMs);
  const changedNs = ctimeNs > mtimeNs ? ctimeNs : mtimeNs;
  return {
    isFile: stat.isFile(),
    key: [stat.dev, stat.ino, stat.size, mtimeNs, ctimeNs].map(String).join(':'),
    changedMs: Number(changedNs / 1000000n),
    coarse: mtimeNs % 1000000n === 0n || ctimeNs % 1000000n === 0n
  };
}

function settledLedgerStamp(stamp) {
  return Date.now() - stamp.changedMs > (stamp.coarse ? COARSE_LEDGER_TIMESTAMP_MS : FINE_LEDGER_TIMESTAMP_MS);
}

function forgetSharedLedgerDocument(ledgerFile) {
  sharedLedgerDocuments.delete(ledgerFile);
}

/* The document for a caller that only reads it: { exists, data }, data
   deep-frozen. Same refusals as readDocument(), which it uses for every fill. */
function readSharedDocument(ledgerFile) {
  let before = null;
  try { before = ledgerStamp(ledgerFile); }
  catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  const known = before && sharedLedgerDocuments.get(ledgerFile);
  if (known && known.key === before.key) return known.document;
  if (!before) forgetSharedLedgerDocument(ledgerFile);
  const fresh = readDocument(ledgerFile);
  const document = Object.freeze({ exists: fresh.exists, data: deepFreezeDocument(fresh.data) });
  if (!before || !before.isFile || !fresh.exists || !settledLedgerStamp(before)) return document;
  let after = null;
  try { after = ledgerStamp(ledgerFile); } catch { return document; }
  if (after.key !== before.key) return document;
  sharedLedgerDocuments.delete(ledgerFile);
  sharedLedgerDocuments.set(ledgerFile, { key: before.key, document });
  while (sharedLedgerDocuments.size > SHARED_LEDGER_DOCUMENTS) {
    sharedLedgerDocuments.delete(sharedLedgerDocuments.keys().next().value);
  }
  return document;
}

/* A LEDGER WRITE PARSES THE LEDGER ONCE, NOT THREE TIMES (T1801).
 *
 * Every Ledger write (an agent's t_ledger.progress, a filing, a decision) ran
 * on the app's main thread and parsed the whole document three times: to read
 * it (transact -> readDocument), to check the text it was about to write, and
 * again to check the temp file after the fsync. On LIVE .47's 12.5 MB Ledger a
 * write held the window for 180-240 ms; LIVE made about 675 in 2.5 h.
 *
 * The temp file is now checked BYTE FOR BYTE against the text that was checked
 * before it was written (writeLedgerFile). Identical bytes parse identically,
 * and any difference -- a short write, one changed byte, even one that still
 * parses -- is refused before the rename, so the check is stricter than the
 * parse it replaces.
 *
 * And the document this process last wrote -- the parse of exactly the text now
 * on disk, already checked -- is kept for the NEXT write only. That write still
 * reads the file under the lock (the .bak needs its bytes anyway) and uses the
 * kept document only when the file holds exactly the text this process wrote.
 * Another writer, a hand edit or a restore in between makes the text differ,
 * and the file is parsed and checked in full, exactly as before, so a change
 * made elsewhere is never written over. It is handed out once, because the
 * write changes what it is given: a refused or no-op write leaves nothing
 * behind, and the write after it reads the file in full.
 *
 * Readers never see it: they get the frozen read memo above, which a writer
 * cannot use because writers change what they read (a copy costs more than
 * the parse). verifyHistory and the lock-holding previews read the file fresh.
 * The file's format is unchanged: the other writers of this file
 * (tools/owner-capture.js, tools/ledger-merge.js) write it pretty-printed too,
 * and tests/owner-ledger-contract.js reports Ledger line numbers.
 *
 * BOUNDED: a handful of Ledger files per process, oldest first. */
const WRITTEN_LEDGER_DOCUMENTS = 4;
const writtenLedgerDocuments = new Map();

function keepWrittenLedgerDocument(ledgerFile, written) {
  writtenLedgerDocuments.delete(ledgerFile);
  writtenLedgerDocuments.set(ledgerFile, written);
  while (writtenLedgerDocuments.size > WRITTEN_LEDGER_DOCUMENTS) {
    writtenLedgerDocuments.delete(writtenLedgerDocuments.keys().next().value);
  }
}

/* The document for the writer that holds the lock: what readDocument() answers,
   data private and changeable. */
function readDocumentForWrite(ledgerFile) {
  const written = writtenLedgerDocuments.get(ledgerFile) || null;
  writtenLedgerDocuments.delete(ledgerFile);
  return readDocument(ledgerFile, written);
}

function parentIdOf(id) {
  const parsed = parseRequestId(id);
  if (!parsed || parsed.segments.length === 0) return null;
  const above = parsed.segments.slice(0, -1);
  return `${parsed.root}${above.length ? `.${above.join('.')}` : ''}`;
}

// Preserve absent legacy fields on reads and ordinary writes. Malformed saved
// fields remain visible; explicit grading/review operations validate them.
function taskDifficultyFields(entry) {
  if (recordKindOf(entry) !== 'T') return {};
  const fields = {};
  for (const key of ['difficulty', 'failedReviewCount']) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) fields[key] = entry[key];
  }
  return fields;
}

// Called only inside the store transaction. The hook is an internal host/test
// dependency, never a tool payload flag or a renderer settings snapshot.
function taskDifficultyEnabled(options) {
  try {
    const read = options.loadSettings || require('./settings').loadSettings;
    const snapshot = read();
    if (!plain(snapshot) || typeof snapshot.then === 'function' || !plain(snapshot.values)) throw new Error('settings unavailable');
    if (Array.isArray(snapshot.rejected) && snapshot.rejected.some(row => row?.id === '*' || row?.id === TASK_DIFFICULTY_SETTING_ID)) throw new Error('rejected grading setting');
    const enabled = snapshot.values[TASK_DIFFICULTY_SETTING_ID];
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('invalid grading setting');
    return enabled === true;
  } catch {
    fail('T_LEDGER_DIFFICULTY_SETTINGS_UNAVAILABLE', 'The saved task difficulty setting could not be read. Try again before filing or reviewing this task.');
  }
}

/* One record as the readers see it. Records the owner-capture CLI wrote have
   no scopeKey/filedBy/history; they normalise here and are never rewritten by
   a read. */
/* The task query must expose the durable handoff state that a presentation
   reader needs without making it reconstruct an operation from journal rows.
   The operation document is the authoritative join: a decision alone does
   not distinguish a confirmed node removal from a committed handoff whose
   topology publication is still uncertain. */
function unknownHandoffProjection(entry) {
  return Object.freeze({
    operationId: null,
    phase: null,
    sourceBarrier: null,
    sourceTombstone: false,
    sourcePreimageRetained: true,
    publicationState: 'unknown',
    publicationReasonCode: 'T_LEDGER_HANDOFF_PROJECTION_AMBIGUOUS',
    sourceNodeId: null,
    ownerState: typeof entry.ownerState === 'string' && entry.ownerState ? entry.ownerState : null,
    ownerNodeId: typeof entry.ownerNodeId === 'string' && entry.ownerNodeId ? entry.ownerNodeId : null,
    destination: null,
    reason: null,
    journal: null,
  });
}

function handoffTaskBindingFor(operation, taskId) {
  if (!Array.isArray(operation?.taskBindings)) return null;
  return operation.taskBindings.find(binding => plain(binding) && binding.taskId === taskId) || null;
}

function assertHandoffTaskBinding(entry, operation, chain) {
  if (operation?.phase === 'prepared') return;
  const binding = handoffTaskBindingFor(operation, entry?.id);
  if (!binding || !Number.isSafeInteger(binding.seq) || binding.seq < 1
      || typeof binding.eventSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.eventSha256)
      || typeof binding.coreSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.coreSha256)
      || typeof binding.statusAfter !== 'string') {
    fail('T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE', 'The handoff task binding is absent or incomplete. No phase is inferred from the saved task.');
  }
  const event = chain?.events?.find(candidate => candidate.seq === binding.seq);
  const history = Array.isArray(entry.history) ? entry.history : [];
  const linkedHistory = history.find(row => plain(row)
    && row.kind === HANDOFF_EVENT_KIND
    && row.operationId === operation.operationId
    && row.seq === binding.seq
    && row.eventSha256 === binding.eventSha256);
  if (!event || event.kind !== HANDOFF_EVENT_KIND || event.requestId !== entry.id
      || event.operation?.operationId !== operation.operationId
      || event.statusAfter !== binding.statusAfter
      || event.eventSha256 !== binding.eventSha256
      || event.coreSha256 !== binding.coreSha256
      || !linkedHistory) {
    fail('T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE', 'The handoff task history is missing or does not match its journal binding. No phase is inferred from the saved task.');
  }
  const latestHistory = history.at(-1);
  const latestEvent = chain.events
    .filter(candidate => candidate.requestId === entry.id && candidate.kind !== 'drift-observed')
    .at(-1);
  if (!plain(latestHistory) || !latestEvent
      || latestEvent.requestId !== entry.id
      || latestEvent.eventSha256 !== latestHistory.eventSha256
      || latestEvent.statusAfter !== entry.status
      || latestEvent.coreSha256 !== coreSha256(entry)) {
    fail('T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE', 'The current task core is not bound to its latest history event. No phase is inferred from the saved task.');
  }
}

function assertHandoffTaskBindings(data, operation, chain) {
  if (operation?.phase === 'prepared') return;
  if (!Array.isArray(operation?.taskIds) || !Array.isArray(operation?.taskBindings)
      || operation.taskBindings.length !== operation.taskIds.length) {
    fail('T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE', 'The handoff operation has no complete per-task journal binding. No phase is inferred from the saved operation.');
  }
  const entries = new Map(data.requests.filter(entry => plain(entry) && typeof entry.id === 'string')
    .map(entry => [entry.id, entry]));
  const seen = new Set();
  for (const taskId of operation.taskIds) {
    if (seen.has(taskId)) fail('T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE', 'The handoff operation contains duplicate task bindings. No phase is inferred from the saved operation.');
    seen.add(taskId);
    const entry = entries.get(taskId);
    if (!entry) fail('T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE', `Task ${taskId} is absent from the saved handoff postimage. No phase is inferred from the saved operation.`);
    assertHandoffTaskBinding(entry, operation, chain);
  }
}

function handoffProjectionOf(entry, operations, chain) {
  if (recordKindOf(entry) !== 'T' || !Array.isArray(operations)) return null;
  const candidates = operations.filter(candidate => plain(candidate)
    && typeof candidate.operationId === 'string'
    && Array.isArray(candidate.taskIds) && candidate.taskIds.includes(entry.id));
  if (!candidates.length) return null;
  if (!plain(chain) || chain.broken) return unknownHandoffProjection(entry);
  const ordered = candidates.map(operation => {
    const journal = plain(operation.journal) ? operation.journal : null;
    const sequence = journal && Number.isSafeInteger(journal.sequence) && journal.sequence > 0 ? journal.sequence : null;
    const operationSha256 = journal && typeof journal.operationSha256 === 'string' ? journal.operationSha256 : null;
    let chainJoined = false;
    try {
      handoffJournalEvent(operation, chain);
      assertHandoffTaskBinding(entry, operation, chain);
      chainJoined = true;
    } catch {
      chainJoined = false;
    }
    const validIdentity = chainJoined && sequence !== null
      && /^[a-f0-9]{64}$/.test(operationSha256 || '')
      && operationSha256 === sha256(canonical(operationEvent(operation)));
    return { operation, sequence, validIdentity };
  });
  if (ordered.some(row => !row.validIdentity)) return unknownHandoffProjection(entry);
  const sequences = ordered.map(row => row.sequence);
  if (new Set(sequences).size !== sequences.length) return unknownHandoffProjection(entry);
  const latestSequence = Math.max(...sequences);
  const latest = ordered.filter(row => row.sequence === latestSequence);
  if (latest.length !== 1) return unknownHandoffProjection(entry);
  const operation = latest[0].operation;
  const phase = HANDOFF_OPERATION_PHASES.has(operation.phase) ? operation.phase : null;
  const sourceBarrier = typeof operation.sourceBarrier === 'string' ? operation.sourceBarrier : null;
  const sourceTombstone = operation.sourceTombstone === true;
  const sourcePreimageRetained = operation.sourcePreimageRetained === true;
  const ownerGoneCleanup = operation.cleanupKind === OWNER_GONE_CLEANUP_KIND;
  const phaseFieldsValid = ownerGoneCleanup
    ? ((phase === 'prepared' && sourceBarrier === 'pending' && sourcePreimageRetained && !sourceTombstone)
      || (phase === 'committed' && sourceBarrier === 'retained' && sourcePreimageRetained && !sourceTombstone)
      || (phase === 'finalized' && sourceBarrier === 'released' && !sourcePreimageRetained && sourceTombstone))
    : ((phase === 'prepared' && sourceBarrier === 'pending'
        && sourcePreimageRetained && !sourceTombstone)
      || (phase === 'committed' && sourceBarrier === 'retained'
        && sourcePreimageRetained && !sourceTombstone)
      || (phase === 'finalized' && sourceBarrier === 'released'
        && !sourcePreimageRetained && sourceTombstone));
  if (!phaseFieldsValid) return unknownHandoffProjection(entry);
  const publicationState = phase === 'finalized' && sourceBarrier === 'released' && sourceTombstone
    ? 'confirmed'
    : (phase === 'committed' && sourceBarrier === 'retained' ? 'uncertain' : 'pending');
  const destination = plain(operation.destination)
    ? Object.freeze({
        kind: typeof operation.destination.kind === 'string' ? operation.destination.kind : null,
        parentNodeId: typeof operation.destination.parentNodeId === 'string' ? operation.destination.parentNodeId : null,
        parentTreeId: typeof operation.destination.parentTreeId === 'string' ? operation.destination.parentTreeId : null,
        parentLabel: typeof operation.destination.parentLabel === 'string' ? operation.destination.parentLabel : null,
      })
    : null;
  const destinationValid = handoffDestinationValid(destination, operation.sourceNodeId, ownerGoneCleanup);
  if (!destinationValid) return unknownHandoffProjection(entry);
  const rawJournal = plain(operation.journal) ? operation.journal : null;
  const journal = rawJournal
    && Number.isSafeInteger(rawJournal.sequence)
    && Number.isSafeInteger(rawJournal.ledgerRevision)
    ? Object.freeze({
        sequence: rawJournal.sequence,
        ledgerRevision: rawJournal.ledgerRevision,
        eventSha256: typeof rawJournal.eventSha256 === 'string' ? rawJournal.eventSha256 : null,
        operationSha256: typeof rawJournal.operationSha256 === 'string' ? rawJournal.operationSha256 : null,
      })
    : null;
  return Object.freeze({
    operationId: operation.operationId,
    phase,
    sourceBarrier,
    sourceTombstone,
    sourcePreimageRetained,
    publicationState,
    publicationReasonCode: publicationState === 'uncertain'
      ? (ownerGoneCleanup ? 'T_LEDGER_OWNER_GONE_CLEANUP_SOURCE_UNCONFIRMED' : 'T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED')
      : null,
    sourceNodeId: typeof operation.sourceNodeId === 'string' ? operation.sourceNodeId : null,
    ...(ownerGoneCleanup ? { cleanupKind: operation.cleanupKind, mode: operation.mode,
      sourceNodeIds: Object.freeze([...operation.sourceNodeIds]), taskCount: operation.taskCount } : {}),
    ownerState: typeof entry.ownerState === 'string' && entry.ownerState ? entry.ownerState : null,
    ownerNodeId: typeof entry.ownerNodeId === 'string' && entry.ownerNodeId ? entry.ownerNodeId : null,
    destination,
    reason: typeof operation.reason === 'string' ? operation.reason : null,
    journal,
  });
}

function normalizeRecord(entry, handoffOperations = null, handoffChain = null) {
  const parsed = parseRequestId(entry.id);
  const scope = SCOPES.includes(entry.scope) ? entry.scope : 'global';
  const captureLog = Array.isArray(entry.captureLog) ? entry.captureLog : [];
  const firstCapture = captureLog.find(item => plain(item)) || null;
  const provenance = plain(entry.provenance) ? entry.provenance : null;
  const scopeKey = scope === 'global'
    ? null
    : (typeof entry.scopeKey === 'string' && entry.scopeKey ? entry.scopeKey : (typeof entry.threadId === 'string' && entry.threadId ? entry.threadId : null));
  const filedBy = typeof entry.filedBy === 'string' && entry.filedBy
    ? entry.filedBy
    : (firstCapture && typeof firstCapture.actor === 'string' && firstCapture.actor ? firstCapture.actor : null);
  const filedAt = typeof entry.filedAt === 'string' && entry.filedAt
    ? entry.filedAt
    : (firstCapture && typeof firstCapture.at === 'string' ? firstCapture.at : (provenance && typeof provenance.recordedAt === 'string' ? provenance.recordedAt : null));
  const normalized = {
    id: entry.id,
    kind: recordKindOf(entry),
    number: parsed ? parsed.rootNumber : null,
    parentId: typeof entry.parentId === 'string' && entry.parentId ? entry.parentId : parentIdOf(entry.id),
    scope,
    scopeKey,
    scopeLabel: typeof entry.scopeLabel === 'string' && entry.scopeLabel ? entry.scopeLabel : null,
    threadId: scope === 'thread' ? scopeKey : (typeof entry.threadId === 'string' ? entry.threadId : null),
    verbatim: typeof entry.verbatim === 'string' ? entry.verbatim : '',
    request: typeof entry.request === 'string' ? entry.request : null,
    status: typeof entry.status === 'string' ? entry.status : '',
    filedBy,
    filedAt,
    gates: Array.isArray(entry.gates) ? entry.gates : [],
    provenance,
    captureLog,
    decisions: Array.isArray(entry.decisions) ? entry.decisions : [],
    history: Array.isArray(entry.history) ? entry.history : [],
    removedAt: typeof entry.removedAt === 'string' ? entry.removedAt : null,
    removedBy: typeof entry.removedBy === 'string' ? entry.removedBy : null,
    // T/A/P-only fields. Always present (null/default for every R record and
    // for a T/A/P record that has not yet reached the state that fills them),
    // so a reader never has to branch on kind to know whether to look.
    recurrence: plain(entry.recurrence) ? entry.recurrence : null,
    completedAt: typeof entry.completedAt === 'string' ? entry.completedAt : null,
    completedBy: typeof entry.completedBy === 'string' ? entry.completedBy : null,
    // T-only: the id it replaces (set only on the new record) and the id that
    // replaced it (set only once superseded). Always present, default null,
    // same pattern as the other T/A/P-only fields above.
    supersedes: typeof entry.supersedes === 'string' && entry.supersedes ? entry.supersedes : null,
    supersededBy: typeof entry.supersededBy === 'string' && entry.supersededBy ? entry.supersededBy : null,
    ownerState: typeof entry.ownerState === 'string' && entry.ownerState ? entry.ownerState : null,
    ownerNodeId: typeof entry.ownerNodeId === 'string' && entry.ownerNodeId ? entry.ownerNodeId : null,
    handoff: handoffProjectionOf(entry, handoffOperations, handoffChain),
    answer: plain(entry.answer) ? entry.answer : null,
    purchase: plain(entry.purchase) ? entry.purchase : null,
    reset: plain(entry.reset) ? entry.reset : null,
    ...taskDifficultyFields(entry)
  };
  if (recordKindOf(entry) === 'T' && Object.prototype.hasOwnProperty.call(entry, 'waitingFor')) {
    normalized.waitingFor = readWaitingFor(entry.waitingFor);
  }
  return normalized;
}

function isReset(record) { return Boolean(record && plain(record.reset)); }

function isStoreRecordId(entry) {
  return plain(entry) && isRequestId(entry.id, { family: 'R' });
}

/**
 * Every record, normalised, in file order. Never creates the file.
 * @returns {{exists:boolean, path:string, revision:number|null, updatedAt:string|null, records:object[]}}
 */
/* kinds defaults to ['R'] and nothing else -- every existing caller of
   readAll (this module's own readLayer/collectStack, r-ledger.js, both CLIs,
   the agent gate, the app's session-start reader) calls it with no kinds
   override, so it keeps seeing exactly the R rows it always saw, unchanged.
   A caller that wants the whole ledger (T, A and P alongside R, each with
   its own kind set by normalizeRecord above) passes kinds explicitly. This
   is also how "the readers that feed agents at session start serve ONLY
   kind R" stays true without either reader touching this default. */
function readAll({ includeRemoved = false, includeProposed = true, kinds = ['R'], requireCompleteRules = false, ...rest } = {}) {
  const { ledgerFile, historyFile } = filesFor(rest);
  const document = readSharedDocument(ledgerFile);
  if (requireCompleteRules) {
    // Complete turn context must not lose a raw R row at the kind filter or
    // broaden an explicitly invalid scope during legacy normalization. Omitted
    // kind/scope still have their documented legacy meanings. Other readers
    // retain their existing tolerant behavior.
    for (const entry of document.data.requests) {
      const kind = idKind(entry.id);
      if (kind !== 'R' && entry.kind !== 'R' && !entry.id.startsWith('R')) continue;
      if (kind !== 'R' || (entry.kind !== undefined && entry.kind !== 'R')
          || (entry.scope !== undefined && !SCOPES.includes(entry.scope))) {
        fail('R_LEDGER_SHAPE_INVALID', 'A rule has an invalid identity, kind or scope.');
      }
    }
  }
  let handoffChain = null;
  if (kinds.includes('T') && Array.isArray(document.data.handoffOperations)) {
    try {
      handoffChain = readChain(historyFile);
    } catch (error) {
      handoffChain = { broken: { line: 0, reason: error?.message || 'history unavailable' }, events: [] };
    }
  }
  const records = document.data.requests
    .filter(entry => plain(entry) && typeof entry.id === 'string' && kinds.includes(recordKindOf(entry)))
    .map(entry => normalizeRecord(entry, document.data.handoffOperations, handoffChain))
    .filter(record => !isReset(record))
    .filter(record => (includeRemoved || !HIDDEN_STATUSES.has(record.status)) && (includeProposed || record.status !== 'proposed'));
  return Object.freeze({
    exists: document.exists,
    path: ledgerFile,
    revision: Number.isInteger(document.data.revision) ? document.data.revision : null,
    updatedAt: typeof document.data.updatedAt === 'string' ? document.data.updatedAt : null,
    records: Object.freeze(records.map(record => Object.freeze(record)))
  });
}

function layerEntry(record) {
  return Object.freeze({
    id: record.id,
    number: record.number,
    parentId: record.parentId,
    stamp: record.filedAt,
    filedBy: record.filedBy,
    words: record.verbatim,
    status: record.status,
    line: null
  });
}

function inLayer(record, scope, key) {
  return record.scope === scope && (scope === 'global' || record.scopeKey === key);
}

/**
 * One tier: the records filed for exactly this scope and key -- active rows
 * only, unless the caller asks for the waiting ones by name. A plain read
 * never hands out a proposal the person has not approved: an older app shell
 * reads a layer for an agent's boot block without naming any option. The
 * agent gate's duplicate check passes includeProposed:true so the same words
 * offered twice while the first waits do not file a second waiting row (each
 * entry carries its status). Declined, removed and done rows never ride.
 */
function readLayer(scope, key, { includeProposed = false, ...rest } = {}) {
  assertScope(scope);
  const layerKey = assertKey(scope, key);
  const all = readAll({ includeRemoved: false, includeProposed: true, ...rest });
  const entries = all.records
    .filter(record => inLayer(record, scope, layerKey))
    .filter(record => ACTIVE_STATUSES.has(record.status) || (includeProposed && record.status === 'proposed'))
    .map(layerEntry);
  return Object.freeze({ scope, key: layerKey, path: all.path, exists: all.exists, entries: Object.freeze(entries), warnings: Object.freeze([]), nextIdMark: null });
}

/* Reading order for a layer: each entry followed by its refinements, depth
   first, every row carrying its depth (0 for a root). File order is kept among
   siblings. A child whose parent is gone lists at the top with its parentId
   still set, so nothing standing is ever hidden. */
function nestEntries(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(entry => !isReset(entry));
  const byId = new Set(list.map(entry => entry.id));
  const children = new Map();
  const roots = [];
  for (const entry of list) {
    if (entry.parentId && byId.has(entry.parentId)) {
      if (!children.has(entry.parentId)) children.set(entry.parentId, []);
      children.get(entry.parentId).push(entry);
    } else {
      roots.push(entry);
    }
  }
  const out = [];
  const walk = (entry, depth) => {
    out.push(Object.freeze({ ...entry, depth }));
    for (const child of children.get(entry.id) || []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return Object.freeze(out);
}

/* Which records apply to one agent: global always; a session record for its
   session; a tree record for any anchor above it; a thread record for its own
   thread. Status is not judged here. A record with no scope reads as global. */
function selectForContext(records, { sessionId = null, treeAnchors = [], threadId = null } = {}) {
  const anchors = new Set((Array.isArray(treeAnchors) ? treeAnchors : []).filter(value => typeof value === 'string' && value));
  const session = typeof sessionId === 'string' && sessionId ? sessionId : null;
  const thread = typeof threadId === 'string' && threadId ? threadId : null;
  return (Array.isArray(records) ? records : []).filter(record => {
    if (!plain(record)) return false;
    const scope = SCOPES.includes(record.scope) ? record.scope : 'global';
    const key = typeof record.scopeKey === 'string' && record.scopeKey ? record.scopeKey : (typeof record.threadId === 'string' && record.threadId ? record.threadId : null);
    if (scope === 'global') return true;
    if (scope === 'session') return session !== null && key === session;
    if (scope === 'tree') return key !== null && anchors.has(key);
    return thread !== null && key === thread;
  });
}

/**
 * The stack an agent boots with, in reading order: global, then the session,
 * then every ancestor tree layer from the top of the chain down, then the
 * agent's own thread. Active rows only -- never proposed, declined, removed or
 * done. Every layer is listed even when empty, so an agent knows what it read.
 */
function collectStack({ sessionId = null, treeAnchors = [], threadId = null } = {}, options = {}) {
  const all = readAll({ includeRemoved: false, includeProposed: false, ...options });
  const active = all.records.filter(record => ACTIVE_STATUSES.has(record.status));
  const layers = [['global', null]];
  if (sessionId) layers.push(['session', sessionId]);
  for (const anchor of Array.isArray(treeAnchors) ? treeAnchors : []) if (anchor) layers.push(['tree', anchor]);
  if (threadId) layers.push(['thread', threadId]);
  return Object.freeze(layers.map(([scope, key]) => Object.freeze({
    scope,
    key,
    path: all.path,
    exists: all.exists,
    appliesTo: SCOPE_WORD[scope],
    entries: nestEntries(active.filter(record => inLayer(record, scope, key)).map(layerEntry)),
    warnings: Object.freeze([])
  })));
}

/** Where one id stands: { scope, id, key }. Removed and declined records still answer. */
function resetRecordById(id, options = {}) {
  const { ledgerFile } = filesFor(options);
  const entry = readSharedDocument(ledgerFile).data.requests.find(candidate => plain(candidate) && candidate.id === id);
  return Boolean(entry && isReset(normalizeRecord(entry)));
}

function findEntry(id, options = {}) {
  assertId(id);
  const all = readAll({ includeRemoved: true, includeProposed: true, ...options });
  const record = all.records.find(candidate => candidate.id === id);
  if (!record && resetRecordById(id, options)) fail('R_LEDGER_ENTRY_RESET', `${id} was cleared from this Ledger category.`);
  if (!record) fail('R_LEDGER_ENTRY_UNKNOWN', `${id} is not in the ledger (deleted, or never filed).`);
  return Object.freeze({ scope: record.scope, id: record.id, key: record.scopeKey });
}

/* NUMBERS COME FROM THE FILE AND THE CHAIN TOGETHER. A record spliced out of
   the JSON by hand is gone from the file but not from the history, and its
   number must never be handed to a new request. The chain's events name every
   id ever written, so the highest number is taken over both. A broken chain
   still counts the events before the break. */
function chainedIds(chain) {
  const ids = new Set();
  for (const event of chain.events) if (isRequestId(event.requestId, { family: 'R' })) ids.add(event.requestId);
  return ids;
}

function highestRootNumber(records, chain) {
  let highest = records.reduce((max, record) => Math.max(max, record.number || 0), 0);
  for (const id of chainedIds(chain)) {
    const parsed = parseRequestId(id);
    if (parsed && parsed.rootNumber > highest) highest = parsed.rootNumber;
  }
  return highest;
}

function nextRootNumber(options = {}) {
  const { ledgerFile, historyFile } = filesFor(options);
  // reset rows are product-hidden but still reserve their historical IDs.
  const document = readDocument(ledgerFile);
  const records = document.data.requests
    .filter(entry => plain(entry) && typeof entry.id === 'string' && idKind(entry.id) === 'R')
    .map(normalizeRecord);
  return highestRootNumber(records, readTransactionHistory(historyFile, document, options)) + 1;
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------
//
// ONE LOCK FILE FOR EVERY WRITER OF THE LEDGER: `<ledger>.lock`, the file
// tools/owner-capture.js acquireLedgerLock takes through
// src/lib/agent-digest/lock.js -- and ledger-archive and
// the migrations through it. That module's authoritative mutex is a
// nonce-claim directory beside the file, but every holder also publishes this
// fixed JSON status file with an exclusive create, refuses to start while the
// file names a live process, and never treats an unreadable record as
// absence. This store speaks the compatibility half of that protocol: it
// publishes a `{ pid, startedAt, nonce }` record, the legacy shape the digest
// lock's classifyFixedHolder reads, exactly as it publishes its own (a
// complete staged file hard-linked into place, so the public path never has a
// zero-byte interval). So:
//   - a CLI holder is visible to the store: the link fails EEXIST, the record
//     names a live pid, the store waits out its retry window and refuses with
//     R_LEDGER_LOCKED;
//   - a store holder is visible to the CLI: its own publish fails EEXIST, its
//     compatibility inspection finds a live pid whose process started before
//     `startedAt`, and it refuses with OWNER_CAPTURE_LEDGER_LOCKED.
// THE STALENESS RULE IS THE DIGEST LOCK'S. A holder is stale only when its
// process is proven absent (ESRCH). EPERM is alive. A record that cannot be
// read is uncertainty, never absence, and is waited out. Age is never a
// reason. The one part left to the CLI is the recycled-pid check: the digest
// lock proves a pid's generation with a process-start probe (powershell.exe
// on Windows, 5 s cold, on whichever thread asks) and this store does not pay
// for that on the person's /Request; it never reclaims a live pid at all, so
// it is strictly more conservative than the CLI, which does reclaim a store
// record whose pid was recycled, by the `startedAt` rule above. A stale record
// is reclaimed by rename to a nonce-unique quarantine path and a byte check,
// never by check-then-unlink, so a replacement a contender published between
// the read and the reclaim is left standing.

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && error.code === 'ESRCH'); }
}

/* { state: 'absent' | 'unreadable' | 'held', holder, contents } */
function readLockHolder(lockFile) {
  let contents;
  try { contents = fs.readFileSync(lockFile, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'absent', holder: null, contents: null };
    throw error;
  }
  let holder;
  try { holder = JSON.parse(contents); } catch { return { state: 'unreadable', holder: null, contents }; }
  if (!plain(holder) || !Number.isSafeInteger(holder.pid) || holder.pid <= 0) return { state: 'unreadable', holder: null, contents };
  return { state: 'held', holder, contents };
}

function unlinkIfPresent(file) {
  try { fs.unlinkSync(file); }
  catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
}

/* Publish a complete record at the fixed path without ever exposing a partial
   one: stage it, fsync, then link. EEXIST means another holder. A volume that
   refuses hard links falls back to an exclusive create, which still excludes;
   the digest lock's readers poll a short grace window over a zero-byte file. */
function publishLockRecord(lockFile, contents, nonce) {
  const staged = `${lockFile}.publishing.${nonce}.${crypto.randomUUID()}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(staged, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(staged, lockFile);
    } catch (error) {
      if (error && error.code === 'EEXIST') throw error;
      fs.writeFileSync(lockFile, contents, { flag: 'wx', mode: 0o600 });
    }
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { /* the primary error is authoritative */ } }
    unlinkIfPresent(staged);
  }
}

/* The record was classified stale from `observed`. Move it aside, confirm the
   moved bytes are the bytes that were classified and that its holder is still
   absent, then remove it. Anything else restores the file and leaves it. */
function reclaimStaleLock(lockFile, observed, nonce) {
  const again = readLockHolder(lockFile);
  if (again.state === 'absent') return;
  if (again.state !== 'held' || again.contents !== observed.contents) return;
  const quarantine = `${lockFile}.stale.${nonce}.${crypto.randomUUID()}`;
  try { fs.renameSync(lockFile, quarantine); }
  catch (error) { if (error && error.code === 'ENOENT') return; throw error; }
  const moved = readLockHolder(quarantine);
  if (moved.state === 'held' && moved.contents === observed.contents && !pidAlive(moved.holder.pid)) {
    try { unlinkIfPresent(quarantine); } catch { /* verified evidence; leaving it costs nothing */ }
    return;
  }
  try { fs.renameSync(quarantine, lockFile); } catch { /* a new holder published meanwhile; its record stands */ }
}

function releaseLock(lockFile, contents) {
  const observed = readLockHolder(lockFile);
  if (observed.state !== 'held' || observed.contents !== contents) return;
  try { unlinkIfPresent(lockFile); } catch { /* released already */ }
}

function acquireLock(ledgerFile) {
  const lockFile = `${ledgerFile}${LOCK_SUFFIX}`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const nonce = crypto.randomUUID();
  const contents = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce, writer: LOCK_WRITER });
  for (let attempt = 0; attempt <= LOCK_WAIT_ATTEMPTS; attempt += 1) {
    try {
      publishLockRecord(lockFile, contents, nonce);
      return { file: lockFile, release: () => releaseLock(lockFile, contents) };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    const observed = readLockHolder(lockFile);
    if (observed.state === 'absent') continue;
    if (observed.state === 'held' && !pidAlive(observed.holder.pid)) {
      reclaimStaleLock(lockFile, observed, nonce);
      continue;
    }
    if (attempt < LOCK_WAIT_ATTEMPTS) waitSync(LOCK_WAIT_MS);
  }
  fail('R_LEDGER_LOCKED', 'Another write to the ledger is in progress. Wait a moment and try again.');
  return null;
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

function renameWithRetry(temporary, target) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    try { fs.renameSync(temporary, target); return; }
    catch (error) {
      if (!TRANSIENT_WRITE_CODES.has(error && error.code) || attempt + 1 >= WRITE_ATTEMPTS) throw error;
      waitSync(25 * (attempt + 1));
    }
  }
}

/* Check the text -> temp file (wx, 0600) -> fsync -> read the bytes back and
   compare them with the checked text byte for byte -> .bak of what was there
   -> one rename. The original changes at the rename only. */
function atomicWrite(ledgerFile, previousRaw, nextData) {
  // Whatever happens below, the next reader parses the file as it then is,
  // and only a write that reached the file leaves a document for the next one.
  forgetSharedLedgerDocument(ledgerFile);
  writtenLedgerDocuments.delete(ledgerFile);
  try { keepWrittenLedgerDocument(ledgerFile, writeLedgerFile(ledgerFile, previousRaw, nextData)); }
  finally { forgetSharedLedgerDocument(ledgerFile); }
}

function writeLedgerFile(ledgerFile, previousRaw, nextData) {
  const serialized = `${JSON.stringify(nextData, null, 2)}\n`;
  const data = JSON.parse(serialized);
  validateShape(data, ledgerFile);
  const bytes = Buffer.from(serialized, 'utf8');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const temporary = `${ledgerFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    // The file must hold exactly the text checked above: nothing short, nothing changed.
    if (!bytes.equals(fs.readFileSync(temporary))) {
      fail('R_LEDGER_WRITE_UNCONFIRMED', 'The Ledger change did not read back exactly as it was written, so it was not saved. Everything already on file is kept. Try again.');
    }
    fs.writeFileSync(`${ledgerFile}.bak`, typeof previousRaw === 'string' ? previousRaw : '', 'utf8');
    renameWithRetry(temporary, ledgerFile);
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { /* closed */ } }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
  return { raw: serialized, data };
}

/* True only when the ledger on disk is still exactly what `document` read:
   absent if it was absent, the same text if not. A read that fails is not
   proof, so it answers false. */
function documentUnchanged(ledgerFile, document) {
  try {
    return document.exists ? fs.readFileSync(ledgerFile, 'utf8') === document.raw : !fs.existsSync(ledgerFile);
  } catch {
    return false;
  }
}

function finalize(data, nextRequests, now, outcome = null) {
  const next = {
    ...data,
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isInteger(data.revision) ? data.revision + 1 : 1,
    updatedAt: todayString(now),
    statusVocabulary: { ...STATUS_VOCABULARY, ...(plain(data.statusVocabulary) ? data.statusVocabulary : {}) },
    requests: nextRequests
  };
  if (outcome && Object.prototype.hasOwnProperty.call(outcome, 'handoffOperations')) {
    next.handoffOperations = outcome.handoffOperations;
  }
  return next;
}

// ---------------------------------------------------------------------------
// The history chain
// ---------------------------------------------------------------------------

/* THE CORE THE CHAIN SPEAKS FOR: identity, placement, status, the words, who
   filed, whose word it is (provenance class and recorder) and how many
   decisions the person has taken on it. Gates and their evidence stay out --
   older ledgers carry gate evidence written without a chain event. Reading
   that legacy evidence does not change the request. */
function coreOf(entry) {
  const provenance = plain(entry.provenance) ? entry.provenance : {};
  const core = {
    id: entry.id,
    parentId: typeof entry.parentId === 'string' && entry.parentId ? entry.parentId : parentIdOf(entry.id),
    scope: SCOPES.includes(entry.scope) ? entry.scope : 'global',
    scopeKey: typeof entry.scopeKey === 'string' && entry.scopeKey ? entry.scopeKey : null,
    status: typeof entry.status === 'string' ? entry.status : '',
    verbatim: typeof entry.verbatim === 'string' ? entry.verbatim : '',
    filedBy: typeof entry.filedBy === 'string' && entry.filedBy ? entry.filedBy : null,
    provenanceClass: typeof provenance.class === 'string' ? provenance.class : null,
    provenanceRecordedBy: typeof provenance.recordedBy === 'string' ? provenance.recordedBy : null,
    decisions: Array.isArray(entry.decisions) ? entry.decisions.length : 0,
    removedAt: typeof entry.removedAt === 'string' ? entry.removedAt : null,
    ...(plain(entry.reset) ? { reset: entry.reset } : {})
  };
  if (recordKindOf(entry) === 'T' && Object.prototype.hasOwnProperty.call(entry, 'waitingFor')) {
    core.waitingFor = readWaitingFor(entry.waitingFor);
  }
  Object.assign(core, taskDifficultyFields(entry));
  if (recordKindOf(entry) === 'T') {
    const reviews = Array.isArray(entry.decisions) ? entry.decisions.filter(row => plain(row) && row.decision === 'review') : [];
    if (reviews.length) core.taskReviews = reviews;
    if (typeof entry.ownerState === 'string' && entry.ownerState) core.ownerState = entry.ownerState;
    if (typeof entry.ownerNodeId === 'string' && entry.ownerNodeId) core.ownerNodeId = entry.ownerNodeId;
  }
  return core;
}

function coreSha256(entry) {
  return sha256(canonical(coreOf(entry)));
}

/* Every line of the chain, checked as it is read. A break is reported with its
   line, never thrown: verifyHistory is a read and a broken file is an answer. */
function readChain(historyFile) {
  let raw;
  try { raw = fs.readFileSync(historyFile, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, events: [], head: GENESIS_SHA256, broken: null };
    throw error;
  }
  const chain = parseChain(raw);
  if (chain.broken) return chain;
  const sources = new Map();
  for (const event of chain.events) {
    if (event.kind !== 'recover') continue;
    const proof = event.recoveredFrom;
    if (!plain(proof) || !/^[a-f0-9]{64}$/.test(proof.fileSha256 || '') || !/^[a-f0-9]{64}$/.test(proof.eventSha256 || '')) {
      return { ...chain, broken: { line: event.seq, reason: 'invalid recovery evidence' } };
    }
    let source = sources.get(proof.fileSha256);
    if (!source) {
      let bytes;
      try { bytes = fs.readFileSync(recoveredHistoryFile(historyFile, proof.fileSha256), 'utf8'); }
      catch { return { ...chain, broken: { line: event.seq, reason: 'recovery evidence unavailable' } }; }
      source = parseChain(bytes);
      if (sha256(bytes) !== proof.fileSha256 || source.broken) {
        return { ...chain, broken: { line: event.seq, reason: 'recovery evidence changed' } };
      }
      sources.set(proof.fileSha256, source);
    }
    const original = source.events.find(candidate => candidate.eventSha256 === proof.eventSha256);
    if (!original || original.kind === 'drift-observed' || original.kind === 'recover'
        || original.requestId !== event.requestId || original.coreSha256 !== event.coreSha256) {
      return { ...chain, broken: { line: event.seq, reason: 'recovery evidence mismatch' } };
    }
  }
  return chain;
}

function parseChain(raw) {
  const lines = raw.split('\n').filter(line => line.trim().length > 0);
  const events = [];
  let previous = GENESIS_SHA256;
  if (lines.length > MAX_EVENTS) return { exists: true, events, head: previous, broken: { line: MAX_EVENTS + 1, reason: 'too many events' } };
  for (let index = 0; index < lines.length; index += 1) {
    const where = index + 1;
    let event;
    // A byte-order mark an editor put at the head of a line is not a change to the event.
    const line = lines[index].startsWith(BOM) ? lines[index].slice(BOM.length) : lines[index];
    try { event = JSON.parse(line); } catch { return { exists: true, events, head: previous, broken: { line: where, reason: 'not JSON' } }; }
    if (!plain(event) || event.seq !== where || event.prevSha256 !== previous
        || typeof event.eventSha256 !== 'string' || event.eventSha256 !== chainHash(previous, event)
        || !EVENT_KINDS.includes(event.kind) || typeof event.requestId !== 'string') {
      return { exists: true, events, head: previous, broken: { line: where, reason: 'hash mismatch' } };
    }
    events.push(event);
    previous = event.eventSha256;
  }
  return { exists: true, events, head: previous, broken: null };
}

function recoveredHistoryFile(historyFile, digest) {
  return path.join(path.dirname(historyFile), 'owner-request-history', `${digest}.jsonl`);
}

// Basic writes need the journal's allocation and append position, not a claim
// that its historical contents were authenticated. Keep one compact projection,
// invalidated by every external file change or unconfirmed append. A cold read
// still scans the journal to retain IDs missing from the current document.
// Reconciliation must retain known identities even when a changed file or an
// unconfirmed write makes the cached projection unusable.
const operationalHistories = new Map();

function historyStamp(historyFile, descriptor = null) {
  let stat;
  try { stat = descriptor === null ? fs.statSync(historyFile, { bigint: true }) : fs.fstatSync(descriptor, { bigint: true }); }
  catch (error) { if (descriptor === null && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile()) fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history is not a regular file.');
  const size = Number(stat.size);
  return { size, key: [stat.dev, stat.ino, stat.size, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].map(String).join(':') };
}

function sameHistoryStamp(left, right) {
  return left === null ? right === null : right !== null && left.key === right.key;
}

function operationalEventSummary(event) {
  const summary = {
    requestId: event.requestId,
    kind: event.kind,
    seq: event.seq,
    eventSha256: event.eventSha256,
    coreSha256: event.coreSha256
  };
  /* Basic history reads intentionally keep a compact cache for ordinary
     records. Handoff replay is different: its phase and operation payload are
     part of the receipt identity, so retaining only the reference would make
     a valid prepare/commit replay look like a missing journal. Preserve those
     fields only for the handoff event kind; the full verified reader remains
     the authority for every other history claim. */
  if (event.kind === HANDOFF_EVENT_KIND) {
    if (typeof event.statusAfter === 'string') summary.statusAfter = event.statusAfter;
    if (Number.isSafeInteger(event.ledgerRevision)) summary.ledgerRevision = event.ledgerRevision;
    if (plain(event.operation)) summary.operation = event.operation;
  }
  return summary;
}

function operationalEvents(events) {
  const latest = new Map();
  for (const event of events) {
    if (event.kind === 'drift-observed' && latest.has(event.requestId)) continue;
    latest.set(event.requestId, operationalEventSummary(event));
  }
  return [...latest.values()];
}

function isHistoryRequestId(id) {
  return idKind(id) !== null || HANDOFF_HISTORY_ID.test(id);
}

function currentHistoryReferences(data) {
  const references = [];
  for (const entry of data.requests) {
    if (!plain(entry) || !idKind(entry.id)) continue;
    // Authenticated recovery preserves source rows, then appends a local one.
    // Older source sequence numbers do not describe the current local append.
    const row = Array.isArray(entry.history) ? entry.history.at(-1) : null;
    if (typeof row?.eventSha256 === 'string' && row.eventSha256) {
      references.push({ requestId: entry.id, seq: row.seq, eventSha256: row.eventSha256 });
    }
  }
  return references;
}

function referenceEvents(events, references) {
  const wanted = new Set(references.map(row => row.seq));
  return new Map(events.filter(event => wanted.has(event.seq)).map(event => [event.seq, {
    requestId: event.requestId, seq: event.seq, eventSha256: event.eventSha256
  }]));
}

function hasCurrentReferences(chain, references) {
  return references.every(row => {
    const event = chain.references.get(row.seq);
    return Number.isSafeInteger(row.seq) && row.seq > 0 && event?.requestId === row.requestId
      && event.eventSha256 === row.eventSha256;
  });
}

function requireKnownReservations(historyFile, events) {
  const known = operationalHistories.get(historyFile);
  if (!known) return;
  const present = new Set(events.map(event => event.requestId));
  if ([...known.reservedIds].some(id => !present.has(id))) {
    fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history lost a known record identity. Restore it before filing another record.');
  }
}

function reconcileOperationalHistory(historyFile, chain, adopting = false) {
  const known = operationalHistories.get(historyFile)?.chain;
  if (known && (chain.sequence < known.sequence || chain.priorHead !== known.head)) {
    fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history lost or replaced a known append. Restore it before filing another record.');
  }
  // The person's adoption may itself chain the identity a failed append left
  // out; transact() holds it to the same reservations once its events exist.
  if (!adopting) requireKnownReservations(historyFile, chain.events);
}

function rememberOperationalHistory(historyFile, chain) {
  const known = operationalHistories.get(historyFile) || { reservedIds: new Set() };
  for (const event of chain.events) known.reservedIds.add(event.requestId);
  known.chain = { ...chain, events: operationalEvents(chain.events), priorHead: chain.head, checked: false };
  known.reusable = true;
  operationalHistories.set(historyFile, known);
}

function readOperationalHistory(historyFile, references) {
  const stamp = historyStamp(historyFile);
  const known = operationalHistories.get(historyFile);
  if (known?.reusable && sameHistoryStamp(known.chain.stamp, stamp) && hasCurrentReferences(known.chain, references)) return known.chain;
  const raw = stamp === null ? '' : fs.readFileSync(historyFile, 'utf8');
  if (!sameHistoryStamp(stamp, historyStamp(historyFile))) fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history changed while it was being read. Try again.');
  const rows = raw.split('\n').filter(line => line.trim().length > 0);
  const latest = new Map(), foundReferences = new Map();
  const wanted = new Set(references.map(row => row.seq));
  let previous = GENESIS_SHA256, priorHead = GENESIS_SHA256;
  const broken = (line, reason) => ({ exists: stamp !== null, events: [], head: previous, broken: { line, reason }, stamp });
  if (rows.length > MAX_EVENTS) return broken(MAX_EVENTS + 1, 'too many events');
  if (rows.length && !raw.endsWith('\n')) return broken(rows.length, 'the last append is incomplete');
  for (let index = 0; index < rows.length; index += 1) {
    let event;
    const line = rows[index].startsWith(BOM) ? rows[index].slice(BOM.length) : rows[index];
    try { event = JSON.parse(line); } catch { return broken(index + 1, 'not JSON'); }
    if (!plain(event) || event.seq !== index + 1 || event.prevSha256 !== previous
        || !/^[a-f0-9]{64}$/.test(event.eventSha256 || '') || !/^[a-f0-9]{64}$/.test(event.coreSha256 || '')
        || !EVENT_KINDS.includes(event.kind) || !isHistoryRequestId(event.requestId)) return broken(index + 1, 'invalid append position or record identity');
    if (event.kind !== 'drift-observed' || !latest.has(event.requestId)) {
      latest.set(event.requestId, operationalEventSummary(event));
    }
    if (wanted.has(event.seq)) foundReferences.set(event.seq, {
      requestId: event.requestId, seq: event.seq, eventSha256: event.eventSha256
    });
    if (event.seq === known?.chain.sequence) priorHead = event.eventSha256;
    previous = event.eventSha256;
  }
  return { exists: stamp !== null, events: [...latest.values()], head: previous,
    sequence: rows.length, broken: null, stamp, checked: false, priorHead, references: foundReferences };
}

function readTransactionHistory(historyFile, document, options, forceVerification = false, adopting = false, handoffHistory = false) {
  // Adoption always forces the same real chainHash recompute readChain gives
  // forceVerification's other callers -- a Basic write's fast path
  // (readOperationalHistory) only checks declared hash shape and position,
  // never recomputes one, so a JSON-valid line with a stale eventSha256 would
  // pass it. Unlike forceVerification, adopting does NOT skip the
  // reconcileOperationalHistory call below: that known-head/reservations
  // check still runs, against this cold chain, exactly as for any write.
  const policy = (forceVerification || adopting) ? null : require('./runtime-policy').runtimePolicy(options);
  const references = currentHistoryReferences(document.data);
  let chain;
  if (forceVerification || adopting || handoffHistory || policy.verifyHistory || !policy.configurationAvailable) {
    const stamp = historyStamp(historyFile);
    chain = { ...readChain(historyFile), stamp };
    if (!sameHistoryStamp(stamp, historyStamp(historyFile))) fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history changed while it was being checked. Try again.');
    const knownSequence = operationalHistories.get(historyFile)?.chain.sequence || 0;
    chain.sequence = chain.events.length;
    chain.priorHead = knownSequence ? chain.events[knownSequence - 1]?.eventSha256 : GENESIS_SHA256;
    chain.references = referenceEvents(chain.events, references);
  } else chain = readOperationalHistory(historyFile, references);
  if (chain.broken) fail('R_LEDGER_CHAIN_BROKEN', `The history at line ${chain.broken.line} cannot be used for a new append (${chain.broken.reason}). Check it before writing again.`);
  // Checking a current append's declared identity is separate from optional
  // historical content verification. A matching count cannot settle custody.
  // Explicit authenticated recovery has its own source-reference protocol.
  if (!forceVerification) {
    reconcileOperationalHistory(historyFile, chain, adopting);
    // Only adoptUnconfirmedHistory passes `adopting`: the person naming these
    // references on the chain is the one write that may proceed past them.
    if (!adopting && !hasCurrentReferences(chain, references)) {
      fail('R_LEDGER_CHAIN_APPEND_UNCONFIRMED', 'A saved Ledger change has no confirmed history append. Check or recover its history before writing again. If that history is gone, only the person can adopt the Ledger as it stands; ask them. This write was not saved; everything already on file is kept.');
    }
    if (!adopting) rememberOperationalHistory(historyFile, chain);
  }
  return chain;
}

function appendChainLine(historyFile, event, expectedStamp) {
  const line = `${JSON.stringify(event)}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_EVENT_BYTES) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'a history event is too large to record.');
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    let descriptor = null, writeAttempted = false, cleanupFailed = false;
    try {
      descriptor = fs.openSync(historyFile, 'a', 0o600);
      const before = historyStamp(historyFile, descriptor);
      if (expectedStamp === null ? before.size !== 0 : !sameHistoryStamp(expectedStamp, before)) {
        fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The history changed before this append could begin.');
      }
      writeAttempted = true;
      const written = fs.writeSync(descriptor, line, null, 'utf8');
      if (written !== bytes) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The history append was only partly written.');
      fs.fsyncSync(descriptor);
      const after = historyStamp(historyFile, descriptor);
      if (after.size !== before.size + bytes) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The history append size could not be confirmed.');
      fs.closeSync(descriptor); descriptor = null;
      if (!sameHistoryStamp(after, historyStamp(historyFile))) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The appended history file was replaced before confirmation.');
      return after;
    } catch (error) {
      lastError = error;
      if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { cleanupFailed = true; } }
      // Once writeSync was entered, a rejection may still have appended bytes.
      // Retrying that same line would manufacture another operation.
      if (writeAttempted || cleanupFailed || !TRANSIENT_WRITE_CODES.has(error && error.code) || attempt + 1 >= WRITE_ATTEMPTS) break;
      waitSync(25 * (attempt + 1));
    }
  }
  const failure = new OwnerRequestStoreError('R_LEDGER_CHAIN_APPEND_FAILED',
    'The request was saved but its history append could not be confirmed. Check or recover its history before relying on it.');
  failure.cause = lastError;
  throw failure;
}

/* The chain's last word on every record: the newest event per id that is not
   an observation. */
function lastCoreByRequest(events) {
  const latest = new Map();
  for (const event of events) if (event.kind !== 'drift-observed') latest.set(event.requestId, event);
  return latest;
}

/* One transaction: lock, read, mutate, finalize, write, append every event.
   `mutate(document, at, chain)` returns { requests, events } where each event
   names the record it is about and the record's history row that must carry
   the hash.

   A RECORD THAT DIFFERS FROM ITS HISTORY IS RECORDED, NOT REFUSED. Before the
   mutation's own event is chained, every record it touches is compared, as it
   was on disk, with the chain's last word on it. When they differ the person
   is never locked out of their own ledger: a 'drift-observed' event goes on
   the chain first, carrying the hash the chain expected and the hash the file
   held, and then the mutation's event as usual. The write re-baselines the
   record honestly -- the observation is on the record for ever. */
function transact(options, now, mutate, forceVerification = false, adopting = false, handoffHistory = false) {
  const { ledgerFile, historyFile } = filesFor(options);
  const clock = clockOf(now);
  const lock = acquireLock(ledgerFile);
  try {
    const document = readDocumentForWrite(ledgerFile);
    const chain = readTransactionHistory(historyFile, document, options, forceVerification, adopting, handoffHistory);
    const expected = lastCoreByRequest(chain.events);
    const onDisk = new Map();
    // Any kind this store manages, not R alone: a T/A/P write deserves the
    // same "your hand change is observed before it's overwritten" protection
    // an R write already has. Widened here only -- everything else about the
    // drift-observed mechanics below (chainEvent, coreSha256, the event
    // shape) is unchanged.
    for (const entry of document.data.requests) if (plain(entry) && typeof entry.id === 'string' && idKind(entry.id)) onDisk.set(entry.id, normalizeRecord(entry));
    const at = clock().toISOString();
    const outcome = mutate(document, at, chain);
    const recordEvents = Array.isArray(outcome.events) ? outcome.events : [];
    const operationEvents = Array.isArray(outcome.operationEvents) ? outcome.operationEvents : [];
    if (recordEvents.length === 0 && operationEvents.length === 0) {
      return {
        ledgerFile, historyFile, revision: document.data.revision, at, outcome,
        publication: Object.freeze({ durable: true, revision: document.data.revision,
          history: Object.freeze({ sequence: chain.sequence ?? chain.events.length, head: chain.head }) })
      };
    }
    const nextData = finalize(document.data, outcome.requests, clock(), outcome);
    let previous = chain.head;
    let seq = chain.sequence ?? chain.events.length;
    const lines = [];
    const chainEvent = (fields) => {
      seq += 1;
      const event = { schemaVersion: SCHEMA_VERSION, eventId: crypto.randomUUID(), seq, at, ...fields, ledgerRevision: nextData.revision, prevSha256: previous };
      event.eventSha256 = chainHash(previous, event);
      previous = event.eventSha256;
      lines.push(event);
      return event;
    };
    const observed = new Set();
    const taskBindingsByOperation = new Map();
    for (const pending of recordEvents) {
      const id = pending.record.id;
      const before = onDisk.get(id);
      const last = expected.get(id);
      if (before && last && !observed.has(id)) {
        const observedSha256 = coreSha256(before);
        if (observedSha256 !== last.coreSha256) {
          observed.add(id);
          chainEvent({
            actor: pending.actor,
            kind: 'drift-observed',
            requestId: id,
            scope: before.scope,
            scopeKey: before.scopeKey,
            statusAfter: before.status,
            coreSha256: observedSha256,
            expectedSha256: last.coreSha256,
            observedSha256
          });
        }
      }
      const event = chainEvent({
        actor: pending.actor,
        kind: pending.kind,
        requestId: id,
        scope: pending.record.scope,
        scopeKey: pending.record.scopeKey,
        statusAfter: pending.record.status,
        coreSha256: coreSha256(pending.record),
        ...(pending.recoveredFrom ? { recoveredFrom: pending.recoveredFrom } : {}),
        ...(pending.unconfirmed ? { unconfirmed: pending.unconfirmed } : {}),
        ...(pending.operation ? { operation: pending.operation } : {})
      });
      pending.historyRow.seq = event.seq;
      pending.historyRow.eventSha256 = event.eventSha256;
      if (pending.kind === HANDOFF_EVENT_KIND && pending.operation?.operationId) {
        const bindings = taskBindingsByOperation.get(pending.operation.operationId) || [];
        bindings.push({ taskId: id, seq: event.seq, eventSha256: event.eventSha256,
          coreSha256: event.coreSha256, statusAfter: event.statusAfter });
        taskBindingsByOperation.set(pending.operation.operationId, bindings);
      }
    }
    for (const pending of operationEvents) {
      if (!plain(pending) || typeof pending.operationId !== 'string' || !HANDOFF_OPERATION_ID.test(pending.operationId)) {
        fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The handoff operation could not be journalled with a stable identity.');
      }
      const bindings = taskBindingsByOperation.get(pending.operationId);
      let pendingOperation = pending;
      if (bindings || (pending.phase !== 'prepared' && !Array.isArray(pending.taskBindings)
        && Array.isArray(pending.taskIds) && pending.taskIds.length === 0)) {
        pendingOperation = { ...pending, taskBindings: [...(bindings || [])].sort((left, right) => left.taskId.localeCompare(right.taskId)) };
        const bindingOperationIndex = Array.isArray(nextData.handoffOperations)
          ? nextData.handoffOperations.findIndex(operation => operation.operationId === pending.operationId)
          : -1;
        if (bindingOperationIndex >= 0) nextData.handoffOperations[bindingOperationIndex] = pendingOperation;
        if (outcome.operation?.operationId === pending.operationId) outcome.operation = pendingOperation;
      }
      const operationPayload = operationEvent(pendingOperation);
      const event = chainEvent({
        actor: pendingOperation.actor,
        kind: HANDOFF_EVENT_KIND,
        requestId: `handoff:${pendingOperation.operationId}`,
        scope: 'global',
        scopeKey: null,
        statusAfter: pendingOperation.phase,
        coreSha256: sha256(canonical(operationPayload)),
        operation: operationPayload
      });
      const recorded = {
        ...pendingOperation,
        journal: {
          sequence: event.seq,
          eventSha256: event.eventSha256,
          operationSha256: event.coreSha256,
          ledgerRevision: nextData.revision
        }
      };
      const operationIndex = Array.isArray(nextData.handoffOperations)
        ? nextData.handoffOperations.findIndex(operation => operation.operationId === pendingOperation.operationId)
        : -1;
      if (operationIndex >= 0) nextData.handoffOperations[operationIndex] = recorded;
      if (outcome.operation?.operationId === pendingOperation.operationId) outcome.operation = recorded;
    }
    if (seq > MAX_EVENTS) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The history has reached its supported event count. Archive it before adding more.');
    if (!sameHistoryStamp(chain.stamp, historyStamp(historyFile))) fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history changed before the write. Try again.');
    const events = operationalEvents([...chain.events, ...lines]);
    // Recovery may establish a new local sequence, but it cannot erase an
    // identity this writer already knows. A refused/no-op recovery keeps the
    // earlier reconciliation facts intact.
    if (forceVerification || adopting) requireKnownReservations(historyFile, events);
    if (!operationalHistories.has(historyFile)) rememberOperationalHistory(historyFile, chain);
    const known = operationalHistories.get(historyFile);
    known.reusable = false;
    // A publication error may occur after the document reached disk. Retain
    // these reservations until readback or explicit recovery settles it.
    const reserved = new Set(lines.map(event => event.requestId).filter(id => !known.reservedIds.has(id)));
    for (const id of reserved) known.reservedIds.add(id);
    try {
      atomicWrite(ledgerFile, document.raw, nextData);
    } catch (error) {
      // Readback settles it when the document still holds exactly what this
      // write read under the lock: nothing was saved, so the numbers it would
      // have used are on no file. Keeping them reserved refused every later
      // filing in this process until a restart. Any other outcome keeps them.
      if (documentUnchanged(ledgerFile, document)) for (const id of reserved) known.reservedIds.delete(id);
      throw error;
    }
    let stamp = chain.stamp;
    for (const event of lines) stamp = appendChainLine(historyFile, event, stamp);
    const references = referenceEvents([...chain.references.values(), ...lines], currentHistoryReferences(nextData));
    rememberOperationalHistory(historyFile, { exists: true, events,
      sequence: seq, head: previous, broken: null, stamp, checked: false, references });
    return {
      ledgerFile, historyFile, revision: nextData.revision, at, outcome,
      publication: Object.freeze({ durable: true, revision: nextData.revision,
        history: Object.freeze({ sequence: seq, head: previous }) })
    };
  } finally {
    lock.release();
  }
}

function handoffTransact(options, now, mutate) {
  return transact(options, now, mutate, false, false, true);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Make sure the ledger exists. Writes a valid empty record (and its .bak of
 * nothing) only when the file is absent; an existing ledger is left as it is.
 * @returns {{created:boolean, path:string}}
 */
function ensureLedger(options = {}) {
  const { ledgerFile, historyFile } = filesFor(options);
  if (fs.existsSync(ledgerFile)) return Object.freeze({ created: false, path: ledgerFile });
  if (backupUsable(ledgerFile)) {
    fail('R_LEDGER_RESET_PARTIAL', 'the Ledger document is absent while its non-empty .bak remains; recovery must reconcile the reset before creating a new record.');
  }
  const lock = acquireLock(ledgerFile);
  try {
    if (fs.existsSync(ledgerFile)) return Object.freeze({ created: false, path: ledgerFile });
    if (backupUsable(ledgerFile)) {
      fail('R_LEDGER_RESET_PARTIAL', 'the Ledger document is absent while its non-empty .bak remains; recovery must reconcile the reset before creating a new record.');
    }
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    atomicWrite(ledgerFile, '', emptyLedger());
    return Object.freeze({ created: true, path: ledgerFile });
  } finally {
    lock.release();
  }
}

function assertHandoffOperationId(operationId) {
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(operationId)) {
    fail('T_LEDGER_HANDOFF_OPERATION_INVALID', 'A removal handoff needs a stable bounded operation id. No task was changed.');
  }
  return operationId;
}

function assertHandoffSourceNodeId(sourceNodeId) {
  if (typeof sourceNodeId !== 'string' || !SAFE_KEY.test(sourceNodeId)) {
    fail('T_LEDGER_HANDOFF_SOURCE_INVALID', 'A removal handoff needs the saved node identity. No task was changed.');
  }
  return sourceNodeId;
}

function assertHandoffPostimageSha256(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail('T_LEDGER_HANDOFF_POSTIMAGE_INVALID', 'A removal handoff needs the native exact postimage identity before the tree write. No task was changed.');
  }
  return value;
}

function handoffOperationsOf(data) {
  return Array.isArray(data.handoffOperations) ? data.handoffOperations : [];
}

function operationById(data, operationId) {
  return handoffOperationsOf(data).find(operation => operation.operationId === operationId) || null;
}

function handoffTasksOf(data, sourceNodeId) {
  return data.requests
    .filter(entry => plain(entry) && recordKindOf(entry) === 'T')
    .map(normalizeRecord)
    .filter(record => HANDOFF_ACTIVE_STATUSES.has(record.status)
      && (record.scope === 'tree' || record.scope === 'thread')
      && record.scopeKey === sourceNodeId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function handoffTaskDigest(records) {
  return sha256(canonical(records.map(record => ({
    id: record.id,
    scope: record.scope,
    scopeKey: record.scopeKey,
    status: record.status,
    coreSha256: coreSha256(record)
  }))));
}

function pendingHandoffForSource(data, scope, scopeKey) {
  if (!['tree', 'thread'].includes(scope) || typeof scopeKey !== 'string' || !scopeKey) return null;
  const candidates = handoffOperationsOf(data).filter(operation => operation.cleanupKind === OWNER_GONE_CLEANUP_KIND
    ? Array.isArray(operation.sourceNodeIds) && operation.sourceNodeIds.includes(scopeKey)
    : operation.sourceNodeId === scopeKey);
  return candidates
    .slice()
    .sort((left, right) => (right.journal?.sequence || 0) - (left.journal?.sequence || 0))
    .at(0) || null;
}

function assertTaskSourceAvailable(data, scope, scopeKey) {
  const globalCleanup = ownerGoneOperationsOf(data).find(operation => operation.phase !== 'finalized');
  if (globalCleanup) {
    fail('T_LEDGER_HANDOFF_SOURCE_PENDING', `Task filing is held while all-node ${globalCleanup.mode || 'cleanup'} operation ${globalCleanup.operationId} is being reconciled. Existing task ownership and saved sources are retained.`);
  }
  const handoff = pendingHandoffForSource(data, scope, scopeKey);
  if (!handoff) return;
  if (handoff.cleanupKind === OWNER_GONE_CLEANUP_KIND) {
    if (handoff.phase === 'finalized' || handoff.sourceTombstone === true) {
      fail('T_LEDGER_HANDOFF_SOURCE_REMOVED', `Task filing for ${scopeKey} is refused because all saved owners were removed by ${handoff.mode || 'cleanup'}. Re-establish a verified current owner before filing under this source.`);
    }
    fail('T_LEDGER_HANDOFF_SOURCE_PENDING', `Task filing for ${scopeKey} is held while ${handoff.mode || 'cleanup'} owner-gone cleanup ${handoff.operationId} is being reconciled. The source task set is retained; retry after cleanup is finalized.`);
  }
  if (handoff.phase === 'finalized' || handoff.sourceTombstone === true) {
    fail('T_LEDGER_HANDOFF_SOURCE_REMOVED', `Task filing for ${scopeKey} is refused because its saved owner was removed. Re-establish a verified current owner before filing under this source.`);
  }
  fail('T_LEDGER_HANDOFF_SOURCE_PENDING', `Task filing for ${scopeKey} is held while removal operation ${handoff.operationId} is being reconciled. The source task set is retained; retry after the handoff is finalized.`);
}

function requestedHandoffIdentity(input, operation) {
  if (input.sourceNodeId !== operation.sourceNodeId) return false;
  if (input.actor !== undefined && input.actor !== operation.actor) return false;
  if (input.taskSetDigest !== undefined && input.taskSetDigest !== operation.taskSetDigest) return false;
  if (input.parentNodeId !== undefined && input.parentNodeId !== operation.destination?.parentNodeId) return false;
  if (input.parentTreeId !== undefined && input.parentTreeId !== operation.destination?.parentTreeId) return false;
  if (input.postimageSha256 !== undefined && operation.postimageSha256 !== undefined
      && input.postimageSha256 !== operation.postimageSha256) return false;
  return true;
}

function assertHandoffOperationIdentity(input, operation) {
  if (!requestedHandoffIdentity(input, operation)) {
    fail('T_LEDGER_HANDOFF_OPERATION_CONFLICT', `Removal operation ${operation.operationId} was already recorded with different actor, source, destination or task set.`);
  }
}

function resolveHandoffAuthority(config, input, phase) {
  if (typeof config.resolveAuthority !== 'function') {
    fail('T_LEDGER_HANDOFF_AUTHORITY_UNKNOWN', 'The native removal authority is not registered. No task was changed.');
  }
  let authority;
  try {
    authority = config.resolveAuthority(Object.freeze({
      operationId: input.operationId,
      sourceNodeId: input.sourceNodeId,
      phase
    }));
  } catch (error) {
    fail(error?.code || 'T_LEDGER_HANDOFF_AUTHORITY_UNKNOWN', error?.message || 'The native removal authority could not be read. No task was changed.');
  }
  if (!plain(authority) || typeof authority.then === 'function'
      || authority.sourceNodeId !== input.sourceNodeId
      || authority.principal !== config.principal
      || !HANDOFF_DESTINATIONS.has(authority.kind)) {
    fail('T_LEDGER_HANDOFF_AUTHORITY_UNKNOWN', 'The removal topology or authenticated principal is unknown. No task was changed.');
  }
  if (authority.kind === 'verified-parent'
      && (typeof authority.parentNodeId !== 'string' || !SAFE_KEY.test(authority.parentNodeId)
        || authority.parentNodeId === input.sourceNodeId
        || typeof authority.parentTreeId !== 'string' || !SAFE_KEY.test(authority.parentTreeId))) {
    fail('T_LEDGER_HANDOFF_AUTHORITY_UNKNOWN', 'The verified parent binding is incomplete or ambiguous. No task was changed.');
  }
  if (authority.kind === 'verified-no-parent' && authority.parentNodeId !== undefined && authority.parentNodeId !== null) {
    fail('T_LEDGER_HANDOFF_AUTHORITY_UNKNOWN', 'The no-parent removal authority carried an unexpected destination. No task was changed.');
  }
  return Object.freeze({
    kind: authority.kind,
    sourceNodeId: input.sourceNodeId,
    parentNodeId: authority.kind === 'verified-parent' ? authority.parentNodeId : null,
    ...(authority.kind === 'verified-parent' ? { parentTreeId: authority.parentTreeId } : {}),
    ...(authority.parentLabel ? { parentLabel: String(authority.parentLabel).slice(0, MAX_LABEL_CHARS) } : {}),
    ...(authority.topologyRevision !== undefined ? { topologyRevision: String(authority.topologyRevision) } : {}),
    ...(typeof authority.topologyToken === 'string' ? { topologyToken: authority.topologyToken } : {}),
    ...(authority.targetConfiguration && authority.kind === 'verified-parent' ? { targetConfiguration: authority.targetConfiguration } : {}),
    ...(authority.sourcePreimage && plain(authority.sourcePreimage) ? { sourcePreimage: authority.sourcePreimage } : {}),
    ...(authority.reason ? { reason: normalizeReason(authority.reason) } : {})
  });
}

function handoffDestination(authority) {
  return Object.freeze({
    kind: authority.kind,
    parentNodeId: authority.parentNodeId,
    ...(authority.parentTreeId ? { parentTreeId: authority.parentTreeId } : {}),
    ...(authority.parentLabel ? { parentLabel: authority.parentLabel } : {}),
    ...(authority.targetConfiguration ? { targetConfiguration: authority.targetConfiguration } : {})
  });
}

function handoffOperationRecord({ input, authority, taskIds, taskSetDigest, at, phase, sourceBarrier, reason, taskLedgerOptions }) {
  const operation = {
    operationId: input.operationId,
    sourceNodeId: input.sourceNodeId,
    actor: input.actor,
    destination: handoffDestination(authority),
    taskIds: [...taskIds],
    taskSetDigest,
    taskCount: taskIds.length,
    phase,
    sourceBarrier,
    sourcePreimageRetained: true,
    reason,
    ...(authority.topologyRevision ? { topologyRevision: authority.topologyRevision } : {}),
    ...(authority.topologyToken ? { topologyToken: authority.topologyToken } : {}),
    ...(authority.sourcePreimage ? { sourcePreimage: authority.sourcePreimage } : {}),
    ...(taskLedgerOptions ? { coordinatorIdentity: taskLedgerOptions.identity,
      reservationBinding: reservationBindingOf(taskLedgerOptions.reservation) } : {}),
    recordedAt: at
  };
  return operation;
}

function ownerGoneCleanupInput(input, config) {
  if (!plain(input)) fail('T_LEDGER_OWNER_GONE_CLEANUP_INVALID', 'An all-node cleanup request must be an object. No task was changed.');
  const operationId = assertHandoffOperationId(input.operationId);
  const mode = input.mode;
  if (!OWNER_GONE_CLEANUP_MODES.has(mode)) fail('T_LEDGER_OWNER_GONE_CLEANUP_INVALID', 'The all-node cleanup mode is not recognized. No task was changed.');
  if (input.reason !== OWNER_GONE_CLEANUP_REASONS[mode]) fail('T_LEDGER_OWNER_GONE_CLEANUP_INVALID', 'The all-node cleanup reason does not match its native mode. No task was changed.');
  const actor = input.actor === undefined ? config.principal : input.actor;
  if (typeof actor !== 'string' || !actor.trim()) fail('T_LEDGER_HANDOFF_AUTHORITY_UNKNOWN', 'The authenticated cleanup principal is unavailable. No task was changed.');
  return Object.freeze({
    operationId,
    mode,
    reason: input.reason,
    actor: actor.trim(),
    ...(typeof input.topologyToken === 'string' ? { topologyToken: input.topologyToken } : {})
  });
}

function ownerGoneTasksOf(data) {
  const tasks = [];
  for (const entry of data.requests) {
    if (!plain(entry) || recordKindOf(entry) !== 'T') continue;
    const record = normalizeRecord(entry);
    if (!HANDOFF_ACTIVE_STATUSES.has(record.status) || !['tree', 'thread'].includes(record.scope)) continue;
    if (record.ownerState === 'owner-gone') continue;
    if (typeof record.scopeKey !== 'string' || !record.scopeKey) {
      fail('T_LEDGER_OWNER_GONE_CLEANUP_AUTHORITY_UNKNOWN', `Active task ${record.id} has no saved owner scope. No cleanup was admitted.`);
    }
    tasks.push(record);
  }
  return tasks.sort((left, right) => left.id.localeCompare(right.id));
}

function ownerGoneSourceIdsOf(tasks) {
  return [...new Set(tasks.map(task => task.scopeKey))].sort((left, right) => left.localeCompare(right));
}

function ownerGoneTaskSnapshot(tasks) {
  return tasks.map(task => Object.freeze({
    id: task.id,
    status: task.status,
    scope: task.scope,
    scopeKey: task.scopeKey,
    coreSha256: coreSha256(task),
  }));
}

function ownerGoneTaskSnapshotDigest(snapshot) {
  return sha256(canonical(snapshot));
}

function ownerGoneOperationRecord({ input, tasks, at, phase, sourceBarrier, sourceTombstone = false, sourcePreimageRetained = true, taskLedgerOptions }) {
  const snapshot = ownerGoneTaskSnapshot(tasks);
  const sourceNodeIds = ownerGoneSourceIdsOf(tasks);
  return {
    cleanupKind: OWNER_GONE_CLEANUP_KIND,
    operationId: input.operationId,
    sourceNodeId: null,
    sourceNodeIds,
    actor: input.actor,
    mode: input.mode,
    reason: input.reason,
    destination: { kind: 'owner-gone', parentNodeId: null },
    taskIds: snapshot.map(task => task.id),
    taskStatuses: snapshot.map(task => ({ id: task.id, status: task.status, scope: task.scope, scopeKey: task.scopeKey })),
    taskSnapshot: snapshot,
    taskSetDigest: ownerGoneTaskSnapshotDigest(snapshot),
    taskCount: snapshot.length,
    phase,
    sourceBarrier,
    sourcePreimageRetained,
    sourceTombstone,
    ...(taskLedgerOptions ? { coordinatorIdentity: taskLedgerOptions.identity,
      reservationBinding: reservationBindingOf(taskLedgerOptions.reservation) } : {}),
    ...(input.topologyToken ? { topologyToken: input.topologyToken } : {}),
    recordedAt: at,
  };
}

function ownerGoneOperationsOf(data) {
  return handoffOperationsOf(data).filter(operation => operation.cleanupKind === OWNER_GONE_CLEANUP_KIND);
}

function ownerGoneOperationById(data, operationId) {
  return ownerGoneOperationsOf(data).find(operation => operation.operationId === operationId) || null;
}

function ownerGoneOperationIdentityMatches(request, operation) {
  return operation.cleanupKind === OWNER_GONE_CLEANUP_KIND
    && operation.operationId === request.operationId
    && operation.actor === request.actor
    && operation.mode === request.mode
    && operation.reason === request.reason;
}

function ownerGoneTaskSetMatches(data, operation) {
  const tasks = ownerGoneTasksOf(data);
  const snapshot = ownerGoneTaskSnapshot(tasks);
  return snapshot.length === operation.taskCount
    && snapshot.every((task, index) => task.id === operation.taskSnapshot?.[index]?.id
      && task.coreSha256 === operation.taskSnapshot?.[index]?.coreSha256)
    && ownerGoneTaskSnapshotDigest(snapshot) === operation.taskSetDigest;
}

function ownerGoneCommittedPostimageMatches(data, operation) {
  const byId = new Map(data.requests.filter(entry => plain(entry) && typeof entry.id === 'string').map(entry => [entry.id, entry]));
  return Array.isArray(operation.taskStatuses)
    && operation.taskStatuses.length === operation.taskCount
    && operation.taskStatuses.every(expected => {
      const entry = byId.get(expected.id);
      const record = entry ? normalizeRecord(entry) : null;
      return record && record.ownerState === 'owner-gone' && record.ownerNodeId === null
        && record.status === expected.status && record.scope === expected.scope && record.scopeKey === expected.scopeKey;
    });
}

function handoffReceipt(operation, publication, replayed = false) {
  return Object.freeze({
    operationId: operation.operationId,
    phase: operation.phase,
    durable: true,
    replayed,
    sourceNodeId: operation.sourceNodeId,
    ...(operation.cleanupKind ? { cleanupKind: operation.cleanupKind, mode: operation.mode,
      sourceNodeIds: Object.freeze([...(operation.sourceNodeIds || [])]) } : {}),
    destination: Object.freeze({ ...operation.destination }),
    taskIds: Object.freeze([...operation.taskIds]),
    taskSetDigest: operation.taskSetDigest,
    taskCount: operation.taskCount,
    sourceBarrier: operation.sourceBarrier,
    sourcePreimageRetained: operation.sourcePreimageRetained,
    sourceTombstone: operation.sourceTombstone === true,
    ...(operation.journal ? { history: Object.freeze({ ...operation.journal }) } : {}),
    ...(operation.reason ? { reason: operation.reason } : {}),
    ...(operation.topologyRevision ? { topologyRevision: operation.topologyRevision } : {}),
    ...(operation.topologyToken ? { topologyToken: operation.topologyToken } : {}),
    ...(operation.postimageSha256 ? { postimageSha256: operation.postimageSha256 } : {}),
    ...(operation.sourcePreimage && plain(operation.sourcePreimage) ? { sourcePreimage: operation.sourcePreimage } : {}),
    ...(publication ? { publication: Object.freeze({ ...publication, history: publication.history ? Object.freeze({ ...publication.history }) : undefined }) } : {})
  });
}

function replaceHandoffOperation(operations, next) {
  const index = operations.findIndex(operation => operation.operationId === next.operationId);
  if (index === -1) return [...operations, next];
  const copy = [...operations]; copy[index] = next; return copy;
}

function policyDenied(message) {
  fail(TASK_LEDGER_POLICY_DENIED, message);
}

function normalizeCoordinatorIdentity(value) {
  if (!plain(value)) policyDenied('The authenticated task Ledger coordinator identity is unavailable. No task was changed.');
  const actor = value.actor === undefined
    ? (value.nodeId === undefined || value.nodeId === null ? 'human' : 'agent')
    : value.actor;
  const nodeId = value.nodeId === undefined ? null : value.nodeId;
  const hostSessionId = value.hostSessionId === undefined ? value.sessionId : value.hostSessionId;
  const orgRevision = value.orgRevision;
  if (!TASK_LEDGER_COORDINATOR_ACTORS.has(actor)
      || (nodeId !== null && (typeof nodeId !== 'string' || !SAFE_KEY.test(nodeId)))
      || typeof hostSessionId !== 'string' || !SAFE_KEY.test(hostSessionId)
      || !Number.isSafeInteger(orgRevision) || orgRevision < 0
      || (actor === 'human' && nodeId !== null)) {
    policyDenied('The authenticated task Ledger coordinator identity is incomplete or ambiguous. No task was changed.');
  }
  return Object.freeze({ actor, nodeId, hostSessionId, orgRevision });
}

function normalizeTaskLedgerReservation(value, identity) {
  if (!plain(value) || typeof value.token !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value.token)
      || (value.sourceNodeId !== null && (typeof value.sourceNodeId !== 'string' || !SAFE_KEY.test(value.sourceNodeId)))
      || (value.parentNodeId !== null && (typeof value.parentNodeId !== 'string' || !SAFE_KEY.test(value.parentNodeId)))
      || (value.parentTreeId !== null && (typeof value.parentTreeId !== 'string' || !SAFE_KEY.test(value.parentTreeId)))
      || (value.sourcePreimageSha256 !== null && (typeof value.sourcePreimageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourcePreimageSha256)))
      || (value.topologyToken !== undefined && (typeof value.topologyToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.topologyToken)))
      || value.orgRevision !== identity.orgRevision
      || (value.operationId !== undefined && (typeof value.operationId !== 'string' || !HANDOFF_OPERATION_ID.test(value.operationId)))) {
    policyDenied('The authenticated task Ledger topology reservation is missing, malformed or stale. No task was changed.');
  }
  if (value.sourceNodeId === null && value.sourcePreimageSha256 !== null) {
    policyDenied('The authenticated task Ledger cleanup reservation carried a source preimage. No task was changed.');
  }
  return Object.freeze({
    token: value.token,
    sourceNodeId: value.sourceNodeId,
    parentNodeId: value.parentNodeId,
    parentTreeId: value.parentTreeId,
    sourcePreimageSha256: value.sourcePreimageSha256,
    ...(value.topologyToken === undefined ? {} : { topologyToken: value.topologyToken }),
    orgRevision: value.orgRevision,
    ...(value.operationId === undefined ? {} : { operationId: value.operationId }),
  });
}

function reservationBindingOf(reservation) {
  return Object.freeze({
    // The raw capability never enters the ledger.  Its digest does: otherwise
    // two independently issued opaque leases with the same topology fields
    // could be substituted at commit time.
    tokenSha256: sha256(reservation.token),
    sourceNodeId: reservation.sourceNodeId,
    parentNodeId: reservation.parentNodeId,
    parentTreeId: reservation.parentTreeId,
    sourcePreimageSha256: reservation.sourcePreimageSha256,
    ...(reservation.topologyToken === undefined ? {} : { topologyToken: reservation.topologyToken }),
    orgRevision: reservation.orgRevision,
  });
}

function storedCoordinatorIdentityValid(value) {
  return plain(value)
    && TASK_LEDGER_COORDINATOR_ACTORS.has(value.actor)
    && (value.nodeId === null || (typeof value.nodeId === 'string' && SAFE_KEY.test(value.nodeId)))
    && typeof value.hostSessionId === 'string' && SAFE_KEY.test(value.hostSessionId)
    && Number.isSafeInteger(value.orgRevision) && value.orgRevision >= 0
    && (value.actor !== 'human' || value.nodeId === null);
}

function storedReservationBindingValid(value) {
  return plain(value)
    && typeof value.tokenSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.tokenSha256)
    && (value.sourceNodeId === null || (typeof value.sourceNodeId === 'string' && SAFE_KEY.test(value.sourceNodeId)))
    && (value.parentNodeId === null || (typeof value.parentNodeId === 'string' && SAFE_KEY.test(value.parentNodeId)))
    && (value.parentTreeId === null || (typeof value.parentTreeId === 'string' && SAFE_KEY.test(value.parentTreeId)))
    && (value.sourcePreimageSha256 === null || (typeof value.sourcePreimageSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sourcePreimageSha256)))
    && (value.topologyToken === undefined || (typeof value.topologyToken === 'string' && /^[a-f0-9]{64}$/.test(value.topologyToken)))
    && Number.isSafeInteger(value.orgRevision) && value.orgRevision >= 0;
}

function storedConsumedReservationValid(value) {
  return plain(value)
    && typeof value.postimageSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.postimageSha256)
    && storedReservationBindingValid(value.reservationBinding);
}

function sameReservationBinding(left, right) {
  return plain(left) && plain(right)
    && left.tokenSha256 === right.tokenSha256
    && left.sourceNodeId === right.sourceNodeId
    && left.parentNodeId === right.parentNodeId
    && left.parentTreeId === right.parentTreeId
    && left.sourcePreimageSha256 === right.sourcePreimageSha256
    && (left.topologyToken || null) === (right.topologyToken || null)
    && left.orgRevision === right.orgRevision;
}

function taskLedgerOptionsFor(config, supplied, {
  requireReservation = false,
  operation = null,
  expectedOperationId = null,
} = {}) {
  const writerStatus = taskLedgerWriterStatus(config);
  if (writerStatus.revoked === true) {
    policyDenied(`The authenticated task Ledger writer was revoked${writerStatus.reason ? ` (${writerStatus.reason})` : ''}. Existing handoff evidence remains unconfirmed.`);
  }
  const registered = config.taskLedgerOptions;
  /* A registration carries the host identity, not a reusable topology lease.
     A missing per-operation options object therefore cannot silently inherit a
     reservation that would authorize an unrelated persistence write. */
  const requested = supplied === undefined
    ? { coordinatorIdentity: registered.coordinatorIdentity }
    : supplied;
  if (!plain(requested)) policyDenied('The authenticated task Ledger options are unavailable. No task was changed.');
  const identity = normalizeCoordinatorIdentity(requested.coordinatorIdentity || registered.coordinatorIdentity);
  if (identity.actor !== registered.coordinatorIdentity.actor
      || identity.nodeId !== registered.coordinatorIdentity.nodeId
      || identity.hostSessionId !== registered.coordinatorIdentity.hostSessionId
      || identity.orgRevision !== registered.coordinatorIdentity.orgRevision) {
    policyDenied('The task Ledger coordinator identity changed while the writer was registered. Re-register before continuing.');
  }
  const rawReservation = requested.reservation;
  const reservation = rawReservation === undefined || rawReservation === null
    ? null : normalizeTaskLedgerReservation(rawReservation, identity);
  if (requireReservation && !reservation) {
    policyDenied('The authenticated task Ledger topology reservation is missing. No task was changed.');
  }
  if (requireReservation && expectedOperationId !== null
      && reservation.operationId !== expectedOperationId) {
    policyDenied('The authenticated task Ledger topology reservation is not bound to this handoff operation. No task was changed.');
  }
  if (operation?.coordinatorIdentity && (operation.coordinatorIdentity.actor !== identity.actor
      || (operation.coordinatorIdentity.nodeId || null) !== (identity.nodeId || null)
      || operation.coordinatorIdentity.hostSessionId !== identity.hostSessionId
      || operation.coordinatorIdentity.orgRevision !== identity.orgRevision)) {
    policyDenied('The task Ledger coordinator identity does not match the durable handoff. Existing evidence remains unconfirmed.');
  }
  if (operation?.reservationBinding && reservation && !sameReservationBinding(operation.reservationBinding, reservationBindingOf(reservation))) {
    policyDenied('The task Ledger topology reservation does not match the durable handoff. Existing evidence remains unconfirmed.');
  }
  const durableConsumed = operation?.consumedReservation || null;
  if (durableConsumed && reservation
      && (!operation.postimageSha256
        || durableConsumed.postimageSha256 !== operation.postimageSha256
        || !sameReservationBinding(durableConsumed.reservationBinding, reservationBindingOf(reservation)))) {
    policyDenied('The authenticated task Ledger topology reservation does not match the durable consumed handoff. Existing evidence remains unconfirmed.');
  }
  const consumed = reservation ? config.consumedReservations.get(reservation.token) : null;
  if (consumed) {
    if (!operation || operation.operationId !== consumed.operationId
        || operation.postimageSha256 !== consumed.postimageSha256
        || !sameReservationBinding(operation.reservationBinding, consumed.reservationBinding)) {
      policyDenied('The authenticated task Ledger topology reservation was already consumed by another or incomplete handoff. Existing evidence remains unconfirmed.');
    }
  }
  return Object.freeze({ identity, reservation, consumed: consumed || durableConsumed || null });
}

function assertReservationAuthority(taskLedgerOptions, input, authority) {
  const reservation = taskLedgerOptions?.reservation;
  if (!reservation) policyDenied('The authenticated task Ledger topology reservation is missing. No task was changed.');
  const parentNodeId = authority?.parentNodeId ?? null;
  const parentTreeId = authority?.parentTreeId ?? null;
  const sourcePreimageSha256 = authority?.sourcePreimage
    ? sha256(canonical(authority.sourcePreimage)) : null;
  if (reservation.sourceNodeId !== (authority?.sourceNodeId ?? input.sourceNodeId)
      || reservation.parentNodeId !== parentNodeId
      || reservation.parentTreeId !== parentTreeId
      || reservation.sourcePreimageSha256 !== sourcePreimageSha256
      || (authority?.topologyToken !== undefined && reservation.topologyToken !== authority.topologyToken)
      || (reservation.operationId !== undefined && reservation.operationId !== input.operationId)) {
    policyDenied('The authenticated task Ledger topology reservation does not match the verified saved authority. No task was changed.');
  }
  if (taskLedgerOptions.identity.actor === 'agent' && taskLedgerOptions.identity.nodeId !== input.sourceNodeId) {
    policyDenied('The authenticated task Ledger agent identity does not match the removed saved owner. No task was changed.');
  }
  if (taskLedgerOptions.identity.actor === 'human' && taskLedgerOptions.identity.nodeId !== null) {
    policyDenied('The authenticated human coordinator identity carried an agent node. No task was changed.');
  }
}

function consumeTaskLedgerReservation(input = {}, config, taskLedgerOptions) {
  const request = normalizeHandoffInput(input, config);
  let consumedToken = null;
  let consumedBinding = null;
  const result = handoffTransact(config.options, request.now, (document, at, chain) => {
    const operation = operationById(document.data, request.operationId);
    if (!operation) {
      fail('T_LEDGER_HANDOFF_OPERATION_UNKNOWN', `Removal operation ${request.operationId} has no durable handoff to admit. No tree change was authorized.`);
    }
    assertRegisteredActor(request, config, operation);
    const activeOptions = taskLedgerOptionsFor(config, taskLedgerOptions, {
      operation,
      requireReservation: true,
      expectedOperationId: operation.operationId,
    });
    if (operation.phase !== 'committed') {
      fail('T_LEDGER_HANDOFF_PHASE_INVALID', `Removal operation ${request.operationId} is not committed for topology admission. No tree change was authorized.`);
    }
    const postimageSha256 = assertHandoffPostimageSha256(request.postimageSha256);
    if (operation.postimageSha256 !== postimageSha256) {
      fail('T_LEDGER_HANDOFF_OPERATION_CONFLICT', `Removal operation ${request.operationId} was admitted for a different durable tree postimage.`);
    }
    assertReservationAuthority(activeOptions, request, {
      sourceNodeId: operation.sourceNodeId,
      parentNodeId: operation.destination?.parentNodeId ?? null,
      parentTreeId: operation.destination?.parentTreeId ?? null,
      topologyToken: operation.topologyToken,
      sourcePreimage: operation.sourcePreimage,
    });
    handoffJournalEvent(operation, chain);
    assertHandoffTaskBindings(document.data, operation, chain);
    const reservation = activeOptions.reservation;
    const binding = reservationBindingOf(reservation);
    const prior = config.consumedReservations.get(reservation.token);
    if (prior || operation.consumedReservation) {
      // A consumed capability is valid only for finalize/read replay.  A
      // second topology admission, even for the same operation and postimage,
      // is a new persistence authorization and must fail closed.
      policyDenied('The authenticated task Ledger topology reservation was already consumed. Finalize or read the existing handoff; do not admit another tree write.');
    }
    consumedToken = reservation.token;
    consumedBinding = binding;
    const consumedOperation = {
      ...operation,
      consumedReservation: { postimageSha256, reservationBinding: binding },
    };
    return {
      requests: document.data.requests,
      events: [],
      operationEvents: [operationEvent(consumedOperation)],
      handoffOperations: replaceHandoffOperation(handoffOperationsOf(document.data), consumedOperation),
      operation: consumedOperation,
      replayed: false,
    };
  });
  const operation = result.outcome.operation;
  config.consumedReservations.set(consumedToken, Object.freeze({
    operationId: operation.operationId,
    postimageSha256: operation.consumedReservation.postimageSha256,
    reservationBinding: consumedBinding,
  }));
  return Object.freeze({
    consumed: true,
    operationId: operation.operationId,
    phase: operation.phase,
    postimageSha256: operation.postimageSha256,
    replayed: false,
  });
}

function taskLedgerWriterStatus(config) {
  if (config.revoked === true) return Object.freeze({ revoked: true, reason: config.revokeReason || 'LIFECYCLE' });
  let kill;
  try {
    kill = killSwitch.status();
  } catch (error) {
    config.revoked = true;
    config.revokeReason = 'KILLSWITCH_STATE_UNAVAILABLE';
    return Object.freeze({ revoked: true, reason: config.revokeReason, error: error?.message || 'unknown state' });
  }
  if (kill?.active === true) {
    // The marker may have been activated by another process, so the local
    // callback is not sufficient.  Latch this capability before returning;
    // clearing the marker must never resurrect an old registration.
    config.revoked = true;
    config.revokeReason = 'KILLSWITCH_ACTIVE';
    return Object.freeze({ revoked: true, reason: config.revokeReason });
  }
  return Object.freeze({ revoked: false, reason: null });
}

/* A writer method closes over the registration config for speed, but that
 * closure is not the authority.  Revocation, kill-switch activation and a
 * foreign/stale registration must be observed again at every write boundary.
 * The status method remains a read-only observation so lifecycle callers can
 * discover revocation; all mutating capability methods use this guard. */
function assertTaskLedgerWriterUse(registration, config, capability) {
  if (taskLedgerWriterRegistrations.get(registration) !== config) {
    policyDenied('The authenticated task Ledger writer registration is no longer current. No task was changed.');
  }
  if (config.capability !== capability) {
    policyDenied('The authenticated task Ledger writer does not carry this capability. No task was changed.');
  }
  const status = taskLedgerWriterStatus(config);
  if (status.revoked === true) {
    policyDenied(`The authenticated task Ledger writer is revoked (${status.reason || 'LIFECYCLE'}). No task was changed.`);
  }
  return config;
}

const TASK_LEDGER_ASSIGNMENT_CAPABILITY = 'task-assignment';
const TASK_LEDGER_ASSIGNMENT_PRINCIPAL = 'task-assignment-service';

function registerTaskLedgerWriter({
  options = {}, principal, resolveAuthority, verifyTopologyReceipt,
  capability = 'topology',
} = {}) {
  const assignmentRegistration = capability === TASK_LEDGER_ASSIGNMENT_CAPABILITY;
  const assignmentAuthority = options?.taskLedgerOptions?.assignmentAuthority;
  if (!plain(options) || typeof principal !== 'string' || !principal.trim()
      || (assignmentRegistration
        ? (principal.trim() !== TASK_LEDGER_ASSIGNMENT_PRINCIPAL
          || !plain(assignmentAuthority)
          || typeof assignmentAuthority.resolveAssignmentAuthority !== 'function'
          || typeof assignmentAuthority.assertCurrent !== 'function'
          || typeof assignmentAuthority.readSettings !== 'function')
        : typeof resolveAuthority !== 'function')) {
    if (assignmentRegistration) {
      policyDenied('The task-assignment Ledger writer needs a private host authority resolver and assignment capability. No task was changed.');
    }
    fail('T_LEDGER_WRITER_UNAVAILABLE', 'The native task Ledger writer needs a private store registration and synchronous authority resolver.');
  }
  if (!['topology', TASK_LEDGER_ASSIGNMENT_CAPABILITY].includes(capability)) {
    policyDenied('The task Ledger writer capability is unknown. No task was changed.');
  }
  if (!plain(options.taskLedgerOptions) || !plain(options.taskLedgerOptions.coordinatorIdentity)) {
    policyDenied('The native task Ledger writer needs a host-derived coordinator identity. No task was changed.');
  }
  let kill;
  try { kill = killSwitch.status(); } catch (error) {
    policyDenied(`The task Ledger kill-switch state is unavailable: ${error?.message || 'unknown state'}. No task was changed.`);
  }
  if (kill?.active === true) {
    policyDenied('The task Ledger writer is unavailable while the native kill switch is active. Existing handoff evidence remains unconfirmed.');
  }
  const coordinatorIdentity = normalizeCoordinatorIdentity(options.taskLedgerOptions.coordinatorIdentity);
  const reservation = options.taskLedgerOptions.reservation === undefined
    ? null : normalizeTaskLedgerReservation(options.taskLedgerOptions.reservation, coordinatorIdentity);
  if (reservation && reservation.operationId === undefined) {
    policyDenied('A registered task Ledger writer cannot carry an unbound topology reservation. No task was changed.');
  }
  const registration = Object.freeze({});
  const config = {
    options: Object.freeze({ ...options }),
    taskLedgerOptions: Object.freeze({ coordinatorIdentity, ...(reservation ? { reservation } : {}) }),
    principal: principal.trim(),
    capability,
    resolveAuthority,
    verifyTopologyReceipt,
    assignmentAuthority: assignmentRegistration ? Object.freeze({ ...assignmentAuthority }) : null,
    consumedReservations: new Map(),
    revoked: false,
    revokeReason: null,
    killSwitchUnsubscribe: null,
  };
  if (typeof killSwitch.onActivate === 'function') {
    config.killSwitchUnsubscribe = killSwitch.onActivate(() => {
      config.revoked = true;
      config.revokeReason = 'KILLSWITCH_ACTIVE';
    });
  }
  taskLedgerWriterRegistrations.set(registration, config);
  return registration;
}

function revokeTaskLedgerWriter(registration, reason = 'LIFECYCLE') {
  const config = registeredTaskLedgerWriter(registration);
  config.revoked = true;
  config.revokeReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'LIFECYCLE';
  if (typeof config.killSwitchUnsubscribe === 'function') config.killSwitchUnsubscribe();
  config.killSwitchUnsubscribe = null;
  return Object.freeze({ revoked: true, reason: config.revokeReason });
}

function taskLedgerWriter(registration) {
  const config = registeredTaskLedgerWriter(registration);
  const writer = { status: () => taskLedgerWriterStatus(config) };
  if (config.capability === 'topology') {
    Object.assign(writer, {
      prepareTaskOwnerGoneCleanup: (input, taskLedgerOptions) => { assertTaskLedgerWriterUse(registration, config, 'topology'); return prepareTaskOwnerGoneCleanup(input, config, taskLedgerOptions); },
      commitTaskOwnerGoneCleanup: (input, taskLedgerOptions) => { assertTaskLedgerWriterUse(registration, config, 'topology'); return commitTaskOwnerGoneCleanup(input, config, taskLedgerOptions); },
      finalizeTaskOwnerGoneCleanup: (input, taskLedgerOptions) => { assertTaskLedgerWriterUse(registration, config, 'topology'); return finalizeTaskOwnerGoneCleanup(input, config, taskLedgerOptions); },
      prepareTaskHandoff: (input, taskLedgerOptions) => { assertTaskLedgerWriterUse(registration, config, 'topology'); return prepareTaskHandoff(input, config, taskLedgerOptions); },
      commitTaskHandoff: (input, taskLedgerOptions) => { assertTaskLedgerWriterUse(registration, config, 'topology'); return commitTaskHandoff(input, config, taskLedgerOptions); },
      finalizeTaskHandoff: (input, taskLedgerOptions) => { assertTaskLedgerWriterUse(registration, config, 'topology'); return finalizeTaskHandoff(input, config, taskLedgerOptions); },
      consumeTaskLedgerReservation: (input, taskLedgerOptions) => { assertTaskLedgerWriterUse(registration, config, 'topology'); return consumeTaskLedgerReservation(input, config, taskLedgerOptions); },
      readTaskHandoff: (operationId, taskLedgerOptions) => { assertTaskLedgerWriterUse(registration, config, 'topology'); return readTaskHandoff({ operationId }, config.options, config, taskLedgerOptions); },
      readTaskOwnerGoneCleanup: (operationId, taskLedgerOptions) => { assertTaskLedgerWriterUse(registration, config, 'topology'); return readTaskHandoff({ operationId }, config.options, config, taskLedgerOptions); },
    });
  } else if (config.capability === TASK_LEDGER_ASSIGNMENT_CAPABILITY) {
    writer.assignTask = input => {
      assertTaskLedgerWriterUse(registration, config, TASK_LEDGER_ASSIGNMENT_CAPABILITY);
      if (!plain(input) || typeof input.id !== 'string' || typeof input.nodeId !== 'string'
          || typeof input.assignmentId !== 'string' || typeof input.reason !== 'string'
          || typeof input.actor !== 'string' || !input.actor.trim()) {
        fail('T_LEDGER_ASSIGNMENT_INVALID', 'A task assignment needs an existing task, target node, assignment id, reason and bound actor. No task was changed.');
      }
      const transaction = module.exports.assignTask;
      if (typeof transaction !== 'function') {
        fail('T_LEDGER_ASSIGNMENT_UNAVAILABLE', 'The task assignment transaction is not installed. No task was changed.');
      }
      const privateOptions = {
        ...config.options,
        taskLedgerOptions: {
          ...config.taskLedgerOptions,
          assignmentAuthority: config.assignmentAuthority,
        },
      };
      const result = transaction({
        id: input.id,
        nodeId: input.nodeId,
        assignmentId: input.assignmentId,
        reason: input.reason,
        actor: input.actor,
        ...(input.now === undefined ? {} : { now: input.now }),
      }, privateOptions);
      if (!plain(result) || typeof result.then === 'function'
          || result.assigned !== true || result.id !== input.id
          || result.assignmentId !== input.assignmentId) {
        fail('T_LEDGER_ASSIGNMENT_RESULT_INVALID', 'The task assignment transaction did not return a complete durable receipt. No assignment was reported.');
      }
      return Object.freeze({ ...result });
    };
  }
  return Object.freeze(writer);
}

function normalizeHandoffInput(input, config) {
  if (!plain(input)) fail('T_LEDGER_HANDOFF_OPERATION_INVALID', 'A removal handoff request must be an object. No task was changed.');
  const operationId = assertHandoffOperationId(input.operationId);
  const sourceNodeId = assertHandoffSourceNodeId(input.sourceNodeId);
  const actor = input.actor === undefined ? config.principal : input.actor;
  if (typeof actor !== 'string' || !actor.trim()) fail('T_LEDGER_HANDOFF_AUTHORITY_UNKNOWN', 'The authenticated removal principal is unavailable. No task was changed.');
  return Object.freeze({
    ...input,
    operationId,
    sourceNodeId,
    actor: actor.trim(),
    ...(input.reason !== undefined ? { reason: normalizeReason(input.reason) } : {}),
    ...(input.postimageSha256 !== undefined ? { postimageSha256: assertHandoffPostimageSha256(input.postimageSha256) } : {})
  });
}

function assertRegisteredActor(input, config, existing = null) {
  const expected = existing?.actor || config.principal;
  if (input.actor !== expected) {
    fail(existing ? 'T_LEDGER_HANDOFF_OPERATION_CONFLICT' : 'T_LEDGER_HANDOFF_AUTHORITY_UNKNOWN',
      'The removal principal does not match the registered native reservation. No task was changed.');
  }
}

function sameHandoffDestination(operation, authority) {
  return operation.destination?.kind === authority.kind
    && (operation.destination?.parentNodeId || null) === (authority.parentNodeId || null)
    && (operation.destination?.parentTreeId || null) === (authority.parentTreeId || null)
    && canonical(operation.destination?.targetConfiguration || null) === canonical(authority.targetConfiguration || null)
    && (operation.topologyToken || null) === (authority.topologyToken || null)
    && canonical(operation.sourcePreimage || null) === canonical(authority.sourcePreimage || null);
}

function handoffDestinationValid(destination, sourceNodeId, ownerGoneCleanup = false) {
  if (!plain(destination) || typeof destination.kind !== 'string') return false;
  if (destination.kind === 'verified-parent') {
    return !ownerGoneCleanup
      && typeof destination.parentNodeId === 'string'
      && SAFE_KEY.test(destination.parentNodeId)
      && destination.parentNodeId !== sourceNodeId
      && typeof destination.parentTreeId === 'string'
      && SAFE_KEY.test(destination.parentTreeId);
  }
  if (destination.kind === 'verified-no-parent') {
    return !ownerGoneCleanup
      && (destination.parentNodeId === null || destination.parentNodeId === undefined)
      && (destination.parentTreeId === null || destination.parentTreeId === undefined);
  }
  if (destination.kind === 'owner-gone') {
    return ownerGoneCleanup
      && (destination.parentNodeId === null || destination.parentNodeId === undefined)
      && (destination.parentTreeId === null || destination.parentTreeId === undefined);
  }
  return false;
}

function assertHandoffDestination(operation) {
  if (!handoffDestinationValid(operation?.destination, operation?.sourceNodeId,
    operation?.cleanupKind === OWNER_GONE_CLEANUP_KIND)) {
    fail('T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE', 'The saved handoff destination is incomplete or unsafe. No topology effect is inferred.');
  }
}

function handoffReason(input, authority) {
  const reason = authority.reason || input.reason;
  if (!reason) fail('T_LEDGER_HANDOFF_REASON_REQUIRED', 'A durable task handoff needs the authenticated removal reason. No task was changed.');
  return normalizeReason(reason);
}

function operationEvent(operation) {
  const { journal: _journal, ...withoutJournal } = operation;
  return { ...withoutJournal, actor: operation.actor };
}

function handoffJournalEvent(operation, chain) {
  const journal = operation?.journal;
  if (!plain(journal) || !Number.isSafeInteger(journal.sequence) || journal.sequence < 1
      || typeof journal.eventSha256 !== 'string' || typeof journal.operationSha256 !== 'string') {
    fail('T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE', 'The handoff operation has no complete journal binding. No phase is inferred from the saved operation.');
  }
  const event = chain.events.find(candidate => candidate.seq === journal.sequence);
  const operationEvents = chain.events.filter(candidate => candidate.kind === HANDOFF_EVENT_KIND
    && candidate.requestId === `handoff:${operation.operationId}`);
  const latest = operationEvents.at(-1);
  const payload = operationEvent(operation);
  if (!event || event.kind !== HANDOFF_EVENT_KIND
      || event.requestId !== `handoff:${operation.operationId}`
      || !latest || latest.seq !== event.seq
      || event.statusAfter !== operation.phase
      || event.eventSha256 !== journal.eventSha256
      || event.coreSha256 !== journal.operationSha256
      || event.ledgerRevision !== journal.ledgerRevision
      || canonical(event.operation) !== canonical(payload)
      || sha256(canonical(payload)) !== journal.operationSha256) {
    fail('T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE', 'The handoff journal does not match the saved operation phase. No topology effect is inferred.');
  }
  assertHandoffDestination(operation);
  return event;
}

function prepareTaskOwnerGoneCleanup(input = {}, config, taskLedgerOptions) {
  const request = ownerGoneCleanupInput(input, config);
  assertRegisteredActor(request, config);
  taskLedgerOptionsFor(config, taskLedgerOptions, { requireReservation: false });
  const result = handoffTransact(config.options, request.now, (document, at, chain) => {
    const existing = ownerGoneOperationById(document.data, request.operationId);
    if (existing) {
      if (!ownerGoneOperationIdentityMatches(request, existing)) {
        fail('T_LEDGER_OWNER_GONE_CLEANUP_CONFLICT', `Cleanup operation ${request.operationId} was recorded with different mode, reason or actor.`);
      }
      assertRegisteredActor(request, config, existing);
      taskLedgerOptionsFor(config, taskLedgerOptions, { operation: existing });
      handoffJournalEvent(existing, chain);
      assertHandoffTaskBindings(document.data, existing, chain);
      if (existing.phase === 'prepared' && !ownerGoneTaskSetMatches(document.data, existing)) {
        fail('T_LEDGER_OWNER_GONE_CLEANUP_TASK_SET_CONFLICT', 'The active task set changed while all-node cleanup was pending. No task was changed.');
      }
      if (existing.phase !== 'prepared' && !ownerGoneCommittedPostimageMatches(document.data, existing)) {
        fail('T_LEDGER_OWNER_GONE_CLEANUP_RECEIPT_UNAVAILABLE', 'The persisted owner-gone cleanup postimage no longer matches its durable operation. No deletion is admitted.');
      }
      return { requests: document.data.requests, events: [], operationEvents: [],
        handoffOperations: handoffOperationsOf(document.data), operation: existing, replayed: true };
    }
    const tasks = ownerGoneTasksOf(document.data);
    const sourceNodeIds = new Set(ownerGoneSourceIdsOf(tasks));
    const prior = ownerGoneOperationsOf(document.data).find(operation => operation.phase !== 'finalized'
      && operation.sourceNodeIds?.some(sourceNodeId => sourceNodeIds.has(sourceNodeId)));
    if (prior) {
      fail('T_LEDGER_OWNER_GONE_CLEANUP_SOURCE_PENDING', `Cleanup operation ${prior.operationId} already holds one of the saved owners in this all-node cleanup.`);
    }
    const activeOptions = taskLedgerOptionsFor(config, taskLedgerOptions, {
      requireReservation: true,
      expectedOperationId: request.operationId,
    });
    if (activeOptions.reservation.sourceNodeId !== null || activeOptions.reservation.parentNodeId !== null
        || activeOptions.reservation.parentTreeId !== null || activeOptions.reservation.sourcePreimageSha256 !== null) {
      policyDenied('The all-node cleanup reservation carried a saved-owner destination. No task was changed.');
    }
    const operation = ownerGoneOperationRecord({
      input: request, tasks, at, phase: 'prepared', sourceBarrier: 'pending',
      taskLedgerOptions: activeOptions,
    });
    return {
      requests: document.data.requests,
      events: [],
      operationEvents: [operationEvent(operation)],
      handoffOperations: [...handoffOperationsOf(document.data), operation],
      operation,
      replayed: false,
    };
  });
  return handoffReceipt(result.outcome.operation, result.publication, result.outcome.replayed === true);
}

function commitTaskOwnerGoneCleanup(input = {}, config, taskLedgerOptions) {
  const request = ownerGoneCleanupInput(input, config);
  assertRegisteredActor(request, config);
  taskLedgerOptionsFor(config, taskLedgerOptions, { requireReservation: false });
  const result = handoffTransact(config.options, request.now, (document, at, chain) => {
    const existing = ownerGoneOperationById(document.data, request.operationId);
    if (!existing) fail('T_LEDGER_OWNER_GONE_CLEANUP_UNKNOWN', `Cleanup operation ${request.operationId} has no prepared owner-gone barrier. No task was changed.`);
    if (!ownerGoneOperationIdentityMatches(request, existing)) {
      fail('T_LEDGER_OWNER_GONE_CLEANUP_CONFLICT', `Cleanup operation ${request.operationId} was recorded with different mode, reason or actor.`);
    }
    assertRegisteredActor(request, config, existing);
    const activeOptions = taskLedgerOptionsFor(config, taskLedgerOptions, {
      operation: existing,
      requireReservation: existing.phase === 'prepared',
      expectedOperationId: existing.operationId,
    });
    if (existing.phase === 'prepared' && (activeOptions.reservation.sourceNodeId !== null
        || activeOptions.reservation.parentNodeId !== null || activeOptions.reservation.parentTreeId !== null
        || activeOptions.reservation.sourcePreimageSha256 !== null)) {
      policyDenied('The all-node cleanup reservation carried a saved-owner destination. No task was changed.');
    }
    handoffJournalEvent(existing, chain);
    assertHandoffTaskBindings(document.data, existing, chain);
    if (existing.phase === 'committed' || existing.phase === 'finalized') {
      if (!ownerGoneCommittedPostimageMatches(document.data, existing)) {
        fail('T_LEDGER_OWNER_GONE_CLEANUP_RECEIPT_UNAVAILABLE', 'The persisted owner-gone cleanup postimage no longer matches its durable operation. No deletion is admitted.');
      }
      return { requests: document.data.requests, events: [], operationEvents: [],
        handoffOperations: handoffOperationsOf(document.data), operation: existing, replayed: true };
    }
    if (existing.phase !== 'prepared') fail('T_LEDGER_OWNER_GONE_CLEANUP_PHASE_INVALID', 'The all-node cleanup barrier is not prepared. No task was changed.');
    if (!ownerGoneTaskSetMatches(document.data, existing)) {
      fail('T_LEDGER_OWNER_GONE_CLEANUP_TASK_SET_CONFLICT', 'The active task set changed after all-node enumeration. The source bytes were retained and no task was changed.');
    }
    const byId = new Map(document.data.requests.map((entry, index) => [entry.id, { entry, index }]));
    const requests = [...document.data.requests];
    const events = [];
    for (const expected of existing.taskStatuses) {
      const found = byId.get(expected.id);
      if (!found) fail('T_LEDGER_OWNER_GONE_CLEANUP_TASK_SET_CONFLICT', `Task ${expected.id} disappeared before all-node cleanup. No task was changed.`);
      const record = normalizeRecord(found.entry);
      const historyRow = { seq: 0, kind: HANDOFF_EVENT_KIND, at, actor: existing.actor,
        statusBefore: record.status, eventSha256: '', operationId: existing.operationId };
      const decision = {
        at, actor: existing.actor, decision: 'owner-gone', operationId: existing.operationId,
        reason: existing.reason, fromNodeId: record.scopeKey, toNodeId: null, ownerState: 'owner-gone'
      };
      const next = {
        ...found.entry,
        scope: record.scope,
        scopeKey: record.scopeKey,
        ...(record.scope === 'thread' ? { threadId: record.threadId } : {}),
        ownerState: 'owner-gone',
        ownerNodeId: null,
        decisions: [...record.decisions, decision],
        history: [...record.history, historyRow]
      };
      requests[found.index] = next;
      events.push({ kind: HANDOFF_EVENT_KIND, actor: existing.actor, record: next, historyRow,
        operation: { type: 'task-owner-gone-cleanup', operationId: existing.operationId,
          ownerState: 'owner-gone', fromNodeId: record.scopeKey, toNodeId: null, reason: existing.reason } });
    }
    const operation = {
      ...existing,
      phase: 'committed',
      sourceBarrier: 'retained',
      sourcePreimageRetained: true,
      sourceTombstone: false,
      committedAt: at,
    };
    return {
      requests,
      events,
      operationEvents: [operationEvent(operation)],
      handoffOperations: replaceHandoffOperation(handoffOperationsOf(document.data), operation),
      operation,
      replayed: false,
    };
  });
  return handoffReceipt(result.outcome.operation, result.publication, result.outcome.replayed === true);
}

function finalizeTaskOwnerGoneCleanup(input = {}, config, taskLedgerOptions) {
  const request = ownerGoneCleanupInput(input, config);
  assertRegisteredActor(request, config);
  taskLedgerOptionsFor(config, taskLedgerOptions, { requireReservation: false });
  const cleanupReceipt = input.cleanupReceipt;
  if (!plain(cleanupReceipt) || typeof cleanupReceipt.then === 'function'
      || cleanupReceipt.durable !== true || cleanupReceipt.operationId !== request.operationId
      || cleanupReceipt.mode !== request.mode || cleanupReceipt.sourceBytesAbsent !== true
      || typeof cleanupReceipt.sourceNodeIdsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(cleanupReceipt.sourceNodeIdsDigest)
      || typeof cleanupReceipt.taskSetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(cleanupReceipt.taskSetDigest)
      || !Number.isSafeInteger(cleanupReceipt.taskCount)) {
    fail('T_LEDGER_OWNER_GONE_CLEANUP_UNCONFIRMED', 'The all-node cleanup read-back is absent or incomplete. The owner-gone barrier remains active.');
  }
  const result = handoffTransact(config.options, request.now, (document, at, chain) => {
    const existing = ownerGoneOperationById(document.data, request.operationId);
    if (!existing) fail('T_LEDGER_OWNER_GONE_CLEANUP_UNKNOWN', `Cleanup operation ${request.operationId} has no committed owner-gone barrier. No deletion is inferred.`);
    if (!ownerGoneOperationIdentityMatches(request, existing)) {
      fail('T_LEDGER_OWNER_GONE_CLEANUP_CONFLICT', `Cleanup operation ${request.operationId} was recorded with different mode, reason or actor.`);
    }
    assertRegisteredActor(request, config, existing);
    const activeOptions = taskLedgerOptionsFor(config, taskLedgerOptions, {
      operation: existing,
      requireReservation: existing.phase === 'committed',
      expectedOperationId: existing.operationId,
    });
    if (existing.phase === 'committed' && (activeOptions.reservation.sourceNodeId !== null
        || activeOptions.reservation.parentNodeId !== null || activeOptions.reservation.parentTreeId !== null
        || activeOptions.reservation.sourcePreimageSha256 !== null)) {
      policyDenied('The all-node cleanup reservation carried a saved-owner destination. No task was changed.');
    }
    handoffJournalEvent(existing, chain);
    assertHandoffTaskBindings(document.data, existing, chain);
    if (cleanupReceipt.sourceNodeIdsDigest !== sha256(canonical(existing.sourceNodeIds))
        || cleanupReceipt.taskSetDigest !== existing.taskSetDigest
        || cleanupReceipt.taskCount !== existing.taskCount) {
      fail('T_LEDGER_OWNER_GONE_CLEANUP_UNCONFIRMED', 'The all-node cleanup read-back does not bind the recorded source and task set. The owner-gone barrier remains active.');
    }
    if (existing.phase === 'finalized') {
      if (!ownerGoneCommittedPostimageMatches(document.data, existing)) {
        fail('T_LEDGER_OWNER_GONE_CLEANUP_RECEIPT_UNAVAILABLE', 'The finalized owner-gone cleanup no longer matches its durable task postimage.');
      }
      return { requests: document.data.requests, events: [], operationEvents: [],
        handoffOperations: handoffOperationsOf(document.data), operation: existing, replayed: true };
    }
    if (existing.phase !== 'committed' || !ownerGoneCommittedPostimageMatches(document.data, existing)) {
      fail('T_LEDGER_OWNER_GONE_CLEANUP_PHASE_INVALID', 'The all-node cleanup is not a durable committed operation. The owner-gone barrier remains active.');
    }
    const operation = {
      ...existing,
      phase: 'finalized',
      sourceBarrier: 'released',
      sourcePreimageRetained: false,
      sourceTombstone: true,
      finalizedAt: at,
      cleanupReceipt: Object.freeze({ ...cleanupReceipt }),
    };
    return {
      requests: document.data.requests,
      events: [],
      operationEvents: [operationEvent(operation)],
      handoffOperations: replaceHandoffOperation(handoffOperationsOf(document.data), operation),
      operation,
      replayed: false,
    };
  });
  return handoffReceipt(result.outcome.operation, result.publication, result.outcome.replayed === true);
}

function prepareTaskHandoff(input = {}, config, taskLedgerOptions) {
  const request = normalizeHandoffInput(input, config);
  assertRegisteredActor(request, config);
  taskLedgerOptionsFor(config, taskLedgerOptions, { requireReservation: false });
  const result = handoffTransact(config.options, request.now, (document, at, chain) => {
    const existing = operationById(document.data, request.operationId);
    if (existing) {
      assertHandoffOperationIdentity(request, existing);
      assertRegisteredActor(request, config, existing);
      taskLedgerOptionsFor(config, taskLedgerOptions, { operation: existing });
      handoffJournalEvent(existing, chain);
      assertHandoffTaskBindings(document.data, existing, chain);
      if (existing.phase !== 'finalized') {
        const authority = resolveHandoffAuthority(config, request, 'prepare-replay');
        if (!sameHandoffDestination(existing, authority)) {
          fail('T_LEDGER_HANDOFF_OPERATION_CONFLICT', `Removal operation ${request.operationId} was recorded for a different verified destination.`);
        }
      }
      return { requests: document.data.requests, events: [], operationEvents: [],
        handoffOperations: handoffOperationsOf(document.data), operation: existing, replayed: true };
    }
    const activeOptions = taskLedgerOptionsFor(config, taskLedgerOptions, {
      requireReservation: true,
      expectedOperationId: request.operationId,
    });
    const sourceOperation = handoffOperationsOf(document.data).find(operation => operation.sourceNodeId === request.sourceNodeId);
    if (sourceOperation) {
      if (sourceOperation.phase === 'finalized' || sourceOperation.sourceTombstone === true) {
        fail('T_LEDGER_HANDOFF_SOURCE_REMOVED', `The saved owner ${request.sourceNodeId} was already removed by ${sourceOperation.operationId}. A second removal operation cannot be created.`);
      }
      fail('T_LEDGER_HANDOFF_SOURCE_PENDING', `The saved owner ${request.sourceNodeId} already has pending removal operation ${sourceOperation.operationId}. Reconcile that operation before creating another.`);
    }
    const authority = resolveHandoffAuthority(config, request, 'prepare');
    assertReservationAuthority(activeOptions, request, authority);
    const tasks = handoffTasksOf(document.data, request.sourceNodeId);
    const taskIds = tasks.map(record => record.id);
    const operation = handoffOperationRecord({
      input: { ...request, actor: config.principal },
      authority,
      taskIds,
      taskSetDigest: handoffTaskDigest(tasks),
      at,
      phase: 'prepared',
      sourceBarrier: 'pending',
      sourceTombstone: false,
      reason: handoffReason(request, authority),
      taskLedgerOptions: activeOptions
    });
    return {
      requests: document.data.requests,
      events: [],
      operationEvents: [operationEvent(operation)],
      handoffOperations: replaceHandoffOperation(handoffOperationsOf(document.data), operation),
      operation,
      replayed: false
    };
  });
  return handoffReceipt(result.outcome.operation, result.publication, result.outcome.replayed === true);
}

function commitTaskHandoff(input = {}, config, taskLedgerOptions) {
  const request = normalizeHandoffInput(input, config);
  const result = handoffTransact(config.options, request.now, (document, at, chain) => {
    const existing = operationById(document.data, request.operationId);
    if (!existing) fail('T_LEDGER_HANDOFF_OPERATION_UNKNOWN', `Removal operation ${request.operationId} has no prepared source barrier. No task was changed.`);
    assertHandoffOperationIdentity(request, existing);
    assertRegisteredActor(request, config, existing);
    const activeOptions = taskLedgerOptionsFor(config, taskLedgerOptions, {
      operation: existing,
      requireReservation: existing.phase === 'prepared',
      expectedOperationId: existing.operationId,
    });
    if (existing.phase === 'committed' || existing.phase === 'finalized') {
      handoffJournalEvent(existing, chain);
      assertHandoffTaskBindings(document.data, existing, chain);
      return { requests: document.data.requests, events: [], operationEvents: [],
        handoffOperations: handoffOperationsOf(document.data), operation: existing, replayed: true };
    }
    if (existing.phase !== 'prepared') fail('T_LEDGER_HANDOFF_PHASE_INVALID', `Removal operation ${request.operationId} is not prepared. No task was changed.`);
    const postimageSha256 = assertHandoffPostimageSha256(request.postimageSha256);
    const authority = resolveHandoffAuthority(config, request, 'commit');
    assertReservationAuthority(activeOptions, request, authority);
    if (!sameHandoffDestination(existing, authority)) {
      fail('T_LEDGER_HANDOFF_OPERATION_CONFLICT', `Removal operation ${request.operationId} was recorded for a different verified destination.`);
    }
    const tasks = handoffTasksOf(document.data, request.sourceNodeId);
    const taskIds = tasks.map(record => record.id);
    const digest = handoffTaskDigest(tasks);
    if (digest !== existing.taskSetDigest || taskIds.length !== existing.taskCount
        || taskIds.some((id, index) => id !== existing.taskIds[index])) {
      fail('T_LEDGER_HANDOFF_TASK_SET_CONFLICT', `The active task set for ${request.sourceNodeId} changed after enumeration. The source barrier and tasks were retained.`);
    }
    const byId = new Map(document.data.requests.map((entry, index) => [entry.id, { entry, index }]));
    const requests = [...document.data.requests];
    const events = [];
    for (const record of tasks) {
      const found = byId.get(record.id);
      if (!found) fail('T_LEDGER_HANDOFF_TASK_SET_CONFLICT', `Task ${record.id} disappeared before the handoff transaction. The source was retained.`);
      const ownerState = authority.kind === 'verified-parent' ? 'reassigned' : 'owner-gone';
      const targetNodeId = authority.kind === 'verified-parent' ? authority.parentNodeId : null;
      const historyRow = { seq: 0, kind: HANDOFF_EVENT_KIND, at, actor: existing.actor,
        statusBefore: record.status, eventSha256: '', operationId: existing.operationId };
      const decision = {
        at, actor: existing.actor, decision: 'handoff', operationId: existing.operationId,
        reason: existing.reason, fromNodeId: existing.sourceNodeId,
        toNodeId: targetNodeId, ownerState
      };
      const next = {
        ...found.entry,
        scope: record.scope,
        scopeKey: targetNodeId || record.scopeKey,
        ...(record.scope === 'thread' ? { threadId: targetNodeId || record.threadId } : {}),
        ...(authority.parentLabel ? { scopeLabel: authority.parentLabel } : {}),
        ownerState,
        ownerNodeId: targetNodeId,
        decisions: [...record.decisions, decision],
        history: [...record.history, historyRow]
      };
      requests[found.index] = next;
      events.push({ kind: HANDOFF_EVENT_KIND, actor: existing.actor, record: next, historyRow,
        operation: { type: 'task-handoff', operationId: existing.operationId, ownerState, fromNodeId: existing.sourceNodeId, toNodeId: targetNodeId } });
    }
    const operation = {
      ...existing,
      destination: handoffDestination(authority),
      phase: 'committed',
      sourceBarrier: 'retained',
      sourcePreimageRetained: true,
      committedAt: at,
      postimageSha256,
      coordinatorIdentity: activeOptions.identity,
      reservationBinding: reservationBindingOf(activeOptions.reservation),
      ...(authority.topologyRevision ? { topologyRevision: authority.topologyRevision } : {})
    };
    return {
      requests,
      events,
      operationEvents: [operationEvent(operation)],
      handoffOperations: replaceHandoffOperation(handoffOperationsOf(document.data), operation),
      operation,
      replayed: false
    };
  });
  return handoffReceipt(result.outcome.operation, result.publication, result.outcome.replayed === true);
}

function verifyHandoffTopology(config, request, operation) {
  if (typeof config.verifyTopologyReceipt !== 'function') {
    fail('T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED', 'The native saved-tree writer did not provide a topology receipt. The source barrier remains active.');
  }
  let receipt;
  try {
    receipt = config.verifyTopologyReceipt(Object.freeze({
      operationId: operation.operationId,
      sourceNodeId: operation.sourceNodeId,
      operation,
      topologyReceipt: request.topologyReceipt
    }));
  } catch (error) {
    fail(error?.code || 'T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED', error?.message || 'The saved-tree removal receipt could not be verified. The source barrier remains active.');
  }
  if (!plain(receipt) || typeof receipt.then === 'function' || receipt.durable !== true
      || receipt.operationId !== operation.operationId
      || receipt.sourceNodeId !== operation.sourceNodeId) {
    fail('T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED', 'The saved-tree removal receipt was absent, uncertain or for a different operation. The source barrier remains active.');
  }
  return Object.freeze({
    durable: true,
    operationId: operation.operationId,
    sourceNodeId: operation.sourceNodeId,
    ...(receipt.topologyRevision !== undefined ? { topologyRevision: String(receipt.topologyRevision) } : {})
  });
}

function finalizeTaskHandoff(input = {}, config, taskLedgerOptions) {
  const request = normalizeHandoffInput(input, config);
  const result = handoffTransact(config.options, request.now, (document, at, chain) => {
    const existing = operationById(document.data, request.operationId);
    if (!existing) fail('T_LEDGER_HANDOFF_OPERATION_UNKNOWN', `Removal operation ${request.operationId} has no committed task handoff. The source was retained.`);
    assertHandoffOperationIdentity(request, existing);
    assertRegisteredActor(request, config, existing);
    const activeOptions = taskLedgerOptionsFor(config, taskLedgerOptions, {
      operation: existing,
      requireReservation: existing.phase === 'committed',
      expectedOperationId: existing.operationId,
    });
    handoffJournalEvent(existing, chain);
    assertHandoffTaskBindings(document.data, existing, chain);
    if (existing.phase === 'finalized') {
      return { requests: document.data.requests, events: [], operationEvents: [],
        handoffOperations: handoffOperationsOf(document.data), operation: existing, replayed: true };
    }
    if (existing.phase !== 'committed') fail('T_LEDGER_HANDOFF_PHASE_INVALID', `Removal operation ${request.operationId} is not committed. The source barrier remains active.`);
    if (activeOptions.reservation) assertReservationAuthority(activeOptions, request, {
      sourceNodeId: existing.sourceNodeId,
      parentNodeId: existing.destination?.parentNodeId ?? null,
      parentTreeId: existing.destination?.parentTreeId ?? null,
      topologyToken: existing.topologyToken,
      sourcePreimage: existing.sourcePreimage,
    });
    const topologyReceipt = verifyHandoffTopology(config, request, existing);
    const operation = {
      ...existing,
      phase: 'finalized',
      sourceBarrier: 'released',
      sourcePreimageRetained: false,
      sourceTombstone: true,
      finalizedAt: at,
      topologyReceipt
    };
    return {
      requests: document.data.requests,
      events: [],
      operationEvents: [operationEvent(operation)],
      handoffOperations: replaceHandoffOperation(handoffOperationsOf(document.data), operation),
      operation,
      replayed: false
    };
  });
  return handoffReceipt(result.outcome.operation, result.publication, result.outcome.replayed === true);
}

function readTaskHandoff({ operationId } = {}, options = {}, config = null, taskLedgerOptions) {
  const id = assertHandoffOperationId(operationId);
  const { historyFile } = filesFor(options);
  const document = readDocument(filesFor(options).ledgerFile);
  const operation = operationById(document.data, id);
  // Resolve the durable operation before checking a supplied capability.  A
  // consumed lease is valid for this read replay, but the guard needs the
  // operation's binding to distinguish that from a second topology write.
  if (config) taskLedgerOptionsFor(config, taskLedgerOptions, { operation: operation || null, requireReservation: false });
  if (!operation) return null;
  const chain = readChain(historyFile);
  if (chain.broken) fail('T_LEDGER_HANDOFF_RECEIPT_UNAVAILABLE', 'The handoff history is unreadable; no phase is inferred from the saved operation.');
  handoffJournalEvent(operation, chain);
  assertHandoffTaskBindings(document.data, operation, chain);
  return handoffReceipt(operation, { durable: true, revision: document.data.revision,
    history: { sequence: chain.events.length, head: chain.head } }, false);
}

/* Does an agent's filing wait for the person? Read from the person's settings
   through the one module that reads that row; injectable for tests. */
function agentFiledNeedsApproval({ settings, needsApproval } = {}) {
  if (typeof needsApproval === 'boolean') return needsApproval;
  const gate = require('./r-ledger-agent-gate');
  if (settings !== undefined) return gate.agentFiledNeedsApprovalOf(settings);
  return gate.loadAgentFilingMode().needsApproval === true;
}

/* A refinement files under a parent that is still live: active, or waiting for
   the person. Nothing files under a row that is done, could not be done as
   asked, declined or removed. */
function requireParent(records, parentId, scope, key) {
  if (!isRequestId(parentId, { family: 'R' })) fail('R_LEDGER_PARENT_INVALID', 'the parent must be a request id like R12 or R12.1.');
  const parent = records.find(record => record.id === parentId);
  if (!parent || !(ACTIVE_STATUSES.has(parent.status) || parent.status === 'proposed')) fail('R_LEDGER_PARENT_UNKNOWN', `${parentId} is not standing, so nothing can be filed under it.`);
  if (!inLayer(parent, scope, key)) fail('R_LEDGER_PARENT_INVALID', 'the parent must stand in this same layer.');
  return parent;
}

/* The next child number under a parent, over the file and the chain both, so
   a child spliced out by hand is never reissued either. */
function childId(records, parent, chain) {
  const prefix = `${parent.id}.`;
  const ids = new Set([...records.map(record => record.id), ...chainedIds(chain)]);
  let highest = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const tail = id.slice(prefix.length);
    if (tail.includes('.')) continue;
    const segment = Number(tail);
    if (Number.isSafeInteger(segment) && segment > highest) highest = segment;
  }
  return `${parent.id}.${highest + 1}`;
}

/**
 * File one request. The person's words land 'open' at once; an agent's land
 * 'open' or, when the person asked to approve agent filings first (or the
 * agent only proposed), 'proposed'.
 */
function fileRequest({ scope, key, words, filedBy, parentId = null, scopeLabel = null, source = null, proposed = false, why = null, now } = {}, options = {}) {
  assertScope(scope);
  const layerKey = assertKey(scope, key, { strict: true });
  const text = normalizeWords(words);
  const who = normalizeFiledBy(filedBy);
  const label = normalizeLabel(scopeLabel);
  const note = normalizeReason(why);
  const byPerson = who === PERSON;
  const waits = !byPerson && (proposed === true || agentFiledNeedsApproval(options));
  const result = transact(options, now, (document, at, chain) => {
    const records = document.data.requests.filter(isStoreRecordId).map(normalizeRecord);
    const parent = parentId === undefined || parentId === null ? null : requireParent(records, parentId, scope, layerKey);
    const id = parent ? childId(records, parent, chain) : `R${highestRootNumber(records, chain) + 1}`;
    const status = byPerson ? 'open' : (waits ? 'proposed' : 'open');
    const citation = typeof source === 'string' && source.trim().length >= 8
      ? source.trim().slice(0, 400)
      : (byPerson ? 'typed by the person in the ToolsEnabled app' : `filed by agent ${who} from the person's words`);
    const provenance = normalizeProvenance({
      class: byPerson ? 'owner-stated' : 'agent-inferred',
      recordedBy: who,
      recordedAt: at,
      source: citation,
      ...(note ? { note } : {})
    });
    const historyRow = { seq: 0, kind: 'file', at, actor: who, eventSha256: '' };
    const record = {
      id,
      kind: 'R',
      parentId: parent ? parent.id : null,
      scope,
      scopeKey: layerKey,
      scopeLabel: label,
      threadId: scope === 'thread' ? layerKey : null,
      verbatim: text,
      request: `(interpretation) ${text.slice(0, 4000)}`,
      status,
      filedBy: who,
      filedAt: at,
      gates: [],
      provenance,
      captureLog: [{ at, actor: who, mode: 'new', gatesAdded: 0, source: citation }],
      decisions: [],
      history: [historyRow],
      removedAt: null,
      removedBy: null
    };
    return { requests: [...document.data.requests, record], events: [{ kind: 'file', actor: who, record, historyRow }], record };
  });
  const record = result.outcome.record;
  return Object.freeze({
    id: record.id,
    parentId: record.parentId,
    scope,
    key: layerKey,
    path: result.ledgerFile,
    stamp: record.filedAt,
    filedBy: who,
    words: text,
    status: record.status,
    awaitingApproval: record.status === 'proposed',
    revision: result.revision
  });
}

function locateForRewrite(document, id) {
  const index = document.data.requests.findIndex(entry => plain(entry) && entry.id === id);
  if (index === -1) fail('R_LEDGER_ENTRY_UNKNOWN', `${id} is not in the ledger (deleted, or never filed).`);
  const entry = document.data.requests[index];
  const record = normalizeRecord(entry);
  if (isReset(record)) fail('R_LEDGER_ENTRY_RESET', `${id} was cleared from this Ledger category and cannot be changed.`);
  return { index, entry, record };
}

function assignmentAuthorityFor(options) {
  const authority = plain(options?.taskLedgerOptions)
    ? options.taskLedgerOptions.assignmentAuthority
    : null;
  if (!plain(authority)
      || typeof authority.resolveAssignmentAuthority !== 'function'
      || typeof authority.assertCurrent !== 'function'
      || typeof authority.readSettings !== 'function') {
    fail('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', 'The authenticated task assignment authority is unavailable. No task was changed.');
  }
  return authority;
}

function assignmentIdentity(value) {
  return typeof value === 'string' && SAFE_KEY.test(value);
}

function assignmentThreadIdentity(value) {
  return value === null || (typeof value === 'string' && THREAD_ID_RE.test(value));
}

function normalizeAssignmentAuthority(value, { taskId, nodeId, assignmentId }) {
  const scope = value?.target?.scope;
  if (!plain(value) || typeof value.then === 'function'
      || value.taskId !== taskId || value.assignmentId !== assignmentId
      || typeof value.targetAgentId !== 'string' || !SAFE_KEY.test(value.targetAgentId)
      || value.targetAgentId !== nodeId
      || !plain(value.target)
      || !['nodeId', 'scope', 'scopeKey', 'sessionId', 'treeId', 'threadId'].every(key => Object.hasOwn(value.target, key))
      || value.target.nodeId !== value.targetAgentId
      || !['tree', 'thread'].includes(value.target.scope)
      || typeof value.target.scopeKey !== 'string'
      || !SAFE_KEY.test(value.target.scopeKey)
      || value.target.scopeKey !== value.target.nodeId
      || !assignmentIdentity(value.target.sessionId)
      || !assignmentIdentity(value.target.treeId)
      || !assignmentThreadIdentity(value.target.threadId)
      || !plain(value.locality)
      || value.locality.sameHost !== true
      || value.locality.sameTree !== true
      || !plain(value.targetConfiguration)
      || !Number.isSafeInteger(value.authorityRevision) || value.authorityRevision < 0
      || !plain(value.authorityReceipt)
      || typeof value.assertCurrent !== 'function') {
    fail('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', 'The authenticated task target or authority receipt is incomplete or ambiguous. No task was changed.');
  }
  return Object.freeze({
    taskId: value.taskId,
    assignmentId: value.assignmentId,
    targetAgentId: value.targetAgentId,
    target: Object.freeze({ ...value.target }),
    locality: Object.freeze({ ...value.locality }),
    targetConfiguration: Object.freeze({ ...value.targetConfiguration }),
    authorityRevision: value.authorityRevision,
    authorityReceipt: Object.freeze({ ...value.authorityReceipt }),
    assertCurrent: value.assertCurrent,
  });
}

function assertAssignmentAuthorityCurrent(assertCurrent) {
  let result;
  try {
    result = assertCurrent();
  } catch (error) {
    fail(error?.code || 'T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', error?.message || 'The authenticated task assignment authority could not be confirmed. No task was changed.');
  }
  if (result === false || (result && typeof result.then === 'function')) {
    fail('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', 'The authenticated task assignment authority could not be confirmed synchronously. No task was changed.');
  }
}

function assignmentSourceBindingFor(data, taskId) {
  const matches = [];
  for (const operation of handoffOperationsOf(data)) {
    if (!plain(operation) || operation.phase === 'finalized') continue;
    const listed = Array.isArray(operation.taskIds) && operation.taskIds.includes(taskId);
    const bound = Array.isArray(operation.taskBindings)
      && operation.taskBindings.some(binding => plain(binding) && binding.taskId === taskId);
    if (Array.isArray(operation.taskIds) && Array.isArray(operation.taskBindings) && listed !== bound) {
      fail('T_LEDGER_HANDOFF_SOURCE_PENDING', `Task ${taskId} has an ambiguous retained handoff binding. No assignment was written.`);
    }
    if (listed || bound) matches.push(operation);
  }
  if (matches.length > 1) {
    fail('T_LEDGER_HANDOFF_SOURCE_PENDING', `Task ${taskId} belongs to more than one unfinished retained handoff. No assignment was written.`);
  }
  return matches[0] || null;
}

function assertTaskAssignmentSourceAvailable(data, taskId) {
  const operation = assignmentSourceBindingFor(data, taskId);
  if (!operation) return;
  if (operation.sourceTombstone === true) {
    fail('T_LEDGER_HANDOFF_SOURCE_REMOVED', `Task ${taskId} belongs to a retained handoff whose source was removed. Re-establish a verified owner before assigning it.`);
  }
  fail('T_LEDGER_HANDOFF_SOURCE_PENDING', `Task ${taskId} belongs to unfinished retained handoff ${operation.operationId}. No assignment was written until that source is reconciled.`);
}

function assignmentAuthorityReceiptIdentity(receipt) {
  if (!plain(receipt)) return null;
  const stable = { ...receipt };
  for (const key of ['at', 'recordedAt', 'now', 'expiresAt']) delete stable[key];
  return canonical(stable);
}

function assignmentSourceFor(record) {
  return {
    scope: record.scope,
    scopeKey: record.scopeKey,
    ownerNodeId: record.ownerNodeId ?? null,
    coreSha256: coreSha256(record),
  };
}

function assertAssignmentSourceJournal(record, chain) {
  const latest = lastCoreByRequest(chain.events).get(record.id);
  const latestHistory = record.history.at(-1);
  if (!latest
      || latest.requestId !== record.id
      || latest.coreSha256 !== coreSha256(record)
      || !latestHistory
      || latestHistory.seq !== latest.seq
      || latestHistory.eventSha256 !== latest.eventSha256) {
    fail('T_LEDGER_ASSIGNMENT_SOURCE_UNCONFIRMED', 'The task source changed without a matching authenticated journal event. No assignment was written.');
  }
}

function assignmentReplayContextFor(record, existing, chain) {
  const operation = existing?.operation;
  const targetAgentId = existing?.targetAgentId || existing?.nodeId;
  const source = operation?.source;
  const latestAssignment = record.decisions
    .filter(decision => plain(decision) && decision.decision === 'assign')
    .at(-1);
  const historyBinding = record.history.find(row => plain(row)
    && row.kind === 'resolve'
    && plain(row.operation)
    && row.operation.taskId === record.id
    && row.operation.assignmentId === existing?.assignmentId);
  const resolveEvent = Array.isArray(chain?.events)
    ? chain.events.find(event => event.seq === historyBinding?.seq
      && event.eventSha256 === historyBinding?.eventSha256
      && event.requestId === record.id
      && event.kind === 'resolve'
      && plain(event.operation)
      && canonical(event.operation) === canonical(operation))
    : null;
  const sourceEvent = resolveEvent && Array.isArray(chain.events)
    ? chain.events
      .filter(event => event.requestId === record.id
        && event.seq < resolveEvent.seq
        && event.kind !== 'drift-observed')
      .at(-1)
    : null;
  if (!plain(existing) || !plain(operation)
      || operation.type !== 'task-assignment'
      || operation.taskId !== record.id
      || operation.assignmentId !== existing.assignmentId
      || !plain(source)
      || !plain(existing.source)
      || canonical(operation.source) !== canonical(existing.source)
      || operation.targetAgentId !== targetAgentId
      || canonical(operation.target) !== canonical(existing.target)
      || canonical(operation.locality) !== canonical(existing.locality)
      || canonical(operation.targetConfiguration) !== canonical(existing.targetConfiguration)
      || operation.authorityRevision !== existing.authorityRevision
      || assignmentAuthorityReceiptIdentity(operation.authorityReceipt)
        !== assignmentAuthorityReceiptIdentity(existing.authorityReceipt)
      || !/^[a-f0-9]{64}$/.test(source.coreSha256 || '')
      || !['global', 'session', 'tree', 'thread'].includes(source.scope)
      || (source.scope === 'global' ? source.scopeKey !== null : !assignmentThreadIdentity(source.scopeKey))
      || (source.ownerNodeId !== null && !assignmentIdentity(source.ownerNodeId))
      || !historyBinding
      || !Number.isSafeInteger(historyBinding.seq) || historyBinding.seq < 1
      || !/^[a-f0-9]{64}$/.test(historyBinding.eventSha256 || '')
      || canonical(historyBinding.operation) !== canonical(operation)
      || !resolveEvent
      || !sourceEvent
      || sourceEvent.coreSha256 !== source.coreSha256
      || latestAssignment !== existing
      || record.ownerState !== 'assigned'
      || record.ownerNodeId !== targetAgentId
      || record.scope !== existing.target?.scope
      || record.scopeKey !== existing.target?.scopeKey
      || (record.scope === 'thread'
        ? record.threadId !== existing.target?.scopeKey
        : record.threadId !== null)
      || typeof existing.assignmentId !== 'string'
      || record.id !== existing.operation.taskId) {
    fail('T_LEDGER_ASSIGNMENT_EVENT_CONFLICT', 'The saved assignment source or target binding is incomplete or conflicting. No task was changed.');
  }
  const persisted = normalizeAssignmentAuthority({
    taskId: record.id,
    assignmentId: existing.assignmentId,
    targetAgentId,
    target: existing.target,
    locality: existing.locality,
    targetConfiguration: existing.targetConfiguration,
    authorityRevision: existing.authorityRevision,
    authorityReceipt: existing.authorityReceipt,
    assertCurrent: () => {},
  }, { taskId: record.id, nodeId: targetAgentId, assignmentId: existing.assignmentId });
  return Object.freeze({
    kind: 'task-assignment-replay',
    taskId: record.id,
    assignmentId: existing.assignmentId,
    source: Object.freeze(source),
    targetAgentId: persisted.targetAgentId,
    target: persisted.target,
    locality: persisted.locality,
    targetConfiguration: persisted.targetConfiguration,
    authorityRevision: persisted.authorityRevision,
    authorityReceipt: persisted.authorityReceipt,
    actor: existing.actor,
    reason: existing.reason,
  });
}

function assignmentIdUses(data, assignmentId) {
  const uses = [];
  for (const entry of data.requests) {
    if (!plain(entry) || recordKindOf(entry) !== 'T' || !Array.isArray(entry.decisions)) continue;
    for (const decision of entry.decisions) {
      if (plain(decision) && decision.decision === 'assign' && decision.assignmentId === assignmentId) {
        uses.push({ taskId: entry.id, decision });
      }
    }
  }
  return uses;
}

function assignmentDecisionMatches(existing, { actor, reason, resolved }) {
  return existing.actor === actor
    && existing.reason === reason
    && existing.nodeId === resolved.targetAgentId
    && existing.authorityRevision === resolved.authorityRevision
    && canonical(existing.target) === canonical(resolved.target)
    && canonical(existing.locality) === canonical(resolved.locality)
    && canonical(existing.targetConfiguration) === canonical(resolved.targetConfiguration)
    && assignmentAuthorityReceiptIdentity(existing.authorityReceipt)
      === assignmentAuthorityReceiptIdentity(resolved.authorityReceipt);
}

function assignmentOperationFor({ id, assignmentId, record, resolved, difficultyPlan }) {
  return {
    type: 'task-assignment',
    taskId: id,
    assignmentId,
    source: assignmentSourceFor(record),
    fromNodeId: record.ownerNodeId || record.scopeKey || null,
    fromScope: record.scope,
    fromScopeKey: record.scopeKey,
    fromOwnerNodeId: record.ownerNodeId,
    toNodeId: resolved.targetAgentId,
    toScope: resolved.target.scope,
    toScopeKey: resolved.target.scopeKey,
    toOwnerNodeId: resolved.targetAgentId,
    ownerState: 'assigned',
    nodeId: resolved.targetAgentId,
    targetAgentId: resolved.targetAgentId,
    target: resolved.target,
    locality: resolved.locality,
    targetConfiguration: resolved.targetConfiguration,
    authorityRevision: resolved.authorityRevision,
    authorityReceipt: resolved.authorityReceipt,
    difficultyPlan,
    ...(difficultyPlan.requiredStrength ? { requiredStrength: difficultyPlan.requiredStrength } : {}),
    ...(difficultyPlan.requiredEffort ? { requiredEffort: difficultyPlan.requiredEffort } : {}),
  };
}

function assignmentReceiptFor(decision, revision, replayed) {
  return Object.freeze({
    type: 'task-assignment',
    taskId: decision.operation?.taskId || null,
    assignmentId: decision.assignmentId,
    targetAgentId: decision.nodeId,
    target: decision.target,
    locality: decision.locality,
    targetConfiguration: decision.targetConfiguration,
    authorityRevision: decision.authorityRevision,
    authorityReceipt: decision.authorityReceipt,
    revision,
    recordedAt: decision.at,
    durable: true,
    replayed,
  });
}

/** Assign a progressed task through a host-bound target authority. */
function assignTask({ id, nodeId, assignmentId, reason, actor, now } = {}, options = {}) {
  assertKindId('T', id);
  if (typeof nodeId !== 'string' || !SAFE_KEY.test(nodeId)) {
    fail('T_LEDGER_ASSIGNMENT_TARGET_INVALID', 'A task assignment needs a bounded target node identity. No task was changed.');
  }
  if (typeof assignmentId !== 'string' || !HANDOFF_OPERATION_ID.test(assignmentId)) {
    fail('T_LEDGER_ASSIGNMENT_ID_INVALID', 'A task assignment needs a stable bounded assignment id. No task was changed.');
  }
  const text = normalizeReason(reason);
  if (!text) fail('T_LEDGER_ASSIGNMENT_REASON_INVALID', 'A task assignment needs a concrete reason. No task was changed.');
  const who = normalizeFiledBy(actor);
  const authority = assignmentAuthorityFor(options);
  const result = transact(options, now, (document, at, chain) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!['open', 'in-progress', 'blocked-external'].includes(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only an open or progressed task can be assigned.`);
    }
    assertTaskAssignmentSourceAvailable(document.data, id);
    const uses = assignmentIdUses(document.data, assignmentId);
    if (uses.some(use => use.taskId !== id)) {
      fail('T_LEDGER_ASSIGNMENT_EVENT_CONFLICT', `Assignment id ${assignmentId} is already bound to another task. No assignment was written.`);
    }
    const existing = uses.filter(use => use.taskId === id).map(use => use.decision);
    if (existing.length > 1) fail('T_LEDGER_ASSIGNMENT_EVENT_CONFLICT', 'This assignment id appears more than once in the saved task.');
    const assignmentReplayContext = existing.length === 1
      ? assignmentReplayContextFor(record, existing[0], chain)
      : null;
    if (existing.length === 0) assertAssignmentSourceJournal(record, chain);
    if (existing.length === 1) {
      const persistedTargetAgentId = existing[0].targetAgentId || existing[0].nodeId;
      if (persistedTargetAgentId !== nodeId
          || existing[0].actor !== who
          || existing[0].reason !== text) {
        fail('T_LEDGER_ASSIGNMENT_EVENT_CONFLICT', 'This assignment id already has a different task actor, target or reason.');
      }
    }
    assertAssignmentAuthorityCurrent(authority.assertCurrent);
    let raw;
    try {
      raw = authority.resolveAssignmentAuthority(Object.freeze({
        task: record,
        nodeId,
        assignmentId,
        ...(assignmentReplayContext ? { assignmentReplayContext } : {}),
      }));
    } catch (error) {
      fail(error?.code || 'T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', error?.message || 'The authenticated task target could not be resolved. No task was changed.');
    }
    const resolved = normalizeAssignmentAuthority(raw, { taskId: id, nodeId, assignmentId });
    assertAssignmentAuthorityCurrent(resolved.assertCurrent);
    if (existing.length === 1) {
      if (!assignmentDecisionMatches(existing[0], { actor: who, reason: text, resolved })) {
        fail('T_LEDGER_ASSIGNMENT_EVENT_CONFLICT', 'This assignment id already has a different target, authority or reason.');
      }
      return { requests: document.data.requests, events: [], record: entry, decision: existing[0], replayed: true };
    }
    const gradingEnabled = taskDifficultyEnabled({ ...options, loadSettings: authority.readSettings });
    const difficultyPlan = resolveTaskAssignment(record, resolved.targetConfiguration, {
      gradingEnabled,
      tiers: authority.tiers,
      resolveModelChoice: authority.resolveModelChoice,
    });
    assertAssignmentAuthorityCurrent(resolved.assertCurrent);
    const operation = assignmentOperationFor({ id, assignmentId, record, resolved, difficultyPlan });
    const decision = {
      at,
      actor: who,
      decision: 'assign',
      assignmentId,
      reason: text,
      source: assignmentSourceFor(record),
      fromNodeId: record.ownerNodeId || record.scopeKey || null,
      fromScope: record.scope,
      fromScopeKey: record.scopeKey,
      toNodeId: resolved.targetAgentId,
      toScope: resolved.target.scope,
      toScopeKey: resolved.target.scopeKey,
      ownerState: 'assigned',
      nodeId: resolved.targetAgentId,
      targetAgentId: resolved.targetAgentId,
      target: resolved.target,
      locality: resolved.locality,
      targetConfiguration: resolved.targetConfiguration,
      authorityRevision: resolved.authorityRevision,
      authorityReceipt: resolved.authorityReceipt,
      difficultyPlan,
      operation,
    };
    const historyRow = { seq: 0, kind: 'resolve', at, actor: who, statusBefore: record.status, eventSha256: '', operation };
    const next = {
      ...entry,
      scope: resolved.target.scope,
      scopeKey: resolved.target.scopeKey,
      ...(resolved.target.scope === 'thread' ? { threadId: resolved.target.scopeKey } : { threadId: null }),
      ownerState: 'assigned',
      ownerNodeId: resolved.targetAgentId,
      decisions: [...record.decisions, decision],
      history: [...record.history, historyRow],
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'resolve', actor: who, record: next, historyRow, operation }], record: next, decision, replayed: false };
  }, true);
  const saved = result.outcome;
  if (!saved?.decision || saved.decision.decision !== 'assign'
      || saved.decision.assignmentId !== assignmentId) {
    fail('T_LEDGER_ASSIGNMENT_RESULT_UNAVAILABLE', 'The saved task assignment result could not be confirmed.');
  }
  const replayed = saved.replayed === true;
  return Object.freeze({
    assigned: true,
    id,
    assignmentId,
    replayed,
    revision: result.revision,
    recordedAt: saved.decision.at,
    receipt: assignmentReceiptFor(saved.decision, result.revision, replayed),
    targetAgentId: saved.decision.targetAgentId || saved.decision.nodeId,
    target: saved.decision.target,
    locality: saved.decision.locality,
    targetConfiguration: saved.decision.targetConfiguration,
    difficultyPlan: saved.decision.difficultyPlan,
    difficulty: saved.decision.difficultyPlan?.difficulty || null,
  });
}

/** The person rewrites the words of one request; the words before stay in its history. */
function editRequest({ id, words, actor, now } = {}, options = {}) {
  assertPerson(actor);
  assertId(id);
  const text = normalizeWords(words);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (HIDDEN_STATUSES.has(record.status)) fail('R_LEDGER_ENTRY_UNKNOWN', `${id} was ${record.status}; it can no longer be edited.`);
    const historyRow = { seq: 0, kind: 'edit', at, actor: PERSON, wordsBefore: record.verbatim, eventSha256: '' };
    const next = {
      ...entry,
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || PERSON,
      verbatim: text,
      request: `(interpretation) ${text.slice(0, 4000)}`,
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'edit', actor: PERSON, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, scope: record.scope, key: record.scopeKey, path: result.ledgerFile, words: text, backup: `${result.ledgerFile}.bak`, revision: result.revision });
}

/** The person deletes one request and every refinement under it; all stay on file as 'removed'. */
function removeRequest({ id, actor, now } = {}, options = {}) {
  assertPerson(actor);
  assertId(id);
  const result = transact(options, now, (document, at) => {
    const { record } = locateForRewrite(document, id);
    if (record.status === 'removed') fail('R_LEDGER_ENTRY_UNKNOWN', `${id} was already deleted.`);
    const requests = [...document.data.requests];
    const events = [];
    const removed = [];
    for (let index = 0; index < requests.length; index += 1) {
      const entry = requests[index];
      if (!plain(entry) || typeof entry.id !== 'string') continue;
      if (entry.id !== id && !entry.id.startsWith(`${id}.`)) continue;
      const current = normalizeRecord(entry);
      if (current.status === 'removed') continue;
      const historyRow = { seq: 0, kind: 'remove', at, actor: PERSON, statusBefore: current.status, eventSha256: '' };
      const next = {
        ...entry,
        scope: current.scope,
        scopeKey: current.scopeKey,
        parentId: current.parentId,
        filedBy: current.filedBy || PERSON,
        status: 'removed',
        removedAt: at,
        removedBy: PERSON,
        history: [...current.history, historyRow]
      };
      requests[index] = next;
      events.push({ kind: 'remove', actor: PERSON, record: next, historyRow });
      removed.push(next.id);
    }
    return { requests, events, record, removed };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, scope: record.scope, key: record.scopeKey, path: result.ledgerFile, removed: Object.freeze(result.outcome.removed), backup: `${result.ledgerFile}.bak`, revision: result.revision });
}

/** The person approves or declines one request. Approve: proposed -> open; decline: any live status -> declined. */
function decide({ id, decision, reason, actor, now } = {}, options = {}) {
  assertPerson(actor);
  assertId(id);
  if (decision !== 'approve' && decision !== 'decline') fail('R_LEDGER_DECISION_INVALID', 'the decision must be approve or decline.');
  const text = normalizeReason(reason);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    const allowed = decision === 'approve' ? APPROVABLE_STATUSES : DECLINABLE_STATUSES;
    if (!allowed.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; it cannot be ${decision === 'approve' ? 'approved' : 'declined'} now.`);
    }
    const statusAfter = decision === 'approve' ? (record.status === 'proposed' ? 'open' : record.status) : 'declined';
    const historyRow = { seq: 0, kind: decision, at, actor: PERSON, statusBefore: record.status, eventSha256: '' };
    const provenance = decision === 'approve' && record.status === 'proposed'
      ? normalizeProvenance({ class: 'owner-stated', recordedBy: PERSON, recordedAt: at, source: 'approved by the person on the Ledger page' })
      : (record.provenance || null);
    const next = {
      ...entry,
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || PERSON,
      status: statusAfter,
      ...(provenance ? { provenance } : {}),
      decisions: [...record.decisions, { at, actor: PERSON, decision, reason: text }],
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: decision, actor: PERSON, record: next, historyRow }], record: next };
  });
  return Object.freeze({ id, status: result.outcome.record.status, revision: result.revision, recordedAt: result.at });
}

/* MOVE A STANDING REQUEST TO A RESOLUTION STATUS.
 *
 * The permission model is decide()'s and is NOT widened: assertPerson refuses
 * every non-owner here exactly as it does there, so an agent that finishes a
 * request still cannot mark it done -- it reports, and the person resolves.
 * What changes is only that the person now HAS a verb for it; before this
 * there was none, for anyone.
 *
 * Only a standing request can be resolved: ACTIVE_STATUSES in, RESOLUTION
 * out. A resolved row is not in ACTIVE_STATUSES, so collectStack drops it from
 * the boot stack on the next read without any change to the readers -- it
 * stops being read to every session as a live rule, and stays in the ledger
 * for the record. No audit call is made here, deliberately, exactly as
 * everywhere else in this file.
 */
function resolve({ id, status, reason, actor, now } = {}, options = {}) {
  assertPerson(actor);
  assertId(id);
  if (!RESOLUTION_STATUSES.has(status)) {
    fail('R_LEDGER_STATUS_INVALID', `${status || 'that'} is not a status this can set; use one of ${[...RESOLUTION_STATUSES].join(', ')}.`);
  }
  const text = normalizeReason(reason);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!ACTIVE_STATUSES.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only a standing request can be resolved.`);
    }
    /* The row carries the SAME FIELD SET decide() writes. An extra field here
       breaks the chain: the writer hashes the event as given and the reader
       re-derives it from the shape it expects, so a row with more in it than
       decide's verifies as an in-place edit at that line. Measured. The status
       it moved TO is on the record itself, and the reason rides in `decisions`
       exactly as decide's does. */
    const historyRow = { seq: 0, kind: 'resolve', at, actor: PERSON, statusBefore: record.status, eventSha256: '' };
    const next = {
      ...entry,
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || PERSON,
      status,
      ...(record.provenance ? { provenance: record.provenance } : {}),
      decisions: [...record.decisions, { at, actor: PERSON, decision: 'resolve', status, reason: text }],
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'resolve', actor: PERSON, record: next, historyRow }], record: next };
  });
  return Object.freeze({ id, status: result.outcome.record.status, revision: result.revision, recordedAt: result.at });
}

// ---------------------------------------------------------------------------
// T, A, P writes -- flat families that agents may write, within the limits
// set out below (see "Kinds" near the top of this file for what each family
// holds). Every one of them runs through the SAME transact() the
// R writes use, so it gets the same lock, the same atomic write, and the
// same hash-chained history for free, unmodified. Scope works exactly like
// R's own (assertScope/assertKey, the same four tiers): T, A and P
// records carry scope exactly as R records do. File/complete/remove are
// agent-usable for T; answer/decline (A) and decide (P) are ALSO
// agent-usable, per the product rule that asks and purchases are
// agent-closable -- but removeAsk and removePurchase stay owner-only
// (assertPerson below, same gate R's own edit/remove/decide/resolve use):
// the rule makes asks and purchases closable, not removable, and agent
// removal applies only to T.
// ---------------------------------------------------------------------------

/* One filed record, T/A/P alike: a per-kind flat id (never a dotted
   refinement, unlike R), the same scope handling fileRequest gives R, the
   kind's own starting status and whatever kind-specific fields the caller
   seeds (recurrence for T, answer:null for A, the purchase field for P). */
function fileMinor(kind, startStatus, extra, { scope, key, words, filedBy, scopeLabel = null, why = null, now } = {}, options = {}) {
  assertScope(scope);
  const layerKey = assertKey(scope, key, { strict: true });
  const text = normalizeWords(words);
  const who = normalizeFiledBy(filedBy);
  const label = normalizeLabel(scopeLabel);
  const note = normalizeReason(why);
  const byPerson = who === PERSON;
  const result = transact(options, now, (document, at, chain) => {
    if (kind === 'T') assertTaskSourceAvailable(document.data, scope, layerKey);
    const id = `${kind}${nextKindNumber(kind, document, chain)}`;
    const citation = byPerson ? 'typed by the person in the ToolsEnabled app' : `filed by agent ${who}`;
    const provenance = normalizeProvenance({
      class: byPerson ? 'owner-stated' : 'agent-inferred',
      recordedBy: who,
      recordedAt: at,
      source: citation,
      ...(note ? { note } : {})
    });
    const historyRow = { seq: 0, kind: 'file', at, actor: who, eventSha256: '' };
    const record = {
      id,
      kind,
      parentId: null,
      scope,
      scopeKey: layerKey,
      scopeLabel: label,
      threadId: scope === 'thread' ? layerKey : null,
      verbatim: text,
      request: `(interpretation) ${text.slice(0, 4000)}`,
      status: startStatus,
      filedBy: who,
      filedAt: at,
      gates: [],
      provenance,
      captureLog: [{ at, actor: who, mode: 'new', gatesAdded: 0, source: citation }],
      decisions: [],
      history: [historyRow],
      removedAt: null,
      removedBy: null,
      ...(typeof extra === 'function' ? extra() : extra)
    };
    return { requests: [...document.data.requests, record], events: [{ kind: 'file', actor: who, record, historyRow }], record };
  });
  const record = result.outcome.record;
  return Object.freeze({
    id: record.id,
    kind,
    scope,
    key: layerKey,
    status: record.status,
    filedBy: who,
    words: text,
    path: result.ledgerFile,
    stamp: record.filedAt,
    revision: result.revision,
    ...taskDifficultyFields(record)
  });
}

/** File one task. Any actor may; recurrence null lands 'open' (one-shot), an object lands 'recurring'.
    supersedes: an existing live (not done/removed/superseded) T id -- in the SAME transaction the new
    task is filed and the named one is rewritten to 'superseded' (supersededBy: <new id>), a hash-chained
    'supersede' event on the OLD record, terminal from then on (completeTask/removeTask both refuse it). */
function fileTask({ scope, key, words, filedBy, scopeLabel, why, now, difficulty, recurrence = null, supersedes = null } = {}, options = {}) {
  const normalizedRecurrence = plain(recurrence) ? { interval: recurrence.interval, completions: [] } : null;
  if (supersedes === null) {
    return fileMinor('T', normalizedRecurrence ? 'recurring' : 'open',
      () => ({ recurrence: normalizedRecurrence, completedAt: null, completedBy: null,
        ...newTaskDifficultyFields({ difficulty, enabled: taskDifficultyEnabled(options) }) }),
      { scope, key, words, filedBy, scopeLabel, why, now }, options);
  }
  // supersedes only ever names a task: a wrong-shaped or wrong-kind id (an R,
  // A or P id, or garbage) is refused here by the same typed code completeTask
  // and removeTask already use for an id that does not look like their kind.
  assertKindId('T', supersedes);
  assertScope(scope);
  const layerKey = assertKey(scope, key, { strict: true });
  const text = normalizeWords(words);
  const who = normalizeFiledBy(filedBy);
  const label = normalizeLabel(scopeLabel);
  const note = normalizeReason(why);
  const byPerson = who === PERSON;
  const startStatus = normalizedRecurrence ? 'recurring' : 'open';
  const result = transact(options, now, (document, at, chain) => {
    assertTaskSourceAvailable(document.data, scope, layerKey);
    const { index: oldIndex, entry: oldEntry, record: oldRecord } = locateForRewrite(document, supersedes);
    if (TASK_SUPERSEDE_BLOCKED_STATUSES.has(oldRecord.status)) {
      fail('R_LEDGER_SUPERSEDE_STATUS_INVALID', `${supersedes} is ${oldRecord.status}; only a live task (not done, removed or already superseded) can be superseded.`);
    }
    const id = `T${nextKindNumber('T', document, chain)}`;
    const citation = byPerson ? 'typed by the person in the ToolsEnabled app' : `filed by agent ${who}`;
    const provenance = normalizeProvenance({
      class: byPerson ? 'owner-stated' : 'agent-inferred',
      recordedBy: who,
      recordedAt: at,
      source: citation,
      ...(note ? { note } : {})
    });
    const newHistoryRow = { seq: 0, kind: 'file', at, actor: who, eventSha256: '' };
    const newRecord = {
      id,
      kind: 'T',
      parentId: null,
      scope,
      scopeKey: layerKey,
      scopeLabel: label,
      threadId: scope === 'thread' ? layerKey : null,
      verbatim: text,
      request: `(interpretation) ${text.slice(0, 4000)}`,
      status: startStatus,
      filedBy: who,
      filedAt: at,
      gates: [],
      provenance,
      captureLog: [{ at, actor: who, mode: 'new', gatesAdded: 0, source: citation }],
      decisions: [],
      history: [newHistoryRow],
      removedAt: null,
      removedBy: null,
      recurrence: normalizedRecurrence,
      completedAt: null,
      completedBy: null,
      supersedes,
      supersededBy: null,
      ...newTaskDifficultyFields({ difficulty, enabled: taskDifficultyEnabled(options) })
    };
    const oldHistoryRow = { seq: 0, kind: 'supersede', at, actor: who, statusBefore: oldRecord.status, eventSha256: '' };
    const nextOld = {
      ...oldEntry,
      kind: oldRecord.kind || 'T',
      scope: oldRecord.scope,
      scopeKey: oldRecord.scopeKey,
      parentId: oldRecord.parentId,
      filedBy: oldRecord.filedBy || who,
      status: 'superseded',
      supersededBy: id,
      history: [...oldRecord.history, oldHistoryRow]
    };
    const requests = [...document.data.requests];
    requests[oldIndex] = nextOld;
    requests.push(newRecord);
    return {
      requests,
      events: [
        { kind: 'file', actor: who, record: newRecord, historyRow: newHistoryRow },
        { kind: 'supersede', actor: who, record: nextOld, historyRow: oldHistoryRow }
      ],
      record: newRecord
    };
  });
  const record = result.outcome.record;
  return Object.freeze({
    id: record.id,
    kind: 'T',
    scope,
    key: layerKey,
    status: record.status,
    filedBy: who,
    words: text,
    path: result.ledgerFile,
    stamp: record.filedAt,
    supersedes,
    revision: result.revision,
    ...taskDifficultyFields(record)
  });
}

/** File one ask. Any actor may; it lands 'open', waiting for the owner to answer or decline it. */
function fileAsk({ scope, key, words, filedBy, scopeLabel, why, now } = {}, options = {}) {
  return fileMinor('A', 'open', { answer: null }, { scope, key, words, filedBy, scopeLabel, why, now }, options);
}

/** File one purchase. Any actor may; it lands 'proposed', waiting for the owner's decision. */
function filePurchase({ scope, key, words, filedBy, scopeLabel, why, now, purchase } = {}, options = {}) {
  const seed = plain(purchase) ? purchase : {};
  const purchaseField = {
    requestId: typeof seed.requestId === 'string' && seed.requestId ? seed.requestId : null,
    lines: Array.isArray(seed.lines) ? seed.lines : [],
    decision: null,
    recordedCharge: null
  };
  return fileMinor('P', 'proposed', { purchase: purchaseField }, { scope, key, words, filedBy, scopeLabel, why, now }, options);
}

/** Record a task checkpoint without completing or reviving terminal work. */
function progressTask(args = {}, options = {}) {
  const { id, status, reason, actor, now } = args;
  const hasWaitingFor = Object.prototype.hasOwnProperty.call(args, 'waitingFor');
  assertKindId('T', id);
  const who = normalizeFiledBy(actor);
  if (!['open', 'in-progress', 'blocked-external'].includes(status)) fail('R_LEDGER_STATUS_INVALID', 'Task progress must be open, in-progress or blocked-external.');
  const text = normalizeReason(reason);
  if (!text) fail('R_LEDGER_WORDS_INVALID', 'Task progress needs a concrete progress or blocker reason.');
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!['open', 'in-progress', 'blocked-external'].includes(record.status)) fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status}; terminal and recurring tasks cannot be rewritten as one-shot work.`);
    const normalizedWaitingFor = hasWaitingFor
      ? assertTaskDependencies(id, args.waitingFor, document.data.requests.map(normalizeRecord))
      : null;
    const previous = record.decisions.at(-1);
    const existingWaitingFor = Object.prototype.hasOwnProperty.call(record, 'waitingFor')
      ? readWaitingFor(record.waitingFor)
      : null;
    const waitingForUnchanged = !hasWaitingFor
      || (existingWaitingFor !== null && JSON.stringify(existingWaitingFor) === JSON.stringify(normalizedWaitingFor));
    if (record.status === status && previous?.decision === 'progress' && previous.reason === text && waitingForUnchanged) {
      return { requests: document.data.requests, events: [], record: entry };
    }
    const historyRow = { seq: 0, kind: 'resolve', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = { ...entry, status,
      decisions: [...record.decisions, { at, actor: who, decision: 'progress', status, reason: text }],
      history: [...record.history, historyRow] };
    if (hasWaitingFor) next.waitingFor = normalizedWaitingFor;
    const requests = [...document.data.requests]; requests[index] = next;
    return { requests, events: [{ kind: 'resolve', actor: who, record: next, historyRow }], record: next };
  });
  return Object.freeze({ id, status: result.outcome.record.status, revision: result.revision, recordedAt: result.at });
}

/** Record one explicit review without completing, reviving or assigning the task. */
function recordTaskReview({ id, reviewId, outcome, reason, actor, now } = {}, options = {}) {
  assertKindId('T', id);
  const who = normalizeFiledBy(actor);
  const text = normalizeReason(reason);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!['open', 'in-progress', 'blocked-external', 'done', 'recurring'].includes(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status}; it cannot receive a task review.`);
    }
    const matches = record.decisions.filter(row => plain(row) && row.decision === 'review' && row.reviewId === reviewId);
    if (matches.length > 1) fail('T_LEDGER_REVIEW_EVENT_CONFLICT', 'This reviewId appears more than once in the saved task.');
    const previousReview = matches[0] || null;
    if (previousReview && (previousReview.actor !== who || previousReview.reason !== text)) {
      fail('T_LEDGER_REVIEW_EVENT_CONFLICT', 'This reviewId already has a different reviewer or reason.');
    }
    // The clock is not part of replay identity. A retry at a new time returns
    // the original review and cannot increment its failure count again.
    const enabled = previousReview ? previousReview.gradingEnabled === true : taskDifficultyEnabled(options);
    const plan = planTaskDifficultyReview(record, { reviewId, outcome }, { enabled, previousReview });
    if (!plan.changed) {
      // A duplicate review does not mutate the task, but its receipt still
      // reports the current saved grade. Validate any present grade first.
      if (Object.prototype.hasOwnProperty.call(record, 'difficulty')) {
        require('./task-difficulty').normalizeTaskDifficulty(record.difficulty);
      }
      if (!Number.isSafeInteger(record.failedReviewCount) || record.failedReviewCount < 0) {
        fail('T_LEDGER_REVIEW_COUNT_INVALID', 'The saved review count cannot be verified.');
      }
      return { requests: document.data.requests, events: [], record: entry, review: previousReview, changed: false };
    }
    const review = {
      at, actor: who, decision: 'review', ...plan.review, reason: text,
      gradingEnabled: enabled, regrade: plan.regrade
    };
    const operation = {
      type: 'task-review', reviewId: review.reviewId, outcome: review.outcome,
      failedReviewCount: review.failedReviewCount, gradingEnabled: enabled, regrade: plan.regrade
    };
    const historyRow = { seq: 0, kind: 'resolve', at, actor: who, statusBefore: record.status, eventSha256: '', operation };
    const next = {
      ...entry, failedReviewCount: plan.failedReviewCount,
      ...(Object.prototype.hasOwnProperty.call(plan, 'difficulty') ? { difficulty: plan.difficulty } : {}),
      decisions: [...record.decisions, review],
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests]; requests[index] = next;
    return {
      requests, events: [{ kind: 'resolve', actor: who, record: next, historyRow, operation }],
      record: next, review, changed: true
    };
  });
  const saved = result.outcome;
  if (!saved?.record || !saved.review || saved.record.id !== id || saved.review.reviewId !== reviewId
      || saved.review.outcome !== outcome || typeof saved.changed !== 'boolean') {
    fail('T_LEDGER_REVIEW_RESULT_UNAVAILABLE', 'The saved review result could not be confirmed.');
  }
  return Object.freeze({
    reviewed: true, changed: saved.changed, replayed: !saved.changed,
    id: saved.record.id, reviewId: saved.review.reviewId, outcome: saved.review.outcome,
    status: saved.record.status, ...taskDifficultyFields(saved.record),
    revision: result.revision, recordedAt: saved.review.at, regrade: saved.review.regrade || null
  });
}

/** Complete one task: open -> done; recurring logs a completion and stays recurring. Any other status refuses. */
function completeTask({ id, actor, now } = {}, options = {}) {
  assertKindId('T', id);
  const who = normalizeFiledBy(actor);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!TASK_COMPLETABLE_STATUSES.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only an open or recurring task can be completed.`);
    }
    const recurring = record.status === 'recurring';
    const priorCompletions = Array.isArray(record.recurrence && record.recurrence.completions) ? record.recurrence.completions : [];
    const nextRecurrence = recurring ? { ...record.recurrence, completions: [...priorCompletions, { at, actor: who }] } : record.recurrence;
    const historyRow = { seq: 0, kind: 'complete', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = {
      ...entry,
      kind: record.kind || 'T',
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || who,
      status: recurring ? 'recurring' : 'done',
      recurrence: nextRecurrence,
      completedAt: at,
      completedBy: who,
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'complete', actor: who, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: record.status, revision: result.revision, recordedAt: result.at });
}

/** Remove one task: a tombstone, like R's remove but for a flat id with no refinements. Any actor may.
    Refuses a superseded task by a typed code: superseded is terminal, same as done or removed. */
function removeTask({ id, actor, now } = {}, options = {}) {
  return removeMinor('T', { id, actor, now }, options, {
    terminalStatus: 'superseded',
    terminalCode: 'R_LEDGER_SUPERSEDE_STATUS_INVALID',
    terminalMessage: taskId => `${taskId} is superseded; a superseded task is terminal and cannot be removed.`
  });
}

/** The owner answers one ask: open -> answered, carrying the owner's own words. */
// PRODUCT RULE: asks and purchases are
// agent-closable. Any actor may answer an ask; removeAsk stays owner-only
// (closable, not removable -- removal is the person's, as for R; agent
// removal applies only to T). `actor` is validated and
// normalized the same way filedBy already is, never assumed to be 'owner'.
function answerAsk({ id, answer, actor, now } = {}, options = {}) {
  assertKindId('A', id);
  const who = normalizeFiledBy(actor);
  const text = normalizeWords(answer);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!ASK_ANSWERABLE_STATUSES.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only an open ask can be answered.`);
    }
    const historyRow = { seq: 0, kind: 'answer', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = {
      ...entry,
      kind: record.kind || 'A',
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || PERSON,
      status: 'answered',
      answer: { words: text, at },
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'answer', actor: who, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: record.status, revision: result.revision, recordedAt: result.at });
}

/** The owner declines to answer one ask: open -> declined. */
// PRODUCT RULE: asks and purchases are
// agent-closable. Any actor may decline an ask; removeAsk stays owner-only.
function declineAsk({ id, reason, actor, now } = {}, options = {}) {
  assertKindId('A', id);
  const who = normalizeFiledBy(actor);
  const text = normalizeReason(reason);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!ASK_DECLINABLE_STATUSES.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only an open ask can be declined.`);
    }
    const historyRow = { seq: 0, kind: 'decline', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = {
      ...entry,
      kind: record.kind || 'A',
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || PERSON,
      status: 'declined',
      decisions: [...record.decisions, { at, actor: who, decision: 'decline', reason: text }],
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'decline', actor: who, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: record.status, revision: result.revision, recordedAt: result.at });
}

/** The owner removes one ask: a tombstone, owner-only like R's remove. */
function removeAsk({ id, actor, now } = {}, options = {}) {
  assertPerson(actor);
  return removeMinor('A', { id, actor, now }, options);
}

// PRODUCT RULE: asks and purchases are
// agent-closable. Any actor may decide a purchase; removePurchase stays
// owner-only. A P DECISION HERE IS A LEDGER MIRROR, NOT A SPEND AUTHORITY:
// approving or declining a P record only updates this ledger's own status
// and history for the record; it never moves money and never touches spend
// caps. Actual spend authority stays entirely with src/lib/providers/pay.js
// and the owner prompt path, neither of which reads this ledger to decide
// whether to spend -- decidePurchase and the ledger it writes are downstream
// of that decision, not upstream of it. assertPurchaseDecider (below) is no
// longer called here for exactly that reason: gating who may write the
// MIRROR never gated who may authorize the SPEND, so removing it here widens
// no financial authority. Journalled with the real actor, never hard-coded
// PERSON: OUTWARD_RESERVED_SETTING_ACTOR is still a valid actor value and is
// still journalled verbatim when the owner's own standing setting decided
// it, exactly as before -- it is simply no longer the ONLY non-owner value
// accepted, since every actor now is.
function decidePurchase({ id, decision, reason, actor, now } = {}, options = {}) {
  assertKindId('P', id);
  const who = normalizeFiledBy(actor);
  if (decision !== 'approve' && decision !== 'decline') fail('R_LEDGER_DECISION_INVALID', 'the decision must be approve or decline.');
  const text = normalizeReason(reason);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!PURCHASE_DECIDABLE_STATUSES.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only a proposed purchase can be ${decision === 'approve' ? 'approved' : 'declined'}.`);
    }
    const statusAfter = decision === 'approve' ? 'approved' : 'declined';
    // Journalled verbatim: `who` is the real actor -- an agent's name, PERSON,
    // or the exact standing-setting string -- never silently rewritten.
    const historyRow = { seq: 0, kind: decision, at, actor: who, statusBefore: record.status, eventSha256: '' };
    const nextPurchase = { ...(record.purchase || {}), decision: { decision, reason: text, at, actor: who } };
    const next = {
      ...entry,
      kind: record.kind || 'P',
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || PERSON,
      status: statusAfter,
      purchase: nextPurchase,
      decisions: [...record.decisions, { at, actor: who, decision, reason: text }],
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: decision, actor: who, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: record.status, revision: result.revision, recordedAt: result.at });
}

/** Record the settled charge for one approved purchase: approved -> recorded. Written by pay.record, not owner-gated. */
function recordPurchase({ id, charge, actor, now } = {}, options = {}) {
  assertKindId('P', id);
  const who = normalizeFiledBy(actor);
  if (!plain(charge)) fail('R_LEDGER_PURCHASE_CHARGE_INVALID', 'the recorded charge must be an object.');
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!PURCHASE_RECORDABLE_STATUSES.has(record.status)) {
      fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status || 'without a status'}; only an approved purchase can be recorded.`);
    }
    const historyRow = { seq: 0, kind: 'record', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const nextPurchase = { ...(record.purchase || {}), recordedCharge: { ...charge, at } };
    const next = {
      ...entry,
      kind: record.kind || 'P',
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || who,
      status: 'recorded',
      purchase: nextPurchase,
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'record', actor: who, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: record.status, revision: result.revision, recordedAt: result.at });
}

/** The owner removes one purchase: a tombstone, owner-only like R's remove. */
function removePurchase({ id, actor, now } = {}, options = {}) {
  assertPerson(actor);
  return removeMinor('P', { id, actor, now }, options);
}

/* Shared tombstone for T/A/P: any status but 'removed' -> 'removed'. The
   caller has already applied whatever actor gate its kind requires (T: none;
   A and P: assertPerson) before reaching here. A kind may name one further
   status that is ALSO terminal to it (T's own 'superseded': terminal, like
   done or removed, refused by its own typed code) without widening this for
   A or P, whose callers never pass it. */
function removeMinor(kind, { id, actor, now } = {}, options = {}, { terminalStatus = null, terminalCode = null, terminalMessage = null } = {}) {
  assertKindId(kind, id);
  const who = normalizeFiledBy(actor);
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (record.status === 'removed') fail('R_LEDGER_ENTRY_UNKNOWN', `${id} was already deleted.`);
    if (terminalStatus !== null && record.status === terminalStatus) fail(terminalCode, terminalMessage(id));
    const historyRow = { seq: 0, kind: 'remove', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = {
      ...entry,
      kind: record.kind || kind,
      scope: record.scope,
      scopeKey: record.scopeKey,
      parentId: record.parentId,
      filedBy: record.filedBy || who,
      status: 'removed',
      removedAt: at,
      removedBy: who,
      history: [...record.history, historyRow]
    };
    const requests = [...document.data.requests];
    requests[index] = next;
    return { requests, events: [{ kind: 'remove', actor: who, record: next, historyRow }], record: next };
  });
  const record = result.outcome.record;
  return Object.freeze({ id, status: record.status, path: result.ledgerFile, backup: `${result.ledgerFile}.bak`, revision: result.revision });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/* A row this store chained carries the hash in its history; a row the CLI
   wrote carries no history at all. */
function carriesChainHash(record) {
  return record.history.some(row => plain(row) && typeof row.eventSha256 === 'string' && row.eventSha256 !== '');
}

/**
 * Walk the chain and compare its last word on every record with the record as
 * it is now. Never creates a file.
 *   drift      records whose core differs from the chain's last word on them,
 *              and records that carry a chain hash in their history but have
 *              no chain event (a history line that never landed is drift, not
 *              a CLI row);
 *   missing    ids the chain names that are no longer in the ledger at all --
 *              spliced out by hand; a tombstone would still be there;
 *   unchained  rows with no history and no chain event: the owner-capture CLI
 *              wrote them; informational.
 * A 'drift-observed' event is informational and never the chain's last word.
 * @returns {{ok:boolean, events:number, head:string, drift:string[], missing:string[], unchained:string[], code?:string, message?:string}}
 */
function verifyHistory(options = {}) {
  const { ledgerFile, historyFile } = filesFor(options);
  const chain = readChain(historyFile);
  if (chain.broken) {
    return Object.freeze({
      ok: false, events: chain.events.length, head: chain.head, drift: Object.freeze([]), missing: Object.freeze([]), unchained: Object.freeze([]),
      code: 'R_LEDGER_CHAIN_BROKEN', message: `The history breaks at line ${chain.broken.line}; it was edited in place. Restore it from a backup before trusting it.`
    });
  }
  const latest = lastCoreByRequest(chain.events);
  const document = readDocument(ledgerFile);
  const drift = [];
  const unchained = [];
  const present = new Set();
  for (const entry of document.data.requests) {
    // Verification covers the whole shared journal. R-only filtering belongs
    // to the standing-rules reader, not the integrity check for T/A/P writes.
    if (!plain(entry) || !idKind(entry.id)) continue;
    const record = normalizeRecord(entry);
    present.add(record.id);
    const last = latest.get(record.id);
    if (!last) { (carriesChainHash(record) ? drift : unchained).push(record.id); continue; }
    if (last.coreSha256 !== coreSha256(record)) drift.push(record.id);
  }
  const missing = [...new Set(chain.events.map(event => event.requestId))]
    .filter(id => idKind(id) && !present.has(id));
  const ok = drift.length === 0 && missing.length === 0;
  const one = list => list.length === 1;
  const driftNote = drift.length
    ? `${one(drift) ? 'One request differs' : `${drift.length} requests differ`} from the last history line about ${one(drift) ? 'it' : 'them'}. Check ${drift.join(', ')} before relying on ${one(drift) ? 'it' : 'them'}.`
    : '';
  const missingNote = missing.length
    ? `${one(missing) ? 'One request the history names is' : `${missing.length} requests the history names are`} no longer in the ledger: ${missing.join(', ')}. ${one(missing) ? 'It' : 'They'} left without a tombstone; restore ${one(missing) ? 'it' : 'them'} from the .bak or the history before relying on the ledger.`
    : '';
  return Object.freeze({
    ok, events: chain.events.length, head: chain.head, drift: Object.freeze(drift), missing: Object.freeze(missing), unchained: Object.freeze(unchained),
    ...(ok ? {} : { code: drift.length ? 'R_LEDGER_CHAIN_DRIFT' : 'R_LEDGER_CHAIN_MISSING', message: [driftNote, missingNote].filter(Boolean).join(' ') })
  });
}

/** Restore evidence for imported rows without rewriting either original
 * journal. Only records whose current core AND stored history reference match
 * the preserved source can recover. This is an explicit owner repair, never
 * an automatic read-time rebaseline. The source bytes remain pinned by hash
 * in each appended recovery event and are checked on subsequent chain reads. */
function recoverHistory({ sourceHistoryFile, actor, now } = {}, options = {}) {
  assertPerson(actor);
  if (typeof sourceHistoryFile !== 'string' || !path.isAbsolute(sourceHistoryFile)) {
    fail('R_LEDGER_RECOVERY_SOURCE_INVALID', 'Recovery needs an absolute path to a preserved history file.');
  }
  const raw = fs.readFileSync(sourceHistoryFile, 'utf8');
  const source = parseChain(raw);
  if (source.broken || !source.events.length) {
    fail('R_LEDGER_RECOVERY_SOURCE_INVALID', 'The preserved history is empty or does not verify.');
  }
  // Verification and the saved evidence use this same immutable byte snapshot.
  const fileSha256 = sha256(raw);
  const latestSource = lastCoreByRequest(source.events);
  const result = transact(options, now, (document, at, chain) => {
    const latestLocal = lastCoreByRequest(chain.events);
    const events = [];
    for (const entry of document.data.requests) {
      if (!plain(entry) || !idKind(entry.id)) continue;
      const original = latestSource.get(entry.id);
      if (!original) continue;
      const record = normalizeRecord(entry);
      const core = coreSha256(record);
      const authentic = original.kind !== 'recover' && original.coreSha256 === core
        && record.history.some(row => row.eventSha256 === original.eventSha256);
      // A number this journal already speaks for is left alone, with one
      // exception: both computers hold that number, the row on file is the
      // preserved source's own record, and its current history reference is
      // one this journal cannot confirm -- the state every write refuses. It
      // recovers like any imported row; transact() chains a difference from
      // the local record as drift-observed first, so neither history is hidden
      // and the person is not left with an unwritable ledger. The reference,
      // not the core, decides: a change that leaves the core alone (a recurring
      // task completed again on the other computer) strands the ledger too.
      if (latestLocal.has(entry.id)) {
        const [reference] = currentHistoryReferences({ requests: [entry] });
        if (!authentic || !reference || hasCurrentReferences(chain, [reference])) continue;
      }
      if (!authentic) {
        fail('R_LEDGER_RECOVERY_MISMATCH', `${entry.id} does not match its preserved history; nothing was recovered.`);
      }
      const recoveredFrom = { fileSha256, eventSha256: original.eventSha256 };
      const historyRow = { kind: 'recover', at, actor, recoveredFrom };
      entry.history.push(historyRow);
      events.push({ kind: 'recover', actor, record: entry, historyRow, recoveredFrom });
    }
    if (events.length) {
      const target = recoveredHistoryFile(historyFileFor(options), fileSha256);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let fd;
      try {
        fd = fs.openSync(target, 'wx', 0o600);
        fs.writeFileSync(fd, raw, 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      if (fs.readFileSync(target, 'utf8') !== raw) {
        fail('R_LEDGER_RECOVERY_SOURCE_INVALID', 'The preserved evidence at the recovery destination does not match.');
      }
    }
    return { requests: document.data.requests, events };
  }, true);
  return Object.freeze({ recovered: Object.freeze(result.outcome.events.map(event => event.record.id)), revision: result.revision, sourceSha256: fileSha256 });
}

/** Every record on the document whose OWN last history row names a chain
 * reference this journal cannot confirm right now -- shared by the preview
 * and the adoption it describes, so the two can never disagree about what
 * would be adopted. */
function unconfirmedRecordsOf(document, chain) {
  const rows = [];
  for (const entry of document.data.requests) {
    if (!plain(entry) || !idKind(entry.id)) continue;
    const [reference] = currentHistoryReferences({ requests: [entry] });
    if (!reference || hasCurrentReferences(chain, [reference])) continue;
    rows.push({ entry, reference });
  }
  return rows;
}

/** A binding for one exact document+chain snapshot, not a bare revision
 * number: an externally copied document can carry the same `revision` as the
 * ledger it was copied from while holding different bytes, so `revision`
 * alone cannot fence a stale preview. `chain.head` is itself a hash chained
 * over every earlier event, so together with the document's own raw bytes
 * this names the exact state a preview was computed from. */
function adoptionToken(document, chain) {
  return sha256(canonical({
    documentSha256: sha256(document.raw),
    revision: Number.isInteger(document.data.revision) ? document.data.revision : 0,
    historyHead: chain.head,
    historySequence: chain.sequence
  }));
}

/** The person's read-only look before adopting: how many records a saved
 * change names a history append this journal cannot confirm right now, and a
 * token bound to this exact document+chain snapshot. Forces the same cold,
 * recomputed chain read adoption itself uses (see readTransactionHistory),
 * so a tampered-but-JSON-valid journal is refused here too, not only at
 * adoption. Changes nothing; a person-gated read like verifyHistory. */
function previewUnconfirmedHistory({ actor } = {}, options = {}) {
  assertPerson(actor);
  const { ledgerFile, historyFile } = filesFor(options);
  const lock = acquireLock(ledgerFile);
  try {
    const document = readDocument(ledgerFile);
    const chain = readTransactionHistory(historyFile, document, options, false, true);
    const revision = Number.isInteger(document.data.revision) ? document.data.revision : 0;
    return Object.freeze({ revision, token: adoptionToken(document, chain), count: unconfirmedRecordsOf(document, chain).length });
  } finally {
    lock.release();
  }
}

/** The person's way out when a saved change names a history append this
 * journal cannot confirm and there is no preserved journal to recover from:
 * the journal was lost while the document survived, the document was copied or
 * merged in from another computer, or an append failed after the document was
 * saved. Nothing is hidden and nothing is rebaselined silently -- every such
 * record gets ONE chain event and one row in its own history, both carrying
 * the reference that could not be confirmed, and its number stays reserved.
 * Words, statuses and earlier history rows are not touched; a record that
 * also differs from this journal's last word on it is chained as
 * drift-observed first, as for any write. Ordinary writes still refuse until
 * the person has done this, an agent can never do it, and a journal that is
 * broken or lost an identity this writer knows still refuses.
 *
 * Adoption edits the record's custody metadata. Its journal envelope uses
 * the existing 'edit' kind, with a hash-covered 'adopt-unconfirmed-history'
 * operation and the original unconfirmed reference. Older readers can verify
 * and append without mistaking this for a purchase, reset or recovery. The
 * document history row retains the explicit 'adopt' label.
 * revision/token, when given, must match a preview of this exact
 * document+chain snapshot (adoptionToken) or the call refuses with
 * R_LEDGER_ADOPTION_STALE, changing nothing; the app always sends them, bound
 * under the same lock this transaction holds. Omitting both keeps the
 * person's direct command-line call (node tools/r-ledger.js adopt) working
 * exactly as before -- that hand on the keyboard is its own binding. */
function adoptUnconfirmedHistory({ actor, now, revision, token } = {}, options = {}) {
  assertPerson(actor);
  const bound = revision !== undefined || token !== undefined;
  const result = transact(options, now, (document, at, chain) => {
    if (bound) {
      const currentRevision = Number.isInteger(document.data.revision) ? document.data.revision : 0;
      if (revision !== currentRevision || token !== adoptionToken(document, chain)) {
        fail('R_LEDGER_ADOPTION_STALE', 'This adoption preview no longer matches the ledger. Preview it again before adopting.');
      }
    }
    const events = [];
    for (const { entry, reference } of unconfirmedRecordsOf(document, chain)) {
      const unconfirmed = { seq: Number.isSafeInteger(reference.seq) ? reference.seq : null, eventSha256: reference.eventSha256 };
      const historyRow = { kind: 'adopt', at, actor, unconfirmed };
      entry.history.push(historyRow);
      events.push({ kind: 'edit', operation: 'adopt-unconfirmed-history', actor, record: entry, historyRow, unconfirmed });
    }
    return { requests: document.data.requests, events };
  }, false, true);
  return Object.freeze({
    adopted: Object.freeze(result.outcome.events.map(event => Object.freeze({ id: event.record.id, unconfirmed: Object.freeze({ ...event.unconfirmed }) }))),
    revision: result.revision
  });
}

// ---------------------------------------------------------------------------
// ADDITIVE, 2026-09-07: purchase-specific store lookups only.
// Neither function below changes an existing function, the record shape or a
// vocabulary; both are read-only compositions of readAll/idKind, which this
// module already exports with the {kinds} widening this file's own header comment
// describes. Needed so the purchase tools (tool-registry.js) and the
// mission-bridge decision pipeline can find the ONE P record a promptId
// belongs to, and so any tool can read one T/A/P record by id without
// reaching for readAll's whole-ledger shape.
// ---------------------------------------------------------------------------

/** Read one record of any kind (R, T, A or P) by id. Refuses an id whose
 * shape names no kind at all; answers R_LEDGER_ENTRY_UNKNOWN for a
 * well-shaped id nothing was ever filed under. */
function findRecord(id, options = {}) {
  const kind = idKind(id);
  if (!kind) fail('R_LEDGER_ID_INVALID', 'ids look like R12, T1, A1 or P1.');
  const all = readAll({ kinds: [kind], includeRemoved: true, includeProposed: true, ...options });
  const record = all.records.find(candidate => candidate.id === id);
  if (!record && resetRecordById(id, options)) fail('R_LEDGER_ENTRY_RESET', `${id} was cleared from this Ledger category.`);
  if (!record) fail('R_LEDGER_ENTRY_UNKNOWN', `${id} is not in the ledger (deleted, or never filed).`);
  return record;
}

/** Which P record, if any, purchase.request filed for this promptId
 * (carried as `purchase.requestId` on the record). Null when no purchase was
 * ever filed under that id, or the ledger cannot be read right now -- the
 * caller decides what null means; this never creates or infers a record. */
function findPurchaseByRequestId(requestId, options = {}) {
  if (typeof requestId !== 'string' || !requestId) return null;
  const all = readAll({ kinds: ['P'], includeRemoved: true, includeProposed: true, ...options });
  const record = all.records.find(candidate => plain(candidate.purchase) && candidate.purchase.requestId === requestId);
  return record ? record.id : null;
}

function assertResetKind(kind) {
  if (!Object.prototype.hasOwnProperty.call(KIND_LABEL, kind)) fail('R_LEDGER_KIND_INVALID', 'kind must be R, T, A or P.');
  return kind;
}

function resetToken(kind, revision) { return sha256(canonical({ action: 'ledger-category-reset', kind, revision })); }

function previewResetKind({ kind, actor } = {}, options = {}) {
  assertPerson(actor); assertResetKind(kind);
  const { ledgerFile } = filesFor(options); const lock = acquireLock(ledgerFile);
  try {
    const document = readDocument(ledgerFile);
    const revision = Number.isInteger(document.data.revision) ? document.data.revision : 0;
    const count = document.data.requests.filter(entry => plain(entry) && recordKindOf(entry) === kind).map(normalizeRecord).filter(record => !isReset(record)).length;
    return Object.freeze({ kind, count, revision, token: resetToken(kind, revision) });
  } finally { lock.release(); }
}

function resetBatchResult(kind, batchId, options = {}) {
  assertResetKind(kind); if (typeof batchId !== 'string') return null;
  const { ledgerFile } = filesFor(options); const document = readDocument(ledgerFile);
  const records = document.data.requests.filter(entry => plain(entry) && recordKindOf(entry) === kind && plain(entry.reset) && entry.reset.batchId === batchId);
  if (!records.length) return null;
  if (verifyHistory(options).ok !== true) fail('R_LEDGER_CHAIN_BROKEN', 'The saved reset history could not be verified. Its purchase prompts remain held.');
  return Object.freeze({ count: records.length, revision: records[0].reset.revision + 1 });
}

function resetKind({ kind, actor, revision, token, batchId: requestedBatchId, now } = {}, options = {}) {
  assertPerson(actor); assertResetKind(kind);
  if (!Number.isInteger(revision) || revision < 0 || token !== resetToken(kind, revision)) fail('R_LEDGER_RESET_STALE', 'This reset confirmation is stale. Review the current count and try again.');
  const result = transact(options, now, (document, at) => {
    const currentRevision = Number.isInteger(document.data.revision) ? document.data.revision : 0;
    if (currentRevision !== revision) fail('R_LEDGER_RESET_STALE', 'This reset confirmation is stale. Review the current count and try again.');
    const batchId = requestedBatchId || crypto.randomUUID();
    if (typeof batchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(batchId)) fail('R_LEDGER_RESET_BATCH_INVALID', 'reset batchId must be a UUID.');
    const events = [];
    const requests = document.data.requests.map(entry => {
      if (!plain(entry) || recordKindOf(entry) !== kind) return entry;
      const record = normalizeRecord(entry); if (isReset(record)) return entry;
      const historyRow = { seq: 0, kind: 'reset', at, actor: PERSON, statusBefore: record.status, eventSha256: '' };
      const reset = { batchId, kind, at, actor: PERSON, revision: currentRevision };
      const next = record.status === 'removed' ? { ...entry, reset, history: [...record.history, historyRow] } : { ...entry, scope: record.scope, scopeKey: record.scopeKey, parentId: record.parentId, filedBy: record.filedBy || PERSON, status: 'removed', removedAt: at, removedBy: PERSON, reset, history: [...record.history, historyRow] };
      events.push({ kind: 'reset', actor: PERSON, record: next, historyRow }); return next;
    });
    if (!events.length) fail('R_LEDGER_RESET_EMPTY', `No ${KIND_LABEL[kind]} records remain to clear.`);
    return { requests, events, batchId };
  });
  return Object.freeze({ kind, count: result.outcome.events.length, batchId: result.outcome.batchId, revision: result.revision });
}

/** The DIRECT pay.record path (LEDGER-KINDS-INTERFACE-20260907.md, TOOLS
 * ruling): an agent calling pay.record with no cart/prompt only
 * reaches providers/pay.js's spend layer when `approval.autoApproved` is
 * true, which is itself an owner decision -- made once, in Settings
 * (outward.reserved_from_agents), rather than per purchase. This composes
 * the three existing, unmodified primitives (filePurchase, decidePurchase,
 * recordPurchase) exactly as a person would on the Ledger page, one
 * transaction each, so the SAME hash-chained history and status gates apply;
 * it adds no new status and no new field. The decision is journalled under
 * OUTWARD_RESERVED_SETTING_ACTOR, not PERSON (FINDING 2 ruling,
 * once assertPurchaseDecider/decidePurchase accepted it): a
 * setting-authorized spend must never read back as an owner click on this
 * exact purchase. `reason` still names the setting in full for a reader who
 * has not seen that constant before. */
function recordDirectPurchase({ words, filedBy, why, line, now } = {}, options = {}) {
  const filed = filePurchase({ scope: 'global', words, filedBy, why, purchase: { lines: [line] } }, options);
  decidePurchase({
    id: filed.id, decision: 'approve', actor: OUTWARD_RESERVED_SETTING_ACTOR,
    reason: 'auto-approved: the owner\'s "outward.reserved_from_agents" setting authorizes this spend without a per-purchase decision.',
    now
  }, options);
  return recordPurchase({ id: filed.id, charge: line, actor: 'pay-provider', now }, options);
}

module.exports = Object.freeze({
  LEDGER_FILE,
  HISTORY_FILE,
  LOCK_SUFFIX,
  SCOPES,
  SCOPE_WORD,
  SAFE_KEY,
  MAX_WORDS_BYTES,
  MAX_FILED_BY_CHARS,
  MAX_LABEL_CHARS,
  STATUS_VOCABULARY,
  ACTIVE_STATUSES,
  RESOLUTION_STATUSES,
  GENESIS_SHA256,
  KIND_LABEL,
  TASK_STATUS_VOCABULARY,
  ASK_STATUS_VOCABULARY,
  PURCHASE_STATUS_VOCABULARY,
  OUTWARD_RESERVED_SETTING_ACTOR,
  OwnerRequestStoreError,
  canonical,
  chainHash,
  coreSha256,
  idKind,
  KIND_ID_RE,
  assertKindId,
  ledgerFileFor,
  historyFileFor,
  ensureLedger,
  registerTaskLedgerWriter,
  revokeTaskLedgerWriter,
  taskLedgerWriter,
  readTaskHandoff,
  readAll,
  readLayer,
  readLedger: readLayer,
  collectStack,
  selectForContext,
  nestEntries,
  findEntry,
  nextRootNumber,
  previewResetKind,
  resetBatchResult,
  resetKind,
  fileRequest,
  editRequest,
  removeRequest,
  decide,
  fileTask,
  recordTaskReview,
  completeTask,
  progressTask,
  assignTask,
  removeTask,
  fileAsk,
  answerAsk,
  declineAsk,
  removeAsk,
  filePurchase,
  decidePurchase,
  recordPurchase,
  removePurchase,
  findRecord,
  findPurchaseByRequestId,
  recordDirectPurchase,
  resolve,
  verifyHistory,
  recoverHistory,
  previewUnconfirmedHistory,
  adoptUnconfirmedHistory,
  agentFiledNeedsApproval
});

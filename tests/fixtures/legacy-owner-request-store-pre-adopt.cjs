'use strict';

// LEGACY ROLLBACK FIXTURE, retained only to test what an engine older than
// the 'adopt' journal event kind (K1, landed on top of ecbf4558) actually
// does when it is pointed at a journal a newer engine has written. This is a
// byte-for-byte copy of src/lib/owner-request-store.js as it stood at commit
// ecbf4558f41cf90e8adbb237ca746e086ee8d97a (sha256
// f228639e925ea1da74afcd072311d6f6f59a3ce47d0d8bd647a4934e2ba6c095), with only
// its four relative `require('./...')` lines rewritten to reach
// src/lib/ from this fixture's own location; nothing else below this header
// was changed. No product entrypoint may import this file -- it exists only
// so tests/owner-request-store.test.js can prove the documented rollback rule
// in packages/owner.ledger/PACKAGE.md against real code instead of prose.
// Do not update this file when src/lib/owner-request-store.js changes: its
// entire value is staying exactly as old as the commit before 'adopt' existed.

// THE ONE PLACE THE PERSON'S REQUESTS ARE FILED, EDITED, REMOVED AND DECIDED.
//
// Before this module there were two stores for the same fact: the canonical
// JSON ledger (reports/OWNER-REQUEST-LEDGER.json, written by the owner-capture
// CLI and read by every gate, digest and projection) and four markdown files
// behind /Request (src/lib/r-ledger.js). The owner ruled on 2026-09-02: one
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
const { statePath } = require('../../src/lib/runtime-state-root');
const { isRequestId, parseRequestId } = require('../../src/lib/request-id');
const { normalizeProvenance } = require('../../src/lib/owner-request-provenance');

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
const EVENT_KINDS = Object.freeze(['file', 'edit', 'remove', 'approve', 'decline', 'drift-observed', 'complete', 'answer', 'record', 'supersede', 'resolve', 'recover', 'reset']);
const BOM = '\uFEFF';

// ---------------------------------------------------------------------------
// Kinds -- owner's words, 2026-09-07: "ledger should have the following
// subsets: R for rules; T for tasks ... these tasks can be completed and
// removed by agents; Asks for things agents need from the owner; and
// Purchases for actual purchases ... Respect how its built, build it the
// same or similar for each." R (rules) above is untouched: its ids
// (assertId, family 'R'), its reader (isStoreRecordId, family 'R' only,
// still exactly as written) and its vocabulary (STATUS_VOCABULARY) are
// exactly what they were. T (tasks), A (asks) and P (purchases) are new,
// flat-numbered families sharing the same ledger file, the same lock, the
// same hash chain (coreOf below is UNCHANGED -- kind is deliberately not
// part of the hashed core, so a chain already written under the old formula,
// including the live 26-record R ledger, keeps verifying) and the same
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
// an owner click, and (owner ruling, 2026-09-07, "asks and purchases: agent
// closable") an agent-decided purchase is never misrecorded as this setting
// either. R's edit/remove/decide/resolve and A/P's own remove stay
// assertPerson-only; A's answer/decline and P's decide do not, as of that
// ruling -- this is a scoped widening of those three writers, not a general
// widening of who "the person" is.
const OUTWARD_RESERVED_SETTING_ACTOR = 'setting:outward.reserved_from_agents';
// UNCALLED since the owner's 2026-09-07 ruling widened decidePurchase to any
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
   a caller must not file R1 over a record it could not read. */
function readDocument(ledgerFile) {
  let stat;
  try {
    stat = fs.statSync(ledgerFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, raw: '', data: emptyLedger() };
    throw error;
  }
  if (stat.size > MAX_LEDGER_BYTES) fail('R_LEDGER_TOO_LARGE', `the ledger exceeds ${MAX_LEDGER_BYTES} bytes.`);
  const raw = fs.readFileSync(ledgerFile, 'utf8');
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

function parentIdOf(id) {
  const parsed = parseRequestId(id);
  if (!parsed || parsed.segments.length === 0) return null;
  const above = parsed.segments.slice(0, -1);
  return `${parsed.root}${above.length ? `.${above.join('.')}` : ''}`;
}

/* One record as the readers see it. Records the owner-capture CLI wrote have
   no scopeKey/filedBy/history; they normalise here and are never rewritten by
   a read. */
function normalizeRecord(entry) {
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
  return {
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
    answer: plain(entry.answer) ? entry.answer : null,
    purchase: plain(entry.purchase) ? entry.purchase : null,
    reset: plain(entry.reset) ? entry.reset : null
  };
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
  const { ledgerFile } = filesFor(rest);
  const document = readDocument(ledgerFile);
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
  const records = document.data.requests
    .filter(entry => plain(entry) && typeof entry.id === 'string' && kinds.includes(recordKindOf(entry)))
    .map(normalizeRecord)
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
  const entry = readDocument(ledgerFile).data.requests.find(candidate => plain(candidate) && candidate.id === id);
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

/* Temp file (wx, 0600) -> fsync -> read the bytes back and parse them -> .bak
   of what was there -> one rename. The original changes at the rename only. */
function atomicWrite(ledgerFile, previousRaw, nextData) {
  const serialized = `${JSON.stringify(nextData, null, 2)}\n`;
  validateShape(JSON.parse(serialized), ledgerFile);
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const temporary = `${ledgerFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    validateShape(JSON.parse(fs.readFileSync(temporary, 'utf8')), ledgerFile);
    fs.writeFileSync(`${ledgerFile}.bak`, typeof previousRaw === 'string' ? previousRaw : '', 'utf8');
    renameWithRetry(temporary, ledgerFile);
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch { /* closed */ } }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function finalize(data, nextRequests, now) {
  return {
    ...data,
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isInteger(data.revision) ? data.revision + 1 : 1,
    updatedAt: todayString(now),
    statusVocabulary: { ...STATUS_VOCABULARY, ...(plain(data.statusVocabulary) ? data.statusVocabulary : {}) },
    requests: nextRequests
  };
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
  return {
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

function operationalEvents(events) {
  const latest = new Map();
  for (const event of events) {
    if (event.kind === 'drift-observed' && latest.has(event.requestId)) continue;
    latest.set(event.requestId, { requestId: event.requestId, kind: event.kind,
      seq: event.seq, eventSha256: event.eventSha256, coreSha256: event.coreSha256 });
  }
  return [...latest.values()];
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

function reconcileOperationalHistory(historyFile, chain) {
  const known = operationalHistories.get(historyFile)?.chain;
  if (known && (chain.sequence < known.sequence || chain.priorHead !== known.head)) {
    fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history lost or replaced a known append. Restore it before filing another record.');
  }
  requireKnownReservations(historyFile, chain.events);
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
        || !EVENT_KINDS.includes(event.kind) || !idKind(event.requestId)) return broken(index + 1, 'invalid append position or record identity');
    if (event.kind !== 'drift-observed' || !latest.has(event.requestId)) {
      latest.set(event.requestId, { requestId: event.requestId, kind: event.kind,
        seq: event.seq, eventSha256: event.eventSha256, coreSha256: event.coreSha256 });
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

function readTransactionHistory(historyFile, document, options, forceVerification = false) {
  const policy = forceVerification ? null : require('../../src/lib/runtime-policy').runtimePolicy(options);
  const references = currentHistoryReferences(document.data);
  let chain;
  if (forceVerification || policy.verifyHistory || !policy.configurationAvailable) {
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
    reconcileOperationalHistory(historyFile, chain);
    if (!hasCurrentReferences(chain, references)) {
      fail('R_LEDGER_CHAIN_APPEND_UNCONFIRMED', 'A saved Ledger change has no confirmed history append. Check or recover its history before writing again.');
    }
    rememberOperationalHistory(historyFile, chain);
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
function transact(options, now, mutate, forceVerification = false) {
  const { ledgerFile, historyFile } = filesFor(options);
  const clock = clockOf(now);
  const lock = acquireLock(ledgerFile);
  try {
    const document = readDocument(ledgerFile);
    const chain = readTransactionHistory(historyFile, document, options, forceVerification);
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
    if (outcome.events.length === 0) {
      return { ledgerFile, historyFile, revision: document.data.revision, at, outcome };
    }
    const nextData = finalize(document.data, outcome.requests, clock());
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
    for (const pending of outcome.events) {
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
        ...(pending.recoveredFrom ? { recoveredFrom: pending.recoveredFrom } : {})
      });
      pending.historyRow.seq = event.seq;
      pending.historyRow.eventSha256 = event.eventSha256;
    }
    if (seq > MAX_EVENTS) fail('R_LEDGER_CHAIN_APPEND_FAILED', 'The history has reached its supported event count. Archive it before adding more.');
    if (!sameHistoryStamp(chain.stamp, historyStamp(historyFile))) fail('R_LEDGER_CHAIN_UNAVAILABLE', 'The task history changed before the write. Try again.');
    const events = operationalEvents([...chain.events, ...lines]);
    // Recovery may establish a new local sequence, but it cannot erase an
    // identity this writer already knows. A refused/no-op recovery keeps the
    // earlier reconciliation facts intact.
    if (forceVerification) requireKnownReservations(historyFile, events);
    if (!operationalHistories.has(historyFile)) rememberOperationalHistory(historyFile, chain);
    const known = operationalHistories.get(historyFile);
    known.reusable = false;
    // A publication error may occur after the document reached disk. Retain
    // these reservations until readback or explicit recovery settles it.
    for (const event of lines) known.reservedIds.add(event.requestId);
    atomicWrite(ledgerFile, document.raw, nextData);
    let stamp = chain.stamp;
    for (const event of lines) stamp = appendChainLine(historyFile, event, stamp);
    const references = referenceEvents([...chain.references.values(), ...lines], currentHistoryReferences(nextData));
    rememberOperationalHistory(historyFile, { exists: true, events,
      sequence: seq, head: previous, broken: null, stamp, checked: false, references });
    return { ledgerFile, historyFile, revision: nextData.revision, at, outcome };
  } finally {
    lock.release();
  }
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
  const lock = acquireLock(ledgerFile);
  try {
    if (fs.existsSync(ledgerFile)) return Object.freeze({ created: false, path: ledgerFile });
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    atomicWrite(ledgerFile, '', emptyLedger());
    return Object.freeze({ created: true, path: ledgerFile });
  } finally {
    lock.release();
  }
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
// T, A, P writes -- flat families, agent-usable per the owner's words
// (2026-09-07): "T for tasks ... these tasks can be completed and removed by
// agents; Asks for things agents need from the owner; and Purchases for
// actual purchases". Every one of them runs through the SAME transact() the
// R writes use, so it gets the same lock, the same atomic write, and the
// same hash-chained history for free, unmodified. Scope works exactly like
// R's own (assertScope/assertKey, the same four tiers) -- "T, A and P
// records carry scope like R." File/complete/remove are agent-usable for T;
// answer/decline (A) and decide (P) are ALSO agent-usable, per a second
// owner ruling relayed by Controller 3 (2026-09-07): "asks and purchases:
// agent closable" -- but removeAsk and removePurchase stay owner-only
// (assertPerson below, same gate R's own edit/remove/decide/resolve use):
// his word was "closable", not "removable", and he named agent-removal only
// for T.
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
      ...extra
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
    revision: result.revision
  });
}

/** File one task. Any actor may; recurrence null lands 'open' (one-shot), an object lands 'recurring'.
    supersedes: an existing live (not done/removed/superseded) T id -- in the SAME transaction the new
    task is filed and the named one is rewritten to 'superseded' (supersededBy: <new id>), a hash-chained
    'supersede' event on the OLD record, terminal from then on (completeTask/removeTask both refuse it). */
function fileTask({ scope, key, words, filedBy, scopeLabel, why, now, recurrence = null, supersedes = null } = {}, options = {}) {
  const normalizedRecurrence = plain(recurrence) ? { interval: recurrence.interval, completions: [] } : null;
  if (supersedes === null) {
    return fileMinor('T', normalizedRecurrence ? 'recurring' : 'open',
      { recurrence: normalizedRecurrence, completedAt: null, completedBy: null },
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
      supersededBy: null
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
    revision: result.revision
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
function progressTask({ id, status, reason, actor, now } = {}, options = {}) {
  assertKindId('T', id);
  const who = normalizeFiledBy(actor);
  if (!['open', 'in-progress', 'blocked-external'].includes(status)) fail('R_LEDGER_STATUS_INVALID', 'Task progress must be open, in-progress or blocked-external.');
  const text = normalizeReason(reason);
  if (!text) fail('R_LEDGER_WORDS_INVALID', 'Task progress needs a concrete progress or blocker reason.');
  const result = transact(options, now, (document, at) => {
    const { index, entry, record } = locateForRewrite(document, id);
    if (!['open', 'in-progress', 'blocked-external'].includes(record.status)) fail('R_LEDGER_STATUS_INVALID', `${id} is ${record.status}; terminal and recurring tasks cannot be rewritten as one-shot work.`);
    const previous = record.decisions.at(-1);
    if (record.status === status && previous?.decision === 'progress' && previous.reason === text) {
      return { requests: document.data.requests, events: [], record: entry };
    }
    const historyRow = { seq: 0, kind: 'resolve', at, actor: who, statusBefore: record.status, eventSha256: '' };
    const next = { ...entry, status,
      decisions: [...record.decisions, { at, actor: who, decision: 'progress', status, reason: text }],
      history: [...record.history, historyRow] };
    const requests = [...document.data.requests]; requests[index] = next;
    return { requests, events: [{ kind: 'resolve', actor: who, record: next, historyRow }], record: next };
  });
  return Object.freeze({ id, status: result.outcome.record.status, revision: result.revision, recordedAt: result.at });
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
// OWNER RULING, relayed by Controller 3 (2026-09-07): "asks and purchases:
// agent closable." Any actor may answer an ask; removeAsk stays owner-only
// (his word was "closable", not "removable" -- removal is the person's, as
// for R; he named agent-removal only for T). `actor` is validated and
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
// OWNER RULING, relayed by Controller 3 (2026-09-07): "asks and purchases:
// agent closable." Any actor may decline an ask; removeAsk stays owner-only.
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

// OWNER RULING, relayed by Controller 3 (2026-09-07): "asks and purchases:
// agent closable." Any actor may decide a purchase; removePurchase stays
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
      if (!plain(entry) || !idKind(entry.id) || latestLocal.has(entry.id)) continue;
      const original = latestSource.get(entry.id);
      if (!original) continue;
      const record = normalizeRecord(entry);
      if (original.kind === 'recover' || original.coreSha256 !== coreSha256(record)
          || !record.history.some(row => row.eventSha256 === original.eventSha256)) {
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

// ---------------------------------------------------------------------------
// ADDITIVE, L3 (Worker 3), 2026-09-07: purchase-specific store lookups only.
// Neither function below changes an existing function, the record shape or a
// vocabulary; both are read-only compositions of readAll/idKind, which L1
// already exports with the {kinds} widening this file's own header comment
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
 * ruling 05:12Z): an agent calling pay.record with no cart/prompt only
 * reaches providers/pay.js's spend layer when `approval.autoApproved` is
 * true, which is itself an owner decision -- made once, in Settings
 * (outward.reserved_from_agents), rather than per purchase. This composes
 * the three existing, unmodified primitives (filePurchase, decidePurchase,
 * recordPurchase) exactly as a person would on the Ledger page, one
 * transaction each, so the SAME hash-chained history and status gates apply;
 * it adds no new status and no new field. The decision is journalled under
 * OUTWARD_RESERVED_SETTING_ACTOR, not PERSON (Controller 3, FINDING 2 ruling,
 * once L1's assertPurchaseDecider/decidePurchase accepted it): a
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
  completeTask,
  progressTask,
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
  agentFiledNeedsApproval
});

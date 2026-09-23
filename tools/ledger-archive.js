'use strict';

// OWNER-REQUEST RETIREMENT: AN APPEND-ONLY OVERLAY, NOT A DELETE.
//
// WHAT WAS WRONG, AND WHY THIS TOOL HAD NEVER BEEN RUN. Until 2026-08-12 the
// commit path of this file did:
//
//     nextRequests = inputs.ledger.requests.filter(r => r.id !== target.requestId)
//     nextLedger   = { ...inputs.ledger, revision: revision + 1, requests: nextRequests }
//
// It REMOVED the owner's own record from reports/OWNER-REQUEST-LEDGER.json and
// bumped the revision -- rewriting the one append-only file every agent in this
// tree is told never to rewrite. The tool was complete, owner-gated, tested,
// atomic, reversible on paper... and it had retired exactly ZERO entries in its
// entire life, because no agent would pull a lever whose first act is deleting
// the owner's words. Correct and unusable is still unusable.
//
// WHAT IT DOES NOW. The planner is unchanged -- computeArchivePlan/candidateFor
// were the good part and still produce exactly the same candidate set. The
// commit path is replaced by ONE APPEND to
//
//     state/owner-request-disposition-events.jsonl
//
// a hash-chained, append-only overlay. Retiring an entry now:
//   * never removes it from the ledger  (the ledger is opened read-only here;
//     tests/ledger-archive.js asserts its sha256 is identical after every op)
//   * is reversible                     (one `reinstate` or `contest` append,
//     by anybody, no preview hash, no owner gate, no undelete)
//   * is visible                        (every event carries the points that
//     scored it, the vetoes that were checked, its evidence, and a reason code
//     that names its own evidence class)
//   * keeps retired entries out of the prominent set agents read at boot
//     (partitionRetired() hands ledger-query the cold ids to withhold from
//     lists; lookups by id are never cold)
//
// THE BOUNDARY IS NOT TIME-BASED. Nothing in this file reads a clock to decide
// that an entry is finished. Age is not evidence: an entry nobody looked at
// carries zero observations, and silence from an empty room means nothing. The
// boundary counts WATCHERS -- see COOLING/COLD below and docs/design/R-LIFECYCLE.md
// section 2. The clock is used for one thing only: stamping `at` on events.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ownerCapture = require('./owner-capture');
// The recurrence detector (veto V2) uses the same pure text matcher as the
// repo-only capture audit without importing that audit or its transcript scan.
const textShingles = require('../src/lib/text-shingles');
const scopeStore = require('../src/lib/owner-request-scope-store');
const { resolveFullySupersededRequests } = require('../src/lib/owner-request-scope');
const { isRequestId } = require('../src/lib/request-id');
// The ledger file this tool reads also carries T/A/P records now. This tool
// was built for R (rule/request) retirement only; KIND_ID_RE is the source
// of truth for what a T/A/P id looks like, so a foreign-kind row can be told
// apart from a genuinely malformed R row rather than refusing the whole
// document for either. Candidate selection (candidateFor, below) stays R
// only in this build -- a named limitation, not a silent one: see the
// report.
const { KIND_ID_RE } = require('../src/lib/owner-request-store');
// reports/ and state/ are written at runtime; installed they are not the
// program directory. See src/lib/runtime-state-root.js.
const { statePath } = require('../src/lib/runtime-state-root');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_LEDGER_FILE = statePath('reports', 'OWNER-REQUEST-LEDGER.json');
const DEFAULT_OVERLAY_FILE = statePath('state', 'owner-request-disposition-events.jsonl');
// Read-only legacy: the pre-overlay two-file archive. It holds 0 requests and 0
// retirements in this tree because the delete path was never run.
const DEFAULT_ARCHIVE_FILE = statePath('reports', 'OWNER-REQUEST-LEDGER-ARCHIVE.json');
const DEFAULT_SCOPE_STORE_FILE = scopeStore.productionScopeStoreFile();
// A neutral installation has no inherited precedent corpus. An installation
// that uses standing-precedent files must supply their exact paths through the
// bounded dependency seam; only ids actually cited there receive veto V3.
const DEFAULT_PRECEDENT_FILES = Object.freeze([]);

const ARCHIVE_SCHEMA_VERSION = 2;
const OVERLAY_SCHEMA_VERSION = 1;
const MAX_REQUESTS = 5_000;
const MAX_RETIREMENTS = 10_000;
const MAX_EVENTS = 50_000;
const MAX_EVENT_BYTES = 8 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const TRANSIENT_WRITE_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const WRITE_ATTEMPTS = 8;
const RULE_KEY_RE = /^[a-z][a-z0-9._:-]{0,63}$/;
const ACTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID_RE = /\bR\d{1,4}(?:\.\d+)?\b/g;
// A bracketed run of SHOUTING is an editorial banner an audit lane pasted into
// many entries at once, not the owner restating himself. Stripping it drops the
// measured restatement pairs from 80 (R1249-R1256 at the top, all sharing one
// banner) to 35 honest ones. See R-LIFECYCLE section 2.3.
const EDITORIAL_BANNER_RE = /\[[^\]]*[A-Z]{3,}[^\]]*\]/g;
// M1+ : the evidence string is itself a run record -- a command AND its result.
// "Evidence is the command, the result/count and the duration" is the house
// rule, so this reads existing evidence rather than executing anything.
const TEST_RUN_EVIDENCE_RE = /(?:npm run |node )[^\s]+[\s\S]{0,200}?(?:exit 0|checks passed|tests? passed|passed\b)/i;
const MIN_JUDGEMENT_QUOTE_CHARS = 24;
const MIN_SHARED_SHINGLES = 3;

// ---------------------------------------------------------------------------
// THE COLD-STORAGE DECISION RULE. Printed tunables, not buried constants.
// ---------------------------------------------------------------------------
// An entry enters COOLING at >= 2 points spanning >= 2 signal families with
// >= 1 mechanical point and zero vetoes -- OR on any single signal marked
// sufficient (M2, M3, O1). It reaches COLD only after COLD_EXPOSURE_QUORUM
// DISTINCT SESSIONS have been shown it in their cooling line and none contested.
// If no sessions boot, nothing cools; that is correct, because nothing looked.
const COOLING_MIN_POINTS = 2;
const COOLING_MIN_FAMILIES = 2;
const COLD_EXPOSURE_QUORUM = 3;
const SIGNAL_FAMILIES = Object.freeze(['mechanical', 'judged', 'owner']);
// Reason codes name their own evidence class, so no reader can mistake
// `unadjudicable` (we cannot tell what he asked) for `settled` (it was done).
// `absorbed` is accepted on read for a future producer; nothing here mints it.
const REASON_CODES = Object.freeze(['settled', 'superseded', 'unadjudicable', 'absorbed', 'owner-confirmed']);
// src/lib/owner-request-lifecycle-projection.js still only knows three codes.
// partitionRetired({legacyReasonCodes:true}) maps down, keeping the sharp code
// visible at the front of the detail string so the downgrade cannot lie.
const LEGACY_REASON_CODES = Object.freeze({
  settled: 'completed',
  superseded: 'fully-superseded',
  unadjudicable: 'completed',
  absorbed: 'completed',
  'owner-confirmed': 'owner-confirmed'
});
const DISPOSITIONS = Object.freeze([
  'cooling', 'cold', 'park', 'reinstate', 'contest', 'observe', 'judgement', 'owner-confirmation'
]);
// Dispositions that hold a target out of the active set and are therefore
// reversible targets for `restore`/`reinstate`.
const RETIRED_DISPOSITIONS = new Set(['cooling', 'cold', 'park']);
// Only `cold` is withheld from the lists agents read at boot. COOLING is shown,
// on purpose: exposure is what earns the retirement.
const WITHHELD_DISPOSITIONS = new Set(['cold']);
const OPERATIONS = new Set(['archive', 'restore', 'contest', 'observe', 'judge', 'park']);
const DEPENDENCY_KEYS = Object.freeze(['ledgerFile', 'archiveFile', 'scopeStoreFile', 'overlayFile', 'precedentFiles', 'clock']);
// The two operations that keep the mission-bridge preview/confirm protocol.
// Everything else is a cheap append, because the design is deliberately
// asymmetric: going cold costs two independent signals plus an exposure
// window; coming back costs one append by anyone.
const CONFIRMED_OPERATIONS = new Set(['archive', 'restore']);

class LedgerArchiveError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LedgerArchiveError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) { throw new LedgerArchiveError(code, message, details); }
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, allowed, required, label) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) fail('LEDGER_ARCHIVE_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function requestId(value, label = 'request id') {
  if (!isRequestId(value, { family: 'R' })) fail('LEDGER_ARCHIVE_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('LEDGER_ARCHIVE_SHAPE_INVALID', `${label} is invalid.`);
  return new Date(Date.parse(value)).toISOString();
}
function shortText(value, label, { max = 300 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\r\n]/.test(value)) {
    fail('LEDGER_ARCHIVE_INPUT_INVALID', `${label} must be 1-${max} characters on a single line.`);
  }
  return value;
}
// Hashing must not care what order the keys happen to sit in, so a
// whitespace-only or key-order-only touch of the overlay does not read as
// tampering while a content change always does.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

function normalizeTarget(value, label = 'retirement target') {
  exact(value, ['targetKind', 'requestId', 'ruleKey'], ['targetKind', 'requestId'], label);
  const targetKind = value.targetKind;
  const id = requestId(value.requestId, `${label} requestId`);
  if (!['request', 'rule'].includes(targetKind)) fail('LEDGER_ARCHIVE_INPUT_INVALID', `${label} targetKind is invalid.`);
  if (targetKind === 'request' && value.ruleKey !== undefined) fail('LEDGER_ARCHIVE_INPUT_INVALID', `${label} request target cannot carry ruleKey.`);
  if (targetKind === 'rule' && (typeof value.ruleKey !== 'string' || !RULE_KEY_RE.test(value.ruleKey))) {
    fail('LEDGER_ARCHIVE_INPUT_INVALID', `${label} ruleKey is invalid.`);
  }
  return Object.freeze(targetKind === 'request' ? { targetKind, requestId: id } : { targetKind, requestId: id, ruleKey: value.ruleKey });
}
function targetKey(target) { return target.targetKind === 'request' ? `request:${target.requestId}` : `rule:${target.requestId}:${target.ruleKey}`; }
function targetFields(target) {
  return Object.freeze(target.targetKind === 'rule'
    ? { targetKind: 'rule', requestId: target.requestId, ruleKey: target.ruleKey }
    : { targetKind: 'request', requestId: target.requestId });
}

// ---------------------------------------------------------------------------
// Legacy two-file archive: read-only, and loudly refused if it ever holds a
// payload. A request sitting in there was DELETED from the ledger by the old
// commit path, and reinstating it would mean writing the ledger -- which this
// tool no longer does under any circumstances. That is a human repair, and it
// should be seen, not silently skipped.
// ---------------------------------------------------------------------------

function emptyArchive() {
  return {
    $comment: [
      'Durable owner-request archive. SUPERSEDED by state/owner-request-disposition-events.jsonl.',
      'Read-only history: tools/ledger-archive.js no longer writes this file and never removes a request from the ledger.',
      'Retirement provenance is read by the active-set renderer; it is not supersession.'
    ],
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    maintainedBy: 'tools/ledger-archive.js',
    requests: [],
    retirements: []
  };
}
function parseJson(raw, label) { try { return JSON.parse(raw); } catch { fail('LEDGER_ARCHIVE_JSON_INVALID', `${label} is not valid JSON.`); } }
function isForeignKindId(id) {
  return typeof id === 'string' && ['T', 'A', 'P'].some(kind => KIND_ID_RE[kind].test(id));
}
// Returns the R-family subset. A T/A/P row (a kind this tool was not built
// for) is skipped silently, never refused; a row that is neither a valid R
// id nor a recognized T/A/P id is still malformed and still refuses the
// whole document, exactly as before this ledger carried other kinds.
function validateRequestArray(requests, label) {
  if (!Array.isArray(requests) || requests.length > MAX_REQUESTS) fail('LEDGER_ARCHIVE_SHAPE_INVALID', `${label} must contain at most ${MAX_REQUESTS} requests.`);
  const seen = new Set();
  const kept = [];
  for (const request of requests) {
    if (plain(request) && isForeignKindId(request.id)) continue;
    if (!plain(request) || !isRequestId(request.id, { family: 'R' })) fail('LEDGER_ARCHIVE_SHAPE_INVALID', `${label} contains a malformed request.`);
    if (seen.has(request.id)) fail('LEDGER_ARCHIVE_DUPLICATE_ID', `${label} contains duplicate request id ${request.id}.`);
    seen.add(request.id);
    kept.push(request);
  }
  return kept;
}
function normalizeLegacyReason(value) {
  exact(value, ['code', 'detail', 'supersedingRequestIds'], ['code', 'detail', 'supersedingRequestIds'], 'retirement reason');
  if (!['completed', 'fully-superseded', 'owner-confirmed'].includes(value.code)
      || typeof value.detail !== 'string' || value.detail.length === 0 || value.detail.length > 300 || /[\r\n]/.test(value.detail)
      || !Array.isArray(value.supersedingRequestIds) || new Set(value.supersedingRequestIds).size !== value.supersedingRequestIds.length
      || value.supersedingRequestIds.some(item => !isRequestId(item, { family: 'R' }))) fail('LEDGER_ARCHIVE_SHAPE_INVALID', 'retirement reason is invalid.');
  if ((value.code === 'fully-superseded') !== (value.supersedingRequestIds.length > 0)) fail('LEDGER_ARCHIVE_SHAPE_INVALID', 'retirement reason provenance is inconsistent.');
  return Object.freeze({ code: value.code, detail: value.detail, supersedingRequestIds: Object.freeze([...value.supersedingRequestIds]) });
}
function normalizeRetirement(value) {
  exact(value, ['targetKind', 'requestId', 'ruleKey', 'retiredAt', 'retiredBy', 'reason'], ['targetKind', 'requestId', 'retiredAt', 'retiredBy', 'reason'], 'retirement');
  const target = normalizeTarget(value.targetKind === 'rule'
    ? { targetKind: value.targetKind, requestId: value.requestId, ruleKey: value.ruleKey }
    : { targetKind: value.targetKind, requestId: value.requestId }, 'retirement');
  if (typeof value.retiredBy !== 'string' || !ACTOR_ID_RE.test(value.retiredBy)) fail('LEDGER_ARCHIVE_SHAPE_INVALID', 'retiredBy is invalid.');
  return Object.freeze({ ...target, retiredAt: timestamp(value.retiredAt, 'retiredAt'), retiredBy: value.retiredBy, reason: normalizeLegacyReason(value.reason) });
}
function normalizeArchive(value) {
  const v1 = plain(value) && value.schemaVersion === 1;
  exact(value, v1 ? ['$comment', 'schemaVersion', 'revision', 'updatedAt', 'maintainedBy', 'requests']
    : ['$comment', 'schemaVersion', 'revision', 'updatedAt', 'maintainedBy', 'requests', 'retirements'],
  v1 ? ['$comment', 'schemaVersion', 'revision', 'updatedAt', 'maintainedBy', 'requests']
    : ['$comment', 'schemaVersion', 'revision', 'updatedAt', 'maintainedBy', 'requests', 'retirements'], 'archive ledger');
  if (!Array.isArray(value.$comment) || ![1, ARCHIVE_SCHEMA_VERSION].includes(value.schemaVersion)
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || (value.updatedAt !== null && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))))
      || value.maintainedBy !== 'tools/ledger-archive.js') fail('LEDGER_ARCHIVE_SHAPE_INVALID', 'Archive ledger metadata is invalid.');
  const requests = validateRequestArray(value.requests, 'Archive ledger');
  const retirements = v1 ? [] : value.retirements;
  if (!Array.isArray(retirements) || retirements.length > MAX_RETIREMENTS) fail('LEDGER_ARCHIVE_SHAPE_INVALID', 'Archive retirements are invalid.');
  const seen = new Set();
  const normalizedRetirements = retirements.map(raw => {
    const retirement = normalizeRetirement(raw); const key = targetKey(retirement);
    if (seen.has(key)) fail('LEDGER_ARCHIVE_DUPLICATE_RETIREMENT', `Archive contains duplicate retirement ${key}.`);
    seen.add(key); return retirement;
  });
  return { ...value, schemaVersion: ARCHIVE_SCHEMA_VERSION, requests, retirements: normalizedRetirements };
}
function normalizeLedger(value) {
  if (!plain(value) || !Array.isArray(value.requests)) fail('LEDGER_ARCHIVE_SHAPE_INVALID', 'Active ledger must be an object with a requests array.');
  const requests = validateRequestArray(value.requests, 'Active ledger');
  return { ...value, requests };
}

// ---------------------------------------------------------------------------
// The overlay: append-only JSONL, hash-chained
// ---------------------------------------------------------------------------

const GENESIS_SHA256 = sha256('owner-request-disposition-events:genesis');

function eventCore(event) {
  const { eventSha256, ...rest } = event;
  return rest;
}
function chainHash(previousSha256, event) { return sha256(`${previousSha256}\n${canonical(eventCore(event))}`); }

function normalizeEvent(value, index) {
  const where = `overlay line ${index + 1}`;
  const allowed = ['schemaVersion', 'eventId', 'seq', 'at', 'actor', 'sessionId', 'disposition',
    'targetKind', 'requestId', 'ruleKey', 'reasonCode', 'detail', 'points', 'vetoesChecked',
    'supersedingRequestIds', 'evidence', 'quote', 'ledgerRevision', 'ledgerSha256', 'planSha256',
    'prevSha256', 'eventSha256'];
  if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key))) fail('LEDGER_ARCHIVE_OVERLAY_LINE_INVALID', `${where} has unknown fields.`);
  for (const key of ['schemaVersion', 'eventId', 'seq', 'at', 'actor', 'disposition', 'targetKind', 'requestId', 'detail', 'prevSha256', 'eventSha256']) {
    if (!Object.hasOwn(value, key)) fail('LEDGER_ARCHIVE_OVERLAY_LINE_INVALID', `${where} is missing ${key}.`);
  }
  if (value.schemaVersion !== OVERLAY_SCHEMA_VERSION || !Number.isSafeInteger(value.seq) || value.seq !== index + 1
      || typeof value.eventId !== 'string' || value.eventId.length === 0 || value.eventId.length > 64
      || !DISPOSITIONS.includes(value.disposition)
      || typeof value.actor !== 'string' || !ACTOR_ID_RE.test(value.actor)
      || (value.sessionId !== undefined && value.sessionId !== null && (typeof value.sessionId !== 'string' || !SESSION_ID_RE.test(value.sessionId)))
      || (value.reasonCode !== undefined && value.reasonCode !== null && !REASON_CODES.includes(value.reasonCode))
      || !/^[a-f0-9]{64}$/.test(String(value.prevSha256)) || !/^[a-f0-9]{64}$/.test(String(value.eventSha256))) {
    fail('LEDGER_ARCHIVE_OVERLAY_LINE_INVALID', `${where} is malformed.`);
  }
  timestamp(value.at, `${where} at`);
  shortText(value.detail, `${where} detail`);
  normalizeTarget(targetFields(value), `${where} target`);
  return value;
}

function readOverlay(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, raw: '', sha256: sha256('absent'), events: [] };
    fail('LEDGER_ARCHIVE_READ_FAILED', `Disposition overlay could not be read: ${path.basename(file)}.`, { cause: error?.code || 'UNKNOWN' });
  }
  const lines = raw.split('\n').filter(line => line.trim().length > 0);
  if (lines.length > MAX_EVENTS) fail('LEDGER_ARCHIVE_SHAPE_INVALID', `Disposition overlay holds more than ${MAX_EVENTS} events.`);
  let previous = GENESIS_SHA256;
  const events = lines.map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) fail('LEDGER_ARCHIVE_OVERLAY_LINE_INVALID', `overlay line ${index + 1} exceeds ${MAX_EVENT_BYTES} bytes.`);
    let parsed;
    try { parsed = JSON.parse(line); } catch { fail('LEDGER_ARCHIVE_OVERLAY_LINE_INVALID', `overlay line ${index + 1} is not valid JSON.`); }
    const event = normalizeEvent(parsed, index);
    // The chain is what makes an append-only file auditable: a rewritten or
    // reordered history cannot present itself as the original one.
    if (event.prevSha256 !== previous || event.eventSha256 !== chainHash(previous, event)) {
      fail('LEDGER_ARCHIVE_OVERLAY_CHAIN_BROKEN', `Disposition overlay hash chain breaks at line ${index + 1}; the history was edited in place.`);
    }
    previous = event.eventSha256;
    return Object.freeze(event);
  });
  return { exists: true, raw, sha256: sha256(raw), events: Object.freeze(events), headSha256: previous };
}

// Fold the event log into one current state per target. Nothing here reads a
// clock; the fold is pure and replayable, which is why a wrong retirement is
// undone by appending rather than by editing.
function projectOverlay(events, legacyRetirements = []) {
  const byTarget = new Map();
  function slot(target) {
    const key = targetKey(target);
    if (!byTarget.has(key)) {
      byTarget.set(key, {
        key,
        target: targetFields(target),
        disposition: null,
        reasonCode: null,
        detail: null,
        since: null,
        actor: null,
        sessionId: null,
        points: [],
        vetoesChecked: [],
        supersedingRequestIds: [],
        observations: new Set(),
        judgements: [],
        ownerConfirmations: [],
        contests: [],
        history: []
      });
    }
    return byTarget.get(key);
  }
  // Historical rule-only retirements from the pre-overlay archive are folded in
  // as `cold`, so nothing that was already retired quietly comes back to life.
  for (const retirement of legacyRetirements) {
    const state = slot(retirement);
    state.disposition = 'cold';
    state.reasonCode = { completed: 'settled', 'fully-superseded': 'superseded', 'owner-confirmed': 'owner-confirmed' }[retirement.reason.code];
    state.detail = retirement.reason.detail;
    state.since = retirement.retiredAt;
    state.actor = retirement.retiredBy;
    state.supersedingRequestIds = [...retirement.reason.supersedingRequestIds];
    state.history.push({ disposition: 'cold', at: retirement.retiredAt, actor: retirement.retiredBy, detail: retirement.reason.detail, source: 'legacy-archive' });
  }
  for (const event of events) {
    const state = slot(event);
    state.history.push({ disposition: event.disposition, at: event.at, actor: event.actor, sessionId: event.sessionId || null, detail: event.detail, reasonCode: event.reasonCode || null, source: 'overlay' });
    if (event.disposition === 'observe') { if (state.disposition === 'cooling') state.observations.add(event.sessionId || event.actor); continue; }
    if (event.disposition === 'judgement') { state.judgements.push({ actor: event.actor, sessionId: event.sessionId || null, quote: event.quote || '', at: event.at }); continue; }
    if (event.disposition === 'owner-confirmation') { state.ownerConfirmations.push({ actor: event.actor, at: event.at, detail: event.detail }); continue; }
    if (event.disposition === 'reinstate' || event.disposition === 'contest') {
      if (event.disposition === 'contest') state.contests.push({ actor: event.actor, sessionId: event.sessionId || null, at: event.at, detail: event.detail });
      state.disposition = null; state.reasonCode = null; state.detail = null; state.since = null; state.actor = null; state.sessionId = null;
      state.points = []; state.vetoesChecked = []; state.supersedingRequestIds = [];
      state.observations = new Set();
      // A contested or reinstated entry starts its case over. Keeping the old
      // judgement would let one rejected argument cool the entry again for free.
      state.judgements = []; state.ownerConfirmations = [];
      continue;
    }
    // cooling | cold | park
    state.disposition = event.disposition;
    state.reasonCode = event.reasonCode || null;
    state.detail = event.detail;
    state.since = event.at;
    state.actor = event.actor;
    state.sessionId = event.sessionId || null;
    state.points = event.points || [];
    state.vetoesChecked = event.vetoesChecked || [];
    state.supersedingRequestIds = event.supersedingRequestIds || [];
    // A new cooling window starts a new exposure count and a new contest
    // count. The permanent record of who contested it before stays in
    // `history`, where a reader looking at the entry cannot miss it.
    if (event.disposition === 'cooling') { state.observations = new Set(); state.contests = []; }
  }
  return byTarget;
}

function stateOf(byTarget, target) { return byTarget.get(targetKey(target)) || null; }
function retiredStates(byTarget) {
  return [...byTarget.values()].filter(state => RETIRED_DISPOSITIONS.has(state.disposition)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function waitSync(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }

function appendEvent(file, event) {
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) fail('LEDGER_ARCHIVE_EVENT_TOO_LARGE', `A disposition event exceeds ${MAX_EVENT_BYTES} bytes.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    let descriptor = null;
    try {
      descriptor = fs.openSync(file, 'a', 0o600);
      fs.writeSync(descriptor, line, null, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = null;
      return;
    } catch (error) {
      if (descriptor !== null) try { fs.closeSync(descriptor); } catch { /* best effort */ }
      if (!TRANSIENT_WRITE_CODES.has(error?.code) || attempt + 1 >= WRITE_ATTEMPTS) {
        fail('LEDGER_ARCHIVE_APPEND_FAILED', `Could not append to ${path.basename(file)}.`, { cause: error?.code || 'UNKNOWN' });
      }
      waitSync(25 * (attempt + 1));
    }
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function readFileSnapshot(file, { allowMissing = false } = {}) {
  try { const raw = fs.readFileSync(file, 'utf8'); return { exists: true, raw, sha256: sha256(raw) }; }
  catch (error) { if (allowMissing && error?.code === 'ENOENT') return { exists: false, raw: null, sha256: sha256('absent') }; fail('LEDGER_ARCHIVE_READ_FAILED', `Required file could not be read: ${path.basename(file)}.`, { cause: error?.code || 'UNKNOWN' }); }
}

function readPrecedentIds(files) {
  const ids = new Set();
  const sources = [];
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      fail('LEDGER_ARCHIVE_READ_FAILED',
        `Precedent file could not be read: ${path.basename(file)}; retirement refused because standing-precedent citations were not measured.`,
        { cause: error?.code || 'UNKNOWN' });
    }
    const found = raw.match(REQUEST_ID_RE) || [];
    for (const id of found) ids.add(id);
    sources.push({ file: path.basename(file), present: true, cited: new Set(found).size });
  }
  return { ids, sources: Object.freeze(sources) };
}

function readInputs({ ledgerFile, archiveFile, scopeStoreFile, overlayFile, precedentFiles }) {
  const activeSnapshot = readFileSnapshot(ledgerFile);
  const archiveSnapshot = readFileSnapshot(archiveFile, { allowMissing: true });
  const scopeSnapshot = readFileSnapshot(scopeStoreFile, { allowMissing: true });
  const ledger = normalizeLedger(parseJson(activeSnapshot.raw, 'Active ledger'));
  const archive = archiveSnapshot.exists ? normalizeArchive(parseJson(archiveSnapshot.raw, 'Archive ledger')) : normalizeArchive(emptyArchive());
  if (archive.requests.length > 0) {
    // Refusing loudly rather than ignoring it: these entries are missing from
    // the ledger because the old delete path removed them, and putting them
    // back is a ledger write this tool will not perform.
    fail('LEDGER_ARCHIVE_LEGACY_PAYLOAD_PRESENT',
      `${path.basename(archiveFile)} holds ${archive.requests.length} request payload(s) removed from the ledger by the retired delete path. Restoring them is a human repair; retirement is refused until it is done.`,
      { requestIds: archive.requests.map(request => request.id) });
  }
  const rules = scopeSnapshot.exists ? scopeStore.normalizeStore(parseJson(scopeSnapshot.raw, 'Owner scope store')).rules : [];
  const overlaySnapshot = readOverlay(overlayFile);
  const byTarget = projectOverlay(overlaySnapshot.events, archive.retirements);
  const precedent = readPrecedentIds(precedentFiles);
  return { activeSnapshot, archiveSnapshot, scopeSnapshot, overlaySnapshot, ledger, archive, rules, byTarget, precedent };
}

// ---------------------------------------------------------------------------
// THE PLANNER -- kept exactly as it was. It produced the right 48 candidates
// before the commit path was replaced, and it produces the same ones now.
// ---------------------------------------------------------------------------

function gateState(request) {
  if (!Object.hasOwn(request, 'gates')) return { allMet: true, issue: null };
  if (!Array.isArray(request.gates)) return { allMet: false, issue: 'gates is not an array' };
  for (let index = 0; index < request.gates.length; index += 1) if (!plain(request.gates[index]) || request.gates[index].met !== true) return { allMet: false, issue: `gate ${index + 1} is not met:true` };
  return { allMet: true, issue: null };
}
function candidateFor(request, superseded) {
  const gates = gateState(request);
  if (!gates.allMet) return request.status === 'done' ? { inconsistency: Object.freeze({ id: request.id, code: 'DONE_WITH_UNMET_GATE', reason: `status is done but ${gates.issue}; retained in the active ledger` }) } : {};
  if (request.status === 'done') return { candidate: Object.freeze({ targetKind: 'request', requestId: request.id, reason: Object.freeze({ code: 'completed', detail: 'status done and every declared gate is met:true', supersedingRequestIds: Object.freeze([]) }) }) };
  const resolution = superseded.get(request.id);
  if (!resolution) return {};
  return { candidate: Object.freeze({ targetKind: 'request', requestId: request.id, reason: Object.freeze({ code: 'fully-superseded', detail: `fully superseded by ${resolution.supersedingRequestIds.join(', ')}`, supersedingRequestIds: Object.freeze([...resolution.supersedingRequestIds]) }) }) };
}

function computeArchivePlan({ ledger, byTarget, rules, activeSnapshot, overlaySnapshot, scopeSnapshot, nowMs }) {
  const superseded = new Map(resolveFullySupersededRequests(rules, { nowMs }).map(result => [result.sourceRequestId, result]));
  const candidates = []; const inconsistencies = [];
  // A COOLING target stays on the candidate list, because `archive` on it is
  // the next step of the same lifecycle (cooling -> cold) and the mission
  // bridge will only confirm a target it can see in this list. Cold and parked
  // targets drop off: there is nothing left to advance.
  const settled = new Set(retiredStates(byTarget).filter(state => state.disposition !== 'cooling').map(state => state.key));
  for (const request of ledger.requests) {
    const outcome = candidateFor(request, superseded);
    if (outcome.inconsistency) inconsistencies.push(outcome.inconsistency);
    if (!outcome.candidate) continue;
    if (settled.has(targetKey(outcome.candidate))) continue;
    candidates.push(outcome.candidate);
  }
  const restorables = retiredStates(byTarget).map(state => state.target);
  const planCore = { activeSha256: activeSnapshot.sha256, overlaySha256: overlaySnapshot.sha256, scopeSha256: scopeSnapshot.sha256, candidates, restorables, inconsistencies };
  const result = {
    planSha256: sha256(JSON.stringify(planCore)),
    candidates: Object.freeze(candidates),
    restorables: Object.freeze(restorables),
    inconsistencies: Object.freeze(inconsistencies),
    // activeCount is the ledger's own length. It does not move when something
    // is retired, because retirement no longer removes anything.
    activeCount: ledger.requests.length,
    // archiveCount is how many targets the overlay currently holds out of the
    // active set -- cooling, cold or parked.
    archiveCount: restorables.length
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) fail('LEDGER_ARCHIVE_RESULT_TOO_LARGE', `Archive plan exceeds ${MAX_RESULT_BYTES} UTF-8 bytes.`);
  return Object.freeze(result);
}

// ---------------------------------------------------------------------------
// THE DECISION RULE (R-LIFECYCLE section 2, sharpened -- see the header of
// tests/ledger-archive.js and the report for exactly what changed and why).
// ---------------------------------------------------------------------------

function entryText(request) {
  return [request?.verbatim, request?.request, request?.interpretation]
    .filter(value => typeof value === 'string')
    .join('\n')
    .replace(EDITORIAL_BANNER_RE, ' ');
}
function verbatimOf(request) { return typeof request?.verbatim === 'string' ? request.verbatim : ''; }
function hasVerbatim(request) { return textShingles.normalize(verbatimOf(request)).length > 0; }
function declaredGates(request) { return Array.isArray(request?.gates) ? request.gates.filter(plain) : []; }
function provenanceUnclassified(request) {
  const value = request?.provenance?.class;
  return value === undefined || value === null || value === 'unclassified';
}
function clauseKindsOf(request) {
  const kinds = new Set();
  if (typeof request?.clauseKind === 'string') kinds.add(request.clauseKind);
  for (const gate of declaredGates(request)) if (typeof gate.clauseKind === 'string') kinds.add(gate.clauseKind);
  return kinds;
}
function gatesCoverVerbatimAttestation(request) {
  for (const source of [request, ...declaredGates(request)]) {
    if (source && typeof source.gatesCoverVerbatim === 'boolean') return source.gatesCoverVerbatim;
  }
  return null;
}

// Recurrence: a LATER entry restating an EARLIER one. Measured on this store,
// a ruleKey collision means supersession and never recurrence, so the detector
// is the 8-gram shingle matcher, not the rule index.
function computeRestatedIds(requests) {
  const shingleSets = requests.map(request => new Set(textShingles.shingles(textShingles.normalize(entryText(request)))));
  const restated = new Map();
  for (let earlier = 0; earlier < requests.length; earlier += 1) {
    const earlierShingles = shingleSets[earlier];
    if (earlierShingles.size === 0) continue;
    for (let later = earlier + 1; later < requests.length; later += 1) {
      let shared = 0;
      for (const shingle of shingleSets[later]) { if (earlierShingles.has(shingle)) { shared += 1; if (shared >= MIN_SHARED_SHINGLES) break; } }
      if (shared >= MIN_SHARED_SHINGLES) {
        if (!restated.has(requests[earlier].id)) restated.set(requests[earlier].id, []);
        restated.get(requests[earlier].id).push(requests[later].id);
      }
    }
  }
  return restated;
}

function signal(id, family, points, detail, { sufficient = false } = {}) {
  return Object.freeze({ id, family, points, detail, sufficient });
}
function checked(id, fired, detail) { return Object.freeze({ id, fired, detail }); }

/**
 * Score one target against the cold-storage rule. Pure: every input is data
 * already read, nothing is executed, and no clock is consulted.
 */
function scoreTarget({ target, request, peers, superseded, state, precedentIds, restatedIds, identity }) {
  const points = [];
  const vetoesChecked = [];
  const id = target.requestId;
  const peerById = peers instanceof Map ? peers : new Map();
  const supersedingIdsOf = resolution => (resolution?.supersedingRequestIds || []);

  if (target.targetKind === 'rule') {
    // A single clause is retired by explicit owner-confirmed instruction, not
    // by inference. Its entry keeps its verbatim and its other clauses.
    points.push(signal('O1', 'owner', 3, 'explicit per-clause retirement of a reconciled rule', { sufficient: true }));
  } else {
    const gates = declaredGates(request);
    const allMet = gates.length > 0 && gates.every(gate => gate.met === true);
    const allEvidenced = allMet && gates.every(gate => typeof gate.evidence === 'string' && gate.evidence.trim().length > 0);
    if (request?.status === 'done' && allMet && allEvidenced) {
      points.push(signal('M1', 'mechanical', 1, `status done, ${gates.length} declared gate(s) met:true, each carrying evidence`));
      const runRecord = gates.find(gate => TEST_RUN_EVIDENCE_RE.test(String(gate.evidence)));
      if (runRecord) points.push(signal('M1+', 'mechanical', 1, `gate evidence names a command and its result: ${String(runRecord.evidence).slice(0, 120)}`));
    } else if (request?.status === 'done' && allMet && !allEvidenced) {
      vetoesChecked.push(checked('M1', false, 'gates are met but at least one carries no evidence, so M1 scores nothing'));
    }

    const resolution = superseded.get(id);
    if (resolution) {
      const supersedingIds = supersedingIdsOf(resolution);
      // M2 IS ONLY SUFFICIENT WHEN THE SUPERSEDING ENTRY IS ITSELF LIVE AND
      // NAMES THE ID IT REPLACES. ruleKeys are hand-assigned, so a reused key
      // could otherwise retire a live requirement wearing his own later words
      // as authority -- harder to spot than a false "done", because the record
      // looks impeccable. Short of both, it scores 1 and needs a second family.
      const witness = supersedingIds
        .map(supersedingId => peerById.get(supersedingId))
        .filter(Boolean)
        .find(superseding => superseding.status !== 'done' && new RegExp(`\\b${id.replace('.', '\\.')}\\b`).test(entryText(superseding)));
      if (witness) points.push(signal('M2', 'mechanical', 2, `every clause superseded by live entry ${witness.id}, which names ${id}`, { sufficient: true }));
      else points.push(signal('M2-', 'mechanical', 1, `fully superseded by ${supersedingIds.join(', ')}, but no live superseding entry names ${id}`));
    }

    // `request` is null when the id is not in the ledger at all. That is a
    // typo, not an unadjudicable entry, and it must never score.
    if (request && !hasVerbatim(request) && declaredGates(request).length === 0 && provenanceUnclassified(request)) {
      points.push(signal('M3', 'mechanical', 2, 'no verbatim, no gates, provenance unclassified: nothing here can be adjudicated', { sufficient: true }));
    }
  }

  // J1 -- a completion judgement by someone other than the session asking for
  // the retirement, quoting the verbatim it claims to satisfy.
  const usableJudgement = (state?.judgements || []).find(judgement => {
    const judge = judgement.sessionId || judgement.actor;
    if (!judge || (identity && judge === identity)) return false;
    const quote = textShingles.normalize(judgement.quote || '');
    if (quote.length < MIN_JUDGEMENT_QUOTE_CHARS) return false;
    return textShingles.normalize(verbatimOf(request)).includes(quote);
  });
  if (usableJudgement) points.push(signal('J1', 'judged', 1, `independent completion judgement by ${usableJudgement.sessionId || usableJudgement.actor}, quoting the verbatim`));
  else if ((state?.judgements || []).length > 0) vetoesChecked.push(checked('J1', false, 'a judgement exists but is same-session or does not quote the verbatim, so it scores nothing'));

  if ((state?.ownerConfirmations || []).length > 0) {
    points.push(signal('O1', 'owner', 3, 'authenticated owner confirmation on file', { sufficient: true }));
  }

  // --- vetoes. Any one blocks retirement at any point count. ---------------
  const vetoes = [];
  function veto(vetoId, detail) { vetoes.push(Object.freeze({ id: vetoId, detail })); vetoesChecked.push(checked(vetoId, true, detail)); }

  const kinds = clauseKindsOf(request);
  if (kinds.has('grant') || kinds.has('prohibition')) veto('V1', 'entry carries a grant or prohibition clause; authorizations never cool');
  else vetoesChecked.push(checked('V1', false, 'no grant or prohibition clause declared'));

  const restatedBy = restatedIds.get(id);
  if (restatedBy && restatedBy.length > 0) veto('V2', `restated by ${restatedBy.slice(0, 5).join(', ')}; recurring, not finished`);
  else vetoesChecked.push(checked('V2', false, 'no later entry restates this one'));

  if (precedentIds.has(id)) veto('V3', 'cited as standing precedent in the current installation policy');
  else vetoesChecked.push(checked('V3', false, 'not cited as standing precedent'));

  if (request?.status === 'blocked-external') veto('V4', 'blocked-external with no recorded clearing of the blocker');
  else vetoesChecked.push(checked('V4', false, 'not blocked-external'));

  const attestation = gatesCoverVerbatimAttestation(request);
  if (attestation === false) veto('V5', 'gatesCoverVerbatim is attested false: the gates are known not to cover what he said');
  else vetoesChecked.push(checked('V5', false,
    attestation === null
      ? 'no gatesCoverVerbatim attestation on file; M1 alone therefore cannot satisfy the family span'
      : 'gates are attested to cover the verbatim'));

  const scored = points.filter(point => point.points > 0);
  const totalPoints = scored.reduce((sum, point) => sum + point.points, 0);
  const mechanicalPoints = scored.filter(point => point.family === 'mechanical').reduce((sum, point) => sum + point.points, 0);
  const families = [...new Set(scored.map(point => point.family))].sort();
  const sufficient = scored.filter(point => point.sufficient).sort((a, b) => b.points - a.points)[0] || null;
  const meetsThreshold = Boolean(sufficient)
    || (totalPoints >= COOLING_MIN_POINTS && mechanicalPoints >= 1 && families.length >= COOLING_MIN_FAMILIES);
  const reasonCode = sufficient
    ? { O1: 'owner-confirmed', M2: 'superseded', M3: 'unadjudicable' }[sufficient.id] || 'settled'
    : 'settled';
  const shortfall = meetsThreshold ? null
    : totalPoints < COOLING_MIN_POINTS ? `only ${totalPoints} point(s); ${COOLING_MIN_POINTS} required`
      : mechanicalPoints < 1 ? 'no mechanical point'
        : `points come from ${families.length} signal family (${families.join(', ')}); ${COOLING_MIN_FAMILIES} required, so "all gates met" alone can never retire anything`;

  return Object.freeze({
    target: targetFields(target),
    points: Object.freeze(scored),
    totalPoints,
    mechanicalPoints,
    families: Object.freeze(families),
    sufficientSignal: sufficient ? sufficient.id : null,
    supersedingRequestIds: Object.freeze(supersedingIdsOf(superseded.get(id))),
    vetoes: Object.freeze(vetoes),
    vetoesChecked: Object.freeze(vetoesChecked),
    reasonCode,
    decision: vetoes.length > 0 ? 'veto' : meetsThreshold ? 'cool' : 'hold',
    shortfall
  });
}

function scoreOf(inputs, target, { identity = null, nowMs } = {}) {
  const superseded = new Map(resolveFullySupersededRequests(inputs.rules, { nowMs }).map(result => [result.sourceRequestId, result]));
  const peers = new Map(inputs.ledger.requests.map(request => [request.id, request]));
  return scoreTarget({
    target,
    request: peers.get(target.requestId) || null,
    peers,
    superseded,
    state: stateOf(inputs.byTarget, target),
    precedentIds: inputs.precedent.ids,
    restatedIds: computeRestatedIds(inputs.ledger.requests),
    identity
  });
}

// ---------------------------------------------------------------------------
// What readers should withhold. This is the "erase from the surfaces agents
// read" half of the design, expressed as one function ledger-query can call.
// ---------------------------------------------------------------------------

function partitionRetired(requests, byTarget, { legacyReasonCodes = false } = {}) {
  const withheld = new Map();
  for (const state of byTarget.values()) {
    if (state.target.targetKind !== 'request' || !WITHHELD_DISPOSITIONS.has(state.disposition)) continue;
    withheld.set(state.target.requestId, state);
  }
  const active = []; const retiredRequests = [];
  for (const request of requests) (withheld.has(request.id) ? retiredRequests : active).push(request);
  const retirements = [];
  for (const state of retiredStates(byTarget)) {
    if (!WITHHELD_DISPOSITIONS.has(state.disposition)) continue;
    const code = state.reasonCode || 'settled';
    const mapped = legacyReasonCodes ? LEGACY_REASON_CODES[code] : code;
    const detail = legacyReasonCodes && mapped !== code ? `${code} — ${state.detail}`.slice(0, 300) : state.detail;
    // The legacy shape requires supersedingRequestIds to be non-empty exactly
    // when the code is fully-superseded, so the mapping carries them across.
    const supersedingRequestIds = mapped === 'fully-superseded' ? [...new Set(state.supersedingRequestIds || [])] : [];
    retirements.push(Object.freeze({
      ...state.target,
      retiredAt: state.since,
      retiredBy: state.actor,
      reason: Object.freeze({ code: mapped, detail, supersedingRequestIds: Object.freeze(supersedingRequestIds) })
    }));
  }
  return Object.freeze({ active: Object.freeze(active), retiredRequests: Object.freeze(retiredRequests), retirements: Object.freeze(retirements) });
}

// ---------------------------------------------------------------------------
// The one mutating entry point
// ---------------------------------------------------------------------------

function buildResult(plan, dryRun, target = null) { return Object.freeze({ ...plan, dryRun, appliedTarget: target, changedCount: target ? 1 : 0 }); }
function validRuleTarget(target, rules) { return target.targetKind === 'rule' && rules.some(rule => rule.sourceRequestId === target.requestId && rule.ruleKey === target.ruleKey); }

function makeEvent({ disposition, target, actor, sessionId, at, seq, detail, reasonCode, score, supersedingRequestIds, evidence, quote, ledger, ledgerSha256, planSha256, prevSha256 }) {
  const event = {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    seq,
    at,
    actor,
    sessionId: sessionId || null,
    disposition,
    targetKind: target.targetKind,
    requestId: target.requestId,
    ...(target.targetKind === 'rule' ? { ruleKey: target.ruleKey } : {}),
    reasonCode: reasonCode || null,
    detail,
    points: score ? score.points.map(point => ({ id: point.id, family: point.family, points: point.points, detail: point.detail })) : [],
    vetoesChecked: score ? score.vetoesChecked.map(item => ({ id: item.id, fired: item.fired, detail: item.detail })) : [],
    supersedingRequestIds: [...new Set(supersedingRequestIds || (score ? score.supersedingRequestIds : []))],
    evidence: evidence || [],
    quote: quote || null,
    ledgerRevision: Number.isSafeInteger(ledger?.revision) ? ledger.revision : null,
    ledgerSha256,
    planSha256: planSha256 || null,
    prevSha256,
    eventSha256: ''
  };
  event.eventSha256 = chainHash(prevSha256, event);
  return event;
}

function archiveLedger(input, dependencies = {}) {
  exact(input, ['operation', 'dryRun', 'expectedPlanSha256', 'target', 'retiredBy', 'actor', 'sessionId', 'why', 'quote', 'evidence'], ['operation', 'dryRun'], 'archive request');
  if (!OPERATIONS.has(input.operation) || typeof input.dryRun !== 'boolean'
      || (input.expectedPlanSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedPlanSha256))) fail('LEDGER_ARCHIVE_INPUT_INVALID', 'archive request is invalid.');
  const confirmed = CONFIRMED_OPERATIONS.has(input.operation);
  if (!input.dryRun && confirmed && (!Object.hasOwn(input, 'target') || !Object.hasOwn(input, 'expectedPlanSha256'))) fail('LEDGER_ARCHIVE_CONFIRMATION_REQUIRED', 'A fresh preview hash and one exact target are required.');
  if (!input.dryRun && !confirmed && !Object.hasOwn(input, 'target')) fail('LEDGER_ARCHIVE_INPUT_INVALID', 'One exact target is required.');
  const actor = input.actor === undefined ? input.retiredBy : input.actor;
  if (!input.dryRun && (typeof actor !== 'string' || !ACTOR_ID_RE.test(actor))) fail('LEDGER_ARCHIVE_TRUSTED_ACTOR_REQUIRED', 'A trusted acting agent is required.');
  if (input.dryRun && (input.target !== undefined || input.retiredBy !== undefined || input.actor !== undefined || input.expectedPlanSha256 !== undefined)) fail('LEDGER_ARCHIVE_INPUT_INVALID', 'Preview cannot carry target, actor, or confirmation hash.');
  const sessionId = input.sessionId === undefined || input.sessionId === null ? null : input.sessionId;
  if (sessionId !== null && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) fail('LEDGER_ARCHIVE_INPUT_INVALID', 'sessionId is invalid.');
  if (input.evidence !== undefined && (!Array.isArray(input.evidence) || input.evidence.length > 8 || input.evidence.some(item => typeof item !== 'string' || item.length > 300))) fail('LEDGER_ARCHIVE_INPUT_INVALID', 'evidence must be up to 8 short strings.');

  const target = input.target === undefined ? null : normalizeTarget(input.target);
  exact(dependencies, DEPENDENCY_KEYS, [], 'archive dependencies');
  const ledgerFile = path.resolve(dependencies.ledgerFile || DEFAULT_LEDGER_FILE);
  const archiveFile = path.resolve(dependencies.archiveFile || DEFAULT_ARCHIVE_FILE);
  const scopeStoreFile = path.resolve(dependencies.scopeStoreFile || DEFAULT_SCOPE_STORE_FILE);
  const overlayFile = path.resolve(dependencies.overlayFile || DEFAULT_OVERLAY_FILE);
  const precedentFiles = (dependencies.precedentFiles || DEFAULT_PRECEDENT_FILES).map(file => path.resolve(file));
  const clock = dependencies.clock || Date.now;
  const nowMs = clock();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('LEDGER_ARCHIVE_INPUT_INVALID', 'clock returned an invalid timestamp.');

  // The lock is on the OVERLAY, not on the ledger. This tool no longer writes
  // the ledger, so it has no business blocking the ledger's own writer, and a
  // lane can retire without touching his record at all.
  let lock;
  try { lock = ownerCapture.acquireLedgerLock(overlayFile); }
  catch (error) { fail('LEDGER_ARCHIVE_LOCKED', 'The disposition overlay is busy; retirement refused rather than racing its writer.', { cause: error?.code || 'UNKNOWN' }); }
  try {
    const inputs = readInputs({ ledgerFile, archiveFile, scopeStoreFile, overlayFile, precedentFiles });
    const plan = computeArchivePlan({ ...inputs, nowMs });
    if (input.dryRun) return buildResult(plan, true);
    if (confirmed && plan.planSha256 !== input.expectedPlanSha256) fail('LEDGER_ARCHIVE_PLAN_CHANGED', 'The ledger/overlay/scope snapshot changed after preview; run a new dry-run.');

    const state = stateOf(inputs.byTarget, target);
    const current = state?.disposition || null;
    const identity = sessionId || actor;
    let disposition; let detail; let reasonCode = null; let score = null;
    let judgementQuote = null; let supersedingRequestIds = null;

    if (input.operation === 'archive') {
      if (target.targetKind === 'rule' && !validRuleTarget(target, inputs.rules)) fail('LEDGER_ARCHIVE_TARGET_INELIGIBLE', 'This clause is not present in the reconciled rule corpus.');
      if (target.targetKind === 'request' && !inputs.ledger.requests.some(item => item.id === target.requestId)) fail('LEDGER_ARCHIVE_TARGET_INELIGIBLE', `${target.requestId} is not in the ledger.`);
      if (current === 'cold') fail('LEDGER_ARCHIVE_ALREADY_RETIRED', 'This exact target is already cold.');
      if (current === 'park') fail('LEDGER_ARCHIVE_TARGET_INELIGIBLE', 'This target is parked; reinstate it before retiring it.');
      if (current === 'cooling') {
        // COOLING -> COLD. Not time. Watchers.
        // A contest cannot be pending here: contesting clears the disposition,
        // so a contested entry is ACTIVE and has to be scored again from
        // scratch, with a fresh exposure window.
        const observations = state.observations.size;
        if (observations < COLD_EXPOSURE_QUORUM) {
          fail('LEDGER_ARCHIVE_EXPOSURE_INSUFFICIENT',
            `${target.requestId} has been seen by ${observations} of ${COLD_EXPOSURE_QUORUM} distinct sessions since it began cooling. Cold is earned by exposure, never by age.`,
            { observations, quorum: COLD_EXPOSURE_QUORUM });
        }
        disposition = 'cold';
        reasonCode = state.reasonCode || 'settled';
        supersedingRequestIds = state.supersedingRequestIds;
        detail = `cold after ${observations} uncontested session exposure(s); reason ${reasonCode}`;
      } else {
        // ACTIVE -> COOLING.
        const candidate = plan.candidates.find(item => targetKey(item) === targetKey(target)) || null;
        score = scoreOf(inputs, target, { identity, nowMs });
        if (score.decision === 'veto') fail('LEDGER_ARCHIVE_VETOED', `${target.requestId} is vetoed: ${score.vetoes.map(item => `${item.id} ${item.detail}`).join('; ')}`, { vetoes: score.vetoes });
        if (score.decision !== 'cool') fail('LEDGER_ARCHIVE_TARGET_INELIGIBLE', `${target.requestId} does not meet the cooling rule: ${score.shortfall}.`, { points: score.points, shortfall: score.shortfall });
        if (target.targetKind === 'request' && !candidate && score.sufficientSignal === null) fail('LEDGER_ARCHIVE_TARGET_INELIGIBLE', 'This request is not an eligible archive candidate.');
        disposition = 'cooling';
        reasonCode = score.reasonCode;
        detail = (candidate ? candidate.reason.detail : `${score.sufficientSignal || 'rule'}: ${score.points.map(point => point.id).join('+')}`).slice(0, 300);
      }
    } else if (input.operation === 'restore') {
      if (!RETIRED_DISPOSITIONS.has(current)) fail('LEDGER_ARCHIVE_NOT_RETIRED', 'This exact target is not retired.');
      disposition = 'reinstate';
      detail = shortText(input.why || `reinstated from ${current}`, 'why');
    } else if (input.operation === 'contest') {
      if (!RETIRED_DISPOSITIONS.has(current)) fail('LEDGER_ARCHIVE_NOT_RETIRED', 'This exact target is not retired, so there is nothing to contest.');
      disposition = 'contest';
      detail = shortText(input.why, 'why');
    } else if (input.operation === 'observe') {
      if (current !== 'cooling') fail('LEDGER_ARCHIVE_NOT_COOLING', 'Only a cooling target accumulates exposure.');
      if (!sessionId) fail('LEDGER_ARCHIVE_INPUT_INVALID', 'observe requires the sessionId that was shown the cooling line.');
      if (state.observations.has(sessionId)) fail('LEDGER_ARCHIVE_ALREADY_OBSERVED', `Session ${sessionId} has already been counted for ${target.requestId}. The quorum counts distinct sessions.`);
      disposition = 'observe';
      detail = shortText(input.why || `shown in the cooling line of session ${sessionId}`, 'why');
    } else if (input.operation === 'judge') {
      const quote = shortText(input.quote, 'quote');
      const request = inputs.ledger.requests.find(item => item.id === target.requestId);
      const normalizedQuote = textShingles.normalize(quote);
      if (normalizedQuote.length < MIN_JUDGEMENT_QUOTE_CHARS) fail('LEDGER_ARCHIVE_JUDGEMENT_UNQUOTED', `A completion judgement must quote at least ${MIN_JUDGEMENT_QUOTE_CHARS} characters of the verbatim it claims to satisfy.`);
      if (!request || !textShingles.normalize(verbatimOf(request)).includes(normalizedQuote)) fail('LEDGER_ARCHIVE_JUDGEMENT_UNQUOTED', `The quoted text does not appear in ${target.requestId}'s verbatim.`);
      disposition = 'judgement';
      detail = shortText(input.why || `completion judgement for ${target.requestId}`, 'why');
      judgementQuote = quote;
    } else {
      if (current === 'cold') fail('LEDGER_ARCHIVE_ALREADY_RETIRED', 'A cold target must be reinstated before it can be parked.');
      disposition = 'park';
      detail = shortText(input.why, 'why');
    }

    // Re-verify every snapshot the decision rested on, BEFORE the append.
    // Nothing here writes the ledger; this is the check that the ledger has
    // not moved underneath the judgement being recorded.
    const finalActive = readFileSnapshot(ledgerFile);
    const finalScope = readFileSnapshot(scopeStoreFile, { allowMissing: true });
    if (finalActive.sha256 !== inputs.activeSnapshot.sha256) fail('LEDGER_ARCHIVE_PLAN_CHANGED', 'The owner ledger changed during retirement preparation; run a new dry-run.');
    if (finalScope.sha256 !== inputs.scopeSnapshot.sha256) fail('LEDGER_ARCHIVE_PLAN_CHANGED', 'Owner scope rules changed during retirement preparation; run a new dry-run.');

    const event = makeEvent({
      disposition,
      target,
      actor,
      sessionId,
      at: new Date(nowMs).toISOString(),
      seq: inputs.overlaySnapshot.events.length + 1,
      detail,
      reasonCode,
      score,
      supersedingRequestIds,
      evidence: input.evidence,
      quote: judgementQuote,
      ledger: inputs.ledger,
      ledgerSha256: inputs.activeSnapshot.sha256,
      planSha256: plan.planSha256,
      prevSha256: inputs.overlaySnapshot.headSha256 || GENESIS_SHA256
    });
    appendEvent(overlayFile, event);

    // Read the whole overlay back. It must parse, chain-verify, and end with
    // exactly the event we wrote -- and the ledger must be byte-identical.
    const verify = readOverlay(overlayFile);
    const written = verify.events.at(-1);
    if (!written || written.eventSha256 !== event.eventSha256) fail('LEDGER_ARCHIVE_WRITE_VERIFY_FAILED', 'The appended disposition event did not read back.');
    if (readFileSnapshot(ledgerFile).sha256 !== inputs.activeSnapshot.sha256) fail('LEDGER_ARCHIVE_LEDGER_MUTATED', 'The owner ledger changed while a retirement was recorded. Retirement never writes it; investigate the other writer.');

    return buildResult(plan, false, target);
  } finally { lock?.release(); }
}

// ---------------------------------------------------------------------------
// Initialization, read paths, CLI
// ---------------------------------------------------------------------------

function initializeOverlay(dependencies = {}) {
  exact(dependencies, DEPENDENCY_KEYS, [], 'initialize dependencies');
  const overlayFile = path.resolve(dependencies.overlayFile || DEFAULT_OVERLAY_FILE);
  let lock;
  try { lock = ownerCapture.acquireLedgerLock(overlayFile); } catch { fail('LEDGER_ARCHIVE_LOCKED', 'Overlay initialization refused while the overlay is busy.'); }
  try {
    const existing = readOverlay(overlayFile);
    if (existing.exists) return Object.freeze({ initialized: false, overlayFile, events: existing.events.length });
    fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
    fs.writeFileSync(overlayFile, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return Object.freeze({ initialized: true, overlayFile, events: 0 });
  } finally { lock.release(); }
}

function readDispositions(dependencies = {}) {
  const ledgerFile = path.resolve(dependencies.ledgerFile || DEFAULT_LEDGER_FILE);
  const archiveFile = path.resolve(dependencies.archiveFile || DEFAULT_ARCHIVE_FILE);
  const scopeStoreFile = path.resolve(dependencies.scopeStoreFile || DEFAULT_SCOPE_STORE_FILE);
  const overlayFile = path.resolve(dependencies.overlayFile || DEFAULT_OVERLAY_FILE);
  const precedentFiles = (dependencies.precedentFiles || DEFAULT_PRECEDENT_FILES).map(file => path.resolve(file));
  return readInputs({ ledgerFile, archiveFile, scopeStoreFile, overlayFile, precedentFiles });
}

function explainTarget(target, dependencies = {}) {
  const inputs = readDispositions(dependencies);
  const nowMs = (dependencies.clock || Date.now)();
  const state = stateOf(inputs.byTarget, target);
  const score = scoreOf(inputs, target, { identity: dependencies.sessionId || null, nowMs });
  return Object.freeze({
    target: targetFields(target),
    disposition: state?.disposition || 'active',
    reasonCode: state?.reasonCode || null,
    detail: state?.detail || null,
    since: state?.since || null,
    observations: state ? [...state.observations].sort() : [],
    quorum: COLD_EXPOSURE_QUORUM,
    contests: state ? state.contests : [],
    judgements: state ? state.judgements : [],
    history: state ? state.history : [],
    score
  });
}

function parseArgs(argv) {
  const args = { command: 'preview', requestId: null, ruleKey: null, sessionId: null, actor: null, why: null, quote: null, help: false };
  const commands = new Set(['preview', 'explain', 'show', 'observe', 'contest', 'reinstate', 'judge', 'initialize']);
  const flags = { '--rule': 'ruleKey', '--session': 'sessionId', '--actor': 'actor', '--why': 'why', '--quote': 'quote' };
  let sawCommand = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (token === '--dry-run') { args.command = 'preview'; sawCommand = true; continue; }
    if (token === '--initialize') { args.command = 'initialize'; sawCommand = true; continue; }
    if (Object.hasOwn(flags, token)) {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.startsWith('--')) fail('LEDGER_ARCHIVE_ARGUMENT_INVALID', `${token} needs a value.`);
      args[flags[token]] = value; index += 1; continue;
    }
    if (token.startsWith('-')) fail('LEDGER_ARCHIVE_ARGUMENT_INVALID', `Unknown argument: ${token}`);
    if (!sawCommand && commands.has(token)) { args.command = token; sawCommand = true; continue; }
    if (args.requestId === null && isRequestId(token, { family: 'R' })) { args.requestId = token; continue; }
    fail('LEDGER_ARCHIVE_ARGUMENT_INVALID', `Unknown argument: ${token}`);
  }
  return args;
}

function printUsage(stream = process.stdout) {
  stream.write([
    'Usage: node tools/ledger-archive.js [preview|explain|show|observe|contest|reinstate|judge|initialize] [R-id] [flags]',
    '',
    '  preview (default, --dry-run)  list retirement candidates; changes nothing',
    '  explain <R-id>                the points, vetoes and exposure behind one target',
    '  show                          every target the overlay currently holds out of the active set',
    '  observe <R-id> --session <id> record that one session was shown this cooling entry',
    '  contest <R-id> --why "..."    return a cooling/cold entry to active; anybody, one append',
    '  reinstate <R-id> --why "..."  same, without recording a dispute',
    '  judge <R-id> --quote "..."    record an independent completion judgement (signal J1)',
    '  initialize                    create the append-only disposition overlay',
    '',
    'Retiring (cooling, then cold) stays behind the mission-bridge preview/confirm',
    'protocol. Reversal is deliberately cheaper than retirement.',
    `Tunables: cooling >= ${COOLING_MIN_POINTS} points across >= ${COOLING_MIN_FAMILIES} families with >= 1 mechanical;`,
    `          cold after ${COLD_EXPOSURE_QUORUM} distinct uncontested session exposures. No rule reads a clock.`,
    ''
  ].join('\n'));
}

function printResult(receipt, stdout = process.stdout, stderr = process.stderr) {
  for (const candidate of receipt.candidates) stdout.write(`${candidate.requestId}\t${candidate.reason.detail}\n`);
  for (const issue of receipt.inconsistencies) stderr.write(`INCONSISTENCY ${issue.id}\t${issue.reason}\n`);
  stderr.write(`retirement appends to ${DEFAULT_OVERLAY_FILE}; ${path.basename(DEFAULT_LEDGER_FILE)} is never rewritten\n`);
  stderr.write(`candidates enter COOLING, not COLD; cold needs ${COLD_EXPOSURE_QUORUM} distinct uncontested session exposures\n`);
}

function printExplain(explained, stdout = process.stdout) {
  const score = explained.score;
  stdout.write(`${explained.target.requestId}${explained.target.ruleKey ? `:${explained.target.ruleKey}` : ''}\t${explained.disposition}${explained.reasonCode ? ` (${explained.reasonCode})` : ''}\n`);
  for (const point of score.points) stdout.write(`  + ${point.id} ${point.points} [${point.family}] ${point.detail}\n`);
  for (const item of score.vetoesChecked) stdout.write(`  ${item.fired ? 'VETO' : '  ok'} ${item.id} ${item.detail}\n`);
  stdout.write(`  = ${score.totalPoints} point(s), ${score.mechanicalPoints} mechanical, families [${score.families.join(', ')}] -> ${score.decision}${score.shortfall ? `: ${score.shortfall}` : ''}\n`);
  if (explained.disposition === 'cooling') stdout.write(`  exposure ${explained.observations.length}/${explained.quorum} distinct sessions: ${explained.observations.join(', ') || 'none'}\n`);
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const core = dependencies.archiveDependencies || {};
  if (args.help) { printUsage(stdout); return null; }
  if (args.command === 'initialize') return initializeOverlay(core);
  const target = args.requestId === null ? null
    : normalizeTarget(args.ruleKey === null ? { targetKind: 'request', requestId: args.requestId } : { targetKind: 'rule', requestId: args.requestId, ruleKey: args.ruleKey });

  if (args.command === 'explain') {
    if (!target) fail('LEDGER_ARCHIVE_ARGUMENT_INVALID', 'explain needs one R-id.');
    const explained = explainTarget(target, { ...core, sessionId: args.sessionId });
    printExplain(explained, stdout);
    return explained;
  }
  if (args.command === 'show') {
    const inputs = readDispositions(core);
    const states = retiredStates(inputs.byTarget);
    for (const state of states) {
      stdout.write(`${state.key}\t${state.disposition}\t${state.reasonCode || '-'}\t${state.disposition === 'cooling' ? `${state.observations.size}/${COLD_EXPOSURE_QUORUM} sessions` : state.since}\t${state.detail || ''}\n`);
    }
    stderr.write(`${states.length} target(s) held out of the active set; every one is reversible with one append\n`);
    return Object.freeze({ held: states.length });
  }
  if (['observe', 'contest', 'reinstate', 'judge'].includes(args.command)) {
    if (!target) fail('LEDGER_ARCHIVE_ARGUMENT_INVALID', `${args.command} needs one R-id.`);
    const operation = args.command === 'reinstate' ? 'restore' : args.command;
    const result = archiveLedger({
      operation,
      dryRun: false,
      target,
      actor: args.actor || 'coordinator',
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.why ? { why: args.why } : {}),
      ...(args.quote ? { quote: args.quote } : {})
    }, core);
    stdout.write(`${args.command}\t${targetKey(target)}\tappended\n`);
    return result;
  }

  // preview: still routed through the mission bridge so the owner-gated policy
  // check and the durable audit record happen exactly as before.
  const createActions = dependencies.createMissionActions || require('../src/lib/mission-bridge/actions').createMissionActions;
  const actions = createActions({ roots: { primary: ROOT }, archiveLedger: input => archiveLedger(input, core) });
  const result = await actions.ledgerArchive({ operation: 'archive', dryRun: true });
  printResult(result.receipt, stdout, stderr);
  return result;
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error?.code || 'LEDGER_ARCHIVE_FAILED'}: ${error?.message || String(error)}\n`); process.exitCode = 1; });

module.exports = Object.freeze({
  ARCHIVE_SCHEMA_VERSION, OVERLAY_SCHEMA_VERSION,
  COLD_EXPOSURE_QUORUM, COOLING_MIN_POINTS, COOLING_MIN_FAMILIES, SIGNAL_FAMILIES, REASON_CODES, LEGACY_REASON_CODES,
  DISPOSITIONS, RETIRED_DISPOSITIONS, WITHHELD_DISPOSITIONS,
  DEFAULT_ARCHIVE_FILE, DEFAULT_LEDGER_FILE, DEFAULT_OVERLAY_FILE, DEFAULT_SCOPE_STORE_FILE, DEFAULT_PRECEDENT_FILES,
  LedgerArchiveError,
  archiveLedger, computeArchivePlan, emptyArchive, explainTarget, initializeOverlay, main,
  normalizeArchive, normalizeTarget, parseArgs, partitionRetired, printResult, projectOverlay, readDispositions, readOverlay, scoreTarget, targetKey
});

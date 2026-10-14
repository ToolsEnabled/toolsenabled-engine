'use strict';

// THE R LEDGER SURFACE BEHIND /Request, NOW AN ADAPTER.
//
// The four markdown ledgers this module used to write (reports/R-LEDGER.md and
// state/r-ledger/*.md) were a second store for the same fact the canonical
// JSON ledger already held. The owner ruled on 2026-09-02: ONE ledger with
// scope tiers. src/lib/owner-request-store.js is that ledger's single write API
// and tier reader; this file keeps every export name the six callers require
// by path (the product host, the standing-requests read, agent onboarding, the
// agent gate, and the two CLIs) and maps each onto the store. No markdown is
// read or written anywhere any more.
//
// What changed for a caller, and nothing else:
//   - ids are R-numbered for every scope (R1, R2, R2.1); RS/RT/RTH are retired,
//     and the R2000 floor with them -- a clean store files R1.
//   - a person-filed entry carries no filedBy; an agent-filed one names the
//     agent, exactly as before. A row an agent filed that still waits for the
//     person carries status 'proposed'.
//   - editRequest and removeRequest are the person's hand: this adapter passes
//     actor 'owner' to the store, which refuses anyone else. `decide` (approve
//     or decline) and `ensure` (create the empty ledger) are new here.

const store = require('./owner-request-store');
const { parseRequestId } = require('./request-id');

const SCOPES = store.SCOPES;
// Kept for callers that still read it; the single counter starts at 1 now.
const GLOBAL_FLOOR = 1;
// The valid statuses resolve() may set. Re-exported (not renamed, not copied)
// so a caller that only loads this adapter module -- the bridge verb Worker 4
// dispatches kind 'T'/'A' through -- reads the SAME set the store enforces,
// at call time, from the one place it is declared.
const RESOLUTION_STATUSES = store.RESOLUTION_STATUSES;
const ID_PREFIX = Object.freeze({ global: 'R', session: 'R', tree: 'R', thread: 'R' });
const SCOPE_WORD = store.SCOPE_WORD;
const SAFE_KEY = store.SAFE_KEY;
const MAX_FILED_BY_CHARS = store.MAX_FILED_BY_CHARS;
const RLedgerError = store.OwnerRequestStoreError;

function assertScope(scope) {
  if (!SCOPES.includes(scope)) throw new RLedgerError('R_LEDGER_SCOPE_INVALID', `scope must be one of ${SCOPES.join(', ')}.`);
}

function assertKey(scope, key) {
  if (scope === 'global') return null;
  if (typeof key !== 'string' || !SAFE_KEY.test(key)) {
    throw new RLedgerError('R_LEDGER_KEY_INVALID', `a ${scope} request needs its ${scope} id (letters, digits, . _ -).`);
  }
  return key;
}

/* Every scope lives in the one JSON file now; the scope and key still have to
   be well formed, as they always did. */
function ledgerPath(scope, key, options = {}) {
  assertScope(scope);
  assertKey(scope, key);
  return store.ledgerFileFor(options);
}

/* The id token -> { id, scope: null, prefix: 'R', number, segments, parentId }
   or null. The scope no longer rides in the id; findEntry reads it. */
function parseEntryId(token) {
  const parsed = parseRequestId(String(token || ''));
  if (!parsed || parsed.family !== 'R') return null;
  const above = parsed.segments.slice(0, -1);
  return {
    id: parsed.id,
    scope: null,
    prefix: 'R',
    number: parsed.rootNumber,
    segments: [...parsed.segments],
    parentId: parsed.segments.length ? `${parsed.root}${above.length ? `.${above.join('.')}` : ''}` : null
  };
}

function parseLedger() {
  throw new RLedgerError('R_LEDGER_MARKDOWN_RETIRED', 'the ledger is one JSON record now; read it with readLedger.');
}

/* A person-filed row carries no attribution; an agent-filed row names the agent. */
function adaptEntry(entry) {
  const { filedBy, ...rest } = entry;
  return Object.freeze(filedBy && filedBy !== 'owner' ? { ...rest, filedBy } : rest);
}

function readLedger(scope, key, options = {}) {
  const layer = store.readLayer(scope, key, options);
  return Object.freeze({ ...layer, entries: Object.freeze(layer.entries.map(adaptEntry)) });
}

function nextNumber(ledger, options = {}) {
  return store.nextRootNumber(ledger && typeof ledger.path === 'string' ? { ledgerFile: ledger.path } : options);
}

const nestEntries = store.nestEntries;

/* The /Task and /Ask families ride the same fileRequest a person's /Request
   always used, carrying one extra field: kind 'T' or 'A'. A payload without
   kind (every existing caller) takes the exact branch and the exact call it
   always took -- byte-for-byte the R path. kind 'P' is never dispatched here:
   a purchase record is never filed from the chat box. */
function fileRequest({ scope, key, words, filedBy, parentId, scopeLabel, source, proposed, why, now, kind, recurrence, difficulty } = {}, options = {}) {
  if (kind === 'T') {
    const filed = store.fileTask({
      scope, key, words, filedBy, scopeLabel, why, now, recurrence,
      ...(difficulty === undefined ? {} : { difficulty })
    }, options);
    return Object.freeze({ ...filed, filedBy: filed.filedBy === 'owner' ? null : filed.filedBy });
  }
  if (kind === 'A') {
    const filed = store.fileAsk({ scope, key, words, filedBy, scopeLabel, why, now }, options);
    return Object.freeze({ ...filed, filedBy: filed.filedBy === 'owner' ? null : filed.filedBy });
  }
  const filed = store.fileRequest({ scope, key, words, filedBy, parentId, scopeLabel, source, proposed, why, now }, options);
  return Object.freeze({ ...filed, filedBy: filed.filedBy === 'owner' ? null : filed.filedBy });
}

function findEntry(id, options = {}) {
  return store.findEntry(id, options);
}

function collectStack(selector = {}, options = {}) {
  return Object.freeze(store.collectStack(selector, options).map(layer => Object.freeze({
    ...layer,
    entries: Object.freeze(layer.entries.map(adaptEntry))
  })));
}

/** The person rewrites the words of one entry. */
function editRequest({ id, key, words, now } = {}, options = {}) {
  void key;
  return store.editRequest({ id, words, actor: 'owner', now }, options);
}

/** The person removes one entry and every refinement filed under it. */
function removeRequest({ id, key, now } = {}, options = {}) {
  void key;
  return store.removeRequest({ id, actor: 'owner', now }, options);
}

/** The person approves or declines one entry. */
function decide({ id, decision, reason, now } = {}, options = {}) {
  return store.decide({ id, decision, reason, actor: 'owner', now }, options);
}

/** The person marks one entry resolved (in-progress, partial, blocked-external,
 * done, not-possible-as-asked or superseded), the same shape as decide. */
function resolve({ id, status, reason, now } = {}, options = {}) {
  return store.resolve({ id, status, reason, actor: 'owner', now }, options);
}

function ensure(options = {}) {
  return store.ensureLedger(options);
}

function readAll(selector = {}, options = {}) {
  return store.readAll({ ...options, ...selector });
}

function verifyHistory(options = {}) {
  return store.verifyHistory(options);
}

module.exports = Object.freeze({
  SCOPES,
  GLOBAL_FLOOR,
  RESOLUTION_STATUSES,
  ID_PREFIX,
  SCOPE_WORD,
  SAFE_KEY,
  MAX_FILED_BY_CHARS,
  RLedgerError,
  ledgerPath,
  parseEntryId,
  parseLedger,
  readLedger,
  nextNumber,
  nestEntries,
  fileRequest,
  findEntry,
  collectStack,
  editRequest,
  removeRequest,
  decide,
  resolve,
  ensure,
  readAll,
  verifyHistory
});

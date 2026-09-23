'use strict';

// THE THREE PLACES THIS PROJECT'S ANSWERS ACTUALLY LIVE, AND THE ONE LIST THAT
// NAMES THEM.
//
// R1246. Today a session that wants to know "did the owner already say
// something about X" has three unrelated moves available and no single one that
// is honest about what it did not look at:
//
//   * `node tools/prior-work-index.js` reads docs/, reports/ and context/ as
//     whole FILES. reports/OWNER-REQUEST-LEDGER.json is 1.3 MB of 560 owner
//     requests, and the index reads a bounded 96 KB head of it as ONE document.
//     So "what did he say about the spend cap" cannot reach R-number granularity
//     at all -- the verbatims are on disk and unreachable.
//   * The agent-coord board (durable memory) is searched by a SQL `LIKE '%x%'`
//     over key/note/tags/value with no ranking, no stemming, and a hard cap of
//     20 rows.
//   * search.query is a semantic vector index over source files that knows
//     nothing about either.
//
// A session therefore asks one of the three, gets nothing, and concludes
// nothing exists. That is the absence-read-as-consent class this codebase has
// now hit nine times, and it is what made four nights of trademark research get
// redone.
//
// THIS MODULE IS THE SOURCE REGISTRY, and it is deliberately a closed list.
// A source that is not in it is not searched, and a source that is in it but
// carries no settings classification is WITHHELD rather than searched -- see
// settings-gate.js. Adding a knowledge source is therefore a two-file act
// (here, and config/settings-registry.json), which is exactly the property
// R1248 asks for: "a module added tomorrow is withheld until classified".
//
// WHAT IS NOT HERE, ON PURPOSE
// ----------------------------
// docs/ is NOT re-indexed into this module's FTS store. tools/prior-work-index.js
// already owns that corpus, already derives itself from disk with no refresh
// step, and already returns the hit/miss/unknown algebra this surface is built
// on (R1237 C7). Building a second docs index would produce two answers that
// can disagree about the same question, and the disagreement would be silent.
// So `docs` is a DELEGATED source: this surface asks the module that owns it
// and folds the answer in. The FTS store owns only the two sources that nothing
// indexes today -- the request ledger and the coordination board.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { rootPath } = require('../../src/lib/runtime');
const { sha256, looksSecret, toPosix } = require('../grepsaver-lib');

// Bounds. A single document's indexed body is capped so one 200 KB ledger entry
// cannot dominate the term statistics of a 560-entry corpus, and so the store
// stays a cache rather than a second copy of the tree.
const MAX_BODY_CHARS = 16 * 1024;
const MAX_TITLE_CHARS = 160;
const MAX_DOCUMENTS_PER_SOURCE = 20000;

class SourceUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceUnavailableError';
    this.code = code;
  }
}

function unavailable(code, message) {
  throw new SourceUnavailableError(code, message);
}

/**
 * Drop secret-shaped LINES, never the whole document.
 *
 * The owner's verbatim words are the entire point of the ledger source, so
 * nothing here paraphrases or truncates meaning. But a line that looks like a
 * bearer token or a private key must not be copied into a second store, even
 * from a file the caller could open directly -- the same posture
 * tools/grepsaver-orient.js takes.
 */
function redactLines(text) {
  const value = text === null || text === undefined ? '' : String(text);
  if (!value) return '';
  const lines = value.split('\n');
  const kept = [];
  for (const line of lines) {
    if (looksSecret(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function clamp(text, max) {
  const value = text === null || text === undefined ? '' : String(text);
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function flattenForIndex(value, depth = 0) {
  if (value === null || value === undefined) return '';
  if (depth > 6) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(item => flattenForIndex(item, depth + 1)).join('\n');
  if (typeof value === 'object') {
    const parts = [];
    for (const [key, item] of Object.entries(value)) {
      parts.push(`${key}: ${flattenForIndex(item, depth + 1)}`);
    }
    return parts.join('\n');
  }
  return '';
}

// --------------------------------------------------------------------------
// ledger -- reports/OWNER-REQUEST-LEDGER.json, one document PER REQUEST
// --------------------------------------------------------------------------

// Two resolutions, because the ledger moved. runtime-state-root.js routes
// `reports/` to the per-user state root in a packaged install, while
// tools/ledger-query.js still joins it onto the program root, which is correct
// in a source checkout. Trying the state-aware path first and the program root
// second covers both without either tree having to know which one it is -- and
// a run that finds NEITHER reports unavailable rather than empty.
function ledgerCandidates(options = {}) {
  if (options.ledgerPath) {
    return [{ role: 'active', file: path.resolve(options.ledgerPath) }];
  }
  const names = [
    ['active', 'OWNER-REQUEST-LEDGER.json'],
    ['archive', 'OWNER-REQUEST-LEDGER-ARCHIVE.json'],
  ];
  const roots = [];
  try { roots.push(rootPath('reports')); } catch { /* program root is appended below regardless */ }
  roots.push(path.resolve(__dirname, '..', '..', 'reports'));

  const out = [];
  for (const [role, name] of names) {
    for (const root of roots) {
      const file = path.join(root, name);
      if (fs.existsSync(file)) { out.push({ role, file }); break; }
    }
  }
  return out;
}

function ledgerFingerprint(options = {}) {
  const candidates = ledgerCandidates(options);
  const active = candidates.find(entry => entry.role === 'active');
  if (!active) {
    unavailable('LEDGER_FILE_ABSENT',
      'reports/OWNER-REQUEST-LEDGER.json could not be found from either the state root or the program root, '
      + 'so no claim can be made about what the owner has or has not asked for.');
  }
  const parts = [];
  for (const entry of candidates) {
    let stat;
    try { stat = fs.statSync(entry.file); } catch (error) {
      unavailable('LEDGER_FILE_UNREADABLE', `${toPosix(entry.file)} could not be stat'ed (${error.code || 'unknown'}).`);
    }
    // Cached results carry locators relative to this program. Moving an
    // unchanged ledger from the checkout into the configured state root must
    // refresh those locators even when its size and timestamp stay identical.
    parts.push(`${entry.role}:${toPosix(path.resolve(entry.file))}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
  }
  return sha256(parts.join('|'));
}

function ledgerDocuments(options = {}) {
  const candidates = ledgerCandidates(options);
  if (!candidates.some(entry => entry.role === 'active')) {
    unavailable('LEDGER_FILE_ABSENT', 'reports/OWNER-REQUEST-LEDGER.json could not be found.');
  }
  const documents = [];
  for (const entry of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
    } catch (error) {
      // A ledger we cannot parse is an UNKNOWN. Reporting the requests we did
      // manage to read as if they were all of them is how a partial read
      // becomes a confident "he never asked for that".
      unavailable('LEDGER_UNPARSEABLE', `${toPosix(entry.file)} is present but could not be parsed: ${error.message}`);
    }
    const requests = Array.isArray(parsed && parsed.requests) ? parsed.requests : null;
    if (!requests) {
      unavailable('LEDGER_SHAPE_UNEXPECTED', `${toPosix(entry.file)} has no requests array.`);
    }
    for (const request of requests) {
      if (!request || typeof request !== 'object') {
        unavailable('LEDGER_SHAPE_UNEXPECTED', `${toPosix(entry.file)} contains a request that is not an object.`);
      }
      const id = typeof request.id === 'string' ? request.id : null;
      if (!id) {
        unavailable('LEDGER_SHAPE_UNEXPECTED', `${toPosix(entry.file)} contains a request with no string id.`);
      }
      if (documents.length >= MAX_DOCUMENTS_PER_SOURCE) {
        unavailable('LEDGER_DOCUMENT_LIMIT_EXCEEDED',
          `${toPosix(entry.file)} contains more than ${MAX_DOCUMENTS_PER_SOURCE} indexable requests, so the ledger cannot be fully enumerated.`);
      }
      const gates = Array.isArray(request.gates) ? request.gates : [];
      const provenanceClass = request.provenance && typeof request.provenance.class === 'string'
        ? request.provenance.class : 'unrecorded';
      const bodyParts = [
        request.verbatim ? `verbatim: ${request.verbatim}` : '',
        request.request ? `interpretation: ${request.request}` : '',
        gates.length ? `gates: ${flattenForIndex(gates)}` : '',
        `provenance: ${provenanceClass}`,
      ].filter(Boolean);
      documents.push({
        docId: id,
        // Identity carries the R-number itself, so `R1246` finds R1246 exactly.
        identity: `${id} ${request.scope || ''} ${request.status || ''} ${provenanceClass}`.trim(),
        title: clamp(redactLines(String(request.request || request.verbatim || id)).replace(/\s+/g, ' ').trim(), MAX_TITLE_CHARS),
        body: clamp(redactLines(bodyParts.join('\n')), MAX_BODY_CHARS),
        locator: `${toPosix(path.relative(path.resolve(__dirname, '..', '..'), entry.file)) || path.basename(entry.file)}#${id}`,
        updatedAt: (request.provenance && request.provenance.recordedAt) || null,
      });
    }
  }
  return documents;
}

// --------------------------------------------------------------------------
// board -- the agent-coord durable memory namespace (and its neighbours)
// --------------------------------------------------------------------------

function boardStatePath(options = {}) {
  if (options.statePath) return path.resolve(options.statePath);
  const configured = typeof process.env.TOOLSENABLED_STATE_PATH === 'string'
    ? process.env.TOOLSENABLED_STATE_PATH.trim() : '';
  if (configured) return path.resolve(configured);
  return rootPath('state', 'toolsenabled.sqlite3');
}

// Read-only, always. This DB is the live transactional store that the MCP
// server writes; opening it read/write from a retrieval path would create WAL
// sidecars next to somebody else's live database for the sake of a query.
function openBoard(options = {}) {
  const file = boardStatePath(options);
  if (!fs.existsSync(file)) {
    // A MISSING store is NOT an empty board. The board may live on another host
    // entirely (the remote bridge writes one), and claiming "no agent has noted
    // this" from a file that is not here is precisely the false-MISS this
    // surface exists to make impossible.
    unavailable('BOARD_STORE_ABSENT',
      `The durable-memory store ${toPosix(file)} is not present, so the coordination board was never consulted.`);
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  } catch (error) {
    unavailable('BOARD_STORE_UNREADABLE', `The durable-memory store could not be opened read-only (${error.code || error.message}).`);
  }
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'").get();
    if (!table) {
      db.close();
      unavailable('BOARD_TABLE_ABSENT',
        'The durable-memory store has no memory_entries table, so the coordination board has never been initialised here.');
    }
  } catch (error) {
    try { db.close(); } catch { /* already gone */ }
    if (error instanceof SourceUnavailableError) throw error;
    unavailable('BOARD_STORE_UNREADABLE', `The durable-memory schema could not be inspected (${error.code || error.message}).`);
  }
  return { db, file };
}

function boardFingerprint(options = {}) {
  const { db } = openBoard(options);
  try {
    const row = db.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(updated_at_ms), 0) AS m FROM memory_entries').get();
    return sha256(`${row.c}:${row.m}`);
  } catch (error) {
    unavailable('BOARD_STORE_UNREADABLE', `The coordination board could not be counted (${error.code || error.message}).`);
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }
}

function boardDocuments(options = {}) {
  const { db } = openBoard(options);
  try {
    const rows = db.prepare(
      'SELECT namespace, entry_key, value_json, note, tags_json, updated_at_ms FROM memory_entries ORDER BY updated_at_ms DESC LIMIT ?'
    ).all(MAX_DOCUMENTS_PER_SOURCE + 1);
    if (rows.length > MAX_DOCUMENTS_PER_SOURCE) {
      unavailable('BOARD_DOCUMENT_LIMIT_EXCEEDED',
        `The coordination board contains more than ${MAX_DOCUMENTS_PER_SOURCE} entries, so it cannot be fully enumerated.`);
    }
    return rows.map(row => {
      let tags = '';
      try {
        const parsed = JSON.parse(row.tags_json || '[]');
        if (!Array.isArray(parsed) || parsed.some(tag => typeof tag !== 'string')) {
          unavailable('BOARD_ENTRY_UNPARSEABLE',
            `The coordination board entry ${row.namespace}/${row.entry_key} has invalid tags JSON.`);
        }
        tags = parsed.join(' ');
      } catch (error) {
        if (error instanceof SourceUnavailableError) throw error;
        unavailable('BOARD_ENTRY_UNPARSEABLE',
          `The coordination board entry ${row.namespace}/${row.entry_key} has unparseable tags JSON (${error.message}).`);
      }
      let value = '';
      try {
        value = flattenForIndex(JSON.parse(row.value_json));
      } catch (error) {
        unavailable('BOARD_ENTRY_UNPARSEABLE',
          `The coordination board entry ${row.namespace}/${row.entry_key} has unparseable value JSON (${error.message}).`);
      }
      return {
        docId: `${row.namespace}/${row.entry_key}`,
        identity: `${row.namespace} ${row.entry_key} ${tags}`.trim(),
        title: clamp(redactLines(String(row.note || row.entry_key)).replace(/\s+/g, ' ').trim(), MAX_TITLE_CHARS),
        body: clamp(redactLines([row.note ? `note: ${row.note}` : '', tags ? `tags: ${tags}` : '', value].filter(Boolean).join('\n')), MAX_BODY_CHARS),
        locator: `memory:${row.namespace}/${row.entry_key}`,
        updatedAt: Number.isFinite(row.updated_at_ms) ? new Date(row.updated_at_ms).toISOString() : null,
      };
    });
  } catch (error) {
    if (error instanceof SourceUnavailableError) throw error;
    unavailable('BOARD_STORE_UNREADABLE', `The coordination board could not be read (${error.code || error.message}).`);
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }
}

// --------------------------------------------------------------------------
// docs -- DELEGATED to tools/prior-work-index.js (R1237 C7), never duplicated
// --------------------------------------------------------------------------

function docsSearch(topic, options = {}) {
  let priorWork;
  try {
    priorWork = require('../prior-work-index').query(topic, {
      limit: options.limit || 8,
      ...(options.docsRoot ? { root: options.docsRoot } : {}),
      ...(options.noWrite === true ? { noWrite: true } : {}),
    });
  } catch (error) {
    unavailable('DOCS_INDEX_FAILED', `The prior-work index could not be consulted: ${error.message}`);
  }
  if (priorWork.outcome === 'unknown') {
    unavailable('DOCS_CORPUS_INCOMPLETE', priorWork.why || `the prior-work index returned ${priorWork.reason}`);
  }
  return {
    documentsConsulted: priorWork.indexedFileCount || 0,
    delegatedTo: 'tools/prior-work-index.js',
    results: (priorWork.results || []).map(hit => ({
      source: 'docs',
      docId: hit.path,
      title: hit.title,
      locator: hit.path,
      updatedAt: hit.modified || null,
      score: hit.score,
      matchedTerms: hit.matchedTerms || [],
      snippet: (hit.headings || []).join(' · ') || null,
    })),
    upstream: { outcome: priorWork.outcome, reason: priorWork.reason, corpusFingerprint: priorWork.corpusFingerprint },
  };
}

// --------------------------------------------------------------------------

const SOURCES = Object.freeze([
  Object.freeze({
    id: 'ledger',
    kind: 'indexed',
    settingId: 'retrieval.search_request_ledger',
    label: 'the owner request ledger (R-numbers and verbatims)',
    holds: 'every recorded owner directive, its verbatim wording, its interpretation, its gates and its provenance class',
    fingerprint: ledgerFingerprint,
    documents: ledgerDocuments,
  }),
  Object.freeze({
    id: 'board',
    kind: 'indexed',
    settingId: 'retrieval.search_coordination_board',
    label: 'the agent coordination board (durable memory notes)',
    holds: 'the durable-memory entries agents write to reach each other, including territory claims and help requests',
    fingerprint: boardFingerprint,
    documents: boardDocuments,
  }),
  Object.freeze({
    id: 'docs',
    kind: 'delegated',
    settingId: 'retrieval.search_documents',
    label: 'project documents and reports (docs/, reports/, context/)',
    holds: 'written-up research, designs, runbooks and lane reports',
    search: docsSearch,
  }),
]);

const SOURCE_BY_ID = new Map(SOURCES.map(source => [source.id, source]));

module.exports = Object.freeze({
  MAX_BODY_CHARS,
  MAX_DOCUMENTS_PER_SOURCE,
  MAX_TITLE_CHARS,
  SOURCES,
  SOURCE_BY_ID,
  SourceUnavailableError,
  boardStatePath,
  clamp,
  flattenForIndex,
  ledgerCandidates,
  redactLines,
});

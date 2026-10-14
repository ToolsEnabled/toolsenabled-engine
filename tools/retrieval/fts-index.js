'use strict';

// THE FULL-TEXT STORE FOR THE TWO SOURCES NOTHING INDEXES TODAY.
//
// SQLite FTS5, through node:sqlite -- the same DatabaseSync that src/lib/search.js
// and src/lib/state-store.js already use. NO NEW DEPENDENCY, and deliberately NO
// EMBEDDINGS: the question this surface answers ("has the owner said anything
// about X", "has an agent already claimed X") is answered by the words people
// actually used, and a vector index over 560 owner verbatims would blur exactly
// the identity -- R-numbers, key names, namespaces -- that makes an answer
// citable. Where a meaning-based backend WOULD help is re-ranking, and that is
// a declared seam in backends.js rather than a rewrite of this file.
//
// THE INDEX IS A CACHE, AND IT IS DERIVED
// ---------------------------------------
// tools/prior-work-index.js states the rule this file obeys: "If keeping this
// current requires anybody to remember to do anything, it will fall behind --
// it already did, twice." So there is no refresh command you must run before a
// query is correct. Every query re-fingerprints each source cheaply (a stat for
// the ledger, a COUNT/MAX for the board) and rebuilds only the sources that
// moved. `node tools/recall-index.js` exists to do that work AHEAD of time and
// to report on it, never as a precondition for a correct answer.
//
// AND A WRITE FAILURE IS NOT A MISS
// ---------------------------------
// Roughly ten lanes share this tree and the state directory is on a Windows
// filesystem with an antivirus scanner in it. If the on-disk store cannot be
// opened or written, the query builds an in-memory FTS5 index instead and says
// so in the packet. Turning "I could not write my cache" into "this topic does
// not exist" is the failure this whole surface is a response to.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { rootPath, ensureDir } = require('../../src/lib/runtime');
const { SourceUnavailableError } = require('./sources');

const SCHEMA_VERSION = 'honest-retrieval-fts-v1';

// Column weights for bm25(). Identity beats title beats body, for the reason
// tools/prior-work-index.js documents at WEIGHT_PATH: naming is an act of
// intent. `R1246` in a request's identity is a much stronger claim to the topic
// "R1246" than a body that mentions it in passing, and ranking those equally is
// how a trademark-cost question got answered with a CSV about alarm clocks.
const WEIGHT_IDENTITY = 8.0;
const WEIGHT_TITLE = 4.0;
const WEIGHT_BODY = 1.0;

// A term appearing in this fraction of the indexed corpus describes the corpus,
// not the topic. Same constant and same reasoning as prior-work-index.
const COMMON_TERM_FRACTION = 0.4;
// Bounded candidate window: bm25 ordering is applied by SQLite, so the tail
// beyond this cannot outrank what is inside it.
const MAX_CANDIDATES = 200;

// Aligned with tools/prior-work-index.js's list on purpose. Two discovery
// surfaces that disagree about whether "how" is a searchable word give two
// different answers to the same question, and the disagreement is invisible.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'at',
  'with', 'how', 'what', 'where', 'why', 'when', 'who', 'do', 'does', 'did', 'i',
  'we', 'my', 'this', 'that', 'these', 'those', 'be', 'am', 'are', 'was', 'were',
  'can', 'could', 'should', 'would', 'will', 'get', 'got', 'find', 'show', 'me',
  'about', 'from', 'by', 'as', 'if', 'not', 'no', 'yes', 'any', 'all', 'has',
  'have', 'had', 'been', 'being', 'but', 'so', 'than', 'then', 'there', 'here',
  'you', 'your', 'our', 'us', 'its', 'his', 'her', 'they', 'them', 'up', 'out',
  'into', 'over', 'under', 'more', 'most', 'some', 'such', 'only', 'own', 'same',
  'too', 'very', 'just', 'now', 'also', 'md', 'json', 'http', 'https', 'www',
]);

/**
 * Split a query the way FTS5's unicode61 tokenizer splits a document.
 *
 * This has to MATCH the tokenizer, not merely resemble it: a query term the
 * index could never contain produces a confident MISS for a document that is
 * sitting right there. unicode61 breaks on every non-alphanumeric character,
 * underscore included, so `agent_coord` is two tokens in the store and must be
 * two tokens in the query.
 */
function tokenize(text) {
  const out = [];
  for (const word of String(text === null || text === undefined ? '' : text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word) continue;
    if (word.length < 2) continue;
    if (STOPWORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

function defaultDbPath() {
  const configured = typeof process.env.TOOLSENABLED_RETRIEVAL_DB === 'string'
    ? process.env.TOOLSENABLED_RETRIEVAL_DB.trim() : '';
  if (configured) return path.resolve(configured);
  return rootPath('state', 'honest-retrieval.sqlite');
}

function applySchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS store_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);');
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5("
    + "source UNINDEXED, docId UNINDEXED, locator UNINDEXED, updatedAt UNINDEXED, "
    + "identity, title, body, tokenize='unicode61');");
  db.exec('CREATE TABLE IF NOT EXISTS source_state ('
    + 'source TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, documentCount INTEGER NOT NULL, indexedAt INTEGER NOT NULL);');
  db.prepare('INSERT OR REPLACE INTO store_meta(k, v) VALUES(?, ?)').run('schemaVersion', SCHEMA_VERSION);
}

function schemaMatches(db) {
  try {
    const row = db.prepare("SELECT v FROM store_meta WHERE k = 'schemaVersion'").get();
    return Boolean(row) && row.v === SCHEMA_VERSION;
  } catch {
    return false;
  }
}

function resetStore(db) {
  db.exec('DROP TABLE IF EXISTS docs;');
  db.exec('DROP TABLE IF EXISTS source_state;');
  db.exec('DROP TABLE IF EXISTS store_meta;');
  applySchema(db);
}

/**
 * Open the store. Falls back to an in-memory index, never to an error and never
 * to silence.
 */
function openStore(options = {}) {
  if (options.forceMemory) {
    const db = new DatabaseSync(':memory:', { allowExtension: false });
    applySchema(db);
    return { db, storage: 'memory', dbPath: ':memory:', why: 'the caller asked for an in-memory index' };
  }
  const dbPath = options.dbPath ? path.resolve(options.dbPath) : defaultDbPath();
  try {
    ensureDir(path.dirname(dbPath));
    const db = new DatabaseSync(dbPath, { allowExtension: false });
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    if (!schemaMatches(db)) resetStore(db); else applySchema(db);
    return { db, storage: 'file', dbPath, why: null };
  } catch (error) {
    const db = new DatabaseSync(':memory:', { allowExtension: false });
    applySchema(db);
    return {
      db,
      storage: 'memory',
      dbPath,
      why: `the on-disk index at ${dbPath} could not be opened (${error.code || error.message}), so this answer was `
        + 'computed from a fresh in-memory index instead. The answer is correct; only the cache was lost.',
    };
  }
}

function storedFingerprint(db, sourceId) {
  try {
    const row = db.prepare('SELECT fingerprint, documentCount FROM source_state WHERE source = ?').get(sourceId);
    return row || null;
  } catch {
    return null;
  }
}

function replaceSource(db, sourceId, documents, fingerprint) {
  const insert = db.prepare(
    'INSERT INTO docs(source, docId, locator, updatedAt, identity, title, body) VALUES(?,?,?,?,?,?,?)'
  );
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM docs WHERE source = ?').run(sourceId);
    for (const document of documents) {
      insert.run(
        sourceId,
        String(document.docId),
        String(document.locator || ''),
        document.updatedAt === null || document.updatedAt === undefined ? '' : String(document.updatedAt),
        String(document.identity || ''),
        String(document.title || ''),
        String(document.body || '')
      );
    }
    db.prepare('INSERT OR REPLACE INTO source_state(source, fingerprint, documentCount, indexedAt) VALUES(?,?,?,?)')
      .run(sourceId, fingerprint, documents.length, Date.now());
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw error;
  }
}

/**
 * Bring every named indexed source up to date, and report per source.
 *
 * A source that throws SourceUnavailableError is reported as `unavailable` with
 * its code -- it is NOT skipped silently, and the caller is required to turn
 * that into UNKNOWN rather than into a smaller corpus that still answers "miss".
 */
function ensureFresh(db, sources, options = {}) {
  const report = [];
  for (const source of sources) {
    if (source.kind !== 'indexed') continue;
    const started = Date.now();
    let fingerprint;
    try {
      fingerprint = source.fingerprint(options);
    } catch (error) {
      report.push({
        id: source.id,
        state: 'unavailable',
        code: error instanceof SourceUnavailableError ? error.code : 'SOURCE_FINGERPRINT_FAILED',
        why: error.message,
        documentCount: 0,
        durationMs: Date.now() - started,
      });
      continue;
    }
    const stored = storedFingerprint(db, source.id);
    if (stored && stored.fingerprint === fingerprint && !options.forceRebuild) {
      report.push({
        id: source.id, state: 'fresh', code: null, why: null,
        documentCount: stored.documentCount, fingerprint, durationMs: Date.now() - started,
      });
      continue;
    }
    let documents;
    try {
      documents = source.documents(options);
    } catch (error) {
      report.push({
        id: source.id,
        state: 'unavailable',
        code: error instanceof SourceUnavailableError ? error.code : 'SOURCE_READ_FAILED',
        why: error.message,
        documentCount: 0,
        durationMs: Date.now() - started,
      });
      continue;
    }
    try {
      replaceSource(db, source.id, documents, fingerprint);
    } catch (error) {
      report.push({
        id: source.id,
        state: 'unavailable',
        code: 'SOURCE_INDEX_WRITE_FAILED',
        why: `${documents.length} document(s) were read but could not be written to the index (${error.code || error.message}).`,
        documentCount: 0,
        durationMs: Date.now() - started,
      });
      continue;
    }
    report.push({
      id: source.id, state: 'rebuilt', code: null, why: null,
      documentCount: documents.length, fingerprint, durationMs: Date.now() - started,
    });
  }
  return report;
}

function phrase(term) {
  // The tokenizer above cannot emit a double quote, so this is belt-and-braces:
  // an unescaped quote would turn a user's words into FTS5 query OPERATORS.
  return `"${String(term).replace(/"/g, '""')}"`;
}

function scopeClause(sourceIds) {
  return sourceIds.map(() => '?').join(', ');
}

/**
 * Run the query. Returns candidates plus the corpus statistics an honest MISS
 * needs to be defensible.
 */
function search(db, { terms, sourceIds, limit = 8 }) {
  if (!sourceIds.length || !terms.length) {
    return { totalDocuments: 0, termCoverage: {}, candidates: [] };
  }
  const scope = scopeClause(sourceIds);
  const totalDocuments = db.prepare(`SELECT COUNT(*) AS c FROM docs WHERE source IN (${scope})`).all(...sourceIds)[0].c;

  const termCoverage = {};
  const matchedByRow = new Map();
  const identityByRow = new Map();
  for (const term of terms) {
    const expression = phrase(term);
    let rows;
    try {
      rows = db.prepare(`SELECT rowid FROM docs WHERE docs MATCH ? AND source IN (${scope})`).all(expression, ...sourceIds);
    } catch (error) {
      throw new SourceUnavailableError(
        'INDEX_TERM_QUERY_FAILED',
        `The full-text index could not measure coverage for term '${term}' (${error.code || error.message}).`
      );
    }
    termCoverage[term] = rows.length;
    for (const row of rows) {
      let set = matchedByRow.get(row.rowid);
      if (!set) { set = new Set(); matchedByRow.set(row.rowid, set); }
      set.add(term);
    }
    let identityRows = [];
    try {
      identityRows = db.prepare(`SELECT rowid FROM docs WHERE docs MATCH ? AND source IN (${scope})`)
        .all(`{identity title} : ${expression}`, ...sourceIds);
    } catch (error) {
      throw new SourceUnavailableError(
        'INDEX_IDENTITY_QUERY_FAILED',
        `The full-text index could not check identity/title matches for term '${term}' (${error.code || error.message}).`
      );
    }
    for (const row of identityRows) {
      let set = identityByRow.get(row.rowid);
      if (!set) { set = new Set(); identityByRow.set(row.rowid, set); }
      set.add(term);
    }
  }

  const present = terms.filter(term => (termCoverage[term] || 0) > 0);
  if (!present.length) return { totalDocuments, termCoverage, candidates: [] };

  const orExpression = present.map(phrase).join(' OR ');
  let ranked;
  try {
    ranked = db.prepare(
      `SELECT rowid, source, docId, locator, updatedAt, title,
              bm25(docs, 0.0, 0.0, 0.0, 0.0, ${WEIGHT_IDENTITY}, ${WEIGHT_TITLE}, ${WEIGHT_BODY}) AS rank,
              snippet(docs, 6, '[', ']', '…', 14) AS snippet
         FROM docs WHERE docs MATCH ? AND source IN (${scope})
         ORDER BY rank LIMIT ?`
    ).all(orExpression, ...sourceIds, MAX_CANDIDATES);
  } catch (error) {
    throw new SourceUnavailableError(
      'INDEX_RANK_QUERY_FAILED',
      `The full-text index could not rank matching documents (${error.code || error.message}).`
    );
  }

  // Precision rules, lifted wholesale from tools/prior-work-index.js so the two
  // surfaces reject the same noise for the same reasons:
  //   * a 3+ word topic must be matched on at least two of its words;
  //   * a matching word only counts if it is rare enough to discriminate, OR
  //     the document names it in its own identity/title.
  // The second half is not decoration: with only the rarity rule, "agent lanes"
  // returned a confident MISS while context/agent-lanes.md sat on disk.
  const commonThreshold = totalDocuments * COMMON_TERM_FRACTION;
  const requiredTerms = terms.length >= 3 ? 2 : 1;
  const discriminating = term => {
    const count = termCoverage[term] || 0;
    return count > 0 && count <= commonThreshold;
  };

  const candidates = [];
  for (const row of ranked) {
    const matched = [...(matchedByRow.get(row.rowid) || [])];
    if (matched.length < requiredTerms) continue;
    const named = identityByRow.get(row.rowid) || new Set();
    const qualifying = matched.filter(term => discriminating(term) || named.has(term));
    if (qualifying.length < requiredTerms) continue;
    candidates.push({
      source: row.source,
      docId: row.docId,
      locator: row.locator,
      title: row.title,
      updatedAt: row.updatedAt || null,
      // bm25 is negative-better; report a positive relevance so a packet reads
      // the way a person expects without hiding what produced it.
      relevance: Math.round(-row.rank * 1000) / 1000,
      matchedTerms: matched,
      namedTerms: [...named],
      snippet: row.snippet || null,
    });
    if (candidates.length >= limit) break;
  }

  return { totalDocuments, termCoverage, candidates };
}

module.exports = Object.freeze({
  COMMON_TERM_FRACTION,
  MAX_CANDIDATES,
  SCHEMA_VERSION,
  STOPWORDS,
  WEIGHT_BODY,
  WEIGHT_IDENTITY,
  WEIGHT_TITLE,
  defaultDbPath,
  ensureFresh,
  openStore,
  search,
  tokenize,
});

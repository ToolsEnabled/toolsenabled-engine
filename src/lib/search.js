'use strict';

// Local semantic search: index text files into a private SQLite vector store and query
// them by meaning. Embeddings come from local Ollama (private, no API key) when available,
// with a deterministic pure-JS lexical fallback so the tool always works and is testable
// with no external service. Its own DB (state/search-index.sqlite) is kept separate from
// the versioned transactional state-store; the index is a rebuildable cache.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { rootPath, ensureDir } = require('./runtime');
const { plaintextCredentialPattern } = require('./secret-patterns');
const audit = require('./audit');
const { isInsideAllowedRoots, usableRoots } = require('./code-file-containment');
const workspaceBoundary = require('./workspace-boundary');

const DB_PATH = process.env.TOOLSENABLED_SEARCH_DB || rootPath('state', 'search-index.sqlite');
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const DEFAULT_MODEL = 'nomic-embed-text';
const LEXICAL_DIM = 256;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const MAX_QUERY_CHUNKS = 200000;
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.py', '.ps1', '.psm1',
  '.sh', '.bash', '.html', '.htm', '.css', '.scss', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.rs', '.go', '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.sql',
  '.xml', '.tf', '.tsv', '.csv', '.log', '.env', '.gradle', '.swift', '.lua', '.r', '.jl'
]);
// Directories the walk never descends into. Two kinds belong here and only one
// of them can honestly be hardcoded.
//
// The BUILT-IN kind is runtime and build output: regenerated rather than
// authored, so indexing it costs time and returns hits nobody wrote.
//
// The second kind is an installation's OWN off-limits folders -- an archived
// corpus, a stale tree kept on disk for reference, anything a user has decided
// is explicit-access-only. Those names mean nothing on any machine but the one
// they came from, so they are DECLARED rather than shipped:
// TOOLSENABLED_SEARCH_SKIP_DIRS is a comma-separated list of directory names
// added to this set. That matters mechanically and not just tidily -- walk()
// recurses into anything NOT listed here, so a corpus that must stay out of a
// rebuildable semantic index has to be named, or search.index will embed it and
// search.query will then surface it to any caller.
const BUILTIN_SKIP_DIRS = [
  'node_modules', 'vault', 'profiles', 'captures', 'state', 'logs', 'dist', 'build', 'out',
  'coverage', '__pycache__', 'venv', 'target', 'bin', 'obj', 'vendor'
];
const SKIP_DIRS = new Set([
  ...BUILTIN_SKIP_DIRS,
  // Lower-cased on the way in because the lookup below folds case; a declared
  // name that silently never matched would be a hole, not a typo.
  ...String(process.env.TOOLSENABLED_SEARCH_SKIP_DIRS || '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(name => name !== '')
]);
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.[^.]+)?|secrets?(?:\.[^.]+)?|service[-_]?account(?:\.[^.]+)?)$/i;
const SENSITIVE_EXTENSION = new Set(['.key', '.pem', '.p12', '.pfx', '.jks', '.keystore']);
const PLAINTEXT_SECRET = plaintextCredentialPattern();

let db = null;
function databaseIsOpen(database) {
  if (!database) return false;
  if (typeof database.isOpen === 'boolean') return database.isOpen;
  return true;
}

function getDb() {
  if (databaseIsOpen(db)) return db;
  db = null;
  ensureDir(path.dirname(DB_PATH));
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, root TEXT NOT NULL, mtimeMs REAL NOT NULL, size INTEGER NOT NULL, embedder TEXT NOT NULL, dim INTEGER NOT NULL, chunkCount INTEGER NOT NULL, indexedAt INTEGER NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS chunks (path TEXT NOT NULL, chunkIndex INTEGER NOT NULL, root TEXT NOT NULL, embedder TEXT NOT NULL, dim INTEGER NOT NULL, text TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (path, chunkIndex));');
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_root_embedder ON chunks(root, embedder);');
  // A file belongs to every indexed root that contains it. files/chunks keep
  // one embedding per path (and the root that last embedded it); membership
  // says which roots a query by root may return it for. Without it, indexing
  // a parent after a child (or the reverse) silently moved the file out of
  // the other root's results.
  db.exec('CREATE TABLE IF NOT EXISTS memberships (root TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (root, path));');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memberships_path ON memberships(path);');
  db.exec('INSERT OR IGNORE INTO memberships(root, path) SELECT root, path FROM files;');
  return db;
}

// --- vector helpers (vectors are L2-normalized on store, so cosine similarity == dot product) ---
function normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}
function dot(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}
function toBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}
function fromBlob(bytes, dim) {
  const ab = new ArrayBuffer(dim * 4);
  new Uint8Array(ab).set(bytes.subarray(0, dim * 4));
  return new Float32Array(ab);
}

// --- embedders ---
function ollamaRequest(pathname, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request({ host: OLLAMA_HOST, port: OLLAMA_PORT, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: timeoutMs }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(buf)); } catch (error) { reject(error); } }
        else reject(new Error(`Ollama HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Ollama request timed out')));
    req.write(data);
    req.end();
  });
}
async function ollamaEmbedOne(text, model) {
  const response = await ollamaRequest('/api/embeddings', { model, prompt: text });
  if (!response || !Array.isArray(response.embedding) || !response.embedding.length) throw new Error('Ollama returned no embedding.');
  return Float32Array.from(response.embedding);
}
async function ollamaAvailability(model) {
  try {
    await ollamaEmbedOne('ping', model);
    return { available: true };
  } catch (error) {
    return { available: null, error: error instanceof Error ? error.message : String(error) };
  }
}
// The lexical embedder's name is its version: a changed tokenizer needs every
// file embedded again, and a new name makes the next index run do that.
const LEXICAL_EMBEDDER = 'lexical-v2';
// Scripts written without spaces between words: indexed by single characters
// and adjacent pairs, so a query shares tokens with the text it occurs in.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function hashInto(vector, token, weight) {
  const h = crypto.createHash('md5').update(token).digest();
  vector[((h[0] << 8) | h[1]) % LEXICAL_DIM] += ((h[2] & 1) ? 1 : -1) * weight;
}

/** Unicode words of `text`, lowercased: letters and digits of any script. */
function lexicalTokens(text) {
  return String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}_]+/gu) || [];
}

function lexicalEmbed(text) {
  const vector = new Float32Array(LEXICAL_DIM);
  for (const word of lexicalTokens(text)) {
    // Split a word into runs of unspaced-script characters and the rest.
    for (const run of word.match(new RegExp(`${UNSPACED_SCRIPT.source}+|(?:(?!${UNSPACED_SCRIPT.source})[\\p{L}\\p{M}\\p{N}_])+`, 'gu')) || []) {
      if (UNSPACED_SCRIPT.test(run)) {
        const chars = [...run];
        for (let i = 0; i < chars.length; i++) {
          hashInto(vector, chars[i], 1);
          if (i + 1 < chars.length) hashInto(vector, chars[i] + chars[i + 1], 1);
        }
        continue;
      }
      const chars = [...run];
      hashInto(vector, run, 1);
      for (let i = 0; i + 3 <= chars.length; i++) hashInto(vector, chars.slice(i, i + 3).join(''), 0.5);
    }
  }
  return vector;
}

// The first lexical embedder (ASCII letters and digits only), kept so an
// index built with it can still be queried until it is indexed again.
function lexicalEmbedV1(text) {
  const vector = new Float32Array(LEXICAL_DIM);
  const tokens = String(text).toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const token of tokens) {
    const h = crypto.createHash('md5').update(token).digest();
    vector[((h[0] << 8) | h[1]) % LEXICAL_DIM] += (h[2] & 1) ? 1 : -1;
    for (let i = 0; i + 3 <= token.length; i++) {
      const g = crypto.createHash('md5').update(token.slice(i, i + 3)).digest();
      vector[((g[0] << 8) | g[1]) % LEXICAL_DIM] += ((g[2] & 1) ? 1 : -1) * 0.5;
    }
  }
  return vector;
}
async function resolveEmbedder(requested, model) {
  if (requested !== 'lexical') {
    const availability = await ollamaAvailability(model);
    if (availability.available === true) {
      return { name: `ollama:${model}`, embed: text => ollamaEmbedOne(text, model) };
    }
  }
  return { name: LEXICAL_EMBEDDER, embed: async text => lexicalEmbed(text) };
}

// --- text handling ---
function chunkText(text) {
  const clean = String(text);
  const chunks = [];
  if (clean.length <= CHUNK_SIZE) {
    if (clean.trim()) chunks.push(clean);
    return chunks;
  }
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const brk = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
      if (brk > CHUNK_SIZE * 0.6) end = i + brk + 1;
    }
    const piece = clean.slice(i, end);
    if (piece.trim()) chunks.push(piece);
    if (end >= clean.length) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
  return chunks;
}
function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Case-insensitive on purpose. A declared skip name is typed by a person
      // and the folder it names is on a case-preserving filesystem, so a
      // case-sensitive membership test would walk straight past a boundary
      // someone believed they had set. Every entry in the set is lower-cased on
      // the way in, so folding here is strictly more protective for the
      // built-in entries too.
      if (SKIP_DIRS.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

function sensitiveFile(file, content) {
  const base = path.basename(file);
  return SENSITIVE_FILE.test(base) || SENSITIVE_EXTENSION.has(path.extname(base).toLowerCase())
    || PLAINTEXT_SECRET.test(content);
}

function close() {
  if (!databaseIsOpen(db)) {
    db = null;
    return false;
  }
  const current = db;
  db = null;
  current.close();
  return true;
}

// search.js has no typed-error class of its own (every existing refusal in
// this file -- 'root is not a directory', 'query must be a non-empty
// string.', etc. -- is a plain Error with no .code) -- checked by grepping
// this file for `.code =`, a custom Error subclass, and `throw new Error`,
// all with zero results for any convention, and a repo-wide grep for
// SearchError/SEARCH_INDEX/SEARCH_ROOT_OUTSIDE_ROOT with zero results too.
// Rather than invent a class just for this refusal, SEARCH_ROOT_OUTSIDE_ROOT
// is both embedded in the message (so prose-matching still works) AND set as
// error.code, an own property on the plain Error, so a caller can match on
// a code the same way code-intel.js's typed CodeIntelError lets one.
// A caller's input that cannot be searched: coded so the agent reads the
// sentence (error-taxonomy classifies *_INVALID as an invalid request)
// instead of the internal-error one.
function searchInputError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function rootOutsideRootError(target) {
  // Name the roots that are allowed, so the agent can index inside one, and
  // inside an OpenShell sandbox how the person chooses the working folder.
  const recorded = require('./code-file-containment').recordedWorkspaceRoots();
  const sandbox = require('./openshell-inside').isInsideOpenShellSandbox()
    ? ' In this OpenShell sandbox the person chooses the working folder with `toolsenabled setup --workspace DIR`, or copies files into it.'
    : '';
  const error = new Error(`SEARCH_ROOT_OUTSIDE_ROOT: root is outside the ToolsEnabled root and every recorded workspace root (${recorded.join(', ') || 'none recorded'}): ${target}. Index a folder inside one of them.${sandbox}`);
  error.code = 'SEARCH_ROOT_OUTSIDE_ROOT';
  return error;
}

// --- public operations ---
async function indexPath(args = {}) {
  const rootAbs = path.resolve(String(args.root || '.'));
  // Mirrors src/lib/providers/code-intel.js#resolveFilePath's containment
  // (see src/lib/code-file-containment.js): `root` is where every file this
  // function walks, reads and embeds comes from, so it must not resolve
  // outside the ToolsEnabled root or a recorded workspace root, lexically or
  // via realpath. MEASURED: this exact escape -- `search.index` root pointed
  // at a secrets directory outside the granted workspace, read and indexed
  // -- is the case documented in this codebase's own
  // src/lib/workspace-boundary.js header.
  if (!isInsideAllowedRoots(rootAbs, { label: 'root' })) {
    audit.record('search.index_root_outside_root_refused', rootAbs, { arg: 'root' });
    throw rootOutsideRootError(rootAbs);
  }
  let rootStat;
  try { rootStat = fs.statSync(rootAbs); } catch (error) {
    if (error && error.code === 'ENOENT') throw searchInputError('SEARCH_ROOT_INVALID', `root does not exist: ${rootAbs}`);
    throw error;
  }
  if (!rootStat.isDirectory()) throw searchInputError('SEARCH_ROOT_INVALID', `root is not a directory: ${rootAbs}. Index the folder that contains it.`);
  const model = args.model || DEFAULT_MODEL;
  const maxFileKb = Number.isFinite(args.maxFileKb) ? args.maxFileKb : 512;
  const maxFiles = Number.isFinite(args.maxFiles) ? args.maxFiles : 2000;
  const embedder = await resolveEmbedder(args.embedder, model);
  const database = getDb();
  const selFile = database.prepare('SELECT mtimeMs, size, embedder FROM files WHERE path = ?');
  const delChunks = database.prepare('DELETE FROM chunks WHERE path = ?');
  const delFile = database.prepare('DELETE FROM files WHERE path = ?');
  const insFile = database.prepare('INSERT OR REPLACE INTO files(path, root, mtimeMs, size, embedder, dim, chunkCount, indexedAt) VALUES(?,?,?,?,?,?,?,?)');
  const insChunk = database.prepare('INSERT OR REPLACE INTO chunks(path, chunkIndex, root, embedder, dim, text, vector) VALUES(?,?,?,?,?,?,?)');
  const addMember = database.prepare('INSERT OR IGNORE INTO memberships(root, path) VALUES(?, ?)');
  const delMember = database.prepare('DELETE FROM memberships WHERE root = ? AND path = ?');
  const delMembers = database.prepare('DELETE FROM memberships WHERE path = ?');
  const memberCount = database.prepare('SELECT COUNT(*) AS c FROM memberships WHERE path = ?');
  // A file that can no longer be indexed at all (too big, binary, sensitive)
  // leaves every root.
  const removeIndexedFile = file => {
    const existed = Boolean(selFile.get(file));
    database.exec('BEGIN');
    try {
      delChunks.run(file);
      delFile.run(file);
      delMembers.run(file);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return existed;
  };
  // A file gone from this root leaves this root only; its embedding goes when
  // no root holds it any more.
  const leaveRoot = file => {
    database.exec('BEGIN');
    try {
      delMember.run(rootAbs, file);
      const orphaned = memberCount.get(file).c === 0;
      if (orphaned) { delChunks.run(file); delFile.run(file); }
      database.exec('COMMIT');
      return orphaned;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const started = Date.now();
  const discovered = new Set();
  let filesIndexed = 0, filesSkipped = 0, filesSensitiveSkipped = 0;
  let filesRemoved = 0, chunksIndexed = 0, filesScanned = 0, truncated = false;
  for (const file of walk(rootAbs)) {
    discovered.add(file);
    if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
    if (filesScanned >= maxFiles) { truncated = true; break; }
    const stat = fs.statSync(file);
    filesScanned++;
    if (stat.size === 0 || stat.size > maxFileKb * 1024) {
      if (removeIndexedFile(file)) filesRemoved++;
      continue;
    }
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('\u0000')) {
      if (removeIndexedFile(file)) filesRemoved++;
      continue; // binary
    }
    if (sensitiveFile(file, content)) {
      filesSensitiveSkipped++;
      if (removeIndexedFile(file)) filesRemoved++;
      continue;
    }
    const prev = selFile.get(file);
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size && prev.embedder === embedder.name) {
      addMember.run(rootAbs, file);
      filesSkipped++;
      continue;
    }
    const pieces = chunkText(content);
    const vectors = [];
    for (const piece of pieces) vectors.push(normalize(await embedder.embed(piece)));
    database.exec('BEGIN');
    try {
      delChunks.run(file);
      let dim = 0;
      for (let ci = 0; ci < pieces.length; ci++) { dim = vectors[ci].length; insChunk.run(file, ci, rootAbs, embedder.name, dim, pieces[ci], toBlob(vectors[ci])); chunksIndexed++; }
      insFile.run(file, rootAbs, stat.mtimeMs, stat.size, embedder.name, dim, pieces.length, Date.now());
      addMember.run(rootAbs, file);
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    filesIndexed++;
  }
  if (!truncated) {
    const members = database.prepare('SELECT path FROM memberships WHERE root = ?').all(rootAbs);
    for (const row of members) {
      if (discovered.has(row.path)) continue;
      // Deleted from disk: gone from every root. Still there but no longer
      // under this walk: gone from this root only.
      if (!fs.existsSync(row.path) ? removeIndexedFile(row.path) : leaveRoot(row.path)) filesRemoved++;
    }
  }
  // A successful, in-bounds index run is audited too, not only a refusal.
  // The dispatch-layer mcp.tool.succeeded record (src/lib/tool-registry.js
  // auditInvocation) already lands for every call, success or failure, but
  // its target is the TOOL NAME ('search.index') and its details carry only
  // { effect, provider, durationMs } -- never which root or how many files.
  // This is per-operation, not per-file (indexPath can touch thousands of
  // files in one call; gating each behind a durable admission the way
  // host.read_file gates its single read would multiply the per-call audit
  // cost by the file count for no proportionate benefit), so it stays the
  // same non-gating audit.record() the refusal above uses rather than
  // requireRecordAsync.
  audit.record('search.index_completed', rootAbs, { filesIndexed, filesScanned, chunksIndexed });
  return {
    root: rootAbs, embedder: embedder.name, filesScanned, filesIndexed, filesSkipped,
    filesSensitiveSkipped, filesRemoved, chunksIndexed, truncated, durationMs: Date.now() - started
  };
}

function currentlyAllowedSearchRows(rows) {
  let roots;
  try { roots = usableRoots(); } catch { return []; }
  const checked = new Map();
  const allowed = candidate => {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
    if (!checked.has(candidate)) {
      try {
        workspaceBoundary.assertInsideRoots(candidate, roots, { label: 'indexed path' });
        checked.set(candidate, true);
      } catch { checked.set(candidate, false); }
    }
    return checked.get(candidate);
  };
  return rows.filter(row => allowed(row.root) && (row.path === undefined || allowed(row.path)));
}

async function query(args = {}) {
  const q = String(args.query || '');
  if (!q.trim()) throw searchInputError('SEARCH_QUERY_INVALID', 'query must be a non-empty string.');
  const k = Math.min(Math.max(Number.isFinite(args.k) ? Math.trunc(args.k) : 8, 1), 50);
  const rootFilter = args.root ? path.resolve(String(args.root)) : null;
  // Same boundary as indexPath's `root` (see src/lib/code-file-containment.js):
  // a `root` filter is how a caller reaches previously indexed chunks by
  // scope, so it must not be able to name a root outside the ToolsEnabled
  // root or a recorded workspace root either -- otherwise a root indexed
  // before this fix shipped (or before a workspace root was de-recorded)
  // would stay queryable forever even though it could no longer be indexed.
  if (rootFilter && !isInsideAllowedRoots(rootFilter, { label: 'root' })) {
    audit.record('search.query_root_outside_root_refused', rootFilter, { arg: 'root' });
    throw rootOutsideRootError(rootFilter);
  }
  const database = getDb();
  // Cached index content does not retain a workspace grant. Choose an
  // embedder only from currently allowed roots, including unscoped queries.
  const anchors = rootFilter
    ? database.prepare('SELECT DISTINCT m.root AS root, c.embedder AS embedder, c.dim AS dim FROM chunks c JOIN memberships m ON m.path = c.path WHERE m.root = ? LIMIT ?').all(rootFilter, MAX_QUERY_CHUNKS)
    : database.prepare('SELECT DISTINCT m.root AS root, c.embedder AS embedder, c.dim AS dim FROM chunks c JOIN memberships m ON m.path = c.path LIMIT ?').all(MAX_QUERY_CHUNKS);
  const anchor = currentlyAllowedSearchRows(anchors)[0];
  if (!anchor) return { query: q, matches: [], note: 'index is empty for that scope; run search.index first.' };
  const embedderName = anchor.embedder;
  let queryVector;
  const lexical = !embedderName.startsWith('ollama:');
  if (lexical && (embedderName === LEXICAL_EMBEDDER ? lexicalTokens(q) : (q.toLowerCase().match(/[a-z0-9_]+/g) || [])).length === 0) {
    throw searchInputError('SEARCH_QUERY_INVALID', `the query has no letters or digits for lexical search (${embedderName}) to match.`);
  }
  if (!lexical) queryVector = await ollamaEmbedOne(q, embedderName.slice('ollama:'.length));
  else queryVector = embedderName === LEXICAL_EMBEDDER ? lexicalEmbed(q) : lexicalEmbedV1(q);
  queryVector = normalize(queryVector);
  const candidates = rootFilter
    ? database.prepare('SELECT m.root AS root, c.path AS path, c.chunkIndex AS chunkIndex, c.text AS text, c.vector AS vector, c.dim AS dim FROM chunks c JOIN memberships m ON m.path = c.path WHERE m.root = ? AND c.embedder = ? LIMIT ?').all(rootFilter, embedderName, MAX_QUERY_CHUNKS)
    : database.prepare('SELECT (SELECT root FROM memberships WHERE path = c.path LIMIT 1) AS root, c.path AS path, c.chunkIndex AS chunkIndex, c.text AS text, c.vector AS vector, c.dim AS dim FROM chunks c WHERE c.embedder = ? AND EXISTS (SELECT 1 FROM memberships WHERE path = c.path) LIMIT ?').all(embedderName, MAX_QUERY_CHUNKS);
  // Embedding may await a local service. Re-read grants afterwards, and check
  // each stored file as well as its root before scoring or exposing snippets.
  const rows = currentlyAllowedSearchRows(candidates);
  const scored = rows.map(r => ({ path: r.path, chunkIndex: r.chunkIndex, score: dot(queryVector, fromBlob(r.vector, r.dim)), text: r.text }));
  scored.sort((a, b) => b.score - a.score);
  // Lexical vectors share nothing with unrelated text; a score at or below
  // zero is no match, not a weak one, and is not returned as one.
  const matches = (lexical ? scored.filter(m => m.score > 1e-6) : scored).slice(0, k).map(m => ({ path: m.path, chunkIndex: m.chunkIndex, score: Math.round(m.score * 1000) / 1000, snippet: m.text.slice(0, 400) }));
  // A successful read of previously indexed content is audited too, not only
  // a refusal or the tool-name-level mcp.tool.succeeded record -- same
  // reasoning as indexPath's own completion audit above. Not fired for the
  // "index is empty for that scope" early return, since nothing was
  // actually disclosed there.
  audit.record('search.query_completed', rootFilter || 'all', { matches: matches.length });
  return { query: q, embedder: embedderName, candidatesScored: rows.length, matches };
}

async function status() {
  const database = getDb();
  const files = database.prepare('SELECT COUNT(*) AS c FROM files').get().c;
  const chunks = database.prepare('SELECT COUNT(*) AS c FROM chunks').get().c;
  const embedders = database.prepare('SELECT embedder, COUNT(*) AS files FROM files GROUP BY embedder').all();
  const roots = database.prepare('SELECT root, COUNT(*) AS files FROM memberships GROUP BY root ORDER BY files DESC LIMIT 20').all();
  const ollama = { model: DEFAULT_MODEL, ...await ollamaAvailability(DEFAULT_MODEL) };
  // Search works without a model (lexical); say that plainly rather than
  // leaving an unreachable local model server looking like a failure.
  const mode = ollama.available === true ? 'semantic (local Ollama embeddings)' : 'lexical (no embedding model reachable; indexing and queries still work)';
  return { dbPath: DB_PATH, files, chunks, embedders, roots, mode, ollama };
}

module.exports = { indexPath, query, status, close, sensitiveFile, lexicalEmbed, lexicalTokens, chunkText, LEXICAL_DIM, LEXICAL_EMBEDDER };

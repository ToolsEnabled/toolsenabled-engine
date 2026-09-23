// Prior-work index — "has anyone already done this?" answered from what is on
// disk, not from what an agent remembered to register.
//
// WHY THIS EXISTS
// ---------------
// The GrepSaver card index maps *code*: seven hand-written system cards, each
// requiring `system`/`source_path`/`fingerprint`/entry-points/PORTS. A finding
// like "USPTO returned zero hits for TOOLSENABLED across nine query forms" has
// no representable shape in that schema, so it was never indexed, so the next
// agent asked `grepsaver-orient.js "trademark"`, got **"No carded system
// matched" at exit 0**, concluded nothing existed, and re-derived the research
// from scratch — for the fourth night running.
//
// The corpus was never missing. `docs/**` and `reports/**` held it the whole
// time. Only the index was missing.
//
// THE ONE DESIGN RULE
// -------------------
// If keeping this current requires anybody to remember to do anything, it will
// fall behind — it already did, twice, in the two indexes this replaces:
//   * context/systems.json is a generated file that is committed and then
//     silently believed forever; it reported ONE system while seven cards
//     existed on disk.
//   * The search index was last really rebuilt on 2026-08-08 and sat at 68%
//     coverage (docs/ 50%, reports/ 12%) because a rebuild is a manual call.
//
// So there is NO registration step here and NO refresh command you must run.
// The index is DERIVED from the corpus, and every query re-stats the corpus and
// compares a fingerprint of (path, size, mtime) before trusting the cache. A
// file added one second ago is in the answer one second later. The cache is a
// speed optimisation and nothing else: if it is stale it is rebuilt, and if it
// cannot be written the query still answers correctly.
//
// HONESTY RULES (the defect this file is half of)
// -----------------------------------------------
// A discovery tool that returns success while finding nothing teaches every
// caller that empty means fine. So three outcomes are kept distinct, in the
// text AND in the exit code:
//   HIT     (0) — the corpus was read and these files address the topic.
//   MISS    (3) — the corpus was read in full and genuinely contains nothing.
//   UNKNOWN (4) — the corpus could NOT be read, so this tool does not know.
// MISS and UNKNOWN are different claims. Collapsing them into "no results" is
// the absence-read-as-consent class this codebase has now hit nine times.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256, toPosix, looksSecret } = require('./grepsaver-lib');

const ROOT = path.resolve(__dirname, '..');

// Where knowledge actually lives. Derived wholesale — no per-file opt-in.
const SCOPES = Object.freeze(['docs', 'reports', 'context']);
// Root-level markdown (CLAUDE.md, BUILD-QUEUE.md, STANDING-ORDERS.md, ...).
const ROOT_GLOB = /\.md$/i;
const INDEXABLE = /\.(md|json|jsonl|txt)$/i;

// Read a bounded head of each file. Titles, headings and topic vocabulary are
// front-loaded in every document format here, and this keeps a 2.3 MB ledger
// from dominating both the build cost and the term statistics.
const MAX_BYTES_PER_FILE = 96 * 1024;
// Runaway guard only. Measured on the real corpus the largest single file
// contributes 2210 distinct terms, so this bites almost never — and when it
// does, terms are dropped by weight*IDF, never by weight alone.
//
// This constant was 400-by-weight and that was a RECALL BUG, not a tuning
// choice: body weight is 1-4 regardless of how rare a word is, so truncating
// by weight preferentially discards the rare, discriminating terms and keeps
// the common ones. Measured effect: `trademark` reached only 4 of its 6
// documents, and `delaware` 6 of 12, because the word sorted below 400 common
// words in a 26 KB document. The index was quietly recreating the exact defect
// it exists to fix.
const MAX_TERMS_PER_FILE = 3000;
// A term this common ranks nothing, so it cannot by itself justify returning a
// document. Expressed as a fraction of the corpus.
const COMMON_TERM_FRACTION = 0.4;
const MAX_HEADINGS = 12;

const CACHE_VERSION = 'prior-work-index-v1';

// The cache belongs to the tree it describes. Deriving it from the root is not
// a nicety: with a single fixed path, querying any other root (a test fixture,
// the retired tree, a worktree) rebuilt the index and then overwrote the
// canonical tree's cache with a foreign tree's contents — one lane's test run
// silently corrupting another lane's discovery answers.
function cacheFileFor(rootDir) {
  return path.join(path.resolve(rootDir), 'context', '.prior-work-cache.json');
}

const CACHE_FILE = cacheFileFor(ROOT);

// Directories that hold machine output, dependencies or binaries — never prose.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.shots', 'coverage', 'dist', 'build',
  'tmp', 'temp', '.cache', 'fixtures', '__pycache__', '.venv'
]);

// Terms so common in this corpus that they rank nothing. Deliberately small:
// over-stopping is how "spend cap" stopped matching anything.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'at',
  'with', 'how', 'what', 'where', 'why', 'when', 'who', 'do', 'does', 'did', 'i',
  'we', 'my', 'this', 'that', 'these', 'those', 'be', 'am', 'are', 'was', 'were',
  'can', 'could', 'should', 'would', 'will', 'get', 'got', 'find', 'show', 'me',
  'about', 'from', 'by', 'as', 'if', 'not', 'no', 'yes', 'any', 'all', 'has',
  'have', 'had', 'been', 'being', 'but', 'so', 'than', 'then', 'there', 'here',
  'you', 'your', 'our', 'us', 'its', 'his', 'her', 'they', 'them', 'up', 'out',
  'into', 'over', 'under', 'more', 'most', 'some', 'such', 'only', 'own', 'same',
  'too', 'very', 'just', 'now', 'also', 'md', 'json', 'http', 'https', 'www'
]);

function tokenize(text) {
  const out = [];
  const words = String(text).toLowerCase().split(/[^a-z0-9]+/);
  for (const word of words) {
    if (word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    out.push(word);
  }
  return out;
}

/**
 * Light stemmer. Not linguistics — just enough that "domains" finds "domain"
 * and "filings" finds "filing", which is the single most common way a plain
 * topic question misses a document that answers it.
 */
function stem(word) {
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es') && !/[aeiou]es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith('ed')) return word.slice(0, -2);
  return word;
}

function keyOf(word) {
  return stem(word);
}

// --------------------------------------------------------------------------
// Corpus enumeration + fingerprint
// --------------------------------------------------------------------------

function walk(dir, rootDir, acc, errors, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // A directory we cannot read is a KNOWN UNKNOWN, recorded so the query can
    // downgrade a MISS to UNKNOWN rather than claiming the topic does not exist.
    errors.push({ path: toPosix(path.relative(rootDir, dir)) || '.', why: error.code || 'EREAD' });
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(full, rootDir, acc, errors, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    // Dotfiles are machine state, not knowledge — and one of them is THIS
    // tool's own cache. `.prior-work-cache.json` lives in context/ and matches
    // *.json, so without this the index indexed itself: every term in the
    // corpus gained a phantom extra document, `trademark` reported 7 files when
    // 6 exist, and the cache grew on every rebuild that read the last one.
    if (entry.name.startsWith('.')) continue;
    if (!INDEXABLE.test(entry.name)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (error) {
      errors.push({ path: toPosix(path.relative(rootDir, full)), why: error.code || 'ESTAT' });
      continue;
    }
    acc.push({
      path: toPosix(path.relative(rootDir, full)),
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs)
    });
  }
}

/**
 * Enumerate the corpus and fingerprint it WITHOUT reading any file content.
 * This is the freshness check that runs on every single query, so it has to be
 * cheap: it is stat-only.
 */
function scanCorpus(rootDir = ROOT) {
  const files = [];
  const errors = [];
  const missingScopes = [];

  for (const scope of SCOPES) {
    const dir = path.join(rootDir, scope);
    if (!fs.existsSync(dir)) {
      missingScopes.push(scope);
      continue;
    }
    walk(dir, rootDir, files, errors);
  }

  // Root-level markdown: the standing orders and the build queue live here.
  try {
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isFile() && ROOT_GLOB.test(entry.name)) {
        const full = path.join(rootDir, entry.name);
        try {
          const stat = fs.statSync(full);
          files.push({ path: toPosix(entry.name), size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
        } catch (error) {
          errors.push({ path: toPosix(entry.name), why: error.code || 'ESTAT' });
        }
      }
    }
  } catch (error) {
    errors.push({ path: '.', why: error.code || 'EREAD' });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = sha256(files.map(f => `${f.path}:${f.size}:${f.mtimeMs}`).join('\n'));
  return { files, errors, missingScopes, fingerprint };
}

// --------------------------------------------------------------------------
// Index construction
// --------------------------------------------------------------------------

function readHead(absPath, size) {
  const length = Math.min(size, MAX_BYTES_PER_FILE);
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buffer = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }
}

function extractTitle(text, relPath) {
  if (text) {
    const lines = text.split(/\r?\n/, 60);
    for (const line of lines) {
      const heading = line.match(/^#\s+(.{3,160})\s*$/);
      if (heading && !looksSecret(heading[1])) return heading[1].trim();
    }
  }
  return path.basename(relPath);
}

function extractHeadings(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^#{2,4}\s+(.{3,120})\s*$/);
    if (heading && !looksSecret(heading[1])) {
      out.push(heading[1].trim());
      if (out.length >= MAX_HEADINGS) break;
    }
  }
  return out;
}

/**
 * Field weights. Identity beats prose, hard.
 *
 * A filename is a deliberate act of naming — `LAUNCH-PURCHASES.md` is a much
 * stronger claim to the topic "purchase list" than a document that happens to
 * say "purchase" once in a footnote. Ranking those equally is exactly how
 * search.query answered a trademark-cost question with a UI plugin's CSV about
 * alarm clocks.
 */
const WEIGHT_PATH = 12;
const WEIGHT_TITLE = 8;
const WEIGHT_HEADING = 4;
const WEIGHT_BODY = 1;

function indexOneFile(rootDir, record) {
  const absPath = path.join(rootDir, record.path);
  const text = readHead(absPath, record.size);
  if (text === null) return null;

  const title = extractTitle(text, record.path);
  const headings = extractHeadings(text);

  const weights = new Map();
  // Terms a human deliberately put in the FILENAME or the TITLE. Tracked
  // separately from their weight because naming is an act of intent: a file
  // called agent-lanes.md is about agent lanes even though "agent" and "lane"
  // are both ambient vocabulary in this corpus and therefore rank near zero.
  const identity = new Set();
  const bump = (term, weight) => {
    const key = keyOf(term);
    if (!key) return;
    weights.set(key, (weights.get(key) || 0) + weight);
  };

  for (const word of tokenize(record.path.replace(/[/\\]/g, ' '))) { bump(word, WEIGHT_PATH); identity.add(keyOf(word)); }
  for (const word of tokenize(title)) { bump(word, WEIGHT_TITLE); identity.add(keyOf(word)); }
  for (const heading of headings) {
    for (const word of tokenize(heading)) bump(word, WEIGHT_HEADING);
  }

  // Body terms score by DISTINCT presence with a small repeat bonus that
  // saturates. A document that says "domain" 400 times is about domains, but
  // not 400x more so than one that says it twice.
  const bodyCounts = new Map();
  for (const word of tokenize(text)) {
    const key = keyOf(word);
    bodyCounts.set(key, (bodyCounts.get(key) || 0) + 1);
  }
  for (const [key, count] of bodyCounts) {
    bump(key, WEIGHT_BODY * Math.min(4, 1 + Math.log2(count)));
  }

  return { title, headings: headings.slice(0, 4), weights, identity };
}

/**
 * Build the whole index from disk. Pure derivation: nothing here consults a
 * registration list, a frontmatter opt-in, or a hand-written card.
 */
function buildIndex(rootDir = ROOT, scan = null) {
  const corpus = scan || scanCorpus(rootDir);
  const files = [];
  const postings = new Map(); // term -> [fileIndex, weight, ...]
  const readErrors = [];

  // PHASE 1 — read every file once and collect its term weights, plus the
  // corpus-wide document frequency of each term. Nothing is discarded yet: how
  // discriminating a term is cannot be known until the whole corpus is counted,
  // and discarding before that is what broke recall on rare terms.
  const perFile = [];
  const docFreq = new Map();

  for (const record of corpus.files) {
    const indexed = indexOneFile(rootDir, record);
    if (!indexed) {
      readErrors.push({ path: record.path, why: 'unreadable' });
      continue;
    }
    const fileIndex = files.length;
    files.push({
      path: record.path,
      title: indexed.title,
      headings: indexed.headings,
      size: record.size,
      mtimeMs: record.mtimeMs
    });
    perFile.push({ fileIndex, weights: indexed.weights, identity: indexed.identity });
    for (const term of indexed.weights.keys()) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  // PHASE 2 — now that rarity is known, emit postings. The per-file cap is a
  // runaway guard and ranks by weight*IDF, so a rare term always outranks a
  // common one and survives truncation.
  const totalFiles = files.length || 1;
  const idfOf = term => Math.log((totalFiles + 1) / ((docFreq.get(term) || 0) + 1)) + 1;

  const identityPostings = new Map(); // term -> [fileIndex, ...]
  for (const { fileIndex, weights, identity } of perFile) {
    let entries = [...weights.entries()];
    if (entries.length > MAX_TERMS_PER_FILE) {
      entries = entries
        .sort((a, b) => (b[1] * idfOf(b[0])) - (a[1] * idfOf(a[0])))
        .slice(0, MAX_TERMS_PER_FILE);
    }
    for (const [term, weight] of entries) {
      let list = postings.get(term);
      if (!list) { list = []; postings.set(term, list); }
      list.push(fileIndex, Math.round(weight * 10) / 10);
    }
    for (const term of identity) {
      let list = identityPostings.get(term);
      if (!list) { list = []; identityPostings.set(term, list); }
      list.push(fileIndex);
    }
  }

  return {
    version: CACHE_VERSION,
    builtAt: new Date().toISOString(),
    root: toPosix(path.resolve(rootDir)),
    corpusFingerprint: corpus.fingerprint,
    scopes: SCOPES.slice(),
    missingScopes: corpus.missingScopes,
    // Everything the build could not see, carried into the answer so a MISS can
    // be honestly downgraded to UNKNOWN.
    degraded: [...corpus.errors, ...readErrors],
    files,
    postings: Object.fromEntries(postings),
    identityPostings: Object.fromEntries(identityPostings)
  };
}

// --------------------------------------------------------------------------
// Cache — a speed optimisation, never a source of truth
// --------------------------------------------------------------------------

function loadCache(rootDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFileFor(rootDir), 'utf8'));
    if (parsed && parsed.version === CACHE_VERSION) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * ~10 lanes share this tree, and a rebuild that locks a file is how the ledger
 * capture failed today. So: write to a PID-unique temp and rename over the
 * cache, and treat every failure as a no-op. A lost cache write costs a few
 * hundred milliseconds on the next query and nothing else — it can never make
 * an answer wrong, because the answer was already computed from disk.
 */
function saveCache(index, rootDir) {
  const target = cacheFileFor(rootDir);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(index), 'utf8');
    fs.renameSync(temp, target);
    return { cached: true };
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    return { cached: false, why: error.code || 'EWRITE' };
  }
}

/**
 * Get a CURRENT index. Re-stats the corpus every call and rebuilds whenever the
 * fingerprint moved. This is the whole anti-staleness mechanism, and it is
 * mechanical: there is no habit, cadence, scheduled task or go-gate involved.
 */
function getIndex(rootDir = ROOT, options = {}) {
  const scan = scanCorpus(rootDir);
  if (!options.forceRebuild) {
    const cached = loadCache(rootDir);
    // A fingerprint only describes the paths we managed to stat. If this scan
    // could not enumerate a path, the omitted path contributes nothing to the
    // hash and can therefore make an incomplete scan look identical to a
    // complete cached scan (especially for an unreadable empty directory).
    // Likewise, do not preserve an old degraded result after the corpus has
    // become readable again. Rebuild so the current uncertainty is carried by
    // the returned index rather than letting either scan answer for the other.
    const scanComplete = scan.errors.length === 0 && scan.missingScopes.length === 0;
    const cacheComplete = cached
      && (cached.degraded || []).length === 0
      && (cached.missingScopes || []).length === 0;
    if (cacheComplete && scanComplete
      && cached.corpusFingerprint === scan.fingerprint
      && cached.root === toPosix(path.resolve(rootDir))) {
      return { index: cached, source: 'cache', rebuilt: false, scan };
    }
  }
  const index = buildIndex(rootDir, scan);
  const cacheResult = options.noWrite ? { cached: false, why: 'no-write' } : saveCache(index, rootDir);
  return { index, source: 'derived', rebuilt: true, scan, cacheResult };
}

// --------------------------------------------------------------------------
// Query
// --------------------------------------------------------------------------

// A body-only mention of a genuinely rare term scores about 5, and that is a
// real answer worth returning — `delaware` appears exactly once in
// docs/design/CODE-SIGNING-DECISION.md and that is still the document a person
// asking about Delaware should see. So the absolute floor is low, and the work
// of rejecting noise is done by the discriminating-term rule below rather than
// by a blunt score threshold that also rejects rare true hits.
const MIN_SCORE = 4;
const TOP_SCORE_FRACTION = 0.25;

/**
 * Answer a plain-topic question with the files that already address it.
 *
 * Returns an explicit `outcome` of hit | miss | unknown. The caller is expected
 * to map that to an exit code; see prior-work.js.
 */
function query(topic, options = {}) {
  const rootDir = options.root || ROOT;
  const limit = Math.min(25, Math.max(1, Number(options.limit) || 8));
  const rawTerms = tokenize(topic);

  if (!rawTerms.length) {
    return {
      outcome: 'unknown',
      reason: 'EMPTY_QUERY',
      topic,
      why: 'the topic has no searchable terms',
      results: []
    };
  }

  let loaded;
  try {
    loaded = getIndex(rootDir, options);
  } catch (error) {
    return {
      outcome: 'unknown',
      reason: 'INDEX_UNAVAILABLE',
      topic,
      why: `the prior-work index could not be built: ${error.message}`,
      results: []
    };
  }

  const { index } = loaded;
  const terms = [...new Set(rawTerms.map(keyOf))];

  // Inverse-document-frequency, so a term that appears in 900 of 1000 files
  // contributes almost nothing and the rare, discriminating term dominates.
  const totalFiles = index.files.length || 1;
  const scores = new Map();
  const matchedTermsPerFile = new Map();
  const termCoverage = {};

  for (const term of terms) {
    const list = index.postings[term];
    if (!list || !list.length) { termCoverage[term] = 0; continue; }
    const docCount = list.length / 2;
    termCoverage[term] = docCount;
    const idf = Math.log((totalFiles + 1) / (docCount + 1)) + 1;
    for (let i = 0; i < list.length; i += 2) {
      const fileIndex = list[i];
      const weight = list[i + 1];
      scores.set(fileIndex, (scores.get(fileIndex) || 0) + weight * idf);
      let set = matchedTermsPerFile.get(fileIndex);
      if (!set) { set = new Set(); matchedTermsPerFile.set(fileIndex, set); }
      set.add(term);
    }
  }

  // A multi-word topic that only ever matches one of its words is usually a
  // coincidence ("spend cap" finding every file that says "cap"). Require the
  // best results to cover more of the query when the query has more to cover.
  const requiredTerms = terms.length >= 3 ? 2 : 1;

  // A term appearing in 40%+ of the corpus describes the corpus, not the topic.
  // Matching only on such terms is how a trademark-cost question came back with
  // a UI plugin's CSV about alarm clocks: every one of those files shared only
  // ambient vocabulary with the question. Requiring one genuinely discriminating
  // term rejects that class without also rejecting rare true hits.
  const commonThreshold = totalFiles * COMMON_TERM_FRACTION;
  const isDiscriminating = term => {
    const count = termCoverage[term] || 0;
    return count > 0 && count <= commonThreshold;
  };

  // Which files carry each query term in their filename or title.
  const identityFiles = new Map(); // fileIndex -> Set(term)
  const identityIndex = index.identityPostings || {};
  for (const term of terms) {
    for (const fileIndex of identityIndex[term] || []) {
      let set = identityFiles.get(fileIndex);
      if (!set) { set = new Set(); identityFiles.set(fileIndex, set); }
      set.add(term);
    }
  }

  // A term only counts toward relevance if it is either rare enough to
  // discriminate, or named in this file's own path/title.
  //
  // The rarity half alone is not enough, and that is not theoretical: with only
  // the rarity rule, the topic "agent lanes" returned MISS — a confident
  // "nothing exists" — while context/agent-lanes.md sat on disk, because
  // "agent" and "lane" are ambient vocabulary here. A false MISS is the most
  // expensive answer this tool can give: it is precisely the message that sent
  // an agent off to redo four nights of launch research.
  const qualifyingCount = entry => {
    const named = identityFiles.get(entry.fileIndex);
    return entry.matchedTerms.filter(term => isDiscriminating(term) || (named && named.has(term))).length;
  };

  const ranked = [...scores.entries()]
    .map(([fileIndex, score]) => ({
      fileIndex,
      score,
      matchedTerms: [...(matchedTermsPerFile.get(fileIndex) || [])]
    }))
    .filter(entry => entry.matchedTerms.length >= requiredTerms)
    .filter(entry => qualifyingCount(entry) >= requiredTerms)
    .sort((a, b) => b.score - a.score);

  const topScore = ranked.length ? ranked[0].score : 0;
  const floor = Math.max(MIN_SCORE, topScore * TOP_SCORE_FRACTION);
  const kept = ranked.filter(entry => entry.score >= floor).slice(0, limit);

  const unreadable = index.degraded || [];
  const missingScopes = index.missingScopes || [];

  const base = {
    topic,
    terms,
    termCoverage,
    indexedFileCount: index.files.length,
    indexSource: loaded.source,
    rebuilt: loaded.rebuilt,
    corpusFingerprint: index.corpusFingerprint,
    scopes: index.scopes,
    degradedCount: unreadable.length,
    missingScopes
  };

  if (kept.length) {
    return {
      ...base,
      outcome: 'hit',
      reason: 'PRIOR_WORK_FOUND',
      totalCandidates: ranked.length,
      results: kept.map(entry => {
        const file = index.files[entry.fileIndex];
        return {
          path: file.path,
          title: file.title,
          headings: file.headings,
          score: Math.round(entry.score * 10) / 10,
          matchedTerms: entry.matchedTerms,
          sizeBytes: file.size,
          modified: new Date(file.mtimeMs).toISOString().slice(0, 10)
        };
      })
    };
  }

  // Nothing cleared the floor. Now the honesty fork that this whole file exists
  // for: is this "nothing exists" or "I could not look"?
  if (missingScopes.length || unreadable.length) {
    return {
      ...base,
      outcome: 'unknown',
      reason: 'CORPUS_INCOMPLETE',
      why: `Cannot claim this topic is unexplored: ${missingScopes.length} scope(s) missing and `
        + `${unreadable.length} path(s) unreadable, so part of the corpus was never examined.`,
      results: []
    };
  }

  // An empty-but-readable directory tree is not evidence that a topic is
  // absent. In particular, accepting zero indexed files would let an empty
  // fixture, checkout, or accidentally cleared corpus turn every query into a
  // confident MISS without examining a single document.
  if (index.files.length === 0) {
    return {
      ...base,
      outcome: 'unknown',
      reason: 'EMPTY_CORPUS',
      why: 'Cannot claim this topic is unexplored: the corpus contained zero indexable files.',
      results: []
    };
  }

  const anyTermKnown = Object.values(termCoverage).some(count => count > 0);
  return {
    ...base,
    outcome: 'miss',
    reason: anyTermKnown ? 'NO_DOCUMENT_ABOVE_RELEVANCE_FLOOR' : 'TOPIC_ABSENT_FROM_CORPUS',
    why: anyTermKnown
      ? `Every scope was read. Some words of this topic appear in the corpus, but no document is `
        + `substantially about it. This is a genuine gap, not an unread corpus.`
      : `Every scope was read (${index.files.length} files) and none of these terms appear at all. `
        + `This topic has genuinely not been written up.`,
    results: []
  };
}

module.exports = {
  buildIndex,
  scanCorpus,
  getIndex,
  query,
  tokenize,
  stem,
  SCOPES,
  CACHE_FILE,
  CACHE_VERSION,
  ROOT
};

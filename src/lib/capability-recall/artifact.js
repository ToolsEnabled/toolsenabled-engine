'use strict';

// LOAD THE INDEX ONCE PER CONTENT, FREEZE IT, AND SHARE IT.
//
// The cost contract this whole design rests on is that a large fleet of agents
// costs the same as one. That is only true if the artifact is loaded once and
// every session reads the same frozen object -- so the singleton is not an
// optimisation here, it is the feature.
//
// ONCE PER CONTENT, not once per process lifetime: the memo below is keyed on
// the digest of the bytes it parsed, so a payload repacked under a running app
// is picked up on the next turn instead of being answered around forever. The
// numbers, and why the freshness check is a stat and not a digest, are on the
// memo itself.
//
// The lock is the same shape lean_rag/datastore/retrieve.py uses for its FAISS
// handle, and for the same reason: two turns arriving in the same tick must not
// both parse a 600 KB document.
//
// REFUSE RATHER THAN ANSWER BADLY. A missing artifact, a truncated one, a
// schema from a different build, or an index whose tokenizer disagrees with
// this process's tokenizer all produce a NAMED refusal, never a degraded
// answer. A tokenizer mismatch is the quiet one: the index would still respond,
// and would simply be wrong about which words exist -- see the note in text.js.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { TOKENIZER_VERSION } = require('./text');

const SCHEMA_VERSION = 'capability-index-v1';

/* THE ARTIFACT LIVES IN config/, AND THAT IS A SHIPPING DECISION.
 *
 * In the lane this was built in it sat at data/capability-index.json. Nothing
 * under data/ reaches a customer: the installer payload is derived from
 * tools/capability-manifest.json in the app repo, whose `dataFiles` list names
 * individual config/*.json files and no data/ path at all. An index that ships
 * to nobody is the trap tools/grepsaver-orient.js fell into with context/ --
 * present in the checkout, absent from every installed copy, and silently
 * answering nothing. So it is built here, beside settings-registry.json and
 * model-floor.json, and the app's manifest names this exact path. */
const DEFAULT_ARTIFACT = path.resolve(__dirname, '..', '..', '..', 'config', 'capability-index.json');

class ArtifactUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArtifactUnavailableError';
    this.code = code;
  }
}

const REQUIRED_KEYS = ['schemaVersion', 'tokenizerVersion', 'constants', 'N', 'avgLen', 'docs', 'df', 'postings', 'phrases'];

function validate(parsed, source) {
  for (const key of REQUIRED_KEYS) {
    if (parsed[key] === undefined) {
      throw new ArtifactUnavailableError('CAPABILITY_INDEX_MALFORMED', `${source} is missing "${key}".`);
    }
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new ArtifactUnavailableError(
      'CAPABILITY_INDEX_SCHEMA_MISMATCH',
      `${source} declares schema "${parsed.schemaVersion}" but this build reads "${SCHEMA_VERSION}". Rebuild the index.`
    );
  }
  if (parsed.tokenizerVersion !== TOKENIZER_VERSION) {
    throw new ArtifactUnavailableError(
      'CAPABILITY_INDEX_TOKENIZER_MISMATCH',
      `${source} was built by tokenizer "${parsed.tokenizerVersion}" and this process runs "${TOKENIZER_VERSION}". `
      + 'The index would still answer and would be wrong about which words exist in it, so it is refused. Rebuild.'
    );
  }
  if (!Array.isArray(parsed.docs) || parsed.docs.length === 0) {
    throw new ArtifactUnavailableError('CAPABILITY_INDEX_EMPTY', `${source} contains no documents.`);
  }
  if (parsed.docs.length !== parsed.N) {
    throw new ArtifactUnavailableError(
      'CAPABILITY_INDEX_MALFORMED',
      `${source} declares N=${parsed.N} but carries ${parsed.docs.length} documents.`
    );
  }
  return parsed;
}

/** Parse and validate without touching the singleton. Used by the tests. */
function parseArtifact(text, source = 'the capability index') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ArtifactUnavailableError('CAPABILITY_INDEX_UNPARSEABLE', `${source} is not readable JSON: ${error.message}`);
  }
  return Object.freeze(validate(parsed, source));
}

/* THE MEMO IS KEYED ON THE PAYLOAD'S CONTENT DIGEST, NOT ON "HAVE I EVER LOADED".
 *
 * MEASURED 2026-09-03, node 22.14 on Windows 10, against the shipped 591,109-byte
 * config/capability-index.json with a warm page cache. Three alternating A/B runs
 * of the same script, medians:
 *
 *                                          before      after
 *   recommend(), every turn after the first  0.178 ms   0.284 ms   +0.106 ms
 *   loadFrom(path)                          26.9   ms   0.090 ms   ~300x
 *   recommend({ artifactPath })             22.1   ms   0.222 ms   ~100x
 *   first recommend() in a process          49.22 ms    unchanged
 *     of that: readFileSync 3.41, JSON.parse 23.26, freeze 0.01 = 26.68 ms
 *   fs.statSync() of the artifact alone      0.076 ms   (n=3000)
 *   read + sha256 of the artifact            5.14  ms
 *   read + JSON.parse of the artifact       12.0   ms
 *
 * TWO THINGS CAME OUT OF THAT. The default path was already once per process,
 * which is the contract this file opens with and it holds. But it was ALSO never
 * looking at the file again, and this index ships inside a payload that is
 * REPACKED UNDER A RUNNING APP -- tools/pack-capability-layer.mjs rmSync's the
 * copied config/ and cpSync's a fresh one over it -- while the owner's standing
 * rule is that the app is never restarted. A process that had already answered
 * one turn kept answering from the pre-repack corpus for the rest of its life and
 * said nothing about it. The second thing is loadFrom(), which memoised nothing
 * and re-read and re-parsed 591 KB on every single call.
 *
 * SO THE MEMO KEY IS THE DIGEST OF THE BYTES THE ARTIFACT WAS PARSED FROM, and a
 * stat decides when that digest is worth computing:
 *
 *   stat unchanged            -> serve the memo.                   0.076 ms
 *   stat moved, digest same   -> serve the SAME frozen object.     5.14 ms, once
 *   digest differs            -> re-read, re-validate, re-freeze. ~27 ms, once
 *
 * Digesting on every call would cost 5.14 ms against a 0.178 ms answer and would
 * pull 591 KB through per turn per agent, which is precisely the "a fleet of
 * agents costs what one costs" contract the header states. Stat-gating keeps it:
 * the whole steady-state addition is that one stat -- +0.106 ms on a turn that is
 * about to wait on a model, and an eighth of the 0.9 ms settings read
 * capabilityRecallEnabled() already pays on the same turn for the same kind of
 * reason. Measured on the same run, building the stamp string costs nothing
 * beside the syscall (stat alone 0.076 ms; stat + Map lookup + stamp 0.073 ms),
 * so the readable shape is also the fast one.
 *
 * A REPACK IS A WINDOW, NOT A VERDICT. rmSync-then-cpSync means there are
 * milliseconds where the file is absent, and more where it is half written. The
 * artifact already in hand was validated from this same path, so during that
 * window it is served and the reason is recorded on lastRefreshRefusal(). Going
 * dark mid-repack would be strictly worse than the behaviour this replaces, which
 * never re-read at all. Nothing here is relaxed: a FIRST load with no memo behind
 * it still refuses by name, exactly as it did.
 */
const memo = new Map();
let pinnedSource = null;
let lastRefusal = null;
let loading = false;

function digestOf(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/* Cheap identity of the bytes on disk. size+mtime alone can miss a rewrite that
 * lands in the same millisecond at the same length; ctime and the file index move
 * too, and a repack that replaces the directory always changes the index. */
function stampOf(source) {
  try {
    const stat = fs.statSync(source);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  } catch {
    return null;
  }
}

function missingError(source, error) {
  return new ArtifactUnavailableError(
    'CAPABILITY_INDEX_MISSING',
    `the capability index could not be read at ${source} (${error.code || error.message}). `
    + 'It is built at ship time by tools/build-capability-index.js.'
  );
}

function keepPrevious(entry, source, reason) {
  lastRefusal = { source, reason, atMs: Date.now() };
  return entry.artifact;
}

/**
 * The artifact at `source`, parsed at most once per distinct content.
 *
 * Returns the identical frozen object for identical bytes, so callers holding
 * `artifact.docs` keep holding one copy no matter how often they ask.
 */
function readMemoized(source) {
  const entry = memo.get(source);
  const stamp = stampOf(source);

  if (entry && stamp !== null && stamp === entry.stamp) return entry.artifact;
  if (entry && stamp === null) return keepPrevious(entry, source, 'the artifact could not be stat-ed');

  let text;
  try {
    text = fs.readFileSync(source, 'utf8');
  } catch (error) {
    /* The SAME named refusal both entry points have always raised. Letting the
     * raw ENOENT escape here once gave a caller passing an explicit path the
     * generic CAPABILITY_INDEX_UNAVAILABLE while the identical failure through
     * load() got CAPABILITY_INDEX_MISSING -- two codes for one condition,
     * decided by which door happened to be used. */
    if (entry) return keepPrevious(entry, source, `the artifact could not be re-read (${error.code || error.message})`);
    throw missingError(source, error);
  }

  const digest = digestOf(text);
  if (entry && digest === entry.digest) {
    /* Same bytes at a new stat: a repack that produced an identical index, or a
     * touch. Do not re-parse and do not mint a second object. */
    entry.stamp = stamp;
    return entry.artifact;
  }

  let parsed;
  try {
    parsed = parseArtifact(text, source);
  } catch (error) {
    if (entry) return keepPrevious(entry, source, `the replacement artifact was refused (${error.code || error.message})`);
    throw error;
  }
  memo.set(source, { stamp, digest, artifact: parsed });
  lastRefusal = null;
  return parsed;
}

/**
 * The process-wide artifact.
 *
 * `artifactPath` is honoured only on the first call, which is deliberate: a
 * second caller pointing at a different index would otherwise silently get the
 * first one. Tests use `loadFrom()` instead of fighting the singleton. The path
 * that first call names is PINNED, and every later call re-checks that same file
 * -- so the pin survives a repack while the contents do not have to.
 */
function load({ artifactPath } = {}) {
  if (loading) {
    throw new ArtifactUnavailableError('CAPABILITY_INDEX_REENTRANT', 'the capability index is already loading in this process');
  }
  loading = true;
  try {
    if (pinnedSource === null) pinnedSource = artifactPath ? path.resolve(artifactPath) : DEFAULT_ARTIFACT;
    return readMemoized(pinnedSource);
  } finally {
    loading = false;
  }
}

/** Load a specific artifact, memoised on its content. Tests and the tuner use this. */
function loadFrom(artifactPath) {
  return readMemoized(path.resolve(artifactPath));
}

/** Why the last refresh kept the previous artifact, or null. */
function lastRefreshRefusal() {
  return lastRefusal;
}

/** Drop the singleton and every memo. Tests only. */
function reset() {
  memo.clear();
  pinnedSource = null;
  lastRefusal = null;
  loading = false;
}

function sha256Of(artifactPath) {
  return digestOf(fs.readFileSync(path.resolve(artifactPath), 'utf8'));
}

module.exports = Object.freeze({
  ArtifactUnavailableError,
  DEFAULT_ARTIFACT,
  SCHEMA_VERSION,
  lastRefreshRefusal,
  load,
  loadFrom,
  parseArtifact,
  reset,
  sha256Of,
});

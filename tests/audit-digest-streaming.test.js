'use strict';

// THE EXTERNAL WITNESS IS STREAMED NOW. IT MUST STILL BE THE SAME WITNESS.
//
// digestFileSet() is what verificationExternal() hashes the projection files
// with, and record() reaches verificationExternal six times per event. It used
// to readFileSync() each projection whole and hash the resulting Buffer; on the
// owner's install that is an 11.0 MB and a 6.4 MB allocation per audit record,
// twice per consequential tool call.
//
// MEASURED 2026-09-03 on the owner's machine over those two real files:
// readFileSync + sha256 of both is 73.7 ms, and the same digest taken through
// one 256 KB buffer is 61.3 ms. The bytes hashed, their order, and the hash are
// identical -- so every one of these cases asserts equality against a digest
// this file computes for itself out of a whole-file read, which is exactly the
// code path the change replaced. If the streaming loop ever hashes one byte
// more, fewer, or in a different order, these go red.
//
// The last case is the one this file exists for. This module has now carried
// the same defect three times -- an absolute sequence compared against a
// position in the live window, which agree only while nothing has been
// archived, so the first retention roll breaks it permanently and silently
// (unanchoredSuffix, advanceVerificationCache, and the projection slice before
// them). A digest of the projection files is exactly the kind of value that
// looks stable until a roll rewrites those files underneath it. So the roll is
// performed for real here, the projections are rebuilt onto the shorter live
// window, and the same equality plus the same cache behaviour is demanded on
// the other side of it.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('../src/lib/audit');
const { createAuditStore, canonicalJson, sha256 } = require('../src/lib/audit-store');

// Must match DIGEST_CHUNK_BYTES in src/lib/audit.js. Named here so a case can
// state plainly that it crosses more than one read, rather than hoping it does.
const DIGEST_CHUNK_BYTES = 256 * 1024;

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: `audit-ed25519-${crypto.createHash('sha256').update(der).digest('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

// The expected value, computed the old way: read the whole file, hash the
// Buffer. Only the row ORDER is borrowed from the subject (digestFileSet sorts
// the paths); every digest below comes from a whole-file read this file
// performs itself, so a streaming defect cannot be cancelled out.
function wholeFileSetDigest(paths) {
  const rows = [];
  for (const file of [...new Set(paths)].sort()) {
    const identity = path.resolve(file);
    if (!fs.existsSync(file)) {
      rows.push({ path: identity, exists: false });
      continue;
    }
    const bytes = fs.readFileSync(file);
    rows.push({ path: identity, exists: true, bytes: bytes.length, digest: sha256(bytes) });
  }
  return sha256(canonicalJson(rows));
}

function createHarness(label) {
  audit.resetForTests();
  audit.resetProjectionVerifyCache();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `audit-digest-${label}-`));
  fs.mkdirSync(path.join(directory, 'state'), { recursive: true });
  const files = {
    jsonl: path.join(directory, 'actions.jsonl'),
    text: path.join(directory, 'actions.log'),
    emergency: path.join(directory, 'emergency.jsonl')
  };
  const store = createAuditStore({ file: path.join(directory, 'audit.sqlite3') });
  const signer = testSigner();
  let anchor = null;
  let eventNumber = 0;
  let now = 1_700_000_000_000;
  const errors = [];
  // No `fs` key: the real filesystem, so digestFileSet takes the streaming
  // path. An injected double would take the whole-file path instead, which is
  // deliberate (several suites count exactly those reads) and is precisely why
  // this file must not inject one.
  const dependencies = {
    store,
    signer,
    anchorStore: {
      get: () => anchor,
      set(value, sequence) {
        const parsed = JSON.parse(value);
        assert.equal(parsed.sequence, sequence);
        anchor = value;
      }
    },
    loadPolicy: () => ({
      audit: {
        enabled: true,
        jsonlFile: 'actions.jsonl',
        textFile: 'actions.log',
        emergencyFile: 'emergency.jsonl'
      }
    }),
    loadSettings: () => ({ values: {}, rejected: [] }),
    rootPath: (...parts) => path.join(directory, ...parts),
    env: {},
    clock: () => now++,
    eventIdFactory: () => `audit-digest-${label}-${String(++eventNumber).padStart(5, '0')}`,
    reportError: message => errors.push(message)
  };
  return {
    dependencies, directory, errors, files, signer, store,
    record(details = { n: eventNumber }) {
      const result = audit.record('digest.test', label, details, dependencies);
      assert.equal(result.ok, true, JSON.stringify({ result, errors }));
      assert.equal(result.durable, true);
      assert.equal(result.projected, true, JSON.stringify({ result, errors }));
      return result;
    },
    cachedExternal() {
      const status = store.verificationCacheStatus();
      assert.equal(status.cached, true,
        'the verification cache must hold, or there is no witness to compare against');
      assert.ok(status.cachedExternal, 'the cached fingerprint must carry the external witness');
      return status.cachedExternal;
    },
    projectionPaths() { return [files.jsonl, files.text]; },
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      audit.resetForTests();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

// ~40 KB of scrubbable detail per event: ten fields at scrubText's 4,000
// character ceiling, which keeps the canonical event under audit-store's
// 64 KB MAX_EVENT_BYTES while making the projection grow fast enough to cross
// several read chunks in a handful of events.
function bulkyDetails(seed) {
  const out = {};
  for (let i = 0; i < 10; i += 1) {
    out[`field${i}`] = `${seed}-${i}-${'abcdefghij'.repeat(399)}`;
  }
  return out;
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('the streamed projection digest is the whole-file digest', () => {
  const test = createHarness('same');
  try {
    for (let i = 0; i < 5; i += 1) test.record({ i });
    const external = test.cachedExternal();
    assert.equal(external.projectionDigest, wholeFileSetDigest(test.projectionPaths()),
      'the streamed witness must be byte-for-byte the witness a whole-file read produces');
    const size = fs.statSync(test.files.jsonl).size;
    assert.ok(size > 0, 'an empty projection would not exercise the read loop at all');
    assert.notEqual(size % DIGEST_CHUNK_BYTES, 0,
      'this case must end on a partial chunk, which is where a reused buffer would leak stale bytes');
  } finally { test.cleanup(); }
});

check('a projection larger than one read chunk digests identically', () => {
  const test = createHarness('chunks');
  try {
    for (let i = 0; i < 24; i += 1) test.record(bulkyDetails(`bulk-${i}`));
    const jsonlSize = fs.statSync(test.files.jsonl).size;
    assert.ok(jsonlSize > 2 * DIGEST_CHUNK_BYTES,
      `the projection must span several full reads to exercise the loop; it was ${jsonlSize} bytes`);
    assert.notEqual(jsonlSize % DIGEST_CHUNK_BYTES, 0, 'and still finish on a partial read');
    assert.equal(test.cachedExternal().projectionDigest, wholeFileSetDigest(test.projectionPaths()),
      'a multi-chunk projection must hash to the same value as one whole-file read');
  } finally { test.cleanup(); }
});

check('an ordinary record reads no projection file whole', () => {
  const test = createHarness('budget');
  const realReadFileSync = fs.readFileSync;
  const realReadSync = fs.readSync;
  const watched = new Set(test.projectionPaths().map(file => path.resolve(file)));
  let wholeFileReads = 0;
  let chunkReads = 0;
  try {
    for (let i = 0; i < 3; i += 1) test.record({ warm: i });
    fs.readFileSync = function (target, ...rest) {
      if (typeof target === 'string' && watched.has(path.resolve(target))) wholeFileReads += 1;
      return realReadFileSync.call(this, target, ...rest);
    };
    fs.readSync = function (...args) {
      chunkReads += 1;
      return realReadSync.apply(this, args);
    };
    for (let i = 0; i < 3; i += 1) {
      test.record({ measured: i });
      assert.equal(test.store.verificationCacheStatus().lastResult, 'cache-hit',
        'a full re-verification would legitimately parse the projection and make this budget meaningless');
    }
  } finally {
    fs.readFileSync = realReadFileSync;
    fs.readSync = realReadSync;
  }
  try {
    assert.equal(wholeFileReads, 0,
      `a steady-state record must not materialize a projection file; it did ${wholeFileReads} times`);
    assert.ok(chunkReads > 0,
      'the witness must still be taken from the file: zero reads would mean it was invented');
  } finally { test.cleanup(); }
});

check('after an archive roll the streamed digest still verifies and the cache still advances', () => {
  const test = createHarness('roll');
  try {
    for (let i = 0; i < 8; i += 1) test.record({ before: i });

    const archiveFile = path.join(test.directory, 'state', 'audit-archive.jsonl');
    const rollDeps = { ...test.dependencies, archiveFile };
    for (let i = 0; i < 3; i += 1) {
      const rolled = audit.rollArchiveOnce(test.store, test.signer, rollDeps, { nowMs: 1_700_000_100_000 + i });
      assert.equal(rolled.rolled, true, `roll ${i} must actually archive an event`);
    }
    // The roll left the projections describing rows the live window no longer
    // has. Rebuilding them is what a retention roll does inside record(); doing
    // it here puts the ledger in the same post-roll state without needing a
    // ten-thousand-event window to reach it.
    const flushed = audit.flush({ force: true }, test.dependencies);
    assert.equal(flushed.projected, true, JSON.stringify({ flushed, errors: test.errors }));

    const boundary = audit.readArchiveBoundary(test.store, test.signer);
    assert.ok(boundary && boundary.archivedThroughSequence > 0,
      'a non-zero archive boundary is the entire point of this case');
    const liveRows = fs.readFileSync(test.files.jsonl, 'utf8').split('\n').filter(Boolean).length;
    assert.ok(liveRows < test.store.status().headSequence,
      'the live window must be genuinely shorter than the absolute head, or nothing was archived');

    // The boundary moved, so every cached fingerprint legitimately fails closed
    // and the first record after the roll re-verifies in full -- that is the
    // designed behaviour, not the defect. The defect is the SECOND one still
    // paying, and the third, and every one after that, which is what happened
    // for as long as the advance compared a live-window length against an
    // absolute head sequence. So absorb the boundary change, then demand that
    // five ordinary records cost nothing.
    test.record({ absorbBoundaryChange: true });
    const before = test.store.verificationCacheStatus();
    for (let i = 0; i < 5; i += 1) test.record({ after: i });
    const after = test.store.verificationCacheStatus();

    assert.equal(test.cachedExternal().projectionDigest, wholeFileSetDigest(test.projectionPaths()),
      'the witness must still be the whole-file witness once a roll has rewritten the projections');
    assert.equal(after.fullVerifications, before.fullVerifications,
      'five ordinary records after a roll must not cost one extra full signature walk');
    assert.ok(after.cacheAdvances > before.cacheAdvances,
      'the verification cache must keep advancing across the boundary, not quietly stop');

    const verified = audit.verify(test.dependencies);
    assert.equal(verified.valid, true, JSON.stringify({ verified, errors: test.errors }));
  } finally { test.cleanup(); }
});

check('a ledger with no projection files yet still agrees on the first record', () => {
  const test = createHarness('absent');
  try {
    // The first admission of a fresh install takes its witness while neither
    // projection exists at all, so digestFileSet's absent-file row and its
    // first-ever read of a newly created file are both on this path.
    assert.equal(fs.existsSync(test.files.jsonl), false, 'a fresh ledger has no projection yet');
    assert.equal(fs.existsSync(test.files.text), false);
    test.record({ first: true });
    assert.equal(test.cachedExternal().projectionDigest, wholeFileSetDigest(test.projectionPaths()),
      'the first record on a fresh ledger must agree with a whole-file read');
    // Reaching end-of-file is the loop's only exit, so every case above already
    // exercises it; what this one adds is the transition from "no file" to a
    // file smaller than a single read.
    assert.ok(fs.statSync(test.files.jsonl).size < DIGEST_CHUNK_BYTES,
      'and it must do so with a projection smaller than one read chunk');
  } finally { test.cleanup(); }
});

assert.ok(checks.length >= 5,
  'expected every digest-streaming case to be registered');

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-digest-streaming: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

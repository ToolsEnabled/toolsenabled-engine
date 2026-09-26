/* Mutation check:
 * Replaced `return Object.freeze(validate(parsed, source));` in artifact.js
 * with `return validate(parsed, source);`.
 * The edit landed, and this test file went red (exit 1).
 */

'use strict';

// Behavioural coverage for src/lib/capability-recall/artifact.js. Every check
// invokes an exported function with a concrete value; none inspect source text.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const artifact = require('../../src/lib/capability-recall/artifact');
const { TOKENIZER_VERSION } = require('../../src/lib/capability-recall/text');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-artifact-test-'));

function validArtifact(overrides = {}) {
  return {
    schemaVersion: artifact.SCHEMA_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    constants: { k1: 1.2 },
    N: 1,
    avgLen: 2,
    docs: [{ id: 'demo', len: 2 }],
    df: { demo: 1 },
    postings: { demo: [[0, 1]] },
    phrases: {},
    ...overrides,
  };
}

function write(name, value) {
  const destination = path.join(tempDir, name);
  fs.writeFileSync(destination, typeof value === 'string' ? value : JSON.stringify(value));
  return destination;
}

function rejectsWithCode(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.name, 'ArtifactUnavailableError');
    assert.equal(error.code, code);
    assert.ok(error instanceof artifact.ArtifactUnavailableError);
    return true;
  });
}

try {
  const parsed = artifact.parseArtifact(JSON.stringify(validArtifact()), 'fixture.json');
  assert.equal(parsed.docs[0].id, 'demo');
  assert.ok(Object.isFrozen(parsed), 'parseArtifact must freeze the shared top-level value');

  rejectsWithCode(() => artifact.parseArtifact('{', 'broken.json'), 'CAPABILITY_INDEX_UNPARSEABLE');

  const missingKey = validArtifact();
  delete missingKey.postings;
  rejectsWithCode(() => artifact.parseArtifact(JSON.stringify(missingKey)), 'CAPABILITY_INDEX_MALFORMED');
  rejectsWithCode(
    () => artifact.parseArtifact(JSON.stringify(validArtifact({ schemaVersion: 'future-schema' }))),
    'CAPABILITY_INDEX_SCHEMA_MISMATCH'
  );
  rejectsWithCode(
    () => artifact.parseArtifact(JSON.stringify(validArtifact({ tokenizerVersion: 'other-tokenizer' }))),
    'CAPABILITY_INDEX_TOKENIZER_MISMATCH'
  );
  rejectsWithCode(
    () => artifact.parseArtifact(JSON.stringify(validArtifact({ N: 0, docs: [] }))),
    'CAPABILITY_INDEX_EMPTY'
  );
  rejectsWithCode(
    () => artifact.parseArtifact(JSON.stringify(validArtifact({ N: 2 }))),
    'CAPABILITY_INDEX_MALFORMED'
  );

  const firstPath = write('first.json', validArtifact());
  const secondPath = write('second.json', validArtifact({ docs: [{ id: 'second', len: 2 }] }));
  assert.equal(artifact.loadFrom(secondPath).docs[0].id, 'second');
  rejectsWithCode(() => artifact.loadFrom(path.join(tempDir, 'absent.json')), 'CAPABILITY_INDEX_MISSING');

  artifact.reset();
  const firstLoad = artifact.load({ artifactPath: firstPath });
  assert.strictEqual(artifact.load({ artifactPath: secondPath }), firstLoad,
    'load must reuse the process singleton and ignore later paths');
  artifact.reset();
  assert.equal(artifact.load({ artifactPath: secondPath }).docs[0].id, 'second',
    'reset must allow the next load to select a new artifact');

  const expectedDigest = crypto.createHash('sha256').update(fs.readFileSync(firstPath, 'utf8'), 'utf8').digest('hex');
  assert.equal(artifact.sha256Of(firstPath), expectedDigest);

  /* ---------------------------------------------- a repacked payload is picked up
   *
   * The payload this index ships inside is rebuilt UNDER A RUNNING APP by
   * tools/pack-capability-layer.mjs, and the owner's standing rule is that the
   * app is never restarted. Every check below rewrites the file at a path that
   * has already been read and asserts what the NEXT read answers. */
  artifact.reset();
  const payloadPath = write('payload.json', validArtifact({ docs: [{ id: 'before-the-repack', len: 2 }] }));

  assert.equal(artifact.loadFrom(payloadPath).docs[0].id, 'before-the-repack');

  /* A repack. Different bytes at the same path: the next read must see them. */
  write('payload.json', validArtifact({ docs: [{ id: 'after-the-repack', len: 2 }] }));
  assert.equal(artifact.loadFrom(payloadPath).docs[0].id, 'after-the-repack',
    'a repacked payload must be picked up on the next read, not answered around until restart');
  assert.equal(artifact.lastRefreshRefusal(), null,
    'a clean repack leaves nothing to explain');

  /* And through load(), which is the door the product actually uses: pinned to
   * the path its first call named, re-checked on every later call. */
  artifact.reset();
  assert.equal(artifact.load({ artifactPath: payloadPath }).docs[0].id, 'after-the-repack');
  write('payload.json', validArtifact({ docs: [{ id: 'repacked-again', len: 2 }] }));
  assert.equal(artifact.load().docs[0].id, 'repacked-again',
    'the process-wide load must see a repack of the file it is pinned to');

  /* THE MEMO IS ON THE CONTENT, NOT ON THE TIMESTAMP. A repack that produced
   * identical bytes -- or a plain touch -- must not re-parse and must not mint a
   * second copy, or a fleet stops costing what one costs. Object identity is the
   * observable that says it did not re-parse. */
  const shared = artifact.loadFrom(payloadPath);
  assert.strictEqual(artifact.loadFrom(payloadPath), shared,
    'an unchanged artifact must be served from the memo, not parsed again');
  const moved = new Date(Date.now() + 60_000);
  fs.utimesSync(payloadPath, moved, moved);
  assert.strictEqual(artifact.loadFrom(payloadPath), shared,
    'same bytes at a new timestamp must reuse the parsed copy, not make a second one');

  /* A REPACK IS A WINDOW, NOT A VERDICT. rmSync-then-cpSync leaves moments where
   * the file is half written, and more where it is not there at all. The corpus
   * already validated from this path is served through both, and the reason is
   * on the record rather than swallowed. */
  fs.writeFileSync(payloadPath, '{"schemaVersion": "capability-ind');
  assert.strictEqual(artifact.loadFrom(payloadPath), shared,
    'a half-written repack must keep the last good index, never take the recommender down');
  const midWrite = artifact.lastRefreshRefusal();
  assert.equal(midWrite.source, payloadPath);
  assert.match(midWrite.reason, /refused \(CAPABILITY_INDEX_UNPARSEABLE\)/);

  fs.rmSync(payloadPath, { force: true });
  assert.strictEqual(artifact.loadFrom(payloadPath), shared,
    'a payload removed mid-repack must keep the last good index');
  assert.match(artifact.lastRefreshRefusal().reason, /could not be (stat-ed|re-read)/);

  write('payload.json', validArtifact({ docs: [{ id: 'after-the-window', len: 2 }] }));
  assert.equal(artifact.loadFrom(payloadPath).docs[0].id, 'after-the-window',
    'once the repack lands, the next read must take it up');
  assert.equal(artifact.lastRefreshRefusal(), null);

  /* NOTHING RELAXED. A first read with no validated copy behind it still refuses
   * by name -- the memo may only ever hold a refusal off, never a first answer. */
  artifact.reset();
  rejectsWithCode(() => artifact.loadFrom(path.join(tempDir, 'never-existed.json')), 'CAPABILITY_INDEX_MISSING');
  const trashPath = write('trash.json', '{ not json');
  rejectsWithCode(() => artifact.loadFrom(trashPath), 'CAPABILITY_INDEX_UNPARSEABLE');
  const staleSchemaPath = write('stale-schema.json', validArtifact({ schemaVersion: 'capability-index-v0' }));
  rejectsWithCode(() => artifact.load({ artifactPath: staleSchemaPath }), 'CAPABILITY_INDEX_SCHEMA_MISMATCH');

  console.log('PASS artifact parsing, named refusals, file loading, singleton reset, digest behaviour, '
    + 'and repack invalidation');
} finally {
  artifact.reset();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

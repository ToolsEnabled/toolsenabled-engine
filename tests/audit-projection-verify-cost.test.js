// EXECUTABLE CHANGE
//
// Discrimination audit (testcanfail-tests-audit-projection-verify-cost-test-js):
// - VACUOUS COLLECTION: FOUND in the final `tests` loop. Mutation: replace the
//   seven-entry test list with `[]`. Before the guard, the runner stayed green:
//   "Audit projection verification-cost tests passed (0 cases)." After adding
//   the guard, the same mutation went RED with
//   "AssertionError [ERR_ASSERTION]: expected every verification-cost case to be registered".
// - EXIT STATUS / TRUTHY RETURN USING ONLY SUBJECT OUTPUT: NOT-FOUND. This file
//   neither spawns a process nor treats a generic non-zero status as evidence.
// - SWALLOWED FAILURE (try/catch or optional chaining): NOT-FOUND. The `finally`
//   in `withHarness` only performs cleanup; it does not catch callback failures.
// - MOCK OF THE SUBJECT: NOT-FOUND. Injected filesystem and store wrappers count
//   calls around the real audit implementation rather than replace its behavior.
// - SKIP / PLATFORM PRECONDITION GUARD: NOT-FOUND. All registered cases execute.
// - EXPECTED VALUE COMPUTED BY THE SAME CODE: NOT-FOUND. Captured projection
//   bytes are used only as before-tamper restoration witnesses; cost assertions
//   use literal, independently specified counts and cursor values.
// - PRECONDITION: Node.js >=22.19.0 is required for `node:sqlite`; the default
//   Node.js v20.20.2 could not load it, so verification used Node.js v22.22.2.
// - RESTORATION: the temporary empty-list mutation was restored byte-for-byte.
//   The restored test run was green: "Audit projection verification-cost tests passed (7 cases)."

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('../src/lib/audit');
const { createAuditStore, ZERO_HASH } = require('../src/lib/audit-store');

const FULL_VERIFY_EVERY = 200;

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId: `audit-projection-${crypto.randomUUID().replace(/-/g, '')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

function countedFs(files) {
  const projectionPaths = new Map(Object.entries(files)
    .filter(([sink]) => sink === 'jsonl' || sink === 'text')
    .map(([sink, file]) => [path.resolve(file), sink]));
  const reads = { jsonl: 0, text: 0 };
  const io = new Proxy(fs, {
    get(target, property) {
      if (property === 'readFileSync') {
        return (file, ...args) => {
          const sink = projectionPaths.get(path.resolve(String(file)));
          if (sink) reads[sink] += 1;
          return target.readFileSync(file, ...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return {
    io,
    resetReads() { reads.jsonl = 0; reads.text = 0; },
    readCounts() { return { ...reads }; }
  };
}

function createHarness(label, overrides = {}) {
  audit.resetForTests();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `audit-projection-${label}-`));
  const files = {
    jsonl: path.join(directory, 'actions.jsonl'),
    text: path.join(directory, 'actions.log'),
    emergency: path.join(directory, 'emergency.jsonl')
  };
  const trackedFs = countedFs(files);
  const store = createAuditStore({ file: ':memory:' });
  const listRequests = [];
  const listEvents = store.listEvents.bind(store);
  store.listEvents = options => {
    listRequests.push({ ...options });
    return listEvents(options);
  };
  let anchor = null;
  let eventNumber = 0;
  let now = 1_700_000_000_000;
  const errors = [];
  const dependencies = {
    store,
    signer: testSigner(),
    fs: trackedFs.io,
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
    rootPath: value => path.join(directory, value),
    env: {},
    clock: () => now++,
    eventIdFactory: () => `audit-projection-${label}-${String(++eventNumber).padStart(4, '0')}`,
    reportError: message => errors.push(message),
    ...overrides
  };
  return {
    dependencies,
    directory,
    errors,
    files,
    listRequests,
    store,
    trackedFs,
    record(action = 'projection.test') {
      const result = audit.record(action, label, { eventNumber }, dependencies);
      assert.equal(result.ok, true, JSON.stringify({ result, errors }));
      assert.equal(result.durable, true);
      assert.equal(result.projected, true, JSON.stringify({ result, errors }));
      return result;
    },
    flush(options = {}) {
      const result = audit.flush(options, dependencies);
      assert.equal(result.projected, true, JSON.stringify({ result, errors }));
      assert.equal(result.pending, 0);
      assert.deepEqual(result.errors, []);
      return result;
    },
    resetMeasurements() {
      trackedFs.resetReads();
      listRequests.length = 0;
    },
    close() {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
      audit.resetForTests();
    }
  };
}

function withHarness(label, callback, overrides = {}) {
  const harness = createHarness(label, overrides);
  try { callback(harness); }
  finally { harness.close(); }
}

function testQuietProjectionSkipsParseAndLedgerScan() {
  withHarness('quiet', harness => {
    harness.record('projection.quiet.seed');
    harness.resetMeasurements();

    harness.flush();

    assert.deepEqual(harness.trackedFs.readCounts(), { jsonl: 2, text: 2 },
      'the warm admission witness reads each projection twice, but flush must not add another read to parse it');
    assert.deepEqual(harness.listRequests.map(request => request.afterSequence), [1, 1],
      'the trusted flush must request only events after each cached sink position');

    audit.resetProjectionVerifyCache();
    harness.resetMeasurements();
    harness.flush();
    assert.deepEqual(harness.trackedFs.readCounts(), { jsonl: 2, text: 2 },
      'after the canonical cache is consumed, an absent projection cache must take one digest read plus one full parse');
    assert.deepEqual(harness.listRequests.map(request => request.afterSequence), [0],
      'the full path may share one complete ledger page-through across both sinks');
  });
}

function testExternalEditIsCaughtAndRebuilt() {
  withHarness('external-edit', harness => {
    harness.record('projection.external.seed');
    const expected = fs.readFileSync(harness.files.jsonl, 'utf8');
    fs.appendFileSync(harness.files.jsonl, 'external edit\n', 'utf8');
    harness.resetMeasurements();

    harness.flush();

    assert.equal(fs.readFileSync(harness.files.jsonl, 'utf8'), expected);
    assert.equal(harness.trackedFs.readCounts().jsonl, 3,
      'the changed file must add the full parse/rebuild read to the two-read warm admission witness');
  });
}

function testTruncationIsCaughtAndRebuilt() {
  withHarness('truncation', harness => {
    harness.record('projection.truncation.one');
    harness.record('projection.truncation.two');
    const expected = fs.readFileSync(harness.files.text, 'utf8');
    const firstLineEnd = expected.indexOf('\n') + 1;
    assert.ok(firstLineEnd > 0);
    fs.writeFileSync(harness.files.text, expected.slice(0, firstLineEnd), 'utf8');
    harness.resetMeasurements();

    harness.flush();

    assert.equal(fs.readFileSync(harness.files.text, 'utf8'), expected);
    assert.equal(harness.store.status().sinks.text.lastSequence, 2);
    assert.equal(harness.trackedFs.readCounts().text, 3);
  });
}

function testDeletedProjectionIsRebuilt() {
  withHarness('deleted', harness => {
    harness.record('projection.deleted.seed');
    const expected = fs.readFileSync(harness.files.text, 'utf8');
    fs.unlinkSync(harness.files.text);
    harness.resetMeasurements();

    harness.flush();

    assert.equal(fs.existsSync(harness.files.text), true);
    assert.equal(fs.readFileSync(harness.files.text, 'utf8'), expected);
    assert.equal(harness.store.status().sinks.text.lastSequence, 1);
  });
}

function testForceAlwaysUsesFullPath() {
  withHarness('force', harness => {
    harness.record('projection.force.seed');
    harness.resetMeasurements();
    harness.flush({ force: true });
    assert.deepEqual(harness.trackedFs.readCounts(), { jsonl: 3, text: 3 },
      'force:true must add a full projection read for both sinks to the two-read warm admission witness');
    assert.deepEqual(harness.listRequests.map(request => request.afterSequence), [0]);
  });
}

function testPeriodicFullVerifyFiresAtBound() {
  withHarness('periodic', harness => {
    harness.record('projection.periodic.seed');
    const expected = fs.readFileSync(harness.files.jsonl, 'utf8');
    const before = fs.statSync(harness.files.jsonl);
    const tampered = expected.replace('projection.periodic.seed', 'projection.tampered.seed');
    assert.notEqual(tampered, expected);
    assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(expected));
    fs.writeFileSync(harness.files.jsonl, tampered, 'utf8');
    fs.utimesSync(harness.files.jsonl, before.atimeMs / 1000, before.mtimeMs / 1000);
    const disguised = fs.statSync(harness.files.jsonl);
    assert.equal(disguised.size, before.size);
    assert.equal(disguised.mtimeMs, before.mtimeMs,
      'the test must preserve both cached fingerprint fields to exercise the bounded blind window');

    for (let check = 1; check < FULL_VERIFY_EVERY; check += 1) {
      harness.resetMeasurements();
      harness.flush();
      const expectedReads = check === 1 ? 2 : 1;
      assert.deepEqual(harness.trackedFs.readCounts(), { jsonl: expectedReads, text: expectedReads },
        `verification ${check} should still use the bounded fast path`);
      assert.equal(fs.readFileSync(harness.files.jsonl, 'utf8'), tampered,
        `the deliberately bounded blind window should remain open through verification ${check}`);
    }

    harness.resetMeasurements();
    harness.flush();
    assert.deepEqual(harness.trackedFs.readCounts(), { jsonl: 2, text: 2 },
      `verification ${FULL_VERIFY_EVERY} must force the full projection path`);
    assert.deepEqual(harness.listRequests.map(request => request.afterSequence), [0]);
    assert.equal(fs.readFileSync(harness.files.jsonl, 'utf8'), expected,
      `verification ${FULL_VERIFY_EVERY} must rebuild a same-size, restored-mtime edit`);
  }, {
    appendFileSync(file, content, encoding) {
      fs.appendFileSync(file, content, encoding);
      fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    }
  });
}

function testStorePositionMismatchFailsClosed() {
  withHarness('position', harness => {
    const recorded = harness.record('projection.position.seed');
    harness.store.setSinkPosition({
      sink: 'jsonl', sequence: 0, eventHash: ZERO_HASH, updatedAtMs: 1_700_000_001_000
    });
    harness.resetMeasurements();

    harness.flush();

    const state = harness.store.status().sinks.jsonl;
    assert.equal(state.lastSequence, 1);
    assert.equal(state.lastHash, recorded.eventHash);
    assert.equal(harness.trackedFs.readCounts().jsonl, 2,
      'a cache/store cursor disagreement must take the full comparison path');
  });
}

const tests = [
  testQuietProjectionSkipsParseAndLedgerScan,
  testExternalEditIsCaughtAndRebuilt,
  testTruncationIsCaughtAndRebuilt,
  testDeletedProjectionIsRebuilt,
  testForceAlwaysUsesFullPath,
  testPeriodicFullVerifyFiresAtBound,
  testStorePositionMismatchFailsClosed
];

assert.equal(tests.length, 7,
  'expected every verification-cost case to be registered');
for (const test of tests) test();

console.log(`Audit projection verification-cost tests passed (${tests.length} cases).`);

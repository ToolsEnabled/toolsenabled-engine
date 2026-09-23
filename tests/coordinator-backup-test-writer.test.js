// NOTHING FOUND
//
// Discrimination audit (2026-08-26): no assertion needed strengthening.
//
// Mutation evidence:
// - Empty snapshot-count loop: exported MAX_SNAPSHOTS as 0 while retaining the
//   implementation limit. The loop became empty and the following assertion
//   failed RED with "+ 'Q37_TEST_ONLY_COMMITTED'" and
//   "- 'Q37_LIMIT_REFUSED'" (AssertionError at the countRefusal assertion).
// - Empty store-count loop: exported MAX_TOTAL_STORES as 0 while retaining the
//   implementation limit. The loop became empty and the following assertion
//   failed RED with "+ [Object: null prototype] {}" and "- null"
//   (AssertionError at the createTestOnlyStore assertion).
// - Forbidden-surface loop: inserted `require('node:fs');` in the writer. The
//   test failed RED with "writer source contains forbidden surface
//   /node:(?:fs|os|path|process|child_process)/" and "true !== false".
// - Independently computed manifest expectation: changed the writer's manifest
//   root binding to `mutation-binding`. The test failed RED with
//   "+ 'not-committed'" and "- 'committed'" before it could report the mutated
//   manifest, demonstrating that the independent verification contract rejects
//   the mutation.
//
// Shape census:
// - (1) NOT-FOUND: every potentially empty loop has a discriminating assertion
//   after it; the other iterated collections are non-empty array literals.
// - (2) NOT-FOUND: this test does not spawn a process or assert an exit status or
//   truthy process return.
// - (3) NOT-FOUND: the outer catch reports the failure and sets exitCode = 1;
//   there is no optional-chain or catch that swallows an assertion failure.
// - (4) NOT-FOUND: no dependency is mocked.
// - (5) NOT-FOUND: there are no skips, platform branches, or precondition guards.
// - (6) NOT-FOUND: expected hashes use Node crypto plus the separate artifact
//   plan contract rather than the writer's manifest implementation; the root-
//   binding mutation above was rejected.
//
// Preconditions: all met. Each source mutation was temporary; the writer was
// restored byte-for-byte (matching SHA-256 before and after), and the restored
// test run completed with "coordinator-backup-test-writer: 8 checks passed".

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const artifactPlan = require('../src/lib/coordinator/backup-artifact-plan.js');
const writer = require('../src/lib/coordinator/backup-test-writer.js');

let passed = 0;

function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function fixtureArtifacts(first = 'bundle fixture', second = 'encrypted fixture') {
  return [
    { name: 'repo.bundle', bytes: Buffer.from(first) },
    { name: 'vault-state.enc', bytes: Buffer.from(second) }
  ];
}

function input(store, overrides = {}) {
  return {
    store,
    snapshotName: 'snapshot-20260730T010203Z',
    artifacts: fixtureArtifacts(),
    ...overrides
  };
}

function expectedManifestHash(snapshotName, artifacts) {
  const manifest = {
    schemaVersion: 1,
    kind: 'backup-manifest',
    mode: 'test-only',
    rootBinding: artifactPlan.ROOT_BINDING,
    snapshotName,
    createdAt: artifactPlan.snapshotIso(snapshotName),
    artifacts: artifacts.map(artifact => ({
      name: artifact.name,
      bytes: artifact.bytes.byteLength,
      sha256: crypto.createHash('sha256').update(artifact.bytes).digest('hex')
    }))
  };
  return crypto.createHash('sha256').update(Buffer.from(JSON.stringify(manifest), 'utf8')).digest('hex');
}

function daySnapshot(index) {
  const instant = new Date(Date.UTC(2026, 0, index + 1, 0, 0, 0));
  return `snapshot-${instant.toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z')}`;
}

function run() {
  process.stdout.write('coordinator-backup-test-writer\n');

  check('mints an opaque frozen, no-input test-store capability', () => {
    assert.equal(writer.createTestOnlyStore.length, 0);
    const store = writer.createTestOnlyStore();
    assert.equal(Object.isFrozen(store), true);
    assert.deepEqual(Reflect.ownKeys(store), []);
    assert.equal(writer.createTestOnlyStore({ ignored: true }), null);
  });

  check('copies canonical fixture bytes, reports only hashes, and verifies without a restore', () => {
    const store = writer.createTestOnlyStore();
    const artifacts = fixtureArtifacts();
    const snapshotName = 'snapshot-20260730T010203Z';
    const result = writer.writeTestOnlyBackup({ store, snapshotName, artifacts });

    assert.equal(result.status, 'committed');
    assert.equal(result.code, 'Q37_TEST_ONLY_COMMITTED');
    assert.equal(result.manifestSha256, expectedManifestHash(snapshotName, artifacts));
    assert.deepEqual(result.artifactSha256, artifacts.map(artifact => crypto.createHash('sha256').update(artifact.bytes).digest('hex')));
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.artifactSha256), true);
    assert.deepEqual(Object.keys(result), ['schemaVersion', 'kind', 'status', 'snapshotName', 'code', 'manifestSha256', 'artifactSha256', 'productionActivation', 'artifactsDeleted']);
    assert.equal(JSON.stringify(result).includes('bundle fixture'), false);
    assert.equal(JSON.stringify(result).includes('encrypted fixture'), false);

    const restore = writer.verifyTestOnlyRestoreContract({ store, snapshotName });
    assert.equal(restore.status, 'verified');
    assert.equal(restore.restoreAttempted, false);
    assert.equal(restore.restoreAuthorized, false);
    assert.equal(restore.productionActivation, 'disabled');
    assert.equal(JSON.stringify(restore).includes('bundle fixture'), false);
  });

  check('uses copied inputs: caller mutation cannot change the stored verification or reported hash', () => {
    const store = writer.createTestOnlyStore();
    const artifacts = fixtureArtifacts('before mutation', 'second before mutation');
    const snapshotName = 'snapshot-20260729T010203Z';
    const expected = expectedManifestHash(snapshotName, artifacts);
    const result = writer.writeTestOnlyBackup({ store, snapshotName, artifacts });
    artifacts[0].bytes.fill(0);
    artifacts[1].bytes.write('changed');

    assert.equal(result.status, 'committed');
    assert.equal(result.manifestSha256, expected);
    assert.equal(writer.verifyTestOnlyRestoreContract({ store, snapshotName }).status, 'verified');
  });

  check('refuses duplicate names and leaves failures uncommitted', () => {
    const store = writer.createTestOnlyStore();
    const snapshotName = 'snapshot-20260728T010203Z';
    assert.equal(writer.writeTestOnlyBackup({ store, snapshotName, artifacts: fixtureArtifacts() }).status, 'committed');
    const duplicate = writer.writeTestOnlyBackup({ store, snapshotName, artifacts: fixtureArtifacts('other', 'other two') });
    assert.equal(duplicate.status, 'not-committed');
    assert.equal(duplicate.code, 'Q37_DUPLICATE_REFUSED');

    const failedName = 'snapshot-20260727T010203Z';
    const invalid = writer.writeTestOnlyBackup({
      store,
      snapshotName: failedName,
      artifacts: [{ name: 'repo.bundle', bytes: Buffer.from('one') }, { name: 'vault-state.enc', bytes: Buffer.from('two'), sourcePath: 'never accepted' }]
    });
    assert.equal(invalid.status, 'not-committed');
    assert.equal(writer.verifyTestOnlyRestoreContract({ store, snapshotName: failedName }).status, 'unavailable');
    assert.equal(writer.writeTestOnlyBackup({ store, snapshotName: failedName, artifacts: fixtureArtifacts() }).status, 'committed');
  });

  check('refuses noncanonical or future names and the retired path-shaped schema', () => {
    const store = writer.createTestOnlyStore();
    const malformed = writer.writeTestOnlyBackup({ store, snapshotName: 'snapshot-not-a-time', artifacts: fixtureArtifacts() });
    const future = writer.writeTestOnlyBackup({ store, snapshotName: 'snapshot-20991231T235959Z', artifacts: fixtureArtifacts() });
    const legacy = writer.writeTestOnlyBackup({ root: store, snapshotName: 'snapshot-20260726T010203Z', artifacts: fixtureArtifacts() });

    for (const refusal of [malformed, future, legacy]) {
      assert.equal(refusal.status, 'not-committed');
      assert.equal(refusal.code, 'Q37_TEST_ONLY_INPUT_REFUSED');
      assert.equal(refusal.productionActivation, 'disabled');
    }
  });

  check('enforces per-artifact, aggregate, store, and snapshot-count limits', () => {
    const oversizedStore = writer.createTestOnlyStore();
    const oversized = writer.writeTestOnlyBackup({
      store: oversizedStore,
      snapshotName: 'snapshot-20260725T010203Z',
      artifacts: [{ name: 'repo.bundle', bytes: Buffer.alloc(writer.MAX_ARTIFACT_BYTES + 1) }, { name: 'vault-state.enc', bytes: Buffer.alloc(1) }]
    });
    assert.equal(oversized.code, 'Q37_TEST_ONLY_INPUT_REFUSED');

    const aggregateStore = writer.createTestOnlyStore();
    const aggregatePart = Math.floor(writer.MAX_SNAPSHOT_BYTES / 2) + 1;
    const aggregate = writer.writeTestOnlyBackup({
      store: aggregateStore,
      snapshotName: 'snapshot-20260724T010203Z',
      artifacts: [{ name: 'repo.bundle', bytes: Buffer.alloc(aggregatePart) }, { name: 'vault-state.enc', bytes: Buffer.alloc(aggregatePart) }]
    });
    assert.equal(aggregate.code, 'Q37_TEST_ONLY_INPUT_REFUSED');
    assert.equal(writer.verifyTestOnlyRestoreContract({ store: aggregateStore, snapshotName: 'snapshot-20260724T010203Z' }).status, 'unavailable');

    const boundedStore = writer.createTestOnlyStore();
    const storePart = Math.floor(writer.MAX_SNAPSHOT_BYTES / 2);
    const first = writer.writeTestOnlyBackup({
      store: boundedStore,
      snapshotName: 'snapshot-20260723T010203Z',
      artifacts: [{ name: 'repo.bundle', bytes: Buffer.alloc(storePart) }, { name: 'vault-state.enc', bytes: Buffer.alloc(storePart) }]
    });
    const second = writer.writeTestOnlyBackup({
      store: boundedStore,
      snapshotName: 'snapshot-20260722T010203Z',
      artifacts: [{ name: 'repo.bundle', bytes: Buffer.alloc(storePart) }, { name: 'vault-state.enc', bytes: Buffer.alloc(storePart) }]
    });
    assert.equal(first.status, 'committed');
    assert.equal(second.code, 'Q37_LIMIT_REFUSED');
    assert.equal(writer.verifyTestOnlyRestoreContract({ store: boundedStore, snapshotName: 'snapshot-20260722T010203Z' }).status, 'unavailable');

    const countStore = writer.createTestOnlyStore();
    for (let index = 0; index < writer.MAX_SNAPSHOTS; index += 1) {
      assert.equal(writer.writeTestOnlyBackup({ store: countStore, snapshotName: daySnapshot(index), artifacts: fixtureArtifacts('a', 'b') }).status, 'committed');
    }
    const countRefusal = writer.writeTestOnlyBackup({ store: countStore, snapshotName: daySnapshot(writer.MAX_SNAPSHOTS), artifacts: fixtureArtifacts('a', 'b') });
    assert.equal(countRefusal.code, 'Q37_LIMIT_REFUSED');
  });

  check('enforces monotonic module-wide store-count and retained-byte budgets', () => {
    const modulePath = require.resolve('../src/lib/coordinator/backup-test-writer.js');
    delete require.cache[modulePath];
    const isolatedWriter = require(modulePath);

    const stores = [];
    for (let index = 0; index < isolatedWriter.MAX_TOTAL_STORES; index += 1) {
      const store = isolatedWriter.createTestOnlyStore();
      assert.notEqual(store, null);
      stores.push(store);
    }
    assert.equal(isolatedWriter.createTestOnlyStore(), null);

    delete require.cache[modulePath];
    const byteWriter = require(modulePath);
    const firstStore = byteWriter.createTestOnlyStore();
    const secondStore = byteWriter.createTestOnlyStore();
    const halfMiB = 512 * 1024;
    const boundedArtifacts = [
      { name: 'repo.bundle', bytes: Buffer.alloc(halfMiB) },
      { name: 'vault-state.enc', bytes: Buffer.alloc(halfMiB) }
    ];
    assert.equal(byteWriter.writeTestOnlyBackup({
      store: firstStore,
      snapshotName: 'snapshot-20260720T010203Z',
      artifacts: boundedArtifacts
    }).status, 'committed');
    const globalRefusal = byteWriter.writeTestOnlyBackup({
      store: secondStore,
      snapshotName: 'snapshot-20260719T010203Z',
      artifacts: boundedArtifacts
    });
    assert.equal(globalRefusal.status, 'not-committed');
    assert.equal(globalRefusal.code, 'Q37_LIMIT_REFUSED');
    assert.equal(byteWriter.verifyTestOnlyRestoreContract({
      store: secondStore,
      snapshotName: 'snapshot-20260719T010203Z'
    }).status, 'unavailable');
  });

  check('hard-refuses retention deletion and statically excludes host-I/O and activation surfaces', () => {
    assert.deepEqual(writer.refuseRetentionDeletion(), {
      schemaVersion: 1,
      kind: 'backup-retention',
      status: 'refused',
      code: 'Q37_DELETION_REFUSED',
      artifactsDeleted: 0,
      productionActivation: 'disabled'
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coordinator', 'backup-test-writer.js'), 'utf8');
    for (const forbidden of [
      /node:(?:fs|os|path|process|child_process)/,
      /\b(?:fsImpl|backupRoot|stageToken|renameSync|writeFileSync|readFileSync|mkdirSync|lstatSync|realpathSync)\b/,
      /(?:node:|require\()['"][^'"]*(?:scheduler|vault)(?:[/'"])/i,
      /\b(?:exec(?:File)?Sync|spawn(?:Sync)?|unlink|rmSync|rmdir)\b/
    ]) {
      assert.equal(forbidden.test(source), false, `writer source contains forbidden surface ${forbidden}`);
    }
    assert.deepEqual([...source.matchAll(/require\(([^)]+)\)/g)].map(match => match[1]), ["'node:crypto'", "'node:util'"]);
    assert.equal(/createTestOnlyRoot/.test(source), false);
  });

  process.stdout.write(`\ncoordinator-backup-test-writer: ${passed} checks passed\n`);
}

try {
  run();
} catch (error) {
  process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`);
  process.exitCode = 1;
}

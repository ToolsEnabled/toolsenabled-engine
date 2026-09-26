/* Mutation check:
 * Changed the module's successful result status from 'committed' to 'not-committed'.
 * The edit landed: yes.
 * This isolated test file went red: yes (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const writer = require('../src/lib/coordinator/backup-test-writer.js');

test('writes copied fixture bytes and exposes verification without authorizing a restore', () => {
  const store = writer.createTestOnlyStore();
  const snapshotName = 'snapshot-20260801T120000Z';
  const artifacts = [
    { name: 'repo.bundle', bytes: Buffer.from('repository fixture') },
    { name: 'vault-state.enc', bytes: new Uint8Array([0, 1, 2, 253, 254, 255]) }
  ];
  const expectedHashes = artifacts.map(({ bytes }) =>
    crypto.createHash('sha256').update(bytes).digest('hex'));

  const written = writer.writeTestOnlyBackup({ store, snapshotName, artifacts });

  assert.equal(written.status, 'committed');
  assert.equal(written.code, 'Q37_TEST_ONLY_COMMITTED');
  assert.deepEqual(written.artifactSha256, expectedHashes);
  assert.equal(written.productionActivation, 'disabled');
  assert.equal(written.artifactsDeleted, 0);

  artifacts[0].bytes.fill(0);
  artifacts[1].bytes.fill(0);

  assert.deepEqual(writer.verifyTestOnlyRestoreContract({ store, snapshotName }), {
    kind: 'backup-restore-verification-contract',
    mode: 'test-only',
    verifies: ['manifest-schema', 'artifact-byte-length', 'artifact-sha256'],
    restoreAttempted: false,
    restoreAuthorized: false,
    productionActivation: 'disabled',
    status: 'verified',
    snapshotName
  });

  assert.deepEqual(writer.refuseRetentionDeletion(), {
    schemaVersion: 1,
    kind: 'backup-retention',
    status: 'refused',
    code: 'Q37_DELETION_REFUSED',
    artifactsDeleted: 0,
    productionActivation: 'disabled'
  });
});

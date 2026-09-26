'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

const writerPath = require.resolve('../src/lib/coordinator/backup-test-writer.js');

function artifacts() {
  return [
    { name: 'repo.bundle', bytes: Buffer.from('repository fixture') },
    { name: 'vault-state.enc', bytes: Buffer.from('vault fixture') }
  ];
}

test('refuses a record whose post-preparation hash verification disagrees, without writes or processes', () => {
  const originalCreateHash = crypto.createHash;
  let hashesCreated = 0;
  crypto.createHash = function createHashWithVerificationFault(...args) {
    const hash = originalCreateHash.apply(this, args);
    hashesCreated += 1;
    if (hashesCreated === 4) {
      const originalDigest = hash.digest;
      hash.digest = function disagreeingDigest(encoding) {
        originalDigest.call(this, encoding);
        return encoding === 'hex' ? '0'.repeat(64) : Buffer.alloc(32);
      };
    }
    return hash;
  };
  delete require.cache[writerPath];
  const writer = require(writerPath);
  const store = writer.createTestOnlyStore();
  const snapshotName = 'snapshot-20260827T010203Z';

  const calls = [];
  const patched = [];
  for (const [owner, names] of [
    [fs, ['appendFileSync', 'copyFileSync', 'mkdirSync', 'renameSync', 'rmSync', 'unlinkSync', 'writeFileSync']],
    [childProcess, ['exec', 'execFile', 'fork', 'spawn', 'spawnSync']]
  ]) {
    for (const name of names) {
      const original = owner[name];
      patched.push(() => { owner[name] = original; });
      owner[name] = (...args) => {
        calls.push([name, args.length]);
        throw new Error(`unexpected side effect through ${name}`);
      };
    }
  }

  let refused;
  try {
    refused = writer.writeTestOnlyBackup({ store, snapshotName, artifacts: artifacts() });
  } finally {
    while (patched.length) patched.pop()();
    crypto.createHash = originalCreateHash;
  }

  assert.equal(hashesCreated, 4, 'fault was consumed by verification, not preparation');
  assert.deepEqual(refused, {
    schemaVersion: 1,
    kind: 'test-only-backup-write',
    status: 'not-committed',
    snapshotName,
    code: 'Q37_VERIFICATION_REFUSED',
    manifestSha256: null,
    artifactSha256: [],
    productionActivation: 'disabled',
    artifactsDeleted: 0
  });
  assert.deepEqual(calls, []);
  assert.equal(writer.verifyTestOnlyRestoreContract({ store, snapshotName }).status, 'unavailable');

  const retry = writer.writeTestOnlyBackup({ store, snapshotName, artifacts: artifacts() });
  assert.equal(retry.status, 'committed', 'refusal must not reserve or write the snapshot');
});

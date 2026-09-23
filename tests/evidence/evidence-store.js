'use strict';

// Q51 package-colocation slice. This is intentionally local and deterministic:
// it exercises the package's owned SQLite lifecycle without touching the
// canonical evidence database or writing provider-visible artifacts.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { APPLICATION_ID, EvidenceStore, verifyEvidenceStore } = require('../../src/lib/evidence-store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-evidence-package-test-'));
const dbFile = path.join(root, 'evidence.sqlite3');
const objectRoot = path.join(root, 'objects');

const store = new EvidenceStore({ dbFile, objectRoot });
assert.deepEqual(store.health(), {
  ok: true,
  schemaVersion: 1,
  applicationId: APPLICATION_ID,
  records: 0,
  activeRecords: 0,
  tombstones: 0,
  runtimeRouteEnabled: false
});

assert.throws(
  () => store._transaction(() => store._transaction(() => null)),
  error => error && error.code === 'EVIDENCE_TRANSACTION_NESTED',
  'nested evidence transactions must fail closed'
);
assert.throws(
  () => store._transaction(() => { throw new Error('rollback fixture'); }),
  'transaction callback failures must roll back'
);
assert.equal(store.health().records, 0, 'a rolled-back transaction leaves no records');
assert.equal(store.close(), true, 'owned database closes');
assert.equal(store.close(), false, 'closing an already closed store is idempotent');

const reopened = new EvidenceStore({ dbFile, objectRoot });
assert.equal(reopened.health().ok, true, 'retained DatabaseSync handles reopen safely');
assert.strictEqual(reopened._open(), reopened._open(), 'a successful open remains cached');

const orphanDigest = 'a'.repeat(64);
const orphanDirectory = path.join(objectRoot, 'objects', 'sha256', 'aa', 'aa');
fs.mkdirSync(orphanDirectory, { recursive: true });
fs.writeFileSync(path.join(orphanDirectory, `${orphanDigest}.blob`), 'orphan');
const originalUnlinkSync = fs.unlinkSync;
fs.unlinkSync = filename => {
  if (filename.endsWith('.trash')) {
    const error = new Error('simulated indeterminate trash deletion');
    error.code = 'EIO';
    throw error;
  }
  return originalUnlinkSync(filename);
};
let unconfirmedCollection;
try {
  unconfirmedCollection = reopened._collectDigest(orphanDigest);
} finally {
  fs.unlinkSync = originalUnlinkSync;
}
assert.equal(
  unconfirmedCollection.collected,
  null,
  'collection distinguishes “did not happen” from “could not be established”'
);
assert.equal(unconfirmedCollection.reason, 'delete-unconfirmed');
assert.equal(unconfirmedCollection.errorCode, 'EIO');
assert.equal(reopened.close(), true);

const unreadableOpenState = Object.create(EvidenceStore.prototype);
unreadableOpenState._db = Object.defineProperty({}, 'isOpen', {
  get() { throw new Error('isOpen unavailable'); }
});
assert.throws(
  () => unreadableOpenState.close(),
  /isOpen unavailable/,
  'an unreadable database open state must not be reported as a successful close'
);

const unreadableTransactionState = Object.create(EvidenceStore.prototype);
unreadableTransactionState._db = Object.defineProperties({}, {
  isOpen: { value: true },
  isTransaction: { get() { throw new Error('isTransaction unavailable'); } }
});
unreadableTransactionState._transactionActive = false;
assert.throws(
  () => unreadableTransactionState._transaction(() => null),
  /isTransaction unavailable/,
  'an unreadable transaction state must refuse instead of assuming no transaction'
);

const verified = verifyEvidenceStore({ dbFile, objectRoot });
assert.equal(verified.ok, true, 'read-only verification accepts the package database');
assert.equal(verified.records, 0);

const originalLstatSync = fs.lstatSync;
fs.lstatSync = filename => {
  if (path.resolve(filename) === path.resolve(dbFile)) {
    const error = new Error('simulated busy database lookup');
    error.code = 'EBUSY';
    throw error;
  }
  return originalLstatSync(filename);
};
try {
  assert.throws(
    () => verifyEvidenceStore({ dbFile, objectRoot }),
    error => error && error.code === 'EVIDENCE_DATABASE_UNAVAILABLE' &&
      /does not claim that it is absent/.test(error.message),
    'a busy filesystem lookup must not report the database as absent'
  );
} finally {
  fs.lstatSync = originalLstatSync;
}
assert.equal(verifyEvidenceStore({ dbFile, objectRoot }).ok, true, 'a transient lookup failure is not cached');
assert.throws(
  () => verifyEvidenceStore({ dbFile: path.join(root, 'absent.sqlite3'), objectRoot }),
  error => error && error.code === 'EVIDENCE_DATABASE_MISSING',
  'ENOENT retains the definite missing result'
);

console.log('Evidence package tests passed (schema lifecycle, transaction guard, rollback, close, collection certainty, verification).');

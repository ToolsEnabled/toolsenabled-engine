/* Mutation check (2026-08-27):
 * Replaced `return { ...prior, replayed: true };` with
 * `return { ...revocation, replayed: true };` in src/lib/license-store.js.
 * The edit landed, and this test file went red by rejecting the conflicting replay.
 * The module was restored to its original sha256 after the run.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LICENSE_APPLICATION_ID,
  LICENSE_SCHEMA_VERSION,
  LicenseStore,
  absoluteDatabasePath
} = require('../src/lib/license-store');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'license-store-test-'));
const databaseFile = path.join(directory, 'licenses.sqlite3');
const licenseId = 'lic_behaviour_1234';
const revocation = {
  licenseId,
  revokedAtMs: 1_725_000_000_123,
  reason: 'payment reversed',
  keyId: `license-ed25519-${'a'.repeat(64)}`,
  signature: 'Abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789_abcdefghijklmnop'
};

let store;
try {
  assert.equal(absoluteDatabasePath({ TOOLSENABLED_LICENSE_DB_PATH: `  ${databaseFile}  ` }), databaseFile);
  assert.throws(
    () => absoluteDatabasePath({ TOOLSENABLED_LICENSE_DB_PATH: 'relative.sqlite3' }),
    /must be an absolute path/
  );

  store = new LicenseStore({ file: databaseFile });
  assert.equal(store.get(licenseId), null);
  assert.deepEqual(store.revoke(revocation), { ...revocation, replayed: false });

  const conflictingReplay = { ...revocation, reason: 'a later conflicting reason' };
  assert.deepEqual(
    store.revoke(conflictingReplay),
    { ...revocation, replayed: true },
    'replaying a license ID must preserve the first durable revocation rather than overwrite it'
  );

  assert.deepEqual(store.get(licenseId), revocation);
  assert.deepEqual(store.status(), {
    ok: true,
    path: databaseFile,
    schemaVersion: LICENSE_SCHEMA_VERSION,
    applicationId: LICENSE_APPLICATION_ID,
    revocations: 1,
    integrity: ['ok']
  });
  assert.equal(store.close(), true);
  assert.equal(store.close(), false);

  store = new LicenseStore({ file: databaseFile });
  assert.deepEqual(store.get(licenseId), revocation, 'a fresh store must read the committed revocation');
  assert.throws(() => store.get('not-a-license'), /licenseId is invalid/);
  assert.throws(() => store.revoke({ ...revocation, signature: 'short' }), /signature is invalid/);
  console.log('license-store behaviour: PASS');
} finally {
  if (store) store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

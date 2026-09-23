'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAdministrativeEnrollment, safeFailure, hash } = require('../src/lib/online-fra-admin-enrollment');
const { fixture } = require('./lib/admin-enrollment-fixture');
function setup() {
  // This protocol-only fixture never writes state. Hash the same absolute
  // path spelling the product validates on both Windows and Linux.
  const stateRoot = path.join(__dirname, 'fixtures', 'disposable-admin'); const f = fixture(stateRoot);
  let record = null, grant = null, identity = f.identity, writes = 0;
  // Protocol unit seam only. Actual Linux custody/locking is exercised separately.
  const vault = { getIdentity: () => identity, operation(request) {
    const error = code => { throw Object.assign(new Error(code), { code, mutationOutcome: 'NOT_ATTEMPTED' }); };
    if (record && JSON.parse(record).state !== 'prepared' && hash(grant || '') !== JSON.parse(record).credentialHash) error('ADMIN_CREDENTIAL_CHANGED');
    if (request.transition === 'inspect') return { record, mutationOutcome: 'NOT_ATTEMPTED' };
    if (request.expectedHash !== (record === null ? null : hash(record))) error('ADMIN_OPERATION_CONFLICT');
    if (request.transition === 'store') { if (grant !== null) error('ADMIN_CREDENTIAL_CONFLICT'); grant = request.credential; }
    if (request.transition === 'cancel' && grant !== null) error('ADMIN_CREDENTIAL_CONFLICT');
    record = request.record; writes++; return { record, mutationOutcome: 'STORED_SYNCED' };
  } };
  const make = () => createAdministrativeEnrollment({ context: f.context, stateRoot, vault, now: () => f.now });
  return { f, make, get writes() { return writes; }, record: () => record, grant: () => grant,
    setIdentity: v => { identity = v; }, replaceGrant: v => { grant = v; } };
}
test('separate signed prepare/import/finalize, exact retry and restart require fresh collection proof', () => {
  const t = setup(), admin = t.make(); const prepared = admin.prepare();
  assert.deepEqual(t.make().prepare(), prepared); assert.equal(t.writes, 1);
  const envelope = t.f.enroll(prepared.signedRequest), imported = admin.importGrant(envelope);
  assert.equal(imported.receipt.serverCollected, false); assert.equal(imported.receipt.durable, true);
  assert.equal(t.record().includes('PRIVATE KEY'), false, 'transport private key removed atomically at store');
  assert.equal(JSON.stringify(imported).includes(t.f.credential.deviceToken), false);
  assert.equal(t.make().importGrant(envelope).stage, 'stored'); assert.equal(t.writes, 2);
  assert.equal(t.make().importGrant(Object.fromEntries(Object.entries(envelope).reverse())).stage, 'stored');
  const final = t.make().finalize(t.f.collect(imported.signedRequest));
  assert.equal(final.stage, 'finalized'); assert.equal(final.receipt.serverCollected, true);
  assert.equal(t.make().resume().receipt.serverCollected, false, 'restart cannot reuse old collected authority');
  assert.throws(() => admin.pairRequest({ webDriveEnabled: false, capabilityDigest: 'a'.repeat(64) }), { code: 'ADMIN_CONSENT_REQUIRED' });
  assert.equal(admin.pairRequest({ webDriveEnabled: true, capabilityDigest: 'a'.repeat(64) }).stage, 'pair-request');
});
test('otherwise valid envelope signed by another issuer is refused before mutation', () => {
  const t = setup(), admin = t.make(), reply = t.f.enroll(admin.prepare().signedRequest);
  reply.signature = crypto.randomBytes(64).toString('base64url');
  assert.throws(() => admin.importGrant(reply), { code: 'ADMIN_REPLY_INVALID' }); assert.equal(t.writes, 1);
});
for (const field of ['accountId', 'publicKey', 'profile', 'operationId', 'enrollmentRequestHash', 'expiresAtMs', 'ciphertext']) {
  test(`tampered issuer envelope ${field} cannot mutate the vault`, () => {
    const t = setup(), admin = t.make(), reply = t.f.enroll(admin.prepare().signedRequest);
    reply[field] = typeof reply[field] === 'number' ? reply[field] + 1 : reply[field] + 'x';
    assert.throws(() => admin.importGrant(reply), { code: 'ADMIN_REPLY_INVALID' }); assert.equal(t.writes, 1);
  });
}
for (const [name, change, code] of [
  ['expired', x => ({ ...x, issuedAtMs: x.issuedAtMs - 700000, expiresAtMs: x.issuedAtMs - 100000 }), 'ADMIN_REPLY_EXPIRED'],
  ['excessive expiry', x => ({ ...x, expiresAtMs: x.issuedAtMs + 600001 }), 'ADMIN_REPLY_EXPIRED'],
  ['wrong account', x => ({ ...x, accountId: 'different' }), 'ADMIN_REPLY_INVALID'],
  ['extra field', x => ({ ...x, extra: true }), 'ADMIN_REPLY_INVALID']
]) test(`even correctly signed ${name} reply is refused`, () => {
  const t = setup(), admin = t.make(), original = t.f.enroll(admin.prepare().signedRequest); delete original.signature;
  assert.throws(() => admin.importGrant(t.f.sign(change(original))), { code }); assert.equal(t.writes, 1);
});
for (const field of ['deviceToken', 'privateKeyPem', 'certificatePem', 'claimedAtMs']) test(`invalid encrypted grant ${field} is refused before writing`, () => {
  const t = setup(), admin = t.make(), reply = t.f.enroll(admin.prepare().signedRequest, value => ({ ...value,
    credential: { ...value.credential, [field]: field === 'claimedAtMs' ? -1 : 'invalid' } }));
  assert.throws(() => admin.importGrant(reply), { code: 'ADMIN_REPLY_INVALID' }); assert.equal(t.writes, 1);
});
test('different current identity never signs or imports', () => {
  const t = setup(), admin = t.make(), reply = t.f.enroll(admin.prepare().signedRequest);
  t.setIdentity(crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.throws(() => admin.importGrant(reply), { code: 'ADMIN_IDENTITY_MISMATCH' }); assert.equal(t.writes, 1);
});
for (const changed of [{ live: false }, { credentialHash: 'a'.repeat(64) }, { deviceId: 'device-' + 'b'.repeat(24) }]) {
  test(`current collection attestation must match stored live credential: ${Object.keys(changed)[0]}`, () => {
    const t = setup(), admin = t.make(), imported = admin.importGrant(t.f.enroll(admin.prepare().signedRequest));
    assert.throws(() => admin.finalize(t.f.collect(imported.signedRequest, changed)), { code: 'ADMIN_REPLY_INVALID' }); assert.equal(t.writes, 2);
  });
}
test('removed/replaced grant after storage cannot be resurrected by replay or resume', () => {
  const t = setup(), admin = t.make(), reply = t.f.enroll(admin.prepare().signedRequest); admin.importGrant(reply); t.replaceGrant(null);
  assert.throws(() => t.make().importGrant(reply), { code: 'ADMIN_CREDENTIAL_CHANGED' });
  assert.throws(() => t.make().resume(), { code: 'ADMIN_CREDENTIAL_CHANGED' }); assert.equal(t.writes, 2);
});
test('pairing after delay/restart uses historical collection proof and freshly signed request', () => {
  const t = setup(), admin = t.make(), imported = admin.importGrant(t.f.enroll(admin.prepare().signedRequest));
  const proof = t.f.collect(imported.signedRequest); admin.finalize(proof);
  t.f.now += 600000;
  assert.throws(() => t.make().finalize(proof), { code: 'ADMIN_REPLY_EXPIRED' }, 'fresh finalization remains strict');
  const pair = t.make().pairRequest({ webDriveEnabled: true, capabilityDigest: 'a'.repeat(64) });
  assert.equal(pair.stage, 'pair-request');
  assert.equal(JSON.parse(Buffer.from(pair.signedRequest.request, 'base64url')).issuedAtMs, t.f.now);
});
test('failure output never includes exception messages or arbitrary properties', () => {
  assert.deepEqual(safeFailure({ message: 'private-value', code: 'PRIVATE_VALUE', token: 'private-value' }),
    { ok: false, code: 'ADMIN_VAULT_FAILED', mutationOutcome: 'NOT_ATTEMPTED' });
  assert.equal(safeFailure({ code: 'SECRET_VAULT_WRITE_UNCERTAIN', mutationOutcome: 'UNCERTAIN' }).mutationOutcome, 'UNCERTAIN');
});
test('CLI rejects oversized, malformed and duplicate-key input before any vault access', () => {
  if (process.platform !== 'linux') return;
  for (const input of ['x'.repeat(65537), '{', '{"version":1,"version":1,"action":"identity","context":{}}']) {
    const child = spawnSync(process.execPath, [path.join(__dirname, '../tools/online-fra-admin-cli.js')], {
      input, env: {}, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
    });
    assert.equal(child.status, 1); assert.equal(child.stderr, '');
    assert.deepEqual(JSON.parse(child.stdout), { ok: false, code: 'ADMIN_INPUT_INVALID', mutationOutcome: 'NOT_ATTEMPTED' });
  }
});

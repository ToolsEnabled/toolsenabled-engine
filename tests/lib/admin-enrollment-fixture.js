'use strict';
// Test-only issuer; no production key, endpoint or credential is used.
const crypto = require('node:crypto');
const { hash, REQUEST_DOMAIN, REPLY_DOMAIN } = require('../../src/lib/online-fra-admin-enrollment');
const wire = key => key.export({ format: 'der', type: 'spki' }).toString('base64url');
function fixture(stateRoot, now = Date.now()) {
  const device = crypto.generateKeyPairSync('ed25519'), issuer = crypto.generateKeyPairSync('ed25519');
  const context = { operationId: crypto.randomBytes(24).toString('hex'), accountId: 'test-account', email: 'owner@example.test',
    name: 'Disposable ROG', publicKey: wire(device.publicKey), profile: hash(stateRoot), issuerPublicKey: wire(issuer.publicKey) };
  const credential = { pairId: 'pair-' + crypto.randomBytes(16).toString('hex'), deviceId: 'device-' + crypto.randomBytes(12).toString('hex'),
    name: context.name, certificatePem: null, privateKeyPem: null, deviceToken: 'dt_' + crypto.randomBytes(32).toString('base64url'), claimedAtMs: now };
  function sign(value) { return { ...value, signature: crypto.sign(null, Buffer.concat([Buffer.from(REPLY_DOMAIN), Buffer.from(JSON.stringify(value))]), issuer.privateKey).toString('base64url') }; }
  function enroll(signed, alter = value => value) {
    const bytes = Buffer.from(signed.request, 'base64url');
    if (!crypto.verify(null, Buffer.concat([Buffer.from(REQUEST_DOMAIN), bytes]), device.publicKey, Buffer.from(signed.signature, 'base64url'))) throw Error('Fixture received unsigned request');
    const request = JSON.parse(bytes), aes = crypto.randomBytes(32), iv = crypto.randomBytes(12), enrollmentRequestHash = hash(bytes);
    const cipher = crypto.createCipheriv('aes-256-gcm', aes, iv); cipher.setAAD(Buffer.from(enrollmentRequestHash));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(alter({ accountId: context.accountId, publicKey: context.publicKey, credential }))), cipher.final()]);
    return sign({ version: 1, operation: 'enroll', operationId: context.operationId, accountId: context.accountId, publicKey: context.publicKey,
      profile: context.profile, enrollmentRequestHash, issuedAtMs: now, expiresAtMs: now + 600000,
      wrappedKey: crypto.publicEncrypt({ key: request.transportPublicKey, oaepHash: 'sha256' }, aes).toString('base64url'),
      iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') });
  }
  function collect(signed, changes = {}) {
    const request = JSON.parse(Buffer.from(signed.request, 'base64url'));
    return sign({ version: 1, operation: 'collect', operationId: context.operationId, accountId: context.accountId, publicKey: context.publicKey,
      profile: context.profile, enrollmentRequestHash: request.enrollmentRequestHash, pairId: credential.pairId, deviceId: credential.deviceId,
      credentialHash: hash(JSON.stringify(credential)), credentialVersion: 2, live: true, issuedAtMs: now, expiresAtMs: now + 120000, ...changes });
  }
  return { context, credential, device, issuer, now, enroll, collect, sign, identity: device.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
module.exports = { fixture };

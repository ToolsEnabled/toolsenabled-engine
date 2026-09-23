'use strict';

// Explicit owner-administration protocol. This never simulates a browser claim,
// creates an identity, authenticates a password, or changes the shell's fence.
const crypto = require('node:crypto');
const path = require('node:path');
const REQUEST_DOMAIN = 'ToolsEnabled owner administrative enrollment v1\n';
const REPLY_DOMAIN = 'ToolsEnabled owner administrative reply v1\n';
const IDENTITY_KEY = 'custom.online_fra_device_identity_v1';
const CONTEXT = ['operationId', 'accountId', 'email', 'name', 'publicKey', 'profile', 'issuerPublicKey'];
const COMMON = ['version', 'operation', 'operationId', 'accountId', 'publicKey', 'profile', 'enrollmentRequestHash'];
const REPLIES = Object.freeze({
  enroll: [...COMMON, 'issuedAtMs', 'expiresAtMs', 'wrappedKey', 'iv', 'tag', 'ciphertext'],
  collect: [...COMMON, 'pairId', 'deviceId', 'credentialHash', 'credentialVersion', 'live', 'issuedAtMs', 'expiresAtMs'],
  pair: [...COMMON, 'pairId', 'deviceId', 'credentialHash', 'credentialVersion', 'live', 'relayPairId', 'capabilityDigest', 'generation', 'solo', 'controlRegistered', 'issuedAtMs', 'expiresAtMs']
});
const CREDENTIAL = ['pairId', 'deviceId', 'name', 'certificatePem', 'privateKeyPem', 'deviceToken', 'claimedAtMs'];
const ERROR_CODES = new Set(['ADMIN_INPUT_INVALID', 'ADMIN_IDENTITY_ABSENT', 'ADMIN_IDENTITY_MISMATCH',
  'ADMIN_CONTEXT_MISMATCH', 'ADMIN_OPERATION_CONFLICT', 'ADMIN_OPERATION_ABSENT', 'ADMIN_REPLY_INVALID',
  'ADMIN_REPLY_EXPIRED', 'ADMIN_CREDENTIAL_CONFLICT', 'ADMIN_CREDENTIAL_CHANGED', 'ADMIN_CONSENT_REQUIRED',
  'ADMIN_NOT_COLLECTED', 'ADMIN_PLATFORM_UNSUPPORTED', 'ADMIN_VAULT_FAILED']);
function fail(code) { throw Object.assign(new Error(code), { code, mutationOutcome: 'NOT_ATTEMPTED' }); }
function exact(value, keys, code = 'ADMIN_INPUT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(code);
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function envelopeHash(reply) {
  exact(reply, [...REPLIES.enroll, 'signature'], 'ADMIN_REPLY_INVALID');
  return hash(JSON.stringify(Object.fromEntries([...REPLIES.enroll, 'signature'].map(key => [key, reply[key]]))));
}
function wire(bytes) { return Buffer.from(bytes).toString('base64url'); }
function unbase(value, size, code = 'ADMIN_REPLY_INVALID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 64 * 1024) fail(code);
  const bytes = Buffer.from(value, 'base64url');
  if (wire(bytes) !== value || (size !== undefined && bytes.length !== size)) fail(code);
  return bytes;
}
function canonical(raw, code = 'ADMIN_INPUT_INVALID') {
  let value;
  try { value = JSON.parse(raw); } catch { fail(code); }
  if (JSON.stringify(value) !== raw) fail(code);
  return value;
}
function publicKey(value) {
  try {
    const key = crypto.createPublicKey({ key: unbase(value, 44), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || wire(key.export({ format: 'der', type: 'spki' })) !== value) fail('ADMIN_INPUT_INVALID');
    return key;
  } catch { fail('ADMIN_INPUT_INVALID'); }
}
function validatedContext(value, stateRoot) {
  exact(value, CONTEXT);
  if (!/^[a-f0-9]{48}$/.test(value.operationId) || !/^[a-f0-9]{64}$/.test(value.profile)
      || typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)
      || value.profile !== hash(path.resolve(stateRoot))) fail('ADMIN_CONTEXT_MISMATCH');
  for (const field of ['accountId', 'email', 'name']) {
    if (typeof value[field] !== 'string' || !value[field] || value[field].length > 254
        || value[field] !== value[field].trim() || /[\x00-\x1f\x7f]/.test(value[field])) fail('ADMIN_INPUT_INVALID');
  }
  publicKey(value.publicKey); publicKey(value.issuerPublicKey);
  return Object.freeze(Object.fromEntries(CONTEXT.map(key => [key, value[key]])));
}
function validateCredential(value, context, now) {
  exact(value, CREDENTIAL, 'ADMIN_REPLY_INVALID');
  if (!/^pair-[a-f0-9]{32}$/.test(value.pairId) || !/^device-[a-f0-9]{24}$/.test(value.deviceId)
      || value.name !== context.name || value.certificatePem !== null || value.privateKeyPem !== null
      || typeof value.deviceToken !== 'string' || !/^dt_[A-Za-z0-9_-]{40,256}$/.test(value.deviceToken)
      || !Number.isSafeInteger(value.claimedAtMs) || value.claimedAtMs <= 0
      || value.claimedAtMs > now + 30000) fail('ADMIN_REPLY_INVALID');
  return Object.fromEntries(CREDENTIAL.map(key => [key, value[key]]));
}

function createAdministrativeEnrollment({ context: supplied, stateRoot, vault, now = Date.now } = {}) {
  const context = validatedContext(supplied, stateRoot);
  if (typeof vault?.getIdentity !== 'function' || typeof vault?.operation !== 'function') fail('ADMIN_INPUT_INVALID');
  function identity() {
    let key;
    try { key = crypto.createPrivateKey(vault.getIdentity(IDENTITY_KEY)); }
    catch (error) { if (error?.code === 'SECRET_NOT_CONFIGURED') fail('ADMIN_IDENTITY_ABSENT'); throw error; }
    if (key.asymmetricKeyType !== 'ed25519'
        || wire(crypto.createPublicKey(key).export({ format: 'der', type: 'spki' })) !== context.publicKey) fail('ADMIN_IDENTITY_MISMATCH');
    return key;
  }
  function signed(operation, fields) {
    const request = { version: 1, operation, operationId: context.operationId, accountId: context.accountId,
      email: context.email, name: context.name, publicKey: context.publicKey, profile: context.profile,
      issuedAtMs: now(), ...fields };
    const bytes = Buffer.from(JSON.stringify(request));
    return { request: wire(bytes), signature: wire(crypto.sign(null, Buffer.concat([Buffer.from(REQUEST_DOMAIN), bytes]), identity())) };
  }
  function transaction(transition, before = null, record = null, credential = null) {
    return vault.operation({ operationId: context.operationId, publicKey: context.publicKey, transition,
      expectedHash: before === null ? null : hash(before), record: record === null ? null : JSON.stringify(record),
      credential: credential === null ? null : JSON.stringify(credential) });
  }
  function inspect(forCancellation = false) {
    identity();
    const answer = transaction(forCancellation ? 'inspect-cancel' : 'inspect');
    if (answer.record === null) return { raw: null, record: null };
    const record = canonical(answer.record, 'ADMIN_OPERATION_CONFLICT');
    if (record.version !== 1 || record.operationId !== context.operationId
        || JSON.stringify(record.context) !== JSON.stringify(context)
        || !['prepared', 'stored', 'finalized'].includes(record.state)) fail('ADMIN_OPERATION_CONFLICT');
    exact(record.enrollmentRequest, ['request', 'signature'], 'ADMIN_OPERATION_CONFLICT');
    const bytes = unbase(record.enrollmentRequest.request, undefined, 'ADMIN_OPERATION_CONFLICT');
    if (!crypto.verify(null, Buffer.concat([Buffer.from(REQUEST_DOMAIN), bytes]), publicKey(context.publicKey),
      unbase(record.enrollmentRequest.signature, 64))) fail('ADMIN_OPERATION_CONFLICT');
    return { raw: answer.record, record };
  }
  function requestHash(record) { return hash(unbase(record.enrollmentRequest.request)); }
  function verifyReply(reply, operation, record, verificationTime = now()) {
    const fields = REPLIES[operation];
    exact(reply, [...fields, 'signature'], 'ADMIN_REPLY_INVALID');
    const unsigned = Object.fromEntries(fields.map(field => [field, reply[field]]));
    if (!crypto.verify(null, Buffer.concat([Buffer.from(REPLY_DOMAIN), Buffer.from(JSON.stringify(unsigned))]),
      publicKey(context.issuerPublicKey), unbase(reply.signature, 64))) fail('ADMIN_REPLY_INVALID');
    if (reply.version !== 1 || reply.operation !== operation || reply.operationId !== context.operationId
        || reply.accountId !== context.accountId || reply.publicKey !== context.publicKey
        || reply.profile !== context.profile || reply.enrollmentRequestHash !== requestHash(record)) fail('ADMIN_REPLY_INVALID');
    const at = verificationTime, maximum = operation === 'enroll' ? 600000 : 120000;
    if (!Number.isSafeInteger(at) || at <= 0 || !Number.isSafeInteger(reply.issuedAtMs) || !Number.isSafeInteger(reply.expiresAtMs)
        || reply.issuedAtMs > at + 30000 || reply.expiresAtMs <= at
        || reply.expiresAtMs <= reply.issuedAtMs || reply.expiresAtMs - reply.issuedAtMs > maximum) fail('ADMIN_REPLY_EXPIRED');
    if (operation !== 'enroll' && (reply.pairId !== record.pairId || reply.deviceId !== record.deviceId
        || reply.credentialHash !== record.credentialHash || reply.live !== true
        || !Number.isSafeInteger(reply.credentialVersion) || reply.credentialVersion < 0)) fail('ADMIN_REPLY_INVALID');
    return unsigned;
  }
  function receipt(record, collected = false, mutationOutcome = 'NOT_ATTEMPTED') {
    return { version: 1, kind: 'owner-administration', operationId: context.operationId,
      accountId: context.accountId, publicKey: context.publicKey, profile: context.profile,
      enrollmentRequestHash: requestHash(record), credentialHash: record.credentialHash, pairId: record.pairId, deviceId: record.deviceId,
      name: context.name, claimedAtMs: record.claimedAtMs, credentialStored: true,
      readBackVerified: true, durable: true, serverCollected: collected, mutationOutcome };
  }
  function storedAnswer(record, mutationOutcome = 'NOT_ATTEMPTED') {
    return { ok: true, stage: 'stored', signedRequest: signed('collect', { pairId: record.pairId,
      deviceId: record.deviceId, enrollmentRequestHash: requestHash(record), credentialHash: record.credentialHash,
      credentialStored: true, readBackVerified: true }),
    receipt: receipt(record, false, mutationOutcome) };
  }
  return Object.freeze({
    prepare() {
      const before = inspect();
      if (before.record) {
        if (before.record.state !== 'prepared') return storedAnswer(before.record);
        return { ok: true, stage: 'prepared', signedRequest: before.record.enrollmentRequest };
      }
      const transport = crypto.generateKeyPairSync('rsa', { modulusLength: 3072,
        publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      const record = { version: 1, state: 'prepared', operationId: context.operationId, context,
        enrollmentRequest: signed('enroll', { transportPublicKey: transport.publicKey }), transportPrivateKeyPem: transport.privateKey };
      transaction('prepare', null, record);
      return { ok: true, stage: 'prepared', signedRequest: record.enrollmentRequest };
    },
    importGrant(reply) {
      const before = inspect(), record = before.record;
      if (!record) fail('ADMIN_OPERATION_ABSENT');
      if (record.state !== 'prepared') {
        if (envelopeHash(reply) !== record.envelopeHash) fail('ADMIN_OPERATION_CONFLICT');
        return storedAnswer(record);
      }
      verifyReply(reply, 'enroll', record);
      let aes, plaintext;
      try {
        aes = crypto.privateDecrypt({ key: record.transportPrivateKeyPem, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, unbase(reply.wrappedKey, 384));
        if (aes.length !== 32) fail('ADMIN_REPLY_INVALID');
        const decipher = crypto.createDecipheriv('aes-256-gcm', aes, unbase(reply.iv, 12));
        decipher.setAAD(Buffer.from(reply.enrollmentRequestHash)); decipher.setAuthTag(unbase(reply.tag, 16));
        plaintext = Buffer.concat([decipher.update(unbase(reply.ciphertext)), decipher.final()]);
        const value = canonical(plaintext.toString(), 'ADMIN_REPLY_INVALID');
        exact(value, ['accountId', 'publicKey', 'credential'], 'ADMIN_REPLY_INVALID');
        if (value.accountId !== context.accountId || value.publicKey !== context.publicKey) fail('ADMIN_REPLY_INVALID');
        const credential = validateCredential(value.credential, context, now());
        const saved = { version: 1, state: 'stored', operationId: context.operationId, context,
          enrollmentRequest: record.enrollmentRequest, envelopeHash: envelopeHash(reply),
          credentialHash: hash(JSON.stringify(credential)), pairId: credential.pairId, deviceId: credential.deviceId,
          claimedAtMs: credential.claimedAtMs, storedAtMs: now() };
        // Obtain the identity proof before committing; a later signer/backend
        // refusal must not misreport an already-stored grant as not attempted.
        const answer = storedAnswer(saved, 'STORED_SYNCED');
        transaction('store', before.raw, saved, credential);
        return answer;
      } catch (error) {
        if (error?.code?.startsWith('ADMIN_') || error?.code?.startsWith('SECRET_')) throw error;
        fail('ADMIN_REPLY_INVALID');
      } finally { aes?.fill(0); plaintext?.fill(0); }
    },
    finalize(reply) {
      const before = inspect(), record = before.record;
      if (!record || record.state === 'prepared') fail('ADMIN_OPERATION_ABSENT');
      verifyReply(reply, 'collect', record);
      const saved = { ...record, state: 'finalized', collectionReply: reply, finalizedAtMs: now() };
      const result = transaction('finalize', before.raw, saved);
      return { ok: true, stage: 'finalized', receipt: receipt(saved, true, result.mutationOutcome) };
    },
    resume() {
      const { record } = inspect();
      if (!record) fail('ADMIN_OPERATION_ABSENT');
      // A prior collection attestation is never restart authority. Obtain a
      // new server collection attestation before the main process can unblock.
      return record.state === 'prepared' ? { ok: true, stage: 'prepared', signedRequest: record.enrollmentRequest } : storedAnswer(record);
    },
    pairRequest({ webDriveEnabled, capabilityDigest } = {}) {
      if (webDriveEnabled !== true) fail('ADMIN_CONSENT_REQUIRED');
      if (typeof capabilityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(capabilityDigest)) fail('ADMIN_INPUT_INVALID');
      const { record } = inspect();
      if (record?.state !== 'finalized') fail('ADMIN_NOT_COLLECTED');
      // Historical collection proves how this exact stored credential arrived.
      // It does not authorize a current relay pair: the freshly signed request
      // goes to the server's current token/key/account/consent checks.
      verifyReply(record.collectionReply, 'collect', record, record.finalizedAtMs);
      return { ok: true, stage: 'pair-request', signedRequest: signed('pair', { pairId: record.pairId,
        deviceId: record.deviceId, enrollmentRequestHash: requestHash(record), credentialHash: record.credentialHash,
        webDriveEnabled: true, capabilityDigest }),
      receipt: receipt(record, true) };
    },
    cancel() {
      // The fixed vault transition refuses any present device grant. Retiring
      // the exact operation after ordinary disconnect cannot revive its grant.
      const before = inspect(true);
      transaction('cancel', before.raw);
      return { ok: true, stage: 'cancelled' };
    }
  });
}
function safeFailure(error) {
  const code = ERROR_CODES.has(error?.code) || /^SECRET_[A-Z_]+$/.test(error?.code || '') ? error.code : 'ADMIN_VAULT_FAILED';
  return { ok: false, code, mutationOutcome: error?.mutationOutcome === 'UNCERTAIN' ? 'UNCERTAIN' : 'NOT_ATTEMPTED' };
}
module.exports = { createAdministrativeEnrollment, validatedContext, validateCredential, safeFailure,
  REQUEST_DOMAIN, REPLY_DOMAIN, REPLIES, IDENTITY_KEY, hash };

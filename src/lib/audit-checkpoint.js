'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, sha256, ZERO_HASH } = require('./audit-store');
const { rootPath } = require('./runtime');

const CHECKPOINT_DOMAIN = 'toolsenabled.audit.checkpoint.v1';
const CHECKPOINT_VERSION = 1;

function checkpointError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function publicKeyDetails(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw checkpointError('AUDIT_CHECKPOINT_KEY_INVALID', 'Checkpoint keys must be Ed25519 keys.');
  }
  return { key, hash: sha256(key.export({ type: 'spki', format: 'der' })) };
}

function signedBytes(body) {
  return Buffer.from(`${CHECKPOINT_DOMAIN}\n${canonicalJson(body)}`, 'utf8');
}

function atomicWrite(file, contents, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    io.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    io.renameSync(temporary, file);
  } finally {
    try { io.unlinkSync(temporary); } catch { /* rename or cleanup already completed */ }
  }
}

function createCheckpoint({ store, signer, now = Date.now(), checkpointId = crypto.randomUUID() } = {}) {
  if (!store || typeof store.verify !== 'function' || typeof store.status !== 'function') {
    throw checkpointError('AUDIT_CHECKPOINT_STORE_INVALID', 'A verifiable audit store is required.');
  }
  if (!signer || typeof signer.sign !== 'function' || typeof signer.publicKeyPem !== 'string') {
    throw checkpointError('AUDIT_CHECKPOINT_SIGNER_INVALID', 'An audit signer is required.');
  }
  const verification = store.verify();
  if (!verification || verification.valid !== true) {
    throw checkpointError('AUDIT_CHECKPOINT_CHAIN_INVALID', 'Refusing to checkpoint an invalid audit chain.', { verification });
  }
  const inspected = publicKeyDetails(signer.publicKeyPem);
  const body = {
    version: CHECKPOINT_VERSION,
    domain: CHECKPOINT_DOMAIN,
    checkpointId,
    createdAtMs: now,
    headSequence: verification.headSequence,
    headHash: verification.headHash,
    headKeyId: verification.headKeyId,
    signingKeyHash: inspected.hash
  };
  return {
    body,
    publicKeyPem: signer.publicKeyPem,
    signature: Buffer.from(signer.sign(signedBytes(body))).toString('base64')
  };
}

function verifyCheckpoint(checkpoint, { trustedKeyHash } = {}) {
  try {
    if (!checkpoint || typeof checkpoint !== 'object' || !checkpoint.body
        || typeof checkpoint.publicKeyPem !== 'string' || typeof checkpoint.signature !== 'string') {
      return { valid: false, reason: 'checkpoint-shape' };
    }
    const body = checkpoint.body;
    if (body.version !== CHECKPOINT_VERSION || body.domain !== CHECKPOINT_DOMAIN
        || !Number.isSafeInteger(body.createdAtMs) || body.createdAtMs < 0
        || !Number.isSafeInteger(body.headSequence) || body.headSequence < 0
        || typeof body.checkpointId !== 'string' || body.checkpointId.length < 8
        || !/^[a-f0-9]{64}$/.test(body.headHash || '')
        || typeof body.signingKeyHash !== 'string') {
      return { valid: false, reason: 'checkpoint-body' };
    }
    if (typeof trustedKeyHash !== 'string' || !/^[a-f0-9]{64}$/.test(trustedKeyHash)) {
      return { valid: false, reason: 'trusted-key-required' };
    }
    const inspected = publicKeyDetails(checkpoint.publicKeyPem);
    if (inspected.hash !== body.signingKeyHash || inspected.hash !== trustedKeyHash) {
      return { valid: false, reason: 'untrusted-key' };
    }
    const valid = crypto.verify(null, signedBytes(body), inspected.key, Buffer.from(checkpoint.signature, 'base64'));
    return valid ? { valid: true, checkpoint: body } : { valid: false, reason: 'signature' };
  } catch {
    return { valid: false, reason: 'verification-error' };
  }
}

function verifyLedgerAgainstCheckpoint(store, checkpoint, trust) {
  const attestation = verifyCheckpoint(checkpoint, trust);
  if (!attestation.valid) return attestation;
  try {
    const chain = store.verify();
    if (!chain || chain.valid !== true) return { valid: false, reason: 'ledger-invalid', chain };
    const body = attestation.checkpoint;
    const status = store.status();
    if (!status || !Number.isSafeInteger(status.headSequence) || status.headSequence < 0) {
      return { valid: false, reason: 'ledger-status-unavailable' };
    }
    if (status.headSequence < body.headSequence) {
      return { valid: false, rollbackDetected: true, reason: 'ledger-behind-checkpoint' };
    }
    const anchored = body.headSequence === 0
      ? { eventHash: ZERO_HASH }
      : store.getEvent({ sequence: body.headSequence });
    if (!anchored || anchored.eventHash !== body.headHash) {
      return { valid: false, rollbackDetected: true, reason: 'checkpoint-head-not-in-ledger' };
    }
    return { valid: true, rollbackDetected: false, checkpoint: body, headSequence: status.headSequence };
  } catch {
    return { valid: false, reason: 'ledger-unavailable' };
  }
}

function defaultOutbox(resolvePath = rootPath) {
  return resolvePath('state/audit-checkpoints');
}

async function emitCheckpoint(options = {}) {
  const checkpoint = createCheckpoint(options);
  const outbox = options.outboxDir || defaultOutbox(options.resolvePath);
  const file = path.join(outbox, `${checkpoint.body.createdAtMs}-${checkpoint.body.checkpointId}.checkpoint.json`);
  atomicWrite(file, `${canonicalJson(checkpoint)}\n`, options.fs || fs);
  let delivered = false;
  let deliveryError = null;
  if (typeof options.destination === 'function') {
    try {
      await options.destination({ checkpoint, bytes: Buffer.from(canonicalJson(checkpoint), 'utf8') });
      delivered = true;
    } catch (error) {
      deliveryError = error && error.message ? String(error.message).slice(0, 500) : 'Checkpoint destination unavailable.';
    }
  }
  return { ok: true, checkpoint, file, delivered, pendingDelivery: !delivered, deliveryError };
}

function startPeriodicCheckpoints(options = {}) {
  const intervalMs = options.intervalMs === undefined ? 15 * 60 * 1000 : options.intervalMs;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
    throw checkpointError('AUDIT_CHECKPOINT_INTERVAL_INVALID', 'Checkpoint interval must be at least one second.');
  }
  let stopped = false;
  const run = () => emitCheckpoint(options).catch(error => {
    if (typeof options.reportError === 'function') options.reportError(error);
    return { ok: false, error };
  });
  const timer = setInterval(() => { if (!stopped) void run(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { run, stop() { stopped = true; clearInterval(timer); } };
}

module.exports = {
  CHECKPOINT_DOMAIN, CHECKPOINT_VERSION, createCheckpoint, emitCheckpoint,
  startPeriodicCheckpoints, verifyCheckpoint, verifyLedgerAgainstCheckpoint
};

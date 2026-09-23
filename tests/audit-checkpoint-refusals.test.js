'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createCheckpoint, emitCheckpoint, startPeriodicCheckpoints
} = require('../src/lib/audit-checkpoint');

function signer() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: bytes => crypto.sign(null, bytes, pair.privateKey)
  };
}

async function main() {
  /* Drive every refusal through the exported API and spy on each downstream
     side-effect boundary. A source-text assertion could pass without entering
     any of these branches, which is exactly what this suite must prevent. */
  let writes = 0;
  let deliveries = 0;
  let signatures = 0;
  const refusingIo = {
    mkdirSync() { writes += 1; },
    writeFileSync() { writes += 1; },
    renameSync() { writes += 1; },
    unlinkSync() { writes += 1; }
  };
  const destination = async () => { deliveries += 1; };
  const validStore = {
    verify: () => ({
      valid: true, headSequence: 0, headHash: '0'.repeat(64), headKeyId: null
    }),
    status: () => ({ headSequence: 0 })
  };
  const validSigner = signer();

  await assert.rejects(emitCheckpoint({
    store: null, signer: validSigner, fs: refusingIo, destination
  }), error => error && error.code === 'AUDIT_CHECKPOINT_STORE_INVALID',
  'a missing store must produce the store refusal');
  assert.equal(writes, 0, 'invalid store refusal must precede outbox writes');
  assert.equal(deliveries, 0, 'invalid store refusal must precede delivery');

  await assert.rejects(emitCheckpoint({
    store: validStore, signer: null, fs: refusingIo, destination
  }), error => error && error.code === 'AUDIT_CHECKPOINT_SIGNER_INVALID',
  'a missing signer must produce the signer refusal');
  assert.equal(writes, 0, 'invalid signer refusal must precede outbox writes');
  assert.equal(deliveries, 0, 'invalid signer refusal must precede delivery');

  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKeySigner = {
    publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign() { signatures += 1; return Buffer.alloc(64); }
  };
  await assert.rejects(emitCheckpoint({
    store: validStore, signer: wrongKeySigner, fs: refusingIo, destination
  }), error => error && error.code === 'AUDIT_CHECKPOINT_KEY_INVALID',
  'a non-Ed25519 public key must produce the key refusal');
  assert.equal(signatures, 0, 'invalid key refusal must precede signing');
  assert.equal(writes, 0, 'invalid key refusal must precede outbox writes');
  assert.equal(deliveries, 0, 'invalid key refusal must precede delivery');

  const originalSetInterval = global.setInterval;
  let timersSpawned = 0;
  global.setInterval = () => { timersSpawned += 1; return { unref() {} }; };
  try {
    assert.throws(
      () => startPeriodicCheckpoints({ intervalMs: 999 }),
      error => error && error.code === 'AUDIT_CHECKPOINT_INTERVAL_INVALID',
      'a sub-second schedule must produce the interval refusal'
    );
  } finally {
    global.setInterval = originalSetInterval;
  }
  assert.equal(timersSpawned, 0, 'invalid interval refusal must precede timer creation');
  assert.equal(writes, 0, 'invalid interval refusal must not write a checkpoint');

  /* A positive control keeps the refusal cases from passing merely because all
     checkpoint creation was disabled. */
  const control = createCheckpoint({ store: validStore, signer: validSigner });
  assert.equal(control.body.version, 1);
  assert.equal(typeof control.signature, 'string');

  process.stdout.write('audit checkpoint refusals: 4 driven; 0 failures\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

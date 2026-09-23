'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuditStore, sha256 } = require('../src/lib/audit-store');
const {
  emitCheckpoint, verifyCheckpoint, verifyLedgerAgainstCheckpoint
} = require('../src/lib/audit-checkpoint');

function signer() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    keyId: `test-${crypto.randomUUID()}`,
    publicKeyPem,
    sign: bytes => crypto.sign(null, bytes, pair.privateKey),
    trustedKeyHash: sha256(pair.publicKey.export({ type: 'spki', format: 'der' }))
  };
}

function append(store, auditSigner, eventId) {
  return store.appendEvent({
    eventId, occurredAtMs: Date.now(),
    event: { action: 'checkpoint.test', target: eventId }
  }, auditSigner);
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-checkpoint-'));
  const file = path.join(directory, 'audit.sqlite');
  const outboxDir = path.join(directory, 'outbox');
  const auditSigner = signer();
  let store = createAuditStore({ file });
  store.registerKey({ keyId: auditSigner.keyId, publicKeyPem: auditSigner.publicKeyPem });
  append(store, auditSigner, 'checkpoint-event-0001');
  store.close();
  const preCheckpoint = fs.readFileSync(file);

  store = createAuditStore({ file });
  append(store, auditSigner, 'checkpoint-event-0002');
  const published = await emitCheckpoint({
    store, signer: auditSigner, outboxDir,
    destination: async () => { throw new Error('destination offline'); }
  });
  assert.equal(published.ok, true, 'destination availability never blocks checkpoint creation');
  assert.equal(published.pendingDelivery, true);
  assert.equal(fs.existsSync(published.file), true, 'checkpoint remains locally ready to ship');
  assert.deepEqual(verifyCheckpoint(published.checkpoint, {}), {
    valid: false, reason: 'trusted-key-required'
  }, 'verification fails closed without an independently trusted key fingerprint');

  /* THE SIGNATURE IS THE ENTIRE CLAIM, SO IT IS TESTED AS ONE.
     Before this block, the only verifyCheckpoint case in the tree was the
     trusted-key-required early return above, which returns four lines before
     the cryptography. Deleting the crypto.verify() call outright -- accepting
     every forgery -- left BOTH this suite and audit-checkpoint-wiring.test.js
     at exit 0, printing "1 rollback detected; 0 failures" unchanged. A
     checkpoint exists to prove the ledger was not rolled back or forked, and
     that proof is worth exactly as much as the refusal to accept a forged one.
     Each case below is a refusal, and the positive control above them keeps
     the refusals from passing because nothing can ever verify. */
  const trust = { trustedKeyHash: auditSigner.trustedKeyHash };
  const clone = () => JSON.parse(JSON.stringify(published.checkpoint));

  assert.deepEqual(verifyCheckpoint(published.checkpoint, trust), {
    valid: true, checkpoint: published.checkpoint.body
  }, 'positive control: a genuine checkpoint under its own trusted key verifies');

  const forged = clone();
  const signatureBytes = Buffer.from(forged.signature, 'base64');
  signatureBytes[0] ^= 0xff;
  forged.signature = signatureBytes.toString('base64');
  assert.deepEqual(verifyCheckpoint(forged, trust), {
    valid: false, reason: 'signature'
  }, 'a checkpoint whose signature was altered is refused');

  const rewrittenHead = clone();
  rewrittenHead.body.headHash = sha256(Buffer.from('a ledger state that was never attested'));
  assert.deepEqual(verifyCheckpoint(rewrittenHead, trust), {
    valid: false, reason: 'signature'
  }, 'rewriting the attested head under an otherwise valid signature is refused');

  assert.deepEqual(verifyCheckpoint(published.checkpoint, {
    trustedKeyHash: signer().trustedKeyHash
  }), {
    valid: false, reason: 'untrusted-key'
  }, 'a well-formed checkpoint signed by a key this verifier does not trust is refused');

  assert.equal(verifyLedgerAgainstCheckpoint(store, published.checkpoint, {
    trustedKeyHash: auditSigner.trustedKeyHash
  }).valid, true);

  const unknownStatus = verifyLedgerAgainstCheckpoint({
    verify: () => ({ valid: true }),
    status: () => ({}),
    getEvent: () => ({ eventHash: published.checkpoint.body.headHash })
  }, published.checkpoint, trust);
  assert.deepEqual(unknownStatus, {
    valid: false, reason: 'ledger-status-unavailable'
  }, 'an unreadable head sequence cannot become a definite successful comparison');
  store.close();

  fs.writeFileSync(file, preCheckpoint);
  store = createAuditStore({ file });
  const rollback = verifyLedgerAgainstCheckpoint(store, published.checkpoint, {
    trustedKeyHash: auditSigner.trustedKeyHash
  });
  assert.equal(rollback.valid, false);
  assert.equal(rollback.rollbackDetected, true);
  assert.equal(rollback.reason, 'ledger-behind-checkpoint');
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
  process.stdout.write('audit checkpoint: 1 rollback detected; 0 failures\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

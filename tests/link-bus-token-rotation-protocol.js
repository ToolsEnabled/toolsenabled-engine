// The protocol is exercised with a disposable customer-neutral two-computer
// registry. Importing the production modules never requires an operator's
// installed topology and never starts a listener.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  authenticateOfferWrapper,
  computeReplayDigest,
  createAuthenticatedOfferWrapper,
  createAuthenticatedVerificationReceipt,
  createCommand,
  MAX_TTL_MS,
  PURPOSE,
  RECIPIENT_IDENTITY,
  sealCommand,
  SENDER_IDENTITY,
  tokenFingerprint,
  validateAuthenticatedAck,
  verifyVerificationReceiptWithSigner
} = require('../tools/lib/link-bus-token-rotation');
const {
  createRecipientOffer
} = require('../tools/lib/special-session-sealed-transport');
const {
  parseCli: parseReceiverCli,
  createRotationReceiver
} = require('../tools/link-bus-token-rotation-receiver');
const {
  pinnedRecipientUrl,
  runRotation
} = require('../tools/link-bus-token-rotation-a');

const OLD_TOKEN = Buffer.alloc(32, 0x11).toString('base64url');
const NEW_TOKEN = Buffer.alloc(32, 0x22).toString('base64url');
const BASE_GENERATION = Buffer.alloc(32, 0x33).toString('base64url');
const TEST_ROOT = path.resolve('synthetic-link-bus-rotation');
// The shipped registry is customer-neutral and intentionally carries no
// operator's private two-machine topology. Exercise the supported resolver
// seam with a disposable declarative installation instead.
const SERVICE_REGISTRY = Object.freeze({
  schemaVersion: 1,
  machines: Object.freeze({
    'customer-left': Object.freeze({ address: '203.0.113.2' }),
    'customer-right': Object.freeze({ address: '203.0.113.3' })
  }),
  services: Object.freeze({})
});
const SERVICE_REGISTRY_OPTIONS = Object.freeze({ registry: SERVICE_REGISTRY });
const RECIPIENT_ADDRESS = SERVICE_REGISTRY.machines['customer-right'].address;
const ROTATION_ORIGIN = `http://${RECIPIENT_ADDRESS}:8792`;

function signer(token) {
  const key = Buffer.from(token, 'utf8');
  return async canonical => crypto.createHmac('sha256', key)
    .update(canonical)
    .digest('base64url');
}

class FakeVaultTransaction {
  constructor(role, events = []) {
    this.role = role;
    this.events = events;
    this.phase = 'idle';
    this.paths = {
      statePath: path.join(TEST_ROOT, 'vault', `.${role}.state.json`),
      candidatePath: path.join(TEST_ROOT, 'vault', `.${role}.candidate`),
      stagedBackupPath:
        path.join(TEST_ROOT, 'vault', `${role}.staged-old.encrypted.bak`),
      backupPath: path.join(TEST_ROOT, 'vault', `${role}.old.encrypted.bak`)
    };
    this.state = null;
    this.prepareCalls = 0;
    this.commitCalls = 0;
    this.rollbackCalls = 0;
  }

  async prepare(token) {
    this.prepareCalls += 1;
    this.events.push(`${this.role}.prepare`);
    this.phase = 'prepared';
    this.state = {
      phase: 'prepared',
      operationId: this.operationId,
      oldTokenSha256: tokenFingerprint(OLD_TOKEN),
      newTokenSha256: tokenFingerprint(token),
      baseGenerationSha256: BASE_GENERATION,
      canonicalPath: path.join(TEST_ROOT, 'vault', `secrets.json`),
      candidatePath: this.paths.candidatePath,
      backupPath: this.paths.backupPath,
      failedNewPath: path.join(TEST_ROOT, 'vault', `${this.role}.failed-new.encrypted.bak`)
    };
    return { ...this.state };
  }

  async commit() {
    this.commitCalls += 1;
    this.events.push(`${this.role}.commit`);
    this.phase = 'committed';
    this.state.phase = 'committed';
    return { ...this.state };
  }

  async rollback() {
    this.rollbackCalls += 1;
    this.events.push(`${this.role}.rollback`);
    this.phase = 'rolled_back';
    if (this.state) this.state.phase = 'rolled_back';
    return { ...this.state };
  }

  async status() {
    return { ...this.state };
  }
}

async function makeReceiver(events = []) {
  const transaction = new FakeVaultTransaction('b', events);
  const signerVaults = [];
  const runtime = {
    bindAddress: RECIPIENT_ADDRESS,
    port: 8792,
    repoRoot: TEST_ROOT,
    vaultPath: path.join(TEST_ROOT, 'vault', `secrets.json`),
    offerAuthScriptPath:
      path.join(TEST_ROOT, 'tools', 'special-session-offer-auth.ps1'),
    powershellPath:
      path.join(TEST_ROOT, 'synthetic-powershell.exe')
  };
  const signCanonicalFromVault = async (vaultPath, canonical) => {
    signerVaults.push(vaultPath);
    const useNew = (
      vaultPath === transaction.paths.candidatePath ||
      (
        vaultPath === runtime.vaultPath &&
        transaction.phase === 'committed'
      )
    );
    return signer(useNew ? NEW_TOKEN : OLD_TOKEN)(canonical);
  };
  const receiver = await createRotationReceiver({
    runtime,
    transaction,
    serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS,
    signCanonicalFromVault
  });
  transaction.operationId = receiver.offer.operationId;
  return { receiver, signerVaults, transaction };
}

function mutateBase64Url(value) {
  const bytes = Buffer.from(value, 'base64url');
  bytes[0] ^= 0x01;
  return bytes.toString('base64url');
}

function testRotationEndpointCannotUse8788() {
  assert.throws(
    () => pinnedRecipientUrl(
      `http://${RECIPIENT_ADDRESS}:8788/offer`,
      '/offer',
      { serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS }
    ),
    error => error.code === 'URL_NOT_PINNED'
  );
  assert.throws(
    () => parseReceiverCli([
      '--execute-link-bus-token-rotation-receiver',
      '--bind',
      RECIPIENT_ADDRESS,
      '--port',
      '8788',
      '--repo-root',
      TEST_ROOT
    ], { serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS }),
    error => error.code === 'INVALID_ARGUMENT'
  );
}

async function testVerificationReceiptAuthentication() {
  const receipt = await createAuthenticatedVerificationReceipt({
    operationId: Buffer.alloc(16, 0x44).toString('base64url'),
    tokenSha256: tokenFingerprint(NEW_TOKEN),
    listenerPid: 45670,
    listenerCreationDate: '20260730120000.000000-420',
    port8788Closed: true,
    verifiedAt: 1800000004000,
    signCanonical: signer(NEW_TOKEN)
  });
  await verifyVerificationReceiptWithSigner({
    receipt,
    operationId: receipt.operationId,
    tokenSha256: receipt.tokenSha256,
    signCanonical: signer(NEW_TOKEN)
  });
  await assert.rejects(
    verifyVerificationReceiptWithSigner({
      receipt: {
        ...receipt,
        listenerPid: receipt.listenerPid + 1
      },
      operationId: receipt.operationId,
      tokenSha256: receipt.tokenSha256,
      signCanonical: signer(NEW_TOKEN)
    }),
    error => error.code === 'VERIFICATION_AUTHENTICATION_FAILED'
  );
  await assert.rejects(
    verifyVerificationReceiptWithSigner({
      receipt,
      operationId: receipt.operationId,
      tokenSha256: receipt.tokenSha256,
      signCanonical: signer(OLD_TOKEN)
    }),
    error => error.code === 'VERIFICATION_AUTHENTICATION_FAILED'
  );
  await assert.rejects(
    verifyVerificationReceiptWithSigner({
      receipt,
      operationId: Buffer.alloc(16, 0x45).toString('base64url'),
      tokenSha256: receipt.tokenSha256,
      signCanonical: signer(NEW_TOKEN)
    }),
    error => error.code === 'VERIFICATION_FAILED'
  );
  const missingProof = { ...receipt };
  delete missingProof.proof;
  await assert.rejects(
    verifyVerificationReceiptWithSigner({
      receipt: missingProof,
      operationId: receipt.operationId,
      tokenSha256: receipt.tokenSha256,
      signCanonical: signer(NEW_TOKEN)
    }),
    error => error.code === 'INVALID_SHAPE'
  );
  await assert.rejects(
    verifyVerificationReceiptWithSigner({
      receipt: {
        ...receipt,
        proof: mutateBase64Url(receipt.proof)
      },
      operationId: receipt.operationId,
      tokenSha256: receipt.tokenSha256,
      signCanonical: signer(NEW_TOKEN)
    }),
    error => error.code === 'VERIFICATION_AUTHENTICATION_FAILED'
  );
}

async function testProtocolAuthenticationAndReplay() {
  const overlongContext = createRecipientOffer({
    senderIdentity: SENDER_IDENTITY,
    recipientIdentity: RECIPIENT_IDENTITY,
    purpose: PURPOSE,
    now: Date.now(),
    ttlMs: MAX_TTL_MS + 1
  });
  try {
    await assert.rejects(
      createAuthenticatedOfferWrapper({
        offer: overlongContext.offer,
        signCanonical: signer(OLD_TOKEN)
      }),
      error => error.code === 'OFFER_CONTEXT_MISMATCH'
    );
  } finally {
    overlongContext.destroy();
  }
  const { receiver, signerVaults, transaction } = await makeReceiver();
  const authenticatedOffer = authenticateOfferWrapper({
    wrapper: receiver.offerWrapper,
    authenticationKey: Buffer.from(OLD_TOKEN, 'utf8')
  });
  assert.deepEqual(authenticatedOffer, receiver.offer);

  const forged = createCommand({
    action: 'stage_b',
    offer: receiver.offer,
    token: NEW_TOKEN,
    authenticationKey: Buffer.from(
      Buffer.alloc(32, 0x99).toString('base64url'),
      'utf8'
    )
  });
  await assert.rejects(
    receiver.handleEnvelope(
      'stage_b',
      sealCommand({ offer: receiver.offer, command: forged })
    ),
    error => error.code === 'COMMAND_AUTHENTICATION_FAILED'
  );
  assert.equal(transaction.prepareCalls, 0);

  const stageCommand = createCommand({
    action: 'stage_b',
    offer: receiver.offer,
    token: NEW_TOKEN,
    authenticationKey: Buffer.from(OLD_TOKEN, 'utf8')
  });
  const stageEnvelope = sealCommand({
    offer: receiver.offer,
    command: stageCommand
  });
  const tampered = JSON.parse(JSON.stringify(stageEnvelope));
  tampered.authenticationTag = mutateBase64Url(tampered.authenticationTag);
  await assert.rejects(
    receiver.handleEnvelope('stage_b', tampered),
    error => error.code === 'AUTHENTICATION_FAILED'
  );
  assert.equal(transaction.prepareCalls, 0);

  const stageDigest = computeReplayDigest(stageEnvelope);
  const stageAck = await receiver.handleEnvelope('stage_b', stageEnvelope);
  validateAuthenticatedAck({
    ack: stageAck,
    expectedStatus: 'staged_b',
    offer: receiver.offer,
    tokenSha256: tokenFingerprint(NEW_TOKEN),
    envelopeReplayDigest: stageDigest,
    oldGenerationSha256: BASE_GENERATION,
    authenticationKey: Buffer.from(NEW_TOKEN, 'utf8')
  });
  const repeatedStageAck = await receiver.handleEnvelope(
    'stage_b',
    stageEnvelope
  );
  assert.deepEqual(repeatedStageAck, stageAck);
  assert.equal(transaction.prepareCalls, 1);

  const commitCommand = createCommand({
    action: 'commit_b',
    offer: receiver.offer,
    tokenSha256: tokenFingerprint(NEW_TOKEN),
    authenticationKey: Buffer.from(OLD_TOKEN, 'utf8')
  });
  const commitEnvelope = sealCommand({
    offer: receiver.offer,
    command: commitCommand
  });
  const signerCallsBeforeCommit = signerVaults.length;
  const commitAck = await receiver.handleEnvelope(
    'commit_b',
    commitEnvelope
  );
  assert.deepEqual(
    signerVaults.slice(signerCallsBeforeCommit),
    [
      transaction.paths.stagedBackupPath,
      path.join(TEST_ROOT, 'vault', `secrets.json`)
    ]
  );
  validateAuthenticatedAck({
    ack: commitAck,
    expectedStatus: 'committed_b',
    offer: receiver.offer,
    tokenSha256: tokenFingerprint(NEW_TOKEN),
    envelopeReplayDigest: computeReplayDigest(commitEnvelope),
    oldGenerationSha256: BASE_GENERATION,
    authenticationKey: Buffer.from(NEW_TOKEN, 'utf8')
  });
  assert.equal(transaction.commitCalls, 1);
  receiver.destroy();
}

async function testCoordinatorOrderingAndAckAuthentication() {
  const events = [];
  const { receiver, transaction: bTransaction } = await makeReceiver(events);
  const aTransaction = new FakeVaultTransaction('a', events);
  aTransaction.operationId = receiver.offer.operationId;

  const result = await runRotation({
    repoRoot: TEST_ROOT,
    offerUrl: `${ROTATION_ORIGIN}/offer`,
    stageUrl: `${ROTATION_ORIGIN}/stage`,
    commitUrl: `${ROTATION_ORIGIN}/commit`,
    rollbackUrl: `${ROTATION_ORIGIN}/rollback`,
    transaction: aTransaction,
    collectAuthenticationKey: async () => Buffer.from(OLD_TOKEN, 'utf8'),
    loadOffer: async () => JSON.parse(JSON.stringify(receiver.offerWrapper)),
    post: async ({ url, envelope }) => {
      const action = {
        '/stage': 'stage_b',
        '/commit': 'commit_b',
        '/rollback': 'rollback_b'
      }[url.pathname];
      return receiver.handleEnvelope(action, envelope);
    },
    randomBytes: size => Buffer.alloc(size, 0x22),
    serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS
  });
  assert.equal(result.status, 'restart_required');
  assert.deepEqual(events, [
    'a.prepare',
    'b.prepare',
    'b.commit',
    'a.commit'
  ]);
  assert.equal(aTransaction.commitCalls, 1);
  assert.equal(bTransaction.commitCalls, 1);
  receiver.destroy();

  const tamperEvents = [];
  const tamperSetup = await makeReceiver(tamperEvents);
  const tamperATransaction = new FakeVaultTransaction('a', tamperEvents);
  tamperATransaction.operationId = tamperSetup.receiver.offer.operationId;
  await assert.rejects(
    runRotation({
      repoRoot: TEST_ROOT,
      offerUrl: `${ROTATION_ORIGIN}/offer`,
      stageUrl: `${ROTATION_ORIGIN}/stage`,
      commitUrl: `${ROTATION_ORIGIN}/commit`,
      rollbackUrl: `${ROTATION_ORIGIN}/rollback`,
      transaction: tamperATransaction,
      collectAuthenticationKey: async () => Buffer.from(OLD_TOKEN, 'utf8'),
      loadOffer: async () => JSON.parse(JSON.stringify(
        tamperSetup.receiver.offerWrapper
      )),
      post: async ({ url, envelope }) => {
        const action = {
          '/stage': 'stage_b',
          '/commit': 'commit_b',
          '/rollback': 'rollback_b'
        }[url.pathname];
        const ack = await tamperSetup.receiver.handleEnvelope(action, envelope);
        if (url.pathname === '/commit') {
          return { ...ack, proof: mutateBase64Url(ack.proof) };
        }
        return ack;
      },
      randomBytes: size => Buffer.alloc(size, 0x22),
      serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS
    }),
    error => error.code === 'ACK_AUTHENTICATION_FAILED'
  );
  assert.equal(tamperATransaction.commitCalls, 0);
  assert.equal(tamperATransaction.rollbackCalls, 1);
  assert.equal(tamperSetup.transaction.rollbackCalls, 1);
  assert.deepEqual(tamperEvents, [
    'a.prepare',
    'b.prepare',
    'b.commit',
    'b.rollback',
    'a.rollback'
  ]);
  assert.deepEqual(
    tamperSetup.signerVaults.slice(-2),
    [
      tamperSetup.transaction.paths.backupPath,
      path.join(TEST_ROOT, 'vault', `secrets.json`)
    ]
  );
  tamperSetup.receiver.destroy();
}

async function main() {
  testRotationEndpointCannotUse8788();
  await testVerificationReceiptAuthentication();
  await testProtocolAuthenticationAndReplay();
  await testCoordinatorOrderingAndAckAuthentication();
  process.stdout.write(
    'link-bus-token-rotation-protocol: all focused tests passed\n'
  );
}

main().catch(error => {
  process.stderr.write(
    `link-bus-token-rotation-protocol failed: ${error && error.code || 'TEST_FAILED'}\n`
  );
  process.exitCode = 1;
});

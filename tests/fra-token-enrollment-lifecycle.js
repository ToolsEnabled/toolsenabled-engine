// EXECUTABLE CHANGE
// Assertion audit (testcanfail-tests-fra-token-enrollment-lifecycle-js):
// - SAME-CODE EXPECTATION: deriveFinalizationFence formerly supplied both the
//   product result and the expected value used throughout finalization.  The
//   independently pinned vector below now discriminates an incorrect digest.
// - NOT-FOUND: empty loop/forEach assertion bodies; exit-status/truthy-return
//   assertions supported only by a subject's own output; swallowed failures;
//   assertions against a mock of the subject; skip/platform no-op guards.
// - MUTATION: returning "A".repeat(43) from deriveFinalizationFence makes the
//   pinned-vector assertion RED with:
//     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
//     + actual - expected
//     + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
//     - 's0j58EnFCIg9u9E8AaQ9DcyAp47L7BKf__v-Ol9Hpuc'
// - RESTORE/PRECONDITION: the product mutation was restored byte-for-byte.
//   The full file cannot currently reach this assertion on the shipped
//   one-machine registry/API: lifecycle.HOST_B is undefined and roleForHost
//   first fails while resolving machine-b with SERVICE_MACHINE_UNKNOWN.  That pre-existing assertion
//   is reported, not weakened; a focused vector run is quoted in the commit/PR
//   report because a green full-file confirmation is therefore unavailable.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rawLifecycle = require('../tools/fra-token-enrollment-lifecycle');
const {
  MAX_TTL_MS,
  createAuthenticatedOfferWrapper,
  createEnrollmentRecipientContext,
  generateToken,
  tokenFingerprint
} = require('../tools/lib/fra-token-enrollment');

// Enrollment is a two-machine feature, while a fresh customer installation
// truthfully declares only its own machine. Bind every exercised lifecycle API
// to a complete synthetic registry rather than depending on or rewriting one
// installation's config/service-registry.json.
const LAB_REGISTRY = Object.freeze({
  schemaVersion: 1,
  machines: Object.freeze({
    'machine-a': Object.freeze({ address: '203.0.113.1', root: 'C:\\fixture-a', role: 'development-host' }),
    'machine-b': Object.freeze({ address: '203.0.113.2', root: 'C:\\fixture-b', role: 'disconnected-peer' })
  }),
  services: Object.freeze({
    'full-remote-access': Object.freeze({ resolution: 'peer', port: 8790 })
  })
});
const serviceRegistryOptions = Object.freeze({ registry: LAB_REGISTRY });
const enrollmentIdentities = Object.freeze({ senderIdentity: 'machine-a', recipientIdentity: 'machine-b' });
const bindOptions = name => (options = {}) => rawLifecycle[name]({ ...options, serviceRegistryOptions });
const lifecycle = Object.freeze({
  ...rawLifecycle,
  HOST_A: rawLifecycle.hostA(serviceRegistryOptions),
  HOST_B: rawLifecycle.hostB(serviceRegistryOptions),
  roleForHost: host => rawLifecycle.roleForHost(host, serviceRegistryOptions),
  peerForHost: host => rawLifecycle.peerForHost(host, serviceRegistryOptions),
  assertLocalHost: (host, root, detectHost) => rawLifecycle.assertLocalHost(
    host, root, detectHost, serviceRegistryOptions
  ),
  parseCli: (argv, dependencies = {}) => rawLifecycle.parseCli(
    argv, { ...dependencies, serviceRegistryOptions }
  ),
  probePeer: bindOptions('probePeer'),
  preflightCoordinator: bindOptions('preflightCoordinator'),
  runCoordinator: bindOptions('runCoordinator'),
  startReceiverDetached: bindOptions('startReceiverDetached'),
  transactionStatus: bindOptions('transactionStatus'),
  rollbackTransaction: bindOptions('rollbackTransaction'),
  retireRolledBackRecovery: bindOptions('retireRolledBackRecovery'),
  proveOldTokenRejected: bindOptions('proveOldTokenRejected'),
  fencePeerFinalization: bindOptions('fencePeerFinalization'),
  prepareFinalize: bindOptions('prepareFinalize'),
  confirmFinalize: bindOptions('confirmFinalize'),
  finalizeTransaction: bindOptions('finalizeTransaction')
});

function expectCode(fn, code) {
  assert.throws(fn, error => error?.code === code || error?.message === code);
}

async function expectCodeAsync(fn, code) {
  await assert.rejects(fn, error => error?.code === code || error?.message === code);
}

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-lifecycle-'));
  const token = generateToken(size => Buffer.alloc(size, 0x41));
  // Mechanical-Connect's installed pre-enrollment credential is a canonical
  // 30-byte/40-character value. Exercise that real migration input through
  // probe and terminal old-token proof rather than using a second new token.
  const oldToken = Buffer.alloc(30, 0x31).toString('base64url');
  const fingerprint = tokenFingerprint(token);
  const oldFingerprint = require('../tools/lib/fra-token-enrollment').persistedTokenFingerprint(oldToken);
  const operationId = Buffer.alloc(16, 0x22).toString('base64url');
  const sentinel = 'must-not-escape-lifecycle-secret';
  try {
    assert.equal(lifecycle.PORT, 8794);
    assert.equal(MAX_TTL_MS, 165 * 60 * 1000);
    assert.equal(lifecycle.COORDINATOR_TIMEOUT_MS, 110 * 60 * 1000);
    assert.equal(lifecycle.COMPENSATION_RESERVE_MS, 5 * 60 * 1000);
    assert.equal(
      MAX_TTL_MS - lifecycle.COORDINATOR_TIMEOUT_MS - lifecycle.COMPENSATION_RESERVE_MS,
      50 * 60 * 1000
    );
    assert.equal(lifecycle.roleForHost(lifecycle.HOST_B), 'b');
    assert.equal(lifecycle.peerForHost(lifecycle.HOST_B), lifecycle.HOST_A);
    expectCode(() => lifecycle.peerForHost('127.0.0.1'), 'FRA_LIFECYCLE_HOST_INVALID');
    expectCode(() => lifecycle.assertLocalHost(lifecycle.HOST_A, temp, () => lifecycle.HOST_B),
      'FRA_LIFECYCLE_HOST_BINDING_INVALID');
    const identityRoot = path.join(temp, 'identity-root');
    const identityAlias = path.join(temp, 'identity-root-alias');
    const identityPeer = path.join(temp, 'identity-peer');
    fs.mkdirSync(identityRoot);
    fs.mkdirSync(identityPeer);
    fs.symlinkSync(identityRoot, identityAlias, 'junction');
    const identityRegistryOptions = { registry: {
      schemaVersion: 1,
      machines: {
        left: { address: '192.0.2.10', root: identityRoot },
        right: { address: '192.0.2.20', root: identityAlias }
      },
      services: {}
    } };
    assert.equal(rawLifecycle.detectedHost(identityRoot, identityRegistryOptions), '192.0.2.10');
    expectCode(() => rawLifecycle.detectedHost(identityAlias, identityRegistryOptions),
      'FRA_LIFECYCLE_ROOT_INVALID');
    let aliasTransactionOpened = false;
    await expectCodeAsync(() => rawLifecycle.transactionStatus({
      host: '192.0.2.20', root: identityAlias, detectHost: () => '192.0.2.20',
      openTransaction: async () => { aliasTransactionOpened = true; },
      serviceRegistryOptions: identityRegistryOptions
    }), 'FRA_LIFECYCLE_ROOT_INVALID');
    assert.equal(aliasTransactionOpened, false,
      'an injected host detector must not bypass canonical-root binding before state access');
    assert.equal(lifecycle.isFingerprint(fingerprint), true);
    assert.equal(lifecycle.isFingerprint('a'.repeat(64)), false);
    assert.equal(lifecycle.isOperationId(operationId), true);
    assert.equal(lifecycle.isOperationId('x'.repeat(22)), false);

    const projected = lifecycle.safeTransactionState({
      phase: 'committed', role: 'b', operationId,
      newFingerprint: fingerprint, previousFingerprint: oldFingerprint,
      previouslyPresent: true, createdAt: 1, updatedAt: 2,
      arbitrary: sentinel
    });
    assert.deepEqual(projected, {
      phase: 'committed', role: 'b', operationId,
      newFingerprint: fingerprint, previousFingerprint: oldFingerprint,
      previouslyPresent: true, createdAtMs: 1, updatedAtMs: 2,
      secretValuesEmitted: false
    });
    assert.equal(JSON.stringify(projected).includes(sentinel), false);

    const digestA = 'a'.repeat(64);
    const digestB = 'b'.repeat(64);
    let proxyOptions;
    let requestCount = 0;
    const probe = await lifecycle.probePeer({
      host: lifecycle.HOST_B,
      root: temp,
      detectHost: () => lifecycle.HOST_B,
      loadToken: () => token,
      loadProfile: () => ({
        allowedTools: ['z.tool', 'a.tool'], allowedToolCount: 2,
        registryNameDigest: digestA, allowedToolNamesDigest: digestB
      }),
      openTransaction: async () => ({ status: async () => ({ phase: 'not_started' }) }),
      createProxy(options) {
        proxyOptions = options;
        return {
          closed: false,
          async request() {
            requestCount += 1;
            if (requestCount === 1) return { result: { serverInfo: { name: 'toolsenabled' } } };
            return { result: { tools: [{ name: 'a.tool' }, { name: 'z.tool' }] } };
          },
          _dropSocket() {}
        };
      }
    });
    assert.equal(probe.ok, true);
    assert.equal(probe.localTokenFingerprint, fingerprint);
    assert.equal(proxyOptions.fraReceiptFile, path.join(temp, 'state', 'full-remote-access-peer-session.json'));
    assert.equal(proxyOptions.tokenLoader(), token);
    assert.equal(JSON.stringify(probe).includes(token), false);
    requestCount = 0;
    const legacyProbe = await lifecycle.probePeer({
      host: lifecycle.HOST_B,
      root: temp,
      detectHost: () => lifecycle.HOST_B,
      loadToken: () => oldToken,
      loadProfile: () => ({
        allowedTools: ['z.tool', 'a.tool'], allowedToolCount: 2,
        registryNameDigest: digestA, allowedToolNamesDigest: digestB
      }),
      openTransaction: async () => ({ status: async () => ({ phase: 'not_started' }) }),
      createProxy() {
        return {
          closed: false,
          async request() {
            requestCount += 1;
            if (requestCount === 1) return { result: { serverInfo: { name: 'toolsenabled' } } };
            return { result: { tools: [{ name: 'a.tool' }, { name: 'z.tool' }] } };
          },
          _dropSocket() {}
        };
      }
    });
    assert.equal(legacyProbe.ok, true);
    assert.equal(legacyProbe.localTokenFingerprint, oldFingerprint);
    assert.equal(JSON.stringify(legacyProbe).includes(oldToken), false);
    await expectCodeAsync(() => lifecycle.probePeer({
      host: lifecycle.HOST_B,
      root: temp,
      detectHost: () => lifecycle.HOST_B,
      loadToken: () => token,
      loadProfile: () => ({
        allowedTools: [], allowedToolCount: 0,
        registryNameDigest: digestA, allowedToolNamesDigest: digestB
      }),
      openTransaction: async () => { throw new Error('transaction state unreadable'); },
      createProxy() { throw new Error('must not probe without rotation state'); }
    }), 'FRA_LIFECYCLE_ROTATION_STATE_UNAVAILABLE');

    const signingKey = Buffer.alloc(32, 0x55);
    const signCanonical = async canonical => crypto.createHmac('sha256', signingKey).update(canonical).digest('base64url');
    const baseNow = 1_800_000_000_000;
    const context = createEnrollmentRecipientContext({ ...enrollmentIdentities, now: baseNow, ttlMs: MAX_TTL_MS });
    const wrapper = await createAuthenticatedOfferWrapper({ ...enrollmentIdentities, offer: context.offer, signCanonical, now: baseNow });
    const preflight = await lifecycle.preflightCoordinator({
      root: temp, port: 8794, now: () => baseNow,
      fetchOffer: async () => wrapper,
      dependencies: { signCanonical }
    });
    assert.equal(preflight.operationId, context.offer.operationId);
    assert.equal(preflight.remainingMs, 165 * 60 * 1000);
    await expectCodeAsync(() => lifecycle.preflightCoordinator({
      root: temp, port: 8794,
      now: () => context.offer.expiresAt
        - (lifecycle.COORDINATOR_TIMEOUT_MS + lifecycle.COMPENSATION_RESERVE_MS) + 1,
      fetchOffer: async () => wrapper,
      dependencies: { signCanonical }
    }), 'FRA_LIFECYCLE_OFFER_WINDOW_INSUFFICIENT');

    let coordinatorInvocation;
    const coordinated = await lifecycle.runCoordinator({
      host: lifecycle.HOST_A,
      root: temp,
      detectHost: () => lifecycle.HOST_A,
      preflight: async () => ({ operationId: context.offer.operationId }),
      spawn(command, args, options) {
        coordinatorInvocation = { command, args, options };
        return {
          status: 0,
          stdout: `${JSON.stringify({
            status: 'committed', operationId: context.offer.operationId,
            tokenFingerprint: fingerprint, machineAPhase: 'committed', machineBPhase: 'committed'
          })}\n`, stderr: ''
        };
      }
    });
    assert.equal(coordinated.ok, true);
    assert.equal(coordinatorInvocation.options.windowsHide, true);
    assert.equal(coordinatorInvocation.options.shell, false);
    assert.equal(JSON.stringify(coordinatorInvocation).includes(token), false);

    const transactionState = {
      phase: 'prepared', role: 'a', operationId,
      newFingerprint: fingerprint, previousFingerprint: oldFingerprint,
      previouslyPresent: true, createdAt: 1, updatedAt: 2
    };
    let rolled = false;
    let recoveryRetired = false;
    let finalized = false;
    const fakeTransaction = {
      async status() { return transactionState; },
      async rollback() { rolled = true; return { ...transactionState, phase: 'rolled_back' }; },
      async retireRolledBackRecovery() {
        recoveryRetired = true;
        return { ...transactionState, phase: 'rolled_back' };
      },
      async finalize({ fence }) { finalized = true; return { ...transactionState, phase: 'committed', finalizedFence: fence }; }
    };
    const rollback = await lifecycle.rollbackTransaction({
      host: lifecycle.HOST_A, root: temp, operationId, fingerprint,
      detectHost: () => lifecycle.HOST_A,
      openTransaction: async () => fakeTransaction
    });
    assert.equal(rollback.rolledBack, true);
    assert.equal(rolled, true);
    transactionState.phase = 'rolled_back';
    const retired = await lifecycle.retireRolledBackRecovery({
      host: lifecycle.HOST_A, root: temp, operationId, fingerprint,
      detectHost: () => lifecycle.HOST_A,
      openTransaction: async () => fakeTransaction
    });
    assert.equal(retired.recoveryRetired, true);
    assert.equal(recoveryRetired, true);
    await expectCodeAsync(() => lifecycle.retireRolledBackRecovery({
      host: lifecycle.HOST_A, root: temp, operationId,
      fingerprint: oldFingerprint,
      detectHost: () => lifecycle.HOST_A,
      openTransaction: async () => fakeTransaction
    }), 'FRA_LIFECYCLE_TRANSACTION_MISMATCH');
    await expectCodeAsync(() => lifecycle.finalizeTransaction({
      host: lifecycle.HOST_A, root: temp, operationId, fingerprint,
      detectHost: () => lifecycle.HOST_A,
      openTransaction: async () => fakeTransaction
    }), 'FRA_LIFECYCLE_FINALIZE_PHASE_INVALID');
    assert.equal(finalized, false, 'rolled-back recovery material must not be finalized automatically');
    transactionState.phase = 'committed';
    await expectCodeAsync(() => lifecycle.finalizeTransaction({
      host: lifecycle.HOST_A, root: temp, operationId, fingerprint,
      detectHost: () => lifecycle.HOST_A,
      openTransaction: async () => fakeTransaction
    }), 'FRA_LIFECYCLE_FINALIZE_BARRIER_NOT_READY');
    const fence = lifecycle.deriveFinalizationFence({
      operationId, previousFingerprint: oldFingerprint, currentFingerprint: fingerprint
    });
    const expectedFinalizationFence = 'BYGAc1wtmOPOBRgmmOrMth4jNAxDY3vlHm5DdJxlb_M';
    assert.equal(fence, expectedFinalizationFence);
    transactionState.finalization = { state: 'mutual', fence };
    const barrierTime = new Date().toISOString();
    fs.mkdirSync(path.join(temp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'state', 'full-remote-access-lifecycle.json'), JSON.stringify({
      schemaVersion: 'tools-enabled.full-remote-access-lifecycle.v3',
      secretValuesEmitted: false,
      host: lifecycle.HOST_A,
      peer: lifecycle.HOST_B,
      rotation: {
        operationId,
        newFingerprint: fingerprint,
        terminalPhase: 'committed',
        oldProofOperationId: operationId,
        committedAt: barrierTime,
        outboundCurrentAt: barrierTime,
        inboundCurrentAt: barrierTime,
        oldTokenRejectedAt: barrierTime,
        peerOldProofAt: barrierTime
      }
    }) + '\n');
    const barrierFinal = await lifecycle.finalizeTransaction({
      host: lifecycle.HOST_A, root: temp, operationId, fingerprint, fence,
      detectHost: () => lifecycle.HOST_A,
      openTransaction: async () => fakeTransaction
    });
    assert.equal(barrierFinal.finalized, true);
    await expectCodeAsync(() => lifecycle.finalizeTransaction({
      host: lifecycle.HOST_A, root: temp, operationId, fence,
      fingerprint: oldFingerprint, detectHost: () => lifecycle.HOST_A,
      openTransaction: async () => fakeTransaction
    }), 'FRA_LIFECYCLE_TRANSACTION_MISMATCH');

    const finalizationFence = lifecycle.deriveFinalizationFence({
      operationId, previousFingerprint: oldFingerprint, currentFingerprint: fingerprint
    });
    assert.equal(finalizationFence, expectedFinalizationFence);
    let localReceiptDigest;
    const peerReceiptDigest = Buffer.alloc(32, 0x52).toString('base64url');
    fs.writeFileSync(path.join(temp, 'state', 'full-remote-access-peer-session.json'), JSON.stringify({
      schemaVersion: 'full-remote-access-peer-session.v4', secretValuesEmitted: false,
      authenticatedAt: new Date().toISOString(), localHost: lifecycle.HOST_A, peerHost: lifecycle.HOST_B,
      rotationKind: 'old-token-rejected', rotationOperationId: operationId, rotationPreviousFingerprint: oldFingerprint,
      rotationCurrentFingerprint: fingerprint, rotationRejectionCode: 'REMOTE_BRIDGE_CONNECTION_CLOSED',
      rotationNonce: Buffer.alloc(16, 0x53).toString('base64url')
    }) + '\n');
    const finalizationState = {
      phase: 'committed', role: 'a', operationId, newFingerprint: fingerprint,
      previousFingerprint: oldFingerprint, previouslyPresent: true, finalization: { state: 'none' }
    };
    const finalizationTransaction = {
      async status() { return finalizationState; },
      async prepareFinalize({ fence: receivedFence, localReceiptDigest: receivedDigest }) {
        assert.equal(receivedFence, finalizationFence);
        assert.equal(receivedDigest, localReceiptDigest);
        return { ...finalizationState, finalization: { state: 'prepared', fence: receivedFence, localReceiptDigest: receivedDigest } };
      },
      async confirmPeerFinalize({ fence: receivedFence, peerReceiptDigest: receivedDigest }) {
        assert.equal(receivedFence, finalizationFence);
        assert.equal(receivedDigest, peerReceiptDigest);
        return { ...finalizationState, finalization: { state: 'mutual', fence: receivedFence, peerReceiptDigest: receivedDigest } };
      }
    };
    const fenceMessages = [];
    const peerFence = await lifecycle.fencePeerFinalization({
      host: lifecycle.HOST_A, root: temp, operationId, fingerprint,
      detectHost: () => lifecycle.HOST_A, openTransaction: async () => finalizationTransaction,
      loadToken: () => token, loadProfile: () => ({ allowedToolCount: 0 }),
      createProxy: () => ({
        closed: false,
        async request(message) {
          if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
          return { result: { tools: [] } };
        },
        async recordRotationProof(proof) {
          fenceMessages.push(proof);
          assert.equal(proof.kind, 'current');
          fs.writeFileSync(path.join(temp, 'state', 'full-remote-access-peer-session.json'), JSON.stringify({
            schemaVersion: 'full-remote-access-peer-session.v4', secretValuesEmitted: false,
            authenticatedAt: new Date().toISOString(), localHost: lifecycle.HOST_A, peerHost: lifecycle.HOST_B,
            rotationKind: proof.kind, rotationOperationId: proof.operationId,
            rotationPreviousFingerprint: proof.previousFingerprint,
            rotationCurrentFingerprint: proof.currentFingerprint,
            rotationRejectionCode: proof.rejectionCode, rotationNonce: proof.nonce
          }) + '\n');
          localReceiptDigest = crypto.createHash('sha256').update(
            fs.readFileSync(path.join(temp, 'state', 'full-remote-access-peer-session.json'))
          ).digest('base64url');
          return { ...proof, type: 'fra.rotation.proof-recorded' };
        },
        async prepareRotationFinalize(request) { fenceMessages.push(request); return { fence: request.fence, localReceiptDigest: peerReceiptDigest }; },
        async confirmRotationFinalize(request) { fenceMessages.push(request); return { fence: request.fence }; },
        _dropSocket() {}
      })
    });
    assert.equal(peerFence.fence, expectedFinalizationFence);
    assert.equal(fenceMessages.length, 3);

    const proofState = { ...transactionState, phase: 'committed' };
    const proofTransaction = {
      paths: { backupPath: path.join(temp, 'vault', '.secrets.json.fra-token-enrollment.a.proof.encrypted.bak') },
      async status() { return proofState; }
    };
    let proofCalls = 0;
    const oldProof = await lifecycle.proveOldTokenRejected({
      host: lifecycle.HOST_A, root: temp, operationId, fingerprint,
      detectHost: () => lifecycle.HOST_A,
      openTransaction: async () => proofTransaction,
      loadPriorToken: () => oldToken,
      probe: async options => {
        proofCalls += 1;
        if (options.loadToken) {
          assert.equal(options.loadToken(), oldToken);
          return { ok: false, code: 'REMOTE_BRIDGE_CONNECTION_CLOSED', localTokenFingerprint: oldFingerprint };
        }
        return { ok: true, localTokenFingerprint: fingerprint };
      }
    });
    assert.equal(proofCalls, 3);
    assert.equal(oldProof.oldTokenRejected, true);
    assert.equal(oldProof.currentTokenReverified, true);
    assert.equal(JSON.stringify(oldProof).includes(oldToken), false);
    let inconclusiveCalls = 0;
    await expectCodeAsync(() => lifecycle.proveOldTokenRejected({
      host: lifecycle.HOST_A, root: temp, operationId, fingerprint,
      detectHost: () => lifecycle.HOST_A,
      openTransaction: async () => proofTransaction,
      loadPriorToken: () => oldToken,
      probe: async options => {
        inconclusiveCalls += 1;
        if (options.loadToken) return { ok: false, code: 'REMOTE_BRIDGE_HANDSHAKE_TIMEOUT' };
        return { ok: true, localTokenFingerprint: fingerprint };
      }
    }), 'FRA_LIFECYCLE_OLD_TOKEN_PROOF_INCONCLUSIVE');
    assert.equal(inconclusiveCalls, 2);

    const vaultDir = path.join(temp, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    const vaultFile = path.join(vaultDir, 'secrets.json');
    fs.writeFileSync(vaultFile, '{}\n');
    assert.equal(lifecycle.assertVaultFile(temp, vaultFile), vaultFile);
    expectCode(() => lifecycle.assertVaultFile(temp, path.join(temp, 'outside.json')),
      'FRA_LIFECYCLE_VAULT_PATH_INVALID');

    const readyChild = { pid: 4321, exitCode: null };
    const readiness = await lifecycle.waitForReceiverReady({
      child: readyChild, host: lifecycle.HOST_B, port: 8794, root: temp,
      inspect() {
        return { status: 0, stdout: JSON.stringify({
          schemaVersion: 'full-remote-access-enrollment-status.v1',
          host: lifecycle.HOST_B, enrollmentPort: 8794,
          enrollmentState: 'owned', enrollmentPid: 4321,
          enrollmentReady: true, secretValuesEmitted: false
        }) };
      }
    });
    assert.equal(readiness, true);

    let killed = false;
    await expectCodeAsync(() => lifecycle.startReceiverDetached({
      host: lifecycle.HOST_B, root: temp, detectHost: () => lifecycle.HOST_B,
      spawnProcess() { return { pid: 9876, exitCode: null, unref() {}, kill() { killed = true; } }; },
      waitUntilReady: async () => { throw new Error(sentinel); }
    }), 'FRA_LIFECYCLE_RECEIVER_READINESS_FAILED');
    assert.equal(killed, true);

    const cliDependencies = {
      root: temp,
      detectHost(root) {
        assert.equal(root, temp);
        return lifecycle.HOST_B;
      }
    };
    const detectedCli = lifecycle.parseCli(['--probe-peer', '--port', '8794'], cliDependencies);
    assert.equal(detectedCli.host, lifecycle.HOST_B);
    const boundCli = lifecycle.parseCli([
      '--probe-peer', '--host', lifecycle.HOST_B, '--port', '8794'
    ], cliDependencies);
    assert.equal(boundCli.host, lifecycle.HOST_B);
    expectCode(() => lifecycle.parseCli([
      '--probe-peer', '--host', lifecycle.HOST_A, '--port', '8794'
    ], cliDependencies), 'FRA_LIFECYCLE_HOST_BINDING_INVALID');
    expectCode(() => lifecycle.parseCli([
      '--finalize', '--host', lifecycle.HOST_B, '--port', '8794'
    ], cliDependencies),
      'FRA_LIFECYCLE_ARGUMENT_INVALID');
    expectCode(() => lifecycle.parseCli([
      '--finalize', '--host', lifecycle.HOST_B, '--port', '8794',
      '--operation-id', operationId, '--fingerprint', fingerprint,
      '--fence', finalizationFence, '--receipt-digest', fingerprint
    ], cliDependencies), 'FRA_LIFECYCLE_ARGUMENT_INVALID');
    const recoveryCli = lifecycle.parseCli([
      '--retire-rolled-back-recovery', '--host', lifecycle.HOST_B, '--port', '8794',
      '--operation-id', operationId, '--fingerprint', fingerprint
    ], cliDependencies);
    assert.equal(recoveryCli.action, 'retire-rolled-back-recovery');
    expectCode(() => lifecycle.parseCli([
      '--retire-rolled-back-recovery', '--host', lifecycle.HOST_B, '--port', '8794',
      '--operation-id', operationId, '--fingerprint', fingerprint,
      '--fence', finalizationFence
    ], cliDependencies), 'FRA_LIFECYCLE_ARGUMENT_INVALID');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('FRA token enrollment lifecycle tests passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });

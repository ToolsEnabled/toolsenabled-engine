'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  implementations: {
    m4: { createClaimAuthority },
    m7: { createFencedSagaCoordinator },
  },
} = require('../src');

const NOW = '2026-08-07T12:00:00.000Z';

function fixture({ count = 3, failAt = -1, unknownAt = -1, failOnce = false, nonCompensatableAt = -1, proofTtlMs = 60_000 } = {}) {
  let now = NOW;
  const clock = () => now;
  const claims = createClaimAuthority({ clock, maxTtlMs: 60 * 60 * 1000 });
  const claim = claims.acquireClaim({
    holderId: 'lane:saga',
    scope: [{ namespace: 'project:test', kind: 'operation', canonicalId: 'operation:test', ancestorIds: [], actions: ['apply'], resourceVersion: 'v1' }],
    ttlMs: 60 * 60 * 1000,
    policyRevisionId: 'policy:v1',
  });
  const binding = claims.bindingFor(claim);
  const states = new Map();
  const attempts = new Map();
  const adapters = {};
  const participants = [];
  for (let index = 0; index < count; index += 1) {
    const participantId = `participant:${index}`;
    const adapterId = `adapter:${index}`;
    states.set(participantId, `snapshot:${index}:v1`);
    adapters[adapterId] = {
      prepare: () => index === unknownAt
        ? ({ state: 'UNKNOWN' })
        : ({ state: 'SAFE', snapshotId: states.get(participantId), resourceVersion: 'v1' }),
      inspect: () => ({ state: index === unknownAt ? 'UNKNOWN' : 'SAFE', snapshotId: states.get(participantId) }),
      apply: () => {
        const attempt = (attempts.get(participantId) || 0) + 1;
        attempts.set(participantId, attempt);
        if (index === unknownAt) return { state: 'UNKNOWN' };
        if (index === failAt && (!failOnce || attempt === 1)) return { state: 'UNSAFE', errorCode: 'FIXTURE_FAIL' };
        return { state: 'SAFE', resultingState: `applied:${index}`, authoritySnapshotId: `authority:${index}`, expiresAt: '2026-08-08T12:00:00.000Z' };
      },
      compensate: () => ({ state: 'SAFE' }),
    };
    participants.push({
      participantId, adapterId, intendedEffect: `effect:${index}`, expectedState: `state:${index}`,
      fenceBindings: [binding], compensationMode: index === nonCompensatableAt ? 'NONE' : 'AUTOMATIC',
    });
  }
  const coordinator = createFencedSagaCoordinator({ adapters, claimAuthority: claims, proofTtlMs, clock });
  const plan = coordinator.planOperation({
    participants,
    recoveryPlan: { recoveryPlanId: 'recovery:test', steps: [], irreversibleParticipantIds: [], policyRevisionId: 'policy:v1' },
    policyRevisionId: 'policy:v1',
    authoritySnapshotId: 'authority:plan',
  });
  const prepare = coordinator.prepareOperation({ operationId: plan.operationId });
  const proof = prepare.state === 'PREPARED' ? coordinator.proveOperation({
    operationId: plan.operationId,
    policyAttestation: { state: 'SAFE', policyRevisionId: 'policy:v1', attestationId: 'attestation:one' },
  }) : null;
  return { coordinator, claims, binding, plan, prepare, proof, states, attempts, setNow: value => { now = value; } };
}

test('partial apply is preserved at every participant boundary without a false commit', () => {
  for (let failAt = 0; failAt < 3; failAt += 1) {
    const { coordinator, plan } = fixture({ failAt });
    const outcome = coordinator.applyOperation({ operationId: plan.operationId });
    assert.equal(outcome.state, failAt === 0 ? 'FAILED' : 'PARTIALLY_APPLIED');
    assert.equal(outcome.receipts.length, failAt);
    assert.equal(outcome.participantStates[`participant:${failAt}`], 'FAILED');
    assert.notEqual(outcome.state, 'COMMITTED');
  }
});

test('a non-compensatable effect remains explicit and requires operator recovery', () => {
  const { coordinator, plan } = fixture({ failAt: 2, nonCompensatableAt: 1 });
  const partial = coordinator.applyOperation({ operationId: plan.operationId });
  assert.equal(partial.state, 'PARTIALLY_APPLIED');
  const recovered = coordinator.recoverOperation({ operationId: plan.operationId, mode: 'COMPENSATE' });
  assert.equal(recovered.state, 'PARTIALLY_APPLIED');
  assert.ok(recovered.safeNextActions.includes('OPERATOR_RECOVERY_REQUIRED'));
});

test('a bounded recovery retry resumes only the missing participant and commits', () => {
  const { coordinator, plan, attempts } = fixture({ failAt: 1, failOnce: true });
  const partial = coordinator.applyOperation({ operationId: plan.operationId });
  assert.equal(partial.receipts.length, 1);
  const recovered = coordinator.recoverOperation({ operationId: plan.operationId, mode: 'RESUME' });
  assert.equal(recovered.state, 'COMMITTED');
  assert.equal(recovered.receipts.length, 3);
  assert.equal(attempts.get('participant:0'), 1);
  assert.equal(attempts.get('participant:1'), 2);
});

test('an unknown participant state remains UNKNOWN with its exact identity', () => {
  const { prepare } = fixture({ unknownAt: 1 });
  assert.equal(prepare.state, 'UNKNOWN');
  assert.deepEqual(prepare.unknownParticipantIds, ['participant:1']);
});

test('stale proof blocks apply before any participant side effect', () => {
  const item = fixture({ proofTtlMs: 1_000 });
  item.setNow('2026-08-07T12:00:02.000Z');
  assert.throws(() => item.coordinator.applyOperation({ operationId: item.plan.operationId }), error => error.code === 'VCS_PROOF_STALE');
  assert.equal(item.attempts.size, 0);
});

test('stale fence blocks apply before any participant side effect', () => {
  const item = fixture();
  item.claims.revokeClaim({ binding: item.binding, reason: 'cancel operation' });
  assert.throws(() => item.coordinator.applyOperation({ operationId: item.plan.operationId }), error => error.code === 'VCS_CLAIM_REVOKED');
  assert.equal(item.attempts.size, 0);
});

test('participant drift after prove blocks with an exact precondition failure', () => {
  const item = fixture();
  item.states.set('participant:1', 'snapshot:1:v2');
  const outcome = item.coordinator.applyOperation({ operationId: item.plan.operationId });
  assert.equal(outcome.state, 'PARTIALLY_APPLIED');
  assert.equal(outcome.receipts.length, 1);
  assert.equal(outcome.failures.at(-1).errorCode, 'VCS_SNAPSHOT_STALE');
});

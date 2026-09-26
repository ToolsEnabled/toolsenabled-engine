'use strict';

const assert = require('node:assert/strict');
const { CloudAgentSession } = require('../src/lib/cloud-agent/session');

const hex = character => character.repeat(64);

function requestInput() {
  return {
    schemaVersion: 1,
    provider: 'codex-cloud',
    environment: 'env-main',
    repository: { rootId: 'agent-mirror' },
    sourceRevision: 'a'.repeat(40),
    fileKeeperProof: { proofId: `proof-${'b'.repeat(20)}`, treeSha256: hex('c') },
    idempotencyKey: `idem-${'d'.repeat(20)}`,
    requiredModel: 'gpt-test-model',
    taskHash: hex('e'),
    pathAllowlist: ['src/**'],
    byteBudget: 4096,
    timeBudgetMs: 1000
  };
}

function providerResult(request, state, evidenceHashes = []) {
  return {
    schemaVersion: 1,
    requestHash: request.requestHash,
    providerTaskId: `task-${'f'.repeat(20)}`,
    requestedModel: request.requiredModel,
    servedModel: state === 'SUCCEEDED' ? request.requiredModel : null,
    state,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:01:00.000Z',
    evidenceHashes,
    artifactManifest: []
  };
}

function makeAdapter({ submitState = 'SUBMITTED', reconcileState = submitState, reconcileEvidence = [], inspect } = {}) {
  let request;
  const calls = { bind: 0, submit: 0, inspect: 0, reconcile: 0, fetch: 0 };
  const adapter = {
    async capabilities() {
      return { providerId: 'codex-cloud', models: ['gpt-test-model'], supportsCancel: false, maxByteBudget: 4096, maxTimeBudgetMs: 1000 };
    },
    async bindEnvironment(value) { calls.bind += 1; request = value; return { environmentRef: `envref-${'1'.repeat(20)}` }; },
    async submit() { calls.submit += 1; return providerResult(request, submitState); },
    async inspect() { calls.inspect += 1; return inspect ? inspect(request) : providerResult(request, reconcileState, reconcileEvidence); },
    async fetchChangeManifest() { calls.fetch += 1; return []; },
    async reconcile() { calls.reconcile += 1; return providerResult(request, reconcileState, reconcileEvidence); }
  };
  return { adapter, calls };
}

async function boundSession(options) {
  const fixture = makeAdapter(options);
  const session = new CloudAgentSession({ adapter: fixture.adapter });
  await session.bindEnvironment(requestInput());
  await session.submit();
  return { ...fixture, session };
}

(async () => {
  {
    const { session, calls } = await boundSession({ reconcileState: 'SUCCEEDED' });
    const refused = await session.reconcile();
    assert.equal(refused.blockedReason, 'EVIDENCE_MISSING');
    assert.equal(refused.reconciled, false);
    assert.equal(refused.canAdvance, false);
    assert.deepEqual(calls, { bind: 1, submit: 1, inspect: 0, reconcile: 1, fetch: 0 });
  }

  for (const terminalState of ['FAILED', 'CANCELLED']) {
    const { session, calls } = await boundSession({ reconcileState: terminalState });
    const refused = await session.reconcile();
    assert.equal(refused.blockedReason, 'NOT_SUCCEEDED');
    assert.equal(refused.reconciled, false);
    assert.equal(refused.canAdvance, false);
    assert.deepEqual(calls, { bind: 1, submit: 1, inspect: 0, reconcile: 1, fetch: 0 });
  }

  for (const nonterminalState of ['SUBMITTED', 'RUNNING']) {
    const { session, calls } = await boundSession({ reconcileState: nonterminalState });
    const refused = await session.reconcile();
    assert.equal(refused.blockedReason, 'NOT_TERMINAL');
    assert.equal(refused.reconciled, false);
    assert.equal(refused.canAdvance, false);
    assert.deepEqual(calls, { bind: 1, submit: 1, inspect: 0, reconcile: 1, fetch: 0 });
  }

  {
    const neverSettles = () => new Promise(() => {});
    let observations = 0;
    const { session, calls } = await boundSession({
      inspect(request) {
        observations += 1;
        return observations === 1 ? providerResult(request, 'SUCCEEDED', [hex('9')]) : neverSettles();
      }
    });
    await session.inspect();
    const before = session.snapshot();
    await assert.rejects(session.inspect(), error => {
      assert.equal(error.code, 'CLOUD_AGENT_OBSERVE_TIMEOUT');
      return true;
    });
    assert.deepEqual(session.snapshot(), before, 'a refused terminal observation must not replace state or result');
    assert.deepEqual(calls, { bind: 1, submit: 1, inspect: 2, reconcile: 0, fetch: 0 },
      'the refusal must not submit again, reconcile, or fetch/write a manifest');
  }

  console.log('cloud-agent session refusal tests passed: four caller-reachable refusal codes were driven');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

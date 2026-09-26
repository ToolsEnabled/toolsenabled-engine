// Mutation check: removed `this.#reconciled = false;` from #observe() in
// src/lib/cloud-agent/session.js, leaving prior reconciliation intact.
// The mutation landed: yes (the module's SHA-256 changed).
// This isolated test went red: yes, on the reconciliation-reset assertion.
// The module was then restored to its original SHA-256.

'use strict';

// Focused behavioural regression test for src/lib/cloud-agent/session.js.
// Run alone with: node tests/cloud-agent-session.test.js

const assert = require('node:assert/strict');

const { CloudAgentSession, assertAdapterShape } = require('../src/lib/cloud-agent/session');

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

function result(request, evidenceHashes, state = 'SUCCEEDED') {
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

(async () => {
  let boundRequest;
  const adapter = {
    async capabilities() {
      return { providerId: 'codex-cloud', models: ['gpt-test-model'], supportsCancel: false, maxByteBudget: 4096, maxTimeBudgetMs: 1000 };
    },
    async bindEnvironment(request) {
      boundRequest = request;
      return { environmentRef: `envref-${'1'.repeat(20)}` };
    },
    async submit(request) {
      return result(request, [], 'SUBMITTED');
    },
    async inspect() {
      return result(boundRequest, []);
    },
    async fetchChangeManifest() {
      return [];
    },
    async reconcile() {
      return result(boundRequest, [hex('2')]);
    }
  };

  assert.doesNotThrow(() => assertAdapterShape(adapter), 'the complete adapter value should be accepted');

  const session = new CloudAgentSession({ adapter });
  await session.bindEnvironment(requestInput());
  await session.submit();

  const reconciled = await session.reconcile();
  assert.equal(reconciled.reconciled, true, 'reconcile with evidence should earn reconciliation');
  assert.equal(reconciled.canAdvance, true, 'reconciled success should be advanceable');

  const inspected = await session.inspect();
  assert.equal(inspected.state, 'SUCCEEDED');
  assert.deepEqual(inspected.result.evidenceHashes, [], 'inspect should store the latest provider result');
  assert.equal(inspected.reconciled, false, 'a new observation must invalidate reconciliation earned on older evidence');
  assert.equal(inspected.canAdvance, false, 'the session must not advance on newly observed, unreconciled evidence');

  const reconciledAgain = await session.reconcile();
  assert.equal(reconciledAgain.reconciled, true, 'a fresh reconcile may earn the gate again');
  assert.equal(reconciledAgain.canAdvance, true);

  console.log('cloud-agent session test passed: a new observation invalidates reconciliation until fresh evidence is reconciled');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

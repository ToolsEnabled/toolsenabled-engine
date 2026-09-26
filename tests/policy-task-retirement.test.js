'use strict';

// Durable task retirement and approval consumption share one SQLite decision.
// No provider, prompt, process, or audit dependency is mocked or executed.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createStateStore, hashInput } = require('../src/lib/state-store');
const capability = require('../src/lib/capability-manifests');

function fixture() {
  let now = 1_800_000_000_000;
  const store = createStateStore({ file: ':memory:', clock: () => now });
  const task = store.submitTask({ queue: 'governance', type: 'scope-probe', idempotencyKey: 'one-task', payload: {
    title: 'Scoped governance probe', objective: 'Exercise stored state transitions without executing a handler.'
  } }).task;
  const compiled = capability.compileManifest({ profileId: 'governance.profile', version: 1, taskId: task.id, baseProfileId: 'scope-probe' }, {
    catalog: { tools: [{ name: 'host.exec', effect: 'local-write', approvalEligible: true,
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }] },
    configuration: { schemaVersion: 1, profiles: [{ id: 'scope-probe', tools: ['host.exec'], approvalRequiredActions: ['host.exec'], maxTtlMs: 60_000 }] },
    now: () => now
  });
  store.createCapabilityProfile({ manifest: compiled.manifest });
  const bound = capability.authorize(compiled.manifest, { revoked: false }, { taskId: task.id, tool: 'host.exec' }, { now });
  store.authorizeCapabilityProfileRequest({ requestId: 'request-governance-1', taskId: task.id, bindingKind: 'tool',
    profileId: compiled.manifest.profileId, profileVersion: 1, profileHash: compiled.manifestHash, requestHash: bound.requestHash, request: bound });
  const args = { command: 'fixture only; no handler invoked' };
  const authorizationId = 'authorization-governance-1';
  store.createPolicyDispatchAuthorization({ authorizationId, taskId: task.id, toolName: 'host.exec', argsHash: hashInput(args),
    targetKind: 'local', targetHash: hashInput('fixture-target'), provenance: null, risk: 'high', delegationDepth: 0,
    userKind: 'owner-authenticated', requestHash: bound.requestHash });
  store.recordScopedApprovalProvenance({ evidenceId: 'evidence-governance-1', taskId: task.id,
    provenance: { schemaVersion: '1.0.0', labels: ['trusted-user'], sources: [] } });
  const action = store.createScopedApprovalAction({ authorizationId, parameters: args,
    subject: { kind: 'owner-authenticated', idHash: hashInput('fixture-subject') }, provenanceEvidenceId: 'evidence-governance-1', expiresAtMs: now + 30_000 }).action;
  const tokenHash = hashInput('fixture-token');
  function approve() { return store.approveScopedApproval({ approvalId: action.approvalId, previewHash: action.previewHash, tokenHash }); }
  function consume(overrides = {}) { return store.consumeScopedApprovalDispatch({ authorizationId, toolName: 'host.exec', argsHash: hashInput(args), tokenHash, ...overrides }); }
  function state() { return store.getScopedApprovalAction({ approvalId: action.approvalId }).state; }
  return { store, task, compiled, action, approve, consume, state, advance: delta => { now += delta; } };
}

function arrangeTask(f, status) {
  if (status === 'cancelled') {
    f.store.cancelTask({ taskId: f.task.id, reason: 'owner cancelled the queued task' });
    return;
  }
  const claim = f.store.claimTask({ queue: 'governance', workerLabel: 'governance-worker', leaseMs: 60_000 });
  f.store.startTask(claim.handle);
  if (status === 'cancel-requested') f.store.cancelTask({ taskId: f.task.id, reason: 'owner stopped the running task' });
  else if (status === 'succeeded') f.store.completeTask(claim.handle, { result: { complete: true } });
  else f.store.failTask(claim.handle, { disposition: status, code: 'FIXTURE_TASK_RETIRED' });
}

for (const kind of ['scoped', 'legacy']) {
  function consume(f) {
    return kind === 'scoped' ? f.consume() : f.store.consumePolicyDispatchAuthorization({
      authorizationId: 'authorization-governance-1', toolName: 'host.exec',
      argsHash: hashInput({ command: 'fixture only; no handler invoked' })
    });
  }
  test(`${kind} authorization consumes once while its task remains active`, t => {
    const f = fixture();
    t.after(() => f.store.close());
    f.approve();
    assert.equal(consume(f).taskId, f.task.id);
    assert.throws(() => consume(f), { code: kind === 'scoped' ? 'APPROVAL_ALREADY_USED' : 'POLICY_AUTHORIZATION_REPLAYED' });
  });
  for (const status of ['cancelled', 'cancel-requested', 'succeeded', 'failed', 'uncertain']) {
    test(`${kind} authorization refuses a ${status} task without recording consumption`, t => {
      const f = fixture();
      t.after(() => f.store.close());
      f.approve();
      arrangeTask(f, status);
      assert.throws(() => consume(f), { code: 'POLICY_TASK_INACTIVE' });
      const count = f.store.transaction(db => db.prepare('SELECT COUNT(*) AS count FROM policy_dispatch_consumptions').get().count);
      assert.equal(count, 0, 'refusal cannot leave a dispatch consumption behind');
      if (kind === 'scoped') assert.equal(f.state(), 'cancelled', 'scope retirement must persist before returning the refusal');
    });
  }
}

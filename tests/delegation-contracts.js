'EXECUTABLE CHANGE';
'use strict';

/*
Report: testcanfail-tests-delegation-contracts-js

Strengthened assertions and mutation evidence:
- Delegated-task rejection case census: temporarily changed
  src/lib/delegation-contracts.js to omit the unknown-key rejection. The test
  went RED with "AssertionError [ERR_ASSERTION]: Missing expected exception:
  expected DELEGATION_CONTRACT_INVALID". The source was restored byte-for-byte.
- Enforcement binding case census: temporarily changed
  src/lib/delegation-enforcement.js so the task-id comparison accepted a
  mismatched task id. The test went RED with "AssertionError [ERR_ASSERTION]:
  expected DELEGATION_ENFORCEMENT_TASK_STALE" (actual code:
  DELEGATION_ENFORCEMENT_PROFILE_MISMATCH). The source was restored
  byte-for-byte.
- Controller-reader case census: temporarily changed
  src/lib/delegation-enforcement.js so a readTask exception was not normalized.
  The test went RED with "AssertionError [ERR_ASSERTION]: expected
  DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE" (actual error: "mutated
  controller reader error"). The source was restored byte-for-byte.

NOT-FOUND: exit-status/truthy-return assertions based only on child output;
try/catch or optional-chain failure swallowing; mocks of the subject; skip or
platform precondition guards; expected values computed by the implementation.
REPORTED (not removed or weakened): `assert.ok(label)` in the enforcement loop
only checks this test's non-empty string literal and is not product evidence;
the preceding typed-error assertion is the product check, while the new exact
case census prevents that check from disappearing through an empty/incomplete
collection.
Preconditions not met: the default Node.js v20.20.2 lacks `node:sqlite`; all
mutation and restoration runs therefore used Node.js v22.22.2.

Restoration confirmation:
`/root/.nvm/versions/node/v22.22.2/bin/node tests/delegation-contracts.js` was
GREEN with "Provider-neutral delegation contract tests passed."
*/

const assert = require('node:assert/strict');
const fs = require('node:fs');
const contracts = require('../src/lib/delegation-contracts');
const enforcement = require('../src/lib/delegation-enforcement');
const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
const generator = require('../tools/generate-delegation-contract-schema');

const h = char => char.repeat(64);
const commit = char => char.repeat(40);
const delegationId = `dlg_${'A'.repeat(16)}`;
const snapshot = { rootId: 'sample-provider', commitSha1: commit('a'), treeSha256: h('b') };
const task = {
  schemaVersion: 1, delegationId, goalId: 'sample-provider-release', phaseId: 'release-candidate', role: 'read_only_review', baseSnapshot: snapshot,
  acceptanceCriteria: ['artifact-verified', 'tests-green'], capabilityProfileHash: h('c'),
  budgets: { maxWallMs: 120000, maxModelTokens: 10000, maxToolCalls: 12, maxEvidenceBytes: 4096 }, terminalStates: ['complete', 'blocked', 'failed']
};
const result = {
  schemaVersion: 1, workerResultId: `wrk_${'B'.repeat(16)}`, delegationId, attempt: 1, terminalState: 'complete', baseSnapshot: snapshot,
  capabilityProfileHash: h('c'), artifacts: [{ kind: 'report', sha256: h('d'), sizeBytes: 100 }],
  verification: { state: 'passed', criterionIds: ['artifact-verified', 'tests-green'], evidenceRefs: ['evidence.receipt-01'] },
  blockerCode: null, usage: { modelTokens: 50, toolCalls: 1, wallMs: 1000, usageRecordRefs: ['usage.receipt-01'] }, brokerAcceptanceState: 'UNACCEPTED'
};
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function code(operation, expected) { assert.throws(operation, error => error && error.code === expected, `expected ${expected}`); }

(() => {
  const normalizedTask = contracts.validateDelegatedTask(task);
  const normalizedResult = contracts.validateWorkerResult(result);
  assert.equal(normalizedTask.contractHash, contracts.validateDelegatedTask(clone(task)).contractHash, 'contract hashes must be deterministic');
  assert.equal(Object.isFrozen(normalizedTask), true);
  assert.equal(normalizedResult.brokerAcceptanceState, 'UNACCEPTED');
  assert.deepEqual(contracts.assertResultForTask(task, result).acceptedByBroker, false, 'worker complete must never become broker acceptance');

  const bundle = contracts.validateEvidenceBundle({
    schemaVersion: 1, bundleId: `evb_${'C'.repeat(16)}`, delegationId, workerResultHash: normalizedResult.contractHash,
    records: [{ ref: 'evidence.receipt-01', sha256: h('e'), sizeBytes: 50, kind: 'verification' }]
  });
  assert.match(bundle.contractHash, /^[a-f0-9]{64}$/);
  const escalation = contracts.validateEscalationPacket({
    schemaVersion: 1, escalationId: `esc_${'D'.repeat(16)}`, delegationId, disputedDecisionCode: 'verification-conflict',
    verifiedFactRefs: ['evidence.receipt-01'], failedCriteria: ['tests-green'], evidenceBundleHash: bundle.contractHash, requestedDecision: 'resolve_evidence'
  });
  assert.match(escalation.contractHash, /^[a-f0-9]{64}$/);

  const delegatedTaskRejectionCases = [
    ['unknown field', value => { value.privateTranscript = 'hidden'; }],
    ['secret-shaped goal', value => { value.goalId = 'Bearer secret-token'; }],
    ['raw browser field', value => { value.browserCookie = 'cookie'; }],
    ['unbounded budget', value => { value.budgets.maxWallMs = 86400001; }]
  ];
  assert.deepEqual(delegatedTaskRejectionCases.map(([label]) => label),
    ['unknown field', 'secret-shaped goal', 'raw browser field', 'unbounded budget'],
    'delegated-task rejection cases must not silently become empty or incomplete');
  for (const [label, mutate] of delegatedTaskRejectionCases) {
    const invalid = clone(task); mutate(invalid); code(() => contracts.validateDelegatedTask(invalid), 'DELEGATION_CONTRACT_INVALID');
  }
  const claimedAcceptance = clone(result); claimedAcceptance.brokerAcceptanceState = 'ACCEPTED'; code(() => contracts.validateWorkerResult(claimedAcceptance), 'DELEGATION_CONTRACT_INVALID');
  const stale = clone(result); stale.baseSnapshot.commitSha1 = commit('f'); code(() => contracts.assertResultForTask(task, stale), 'DELEGATION_CONTRACT_STALE_OR_MISMATCHED');
  const exceeded = clone(result); exceeded.usage.modelTokens = task.budgets.maxModelTokens + 1; code(() => contracts.assertResultForTask(task, exceeded), 'DELEGATION_CONTRACT_BUDGET_EXCEEDED');
  const unauthorizedCriterion = clone(result); unauthorizedCriterion.verification.criterionIds.push('unknown-criterion'); code(() => contracts.assertResultForTask(task, unauthorizedCriterion), 'DELEGATION_CONTRACT_CRITERION_DENIED');
  const rawEscalation = { schemaVersion: 1, escalationId: `esc_${'D'.repeat(16)}`, delegationId, disputedDecisionCode: 'verification-conflict', verifiedFactRefs: ['evidence.receipt-01'], failedCriteria: [], evidenceBundleHash: h('f'), requestedDecision: 'resolve_evidence', rawDiff: 'not allowed' };
  code(() => contracts.validateEscalationPacket(rawEscalation), 'DELEGATION_CONTRACT_INVALID');

  // Every JavaScript entry point must enforce the same closed shape promised
  // by the generated JSON Schema without invoking caller-controlled getters.
  const hiddenTask = clone(task);
  Object.defineProperty(hiddenTask, 'privateTranscript', { value: 'hidden', enumerable: false });
  code(() => contracts.validateDelegatedTask(hiddenTask), 'DELEGATION_CONTRACT_INVALID');

  const symbolTask = clone(task);
  symbolTask[Symbol('ambient-authority')] = true;
  code(() => contracts.validateDelegatedTask(symbolTask), 'DELEGATION_CONTRACT_INVALID');

  let taskGetterCalls = 0;
  const accessorTask = clone(task);
  Object.defineProperty(accessorTask, 'goalId', {
    enumerable: true,
    get() { taskGetterCalls += 1; return task.goalId; }
  });
  code(() => contracts.validateDelegatedTask(accessorTask), 'DELEGATION_CONTRACT_INVALID');
  assert.equal(taskGetterCalls, 0, 'task accessors must be rejected without invocation');

  const hiddenBudget = clone(task);
  Object.defineProperty(hiddenBudget.budgets, 'unmeteredCalls', { value: 1, enumerable: false });
  code(() => contracts.validateDelegatedTask(hiddenBudget), 'DELEGATION_CONTRACT_INVALID');

  let criterionGetterCalls = 0;
  const accessorCriteria = clone(task);
  Object.defineProperty(accessorCriteria.acceptanceCriteria, '0', {
    configurable: true,
    enumerable: true,
    get() { criterionGetterCalls += 1; return 'artifact-verified'; }
  });
  code(() => contracts.validateDelegatedTask(accessorCriteria), 'DELEGATION_CONTRACT_INVALID');
  assert.equal(criterionGetterCalls, 0, 'array accessors must be rejected without invocation');

  const symbolCriteria = clone(task);
  symbolCriteria.acceptanceCriteria[Symbol('hidden-criterion')] = 'authority';
  code(() => contracts.validateDelegatedTask(symbolCriteria), 'DELEGATION_CONTRACT_INVALID');

  let proxyGets = 0;
  const proxyTask = new Proxy(clone(task), {
    get() { proxyGets += 1; throw new Error('top-level get trap must not run'); }
  });
  assert.equal(contracts.validateDelegatedTask(proxyTask).goalId, task.goalId);
  assert.equal(proxyGets, 0, 'valid proxy-backed objects must be read from data descriptors');

  let arrayProxyGets = 0;
  const proxyCriteriaTask = clone(task);
  proxyCriteriaTask.acceptanceCriteria = new Proxy([...task.acceptanceCriteria], {
    get() { arrayProxyGets += 1; throw new Error('array get trap must not run'); }
  });
  assert.deepEqual(contracts.validateDelegatedTask(proxyCriteriaTask).acceptanceCriteria,
    ['artifact-verified', 'tests-green']);
  assert.equal(arrayProxyGets, 0, 'valid proxy-backed arrays must be read from data descriptors');

  code(() => contracts.validateDelegatedTask(new Proxy(clone(task), {
    getPrototypeOf() { throw new Error('Bearer prototype trap'); }
  })), 'DELEGATION_CONTRACT_INVALID');
  code(() => contracts.validateDelegatedTask(new Proxy(clone(task), {
    ownKeys() { throw new Error('OTP ownKeys trap'); }
  })), 'DELEGATION_CONTRACT_INVALID');

  let digestGetterCalls = 0;
  const accessorDigest = {};
  Object.defineProperty(accessorDigest, 'value', {
    enumerable: true,
    get() { digestGetterCalls += 1; return 'unsafe'; }
  });
  code(() => contracts.digest('test', accessorDigest), 'DELEGATION_CONTRACT_INVALID');
  assert.equal(digestGetterCalls, 0, 'digest accessors must be rejected without invocation');

  generator.generate({ check: true });
  const schema = JSON.parse(fs.readFileSync(generator.OUTPUT, 'utf8'));
  assert.equal(schema.$id, 'urn:toolsenabled:delegation-contracts:1.0.0');
  assert.equal(schema.$defs.WorkerResult.properties.brokerAcceptanceState.const, 'UNACCEPTED');

  // Q21/P2: the controller must re-bind every action to the exact task,
  // snapshot, profile, actor lane, command/tool schema, expiry, and fence.
  // This is a pure authorizer test: it must not register a worker authority.
  const now = 1_000_000;
  const taskId = `task-${'E'.repeat(8)}`;
  const scopeId = `ctx_${'1'.repeat(32)}`;
  const binding = {
    delegationId,
    taskId,
    actor: 'gemini',
    providerAdapter: 'gemini-subscription-cli',
    rootId: snapshot.rootId,
    rootHash: snapshot.treeSha256,
    baseSnapshot: clone(snapshot),
    capabilityProfileHash: h('c'),
    toolSchemas: [{ name: 'memory.search', schemaHash: h('d') }],
    commandIds: ['inspect.readonly'],
    scopeId,
    expiresAtMs: now + 60_000,
    profileExpiresAtMs: now + 120_000,
    fence: 7
  };
  const profile = {
    taskId,
    delegationId,
    actor: 'gemini',
    providerAdapter: 'gemini-subscription-cli',
    rootId: snapshot.rootId,
    rootHash: snapshot.treeSha256,
    baseSnapshot: clone(snapshot),
    profileHash: h('c'),
    toolSchemas: [{ name: 'memory.search', schemaHash: h('d') }],
    commandIds: ['inspect.readonly'],
    scopeId,
    expiresAtMs: now + 120_000,
    fence: 7
  };
  const currentTask = {
    taskId,
    status: 'running',
    delegationId,
    capabilityProfileHash: h('c'),
    baseSnapshot: clone(snapshot)
  };
  const deps = { now, readTask: () => currentTask, readProfile: () => profile, readFence: () => 7 };
  const receipt = enforcement.enforceDelegation({
    task,
    binding: clone(binding),
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
  }, deps);
  assert.equal(receipt.status, 'authorized');
  assert.equal(receipt.grantsAuthority, false);
  assert.match(receipt.receiptHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(receipt, 'secret'), false);

  const hiddenRequest = {
    task,
    binding: clone(binding),
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
  };
  Object.defineProperty(hiddenRequest, 'ambientAuthority', { value: true, enumerable: false });
  code(() => enforcement.enforceDelegation(hiddenRequest, deps), 'DELEGATION_ENFORCEMENT_INVALID');

  const symbolBinding = clone(binding);
  symbolBinding[Symbol('hidden-command')] = 'unsafe';
  code(() => enforcement.enforceDelegation({
    task,
    binding: symbolBinding,
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
  }, deps), 'DELEGATION_ENFORCEMENT_INVALID');

  let actionGetterCalls = 0;
  const accessorAction = { kind: 'tool', toolSchemaHash: h('d') };
  Object.defineProperty(accessorAction, 'toolName', {
    enumerable: true,
    get() { actionGetterCalls += 1; return 'memory.search'; }
  });
  code(() => enforcement.enforceDelegation({ task, binding: clone(binding), action: accessorAction }, deps),
    'DELEGATION_ENFORCEMENT_INVALID');
  assert.equal(actionGetterCalls, 0, 'enforcement action getters must not run');

  let toolSchemaGetterCalls = 0;
  const accessorToolSchemas = clone(binding);
  Object.defineProperty(accessorToolSchemas.toolSchemas, '0', {
    configurable: true,
    enumerable: true,
    get() { toolSchemaGetterCalls += 1; return binding.toolSchemas[0]; }
  });
  code(() => enforcement.enforceDelegation({
    task,
    binding: accessorToolSchemas,
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
  }, deps), 'DELEGATION_ENFORCEMENT_INVALID');
  assert.equal(toolSchemaGetterCalls, 0, 'enforcement array getters must not run');

  let requestProxyGets = 0;
  const proxyRequest = new Proxy({
    task,
    binding: clone(binding),
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
  }, { get() { requestProxyGets += 1; throw new Error('request get trap must not run'); } });
  assert.equal(enforcement.enforceDelegation(proxyRequest, deps).status, 'authorized');
  assert.equal(requestProxyGets, 0, 'valid enforcement proxies must be read from descriptors');

  let dependencyProxyGets = 0;
  const proxyDependencies = new Proxy({ ...deps }, {
    get() { dependencyProxyGets += 1; throw new Error('dependency get trap must not run'); }
  });
  assert.equal(enforcement.enforceDelegation({
    task,
    binding: clone(binding),
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
  }, proxyDependencies).status, 'authorized');
  assert.equal(dependencyProxyGets, 0, 'valid dependency proxies must be read from descriptors');

  let taskSnapshotProxyGets = 0;
  const proxyCurrentTask = new Proxy({ ...currentTask }, {
    get() { taskSnapshotProxyGets += 1; throw new Error('task snapshot get trap must not run'); }
  });
  assert.equal(enforcement.enforceDelegation({
    task,
    binding: clone(binding),
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
  }, { ...deps, readTask: () => proxyCurrentTask }).status, 'authorized');
  assert.equal(taskSnapshotProxyGets, 0, 'controller task snapshots must be read from descriptors');

  let taskStatusGetterCalls = 0;
  const accessorCurrentTask = { ...currentTask };
  Object.defineProperty(accessorCurrentTask, 'status', {
    enumerable: true,
    get() { taskStatusGetterCalls += 1; return 'running'; }
  });
  code(() => enforcement.enforceDelegation({
    task,
    binding: clone(binding),
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
  }, { ...deps, readTask: () => accessorCurrentTask }), 'DELEGATION_ENFORCEMENT_INVALID');
  assert.equal(taskStatusGetterCalls, 0, 'controller task snapshot getters must not run');

  const enforcementBindingRejectionCases = [
    ['task mismatch', value => { value.taskId = `other-${'F'.repeat(8)}`; }, 'DELEGATION_ENFORCEMENT_TASK_STALE'],
    ['provider mismatch', value => { value.actor = 'claude'; }, 'DELEGATION_ENFORCEMENT_PROVIDER_DENIED'],
    ['root mismatch', value => { value.rootHash = h('f'); }, 'DELEGATION_ENFORCEMENT_ROOT_MISMATCH'],
    ['snapshot mismatch', value => { value.baseSnapshot.commitSha1 = commit('f'); }, 'DELEGATION_ENFORCEMENT_SNAPSHOT_MISMATCH'],
    ['expired binding', value => { value.expiresAtMs = now - 1; }, 'DELEGATION_ENFORCEMENT_EXPIRED'],
    ['stale fence', value => { value.fence = 8; }, 'DELEGATION_ENFORCEMENT_FENCE_STALE'],
    ['profile tool allowlist mismatch', value => { value.commandIds = ['other.command']; }, 'DELEGATION_ENFORCEMENT_PROFILE_MISMATCH'],
    ['profile mismatch', value => { value.capabilityProfileHash = h('e'); }, 'DELEGATION_ENFORCEMENT_PROFILE_MISMATCH']
  ];
  assert.deepEqual(enforcementBindingRejectionCases.map(([label]) => label), [
    'task mismatch', 'provider mismatch', 'root mismatch', 'snapshot mismatch',
    'expired binding', 'stale fence', 'profile tool allowlist mismatch', 'profile mismatch'
  ], 'enforcement binding rejection cases must not silently become empty or incomplete');
  for (const [label, mutate, expected] of enforcementBindingRejectionCases) {
    const invalid = clone(binding);
    mutate(invalid);
    code(() => enforcement.enforceDelegation({
      task,
      binding: invalid,
      action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
    }, deps), expected);
    assert.ok(label);
  }
  const queuedTask = { ...currentTask, status: 'queued' };
  code(() => enforcement.enforceDelegation({
    task,
    binding: clone(binding),
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
  }, { ...deps, readTask: () => queuedTask }), 'DELEGATION_ENFORCEMENT_TASK_STALE');
  code(() => enforcement.enforceDelegation({
    task,
    binding: clone(binding),
    action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('e') }
  }, deps), 'DELEGATION_ENFORCEMENT_TOOL_SCHEMA_DENIED');

  // Controller reader errors are fail-closed and must not disclose a provider
  // or task error message through the gateway's typed contract.
  const failingControllerReaders = ['readTask', 'readProfile', 'readFence'];
  assert.deepEqual(failingControllerReaders, ['readTask', 'readProfile', 'readFence'],
    'controller-reader rejection cases must not silently become empty or incomplete');
  for (const reader of failingControllerReaders) {
    code(() => enforcement.enforceDelegation({
      task,
      binding: clone(binding),
      action: { kind: 'tool', toolName: 'memory.search', toolSchemaHash: h('d') }
    }, { ...deps, [reader]: () => { throw new Error('Bearer private-token must not escape'); } }), 'DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE');
  }

  const access = enforcement.evidenceAccess(binding);
  const authorizeEvidence = enforcement.createEvidenceAuthorizer(binding, { now: () => now + 1, readFence: () => 7 });
  assert.equal(authorizeEvidence({ operation: 'write', access, binding: { taskId, scopeId } }), true);
  assert.equal(authorizeEvidence({ operation: 'read-public', access, binding: { taskId, scopeId } }), true);
  assert.equal(authorizeEvidence({ operation: 'read-protected', access, binding: { taskId, scopeId } }), false);

  const hiddenEvidenceRequest = { operation: 'write', access, binding: { taskId, scopeId } };
  Object.defineProperty(hiddenEvidenceRequest, 'approvalToken', { value: 'hidden', enumerable: false });
  code(() => authorizeEvidence(hiddenEvidenceRequest), 'DELEGATION_ENFORCEMENT_INVALID');

  let evidenceGetterCalls = 0;
  const accessorEvidenceRequest = { access, binding: { taskId, scopeId } };
  Object.defineProperty(accessorEvidenceRequest, 'operation', {
    enumerable: true,
    get() { evidenceGetterCalls += 1; return 'write'; }
  });
  code(() => authorizeEvidence(accessorEvidenceRequest), 'DELEGATION_ENFORCEMENT_INVALID');
  assert.equal(evidenceGetterCalls, 0, 'evidence authorization getters must not run');

  let evidenceProxyGets = 0;
  const proxyEvidenceRequest = new Proxy({ operation: 'write', access, binding: { taskId, scopeId } }, {
    get() { evidenceProxyGets += 1; throw new Error('evidence request get trap must not run'); }
  });
  assert.equal(authorizeEvidence(proxyEvidenceRequest), true);
  assert.equal(evidenceProxyGets, 0, 'valid evidence request proxies must be read from descriptors');

  let evidenceDependencyGetterCalls = 0;
  const accessorEvidenceDependencies = { readFence: () => 7 };
  Object.defineProperty(accessorEvidenceDependencies, 'now', {
    enumerable: true,
    get() { evidenceDependencyGetterCalls += 1; return () => now + 1; }
  });
  code(() => enforcement.createEvidenceAuthorizer(binding, accessorEvidenceDependencies),
    'DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE');
  assert.equal(evidenceDependencyGetterCalls, 0, 'evidence dependency getters must not run');

  assert.equal(authorizeEvidence({ operation: 'write', access: { ...access, scopeId: `ctx_${'2'.repeat(32)}` }, binding: { taskId, scopeId } }), false);
  assert.equal(enforcement.createEvidenceAuthorizer(binding, { now: () => binding.expiresAtMs, readFence: () => 7 })({ operation: 'write', access, binding: { taskId, scopeId } }), false);
  code(() => enforcement.createEvidenceAuthorizer(binding, { now: () => now + 1, readFence: () => { throw new Error('OTP must not escape'); } })({ operation: 'write', access, binding: { taskId, scopeId } }), 'DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE');
  code(() => enforcement.createEvidenceAuthorizer(binding, { now: () => { throw new Error('private browser content'); }, readFence: () => 7 })({ operation: 'write', access, binding: { taskId, scopeId } }), 'DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE');
  assert.equal(TOOL_REGISTRY.some(tool => tool.name.startsWith('delegation.')), false, 'no delegation.* MCP authority may be registered');
  console.log('Provider-neutral delegation contract tests passed.');
})();

// EXECUTABLE CHANGE
/*
Report: testcanfail-tests-delegation-readonly-qualification-js

Strengthened assertions and mutation evidence:
- The receipt.workerResultHash expectation was computed by
  contracts.validateWorkerResult(result()), the same contract implementation
  used by qualifyReadonlyReview. Mutation: changed the contract digest domain
  from HASH_DOMAIN to `${HASH_DOMAIN}-MUTATED`. Before this change the test
  remained green: "Delegation read-only qualification tests passed (25 checks)."
  With the fixed literal oracle it failed red with:
  "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal"
  and actual workerResultHash
  "bbb9a2c4cecde138281cfa2738a7e93b3728b5d7facd3002222de0501785c7c2"
  instead of
  "0613dfffc35527554340bb98705464c3467e0a181d0fddaed7c135c9a956d06a".
- The receipt.evidenceBundleHash expectation was computed by
  contracts.validateEvidenceBundle(bundle()), again the same contract
  implementation used by qualifyReadonlyReview. The same mutation changes the
  actual value to
  "71cf2321b06c136791b68405184d6a2d4c78b0c25218ce2887c1368617fec6ee";
  the single deep-equality assertion reports the earlier workerResultHash
  mismatch first. Its independent literal expected value is
  "7253ac1b8cbf93bd92d379cc2e7376469bd94f0d74d8c5e8404650309e44f27e".

Shape census:
- Empty loop/forEach assertion body: NOT-FOUND.
- Exit-status or truthy-return assertion without own-output evidence: NOT-FOUND.
- try/catch or optional-chain swallowing the failure under test: NOT-FOUND.
- Assertion against a mock of the subject under test: NOT-FOUND. The injected
  controller readers are collaborators, not qualifyReadonlyReview itself.
- Skip or platform precondition guard: NOT-FOUND.
- Expected value computed by the same code under test: FOUND and fixed for both
  receipt hashes as documented above.

Restoration and final run:
- src/lib/delegation-contracts.js was restored byte-for-byte (verified with
  cmp). No precondition was unmet.
- Final green output: "Delegation read-only qualification tests passed (25 checks)."
*/
'use strict';

const assert = require('node:assert/strict');
const contracts = require('../src/lib/delegation-contracts');
const { qualifyReadonlyReview } = require('../src/lib/delegation-readonly-qualification');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const COMMIT = 'd'.repeat(40);
const NOW = 1_800_000_000_000;
const delegationId = `dlg_${'A'.repeat(20)}`;
const workerResultId = `wrk_${'B'.repeat(20)}`;
const bundleId = `evb_${'C'.repeat(20)}`;
const taskId = 'task-q21-readonly';
const scopeId = `ctx_${'D'.repeat(32)}`;
const snapshot = { rootId: 'toolsenabled', commitSha1: COMMIT, treeSha256: HASH_A };

function task(overrides = {}) {
  return {
    schemaVersion: 1,
    delegationId,
    goalId: 'goal-q21',
    phaseId: 'phase-q21',
    role: 'read_only_review',
    baseSnapshot: { ...snapshot },
    acceptanceCriteria: ['criterion-one', 'criterion-two'],
    capabilityProfileHash: HASH_B,
    budgets: { maxWallMs: 10_000, maxModelTokens: 100, maxToolCalls: 0, maxEvidenceBytes: 4096 },
    terminalStates: ['complete'],
    ...overrides
  };
}

function binding(overrides = {}) {
  return {
    delegationId,
    taskId,
    actor: 'gemini',
    providerAdapter: 'gemini-subscription-cli',
    rootId: 'toolsenabled',
    rootHash: HASH_A,
    baseSnapshot: { ...snapshot },
    capabilityProfileHash: HASH_B,
    toolSchemas: [],
    commandIds: [],
    scopeId,
    expiresAtMs: NOW + 60_000,
    profileExpiresAtMs: NOW + 60_000,
    fence: 7,
    ...overrides
  };
}

function result(overrides = {}) {
  return {
    schemaVersion: 1,
    workerResultId,
    delegationId,
    attempt: 1,
    terminalState: 'complete',
    baseSnapshot: { ...snapshot },
    capabilityProfileHash: HASH_B,
    artifacts: [{ kind: 'report', sha256: HASH_C, sizeBytes: 12 }],
    verification: { state: 'passed', criterionIds: ['criterion-one', 'criterion-two'], evidenceRefs: ['evidence:one'] },
    blockerCode: null,
    usage: { modelTokens: 10, toolCalls: 0, wallMs: 100, usageRecordRefs: [] },
    brokerAcceptanceState: 'UNACCEPTED',
    ...overrides
  };
}

function bundle(workerResult = result(), overrides = {}) {
  const normalized = contracts.validateWorkerResult(workerResult);
  return {
    schemaVersion: 1,
    bundleId,
    delegationId,
    workerResultHash: normalized.contractHash,
    records: [{ ref: 'evidence:one', sha256: HASH_C, sizeBytes: 12, kind: 'verification' }],
    ...overrides
  };
}

function dependencies(options = {}) {
  const currentTask = options.currentTask || {
    taskId,
    status: 'running',
    cancellationRequested: false,
    delegationId,
    capabilityProfileHash: HASH_B,
    baseSnapshot: { ...snapshot }
  };
  const profile = options.profile || {
    taskId,
    delegationId,
    actor: 'gemini',
    providerAdapter: 'gemini-subscription-cli',
    rootId: 'toolsenabled',
    rootHash: HASH_A,
    baseSnapshot: { ...snapshot },
    profileHash: HASH_B,
    toolSchemas: [],
    commandIds: [],
    scopeId,
    expiresAtMs: NOW + 60_000,
    fence: 7
  };
  let fenceReads = 0;
  return {
    now: options.now || (() => NOW),
    readTask: options.readTask || (() => currentTask),
    readProfile: options.readProfile || (() => profile),
    readFence: options.readFence || (() => { fenceReads += 1; return options.secondFence && fenceReads > 1 ? options.secondFence : 7; })
  };
}

function input(overrides = {}) {
  const workerResult = overrides.workerResult || result();
  return {
    task: overrides.task || task(),
    binding: overrides.binding || binding(),
    workerResult,
    evidenceBundle: Object.hasOwn(overrides, 'evidenceBundle') ? overrides.evidenceBundle : bundle(workerResult)
  };
}

function rejects(label, candidate, deps, code) {
  assert.throws(() => qualifyReadonlyReview(candidate, deps), error => error && error.code === code, label);
}

const receipt = qualifyReadonlyReview(input(), dependencies());
assert.deepEqual(receipt, {
  schemaVersion: 1,
  status: 'qualified_read_only_candidate',
  delegationId,
  taskId,
  capabilityProfileHash: HASH_B,
  workerResultHash: '0613dfffc35527554340bb98705464c3467e0a181d0fddaed7c135c9a956d06a',
  evidenceBundleHash: '7253ac1b8cbf93bd92d379cc2e7376469bd94f0d74d8c5e8404650309e44f27e',
  fence: 7,
  expiresAtMs: NOW + 60_000,
  acceptanceState: 'UNACCEPTED',
  grantsAuthority: false
});
assert.ok(Object.isFrozen(receipt));

const hiddenInput = input();
Object.defineProperty(hiddenInput, 'ambientAuthority', { value: true, enumerable: false });
rejects('hidden qualification field', hiddenInput, dependencies(), 'DELEGATION_READONLY_INVALID');

const symbolInput = input();
symbolInput[Symbol('hidden-scope')] = 'unsafe';
rejects('Symbol qualification field', symbolInput, dependencies(), 'DELEGATION_READONLY_INVALID');

let inputGetterCalls = 0;
const accessorInput = input();
Object.defineProperty(accessorInput, 'task', {
  enumerable: true,
  get() { inputGetterCalls += 1; return task(); }
});
rejects('qualification accessor', accessorInput, dependencies(), 'DELEGATION_READONLY_INVALID');
assert.equal(inputGetterCalls, 0, 'qualification request getters must not run');

let inputProxyGets = 0;
const proxyInput = new Proxy(input(), {
  get() { inputProxyGets += 1; throw new Error('qualification get trap must not run'); }
});
assert.equal(qualifyReadonlyReview(proxyInput, dependencies()).status, 'qualified_read_only_candidate');
assert.equal(inputProxyGets, 0, 'valid qualification proxies must be read from descriptors');

let dependencyGetterCalls = 0;
const accessorDependencies = dependencies();
Object.defineProperty(accessorDependencies, 'now', {
  enumerable: true,
  get() { dependencyGetterCalls += 1; return () => NOW; }
});
rejects('dependency accessor', input(), accessorDependencies, 'DELEGATION_READONLY_CONTROLLER_UNAVAILABLE');
assert.equal(dependencyGetterCalls, 0, 'qualification dependency getters must not run');

let dependencyProxyGets = 0;
const proxyDependencies = new Proxy(dependencies(), {
  get() { dependencyProxyGets += 1; throw new Error('dependency get trap must not run'); }
});
assert.equal(qualifyReadonlyReview(input(), proxyDependencies).status, 'qualified_read_only_candidate');
assert.equal(dependencyProxyGets, 0, 'valid dependency proxies must be read from descriptors');

let taskGetterCalls = 0;
const accessorCurrentTask = {
  taskId,
  cancellationRequested: false,
  delegationId,
  capabilityProfileHash: HASH_B,
  baseSnapshot: { ...snapshot }
};
Object.defineProperty(accessorCurrentTask, 'status', {
  enumerable: true,
  get() { taskGetterCalls += 1; return 'running'; }
});
rejects('controller task accessor', input(), dependencies({ currentTask: accessorCurrentTask }),
  'DELEGATION_READONLY_INVALID');
assert.equal(taskGetterCalls, 0, 'controller task getters must not run');

let taskProxyGets = 0;
const proxyCurrentTask = new Proxy({
  taskId,
  status: 'running',
  cancellationRequested: false,
  delegationId,
  capabilityProfileHash: HASH_B,
  baseSnapshot: { ...snapshot }
}, { get() { taskProxyGets += 1; throw new Error('controller task get trap must not run'); } });
assert.equal(qualifyReadonlyReview(input(), dependencies({ currentTask: proxyCurrentTask })).status,
  'qualified_read_only_candidate');
assert.equal(taskProxyGets, 0, 'valid controller task proxies must be read from descriptors');

let snapshotGetterCalls = 0;
const accessorSnapshotTask = {
  taskId,
  status: 'running',
  cancellationRequested: false,
  delegationId,
  capabilityProfileHash: HASH_B,
  baseSnapshot: { commitSha1: COMMIT, treeSha256: HASH_A }
};
Object.defineProperty(accessorSnapshotTask.baseSnapshot, 'rootId', {
  enumerable: true,
  get() { snapshotGetterCalls += 1; return 'toolsenabled'; }
});
rejects('controller base snapshot accessor', input(), dependencies({ currentTask: accessorSnapshotTask }),
  'DELEGATION_READONLY_INVALID');
assert.equal(snapshotGetterCalls, 0, 'controller base snapshot getters must not run');

const symbolCurrentTask = {
  taskId,
  status: 'running',
  cancellationRequested: false,
  delegationId,
  capabilityProfileHash: HASH_B,
  baseSnapshot: { ...snapshot },
  [Symbol('hidden-task-data')]: true
};
rejects('controller task Symbol field', input(), dependencies({ currentTask: symbolCurrentTask }),
  'DELEGATION_READONLY_INVALID');

rejects('non-read-only role', input({ task: task({ role: 'disposable_edit' }) }), dependencies(), 'DELEGATION_READONLY_SCOPE_DENIED');
rejects('task tool budget', input({ task: task({ budgets: { maxWallMs: 10_000, maxModelTokens: 100, maxToolCalls: 1, maxEvidenceBytes: 4096 } }) }), dependencies(), 'DELEGATION_READONLY_SCOPE_DENIED');
rejects('binding tool scope', input({ binding: binding({ toolSchemas: [{ name: 'task.list', schemaHash: HASH_C }] }) }), dependencies(), 'DELEGATION_READONLY_SCOPE_DENIED');
rejects('binding command scope', input({ binding: binding({ commandIds: ['safe-command'] }) }), dependencies(), 'DELEGATION_READONLY_SCOPE_DENIED');
rejects('expired binding', input({ binding: binding({ expiresAtMs: NOW }) }), dependencies(), 'DELEGATION_READONLY_EXPIRED');
rejects('cancelled task', input(), dependencies({ currentTask: { taskId, status: 'running', cancellationRequested: true, delegationId, capabilityProfileHash: HASH_B, baseSnapshot: { ...snapshot } } }), 'DELEGATION_READONLY_TASK_STALE');
rejects('stale second fence read', input(), dependencies({ secondFence: 8 }), 'DELEGATION_READONLY_FENCE_STALE');
const toolUsingResult = result({
  usage: { modelTokens: 10, toolCalls: 1, wallMs: 100, usageRecordRefs: [] }
});
rejects('worker tool use', input({ workerResult: toolUsingResult }), dependencies(), 'DELEGATION_READONLY_RESULT_DENIED');
rejects('worker patch artifact', input({ workerResult: result({ artifacts: [{ kind: 'patch', sha256: HASH_C, sizeBytes: 12 }] }) }), dependencies(), 'DELEGATION_READONLY_RESULT_DENIED');
rejects('incomplete verification', input({ workerResult: result({ verification: { state: 'passed', criterionIds: ['criterion-one'], evidenceRefs: ['evidence:one'] } }) }), dependencies(), 'DELEGATION_READONLY_VERIFICATION_INCOMPLETE');
rejects('missing evidence bundle', input({ evidenceBundle: null }), dependencies(), 'DELEGATION_READONLY_EVIDENCE_MISMATCH');
rejects('wrong evidence linkage', input({ evidenceBundle: bundle(result(), { workerResultHash: HASH_A }) }), dependencies(), 'DELEGATION_READONLY_EVIDENCE_MISMATCH');
rejects('reader exception is generic', input(), dependencies({ readProfile: () => { throw new Error('Bearer secret-should-not-leak'); } }), 'DELEGATION_READONLY_CONTROLLER_UNAVAILABLE');
rejects('required controller reader is absent', input(), { now: () => NOW, readTask: () => ({}), readFence: () => 7 }, 'DELEGATION_READONLY_CONTROLLER_UNAVAILABLE');

console.log('Delegation read-only qualification tests passed (25 checks).');

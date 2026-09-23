// EXECUTABLE CHANGE
// testcanfail-tests-delegation-task-projection-js
// Strengthened assertion: the forbidden-import scan now first proves that its
// require-statement parser found at least one import. Mutation: in a scratch
// copy, changed the subject's sole `require(...)` to `module['require'](...)`.
// Before this change the focused check stayed green; afterward it failed red:
// "AssertionError [ERR_ASSERTION]: Module import scan must find at least one require statement"
// Restored source: SHA-256 before/after matched byte-for-byte. The restored
// focused check is green: "Module code verified to have NO forbidden direct imports".
// NOT-FOUND (2): no exit-status or truthy-return-only process assertion.
// NOT-FOUND (3): no try/catch or optional chain swallowing an expected failure.
// NOT-FOUND (4): no assertion against a mock of the behavior under test.
// NOT-FOUND (5): no skip or platform precondition guard.
// NOT-FOUND (6): no expected value computed by the same code it checks.
// PRECONDITION-NOT-MET: the complete file requires node:sqlite (Node >=22.19),
// but this environment supplies Node 20.20.2 and cannot fetch another runtime.
'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createStateStore } = require('../src/lib/state-store');
const taskService = require('../src/lib/providers/tasks');
const contracts = require('../src/lib/delegation-contracts');
const { DelegationTaskProjectionError, submitDelegatedTask, decodeDelegatedTaskProjection } = require('../src/lib/delegation-task-projection');

// Helpers
const h = char => char.repeat(64);
const commit = char => char.repeat(40);
const delegationId = `dlg_${'A'.repeat(16)}`;
const snapshot = { rootId: 'sample-provider', commitSha1: commit('a'), treeSha256: h('b') };

const validDelegatedTask = {
  schemaVersion: 1,
  delegationId,
  goalId: 'sample-provider-release',
  phaseId: 'release-candidate',
  role: 'read_only_review',
  baseSnapshot: snapshot,
  acceptanceCriteria: ['artifact-verified', 'tests-green'],
  capabilityProfileHash: h('c'),
  budgets: { maxWallMs: 120000, maxModelTokens: 10000, maxToolCalls: 12, maxEvidenceBytes: 4096 },
  terminalStates: ['complete', 'blocked', 'failed']
};

async function runTests() {
  console.log('Running delegation-task-projection tests...');

  // The real canonical task service is exercised against a deterministic state
  // store: no wall clock and no random UUIDs can leak into this regression.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-delegation-projection-'));
  let sequence = 0;
  const stateStore = createStateStore({
    file: path.join(directory, 'state.sqlite3'),
    ownerId: 'test-delegation-projection',
    clock: () => Date.UTC(2026, 6, 29, 12, 0, 0),
    idFactory: prefix => `${prefix}-${String(++sequence).padStart(4, '0')}`
  });
  const dependencies = { state: stateStore };

  // 1. Test invalid DelegatedTask rejects before submit
  {
    const invalidTask = { ...validDelegatedTask, schemaVersion: 999 };
    await assert.rejects(
      submitDelegatedTask(taskService, invalidTask, { idempotencyKey: 'idem-test-01', queue: 'default', type: 'task-type' }, dependencies),
      /DelegatedTask schema version is unsupported/
    );
    console.log('âœ” Invalid DelegatedTask rejected before submit');
  }

  // JavaScript-only wrappers are closed and descriptor-read: hidden/Symbol
  // options and accessors cannot expand submission authority or execute code.
  const fakeSubmit = { submit: async request => request };
  const hiddenOptions = { idempotencyKey: 'idem-hidden-01', queue: 'default', type: 'task-type' };
  Object.defineProperty(hiddenOptions, 'priority', { value: 'ambient', enumerable: false });
  await assert.rejects(
    submitDelegatedTask(fakeSubmit, validDelegatedTask, hiddenOptions),
    error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
  );

  const symbolOptions = { idempotencyKey: 'idem-symbol-01', queue: 'default', type: 'task-type' };
  symbolOptions[Symbol('hidden-option')] = true;
  await assert.rejects(
    submitDelegatedTask(fakeSubmit, validDelegatedTask, symbolOptions),
    error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
  );

  let optionGetterCalls = 0;
  const accessorOptions = { queue: 'default', type: 'task-type' };
  Object.defineProperty(accessorOptions, 'idempotencyKey', {
    enumerable: true,
    get() { optionGetterCalls += 1; return 'idem-accessor-01'; }
  });
  await assert.rejects(
    submitDelegatedTask(fakeSubmit, validDelegatedTask, accessorOptions),
    error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
  );
  assert.equal(optionGetterCalls, 0, 'submit option getters must not run');

  let optionProxyGets = 0;
  const proxyOptions = new Proxy({ idempotencyKey: 'idem-proxy-01', queue: 'default', type: 'task-type' }, {
    get() { optionProxyGets += 1; throw new Error('option get trap must not run'); }
  });
  assert.equal((await submitDelegatedTask(fakeSubmit, validDelegatedTask, proxyOptions)).idempotencyKey,
    'idem-proxy-01');
  assert.equal(optionProxyGets, 0, 'valid submit option proxies must be read from descriptors');

  let serviceGetterCalls = 0;
  const accessorService = {};
  Object.defineProperty(accessorService, 'submit', {
    enumerable: true,
    get() { serviceGetterCalls += 1; return async request => request; }
  });
  await assert.rejects(
    submitDelegatedTask(accessorService, validDelegatedTask,
      { idempotencyKey: 'idem-service-01', queue: 'default', type: 'task-type' }),
    error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
  );
  assert.equal(serviceGetterCalls, 0, 'task service accessors must not run');

  let serviceProxyGets = 0;
  const proxyService = new Proxy(fakeSubmit, {
    get() { serviceProxyGets += 1; throw new Error('service get trap must not run'); }
  });
  assert.equal((await submitDelegatedTask(proxyService, validDelegatedTask,
    { idempotencyKey: 'idem-service-proxy-01', queue: 'default', type: 'task-type' })).idempotencyKey,
  'idem-service-proxy-01');
  assert.equal(serviceProxyGets, 0, 'valid task service proxies must be read from descriptors');

  // 2. Test successful idempotent submission (create + replay)
  let task1, task2;
  const idempotencyKey = 'idem-test-02';
  {
    task1 = await submitDelegatedTask(taskService, validDelegatedTask, { idempotencyKey, queue: 'default', type: 'task-type' }, dependencies);
    assert.ok(task1.taskId);
    assert.equal(task1.taskId, 'task-0001');
    assert.equal(task1.replayed, false);
    console.log('âœ” First submission created task:', task1.taskId);

    // Replay submission with exact same definition
    task2 = await submitDelegatedTask(taskService, validDelegatedTask, { idempotencyKey, queue: 'default', type: 'task-type' }, dependencies);
    assert.equal(task2.taskId, task1.taskId);
    assert.equal(task2.replayed, true);
    console.log('âœ” Idempotent replay returned same task ID');
  }

  // 3. Test retrieving task and decoding context only to safe references
  {
    const retrieved = await taskService.get({ taskId: task1.taskId, includePayload: true }, dependencies);
    assert.ok(retrieved.payload);

    // Confirm title/objective are the fixed bounded strings
    assert.equal(retrieved.payload.title, 'Delegated Task Projection');
    assert.equal(retrieved.payload.objective, 'Execute projected task delegation securely.');

    // Decode from retrieved task object
    assert.equal(retrieved.maxAttempts, 1);
    assert.equal(retrieved.expiryPolicy, 'uncertain');
    assert.equal(retrieved.payload.context.includes('sample-provider-release'), false);
    assert.equal(retrieved.payload.context.includes('artifact-verified'), false);

    const projection = decodeDelegatedTaskProjection(retrieved, validDelegatedTask);
    assert.equal(projection.projectionSchemaVersion, 1);
    assert.equal(projection.kind, 'delegated-task');
    assert.equal(projection.delegationId, delegationId);
    assert.equal(projection.contractHash, contracts.validateDelegatedTask(validDelegatedTask).contractHash);
    assert.equal(projection.role, 'read_only_review');
    assert.equal(projection.capabilityProfileHash, h('c'));
    assert.deepEqual(projection.baseSnapshot, snapshot);
    assert.equal(projection.contentTrust, 'untrusted');
    assert.equal(projection.grantsAuthority, false);

    // Ensure projection object and baseSnapshot sub-object are frozen
    assert.ok(Object.isFrozen(projection));
    assert.ok(Object.isFrozen(projection.baseSnapshot));

    // Decode from raw string directly
    const stringProjection = decodeDelegatedTaskProjection(retrieved.payload.context, validDelegatedTask);
    assert.equal(stringProjection.delegationId, delegationId);
    assert.ok(Object.isFrozen(stringProjection));

    let wrapperGetterCalls = 0;
    const accessorWrapper = {};
    Object.defineProperty(accessorWrapper, 'payload', {
      enumerable: true,
      get() { wrapperGetterCalls += 1; return retrieved.payload; }
    });
    assert.throws(
      () => decodeDelegatedTaskProjection(accessorWrapper, validDelegatedTask),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
    );
    assert.equal(wrapperGetterCalls, 0, 'projection wrapper getters must not run');

    let payloadGetterCalls = 0;
    const accessorPayload = {};
    Object.defineProperty(accessorPayload, 'context', {
      enumerable: true,
      get() { payloadGetterCalls += 1; return retrieved.payload.context; }
    });
    assert.throws(
      () => decodeDelegatedTaskProjection({ payload: accessorPayload }, validDelegatedTask),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
    );
    assert.equal(payloadGetterCalls, 0, 'task payload getters must not run');

    let wrapperProxyGets = 0;
    const proxyWrapper = new Proxy({ payload: { context: retrieved.payload.context } }, {
      get() { wrapperProxyGets += 1; throw new Error('wrapper get trap must not run'); }
    });
    assert.equal(decodeDelegatedTaskProjection(proxyWrapper, validDelegatedTask).delegationId, delegationId);
    assert.equal(wrapperProxyGets, 0, 'valid projection wrapper proxies must be read from descriptors');

    console.log('âœ” Successfully retrieved and decoded projection to frozen value-free references');
  }

  // 4. Test malformed/extra/secret-shaped context rejects on decode
  {
    // Extra key in context
    const extraContext = {
      projectionSchemaVersion: 1,
      kind: 'delegated-task',
      delegationId,
      contractHash: h('c'),
      role: 'read_only_review',
      capabilityProfileHash: h('c'),
      baseSnapshot: { ...snapshot },
      extraNonSensitiveField: 'hello'
    };
    assert.throws(
      () => decodeDelegatedTaskProjection({ payload: { context: JSON.stringify(extraContext) } }),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
    );

    // Missing key in context
    const missingContext = {
      projectionSchemaVersion: 1,
      kind: 'delegated-task',
      delegationId,
      contractHash: h('c'),
      role: 'read_only_review',
      capabilityProfileHash: h('c')
      // baseSnapshot missing
    };
    assert.throws(
      () => decodeDelegatedTaskProjection({ payload: { context: JSON.stringify(missingContext) } }),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
    );

    // Secret-shaped context (using pattern matching SENSITIVE)
    const secretShapedContext = {
      projectionSchemaVersion: 1,
      kind: 'delegated-task',
      delegationId,
      contractHash: h('c'),
      role: 'read_only_review',
      capabilityProfileHash: h('c'),
      baseSnapshot: { ...snapshot, rootId: 'Bearer secret-root-token' }
    };
    assert.throws(
      () => decodeDelegatedTaskProjection({ payload: { context: JSON.stringify(secretShapedContext) } }),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_DENIED'
    );

    // Unsupported version
    const wrongVersionContext = {
      projectionSchemaVersion: 2,
      kind: 'delegated-task',
      delegationId,
      contractHash: h('c'),
      role: 'read_only_review',
      capabilityProfileHash: h('c'),
      baseSnapshot: { ...snapshot }
    };
    assert.throws(
      () => decodeDelegatedTaskProjection({ payload: { context: JSON.stringify(wrongVersionContext) } }),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
    );

    // Malformed JSON
    assert.throws(
      () => decodeDelegatedTaskProjection({ payload: { context: '{invalid-json' } }),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
    );

    const mismatched = { ...validDelegatedTask, capabilityProfileHash: h('d') };
    assert.throws(
      () => decodeDelegatedTaskProjection(JSON.stringify({
        projectionSchemaVersion: 1,
        kind: 'delegated-task',
        delegationId,
        contractHash: contracts.validateDelegatedTask(validDelegatedTask).contractHash,
        role: 'read_only_review',
        capabilityProfileHash: h('c'),
        baseSnapshot: snapshot
      }), mismatched),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_STALE_OR_MISMATCHED'
    );

    console.log('âœ” Malformed/extra/secret-shaped context correctly rejected during decode');
  }

  // Safe-looking syntax is insufficient: projection submission rejects an
  // identifier with a secret-shaped lane before it reaches canonical storage.
  await assert.rejects(
    submitDelegatedTask(taskService, validDelegatedTask, { idempotencyKey: 'token-lane-01', queue: 'default', type: 'task-type' }, dependencies),
    error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
  );

  // 5. Test module lacks direct imports of state-store/registry/provider/browser/vault
  {
    const projFilePath = path.join(__dirname, '../src/lib/delegation-task-projection.js');
    const code = fs.readFileSync(projFilePath, 'utf8');

    // Parse all require statements
    const requireMatches = code.match(/require\s*\(\s*['"`](.*?)['"`]\s*\)/g) || [];
    const forbidden = ['state-store', 'registry', 'provider', 'browser', 'vault'];

    assert.ok(requireMatches.length > 0,
      'Module import scan must find at least one require statement');
    for (const match of requireMatches) {
      const importPath = match.match(/['"`](.*?)['"`]/)[1];
      const resolvedName = path.basename(importPath, '.js');
      for (const word of forbidden) {
        assert.ok(!resolvedName.includes(word), `Module must not directly import ${word}: ${match}`);
      }
    }
    console.log('âœ” Module code verified to have NO forbidden direct imports');
  }

  // 6. Test module never calls lifecycle-mutating task APIs other than submit/get
  {
    const projFilePath = path.join(__dirname, '../src/lib/delegation-task-projection.js');
    const code = fs.readFileSync(projFilePath, 'utf8');

    const forbiddenMethods = ['claim', 'start', 'heartbeat', 'checkpoint', 'complete', 'fail', 'cancel', 'list'];
    for (const method of forbiddenMethods) {
      assert.ok(!code.includes(`taskService.${method}`), `Module must not call taskService.${method}`);
      assert.ok(!code.includes(`['${method}']`), `Module must not call taskService.${method}`);
      assert.ok(!code.includes(`["${method}"]`), `Module must not call taskService.${method}`);
    }
    console.log('âœ” Module code verified to NOT call any forbidden taskService lifecycle methods');
  }

  console.log('\nAll tests passed successfully! Q21/AGW-07 First Slice fully validated.');
  stateStore.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

runTests().catch(err => {
  console.error('Test run failed:', err);
  process.exit(1);
});

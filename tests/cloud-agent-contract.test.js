// EXECUTABLE CHANGE — testcanfail-tests-cloud-agent-contract-test-js
//
// Mutation report:
// - Source-effect assertion: inserted `require('node:fs')` into session.js. The
//   old test stayed green; the strengthened test went RED with:
//   `AssertionError [ERR_ASSERTION]: session.js must not match /require...fs/`.
// - Idempotency boundary assertion: changed session.js to pass a replacement
//   idempotencyKey to adapter.submit. The old same-task/store-size assertions
//   stayed green; the added request-capture assertion went RED with:
//   `Expected values to be strictly deep-equal` and actual values
//   `[ 'idem-mutated', 'idem-mutated' ]` instead of the two original keys.
// - Empty-loop mutation: emptied forbiddenCoreEffects in this scratch test.
//   The old loop stayed green; the new cardinality assertion went RED with:
//   `AssertionError [ERR_ASSERTION]: the core-effect denylist must not be empty`.
// - Restored source byte-for-byte (session.js SHA-256
//   20a38574f317655a5f57b8089e71a7497cd46f8189d0cc022b7d60ad93bd9740), then
//   `node tests/cloud-agent-contract.test.js` was GREEN:
//   `cloud-agent contract tests passed (53 checks: request/result validation, immutable bindings, manifest budgets, state-machine transitions, idempotent submit/reconcile, UNKNOWN handling, model-mismatch reconciliation, timeout absorption, and zero checkout-write/apply capability).`
// - NOT-FOUND: exit-status/truthy process assertions; swallowed failures via
//   try/catch or optional chaining; skip/platform precondition guards; expected
//   values computed by the same product code. No process is spawned by this file.
// - PRECONDITIONS: all met; the focused test runs directly with Node.

'use strict';

// R1177 S1: focused, provider-neutral tests for src/lib/cloud-agent/*.
// Plain `node tests/cloud-agent-contract.test.js`. No fs, no network, no
// child process, no isolated-environment: every adapter here is an in-memory
// fake, which is the entire point of the dependency-injected contract.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contract = require('../src/lib/cloud-agent/contract');
const stateMachine = require('../src/lib/cloud-agent/state-machine');
const { CloudAgentSession, assertAdapterShape } = require('../src/lib/cloud-agent/session');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');
const cloudAgentIndex = require('../src/lib/cloud-agent');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const asyncCheck = async (label, fn) => { await fn(); checks += 1; void label; };

function code(fn, expectedCode) {
  assert.throws(fn, error => {
    assert.ok(error instanceof CloudAgentError, `expected a CloudAgentError, got ${error && error.constructor && error.constructor.name}`);
    assert.equal(error.code, expectedCode, `expected code ${expectedCode}, got ${error.code}: ${error.message}`);
    return true;
  });
}

async function rejectsWithCode(promise, expectedCode) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof CloudAgentError, `expected a CloudAgentError, got ${error && error.constructor && error.constructor.name}`);
    assert.equal(error.code, expectedCode, `expected code ${expectedCode}, got ${error.code}: ${error.message}`);
    return true;
  });
}

const hex = (char, length = 64) => char.repeat(length);
const opaque = (prefix, char = 'a') => `${prefix}${char.repeat(20)}`;

const forbiddenCoreEffects = [
  /require\s*\(\s*['"](?:node:)?fs['"]\s*\)/i,
  /\bfs(?:\.promises)?\.(?:write|append|rm|unlink|copy)/i,
  /\bgit\s+apply\b/i,
  /child_process/,
  /\bexecSync\b/,
  /\bspawn\b/
];

function assertCoreSourceHasNoEffects(source, fileName) {
  assert.ok(forbiddenCoreEffects.length > 0, 'the core-effect denylist must not be empty');
  for (const pattern of forbiddenCoreEffects) {
    assert.equal(pattern.test(source), false, `${fileName} must not match ${pattern}`);
  }
}

function baseRequestInput(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'codex-cloud',
    environment: 'env-main',
    repository: { rootId: 'toolsenabled' },
    sourceRevision: hex('a', 40),
    fileKeeperProof: { proofId: opaque('fkp-', 'b'), treeSha256: hex('c') },
    idempotencyKey: opaque('idem-', 'd'),
    requiredModel: 'gpt-test-model',
    taskHash: hex('e'),
    pathAllowlist: ['src/**'],
    byteBudget: 4096,
    timeBudgetMs: 5000,
    ...overrides
  };
}

function baseResultInput(request, overrides = {}) {
  return {
    schemaVersion: 1,
    requestHash: request.requestHash,
    providerTaskId: opaque('task-', 'f'),
    requestedModel: request.requiredModel,
    servedModel: request.requiredModel,
    state: 'SUCCEEDED',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:05:00.000Z',
    evidenceHashes: [hex('1')],
    artifactManifest: [],
    ...overrides
  };
}

// A fully working fake adapter. Each operation can be overridden per test so
// a scenario only has to describe what differs from the happy path. Calls are
// counted by wrapping the FINAL (post-override) methods, so an override never
// has to remember to track itself -- this is what lets the UNKNOWN-handling
// and idempotency tests assert "the adapter's submit was invoked exactly N
// times" regardless of which operation a given test replaced.
function fakeAdapter(overrides = {}) {
  const calls = { capabilities: 0, bindEnvironment: 0, submit: 0, inspect: 0, fetchChangeManifest: 0, cancel: 0, reconcile: 0 };
  const tasks = new Map();
  const base = {
    async capabilities() {
      return { providerId: 'codex-cloud', models: ['gpt-test-model'], supportsCancel: true, maxByteBudget: 4096, maxTimeBudgetMs: 60000 };
    },
    async bindEnvironment() {
      return { environmentRef: opaque('envref-', '2') };
    },
    async submit(request) {
      const result = baseResultInput(request, { state: 'SUBMITTED', servedModel: null, evidenceHashes: [] });
      tasks.set(result.providerTaskId, result);
      return result;
    },
    async inspect(providerTaskId, request) {
      return tasks.get(providerTaskId) || baseResultInput(request, { providerTaskId, state: 'SUCCEEDED' });
    },
    async fetchChangeManifest() {
      return [{ path: 'src/foo.js', sha256: hex('9'), sizeBytes: 12 }];
    },
    async cancel(providerTaskId, request) {
      return baseResultInput(request, { providerTaskId, state: 'CANCELLED', servedModel: null, evidenceHashes: [] });
    },
    async reconcile(providerTaskId, request) {
      return tasks.get(providerTaskId) || baseResultInput(request, { providerTaskId, state: 'SUCCEEDED' });
    }
  };
  const merged = { ...base, ...overrides };
  const adapter = {};
  for (const name of Object.keys(merged)) {
    adapter[name] = (...args) => { calls[name] = (calls[name] || 0) + 1; return merged[name](...args); };
  }
  return { adapter, calls, tasks };
}

(async () => {
  // --- validateRequest: shape, bounds, determinism, immutability ----------

  check('validateRequest accepts a well-formed request and freezes it', () => {
    const request = contract.validateRequest(baseRequestInput());
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.repository), true);
    assert.equal(Object.isFrozen(request.fileKeeperProof), true);
    assert.equal(Object.isFrozen(request.pathAllowlist), true);
    assert.match(request.requestHash, /^[a-f0-9]{64}$/);
  });

  check('validateRequest is deterministic: identical input produces identical requestHash', () => {
    const a = contract.validateRequest(baseRequestInput());
    const b = contract.validateRequest(baseRequestInput());
    assert.equal(a.requestHash, b.requestHash);
  });

  check('validateRequest hash changes when a bound field changes', () => {
    const a = contract.validateRequest(baseRequestInput());
    const b = contract.validateRequest(baseRequestInput({ sourceRevision: hex('9', 40) }));
    assert.notEqual(a.requestHash, b.requestHash);
  });

  check('validateRequest rejects an unlisted extra field', () => {
    code(() => contract.validateRequest({ ...baseRequestInput(), extra: 'nope' }), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('validateRequest rejects a missing required field', () => {
    const input = baseRequestInput();
    delete input.taskHash;
    code(() => contract.validateRequest(input), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('validateRequest rejects a non-hex sourceRevision', () => {
    code(() => contract.validateRequest(baseRequestInput({ sourceRevision: 'not-a-sha1' })), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('validateRequest rejects an unsupported schemaVersion', () => {
    code(() => contract.validateRequest(baseRequestInput({ schemaVersion: 2 })), 'CLOUD_AGENT_CONTRACT_VERSION_UNSUPPORTED');
  });

  check('validateRequest rejects a ".." path segment in pathAllowlist', () => {
    code(() => contract.validateRequest(baseRequestInput({ pathAllowlist: ['../etc/passwd'] })), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('validateRequest rejects duplicate pathAllowlist entries', () => {
    code(() => contract.validateRequest(baseRequestInput({ pathAllowlist: ['src/**', 'src/**'] })), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('validateRequest rejects an out-of-range byteBudget', () => {
    code(() => contract.validateRequest(baseRequestInput({ byteBudget: 0 })), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('validateRequest rejects a sub-floor timeBudgetMs', () => {
    code(() => contract.validateRequest(baseRequestInput({ timeBudgetMs: 10 })), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('a frozen CloudAgentRequest cannot be mutated (immutable binding)', () => {
    const request = contract.validateRequest(baseRequestInput());
    assert.throws(() => { request.sourceRevision = hex('0', 40); }, TypeError);
    assert.throws(() => { request.repository.rootId = 'other'; }, TypeError);
    assert.throws(() => { request.pathAllowlist.push('x'); }, TypeError);
    assert.equal(request.sourceRevision, hex('a', 40), 'value must be unchanged after a blocked mutation attempt');
  });

  // --- validateResult -------------------------------------------------------

  check('validateResult accepts a well-formed result and freezes it', () => {
    const request = contract.validateRequest(baseRequestInput());
    const result = contract.validateResult(baseResultInput(request));
    assert.equal(Object.isFrozen(result), true);
    assert.match(result.resultHash, /^[a-f0-9]{64}$/);
  });

  check('validateResult requires providerTaskId to be null only when state is UNKNOWN', () => {
    const request = contract.validateRequest(baseRequestInput());
    code(() => contract.validateResult(baseResultInput(request, { providerTaskId: null, state: 'SUCCEEDED' })), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('validateResult accepts a null providerTaskId when state is UNKNOWN', () => {
    const request = contract.validateRequest(baseRequestInput());
    const result = contract.validateResult(baseResultInput(request, { providerTaskId: null, state: 'UNKNOWN', servedModel: null, evidenceHashes: [] }));
    assert.equal(result.providerTaskId, null);
    assert.equal(result.state, 'UNKNOWN');
  });

  check('validateResult rejects an unrecognized state', () => {
    const request = contract.validateRequest(baseRequestInput());
    code(() => contract.validateResult(baseResultInput(request, { state: 'DONE_ISH' })), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('validateResult rejects an unlisted extra field', () => {
    const request = contract.validateRequest(baseRequestInput());
    code(() => contract.validateResult({ ...baseResultInput(request), extra: true }), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('assertResultMatchesRequest rejects a result bound to a different request', () => {
    const requestA = contract.validateRequest(baseRequestInput());
    const requestB = contract.validateRequest(baseRequestInput({ idempotencyKey: opaque('idem-', 'z') }));
    const resultForB = contract.validateResult(baseResultInput(requestB));
    code(() => contract.assertResultMatchesRequest(requestA, resultForB), 'CLOUD_AGENT_REQUEST_MISMATCH');
  });

  check('assertResultMatchesRequest rejects a requestedModel that does not match the bound request', () => {
    const request = contract.validateRequest(baseRequestInput());
    const result = contract.validateResult(baseResultInput(request, { requestedModel: 'some-other-model', requestHash: request.requestHash }));
    code(() => contract.assertResultMatchesRequest(request, result), 'CLOUD_AGENT_REQUEST_MISMATCH');
  });

  check('assertResultMatchesRequest refuses absent bindings instead of matching undefined values', () => {
    code(() => contract.assertResultMatchesRequest({}, {}), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  // --- bounded manifest validation ------------------------------------------

  check('validateManifest accepts entries and sorts them deterministically', () => {
    const manifest = contract.validateManifest([
      { path: 'src/b.js', sha256: hex('2'), sizeBytes: 5 },
      { path: 'src/a.js', sha256: hex('3'), sizeBytes: 5 }
    ]);
    assert.deepEqual(manifest.map(entry => entry.path), ['src/a.js', 'src/b.js']);
    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.isFrozen(manifest[0]), true);
  });

  check('validateManifest rejects duplicate paths', () => {
    code(() => contract.validateManifest([
      { path: 'src/a.js', sha256: hex('2'), sizeBytes: 1 },
      { path: 'src/a.js', sha256: hex('3'), sizeBytes: 1 }
    ]), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('validateManifest rejects a ".." path segment', () => {
    code(() => contract.validateManifest([{ path: '../outside.js', sha256: hex('2'), sizeBytes: 1 }]), 'CLOUD_AGENT_CONTRACT_INVALID');
  });

  check('matchesAllowlist matches an exact path and a "/**" prefix, but not a sibling', () => {
    assert.equal(contract.matchesAllowlist('docs/readme.md', ['docs/readme.md']), true);
    assert.equal(contract.matchesAllowlist('src/lib/deep/file.js', ['src/**']), true);
    assert.equal(contract.matchesAllowlist('src', ['src/**']), true);
    assert.equal(contract.matchesAllowlist('src-other/file.js', ['src/**']), false);
  });

  check('assertManifestWithinBudget rejects a path outside the allowlist', () => {
    const request = contract.validateRequest(baseRequestInput({ pathAllowlist: ['src/**'] }));
    const manifest = contract.validateManifest([{ path: 'secrets/creds.env', sha256: hex('4'), sizeBytes: 1 }]);
    code(() => contract.assertManifestWithinBudget(request, manifest), 'CLOUD_AGENT_MANIFEST_PATH_DENIED');
  });

  check('assertManifestWithinBudget rejects a manifest exceeding the byte budget', () => {
    const request = contract.validateRequest(baseRequestInput({ pathAllowlist: ['src/**'], byteBudget: 10 }));
    const manifest = contract.validateManifest([{ path: 'src/big.js', sha256: hex('5'), sizeBytes: 11 }]);
    code(() => contract.assertManifestWithinBudget(request, manifest), 'CLOUD_AGENT_MANIFEST_BUDGET_EXCEEDED');
  });

  check('assertManifestWithinBudget accepts a manifest within budget and allowlist', () => {
    const request = contract.validateRequest(baseRequestInput({ pathAllowlist: ['src/**'], byteBudget: 10 }));
    const manifest = contract.validateManifest([{ path: 'src/ok.js', sha256: hex('6'), sizeBytes: 10 }]);
    assert.equal(contract.assertManifestWithinBudget(request, manifest), true);
  });

  // --- state machine ---------------------------------------------------------

  check('state machine allows the documented happy-path transitions', () => {
    assert.equal(stateMachine.afterBind('UNBOUND'), 'READY');
    assert.equal(stateMachine.afterSubmit('READY', 'SUBMITTED'), 'SUBMITTED');
    assert.equal(stateMachine.afterObserve('SUBMITTED', 'RUNNING'), 'RUNNING');
    assert.equal(stateMachine.afterObserve('RUNNING', 'SUCCEEDED'), 'SUCCEEDED');
  });

  check('state machine refuses submit landing directly on a terminal state', () => {
    code(() => stateMachine.afterSubmit('READY', 'SUCCEEDED'), 'CLOUD_AGENT_ILLEGAL_TRANSITION');
  });

  check('state machine refuses leaving a terminal state', () => {
    code(() => stateMachine.afterObserve('SUCCEEDED', 'RUNNING'), 'CLOUD_AGENT_ILLEGAL_TRANSITION');
    code(() => stateMachine.afterObserve('FAILED', 'SUCCEEDED'), 'CLOUD_AGENT_ILLEGAL_TRANSITION');
    code(() => stateMachine.afterObserve('CANCELLED', 'RUNNING'), 'CLOUD_AGENT_ILLEGAL_TRANSITION');
  });

  check('state machine allows UNKNOWN to recover to any known in-flight or terminal state', () => {
    assert.equal(stateMachine.afterObserve('UNKNOWN', 'RUNNING'), 'RUNNING');
    assert.equal(stateMachine.afterObserve('UNKNOWN', 'SUCCEEDED'), 'SUCCEEDED');
    assert.equal(stateMachine.afterObserve('UNKNOWN', 'UNKNOWN'), 'UNKNOWN');
  });

  check('state machine rejects an unrecognized state name', () => {
    code(() => stateMachine.afterObserve('SUBMITTED', 'ALMOST_DONE'), 'CLOUD_AGENT_STATE_UNKNOWN');
  });

  check('canAdvance is true only for SUCCEEDED + reconciled', () => {
    assert.equal(stateMachine.canAdvance({ state: 'SUCCEEDED', reconciled: true }), true);
    assert.equal(stateMachine.canAdvance({ state: 'SUCCEEDED', reconciled: false }), false);
    assert.equal(stateMachine.canAdvance({ state: 'UNKNOWN', reconciled: true }), false);
  });

  check('canAdvance refuses snapshots that cannot establish state or reconciliation', () => {
    code(() => stateMachine.canAdvance(undefined), 'CLOUD_AGENT_SESSION_INVALID');
    code(() => stateMachine.canAdvance({ reconciled: true }), 'CLOUD_AGENT_STATE_UNKNOWN');
    code(() => stateMachine.canAdvance({ state: 'SUCCEEDED' }), 'CLOUD_AGENT_SESSION_INVALID');
  });

  // --- adapter shape ----------------------------------------------------------

  check('assertAdapterShape rejects an adapter missing a required operation', () => {
    const { adapter } = fakeAdapter();
    delete adapter.submit;
    code(() => assertAdapterShape(adapter), 'CLOUD_AGENT_ADAPTER_INVALID');
  });

  check('assertAdapterShape rejects a non-function optional cancel', () => {
    const { adapter } = fakeAdapter();
    adapter.cancel = 'not-a-function';
    code(() => assertAdapterShape(adapter), 'CLOUD_AGENT_ADAPTER_INVALID');
  });

  check('assertAdapterShape accepts a fully-implemented adapter and one missing optional cancel', () => {
    const { adapter } = fakeAdapter();
    assertAdapterShape(adapter);
    delete adapter.cancel;
    assertAdapterShape(adapter);
  });

  // --- CloudAgentSession: full lifecycle --------------------------------------

  await asyncCheck('CloudAgentSession runs bind -> submit -> inspect -> fetchChangeManifest -> reconcile to canAdvance', async () => {
    const { adapter, tasks } = fakeAdapter();
    const session = new CloudAgentSession({ adapter });
    const bound = await session.bindEnvironment(baseRequestInput());
    assert.equal(bound.state, 'READY');

    const submitted = await session.submit();
    assert.equal(submitted.state, 'SUBMITTED');
    const taskId = submitted.result.providerTaskId;

    // The provider finishes the task between submit and inspect.
    tasks.set(taskId, { ...tasks.get(taskId), state: 'SUCCEEDED', servedModel: 'gpt-test-model', evidenceHashes: [hex('7')] });
    const inspected = await session.inspect();
    assert.equal(inspected.state, 'SUCCEEDED');
    assert.equal(inspected.reconciled, false, 'a bare inspect() must never set reconciled');
    assert.equal(inspected.canAdvance, false);

    const manifest = await session.fetchChangeManifest();
    assert.deepEqual(manifest.map(entry => entry.path), ['src/foo.js']);

    const reconciled = await session.reconcile();
    assert.equal(reconciled.state, 'SUCCEEDED');
    assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.canAdvance, true);
    assert.equal(reconciled.blockedReason, null);
  });

  // --- idempotent submit / reconcile ------------------------------------------

  await asyncCheck('submit() called twice on the same session is idempotent: the adapter is invoked once', async () => {
    const { adapter, calls } = fakeAdapter();
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(baseRequestInput());
    const first = await session.submit();
    const second = await session.submit();
    assert.equal(calls.submit, 1);
    assert.equal(first.result.providerTaskId, second.result.providerTaskId);
  });

  await asyncCheck('reconcile() is idempotent when the provider keeps reporting the same terminal outcome', async () => {
    const { adapter, tasks } = fakeAdapter();
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(baseRequestInput());
    const submitted = await session.submit();
    const taskId = submitted.result.providerTaskId;
    tasks.set(taskId, { ...tasks.get(taskId), state: 'SUCCEEDED', servedModel: 'gpt-test-model', evidenceHashes: [hex('8')] });

    const first = await session.reconcile();
    const second = await session.reconcile();
    assert.equal(first.reconciled, true);
    assert.equal(second.reconciled, true);
    assert.equal(first.result.resultHash, second.result.resultHash);
  });

  await asyncCheck('idempotencyKey lets two independent sessions dedupe against a shared provider-side store', async () => {
    // Simulates two process attempts (e.g. a crash-and-retry) sharing one
    // provider-side idempotency table keyed off request.idempotencyKey --
    // the real cross-process guarantee; a session's own in-memory guard above
    // only covers a single process's lifetime.
    const providerStore = new Map();
    const submittedIdempotencyKeys = [];
    const request = baseRequestInput();
    const makeAdapter = () => fakeAdapter({
      async submit(validatedRequest) {
        submittedIdempotencyKeys.push(validatedRequest.idempotencyKey);
        if (providerStore.has(validatedRequest.idempotencyKey)) return providerStore.get(validatedRequest.idempotencyKey);
        const result = baseResultInput(validatedRequest, { state: 'SUBMITTED', servedModel: null, evidenceHashes: [] });
        providerStore.set(validatedRequest.idempotencyKey, result);
        return result;
      }
    }).adapter;

    const sessionA = new CloudAgentSession({ adapter: makeAdapter() });
    await sessionA.bindEnvironment(request);
    const submittedA = await sessionA.submit();

    const sessionB = new CloudAgentSession({ adapter: makeAdapter() });
    await sessionB.bindEnvironment(request);
    const submittedB = await sessionB.submit();

    assert.equal(submittedA.result.providerTaskId, submittedB.result.providerTaskId, 'the same idempotencyKey must resolve to the same provider task');
    assert.equal(providerStore.size, 1, 'the provider-side store must show exactly one task, not two');
    assert.deepEqual(submittedIdempotencyKeys, [request.idempotencyKey, request.idempotencyKey],
      'each independent session must forward the caller-bound idempotencyKey to its adapter');
  });

  // --- UNKNOWN handling --------------------------------------------------------

  await asyncCheck('UNKNOWN never maps to success and reconcile never re-calls submit', async () => {
    const { adapter, calls } = fakeAdapter({
      async inspect(providerTaskId, request) { return baseResultInput(request, { state: 'UNKNOWN', providerTaskId: null, servedModel: null, evidenceHashes: [] }); },
      async reconcile(providerTaskId, request) { return baseResultInput(request, { state: 'UNKNOWN', providerTaskId: null, servedModel: null, evidenceHashes: [] }); }
    });
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(baseRequestInput());
    await session.submit();

    const inspected = await session.inspect();
    assert.equal(inspected.state, 'UNKNOWN');
    assert.equal(inspected.canAdvance, false);

    const reconciled = await session.reconcile();
    assert.equal(reconciled.state, 'UNKNOWN');
    assert.equal(reconciled.reconciled, false);
    assert.equal(reconciled.blockedReason, 'STATE_UNKNOWN');
    assert.equal(reconciled.canAdvance, false);

    // The only mutating operation in this whole contract is submit(); prove
    // it was never called again while resolving two UNKNOWN observations.
    assert.equal(calls.submit, 1);
  });

  // --- timeout: an adapter that never resolves must become UNKNOWN, not hang or fail ---

  await asyncCheck('a submit() that exceeds timeBudgetMs resolves to UNKNOWN with no providerTaskId, never SUCCEEDED/FAILED', async () => {
    const { adapter, calls } = fakeAdapter({ async submit() { return new Promise(() => {}); } });
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(baseRequestInput({ timeBudgetMs: 1000 }));
    const snapshot = await session.submit();
    assert.equal(snapshot.state, 'UNKNOWN');
    assert.equal(snapshot.result.providerTaskId, null);
    assert.equal(snapshot.reconciled, false);
    assert.equal(calls.submit, 1, 'the timed-out call itself still only counts once');
  });

  await asyncCheck('an inspect() that exceeds timeBudgetMs resolves to UNKNOWN while preserving the known providerTaskId', async () => {
    const { adapter } = fakeAdapter({ async inspect() { return new Promise(() => {}); } });
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(baseRequestInput({ timeBudgetMs: 1000 }));
    const submitted = await session.submit();
    const snapshot = await session.inspect();
    assert.equal(snapshot.state, 'UNKNOWN');
    assert.equal(snapshot.result.providerTaskId, submitted.result.providerTaskId, 'losing contact must not lose the known task id');
  });

  await asyncCheck('falsy adapter rejection reasons remain rejections instead of becoming invalid results', async () => {
    const submitFailure = null;
    const { adapter: submitAdapter } = fakeAdapter({ async submit() { throw submitFailure; } });
    const submitSession = new CloudAgentSession({ adapter: submitAdapter });
    await submitSession.bindEnvironment(baseRequestInput());
    await assert.rejects(submitSession.submit(), error => error === submitFailure);

    const inspectFailure = false;
    const { adapter: inspectAdapter } = fakeAdapter({ async inspect() { throw inspectFailure; } });
    const inspectSession = new CloudAgentSession({ adapter: inspectAdapter });
    await inspectSession.bindEnvironment(baseRequestInput());
    await inspectSession.submit();
    await assert.rejects(inspectSession.inspect(), error => error === inspectFailure);
  });

  // --- requested-vs-served model mismatch --------------------------------------

  await asyncCheck('reconcile() refuses to advance on a requested-vs-served model mismatch', async () => {
    const { adapter } = fakeAdapter({
      async reconcile(providerTaskId, request) {
        return baseResultInput(request, { providerTaskId, state: 'SUCCEEDED', servedModel: 'a-different-model', evidenceHashes: [hex('a')] });
      }
    });
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(baseRequestInput());
    await session.submit();
    const reconciled = await session.reconcile();
    assert.equal(reconciled.state, 'SUCCEEDED');
    assert.equal(reconciled.reconciled, false);
    assert.equal(reconciled.blockedReason, 'MODEL_MISMATCH');
    assert.equal(reconciled.canAdvance, false);
  });

  await asyncCheck('submit() itself rejects a result whose requestedModel echo does not match the bound request', async () => {
    const { adapter } = fakeAdapter({
      async submit(request) { return baseResultInput(request, { state: 'SUBMITTED', requestedModel: 'wrong-model', servedModel: null, evidenceHashes: [] }); }
    });
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(baseRequestInput());
    await rejectsWithCode(session.submit(), 'CLOUD_AGENT_REQUEST_MISMATCH');
  });

  // --- illegal-state guards ------------------------------------------------

  await asyncCheck('operations refuse to run out of order', async () => {
    const { adapter } = fakeAdapter();
    const session = new CloudAgentSession({ adapter });
    await rejectsWithCode(session.submit(), 'CLOUD_AGENT_NOT_BOUND');
    await rejectsWithCode(session.inspect(), 'CLOUD_AGENT_NOT_BOUND');
    await rejectsWithCode(session.cancel(), 'CLOUD_AGENT_NOT_BOUND');

    await session.bindEnvironment(baseRequestInput());
    await rejectsWithCode(session.bindEnvironment(baseRequestInput()), 'CLOUD_AGENT_ALREADY_BOUND');
    await rejectsWithCode(session.inspect(), 'CLOUD_AGENT_NOT_SUBMITTED');
    await rejectsWithCode(session.fetchChangeManifest(), 'CLOUD_AGENT_NOT_SUBMITTED');
  });

  await asyncCheck('cancel() is refused once a task has reached a terminal state', async () => {
    const { adapter, tasks } = fakeAdapter();
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(baseRequestInput());
    const submitted = await session.submit();
    tasks.set(submitted.result.providerTaskId, { ...tasks.get(submitted.result.providerTaskId), state: 'SUCCEEDED', servedModel: 'gpt-test-model', evidenceHashes: [hex('b')] });
    await session.inspect();
    await rejectsWithCode(session.cancel(), 'CLOUD_AGENT_INVALID_STATE');
  });

  await asyncCheck('cancel() is refused when the adapter does not implement it', async () => {
    const { adapter } = fakeAdapter();
    delete adapter.cancel;
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(baseRequestInput());
    await session.submit();
    await rejectsWithCode(session.cancel(), 'CLOUD_AGENT_CANCEL_UNSUPPORTED');
  });

  await asyncCheck('a changed providerTaskId from the adapter is refused, not silently adopted', async () => {
    const { adapter } = fakeAdapter({
      async inspect(providerTaskId, request) { return baseResultInput(request, { providerTaskId: opaque('task-', 'z'), state: 'RUNNING', servedModel: null, evidenceHashes: [] }); }
    });
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(baseRequestInput());
    await session.submit();
    await rejectsWithCode(session.inspect(), 'CLOUD_AGENT_TASK_ID_CHANGED');
  });

  // --- capabilities ------------------------------------------------------------

  await asyncCheck('capabilities() works before bindEnvironment and validates the adapter response', async () => {
    const { adapter } = fakeAdapter();
    const session = new CloudAgentSession({ adapter });
    const caps = await session.capabilities();
    assert.equal(caps.providerId, 'codex-cloud');
    assert.equal(Object.isFrozen(caps), true);
  });

  // --- zero checkout-write/apply capability ------------------------------------

  check('CloudAgentSession exposes only the contracted operations -- no apply/write/patch method', () => {
    const publicNames = Object.getOwnPropertyNames(CloudAgentSession.prototype)
      .filter(name => name !== 'constructor');
    assert.deepEqual(publicNames.sort(), ['bindEnvironment', 'cancel', 'capabilities', 'fetchChangeManifest', 'inspect', 'reconcile', 'snapshot', 'submit'].sort());
  });

  check('the cloud-agent core source never references a filesystem write, git apply, or child process', () => {
    const guardedFiles = ['contract.js', 'state-machine.js', 'session.js', 'index.js', 'errors.js']
      .map(name => path.join(__dirname, '..', 'src', 'lib', 'cloud-agent', name));
    assert.deepEqual(guardedFiles.map(file => path.basename(file)),
      ['contract.js', 'state-machine.js', 'session.js', 'index.js', 'errors.js'],
      'the source-effect scan must cover every cloud-agent core module');
    for (const file of guardedFiles) {
      const source = fs.readFileSync(file, 'utf8');
      assertCoreSourceHasNoEffects(source, path.basename(file));
    }
  });

  check('the core source effect guard detects both direct and promise-based filesystem writes', () => {
    assert.throws(() => assertCoreSourceHasNoEffects('fs.writeFileSync(target, data);', 'direct-write.js'), assert.AssertionError);
    assert.throws(() => assertCoreSourceHasNoEffects('fs.promises.writeFile(target, data);', 'promise-write.js'), assert.AssertionError);
    assert.throws(() => assertCoreSourceHasNoEffects("require('node:fs').writeFileSync(target, data);", 'required-write.js'), assert.AssertionError);
  });

  check('the public barrel re-exports the same contract/state-machine/session modules', () => {
    assert.equal(cloudAgentIndex.contract, contract);
    assert.equal(cloudAgentIndex.stateMachine, stateMachine);
    assert.equal(cloudAgentIndex.CloudAgentSession, CloudAgentSession);
  });

  console.log(`cloud-agent contract tests passed (${checks} checks: request/result validation, immutable bindings, manifest budgets, state-machine transitions, idempotent submit/reconcile, UNKNOWN handling, model-mismatch reconciliation, timeout absorption, and zero checkout-write/apply capability).`);
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

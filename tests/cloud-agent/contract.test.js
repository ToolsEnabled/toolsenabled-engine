/*
 * Mutation check: changed isKnownState to return typeof value === 'string'.
 * The edit landed in src/lib/cloud-agent/contract.js (SHA-256 changed).
 * This file went red: the lowercase "running" rejection failed (exit 1).
 * The module was then restored to its exact original SHA-256.
 */

'use strict';

// Focused behavioural coverage for src/lib/cloud-agent/contract.js.
// Run alone with: node tests/cloud-agent/contract.test.js

const assert = require('node:assert/strict');
const contract = require('../../src/lib/cloud-agent/contract');
const { CloudAgentError } = require('../../src/lib/cloud-agent/errors');

const sha256 = character => character.repeat(64);

function requestInput(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'codex-cloud',
    environment: 'production-1',
    repository: { rootId: 'agent-mirror' },
    sourceRevision: 'a'.repeat(40),
    fileKeeperProof: { proofId: 'proof_12345678', treeSha256: sha256('b') },
    idempotencyKey: 'request_12345678',
    requiredModel: 'gpt-5.6',
    taskHash: sha256('c'),
    pathAllowlist: ['docs/guide.md', 'src/**'],
    byteBudget: 100,
    timeBudgetMs: 5_000,
    ...overrides
  };
}

function resultInput(request, overrides = {}) {
  return {
    schemaVersion: 1,
    requestHash: request.requestHash,
    providerTaskId: 'task_12345678',
    requestedModel: request.requiredModel,
    servedModel: 'gpt-5.6-2026-08-01',
    state: 'SUCCEEDED',
    createdAt: '2026-08-27T12:00:00.000Z',
    updatedAt: '2026-08-27T12:01:00.000Z',
    evidenceHashes: [sha256('e')],
    artifactManifest: [
      { path: 'src/z.js', sha256: sha256('f'), sizeBytes: 30 },
      { path: 'src/a.js', sha256: sha256('d'), sizeBytes: 20 }
    ],
    ...overrides
  };
}

function throwsCode(fn, expectedCode) {
  assert.throws(fn, error => {
    assert.ok(error instanceof CloudAgentError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

// Constants and state predicates expose the state vocabulary without accepting
// lookalikes or coercing non-string values.
assert.equal(contract.SCHEMA_VERSION, 1);
assert.deepEqual(contract.STATES, ['UNBOUND', 'READY', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']);
assert.deepEqual(contract.TERMINAL_STATES, ['SUCCEEDED', 'FAILED', 'CANCELLED']);
assert.equal(contract.isKnownState('RUNNING'), true);
assert.equal(contract.isKnownState('running'), false);
assert.equal(contract.isKnownState({ toString: () => 'RUNNING' }), false);
assert.equal(contract.isTerminalState('FAILED'), true);
assert.equal(contract.isTerminalState('RUNNING'), false);

// Request validation normalizes ordering, snapshots nested values, freezes the
// result, and binds every accepted value into a deterministic digest.
const input = requestInput({ pathAllowlist: ['src/**', 'docs/guide.md'] });
const request = contract.validateRequest(input);
assert.deepEqual(request.pathAllowlist, ['docs/guide.md', 'src/**']);
assert.equal(request.requestHash, '9f27fdcaa66c7e102dc7fe041c02143bb13c2df1fec113ece100176a3b83af0d');
assert.equal(Object.isFrozen(request), true);
assert.equal(Object.isFrozen(request.repository), true);
assert.equal(Object.isFrozen(request.fileKeeperProof), true);
assert.equal(Object.isFrozen(request.pathAllowlist), true);
input.repository.rootId = 'changed-after-validation';
assert.equal(request.repository.rootId, 'agent-mirror');
assert.notEqual(contract.validateRequest(requestInput({ taskHash: sha256('9') })).requestHash, request.requestHash);
throwsCode(() => contract.validateRequest({ ...requestInput(), surprise: true }), 'CLOUD_AGENT_CONTRACT_INVALID');
throwsCode(() => contract.validateRequest(requestInput({ schemaVersion: 2 })), 'CLOUD_AGENT_CONTRACT_VERSION_UNSUPPORTED');
throwsCode(() => contract.validateRequest(requestInput({ pathAllowlist: ['src/../secrets'] })), 'CLOUD_AGENT_CONTRACT_INVALID');

// The public digest is stable across object insertion order and separates
// kinds, rather than merely hashing JSON.stringify output.
assert.equal(contract.digest('sample', { b: 2, a: 1 }), contract.digest('sample', { a: 1, b: 2 }));
assert.notEqual(contract.digest('sample', { a: 1 }), contract.digest('other', { a: 1 }));

// Manifest validation returns immutable path-sorted snapshots. Allowlist
// matching honours path-segment boundaries, and the combined gate enforces
// both path authority and the aggregate byte budget.
const manifest = contract.validateManifest(resultInput(request).artifactManifest);
assert.deepEqual(manifest.map(entry => entry.path), ['src/a.js', 'src/z.js']);
assert.equal(Object.isFrozen(manifest), true);
assert.equal(Object.isFrozen(manifest[0]), true);
assert.equal(contract.matchesAllowlist('src', ['src/**']), true);
assert.equal(contract.matchesAllowlist('src/nested/file.js', ['src/**']), true);
assert.equal(contract.matchesAllowlist('src-escape/file.js', ['src/**']), false);
assert.equal(contract.matchesAllowlist('docs/guide.md', ['docs/guide.md']), true);
assert.equal(contract.assertManifestWithinBudget(request, manifest), true);
throwsCode(
  () => contract.assertManifestWithinBudget(request, contract.validateManifest([
    { path: 'private/key.txt', sha256: sha256('1'), sizeBytes: 1 }
  ])),
  'CLOUD_AGENT_MANIFEST_PATH_DENIED'
);
throwsCode(
  () => contract.assertManifestWithinBudget(request, contract.validateManifest([
    { path: 'src/large.bin', sha256: sha256('2'), sizeBytes: 101 }
  ])),
  'CLOUD_AGENT_MANIFEST_BUDGET_EXCEEDED'
);

// Results are normalized and bound to the originating request/model.
const result = contract.validateResult(resultInput(request));
assert.deepEqual(result.artifactManifest.map(entry => entry.path), ['src/a.js', 'src/z.js']);
assert.equal(Object.isFrozen(result), true);
assert.match(result.resultHash, /^[a-f0-9]{64}$/);
assert.equal(contract.assertResultMatchesRequest(request, result), true);
throwsCode(
  () => contract.assertResultMatchesRequest(
    contract.validateRequest(requestInput({ idempotencyKey: 'different_12345678' })),
    result
  ),
  'CLOUD_AGENT_REQUEST_MISMATCH'
);
throwsCode(() => contract.validateResult(resultInput(request, { state: 'DONE' })), 'CLOUD_AGENT_CONTRACT_INVALID');

// Timeout placeholders preserve prior evidence while accurately advancing the
// observation timestamp; an initial timeout has a null provider task id.
const later = '2026-08-27T12:02:00.000Z';
const unknown = contract.buildUnknownResult({ request, previous: result, now: () => later });
assert.deepEqual(
  {
    state: unknown.state,
    providerTaskId: unknown.providerTaskId,
    createdAt: unknown.createdAt,
    updatedAt: unknown.updatedAt,
    evidenceHashes: unknown.evidenceHashes,
    artifactManifest: unknown.artifactManifest
  },
  {
    state: 'UNKNOWN',
    providerTaskId: result.providerTaskId,
    createdAt: result.createdAt,
    updatedAt: later,
    evidenceHashes: result.evidenceHashes,
    artifactManifest: result.artifactManifest
  }
);
assert.equal(contract.buildUnknownResult({ request, previous: null, now: () => later }).providerTaskId, null);

// Capability and environment acknowledgements are value-validated snapshots.
const capabilities = contract.validateCapabilities({
  providerId: 'codex-cloud',
  models: ['gpt-5.6', 'gpt-5.5'],
  supportsCancel: true,
  maxByteBudget: 1_000,
  maxTimeBudgetMs: 60_000,
  localCli: { detected: true, version: '1.2.3-beta' }
});
assert.deepEqual(capabilities.models, ['gpt-5.5', 'gpt-5.6']);
assert.deepEqual(capabilities.localCli, { detected: true, version: '1.2.3-beta' });
assert.equal(Object.isFrozen(capabilities), true);
assert.equal(Object.isFrozen(capabilities.localCli), true);
throwsCode(
  () => contract.validateCapabilities({ ...capabilities, supportsCancel: 'yes' }),
  'CLOUD_AGENT_CONTRACT_INVALID'
);
const acknowledgement = contract.validateEnvironmentAck({ environmentRef: 'environment_12345678' });
assert.deepEqual(acknowledgement, { environmentRef: 'environment_12345678' });
assert.equal(Object.isFrozen(acknowledgement), true);

process.stdout.write('cloud-agent contract behaviour tests passed\n');

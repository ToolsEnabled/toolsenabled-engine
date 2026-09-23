// EXECUTABLE CHANGE
// Assertion strengthened: the generated-Python census now compares with the
// contract's fixed cardinality, rather than computing its expectation
// from the JavaScript implementation being checked.
// The current tool/local-model contract has 23 explicitly named codes below; the
// historical 16-code mutation proof is retained here as provenance.
// Mutation: removed INTERNAL_ERROR from the policy/JavaScript census and
// truncated the generated Python census. The former assertion stayed green:
//   "OLD ASSERTION GREEN under synchronized cardinality mutation: 15"
// The strengthened assertion went red:
//   "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"
//   "'15' !== '16'"
// Restoration: all three temporarily mutated product files were restored
// byte-for-byte (git status named only this test afterward).
// Final full-suite precondition not met: the available Node.js v20.20.2 lacks
// node:sqlite; the restored run stopped at load time with
//   "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite"
// and fetching Node 22 was forbidden by the registry (HTTP 403).
// NOT-FOUND (1): no assertion loop iterates a possibly empty collection; all
// loops use fixed nonempty test-owned fixtures, and the product census has an
// independent equality assertion against the fixed expected keys.
// NOT-FOUND (2): the Python exit status is accompanied by exact stdout and
// in-process assertions; no bare non-zero status or truthy return is evidence.
// NOT-FOUND (3): caught failures return a code/error that is asserted; no
// optional chain or catch silently accepts the failure under test.
// NOT-FOUND (4): collaborators are controlled inputs, not mocks of the
// error-taxonomy behavior asserted by the test.
// NOT-FOUND (5): there is no skip or platform precondition guard in this file.
// Shape (6) FOUND and fixed at the generated-Python cardinality assertion.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const errorTaxonomy = require('../src/lib/error-taxonomy');
const tasks = require('../src/lib/providers/tasks');
const { StateStoreError } = require('../src/lib/state-store');
const { toolError } = require('../src/mcp-server');
const bindings = require('../schemas/generated/platform.errors');
const { generate, pythonLiteral, validate: validateBindings } = require('../tools/generate-error-taxonomy-bindings');
const errorPolicy = require('../schemas/platform/error-policy.json');
const errorSchema = require('../schemas/platform/error.schema.json');

const expected = Object.freeze({
  INVALID_REQUEST: 'retry-after-input', POLICY_DENIED: 'terminal', APPROVAL_REQUIRED: 'retry-after-input',
  INPUT_REQUIRED: 'retry-after-input', AUTH_EXPIRED: 'retry-after-input', QUOTA_EXHAUSTED: 'retry-after-time',
  UNAVAILABLE: 'retry-after-time', TIMEOUT: 'retry-after-time', MALFORMED_OUTPUT: 'terminal',
  VERIFICATION_FAILED: 'terminal', STALE_DATA: 'retry-after-input', RESOURCE_PRESSURE: 'retry-after-time',
  INJECTION_DETECTED: 'terminal', SANDBOX_VIOLATION: 'terminal', EXTERNAL_CHANGE: 'retry-after-input',
  INTERNAL_ERROR: 'terminal', MODEL_PROVIDER_TIMED_OUT: 'retry-after-time',
  MODEL_OUTPUT_BUDGET_SPENT: 'retry-after-input', LOCAL_NODE_OUTPUT_BUDGET_SPENT: 'retry-after-input',
  LOCAL_NODE_GPU_REQUIRED: 'retry-after-input', LOCAL_NODE_GPU_UNVERIFIED: 'retry-after-input',
  MODEL_PROVIDER_INTERRUPTED: 'terminal', OPERATION_CANCELLED: 'terminal'
});

const representative = Object.freeze({
  INVALID_REQUEST: 'INVALID_ARGUMENT', POLICY_DENIED: 'POLICY_ACTION_DENIED', APPROVAL_REQUIRED: 'APPROVAL_EXPIRED',
  INPUT_REQUIRED: 'INPUT_MISSING', AUTH_EXPIRED: 'AUTH_REQUIRED', QUOTA_EXHAUSTED: 'RATE_LIMITED',
  UNAVAILABLE: 'ECONNREFUSED', TIMEOUT: 'ETIMEDOUT', MALFORMED_OUTPUT: 'PROVIDER_OUTPUT_INVALID',
  VERIFICATION_FAILED: 'VERIFY_FAILED', STALE_DATA: 'TASK_FENCE_LOST', RESOURCE_PRESSURE: 'RESOURCE_HEADROOM_LOW',
  INJECTION_DETECTED: 'PROMPT_INJECTION_DETECTED', SANDBOX_VIOLATION: 'SANDBOX_ESCAPE_ATTEMPT',
  EXTERNAL_CHANGE: 'SCHEDULER_FOREIGN_TASK', OPERATION_CANCELLED: 'ABORT_ERR'
});

function codeOf(fn) {
  try { fn(); }
  catch (error) { return error.code; }
  return null;
}

(async () => {
  generate({ check: true });
  assert.deepEqual(new Set(errorTaxonomy.ERROR_CODE_VALUES), new Set(Object.keys(expected)));
  assert.equal(errorTaxonomy.RETRY_CEILINGS.global, 3);
  assert.equal(errorTaxonomy.RETRY_CEILINGS['external-write'], 2);

  for (const [code, classification] of Object.entries(expected)) {
    const failure = errorTaxonomy.publicFailure({ code });
    assert.equal(failure.code, code);
    assert.equal(failure.classification, classification);
    assert.equal(failure.retryable, classification === 'retry-after-time');
    assert.doesNotThrow(() => errorTaxonomy.assertPublicFailure(failure));
    assert.doesNotThrow(() => bindings.validatePublicFailure(failure));
    const decision = errorTaxonomy.decideRetry(failure, { effect: 'external-read', attempt: 1 });
    if (classification === 'terminal') assert.equal(decision.disposition, 'failed', `${code} must be terminal`);
    else if (classification === 'retry-after-input') assert.equal(decision.disposition, 'blocked', `${code} must wait for new input`);
    else assert.equal(decision.disposition, 'retry', `${code} must be retryable`);
  }

  for (const [expectedCode, sourceCode] of Object.entries(representative)) {
    assert.equal(errorTaxonomy.publicFailure({ code: sourceCode }).code, expectedCode, `${sourceCode} must map without prose parsing`);
  }
  assert.equal(errorTaxonomy.publicFailure({ code: 'TIMEOUT' }, { injectionDetected: true }).code, 'INJECTION_DETECTED');
  const localVerificationFailure = toolError(Object.assign(new Error('private provider verification output'), {
    code: 'SIGNATURE_INVALID'
  }));
  assert.equal(localVerificationFailure.structuredContent.error.code, 'SIGNATURE_INVALID');
  assert.equal(localVerificationFailure.structuredContent.error.taxonomy.code, 'VERIFICATION_FAILED');
  assert.equal(localVerificationFailure.content[0].text, 'The result could not be verified and was not accepted.');
  assert.doesNotMatch(localVerificationFailure.content[0].text, /private provider verification output/);
  assert.doesNotMatch(JSON.stringify(localVerificationFailure), /private provider verification output/);
  assert.equal(errorTaxonomy.publicFailure(Object.create({ code: 'TIMEOUT' })).code, 'INTERNAL_ERROR', 'inherited source code must not steer a retry');
  for (const unconfirmedCancellation of [
    { name: 'AbortError', message: 'The operation was cancelled.' },
    { code: 'ABORT_ERR_EXTRA' }, { code: 'OTHER_ABORT_ERR' }, Object.create({ code: 'ABORT_ERR' })
  ]) {
    assert.equal(errorTaxonomy.publicFailure(unconfirmedCancellation).code, 'INTERNAL_ERROR',
      'only the exact own structured cancellation code may establish cancellation');
  }
  assert.equal(errorTaxonomy.publicFailure({ code: 'ABORT_ERR', timedOut: true }).code, 'TIMEOUT');
  for (const [observation, expectedCode] of [
    ['timedOut', 'TIMEOUT'], ['injectionDetected', 'INJECTION_DETECTED'], ['sandboxViolation', 'SANDBOX_VIOLATION']
  ]) {
    assert.equal(errorTaxonomy.publicFailure({ code: 'ABORT_ERR' }, { [observation]: true }).code, expectedCode,
      'explicit adapter observations retain precedence over a source cancellation code');
  }
  const cancelled = errorTaxonomy.publicFailure({ code: 'ABORT_ERR' }, { retryAfterMs: 1 });
  assert.equal(Object.hasOwn(cancelled, 'retryAfterMs'), false);
  assert.equal(errorTaxonomy.decideRetry(cancelled, { effect: 'external-write', attempt: 1 }).disposition, 'failed');

  const unknownWithProviderProse = errorTaxonomy.publicFailure({
    code: 'UNCLASSIFIED_LEGACY',
    message: 'rate limit api-key sk_live_secret_please_retry'
  });
  assert.equal(unknownWithProviderProse.code, 'INTERNAL_ERROR', 'unstructured prose must not drive classification');
  assert.doesNotMatch(JSON.stringify(unknownWithProviderProse), /sk_live|rate limit/i);

  const timeout = errorTaxonomy.publicFailure({ code: 'ETIMEDOUT', message: 'secret timeout detail' });
  assert.equal(errorTaxonomy.decideRetry(timeout, { effect: 'external-write', sideEffect: true, attempt: 1 }).disposition, 'uncertain');
  assert.equal(errorTaxonomy.decideRetry(timeout, {
    effect: 'external-write', sideEffect: true, idempotencyKey: 'p15-side-effect-0001', attempt: 1
  }).reason, 'reconciliation-required');
  assert.equal(errorTaxonomy.decideRetry(timeout, {
    effect: 'external-write', sideEffect: true, idempotencyKey: 'p15-side-effect-0001', reconcile: true, attempt: 1
  }).disposition, 'retry');
  assert.equal(errorTaxonomy.decideRetry(timeout, {
    effect: 'external-write', sideEffect: true, idempotencyKey: 'p15-side-effect-0001', reconcile: true, attempt: 2
  }).reason, 'retry-ceiling-reached');
  for (const hostileEffect of ['toString', '__proto__']) {
    assert.equal(errorTaxonomy.operationCeiling({ effect: hostileEffect }), 3);
    const decision = errorTaxonomy.decideRetry(timeout, { effect: hostileEffect, attempt: 1 });
    assert.equal(decision.maxAttempts, 3);
    assert.equal(decision.disposition, 'retry');
  }
  assert.equal(errorTaxonomy.operationCeiling(Object.create({ effect: 'external-write' })), 3);

  let effects = 0;
  const reconciled = await errorTaxonomy.runIdempotentSideEffect({
    idempotencyKey: 'p15-side-effect-0002',
    execute: async ({ idempotencyKey, attempt }) => {
      assert.equal(idempotencyKey, 'p15-side-effect-0002');
      effects += 1;
      assert.equal(attempt, 1);
      const error = new Error('provider body with token sk_live_must_not_leave_process');
      error.code = 'ETIMEDOUT';
      throw error;
    },
    reconcile: async ({ idempotencyKey }) => {
      assert.equal(idempotencyKey, 'p15-side-effect-0002');
      return { status: 'succeeded', value: { providerId: 'fixed-provider-id' } };
    }
  });
  assert.equal(effects, 1, 'a timeout after a side effect must reconcile, not invoke it again');
  assert.equal(reconciled.replayed, true);
  assert.deepEqual(reconciled.value, { providerId: 'fixed-provider-id' });

  let ambiguousEffects = 0;
  const ambiguousCode = await (async () => {
    try {
      await errorTaxonomy.runIdempotentSideEffect({
        idempotencyKey: 'p15-side-effect-0003',
        execute: async () => {
          ambiguousEffects += 1;
          const error = new Error('ambiguous');
          error.code = 'ETIMEDOUT';
          throw error;
        },
        reconcile: async () => ({ status: 'unknown' })
      });
    } catch (error) { return error.code; }
    return null;
  })();
  assert.equal(ambiguousEffects, 1);
  assert.equal(ambiguousCode, 'TIMEOUT');
  const reconciliationFailure = await (async () => {
    try {
      await errorTaxonomy.runIdempotentSideEffect({
        idempotencyKey: 'p15-side-effect-0004',
        execute: async () => {
          const error = new Error('provider timeout');
          error.code = 'ETIMEDOUT';
          throw error;
        },
        reconcile: async () => {
          const error = new Error('reconcile secret must stay protected');
          error.code = 'ECONNREFUSED';
          throw error;
        }
      });
    } catch (error) { return error; }
    return null;
  })();
  assert.equal(reconciliationFailure.code, 'TIMEOUT');
  assert.doesNotMatch(reconciliationFailure.message, /reconcile secret/i);
  assert.equal(await (async () => {
    try { await errorTaxonomy.runIdempotentSideEffect(null); }
    catch (error) { return error.code; }
    return null;
  })(), 'INVALID_REQUEST');
  assert.equal(codeOf(() => errorTaxonomy.assertPublicFailure({ schemaVersion: '1.0.0', code: 'TIMEOUT', classification: 'terminal', retryable: false, safeSummary: 'forged' })), 'INVALID_REQUEST');
  const timeoutWithoutDelay = { ...errorTaxonomy.publicFailure({ code: 'TIMEOUT' }) };
  delete timeoutWithoutDelay.retryAfterMs;
  assert.equal(codeOf(() => errorTaxonomy.assertPublicFailure(timeoutWithoutDelay)), 'INVALID_REQUEST');
  assert.equal(codeOf(() => errorTaxonomy.decideRetry(timeoutWithoutDelay)), 'INVALID_REQUEST');
  const immediateRetry = { ...errorTaxonomy.publicFailure({ code: 'TIMEOUT' }), retryAfterMs: 0 };
  assert.equal(errorTaxonomy.decideRetry(immediateRetry).retryAfterMs, 0);
  for (const invalidRetryAfterMs of [-1, 3_600_001]) {
    const bounded = errorTaxonomy.publicFailure(new errorTaxonomy.TypedOperationalError('TIMEOUT', { retryAfterMs: invalidRetryAfterMs }));
    assert.equal(bounded.retryAfterMs, 5000);
    assert.doesNotThrow(() => errorTaxonomy.assertPublicFailure(bounded));
  }
  const mutatedRetryHint = new errorTaxonomy.TypedOperationalError('TIMEOUT');
  mutatedRetryHint.retryAfterMs = -1;
  const mutationBounded = errorTaxonomy.publicFailure(mutatedRetryHint);
  assert.equal(mutationBounded.retryAfterMs, 5000);
  assert.doesNotThrow(() => errorTaxonomy.assertPublicFailure(mutationBounded));
  const terminalRetryHint = new errorTaxonomy.TypedOperationalError('POLICY_DENIED');
  terminalRetryHint.retryAfterMs = 1;
  const terminalBounded = errorTaxonomy.publicFailure(terminalRetryHint);
  assert.equal(Object.hasOwn(terminalBounded, 'retryAfterMs'), false);
  assert.equal(codeOf(() => errorTaxonomy.assertPublicFailure({ ...terminalBounded, retryAfterMs: 1 })), 'INVALID_REQUEST');
  assert.throws(() => bindings.validatePublicFailure({ ...terminalBounded, retryAfterMs: 1 }), /invalid/);
  const inheritedEnvelope = Object.create(errorTaxonomy.publicFailure({ code: 'TIMEOUT' }));
  assert.equal(codeOf(() => errorTaxonomy.assertPublicFailure(inheritedEnvelope)), 'INVALID_REQUEST');
  assert.throws(() => bindings.validatePublicFailure(inheritedEnvelope), /invalid/);

  const malformedSchema = structuredClone(errorSchema);
  delete malformedSchema.additionalProperties;
  malformedSchema.required = [];
  malformedSchema.properties.safeSummary.maxLength = 999999;
  assert.throws(() => validateBindings(errorPolicy, malformedSchema), /closed and fully bounded/);
  const missingSemanticSchema = structuredClone(errorSchema);
  delete missingSemanticSchema.allOf;
  assert.throws(() => validateBindings(errorPolicy, missingSemanticSchema), /closed and fully bounded/);
  const malformedPolicy = structuredClone(errorPolicy);
  malformedPolicy.codes.find(item => item.code === 'TIMEOUT').defaultRetryAfterMs = 3_600_001;
  assert.throws(() => validateBindings(malformedPolicy, errorSchema), /Invalid P15 taxonomy entry/);
  const missingCeilings = structuredClone(errorPolicy);
  missingCeilings.operationRetryCeilings = {};
  assert.throws(() => validateBindings(missingCeilings, errorSchema), /retry ceiling keys/);
  const terminalRetryDelay = structuredClone(errorPolicy);
  terminalRetryDelay.codes.find(item => item.code === 'POLICY_DENIED').defaultRetryAfterMs = 1;
  assert.throws(() => validateBindings(terminalRetryDelay, errorSchema), /Invalid P15 taxonomy entry/);
  const missingFallback = structuredClone(errorPolicy);
  missingFallback.codes = missingFallback.codes.filter(item => item.code !== 'INTERNAL_ERROR');
  assert.throws(() => validateBindings(missingFallback, errorSchema), /closed and schema-aligned/);
  assert.match(pythonLiteral({ safeSummary: 'true false null' }), /"true false null"/);

  const protectedFailure = toolError(new StateStoreError('OPERATION_UNCERTAIN', 'provider detail secret-value', { operationId: 'private-operation' }));
  assert.equal(protectedFailure.structuredContent.error.code, 'OPERATION_UNCERTAIN');
  assert.equal(protectedFailure.structuredContent.error.taxonomy.code, 'INTERNAL_ERROR');
  assert.equal(protectedFailure.structuredContent.error.taxonomy.classification, 'terminal');
  assert.doesNotMatch(JSON.stringify(protectedFailure.structuredContent.error.taxonomy), /secret-value|private-operation|OPERATION_UNCERTAIN/);
  assert.doesNotMatch(protectedFailure.content[0].text, /secret-value|private-operation|OPERATION_UNCERTAIN/);
  assert.doesNotMatch(JSON.stringify(protectedFailure), /secret-value|private-operation/);

  const cancelledFailure = toolError(new StateStoreError('ABORT_ERR', 'provider detail secret-value', { operationId: 'private-operation' }));
  assert.equal(cancelledFailure.structuredContent.error.taxonomy.code, 'OPERATION_CANCELLED');
  assert.equal(cancelledFailure.structuredContent.error.taxonomy.classification, 'terminal');
  assert.equal(cancelledFailure.structuredContent.error.taxonomy.retryable, false);
  assert.equal(cancelledFailure.structuredContent.error.message, 'The operation was cancelled.');
  assert.equal(cancelledFailure.content[0].text, 'The operation was cancelled.');
  assert.doesNotMatch(JSON.stringify(cancelledFailure), /secret-value|private-operation/);
  assert.equal(errorTaxonomy.publicFailure({ code: 'NOT_ABORT_ERR' }).code, 'INTERNAL_ERROR');
  assert.equal(errorTaxonomy.publicFailure({ code: 'ABORT_ERR', timedOut: true }).code, 'TIMEOUT');

  const HANDLE = { taskId: 'task-p15-00000001', attempt: 1, workerLabel: 'p15-worker', claimToken: 'A'.repeat(43), fence: 1 };
  const task = await tasks.get({ taskId: HANDLE.taskId, includePayload: false, includeCheckpoint: false }, { state: {
    getTask: () => ({ id: HANDLE.taskId, queue: 'p15', type: 'test', status: 'failed', attempt: 1, maxAttempts: 2,
      expiryPolicy: 'retry', error: { code: 'SCHEDULER_FOREIGN_TASK', message: 'legacy compatibility detail' } })
  } });
  assert.equal(task.error.code, 'SCHEDULER_FOREIGN_TASK');
  assert.equal(task.error.taxonomy.code, 'EXTERNAL_CHANGE');
  assert.equal(task.error.taxonomy.classification, 'retry-after-input');

  const python = require('./lib/platform-contract-fixture').machineWidePython();
  const py = spawnSync(python, ['-B', '-c', [
    'import sys, json',
    'from collections.abc import Mapping',
    "sys.path.insert(0, 'schemas/generated')",
    'import coordinator_platform_errors as e',
    "item=e.validate_public_failure({'schemaVersion':'1.0.0','code':'TIMEOUT','classification':'retry-after-time','retryable':True,'safeSummary':'The operation did not finish before its safety deadline.'})",
    "assert item['code'] == 'TIMEOUT'",
    "cancelled=e.validate_public_failure({'schemaVersion':'1.0.0','code':'OPERATION_CANCELLED','classification':'terminal','retryable':False,'safeSummary':'The operation was cancelled.'})",
    "assert cancelled['code'] == 'OPERATION_CANCELLED' and cancelled['retryable'] is False",
    "exec(\"class Sneaky(Mapping):\\n    def __iter__(self): return iter(())\\n    def __len__(self): return 0\\n    def __getitem__(self, key): raise KeyError(key)\\n    def get(self, key, default=None): return {'schemaVersion':'1.0.0','code':'TIMEOUT','classification':'retry-after-time','retryable':True,'safeSummary':'The operation did not finish before its safety deadline.'}.get(key, default)\\ntry:\\n    e.validate_public_failure(Sneaky())\\nexcept ValueError:\\n    pass\\nelse:\\n    raise AssertionError('sneaky mapping accepted')\")",
    "exec(\"try:\\n    e.validate_public_failure({'schemaVersion':'1.0.0','code':'TIMEOUT','classification':'retry-after-time','retryable':True,'safeSummary':'The operation did not finish before its safety deadline.','retryAfterMs':None})\\nexcept ValueError:\\n    pass\\nelse:\\n    raise AssertionError('null retryAfterMs accepted')\")",
    'print(json.dumps(e.ERROR_CODE_VALUES))'
  ].join(';')], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(new Set(JSON.parse(py.stdout)), new Set(Object.keys(expected)));

  console.log('Unified-agent P15 error taxonomy tests passed.');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

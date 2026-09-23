/*
 * Mutation check: changed !Array.isArray(value) to Array.isArray(value) in isPlainObject.
 * The module edit landed: yes.
 * This isolated test file went red: yes (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const safety = require('../src/lib/providers/provider-safety');

function throwsCode(fn, code) {
  let error;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error, `expected ${code} to be thrown`);
  assert.equal(error.code, code);
}

(async () => {
  assert.equal(safety.isPlainObject({}), true);
  assert.equal(safety.isPlainObject(Object.create(null)), true);
  assert.equal(safety.isPlainObject([]), false);
  assert.deepEqual(safety.exactKeys({ vaultKey: 'billing-key' }, ['vaultKey'], 'input'), { vaultKey: 'billing-key' });
  assert.throws(() => safety.exactKeys({ apiKey: 'literal' }, ['apiKey'], 'input'), /credentials must be supplied only by vaultKey/);

  assert.equal(safety.text('region-1', 'region', 20, /^[a-z0-9-]+$/), 'region-1');
  assert.equal(safety.optionalText(undefined, 'note', 20), undefined);
  assert.equal(safety.vaultKey(undefined, 'default-key'), 'default-key');
  assert.equal(safety.idempotencyKey('request:12345678'), 'request:12345678');
  assert.equal(safety.positiveInteger(3, 'count', 5), 3);
  assert.equal(safety.boundedInteger(undefined, 'limit', 10, 1, 20), 10);
  assert.throws(() => safety.positiveInteger(0, 'count', 5), /1 through 5/);
  assert.throws(() => safety.boundedInteger(21, 'limit', 10, 1, 20), /1 through 20/);

  const secret = 's3cr+t/value';
  assert.equal(safety.secretValue(() => secret, 'provider-key'), secret);
  throwsCode(() => safety.secretValue(() => { throw new Error(`leaked ${secret}`); }, 'provider-key'), 'VAULT_SECRET_UNAVAILABLE');
  assert.equal(safety.redactText(`raw=${secret} encoded=${encodeURIComponent(secret)} b64=${Buffer.from(secret).toString('base64')}`, secret),
    'raw=[REDACTED] encoded=[REDACTED] b64=[REDACTED]');
  assert.deepEqual(safety.safeObject({ note: `value ${secret}`, apiToken: secret, nested: ['ok', secret] }, secret), {
    note: 'value [REDACTED]', apiToken: '[REDACTED]', nested: ['ok', '[REDACTED]']
  });
  assert.deepEqual(safety.UNTRUSTED_CONTENT, { contentTrust: 'untrusted', grantsAuthority: false });
  assert.equal(Object.isFrozen(safety.UNTRUSTED_CONTENT), true);

  const calls = [];
  const state = {
    reserveOperation(request) { calls.push(['reserve', request]); return { disposition: 'reserved', handle: 'h1' }; },
    markOperationExecuting(handle, options) { calls.push(['executing', handle, options]); return { handle: 'h2' }; },
    succeedOperation(handle, options) { calls.push(['succeed', handle, options]); }
  };
  let began;
  const result = await safety.mutate({
    state, hashInput: input => `hash:${input.id}`, now: () => 123, type: 'create', key: 'request:12345678', input: { id: 7 },
    execute: async markAttempted => { markAttempted(); began = true; return { providerId: 'p7' }; }
  });
  assert.equal(began, true);
  assert.deepEqual(result, { providerId: 'p7', replayed: false });
  assert.equal(calls[0][1].inputHash, 'hash:7');
  assert.match(calls[0][1].ownerId, /^provider-operation-[a-f0-9]{32}$/);
  assert.deepEqual(calls.at(-1), ['succeed', 'h2', { result: { providerId: 'p7' } }]);

  const replay = await safety.mutate({
    state: { reserveOperation: () => ({ disposition: 'replay', result: { providerId: 'p7' } }) },
    hashInput: () => 'unused', now: () => 0, type: 'create', key: 'request:12345678', input: {},
    execute: async () => assert.fail('replays must not execute the provider request')
  });
  assert.deepEqual(replay, { providerId: 'p7', replayed: true });

  // A replay without a durable result must refuse before executing or writing
  // any additional operation state.
  {
    const replayCalls = [];
    const replayState = {
      reserveOperation(request) {
        replayCalls.push(['reserve', request]);
        return { disposition: 'replay', result: null };
      },
      markOperationExecuting() { replayCalls.push(['executing']); },
      succeedOperation() { replayCalls.push(['succeed']); },
      failOperation() { replayCalls.push(['fail']); },
      markOperationUncertain() { replayCalls.push(['uncertain']); }
    };
    let executions = 0;
    await assert.rejects(
      safety.mutate({
        state: replayState, hashInput: () => 'replay-hash', now: () => 0,
        type: 'create', key: 'request:replay1', input: {},
        execute: async () => { executions += 1; }
      }),
      error => error.code === 'OPERATION_REPLAY_RESULT_UNAVAILABLE'
    );
    assert.equal(executions, 0);
    assert.deepEqual(replayCalls.map(call => call[0]), ['reserve']);
  }

  // An unusable reservation must similarly stop before execution or any state
  // transition following reserveOperation.
  {
    const reservationCalls = [];
    const reservationState = {
      reserveOperation(request) {
        reservationCalls.push(['reserve', request]);
        return { disposition: 'busy', handle: null };
      },
      markOperationExecuting() { reservationCalls.push(['executing']); },
      succeedOperation() { reservationCalls.push(['succeed']); },
      failOperation() { reservationCalls.push(['fail']); },
      markOperationUncertain() { reservationCalls.push(['uncertain']); }
    };
    let executions = 0;
    await assert.rejects(
      safety.mutate({
        state: reservationState, hashInput: () => 'reservation-hash', now: () => 0,
        type: 'create', key: 'request:reserve1', input: {},
        execute: async () => { executions += 1; }
      }),
      error => error.code === 'OPERATION_RESERVATION_FAILED'
    );
    assert.equal(executions, 0);
    assert.deepEqual(reservationCalls.map(call => call[0]), ['reserve']);
  }

  // A failure before markAttempted is rethrown unchanged and durably classified
  // as retryable PRE_REQUEST_FAILED; it is never recorded as success/uncertain.
  {
    const preRequestError = new Error('local preparation failed');
    const preRequestCalls = [];
    const preRequestState = {
      reserveOperation() { return { disposition: 'reserved', handle: 'pre-h1' }; },
      markOperationExecuting() { return { handle: 'pre-h2' }; },
      failOperation(handle, details) { preRequestCalls.push(['fail', handle, details]); },
      succeedOperation() { preRequestCalls.push(['succeed']); },
      markOperationUncertain() { preRequestCalls.push(['uncertain']); }
    };
    await assert.rejects(
      safety.mutate({
        state: preRequestState, hashInput: () => 'pre-hash', now: () => 456,
        type: 'create', key: 'request:before1', input: {},
        execute: async () => { throw preRequestError; }
      }),
      error => error === preRequestError
    );
    assert.deepEqual(preRequestCalls, [[
      'fail', 'pre-h2', {
        errorCode: 'PRE_REQUEST_FAILED',
        errorMessage: 'The provider request did not begin; retry may be safe after correction.',
        retryAtMs: 456
      }
    ]]);
  }

  // Once markAttempted has run, an uncoded provider failure is rethrown and the
  // only durable write classifies the unknown external outcome as uncertain.
  {
    const providerError = new Error('connection dropped');
    const attemptedCalls = [];
    const attemptedState = {
      reserveOperation() { return { disposition: 'reserved', handle: 'external-h1' }; },
      markOperationExecuting() { return { handle: 'external-h2' }; },
      markOperationUncertain(handle, details) { attemptedCalls.push(['uncertain', handle, details]); },
      succeedOperation() { attemptedCalls.push(['succeed']); },
      failOperation() { attemptedCalls.push(['fail']); }
    };
    await assert.rejects(
      safety.mutate({
        state: attemptedState, hashInput: () => 'external-hash', now: () => 789,
        type: 'create', key: 'request:external1', input: {},
        execute: async markAttempted => { markAttempted(); throw providerError; }
      }),
      error => error === providerError
    );
    assert.deepEqual(attemptedCalls, [[
      'uncertain', 'external-h2', {
        errorCode: 'EXTERNAL_OUTCOME_UNCERTAIN',
        errorMessage: 'The provider request began; its outcome is uncertain and automatic replay is blocked.'
      }
    ]]);
  }

  console.log('provider-safety behavior tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

/*
 * Driven refusal coverage for the Paddle provider.  The accompanying report
 * records the per-code mutation runs; these assertions use the public module
 * functions rather than inspecting its source.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
// Node 20 in the isolated runner has no node:sqlite.  Every driven call below
// injects its own state store, so prevent the unused production default from
// loading sqlite merely as a side effect of requiring the provider.
const stateStorePath = require.resolve('../src/lib/state-store');
require.cache[stateStorePath] = { id: stateStorePath, filename: stateStorePath, loaded: true,
  exports: { getStateStore: () => { throw new Error('test must inject state'); }, hashInput: JSON.stringify } };
const paddle = require('../src/lib/providers/paddle');

const NOW_SECONDS = 1_700_000_000;
const SECRET = 'paddle_test_only_secret';
const ID = 'a'.repeat(26);
const PROFILE = {
  environment: 'sandbox', apiRoot: 'https://sandbox-api.paddle.com',
  apiVaultKey: 'PADDLE_SANDBOX_API_KEY', webhookVaultKey: 'PADDLE_SANDBOX_WEBHOOK_SECRET',
  chargesRealMoney: false
};
const licensing = {
  fulfillableTiers: () => ['pro'],
  requiredMetadata: () => ({ tier: 'toolsenabled_tier', pairId: 'toolsenabled_pair_id' })
};

function stateSpy() {
  const calls = [];
  return {
    calls,
    reserveOperation(value) { calls.push(['reserve', value]); return { disposition: 'reserved', handle: 'reserved' }; },
    markOperationExecuting(handle) { calls.push(['executing', handle]); return { handle: 'executing' }; },
    succeedOperation(handle, value) { calls.push(['succeed', handle, value]); },
    failOperation(handle, value) { calls.push(['fail', handle, value]); },
    markOperationUncertain(handle, value) { calls.push(['uncertain', handle, value]); }
  };
}

function harness(options = {}) {
  const effects = { requests: [], records: [], policy: [], state: stateSpy() };
  const overrides = {
    resolveEnvironment: () => ({ profile: PROFILE, recorded: true, reason: 'recorded' }),
    getSecret: () => SECRET,
    assertActive: (...args) => effects.policy.push(args),
    record: (...args) => effects.records.push(args),
    request: async (url, init) => {
      effects.requests.push([url, init]);
      if (options.request) return options.request(url, init, effects.requests.length);
      return { status: 200, body: { data: {} } };
    },
    state: effects.state,
    hashInput: value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    now: () => NOW_SECONDS * 1000,
    licensing: options.noLicensing ? null : licensing
  };
  return { effects, overrides };
}

function code(error, expected) { return Boolean(error) && error.code === expected; }
function transactionInput(extra = {}) {
  return { priceId: `pri_${ID}`, quantity: 1, tier: 'pro', pairId: 'pair-1234',
    returnUrl: 'https://merchant.example/complete', vaultKey: PROFILE.apiVaultKey,
    idempotencyKey: 'checkout-refusal-0001', ...extra };
}

async function main() {
  let h = harness();
  await assert.rejects(paddle.doctor({ vaultKey: 'PADDLE_LIVE_API_KEY' }, h.overrides),
    error => code(error, 'PADDLE_API_VAULT_KEY_INVALID'));
  assert.deepEqual(h.effects, { requests: [], records: [], policy: [], state: h.effects.state });

  h = harness();
  await assert.rejects(paddle.transactionCreate(transactionInput({ returnUrl: 'http://merchant.example' }), h.overrides),
    error => code(error, 'PADDLE_CHECKOUT_RETURN_URL_INVALID'));
  assert.equal(h.effects.requests.length + h.effects.records.length + h.effects.state.calls.length, 0);

  h = harness({ noLicensing: true });
  await assert.rejects(paddle.transactionCreate(transactionInput(), h.overrides),
    error => code(error, 'PADDLE_CHECKOUT_UNAVAILABLE_IN_THIS_BUILD'));
  assert.equal(h.effects.requests.length + h.effects.records.length + h.effects.state.calls.length, 0);

  h = harness();
  await assert.rejects(paddle.transactionCreate(transactionInput({ tier: 'enterprise' }), h.overrides),
    error => code(error, 'PADDLE_CHECKOUT_TIER_UNFULFILLABLE'));
  assert.equal(h.effects.requests.length + h.effects.records.length + h.effects.state.calls.length, 0);

  for (const [name, response, expected] of [
    ['lost custom data', { id: `txn_${ID}`, status: 'draft', custom_data: {} }, 'PADDLE_CHECKOUT_CUSTOM_DATA_LOST'],
    ['missing URL', { id: `txn_${ID}`, status: 'draft', custom_data: { toolsenabled_tier: 'pro', toolsenabled_pair_id: 'pair-1234' } }, 'PADDLE_CHECKOUT_URL_MISSING'],
    ['invalid URL', { id: `txn_${ID}`, status: 'draft', checkout: { url: 'not a URL' }, custom_data: { toolsenabled_tier: 'pro', toolsenabled_pair_id: 'pair-1234' } }, 'PADDLE_CHECKOUT_URL_INVALID']
  ]) {
    h = harness({ request: async () => ({ status: 200, body: { data: response } }) });
    await assert.rejects(paddle.transactionCreate(transactionInput({ idempotencyKey: `checkout-${name.replaceAll(' ', '-')}-0001` }), h.overrides),
      error => code(error, expected));
    assert.equal(h.effects.requests.length, 1, `${name}: only the transaction creation request occurred`);
    assert.equal(h.effects.requests[0][1].method, 'POST');
    assert.equal(h.effects.records.length, 0, `${name}: refused checkout was not audited as successful`);
    assert.equal(h.effects.state.calls.at(-1)[0], 'uncertain', `${name}: begun request is not marked safely retryable`);
  }

  h = harness({ request: async () => ({ status: 200, body: { data: null } }) });
  await assert.rejects(paddle.transactionGet({ transactionId: `txn_${ID}`, vaultKey: PROFILE.apiVaultKey }, h.overrides),
    error => code(error, 'PADDLE_INVALID_RESPONSE'));
  assert.equal(h.effects.requests.length, 1);
  assert.equal(h.effects.records.length, 0);

  h = harness({ request: async () => { throw new Error('network detail must be hidden'); } });
  await assert.rejects(paddle.doctor({ vaultKey: PROFILE.apiVaultKey }, h.overrides), error =>
    code(error, 'PADDLE_REQUEST_FAILED') && !error.message.includes('network detail'));
  assert.equal(h.effects.requests.length, 1);
  assert.equal(h.effects.records.length, 0);

  h = harness();
  await assert.rejects(paddle.transactionCancel({ transactionId: `txn_${ID}`, expectedStatus: 'completed',
    vaultKey: PROFILE.apiVaultKey, idempotencyKey: 'cancel-not-allowed-0001' }, h.overrides),
  error => code(error, 'PADDLE_TRANSACTION_NOT_CANCELLABLE'));
  assert.equal(h.effects.requests.length + h.effects.records.length + h.effects.state.calls.length, 0);

  h = harness({ request: async () => ({ status: 200, body: { data: { id: `txn_${ID}`, status: 'completed' } } }) });
  await assert.rejects(paddle.transactionCancel({ transactionId: `txn_${ID}`, expectedStatus: 'ready',
    vaultKey: PROFILE.apiVaultKey, idempotencyKey: 'cancel-fence-refusal-0001' }, h.overrides),
  error => code(error, 'PADDLE_TRANSACTION_CANCEL_FENCE_MISMATCH'));
  assert.equal(h.effects.requests.length, 1);
  assert.equal(h.effects.requests[0][1].method, 'GET');
  assert.equal(h.effects.records.length, 0);
  assert.equal(h.effects.state.calls.at(-1)[0], 'fail');

  const subscription = { subscriptionId: `sub_${ID}`, effectiveFrom: 'immediately', expectedStatus: 'paused',
    expectedUpdatedAt: '2026-08-27T12:00:00Z', vaultKey: PROFILE.apiVaultKey, idempotencyKey: 'subscription-refusal-0001' };
  h = harness();
  await assert.rejects(paddle.subscriptionCancel(subscription, h.overrides),
    error => code(error, 'PADDLE_SUBSCRIPTION_NOT_CANCELLABLE'));
  assert.equal(h.effects.requests.length + h.effects.records.length + h.effects.state.calls.length, 0);

  h = harness({ request: async () => ({ status: 200, body: { data: { id: `sub_${ID}`, status: 'active', updated_at: '2026-08-27T12:00:01Z' } } }) });
  await assert.rejects(paddle.subscriptionCancel({ ...subscription, expectedStatus: 'active', idempotencyKey: 'subscription-fence-0001' }, h.overrides),
    error => code(error, 'PADDLE_SUBSCRIPTION_CANCEL_FENCE_MISMATCH'));
  assert.equal(h.effects.requests.length, 1);
  assert.equal(h.effects.requests[0][1].method, 'GET');
  assert.equal(h.effects.records.length, 0);
  assert.equal(h.effects.state.calls.at(-1)[0], 'fail');

  h = harness();
  assert.throws(() => paddle.webhookVerify({ payload: '', signatureHeader: 'ts=1;h1=' + '0'.repeat(64),
    webhookVaultKey: PROFILE.webhookVaultKey }, h.overrides), error => code(error, 'PADDLE_WEBHOOK_PAYLOAD_INVALID'));
  assert.equal(h.effects.requests.length + h.effects.records.length + h.effects.state.calls.length, 0);

  process.stdout.write('providers-paddle driven refusals: ok\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });

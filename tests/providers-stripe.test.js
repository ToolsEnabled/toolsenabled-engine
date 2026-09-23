/* Mutation check for the Stripe daily-limit cents conversion.
 * Exact mutation: Math.round(limit * 100) -> Math.round(limit).
 * The module edit landed: yes (one replacement).
 * The isolated test went red: yes (exit code 1; expected 1234, received 12).
 */
'use strict';

const assert = require('node:assert/strict');

const runtimePath = require.resolve('../src/lib/runtime');
const policyPath = require.resolve('../src/lib/policy');
const auditPath = require.resolve('../src/lib/audit');
const httpPath = require.resolve('../src/lib/http');
const payPath = require.resolve('../src/lib/providers/pay');
const stripePath = require.resolve('../src/lib/providers/stripe');

const calls = { policies: [], audits: [], requests: [], caps: [], secrets: [] };
const mock = (filename, exports) => {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

mock(runtimePath, { getSecret(name) { calls.secrets.push(name); return 'rk_test_value'; } });
mock(policyPath, { assertActive(action) { calls.policies.push(action); } });
mock(auditPath, { record(...args) { calls.audits.push(args); } });
mock(payPath, { check(input) { calls.caps.push(input); return { allowed: true, limitUsd: 500 }; } });
mock(httpPath, {
  async request(url, options) {
    calls.requests.push({ url, ...options, form: Object.fromEntries(options.body) });
    if (url.endsWith('/cardholders')) {
      return { body: { id: 'ich_123', object: 'issuing.cardholder', type: 'company', status: 'active', requirements: { disabled_reason: null }, livemode: false } };
    }
    return { body: { id: 'ic_123', object: 'issuing.card', cardholder: { id: 'ich_123' }, type: 'virtual', status: 'inactive', currency: 'usd', last4: '4242', exp_month: 12, exp_year: 2030, spending_controls: { allowed_card_presences: ['not_present'] }, livemode: false } };
  }
});

const stripe = require(stripePath);

(async () => {
  const cardholder = await stripe.createCardholder({
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    type: 'company',
    billing: { line1: '1 Computing Way', city: 'London', country: 'gb', postalCode: 'SW1A 1AA' }
  });
  assert.deepEqual(cardholder, {
    id: 'ich_123', object: 'issuing.cardholder', type: 'company', status: 'active',
    requirements: { disabled_reason: null }, livemode: false
  });
  assert.deepEqual(calls.requests[0].form, {
    type: 'company', status: 'active', name: 'Ada Lovelace', email: 'ada@example.test',
    'billing[address][line1]': '1 Computing Way', 'billing[address][city]': 'London',
    'billing[address][country]': 'GB', 'billing[address][postal_code]': 'SW1A 1AA'
  });

  const card = await stripe.createVirtualCard({
    cardholderId: 'ich_123', dailyLimitUsd: 12.34, active: false,
    allowedMerchantCountries: ['us', 'ca'], allowedCategories: ['office_supplies'], cancelAfterPayments: 3
  });
  assert.deepEqual(calls.caps, [{ amountUsd: 12.34, purpose: 'Stripe Issuing virtual-card daily limit' }]);
  assert.deepEqual(calls.requests[1].form, {
    cardholder: 'ich_123', currency: 'usd', type: 'virtual', status: 'inactive',
    'spending_controls[allowed_card_presences][0]': 'not_present',
    'spending_controls[spending_limits][0][amount]': '1234',
    'spending_controls[spending_limits][0][interval]': 'daily',
    'spending_controls[allowed_merchant_countries][0]': 'US',
    'spending_controls[allowed_merchant_countries][1]': 'CA',
    'spending_controls[allowed_categories][0]': 'office_supplies',
    'lifecycle_controls[cancel_after][payment_count]': '3'
  });
  assert.deepEqual(card, {
    id: 'ic_123', object: 'issuing.card', cardholder: 'ich_123', type: 'virtual', status: 'inactive',
    currency: 'usd', last4: '4242', expMonth: 12, expYear: 2030,
    spendingControls: { allowed_card_presences: ['not_present'] }, livemode: false
  });
  assert.deepEqual(calls.policies, ['stripe.cardholder.create', 'stripe.virtualCard.create']);
  assert.equal(calls.audits[0][0], 'stripe.cardholder.create');
  assert.equal(calls.audits[1][0], 'stripe.virtualCard.create');
  assert.deepEqual(calls.secrets, ['stripe_restricted_key', 'stripe_restricted_key']);
  assert.equal(calls.requests[1].headers.authorization, `Basic ${Buffer.from('rk_test_value:').toString('base64')}`);

  console.log('providers/stripe behavior: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

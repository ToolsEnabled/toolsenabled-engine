'use strict';

// STRIPE BILLING -- THE VERIFICATION HALF, WHICH IS ALL THAT IS LEFT.
//
// This suite used to cover `productCreate`, `priceCreate`, `checkoutCreate` and
// `portalCreate` as well. Those were removed from `providers/billing.js` on the
// legal lane's determination (R-008) once Paddle became the merchant of record;
// see that file's header for why removal beat fencing. Their tests went with
// them, and this file deliberately does not keep skipped or commented-out
// versions -- a disabled test for deleted code is a reader's trap.
//
// ONE PROPERTY DID NOT GO WITH THEM. `tests/entitlement.js` D11 proved that what
// the checkout writes is where the grant path reads it -- the guard against
// charging a customer whose licence can never be issued. It was PORTED to the
// Paddle leg first (W2c in `tests/entitlement-grant.test.js`) and only then was
// the Stripe leg removed.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const billing = require('../../src/lib/providers/billing');

function fixture(overrides = {}) {
  const calls = [];
  const dependencies = {
    assertActive: (...args) => calls.push(['active', ...args]),
    getSecret: key => {
      calls.push(['secret', key]);
      if (key === 'stripe_restricted_key') return 'sk_test_fixture';
      throw new Error(`Unexpected secret ${key}`);
    },
    record: (...args) => calls.push(['audit', ...args]),
    request: async (url, options) => {
      calls.push(['request', url, options]);
      return { body: { id: 'unused' } };
    },
    now: () => 1_750_000_000_000,
    ...overrides
  };
  return { calls, dependencies };
}

(async () => {
  // checkoutStatus -- a GET, and the only outbound call left in this module.
  {
    const { calls, dependencies } = fixture({
      request: async (url, options) => {
        calls.push(['request', url, options]);
        return { body: {
          id: 'cs_test_12345678', object: 'checkout.session', status: 'complete',
          payment_status: 'paid', customer: 'cus_12345678', subscription: 'sub_12345678', livemode: true
        } };
      }
    });
    const status = await billing.checkoutStatus({ sessionId: 'cs_test_12345678' }, dependencies);
    assert.equal(status.paymentStatus, 'paid');
    const requestCall = calls.find(call => call[0] === 'request');
    assert.equal(requestCall[2].method, 'GET');
    assert.equal(requestCall[1], 'https://api.stripe.com/v1/checkout/sessions/cs_test_12345678');

    // The reference fields arrive expanded or bare depending on the call; both
    // must reduce to an id, because the fulfilment path joins on it.
    assert.equal(status.customerId, 'cus_12345678');
    assert.equal(status.subscriptionId, 'sub_12345678');
  }

  // checkoutStatus refuses an id that is not a Checkout Session id, before any
  // request goes out.
  {
    const { calls, dependencies } = fixture();
    await assert.rejects(
      billing.checkoutStatus({ sessionId: 'sub_12345678' }, dependencies),
      /not a valid Stripe cs ID/
    );
    assert.equal(calls.some(call => call[0] === 'request'), false, 'a malformed id must not reach the network');
  }

  // webhookVerify -- the HMAC check, which is what the fulfilment path depends on.
  {
    const secret = 'whsec_offline_fixture';
    const timestamp = 1_750_000_000;
    const payload = '{"id":"evt_12345678","type":"checkout.session.completed","created":1750000000,"livemode":false,"data":{"object":{"id":"cs_12345678"}}}';
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    const audits = [];
    const event = billing.webhookVerify({
      payload,
      signatureHeader: `t=${timestamp},v1=${'0'.repeat(64)},v1=${signature}`,
      vaultKey: 'stripe_webhook_signing_secret_fixture'
    }, {
      getSecret: key => {
        assert.equal(key, 'stripe_webhook_signing_secret_fixture');
        return secret;
      },
      now: () => timestamp * 1000,
      record: (...args) => audits.push(args)
    });
    assert.equal(event.id, 'evt_12345678');
    assert.deepEqual(audits, [[
      'billing.webhook_verify',
      'evt_12345678',
      { type: 'checkout.session.completed', created: timestamp, livemode: false }
    ]]);
    // One altered byte -- a trailing space -- must fail the signature.
    assert.throws(() => billing.webhookVerify({
      payload: `${payload} `,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      vaultKey: 'stripe_webhook_signing_secret_fixture'
    }, { getSecret: () => secret, now: () => timestamp * 1000 }), /verification failed/);
    assert.throws(() => billing.webhookVerify({
      payload,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      vaultKey: 'stripe_webhook_signing_secret_fixture'
    }, { getSecret: () => secret, now: () => (timestamp + 301) * 1000 }), /tolerance/);
  }

  assert.deepEqual(billing.parseStripeSignature(`t=123,v1=${'a'.repeat(64)}`), {
    timestamp: 123,
    signatures: ['a'.repeat(64)]
  });

  // The four removed functions must stay removed. A re-export is how a money
  // path comes back without anyone deciding it should.
  for (const gone of ['checkoutCreate', 'productCreate', 'priceCreate', 'portalCreate']) {
    assert.equal(
      billing[gone], undefined,
      `${gone} was removed on the R-008 determination and must not be re-exported without a fresh decision`
    );
  }

  console.log('Billing provider tests passed.');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

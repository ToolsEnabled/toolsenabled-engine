'use strict';

// STRIPE, VERIFICATION HALF ONLY. THIS FILE CANNOT TAKE MONEY, AND THAT IS THE POINT.
//
// WHAT WAS REMOVED, AND WHY. This module used to carry four functions that
// could start or manage a sale -- `productCreate`, `priceCreate`,
// `checkoutCreate` and `portalCreate`. They were committed, pointed at
// `https://api.stripe.com/v1`, reachable from the MCP tool surface at the
// confined "Standard" tier, and stopped by nothing except the absence of a
// credential. They were removed deliberately (R-008), and the removal was a
// decision, not an accident of cleanup.
//
// The reasoning, kept here because a future reader will otherwise reintroduce
// them:
//
//   PADDLE IS THE MERCHANT OF RECORD. A second money path contradicts the
//   customer-facing documents, which describe one.
//
//   "STOPPED BY ABSENT CREDENTIALS" WAS ALWAYS TEMPORARY. Stripe ISSUING --
//   the virtual-card feature in `providers/stripe.js` -- is a different
//   feature and is untouched by this. The moment any Stripe credential lands
//   in the vault for Issuing, the checkout leg's only protection stops being
//   true: same provider, adjacent credential space. That coupling is what
//   ruled out documenting it and leaving it in place.
//
//   FENCING WOULD HAVE PRESERVED OPTIONALITY THAT GIT ALREADY PRESERVES. A
//   fence is a standing invitation to flip. If direct Stripe sales are ever
//   wanted, this is a revert away -- behind a fresh decision, which is where
//   that belongs.
//
// WHAT REMAINS, AND WHY IT IS SAFE. `checkoutStatus` reads one session;
// `webhookVerify` checks an HMAC. Neither moves money, and
// `entitlement-fulfilment.js` consumes both. Whether the Stripe *fulfilment*
// path stays at all is a separate, later decision.
//
// THE GUARD THAT USED TO LIVE HERE DID NOT DIE WITH THE CODE. The entitlement
// suite proved that what the checkout writes is where the grant path reads it --
// the mechanical guard against charging a customer whose licence can never be
// issued. That property was PORTED to the Paddle leg first, and only then was
// this removed. Port first, remove second.

const crypto = require('node:crypto');
const { getSecret } = require('../runtime');
const { assertActive } = require('../policy');
const { record } = require('../audit');
const { request } = require('../http');

const STRIPE_API = 'https://api.stripe.com/v1';
const MAX_WEBHOOK_BYTES = 1024 * 1024;

function readKey(readSecret = getSecret) {
  try {
    return readSecret('stripe_restricted_key');
  } catch (error) {
    if (!/not configured|key not found/i.test(String(error && error.message))) throw error;
    return readSecret('stripe_secret_key');
  }
}

// No idempotency-key parameter any more: it existed for the mutating calls, and
// there are none left in this file. A GET does not need one, and an unused
// parameter on a header builder is an invitation to add a POST back.
function stripeHeaders(readSecret) {
  const value = readKey(readSecret);
  return {
    authorization: `Basic ${Buffer.from(`${value}:`, 'utf8').toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded'
  };
}

function requireStripeId(value, prefix, label) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9_]{8,}$`).test(value)) {
    throw new Error(`${label} is not a valid Stripe ${prefix} ID.`);
  }
  return value;
}

/** Stripe returns some references expanded and some as bare ids; take the id either way. */
function referencedId(value) {
  if (typeof value === 'string') return value;
  return value && typeof value.id === 'string' ? value.id : null;
}

function sanitizeCheckout(value) {
  if (typeof value.id !== 'string' || !/^cs_[A-Za-z0-9_]{8,}$/.test(value.id) ||
      value.object !== 'checkout.session' || typeof value.status !== 'string' || !value.status ||
      typeof value.payment_status !== 'string' || !value.payment_status ||
      typeof value.livemode !== 'boolean') {
    throw new Error('Stripe returned an invalid Checkout Session.');
  }
  return {
    id: value.id,
    object: value.object,
    url: value.url || null,
    mode: value.mode || null,
    status: value.status || null,
    paymentStatus: value.payment_status || null,
    customerId: referencedId(value.customer),
    subscriptionId: referencedId(value.subscription),
    expiresAt: value.expires_at || null,
    active: value.active === undefined ? null : value.active,
    livemode: value.livemode
  };
}

async function stripeRequest(path, options, dependencies) {
  const call = dependencies.request || request;
  const result = await call(`${STRIPE_API}${path}`, options);
  if (!result || !result.body || typeof result.body !== 'object' || Array.isArray(result.body)) {
    throw new Error('Stripe returned an invalid response.');
  }
  return result.body;
}

function deps(dependencies = {}) {
  return {
    assertActive: dependencies.assertActive || assertActive,
    getSecret: dependencies.getSecret || getSecret,
    record: dependencies.record || record,
    request: dependencies.request || request,
    now: dependencies.now || (() => Date.now())
  };
}

async function checkoutStatus({ sessionId }, dependencies = {}) {
  const d = deps(dependencies);
  d.assertActive('billing.checkout_status', { provider: 'stripe' });
  requireStripeId(sessionId, 'cs', 'sessionId');
  const value = sanitizeCheckout(await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'GET',
    headers: stripeHeaders(d.getSecret)
  }, d));
  d.record('billing.checkout_status', value.id, {
    status: value.status, paymentStatus: value.paymentStatus, livemode: value.livemode
  });
  return value;
}

function parseStripeSignature(header) {
  if (typeof header !== 'string' || !header || header.length > 4096) throw new Error('signatureHeader is invalid.');
  const timestamps = [];
  const signatures = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === 't' && /^\d{1,16}$/.test(value)) timestamps.push(Number(value));
    if (name === 'v1' && /^[a-f0-9]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamps.length !== 1 || !Number.isSafeInteger(timestamps[0]) || signatures.length < 1) {
    // Coded like the Paddle sibling's PADDLE_WEBHOOK_SIGNATURE_INVALID: a
    // header that cannot be parsed cannot be verified. Measured on the
    // 2026-08-19 sweep as a refusal with a sentence and no machine code.
    const error = new Error('signatureHeader does not contain one valid timestamp and at least one v1 signature.');
    error.code = 'BILLING_WEBHOOK_SIGNATURE_INVALID';
    throw error;
  }
  return { timestamp: timestamps[0], signatures };
}

function webhookVerify({
  payload,
  signatureHeader,
  vaultKey,
  toleranceSeconds = 300
}, dependencies = {}) {
  const d = deps(dependencies);
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_WEBHOOK_BYTES) {
    throw new Error(`payload must be a raw UTF-8 string no larger than ${MAX_WEBHOOK_BYTES} bytes.`);
  }
  if (typeof vaultKey !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(vaultKey)) throw new Error('vaultKey is invalid.');
  if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 0 || toleranceSeconds > 3600) {
    throw new Error('toleranceSeconds must be an integer from 0 through 3600.');
  }
  const parsed = parseStripeSignature(signatureHeader);
  const nowSeconds = Math.floor(d.now() / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    const staleness = new Error('Stripe webhook timestamp is outside the accepted tolerance.');
    staleness.code = 'BILLING_WEBHOOK_TIMESTAMP_INVALID';
    throw staleness;
  }
  const secret = d.getSecret(vaultKey);
  const expected = crypto.createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${payload}`, 'utf8')
    .digest();
  const matched = parsed.signatures.some(value => {
    const candidate = Buffer.from(value, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  });
  if (!matched) {
    const mismatch = new Error('Stripe webhook signature verification failed.');
    mismatch.code = 'BILLING_WEBHOOK_SIGNATURE_INVALID';
    throw mismatch;
  }
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    throw new Error('Verified Stripe webhook payload is not valid JSON.');
  }
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]{8,}$/.test(event.id) ||
      typeof event.type !== 'string' || !event.type || typeof event.livemode !== 'boolean') {
    throw new Error('Verified Stripe webhook payload is not a valid event object.');
  }
  d.record('billing.webhook_verify', event.id, {
    type: event.type, created: Number.isSafeInteger(event.created) ? event.created : null,
    livemode: event.livemode
  });
  return event;
}

module.exports = {
  MAX_WEBHOOK_BYTES,
  checkoutStatus,
  parseStripeSignature,
  readKey,
  webhookVerify
};

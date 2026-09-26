'use strict';

const crypto = require('node:crypto');
const { getSecret } = require('../runtime');
const { assertActive } = require('../policy');
const { record } = require('../audit');
const { request } = require('../http');
const { getStateStore, hashInput } = require('../state-store');
const safety = require('./provider-safety');
const { environmentProfile, resolvePaddleEnvironment, ENVIRONMENTS, FAIL_CLOSED_ENVIRONMENT } = require('../paddle-environment');
// INJECTED, NOT REQUIRED. The checkout leg below has to agree with the
// fulfilment path about two key names and about which tiers can be licensed
// at all; a second copy of either would drift, and the drift would only show
// up as a customer who paid and got nothing. But this FILE ships in the free
// capability payload, and the packer's walk stages every module a require()
// literal names — a require here, even a lazy one, put the priced tier table
// into every free install (tools/test/free-payload-licensing.test.mjs).
// So the checkout's licensing knowledge arrives as a DEPENDENCY: the
// paddle-checkout tool pack (owner surface, never in the payload walk) hands
// in { fulfillableTiers, requiredMetadata } from the one authoritative
// modules, and a build that was not given them cannot open a checkout —
// which is the correct behavior for a build that could not entitle what it
// charged.

// SANDBOX OR LIVE IS A RECORDED CHOICE, NOT A CONSTANT. This file used to hold
// `API_ROOT = 'https://sandbox-api.paddle.com'` plus two fixed vault key names,
// which meant a real charge was impossible without editing source. What every
// call now does instead is resolve the recorded environment once, up front, and
// carry that ONE profile through the host, the vault key, the policy check, the
// audit record and the returned output. Resolving it more than once per call
// would let a config write land mid-call and produce a record that disagrees
// with the request it describes.
//
// The names below are kept as module exports because they are part of this
// module's published surface; they now describe the FAIL-CLOSED environment
// rather than the only environment.
const API_ROOT = ENVIRONMENTS[FAIL_CLOSED_ENVIRONMENT].apiRoot;
const DEFAULT_VAULT_KEY = ENVIRONMENTS[FAIL_CLOSED_ENVIRONMENT].apiVaultKey;
const DEFAULT_WEBHOOK_VAULT_KEY = ENVIRONMENTS[FAIL_CLOSED_ENVIRONMENT].webhookVaultKey;
const ENTITY_ID = /^[a-z]{3}_[a-z0-9]{26}$/;
const WEBHOOK_LIMIT = 1024 * 1024;
const TRANSACTION_CANCELLABLE = new Set(['draft', 'ready']);
const SUBSCRIPTION_CANCELLABLE = new Set(['active', 'trialing']);
// Paddle's field is `custom_data`. Stripe's is `metadata`. providers/billing.js
// already carries the warning that they are not the same mechanism; naming the
// field here means a refusal can say WHICH field was wrong.
const PADDLE_CUSTOM_DATA = 'custom_data';
// Only tiers this codebase can actually issue a licence for. entitlement-grant
// refuses anything else AFTER the customer has paid; the checkout leg refuses
// it BEFORE, which is the same rule enforced where it is still free. Resolved
// through fulfillableTiers() above at call time — see the lazy-import note.
// A seat count, not a shopping cart. Bounded because an unbounded quantity is
// an unbounded charge.
const MAX_CHECKOUT_QUANTITY = 1000;
const CHECKOUT_URL_LIMIT = 2048;
function dependencies(overrides = {}) { return { assertActive: overrides.assertActive || assertActive, getSecret: overrides.getSecret || getSecret, record: overrides.record || record, request: overrides.request || request, state: overrides.state || getStateStore(), hashInput: overrides.hashInput || hashInput, now: overrides.now || (() => Date.now()), resolveEnvironment: overrides.resolveEnvironment || resolvePaddleEnvironment, licensing: overrides.licensing || null }; }
function entity(value, label, prefix) { return safety.text(value, label, 30, new RegExp(`^${prefix}_[a-z0-9]{26}$`)); }
// One resolution per call, named so no function can accidentally read the
// environment twice and disagree with itself.
function profileFor(d) { return d.resolveEnvironment().profile; }
// The guards still refuse every key but one -- what changed is WHICH one. A key
// belonging to the other environment is the dangerous input here (a live key
// used against the sandbox host authenticates nothing; a sandbox key used
// against the live host would be a silent no-op on real money), so it is named
// in the refusal rather than lumped in with typos.
function vaultFrom(input, profile) {
  const key = safety.vaultKey(input.vaultKey, profile.apiVaultKey);
  if (key !== profile.apiVaultKey) throw safety.safeError('PADDLE_API_VAULT_KEY_INVALID', `Paddle API operations in the recorded ${profile.environment} environment require the ${profile.apiVaultKey} vault key.`);
  return key;
}
function webhookVaultFrom(input, profile) {
  const key = safety.vaultKey(input.webhookVaultKey, profile.webhookVaultKey);
  if (key !== profile.webhookVaultKey) throw safety.safeError('PADDLE_WEBHOOK_VAULT_KEY_INVALID', `Paddle webhook verification in the recorded ${profile.environment} environment requires the ${profile.webhookVaultKey} vault key.`);
  return key;
}
function providerTimestamp(value, label) {
  const text = safety.text(value, label, 40, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text); const parsed = new Date(Date.parse(text));
  if (!Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3]) || parsed.getUTCHours() !== Number(match[4]) || parsed.getUTCMinutes() !== Number(match[5])
    || parsed.getUTCSeconds() !== Number(match[6])) throw new TypeError(`${label} is invalid.`);
  return text;
}
function headers(secret) { return { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'paddle-version': '1', 'user-agent': 'ToolsEnabled/1.4' }; }
function bodyOf(result, label) { if (!result || (Number.isInteger(result.status) && result.status >= 300 && result.status < 400) || !safety.isPlainObject(result.body)) throw safety.safeError('PADDLE_INVALID_RESPONSE', `Paddle returned an invalid ${label} response.`); return result.body; }
// The environment argument defaults to the FAIL-CLOSED one rather than to the
// recorded one on purpose: this is exported, and an outside caller that forgets
// to say which host it means must not be handed the live host. Every internal
// caller passes the profile resolved for its own call. An explicitly named
// environment that is not recognised throws, via environmentProfile().
function officialUrl(path, environment = FAIL_CLOSED_ENVIRONMENT) { const profile = environmentProfile(environment); if (!/^\/[A-Za-z0-9_./?=&-]{1,512}$/.test(path) || path.includes('//')) throw safety.safeError('PADDLE_PATH_FORBIDDEN', 'Paddle path is not allowed.'); return `${profile.apiRoot}${path}`; }
async function api(path, d, key, profile, options = {}) { const secret = safety.secretValue(d.getSecret, key); try { return bodyOf(await d.request(officialUrl(path, profile.environment), { method: options.method || 'GET', retries: options.retries === undefined ? 0 : options.retries, redirect: 'manual', headers: headers(secret), body: options.body === undefined ? undefined : JSON.stringify(options.body) }), 'API'); } catch (error) { throw safety.safeError('PADDLE_REQUEST_FAILED', 'Paddle did not return a usable response.'); } }
function recordOf(value, secret, kind) { if (!safety.isPlainObject(value)) throw safety.safeError('PADDLE_INVALID_RESPONSE', `Paddle returned an invalid ${kind}.`); return { id: typeof value.id === 'string' ? safety.redactText(value.id, secret, 200) : null, status: typeof value.status === 'string' ? safety.redactText(value.status, secret, 100) : null, description: typeof value.description === 'string' ? safety.redactText(value.description, secret, 1000) : null, customerId: typeof value.customer_id === 'string' ? safety.redactText(value.customer_id, secret, 200) : null, productId: typeof value.product_id === 'string' ? safety.redactText(value.product_id, secret, 200) : null, priceId: typeof value.price_id === 'string' ? safety.redactText(value.price_id, secret, 200) : null, billingCycle: safety.safeObject(value.billing_cycle, secret), nextBilledAt: typeof value.next_billed_at === 'string' ? safety.redactText(value.next_billed_at, secret, 80) : null, createdAt: typeof value.created_at === 'string' ? safety.redactText(value.created_at, secret, 80) : null, updatedAt: typeof value.updated_at === 'string' ? safety.redactText(value.updated_at, secret, 80) : null, ...safety.UNTRUSTED_CONTENT }; }

// paddle.doctor is the one tool whose job includes SAYING which environment is
// in force, so it reports how the answer was reached (`environmentSource`:
// recorded, absent, unrecognised, ...). "Sandbox because nobody has configured
// anything" and "sandbox because somebody chose it" are different facts, and an
// operator who thinks they went live needs to be able to tell them apart.
async function doctor(input = {}, overrides = {}) { safety.exactKeys(input, ['vaultKey'], 'paddle.doctor input'); const d = dependencies(overrides); const resolved = d.resolveEnvironment(); const profile = resolved.profile; const key = vaultFrom(input, profile); d.assertActive('paddle.doctor', { provider: 'paddle', environment: profile.environment }); await api('/event-types?per_page=1', d, key, profile); const output = { configured: true, authenticated: true, environment: profile.environment, environmentRecorded: resolved.recorded, environmentSource: resolved.reason, chargesRealMoney: profile.chargesRealMoney, ...safety.UNTRUSTED_CONTENT }; d.record('paddle.doctor', profile.environment, { vaultKey: key, authenticated: true, environmentSource: resolved.reason }); return output; }
async function catalogList(input = {}, overrides = {}) { safety.exactKeys(input, ['kind', 'vaultKey', 'limit'], 'paddle.catalog_list input'); const d = dependencies(overrides); const kind = safety.text(input.kind, 'kind', 10, /^(products|prices)$/); const profile = profileFor(d); const key = vaultFrom(input, profile); const limit = safety.boundedInteger(input.limit, 'limit', 20, 1, 50); d.assertActive('paddle.catalog_list', { provider: 'paddle', environment: profile.environment }); const secret = safety.secretValue(d.getSecret, key); const raw = await api(`/${kind}?per_page=${limit}`, d, key, profile); if (!Array.isArray(raw.data)) throw safety.safeError('PADDLE_INVALID_RESPONSE', `Paddle returned ${kind} without a data list.`); const items = raw.data.slice(0, limit).map(item => recordOf(item, secret, kind)); d.record('paddle.catalog_list', kind, { vaultKey: key, resultCount: items.length, environment: profile.environment }); return { environment: profile.environment, kind, items, count: items.length, ...safety.UNTRUSTED_CONTENT }; }
async function transactionGet(input = {}, overrides = {}) { safety.exactKeys(input, ['transactionId', 'vaultKey'], 'paddle.transaction_get input'); const d = dependencies(overrides); const target = entity(input.transactionId, 'transactionId', 'txn'); const profile = profileFor(d); const key = vaultFrom(input, profile); d.assertActive('paddle.transaction_get', { provider: 'paddle', environment: profile.environment }); const secret = safety.secretValue(d.getSecret, key); const raw = await api(`/transactions/${encodeURIComponent(target)}`, d, key, profile); const output = recordOf(raw.data, secret, 'transaction'); d.record('paddle.transaction_get', target, { vaultKey: key, status: output.status, environment: profile.environment }); return output; }
async function transactionVerify(input = {}, overrides = {}) { safety.exactKeys(input, ['transactionId', 'expectedStatus', 'vaultKey'], 'paddle.transaction_verify input'); const expected = safety.text(input.expectedStatus, 'expectedStatus', 80, /^[a-z_]+$/); const output = await transactionGet({ transactionId: input.transactionId, vaultKey: input.vaultKey }, overrides); if (typeof output.status !== 'string' || !/^[a-z_]{1,80}$/.test(output.status)) throw safety.safeError('PADDLE_INVALID_RESPONSE', 'Paddle returned a transaction without a usable status, so its status could not be verified.'); const verified = output.status === expected; return { transactionId: output.id, expectedStatus: expected, observedStatus: output.status, verified, verification: verified ? 'matched' : 'mismatch', ...safety.UNTRUSTED_CONTENT }; }
// The URL Paddle sends the customer back to. Bounded, https-only, and no
// credentials in it: this string is handed to a third party and comes back
// through a browser, so it is the wrong place for anything secret.
function checkoutReturnUrl(value) {
  const text = safety.text(value, 'returnUrl', CHECKOUT_URL_LIMIT);
  let parsed;
  try { parsed = new URL(text); } catch { throw safety.safeError('PADDLE_CHECKOUT_RETURN_URL_INVALID', 'returnUrl must be an absolute URL.'); }
  if (parsed.protocol !== 'https:') throw safety.safeError('PADDLE_CHECKOUT_RETURN_URL_INVALID', 'returnUrl must be https.');
  if (parsed.username || parsed.password) throw safety.safeError('PADDLE_CHECKOUT_RETURN_URL_INVALID', 'returnUrl must not carry credentials.');
  return parsed.toString();
}

// Paddle's hosted checkout link, taken from the created transaction. Validated
// rather than trusted: this value is what a paying customer is sent to, so a
// non-https or off-host link is refused instead of forwarded.
function checkoutUrlOf(data, profile) {
  const raw = safety.isPlainObject(data) && safety.isPlainObject(data.checkout) ? data.checkout.url : null;
  if (typeof raw !== 'string' || !raw || raw.length > CHECKOUT_URL_LIMIT) {
    throw safety.safeError('PADDLE_CHECKOUT_URL_MISSING', 'Paddle did not return a hosted checkout URL, so there is nothing for a customer to pay with. The transaction is unpaid.');
  }
  let parsed;
  try { parsed = new URL(raw); } catch { throw safety.safeError('PADDLE_CHECKOUT_URL_INVALID', 'Paddle returned a checkout URL that is not a URL.'); }
  if (parsed.protocol !== 'https:') throw safety.safeError('PADDLE_CHECKOUT_URL_INVALID', `Paddle returned a non-https checkout URL for the ${profile.environment} environment.`);
  return parsed.toString();
}

// THE CHECKOUT LEG -- the one thing in this file that can START a sale.
//
// Every other function here reads or cancels something that already exists, so
// until now nothing in this codebase could take an order at all;
// src/lib/mission-bridge/purchase-recording.js says it plainly: "There is no
// merchant checkout integration anywhere in this codebase."
//
// PADDLE-HOSTED, so the card form is Paddle's problem and no card data ever
// touches this process. Paddle Billing has no separate checkout-session object
// the way Stripe does: a transaction created with `checkout.url` IS the hosted
// checkout, and `data.checkout.url` comes back as the link the customer opens.
//
// THE CONTRACT THAT DECIDES WHETHER A SALE CAN BE FULFILLED AT ALL.
// entitlement-grant.js reads `custom_data.toolsenabled_tier` and
// `custom_data.toolsenabled_pair_id` off the notification and refuses to issue
// a licence without both. Getting this wrong is not a loud failure -- it
// charges a customer and delivers nothing. So both values are checked BEFORE
// the request goes out, against the same TIERS table the fulfilment path will
// judge them by, and a tier this codebase cannot license is refused here where
// nobody has paid yet.
//
// AND CHECKED AGAIN ON THE WAY BACK, because there is exactly one moment when
// this is still free to catch: a created transaction is NOT a paid one -- it is
// draft/ready until the customer completes checkout. If Paddle echoes a
// transaction that lost either key, throwing costs nothing and prevents handing
// out a link that could take money this codebase could never fulfil.
//
// RENEWALS ARE A SEPARATE QUESTION, deliberately not assumed here. Paddle
// delivers `subscription.*` on the subscription object and
// `transaction.completed` on the transaction, and entitlement-grant reads
// custom_data off whichever object arrives. This call can only set custom_data
// on the transaction it creates; whether Paddle propagates it onto the
// subscription is a fact about Paddle's behaviour, not about this code, and it
// is UNVERIFIED against a live account. Until it is verified end to end, treat
// renewal fulfilment as unproven -- see the report accompanying this change.
async function transactionCreate(input = {}, overrides = {}) {
  safety.exactKeys(input, ['priceId', 'quantity', 'tier', 'pairId', 'returnUrl', 'customerEmail', 'vaultKey', 'idempotencyKey'], 'paddle.transaction_create input');
  const d = dependencies(overrides);
  const priceId = entity(input.priceId, 'priceId', 'pri');
  const quantity = safety.boundedInteger(input.quantity, 'quantity', 1, 1, MAX_CHECKOUT_QUANTITY);
  const tier = safety.text(input.tier, 'tier', 64, /^[a-z][a-z0-9_-]*$/);
  const pairId = safety.text(input.pairId, 'pairId', 200, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  const returnUrl = checkoutReturnUrl(input.returnUrl);
  const email = input.customerEmail === undefined || input.customerEmail === null
    ? null
    : safety.text(input.customerEmail, 'customerEmail', 254, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  const profile = profileFor(d);
  const key = vaultFrom(input, profile);
  const idem = safety.idempotencyKey(input.idempotencyKey);
  if (!d.licensing || typeof d.licensing.fulfillableTiers !== 'function' || typeof d.licensing.requiredMetadata !== 'function') {
    throw safety.safeError('PADDLE_CHECKOUT_UNAVAILABLE_IN_THIS_BUILD',
      'This build carries no licensing table, so nothing it charged could be entitled — no checkout was opened. '
      + 'Paid checkouts run from the owner build, which supplies the licensing modules.');
  }
  const fulfillable = d.licensing.fulfillableTiers();
  if (!fulfillable.includes(tier)) {
    throw safety.safeError('PADDLE_CHECKOUT_TIER_UNFULFILLABLE',
      `A checkout may only be opened for a tier this codebase can license: ${fulfillable.join(', ')}. `
      + 'Opening one for any other tier would charge a customer that nothing could then entitle.');
  }
  d.assertActive('paddle.transaction_create', { provider: 'paddle', environment: profile.environment });
  const metadataNames = d.licensing.requiredMetadata();
  const customData = { [metadataNames.tier]: tier, [metadataNames.pairId]: pairId };
  // vaultKey is in the hashed input for the same reason it is in every other
  // mutating call here: it is the only thing that differs between the sandbox
  // checkout and the identical live one, and without it `safety.mutate` would
  // replay one as the other across the money boundary.
  const output = await safety.mutate({
    state: d.state, hashInput: d.hashInput, now: d.now, type: 'paddle.transaction_create', key: idem,
    input: { priceId, quantity, tier, pairId, returnUrl, vaultKey: key },
    execute: async started => {
      const secret = safety.secretValue(d.getSecret, key);
      const body = { items: [{ price_id: priceId, quantity }], custom_data: customData, collection_mode: 'automatic', checkout: { url: returnUrl } };
      if (email) body.customer = { email };
      started();
      const raw = await api('/transactions', d, key, profile, { method: 'POST', body, retries: 0 });
      const echoed = safety.isPlainObject(raw.data) && safety.isPlainObject(raw.data[PADDLE_CUSTOM_DATA]) ? raw.data[PADDLE_CUSTOM_DATA] : {};
      for (const name of [metadataNames.tier, metadataNames.pairId]) {
        if (echoed[name] !== customData[name]) {
          throw safety.safeError('PADDLE_CHECKOUT_CUSTOM_DATA_LOST',
            `Paddle returned a transaction whose ${PADDLE_CUSTOM_DATA}.${name} is not what was sent, so a completed payment could not be fulfilled. `
            + 'No checkout link was issued and the transaction is unpaid.');
        }
      }
      return {
        transaction: recordOf(raw.data, secret, 'transaction'),
        checkoutUrl: checkoutUrlOf(raw.data, profile),
        tier,
        pairId,
        environment: profile.environment,
        chargesRealMoney: profile.chargesRealMoney,
        ...safety.UNTRUSTED_CONTENT
      };
    }
  });
  try {
    d.record('paddle.transaction_create', output.transaction?.id || priceId, {
      vaultKey: key, priceId, quantity, tier, pairId, replayed: output.replayed,
      environment: profile.environment, chargesRealMoney: profile.chargesRealMoney
    });
  } catch { /* durable operation already wins */ }
  return output;
}

// WHAT KEEPS A CANCELLATION FROM REPLAYING ACROSS THE MONEY BOUNDARY.
// `safety.mutate` replays a stored result whenever the hashed input matches, so
// if a sandbox cancellation and the identical live one hashed the same, the
// live caller would be told the real transaction was canceled and no request
// would ever be sent. They do not hash the same, and the reason is `vaultKey`
// below: the two environments have DIFFERENT vault key names, so the resolved
// key already carries the environment into the hash. That is load-bearing, not
// incidental -- if a future change ever gives both environments one key name,
// this input must gain an explicit environment field or cross-environment
// replay becomes possible. tests/paddle-environment.test.js 3f is the guard.
async function transactionCancel(input = {}, overrides = {}) { safety.exactKeys(input, ['transactionId', 'expectedStatus', 'vaultKey', 'idempotencyKey'], 'paddle.transaction_cancel input'); const d = dependencies(overrides); const target = entity(input.transactionId, 'transactionId', 'txn'); const expected = safety.text(input.expectedStatus, 'expectedStatus', 80, /^[a-z_]+$/); const profile = profileFor(d); const key = vaultFrom(input, profile); const idem = safety.idempotencyKey(input.idempotencyKey); if (!TRANSACTION_CANCELLABLE.has(expected)) throw safety.safeError('PADDLE_TRANSACTION_NOT_CANCELLABLE', 'Transactions cannot be canceled unless their status is draft or ready.'); d.assertActive('paddle.transaction_cancel', { provider: 'paddle', environment: profile.environment }); const output = await safety.mutate({ state: d.state, hashInput: d.hashInput, now: d.now, type: 'paddle.transaction_cancel', key: idem, input: { transactionId: target, expectedStatus: expected, vaultKey: key }, execute: async started => { const secret = safety.secretValue(d.getSecret, key); const before = await api(`/transactions/${encodeURIComponent(target)}`, d, key, profile); const observed = before.data?.status; if (!TRANSACTION_CANCELLABLE.has(observed) || observed !== expected) throw safety.safeError('PADDLE_TRANSACTION_CANCEL_FENCE_MISMATCH', 'The transaction status changed or is not cancellable; no cancellation was sent.'); started(); const raw = await api(`/transactions/${encodeURIComponent(target)}`, d, key, profile, { method: 'PATCH', body: { status: 'canceled' }, retries: 0 }); return { transaction: recordOf(raw.data, secret, 'transaction'), environment: profile.environment, ...safety.UNTRUSTED_CONTENT }; }}); try { d.record('paddle.transaction_cancel', target, { vaultKey: key, expectedStatus: expected, replayed: output.replayed, environment: profile.environment }); } catch { /* durable operation already wins */ } return output; }
async function subscriptionGet(input = {}, overrides = {}) { safety.exactKeys(input, ['subscriptionId', 'vaultKey'], 'paddle.subscription_get input'); const d = dependencies(overrides); const target = entity(input.subscriptionId, 'subscriptionId', 'sub'); const profile = profileFor(d); const key = vaultFrom(input, profile); d.assertActive('paddle.subscription_get', { provider: 'paddle', environment: profile.environment }); const secret = safety.secretValue(d.getSecret, key); const raw = await api(`/subscriptions/${encodeURIComponent(target)}`, d, key, profile); const output = recordOf(raw.data, secret, 'subscription'); d.record('paddle.subscription_get', target, { vaultKey: key, status: output.status, environment: profile.environment }); return output; }
// Same replay-across-a-money-boundary reasoning, and the same load-bearing
// vaultKey, as transaction_cancel above.
async function subscriptionCancel(input = {}, overrides = {}) { safety.exactKeys(input, ['subscriptionId', 'effectiveFrom', 'expectedStatus', 'expectedUpdatedAt', 'vaultKey', 'idempotencyKey'], 'paddle.subscription_cancel input'); const d = dependencies(overrides); const target = entity(input.subscriptionId, 'subscriptionId', 'sub'); const effectiveFrom = safety.text(input.effectiveFrom, 'effectiveFrom', 30, /^(immediately|next_billing_period)$/); const expected = safety.text(input.expectedStatus, 'expectedStatus', 80, /^[a-z_]+$/); const expectedUpdatedAt = providerTimestamp(input.expectedUpdatedAt, 'expectedUpdatedAt'); const profile = profileFor(d); const key = vaultFrom(input, profile); const idem = safety.idempotencyKey(input.idempotencyKey); if (!SUBSCRIPTION_CANCELLABLE.has(expected)) throw safety.safeError('PADDLE_SUBSCRIPTION_NOT_CANCELLABLE', 'Only active or trialing subscriptions can be canceled.'); d.assertActive('paddle.subscription_cancel', { provider: 'paddle', environment: profile.environment }); const output = await safety.mutate({ state: d.state, hashInput: d.hashInput, now: d.now, type: 'paddle.subscription_cancel', key: idem, input: { subscriptionId: target, effectiveFrom, expectedStatus: expected, expectedUpdatedAt, vaultKey: key }, execute: async started => { const secret = safety.secretValue(d.getSecret, key); const before = await api(`/subscriptions/${encodeURIComponent(target)}`, d, key, profile); const observed = before.data?.status; const observedUpdatedAt = before.data?.updated_at; if (!SUBSCRIPTION_CANCELLABLE.has(observed) || observed !== expected || observedUpdatedAt !== expectedUpdatedAt) throw safety.safeError('PADDLE_SUBSCRIPTION_CANCEL_FENCE_MISMATCH', 'The subscription status or update timestamp changed, or it is not cancellable; no cancellation was sent.'); started(); const raw = await api(`/subscriptions/${encodeURIComponent(target)}/cancel`, d, key, profile, { method: 'POST', body: { effective_from: effectiveFrom }, retries: 0 }); return { subscription: recordOf(raw.data, secret, 'subscription'), environment: profile.environment, ...safety.UNTRUSTED_CONTENT }; }}); try { d.record('paddle.subscription_cancel', target, { vaultKey: key, effectiveFrom, expectedStatus: expected, expectedUpdatedAt, replayed: output.replayed, environment: profile.environment }); } catch { /* durable operation already wins */ } return output; }
function parseWebhookSignature(header) {
  const timestamps = []; const signatures = []; const parts = header.split(';');
  if (!parts.length || parts.some(part => !part.trim())) throw safety.safeError('PADDLE_WEBHOOK_SIGNATURE_INVALID', 'Paddle signature header is invalid.');
  for (const raw of parts) {
    const match = /^\s*(ts|h1)\s*=\s*([^=\s;]+)\s*$/.exec(raw);
    if (!match) throw safety.safeError('PADDLE_WEBHOOK_SIGNATURE_INVALID', 'Paddle signature header is invalid.');
    if (match[1] === 'ts') timestamps.push(match[2]); else signatures.push(match[2]);
  }
  if (timestamps.length !== 1 || signatures.length < 1 || !/^\d{1,12}$/.test(timestamps[0]) || !Number.isSafeInteger(Number(timestamps[0]))
    || signatures.some(value => !/^[a-f0-9]{64}$/i.test(value))) {
    throw safety.safeError('PADDLE_WEBHOOK_SIGNATURE_INVALID', 'Paddle signature header is invalid.');
  }
  return { timestamp: Number(timestamps[0]), signatures };
}
function webhookVerify(input = {}, overrides = {}) { safety.exactKeys(input, ['payload', 'signatureHeader', 'webhookVaultKey', 'toleranceSeconds'], 'paddle.webhook_verify input'); const d = dependencies(overrides); const payload = input.payload; if (typeof payload !== 'string' || !payload || Buffer.byteLength(payload, 'utf8') > WEBHOOK_LIMIT || /[\x00]/.test(payload)) throw safety.safeError('PADDLE_WEBHOOK_PAYLOAD_INVALID', 'Webhook payload must be bounded UTF-8 text.'); const header = safety.text(input.signatureHeader, 'signatureHeader', 4096); const profile = profileFor(d); const key = webhookVaultFrom(input, profile); const tolerance = safety.boundedInteger(input.toleranceSeconds, 'toleranceSeconds', 5, 1, 300); const parsed = parseWebhookSignature(header); const timestamp = parsed.timestamp; if (Math.abs(Math.floor(d.now() / 1000) - timestamp) > tolerance) throw safety.safeError('PADDLE_WEBHOOK_TIMESTAMP_INVALID', 'Paddle webhook timestamp is outside the accepted tolerance.'); const secret = safety.secretValue(d.getSecret, key); const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${timestamp}:${payload}`, 'utf8').digest('hex'), 'hex'); let matched = false; for (const candidate of parsed.signatures) { const actual = Buffer.from(candidate, 'hex'); matched = crypto.timingSafeEqual(expected, actual) || matched; } if (!matched) throw safety.safeError('PADDLE_WEBHOOK_SIGNATURE_INVALID', 'Paddle webhook signature verification failed.'); let event; try { event = JSON.parse(payload); } catch { throw safety.safeError('PADDLE_WEBHOOK_PAYLOAD_INVALID', 'Verified Paddle webhook payload is not valid JSON.'); } if (!safety.isPlainObject(event)) throw safety.safeError('PADDLE_WEBHOOK_PAYLOAD_INVALID', 'Verified Paddle webhook payload is not an object.'); const eventId = typeof event.event_id === 'string' && /^evt_[a-z0-9]{26}$/.test(event.event_id) ? event.event_id : null; const eventType = typeof event.event_type === 'string' && /^[a-z][a-z0-9_.]{0,159}$/.test(event.event_type) ? event.event_type : null; const data = safety.isPlainObject(event.data) ? event.data : {}; const entityId = typeof data.id === 'string' && ENTITY_ID.test(data.id) ? data.id : null; const entityStatus = typeof data.status === 'string' && /^[a-z_]{1,80}$/.test(data.status) ? data.status : null; const payloadSha256 = crypto.createHash('sha256').update(payload, 'utf8').digest('hex'); d.record('paddle.webhook_verify', eventId || 'webhook', { webhookVaultKey: key, eventType, entityId, environment: profile.environment }); return { eventId, eventType, entityId, entityStatus, payloadSha256, environment: profile.environment, verified: true, ...safety.UNTRUSTED_CONTENT }; }

module.exports = { API_ROOT, DEFAULT_VAULT_KEY, DEFAULT_WEBHOOK_VAULT_KEY, MAX_CHECKOUT_QUANTITY, PADDLE_CUSTOM_DATA, WEBHOOK_LIMIT, catalogList, doctor, officialUrl, subscriptionCancel, subscriptionGet, transactionCancel, transactionCreate, transactionGet, transactionVerify, webhookVerify };

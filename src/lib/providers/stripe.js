'use strict';

const { getSecret } = require('../runtime');
const { assertActive } = require('../policy');
const { record } = require('../audit');
const { request } = require('../http');
const pay = require('./pay');

function key() {
  try { return getSecret('stripe_restricted_key'); }
  catch (error) {
    // A cancellation or unavailable interactive desktop must not silently fall
    // through into a second credential prompt.  Only an ordinary absent
    // restricted key permits the supported secret-key fallback.
    if (!error || error.code !== 'SECRET_NOT_CONFIGURED') throw error;
    return getSecret('stripe_secret_key');
  }
}
function headers() { return { authorization: `Basic ${Buffer.from(`${key()}:`, 'utf8').toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }; }
function requireId(value, kind) { if (!/^[A-Za-z0-9_]+$/.test(value || '')) throw new Error(`${kind} is invalid.`); return value; }
function append(form, prefix, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) { value.forEach((entry, index) => append(form, `${prefix}[${index}]`, entry)); return; }
  if (typeof value === 'object') { Object.entries(value).forEach(([key, entry]) => append(form, `${prefix}[${key}]`, entry)); return; }
  form.set(prefix, String(value));
}
function responseCard(card) {
  return { id: card.id, object: card.object, cardholder: typeof card.cardholder === 'string' ? card.cardholder : card.cardholder && card.cardholder.id, type: card.type, status: card.status, currency: card.currency, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year, spendingControls: card.spending_controls, livemode: card.livemode };
}

async function createCardholder({ name, email = '', phoneNumber = '', type = 'individual', billing, status = 'active' }) {
  assertActive('stripe.cardholder.create');
  if (!['individual', 'company'].includes(type)) throw new Error('type must be individual or company.');
  if (!['active', 'inactive'].includes(status)) throw new Error('status must be active or inactive.');
  if (typeof name !== 'string' || !name.trim() || name.length > 24) throw new Error('name must be a non-empty string of at most 24 characters.');
  if (!billing || !billing.line1 || !billing.city || !billing.country || !billing.postalCode) throw new Error('billing requires line1, city, country, and postalCode.');
  if (!/^[A-Za-z]{2}$/.test(billing.country)) throw new Error('billing.country must be a two-letter country code.');
  const body = new URLSearchParams();
  append(body, 'type', type); append(body, 'status', status); append(body, 'name', name);
  append(body, 'email', email); append(body, 'phone_number', phoneNumber);
  append(body, 'billing[address]', { line1: billing.line1, line2: billing.line2, city: billing.city, state: billing.state, country: billing.country.toUpperCase(), postal_code: billing.postalCode });
  const created = (await request('https://api.stripe.com/v1/issuing/cardholders', { method: 'POST', headers: headers(), body })).body;
  record('stripe.cardholder.create', created.id, { type, status, hasEmail: Boolean(email), hasPhone: Boolean(phoneNumber) });
  return { id: created.id, object: created.object, type: created.type, status: created.status, requirements: created.requirements, livemode: created.livemode };
}

async function createVirtualCard({ cardholderId, currency = 'usd', dailyLimitUsd, active = true, allowedMerchantCountries = [], allowedCategories = [], cancelAfterPayments }) {
  assertActive('stripe.virtualCard.create');
  requireId(cardholderId, 'cardholderId');
  if (!/^[a-z]{3}$/.test(currency)) throw new Error('currency must be a lowercase ISO currency code.');
  const limit = Number(dailyLimitUsd);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('dailyLimitUsd must be a positive number.');
  const cap = pay.check({ amountUsd: limit, purpose: 'Stripe Issuing virtual-card daily limit' });
  if (!cap.allowed) throw new Error(`Requested virtual-card daily limit exceeds the local policy cap of ${cap.limitUsd} USD.`);
  if (!Array.isArray(allowedMerchantCountries) || allowedMerchantCountries.some(country => !/^[A-Za-z]{2}$/.test(country))) throw new Error('allowedMerchantCountries must contain two-letter country codes.');
  if (!Array.isArray(allowedCategories) || allowedCategories.some(category => !/^[a-z_]+$/.test(category))) throw new Error('allowedCategories must contain Stripe merchant category names.');
  if (cancelAfterPayments !== undefined && (!Number.isInteger(Number(cancelAfterPayments)) || Number(cancelAfterPayments) < 1)) throw new Error('cancelAfterPayments must be a positive integer.');
  const body = new URLSearchParams();
  append(body, 'cardholder', cardholderId); append(body, 'currency', currency); append(body, 'type', 'virtual'); append(body, 'status', active ? 'active' : 'inactive');
  append(body, 'spending_controls[allowed_card_presences]', ['not_present']);
  append(body, 'spending_controls[spending_limits]', [{ amount: Math.round(limit * 100), interval: 'daily' }]);
  if (allowedMerchantCountries.length) append(body, 'spending_controls[allowed_merchant_countries]', allowedMerchantCountries.map(country => country.toUpperCase()));
  if (allowedCategories.length) append(body, 'spending_controls[allowed_categories]', allowedCategories);
  if (cancelAfterPayments !== undefined) append(body, 'lifecycle_controls[cancel_after][payment_count]', Number(cancelAfterPayments));
  const created = (await request('https://api.stripe.com/v1/issuing/cards', { method: 'POST', headers: headers(), body })).body;
  const output = responseCard(created);
  record('stripe.virtualCard.create', output.id, { cardholderId, currency, dailyLimitUsd: limit, active, allowedMerchantCountries, allowedCategories, cancelAfterPayments });
  return output;
}

module.exports = { createCardholder, createVirtualCard };

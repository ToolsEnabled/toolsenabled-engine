'use strict';
// WHICH OF THE PERSON'S OWN ACCOUNTS OF ONE PROVIDER A START USES, AND WHAT
// HAPPENS WHEN THAT ACCOUNT RUNS OUT.
//
// There is one answer: `manual`, "stop and let the person choose". A start uses
// the account the person chose (or, before anybody chose, the first usable
// account in the order they listed), and when that account cannot serve, the
// start stops and says which account is spent and which of their other
// accounts of the same provider is ready. It never moves the work onto another
// account of the same provider by itself.
//
// Earlier builds offered further modes whose purpose was to spread or drain
// allowance across several accounts of one provider automatically (walk the
// list, take turns, most room first, least room first, keep them even, a
// reserve-driven hybrid, and resets-soonest-first). Those modes are retired.
// What remains available is decided elsewhere and is unaffected here: moving
// work to a DIFFERENT provider the person attached, overflow to the person's
// own API key, and waiting for an allowance to reset.
//
// MIGRATION. A registry or setting written by an earlier build may still name
// a retired mode. Every such id -- and any id this build does not recognise --
// normalises to `manual`. Nothing that was stored can turn automatic
// same-provider switching back on, and an unreadable answer fails to the stop,
// never to a switch.
//
// This module is ONE PURE FUNCTION over readings that were already taken. It
// starts nothing, spends nothing, and reads no file.

const usability = require('./usability.js');

const MODE = Object.freeze({
  MANUAL: 'manual'
});

/* The ids earlier builds accepted and this one does not. Each is read as
   `manual`. They are listed rather than left to the unrecognised-id rule so a
   surface can tell a person that a stored choice was retired, and so a test
   can prove every one of them lands on the stop. */
const RETIRED_SELECTION_MODES = Object.freeze([
  'priority',
  'rotate',
  'most-available',
  'least-available',
  'even',
  'dynamic',
  'resets-soonest',
  'expiring-first'
]);

/* `automatic: false` is the whole of the one mode there is. */
const SELECTION_MODES = Object.freeze([
  Object.freeze({ id: MODE.MANUAL, automatic: false })
]);

const SELECTION_MODE_IDS = Object.freeze(SELECTION_MODES.map(mode => mode.id));
const DEFAULT_SELECTION_MODE = MODE.MANUAL;
/* What an id this build does not know normalises to. */
const UNRECOGNISED_SELECTION_MODE = MODE.MANUAL;

function selectionMode(id) {
  return SELECTION_MODES.find(mode => mode.id === id) || null;
}

/** Every value -- known, retired, malformed or absent -- means `manual`. */
function normalizeSelectionMode(value) {
  return SELECTION_MODE_IDS.includes(value) ? value : UNRECOGNISED_SELECTION_MODE;
}

/** True when a stored value names a mode this build retired. */
function isRetiredSelectionMode(value) {
  return RETIRED_SELECTION_MODES.includes(value);
}

/** No mode moves between accounts of one provider without being asked. */
function isAutomatic(mode) {
  const found = selectionMode(normalizeSelectionMode(mode));
  return Boolean(found && found.automatic);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function listed(account, reading) {
  return {
    account,
    priority: Number.isSafeInteger(account.priority) && account.priority > 0 ? account.priority : Number.MAX_SAFE_INTEGER,
    name: typeof account.name === 'string' ? account.name : '',
    status: usability.statusOf(reading)
  };
}

/* Registry order, with one exception: an account known to be unable to serve a
   turn right now (signed out, spent, not provisioned) goes behind the ones that
   can. That is usability, not usage -- no allowance figure is compared -- and
   it is recomputed from the reading taken for THIS start, so nothing is
   demoted permanently. Stable by construction: tier, priority, then name. */
function byRegistry(a, b) {
  return (usability.selectionTier(a.status) - usability.selectionTier(b.status))
    || (a.priority - b.priority)
    || a.name.localeCompare(b.name);
}

/**
 * The order this provider's accounts are shown and considered in.
 *
 * `accounts` are registry entries; `readings` is an optional map from account
 * name to whatever the probe measured. Only the usability of a reading is
 * consulted, never how much allowance it reports, so the order a person sees
 * is the order they listed.
 *
 * Returns the order plus ONE SENTENCE saying why, because a surface that shows
 * an order has to be able to explain it. `measuredCount` and `unmeasuredCount`
 * are null: this order is not based on a measurement, and reporting a count of
 * unread accounts would be a caveat about a reading nothing consulted.
 */
function orderAccounts({ mode = DEFAULT_SELECTION_MODE, accounts = [], readings = null } = {}) {
  const chosen = normalizeSelectionMode(mode);
  const list = Array.isArray(accounts) ? accounts.filter(plainObject) : [];
  const lookup = readings instanceof Map
    ? name => readings.get(name)
    : (plainObject(readings) ? name => readings[name] : () => null);
  const entries = list.map(account => listed(account, lookup(account.name))).sort(byRegistry);
  /* Only accounts KNOWN to be unusable are counted. An account whose status was
     never read is one nothing has asked yet, not one that cannot serve. */
  const unusable = entries.filter(entry =>
    usability.recoversWithoutPerson(entry.status) || usability.needsPerson(entry.status)).length;
  const why = unusable === 0
    ? 'In the order the accounts are listed.'
    : (unusable === 1
      ? 'In the order the accounts are listed, except one account that cannot serve a turn right now, which was moved behind the rest.'
      : `In the order the accounts are listed, except ${unusable} accounts that cannot serve a turn right now, which were moved behind the rest.`);
  return Object.freeze({
    mode: chosen,
    accounts: Object.freeze(entries.map(entry => entry.account)),
    names: Object.freeze(entries.map(entry => entry.name)),
    measuredCount: null,
    unmeasuredCount: null,
    why
  });
}

module.exports = Object.freeze({
  DEFAULT_SELECTION_MODE,
  MODE,
  RETIRED_SELECTION_MODES,
  SELECTION_MODES,
  SELECTION_MODE_IDS,
  UNRECOGNISED_SELECTION_MODE,
  isAutomatic,
  isRetiredSelectionMode,
  normalizeSelectionMode,
  orderAccounts,
  selectionMode
});

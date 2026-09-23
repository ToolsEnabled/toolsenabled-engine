'use strict';

// Settings-only purchase reservation policy. It deliberately does not read
// owner prompts or authorize a spend; callers compose that separate evidence.
const RESERVATION_PURCHASES = 'Approving any purchase or spending any money';
const AUTO_APPROVE_SETTING_ID = 'outward.reserved_from_agents';
const REQUIRE_APPROVAL_SETTING_ID = 'purchases.require_owner_approval';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function purchaseApprovalReserved(dependencies = {}) {
  let loaded;
  try {
    const loadSettings = dependencies.loadSettings || require('./settings').loadSettings;
    loaded = loadSettings(dependencies.settingsOptions || {});
  } catch (error) {
    return Object.freeze({
      reserved: true,
      readable: false,
      reason: `Your settings could not be read (${error && error.message ? error.message : String(error)}), so purchases stay reserved for you.`
    });
  }
  if (!isPlainObject(loaded) || !isPlainObject(loaded.values)) {
    return Object.freeze({ reserved: true, readable: false, reason: 'Your settings could not be read, so purchases stay reserved for you.' });
  }
  const list = loaded.values[AUTO_APPROVE_SETTING_ID];
  if (!Array.isArray(list)) {
    return Object.freeze({ reserved: true, readable: false, reason: 'Your list of things you keep for yourself could not be read, so purchases stay reserved for you.' });
  }
  const source = loaded.provenance?.[REQUIRE_APPROVAL_SETTING_ID]?.source;
  const required = loaded.values[REQUIRE_APPROVAL_SETTING_ID];
  const rejected = (loaded.rejected || []).some(entry => entry && [REQUIRE_APPROVAL_SETTING_ID, '*'].includes(entry.id));
  if (rejected || (required !== undefined && typeof required !== 'boolean')) {
    return Object.freeze({ reserved: true, readable: false, reason: 'Your purchase approval setting could not be read.' });
  }
  const chosen = ['user', 'installer'].includes(source);
  const reservedByList = list.some(item => typeof item === 'string' && item.trim() === RESERVATION_PURCHASES);
  const reserved = reservedByList || (required !== undefined && !(required === false && chosen));
  return Object.freeze({
    reserved,
    readable: true,
    reason: reserved ? 'Purchases wait for your approval.' : 'You chose to allow spending records without individual purchase approval.'
  });
}

module.exports = Object.freeze({
  RESERVATION_PURCHASES,
  AUTO_APPROVE_SETTING_ID,
  REQUIRE_APPROVAL_SETTING_ID,
  purchaseApprovalReserved
});

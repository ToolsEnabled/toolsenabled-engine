'use strict';

require('./lib/isolated-environment').activate('system-status-entitlement-failure');
const assert = require('node:assert/strict');
const { entitlementState } = require('../src/lib/system-status');

const unavailable = Object.assign(new Error('reporter could not load'), { code: 'MODULE_NOT_FOUND' });
const result = entitlementState(() => { throw unavailable; });

assert.deepEqual(result, {
  ok: false,
  tier: null,
  unlicensedInstall: null,
  reason: 'entitlement-unreadable',
  detail: 'reporter could not load'
}, 'a failed entitlement check must remain a failed check rather than impersonating a community result');

const community = { ok: true, tier: 'community', unlicensedInstall: 'full-function' };
assert.equal(entitlementState(() => community), community,
  'a genuine community report remains a successful supported installation');

console.log('System-status entitlement failure reporting tests passed.');

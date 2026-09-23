'use strict';

require('../lib/isolated-environment').activate('providers-infrastructure');
const assert = require('node:assert/strict');
const infrastructure = require('../../src/lib/providers/infrastructure');

function accountRegistry() {
  const account = { email: 'owner@example.com' };
  return {
    resolve: selector => selector === account.email ? 'owner' : selector,
    load: () => ({ accounts: { owner: account } }),
    list: () => [{ alias: 'owner', email: account.email, authorized: true }]
  };
}

const activity = [];
const result = infrastructure.gcloudAccountInspect(
  { account: 'owner@example.com' },
  {
    accountRegistry: accountRegistry(),
    gcloudAvailable: () => false,
    assertActive: (...args) => activity.push(['active', ...args]),
    record: (...args) => activity.push(['record', ...args]),
    now: () => 1_800_000_000_000
  }
);

assert.deepEqual(result.account, {
  alias: 'owner',
  email: 'owner@example.com',
  registered: true,
  authorized: true
});
assert.deepEqual(result.gcloud, {
  available: false,
  identity: { status: 'unknown', reason: 'gcloud_unavailable' }
});
assert.deepEqual(result.projectDiscovery, {
  status: 'unknown',
  reason: 'gcloud_unavailable',
  returned: 0,
  truncated: false
});
assert.deepEqual(result.projects, []);
assert.equal(result.readOnly, true);
assert.equal(result.activeConfigChanged, false);
assert.equal(result.contentTrust, 'untrusted');
assert.equal(result.grantsAuthority, false);
assert.deepEqual(activity, [
  ['active', 'gcloud.account.inspect', { provider: 'googleCloud' }],
  ['record', 'gcloud.account.inspect', 'selected-account', {
    gcloudAvailable: false,
    identityStatus: 'unknown',
    projectDiscoveryStatus: 'unknown',
    projectCount: 0,
    truncated: false,
    durationMs: 0
  }]
]);

assert.throws(
  () => infrastructure.gcloudAccountInspect({ account: ' owner@example.com' }, {
    accountRegistry: accountRegistry()
  }),
  /account must be an exact registered Google account alias or email/
);
assert.throws(
  () => infrastructure._testing.resolveSelectedAccount('owner', {
    ...accountRegistry(),
    list: () => [{ alias: 'owner', email: 'owner@example.com', authorized: false }]
  }),
  error => error.code === 'GOOGLE_ACCOUNT_NOT_AUTHORIZED'
);

console.log('Infrastructure provider behavior tests passed.');

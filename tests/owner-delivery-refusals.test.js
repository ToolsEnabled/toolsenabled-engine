'use strict';

require('./lib/isolated-environment').activate('owner-delivery-refusals');

const assert = require('node:assert/strict');

// Install the registry seam before owner-delivery captures loadRegistry. This
// drives the same missing-dashboard condition as a shipped registry with no
// dashboard, without changing this checkout's installation-specific config.
const serviceRegistry = require('../src/lib/service-registry');
const registryCacheEntry = require.cache[require.resolve('../src/lib/service-registry')];
registryCacheEntry.exports = {
  ...serviceRegistry,
  loadRegistry: () => ({ services: {} })
};
delete require.cache[require.resolve('../src/lib/owner-delivery')];
const delivery = require('../src/lib/owner-delivery');
registryCacheEntry.exports = serviceRegistry;

async function main() {
  let accountCalls = 0;
  let gmailCalls = 0;

  assert.throws(
    () => delivery.resolveChannel({
      channel: 'carrier-pigeon',
      // An explicit invalid channel must refuse before consulting config.
      file: '/this/file/must/not/be/read.json',
      env: { TOOLSENABLED_OWNER_DELIVERY_CHANNEL: 'email' }
    }),
    error => error instanceof delivery.OwnerDeliveryError &&
      error.code === 'OWNER_DELIVERY_CHANNEL_INVALID'
  );

  await assert.rejects(
    delivery.sendEmailToOwner(
      { subject: 'subject', text: 'body' },
      {
        accounts: {
          resolve() { accountCalls += 1; return 'owner'; },
          load() { accountCalls += 1; return { accounts: { owner: {} } }; }
        },
        gmail: {
          async gmailSend() { gmailCalls += 1; return { id: 'should-not-send' }; }
        }
      }
    ),
    error => error instanceof delivery.OwnerDeliveryError &&
      error.code === 'OWNER_DELIVERY_RECIPIENT_UNRESOLVED'
  );
  assert.equal(accountCalls, 2, 'the real recipient-resolution path must run');
  assert.equal(gmailCalls, 0, 'an unresolved recipient must not invoke Gmail');

  assert.throws(
    () => delivery.defaultDashboardUrl(),
    error => error && error.code === 'SERVICE_DASHBOARD_UNDECLARED'
  );
  assert.equal(gmailCalls, 0, 'dashboard refusal must not cause a delivery');

  console.log('owner-delivery driven refusal tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

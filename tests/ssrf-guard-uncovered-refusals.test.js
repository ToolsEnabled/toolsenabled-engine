'use strict';

const assert = require('node:assert/strict');
const guard = require('../src/lib/ssrf-guard');

let checks = 0;

async function refuses(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error instanceof guard.SsrfGuardError, true);
    assert.equal(error.code, code);
    return true;
  });
  checks += 1;
}

(async () => {
  let dependencyCalls = 0;
  await refuses(guard.resolveTarget('not a URL', {
    resolve: async () => { dependencyCalls += 1; return [{ address: '8.8.8.8' }]; }
  }), 'HTTP_URL_INVALID');
  assert.equal(dependencyCalls, 0, 'an invalid URL must refuse before DNS or transport work');

  await refuses(guard.resolveAddresses('', {
    resolve: async () => { dependencyCalls += 1; return [{ address: '8.8.8.8' }]; }
  }), 'HTTP_HOST_INVALID');
  assert.equal(dependencyCalls, 0, 'an invalid host must refuse before DNS work');

  let resolverCalls = 0;
  await refuses(guard.resolveAddresses('example.test', {
    resolve: async () => { resolverCalls += 1; throw new Error('fixture lookup failure'); }
  }), 'HTTP_DNS_LOOKUP_FAILED');
  assert.equal(resolverCalls, 1, 'lookup failure must stop after the attempted lookup');

  resolverCalls = 0;
  await refuses(guard.resolveAddresses('example.test', {
    resolve: async () => { resolverCalls += 1; return []; }
  }), 'HTTP_DNS_NO_ADDRESS');
  assert.equal(resolverCalls, 1, 'an empty answer must not cause another lookup');

  resolverCalls = 0;
  await refuses(guard.resolveAddresses('example.test', {
    resolve: async () => { resolverCalls += 1; return [{ address: 'definitely-not-an-ip' }]; }
  }), 'HTTP_DNS_INVALID_ADDRESS');
  assert.equal(resolverCalls, 1, 'an invalid answer must not cause another lookup');

  const target = await guard.resolveTarget('https://example.test/resource', {
    resolve: async () => [{ address: '8.8.8.8' }]
  });
  let transportCalls = 0;
  await refuses(guard.requestPinned(target, { method: 'POST', body: 'must-not-be-written' }, {
    transport: async request => {
      transportCalls += 1;
      assert.equal(request.body, 'must-not-be-written');
      return { status: 0, remoteAddress: '8.8.8.8' };
    }
  }), 'HTTP_RESPONSE_INVALID');
  assert.equal(transportCalls, 1, 'an invalid response must refuse without retrying or starting another transport');

  console.log(`SSRF refusal tests passed (${checks} driven refusals).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

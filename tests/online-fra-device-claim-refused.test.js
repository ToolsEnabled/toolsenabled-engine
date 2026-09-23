'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');

const spawnCalls = [];
const originalProcessMethods = new Map();
for (const method of ['exec', 'execFile', 'fork', 'spawn', 'spawnSync']) {
  originalProcessMethods.set(method, childProcess[method]);
  childProcess[method] = (...args) => {
    spawnCalls.push({ method, args });
    throw new Error(`unexpected child process via ${method}`);
  };
}

const {
  OnlineFraDeviceClaimError,
  createDeviceClaimClient
} = require('../src/lib/online-fra-device-claim');
const { DEVICE_IDENTITY_VAULT_KEY } = require('../src/lib/online-fra-device-identity');

const BASE_URL = 'https://app.toolsenabled.ai';
const identityPem = crypto.generateKeyPairSync('ed25519').privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();

function harness(response) {
  const writes = [];
  const requests = [];
  const vault = {
    getSecret(key) {
      if (key === DEVICE_IDENTITY_VAULT_KEY) return identityPem;
      const error = new Error('absent');
      error.code = 'SECRET_NOT_CONFIGURED';
      throw error;
    },
    setSecret(key, value) { writes.push({ key, value }); }
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { status: response.status, json: async () => response.body };
  };
  return {
    client: createDeviceClaimClient({ baseUrl: BASE_URL, vault, fetchImpl }),
    requests,
    writes
  };
}

async function assertRefused(label, response, drive, expectedMessage, expectedCode = 'DEVICE_CLAIM_REFUSED') {
  const subject = harness(response);
  await assert.rejects(
    drive(subject.client),
    error => {
      assert.ok(error instanceof OnlineFraDeviceClaimError, `${label}: throws the module's typed error`);
      assert.equal(error.name, 'OnlineFraDeviceClaimError', `${label}: preserves the public error name`);
      assert.equal(error.code, expectedCode, `${label}: distinguishes a refusal from an incomplete success response`);
      assert.equal(error.message, expectedMessage, `${label}: explains the refused operation`);
      assert.equal(error.requestOutcome, expectedCode === 'DEVICE_CLAIM_RESPONSE_INVALID' ? 'UNCERTAIN' : undefined);
      return true;
    }
  );
  assert.equal(subject.requests.length, 1, `${label}: makes only the injected request`);
  assert.deepEqual(subject.writes, [], `${label}: writes no identity or credential after refusal`);
}

(async () => {
  const invalidMessage = 'The account service returned an incomplete or unreadable claim response. '
    + 'The request may have reached the service; check its status before repeating it.';
  await assertRefused(
    'open response without a claim',
    { status: 503, body: null },
    client => client.openClaim({ name: 'Desk PC' }),
    'The claim was refused (503).'
  );

  await assertRefused(
    'status response without a state',
    { status: 200, body: {} },
    client => client.pollOnce({ pollToken: 'poll-status' }),
    invalidMessage, 'DEVICE_CLAIM_RESPONSE_INVALID'
  );

  await assertRefused(
    'reservation without an account email',
    { status: 200, body: { state: 'reserved', account: {} } },
    client => client.pollOnce({ pollToken: 'poll-reserved' }),
    invalidMessage, 'DEVICE_CLAIM_RESPONSE_INVALID'
  );

  await assertRefused(
    'grant without a device token',
    { status: 200, body: { state: 'granted', device: { pairId: 'pair-1' } } },
    client => client.pollOnce({ pollToken: 'poll-granted' }),
    invalidMessage, 'DEVICE_CLAIM_RESPONSE_INVALID'
  );

  await assertRefused(
    'decision response without the expected state',
    { status: 202, body: { state: 'pending' } },
    client => client.decideClaim({ pollToken: 'poll-decision', accept: true }),
    invalidMessage, 'DEVICE_CLAIM_RESPONSE_INVALID'
  );

  assert.deepEqual(spawnCalls, [], 'refusal paths spawn no child processes');
  console.log('online-fra-device-claim-refused: 5 driven refusals passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  for (const [method, implementation] of originalProcessMethods) childProcess[method] = implementation;
});

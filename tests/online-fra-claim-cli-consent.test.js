'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const production = require('../src/lib/online-fra-device-claim');
async function invoke(args, response) {
  const requests = [];
  const writes = [];
  let output = '';
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const processFixture = {
    argv: ['node', 'claim-cli', ...args], env: {},
    stdout: { write(value) { output += value; } }, stderr: { write() {} },
    set exitCode(value) { finish(value); }
  };
  const runtime = {
    getSecret() { const error = new Error('Absent'); error.code = 'SECRET_NOT_CONFIGURED'; throw error; },
    setSecret(...values) { writes.push(values); }, clearDeviceCredential() { throw new Error('Unexpected clear'); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../tools/online-fra-claim-cli.js'), 'utf8'), {
    process: processFixture, setTimeout,
    require(name) {
      if (name === '../src/lib/runtime') return runtime;
      if (name === '../src/lib/device-credential-clear-outcome') return require(name);
      assert.equal(name, '../src/lib/online-fra-device-claim');
      return { ...production, createDeviceClaimClient(options) {
        return production.createDeviceClaimClient({ ...options, fetchImpl: async (url, init) => {
          requests.push(JSON.parse(init.body));
          return { status: response.status, json: async () => response.body };
        } });
      } };
    }
  }, { timeout: 1000 });
  const exitCode = await completed;
  return { exitCode, output: JSON.parse(output), requests, writes };
}
const token = 'fixture-poll-token';
test('CLI preserves reserved account for the local consent screen', async () => {
  const result = await invoke(['poll', '--token', token], { status: 200, body: { state: 'reserved', account: { email: 'fixture@example.invalid' }, intervalSeconds: 5 } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, { state: 'reserved', account: { email: 'fixture@example.invalid' }, intervalSeconds: 5 });
  assert.deepEqual(result.requests, [{ pollToken: token }]);
  assert.deepEqual(result.writes, []);
});
for (const accept of [true, false]) test(`CLI transmits explicit ${accept ? 'acceptance' : 'decline'} without collecting credentials`, async () => {
  const state = accept ? 'accepted' : 'rejected';
  const result = await invoke(['poll', '--token', token, '--accept', String(accept)], { status: accept ? 202 : 200, body: { state } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, { state });
  assert.deepEqual(result.requests, [{ pollToken: token, accept }]);
  assert.deepEqual(result.writes, []);
});
test('CLI rejects malformed consent before making a request', async () => {
  const result = await invoke(['poll', '--token', token, '--accept', 'yes'], { status: 200, body: { state: 'pending', intervalSeconds: 5 } });
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.error.code, 'CLI_USAGE');
  assert.deepEqual(result.requests, []);
});

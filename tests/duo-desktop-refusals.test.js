'use strict';

const assert = require('node:assert/strict');
const duo = require('../src/lib/providers/duo-desktop');

const READY_STATUS = JSON.stringify({
  Installed: true,
  Version: '6.12.0.0',
  SignatureValid: true,
  SignerMatches: true,
  ProcessRunning: true,
  ServicesReady: true
});

function harness({ status = READY_STATUS, execution } = {}) {
  const calls = [];
  const overrides = {
    platform: 'win32',
    ucrAccount: 'person@example.edu',
    audit: {
      record(...args) { calls.push(['audit', ...args]); }
    },
    async runStatusProbe() {
      calls.push(['status']);
      return { ok: true, stdout: status };
    },
    async runLogin(input) {
      calls.push(['login', input]);
      return execution;
    }
  };
  return { calls, overrides };
}

async function refuses(input, overrides, code) {
  await assert.rejects(
    duo.ucrLogin(input, overrides),
    error => {
      assert.equal(error && error.code, code);
      return true;
    }
  );
}

(async () => {
  const invalidTimeout = harness();
  await refuses(
    { account: 'person@example.edu', timeoutSeconds: 59 },
    invalidTimeout.overrides,
    'DUO_DESKTOP_TIMEOUT_INVALID'
  );
  assert.deepEqual(invalidTimeout.calls, [], 'invalid input must not probe, spawn the login helper, or audit');

  const unavailable = harness({
    status: JSON.stringify({
      Installed: true,
      Version: '6.12.0.0',
      SignatureValid: true,
      SignerMatches: true,
      ProcessRunning: false,
      ServicesReady: true
    })
  });
  await refuses(
    { account: 'person@example.edu', timeoutSeconds: 60 },
    unavailable.overrides,
    'DUO_DESKTOP_UNAVAILABLE'
  );
  assert.equal(unavailable.calls.length, 2);
  assert.deepEqual(unavailable.calls.map(call => call[0]), ['status', 'audit']);
  assert.equal(unavailable.calls[1][1], 'duo.desktop_status');
  assert.equal(unavailable.calls.some(call => call[0] === 'login'), false,
    'unavailable Desktop must not spawn the login helper');
  assert.equal(unavailable.calls.some(call => call[1] === 'duo.ucr_login'), false,
    'a refusal must not write a successful-login audit record');

  for (const scenario of [
    {
      name: 'missing helper result',
      execution: undefined,
      code: 'DUO_DESKTOP_LOGIN_FAILED'
    },
    {
      name: 'busy browser protocol',
      execution: {
        ok: false,
        stdout: JSON.stringify({ ok: false, steps: [], failure: 'browser_session_busy' }),
        failure: 'browser_session_busy',
        timedOut: false
      },
      code: 'DUO_DESKTOP_BROWSER_SESSION_BUSY'
    },
    {
      name: 'credential protocol',
      execution: {
        ok: false,
        stdout: JSON.stringify({ ok: false, steps: [], failure: 'credential_unavailable' }),
        failure: 'credential_unavailable',
        timedOut: false
      },
      code: 'DUO_DESKTOP_CREDENTIAL_REQUIRED'
    }
  ]) {
    const driven = harness({ execution: scenario.execution });
    await refuses(
      { account: 'person@example.edu', timeoutSeconds: 60 },
      driven.overrides,
      scenario.code
    );
    assert.equal(driven.calls.length, 3);
    assert.deepEqual(driven.calls.map(call => call[0]), ['status', 'audit', 'login']);
    assert.equal(driven.calls[1][1], 'duo.desktop_status');
    assert.deepEqual(driven.calls[2],
      ['login', { timeoutMs: 60_000, exactAgentApproval: false }]);
    assert.equal(driven.calls.some(call => call[1] === 'duo.ucr_login'), false,
      `${scenario.name} must not write a successful-login audit record`);
  }

  process.stdout.write('duo-desktop driven refusal tests passed\n');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

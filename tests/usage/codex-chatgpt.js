// Product requirement: no pinned Codex version. New parseable
// versions must pass the same initialization and response-shape checks;
// neither an unreadable version nor protocol drift may publish an allowance.

'use strict';

const assert = require('node:assert/strict');
const {
  CODEX_APP_SERVER_CLI_VERSION,
  createCodexChatgptAdapter
} = require('../../src/lib/usage/adapters/codex-chatgpt');

const ACCOUNT = Object.freeze({ accountId: 'acct-1', provider: 'openai', lane: 'subscription' });
const NOW_MS = Date.parse('2026-08-27T12:00:00.000Z');

function rateLimits(overrides = {}) {
  return {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 37, windowDurationMins: 7 * 24 * 60, resetsAt: 1787918400 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null,
    spendControlReached: false,
    planType: 'plus',
    rateLimitReachedType: null,
    ...overrides
  };
}

function transport(replies, requests = [], cliVersion = CODEX_APP_SERVER_CLI_VERSION) {
  return {
    cliVersion,
    async request(request) {
      requests.push(request);
      return replies.shift();
    }
  };
}

(async function run() {
  assert.throws(
    () => createCodexChatgptAdapter({ transport: { cliVersion: CODEX_APP_SERVER_CLI_VERSION } }),
    { name: 'TypeError', message: 'Codex app-server transport is invalid.' }
  );

  const requests = [];
  const adapter = createCodexChatgptAdapter({
    transport: transport([
      { jsonrpc: '2.0', id: 1, result: { userAgent: 'test' } },
      { result: rateLimits(), observedAt: '2026-08-27T11:59:58.123Z' }
    ], requests)
  });
  assert.equal(adapter.id, 'codex-chatgpt');
  assert.deepEqual(await adapter.read(ACCOUNT, { nowMs: NOW_MS }), {
    schemaVersion: 1,
    ...ACCOUNT,
    used: 37,
    remaining: 63,
    unit: 'percent-weekly',
    resetsAt: '2026-08-28T12:00:00.000Z',
    provenance: 'MEASURED',
    observedAt: '2026-08-27T11:59:58.123Z',
    reason: null,
    scope: 'ACCOUNT_ALLOWANCE'
  });
  assert.deepEqual(requests, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }
  ]);

  const unavailable = await createCodexChatgptAdapter().read(ACCOUNT, { nowMs: NOW_MS });
  assert.equal(unavailable.provenance, 'UNKNOWN');
  assert.equal(unavailable.reason, 'PROVIDER_SURFACE_UNAVAILABLE');
  assert.equal(unavailable.used, null);

  for (const version of ['codex-cli 0.146.1', 'codex-cli 0.155.1', 'codex-cli 999.0.0',
    'codex-cli 1.0.0-alpha.1+build.2', ' codex-cli 2.3.4\n']) {
    const calls = [];
    const measured = await createCodexChatgptAdapter({
      transport: transport([{ initialized: true }, rateLimits()], calls, version)
    }).read(ACCOUNT, { nowMs: NOW_MS });
    assert.equal(measured.provenance, 'MEASURED', `${version}: supported protocol must not depend on a version pin`);
    assert.equal(measured.used, 37);
    assert.equal(measured.remaining, 63);
    assert.deepEqual(calls.map(call => call.method), ['initialize', 'account/rateLimits/read']);
  }

  for (const version of ['', 'codex-cli unknown', 'codex-cli 0.146', 'other-cli 0.146.0',
    'codex-cli 0.146.0 unexpected', 'codex-cli 1.2.3-', 'codex-cli 1.2.3+', 'codex-cli 1.2.3-..']) {
    const calls = [];
    const invalidVersion = await createCodexChatgptAdapter({
      transport: transport([{ initialized: true }, rateLimits()], calls, version)
    }).read(ACCOUNT, { nowMs: NOW_MS });
    assert.equal(invalidVersion.provenance, 'UNKNOWN', version);
    assert.equal(invalidVersion.reason, 'PROVIDER_SURFACE_INVALID', version);
    assert.equal(invalidVersion.used, null);
    assert.equal(invalidVersion.remaining, null);
    assert.equal(calls.length, 0, `${version}: unreadable identity must fail before I/O`);
  }

  const changedCalls = [];
  const changedTransport = transport([{ initialized: true }, rateLimits()], changedCalls);
  const changedIdentity = createCodexChatgptAdapter({ transport: changedTransport });
  changedTransport.cliVersion = null;
  assert.equal((await changedIdentity.read(ACCOUNT, { nowMs: NOW_MS })).reason, 'PROVIDER_SURFACE_INVALID');
  assert.equal(changedCalls.length, 0);

  for (const payload of [rateLimits({ secondary: {} }), rateLimits({ newAllowance: 100 }),
    rateLimits({ credits: { hasCredits: false, unlimited: false } })]) {
    const calls = [];
    const invalidPayload = await createCodexChatgptAdapter({
      transport: transport([{ initialized: true }, payload], calls, 'codex-cli 999.0.0')
    }).read(ACCOUNT, { nowMs: NOW_MS });
    assert.equal(invalidPayload.provenance, 'UNKNOWN');
    assert.equal(invalidPayload.reason, 'PROVIDER_SURFACE_INVALID');
    assert.equal(invalidPayload.used, null);
    assert.equal(invalidPayload.remaining, null, 'new versions must not bypass response-shape validation');
    assert.equal(calls.length, 2);
  }

  for (const reply of [undefined, { jsonrpc: '2.0', id: 1, error: { code: -32600 } },
    { jsonrpc: '1.0', id: 1, result: {} }]) {
    const calls = [];
    const uninitialized = await createCodexChatgptAdapter({
      transport: transport([reply, rateLimits()], calls, 'codex-cli 999.0.0')
    }).read(ACCOUNT, { nowMs: NOW_MS });
    assert.equal(uninitialized.provenance, 'UNKNOWN');
    assert.equal(uninitialized.reason, 'PROVIDER_SURFACE_INVALID');
    assert.equal(uninitialized.used, null);
    assert.equal(uninitialized.remaining, null);
    assert.deepEqual(calls.map(call => call.method), ['initialize'], 'failed handshake must prevent the usage read');
  }

  const rejected = await createCodexChatgptAdapter({
    transport: {
      cliVersion: CODEX_APP_SERVER_CLI_VERSION,
      request: async () => { throw new Error('offline'); }
    }
  }).read(ACCOUNT, { nowMs: NOW_MS });
  assert.equal(rejected.reason, 'PROVIDER_SURFACE_UNAVAILABLE');

  console.log('codex-chatgpt adapter: version compatibility, handshake and response-shape checks passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

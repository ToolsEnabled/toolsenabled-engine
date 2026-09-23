// Mutation check (2026-08-27): in src/lib/usage/adapters/codex-chatgpt.js,
// changed CODEX_APP_SERVER_CLI_VERSION from "codex-cli 0.146.0" to
// "codex-cli 0.147.0". The edit landed (confirmed in the module), and this
// isolated test went red with exit code 1. The module was then restored and
// its original SHA-256 was confirmed.

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

function transport(replies, requests = []) {
  return {
    cliVersion: CODEX_APP_SERVER_CLI_VERSION,
    async request(request) {
      requests.push(request);
      return replies.shift();
    }
  };
}

(async function run() {
  assert.equal(CODEX_APP_SERVER_CLI_VERSION, 'codex-cli 0.146.0');
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

  const invalidVersion = await createCodexChatgptAdapter({
    transport: { cliVersion: 'codex-cli 999.0.0', request: async () => assert.fail('must not perform I/O') }
  }).read(ACCOUNT, { nowMs: NOW_MS });
  assert.equal(invalidVersion.reason, 'PROVIDER_SURFACE_INVALID');

  const invalidPayload = await createCodexChatgptAdapter({
    transport: transport([{ initialized: true }, rateLimits({ secondary: {} })])
  }).read(ACCOUNT, { nowMs: NOW_MS });
  assert.equal(invalidPayload.reason, 'PROVIDER_SURFACE_INVALID');
  assert.equal(invalidPayload.remaining, null, 'invalid provider data must not publish an allowance');

  const rejected = await createCodexChatgptAdapter({
    transport: {
      cliVersion: CODEX_APP_SERVER_CLI_VERSION,
      request: async () => { throw new Error('offline'); }
    }
  }).read(ACCOUNT, { nowMs: NOW_MS });
  assert.equal(rejected.reason, 'PROVIDER_SURFACE_UNAVAILABLE');

  console.log('codex-chatgpt adapter: 6 behavior checks passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

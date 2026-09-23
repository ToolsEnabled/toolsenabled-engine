'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PROTOCOL, parseFrame } = require('../../src/lib/providers/gemini-quota-protocol');
const { probeGeminiAccount, STATUS } = require('../../src/lib/multi-account/health');
const { selectAccount } = require('../../src/lib/multi-account/switcher');
const { withProbeLifecycle } = require('../../src/lib/multi-account/probe-lifecycle');
const id = '1'.repeat(32), email = 'fixture@example.test';
const account = { name: 'fixture', provider: 'gemini', home: path.resolve('synthetic-home'), expectEmail: email };
const fsImpl = { statSync() { return { isFile: () => true }; } };
const RETIRED_TIER = Object.freeze({ reasonCode: 'UNSUPPORTED_CLIENT',
  reasonMessage: 'This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products.' });
const decode = result => parseFrame(`${PROTOCOL}\t${JSON.stringify({ version: 1, id, ...result })}`, id);

async function pipeline({ failure = 'quota', identity = email } = {}) {
  const operations = [];
  const { readGeminiQuota } = await import('../../src/lib/providers/gemini-quota-worker-core.mjs');
  const sdk = { Config: class {}, AuthType: { LOGIN_WITH_GOOGLE: 'oauth-personal' },
    getOauthClient: async () => ({ request: async () => {
      operations.push('userinfo');
      if (identity === null) throw Error('Synthetic identity service failure');
      return { data: { email: identity } };
    } }),
    CodeAssistServer: class {
      async loadCodeAssist() {
        operations.push('loadCodeAssist');
        if (failure === 'health') throw Error('Synthetic health service failure');
        if (failure === 'validation') return { ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED' }] };
        if (failure === 'tier') return {};
        if (failure === 'project') return { currentTier: { id: 'free-tier' } };
        // Google's answer for an individual account after it stopped serving
        // them through Gemini CLI (2026-06-18, gemini-cli discussion 28017).
        if (failure === 'retired') return { ineligibleTiers: [RETIRED_TIER] };
        if (failure === 'retired-onboarded') return { currentTier: { id: 'free-tier' }, ineligibleTiers: [RETIRED_TIER] };
        if (failure === 'retired-message') return { ineligibleTiers: [{ reasonMessage: RETIRED_TIER.reasonMessage }] };
        if (failure === 'licensed') return { currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'fixture-project', ineligibleTiers: [RETIRED_TIER] };
        return { currentTier: { id: 'free-tier' }, cloudaicompanionProject: failure === 'changed-project' ? 'changed' : 'fixture-project' };
      }
      async retrieveUserQuota() {
        operations.push('retrieveUserQuota');
        if (failure === 'quota') throw Error('Synthetic quota service failure');
        if (failure === 'malformed') return [];
        return { buckets: [{ modelId: 'fixture-model', tokenType: 'REQUESTS', remainingFraction: 0.5 }] };
      }
    } };
  const raw = await readGeminiQuota(sdk, { cwd: '.', id, ...(failure === 'changed-project' ? { project: 'fixture-project' } : {}) });
  const result = decode(raw);
  assert.ok(result, 'The actual worker result must cross the current validated wire decoder');
  const reading = await probeGeminiAccount(account, { fsImpl, quotaProbe: async () => withProbeLifecycle(result, 'closed') });
  const selected = await selectAccount({ registry: { accounts: [account] }, probe: async () => reading });
  return { raw, result, reading, selected, operations };
}

for (const failure of ['health', 'quota', 'malformed']) test(`verified matching identity survives ${failure} unavailability without invented allowance`, async () => {
  const f = await pipeline({ failure });
  assert.equal(f.result.status, 'unavailable');
  assert.equal(f.result.email, email);
  assert.equal(f.reading.email, email);
  assert.equal(f.reading.status, STATUS.HEALTHY);
  assert.equal(f.reading.canServe, true);
  assert.equal(f.reading.usageStatus, 'unavailable');
  assert.equal(f.reading.usageCode, failure === 'malformed' ? 'GEMINI_USAGE_MALFORMED' : 'GEMINI_SERVICE_UNAVAILABLE');
  assert.equal(f.reading.allowanceBuckets, null);
  assert.equal(f.reading.usedPercent, null);
  assert.equal(f.selected.ok, true, 'The canonical Start selector must not reject independently verified identity for missing quota');
  assert.deepEqual(f.operations, failure === 'health' ? ['userinfo', 'loadCodeAssist'] : ['userinfo', 'loadCodeAssist', 'retrieveUserQuota']);
});

test('quota failure still blocks a pinned account when userinfo never verified its identity', async () => {
  const f = await pipeline({ identity: null });
  assert.equal(f.reading.email, null);
  assert.equal(f.reading.status, STATUS.TRANSIENT);
  assert.equal(f.reading.canServe, false);
  assert.equal(f.selected.ok, false);
});

test('a verified mismatching identity still blocks even when quota fails afterwards', async () => {
  const f = await pipeline({ identity: 'another@example.test' });
  assert.equal(f.reading.email, 'another@example.test');
  assert.equal(f.reading.status, STATUS.ACCOUNT_MISMATCH);
  assert.equal(f.reading.canServe, false);
  assert.equal(f.selected.code, 'ACCOUNT_MISMATCH');
});

for (const [failure, code] of [['validation', 'GEMINI_VALIDATION_REQUIRED'], ['tier', 'GEMINI_NOT_PROVISIONED'],
  ['project', 'GEMINI_PROJECT_UNAVAILABLE'], ['changed-project', 'GEMINI_PROJECT_CHANGED']]) {
  test(`verified identity remains a fact but does not override ${code}`, async () => {
    const f = await pipeline({ failure });
    assert.equal(f.result.email, email);
    assert.equal(f.reading.email, email);
    assert.equal(f.reading.status, STATUS.TRANSIENT);
    assert.equal(f.reading.canServe, false);
    assert.equal(f.reading.usageCode, code);
    assert.equal(f.reading.allowanceBuckets, null);
    assert.equal(f.selected.ok, false);
    assert.equal(f.operations.includes('retrieveUserQuota'), false);
    const unpinned = await probeGeminiAccount({ ...account, expectEmail: null }, { fsImpl, quotaProbe: async () => f.result });
    assert.equal(unpinned.canServe, false, 'A known service refusal is not permission just because no email was pinned');
  });
}

test('auth, storage, runtime and transport failures cannot carry a usable identity through the protocol', async () => {
  for (const code of ['GEMINI_CACHED_AUTH_UNAVAILABLE', 'GEMINI_AUTH_FILE_CHANGED', 'GEMINI_AUTH_FILE_UNAVAILABLE',
    'GEMINI_AUTH_MODE_UNSUPPORTED', 'GEMINI_RUNTIME_UNAVAILABLE', 'GEMINI_USAGE_OUTPUT_LIMIT',
    'GEMINI_USAGE_TIMEOUT', 'GEMINI_USAGE_CANCELLED', 'GEMINI_WORKER_EXIT_FAILED']) {
    const result = decode({ status: 'unavailable', code, email });
    assert.equal(result.email, undefined, code);
    const reading = await probeGeminiAccount(account, { fsImpl, quotaProbe: async () => result });
    assert.equal(reading.canServe, false, code);
  }
});

test('malformed unavailable-frame identity is rejected, while absent identity remains unknown', () => {
  for (const invalid of ['', 'not-an-email', ['fixture@example.test'], { email }, 42]) {
    assert.equal(decode({ status: 'unavailable', code: 'GEMINI_SERVICE_UNAVAILABLE', email: invalid }), null);
  }
  assert.equal(decode({ status: 'unavailable', code: 'GEMINI_SERVICE_UNAVAILABLE' }).email, undefined);
});

// PERMANENT, NOT "UNKNOWN". Google stopped serving individual accounts through
// Gemini CLI. Before this, the health read called that answer "not provisioned"
// and TRANSIENT, so Start stopped on the account forever with a sentence that
// promised nothing and named no way forward.
for (const failure of ['retired', 'retired-onboarded', 'retired-message']) test(`an individual account Google no longer serves through Gemini CLI is told so plainly (${failure})`, async () => {
  const { GEMINI_INDIVIDUAL_RETIREMENT_MESSAGE } = require('../../src/lib/agent-engine/acp-adapter');
  const f = await pipeline({ failure });
  assert.equal(f.result.status, 'unavailable');
  assert.equal(f.result.code, 'GEMINI_CLIENT_RETIRED');
  assert.equal(f.result.email, email, 'the retirement answer arrives after verified identity and keeps it');
  assert.equal(f.reading.usageCode, 'GEMINI_CLIENT_RETIRED');
  assert.equal(f.reading.status, STATUS.NOT_PROVISIONED, 'a retired client is not a transient unknown');
  assert.equal(f.reading.canServe, false);
  assert.equal(f.reading.allowanceBuckets, null);
  assert.equal(f.reading.reason, GEMINI_INDIVIDUAL_RETIREMENT_MESSAGE, 'the same sentence the Research start shows');
  assert.equal(f.reading.usageReason, GEMINI_INDIVIDUAL_RETIREMENT_MESSAGE);
  assert.equal(f.operations.includes('retrieveUserQuota'), false);
  assert.equal(f.selected.ok, false);
  assert.equal(f.selected.code, 'NO_ACCOUNT_USABLE', 'Start does not stop on it as an unknown');
  const unpinned = await probeGeminiAccount({ ...account, expectEmail: null }, { fsImpl, quotaProbe: async () => f.result });
  assert.equal(unpinned.canServe, false);
  assert.equal(unpinned.status, STATUS.NOT_PROVISIONED);
});

test('a retired individual account does not block failover to another Gemini account that still serves', async () => {
  const f = await pipeline({ failure: 'retired' });
  const licensed = { name: 'work', provider: 'gemini', home: path.resolve('synthetic-home-work'), expectEmail: null };
  const selected = await selectAccount({ registry: { accounts: [account, licensed] },
    probe: async candidate => candidate.name === 'work'
      ? probeGeminiAccount(licensed, { fsImpl, quotaProbe: async () => withProbeLifecycle({ status: 'observed', email: 'work@example.test',
        allowanceBuckets: null }, 'closed') })
      : f.reading });
  assert.equal(selected.ok, true);
  assert.equal(selected.account.name, 'work');
});

test('an account with a Code Assist tier and project keeps serving even when Google lists the individual tier as retired', async () => {
  const f = await pipeline({ failure: 'licensed' });
  assert.equal(f.result.status, 'observed');
  assert.equal(f.reading.status, STATUS.HEALTHY);
  assert.equal(f.reading.canServe, true);
  assert.deepEqual(f.operations, ['userinfo', 'loadCodeAssist', 'retrieveUserQuota']);
});

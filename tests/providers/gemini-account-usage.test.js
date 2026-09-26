'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { probeGeminiAccount, STATUS } = require('../../src/lib/multi-account/health');
const { defaultProbeFor } = require('../../src/lib/multi-account/rotation');
const { decodeGeminiQuota } = require('../../src/lib/usage/gemini-quota');
const { withProbeLifecycle, probeLifecycleOf } = require('../../src/lib/multi-account/probe-lifecycle');

const account = { name: 'lab', provider: 'gemini', home: path.resolve('synthetic-gemini-home'), expectEmail: null };
const fsImpl = { statSync() { return { isFile: () => true }; } };
const allowanceBuckets = decodeGeminiQuota({ buckets: [
  { modelId: 'gemini-2.5-pro', tokenType: 'INPUT', remainingFraction: 0, remainingAmount: '90071992547409931234', resetTime: '2026-09-15T00:00:00Z' },
  { modelId: 'gemini-2.5-flash', tokenType: 'OUTPUT', remainingFraction: 0.5 }
] }, { observedAt: '2026-09-14T18:00:00Z', sourceVersion: '0.58.0' });
const observation = withProbeLifecycle({ status: 'observed', email: 'fixture@example.test', allowanceBuckets }, 'closed');

test('canonical Gemini factory reports precise independent buckets without pooled usage or rank windows', async () => {
  let called = 0;
  const probe = defaultProbeFor('gemini', { fsImpl, quotaProbe: async ({ home }) => { called++; assert.equal(home, account.home); return observation; } });
  const row = await probe(account);
  assert.equal(called, 1);
  assert.equal(row.status, STATUS.HEALTHY);
  assert.equal(row.canServe, true, 'one exhausted model decided service for every model');
  assert.equal(row.usageStatus, 'measured');
  assert.equal(row.allowanceBuckets, allowanceBuckets);
  assert.equal(row.allowanceBuckets.buckets[0].remainingAmount, '90071992547409931234');
  assert.equal(row.usedPercent, null);
  assert.deepEqual(row.windows, { hourly: null, weekly: null, weeklyWindows: [] });
  assert.equal(probeLifecycleOf(row), 'closed');
  assert.equal(Object.keys(row).includes('probeLifecycle'), false);
});

for (const [mode, email, status] of [['match', 'fixture@example.test', STATUS.HEALTHY], ['mismatch', 'other@example.test', STATUS.ACCOUNT_MISMATCH], ['missing', null, STATUS.TRANSIENT]]) {
  test(`fresh Gemini identity ${mode} enforces the registered expectation`, async () => {
    const row = await probeGeminiAccount({ ...account, expectEmail: 'fixture@example.test' }, { fsImpl,
      quotaProbe: async () => withProbeLifecycle({ ...observation, email }, 'closed') });
    assert.equal(row.status, status);
    assert.equal(row.canServe, mode === 'match');
    assert.equal(row.allowanceBuckets, mode === 'match' ? allowanceBuckets : null);
  });
}

for (const code of ['GEMINI_CACHED_AUTH_UNAVAILABLE', 'GEMINI_SERVICE_UNAVAILABLE', 'GEMINI_AUTH_MODE_UNSUPPORTED']) {
  // This is explicitly the case with NO independently verified userinfo.
  // Separate worker/frame/health tests cover identity verified before quota
  // failure; a generic unavailable result cannot erase that distinction.
  test(`${code} without verified identity does not invent expiry, usage or identity`, async () => {
    const options = { fsImpl, quotaProbe: async () => ({ status: 'unavailable', code }) };
    const row = await probeGeminiAccount(account, options);
    assert.equal(row.status, STATUS.HEALTHY);
    assert.equal(row.allowanceBuckets, null);
    assert.equal(row.usedPercent, null);
    assert.equal(row.usageStatus, code === 'GEMINI_AUTH_MODE_UNSUPPORTED' ? 'unsupported' : 'unavailable');
    assert.equal(probeLifecycleOf(row), null);
    const pinned = await probeGeminiAccount({ ...account, expectEmail: 'fixture@example.test' }, options);
    assert.equal(pinned.status, STATUS.TRANSIENT);
    assert.equal(pinned.canServe, false);
  });
}

test('no sign-in file does not invoke the SDK worker', async () => {
  let calls = 0;
  const row = await probeGeminiAccount(account, { fsImpl: { statSync() { throw Object.assign(Error(), { code: 'ENOENT' }); } }, quotaProbe: async () => { calls++; } });
  assert.equal(row.status, STATUS.SIGNED_OUT);
  assert.equal(calls, 0);
});

test('rotation preserves buckets and does not label a failed canonical probe as unsupported', async t => {
  const fs = require('node:fs'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-account-row-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registryPath = path.join(root, 'accounts.json');
  fs.writeFileSync(registryPath, JSON.stringify({ accounts: [{ name: 'lab', provider: 'gemini', homeDir: '.gemini-lab', priority: 1 }] }));
  const { readAccountUsage } = require('../../src/lib/multi-account/rotation');
  const options = { registryPath, homeDir: root, providers: ['gemini'] };
  const measured = await readAccountUsage({ ...options, probeFor: () => async () => ({ status: 'healthy', canServe: true, allowanceBuckets, usageStatus: 'measured' }) });
  assert.equal(measured.accounts.length, 1);
  assert.equal(measured.accounts[0].allowanceBuckets, allowanceBuckets);
  const failed = await readAccountUsage({ ...options, probeFor: () => async () => { throw Error('synthetic failure'); } });
  assert.equal(failed.accounts[0].usageStatus, 'unavailable');
  assert.equal(failed.accounts[0].usageCode, 'GEMINI_USAGE_UNAVAILABLE');
  assert.equal(failed.accounts[0].allowanceBuckets, null);
});

test('worker core rejects malformed top-level quota but preserves a legitimate empty object', async () => {
  const { readGeminiQuota } = await import('../../src/lib/providers/gemini-quota-worker-core.mjs');
  for (const quota of [null, undefined, [], '', false, 3, {}]) {
    const sdk = { Config: class {}, AuthType: { LOGIN_WITH_GOOGLE: 'oauth-personal' },
      getOauthClient: async () => ({ request: async () => ({ data: { email: 'fixture@example.test' } }) }),
      CodeAssistServer: class {
        async loadCodeAssist() { return { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'fixture-project' }; }
        async retrieveUserQuota() { return quota; }
      } };
    const result = await readGeminiQuota(sdk, { cwd: '.', id: 'fixture' });
    if (quota && !Array.isArray(quota) && typeof quota === 'object') assert.deepEqual(result.quota, { buckets: [] });
    else assert.equal(result.code, 'GEMINI_USAGE_MALFORMED');
  }
});

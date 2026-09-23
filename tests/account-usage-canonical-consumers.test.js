'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const quota = require('../src/lib/status-injection');
const rotation = require('../src/lib/multi-account/rotation');
const { listAccountRouter } = require('../src/lib/tool-registry');

const NOW = Date.parse('2026-09-14T18:00:00.000Z');
const HOME = path.join(os.tmpdir(), 'canonical-usage-fixture');
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const measured = (provider, allowanceBinding, usedPercent, extra = {}) => ({
  provider, allowanceBinding, name: 'synthetic-account', status: 'healthy', canServe: true,
  usedPercent, usageStatus: 'measured', resetsAt: '2026-09-15T00:00:00.000Z', ...extra
});
function canonicalDependencies(accounts) {
  const calls = [];
  return { calls, dependencies: {
    accountRegistryPathImpl: () => path.join(HOME, 'accounts.json'),
    readAccountUsageImpl: async options => { calls.push(options); return { ok: true, accounts }; },
    // These old seams keep RED runs synthetic and must be unused after repair.
    loadRegistryImpl: () => ({ accounts: [] }),
    readClaudeCache: () => null
  } };
}

test('explicit Codex quota uses the canonical reader and excludes other provider rows', async () => {
  const fixture = canonicalDependencies([
    measured('codex', A, 25), measured('codex', B, null, { usageStatus: 'unavailable' }),
    measured('claude', C, 99), measured('grok', C, 100)
  ]);
  const answer = await quota.readDefaultCodexQuota({ homeDir: HOME }, fixture.dependencies);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0].providers, ['codex']);
  assert.equal(fixture.calls[0].homeDir, HOME);
  assert.equal(fixture.calls[0].timeoutMs, 8000);
  assert.equal(answer.status, 'PARTIAL');
  assert.equal(answer.accountCount, 2);
  assert.equal(answer.unknownAccounts, 1);
  assert.equal(answer.maxUsedPercent, 25);
  assert.equal(answer.minRemainingPercent, 75);
});

test('explicit Claude quota aggregates only requested account bindings and never reads ambient cache', async () => {
  const fixture = canonicalDependencies([
    measured('claude', A, 61.27), measured('claude', B, 98), measured('codex', A, 100)
  ]);
  fixture.dependencies.readClaudeCache = () => { throw new Error('ambient cache must not be opened'); };
  const answer = await quota.readDefaultClaudeQuota({ homeDir: HOME, accountBindings: [A],
    claudeSdkQuery: { get_usage() { throw new Error('unbound SDK must not be called'); } }
  }, fixture.dependencies);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0].providers, ['claude']);
  assert.deepEqual(fixture.calls[0].accountBindings, [A]);
  assert.equal(answer.accountCount, 1);
  assert.equal(answer.maxUsedPercent, 61.27);
  assert.equal(answer.status, 'MEASURED');
  assert.equal(Object.hasOwn(answer, 'name'), false);
});

test('the explicit combined quota reader makes one canonical batch and does not hide partial Claude coverage', async () => {
  const fixture = canonicalDependencies([
    measured('codex', A, 10), measured('claude', A, 20),
    measured('claude', B, null, { usageStatus: 'unavailable' }),
    measured('claude', C, 100, { status: 'exhausted', canServe: false })
  ]);
  // Avoid the old implementation's unconditional real readers during RED.
  assert.equal(typeof rotation.defaultProbeFor, 'function');
  const answer = await quota.readDefaultQuota({ homeDir: HOME }, fixture.dependencies);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0].providers, ['codex', 'claude']);
  assert.equal(answer.codex.accountCount, 1);
  assert.equal(answer.claude.accountCount, 3);
  assert.equal(answer.claude.unknownAccounts, 1);
  assert.equal(answer.claude.status, 'PARTIAL');
  assert.equal(answer.claude.exhaustedAccounts, 1);
});

test('automatic quota refuses any unbound aggregate without file, SDK or provider work', async () => {
  let reads = 0, probes = 0, writes = 0;
  const deps = { clock: () => NOW, quotaObservationFile: path.join(HOME, 'old-observation.json'),
    fsImpl: {
      readFileSync() { reads += 1; return JSON.stringify({ schemaVersion: 1, observedAtMs: NOW,
        quota: { codex: { status: 'MEASURED', accountCount: 1, maxUsedPercent: 99, minRemainingPercent: 1 } } }); },
      mkdirSync() { writes += 1; }, writeFileSync() { writes += 1; }, renameSync() { writes += 1; }, rmSync() { writes += 1; }
    }, probeQuota: async () => { probes += 1; return { status: 'UNKNOWN' }; }
  };
  for (let i = 0; i < 20; i += 1) {
    const answer = await quota.readQuotaObservation({}, deps);
    assert.deepEqual(answer, { status: 'UNKNOWN', reason: 'QUOTA_BOUND_SNAPSHOT_UNAVAILABLE' });
  }
  assert.deepEqual({ reads, probes, writes }, { reads: 0, probes: 0, writes: 0 });
});

test('unavailable automatic quota is informational and preserves the onboarding packet and other sources', async () => {
  let calls = 0;
  const read = value => () => { calls += 1; return value; };
  const text = await quota.prependStatusInjection('BEGIN OWNER ONBOARDING', {
    settings: { values: { 'agent.status_injection': true } }
  }, { clock: () => NOW, environment: {},
    readMachineLoad: read({ status: 'MEASURED', utilizationPercent: 12, coreCount: 4, sampleIntervalMs: 100 }),
    readMemory: read({ status: 'MEASURED', freeBytes: 10, totalBytes: 20, freePercent: 50 }),
    readStateHealth: read({ ok: true }), readAuditDurability: read({ state: 'ok' }),
    readOwnerCapture: read([]), readUsage: read({ coverage: {}, totals: {} }),
    fsImpl: { readFileSync() { throw new Error('no quota file reads'); } },
    probeQuota() { throw new Error('no hook provider probe'); }
  });
  assert.match(text, /quota=UNKNOWN\(QUOTA_BOUND_SNAPSHOT_UNAVAILABLE\)/);
  assert.match(text, /cpu=12%/);
  assert.match(text, /BEGIN OWNER ONBOARDING$/);
  assert.equal(calls, 6);
  assert.doesNotMatch(text, /signed.out|expired|exhausted/i);
});

function routerDependencies(accounts, extra = {}) {
  return { homeDir: HOME, registryPathImpl: () => path.join(HOME, 'accounts.json'),
    readRegistryQuietlyImpl: () => ({ registry: { accounts, exhaustedAtPercent: 90 } }), ...extra };
}
function claudeAccount(name, extra = {}) {
  return { name, provider: 'claude', configDir: path.join(HOME, name), ...extra };
}
const signedIn = async () => ({ state: 'indeterminate', capabilityRan: false,
  billingSource: 'subscription', account: 'fixture@example.invalid', plan: 'pro' });
const liveUsage = async () => ({ status: 'MEASURED', fetchedAtMs: NOW, ageMs: 0,
  source: 'claude-get-usage', activeLimits: [], bindingLimit: null,
  limits: [{ kind: 'five_hour', group: null, applicability: 'MEASURED', percent: 62,
    resetsAt: '2026-09-15T00:00:00.000Z', model: null, isActive: true, index: 0 }] });

test('the router reads Claude auth and quota through the same canonical factory as Accounts', async () => {
  let usageCalls = 0;
  const answer = await listAccountRouter({}, routerDependencies([claudeAccount('one')], {
    claudeAuthProbeImpl: signedIn, claudeUsageProbeImpl: async options => {
      usageCalls += 1;
      assert.equal(options.configDir, path.join(HOME, 'one'));
      return liveUsage();
    }
  }));
  assert.equal(usageCalls, 1);
  assert.equal(answer.accounts[0].remainingPercent, 38);
  assert.equal(answer.accounts[0].providerUsable, true);
  assert.equal(answer.accounts[0].usable, 'UNKNOWN', 'an unmeasured lock is still unknown');
});

test('canonical router identity mismatch blanks quota and cannot turn a different login into available', async () => {
  const answer = await listAccountRouter({}, routerDependencies([
    claudeAccount('one', { expectEmail: 'expected@example.invalid' })
  ], { claudeAuthProbeImpl: signedIn, claudeUsageProbeImpl: liveUsage }));
  assert.equal(answer.accounts[0].healthStatus, 'account_mismatch');
  assert.equal(answer.accounts[0].remainingPercent, 'UNKNOWN');
  assert.equal(answer.accounts[0].providerUsable, false);
});

test('Gemini and Grok router rows dispatch their own canonical provider factory', async () => {
  const calls = [];
  const accounts = ['gemini', 'grok'].map(provider => ({ name: provider, provider, configDir: path.join(HOME, provider) }));
  const answer = await listAccountRouter({}, routerDependencies(accounts, {
    accountProbeForImpl(provider, options) {
      assert.equal(options.homeDir, HOME);
      return async account => { calls.push([provider, account.name]); return measured(provider, A, provider === 'grok' ? 40 : null); };
    }
  }));
  assert.deepEqual(calls, [['gemini', 'gemini'], ['grok', 'grok']]);
  assert.equal(answer.accounts[0].remainingPercent, 'UNKNOWN');
  assert.equal(answer.accounts[1].remainingPercent, 60);
});

test('the exported canonical factory refuses an unknown provider before any Codex fallback', () => {
  assert.equal(typeof rotation.defaultProbeFor, 'function');
  assert.throws(() => rotation.defaultProbeFor('unknown-provider', {}), { code: 'ACCOUNT_PROVIDER_UNSUPPORTED' });
});

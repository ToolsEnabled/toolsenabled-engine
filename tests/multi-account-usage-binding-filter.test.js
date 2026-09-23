'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAccountUsage, accountUsageBinding, claudeProbeFactory,
  ACCOUNT_USAGE_BINDING_FILTER_VERSION } = require('../src/lib/multi-account/rotation');
const { probeLifecycleOf, withProbeLifecycle } = require('../src/lib/multi-account/probe-lifecycle');

const reading = () => ({ status: 'healthy', canServe: true, usedPercent: null,
  usageStatus: 'unavailable', windows: { hourly: null, weekly: null, weeklyWindows: [] } });
async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-binding-filter-'));
  const registryPath = path.join(root, 'accounts.json');
  const accounts = [
    { name: 'c-one', provider: 'claude', configDir: 'one', priority: 1 },
    { name: 'c-two', provider: 'claude', configDir: 'two', priority: 2 },
    { name: 'g-one', provider: 'grok', configDir: 'grok', priority: 1 }
  ];
  fs.writeFileSync(registryPath, JSON.stringify({ accounts }));
  const binding = account => accountUsageBinding({ ...account, directory: path.join(root, account.configDir) });
  try { await run({ root, registryPath, accounts, binding }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('the versioned binding hook checks only the exact selected account and never ranks the subset', async () => {
  assert.equal(ACCOUNT_USAGE_BINDING_FILTER_VERSION, 1);
  await fixture(async ({ root, registryPath, accounts, binding }) => {
    const calls = [];
    const probeFor = () => async account => { calls.push(account.name); return reading(); };
    const subset = await readAccountUsage({ homeDir: root, registryPath, probeFor,
      accountBindings: [binding(accounts[1])] });
    assert.equal(subset.ok, true);
    assert.deepEqual(calls, ['c-two']);
    assert.deepEqual(subset.accounts.map(account => account.name), ['c-two']);
    assert.deepEqual(subset.orders, []);
    calls.length = 0;
    const full = await readAccountUsage({ homeDir: root, registryPath, probeFor });
    assert.equal(full.accounts.length, 3);
    assert.deepEqual(calls.sort(), ['c-one', 'c-two', 'g-one']);
    assert.deepEqual(full.orders.map(order => order.provider), ['claude', 'grok']);
  });
});

test('invalid binding filters fail before registry reads or provider calls', async () => {
  const valid = 'a'.repeat(64);
  for (const accountBindings of ['all', [valid, valid], ['A'.repeat(64)], ['not-a-binding'],
    Array.from({ length: 257 }, (_, index) => index.toString(16).padStart(64, '0'))]) {
    let accessed = false;
    const result = await readAccountUsage({ accountBindings,
      fsImpl: { readFileSync() { accessed = true; throw new Error('unexpected read'); } },
      probeFor() { accessed = true; throw new Error('unexpected probe'); } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ACCOUNT_USAGE_BINDINGS_INVALID');
    assert.equal(accessed, false);
    assert.deepEqual(result.accounts, []);
  }
});

test('a stale binding cannot follow a reused label to a different provider home', async () => {
  await fixture(async ({ root, registryPath, accounts, binding }) => {
    const oldBinding = binding(accounts[0]);
    accounts[0].configDir = 'replacement-home';
    fs.writeFileSync(registryPath, JSON.stringify({ accounts }));
    let calls = 0;
    const result = await readAccountUsage({ homeDir: root, registryPath, accountBindings: [oldBinding],
      probeFor: () => async () => { calls += 1; return reading(); } });
    assert.equal(result.ok, true);
    assert.equal(calls, 0);
    assert.deepEqual(result.accounts, []);
    assert.deepEqual(result.orders, []);
  });
});

test('lifecycle receipts survive internal row projection but cannot be restored from JSON or enumerable fields', async () => {
  await fixture(async ({ root, registryPath, accounts, binding }) => {
    for (const source of [withProbeLifecycle(reading(), 'closed'), { ...reading(), probeLifecycle: 'closed' }, reading()]) {
      const result = await readAccountUsage({ homeDir: root, registryPath, accountBindings: [binding(accounts[0])],
        probeFor: () => async () => source });
      const row = result.accounts[0];
      assert.equal(probeLifecycleOf(row), probeLifecycleOf(source));
      assert.equal(probeLifecycleOf(JSON.parse(JSON.stringify(row))), null);
      assert.equal(Object.keys(row).includes('probeLifecycle'), false);
    }
  });
  const retryCleanup = async () => {};
  const source = Object.defineProperty(reading(), 'retryCleanup', { value: retryCleanup });
  assert.equal(withProbeLifecycle(source, 'unproven').retryCleanup, retryCleanup);
  assert.throws(() => withProbeLifecycle(reading(), 'assumed-closed'), TypeError);
});

test('Claude requires positive closure from both its auth and usage process', async () => {
  const root = path.parse(process.cwd()).root;
  const account = { name: 'fixture', provider: 'claude', configDir: path.join(root, 'fixture-claude'), priority: 1 };
  const auth = { state: 'indeterminate', capabilityRan: false, billingSource: 'subscription', account: null };
  const usage = { status: 'UNKNOWN', reason: 'CLAUDE_USAGE_FETCH_UNAVAILABLE' };
  const cases = [
    [withProbeLifecycle(auth, 'closed'), withProbeLifecycle(usage, 'closed'), 'closed'],
    [auth, withProbeLifecycle(usage, 'closed'), null],
    [withProbeLifecycle(auth, 'closed'), usage, null],
    [withProbeLifecycle(auth, 'closed'), withProbeLifecycle(usage, 'not-started'), null],
    [{ ...auth, probeLifecycle: 'closed' }, { ...usage, probeLifecycle: 'closed' }, null]
  ];
  for (const [observed, live, expected] of cases) {
    const check = claudeProbeFactory({ homeDir: root, exhaustedAtPercent: 99,
      authProbe: async () => observed, usageProbe: async () => live });
    const result = await check(account);
    assert.equal(probeLifecycleOf(result), expected);
    assert.equal(result.canServe, true, 'unknown allowance does not invalidate sign-in');
  }
});

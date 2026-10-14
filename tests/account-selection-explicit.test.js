'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const rotation = require('../src/lib/multi-account/rotation');
const switcher = require('../src/lib/multi-account/switcher');
const { accountRegistryPath } = require('../src/lib/multi-account/registry-location');
const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT;
before(() => { process.env.TOOLSENABLED_STATE_ROOT = path.join(os.tmpdir(), 'te-explicit-state-' + randomUUID()); });
after(() => {
  if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
  else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot;
});

function machine(provider = 'codex', pin = null) {
  const root = path.join(os.tmpdir(), 'te-explicit-' + randomUUID());
  const field = provider === 'codex' ? 'profileDir' : 'configDir';
  const registry = { selectionMode: 'priority', accounts: [
    { name: 'chosen', provider, [field]: 'chosen-home', priority: 1 },
    { name: 'other', provider, [field]: 'other-home', priority: 2 }
  ] };
  const statePath = path.join(root, 'state.json');
  const files = new Map([[accountRegistryPath(), JSON.stringify(registry)],
    [statePath, JSON.stringify({ activeAccount: 'other', activeByProvider: { [provider]: 'other' },
      manualPinByProvider: pin ? { [provider]: pin } : {}, history: [] })]]);
  const fsImpl = { readFileSync(file) {
    if (files.has(file)) return files.get(file);
    throw Object.assign(new Error('missing synthetic metadata'), { code: 'ENOENT' });
  }, mkdirSync() {}, writeFileSync(file, text) { files.set(file, text); } };
  return { registry, files, args: { provider, servicesRoot: root, homeDir: root, statePath, fsImpl } };
}
function reading(account, status = 'healthy') {
  return { account: account.name, status, canServe: status === 'healthy', usedPercent: status === 'exhausted' ? 100 : 1,
    reason: status === 'exhausted' ? 'The provider usage limit was reached.' : 'The selected account can serve.' };
}

test('an exhausted explicit account never probes or selects its healthy sibling', async () => {
  for (const provider of ['codex', 'claude']) {
    const fixture = machine(provider);
    const seen = [];
    const answer = await rotation.resolveAccountForSession({ ...fixture.args, preferred: 'chosen',
      selectionMode: 'priority', mode: 'auto',
      probe: async account => { seen.push(account.name); return reading(account, account.name === 'chosen' ? 'exhausted' : 'healthy'); } });
    assert.equal(answer.blocked, true);
    assert.equal(answer.account, null);
    assert.equal(answer.switched, false);
    assert.deepEqual(seen, ['chosen']);
    const state = JSON.parse(fixture.files.get(fixture.args.statePath));
    assert.equal(state.activeAccount, 'other');
    assert.equal(state.history.some(entry => entry.outcome === 'selected'), false);
  }
});

test('a healthy explicitly selected account carries only its own native home', async () => {
  const fixture = machine();
  const seen = [];
  const answer = await rotation.resolveAccountForSession({ ...fixture.args, preferred: 'chosen',
    probe: async account => { seen.push(account.name); return reading(account); } });
  assert.equal(answer.blocked, false);
  assert.equal(answer.account.name, 'chosen');
  assert.equal(answer.env.CODEX_HOME, path.join(fixture.args.homeDir, 'chosen-home'));
  assert.equal(answer.switched, false);
  assert.deepEqual(seen, ['chosen']);
});

test('a stored manual choice survives exhaustion and is never replaced', async () => {
  const fixture = machine('codex', 'chosen');
  const seen = [];
  const answer = await rotation.resolveAccountForSession({ ...fixture.args,
    probe: async account => { seen.push(account.name); return reading(account, 'exhausted'); } });
  assert.equal(answer.blocked, true);
  assert.deepEqual(seen, ['chosen']);
  assert.equal(JSON.parse(fixture.files.get(fixture.args.statePath)).manualPinByProvider.codex, 'chosen');
});

test('a previous automatic selection and usage ranking do not choose an account', async () => {
  const fixture = machine();
  let probes = 0;
  const answer = await rotation.resolveAccountForSession({ ...fixture.args,
    selectionMode: 'most-remaining', keepTryingAccounts: true,
    probe: async account => { probes++; return reading(account); } });
  assert.equal(answer.account, null);
  assert.equal(answer.env, null);
  assert.equal(probes, 0);
});



test('unknown explicit selection refuses before any sibling probe', async () => {
  const fixture = machine();
  let probes = 0;
  const answer = await rotation.resolveAccountForSession({ ...fixture.args, preferred: 'missing',
    probe: async account => { probes++; return reading(account); } });
  assert.equal(answer.blocked, true);
  assert.equal(answer.account, null);
  assert.equal(probes, 0);
});

test('direct switcher callers cannot walk another account after any refusal', async () => {
  const { registry } = machine();
  for (const status of ['exhausted', 'signed_out', 'unprovisioned', 'transient', 'account_mismatch']) {
    const seen = [];
    const result = await switcher.selectAccount({ registry, preferred: 'chosen',
      probe: async account => { seen.push(account.name); return reading(account, account.name === 'chosen' ? status : 'healthy'); } });
    assert.equal(result.ok, false);
    assert.equal(result.account, null);
    assert.deepEqual(seen, ['chosen']);
  }
});

test('direct switcher requires an explicit account and permits an explicit healthy choice', async () => {
  const { registry } = machine();
  let probes = 0;
  const probe = async account => { probes++; return reading(account); };
  const refused = await switcher.selectAccount({ registry, probe });
  assert.equal(refused.ok, false);
  assert.equal(probes, 0);
  const selected = await switcher.selectAccount({ registry, preferred: 'other', probe });
  assert.equal(selected.ok, true);
  assert.equal(selected.account.name, 'other');
  assert.equal(probes, 1);
});



test('invalid selectors and provider clients refuse before probing', async () => {
  for (const [patch, code] of [
    [{ preferred: '' }, 'ACCOUNT_SELECTION_INVALID'],
    [{ preferred: {} }, 'ACCOUNT_SELECTION_INVALID'],
    [{ preferred: 'x'.repeat(121) }, 'ACCOUNT_SELECTION_INVALID'],
    [{ client: 'antigravity' }, 'ACCOUNT_CLIENT_INVALID'],
  ]) {
    const fixture = machine();
    let probes = 0;
    const answer = await rotation.resolveAccountForSession({ ...fixture.args, preferred: 'chosen', ...patch,
      probe: async account => { probes++; return reading(account); } });
    assert.equal(answer.blocked, true);
    assert.equal(answer.code, code);
    assert.equal(probes, 0);
  }
});
test('a chosen account without a registry location refuses instead of using ambient sign-in', async () => {
  const fixture = machine();
  let probes = 0;
  const answer = await rotation.resolveAccountForSession({ ...fixture.args, servicesRoot: undefined,
    preferred: 'chosen', probe: async account => { probes++; return reading(account); } });
  assert.equal(answer.blocked, true);
  assert.equal(answer.env, null);
  assert.equal(probes, 0);
});

test('renderer retry requests cannot select an alternate even with empty exclusions', async () => {
  for (const provider of ['codex', 'claude']) {
    for (const preferred of [null, 'other']) {
      const fixture = machine(provider, 'chosen');
      let probes = 0;
      const answer = await rotation.resolveAccountForSession({ ...fixture.args, preferred,
        excludeAccounts: [], keepTryingAccounts: true,
        probe: async account => { probes++; return reading(account); } });
      assert.equal(answer.code, 'ACCOUNT_AUTOMATIC_SWITCHING_DISABLED');
      assert.equal(answer.blocked, true);
      assert.equal(answer.account, null);
      assert.equal(probes, 0);
      assert.equal(JSON.parse(fixture.files.get(fixture.args.statePath)).manualPinByProvider[provider], 'chosen');
    }
  }
});

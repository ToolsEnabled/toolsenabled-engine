'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const rotation = require('../src/lib/multi-account/rotation');
const switcher = require('../src/lib/multi-account/switcher');
const { classifyClaudeAuth } = require('../src/lib/providers/claude-auth-probe');
const { accountRegistryPath } = require('../src/lib/multi-account/registry-location');
const { loadRegistry } = require('../src/lib/multi-account/registry');
const previous = process.env.TOOLSENABLED_STATE_ROOT;
before(() => { process.env.TOOLSENABLED_STATE_ROOT = path.join(os.tmpdir(), 'choice-test-' + randomUUID()); });
after(() => { if (previous === undefined) delete process.env.TOOLSENABLED_STATE_ROOT; else process.env.TOOLSENABLED_STATE_ROOT = previous; });

function fixture(provider = 'codex') {
  const root = path.join(os.tmpdir(), 'choice-fixture-' + randomUUID());
  const statePath = path.join(root, 'multi-account-state.json');
  const field = provider === 'codex' ? 'profileDir' : 'configDir';
  const registry = { accounts: ['chosen', 'other'].map(name => ({ name, provider, [field]: name + '-home' })) };
  const files = new Map([[accountRegistryPath(), JSON.stringify(registry)], [statePath, JSON.stringify({
    activeAccount: 'other', activeByProvider: { [provider]: 'other' }, manualPinByProvider: { [provider]: 'chosen' }, history: [],
  })]]);
  const directories = new Set([root]);
  let writes = 0;
  const fsImpl = {
    readFileSync(file) { if (files.has(file)) return files.get(file); throw Object.assign(new Error('synthetic absence'), { code: 'ENOENT' }); },
    mkdirSync() {}, writeFileSync(file, text) { writes++; files.set(file, text); },
    mkdtempSync(prefix) { const directory = prefix + randomUUID(); directories.add(directory); return directory; },
    renameSync(from, to) { const bytes = fsImpl.readFileSync(from); files.set(to, bytes); files.delete(from); },
    readdirSync(directory) { return [...directories].filter(value => path.dirname(value) === directory).map(value => path.basename(value)); },
    rmdirSync(directory) { directories.delete(directory); },
  };
  const probe = async account => ({ account: account.name, status: 'healthy', canServe: true, reason: 'Ready.' });
  return { files, registry, fsImpl, probe, writes: () => writes, args: { provider, servicesRoot: root, homeDir: root, statePath, fsImpl } };
}

test('A2: quarantine refuses repeated Starts until an explicit choice, preserving damaged bytes', async () => {
  const f = fixture();
  const damaged = '{ damaged selection metadata';
  f.files.set(f.args.statePath, damaged);
  let probes = 0;
  const probe = async account => { probes++; return f.probe(account); };
  for (let start = 0; start < 3; start++) {
    const result = await rotation.resolveAccountForSession({ ...f.args, probe });
    assert.equal(result.code, 'ACCOUNT_STATE_UNREADABLE');
    assert.equal(result.blocked, true);
    assert.equal(result.account, null);
    assert.match(result.reason, /choose an account/i);
  }
  assert.equal(probes, 0);
  const direct = await switcher.resolveForLaunch({ ...f.args, registry: f.registry, preferred: 'chosen', probe });
  assert.equal(direct.code, 'ACCOUNT_STATE_UNREADABLE');
  assert.equal(probes, 0);
  assert.equal([...f.files.values()].filter(value => value === damaged).length, 1);
  assert.equal((await switcher.switchTo({ ...f.args, registry: f.registry, selector: 'chosen', probe: f.probe })).ok, true);
  assert.equal((await rotation.resolveAccountForSession({ ...f.args, probe })).account.name, 'chosen');
  assert.equal((await rotation.resolveAccountForSession({ ...f.args, provider: 'claude', probe })).code, 'ACCOUNT_STATE_UNREADABLE');
});

test('A2: an interrupted quarantine cannot make missing selection mean default', async () => {
  const f = fixture();
  f.files.set(f.args.statePath, '{ damaged selection metadata');
  const write = f.fsImpl.writeFileSync;
  f.fsImpl.writeFileSync = () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }); };
  await rotation.resolveAccountForSession({ ...f.args, probe: f.probe });
  f.fsImpl.writeFileSync = write;
  const result = await rotation.resolveAccountForSession({ ...f.args, probe: f.probe });
  assert.equal(result.code, 'ACCOUNT_STATE_UNREADABLE');
  assert.equal(result.blocked, true);
});

test('A2: structurally unreadable choice metadata never authorizes a default sign-in', async () => {
  for (const state of [{ manualPinByProvider: { codex: 42 } }, { manualPinByProvider: 'chosen' },
    { activeByProvider: [] }, { selectionRevision: 42 }, { history: 'lost choices' }]) {
    const f = fixture();
    f.files.set(f.args.statePath, JSON.stringify(state));
    const result = await rotation.resolveAccountForSession({ ...f.args, probe: f.probe });
    assert.equal(result.code, 'ACCOUNT_STATE_UNREADABLE');
    assert.equal(result.blocked, true);
    assert.equal((await rotation.resolveAccountForSession({ ...f.args, probe: f.probe })).code, 'ACCOUNT_STATE_UNREADABLE');
  }
});

test('A3: a pin-only manual choice during a held Start refuses the stale commit', async () => {
  const f = fixture();
  let entered, release;
  const held = new Promise(resolve => { release = resolve; });
  const observed = new Promise(resolve => { entered = resolve; });
  const pending = rotation.resolveAccountForSession({ ...f.args, probe: async account => { entered(); await held; return f.probe(account); } });
  await observed;
  await switcher.switchTo({ ...f.args, registry: f.registry, selector: 'other', probe: f.probe });
  const newer = f.files.get(f.args.statePath);
  release();
  const result = await pending;
  assert.equal(result.code, 'ACCOUNT_LAUNCH_COMMIT_CONFLICT');
  assert.equal(result.blocked, true);
  assert.equal(f.files.get(f.args.statePath), newer);
  assert.equal((await rotation.resolveAccountForSession({ ...f.args, probe: f.probe })).account.name, 'other');
});

test('A3: choosing away and back still invalidates an older admission', async () => {
  const f = fixture();
  const selection = await switcher.resolveForLaunch({ ...f.args, registry: f.registry, preferred: 'chosen', probe: f.probe, persistSelection: false });
  await switcher.switchTo({ ...f.args, registry: f.registry, selector: 'other', probe: f.probe });
  await switcher.switchTo({ ...f.args, registry: f.registry, selector: 'chosen', probe: f.probe });
  // Keep active account equal to the launch's original observation: only the revision can detect this race.
  const state = JSON.parse(f.files.get(f.args.statePath));
  f.files.set(f.args.statePath, JSON.stringify({ ...state, activeAccount: 'other', activeByProvider: { codex: 'other' } }));
  const newer = f.files.get(f.args.statePath);
  assert.throws(() => switcher.commitLaunchSelection({ selection, statePath: f.args.statePath, fsImpl: f.fsImpl }), { code: 'ACCOUNT_LAUNCH_COMMIT_CONFLICT' });
  assert.equal(f.files.get(f.args.statePath), newer);
});

test('A3: a deferred admission without its observed choice refuses without a write', async () => {
  const f = fixture();
  const selected = await switcher.resolveForLaunch({ ...f.args, registry: f.registry, preferred: 'chosen', probe: f.probe, persistSelection: false });
  const { choiceSnapshot, ...unverified } = selected;
  const beforeCommit = f.files.get(f.args.statePath);
  assert.throws(() => switcher.commitLaunchSelection({ selection: unverified, statePath: f.args.statePath, fsImpl: f.fsImpl }),
    { code: 'ACCOUNT_LAUNCH_SELECTION_INVALID' });
  assert.equal(f.files.get(f.args.statePath), beforeCommit);
});

const signedIn = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'sample' };
const nativeModes = [
  [{ ...signedIn, apiKeySource: 'ANTHROPIC_API_KEY' }, 'api_key', /API key settings/],
  [{ ...signedIn, authMethod: 'api_key', apiKeySource: 'apiKeyHelper' }, 'key_helper', /key helper settings/],
  [{ ...signedIn, authMethod: 'vertex', apiProvider: 'vertex' }, 'cloud', /cloud provider settings/],
  [{ ...signedIn, authMethod: 'bedrock', apiProvider: 'bedrock' }, 'cloud', /cloud provider settings/],
  [{ ...signedIn, authMethod: 'api_key' }, 'api_key', /API key settings/],
];
function claudeProbe(f, status, statusExit = 0) {
  return rotation.claudeProbeFactory({ homeDir: f.args.homeDir, fsImpl: f.fsImpl, ...rotation.PROVIDER_CEILING_THRESHOLDS,
    authProbe: async () => classifyClaudeAuth({ statusExit, statusStdout: JSON.stringify(status), capabilityRan: false }),
    usageProbe: async () => ({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_RATE_LIMITS_UNAVAILABLE' }),
  });
}

test('A5: successful native API, cloud and helper status can select only the chosen home', async () => {
  for (const [status, billingSource, remedy] of nativeModes) {
    const f = fixture('claude');
    assert.equal(classifyClaudeAuth({ statusExit: 0, statusStdout: JSON.stringify(status) }).billingSource, billingSource);
    const reading = await claudeProbe(f, status)(f.registry.accounts[0]);
    assert.match(reading.reason, remedy);
    const result = await rotation.resolveAccountForSession({ ...f.args, probe: claudeProbe(f, status) });
    assert.equal(result.blocked, false);
    assert.equal(result.account.name, 'chosen');
    assert.equal(result.env.CLAUDE_CONFIG_DIR, path.join(f.args.homeDir, 'chosen-home'));
    assert.doesNotMatch(result.reason, /exhausted|skipped|out of allowance/i);
  }
});

test('A5: native API, cloud and helper authentication cannot be exhausted by a subscription allowance', async () => {
  for (const [status] of nativeModes) {
    const f = fixture('claude');
    const probe = rotation.claudeProbeFactory({ homeDir: f.args.homeDir, fsImpl: f.fsImpl, ...rotation.PROVIDER_CEILING_THRESHOLDS,
      authProbe: async () => classifyClaudeAuth({ statusExit: 0, statusStdout: JSON.stringify(status) }),
      usageProbe: async () => ({ status: 'MEASURED', limits: [{ kind: 'five_hour', percent: 100 }, { kind: 'seven_day', percent: 100 }] }),
    });
    const result = await rotation.resolveAccountForSession({ ...f.args, probe });
    assert.equal(result.blocked, false);
    assert.equal(result.account.name, 'chosen');
  }
});

test('A6: failed signed-in Claude status remains unknown through factory and selection', async () => {
  for (const statusExit of [null, 1, 2]) {
    const f = fixture('claude');
    const probe = claudeProbe(f, signedIn, statusExit);
    const reading = await probe(f.registry.accounts[0]);
    assert.equal(reading.status, 'transient');
    assert.equal(reading.canServe, false);
    const result = await rotation.resolveAccountForSession({ ...f.args, probe });
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'ACCOUNT_STATUS_UNKNOWN');
    assert.equal(result.account, null);
  }
});

test('A7: each measured refusal retains its specific safe code and remedy', async () => {
  for (const [status, code, remedy] of [
    ['signed_out', 'ACCOUNT_SIGNED_OUT', /sign in/i], ['not_provisioned', 'ACCOUNT_NOT_PROVISIONED', /sign in/i],
    ['exhausted', 'ACCOUNT_EXHAUSTED', /allowance.*reset/i],
    ['account_mismatch', 'ACCOUNT_MISMATCH', /different.*account|expected account/i],
    ['transient', 'ACCOUNT_STATUS_UNKNOWN', /could not be checked/i],
  ]) {
    const f = fixture();
    const probe = async account => ({ account: account.name, status, canServe: false, reason: 'Confidential provider diagnostics must stay private.' });
    const result = await rotation.resolveAccountForSession({ ...f.args, probe });
    assert.equal(result.code, code);
    assert.equal(result.blocked, true);
    assert.match(result.reason, remedy);
    assert.doesNotMatch(result.reason, /Confidential/);
  }
});

test('A7: contradictory healthy but unable-to-serve reading stays unknown', async () => {
  const f = fixture();
  const result = await rotation.resolveAccountForSession({ ...f.args,
    probe: async account => ({ account: account.name, status: 'healthy', canServe: false, reason: 'Confidential diagnostics.' }) });
  assert.equal(result.code, 'ACCOUNT_STATUS_UNKNOWN');
  assert.equal(result.blocked, true);
  assert.equal(result.account, null);
});

test('A4: contradictory or oversized historical labels refuse without a probe', async () => {
  for (const previousNames of [['other'], Array.from({ length: 65 }, (_, index) => 'old-' + index), ['x'.repeat(121)], [null], 'old']) {
    const f = fixture();
    f.registry.accounts[0].previousNames = previousNames;
    f.files.set(accountRegistryPath(), JSON.stringify(f.registry));
    assert.throws(() => loadRegistry({ configPath: accountRegistryPath(), fsImpl: f.fsImpl }),
      { code: Array.isArray(previousNames) && previousNames[0] === 'other' ? 'ACCOUNTS_ALIAS_CONFLICT' : 'ACCOUNTS_ALIASES_INVALID' });
    let probes = 0;
    const result = await rotation.resolveAccountForSession({ ...f.args, probe: async account => { probes++; return f.probe(account); } });
    assert.equal(result.blocked, true);
    assert.equal(result.account, null);
    assert.equal(probes, 0);
  }
});

test('A8: every retired retry field refuses before any reads, probes or writes', async () => {
  for (const patch of [{ excludeAccounts: [] }, { excludeAccounts: null }, { keepTryingAccounts: false }, { keepTryingAccounts: undefined }]) {
    const f = fixture();
    let reads = 0, probes = 0;
    const originalRead = f.fsImpl.readFileSync;
    f.fsImpl.readFileSync = file => { reads++; return originalRead(file); };
    const result = await rotation.resolveAccountForSession({ ...f.args, ...patch, probe: async account => { probes++; return f.probe(account); } });
    assert.equal(result.code, 'ACCOUNT_AUTOMATIC_SWITCHING_DISABLED');
    assert.equal(result.blocked, true);
    assert.match(result.reason, /automatic account switching was removed/i);
    assert.equal(reads, 0); assert.equal(probes, 0); assert.equal(f.writes(), 0);
    const direct = await switcher.selectAccount({ registry: f.registry, preferred: 'chosen', ...patch,
      probe: async account => { probes++; return f.probe(account); } });
    assert.equal(direct.code, 'ACCOUNT_AUTOMATIC_SWITCHING_DISABLED');
    const launch = await switcher.resolveForLaunch({ ...f.args, registry: f.registry, preferred: 'chosen', ...patch,
      probe: async account => { probes++; return f.probe(account); } });
    assert.equal(launch.code, 'ACCOUNT_AUTOMATIC_SWITCHING_DISABLED');
    assert.equal(reads, 0); assert.equal(probes, 0); assert.equal(f.writes(), 0);
  }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { listEnvironmentsForAccount, discoverCloudEnvironments, normalizeEnvironment } = require('../src/lib/cloud-agent/codex-cloud-environments');
const { projectNativeCloudRoute } = require('../src/lib/cloud-agent/native-cloud-route');
const { classifyClaudeAuth } = require('../src/lib/providers/claude-auth-probe');

const account = { name: 'chosen', provider: 'codex', profileDir: 'chosen-home' };
const environmentId = '0123456789abcdef0123456789abcdef';
function excludes(value, secret) {
  assert.equal(JSON.stringify(value).includes(secret), false, 'confidential input reached returned data');
}

test('cloud discovery never reads sign-in or calls an HTTP backend', async () => {
  let reads = 0, requests = 0;
  const result = await listEnvironmentsForAccount(account, {
    fsImpl: { readFileSync() { reads++; throw new Error('sign-in must stay vendor-owned'); } },
    fetchImpl: async () => { requests++; throw new Error('no private backend request'); }
  });
  assert.equal(reads, 0);
  assert.equal(requests, 0);
  assert.equal(result.reading, 'unknown');
  assert.deepEqual(result.environments, []);
  assert.equal(result.nativeRoute.credentialCustody, 'vendor-cli');
  assert.deepEqual(result.nativeRoute.picker.argv, ['cloud']);
});

test('manual ID returns a CLI-owned plan while keeping catalog and binding unknown', async () => {
  const result = await listEnvironmentsForAccount(account, {
    nativeSelection: { account: 'chosen', provider: 'codex', environmentId, repository: 'owner/repository', branch: 'release' }
  });
  assert.equal(result.reading, 'unknown');
  assert.deepEqual(result.environments, []);
  assert.equal(result.nativeRoute.manualSelection.source, 'owner-declared');
  assert.equal(result.nativeRoute.manualSelection.requiresProviderBinding, false);
  assert.equal(result.nativeRoute.manualSelection.providerConfirmed, false);
  assert.equal(result.nativeRoute.manualSelection.environmentSource, 'person-entered');
  assert.deepEqual(result.nativeRoute.manualSelection.argv,
    ['cloud', 'exec', '--env', environmentId, '--branch', 'release']);
});

test('manual selection must belong to this provider/account and carry a valid ID and branch', async () => {
  const valid = { account: 'chosen', provider: 'codex', environmentId, repository: 'owner/repository', branch: 'release' };
  for (const selection of [{ ...valid, account: 'other' }, { ...valid, provider: 'claude' },
    { ...valid, environmentId: 'display-label' }, { ...valid, branch: '../foreign' },
    { ...valid, repository: 'not-a-repository' }]) {
    const result = await listEnvironmentsForAccount(account, { nativeSelection: selection });
    assert.equal(result.availability, 'refused');
    assert.equal(result.nativeRoute, null);
  }
});

test('accessor inputs refuse without executing accessors', async () => {
  let getters = 0;
  const input = { ...account };
  Object.defineProperty(input, 'name', { enumerable: true, get() { getters++; return 'chosen'; } });
  const result = await listEnvironmentsForAccount(input);
  assert.equal(result.availability, 'refused');
  assert.equal(getters, 0);
});

test('invalid native account and selection shapes refuse with no credential access', async () => {
  for (const input of [null, [], Object.assign(new Date(), account), { ...account, provider: 'claude' },
    { ...account, name: '' }, { ...account, name: 'chosen\nother' }]) {
    const result = await listEnvironmentsForAccount(input);
    assert.equal(result.availability, 'refused');
    assert.equal(result.nativeRoute, null);
  }
  for (const selection of [[], Object.assign(new Date(), { account: 'chosen', provider: 'codex', environmentId })]) {
    const result = await listEnvironmentsForAccount(account, { nativeSelection: selection });
    assert.equal(result.availability, 'refused');
  }
  let getters = 0;
  const selection = { account: 'chosen', provider: 'codex' };
  Object.defineProperty(selection, 'environmentId', { get() { getters++; return environmentId; } });
  const result = await listEnvironmentsForAccount(account, { nativeSelection: selection });
  assert.equal(result.availability, 'refused');
  assert.equal(getters, 0);
});

test('native route survives discovery and unknown does not become an empty catalog', async () => {
  const result = await discoverCloudEnvironments({ accounts: [account] });
  assert.equal(result.complete, false);
  assert.deepEqual(result.environments, []);
  assert.equal(result.accounts[0].availability, 'native-picker-or-explicit-id');
  assert.equal(result.accounts[0].nativeRoute.account, 'chosen');
});

test('native route projection drops unknown properties and rejects changed ownership', async () => {
  const secret = randomBytes(24).toString('base64url');
  const reading = await listEnvironmentsForAccount(account);
  const owner = { account: account.name, provider: account.provider };
  const projected = projectNativeCloudRoute({ ...reading.nativeRoute, [secret]: secret }, owner);
  excludes(projected, secret);
  assert.equal(projected.nativeRoute.account, 'chosen');
  const refused = projectNativeCloudRoute({ ...reading.nativeRoute, account: 'other' }, owner);
  assert.equal(refused.nativeRoute, null);
  assert.equal(refused.availability, 'refused');
});

test('native route metadata cannot invent custody, a picker, or manual selection authority', async () => {
  const result = await listEnvironmentsForAccount(account, { nativeSelection: {
    account: 'chosen', provider: 'codex', environmentId, repository: 'owner/repository', branch: 'release'
  } });
  const route = result.nativeRoute;
  const manual = route.manualSelection;
  const owner = { account: 'chosen', provider: 'codex' };
  const invalid = [[], Object.assign(new Date(), route), { ...route, auth: 'external-token' },
    { ...route, credentialCustody: 'application' }, { ...route, signIn: 'authorized' },
    { ...route, catalog: 'complete' }, { ...route, picker: { argv: ['cloud', 'exec'], interactive: true } },
    { ...route, picker: { argv: ['cloud'], interactive: false } },
    { ...route, manualSelection: [] },
    { ...route, manualSelection: Object.assign(new Date(), manual) },
    { ...route, manualSelection: { ...manual, account: 'other' } },
    { ...route, manualSelection: { ...manual, source: 'provider-confirmed' } },
    { ...route, manualSelection: { ...manual, requiresProviderBinding: true } },
    { ...route, manualSelection: { ...manual, environmentSource: 'automatic' } },
    { ...route, manualSelection: { ...manual, providerConfirmed: true } },
    { ...route, manualSelection: { ...manual, environmentId: 'display-label' } },
    { ...route, manualSelection: { ...manual, declaredRepository: 'invalid' } },
    { ...route, manualSelection: { ...manual, branch: '../foreign' } }
  ];
  for (const value of invalid) {
    const refused = projectNativeCloudRoute(value, owner);
    assert.equal(refused.nativeRoute, null);
    assert.equal(refused.availability, 'refused');
  }
});

test('metadata projection redacts before bounding and repository ambiguity remains a refusal', () => {
  const secret = randomBytes(24).toString('base64url');
  const normalized = normalizeEnvironment({ id: environmentId, label: secret,
    repo_map: { one: { repository_full_name: 'owner/repository', default_branch: secret, visibility: secret } }
  }, { secret });
  excludes(normalized, secret);
  assert.equal(normalized.repository, 'owner/repository');
  assert.equal(normalized.defaultBranch, null);
  assert.equal(normalized.launchable, true);
  const ambiguous = normalizeEnvironment({ id: environmentId, repo_map: {
    one: { repository_full_name: 'owner/one' }, two: { repository_full_name: 'owner/two' }
  } });
  assert.equal(ambiguous.repository, null);
  assert.equal(ambiguous.launchable, false);
});

test('reader diagnostics cannot enter discovery output', async () => {
  const secret = randomBytes(24).toString('base64url');
  const result = await discoverCloudEnvironments({ accounts: [account] }, {
    readAccountEnvironments: async () => { throw Object.assign(new Error(secret), { code: secret }); }
  });
  excludes(result, secret);
  assert.equal(result.complete, false);
  assert.equal(result.accounts[0].reading, 'unknown');
});

test('Claude diagnostics remain indeterminate and never echo untrusted error text', () => {
  const secret = randomBytes(24).toString('base64url');
  const status = classifyClaudeAuth({ statusTransportError: secret });
  excludes(status, secret);
  assert.equal(status.state, 'indeterminate');
  assert.equal(status.canFailover, false);
  const capability = classifyClaudeAuth({ statusExit: 0,
    statusStdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
    capabilityRan: true, capabilityTransportError: secret });
  excludes(capability, secret);
  assert.equal(capability.state, 'indeterminate');
  assert.equal(capability.usable, false);
});

test('cloud binding refusals and account discovery failures contain private diagnostics', async () => {
  const launcher = require('../src/lib/cloud-agent/codex-cloud-launch');
  const secret = randomBytes(24).toString('base64url');
  const registry = { exhaustedAtPercent: 100, accounts: [account] };
  for (const discoverEnvironmentsImpl of [
    async () => { throw Object.assign(new Error(secret), { code: secret }); },
    async () => ({ environments: [], accounts: [{ account: 'chosen', reading: 'unknown', reason: secret }], complete: false }),
    async () => ({ environments: [{ environmentId, repository: null, reason: secret }], accounts: [], complete: true })
  ]) {
    let created = false;
    const error = await launcher.launchCloudTask({ environment: environmentId, branch: 'main',
      repository: 'owner/repository', prompt: 'Read this repository.', account: 'chosen' }, {
      loadRegistryImpl: () => registry, accountRegistryPathImpl: () => 'synthetic-registry', discoverEnvironmentsImpl,
      transportFactory: () => { created = true; throw new Error('must refuse before transport'); }
    }).then(() => null, value => value);
    assert.equal(error.code, 'CLOUD_LAUNCH_BINDING_UNVERIFIED');
    excludes({ message: error.message, ...error }, secret);
    assert.equal(created, false);
  }
  const result = await launcher.listCloudAccounts({}, {
    loadRegistryImpl: () => registry, accountRegistryPathImpl: () => 'synthetic-registry',
    statePath: 'synthetic-state', fsImpl: { readFileSync() { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } },
    probeImpl: async () => { throw Object.assign(new Error(secret), { code: secret }); },
    discoverEnvironmentsImpl: async () => { throw Object.assign(new Error(secret), { code: secret }); }
  });
  excludes(result, secret);
  assert.equal(result.accounts[0].status, 'unknown');
  assert.equal(result.accounts[0].canServe, false);
  assert.equal(result.environmentsComplete, false);
});

test('Cloud account selection cannot bind a same-named non-Codex account', async () => {
  const launcher = require('../src/lib/cloud-agent/codex-cloud-launch');
  const path = require('node:path');
  const os = require('node:os');
  const statePath = path.join(os.tmpdir(), 'synthetic-cloud-selection-' + require('node:crypto').randomUUID());
  const registry = { exhaustedAtPercent: 100, accounts: [
    { ...account, provider: 'claude', configDir: 'other-home' }, account
  ] };
  const seen = [], bound = [];
  const result = await launcher.listCloudTasks({ account: 'chosen' }, {
    statePath, loadRegistryImpl: () => registry, accountRegistryPathImpl: () => 'synthetic-registry',
    probeImpl: async selected => { seen.push(selected.provider); return { status: 'healthy', canServe: true }; },
    executableImpl: () => ({ command: 'synthetic-codex' }),
    environmentImpl: selected => { bound.push(selected.provider); return {}; },
    transportFactory: () => ({ listTasks: async () => ({ tasks: [] }) })
  });
  assert.equal(result.account.name, 'chosen');
  assert.deepEqual(seen, ['codex']);
  assert.deepEqual(bound, ['codex']);
});

test('native route projection refuses accessors without executing them', async () => {
  const result = await listEnvironmentsForAccount(account, { nativeSelection: {
    account: 'chosen', provider: 'codex', environmentId, repository: 'owner/repository', branch: 'main'
  } });
  for (const area of ['route', 'picker', 'manual', 'argv']) {
    let getters = 0;
    const route = { ...result.nativeRoute, picker: { ...result.nativeRoute.picker },
      manualSelection: { ...result.nativeRoute.manualSelection } };
    const object = area === 'route' ? route : area === 'picker' ? route.picker
      : area === 'manual' ? route.manualSelection : (route.picker.argv = Array(1));
    const property = area === 'route' ? 'auth' : area === 'picker' ? 'interactive' : area === 'manual' ? 'source' : '0';
    const value = area === 'route' ? 'native-cli' : area === 'picker' ? true : area === 'manual' ? 'owner-declared' : 'cloud';
    Object.defineProperty(object, property, { enumerable: true, get() { getters++; return value; } });
    const projected = projectNativeCloudRoute(route, { account: 'chosen', provider: 'codex' });
    assert.equal(projected.availability, 'refused');
    assert.equal(projected.nativeRoute, null);
    assert.equal(getters, 0);
  }
});

test('the batch dispatcher never echoes subprocess errors or provider diagnostics', async () => {
  const { createCodexDispatcher } = require('../src/lib/cloud-agent/codex-dispatcher');
  const secret = randomBytes(24).toString('base64url');
  for (const [outcome, expectedCode, answered] of [
    [{ error: Object.assign(new Error(secret), { code: secret }) }, 'CLOUD_DISPATCH_UNCERTAIN', false],
    [{ status: 1, stdout: '', stderr: 'quota exceeded ' + secret }, 'CLOUD_DISPATCH_REFUSED', true],
    [{ status: 1, stdout: secret, stderr: '' }, 'CLOUD_DISPATCH_UNCERTAIN', false],
  ]) {
    const dispatch = createCodexDispatcher({ codexBinary: 'synthetic-codex',
      accountHome: 'synthetic-home', environment: environmentId,
      scrubEnvironment: () => ({}), spawnImpl: async () => outcome });
    const error = await dispatch({ task: { contract: 'Read this repository.' }, index: 0, account: 'chosen' })
      .then(() => null, value => value);
    assert.equal(error.code, expectedCode);
    assert.equal(error.providerAnswered === true, answered);
    excludes({ message: error.message, ...error }, secret);
  }
});

test('Cloud harvest retains task data and confines native provider diagnostics', async t => {
  const { createCodexHarvestFetch } = require('../tools/cloud-lane');
  const childProcess = require('node:child_process');
  const secret = randomBytes(24).toString('base64url');
  const diff = 'diff --git a/example.js b/example.js\n+preserved task result\n';
  for (const [responses, state, throttled] of [
    [[{ error: new Error(secret), stdout: '', stderr: '' }], 'error', false],
    [[{ error: new Error(secret), stdout: secret, stderr: '' }], 'error', false],
    [[{ error: null, stdout: '[ERROR] ' + secret, stderr: '' }], 'errored', false],
    [[{ error: null, stdout: '[READY]', stderr: '' }, { error: new Error(secret), stdout: '', stderr: '429 Too Many Requests ' + secret }], 'error', true],
    [[{ error: null, stdout: '[READY]', stderr: '' }, { error: new Error(secret), stdout: secret, stderr: '' }], 'error', false],
    [[{ error: null, stdout: '[READY]', stderr: '' }, { error: null, stdout: diff, stderr: '' }], 'ready', false],
  ]) {
    const replies = [...responses];
    const calls = [];
    const mock = t.mock.method(childProcess, 'execFile', (command, argv, options, callback) => {
      calls.push({ command, argv, home: options.env.CODEX_HOME });
      const response = replies.shift();
      assert.ok(response, 'no unplanned native request');
      callback(response.error, response.stdout, response.stderr);
    });
    try {
      const fetch = createCodexHarvestFetch({ codexBinary: 'synthetic-codex', accountHomes: { chosen: 'synthetic-home' } });
      const result = await fetch({ taskId: 'task-native', account: 'chosen' })
        .then(value => ({ value }), error => ({ error: { code: error.code, message: error.message, ...error } }));
      excludes(result, secret);
      assert.equal(calls.length, responses.length);
      assert.equal(calls.every(call => call.home === 'synthetic-home'), true);
      if (state === 'error') {
        assert.equal(result.error.code, 'CLOUD_HARVEST_FETCH');
        assert.equal(/429 Too Many Requests/.test(result.error.message), throttled);
      } else {
        assert.equal(result.value.state, state);
        assert.equal(result.value.diff, state === 'ready' ? diff : '');
      }
    } finally { mock.mock.restore(); }
  }
  const { harvestBatch } = require('../src/lib/cloud-agent/batch-harvest');
  const error = await harvestBatch({ journalFile: 'synthetic-journal', outDir: 'synthetic-output',
    fetchTask: async () => ({}), fsImpl: { readFileSync() { throw Object.assign(new Error(secret), { code: secret }); } } })
    .then(() => null, value => value);
  assert.equal(error.code, 'CLOUD_HARVEST_NO_JOURNAL');
  excludes({ message: error.message, ...error }, secret);
});

function manualLaunchFixture(overrides = {}) {
  const launcher = require('../src/lib/cloud-agent/codex-cloud-launch');
  const seen = { spawns: [], mirror: [], queries: [], probes: [] };
  const files = new Map();
  const fsImpl = { readFileSync(file) {
    if (files.has(file)) return files.get(file);
    throw Object.assign(new Error('missing synthetic selection state'), { code: 'ENOENT' });
  }, mkdirSync() {}, writeFileSync(file, data) { files.set(file, data); } };
  return { seen, request: { environment: environmentId, environmentSource: 'person-entered',
    repository: 'owner/repository', branch: 'main', account: 'chosen', prompt: 'Read this repository.' },
    dependencies: { loadRegistryImpl: () => ({ accounts: [account] }), accountRegistryPathImpl: () => 'synthetic-registry',
      fsImpl, statePath: 'synthetic-state', codexConfigPath: 'synthetic-selection',
      probeImpl: async selected => { seen.probes.push(selected.name); return { status: 'healthy', canServe: true }; },
      executableImpl: () => ({ command: 'synthetic-official-codex' }),
      environmentImpl: () => ({ CODEX_HOME: 'synthetic-selected-home' }),
      checkMirrorFreshnessImpl: async input => { seen.mirror.push(input); return { fresh: true }; },
      transportFactory: options => require('../src/lib/cloud-agent/codex-cli-transport').createCodexCliTransport({ ...options,
        spawnImpl: (command, argv, config) => {
          seen.spawns.push({ command, argv, config });
          const { EventEmitter } = require('node:events');
          const child = new EventEmitter();
          child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.stdin.end = query => { seen.queries.push(query); }; child.kill = () => {};
          setImmediate(() => { child.stdout.emit('data', 'https://chatgpt.com/codex/tasks/task_e_manual1234'); child.emit('close', 0); });
          return child;
        } }), ...overrides }, launcher };
}

test('person-entered Cloud IDs launch only through the official CLI with unconfirmed binding shown', async () => {
  const fixture = manualLaunchFixture();
  const result = await fixture.launcher.launchCloudTask(fixture.request, fixture.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.taskId, 'task_e_manual1234');
  assert.equal(fixture.seen.spawns.length, 1);
  const call = fixture.seen.spawns[0];
  assert.equal(call.command, 'synthetic-official-codex');
  assert.deepEqual(call.argv, ['cloud', 'exec', '--env', environmentId, '--branch', 'main']);
  assert.equal(call.config.shell, false);
  assert.deepEqual(call.config.env, { CODEX_HOME: 'synthetic-selected-home' });
  assert.deepEqual(fixture.seen.probes, ['chosen']);
  assert.deepEqual(fixture.seen.mirror, [{ cloudRepository: 'owner/repository', mirrorBranch: 'main' }]);
  assert.equal(result.repositoryBinding.source, 'person-entered');
  assert.equal(result.repositoryBinding.providerConfirmed, false);
  assert.equal(result.repositoryBinding.confirmation, 'unconfirmed');
  assert.equal(result.repositoryBinding.providerRepository, null);
  assert.match(result.message, /entered by the person.*not confirmed/);
  assert.match(fixture.seen.queries[0], /not confirmed by the provider.*Verify the checked-out repository/);
});

test('manual Cloud declarations retain real provider refusals, freshness, and explicit provenance', async () => {
  for (const [discovery, expected] of [
    [{ environments: [{ environmentId, repository: 'other/repository' }], complete: true }, 'CLOUD_LAUNCH_REPOSITORY_MISMATCH'],
    [{ environments: [], complete: true }, 'CLOUD_LAUNCH_ENVIRONMENT_NOT_VISIBLE'],
  ]) {
    const fixture = manualLaunchFixture({ discoverEnvironmentsImpl: async () => discovery });
    await assert.rejects(fixture.launcher.launchCloudTask(fixture.request, fixture.dependencies), { code: expected });
    assert.equal(fixture.seen.spawns.length, 0);
    assert.equal(fixture.seen.mirror.length, 0);
  }
  const fixedSecret = randomBytes(24).toString('base64url');
  for (const discoverEnvironmentsImpl of [async () => { throw new Error(fixedSecret); }, async () => null,
    async () => ({ environments: [{ environmentId, repository: null, reason: fixedSecret }], complete: false })]) {
    const fixture = manualLaunchFixture({ discoverEnvironmentsImpl });
    const result = await fixture.launcher.launchCloudTask(fixture.request, fixture.dependencies);
    excludes(result, fixedSecret);
    assert.equal(result.repositoryBinding.providerConfirmed, false);
    assert.equal(fixture.seen.spawns.length, 1);
  }
  const missing = manualLaunchFixture(); delete missing.request.environmentSource;
  await assert.rejects(missing.launcher.launchCloudTask(missing.request, missing.dependencies), { code: 'CLOUD_LAUNCH_BINDING_UNVERIFIED' });
  assert.equal(missing.seen.spawns.length, 0);
  for (const source of [null, false, 'automatic', 'provider-confirmed']) {
    const fixture = manualLaunchFixture(); fixture.request.environmentSource = source;
    await assert.rejects(fixture.launcher.launchCloudTask(fixture.request, fixture.dependencies), { code: 'CLOUD_LAUNCH_ENVIRONMENT_SOURCE_INVALID' });
    assert.equal(fixture.seen.spawns.length, 0);
  }
  const stale = manualLaunchFixture({ checkMirrorFreshnessImpl: async () => { throw Object.assign(new Error('stale synthetic mirror'), { code: 'CLOUD_MIRROR_STALE' }); } });
  await assert.rejects(stale.launcher.launchCloudTask(stale.request, stale.dependencies), { code: 'CLOUD_MIRROR_STALE' });
  assert.equal(stale.seen.spawns.length, 0);
});

test('manual Cloud provenance is validated by the public tool schema using values', () => {
  const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
  const { validate } = require('../src/lib/schema-validator');
  const launch = TOOL_REGISTRY.find(tool => tool.name === 'cloud.task_launch');
  assert.ok(launch);
  const request = manualLaunchFixture().request;
  assert.equal(validate(launch.inputSchema, request).length, 0);
  for (const source of ['automatic', 'provider-confirmed', false, 1]) {
    assert.equal(validate(launch.inputSchema, { ...request, environmentSource: source }).length > 0, true);
  }
});
test('uncertain manual launches preserve unconfirmed provenance and withhold raw errors', async () => {
  const secret = randomBytes(24).toString('base64url');
  for (const createTask of [async () => null, async () => { throw Object.assign(new Error(secret), { code: secret }); }]) {
    const fixture = manualLaunchFixture({ transportFactory: () => ({ createTask }) });
    const result = await fixture.launcher.launchCloudTask(fixture.request, fixture.dependencies);
    excludes(result, secret);
    assert.equal(result.state, 'UNKNOWN');
    assert.equal(result.taskId, null);
    assert.equal(result.repositoryBinding.providerConfirmed, false);
    assert.match(result.message, /unknown.*entered by the person.*not confirmed/i);
  }
});

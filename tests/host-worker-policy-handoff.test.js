'use strict';
require('./lib/isolated-environment').activate('f3-private-policy-hook');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const filename = path.join(__dirname, '../src/lib/host-worker-session.js');
function loadLauncher() {
  const mutation = process.env.F3_POLICY_LAUNCHER_MUTATION;
  if (!mutation) return require(filename);
  const targets = { privateFactory: "if (observeThreadPolicyForLaunch !== null && typeof observeThreadPolicyForLaunch !== 'function')",
    privateLaunchArgument: "if (launchObservation !== null && typeof launchObservation !== 'function')",
    privateObserver: "if (observeThreadPolicy !== null && typeof observeThreadPolicy !== 'function')" };
  const source = fs.readFileSync(filename, 'utf8'), target = targets[mutation];
  if (!target || !source.includes(target)) throw Error('Launcher mutant not applicable');
  const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = module.paths;
  compiled._compile(source.replace(target, 'if (false)'), filename); return compiled.exports;
}
const { createHostWorkerLauncher } = loadLauncher();
function fixture(t, observeThreadPolicyForLaunch = null) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-policy-fixture-')); fs.chmodSync(stateRoot, 0o700);
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const calls = [];
  const launcher = createHostWorkerLauncher({ config: { mode: 'host', workers: true, stateRoot }, workspaceRoot: stateRoot,
    socketPath: path.join(stateRoot, 'fixture-socket'), env: { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1',
      TOOLSENABLED_TOOL_ALLOWLIST: 'host.read_file', TOOLSENABLED_LEVEL_CAP: '4' },
    checkNative: () => {}, agentApiMode: () => 'Enabled', observeThreadPolicyForLaunch,
    startCodex: async options => { calls.push(options); return { threadId: 'fixture-thread', resolvedSandbox: { type: 'dangerFullAccess' }, adapter: {}, close() {} }; }
  });
  const spec = { provider: 'codex', level: 4, nodeId: 'fixture-node', sessionId: 'fixture-session', parentSessionId: 'fixture-parent',
    nodeFolder: path.join(stateRoot, 'fixture-node'), linkToken: 'synthetic-fixture-token' };
  return { launcher, calls, spec, stateRoot };
}
test('private launcher observer reaches native options while approval and sandbox defaults remain unchanged', async t => {
  const observer = () => false; let observedSpec;
  const f = fixture(t, spec => { observedSpec = spec; return observer; });
  const ordinary = fixture(t); await ordinary.launcher.start(ordinary.spec); await f.launcher.start(f.spec);
  assert.equal(observedSpec, f.spec); assert.equal(f.calls[0].observeThreadPolicy, observer);
  assert.deepEqual(f.calls[0].threadOptions, ordinary.calls[0].threadOptions);
  assert.equal(ordinary.calls[0].observeThreadPolicy, undefined);
});
test('caller-shaped observer metadata cannot replace a private function', async t => {
  const f = fixture(t, () => ({ claimedTrusted: true, approvalPolicy: 'never' }));
  await assert.rejects(f.launcher.start(f.spec), { code: 'HOST_WORKER_POLICY_OBSERVER_INVALID' });
  assert.equal(f.calls.length, 0);
});
test('invalid private factory fails before attempting a worker start', () => {
  assert.throws(() => createHostWorkerLauncher({ config: { mode: 'host', workers: true },
    env: { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1' },
    observeThreadPolicyForLaunch: { claimedTrusted: true } }), { code: 'HOST_WORKER_POLICY_OBSERVER_INVALID' });
});
test('existing parent tool ceiling still refuses a wider child before private observation or native start', async t => {
  let observations = 0;
  const f = fixture(t, () => { observations++; return () => false; });
  const wider = { ...f.spec, serverEnv: { TOOLSENABLED_TOOL_ALLOWLIST: 'host.write_file' } };
  await assert.rejects(f.launcher.start(wider), { code: 'HOST_WORKER_ENV_INVALID' });
  assert.equal(observations, 0); assert.equal(f.calls.length, 0);
});
test('canonical host can supply exact private observation closure outside serialized worker spec', async t => {
  const f = fixture(t); const observer = () => false;
  await f.launcher.start(f.spec, { launchObservation: observer });
  assert.equal(f.calls[0].observeThreadPolicy, observer);
  assert.equal(Object.hasOwn(f.spec, 'launchObservation'), false);
  assert.equal(f.calls[0].threadOptions.approvalPolicy, 'never'); // existing level4 fixture setting
});
test('metadata in the private launch argument is explicitly refused before native start', async t => {
  const f = fixture(t);
  await assert.rejects(f.launcher.start(f.spec, { launchObservation: { claimedTrusted: true } }), { code: 'HOST_WORKER_POLICY_OBSERVER_INVALID' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.stateRoot), [], 'invalid private argument must not prepare worker capability files');
});

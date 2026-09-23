'use strict';

// Independent hostile/fault-injection proof for the production seams added to
// make the native worker durable and the optional two-computer bridge honest.
// No Task Scheduler mutation, vault read, listener, or network request occurs.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

require('./lib/isolated-environment').activate('managed-native-tunnel-hostile');

const managed = require('../src/lib/managed-processes');
const health = require('../src/lib/health-invariants');
const preflight = require('../tools/tunnel-bridge-preflight');
const offerClient = require('../tools/lib/link-bus-offer-client');

const ROOT = path.resolve(__dirname, '..');
const MARKER = 'PRIVATE_TOKEN_MARKER_Q91';
let passed = 0;
let skipped = 0;
function checkWindows(name, fn) {
  if (process.platform === 'win32') return check(name, fn);
  skipped += 1;
  process.stdout.write(`  SKIP ${name}: requires native Windows PowerShell\n`);
}
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}
async function checkAsync(name, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function registry(overrides = {}) {
  const value = {
    schemaVersion: 1,
    machines: {
      'customer-left': { address: '192.0.2.10', root: preflight.ROOT },
      'customer-right': { address: '192.0.2.20', root: 'D:\\Customer\\ToolsEnabled' }
    },
    services: {
      'local-link-bus-diagnostic': { resolution: 'self', port: 8787, transport: 'http' },
      'local-peer-tool-bridge-diagnostic': { resolution: 'self', port: 8788, transport: 'tcp' },
      'peer-tool-bridge': { resolution: 'peer', port: 8788, transport: 'tcp' },
      'shared-agent-bus': {
        resolution: 'fixed', fixedMachine: 'customer-right', port: 8787, transport: 'http'
      }
    }
  };
  return {
    ...value,
    ...overrides,
    machines: overrides.machines || value.machines,
    services: overrides.services || value.services
  };
}

function secrets(left = 'link-bus-token-abcdefghijkl', right = 'remote-bridge-token-uvwxyz') {
  return key => key === preflight.LINK_BUS_TOKEN_KEY ? left
    : (key === preflight.REMOTE_BRIDGE_TOKEN_KEY ? right : (() => { throw new Error('unexpected key'); })());
}

function evaluate(registryValue = registry(), options = {}) {
  return preflight.evaluateTunnelBridgeReadiness({
    registryOptions: { registry: registryValue },
    from: 'customer-left',
    readSecret: secrets(),
    ...options
  });
}

process.stdout.write('managed-native-tunnel-hostile\n');

check('a complete customer-owned pair passes without emitting identities, addresses, paths, or tokens', () => {
  const result = evaluate();
  assert.deepEqual(result, {
    schemaVersion: 'tunnel-bridge-preflight.v1',
    ok: true,
    configured: true,
    code: 'READY',
    localRole: 'coordinator',
    endpointsVerified: 4,
    tokensVerified: 2,
    secretValuesEmitted: false
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of ['customer-left', 'customer-right', '192.0.2.10', '192.0.2.20',
    preflight.ROOT, 'link-bus-token', 'remote-bridge-token']) {
    assert.equal(serialized.includes(forbidden), false, `preflight leaked ${forbidden}`);
  }
});

check('fresh one-machine install refuses before reading either vault token', () => {
  let reads = 0;
  const result = preflight.evaluateTunnelBridgeReadiness({
    registryOptions: {
      registry: { schemaVersion: 1, machines: { local: { address: '127.0.0.1' } }, services: {} }
    },
    from: 'local',
    readSecret() { reads += 1; return MARKER; }
  });
  assert.equal(result.code, 'TUNNEL_BRIDGE_TWO_MACHINE_SETUP_REQUIRED');
  assert.equal(reads, 0);
  assert.equal(JSON.stringify(result).includes(MARKER), false);
});

check('loopback, wrong-root, missing-service, and misdirected-peer setups fail closed', () => {
  const base = registry();
  const cases = [
    [registry({ machines: { ...base.machines, 'customer-left': { address: '127.0.0.1', root: preflight.ROOT } } }),
      'TUNNEL_BRIDGE_DIRECT_ADDRESS_REQUIRED'],
    [registry({ machines: { ...base.machines, 'customer-left': { address: '192.0.2.10', root: `C:\\${MARKER}` } } }),
      'TUNNEL_BRIDGE_ROOT_BINDING_REQUIRED'],
    [registry({ services: { ...base.services, 'peer-tool-bridge': undefined } }),
      'TUNNEL_BRIDGE_SERVICE_SETUP_REQUIRED'],
    [registry({ services: { ...base.services, 'peer-tool-bridge': { resolution: 'self', port: 8788, transport: 'tcp' } } }),
      'TUNNEL_BRIDGE_SERVICE_SETUP_REQUIRED']
  ];
  // JSON cannot carry an undefined service. Remove it to make a valid missing
  // declaration rather than accidentally testing malformed JSON semantics.
  delete cases[2][0].services['peer-tool-bridge'];
  for (const [fixture, code] of cases) {
    const result = evaluate(fixture);
    assert.equal(result.code, code);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(MARKER), false);
  }
});

check('missing, malformed, reused, and throwing secrets expose only fixed refusal codes', () => {
  const cases = [
    [() => { throw new Error(MARKER); }, 'TUNNEL_BRIDGE_TOKEN_SETUP_REQUIRED'],
    [secrets('short', `remote-${MARKER}-abcdefghijkl`), 'TUNNEL_BRIDGE_TOKEN_INVALID'],
    [secrets(MARKER.repeat(500), 'remote-bridge-token-uvwxyz'), 'TUNNEL_BRIDGE_TOKEN_INVALID'],
    [secrets('same-token-abcdefghijkl', 'same-token-abcdefghijkl'), 'TUNNEL_BRIDGE_TOKEN_REUSE_REFUSED']
  ];
  for (const [readSecret, code] of cases) {
    const result = evaluate(registry(), { readSecret });
    assert.equal(result.code, code);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(MARKER), false);
  }
});

check('ambient host, key-name, and role overrides cannot enter the preflight decision', () => {
  const names = ['TUNNEL_HOST', 'LINK_BUS_ENROLL_VAULT_KEY', 'REMOTE_AGENT_BRIDGE_ENROLL_VAULT_KEY', 'MACHINE_ID'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const seen = [];
  try {
    for (const name of names) process.env[name] = MARKER;
    const result = evaluate(registry(), {
      readSecret(key, options) {
        seen.push({ key, options });
        return secrets()(key);
      }
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen.map(item => item.key), [
      'custom.link_bus_bridge_token', 'custom.remote_agent_bridge_token'
    ]);
    assert.ok(seen.every(item => item.options.prompt === false));
    assert.equal(JSON.stringify(result).includes(MARKER), false);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

check('generic offer client pins coordinator/recipient topology and reads only the existing link-bus token', () => {
  const fixture = registry();
  const options = { registry: fixture };
  const topology = offerClient.rotationTopology(options);
  assert.deepEqual(topology, { coordinatorAddress: '192.0.2.10', recipientAddress: '192.0.2.20' });
  const pinned = offerClient.pinnedOfferUrl('http://192.0.2.20:8792/offer', {
    serviceRegistryOptions: options
  });
  assert.equal(pinned.parsed.pathname, '/offer');
  assert.throws(
    () => offerClient.pinnedOfferUrl(`http://192.0.2.20:8792/offer?x=${MARKER}`, { serviceRegistryOptions: options }),
    error => error.code === 'URL_NOT_PINNED' && !error.message.includes(MARKER)
  );
  const keys = [];
  const key = offerClient.collectOfferAuthenticationKey({ readSecret(name, readOptions) {
    keys.push({ name, readOptions });
    return 'link-bus-token-abcdefghijkl';
  } });
  assert.equal(key.toString('utf8'), 'link-bus-token-abcdefghijkl');
  key.fill(0);
  assert.deepEqual(keys, [{ name: 'custom.link_bus_bridge_token', readOptions: { prompt: false } }]);
});

check('managed declarations encode background native polling and setup-gated tunnel start', () => {
  const native = managed.getProcess('native-agent-worker');
  const tunnel = managed.getProcess('tunnel-bridge-keeper');
  assert.equal(native.onDemand, undefined);
  assert.equal(native.repetitionMinutes, 2);
  assert.equal(native.rungs.alive.kind, 'pid-lock');
  assert.equal(native.rungs.functioning.stateField, 'observedAtMs');
  assert.equal(tunnel.onDemand, true);
  assert.equal(tunnel.repetitionMinutes, undefined);
  assert.equal(tunnel.rungs.alive.kind, 'scheduled-task-running');
  assert.equal(tunnel.rungs.functioning.failureField, 'failureAt');
});

check('a fresh native heartbeat that records polling failure is never health-passed', () => {
  const native = managed.getProcess('native-agent-worker');
  const now = 1_900_000_000_000;
  const verdict = health.evaluateRung(native, 'functioning', {
    fileExists: () => true,
    readJsonFile: () => ({ observedAtMs: now - 1_000, ok: false }),
    now: () => now
  });
  assert.equal(verdict.state, 'fail');
  assert.match(verdict.reason, /ok=false/);
});

check('registrars and supervisor have no direct spawn, fixed host, fixed Node, or preflight bypass', () => {
  const nativeRegistrar = fs.readFileSync(path.join(ROOT, 'tools/native-agent-worker-register-task.ps1'), 'utf8');
  const tunnelRegistrar = fs.readFileSync(path.join(ROOT, 'tools/tunnel-bridge-keeper-task.ps1'), 'utf8');
  const supervisor = fs.readFileSync(path.join(ROOT, 'tools/bridge-session-supervisor.ps1'), 'utf8');
  const control = fs.readFileSync(path.join(ROOT, 'tools/tunnel-bridge-control.ps1'), 'utf8');
  const bridgeStarter = fs.readFileSync(path.join(ROOT, 'tools/start-remote-agent-bridge.ps1'), 'utf8');
  assert.match(nativeRegistrar, /Resolve-ToolsEnabledNode -Root \$repoRoot/);
  assert.match(nativeRegistrar, /repetitionMinutes/);
  assert.ok(nativeRegistrar.indexOf('Assert-RegisteredTaskCurrent -Task $task') <
    nativeRegistrar.indexOf('Start-ScheduledTask -TaskName $TaskName'),
  'explicit native starts must refuse a stale or replaced scheduled-task action');
  assert.doesNotMatch(nativeRegistrar, /C:\\(?:agent-apps|Program Files)|New-ToolsEnabledTaskTriggers\s+-OnDemand/i);
  assert.match(tunnelRegistrar, /New-ToolsEnabledTaskTriggers -OnDemand -IncludeLogon/);
  assert.doesNotMatch(tunnelRegistrar, /RepetitionInterval|Start-Process|machine-[ab]|Machine [AB]|C:\\(?:agent-apps|Program Files)/i);
  assert.ok(tunnelRegistrar.indexOf('Assert-TunnelBridgeReady') < tunnelRegistrar.indexOf('Register-ScheduledTask'));
  assert.match(tunnelRegistrar, /TUNNEL_BRIDGE_KEEPER_START_UNVERIFIED/);
  assert.match(tunnelRegistrar, /TUNNEL_BRIDGE_KEEPER_STOP_UNVERIFIED/);
  assert.doesNotMatch(tunnelRegistrar, /try\s*\{\s*Stop-ScheduledTask[^}]+\}\s*catch\s*\{\s*\}/s);
  assert.ok(supervisor.indexOf("$preflightRaw = @(& $Node $Preflight") < supervisor.indexOf('function Start-Component'));
  assert.match(supervisor, /Get-NetTCPConnection -LocalPort \$Component\.Port/);
  assert.match(control, /Get-NetTCPConnection -LocalPort \$Component\.Port/);
  assert.doesNotMatch(control, /Get-NetTCPConnection -LocalAddress \$HostName/);
  assert.match(control, /config\\managed-processes\.json/);
  assert.doesNotMatch(control, /\$KeeperTaskName\s*=\s*'ToolsEnabled/);
  assert.doesNotMatch(supervisor, /IndexOf\(\$expectedScript/);
  assert.match(supervisor, /\$commandLine -match \$scriptCommandPattern/);
  assert.match(bridgeStarter, /\$ownerCommandLine -match \$serverCommandPattern/);
  assert.doesNotMatch(bridgeStarter, /-match 'remote-agent-bridge\\\.js'/);
  assert.doesNotMatch(control, /Start-Process/);
  assert.match(control, /& \$KeeperTask -StartNow/);
  assert.match(control, /& \$KeeperTask -StopNow/);
});

checkWindows('managed registrars refuse a caller-selected task name before scheduler access', () => {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const cases = [
    ['tools/native-agent-worker-register-task.ps1', 'NATIVE_AGENT_WORKER_TASK_NAME_OVERRIDE_REFUSED'],
    ['tools/tunnel-bridge-keeper-task.ps1', 'TUNNEL_BRIDGE_KEEPER_TASK_NAME_OVERRIDE_REFUSED']
  ];
  for (const [relative, code] of cases) {
    const attempt = childProcess.spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(ROOT, relative), '-Status', '-TaskName', MARKER
    ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    const output = `${attempt.stdout || ''}\n${attempt.stderr || ''}`;
    assert.notEqual(attempt.status, 0, relative);
    assert.match(output, new RegExp(code), relative);
    assert.equal(output.includes(MARKER), false, relative);
    assert.doesNotMatch(output, /Get-ScheduledTask/i, relative);
  }
});

check('retired migration orchestrators are absent while generic sealed transport remains shipped', () => {
  const retired = [
    'tools/special-session-a-credential-handoff.js',
    'tools/special-session-archive-server.js',
    'tools/special-session-credential-receiver.js',
    'tools/special-session-portfolio-pipe-helper.py',
    'tools/special-session-vault-pipe-helper.ps1'
  ];
  for (const relative of retired) assert.equal(fs.existsSync(path.join(ROOT, relative)), false, relative);
  assert.equal(fs.existsSync(path.join(ROOT, 'tools/lib/special-session-sealed-transport.js')), true);
  const manifests = [
    fs.readFileSync(path.join(ROOT, 'config/packages.json'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'config/payload-boundary.json'), 'utf8')
  ].join('\n');
  for (const relative of retired) assert.equal(manifests.includes(relative), false, relative);
  assert.ok(manifests.includes('tools/lib/link-bus-offer-client.js'));
});

check('owned production paths contain no named-machine or personal-profile residue', () => {
  const paths = [
    'tools/link-bus-token-rotation-a.js',
    'tools/link-bus-token-rotation-receiver.js',
    'tools/link-bus-token-rotation-local.js',
    'tools/link-bus-token-rotation-verify.js',
    'tools/tunnel-bridge-preflight.js',
    'tools/tunnel-bridge-keeper-task.ps1',
    'tools/tunnel-bridge-control.ps1',
    'tools/tunnel-bridge-health.js',
    'tools/bridge-session-supervisor.ps1',
    'tools/start-remote-agent-bridge.ps1',
    'tools/native-agent-worker-register-task.ps1',
    'sidecars/native-agent/bin/native-agent-worker.js'
  ];
  for (const relative of paths) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /\bMachine [AB]\b|machine-[ab]|C:\\Users\\|undefined[\\/]src/i, relative);
  }
});

async function main() {
  await checkAsync('native worker health callback reports failed polling and cannot crash the worker', async () => {
    const workerPath = path.join(ROOT, 'sidecars/native-agent/src/native-agent-worker.js');
    const tasksPath = path.join(ROOT, 'src/lib/providers/tasks.js');
    require.cache[tasksPath] = { id: tasksPath, filename: tasksPath, loaded: true, exports: {} };
    delete require.cache[workerPath];
    const { NativeAgentWorker } = require(workerPath);
    const heartbeats = [];
    let worker;
    worker = new NativeAgentWorker({
      tasks: { async claim() { worker.stop(); throw new Error(MARKER); } },
      onHeartbeat(value) { heartbeats.push(value); if (heartbeats.length === 1) throw new Error('telemetry unavailable'); },
      onEvent() {},
      pollIntervalMs: 1,
      healthHeartbeatMs: 1
    });
    await worker.runForever();
    assert.equal(heartbeats[0].ok, false, 'startup cannot health-pass before a successful queue read');
    assert.equal(heartbeats[0].state, 'starting');
    assert.ok(heartbeats.some(item => item.ok === false && item.state === 'polling'));
    assert.ok(heartbeats.every(item => item.secretValuesEmitted === false));
    assert.equal(JSON.stringify(heartbeats).includes(MARKER), false);
  });
  process.stdout.write(`\nmanaged-native-tunnel-hostile: ${passed} checks passed, ${skipped} skipped\n`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

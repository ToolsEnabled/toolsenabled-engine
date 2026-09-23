// EXECUTABLE CHANGE
// Mutation report (testcanfail-tests-service-registry-js):
// - The two installation-dependent SERVICE_UNKNOWN guards were vacuous on a
//   fresh registry. Both tests now use the non-empty registry fixture and
//   execute their consumer assertions on every platform.
// - Mutation: made listServices return an empty list. The new cardinality
//   assertion goes RED with "AssertionError [ERR_ASSERTION]: the installation
//   registry must expose at least one canonical service name" (mutation was
//   checked with a focused harness because the full file's agent-comms import
//   requires node:sqlite, unavailable in the installed Node.js runtime).
// - NOT-FOUND: exit-status/truthy-return-only evidence; swallowed failures in
//   try/catch or optional chains; assertions against mocks of their subjects;
//   expected values computed by the subject code. Non-empty literal scenario
//   loops were found, but cannot execute vacuously and needed no change.
// - Restored source byte-for-byte. Final full-file run precondition not met:
//   this Node.js runtime has no node:sqlite. The run reaches the agent-comms
//   import and reports "ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module:
//   node:sqlite"; the focused runnable sections are green.

'use strict';

// Tests for src/lib/service-registry.js -- the resolver built so a caller
// asks for a service BY ROLE and cannot name the wrong endpoint, because it
// never names one at all. See config/service-registry.json's header comment
// and docs/coordinator/MECHANIZE-NOT-REMEMBER.md item 1 for the incident
// this exists to make impossible: the coordinator hardcoded
// 'http://203.0.113.2:8787' (Machine A's own address) and concluded,
// across hours and several owner reports, that Machine B was silent. It was
// not -- Machine B's independent copy of the link-bus was the canonical bus
// the whole time.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const registry = require('../src/lib/service-registry');
const registryProbe = require('../src/lib/service-registry-probe');
const peerDispatch = require('../tools/peer-dispatch');

const MACHINE_A = '203.0.113.2';
const MACHINE_B = '203.0.113.1';

function networkInterfacesFor(...addresses) {
  return () => ({ eth0: addresses.map(address => ({ family: 'IPv4', address })) });
}

function validRegistryFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    machines: {
      'machine-a': { address: MACHINE_A },
      'machine-b': { address: MACHINE_B }
    },
    services: {
      'shared-agent-bus': {
        displayName: 'Shared agent bus (Tunnel)', transport: 'http', port: 8787,
        resolution: 'fixed', fixedMachine: 'machine-b', peerReachable: true, healthPath: '/health'
      },
      'peer-tool-bridge': {
        displayName: 'Peer tool bridge (Bridge)', transport: 'mcp-jsonrpc-over-tcp', port: 8788,
        resolution: 'peer', peerReachable: true
      },
      'local-link-bus-diagnostic': {
        displayName: 'Local link-bus diagnostic', transport: 'http', port: 8787,
        resolution: 'self', peerReachable: false, healthPath: '/health'
      },
      'local-peer-tool-bridge-diagnostic': {
        displayName: 'Local peer-tool-bridge diagnostic', transport: 'mcp-jsonrpc-over-tcp', port: 8788,
        resolution: 'self', peerReachable: false
      },
      dashboard: {
        displayName: 'Dashboard', transport: 'http', port: 3889,
        resolution: 'loopback', peerReachable: false, healthPath: '/health'
      },
      ...overrides
    }
  };
}

function withAddresses(first, second) {
  const fixture = validRegistryFixture();
  fixture.machines['machine-a'].address = first;
  fixture.machines['machine-b'].address = second;
  return fixture;
}

function runPowerShellPolicy(root) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'service-registry-ps-'));
  const harness = path.join(directory, 'policy.ps1');
  const helper = path.join(__dirname, '..', 'tools', 'lib', 'service-registry.ps1');
  const quote = value => String(value).replace(/'/g, "''");
  fs.writeFileSync(harness, [
    "$ErrorActionPreference = 'Stop'",
    `. '${quote(helper)}'`,
    'try {',
    `  $topology = Resolve-ServiceRegistryTopology -Root '${quote(root)}' -ConfiguredAddress '10.0.0.5'`,
    "  [ordered]@{ ok = $true; local = $topology.localMachine.address; peer = $topology.peerMachine.address; code = $null } | ConvertTo-Json -Compress",
    '} catch {',
    "  [ordered]@{ ok = $false; local = $null; peer = $null; code = [string]$_.Exception.Message } | ConvertTo-Json -Compress",
    '}'
  ].join('\n'), 'ascii');
  try {
    const stdout = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness
    ], { windowsHide: true, encoding: 'utf8' });
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  let checks = 0;
  let skipped = 0;
  const check = async (label, fn) => { await fn(); checks += 1; void label; };
  const checkWindows = async (label, fn) => {
    if (process.platform !== 'win32') {
      skipped += 1;
      console.log(`SKIP ${label}: requires native Windows PowerShell`);
    } else await check(label, fn);
  };

  // --- 1. Unknown service refuses -------------------------------------------
  await check('an unregistered service id refuses with SERVICE_UNKNOWN, never a guess', () => {
    const result = registry.resolveService('does-not-exist-anywhere');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVICE_UNKNOWN');
    assert.match(result.reason, /does-not-exist-anywhere/);
  });

  await check('an empty or non-string service id refuses rather than throwing', () => {
    for (const bad of ['', null, undefined, 42]) {
      const result = registry.resolveService(bad);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SERVICE_ID_INVALID');
    }
  });

  // --- 2. THE regression test: the forked-bus bug is now impossible --------
  await check('shared-agent-bus is fixed to Machine B and NEVER resolves to Machine A, from any caller identity', () => {
    const fixture = validRegistryFixture();
    const fromA = registry.resolveService('shared-agent-bus', { registry: fixture, from: 'machine-a' });
    const fromB = registry.resolveService('shared-agent-bus', { registry: fixture, from: 'machine-b' });
    const noIdentityKnown = registry.resolveService('shared-agent-bus', {
      registry: fixture, networkInterfaces: networkInterfacesFor() // no interfaces match either machine
    });
    for (const result of [fromA, fromB, noIdentityKnown]) {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.host, MACHINE_B, 'shared-agent-bus must always resolve to the canonical Machine B address');
      assert.notEqual(result.host, MACHINE_A, 'shared-agent-bus must never resolve to Machine A -- this is the exact historical bug');
      assert.equal(result.url, `http://${MACHINE_B}:8787`);
      assert.equal(result.ownerMachineId, 'machine-b');
    }
  });

  await check('the retired owner-directive relay implementation and CLI stay absent', async () => {
    const repoRoot = path.resolve(__dirname, '..');
    assert.equal(fs.existsSync(path.join(repoRoot, 'src', 'lib', 'owner-directive-relay.js')), false);
    assert.equal(fs.existsSync(path.join(repoRoot, 'tools', 'owner-directive-relay.js')), false);
  });

  // --- 2b. Second migrated consumer: agent-comms.js's relay endpoint -------
  // src/lib/providers/agent-comms.js used to default relayHost to the
  // literal '203.0.113.2' (Machine A). It now resolves role
  // RELAY_SERVICE_ID ('shared-agent-bus') through the shared registry.
  // "shared-agent-bus" is 'fixed' resolution, so the caller's own
  // machine identity must NOT matter -- these three scenarios (machine-a,
  // machine-b, and an undetectable identity) must all still land on Machine
  // B, which is the specific proof requested for this migration.
  await check('the migrated consumer (agent-comms provider) resolves the relay endpoint to Machine B from machine-a identity, machine-b identity, and undetectable identity alike', () => {
    const agentComms = require('../src/lib/providers/agent-comms');
    assert.equal(agentComms.RELAY_SERVICE_ID, 'shared-agent-bus');
    const fixture = validRegistryFixture();
    const scenarios = {
      'machine-a identity': id => registry.resolveService(id, { registry: fixture, from: 'machine-a' }),
      'machine-b identity': id => registry.resolveService(id, { registry: fixture, from: 'machine-b' }),
      'undetectable identity': id => registry.resolveService(id, { registry: fixture, networkInterfaces: networkInterfacesFor() })
    };
    for (const [label, resolveServiceFn] of Object.entries(scenarios)) {
      const resolved = agentComms.resolveRelayEndpoint(resolveServiceFn);
      assert.equal(resolved.host, MACHINE_B, `${label}: shared-agent-bus must resolve to Machine B`);
      assert.notEqual(resolved.host, MACHINE_A, `${label}: must never resolve to Machine A -- this is the exact historical bug`);
      assert.equal(resolved.port, 8787);
    }
  });

  await check('agent-comms fails closed with a named AGENT_COMMS_RELAY_ENDPOINT_UNRESOLVED error when the resolver refuses, instead of falling back to a hardcoded host', () => {
    const agentComms = require('../src/lib/providers/agent-comms');
    const alwaysRefuses = () => ({ ok: false, service: 'shared-agent-bus', code: 'SERVICE_REGISTRY_UNAVAILABLE', reason: 'simulated for test' });
    assert.throws(
      () => agentComms.resolveRelayEndpoint(alwaysRefuses),
      error => error instanceof agentComms.AgentCommsToolError
        && error.code === 'AGENT_COMMS_RELAY_ENDPOINT_UNRESOLVED'
        && /SERVICE_REGISTRY_UNAVAILABLE/.test(error.message)
    );
  });

  await check('the agent-comms provider actually issues its outbound relay request to the resolved host, end to end, from machine-a identity, machine-b identity, and undetectable identity alike', async () => {
    const { createAgentCommsProvider } = require('../src/lib/providers/agent-comms');
    // The provider exposes its endpoint resolver as an injected production
    // seam. Exercise it with disposable registry state instead of consulting
    // an operator's installed two-computer topology and skipping on the
    // customer-neutral default.
    function memoryStore() {
      const entries = new Map();
      return Object.freeze({
        getMemory({ namespace, key }) {
          const value = entries.get(`${namespace}\0${key}`);
          return value ? JSON.parse(JSON.stringify(value)) : null;
        },
        setMemory({ namespace, key, value, expectedRevision }) {
          const lookup = `${namespace}\0${key}`;
          const prior = entries.get(lookup);
          const revision = prior ? prior.revision : 0;
          if (revision !== expectedRevision) throw Object.assign(new Error('revision conflict'), { code: 'MEMORY_REVISION_CONFLICT' });
          const entry = { namespace, key, value: JSON.parse(JSON.stringify(value)), revision: revision + 1 };
          entries.set(lookup, entry);
          return { entry: JSON.parse(JSON.stringify(entry)), created: !prior, replayed: false };
        }
      });
    }
    async function waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return predicate();
    }
    const fixture = validRegistryFixture();
    const scenarios = {
      'machine-a identity': id => registry.resolveService(id, { registry: fixture, from: 'machine-a' }),
      'machine-b identity': id => registry.resolveService(id, { registry: fixture, from: 'machine-b' }),
      'undetectable identity': id => registry.resolveService(id, { registry: fixture, networkInterfaces: networkInterfacesFor() })
    };
    for (const [label, resolveServiceFn] of Object.entries(scenarios)) {
      let capturedHost = null;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-endpoint-'));
      try {
        const provider = createAgentCommsProvider({
          localMachine: { address: MACHINE_A, machineId: 'machine-a' },
          stateStore: memoryStore(),
          tokenLoader: () => 'test-link-bus-token-value-000000',
          stateFile: path.join(directory, 'broker.json'),
          serviceRegistryOptions: { registry: fixture },
          resolveServiceFn,
          now: () => 1_900_000_000_000,
          // A deterministic fake transport -- captures the host the provider
          // actually dialed, then fails fast (no real network call, and no
          // lingering 5s relay-request-timeout handle left behind).
          requestImpl: (options) => {
            if (capturedHost === null) capturedHost = options.host;
            const fakeRequest = new EventEmitter();
            fakeRequest.write = () => {};
            fakeRequest.destroy = () => {};
            fakeRequest.end = () => {
              process.nextTick(() => fakeRequest.emit('error', Object.assign(
                new Error('test probe short-circuit -- no real network call is made'), { code: 'ECONNREFUSED' }
              )));
            };
            return fakeRequest;
          }
        });
        provider.send({ recipientActor: 'claude', recipientMachine: 'machine-b', body: 'endpoint probe' }, { agentActor: 'codex' }).catch(() => {});
        const observed = await waitFor(() => capturedHost !== null);
        assert.ok(observed, `${label}: the provider never attempted an outbound relay request`);
        assert.equal(capturedHost, MACHINE_B, `${label}: outbound relay request must target Machine B`);
        assert.notEqual(capturedHost, MACHINE_A, `${label}: outbound relay request must never target Machine A -- this is the exact historical bug`);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  await check('agent-comms uses one registry snapshot and refuses malformed, non-pair, or disagreeing local identity state', async () => {
    const { createAgentCommsProvider } = require('../src/lib/providers/agent-comms');
    assert.throws(
      () => createAgentCommsProvider({
        serviceRegistryOptions: { registry: { schemaVersion: 1, machines: [], services: {} } }
      }),
      error => error && error.code === 'SERVICE_REGISTRY_INVALID'
    );

    let tokenReads = 0;
    const tokenLoader = () => { tokenReads += 1; return 'test-link-bus-token-value-000000'; };
    const oneMachine = {
      schemaVersion: 1,
      machines: { only: { address: '192.0.2.10' } },
      services: {}
    };
    const oneProvider = createAgentCommsProvider({
      localMachine: { machineId: 'only', address: '192.0.2.10' },
      serviceRegistryOptions: { registry: oneMachine },
      tokenLoader
    });
    await assert.rejects(
      oneProvider.send({ recipientActor: 'claude', recipientMachine: 'absent-peer', body: 'x' }, { agentActor: 'codex' }),
      error => error && error.code === 'AGENT_COMMS_MACHINE_UNKNOWN'
    );

    const threeMachines = {
      schemaVersion: 1,
      machines: {
        left: { address: '192.0.2.10' },
        right: { address: '192.0.2.20' },
        extra: { address: '192.0.2.30' }
      },
      services: {}
    };
    const threeProvider = createAgentCommsProvider({
      localMachine: { machineId: 'left', address: '192.0.2.10' },
      serviceRegistryOptions: { registry: threeMachines },
      tokenLoader
    });
    await assert.rejects(
      threeProvider.send({ recipientActor: 'claude', recipientMachine: 'right', body: 'x' }, { agentActor: 'codex' }),
      error => error && error.code === 'AGENT_COMMS_TWO_MACHINE_TOPOLOGY_REQUIRED'
    );

    const fixture = validRegistryFixture();
    const mismatched = createAgentCommsProvider({
      localMachine: { machineId: 'machine-a', address: MACHINE_B },
      serviceRegistryOptions: { registry: fixture },
      tokenLoader
    });
    await assert.rejects(
      mismatched.send({ recipientActor: 'claude', recipientMachine: 'machine-b', body: 'x' }, { agentActor: 'codex' }),
      error => error && error.code === 'AGENT_COMMS_LOCAL_MACHINE_MISMATCH'
    );
    assert.equal(tokenReads, 0, 'topology and local-identity refusal must happen before any credential read');
  });

  // --- 3. Wrong-host / peer resolution: resolves to the true owner, or refuses distinctly ---
  await check('a peer-relative service resolves to the OTHER machine, symmetrically from each side', () => {
    const fixture = validRegistryFixture();
    const fromA = registry.resolveService('peer-tool-bridge', { registry: fixture, from: 'machine-a' });
    const fromB = registry.resolveService('peer-tool-bridge', { registry: fixture, from: 'machine-b' });
    assert.equal(fromA.ok, true);
    assert.equal(fromA.host, MACHINE_B, 'from machine-a, the peer bridge is on machine-b');
    assert.equal(fromA.ownerMachineId, 'machine-b');
    assert.equal(fromB.ok, true);
    assert.equal(fromB.host, MACHINE_A, 'from machine-b, the peer bridge is on machine-a');
    assert.equal(fromB.ownerMachineId, 'machine-a');
  });

  await check('a peer-relative service refuses with a distinct code when local identity cannot be told, instead of guessing a side', () => {
    const fixture = validRegistryFixture();
    const noMatch = registry.resolveService('peer-tool-bridge', {
      registry: fixture, networkInterfaces: networkInterfacesFor('10.0.0.9')
    });
    assert.equal(noMatch.ok, false);
    assert.equal(noMatch.code, 'SERVICE_LOCAL_MACHINE_UNKNOWN');
    assert.match(noMatch.reason, /cannot see/i);

    const bothMatch = registry.resolveService('peer-tool-bridge', {
      registry: fixture, networkInterfaces: networkInterfacesFor(MACHINE_A, MACHINE_B)
    });
    assert.equal(bothMatch.ok, false);
    assert.equal(bothMatch.code, 'SERVICE_LOCAL_MACHINE_UNKNOWN');
    assert.match(bothMatch.reason, /ambiguous/i);
  });

  await check('an unroutable "from" machine id refuses with SERVICE_MACHINE_UNKNOWN', () => {
    const fixture = validRegistryFixture();
    const result = registry.resolveService('peer-tool-bridge', { registry: fixture, from: 'machine-z' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVICE_MACHINE_UNKNOWN');
  });

  // --- 4. self vs loopback: the bug caught while building this module ------
  await check('"self" resolves to the caller\'s OWN direct-link address, not loopback (the link-bus binds a specific address, not 127.0.0.1)', () => {
    const fixture = validRegistryFixture();
    const fromA = registry.resolveService('local-link-bus-diagnostic', { registry: fixture, from: 'machine-a' });
    assert.equal(fromA.ok, true);
    assert.equal(fromA.host, MACHINE_A);
    assert.notEqual(fromA.host, '127.0.0.1', 'this diagnostic role must not collapse to loopback -- that would be connection-refused against the real listener');
  });

  await check('"loopback" always resolves to 127.0.0.1 and never needs or uses machine identity', () => {
    const fixture = validRegistryFixture();
    const withNoInterfaces = registry.resolveService('dashboard', { registry: fixture, networkInterfaces: networkInterfacesFor() });
    const withAmbiguousInterfaces = registry.resolveService('dashboard', { registry: fixture, networkInterfaces: networkInterfacesFor(MACHINE_A, MACHINE_B) });
    for (const result of [withNoInterfaces, withAmbiguousInterfaces]) {
      assert.equal(result.ok, true, 'loopback resolution must never fail on ambiguous/undetectable machine identity');
      assert.equal(result.host, '127.0.0.1');
      assert.equal(result.ownerMachineId, null);
    }
  });

  // --- 5. Registry integrity: malformed data fails closed -------------------
  await check('the sanctioned-address policy accepts an ordinary LAN pair and derives the exact peer from the registry', () => {
    const fixture = withAddresses('10.0.0.5', '10.0.0.6');
    const policy = registry.machineAddressPolicy({ registry: fixture });
    assert.deepEqual(policy.addresses, ['10.0.0.5', '10.0.0.6']);
    assert.equal(policy.has('10.0.0.5'), true);
    assert.equal(policy.has('10.0.0.6'), true);
    assert.equal(registry.assertSanctionedMachineAddress('10.0.0.5', { registry: fixture }).machineId, 'machine-a');
    assert.equal(registry.peerMachineForAddress('10.0.0.5', { registry: fixture }).address, '10.0.0.6');
  });

  await check('FRA direction uses address order with arbitrary customer machine ids and refuses non-pairs', () => {
    const customerPair = {
      schemaVersion: 1,
      machines: {
        'customer-studio': { address: '10.20.30.90' },
        'customer-laptop': { address: '10.20.30.4' }
      },
      services: {}
    };
    const pair = registry.directionalMachinePair({ registry: customerPair });
    assert.equal(pair.coordinatorMachine.machineId, 'customer-laptop');
    assert.equal(pair.recipientMachine.machineId, 'customer-studio');
    assert.throws(
      () => registry.directionalMachinePair({ registry: { schemaVersion: 1, machines: { only: { address: '10.0.0.1' } }, services: {} } }),
      error => error instanceof registry.ServiceRegistryError && error.code === 'SERVICE_PEER_UNDETERMINED'
    );
  });

  await check('peer dispatch accepts one exact customer pair and refuses a first-other choice from three machines', () => {
    const customerPair = {
      schemaVersion: 1,
      machines: {
        'editing-rig': { address: '10.20.30.90', root: 'D:\\ToolsEnabled' },
        'travel-laptop': { address: '10.20.30.4', root: 'E:\\ToolsEnabled' }
      },
      services: {}
    };
    const topology = peerDispatch.resolvePeerTopology({ registry: customerPair });
    assert.deepEqual(topology.machines.map(machine => machine.machineId), ['travel-laptop', 'editing-rig']);
    assert.equal(peerDispatch.localHost({
      topology,
      networkInterfaces: networkInterfacesFor('10.20.30.90')
    }), '10.20.30.90');
    assert.equal(peerDispatch.localHost({
      topology,
      networkInterfaces: networkInterfacesFor('10.20.30.90', '10.20.30.4')
    }), null, 'seeing both pair addresses must remain ambiguous');

    assert.throws(
      () => peerDispatch.resolvePeerTopology({
        registry: {
          ...customerPair,
          machines: { ...customerPair.machines, 'third-machine': { address: '10.20.30.120', root: 'F:\\ToolsEnabled' } }
        }
      }),
      error => error instanceof registry.ServiceRegistryError && error.code === 'SERVICE_PEER_UNDETERMINED'
    );
  });

  await check('the sanctioned-address policy refuses an address outside the registry with a named error', () => {
    const fixture = withAddresses('10.0.0.5', '10.0.0.6');
    assert.throws(
      () => registry.assertSanctionedMachineAddress('10.0.0.7', { registry: fixture }),
      error => error instanceof registry.ServiceRegistryError
        && error.code === 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED'
    );
  });

  await check('missing, malformed, and empty-machine registries all refuse address authorization by name', () => {
    const missingPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'service-registry-policy-missing-')), 'missing.json');
    assert.throws(
      () => registry.assertSanctionedMachineAddress('10.0.0.5', { registryPath: missingPath, noCache: true }),
      error => error instanceof registry.ServiceRegistryError && error.code === 'SERVICE_REGISTRY_UNAVAILABLE'
    );
    const malformed = withAddresses('10.0.0.5', 'not-an-ip');
    assert.throws(
      () => registry.assertSanctionedMachineAddress('10.0.0.5', { registry: malformed }),
      error => error instanceof registry.ServiceRegistryError && error.code === 'SERVICE_REGISTRY_INVALID'
    );
    assert.throws(
      () => registry.assertSanctionedMachineAddress('10.0.0.5', { registry: { schemaVersion: 1, machines: {}, services: {} } }),
      error => error instanceof registry.ServiceRegistryError && error.code === 'SERVICE_REGISTRY_EMPTY'
    );
  });

  await check('declaredPort refuses an unreadable registry instead of reporting the shipped fallback as declared', () => {
    const missingPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'service-registry-port-missing-')), 'missing.json');
    assert.throws(
      () => registry.declaredPort('shared-agent-bus', 8787, { registryPath: missingPath, noCache: true }),
      error => error instanceof registry.ServiceRegistryError && error.code === 'SERVICE_REGISTRY_UNAVAILABLE'
    );
  });

  await check('address authorization never trusts a cached valid registry after the file becomes malformed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-registry-live-policy-'));
    const registryFile = path.join(root, 'service-registry.json');
    try {
      fs.writeFileSync(registryFile, JSON.stringify(withAddresses('10.0.0.5', '10.0.0.6')), 'utf8');
      registry.resetRegistryCache();
      assert.equal(registry.loadRegistry({ registryPath: registryFile }).machines['machine-a'].address, '10.0.0.5');
      fs.writeFileSync(registryFile, '{not json', 'utf8');
      assert.throws(
        () => registry.assertSanctionedMachineAddress('10.0.0.5', { registryPath: registryFile }),
        error => error instanceof registry.ServiceRegistryError && error.code === 'SERVICE_REGISTRY_INVALID'
      );
    } finally {
      registry.resetRegistryCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('the existing direct-link pair remains the exact accepted peer pair when the registry declares it', () => {
    const fixture = withAddresses(MACHINE_A, MACHINE_B);
    assert.equal(registry.peerMachineForAddress(MACHINE_A, { registry: fixture }).address, MACHINE_B);
    assert.equal(registry.peerMachineForAddress(MACHINE_B, { registry: fixture }).address, MACHINE_A);
    assert.throws(
      () => registry.assertSanctionedMachineAddress('203.0.113.50', { registry: fixture }),
      error => error.code === 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED'
    );
  });

  await checkWindows('the PowerShell policy reads the same JSON, accepts the ordinary LAN pair, and refuses missing/malformed/empty registries by name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-registry-ps-root-'));
    try {
      fs.mkdirSync(path.join(root, 'config'));
      const registryFile = path.join(root, 'config', 'service-registry.json');
      fs.writeFileSync(registryFile, JSON.stringify(withAddresses('10.0.0.5', '10.0.0.6')), 'utf8');
      assert.deepEqual(runPowerShellPolicy(root), {
        ok: true, local: '10.0.0.5', peer: '10.0.0.6', code: null
      });

      fs.writeFileSync(registryFile, '{not json', 'utf8');
      assert.equal(runPowerShellPolicy(root).code, 'SERVICE_REGISTRY_INVALID');

      fs.writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, machines: {}, services: {} }), 'utf8');
      assert.equal(runPowerShellPolicy(root).code, 'SERVICE_REGISTRY_EMPTY');

      fs.unlinkSync(registryFile);
      assert.equal(runPowerShellPolicy(root).code, 'SERVICE_REGISTRY_UNAVAILABLE');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('a malformed registry (bad IPv4) is refused, not partially accepted', () => {
    const bad = validRegistryFixture();
    bad.machines['machine-a'].address = 'not-an-ip';
    const result = registry.resolveService('shared-agent-bus', { registry: bad });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVICE_REGISTRY_INVALID');
  });

  await check('a "fixed" service naming an unknown machine is refused, not silently pointed somewhere', () => {
    const bad = validRegistryFixture();
    bad.services['shared-agent-bus'].fixedMachine = 'machine-nowhere';
    const result = registry.resolveService('shared-agent-bus', { registry: bad });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVICE_REGISTRY_INVALID');
  });

  await check('an unsupported resolution kind is refused by name, not treated as any existing kind', () => {
    const bad = validRegistryFixture();
    bad.services.dashboard.resolution = 'teleport';
    const result = registry.resolveService('dashboard', { registry: bad });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVICE_REGISTRY_INVALID');
  });

  await check('a registry file that cannot be read is UNAVAILABLE, distinctly from an unknown service', () => {
    const missingPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'service-registry-missing-')), 'nope.json');
    const result = registry.resolveService('shared-agent-bus', { registryPath: missingPath, noCache: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVICE_REGISTRY_UNAVAILABLE');
  });

  await check('resolveServiceOrThrow throws ServiceRegistryError with the same code on refusal, and returns the same shape on success', () => {
    const fixture = validRegistryFixture();
    assert.throws(
      () => registry.resolveServiceOrThrow('nope', { registry: fixture }),
      error => error instanceof registry.ServiceRegistryError && error.code === 'SERVICE_UNKNOWN'
    );
    const ok = registry.resolveServiceOrThrow('dashboard', { registry: fixture });
    assert.equal(ok.ok, true);
    assert.equal(ok.host, '127.0.0.1');
  });

  // --- 6. Real on-disk registry sanity --------------------------------------
  await check('the real config/service-registry.json parses and returns a canonical service-name list', () => {
    registry.resetRegistryCache();
    const names = registry.listServices();
    assert.notEqual(names.length, 0,
      'the installation registry must expose at least one canonical service name');
    assert.deepEqual(names, [...new Set(names)].sort(),
      'service names from any valid installation registry must be unique and sorted');
  });

  // --- 7. Never emits a credential value ------------------------------------
  await check('the resolver module never reads a secret -- no getSecret call or import anywhere in its source', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'service-registry.js'), 'utf8');
    assert.doesNotMatch(source, /getSecret\s*\(/, 'service-registry.js must never call getSecret');
    assert.doesNotMatch(source, /\{[^}]*\bgetSecret\b[^}]*\}\s*=\s*require/, 'service-registry.js must never import getSecret');
  });

  await check('tokenVaultKey in a resolution is a key NAME string, never something that looks like a live secret', () => {
    const fixture = validRegistryFixture();
    fixture.services['shared-agent-bus'].tokenVaultKey = 'custom.link_bus_bridge_token';
    const resolved = registry.resolveService('shared-agent-bus', { registry: fixture });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.tokenVaultKey, 'custom.link_bus_bridge_token');
  });

  // --- 8. resolveAndProbe: distinguishes DOWN from UNKNOWN -------------------
  await check('resolveAndProbe classifies a refused/reset connection as DOWN, a genuine answer as UP', async () => {
    const fixture = validRegistryFixture();
    const up = await registryProbe.resolveAndProbe('shared-agent-bus', {
      registry: fixture,
      httpProbe: async () => ({ reachability: 'UP', status: 200 })
    });
    assert.equal(up.ok, true);
    assert.equal(up.reachability, 'UP');

    const down = await registryProbe.resolveAndProbe('shared-agent-bus', {
      registry: fixture,
      httpProbe: async () => ({ reachability: 'DOWN', error: 'ECONNREFUSED' })
    });
    assert.equal(down.ok, true);
    assert.equal(down.reachability, 'DOWN');
    assert.equal(down.probeError, 'ECONNREFUSED');
  });

  await check('resolveAndProbe reports UNKNOWN, not DOWN, when the outcome cannot be classified as a definite negative', async () => {
    const fixture = validRegistryFixture();
    const unclear = await registryProbe.resolveAndProbe('shared-agent-bus', {
      registry: fixture,
      httpProbe: async () => ({ reachability: 'UNKNOWN', error: 'timeout' })
    });
    assert.equal(unclear.reachability, 'UNKNOWN');
    assert.notEqual(unclear.reachability, 'DOWN', '"cannot tell" must never be reported as the stronger claim "is down"');
  });

  await check('probe timeouts and unavailable routes remain UNKNOWN because they did not measure the service', () => {
    for (const code of ['ETIMEDOUT', 'TimeoutError', 'EHOSTUNREACH', 'ENETUNREACH']) {
      assert.equal(registryProbe.classifyProbeError({ code }), 'UNKNOWN', `${code} must not claim the service is down`);
    }
  });

  await check('resolveAndProbe never attempts a network call when resolution itself fails', async () => {
    let probeCalled = false;
    const result = await registryProbe.resolveAndProbe('does-not-exist', {
      httpProbe: async () => { probeCalled = true; return { reachability: 'UP' }; }
    });
    assert.equal(result.ok, false);
    assert.equal(probeCalled, false, 'a probe must never fire against an endpoint that could not be identified');
  });

  await check('resolveAndProbe reports UNKNOWN, not a guess, for a service with no declared health path', () => {
    const promise = registryProbe.resolveAndProbe('peer-tool-bridge', { registry: validRegistryFixture(), from: 'machine-a' });
    return promise.then(result => {
      assert.equal(result.ok, true);
      assert.equal(result.reachability, 'UNKNOWN');
      assert.match(result.probeError, /SERVICE_PROBE_UNSUPPORTED/);
    });
  });

  // --- 9. Third and fourth migrated consumers: tunnel-bridge-health.js and --
  // remote-bridge-smoke-test.js. Both used to default to the literal
  // '203.0.113.2' (Machine A's own address). Unlike shared-agent-bus (a
  // "fixed" role that must NEVER resolve to Machine A), these two are
  // self-relative: the correct behaviour is that they track whichever
  // machine is actually running them. The regression these tests must catch
  // is therefore different in shape from section 2's: not "always resolves
  // to Machine A regardless of identity" (the old bug), but "resolves to
  // THIS caller's own identity, and refuses -- rather than guessing Machine
  // A -- when identity cannot be told." A new role,
  // 'local-peer-tool-bridge-diagnostic' (self resolution, port 8788), was
  // added for this pair, mirroring local-link-bus-diagnostic (self, 8787).
  await check('the new role local-peer-tool-bridge-diagnostic resolves to the CALLER\'s own address, from machine-a identity and machine-b identity alike, and refuses -- never defaulting to Machine A -- when identity is undetectable', () => {
    const fixture = validRegistryFixture();
    const fromA = registry.resolveService('local-peer-tool-bridge-diagnostic', { registry: fixture, from: 'machine-a' });
    assert.equal(fromA.ok, true);
    assert.equal(fromA.host, MACHINE_A);
    assert.equal(fromA.port, 8788);

    const fromB = registry.resolveService('local-peer-tool-bridge-diagnostic', { registry: fixture, from: 'machine-b' });
    assert.equal(fromB.ok, true);
    assert.equal(fromB.host, MACHINE_B, 'from machine-b identity this role must resolve to machine-b\'s OWN address, not machine-a\'s');
    assert.notEqual(fromB.host, MACHINE_A, 'must never silently resolve to Machine A when the caller is machine-b -- that is the exact historical default-masquerading-as-resolution bug');

    const undetectable = registry.resolveService('local-peer-tool-bridge-diagnostic', {
      registry: fixture, networkInterfaces: networkInterfacesFor() // no interfaces match either machine
    });
    assert.equal(undetectable.ok, false, 'undetectable identity must refuse, not silently default to Machine A');
    assert.equal(undetectable.code, 'SERVICE_LOCAL_MACHINE_UNKNOWN');
  });

  await check('the migrated consumer (tunnel-bridge-health.js) resolves both probe targets to the CALLER\'s own address across machine-a, machine-b, and undetectable identity, and never performs network I/O when unresolved', async () => {
    const tunnelBridgeHealth = require('../tools/tunnel-bridge-health');
    assert.equal(tunnelBridgeHealth.LINK_BUS_DIAGNOSTIC_SERVICE_ID, 'local-link-bus-diagnostic');
    assert.equal(tunnelBridgeHealth.REMOTE_BRIDGE_DIAGNOSTIC_SERVICE_ID, 'local-peer-tool-bridge-diagnostic');

    const fixture = validRegistryFixture();
    const scenarios = {
      'machine-a identity': id => registry.resolveService(id, { registry: fixture, from: 'machine-a' }),
      'machine-b identity': id => registry.resolveService(id, { registry: fixture, from: 'machine-b' }),
      'undetectable identity': id => registry.resolveService(id, { registry: fixture, networkInterfaces: networkInterfacesFor() })
    };
    const expectedHost = { 'machine-a identity': MACHINE_A, 'machine-b identity': MACHINE_B, 'undetectable identity': null };

    for (const [label, resolveServiceFn] of Object.entries(scenarios)) {
      for (const serviceId of [tunnelBridgeHealth.LINK_BUS_DIAGNOSTIC_SERVICE_ID, tunnelBridgeHealth.REMOTE_BRIDGE_DIAGNOSTIC_SERVICE_ID]) {
        if (expectedHost[label] === null) {
          assert.throws(
            () => tunnelBridgeHealth.resolveDiagnosticHost(serviceId, resolveServiceFn),
            error => error instanceof tunnelBridgeHealth.TunnelBridgeHealthError
              && error.code === 'TUNNEL_BRIDGE_HEALTH_ENDPOINT_UNRESOLVED'
              && /SERVICE_LOCAL_MACHINE_UNKNOWN/.test(error.message),
            `${label}/${serviceId}: must refuse with a named error, not fall back to a literal host`
          );
        } else {
          const host = tunnelBridgeHealth.resolveDiagnosticHost(serviceId, resolveServiceFn);
          assert.equal(host, expectedHost[label], `${label}/${serviceId}: must resolve to the caller's own address`);
          if (expectedHost[label] !== MACHINE_A) {
            assert.notEqual(host, MACHINE_A, `${label}/${serviceId}: must never silently resolve to Machine A when that is not the caller's own identity`);
          }
        }
      }
    }

    // End to end: when the role cannot be resolved, probeLinkBus/probeListener
    // must report a clean {ok:false} probe result -- never throw, and never
    // attempt a network call against a guessed host.
    const [linkBus, listener] = await Promise.all([
      tunnelBridgeHealth.probeLinkBus({ resolveServiceFn: scenarios['undetectable identity'] }),
      tunnelBridgeHealth.probeListener({ resolveServiceFn: scenarios['undetectable identity'] })
    ]);
    for (const result of [linkBus, listener]) {
      assert.equal(result.ok, false);
      assert.equal(result.host, null, 'no host was resolved, so none must be reported as probed');
      assert.equal(result.error, 'endpoint_unresolved');
      assert.match(result.reason, /SERVICE_LOCAL_MACHINE_UNKNOWN/);
    }
  });

  await check('the migrated consumer (remote-bridge-smoke-test.js) resolves its self-dial target to the CALLER\'s own address across machine-a, machine-b, and undetectable identity', () => {
    const smokeTest = require('../tools/remote-bridge-smoke-test');
    assert.equal(smokeTest.REMOTE_BRIDGE_DIAGNOSTIC_SERVICE_ID, 'local-peer-tool-bridge-diagnostic');
    assert.equal(smokeTest.PORT, 8788);
    const fixture = validRegistryFixture();

    assert.equal(
      smokeTest.resolveOwnAddress(id => registry.resolveService(id, { registry: fixture, from: 'machine-a' })),
      MACHINE_A
    );
    assert.equal(
      smokeTest.resolveOwnAddress(id => registry.resolveService(id, { registry: fixture, from: 'machine-b' })),
      MACHINE_B
    );
    assert.notEqual(
      smokeTest.resolveOwnAddress(id => registry.resolveService(id, { registry: fixture, from: 'machine-b' })),
      MACHINE_A,
      'from machine-b identity this must resolve to machine-b\'s own address, never Machine A'
    );

    assert.throws(
      () => smokeTest.resolveOwnAddress(id => registry.resolveService(id, { registry: fixture, networkInterfaces: networkInterfacesFor() })),
      error => error instanceof smokeTest.RemoteBridgeSmokeTestError
        && error.code === 'REMOTE_BRIDGE_SMOKE_TEST_ENDPOINT_UNRESOLVED'
        && /SERVICE_LOCAL_MACHINE_UNKNOWN/.test(error.message),
      'undetectable identity must refuse with a named error, not fall back to a literal host'
    );
  });

  process.stdout.write(`Service registry tests passed (${checks} checks, ${skipped} native Windows checks skipped).\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

// EXECUTABLE CHANGE -- testcanfail-tests-bridge-status-js
//
// Mutation report:
// - SAME-CODE EXPECTATION: DEFAULT_LIVENESS_TIMEOUT_MS in tools/bridge-status.js
//   was temporarily mutated from 45_000 to 11_000.  The pre-existing focused
//   assertions stayed green: "focused existing assertions passed under mutated
//   default: 11000".  The literal contract assertion below then made that same
//   mutation red: "AssertionError [ERR_ASSERTION]: the execution budget must
//   retain the measured 45-second default" and "11000 !== 45000".
// - NOT-FOUND empty loop/forEach: the only assertion loop uses an eight-element
//   literal and asserts that every case actually threw before inspecting it.
// - NOT-FOUND exit-status-only evidence: both spawned CLI checks also inspect
//   subject-owned stdout (usage text or the parsed named error).
// - NOT-FOUND swallowed failure: the validation-case catch records the error
//   and is followed by assert.ok(thrown); optional chaining is not used.
// - NOT-FOUND subject mocked by its own mock: injected proxies and policy data
//   are inputs at documented seams; assertions exercise bridge-status results.
// - NOT-FOUND skip/platform guard: this file contains no skip or precondition
//   that can turn it into a no-op.
// - RESTORED: tools/bridge-status.js was restored byte-for-byte (SHA-256
//   c9d94c173fa4eb2c9d338c52d0d1c4565be276f1a1df9d70fd4ad81f709a5d15).
// - GREEN AFTER RESTORE: the focused assertion run printed "focused strengthened
//   assertions passed after exact restore: 45000".
// - PRECONDITION NOT MET: the complete file is independently red before and
//   after this change at "the call completed; it was never hung" (false !==
//   true), so final confirmation uses the isolated strengthened assertion.

'use strict';

// Tests for tools/bridge-status.js's host-identity resolution -- the bug this
// exists to make impossible: defaultPeerConfig()'s bare-run fallback used to
// hardcode '203.0.113.2' (Machine A's own address) unconditionally whenever
// neither REMOTE_AGENT_PROXY_LOCAL_HOST nor REMOTE_AGENT_PROXY_HOST was set,
// so a bare run on Machine B reported itself as Machine A and probed the
// wrong peer. Same failure shape as the incident tests/service-registry.js
// documents; fixed the same way -- real interface detection, fail-closed on
// ambiguity, never a hardcoded guess.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_STATUS_PATH = path.join(ROOT, 'tools', 'bridge-status.js');
const SERVICE_REGISTRY_MODULE = require.resolve('../src/lib/service-registry');

const MACHINE_A = '203.0.113.2';
const MACHINE_B = '203.0.113.1';

// THE TWO MACHINES BELOW ARE A FIXTURE, NOT THIS HOST'S REAL CONFIGURATION.
//
// Every host-identity path under test here (detectLocalHost, defaultPeerConfig,
// parseArgs) asks the ONE central policy in src/lib/service-registry.js which
// addresses may name a machine, and that policy reads
// config/service-registry.json -- a live operational file describing a real
// deployment. Asserting against whatever that file happens to say makes this a
// test of one operator's network rather than of the resolution logic, and it
// re-states two real addresses in test source. The addresses below are RFC 5737
// documentation range: reserved, routable nowhere, correct to publish.
//
// Injecting a fixture registry is this repo's established way to say that --
// see tests/fra-machine-identity.js and tests/fra-secure-session.js, which pass
// `{ registry: <literal> }` through each function's serviceRegistryOptions
// argument. tools/bridge-status.js has no such argument: it destructures the
// three policy functions at module load and calls them with no options at all.
// So the same fixture is injected one level up, at the module seam, before
// bridge-status is required -- and only for the three functions that answer
// "is this address a known machine". Everything else passes through untouched,
// so ServiceRegistryError keeps its identity (the .code assertions below are
// checked on real ServiceRegistryError instances) and service resolution still
// reads the real file.
//
// It is written to disk rather than applied inline because the CLI checks at
// the end of this file run bridge-status in a SEPARATE PROCESS, which cannot
// see an in-process patch. Parent and child load the identical file -- the
// parent by require, the child by `node --require` -- so there is exactly one
// definition of the fixture and no way for the two to drift.
const LAB_REGISTRY = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: MACHINE_A, root: 'C:\\lab\\machine-a', role: 'development-host' },
    'machine-b': { address: MACHINE_B, root: 'C:\\lab\\machine-b', role: 'disconnected-peer' }
  },
  services: {}
};

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-status-registry-'));
const REGISTRY_FIXTURE_PRELOAD = path.join(fixtureDirectory, 'inject-lab-registry.cjs');
fs.writeFileSync(REGISTRY_FIXTURE_PRELOAD, [
  "'use strict';",
  '// Generated by tests/bridge-status.js; see the comment there. Substitutes a',
  '// documentation-range machine-address policy for the live one, in whichever',
  '// process loads this file, and nowhere else.',
  `const modulePath = ${JSON.stringify(SERVICE_REGISTRY_MODULE)};`,
  `const registry = ${JSON.stringify(LAB_REGISTRY)};`,
  'const real = require(modulePath);',
  '// A caller that names its own registry still gets its own registry.',
  "const withFixture = options => (options && (Object.hasOwn(options, 'registry') || Object.hasOwn(options, 'registryPath')))",
  '  ? options',
  '  : { ...options, registry };',
  'require.cache[modulePath].exports = Object.freeze({',
  '  ...real,',
  '  machineAddressPolicy: (options = {}) => real.machineAddressPolicy(withFixture(options)),',
  '  assertSanctionedMachineAddress: (address, options = {}) => real.assertSanctionedMachineAddress(address, withFixture(options)),',
  '  peerMachineForAddress: (address, options = {}) => real.peerMachineForAddress(address, withFixture(options))',
  '});',
  ''
].join('\n'), 'utf8');
process.on('exit', () => {
  try { fs.rmSync(fixtureDirectory, { recursive: true, force: true }); } catch { /* best-effort test cleanup */ }
});

require(REGISTRY_FIXTURE_PRELOAD);

const bridgeStatus = require('../tools/bridge-status');
const { loadRegistry } = require('../src/lib/service-registry');

// Validated through the real validateRegistry, so a malformed fixture fails
// loudly here instead of quietly changing what the assertions below mean.
const REGISTRY = loadRegistry({ registry: LAB_REGISTRY });
const machineForAddress = address => Object.values(REGISTRY.machines).find(machine => machine.address === address);

function networkInterfacesFor(...addresses) {
  return () => ({ eth0: addresses.map(address => ({ family: 'IPv4', address })) });
}

async function main() {
  let checks = 0;
  const check = async (label, fn) => { await fn(); checks += 1; void label; };

  // --- 1. detectLocalHost: the three-case bar (machine-a, machine-b, undetectable) ---
  await check('detectLocalHost resolves machine-a from its own interface', () => {
    assert.equal(bridgeStatus.detectLocalHost(networkInterfacesFor(MACHINE_A)), MACHINE_A);
  });

  await check('detectLocalHost resolves machine-b from its own interface', () => {
    assert.equal(bridgeStatus.detectLocalHost(networkInterfacesFor(MACHINE_B)), MACHINE_B);
  });

  await check('detectLocalHost refuses (returns null, never guesses) with no matching interface', () => {
    assert.equal(bridgeStatus.detectLocalHost(networkInterfacesFor('10.0.0.9')), null);
  });

  await check('detectLocalHost refuses (returns null, never guesses) with both addresses visible', () => {
    assert.equal(bridgeStatus.detectLocalHost(networkInterfacesFor(MACHINE_A, MACHINE_B)), null);
  });

  await check('detectLocalHost returns null rather than throwing if interfaces cannot be read', () => {
    const throwing = () => { throw new Error('EPERM'); };
    assert.equal(bridgeStatus.detectLocalHost(throwing), null);
  });

  // --- 2. defaultPeerConfig bare-run: the actual bug -- must detect, not hardcode machine-a ---
  await check('defaultPeerConfig bare run on machine-b resolves localHost to machine-b, not the old machine-a default', () => {
    const config = bridgeStatus.defaultPeerConfig({}, networkInterfacesFor(MACHINE_B));
    assert.equal(config.localHost, MACHINE_B);
    assert.equal(config.peerHost, MACHINE_A);
    assert.equal(config.expectedRoot, machineForAddress(MACHINE_A).root,
      'the root expectation describes the remote peer, never this local checkout');
    assert.notEqual(config.localHost, MACHINE_A, 'this is the exact regression: bare run on B must never report itself as A');
  });

  await check('defaultPeerConfig bare run on machine-a still resolves correctly', () => {
    const config = bridgeStatus.defaultPeerConfig({}, networkInterfacesFor(MACHINE_A));
    assert.equal(config.localHost, MACHINE_A);
    assert.equal(config.peerHost, MACHINE_B);
  });

  await check('defaultPeerConfig bare run with undetectable interfaces returns nulls instead of guessing', () => {
    const config = bridgeStatus.defaultPeerConfig({}, networkInterfacesFor());
    assert.equal(config.localHost, null);
    assert.equal(config.peerHost, null);
  });

  // --- 3. explicit env vars: unchanged behavior, regression guard ---
  await check('REMOTE_AGENT_PROXY_HOST=machine-a still forces localHost=machine-b (unchanged)', () => {
    const config = bridgeStatus.defaultPeerConfig({ REMOTE_AGENT_PROXY_HOST: MACHINE_A }, networkInterfacesFor());
    assert.equal(config.localHost, MACHINE_B);
    assert.equal(config.peerHost, MACHINE_A);
  });

  await check('REMOTE_AGENT_PROXY_HOST=machine-b still forces localHost=machine-a (unchanged)', () => {
    const config = bridgeStatus.defaultPeerConfig({ REMOTE_AGENT_PROXY_HOST: MACHINE_B }, networkInterfacesFor());
    assert.equal(config.localHost, MACHINE_A);
    assert.equal(config.peerHost, MACHINE_B);
  });

  await check('REMOTE_AGENT_PROXY_LOCAL_HOST always wins outright, detection never consulted', () => {
    const config = bridgeStatus.defaultPeerConfig({ REMOTE_AGENT_PROXY_LOCAL_HOST: MACHINE_B }, networkInterfacesFor(MACHINE_A));
    assert.equal(config.localHost, MACHINE_B, 'explicit env var must win even when real interfaces disagree');
  });

  // --- 4. parseArgs: --local/--peer stay byte-identical, bare run fails closed ---
  await check('parseArgs bare run refuses with a named error when identity is undetectable, instead of falling back to a literal host', () => {
    assert.throws(
      () => bridgeStatus.parseArgs([], {}, networkInterfacesFor()),
      /BRIDGE_STATUS_LOCAL_HOST_UNDETECTABLE/,
      'undetectable identity must refuse with a named error, not fall back to a literal host'
    );
  });

  await check('parseArgs bare run on machine-b resolves to machine-b, not machine-a', () => {
    const args = bridgeStatus.parseArgs([], {}, networkInterfacesFor(MACHINE_B));
    assert.equal(args.localHost, MACHINE_B);
    assert.equal(args.peerHost, MACHINE_A);
  });

  await check('--local and --peer override detection outright, even when interfaces are undetectable (byte-identical to prior behavior)', () => {
    const args = bridgeStatus.parseArgs(
      ['--local', MACHINE_B, '--peer', MACHINE_A],
      {},
      networkInterfacesFor()
    );
    assert.equal(args.localHost, MACHINE_B);
    assert.equal(args.peerHost, MACHINE_A);
  });

  await check('--local alone, with peer still undetectable, refuses on the peer side specifically -- peerHost is the value actually dialed over the network, so it must fail closed too', () => {
    assert.throws(
      () => bridgeStatus.parseArgs(['--local', MACHINE_B], {}, networkInterfacesFor()),
      /BRIDGE_STATUS_PEER_HOST_UNDETECTABLE/
    );
  });

  await check('--local plus a detectable peer interface resolves without needing --peer explicitly', () => {
    const args = bridgeStatus.parseArgs(['--local', MACHINE_B], {}, networkInterfacesFor(MACHINE_B));
    assert.equal(args.localHost, MACHINE_B);
    assert.equal(args.peerHost, MACHINE_A, 'peerHost is still derived from localHost when only --local is given explicitly');
  });

  await check('an explicit address outside the registry is refused with the central named error before probing', () => {
    assert.throws(
      () => bridgeStatus.parseArgs(['--local', MACHINE_B, '--peer', '10.0.0.9'], {}, networkInterfacesFor()),
      error => error && error.code === 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED'
    );
  });

  await check('the same registered address cannot be both self and peer', () => {
    assert.throws(
      () => bridgeStatus.parseArgs(['--local', MACHINE_B, '--peer', MACHINE_B], {}, networkInterfacesFor()),
      error => error && error.code === 'BRIDGE_STATUS_HOST_PAIR_INVALID'
    );
  });

  // --- 3. SLOW IS NOT DEAD ---------------------------------------------
  //
  // The regression these pin: probeBridge gave the proxy ONE budget (10s) and
  // classifyBridge mapped a liveness timeout to DEGRADED, so a working remote
  // lane whose tools/call took longer than the enumeration budget was reported
  // broken and exited 1. Measured against the live peer on 2026-08-11:
  // initialize 443-1237ms, tools/list 53-69ms, but system.kill_switch_status
  // 7,546-7,874ms -- all three succeeded. These exercise the real async paths
  // with real timers through probeBridge's own proxyFactory seam; nothing here
  // asserts on source text.

  const FORBIDDEN_FREE_TOOLS = [{ name: 'system.status' }, { name: 'system.kill_switch_status' }];

  // A proxy that answers correctly, but takes `livenessDelayMs` to do the one
  // thing that actually executes on the peer.
  const fakeProxy = ({ livenessDelayMs = 0, listDelayMs = 0, initDelayMs = 0, livenessFails = false } = {}) => () => ({
    closed: false,
    _dropSocket() {},
    async request(message) {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      if (message.method === 'initialize') {
        await sleep(initDelayMs);
        return { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'peer' } } };
      }
      if (message.method === 'notifications/initialized') return null;
      if (message.method === 'tools/list') {
        await sleep(listDelayMs);
        return { result: { tools: FORBIDDEN_FREE_TOOLS } };
      }
      if (message.method === 'tools/call') {
        await sleep(livenessDelayMs);
        if (livenessFails) return { error: { code: -32000, data: { code: 'REMOTE_TOOL_REFUSED' } } };
        return { result: { structuredContent: { active: false } } };
      }
      throw new Error(`unexpected method ${message.method}`);
    }
  });

  const probeWith = (proxyOptions, probeOptions = {}) => bridgeStatus.probeBridge({
    peerHost: MACHINE_B,
    localHost: MACHINE_A,
    expectedRoot: machineForAddress(MACHINE_B).root,
    tokenLoader: () => 'unused-by-the-injected-proxy',
    proxyFactory: fakeProxy(proxyOptions),
    ...probeOptions
  });

  await check('a liveness call slower than the OLD single 10s budget still succeeds and is not DEGRADED', async () => {
    const result = await probeWith({ livenessDelayMs: 120 }, { timeoutMs: 1000, livenessTimeoutMs: 5000, livenessSlowMs: 40 });
    assert.equal(result.liveness.ok, true, 'the call completed; it was never hung');
    assert.equal(result.liveness.slow, true);
    assert.equal(result.state, 'SLOW');
    assert.notEqual(result.state, 'DEGRADED', 'this is the regression: a working lane reported broken');
  });

  await check('SLOW exits 0, because a lane that answered correctly is usable', () => {
    assert.equal(bridgeStatus.exitCodeForState('SLOW'), 0);
    assert.equal(bridgeStatus.exitCodeForState('UP'), 0);
    assert.equal(bridgeStatus.exitCodeForState('DEGRADED'), 1);
    assert.equal(bridgeStatus.exitCodeForState('DOWN'), 1);
    assert.equal(bridgeStatus.exitCodeForState('UNKNOWN'), 1);
  });

  await check('a fast liveness call is still plain UP, never SLOW', async () => {
    const result = await probeWith({ livenessDelayMs: 0 }, { timeoutMs: 1000, livenessTimeoutMs: 5000, livenessSlowMs: 500 });
    assert.equal(result.state, 'UP');
    assert.equal(result.liveness.slow, false);
  });

  await check('a liveness call that genuinely FAILS is still DEGRADED -- SLOW never forgives a fault', async () => {
    const result = await probeWith({ livenessFails: true }, { timeoutMs: 1000, livenessTimeoutMs: 5000, livenessSlowMs: 40 });
    assert.equal(result.liveness.ok, false);
    assert.equal(result.state, 'DEGRADED');
  });

  await check('a liveness call that exceeds its OWN budget is DEGRADED, not SLOW', async () => {
    const result = await probeWith({ livenessDelayMs: 400 }, { timeoutMs: 1000, livenessTimeoutMs: 60, livenessSlowMs: 20 });
    assert.equal(result.liveness.ok, false);
    assert.equal(result.state, 'DEGRADED');
    assert.equal(result.liveness.error, 'BRIDGE_STATUS_STEP_BUDGET_EXCEEDED');
  });

  await check('the enumeration budget still bounds tools/list independently of the larger liveness budget', async () => {
    const result = await probeWith({ listDelayMs: 400 }, { timeoutMs: 60, livenessTimeoutMs: 30000, livenessSlowMs: 20 });
    assert.equal(result.tools.ok, false, 'a slow ENUMERATION is not excused by the liveness budget');
    assert.equal(result.state, 'DEGRADED');
  });

  await check('the enumeration budget still bounds initialize independently', async () => {
    const result = await probeWith({ initDelayMs: 400 }, { timeoutMs: 60, livenessTimeoutMs: 30000, livenessSlowMs: 20 });
    assert.equal(result.initialize.ok, false);
    assert.notEqual(result.state, 'UP');
  });

  // --- 4. THE REMOTE SURFACE MUST NOT BE WIDER THAN THE LOCAL TIER --------
  //
  // Measured on the live peer 2026-08-11: 294 advertised tools, 140 of them
  // write-effect, and host.write_file actually executed across the hop and wrote
  // to the peer's disk -- while this machine's own guardedToolNames() returns
  // 114 read-only tools and assertToolAllowed refuses host.write_file with
  // PERMISSION_EFFECT_REFUSED. The old three-name FORBIDDEN_REMOTE_TOOLS list
  // reported forbiddenExcluded:true throughout, because host.write_file was not
  // one of its three names.

  const guardedEffectsStub = (guardedNames, effects) => () => ({
    effectByName: new Map(Object.entries(effects)),
    guarded: new Set(guardedNames)
  });

  await check('a write-effect tool advertised remotely is caught even though it is not on the three-name forbidden list', () => {
    const summary = bridgeStatus.summarizeTools(
      { result: { tools: [{ name: 'system.status' }, { name: 'host.write_file' }] } },
      { guardedEffects: guardedEffectsStub(['system.status'], { 'system.status': 'local-read', 'host.write_file': 'local-write' }) }
    );
    assert.equal(summary.forbiddenExcluded, true, 'the old check passes -- host.write_file was never on its list');
    assert.equal(summary.ok, false, 'and the surface check must still fail');
    assert.equal(summary.error, 'remote_surface_wider_than_local_tier');
    assert.equal(summary.surfaceWidenedBy, 1);
    assert.deepEqual(summary.widenedSample, ['host.write_file']);
  });

  await check('a remote surface matching the local guarded tier passes', () => {
    const summary = bridgeStatus.summarizeTools(
      { result: { tools: [{ name: 'system.status' }, { name: 'audit.status' }] } },
      { guardedEffects: guardedEffectsStub(['system.status', 'audit.status'], { 'system.status': 'local-read', 'audit.status': 'local-read' }) }
    );
    assert.equal(summary.ok, true);
    assert.equal(summary.surfaceWidenedBy, 0);
    assert.equal(summary.effectParityChecked, true);
  });

  await check('a widened surface makes the whole bridge DEGRADED, not merely noted', async () => {
    const result = await probeWith({ livenessDelayMs: 0 }, {
      timeoutMs: 1000,
      livenessTimeoutMs: 5000,
      livenessSlowMs: 500
    });
    // The injected proxy advertises system.status + system.kill_switch_status;
    // both are local-read, so the REAL policy admits them and this stays UP.
    assert.equal(result.tools.effectParityChecked, true, 'parity is checked against the real local policy, not stubbed away');
    assert.equal(result.tools.surfaceWidenedBy, 0);
    assert.equal(result.state, 'UP');
  });

  await check('an unreadable local policy reports parity UNCHECKED and fails -- never silently "in parity"', () => {
    const summary = bridgeStatus.summarizeTools(
      { result: { tools: [{ name: 'system.status' }] } },
      { guardedEffects: () => { throw new Error('policy unreadable'); } }
    );
    assert.equal(summary.effectParityChecked, false);
    assert.equal(summary.ok, false, 'absence of a check must never read as a passed check');
    assert.equal(summary.error, 'remote_surface_parity_unchecked');
  });

  await check('a tool advertised remotely but absent from the local registry is counted, not silently ignored', () => {
    const summary = bridgeStatus.summarizeTools(
      { result: { tools: [{ name: 'system.status' }, { name: 'some.future_tool' }] } },
      { guardedEffects: guardedEffectsStub(['system.status'], { 'system.status': 'local-read' }) }
    );
    assert.equal(summary.advertisedButUnknownLocally, 1);
    assert.equal(summary.surfaceWidenedBy, 0, 'version skew is reported separately from a widened tier');
  });

  await check('an initialize that exceeds its budget is DEGRADED, not UNKNOWN -- the peer was reachable and did not serve', async () => {
    const result = await probeWith({ initDelayMs: 400 }, { timeoutMs: 60, livenessTimeoutMs: 30000, livenessSlowMs: 20 });
    assert.equal(result.initialize.error, 'BRIDGE_STATUS_STEP_BUDGET_EXCEEDED');
    assert.equal(result.state, 'DEGRADED',
      'UNKNOWN reads as "the checker could not tell" and would hide a measured fact');
    assert.equal(bridgeStatus.classifyFailure('BRIDGE_STATUS_STEP_BUDGET_EXCEEDED'), 'DEGRADED');
  });

  await check('the rollup ranks a real fault above SLOW, so a slow lane cannot mask a broken one', () => {
    assert.equal(bridgeStatus.rollUpState(['SLOW', 'DEGRADED']), 'DEGRADED');
    assert.equal(bridgeStatus.rollUpState(['SLOW', 'DOWN']), 'DOWN');
    assert.equal(bridgeStatus.rollUpState(['UP', 'SLOW']), 'SLOW');
    assert.equal(bridgeStatus.rollUpState(['UP', 'UP']), 'UP');
  });

  await check('a slow threshold at or above the budget is refused -- it could never fire', () => {
    assert.throws(
      () => bridgeStatus.parseArgs(['--local', MACHINE_A, '--peer', MACHINE_B, '--liveness-timeout-ms', '5000', '--liveness-slow-ms', '5000'], {}, networkInterfacesFor()),
      /BRIDGE_STATUS_LIVENESS_SLOW_INVALID/
    );
  });

  await check('the liveness budget defaults well above the measured live cost of a real tools/call', () => {
    const args = bridgeStatus.parseArgs(['--local', MACHINE_A, '--peer', MACHINE_B], {}, networkInterfacesFor());
    assert.equal(args.livenessTimeoutMs, bridgeStatus.DEFAULT_LIVENESS_TIMEOUT_MS);
    assert.equal(args.livenessTimeoutMs, 45_000,
      'the execution budget must retain the measured 45-second default');
    assert.ok(args.livenessTimeoutMs > 10_000,
      'the old 10s budget was below the measured 7.5-8s live cost by less than the noise');
    assert.ok(args.timeoutMs <= args.livenessTimeoutMs,
      'enumeration must never be given a larger budget than execution');
  });

  // --- 5. --HELP MUST NEVER REQUIRE HOST DETECTION -------------------------
  //
  // The regression this pins: parseArgs() ran defaultPeerConfig() -- full
  // interface-based host detection -- BEFORE it ever looked at args.help. A
  // host with no matching direct-link interface is a normal, correct
  // condition (see detectLocalHost's fail-closed contract in section 1 above,
  // and this repo's own owner-facing state: Machine A connected, Machine B
  // disconnected), yet it made even `--help` unreachable: the tool printed
  // the opaque error JSON below and exited 1 instead of usage text and exit 0.

  await check('parseArgs resolves --help from argv alone -- host detection never runs, even when interfaces would throw', () => {
    const refusingInterfaces = () => { throw new Error('detectLocalHost must not be called for --help'); };
    assert.deepEqual(bridgeStatus.parseArgs(['--help'], {}, refusingInterfaces), { help: true });
  });

  await check('parseArgs resolves -h the same way as --help', () => {
    const refusingInterfaces = () => { throw new Error('detectLocalHost must not be called for -h'); };
    assert.deepEqual(bridgeStatus.parseArgs(['-h'], {}, refusingInterfaces), { help: true });
  });

  await check('CLI: `node tools/bridge-status.js --help` exits 0 and prints usage, on any host', () => {
    const result = spawnSync(process.execPath, [BRIDGE_STATUS_PATH, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(result.status, 0, `expected exit 0; stderr was: ${result.stderr}`);
    assert.match(result.stdout, /Read-only registered-machine status checker/, 'usage text must be printed');
    assert.equal(result.stdout.includes('probe_error'), false, 'usage output must never contain the opaque error string');
  });

  // --- 6. A REFUSAL NAMES WHAT FAILED, NEVER THE OPAQUE 'probe_error' ------
  //
  // safeErrorCode() reads only error.code (and, failing that, a non-generic
  // error.name) -- never error.message. This module's own refusals used to be
  // plain `new Error('BRIDGE_STATUS_...')`, so the specific, actionable
  // identifier lived only in .message and was masked to the opaque
  // 'probe_error' by the time it reached the printed JSON. "I cannot see a
  // direct link from this machine" must stay the honest answer; only the
  // OPACITY of the code was the bug.

  await check('every parseArgs validation refusal carries a real .code that safeErrorCode reports verbatim, never probe_error', () => {
    const cases = [
      { argv: ['--peer'], expected: 'BRIDGE_STATUS_ARGUMENT_MISSING' },
      { argv: ['--bogus-flag', 'x'], expected: 'BRIDGE_STATUS_ARGUMENT_INVALID' },
      { argv: [], expected: 'BRIDGE_STATUS_LOCAL_HOST_UNDETECTABLE' },
      { argv: ['--local', MACHINE_A], expected: 'BRIDGE_STATUS_PEER_HOST_UNDETECTABLE' },
      { argv: ['--local', MACHINE_A, '--peer', MACHINE_B, '--timeout-ms', '1'], expected: 'BRIDGE_STATUS_TIMEOUT_INVALID' },
      { argv: ['--local', MACHINE_A, '--peer', MACHINE_B, '--liveness-timeout-ms', '1'], expected: 'BRIDGE_STATUS_LIVENESS_TIMEOUT_INVALID' },
      { argv: ['--local', MACHINE_A, '--peer', MACHINE_B, '--liveness-timeout-ms', '5000', '--liveness-slow-ms', '5000'], expected: 'BRIDGE_STATUS_LIVENESS_SLOW_INVALID' },
      { argv: ['--local', MACHINE_A, '--peer', MACHINE_B, '--bridge-port', 'not-a-number'], expected: 'BRIDGE_STATUS_PORT_INVALID' }
    ];
    for (const { argv, expected } of cases) {
      let thrown = null;
      try {
        bridgeStatus.parseArgs(argv, {}, networkInterfacesFor());
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, `expected ${expected} to throw for argv ${JSON.stringify(argv)}`);
      assert.equal(thrown.code, expected, `.code mismatch for argv ${JSON.stringify(argv)}`);
      assert.equal(
        bridgeStatus.safeErrorCode(thrown),
        expected,
        `safeErrorCode must report ${expected} verbatim -- this is the exact regression: it collapsed to probe_error, for argv ${JSON.stringify(argv)}`
      );
    }
  });

  await check('CLI: an invalid argument refuses with the specific code in the printed JSON, not probe_error', () => {
    // The child is its own process, so it gets the fixture registry the same way
    // this one did -- see REGISTRY_FIXTURE_PRELOAD above. Without it the
    // documentation-range pair is refused as unsanctioned before --timeout-ms is
    // ever validated, and this check would pin a different refusal than the one
    // it exists to pin.
    const result = spawnSync(process.execPath, [
      '--require', REGISTRY_FIXTURE_PRELOAD,
      BRIDGE_STATUS_PATH, '--local', MACHINE_A, '--peer', MACHINE_B, '--timeout-ms', '1'
    ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.error, 'BRIDGE_STATUS_TIMEOUT_INVALID', 'the specific refusal must survive to the printed JSON');
    assert.notEqual(parsed.error, 'probe_error', 'this is the exact regression: an actionable identifier masked into an opaque string');
  });

  process.stdout.write(`Bridge status tests passed (${checks} checks).\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

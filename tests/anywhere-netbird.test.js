/* EXECUTABLE CHANGE — testcanfail-tests-anywhere-netbird-test-js
 *
 * Strengthened assertions and mutation evidence:
 * - MAX_RELAY_ENDPOINTS was mutated from 8 to 9.  Before the fixed-value
 *   assertion was added, this test remained green because both the input and
 *   expected boundary came from the exported constant.  With the assertion it
 *   went RED: "FAIL  relay endpoints are bounded and validated: Expected
 *   values to be strictly equal: 9 !== 8".
 * - RECONNECT_MAX_MS was mutated from 60000 to 120000.  Before the fixed-value
 *   assertion was added, this test remained green because both the cap and its
 *   expectation came from the exported constant.  With the assertion it went
 *   RED: "FAIL  backoff grows and is capped: Expected values to be strictly
 *   equal: 120000 !== 60000".
 * - Restored src/lib/anywhere-netbird.js byte-for-byte after both mutations.
 *   The restored run was GREEN: "anywhere-netbird: 24 checks, 0 failure(s)".
 *
 * Census of requested shapes:
 * (1) NOT-FOUND — every assertion-bearing loop has a guaranteed non-empty
 *     input (the source scan necessarily contains the already-loaded JS
 *     modules, the backoff loop runs 10 times, and the retry loop 200 times).
 * (2) NOT-FOUND — this file makes no exit-status/truthy-process assertion.
 * (3) NOT-FOUND — the malformed-key catch verifies both the error code and
 *     secret-free message; its assert.fail is not swallowed because the
 *     resulting AssertionError fails the code assertion.
 * (4) NOT-FOUND — no mocks are used.
 * (5) NOT-FOUND — there are no skips or platform precondition guards.
 * (6) FOUND — the relay maximum and reconnect cap expected values were
 *     computed from the same module exports being checked; fixed below.
 *
 * Unmet preconditions: none.
 */
'use strict';

// The NetBird transport, and the licence boundary that decides whether this
// product can be sold at all.
//
// The expensive failure here is not a bug. It is an ARCHITECTURE that links a
// NetBird server into our process, because AGPLv3 section 13 then obliges us to
// publish the paid product's source to every user who reaches it over a
// network. A comment saying "do not link this" is not a control. This file
// makes it a mechanical one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const netbird = require('../src/lib/anywhere-netbird');
const anywhereTransport = require('../src/lib/anywhere-transport');
const machineProfile = require('../src/lib/machine-profile');
const entitlement = require('../src/lib/entitlement');

const ROOT = path.resolve(__dirname, '..');
const VALID_KEY = 'A1B2C3D4-1111-2222-3333-444455556666';

let checks = 0;
let failures = 0;

function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); checks += 1; }
  catch (error) { console.log(`  FAIL  ${name}: ${error && error.message}`); failures += 1; }
}

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

// --- the boundary ----------------------------------------------------------

check('no source file imports, vendors or forks a NetBird server', () => {
  // A require of anything NetBird-shaped is the exact act that would attach
  // AGPLv3 section 13 to this codebase. Searched over real files rather than
  // asserted about the one module that promises not to do it, because the
  // module that eventually does it will be a different one.
  const offenders = [];
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    const requires = text.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || [];
    for (const statement of requires) {
      if (/netbird|wiretrustee/i.test(statement)) offenders.push(`${path.relative(ROOT, file)}: ${statement}`);
    }
  }
  assert.deepEqual(offenders, [],
    `a NetBird server may only be reached over the network, never linked:\n${offenders.join('\n')}`);
});

check('no NetBird package is declared as a dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
  const offenders = declared.filter(name => /netbird|wiretrustee/i.test(name));
  assert.deepEqual(offenders, [], `NetBird servers are AGPLv3 and must not become a dependency: ${offenders.join(', ')}`);
});

check('the descriptor carries the boundary with it', () => {
  const deployment = netbird.describeDeployment({
    transport: 'self-hosted-relay',
    management: 'https://netbird.example.com'
  });
  assert.equal(deployment.agplBoundary.processes, 'separate');
  assert.equal(deployment.agplBoundary.linked, false);
  assert.match(deployment.agplBoundary.note, /AGPLv3/);
});

// --- no second transport axis, and no second gate --------------------------

check('NetBird adds no transport id, so the licence gate keeps its meaning', () => {
  // If 'netbird' ever appears here, a customer can select a word the
  // entitlement gate has no opinion about, and the paid capability becomes
  // reachable for free.
  assert.deepEqual([...machineProfile.TRANSPORTS], ['direct', 'self-hosted-relay', 'hosted-relay']);
  assert.deepEqual([...anywhereTransport.FREE_TRANSPORTS].sort(), ['direct', 'self-hosted-relay']);
  assert.ok(!machineProfile.TRANSPORTS.includes('netbird'));
});

check('self-hosting is free and hosted is gated, which is the whole product split', () => {
  const free = anywhereTransport.decideTransport('self-hosted-relay');
  assert.equal(free.allowed, true);
  assert.equal(free.entitlementChecked, false, 'self-hosting must never consult a licence');

  const gated = entitlement.GATED_CAPABILITIES['hosted-relay'];
  assert.ok(gated, 'hosted-relay must remain the gated capability');
  assert.ok(gated.freeAlternatives.some(text => /self-hosted-relay/.test(text)),
    'the gate must keep naming the free way to get the same job done');
});

check('operators are distinguished, so a descriptor cannot misreport who runs it', () => {
  assert.equal(netbird.describeDeployment({ transport: 'self-hosted-relay', management: 'https://a.example.com' }).operator, 'customer');
  assert.equal(netbird.describeDeployment({ transport: 'hosted-relay', management: 'https://b.example.com' }).operator, 'us');
});

// --- deployment descriptors ------------------------------------------------

check('the direct transport is refused rather than given an invented server', () => {
  assert.throws(() => netbird.describeDeployment({ transport: 'direct', management: 'https://a.example.com' }),
    error => error.code === 'ANYWHERE_NETBIRD_TRANSPORT_REFUSED');
  assert.throws(() => netbird.describeDeployment({ transport: 'netbird', management: 'https://a.example.com' }),
    error => error.code === 'ANYWHERE_NETBIRD_TRANSPORT_REFUSED');
});

check('plain http is refused, not silently upgraded', () => {
  assert.throws(() => netbird.describeDeployment({ transport: 'hosted-relay', management: 'http://netbird.example.com' }),
    error => error.code === 'ANYWHERE_NETBIRD_ENDPOINT_INSECURE');
});

check('loopback http is allowed, because that is how a self-hoster tests', () => {
  const deployment = netbird.describeDeployment({ transport: 'self-hosted-relay', management: 'http://127.0.0.1:33073' });
  assert.equal(deployment.management, 'http://127.0.0.1:33073');
});

check('credentials in an endpoint URL are refused', () => {
  assert.throws(() => netbird.describeDeployment({ transport: 'hosted-relay', management: 'https://user:pass@netbird.example.com' }),
    error => error.code === 'ANYWHERE_NETBIRD_ENDPOINT_INVALID');
});

check('a setup key pasted into a config field is caught before it is persisted', () => {
  assert.throws(() => netbird.describeDeployment({ transport: 'hosted-relay', management: VALID_KEY }),
    error => error.code === 'ANYWHERE_NETBIRD_SECRET_IN_CONFIG');
});

check('signal defaults to management, and trailing slashes normalize', () => {
  const deployment = netbird.describeDeployment({
    transport: 'self-hosted-relay',
    management: 'https://netbird.example.com/'
  });
  assert.equal(deployment.management, 'https://netbird.example.com');
  assert.equal(deployment.signal, deployment.management);
});

check('relay endpoints are bounded and validated', () => {
  assert.equal(netbird.MAX_RELAY_ENDPOINTS, 8);
  const deployment = netbird.describeDeployment({
    transport: 'hosted-relay',
    management: 'https://netbird.example.com',
    relays: ['https://relay1.example.com', 'https://relay2.example.com']
  });
  assert.equal(deployment.relays.length, 2);
  assert.throws(() => netbird.describeDeployment({
    transport: 'hosted-relay',
    management: 'https://netbird.example.com',
    relays: new Array(netbird.MAX_RELAY_ENDPOINTS + 1).fill('https://r.example.com')
  }), error => error.code === 'ANYWHERE_NETBIRD_RELAYS_INVALID');
});

// --- enrollment ------------------------------------------------------------

check('enrollment never returns, stores or echoes the setup key', () => {
  const deployment = netbird.describeDeployment({ transport: 'hosted-relay', management: 'https://netbird.example.com' });
  const receipt = netbird.prepareEnrollment({ deployment, setupKey: VALID_KEY, hostname: 'machine-a' });
  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes(VALID_KEY), 'the enrollment receipt leaked the setup key');
  assert.equal(receipt.setupKeyPresent, true);
  assert.equal(receipt.secretValuesEmitted, false);
  assert.equal(receipt.hostname, 'machine-a');
});

check('a malformed setup key is refused without being echoed', () => {
  const deployment = netbird.describeDeployment({ transport: 'hosted-relay', management: 'https://netbird.example.com' });
  try {
    netbird.prepareEnrollment({ deployment, setupKey: 'not-a-key-but-still-secret', hostname: 'machine-a' });
    assert.fail('a malformed setup key must be refused');
  } catch (error) {
    assert.equal(error.code, 'ANYWHERE_NETBIRD_SETUP_KEY_INVALID');
    assert.ok(!/not-a-key-but-still-secret/.test(error.message), 'the refusal echoed the credential it rejected');
  }
});

check('enrollment refuses a hand-built deployment', () => {
  assert.throws(() => netbird.prepareEnrollment({ deployment: { transport: 'direct' }, setupKey: VALID_KEY, hostname: 'm' }),
    error => error.code === 'ANYWHERE_NETBIRD_ENROLL_DEPLOYMENT_REFUSED');
});

// --- reconnection ----------------------------------------------------------

check('backoff grows and is capped', () => {
  assert.equal(netbird.RECONNECT_MAX_MS, 60000);
  const policy = netbird.createReconnectPolicy();
  const delays = [];
  for (let i = 0; i < 10; i += 1) delays.push(policy.nextReconnect(0, 'unreachable').delayMs);
  assert.deepEqual(delays.slice(0, 4), [1000, 2000, 4000, 8000]);
  assert.equal(delays[delays.length - 1], netbird.RECONNECT_MAX_MS);
  assert.ok(delays.every(delay => delay <= netbird.RECONNECT_MAX_MS));
});

check('resume from sleep reconnects now instead of serving out a stale backoff', () => {
  const policy = netbird.createReconnectPolicy();
  policy.nextReconnect(0);
  policy.nextReconnect(0);
  policy.nextReconnect(0);
  const resumed = policy.onResume();
  assert.equal(resumed.action, 'reconnect-now');
  assert.equal(resumed.attempt, 0);
  assert.equal(resumed.cause, 'resume');
  assert.equal(policy.nextReconnect(0).delayMs, 1000, 'backoff must restart after a resume');
});

check('a network change resets backoff AND invalidates prior candidates', () => {
  const policy = netbird.createReconnectPolicy();
  policy.nextReconnect(0);
  policy.nextReconnect(0);
  const before = policy.snapshot().networkGeneration;
  const changed = policy.onNetworkChange();
  assert.equal(changed.action, 'reconnect-now');
  assert.equal(changed.cause, 'network-change');
  assert.equal(changed.discardPriorCandidates, true);
  assert.equal(changed.networkGeneration, before + 1,
    'a new network must bump the generation so in-flight work from the old one can be discarded');
  assert.equal(policy.nextReconnect(0).delayMs, 1000);
});

check('a resume does NOT bump the network generation', () => {
  // The two events are genuinely different: same network after a lid close
  // means held state may still be good.
  const policy = netbird.createReconnectPolicy();
  const before = policy.snapshot().networkGeneration;
  policy.onResume();
  assert.equal(policy.snapshot().networkGeneration, before);
});

check('an exhausted policy refuses and explains, and never downgrades', () => {
  const policy = netbird.createReconnectPolicy({ maxAttempts: 2 });
  assert.equal(policy.nextReconnect(0).action, 'retry');
  assert.equal(policy.nextReconnect(0).action, 'retry');
  const refused = policy.nextReconnect(0, 'coordination server unreachable');
  assert.equal(refused.action, 'refuse');
  assert.equal(refused.state, 'refused');
  assert.match(refused.explanation, /refused rather than/);
  assert.match(refused.explanation, /route you did not choose/);
  // R1228, asserted on the OUTCOME rather than on the prose -- the explanation
  // is allowed to use the word "downgraded" precisely because it is telling the
  // user that no downgrade happened. What must not exist is a fallback RESULT:
  // no alternative transport is named, and 'refuse' is the terminal action.
  assert.deepEqual(Object.keys(refused).sort(), ['action', 'attempt', 'explanation', 'reason', 'state'].sort());
  assert.equal(refused.transport, undefined, 'a refusal must not name a transport to fall back to');
  assert.ok(!['retry', 'fallback', 'direct'].includes(refused.action));
  assert.equal(policy.nextReconnect(0).action, 'refuse', 'refusal is terminal, not a pause before a downgrade');
});

check('the default policy never gives up', () => {
  const policy = netbird.createReconnectPolicy();
  for (let i = 0; i < 200; i += 1) {
    assert.equal(policy.nextReconnect(0).action, 'retry');
  }
});

check('a connection resets the policy', () => {
  const policy = netbird.createReconnectPolicy();
  policy.nextReconnect(0);
  policy.nextReconnect(0);
  const connected = policy.onConnected();
  assert.equal(connected.state, 'connected');
  assert.equal(policy.snapshot().attempt, 0);
  assert.equal(policy.snapshot().lastReason, null);
});

check('snapshots carry no secret and refuse a bad clock', () => {
  const policy = netbird.createReconnectPolicy();
  assert.equal(policy.snapshot().secretValuesEmitted, false);
  assert.throws(() => policy.nextReconnect(Number.NaN), error => error.code === 'ANYWHERE_NETBIRD_CLOCK_INVALID');
  assert.throws(() => netbird.createReconnectPolicy({ baseMs: 5000, maxMs: 1000 }),
    error => error.code === 'ANYWHERE_NETBIRD_RECONNECT_BOUNDS_INVALID');
});

console.log(`\nanywhere-netbird: ${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exitCode = 1;

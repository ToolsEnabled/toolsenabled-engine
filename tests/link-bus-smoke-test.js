// EXECUTABLE CHANGE -- mutation audit report: testcanfail-tests-link-bus-smoke-test-js
'use strict';

const assert = require('node:assert/strict');

// --- the probe's host allowlist comes from a fixture registry ---------------
//
// tools/link-bus-smoke-test.js builds ALLOWED_HOSTS ONCE, at require time, from
// the live service registry (config/service-registry.json) -- the builder's own
// untracked, machine-local network configuration. Read that file and this test
// only passes on one LAN. So inject a two-machine fixture instead, exactly as
// tests/fra-secure-session.js does for the FRA peer pair; the addresses below
// are RFC 5737 documentation addresses and are the same ones the assertions use.
//
// The injection point is unusual only because the allowlist is captured at
// module load and runSmoke() takes no serviceRegistryOptions to pass down. So
// the fixture is supplied through the module the probe reads the registry
// through: a stand-in for src/lib/service-registry that DELEGATES to the real
// resolver with { registry: lab } filled in. The fixture therefore still goes
// through the production validateRegistry() and buildMachineAddressPolicy(), so
// the allowlist under test is built by shipped code and not hand-written here.
// Seeding require.cache with a stand-in module is the pattern
// tests/install-tier-enforcement.test.js already uses.
const lab = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.2', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.1', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};
const serviceRegistryPath = require.resolve('../src/lib/service-registry');
const serviceRegistry = require('../src/lib/service-registry');
const fixturePolicyCalls = [];
// An explicit registry from a caller still wins; the fixture only fills the gap
// where the probe would otherwise fall through to the on-disk registry.
const withFixture = (options = {}) => (
  Object.hasOwn(options, 'registry') || Object.hasOwn(options, 'registryPath')
    ? options
    : { ...options, registry: lab }
);
const savedServiceRegistry = require.cache[serviceRegistryPath];
require.cache[serviceRegistryPath] = {
  id: serviceRegistryPath,
  filename: serviceRegistryPath,
  loaded: true,
  exports: Object.freeze({
    ...serviceRegistry,
    machineAddressPolicy: (options = {}) => {
      const fixtureOptions = withFixture(options);
      fixturePolicyCalls.push(fixtureOptions);
      return serviceRegistry.machineAddressPolicy(fixtureOptions);
    },
    machineForId: (machineId, options = {}) => serviceRegistry.machineForId(machineId, withFixture(options))
  })
};
let probe;
try {
  probe = require('../tools/link-bus-smoke-test');
} finally {
  // The probe froze its allowlist during that require, so the stand-in has done
  // its whole job; put the real resolver back rather than leave it shadowed.
  if (savedServiceRegistry === undefined) delete require.cache[serviceRegistryPath];
  else require.cache[serviceRegistryPath] = savedServiceRegistry;
}
const {
  ALLOWED_HOSTS, SMOKE_START_CURSOR, READ_PAGE_SIZE, MAX_MESSAGE_ENVELOPE_BYTES, MAX_RESPONSE_BYTES,
  runSmoke, safeErrorCode
} = probe;
const { MAX_PAGE_SIZE } = require('../sidecars/link-bus/store');

// If the stand-in ever stops applying, the probe falls back to whatever
// machines the live registry declares, and the host assertions below start
// passing -- or failing -- for a reason that has nothing to do with this
// contract. Pin the allowlist to the fixture so that can never go unseen.
function testTheAllowlistCameFromTheFixture() {
  assert.deepEqual(fixturePolicyCalls, [{ registry: lab }],
    'the probe must ask the production registry resolver to build its allowlist from the fixture exactly once');
  assert.deepEqual([...ALLOWED_HOSTS].sort(), ['203.0.113.1', '203.0.113.2'],
    'the probe must build its host allowlist from the injected fixture registry, never from the machine-local one');
}

// The probe's paging is a contract with the server it probes, not a tuning
// knob. b0e07ba took the page size from transport-relay's DEFAULT_PAGE_SIZE --
// an unrelated subsystem -- so the probe silently dropped from 200 to 25 per
// page and every positioned read went to a limit this contract did not expect.
// Assert the agreement itself, so a retune anywhere reports as a stated drift
// rather than as an unexplained UNEXPECTED_POSITIONED_READ deep in a drain.
function testPagingAgreesWithTheServer() {
  assert.equal(READ_PAGE_SIZE, MAX_PAGE_SIZE,
    'the probe must page at the link bus server\'s own maximum page size; a larger ask is truncated and a smaller one only widens the HEAD_MOVED race');
  assert.ok(Number.isSafeInteger(READ_PAGE_SIZE) && READ_PAGE_SIZE > 0, 'the page size must be a positive integer');
  // The invariant b0e07ba existed to guarantee, now actually asserted: the
  // response cap must hold one whole page at the per-message envelope ceiling,
  // or the probe destroys its own socket on a healthy bus.
  assert.ok(MAX_RESPONSE_BYTES >= READ_PAGE_SIZE * MAX_MESSAGE_ENVELOPE_BYTES,
    'the response cap must be able to hold one full page at the envelope ceiling');
}

async function main() {
  testTheAllowlistCameFromTheFixture();
  testPagingAgreesWithTheServer();
  // Derived, never hand-copied: the stub answers exactly the page size the
  // probe advertises, so the fixture can never be the thing that drifts.
  const firstPage = `/v1/messages?channel=team&cursor=${SMOKE_START_CURSOR}&limit=${READ_PAGE_SIZE}`;
  const confirmationPage = `/v1/messages?channel=team&cursor=1&limit=${READ_PAGE_SIZE}`;
  const secret = 'link-bus-test-secret-marker';
  const messageMarker = 'private-message-marker';
  const calls = [];
  const output = [];
  const requestFn = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/health') return { status: 200, body: JSON.stringify({ ok: true, messages: 9, marker: messageMarker }) };
    if (path === '/tools/list' || path === '/v1/full-remote-access') return { status: 404, body: JSON.stringify({ error: 'not found' }) };
    if (path === '/v1/messages' && options.method === 'POST') return { status: 401, body: JSON.stringify({ error: 'unauthorized' }) };
    if (path.startsWith('/v1/messages?channel=team&cursor=')) {
      assert.equal(options.headers.Authorization, `Bearer ${secret}`);
      if (path === firstPage) {
        return {
          status: 200,
          body: JSON.stringify({
            messages: [{ sequence: 1, message: messageMarker }], cursor: '1', requestedCursor: 0,
            headSequence: 1, floorSequence: 1, backlogCount: 1, caughtUp: false, status: 'BACKLOG'
          })
        };
      }
      if (path === confirmationPage) {
        return {
          status: 200,
          body: JSON.stringify({
            messages: [], cursor: '1', requestedCursor: 1,
            headSequence: 1, floorSequence: 1, backlogCount: 0, caughtUp: true, status: 'CAUGHT_UP'
          })
        };
      }
      throw new Error('UNEXPECTED_POSITIONED_READ');
    }
    if (path === '/v1/messages?channel=team' && !options.headers) return { status: 401, body: JSON.stringify({ error: 'unauthorized' }) };
    if (path === '/v1/messages?channel=team' && options.headers.Authorization === 'Bearer link-bus-smoke-intentionally-invalid') {
      return { status: 401, body: JSON.stringify({ error: 'unauthorized' }) };
    }
    throw new Error('UNEXPECTED_TEST_REQUEST');
  };

  const result = await runSmoke({
    host: '203.0.113.2',
    tokenLoader: () => secret,
    requestFn,
    write: value => output.push(value)
  });
  assert.equal(result.ok, true);
  assert.equal(output.length, 1);
  assert.doesNotMatch(output[0], new RegExp(secret));
  assert.doesNotMatch(output[0], new RegExp(messageMarker));
  assert.match(output[0], /"responseBodiesEmitted": false/);
  assert.match(output[0], /"secretValuesEmitted": false/);
  assert.ok(calls.some(call => call.path === firstPage));
  assert.ok(calls.some(call => call.path === confirmationPage));
  // The drain must confirm caught-up with a second, empty positioned read --
  // one page plus one confirmation, never a single read that assumes absence.
  assert.equal(calls.filter(call => call.path.startsWith('/v1/messages?channel=team&cursor=')).length, 2,
    'the drain reads one page and then confirms with exactly one empty read');
  assert.ok(calls.some(call => call.path === '/v1/messages' && call.options.method === 'POST'));

  let tokenLoaded = false;
  await assert.rejects(
    () => runSmoke({ host: '203.0.113.9', tokenLoader: () => { tokenLoaded = true; return secret; }, requestFn, write() {} }),
    /LINK_BUS_HOST_NOT_ALLOWED/
  );
  assert.equal(tokenLoaded, false, 'an invalid target must fail before the vault loader runs');
  assert.equal(safeErrorCode(new Error(secret)), 'LINK_BUS_SMOKE_FAILED');
  assert.equal(safeErrorCode(new Error('LINK_BUS_REQUEST_TIMEOUT')), 'LINK_BUS_REQUEST_TIMEOUT');
  console.log('link bus content-safe smoke contract passed.');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

// Mutation audit (2026-08-26): replacing the product's ALLOWED_HOSTS
// initialization with `new Set(['203.0.113.1', '203.0.113.2'])` left the old
// suite GREEN: "link bus content-safe smoke contract passed." With the call
// assertion above, that same mutation is RED:
// "AssertionError [ERR_ASSERTION]: the probe must ask the production registry
// resolver to build its allowlist from the fixture exactly once"
// "actual: []"
// The product file was restored byte-for-byte (SHA-256
// 32d14fc7f0c3320c59d610a9cdfb3e1812581ce9b06b1aa4627156188097f9ff),
// then this file was GREEN: "link bus content-safe smoke contract passed."
// Audit census: empty loop/forEach assertions NOT-FOUND; exit-status/truthy-
// return-only assertions NOT-FOUND; swallowed failures via try/catch or optional
// chaining NOT-FOUND; further assertions against a mock of their own subject
// NOT-FOUND; file-wide skips or silent precondition guards NOT-FOUND; expected
// values computed only by the same code under test NOT-FOUND. Preconditions not
// met: none.

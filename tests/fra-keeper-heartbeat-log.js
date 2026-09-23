// EXECUTABLE CHANGE
// Assertion strengthened: writeKeeperState generatedAt freshness/ISO checks.
// Mutation: replaced the product's new Date().toISOString() value with the
// canonical but stale "2000-01-01T00:00:00.000Z". Before strengthening, the
// test stayed GREEN: "fra-keeper heartbeat-log telemetry retention passed."
// After strengthening, the same mutation produced RED:
// "AssertionError [ERR_ASSERTION]: generatedAt must describe this write, not merely contain some parseable timestamp"
// Restored source byte-for-byte; final GREEN:
// "fra-keeper heartbeat-log telemetry retention passed."
// NOT-FOUND (1): no assertion is confined to a possibly-empty loop/forEach.
// NOT-FOUND (2): no assertion treats an exit status/truthy return as evidence.
// NOT-FOUND (3): no test failure is swallowed by try/catch or optional chaining;
// the catch in finally is cleanup-only and cannot intercept an assertion.
// NOT-FOUND (4): injected heartbeat/log dependencies expose runHeartbeat's
// output and do not mock the sanitizer/wiring that those assertions exercise.
// NOT-FOUND (5): there is no skip or platform precondition guard.
// NOT-FOUND (6): no expected value is computed by the product code under test.
// FIXTURE PRECONDITION: the portable shipped registry correctly declares only
// this machine, while fra-peer-heartbeat requires an explicitly configured
// two-machine deployment. This test injects a temporary two-machine registry
// through the production loader's validated `registry` seam. It never mutates
// config/service-registry.json, so the portable default remains byte-for-byte
// unchanged even when tests run concurrently.

'use strict';

// Behavioural coverage for Correction 3 of the fra-reliability-commit3
// review: tools/fra-keeper.js's own runHeartbeat() must RETAIN the new
// stage/attempt/elapsedMs telemetry tools/fra-peer-heartbeat.js's heartbeat()
// now produces. Before this fix it logged only ok/code -- stage/attempt/
// elapsedMs were read off the result and then silently dropped on every
// single invocation, which is exactly the unattended path this telemetry
// effort exists to reach (an operator reading fra-keeper.log at 3am, not an
// interactive caller).
//
// tools/full-remote-access-lifecycle.ps1's Invoke-Reconcile has the same
// defect on its own (PowerShell) unattended path; its own
// Get-SanitizedHeartbeatTelemetry is a deliberately parallel implementation
// of the exact same four-field allowlist, tested in tests/fra-lifecycle-guards.js
// -- a literal shared module was not possible across the JS/PowerShell
// boundary, so both sides reuse/mirror the SAME allowlist logic instead of
// each inventing their own.
//
// fra-keeper.js is a self-executing script; requiring it here does NOT
// trigger the live run (guarded by `if (require.main === module)`), so
// runHeartbeat() can be exercised directly via its injectable
// heartbeatFn/logFn, matching the dependency-injection pattern
// tests/fra-peer-heartbeat.js already uses for createProxy/loadProfile/loadToken.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const serviceRegistry = require('../src/lib/service-registry');

const fixtureRegistryInput = Object.freeze({
  schemaVersion: 1,
  machines: Object.freeze({
    'machine-a': Object.freeze({ address: '192.0.2.10', root: 'C:\\fixture\\machine-a' }),
    'machine-b': Object.freeze({ address: '192.0.2.11', root: 'C:\\fixture\\machine-b' })
  }),
  services: Object.freeze({
    'full-remote-access': Object.freeze({ transport: 'tcp', resolution: 'peer', port: 8790 })
  })
});
const fixtureRegistry = serviceRegistry.loadRegistry({ registry: fixtureRegistryInput });
assert.deepEqual(Object.keys(fixtureRegistry.machines).sort(), ['machine-a', 'machine-b']);
assert.equal(serviceRegistry.declaredPort('full-remote-access', 1, { registry: fixtureRegistryInput }), 8790);

// fra-peer-heartbeat resolves its deployment topology at module load. Keep the
// override scoped to those requires, return every other production export
// unchanged, and restore Node's loader even if a dependency refuses to load.
const serviceRegistryPath = require.resolve('../src/lib/service-registry');
const injectedServiceRegistry = Object.freeze({
  ...serviceRegistry,
  loadRegistry: () => fixtureRegistry,
  declaredPort: (serviceId, fallback) => serviceRegistry.declaredPort(
    serviceId, fallback, { registry: fixtureRegistryInput }),
  machineAddressPolicy: () => serviceRegistry.machineAddressPolicy({ registry: fixtureRegistryInput })
});
const originalModuleLoad = Module._load;
Module._load = function loadWithFixture(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (resolved === serviceRegistryPath) return injectedServiceRegistry;
  return originalModuleLoad.call(this, request, parent, isMain);
};

let keeper;
let sanitizeHeartbeatTelemetry;
try {
  ({ sanitizeHeartbeatTelemetry } = require('../tools/fra-peer-heartbeat'));
  keeper = require('../tools/fra-keeper');
} finally {
  Module._load = originalModuleLoad;
}

async function main() {
  // --- sanitizeHeartbeatTelemetry(): the strict allowlist itself, exercised
  // directly first (fra-keeper.js's own coverage below just proves it is
  // actually WIRED IN). Widened from four to FIVE fields by correction D
  // (2026-08-04 review round 2): attemptsHistory, a bounded/sanitized
  // per-attempt summary, so a recovered retry's masked attempt-1 failure is
  // no longer silently dropped by this same unattended-log projection. -----
  {
    const clean = sanitizeHeartbeatTelemetry({
      ok: true, host: '203.0.113.1', peer: '203.0.113.2', toolCount: 3,
      stage: 'liveness_write', attempt: 1, elapsedMs: 4821, secretValuesEmitted: false,
      attemptsHistory: [{ attempt: 1, stage: 'liveness_write', code: null, elapsedMs: 4821, ok: true }]
    });
    assert.deepEqual(clean, {
      code: null, stage: 'liveness_write', attempt: 1, elapsedMs: 4821,
      attemptsHistory: [{ attempt: 1, stage: 'liveness_write', code: null, elapsedMs: 4821, ok: true }]
    });
  }
  {
    const failed = sanitizeHeartbeatTelemetry({
      ok: false, code: 'REMOTE_BRIDGE_RESET', stage: 'connect', attempt: 2, elapsedMs: 512
    });
    assert.deepEqual(failed, { code: 'REMOTE_BRIDGE_RESET', stage: 'connect', attempt: 2, elapsedMs: 512, attemptsHistory: [] });
  }
  // An unrecognized stage/attempt/elapsedMs value collapses to null exactly
  // like heartbeat()'s own safeStage/safeAttempt/safeElapsedMs do -- this
  // helper must never invent a second, weaker allowlist of its own.
  {
    const bogus = sanitizeHeartbeatTelemetry({
      ok: false, code: 'not safe', stage: 'not_a_real_stage', attempt: 3, elapsedMs: -5
    });
    assert.deepEqual(bogus, { code: 'FRA_HEARTBEAT_FAILED', stage: null, attempt: null, elapsedMs: null, attemptsHistory: [] });
  }
  // An attempt to smuggle an extra/unexpected field through the result
  // object must never be retained -- only the exact 5 allowlisted keys are
  // ever present on the sanitized output, whatever else is on the input.
  {
    const smuggled = sanitizeHeartbeatTelemetry({
      ok: true, stage: 'liveness_write', attempt: 1, elapsedMs: 99,
      secretPath: 'C:\\should\\never\\appear',
      token: 'must-not-leak-anywhere-0123456789'
    });
    assert.deepEqual(Object.keys(smuggled).sort(), ['attempt', 'attemptsHistory', 'code', 'elapsedMs', 'stage']);
    const serialized = JSON.stringify(smuggled);
    assert.equal(serialized.includes('secretPath'), false);
    assert.equal(serialized.includes('token'), false);
    assert.equal(serialized.includes('must-not-leak'), false);
  }
  // Correction D end to end: a masked-retry result (attempt-1 failure,
  // attempt-2 success) must retain BOTH attempts' summaries through this
  // same sanitizer, and a hostile/oversized attemptsHistory on the input
  // must never pass through unsanitized or ungrown past 2 entries.
  {
    const recovered = sanitizeHeartbeatTelemetry({
      ok: true, stage: 'liveness_write', attempt: 2, elapsedMs: 300,
      attemptsHistory: [
        { attempt: 1, stage: 'connect', code: 'REMOTE_BRIDGE_RESET', elapsedMs: 120, ok: false },
        { attempt: 2, stage: 'liveness_write', code: null, elapsedMs: 300, ok: true }
      ]
    });
    assert.equal(recovered.attemptsHistory.length, 2);
    assert.equal(recovered.attemptsHistory[0].ok, false, 'attempt 1\'s failure must survive this sanitizer too');
    assert.equal(recovered.attemptsHistory[0].code, 'REMOTE_BRIDGE_RESET');
    assert.equal(recovered.attemptsHistory[1].ok, true);
    assert.equal(Object.isFrozen(recovered.attemptsHistory), true);

    const hostile = sanitizeHeartbeatTelemetry({
      ok: false,
      attemptsHistory: [
        { attempt: 1, stage: 'connect', code: 'REMOTE_BRIDGE_RESET', elapsedMs: 10, ok: false },
        { attempt: 2, stage: 'connect', code: 'REMOTE_BRIDGE_RESET', elapsedMs: 20, ok: false },
        { attempt: 1, stage: 'connect', code: 'SHOULD_NOT_APPEAR', elapsedMs: 1, ok: false, token: 'must-not-leak-0123456789' }
      ]
    });
    assert.equal(hostile.attemptsHistory.length, 2, 'no more than 2 entries may ever survive this sanitizer either');
    const hostileSerialized = JSON.stringify(hostile);
    assert.equal(hostileSerialized.includes('SHOULD_NOT_APPEAR'), false);
    assert.equal(hostileSerialized.includes('must-not-leak'), false);
  }

  // --- fra-keeper.js's own runHeartbeat(): the fields now reach its log,
  // on a genuine successful probe. --------------------------------------
  {
    const logged = [];
    await keeper.runHeartbeat('203.0.113.1', 'steady', {
      heartbeatFn: async () => ({
        ok: true, host: '203.0.113.1', peer: '203.0.113.2',
        toolCount: 3, readOnlyToolVerified: 'system.kill_switch_status',
        stage: 'liveness_write', attempt: 1, elapsedMs: 8123, secretValuesEmitted: false,
        attemptsHistory: [{ attempt: 1, stage: 'liveness_write', code: null, elapsedMs: 8123, ok: true }]
      }),
      logFn: record => logged.push(record)
    });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].action, 'heartbeat');
    assert.equal(logged[0].context, 'steady');
    assert.equal(logged[0].host, '203.0.113.1');
    assert.equal(logged[0].ok, true);
    assert.equal(logged[0].code, null);
    assert.equal(logged[0].stage, 'liveness_write');
    assert.equal(logged[0].attempt, 1);
    assert.equal(logged[0].elapsedMs, 8123);
    assert.deepEqual(logged[0].attemptsHistory,
      [{ attempt: 1, stage: 'liveness_write', code: null, elapsedMs: 8123, ok: true }]);
  }

  // --- Correction D end to end: a MASKED-RETRY result (attempt 1 fails with
  // a retryable code, attempt 2 recovers) must retain BOTH attempts'
  // summaries in fra-keeper.js's own on-disk log, not just the successful
  // final attempt. -----------------------------------------------------------
  {
    const logged = [];
    await keeper.runHeartbeat('203.0.113.1', 'steady', {
      heartbeatFn: async () => ({
        ok: true, host: '203.0.113.1', peer: '203.0.113.2',
        stage: 'liveness_write', attempt: 2, elapsedMs: 340, secretValuesEmitted: false,
        attemptsHistory: [
          { attempt: 1, stage: 'connect', code: 'REMOTE_BRIDGE_CONNECTION_CLOSED', elapsedMs: 205, ok: false },
          { attempt: 2, stage: 'liveness_write', code: null, elapsedMs: 340, ok: true }
        ]
      }),
      logFn: record => logged.push(record)
    });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].ok, true);
    assert.equal(logged[0].attempt, 2, 'the top-level fields still show only the recovering attempt, unchanged');
    assert.equal(logged[0].attemptsHistory.length, 2,
      'the recovered attempt-1 failure must not be silently dropped from the keeper\'s own log');
    assert.equal(logged[0].attemptsHistory[0].ok, false);
    assert.equal(logged[0].attemptsHistory[0].code, 'REMOTE_BRIDGE_CONNECTION_CLOSED');
    assert.equal(logged[0].attemptsHistory[1].ok, true);
  }

  // --- and on a genuine failed probe (a retryable transport code that also
  // failed the retry -- attempt:2). ---------------------------------------
  {
    const logged = [];
    await keeper.runHeartbeat('203.0.113.1', 'post_start', {
      heartbeatFn: async () => ({
        ok: false, host: '203.0.113.1', peer: '203.0.113.2',
        code: 'REMOTE_BRIDGE_CONNECTION_CLOSED', stage: 'connect', attempt: 2, elapsedMs: 401,
        secretValuesEmitted: false
      }),
      logFn: record => logged.push(record)
    });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].ok, false);
    assert.equal(logged[0].code, 'REMOTE_BRIDGE_CONNECTION_CLOSED');
    assert.equal(logged[0].stage, 'connect');
    assert.equal(logged[0].attempt, 2);
    assert.equal(logged[0].elapsedMs, 401);
  }

  // --- an uncaught throw from heartbeatFn still logs a code, unaffected by
  // the telemetry change (pre-existing behaviour, pinned so it cannot
  // regress). ----------------------------------------------------------------
  {
    const logged = [];
    await keeper.runHeartbeat('203.0.113.1', 'steady', {
      heartbeatFn: async () => { throw Object.assign(new Error('boom'), { code: 'FRA_HEARTBEAT_HOST_INVALID' }); },
      logFn: record => logged.push(record)
    });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].action, 'heartbeat_error');
    assert.equal(logged[0].code, 'FRA_HEARTBEAT_HOST_INVALID');
  }

  // --- a smuggled/extra field on the heartbeat() result must never reach
  // fra-keeper.js's own on-disk log through runHeartbeat() either -- the
  // end-to-end proof, not just sanitizeHeartbeatTelemetry() in isolation. ----
  {
    const logged = [];
    await keeper.runHeartbeat('203.0.113.1', 'steady', {
      heartbeatFn: async () => ({
        ok: true, stage: 'liveness_write', attempt: 1, elapsedMs: 55,
        secretPath: 'C:\\should\\never\\appear', token: 'must-not-leak-0123456789'
      }),
      logFn: record => logged.push(record)
    });
    assert.equal(logged.length, 1);
    const serialized = JSON.stringify(logged[0]);
    assert.equal(serialized.includes('secretPath'), false);
    assert.equal(serialized.includes('token'), false);
    assert.equal(serialized.includes('must-not-leak'), false);
    assert.deepEqual(Object.keys(logged[0]).sort(),
      ['action', 'attempt', 'attemptsHistory', 'code', 'context', 'elapsedMs', 'host', 'ok', 'stage']);
  }

  // --- writeKeeperState(): the dedicated freshness signal that fixes the
  // steady-path gap (the health rung's stateFile went stale indefinitely
  // during any stable healthy stretch, because only the Start action touched
  // it). No dependency injection exists for this one -- it always targets
  // the real KEEPER_STATE_FILE -- so this writes for real and cleans up
  // after itself, restoring whatever was there before (absent, here). -------
  {
    const existedBefore = fs.existsSync(keeper.KEEPER_STATE_FILE);
    const savedBefore = existedBefore ? fs.readFileSync(keeper.KEEPER_STATE_FILE, 'utf8') : null;
    try {
      const beforeWriteMs = Date.now();
      keeper.writeKeeperState({ action: 'steady', host: '203.0.113.1', via: 'EADDRINUSE' });
      const afterWriteMs = Date.now();
      assert.equal(fs.existsSync(keeper.KEEPER_STATE_FILE), true);
      const bytes = fs.readFileSync(keeper.KEEPER_STATE_FILE);
      assert.equal(bytes[0], 0x7b, 'writeFileSync utf8 never emits a BOM -- first byte must be "{" (0x7b)');
      const parsed = JSON.parse(bytes.toString('utf8'));
      assert.equal(parsed.action, 'steady');
      assert.equal(parsed.host, '203.0.113.1');
      assert.equal(typeof parsed.generatedAt, 'string');
      assert.ok(!Number.isNaN(Date.parse(parsed.generatedAt)), 'generatedAt must be a real ISO timestamp');
      assert.equal(new Date(parsed.generatedAt).toISOString(), parsed.generatedAt,
        'generatedAt must use the canonical ISO representation promised by the state-file contract');
      const generatedAtMs = Date.parse(parsed.generatedAt);
      assert.ok(generatedAtMs >= beforeWriteMs && generatedAtMs <= afterWriteMs,
        'generatedAt must describe this write, not merely contain some parseable timestamp');
    } finally {
      if (existedBefore) fs.writeFileSync(keeper.KEEPER_STATE_FILE, savedBefore);
      else { try { fs.unlinkSync(keeper.KEEPER_STATE_FILE); } catch {} }
    }
  }

  console.log('fra-keeper heartbeat-log telemetry retention passed.');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

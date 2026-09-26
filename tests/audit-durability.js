'use strict';

// Audit durability health-signal tests.
//
// These run entirely against a temporary emergency-spool directory and an
// in-memory store. Per STANDING-ORDERS LOCAL-WORK rule 1, nothing here may
// touch the production ledger: the emergency path is redirected by env
// override and the durability sidecar lives beside it.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuditStore } = require('../src/lib/audit-store');
const audit = require('../src/lib/audit');

// Injected so the tests never read or create the real vault signing key.
function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId: `audit-test-${crypto.randomUUID().replace(/-/g, '')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-durability-'));
  return { dir, emergency: path.join(dir, 'audit-emergency.jsonl'), state: path.join(dir, 'audit-durability.json') };
}

function envFor(space) {
  return { TOOLSENABLED_AUDIT_EMERGENCY_PATH: space.emergency };
}

// A store whose write lock fails, so record() takes its spool-and-continue
// path exactly as it does under real contention.
function contendedStore() {
  const real = createAuditStore({ file: ':memory:' });
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'withProjectionLock') {
        return () => { throw new Error('simulated BEGIN IMMEDIATE contention'); };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function testCleanLedgerIsOk() {
  const space = scratch();
  const summary = audit.durability({ env: envFor(space) });
  assert.strictEqual(summary.state, 'ok', 'a ledger with no recorded breach is ok');
  assert.strictEqual(summary.stateFilePresent, false);
  assert.strictEqual(summary.pendingEmergency, 0);
  assert.strictEqual(summary.breachCount, 0);
}

// The core regression: a failed canonical write must still not throw, must
// still spool, and must now leave an observable trace.
function testBreachIsRecordedWithoutChangingRecordBehaviour() {
  const space = scratch();
  const now = 1_700_000_000_000;
  const store = contendedStore();
  const errors = [];
  const status = audit.record('test.action', 'test-target', { note: 'x' }, {
    store, signer: testSigner(), env: envFor(space), clock: () => now, reportError: message => errors.push(message)
  });

  assert.strictEqual(status.ok, false, 'a failed canonical write is still reported as not ok');
  assert.strictEqual(status.durable, false, 'a failed canonical write is not durable');
  assert.strictEqual(status.pending, 1, 'the event was spooled to emergency storage');
  assert.ok(fs.existsSync(space.emergency), 'the emergency spool file exists');
  assert.ok(errors.some(message => /canonical audit failed/.test(message)), 'the stderr diagnostic is unchanged');

  const state = audit.readDurabilityState({ emergency: space.emergency });
  assert.strictEqual(state.readable, true);
  assert.strictEqual(state.breaches.length, 1, 'the breach was remembered');
  assert.strictEqual(state.breaches[0].atMs, now);
  assert.strictEqual(state.breaches[0].action, 'test.action');
  assert.strictEqual(state.breaches[0].spooled, true);
}

// The failure mode that went unnoticed: breaches scattered across hours, each
// one recovered within seconds, so spool depth reads zero almost always.
function testScatteredBreachesSurfaceAsOneLongWindow() {
  const space = scratch();
  const start = 1_700_000_000_000;
  const store = contendedStore();
  for (let index = 0; index < 12; index += 1) {
    const at = start + index * 25 * 60 * 1000; // 25 minutes apart, ~4h35m total
    audit.record('test.action', 'test-target', {}, {
      store, signer: testSigner(), env: envFor(space), clock: () => at, reportError: () => {}
    });
  }
  // Drain the spool so an instantaneous probe would look perfectly healthy.
  fs.rmSync(space.emergency);

  const at = start + 12 * 25 * 60 * 1000;
  const summary = audit.durability({ env: envFor(space), clock: () => at });
  assert.strictEqual(summary.pendingEmergency, 0, 'nothing is spooled at this instant');
  assert.strictEqual(summary.state, 'critical', 'a multi-hour non-durable window is critical even with an empty spool');
  assert.strictEqual(summary.breachCount, 12);
  assert.strictEqual(summary.windows.length, 1, 'scattered breaches collapse into one window');
  assert.strictEqual(summary.windows[0].count, 12);
  assert.ok(summary.windows[0].durationMs >= 4 * 60 * 60 * 1000, 'the window spans the whole degraded period');
  assert.ok(summary.reasons.some(reason => /non-durable audit write/.test(reason)));
}

function testUnreadableStateIsUnknownNotOk() {
  const space = scratch();
  fs.writeFileSync(space.state, 'this is not json', 'utf8');
  const summary = audit.durability({ env: envFor(space) });
  assert.strictEqual(summary.state, 'unknown', 'an unreadable state file is unknown, never ok');
  assert.notStrictEqual(summary.state, 'ok');
  assert.strictEqual(summary.stateReadable, false);
  assert.ok(summary.reasons.some(reason => /could not be read/.test(reason)));
}

function testMissingStateIsDifferentFromStateWhoseAbsenceCouldNotBeEstablished() {
  const space = scratch();
  const missing = audit.readDurabilityState({ emergency: space.emergency });
  assert.deepStrictEqual(
    { present: missing.present, readable: missing.readable },
    { present: false, readable: true },
    'a successful absence check establishes that no durability state exists'
  );

  const unreadable = audit.readDurabilityState({ emergency: space.emergency }, {
    fs: {
      existsSync() { return true; },
      readFileSync() {
        const error = new Error('simulated access denial');
        error.code = 'EACCES';
        throw error;
      }
    }
  });
  assert.deepStrictEqual(
    { present: unreadable.present, readable: unreadable.readable },
    { present: true, readable: false },
    'a failed read says the state could not be established, not that it is absent'
  );
  assert.match(unreadable.reason, /simulated access denial/);
}

function testStillSpooledIsCritical() {
  const space = scratch();
  const now = 1_700_000_000_000;
  const store = contendedStore();
  audit.record('test.action', 'test-target', {}, {
    store, signer: testSigner(), env: envFor(space), clock: () => now, reportError: () => {}
  });
  const summary = audit.durability({ env: envFor(space), clock: () => now });
  assert.strictEqual(summary.pendingEmergency, 1);
  assert.strictEqual(summary.state, 'critical', 'an event sitting in the spool is critical');
  assert.ok(summary.reasons.some(reason => /not in the canonical chain/.test(reason)));
}

function testWindowClustering() {
  const hour = 60 * 60 * 1000;
  const windows = audit.durabilityWindows([
    { atMs: 0 }, { atMs: 10 * 60 * 1000 }, { atMs: 20 * 60 * 1000 },
    { atMs: 5 * hour }
  ]);
  assert.strictEqual(windows.length, 2, 'a gap beyond the cluster interval starts a new window');
  assert.strictEqual(windows[0].count, 3);
  assert.strictEqual(windows[0].durationMs, 20 * 60 * 1000);
  assert.strictEqual(windows[1].count, 1);
}

const tests = [
  testCleanLedgerIsOk,
  testBreachIsRecordedWithoutChangingRecordBehaviour,
  testScatteredBreachesSurfaceAsOneLongWindow,
  testUnreadableStateIsUnknownNotOk,
  testMissingStateIsDifferentFromStateWhoseAbsenceCouldNotBeEstablished,
  testStillSpooledIsCritical,
  testWindowClustering
];

for (const test of tests) {
  audit.resetForTests();
  test();
}
console.log(`Audit durability health-signal tests passed (${tests.length} cases).`);

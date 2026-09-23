'use strict';

// A REFUSAL THAT NAMES A FACT AND NO ACTION IS NOT A REFUSAL A CALLER CAN ACT ON.
//
// Evidence, this installation, capability/logs/actions.jsonl (2026-08-30 to
// 2026-09-03): 55 recorded tool failures whose entire caller-visible reason
// was the single string
//
//   "Durable audit intent could not be recorded; the external mutation was not started."
//
// Every one of those records carried `error` and nothing else -- no reason, no
// sink, no cause -- because the tool failure path stores only `error.message`.
// The classification that unavailableDetails() computes never reached anyone,
// so a full disk, a locked file, a diverged projection and a poisoned head
// anchor all read as the same sentence, which is exactly the outcome the
// comment above primaryFailure() in src/lib/audit.js claims is prevented.
//
// These checks assert the BEHAVIOUR of the sentence a caller receives:
//   - it names the specific failure classification;
//   - it names an action the caller can take, by tool name;
//   - two different underlying faults do not produce the same sentence;
//   - the disabled-ledger refusal names the setting to change, and does NOT
//     send the caller to a health tool that would report nothing wrong;
//   - none of this drops `details.reason`, which machine readers assert on.
//
// Nothing here touches the production ledger, vault, or anchor: every store,
// signer, anchor and path is injected into a scratch temp directory, the same
// way tests/audit-error-classification.test.js does it.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AuditStoreError, createAuditStore } = require('../src/lib/audit-store');
const audit = require('../src/lib/audit');

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId: `audit-test-${crypto.randomUUID().replace(/-/g, '')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-refusal-sentence-'));
  return {
    dir,
    jsonl: path.join(dir, 'actions.jsonl'),
    text: path.join(dir, 'actions.log'),
    emergency: path.join(dir, 'audit-emergency.jsonl')
  };
}

function memoryAnchor() {
  let value = null;
  return { get: () => value, set(next) { value = next; } };
}

function dependencies(space, extra = {}) {
  return {
    signer: testSigner(),
    env: {
      TOOLSENABLED_AUDIT_JSONL_PATH: space.jsonl,
      TOOLSENABLED_AUDIT_TEXT_PATH: space.text,
      TOOLSENABLED_AUDIT_EMERGENCY_PATH: space.emergency
    },
    rootPath: value => path.join(space.dir, value),
    anchorStore: memoryAnchor(),
    reportError: () => {},
    ...extra
  };
}

function failingStore(error) {
  const real = createAuditStore({ file: ':memory:' });
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'withProjectionLock') return () => { throw error; };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function storeFailure(code, message, details) {
  const driver = new Error('underlying driver failure');
  driver.code = code;
  return new AuditStoreError(code, message, details, { cause: driver });
}

function refusalFor(deps, action) {
  let thrown = null;
  try { audit.requireRecord(action, 'probe-target', {}, deps); }
  catch (error) { thrown = error; }
  assert.ok(thrown, `requireRecord must refuse for ${action}`);
  return thrown;
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

// host.read_file/list_dir and code lookups require durable admission too.
// The shared refusal must describe them without claiming an external mutation.
check('local reads receive a refusal that does not misclassify their effect', () => {
  for (const status of [
    { disabled: true },
    { durable: false },
    { durable: true, anchored: false },
  ]) {
    assert.throws(() => audit.requireDurableStatus(status), error => {
      assert.match(error.message, /operation requiring this record cannot proceed/);
      assert.doesNotMatch(error.message, /external mutation|allow external writes|every external write/);
      return error.code === (status.disabled ? 'AUDIT_DISABLED' : 'AUDIT_UNAVAILABLE');
    });
  }
});

// 1. The sentence must name the classification, not only the symptom.
check('the refusal sentence names the specific failure that caused it', () => {
  const space = scratch();
  const deps = dependencies(space, {
    store: failingStore(storeFailure('AUDIT_SQLITE_ERROR', 'The audit ledger rejected a transaction.', { sqliteCode: 'SQLITE_FULL' }))
  });

  const thrown = refusalFor(deps, 'probe.full-disk');
  assert.strictEqual(thrown.code, 'AUDIT_UNAVAILABLE', 'the refusal contract code must not change');
  assert.ok(thrown.message.includes('AUDIT_SQLITE_ERROR'),
    `the caller-visible sentence must name the classification; got: ${thrown.message}`);
});

// 2. The sentence must name an action, by tool name. A caller who is told only
//    that a write did not happen has nothing to do next.
check('the refusal sentence names the tool that reports which sink failed', () => {
  const space = scratch();
  const deps = dependencies(space, {
    store: failingStore(storeFailure('AUDIT_SQLITE_ERROR', 'The audit ledger rejected a transaction.', { sqliteCode: 'SQLITE_FULL' }))
  });

  const thrown = refusalFor(deps, 'probe.action');
  assert.ok(thrown.message.includes('audit.status'),
    `the sentence must name the tool to run; got: ${thrown.message}`);
  assert.ok(/repair/i.test(thrown.message),
    `the sentence must say what to do with what that tool reports; got: ${thrown.message}`);
});

// 3. Two different faults must not produce the same sentence. This is the
//    property the module comment claims and the live log disproved.
check('two different underlying faults produce two different sentences', () => {
  const full = refusalFor(dependencies(scratch(), {
    store: failingStore(storeFailure('AUDIT_SQLITE_ERROR', 'The audit ledger rejected a transaction.', { sqliteCode: 'SQLITE_FULL' }))
  }), 'probe.disk');

  const anchor = refusalFor(dependencies(scratch(), {
    store: failingStore(storeFailure('AUDIT_ANCHOR_INVALID', 'The monotonic head anchor is invalid.', { anchor: 'poisoned' }))
  }), 'probe.anchor');

  assert.notStrictEqual(full.message, anchor.message,
    'a full disk and a poisoned anchor must not read as the same sentence');
  assert.ok(anchor.message.includes('AUDIT_ANCHOR_INVALID'),
    `the anchor refusal must name its own classification; got: ${anchor.message}`);
});

// 4. The classification must still ride in details for machine readers.
check('details.reason survives alongside the composed sentence', () => {
  const thrown = refusalFor(dependencies(scratch(), {
    store: failingStore(storeFailure('AUDIT_SQLITE_ERROR', 'The audit ledger rejected a transaction.', { sqliteCode: 'SQLITE_FULL' }))
  }), 'probe.details');

  assert.strictEqual(thrown.details.reason, 'AUDIT_SQLITE_ERROR',
    'machine readers assert on details.reason; composing the sentence must not remove it');
  assert.strictEqual(thrown.details.reasonDetails.sqliteCode, 'SQLITE_FULL');
});

// 5. A disabled ledger is a setting, not a fault. Its sentence must name the
//    setting -- and must not send the caller to a health tool that will
//    truthfully report nothing wrong.
check('the disabled-ledger refusal names the setting to change', () => {
  const space = scratch();
  const deps = dependencies(space, { loadPolicy: () => ({ audit: { enabled: false } }) });

  let thrown = null;
  try { audit.requireRecord('probe.disabled', 'probe-target', {}, deps); }
  catch (error) { thrown = error; }

  assert.ok(thrown, 'a disabled ledger must still refuse an external write');
  assert.strictEqual(thrown.code, 'AUDIT_DISABLED', 'the disabled contract code must not change');
  assert.ok(thrown.message.includes('toolsenabled.policy.json'),
    `the sentence must name the file that holds the setting; got: ${thrown.message}`);
  assert.ok(thrown.message.includes('enabled'),
    `the sentence must name the setting; got: ${thrown.message}`);
  assert.ok(!thrown.message.includes('audit.status'),
    'a deliberate setting must not be reported as a sink to repair');
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok   - ${name}`); }
  catch (error) { failed++; console.log(`FAIL - ${name}\n  ${error && error.message}`); }
}
if (failed) {
  console.log(`audit-refusal-sentence-names-action: ${failed} of ${checks.length} checks failed`);
  process.exitCode = 1;
} else {
  console.log(`audit-refusal-sentence-names-action: ${checks.length}/${checks.length} checks passed`);
}

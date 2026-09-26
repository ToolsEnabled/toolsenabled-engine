'use strict';

// Regression tests: rendering an audit event for a projection must be TOTAL.
// It must never throw, because a projection line that throws does not lose one
// line -- it wedges that sink forever.
//
// This is not hypothetical. On 2026-08-10 the live installation's text
// projection was stuck at sequence 19573 with a 1197-event backlog, and
// audit.flush({ force: true }) failed every time with the bare message
// "Cannot read properties of undefined (reading 'slice')". The cause:
//
//   redact(value) -> scrub(undefined) returns undefined
//                 -> JSON.stringify(undefined) returns undefined, NOT a string
//                 -> .slice(0, 4000) throws
//
// projectionLine() calls redact() on `target`, and five events above the sink
// cursor had NO target at all -- written by lanes that called record() with a
// single object argument, so `action` received the object and `target` received
// nothing. The ledger accepted those events (they are validly signed and
// chained), but its own text projection could not render them, so the sink
// could never advance past sequence 19985.
//
// That mattered far beyond tidiness: the diverged projection is what
// requireRecord() hits first, so every external-write MCP tool in the product
// stayed refused until this was fixed.
//
// Per STANDING-ORDERS LOCAL-WORK rule 1, nothing here touches the production
// ledger or the production vault: the store is in-memory, the signer is
// generated per test, the anchor is an in-memory stand-in, and every file path
// is redirected into a scratch temp directory.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuditStore } = require('../src/lib/audit-store');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-projection-total-'));
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
    store: createAuditStore({ file: ':memory:' }),
    ...extra
  };
}

// THE CORE CASE, reproducing the live wedge exactly: an event with no target.
function testAnEventWithNoTargetStillProjects() {
  const space = scratch();
  const deps = dependencies(space);

  audit.record('probe.no-target', undefined, { note: 'target omitted by the caller' }, deps);
  const result = audit.flush({ force: true, ...deps });

  assert.deepStrictEqual(result.errors, [],
    'an event without a target must not fail the projection');
  assert.strictEqual(result.projected, true,
    'the projection must complete; a sink that cannot render one event is wedged forever');
  assert.strictEqual(result.pending, 0, 'no backlog may remain');

  const text = fs.readFileSync(space.text, 'utf8');
  assert.match(text, /probe\.no-target/, 'the event must actually appear in the text projection');
  const jsonl = fs.readFileSync(space.jsonl, 'utf8');
  assert.match(jsonl, /probe\.no-target/, 'the event must actually appear in the jsonl projection');
}

// The same defect reached through the whole record path, and the property that
// actually matters to the product: writes keep being admitted afterwards.
function testTheSinkStillAdvancesAfterATargetlessEvent() {
  const space = scratch();
  const deps = dependencies(space);

  audit.record('probe.before', 'probe-target', {}, deps);
  audit.record('probe.no-target', undefined, {}, deps);
  audit.record('probe.after', 'probe-target', {}, deps);
  const result = audit.flush({ force: true, ...deps });

  assert.strictEqual(result.projected, true, 'the sink must advance past a targetless event');
  const text = fs.readFileSync(space.text, 'utf8');
  assert.match(text, /probe\.after/,
    'events recorded AFTER a targetless one must still reach the projection');
}

// redact() is used well beyond projections, so prove the totality directly
// rather than only through its most visible symptom.
function testRedactIsTotalForEveryValueShape() {
  const space = scratch();
  const deps = dependencies(space);
  // details values that scrub() returns as non-strings, including the
  // undefined that JSON.stringify cannot encode.
  const cases = { missing: undefined, nothing: null, flag: true, count: 7, nested: { a: undefined } };
  audit.record('probe.shapes', 'probe-target', cases, deps);
  const result = audit.flush({ force: true, ...deps });
  assert.strictEqual(result.projected, true, 'no value shape may make a projection throw');
}

const tests = [
  testAnEventWithNoTargetStillProjects,
  testTheSinkStillAdvancesAfterATargetlessEvent,
  testRedactIsTotalForEveryValueShape
];

for (const test of tests) {
  audit.resetForTests();
  test();
}
console.log(`Audit projection total-render tests passed (${tests.length} cases).`);

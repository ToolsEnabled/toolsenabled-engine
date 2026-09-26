'use strict';
/* A SIGNING-KEY REFUSAL MUST NAME ITS OWN CAUSE.
 *
 * MEASURED, the 1.0.45 cut of 2026-09-16: a settings batch failed with thirty
 * identical {"ok":false,"code":"AUDIT_UNAVAILABLE"} entries and exactly one
 * diagnostic line -- "ToolsEnabled canonical audit failed for a batch of 30:
 * The audit signing key could not be initialized in this operating-system
 * identity or vault context." That sentence is audit.js's own fixed prose.
 * keyMaterial()'s create path caught the vault call's error with a bare
 * `catch {}` and its read path caught into `error` and never used it, so the
 * one fact that could have diagnosed the cut was destroyed one frame from
 * where it was raised.
 *
 * These tests inject dependencies.getSecret / dependencies.getOrCreateSecret
 * that throw a distinctive reason and assert, by calling the exported surface
 * with values, that (a) the refusal still carries code
 * AUDIT_SIGNING_KEY_UNAVAILABLE and (b) the injected reason is still reachable
 * from the thrown error. Nothing here pins the spelling of the refusal
 * sentence, the separator, or where the cause is attached: the reason may
 * arrive in the message, in an `Error.cause` chain, or in both, and any of
 * those passes. A better implementation than the current one must not go red.
 *
 * SECRETS: no secret value appears in this file. The injected reasons are
 * fixed non-credential prose, and the assertions search for THAT prose. The
 * key material audit.js generates never leaves audit.js.
 *
 *   node --test tests/audit-signing-key-cause.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

// Distinctive enough that it cannot collide with any fixed prose in audit.js
// or in the vault accessors, and plainly not a credential.
const READ_REASON = 'vault read refused by identity gamma-seven for this ledger';
const CREATE_REASON = 'vault initialization refused by identity gamma-seven for this ledger';

function harness(label, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `te-audit-key-cause-${label}-`));
  const store = createAuditStore({ file: path.join(dir, 'audit.sqlite3'), clock: () => 1000 });
  const reports = [];
  let nextId = 0;
  const dependencies = {
    store,
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(dir, value),
    env: {},
    eventIdFactory: () => `audit-key-cause-${String(++nextId).padStart(8, '0')}`,
    clock: () => 1000 + nextId,
    reportError: message => reports.push(message),
    anchorStore: (() => { let value = null; return { get: () => value, set(next) { value = next; } }; })(),
    ...overrides
  };
  return {
    dir, store, dependencies, reports,
    close() { try { store.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  };
}

function throwing(reason, code) {
  return () => {
    const error = new Error(reason);
    if (code) error.code = code;
    throw error;
  };
}

// The reason is "reachable" if a person holding the thrown error can read it
// without knowing how this module chose to attach it. Both routes count, and
// a future implementation that uses only one of them still passes.
function reachableText(error) {
  const parts = [];
  const seen = new Set();
  let cursor = error;
  while (cursor && !seen.has(cursor) && parts.length < 10) {
    seen.add(cursor);
    parts.push(typeof cursor.message === 'string' ? cursor.message : String(cursor));
    cursor = cursor.cause;
  }
  return parts.join('\n');
}

function capture(run) {
  try { run(); } catch (error) { return error; }
  return null;
}

test('the read-path signing-key refusal keeps its code and carries the vault reason', () => {
  audit.resetForTests();
  const harnessed = harness('read');
  try {
    const thrown = capture(() => audit.status({
      ...harnessed.dependencies,
      signer: undefined,
      getSecret: throwing(READ_REASON, 'SECRET_VAULT_UNREADABLE'),
      getOrCreateSecret: throwing('a replacement key must never be minted for an unreadable vault')
    }));
    assert.ok(thrown, 'an unreadable signing key must refuse rather than return a status');
    assert.equal(thrown.code, 'AUDIT_SIGNING_KEY_UNAVAILABLE');
    assert.ok(reachableText(thrown).includes(READ_REASON),
      `the injected vault reason must survive to the caller; got: ${reachableText(thrown)}`);
  } finally { harnessed.close(); }
});

test('the create-path signing-key refusal keeps its code and carries the vault reason', () => {
  audit.resetForTests();
  const harnessed = harness('create');
  try {
    const thrown = capture(() => audit.status({
      ...harnessed.dependencies,
      signer: undefined,
      getSecret: throwing('not configured', 'SECRET_NOT_CONFIGURED'),
      getOrCreateSecret: throwing(CREATE_REASON)
    }));
    assert.ok(thrown, 'a vault that cannot store a new signing key must refuse');
    assert.equal(thrown.code, 'AUDIT_SIGNING_KEY_UNAVAILABLE');
    assert.ok(reachableText(thrown).includes(CREATE_REASON),
      `the injected vault reason must survive to the caller; got: ${reachableText(thrown)}`);
  } finally { harnessed.close(); }
});

// The measured defect, at the exact sink that produced it: recordBatch's
// diagnostic goes through safeError(error), which reads error.message alone.
// A cause that never reaches the message would leave this line as
// undiagnosable as the cut4 line was.
test('the batch diagnostic line names the vault reason instead of fixed prose alone', () => {
  audit.resetForTests();
  const harnessed = harness('batch');
  try {
    audit.recordBatch(
      [{ action: 'first.event', target: 'safe-target', details: {} },
        { action: 'second.event', target: 'safe-target', details: {} }],
      {
        ...harnessed.dependencies,
        signer: undefined,
        getSecret: throwing('not configured', 'SECRET_NOT_CONFIGURED'),
        getOrCreateSecret: throwing(CREATE_REASON)
      }
    );
    const joined = harnessed.reports.join('\n');
    assert.ok(/canonical audit failed for a batch/i.test(joined),
      `the batch failure must still be reported; got: ${joined}`);
    assert.ok(joined.includes(CREATE_REASON),
      `the reported batch failure must name the vault reason; got: ${joined}`);
  } finally { harnessed.close(); }
});

// An arbitrarily long reason must not become an unbounded message. The bound
// itself is the implementation's choice; this only requires that SOME bound
// exists and that the message still opens with what the vault actually said.
test('an oversized vault reason is bounded but still recognisable', () => {
  audit.resetForTests();
  const harnessed = harness('bounded');
  try {
    const oversized = `${CREATE_REASON} ${'d'.repeat(50000)}`;
    const thrown = capture(() => audit.status({
      ...harnessed.dependencies,
      signer: undefined,
      getSecret: throwing('not configured', 'SECRET_NOT_CONFIGURED'),
      getOrCreateSecret: throwing(oversized)
    }));
    assert.ok(thrown, 'a vault that cannot store a new signing key must refuse');
    assert.equal(thrown.code, 'AUDIT_SIGNING_KEY_UNAVAILABLE');
    assert.ok(thrown.message.includes(CREATE_REASON),
      `the refusal message must open with what the vault said; got: ${thrown.message.slice(0, 400)}`);
    assert.ok(thrown.message.length < 10000,
      `the refusal message must be bounded; it was ${thrown.message.length} characters`);
  } finally { harnessed.close(); }
});

// "There was no underlying failure" and "there was one and it could not be
// described" are different answers. `throw` accepts any value, so a cause can
// render to nothing; if that silently produced the fixed sentence alone, the
// refusal would be indistinguishable from the defect this change removed.
//
// The fixed part of the sentence is DERIVED here, as the common prefix of two
// refusals from the same path, rather than written down. So these cases pin no
// spelling of the sentence, the connector, or the words used for an
// undescribable cause -- only that something is added.
function commonPrefixLength(first, second) {
  let index = 0;
  while (index < first.length && index < second.length && first[index] === second[index]) index += 1;
  return index;
}

function createPathRefusal(label, thrownValue) {
  audit.resetForTests();
  const harnessed = harness(label);
  try {
    return capture(() => audit.status({
      ...harnessed.dependencies,
      signer: undefined,
      getSecret: throwing('not configured', 'SECRET_NOT_CONFIGURED'),
      getOrCreateSecret: () => { throw thrownValue; }
    }));
  } finally { harnessed.close(); }
}

test('a cause that renders to nothing is still named, not silently dropped', () => {
  const describable = createPathRefusal('describable', new Error(CREATE_REASON));
  for (const [label, thrownValue] of [
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['blank message', new Error('   ')]
  ]) {
    const thrown = createPathRefusal('undescribable', thrownValue);
    assert.ok(thrown, `throwing ${label} from the vault must still refuse`);
    assert.equal(thrown.code, 'AUDIT_SIGNING_KEY_UNAVAILABLE',
      `the refusal code must stay stable when ${label} is thrown`);
    const fixed = commonPrefixLength(thrown.message, describable.message);
    assert.ok(thrown.message.length > fixed,
      `a cause that cannot be described must still add something to the refusal, so a reader can tell it apart `
      + `from a refusal that had no underlying failure at all. Throwing ${label} produced: ${thrown.message}`);
  }
});

test('a cause that cannot be converted to text yields a refusal, not a crash in the handler', () => {
  const describable = createPathRefusal('describable-2', new Error(CREATE_REASON));
  const hostile = { get message() { throw new Error('message getter refuses'); },
    toString() { throw new Error('toString refuses'); } };
  const thrown = createPathRefusal('hostile', hostile);
  assert.ok(thrown, 'a cause that cannot be rendered must still produce a refusal');
  assert.equal(thrown.code, 'AUDIT_SIGNING_KEY_UNAVAILABLE',
    `the refusal code must survive an unrenderable cause; it was ${thrown.code} (${thrown.message})`);
  const fixed = commonPrefixLength(thrown.message, describable.message);
  assert.ok(thrown.message.length > fixed,
    `an unrenderable cause must still be named as one; got: ${thrown.message}`);
});

// A THROWN VALUE'S CONTENT MUST NEVER REACH THE MESSAGE.
//
// `String(x)` is the IDENTITY FUNCTION for a primitive, so a `String(cause)`
// fallback puts a thrown string into the refusal verbatim -- measured, and the
// stand-in below appeared in full at the bytes before this gate existed. An
// object with a custom toString does the same. Nothing in this tree throws a
// raw string today; audit.js now relays child diagnostics, so the first path
// that hands one through would leak on its first run.
//
// The value below is a STAND-IN. It is not a key, is not derived from one, and
// resembles no real credential. It exists only so that a leak is visible, and
// asserting on it is the only way this file ever mentions a "value" at all.
const STANDIN = 'W65STANDIN-NOT-A-REAL-SECRET-7xq2m';

// BOTH HALVES ARE REQUIRED. "The stand-in is absent" alone is a weak
// assertion: a mutation that deleted the whole message would satisfy it. So
// each case also requires the refusal to NAME THE TYPE of what was thrown,
// which is the content-free fact the implementation promises to give.
test('a thrown value that is not an Error is named by type, and its content never reaches the message', () => {
  const hostileToString = { toString() { return STANDIN; } };
  const hostileMessage = { message: { toString() { return STANDIN; } } };
  for (const [label, value] of [
    ['a thrown string', STANDIN],
    ['a thrown object with a toString that returns content', hostileToString],
    ['a thrown object whose message is not a string', hostileMessage],
    ['a thrown Buffer', Buffer.from(STANDIN, 'utf8')]
  ]) {
    const thrown = createPathRefusal('standin', value);
    assert.ok(thrown, `throwing ${label} from the vault must still refuse`);
    assert.equal(thrown.code, 'AUDIT_SIGNING_KEY_UNAVAILABLE',
      `the refusal code must stay stable for ${label}`);

    // Half one: the content is gone. Checked on the whole reachable surface,
    // not just the message, because a cause chain is printed by this module too.
    assert.ok(!reachableText(thrown).includes(STANDIN),
      `${label}: the thrown value's content must not be reachable from the refusal`);

    // Half two: something content-free was still said, and it is the TYPE.
    const kind = value === null ? 'null' : typeof value;
    assert.ok(thrown.message.includes(kind),
      `${label}: the refusal must name the type of what was thrown (expected the word ${kind}); got: ${thrown.message}`);
  }
});

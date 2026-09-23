// NOTHING FOUND
//
// Discriminating-assertion audit (2026-08-26):
//   1. NOT-FOUND -- both loops iterate over non-empty array literals; no
//      assertion is hidden behind a product-provided collection.
//   2. NOT-FOUND -- this file neither spawns a process nor treats an exit
//      status or a truthy return value as evidence.
//   3. NOT-FOUND -- each caught error is immediately required by assert.ok;
//      there is no optional chain or catch that permits the subject to pass.
//   4. NOT-FOUND -- the injected store only creates the initiating fault; all
//      asserted classification, propagation, persistence, and redaction are
//      outputs of the real audit module.
//   5. NOT-FOUND -- there are no skips or platform precondition guards.
//   6. NOT-FOUND -- expected codes, messages, redactions, and booleans are
//      independent literals rather than values computed by the subject.
//
// Mutation precondition not met: the available Node.js is v20.20.2, which
// lacks node:sqlite. The unmodified baseline therefore stops while opening
// the first in-memory store with ERR_UNKNOWN_BUILTIN_MODULE before any test
// assertion executes. Attempting to obtain the declared Node >=22.19.0 with
// `npx --yes node@22.19.0` was rejected by the package registry (HTTP 403).
// Consequently no trustworthy GREEN baseline or RED mutation output can be
// quoted, and no assertion was changed without the required mutation proof.

'use strict';

// Regression tests: an audit refusal must say WHICH failure it was.
//
// src/lib/audit-store.js raises failures that carry three separate pieces of
// evidence -- a mechanical `code`, a structured `details` object, and the
// original error as `cause`. Before this fix every one of those was thrown
// away at the audit.js boundary: `status.errors` entries were built by hand
// as `{ sink, message }`, so an operator whose external write had just been
// refused read "The audit ledger rejected a transaction." and could not tell
// a poisoned head anchor from a locked projection file from a full disk.
//
// That is not hypothetical. On 2026-08-10 the live installation refused every
// external write, and the refusal that reached the caller was the generic
// transaction-rejection sentence; the actual failure was a diverged audit
// projection (sink cursor 19573 against 19577 projected lines), with a
// poisoned monotonic head anchor underneath it. Nothing about either was
// visible from the error.
//
// These tests assert the fixed behaviour:
//   - a store-level failure's code, structured details and cause chain all
//     reach the caller through status.errors AND through AuditRequiredError;
//   - a projection divergence is classified as such, not as a SQLite-shaped
//     transaction rejection;
//   - none of that widens the surface: credential-shaped keys and
//     token-shaped values in a failure's details or message stay redacted,
//     via the module's existing scrub()/redact() mechanism.
//
// Per STANDING-ORDERS LOCAL-WORK rule 1, nothing here touches the production
// ledger or the production vault: every store, signer, anchor and file path
// below is injected or redirected into a scratch temp directory, exactly as
// tests/audit-spool-ingestion.test.js and tests/kernel.audit/audit-reliability.js do.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuditStoreError, createAuditStore } = require('../src/lib/audit-store');
const audit = require('../src/lib/audit');

// Injected so these tests never read or create the real vault signing key.
function testSigner(seed = 'default') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId: `audit-test-${seed}-${crypto.randomUUID().replace(/-/g, '')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-error-classification-'));
  return {
    dir,
    jsonl: path.join(dir, 'actions.jsonl'),
    text: path.join(dir, 'actions.log'),
    emergency: path.join(dir, 'audit-emergency.jsonl')
  };
}

// Overriding rootPath as well as the explicit env paths keeps every audit
// file these tests touch inside the scratch directory, even for a call site
// that resolves a default-relative path against the repo root.
function pathsFor(space) {
  return {
    env: {
      TOOLSENABLED_AUDIT_JSONL_PATH: space.jsonl,
      TOOLSENABLED_AUDIT_TEXT_PATH: space.text,
      TOOLSENABLED_AUDIT_EMERGENCY_PATH: space.emergency
    },
    rootPath: value => path.join(space.dir, value)
  };
}

// The protected head anchor is vault-backed in production (HEAD_VAULT_KEY);
// this in-memory stand-in keeps these tests off the real vault secret.
function memoryAnchor() {
  let value = null;
  return { get: () => value, set(next) { value = next; } };
}

function freshStore() {
  return createAuditStore({ file: ':memory:' });
}

function dependencies(space, extra = {}) {
  return {
    signer: testSigner(),
    ...pathsFor(space),
    anchorStore: memoryAnchor(),
    reportError: () => {},
    ...extra
  };
}

// A store whose single write lock fails with a fully-classified store error:
// a mechanical code, structured details, and the underlying driver error as
// `cause` -- exactly the shape audit-store.js's _transaction() produces for a
// real SQLite fault.
function failingStore(error) {
  const real = freshStore();
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'withProjectionLock') return () => { throw error; };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function sqliteFullFailure(details = { sqliteCode: 'SQLITE_FULL' }) {
  const driver = new Error('database or disk is full');
  driver.code = 'SQLITE_FULL';
  return new AuditStoreError(
    'AUDIT_SQLITE_ERROR', 'The audit ledger rejected a transaction.', details, { cause: driver }
  );
}

// THE CORE CASE. Plant a store-level failure and require that the caller can
// see the specific code, the structured details, and the cause chain.
function testStoreFailureCodeReachesTheCaller() {
  const space = scratch();
  const store = failingStore(sqliteFullFailure());

  let thrown = null;
  try { audit.requireRecord('probe.classified', 'probe-target', {}, dependencies(space, { store })); }
  catch (error) { thrown = error; }

  assert.ok(thrown, 'requireRecord must refuse when the audit ledger cannot be written');
  assert.ok(thrown instanceof audit.AuditRequiredError);
  assert.strictEqual(thrown.code, 'AUDIT_UNAVAILABLE', 'the refusal contract code must not change');

  // status.errors must carry the classification, not just a sentence.
  const canonical = (thrown.details.errors || []).find(entry => entry.sink === 'canonical');
  assert.ok(canonical, 'the canonical sink failure must be reported');
  assert.strictEqual(canonical.code, 'AUDIT_SQLITE_ERROR',
    'status.errors must preserve the store-level error code, not drop it');
  assert.ok(canonical.details, 'status.errors must preserve the structured details');
  assert.strictEqual(canonical.details.sqliteCode, 'SQLITE_FULL',
    'the operator must be able to tell a full disk from a locked file');
  assert.ok(Array.isArray(canonical.cause) && canonical.cause.length >= 1,
    'status.errors must preserve the cause chain');
  assert.match(canonical.cause[0].message, /disk is full/,
    'the original driver failure must survive to the caller');
  assert.strictEqual(canonical.cause[0].code, 'SQLITE_FULL');

  // AuditRequiredError itself must be classifiable without walking the list.
  assert.strictEqual(thrown.details.reason, 'AUDIT_SQLITE_ERROR',
    'AuditRequiredError must name the specific failure that caused the refusal');
  assert.strictEqual(thrown.details.reasonDetails.sqliteCode, 'SQLITE_FULL');
  assert.ok(Array.isArray(thrown.details.cause) && thrown.details.cause.length >= 1,
    'AuditRequiredError must carry the cause chain');
}

// The plain, non-required writer degrades to spool-and-continue rather than
// throwing, so its status object is the ONLY place the classification can
// appear. It must appear there too.
function testRecordStatusCarriesClassification() {
  const space = scratch();
  const store = failingStore(sqliteFullFailure());

  const status = audit.record('probe.status', 'probe-target', {}, dependencies(space, { store }));
  assert.strictEqual(status.durable, false);
  const canonical = status.errors.find(entry => entry.sink === 'canonical');
  assert.strictEqual(canonical.code, 'AUDIT_SQLITE_ERROR');
  assert.strictEqual(canonical.details.sqliteCode, 'SQLITE_FULL');
  assert.strictEqual(canonical.cause[0].code, 'SQLITE_FULL');

  // The unsigned durability sidecar is the trace that outlives the spool. On
  // the live installation it held 200 consecutive breaches whose message was
  // "The audit ledger rejected a transaction." and nothing else -- a durable
  // record of a failure nobody could classify. It must carry the code too.
  const durability = audit.readDurabilityState({ emergency: space.emergency });
  assert.strictEqual(durability.readable, true);
  assert.strictEqual(durability.breaches[durability.breaches.length - 1].code, 'AUDIT_SQLITE_ERROR',
    'the durability sidecar must persist which failure it was, not only a sentence');
}

// THE LIVE CASE. A diverged projection is not a SQLite fault and must not be
// reported as one: audit.js raises its own integrity refusals from inside a
// store transaction, and an untagged one gets relabelled AUDIT_SQLITE_ERROR
// by the transaction wrapper -- which is precisely how the 2026-08-10 outage
// read as database contention that was never happening.
function testProjectionDivergenceIsNotReportedAsASqliteFault() {
  const space = scratch();
  const store = freshStore();
  const deps = dependencies(space, { store });

  const seeded = audit.record('probe.seed', 'probe-target', {}, deps);
  assert.strictEqual(seeded.durable, true, 'the isolated ledger must accept a first event');
  assert.strictEqual(seeded.projected, true, 'the isolated projection must be written');

  // A well-formed but unbacked projection line: it parses, so this is a
  // divergence, not an unreadable file.
  fs.appendFileSync(space.jsonl,
    `${JSON.stringify({ sequence: 9999, eventHash: 'a'.repeat(64) })}\n`, 'utf8');

  let thrown = null;
  try { audit.requireRecord('probe.after-divergence', 'probe-target', {}, deps); }
  catch (error) { thrown = error; }

  assert.ok(thrown, 'a diverged projection must fail the write closed');
  assert.strictEqual(thrown.code, 'AUDIT_UNAVAILABLE');
  assert.strictEqual(thrown.details.reason, 'AUDIT_PROJECTION_DIVERGED',
    'a projection divergence must be classified as one, not as a transaction rejection');
  const messages = (thrown.details.errors || []).map(entry => entry.message).join(' | ');
  assert.doesNotMatch(messages, /rejected a transaction/i,
    'the projection divergence must not be relabelled as a generic SQLite transaction failure');
  assert.match(messages, /projection diverged/i,
    'the operator must be told the projection diverged');
}

// The classification must never become a payload channel. Credential-shaped
// keys and token-shaped values planted in a failure's details and message
// must arrive redacted, through the module's existing scrub()/redact() path.
function testClassificationNeverWidensCredentialExposure() {
  const space = scratch();
  const secret = 'sk_live_000000000000abcdef';
  const failure = sqliteFullFailure({
    sqliteCode: 'SQLITE_FULL',
    access_token: 'must-not-appear-anywhere',
    note: `authorization=${secret}`
  });
  failure.message = `The audit ledger rejected a transaction (Bearer ${'z'.repeat(40)}).`;
  const store = failingStore(failure);

  let thrown = null;
  try { audit.requireRecord('probe.redaction', 'probe-target', {}, dependencies(space, { store })); }
  catch (error) { thrown = error; }

  assert.ok(thrown);
  const serialized = JSON.stringify(thrown.details);
  assert.doesNotMatch(serialized, /must-not-appear-anywhere/,
    'a credential-shaped detail key must never reach the caller through the classification');
  assert.doesNotMatch(serialized, new RegExp(secret),
    'a provider-token-shaped value must never reach the caller through the classification');
  assert.doesNotMatch(serialized, /Bearer z{12,}/,
    'a bearer token in the failure message must never reach the caller through the classification');
  assert.match(serialized, /REDACTED/, 'the existing redactor must be what removed it');
  // The safe, mechanical parts still survive -- redaction must not become
  // another way of destroying the diagnosis.
  assert.strictEqual(thrown.details.reason, 'AUDIT_SQLITE_ERROR');
  assert.strictEqual(thrown.details.reasonDetails.sqliteCode, 'SQLITE_FULL');
}

// A POISONED HEAD ANCHOR MUST STILL NAME ITSELF FROM INSIDE THE TRANSACTION.
//
// This is the 2026-08-10 shape exactly: a healthy ledger whose protected head
// anchor is then unreadable. It became reachable again on 2026-08-17, when
// verify() was changed to defer anchor reconciliation (it was verifying the
// whole ledger twice) and its first anchor read consequently moved inside
// withProjectionLock. readAnchor's two rejections were bare Errors with no
// code, so preservesClassification() (audit-store.js:315-319) refused them and
// _transaction relabelled both as AUDIT_SQLITE_ERROR / "The audit ledger
// rejected a transaction" -- restoring the precise diagnosis-erasure this file
// exists to prevent. They now carry AUDIT_ANCHOR_MALFORMED / AUDIT_ANCHOR_INVALID.
//
// Deliberately not asserted through a thrown error: verify() reports rather
// than throws, so the check is on what an operator actually reads back.
function testAnchorFaultIsNamedNotRelabelled() {
  for (const [label, poison, shape] of [
    ['unparseable', '{not json', /malformed/i],
    ['parses but is not an anchor', '{"domain":"nope","version":1}', /invalid/i]
  ]) {
    const space = scratch();
    const deps = dependencies(space, { store: freshStore() });

    const seeded = audit.record('probe.seed', 'probe-target', {}, deps);
    assert.strictEqual(seeded.durable, true,
      `the isolated ledger must accept a first event before the anchor is poisoned (${label})`);

    const result = audit.verify({ ...deps, anchorStore: { get: () => poison, set: () => {} } });
    const reported = JSON.stringify(result.error || '');

    assert.strictEqual(result.valid, false, `a poisoned head anchor must fail verification closed (${label})`);
    assert.match(reported, /protected audit head anchor/i,
      `the operator must be told the protected head anchor is the fault, not the ledger (${label}); read back: ${reported}`);
    assert.match(reported, shape,
      `the specific anchor fault must survive the ledger transaction (${label}); read back: ${reported}`);
    assert.doesNotMatch(reported, /rejected a transaction/i,
      `an anchor fault must never be relabelled as a generic SQLite transaction rejection (${label})`);
  }
}

const tests = [
  testStoreFailureCodeReachesTheCaller,
  testRecordStatusCarriesClassification,
  testProjectionDivergenceIsNotReportedAsASqliteFault,
  testClassificationNeverWidensCredentialExposure,
  testAnchorFaultIsNamedNotRelabelled
];

for (const test of tests) {
  audit.resetForTests();
  test();
}
console.log(`Audit error-classification tests passed (${tests.length} cases).`);

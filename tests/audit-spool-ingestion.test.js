'EXECUTABLE CHANGE';
'use strict';

// Discrimination report (testcanfail-tests-audit-spool-ingestion-test-js):
// - STRENGTHENED: the test registry must contain all seven named cases before
//   iteration. Mutation: replaced its seven entries with an empty array. Before
//   this guard the mutation stayed green with "Audit emergency-spool ingestion
//   hardening tests passed (0 cases)." With the guard it is red with
//   "AssertionError [ERR_ASSERTION]: audit spool ingestion must execute all
//   seven cases" and "0 !== 7". After restoring the registry byte-for-byte,
//   the run is green with "Audit emergency-spool ingestion hardening tests
//   passed (7 cases)."
// - NOT-FOUND (2): no exit-status or generic truthy-return assertion is used
//   as a substitute for checking the subject's own output.
// - NOT-FOUND (3): no try/catch or optional chain swallows a subject failure.
// - NOT-FOUND (4): no assertion targets a mock of the behavior under test;
//   injected signers, stores, paths, clock, reporter, and anchor isolate real
//   spool ingestion rather than replace it.
// - NOT-FOUND (5): there is no skip or platform precondition guard.
// - NOT-FOUND (6): no expected assertion value is computed by production code.
//   envelopeFor uses canonicalJson to construct authenticated input, but every
//   expected ledger/quarantine/redaction value is independently literal.
// - PRECONDITION: the default Node.js v20.20.2 lacks node:sqlite; discrimination
//   and restored-green runs therefore used the installed Node.js v22.22.2.

// Regression tests for R1162 Stage 0 audit emergency-spool hardening
// (AUDIT-F-03, CRED-F6, CRED-F7 -- docs/coordinator/R1162-SECCOUNCIL-FINAL-SYNTHESIS.md).
//
// Before this fix, ingestEmergency() treated any well-formed JSON line
// sitting in the emergency-spool file as a trusted, already-scrubbed audit
// event and handed it straight to the canonical signer. Since the spool
// file is ordinary disk content -- anything with write access to its
// directory (a lower-privileged same-user process, a restored backup, a
// hand-edited "recovery" file) can add lines to it -- that made the trusted
// signer a signing oracle for attacker-writable JSON (AUDIT-F-03), and any
// credential-shaped content already in an item's `details` would be
// canonicalized verbatim into the permanent signed ledger (CRED-F7). A
// separate, related gap let a raw caller-supplied action string reach the
// unsigned durability sidecar unsanitized (CRED-F6).
//
// These tests assert the fixed behaviour:
//   - a bare (un-enveloped) spool line is quarantined, never canonicalized;
//   - an envelope with a forged or stale (pre-rotation) mac is quarantined;
//   - the process's own authentic spool write still round-trips normally;
//   - even an authenticated item is re-scrubbed before it becomes permanent;
//   - the durability sidecar never persists a raw, unsanitized action.
//
// Per STANDING-ORDERS LOCAL-WORK rule 1, nothing here may touch the
// production ledger or the production vault: every store, signer, and file
// path below is injected or redirected to a scratch temp directory, exactly
// as tests/audit-durability.js and tests/kernel.audit/audit-reliability.js
// already do.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalJson, createAuditStore } = require('../src/lib/audit-store');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-spool-ingestion-'));
  return { dir, emergency: path.join(dir, 'audit-emergency.jsonl'), state: path.join(dir, 'audit-durability.json') };
}

// Per STANDING-ORDERS LOCAL-WORK rule 1, nothing here may touch the
// production ledger. TOOLSENABLED_AUDIT_EMERGENCY_PATH alone only redirects
// the spool file -- record()/flush() still resolve the canonical jsonl/text
// projection files (and this file's own default-relative emergency path,
// were the env override ever missing from a given call site) against the
// real repo root. Overriding `rootPath` too, exactly as
// tests/kernel.audit/audit-reliability.js's harness() does, keeps every
// audit file this suite touches inside the scratch directory.
function pathsFor(space) {
  return {
    env: { TOOLSENABLED_AUDIT_EMERGENCY_PATH: space.emergency },
    rootPath: value => path.join(space.dir, value)
  };
}

function freshStore() {
  return createAuditStore({ file: ':memory:' });
}

// The protected head anchor is itself vault-backed in production
// (HEAD_VAULT_KEY). Every test here that lets prepare() run far enough to
// reconcile the anchor must supply this in-memory stand-in instead --
// otherwise audit.js falls back to the real getSecret() and would read or
// write the real vault's anchor secret as a side effect of running these
// tests (same technique as tests/kernel.audit/audit-reliability.js's
// memoryAnchor()).
function memoryAnchor() {
  let value = null;
  return {
    get: () => value,
    set(next) { value = next; }
  };
}

// A store whose write lock fails, so record() takes its real
// spool-and-continue path exactly as it does under production contention
// (same technique as tests/audit-durability.js's contendedStore()).
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

// Reproduces src/lib/audit.js's internal spool mac derivation. The
// derivation itself is not exported -- production code never needs to build
// an envelope by hand -- so these adversarial/round-trip tests reconstruct
// it exactly to prove the ingestion side actually enforces what the write
// side actually produces, rather than testing a stand-in.
function deriveMacKey(signer) {
  return crypto.createHash('sha256')
    .update(Buffer.from(signer.sign(Buffer.from('toolsenabled.audit.spool.mac.v1', 'utf8'))))
    .digest();
}

function envelopeFor(item, signer) {
  const mac = crypto.createHmac('sha256', deriveMacKey(signer)).update(canonicalJson(item)).digest('hex');
  return { version: 1, domain: 'toolsenabled.audit.spool.v1', item, mac };
}

function writeSpoolLine(space, record) {
  fs.mkdirSync(space.dir, { recursive: true });
  fs.appendFileSync(space.emergency, `${JSON.stringify(record)}\n`, 'utf8');
}

function actionsIn(store) {
  return store.listEvents({ afterSequence: 0, limit: 100 }).map(event => event.event.action);
}

// AUDIT-F-03: a bare, unauthenticated spool line -- exactly what an
// attacker with only filesystem write access to the spool directory (but no
// access to the trusted signer) can produce -- must never be canonicalized.
function testBareSpoolLineIsQuarantinedNotCanonicalized() {
  const space = scratch();
  const signer = testSigner();
  const store = freshStore();
  writeSpoolLine(space, {
    eventId: 'audit-bare-0000000000000001', occurredAtMs: 1000, createdAtMs: 1000,
    event: { timestamp: new Date(1000).toISOString(), action: 'attacker.bare', target: 'safe', details: {} }
  });

  const result = audit.flush({ force: true }, {
    store, signer, ...pathsFor(space), clock: () => 2000, reportError: () => {}, anchorStore: memoryAnchor()
  });
  assert.strictEqual(result.projected, true);

  const actions = actionsIn(store);
  assert.ok(!actions.includes('attacker.bare'), 'a bare, unauthenticated spool line must never reach the canonical ledger');
  assert.ok(actions.includes('audit.emergency.quarantined'), 'the bare line must be quarantined instead');
  const quarantine = fs.readdirSync(space.dir).find(name => name.startsWith('audit-emergency.jsonl.quarantine-'));
  assert.ok(quarantine, 'the poisoned spool source must be preserved for manual review, not silently dropped');
}

// AUDIT-F-03: an attacker can construct a well-formed envelope shape, but
// only the real vault-trusted signer's key derives a mac that verifies.
function testForgedMacIsQuarantinedNotCanonicalized() {
  const space = scratch();
  const signer = testSigner('trusted');
  const attackerSigner = testSigner('attacker');
  const store = freshStore();
  writeSpoolLine(space, envelopeFor({
    eventId: 'audit-forged-000000000000001', occurredAtMs: 1000, createdAtMs: 1000,
    event: { timestamp: new Date(1000).toISOString(), action: 'attacker.forged', target: 'safe', details: {} }
  }, attackerSigner));

  const result = audit.flush({ force: true }, {
    store, signer, ...pathsFor(space), clock: () => 2000, reportError: () => {}, anchorStore: memoryAnchor()
  });
  assert.strictEqual(result.projected, true);
  const actions = actionsIn(store);
  assert.ok(!actions.includes('attacker.forged'), 'a forged mac must never reach the canonical ledger');
  assert.ok(actions.includes('audit.emergency.quarantined'));
}

// AUDIT-F-03: a mac produced under a signer that is no longer the
// vault-trusted key must not be trusted forever just because it was once
// authentic -- key rotation must invalidate stale spool entries too.
function testRotatedSignerInvalidatesOldSpoolMac() {
  const space = scratch();
  const oldSigner = testSigner('old');
  const newSigner = testSigner('new');
  const store = freshStore();
  writeSpoolLine(space, envelopeFor({
    eventId: 'audit-rotated-0000000000001', occurredAtMs: 1000, createdAtMs: 1000,
    event: { timestamp: new Date(1000).toISOString(), action: 'pre.rotation', target: 'safe', details: {} }
  }, oldSigner));

  const result = audit.flush({ force: true }, {
    store, signer: newSigner, ...pathsFor(space), clock: () => 2000, reportError: () => {}, anchorStore: memoryAnchor()
  });
  assert.strictEqual(result.projected, true);
  const actions = actionsIn(store);
  assert.ok(!actions.includes('pre.rotation'), 'a mac from a since-rotated signer must not verify under the new key');
  assert.ok(actions.includes('audit.emergency.quarantined'));
}

// The fix must not turn the spool into a black hole: an envelope
// authenticated with the current signer still ingests normally, with no
// spurious quarantine noise.
function testAuthenticEnvelopeIsIngestedNormally() {
  const space = scratch();
  const signer = testSigner();
  const store = freshStore();
  writeSpoolLine(space, envelopeFor({
    eventId: 'audit-good-00000000000000001', occurredAtMs: 1000, createdAtMs: 1000,
    event: { timestamp: new Date(1000).toISOString(), action: 'legit.write', target: 'safe', details: { note: 'ok' } }
  }, signer));

  const result = audit.flush({ force: true }, {
    store, signer, ...pathsFor(space), clock: () => 2000, reportError: () => {}, anchorStore: memoryAnchor()
  });
  assert.strictEqual(result.projected, true);
  const events = store.listEvents({ afterSequence: 0, limit: 10 });
  assert.strictEqual(events.length, 1, 'exactly the one authentic event should be ingested, with no quarantine noise');
  assert.strictEqual(events[0].event.action, 'legit.write');
  assert.strictEqual(events[0].event.details.note, 'ok');
}

// End-to-end sanity: record()'s own real spool-and-continue path (taken
// under genuine canonical-store contention) must still produce an envelope
// that this same fixed ingestion path recovers cleanly -- the write side and
// the read side must agree with each other, not just with a hand-built
// fixture.
function testRecordsOwnSpoolWriteIngestsOnRecovery() {
  const space = scratch();
  const signer = testSigner();
  const contended = contendedStore();
  const first = audit.record('provider.intent', 'safe-target', { note: 'queued' }, {
    store: contended, signer, ...pathsFor(space), clock: () => 1000, reportError: () => {}
  });
  assert.strictEqual(first.durable, false, 'the simulated canonical contention must still be reported as non-durable');
  assert.strictEqual(first.pending, 1, 'the event must have been spooled');
  assert.ok(fs.existsSync(space.emergency), 'the emergency spool file must exist');

  const recoveredStore = freshStore();
  const recovered = audit.flush({ force: true }, {
    store: recoveredStore, signer, ...pathsFor(space), clock: () => 2000, reportError: () => {}, anchorStore: memoryAnchor()
  });
  assert.strictEqual(recovered.projected, true);
  const events = recoveredStore.listEvents({ afterSequence: 0, limit: 10 });
  assert.strictEqual(events.length, 1, "the process's own spooled write must survive round-trip authentication");
  assert.strictEqual(events[0].event.action, 'provider.intent');
  assert.strictEqual(events[0].event.details.note, 'queued');
}

// CRED-F7: an authenticated item (it passes the mac check) but one that
// still carries a raw secret in its details -- e.g. an item spooled before
// scrub()'s patterns were last tightened -- must be re-scrubbed before it is
// canonicalized, not trusted verbatim just because its provenance checks out.
function testAuthenticatedItemIsRescrubbedBeforeCanonicalization() {
  const space = scratch();
  const signer = testSigner();
  const store = freshStore();
  writeSpoolLine(space, envelopeFor({
    eventId: 'audit-unscrubbed-00000000001', occurredAtMs: 1000, createdAtMs: 1000,
    event: {
      timestamp: new Date(1000).toISOString(), action: 'provider.commit', target: 'safe',
      details: { access_token: 'must-not-appear', safe: 'retained' }
    }
  }, signer));

  const result = audit.flush({ force: true }, {
    store, signer, ...pathsFor(space), clock: () => 2000, reportError: () => {}, anchorStore: memoryAnchor()
  });
  assert.strictEqual(result.projected, true);
  const events = store.listEvents({ afterSequence: 0, limit: 10 });
  const ingested = events.find(event => event.event.action === 'provider.commit');
  assert.ok(ingested, 'the authenticated item must still be ingested');
  assert.strictEqual(ingested.event.details.access_token, 'REDACTED',
    'CRED-F7: ingestion must re-scrub, not trust the spooled details verbatim');
  assert.strictEqual(ingested.event.details.safe, 'retained', 'scrubbing must not destroy safe fields');
  assert.doesNotMatch(JSON.stringify(events), /must-not-appear/);
}

// CRED-F6: the durability sidecar is a plain, unsigned JSON file, not the
// scrubbed-and-canonicalized ledger. It must never persist the caller's raw
// action string verbatim, on disk or through its own read path.
function testDurabilitySidecarScrubsAction() {
  const space = scratch();
  const signer = testSigner();
  const contended = contendedStore();
  const status = audit.record('leak api_key=must-not-appear-in-sidecar', 'safe-target', {}, {
    store: contended, signer, ...pathsFor(space), clock: () => 1000, reportError: () => {}
  });
  assert.strictEqual(status.durable, false);

  const state = audit.readDurabilityState({ emergency: space.emergency });
  assert.strictEqual(state.readable, true);
  assert.strictEqual(state.breaches.length, 1);
  assert.ok(!/must-not-appear-in-sidecar/.test(state.breaches[0].action || ''),
    'CRED-F6: the durability sidecar must never persist an unsanitized action');
  assert.match(state.breaches[0].action, /REDACTED/);

  const raw = fs.readFileSync(space.state, 'utf8');
  assert.doesNotMatch(raw, /must-not-appear-in-sidecar/, 'the raw sidecar bytes on disk must also never contain the secret');
}

const tests = [
  testBareSpoolLineIsQuarantinedNotCanonicalized,
  testForgedMacIsQuarantinedNotCanonicalized,
  testRotatedSignerInvalidatesOldSpoolMac,
  testAuthenticEnvelopeIsIngestedNormally,
  testRecordsOwnSpoolWriteIngestsOnRecovery,
  testAuthenticatedItemIsRescrubbedBeforeCanonicalization,
  testDurabilitySidecarScrubsAction
];

assert.strictEqual(tests.length, 7, 'audit spool ingestion must execute all seven cases');
for (const test of tests) {
  audit.resetForTests();
  test();
}
console.log(`Audit emergency-spool ingestion hardening tests passed (${tests.length} cases).`);

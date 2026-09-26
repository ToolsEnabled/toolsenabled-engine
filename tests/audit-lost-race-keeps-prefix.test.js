'use strict';

// LOSING THE ADMISSION RACE MUST NOT THROW AWAY THE VERIFIED PREFIX.
//
// trustedVerificationMatches() is the fail-closed bridge between the O(N)
// verification taken outside the writer lock and the exact-witness check taken
// inside it. The digest it compares folds in PRAGMA data_version, so ANY other
// connection's commit makes it differ -- and on this product's own measurements
// there are around twelve resident audit writers on one ledger.
//
// It used to answer that race by calling _clearVerificationTrust(), which nulls
// both the exact-witness token and the verification cache. Only the witness is
// stale. The cache is the trusted prefix _verifyIncremental() extends, and
// _verifyWithCache can only reach the incremental path through it, so nulling
// it sent the retry through a full row read and Ed25519 walk of every live
// event -- ~1.7 s per pass on a 10,000-event ledger -- and then back into the
// same race, up to 32 times with no sleep in between. The incremental path
// exists for exactly this case and was destroyed at the moment it was needed.
//
// These checks pin both halves: the race is still detected and still refuses,
// AND the prefix survives so the retry is incremental rather than a full walk.
// They assert on the store's own counters, never on a clock -- a wall-clock
// threshold on a loaded machine manufactures failures.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuditStore } = require('../src/lib/audit-store');

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: `audit-ed25519-${crypto.createHash('sha256').update(der).digest('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

function ledger(count = 8) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-lost-race-'));
  const signer = testSigner();
  const store = createAuditStore({ file: path.join(dir, 'a.sqlite3') });
  store.registerKey(signer);
  for (let i = 1; i <= count; i += 1) {
    const appended = store.appendEvent({
      event: { timestamp: new Date(i).toISOString(), action: 'probe', target: 't', details: { i, note: `event ${i}` } },
      occurredAtMs: i, createdAtMs: i, eventId: crypto.randomUUID()
    }, signer).event;
    for (const sink of ['jsonl', 'text']) {
      store.markSinkSuccess({ sink, sequence: appended.sequence, eventHash: appended.eventHash, updatedAtMs: i });
    }
  }
  return {
    store, signer,
    cleanup() { try { store.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

// A different `external` is what a sibling process's projection write looks
// like to this store: the full fingerprint differs, so the witness cannot match.
const external = tag => ({ version: 1, cacheable: true, anchor: null, projectionDigest: tag, emergencyDigest: 'e' });

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('a lost race still refuses, fail-closed', () => {
  const test = ledger();
  try {
    const prior = test.store.verifyWithEvents({ external: external('a') });
    assert.equal(prior.verification.valid, true);
    assert.equal(test.store.trustedVerificationMatches({ prior, external: external('moved') }), false,
      'a changed witness must never be admitted -- this is the check that keeps the append honest');
  } finally { test.cleanup(); }
});

check('a lost race keeps the verified prefix, so the retry is incremental', () => {
  const test = ledger();
  try {
    const prior = test.store.verifyWithEvents({ external: external('a') });
    const before = test.store.verificationCacheStatus();
    assert.equal(before.lastResult, 'full', 'precondition: the first verification is the full walk');

    test.store.trustedVerificationMatches({ prior, external: external('moved') });

    // This is what lockedAdmissionAppend's retry does next.
    const retry = test.store.verifyWithEvents({ external: external('moved') });
    const after = test.store.verificationCacheStatus();

    assert.equal(retry.verification.valid, true, 'the retry must still verify');
    assert.equal(after.fullVerifications, before.fullVerifications,
      `the retry must not re-walk every signature; full walks went ${before.fullVerifications} -> ${after.fullVerifications}`);
    assert.ok(['incremental', 'cache-hit'].includes(after.lastResult),
      `the retry must be served by the retained prefix, saw ${after.lastResult}`);
  } finally { test.cleanup(); }
});

check('the witness itself is still dropped, so nothing stale can be admitted', () => {
  const test = ledger();
  try {
    const prior = test.store.verifyWithEvents({ external: external('a') });
    test.store.trustedVerificationMatches({ prior, external: external('moved') });
    // The same stale `prior` must not be accepted afterwards either, even when
    // re-offered against the witness it originally matched.
    assert.equal(test.store.trustedVerificationMatches({ prior, external: external('a') }), false,
      'once the witness has been dropped, a stale snapshot may not be re-admitted on a second try');
  } finally { test.cleanup(); }
});

check('repeated lost races never accumulate full walks', () => {
  const test = ledger();
  try {
    let prior = test.store.verifyWithEvents({ external: external('a') });
    const before = test.store.verificationCacheStatus().fullVerifications;
    for (let i = 0; i < 6; i += 1) {
      test.store.trustedVerificationMatches({ prior, external: external(`sibling${i}`) });
      prior = test.store.verifyWithEvents({ external: external(`sibling${i}`) });
      assert.equal(prior.verification.valid, true);
    }
    assert.equal(test.store.verificationCacheStatus().fullVerifications, before,
      'six consecutive lost races must add no full signature walk -- this is the 32-retry spin the fix exists to stop');
  } finally { test.cleanup(); }
});

check('the remembered verification is still deeply frozen', () => {
  const test = ledger();
  try {
    const result = test.store.verifyWithEvents({ external: external('a') });
    assert.ok(Object.isFrozen(result), 'the result itself must be frozen');
    assert.ok(Object.isFrozen(result.events), 'the events array must be frozen');
    const event = result.events[0];
    assert.ok(Object.isFrozen(event), 'each row must be frozen');
    assert.ok(Object.isFrozen(event.event), 'the nested event must be frozen');
    assert.ok(Object.isFrozen(event.event.details),
      'the details payload must be frozen too -- this is the depth a shallow isFrozen check would have lost');
    // And again after a second verification, which now reuses the memo.
    const second = test.store.verifyWithEvents({ external: external('b') });
    assert.ok(Object.isFrozen(second.events[0].event.details),
      'reusing the memo must not stop freezing anything');
  } finally { test.cleanup(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-lost-race-keeps-prefix: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

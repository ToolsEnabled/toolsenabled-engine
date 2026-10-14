'use strict';

// THE VERIFICATION CACHE MUST SURVIVE THE ARCHIVE ROLL.
//
// An append invalidates this process's verification cache (every mutation
// does). advanceVerificationCache() is what puts it back, cheaply, by proving
// the one new row extends the head it already trusted. If that advance fails,
// nothing else re-establishes the cache -- the next record() falls through to
// a full O(N) chain-and-signature walk, and so does the one after it.
//
// That failure is invisible: the answers stay correct, only the cost changes.
// It was measured on the owner's install 2026-09-02 as 1.7 s per record and
// roughly two records per tool call, which is most of why every tool call took
// ten seconds or more.
//
// The trigger was the retention roll. `prior.events` is the LIVE window, while
// `head.sequence` keeps counting through everything the roll has archived, so
// comparing them directly holds only while the boundary is still zero. The
// first roll broke it permanently, because the boundary only ever grows -- and
// a bounded ledger is exactly the configuration this product ships by default,
// so every install reaches it eventually and none of them recover.
//
// _verifyIncremental already roots its own count on the boundary. These checks
// pin that the advance agrees with it, because a cache one of them establishes
// and the other rejects is the same as no cache at all.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuditStore } = require('../src/lib/audit-store');
const { rollArchiveOnce, verifiedArchiveBoundary } = require('../src/lib/audit');

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: `audit-ed25519-${crypto.createHash('sha256').update(der).digest('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

// A ledger whose projection sinks are caught up, so the roll's sink guard is
// satisfied and the roll is actually reachable.
function ledger(count = 6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-advance-cache-'));
  const dbFile = path.join(dir, 'a.sqlite3');
  const archiveFile = path.join(dir, 'archive.jsonl');
  const signer = testSigner();
  const store = createAuditStore({ file: dbFile });
  store.registerKey(signer);
  let last = null;
  for (let i = 1; i <= count; i += 1) {
    last = store.appendEvent({
      event: { timestamp: new Date(i).toISOString(), action: 'probe', target: 't', details: { i } },
      occurredAtMs: i, createdAtMs: i, eventId: crypto.randomUUID()
    }, signer).event;
    for (const sink of ['jsonl', 'text']) {
      store.markSinkSuccess({ sink, sequence: last.sequence, eventHash: last.eventHash, updatedAtMs: i });
    }
  }
  return {
    dir, dbFile, archiveFile, signer, store,
    deps: { archiveFile, clock: () => 1 },
    // Append one more event the way a record() would, sinks kept level so the
    // fingerprint's sink digest matches what the advance expects to see.
    appendOne(at) {
      const appended = store.appendEvent({
        event: { timestamp: new Date(at).toISOString(), action: 'probe', target: 't', details: { at } },
        occurredAtMs: at, createdAtMs: at, eventId: crypto.randomUUID()
      }, signer).event;
      for (const sink of ['jsonl', 'text']) {
        store.markSinkSuccess({ sink, sequence: appended.sequence, eventHash: appended.eventHash, updatedAtMs: at });
      }
      return appended;
    },
    cleanup() { try { store.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

const external = tag => ({ version: 1, cacheable: true, anchor: null, projectionDigest: tag, emergencyDigest: 'e' });

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('after an archive roll, an append still advances the verification cache', () => {
  const test = ledger(6);
  try {
    const rolled = rollArchiveOnce(test.store, test.signer, test.deps, { nowMs: 1 });
    assert.equal(rolled.rolled, true, 'the roll must happen for this case to mean anything');
    const boundary = verifiedArchiveBoundary(rolled.boundary, test.signer);
    assert.ok(boundary && boundary.archivedThroughSequence > 0, 'a real, non-zero boundary is the whole point');

    const prior = test.store.verifyWithEvents({ external: external('a'), boundary });
    assert.equal(prior.verification.valid, true, 'the rolled ledger must verify at its boundary');
    // The live window is genuinely shorter than the absolute head, which is the
    // condition the old arithmetic could not represent.
    assert.ok(prior.events.length < prior.verification.headSequence,
      'this case is only meaningful while events have been archived');

    const appended = test.appendOne(7);
    const advanced = test.store.advanceVerificationCache({
      prior, event: appended, external: external('b'), boundary
    });
    assert.equal(advanced, true,
      'the advance must accept an append onto a rolled ledger; refusing it silently costs a full walk per record');

    const after = test.store.verifyWithEvents({ external: external('b'), boundary });
    assert.equal(after.verification.valid, true);
    assert.equal(test.store.verificationCacheStatus().lastResult, 'cache-hit',
      'the advanced cache must actually be reused -- an advance nobody hits is not a fix');
    assert.equal(after.verification.headSequence, appended.sequence);
  } finally { test.cleanup(); }
});

check('the advance still works when nothing has been archived', () => {
  const test = ledger(4);
  try {
    const prior = test.store.verifyWithEvents({ external: external('a'), boundary: null });
    assert.equal(prior.verification.valid, true);
    const appended = test.appendOne(5);
    assert.equal(test.store.advanceVerificationCache({
      prior, event: appended, external: external('b'), boundary: null
    }), true, 'the unrolled case must keep working exactly as before');
    test.store.verifyWithEvents({ external: external('b'), boundary: null });
    assert.equal(test.store.verificationCacheStatus().lastResult, 'cache-hit');
  } finally { test.cleanup(); }
});

check('a rolled ledger never pays a full walk twice for the same unchanged state', () => {
  const test = ledger(6);
  try {
    const rolled = rollArchiveOnce(test.store, test.signer, test.deps, { nowMs: 1 });
    const boundary = verifiedArchiveBoundary(rolled.boundary, test.signer);
    let prior = test.store.verifyWithEvents({ external: external('a'), boundary });
    const before = test.store.verificationCacheStatus().fullVerifications;

    // Five appends in a row, each advanced then re-verified: the shape a
    // process running back-to-back tool calls actually produces.
    for (let i = 0; i < 5; i += 1) {
      const appended = test.appendOne(10 + i);
      assert.equal(test.store.advanceVerificationCache({
        prior, event: appended, external: external(`x${i}`), boundary
      }), true, `advance ${i} must hold across repeated appends`);
      prior = test.store.verifyWithEvents({ external: external(`x${i}`), boundary });
      assert.equal(prior.verification.valid, true);
    }
    assert.equal(test.store.verificationCacheStatus().fullVerifications, before,
      'not one additional full signature walk may be needed for five ordinary appends');
  } finally { test.cleanup(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-advance-cache-after-roll: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

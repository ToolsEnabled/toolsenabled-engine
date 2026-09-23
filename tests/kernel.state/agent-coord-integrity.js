// EXECUTABLE CHANGE
'use strict';

// DISCRIMINATION REPORT (testcanfail-tests-kernel-state-agent-coord-integrity-js)
// Strengthened assertions: the attestation-field and malformed-author table
// loops now assert their complete case census before iterating.  Mutation:
// replace either table with `[]`.  RED (attestation table):
//   AssertionError [ERR_ASSERTION]: attestation mutation census must remain complete
//   0 !== 9
// RED (malformed-author table):
//   AssertionError [ERR_ASSERTION]: malformed-author census must remain complete
//   0 !== 5
// Restored-source GREEN:
//   agent-coord-integrity proof passed
// NOT-FOUND (exit/truthy-only): no child process or exit-status assertion.
// NOT-FOUND (swallowed failure): only cleanup is non-fatal; verification catches
// malformed candidate records by contract, while rejection checks use assert.throws.
// NOT-FOUND (subject mocked): this test loads the real state store and integrity module.
// NOT-FOUND (skip/platform guard): execution has no skip or precondition branch.
// NOT-FOUND (same-code oracle): hashInput comparisons cross the independently stored
// database value; crypto checks also include negative mutations/different-key cases.
// Product mutation checked: changing state-store hashInput to return 64 zeroes made
// the existing value-hash sanity assertion RED; src/lib/state-store.js was restored
// byte-for-byte (SHA-256 b615db5aafd92de72b350cbff129ff3a28076cf7a325a220fbce740caf364064).
// Precondition named: PATH's Node 20 lacks node:sqlite; runs use the repository's
// installed /root/.nvm/versions/node/v22.22.2/bin/node.

// Proves the specific claim made about memory_entries integrity: under the
// CURRENT scheme (state-store.js value_hash = plain sha256 of content), a
// raw SQL rewrite that recomputes value_hash to match is indistinguishable
// from a genuine write. Under the PROPOSED scheme (src/lib/agent-coord-
// integrity.js, HMAC-SHA256 keyed on a secret the attacker does not hold),
// the same rewrite is detected. Uses only synthetic test data in a throwaway
// temp-file database -- never state/toolsenabled.sqlite3, never a real vault
// secret, and this file is not wired into any live read/write path.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore, hashInput } = require('../../src/lib/state-store');
const integrity = require('../../src/lib/agent-coord-integrity');

const temporaryRoots = [];
function fixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-agent-coord-integrity-${name}-`));
  temporaryRoots.push(dir);
  return createStateStore({ file: path.join(dir, 'state.sqlite3') });
}

// getMemory() returns the friendly {value, tags, ...} shape for callers; the
// integrity record needs the exact stored JSON columns (what a raw UPDATE
// would actually touch), so read those directly the same way the repo's own
// tamper-simulation tests do (tests/kernel.state/state-store.js).
function rawRow(store, namespace, key) {
  return store.transaction(db => db.prepare(
    'SELECT namespace, entry_key AS key, value_json AS valueJson, note, tags_json AS tagsJson, revision FROM memory_entries WHERE namespace = ? AND entry_key = ?'
  ).get(namespace, key));
}

(async () => {
  try {
    const store = fixture('proof');

    // 1. A genuine write, exactly as memory.set produces it today.
    const genuine = store.setMemory({
      namespace: 'test-ns', key: 'test-key', value: { msg: 'genuine coordination content' }
    });
    const row = () => store.getMemory({ namespace: 'test-ns', key: 'test-key' });
    const before = row();
    assert.equal(before.revision, 1);
    assert.equal(before.valueHash, hashInput({ msg: 'genuine coordination content' }),
      'sanity: value_hash is exactly the plain content hash state-store.js already computes');

    // 2. Attacker with raw DB access (this is what BUILTIN\Users / CodexSandboxUsers
    // have today per icacls on state\toolsenabled.sqlite3) rewrites the row directly,
    // bypassing memory.set entirely, and recomputes the SAME unkeyed hash algorithm
    // to keep the row self-consistent. No secret is required to do this.
    const forgedValueJson = JSON.stringify({ msg: 'forged: this never happened' });
    const forgedHash = hashInput({ msg: 'forged: this never happened' });
    store.transaction(db => db.prepare(
      'UPDATE memory_entries SET value_json = ?, value_hash = ?, revision = revision + 1 WHERE namespace = ? AND entry_key = ?'
    ).run(forgedValueJson, forgedHash, 'test-ns', 'test-key'));

    // getMemory() itself re-derives the canonical form and throws
    // MEMORY_ENTRY_INVALID if value_hash disagrees with the stored content
    // (state-store.js _memoryRow) -- so this call succeeding at all is
    // already evidence the forged row looks completely legitimate to a
    // normal reader; it does not throw here.
    const tampered = row();
    assert.equal(tampered.revision, 2);
    assert.equal(tampered.value.msg, 'forged: this never happened');

    // THE HOLE: under the current scheme, the forged row is fully self-consistent.
    // A reader has no signal at all that this content is not what memory.set wrote.
    assert.equal(tampered.valueHash, hashInput(tampered.value),
      'CURRENT SCHEME: forged content + recomputed self-hash passes -- undetectable');

    // 3. Now redo the same scenario under the proposed HMAC scheme. The secret is
    // synthetic test material generated locally -- not the real vault, not a live key.
    const secret = crypto.randomBytes(32);
    const store2 = fixture('hmac-proof');
    store2.setMemory({
      namespace: 'test-ns', key: 'test-key', value: { msg: 'genuine coordination content' }
    });
    const genuineRecord = rawRow(store2, 'test-ns', 'test-key');
    const genuineMac = integrity.sign(secret, genuineRecord);
    assert.equal(integrity.verify(secret, genuineRecord, genuineMac), true,
      'sanity: a genuine write verifies against its own HMAC');

    // Same attack as step 2: raw rewrite, content self-hash recomputed to match.
    // The attacker does not have `secret` (that is the whole point -- it lives only
    // where DPAPI CurrentUser decrypt rights exist), so the best they can do is leave
    // the old HMAC in place or guess; either way it was computed over the genuine
    // payload, not the forged one.
    const forgedHash2 = hashInput({ msg: 'forged: this never happened' });
    store2.transaction(db => db.prepare(
      'UPDATE memory_entries SET value_json = ?, value_hash = ?, revision = revision + 1 WHERE namespace = ? AND entry_key = ?'
    ).run(JSON.stringify({ msg: 'forged: this never happened' }), forgedHash2, 'test-ns', 'test-key'));
    const tamperedRecord = rawRow(store2, 'test-ns', 'test-key');

    // THE FIX: the stale HMAC (signed over the genuine payload/revision) no longer
    // verifies against the tampered payload/revision -- the forgery is now loud.
    assert.equal(integrity.verify(secret, tamperedRecord, genuineMac), false,
      'PROPOSED SCHEME: forged content fails HMAC verification -- detected');

    // And confirm a forger who does not hold `secret` cannot mint a replacement MAC
    // either -- guessing a random 32-byte hex string over the tampered record fails.
    assert.equal(integrity.verify(secret, tamperedRecord, crypto.randomBytes(32).toString('hex')), false,
      'a forger without the secret cannot mint a valid replacement HMAC either');

    // 4. Operational requirement: deployment must be additive/backward-compatible.
    // A row written before this scheme existed has no mac at all -- that must read
    // as "legacy, unsigned", never as "tampered". classify() gives that third state.
    assert.equal(integrity.classify(secret, genuineRecord, null), 'legacy-unsigned',
      'a pre-existing row with no mac column value is legacy, not a verification failure');
    assert.equal(integrity.classify(secret, genuineRecord, undefined), 'legacy-unsigned',
      'undefined mac (column not yet backfilled) also reads as legacy, not tampered');
    assert.equal(integrity.classify(secret, genuineRecord, genuineMac), 'verified',
      'a signed, matching row classifies as verified');
    assert.equal(integrity.classify(secret, tamperedRecord, genuineMac), 'tamper-suspected',
      'a signed row whose content no longer matches its mac is the loud tamper signal');

    // 5. AUTHORSHIP (v2). The primitives that make an entry attributable.
    // End-to-end behaviour against a real database lives in
    // tests/kernel.state/agent-coord-attest-migrate.js; this block covers the
    // pure crypto properties that suite relies on.
    const observed = { principal: 'test-user', pid: 4242, machineId: 'machine-a', signerVersion: 1 };
    const attestation = {
      kind: 'authored', namespace: 'agent-coord', key: 'test-key', revision: 1,
      valueHash: hashInput({ msg: 'genuine coordination content' }),
      author: { declared: 'lane-a', observed }, signedAtMs: 1700000000000
    };
    const attestationMac = integrity.signAttestation(secret, attestation);
    assert.equal(integrity.verifyAttestation(secret, attestation, attestationMac), true,
      'an authored attestation verifies under its own key');

    // Every field is load-bearing: changing any one of them must break the MAC,
    // otherwise that field could be rewritten by a raw DB writer for free.
    const attestationMutations = [
      ['declared author', { ...attestation, author: { declared: 'coordinator-sol', observed } }],
      ['observed principal', { ...attestation, author: { declared: 'lane-a', observed: { ...observed, principal: 'attacker' } } }],
      ['observed pid', { ...attestation, author: { declared: 'lane-a', observed: { ...observed, pid: 9999 } } }],
      ['content hash', { ...attestation, valueHash: hashInput({ msg: 'forged' }) }],
      ['revision', { ...attestation, revision: 2 }],
      ['namespace', { ...attestation, namespace: 'other-ns' }],
      ['key', { ...attestation, key: 'other-key' }],
      ['kind', { ...attestation, kind: 'baseline-snapshot' }],
      ['signing time', { ...attestation, signedAtMs: 1700000000001 }]
    ];
    assert.equal(attestationMutations.length, 9,
      'attestation mutation census must remain complete');
    for (const [label, mutated] of attestationMutations) {
      assert.equal(integrity.verifyAttestation(secret, mutated, attestationMac), false,
        `mutating the ${label} must invalidate the attestation MAC`);
    }

    // DOMAIN SEPARATION. A v1 record signature and a v2 attestation are
    // computed under different context strings, so one can never be replayed
    // as the other even when an attacker controls the surrounding fields.
    assert.notEqual(integrity.CONTEXT, integrity.ATTESTATION_CONTEXT);
    assert.equal(integrity.verifyAttestation(secret, attestation, integrity.sign(secret, genuineRecord)), false,
      'a v1 record MAC is not accepted as a v2 attestation MAC');

    // KEY FINGERPRINT. Stable for one key, different across keys, and never a
    // route back to the key itself -- it is what makes a vault swap visible
    // without ever writing key material into a ledger or a report.
    const otherSecret = crypto.randomBytes(32);
    assert.equal(integrity.keyFingerprint(secret), integrity.keyFingerprint(secret), 'fingerprint is stable');
    assert.notEqual(integrity.keyFingerprint(secret), integrity.keyFingerprint(otherSecret), 'different keys differ');
    assert.equal(integrity.keyFingerprint(secret).includes(secret.toString('hex').slice(0, 8)), false,
      'the fingerprint does not embed key material');

    // Author validation rejects malformed input rather than silently signing a
    // shape a reader could not interpret.
    const malformedAuthors = [
      { declared: '', observed },
      { declared: 'has spaces', observed },
      { declared: 'lane-a', observed: { ...observed, pid: -1 } },
      { declared: 'lane-a', observed: null },
      { declared: 'lane-a' }
    ];
    assert.equal(malformedAuthors.length, 5,
      'malformed-author census must remain complete');
    for (const bad of malformedAuthors) {
      assert.throws(() => integrity.canonicalAuthor(bad), integrity.AgentCoordIntegrityError,
        `malformed author ${JSON.stringify(bad)} must be rejected`);
    }

    // Canonicalization is byte-stable regardless of the caller's key order --
    // otherwise two honest signers would disagree about the same author.
    assert.equal(
      JSON.stringify(integrity.canonicalAuthor({ declared: 'lane-a', observed })),
      JSON.stringify(integrity.canonicalAuthor({
        observed: { signerVersion: 1, machineId: 'machine-a', pid: 4242, principal: 'test-user' },
        declared: 'lane-a'
      })),
      'canonical author form does not depend on property order'
    );

    store.close();
    store2.close();
    process.stdout.write('agent-coord-integrity proof passed\n');
  } finally {
    // Best-effort cleanup only: a lingering AV/indexer handle on the temp
    // sqlite file must not turn a passed proof into a failed exit code. The
    // proof's pass/fail already happened above; this is tidiness, not
    // evidence of anything.
    for (const dir of temporaryRoots) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
      catch (error) { console.error(`(non-fatal) temp cleanup failed for ${dir}: ${error.message}`); }
    }
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

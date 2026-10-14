// NOTHING FOUND
//
// Discrimination audit (2026-08-26): no assertion required strengthening.
// Mutation 1 inserted an unconditional `return null` at the start of
// verifiedArchiveBoundary(). The acceptance checks went RED with:
//   "AssertionError [ERR_ASSERTION]: a freshly minted boundary must verify
//    against its own signer"
// and:
//   "AssertionError [ERR_ASSERTION]: precondition: the forged boundary is
//    internally valid, so only the key check rejects it"
// Mutation 2 made verifiedArchiveBoundary() trust every object without checking
// its signature. The refusal checks went RED, including:
//   "AssertionError [ERR_ASSERTION]: mutating archivedThroughSequence must
//    invalidate the boundary"
//   "AssertionError [ERR_ASSERTION]: a claim carrying the head-anchor domain
//    must never verify as a boundary"
//   "AssertionError [ERR_ASSERTION]: a boundary signed by another key must be
//    refused"
//   "AssertionError [ERR_ASSERTION]: array must be refused"
//   "AssertionError [ERR_ASSERTION]: a missing or keyless signer must refuse,
//    never accept"
// The production file was restored byte-for-byte after both mutations (SHA-256
// before and after: 0d54120a8f091610c6c769cf6d5a268e31bdf2bb68e965e34c932393611d1c4f).
//
// NOT-FOUND (1): all three loops iterate non-empty array literals; none obtains
// cases from a possibly empty runtime collection.
// NOT-FOUND (2): there is no exit-status or generic truthy-return proxy for
// process output. The two assert.ok calls inspect verifier results directly.
// NOT-FOUND (3): catches in the local runner record failure and set a non-zero
// exit code; finally blocks only clean scratch stores and swallow no assertion.
// NOT-FOUND (4): cryptographic and persistence subjects are real implementations,
// not mocks of makeArchiveBoundary(), verifiedArchiveBoundary(), or the store.
// NOT-FOUND (5): there are no skips or platform precondition guards.
// NOT-FOUND (6): expected rooting fields and rejection outcomes are independent
// literals, rather than values computed by the implementation under test.
//
// Unmet precondition: this container runs Node 20.19.1, which lacks node:sqlite.
// Consequently the three persistence checks fail while opening their scratch
// stores with ERR_UNKNOWN_BUILTIN_MODULE. The six verifier-only checks are green
// after exact restoration: "audit-archive-boundary: 6/9 checks passed". A full
// green confirmation requires the package's declared Node >=22.19.0 runtime.

'use strict';

// THE ARCHIVE BOUNDARY IS THE ONLY THING STANDING BETWEEN COLD STORAGE AND
// UNDETECTABLE TRUNCATION.
//
// The audit ledger is unbounded: 1,527 events/day measured on the owner's
// install, ~557,000 after a year, and every short-lived process re-verifies all
// of it -- ~110 scheduled process starts an hour, each paying a full pass. A
// measured no-op keeper decision costs 8,924 ms and 34,951 signature checks.
// Bounding the live ledger is what fixes that, and bounding it means the oldest
// events leave.
//
// The moment they leave, the live rows no longer start at sequence 1, and the
// contiguity check that makes front-truncation detectable for free stops firing
// on its own. A signed boundary is what replaces it. If the boundary can be
// forged, or presented from another context, or accepted while malformed, then
// archiving has bought CPU by discarding the property legal names as the
// product's biggest advantage.
//
// So these cases are not about the happy path. Every one of them is an attempt
// to get a boundary accepted that should not be.
//
// Nothing here touches the production ledger or vault: the signer is generated
// in-process and verifiedArchiveBoundary() takes it as an argument, which is the
// design point being asserted (see "the verifying key" case below).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

const {
  makeArchiveBoundary, verifiedArchiveBoundary, readArchiveBoundary,
  ARCHIVE_BOUNDARY_DOMAIN, ARCHIVE_BOUNDARY_METADATA_KEY
} = audit;

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: `audit-ed25519-${crypto.createHash('sha256').update(der).digest('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

const signer = testSigner();
const claim = {
  archivedThroughSequence: 2,
  eventHash: 'a'.repeat(64)
};
const minted = makeArchiveBoundary(claim, signer);

check('a boundary this installation minted verifies, and yields only the two rooting fields', () => {
  const verified = verifiedArchiveBoundary(minted, signer);
  assert.ok(verified, 'a freshly minted boundary must verify against its own signer');
  assert.equal(verified.archivedThroughSequence, 2);
  assert.equal(verified.eventHash, 'a'.repeat(64));
  // Only the fields audit-store roots the chain on are handed onward, so a
  // field added later cannot silently acquire meaning inside the verifier.
  assert.deepEqual(Object.keys(verified).sort(), ['archivedThroughSequence', 'eventHash']);
});

check('every signed field is covered: mutating any one of them is refused', () => {
  // If a field is in the payload but not in the signature, an attacker edits it
  // freely -- which is exactly the class of defect that killed an earlier
  // checkpoint design (event_hash never covered the signature column).
  for (const [field, value] of [
    ['archivedThroughSequence', 3],
    ['eventHash', 'b'.repeat(64)],
    ['keyId', `audit-ed25519-${'e'.repeat(64)}`],
    ['version', 2],
    ['domain', 'toolsenabled.audit.head.v1']
  ]) {
    assert.equal(verifiedArchiveBoundary({ ...minted, [field]: value }, signer), null,
      `mutating ${field} must invalidate the boundary`);
  }
});

check('a head anchor cannot be presented as an archive boundary', () => {
  // Both are signed by the same audit key over canonical JSON. Without distinct
  // domains, a valid signature from one context would satisfy the other -- the
  // missing-domain-separation defect an adversarial review caught in an earlier
  // draft of this work.
  const anchorShaped = makeArchiveBoundary(claim, signer);
  anchorShaped.domain = 'toolsenabled.audit.head.v1';
  assert.equal(verifiedArchiveBoundary(anchorShaped, signer), null,
    'a claim carrying the head-anchor domain must never verify as a boundary');
  assert.notEqual(ARCHIVE_BOUNDARY_DOMAIN, 'toolsenabled.audit.head.v1',
    'the two domains must actually differ');
});

check('the verifying key is the caller-supplied vault key, not one from the ledger', () => {
  // This is the property that keeps the root of trust outside the surface being
  // audited. A boundary minted by any other key is not this installation's,
  // however internally valid its signature is.
  const attacker = testSigner();
  const forged = makeArchiveBoundary(claim, attacker);
  assert.equal(verifiedArchiveBoundary(forged, signer), null,
    'a boundary signed by another key must be refused');
  assert.ok(verifiedArchiveBoundary(forged, attacker),
    'precondition: the forged boundary is internally valid, so only the key check rejects it');
  // And a boundary whose keyId claims ours while being signed by theirs.
  assert.equal(verifiedArchiveBoundary({ ...forged, keyId: signer.keyId }, signer), null,
    'claiming our keyId must not help when the signature is theirs');
});

check('absent, malformed and wrong-shaped boundaries are refused rather than half-trusted', () => {
  for (const [label, value] of [
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['string', 'boundary'],
    ['empty object', {}],
    ['sequence 0', { ...minted, archivedThroughSequence: 0 }],
    ['negative sequence', { ...minted, archivedThroughSequence: -1 }],
    ['non-integer sequence', { ...minted, archivedThroughSequence: 2.5 }],
    ['short hash', { ...minted, eventHash: 'a'.repeat(63) }],
    ['non-hex hash', { ...minted, eventHash: 'z'.repeat(64) }],
    ['missing signature', { ...minted, signature: undefined }],
    ['non-base64 signature', { ...minted, signature: '!!!!' }]
  ]) {
    assert.equal(verifiedArchiveBoundary(value, signer), null, `${label} must be refused`);
  }
});

check('a boundary cannot be verified without a signer', () => {
  // Falling back to "no key supplied, assume valid" would be the whole hole.
  for (const bad of [null, undefined, {}, { publicKeyPem: '' }, { publicKeyPem: 42 }]) {
    assert.equal(verifiedArchiveBoundary(minted, bad), null,
      'a missing or keyless signer must refuse, never accept');
  }
});

// ---------------------------------------------------------------------------
// THE ROUND TRIP: mint, persist to audit_metadata, read back through
// readArchiveBoundary(), and confirm on-disk tampering is refused the same
// way an in-memory forgery is. audit_metadata is an ordinary table an
// attacker with database access can write directly, so the read path must
// re-verify from the stored bytes, never trust that a value found under the
// expected metadata key is automatically the real thing.
// ---------------------------------------------------------------------------
function scratchStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-archive-boundary-'));
  const store = createAuditStore({ file: path.join(dir, 'a.sqlite3') });
  return { dir, store, close: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

check('a boundary written via setMetadata round-trips through readArchiveBoundary', () => {
  const scratch = scratchStore();
  try {
    assert.equal(readArchiveBoundary(scratch.store, signer), null,
      'no boundary has been written yet, so reading must return null, not throw');
    scratch.store.setMetadata(ARCHIVE_BOUNDARY_METADATA_KEY, minted);
    const read = readArchiveBoundary(scratch.store, signer);
    assert.ok(read, 'a boundary written via setMetadata must be readable and verify');
    assert.equal(read.archivedThroughSequence, 2);
    assert.equal(read.eventHash, 'a'.repeat(64));
  } finally { scratch.close(); }
});

check('hand-editing the stored bytes is refused, not silently accepted', () => {
  const scratch = scratchStore();
  try {
    scratch.store.setMetadata(ARCHIVE_BOUNDARY_METADATA_KEY, minted);
    assert.ok(readArchiveBoundary(scratch.store, signer), 'precondition: the untouched value must verify');
    // The same class of attack the public-key-identity and signature-stripping
    // fixes elsewhere in this session were written against: edit a stored
    // value directly and confirm verification, not presence, is what gates
    // trust.
    scratch.store.setMetadata(ARCHIVE_BOUNDARY_METADATA_KEY, { ...minted, archivedThroughSequence: 999 });
    assert.equal(readArchiveBoundary(scratch.store, signer), null,
      'a hand-edited boundary must be refused even though it sits under the correct metadata key');
  } finally { scratch.close(); }
});

check('a boundary read with the wrong signer is refused, exactly as an in-memory one is', () => {
  const scratch = scratchStore();
  try {
    scratch.store.setMetadata(ARCHIVE_BOUNDARY_METADATA_KEY, minted);
    const other = testSigner();
    assert.equal(readArchiveBoundary(scratch.store, other), null,
      'reading with a different installation\'s signer must not verify this installation\'s boundary');
  } finally { scratch.close(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-archive-boundary: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

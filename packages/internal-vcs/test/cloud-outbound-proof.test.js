'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutboundProof, validateOutboundProof } = require('../src/cloud/outbound-proof');
const { OUTBOUND_PROOF_SCHEMA } = require('../src/cloud/constants');

const MANIFEST_ID = `sha256:${'d'.repeat(64)}`;
const GIT_COMMIT = `git-sha1:${'e'.repeat(40)}`;
const CREATED_AT = '2026-08-08T12:00:00.000Z';

function input(overrides = {}) {
  return {
    manifestId: MANIFEST_ID,
    sourceCommit: GIT_COMMIT,
    branch: 'r1177/s2-filekeeper-custody',
    remoteLabel: 'origin',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

test('outbound proofs are deterministic and bind manifest, commit, branch, remote, and time', () => {
  const first = createOutboundProof(input());
  const second = createOutboundProof({
    createdAt: CREATED_AT,
    remoteLabel: 'origin',
    branch: 'r1177/s2-filekeeper-custody',
    sourceCommit: GIT_COMMIT,
    manifestId: MANIFEST_ID,
  });
  assert.equal(first.proofId, second.proofId);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, OUTBOUND_PROOF_SCHEMA);
  assert.equal(first.manifestId, MANIFEST_ID);
  assert.equal(first.sourceCommit, GIT_COMMIT);
  assert.ok(first.proofId.startsWith('sha256:'));
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(validateOutboundProof(first), first);
  // Any bound field changes the identity.
  assert.notEqual(createOutboundProof(input({ branch: 'main' })).proofId, first.proofId);
  assert.notEqual(createOutboundProof(input({ createdAt: '2026-08-08T12:00:01.000Z' })).proofId, first.proofId);
  assert.notEqual(createOutboundProof(input({ remoteLabel: 'mirror' })).proofId, first.proofId);
});

test('unqualified hashes are refused; qualified git locators are accepted', () => {
  assert.throws(() => createOutboundProof(input({ sourceCommit: 'e'.repeat(40) })), { code: 'VCS_CONTRACT_VIOLATION' });
  assert.throws(() => createOutboundProof(input({ sourceCommit: `sha1:${'e'.repeat(40)}` })), { code: 'VCS_CONTRACT_VIOLATION' });
  assert.throws(() => createOutboundProof(input({ sourceCommit: `git-sha1:${'E'.repeat(40)}` })), { code: 'VCS_CONTRACT_VIOLATION' });
  assert.throws(() => createOutboundProof(input({ manifestId: 'd'.repeat(64) })), { code: 'VCS_CONTRACT_VIOLATION' });
  // A manifestId is an internal digest, never a git locator.
  assert.throws(() => createOutboundProof(input({ manifestId: GIT_COMMIT })), { code: 'CLOUD_PROOF_UNKNOWN' });
  const sha256Commit = createOutboundProof(input({ sourceCommit: `git-sha256:${'f'.repeat(64)}` }));
  assert.equal(sha256Commit.sourceCommit, `git-sha256:${'f'.repeat(64)}`);
});

test('proof inputs are closed objects: extra fields, missing fields, and accessors are refused', () => {
  assert.throws(() => createOutboundProof(input({ note: 'extra' })), { code: 'CLOUD_PROOF_UNKNOWN' });
  const missing = input();
  delete missing.remoteLabel;
  assert.throws(() => createOutboundProof(missing), { code: 'CLOUD_PROOF_UNKNOWN' });
  assert.throws(() => createOutboundProof(null), { code: 'CLOUD_PROOF_UNKNOWN' });
  assert.throws(() => createOutboundProof([input()]), { code: 'CLOUD_PROOF_UNKNOWN' });

  const trick = input();
  delete trick.branch;
  let reads = 0;
  Object.defineProperty(trick, 'branch', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? 'main' : 'swapped-after-validation';
    },
  });
  assert.throws(() => createOutboundProof(trick), { code: 'CLOUD_PROOF_UNKNOWN' });

  for (const field of ['branch', 'remoteLabel']) {
    assert.throws(() => createOutboundProof(input({ [field]: '' })), { code: 'CLOUD_PROOF_UNKNOWN' });
    assert.throws(() => createOutboundProof(input({ [field]: 'has\u0000control' })), { code: 'CLOUD_PROOF_UNKNOWN' });
    assert.throws(() => createOutboundProof(input({ [field]: 42 })), { code: 'CLOUD_PROOF_UNKNOWN' });
  }
});

test('createdAt is caller-supplied and must be one canonical UTC representation', () => {
  for (const createdAt of [
    '2026-08-08T12:00:00Z',
    '2026-08-08T12:00:00.000+00:00',
    '2026-08-08 12:00:00.000Z',
    'not-a-timestamp',
    '',
  ]) {
    assert.throws(
      () => createOutboundProof(input({ createdAt })),
      { code: 'CLOUD_PROOF_UNKNOWN' },
      `expected refusal: ${JSON.stringify(createdAt)}`,
    );
  }
  const proof = createOutboundProof(input());
  assert.equal(proof.createdAt, CREATED_AT);
});

test('tampered or non-canonical proof records are refused on validation', () => {
  const proof = createOutboundProof(input());
  assert.throws(
    () => validateOutboundProof({ ...proof, branch: 'main' }),
    { code: 'CLOUD_PROOF_UNKNOWN' },
  );
  assert.throws(
    () => validateOutboundProof({ ...proof, note: 'extra' }),
    { code: 'CLOUD_PROOF_UNKNOWN' },
  );
  assert.throws(
    () => validateOutboundProof({ ...proof, schemaVersion: 'internal-vcs.cloud.outbound-proof/v2' }),
    { code: 'CLOUD_PROOF_UNKNOWN' },
  );
  assert.throws(
    () => validateOutboundProof({ ...proof, proofId: GIT_COMMIT }),
    { code: 'CLOUD_PROOF_UNKNOWN' },
  );
});

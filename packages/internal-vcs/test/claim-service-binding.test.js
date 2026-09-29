'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createClaimServiceBinding,
  getSharedClaimService,
  resetSharedClaimServiceForTests,
} = require('../src/claim-service-binding');
const { VCS_ERROR_CODES } = require('../src/errors');
const claimServiceStub = require('../src/services/claim-service');

function fileScope(pathId, { actions = ['write'], resourceVersion = 'v1' } = {}) {
  return [{
    namespace: 'worktree:main',
    kind: 'file',
    canonicalId: pathId,
    ancestorIds: [],
    actions,
    resourceVersion,
  }];
}

test('acquireClaim/heartbeatClaim/releaseClaim/inspectClaim actually work through the binding', async () => {
  const service = createClaimServiceBinding({ clock: () => 1_000 });

  const claim = await service.acquireClaim({
    holderId: 'lane:alpha',
    scope: fileScope('packages/internal-vcs/src/services/claim-service.js'),
    ttlMs: 1_000,
    policyRevisionId: 'policy:v1',
  });
  assert.equal(claim.holderId, 'lane:alpha');
  assert.equal(claim.state, 'ACTIVE');
  assert.equal(claim.fenceToken, 1);

  const binding = {
    claimId: claim.claimId,
    scopeDigest: claim.scopeDigest,
    fenceToken: claim.fenceToken,
    authoritySnapshotId: claim.authoritySnapshotId,
    expiresAt: claim.expiresAt,
  };

  const renewed = await service.heartbeatClaim({ binding, ttlMs: 2_000 });
  assert.equal(renewed.claimId, claim.claimId);
  assert.equal(renewed.fenceToken, claim.fenceToken, 'heartbeat renews time, never reissues the fence');
  assert.notEqual(renewed.expiresAt, claim.expiresAt);

  const renewedBinding = {
    claimId: renewed.claimId,
    scopeDigest: renewed.scopeDigest,
    fenceToken: renewed.fenceToken,
    authoritySnapshotId: renewed.authoritySnapshotId,
    expiresAt: renewed.expiresAt,
  };

  const inspectionWhileHeld = await service.inspectClaim({ scope: fileScope('packages/internal-vcs/src/services/claim-service.js') });
  assert.equal(inspectionWhileHeld.state, 'UNSAFE', 'an active overlapping claim must be visible to inspectClaim');
  assert.equal(inspectionWhileHeld.claims.length, 1);
  assert.equal(inspectionWhileHeld.claims[0].claimId, claim.claimId);

  const released = await service.releaseClaim({ binding: renewedBinding, reason: 'lane finished' });
  assert.equal(released.state, 'RELEASED');

  const inspectionAfterRelease = await service.inspectClaim({ scope: fileScope('packages/internal-vcs/src/services/claim-service.js') });
  assert.equal(inspectionAfterRelease.state, 'SAFE', 'a released claim must no longer block the territory');
});

// DELIBERATE RED (per instructions): prove a second acquire over an
// OVERLAPPING territory is REFUSED while the first claim is still active.
// If this ever passes with both claims granted, the binding does not do
// what its name says.
test('DELIBERATE RED: a second acquireClaim over overlapping file territory is refused, not silently granted', async () => {
  const service = createClaimServiceBinding({ clock: () => 5_000 });
  const territory = fileScope('packages/internal-vcs/src/services/claim-service-binding.js');

  const first = await service.acquireClaim({
    holderId: 'lane:one',
    scope: territory,
    ttlMs: 10_000,
    policyRevisionId: 'policy:v1',
  });
  assert.equal(first.state, 'ACTIVE');

  await assert.rejects(
    service.acquireClaim({
      holderId: 'lane:two',
      scope: territory, // identical/overlapping territory, still held by lane:one
      ttlMs: 10_000,
      policyRevisionId: 'policy:v1',
    }),
    (error) => {
      assert.equal(error.code, VCS_ERROR_CODES.LEASE_CONFLICT, `expected a fenced refusal (VCS_LEASE_CONFLICT), got ${error.code}`);
      assert.equal(error.details.existingClaimId, first.claimId);
      return true;
    },
    'a second lane must NOT be able to acquire an overlapping claim while the first is active',
  );

  // Sanity contrast: a DISJOINT file territory is unaffected by the held claim.
  const disjoint = await service.acquireClaim({
    holderId: 'lane:three',
    scope: fileScope('packages/internal-vcs/src/services/backup-service.js'),
    ttlMs: 10_000,
    policyRevisionId: 'policy:v1',
  });
  assert.equal(disjoint.state, 'ACTIVE');
});

test('two independent bindings do NOT fence each other (documented process-scope limit)', async () => {
  const territory = fileScope('packages/internal-vcs/src/services/conflict-service.js');
  const serviceA = createClaimServiceBinding({ clock: () => 1_000 });
  const serviceB = createClaimServiceBinding({ clock: () => 1_000 });

  const claimFromA = await serviceA.acquireClaim({
    holderId: 'lane:on-a', scope: territory, ttlMs: 5_000, policyRevisionId: 'policy:v1',
  });
  assert.equal(claimFromA.state, 'ACTIVE');

  // Because serviceB owns its own in-memory ClaimAuthority, it has no idea
  // serviceA holds this territory -- this is the documented limitation, not
  // a bug: real cross-process fencing requires either one shared process
  // (getSharedClaimService) or a shared controlStore.
  const claimFromB = await serviceB.acquireClaim({
    holderId: 'lane:on-b', scope: territory, ttlMs: 5_000, policyRevisionId: 'policy:v1',
  });
  assert.equal(claimFromB.state, 'ACTIVE');
});

test('getSharedClaimService returns one shared in-process instance so unrelated call sites fence each other', async () => {
  resetSharedClaimServiceForTests();
  const territory = fileScope('packages/internal-vcs/src/services/governance-service.js');

  const supervisorCallSiteOne = getSharedClaimService({ clock: () => 1_000 });
  const supervisorCallSiteTwo = getSharedClaimService({ clock: () => 1_000 }); // options ignored on 2nd+ call
  assert.equal(supervisorCallSiteOne, supervisorCallSiteTwo, 'must be the identical shared instance, not a lookalike');

  await supervisorCallSiteOne.acquireClaim({
    holderId: 'lane:first-caller', scope: territory, ttlMs: 5_000, policyRevisionId: 'policy:v1',
  });

  await assert.rejects(
    supervisorCallSiteTwo.acquireClaim({
      holderId: 'lane:second-caller', scope: territory, ttlMs: 5_000, policyRevisionId: 'policy:v1',
    }),
    (error) => error.code === VCS_ERROR_CODES.LEASE_CONFLICT,
    'the shared binding must see both call sites as one claim table',
  );

  resetSharedClaimServiceForTests();
});

test('binding this module does not rebind the locked unbound-stub contract at ../services/claim-service.js', async () => {
  // claim-service.js must stay unbound (test/unbound-services.test.js locks
  // this); this binding lives entirely alongside it, not inside it.
  await assert.rejects(
    claimServiceStub.acquireClaim({}),
    (error) => error.code === VCS_ERROR_CODES.ADAPTER_UNAVAILABLE,
  );
});

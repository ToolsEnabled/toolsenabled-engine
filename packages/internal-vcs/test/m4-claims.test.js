'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  implementations: { m4: {
    compareScopes,
    createClaimAuthority,
    createLaneLifecycleAuthority,
  } },
} = require('../src');

function scope(id = 'component:a', resourceVersion = 'v1', actions = ['write']) {
  return [{
    namespace: 'project:test',
    kind: 'component',
    canonicalId: id,
    ancestorIds: id.includes('/') ? ['component:a'] : [],
    actions,
    resourceVersion,
  }];
}

test('concurrent acquisition grants one holder and rejects the overlapping race', () => {
  const authority = createClaimAuthority({ clock: () => 1_000 });
  const first = authority.acquireClaim({ holderId: 'lane:one', scope: scope(), ttlMs: 1_000, policyRevisionId: 'policy:v1' });
  assert.equal(first.fenceToken, 1);
  assert.throws(() => authority.acquireClaim({
    holderId: 'lane:two', scope: scope(), ttlMs: 1_000, policyRevisionId: 'policy:v1',
  }), error => error.code === 'VCS_LEASE_CONFLICT');
  assert.equal(authority.inspectClaim({ scope: scope() }).state, 'UNSAFE');
});

test('stale holder resume cannot reuse an earlier fence', () => {
  let now = 1_000;
  const authority = createClaimAuthority({ clock: () => now });
  const first = authority.acquireClaim({ holderId: 'lane:one', scope: scope(), ttlMs: 1_000, policyRevisionId: 'policy:v1' });
  const stale = authority.bindingFor(first);
  authority.releaseClaim({ binding: stale, reason: 'handoff' });
  now += 1;
  const second = authority.acquireClaim({ holderId: 'lane:two', scope: scope(), ttlMs: 1_000, policyRevisionId: 'policy:v1' });
  assert.equal(second.fenceToken, 2);
  assert.throws(() => authority.validateFence(stale), error => error.code === 'VCS_FENCE_STALE');
  assert.equal(authority.validateFence(authority.bindingFor(second)).holderId, 'lane:two');
});

test('expiry and revocation fail closed at the protected write boundary', () => {
  let now = 1_000;
  const authority = createClaimAuthority({ clock: () => now, maxTtlMs: 5_000 });
  const expiring = authority.acquireClaim({ holderId: 'lane:one', scope: scope(), ttlMs: 100, policyRevisionId: 'policy:v1' });
  const expiringBinding = authority.bindingFor(expiring);
  now = 1_101;
  assert.throws(() => authority.validateFence(expiringBinding), error => error.code === 'VCS_CLAIM_EXPIRED');

  const active = authority.acquireClaim({ holderId: 'lane:two', scope: scope(), ttlMs: 500, policyRevisionId: 'policy:v1' });
  const activeBinding = authority.bindingFor(active);
  authority.revokeClaim({ binding: activeBinding, reason: 'authority revoked' });
  assert.throws(() => authority.validateFence(activeBinding), error => error.code === 'VCS_CLAIM_REVOKED');
});

test('heartbeat renews time without decreasing or reusing the fence', () => {
  let now = 1_000;
  const authority = createClaimAuthority({ clock: () => now, maxTtlMs: 5_000 });
  const claim = authority.acquireClaim({ holderId: 'lane:one', scope: scope(), ttlMs: 100, policyRevisionId: 'policy:v1' });
  now = 1_050;
  const renewed = authority.heartbeatClaim({ binding: authority.bindingFor(claim), ttlMs: 500 });
  assert.equal(renewed.fenceToken, claim.fenceToken);
  assert.equal(renewed.expiresAt, new Date(1_550).toISOString());
  assert.notEqual(renewed.authoritySnapshotId, claim.authoritySnapshotId);
  assert.throws(() => authority.validateFence(authority.bindingFor(claim)), error => error.code === 'VCS_FENCE_STALE');
});

test('partitions produce quarantined proposals that require a new live claim and every revalidation', () => {
  const claims = createClaimAuthority({ clock: () => 1_000 });
  const lanes = createLaneLifecycleAuthority({ claimAuthority: claims, clock: () => 1_000 });
  const proposal = lanes.registerOfflineProposal({
    proposalId: 'proposal:offline', creatorId: 'lane:offline', baseAuthoritySnapshotId: 'snapshot:old',
    revisionManifestId: 'revision:draft', requiredRevalidationIds: ['policy', 'closure', 'conflicts'],
  });
  assert.equal(proposal.state, 'QUARANTINED');
  const claim = claims.acquireClaim({ holderId: 'lane:offline', scope: scope(), ttlMs: 1_000, policyRevisionId: 'policy:v1' });
  const binding = claims.bindingFor(claim);
  assert.throws(() => lanes.revalidateOfflineProposal({
    proposalId: proposal.proposalId, binding, completedRevalidationIds: ['policy', 'closure'],
  }), error => error.code === 'VCS_PROPOSAL_QUARANTINED');
  assert.equal(lanes.revalidateOfflineProposal({
    proposalId: proposal.proposalId, binding, completedRevalidationIds: ['policy', 'closure', 'conflicts'],
  }).state, 'SUBMITTED');
});

test('lane registration rejects duplicate dispatch and holder mismatch', () => {
  const claims = createClaimAuthority({ clock: () => 1_000 });
  const lanes = createLaneLifecycleAuthority({ claimAuthority: claims, clock: () => 1_000 });
  const claim = claims.acquireClaim({ holderId: 'lane:one', scope: scope(), ttlMs: 1_000, policyRevisionId: 'policy:v1' });
  const binding = claims.bindingFor(claim);
  lanes.registerLane({ laneId: 'lane:one', holderId: 'lane:one', territory: scope(), protectedArtifactIds: ['artifact:a'], worktreeId: 'worktree:one', binding });
  assert.throws(() => lanes.registerLane({
    laneId: 'lane:one', holderId: 'lane:one', territory: scope(), protectedArtifactIds: [], worktreeId: 'worktree:two', binding,
  }), error => error.code === 'VCS_LEASE_CONFLICT');
  assert.throws(() => lanes.registerLane({
    laneId: 'lane:other', holderId: 'lane:other', territory: scope('component:a/child'), protectedArtifactIds: [], worktreeId: 'worktree:two', binding,
  }), error => ['VCS_UNAUTHORIZED', 'VCS_LEASE_CONFLICT'].includes(error.code));
});

test('cleanup refuses active or unclassified lanes and accepts complete recovery evidence', () => {
  const claims = createClaimAuthority({ clock: () => 1_000 });
  const lanes = createLaneLifecycleAuthority({ claimAuthority: claims, clock: () => 1_000 });
  const claim = claims.acquireClaim({ holderId: 'lane:one', scope: scope(), ttlMs: 1_000, policyRevisionId: 'policy:v1' });
  const binding = claims.bindingFor(claim);
  lanes.registerLane({ laneId: 'lane:one', holderId: 'lane:one', territory: scope(), protectedArtifactIds: [], worktreeId: 'worktree:one', binding });
  const inventory = {
    inventoryId: 'inventory:one', authoritySnapshotId: 'snapshot:one', trackedIds: ['tracked:a'],
    untrackedIds: [], ignoredIds: [], nestedIds: [], externalIds: [], refIds: [], reflogIds: [], unreachableObjectIds: [], unclassifiedIds: [],
  };
  assert.throws(() => lanes.planReap({ laneId: 'lane:one', inventory, binding, policyRevisionId: 'policy:v1', recoveryRecordIds: ['recovery:one'] }), error => error.code === 'VCS_CLEANUP_REFUSED');
  lanes.markLaneState({ laneId: 'lane:one', state: 'ABANDONED' });
  assert.throws(() => lanes.planReap({
    laneId: 'lane:one', inventory: { ...inventory, unclassifiedIds: ['mystery'] }, binding,
    policyRevisionId: 'policy:v1', recoveryRecordIds: ['recovery:one'],
  }), error => error.code === 'VCS_CLEANUP_REFUSED');
  assert.equal(lanes.planReap({
    laneId: 'lane:one', inventory, binding, policyRevisionId: 'policy:v1', recoveryRecordIds: ['recovery:one'],
  }).state, 'SAFE');
});

test('scope comparison handles hierarchy, semantic aliases, read sharing, and unknown evidence', () => {
  assert.equal(compareScopes(scope('component:a'), scope('component:a/child')).state, 'UNSAFE');
  assert.equal(compareScopes(scope('component:a', 'v1', ['read']), scope('component:a', 'v1', ['read'])).state, 'SAFE');
  assert.equal(compareScopes(scope('component:x'), scope('component:y'), { aliasResolver: () => true }).state, 'UNSAFE');
  assert.equal(compareScopes(scope('component:x', 'UNKNOWN'), scope('component:x')).state, 'UNKNOWN');
});

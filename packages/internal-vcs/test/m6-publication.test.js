'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
  implementations: {
    m4: { createClaimAuthority },
    m6: { createGitCliPublicationAdapter, createReceiptBackedGitPublisher },
  },
} = require('../src');
const { canonicalEncode, hashBytes } = require('../src/m1/canonical');
const { createProcessRunner } = require('../src/m2/process-runner');

const NOW = '2026-08-07T12:00:00.000Z';

function claimFixture(clock = () => NOW) {
  const authority = createClaimAuthority({ clock, maxTtlMs: 60 * 60 * 1000 });
  const claim = authority.acquireClaim({
    holderId: 'lane:publisher',
    scope: [{ namespace: 'project:test', kind: 'git-destination', canonicalId: 'destination:origin', ancestorIds: [], actions: ['publish'], resourceVersion: 'v1' }],
    ttlMs: 60 * 60 * 1000,
    policyRevisionId: 'policy:v1',
  });
  return { authority, binding: authority.bindingFor(claim) };
}

function attestation(revisionId) {
  return {
    policyRevisionId: 'policy:v1',
    immutableInputIds: [revisionId],
    expiresAt: '2026-08-08T12:00:00.000Z',
  };
}

class FakeGitAdapter {
  constructor() {
    this.observation = this.makeObservation([]);
    this.publishResult = { state: 'SAFE', exitCode: 0 };
    this.afterPublish = null;
  }

  makeObservation(refs) {
    const advertisedRefs = refs.map(([refName, objectId]) => ({ refName, objectId }));
    return {
      state: 'SAFE', advertisedRefs, coveredObjectIds: advertisedRefs.map(ref => ref.objectId), observedAt: NOW,
      authoritySnapshotId: hashBytes(canonicalEncode(advertisedRefs)),
    };
  }

  observeDestination() { return this.observation; }

  publish() {
    if (this.afterPublish) this.observation = this.afterPublish;
    return this.publishResult;
  }
}

function plannedPublisher(adapter, clock = () => NOW, namespaces = ['refs/heads/main'], objects = ['git-sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
  const { authority, binding } = claimFixture(clock);
  const publisher = createReceiptBackedGitPublisher({ adapter, claimAuthority: authority, clock, receiptTtlMs: 60_000 });
  const plan = publisher.planPublication({
    revisionId: 'revision:one', destinationId: 'destination:origin', expectedNamespaceIds: namespaces,
    expectedObjectIds: objects, policyRevisionId: 'policy:v1',
  });
  return { publisher, plan, binding };
}

test('failed push and misleading output cannot produce a receipt', () => {
  const adapter = new FakeGitAdapter();
  adapter.publishResult = { state: 'UNSAFE', exitCode: 1, stdout: 'Everything up-to-date' };
  const { publisher, plan, binding } = plannedPublisher(adapter);
  assert.throws(() => publisher.publishRevision({
    planId: plan.planId, refspecs: ['HEAD:refs/heads/main'], binding, policyAttestation: attestation('revision:one'),
  }), error => error.code === 'VCS_DESTINATION_UNPROVEN' && error.details.exitCode === 1);
});

test('omitted custom refs and ghost namespace assumptions fail closed', () => {
  const adapter = new FakeGitAdapter();
  adapter.afterPublish = adapter.makeObservation([['refs/heads/main', 'git-sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']]);
  const { publisher, plan, binding } = plannedPublisher(adapter, () => NOW, ['refs/heads/main', 'refs/custom/*']);
  assert.throws(() => publisher.publishRevision({
    planId: plan.planId, refspecs: ['HEAD:refs/heads/main'], binding, policyAttestation: attestation('revision:one'),
  }), error => error.code === 'VCS_DESTINATION_UNPROVEN' && error.details.missingNamespaceIds.includes('refs/custom/*'));
});

test('destination drift between plan and apply blocks publication', () => {
  const adapter = new FakeGitAdapter();
  const { publisher, plan, binding } = plannedPublisher(adapter);
  adapter.observation = adapter.makeObservation([['refs/heads/other', 'git-sha1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']]);
  assert.throws(() => publisher.publishRevision({
    planId: plan.planId, refspecs: ['HEAD:refs/heads/main'], binding, policyAttestation: attestation('revision:one'),
  }), error => error.code === 'VCS_DESTINATION_UNPROVEN' && /drifted/.test(error.message));
});

test('expired or drifted receipts cannot authorize cleanup', () => {
  let now = NOW;
  const clock = () => now;
  const adapter = new FakeGitAdapter();
  adapter.afterPublish = adapter.makeObservation([['refs/heads/main', 'git-sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']]);
  const { publisher, plan, binding } = plannedPublisher(adapter, clock);
  const receipt = publisher.publishRevision({ planId: plan.planId, refspecs: ['HEAD:refs/heads/main'], binding, policyAttestation: attestation('revision:one') });
  assert.equal(publisher.authorizeCleanup({ receiptId: receipt.receiptId, binding }).freshness, 'FRESH');
  adapter.observation = adapter.makeObservation([['refs/heads/main', 'git-sha1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']]);
  assert.throws(() => publisher.authorizeCleanup({ receiptId: receipt.receiptId, binding }), error => error.code === 'VCS_CLEANUP_REFUSED');
  adapter.observation = adapter.afterPublish;
  now = '2026-08-07T12:02:00.000Z';
  assert.throws(() => publisher.authorizeCleanup({ receiptId: receipt.receiptId, binding }), error => error.code === 'VCS_CLEANUP_REFUSED');
});

test('the real Git adapter atomically publishes required standard and custom refs and verifies them from the destination', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-vcs-m6-'));
  const repository = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  const run = (cwd, argv) => {
    const result = childProcess.spawnSync('git', argv, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
    assert.equal(result.status, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(repository);
    run(root, ['init', '--bare', remote]);
    run(repository, ['init']);
    run(repository, ['config', 'user.name', 'M6 Fixture']);
    run(repository, ['config', 'user.email', 'm6@example.invalid']);
    fs.writeFileSync(path.join(repository, 'file.txt'), 'receipt-backed\n');
    run(repository, ['add', 'file.txt']);
    run(repository, ['commit', '-m', 'fixture']);
    run(repository, ['branch', '-M', 'main']);
    run(repository, ['remote', 'add', 'origin', remote]);
    run(repository, ['update-ref', 'refs/custom/evidence', 'HEAD']);
    const oid = run(repository, ['rev-parse', 'HEAD']);
    const qualified = `${oid.length === 40 ? 'git-sha1' : 'git-sha256'}:${oid}`;
    const runner = createProcessRunner({ defaultTimeoutMs: 30_000, defaultMaxOutputBytes: 4 * 1024 * 1024 });
    const adapter = createGitCliPublicationAdapter({ runner, repositoryLocator: repository, remoteName: 'origin', clock: () => NOW });
    const { authority, binding } = claimFixture();
    const publisher = createReceiptBackedGitPublisher({ adapter, claimAuthority: authority, clock: () => NOW });
    const plan = publisher.planPublication({
      revisionId: 'revision:real-git', destinationId: 'destination:origin',
      expectedNamespaceIds: ['refs/custom/*', 'refs/heads/main'], expectedObjectIds: [qualified], policyRevisionId: 'policy:v1',
    });
    const receipt = publisher.publishRevision({
      planId: plan.planId,
      refspecs: ['refs/custom/evidence:refs/custom/evidence', 'refs/heads/main:refs/heads/main'],
      binding,
      policyAttestation: attestation('revision:real-git'),
    });
    assert.equal(receipt.freshness, 'FRESH');
    assert.deepEqual(receipt.coveredNamespaceIds, ['refs/custom/*', 'refs/heads/main']);
    assert.ok(receipt.coveredObjectIds.includes(qualified));
    assert.equal(run(repository, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

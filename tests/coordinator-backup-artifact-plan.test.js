'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const planner = require('../src/lib/coordinator/backup-artifact-plan.js');

let passed = 0;
function check(name, fn) { fn(); passed += 1; process.stdout.write(`  ok  ${name}\n`); }
function input(overrides = {}) {
  return {
    rootBinding: planner.ROOT_BINDING,
    snapshotName: 'snapshot-20260729T120000Z',
    createdAt: '2026-07-29T12:00:00.000Z',
    maxSnapshots: 2,
    artifacts: [...planner.REQUIRED_ARTIFACTS],
    existingSnapshotNames: ['snapshot-20260728T120000Z', 'snapshot-20260727T120000Z'],
    ...overrides
  };
}
function run() {
  process.stdout.write('coordinator-backup-artifact-plan\n');
  check('returns a frozen dry-run manifest with a deterministic checksum and no filesystem path', () => {
    const first = planner.buildBackupArtifactPlan(input());
    const second = planner.buildBackupArtifactPlan(input());
    assert.equal(first.valid, true);
    assert.equal(first.plan.mode, 'dry-run');
    assert.equal(first.plan.rootBinding, planner.ROOT_BINDING);
    assert.equal(first.plan.manifest.manifestSha256, second.plan.manifest.manifestSha256);
    assert.match(first.plan.manifest.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.plan.manifest.artifacts.every(artifact => artifact.materialized === false && artifact.contentHash === 'not-produced'), true);
    assert.equal(first.plan.manifest.grantsRestoreAuthority, false);
    assert.equal(first.plan.activation.writesAuthorized, false);
    assert.equal(Object.isFrozen(first.plan), true);
    assert.equal(JSON.stringify(first.plan).includes('C:\\'), false);
  });
  check('retains newest snapshots deterministically and only proposes older candidates', () => {
    const result = planner.buildBackupArtifactPlan(input());
    assert.deepEqual(result.plan.retention, { maxSnapshots: 2, retainSnapshotNames: ['snapshot-20260729T120000Z', 'snapshot-20260728T120000Z'], pruneCandidateSnapshotNames: ['snapshot-20260727T120000Z'], deletionAuthorized: false });
    assert.equal(result.plan.retention.pruneCandidateSnapshotNames.includes(result.plan.snapshotName), false);
  });
  check('rejects any root change, artifact drift, non-canonical timestamp, duplicate history, or unsafe retention size', () => {
    const cases = [input({ rootBinding: 'other-root' }), input({ artifacts: ['vault-state.enc', 'repo.bundle'] }), input({ snapshotName: 'snapshot-20260230T120000Z' }), input({ existingSnapshotNames: ['snapshot-20260728T120000Z', 'snapshot-20260728T120000Z'] }), input({ maxSnapshots: 0 }), input({ maxSnapshots: planner.MAX_RETENTION_SNAPSHOTS + 1 })];
    for (const candidate of cases) {
      const result = planner.buildBackupArtifactPlan(candidate);
      assert.equal(result.valid, false);
      assert.equal(result.plan, null);
      assert.equal(Object.isFrozen(result), true);
    }
  });
  check('does not evaluate hostile input accessors and rejects extra or missing keys', () => {
    let accessed = 0;
    const hostile = input();
    Object.defineProperty(hostile, 'rootBinding', { enumerable: true, get() { accessed += 1; return planner.ROOT_BINDING; } });
    assert.equal(planner.buildBackupArtifactPlan(hostile).valid, false);
    assert.equal(accessed, 0);
    assert.equal(planner.buildBackupArtifactPlan({ ...input(), unexpected: true }).valid, false);
    const missing = input(); delete missing.artifacts;
    assert.equal(planner.buildBackupArtifactPlan(missing).valid, false);
  });
  check('contains no storage, process, task registration, vault read, or live deletion primitive', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coordinator', 'backup-artifact-plan.js'), 'utf8');
    for (const forbidden of [/require\(['\"]node:fs/, /readFile/, /writeFile/, /copyFile/, /rename/, /unlink/, /rmSync/, /exec(?:File)?Sync/, /spawn(?:Sync)?/, /secrets\.ps1/, /schedule/i]) assert.equal(forbidden.test(source), false, `planner source contains forbidden primitive ${forbidden}`);
  });
  process.stdout.write(`\ncoordinator-backup-artifact-plan: ${passed} checks passed\n`);
}
try { run(); } catch (error) { process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`); process.exitCode = 1; }

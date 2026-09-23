/*
 * Mutation check: reversed risk-ranked diff sorting from descending to ascending.
 * The one-line module edit landed (confirmed by matching the mutated source).
 * This isolated test went red with exit code 1 on the risk-order assertion.
 * The module was restored and its original SHA-256 was confirmed afterward.
 */

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const {
  ARTIFACT_KINDS,
  RISK_RANK,
  SCHEMA_VERSION,
  buildReviewPacket
} = require('../../src/lib/coordinator-workflow/review-packet');
const { hashMissionContract } = require('../../src/lib/coordinator-workflow/mission-contract');

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function fixture() {
  const mission = {
    schemaVersion: 2,
    missionId: 'review-packet-test-001',
    missionVersion: 1,
    createdAt: '2026-08-27T00:00:00Z',
    objective: 'Produce a deterministic, risk-ranked review packet.',
    nonGoals: ['Execute the submitted artifacts'],
    workspace: { repository: 'customer_private_mirror', baseSnapshotSha256: digest('base') },
    scope: {
      allowedOperations: ['read_artifacts', 'run_local_tests'],
      allowedPaths: ['src', 'tests'],
      forbiddenPaths: ['vault']
    },
    toolProfileId: 'review_packet_test',
    acceptance: {
      criteria: [{
        id: 'criterion-tests',
        description: 'The isolated test passes.',
        requiredEvidenceTypes: ['command']
      }],
      severityCeiling: 'medium'
    },
    budgets: {
      maxWorkerContextTokens: 2048,
      maxCheckpointTokens: 256,
      maxReviewPacketTokens: 4096,
      maxReviewEvents: 1
    },
    wakeEvents: ['verification_completed']
  };
  const missionHash = hashMissionContract(mission).hash;
  const testHash = digest('tests passed');
  const alphaHash = digest('alpha diff');
  const zetaHash = digest('zeta diff');

  return {
    mission,
    verification: {
      schemaVersion: 1,
      missionId: mission.missionId,
      missionHash,
      createdAt: '2026-08-27T00:01:00Z',
      baseSnapshotSha256: mission.workspace.baseSnapshotSha256,
      checks: [{
        criterionId: 'criterion-tests',
        status: 'pass',
        evidence: [{
          evidenceId: 'evidence-tests',
          type: 'command',
          artifact: { artifactId: 'test-log', sha256: testHash, path: 'artifacts/tests.log' },
          detail: 'The isolated review-packet test passed.'
        }]
      }],
      regressions: { p2f: [], f2p: ['criterion-tests'], p2p: [], f2f: [] }
    },
    artifacts: [
      { artifactId: 'zeta-diff', sha256: zetaHash, path: 'src/zeta.js', kind: 'diff', sizeBytes: 20 },
      { artifactId: 'test-log', sha256: testHash, path: 'artifacts/tests.log', kind: 'test_log', sizeBytes: 12 },
      { artifactId: 'alpha-diff', sha256: alphaHash, path: 'src/alpha.js', kind: 'diff', sizeBytes: 10 }
    ],
    diffExcerpts: [
      { artifactId: 'alpha-diff', path: 'src/alpha.js', risk: 'medium', reason: 'Touches validation.', startLine: 8, endLine: 9, excerpt: 'validate();' },
      { artifactId: 'zeta-diff', path: 'src/zeta.js', risk: 'critical', reason: 'Touches authorization.', startLine: 2, endLine: 2, excerpt: 'authorize();' }
    ],
    unresolved: [
      { id: 'finding-low', severity: 'low', description: 'Minor naming concern.', criterionIds: [] },
      { id: 'finding-medium', severity: 'medium', description: 'Validation needs review.', criterionIds: ['criterion-tests'] }
    ]
  };
}

function assertRefusal(code, mutate, options) {
  const input = fixture();
  mutate(input);
  const before = JSON.stringify(input);
  let writes = 0;
  let spawns = 0;
  const writeFileSync = fs.writeFileSync;
  const appendFileSync = fs.appendFileSync;
  const spawnSync = childProcess.spawnSync;
  const spawn = childProcess.spawn;
  fs.writeFileSync = (...args) => { writes += 1; return writeFileSync(...args); };
  fs.appendFileSync = (...args) => { writes += 1; return appendFileSync(...args); };
  childProcess.spawnSync = (...args) => { spawns += 1; return spawnSync(...args); };
  childProcess.spawn = (...args) => { spawns += 1; return spawn(...args); };
  try {
    assert.throws(
      () => buildReviewPacket(input, options),
      error => error.code === code,
      `expected ${code}`
    );
  } finally {
    fs.writeFileSync = writeFileSync;
    fs.appendFileSync = appendFileSync;
    childProcess.spawnSync = spawnSync;
    childProcess.spawn = spawn;
  }
  assert.equal(JSON.stringify(input), before, `${code} must not mutate caller input`);
  assert.equal(writes, 0, `${code} must not write files`);
  assert.equal(spawns, 0, `${code} must not spawn processes`);
}

function run() {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(ARTIFACT_KINDS, ['diff', 'test_log', 'verification', 'source', 'state']);
  assert.deepEqual(RISK_RANK, { critical: 4, high: 3, medium: 2, low: 1 });

  const input = fixture();
  const result = buildReviewPacket(input, { maxTokens: 4096 });

  assert.deepEqual(result.packet.artifacts.map(item => item.artifactId), ['alpha-diff', 'test-log', 'zeta-diff']);
  assert.deepEqual(result.packet.riskRankedDiffExcerpts.map(item => item.risk), ['critical', 'medium']);
  assert.deepEqual(result.packet.unresolved.map(item => item.severity), ['medium', 'low']);
  assert.equal(result.packet.riskRankedDiffExcerpts[0].artifactSha256, digest('zeta diff'));
  assert.deepEqual(result.packet.verification.criteria[0].evidence[0].artifact, {
    artifactId: 'test-log',
    sha256: digest('tests passed'),
    path: 'artifacts/tests.log'
  });
  assert.equal(result.text, JSON.stringify(result.packet));
  assert.equal(result.bytes, Buffer.byteLength(result.text, 'utf8'));
  assert.ok(result.estimatedTokens <= result.maxTokens);

  input.artifacts[0].path = 'mutated/after/build.js';
  assert.equal(result.packet.artifacts[2].path, 'src/zeta.js', 'the returned packet must not alias its input');

  const overCeiling = fixture();
  overCeiling.unresolved[0].severity = 'high';
  assert.throws(
    () => buildReviewPacket(overCeiling),
    error => error.code === 'COORDINATOR_WORKFLOW_SEVERITY_EXCEEDED'
      && error.details.severityCeiling === 'medium'
      && error.details.unresolvedIds.join(',') === 'finding-low'
  );

  assertRefusal('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', input => {
    input.artifacts[0].kind = 'archive';
  });
  assertRefusal('COORDINATOR_WORKFLOW_CRITERION_UNKNOWN', input => {
    input.unresolved[1].criterionIds = ['criterion-unknown'];
  });
  assertRefusal('COORDINATOR_WORKFLOW_DIFF_INVALID', input => {
    input.diffExcerpts[0].risk = 'severe';
  });
  assertRefusal('COORDINATOR_WORKFLOW_REVIEW_BUDGET_INVALID', input => {
    input.mission.budgets.maxReviewPacketTokens = 2048;
    input.verification.missionHash = hashMissionContract(input.mission).hash;
  }, { maxTokens: 4096 });
  {
    const input = fixture();
    input.mission.budgets.maxReviewPacketTokens = 256;
    input.verification.missionHash = hashMissionContract(input.mission).hash;
    assertRefusal('COORDINATOR_WORKFLOW_REVIEW_PACKET_OVER_BUDGET', target => {
      Object.assign(target, input);
    });
  }
  assertRefusal('COORDINATOR_WORKFLOW_UNRESOLVED_INVALID', input => {
    input.unresolved[0].severity = 'severe';
  });

  console.log('review-packet behavior: PASS');
}

run();

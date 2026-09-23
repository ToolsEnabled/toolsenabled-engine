/*
 * Mutation: changed `item.status !== 'pass'` to `item.status === 'not-pass'` in assertAcceptanceVerified.
 * Mutation landed: yes, confirmed by matching the replacement text in the module.
 * Isolated result: RED (exit 1), because the expected acceptance-unverified exception was missing.
 */
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SCHEMA_VERSION,
  artifactPointer,
  assertAcceptanceVerified,
  validateVerificationManifest
} = require('../../src/lib/coordinator-workflow/verification-manifest');
const { CoordinatorWorkflowError } = require('../../src/lib/coordinator-workflow/common');
const { hashMissionContract } = require('../../src/lib/coordinator-workflow/mission-contract');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function mission() {
  return {
    schemaVersion: 2,
    missionId: 'verification-behaviour-001',
    missionVersion: 1,
    createdAt: '2026-08-27T12:00:00Z',
    objective: 'Prove verification manifests enforce acceptance evidence.',
    nonGoals: [],
    workspace: { repository: 'customer_private_mirror', baseSnapshotSha256: digest('base') },
    scope: {
      allowedOperations: ['run_local_tests', 'read_repository'],
      allowedPaths: ['src', 'tests'],
      forbiddenPaths: []
    },
    toolProfileId: 'verification_profile',
    acceptance: {
      criteria: [
        { id: 'criterion-tests', description: 'Tests pass.', requiredEvidenceTypes: ['command'] },
        { id: 'criterion-source', description: 'Source is identified.', requiredEvidenceTypes: ['file_hash'] }
      ],
      severityCeiling: 'low'
    },
    budgets: {
      maxWorkerContextTokens: 1024,
      maxCheckpointTokens: 256,
      maxReviewPacketTokens: 1024,
      maxReviewEvents: 2
    },
    wakeEvents: ['verification_completed']
  };
}

function manifest(contract = mission()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    missionId: contract.missionId,
    missionHash: hashMissionContract(contract).hash,
    createdAt: '2026-08-27T12:05:00Z',
    baseSnapshotSha256: contract.workspace.baseSnapshotSha256,
    checks: [
      {
        criterionId: 'criterion-tests',
        status: 'pass',
        evidence: [{
          evidenceId: 'evidence-z-command',
          type: 'command',
          artifact: { artifactId: 'artifact-test-log', sha256: digest('tests'), path: 'artifacts/tests.log' },
          detail: 'The isolated test command exited successfully.'
        }]
      },
      {
        criterionId: 'criterion-source',
        status: 'pass',
        evidence: [{
          evidenceId: 'evidence-a-source',
          type: 'file_hash',
          artifact: {
            artifactId: 'artifact-source', sha256: digest('source'), path: 'src/module.js', startLine: 10, endLine: 15
          },
          detail: 'The source range was content addressed.'
        }]
      }
    ],
    regressions: { p2f: [], f2p: ['check-z', 'check-a'], p2p: [], f2f: [] }
  };
}

function expectCode(action, code) {
  assert.throws(action, error => {
    assert.ok(error instanceof CoordinatorWorkflowError);
    assert.equal(error.code, code);
    return true;
  });
}

function expectRefusalWithoutEffects(contract, input, code) {
  const beforeContract = structuredClone(contract);
  const beforeInput = structuredClone(input);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-manifest-refusal-'));
  const previousDirectory = process.cwd();
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  let spawnCount = 0;
  childProcess.spawn = (...args) => {
    spawnCount += 1;
    return originalSpawn(...args);
  };
  childProcess.spawnSync = (...args) => {
    spawnCount += 1;
    return originalSpawnSync(...args);
  };

  try {
    process.chdir(sandbox);
    expectCode(() => validateVerificationManifest(input, contract), code);
    assert.deepEqual(input, beforeInput, `${code} must not mutate the refused manifest`);
    assert.deepEqual(contract, beforeContract, `${code} must not mutate the mission contract`);
    assert.deepEqual(fs.readdirSync(sandbox), [], `${code} must not write files`);
    assert.equal(spawnCount, 0, `${code} must not spawn a process`);
  } finally {
    process.chdir(previousDirectory);
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function run() {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(
    artifactPointer({ artifactId: 'artifact-one', sha256: digest('one'), path: 'logs/out.txt', startLine: 2, endLine: 4 }, 'pointer'),
    { artifactId: 'artifact-one', sha256: digest('one'), path: 'logs/out.txt', startLine: 2, endLine: 4 }
  );
  expectCode(
    () => artifactPointer({ artifactId: 'artifact-one', sha256: digest('one'), path: 'logs/out.txt', startLine: 1, endLine: 502 }, 'pointer'),
    'COORDINATOR_WORKFLOW_POINTER_INVALID'
  );

  const contract = mission();
  const input = manifest(contract);
  const validated = validateVerificationManifest(input, contract);
  assert.notStrictEqual(validated, input, 'validation returns a defensive clone');
  assert.deepEqual(validated.checks.map(item => item.criterionId), ['criterion-source', 'criterion-tests']);
  assert.deepEqual(validated.regressions.f2p, ['check-a', 'check-z']);
  assert.deepEqual(assertAcceptanceVerified(input, contract), validated);

  const missingEvidence = manifest(contract);
  missingEvidence.checks[0].evidence = [];
  expectCode(() => validateVerificationManifest(missingEvidence, contract), 'COORDINATOR_WORKFLOW_EVIDENCE_MISSING');

  const incomplete = manifest(contract);
  incomplete.checks[0].status = 'fail';
  expectCode(() => assertAcceptanceVerified(incomplete, contract), 'COORDINATOR_WORKFLOW_ACCEPTANCE_UNVERIFIED');

  const regressed = manifest(contract);
  regressed.regressions.p2f = ['criterion-tests'];
  expectCode(() => assertAcceptanceVerified(regressed, contract), 'COORDINATOR_WORKFLOW_REGRESSION_DETECTED');

  const unknownCriterion = manifest(contract);
  unknownCriterion.checks[0].criterionId = 'criterion-unknown';
  expectRefusalWithoutEffects(contract, unknownCriterion, 'COORDINATOR_WORKFLOW_CRITERION_UNKNOWN');

  const invalidEvidence = manifest(contract);
  invalidEvidence.checks[0].evidence[0].type = 'unsupported_type';
  expectRefusalWithoutEffects(contract, invalidEvidence, 'COORDINATOR_WORKFLOW_EVIDENCE_INVALID');

  const wrongMission = manifest(contract);
  wrongMission.missionId = 'different-mission-001';
  expectRefusalWithoutEffects(contract, wrongMission, 'COORDINATOR_WORKFLOW_MISSION_MISMATCH');

  const invalidRegression = manifest(contract);
  invalidRegression.regressions.p2f = null;
  expectRefusalWithoutEffects(contract, invalidRegression, 'COORDINATOR_WORKFLOW_REGRESSION_INVALID');

  const wrongSnapshot = manifest(contract);
  wrongSnapshot.baseSnapshotSha256 = digest('different-base');
  expectRefusalWithoutEffects(contract, wrongSnapshot, 'COORDINATOR_WORKFLOW_SNAPSHOT_MISMATCH');

  const invalidVerification = manifest(contract);
  invalidVerification.checks[0].status = 'nope';
  expectRefusalWithoutEffects(contract, invalidVerification, 'COORDINATOR_WORKFLOW_VERIFICATION_INVALID');

  process.stdout.write('verification-manifest behaviour: ok\n');
}

run();

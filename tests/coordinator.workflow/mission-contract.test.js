/*
 * Mutation check: changed `const SCHEMA_VERSION = 2;` to `const SCHEMA_VERSION = 3;`
 * in src/lib/coordinator-workflow/mission-contract.js.
 * The edit landed, and this isolated test went red with exit code 1.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  EVIDENCE_TYPES,
  OPERATIONS,
  SCHEMA_VERSION,
  WAKE_EVENTS,
  hashMissionContract,
  renderCompactMission,
  validateMissionContract
} = require('../../src/lib/coordinator-workflow/mission-contract');
const { CoordinatorWorkflowError } = require('../../src/lib/coordinator-workflow/common');

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function mission() {
  return {
    schemaVersion: 2,
    missionId: 'mission-contract-test',
    missionVersion: 3,
    createdAt: '2026-08-27T12:00:00Z',
    objective: 'Prove the mission contract is validated and rendered.',
    nonGoals: ['Deploy changes'],
    workspace: { repository: 'customer_private_mirror', baseSnapshotSha256: digest('base') },
    scope: {
      allowedOperations: ['run_local_tests', 'read_repository'],
      allowedPaths: ['tests/z', 'src/lib'],
      forbiddenPaths: ['secrets', '.git']
    },
    toolProfileId: 'local_tester',
    acceptance: {
      criteria: [
        { id: 'tests-pass', description: 'The focused test passes.', requiredEvidenceTypes: ['file_hash', 'command'] },
        { id: 'report-written', description: 'The report records red and green.', requiredEvidenceTypes: ['artifact_hash'] }
      ],
      severityCeiling: 'low'
    },
    budgets: {
      maxWorkerContextTokens: 4096,
      maxCheckpointTokens: 512,
      maxReviewPacketTokens: 1024,
      maxReviewEvents: 2
    },
    wakeEvents: ['verification_completed', 'failed', 'completed']
  };
}

function expectWorkflowError(action, code) {
  assert.throws(action, error => {
    assert.ok(error instanceof CoordinatorWorkflowError);
    assert.equal(error.code, code);
    return true;
  });
}

function run() {
  assert.equal(SCHEMA_VERSION, 2);
  assert.ok(OPERATIONS.includes('run_local_tests'));
  assert.ok(EVIDENCE_TYPES.includes('command'));
  assert.ok(WAKE_EVENTS.includes('verification_completed'));
  assert.ok(Object.isFrozen(OPERATIONS));

  const input = mission();
  const validated = validateMissionContract(input);
  assert.notStrictEqual(validated, input);
  assert.deepEqual(validated.scope.allowedOperations, ['read_repository', 'run_local_tests']);
  assert.deepEqual(validated.scope.allowedPaths, ['src/lib', 'tests/z']);
  assert.deepEqual(validated.scope.forbiddenPaths, ['.git', 'secrets']);
  assert.deepEqual(validated.acceptance.criteria.map(item => item.id), ['report-written', 'tests-pass']);
  assert.deepEqual(validated.acceptance.criteria[1].requiredEvidenceTypes, ['command', 'file_hash']);
  assert.deepEqual(validated.wakeEvents, ['completed', 'failed', 'verification_completed']);

  const firstHash = hashMissionContract(input);
  const reordered = mission();
  reordered.scope.allowedOperations.reverse();
  reordered.scope.allowedPaths.reverse();
  reordered.acceptance.criteria.reverse();
  reordered.wakeEvents.reverse();
  assert.equal(hashMissionContract(reordered).hash, firstHash.hash, 'canonical hash must ignore order for set-like fields');
  assert.equal(firstHash.hash, digest(firstHash.canonical));

  const rendered = renderCompactMission(input);
  assert.equal(rendered.hash, firstHash.hash);
  assert.match(rendered.text, new RegExp(`^MISSION mission-contract-test@3 ${firstHash.hash}`));
  assert.match(rendered.text, /SCOPE operations=read_repository,run_local_tests allowed=src\/lib,tests\/z forbidden=\.git,secrets/);
  assert.match(rendered.text, /report-written: "The report records red and green\." \[artifact_hash\]/);
  assert.ok(rendered.estimatedTokens > 0);

  expectWorkflowError(() => validateMissionContract({ ...mission(), schemaVersion: 1 }), 'COORDINATOR_WORKFLOW_VERSION_INVALID');
  expectWorkflowError(() => validateMissionContract({
    ...mission(),
    scope: { ...mission().scope, forbiddenPaths: ['SRC/lib'] }
  }), 'COORDINATOR_WORKFLOW_SCOPE_INVALID');
  expectWorkflowError(() => renderCompactMission(input, { maxTokens: 128 }), 'COORDINATOR_WORKFLOW_MISSION_RENDER_OVER_BUDGET');
  expectWorkflowError(() => validateMissionContract({ ...mission(), wakeEvents: ['unknown_event'] }), 'COORDINATOR_WORKFLOW_WAKE_INVALID');

  process.stdout.write('mission-contract behavior tests passed\n');
}

run();

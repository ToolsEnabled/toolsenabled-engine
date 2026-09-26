/*
 * Mutation proof: changing each covered refusal code to BROKER_INVALID was
 * printed from the edited module and made this isolated file exit 1. After
 * each run the source matched its original SHA-256.
 */

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  EXECUTION_ROLES,
  SCHEMA_VERSION,
  deriveBrokerVerification,
  deriveRegressions,
  validateBrokerRecord
} = require('../../src/lib/coordinator-workflow/broker-verification');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function mission() {
  return {
    schemaVersion: 2,
    missionId: 'broker-refusal-coverage-001',
    missionVersion: 1,
    createdAt: '2026-08-27T12:00:00Z',
    objective: 'Prove broker verification refusals execute before side effects.',
    nonGoals: [],
    workspace: { repository: 'customer_private_mirror', baseSnapshotSha256: digest('base') },
    scope: { allowedOperations: ['run_local_tests'], allowedPaths: ['src'], forbiddenPaths: [] },
    toolProfileId: 'broker_refusal_profile',
    acceptance: {
      criteria: [{ id: 'criterion-tests', description: 'Tests pass.', requiredEvidenceTypes: ['command'] }],
      severityCeiling: 'medium'
    },
    budgets: { maxWorkerContextTokens: 1024, maxCheckpointTokens: 256, maxReviewPacketTokens: 1024, maxReviewEvents: 2 },
    wakeEvents: ['verification_completed']
  };
}

function withoutWritesOrSpawns(action) {
  const calls = [];
  const replacements = [
    [fs, 'writeFileSync'], [fs, 'appendFileSync'], [fs, 'mkdirSync'],
    [childProcess, 'spawn'], [childProcess, 'spawnSync'], [childProcess, 'exec'], [childProcess, 'execSync']
  ];
  const originals = replacements.map(([owner, name]) => [owner, name, owner[name]]);
  for (const [owner, name] of replacements) owner[name] = () => { calls.push(name); throw new Error(`unexpected ${name}`); };
  try {
    action();
  } finally {
    for (const [owner, name, original] of originals) owner[name] = original;
  }
  assert.deepEqual(calls, [], 'a refusal must not write files or spawn processes');
}

function expectCode(action, code, messagePattern) {
  let result = Symbol('not-called');
  withoutWritesOrSpawns(() => {
    assert.throws(() => { result = action(); }, error => {
      assert.equal(error.code, code);
      assert.match(error.message, messagePattern);
      return true;
    });
  });
  assert.equal(typeof result, 'symbol', 'a refusing operation must not return a record');
}

function manifest(statuses) {
  return {
    checks: Object.entries(statuses).map(([criterionId, status]) => ({ criterionId, status }))
  };
}

function expectBrokerError(action, messagePattern) {
  assert.throws(action, error => {
    assert.equal(error.code, 'COORDINATOR_WORKFLOW_BROKER_INVALID');
    assert.match(error.message, messagePattern);
    return true;
  });
}

function run() {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(EXECUTION_ROLES, ['baseline', 'candidate']);
  assert.ok(Object.isFrozen(EXECUTION_ROLES));

  const regressions = deriveRegressions(
    manifest({ staysPassing: 'pass', newlyFailing: 'pass', newlyPassing: 'fail', staysFailing: 'fail' }),
    manifest({ staysFailing: 'fail', newlyPassing: 'pass', newlyFailing: 'fail', staysPassing: 'pass' })
  );
  assert.deepEqual(regressions, {
    p2f: ['newlyFailing'],
    f2p: ['newlyPassing'],
    p2p: ['staysPassing'],
    f2f: ['staysFailing']
  });

  expectBrokerError(
    () => deriveRegressions(manifest({ covered: 'pass' }), manifest({ different: 'pass' })),
    /identical criterion ids/
  );
  expectBrokerError(
    () => deriveRegressions(manifest({ covered: 'pass' }), manifest({ covered: 'skipped' })),
    /Skipped verification cannot be classified/
  );

  let resolverCalls = 0;
  const invalidArtifactInput = {
    trustedRoot: '/trusted', runId: 'run-refusal-001', mission: mission(), executionRole: 'candidate',
    executionId: 'execution-refusal-001', workspacePath: 'run-refusal-001/candidate',
    artifacts: [{ artifactId: 'artifact-refusal-001', path: 'artifacts/output.bin', kind: 'unsupported' }],
    checks: [{ criterionId: 'criterion-tests', status: 'pass', evidence: [] }],
    execution: { exitCode: 0, signal: null, timedOut: false }, executedAt: '2026-08-27T12:05:00Z'
  };
  expectCode(
    () => deriveBrokerVerification(invalidArtifactInput, () => { resolverCalls += 1; return []; }),
    'COORDINATOR_WORKFLOW_ARTIFACT_INVALID', /kind is unsupported/
  );
  assert.equal(resolverCalls, 0, 'unsupported artifact kinds refuse before artifact resolution');

  const mismatchedRecord = {
    schemaVersion: 1, runId: 'run-refusal-001', missionId: 'different-mission-001', missionHash: digest('different'),
    executionRole: 'candidate', executionId: 'execution-refusal-001', workspacePath: 'run-refusal-001/candidate',
    executedAt: '2026-08-27T12:05:00Z', execution: null, artifacts: null, snapshot: null, manifest: null
  };
  const originalRecord = structuredClone(mismatchedRecord);
  expectCode(
    () => validateBrokerRecord(mismatchedRecord, mission(), 'candidate'),
    'COORDINATOR_WORKFLOW_MISSION_MISMATCH', /not bound to this mission contract/
  );
  assert.deepEqual(mismatchedRecord, originalRecord, 'mission mismatch refusal must not mutate the persisted record');

  process.stdout.write('broker-verification behavior tests passed\n');
}

run();

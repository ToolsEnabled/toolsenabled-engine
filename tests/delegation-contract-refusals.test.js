'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const effects = { writes: 0, spawns: 0 };
const restore = [];
for (const name of ['appendFile', 'appendFileSync', 'createWriteStream', 'writeFile', 'writeFileSync']) {
  const original = fs[name];
  fs[name] = (...args) => { effects.writes += 1; return original(...args); };
  restore.push(() => { fs[name] = original; });
}
for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
  const original = childProcess[name];
  childProcess[name] = (...args) => { effects.spawns += 1; return original(...args); };
  restore.push(() => { childProcess[name] = original; });
}

try {
  const contracts = require('../src/lib/delegation-contracts');
  const hash = character => character.repeat(64);
  const delegationId = `dlg_${'A'.repeat(16)}`;
  const snapshot = { rootId: 'release-root', commitSha1: 'b'.repeat(40), treeSha256: hash('c') };
  const task = {
    schemaVersion: 1,
    delegationId,
    goalId: 'release-goal',
    phaseId: 'verify-phase',
    role: 'deterministic_verification',
    baseSnapshot: snapshot,
    acceptanceCriteria: ['tests-green'],
    capabilityProfileHash: hash('d'),
    budgets: { maxWallMs: 10_000, maxModelTokens: 100, maxToolCalls: 2, maxEvidenceBytes: 1024 },
    terminalStates: ['complete']
  };
  const result = {
    schemaVersion: 1,
    workerResultId: `wrk_${'B'.repeat(16)}`,
    delegationId,
    attempt: 1,
    terminalState: 'failed',
    baseSnapshot: snapshot,
    capabilityProfileHash: hash('d'),
    artifacts: [],
    verification: { state: 'failed', criterionIds: ['tests-green'], evidenceRefs: [] },
    blockerCode: null,
    usage: { modelTokens: 1, toolCalls: 1, wallMs: 1000, usageRecordRefs: [] },
    brokerAcceptanceState: 'UNACCEPTED'
  };

  function refusal(operation, code, message) {
    let returned = false;
    let error;
    assert.throws(() => {
      operation();
      returned = true;
    }, thrown => {
      error = thrown;
      return thrown instanceof contracts.DelegationContractError;
    });
    assert.equal(returned, false, `${code} must throw rather than return`);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
  }

  const versionCases = [
    ['DelegatedTask', () => ({ ...task, schemaVersion: 2 }), contracts.validateDelegatedTask],
    ['WorkerResult', () => ({ ...result, schemaVersion: 2 }), contracts.validateWorkerResult],
    ['EvidenceBundle', () => ({ schemaVersion: 2, bundleId: `evb_${'C'.repeat(16)}`, delegationId, workerResultHash: hash('e'), records: [] }), contracts.validateEvidenceBundle],
    ['EscalationPacket', () => ({ schemaVersion: 2, escalationId: `esc_${'D'.repeat(16)}`, delegationId, disputedDecisionCode: 'evidence-conflict', verifiedFactRefs: ['evidence.receipt'], failedCriteria: [], evidenceBundleHash: hash('f'), requestedDecision: 'resolve_evidence' }), contracts.validateEscalationPacket]
  ];
  for (const [label, input, validate] of versionCases) {
    refusal(() => validate(input()), 'DELEGATION_CONTRACT_VERSION_UNSUPPORTED', `${label} schema version is unsupported.`);
  }

  refusal(
    () => contracts.assertResultForTask(task, result),
    'DELEGATION_CONTRACT_TERMINAL_STATE_DENIED',
    'WorkerResult terminal state was not permitted by DelegatedTask.'
  );
  assert.deepEqual(effects, { writes: 0, spawns: 0 }, 'refusals must not write or spawn');
} finally {
  for (const undo of restore.reverse()) undo();
}

console.log('delegation contract refusal tests passed');

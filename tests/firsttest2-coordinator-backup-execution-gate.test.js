/* Mutation check:
 * Changed the accepted result's `status: 'blocked'` to `status: 'allowed'` in
 * src/lib/coordinator/backup-execution-gate.js.
 * The edit landed, and this isolated test went red with exit code 1.
 */

'use strict';

const assert = require('node:assert/strict');

const gate = require('../src/lib/coordinator/backup-execution-gate.js');

function validDefinition() {
  return {
    id: 'recurring-backup-definition',
    host: 'coordinator-duty-host',
    mode: 'report-only',
    intervalMs: 3_600_000,
    destinationKind: 'local-directory',
    retentionMaxSnapshots: 14,
    plannedArtifacts: [
      'git-bundle',
      'vault-state-copy',
      'manifest-sha256',
      'retention-prune'
    ],
    safety: {
      registerScheduledTask: false,
      createArtifacts: false,
      deleteArtifacts: false,
      readVaultContents: false,
      readDestinationMetadata: true
    }
  };
}

function assertExecutionRemainsUnauthorized(result) {
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.activationRequired, true);
  assert.equal(result.artifactsCreated, 0);
  assert.equal(result.artifactsDeleted, 0);
  assert.equal(result.scheduledTaskRegistered, false);
  assert.equal(result.vaultContentsRead, false);
  assert.equal(result.backupExistence, 'not-asserted');
  assert.equal(result.contentTrust, 'untrusted');
}

const accepted = gate.evaluateBackupExecutionGate(validDefinition());
assert.equal(accepted.status, 'blocked');
assert.equal(accepted.mode, 'report-only');
assert.equal(accepted.intervalMs, 3_600_000);
assert.equal(accepted.retentionMaxSnapshots, 14);
assert.deepEqual(accepted.plannedArtifacts, validDefinition().plannedArtifacts);
assertExecutionRemainsUnauthorized(accepted);

const attemptedExecution = validDefinition();
attemptedExecution.mode = 'execute';
const rejected = gate.evaluateBackupExecutionGate(attemptedExecution);
assert.equal(rejected.status, 'unavailable');
assert.equal(rejected.mode, null);
assert.equal(rejected.intervalMs, null);
assert.deepEqual(rejected.plannedArtifacts, []);
assertExecutionRemainsUnauthorized(rejected);

const explicitFallback = gate.unavailable('ignored input');
assert.deepEqual(explicitFallback, rejected);

for (const result of [accepted, rejected, explicitFallback]) {
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.plannedArtifacts), true);
  assert.equal(Object.isFrozen(result.activationContract), true);
  assert.deepEqual(result.activationContract, {
    schemaVersion: 1,
    kind: 'recurring-backup-activation-request',
    requestState: 'not-present',
    executionAuthorized: false,
    ownerApprovalRequired: true,
    schedulerRegistrationAuthorized: false,
    retentionDeletionAuthorized: false
  });
}

process.stdout.write('firsttest2 coordinator backup execution gate: PASS\n');

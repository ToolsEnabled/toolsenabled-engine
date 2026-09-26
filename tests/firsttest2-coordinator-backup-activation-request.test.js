'use strict';

/* Mutation check:
 * Changed the valid response's executionAuthorized from false to true in
 * src/lib/coordinator/backup-activation-request.js.
 * The mutation landed, and this isolated test went red with exit code 1.
 */

const assert = require('node:assert/strict');
const {
  ARTIFACT_KINDS,
  KIND,
  ROOT_BINDING,
  activationContractSummary,
  unavailable,
  validatePendingActivationRequest
} = require('../src/lib/coordinator/backup-activation-request.js');

const pendingRequest = {
  schemaVersion: 1,
  kind: KIND,
  requestId: 'backup-request-20260827',
  rootBinding: ROOT_BINDING,
  requestedAt: '2026-08-27T12:00:00.000Z',
  artifactKinds: [...ARTIFACT_KINDS],
  retentionMaxSnapshots: 30,
  schedulerRegistrationRequested: false,
  ownerApproval: 'not-approved'
};

const accepted = validatePendingActivationRequest(pendingRequest);
assert.deepEqual(accepted, {
  valid: true,
  errors: [],
  request: {
    schemaVersion: 1,
    kind: 'recurring-backup-activation-request',
    requestId: 'backup-request-20260827',
    rootBinding: 'toolsenabled-backup-root-v1',
    requestedAt: '2026-08-27T12:00:00.000Z',
    artifactKinds: ['git-bundle', 'vault-state-copy', 'manifest-sha256', 'retention-prune'],
    retentionMaxSnapshots: 30,
    ownerApproval: 'not-approved'
  },
  executionAuthorized: false,
  ownerApprovalRequired: true,
  schedulerRegistrationAuthorized: false,
  retentionDeletionAuthorized: false
});
assert.equal(Object.isFrozen(accepted), true);
assert.equal(Object.isFrozen(accepted.request.artifactKinds), true);

for (const invalid of [
  { ...pendingRequest, ownerApproval: 'approved' },
  { ...pendingRequest, schedulerRegistrationRequested: true },
  { ...pendingRequest, retentionMaxSnapshots: 91 }
]) {
  const rejected = validatePendingActivationRequest(invalid);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.request, null);
  assert.equal(rejected.executionAuthorized, false);
}

assert.deepEqual(unavailable(['deliberate reason']), {
  valid: false,
  errors: ['deliberate reason'],
  request: null,
  executionAuthorized: false,
  ownerApprovalRequired: true,
  schedulerRegistrationAuthorized: false,
  retentionDeletionAuthorized: false
});

assert.deepEqual(activationContractSummary(), {
  schemaVersion: 1,
  kind: 'recurring-backup-activation-request',
  requestState: 'not-present',
  executionAuthorized: false,
  ownerApprovalRequired: true,
  schedulerRegistrationAuthorized: false,
  retentionDeletionAuthorized: false
});

process.stdout.write('backup activation request behaviour: ok\n');

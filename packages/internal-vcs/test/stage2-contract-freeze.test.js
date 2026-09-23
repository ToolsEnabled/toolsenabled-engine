'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vcs = require('../src');

test('stage-2 public contracts remain frozen behind the M1-M2 implementation', () => {
  assert.equal(vcs.CONTRACT_NAMES.length, 32);
  assert.equal(Object.keys(vcs.VCS_ERROR_CODES).length, 33);
  assert.deepEqual(Object.fromEntries(Object.entries(vcs.services).map(([name, service]) => [
    name,
    Object.keys(service),
  ])), {
    revisions: ['proposeRevision', 'validateRevision', 'acceptRevision', 'preserveRevision', 'tombstoneRevision', 'getRevision'],
    claims: ['acquireClaim', 'heartbeatClaim', 'releaseClaim', 'inspectClaim'],
    conflicts: ['analyzeConflict', 'recordResolution', 'getConflictSurface'],
    operations: ['planOperation', 'prepareOperation', 'proveOperation', 'applyOperation', 'recoverOperation', 'getOperation'],
    governance: ['recordProvenance', 'getProvenance', 'resolvePolicy', 'evaluatePolicy', 'attestPolicy'],
    backups: ['createBackup', 'verifyBackup', 'restoreBackup', 'getBackup'],
    publication: ['planPublication', 'publishRevision', 'verifyPublishReceipt', 'revalidatePublishReceipt'],
    lifecycle: ['registerOfflineProposal', 'revalidateOfflineProposal', 'recordConsumerObservation', 'invalidateDownstreamState', 'planCleanup', 'applyCleanup'],
  });
});

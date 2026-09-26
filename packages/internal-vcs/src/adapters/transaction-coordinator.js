'use strict';

const { declareAdapter } = require('./contract');

/** Participant prepare/prove/apply/compensate contract; not global atomicity. */
module.exports = declareAdapter('TransactionCoordinator', {
  prepare: { request: 'ParticipantIntent+SnapshotToken+FenceBinding[]', result: 'ParticipantReceipt' },
  prove: { request: 'OperationRecord+SnapshotToken[]', result: 'ProofRecord' },
  apply: { request: 'OperationApplyInput', result: 'OperationOutcome' },
  recover: { request: 'OperationRecoveryInput', result: 'OperationOutcome' },
  compensate: { request: 'RecoveryPlan+ParticipantReceipt[]+FenceBinding[]', result: 'OperationOutcome' },
  inspectParticipant: { request: 'participantId+authoritySnapshotId', result: 'SnapshotToken|VcsError' },
});

'use strict';

const { declareAdapter } = require('./contract');

/** Append-only authority/custody/execution/result evidence sink. */
module.exports = declareAdapter('AuditSink', {
  appendAuditEvent: { request: 'ProvenanceRecord+LifecycleTransition', result: 'ParticipantReceipt' },
  verifyAuditChain: { request: 'range+authoritySnapshotId', result: 'ProofRecord' },
  queryProvenance: { request: 'subjectId+snapshotId?', result: 'ProvenanceRecord[]' },
});

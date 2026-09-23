'use strict';

const { declareAdapter } = require('./contract');

/** Git import/export and destination proof only; never the acceptance authority. */
module.exports = declareAdapter('GitBridge', {
  observeRepository: { request: 'repositoryLocator+requiredNamespaceIds', result: 'SnapshotToken+EvidenceEnvelope' },
  importRevision: { request: 'SnapshotToken+GitObjectIds', result: 'RevisionManifest' },
  publishRevision: { request: 'PublishInput', result: 'PublishReceipt' },
  verifyDestinationReceipt: { request: 'receiptId+currentAuthoritySnapshotId', result: 'PublishReceipt' },
});

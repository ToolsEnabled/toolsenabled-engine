'use strict';

const { declareAdapter } = require('./contract');

/** Authenticated request/receipt boundary; stage 2 defines no wire protocol. */
module.exports = declareAdapter('ServerTransport', {
  serveRequest: { request: 'authenticatedEnvelope', result: 'typedResult|VcsError' },
  discoverCapabilities: { request: 'clientProfile', result: 'serverCapabilityManifest' },
  issueReceipt: { request: 'immutableRequest+authoritySnapshotId', result: 'ParticipantReceipt' },
});

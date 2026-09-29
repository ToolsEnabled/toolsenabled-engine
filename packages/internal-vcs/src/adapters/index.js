'use strict';

module.exports = Object.freeze({
  contentStore: require('./content-store'),
  metadataStore: require('./metadata-store'),
  gitBridge: require('./git-bridge'),
  identityAuthority: require('./identity-authority'),
  policyEvaluator: require('./policy-evaluator'),
  auditSink: require('./audit-sink'),
  clock: require('./clock'),
  transactionCoordinator: require('./transaction-coordinator'),
  backupStore: require('./backup-store'),
  serverTransport: require('./server-transport'),
  processRunner: require('./process-runner'),
  serviceResolver: require('./service-resolver'),
});

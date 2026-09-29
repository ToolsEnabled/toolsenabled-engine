'use strict';

const { VcsError, VCS_ERROR_CODES } = require('./errors');
const lifecycle = require('./lifecycle');
const { CONTRACT_NAMES } = require('./contracts');
const revisionService = require('./services/revision-service');
const claimService = require('./services/claim-service');
const conflictService = require('./services/conflict-service');
const operationService = require('./services/operation-service');
const governanceService = require('./services/governance-service');
const backupService = require('./services/backup-service');
const publicationService = require('./services/publication-service');
const lifecycleService = require('./services/lifecycle-service');
const adapters = require('./adapters');
const configuration = require('./m3/configuration');
const identityPolicy = require('./m3/identity-policy-authority');
const claimAuthority = require('./m4/claim-authority');
const conflictImplementation = require('./m5/conflict-service');
const publicationImplementation = require('./m6/git-publication');
const protectedMainReceiverTransport = require('./m6/protected-main-receiver-transport');
const sagaImplementation = require('./m7/saga-coordinator');
const backupImplementation = require('./m8/backup-service');
const migrationImplementation = require('./m9/protected-stream-migration');
const { createInternalVcsSystem } = require('./m9/internal-vcs-system');

const services = Object.freeze({
  revisions: revisionService,
  claims: claimService,
  conflicts: conflictService,
  operations: operationService,
  governance: governanceService,
  backups: backupService,
  publication: publicationService,
  lifecycle: lifecycleService,
});

module.exports = Object.freeze({
  VcsError,
  VCS_ERROR_CODES,
  CONTRACT_NAMES,
  ...lifecycle,
  services,
  adapters,
  configuration,
  createInternalVcsSystem,
  implementations: Object.freeze({
    m3: identityPolicy,
    m4: claimAuthority,
    m5: conflictImplementation,
    m6: publicationImplementation,
    m7: sagaImplementation,
    m8: backupImplementation,
    m9: migrationImplementation,
  }),
  transport: protectedMainReceiverTransport,
  createFilekeeperProtectedMainReceiverTransport: protectedMainReceiverTransport.createFilekeeperProtectedMainReceiverTransport,
});

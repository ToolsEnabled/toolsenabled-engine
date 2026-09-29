'use strict';

const { unboundService } = require('../unbound-service');

/** @param {{manifest:import('../types').RevisionManifest,claim:import('../types').FenceBinding|null,mode:'CONNECTED'|'OFFLINE_PROPOSAL'}} input @returns {Promise<import('../types').RevisionManifest|import('../types').OfflineProposal>} */
async function proposeRevision(input) { return unboundService('RevisionService.proposeRevision'); }
/** @param {{revisionId:string,expectedPolicyRevisionId:string,expectedAuthoritySnapshotId:string}} input @returns {Promise<import('../types').EvidenceEnvelope>} */
async function validateRevision(input) { return unboundService('RevisionService.validateRevision'); }
/** @param {import('../types').AcceptRevisionInput} input @returns {Promise<import('../types').LifecycleTransition>} */
async function acceptRevision(input) { return unboundService('RevisionService.acceptRevision'); }
/** @param {import('../types').PreserveRevisionInput} input @returns {Promise<import('../types').RetentionRecord>} */
async function preserveRevision(input) { return unboundService('RevisionService.preserveRevision'); }
/** @param {import('../types').TombstoneRevisionInput} input @returns {Promise<import('../types').RetentionRecord>} */
async function tombstoneRevision(input) { return unboundService('RevisionService.tombstoneRevision'); }
/** @param {{revisionId:string,authoritySnapshotId:string|null}} input @returns {Promise<import('../types').RevisionManifest>} */
async function getRevision(input) { return unboundService('RevisionService.getRevision'); }

module.exports = Object.freeze({
  proposeRevision,
  validateRevision,
  acceptRevision,
  preserveRevision,
  tombstoneRevision,
  getRevision,
});

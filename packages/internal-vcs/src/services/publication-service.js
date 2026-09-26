'use strict';

const { unboundService } = require('../unbound-service');

/** @param {{revisionId:string,destinationId:string,expectedNamespaceIds:string[],expectedObjectIds:string[],policyRevisionId:string}} input @returns {Promise<import('../types').ProofRecord>} */
async function planPublication(input) { return unboundService('PublicationService.planPublication'); }
/** @param {import('../types').PublishInput} input @returns {Promise<import('../types').PublishReceipt>} */
async function publishRevision(input) { return unboundService('PublicationService.publishRevision'); }
/** @param {{receiptId:string,expectedAuthoritySnapshotId:string,requiredFreshUntil:string}} input @returns {Promise<import('../types').PublishReceipt>} */
async function verifyPublishReceipt(input) { return unboundService('PublicationService.verifyPublishReceipt'); }
/** @param {{receiptId:string,currentAuthoritySnapshotId:string}} input @returns {Promise<import('../types').InvalidationRecord|null>} */
async function revalidatePublishReceipt(input) { return unboundService('PublicationService.revalidatePublishReceipt'); }

module.exports = Object.freeze({
  planPublication,
  publishRevision,
  verifyPublishReceipt,
  revalidatePublishReceipt,
});

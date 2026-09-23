'use strict';

const { unboundService } = require('../unbound-service');

/** @param {import('../types').OfflineProposal} input @returns {Promise<import('../types').OfflineProposal>} */
async function registerOfflineProposal(input) { return unboundService('LifecycleService.registerOfflineProposal'); }
/** @param {{proposalId:string,newClaim:import('../types').FenceBinding,policyRevisionId:string,currentAuthoritySnapshotId:string}} input @returns {Promise<import('../types').LifecycleTransition>} */
async function revalidateOfflineProposal(input) { return unboundService('LifecycleService.revalidateOfflineProposal'); }
/** @param {{observation:import('../types').ConsumerObservation,fenceBindings:import('../types').FenceBinding[],expectedAuthoritySnapshotId:string}} input @returns {Promise<import('../types').LifecycleTransition>} */
async function recordConsumerObservation(input) { return unboundService('LifecycleService.recordConsumerObservation'); }
/** @param {{subjectId:string,reason:string,currentAuthoritySnapshotId:string,fenceBindings:import('../types').FenceBinding[]}} input @returns {Promise<import('../types').InvalidationRecord>} */
async function invalidateDownstreamState(input) { return unboundService('LifecycleService.invalidateDownstreamState'); }
/** @param {{laneId:string,inventory:import('../types').ArtifactInventory,policyRevisionId:string,fenceBindings:import('../types').FenceBinding[],expectedAuthoritySnapshotId:string}} input @returns {Promise<import('../types').CleanupPlan>} */
async function planCleanup(input) { return unboundService('LifecycleService.planCleanup'); }
/** @param {{cleanupPlan:import('../types').CleanupPlan,fenceBindings:import('../types').FenceBinding[],expectedAuthoritySnapshotId:string,impactPlanId:string}} input @returns {Promise<import('../types').LifecycleTransition>} */
async function applyCleanup(input) { return unboundService('LifecycleService.applyCleanup'); }

module.exports = Object.freeze({
  registerOfflineProposal,
  revalidateOfflineProposal,
  recordConsumerObservation,
  invalidateDownstreamState,
  planCleanup,
  applyCleanup,
});

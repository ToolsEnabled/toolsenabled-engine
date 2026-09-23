'use strict';

const { unboundService } = require('../unbound-service');

/** @param {{participants:import('../types').ParticipantIntent[],recoveryPlan:import('../types').RecoveryPlan,policyRevisionId:string,fenceBindings:import('../types').FenceBinding[],expectedAuthoritySnapshotId:string}} input @returns {Promise<import('../types').OperationRecord>} */
async function planOperation(input) { return unboundService('OperationService.planOperation'); }
/** @param {{operationId:string,participantSnapshotIds:string[],fenceBindings:import('../types').FenceBinding[],expectedAuthoritySnapshotId:string}} input @returns {Promise<import('../types').OperationRecord>} */
async function prepareOperation(input) { return unboundService('OperationService.prepareOperation'); }
/** @param {{operationId:string,snapshotIds:string[],policyAttestationId:string,expectedAuthoritySnapshotId:string}} input @returns {Promise<import('../types').ProofRecord>} */
async function proveOperation(input) { return unboundService('OperationService.proveOperation'); }
/** @param {import('../types').OperationApplyInput} input @returns {Promise<import('../types').OperationOutcome>} */
async function applyOperation(input) { return unboundService('OperationService.applyOperation'); }
/** @param {import('../types').OperationRecoveryInput} input @returns {Promise<import('../types').OperationOutcome>} */
async function recoverOperation(input) { return unboundService('OperationService.recoverOperation'); }
/** @param {{operationId:string,authoritySnapshotId:string|null}} input @returns {Promise<import('../types').OperationRecord>} */
async function getOperation(input) { return unboundService('OperationService.getOperation'); }

module.exports = Object.freeze({
  planOperation,
  prepareOperation,
  proveOperation,
  applyOperation,
  recoverOperation,
  getOperation,
});

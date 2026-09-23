'use strict';

const { unboundService } = require('../unbound-service');

/** @param {{record:import('../types').ProvenanceRecord,fenceBindings:import('../types').FenceBinding[],expectedAuthoritySnapshotId:string}} input @returns {Promise<import('../types').ProvenanceRecord>} */
async function recordProvenance(input) { return unboundService('GovernanceService.recordProvenance'); }
/** @param {{subjectId:string,authoritySnapshotId:string|null}} input @returns {Promise<import('../types').ProvenanceRecord>} */
async function getProvenance(input) { return unboundService('GovernanceService.getProvenance'); }
/** @param {{policyRevisionId:string,consumerAttestationId:string|null}} input @returns {Promise<import('../types').PolicyAttestation>} */
async function resolvePolicy(input) { return unboundService('GovernanceService.resolvePolicy'); }
/** @param {{action:string,subjectId:string,scope:import('../types').ScopeSelector[],policyRevisionId:string,authoritySnapshotId:string}} input @returns {Promise<import('../types').PolicyEvaluation>} */
async function evaluatePolicy(input) { return unboundService('GovernanceService.evaluatePolicy'); }
/** @param {{subjectId:string,policyRevisionId:string,immutableInputIds:string[],evaluationId:string,fenceBindings:import('../types').FenceBinding[],expectedAuthoritySnapshotId:string}} input @returns {Promise<import('../types').PolicyAttestation>} */
async function attestPolicy(input) { return unboundService('GovernanceService.attestPolicy'); }

module.exports = Object.freeze({
  recordProvenance,
  getProvenance,
  resolvePolicy,
  evaluatePolicy,
  attestPolicy,
});

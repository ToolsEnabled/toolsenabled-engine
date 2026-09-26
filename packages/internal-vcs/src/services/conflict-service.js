'use strict';

const { unboundService } = require('../unbound-service');

/** @param {{baseRevisionIds:string[],candidateRevisionIds:string[],entities:import('../types').ScopeSelector[],policyRevisionId:string}} input @returns {Promise<import('../types').ConflictSurface>} */
async function analyzeConflict(input) { return unboundService('ConflictService.analyzeConflict'); }
/** @param {{resolution:import('../types').ResolutionRecord,proofId:string,fenceBindings:import('../types').FenceBinding[],expectedAuthoritySnapshotId:string,impactPlanId:string}} input @returns {Promise<import('../types').LifecycleTransition>} */
async function recordResolution(input) { return unboundService('ConflictService.recordResolution'); }
/** @param {{conflictId:string,authoritySnapshotId:string|null}} input @returns {Promise<import('../types').ConflictSurface>} */
async function getConflictSurface(input) { return unboundService('ConflictService.getConflictSurface'); }

module.exports = Object.freeze({
  analyzeConflict,
  recordResolution,
  getConflictSurface,
});

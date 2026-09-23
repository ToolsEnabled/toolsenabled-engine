'use strict';

const { unboundService } = require('../unbound-service');

/** @param {{holderId:string,scope:import('../types').ScopeSelector[],ttlMs:number,expectedAbsent:boolean,policyRevisionId:string,compatibilityRuleRevisionId:string}} input @returns {Promise<import('../types').WorkClaim>} */
async function acquireClaim(input) { return unboundService('ClaimService.acquireClaim'); }
/** @param {{binding:import('../types').FenceBinding,ttlMs:number}} input @returns {Promise<import('../types').WorkClaim>} */
async function heartbeatClaim(input) { return unboundService('ClaimService.heartbeatClaim'); }
/** @param {{binding:import('../types').FenceBinding,reason:string}} input @returns {Promise<import('../types').LifecycleTransition>} */
async function releaseClaim(input) { return unboundService('ClaimService.releaseClaim'); }
/** @param {{scope:import('../types').ScopeSelector[],authoritySnapshotId:string|null}} input @returns {Promise<{claims:import('../types').WorkClaim[],compatibility:import('../types').ScopeCompatibilityDecision}>} */
async function inspectClaim(input) { return unboundService('ClaimService.inspectClaim'); }

module.exports = Object.freeze({
  acquireClaim,
  heartbeatClaim,
  releaseClaim,
  inspectClaim,
});

'use strict';

const { unboundService } = require('../unbound-service');

/** @param {import('../types').BackupCreateInput} input @returns {Promise<import('../types').BackupManifest>} */
async function createBackup(input) { return unboundService('BackupService.createBackup'); }
/** @param {{backupId:string,expectedManifestId:string,authoritySnapshotId:string}} input @returns {Promise<import('../types').ProofRecord>} */
async function verifyBackup(input) { return unboundService('BackupService.verifyBackup'); }
/** @param {{backupId:string,targetId:string,proofId:string,fenceBindings:import('../types').FenceBinding[],expectedAuthoritySnapshotId:string,impactPlanId:string}} input @returns {Promise<import('../types').LifecycleTransition>} */
async function restoreBackup(input) { return unboundService('BackupService.restoreBackup'); }
/** @param {{backupId:string,authoritySnapshotId:string|null}} input @returns {Promise<import('../types').BackupManifest>} */
async function getBackup(input) { return unboundService('BackupService.getBackup'); }

module.exports = Object.freeze({
  createBackup,
  verifyBackup,
  restoreBackup,
  getBackup,
});

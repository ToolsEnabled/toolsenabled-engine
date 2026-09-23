'use strict';

const { declareAdapter } = require('./contract');

/** Point-in-time manifest storage and isolated restore evidence. */
module.exports = declareAdapter('BackupStore', {
  writeBackup: { request: 'BackupCreateInput', result: 'BackupManifest' },
  readBackup: { request: 'backupId+authoritySnapshotId?', result: 'BackupManifest' },
  verifyClosure: { request: 'BackupManifest', result: 'ProofRecord' },
  restoreIntoIsolation: { request: 'BackupManifest+ProofRecord+FenceBinding[]', result: 'LifecycleTransition' },
});

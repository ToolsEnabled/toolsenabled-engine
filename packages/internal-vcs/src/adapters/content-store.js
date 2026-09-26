'use strict';

const { declareAdapter } = require('./contract');

/** Immutable algorithm-qualified blob/tree access; no workspace or policy authority. */
module.exports = declareAdapter('ContentStore', {
  putImmutable: { request: 'ArtifactReference+bytes', result: 'ArtifactReference' },
  getImmutable: { request: 'artifactId', result: 'bytes|VcsError' },
  hasImmutable: { request: 'artifactId+authoritySnapshotId', result: 'EvidenceEnvelope' },
  verifyIntegrity: { request: 'ArtifactReference', result: 'EvidenceEnvelope' },
});

'use strict';

const { CONTROL_CONTRACT_NAMES } = require('./control-contracts');

/**
 * @typedef {'SAFE'|'UNSAFE'|'UNKNOWN'} TruthState
 */

/**
 * @typedef {object} EvidenceEnvelope
 * @property {TruthState} state
 * @property {string} authoritySnapshotId
 * @property {string} observedAt
 * @property {string} expiresAt
 * @property {string[]} coveredArtifactIds
 * @property {string[]} missingArtifactIds
 * @property {string[]} evidenceIds
 */

/**
 * @typedef {object} ArtifactReference
 * @property {string} artifactId Algorithm-qualified immutable identity.
 * @property {string} kind
 * @property {string} authorityId
 * @property {string} integrity
 * @property {boolean} required
 * @property {string} retentionClass
 */

/**
 * @typedef {object} RevisionManifest
 * @property {string} revisionId
 * @property {string[]} parentRevisionIds
 * @property {ArtifactReference[]} artifacts
 * @property {string[]} requiredNamespaceIds
 * @property {string} policyRevisionId
 * @property {string[]} intendedConsumerIds
 * @property {EvidenceEnvelope} completeness
 * @property {string} state
 * @property {string} retentionState
 * @property {string|null} supersedesRevisionId
 */

/**
 * @typedef {object} WorkClaim
 * @property {string} claimId
 * @property {string} holderId
 * @property {Array<{kind:string,id:string}>} scope
 * @property {number} fenceToken
 * @property {string} scopeDigest
 * @property {string} issuedAt
 * @property {string} expiresAt
 * @property {string} policyRevisionId
 * @property {string} authoritySnapshotId
 * @property {string} state
 */

/**
 * @typedef {object} ConflictSurface
 * @property {string} conflictId
 * @property {string[]} kinds
 * @property {Array<{kind:string,id:string}>} entities
 * @property {string[]} candidateRevisionIds
 * @property {string[]} mergeBaseRevisionIds
 * @property {string[]} requiredValidatorIds
 * @property {string} state
 */

/**
 * @typedef {object} ProvenanceRecord
 * @property {string} provenanceId
 * @property {string} authoritySourceId
 * @property {string[]} custodyEventIds
 * @property {string} custodianId
 * @property {string} claimedAuthorId
 * @property {string} authenticatedPrincipalId
 * @property {string} executorId
 * @property {string} toolRevisionId
 * @property {string} policyRevisionId
 * @property {string} verificationAlgorithmId
 * @property {string[]} reviewerIds
 * @property {string[]} approverIds
 * @property {string[]} evidenceIds
 * @property {string} resultState
 */

/**
 * @typedef {object} OperationRecord
 * @property {string} operationId
 * @property {string} state
 * @property {string} recoveryPlanId
 * @property {string[]} participantIntentIds
 * @property {string[]} snapshotIds
 * @property {string[]} proofIds
 * @property {string[]} fenceBindingIds
 * @property {string[]} participantReceiptIds
 * @property {string[]} unknownParticipantIds
 */

const CONTRACT_NAMES = Object.freeze([
  'EvidenceEnvelope',
  'ArtifactReference',
  'RevisionManifest',
  'WorkClaim',
  'ConflictSurface',
  'ProvenanceRecord',
  'OperationRecord',
  ...CONTROL_CONTRACT_NAMES,
]);

module.exports = Object.freeze({ CONTRACT_NAMES });

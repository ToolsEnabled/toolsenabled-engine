'use strict';

/** @typedef {{namespace:string,kind:string,canonicalId:string,ancestorIds:string[],actions:string[],resourceVersion:string}} ScopeSelector */
/** @typedef {{state:'SAFE'|'UNSAFE'|'UNKNOWN',ruleRevisionId:string,left:ScopeSelector[],right:ScopeSelector[],overlaps:Array<{leftId:string,rightId:string,relation:string}>,evidenceIds:string[]}} ScopeCompatibilityDecision */
/** @typedef {{claimId:string,scopeDigest:string,fenceToken:number,authoritySnapshotId:string,expiresAt:string}} FenceBinding */
/** @typedef {{eventId:string,claimId:string,previousState:string,nextState:string,fenceToken:number,authoritySnapshotId:string,occurredAt:string,reason:string}} LeaseEvent */
/** @typedef {{laneId:string,holderId:string,territory:ScopeSelector[],protectedArtifactIds:string[],worktreeId:string,claimId:string,lastHeartbeatAt:string,state:string}} LaneRecord */
/** @typedef {{proposalId:string,state:'OFFLINE_PROPOSAL'|'QUARANTINED',creatorId:string,baseAuthoritySnapshotId:string,revisionManifestId:string,createdAt:string,requiredRevalidationIds:string[]}} OfflineProposal */
/** @typedef {{snapshotId:string,participantId:string,resourceVersion:string,authoritySnapshotId:string,observedAt:string,expiresAt:string}} SnapshotToken */
/** @typedef {{proofId:string,immutableInputIds:string[],snapshotIds:string[],policyRevisionId:string,verificationAlgorithmId:string,freshness:'FRESH'|'STALE'|'EXPIRED'|'INVALIDATED'|'UNKNOWN',expiresAt:string,evidenceIds:string[]}} ProofRecord */
/** @typedef {{evaluationId:string,policyRevisionId:string,subjectId:string,state:'SAFE'|'UNSAFE'|'UNKNOWN',evidenceIds:string[],unmetRuleIds:string[]}} PolicyEvaluation */
/** @typedef {{attestationId:string,policyRevisionId:string,immutableInputIds:string[],evaluationId:string,authoritySnapshotId:string,expiresAt:string}} PolicyAttestation */
/** @typedef {{decisionId:string,authenticatedPrincipalId:string,scope:ScopeSelector[],actions:string[],state:'SAFE'|'UNSAFE'|'UNKNOWN',keyStatus:string,revocationStatus:string,expiresAt:string}} AuthorizationDecision */
/** @typedef {{attestationId:string,replicaId:string,policyRevisionId:string,requiredNamespaceIds:string[],coveredArtifactIds:string[],state:'SAFE'|'UNSAFE'|'UNKNOWN',authoritySnapshotId:string,observedAt:string}} ReplicaAttestation */
/** @typedef {{resolutionId:string,conflictId:string,scope:ScopeSelector[],rationale:string,validatorEvidenceIds:string[],policyRevisionId:string,expiresAt:string,applicabilityState:'SAFE'|'UNSAFE'|'UNKNOWN',applicabilityDecisionId:string,fenceBindings:FenceBinding[]}} ResolutionRecord */
/** @typedef {{transitionId:string,subjectId:string,dimension:string,previousState:string,nextState:string,proofId:string,fenceBindings:FenceBinding[],authoritySnapshotId:string,occurredAt:string}} LifecycleTransition */
/** @typedef {{participantId:string,adapterId:string,intendedEffect:string,expectedState:string,snapshotId:string,fenceBindings:FenceBinding[],compensationMode:string}} ParticipantIntent */
/** @typedef {{receiptId:string,participantId:string,requestDigest:string,resultingState:string,authoritySnapshotId:string,appliedAt:string,expiresAt:string}} ParticipantReceipt */
/** @typedef {{recoveryPlanId:string,operationId:string,steps:Array<{participantId:string,action:string,precondition:string}>,irreversibleParticipantIds:string[],policyRevisionId:string}} RecoveryPlan */
/** @typedef {{receiptId:string,destinationId:string,revisionId:string,coveredNamespaceIds:string[],coveredObjectIds:string[],policyRevisionId:string,authoritySnapshotId:string,observedAt:string,expiresAt:string,freshness:'FRESH'|'STALE'|'EXPIRED'|'INVALIDATED'|'UNKNOWN'}} PublishReceipt */
/** @typedef {{observationId:string,consumerId:string,revisionId:string,publishReceiptId:string,observedRuntimeRevision:string,observedAt:string,expiresAt:string}} ConsumerObservation */
/** @typedef {{invalidationId:string,subjectId:string,reason:string,detectedAt:string,authoritySnapshotId:string,invalidatedDownstreamIds:string[]}} InvalidationRecord */
/** @typedef {{inventoryId:string,laneId:string,trackedIds:string[],untrackedIds:string[],ignoredIds:string[],nestedIds:string[],externalIds:string[],refIds:string[],reflogIds:string[],unreachableObjectIds:string[],unclassifiedIds:string[],authoritySnapshotId:string}} ArtifactInventory */
/** @typedef {{cleanupPlanId:string,inventoryId:string,policyRevisionId:string,proofId:string,fenceBindings:FenceBinding[],recoveryRecordIds:string[],state:'SAFE'|'UNSAFE'|'UNKNOWN'}} CleanupPlan */
/** @typedef {{backupId:string,projectRevisionId:string,controlLogSegmentIds:string[],contentArtifactIds:string[],requiredNamespaceIds:string[],externalRecoveryEvidenceIds:string[],secretReprovisioningRequirementIds:string[],compatibilityProfileId:string,rpo:string,rto:string,state:string,authoritySnapshotId:string}} BackupManifest */
/** @typedef {{retentionRecordId:string,subjectId:string,previousState:string,nextState:string,policyRevisionId:string,reason:string,fenceBindings:FenceBinding[],recoveryEvidenceIds:string[]}} RetentionRecord */
/** @typedef {{operationId:string,state:string,receipts:ParticipantReceipt[],unknownParticipantIds:string[],safeNextActions:string[],authoritySnapshotId:string}} OperationOutcome */

const CONTROL_CONTRACT_NAMES = Object.freeze([
  'ScopeSelector',
  'ScopeCompatibilityDecision',
  'FenceBinding',
  'LeaseEvent',
  'LaneRecord',
  'OfflineProposal',
  'SnapshotToken',
  'ProofRecord',
  'PolicyEvaluation',
  'PolicyAttestation',
  'AuthorizationDecision',
  'ReplicaAttestation',
  'ResolutionRecord',
  'LifecycleTransition',
  'ParticipantIntent',
  'ParticipantReceipt',
  'RecoveryPlan',
  'PublishReceipt',
  'ConsumerObservation',
  'InvalidationRecord',
  'ArtifactInventory',
  'CleanupPlan',
  'BackupManifest',
  'RetentionRecord',
  'OperationOutcome',
]);

module.exports = Object.freeze({ CONTROL_CONTRACT_NAMES });

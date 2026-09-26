export type TruthState = 'SAFE' | 'UNSAFE' | 'UNKNOWN';
export type EvidenceFreshness = 'FRESH' | 'STALE' | 'EXPIRED' | 'INVALIDATED' | 'UNKNOWN';
export type ProposalState = 'DRAFT' | 'OFFLINE_PROPOSAL' | 'QUARANTINED' | 'SUBMITTED' | 'SUPERSEDED';
export type RevisionState = 'DRAFT' | 'PROPOSED' | 'VALIDATED' | 'ACCEPTED' | 'PROVEN' | 'APPLYING' | 'APPLIED' | 'OBSERVED_RUNNING' | 'SUPERSEDED';
export type RetentionState = 'UNCLASSIFIED' | 'PRESERVED' | 'RELEASED' | 'TOMBSTONED';
export type ClaimState = 'REQUESTED' | 'GRANTED' | 'ACTIVE' | 'RENEWING' | 'RELEASED' | 'REVOKED' | 'EXPIRED' | 'ABANDONED';
export type OperationState = 'PLANNED' | 'PREPARED' | 'PROVEN' | 'APPLYING' | 'COMMITTED' | 'PARTIALLY_APPLIED' | 'COMPENSATING' | 'FAILED' | 'UNKNOWN';
export type ConflictKind = 'TEXTUAL' | 'STRUCTURAL' | 'SEMANTIC' | 'AUTHORITY' | 'TASK' | 'SIDE_EFFECT';
export type BackupState = 'DECLARED' | 'SNAPSHOTTING' | 'VERIFIED' | 'RESTORABLE' | 'RESTORED' | 'FAILED' | 'UNKNOWN';

export interface ScopeSelector {
  namespace: string;
  kind: string;
  canonicalId: string;
  ancestorIds: string[];
  actions: string[];
  resourceVersion: string;
}

export interface ScopeCompatibilityDecision {
  state: TruthState;
  ruleRevisionId: string;
  left: ScopeSelector[];
  right: ScopeSelector[];
  overlaps: Array<{ leftId: string; rightId: string; relation: string }>;
  evidenceIds: string[];
}

export interface FenceBinding {
  claimId: string;
  scopeDigest: string;
  fenceToken: number;
  authoritySnapshotId: string;
  expiresAt: string;
}

export interface EvidenceEnvelope {
  state: TruthState;
  authoritySnapshotId: string;
  observedAt: string;
  expiresAt: string;
  coveredArtifactIds: string[];
  missingArtifactIds: string[];
  evidenceIds: string[];
}

export interface ArtifactReference {
  artifactId: string;
  kind: string;
  authorityId: string;
  integrity: string;
  required: boolean;
  retentionClass: string;
}

export interface RevisionManifest {
  revisionId: string;
  parentRevisionIds: string[];
  artifacts: ArtifactReference[];
  requiredNamespaceIds: string[];
  policyRevisionId: string;
  intendedConsumerIds: string[];
  completeness: EvidenceEnvelope;
  state: RevisionState;
  retentionState: RetentionState;
  supersedesRevisionId: string | null;
}

export interface WorkClaim {
  claimId: string;
  holderId: string;
  scope: ScopeSelector[];
  scopeDigest: string;
  fenceToken: number;
  issuedAt: string;
  expiresAt: string;
  policyRevisionId: string;
  authoritySnapshotId: string;
  state: ClaimState;
}

export interface OfflineProposal {
  proposalId: string;
  state: 'OFFLINE_PROPOSAL' | 'QUARANTINED';
  creatorId: string;
  baseAuthoritySnapshotId: string;
  revisionManifestId: string;
  createdAt: string;
  requiredRevalidationIds: string[];
}

export interface SnapshotToken {
  snapshotId: string;
  participantId: string;
  resourceVersion: string;
  authoritySnapshotId: string;
  observedAt: string;
  expiresAt: string;
}

export interface ProofRecord {
  proofId: string;
  immutableInputIds: string[];
  snapshotIds: string[];
  policyRevisionId: string;
  verificationAlgorithmId: string;
  freshness: EvidenceFreshness;
  expiresAt: string;
  evidenceIds: string[];
}

export interface PolicyEvaluation {
  evaluationId: string;
  policyRevisionId: string;
  subjectId: string;
  state: TruthState;
  evidenceIds: string[];
  unmetRuleIds: string[];
}

export interface PolicyAttestation {
  attestationId: string;
  policyRevisionId: string;
  immutableInputIds: string[];
  evaluationId: string;
  authoritySnapshotId: string;
  expiresAt: string;
}

export interface AuthorizationDecision {
  decisionId: string;
  authenticatedPrincipalId: string;
  scope: ScopeSelector[];
  actions: string[];
  state: TruthState;
  keyStatus: string;
  revocationStatus: string;
  expiresAt: string;
}

export interface ConflictSurface {
  conflictId: string;
  kinds: ConflictKind[];
  entities: ScopeSelector[];
  candidateRevisionIds: string[];
  mergeBaseRevisionIds: string[];
  requiredValidatorIds: string[];
  state: string;
}

export interface ResolutionRecord {
  resolutionId: string;
  conflictId: string;
  scope: ScopeSelector[];
  rationale: string;
  validatorEvidenceIds: string[];
  policyRevisionId: string;
  expiresAt: string;
  applicabilityState: TruthState;
  applicabilityDecisionId: string;
  fenceBindings: FenceBinding[];
}

export interface ParticipantIntent {
  participantId: string;
  adapterId: string;
  intendedEffect: string;
  expectedState: string;
  snapshotId: string;
  fenceBindings: FenceBinding[];
  compensationMode: string;
}

export interface ParticipantReceipt {
  receiptId: string;
  participantId: string;
  requestDigest: string;
  resultingState: string;
  authoritySnapshotId: string;
  appliedAt: string;
  expiresAt: string;
}

export interface RecoveryPlan {
  recoveryPlanId: string;
  operationId: string;
  steps: Array<{ participantId: string; action: string; precondition: string }>;
  irreversibleParticipantIds: string[];
  policyRevisionId: string;
}

export interface OperationRecord {
  operationId: string;
  state: OperationState;
  recoveryPlanId: string;
  participantIntentIds: string[];
  snapshotIds: string[];
  proofIds: string[];
  fenceBindingIds: string[];
  participantReceiptIds: string[];
  unknownParticipantIds: string[];
}

export interface OperationOutcome {
  operationId: string;
  state: OperationState;
  receipts: ParticipantReceipt[];
  unknownParticipantIds: string[];
  safeNextActions: string[];
  authoritySnapshotId: string;
}

export interface PublishReceipt {
  receiptId: string;
  destinationId: string;
  revisionId: string;
  coveredNamespaceIds: string[];
  coveredObjectIds: string[];
  policyRevisionId: string;
  authoritySnapshotId: string;
  observedAt: string;
  expiresAt: string;
  freshness: EvidenceFreshness;
}

export interface ConsumerObservation {
  observationId: string;
  consumerId: string;
  revisionId: string;
  publishReceiptId: string;
  observedRuntimeRevision: string;
  observedAt: string;
  expiresAt: string;
}

export interface InvalidationRecord {
  invalidationId: string;
  subjectId: string;
  reason: string;
  detectedAt: string;
  authoritySnapshotId: string;
  invalidatedDownstreamIds: string[];
}

export interface ArtifactInventory {
  inventoryId: string;
  laneId: string;
  trackedIds: string[];
  untrackedIds: string[];
  ignoredIds: string[];
  nestedIds: string[];
  externalIds: string[];
  refIds: string[];
  reflogIds: string[];
  unreachableObjectIds: string[];
  unclassifiedIds: string[];
  authoritySnapshotId: string;
}

export interface CleanupPlan {
  cleanupPlanId: string;
  inventoryId: string;
  policyRevisionId: string;
  proofId: string;
  fenceBindings: FenceBinding[];
  recoveryRecordIds: string[];
  state: TruthState;
}

export interface BackupManifest {
  backupId: string;
  projectRevisionId: string;
  controlLogSegmentIds: string[];
  contentArtifactIds: string[];
  requiredNamespaceIds: string[];
  externalRecoveryEvidenceIds: string[];
  secretReprovisioningRequirementIds: string[];
  compatibilityProfileId: string;
  rpo: string;
  rto: string;
  state: BackupState;
  authoritySnapshotId: string;
}

export interface ReplicaAttestation {
  attestationId: string;
  replicaId: string;
  policyRevisionId: string;
  requiredNamespaceIds: string[];
  coveredArtifactIds: string[];
  state: TruthState;
  authoritySnapshotId: string;
  observedAt: string;
}

export interface LifecycleTransition {
  transitionId: string;
  subjectId: string;
  dimension: string;
  previousState: string;
  nextState: string;
  proofId: string;
  fenceBindings: FenceBinding[];
  authoritySnapshotId: string;
  occurredAt: string;
}

export interface ProvenanceRecord {
  provenanceId: string;
  authoritySourceId: string;
  custodyEventIds: string[];
  custodianId: string;
  claimedAuthorId: string;
  authenticatedPrincipalId: string;
  executorId: string;
  toolRevisionId: string;
  policyRevisionId: string;
  verificationAlgorithmId: string;
  reviewerIds: string[];
  approverIds: string[];
  evidenceIds: string[];
  resultState: string;
}

export interface RetentionRecord {
  retentionRecordId: string;
  subjectId: string;
  previousState: RetentionState;
  nextState: RetentionState;
  policyRevisionId: string;
  reason: string;
  fenceBindings: FenceBinding[];
  recoveryEvidenceIds: string[];
}

export interface BaseProtectedMutation {
  fenceBindings: FenceBinding[];
  expectedAuthoritySnapshotId: string;
  impactPlanId: string;
}

export interface AcceptRevisionInput extends BaseProtectedMutation {
  revisionId: string;
  expectedState: RevisionState;
  policyAttestationId: string;
  proofId: string;
}

export interface PreserveRevisionInput extends BaseProtectedMutation {
  revisionId: string;
  reason: string;
  retentionPolicyId: string;
  recoveryEvidenceIds: string[];
}

export interface TombstoneRevisionInput extends PreserveRevisionInput {}

export interface OperationApplyInput extends BaseProtectedMutation {
  operationId: string;
  proofId: string;
  participantIntentIds: string[];
}

export interface OperationRecoveryInput extends BaseProtectedMutation {
  operationId: string;
  recoveryPlanId: string;
  expectedState: OperationState;
}

export interface PublishInput extends BaseProtectedMutation {
  revisionId: string;
  destinationId: string;
  expectedNamespaceIds: string[];
  expectedObjectIds: string[];
}

export interface BackupCreateInput extends BaseProtectedMutation {
  projectId: string;
  revisionManifestId: string;
  snapshotIds: string[];
  rpo: string;
  rto: string;
}

export interface InternalVcsConfiguration {
  identity?: {
    signatureAlgorithm?: 'Ed25519';
    trustMode?: 'explicit';
    administrativeRecoveryPrincipalIds?: string[];
    keyStoreKind?: string;
    issueKeys?: false;
  };
  retention?: {
    controlLogMs?: number | null;
    provenanceMs?: number | null;
    repositoryContentMs?: number | null;
    buildEvidenceMs?: number | null;
    tombstoneRequired?: boolean;
    hardDeleteEnabled?: false;
  };
  recovery?: {
    rpoMs?: number;
    rtoMs?: number;
    isolatedRestoreRequired?: boolean;
  };
  admission?: {
    failClosedOnUnknown?: boolean;
    requireVerbatimAuthoritySource?: boolean;
    requireFreshReview?: boolean;
  };
}

export interface InternalVcsSystemOptions {
  configuration?: InternalVcsConfiguration;
  controlStore?: object | null;
  shadowImporter: object;
  publicationAdapter: object;
  backupStore: object;
  signatureAuthority: object;
  sagaAdapters: Record<string, object>;
  rollbackAdapter: object;
  clock?: () => string;
  monotonicClock?: () => number;
}

export interface InternalVcsSystem {
  configuration: Readonly<InternalVcsConfiguration>;
  services: Readonly<Record<string, Readonly<Record<string, (...args: any[]) => Promise<any>>>>>;
  authorities: Readonly<Record<string, object>>;
  migration: object;
}

export function createInternalVcsSystem(options: InternalVcsSystemOptions): InternalVcsSystem;

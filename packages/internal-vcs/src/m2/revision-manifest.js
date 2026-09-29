'use strict';

const { VcsError, VCS_ERROR_CODES } = require('../errors');
const { REVISION_STATES, RETENTION_STATES, TRUTH_STATES } = require('../lifecycle');
const {
  canonicalEncode,
  deepFreeze,
  hashBytes,
  immutableClone,
  parseQualifiedId,
} = require('../m1/canonical');

const MANIFEST_SCHEMA = 'internal-vcs.revision-manifest/v1';
const ARTIFACT_KEYS = Object.freeze([
  'artifactId',
  'authorityId',
  'integrity',
  'kind',
  'required',
  'retentionClass',
]);
const MANIFEST_KEYS = Object.freeze([
  'artifacts',
  'completeness',
  'intendedConsumerIds',
  'parentRevisionIds',
  'policyRevisionId',
  'requiredNamespaceIds',
  'retentionState',
  'revisionId',
  'state',
  'supersedesRevisionId',
]);
const EVIDENCE_KEYS = Object.freeze([
  'authoritySnapshotId',
  'coveredArtifactIds',
  'evidenceIds',
  'expiresAt',
  'missingArtifactIds',
  'observedAt',
  'state',
]);

function fail(code, message, details = {}) {
  throw new VcsError(code, message, details);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a non-empty string`, { field });
  }
  return value;
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be an object`, { field });
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} has an unexpected shape`, { field, keys });
  }
}

function sortedUniqueStrings(values, field, { qualified = false } = {}) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.length === 0)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be an array of non-empty strings`, { field });
  }
  const sorted = [...values].sort();
  if (sorted.some((value, index) => value !== values[index]) || new Set(sorted).size !== sorted.length) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be sorted and unique`, { field });
  }
  if (qualified) for (const value of sorted) parseQualifiedId(value);
  return sorted;
}

function normalizeStrings(values) {
  return [...new Set(values)].sort();
}

function validateArtifact(artifact) {
  exactKeys(artifact, ARTIFACT_KEYS, 'artifact');
  parseQualifiedId(artifact.artifactId);
  parseQualifiedId(artifact.integrity);
  nonEmptyString(artifact.kind, 'artifact.kind');
  nonEmptyString(artifact.authorityId, 'artifact.authorityId');
  nonEmptyString(artifact.retentionClass, 'artifact.retentionClass');
  if (typeof artifact.required !== 'boolean') {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'artifact.required must be boolean');
  }
  return immutableClone(artifact);
}

function validateEvidence(evidence, requiredArtifactIds) {
  exactKeys(evidence, EVIDENCE_KEYS, 'completeness');
  if (!TRUTH_STATES.includes(evidence.state)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'completeness state is invalid', { state: evidence.state });
  }
  parseQualifiedId(evidence.authoritySnapshotId);
  nonEmptyString(evidence.observedAt, 'completeness.observedAt');
  nonEmptyString(evidence.expiresAt, 'completeness.expiresAt');
  const covered = sortedUniqueStrings(evidence.coveredArtifactIds, 'completeness.coveredArtifactIds', { qualified: true });
  const missing = sortedUniqueStrings(evidence.missingArtifactIds, 'completeness.missingArtifactIds', { qualified: true });
  sortedUniqueStrings(evidence.evidenceIds, 'completeness.evidenceIds', { qualified: true });
  const overlap = covered.filter(identifier => missing.includes(identifier));
  if (overlap.length > 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'completeness coverage overlaps missing artifacts', { overlap });
  const classified = new Set([...covered, ...missing]);
  const unclassified = requiredArtifactIds.filter(identifier => !classified.has(identifier));
  if (unclassified.length > 0) {
    fail(VCS_ERROR_CODES.INCOMPLETE_ARTIFACT, 'required artifacts are absent from completeness evidence', { unclassified });
  }
  if (missing.length > 0 && evidence.state === 'SAFE') {
    fail(VCS_ERROR_CODES.INCOMPLETE_ARTIFACT, 'a manifest with missing artifacts cannot be SAFE', { missing });
  }
  return immutableClone(evidence);
}

function manifestBody(manifest) {
  return {
    parentRevisionIds: manifest.parentRevisionIds,
    artifacts: manifest.artifacts,
    requiredNamespaceIds: manifest.requiredNamespaceIds,
    policyRevisionId: manifest.policyRevisionId,
    intendedConsumerIds: manifest.intendedConsumerIds,
    completeness: manifest.completeness,
    state: manifest.state,
    retentionState: manifest.retentionState,
    supersedesRevisionId: manifest.supersedesRevisionId,
  };
}

function createRevisionManifest({
  parentRevisionIds = [],
  artifacts,
  requiredNamespaceIds,
  policyRevisionId,
  intendedConsumerIds,
  completeness,
  state = 'PROPOSED',
  retentionState = 'PRESERVED',
  supersedesRevisionId = null,
}) {
  const normalizedArtifacts = [...artifacts].map(validateArtifact)
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  if (new Set(normalizedArtifacts.map(artifact => artifact.artifactId)).size !== normalizedArtifacts.length) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'artifact identifiers must be unique');
  }
  const normalized = {
    parentRevisionIds: normalizeStrings(parentRevisionIds),
    artifacts: normalizedArtifacts,
    requiredNamespaceIds: normalizeStrings(requiredNamespaceIds),
    policyRevisionId: nonEmptyString(policyRevisionId, 'policyRevisionId'),
    intendedConsumerIds: normalizeStrings(intendedConsumerIds),
    completeness: immutableClone(completeness),
    state,
    retentionState,
    supersedesRevisionId,
  };
  const revisionId = hashBytes(canonicalEncode({ schemaVersion: MANIFEST_SCHEMA, ...normalized }));
  return validateRevisionManifest({ revisionId, ...normalized });
}

function validateRevisionManifest(manifest) {
  exactKeys(manifest, MANIFEST_KEYS, 'manifest');
  parseQualifiedId(manifest.revisionId);
  const artifacts = manifest.artifacts.map(validateArtifact);
  if (artifacts.some((artifact, index) => index > 0 && artifacts[index - 1].artifactId >= artifact.artifactId)) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'manifest artifacts must be sorted and unique');
  }
  sortedUniqueStrings(manifest.parentRevisionIds, 'parentRevisionIds', { qualified: true });
  sortedUniqueStrings(manifest.requiredNamespaceIds, 'requiredNamespaceIds');
  sortedUniqueStrings(manifest.intendedConsumerIds, 'intendedConsumerIds');
  nonEmptyString(manifest.policyRevisionId, 'policyRevisionId');
  if (!REVISION_STATES.includes(manifest.state)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'revision state is invalid');
  if (!RETENTION_STATES.includes(manifest.retentionState)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'retention state is invalid');
  if (manifest.supersedesRevisionId !== null) parseQualifiedId(manifest.supersedesRevisionId);
  const requiredIds = artifacts.filter(artifact => artifact.required).map(artifact => artifact.artifactId);
  validateEvidence(manifest.completeness, requiredIds);
  const actualId = hashBytes(canonicalEncode({ schemaVersion: MANIFEST_SCHEMA, ...manifestBody(manifest) }));
  if (actualId !== manifest.revisionId) {
    fail(VCS_ERROR_CODES.INTEGRITY_FAILURE, 'revision manifest digest does not match its canonical content', {
      expected: manifest.revisionId,
      actual: actualId,
    });
  }
  return immutableClone(manifest);
}

function verifyRevisionClosure({
  artifacts,
  artifactStates,
  requiredNamespaceIds,
  namespaceStates,
  authoritySnapshotId,
  observedAt,
  expiresAt,
  evidenceIds,
}) {
  parseQualifiedId(authoritySnapshotId);
  const normalizedArtifacts = artifacts.map(validateArtifact);
  const coveredArtifactIds = [];
  const missingArtifactIds = [];
  const corruptArtifactIds = [];
  for (const artifact of normalizedArtifacts) {
    const state = artifactStates[artifact.artifactId] || 'MISSING';
    if (!['PRESENT', 'MISSING', 'CORRUPT'].includes(state)) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'artifact coverage state is invalid', { artifactId: artifact.artifactId, state });
    }
    if (state === 'PRESENT') coveredArtifactIds.push(artifact.artifactId);
    if (artifact.required && state === 'MISSING') missingArtifactIds.push(artifact.artifactId);
    if (artifact.required && state === 'CORRUPT') corruptArtifactIds.push(artifact.artifactId);
  }
  for (const namespaceId of requiredNamespaceIds) {
    if (!namespaceStates[namespaceId] || namespaceStates[namespaceId] === 'MISSING') {
      const placeholderId = hashBytes(canonicalEncode({ kind: 'git-namespace-requirement', namespaceId }));
      if (!missingArtifactIds.includes(placeholderId)) missingArtifactIds.push(placeholderId);
    }
  }
  const state = corruptArtifactIds.length > 0
    ? 'UNSAFE'
    : missingArtifactIds.length > 0 ? 'UNKNOWN' : 'SAFE';
  return deepFreeze({
    state,
    authoritySnapshotId,
    observedAt: nonEmptyString(observedAt, 'observedAt'),
    expiresAt: nonEmptyString(expiresAt, 'expiresAt'),
    coveredArtifactIds: normalizeStrings(coveredArtifactIds),
    missingArtifactIds: normalizeStrings(missingArtifactIds),
    evidenceIds: normalizeStrings([...evidenceIds, ...corruptArtifactIds]),
  });
}

module.exports = Object.freeze({
  MANIFEST_SCHEMA,
  createRevisionManifest,
  validateRevisionManifest,
  verifyRevisionClosure,
});

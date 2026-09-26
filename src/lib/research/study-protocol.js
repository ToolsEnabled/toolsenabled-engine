'use strict';

// Prospective declarations only. This module does not inspect files, resolve an
// image, measure a cleanroom, run a canary, or execute a scientific checker.
const crypto = require('node:crypto');

const MAX_ARTIFACTS = 64;
const MAX_MANIFEST_BYTES = 32768;
const SOURCE_REPOSITORY_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const ARTIFACT_ROLES = Object.freeze([
  'protocol', 'prompt', 'environment-manifest', 'oracle-data-freeze',
  'oracle-bank-manifest', 'checker', 'generation-harness', 'canary-harness'
]);
const UNMEASURED = Object.freeze([
  'artifact-bytes-and-completeness',
  'cleanroom-and-instruction-absence',
  'generation-surface-and-engine-oracle-identity',
  'frozen-prompt-delivery',
  'batch-bound-calibrated-pre-and-post-canaries',
  'deterministic-checker-and-controls'
]);
const ID = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const hashJson = value => crypto.createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');

class StudyProtocolError extends Error {
  constructor(code, message) { super(message); this.name = 'StudyProtocolError'; this.code = code; }
}

function invalid(message) {
  throw new StudyProtocolError('RESEARCH_STUDY_PROTOCOL_INVALID', message);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key)
        || !Object.getOwnPropertyDescriptor(value, key).enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    invalid(`${label} must contain exactly: ${keys.join(', ')}.`);
  }
}

function matches(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} has an invalid identity or format.`);
}

function validateSourceRepository(value) {
  // The caller selects the primary repository or a reviewed fork. This checks
  // only a bounded root-URL spelling; it neither resolves nor trusts that source.
  matches(value, SOURCE_REPOSITORY_URL, 'source.repository (explicit HTTPS GitHub repository root URL)');
  if (new URL(value).href !== value) {
    invalid('source.repository must be a canonical repository root URL, without normalization or aliases.');
  }
}

function boundedArray(value, max, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max
      || Reflect.ownKeys(value).length !== value.length + 1) {
    invalid(`${label} must be a dense array containing 1 through ${max} entries.`);
  }
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateStudyProtocol(runnerKind, config = {}) {
  if (!Object.hasOwn(config, 'studyProtocol')) return null;
  if (runnerKind !== 'process') {
    throw new StudyProtocolError('RESEARCH_STUDY_PROTOCOL_RUNNER_UNSUPPORTED',
      'studyProtocol is a process-only declaration; agent dispatch and HTTP transport do not implement this study protocol.');
  }
  const manifest = config.studyProtocol;
  exactObject(manifest, ['version', 'protocolId', 'studyId', 'batchId', 'source', 'artifacts', 'environment', 'oracle', 'canary', 'gradingPolicy'], 'studyProtocol');
  if (manifest.version !== 1 || manifest.protocolId !== 'lean-bench'
      || manifest.gradingPolicy !== 'deterministic-no-llm') {
    invalid('studyProtocol v1 declares lean-bench with deterministic-no-llm grading; it does not verify grading.');
  }
  matches(manifest.studyId, ID, 'studyId');
  matches(manifest.batchId, ID, 'batchId');
  exactObject(manifest.source, ['repository', 'revision'], 'source');
  validateSourceRepository(manifest.source.repository);
  matches(manifest.source.revision, /^[a-f0-9]{40}$/, 'source.revision (full lowercase commit ID, never a branch or tag)');

  boundedArray(manifest.artifacts, MAX_ARTIFACTS, 'artifacts');
  const artifactIds = new Set();
  const roles = new Set();
  for (const artifact of manifest.artifacts) {
    exactObject(artifact, ['id', 'role', 'sha256'], 'artifact');
    matches(artifact.id, ID, 'artifact.id');
    matches(artifact.sha256, SHA256, 'artifact.sha256 (full lowercase SHA-256)');
    if (!ARTIFACT_ROLES.includes(artifact.role)) invalid('An artifact role is unknown; roles cannot be inferred from filenames.');
    if (artifactIds.has(artifact.id)) invalid('Artifact IDs must be unique across all roles.');
    artifactIds.add(artifact.id);
    roles.add(artifact.role);
  }
  if (ARTIFACT_ROLES.some(role => !roles.has(role))) invalid(`Declare at least one artifact for every role: ${ARTIFACT_ROLES.join(', ')}.`);

  exactObject(manifest.environment, ['variableAllowlist', 'instructionPolicy'], 'environment');
  if (manifest.environment.instructionPolicy !== 'instruction-bare') invalid('environment.instructionPolicy must declare instruction-bare execution; this is not a measurement of it.');
  boundedArray(manifest.environment.variableAllowlist, 64, 'environment.variableAllowlist');
  const variables = new Set();
  for (const key of manifest.environment.variableAllowlist) {
    matches(key, /^[A-Za-z_][A-Za-z0-9_]{0,95}$/, 'Environment variable name (no value)');
    if (variables.has(key.toLowerCase())) invalid('Environment variable names must be unique, including Windows case aliases.');
    variables.add(key.toLowerCase());
  }
  exactObject(manifest.oracle, ['engineImage'], 'oracle');
  if (typeof manifest.oracle.engineImage !== 'string' || manifest.oracle.engineImage.length > 327
      || !/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(manifest.oracle.engineImage)) {
    invalid('oracle.engineImage must be a digest-qualified image reference, not a floating image tag.');
  }
  exactObject(manifest.canary, ['surfaceIds', 'policy'], 'canary');
  if (manifest.canary.policy !== 'calibrated-same-utc-day-before-and-after-batch') {
    invalid('canary.policy must require calibrated same-UTC-day checks before and after the batch; certificates are not accepted in a prospective declaration.');
  }
  boundedArray(manifest.canary.surfaceIds, 16, 'canary.surfaceIds');
  for (const surface of manifest.canary.surfaceIds) matches(surface, ID, 'canary.surfaceIds entry');
  if (new Set(manifest.canary.surfaceIds).size !== manifest.canary.surfaceIds.length) invalid('Canary surface IDs must be unique.');
  const json = JSON.stringify(manifest);
  if (Buffer.byteLength(json, 'utf8') > MAX_MANIFEST_BYTES) invalid(`studyProtocol exceeds ${MAX_MANIFEST_BYTES} bytes.`);
  // Keep caller objects mutable, but detach the accepted snapshot so later
  // edits to the caller's object cannot change a declaration being completed.
  return freeze(JSON.parse(json));
}

function studyProtocolDeclaration(manifest, binding) {
  exactObject(binding, ['runId', 'experimentId', 'experimentConfigHash', 'paramsHash', 'attempt', 'fence'], 'Study run binding');
  matches(binding.runId, ID, 'runId');
  matches(binding.experimentId, ID, 'experimentId');
  matches(binding.experimentConfigHash, SHA256, 'experimentConfigHash');
  matches(binding.paramsHash, SHA256, 'paramsHash');
  if (!Number.isSafeInteger(binding.attempt) || binding.attempt < 1
      || !Number.isSafeInteger(binding.fence) || binding.fence < 1) invalid('A study declaration needs an exact positive attempt and fence.');
  const snapshot = validateStudyProtocol('process', { studyProtocol: manifest });
  return freeze({
    version: 1, status: 'declared-unverified', scope: 'prospective-study-manifest',
    manifest: snapshot, manifestSha256: hashJson(snapshot), ...binding,
    unmeasured: [...UNMEASURED]
  });
}

function assertStudyProtocolDeclaration(declaration, { manifest, binding }) {
  if (!manifest) {
    if (declaration !== undefined) throw new StudyProtocolError('RESEARCH_STUDY_DECLARATION_UNEXPECTED',
      'This run has no immutable study protocol declaration; result metadata cannot introduce one.');
    return;
  }
  if (declaration === undefined || declaration === null) throw new StudyProtocolError('RESEARCH_STUDY_DECLARATION_MISSING',
    'The study declaration is missing from this attempt. No result was accepted.');
  const expected = studyProtocolDeclaration(manifest, binding);
  try {
    exactObject(declaration, Object.keys(expected), 'Study declaration');
    validateStudyProtocol('process', { studyProtocol: declaration.manifest });
    if (hashJson(declaration) === hashJson(expected)) return;
  } catch (error) {
    if (!(error instanceof StudyProtocolError)) throw error;
  }
  throw new StudyProtocolError('RESEARCH_STUDY_DECLARATION_INVALID',
    'The declaration changed, claimed verification, or belongs to another experiment, run, or attempt. No result was accepted.');
}

module.exports = {
  MAX_ARTIFACTS, MAX_MANIFEST_BYTES, ARTIFACT_ROLES, UNMEASURED, StudyProtocolError,
  validateStudyProtocol, studyProtocolDeclaration, assertStudyProtocolDeclaration
};

'use strict';

// This module accepts observations only from the broker execution lane.  It
// deliberately has no concept of worker claims, prose, self-review, or a
// caller-supplied regression list.  Baseline/candidate transitions are derived
// from two normalized verifier records using the same criterion definitions.

const {
  clone,
  canonicalJson,
  compareText,
  exactKeys,
  fail,
  hashCanonical,
  identifier,
  integer,
  isoTime,
  pathKey,
  plainObject,
  safePath,
  safeText,
  sha256,
  unique
} = require('./common');
const { createOutboxRecord, validateEventEnvelope } = require('./event-envelope');
const { ARTIFACT_KINDS } = require('./review-packet');
const { hashMissionContract } = require('./mission-contract');
const { assertAcceptanceVerified, validateVerificationManifest } = require('./verification-manifest');
const {
  resolveTrustedArtifacts,
  validateTrustedArtifactSnapshot
} = require('./trusted-artifacts');

const SCHEMA_VERSION = 1;
const EXECUTION_ROLES = new Set(['baseline', 'candidate']);
const ARTIFACT_KIND_SET = new Set(ARTIFACT_KINDS);

function pathIsWithin(path, root) {
  const normalizedPath = pathKey(path);
  const normalizedRoot = pathKey(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function assertArtifactsInMissionScope(record, mission) {
  const allowedPaths = mission.scope.allowedPaths;
  const forbiddenPaths = mission.scope.forbiddenPaths;
  for (const artifact of record.artifacts) {
    const forbidden = forbiddenPaths.find(path => pathIsWithin(artifact.path, path));
    const allowed = allowedPaths.some(path => pathIsWithin(artifact.path, path));
    if (forbidden || !allowed) {
      fail('COORDINATOR_WORKFLOW_SCOPE_INVALID', 'Broker verification artifacts must remain within the mission path scope.', {
        executionRole: record.executionRole,
        artifactId: artifact.artifactId,
        path: artifact.path,
        forbiddenPath: forbidden
      });
    }
  }
}

function role(value, label = 'executionRole') {
  const normalized = safeText(value, label, { min: 8, max: 9, pattern: /^(?:baseline|candidate)$/ });
  if (!EXECUTION_ROLES.has(normalized)) fail('COORDINATOR_WORKFLOW_BROKER_INVALID', `${label} is invalid.`, { field: label });
  return normalized;
}

function execution(value) {
  const source = plainObject(value, 'execution');
  exactKeys(source, ['exitCode', 'signal', 'timedOut'], 'execution');
  const exitCode = integer(source.exitCode, 'execution.exitCode', { min: 0, max: 255 });
  const signal = source.signal === null ? null : safeText(source.signal, 'execution.signal', { min: 1, max: 80, pattern: /^[A-Za-z0-9_.:-]+$/ });
  if (typeof source.timedOut !== 'boolean') fail('COORDINATOR_WORKFLOW_BROKER_INVALID', 'execution.timedOut must be a boolean.', { field: 'execution.timedOut' });
  return { exitCode, signal, timedOut: source.timedOut };
}

function executionHealthy(value) {
  return value.exitCode === 0 && value.signal === null && value.timedOut === false;
}

function artifactInputs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    fail('COORDINATOR_WORKFLOW_BROKER_INVALID', 'artifacts must contain one through 100 broker-named artifacts.', { field: 'artifacts' });
  }
  return value.map((entry, index) => {
    const source = plainObject(entry, `artifacts[${index}]`);
    exactKeys(source, ['artifactId', 'path', 'kind'], `artifacts[${index}]`);
    const kind = safeText(source.kind, `artifacts[${index}].kind`, { min: 4, max: 20, pattern: /^[a-z_]+$/ });
    if (!ARTIFACT_KIND_SET.has(kind)) fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', `artifacts[${index}].kind is unsupported.`, { field: `artifacts[${index}].kind` });
    return {
      artifactId: identifier(source.artifactId, `artifacts[${index}].artifactId`),
      path: safePath(source.path, `artifacts[${index}].path`),
      kind
    };
  });
}

function evidenceInput(value, label, artifactMap) {
  const source = plainObject(value, label);
  exactKeys(source, ['evidenceId', 'type', 'artifactId', 'detail', 'startLine', 'endLine'], label);
  const artifactId = identifier(source.artifactId, `${label}.artifactId`);
  const artifact = artifactMap.get(artifactId);
  if (!artifact) fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', `${label}.artifactId is not a resolved broker artifact.`, { artifactId });
  const pointer = { artifactId, sha256: artifact.sha256, path: artifact.path };
  if (source.startLine !== undefined || source.endLine !== undefined) {
    pointer.startLine = integer(source.startLine, `${label}.startLine`, { min: 1, max: 10_000_000 });
    pointer.endLine = integer(source.endLine, `${label}.endLine`, { min: pointer.startLine, max: 10_000_000 });
  }
  return {
    evidenceId: identifier(source.evidenceId, `${label}.evidenceId`),
    type: safeText(source.type, `${label}.type`, { min: 3, max: 40, pattern: /^[a-z_]+$/ }),
    artifact: pointer,
    detail: safeText(source.detail, `${label}.detail`, { min: 1, max: 300 })
  };
}

function checks(value, artifactMap) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    fail('COORDINATOR_WORKFLOW_BROKER_INVALID', 'checks must contain one through 32 criterion observations.', { field: 'checks' });
  }
  return value.map((entry, index) => {
    const label = `checks[${index}]`;
    const source = plainObject(entry, label);
    exactKeys(source, ['criterionId', 'status', 'evidence'], label);
    if (!Array.isArray(source.evidence) || source.evidence.length < 1 || source.evidence.length > 16) {
      fail('COORDINATOR_WORKFLOW_BROKER_INVALID', `${label}.evidence must contain one through 16 artifacts.`, { field: `${label}.evidence` });
    }
    return {
      criterionId: identifier(source.criterionId, `${label}.criterionId`),
      status: safeText(source.status, `${label}.status`, { min: 4, max: 8, pattern: /^[a-z]+$/ }),
      evidence: source.evidence.map((item, evidenceIndex) => evidenceInput(item, `${label}.evidence[${evidenceIndex}]`, artifactMap))
    };
  });
}

function storedArtifacts(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', 'Stored broker artifacts must contain one through 100 entries.', { field: 'artifacts' });
  }
  const artifacts = value.map((entry, index) => {
    const label = `artifacts[${index}]`;
    const source = plainObject(entry, label);
    exactKeys(source, ['artifactId', 'path', 'kind', 'sha256', 'sizeBytes'], label);
    const kind = safeText(source.kind, `${label}.kind`, { min: 4, max: 20, pattern: /^[a-z_]+$/ });
    if (!ARTIFACT_KIND_SET.has(kind)) fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', `${label}.kind is unsupported.`, { field: `${label}.kind` });
    return {
      artifactId: identifier(source.artifactId, `${label}.artifactId`),
      path: safePath(source.path, `${label}.path`),
      kind,
      sha256: sha256(source.sha256, `${label}.sha256`),
      sizeBytes: integer(source.sizeBytes, `${label}.sizeBytes`, { min: 1, max: 64 * 1024 * 1024 })
    };
  });
  unique(artifacts.map(item => item.artifactId), 'stored artifact ids');
  unique(artifacts.map(item => item.path.toLowerCase()), 'stored artifact paths');
  return artifacts.sort((left, right) => compareText(left.artifactId, right.artifactId));
}

function deriveBrokerVerification(value, resolver = resolveTrustedArtifacts) {
  const source = plainObject(value, 'broker verification input');
  exactKeys(source, ['trustedRoot', 'runId', 'mission', 'executionRole', 'executionId', 'workspacePath', 'artifacts', 'checks', 'execution', 'executedAt'], 'broker verification input');
  if (typeof source.trustedRoot !== 'string' || !source.trustedRoot) fail('COORDINATOR_WORKFLOW_BROKER_INVALID', 'trustedRoot must be broker-fixed text.', { field: 'trustedRoot' });
  const runId = identifier(source.runId, 'runId');
  const mission = hashMissionContract(source.mission);
  const executionRole = role(source.executionRole);
  const executionId = identifier(source.executionId, 'executionId');
  const workspacePath = safePath(source.workspacePath, 'workspacePath');
  const observedExecution = execution(source.execution);
  const executedAt = isoTime(source.executedAt, 'executedAt');
  const requestedArtifacts = artifactInputs(source.artifacts);
  const artifacts = resolver({ trustedRoot: source.trustedRoot, runId, workspacePath, artifacts: requestedArtifacts });
  const artifactMap = new Map(artifacts.map(item => [item.artifactId, item]));
  const manifest = validateVerificationManifest({
    schemaVersion: SCHEMA_VERSION,
    missionId: mission.contract.missionId,
    missionHash: mission.hash,
    createdAt: executedAt,
    baseSnapshotSha256: mission.contract.workspace.baseSnapshotSha256,
    checks: checks(source.checks, artifactMap),
    // Any candidate/baseline transition supplied by a worker is intentionally
    // discarded.  This placeholder is replaced only by deriveRegressions.
    regressions: { p2f: [], f2p: [], p2p: [], f2f: [] }
  }, mission.contract);
  return clone({
    schemaVersion: SCHEMA_VERSION,
    runId,
    missionId: mission.contract.missionId,
    missionHash: mission.hash,
    executionRole,
    executionId,
    workspacePath,
    executedAt,
    execution: observedExecution,
    artifacts,
    manifest
  });
}

function validateBrokerRecord(value, missionValue, expectedRole) {
  const mission = hashMissionContract(missionValue);
  const source = plainObject(value, 'broker verification record');
  exactKeys(source, ['schemaVersion', 'runId', 'missionId', 'missionHash', 'executionRole', 'executionId', 'workspacePath', 'executedAt', 'execution', 'artifacts', 'snapshot', 'manifest'], 'broker verification record');
  if (source.schemaVersion !== SCHEMA_VERSION) fail('COORDINATOR_WORKFLOW_VERSION_INVALID', `broker verification schemaVersion must be ${SCHEMA_VERSION}.`, { field: 'schemaVersion' });
  const executionRole = role(source.executionRole);
  if (expectedRole && executionRole !== expectedRole) fail('COORDINATOR_WORKFLOW_BROKER_INVALID', 'The stored broker verification has the wrong execution role.', { expectedRole, actualRole: executionRole });
  const runId = identifier(source.runId, 'runId');
  if (identifier(source.missionId, 'missionId') !== mission.contract.missionId || source.missionHash !== mission.hash) {
    fail('COORDINATOR_WORKFLOW_MISSION_MISMATCH', 'The broker verification is not bound to this mission contract.');
  }
  const resolvedArtifacts = storedArtifacts(source.artifacts);
  const snapshot = validateTrustedArtifactSnapshot(source.snapshot);
  if (snapshot.runId !== runId || snapshot.workspacePath !== safePath(source.workspacePath, 'workspacePath')) {
    fail('COORDINATOR_WORKFLOW_BROKER_INVALID', 'The persisted artifact snapshot is not bound to this broker verification workspace.', {
      runId,
      executionRole
    });
  }
  const snapshotArtifacts = snapshot.artifacts
    .map(({ artifactId, path, kind, sha256, sizeBytes }) => ({ artifactId, path, kind, sha256, sizeBytes }))
    .sort((left, right) => compareText(left.artifactId, right.artifactId));
  if (canonicalJson(snapshotArtifacts) !== canonicalJson(resolvedArtifacts)) {
    fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', 'The persisted artifact snapshot does not match the broker-resolved evidence.', { executionRole });
  }
  // `deriveBrokerVerification` already validates hashes and sizes from file
  // descriptors. Reconstructing a manifest below protects persisted rows from
  // malformed/corrupt JSON on restart.
  const manifest = validateVerificationManifest(source.manifest, mission.contract);
  const artifactMap = new Map(resolvedArtifacts.map(item => [item.artifactId, item]));
  for (const check of manifest.checks) for (const item of check.evidence) {
    const artifact = artifactMap.get(item.artifact.artifactId);
    if (!artifact || artifact.path !== item.artifact.path || artifact.sha256 !== item.artifact.sha256) {
      fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', 'Stored verification evidence must remain bound to one broker-resolved artifact.', {
        criterionId: check.criterionId,
        artifactId: item.artifact.artifactId
      });
    }
  }
  return clone({
    schemaVersion: SCHEMA_VERSION,
    runId,
    missionId: mission.contract.missionId,
    missionHash: mission.hash,
    executionRole,
    executionId: identifier(source.executionId, 'executionId'),
    workspacePath: safePath(source.workspacePath, 'workspacePath'),
    executedAt: isoTime(source.executedAt, 'executedAt'),
    execution: execution(source.execution),
    artifacts: resolvedArtifacts,
    snapshot,
    manifest
  });
}

function deriveRegressions(baselineManifest, candidateManifest) {
  const baseline = new Map(baselineManifest.checks.map(item => [item.criterionId, item.status]));
  const candidate = new Map(candidateManifest.checks.map(item => [item.criterionId, item.status]));
  const ids = [...baseline.keys()].sort(compareText);
  if (ids.length !== candidate.size || ids.some(id => !candidate.has(id))) {
    fail('COORDINATOR_WORKFLOW_BROKER_INVALID', 'Baseline and candidate verification must cover the identical criterion ids.');
  }
  const unmeasured = ids.filter(id => baseline.get(id) === 'skipped' || candidate.get(id) === 'skipped');
  if (unmeasured.length) {
    fail('COORDINATOR_WORKFLOW_BROKER_INVALID', 'Skipped verification cannot be classified as a definite regression outcome.', {
      criterionIds: unmeasured
    });
  }
  const output = { p2f: [], f2p: [], p2p: [], f2f: [] };
  for (const id of ids) {
    const before = baseline.get(id) === 'pass';
    const after = candidate.get(id) === 'pass';
    if (before && after) output.p2p.push(id);
    else if (before && !after) output.p2f.push(id);
    else if (!before && after) output.f2p.push(id);
    else output.f2f.push(id);
  }
  return output;
}

function deriveAcceptedWorkflow(value) {
  const source = plainObject(value, 'accepted workflow input');
  exactKeys(source, ['mission', 'baseline', 'candidate', 'acceptedAt'], 'accepted workflow input');
  const mission = hashMissionContract(source.mission);
  const baseline = validateBrokerRecord(source.baseline, mission.contract, 'baseline');
  const candidate = validateBrokerRecord(source.candidate, mission.contract, 'candidate');
  if (Date.parse(baseline.executedAt) >= Date.parse(candidate.executedAt)) {
    fail('COORDINATOR_WORKFLOW_BROKER_INVALID', 'Baseline verification must be executed before candidate verification.', {
      baselineExecutedAt: baseline.executedAt,
      candidateExecutedAt: candidate.executedAt
    });
  }
  assertArtifactsInMissionScope(baseline, mission.contract);
  assertArtifactsInMissionScope(candidate, mission.contract);
  // Broker records have no unresolved-risk field.  Consequently they cannot
  // prove compliance with ceilings that permit at most no or low unresolved
  // risk; those policies require the risk-bearing review-packet lane.
  if (mission.contract.acceptance.severityCeiling !== 'medium') {
    fail('COORDINATOR_WORKFLOW_SEVERITY_EXCEEDED', 'Broker-only acceptance cannot establish compliance with this mission severity ceiling.', {
      severityCeiling: mission.contract.acceptance.severityCeiling
    });
  }
  if (!executionHealthy(baseline.execution) || !executionHealthy(candidate.execution)) {
    fail('COORDINATOR_WORKFLOW_BROKER_EXECUTION_UNHEALTHY', 'A nonzero, signalled, timed-out, or incomplete broker execution cannot authorize acceptance.', {
      baseline: baseline.execution,
      candidate: candidate.execution
    });
  }
  const regressions = deriveRegressions(baseline.manifest, candidate.manifest);
  const manifest = assertAcceptanceVerified({ ...candidate.manifest, regressions }, mission.contract);
  const criterionIds = manifest.checks.map(item => item.criterionId).sort(compareText);
  const artifactIds = [...new Set(manifest.checks.flatMap(check => check.evidence.map(item => item.artifact.artifactId)))].sort(compareText);
  if (!criterionIds.length || !artifactIds.length) fail('COORDINATOR_WORKFLOW_EVIDENCE_MISSING', 'Terminal acceptance requires artifact-backed coverage for every criterion.');
  const acceptedAt = isoTime(source.acceptedAt, 'acceptedAt');
  const eventSeed = hashCanonical({ runId: candidate.runId, missionHash: mission.hash, baseline: hashCanonical(baseline), candidate: hashCanonical(candidate), manifest });
  const event = validateEventEnvelope({
    schemaVersion: SCHEMA_VERSION,
    eventId: `event-${eventSeed}`,
    missionId: mission.contract.missionId,
    missionHash: mission.hash,
    type: 'completed',
    occurredAt: acceptedAt,
    payload: {
      summary: 'Broker-derived verification satisfied every required acceptance criterion.',
      artifactIds,
      criterionIds,
      code: 'ACCEPTED'
    }
  });
  const outbox = createOutboxRecord({
    outboxId: `outbox-${eventSeed}`,
    createdAt: acceptedAt,
    deliveryState: 'pending',
    event
  });
  return clone({
    schemaVersion: SCHEMA_VERSION,
    status: 'ACCEPTED',
    runId: candidate.runId,
    missionId: mission.contract.missionId,
    missionHash: mission.hash,
    baselineExecutionId: baseline.executionId,
    candidateExecutionId: candidate.executionId,
    manifest,
    artifacts: candidate.artifacts,
    event,
    outbox
  });
}

module.exports = {
  EXECUTION_ROLES: Object.freeze([...EXECUTION_ROLES]),
  SCHEMA_VERSION,
  deriveAcceptedWorkflow,
  deriveBrokerVerification,
  deriveRegressions,
  validateBrokerRecord
};

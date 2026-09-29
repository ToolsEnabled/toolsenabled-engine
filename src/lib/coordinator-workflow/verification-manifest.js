'use strict';

const {
  clone,
  compareText,
  exactKeys,
  fail,
  identifier,
  integer,
  isoTime,
  plainObject,
  safePath,
  safeText,
  sha256,
  unique
} = require('./common');
const { EVIDENCE_TYPES, hashMissionContract } = require('./mission-contract');

const SCHEMA_VERSION = 1;
const EVIDENCE_TYPE_SET = new Set(EVIDENCE_TYPES);
const CHECK_STATUSES = new Set(['pass', 'fail', 'skipped']);

function artifactPointer(value, label) {
  const source = plainObject(value, label);
  exactKeys(source, ['artifactId', 'sha256', 'path', 'startLine', 'endLine'], label);
  const pointer = {
    artifactId: identifier(source.artifactId, `${label}.artifactId`),
    sha256: sha256(source.sha256, `${label}.sha256`),
    path: safePath(source.path, `${label}.path`)
  };
  if (source.startLine !== undefined || source.endLine !== undefined) {
    pointer.startLine = integer(source.startLine, `${label}.startLine`, { min: 1, max: 10_000_000 });
    pointer.endLine = integer(source.endLine, `${label}.endLine`, { min: pointer.startLine, max: 10_000_000 });
    if (pointer.endLine - pointer.startLine > 500) {
      fail('COORDINATOR_WORKFLOW_POINTER_INVALID', `${label} must point to at most 501 lines.`, { field: label });
    }
  }
  return pointer;
}

function evidence(value, criterionId, index) {
  const label = `checks.${criterionId}.evidence[${index}]`;
  const source = plainObject(value, label);
  exactKeys(source, ['evidenceId', 'type', 'artifact', 'detail'], label);
  const type = safeText(source.type, `${label}.type`, { min: 3, max: 40, pattern: /^[a-z_]+$/ });
  if (!EVIDENCE_TYPE_SET.has(type)) fail('COORDINATOR_WORKFLOW_EVIDENCE_INVALID', `${label}.type is unsupported.`, { field: `${label}.type` });
  return {
    evidenceId: identifier(source.evidenceId, `${label}.evidenceId`),
    type,
    artifact: artifactPointer(source.artifact, `${label}.artifact`),
    detail: safeText(source.detail, `${label}.detail`, { min: 1, max: 300 })
  };
}

function check(value, criterionMap, index) {
  const source = plainObject(value, `checks[${index}]`);
  exactKeys(source, ['criterionId', 'status', 'evidence'], `checks[${index}]`);
  const criterionId = identifier(source.criterionId, `checks[${index}].criterionId`);
  const criterion = criterionMap.get(criterionId);
  if (!criterion) fail('COORDINATOR_WORKFLOW_CRITERION_UNKNOWN', `checks[${index}] references an unknown acceptance criterion.`, { field: `checks[${index}].criterionId` });
  const status = safeText(source.status, `checks[${index}].status`, { min: 4, max: 8, pattern: /^[a-z]+$/ });
  if (!CHECK_STATUSES.has(status)) fail('COORDINATOR_WORKFLOW_VERIFICATION_INVALID', `checks[${index}].status is invalid.`, { field: `checks[${index}].status` });
  if (!Array.isArray(source.evidence) || source.evidence.length < 1 || source.evidence.length > 16) {
    fail('COORDINATOR_WORKFLOW_EVIDENCE_MISSING', `checks[${index}].evidence must contain at least one bounded artifact-backed item.`, { field: `checks[${index}].evidence` });
  }
  const items = source.evidence.map((entry, evidenceIndex) => evidence(entry, criterionId, evidenceIndex));
  unique(items.map(item => item.evidenceId), `checks[${index}].evidence ids`);
  const actualTypes = new Set(items.map(item => item.type));
  for (const requiredType of criterion.requiredEvidenceTypes) {
    if (!actualTypes.has(requiredType)) {
      fail('COORDINATOR_WORKFLOW_EVIDENCE_MISSING', `checks[${index}] is missing required '${requiredType}' evidence.`, { criterionId, requiredType });
    }
  }
  return { criterionId, status, evidence: items.sort((left, right) => compareText(left.evidenceId, right.evidenceId)) };
}

function regressionList(value, label) {
  if (!Array.isArray(value) || value.length > 200) {
    fail('COORDINATOR_WORKFLOW_REGRESSION_INVALID', `${label} must contain at most 200 check identifiers.`, { field: label });
  }
  const output = value.map((entry, index) => identifier(entry, `${label}[${index}]`));
  unique(output, label);
  return output.sort(compareText);
}

function regressions(value) {
  const source = plainObject(value, 'regressions');
  exactKeys(source, ['p2f', 'f2p', 'p2p', 'f2f'], 'regressions');
  const output = {
    p2f: regressionList(source.p2f, 'regressions.p2f'),
    f2p: regressionList(source.f2p, 'regressions.f2p'),
    p2p: regressionList(source.p2p, 'regressions.p2p'),
    f2f: regressionList(source.f2f, 'regressions.f2f')
  };
  const all = Object.values(output).flat();
  unique(all, 'regression identifiers');
  return output;
}

function validateVerificationManifest(value, missionValue) {
  const mission = hashMissionContract(missionValue);
  const source = plainObject(value, 'verification manifest');
  exactKeys(source, ['schemaVersion', 'missionId', 'missionHash', 'createdAt', 'baseSnapshotSha256', 'checks', 'regressions'], 'verification manifest');
  if (source.schemaVersion !== SCHEMA_VERSION) {
    fail('COORDINATOR_WORKFLOW_VERSION_INVALID', `verification manifest schemaVersion must be ${SCHEMA_VERSION}.`, { field: 'schemaVersion' });
  }
  const missionId = identifier(source.missionId, 'missionId');
  if (missionId !== mission.contract.missionId) fail('COORDINATOR_WORKFLOW_MISSION_MISMATCH', 'verification manifest missionId does not match the mission contract.', { missionId });
  const missionHash = sha256(source.missionHash, 'missionHash');
  if (missionHash !== mission.hash) fail('COORDINATOR_WORKFLOW_MISSION_MISMATCH', 'verification manifest missionHash does not match the mission contract.', { missionHash });
  const baseSnapshotSha256 = sha256(source.baseSnapshotSha256, 'baseSnapshotSha256');
  if (baseSnapshotSha256 !== mission.contract.workspace.baseSnapshotSha256) {
    fail('COORDINATOR_WORKFLOW_SNAPSHOT_MISMATCH', 'verification manifest base snapshot does not match the mission contract.', { baseSnapshotSha256 });
  }
  if (!Array.isArray(source.checks) || source.checks.length !== mission.contract.acceptance.criteria.length) {
    fail('COORDINATOR_WORKFLOW_EVIDENCE_MISSING', 'verification manifest must contain exactly one check for every acceptance criterion.', { field: 'checks' });
  }
  const criterionMap = new Map(mission.contract.acceptance.criteria.map(item => [item.id, item]));
  const checks = source.checks.map((entry, index) => check(entry, criterionMap, index));
  unique(checks.map(item => item.criterionId), 'checks criterionIds');
  const expectedIds = [...criterionMap.keys()].sort();
  const actualIds = checks.map(item => item.criterionId).sort();
  if (expectedIds.join('\u0000') !== actualIds.join('\u0000')) {
    fail('COORDINATOR_WORKFLOW_EVIDENCE_MISSING', 'verification manifest is missing an acceptance criterion.', { expectedIds, actualIds });
  }
  const evidenceIds = checks.flatMap(item => item.evidence.map(entry => entry.evidenceId));
  unique(evidenceIds, 'verification evidence ids');
  return clone({
    schemaVersion: SCHEMA_VERSION,
    missionId,
    missionHash,
    createdAt: isoTime(source.createdAt, 'createdAt'),
    baseSnapshotSha256,
    checks: checks.sort((left, right) => compareText(left.criterionId, right.criterionId)),
    regressions: regressions(source.regressions)
  });
}

function assertAcceptanceVerified(value, missionValue) {
  const manifest = validateVerificationManifest(value, missionValue);
  const incomplete = manifest.checks.filter(item => item.status !== 'pass').map(item => item.criterionId);
  if (incomplete.length) {
    fail('COORDINATOR_WORKFLOW_ACCEPTANCE_UNVERIFIED', 'A review packet cannot be built while any acceptance criterion is not passing.', { criterionIds: incomplete });
  }
  if (manifest.regressions.p2f.length) {
    fail('COORDINATOR_WORKFLOW_REGRESSION_DETECTED', 'A review packet cannot be built with pass-to-fail regressions.', { p2f: manifest.regressions.p2f });
  }
  return manifest;
}

module.exports = {
  SCHEMA_VERSION,
  artifactPointer,
  assertAcceptanceVerified,
  validateVerificationManifest
};

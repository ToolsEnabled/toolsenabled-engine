'use strict';

const {
  canonicalJson,
  clone,
  compareText,
  estimateTokens,
  exactKeys,
  fail,
  identifier,
  integer,
  plainObject,
  pathKey,
  safePath,
  safeText,
  sha256,
  unique
} = require('./common');
const { hashMissionContract } = require('./mission-contract');
const { assertAcceptanceVerified } = require('./verification-manifest');

const SCHEMA_VERSION = 1;
const ARTIFACT_KINDS = new Set(['diff', 'test_log', 'verification', 'source', 'state']);
const RISK_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });
const SEVERITIES = new Set(Object.keys(RISK_RANK));
const ACCEPTANCE_CEILING_RANK = Object.freeze({ none: 0, low: 1, medium: 2 });

function artifact(value, index) {
  const label = `artifacts[${index}]`;
  const source = plainObject(value, label);
  exactKeys(source, ['artifactId', 'sha256', 'path', 'kind', 'sizeBytes'], label);
  const kind = safeText(source.kind, `${label}.kind`, { min: 4, max: 20, pattern: /^[a-z_]+$/ });
  if (!ARTIFACT_KINDS.has(kind)) fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', `${label}.kind is unsupported.`, { field: `${label}.kind` });
  return {
    artifactId: identifier(source.artifactId, `${label}.artifactId`),
    sha256: sha256(source.sha256, `${label}.sha256`),
    path: safePath(source.path, `${label}.path`),
    kind,
    sizeBytes: integer(source.sizeBytes, `${label}.sizeBytes`, { min: 1, max: 1_073_741_824 })
  };
}

function artifacts(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', 'artifacts must contain one through 100 hashed artifact pointers.', { field: 'artifacts' });
  }
  const output = value.map(artifact);
  unique(output.map(item => item.artifactId), 'artifact ids');
  unique(output.map(item => pathKey(item.path)), 'artifact paths');
  return output.sort((left, right) => compareText(left.artifactId, right.artifactId));
}

function diffExcerpt(value, index, artifactMap) {
  const label = `diffExcerpts[${index}]`;
  const source = plainObject(value, label);
  exactKeys(source, ['artifactId', 'path', 'risk', 'reason', 'startLine', 'endLine', 'excerpt'], label);
  const artifactId = identifier(source.artifactId, `${label}.artifactId`);
  const pointer = artifactMap.get(artifactId);
  if (!pointer || pointer.kind !== 'diff') {
    fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', `${label}.artifactId must reference a declared diff artifact.`, { artifactId });
  }
  const path = safePath(source.path, `${label}.path`);
  if (path !== pointer.path) {
    fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', `${label}.path must match the referenced diff artifact path.`, { artifactId, path });
  }
  const risk = safeText(source.risk, `${label}.risk`, { min: 3, max: 8, pattern: /^[a-z]+$/ });
  if (!SEVERITIES.has(risk)) fail('COORDINATOR_WORKFLOW_DIFF_INVALID', `${label}.risk is invalid.`, { field: `${label}.risk` });
  const startLine = integer(source.startLine, `${label}.startLine`, { min: 1, max: 10_000_000 });
  const endLine = integer(source.endLine, `${label}.endLine`, { min: startLine, max: 10_000_000 });
  if (endLine - startLine > 159) fail('COORDINATOR_WORKFLOW_DIFF_INVALID', `${label} must contain at most 160 source lines.`, { field: label });
  return {
    artifactId,
    artifactSha256: pointer.sha256,
    path,
    risk,
    reason: safeText(source.reason, `${label}.reason`, { min: 1, max: 240 }),
    startLine,
    endLine,
    excerpt: safeText(source.excerpt, `${label}.excerpt`, { min: 1, max: 1200 })
  };
}

function unresolved(value, index, criterionIds) {
  const label = `unresolved[${index}]`;
  const source = plainObject(value, label);
  exactKeys(source, ['id', 'severity', 'description', 'criterionIds'], label);
  const severity = safeText(source.severity, `${label}.severity`, { min: 3, max: 8, pattern: /^[a-z]+$/ });
  if (!SEVERITIES.has(severity)) fail('COORDINATOR_WORKFLOW_UNRESOLVED_INVALID', `${label}.severity is invalid.`, { field: `${label}.severity` });
  if (!Array.isArray(source.criterionIds) || source.criterionIds.length > 32) {
    fail('COORDINATOR_WORKFLOW_UNRESOLVED_INVALID', `${label}.criterionIds must contain at most 32 criterion identifiers.`, { field: `${label}.criterionIds` });
  }
  const linked = source.criterionIds.map((entry, linkedIndex) => identifier(entry, `${label}.criterionIds[${linkedIndex}]`));
  unique(linked, `${label}.criterionIds`);
  for (const criterionId of linked) {
    if (!criterionIds.has(criterionId)) fail('COORDINATOR_WORKFLOW_CRITERION_UNKNOWN', `${label} references an unknown acceptance criterion.`, { criterionId });
  }
  return {
    id: identifier(source.id, `${label}.id`),
    severity,
    description: safeText(source.description, `${label}.description`, { min: 1, max: 500 }),
    criterionIds: linked.sort()
  };
}

function evidenceForReview(manifest, artifactMap) {
  return manifest.checks.map(check => ({
    criterionId: check.criterionId,
    evidence: check.evidence.map(item => {
      const artifact = artifactMap.get(item.artifact.artifactId);
      if (!artifact || artifact.sha256 !== item.artifact.sha256 || artifact.path !== item.artifact.path) {
        fail('COORDINATOR_WORKFLOW_ARTIFACT_INVALID', 'Verification evidence must point to a declared artifact with the same hash and path.', {
          criterionId: check.criterionId,
          artifactId: item.artifact.artifactId
        });
      }
      return {
        evidenceId: item.evidenceId,
        type: item.type,
        artifact: item.artifact,
        detail: item.detail
      };
    })
  }));
}

function buildReviewPacket(value, options = {}) {
  const source = plainObject(value, 'review packet input');
  exactKeys(source, ['mission', 'verification', 'artifacts', 'diffExcerpts', 'unresolved'], 'review packet input');
  const settings = plainObject(options, 'options');
  exactKeys(settings, ['maxTokens'], 'options');
  const mission = hashMissionContract(source.mission);
  const verification = assertAcceptanceVerified(source.verification, mission.contract);
  const declaredArtifacts = artifacts(source.artifacts);
  const artifactMap = new Map(declaredArtifacts.map(item => [item.artifactId, item]));
  if (!Array.isArray(source.diffExcerpts) || source.diffExcerpts.length > 20) {
    fail('COORDINATOR_WORKFLOW_DIFF_INVALID', 'diffExcerpts must contain at most 20 bounded excerpts.', { field: 'diffExcerpts' });
  }
  const excerpts = source.diffExcerpts.map((entry, index) => diffExcerpt(entry, index, artifactMap));
  unique(excerpts.map(item => `${item.artifactId}:${item.path}:${item.startLine}:${item.endLine}`), 'diff excerpt ranges');
  excerpts.sort((left, right) => RISK_RANK[right.risk] - RISK_RANK[left.risk] || compareText(left.path, right.path) || left.startLine - right.startLine);
  if (!Array.isArray(source.unresolved) || source.unresolved.length > 32) {
    fail('COORDINATOR_WORKFLOW_UNRESOLVED_INVALID', 'unresolved must contain at most 32 items.', { field: 'unresolved' });
  }
  const criterionIds = new Set(mission.contract.acceptance.criteria.map(item => item.id));
  const unresolvedItems = source.unresolved.map((entry, index) => unresolved(entry, index, criterionIds));
  unique(unresolvedItems.map(item => item.id), 'unresolved ids');
  unresolvedItems.sort((left, right) => RISK_RANK[right.severity] - RISK_RANK[left.severity] || compareText(left.id, right.id));
  const severityCeiling = ACCEPTANCE_CEILING_RANK[mission.contract.acceptance.severityCeiling];
  const severityExceeded = unresolvedItems.filter(item => RISK_RANK[item.severity] > severityCeiling);
  if (severityExceeded.length) {
    fail('COORDINATOR_WORKFLOW_SEVERITY_EXCEEDED', 'A review packet cannot be built with unresolved findings above the mission severity ceiling.', {
      severityCeiling: mission.contract.acceptance.severityCeiling,
      unresolvedIds: severityExceeded.map(item => item.id)
    });
  }
  const maxTokens = settings.maxTokens === undefined
    ? mission.contract.budgets.maxReviewPacketTokens
    : integer(settings.maxTokens, 'options.maxTokens', { min: 256, max: 4096 });
  if (maxTokens > mission.contract.budgets.maxReviewPacketTokens || maxTokens > 4096) {
    fail('COORDINATOR_WORKFLOW_REVIEW_BUDGET_INVALID', 'The review packet budget exceeds the mission or permanent packet ceiling.', {
      maxTokens,
      missionMaximum: mission.contract.budgets.maxReviewPacketTokens
    });
  }
  const packet = {
    schemaVersion: SCHEMA_VERSION,
    mission: {
      missionId: mission.contract.missionId,
      missionVersion: mission.contract.missionVersion,
      missionHash: mission.hash,
      objective: mission.contract.objective,
      nonGoals: mission.contract.nonGoals,
      workspace: mission.contract.workspace,
      scope: mission.contract.scope,
      toolProfileId: mission.contract.toolProfileId
    },
    verification: {
      criteria: evidenceForReview(verification, artifactMap),
      regressions: verification.regressions
    },
    artifacts: declaredArtifacts,
    riskRankedDiffExcerpts: excerpts,
    unresolved: unresolvedItems
  };
  const text = canonicalJson(packet);
  const estimatedTokens = estimateTokens(text);
  if (estimatedTokens > maxTokens) {
    fail('COORDINATOR_WORKFLOW_REVIEW_PACKET_OVER_BUDGET', 'The review packet exceeds its configured token budget; reduce supplied evidence or excerpts.', { estimatedTokens, maxTokens });
  }
  return {
    packet: clone(packet),
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    estimatedTokens,
    maxTokens
  };
}

module.exports = {
  ARTIFACT_KINDS: Object.freeze([...ARTIFACT_KINDS]),
  RISK_RANK,
  SCHEMA_VERSION,
  buildReviewPacket
};

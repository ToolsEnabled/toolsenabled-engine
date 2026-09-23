'use strict';

const {
  canonicalJson,
  clone,
  compareText,
  estimateTokens,
  exactKeys,
  fail,
  hashCanonical,
  identifier,
  integer,
  isoTime,
  plainObject,
  pathKey,
  safePath,
  safeText,
  sha256,
  unique
} = require('./common');

const SCHEMA_VERSION = 2;
const OPERATIONS = new Set(['read_repository', 'edit_allowed_paths', 'run_local_tests', 'read_artifacts', 'write_artifacts']);
const EVIDENCE_TYPES = new Set(['command', 'file_hash', 'artifact_hash', 'state_assertion']);
const WAKE_EVENTS = new Set(['completed', 'failed', 'help_requested', 'approval_required', 'milestone_reached', 'budget_warning', 'budget_exceeded', 'stalled', 'timed_out', 'cancelled', 'verification_completed']);

function textList(value, label, { maximumItems, maximumLength, minimumItems = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    fail('COORDINATOR_WORKFLOW_INVALID_ARGUMENT', `${label} must contain ${minimumItems} through ${maximumItems} strings.`, { field: label });
  }
  const output = value.map((entry, index) => safeText(entry, `${label}[${index}]`, { min: 1, max: maximumLength }));
  unique(output, label);
  return output;
}

function pathList(value, label, maximumItems) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    fail('COORDINATOR_WORKFLOW_INVALID_ARGUMENT', `${label} must contain at most ${maximumItems} paths.`, { field: label });
  }
  const output = value.map((entry, index) => safePath(entry, `${label}[${index}]`));
  unique(output.map(pathKey), label);
  return output.sort(compareText);
}

function scope(value) {
  const source = plainObject(value, 'scope');
  exactKeys(source, ['allowedOperations', 'allowedPaths', 'forbiddenPaths'], 'scope');
  if (!Array.isArray(source.allowedOperations) || source.allowedOperations.length < 1 || source.allowedOperations.length > OPERATIONS.size) {
    fail('COORDINATOR_WORKFLOW_INVALID_ARGUMENT', 'scope.allowedOperations must contain one or more operations.', { field: 'scope.allowedOperations' });
  }
  const allowedOperations = source.allowedOperations.map((entry, index) => {
    const operation = safeText(entry, `scope.allowedOperations[${index}]`, { min: 3, max: 80, pattern: /^[a-z_]+$/ });
    if (!OPERATIONS.has(operation)) fail('COORDINATOR_WORKFLOW_SCOPE_INVALID', `scope.allowedOperations[${index}] is unsupported.`, { field: `scope.allowedOperations[${index}]` });
    return operation;
  });
  unique(allowedOperations, 'scope.allowedOperations');
  const allowedPaths = pathList(source.allowedPaths, 'scope.allowedPaths', 128);
  if (!allowedPaths.length) fail('COORDINATOR_WORKFLOW_SCOPE_INVALID', 'scope.allowedPaths must not be empty.', { field: 'scope.allowedPaths' });
  const forbiddenPaths = pathList(source.forbiddenPaths, 'scope.forbiddenPaths', 128);
  const forbiddenPathKeys = new Set(forbiddenPaths.map(pathKey));
  const overlap = allowedPaths.find(path => forbiddenPathKeys.has(pathKey(path)));
  if (overlap) fail('COORDINATOR_WORKFLOW_SCOPE_INVALID', 'scope paths must not be both allowed and forbidden.', { path: overlap });
  return { allowedOperations: [...allowedOperations].sort(), allowedPaths, forbiddenPaths };
}

function criterion(value, index) {
  const source = plainObject(value, `acceptance.criteria[${index}]`);
  exactKeys(source, ['id', 'description', 'requiredEvidenceTypes'], `acceptance.criteria[${index}]`);
  const id = identifier(source.id, `acceptance.criteria[${index}].id`);
  const description = safeText(source.description, `acceptance.criteria[${index}].description`, { min: 1, max: 600 });
  if (!Array.isArray(source.requiredEvidenceTypes) || source.requiredEvidenceTypes.length < 1 || source.requiredEvidenceTypes.length > EVIDENCE_TYPES.size) {
    fail('COORDINATOR_WORKFLOW_ACCEPTANCE_INVALID', `acceptance.criteria[${index}].requiredEvidenceTypes must not be empty.`, { field: `acceptance.criteria[${index}].requiredEvidenceTypes` });
  }
  const requiredEvidenceTypes = source.requiredEvidenceTypes.map((entry, evidenceIndex) => {
    const type = safeText(entry, `acceptance.criteria[${index}].requiredEvidenceTypes[${evidenceIndex}]`, { min: 3, max: 40, pattern: /^[a-z_]+$/ });
    if (!EVIDENCE_TYPES.has(type)) fail('COORDINATOR_WORKFLOW_ACCEPTANCE_INVALID', 'An acceptance criterion has an unsupported evidence type.', { field: `acceptance.criteria[${index}].requiredEvidenceTypes[${evidenceIndex}]` });
    return type;
  });
  unique(requiredEvidenceTypes, `acceptance.criteria[${index}].requiredEvidenceTypes`);
  return { id, description, requiredEvidenceTypes: [...requiredEvidenceTypes].sort() };
}

function acceptance(value) {
  const source = plainObject(value, 'acceptance');
  exactKeys(source, ['criteria', 'severityCeiling'], 'acceptance');
  if (!Array.isArray(source.criteria) || source.criteria.length < 1 || source.criteria.length > 32) {
    fail('COORDINATOR_WORKFLOW_ACCEPTANCE_INVALID', 'acceptance.criteria must contain one through 32 criteria.', { field: 'acceptance.criteria' });
  }
  const criteria = source.criteria.map(criterion);
  unique(criteria.map(item => item.id), 'acceptance.criteria ids');
  const severityCeiling = safeText(source.severityCeiling, 'acceptance.severityCeiling', { min: 2, max: 16, pattern: /^(?:none|low|medium)$/ });
  return { criteria: criteria.sort((left, right) => compareText(left.id, right.id)), severityCeiling };
}

function budgets(value) {
  const source = plainObject(value, 'budgets');
  exactKeys(source, ['maxWorkerContextTokens', 'maxCheckpointTokens', 'maxReviewPacketTokens', 'maxReviewEvents'], 'budgets');
  const maxWorkerContextTokens = integer(source.maxWorkerContextTokens, 'budgets.maxWorkerContextTokens', { min: 512, max: 65536 });
  const maxCheckpointTokens = integer(source.maxCheckpointTokens, 'budgets.maxCheckpointTokens', { min: 64, max: 2000 });
  const maxReviewPacketTokens = integer(source.maxReviewPacketTokens, 'budgets.maxReviewPacketTokens', { min: 256, max: 4096 });
  const maxReviewEvents = integer(source.maxReviewEvents, 'budgets.maxReviewEvents', { min: 0, max: 8 });
  return { maxWorkerContextTokens, maxCheckpointTokens, maxReviewPacketTokens, maxReviewEvents };
}

function validateMissionContract(value) {
  const source = plainObject(value, 'mission contract');
  exactKeys(source, ['schemaVersion', 'missionId', 'missionVersion', 'createdAt', 'objective', 'nonGoals', 'workspace', 'scope', 'toolProfileId', 'acceptance', 'budgets', 'wakeEvents'], 'mission contract');
  if (source.schemaVersion !== SCHEMA_VERSION) {
    fail('COORDINATOR_WORKFLOW_VERSION_INVALID', `mission contract schemaVersion must be ${SCHEMA_VERSION}.`, { field: 'schemaVersion' });
  }
  const workspace = plainObject(source.workspace, 'workspace');
  exactKeys(workspace, ['repository', 'baseSnapshotSha256'], 'workspace');
  const output = {
    schemaVersion: SCHEMA_VERSION,
    missionId: identifier(source.missionId, 'missionId'),
    missionVersion: integer(source.missionVersion, 'missionVersion', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    createdAt: isoTime(source.createdAt, 'createdAt'),
    objective: safeText(source.objective, 'objective', { min: 1, max: 3000 }),
    nonGoals: textList(source.nonGoals, 'nonGoals', { maximumItems: 32, maximumLength: 500 }),
    workspace: {
      repository: safeText(workspace.repository, 'workspace.repository', { min: 1, max: 120, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/ }),
      baseSnapshotSha256: sha256(workspace.baseSnapshotSha256, 'workspace.baseSnapshotSha256')
    },
    scope: scope(source.scope),
    toolProfileId: identifier(source.toolProfileId, 'toolProfileId'),
    acceptance: acceptance(source.acceptance),
    budgets: budgets(source.budgets),
    wakeEvents: textList(source.wakeEvents, 'wakeEvents', { minimumItems: 1, maximumItems: WAKE_EVENTS.size, maximumLength: 40 })
  };
  for (const event of output.wakeEvents) {
    if (!WAKE_EVENTS.has(event)) fail('COORDINATOR_WORKFLOW_WAKE_INVALID', `wakeEvents contains unsupported event '${event}'.`, { field: 'wakeEvents' });
  }
  unique(output.wakeEvents, 'wakeEvents');
  output.wakeEvents.sort();
  return clone(output);
}

function hashMissionContract(value) {
  const contract = validateMissionContract(value);
  const canonical = canonicalJson(contract);
  return { contract, canonical, hash: hashCanonical(contract) };
}

function renderCompactMission(value, options = {}) {
  const allowedOptions = plainObject(options, 'options');
  exactKeys(allowedOptions, ['maxTokens'], 'options');
  const { contract, hash } = hashMissionContract(value);
  const maxTokens = allowedOptions.maxTokens === undefined
    ? Math.min(contract.budgets.maxWorkerContextTokens, 4096)
    : integer(allowedOptions.maxTokens, 'options.maxTokens', { min: 128, max: 65536 });
  const lines = [
    `MISSION ${contract.missionId}@${contract.missionVersion} ${hash}`,
    `PROFILE ${contract.toolProfileId}`,
    `OBJECTIVE ${JSON.stringify(contract.objective)}`,
    `NON_GOALS ${contract.nonGoals.map(item => JSON.stringify(item)).join(' | ') || 'none'}`,
    `WORKSPACE ${contract.workspace.repository} ${contract.workspace.baseSnapshotSha256}`,
    `SCOPE operations=${contract.scope.allowedOperations.join(',')} allowed=${contract.scope.allowedPaths.join(',')} forbidden=${contract.scope.forbiddenPaths.join(',') || 'none'}`,
    'ACCEPTANCE',
    ...contract.acceptance.criteria.map(item => `${item.id}: ${JSON.stringify(item.description)} [${item.requiredEvidenceTypes.join(',')}]`),
    `SEVERITY_CEILING ${contract.acceptance.severityCeiling}`,
    `BUDGETS worker=${contract.budgets.maxWorkerContextTokens} checkpoint=${contract.budgets.maxCheckpointTokens} review=${contract.budgets.maxReviewPacketTokens} events=${contract.budgets.maxReviewEvents}`,
    `WAKE ${contract.wakeEvents.join(',')}`
  ];
  const text = lines.join('\n');
  const estimatedTokens = estimateTokens(text);
  if (estimatedTokens > maxTokens) {
    fail('COORDINATOR_WORKFLOW_MISSION_RENDER_OVER_BUDGET', 'The compact mission renderer exceeded its token budget.', { estimatedTokens, maxTokens });
  }
  return { missionId: contract.missionId, missionVersion: contract.missionVersion, hash, text, estimatedTokens };
}

module.exports = {
  EVIDENCE_TYPES: Object.freeze([...EVIDENCE_TYPES]),
  OPERATIONS: Object.freeze([...OPERATIONS]),
  SCHEMA_VERSION,
  WAKE_EVENTS: Object.freeze([...WAKE_EVENTS]),
  hashMissionContract,
  renderCompactMission,
  validateMissionContract
};

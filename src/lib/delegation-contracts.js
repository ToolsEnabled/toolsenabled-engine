'use strict';

// Q21/P1.  These contracts deliberately have no registry entry, task-store
// write, provider, browser, vault, or executor dependency.  They are a
// fail-closed vocabulary for a later broker; defining a contract never grants
// a worker authority.
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const HASH_DOMAIN = 'toolsenabled.delegation-contract.v1';
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA1 = /^[a-f0-9]{40}$/;
const ID = /^[a-z][a-z0-9._-]{2,119}$/;
const OPAQUE_ID = /^(?:dlg|wrk|evb|esc)_[A-Za-z0-9_-]{16,96}$/;
const REF = /^[a-z][a-z0-9._:-]{2,159}$/;
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:api[_-]?key|token|password|cookie|otp|mfa|secret)\b|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})/i;
const ROLES = Object.freeze(['read_only_review', 'deterministic_verification', 'disposable_edit']);
const TERMINAL_STATES = Object.freeze(['complete', 'blocked', 'cancelled', 'failed']);
const VERIFICATION_STATES = Object.freeze(['passed', 'failed', 'not_run']);
const REQUESTED_DECISIONS = Object.freeze(['clarify_scope', 'resolve_evidence', 'approve_repair_plan', 'route_to_owner']);

class DelegationContractError extends Error {
  constructor(code, message) { super(message); this.name = 'DelegationContractError'; this.code = code; }
}
function fail(code, message) { throw new DelegationContractError(code, message); }
function plain(value) {
  if (!value || typeof value !== 'object') return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    fail('DELEGATION_CONTRACT_INVALID', 'Contract object type could not be established.');
  }
}
function exact(value, keys, required, label) {
  if (!plain(value)) fail('DELEGATION_CONTRACT_INVALID', `${label} must be a closed object.`);
  let actual;
  try {
    actual = Reflect.ownKeys(value);
  } catch {
    fail('DELEGATION_CONTRACT_INVALID', `${label} must be a closed object.`);
  }
  if (actual.some(key => typeof key !== 'string' || !keys.includes(key))
      || required.some(key => !actual.includes(key))) {
    fail('DELEGATION_CONTRACT_INVALID', `${label} has unsupported or missing fields.`);
  }
  const snapshot = {};
  for (const key of actual) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail('DELEGATION_CONTRACT_INVALID', `${label} must contain only data fields.`);
    }
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('DELEGATION_CONTRACT_INVALID', `${label} must contain only enumerable data fields.`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}
function arrayItems(value, label, { min = 0, max = 4096 } = {}) {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail('DELEGATION_CONTRACT_INVALID', `${label} is invalid.`);
  }
  if (!isArray) fail('DELEGATION_CONTRACT_INVALID', `${label} is invalid.`);
  let actual;
  let lengthDescriptor;
  try {
    actual = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail('DELEGATION_CONTRACT_INVALID', `${label} is invalid.`);
  }
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < min || lengthDescriptor.value > max) {
    fail('DELEGATION_CONTRACT_INVALID', `${label} is invalid.`);
  }
  const length = lengthDescriptor.value;
  if (actual.length !== length + 1 || !actual.includes('length')
      || actual.some(key => typeof key !== 'string'
        || (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) {
    fail('DELEGATION_CONTRACT_INVALID', `${label} has unsupported or missing fields.`);
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!actual.includes(key)) fail('DELEGATION_CONTRACT_INVALID', `${label} is sparse.`);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail('DELEGATION_CONTRACT_INVALID', `${label} must contain only data items.`);
    }
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('DELEGATION_CONTRACT_INVALID', `${label} must contain only enumerable data items.`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}
function safe(value, label, pattern, max = 240) {
  if (typeof value !== 'string' || !value || value.length > max || !pattern.test(value) || SENSITIVE.test(value)) {
    fail('DELEGATION_CONTRACT_INVALID', `${label} is invalid.`);
  }
  return value;
}
function id(value, label) { return safe(value, label, ID, 120); }
function opaque(value, label, prefix) {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value) || !value.startsWith(prefix) || SENSITIVE.test(value)) fail('DELEGATION_CONTRACT_INVALID', `${label} is invalid.`);
  return value;
}
function hash(value, label) { return safe(value, label, SHA256, 64); }
function git(value, label) { return safe(value, label, GIT_SHA1, 40); }
function ref(value, label) { return safe(value, label, REF, 160); }
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('DELEGATION_CONTRACT_INVALID', `${label} is invalid.`);
  return value;
}
function oneOf(value, values, label) {
  if (!values.includes(value)) fail('DELEGATION_CONTRACT_INVALID', `${label} is invalid.`);
  return value;
}
function sortedUnique(values, label, validator, { min = 0, max = 64 } = {}) {
  const items = arrayItems(values, label, { min, max });
  const normalized = items.map((value, index) => validator(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail('DELEGATION_CONTRACT_INVALID', `${label} contains duplicates.`);
  return Object.freeze([...normalized].sort());
}
function stable(value) {
  let isArray = false;
  try { isArray = Array.isArray(value); } catch { fail('DELEGATION_CONTRACT_INVALID', 'Digest input is invalid.'); }
  if (isArray) return arrayItems(value, 'digest array').map(stable);
  if (plain(value)) {
    let keys;
    try { keys = Reflect.ownKeys(value); } catch { fail('DELEGATION_CONTRACT_INVALID', 'Digest input is invalid.'); }
    if (keys.some(key => typeof key !== 'string')) fail('DELEGATION_CONTRACT_INVALID', 'Digest input is invalid.');
    return Object.fromEntries(keys.sort().map(key => {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail('DELEGATION_CONTRACT_INVALID', 'Digest input is invalid.'); }
      if (!descriptor || descriptor.enumerable !== true
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail('DELEGATION_CONTRACT_INVALID', 'Digest input must contain only enumerable data fields.');
      }
      return [key, stable(descriptor.value)];
    }));
  }
  if (value !== null && (typeof value === 'object' || typeof value === 'function'
      || typeof value === 'symbol' || typeof value === 'bigint' || value === undefined)) {
    fail('DELEGATION_CONTRACT_INVALID', 'Digest input is invalid.');
  }
  return value;
}
function digest(kind, value) {
  if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(kind)) {
    fail('DELEGATION_CONTRACT_INVALID', 'Digest kind is invalid.');
  }
  return crypto.createHash('sha256').update(`${HASH_DOMAIN}\0${kind}\0${JSON.stringify(stable(value))}`).digest('hex');
}
function frozen(value) { return Object.freeze(value); }

function baseSnapshot(value) {
  value = exact(value, ['rootId', 'commitSha1', 'treeSha256'], ['rootId', 'commitSha1', 'treeSha256'], 'baseSnapshot');
  return frozen({ rootId: id(value.rootId, 'baseSnapshot.rootId'), commitSha1: git(value.commitSha1, 'baseSnapshot.commitSha1'), treeSha256: hash(value.treeSha256, 'baseSnapshot.treeSha256') });
}
function budgets(value) {
  value = exact(value, ['maxWallMs', 'maxModelTokens', 'maxToolCalls', 'maxEvidenceBytes'], ['maxWallMs', 'maxModelTokens', 'maxToolCalls', 'maxEvidenceBytes'], 'budgets');
  return frozen({
    maxWallMs: integer(value.maxWallMs, 'budgets.maxWallMs', 1_000, 24 * 60 * 60 * 1_000),
    maxModelTokens: integer(value.maxModelTokens, 'budgets.maxModelTokens', 0, 2_000_000),
    maxToolCalls: integer(value.maxToolCalls, 'budgets.maxToolCalls', 0, 10_000),
    maxEvidenceBytes: integer(value.maxEvidenceBytes, 'budgets.maxEvidenceBytes', 0, 8 * 1024 * 1024)
  });
}
function validateDelegatedTask(value) {
  value = exact(value, ['schemaVersion', 'delegationId', 'goalId', 'phaseId', 'role', 'baseSnapshot', 'acceptanceCriteria', 'capabilityProfileHash', 'budgets', 'terminalStates'],
    ['schemaVersion', 'delegationId', 'goalId', 'phaseId', 'role', 'baseSnapshot', 'acceptanceCriteria', 'capabilityProfileHash', 'budgets', 'terminalStates'], 'DelegatedTask');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('DELEGATION_CONTRACT_VERSION_UNSUPPORTED', 'DelegatedTask schema version is unsupported.');
  const output = {
    schemaVersion: SCHEMA_VERSION,
    delegationId: opaque(value.delegationId, 'delegationId', 'dlg_'),
    goalId: id(value.goalId, 'goalId'),
    phaseId: id(value.phaseId, 'phaseId'),
    role: oneOf(value.role, ROLES, 'role'),
    baseSnapshot: baseSnapshot(value.baseSnapshot),
    acceptanceCriteria: sortedUnique(value.acceptanceCriteria, 'acceptanceCriteria', id, { min: 1, max: 128 }),
    capabilityProfileHash: hash(value.capabilityProfileHash, 'capabilityProfileHash'),
    budgets: budgets(value.budgets),
    terminalStates: sortedUnique(value.terminalStates, 'terminalStates', (item, label) => oneOf(item, TERMINAL_STATES, label), { min: 1, max: TERMINAL_STATES.length })
  };
  return frozen({ ...output, contractHash: digest('DelegatedTask', output) });
}

function verification(value) {
  value = exact(value, ['state', 'criterionIds', 'evidenceRefs'], ['state', 'criterionIds', 'evidenceRefs'], 'verification');
  return frozen({
    state: oneOf(value.state, VERIFICATION_STATES, 'verification.state'),
    criterionIds: sortedUnique(value.criterionIds, 'verification.criterionIds', id, { max: 128 }),
    evidenceRefs: sortedUnique(value.evidenceRefs, 'verification.evidenceRefs', ref, { max: 128 })
  });
}
function artifact(value, index) {
  value = exact(value, ['kind', 'sha256', 'sizeBytes'], ['kind', 'sha256', 'sizeBytes'], `artifacts[${index}]`);
  return frozen({ kind: oneOf(value.kind, ['patch', 'archive', 'report', 'test-output'], `artifacts[${index}].kind`), sha256: hash(value.sha256, `artifacts[${index}].sha256`), sizeBytes: integer(value.sizeBytes, `artifacts[${index}].sizeBytes`, 1, 64 * 1024 * 1024) });
}
function usage(value) {
  value = exact(value, ['modelTokens', 'toolCalls', 'wallMs', 'usageRecordRefs'], ['modelTokens', 'toolCalls', 'wallMs', 'usageRecordRefs'], 'usage');
  return frozen({ modelTokens: integer(value.modelTokens, 'usage.modelTokens', 0, 2_000_000), toolCalls: integer(value.toolCalls, 'usage.toolCalls', 0, 10_000), wallMs: integer(value.wallMs, 'usage.wallMs', 0, 24 * 60 * 60 * 1_000), usageRecordRefs: sortedUnique(value.usageRecordRefs, 'usage.usageRecordRefs', ref, { max: 64 }) });
}
function validateWorkerResult(value) {
  value = exact(value, ['schemaVersion', 'workerResultId', 'delegationId', 'attempt', 'terminalState', 'baseSnapshot', 'capabilityProfileHash', 'artifacts', 'verification', 'blockerCode', 'usage', 'brokerAcceptanceState'],
    ['schemaVersion', 'workerResultId', 'delegationId', 'attempt', 'terminalState', 'baseSnapshot', 'capabilityProfileHash', 'artifacts', 'verification', 'blockerCode', 'usage', 'brokerAcceptanceState'], 'WorkerResult');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('DELEGATION_CONTRACT_VERSION_UNSUPPORTED', 'WorkerResult schema version is unsupported.');
  const output = {
    schemaVersion: SCHEMA_VERSION, workerResultId: opaque(value.workerResultId, 'workerResultId', 'wrk_'), delegationId: opaque(value.delegationId, 'delegationId', 'dlg_'),
    attempt: integer(value.attempt, 'attempt', 1, 10_000), terminalState: oneOf(value.terminalState, TERMINAL_STATES, 'terminalState'),
    baseSnapshot: baseSnapshot(value.baseSnapshot), capabilityProfileHash: hash(value.capabilityProfileHash, 'capabilityProfileHash'),
    artifacts: Object.freeze(arrayItems(value.artifacts, 'artifacts', { max: 64 }).map(artifact)), verification: verification(value.verification),
    blockerCode: value.blockerCode === null ? null : id(value.blockerCode, 'blockerCode'), usage: usage(value.usage),
    brokerAcceptanceState: oneOf(value.brokerAcceptanceState, ['UNACCEPTED'], 'brokerAcceptanceState')
  };
  if (output.terminalState === 'blocked' && !output.blockerCode) fail('DELEGATION_CONTRACT_INVALID', 'A blocked WorkerResult requires a bounded blocker code.');
  if (output.terminalState !== 'blocked' && output.blockerCode !== null) fail('DELEGATION_CONTRACT_INVALID', 'Only a blocked WorkerResult may carry a blocker code.');
  return frozen({ ...output, contractHash: digest('WorkerResult', output) });
}

function evidenceRecord(value, index) {
  value = exact(value, ['ref', 'sha256', 'sizeBytes', 'kind'], ['ref', 'sha256', 'sizeBytes', 'kind'], `records[${index}]`);
  return frozen({ ref: ref(value.ref, `records[${index}].ref`), sha256: hash(value.sha256, `records[${index}].sha256`), sizeBytes: integer(value.sizeBytes, `records[${index}].sizeBytes`, 1, 8 * 1024 * 1024), kind: oneOf(value.kind, ['verification', 'artifact', 'receipt'], `records[${index}].kind`) });
}
function validateEvidenceBundle(value) {
  value = exact(value, ['schemaVersion', 'bundleId', 'delegationId', 'workerResultHash', 'records'], ['schemaVersion', 'bundleId', 'delegationId', 'workerResultHash', 'records'], 'EvidenceBundle');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('DELEGATION_CONTRACT_VERSION_UNSUPPORTED', 'EvidenceBundle schema version is unsupported.');
  const records = arrayItems(value.records, 'EvidenceBundle records', { max: 128 }).map(evidenceRecord);
  if (new Set(records.map(item => item.ref)).size !== records.length) fail('DELEGATION_CONTRACT_INVALID', 'EvidenceBundle record references must be unique.');
  const output = { schemaVersion: SCHEMA_VERSION, bundleId: opaque(value.bundleId, 'bundleId', 'evb_'), delegationId: opaque(value.delegationId, 'delegationId', 'dlg_'), workerResultHash: hash(value.workerResultHash, 'workerResultHash'), records: Object.freeze([...records].sort((a, b) => a.ref.localeCompare(b.ref))) };
  return frozen({ ...output, contractHash: digest('EvidenceBundle', output) });
}

function validateEscalationPacket(value) {
  value = exact(value, ['schemaVersion', 'escalationId', 'delegationId', 'disputedDecisionCode', 'verifiedFactRefs', 'failedCriteria', 'evidenceBundleHash', 'requestedDecision'],
    ['schemaVersion', 'escalationId', 'delegationId', 'disputedDecisionCode', 'verifiedFactRefs', 'failedCriteria', 'evidenceBundleHash', 'requestedDecision'], 'EscalationPacket');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('DELEGATION_CONTRACT_VERSION_UNSUPPORTED', 'EscalationPacket schema version is unsupported.');
  const output = {
    schemaVersion: SCHEMA_VERSION, escalationId: opaque(value.escalationId, 'escalationId', 'esc_'), delegationId: opaque(value.delegationId, 'delegationId', 'dlg_'),
    disputedDecisionCode: id(value.disputedDecisionCode, 'disputedDecisionCode'), verifiedFactRefs: sortedUnique(value.verifiedFactRefs, 'verifiedFactRefs', ref, { min: 1, max: 64 }),
    failedCriteria: sortedUnique(value.failedCriteria, 'failedCriteria', id, { max: 128 }), evidenceBundleHash: hash(value.evidenceBundleHash, 'evidenceBundleHash'), requestedDecision: oneOf(value.requestedDecision, REQUESTED_DECISIONS, 'requestedDecision')
  };
  return frozen({ ...output, contractHash: digest('EscalationPacket', output) });
}

function assertResultForTask(taskInput, resultInput) {
  const task = validateDelegatedTask(taskInput); const result = validateWorkerResult(resultInput);
  if (result.delegationId !== task.delegationId || result.capabilityProfileHash !== task.capabilityProfileHash || result.baseSnapshot.commitSha1 !== task.baseSnapshot.commitSha1 || result.baseSnapshot.treeSha256 !== task.baseSnapshot.treeSha256 || result.baseSnapshot.rootId !== task.baseSnapshot.rootId) {
    fail('DELEGATION_CONTRACT_STALE_OR_MISMATCHED', 'WorkerResult does not bind the exact DelegatedTask base snapshot and capability profile.');
  }
  if (!task.terminalStates.includes(result.terminalState)) fail('DELEGATION_CONTRACT_TERMINAL_STATE_DENIED', 'WorkerResult terminal state was not permitted by DelegatedTask.');
  if (result.usage.modelTokens > task.budgets.maxModelTokens || result.usage.toolCalls > task.budgets.maxToolCalls || result.usage.wallMs > task.budgets.maxWallMs) {
    fail('DELEGATION_CONTRACT_BUDGET_EXCEEDED', 'WorkerResult exceeds the DelegatedTask budget.');
  }
  if (result.verification.criterionIds.some(item => !task.acceptanceCriteria.includes(item))) fail('DELEGATION_CONTRACT_CRITERION_DENIED', 'WorkerResult names an acceptance criterion outside DelegatedTask.');
  return frozen({ task, result, acceptedByBroker: false });
}

function schemaDocument() {
  const opaque = '^(?:dlg|wrk|evb|esc)_[A-Za-z0-9_-]{16,96}$';
  const closed = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
  const string = (pattern, minLength, maxLength) => ({ type: 'string', pattern, minLength, maxLength });
  const hashSchema = string('^[a-f0-9]{64}$', 64, 64);
  const idSchema = string('^[a-z][a-z0-9._-]{2,119}$', 3, 120);
  const refSchema = string('^[a-z][a-z0-9._:-]{2,159}$', 3, 160);
  const snapshot = closed({ rootId: idSchema, commitSha1: string('^[a-f0-9]{40}$', 40, 40), treeSha256: hashSchema }, ['rootId', 'commitSha1', 'treeSha256']);
  const contracts = {
    DelegatedTask: closed({ schemaVersion: { const: SCHEMA_VERSION }, delegationId: { allOf: [string(opaque, 20, 100), { pattern: '^dlg_' }] }, goalId: idSchema, phaseId: idSchema, role: { enum: ROLES }, baseSnapshot: snapshot, acceptanceCriteria: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: idSchema }, capabilityProfileHash: hashSchema, budgets: closed({ maxWallMs: { type: 'integer', minimum: 1000, maximum: 86400000 }, maxModelTokens: { type: 'integer', minimum: 0, maximum: 2000000 }, maxToolCalls: { type: 'integer', minimum: 0, maximum: 10000 }, maxEvidenceBytes: { type: 'integer', minimum: 0, maximum: 8388608 } }, ['maxWallMs', 'maxModelTokens', 'maxToolCalls', 'maxEvidenceBytes']), terminalStates: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { enum: TERMINAL_STATES } } }, ['schemaVersion', 'delegationId', 'goalId', 'phaseId', 'role', 'baseSnapshot', 'acceptanceCriteria', 'capabilityProfileHash', 'budgets', 'terminalStates']),
    WorkerResult: closed({ schemaVersion: { const: SCHEMA_VERSION }, workerResultId: { allOf: [string(opaque, 20, 100), { pattern: '^wrk_' }] }, delegationId: { allOf: [string(opaque, 20, 100), { pattern: '^dlg_' }] }, attempt: { type: 'integer', minimum: 1, maximum: 10000 }, terminalState: { enum: TERMINAL_STATES }, baseSnapshot: snapshot, capabilityProfileHash: hashSchema, artifacts: { type: 'array', maxItems: 64, items: closed({ kind: { enum: ['patch', 'archive', 'report', 'test-output'] }, sha256: hashSchema, sizeBytes: { type: 'integer', minimum: 1, maximum: 67108864 } }, ['kind', 'sha256', 'sizeBytes']) }, verification: closed({ state: { enum: VERIFICATION_STATES }, criterionIds: { type: 'array', maxItems: 128, uniqueItems: true, items: idSchema }, evidenceRefs: { type: 'array', maxItems: 128, uniqueItems: true, items: refSchema } }, ['state', 'criterionIds', 'evidenceRefs']), blockerCode: { anyOf: [{ type: 'null' }, idSchema] }, usage: closed({ modelTokens: { type: 'integer', minimum: 0, maximum: 2000000 }, toolCalls: { type: 'integer', minimum: 0, maximum: 10000 }, wallMs: { type: 'integer', minimum: 0, maximum: 86400000 }, usageRecordRefs: { type: 'array', maxItems: 64, uniqueItems: true, items: refSchema } }, ['modelTokens', 'toolCalls', 'wallMs', 'usageRecordRefs']), brokerAcceptanceState: { const: 'UNACCEPTED' } }, ['schemaVersion', 'workerResultId', 'delegationId', 'attempt', 'terminalState', 'baseSnapshot', 'capabilityProfileHash', 'artifacts', 'verification', 'blockerCode', 'usage', 'brokerAcceptanceState']),
    EvidenceBundle: closed({ schemaVersion: { const: SCHEMA_VERSION }, bundleId: { allOf: [string(opaque, 20, 100), { pattern: '^evb_' }] }, delegationId: { allOf: [string(opaque, 20, 100), { pattern: '^dlg_' }] }, workerResultHash: hashSchema, records: { type: 'array', maxItems: 128, items: closed({ ref: refSchema, sha256: hashSchema, sizeBytes: { type: 'integer', minimum: 1, maximum: 8388608 }, kind: { enum: ['verification', 'artifact', 'receipt'] } }, ['ref', 'sha256', 'sizeBytes', 'kind']) } }, ['schemaVersion', 'bundleId', 'delegationId', 'workerResultHash', 'records']),
    EscalationPacket: closed({ schemaVersion: { const: SCHEMA_VERSION }, escalationId: { allOf: [string(opaque, 20, 100), { pattern: '^esc_' }] }, delegationId: { allOf: [string(opaque, 20, 100), { pattern: '^dlg_' }] }, disputedDecisionCode: idSchema, verifiedFactRefs: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: refSchema }, failedCriteria: { type: 'array', maxItems: 128, uniqueItems: true, items: idSchema }, evidenceBundleHash: hashSchema, requestedDecision: { enum: REQUESTED_DECISIONS } }, ['schemaVersion', 'escalationId', 'delegationId', 'disputedDecisionCode', 'verifiedFactRefs', 'failedCriteria', 'evidenceBundleHash', 'requestedDecision'])
  };
  return frozen({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:toolsenabled:delegation-contracts:1.0.0', title: 'ToolsEnabled inert provider-neutral delegation contracts', schemaVersion: SCHEMA_VERSION, additionalProperties: false, $defs: contracts });
}

module.exports = Object.freeze({
  DelegationContractError, HASH_DOMAIN, REQUESTED_DECISIONS, ROLES, SCHEMA_VERSION, TERMINAL_STATES, VERIFICATION_STATES,
  assertResultForTask, digest, schemaDocument, validateDelegatedTask, validateEscalationPacket, validateEvidenceBundle, validateWorkerResult
});

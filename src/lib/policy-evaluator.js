'use strict';

// P13 deterministic policy kernel. This intentionally has no provider,
// browser, vault, state-store, clock, environment, or prompt dependency. A
// caller supplies only bounded facts; decisions are stable under replay.

const { canonicalHash } = require('../../schemas/generated/platform.identity');
const provenance = require('../../schemas/generated/platform.provenance');
const { p13PolicyActionCatalog } = require('./tool-registry');

const RULE_SCHEMA = require('../../schemas/platform/policy-rule.schema.json');
const REQUEST_SCHEMA = require('../../schemas/platform/policy-request.schema.json');
const DECISION_SCHEMA = require('../../schemas/platform/policy-decision.schema.json');

const SCHEMA_VERSION = 1;
const POLICY_VERSION = '1.0.0';
const RULE_HASH_DOMAIN = 'coordinator.policy-rule-set.v1';
const REQUEST_HASH_DOMAIN = 'coordinator.policy-request.v1';
const DECISION_HASH_DOMAIN = 'coordinator.policy-decision.v1';
const ACTION_ID = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
const SAFE_WORD = /^[a-z][a-z0-9-]{1,63}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const HASH = /^[a-f0-9]{64}$/;
const EFFECT_VALUES = Object.freeze(['local-read', 'local-write', 'external-read', 'external-write']);
const ACTION_KIND_VALUES = Object.freeze([
  'tool-dispatch', 'secret-access', 'generated-code-execution', 'finance-order',
  'authenticated-browser', 'recursive-delegation', 'external-write', 'local-write', 'unmapped'
]);
const TARGET_KIND_VALUES = Object.freeze(['local', 'external', 'account', 'secret', 'browser-session', 'finance', 'agent']);
const RISK_VALUES = Object.freeze(['low', 'medium', 'high', 'critical']);
const USER_VALUES = Object.freeze(['owner-authenticated', 'agent', 'unknown']);
const CAPABILITY_STATUS_VALUES = Object.freeze(['authorized', 'missing', 'expired', 'revoked', 'denied']);
const APPROVAL_STATUS_VALUES = Object.freeze(['not-required', 'missing', 'valid', 'consumed', 'expired', 'rejected']);
const SPECIAL_USER_ACTION_VALUES = Object.freeze(['secret-access', 'finance-order', 'authenticated-browser']);
const CONSEQUENTIAL_EFFECT_VALUES = Object.freeze(['local-write', 'external-write']);
// Captured once from the registry's protected startup snapshot. In particular,
// this never reads the mutable public TOOL_REGISTRY export at evaluation time.
const POLICY_ACTION_CATALOG = p13PolicyActionCatalog();

const includes = (values, value) => values.includes(value);

function actionCatalog() {
  return POLICY_ACTION_CATALOG;
}

function actionSpec(actionId) {
  return actionCatalog().find(item => item.name === actionId) || null;
}

class PolicyEvaluationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PolicyEvaluationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PolicyEvaluationError(code, message, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, allowed, label, required = []) {
  if (!plainObject(value)) fail('POLICY_REQUEST_INVALID', `${label} must be a plain object.`, { field: label });
  const keys = Object.keys(value);
  const unexpected = keys.filter(key => !allowed.includes(key));
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (unexpected.length || missing.length) {
    fail('POLICY_REQUEST_INVALID', `${label} has unsupported or missing fields.`, { field: label, unexpected, missing });
  }
  return value;
}

function word(value, label) {
  if (typeof value !== 'string' || !SAFE_WORD.test(value)) fail('POLICY_REQUEST_INVALID', `${label} is invalid.`, { field: label });
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('POLICY_REQUEST_INVALID', `${label} must be a SHA-256 digest.`, { field: label });
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneProvenance(value) {
  if (value === null) return null;
  try { provenance.validateEnvelope(value); }
  catch (error) { fail('POLICY_REQUEST_INVALID', 'provenance must be a canonical P08 provenance envelope.', { field: 'provenance', cause: error.code }); }
  return deepFreeze({
    schemaVersion: value.schemaVersion,
    labels: [...value.labels],
    sources: value.sources.map(item => ({ evidenceId: item.evidenceId, contentHash: item.contentHash }))
  });
}

function cloneCapability(value) {
  if (value === null) return null;
  exactKeys(value, ['status', 'profileHash', 'requestHash', 'taskId', 'tool'], 'capability', ['status', 'profileHash', 'requestHash', 'taskId', 'tool']);
  if (!TASK_ID.test(value.taskId)) fail('POLICY_REQUEST_INVALID', 'capability.taskId is invalid.', { field: 'capability.taskId' });
  if (typeof value.tool !== 'string' || !ACTION_ID.test(value.tool)) fail('POLICY_REQUEST_INVALID', 'capability.tool is invalid.', { field: 'capability.tool' });
  return deepFreeze({
    status: word(value.status, 'capability.status'),
    profileHash: hash(value.profileHash, 'capability.profileHash'),
    requestHash: hash(value.requestHash, 'capability.requestHash'),
    taskId: value.taskId,
    tool: value.tool
  });
}

function cloneTarget(value) {
  if (value === null) return null;
  exactKeys(value, ['kind', 'identifierHash', 'pinned'], 'target', ['kind', 'identifierHash', 'pinned']);
  if (typeof value.pinned !== 'boolean') fail('POLICY_REQUEST_INVALID', 'target.pinned must be boolean.', { field: 'target.pinned' });
  return deepFreeze({ kind: word(value.kind, 'target.kind'), identifierHash: hash(value.identifierHash, 'target.identifierHash'), pinned: value.pinned });
}

function cloneUser(value) {
  if (value === null) return null;
  exactKeys(value, ['kind'], 'user', ['kind']);
  return deepFreeze({ kind: word(value.kind, 'user.kind') });
}

function cloneApproval(value) {
  if (value === null) return null;
  exactKeys(value, ['status'], 'approval', ['status']);
  return deepFreeze({ status: word(value.status, 'approval.status') });
}

function validateRequest(value) {
  exactKeys(value, ['schemaVersion', 'action', 'provenance', 'capability', 'task', 'target', 'user', 'approval'], 'policy request', [
    'schemaVersion', 'action', 'provenance', 'capability', 'task', 'target', 'user', 'approval'
  ]);
  if (value.schemaVersion !== SCHEMA_VERSION) fail('POLICY_REQUEST_INVALID', `policy request schemaVersion must be ${SCHEMA_VERSION}.`, { field: 'schemaVersion' });
  exactKeys(value.action, ['id', 'kind', 'effect', 'generatedCode'], 'action', ['id', 'kind', 'effect', 'generatedCode']);
  if (typeof value.action.id !== 'string' || !ACTION_ID.test(value.action.id)) fail('POLICY_REQUEST_INVALID', 'action.id is invalid.', { field: 'action.id' });
  if (typeof value.action.generatedCode !== 'boolean') fail('POLICY_REQUEST_INVALID', 'action.generatedCode must be boolean.', { field: 'action.generatedCode' });
  exactKeys(value.task, ['id', 'risk', 'delegationDepth'], 'task', ['id', 'risk', 'delegationDepth']);
  if (typeof value.task.id !== 'string' || !TASK_ID.test(value.task.id)) fail('POLICY_REQUEST_INVALID', 'task.id is invalid.', { field: 'task.id' });
  if (!Number.isSafeInteger(value.task.delegationDepth) || value.task.delegationDepth < 0 || value.task.delegationDepth > 16) {
    fail('POLICY_REQUEST_INVALID', 'task.delegationDepth is invalid.', { field: 'task.delegationDepth' });
  }
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    action: deepFreeze({ id: value.action.id, kind: word(value.action.kind, 'action.kind'), effect: word(value.action.effect, 'action.effect'), generatedCode: value.action.generatedCode }),
    provenance: cloneProvenance(value.provenance),
    capability: cloneCapability(value.capability),
    task: deepFreeze({ id: value.task.id, risk: word(value.task.risk, 'task.risk'), delegationDepth: value.task.delegationDepth }),
    target: cloneTarget(value.target),
    user: cloneUser(value.user),
    approval: cloneApproval(value.approval)
  });
}

function sinkFor(request) {
  if (request.action.kind === 'secret-access') return 'secret';
  if (request.action.kind === 'generated-code-execution') return 'command';
  if (request.action.effect === 'external-write') return 'external-write';
  if (request.action.effect === 'external-read') return 'network';
  return 'memory';
}

function provenanceLabelsBlocked(request) {
  if (request.provenance === null) return [];
  return provenance.evaluateSink(request.provenance, sinkFor(request)).blockingLabels;
}

function requiresOwnerConfirmation(request) {
  return includes(CONSEQUENTIAL_EFFECT_VALUES, request.action.effect) || request.task.risk !== 'low';
}

function actionRequiresTargetKind(request) {
  const required = {
    'secret-access': 'secret',
    'finance-order': 'finance',
    'authenticated-browser': 'browser-session',
    'recursive-delegation': 'agent',
    'external-write': 'external',
    'local-write': 'local'
  };
  return required[request.action.kind] || null;
}

const PREDICATES = Object.freeze({
  'unknown-action-id': request => actionSpec(request.action.id) === null,
  'action-mapping-unknown': request => {
    const spec = actionSpec(request.action.id);
    return spec === null || request.action.kind === 'unmapped';
  },
  'action-effect-mismatch': request => {
    const spec = actionSpec(request.action.id);
    return spec !== null && spec.effect !== request.action.effect;
  },
  'unknown-action-kind': request => !includes(ACTION_KIND_VALUES, request.action.kind),
  'unknown-effect': request => !includes(EFFECT_VALUES, request.action.effect),
  'recursive-delegation': request => request.action.kind === 'recursive-delegation' || request.task.delegationDepth > 0,
  'generated-code': request => request.action.generatedCode || request.action.kind === 'generated-code-execution',
  'provenance-missing': request => request.provenance === null,
  'provenance-denied': request => provenanceLabelsBlocked(request).length > 0,
  'capability-missing': request => request.capability === null || request.capability.status === 'missing',
  'capability-expired': request => request.capability !== null && request.capability.status === 'expired',
  'capability-revoked': request => request.capability !== null && request.capability.status === 'revoked',
  'capability-denied': request => request.capability !== null && request.capability.status === 'denied',
  'capability-invalid': request => request.capability !== null && !includes(CAPABILITY_STATUS_VALUES, request.capability.status),
  'capability-binding-mismatch': request => request.capability !== null
    && (request.capability.taskId !== request.task.id || request.capability.tool !== request.action.id),
  'unknown-task-risk': request => !includes(RISK_VALUES, request.task.risk),
  'target-missing': request => request.target === null,
  'target-unknown': request => request.target !== null && !includes(TARGET_KIND_VALUES, request.target.kind),
  'target-unpinned': request => request.target !== null && request.target.pinned !== true,
  'target-kind-mismatch': request => request.target !== null && actionRequiresTargetKind(request) !== null
    && request.target.kind !== actionRequiresTargetKind(request),
  'user-missing': request => request.user === null,
  'user-unrecognized': request => request.user !== null && !includes(USER_VALUES, request.user.kind),
  'user-owner-required': request => !includes(SPECIAL_USER_ACTION_VALUES, request.action.kind) && requiresOwnerConfirmation(request)
    && (!request.user || request.user.kind !== 'owner-authenticated'),
  'approval-status-invalid': request => request.approval !== null && !includes(APPROVAL_STATUS_VALUES, request.approval.status),
  'user-performed-action': request => includes(SPECIAL_USER_ACTION_VALUES, request.action.kind),
  'approval-required': request => requiresOwnerConfirmation(request)
    && (!request.approval || !['valid', 'consumed'].includes(request.approval.status)),
  'confirmation-action': request => requiresOwnerConfirmation(request),
  'automatic-action': request => !requiresOwnerConfirmation(request) && ['local-read', 'external-read'].includes(request.action.effect),
  'default-deny': () => true
});

const POLICY_RULES = deepFreeze([
  { schemaVersion: 1, id: 'block-unknown-action-id', predicate: 'unknown-action-id', classification: 'blocked', reasonCode: 'ACTION_ID_UNKNOWN' },
  { schemaVersion: 1, id: 'block-action-mapping-unknown', predicate: 'action-mapping-unknown', classification: 'blocked', reasonCode: 'ACTION_MAPPING_UNKNOWN' },
  { schemaVersion: 1, id: 'block-action-effect-mismatch', predicate: 'action-effect-mismatch', classification: 'blocked', reasonCode: 'ACTION_EFFECT_MISMATCH' },
  { schemaVersion: 1, id: 'block-unknown-action-kind', predicate: 'unknown-action-kind', classification: 'blocked', reasonCode: 'ACTION_TYPE_UNKNOWN' },
  { schemaVersion: 1, id: 'block-unknown-effect', predicate: 'unknown-effect', classification: 'blocked', reasonCode: 'ACTION_EFFECT_UNKNOWN' },
  { schemaVersion: 1, id: 'block-recursive-delegation', predicate: 'recursive-delegation', classification: 'blocked', reasonCode: 'RECURSIVE_DELEGATION_BLOCKED' },
  { schemaVersion: 1, id: 'block-generated-code', predicate: 'generated-code', classification: 'blocked', reasonCode: 'GENERATED_CODE_BLOCKED' },
  { schemaVersion: 1, id: 'block-provenance-missing', predicate: 'provenance-missing', classification: 'blocked', reasonCode: 'PROVENANCE_REQUIRED' },
  { schemaVersion: 1, id: 'block-provenance-denied', predicate: 'provenance-denied', classification: 'blocked', reasonCode: 'PROVENANCE_DENIED' },
  { schemaVersion: 1, id: 'block-capability-missing', predicate: 'capability-missing', classification: 'blocked', reasonCode: 'CAPABILITY_MANIFEST_REQUIRED' },
  { schemaVersion: 1, id: 'block-capability-expired', predicate: 'capability-expired', classification: 'blocked', reasonCode: 'CAPABILITY_MANIFEST_EXPIRED' },
  { schemaVersion: 1, id: 'block-capability-revoked', predicate: 'capability-revoked', classification: 'blocked', reasonCode: 'CAPABILITY_MANIFEST_REVOKED' },
  { schemaVersion: 1, id: 'block-capability-denied', predicate: 'capability-denied', classification: 'blocked', reasonCode: 'CAPABILITY_MANIFEST_DENIED' },
  { schemaVersion: 1, id: 'block-capability-invalid', predicate: 'capability-invalid', classification: 'blocked', reasonCode: 'CAPABILITY_MANIFEST_INVALID' },
  { schemaVersion: 1, id: 'block-capability-binding', predicate: 'capability-binding-mismatch', classification: 'blocked', reasonCode: 'CAPABILITY_MANIFEST_BINDING_MISMATCH' },
  { schemaVersion: 1, id: 'block-unknown-task-risk', predicate: 'unknown-task-risk', classification: 'blocked', reasonCode: 'TASK_RISK_UNKNOWN' },
  { schemaVersion: 1, id: 'block-target-missing', predicate: 'target-missing', classification: 'blocked', reasonCode: 'TARGET_REQUIRED' },
  { schemaVersion: 1, id: 'block-target-unknown', predicate: 'target-unknown', classification: 'blocked', reasonCode: 'TARGET_KIND_UNKNOWN' },
  { schemaVersion: 1, id: 'block-target-unpinned', predicate: 'target-unpinned', classification: 'blocked', reasonCode: 'TARGET_NOT_PINNED' },
  { schemaVersion: 1, id: 'block-target-kind', predicate: 'target-kind-mismatch', classification: 'blocked', reasonCode: 'TARGET_KIND_MISMATCH' },
  { schemaVersion: 1, id: 'block-user-missing', predicate: 'user-missing', classification: 'blocked', reasonCode: 'USER_IDENTITY_REQUIRED' },
  { schemaVersion: 1, id: 'block-user-unrecognized', predicate: 'user-unrecognized', classification: 'blocked', reasonCode: 'USER_IDENTITY_UNRECOGNIZED' },
  { schemaVersion: 1, id: 'block-user-owner-required', predicate: 'user-owner-required', classification: 'blocked', reasonCode: 'OWNER_IDENTITY_REQUIRED' },
  { schemaVersion: 1, id: 'block-approval-status-invalid', predicate: 'approval-status-invalid', classification: 'blocked', reasonCode: 'APPROVAL_STATUS_INVALID' },
  { schemaVersion: 1, id: 'user-performed-sensitive-action', predicate: 'user-performed-action', classification: 'user-performed', reasonCode: 'USER_PERFORMED_REQUIRED' },
  { schemaVersion: 1, id: 'confirmation-approval-required', predicate: 'approval-required', classification: 'confirmation-required', reasonCode: 'APPROVAL_REQUIRED' },
  { schemaVersion: 1, id: 'confirmation-consequential-action', predicate: 'confirmation-action', classification: 'confirmation-required', reasonCode: 'CONFIRMATION_REQUIRED' },
  { schemaVersion: 1, id: 'automatic-low-risk-read', predicate: 'automatic-action', classification: 'automatic', reasonCode: 'AUTOMATIC_ALLOWED' },
  { schemaVersion: 1, id: 'block-default-deny', predicate: 'default-deny', classification: 'blocked', reasonCode: 'DEFAULT_DENY' }
]);

function validateRules(...argumentsValue) {
  if (argumentsValue.length !== 0) {
    fail('POLICY_RULE_RUNTIME_FORBIDDEN', 'Runtime callers cannot supply, subset, or replace P13 rules.');
  }
  const rules = POLICY_RULES;
  if (!Array.isArray(rules) || !rules.length) fail('POLICY_RULE_INVALID', 'Policy rules must be a non-empty array.');
  const ids = new Set();
  for (const rule of rules) {
    if (!plainObject(rule)) fail('POLICY_RULE_INVALID', 'Every policy rule must be a plain object.');
    const keys = Object.keys(rule);
    if (keys.length !== 5 || keys.some(key => !['schemaVersion', 'id', 'predicate', 'classification', 'reasonCode'].includes(key))
      || rule.schemaVersion !== SCHEMA_VERSION || typeof rule.id !== 'string' || !/^[a-z][a-z0-9-]{2,79}$/.test(rule.id)
      || typeof rule.predicate !== 'string' || !Object.hasOwn(PREDICATES, rule.predicate)
      || !['automatic', 'confirmation-required', 'user-performed', 'blocked'].includes(rule.classification)
      || typeof rule.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,79}$/.test(rule.reasonCode) || ids.has(rule.id)) {
      fail('POLICY_RULE_INVALID', 'Policy rules must match the closed P13 rule schema.');
    }
    ids.add(rule.id);
  }
  return Object.freeze({ ruleCount: rules.length });
}

validateRules();
function policyHash() {
  return canonicalHash(RULE_HASH_DOMAIN, {
    schemaVersion: SCHEMA_VERSION,
    policyVersion: POLICY_VERSION,
    rules: POLICY_RULES,
    actionCatalog: actionCatalog()
  });
}

function policyMetadata() {
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, policyVersion: POLICY_VERSION, ruleCount: POLICY_RULES.length, policyHash: policyHash() });
}

function matchedRules(request) {
  return POLICY_RULES.filter(rule => PREDICATES[rule.predicate](request));
}

function makeDecision(request, classification, allowed, rules, extraReasonCodes = []) {
  const reasonCodes = [...new Set(rules.map(rule => rule.reasonCode).concat(extraReasonCodes))];
  const core = {
    schemaVersion: SCHEMA_VERSION,
    policyVersion: POLICY_VERSION,
    policyHash: policyHash(),
    requestHash: canonicalHash(REQUEST_HASH_DOMAIN, request),
    actionId: request.action.id,
    classification,
    allowed,
    reasonCodes,
    matchedRuleIds: rules.map(rule => rule.id),
    blockingLabels: provenanceLabelsBlocked(request)
  };
  return deepFreeze({ ...core, decisionHash: canonicalHash(DECISION_HASH_DOMAIN, core) });
}

function evaluate(input) {
  const request = validateRequest(input);
  const rules = matchedRules(request);
  const blockers = rules.filter(rule => rule.classification === 'blocked' && rule.id !== 'block-default-deny');
  if (blockers.length) return makeDecision(request, 'blocked', false, blockers);
  const userPerformed = rules.filter(rule => rule.classification === 'user-performed');
  if (userPerformed.length) return makeDecision(request, 'user-performed', false, userPerformed);
  const confirmation = rules.filter(rule => rule.classification === 'confirmation-required');
  if (confirmation.length) {
    const approved = request.approval !== null && ['valid', 'consumed'].includes(request.approval.status);
    return makeDecision(request, 'confirmation-required', approved, confirmation);
  }
  const automatic = rules.filter(rule => rule.classification === 'automatic');
  if (automatic.length) return makeDecision(request, 'automatic', true, automatic);
  const fallback = POLICY_RULES.find(rule => rule.id === 'block-default-deny');
  return makeDecision(request, 'blocked', false, [fallback]);
}

function validateDecision(value) {
  exactKeys(value, ['schemaVersion', 'policyVersion', 'policyHash', 'requestHash', 'decisionHash', 'actionId', 'classification', 'allowed', 'reasonCodes', 'matchedRuleIds', 'blockingLabels'], 'policy decision', [
    'schemaVersion', 'policyVersion', 'policyHash', 'requestHash', 'decisionHash', 'actionId', 'classification', 'allowed', 'reasonCodes', 'matchedRuleIds', 'blockingLabels'
  ]);
  if (value.schemaVersion !== SCHEMA_VERSION || value.policyVersion !== POLICY_VERSION || value.policyHash !== policyHash()
    || typeof value.actionId !== 'string' || !ACTION_ID.test(value.actionId)
    || !['automatic', 'confirmation-required', 'user-performed', 'blocked'].includes(value.classification)
    || typeof value.allowed !== 'boolean' || !Array.isArray(value.reasonCodes) || !Array.isArray(value.matchedRuleIds)
    || !Array.isArray(value.blockingLabels) || !value.reasonCodes.length || !value.matchedRuleIds.length) {
    fail('POLICY_DECISION_INVALID', 'Policy decision has invalid closed fields.');
  }
  if (new Set(value.reasonCodes).size !== value.reasonCodes.length || value.reasonCodes.some(code => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{2,79}$/.test(code))) {
    fail('POLICY_DECISION_INVALID', 'Policy decision reason codes must be unique known machine codes.');
  }
  const rulesById = new Map(POLICY_RULES.map(rule => [rule.id, rule]));
  if (new Set(value.matchedRuleIds).size !== value.matchedRuleIds.length || value.matchedRuleIds.some(id => !rulesById.has(id))) {
    fail('POLICY_DECISION_INVALID', 'Policy decision matched rules must be unique shipped rules.');
  }
  const expectedReasons = [...new Set(value.matchedRuleIds.map(id => rulesById.get(id).reasonCode))];
  if (JSON.stringify(value.reasonCodes) !== JSON.stringify(expectedReasons)) {
    fail('POLICY_DECISION_INVALID', 'Policy decision reasons must exactly match its matched rules.');
  }
  if ((value.classification === 'automatic' && value.allowed !== true)
    || (['blocked', 'user-performed'].includes(value.classification) && value.allowed !== false)
    || value.blockingLabels.some(label => !provenance.LABELS.includes(label))
    || new Set(value.blockingLabels).size !== value.blockingLabels.length
    || JSON.stringify(value.blockingLabels) !== JSON.stringify([...value.blockingLabels].sort())) {
    fail('POLICY_DECISION_INVALID', 'Policy decision classification and safe labels are inconsistent.');
  }
  for (const digestField of ['requestHash', 'decisionHash']) hash(value[digestField], `policy decision.${digestField}`);
  const core = { ...value };
  delete core.decisionHash;
  if (canonicalHash(DECISION_HASH_DOMAIN, core) !== value.decisionHash) fail('POLICY_DECISION_INVALID', 'Policy decision hash does not match its closed record.');
  return deepFreeze({ ...value, reasonCodes: [...value.reasonCodes], matchedRuleIds: [...value.matchedRuleIds], blockingLabels: [...value.blockingLabels] });
}

function assertReplay(input, decision) {
  const expected = evaluate(input);
  const actual = validateDecision(decision);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    fail('POLICY_DECISION_REPLAY_MISMATCH', 'Policy decision does not match deterministic replay.', { expectedHash: expected.decisionHash, actualHash: actual.decisionHash });
  }
  return Object.freeze({ valid: true, decisionHash: expected.decisionHash });
}

function dispatchFacts(value) {
  exactKeys(value, ['provenance', 'capability', 'task', 'target', 'user', 'approval'], 'tool dispatch policy facts', ['provenance', 'capability', 'task', 'target', 'user', 'approval']);
  return value;
}

function evaluateToolDispatch(entry, facts) {
  if (!entry || typeof entry.name !== 'string' || !ACTION_ID.test(entry.name) || typeof entry.effect !== 'string' || !includes(EFFECT_VALUES, entry.effect)) {
    fail('POLICY_DISPATCH_INVALID', 'Tool dispatch metadata is invalid.');
  }
  const input = dispatchFacts(facts);
  const spec = actionSpec(entry.name);
  const semantics = spec || { policyKind: 'unmapped', generatedCode: false };
  return evaluate({
    schemaVersion: SCHEMA_VERSION,
    action: { id: entry.name, kind: semantics.policyKind, effect: entry.effect, generatedCode: semantics.generatedCode === true },
    provenance: input.provenance,
    capability: input.capability,
    task: input.task,
    target: input.target,
    user: input.user,
    approval: input.approval
  });
}

function consequentialTool(entry) {
  if (!entry || typeof entry.name !== 'string' || !ACTION_ID.test(entry.name)
    || typeof entry.effect !== 'string' || !includes(EFFECT_VALUES, entry.effect)) {
    fail('POLICY_DISPATCH_INVALID', 'Tool dispatch metadata is invalid.');
  }
  const spec = actionSpec(entry.name);
  return Boolean(spec && spec.p13Enforced === true && spec.effect === entry.effect);
}

module.exports = Object.freeze({
  DECISION_SCHEMA, POLICY_VERSION,
  PolicyEvaluationError, REQUEST_SCHEMA, RULE_SCHEMA, SCHEMA_VERSION,
  assertReplay, consequentialTool, evaluate, evaluateToolDispatch,
  policyMetadata, validateDecision, validateRequest, validateRules
});

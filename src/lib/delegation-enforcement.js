'use strict';

// Q21/P2 controller enforcement.  This module is deliberately not a provider,
// executor, task submitter, MCP tool, or acceptance path.  It only turns a
// controller-owned profile/task snapshot into a short-lived, value-free
// authorization receipt immediately before an already-qualified action.  The
// caller must inject the authoritative task/profile/fence readers; omission is
// a fail-closed error.

const crypto = require('node:crypto');
const contracts = require('./delegation-contracts');

const ACTORS = Object.freeze(['codex', 'claude', 'gemini', 'grok']);
const PROVIDER_ADAPTERS = Object.freeze([
  'local',
  'codex-subscription-cli',
  'claude-subscription-cli',
  'gemini-subscription-cli'
]);
const ADAPTER_FOR_ACTOR = Object.freeze({
  codex: 'codex-subscription-cli',
  claude: 'claude-subscription-cli',
  gemini: 'gemini-subscription-cli'
});
const ACTION_KINDS = Object.freeze(['tool', 'command']);
const EVIDENCE_OPERATIONS = Object.freeze(['write', 'read-public', 'list-public', 'verify']);
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const ACTOR = /^[a-z]+$/;
const ROOT_ID = /^[a-z][a-z0-9._-]{1,79}$/;
const SCOPE_ID = /^ctx_[A-Za-z0-9_-]{32}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const COMMAND_ID = /^[a-z][a-z0-9._-]{1,119}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:api[_-]?key|token|password|cookie|otp|mfa|secret)\b|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;

class DelegationEnforcementError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DelegationEnforcementError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new DelegationEnforcementError(code, message, details);
}

function plain(value, label) {
  let valid = false;
  try {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      valid = prototype === Object.prototype || prototype === null;
    }
  } catch {
    valid = false;
  }
  if (!valid) {
    fail('DELEGATION_ENFORCEMENT_INVALID', `${label} must be a closed object.`, { field: label });
  }
  return value;
}

function exact(value, keys, required, label) {
  const source = plain(value, label);
  let actual;
  try {
    actual = Reflect.ownKeys(source);
  } catch {
    fail('DELEGATION_ENFORCEMENT_INVALID', `${label} must be a closed object.`, { field: label });
  }
  if (actual.some(key => typeof key !== 'string' || !keys.includes(key))
      || required.some(key => !actual.includes(key))) {
    fail('DELEGATION_ENFORCEMENT_INVALID', `${label} has unsupported or missing fields.`, { field: label });
  }
  const snapshot = {};
  for (const key of actual) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      fail('DELEGATION_ENFORCEMENT_INVALID', `${label} must contain only data fields.`, { field: label });
    }
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('DELEGATION_ENFORCEMENT_INVALID', `${label} must contain only enumerable data fields.`, { field: label });
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function arrayItems(value, label, { min = 0, max = 128 } = {}) {
  let isArray = false;
  try { isArray = Array.isArray(value); } catch { isArray = false; }
  if (!isArray) fail('DELEGATION_ENFORCEMENT_INVALID', `${label} is invalid.`, { field: label });
  let actual;
  let lengthDescriptor;
  try {
    actual = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail('DELEGATION_ENFORCEMENT_INVALID', `${label} is invalid.`, { field: label });
  }
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < min || lengthDescriptor.value > max) {
    fail('DELEGATION_ENFORCEMENT_INVALID', `${label} is invalid.`, { field: label });
  }
  const length = lengthDescriptor.value;
  if (actual.length !== length + 1 || !actual.includes('length')
      || actual.some(key => typeof key !== 'string'
        || (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) {
    fail('DELEGATION_ENFORCEMENT_INVALID', `${label} has unsupported or missing fields.`, { field: label });
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!actual.includes(key)) fail('DELEGATION_ENFORCEMENT_INVALID', `${label} is sparse.`, { field: label });
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
      fail('DELEGATION_ENFORCEMENT_INVALID', `${label} must contain only data items.`, { field: label });
    }
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('DELEGATION_ENFORCEMENT_INVALID', `${label} must contain only enumerable data items.`, { field: label });
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function bounded(value, label, pattern, { min = 1, max = 240 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max ||
      !pattern.test(value) || SENSITIVE.test(value)) {
    fail('DELEGATION_ENFORCEMENT_INVALID', `${label} is invalid.`, { field: label });
  }
  return value;
}

function hash(value, label) { return bounded(value, label, SHA256, { min: 64, max: 64 }); }
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('DELEGATION_ENFORCEMENT_INVALID', `${label} is invalid.`, { field: label });
  }
  return value;
}

function sortedUnique(values, label, validator, { min = 0, max = 128 } = {}) {
  const items = arrayItems(values, label, { min, max });
  const normalized = items.map((item, index) => validator(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail('DELEGATION_ENFORCEMENT_INVALID', `${label} contains duplicates.`, { field: label });
  }
  return Object.freeze([...normalized].sort());
}

function snapshot(value, label = 'baseSnapshot') {
  const source = exact(value, ['rootId', 'commitSha1', 'treeSha256'], ['rootId', 'commitSha1', 'treeSha256'], label);
  if (!ROOT_ID.test(source.rootId) || SENSITIVE.test(source.rootId)) fail('DELEGATION_ENFORCEMENT_INVALID', `${label}.rootId is invalid.`);
  if (!/^[a-f0-9]{40}$/.test(source.commitSha1) || SENSITIVE.test(source.commitSha1)) fail('DELEGATION_ENFORCEMENT_INVALID', `${label}.commitSha1 is invalid.`);
  return Object.freeze({ rootId: source.rootId, commitSha1: source.commitSha1, treeSha256: hash(source.treeSha256, `${label}.treeSha256`) });
}

function toolSchema(value, index) {
  const source = exact(value, ['name', 'schemaHash'], ['name', 'schemaHash'], `toolSchemas[${index}]`);
  return Object.freeze({
    name: bounded(source.name, `toolSchemas[${index}].name`, TOOL_NAME, { min: 3, max: 200 }),
    schemaHash: hash(source.schemaHash, `toolSchemas[${index}].schemaHash`)
  });
}

function toolSchemas(values, label) {
  const normalized = arrayItems(values, label, { max: 128 }).map((item, index) => toolSchema(item, index));
  const names = normalized.map(item => item.name);
  if (new Set(names).size !== names.length) {
    fail('DELEGATION_ENFORCEMENT_INVALID', `${label} contains duplicate tool names.`, { field: label });
  }
  return Object.freeze([...normalized].sort((left, right) => left.name.localeCompare(right.name)));
}

function normalizeBinding(value, nowMs) {
  const source = exact(value, [
    'delegationId', 'taskId', 'actor', 'providerAdapter', 'rootId', 'rootHash',
    'baseSnapshot', 'capabilityProfileHash', 'toolSchemas', 'commandIds',
    'scopeId', 'expiresAtMs', 'profileExpiresAtMs', 'fence'
  ], [
    'delegationId', 'taskId', 'actor', 'providerAdapter', 'rootId', 'rootHash',
    'baseSnapshot', 'capabilityProfileHash', 'toolSchemas', 'commandIds',
    'scopeId', 'expiresAtMs', 'profileExpiresAtMs', 'fence'
  ], 'binding');
  const actor = bounded(source.actor, 'binding.actor', ACTOR, { min: 3, max: 16 });
  if (!ACTORS.includes(actor)) fail('DELEGATION_ENFORCEMENT_ACTOR_DENIED', 'binding.actor is not an approved worker actor.');
  if (source.providerAdapter !== ADAPTER_FOR_ACTOR[actor] || !PROVIDER_ADAPTERS.includes(source.providerAdapter)) {
    fail('DELEGATION_ENFORCEMENT_PROVIDER_DENIED', 'binding.providerAdapter does not match the actor subscription lane.');
  }
  // Expiry is checked by the enforcing operation against its injected clock.
  // Normalization itself must still be able to describe an expired binding so
  // callers receive the typed EXPIRED denial rather than a generic shape error.
  const expiresAtMs = integer(source.expiresAtMs, 'binding.expiresAtMs', 1);
  const profileExpiresAtMs = integer(source.profileExpiresAtMs, 'binding.profileExpiresAtMs', 1);
  if (expiresAtMs > profileExpiresAtMs) fail('DELEGATION_ENFORCEMENT_EXPIRED', 'binding expiry exceeds the profile expiry.');
  return Object.freeze({
    delegationId: bounded(source.delegationId, 'binding.delegationId', /^(?:dlg)_[A-Za-z0-9_-]{16,96}$/, { min: 20, max: 100 }),
    taskId: bounded(source.taskId, 'binding.taskId', TASK_ID, { min: 8, max: 200 }),
    actor,
    providerAdapter: source.providerAdapter,
    rootId: bounded(source.rootId, 'binding.rootId', ROOT_ID, { min: 2, max: 80 }),
    rootHash: hash(source.rootHash, 'binding.rootHash'),
    baseSnapshot: snapshot(source.baseSnapshot, 'binding.baseSnapshot'),
    capabilityProfileHash: hash(source.capabilityProfileHash, 'binding.capabilityProfileHash'),
    toolSchemas: toolSchemas(source.toolSchemas, 'binding.toolSchemas'),
    commandIds: sortedUnique(source.commandIds, 'binding.commandIds', (item, label) => bounded(item, label, COMMAND_ID, { min: 2, max: 120 }), { max: 128 }),
    scopeId: bounded(source.scopeId, 'binding.scopeId', SCOPE_ID, { min: 36, max: 36 }),
    expiresAtMs,
    profileExpiresAtMs,
    fence: integer(source.fence, 'binding.fence', 1)
  });
}

function normalizeAction(value) {
  const source = exact(value, ['kind', 'toolName', 'toolSchemaHash', 'commandId'], ['kind'], 'action');
  if (!ACTION_KINDS.includes(source.kind)) fail('DELEGATION_ENFORCEMENT_ACTION_DENIED', 'action.kind is not supported.');
  const toolName = source.toolName === undefined || source.toolName === null ? null : bounded(source.toolName, 'action.toolName', TOOL_NAME, { min: 3, max: 200 });
  const toolSchemaHash = source.toolSchemaHash === undefined || source.toolSchemaHash === null ? null : hash(source.toolSchemaHash, 'action.toolSchemaHash');
  const commandId = source.commandId === undefined || source.commandId === null ? null : bounded(source.commandId, 'action.commandId', COMMAND_ID, { min: 2, max: 120 });
  if (source.kind === 'tool' && (!toolName || !toolSchemaHash || commandId !== null)) fail('DELEGATION_ENFORCEMENT_ACTION_DENIED', 'A tool action must name exactly one schema-bound tool.');
  if (source.kind === 'command' && (!commandId || toolName !== null || toolSchemaHash !== null)) fail('DELEGATION_ENFORCEMENT_ACTION_DENIED', 'A command action must name exactly one allowlisted command.');
  return Object.freeze({ kind: source.kind, toolName, toolSchemaHash, commandId });
}

function sameSnapshot(left, right) {
  return Boolean(left && right) && left.rootId === right.rootId && left.commitSha1 === right.commitSha1 && left.treeSha256 === right.treeSha256;
}

function profileRecord(value) {
  const source = exact(value, [
    'taskId', 'delegationId', 'actor', 'providerAdapter', 'rootId', 'rootHash',
    'baseSnapshot', 'profileHash', 'toolSchemas', 'commandIds', 'scopeId',
    'expiresAtMs', 'fence'
  ], [
    'taskId', 'delegationId', 'actor', 'providerAdapter', 'rootId', 'rootHash',
    'baseSnapshot', 'profileHash', 'toolSchemas', 'commandIds', 'scopeId',
    'expiresAtMs', 'fence'
  ], 'profile');
  return Object.freeze({
    taskId: bounded(source.taskId, 'profile.taskId', TASK_ID, { min: 8, max: 200 }),
    delegationId: bounded(source.delegationId, 'profile.delegationId', /^(?:dlg)_[A-Za-z0-9_-]{16,96}$/, { min: 20, max: 100 }),
    actor: bounded(source.actor, 'profile.actor', ACTOR, { min: 3, max: 16 }),
    providerAdapter: bounded(source.providerAdapter, 'profile.providerAdapter', /^[a-z-]+$/, { min: 3, max: 40 }),
    rootId: bounded(source.rootId, 'profile.rootId', ROOT_ID, { min: 2, max: 80 }),
    rootHash: hash(source.rootHash, 'profile.rootHash'),
    baseSnapshot: snapshot(source.baseSnapshot, 'profile.baseSnapshot'),
    profileHash: hash(source.profileHash, 'profile.profileHash'),
    toolSchemas: toolSchemas(source.toolSchemas, 'profile.toolSchemas'),
    commandIds: sortedUnique(source.commandIds, 'profile.commandIds', (item, label) => bounded(item, label, COMMAND_ID, { min: 2, max: 120 }), { max: 128 }),
    scopeId: bounded(source.scopeId, 'profile.scopeId', SCOPE_ID, { min: 36, max: 36 }),
    expiresAtMs: integer(source.expiresAtMs, 'profile.expiresAtMs', 1),
    fence: integer(source.fence, 'profile.fence', 1)
  });
}

function taskRecord(value) {
  const source = exact(value, [
    'taskId', 'status', 'delegationId', 'capabilityProfileHash', 'baseSnapshot'
  ], [
    'taskId', 'status', 'delegationId', 'capabilityProfileHash', 'baseSnapshot'
  ], 'task snapshot');
  return Object.freeze({
    taskId: bounded(source.taskId, 'task snapshot.taskId', TASK_ID, { min: 8, max: 200 }),
    status: bounded(source.status, 'task snapshot.status', /^[a-z][a-z_-]{1,39}$/, { min: 2, max: 40 }),
    delegationId: bounded(source.delegationId, 'task snapshot.delegationId', /^(?:dlg)_[A-Za-z0-9_-]{16,96}$/, { min: 20, max: 100 }),
    capabilityProfileHash: hash(source.capabilityProfileHash, 'task snapshot.capabilityProfileHash'),
    baseSnapshot: snapshot(source.baseSnapshot, 'task snapshot.baseSnapshot')
  });
}

function controllerDependencies(value) {
  let source;
  try {
    source = exact(value, ['now', 'readTask', 'readProfile', 'readFence'],
      ['readTask', 'readProfile', 'readFence'], 'controller dependencies');
  } catch {
    fail('DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE', 'The controller must provide closed task, profile, and fence readers.');
  }
  if (typeof source.readTask !== 'function' || typeof source.readProfile !== 'function'
      || typeof source.readFence !== 'function') {
    fail('DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE', 'The controller must provide task, profile, and fence readers.');
  }
  return source;
}

function assertEqual(actual, expected, code, message) {
  if (actual !== expected) fail(code, message);
}

function readController(dependencies, reader, ...args) {
  try {
    return dependencies[reader](...args);
  } catch {
    // Controller-reader failures are untrusted operational details.  Never
    // relay their message (which could contain provider or task content), and
    // never turn a partial reader failure into an authorization.
    fail('DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE', 'The controller could not read required delegation state.');
  }
}

function enforceDelegation(input, dependencies = {}) {
  const source = exact(input, ['task', 'binding', 'action'], ['task', 'binding', 'action'], 'delegation request');
  const controller = controllerDependencies(dependencies);
  const now = controller.now === undefined ? Date.now() : controller.now;
  integer(now, 'controller clock');
  const task = contracts.validateDelegatedTask(source.task);
  const binding = normalizeBinding(source.binding, now);
  const action = normalizeAction(source.action);
  assertEqual(binding.delegationId, task.delegationId, 'DELEGATION_ENFORCEMENT_TASK_MISMATCH', 'The binding is for a different delegation.');
  assertEqual(binding.rootId, task.baseSnapshot.rootId, 'DELEGATION_ENFORCEMENT_ROOT_MISMATCH', 'The binding root is not the task root.');
  assertEqual(binding.rootHash, task.baseSnapshot.treeSha256, 'DELEGATION_ENFORCEMENT_ROOT_MISMATCH', 'The binding root hash is not the task snapshot tree hash.');
  if (!sameSnapshot(binding.baseSnapshot, task.baseSnapshot)) fail('DELEGATION_ENFORCEMENT_SNAPSHOT_MISMATCH', 'The binding base snapshot is stale or mismatched.');
  assertEqual(binding.capabilityProfileHash, task.capabilityProfileHash, 'DELEGATION_ENFORCEMENT_PROFILE_MISMATCH', 'The binding capability profile is not the task profile.');
  if (binding.expiresAtMs <= now || binding.profileExpiresAtMs <= now) fail('DELEGATION_ENFORCEMENT_EXPIRED', 'The delegation or profile has expired.');

  const currentTask = taskRecord(readController(controller, 'readTask', binding.taskId));
  if (!currentTask || currentTask.taskId !== binding.taskId || currentTask.status !== 'running' ||
      currentTask.delegationId !== task.delegationId || currentTask.capabilityProfileHash !== task.capabilityProfileHash ||
      !sameSnapshot(currentTask.baseSnapshot, task.baseSnapshot)) {
    fail('DELEGATION_ENFORCEMENT_TASK_STALE', 'The durable task is missing, not running, or no longer matches the delegation.');
  }
  const currentFence = readController(controller, 'readFence', binding.taskId);
  if (!Number.isSafeInteger(currentFence)) fail('DELEGATION_ENFORCEMENT_FENCE_UNAVAILABLE', 'The controller could not read the current task fence.');
  if (currentFence !== binding.fence) fail('DELEGATION_ENFORCEMENT_FENCE_STALE', 'The delegation fence is stale.');

  const profile = profileRecord(readController(controller, 'readProfile', {
    taskId: binding.taskId,
    delegationId: binding.delegationId,
    profileHash: binding.capabilityProfileHash
  }));
  for (const field of ['taskId', 'delegationId', 'actor', 'providerAdapter', 'rootId', 'rootHash', 'scopeId', 'fence']) {
    if (profile[field] !== binding[field]) fail('DELEGATION_ENFORCEMENT_PROFILE_MISMATCH', `The controller profile does not match binding.${field}.`);
  }
  if (profile.profileHash !== binding.capabilityProfileHash) {
    fail('DELEGATION_ENFORCEMENT_PROFILE_MISMATCH', 'The controller profile hash does not match the bound capability profile.');
  }
  if (!sameSnapshot(profile.baseSnapshot, binding.baseSnapshot) || profile.expiresAtMs < binding.expiresAtMs) {
    fail('DELEGATION_ENFORCEMENT_PROFILE_MISMATCH', 'The controller profile snapshot or expiry does not match the binding.');
  }
  if (JSON.stringify(profile.toolSchemas) !== JSON.stringify(binding.toolSchemas) || JSON.stringify(profile.commandIds) !== JSON.stringify(binding.commandIds)) {
    fail('DELEGATION_ENFORCEMENT_PROFILE_MISMATCH', 'The controller profile tool schemas or command IDs do not match the binding.');
  }
  if (action.kind === 'tool') {
    const schema = binding.toolSchemas.find(item => item.name === action.toolName);
    if (!schema || schema.schemaHash !== action.toolSchemaHash) fail('DELEGATION_ENFORCEMENT_TOOL_SCHEMA_DENIED', 'The action tool schema is not in the bound profile.');
  } else if (!binding.commandIds.includes(action.commandId)) {
    fail('DELEGATION_ENFORCEMENT_COMMAND_DENIED', 'The action command is not in the bound profile.');
  }
  const receipt = {
    schemaVersion: 1,
    status: 'authorized',
    delegationId: binding.delegationId,
    taskId: binding.taskId,
    actor: binding.actor,
    providerAdapter: binding.providerAdapter,
    rootId: binding.rootId,
    rootHash: binding.rootHash,
    baseSnapshot: binding.baseSnapshot,
    capabilityProfileHash: binding.capabilityProfileHash,
    scopeId: binding.scopeId,
    expiresAtMs: binding.expiresAtMs,
    fence: binding.fence,
    action,
    contentTrust: 'verified-local-state',
    grantsAuthority: false
  };
  return Object.freeze({ ...receipt, receiptHash: contracts.digest('DelegationAuthorization', receipt) });
}

function evidenceAccess(binding) {
  const normalized = normalizeBinding(binding, 0);
  return Object.freeze({
    delegationId: normalized.delegationId,
    taskId: normalized.taskId,
    scopeId: normalized.scopeId,
    capabilityProfileHash: normalized.capabilityProfileHash,
    fence: normalized.fence,
    expiresAtMs: normalized.expiresAtMs,
    profileExpiresAtMs: normalized.profileExpiresAtMs
  });
}

function createEvidenceAuthorizer(binding, dependencies = {}) {
  const grant = evidenceAccess(binding);
  let dependencySnapshot;
  try {
    dependencySnapshot = exact(dependencies, ['now', 'readFence'], ['readFence'], 'evidence dependencies');
  } catch {
    fail('DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE', 'The controller must provide closed evidence fence dependencies.');
  }
  const readFence = dependencySnapshot.readFence;
  const now = dependencySnapshot.now === undefined ? Date.now : dependencySnapshot.now;
  if (typeof now !== 'function' || typeof readFence !== 'function') {
    fail('DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE', 'The controller must provide evidence clock and fence readers.');
  }
  return Object.freeze(request => {
    const source = exact(request, ['operation', 'access', 'binding'], ['operation', 'access', 'binding'], 'evidence authorization request');
    const access = exact(source.access, [
      'delegationId', 'taskId', 'scopeId', 'capabilityProfileHash', 'fence',
      'expiresAtMs', 'profileExpiresAtMs'
    ], [
      'delegationId', 'taskId', 'scopeId', 'capabilityProfileHash', 'fence',
      'expiresAtMs', 'profileExpiresAtMs'
    ], 'evidence access');
    const evidenceBinding = exact(source.binding, ['taskId', 'scopeId'], ['taskId', 'scopeId'], 'evidence binding');
    const operation = source.operation;
    if (!EVIDENCE_OPERATIONS.includes(operation)) return false;
    if (access.delegationId !== grant.delegationId || access.taskId !== grant.taskId || access.scopeId !== grant.scopeId ||
        access.capabilityProfileHash !== grant.capabilityProfileHash || access.fence !== grant.fence ||
        access.expiresAtMs !== grant.expiresAtMs || access.profileExpiresAtMs !== grant.profileExpiresAtMs ||
        evidenceBinding.taskId !== grant.taskId || evidenceBinding.scopeId !== grant.scopeId) return false;
    try {
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs)) {
        fail('DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE', 'The controller could not read a valid evidence clock.');
      }
      if (nowMs >= grant.expiresAtMs || nowMs >= grant.profileExpiresAtMs) return false;
      const currentFence = readFence(grant.taskId);
      if (!Number.isSafeInteger(currentFence)) {
        fail('DELEGATION_ENFORCEMENT_FENCE_UNAVAILABLE', 'The controller could not read the current evidence fence.');
      }
      return currentFence === grant.fence;
    } catch {
      // Refuse rather than reporting a definite denial when the controller
      // clock or fence could not be measured.  Do not leak the reader error.
      fail('DELEGATION_ENFORCEMENT_CONTROLLER_UNAVAILABLE', 'The controller could not read required evidence authorization state.');
    }
  });
}

module.exports = Object.freeze({
  ACTORS,
  ADAPTER_FOR_ACTOR,
  ACTION_KINDS,
  EVIDENCE_OPERATIONS,
  PROVIDER_ADAPTERS,
  DelegationEnforcementError,
  createEvidenceAuthorizer,
  enforceDelegation,
  evidenceAccess,
  normalizeAction,
  normalizeBinding,
  profileRecord
});

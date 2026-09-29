'use strict';

/**
 * Q21/AGW-07 Delegation Task Projection
 *
 * This module projects a validated DelegatedTask onto the canonical task.js service.
 * It is a narrow first slice containing only a submit and a read/decode function.
 * It strictly avoids importing state-store, registry, provider, browser, or vault.
 */

const { validateDelegatedTask } = require('./delegation-contracts');

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA1 = /^[a-f0-9]{40}$/;
const ID_PATTERN = /^[a-z][a-z0-9._-]{2,119}$/;
const OPAQUE_ID = /^(?:dlg|wrk|evb|esc)_[A-Za-z0-9_-]{16,96}$/;
const ROLES = ['read_only_review', 'deterministic_verification', 'disposable_edit'];
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:api[_-]?key|token|password|cookie|otp|mfa|secret)\b|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

class DelegationTaskProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DelegationTaskProjectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DelegationTaskProjectionError(code, message);
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
  if (!valid) fail('DELEGATION_TASK_PROJECTION_INVALID', `${label} must be a plain object.`);
  return value;
}

function ownData(value, key, label, { required = true } = {}) {
  const source = plain(value, label);
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(source, key); } catch {
    fail('DELEGATION_TASK_PROJECTION_INVALID', `${label}.${key} must be a data field.`);
  }
  if (!descriptor) {
    if (!required) return Object.freeze({ present: false, value: undefined });
    fail('DELEGATION_TASK_PROJECTION_INVALID', `${label}.${key} is missing.`);
  }
  if (descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', `${label}.${key} must be an enumerable data field.`);
  }
  return Object.freeze({ present: true, value: descriptor.value });
}

function exact(value, fields, label) {
  const source = plain(value, label);
  let keys;
  try { keys = Reflect.ownKeys(source); } catch {
    fail('DELEGATION_TASK_PROJECTION_INVALID', `${label} must be a closed plain object.`);
  }
  if (keys.length !== fields.length
      || keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', `${label} contains extra or missing fields.`);
  }
  const snapshot = {};
  for (const key of keys) snapshot[key] = ownData(source, key, label).value;
  return Object.freeze(snapshot);
}

function safeIdentifier(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value) || SENSITIVE.test(value)) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', `${label} is invalid.`);
  }
  return value;
}

function sameSnapshot(left, right) {
  return left.rootId === right.rootId && left.commitSha1 === right.commitSha1 && left.treeSha256 === right.treeSha256;
}

/**
 * Projects a validated existing DelegatedTask onto the existing canonical tasks.js owner.
 *
 * @param {object} taskService Injected task provider service (with submit/get).
 * @param {object} delegatedTask The raw DelegatedTask to project.
 * @param {object} options Submit options containing idempotencyKey, queue, and type.
 * @param {object} [dependencies] Optional state store or other service dependencies.
 * @returns {Promise<object>} The submitted canonical task metadata.
 */
async function submitDelegatedTask(taskService, delegatedTask, options = {}, dependencies = {}) {
  let submit;
  try { submit = ownData(taskService, 'submit', 'taskService').value; } catch {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'taskService.submit is required.');
  }
  if (typeof submit !== 'function') fail('DELEGATION_TASK_PROJECTION_INVALID', 'taskService.submit is required.');

  // Validate the DelegatedTask using the actual contracts module
  const validated = validateDelegatedTask(delegatedTask);

  // Validate caller-supplied options
  const optionSnapshot = exact(options, ['idempotencyKey', 'queue', 'type'], 'submit options');
  const { idempotencyKey, queue, type } = optionSnapshot;
  safeIdentifier(idempotencyKey, IDEMPOTENCY_KEY_PATTERN, 'idempotencyKey');
  safeIdentifier(queue, IDENTIFIER_PATTERN, 'queue');
  safeIdentifier(type, IDENTIFIER_PATTERN, 'type');

  // Build the compact JSON context containing only references & hashes
  const context = {
    projectionSchemaVersion: 1,
    kind: 'delegated-task',
    delegationId: validated.delegationId,
    contractHash: validated.contractHash,
    role: validated.role,
    capabilityProfileHash: validated.capabilityProfileHash,
    baseSnapshot: {
      rootId: validated.baseSnapshot.rootId,
      commitSha1: validated.baseSnapshot.commitSha1,
      treeSha256: validated.baseSnapshot.treeSha256
    }
  };

  const payload = {
    title: 'Delegated Task Projection',
    objective: 'Execute projected task delegation securely.',
    context: JSON.stringify(context)
  };

  return submit.call(taskService, {
    queue,
    type,
    idempotencyKey,
    payload,
    expiryPolicy: 'uncertain',
    maxAttempts: 1
  }, dependencies);
}

/**
 * Decodes the compact projection context from a canonical task record.
 * Accepts only the exact compact schema, returning a frozen value-free untrusted projection.
 * Rejects malformed, secret-shaped, extra, stale, or mismatched data.
 *
 * @param {object|string} taskOrContext The task record retrieved from taskService, its payload, or raw context string.
 * @returns {object} The frozen projection object.
 */
function decodeDelegatedTaskProjection(taskOrContext, expectedDelegatedTask) {
  let contextString;

  if (typeof taskOrContext === 'string') {
    contextString = taskOrContext;
  } else if (taskOrContext && typeof taskOrContext === 'object') {
    const payloadField = ownData(taskOrContext, 'payload', 'projection wrapper', { required: false });
    const contextField = ownData(taskOrContext, 'context', 'projection wrapper', { required: false });
    if (payloadField.present) {
      contextString = ownData(payloadField.value, 'context', 'task payload').value;
    } else if (contextField.present) {
      contextString = contextField.value;
    } else {
      fail('DELEGATION_TASK_PROJECTION_INVALID', 'task payload context is missing or invalid.');
    }
  } else {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'projection input is invalid.');
  }
  if (typeof contextString !== 'string') {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'task payload context is missing or invalid.');
  }

  // Reject secret-shaped context string
  if (SENSITIVE.test(contextString)) {
    fail('DELEGATION_TASK_PROJECTION_DENIED', 'task context contains sensitive or secret-shaped data.');
  }

  let context;
  try {
    context = JSON.parse(contextString);
  } catch {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'task context is not valid JSON.');
  }

  const expectedKeys = ['projectionSchemaVersion', 'kind', 'delegationId', 'contractHash', 'role', 'capabilityProfileHash', 'baseSnapshot'];
  context = exact(context, expectedKeys, 'task context');

  // Validate individual fields
  if (context.projectionSchemaVersion !== 1) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'projection schema version is unsupported.');
  }

  if (context.kind !== 'delegated-task') {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'projection kind is unsupported.');
  }

  if (typeof context.delegationId !== 'string' || !OPAQUE_ID.test(context.delegationId) || !context.delegationId.startsWith('dlg_')) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'delegationId is invalid.');
  }

  if (typeof context.contractHash !== 'string' || !SHA256.test(context.contractHash)) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'contractHash is invalid.');
  }

  if (!ROLES.includes(context.role)) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'role is invalid.');
  }

  if (typeof context.capabilityProfileHash !== 'string' || !SHA256.test(context.capabilityProfileHash)) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'capabilityProfileHash is invalid.');
  }

  // Validate baseSnapshot sub-object
  const expectedBsKeys = ['rootId', 'commitSha1', 'treeSha256'];
  const bs = exact(context.baseSnapshot, expectedBsKeys, 'baseSnapshot');

  if (typeof bs.rootId !== 'string' || !ID_PATTERN.test(bs.rootId)) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'baseSnapshot.rootId is invalid.');
  }

  if (typeof bs.commitSha1 !== 'string' || !GIT_SHA1.test(bs.commitSha1)) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'baseSnapshot.commitSha1 is invalid.');
  }

  if (typeof bs.treeSha256 !== 'string' || !SHA256.test(bs.treeSha256)) {
    fail('DELEGATION_TASK_PROJECTION_INVALID', 'baseSnapshot.treeSha256 is invalid.');
  }

  // A context is untrusted data. It becomes a usable reference only when the
  // caller supplies the exact current DelegatedTask it expects. This prevents a
  // valid but stale/mismatched durable-task payload from being reinterpreted as
  // the current delegation.
  if (expectedDelegatedTask !== undefined) {
    const expected = validateDelegatedTask(expectedDelegatedTask);
    if (context.delegationId !== expected.delegationId ||
        context.contractHash !== expected.contractHash ||
        context.role !== expected.role ||
        context.capabilityProfileHash !== expected.capabilityProfileHash ||
        !sameSnapshot(bs, expected.baseSnapshot)) {
      fail('DELEGATION_TASK_PROJECTION_STALE_OR_MISMATCHED', 'projection does not match the expected DelegatedTask.');
    }
  }

  // Return frozen, value-free, untrusted projection
  return Object.freeze({
    projectionSchemaVersion: context.projectionSchemaVersion,
    kind: context.kind,
    delegationId: context.delegationId,
    contractHash: context.contractHash,
    role: context.role,
    capabilityProfileHash: context.capabilityProfileHash,
    baseSnapshot: Object.freeze({
      rootId: bs.rootId,
      commitSha1: bs.commitSha1,
      treeSha256: bs.treeSha256
    }),
    contentTrust: 'untrusted',
    grantsAuthority: false
  });
}

module.exports = Object.freeze({
  DelegationTaskProjectionError,
  decodeDelegatedTaskProjection,
  submitDelegatedTask
});

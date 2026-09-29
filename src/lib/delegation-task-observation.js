'use strict';

// Q21/AGW-07 read-side only. This wrapper projects an existing canonical task
// into redacted metadata. It never leases, changes, completes, or accepts work.
const { DelegationTaskProjectionError, decodeDelegatedTaskProjection } = require('./delegation-task-projection');

const SAFE_ID = /^[a-z][a-z0-9._-]{2,119}$/;
const STATUS = Object.freeze(['queued', 'leased', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled', 'uncertain']);
const EXPIRY = Object.freeze(['uncertain', 'retry']);
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:api[_-]?key|token|password|cookie|otp|mfa|secret)\b|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;

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
  if (!valid) fail('DELEGATION_TASK_OBSERVATION_INVALID', `${label} must be a plain object.`);
  return value;
}

function ownData(value, key, label, { required = true } = {}) {
  const source = plain(value, label);
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(source, key); } catch {
    fail('DELEGATION_TASK_OBSERVATION_INVALID', `${label}.${key} must be a data field.`);
  }
  if (!descriptor) {
    if (!required) return undefined;
    fail('DELEGATION_TASK_OBSERVATION_INVALID', `${label}.${key} is missing.`);
  }
  if (descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail('DELEGATION_TASK_OBSERVATION_INVALID', `${label}.${key} must be an enumerable data field.`);
  }
  return descriptor.value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || SENSITIVE.test(value)) {
    fail('DELEGATION_TASK_OBSERVATION_INVALID', `${label} is invalid.`);
  }
  return value;
}

function optionalTime(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('DELEGATION_TASK_OBSERVATION_INVALID', `${label} is invalid.`);
  }
  return value;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const field of Object.values(value)) freeze(field);
    Object.freeze(value);
  }
  return value;
}

function metadata(task) {
  const source = plain(task, 'canonical task metadata');
  const field = (key, options) => ownData(source, key, 'canonical task metadata', options);
  const status = field('status');
  const attempt = field('attempt');
  const maxAttempts = field('maxAttempts');
  const expiryPolicy = field('expiryPolicy');
  const cancellationRequested = field('cancellationRequested');
  if (!STATUS.includes(status)) fail('DELEGATION_TASK_OBSERVATION_INVALID', 'task status is invalid.');
  if (!Number.isSafeInteger(attempt) || attempt < 0 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    fail('DELEGATION_TASK_OBSERVATION_INVALID', 'task attempt metadata is invalid.');
  }
  if (!EXPIRY.includes(expiryPolicy)) fail('DELEGATION_TASK_OBSERVATION_INVALID', 'task expiry policy is invalid.');
  if (typeof cancellationRequested !== 'boolean') fail('DELEGATION_TASK_OBSERVATION_INVALID', 'task cancellation state is invalid.');
  return Object.freeze({
    taskId: safeId(field('taskId'), 'taskId'),
    queue: safeId(field('queue'), 'queue'),
    type: safeId(field('type'), 'type'),
    status,
    attempt,
    maxAttempts,
    expiryPolicy,
    createdAtMs: optionalTime(field('createdAtMs', { required: false }), 'createdAtMs'),
    updatedAtMs: optionalTime(field('updatedAtMs', { required: false }), 'updatedAtMs'),
    availableAtMs: optionalTime(field('availableAtMs', { required: false }), 'availableAtMs'),
    expiresAtMs: optionalTime(field('expiresAtMs', { required: false }), 'expiresAtMs'),
    retryAtMs: optionalTime(field('retryAtMs', { required: false }), 'retryAtMs'),
    startedAtMs: optionalTime(field('startedAtMs', { required: false }), 'startedAtMs'),
    leaseExpiresAtMs: optionalTime(field('leaseExpiresAtMs', { required: false }), 'leaseExpiresAtMs'),
    completedAtMs: optionalTime(field('completedAtMs', { required: false }), 'completedAtMs'),
    cancellationRequested
  });
}

async function observeDelegatedTask(taskService, taskId, expectedDelegatedTask, dependencies = {}) {
  let get;
  try { get = ownData(taskService, 'get', 'taskService'); } catch {
    fail('DELEGATION_TASK_OBSERVATION_INVALID', 'taskService.get is required.');
  }
  if (typeof get !== 'function') fail('DELEGATION_TASK_OBSERVATION_INVALID', 'taskService.get is required.');
  const requestedTaskId = safeId(taskId, 'taskId');
  // This is the one and only task-service call. The payload is needed solely
  // for the existing opaque-reference decoder; it is never returned.
  const task = await get.call(taskService, { taskId: requestedTaskId, includePayload: true, includeCheckpoint: false }, dependencies);
  if (!task) fail('DELEGATION_TASK_OBSERVATION_NOT_FOUND', 'canonical task was not found.');
  const projection = decodeDelegatedTaskProjection(task, expectedDelegatedTask);
  const observed = metadata(task);
  if (observed.taskId !== requestedTaskId) {
    fail('DELEGATION_TASK_OBSERVATION_INVALID', 'canonical task identity does not match the request.');
  }
  return freeze({ ...observed, projection, contentTrust: 'untrusted', grantsAuthority: false });
}

module.exports = Object.freeze({ observeDelegatedTask });

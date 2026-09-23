'use strict';

// Q21/AGW-07. A read-only bridge over the canonical task and task_attempts
// owners. Fence is a claim generation; executionAttempt is a retry-budget
// generation. They are intentionally not derivable from one another.
const SAFE_ID = /^[a-z][a-z0-9._-]{2,119}$/;
const ATTEMPT_STATUS = Object.freeze(['leased', 'running', 'succeeded', 'retryable_failed', 'failed', 'cancelled', 'lease_expired', 'uncertain']);
const TASK_STATUS = Object.freeze(['queued', 'leased', 'running', 'retry_wait', 'succeeded', 'failed', 'uncertain', 'cancelled']);
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:api[_-]?key|token|password|cookie|otp|mfa|secret)\b|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;

class DelegationTaskAttemptProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DelegationTaskAttemptProjectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DelegationTaskAttemptProjectionError(code, message);
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || SENSITIVE.test(value)) {
    fail('DELEGATION_TASK_ATTEMPT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function integer(value, label, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('DELEGATION_TASK_ATTEMPT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function optionalTime(value, label) {
  if (value === null) return null;
  return integer(value, label, 0);
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
  if (!valid) fail('DELEGATION_TASK_ATTEMPT_INVALID', `${label} is invalid.`);
  return value;
}

function ownData(value, key, label, { required = true } = {}) {
  const source = plain(value, label);
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(source, key); } catch {
    fail('DELEGATION_TASK_ATTEMPT_INVALID', `${label}.${key} must be a data field.`);
  }
  if (!descriptor) {
    if (!required) return Object.freeze({ present: false, value: undefined });
    fail('DELEGATION_TASK_ATTEMPT_INVALID', `${label}.${key} is missing.`);
  }
  if (descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail('DELEGATION_TASK_ATTEMPT_INVALID', `${label}.${key} must be an enumerable data field.`);
  }
  return Object.freeze({ present: true, value: descriptor.value });
}

function exact(value, fields, label) {
  const source = plain(value, label);
  let keys;
  try { keys = Reflect.ownKeys(source); } catch {
    fail('DELEGATION_TASK_ATTEMPT_INVALID', `${label} is invalid.`);
  }
  if (keys.length !== fields.length
      || keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
    fail('DELEGATION_TASK_ATTEMPT_INVALID', `${label} has unsupported or missing fields.`);
  }
  const snapshot = {};
  for (const key of keys) snapshot[key] = ownData(source, key, label).value;
  return Object.freeze(snapshot);
}

function freeze(value) {
  return Object.freeze(value);
}

function absent(taskId, fence) {
  return freeze({
    presence: 'absent',
    taskId,
    fence,
    executionAttempt: null,
    attemptStatus: 'unclaimed',
    taskStatus: null,
    maxAttempts: null,
    claimedAtMs: null,
    startedAtMs: null,
    endedAtMs: null,
    retryBudgetConsumed: false,
    contentTrust: 'untrusted',
    grantsAuthority: false
  });
}

function projectDelegationTaskAttempt(readers, request) {
  let readerSnapshot;
  try { readerSnapshot = exact(readers, ['getTask', 'getTaskAttemptMetadata'], 'canonical readers'); } catch {
    fail('DELEGATION_TASK_ATTEMPT_INVALID', 'canonical read APIs are required.');
  }
  const getTask = readerSnapshot.getTask;
  const getTaskAttemptMetadata = readerSnapshot.getTaskAttemptMetadata;
  if (typeof getTask !== 'function' || typeof getTaskAttemptMetadata !== 'function') {
    fail('DELEGATION_TASK_ATTEMPT_INVALID', 'canonical read APIs are required.');
  }
  const source = exact(request, ['taskId', 'fence'], 'request');
  const taskId = safeId(source.taskId, 'taskId');
  const fence = integer(source.fence, 'fence', 1);
  let attempt;
  try {
    attempt = getTaskAttemptMetadata({ taskId, fence });
  } catch {
    fail('DELEGATION_TASK_ATTEMPT_READER_UNAVAILABLE', 'canonical attempt reader is unavailable.');
  }
  if (attempt === null) return absent(taskId, fence);

  const normalizedAttempt = exact(attempt, [
    'taskId', 'fence', 'executionAttempt', 'status', 'leaseExpiresAtMs',
    'claimedAtMs', 'startedAtMs', 'updatedAtMs', 'endedAtMs'
  ], 'attemptMetadata');
  if (safeId(normalizedAttempt.taskId, 'attemptMetadata.taskId') !== taskId ||
      integer(normalizedAttempt.fence, 'attemptMetadata.fence', 1) !== fence ||
      !ATTEMPT_STATUS.includes(normalizedAttempt.status)) {
    fail('DELEGATION_TASK_ATTEMPT_MISMATCH', 'attempt metadata does not match the requested generation.');
  }
  const executionAttempt = integer(normalizedAttempt.executionAttempt, 'attemptMetadata.executionAttempt', 1, 10);
  const claimedAtMs = optionalTime(normalizedAttempt.claimedAtMs, 'attemptMetadata.claimedAtMs');
  const startedAtMs = optionalTime(normalizedAttempt.startedAtMs, 'attemptMetadata.startedAtMs');
  optionalTime(normalizedAttempt.leaseExpiresAtMs, 'attemptMetadata.leaseExpiresAtMs');
  optionalTime(normalizedAttempt.updatedAtMs, 'attemptMetadata.updatedAtMs');
  const endedAtMs = optionalTime(normalizedAttempt.endedAtMs, 'attemptMetadata.endedAtMs');

  let task;
  try {
    task = getTask({ taskId, includePayload: false, includeCheckpoint: false });
  } catch {
    fail('DELEGATION_TASK_ATTEMPT_READER_UNAVAILABLE', 'canonical task reader is unavailable.');
  }
  if (!task || typeof task !== 'object') fail('DELEGATION_TASK_ATTEMPT_MISMATCH', 'parent task is absent for the attempt generation.');
  const taskIdField = ownData(task, 'taskId', 'parent task', { required: false });
  const legacyIdField = ownData(task, 'id', 'parent task', { required: false });
  const storedStatusField = ownData(task, 'storedStatus', 'parent task', { required: false });
  const statusField = ownData(task, 'status', 'parent task', { required: false });
  const canonicalTaskId = taskIdField.present ? taskIdField.value : legacyIdField.value;
  const taskStatus = storedStatusField.present ? storedStatusField.value : statusField.value;
  const maxAttempts = ownData(task, 'maxAttempts', 'parent task').value;
  const taskFence = ownData(task, 'fence', 'parent task').value;
  if (safeId(canonicalTaskId, 'task.taskId') !== taskId || !TASK_STATUS.includes(taskStatus) ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
      !Number.isSafeInteger(taskFence) || taskFence < fence) {
    fail('DELEGATION_TASK_ATTEMPT_MISMATCH', 'parent task metadata is inconsistent with the attempt generation.');
  }

  return freeze({
    presence: 'present',
    taskId,
    fence,
    executionAttempt,
    attemptStatus: normalizedAttempt.status,
    taskStatus,
    maxAttempts,
    claimedAtMs,
    startedAtMs,
    endedAtMs,
    retryBudgetConsumed: startedAtMs !== null,
    contentTrust: 'untrusted',
    grantsAuthority: false
  });
}

module.exports = Object.freeze({ DelegationTaskAttemptProjectionError, projectDelegationTaskAttempt });

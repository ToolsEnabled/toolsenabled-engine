'use strict';

// Q21/P3 foundation. This module is deliberately a pure controller-side
// qualification check: it neither dispatches work nor exposes a delegation
// operation. A returned receipt is only a value-free, UNACCEPTED candidate for
// later broker verification. It grants no authority and cannot make a worker
// result authoritative.

const contracts = require('./delegation-contracts');
const enforcement = require('./delegation-enforcement');

class DelegationReadonlyQualificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DelegationReadonlyQualificationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DelegationReadonlyQualificationError(code, message);
}

function plain(value) {
  if (!value || typeof value !== 'object') return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exact(value, keys, label) {
  if (!plain(value)) fail('DELEGATION_READONLY_INVALID', `${label} must be a closed object.`);
  let actual;
  try { actual = Reflect.ownKeys(value); } catch {
    fail('DELEGATION_READONLY_INVALID', `${label} must be a closed object.`);
  }
  if (actual.length !== keys.length
      || actual.some(key => typeof key !== 'string' || !keys.includes(key))) {
    fail('DELEGATION_READONLY_INVALID', `${label} has unsupported or missing fields.`);
  }
  const snapshot = {};
  for (const key of actual) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
      fail('DELEGATION_READONLY_INVALID', `${label} must contain only data fields.`);
    }
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('DELEGATION_READONLY_INVALID', `${label} must contain only enumerable data fields.`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function sameSnapshot(left, right) {
  return Boolean(left && right)
    && left.rootId === right.rootId
    && left.commitSha1 === right.commitSha1
    && left.treeSha256 === right.treeSha256;
}

function sameSorted(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function currentTaskRecord(value) {
  const source = exact(value, [
    'taskId', 'status', 'cancellationRequested', 'delegationId',
    'capabilityProfileHash', 'baseSnapshot'
  ], 'controller task');
  const baseSnapshot = exact(source.baseSnapshot, ['rootId', 'commitSha1', 'treeSha256'],
    'controller task base snapshot');
  if (typeof source.taskId !== 'string' || typeof source.status !== 'string' ||
      typeof source.cancellationRequested !== 'boolean' || typeof source.delegationId !== 'string' ||
      typeof source.capabilityProfileHash !== 'string' || typeof baseSnapshot.rootId !== 'string' ||
      typeof baseSnapshot.commitSha1 !== 'string' || typeof baseSnapshot.treeSha256 !== 'string') {
    fail('DELEGATION_READONLY_INVALID', 'controller task has invalid fields.');
  }
  return Object.freeze({
    taskId: source.taskId,
    status: source.status,
    cancellationRequested: source.cancellationRequested,
    delegationId: source.delegationId,
    capabilityProfileHash: source.capabilityProfileHash,
    baseSnapshot: Object.freeze({
      rootId: baseSnapshot.rootId,
      commitSha1: baseSnapshot.commitSha1,
      treeSha256: baseSnapshot.treeSha256
    })
  });
}

function controllerDependencies(value) {
  let source;
  try {
    source = exact(value, ['now', 'readTask', 'readProfile', 'readFence'], 'controller dependencies');
  } catch {
    fail('DELEGATION_READONLY_CONTROLLER_UNAVAILABLE', 'The controller must provide closed task, profile, fence, and clock readers.');
  }
  if (typeof source.readTask !== 'function' || typeof source.readProfile !== 'function' ||
      typeof source.readFence !== 'function' || typeof source.now !== 'function') {
    fail('DELEGATION_READONLY_CONTROLLER_UNAVAILABLE', 'The controller must provide task, profile, fence, and clock readers.');
  }
  return source;
}

function read(dependencies, name, ...args) {
  try {
    return dependencies[name](...args);
  } catch {
    // Reader details can contain task/provider data. A qualification error is
    // intentionally generic and never relays the exception text.
    fail('DELEGATION_READONLY_CONTROLLER_UNAVAILABLE', 'The controller could not read required delegation state.');
  }
}

function assertLiveBinding(binding, task, dependencies, nowMs) {
  if (binding.expiresAtMs <= nowMs || binding.profileExpiresAtMs <= nowMs) {
    fail('DELEGATION_READONLY_EXPIRED', 'The read-only binding or profile has expired.');
  }
  const currentTask = currentTaskRecord(read(dependencies, 'readTask', binding.taskId));
  if (currentTask.status !== 'running' || currentTask.cancellationRequested ||
      currentTask.taskId !== binding.taskId || currentTask.delegationId !== task.delegationId ||
      currentTask.capabilityProfileHash !== task.capabilityProfileHash ||
      !sameSnapshot(currentTask.baseSnapshot, task.baseSnapshot)) {
    fail('DELEGATION_READONLY_TASK_STALE', 'The durable task is not an active matching read-only task.');
  }

  const fence = read(dependencies, 'readFence', binding.taskId);
  if (!Number.isSafeInteger(fence) || fence !== binding.fence) {
    fail('DELEGATION_READONLY_FENCE_STALE', 'The read-only binding fence is stale or unavailable.');
  }

  const profile = enforcement.profileRecord(read(dependencies, 'readProfile', {
    taskId: binding.taskId,
    delegationId: binding.delegationId,
    profileHash: binding.capabilityProfileHash
  }));
  for (const field of ['taskId', 'delegationId', 'actor', 'providerAdapter', 'rootId', 'rootHash', 'scopeId', 'fence']) {
    if (profile[field] !== binding[field]) {
      fail('DELEGATION_READONLY_PROFILE_MISMATCH', 'The controller profile does not match the read-only binding.');
    }
  }
  if (profile.profileHash !== binding.capabilityProfileHash ||
      !sameSnapshot(profile.baseSnapshot, binding.baseSnapshot) ||
      profile.expiresAtMs < binding.expiresAtMs ||
      profile.toolSchemas.length !== 0 || profile.commandIds.length !== 0) {
    fail('DELEGATION_READONLY_PROFILE_MISMATCH', 'The controller profile is not an exact empty-scope read-only profile.');
  }
}

function normalizeInput(input) {
  const source = exact(input, ['task', 'binding', 'workerResult', 'evidenceBundle'], 'read-only qualification request');
  const task = contracts.validateDelegatedTask(source.task);
  const binding = enforcement.normalizeBinding(source.binding, 0);
  const workerResult = contracts.validateWorkerResult(source.workerResult);

  if (task.role !== 'read_only_review' || task.budgets.maxToolCalls !== 0 ||
      binding.toolSchemas.length !== 0 || binding.commandIds.length !== 0) {
    fail('DELEGATION_READONLY_SCOPE_DENIED', 'The task or binding carries non-read-only scope.');
  }
  if (binding.delegationId !== task.delegationId || binding.rootId !== task.baseSnapshot.rootId ||
      binding.rootHash !== task.baseSnapshot.treeSha256 || !sameSnapshot(binding.baseSnapshot, task.baseSnapshot) ||
      binding.capabilityProfileHash !== task.capabilityProfileHash) {
    fail('DELEGATION_READONLY_BINDING_MISMATCH', 'The binding does not match the delegated task.');
  }
  if (workerResult.terminalState !== 'complete' || workerResult.usage.toolCalls !== 0 ||
      workerResult.brokerAcceptanceState !== 'UNACCEPTED' ||
      workerResult.artifacts.some(artifact => artifact.kind === 'patch')) {
    fail('DELEGATION_READONLY_RESULT_DENIED', 'The worker result is not a complete zero-tool unaccepted read-only candidate.');
  }
  // Revalidate the original closed payloads here. The normalized values carry
  // controller-only contractHash fields and are deliberately not fed back into
  // the strict public-contract validator.
  contracts.assertResultForTask(source.task, source.workerResult);
  if (workerResult.verification.state !== 'passed' ||
      !sameSorted(workerResult.verification.criterionIds, task.acceptanceCriteria)) {
    fail('DELEGATION_READONLY_VERIFICATION_INCOMPLETE', 'The worker result does not prove every task criterion.');
  }

  const evidenceBundle = source.evidenceBundle === null ? null : contracts.validateEvidenceBundle(source.evidenceBundle);
  if (evidenceBundle && (evidenceBundle.delegationId !== task.delegationId ||
      evidenceBundle.workerResultHash !== workerResult.contractHash)) {
    fail('DELEGATION_READONLY_EVIDENCE_MISMATCH', 'The evidence bundle is not bound to this worker result.');
  }
  if (workerResult.verification.evidenceRefs.length > 0 && !evidenceBundle) {
    fail('DELEGATION_READONLY_EVIDENCE_MISMATCH', 'Referenced verification evidence requires a bound evidence bundle.');
  }
  return Object.freeze({ task, binding, workerResult, evidenceBundle });
}

function qualifyReadonlyReview(input, dependencies = {}) {
  const controller = controllerDependencies(dependencies);
  const prepared = normalizeInput(input);
  const nowMs = read(controller, 'now');
  if (!Number.isSafeInteger(nowMs)) {
    fail('DELEGATION_READONLY_CONTROLLER_UNAVAILABLE', 'The controller clock is unavailable.');
  }
  // Check twice. The first rejects stale/cancelled work before preparation;
  // the second is the race-closing observation immediately before a receipt.
  assertLiveBinding(prepared.binding, prepared.task, controller, nowMs);
  assertLiveBinding(prepared.binding, prepared.task, controller, nowMs);
  return Object.freeze({
    schemaVersion: 1,
    status: 'qualified_read_only_candidate',
    delegationId: prepared.task.delegationId,
    taskId: prepared.binding.taskId,
    capabilityProfileHash: prepared.task.capabilityProfileHash,
    workerResultHash: prepared.workerResult.contractHash,
    evidenceBundleHash: prepared.evidenceBundle ? prepared.evidenceBundle.contractHash : null,
    fence: prepared.binding.fence,
    expiresAtMs: prepared.binding.expiresAtMs,
    acceptanceState: 'UNACCEPTED',
    grantsAuthority: false
  });
}

module.exports = Object.freeze({
  DelegationReadonlyQualificationError,
  qualifyReadonlyReview
});

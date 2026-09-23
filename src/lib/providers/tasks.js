'use strict';

const { getStateStore } = require('../state-store');
const coordinatorAudit = require('../coordinator-audit-events');
const errorTaxonomy = require('../error-taxonomy');

const MIN_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 900;
const DEFAULT_LEASE_SECONDS = 300;
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });
const RESERVED_LOCAL_ADVISORY_QUEUE = 'overnight-local-advisory';
const RESERVED_RESEARCH_RUNS_QUEUE = 'research-runs';
const INTERNAL_OVERNIGHT_ADVISORY_STATES = new WeakSet();
const INTERNAL_RESEARCH_RUNS_STATES = new WeakSet();
const INTERNAL_OVERNIGHT_RETRY_CODES = new Set([
  'LOCAL_ADVISORY_STATUS_UNAVAILABLE', 'LOCAL_ADVISORY_LOCAL_TIER_STATUS_UNAVAILABLE',
  'LOCAL_ADVISORY_AWAITING_STRONG_RESIDENCY',
  'LOCAL_ADVISORY_PAUSED_ON_BATTERY', 'LOCAL_ADVISORY_GPU_TOO_WARM',
  'LOCAL_ADVISORY_FREE_RAM_BELOW_FLOOR', 'LOCAL_ADVISORY_FREE_VRAM_BELOW_FLOOR',
  'LOCAL_ADVISORY_THERMAL_STATUS_UNAVAILABLE', 'LOCAL_ADVISORY_PRESSURE_STATUS_UNAVAILABLE',
  'LOCAL_ADVISORY_FRESH_LOAD_FREE_VRAM_BELOW_6.5GIB', 'LOCAL_ADVISORY_ANOTHER_LOCAL_MODEL_IS_RESIDENT',
  'LOCAL_ADVISORY_PAGING_PRESSURE', 'LOCAL_ADVISORY_FOREGROUND_PRESSURE',
  'HERMES_RESOURCE_PAUSED', 'HERMES_RESOURCE_BUSY', 'STRONG_PAUSED', 'MODEL_RESOURCE_BUSY',
  'MODEL_UNAVAILABLE', 'HERMES_UNAVAILABLE', 'STRONG_DISABLED'
]);
const INTERNAL_RESEARCH_RETRY_CODES = new Set([
  'RESEARCH_RUN_SERIALIZED', 'RESEARCH_PAUSED_BY_SETTINGS', 'RESEARCH_PROJECT_DISABLED',
  'RESEARCH_BRIDGE_UNAVAILABLE'
]);

// The local advisory worker deliberately uses this generic fenced-task adapter,
// but the public task.* tools must never become a second control plane for its
// private queue. Dependencies are supplied by server/worker wiring, not MCP
// input, so this is not a caller-settable escape hatch.
function overnightAdvisoryQueueAccess(dependencies = {}) {
  return dependencies.internalOvernightAdvisoryWorker === true || INTERNAL_OVERNIGHT_ADVISORY_STATES.has(dependencies.state);
}

function researchRunsQueueAccess(dependencies = {}) {
  return dependencies.internalResearchRunsWorker === true || INTERNAL_RESEARCH_RUNS_STATES.has(dependencies.state);
}

function reservedQueueAccess(queue, dependencies = {}) {
  if (queue === RESERVED_LOCAL_ADVISORY_QUEUE) return overnightAdvisoryQueueAccess(dependencies);
  if (queue === RESERVED_RESEARCH_RUNS_QUEUE) return researchRunsQueueAccess(dependencies);
  return true;
}

function internalOvernightAdvisoryState(state) {
  if (!state || typeof state !== 'object') throw new TypeError('A durable state store is required for the internal overnight advisory worker.');
  const wrapped = new Proxy(state, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  INTERNAL_OVERNIGHT_ADVISORY_STATES.add(wrapped);
  return wrapped;
}

function internalResearchRunsState(state) {
  if (!state || typeof state !== 'object') throw new TypeError('A durable state store is required for the internal research runs worker.');
  const wrapped = new Proxy(state, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  INTERNAL_RESEARCH_RUNS_STATES.add(wrapped);
  return wrapped;
}

function reservedQueueError(queue) {
  const control = queue === RESERVED_RESEARCH_RUNS_QUEUE ? 'research.*' : 'overnight_advisory.*';
  const error = new TypeError(`The ${queue} queue is reserved; use ${control} controls only.`);
  error.code = 'TASK_QUEUE_RESERVED';
  return error;
}

function taskQueue(task) {
  return task && (task.queue === undefined ? task.queueName : task.queue);
}

function assertQueueAccess(queue, dependencies) {
  if (!reservedQueueAccess(queue, dependencies)) throw reservedQueueError(queue);
}

function assertTaskAccess(state, taskId, dependencies) {
  const task = state.getTask({ taskId, includePayload: false, includeCheckpoint: false });
  const queue = taskQueue(task);
  if (task && !reservedQueueAccess(queue, dependencies)) throw reservedQueueError(queue);
}

function durableState(dependencies) {
  return dependencies.state || getStateStore();
}

function milliseconds(seconds, field) {
  if (seconds === undefined) return DEFAULT_LEASE_SECONDS * 1000;
  if (!Number.isSafeInteger(seconds) || seconds < MIN_LEASE_SECONDS || seconds > MAX_LEASE_SECONDS) {
    throw new TypeError(`${field} must be an integer from ${MIN_LEASE_SECONDS} through ${MAX_LEASE_SECONDS}.`);
  }
  return seconds * 1000;
}

function optionalMilliseconds(seconds, field) {
  if (seconds === undefined) return undefined;
  return milliseconds(seconds, field);
}

function retryDelayMilliseconds(seconds, disposition) {
  if (seconds === undefined) return undefined;
  if (disposition !== 'retry') throw new TypeError('retryDelaySeconds is only valid when disposition is retry.');
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 3600) {
    throw new TypeError('retryDelaySeconds must be an integer from 0 through 3600.');
  }
  return seconds * 1000;
}

function unique(values, field) {
  if (!Array.isArray(values)) return values;
  if (new Set(values).size !== values.length) throw new TypeError(`${field} must not contain duplicates.`);
  return values;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function taskRecord(value) {
  if (!value || typeof value !== 'object') return {};
  return value.task && typeof value.task === 'object' ? value.task : value;
}

function taskMetadata(value) {
  const task = taskRecord(value);
  return compact({
    taskId: task.taskId === undefined ? task.id : task.taskId,
    queue: task.queue,
    type: task.type,
    status: task.status,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    expiryPolicy: task.expiryPolicy,
    createdAt: task.createdAt,
    createdAtMs: task.createdAtMs,
    updatedAt: task.updatedAt,
    updatedAtMs: task.updatedAtMs,
    availableAt: task.availableAt,
    availableAtMs: task.availableAtMs,
    expiresAt: task.expiresAt,
    expiresAtMs: task.expiresAtMs,
    retryAt: task.retryAt,
    retryAtMs: task.retryAtMs,
    startedAt: task.startedAt,
    startedAtMs: task.startedAtMs,
    leaseExpiresAt: task.leaseExpiresAt,
    leaseExpiresAtMs: task.leaseExpiresAtMs,
    completedAt: task.completedAt,
    completedAtMs: task.completedAtMs,
    checkpointRevision: task.checkpointRevision,
    cancellationRequested: task.cancellationRequested === undefined ? task.cancelRequested : task.cancellationRequested
  });
}

function publicHandle(value) {
  if (!value || typeof value !== 'object') throw new Error('The durable task claim did not return a lease handle.');
  const output = compact({
    taskId: value.taskId === undefined ? value.id : value.taskId,
    attempt: value.attempt,
    workerLabel: value.workerLabel === undefined ? value.ownerId : value.workerLabel,
    claimToken: value.claimToken === undefined ? value.token : value.claimToken,
    fence: value.fence
  });
  for (const field of ['taskId', 'attempt', 'workerLabel', 'claimToken', 'fence']) {
    if (output[field] === undefined) throw new Error(`The durable task claim handle is missing ${field}.`);
  }
  return output;
}

function stateHandle(value) {
  return {
    taskId: value.taskId,
    attempt: value.attempt,
    workerLabel: value.workerLabel,
    claimToken: value.claimToken,
    fence: value.fence
  };
}

function transitionMetadata(value) {
  const task = taskMetadata(value);
  const handle = value && value.handle && typeof value.handle === 'object' ? value.handle : null;
  return compact({
    ...task,
    fence: handle ? handle.fence : value && value.fence,
    // The durable store returns the new deadline beside the handle; the
    // handle itself contains only the claim identity. Preserve explicit null
    // on terminal tasks instead of reintroducing an older lease deadline.
    leaseExpiresAt: value?.leaseExpiresAt !== undefined ? value.leaseExpiresAt
      : task.leaseExpiresAt !== undefined ? task.leaseExpiresAt : handle?.expiresAt,
    leaseExpiresAtMs: value?.leaseExpiresAtMs !== undefined ? value.leaseExpiresAtMs
      : task.leaseExpiresAtMs !== undefined ? task.leaseExpiresAtMs : handle?.expiresAtMs,
    heartbeatByMs: value && value.heartbeatByMs,
    cancellationRequested: value && value.cancellationRequested === undefined
      ? (value && value.cancelRequested === undefined ? task.cancellationRequested : value.cancelRequested)
      : value && value.cancellationRequested,
    replayed: value && value.replayed
  });
}

// The durable task store remains the state authority.  This adapter observes
// only the returned transition metadata after a successful state operation;
// it never receives payloads, checkpoints, claim tokens, result bodies, or
// failure messages.  Canonical-audit outages keep their existing emergency
// spool/recovery semantics because P11 delegates the write to audit.record.
function recordTaskTransition(operation, value, dependencies = {}) {
  const task = taskMetadata(value);
  if (typeof task.taskId !== 'string' || typeof task.status !== 'string') return null;
  const event = coordinatorAudit.taskTransition({
    taskId: task.taskId,
    operation,
    status: task.status,
    attempt: task.attempt,
    fence: value && value.fence,
    revision: value && (value.revision === undefined ? task.checkpointRevision : value.revision),
    replayed: value && value.replayed,
    occurredAtMs: task.updatedAtMs
  });
  return coordinatorAudit.write(event, {
    required: false,
    ...(typeof dependencies.auditRecord === 'function' ? { auditRecord: dependencies.auditRecord } : {}),
    ...(dependencies.auditDependencies ? { auditDependencies: dependencies.auditDependencies } : {})
  });
}

function publicCheckpoint(value, includeBody) {
  if (!value || typeof value !== 'object') return undefined;
  const checkpoint = value;
  const output = compact({
    revision: checkpoint.revision,
    checkpointKey: checkpoint.checkpointKey === undefined ? checkpoint.key : checkpoint.checkpointKey,
    hash: checkpoint.hash,
    createdAt: checkpoint.createdAt,
    createdAtMs: checkpoint.createdAtMs
  });
  if (includeBody) {
    let body = checkpoint.checkpoint === undefined ? checkpoint.body : checkpoint.checkpoint;
    if (body === undefined && (checkpoint.summary !== undefined || checkpoint.resumeContext !== undefined)) {
      body = compact({ summary: checkpoint.summary, resumeContext: checkpoint.resumeContext });
    }
    if (body !== undefined) output.checkpoint = body;
    Object.assign(output, UNTRUSTED_CONTENT);
  }
  return output;
}

async function submit(input, dependencies = {}) {
  assertQueueAccess(input && input.queue, dependencies);
  const state = durableState(dependencies);
  const result = await state.submitTask({
    queue: input.queue,
    type: input.type,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    expiryPolicy: input.expiryPolicy,
    maxAttempts: input.maxAttempts
  });
  const output = {
    ...taskMetadata(result),
    replayed: Boolean(result && (result.replayed === true || result.disposition === 'replay'))
  };
  recordTaskTransition('submit', output, dependencies);
  return output;
}

async function claim(input, dependencies = {}) {
  const state = durableState(dependencies);
  assertQueueAccess(input && input.queue, dependencies);
  const leaseMs = milliseconds(input.leaseSeconds, 'leaseSeconds');
  const request = compact({
    queue: input.queue,
    types: unique(input.types, 'types'),
    workerLabel: input.workerLabel,
    leaseMs
  });
  const result = await state.claimTask(request);
  if (!result) return { claimed: false, queue: input.queue };
  const task = taskRecord(result);
  const handle = publicHandle(result.handle);
  const latestCheckpoint = task.latestCheckpoint === undefined ? result.latestCheckpoint : task.latestCheckpoint;
  const body = compact({
    ...taskMetadata(task),
    payload: task.payload,
    latestCheckpoint: latestCheckpoint === undefined ? undefined : publicCheckpoint(latestCheckpoint, true),
    ...UNTRUSTED_CONTENT
  });
  const output = compact({
    claimed: true,
    ...UNTRUSTED_CONTENT,
    task: body,
    handle,
    leaseExpiresAt: result.leaseExpiresAt === undefined && result.handle ? result.handle.expiresAt : result.leaseExpiresAt,
    leaseExpiresAtMs: result.leaseExpiresAtMs === undefined && result.handle ? result.handle.expiresAtMs : result.leaseExpiresAtMs,
    heartbeatByMs: result.heartbeatByMs
  });
  recordTaskTransition('claim', { ...taskMetadata(task), fence: handle.fence, replayed: Boolean(result && result.replayed) }, dependencies);
  return output;
}

async function start(input, dependencies = {}) {
  const state = durableState(dependencies);
  assertTaskAccess(state, input && input.handle && input.handle.taskId, dependencies);
  const result = await state.startTask(stateHandle(input.handle), compact({
    leaseMs: milliseconds(input.leaseSeconds, 'leaseSeconds')
  }));
  const output = transitionMetadata(result);
  recordTaskTransition('start', output, dependencies);
  return output;
}

async function heartbeat(input, dependencies = {}) {
  const state = durableState(dependencies);
  assertTaskAccess(state, input && input.handle && input.handle.taskId, dependencies);
  const result = await state.heartbeatTask(stateHandle(input.handle), compact({
    leaseMs: milliseconds(input.extendSeconds, 'extendSeconds')
  }));
  const output = transitionMetadata(result);
  recordTaskTransition('heartbeat', output, dependencies);
  return output;
}

// Internal worker guard, deliberately absent from task.* tools. Keep this
// synchronous so a queued cancellation or lease replacement cannot hide
// behind an earlier awaited start/heartbeat acknowledgement at native launch.
function inspectClaim(input, dependencies = {}) {
  const state = durableState(dependencies);
  assertTaskAccess(state, input && input.handle && input.handle.taskId, dependencies);
  const result = state.inspectTaskClaim(stateHandle(input.handle));
  if (!result || typeof result.then === 'function') {
    throw new TypeError('The native launch claim check must complete synchronously.');
  }
  return transitionMetadata(result);
}

async function checkpoint(input, dependencies = {}) {
  const state = durableState(dependencies);
  assertTaskAccess(state, input && input.handle && input.handle.taskId, dependencies);
  const result = await state.checkpointTask(stateHandle(input.handle), compact({
    checkpointKey: input.checkpointKey,
    expectedRevision: input.expectedRevision,
    checkpoint: input.checkpoint,
    leaseMs: optionalMilliseconds(input.extendSeconds, 'extendSeconds')
  }));
  const saved = publicCheckpoint(result && (result.savedCheckpoint || result.checkpoint || result), false) || {};
  const output = compact({
    ...transitionMetadata(result),
    revision: saved.revision,
    checkpointKey: saved.checkpointKey,
    hash: saved.hash,
    checkpointCreatedAt: saved.createdAt,
    checkpointCreatedAtMs: saved.createdAtMs
  });
  recordTaskTransition('checkpoint', output, dependencies);
  return output;
}

async function complete(input, dependencies = {}) {
  const state = durableState(dependencies);
  assertTaskAccess(state, input && input.handle && input.handle.taskId, dependencies);
  const result = await state.completeTask(stateHandle(input.handle), { result: input.result });
  const output = transitionMetadata(result);
  recordTaskTransition('complete', output, dependencies);
  return output;
}

// Internal worker operation only; deliberately absent from the public tool
// registry. The run link, claim token and fence are rechecked in the same DB
// transaction that saves every result and marks the task complete.
async function completeResearchRun(input, dependencies = {}) {
  if (!researchRunsQueueAccess(dependencies)) throw reservedQueueError(RESERVED_RESEARCH_RUNS_QUEUE);
  const state = durableState(dependencies);
  assertTaskAccess(state, input?.handle?.taskId, dependencies);
  const result = await state.completeResearchRun(stateHandle(input.handle), {
    runId: input.runId, records: input.records, result: input.result
  });
  const output = transitionMetadata(result);
  recordTaskTransition('complete', output, dependencies);
  return output;
}

async function fail(input, dependencies = {}) {
  const state = durableState(dependencies);
  assertTaskAccess(state, input && input.handle && input.handle.taskId, dependencies);
  // The generic public task contract keeps its legacy detailed code, while the
  // one private overnight queue maps only its fixed resource/power pause codes
  // onto the closed retry taxonomy. This prevents an unrecognized local pause
  // from being converted into a terminal INTERNAL_ERROR after work was safely
  // deferred. Public callers can neither target that queue nor select this
  // mapping.
  const taxonomyCode = ((overnightAdvisoryQueueAccess(dependencies) && input?.disposition === 'retry'
      && INTERNAL_OVERNIGHT_RETRY_CODES.has(input?.code))
    || (researchRunsQueueAccess(dependencies) && input?.disposition === 'retry'
      && INTERNAL_RESEARCH_RETRY_CODES.has(input?.code)))
    ? 'RESOURCE_PRESSURE' : input && input.code;
  const typed = errorTaxonomy.publicFailure(errorTaxonomy.adaptToolError({
    code: taxonomyCode,
    message: input && input.message
  }));
  // Preserve the legacy bounded/sanitized task error fields for compatibility;
  // the public task reader attaches P15's closed taxonomy so controllers do
  // not parse those legacy details to decide retry/block/fail.
  if (input.disposition === 'retry') {
    const current = state.getTask({ taskId: input.handle.taskId, includePayload: false, includeCheckpoint: false });
    const decision = errorTaxonomy.decideRetry(typed, {
      effect: 'local-write',
      attempt: current && Number.isSafeInteger(current.attempt) ? current.attempt : 1
    });
    if (decision.disposition !== 'retry') {
      const error = new TypeError(`The failure is classified ${typed.code} and is not retryable for this attempt (${decision.reason}). Preserve the actual failure code; use failed for a definitive failure or uncertain for an unresolved outcome.`);
      error.code = 'TASK_RETRY_CODE_INVALID';
      error.details = { field: decision.reason === 'retry-ceiling-reached' ? 'disposition' : 'code', failureTaxonomyCode: typed.code, retryReason: decision.reason };
      throw error;
    }
  }
  const result = await state.failTask(stateHandle(input.handle), compact({
    disposition: input.disposition,
    code: input.code,
    message: input.message,
    retryDelayMs: retryDelayMilliseconds(input.retryDelaySeconds, input.disposition)
  }));
  const output = transitionMetadata(result);
  recordTaskTransition('fail', output, dependencies);
  return output;
}

async function cancel(input, dependencies = {}) {
  const state = durableState(dependencies);
  assertTaskAccess(state, input && input.taskId, dependencies);
  const result = await state.cancelTask(compact({ taskId: input.taskId, reason: input.reason }));
  const output = transitionMetadata(result);
  recordTaskTransition('cancel', output, dependencies);
  return output;
}

function contentBearingTask(value, options) {
  const task = taskRecord(value);
  const output = taskMetadata(task);
  let hasContent = false;
  if (options.includePayload && task.payload !== undefined) {
    output.payload = task.payload;
    hasContent = true;
  }
  if (task.result !== undefined) {
    output.result = task.result;
    hasContent = true;
  }
  const error = task.error && typeof task.error === 'object'
    ? task.error
    : (task.errorCode === undefined || task.errorCode === null ? null : { code: task.errorCode, message: task.errorMessage || '' });
  if (error) {
    const taxonomy = errorTaxonomy.publicFailure(errorTaxonomy.adaptToolError(error));
    // Preserve the legacy bounded task failure fields, and attach a separate
    // closed envelope so new consumers never need to parse those fields.
    output.error = compact({ code: error.code, message: error.message, taxonomy });
    hasContent = true;
  }
  if (options.includeCheckpoint) {
    const latest = task.latestCheckpoint === undefined ? value.latestCheckpoint : task.latestCheckpoint;
    if (latest !== undefined) {
      output.latestCheckpoint = publicCheckpoint(latest, true);
      hasContent = true;
    }
  }
  if (hasContent) Object.assign(output, UNTRUSTED_CONTENT);
  return output;
}

async function get(input, dependencies = {}) {
  const state = durableState(dependencies);
  assertTaskAccess(state, input && input.taskId, dependencies);
  const result = await state.getTask({
    taskId: input.taskId,
    includePayload: input.includePayload === true,
    includeCheckpoint: input.includeCheckpoint === true
  });
  if (!result) return null;
  return contentBearingTask(result, input);
}

async function list(input = {}, dependencies = {}) {
  const state = durableState(dependencies);
  assertQueueAccess(input && input.queue, dependencies);
  const result = await state.listTasks(compact({
    queue: input.queue,
    type: input.type,
    status: input.status,
    statuses: input.statuses,
    limit: input.limit
  }));
  if (!Array.isArray(result) && (!result || !Array.isArray(result.tasks))) {
    throw new Error('The durable task list did not return a task collection.');
  }
  const rows = Array.isArray(result) ? result : result.tasks;
  const visible = rows.filter(task => reservedQueueAccess(taskQueue(task), dependencies));
  return compact({
    tasks: visible.map(taskMetadata),
    count: visible.length,
    nextCursor: !Array.isArray(result) && result ? result.nextCursor : undefined
  });
}

module.exports = {
  DEFAULT_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
  MIN_LEASE_SECONDS,
  UNTRUSTED_CONTENT,
  cancel,
  checkpoint,
  claim,
  complete,
  completeResearchRun,
  fail,
  get,
  heartbeat,
  inspectClaim,
  internalOvernightAdvisoryState,
  internalResearchRunsState,
  list,
  start,
  submit
};

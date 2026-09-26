'use strict';

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_WORKERS = 1_000;
const WAKE_ACTIONS = Object.freeze(['resume', 'respawn', 'prompt']);

const ADAPTER_KINDS = Object.freeze({
  CLAUDE_SESSION_RESUME: 'CLAUDE_SESSION_RESUME',
  DURABLE_TASK_REENQUEUE: 'DURABLE_TASK_REENQUEUE'
});

const adapterBrand = new WeakSet();

class WorkerRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkerRegistryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkerRegistryError(code, message);
}

function identifier(value, label) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_IDENTIFIER_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    fail('WAKE_WORKER_INVALID', `${label} is invalid.`);
  }
  return value;
}

function plainDataObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('WAKE_WORKER_INVALID', `${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('WAKE_WORKER_INVALID', `${label} must be a plain data object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('WAKE_WORKER_INVALID', `${label} may only contain string keys.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('WAKE_WORKER_INVALID', `${label} may not contain accessors.`);
    }
  }
  return value;
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    fail('WAKE_WORKER_INVALID', `${label} keys are invalid.`);
  }
}

function freezeOperation(value) {
  const operation = { ...value };
  if (Array.isArray(operation.arguments)) operation.arguments = Object.freeze([...operation.arguments]);
  return Object.freeze(operation);
}

function makeAdapter(kind, operation) {
  const adapter = Object.freeze({
    kind,
    allowedActions: WAKE_ACTIONS,
    operation: freezeOperation(operation)
  });
  adapterBrand.add(adapter);
  return adapter;
}

function createClaudeSessionResumeAdapter(options = {}) {
  const source = plainDataObject(options, 'Claude resume adapter');
  exactKeys(source, ['storedSessionId'], 'Claude resume adapter');
  const storedSessionId = identifier(source.storedSessionId, 'storedSessionId');
  return makeAdapter(ADAPTER_KINDS.CLAUDE_SESSION_RESUME, {
    kind: ADAPTER_KINDS.CLAUDE_SESSION_RESUME,
    program: 'claude',
    arguments: ['--resume', storedSessionId]
  });
}

function createDurableTaskReenqueueAdapter(options = {}) {
  const source = plainDataObject(options, 'durable task adapter');
  exactKeys(source, ['leaseFence', 'taskId'], 'durable task adapter');
  const taskId = identifier(source.taskId, 'taskId');
  const leaseFence = identifier(source.leaseFence, 'leaseFence');
  return makeAdapter(ADAPTER_KINDS.DURABLE_TASK_REENQUEUE, {
    kind: ADAPTER_KINDS.DURABLE_TASK_REENQUEUE,
    taskId,
    leaseFence
  });
}

function validateWorker(worker) {
  const source = plainDataObject(worker, 'worker declaration');
  const keys = Object.keys(source).sort();
  const permitted = ['adapter', 'enabled', 'targetId'];
  if (keys.some(key => !permitted.includes(key))
    || !keys.includes('adapter')
    || !keys.includes('targetId')) {
    fail('WAKE_WORKER_INVALID', 'worker declaration keys are invalid.');
  }
  if (source.enabled !== undefined && typeof source.enabled !== 'boolean') {
    fail('WAKE_WORKER_INVALID', 'worker enabled must be a boolean when present.');
  }
  if (!adapterBrand.has(source.adapter)) {
    fail('WAKE_WORKER_INVALID', 'worker adapter must be created by this registry.');
  }
  return Object.freeze({
    targetId: identifier(source.targetId, 'targetId'),
    enabled: source.enabled === true,
    adapter: source.adapter
  });
}

function createWorkerRegistry({ workers = [] } = {}) {
  if (!Array.isArray(workers) || workers.length > MAX_WORKERS) {
    fail('WAKE_WORKER_INVALID', 'workers must be a bounded array.');
  }
  const byTarget = new Map();
  for (const worker of workers) {
    const declared = validateWorker(worker);
    if (byTarget.has(declared.targetId)) {
      fail('WAKE_WORKER_INVALID', 'worker targetId is duplicated.');
    }
    byTarget.set(declared.targetId, declared);
  }

  function resolve(targetId) {
    return byTarget.get(identifier(targetId, 'targetId')) || null;
  }

  function listTargets() {
    return Object.freeze([...byTarget.values()].map(worker => Object.freeze({
      targetId: worker.targetId,
      enabled: worker.enabled,
      adapterKind: worker.adapter.kind
    })));
  }

  return Object.freeze({
    listTargets,
    resolve
  });
}

module.exports = Object.freeze({
  ADAPTER_KINDS,
  WorkerRegistryError,
  createClaudeSessionResumeAdapter,
  createDurableTaskReenqueueAdapter,
  createWorkerRegistry
});

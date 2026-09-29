'use strict';

const {
  createWorkerRegistry
} = require('./worker-registry');

const RECEIPT_VERSION = 1;
const DEFAULT_MAX_RECEIPTS = 1_000;
const MAX_IDENTIFIER_LENGTH = 128;
const ALLOWED_ACTIONS = new Set(['resume', 'respawn', 'prompt']);
const OUTCOMES = Object.freeze({
  ACTION_REFUSED: 'ACTION_REFUSED',
  INSTRUCTION_INVALID: 'INSTRUCTION_INVALID',
  RUNNER_FAILED: 'RUNNER_FAILED',
  RUNNER_REFUSED: 'RUNNER_REFUSED',
  STARTED: 'STARTED',
  TARGET_UNARMED: 'TARGET_UNARMED',
  TARGET_UNKNOWN: 'TARGET_UNKNOWN'
});

class WakeDispatchError extends Error {
  constructor(receipt) {
    super(`wake dispatch refused: ${receipt.outcome}`);
    this.name = 'WakeDispatchError';
    this.code = receipt.outcome;
    this.receipt = receipt;
  }
}

function identifier(value, { requestId = false } = {}) {
  const minimum = requestId ? 8 : 1;
  return typeof value === 'string'
    && value.length >= minimum
    && value.length <= MAX_IDENTIFIER_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
    ? value
    : null;
}

function makeReceipt(requestId, targetId, accepted, outcome) {
  return Object.freeze({
    receiptVersion: RECEIPT_VERSION,
    requestId,
    targetId,
    accepted,
    outcome
  });
}

function refusingRunner() {
  return Object.freeze({
    async run() {
      throw new Error('WAKE_RUNNER_REFUSED');
    }
  });
}

function normalizeInstruction(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Object.keys(value).sort();
  const expected = value.action === 'prompt'
    ? ['action', 'agentId', 'prompt', 'requestId', 'sessionId']
    : ['action', 'agentId', 'requestId', 'sessionId'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  if (!identifier(value.requestId, { requestId: true })
    || !identifier(value.agentId)
    || !identifier(value.sessionId)
    || typeof value.action !== 'string'
    || !ALLOWED_ACTIONS.has(value.action)) {
    return null;
  }
  if (value.action === 'prompt' && (typeof value.prompt !== 'string' || value.prompt.length < 1 || value.prompt.length > 4_000)) {
    return null;
  }
  return Object.freeze({
    requestId: value.requestId,
    targetId: value.agentId,
    action: value.action
  });
}

function createWakeExecutor({
  registry = createWorkerRegistry(),
  runner = refusingRunner(),
  maxReceipts = DEFAULT_MAX_RECEIPTS
} = {}) {
  if (!registry || typeof registry.resolve !== 'function') {
    throw new TypeError('registry must expose resolve(targetId).');
  }
  if (!runner || typeof runner.run !== 'function') {
    throw new TypeError('runner must expose run(fixedOperation).');
  }
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > 100_000) {
    throw new TypeError('maxReceipts must be a safe bounded integer.');
  }

  const receipts = [];

  function record(receipt) {
    receipts.push(receipt);
    if (receipts.length > maxReceipts) receipts.splice(0, receipts.length - maxReceipts);
    return receipt;
  }

  async function handle(instruction) {
    const normalized = normalizeInstruction(instruction);
    if (!normalized) return record(makeReceipt(null, null, false, OUTCOMES.INSTRUCTION_INVALID));

    const worker = registry.resolve(normalized.targetId);
    if (!worker) {
      return record(makeReceipt(normalized.requestId, normalized.targetId, false, OUTCOMES.TARGET_UNKNOWN));
    }
    if (worker.enabled !== true) {
      return record(makeReceipt(normalized.requestId, normalized.targetId, false, OUTCOMES.TARGET_UNARMED));
    }
    if (!worker.adapter.allowedActions.includes(normalized.action)) {
      return record(makeReceipt(normalized.requestId, normalized.targetId, false, OUTCOMES.ACTION_REFUSED));
    }

    try {
      await runner.run(worker.adapter.operation);
      return record(makeReceipt(normalized.requestId, normalized.targetId, true, OUTCOMES.STARTED));
    } catch (error) {
      const outcome = error && error.message === 'WAKE_RUNNER_REFUSED'
        ? OUTCOMES.RUNNER_REFUSED
        : OUTCOMES.RUNNER_FAILED;
      return record(makeReceipt(normalized.requestId, normalized.targetId, false, outcome));
    }
  }

  async function forWakeRequest(instruction) {
    const receipt = await handle(instruction);
    if (!receipt.accepted) throw new WakeDispatchError(receipt);
    return receipt;
  }

  function getReceipts() {
    return Object.freeze([...receipts]);
  }

  return Object.freeze({
    forWakeRequest,
    getReceipts,
    handle
  });
}

module.exports = Object.freeze({
  DEFAULT_MAX_RECEIPTS,
  OUTCOMES,
  RECEIPT_VERSION,
  WakeDispatchError,
  createWakeExecutor
});

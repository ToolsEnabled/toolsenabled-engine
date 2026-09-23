'use strict';

// The engine contract deliberately owns validation only.  Engine adapters own
// transport, engine-specific protocol mapping, and process lifecycle.

const CONTRACT_VERSION = 1;

const ENGINE_METHODS = Object.freeze([
  'startThread',
  'resumeThread',
  'forkThread',
  'sendTurn',
  'onEvent',
  'answerApproval',
  'interrupt',
  'getUsage'
]);

const EVENT_TYPES = Object.freeze([
  'assistant_text_delta',
  'assistant_text',
  'tool_call',
  'tool_result',
  'approval_request',
  'usage',
  'turn_completed',
  /* THE TWO ADDED 2026-09-03, owner: "more event types are fine we should be
     showing the user when the model is thinking anyway." Neither carries
     assistant speech, so admitting them widens what a surface may SHOW,
     never what it may print as words the agent said.

     turn_accepted -- an early, adapter-specific receipt that the turn is
       under way (see claude-cli-adapter.js's system/init handling for why
       one engine needs this and the other does not).
     thinking      -- the model's own reasoning content, forwarded as its own
       type instead of being dropped or folded into assistant_text (see
       claude-cli-adapter.js and codex-adapter.js for where each engine's
       reasoning shape is read). */
  'turn_accepted',
  'thinking'
]);

class AgentEngineContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentEngineContractError';
    this.code = 'AGENT_ENGINE_CONTRACT_INVALID';
  }
}

function invalid(message) {
  throw new AgentEngineContractError(message);
}

function descriptors(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const own = Object.getOwnPropertyDescriptors(value);
  if (Object.values(own).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return null;
  return own;
}

function record(value, label, allowed, required = []) {
  const own = descriptors(value);
  if (!own) invalid(`${label} must be a plain data object`);
  for (const key of Object.keys(own)) {
    if (!allowed.includes(key)) invalid(`${label} contains unsupported field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(own, key)) invalid(`${label} is missing ${key}`);
  }
  return own;
}

function string(value, label, { allowEmpty = false, max = 1_000_000 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    invalid(`${label} must be a ${allowEmpty ? 'bounded' : 'non-empty'} string`);
  }
  return value;
}

function optionalString(value, label) {
  return value === undefined ? undefined : string(value, label, { allowEmpty: false, max: 32_768 });
}

function jsonValue(value, label, depth = 0) {
  if (depth > 32) invalid(`${label} exceeds the maximum JSON depth`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, depth + 1));
  const own = descriptors(value);
  if (!own) invalid(`${label} must be JSON data`);
  const output = {};
  for (const [key, descriptor] of Object.entries(own)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalid(`${label} has an unsafe key`);
    output[key] = jsonValue(descriptor.value, `${label}.${key}`, depth + 1);
  }
  return output;
}

function validateThreadOptions(value = {}) {
  const own = record(value, 'thread options', [
    'cwd', 'model', 'serviceTier', 'approvalPolicy', 'sandbox', 'baseInstructions',
    'developerInstructions', 'personality', 'ephemeral', 'lastTurnId', 'effort'
  ]);
  const output = {};
  for (const key of ['cwd', 'model', 'serviceTier', 'baseInstructions', 'developerInstructions', 'lastTurnId']) {
    if (Object.hasOwn(own, key)) output[key] = optionalString(own[key].value, `thread options.${key}`);
  }
  if (Object.hasOwn(own, 'effort')) {
    const effort = string(own.effort.value, 'thread options.effort');
    if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) {
      invalid('thread options.effort is unsupported');
    }
    output.effort = effort;
  }
  if (Object.hasOwn(own, 'approvalPolicy')) {
    const value = string(own.approvalPolicy.value, 'thread options.approvalPolicy');
    if (!['untrusted', 'on-request', 'never'].includes(value)) invalid('thread options.approvalPolicy is unsupported');
    output.approvalPolicy = value;
  }
  if (Object.hasOwn(own, 'sandbox')) {
    const value = string(own.sandbox.value, 'thread options.sandbox');
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value)) invalid('thread options.sandbox is unsupported');
    output.sandbox = value;
  }
  if (Object.hasOwn(own, 'personality')) output.personality = string(own.personality.value, 'thread options.personality');
  if (Object.hasOwn(own, 'ephemeral')) {
    if (typeof own.ephemeral.value !== 'boolean') invalid('thread options.ephemeral must be boolean');
    output.ephemeral = own.ephemeral.value;
  }
  return Object.freeze(output);
}

function validateThreadId(value, label = 'threadId') {
  return string(value, label, { max: 512 });
}

function validateImage(value, index) {
  const own = record(value, `images[${index}]`, ['url', 'path', 'detail']);
  const hasUrl = Object.hasOwn(own, 'url');
  const hasPath = Object.hasOwn(own, 'path');
  if (hasUrl === hasPath) invalid(`images[${index}] must contain exactly one of url or path`);
  const output = hasUrl
    ? { url: string(own.url.value, `images[${index}].url`, { max: 4_000_000 }) }
    : { path: string(own.path.value, `images[${index}].path`, { max: 32_768 }) };
  if (Object.hasOwn(own, 'detail')) {
    const detail = string(own.detail.value, `images[${index}].detail`);
    if (!['auto', 'low', 'high', 'original'].includes(detail)) invalid(`images[${index}].detail is unsupported`);
    output.detail = detail;
  }
  return Object.freeze(output);
}

function validateSendTurnRequest(value) {
  const own = record(value, 'turn request', ['threadId', 'text', 'images', 'options'], ['threadId', 'text']);
  const text = string(own.text.value, 'turn request.text', { allowEmpty: true });
  const images = Object.hasOwn(own, 'images') ? own.images.value : [];
  if (!Array.isArray(images) || images.length > 64) invalid('turn request.images must be an array of at most 64 images');
  if (text.length === 0 && images.length === 0) invalid('turn request requires text or an image');
  return Object.freeze({
    threadId: validateThreadId(own.threadId.value),
    text,
    images: Object.freeze(images.map(validateImage)),
    options: validateThreadOptions(Object.hasOwn(own, 'options') ? own.options.value : {})
  });
}

function validateApprovalAnswer(value) {
  const own = record(value, 'approval answer', ['approvalId', 'response'], ['approvalId', 'response']);
  return Object.freeze({
    approvalId: string(own.approvalId.value, 'approval answer.approvalId', { max: 1_024 }),
    response: Object.freeze(jsonValue(own.response.value, 'approval answer.response'))
  });
}

function validateEngineEvent(value) {
  const own = record(value, 'engine event', ['type', 'threadId', 'turnId', 'itemId', 'toolCallId', 'text', 'tool', 'payload', 'approval', 'usage', 'status'], ['type']);
  const type = string(own.type.value, 'engine event.type', { max: 128 });
  if (!EVENT_TYPES.includes(type)) invalid(`engine event type ${type} is unsupported`);
  const output = { type };
  for (const key of ['threadId', 'turnId', 'itemId', 'toolCallId', 'text', 'tool', 'status']) {
    if (Object.hasOwn(own, key)) output[key] = string(own[key].value, `engine event.${key}`, { allowEmpty: key === 'text', max: 1_000_000 });
  }
  for (const key of ['payload', 'approval', 'usage']) {
    if (Object.hasOwn(own, key)) output[key] = Object.freeze(jsonValue(own[key].value, `engine event.${key}`));
  }
  return Object.freeze(output);
}

function assertEngineAdapter(adapter) {
  const own = descriptors(adapter);
  if (!own && (adapter === null || (typeof adapter !== 'object' && typeof adapter !== 'function'))) {
    invalid('engine adapter must be an object');
  }
  for (const method of ENGINE_METHODS) {
    if (typeof adapter[method] !== 'function') invalid(`engine adapter must implement ${method}()`);
  }
  return adapter;
}

module.exports = {
  CONTRACT_VERSION,
  ENGINE_METHODS,
  EVENT_TYPES,
  AgentEngineContractError,
  assertEngineAdapter,
  validateApprovalAnswer,
  validateEngineEvent,
  validateImage,
  validateSendTurnRequest,
  validateThreadId,
  validateThreadOptions
};

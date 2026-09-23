'use strict';

// Q21/AGW-05. This is a pure, default-off adapter vocabulary. It deliberately
// has no provider execution, task-store, registry, browser, vault, audit, or
// acceptance dependency. A conforming adapter is still only an untrusted
// worker; the existing controller remains the sole task-state and acceptance
// owner.
const crypto = require('node:crypto');
const delegationContracts = require('./delegation-contracts');

const SCHEMA_VERSION = 1;
const HASH_DOMAIN = 'toolsenabled.delegation-adapter-contract.v1';
const ID = /^[a-z][a-z0-9._-]{2,119}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:api[_-]?key|token|password|cookie|otp|mfa|secret)\b|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;

// No API route appears here: this P1 contract supports only the already
// configured local/subscription transport names and does not select one.
const ALLOWED_TRANSPORTS = Object.freeze([
  'claude-subscription-cli',
  'codex-subscription-cli',
  'gemini-subscription-cli',
  'local'
]);
const EVENT_KINDS = Object.freeze(['complete', 'error', 'input_required', 'progress', 'stderr_warning']);
const REQUIRED_METHODS = Object.freeze(['probe', 'start', 'collect', 'provideInput', 'cancel', 'cleanup']);
const RESULT_STATES = Object.freeze(['complete', 'blocked', 'cancelled', 'failed']);

class DelegationAdapterContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DelegationAdapterContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DelegationAdapterContractError(code, message);
}

const INDETERMINATE_ERROR_CODES = new Set(['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']);

function inspectionFailed(error, definiteMessage) {
  if (error && (INDETERMINATE_ERROR_CODES.has(error.code) || error.name === 'TimeoutError')) {
    fail(
      'DELEGATION_ADAPTER_INSPECTION_UNAVAILABLE',
      'Adapter contract inspection could not be completed; this does NOT claim that the adapter or field is absent or invalid.'
    );
  }
  fail('DELEGATION_ADAPTER_INVALID', definiteMessage);
}

function plain(value, label) {
  let valid = false;
  try {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      valid = prototype === Object.prototype || prototype === null;
    }
  } catch (error) {
    inspectionFailed(error, `${label} must be a plain object.`);
  }
  if (!valid) {
    fail('DELEGATION_ADAPTER_INVALID', `${label} must be a plain object.`);
  }
  return value;
}

function ownData(value, key, label) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (error) {
    inspectionFailed(error, `${label}.${key} must be a data field.`);
  }
  if (!descriptor || descriptor.enumerable !== true
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    // Accessors are rejected instead of read: validation must not run adapter
    // code or execute untrusted descriptor getters.
    fail('DELEGATION_ADAPTER_INVALID', `${label}.${key} must be a data field.`);
  }
  return descriptor.value;
}

function closed(value, fields, required, label) {
  const source = plain(value, label);
  let keys;
  try { keys = Reflect.ownKeys(source); } catch (error) {
    inspectionFailed(error, `${label} must be a plain object.`);
  }
  if (keys.some(key => typeof key !== 'string' || !fields.includes(key))
      || required.some(key => !keys.includes(key))) {
    fail('DELEGATION_ADAPTER_INVALID', `${label} has unsupported or missing fields.`);
  }
  const snapshot = {};
  for (const key of keys) snapshot[key] = ownData(source, key, label);
  return Object.freeze(snapshot);
}

function arrayItems(value, label, { min = 0, max = 32 } = {}) {
  let isArray = false;
  try { isArray = Array.isArray(value); } catch (error) {
    inspectionFailed(error, `${label} is invalid.`);
  }
  if (!isArray) fail('DELEGATION_ADAPTER_INVALID', `${label} is invalid.`);
  let keys;
  let lengthDescriptor;
  try {
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch (error) {
    inspectionFailed(error, `${label} is invalid.`);
  }
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < min || lengthDescriptor.value > max) {
    fail('DELEGATION_ADAPTER_INVALID', `${label} is invalid.`);
  }
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1 || !keys.includes('length')
      || keys.some(key => typeof key !== 'string'
        || (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) {
    fail('DELEGATION_ADAPTER_INVALID', `${label} has unsupported or missing fields.`);
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) fail('DELEGATION_ADAPTER_INVALID', `${label} is sparse.`);
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (error) {
      inspectionFailed(error, `${label} must contain only data items.`);
    }
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('DELEGATION_ADAPTER_INVALID', `${label} must contain only enumerable data items.`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function safeText(value, label, pattern = ID, { min = 3, max = 120 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || !pattern.test(value) || SENSITIVE.test(value)) {
    fail('DELEGATION_ADAPTER_INVALID', `${label} is invalid.`);
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('DELEGATION_ADAPTER_INVALID', `${label} is invalid.`);
  }
  return value;
}

function sortedUnique(values, label, allowed, { min = 1, max = 32 } = {}) {
  const normalized = arrayItems(values, label, { min, max }).map((value, index) => {
    const item = safeText(value, `${label}[${index}]`);
    if (!allowed.includes(item)) fail('DELEGATION_ADAPTER_INVALID', `${label} contains an unsupported value.`);
    return item;
  });
  if (new Set(normalized).size !== normalized.length || normalized.some((item, index) => item !== [...normalized].sort()[index])) {
    fail('DELEGATION_ADAPTER_INVALID', `${label} must be sorted and unique.`);
  }
  return Object.freeze([...normalized]);
}

function stable(value) {
  let isArray = false;
  try { isArray = Array.isArray(value); } catch (error) {
    inspectionFailed(error, 'digest input is invalid.');
  }
  if (isArray) return arrayItems(value, 'digest array', { max: 4096 }).map(stable);
  if (value && typeof value === 'object') {
    const source = plain(value, 'digest input');
    let keys;
    try { keys = Reflect.ownKeys(source); } catch (error) {
      inspectionFailed(error, 'digest input is invalid.');
    }
    if (keys.some(key => typeof key !== 'string')) fail('DELEGATION_ADAPTER_INVALID', 'digest input is invalid.');
    return Object.fromEntries(keys.sort().map(key => [key, stable(ownData(source, key, 'digest input'))]));
  }
  return value;
}

function digest(kind, value) {
  return crypto.createHash('sha256').update(`${HASH_DOMAIN}\0${kind}\0${JSON.stringify(stable(value))}`).digest('hex');
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const field of Object.values(value)) freeze(field);
    Object.freeze(value);
  }
  return value;
}

function normalizeManifest(value) {
  const source = closed(value,
    ['schemaVersion', 'adapterId', 'adapterVersion', 'supportedRoles', 'transport', 'parser', 'probe', 'process', 'output'],
    ['schemaVersion', 'adapterId', 'adapterVersion', 'supportedRoles', 'transport', 'parser', 'probe', 'process', 'output'],
    'manifest');
  if (ownData(source, 'schemaVersion', 'manifest') !== SCHEMA_VERSION) {
    fail('DELEGATION_ADAPTER_VERSION_UNSUPPORTED', 'manifest schema version is unsupported.');
  }

  const parser = closed(ownData(source, 'parser', 'manifest'), ['id', 'version'], ['id', 'version'], 'manifest.parser');
  const probe = closed(ownData(source, 'probe', 'manifest'), ['protocol', 'maxAgeMs'], ['protocol', 'maxAgeMs'], 'manifest.probe');
  const process = closed(ownData(source, 'process', 'manifest'), ['environment', 'ownership', 'cleanup'], ['environment', 'ownership', 'cleanup'], 'manifest.process');
  const output = closed(ownData(source, 'output', 'manifest'), ['eventSchema', 'resultContract', 'eventKinds'], ['eventSchema', 'resultContract', 'eventKinds'], 'manifest.output');

  if (ownData(source, 'transport', 'manifest') === undefined || !ALLOWED_TRANSPORTS.includes(ownData(source, 'transport', 'manifest'))) {
    fail('DELEGATION_ADAPTER_TRANSPORT_DENIED', 'manifest transport is not allowed.');
  }
  if (ownData(parser, 'version', 'manifest.parser') === undefined || !VERSION.test(ownData(parser, 'version', 'manifest.parser'))) {
    fail('DELEGATION_ADAPTER_INVALID', 'manifest parser version is invalid.');
  }
  if (ownData(probe, 'protocol', 'manifest.probe') !== 'provider-health/v1' ||
      ownData(process, 'environment', 'manifest.process') !== 'sanitized' ||
      ownData(process, 'ownership', 'manifest.process') !== 'adapter_owned_process_tree' ||
      ownData(process, 'cleanup', 'manifest.process') !== 'owned_process_tree_only' ||
      ownData(output, 'eventSchema', 'manifest.output') !== 'agent-event/v1' ||
      ownData(output, 'resultContract', 'manifest.output') !== 'delegation-contracts/v1') {
    fail('DELEGATION_ADAPTER_INVALID', 'manifest declares an unsupported lifecycle or result contract.');
  }

  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    adapterId: safeText(ownData(source, 'adapterId', 'manifest'), 'manifest.adapterId'),
    adapterVersion: safeText(ownData(source, 'adapterVersion', 'manifest'), 'manifest.adapterVersion', VERSION, { min: 5, max: 32 }),
    supportedRoles: sortedUnique(ownData(source, 'supportedRoles', 'manifest'), 'manifest.supportedRoles', delegationContracts.ROLES),
    transport: ownData(source, 'transport', 'manifest'),
    parser: Object.freeze({ id: safeText(ownData(parser, 'id', 'manifest.parser'), 'manifest.parser.id'), version: ownData(parser, 'version', 'manifest.parser') }),
    probe: Object.freeze({ protocol: 'provider-health/v1', maxAgeMs: integer(ownData(probe, 'maxAgeMs', 'manifest.probe'), 'manifest.probe.maxAgeMs', 1_000, 24 * 60 * 60 * 1_000) }),
    process: Object.freeze({ environment: 'sanitized', ownership: 'adapter_owned_process_tree', cleanup: 'owned_process_tree_only' }),
    output: Object.freeze({ eventSchema: 'agent-event/v1', resultContract: 'delegation-contracts/v1', eventKinds: sortedUnique(ownData(output, 'eventKinds', 'manifest.output'), 'manifest.output.eventKinds', EVENT_KINDS) })
  };
  return freeze({ ...normalized, manifestHash: digest('manifest', normalized) });
}

function validateAdapterInstance(value, expectedAdapterId) {
  const adapter = plain(value, 'adapter');
  const expected = ['descriptorId', ...REQUIRED_METHODS];
  let keys;
  try { keys = Reflect.ownKeys(adapter); } catch (error) {
    inspectionFailed(error, 'adapter must expose a closed interface.');
  }
  if (keys.length !== expected.length
      || keys.some(key => typeof key !== 'string' || !expected.includes(key))) {
    fail('DELEGATION_ADAPTER_INVALID', 'adapter has unsupported or missing interface members.');
  }
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(adapter, 'descriptorId'); } catch (error) {
    inspectionFailed(error, 'adapter descriptorId is invalid or does not match the manifest.');
  }
  if (!descriptor || descriptor.enumerable !== true
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.writable || descriptor.configurable ||
      safeText(descriptor.value, 'adapter.descriptorId') !== expectedAdapterId) {
    fail('DELEGATION_ADAPTER_INVALID', 'adapter descriptorId is invalid or does not match the manifest.');
  }
  for (const method of REQUIRED_METHODS) {
    let methodDescriptor;
    try { methodDescriptor = Object.getOwnPropertyDescriptor(adapter, method); } catch (error) {
      inspectionFailed(error, 'adapter is missing a required interface function.');
    }
    if (!methodDescriptor || methodDescriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(methodDescriptor, 'value')
        || typeof methodDescriptor.value !== 'function') {
      fail('DELEGATION_ADAPTER_INVALID', 'adapter is missing a required interface function.');
    }
  }
  // No function is invoked. This function deliberately does not inspect any
  // implementation body or provide an execution capability.
  return Object.freeze({ descriptorId: expectedAdapterId, methods: REQUIRED_METHODS });
}

function validateEventEnvelope(manifestInput, eventInput) {
  const manifest = normalizeManifest(manifestInput);
  const event = closed(eventInput, ['schemaVersion', 'adapterId', 'kind', 'sequence', 'payloadHash'], ['schemaVersion', 'adapterId', 'kind', 'sequence', 'payloadHash'], 'event');
  const normalized = {
    schemaVersion: ownData(event, 'schemaVersion', 'event'),
    adapterId: ownData(event, 'adapterId', 'event'),
    kind: ownData(event, 'kind', 'event'),
    sequence: ownData(event, 'sequence', 'event'),
    payloadHash: ownData(event, 'payloadHash', 'event')
  };
  if (normalized.schemaVersion !== 'agent-event/v1' || normalized.adapterId !== manifest.adapterId ||
      !manifest.output.eventKinds.includes(safeText(normalized.kind, 'event.kind')) ||
      !Number.isSafeInteger(normalized.sequence) || normalized.sequence < 0 ||
      !SHA256.test(normalized.payloadHash) || SENSITIVE.test(normalized.payloadHash)) {
    fail('DELEGATION_ADAPTER_INVALID', 'event envelope is invalid.');
  }
  return freeze(normalized);
}

function validateResultEnvelope(manifestInput, resultInput) {
  const manifest = normalizeManifest(manifestInput);
  const result = closed(resultInput, ['schemaVersion', 'adapterId', 'eventCursor', 'workerResult'], ['schemaVersion', 'adapterId', 'eventCursor', 'workerResult'], 'result');
  if (ownData(result, 'schemaVersion', 'result') !== 'agent-adapter-result/v1' ||
      ownData(result, 'adapterId', 'result') !== manifest.adapterId ||
      !SHA256.test(ownData(result, 'eventCursor', 'result')) || SENSITIVE.test(ownData(result, 'eventCursor', 'result'))) {
    fail('DELEGATION_ADAPTER_INVALID', 'result envelope is invalid.');
  }
  const workerResult = delegationContracts.validateWorkerResult(ownData(result, 'workerResult', 'result'));
  if (!RESULT_STATES.includes(workerResult.terminalState)) fail('DELEGATION_ADAPTER_INVALID', 'result terminal state is invalid.');
  return freeze({ schemaVersion: 'agent-adapter-result/v1', adapterId: manifest.adapterId, eventCursor: ownData(result, 'eventCursor', 'result'), workerResultHash: workerResult.contractHash, brokerAcceptanceState: 'UNACCEPTED' });
}

function validateAdapterRegistration(manifestInput, adapterInput) {
  const manifest = normalizeManifest(manifestInput);
  const adapter = validateAdapterInstance(adapterInput, manifest.adapterId);
  return freeze({
    schemaVersion: SCHEMA_VERSION,
    receiptKind: 'adapter_conformance_unaccepted',
    manifestHash: manifest.manifestHash,
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    interfaceMethods: adapter.methods,
    grantsAuthority: false,
    acceptanceState: 'UNACCEPTED',
    taskStateOwner: 'existing_canonical_task_service',
    adapterMayCreateTaskState: false,
    adapterMayMutateTaskState: false,
    adapterMayAcceptWork: false,
    adapterMaySelectFallback: false
  });
}

module.exports = Object.freeze({
  ALLOWED_TRANSPORTS,
  DelegationAdapterContractError,
  EVENT_KINDS,
  REQUIRED_METHODS,
  SCHEMA_VERSION,
  normalizeManifest,
  validateAdapterInstance,
  validateAdapterRegistration,
  validateEventEnvelope,
  validateResultEnvelope
});

'use strict';

// Transitional projection for readers that still poll the retired
// `agent-coord` memory board.  The dependency boundary is deliberate: this
// module receives a *read function* for the fabric and a write-capable legacy
// board.  It has no fabric writer, no legacy scan, and no method that accepts a
// legacy message for forwarding.  That makes legacy -> fabric forwarding
// impossible through this adapter rather than merely discouraged by callers.

const crypto = require('node:crypto');
const { containsSensitiveMaterial } = require('../providers/sensitive-local-input');

const BRIDGE_VERSION = 1;
const LEGACY_NAMESPACE = 'agent-coord';
const DIRECTION = 'fabric-to-legacy-readers';
const LEGACY_TAGS = Object.freeze(['agent-comms', 'compat', 'fabric-to-legacy']);
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CHANNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHANNEL_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;
const KINDS = new Set(['ask', 'answer', 'notice']);

class CompatBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CompatBridgeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CompatBridgeError(code, message);
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
}

function plainObject(value, code, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(code, `${label} may only contain string keys.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(code, `${label} may not contain accessors.`);
    }
  }
  return value;
}

function exactKeys(value, expected, code, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${label} fields are invalid.`);
  }
}

function identifier(value, label, code = 'COMPAT_BRIDGE_FABRIC_RECORD_INVALID') {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function nonNegativeInteger(value, label, { minimum = 0, code = 'COMPAT_BRIDGE_FABRIC_RECORD_INVALID' } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function normalizeIdentity(value, code = 'COMPAT_BRIDGE_FABRIC_RECORD_INVALID') {
  const source = plainObject(value, code, 'agent identity');
  exactKeys(source, ['agentId', 'machineId'], code, 'agent identity');
  return Object.freeze({
    agentId: identifier(source.agentId, 'agentId', code),
    machineId: identifier(source.machineId, 'machineId', code)
  });
}

function normalizeAudience(value) {
  const source = plainObject(value, 'COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'message audience');
  if (source.type === 'direct') {
    exactKeys(source, ['agent', 'type'], 'COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'direct audience');
    return Object.freeze({ type: 'direct', agent: normalizeIdentity(source.agent) });
  }
  if (source.type === 'channel') {
    exactKeys(source, ['name', 'type'], 'COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'channel audience');
    if (typeof source.name !== 'string' || !CHANNEL_NAME_RE.test(source.name)) {
      fail('COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'channel audience name is invalid.');
    }
    return Object.freeze({ type: 'channel', name: source.name });
  }
  fail('COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'message audience type is invalid.');
}

function normalizeMessage(value) {
  const source = plainObject(value, 'COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'fabric message');
  exactKeys(source, ['audience', 'body', 'causalParent', 'id', 'issuedAt', 'kind', 'sender', 'sequence'], 'COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'fabric message');
  if (typeof source.id !== 'string' || source.id.length < 1 || source.id.length > 512 || source.id.includes('\0')) {
    fail('COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'fabric message id is invalid.');
  }
  if (typeof source.body !== 'string' || source.body.length < 1 || source.body.length > 4_000 || source.body.includes('\0')) {
    fail('COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'fabric message body is invalid.');
  }
  if (source.causalParent !== null && (typeof source.causalParent !== 'string' || source.causalParent.length < 1 || source.causalParent.length > 512)) {
    fail('COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'fabric message causal parent is invalid.');
  }
  if (!KINDS.has(source.kind)) fail('COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'fabric message kind is invalid.');
  return Object.freeze({
    id: source.id,
    sender: normalizeIdentity(source.sender),
    audience: normalizeAudience(source.audience),
    sequence: nonNegativeInteger(source.sequence, 'fabric message sequence', { minimum: 1 }),
    causalParent: source.causalParent,
    kind: source.kind,
    body: source.body,
    issuedAt: nonNegativeInteger(source.issuedAt, 'fabric message issuedAt')
  });
}

function normalizeRecord(value) {
  const source = plainObject(value, 'COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'fabric history record');
  if (!Object.hasOwn(source, 'sequence') || !Object.hasOwn(source, 'message')) {
    fail('COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'fabric history record is missing required fields.');
  }
  return Object.freeze({
    historySequence: nonNegativeInteger(source.sequence, 'fabric history sequence', { minimum: 1 }),
    message: normalizeMessage(source.message)
  });
}

function normalizeReadResult(value) {
  const source = plainObject(value, 'COMPAT_BRIDGE_FABRIC_READ_INVALID', 'fabric history result');
  if (!Array.isArray(source.records)) fail('COMPAT_BRIDGE_FABRIC_READ_INVALID', 'fabric history result records are invalid.');
  return source.records.map(normalizeRecord);
}

function sourceFingerprint(channelId, record) {
  const representation = JSON.stringify({
    channelId,
    historySequence: record.historySequence,
    message: record.message
  });
  return crypto.createHash('sha256')
    .update('toolsenabled.agent-comms.compat-bridge.v1\0', 'utf8')
    .update(representation, 'utf8')
    .digest('hex');
}

function legacyKey(recipientAgentId, fingerprint) {
  return `message/${recipientAgentId}/compat-${fingerprint}`;
}

function bridgeValue({ channelId, record, recipient, fingerprint, carriedAtMs }) {
  const message = record.message;
  return freeze({
    schemaVersion: BRIDGE_VERSION,
    bridge: {
      direction: DIRECTION,
      source: 'agent-comms',
      channelId,
      historySequence: record.historySequence,
      messageId: message.id,
      fingerprint
    },
    recipient: { agentId: recipient.agentId, machineId: recipient.machineId },
    sender: { agentId: message.sender.agentId, machineId: message.sender.machineId },
    audience: message.audience.type === 'direct'
      ? { type: 'direct', agent: { agentId: message.audience.agent.agentId, machineId: message.audience.agent.machineId } }
      : { type: 'channel', name: message.audience.name },
    kind: message.kind,
    body: message.body,
    causalParent: message.causalParent,
    issuedAt: message.issuedAt,
    carriedAtMs
  });
}

function isMatchingProjection(entry, fingerprint) {
  if (!entry || typeof entry !== 'object' || !entry.value || typeof entry.value !== 'object') return false;
  const bridge = entry.value.bridge;
  return Boolean(bridge
    && typeof bridge === 'object'
    && bridge.direction === DIRECTION
    && bridge.source === 'agent-comms'
    && bridge.fingerprint === fingerprint);
}

function legacyEntry(legacyBoard, key) {
  try {
    return legacyBoard.getMemory({ namespace: LEGACY_NAMESPACE, key });
  } catch {
    fail('COMPAT_BRIDGE_LEGACY_READ_FAILED', 'The legacy board could not be read.');
  }
}

function createCompatBridge({
  readFabric,
  legacyBoard,
  channelMembers = null,
  sensitiveDetector = containsSensitiveMaterial,
  now = Date.now
} = {}) {
  if (typeof readFabric !== 'function'
    || !legacyBoard || typeof legacyBoard.getMemory !== 'function' || typeof legacyBoard.setMemory !== 'function'
    || (channelMembers !== null && typeof channelMembers !== 'function')
    || typeof sensitiveDetector !== 'function'
    || typeof now !== 'function') {
    fail('COMPAT_BRIDGE_CONFIGURATION_INVALID', 'A fabric read function, legacy memory adapter, detector, and clock are required.');
  }

  function currentTime() {
    return nonNegativeInteger(now(), 'clock result', { code: 'COMPAT_BRIDGE_CLOCK_INVALID' });
  }

  function recipientsFor(message) {
    if (message.audience.type === 'direct') return [message.audience.agent];
    if (!channelMembers) {
      fail('COMPAT_BRIDGE_CHANNEL_RESOLVER_REQUIRED', 'A channel membership resolver is required to project a channel message to old readers.');
    }
    let members;
    try { members = channelMembers({ channelId: message.audience.name }); }
    catch { fail('COMPAT_BRIDGE_CHANNEL_RESOLUTION_FAILED', 'Channel membership could not be resolved.'); }
    if (!Array.isArray(members)) {
      fail('COMPAT_BRIDGE_CHANNEL_RESOLUTION_FAILED', 'Channel membership resolver returned an invalid result.');
    }
    const recipients = members.map(member => normalizeIdentity(member, 'COMPAT_BRIDGE_CHANNEL_RESOLUTION_FAILED'));
    const byLegacyAgentId = new Map();
    for (const recipient of recipients) {
      const existing = byLegacyAgentId.get(recipient.agentId);
      if (existing && existing.machineId !== recipient.machineId) {
        fail('COMPAT_BRIDGE_LEGACY_RECIPIENT_AMBIGUOUS', 'Legacy board recipient identity is ambiguous across machines.');
      }
      byLegacyAgentId.set(recipient.agentId, recipient);
    }
    return [...byLegacyAgentId.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  function planProjection(channelId, records) {
    const carriedAtMs = currentTime();
    const plannedKeys = new Set();
    const plans = [];
    for (const record of records) {
      let sensitive;
      try { sensitive = sensitiveDetector(record.message.body); }
      catch { fail('COMPAT_BRIDGE_SENSITIVE_DETECTOR_FAILED', 'The credential detector failed.'); }
      if (typeof sensitive !== 'boolean') {
        fail('COMPAT_BRIDGE_SENSITIVE_DETECTOR_FAILED', 'The credential detector returned an invalid result.');
      }
      if (sensitive) {
        fail('COMPAT_BRIDGE_CREDENTIAL_SHAPED', 'Credential-shaped content cannot be carried to the legacy board.');
      }
      const fingerprint = sourceFingerprint(channelId, record);
      for (const recipient of recipientsFor(record.message)) {
        const key = legacyKey(recipient.agentId, fingerprint);
        if (plannedKeys.has(key)) {
          fail('COMPAT_BRIDGE_FABRIC_RECORD_INVALID', 'Fabric history contains a duplicate projected record.');
        }
        plannedKeys.add(key);
        plans.push(Object.freeze({
          key,
          fingerprint,
          messageId: record.message.id,
          recipient,
          value: bridgeValue({ channelId, record, recipient, fingerprint, carriedAtMs })
        }));
      }
    }
    return plans;
  }

  function writeProjection(plan) {
    try {
      legacyBoard.setMemory({
        namespace: LEGACY_NAMESPACE,
        key: plan.key,
        value: plan.value,
        note: 'One-way agent-comms compatibility projection for legacy readers.',
        tags: LEGACY_TAGS,
        expectedRevision: 0
      });
      return 'CARRIED';
    } catch (error) {
      if (error && error.code === 'MEMORY_REVISION_CONFLICT') {
        const concurrent = legacyEntry(legacyBoard, plan.key);
        if (isMatchingProjection(concurrent, plan.fingerprint)) return 'ALREADY_CARRIED';
        fail('COMPAT_BRIDGE_LEGACY_KEY_COLLISION', 'A legacy entry occupies the compatibility projection key.');
      }
      fail('COMPAT_BRIDGE_LEGACY_WRITE_FAILED', 'The legacy board could not persist the compatibility projection.');
    }
  }

  // `carry` is intentionally the only operational method.  It first validates
  // every fabric record (including sensitivity and channel resolution) before
  // writing anything, so a refused credential-shaped record cannot leave a
  // partial projection batch behind.
  function carry({ channelId, afterSequence = 0 } = {}) {
    if (typeof channelId !== 'string' || !CHANNEL_ID_RE.test(channelId)) {
      fail('COMPAT_BRIDGE_ARGUMENT_INVALID', 'channelId is invalid.');
    }
    nonNegativeInteger(afterSequence, 'afterSequence', { code: 'COMPAT_BRIDGE_ARGUMENT_INVALID' });
    let read;
    try { read = readFabric({ channelId, afterSequence }); }
    catch { fail('COMPAT_BRIDGE_FABRIC_READ_FAILED', 'Fabric history could not be read.'); }
    if (read && typeof read.then === 'function') {
      fail('COMPAT_BRIDGE_FABRIC_READ_INVALID', 'Compatibility bridge requires a synchronous, dependency-injected fabric read.');
    }
    const records = normalizeReadResult(read);
    const plans = planProjection(channelId, records);

    const carried = [];
    const alreadyCarried = [];
    for (const plan of plans) {
      const existing = legacyEntry(legacyBoard, plan.key);
      if (existing) {
        if (!isMatchingProjection(existing, plan.fingerprint)) {
          fail('COMPAT_BRIDGE_LEGACY_KEY_COLLISION', 'A legacy entry occupies the compatibility projection key.');
        }
        alreadyCarried.push({ key: plan.key, messageId: plan.messageId, recipientAgentId: plan.recipient.agentId });
        continue;
      }
      const outcome = writeProjection(plan);
      const summary = { key: plan.key, messageId: plan.messageId, recipientAgentId: plan.recipient.agentId };
      if (outcome === 'CARRIED') carried.push(summary);
      else alreadyCarried.push(summary);
    }

    return freeze({
      channelId,
      direction: DIRECTION,
      recordsRead: records.length,
      carried,
      alreadyCarried
    });
  }

  return Object.freeze({ carry });
}

module.exports = Object.freeze({
  BRIDGE_VERSION,
  CompatBridgeError,
  DIRECTION,
  LEGACY_NAMESPACE,
  LEGACY_TAGS,
  createCompatBridge
});

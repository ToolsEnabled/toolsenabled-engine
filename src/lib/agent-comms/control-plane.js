'use strict';

// Durable named-channel and owner-designation control state for the agent
// communications fabric. Message bodies never enter this record; they live in
// history.js. The StateStore memory adapter supplies revisioned SQLite writes,
// so channel membership and revocation survive process/session boundaries.

const SCHEMA_VERSION = 1;
const DEFAULT_NAMESPACE = 'agent-comms-control';
const CONTROL_KEY = 'directory';
const OWNER_CHANNEL = 'owner-special';
const DEFAULT_MAX_CHANNELS = 128;
const DEFAULT_MAX_MEMBERSHIPS = 2_048;
const DEFAULT_MAX_DESIGNATION_EVENTS = 512;
const DEFAULT_MAX_WRITE_RETRIES = 8;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CHANNEL_RE = /^[a-z][a-z0-9-]{0,47}$/;

class ControlPlaneError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'ControlPlaneError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details, cause) {
  throw new ControlPlaneError(code, message, details, cause ? { cause } : {});
}

function plainObject(value, label, code = 'AGENT_COMMS_CONTROL_ARGUMENT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be a plain data object.`, { field: label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain data object.`, { field: label });
  }
  return value;
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}, code = 'AGENT_COMMS_CONTROL_ARGUMENT_INVALID') {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(code, `${label} must be a safe integer in range.`, { field: label, min, max });
  }
  return value;
}

function agentId(value, label = 'agentId', code = 'AGENT_COMMS_CONTROL_ARGUMENT_INVALID') {
  if (typeof value !== 'string' || !AGENT_RE.test(value)) {
    fail(code, `${label} is invalid.`, { field: label });
  }
  return value;
}

function channelName(value, label = 'channel', code = 'AGENT_COMMS_CONTROL_ARGUMENT_INVALID') {
  if (typeof value !== 'string' || !CHANNEL_RE.test(value)) {
    fail(code, `${label} is invalid.`, { field: label });
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutable(value) {
  return deepFreeze(clone(value));
}

function emptyState(createdAtMs) {
  return {
    schemaVersion: SCHEMA_VERSION,
    nextDesignationSequence: 1,
    channels: [{
      name: OWNER_CHANNEL,
      createdAtMs,
      createdBy: 'owner',
      ownerSpecial: true,
      members: []
    }],
    designationEvents: []
  };
}

function validateChannel(value, index, code = 'AGENT_COMMS_CONTROL_STATE_CORRUPT') {
  const source = plainObject(value, `channels[${index}]`, code);
  const keys = Object.keys(source).sort();
  const expected = ['createdAtMs', 'createdBy', 'members', 'name', 'ownerSpecial'];
  if (keys.length !== expected.length || keys.some((key, position) => key !== expected[position])) {
    fail(code, 'Stored channel fields are invalid.', { index });
  }
  const name = channelName(source.name, `channels[${index}].name`, code);
  const ownerSpecial = source.ownerSpecial === true;
  if (typeof source.ownerSpecial !== 'boolean' || ownerSpecial !== (name === OWNER_CHANNEL)) {
    fail(code, 'Stored owner-channel designation is invalid.', { channel: name });
  }
  safeInteger(source.createdAtMs, `channels[${index}].createdAtMs`, {}, code);
  agentId(source.createdBy, `channels[${index}].createdBy`, code);
  if (!Array.isArray(source.members)) fail(code, 'Stored channel members are invalid.', { channel: name });
  const members = source.members.map((member, memberIndex) => agentId(member, `channels[${index}].members[${memberIndex}]`, code));
  /* 'en' IS PINNED ON EVERY SORT AND ON THIS CHECK, and the pin is the point:
   * localeCompare with no locale collates in the HOST's locale, so durable
   * state written on one machine could be declared CORRUPT when read on a
   * machine whose locale (or ICU) orders `_` and `-` differently. A validator
   * and its writers must share one collation that no machine setting can move. */
  if (new Set(members).size !== members.length || members.some((member, memberIndex) => memberIndex > 0 && members[memberIndex - 1].localeCompare(member, 'en') >= 0)) {
    fail(code, 'Stored channel members must be unique and sorted.', { channel: name });
  }
  return { name, createdAtMs: source.createdAtMs, createdBy: source.createdBy, ownerSpecial, members };
}

function validateDesignationEvent(value, index, priorSequence, code = 'AGENT_COMMS_CONTROL_STATE_CORRUPT') {
  const source = plainObject(value, `designationEvents[${index}]`, code);
  const keys = Object.keys(source).sort();
  const expected = ['action', 'actorId', 'agentId', 'atMs', 'sequence'];
  if (keys.length !== expected.length || keys.some((key, position) => key !== expected[position])) {
    fail(code, 'Stored designation event fields are invalid.', { index });
  }
  const sequence = safeInteger(source.sequence, `designationEvents[${index}].sequence`, { min: 1 }, code);
  if (sequence !== priorSequence + 1) fail(code, 'Stored designation events are not contiguous.', { index, sequence });
  if (!['DESIGNATED', 'REVOKED'].includes(source.action)) fail(code, 'Stored designation action is invalid.', { index });
  return {
    sequence,
    action: source.action,
    agentId: agentId(source.agentId, `designationEvents[${index}].agentId`, code),
    actorId: agentId(source.actorId, `designationEvents[${index}].actorId`, code),
    atMs: safeInteger(source.atMs, `designationEvents[${index}].atMs`, {}, code)
  };
}

function validateState(value, limits) {
  const source = plainObject(value, 'stored control plane', 'AGENT_COMMS_CONTROL_STATE_CORRUPT');
  if (source.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(source.channels)
    || !Array.isArray(source.designationEvents)
    || !Number.isSafeInteger(source.nextDesignationSequence)
    || source.nextDesignationSequence < 1) {
    fail('AGENT_COMMS_CONTROL_STATE_CORRUPT', 'Stored control plane has an invalid shape.');
  }
  if (source.channels.length < 1 || source.channels.length > limits.maxChannels) {
    fail('AGENT_COMMS_CONTROL_STATE_CORRUPT', 'Stored channel count exceeds its bound.');
  }
  if (source.designationEvents.length > limits.maxDesignationEvents) {
    fail('AGENT_COMMS_CONTROL_STATE_CORRUPT', 'Stored designation history exceeds its bound.');
  }
  const channels = source.channels.map((channel, index) => validateChannel(channel, index));
  if (new Set(channels.map(channel => channel.name)).size !== channels.length
    || channels.filter(channel => channel.ownerSpecial).length !== 1) {
    fail('AGENT_COMMS_CONTROL_STATE_CORRUPT', 'Stored channels do not contain exactly one unique owner channel.');
  }
  const memberships = channels.reduce((total, channel) => total + channel.members.length, 0);
  if (memberships > limits.maxMemberships) {
    fail('AGENT_COMMS_CONTROL_STATE_CORRUPT', 'Stored channel membership count exceeds its bound.');
  }
  let priorSequence = 0;
  const designationEvents = source.designationEvents.map((event, index) => {
    const normalized = validateDesignationEvent(event, index, priorSequence);
    priorSequence = normalized.sequence;
    return normalized;
  });
  if (source.nextDesignationSequence !== priorSequence + 1) {
    fail('AGENT_COMMS_CONTROL_STATE_CORRUPT', 'Stored designation sequence head is invalid.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    nextDesignationSequence: source.nextDesignationSequence,
    channels,
    designationEvents
  };
}

function activeDesignations(state) {
  const active = new Set();
  for (const event of state.designationEvents) {
    if (event.action === 'DESIGNATED') active.add(event.agentId);
    else active.delete(event.agentId);
  }
  return [...active].sort((left, right) => left.localeCompare(right, 'en'));
}

function ownerActor(value) {
  const source = plainObject(value, 'owner actor', 'OWNER_ACTOR_REQUIRED');
  if (source.actorKind !== 'owner' || source.actorId !== 'owner') {
    fail('OWNER_ACTOR_REQUIRED', 'Owner designation changes require the transport-bound owner actor.');
  }
  return Object.freeze({ actorKind: 'owner', actorId: 'owner' });
}

function createControlPlane({
  store,
  namespace = DEFAULT_NAMESPACE,
  maxChannels = DEFAULT_MAX_CHANNELS,
  maxMemberships = DEFAULT_MAX_MEMBERSHIPS,
  maxDesignationEvents = DEFAULT_MAX_DESIGNATION_EVENTS,
  maxWriteRetries = DEFAULT_MAX_WRITE_RETRIES,
  now = Date.now
} = {}) {
  if (!store || typeof store.getMemory !== 'function' || typeof store.setMemory !== 'function' || typeof now !== 'function') {
    fail('AGENT_COMMS_CONTROL_CONFIGURATION_INVALID', 'A revisioned StateStore-compatible adapter and clock are required.');
  }
  channelName(namespace, 'namespace', 'AGENT_COMMS_CONTROL_CONFIGURATION_INVALID');
  const limits = {
    maxChannels: safeInteger(maxChannels, 'maxChannels', { min: 1, max: 1_000 }, 'AGENT_COMMS_CONTROL_CONFIGURATION_INVALID'),
    maxMemberships: safeInteger(maxMemberships, 'maxMemberships', { min: 1, max: 100_000 }, 'AGENT_COMMS_CONTROL_CONFIGURATION_INVALID'),
    maxDesignationEvents: safeInteger(maxDesignationEvents, 'maxDesignationEvents', { min: 1, max: 10_000 }, 'AGENT_COMMS_CONTROL_CONFIGURATION_INVALID')
  };
  safeInteger(maxWriteRetries, 'maxWriteRetries', { min: 1, max: 100 }, 'AGENT_COMMS_CONTROL_CONFIGURATION_INVALID');

  function currentTime() {
    return safeInteger(now(), 'clock result', {}, 'AGENT_COMMS_CONTROL_CLOCK_INVALID');
  }

  function entry() {
    let value;
    try { value = store.getMemory({ namespace, key: CONTROL_KEY }); }
    catch (error) { fail('AGENT_COMMS_CONTROL_READ_FAILED', 'Durable control state could not be read.', {}, error); }
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Object.hasOwn(value, 'value')) {
      fail('AGENT_COMMS_CONTROL_STORAGE_INVALID', 'Durable control storage returned an invalid entry.');
    }
    return value;
  }

  function readState() {
    const stored = entry();
    return stored ? validateState(stored.value, limits) : emptyState(currentTime());
  }

  function mutate(work) {
    for (let attempt = 1; attempt <= maxWriteRetries; attempt += 1) {
      const prior = entry();
      const state = prior ? validateState(prior.value, limits) : emptyState(currentTime());
      const outcome = work(state);
      validateState(state, limits);
      // Idempotent designation refusals are observations, not state changes.
      // Do not manufacture a durable revision for an operation that reports
      // that it changed nothing.
      if (outcome && outcome.changed === false) return immutable(outcome);
      try {
        const saved = store.setMemory({
          namespace,
          key: CONTROL_KEY,
          value: state,
          tags: ['agent-comms', 'control'],
          expectedRevision: prior ? prior.revision : 0
        });
        const savedEntry = saved && typeof saved === 'object' ? saved.entry : null;
        const minimumRevision = prior ? prior.revision : 1;
        if (!savedEntry || typeof savedEntry !== 'object'
          || !Number.isSafeInteger(savedEntry.revision)
          || savedEntry.revision < minimumRevision
          || savedEntry.revision > minimumRevision + (prior ? 1 : 0)
          || !Object.hasOwn(savedEntry, 'value')
          || JSON.stringify(validateState(savedEntry.value, limits)) !== JSON.stringify(state)) {
          fail('AGENT_COMMS_CONTROL_WRITE_FAILED', 'Durable control storage did not acknowledge the requested state.');
        }
        return immutable(outcome);
      } catch (error) {
        const conflict = error && error.code === 'MEMORY_REVISION_CONFLICT';
        if (conflict && attempt < maxWriteRetries) continue;
        if (conflict) {
          fail('AGENT_COMMS_CONTROL_CONCURRENCY_RETRY_EXHAUSTED', 'Concurrent control writers exhausted the retry budget.', { attempts: maxWriteRetries }, error);
        }
        fail('AGENT_COMMS_CONTROL_WRITE_FAILED', 'Durable control state could not be written.', {}, error);
      }
    }
    fail('AGENT_COMMS_CONTROL_CONCURRENCY_RETRY_EXHAUSTED', 'Concurrent control writers exhausted the retry budget.', { attempts: maxWriteRetries });
  }

  function snapshot() {
    const state = readState();
    const designatedAgentIds = activeDesignations(state);
    const channels = state.channels
      .map(channel => channel.ownerSpecial ? { ...channel, members: designatedAgentIds } : channel)
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    return immutable({
      schemaVersion: SCHEMA_VERSION,
      ownerChannel: OWNER_CHANNEL,
      channels,
      designations: {
        activeAgentIds: designatedAgentIds,
        events: state.designationEvents
      }
    });
  }

  function createChannel(input) {
    const source = plainObject(input, 'create channel input');
    const name = channelName(source.name);
    const actorId = agentId(source.actorId);
    if (name === OWNER_CHANNEL) fail('OWNER_CHANNEL_MANAGED', 'The special owner channel is created and governed only by designation records.');
    return mutate(state => {
      if (state.channels.some(channel => channel.name === name)) {
        fail('AGENT_CHANNEL_EXISTS', 'Channel already exists.', { channel: name });
      }
      if (state.channels.length >= limits.maxChannels) {
        fail('AGENT_COMMS_CONTROL_CAPACITY', 'Channel capacity is exhausted.', { maximum: limits.maxChannels });
      }
      const channel = { name, createdAtMs: currentTime(), createdBy: actorId, ownerSpecial: false, members: [] };
      state.channels.push(channel);
      state.channels.sort((left, right) => left.name.localeCompare(right.name, 'en'));
      return { created: true, channel };
    });
  }

  function membership(input, action) {
    const source = plainObject(input, `${action.toLowerCase()} channel input`);
    const name = channelName(source.channel);
    const member = agentId(source.agentId);
    if (name === OWNER_CHANNEL) fail('OWNER_CHANNEL_MANAGED', 'Owner-channel access changes only through designate/revoke.');
    return mutate(state => {
      const channel = state.channels.find(candidate => candidate.name === name);
      if (!channel) fail('AGENT_CHANNEL_UNKNOWN', 'Channel is unknown.', { channel: name });
      const index = channel.members.indexOf(member);
      if (action === 'JOIN') {
        if (index >= 0) return { joined: false, channel: name, agentId: member };
        const memberships = state.channels.reduce((total, candidate) => total + candidate.members.length, 0);
        if (memberships >= limits.maxMemberships) {
          fail('AGENT_COMMS_CONTROL_CAPACITY', 'Channel membership capacity is exhausted.', { maximum: limits.maxMemberships });
        }
        channel.members.push(member);
        channel.members.sort((left, right) => left.localeCompare(right, 'en'));
        return { joined: true, channel: name, agentId: member };
      }
      if (index < 0) return { left: false, channel: name, agentId: member };
      channel.members.splice(index, 1);
      return { left: true, channel: name, agentId: member };
    });
  }

  function appendDesignation(input, action) {
    const source = plainObject(input, `${action.toLowerCase()} input`);
    const actor = ownerActor(source.actor);
    const target = agentId(source.agentId);
    if (target === 'owner') fail('OWNER_CHANNEL_DESIGNATION_INVALID', 'The owner identity is structurally authorized and cannot be designated or revoked.');
    return mutate(state => {
      const active = new Set(activeDesignations(state));
      const desired = action === 'DESIGNATED';
      if (active.has(target) === desired) {
        return {
          changed: false,
          active: desired,
          agentId: target,
          code: desired ? 'OWNER_CHANNEL_ALREADY_DESIGNATED' : 'OWNER_CHANNEL_ALREADY_REVOKED'
        };
      }
      if (state.designationEvents.length >= limits.maxDesignationEvents) {
        fail('AGENT_COMMS_CONTROL_CAPACITY', 'Designation event capacity is exhausted; refusing to discard owner authorization history.', {
          maximum: limits.maxDesignationEvents
        });
      }
      const event = {
        sequence: state.nextDesignationSequence,
        action,
        agentId: target,
        actorId: actor.actorId,
        atMs: currentTime()
      };
      state.nextDesignationSequence += 1;
      state.designationEvents.push(event);
      return {
        changed: true,
        active: desired,
        agentId: target,
        code: desired ? 'OWNER_CHANNEL_DESIGNATED' : 'OWNER_CHANNEL_REVOKED',
        event
      };
    });
  }

  function isDesignated(value) {
    const target = agentId(value);
    return activeDesignations(readState()).includes(target);
  }

  function assertAccess(input) {
    const source = plainObject(input, 'channel access input');
    const name = channelName(source.channel);
    const actor = agentId(source.agentId);
    const state = readState();
    const channel = state.channels.find(candidate => candidate.name === name);
    if (!channel) fail('AGENT_CHANNEL_UNKNOWN', 'Channel is unknown.', { channel: name });
    if (channel.ownerSpecial) {
      if (actor !== 'owner' && !activeDesignations(state).includes(actor)) {
        fail('OWNER_CHANNEL_NOT_DESIGNATED', 'Agent is not currently designated for the special owner channel.', { agentId: actor });
      }
      return immutable({ channel: name, agentId: actor, ownerSpecial: true, allowed: true });
    }
    if (!channel.members.includes(actor)) {
      fail('AGENT_MESSAGE_CHANNEL_MEMBERSHIP_REQUIRED', 'Agent is not a channel member.', { channel: name, agentId: actor });
    }
    return immutable({ channel: name, agentId: actor, ownerSpecial: false, allowed: true });
  }

  return Object.freeze({
    assertAccess,
    createChannel,
    designate(input) { return appendDesignation(input, 'DESIGNATED'); },
    isDesignated,
    join(input) { return membership(input, 'JOIN'); },
    leave(input) { return membership(input, 'LEAVE'); },
    revoke(input) { return appendDesignation(input, 'REVOKED'); },
    snapshot
  });
}

module.exports = Object.freeze({
  CONTROL_KEY,
  ControlPlaneError,
  DEFAULT_NAMESPACE,
  OWNER_CHANNEL,
  SCHEMA_VERSION,
  createControlPlane
});

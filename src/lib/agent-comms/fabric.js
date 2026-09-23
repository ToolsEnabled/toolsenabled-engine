'use strict';

// Composition root for the Q90 agent communications modules.  This file owns
// adapters and operation ordering only; validation, lifecycle transitions,
// durable history, routing, wake decisions, and home-node rules stay in their
// respective modules.

const crypto = require('node:crypto');

const { createChannelContract } = require('./channel-contract');
const { STATES, createDeliveryLifecycle } = require('./delivery');
const { createHistory } = require('./history');
const { createBroker, ROUTES } = require('./broker');
const { createClaims } = require('./claims');
const homeNodes = require('./home-node');
const { createPositionedReader } = require('./read-position');
const { createCompatBridge } = require('./compat-bridge');
const { createControlPlane, OWNER_CHANNEL } = require('./control-plane');

// channel-contract bounds bodies by JavaScript characters, while history
// bounds the JSON-encoded envelope by bytes.  28 KiB accommodates the default
// 4000-character body even when every character needs a six-byte JSON escape,
// plus the bounded envelope metadata.
const DEFAULT_HISTORY_MESSAGE_BYTES = 28 * 1024;
const DEFAULT_HISTORY_CHANNEL_BYTES = 32 * 1024;
const TRACKED_KINDS = new Set(['ask', 'answer']);
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OWNER_JOURNAL_STREAM = 'owner.journal';
const OWNER_PROJECTION_VERSION = 1;

class AgentCommsFabricError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentCommsFabricError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

class TruncatedRead extends Error {
  constructor(snapshot) {
    super('History cursor is behind the retention floor.');
    this.snapshot = snapshot;
  }
}

function fail(code, message, details) {
  throw new AgentCommsFabricError(code, message, details);
}

function plainObject(value, label, code = 'FABRIC_ARGUMENT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be a plain object.`, { field: label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain object.`, { field: label });
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(code, `${label} may only contain string keys.`, { field: label });
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(code, `${label} may not contain accessors.`, { field: label });
    }
  }
  return value;
}

function exactKeys(value, required, optional, label, code = 'FABRIC_ARGUMENT_INVALID') {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(code, `${label} requires ${key}.`, { field: key });
  }
  if (Object.keys(value).some(key => !allowed.has(key))) {
    fail(code, `${label} contains an unsupported field.`, { field: label });
  }
}

function identifier(value, label, code = 'FABRIC_ARGUMENT_INVALID') {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    fail(code, `${label} is invalid.`, { field: label });
  }
  return value;
}

function nonNegativeInteger(value, label, code = 'FABRIC_ARGUMENT_INVALID') {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, `${label} must be a non-negative safe integer.`, { field: label });
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function identityKey(identity) {
  return `${identity.machineId}\u0000${identity.agentId}`;
}

function sameIdentity(left, right) {
  return left.agentId === right.agentId && left.machineId === right.machineId;
}

function normalizeAgents(value) {
  if (!Array.isArray(value) || value.length < 1) {
    fail('FABRIC_CONFIGURATION_INVALID', 'agents must be a non-empty array.');
  }
  const identities = new Set();
  const agentIds = new Set();
  return Object.freeze(value.map((entry, index) => {
    const source = plainObject(entry, `agents[${index}]`, 'FABRIC_CONFIGURATION_INVALID');
    exactKeys(source, ['agentId', 'machineId', 'route', 'sessionId'], [], `agents[${index}]`, 'FABRIC_CONFIGURATION_INVALID');
    const agent = {
      agentId: identifier(source.agentId, `agents[${index}].agentId`, 'FABRIC_CONFIGURATION_INVALID'),
      machineId: identifier(source.machineId, `agents[${index}].machineId`, 'FABRIC_CONFIGURATION_INVALID'),
      sessionId: identifier(source.sessionId, `agents[${index}].sessionId`, 'FABRIC_CONFIGURATION_INVALID'),
      route: source.route
    };
    if (!Object.values(ROUTES).includes(agent.route)) {
      fail('FABRIC_CONFIGURATION_INVALID', `agents[${index}].route is invalid.`);
    }
    if (identities.has(identityKey(agent))) {
      fail('FABRIC_CONFIGURATION_INVALID', 'agent identities must be unique.');
    }
    // delivery.js, broker.js, and history.js identify an agent by agentId,
    // while channel-contract.js identifies it by machineId + agentId. Refuse
    // the ambiguous superset at the composition boundary.
    if (agentIds.has(agent.agentId)) {
      fail('FABRIC_AGENT_ID_AMBIGUOUS', 'agentId must be globally unique across configured machines.');
    }
    identities.add(identityKey(agent));
    agentIds.add(agent.agentId);
    return Object.freeze(agent);
  }));
}

function directAudience(identity) {
  return Object.freeze({
    type: 'direct',
    agent: Object.freeze({ agentId: identity.agentId, machineId: identity.machineId })
  });
}

function streamIdForAudience(audience) {
  const source = plainObject(audience, 'audience');
  if (source.type === 'channel') {
    exactKeys(source, ['name', 'type'], [], 'audience');
    if (typeof source.name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(source.name)) {
      fail('FABRIC_ARGUMENT_INVALID', 'channel audience name is invalid.');
    }
    return source.name;
  }
  if (source.type !== 'direct') fail('FABRIC_ARGUMENT_INVALID', 'audience type is invalid.');
  exactKeys(source, ['agent', 'type'], [], 'audience');
  const agent = plainObject(source.agent, 'audience.agent');
  exactKeys(agent, ['agentId', 'machineId'], [], 'audience.agent');
  const agentId = identifier(agent.agentId, 'audience.agent.agentId');
  const machineId = identifier(agent.machineId, 'audience.agent.machineId');
  const digest = crypto.createHash('sha256')
    .update(`${machineId}\u0000${agentId}`, 'utf8')
    .digest('hex');
  return `direct.${digest}`;
}

function deliveryEnvelope(message) {
  return Object.freeze({
    messageId: message.id,
    kind: message.kind.toUpperCase(),
    senderId: message.sender.agentId,
    recipientId: message.audience.agent.agentId,
    causalParentId: message.causalParent
  });
}

function resolvePort(port) {
  if (port === null || port === undefined) return null;
  if (typeof port === 'function') return port;
  if (port && typeof port.deliver === 'function') return port.deliver.bind(port);
  fail('FABRIC_CONFIGURATION_INVALID', 'homeDeliveryPort must be a function or expose deliver().');
}

function resolveInboundTransport(port) {
  if (port === null || port === undefined) return null;
  if (!port || typeof port !== 'object' || Array.isArray(port)
    || typeof port.read !== 'function'
    || typeof port.drain !== 'function'
    || typeof port.getCursor !== 'function') {
    fail(
      'FABRIC_CONFIGURATION_INVALID',
      'inboundTransport must expose cursor-backed read(), drain(), and getCursor() methods.'
    );
  }
  return Object.freeze({
    drain: port.drain.bind(port),
    getCursor: port.getCursor.bind(port),
    read: port.read.bind(port)
  });
}

function resolveInboundAuthentication(port) {
  if (port === null || port === undefined) return null;
  if (typeof port === 'function') return port;
  if (port && typeof port.resolve === 'function') return port.resolve.bind(port);
  fail(
    'FABRIC_CONFIGURATION_INVALID',
    'inboundAuthentication must be a function or expose resolve().'
  );
}

function resolveMailboxPort(port) {
  if (port === null || port === undefined) return null;
  if (!port || typeof port !== 'object' || Array.isArray(port)
    || typeof port.isRegistered !== 'function'
    || typeof port.append !== 'function') {
    fail(
      'FABRIC_CONFIGURATION_INVALID',
      'mailboxPort must expose synchronous isRegistered(agentId) and append(entry) methods.'
    );
  }
  return Object.freeze({
    append: port.append.bind(port),
    isRegistered: port.isRegistered.bind(port)
  });
}

function createAgentCommsFabric({
  agents,
  verifier,
  store,
  broker = null,
  brokerOptions = null,
  inboundAuthentication = null,
  inboundTransport = null,
  mailboxPort = null,
  channelContractOptions = {},
  claimsOptions = {},
  controlOptions = {},
  deliveryOptions = {},
  historyOptions = {},
  homeNode = null,
  legacyBoard = null,
  now = Date.now
} = {}) {
  if (typeof now !== 'function') fail('FABRIC_CONFIGURATION_INVALID', 'now must be an injected function.');
  const directory = normalizeAgents(agents);
  const byIdentity = new Map(directory.map(agent => [identityKey(agent), agent]));
  const byAgentId = new Map(directory.map(agent => [agent.agentId, agent]));
  let durableHistory = null;

  function retainedHistory(channelId) {
    if (!durableHistory) return [];
    let snapshot = durableHistory.read({ channelId, afterSequence: 0 });
    if (snapshot.status === 'TRUNCATED') {
      snapshot = durableHistory.read({ channelId, afterSequence: snapshot.floorSequence - 1 });
    }
    return snapshot.records;
  }

  function resolveDurableMessage(messageId) {
    const record = retainedHistory(OWNER_JOURNAL_STREAM)
      .find(candidate => candidate.message.message.id === messageId
        && audienceRecordFor(candidate.message));
    return record ? record.message.message : null;
  }

  function audienceRecordFor(journalEnvelope) {
    return retainedHistory(journalEnvelope.streamId)
      .find(candidate => candidate.message.id === journalEnvelope.message.id) || null;
  }

  if (legacyBoard && channelContractOptions.maxBodyLength !== undefined && channelContractOptions.maxBodyLength > 4_000) {
    fail('FABRIC_COMPAT_BODY_LIMIT_MISMATCH', 'The legacy bridge cannot carry bodies larger than 4000 characters.');
  }
  if (legacyBoard && channelContractOptions.maxChannelNameLength !== undefined && channelContractOptions.maxChannelNameLength > 48) {
    fail('FABRIC_COMPAT_CHANNEL_LIMIT_MISMATCH', 'The legacy bridge cannot carry channel names longer than 48 characters.');
  }

  const contract = createChannelContract({
    ...channelContractOptions,
    knownAgents: directory.map(({ agentId, machineId }) => ({ agentId, machineId })),
    messageIdFactory: Object.hasOwn(channelContractOptions, 'messageIdFactory')
      ? channelContractOptions.messageIdFactory
      : () => `message-${crypto.randomUUID()}`,
    messageResolver: channelContractOptions.messageResolver || resolveDurableMessage,
    verifier,
    now
  });
  const control = createControlPlane({ ...controlOptions, store, now });
  const mailbox = resolveMailboxPort(mailboxPort);
  const localDeliveryNotices = new Map();

  function hydrateChannels() {
    const snapshot = control.snapshot();
    for (const durableChannel of snapshot.channels) {
      const existing = contract.listChannels().find(channel => channel.name === durableChannel.name);
      if (!existing) contract.createChannel({ name: durableChannel.name });
      const members = new Set(contract.listChannels()
        .find(channel => channel.name === durableChannel.name).members
        .map(member => member.agentId));
      for (const memberAgentId of durableChannel.members) {
        const configured = byAgentId.get(memberAgentId);
        if (configured && !members.has(memberAgentId)) {
          contract.joinChannel({
            channel: durableChannel.name,
            agent: { agentId: configured.agentId, machineId: configured.machineId }
          });
        }
      }
      const owner = byAgentId.get('owner');
      if (durableChannel.ownerSpecial && owner && !members.has('owner')) {
        contract.joinChannel({
          channel: durableChannel.name,
          agent: { agentId: owner.agentId, machineId: owner.machineId }
        });
      }
    }
    return snapshot;
  }

  hydrateChannels();
  const lifecycle = createDeliveryLifecycle({
    ...deliveryOptions,
    normalizeEnvelope: deliveryEnvelope,
    now
  });
  const history = createHistory({
    maxChannelBytes: DEFAULT_HISTORY_CHANNEL_BYTES,
    maxMessageBytes: DEFAULT_HISTORY_MESSAGE_BYTES,
    ...historyOptions,
    store,
    now
  });
  durableHistory = history;
  const claims = createClaims({ ...claimsOptions, now });
  const claimedSubjects = new Set();

  let activeBroker = broker;
  if (activeBroker === null) {
    const options = plainObject(brokerOptions, 'brokerOptions', 'FABRIC_CONFIGURATION_INVALID');
    const configuredTransport = options.transport;
    activeBroker = createBroker({
      ...options,
      knownAgents: directory.map(({ agentId, machineId, route, sessionId }) => ({ agentId, machineId, route, sessionId })),
      now,
      transport: configuredTransport && typeof configuredTransport.deliver === 'function'
        ? Object.freeze({
          async deliver(attempt) {
            const receipt = await configuredTransport.deliver(attempt);
            if (!receipt || receipt.delivered !== true
              || !receipt.evidence || receipt.evidence.source !== 'local-durable-fabric') {
              return receipt;
            }
            const message = attempt.message;
            const recipient = message.audience.agent;
            const noticeKey = `${message.id}\u0000${recipient.agentId}`;
            let notice = localDeliveryNotices.get(noticeKey);
            let audiencePersisted = false;
            if (!notice || notice.queued !== true) {
              const streamId = streamIdForAudience(message.audience);
              const record = retainedHistory(streamId)
                .find(candidate => candidate.message.id === message.id);
              audiencePersisted = Boolean(record);
              // An append can throw after writing. Repeating that optional
              // hint here would duplicate mailbox traffic within one send;
              // the audience record still decides the delivery receipt.
              if (!notice || notice.code !== 'FABRIC_MAILBOX_APPEND_FAILED') {
                notice = record
                  ? mailboxNotification(recipient, message, streamId, record.sequence)
                  : Object.freeze({ queued: false, code: 'FABRIC_AUDIENCE_NOT_PUBLISHED', agentId: recipient.agentId });
                localDeliveryNotices.set(noticeKey, notice);
              }
            } else {
              audiencePersisted = true;
            }
            // Audience history is the durable hand-off. The presence mailbox is
            // only a wake/display hint, so its absence cannot turn an already
            // persisted delivery into an eternal broker spool entry.
            return audiencePersisted
              ? receipt
              : Object.freeze({ delivered: false, messageId: attempt.messageId });
          }
        })
        : configuredTransport
    });
  }
  if (!activeBroker || typeof activeBroker.send !== 'function' || typeof activeBroker.drain !== 'function') {
    fail('FABRIC_CONFIGURATION_INVALID', 'broker must expose send() and drain().');
  }
  const inboundPort = resolveInboundTransport(inboundTransport);
  const inboundAuthenticationFor = resolveInboundAuthentication(inboundAuthentication);
  const inboundReceipts = new Map();
  const inboundReader = inboundPort === null ? null : createPositionedReader({
    async readPage(request) {
      const page = plainObject(
        await inboundPort.read(request),
        'inbound transport page',
        'FABRIC_INBOUND_PAGE_INVALID'
      );
      if (!Array.isArray(page.messages)) {
        fail('FABRIC_INBOUND_PAGE_INVALID', 'inbound transport page must expose messages.');
      }
      return {
        headSequence: page.headSequence,
        nextCursor: page.cursor,
        records: page.messages
      };
    }
  });

  let homeResolution = null;
  let peerState = null;
  let homeDelivery = null;
  if (homeNode !== null) {
    const options = plainObject(homeNode, 'homeNode', 'FABRIC_CONFIGURATION_INVALID');
    exactKeys(options, ['configuration', 'identity'], ['deliveryPort', 'state'], 'homeNode', 'FABRIC_CONFIGURATION_INVALID');
    homeResolution = homeNodes.resolveHomeNodeRole({
      configuration: options.configuration,
      identity: options.identity
    });
    homeDelivery = resolvePort(options.deliveryPort);
    if (homeResolution.role === 'PEER') {
      peerState = options.state === undefined
        ? homeNodes.createPeerDeliveryState(homeResolution)
        : homeNodes.normalizePeerDeliveryState(options.state);
      if (peerState.nodeId !== homeResolution.nodeId || peerState.homeNode.nodeId !== homeResolution.homeNode.nodeId) {
        fail('FABRIC_HOME_STATE_MISMATCH', 'Restored peer state does not match the resolved home-node configuration.');
      }
    }
  }

  function knownIdentity(input, label = 'agent') {
    const source = plainObject(input, label);
    exactKeys(source, ['agentId', 'machineId'], [], label);
    const normalized = {
      agentId: identifier(source.agentId, `${label}.agentId`),
      machineId: identifier(source.machineId, `${label}.machineId`)
    };
    const known = byIdentity.get(identityKey(normalized));
    if (!known) fail('FABRIC_AGENT_UNKNOWN', `${label} is not configured.`);
    return Object.freeze({ agentId: known.agentId, machineId: known.machineId });
  }

  function normalizeAudience(input, reader = null) {
    const source = plainObject(input, 'audience');
    if (source.type === 'direct') {
      exactKeys(source, ['agent', 'type'], [], 'audience');
      const audience = directAudience(knownIdentity(source.agent, 'audience.agent'));
      if (reader && !sameIdentity(reader, audience.agent)) {
        fail('FABRIC_READ_NOT_ADDRESSED', 'An agent may read only its own direct stream.');
      }
      return audience;
    }
    if (source.type === 'channel') {
      exactKeys(source, ['name', 'type'], [], 'audience');
      const durable = control.snapshot().channels.find(candidate => candidate.name === source.name);
      if (!durable) fail('FABRIC_CHANNEL_UNKNOWN', 'The channel is unknown.');
      if (reader) ensureChannelMembership(reader, durable.name);
      return Object.freeze({ type: 'channel', name: durable.name });
    }
    fail('FABRIC_ARGUMENT_INVALID', 'audience type is invalid.');
  }

  function currentTime() {
    return nonNegativeInteger(now(), 'clock result', 'FABRIC_CLOCK_INVALID');
  }

  function ensureChannelMembership(agent, channelName) {
    const access = control.assertAccess({ channel: channelName, agentId: agent.agentId });
    const channel = contract.listChannels().find(candidate => candidate.name === channelName);
    if (!channel) {
      contract.createChannel({ name: channelName });
    }
    const refreshed = contract.listChannels().find(candidate => candidate.name === channelName);
    if (!refreshed.members.some(member => sameIdentity(member, agent))) {
      contract.joinChannel({ channel: channelName, agent });
    }
    return access;
  }

  function channelMembers(channelName) {
    const durable = control.snapshot().channels.find(channel => channel.name === channelName);
    if (!durable) fail('FABRIC_CHANNEL_UNKNOWN', 'The channel is unknown.', { channel: channelName });
    return durable.members.map(memberAgentId => {
      const agent = byAgentId.get(memberAgentId);
      if (!agent) {
        fail(
          'FABRIC_CHANNEL_MEMBER_UNCONFIGURED',
          'A durable channel member is not present in the configured agent directory.',
          { agentId: memberAgentId, channel: channelName }
        );
      }
      return Object.freeze({ agentId: agent.agentId, machineId: agent.machineId });
    });
  }

  function mailboxNotification(recipient, message, streamId, streamSequence) {
    if (!mailbox) return Object.freeze({ queued: false, code: 'FABRIC_MAILBOX_PORT_UNAVAILABLE', agentId: recipient.agentId });
    // Audience history is already durable. An optional wake/display hint may
    // fail, but rejecting here would hide the stored message's receipt and
    // stop broker delivery or later channel recipients. Keep the failure in
    // mailboxDeliveries while allowing the authoritative hand-off to finish.
    let registered;
    try { registered = mailbox.isRegistered(recipient.agentId) === true; }
    catch (error) {
      return Object.freeze({
        queued: false,
        code: 'FABRIC_MAILBOX_REGISTRY_FAILED',
        reason: 'The presence-mailbox registration could not be read.',
        agentId: recipient.agentId,
        causeCode: error && typeof error.code === 'string' ? error.code : null
      });
    }
    if (!registered) return Object.freeze({ queued: false, code: 'FABRIC_MAILBOX_NOT_REGISTERED', agentId: recipient.agentId });
    const requestId = `agent-comms-${crypto.createHash('sha256').update(`${recipient.agentId}\u0000${message.id}`, 'utf8').digest('hex').slice(0, 48)}`;
    const destination = message.audience.type === 'channel'
      ? `#${message.audience.name}`
      : `@${recipient.agentId}`;
    let receipt;
    try {
      receipt = mailbox.append(Object.freeze({
        agentId: recipient.agentId,
        from: message.sender.agentId,
        prompt: `[agent-comms ${destination}] ${message.body}`,
        requestId,
        at: currentTime(),
        messageId: message.id,
        streamId,
        streamSequence
      }));
    } catch (error) {
      return Object.freeze({
        queued: false,
        code: 'FABRIC_MAILBOX_APPEND_FAILED',
        reason: 'The registered presence mailbox refused the durable fabric notice.',
        agentId: recipient.agentId,
        messageId: message.id,
        causeCode: error && typeof error.code === 'string' ? error.code : null
      });
    }
    return deepFreeze({
      queued: true,
      code: 'FABRIC_MAILBOX_QUEUED',
      agentId: recipient.agentId,
      requestId: receipt && typeof receipt.requestId === 'string' ? receipt.requestId : requestId
    });
  }

  function notifyRecipients(recipients, message, streamId, streamSequence) {
    const results = recipients
      .filter(recipient => !sameIdentity(recipient, message.sender))
      .map(recipient => mailboxNotification(recipient, message, streamId, streamSequence));
    for (const result of results) {
      localDeliveryNotices.set(`${message.id}\u0000${result.agentId}`, result);
    }
    return deepFreeze(results);
  }

  function deliverySnapshot(messageId) {
    return lifecycle.getMessage(messageId);
  }

  function recordBrokerDelivery(messageId, code) {
    const existing = deliverySnapshot(messageId);
    if (!existing || existing.state !== STATES.SENT) return existing;
    const recorded = lifecycle.recordDelivery(messageId, {
      source: 'broker-confirmed-receipt',
      brokerCode: code,
      messageId
    });
    if (!recorded.accepted) {
      fail('FABRIC_DELIVERY_EVIDENCE_REJECTED', 'Broker delivery evidence could not be applied.', {
        messageId,
        lifecycleCode: recorded.code
      });
    }
    return recorded.message;
  }

  function preflightAnswer(sender, recipient, causalParent) {
    const ask = lifecycle.getMessage(causalParent);
    if (ask) {
      if (ask.kind !== 'ASK') return Object.freeze({ accepted: false, code: 'ANSWER_ASK_NOT_FOUND' });
      if (ask.senderId !== recipient.agentId || ask.recipientId !== sender.agentId) {
        return Object.freeze({ accepted: false, code: 'ANSWER_ASK_AUDIENCE_MISMATCH' });
      }
      if (ask.state !== STATES.READ) {
        return Object.freeze({ accepted: false, code: 'DELIVERY_TRANSITION_REJECTED', state: ask.state });
      }
      return null;
    }

    const durableAsk = resolveDurableMessage(causalParent);
    if (!durableAsk || durableAsk.kind !== 'ask' || durableAsk.audience.type !== 'direct') {
      return Object.freeze({ accepted: false, code: 'ANSWER_ASK_NOT_FOUND' });
    }
    if (!sameIdentity(durableAsk.sender, recipient) || !sameIdentity(durableAsk.audience.agent, sender)) {
      return Object.freeze({ accepted: false, code: 'ANSWER_ASK_AUDIENCE_MISMATCH' });
    }
    const streamId = streamIdForAudience(durableAsk.audience);
    const record = retainedHistory(streamId).find(candidate => candidate.message.id === causalParent);
    const cursor = history.getCursor({ agentId: sender.agentId, channelId: streamId });
    if (!record || cursor.sequence < record.sequence) {
      return Object.freeze({ accepted: false, code: 'DELIVERY_TRANSITION_REJECTED', state: 'DELIVERED' });
    }
    return null;
  }

  function acceptAuthenticatedSubmission(submission, authentication, deliveryEvidence = null) {
    const posted = contract.post(submission, authentication);
    if (!posted.accepted) return posted;

    const message = posted.message;
    let delivery = null;
    const lifecycleTrackable = message.kind === 'ask'
      || (message.kind === 'answer' && lifecycle.getMessage(message.causalParent));
    if (message.audience.type === 'direct' && TRACKED_KINDS.has(message.kind) && lifecycleTrackable) {
      const accepted = lifecycle.accept(message);
      if (!accepted.accepted) {
        fail('FABRIC_LIFECYCLE_REJECTED_AFTER_CONTRACT', 'The lifecycle refused a contract-accepted message.', {
          messageId: message.id,
          lifecycleCode: accepted.code
        });
      }
      delivery = accepted.message;
    }

    const streamId = streamIdForAudience(message.audience);
    // The owner journal is structural and precedes every audience projection.
    // ownerProjection verifies the matching audience row before presenting
    // this envelope as sent, retaining a failed second append as an explicit
    // incomplete operation rather than a message nobody can receive.
    const journalRecord = history.append({
      channelId: OWNER_JOURNAL_STREAM,
      message: { streamId, message }
    });
    /* WHO THIS STREAM EXISTS FOR, so retention can tell read from unread
       (T201). A direct stream is `direct.<digest of machineId+agentId>` -- one
       stream per RECIPIENT, shared by every sender -- so its reader set is
       exactly that one agent, and history.append() may then evict only what
       that agent has acknowledged rather than whatever is oldest.

       DIRECT AUDIENCES ONLY, deliberately. A channel audience has no single
       declared reader here; naming a set this call cannot know would be a
       guess, and a guessed reader that never acknowledges would eventually
       refuse appends on a stream nobody was protecting. Those streams keep the
       bounded, self-pruning behaviour they have always had. */
    let historyRecord;
    try {
      historyRecord = history.append({
        channelId: streamId,
        message,
        ...(message.audience.type === 'direct'
          ? { readers: [message.audience.agent.agentId] }
          : {})
      });
    } catch (error) {
      /* THE SENDER IS TOLD, IN ITS OWN VOCABULARY, and told something it can
         act on. Retention refuses rather than destroying a record the
         recipient has never read (T201); without this the caller received a
         raw HistoryError carrying an engine-internal code, from a function
         whose whole contract is to answer with FABRIC_ refusals.

         WHAT THE SENTENCE HAS TO CONVEY: nothing was lost, the recipient is
         simply behind, and the same message can be sent again once it catches
         up. That is the opposite of the old behaviour, where the send
         succeeded and an older message the recipient had never seen was
         silently destroyed to make room. */
      if (error?.code === 'HISTORY_CHANNEL_UNREAD_FULL') {
        fail('FABRIC_RECIPIENT_BACKLOG_FULL',
          'That agent has not yet read the messages already waiting for it, so this one cannot be queued without discarding one it has never seen. Nothing was lost; send it again once the agent has caught up.',
          { messageId: message.id, recipientId: message.audience?.agent?.agentId ?? null });
      }
      throw error;
    }
    if (deliveryEvidence !== null && delivery) {
      const recorded = lifecycle.recordDelivery(message.id, deliveryEvidence);
      if (!recorded.accepted) {
        fail('FABRIC_DELIVERY_EVIDENCE_REJECTED', 'Inbound delivery evidence could not be applied.', {
          messageId: message.id,
          lifecycleCode: recorded.code
        });
      }
      delivery = recorded.message;
    }
    return deepFreeze({
      accepted: true,
      code: posted.code,
      message,
      stream: { id: streamId, sequence: historyRecord.sequence },
      journal: { id: OWNER_JOURNAL_STREAM, sequence: journalRecord.sequence },
      delivery
    });
  }

  async function sendInternal(input, authentication) {
    const source = plainObject(input, 'send input');
    exactKeys(source, ['body', 'kind', 'recipient', 'sender'], ['causalParent', 'issuedAt'], 'send input');
    const sender = knownIdentity(source.sender, 'sender');
    const recipient = knownIdentity(source.recipient, 'recipient');
    const causalParent = source.causalParent === undefined ? null : source.causalParent;
    const issuedAt = source.issuedAt === undefined ? currentTime() : source.issuedAt;

    if (source.kind === 'answer') {
      const refused = preflightAnswer(sender, recipient, causalParent);
      if (refused) return refused;
    }
    if (homeResolution && homeResolution.role === 'UNCONFIGURED') {
      return Object.freeze({ accepted: false, code: 'FABRIC_HOME_NODE_UNCONFIGURED' });
    }

    const accepted = acceptAuthenticatedSubmission({
      sender,
      audience: directAudience(recipient),
      causalParent,
      kind: source.kind,
      body: source.body,
      issuedAt
    }, authentication);
    if (!accepted.accepted) return accepted;

    const message = accepted.message;
    let delivery = accepted.delivery;
    const mailboxDeliveries = notifyRecipients([recipient], message, accepted.stream.id, accepted.stream.sequence);

    let brokerResult;
    let retainedForHome = false;
    if (peerState && ['DEGRADED', 'RECONCILING'].includes(peerState.deliveryState)) {
      peerState = homeNodes.queueLocally(peerState, {
        historySequence: accepted.stream.sequence,
        message,
        streamId: accepted.stream.id
      });
      retainedForHome = true;
      brokerResult = Object.freeze({
        accepted: true,
        code: 'FABRIC_HOME_RETAINED',
        delivered: false,
        messageId: message.id,
        spooled: false,
        state: 'SENT'
      });
    } else {
      brokerResult = await activeBroker.send(message);
      if (brokerResult.delivered === true && delivery) {
        delivery = recordBrokerDelivery(message.id, brokerResult.code);
      }
    }

    return deepFreeze({
      accepted: true,
      code: brokerResult.code,
      message,
      stream: accepted.stream,
      journal: accepted.journal,
      delivery,
      broker: brokerResult,
      mailboxDeliveries,
      retainedForHome
    });
  }

  let operationTail = Promise.resolve();
  function serialize(operation) {
    const next = operationTail.then(operation, operation);
    operationTail = next.catch(() => {});
    return next;
  }

  function requireInboundTransport() {
    if (!inboundPort || !inboundReader) {
      fail('FABRIC_INBOUND_TRANSPORT_UNAVAILABLE', 'No cursor-backed inbound transport was injected.');
    }
  }

  function normalizeInboundRecord(input) {
    const record = plainObject(input, 'inbound transport record', 'FABRIC_INBOUND_RECORD_INVALID');
    if (!Object.hasOwn(record, 'message') || typeof record.message !== 'string') {
      fail('FABRIC_INBOUND_RECORD_INVALID', 'inbound transport record must contain an encoded message.');
    }
    const sequence = nonNegativeInteger(record.sequence, 'inbound transport sequence', 'FABRIC_INBOUND_RECORD_INVALID');
    if (sequence === 0) {
      fail('FABRIC_INBOUND_RECORD_INVALID', 'inbound transport sequence must be positive.');
    }
    if (typeof record.channel !== 'string' || record.channel.length < 1 || record.channel.length > 128) {
      fail('FABRIC_INBOUND_RECORD_INVALID', 'inbound transport channel is invalid.');
    }
    let message;
    try { message = JSON.parse(record.message); }
    catch { fail('FABRIC_INBOUND_MESSAGE_INVALID', 'inbound transport message is not valid JSON.'); }
    message = plainObject(message, 'inbound message', 'FABRIC_INBOUND_MESSAGE_INVALID');
    exactKeys(
      message,
      ['audience', 'body', 'causalParent', 'issuedAt', 'kind', 'sender'],
      ['id', 'sequence'],
      'inbound message',
      'FABRIC_INBOUND_MESSAGE_INVALID'
    );
    const submission = Object.freeze({
      audience: message.audience,
      body: message.body,
      causalParent: message.causalParent,
      issuedAt: message.issuedAt,
      kind: message.kind,
      sender: message.sender
    });
    const fingerprint = crypto.createHash('sha256')
      .update(`${record.channel}\u0000${sequence}\u0000${record.message}`, 'utf8')
      .digest('hex');
    return Object.freeze({
      authentication: Object.hasOwn(record, 'authentication') ? record.authentication : undefined,
      channel: record.channel,
      fingerprint,
      key: `${record.channel}\u0000${sequence}`,
      record,
      sequence,
      submission
    });
  }

  function resolveRecordAuthentication(normalized) {
    if (!inboundAuthenticationFor) return normalized.authentication;
    let authentication;
    try {
      authentication = inboundAuthenticationFor(Object.freeze({
        record: normalized.record,
        submission: normalized.submission
      }));
    } catch {
      return undefined;
    }
    if (authentication && typeof authentication.then === 'function') {
      fail(
        'FABRIC_INBOUND_AUTHENTICATION_INVALID',
        'inboundAuthentication must resolve synchronously before channel verification.'
      );
    }
    return authentication;
  }

  function receiveInboundRecord(input) {
    const normalized = normalizeInboundRecord(input);
    const prior = inboundReceipts.get(normalized.key);
    if (prior) {
      if (prior.fingerprint !== normalized.fingerprint) {
        fail(
          'FABRIC_INBOUND_POSITION_CONFLICT',
          'an inbound transport position was reused with different message content.',
          { channel: normalized.channel, sequence: normalized.sequence }
        );
      }
      return deepFreeze({ ...prior.result, replayed: true });
    }

    const accepted = acceptAuthenticatedSubmission(
      normalized.submission,
      resolveRecordAuthentication(normalized),
      {
        source: 'transport-inbound',
        transportChannel: normalized.channel,
        transportSequence: normalized.sequence
      }
    );
    const result = deepFreeze({
      ...accepted,
      inbound: true,
      replayed: false,
      transport: {
        channel: normalized.channel,
        sequence: normalized.sequence
      }
    });
    inboundReceipts.set(normalized.key, Object.freeze({
      fingerprint: normalized.fingerprint,
      result
    }));
    return result;
  }

  function summarizeInbound(position, received) {
    // Authentication stays inside the verification seam. Positioned reads
    // may carry it on raw relay records, but callers receive only verified or
    // refused ingress outcomes plus non-sensitive position metadata.
    const safePosition = Object.fromEntries(Object.entries(position)
      .filter(([key]) => key !== 'records' && key !== 'messages'));
    return deepFreeze({
      ...safePosition,
      received,
      acceptedCount: received.filter(result => result.accepted === true).length,
      refusedCount: received.filter(result => result.accepted !== true).length
    });
  }

  function readInbound(input) {
    return serialize(async () => {
      requireInboundTransport();
      const page = await inboundReader.read(input);
      const mayConsume = page.status === 'BACKLOG'
        || (page.status === 'INCOMPLETE' && page.reason === 'PAGE_PARTIAL');
      const received = [];
      if (mayConsume) {
        for (const record of page.records) received.push(receiveInboundRecord(record));
      }
      return summarizeInbound(page, received);
    });
  }

  function drainInbound(input = {}) {
    return serialize(async () => {
      requireInboundTransport();
      const source = plainObject(input, 'inbound drain input');
      exactKeys(source, [], [], 'inbound drain input');
      const received = [];
      const position = await inboundPort.drain({
        async onMessage(record) {
          received.push(receiveInboundRecord(record));
        }
      });
      return summarizeInbound(position, received);
    });
  }

  function inboundPosition(input = {}) {
    requireInboundTransport();
    const source = plainObject(input, 'inbound position input');
    exactKeys(source, [], [], 'inbound position input');
    const cursor = nonNegativeInteger(
      inboundPort.getCursor(),
      'inbound transport cursor',
      'FABRIC_INBOUND_POSITION_INVALID'
    );
    return Object.freeze({ status: 'POSITION', cursor });
  }

  function send(input, authentication) {
    return serialize(() => sendInternal(input, authentication));
  }

  // Internal host receipt transition. The broker requires the original
  // envelope and its retained delivery fingerprint before changing state.
  function transitionRecipientDelivery(input, verb) {
    return serialize(() => {
      const source = plainObject(input, 'discard delivery input');
      exactKeys(source, ['agent', 'message'], [], 'discard delivery input');
      const agent = knownIdentity(source.agent);
      const message = plainObject(source.message, 'discarded message');
      const recipient = message.audience?.type === 'direct' && message.audience.agent;
      if (!recipient || recipient.agentId !== agent.agentId || recipient.machineId !== agent.machineId) {
        fail('FABRIC_DELIVERY_RECIPIENT_MISMATCH', 'Only the original recipient inbox can discard this delivery.');
      }
      if (typeof activeBroker[verb] !== 'function') {
        fail('FABRIC_DELIVERY_RECEIPTS_UNAVAILABLE', 'This broker cannot retain recipient handoff state.');
      }
      return activeBroker[verb]({ message, ...(verb === 'deadLetter' ? { reason: 'RECIPIENT_QUEUE_DISCARDED' } : {}) });
    });
  }

  const discardDelivery = input => transitionRecipientDelivery(input, 'deadLetter');
  const deferDelivery = input => transitionRecipientDelivery(input, 'deferDelivery');
  const acknowledgeDeferredDelivery = input => transitionRecipientDelivery(input, 'acknowledgeDeferredDelivery');

  // Read the same durable dead letter that changed the delivery receipt.
  // There is no second notification write to lose if the host exits between
  // recording failure and the sender's next inbox read.
  function deliveryFailures(input) {
    const source = plainObject(input, 'delivery failures input');
    exactKeys(source, ['agents'], [], 'delivery failures input');
    if (!Array.isArray(source.agents)) fail('FABRIC_ARGUMENT_INVALID', 'agents must be an array.');
    const wanted = new Map(source.agents.map(value => {
      const agent = knownIdentity(value);
      return [agent.agentId, agent.machineId];
    }));
    if (typeof activeBroker.getState !== 'function') {
      fail('FABRIC_DELIVERY_RECEIPTS_UNAVAILABLE', 'This broker cannot read delivery receipts.');
    }
    const state = activeBroker.getState();
    const visible = (recipientId, recipientMachine, senderId, senderMachine) =>
      wanted.get(recipientId) === recipientMachine || (senderId && wanted.get(senderId) === senderMachine);
    const failures = state.deadLetters.flatMap(record => {
      const entry = record.entry;
      const sender = entry.message.sender;
      if (wanted.get(entry.recipientAgentId) !== entry.recipientMachineId
        && (!sender || wanted.get(sender.agentId) !== sender.machineId)) return [];
      return [{ messageId: entry.messageId, senderAgentId: sender?.agentId || null,
        recipientAgentId: entry.recipientAgentId, code: 'BROKER_MESSAGE_DEAD_LETTERED',
        reason: record.reason, at: record.deadLetteredAtMs }];
    });
    const deferred = (state.deferred || []).flatMap(record => {
      const entry = record.entry, sender = entry.message.sender;
      if (!visible(entry.recipientAgentId, entry.recipientMachineId, sender?.agentId, sender?.machineId)) return [];
      return [{ messageId: entry.messageId, senderAgentId: sender?.agentId || null,
        recipientAgentId: entry.recipientAgentId,
        code: record.waitingForModel ? 'BROKER_DELIVERY_AWAITING_MODEL' : 'BROKER_DELIVERY_DEFERRED',
        reason: record.waitingForModel ? 'RECIPIENT_MODEL_PENDING' : 'RECIPIENT_SESSION_RETIRED',
        at: record.deferredAtMs, message: entry.message }];
    });
    const confirmed = state.deliveries.flatMap(receipt => {
      if (!Number.isSafeInteger(receipt.modelHandoffAtMs)
        || !visible(receipt.recipientAgentId, receipt.recipientMachineId, receipt.senderAgentId, receipt.senderMachineId)) return [];
      return [{ messageId: receipt.messageId, senderAgentId: receipt.senderAgentId,
        recipientAgentId: receipt.recipientAgentId, code: 'BROKER_MODEL_HANDOFF_CONFIRMED',
        reason: 'RECOVERED_MODEL_HANDOFF', at: receipt.modelHandoffAtMs,
        ...(receipt.modelHandoffRecovered === false ? { notifySender: false } : {}) }];
    });
    return deepFreeze([...failures, ...deferred, ...confirmed]);
  }

  function sendChannel(input, authentication) {
    return serialize(() => {
      const source = plainObject(input, 'channel send input');
      exactKeys(source, ['body', 'channel', 'kind', 'sender'], ['causalParent', 'issuedAt'], 'channel send input');
      const sender = knownIdentity(source.sender, 'sender');
      if (typeof source.channel !== 'string') fail('FABRIC_ARGUMENT_INVALID', 'channel is invalid.', { field: 'channel' });
      ensureChannelMembership(sender, source.channel);
      const accepted = acceptAuthenticatedSubmission({
        sender,
        audience: { type: 'channel', name: source.channel },
        causalParent: source.causalParent === undefined ? null : source.causalParent,
        kind: source.kind,
        body: source.body,
        issuedAt: source.issuedAt === undefined ? currentTime() : source.issuedAt
      }, authentication);
      if (!accepted.accepted) return accepted;
      const recipients = channelMembers(source.channel);
      const mailboxDeliveries = notifyRecipients(
        recipients,
        accepted.message,
        accepted.stream.id,
        accepted.stream.sequence
      );
      return deepFreeze({
        accepted: true,
        code: 'FABRIC_CHANNEL_DURABLE',
        message: accepted.message,
        stream: accepted.stream,
        journal: accepted.journal,
        delivery: {
          state: 'DELIVERED',
          durable: true,
          recipientAgentIds: recipients
            .filter(recipient => !sameIdentity(recipient, sender))
            .map(recipient => recipient.agentId)
        },
        mailboxDeliveries
      });
    });
  }

  function answer(input, authentication) {
    return serialize(async () => {
      const source = plainObject(input, 'answer input');
      exactKeys(source, ['askId', 'body', 'sender'], ['issuedAt'], 'answer input');
      const sender = knownIdentity(source.sender, 'sender');
      const parent = contract.getMessage(source.askId);
      if (!parent || parent.kind !== 'ask') {
        return Object.freeze({ accepted: false, code: 'ANSWER_ASK_NOT_FOUND' });
      }
      return sendInternal({
        sender,
        recipient: parent.sender,
        kind: 'answer',
        causalParent: source.askId,
        body: source.body,
        ...(source.issuedAt === undefined ? {} : { issuedAt: source.issuedAt })
      }, authentication);
    });
  }

  function createChannel(input) {
    const source = plainObject(input, 'create channel input');
    exactKeys(source, ['name'], ['actor'], 'create channel input');
    const actor = Object.hasOwn(source, 'actor') ? knownIdentity(source.actor, 'actor') : null;
    control.createChannel({ name: source.name, actorId: actor ? actor.agentId : 'system' });
    return contract.createChannel({ name: source.name });
  }

  function joinChannel(input) {
    const source = plainObject(input, 'join input');
    exactKeys(source, ['agent', 'channel'], [], 'join input');
    const agent = knownIdentity(source.agent);
    control.join({ channel: source.channel, agentId: agent.agentId });
    return contract.joinChannel({ channel: source.channel, agent });
  }

  function leaveChannel(input) {
    const source = plainObject(input, 'leave input');
    exactKeys(source, ['agent', 'channel'], [], 'leave input');
    const agent = knownIdentity(source.agent);
    control.leave({ channel: source.channel, agentId: agent.agentId });
    return contract.leaveChannel({ channel: source.channel, agent });
  }

  // Claims remain observations owned by the claims module. The fabric binds
  // an observation to a configured agent identity, but deliberately never
  // selects between conflicting observations.
  function assertClaim(input) {
    const source = plainObject(input, 'claim assertion input');
    exactKeys(source, ['agent', 'asOfMs', 'kind', 'subject', 'value'], ['evidence', 'validity'], 'claim assertion input');
    const agent = knownIdentity(source.agent);
    const result = claims.assert({
      subject: source.subject,
      kind: source.kind,
      author: agent.agentId,
      value: source.value,
      asOfMs: source.asOfMs,
      ...(Object.hasOwn(source, 'evidence') ? { evidence: source.evidence } : {}),
      ...(Object.hasOwn(source, 'validity') ? { validity: source.validity } : {})
    });
    claimedSubjects.add(source.subject);
    return result;
  }

  function readClaim(input) {
    const source = plainObject(input, 'claim read input');
    exactKeys(source, ['subject'], [], 'claim read input');
    return claims.read({ subject: source.subject });
  }

  function listOpenConflicts(input = {}) {
    const source = plainObject(input, 'open conflicts input');
    exactKeys(source, [], [], 'open conflicts input');
    const conflicts = [...claimedSubjects]
      .sort((left, right) => left.localeCompare(right))
      .map(subject => claims.read({ subject }))
      .filter(result => result.status === 'CONFLICT');
    return deepFreeze({
      status: 'OPEN_CONFLICTS',
      adjudication: 'NONE',
      presentation: {
        label: 'OPEN CONFLICTS — NOT ADJUDICATED',
        freshness: 'Freshness hints on each conflict are context only, never a winner.'
      },
      conflicts
    });
  }

  async function read(input) {
    const source = plainObject(input, 'read input');
    exactKeys(source, ['agent', 'audience'], ['cursor', 'limit'], 'read input');
    const agent = knownIdentity(source.agent);
    const audience = normalizeAudience(source.audience, agent);
    const channelId = streamIdForAudience(audience);
    let lastSnapshot = null;
    const reader = createPositionedReader({
      readPage({ cursor, limit }) {
        const snapshot = history.read({ channelId, afterSequence: cursor });
        if (snapshot.status === 'TRUNCATED') throw new TruncatedRead(snapshot);
        lastSnapshot = snapshot;
        const records = limit === undefined ? snapshot.records : snapshot.records.slice(0, limit);
        return {
          headSequence: snapshot.headSequence,
          nextCursor: records.length ? records.at(-1).sequence : cursor,
          records
        };
      }
    });
    const positionedInput = {};
    if (Object.hasOwn(source, 'cursor')) positionedInput.cursor = source.cursor;
    if (Object.hasOwn(source, 'limit')) positionedInput.limit = source.limit;
    try {
      const result = await reader.read(positionedInput);
      return deepFreeze({
        streamId: channelId,
        floorSequence: lastSnapshot.floorSequence,
        ...result
      });
    } catch (error) {
      if (!(error instanceof TruncatedRead)) throw error;
      const snapshot = error.snapshot;
      return deepFreeze({
        streamId: channelId,
        status: 'TRUNCATED',
        reason: 'RETENTION_FLOOR',
        cursor: snapshot.afterSequence,
        floorSequence: snapshot.floorSequence,
        headSequence: snapshot.headSequence,
        backlogCount: Math.max(0, snapshot.headSequence - snapshot.afterSequence),
        caughtUp: false,
        nextCursor: snapshot.afterSequence,
        records: []
      });
    }
  }

  function position(input) {
    const source = plainObject(input, 'position input');
    exactKeys(source, ['agent', 'audience'], [], 'position input');
    const agent = knownIdentity(source.agent);
    const audience = normalizeAudience(source.audience, agent);
    const channelId = streamIdForAudience(audience);
    const cursor = history.getCursor({ agentId: agent.agentId, channelId });
    const snapshot = history.read({ channelId, afterSequence: cursor.sequence });
    const truncated = snapshot.status === 'TRUNCATED';
    return deepFreeze({
      streamId: channelId,
      status: truncated ? 'TRUNCATED' : (cursor.sequence === snapshot.headSequence ? 'CAUGHT_UP' : 'BACKLOG'),
      cursor: cursor.sequence,
      floorSequence: snapshot.floorSequence,
      headSequence: snapshot.headSequence,
      backlogCount: Math.max(0, snapshot.headSequence - cursor.sequence),
      caughtUp: !truncated && cursor.sequence === snapshot.headSequence
    });
  }

  function normalizeReadEvidence(value) {
    const evidence = plainObject(value, 'read evidence', 'FABRIC_READ_EVIDENCE_REQUIRED');
    if (Object.keys(evidence).length < 1) {
      fail('FABRIC_READ_EVIDENCE_REQUIRED', 'read evidence may not be empty.');
    }
    return evidence;
  }

  function markRead(input) {
    return serialize(() => {
      const source = plainObject(input, 'markRead input');
      exactKeys(source, ['agent', 'audience', 'evidence', 'messageId', 'sequence'], [], 'markRead input');
      const agent = knownIdentity(source.agent);
      const audience = normalizeAudience(source.audience, agent);
      const evidence = normalizeReadEvidence(source.evidence);
      const sequence = nonNegativeInteger(source.sequence, 'sequence');
      if (sequence === 0) fail('FABRIC_ARGUMENT_INVALID', 'sequence must be positive.', { field: 'sequence' });
      if (typeof source.messageId !== 'string' || source.messageId.length < 1) {
        fail('FABRIC_ARGUMENT_INVALID', 'messageId is invalid.', { field: 'messageId' });
      }
      const channelId = streamIdForAudience(audience);
      const cursor = history.getCursor({ agentId: agent.agentId, channelId });
      const unread = history.read({ channelId, afterSequence: cursor.sequence });
      if (unread.status === 'TRUNCATED') {
        return deepFreeze({
          accepted: false,
          code: 'FABRIC_CURSOR_TRUNCATED',
          cursor: cursor.sequence,
          floorSequence: unread.floorSequence,
          headSequence: unread.headSequence
        });
      }
      const next = unread.records[0];
      if (!next || next.sequence !== sequence || next.message.id !== source.messageId) {
        return Object.freeze({ accepted: false, code: 'FABRIC_READ_OUT_OF_ORDER', cursor: cursor.sequence });
      }

      let delivery = lifecycle.getMessage(source.messageId);
      if (delivery) {
        if (delivery.recipientId !== agent.agentId) {
          return Object.freeze({ accepted: false, code: 'FABRIC_READ_NOT_ADDRESSED' });
        }
        if (delivery.state === STATES.DELIVERED) {
          const recorded = lifecycle.recordRead(source.messageId, evidence);
          if (!recorded.accepted) return recorded;
          delivery = recorded.message;
        } else if (![STATES.READ, STATES.ANSWERED, STATES.REFUSED].includes(delivery.state)) {
          return Object.freeze({
            accepted: false,
            code: 'DELIVERY_TRANSITION_REJECTED',
            action: 'READ',
            state: delivery.state
          });
        }
      } else {
        // Lifecycle.js is an in-process projection. The durable history record
        // and cursor remain authoritative after restart, so a recovered reader
        // may acknowledge any addressed retained message without fabricating a
        // missing lifecycle failure.
        delivery = deepFreeze({
          messageId: next.message.id,
          kind: next.message.kind.toUpperCase(),
          state: 'READ',
          durable: true,
          deliveredAtMs: next.appendedAtMs,
          readAtMs: currentTime(),
          readEvidence: evidence
        });
      }

      const acknowledged = history.acknowledge({
        agentId: agent.agentId,
        channelId,
        sequence
      });
      return deepFreeze({
        accepted: true,
        code: 'FABRIC_READ_MARKED',
        messageId: source.messageId,
        sequence,
        delivery,
        cursor: acknowledged.sequence
      });
    });
  }

  function listOutstandingAsks(input) {
    const source = plainObject(input, 'outstanding asks input');
    exactKeys(source, ['agent'], ['atMs'], 'outstanding asks input');
    const agent = knownIdentity(source.agent);
    return Object.hasOwn(source, 'atMs')
      ? lifecycle.listOutstandingAsks(agent.agentId, source.atMs)
      : lifecycle.listOutstandingAsks(agent.agentId);
  }

  function drain(input = {}) {
    return serialize(async () => {
      const source = plainObject(input, 'drain input');
      exactKeys(source, [], ['agent'], 'drain input');
      const agentId = Object.hasOwn(source, 'agent') ? knownIdentity(source.agent).agentId : null;
      const drained = await activeBroker.drain(agentId);
      const deliveries = [];
      for (const result of drained.results) {
        if (result.delivered === true) {
          const delivery = recordBrokerDelivery(result.messageId, result.code);
          if (delivery) deliveries.push(delivery);
        }
      }
      return deepFreeze({ ...drained, lifecycleDeliveries: deliveries });
    });
  }

  function requirePeer() {
    if (!peerState) fail('FABRIC_HOME_PEER_REQUIRED', 'This fabric is not configured as a peer node.');
  }

  function markHomeUnreachable() {
    return serialize(() => {
      requirePeer();
      peerState = homeNodes.enterHomeUnreachable(peerState);
      return peerState;
    });
  }

  function markHomeReachable() {
    return serialize(() => {
      requirePeer();
      peerState = homeNodes.beginReconciliation(peerState);
      return peerState;
    });
  }

  function reconcileHome() {
    return serialize(async () => {
      requirePeer();
      if (peerState.deliveryState === 'DEGRADED') {
        return deepFreeze({
          accepted: false,
          code: 'FABRIC_HOME_UNREACHABLE',
          reconciled: 0,
          remaining: peerState.localQueue.length,
          state: peerState
        });
      }
      if (!homeDelivery) {
        return deepFreeze({
          accepted: false,
          code: 'FABRIC_HOME_DELIVERY_PORT_UNAVAILABLE',
          reconciled: 0,
          remaining: peerState.localQueue.length,
          state: peerState
        });
      }

      let reconciled = 0;
      let code = 'FABRIC_HOME_RECONCILED';
      while (true) {
        const action = homeNodes.nextReconciliationItem(peerState);
        if (!action) break;
        let receipt;
        try { receipt = await homeDelivery(action); }
        catch {
          code = 'FABRIC_HOME_DELIVERY_FAILED';
          break;
        }
        if (!receipt || receipt.accepted !== true || receipt.sequence !== action.sequence) {
          code = 'FABRIC_HOME_DELIVERY_UNCONFIRMED';
          break;
        }
        peerState = homeNodes.acknowledgeReconciled(peerState, action.sequence);
        reconciled += 1;
      }
      return deepFreeze({
        accepted: code === 'FABRIC_HOME_RECONCILED',
        code,
        reconciled,
        remaining: peerState.localQueue.length,
        state: peerState
      });
    });
  }

  function homeStatus() {
    if (peerState) return peerState;
    return homeResolution;
  }

  function requireOwnerActor(input, code = 'OWNER_VISIBILITY_OWNER_REQUIRED') {
    const actor = plainObject(input, 'owner actor', code);
    exactKeys(actor, ['actorId', 'actorKind'], [], 'owner actor', code);
    if (actor.actorId !== 'owner' || actor.actorKind !== 'owner') {
      fail(code, 'This operation requires the transport-bound owner actor.');
    }
    return Object.freeze({ actorId: 'owner', actorKind: 'owner' });
  }

  function designateOwnerAgent(input) {
    const source = plainObject(input, 'designation input');
    exactKeys(source, ['actor', 'agent'], [], 'designation input');
    const actor = requireOwnerActor(source.actor, 'OWNER_ACTOR_REQUIRED');
    const agent = knownIdentity(source.agent);
    const result = control.designate({ actor, agentId: agent.agentId });
    if (result.active) {
      const channel = contract.listChannels().find(candidate => candidate.name === OWNER_CHANNEL);
      if (!channel.members.some(member => sameIdentity(member, agent))) {
        contract.joinChannel({ channel: OWNER_CHANNEL, agent });
      }
    }
    return result;
  }

  function revokeOwnerAgent(input) {
    const source = plainObject(input, 'revocation input');
    exactKeys(source, ['actor', 'agent'], [], 'revocation input');
    const actor = requireOwnerActor(source.actor, 'OWNER_ACTOR_REQUIRED');
    const agent = knownIdentity(source.agent);
    const result = control.revoke({ actor, agentId: agent.agentId });
    if (!result.active) {
      const channel = contract.listChannels().find(candidate => candidate.name === OWNER_CHANNEL);
      if (channel.members.some(member => sameIdentity(member, agent))) {
        contract.leaveChannel({ channel: OWNER_CHANNEL, agent });
      }
    }
    return result;
  }

  function listChannels(input = {}) {
    const source = plainObject(input, 'list channels input');
    exactKeys(source, ['agent'], [], 'list channels input');
    const agent = knownIdentity(source.agent);
    const snapshot = control.snapshot();
    const owner = agent.agentId === 'owner';
    return deepFreeze({
      schemaVersion: snapshot.schemaVersion,
      ownerChannel: snapshot.ownerChannel,
      channels: snapshot.channels.filter(channel => owner || channel.members.includes(agent.agentId)),
      designations: owner
        ? snapshot.designations
        : { active: snapshot.designations.activeAgentIds.includes(agent.agentId) }
    });
  }

  function ownerProjection(input) {
    const source = plainObject(input, 'owner projection input');
    exactKeys(source, ['actor'], ['cursor', 'limit'], 'owner projection input');
    requireOwnerActor(source.actor);
    const cursor = nonNegativeInteger(source.cursor === undefined ? 0 : source.cursor, 'cursor');
    const limit = nonNegativeInteger(source.limit === undefined ? 100 : source.limit, 'limit');
    if (limit < 1 || limit > 1_000) fail('FABRIC_ARGUMENT_INVALID', 'limit must be between 1 and 1000.', { field: 'limit' });
    const snapshot = history.read({ channelId: OWNER_JOURNAL_STREAM, afterSequence: cursor });
    const controlSnapshot = control.snapshot();
    if (snapshot.status === 'TRUNCATED') {
      return deepFreeze({
        schemaVersion: OWNER_PROJECTION_VERSION,
        generatedAtMs: currentTime(),
        channels: controlSnapshot.channels,
        designations: controlSnapshot.designations,
        journal: {
          streamId: OWNER_JOURNAL_STREAM,
          status: 'TRUNCATED',
          reason: 'RETENTION_FLOOR',
          cursor,
          nextCursor: cursor,
          floorSequence: snapshot.floorSequence,
          headSequence: snapshot.headSequence,
          backlogCount: Math.max(0, snapshot.headSequence - cursor),
          caughtUp: false,
          records: []
        }
      });
    }
    const scannedRecords = snapshot.records.slice(0, limit);
    const records = [];
    const incompleteRecords = [];
    // Every row must have its durable audience append, but a page often has
    // many rows in the same stream. Read and validate that stream once for
    // this synchronous projection instead of decoding its entire history for
    // every row. A later projection reads again, including repaired appends
    // and retention changes made by another writer.
    const audienceIdsByStream = new Map();
    for (const record of scannedRecords) {
      const envelope = record.message;
      let audienceIds = audienceIdsByStream.get(envelope.streamId);
      if (!audienceIds) {
        audienceIds = new Set(retainedHistory(envelope.streamId).map(row => row.message.id));
        audienceIdsByStream.set(envelope.streamId, audienceIds);
      }
      if (audienceIds.has(envelope.message.id)) records.push(record);
      else incompleteRecords.push(deepFreeze({
        sequence: record.sequence,
        appendedAtMs: record.appendedAtMs,
        messageId: record.message.message.id,
        streamId: record.message.streamId,
        message: record.message,
        status: 'INCOMPLETE_AUDIENCE_APPEND'
      }));
    }
    const nextCursor = scannedRecords.length ? scannedRecords.at(-1).sequence : cursor;
    const caughtUp = records.length === 0 && cursor === snapshot.headSequence;
    const pageComplete = nextCursor === snapshot.headSequence;
    return deepFreeze({
      schemaVersion: OWNER_PROJECTION_VERSION,
      generatedAtMs: currentTime(),
      channels: controlSnapshot.channels,
      designations: controlSnapshot.designations,
      journal: {
        streamId: OWNER_JOURNAL_STREAM,
        status: caughtUp ? 'CAUGHT_UP' : (pageComplete ? 'BACKLOG' : 'INCOMPLETE'),
        reason: caughtUp ? null : (pageComplete ? 'RECORDS_AVAILABLE' : 'PAGE_PARTIAL'),
        cursor,
        nextCursor,
        floorSequence: snapshot.floorSequence,
        headSequence: snapshot.headSequence,
        backlogCount: Math.max(0, snapshot.headSequence - cursor),
        caughtUp,
        records,
        incompleteRecords
      }
    });
  }

  const compatBridge = legacyBoard ? createCompatBridge({
    readFabric: ({ channelId, afterSequence }) => history.read({ channelId, afterSequence }),
    legacyBoard,
    channelMembers({ channelId }) {
      const channel = contract.listChannels().find(candidate => candidate.name === channelId);
      if (!channel) fail('FABRIC_CHANNEL_UNKNOWN', 'The channel is unknown.');
      return channel.members;
    },
    now
  }) : null;

  function carryLegacy(input) {
    if (!compatBridge) fail('FABRIC_COMPAT_BRIDGE_UNAVAILABLE', 'No legacy board was injected.');
    const source = plainObject(input, 'carryLegacy input');
    exactKeys(source, ['audience'], ['afterSequence'], 'carryLegacy input');
    const audience = normalizeAudience(source.audience);
    return compatBridge.carry({
      channelId: streamIdForAudience(audience),
      afterSequence: source.afterSequence === undefined ? 0 : source.afterSequence
    });
  }

  return Object.freeze({
    answer,
    assertClaim,
    carryLegacy,
    createChannel,
    designateOwnerAgent,
    acknowledgeDeferredDelivery,
    deferDelivery,
    deliveryFailures,
    discardDelivery,
    drain,
    drainInbound,
    homeStatus,
    inboundPosition,
    joinChannel,
    leaveChannel,
    listChannels,
    listOpenConflicts,
    listOutstandingAsks,
    markHomeReachable,
    markHomeUnreachable,
    markRead,
    position,
    ownerProjection,
    read,
    readClaim,
    reconcileHome,
    readInbound,
    revokeOwnerAgent,
    send,
    sendChannel,
    streamIdForAudience
  });
}

module.exports = Object.freeze({
  AgentCommsFabricError,
  DEFAULT_HISTORY_CHANNEL_BYTES,
  DEFAULT_HISTORY_MESSAGE_BYTES,
  OWNER_CHANNEL,
  OWNER_JOURNAL_STREAM,
  OWNER_PROJECTION_VERSION,
  createAgentCommsFabric,
  createFabric: createAgentCommsFabric,
  streamIdForAudience
});

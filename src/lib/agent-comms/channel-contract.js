'use strict';

// The in-memory channel and addressing contract.  Durable history, delivery
// receipts, transport, and wake decisions are deliberately outside this core.

const { containsSensitiveMaterial } = require('../providers/sensitive-local-input');

const AUTH_PURPOSE = 'toolsenabled.agent-comms.message.v1';
const KINDS = Object.freeze(['ask', 'answer', 'notice']);
const MAX_IDENTIFIER_LENGTH = 64;
const DEFAULT_MAX_CHANNEL_NAME_LENGTH = 48;
const DEFAULT_MAX_BODY_LENGTH = 4_000;
const DEFAULT_MAX_REFUSALS = 1_000;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CHANNEL_RE = /^[a-z][a-z0-9-]*$/;

/* A REFUSAL REASON IS PROSE, NOT A SECOND COPY OF ITS CODE.
 *
 * post() returns refusals as values because an agent can repair most of them,
 * but recordRefusal() used to set `reason: code`. The app deliberately hides a
 * bare identifier from visible copy, so a person saw only its generic fallback
 * and could not tell whether the message was blocked by content inspection,
 * sender verification, addressing, or reply binding. Keep the code for
 * machines; give the person the mechanism and the next valid action here.
 *
 * The final entry is a floor for a new contract refusal. It is intentionally
 * about this contract rather than guessed from code words, and still tells the
 * caller how to get a fresh admissible request. */
const REFUSAL_REASONS = Object.freeze({
  AGENT_MESSAGE_INVALID: 'The agent-message contract rejected the message fields, so nothing was sent. Correct the request shape and send it again.',
  AGENT_MESSAGE_KIND_INVALID: 'The agent-message contract did not recognise the message kind, so nothing was sent. Choose ask, answer, or notice and send it again.',
  AGENT_MESSAGE_BODY_INVALID: 'The agent-message contract rejected an empty, malformed, or overlong body, so nothing was sent. Supply a shorter non-empty message and send it again.',
  AGENT_MESSAGE_CAUSAL_PARENT_REQUIRED: 'The reply-binding check found an answer with no original question, so nothing was sent. Reply to a listed ask or send a new notice instead.',
  AGENT_MESSAGE_CAUSAL_PARENT_UNKNOWN: 'The reply-binding check could not find the original question, so nothing was sent. Refresh the conversation and reply to an ask that is still listed.',
  AGENT_MESSAGE_CAUSAL_PARENT_RESOLVER_FAILED: 'The reply-binding check could not read the original question, so nothing was sent. Restore the message history service and send the reply again.',
  AGENT_MESSAGE_CAUSAL_PARENT_INVALID: 'The reply-binding check found that this answer does not belong to that question, so nothing was sent. Reply from the addressed agent to the original ask.',
  AGENT_MESSAGE_SENSITIVE_DETECTOR_FAILED: 'The sensitive-content check could not inspect this message, so nothing was sent. Restore the local messaging service and send it again.',
  AGENT_MESSAGE_BODY_SENSITIVE: 'The sensitive-content check found credential-like material, so nothing was sent. Remove passwords, keys, and tokens and send only the non-secret instructions.',
  AGENT_MESSAGE_VERIFIER_UNAVAILABLE: 'The sender-verification service was unavailable, so nothing was sent. Restore the local messaging service and send it again.',
  AGENT_MESSAGE_VERIFIER_INVALID: 'The sender-verification service returned an unusable result, so nothing was sent. Restart the agent session and send it again.',
  AGENT_MESSAGE_AUTHENTICATION_FAILED: 'The sender-verification check did not accept this session, so nothing was sent. Start a fresh agent session and send it again.',
  AGENT_MESSAGE_SENDER_FORGED: 'The verified sender did not match the sender named by the message, so nothing was sent. Send it from the agent session named as the sender.',
  AGENT_MESSAGE_SENDER_UNKNOWN: 'The sender is not in the current agent directory, so nothing was sent. Refresh the agent tree and send from a listed running agent.',
  AGENT_MESSAGE_CHANNEL_UNKNOWN: 'The channel is not in the current agent directory, so nothing was sent. Refresh the channel list and choose one that is listed.',
  AGENT_MESSAGE_CHANNEL_MEMBERSHIP_REQUIRED: 'The sender is not a member of that channel, so nothing was sent. Join the channel first or choose one the sender belongs to.',
  AGENT_MESSAGE_RECIPIENT_UNKNOWN: 'The recipient is not in the current agent directory, so nothing was sent. Refresh the agent tree and choose a listed running recipient.'
});
const UNKNOWN_REFUSAL_REASON = 'The agent-message contract refused this message before delivery. Refresh the agent tree, correct the request it names, and send it again.';

class ChannelContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChannelContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChannelContractError(code, message);
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
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
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

function identifier(value, label, code = 'AGENT_MESSAGE_INVALID') {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_RE.test(value)) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function normalizeIdentity(value, code = 'AGENT_MESSAGE_INVALID') {
  const source = plainObject(value, code, 'agent identity');
  exactKeys(source, ['agentId', 'machineId'], code, 'agent identity');
  return Object.freeze({
    agentId: identifier(source.agentId, 'agentId', code),
    machineId: identifier(source.machineId, 'machineId', code)
  });
}

function identityKey(identity) {
  return `${identity.machineId}\u0000${identity.agentId}`;
}

function sameIdentity(left, right) {
  return left.agentId === right.agentId && left.machineId === right.machineId;
}

function formatDirectAddress(identity) {
  const normalized = normalizeIdentity(identity, 'AGENT_ADDRESS_INVALID');
  return `@${normalized.machineId}/${normalized.agentId}`;
}

function normalizeChannelName(value, maxLength, code = 'AGENT_CHANNEL_INVALID') {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || !CHANNEL_RE.test(value)
    || value.startsWith('@')) {
    fail(code, 'channel name is invalid or collides with a direct address.');
  }
  return value;
}

function normalizeAudience(value, maxChannelNameLength, code = 'AGENT_MESSAGE_INVALID') {
  const source = plainObject(value, code, 'audience');
  if (source.type === 'channel') {
    exactKeys(source, ['name', 'type'], code, 'channel audience');
    return Object.freeze({
      type: 'channel',
      name: normalizeChannelName(source.name, maxChannelNameLength, code)
    });
  }
  if (source.type === 'direct') {
    exactKeys(source, ['agent', 'type'], code, 'direct audience');
    return Object.freeze({ type: 'direct', agent: normalizeIdentity(source.agent, code) });
  }
  fail(code, 'audience type is invalid.');
}

function audienceKey(audience) {
  return audience.type === 'channel'
    ? `channel:${audience.name}`
    : `direct:${formatDirectAddress(audience.agent)}`;
}

function defaultMessageId(audience, sequence) {
  return `${audienceKey(audience)}:${sequence}`;
}

function canonicalSubmission(submission) {
  return JSON.stringify({
    audience: submission.audience,
    body: submission.body,
    causalParent: submission.causalParent,
    issuedAt: submission.issuedAt,
    kind: submission.kind,
    sender: submission.sender
  });
}

function freezeAudience(audience) {
  if (audience.type === 'channel') return Object.freeze({ type: 'channel', name: audience.name });
  return Object.freeze({ type: 'direct', agent: Object.freeze({ ...audience.agent }) });
}

function freezeMessage(message) {
  return Object.freeze({
    id: message.id,
    sender: Object.freeze({ ...message.sender }),
    audience: freezeAudience(message.audience),
    sequence: message.sequence,
    causalParent: message.causalParent,
    kind: message.kind,
    body: message.body,
    issuedAt: message.issuedAt
  });
}

function safeInteger(value, label, code = 'AGENT_MESSAGE_INVALID') {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, `${label} must be a non-negative safe integer.`);
  return value;
}

function createChannelContract({
  knownAgents = [],
  verifier = null,
  now = Date.now,
  maxChannelNameLength = DEFAULT_MAX_CHANNEL_NAME_LENGTH,
  maxBodyLength = DEFAULT_MAX_BODY_LENGTH,
  maxRefusals = DEFAULT_MAX_REFUSALS,
  messageIdFactory = defaultMessageId,
  messageResolver = null,
  sensitiveDetector = containsSensitiveMaterial
} = {}) {
  if (!Array.isArray(knownAgents) || typeof now !== 'function'
    || typeof messageIdFactory !== 'function'
    || (messageResolver !== null && typeof messageResolver !== 'function')
    || typeof sensitiveDetector !== 'function') {
    fail('AGENT_COMMS_CONFIGURATION_INVALID', 'knownAgents, now, messageIdFactory, messageResolver, and sensitiveDetector are invalid.');
  }
  if (!Number.isSafeInteger(maxChannelNameLength) || maxChannelNameLength < 1 || maxChannelNameLength > 128
    || !Number.isSafeInteger(maxBodyLength) || maxBodyLength < 1 || maxBodyLength > 100_000
    || !Number.isSafeInteger(maxRefusals) || maxRefusals < 1 || maxRefusals > 100_000) {
    fail('AGENT_COMMS_CONFIGURATION_INVALID', 'configured bounds are invalid.');
  }

  const agents = new Map();
  const channels = new Map();
  const messages = new Map();
  const nextSequences = new Map();
  const refusals = [];

  function currentTime() {
    const value = now();
    safeInteger(value, 'clock value', 'AGENT_COMMS_CLOCK_INVALID');
    return value;
  }

  function recordRefusal(code) {
    const reason = REFUSAL_REASONS[code] || UNKNOWN_REFUSAL_REASON;
    const refusal = Object.freeze({ code, reason, refusedAt: currentTime() });
    refusals.push(refusal);
    if (refusals.length > maxRefusals) refusals.splice(0, refusals.length - maxRefusals);
    return Object.freeze({ accepted: false, code, reason });
  }

  function registerAgent(identity) {
    const normalized = normalizeIdentity(identity, 'AGENT_IDENTITY_INVALID');
    const key = identityKey(normalized);
    if (agents.has(key)) return Object.freeze({ added: false, agent: Object.freeze({ ...normalized }) });
    agents.set(key, normalized);
    return Object.freeze({ added: true, agent: Object.freeze({ ...normalized }) });
  }

  for (const identity of knownAgents) registerAgent(identity);

  function requireKnownAgent(identity, code = 'AGENT_MESSAGE_AGENT_UNKNOWN') {
    if (!agents.has(identityKey(identity))) fail(code, 'agent identity is unknown.');
  }

  function createChannel(input) {
    const source = plainObject(input, 'AGENT_CHANNEL_INVALID', 'channel request');
    exactKeys(source, ['name'], 'AGENT_CHANNEL_INVALID', 'channel request');
    const name = normalizeChannelName(source.name, maxChannelNameLength);
    if (channels.has(name)) fail('AGENT_CHANNEL_EXISTS', 'channel already exists.');
    channels.set(name, { name, members: new Set() });
    return Object.freeze({ name, members: Object.freeze([]) });
  }

  function normalizeMembership(input) {
    const source = plainObject(input, 'AGENT_CHANNEL_INVALID', 'channel membership');
    exactKeys(source, ['agent', 'channel'], 'AGENT_CHANNEL_INVALID', 'channel membership');
    const name = normalizeChannelName(source.channel, maxChannelNameLength);
    const agent = normalizeIdentity(source.agent, 'AGENT_IDENTITY_INVALID');
    const channel = channels.get(name);
    if (!channel) fail('AGENT_CHANNEL_UNKNOWN', 'channel is unknown.');
    requireKnownAgent(agent, 'AGENT_CHANNEL_AGENT_UNKNOWN');
    return { channel, agent };
  }

  function joinChannel(input) {
    const { channel, agent } = normalizeMembership(input);
    const key = identityKey(agent);
    if (channel.members.has(key)) return Object.freeze({ joined: false, channel: channel.name, agent: Object.freeze({ ...agent }) });
    channel.members.add(key);
    return Object.freeze({ joined: true, channel: channel.name, agent: Object.freeze({ ...agent }) });
  }

  function leaveChannel(input) {
    const { channel, agent } = normalizeMembership(input);
    const left = channel.members.delete(identityKey(agent));
    return Object.freeze({ left, channel: channel.name, agent: Object.freeze({ ...agent }) });
  }

  function normalizeSubmission(input) {
    const source = plainObject(input, 'AGENT_MESSAGE_INVALID', 'message');
    exactKeys(source, ['audience', 'body', 'causalParent', 'issuedAt', 'kind', 'sender'], 'AGENT_MESSAGE_INVALID', 'message');
    const sender = normalizeIdentity(source.sender);
    const audience = normalizeAudience(source.audience, maxChannelNameLength);
    if (!KINDS.includes(source.kind)) fail('AGENT_MESSAGE_KIND_INVALID', 'message kind is invalid.');
    if (typeof source.body !== 'string' || source.body.length < 1 || source.body.length > maxBodyLength || source.body.includes('\u0000')) {
      fail('AGENT_MESSAGE_BODY_INVALID', 'message body is invalid or exceeds its bound.');
    }
    if (source.causalParent !== null && (typeof source.causalParent !== 'string' || source.causalParent.length < 1 || source.causalParent.length > 256)) {
      fail('AGENT_MESSAGE_CAUSAL_PARENT_INVALID', 'causal parent is invalid.');
    }
    if (source.kind === 'answer' && source.causalParent === null) {
      fail('AGENT_MESSAGE_CAUSAL_PARENT_REQUIRED', 'an answer must name its causal parent.');
    }
    safeInteger(source.issuedAt, 'issuedAt');
    return Object.freeze({
      sender,
      audience,
      causalParent: source.causalParent,
      kind: source.kind,
      body: source.body,
      issuedAt: source.issuedAt
    });
  }

  function verifySender(submission, authentication) {
    if (!verifier || typeof verifier.verify !== 'function') return 'AGENT_MESSAGE_VERIFIER_UNAVAILABLE';
    let attestation;
    try {
      attestation = verifier.verify(Object.freeze({
        purpose: AUTH_PURPOSE,
        canonicalMessage: canonicalSubmission(submission),
        authentication
      }));
    } catch {
      return 'AGENT_MESSAGE_VERIFIER_UNAVAILABLE';
    }
    if (attestation && typeof attestation.then === 'function') return 'AGENT_MESSAGE_VERIFIER_INVALID';
    if (!attestation || attestation.authenticated !== true || attestation.integrityChecked !== true) {
      return 'AGENT_MESSAGE_AUTHENTICATION_FAILED';
    }
    let verifiedSender;
    try { verifiedSender = normalizeIdentity(attestation.sender, 'AGENT_MESSAGE_AUTHENTICATION_FAILED'); }
    catch { return 'AGENT_MESSAGE_AUTHENTICATION_FAILED'; }
    return sameIdentity(verifiedSender, submission.sender) ? null : 'AGENT_MESSAGE_SENDER_FORGED';
  }

  function senderCanReplyTo(parent, sender) {
    if (parent.audience.type === 'direct') return sameIdentity(parent.audience.agent, sender);
    const channel = channels.get(parent.audience.name);
    return Boolean(channel && channel.members.has(identityKey(sender)));
  }

  function answerAudienceMatchesParent(submission, parent) {
    if (submission.audience.type === 'direct') return sameIdentity(submission.audience.agent, parent.sender);
    return parent.audience.type === 'channel' && submission.audience.name === parent.audience.name;
  }

  function post(input, authentication) {
    let submission;
    try { submission = normalizeSubmission(input); }
    catch (error) { return recordRefusal(error instanceof ChannelContractError ? error.code : 'AGENT_MESSAGE_INVALID'); }

    let sensitive = false;
    try { sensitive = sensitiveDetector(submission.body) === true; }
    catch { return recordRefusal('AGENT_MESSAGE_SENSITIVE_DETECTOR_FAILED'); }
    if (sensitive) return recordRefusal('AGENT_MESSAGE_BODY_SENSITIVE');

    const authenticationError = verifySender(submission, authentication);
    if (authenticationError) return recordRefusal(authenticationError);

    try {
      requireKnownAgent(submission.sender, 'AGENT_MESSAGE_SENDER_UNKNOWN');
      if (submission.audience.type === 'channel') {
        const channel = channels.get(submission.audience.name);
        if (!channel) fail('AGENT_MESSAGE_CHANNEL_UNKNOWN', 'channel is unknown.');
        if (!channel.members.has(identityKey(submission.sender))) {
          fail('AGENT_MESSAGE_CHANNEL_MEMBERSHIP_REQUIRED', 'sender is not a channel member.');
        }
      } else {
        requireKnownAgent(submission.audience.agent, 'AGENT_MESSAGE_RECIPIENT_UNKNOWN');
      }

      if (submission.kind === 'answer') {
        let parent = messages.get(submission.causalParent);
        if (!parent && messageResolver) {
          try { parent = messageResolver(submission.causalParent); }
          catch { fail('AGENT_MESSAGE_CAUSAL_PARENT_RESOLVER_FAILED', 'causal parent resolver failed.'); }
        }
        if (!parent) fail('AGENT_MESSAGE_CAUSAL_PARENT_UNKNOWN', 'causal parent is unknown.');
        if (parent.kind !== 'ask' || !senderCanReplyTo(parent, submission.sender) || !answerAudienceMatchesParent(submission, parent)) {
          fail('AGENT_MESSAGE_CAUSAL_PARENT_INVALID', 'answer does not validly bind its causal parent.');
        }
      }
    } catch (error) {
      return recordRefusal(error instanceof ChannelContractError ? error.code : 'AGENT_MESSAGE_INVALID');
    }

    const stream = audienceKey(submission.audience);
    const sequence = nextSequences.get(stream) || 1;
    nextSequences.set(stream, sequence + 1);
    let id;
    try { id = messageIdFactory(submission.audience, sequence); }
    catch { fail('AGENT_COMMS_CONFIGURATION_INVALID', 'messageIdFactory failed.'); }
    if (typeof id !== 'string' || id.length < 1 || id.length > 512 || id.includes('\u0000') || messages.has(id)) {
      fail('AGENT_COMMS_CONFIGURATION_INVALID', 'messageIdFactory returned an invalid or duplicate id.');
    }
    const message = freezeMessage({ ...submission, sequence, id });
    messages.set(message.id, message);
    return Object.freeze({ accepted: true, code: 'AGENT_MESSAGE_ACCEPTED', message });
  }

  function getMessage(id) {
    if (typeof id !== 'string') fail('AGENT_MESSAGE_ID_INVALID', 'message id is invalid.');
    return messages.get(id) || null;
  }

  function getRefusals() {
    return Object.freeze(refusals.map(refusal => Object.freeze({ ...refusal })));
  }

  function listChannels() {
    return Object.freeze([...channels.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(channel => Object.freeze({
        name: channel.name,
        members: Object.freeze([...channel.members]
          .map(key => agents.get(key))
          .sort((left, right) => identityKey(left).localeCompare(identityKey(right)))
          .map(identity => Object.freeze({ ...identity })))
      })));
  }

  return Object.freeze({
    createChannel,
    formatDirectAddress,
    getMessage,
    getRefusals,
    joinChannel,
    leaveChannel,
    listChannels,
    post,
    registerAgent
  });
}

module.exports = Object.freeze({
  AUTH_PURPOSE,
  ChannelContractError,
  DEFAULT_MAX_BODY_LENGTH,
  DEFAULT_MAX_CHANNEL_NAME_LENGTH,
  KINDS,
  createChannelContract,
  formatDirectAddress
});

'use strict';

const { createLocalAgentCommsRuntime, normalizeAgentId } = require('../src/lib/agent-comms/local-runtime');

const BOOLEAN_FLAGS = new Set(['all', 'once']);

class AgentMsgCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentMsgCliError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AgentMsgCliError(code, message);
}

function usage() {
  return `Usage:
  node tools/agent-msg.js send --actor <agent> (--to <agent> | --channel <name>) --body <text> [--kind notice|ask|answer] [--causal-parent <id>]
  node tools/agent-msg.js read --actor <agent> [--channel <name> | --all] [--cursor <n>] [--limit <n>]
  node tools/agent-msg.js ack --actor <agent> [--channel <name>] --message-id <id> --sequence <n> [--evidence <text>]
  node tools/agent-msg.js channels list --actor <agent>
  node tools/agent-msg.js channels create --actor <agent> --channel <name>
  node tools/agent-msg.js channels join|leave --actor <agent> --channel <name> [--agent <agent>]
  node tools/agent-msg.js designate|revoke --actor owner --agent <agent>
  node tools/agent-msg.js watch --actor <agent> [--channel <name> | --all] [--cursor <n>] [--limit <n>] [--interval-ms <n>] [--once]
`;
}

function parseArgs(argv) {
  const values = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!key || Object.hasOwn(values, key)) fail('AGENT_MSG_ARGUMENT_INVALID', `Duplicate or empty flag: ${token}`);
    if (BOOLEAN_FLAGS.has(key)) {
      values[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('AGENT_MSG_ARGUMENT_INVALID', `${token} requires a value.`);
    values[key] = value;
    index += 1;
  }
  return { positionals, values };
}

function exactFlags(values, allowed) {
  const invalid = Object.keys(values).filter(key => !allowed.includes(key));
  if (invalid.length) fail('AGENT_MSG_ARGUMENT_INVALID', `Unsupported flag(s): ${invalid.map(key => `--${key}`).join(', ')}`);
}

function required(values, key) {
  const value = values[key];
  if (typeof value !== 'string' || !value.length) fail('AGENT_MSG_ARGUMENT_INVALID', `--${key} is required.`);
  return value;
}

function integer(values, key, { defaultValue, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Object.hasOwn(values, key)) {
    if (defaultValue !== undefined) return defaultValue;
    fail('AGENT_MSG_ARGUMENT_INVALID', `--${key} is required.`);
  }
  if (!/^[0-9]+$/.test(values[key])) fail('AGENT_MSG_ARGUMENT_INVALID', `--${key} must be a non-negative integer.`);
  const value = Number(values[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('AGENT_MSG_ARGUMENT_INVALID', `--${key} is outside its allowed range.`);
  }
  return value;
}

function actor(values) {
  return normalizeAgentId(required(values, 'actor'), 'actor');
}

function runtimeFor(...agentIds) {
  return createLocalAgentCommsRuntime({ extraAgentIds: agentIds.filter(Boolean) });
}

function auth(identity) {
  return Object.freeze({ identity });
}

function audienceFor(runtime, actorId, channel) {
  return channel
    ? Object.freeze({ type: 'channel', name: channel })
    : Object.freeze({ type: 'direct', agent: runtime.identity(actorId) });
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function send(values) {
  require('../src/lib/agent-delegation-policy').assertAgentCommunicationAllowed();
  exactFlags(values, ['actor', 'body', 'causal-parent', 'channel', 'kind', 'to']);
  const senderId = actor(values);
  const recipientId = values.to === undefined ? null : normalizeAgentId(values.to, 'to');
  const channel = values.channel;
  if ((recipientId === null) === (channel === undefined)) {
    fail('AGENT_MSG_ARGUMENT_INVALID', 'Specify exactly one of --to or --channel.');
  }
  const kind = values.kind || 'notice';
  if (!['notice', 'ask', 'answer'].includes(kind)) fail('AGENT_MSG_ARGUMENT_INVALID', '--kind is invalid.');
  const runtime = runtimeFor(senderId, recipientId);
  const sender = runtime.identity(senderId);
  const message = {
    sender,
    kind,
    body: required(values, 'body'),
    ...(values['causal-parent'] === undefined ? {} : { causalParent: values['causal-parent'] })
  };
  const result = await (channel === undefined
    ? runtime.fabric.send({ ...message, recipient: runtime.identity(recipientId) }, auth(sender))
    : runtime.fabric.sendChannel({ ...message, channel }, auth(sender)));
  if (!result || result.accepted !== true) {
    fail(result && result.code ? result.code : 'AGENT_MSG_SEND_REFUSED', 'The fabric refused the message.');
  }
  return result;
}

async function read(values) {
  exactFlags(values, ['actor', 'all', 'channel', 'cursor', 'limit']);
  const actorId = actor(values);
  if (values.all && values.channel) fail('AGENT_MSG_ARGUMENT_INVALID', '--all and --channel are mutually exclusive.');
  const runtime = runtimeFor(actorId);
  const limit = integer(values, 'limit', { defaultValue: 100, min: 1, max: 1_000 });
  if (values.all) {
    if (actorId !== 'owner') fail('OWNER_VISIBILITY_OWNER_REQUIRED', '--all is the owner visibility projection.');
    return runtime.fabric.ownerProjection({
      actor: runtime.ownerActor,
      cursor: integer(values, 'cursor', { defaultValue: 0 }),
      limit
    });
  }
  const identity = runtime.identity(actorId);
  const audience = audienceFor(runtime, actorId, values.channel);
  const cursor = Object.hasOwn(values, 'cursor')
    ? integer(values, 'cursor')
    : runtime.fabric.position({ agent: identity, audience }).cursor;
  return runtime.fabric.read({ agent: identity, audience, cursor, limit });
}

async function acknowledge(values) {
  exactFlags(values, ['actor', 'channel', 'evidence', 'message-id', 'sequence']);
  const actorId = actor(values);
  const runtime = runtimeFor(actorId);
  const identity = runtime.identity(actorId);
  const result = await runtime.fabric.markRead({
    agent: identity,
    audience: audienceFor(runtime, actorId, values.channel),
    messageId: required(values, 'message-id'),
    sequence: integer(values, 'sequence', { min: 1 }),
    evidence: { source: 'agent-msg-cli', note: values.evidence || 'processed at agent boundary' }
  });
  if (!result || result.accepted !== true) {
    fail(result && result.code ? result.code : 'AGENT_MSG_ACK_REFUSED', 'The fabric refused the acknowledgement.');
  }
  return result;
}

async function channels(positionals, values) {
  if (positionals.length !== 1 || !['list', 'create', 'join', 'leave'].includes(positionals[0])) {
    fail('AGENT_MSG_ARGUMENT_INVALID', 'channels requires list, create, join, or leave.');
  }
  const action = positionals[0];
  exactFlags(values, action === 'list'
    ? ['actor']
    : (action === 'create' ? ['actor', 'channel'] : ['actor', 'agent', 'channel']));
  const actorId = actor(values);
  const targetId = values.agent === undefined ? actorId : normalizeAgentId(values.agent, 'agent');
  const runtime = runtimeFor(actorId, targetId);
  if (action === 'list') return runtime.fabric.listChannels({ agent: runtime.identity(actorId) });
  const channel = required(values, 'channel');
  if (action === 'create') {
    const created = runtime.fabric.createChannel({ name: channel, actor: runtime.identity(actorId) });
    const joined = runtime.fabric.joinChannel({ channel, agent: runtime.identity(actorId) });
    return Object.freeze({ created, joined });
  }
  return action === 'join'
    ? runtime.fabric.joinChannel({ channel, agent: runtime.identity(targetId) })
    : runtime.fabric.leaveChannel({ channel, agent: runtime.identity(targetId) });
}

async function designation(command, values) {
  exactFlags(values, ['actor', 'agent']);
  const actorId = actor(values);
  if (actorId !== 'owner') fail('OWNER_ACTOR_REQUIRED', 'Designation changes require --actor owner.');
  const targetId = normalizeAgentId(required(values, 'agent'), 'agent');
  const runtime = runtimeFor(actorId, targetId);
  const input = { actor: runtime.ownerActor, agent: runtime.identity(targetId) };
  return command === 'designate'
    ? runtime.fabric.designateOwnerAgent(input)
    : runtime.fabric.revokeOwnerAgent(input);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function watch(values) {
  exactFlags(values, ['actor', 'all', 'channel', 'cursor', 'interval-ms', 'limit', 'once']);
  const intervalMs = integer(values, 'interval-ms', { defaultValue: 1_000, min: 100, max: 60_000 });
  let cursor = integer(values, 'cursor', { defaultValue: 0 });
  do {
    const result = await read({
      actor: values.actor,
      ...(values.all ? { all: true } : {}),
      ...(values.channel === undefined ? {} : { channel: values.channel }),
      cursor: String(cursor),
      ...(values.limit === undefined ? {} : { limit: values.limit })
    });
    const page = values.all ? result.journal : result;
    if (!page || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < 0) {
      fail('AGENT_MSG_READ_CURSOR_INVALID', 'The fabric did not provide a valid next cursor.');
    }
    output(result);
    cursor = page.nextCursor;
    if (values.once) return null;
    await wait(intervalMs);
  } while (true);
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  const parsed = parseArgs(rest);
  let result;
  if (command === 'send') result = await send(parsed.values);
  else if (command === 'read') result = await read(parsed.values);
  else if (command === 'ack') result = await acknowledge(parsed.values);
  else if (command === 'channels') result = await channels(parsed.positionals, parsed.values);
  else if (command === 'designate' || command === 'revoke') result = await designation(command, parsed.values);
  else if (command === 'watch') result = await watch(parsed.values);
  else fail('AGENT_MSG_COMMAND_UNKNOWN', `Unknown command: ${command}`);
  if (result !== null) output(await result);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error && typeof error.code === 'string' ? error.code : 'AGENT_MSG_FAILED',
      message: error && typeof error.message === 'string' ? error.message : 'Agent messaging failed.'
    })}\n`);
    process.exitCode = 2;
  });
}

module.exports = Object.freeze({ main, parseArgs, usage });

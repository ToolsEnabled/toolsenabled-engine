'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

// The provider freezes its sanctioned machine table when the module loads.
// Install the harness's validated two-machine registry for that one load, then
// immediately restore the real resolver so no later read is shadowed.
const { FIXTURE_MACHINES, installFixtureRegistry } = require('./helpers/comms-harness');
const restoreServiceRegistry = installFixtureRegistry();
let agentComms;
try {
  agentComms = require('../../src/lib/providers/agent-comms');
} finally {
  restoreServiceRegistry();
}
const { createAgentCommsProvider, openMessage, sealMessage, RELAY_CHANNEL } = agentComms;
const { createStore } = require('../../sidecars/link-bus/store');
const presence = require('../../src/lib/agent-presence');

const ROOT = path.resolve(__dirname, '..', '..');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function memoryStore() {
  const entries = new Map();
  return Object.freeze({
    getMemory({ namespace, key }) {
      const value = entries.get(`${namespace}\0${key}`);
      return value ? clone(value) : null;
    },
    setMemory({ namespace, key, value, expectedRevision }) {
      const lookup = `${namespace}\0${key}`;
      const prior = entries.get(lookup);
      const revision = prior ? prior.revision : 0;
      if (revision !== expectedRevision) throw Object.assign(new Error('revision conflict'), { code: 'MEMORY_REVISION_CONFLICT' });
      const entry = { namespace, key, value: clone(value), revision: revision + 1 };
      entries.set(lookup, entry);
      return { entry: clone(entry), created: !prior, replayed: false };
    }
  });
}

function relayRequest(store, token) {
  return async descriptor => {
    const url = new URL(descriptor.path, 'http://relay.test');
    if (descriptor.method === 'POST') {
      const body = JSON.parse(descriptor.body);
      body.message = sealMessage(token, body.message);
      const record = store.append(body);
      descriptor.onRequestSent();
      return { statusCode: 200, body: JSON.stringify({ id: `${record.channel}:${record.sequence}` }) };
    }
    const page = store.list({
      channel: url.searchParams.get('channel'),
      cursor: url.searchParams.get('cursor'),
      limit: Number(url.searchParams.get('limit'))
    });
    page.messages = page.messages.map(record => ({ ...record, ...openMessage(token, record.message) }));
    return { statusCode: 200, body: JSON.stringify(page) };
  };
}

test('provider sends, reads, and acknowledges a notice through the relay transport', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-provider-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = createStore({ stateDir: path.join(directory, 'relay') });
  const machineA = createAgentCommsProvider({
    localMachine: { address: FIXTURE_MACHINES['machine-a'].address, machineId: 'machine-a' },
    stateStore: memoryStore(),
    tokenLoader: () => 'test-link-bus-token-value',
    requestPort: relayRequest(relay, 'test-link-bus-token-value'),
    stateFile: path.join(directory, 'broker-a.json'),
    now: () => 1_900_000_000_000
  });
  const machineB = createAgentCommsProvider({
    localMachine: { address: FIXTURE_MACHINES['machine-b'].address, machineId: 'machine-b' },
    stateStore: memoryStore(),
    tokenLoader: () => 'test-link-bus-token-value',
    requestPort: relayRequest(relay, 'test-link-bus-token-value'),
    stateFile: path.join(directory, 'broker-b.json'),
    now: () => 1_900_000_000_000
  });

  const sent = await machineA.send({ recipientActor: 'claude', recipientMachine: 'machine-b', body: 'fabric hello' }, { agentActor: 'codex' });
  assert.equal(sent.accepted, true);
  assert.equal(sent.broker.delivered, true);
  assert.equal(relay.totalCount(), 1);

  const read = await machineB.read({ cursor: 0 }, { agentActor: 'claude' });
  assert.equal(read.inbound.acceptedCount, 1);
  assert.equal(read.page.records.length, 1);
  assert.equal(read.page.records[0].message.body, 'fabric hello');
  assert.equal(read.page.records[0].message.audience.agent.agentId, 'claude-machine-b');

  const acknowledged = await machineB.acknowledge({
    messageId: read.page.records[0].message.id,
    sequence: read.page.records[0].sequence,
    evidence: 'processed by test recipient'
  }, { agentActor: 'claude' });
  assert.equal(acknowledged.accepted, true);
  assert.equal(acknowledged.cursor, 1);
  assert.equal(RELAY_CHANNEL, 'agent_comms_v1');
});

test('provider refuses an unbound actor instead of accepting a caller-selected sender', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-provider-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = createStore({ stateDir: path.join(directory, 'relay') });
  const provider = createAgentCommsProvider({
    localMachine: { address: FIXTURE_MACHINES['machine-a'].address, machineId: 'machine-a' },
    stateStore: memoryStore(),
    tokenLoader: () => 'test-link-bus-token-value',
    requestPort: relayRequest(relay, 'test-link-bus-token-value'),
    stateFile: path.join(directory, 'broker.json')
  });
  await assert.rejects(
    provider.send({ recipientActor: 'claude', recipientMachine: 'machine-b', body: 'no forged sender' }, {}),
    error => error && error.code === 'AGENT_COMMS_ACTOR_REQUIRED'
  );
  assert.equal(relay.totalCount(), 0);
});

test('provider refuses same-machine delivery so relay replay cannot duplicate local history', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-provider-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = createStore({ stateDir: path.join(directory, 'relay') });
  const provider = createAgentCommsProvider({
    localMachine: { address: FIXTURE_MACHINES['machine-a'].address, machineId: 'machine-a' },
    stateStore: memoryStore(),
    tokenLoader: () => 'test-link-bus-token-value',
    requestPort: relayRequest(relay, 'test-link-bus-token-value'),
    stateFile: path.join(directory, 'broker.json')
  });
  const result = await provider.send({
    recipientActor: 'claude', recipientMachine: 'machine-a', body: 'use legacy local board'
  }, { agentActor: 'codex' });
  /* The refusal and the silence on the relay are the properties under test and
     both still hold. What is asserted loosely now is the ADVICE that travels
     with the refusal: on a one-machine installation this code is the answer to
     the only recipient the tool's own enum offers, so a refusal that named no
     alternative was a dead end. It now names the local tool. Pinning the whole
     object by deepEqual made that improvement look like a regression. */
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'AGENT_COMMS_CROSS_MACHINE_RECIPIENT_REQUIRED');
  assert.equal(result.useInstead, 'agent_comms.send_local');
  assert.equal(relay.totalCount(), 0);
});

test('the single-machine refusals answer before the relay credential is loaded', async t => {
  /* THE STOCK INSTALL, NOT A CONTRIVANCE. On a shipped one-machine registry the
     only recipient the tool's enum can name is the local machine, and no relay
     credential is ever provisioned -- the default tokenLoader throws
     SECRET_NOT_CONFIGURED. Measured against the sealed payload (2026-08-19):
     build() ran before the recipient check, so every send answered
     AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE and the one honest refusal in the
     file -- "use agent_comms.send_local" -- was unreachable on every machine
     that needed it. The recipient's identity is registry knowledge, not relay
     knowledge; it must be answered without touching the credential. */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-provider-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const throwingLoader = () => {
    const error = new Error("Secret 'custom.link_bus_bridge_token' is not configured.");
    error.code = 'SECRET_NOT_CONFIGURED';
    throw error;
  };
  const provider = createAgentCommsProvider({
    localMachine: { address: FIXTURE_MACHINES['machine-a'].address, machineId: 'machine-a' },
    stateStore: memoryStore(),
    tokenLoader: throwingLoader,
    stateFile: path.join(directory, 'broker.json')
  });
  const result = await provider.send({
    recipientActor: 'claude', recipientMachine: 'machine-a', body: 'local hello'
  }, { agentActor: 'codex' });
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'AGENT_COMMS_CROSS_MACHINE_RECIPIENT_REQUIRED');
  assert.equal(result.useInstead, 'agent_comms.send_local');
  /* An unregistered recipient is likewise a registry answer, not a credential
     answer: the person typo'd or the peer is not enrolled, and saying "the
     relay credential is unavailable" for that sends them to the wrong repair. */
  await assert.rejects(
    provider.send({ recipientActor: 'claude', recipientMachine: 'machine-nowhere', body: 'x' }, { agentActor: 'codex' }),
    error => error && error.code === 'AGENT_COMMS_MACHINE_UNKNOWN'
  );
});

test('a non-ASCII hostname still yields a local machine identity', () => {
  const localRuntime = require('../../src/lib/agent-comms/local-runtime');
  /* A computer named in the person's own alphabet must not brick the local
     comms runtime; machine-record.js already answers the same input with
     'this-machine'. An EXPLICIT machine id that normalizes to nothing is the
     person's configuration being wrong and still refuses loudly. */
  for (const foreign of ['Ноутбук', 'ノートPC', '田中のPC']) {
    const derived = localRuntime.configuredMachineId({ env: {}, hostname: () => foreign });
    assert.equal(typeof derived, 'string');
    assert.notEqual(derived, '', `hostname ${foreign} must not derive an empty machine id`);
  }
  assert.equal(localRuntime.configuredMachineId({ env: {}, hostname: () => 'Equipo-de-Ana' }), 'equipo-de-ana');
  assert.throws(
    () => localRuntime.configuredMachineId({ env: { TOOLSENABLED_MACHINE_ID: 'Ноутбук' }, hostname: () => 'fine-host' }),
    error => error && error.code === 'AGENT_COMMS_MACHINE_ID_UNAVAILABLE',
    'a configured id that normalizes to nothing is refused, not silently renamed'
  );
});

test('a failed hostname lookup refuses instead of inventing a local machine identity', () => {
  const localRuntime = require('../../src/lib/agent-comms/local-runtime');
  assert.throws(
    () => localRuntime.configuredMachineId({
      env: {},
      hostname: () => { throw Object.assign(new Error('hostname unavailable'), { code: 'EHOSTDOWN' }); }
    }),
    error => error &&
      error.code === 'AGENT_COMMS_MACHINE_ID_UNAVAILABLE' &&
      error.details.causeCode === 'EHOSTDOWN',
    'a hostname read failure is unmeasured, not the definite identity this-machine'
  );
});

test('agent-msg CLI operates durable local channels, owner visibility, designation, revocation, ack, watch, and the existing presence mailbox', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-msg-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.sqlite3');
  const brokerFile = path.join(directory, 'broker.json');
  const presenceFile = path.join(directory, 'presence.json');
  const mailboxDir = path.join(directory, 'mailbox');
  const progressDir = path.join(directory, 'progress');
  presence.register({
    agentId: 'terra',
    runId: '11111111-1111-4111-8111-111111111111',
    role: 'builder',
    tier: 'gpt-5.6-terra',
    reportsTo: 'codex-manager-seat-1',
    dispatcher: 'codex-manager-seat-1',
    lane: 'r1162-cli-test',
    territory: 'tests/agent-comms',
    currentTask: 'agent-msg-cli-test',
    brief: path.join(directory, 'brief.md'),
    consoleLog: path.join(directory, 'console.log'),
    worktree: directory,
    launchSpec: path.join(directory, 'launch.json'),
    pid: null,
    startedAt: 1_900_000_000_000,
    lastHeartbeat: 1_900_000_000_000,
    status: 'running',
    exitCode: null,
    lastVerdict: null,
    terminalAt: null,
    staleReason: null,
    mailboxOffset: 0,
    respawnCount: 0,
    verdictConsumedAt: null
  }, { file: presenceFile, progressDir });

  const env = {
    ...process.env,
    TOOLSENABLED_STATE_PATH: stateFile,
    TOOLSENABLED_AGENT_COMMS_BROKER_FILE: brokerFile,
    TOOLSENABLED_AGENT_PRESENCE_FILE: presenceFile,
    TOOLSENABLED_AGENT_MAILBOX_DIR: mailboxDir,
    TOOLSENABLED_AGENT_USEFUL_PROGRESS_DIR: progressDir,
    TOOLSENABLED_MACHINE_ID: 'test-machine'
  };
  function run(args, expectedStatus = 0) {
    const result = spawnSync(process.execPath, ['tools/agent-msg.js', ...args], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(result.status, expectedStatus, `command ${args.join(' ')} failed: ${result.stderr}`);
    return expectedStatus === 0 ? JSON.parse(result.stdout) : JSON.parse(result.stderr);
  }

  run(['channels', 'create', '--actor', 'codex', '--channel', 'operations']);
  run(['channels', 'join', '--actor', 'codex', '--agent', 'terra', '--channel', 'operations']);
  const sent = run(['send', '--actor', 'codex', '--channel', 'operations', '--body', 'durable CLI hello']);
  assert.equal(sent.code, 'FABRIC_CHANNEL_DURABLE');
  const mailbox = presence.drainMailbox('terra', 0, { mailboxDir });
  assert.equal(mailbox.entries.length, 1);
  assert.match(mailbox.entries[0].prompt, /durable CLI hello/);

  const unread = run(['read', '--actor', 'terra', '--channel', 'operations']);
  assert.equal(unread.records.length, 1);
  const acked = run([
    'ack', '--actor', 'terra', '--channel', 'operations',
    '--message-id', unread.records[0].message.id,
    '--sequence', String(unread.records[0].sequence)
  ]);
  assert.equal(acked.code, 'FABRIC_READ_MARKED');
  assert.equal(run(['read', '--actor', 'terra', '--channel', 'operations']).records.length, 0);

  const sensitive = run([
    'send', '--actor', 'codex', '--channel', 'operations', '--body', 'api_key=not-a-real-value'
  ], 2);
  assert.equal(sensitive.error, 'AGENT_MESSAGE_BODY_SENSITIVE');
  const notOwner = run(['designate', '--actor', 'codex', '--agent', 'terra'], 2);
  assert.equal(notOwner.error, 'OWNER_ACTOR_REQUIRED');
  assert.equal(run(['designate', '--actor', 'owner', '--agent', 'terra']).code, 'OWNER_CHANNEL_DESIGNATED');
  run(['send', '--actor', 'owner', '--channel', 'owner-special', '--body', 'special channel hello']);
  assert.equal(run(['read', '--actor', 'terra', '--channel', 'owner-special', '--cursor', '0']).records.length, 1);
  assert.equal(run(['revoke', '--actor', 'owner', '--agent', 'terra']).code, 'OWNER_CHANNEL_REVOKED');
  const revoked = run(['read', '--actor', 'terra', '--channel', 'owner-special', '--cursor', '0'], 2);
  assert.equal(revoked.error, 'OWNER_CHANNEL_NOT_DESIGNATED');

  const ownerView = run(['read', '--actor', 'owner', '--all', '--cursor', '0']);
  assert.deepEqual(ownerView.journal.records.map(record => record.message.message.body), [
    'durable CLI hello',
    'special channel hello'
  ]);
  assert.deepEqual(ownerView.designations.events.map(event => event.action), ['DESIGNATED', 'REVOKED']);
  const watched = run(['watch', '--actor', 'owner', '--all', '--cursor', '0', '--once']);
  assert.equal(watched.schemaVersion, 1);
  assert.equal(watched.journal.records.length, 2);
});

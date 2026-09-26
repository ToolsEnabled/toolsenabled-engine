// EXECUTABLE CHANGE
//
// DISCRIMINATION REPORT (testcanfail-tests-agent-comms-relay-edge-js)
// Strengthened the forged-envelope rejection below. Mutation applied to the
// code under test: openMessage reported AGENT_COMMS_RELAY_RESPONSE_INVALID in
// place of AGENT_COMMS_RELAY_AUTHENTICATION_FAILED. Before this change the
// whole file remained green, including:
//   “✔ a relay record whose authentication does not verify is never delivered
//   into history”
// After this change the mutation is rejected with:
//   “error: |-
//     The forged envelope, rather than an unrelated transport failure, caused
//     the refusal.
//     + actual - expected
//     + 'AGENT_COMMS_RELAY_RESPONSE_INVALID'
//     - 'AGENT_COMMS_RELAY_AUTHENTICATION_FAILED'”
// The source mutation was restored byte-for-byte (both SHA-256 values were
// fd3fa43eeb252901d1a896ad9ddfd7d2b4ad6bfd564839146fd24aae093eba01).
// The restored-source run finished with:
//   “ℹ tests 9”, “ℹ pass 9”, and “ℹ fail 0”.
//
// Shape census:
//   (1) NOT-FOUND — the only assertion loop iterates a fixed, non-empty literal.
//   (2) FOUND/FIXED — the forged-envelope predicate accepted every error whose
//       code merely began TRANSPORT_RELAY_; that was the subject's own generic
//       failure output and did not identify authentication as the cause.
//   (3) NOT-FOUND — no test try/catch or optional chain swallows a failure.
//   (4) NOT-FOUND — the registry/credential/state seams do not replace the
//       socket, relay transport, authentication verifier, fabric, or broker
//       being asserted on.
//   (5) NOT-FOUND — the file has no skip or platform precondition guard.
//   (6) NOT-FOUND — expected values are literals independent of product code.
// Preconditions: the default Node.js v20.20.2 lacks node:sqlite, so the
// required executable runs used the installed Node.js v24.15.0.

'use strict';

// THE CROSS-MACHINE HALF, OVER A REAL EDGE, WITHOUT A LIVE RELAY CREDENTIAL.
//
// THE CONSTRAINT THIS SUITE EXISTS TO REMOVE. Exercised live on 2026-08-23,
// agent_comms.read on this machine answered "The configured sign-in needs to
// be refreshed by its owner." The cross-machine channel therefore cannot be
// driven against the real shared bus here at all -- and a harness that only
// runs when a live relay credential happens to be valid is a harness nobody
// runs, which is how the relay half came to have no end-to-end coverage.
//
// SO THE EDGE IS REAL AND THE ACCOUNT IS INJECTED. This suite starts the
// SHIPPED sidecars/link-bus server on a loopback socket with a test bearer
// token, and drives it with the SHIPPED src/lib/providers/agent-comms.js
// client -- no injected requestPort. Real sockets, real Bearer auth, real
// HMAC sealing and opening, the real durable NDJSON store, the real relay
// transport, the real fabric, broker, history and positioned read. What is
// injected is only the credential (a literal, never a vault read), the state
// locations, and the two-machine service registry the shipped one-machine
// default cannot supply.
//
// THE ONE SEAM THAT HAD TO BE FAKED, AND WHY IT IS NOT A MOCK OF THE
// SUBSYSTEM. src/lib/providers/agent-comms.js builds its machine table once,
// at module load, from machineAddressPolicy(); createAgentCommsProvider takes
// resolveServiceFn, tokenLoader, stateStore, stateFile and requestPort as
// options but takes no machine list. The shipped config/service-registry.json
// declares exactly one machine, so no caller on a stock checkout can name a
// peer. The fixture is therefore seeded through require.cache the way
// tests/link-bus-smoke-test.js already seeds one, DELEGATING to the real
// resolver so the machine policy under test is still built by shipped code.
// The first test below pins that the fixture actually applied, because if it
// silently stopped applying every assertion here would start passing or
// failing for reasons that have nothing to do with agent comms.

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const harness = require('./helpers/comms-harness');

// The registry fixture must be in place BEFORE either module below is loaded:
// the link-bus server resolves its default machine and peer at require time,
// and the provider freezes its machine table at require time. Restored
// immediately afterwards so nothing else in this process reads a shadowed
// resolver.
const restoreRegistry = harness.installFixtureRegistry();
let linkBus;
let linkBusStore;
let agentComms;
try {
  linkBus = require('../../sidecars/link-bus/server');
  ({ createStore: linkBusStore } = require('../../sidecars/link-bus/store'));
  agentComms = require('../../src/lib/providers/agent-comms');
} finally {
  restoreRegistry();
}

const NOW_MS = 1_900_000_000_000;
const TOKEN = harness.TEST_RELAY_TOKEN;

function providerFactory(directory, port) {
  return function makeProvider(machineId, {
    stateStore = harness.memoryStateStore(),
    stateFile = path.join(directory, `broker-${machineId}-${Math.random().toString(16).slice(2)}.json`),
    token = TOKEN
  } = {}) {
    return agentComms.createAgentCommsProvider({
      localMachine: { address: harness.FIXTURE_MACHINES[machineId].address, machineId },
      stateStore,
      stateFile,
      tokenLoader: () => token,
      // An explicit host and port is the override the provider documents for a
      // caller that legitimately needs one. requestPort is deliberately NOT
      // supplied, so boundedHttpRequest, the bearer header, the HMAC envelope
      // and node:http all run for real.
      relayHost: '127.0.0.1',
      relayPort: port,
      now: () => NOW_MS
    });
  };
}

async function standUp(t) {
  const directory = harness.workspace(t, 'agent-comms-relay-edge-');
  const bus = await harness.startLinkBus({ linkBus, createStore: linkBusStore, directory });
  t.after(() => bus.close());
  return { bus, directory, makeProvider: providerFactory(directory, bus.port) };
}

test('the machine table under test came from the fixture, not from this machine', () => {
  /* If the stand-in ever stops applying, this suite falls back to whatever the
     installed service registry declares -- one machine on a stock checkout --
     and every cross-machine assertion below turns into a refusal that looks
     like a subsystem defect. Pin it so that can never go unseen. */
  assert.deepEqual(agentComms.MACHINES.map(machine => machine.machineId).sort(), ['machine-a', 'machine-b']);
  assert.deepEqual(agentComms.MACHINES.map(machine => machine.address).sort(), ['127.0.0.1', '203.0.113.1']);
  assert.equal(agentComms.RELAY_CHANNEL, 'agent_comms_v1');
});

test('a notice crosses a real socket and arrives once, intact, and addressed to the right agent', async t => {
  const { bus, makeProvider } = await standUp(t);
  const machineA = makeProvider('machine-a');
  const machineB = makeProvider('machine-b');

  const sent = await machineA.send({
    recipientActor: 'claude', recipientMachine: 'machine-b', body: 'over the wire'
  }, { agentActor: 'codex' });
  assert.equal(sent.accepted, true);
  assert.equal(sent.broker.delivered, true, 'delivered means the relay assigned this message a sequence');
  assert.equal(bus.server.listening, true);

  const read = await machineB.read({ cursor: 0 }, { agentActor: 'claude' });
  assert.equal(read.inbound.acceptedCount, 1, 'exactly one record was drained off the relay and verified');
  assert.equal(read.inbound.refusedCount, 0);
  assert.equal(read.page.records.length, 1, 'and exactly one landed in durable fabric history');
  const record = read.page.records[0];
  assert.equal(record.message.body, 'over the wire');
  assert.equal(record.message.audience.agent.agentId, 'claude-machine-b');
  assert.equal(record.message.sender.agentId, 'codex-machine-a');

  const acknowledged = await machineB.acknowledge({
    messageId: record.message.id,
    sequence: record.sequence,
    evidence: 'processed by the relay edge harness'
  }, { agentActor: 'claude' });
  assert.equal(acknowledged.accepted, true);
  assert.equal(acknowledged.cursor, 1);
});

test('the relay keeps order, and the durable cursor survives a restart without re-delivering', async t => {
  const { directory, makeProvider } = await standUp(t);
  const machineA = makeProvider('machine-a');
  // The recipient's two durable artefacts, shared across the "restart" below.
  const durable = {
    stateStore: harness.memoryStateStore(),
    stateFile: path.join(directory, 'broker-machine-b-restart.json')
  };

  for (const body of ['one', 'two', 'three']) {
    const sent = await machineA.send({ recipientActor: 'claude', recipientMachine: 'machine-b', body }, { agentActor: 'codex' });
    assert.equal(sent.accepted, true, `send of ${body} must be accepted`);
  }

  const machineB = makeProvider('machine-b', durable);
  const first = await machineB.read({ cursor: 0 }, { agentActor: 'claude' });
  assert.deepEqual(first.page.records.map(record => record.message.body), ['one', 'two', 'three'],
    'the relay preserves the order the sender used');
  assert.deepEqual(first.page.records.map(record => record.sequence), [1, 2, 3]);

  /* THE RESTART. A new provider over the SAME durable state is what the tool
     surface actually does on the next MCP call. The relay channel still holds
     all three messages; the stored cursor is the only thing standing between
     "read my inbox" and three duplicates in it. */
  const restarted = makeProvider('machine-b', durable);
  const second = await restarted.read({ cursor: 0 }, { agentActor: 'claude' });
  assert.equal(second.inbound.acceptedCount, 0, 'a restart re-ingests nothing it has already taken off the relay');
  assert.equal(second.inbound.status, 'CAUGHT_UP');
  assert.deepEqual(second.page.records.map(record => record.message.body), ['one', 'two', 'three'],
    'and durable history still holds exactly three, not six');
});

test('a credential the relay rejects is reported as a refusal, never as an empty inbox', async t => {
  const { makeProvider } = await standUp(t);
  const machineA = makeProvider('machine-a');
  await machineA.send({ recipientActor: 'claude', recipientMachine: 'machine-b', body: 'waiting to be read' }, { agentActor: 'codex' });

  /* THE LIVE CONDITION, REPRODUCED. Exercised on this machine the same day this
     suite was written, agent_comms.read answered "The configured sign-in needs
     to be refreshed by its owner." The only unacceptable answer to a rejected
     credential is a successful read of an empty inbox: a person told their
     inbox is empty stops looking, and the message that was waiting for them is
     still waiting. */
  const stale = makeProvider('machine-b', { token: 'a-stale-token-that-the-relay-will-not-accept' });
  await assert.rejects(
    () => stale.read({ cursor: 0 }, { agentActor: 'claude' }),
    error => {
      assert.equal(error.code, 'TRANSPORT_RELAY_READ_REJECTED', 'the refusal names the relay read, not a generic failure');
      assert.equal(error.details.statusCode, 401, 'and carries the status that says which repair is needed');
      return true;
    }
  );

  // The holder of the right credential still sees the message that was there
  // all along, which is what makes the refusal above a refusal and not a loss.
  const machineB = makeProvider('machine-b');
  const read = await machineB.read({ cursor: 0 }, { agentActor: 'claude' });
  assert.deepEqual(read.page.records.map(record => record.message.body), ['waiting to be read']);
});

test('a relay record whose authentication does not verify is never delivered into history', async t => {
  const { bus, directory, makeProvider } = await standUp(t);
  const durable = {
    stateStore: harness.memoryStateStore(),
    stateFile: path.join(directory, 'broker-machine-b-forged.json')
  };

  /* A RECORD ON THE SHARED BUS THAT THIS MACHINE'S TOKEN CANNOT OPEN. The bus
     itself is content-agnostic -- it stores a string -- so the only thing
     standing between a forged envelope and a delivered message is the HMAC the
     client checks after the bytes come back. Posted through the real HTTP
     surface, sealed under an attacker's token. */
  const forgedBody = 'forged-envelope-must-never-be-delivered';
  const forged = agentComms.sealMessage(
    Buffer.from('an-attacker-token-value-that-is-not-ours', 'utf8'),
    JSON.stringify({
      audience: { type: 'direct', agent: { agentId: 'claude-machine-b', machineId: 'machine-b' } },
      body: forgedBody,
      causalParent: null,
      issuedAt: NOW_MS,
      kind: 'notice',
      sender: { agentId: 'codex-machine-a', machineId: 'machine-a' }
    })
  );
  const posted = await postToBus(bus.port, {
    channel: agentComms.RELAY_CHANNEL,
    sender: 'agent-comms-machine-a',
    message: forged,
    sentAt: new Date(NOW_MS).toISOString()
  });
  assert.equal(posted.statusCode, 200, 'the bus accepts any string; verification is the client\'s job');

  const machineB = makeProvider('machine-b', durable);
  await assert.rejects(
    () => machineB.read({ cursor: 0 }, { agentActor: 'claude' }),
    error => {
      assert.equal(error.code, 'TRANSPORT_RELAY_REQUEST_FAILED',
        'the verified relay response failed, rather than an unrelated transport operation');
      assert.equal(error.details.relayCode, 'AGENT_COMMS_RELAY_AUTHENTICATION_FAILED',
        'the forged envelope, rather than an unrelated transport failure, caused the refusal');
      return true;
    },
    'an unverifiable record is refused rather than delivered'
  );
  assert.doesNotMatch(durable.stateStore.dump(), new RegExp(forgedBody),
    'and nothing about it reached durable fabric history, on any stream');
});

test('a send the relay could not take is never reported as delivered', async t => {
  const directory = harness.workspace(t, 'agent-comms-relay-outage-');
  const port = await harness.reservePort();
  const makeProvider = providerFactory(directory, port);
  const machineA = makeProvider('machine-a');

  /* NOTHING IS LISTENING. This is the ordinary case -- the peer is off, the
     bus is restarting -- and the only wrong answer is "delivered". */
  const sent = await machineA.send({
    recipientActor: 'claude', recipientMachine: 'machine-b', body: 'sent while the relay was down'
  }, { agentActor: 'codex' });
  assert.equal(sent.broker.delivered, false, 'an unreachable relay is never delivery evidence');
  assert.equal(sent.broker.code, 'BROKER_TRANSPORT_FAILED');
  assert.equal(sent.broker.state, 'SENT', 'and the message stays durably SENT rather than being dropped');
  assert.equal(sent.code, 'BROKER_TRANSPORT_FAILED', 'the code the caller reads is the transport failure, not a success');

  // The relay comes back. Nothing was invented on it while it was away.
  const bus = await harness.startLinkBus({ linkBus, createStore: linkBusStore, directory, port });
  t.after(() => bus.close());
  const machineB = makeProvider('machine-b');
  const read = await machineB.read({ cursor: 0 }, { agentActor: 'claude' });
  assert.deepEqual(read.page.records, [], 'a message the relay never accepted is not on the relay');
});

test('a message spooled during an outage is actually delivered once the relay returns', async t => {
  /* THE TEST ABOVE STOPS EXACTLY WHERE THIS DEFECT STARTS. It proves a send the
     relay could not take is spooled rather than lost or claimed as delivered --
     and that was the whole story, forever. The outbound spool had no drainer:
     fabric.drain() existed and nothing in the product called it, so a message
     queued during an outage was never delivered by anything, at any later time.
     Measured before the fix: relay down, send, relay back, both sides poll, and
     the recipient's inbox stayed empty permanently.

     What makes it a customer-visible defect rather than a latent one is the
     field a caller reads first. The send reports the message durably SENT, and
     the person is entitled to read that as "it will go when the bus is back". */
  const directory = harness.workspace(t, 'agent-comms-spool-drain-');
  const port = await harness.reservePort();
  const makeProvider = providerFactory(directory, port);
  const machineA = makeProvider('machine-a');

  const sent = await machineA.send({
    recipientActor: 'claude', recipientMachine: 'machine-b', body: 'queued while the bus was down'
  }, { agentActor: 'codex' });
  assert.equal(sent.broker.delivered, false, 'precondition: the relay could not take it');
  assert.equal(sent.broker.state, 'SENT', 'precondition: and it was spooled rather than dropped');

  // The bus comes back, and the sender does the ordinary thing: it polls.
  const bus = await harness.startLinkBus({ linkBus, createStore: linkBusStore, directory, port });
  t.after(() => bus.close());

  const senderPoll = await machineA.read({ cursor: 0 }, { agentActor: 'codex' });
  assert.ok(senderPoll.outbound, 'polling reports what happened to the outbound spool, rather than saying nothing');

  /* THE PROPERTY, AND IT IS THE RECIPIENT'S, NOT THE SENDER'S. A drain that
     reported success while the message stayed on this machine would be the same
     defect wearing a receipt, so the assertion is made on the far side. */
  const machineB = makeProvider('machine-b');
  const delivered = await machineB.read({ cursor: 0 }, { agentActor: 'claude' });
  assert.equal(delivered.page.records.length, 1,
    'the message spooled during the outage reaches the recipient once the relay returns');
  assert.equal(delivered.page.records[0].message.body, 'queued while the bus was down',
    'and it arrives intact, not as a placeholder or a retry stub');
});

test('a still-unreachable relay leaves the reader their inbox rather than failing the poll', async t => {
  /* The drain is fail-open on purpose. A reader whose own inbox is fine must
     not lose it because an unrelated outbound message could not go out -- that
     would turn one stuck send into a total loss of the comms surface. */
  const directory = harness.workspace(t, 'agent-comms-drain-failopen-');
  const port = await harness.reservePort();
  const makeProvider = providerFactory(directory, port);
  const machineA = makeProvider('machine-a');

  await machineA.send({
    recipientActor: 'claude', recipientMachine: 'machine-b', body: 'still stuck'
  }, { agentActor: 'codex' });

  // Relay never comes back. The poll must still answer.
  const poll = await machineA.read({ cursor: 0 }, { agentActor: 'codex' });
  assert.ok(poll.page, 'the reader still gets a page');
  assert.deepEqual(poll.page.records, [], 'an empty one, honestly');
  assert.ok(poll.outbound, 'and the failed drain is reported rather than swallowed');
});

test('the cross-machine messenger refuses a local recipient before it loads any credential', async t => {
  const directory = harness.workspace(t, 'agent-comms-relay-local-');
  const port = await harness.reservePort();
  let credentialLoaded = false;
  const provider = agentComms.createAgentCommsProvider({
    localMachine: { address: '127.0.0.1', machineId: 'machine-a' },
    stateStore: harness.memoryStateStore(),
    stateFile: path.join(directory, 'broker.json'),
    tokenLoader: () => { credentialLoaded = true; return TOKEN; },
    relayHost: '127.0.0.1',
    relayPort: port,
    now: () => NOW_MS
  });
  const refused = await provider.send({
    recipientActor: 'claude', recipientMachine: 'machine-a', body: 'this one is local'
  }, { agentActor: 'codex' });
  assert.equal(refused.accepted, false);
  assert.equal(refused.code, 'AGENT_COMMS_CROSS_MACHINE_RECIPIENT_REQUIRED');
  assert.equal(refused.useInstead, 'agent_comms.send_local', 'the refusal names the tool that can do it');
  assert.equal(credentialLoaded, false,
    'who the recipient is, is registry knowledge; asking for a relay credential to answer it sends the person to the wrong repair');
});

/** One raw POST to the running bus, so a record can be placed on the channel
 *  without going through the client whose verification is under test. */
function postToBus(port, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload, 'utf8'))
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

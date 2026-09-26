'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAgentCommsFabric } = require('../../src/lib/agent-comms/fabric');
const { ROUTES } = require('../../src/lib/agent-comms/broker');
const { ReadPositionError } = require('../../src/lib/agent-comms/read-position');
const { createRelayTransport } = require('../../src/lib/agent-comms/transport-relay');
const { createWakeRequestHandler } = require('../../src/lib/agent-wake/wake-request');

const ALICE = Object.freeze({ agentId: 'alice', machineId: 'desktop-b' });
const BOB = Object.freeze({ agentId: 'bob', machineId: 'laptop-a' });
const OWNER = Object.freeze({ agentId: 'owner', machineId: 'desktop-b' });

function configuredAgents(bobRoute = ROUTES.LOCAL) {
  return [
    { ...ALICE, sessionId: 'alice-session', route: ROUTES.LOCAL },
    { ...BOB, sessionId: 'bob-session', route: bobRoute }
  ];
}

function direct(agent) {
  return { type: 'direct', agent };
}

function auth(identity) {
  return { identity };
}

function verifier() {
  return Object.freeze({
    verify({ authentication }) {
      if (!authentication || !authentication.identity) {
        return Object.freeze({ authenticated: false, integrityChecked: false });
      }
      return Object.freeze({
        authenticated: true,
        integrityChecked: true,
        sender: authentication.identity
      });
    }
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function memoryStore() {
  const entries = new Map();
  return Object.freeze({
    getMemory({ namespace, key }) {
      const entry = entries.get(`${namespace}\u0000${key}`);
      return entry ? clone(entry) : null;
    },
    setMemory({ namespace, key, value, expectedRevision }) {
      const lookup = `${namespace}\u0000${key}`;
      const prior = entries.get(lookup);
      const revision = prior ? prior.revision : 0;
      if (revision !== expectedRevision) {
        const error = new Error('revision conflict');
        error.code = 'MEMORY_REVISION_CONFLICT';
        throw error;
      }
      const entry = { namespace, key, revision: revision + 1, value: clone(value) };
      entries.set(lookup, entry);
      return { entry: clone(entry), created: !prior, replayed: false };
    }
  });
}

function inboundRecord(sequence, {
  sender = ALICE,
  audience = direct(BOB),
  kind = 'notice',
  body = `inbound-${sequence}`,
  authentication
} = {}) {
  return Object.freeze({
    authentication: authentication === undefined ? auth(sender) : authentication,
    channel: 'agent_comms',
    message: JSON.stringify({
      id: `remote-message-${sequence}`,
      sender,
      audience,
      sequence,
      causalParent: null,
      kind,
      body,
      issuedAt: 1_900_000_000_000 + sequence
    }),
    sender: 'injected-fake-relay',
    sentAt: new Date(1_900_000_000_000 + sequence).toISOString(),
    sequence
  });
}

function cursorBackedInbound(records) {
  const readCalls = [];
  const headSequence = records.length ? records.at(-1).sequence : 0;
  const port = createRelayTransport({
    channel: 'agent_comms',
    initialCursor: 0,
    now: () => 1_900_000_000_000,
    sender: 'fabric-inbound-fake',
    async requestPort(request) {
      readCalls.push(request);
      const url = new URL(request.path, 'http://injected-fake.invalid');
      const requestedCursor = Number(url.searchParams.get('cursor'));
      const limit = Number(url.searchParams.get('limit'));
      const messages = records
        .filter(record => record.sequence > requestedCursor)
        .slice(0, limit);
      const nextCursor = messages.length ? messages.at(-1).sequence : requestedCursor;
      const partial = nextCursor < headSequence;
      return Object.freeze({
        statusCode: 200,
        body: JSON.stringify({
          backlogCount: Math.max(0, headSequence - requestedCursor),
          caughtUp: requestedCursor === headSequence,
          cursor: String(nextCursor),
          floorSequence: 1,
          headSequence,
          messages,
          requestedCursor,
          ...(partial ? { reason: 'PAGE_PARTIAL' } : {}),
          status: requestedCursor === headSequence
            ? 'CAUGHT_UP'
            : (partial ? 'INCOMPLETE' : 'BACKLOG')
        })
      });
    }
  });
  return {
    readCalls,
    port
  };
}

function fixture(t, {
  bobRoute = ROUTES.LOCAL,
  agents = configuredAgents(bobRoute),
  historyOptions = {},
  claimsOptions = {},
  homeNode = null,
  inboundAuthentication = null,
  inboundTransport = null,
  legacyBoard = null,
  mailboxPort = null,
  transportDeliver = async attempt => ({ delivered: true, messageId: attempt.messageId }),
  wakePort = null
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-fabric-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clock = { value: 1_900_000_000_000 };
  const presence = new Map();
  const transportCalls = [];
  const livenessReceiver = Object.freeze({
    getAgent(agentId, sessionId) {
      const state = presence.get(`${agentId}\u0000${sessionId}`);
      return state ? Object.freeze({ agentId, sessionId, state, freshness: 'FRESH' }) : null;
    }
  });
  const fabric = createAgentCommsFabric({
    agents,
    verifier: verifier(),
    store: memoryStore(),
    now: () => clock.value,
    inboundAuthentication,
    inboundTransport,
    historyOptions,
    claimsOptions,
    mailboxPort,
    brokerOptions: {
      stateFile: path.join(directory, 'broker.json'),
      livenessReceiver,
      transport: Object.freeze({
        async deliver(attempt) {
          transportCalls.push(attempt);
          return transportDeliver(attempt);
        }
      }),
      wakePort
    },
    homeNode,
    legacyBoard
  });
  return {
    clock,
    directory,
    fabric,
    presence,
    transportCalls,
    setPresence(agent, state) {
      const configured = agents.find(item => item.agentId === agent.agentId);
      presence.set(`${configured.agentId}\u0000${configured.sessionId}`, state);
    }
  };
}

test('owner journal pages bound repeated history reads and observe later audience changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-journal-page-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = memoryStore();
  const reads = new Map();
  const store = {
    getMemory(input) {
      reads.set(input.key, (reads.get(input.key) || 0) + 1);
      return base.getMemory(input);
    },
    setMemory: base.setMemory
  };
  const fabric = createAgentCommsFabric({
    agents: configuredAgents(), verifier: verifier(), store,
    now: () => 1_900_000_000_000,
    brokerOptions: {
      stateFile: path.join(directory, 'broker.json'),
      livenessReceiver: { getAgent() { return { state: 'RUNNING', freshness: 'FRESH' }; } },
      transport: { async deliver(attempt) { return { delivered: true, messageId: attempt.messageId }; } }
    }
  });
  const ids = [];
  for (let index = 0; index < 8; index++) {
    const [sender, recipient] = index < 6 ? [ALICE, BOB] : [BOB, ALICE];
    const sent = await fabric.send({ sender, recipient, kind: 'notice', body: `journal row ${index}` }, auth(sender));
    assert.equal(sent.accepted, true);
    ids.push(sent.message.id);
  }
  const project = () => fabric.ownerProjection({ actor: { actorId: 'owner', actorKind: 'owner' }, cursor: 0 });
  reads.clear();
  const page = project();
  assert.deepEqual(page.journal.records.map(row => row.message.message.id), ids);
  const streams = new Set(page.journal.records.map(row => row.message.streamId));
  assert.equal(streams.size, 2, 'the page must span more than one audience');
  for (const stream of streams) {
    assert.ok(reads.get(`history/${stream}`) <= 2,
      'a page must not decode the same retained history once per journal row');
  }

  const key = `history/${page.journal.records[0].message.streamId}`;
  const lookup = { namespace: 'agent-comms', key };
  const original = base.getMemory(lookup).value;
  const replaceAudience = value => {
    const entry = base.getMemory(lookup);
    base.setMemory({ ...lookup, value, expectedRevision: entry.revision });
  };
  // Another writer can advance retention or finish a previously missing
  // audience append. Each call must establish those facts again.
  replaceAudience({ ...original, floorSequence: original.floorSequence + 1, records: original.records.slice(1) });
  const retained = project();
  assert.deepEqual(retained.journal.records.map(row => row.message.message.id), ids.slice(1));
  assert.deepEqual(retained.journal.incompleteRecords.map(row => row.messageId), [ids[0]]);
  replaceAudience(original);
  assert.deepEqual(project().journal.records.map(row => row.message.message.id), ids);
  replaceAudience({ ...original, headSequence: original.headSequence + 1 });
  assert.throws(project, error => error && error.code === 'HISTORY_STATE_CORRUPT',
    'a previous readable snapshot cannot conceal a later corrupt audience');
});

test('failed audience append remains an explicit incomplete owner operation', async t => {
  const base = memoryStore();
  let journalWritten = false;
  const store = Object.freeze({
    getMemory: base.getMemory,
    setMemory(request) {
      if (request.key === 'history/owner.journal') journalWritten = true;
      else if (journalWritten && request.key.startsWith('history/')) {
        const error = new Error('injected audience storage refusal');
        error.code = 'INJECTED_STORAGE_REFUSAL';
        throw error;
      }
      return base.setMemory(request);
    }
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-fabric-append-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fabric = createAgentCommsFabric({
    agents: configuredAgents(), verifier: verifier(), store,
    now: () => 1_900_000_000_000,
    brokerOptions: {
      stateFile: path.join(directory, 'broker.json'),
      livenessReceiver: { getAgent() { return null; } },
      transport: { async deliver(attempt) { return { delivered: true, messageId: attempt.messageId }; } }
    }
  });

  await assert.rejects(() => fabric.send({
    sender: ALICE, recipient: BOB, kind: 'notice', body: 'must not look sent'
  }, auth(ALICE)), error => error && error.code === 'HISTORY_STORAGE_WRITE_FAILED');
  const projection = fabric.ownerProjection({ actor: { actorId: 'owner', actorKind: 'owner' }, cursor: 0 });
  assert.deepEqual(projection.journal.records, []);
  assert.equal(projection.journal.incompleteRecords.length, 1);
  assert.equal(projection.journal.incompleteRecords[0].status, 'INCOMPLETE_AUDIENCE_APPEND');
});

test('local durable audience delivery is recorded even when the optional mailbox notice is unavailable', async t => {
  let registered = false;
  const appended = [];
  const mailboxPort = Object.freeze({
    isRegistered() { return registered; },
    append(entry) { appended.push(entry); return { requestId: entry.requestId }; }
  });
  const { fabric } = fixture(t, {
    mailboxPort,
    transportDeliver: async attempt => ({
      delivered: true,
      messageId: attempt.messageId,
      evidence: { source: 'local-durable-fabric' }
    })
  });

  const sent = await fabric.send({ sender: ALICE, recipient: BOB, kind: 'notice', body: 'wait for mailbox' }, auth(ALICE));
  assert.equal(sent.broker.delivered, true);
  assert.equal(sent.mailboxDeliveries[0].code, 'FABRIC_MAILBOX_NOT_REGISTERED');
  registered = true;
  const drained = await fabric.drain({ agent: BOB });
  assert.equal(drained.delivered, 0);
  assert.equal(drained.remaining, 0);
  assert.equal(appended.length, 0);
});

for (const failureSite of ['registry', 'append']) {
  test(`a mailbox ${failureSite} outage preserves the direct delivery receipt and readable message`, async t => {
    let unavailable = true;
    const notices = [];
    const refuse = () => { throw Object.assign(new Error('injected mailbox outage'), { code: 'EIO' }); };
    const { directory, fabric, transportCalls } = fixture(t, {
      mailboxPort: {
        isRegistered() {
          if (unavailable && failureSite === 'registry') refuse();
          return true;
        },
        append(entry) {
          if (unavailable && failureSite === 'append') refuse();
          notices.push(entry);
          return { requestId: entry.requestId };
        }
      },
      transportDeliver: async attempt => ({
        delivered: true,
        messageId: attempt.messageId,
        evidence: { source: 'local-durable-fabric' }
      })
    });

    const sent = await fabric.send({
      sender: ALICE, recipient: BOB, kind: 'ask', body: `survive mailbox ${failureSite} outage`
    }, auth(ALICE));
    assert.equal(sent.accepted, true);
    assert.equal(sent.broker.delivered, true);
    assert.equal(sent.delivery.state, 'DELIVERED');
    assert.equal(sent.mailboxDeliveries[0].queued, false);
    assert.equal(sent.mailboxDeliveries[0].code, `FABRIC_MAILBOX_${failureSite.toUpperCase()}_FAILED`);
    assert.equal(sent.mailboxDeliveries[0].causeCode, 'EIO');
    assert.equal(transportCalls.length, 1);

    const read = await fabric.read({ agent: BOB, audience: direct(BOB), cursor: 0 });
    assert.deepEqual(read.records.map(record => record.message.id), [sent.message.id]);
    const acknowledged = await fabric.markRead({
      agent: BOB, audience: direct(BOB), messageId: sent.message.id,
      sequence: read.records[0].sequence, evidence: { source: 'mailbox-outage-test' }
    });
    assert.equal(acknowledged.accepted, true);
    assert.equal(acknowledged.delivery.state, 'READ');

    const journal = fabric.ownerProjection({ actor: { actorId: 'owner', actorKind: 'owner' }, cursor: 0 }).journal;
    assert.deepEqual(journal.records.map(record => record.message.message.id), [sent.message.id]);
    assert.deepEqual(journal.incompleteRecords, []);
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'broker.json'), 'utf8'));
    assert.deepEqual(persisted.spool, []);
    assert.deepEqual(persisted.deliveries.map(receipt => receipt.messageId), [sent.message.id]);

    unavailable = false;
    const drained = await fabric.drain({ agent: BOB });
    assert.equal(drained.remaining, 0);
    assert.equal(transportCalls.length, 1, 'a completed delivery must not repeat after mailbox recovery');
    assert.equal(notices.length, 0);
    const next = await fabric.send({
      sender: ALICE, recipient: BOB, kind: 'notice', body: 'mailbox recovered'
    }, auth(ALICE));
    assert.equal(next.broker.delivered, true);
    assert.equal(next.mailboxDeliveries[0].queued, true);
    assert.deepEqual(notices.map(entry => entry.messageId), [next.message.id]);
  });

  test(`one member's mailbox ${failureSite} outage does not interrupt channel fanout`, async t => {
    const notified = [];
    const { fabric } = fixture(t, {
      agents: [...configuredAgents(), { ...OWNER, sessionId: 'owner-session', route: ROUTES.LOCAL }],
      mailboxPort: {
        isRegistered(agentId) {
          if (agentId === BOB.agentId && failureSite === 'registry') {
            throw Object.assign(new Error('injected mailbox registry outage'), { code: 'EIO' });
          }
          return true;
        },
        append(entry) {
          if (entry.agentId === BOB.agentId && failureSite === 'append') {
            throw Object.assign(new Error('injected mailbox append outage'), { code: 'EIO' });
          }
          notified.push(entry);
          return { requestId: entry.requestId };
        }
      }
    });
    fabric.createChannel({ name: 'mailbox-outage' });
    for (const agent of [ALICE, BOB, OWNER]) fabric.joinChannel({ channel: 'mailbox-outage', agent });

    const sent = await fabric.sendChannel({
      sender: ALICE, channel: 'mailbox-outage', kind: 'notice', body: 'continue channel fanout'
    }, auth(ALICE));
    assert.equal(sent.accepted, true);
    assert.equal(sent.delivery.state, 'DELIVERED');
    assert.deepEqual(sent.mailboxDeliveries.map(receipt => [receipt.agentId, receipt.queued]), [
      [BOB.agentId, false], [OWNER.agentId, true]
    ]);
    assert.equal(sent.mailboxDeliveries[0].code, `FABRIC_MAILBOX_${failureSite.toUpperCase()}_FAILED`);
    assert.deepEqual(notified.map(entry => entry.agentId), [OWNER.agentId]);
    for (const agent of [BOB, OWNER]) {
      const read = await fabric.read({ agent, audience: { type: 'channel', name: 'mailbox-outage' }, cursor: 0 });
      assert.deepEqual(read.records.map(record => record.message.id), [sent.message.id]);
    }
  });
}

test('a mailbox append that writes before throwing is not repeated by local transport', async t => {
  const notices = [];
  const { fabric, transportCalls } = fixture(t, {
    mailboxPort: {
      isRegistered() { return true; },
      append(entry) {
        notices.push(entry);
        throw Object.assign(new Error('injected failure after mailbox append'), { code: 'EIO' });
      }
    },
    transportDeliver: async attempt => ({
      delivered: true, messageId: attempt.messageId,
      evidence: { source: 'local-durable-fabric' }
    })
  });
  const sent = await fabric.send({
    sender: ALICE, recipient: BOB, kind: 'notice', body: 'one mailbox hint'
  }, auth(ALICE));
  assert.equal(sent.broker.delivered, true);
  assert.equal(sent.mailboxDeliveries[0].code, 'FABRIC_MAILBOX_APPEND_FAILED');
  assert.equal(sent.mailboxDeliveries[0].queued, false, 'an ambiguous hint append is not a confirmed hint');
  assert.deepEqual(notices.map(entry => entry.messageId), [sent.message.id]);
  assert.equal(transportCalls.length, 1);
  assert.equal((await fabric.drain({ agent: BOB })).remaining, 0);
  assert.equal(notices.length, 1);
});

test('joined recipient reads and answers an addressed ASK, clearing the sender outstanding view', async t => {
  const { fabric } = fixture(t);
  fabric.createChannel({ name: 'ops' });
  assert.equal(fabric.joinChannel({ channel: 'ops', agent: ALICE }).joined, true);
  assert.equal(fabric.joinChannel({ channel: 'ops', agent: BOB }).joined, true);

  const sent = await fabric.send({
    sender: ALICE,
    recipient: BOB,
    kind: 'ask',
    body: 'Can you review the assembled fabric?'
  }, auth(ALICE));

  assert.equal(sent.accepted, true);
  assert.equal(sent.delivery.state, 'DELIVERED');
  assert.deepEqual(fabric.listOutstandingAsks({ agent: ALICE }).map(ask => ask.askId), [sent.message.id]);

  const inbox = direct(BOB);
  assert.deepEqual(fabric.position({ agent: BOB, audience: inbox }), {
    streamId: sent.stream.id,
    status: 'BACKLOG',
    cursor: 0,
    floorSequence: 1,
    headSequence: 1,
    backlogCount: 1,
    caughtUp: false
  });
  const replay = await fabric.read({ agent: BOB, audience: inbox, cursor: 0 });
  assert.deepEqual(replay.records.map(record => record.message.id), [sent.message.id]);

  const read = await fabric.markRead({
    agent: BOB,
    audience: inbox,
    messageId: sent.message.id,
    sequence: replay.records[0].sequence,
    evidence: { receiptId: 'bob-read-1' }
  });
  assert.equal(read.accepted, true);
  assert.equal(read.delivery.state, 'READ');

  const answered = await fabric.answer({
    sender: BOB,
    askId: sent.message.id,
    body: 'Yes; the seams now run together.'
  }, auth(BOB));
  assert.equal(answered.accepted, true);
  assert.equal(answered.message.causalParent, sent.message.id);
  assert.deepEqual(fabric.listOutstandingAsks({ agent: ALICE }), []);
});

test('unreachable peer stays SENT in spool and drains in order after return', async t => {
  const { fabric, setPresence, transportCalls } = fixture(t, { bobRoute: ROUTES.PEER });

  const first = await fabric.send({ sender: ALICE, recipient: BOB, kind: 'ask', body: 'first ask' }, auth(ALICE));
  const second = await fabric.send({ sender: ALICE, recipient: BOB, kind: 'ask', body: 'second ask' }, auth(ALICE));

  assert.equal(first.broker.state, 'SENT');
  assert.equal(second.broker.state, 'SENT');
  assert.equal(first.delivery.state, 'SENT');
  assert.equal(second.delivery.state, 'SENT');
  assert.equal(transportCalls.length, 0);

  setPresence(BOB, 'RUNNING');
  const drained = await fabric.drain({ agent: BOB });
  assert.equal(drained.delivered, 2);
  assert.equal(drained.remaining, 0);
  assert.deepEqual(transportCalls.map(call => call.messageId), [first.message.id, second.message.id]);
  assert.deepEqual(drained.lifecycleDeliveries.map(delivery => delivery.state), ['DELIVERED', 'DELIVERED']);
});

test('wake-contract refusal keeps an asleep recipient SENT without attempting delivery', async t => {
  let directory;
  let clock;
  const wakeHandlerPort = request => wakeHandler.handleWakeRequest(request, { trusted: true });
  let wakeHandler;
  const setup = fixture(t, {
    bobRoute: ROUTES.PEER,
    wakePort: request => wakeHandlerPort(request),
    transportDeliver: async attempt => ({ delivered: true, messageId: attempt.messageId })
  });
  ({ directory, clock } = setup);
  wakeHandler = createWakeRequestHandler({
    stateFile: path.join(directory, 'wake.json'),
    authenticator: Object.freeze({
      verify() {
        return Object.freeze({
          authenticated: true,
          integrityChecked: true,
          principal: 'fabric-integration-test'
        });
      }
    }),
    isKnownAgent: () => false,
    executor: async () => { throw new Error('must not execute'); },
    now: () => clock.value
  });
  setup.setPresence(BOB, 'IDLE');

  const sent = await setup.fabric.send({
    sender: ALICE,
    recipient: BOB,
    kind: 'ask',
    body: 'wake before reading'
  }, auth(ALICE));

  assert.equal(sent.broker.state, 'SENT');
  assert.equal(sent.broker.delivered, false);
  assert.equal(sent.delivery.state, 'SENT');
  assert.equal(sent.broker.wake.requested, true);
  assert.equal(sent.broker.wake.accepted, false);
  assert.equal(sent.broker.wake.code, 'WAKE_AGENT_UNKNOWN');
  assert.equal(setup.transportCalls.length, 0);
});

test('away agent replays every retained record and receives explicit TRUNCATED behind the floor', async t => {
  const retained = fixture(t, { historyOptions: { retention: 10 } });
  const ids = [];
  for (const body of ['one', 'two', 'three']) {
    const sent = await retained.fabric.send({ sender: ALICE, recipient: BOB, kind: 'notice', body }, auth(ALICE));
    ids.push(sent.message.id);
  }
  const replay = await retained.fabric.read({ agent: BOB, audience: direct(BOB), cursor: 0 });
  assert.deepEqual(replay.records.map(record => record.message.id), ids);

  /* THE FLOOR STILL MOVES, AND A CURSOR BEHIND IT IS STILL TOLD SO -- but now
     only over records BOB has actually read. This half of the test used to
     prune two records BOB had never seen and call the resulting TRUNCATED the
     rule; that was T201, a message expiring before its session read it. The
     TRUNCATED contract itself is real and unchanged, so it is still pinned
     here, with BOB acknowledging sequence 1 before the third send makes room
     for itself. */
  const pruned = fixture(t, { historyOptions: { retention: 2 } });
  const prunedIds = [];
  for (const body of ['oldest', 'middle']) {
    const sent = await pruned.fabric.send({ sender: ALICE, recipient: BOB, kind: 'notice', body }, auth(ALICE));
    prunedIds.push(sent.message.id);
  }
  const readOldest = await pruned.fabric.markRead({
    agent: BOB, audience: direct(BOB), evidence: { handedToModel: true },
    messageId: prunedIds[0], sequence: 1
  });
  assert.equal(readOldest.accepted, true);
  await pruned.fabric.send({ sender: ALICE, recipient: BOB, kind: 'notice', body: 'newest' }, auth(ALICE));

  const truncated = await pruned.fabric.read({ agent: BOB, audience: direct(BOB), cursor: 0 });
  assert.equal(truncated.status, 'TRUNCATED');
  assert.equal(truncated.floorSequence, 2);
  assert.equal(truncated.headSequence, 3);
  assert.deepEqual(truncated.records, []);
});

/* T201: A MESSAGE MAY NOT EXPIRE BEFORE ITS RECIPIENT HAS READ IT.
 *
 * The half above used to be the whole rule: three notices into a retention-2
 * direct stream, BOB having read nothing, and the oldest two gone. Direct
 * streams are `direct.<digest>` -- one stream per RECIPIENT -- so their reader
 * set is known exactly, and retention may now evict only what that recipient
 * has acknowledged. When it cannot, the SEND is refused, by name, and the
 * sender is told nothing was lost. Refusing a new message is recoverable;
 * destroying one the product already accepted is not.
 *
 * Driven with values through the fabric's own doors, so it says what a sender
 * and a recipient observe rather than how retention is written. */
test('an unread direct backlog refuses the next send instead of destroying what nobody has read', async t => {
  const { fabric } = fixture(t, { historyOptions: { retention: 2 } });
  const ids = [];
  for (const body of ['first words', 'second words']) {
    const sent = await fabric.send({ sender: ALICE, recipient: BOB, kind: 'notice', body }, auth(ALICE));
    ids.push(sent.message.id);
  }

  await assert.rejects(
    () => fabric.send({ sender: ALICE, recipient: BOB, kind: 'notice', body: 'third words' }, auth(ALICE)),
    error => error.code === 'FABRIC_RECIPIENT_BACKLOG_FULL',
    'the third send destroyed a message BOB had never read, and said nothing about it',
  );

  // And what BOB was sent is all still there to be read, in order.
  const page = await fabric.read({ agent: BOB, audience: direct(BOB), cursor: 0 });
  // Not TRUNCATED is the claim: nothing fell off the floor. ('BACKLOG' is the
  // positioned reader saying there is more waiting, which is exactly right.)
  assert.notEqual(page.status, 'TRUNCATED', 'BOB was told his unread prefix had expired');
  assert.deepEqual(page.records.map(record => record.message.id), ids);
  assert.deepEqual(page.records.map(record => record.message.body), ['first words', 'second words']);

  // Reading releases the room: the send that was refused now goes.
  assert.equal((await fabric.markRead({
    agent: BOB, audience: direct(BOB), evidence: { handedToModel: true },
    messageId: ids[0], sequence: 1
  })).accepted, true);
  const third = await fabric.send({ sender: ALICE, recipient: BOB, kind: 'notice', body: 'third words' }, auth(ALICE));
  assert.equal(third.accepted, true, 'acknowledging the backlog did not free the channel, so a slow reader blocks it forever');
});

test('cursorless reads are refused by read-position through the fabric boundary', async t => {
  const { fabric } = fixture(t);
  await assert.rejects(
    () => fabric.read({ agent: BOB, audience: direct(BOB) }),
    error => error instanceof ReadPositionError && error.code === 'READ_POSITION_INVALID_ARGUMENT'
  );
});

test('cursor-backed inbound drain authenticates accepted messages and refuses a forged sender before history', async t => {
  const inbound = cursorBackedInbound([
    inboundRecord(1, { kind: 'ask', body: 'authenticated inbound ask' }),
    inboundRecord(2, {
      sender: BOB,
      audience: direct(ALICE),
      authentication: auth(ALICE),
      body: 'forged sender must not enter history'
    })
  ]);
  const { fabric } = fixture(t, { inboundTransport: inbound.port });

  const drained = await fabric.drainInbound();

  assert.equal(drained.acceptedCount, 1);
  assert.equal(drained.refusedCount, 1);
  assert.equal(drained.received[0].accepted, true);
  assert.equal(drained.received[0].delivery.state, 'DELIVERED');
  assert.equal(drained.received[1].accepted, false);
  assert.equal(drained.received[1].code, 'AGENT_MESSAGE_SENDER_FORGED');
  assert.equal(JSON.stringify(drained).includes('"authentication"'), false);
  assert.deepEqual(fabric.inboundPosition(), { status: 'POSITION', cursor: 2 });

  const bobInbox = await fabric.read({ agent: BOB, audience: direct(BOB), cursor: 0 });
  assert.deepEqual(bobInbox.records.map(record => record.message.body), ['authenticated inbound ask']);
  assert.equal(fabric.position({ agent: ALICE, audience: direct(ALICE) }).headSequence, 0);
  assert.equal(Object.hasOwn(fabric, 'receiveInboundRecord'), false);
  assert.equal(Object.hasOwn(fabric, 'ingestInbound'), false);
});

test('cursorless inbound reads are refused before the transport and the stored position is reported', async t => {
  const inbound = cursorBackedInbound([]);
  const { fabric } = fixture(t, { inboundTransport: inbound.port });

  await assert.rejects(
    () => fabric.readInbound({}),
    error => error instanceof ReadPositionError && error.code === 'READ_POSITION_INVALID_ARGUMENT'
  );
  assert.equal(inbound.readCalls.length, 0);
  const positioned = await fabric.readInbound({ cursor: 0 });
  assert.equal(positioned.status, 'CAUGHT_UP');
  assert.equal(positioned.cursor, 0);
  assert.equal(positioned.nextCursor, 0);
  assert.deepEqual(positioned.received, []);
  assert.equal(inbound.readCalls.length, 1);
  assert.deepEqual(fabric.inboundPosition(), { status: 'POSITION', cursor: 0 });
});

test('degraded peer retains work and reconciles it to the configured home in order', async t => {
  const homeActions = [];
  const homeNode = {
    configuration: {
      schemaVersion: 1,
      nodes: [
        { nodeId: 'desktop-home', isHome: true, brokerEndpoint: 'wss://home.example.test/agent-comms' },
        { nodeId: 'travel-laptop', isHome: false }
      ]
    },
    identity: { nodeId: 'travel-laptop' },
    deliveryPort: async action => {
      homeActions.push(action);
      return { accepted: true, sequence: action.sequence };
    }
  };
  const { fabric, transportCalls } = fixture(t, { homeNode });
  const degraded = await fabric.markHomeUnreachable();
  assert.equal(degraded.deliveryState, 'DEGRADED');
  assert.equal(degraded.visibleStatus.code, 'HOME_NODE_UNREACHABLE');

  const first = await fabric.send({ sender: ALICE, recipient: BOB, kind: 'notice', body: 'retained first' }, auth(ALICE));
  const second = await fabric.send({ sender: ALICE, recipient: BOB, kind: 'notice', body: 'retained second' }, auth(ALICE));
  assert.equal(first.retainedForHome, true);
  assert.equal(second.retainedForHome, true);
  assert.equal(transportCalls.length, 0);
  assert.deepEqual(fabric.homeStatus().localQueue.map(item => item.sequence), [1, 2]);

  const reconciling = await fabric.markHomeReachable();
  assert.equal(reconciling.deliveryState, 'RECONCILING');
  const reconciled = await fabric.reconcileHome();
  assert.equal(reconciled.accepted, true);
  assert.equal(reconciled.reconciled, 2);
  assert.equal(reconciled.remaining, 0);
  assert.equal(reconciled.state.deliveryState, 'HEALTHY');
  assert.deepEqual(homeActions.map(action => action.payload.message.id), [first.message.id, second.message.id]);
});

test('fabric history projects one way to a legacy reader without accepting legacy ingress', async t => {
  const legacyBoard = memoryStore();
  const { fabric } = fixture(t, { legacyBoard });
  const sent = await fabric.send({
    sender: ALICE,
    recipient: BOB,
    kind: 'notice',
    body: 'compatibility projection'
  }, auth(ALICE));

  const carried = fabric.carryLegacy({ audience: direct(BOB), afterSequence: 0 });
  assert.equal(carried.direction, 'fabric-to-legacy-readers');
  assert.equal(carried.recordsRead, 1);
  assert.equal(carried.carried.length, 1);
  const entry = legacyBoard.getMemory({ namespace: 'agent-coord', key: carried.carried[0].key });
  assert.equal(entry.value.bridge.messageId, sent.message.id);
  assert.equal(entry.value.bridge.direction, 'fabric-to-legacy-readers');
  assert.equal(Object.hasOwn(fabric, 'importLegacy'), false);
});

test('fabric surfaces contradictory agent claims as a conflict without adjudicating either side', t => {
  const { fabric, clock } = fixture(t);
  const subject = 'bridge/q91-wire/reachable';

  const initial = fabric.assertClaim({
    agent: ALICE,
    subject,
    kind: 'port-probe',
    value: false,
    asOfMs: clock.value,
    evidence: { kind: 'command', reference: 'alice-probe-closed' }
  });
  assert.equal(initial.status, 'CURRENT');

  clock.value += 1_000;
  const asserted = fabric.assertClaim({
    agent: BOB,
    subject,
    kind: 'port-probe',
    value: true,
    asOfMs: clock.value,
    evidence: { kind: 'receipt', reference: 'bob-probe-open' }
  });
  const read = fabric.readClaim({ subject });
  const open = fabric.listOpenConflicts();

  for (const result of [asserted, read]) {
    assert.equal(result.status, 'CONFLICT');
    assert.equal(result.adjudication, 'NONE');
    assert.deepEqual(result.claims.map(claim => [claim.author, claim.value]), [
      ['alice', false],
      ['bob', true]
    ]);
    assert.equal(Object.hasOwn(result, 'winner'), false);
    assert.equal(Object.hasOwn(result, 'preferredClaim'), false);
    assert.equal(Object.hasOwn(result, 'value'), false);
  }
  assert.equal(open.status, 'OPEN_CONFLICTS');
  assert.equal(open.adjudication, 'NONE');
  assert.equal(open.conflicts.length, 1);
  assert.equal(open.conflicts[0].status, 'CONFLICT');
  assert.equal(Object.hasOwn(open.conflicts[0], 'winner'), false);
  assert.match(open.presentation.label, /NOT ADJUDICATED/);
  assert.equal(Object.hasOwn(fabric, 'resolveConflict'), false);
  assert.equal(Object.keys(fabric).some(key => /winner|adjudicat/i.test(key)), false);
});

test('an expired fabric claim is STALE with its age and withholds its value', t => {
  const { fabric, clock } = fixture(t, {
    claimsOptions: { validityBudgets: { 'port-probe': 5 } }
  });
  const subject = 'bridge/q91-wire/expired';
  fabric.assertClaim({
    agent: ALICE,
    subject,
    kind: 'port-probe',
    value: 'unreachable-observation',
    asOfMs: clock.value,
    evidence: { kind: 'command', reference: 'alice-expired-probe' }
  });

  clock.value += 6;
  const stale = fabric.readClaim({ subject });

  assert.equal(stale.status, 'STALE');
  assert.equal(stale.ageMs, 6);
  assert.equal(stale.presentation.valueWithheld, true);
  assert.equal(Object.hasOwn(stale, 'value'), false);
  assert.equal(Object.hasOwn(stale, 'claim'), false);
  assert.equal(JSON.stringify(stale).includes('unreachable-observation'), false);
});

test('fabric keeps unevidenced assertions visibly distinct from evidenced findings', t => {
  const { fabric, clock } = fixture(t);
  const unevidenced = fabric.assertClaim({
    agent: ALICE,
    subject: 'bridge/q91-wire/claimed-status',
    kind: 'status',
    value: 'running',
    asOfMs: clock.value
  });
  const evidenced = fabric.assertClaim({
    agent: ALICE,
    subject: 'bridge/q91-wire/measured-status',
    kind: 'status',
    value: 'running',
    asOfMs: clock.value,
    evidence: { kind: 'receipt', reference: 'status-command-receipt' }
  });

  assert.equal(unevidenced.claim.evidence.status, 'UNEVIDENCED_ASSERTION');
  assert.equal(unevidenced.claim.evidence.label, 'UNEVIDENCED ASSERTION');
  assert.equal(evidenced.claim.evidence.status, 'EVIDENCED_FINDING');
  assert.equal(evidenced.claim.evidence.label, 'EVIDENCED FINDING');
});

test('durable named channels, owner projection, designation, revocation, and mailbox delivery compose without hidden traffic', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-operational-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = memoryStore();
  const mailboxRows = [];
  const clock = { value: 1_900_000_100_000 };
  const mailboxPort = Object.freeze({
    isRegistered(agentId) { return agentId === 'bob'; },
    append(entry) {
      mailboxRows.push(clone(entry));
      return { requestId: entry.requestId };
    }
  });

  function operationalFabric(machineId, stateName) {
    const identities = [
      { agentId: 'owner', machineId, sessionId: `owner-${machineId}`, route: ROUTES.LOCAL },
      { agentId: 'alice', machineId, sessionId: `alice-${machineId}`, route: ROUTES.LOCAL },
      { agentId: 'bob', machineId, sessionId: `bob-${machineId}`, route: ROUTES.LOCAL }
    ];
    return createAgentCommsFabric({
      agents: identities,
      verifier: verifier(),
      store,
      now: () => clock.value,
      mailboxPort,
      brokerOptions: {
        stateFile: path.join(directory, stateName),
        livenessReceiver: { getAgent() { return { state: 'RUNNING', freshness: 'FRESH' }; } },
        transport: { async deliver(attempt) { return { delivered: true, messageId: attempt.messageId }; } }
      }
    });
  }

  const first = operationalFabric('machine-a', 'broker-a.json');
  const ownerA = { agentId: 'owner', machineId: 'machine-a' };
  const aliceA = { agentId: 'alice', machineId: 'machine-a' };
  const bobA = { agentId: 'bob', machineId: 'machine-a' };
  first.createChannel({ name: 'operations', actor: aliceA });
  first.joinChannel({ channel: 'operations', agent: aliceA });
  first.joinChannel({ channel: 'operations', agent: bobA });

  const posted = await first.sendChannel({
    sender: aliceA,
    channel: 'operations',
    kind: 'notice',
    body: 'lane boundary update'
  }, auth(aliceA));
  assert.equal(posted.accepted, true);
  assert.equal(posted.code, 'FABRIC_CHANNEL_DURABLE');
  assert.deepEqual(posted.delivery.recipientAgentIds, ['bob']);
  assert.equal(mailboxRows.length, 1);
  assert.equal(mailboxRows[0].agentId, 'bob');
  assert.match(mailboxRows[0].prompt, /lane boundary update/);

  const unread = await first.read({ agent: bobA, audience: { type: 'channel', name: 'operations' }, cursor: 0 });
  assert.deepEqual(unread.records.map(record => record.message.id), [posted.message.id]);
  const acknowledged = await first.markRead({
    agent: bobA,
    audience: { type: 'channel', name: 'operations' },
    messageId: posted.message.id,
    sequence: unread.records[0].sequence,
    evidence: { source: 'test-agent-boundary' }
  });
  assert.equal(acknowledged.accepted, true);
  assert.equal(first.position({ agent: bobA, audience: { type: 'channel', name: 'operations' } }).caughtUp, true);

  const durableAsk = await first.send({
    sender: aliceA,
    recipient: bobA,
    kind: 'ask',
    body: 'survive restart before acknowledgement'
  }, auth(aliceA));
  const restartedSameMachine = operationalFabric('machine-a', 'broker-a-restarted.json');
  const directAfterRestart = await restartedSameMachine.read({ agent: bobA, audience: direct(bobA), cursor: 0 });
  assert.deepEqual(directAfterRestart.records.map(record => record.message.id), [durableAsk.message.id]);
  const durableAck = await restartedSameMachine.markRead({
    agent: bobA,
    audience: direct(bobA),
    messageId: durableAsk.message.id,
    sequence: directAfterRestart.records[0].sequence,
    evidence: { source: 'restart-boundary-test' }
  });
  assert.equal(durableAck.accepted, true);
  assert.equal(durableAck.delivery.durable, true);
  const durableAnswer = await restartedSameMachine.send({
    sender: bobA,
    recipient: aliceA,
    kind: 'answer',
    causalParent: durableAsk.message.id,
    body: 'restart-safe answer'
  }, auth(bobA));
  assert.equal(durableAnswer.accepted, true);
  assert.equal(durableAnswer.message.causalParent, durableAsk.message.id);
  const secondAfterRestart = await restartedSameMachine.send({
    sender: aliceA,
    recipient: bobA,
    kind: 'notice',
    body: 'restart-safe message identity'
  }, auth(aliceA));
  assert.equal(secondAfterRestart.accepted, true);
  assert.notEqual(secondAfterRestart.message.id, durableAsk.message.id);

  const projection = first.ownerProjection({
    actor: { actorId: 'owner', actorKind: 'owner' },
    cursor: 0
  });
  assert.equal(projection.channels.some(channel => channel.name === 'operations'), true);
  assert.equal(projection.channels.some(channel => channel.name === 'owner-special'), true);
  assert.deepEqual(projection.journal.records.map(record => record.message.message.body), [
    'lane boundary update',
    'survive restart before acknowledgement',
    'restart-safe answer',
    'restart-safe message identity'
  ]);
  assert.throws(
    () => first.ownerProjection({ actor: { actorId: 'alice', actorKind: 'agent' }, cursor: 0 }),
    error => error && error.code === 'OWNER_VISIBILITY_OWNER_REQUIRED'
  );

  const beforeSecret = projection.journal.headSequence;
  const secret = await first.sendChannel({
    sender: aliceA,
    channel: 'operations',
    kind: 'notice',
    body: 'api_key=not-a-real-credential'
  }, auth(aliceA));
  assert.equal(secret.accepted, false);
  assert.equal(secret.code, 'AGENT_MESSAGE_BODY_SENSITIVE');
  assert.match(secret.reason, /sensitive-content check/i);
  assert.match(secret.reason, /remove.*(?:passwords|keys|tokens)/i,
    'the fabric must carry the contract refusal mechanism and way out to its caller');
  assert.equal(first.ownerProjection({ actor: { actorId: 'owner', actorKind: 'owner' }, cursor: 0 }).journal.headSequence, beforeSecret);

  await assert.rejects(
    () => first.read({ agent: bobA, audience: { type: 'channel', name: 'owner-special' }, cursor: 0 }),
    error => error && error.code === 'OWNER_CHANNEL_NOT_DESIGNATED'
  );
  assert.throws(
    () => first.designateOwnerAgent({ actor: { actorId: 'alice', actorKind: 'agent' }, agent: bobA }),
    error => error && error.code === 'OWNER_ACTOR_REQUIRED'
  );
  const designated = first.designateOwnerAgent({
    actor: { actorId: 'owner', actorKind: 'owner' },
    agent: bobA
  });
  assert.equal(designated.code, 'OWNER_CHANNEL_DESIGNATED');
  const ownerMessage = await first.sendChannel({
    sender: ownerA,
    channel: 'owner-special',
    kind: 'notice',
    body: 'owner-designated instruction'
  }, auth(ownerA));
  assert.equal(ownerMessage.accepted, true);
  const special = await first.read({ agent: bobA, audience: { type: 'channel', name: 'owner-special' }, cursor: 0 });
  assert.deepEqual(special.records.map(record => record.message.body), ['owner-designated instruction']);

  const designatedOtherMachine = operationalFabric('machine-c', 'broker-c.json');
  const bobC = { agentId: 'bob', machineId: 'machine-c' };
  const specialAcrossMachines = await designatedOtherMachine.read({
    agent: bobC,
    audience: { type: 'channel', name: 'owner-special' },
    cursor: 0
  });
  assert.deepEqual(specialAcrossMachines.records.map(record => record.message.body), ['owner-designated instruction']);

  const revoked = first.revokeOwnerAgent({
    actor: { actorId: 'owner', actorKind: 'owner' },
    agent: bobA
  });
  assert.equal(revoked.code, 'OWNER_CHANNEL_REVOKED');
  await assert.rejects(
    () => designatedOtherMachine.read({ agent: bobC, audience: { type: 'channel', name: 'owner-special' }, cursor: 0 }),
    error => error && error.code === 'OWNER_CHANNEL_NOT_DESIGNATED'
  );

  const restarted = operationalFabric('machine-d', 'broker-d.json');
  const bobD = { agentId: 'bob', machineId: 'machine-d' };
  assert.equal(restarted.position({ agent: bobD, audience: { type: 'channel', name: 'operations' } }).caughtUp, true);
  const resumed = await restarted.read({ agent: bobD, audience: { type: 'channel', name: 'operations' }, cursor: 0 });
  assert.deepEqual(resumed.records.map(record => record.message.body), ['lane boundary update']);
  await assert.rejects(
    () => restarted.read({ agent: bobD, audience: { type: 'channel', name: 'owner-special' }, cursor: 0 }),
    error => error && error.code === 'OWNER_CHANNEL_NOT_DESIGNATED'
  );
  const visible = restarted.ownerProjection({ actor: { actorId: 'owner', actorKind: 'owner' }, cursor: 0 });
  assert.deepEqual(visible.designations.events.map(event => event.action), ['DESIGNATED', 'REVOKED']);
  assert.deepEqual(visible.designations.activeAgentIds, []);
  assert.deepEqual(visible.journal.records.map(record => record.message.message.body), [
    'lane boundary update',
    'survive restart before acknowledgement',
    'restart-safe answer',
    'restart-safe message identity',
    'owner-designated instruction'
  ]);
});

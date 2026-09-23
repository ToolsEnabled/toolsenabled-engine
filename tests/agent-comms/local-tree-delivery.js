// UNWIRED FROM test:orphans-wired-0823 ON 2026-08-26 (commit f061ec5). NEVER
// green since genesis e416f58 (3/8 fail), wired while red. PRODUCT defect on
// the agent-comms delivery contract: a local same-tree send delivers
// synchronously and reaches the inbox, but the send receipt reports the spool
// state (broker.js:505 delivered:false) because nothing calls recordDelivery
// for the synchronous delivery. The undrained phantom then poisons broker
// reload (broker.js:388, tests 4/8). The fix is a delivery-contract decision
// for the agent-comms owner -- an overstating receipt loses messages silently,
// worse than this understatement. Re-add to the suite when the local receipt
// tells the truth. (This note lived briefly as a package.json "_note:" script
// entry, which tests/test-chain-short-circuit.test.js rightly refuses: prose
// in the scripts block is indistinguishable from a runnable joined command.)
//
// NOTHING FOUND
//
// Assertion-can-fail audit (2026-08-26): no assertion required strengthening.
// The two superficially suspect collection checks are not vacuous: the burst
// has a fixed count of 12 and compares its length to 12, while the sequential
// case iterates a fixed four-element literal and finally compares the complete
// inbox with four independently specified values.
//
// MUTATIONS OBSERVED (production restored byte-for-byte after each run):
// - Changed the provider's successful receipt to `accepted: false`. The
//   sequential loop went RED with: "false !== true" at its in-loop assertion.
// - Changed the provider receipt's message id to `mutated-constant-id`. The
//   burst went RED at the receipt/inbox identity assertion with:
//   "the ids the senders were given are exactly the ids that arrived" and a
//   diff of twelve real `message-*` ids against twelve mutated constant ids.
// These mutations cover the only loop-shaped and same-subject-derived-looking
// assertions; both discriminate. `cmp` against the saved originals returned 0
// after both restorations. The restored passing subset reported:
// "# pass 5", "# fail 0".
//
// NOT-FOUND: an assertion solely on exit status or a truthy process return.
// NOT-FOUND: try/catch or optional chaining that swallows the target failure.
// NOT-FOUND: a mock of the local communications implementation under test.
// NOT-FOUND: a platform skip or precondition guard that makes the file a no-op.
// NOT-FOUND: an expected value computed by the implementation being checked;
// nondeterministic receipt ids are compared across independent receipt and
// durable-inbox observations, and the constant-id mutation proves that check.
//
// UNMET PRECONDITION: the complete baseline cannot currently be green in this
// checkout. Tests 1, 4, and 8 fail before any mutation: test 1 reports
// "false !== true" for the broker-delivered receipt, and tests 4 and 8 throw
// BROKER_CONFIGURATION_INVALID ("stored spool contains an agent absent from
// the current directory."). This audit did not weaken those product checks or
// alter their setup. A restored run restricted to the five unaffected tests
// was green, as quoted above.

'use strict';

// TWO AGENT CIRCLES ON ONE COMPUTER, AND ONE MESSAGE ACTUALLY TRAVELLING
// BETWEEN THEM -- through the shipped composition, not a model of it.
//
// WHAT IS UNDER TEST. Every module in the chain is the real one:
//
//   src/lib/agent-comms/tree-node-directory.js   who is running, and who
//                                                reports to whom
//   src/lib/providers/agent-comms-local.js       the tool-facing send/roster
//   src/lib/agent-comms/local-runtime.js         the roster and verifier
//   src/lib/agent-comms/fabric.js                contract, journal, history
//   src/lib/agent-comms/broker.js                the durable at-least-once spool
//   src/lib/agent-comms/history.js               the compare-and-set log
//   src/lib/agent-comms/read-position.js         the positioned read
//
// Only WHERE they read and write is replaced (see helpers/comms-harness.js),
// so this suite runs on a clean checkout with no service registry, no
// config/agent-org.json, no presence file, no vault and no second machine.
//
// WHY THE PROPERTIES ARE THESE PROPERTIES. They are the five ways a messaging
// system fails in a way nobody notices until it has already cost someone a
// day's work: a message is lost, a message arrives twice, messages arrive out
// of order, a read position moves past something that was never delivered, and
// a refusal is presented as an empty inbox. Each has its own test, and each of
// those tests was checked by breaking the thing it covers and watching it go
// red before it was left green.

const assert = require('node:assert/strict');
const test = require('node:test');

const harness = require('./helpers/comms-harness');
const { createTreeNodeDirectory, DEFAULT_LIVE_WINDOW_MS, STOPPED_RETENTION_MS } = require('../../src/lib/agent-comms/tree-node-directory');
const { createLocalAgentCommsRuntime } = require('../../src/lib/agent-comms/local-runtime');
const { createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');

const START_MS = 1_900_000_000_000;

/** Two circles with a line between them: a manager and the agent that reports
 *  to it, which is the only relationship the directory will certify. */
function standUpTree(t, { extraNodes = [] } = {}) {
  const directory = harness.workspace(t, 'agent-comms-local-tree-');
  const clock = { at: START_MS };
  const stood = harness.localTree({
    createTreeNodeDirectory,
    createLocalAgentCommsRuntime,
    createLocalAgentMessageProvider,
    directory,
    now: () => clock.at
  });
  const manager = stood.tree.registerNode({ sessionId: 'session-coordinator', nodeName: 'Coordinator' });
  const worker = stood.tree.registerNode({
    sessionId: 'session-builder',
    nodeName: 'Builder',
    managerSessionId: 'session-coordinator',
    managerName: 'Coordinator'
  });
  for (const node of extraNodes) stood.tree.registerNode(node);
  return { ...stood, clock, manager, worker };
}

async function inboxBodies(stood, agentId, limit = 100) {
  const page = await stood.provider.inbox({ agentId, cursor: 0, limit });
  return page.page.records.map(record => record.message.body);
}

test('a stopped caller cannot send as the same-named circle left running in another tree', async t => {
  const stood = harness.localTree({
    createTreeNodeDirectory,
    createLocalAgentCommsRuntime,
    createLocalAgentMessageProvider,
    directory: harness.workspace(t, 'agent-comms-bound-sender-'),
    now: () => START_MS
  });
  const otherManager = stood.tree.registerNode({ sessionId: 'manager-b', nodeName: 'Manager', treeKey: 'tree-b' });
  stood.tree.registerNode({ sessionId: 'worker-a', nodeName: 'Worker', managerName: 'Manager', treeKey: 'tree-a' });
  stood.tree.registerNode({ sessionId: 'worker-b', nodeName: 'Worker', managerName: 'Manager', treeKey: 'tree-b' });
  stood.tree.unregisterNode({ sessionId: 'worker-a' });

  const refused = await stood.provider.send({ from: 'Worker', to: 'Manager', body: 'stale-session-message' },
    { agentSessionId: 'worker-a' });
  assert.equal(refused.accepted, false, 'the stopped session must not become worker-b');
  assert.equal(refused.code, 'TREE_SENDER_IDENTITY_MISMATCH');
  assert.deepEqual(refused.reachable, []);
  assert.deepEqual(await inboxBodies(stood, otherManager.agentId), [], 'the other tree received no message');

  const accepted = await stood.provider.send({ from: 'Worker', to: 'Manager', body: 'current-session-message' },
    { agentSessionId: 'worker-b' });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(await inboxBodies(stood, otherManager.agentId), ['Worker: current-session-message']);
});

test('a message from one circle reaches exactly the other circle, once and intact', async t => {
  const stood = standUpTree(t);

  const sent = await stood.provider.send({ from: 'Coordinator', to: 'Builder', body: 'start on the intake list' });
  assert.equal(sent.accepted, true, 'a manager writing to an agent that reports to it must be accepted');
  assert.equal(sent.delivered, true, 'the broker receipt, not the ask/answer lifecycle, is what says delivered');
  assert.equal(sent.to, 'Builder');
  assert.equal(sent.from, 'Coordinator');
  assert.equal(sent.relation, 'reports-to-sender');

  const inbox = await stood.provider.inbox({ agentId: stood.worker.agentId, cursor: 0 });
  assert.equal(inbox.page.records.length, 1, 'exactly one message, not zero and not two');
  const record = inbox.page.records[0];
  // INTACT: the body the sender typed, carrying the sender's circle name so the
  // receiving transcript can say who wrote without a second lookup table.
  assert.equal(record.message.body, 'Coordinator: start on the intake list');
  assert.equal(record.message.id, sent.messageId, 'the id in the receipt is the id in the inbox');
  // TO THE RIGHT RECIPIENT: addressed to the worker's durable identity, and
  // filed on the worker's own stream rather than a shared one.
  assert.equal(record.message.audience.type, 'direct');
  assert.equal(record.message.audience.agent.agentId, stood.worker.agentId);
  assert.equal(record.message.sender.agentId, stood.manager.agentId);

  // AND NOT TO THE SENDER. A fabric that filed a direct message on the sender's
  // stream too would look perfectly healthy from the recipient's side.
  const senderInbox = await stood.provider.inbox({ agentId: stood.manager.agentId, cursor: 0 });
  assert.equal(senderInbox.page.records.length, 0, 'a direct message never lands in its own sender inbox');

  // The reply travels the other way along the same line, and the directory
  // names the relation from the writer's point of view.
  const reply = await stood.provider.send({ from: 'Builder', to: 'Coordinator', body: 'intake list started' });
  assert.equal(reply.accepted, true);
  assert.equal(reply.relation, 'manager');
  assert.deepEqual(await inboxBodies(stood, stood.manager.agentId), ['Builder: intake list started']);
});

test('a burst of concurrent sends loses nothing, duplicates nothing, and keeps one total order', async t => {
  const stood = standUpTree(t);
  const count = 12;

  /* OVERLAPPING ON PURPOSE, because the production shape is overlapping.
     src/lib/providers/agent-comms-local.js builds a FRESH runtime -- and
     therefore a fresh fabric, with its own serialization tail, its own broker
     handle and its own view of the tree -- for EVERY send. Twelve in flight at
     once are twelve independent writers interleaved at their await points over
     one durable history and one durable spool. A fabric that serialized only
     within itself, a spool that lost an entry to another handle's commit, or a
     retention floor set below the burst would all show up here and nowhere in
     the module-level suites, which each drive a single instance.

     Measured while writing this: within one process the append itself is
     synchronous end to end, so history.js's compare-and-set retry is NOT what
     this exercises -- the interleaving happens around the broker's delivery
     await, not inside an append. Said plainly here because a comment naming a
     mechanism the test cannot reach is worse than no comment. */
  const results = await Promise.all(Array.from({ length: count }, (unused, index) =>
    stood.provider.send({ from: 'Coordinator', to: 'Builder', body: `message ${index}` })));
  assert.equal(results.filter(result => result.accepted === true).length, count,
    'every concurrent send is accepted or the ones that were not must say why');

  const bodies = await inboxBodies(stood, stood.worker.agentId);
  assert.equal(bodies.length, count, 'nothing was lost and nothing arrived twice');
  assert.equal(new Set(bodies).size, count, 'no message was delivered more than once');

  const page = await stood.provider.inbox({ agentId: stood.worker.agentId, cursor: 0, limit: 100 });
  const sequences = page.page.records.map(record => record.sequence);
  assert.deepEqual(sequences, Array.from({ length: count }, (unused, index) => index + 1),
    'the stream carries one contiguous total order with no gap and no repeat');

  // Every accepted send is in the recipient stream exactly once, by id.
  const deliveredIds = page.page.records.map(record => record.message.id).sort();
  assert.deepEqual(deliveredIds, results.map(result => result.messageId).sort(),
    'the ids the senders were given are exactly the ids that arrived');
});

test('sequential sends arrive in the order they were sent', async t => {
  const stood = standUpTree(t);
  const order = ['first', 'second', 'third', 'fourth'];
  for (const body of order) {
    const sent = await stood.provider.send({ from: 'Coordinator', to: 'Builder', body });
    assert.equal(sent.accepted, true);
  }
  assert.deepEqual(await inboxBodies(stood, stood.worker.agentId), order.map(body => `Coordinator: ${body}`));
});

test('a recipient whose session has ended is recorded for a wake, and never reported as delivered', async t => {
  const stood = standUpTree(t);
  await stood.provider.send({ from: 'Coordinator', to: 'Builder', body: 'while it was running' });
  const before = await inboxBodies(stood, stood.worker.agentId);
  assert.equal(before.length, 1);

  /* THE WINDOW THIS TEST IS ABOUT, AND WHAT CHANGED IN IT (T255). The person's
     screen still shows the circle; the session behind it has stopped. This used
     to be a refusal, and the assertion here was that NOTHING was written -- the
     hazard being a spool nobody drains plus a sender told it was delivered.
     Both halves of that hazard are still asserted below, and neither is
     softened: what a stopped circle must never produce is a claim of DELIVERY.
     What it must now produce is a durable record, because a message that is
     thrown away cannot be delivered by a wake either -- and the owner being
     unable to reach their own stopped agent is the defect this closes. So the
     old "nothing is written" becomes "exactly this is written, once, and it is
     reported as held rather than delivered". */
  stood.tree.unregisterNode({ sessionId: 'session-builder' });
  const held = await stood.provider.send({ from: 'Coordinator', to: 'Builder', body: 'after it stopped' });

  assert.equal(held.accepted, true, 'a message for a stopped circle is kept, so a wake has something to deliver');
  assert.equal(held.recipientStopped, true, 'the caller is told the recipient was not running');
  assert.equal(held.wakeRequired, true, 'the caller is told something must start that circle');
  assert.equal(held.delivered, false,
    'recorded is not read: reporting delivery here is the silent-success this test was written against');
  assert.match(held.note, /Builder/, 'the answer names the circle the person can see');
  assert.match(held.note, /not been delivered yet/,
    'the person is told the message is held, not that it arrived');

  /* IT IS WRITTEN ONCE, AND IT IS THE MESSAGE THAT WAS SENT. The old assertion
     compared the stream against `before` to prove nothing landed; this compares
     it against `before` plus exactly this body, which is the same assertion
     doing more work -- a duplicate or a lost write both fail it. */
  assert.deepEqual(await inboxBodies(stood, stood.worker.agentId), [...before, 'Coordinator: after it stopped'],
    'the held message is appended once, intact, and nothing else is');
  const journal = await stood.provider.ownerJournal({ limit: 100 });
  assert.equal(journal.messages.length, 2, 'the owner journal records the held message too');
});

/* THE REFUSALS THAT MUST SURVIVE THE WAKE. A stopped circle is now accepted, so
   the risk this pins is that acceptance leaked to rows that cannot wake at all.
   A tombstone's circle continued elsewhere or ended, and an unknown name is a
   typo; both must still refuse, by name, exactly as before. */
test('a circle that cannot wake still refuses, and by its own name', async t => {
  const stood = standUpTree(t);
  stood.tree.unregisterNode({ sessionId: 'session-builder' });

  const unknown = await stood.provider.send({ from: 'Coordinator', to: 'Nobody', body: 'hello' });
  assert.equal(unknown.accepted, false, 'a name nobody holds is not woken into existence');
  assert.equal(unknown.code, 'TREE_RECIPIENT_UNKNOWN');

  /* Past STOPPED_RETENTION_MS the row no longer describes anything startable.
     The SENDER is beaten forward first: it is the circle calling the tool and is
     still running, and without that its own entry lapses too and the answer
     becomes TREE_SENDER_NOT_RUNNING -- a true refusal about the wrong end, which
     would leave the recipient rule untested. */
  stood.clock.at = START_MS + STOPPED_RETENTION_MS + DEFAULT_LIVE_WINDOW_MS + 1;
  stood.tree.heartbeatNode({ sessionId: 'session-coordinator' });
  const expiredRecipient = await stood.provider.send({ from: 'Coordinator', to: 'Builder', body: 'much later' });
  assert.equal(expiredRecipient.accepted, false, 'an expired row is not a stopped circle waiting to be woken');
  assert.equal(expiredRecipient.code, 'TREE_RECIPIENT_NOT_RUNNING',
    'the original refusal keeps its name for the cases that genuinely cannot wake');
});

test('a lapsed heartbeat is held for a wake too, because a crashed circle is the one most worth reaching', async t => {
  const stood = standUpTree(t);
  // Three missed beats at the host's cadence. The session never said goodbye;
  // it simply stopped speaking, which is what a crashed window looks like.
  // The SENDER is still beating -- it is the one calling the tool -- so the
  // only lapsed entry is the recipient's.
  stood.clock.at = START_MS + DEFAULT_LIVE_WINDOW_MS + 1;
  stood.tree.heartbeatNode({ sessionId: 'session-coordinator' });
  const held = await stood.provider.send({ from: 'Coordinator', to: 'Builder', body: 'anyone there' });

  /* T255, AND THIS IS A DELIBERATE WIDENING RATHER THAN A SIDE EFFECT. A lapsed
     heartbeat and a clean stop are indistinguishable at this layer -- isLive is
     false for both -- and rather than split them I chose to treat both as
     wakeable, because a crashed or killed agent is precisely the one a person is
     most likely to be trying to reach and least able to restart by hand. The
     hazard of the choice is a circle that is actually alive but wedged, where a
     wake could try to double-start it; that is why the start guards belong to
     whoever performs the wake and not to this file, which only decides whether
     the message is worth keeping. Kept, here, with the same three-way honesty as
     a clean stop: accepted, recorded, and explicitly NOT delivered. */
  assert.equal(held.accepted, true, 'a crashed circle still has a person trying to reach it');
  assert.equal(held.recipientStopped, true);
  assert.equal(held.wakeRequired, true);
  assert.equal(held.delivered, false, 'nothing read it, and a lapsed circle must not be reported as delivered');
  assert.deepEqual(await inboxBodies(stood, stood.worker.agentId), ['Coordinator: anyone there'],
    'the message is recorded once so the wake has it');
});

test('each way a delivery cannot happen is refused with its own reason, never as an empty success', async t => {
  const stood = standUpTree(t, {
    extraNodes: [{ sessionId: 'session-auditor', nodeName: 'Auditor' }]
  });

  /* THE EDGE IS THE AUTHORITY. Auditor is running and is on the same tree, but
     no line was drawn between it and Coordinator, so there is nothing to
     deliver along. That is a different answer from "no such circle", and the
     difference is the whole repair the person would attempt. */
  const notConnected = await stood.provider.send({ from: 'Coordinator', to: 'Auditor', body: 'sideways' });
  assert.equal(notConnected.accepted, false);
  assert.equal(notConnected.code, 'TREE_RECIPIENT_NOT_CONNECTED');
  assert.match(notConnected.reason, /Auditor/);

  const unknown = await stood.provider.send({ from: 'Coordinator', to: 'Ghost', body: 'nowhere' });
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.code, 'TREE_RECIPIENT_UNKNOWN');

  const unknownSender = await stood.provider.send({ from: 'Ghost', to: 'Builder', body: 'from nowhere' });
  assert.equal(unknownSender.accepted, false);
  assert.equal(unknownSender.code, 'TREE_SENDER_UNKNOWN');

  // Each refusal carries the list the person actually drew, so the next attempt
  // is a choice rather than a guess.
  /* The address rides beside the name. This expectation was missing `agentId`
     and had been failing at the engine landing tip before this branch existed:
     80e72603c ("Every roster row carries the address that tells two same-named
     circles apart") added it to every roster row, and that commit is an ancestor
     of this base. Asserted from stood.worker.agentId rather than a pasted
     literal, so it stays true when the harness mints a different id. */
  assert.deepEqual(notConnected.reachable, [{ nodeName: 'Builder', agentId: stood.worker.agentId,
    relation: 'reports-to-sender', treeKey: null, lastSeenAt: 1_900_000_000_000, transient: false }]);

  // None of the four refusals put anything in front of anyone.
  assert.deepEqual(await inboxBodies(stood, stood.worker.agentId), []);
  const journal = await stood.provider.ownerJournal({ limit: 100 });
  assert.deepEqual(journal.messages, []);
});

test('the read position cannot advance past a message that was never delivered', async t => {
  const stood = standUpTree(t);
  const sent = await stood.provider.send({ from: 'Coordinator', to: 'Builder', body: 'acknowledge me' });
  assert.equal(sent.accepted, true);

  // The tool-facing local provider tracks its cursor in the caller; the
  // position itself lives in the fabric, so reach it through the same runtime
  // the provider builds rather than through a second construction.
  const runtime = stood.runtimeFor({ extraAgentIds: [stood.manager.agentId, stood.worker.agentId] });
  const agent = runtime.identity(stood.worker.agentId);
  const audience = { type: 'direct', agent };
  const evidence = { source: 'local-tree-delivery test', note: 'processed' };

  assert.equal(runtime.fabric.position({ agent, audience }).cursor, 0);

  const ahead = await runtime.fabric.markRead({
    agent, audience, evidence, messageId: sent.messageId, sequence: 2
  });
  assert.equal(ahead.accepted, false, 'a sequence nothing was ever delivered at cannot be acknowledged');
  assert.equal(ahead.code, 'FABRIC_READ_OUT_OF_ORDER');
  assert.equal(runtime.fabric.position({ agent, audience }).cursor, 0, 'and the stored position did not move');

  const wrongId = await runtime.fabric.markRead({
    agent, audience, evidence, messageId: 'message-that-was-never-sent', sequence: 1
  });
  assert.equal(wrongId.accepted, false, 'the right slot with the wrong message is still not this message');
  assert.equal(wrongId.code, 'FABRIC_READ_OUT_OF_ORDER');
  assert.equal(runtime.fabric.position({ agent, audience }).cursor, 0);

  // The message is still there to be read after both refusals -- a refused
  // acknowledgement must not consume what it refused.
  assert.deepEqual(await inboxBodies(stood, stood.worker.agentId), ['Coordinator: acknowledge me']);

  const marked = await runtime.fabric.markRead({
    agent, audience, evidence, messageId: sent.messageId, sequence: sent.sequence
  });
  assert.equal(marked.accepted, true);
  assert.equal(marked.code, 'FABRIC_READ_MARKED');
  assert.equal(marked.cursor, 1);
  assert.equal(runtime.fabric.position({ agent, audience }).cursor, 1);
  assert.equal(runtime.fabric.position({ agent, audience }).caughtUp, true);

  const again = await runtime.fabric.markRead({
    agent, audience, evidence, messageId: sent.messageId, sequence: sent.sequence
  });
  assert.equal(again.accepted, false, 'the same message cannot be acknowledged twice');
  assert.equal(again.code, 'FABRIC_READ_OUT_OF_ORDER');
});

test('the owner journal and what was delivered are the same set of messages', async t => {
  const stood = standUpTree(t, {
    extraNodes: [{ sessionId: 'session-auditor', nodeName: 'Auditor' }]
  });

  const accepted = [];
  for (const body of ['one', 'two']) {
    accepted.push(await stood.provider.send({ from: 'Coordinator', to: 'Builder', body }));
  }
  // Two that must never appear anywhere: no line, and no such circle.
  await stood.provider.send({ from: 'Coordinator', to: 'Auditor', body: 'refused sideways' });
  await stood.provider.send({ from: 'Coordinator', to: 'Ghost', body: 'refused nowhere' });
  accepted.push(await stood.provider.send({ from: 'Builder', to: 'Coordinator', body: 'three' }));

  /* THE JOURNAL IS STRUCTURAL, NOT A SECOND LOG. fabric.js appends to the owner
     journal BEFORE the recipient stream, so a message cannot be delivered
     without being visible to the owner. This asserts the other direction too:
     nothing is visible to the owner that was not delivered. */
  const journal = await stood.provider.ownerJournal({ limit: 100 });
  assert.equal(journal.ok, true);
  assert.deepEqual(journal.messages.map(message => message.text), [
    'Coordinator: one',
    'Coordinator: two',
    'Builder: three'
  ], 'the journal holds exactly the accepted messages, in the order they were accepted');
  assert.deepEqual(journal.messages.map(message => message.sender), ['Coordinator', 'Coordinator', 'Builder'],
    'the journal names the circle, not the durable tree- hash');
  assert.deepEqual(journal.messages.map(message => message.id).sort(),
    accepted.map(result => result.messageId).sort());

  const journalText = JSON.stringify(journal.messages);
  assert.doesNotMatch(journalText, /refused sideways/);
  assert.doesNotMatch(journalText, /refused nowhere/);

  // And the recipient streams add up to the same three messages.
  const delivered = [
    ...await inboxBodies(stood, stood.worker.agentId),
    ...await inboxBodies(stood, stood.manager.agentId)
  ];
  assert.equal(delivered.length, journal.messages.length,
    'every journalled message was delivered to exactly one recipient stream');
  assert.deepEqual(delivered.sort(), journal.messages.map(message => message.text).sort());
});

test('an unreadable owner projection is a refusal, never a definite empty journal', async () => {
  for (const projection of [
    undefined,
    {},
    { journal: { status: 'CAUGHT_UP' } },
    { journal: { status: 'UNKNOWN', records: [] } }
  ]) {
    const provider = createLocalAgentMessageProvider({
      directory: { listNodes: () => [] },
      runtimeFactory: () => ({
        ownerActor: { actorId: 'owner', actorKind: 'owner' },
        fabric: { ownerProjection: async () => projection }
      })
    });
    const result = await provider.ownerJournal();
    assert.equal(result.ok, false,
      'a missing projection, records array, or recognized status cannot collapse into an empty success');
    assert.equal(Object.hasOwn(result, 'messages'), false,
      'a refused read must not report a definite message count');
  }
});

/* T201 (landed 2026-09-19): retention may not evict a record its declared
   reader has not read. This test used to send 22 unread reports and watch the
   journal expire its prefix; under the new law that exact scenario is a
   refusal (the unread backlog fills and nothing is discarded), which the test
   below pins. Here the reader acknowledges as it goes, so the prefix expires
   only behind what Builder has already read -- and the owner still sees the
   retained tail, which is what this test was always about. */
async function acknowledgeEverythingUnread(stood, acked) {
  const page = await stood.provider.inbox({ agentId: stood.worker.agentId, cursor: 0, limit: 100 });
  for (const record of page.page.records) {
    if (record.sequence <= acked.last) continue;
    await stood.provider.acknowledgeRead({ agentId: stood.worker.agentId, message: record.message, sequence: record.sequence });
    acked.last = record.sequence;
  }
}

test('the owner sees the latest retained messages after the journal expires its prefix', async t => {
  const stood = standUpTree(t);
  const acked = { last: 0 };
  for (let i = 0; i < 22; i += 1) {
    const sent = await stood.provider.send({ from: 'Coordinator', to: 'Builder', body: `report-${i}: ${'x'.repeat(1300)}` });
    assert.equal(sent.accepted, true);
    await acknowledgeEverythingUnread(stood, acked);
  }
  const journal = await stood.provider.ownerJournal({ limit: 2 });
  assert.equal(journal.ok, true, 'expired earlier entries must not hide the retained tail');
  assert.deepEqual(journal.messages.map(m => m.text.split(':')[1].trim()), ['report-20', 'report-21']);
  assert.match(journal.notice, /Older messages.*expired/);
  assert.ok(journal.history.floorSequence > 1);
  assert.equal(journal.messages.every(m => m.grantsAuthority === false), true);
});

test('an owner view without a cursor shows the newest page, not the first page forever', async t => {
  const stood = standUpTree(t);
  for (const body of ['one', 'two', 'three']) await stood.provider.send({ from: 'Coordinator', to: 'Builder', body });
  assert.deepEqual((await stood.provider.ownerJournal({ limit: 2 })).messages.map(m => m.text), ['Coordinator: two', 'Coordinator: three']);
  assert.deepEqual((await stood.provider.ownerJournal({ limit: 2, cursor: 0 })).messages.map(m => m.text), ['Coordinator: one', 'Coordinator: two']);
});

test('a tail read chooses its starting position once while concurrent sends advance the head', async t => {
  const stood = standUpTree(t);
  for (let i = 1; i <= 10; i++) await stood.provider.send({ from: 'Coordinator', to: 'Builder', body: `report ${i}` });
  let reads = 0;
  const provider = createLocalAgentMessageProvider({ directory: stood.tree, brokerFile: stood.brokerFile,
    now: () => stood.clock.at, runtimeFactory(options) {
      const runtime = stood.runtimeFor(options);
      return { ...runtime, fabric: { ...runtime.fabric, async ownerProjection(request) {
        reads++;
        await stood.provider.send({ from: 'Coordinator', to: 'Builder', body: `concurrent ${reads}` });
        return runtime.fabric.ownerProjection(request);
      } } };
    } });
  const result = await provider.ownerJournal({ limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(reads, 2, 'the reader must not chase a moving tail and misreport its start');
  assert.equal(result.history.startCursor, 9);
  assert.equal(result.history.nextCursor, 11);
  assert.equal(result.history.headSequence, 12);
  assert.deepEqual(result.messages.map(message => message.sequence), [10, 11]);
  const next = await provider.ownerJournal({ limit: 2, cursor: result.history.nextCursor });
  assert.deepEqual(next.messages.map(message => message.sequence), [12, 13]);
});

test('the owner projection preserves recipient identity, sequence, and durable inbox evidence across provider reconstruction', async t => {
  const stood = standUpTree(t);
  const receipt = await stood.provider.send({ from: 'Coordinator', to: 'Builder', body: 'A complete routed message.' });
  const restarted = createLocalAgentMessageProvider({ directory: stood.tree, brokerFile: stood.brokerFile,
    now: () => stood.clock.at, runtimeFactory: stood.runtimeFor });
  const result = await restarted.ownerJournal({ cursor: 0, limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.messages.length, 1);
  assert.deepEqual({ id: result.messages[0].id, sender: result.messages[0].sender, recipient: result.messages[0].recipient,
    senderId: result.messages[0].senderId, recipientId: result.messages[0].recipientId, kind: result.messages[0].kind,
    sequence: result.messages[0].sequence, deliveryState: result.messages[0].deliveryState }, {
    id: receipt.messageId, sender: 'Coordinator', recipient: 'Builder', senderId: stood.manager.agentId,
    recipientId: stood.worker.agentId, kind: 'notice', sequence: 1, deliveryState: 'available'
  });
  assert.equal(result.history.nextCursor, 1);
  assert.equal(result.messages[0].grantsAuthority, false);
  assert.deepEqual((await restarted.ownerJournal({ cursor: 1 })).messages, []);
});

test('a failed audience write remains visible to the owner and becomes confirmed only after its real inbox append', async t => {
  const stood = standUpTree(t);
  let rejectAudience = true;
  const store = { getMemory: stood.store.getMemory, setMemory(request) {
    if (rejectAudience && request.key.startsWith('history/direct.')) throw new Error('injected audience write refusal');
    return stood.store.setMemory(request);
  } };
  const runtimeFactory = options => createLocalAgentCommsRuntime({ ...options, store,
    now: () => stood.clock.at, brokerFile: stood.brokerFile, orgFile: stood.orgFile,
    presenceFile: require('node:path').join(require('node:path').dirname(stood.orgFile), 'presence.json'),
    mailboxDir: require('node:path').join(require('node:path').dirname(stood.orgFile), 'mailbox'), machineId: 'harness-machine' });
  const provider = createLocalAgentMessageProvider({ directory: stood.tree, brokerFile: stood.brokerFile,
    now: () => stood.clock.at, runtimeFactory });
  await assert.rejects(provider.send({ from: 'Coordinator', to: 'Builder', body: 'Visible even when delivery fails.' }),
    error => error.code === 'HISTORY_STORAGE_WRITE_FAILED');
  const failed = await provider.ownerJournal({ cursor: 0 });
  assert.equal(failed.ok, true);
  assert.equal(failed.messages.length, 1, 'a partial write cannot masquerade as an empty conversation');
  assert.equal(failed.messages[0].deliveryState, 'unconfirmed');
  assert.equal(failed.messages[0].recipient, 'Builder');
  assert.match(failed.notice, /without a confirmed recipient inbox write/);
  const inbox = await provider.inbox({ agentId: stood.worker.agentId, cursor: 0 });
  assert.deepEqual(inbox.page.records, []);
  const record = stood.store.getMemory({ namespace: 'agent-comms', key: 'history/owner.journal' }).value.records[0];
  rejectAudience = false;
  const { createHistory } = require('../../src/lib/agent-comms/history');
  const history = createHistory({ store, now: () => stood.clock.at });
  history.append({ channelId: record.message.streamId, message: record.message.message });
  const repaired = await provider.ownerJournal({ cursor: 0 });
  assert.equal(repaired.messages[0].id, failed.messages[0].id);
  assert.equal(repaired.messages[0].deliveryState, 'available');
  assert.equal(repaired.notice, null);
  assert.equal((await provider.inbox({ agentId: stood.worker.agentId, cursor: 0 })).page.records.length, 1);
});

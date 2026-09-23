'use strict';

// THE COURIER'S TICK, AND THE RUNTIME IT REBUILT EVERY TIME IT RAN.
//
// THE DEFECT THESE PIN, MEASURED 2026-09-03 on this checkout against an
// isolated state root -- three circles, forty messages already on the wire, a
// 12,608-byte broker spool -- driving inbox() at the shell's own 1200 ms tick:
//
//   first inbox() of a tick     11.45 / 12.24 / 14.25 ms   (min / median / max)
//   later inbox() of same tick   1.18 /  1.32 /  2.25 ms
//   whole tick, three circles   13.96 / 15.10 / 17.19 ms
//
// One runtime rebuild per tick, every tick, forever. Not because anything had
// changed -- because the memo guarding the rebuild expired after 1000 ms while
// the poll that used it runs every 1200 ms, and the two numbers live in two
// repositories. A rebuild takes the machine-wide spool lock, reads the spool,
// reconciles every claim in it and writes it back: 16.69 / 22.77 / 49.96 ms
// measured on its own.
//
// HOW A BUILD IS OBSERVED HERE. Building a runtime constructs a broker, and a
// broker rewrites its spool file at construction -- measured: an inbox() read
// that delivered nothing still moved local-broker.json's mtime while leaving
// its size identical. So "the spool file's mtime moved" IS "a runtime was
// rebuilt", read off the product rather than off a counter this test installed.
// Every act is separated by a real 20 ms so two writes can never share one
// filesystem timestamp.
//
// WHAT IS REAL: every module in the chain -- the tree directory, the local
// message provider, the local runtime, the fabric, the durable broker and the
// SQLite state store. Only WHERE they read and write is moved: the state root
// to a temp directory, through the same TOOLSENABLED_STATE_ROOT the shell sets,
// and one tree file and one spool file per test so no test can be read as
// passing on another test's leftovers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

/* The LONG form of the temp directory. On Windows os.tmpdir() answers the 8.3
   short name of the profile ("TOOLSE~2"), and runtime-state-root.js reads a
   state root that does not spell the signed-in account as a crossing into
   another Windows account -- and then refuses to read or write any state at
   all. A test that silently ran somewhere else would be worse than this one
   failing loudly, so the path is resolved rather than hoped about. */
const TEMP_ROOT = fs.realpathSync.native ? fs.realpathSync.native(os.tmpdir()) : fs.realpathSync(os.tmpdir());
const STATE_ROOT = fs.mkdtempSync(path.join(TEMP_ROOT, 'agent-comms-runtime-reuse-'));
process.env.TOOLSENABLED_STATE_ROOT = STATE_ROOT;
process.on('exit', () => { try { fs.rmSync(STATE_ROOT, { recursive: true, force: true }); } catch { /* the OS sweeps temp */ } });

const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const { createControlPlane } = require('../../src/lib/agent-comms/control-plane');
const { getStateStore } = require('../../src/lib/state-store');
const local = require('../../src/lib/providers/agent-comms-local');

const START_MS = 1_900_000_000_000;
const POLL_MS = 1_200;

/* Let the filesystem clock move, so two spool writes can never land on one
   timestamp whatever this platform's timestamp resolution turns out to be. */
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

let standing = 0;

async function standUp() {
  standing += 1;
  const suffix = `t${standing}`;
  const clock = { at: START_MS };
  const now = () => clock.at;
  const brokerFile = path.join(STATE_ROOT, `broker-${suffix}.json`);
  const tree = createTreeNodeDirectory({ file: path.join(STATE_ROOT, `tree-${suffix}.json`), now });
  const provider = local.createLocalAgentMessageProvider({ directory: tree, brokerFile, now });
  tree.registerNode({ sessionId: `session-controller-${suffix}`, nodeName: 'Controller' });
  const circle = tree.registerNode({
    sessionId: `session-circle-1-${suffix}`,
    nodeName: 'Circle1',
    managerSessionId: `session-controller-${suffix}`,
    managerName: 'Controller'
  });
  const sent = await provider.send({ from: 'Controller', to: 'Circle1', body: 'start on the intake list' });
  assert.equal(sent.accepted, true, 'the fixture must actually put a message on the wire');
  return {
    circle,
    clock,
    provider,
    suffix,
    tree,
    spoolWrittenAt: () => fs.statSync(brokerFile).mtimeMs
  };
}

test('a courier tick longer than the old one-second clock no longer rebuilds the runtime', async () => {
  const { circle, clock, provider, spoolWrittenAt } = await standUp();
  await provider.inbox({ agentId: circle.agentId, cursor: 0, limit: 10 });

  await settle();
  const before = spoolWrittenAt();

  // The shell's own tick, twice, so this is not one lucky call.
  for (const tick of [1, 2]) {
    clock.at += POLL_MS;
    await settle();
    const answer = await provider.inbox({ agentId: circle.agentId, cursor: 0, limit: 10 });
    assert.deepEqual(
      answer.page.records.map(record => record.message.body),
      ['Controller: start on the intake list'],
      `tick ${tick} must still read the message that is actually there`
    );
  }

  assert.equal(spoolWrittenAt(), before,
    'a poll interval wider than the memo rebuilt the whole runtime -- spool lock, spool read, spool rewrite -- on every tick');
});

test('a roster change the tree directory cannot show drops the held runtime at once', async () => {
  const { circle, clock, provider, spoolWrittenAt, suffix } = await standUp();
  await provider.inbox({ agentId: circle.agentId, cursor: 0, limit: 10 });

  await settle();
  const before = spoolWrittenAt();

  /* A DURABLE CHANNEL MEMBER IS ON THE ROSTER AND NOWHERE ON THE TREE. The memo
     key is built from the tree directory, so this addition is invisible to it,
     and the old rule would have gone on answering from the held runtime for the
     rest of its one-second window. Only 50 ms of that window is spent here on
     purpose: what is being pinned is that the answer is fresher than a clock,
     not that a different clock was chosen. */
  const control = createControlPlane({ store: getStateStore() });
  control.createChannel({ name: `reuse-probe-${suffix}`, actorId: 'owner' });
  control.join({ channel: `reuse-probe-${suffix}`, agentId: `late-arrival-${suffix}` });

  clock.at += 50;
  await settle();
  await provider.inbox({ agentId: circle.agentId, cursor: 0, limit: 10 });

  assert.notEqual(spoolWrittenAt(), before,
    'an agent that joined the roster where the memo key cannot see it was answered from a runtime that never heard of it');
});

test('an unchanging roster is still rebuilt once the ceiling passes, so the spool keeps being swept', async () => {
  const { circle, clock, provider, spoolWrittenAt } = await standUp();
  await provider.inbox({ agentId: circle.agentId, cursor: 0, limit: 10 });

  await settle();
  const before = spoolWrittenAt();

  clock.at += 9_000;
  await settle();
  await provider.inbox({ agentId: circle.agentId, cursor: 0, limit: 10 });
  assert.equal(spoolWrittenAt(), before, 'inside the ceiling the held runtime is still the answer');

  clock.at += 1_500;
  await settle();
  await provider.inbox({ agentId: circle.agentId, cursor: 0, limit: 10 });
  assert.notEqual(spoolWrittenAt(), before,
    'past the ceiling nothing rebuilds the broker here, so a claim left behind by a process that died is never reclaimed again');
});

test('inboxes() answers every circle with the page inbox() gives it, out of one build', async () => {
  const { clock, provider, spoolWrittenAt, suffix, tree } = await standUp();
  const second = tree.registerNode({
    sessionId: `session-circle-2-${suffix}`,
    nodeName: 'Circle2',
    managerSessionId: `session-controller-${suffix}`,
    managerName: 'Controller'
  });
  const first = tree.listNodes().find(node => node.nodeName === 'Circle1');
  await provider.send({ from: 'Controller', to: 'Circle2', body: 'take the second list' });
  await provider.send({ from: 'Controller', to: 'Circle1', body: 'and the third one' });

  const singly = new Map();
  for (const node of [first, second]) {
    const answer = await provider.inbox({ agentId: node.agentId, cursor: 0, limit: 10 });
    singly.set(node.agentId, answer.page.records.map(record => record.message.body));
  }
  assert.deepEqual(
    singly.get(first.agentId),
    ['Controller: start on the intake list', 'Controller: and the third one'],
    'the fixture itself must be the two messages Circle1 was actually sent, in the order they were sent'
  );
  assert.deepEqual(singly.get(second.agentId), ['Controller: take the second list']);

  await settle();
  clock.at += POLL_MS;
  const before = spoolWrittenAt();
  const batched = await provider.inboxes([
    { agentId: first.agentId, cursor: 0, limit: 10 },
    { agentId: second.agentId, cursor: 0, limit: 10 }
  ]);

  assert.deepEqual(
    batched.map(entry => entry.agentId),
    [first.agentId, second.agentId],
    'the answer must come back for the circles that were asked about, in the order they were asked'
  );
  for (const entry of batched) {
    assert.deepEqual(
      entry.page.records.map(record => record.message.body),
      singly.get(entry.agentId),
      'a batched page must carry exactly what the single-circle read of the same circle carries'
    );
  }
  assert.equal(spoolWrittenAt(), before,
    'a whole round of pages must cost at most one build, and on an unchanged roster it must cost none');
});

test('one unusable name in a round does not cost the other circles their messages', async () => {
  const { circle, provider } = await standUp();

  const batched = await provider.inboxes([
    { agentId: 'Not A Circle', cursor: 0, limit: 10 },
    { agentId: circle.agentId, cursor: 0, limit: 10 }
  ]);

  assert.deepEqual(
    batched.map(entry => entry.agentId),
    [circle.agentId],
    'a name the fabric can never address must drop out of the answer rather than refuse the whole round'
  );
  assert.deepEqual(
    batched[0].page.records.map(record => record.message.body),
    ['Controller: start on the intake list'],
    'and the circle that was addressable must still get its message'
  );

  /* OMITTED IS NOT EMPTY. Nothing in the answer may claim the unusable name was
     read and had nothing waiting; that is how a message is lost once, quietly,
     and never looked for again. */
  assert.equal(batched.some(entry => entry.agentId === 'Not A Circle'), false,
    'an unread circle answered with an empty page reads as "nothing arrived" for ever after');
});

test('inboxes() refuses a call that is not a list of requests, and answers an empty round emptily', async () => {
  const { provider } = await standUp();
  await assert.rejects(() => provider.inboxes('Circle1'), error => error.code === 'AGENT_INBOX_REQUESTS_INVALID');
  assert.deepEqual(await provider.inboxes([]), []);
  assert.deepEqual(await provider.inboxes(), []);
});

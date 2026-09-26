'use strict';

/* AN UNCHANGED MESSAGE SPOOL IS CHECKED ONCE, NOT ON EVERY COURIER ROUND (T1800).
 *
 * The app's tree courier reads every circle's inbox every 1.2 s, and each round
 * also asks the broker for delivery receipts (fabric.deliveryFailures). That
 * read parsed the whole machine-wide spool file, re-checked every stored entry
 * (canonical JSON plus a SHA-256 of each message) and copied it, although the
 * file had not changed since the round before: about 8 ms of main-thread work
 * per round with LIVE's shape (112 deferred handoffs, 467 KB).
 *
 * The first test is the courier's own round against a real provider, tree
 * directory and spool file. The rest hold the kept state to what it must not
 * cost: a send, a dead letter and an outside rewrite that keeps the file's size
 * and times are each seen on the very next round; a tampered spool is refused
 * on every round, never served from an earlier check; and nobody can change
 * what the next reader sees.
 *
 * Checks are counted two ways, neither of them a timing: parses of the spool
 * file's own text (JSON.parse is wrapped and calls the real parser), and
 * re-computations of a stored entry's fingerprint (crypto.createHash is wrapped;
 * a SHA-256 digest equal to a stored fingerprint is a stored entry re-checked). */

const isolation = require('../lib/isolated-environment').activate('broker-spool-checked-once');
// Circle and stream ids derive from the machine id (the hostname by default).
// Pinned, so every machine runs this test over the same ids. (About one direct
// stream id in 4,300 is refused as a credential-shaped string; these are not.)
process.env.TOOLSENABLED_MACHINE_ID = 'spool-checked-once-host';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createBroker, ROUTES } = require('../../src/lib/agent-comms/broker');
const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const { createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');

const CIRCLES = 16;
const SENDS_PER_CIRCLE = 7; // 112 deferred handoffs, as in LIVE's spool
const ROUND_MS = 1200; // the courier's tick
// The test's own reads of the file use the parser as it was before counting.
const parseJson = JSON.parse.bind(JSON);

let sequence = 0;
async function courier(t) {
  const root = fs.mkdtempSync(path.join(isolation.root, 'spool-checked-once-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = `spool-${++sequence}`;
  const clock = { at: Date.UTC(2026, 8, 24, 3, 0, 0) };
  const now = () => clock.at;
  const brokerFile = path.join(root, 'local-broker.json');
  const directory = createTreeNodeDirectory({ file: path.join(root, 'tree-nodes.json'), now });
  const manager = directory.registerNode({ sessionId: `${prefix}-manager`, nodeName: 'Manager',
    nodeKey: `${prefix}-manager-node`, treeKey: prefix, pid: process.pid });
  const circles = Array.from({ length: CIRCLES }, (_, index) => directory.registerNode({
    sessionId: `${prefix}-circle-${index}`, nodeName: `Circle${index}`, managerName: 'Manager',
    nodeKey: `${prefix}-circle-${index}-node`, treeKey: prefix, pid: process.pid }));
  const provider = createLocalAgentMessageProvider({ directory, brokerFile, now });
  const asManager = { agentSessionId: manager.sessionId, agentPrincipal: { sessionId: manager.sessionId } };
  const send = async (circle, body) => {
    clock.at += 5;
    const sent = await provider.send({ from: 'Manager', to: circle.nodeName, body }, asManager);
    assert.equal(sent.accepted, true, `${body}: ${sent.code}`);
    return sent;
  };
  for (let round = 1; round <= SENDS_PER_CIRCLE; round += 1) {
    for (const [index, circle] of circles.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await send(circle, `Circle ${index} status ${round}: suite 36/36 passed, see evidence/lane/receipts.txt.`);
    }
  }
  const everyone = [manager, ...circles];
  const cursors = new Map(everyone.map(node => [node.agentId, 0]));
  const round = async (advanceMs = ROUND_MS) => {
    clock.at += advanceMs;
    const answers = await provider.inboxes(everyone.map(node => ({
      agentId: node.agentId, cursor: cursors.get(node.agentId), limit: 25 })));
    for (const answer of answers) {
      const last = answer.page.records.at(-1);
      if (last) cursors.set(answer.agentId, last.sequence);
    }
    return new Map(answers.map(answer => [answer.agentId, answer.page]));
  };
  const spool = () => parseJson(fs.readFileSync(brokerFile, 'utf8'));
  return { provider, directory, manager, circles, brokerFile, clock, send, round, spool, asManager };
}

/* Parses of the spool file as it is on disk at that moment: every check of the
   file starts with one. Any other parse of a spool state is a copy of one
   (JSON round trip, a compact text). Other files do not hold "wakeCooldowns". */
function countSpoolParses(t, brokerFile) {
  const original = JSON.parse;
  const counter = { parses: 0, copies: 0 };
  const onDisk = () => { try { return fs.readFileSync(brokerFile, 'utf8'); } catch { return null; } };
  JSON.parse = function countedParse(text, reviver) {
    if (typeof text === 'string' && text.includes('"wakeCooldowns"')) {
      if (text === onDisk()) counter.parses += 1;
      else counter.copies += 1;
    }
    return original.call(this, text, reviver);
  };
  t.after(() => { JSON.parse = original; });
  return counter;
}

/* Stored entries whose fingerprint was computed again. */
function countFingerprints(t, state) {
  const original = crypto.createHash;
  const counter = { recomputed: 0, fingerprints: new Set() };
  counter.reset = next => {
    const entries = [...next.spool, ...next.deferred.map(row => row.entry), ...next.deadLetters.map(row => row.entry)];
    counter.recomputed = 0;
    counter.entries = entries.length;
    counter.fingerprints = new Set(entries.map(entry => entry.fingerprint));
  };
  counter.reset(state);
  crypto.createHash = function countedCreateHash(algorithm, ...rest) {
    const hash = original.call(this, algorithm, ...rest);
    if (String(algorithm).toLowerCase() !== 'sha256') return hash;
    const digest = hash.digest;
    hash.digest = function countedDigest(encoding) {
      const out = digest.call(this, encoding);
      if (encoding === 'hex' && counter.fingerprints.has(out)) counter.recomputed += 1;
      return out;
    };
    return hash;
  };
  t.after(() => { crypto.createHash = original; });
  return counter;
}

const pending = page => page.pendingDeliveries.map(row => `${row.message.id}@${row.deferredAt}`);

test('10 unchanged courier rounds over 112 deferred handoffs re-check the spool 0 times', async t => {
  const f = await courier(t);
  assert.equal(f.spool().deferred.length, CIRCLES * SENDS_PER_CIRCLE, 'the spool holds 112 deferred handoffs');
  const first = await f.round();
  assert.equal(first.size, CIRCLES + 1, 'every circle and the manager are answered');
  for (const circle of f.circles) {
    assert.equal(first.get(circle.agentId).pendingDeliveries.length, SENDS_PER_CIRCLE, 'each circle sees its handoffs');
  }
  const expected = new Map([...first].map(([agentId, page]) => [agentId, pending(page)]));

  const parses = countSpoolParses(t, f.brokerFile);
  const fingerprints = countFingerprints(t, f.spool());
  for (let index = 0; index < 10; index += 1) {
    // Twelve seconds in all: the courier's runtime is rebuilt once on the way
    // (every 10 s), which re-opens the broker and rewrites the same bytes.
    const pages = await f.round(); // eslint-disable-line no-await-in-loop
    assert.equal(pages.size, CIRCLES + 1);
    for (const [agentId, page] of pages) {
      assert.deepEqual(pending(page), expected.get(agentId), 'an unchanged round answers what the first one did');
      assert.equal(page.records.length, 0);
    }
  }
  assert.deepEqual({ spoolFileParses: parses.parses, storedEntriesRechecked: fingerprints.recomputed },
    { spoolFileParses: 0, storedEntriesRechecked: 0 },
    `10 unchanged rounds parsed the spool file ${parses.parses} times and re-checked ${fingerprints.recomputed} stored entries`);
  assert.ok(parses.copies <= 1,
    `10 unchanged rounds copied the spool state ${parses.copies} times (only the 10 s runtime rebuild may copy it)`);
});

test('a send, a dead letter and an outside rewrite are each seen on the next round, then kept again', async t => {
  const f = await courier(t);
  await f.round();
  const target = f.circles[3];
  const parses = countSpoolParses(t, f.brokerFile);
  const fingerprints = countFingerprints(t, f.spool());
  const unchangedRoundChecksNothing = async why => {
    parses.parses = 0;
    fingerprints.reset(f.spool());
    await f.round();
    assert.deepEqual({ spoolFileParses: parses.parses, storedEntriesRechecked: fingerprints.recomputed },
      { spoolFileParses: 0, storedEntriesRechecked: 0 },
      `${why}: the next unchanged round parsed the spool ${parses.parses} times and re-checked ${fingerprints.recomputed} entries`);
  };
  await unchangedRoundChecksNothing('setup');

  // A send through this process.
  const sent = await f.send(target, 'A new message after the spool was kept.');
  const afterSend = await f.round();
  const page = afterSend.get(target.agentId);
  assert.equal(page.records.length, 1, 'the new message is delivered');
  assert.equal(page.records[0].message.id, sent.messageId);
  assert.equal(page.pendingDeliveries.length, SENDS_PER_CIRCLE + 1, 'its handoff is seen on the next round');
  assert.ok(page.pendingDeliveries.some(row => row.message.id === sent.messageId));
  await unchangedRoundChecksNothing('after a send');

  // A dead letter: the recipient discards the new message.
  const discarded = await f.provider.discard({ agentId: target.agentId, message: page.records[0].message });
  assert.equal(discarded.accepted, true, discarded.code);
  const afterDiscard = await f.round();
  assert.deepEqual(afterDiscard.get(f.manager.agentId).deliveryReceipts
    .filter(row => row.code === 'BROKER_MESSAGE_DEAD_LETTERED').map(row => row.messageId), [sent.messageId],
  'the sender sees the dead letter on the next round');
  assert.equal(afterDiscard.get(target.agentId).pendingDeliveries.length, SENDS_PER_CIRCLE);
  await unchangedRoundChecksNothing('after a dead letter');

  // Another writer rewrites the file in place, keeping its size, modification
  // time and access time: one deferred handoff's time moves by 1 ms. (The
  // times are first set to whole milliseconds so they can be restored exactly.)
  const then = new Date(Date.now() - 60_000);
  fs.utimesSync(f.brokerFile, then, then);
  const before = fs.statSync(f.brokerFile);
  const raw = fs.readFileSync(f.brokerFile, 'utf8');
  const state = parseJson(raw);
  const row = state.deferred.find(item => item.entry.recipientAgentId === target.agentId);
  const moved = row.deferredAtMs % 10 === 9 ? row.deferredAtMs - 1 : row.deferredAtMs + 1;
  const edited = raw.replace(`"deferredAtMs": ${row.deferredAtMs},`, `"deferredAtMs": ${moved},`);
  assert.notEqual(edited, raw);
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength(raw));
  fs.writeFileSync(f.brokerFile, edited);
  fs.utimesSync(f.brokerFile, before.atime, before.mtime);
  assert.equal(fs.statSync(f.brokerFile).size, before.size);
  assert.equal(fs.statSync(f.brokerFile).mtimeMs, before.mtimeMs);
  parses.parses = 0;
  fingerprints.reset(state);
  const afterRewrite = await f.round();
  const deferredAt = afterRewrite.get(target.agentId).pendingDeliveries
    .find(item => item.message.id === row.entry.messageId).deferredAt;
  assert.equal(deferredAt, moved, 'the rewritten spool is read, not the kept one');
  assert.equal(parses.parses, 1, 'the rewritten spool is parsed once');
  assert.equal(fingerprints.recomputed, fingerprints.entries, 'and every stored entry in it is checked in full');
  await unchangedRoundChecksNothing('after an outside rewrite');
});

test('a tampered spool is refused on every round, never served from an earlier check', async t => {
  const f = await courier(t);
  const first = await f.round();
  const raw = fs.readFileSync(f.brokerFile, 'utf8');
  const before = fs.statSync(f.brokerFile);
  // One byte of one stored message changes; its fingerprint does not.
  const tampered = raw.replace('Circle 5 status 4: suite 36/36 passed', 'Circle 5 status 4: suite 36/36 PASSED');
  assert.notEqual(tampered, raw);
  assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(raw));
  fs.writeFileSync(f.brokerFile, tampered);
  fs.utimesSync(f.brokerFile, before.atime, before.mtime);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // The round is omitted whole (no cursor moves), exactly as for a round
    // that cannot read the spool; it is not answered from the kept state.
    assert.deepEqual(await f.round(), new Map(), `round ${attempt + 1} after the tamper was answered`); // eslint-disable-line no-await-in-loop
  }
  assert.throws(() => createBroker({ stateFile: f.brokerFile, knownAgents: [], transport: { deliver: async () => ({}) },
    livenessReceiver: { getAgent: () => null } }), { code: 'BROKER_STATE_CORRUPT' });

  fs.writeFileSync(f.brokerFile, raw);
  const repaired = await f.round();
  assert.equal(repaired.size, CIRCLES + 1, 'the repaired spool is read again');
  for (const circle of f.circles) {
    assert.deepEqual(pending(repaired.get(circle.agentId)), pending(first.get(circle.agentId)));
  }
});

function brokerOptions(t) {
  const directory = fs.mkdtempSync(path.join(isolation.root, 'spool-view-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    stateFile: path.join(directory, 'broker.json'),
    knownAgents: [{ agentId: 'agent-a', machineId: 'machine', route: ROUTES.LOCAL, sessionId: 'session-a' }],
    transport: { deliver: async attempt => ({ delivered: true, messageId: attempt.messageId }) },
    now: () => 1234,
    processIdentity: pid => ({ status: 'ALIVE', processStartIdentity: `test-process-start:${pid}` }),
    livenessReceiver: { getAgent() { return { state: 'RUNNING', freshness: 'FRESH' }; } }
  };
}

test('the shared spool view is frozen, and getState() still hands each caller its own copy', async t => {
  const options = brokerOptions(t);
  const broker = createBroker(options);
  await broker.send({ messageId: 'kept', recipientAgentId: 'agent-a', body: 'kept' });
  const view = broker.getStateView();
  assert.equal(view.deliveries.length, 1);
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view.deliveries) && Object.isFrozen(view.deliveries[0]));
  assert.throws(() => { view.deliveries.push({ forged: true }); }, TypeError);
  assert.throws(() => { view.deliveries[0].messageId = 'forged'; }, TypeError);
  assert.equal(broker.getStateView(), view, 'an unchanged spool is one shared, already-checked state');

  const copy = broker.getState();
  assert.equal(Object.isFrozen(copy), false, 'callers that change what they read still get a private copy');
  copy.deliveries.push({ forged: true });
  copy.nextSequence = 999;
  assert.deepEqual(broker.getState(), view, 'a change to one copy reaches neither the next copy nor the view');
  assert.deepEqual(createBroker(options).getState(), view, 'nor another broker over the same file');

  await broker.send({ messageId: 'second', recipientAgentId: 'agent-a', body: 'second' });
  const next = broker.getStateView();
  assert.notEqual(next, view, 'a commit through this broker is read back at once');
  assert.deepEqual(next.deliveries.map(row => row.messageId), ['kept', 'second']);
  assert.deepEqual(view.deliveries.map(row => row.messageId), ['kept'], 'a view already handed out does not change');
});

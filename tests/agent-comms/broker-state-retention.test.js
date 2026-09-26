'use strict';

// R6a-comms-engine: the broker's delivery-receipt and dead-letter logs grew
// forever. MEASURED 2026-09-04 against the Live installation's own (read-only)
// local-broker.json: 256,593 bytes, spool and dead letters both empty, and 822
// delivery receipts alone accounting for 215,365 of those bytes (84%) -- for a
// value nothing reads again after the one retry-dedup check at enqueue() time.
// Every broker operation reads, JSON.parses, deep-clones and rewrites the
// WHOLE file (see readState/commit/withStateLock in broker.js), so the cost of
// every message was proportional to the installation's entire lifetime of
// messages, not to the small set still in flight. These tests pin the fix:
// both logs keep only their most recent entries, on disk, not just in a
// computed view, and the near-term idempotency the cap exists to serve still
// works right up to the edge of the window.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_DEAD_LETTER_RETENTION,
  DEFAULT_DELIVERY_RETENTION,
  BrokerError,
  ROUTES,
  createBroker
} = require('../../src/lib/agent-comms/broker');

const agents = ['agent-a', 'agent-b'].map(agentId => ({
  agentId,
  machineId: 'machine',
  route: ROUTES.LOCAL,
  sessionId: `session-${agentId}`
}));

function options(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-retention-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    stateFile: path.join(directory, 'broker.json'),
    knownAgents: agents,
    transport: { async deliver(attempt) { return { delivered: true, messageId: attempt.messageId }; } },
    now: () => 1234,
    processIdentity: pid => ({ status: 'ALIVE', processStartIdentity: `test-process-start:${pid}` }),
    livenessReceiver: { getAgent() { return { state: 'RUNNING', freshness: 'FRESH' }; } },
    ...overrides
  };
}

function message(id, recipientAgentId) {
  return { messageId: id, recipientAgentId, body: id };
}

function readRawState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

test('delivery receipts are capped on disk, oldest evicted first, not merely hidden from getState()', async t => {
  const configured = options(t, { deliveryRetention: 4 });
  const broker = createBroker(configured);

  for (let index = 1; index <= 10; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await broker.send(message(`msg-${index}`, 'agent-a'));
    assert.equal(result.delivered, true, `send ${index} did not deliver`);
  }

  const expectedRetained = ['msg-7', 'msg-8', 'msg-9', 'msg-10'];
  assert.equal(broker.getState().deliveries.length, 4,
    'the in-memory snapshot kept more than deliveryRetention receipts');
  assert.deepEqual(broker.getState().deliveries.map(d => d.messageId), expectedRetained,
    'eviction did not keep the most recent receipts in order');

  // The bound must be a property of the STORED file -- the thing every future
  // operation parses -- not a filter applied only when reading it back.
  const onDisk = readRawState(configured.stateFile);
  assert.equal(onDisk.deliveries.length, 4, 'the file on disk still holds every receipt ever recorded');
  assert.deepEqual(onDisk.deliveries.map(d => d.messageId), expectedRetained);

  // Reopening (a fresh process rebuilding the broker, as local-runtime.js
  // does on every call) must not resurrect what was already trimmed away.
  const reopened = createBroker(configured);
  assert.equal(reopened.getState().deliveries.length, 4);
  assert.deepEqual(reopened.getState().deliveries.map(d => d.messageId), expectedRetained);
});

test('dead letters are capped independently of deliveries, and an already-oversized file is compacted the next time a broker opens', async t => {
  const configured = options(t, {
    deadLetterRetention: 3,
    transport: { async deliver() { return { delivered: false }; } }
  });
  const first = createBroker(configured);

  for (let index = 1; index <= 8; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await first.send(message(`stale-${index}`, 'agent-b'));
    assert.equal(result.delivered, false, `send ${index} unexpectedly delivered`);
  }
  assert.equal(first.getState().spool.length, 8, 'setup did not leave every message spooled for agent-b');

  // agent-b leaving the known-agent directory is what turns a spooled packet
  // into a dead letter (see the constructor sweep in createBroker). All eight
  // become dead letters in the SAME sweep -- this is the already-oversized-file
  // compaction case, not just steady-state growth.
  const reopened = createBroker({ ...configured, knownAgents: [agents[0]] });
  const state = reopened.getState();
  assert.equal(state.spool.length, 0, 'a dead-lettered-then-evicted packet must not linger in the spool');
  assert.equal(state.deadLetters.length, 3, 'more than deadLetterRetention dead letters were kept');
  assert.deepEqual(
    state.deadLetters.map(d => d.entry.messageId),
    ['stale-6', 'stale-7', 'stale-8'],
    'eviction did not keep the most recently dead-lettered packets'
  );

  const onDisk = readRawState(configured.stateFile);
  assert.equal(onDisk.deadLetters.length, 3, 'the file on disk still holds every dead letter ever recorded');
});

test('a replay within the retention window is still deduplicated; one that falls outside it is a documented, bounded trade-off, not a silent duplicate bug', async t => {
  let calls = 0;
  const configured = options(t, {
    deliveryRetention: 2,
    transport: {
      async deliver(attempt) { calls += 1; return { delivered: true, messageId: attempt.messageId }; }
    }
  });
  const broker = createBroker(configured);

  await broker.send(message('first', 'agent-a'));
  await broker.send(message('second', 'agent-a'));
  await broker.send(message('third', 'agent-a'));
  assert.equal(calls, 3);
  assert.deepEqual(broker.getState().deliveries.map(d => d.messageId), ['second', 'third'],
    'setup did not evict "first" as expected before the replay checks below');

  // Still inside the window: this is the case the receipt log exists to
  // serve, and it must keep working exactly as before this change.
  const recentReplay = await broker.send(message('third', 'agent-a'));
  assert.equal(recentReplay.code, 'BROKER_DELIVERY_REPLAY');
  assert.equal(recentReplay.delivered, true);
  assert.equal(calls, 3, 'a replay still inside the retention window called transport again');

  // Outside the window: the receipt is gone, so this is indistinguishable
  // from a brand-new send and is delivered again. That is the bound's
  // documented cost, asserted here so it can never regress silently into an
  // unbounded log again without this test forcing the choice back into view.
  const staleReplay = await broker.send(message('first', 'agent-a'));
  assert.equal(staleReplay.delivered, true);
  assert.equal(calls, 4, 'a resend past the retention window was not attempted as a new delivery');
});

test('a pre-existing on-disk file already holding more than deliveryRetention receipts is compacted the FIRST time any broker opens it, not only after further sends accumulate through this process', t => {
  const configured = options(t, { deliveryRetention: 4 });
  const rawFingerprint = 'a'.repeat(64);
  const preExisting = {
    schemaVersion: 1,
    nextSequence: 1,
    spool: [],
    deliveries: Array.from({ length: 10 }, (_, index) => ({
      messageId: `legacy-${index + 1}`,
      recipientAgentId: 'agent-a',
      recipientMachineId: null,
      fingerprint: rawFingerprint,
      deliveredAtMs: 1000 + index
    })),
    deadLetters: [],
    wakeCooldowns: []
  };
  fs.writeFileSync(configured.stateFile, JSON.stringify(preExisting, null, 2));

  // This is the Live installation's actual shape: a file that grew past any
  // cap under a build that predates this fix, opened for the very first time
  // by code that now enforces one. No send() has happened yet in this
  // process -- if compaction only ever fired from the write path
  // (recordDelivery), a file that already existed before this change shipped
  // would stay oversized forever, silently, which is exactly the failure
  // this lane was filed to close (see local-broker.json: 822 real receipts,
  // never migrated by anything).
  const broker = createBroker(configured);
  const expectedRetained = ['legacy-7', 'legacy-8', 'legacy-9', 'legacy-10'];
  assert.equal(broker.getState().deliveries.length, 4,
    'a pre-existing oversized file was not compacted on its very first open');
  assert.deepEqual(broker.getState().deliveries.map(d => d.messageId), expectedRetained,
    'compaction on open did not keep the most recently delivered receipts');

  const onDisk = readRawState(configured.stateFile);
  assert.equal(onDisk.deliveries.length, 4,
    'the on-disk file was left oversized even though the in-memory view was compacted');
  assert.deepEqual(onDisk.deliveries.map(d => d.messageId), expectedRetained);
});

test('deliveryRetention and deadLetterRetention are validated like every other broker knob', t => {
  const configured = options(t);
  assert.throws(
    () => createBroker({ ...configured, deliveryRetention: 0 }),
    error => error instanceof BrokerError && error.code === 'BROKER_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => createBroker({ ...configured, deadLetterRetention: -1 }),
    error => error instanceof BrokerError && error.code === 'BROKER_CONFIGURATION_INVALID'
  );
  // The exported defaults are the module's public contract: a positive bound
  // for each, and dead letters (full packets) budgeted no more generously
  // than receipts (small records), matching the reasoning in broker.js.
  assert.equal(Number.isSafeInteger(DEFAULT_DELIVERY_RETENTION) && DEFAULT_DELIVERY_RETENTION > 0, true);
  assert.equal(Number.isSafeInteger(DEFAULT_DEAD_LETTER_RETENTION) && DEFAULT_DEAD_LETTER_RETENTION > 0, true);
  assert.equal(DEFAULT_DEAD_LETTER_RETENTION <= DEFAULT_DELIVERY_RETENTION, true);
});

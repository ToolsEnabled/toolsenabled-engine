'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBroker } = require('../../src/lib/agent-comms/broker');

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-refusals-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const options = {
    stateFile: path.join(directory, 'state.json'),
    knownAgents: [{ agentId: 'agent-a', sessionId: 'session-a', route: 'peer' }],
    transport: { async deliver(attempt) { calls.push(attempt); return { delivered: true, messageId: attempt.messageId }; } },
    livenessReceiver: { getAgent() { return { freshness: 'FRESH', state: 'RUNNING' }; } },
    now: () => 1000,
    ...overrides
  };
  return { directory, options, calls };
}

function message(messageId, body = 'body') {
  return { messageId, recipientAgentId: 'agent-a', body };
}

test('configuration, message, clock, lock, and stored-state refusals are driven', async t => {
  const invalidConfiguration = fixture(t);
  assert.throws(
    () => createBroker({ ...invalidConfiguration.options, wakeCooldownMs: 0 }),
    error => error.code === 'BROKER_CONFIGURATION_INVALID'
  );
  assert.equal(invalidConfiguration.calls.length, 0);
  assert.equal(fs.existsSync(invalidConfiguration.options.stateFile), false);

  const invalidMessage = fixture(t);
  const invalidMessageBroker = createBroker(invalidMessage.options);
  const rejected = await invalidMessageBroker.send({ messageId: '', recipientAgentId: 'agent-a' });
  assert.deepEqual(rejected, {
    accepted: false, code: 'BROKER_MESSAGE_INVALID', state: null, delivered: false, spooled: false
  });
  assert.equal(invalidMessage.calls.length, 0);
  assert.equal(invalidMessageBroker.getSpool().length, 0);

  const invalidClock = fixture(t, { now: () => NaN });
  const invalidClockBroker = createBroker(invalidClock.options);
  await assert.rejects(invalidClockBroker.send(message('clock')), error => error.code === 'BROKER_CLOCK_INVALID');
  assert.equal(invalidClock.calls.length, 0);
  assert.equal(invalidClockBroker.getSpool().length, 0);

  const locked = fixture(t);
  fs.mkdirSync(path.dirname(locked.options.stateFile), { recursive: true });
  fs.writeFileSync(`${locked.options.stateFile}.lock`, 'held');
  assert.throws(() => createBroker(locked.options), error => error.code === 'BROKER_STATE_LOCKED');
  assert.equal(locked.calls.length, 0);
  assert.equal(fs.existsSync(locked.options.stateFile), false);

  const unavailable = fixture(t);
  const originalOpenSync = fs.openSync;
  fs.openSync = function injectedLockFailure(file, flags, ...rest) {
    const lockPublicationPrefix = `${path.resolve(unavailable.options.stateFile)}.lock`;
    if (typeof file === 'string' && file.startsWith(lockPublicationPrefix) && flags === 'wx') {
      const error = new Error('injected lock storage failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalOpenSync.call(this, file, flags, ...rest);
  };
  try {
    assert.throws(
      () => createBroker(unavailable.options),
      error => error.code === 'BROKER_STATE_UNAVAILABLE' && error.cause.code === 'EACCES'
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(unavailable.calls.length, 0);
  assert.equal(fs.existsSync(unavailable.options.stateFile), false);

  const corrupt = fixture(t);
  fs.writeFileSync(corrupt.options.stateFile, '{not-json');
  assert.throws(() => createBroker(corrupt.options), error => error.code === 'BROKER_STATE_CORRUPT');
  assert.equal(corrupt.calls.length, 0);
  assert.equal(fs.readFileSync(corrupt.options.stateFile, 'utf8'), '{not-json');
});

test('message-id conflict and drain completion preserve the queued message', async t => {
  const harness = fixture(t, {
    livenessReceiver: { getAgent() { return { freshness: 'FRESH', state: 'STOPPED' }; } }
  });
  const broker = createBroker(harness.options);
  const first = await broker.send(message('same-id', 'first'));
  assert.equal(first.spooled, true);

  const conflict = await broker.send(message('same-id', 'different'));
  assert.equal(conflict.code, 'BROKER_MESSAGE_ID_CONFLICT');
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.spooled, false);
  assert.equal(harness.calls.length, 0);
  assert.deepEqual(broker.getSpool().map(entry => entry.message.body), ['first']);

  const drained = await broker.drain();
  assert.equal(drained.code, 'BROKER_DRAIN_COMPLETE');
  assert.equal(drained.attempted, 0);
  assert.equal(drained.delivered, 0);
  assert.equal(drained.remaining, 1);
  assert.equal(harness.calls.length, 0);
});

test('a failed first message blocks later delivery order without transport calls', async t => {
  let reads = 0;
  const harness = fixture(t, {
    livenessReceiver: { getAgent() {
      reads += 1;
      if (reads <= 2) return { freshness: 'FRESH', state: 'STOPPED' };
      throw new Error('first queued entry cannot be measured');
    } }
  });
  const broker = createBroker(harness.options);
  await broker.send(message('ordered-1'));
  await broker.send(message('ordered-2'));
  const result = await broker.drain();
  assert.equal(result.results[0].code, 'BROKER_LIVENESS_UNAVAILABLE');
  assert.equal(result.results[1].code, 'BROKER_ORDER_BLOCKED');
  assert.equal(result.results[1].attempted, false);
  assert.equal(result.remaining, 2);
  assert.equal(harness.calls.length, 0);
});

test('wake accepted but not executed, cooldown, and port failure all refuse delivery', async t => {
  const wakeCalls = [];
  const harness = fixture(t, {
    livenessReceiver: { getAgent() { return { freshness: 'FRESH', state: 'IDLE' }; } },
    wakePort: async request => { wakeCalls.push(request); return { accepted: true, executed: false }; }
  });
  const broker = createBroker(harness.options);
  const first = await broker.send(message('wake-1'));
  assert.equal(first.code, 'BROKER_WAKE_NOT_EXECUTED');
  assert.equal(first.wake.code, 'BROKER_WAKE_ACCEPTED');
  assert.equal(first.wake.accepted, true);
  assert.equal(first.wake.executed, false);
  const second = await broker.send(message('wake-2'));
  assert.equal(second.code, 'BROKER_ORDER_BLOCKED');
  const cooldownDrain = await broker.drain();
  assert.equal(cooldownDrain.results[0].code, 'BROKER_WAKE_NOT_EXECUTED');
  assert.equal(cooldownDrain.results[0].wake.code, 'BROKER_WAKE_COOLDOWN');
  assert.equal(cooldownDrain.results[0].wake.requested, false);
  assert.equal(wakeCalls.length, 1);
  assert.equal(harness.calls.length, 0);
  assert.equal(broker.getSpool().length, 2);

  const failed = fixture(t, {
    livenessReceiver: { getAgent() { return { freshness: 'FRESH', state: 'IDLE' }; } },
    wakePort: async () => { throw new Error('injected wake-port failure'); }
  });
  const failedBroker = createBroker(failed.options);
  const failedResult = await failedBroker.send(message('wake-failed'));
  assert.equal(failedResult.code, 'BROKER_WAKE_NOT_EXECUTED');
  assert.equal(failedResult.wake.code, 'BROKER_WAKE_PORT_FAILED');
  assert.equal(failedResult.wake.requested, true);
  assert.equal(failed.calls.length, 0);
  assert.equal(failedBroker.getSpool().length, 1);
});

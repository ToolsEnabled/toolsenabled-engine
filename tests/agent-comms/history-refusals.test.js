'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHistory, HistoryError } = require('../../src/lib/agent-comms/history');

function adapter({ entry = null, readError = null, writeError = null } = {}) {
  const calls = { reads: 0, writes: 0 };
  return {
    calls,
    getMemory() {
      calls.reads += 1;
      if (readError) throw readError;
      return entry;
    },
    setMemory() {
      calls.writes += 1;
      if (writeError) throw writeError;
      return { revision: 1 };
    }
  };
}

function refusal(code, run, store, { reads } = {}) {
  assert.throws(run, error => {
    assert.ok(error instanceof HistoryError);
    assert.equal(error.code, code);
    return true;
  });
  assert.equal(store.calls.writes, 0, `${code} must not write`);
  if (reads !== undefined) assert.equal(store.calls.reads, reads);
}

test('configuration and argument refusals happen before storage effects', () => {
  const missingStore = adapter();
  refusal('HISTORY_CONFIGURATION_INVALID', () => createHistory(), missingStore, { reads: 0 });

  const badConfiguration = adapter();
  refusal('HISTORY_CONFIGURATION_INVALID', () => createHistory({ store: badConfiguration, retention: 0 }), badConfiguration, { reads: 0 });

  const badArgument = adapter();
  const history = createHistory({ store: badArgument });
  refusal('HISTORY_INVALID_ARGUMENT', () => history.append({ channelId: 'channel' }), badArgument, { reads: 0 });
});

test('invalid, secret, and oversized messages are rejected before reading or writing', () => {
  for (const [code, message] of [
    ['HISTORY_MESSAGE_INVALID', { value: Number.NaN }],
    ['HISTORY_SECRET_REJECTED', { apiKey: 'not-even-a-real-secret' }],
    ['HISTORY_MESSAGE_TOO_LARGE', 'x'.repeat(65)]
  ]) {
    const store = adapter();
    const history = createHistory({ store, maxMessageBytes: 64 });
    refusal(code, () => history.append({ channelId: 'channel', message }), store, { reads: 0 });
  }
});

test('invalid clock refuses append before durable storage access', () => {
  const store = adapter();
  const history = createHistory({ store, now: () => -1 });
  refusal('HISTORY_CLOCK_INVALID', () => history.append({ channelId: 'channel', message: 'hello' }), store, { reads: 0 });
});

test('storage read failures and invalid storage entries never write', () => {
  const readFailure = adapter({ readError: new Error('disk unavailable') });
  refusal('HISTORY_STORAGE_READ_FAILED', () => createHistory({ store: readFailure }).read({ channelId: 'channel' }), readFailure, { reads: 1 });

  const invalidEntry = adapter({ entry: { revision: 0, value: {} } });
  refusal('HISTORY_STORAGE_INVALID', () => createHistory({ store: invalidEntry }).read({ channelId: 'channel' }), invalidEntry, { reads: 1 });
});

test('corrupt channel state is refused rather than repaired or overwritten', () => {
  const store = adapter({ entry: { revision: 1, value: { schemaVersion: 1, channelId: 'wrong', floorSequence: 1, headSequence: 0, records: [] } } });
  refusal('HISTORY_STATE_CORRUPT', () => createHistory({ store }).append({ channelId: 'channel', message: 'hello' }), store, { reads: 1 });
});

test('acknowledgement beyond the channel head does not create a cursor', () => {
  const store = adapter();
  refusal('HISTORY_ACK_BEYOND_HEAD', () => createHistory({ store }).acknowledge({ agentId: 'agent', channelId: 'channel', sequence: 1 }), store, { reads: 1 });
});

test('a single record that fits alone but not in its channel envelope refuses capacity', () => {
  const store = adapter();
  const history = createHistory({ store, maxChannelBytes: 1024, maxMessageBytes: 1024, now: () => 0 });
  // JSON(message) is below 1024 and the record is below 1024, while the
  // required channel metadata pushes the complete durable value over budget.
  refusal('HISTORY_CHANNEL_CAPACITY', () => history.append({ channelId: 'channel', message: 'x'.repeat(950) }), store, { reads: 1 });
});

test('exhausted optimistic-concurrency retries refuse without a successful write', () => {
  const conflict = Object.assign(new Error('raced'), { code: 'MEMORY_REVISION_CONFLICT' });
  const store = adapter({ writeError: conflict });
  const history = createHistory({ store, maxWriteRetries: 2, now: () => 0 });
  assert.throws(() => history.append({ channelId: 'channel', message: 'hello' }), error => {
    assert.equal(error.code, 'HISTORY_CONCURRENCY_RETRY_EXHAUSTED');
    assert.equal(error.details.attempts, 2);
    assert.equal(error.cause, conflict);
    return true;
  });
  assert.equal(store.calls.reads, 2);
  assert.equal(store.calls.writes, 2, 'each attempted write conflicted; none succeeded');
});

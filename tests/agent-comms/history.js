'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHistory, HistoryError } = require('../../src/lib/agent-comms/history');
const { createStateStore } = require('../../src/lib/state-store');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function keyOf(namespace, key) {
  return `${namespace}\u0000${key}`;
}

function createMemoryStore({ onBeforeSet = null } = {}) {
  const values = new Map();
  let beforeSet = onBeforeSet;
  return Object.freeze({
    getMemory({ namespace, key }) {
      const entry = values.get(keyOf(namespace, key));
      return entry ? clone(entry) : null;
    },
    setMemory({ namespace, key, value, expectedRevision }) {
      if (beforeSet) {
        const hook = beforeSet;
        beforeSet = null;
        hook();
      }
      const lookup = keyOf(namespace, key);
      const prior = values.get(lookup);
      const actualRevision = prior ? prior.revision : 0;
      if (actualRevision !== expectedRevision) {
        const error = new Error('revision conflict');
        error.code = 'MEMORY_REVISION_CONFLICT';
        throw error;
      }
      const entry = { namespace, key, revision: actualRevision + 1, value: clone(value) };
      values.set(lookup, entry);
      return { entry: clone(entry), created: !prior, replayed: false };
    }
  });
}

function fixture(options = {}) {
  let time = options.now ?? 10_000;
  const store = options.store || createMemoryStore(options);
  const history = createHistory({
    store,
    retention: options.retention ?? 10,
    maxChannelBytes: options.maxChannelBytes ?? 8 * 1024,
    maxMessageBytes: options.maxMessageBytes ?? 1024,
    now: () => time
  });
  return {
    history,
    store,
    advance(ms = 1) { time += ms; }
  };
}

function append(history, channelId, text) {
  return history.append({ channelId, message: { text } });
}

test('append and read back preserve a total in-channel order', () => {
  const { history, advance } = fixture();
  assert.equal(append(history, 'ops', 'first').sequence, 1);
  advance();
  assert.equal(append(history, 'ops', 'second').sequence, 2);
  advance();
  assert.equal(append(history, 'ops', 'third').sequence, 3);

  const result = history.read({ channelId: 'ops', afterSequence: 0 });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.records.map(record => [record.sequence, record.message.text]), [
    [1, 'first'], [2, 'second'], [3, 'third']
  ]);
});

test('replay from a cursor returns exactly its ordered tail', () => {
  const { history } = fixture();
  for (const text of ['one', 'two', 'three', 'four']) append(history, 'ops', text);

  const result = history.read({ channelId: 'ops', afterSequence: 2 });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.records.map(record => record.sequence), [3, 4]);
  assert.deepEqual(result.records.map(record => record.message.text), ['three', 'four']);
});

test('replay from zero returns all retained history', () => {
  const { history } = fixture();
  append(history, 'ops', 'one');
  append(history, 'ops', 'two');

  const result = history.read({ channelId: 'ops', afterSequence: 0 });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.records.map(record => record.sequence), [1, 2]);
});

test('replay from beyond the head is empty rather than an error', () => {
  const { history } = fixture();
  append(history, 'ops', 'one');

  const result = history.read({ channelId: 'ops', afterSequence: 99 });
  assert.equal(result.status, 'OK');
  assert.equal(result.headSequence, 1);
  assert.deepEqual(result.records, []);
});

test('a cursor before the retention floor receives explicit TRUNCATED rather than a partial tail', () => {
  const { history } = fixture({ retention: 2 });
  append(history, 'ops', 'one');
  append(history, 'ops', 'two');
  append(history, 'ops', 'three');

  const result = history.read({ channelId: 'ops', afterSequence: 0 });
  assert.equal(result.status, 'TRUNCATED');
  assert.equal(result.floorSequence, 2);
  assert.equal(result.headSequence, 3);
  assert.deepEqual(result.records, []);
});

test('a crash between replay and acknowledgement replays records instead of losing them', () => {
  const { history, store } = fixture();
  append(history, 'ops', 'one');
  append(history, 'ops', 'two');

  const first = history.replay({ agentId: 'agent-a', channelIds: ['ops'] }).channels[0];
  assert.equal(first.cursorSequence, 0);
  assert.deepEqual(first.records.map(record => record.sequence), [1, 2]);

  // Simulated restart: the second facade sees the same durable storage but no
  // acknowledgement was written before the first process disappeared.
  const restarted = createHistory({ store, now: () => 10_001 });
  const replay = restarted.replay({ agentId: 'agent-a', channelIds: ['ops'] }).channels[0];
  assert.equal(replay.cursorSequence, 0);
  assert.deepEqual(replay.records.map(record => record.sequence), [1, 2]);

  assert.equal(restarted.acknowledge({ agentId: 'agent-a', channelId: 'ops', sequence: 2 }).advanced, true);
  assert.deepEqual(restarted.replay({ agentId: 'agent-a', channelIds: ['ops'] }).channels[0].records, []);
});

test('interleaved concurrent writers retry their CAS and retain one valid total order', () => {
  let second;
  const store = createMemoryStore({
    onBeforeSet() {
      second = createHistory({ store, now: () => 10_001 });
      append(second, 'ops', 'second-writer');
    }
  });
  const first = createHistory({ store, now: () => 10_000 });

  const record = append(first, 'ops', 'first-writer');
  assert.equal(record.sequence, 2);
  const records = first.read({ channelId: 'ops', afterSequence: 0 }).records;
  assert.deepEqual(records.map(entry => entry.sequence), [1, 2]);
  assert.deepEqual(records.map(entry => entry.message.text), ['second-writer', 'first-writer']);
});

test('retention pruning leaves live cursors intact and makes their lag visible', () => {
  const { history } = fixture({ retention: 2 });
  append(history, 'ops', 'one');
  assert.equal(history.acknowledge({ agentId: 'agent-a', channelId: 'ops', sequence: 1 }).advanced, true);
  append(history, 'ops', 'two');
  append(history, 'ops', 'three');
  append(history, 'ops', 'four');

  assert.equal(history.getCursor({ agentId: 'agent-a', channelId: 'ops' }).sequence, 1);
  const replay = history.replay({ agentId: 'agent-a', channelIds: ['ops'] }).channels[0];
  assert.equal(replay.status, 'TRUNCATED');
  assert.equal(replay.floorSequence, 3);
  assert.throws(
    () => history.acknowledge({ agentId: 'agent-a', channelId: 'ops', sequence: 4 }),
    error => error instanceof HistoryError && error.code === 'HISTORY_CURSOR_TRUNCATED'
  );
});

test('the injected production StateStore memory API supplies durable revisioned storage', t => {
  const store = createStateStore({ file: ':memory:' });
  t.after(() => store.close());
  const history = createHistory({ store, now: () => 10_000 });

  append(history, 'ops', 'durably stored');
  assert.deepEqual(history.read({ channelId: 'ops', afterSequence: 0 }).records.map(record => record.message.text), ['durably stored']);
});

/* T201: A MESSAGE MUST NOT EXPIRE BEFORE ITS SESSION HAS READ IT.
 *
 * Retention evicted the oldest record on every append that crossed the bound,
 * by count and then by bytes, without reference to any reader's position. The
 * test above this one ('retention pruning leaves live cursors intact...') pins
 * what that costs: agent-a acknowledged sequence 1, sequences 2 and 3 were
 * dropped unread, and all the reader gets back is TRUNCATED and a floor. That
 * is the app's "Earlier agent messages have expired before this session could
 * read them" -- a description of a loss, not a remedy.
 *
 * These drive append() and acknowledge() WITH VALUES. They do not assert how
 * the floor is computed, only that a record a declared reader has not
 * acknowledged is still there to be read, and that the refusal, when the
 * channel genuinely cannot take another record, NAMES ITSELF.
 *
 * The unchanged half is pinned too: a channel that declares no reader prunes
 * exactly as it did, because there is nobody there to be behind. */

function appendFor(history, channelId, text, readers) {
  return history.append({ channelId, message: { text }, readers });
}

test('a record its declared reader has not acknowledged is not evicted to make room', () => {
  const { history } = fixture({ retention: 2 });
  appendFor(history, 'ops', 'one', ['agent-a']);
  appendFor(history, 'ops', 'two', ['agent-a']);

  assert.throws(
    () => appendFor(history, 'ops', 'three', ['agent-a']),
    error => error instanceof HistoryError && error.code === 'HISTORY_CHANNEL_UNREAD_FULL',
    'the third append silently destroyed a message agent-a had never read',
  );
  const page = history.read({ channelId: 'ops', afterSequence: 0 });
  assert.equal(page.status, 'OK', 'the reader was told its unread prefix had expired');
  assert.deepEqual(page.records.map(record => record.message.text), ['one', 'two']);
  assert.equal(history.replay({ agentId: 'agent-a', channelIds: ['ops'] }).channels[0].status, 'OK');
});

test('reading releases the room: what the reader has acknowledged becomes evictable', () => {
  const { history } = fixture({ retention: 2 });
  appendFor(history, 'ops', 'one', ['agent-a']);
  appendFor(history, 'ops', 'two', ['agent-a']);
  assert.equal(history.acknowledge({ agentId: 'agent-a', channelId: 'ops', sequence: 1 }).advanced, true);

  assert.equal(appendFor(history, 'ops', 'three', ['agent-a']).sequence, 3);
  // Read from where agent-a actually is. A read from zero is TRUNCATED once the
  // acknowledged prefix has gone, which is correct and is pinned above.
  assert.deepEqual(
    history.read({ channelId: 'ops', afterSequence: 1 }).records.map(record => record.message.text),
    ['two', 'three'],
    'the acknowledged record should have made room, and only it',
  );
  assert.equal(history.replay({ agentId: 'agent-a', channelIds: ['ops'] }).channels[0].status, 'OK',
    'the reader was told its own unread tail had expired');
  assert.throws(
    () => appendFor(history, 'ops', 'four', ['agent-a']),
    error => error instanceof HistoryError && error.code === 'HISTORY_CHANNEL_UNREAD_FULL',
    'sequence 2 was still unread and was evicted anyway',
  );
});

test('the slowest declared reader sets the floor, not the fastest', () => {
  const { history } = fixture({ retention: 2 });
  appendFor(history, 'ops', 'one', ['agent-a', 'agent-b']);
  appendFor(history, 'ops', 'two', ['agent-a', 'agent-b']);
  assert.equal(history.acknowledge({ agentId: 'agent-a', channelId: 'ops', sequence: 2 }).advanced, true);

  assert.throws(
    () => appendFor(history, 'ops', 'three', ['agent-a', 'agent-b']),
    error => error instanceof HistoryError && error.code === 'HISTORY_CHANNEL_UNREAD_FULL',
    'agent-b had read nothing and its records were dropped because agent-a was caught up',
  );
  assert.equal(history.acknowledge({ agentId: 'agent-b', channelId: 'ops', sequence: 2 }).advanced, true);
  assert.equal(appendFor(history, 'ops', 'three', ['agent-a', 'agent-b']).sequence, 3);
});

test('a reader declared once keeps its protection on later appends that do not name it', () => {
  const { history } = fixture({ retention: 2 });
  appendFor(history, 'ops', 'one', ['agent-a']);
  // The second writer does not know the audience; the channel already does.
  append(history, 'ops', 'two');
  assert.throws(
    () => append(history, 'ops', 'three'),
    error => error instanceof HistoryError && error.code === 'HISTORY_CHANNEL_UNREAD_FULL',
    'the channel forgot its reader as soon as one append omitted it',
  );
});

test('a channel with no declared reader prunes exactly as it always did', () => {
  const { history } = fixture({ retention: 2 });
  append(history, 'ops', 'one');
  append(history, 'ops', 'two');
  assert.equal(append(history, 'ops', 'three').sequence, 3);
  const page = history.read({ channelId: 'ops', afterSequence: 0 });
  assert.equal(page.status, 'TRUNCATED', 'an undeclared channel stopped pruning, so nothing was truncated');
  assert.equal(page.floorSequence, 2);
  assert.deepEqual(
    history.read({ channelId: 'ops', afterSequence: 1 }).records.map(record => record.message.text),
    ['two', 'three'],
    'a channel nobody declared a reader for must keep its bounded, self-pruning behaviour',
  );
});

test('the byte budget may not evict an unread record either', () => {
  const { history } = fixture({ retention: 1_000, maxChannelBytes: 1_400, maxMessageBytes: 400 });
  const filler = 'x'.repeat(300);
  let appended = 0;
  let refusal = null;
  for (let index = 0; index < 20; index += 1) {
    try {
      appendFor(history, 'ops', `${filler}-${index}`, ['agent-a']);
      appended += 1;
    } catch (error) {
      refusal = error;
      break;
    }
  }
  assert.ok(appended >= 1, 'the channel could not take a single record');
  assert.ok(refusal instanceof HistoryError, 'the byte budget dropped an unread record instead of refusing');
  assert.equal(refusal.code, 'HISTORY_CHANNEL_UNREAD_FULL');
  const page = history.read({ channelId: 'ops', afterSequence: 0 });
  assert.equal(page.status, 'OK');
  assert.equal(page.records.length, appended, 'a record nobody had read was evicted by the byte budget');
  assert.equal(page.records[0].sequence, 1, 'the oldest unread record is gone');
});

'use strict';

/* A STORED CHANNEL IS VALIDATED ONCE PER STORED VALUE (T1762).
 *
 * The app's tree courier reads every circle's direct channel every 1.2 s. With
 * 45 circles at the 32 KiB cap, each round re-verified every stored value
 * (canonical JSON, SHA-256, credential scan) and re-validated every record,
 * although nothing had changed since the round before -- measured offline at
 * 51-73 ms of main-thread work per round, a round every 1.2 s.
 *
 * The first test is the courier's shape against the real StateStore. The rest
 * pin down that reusing a validated channel never serves a changed, corrupt
 * or unverifiable value. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createHistory, HistoryError } = require('../../src/lib/agent-comms/history');
const { createStateStore } = require('../../src/lib/state-store');

function realStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-validated-once-'));
  const file = path.join(dir, 'state.sqlite3');
  const store = createStateStore({ file, busyTimeoutMs: 2000 });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, file };
}

function countHashes(t) {
  const original = crypto.createHash;
  const counter = { sha256: 0 };
  crypto.createHash = function countedCreateHash(algorithm, ...rest) {
    if (String(algorithm).toLowerCase() === 'sha256') counter.sha256 += 1;
    return original.call(this, algorithm, ...rest);
  };
  t.after(() => { crypto.createHash = original; });
  return counter;
}

const report = (circle, sequence) => ({
  from: 'Controller',
  body: `Circle ${circle} message ${sequence}: suite 36/36 passed, mutant 34/36 failed as expected, restored 36/36. `
    + 'See evidence/lane/report.md and src/lib/agent-comms/fabric.js line 1141 for the receipts. '.repeat(9)
});

test('45 full channels read every tick: unchanged rounds re-verify nothing, an append costs one read of one channel', t => {
  const { store } = realStore(t);
  let clock = Date.UTC(2026, 8, 24, 1, 0, 0);
  const history = createHistory({ store, maxChannelBytes: 32 * 1024, maxMessageBytes: 4 * 1024, now: () => clock });
  const channels = Array.from({ length: 45 }, (_, index) => `direct.circle-${index}`);
  channels.forEach((channelId, index) => {
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      clock += 5;
      history.append({ channelId, message: report(index, sequence) });
    }
  });
  const heads = new Map();
  for (const channelId of channels) {
    const probe = history.read({ channelId });
    const page = history.read({ channelId, afterSequence: probe.floorSequence - 1 });
    assert.equal(page.status, 'OK');
    assert.ok(page.records.length >= 25, `${channelId} holds a full stream (${page.records.length} records)`);
    assert.ok(page.floorSequence > 1, `${channelId} is at its byte cap, so the oldest records were evicted`);
    heads.set(channelId, page.headSequence);
  }
  for (const channelId of channels) history.read({ channelId, afterSequence: heads.get(channelId) });

  const hashes = countHashes(t);
  for (let round = 0; round < 10; round += 1) {
    for (const channelId of channels) {
      const page = history.read({ channelId, afterSequence: heads.get(channelId) });
      assert.equal(page.status, 'OK');
      assert.equal(page.records.length, 0);
    }
  }
  assert.equal(hashes.sha256, 0, `10 unchanged rounds over 45 full channels re-verified ${hashes.sha256} stored values`);

  hashes.sha256 = 0;
  clock += 5;
  const appended = history.append({ channelId: channels[3], message: report(3, 41) });
  const verificationsForAppend = hashes.sha256;
  hashes.sha256 = 0;
  const pages = channels.map(channelId => history.read({ channelId, afterSequence: heads.get(channelId) }));
  assert.equal(pages[3].records.length, 1, 'the new record is delivered');
  assert.equal(pages[3].records[0].sequence, appended.sequence);
  assert.deepEqual(pages[3].records[0].message, report(3, 41));
  assert.ok(pages.every((page, index) => index === 3 || page.records.length === 0));
  assert.equal(hashes.sha256, 0, `the round after an append re-verified ${hashes.sha256} stored values`);
  assert.ok(verificationsForAppend <= 3, `the append itself verified ${verificationsForAppend} values`);
});

test('a stored channel changed behind the store is not served from an earlier validation', t => {
  const { store, file } = realStore(t);
  const history = createHistory({ store, maxChannelBytes: 32 * 1024 });
  history.append({ channelId: 'direct.a', message: { body: 'first' } });
  assert.equal(history.read({ channelId: 'direct.a' }).records.length, 1);

  // Closed before any assertion: Windows will not remove a directory that
  // still has the database open.
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("SELECT value_json, value_hash FROM memory_entries WHERE entry_key = 'history/direct.a'").get();
    const forged = row.value_json.replace('"first"', '"forged"');
    assert.notEqual(forged, row.value_json);
    db.prepare("UPDATE memory_entries SET value_json = ? WHERE entry_key = 'history/direct.a'").run(forged);
  } finally { db.close(); }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => history.read({ channelId: 'direct.a' }), error => {
      assert.ok(error instanceof HistoryError);
      assert.equal(error.code, 'HISTORY_STORAGE_READ_FAILED');
      return true;
    });
  }
});

// A memory adapter that returns a freshly parsed value on every read, like
// StateStore, and counts how often the stored channel's records are walked.
function countingAdapter(initial) {
  const state = { stored: initial, revision: 1, valueHash: 'a'.repeat(64), walks: 0 };
  return {
    state,
    getMemory() {
      const value = JSON.parse(JSON.stringify(state.stored));
      const watched = new Proxy(value, {
        get(target, key, receiver) {
          if (key === 'records') state.walks += 1;
          return Reflect.get(target, key, receiver);
        }
      });
      const entry = { namespace: 'agent-comms', key: 'history/direct.a', value: watched, revision: state.revision };
      if (state.valueHash !== undefined) entry.valueHash = state.valueHash;
      return entry;
    },
    setMemory() { throw new Error('not used'); }
  };
}

const channel = records => ({
  schemaVersion: 1,
  channelId: 'direct.a',
  floorSequence: 1,
  headSequence: records.length,
  records: records.map((body, index) => ({ sequence: index + 1, appendedAtMs: 1000 + index, message: { body } })),
  readers: []
});

test('an unchanged revision and hash are validated once; a new revision or hash is validated again', () => {
  const adapter = countingAdapter(channel(['one', 'two']));
  const history = createHistory({ store: adapter });
  assert.equal(history.read({ channelId: 'direct.a' }).records.length, 2);
  const walksForOneValidation = adapter.state.walks;
  assert.ok(walksForOneValidation > 0);
  for (let read = 0; read < 9; read += 1) assert.equal(history.read({ channelId: 'direct.a' }).records.length, 2);
  assert.equal(adapter.state.walks, walksForOneValidation,
    `nine more unchanged reads walked the stored records ${adapter.state.walks - walksForOneValidation} more times`);

  adapter.state.stored = channel(['one', 'two', 'three']);
  adapter.state.revision = 2;
  adapter.state.valueHash = 'b'.repeat(64);
  const walksBefore = adapter.state.walks;
  assert.deepEqual(history.read({ channelId: 'direct.a', afterSequence: 2 }).records.map(record => record.message.body), ['three']);
  assert.ok(adapter.state.walks > walksBefore, 'a new revision is validated');
});

test('an adapter without a stored-value hash is validated on every read, as before', () => {
  const adapter = countingAdapter(channel(['one']));
  adapter.state.valueHash = undefined;
  const history = createHistory({ store: adapter });
  history.read({ channelId: 'direct.a' });
  const walksForOneValidation = adapter.state.walks;
  assert.ok(walksForOneValidation > 0);
  for (let read = 0; read < 4; read += 1) history.read({ channelId: 'direct.a' });
  assert.equal(adapter.state.walks, 5 * walksForOneValidation, 'every read without a hash validates the channel');
});

test('a corrupt stored channel is refused on every read, never remembered', () => {
  const corrupt = channel(['one', 'two']);
  corrupt.headSequence = 5;
  const adapter = countingAdapter(corrupt);
  const history = createHistory({ store: adapter });
  for (let read = 0; read < 3; read += 1) {
    assert.throws(() => history.read({ channelId: 'direct.a' }), error => error instanceof HistoryError && error.code === 'HISTORY_STATE_CORRUPT');
  }
});

test('records handed out are frozen copies, so a caller cannot change what the next read returns', () => {
  const adapter = countingAdapter(channel(['one']));
  const history = createHistory({ store: adapter });
  const first = history.read({ channelId: 'direct.a' });
  assert.ok(Object.isFrozen(first.records[0].message));
  assert.throws(() => { first.records[0].message.body = 'changed'; }, TypeError);
  assert.equal(history.read({ channelId: 'direct.a' }).records[0].message.body, 'one');
});

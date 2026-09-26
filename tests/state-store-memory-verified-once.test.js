'use strict';

/* A STORED MEMORY ROW IS VERIFIED ONCE PER STORED VALUE (T1762).
 *
 * The tree courier reads every circle's inbox stream through getMemory every
 * 1.2 s. Each read re-serialized, re-hashed and secret-scanned the same
 * unchanged 32 KiB value on the application's main thread. These tests count
 * SHA-256 computations, which every full verification performs exactly once
 * and a remembered row performs none of, and they pin down that remembering a
 * verified row weakens nothing: any change to the stored bytes is verified in
 * full and a failure still throws. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createStateStore, StateStoreError } = require('../src/lib/state-store');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-memory-verified-once-'));
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

// About 31 KiB of ordinary report text per value, like a full inbox stream.
function streamValue(index, round = 0) {
  const records = [];
  for (let sequence = 1; sequence <= 33; sequence += 1) {
    records.push({
      sequence,
      text: `Circle ${index} report ${sequence} round ${round}: suite 36/36 passed, mutant 34/36 failed as expected, `
        + 'restored 36/36; see evidence/lane/report.md and src/lib/agent-comms/fabric.js line 1141. '.repeat(9)
    });
  }
  return { circle: index, records };
}

function expectCode(run, code) {
  assert.throws(run, error => {
    assert.ok(error instanceof StateStoreError, `expected StateStoreError, got ${error && error.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('unchanged rows are not re-verified on every read, and a change costs one verification', t => {
  const { store } = fixture(t);
  const keys = Array.from({ length: 45 }, (_, index) => `history/direct.circle-${index}`);
  keys.forEach((key, index) => {
    const saved = store.setMemory({ namespace: 'agent-comms', key, value: streamValue(index) });
    assert.ok(Buffer.byteLength(JSON.stringify(saved.entry.value)) > 28 * 1024, 'each stream is close to the 32 KiB cap');
  });

  const hashes = countHashes(t);
  for (const key of keys) store.getMemory({ namespace: 'agent-comms', key });
  const firstRound = hashes.sha256;
  assert.ok(firstRound <= keys.length, `first round verifies each row at most once (${firstRound})`);

  hashes.sha256 = 0;
  for (let round = 0; round < 10; round += 1) {
    keys.forEach((key, index) => {
      const entry = store.getMemory({ namespace: 'agent-comms', key });
      assert.equal(entry.value.circle, index);
    });
  }
  assert.equal(hashes.sha256, 0, `10 unchanged rounds over 45 streams re-verified ${hashes.sha256} times`);

  hashes.sha256 = 0;
  store.setMemory({ namespace: 'agent-comms', key: keys[7], value: streamValue(7, 1) });
  const afterWrite = keys.map(key => store.getMemory({ namespace: 'agent-comms', key }));
  assert.match(afterWrite[7].value.records[0].text, /round 1:/, 'the changed stream is read back');
  assert.match(afterWrite[8].value.records[0].text, /round 0:/, 'the unchanged streams are read back');
  // One hash to accept the write, one to verify the saved row, none for the 45 reads.
  assert.equal(hashes.sha256, 2, `a write plus the next round cost ${hashes.sha256} hashes`);
});

test('a stored row changed behind the store is verified again and still refused', t => {
  const { store, file } = fixture(t);
  store.setMemory({ namespace: 'agent-comms', key: 'history/direct.a', value: { text: 'first' } });
  store.setMemory({ namespace: 'agent-comms', key: 'history/direct.b', value: { text: 'second' } });
  store.setMemory({ namespace: 'agent-comms', key: 'history/direct.c', value: { text: 'third' } });
  for (const key of ['history/direct.a', 'history/direct.b', 'history/direct.c']) {
    store.getMemory({ namespace: 'agent-comms', key });
  }

  // Edited straight in the database file, beside the store's own connection.
  // The handle is closed before any assertion: Windows will not remove a
  // directory that still has the database open.
  const edited = '{"text":"forged"}';
  const secret = '{"password":"hunter2"}';
  const db = new DatabaseSync(file);
  try {
    const update = db.prepare('UPDATE memory_entries SET value_json = ?, value_hash = ? WHERE namespace = ? AND entry_key = ?');
    // Value bytes edited, hash left alone.
    const originalHash = db.prepare('SELECT value_hash FROM memory_entries WHERE entry_key = ?').get('history/direct.a').value_hash;
    update.run(edited, originalHash, 'agent-comms', 'history/direct.a');
    // A credential field with a correctly recomputed hash.
    update.run(secret, crypto.createHash('sha256').update(secret).digest('hex'), 'agent-comms', 'history/direct.b');
    // Non-canonical tags.
    db.prepare('UPDATE memory_entries SET tags_json = ? WHERE namespace = ? AND entry_key = ?').run('[ ]', 'agent-comms', 'history/direct.c');
  } finally { db.close(); }

  // The integrity check must fail, on every read.
  expectCode(() => store.getMemory({ namespace: 'agent-comms', key: 'history/direct.a' }), 'MEMORY_ENTRY_INVALID');
  expectCode(() => store.getMemory({ namespace: 'agent-comms', key: 'history/direct.a' }), 'MEMORY_ENTRY_INVALID');
  // The secret scan must still refuse the credential.
  expectCode(() => store.getMemory({ namespace: 'agent-comms', key: 'history/direct.b' }), 'MEMORY_SECRET_REJECTED');
  // Refused, not served from the earlier verification.
  expectCode(() => store.getMemory({ namespace: 'agent-comms', key: 'history/direct.c' }), 'MEMORY_ENTRY_INVALID');
});

test('each read hands back its own copy of the value', t => {
  const { store } = fixture(t);
  store.setMemory({ namespace: 'agent-comms', key: 'history/direct.a', value: { records: [{ text: 'kept' }] } });
  const first = store.getMemory({ namespace: 'agent-comms', key: 'history/direct.a' });
  first.value.records[0].text = 'changed by a caller';
  first.value.records.push({ text: 'added by a caller' });
  const second = store.getMemory({ namespace: 'agent-comms', key: 'history/direct.a' });
  assert.deepEqual(second.value, { records: [{ text: 'kept' }] });
});

test('the remembered rows are bounded: the oldest are forgotten and verified again', t => {
  const { store } = fixture(t);
  const total = 1100;
  for (let index = 0; index < total; index += 1) {
    store.setMemory({ namespace: 'agent.bound', key: `row-${index}`, value: { index } });
  }
  const hashes = countHashes(t);
  for (let index = 0; index < total; index += 1) store.getMemory({ namespace: 'agent.bound', key: `row-${index}` });

  hashes.sha256 = 0;
  for (let index = total - 1000; index < total; index += 1) store.getMemory({ namespace: 'agent.bound', key: `row-${index}` });
  assert.equal(hashes.sha256, 0, 'the most recent rows stay remembered');

  hashes.sha256 = 0;
  for (let index = 0; index < 50; index += 1) store.getMemory({ namespace: 'agent.bound', key: `row-${index}` });
  assert.equal(hashes.sha256, 50, 'rows beyond the bound are forgotten and verified in full again');
});

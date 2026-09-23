'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, binding, change, inspect } = require('./helpers/byte-authority-fixture');
const { createByteAuthority } = require('../src/lib/region-holds/byte-authority');

test('failed publication remains prepared and retry automatically records unapplied bytes before a new publication', async t => {
  const f = fixture(t), a = binding('actor-a');
  const failing = createByteAuthority({ stateRoot: f.root, materialize: f.materialize,
    publish: () => { throw new Error('injected before rename'); } });
  await failing.observeRead({ binding: a, resource: f.resource });
  await assert.rejects(change(failing, a, f.resource, 0, 1, 'A'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  assert.equal(inspect(failing, 'SELECT status FROM operations')[0].status, 'PREPARED');
  await change(f.authority, a, f.resource, 0, 1, 'A');
  const operations = inspect(f.authority, 'SELECT status,receipt_json FROM operations ORDER BY rowid');
  assert.equal(operations[0].status, 'ABORTED');
  assert.equal(operations[0].receipt_json, null);
  assert.equal(operations[1].status, 'COMMITTED');
  assert.equal(inspect(f.authority, "SELECT * FROM events WHERE kind='patch.recovered-unapplied'").length, 1);
  assert.equal((await f.authority.recoverPending()).recovered.length, 0);
});

test('publication followed by an outcome failure recovers byte identity and reader invalidation exactly once', async t => {
  const f = fixture(t), a = binding('actor-a'), b = binding('actor-b');
  const failing = createByteAuthority({ stateRoot: f.root, materialize: f.materialize,
    publish: input => { f.publish(input); throw new Error('injected after rename'); } });
  await failing.observeRead({ binding: a, resource: f.resource, startByte: 0, endByte: 1 });
  await failing.observeRead({ binding: b, resource: f.resource, startByte: 0, endByte: 1 });
  await assert.rejects(change(failing, a, f.resource, 0, 1, 'AAA'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'AAAbcdefghij');
  const recovery = await f.authority.recoverPending();
  assert.equal(recovery.recovered[0].outcome, 'recovered-materialized');
  assert.equal(recovery.recovered[0].receipt.recovered, true);
  assert.equal((await f.authority.recoverPending()).recovered.length, 0);
  await assert.rejects(change(f.authority, b, f.resource, 0, 1, 'Z'), { code: 'BYTE_READ_SET_STALE' });
});

test('unexpected recovered bytes remain quarantined while an unrelated scope and resource still work', async t => {
  const f = fixture(t), a = binding('actor-a'), b = binding('actor-b');
  const other = f.file('unrelated.txt', 'hello');
  const failing = createByteAuthority({ stateRoot: f.root, materialize: f.materialize,
    publish: () => { fs.writeFileSync(f.resource, 'unrecognized'); throw new Error('injected foreign mutation'); } });
  await failing.observeRead({ binding: a, resource: f.resource });
  await assert.rejects(change(failing, a, f.resource, 0, 1, 'A'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  await assert.rejects(f.authority.recoverPending(), { code: 'BYTE_RECOVERY_UNRESOLVED' });
  assert.equal(inspect(f.authority, 'SELECT status FROM operations')[0].status, 'UNKNOWN');
  await assert.rejects(f.authority.observeRead({ binding: b, resource: f.resource }), { code: 'BYTE_RECOVERY_UNRESOLVED' });
  await assert.rejects(f.authority.observeRead({ binding: a, resource: other }), { code: 'BYTE_RECOVERY_UNRESOLVED' });
  await f.authority.observeRead({ binding: b, resource: other });
  await change(f.authority, b, other, 0, 1, 'H');
  assert.equal(fs.readFileSync(other, 'utf8'), 'Hello');
  assert.equal((await f.authority.closeLaunch({ binding: a, reason: 'retired with unresolved journal' })).closed, true);
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'unrecognized');
});

test('a pending materialized edit to another read dependency is recovered before allowing a target patch', async t => {
  const f = fixture(t), a = binding('actor-a'), b = binding('actor-b');
  const target = f.file('target.txt', 'hello');
  await f.authority.observeRead({ binding: b, resource: f.resource });
  await f.authority.observeRead({ binding: b, resource: target });
  const failing = createByteAuthority({ stateRoot: f.root, materialize: f.materialize,
    publish: input => { f.publish(input); throw new Error('injected after rename'); } });
  await failing.observeRead({ binding: a, resource: f.resource });
  await assert.rejects(change(failing, a, f.resource, 0, 1, 'A'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  await assert.rejects(change(f.authority, b, target, 0, 1, 'H'), { code: 'BYTE_READ_SET_STALE' });
  const operation = inspect(f.authority, 'SELECT status,receipt_json FROM operations')[0];
  assert.equal(operation.status, 'COMMITTED');
  assert.equal(JSON.parse(operation.receipt_json).outcome, 'recovered-materialized');
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
  await f.authority.observeRead({ binding: b, resource: f.resource, startByte: 0, endByte: 1 });
  await change(f.authority, b, target, 0, 1, 'H');
  assert.equal(fs.readFileSync(target, 'utf8'), 'Hello');
});

test('missing recorded state refuses before materializing a file', async t => {
  const f = fixture(t), a = binding('actor-a');
  await f.authority.observeRead({ binding: a, resource: f.resource });
  const preserved = f.authority.dataFile + '.preserved';
  fs.renameSync(f.authority.dataFile, preserved);
  let reads = 0;
  const reopened = createByteAuthority({ stateRoot: f.root,
    materialize: file => { reads += 1; return f.materialize(file); }, publish: f.publish });
  await assert.rejects(reopened.observeRead({ binding: a, resource: f.resource }), { code: 'BYTE_STATE_MISSING' });
  assert.equal(reads, 0);
  fs.renameSync(preserved, f.authority.dataFile);
});

test('pending operation corruption is refused before recovery can change read projections', async t => {
  const f = fixture(t), a = binding('actor-a');
  const failing = createByteAuthority({ stateRoot: f.root, materialize: f.materialize,
    publish: () => { throw new Error('injected before rename'); } });
  await failing.observeRead({ binding: a, resource: f.resource });
  await assert.rejects(change(failing, a, f.resource, 0, 1, 'A'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(f.authority.dataFile);
  try {
    const row = db.prepare('SELECT * FROM operations').get();
    const damaged = JSON.parse(row.operation_json);
    damaged.startByte += 1;
    db.prepare('UPDATE operations SET operation_json=? WHERE id=?').run(JSON.stringify(damaged), row.id);
  } finally { db.close(); }
  await assert.rejects(f.authority.observeRead({ binding: a, resource: f.resource }), { code: 'BYTE_STATE_CORRUPT' });
  assert.equal(inspect(f.authority, 'SELECT status FROM operations')[0].status, 'PREPARED');
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'abcdefghij');
});

test('loss of a resource version is corruption, not permission to manufacture a new empty index', async t => {
  const f = fixture(t), a = binding('actor-a');
  await f.authority.observeRead({ binding: a, resource: f.resource });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(f.authority.dataFile);
  try { db.exec('DELETE FROM resources'); } finally { db.close(); }
  await assert.rejects(f.authority.observeRead({ binding: a, resource: f.resource }), { code: 'BYTE_STATE_CORRUPT' });
  assert.equal(inspect(f.authority, 'SELECT * FROM receipts').length, 1);
});

test('interrupted no-op recovery records an observation with no invented publication effect', async t => {
  const f = fixture(t), a = binding('actor-a');
  await f.authority.observeRead({ binding: a, resource: f.resource });
  let materializations = 0;
  const failing = createByteAuthority({ stateRoot: f.root, publish: f.publish,
    materialize: resource => {
      if (++materializations === 2) throw new Error('injected confirmation failure');
      return f.materialize(resource);
    } });
  await assert.rejects(change(failing, a, f.resource, 0, 1, 'a'));
  assert.equal(inspect(f.authority, 'SELECT status FROM operations')[0].status, 'PREPARED');
  await f.authority.observeRead({ binding: a, resource: f.resource });
  const operation = inspect(f.authority, 'SELECT status,receipt_json FROM operations')[0];
  assert.equal(operation.status, 'COMMITTED');
  assert.equal(JSON.parse(operation.receipt_json).outcome, 'recovered-no-op');
  assert.equal(f.publications(), 0);
});

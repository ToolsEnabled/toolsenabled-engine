'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { binding, fixture, change, inspect, hash } = require('./helpers/byte-authority-fixture');
const { createByteAuthority, MAX_RESOURCE_BYTES } = require('../src/lib/region-holds/byte-authority');

const write = (authority, actor, resource, bytes, extra = {}) => authority.applyWrite({
  binding: actor, resource, bytes: Buffer.from(bytes), ...extra
});

test('blind whole-file overwrite is exact publication intent, not a fabricated read receipt', async t => {
  const f = fixture(t), a = binding('blind-writer');
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0xa9, 13, 10, 0, 0xff]);
  const result = await write(f.authority, a, f.resource, bytes);
  assert.deepEqual(fs.readFileSync(f.resource), bytes);
  assert.equal(result.created, false);
  assert.equal(result.receipt.op, 'write');
  assert.equal(result.receipt.writeIntent, 'blind-whole-file');
  assert.equal(result.receipt.outcome, 'committed');
  assert.equal(result.receipt.beforePresent, true);
  assert.equal(result.receipt.fileSha256, hash(bytes));
  assert.equal(inspect(f.authority, 'SELECT * FROM reads').length, 0);
  assert.equal(inspect(f.authority, 'SELECT * FROM receipts').length, 0);
  const operation = JSON.parse(inspect(f.authority, 'SELECT operation_json FROM operations')[0].operation_json);
  assert.equal(operation.receiptRef, null);
  assert.equal(operation.publicationMode, 'replace-existing');
  await assert.rejects(change(f.authority, a, f.resource, 0, 1, 'A'), { code: 'BYTE_READ_REQUIRED' });
});

test('write intent Buffer is copied before asynchronous authority admission', async t => {
  const f = fixture(t), a = binding('blind-writer');
  const bytes = Buffer.from('original intent');
  const applied = f.authority.applyWrite({ binding: a, resource: f.resource, bytes });
  bytes.fill(0);
  await applied;
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'original intent');
});

for (const original of ['old target', null]) {
  test('a changed cross-file dependency prevents blind ' + (original === null ? 'creation' : 'overwrite'), async t => {
    const f = fixture(t, original), a = binding('writer'), b = binding('dependency-writer');
    const dependency = f.file('dependency.txt', 'left right');
    await f.authority.observeRead({ binding: a, resource: dependency, startByte: 0, endByte: 4 });
    await f.authority.observeRead({ binding: b, resource: dependency, startByte: 0, endByte: 4 });
    await change(f.authority, b, dependency, 0, 4, 'LEFT');
    await assert.rejects(write(f.authority, a, f.resource, 'replacement'), error => {
      assert.equal(error.code, 'BYTE_READ_SET_STALE');
      assert.equal(error.details.repairs[0].resource.toLowerCase(), dependency.toLowerCase());
      return true;
    });
    assert.equal(fs.existsSync(f.resource), original !== null);
    if (original !== null) assert.equal(fs.readFileSync(f.resource, 'utf8'), original);
    assert.equal(inspect(f.authority, 'SELECT operation_json FROM operations')
      .some(row => JSON.parse(row.operation_json).op === 'write'), false);
    await f.authority.observeRead({ binding: a, resource: dependency, startByte: 0, endByte: 2 });
    await assert.rejects(write(f.authority, a, f.resource, 'replacement'), { code: 'BYTE_READ_SET_STALE' });
    await f.authority.observeRead({ binding: a, resource: dependency, startByte: 2, endByte: 4 });
    await write(f.authority, a, f.resource, 'replacement');
    assert.equal(fs.readFileSync(f.resource, 'utf8'), 'replacement');
  });
}

test('whole overwrite invalidates writer and peer observations without expanding what either read', async t => {
  const f = fixture(t), a = binding('writer'), b = binding('peer');
  await f.authority.observeRead({ binding: a, resource: f.resource, startByte: 2, endByte: 4 });
  await f.authority.observeRead({ binding: b, resource: f.resource, startByte: 10, endByte: 10 });
  const previous = inspect(f.authority, 'SELECT receipt_json FROM receipts');
  await write(f.authority, a, f.resource, 'a much longer replacement');
  const reads = inspect(f.authority, 'SELECT * FROM reads ORDER BY scope_id');
  assert.equal(reads.length, 2);
  assert.ok(reads.every(row => row.stale_reason === 'WHOLE_FILE_WRITE'));
  assert.deepEqual(inspect(f.authority, 'SELECT receipt_json FROM receipts'), previous);
  assert.deepEqual(reads.map(row => [row.start_byte, row.end_byte, Buffer.from(row.observed).toString()]),
    [[10, 10, ''], [2, 4, 'cd']]);
  await assert.rejects(write(f.authority, a, f.resource, 'another'), { code: 'BYTE_READ_SET_STALE' });
  await f.authority.observeRead({ binding: a, resource: f.resource, startByte: 0, endByte: 1 });
  await assert.rejects(write(f.authority, a, f.resource, 'another'), { code: 'BYTE_READ_SET_STALE' });
  await f.authority.observeRead({ binding: a, resource: f.resource });
  await write(f.authority, a, f.resource, 'another');
});

test('empty-file creation has an absent base and a real effect; empty overwrite is a no-op', async t => {
  const f = fixture(t, null), a = binding('writer');
  await assert.rejects(f.authority.observeRead({ binding: a, resource: f.resource }), { code: 'BYTE_RESOURCE_ABSENT' });
  const created = await write(f.authority, a, f.resource, '');
  assert.equal(created.created, true);
  assert.equal(created.receipt.noOp, false);
  assert.equal(created.receipt.outcome, 'committed');
  assert.equal(created.receipt.beforePresent, false);
  assert.equal(created.receipt.beforeFileSha256, null);
  assert.equal(created.receipt.preHash, null);
  assert.equal(created.receipt.fileSha256, hash(Buffer.alloc(0)));
  assert.equal(inspect(f.authority, 'SELECT present FROM resources')[0].present, 1);
  assert.equal(inspect(f.authority, 'SELECT * FROM receipts').length, 0);
  assert.equal(inspect(f.authority, 'SELECT * FROM reads').length, 0);
  assert.equal(fs.statSync(f.resource).size, 0);
  assert.equal(fs.statSync(f.resource).nlink, 1);
  const noOp = await write(f.authority, a, f.resource, '');
  assert.equal(noOp.created, false);
  assert.equal(noOp.receipt.noOp, true);
  assert.equal(noOp.receipt.resourceVersion, created.receipt.resourceVersion);
  assert.equal(f.publications(), 1);
});

test('new filename case is preserved separately from the canonical Windows index key', async t => {
  const f = fixture(t), a = binding('writer');
  const resource = path.join(f.root, 'MixedCase-NewFile.txt');
  await write(f.authority, a, resource, 'new');
  assert.equal(fs.readdirSync(f.root).includes('MixedCase-NewFile.txt'), true);
  assert.equal(fs.statSync(resource).nlink, 1);
});

test('a valid long target basename does not make the operation-owned create stage exceed the leaf-name limit', async t => {
  const f = fixture(t), a = binding('writer');
  // 224-byte ASCII basename is below the common 255-byte leaf limit; adding
  // the full operation identifier to that basename would exceed the limit.
  const basename = 'n'.repeat(220) + '.txt';
  const resource = path.join(f.root, basename);
  await write(f.authority, a, resource, 'long-name creation');
  assert.equal(fs.readFileSync(resource, 'utf8'), 'long-name creation');
  const operation = JSON.parse(inspect(f.authority, 'SELECT operation_json FROM operations')[0].operation_json);
  assert.equal(path.basename(operation.createPreparation.stagingPath), '.te-' + operation.operationId + '.create.tmp');
  assert.equal(fs.existsSync(operation.createPreparation.stagingPath), false);
});

test('an unavailable previously read dependency cannot be repaired by inventing an absence receipt', async t => {
  const f = fixture(t), a = binding('writer');
  const dependency = f.file('dependency.txt', 'observed');
  await f.authority.observeRead({ binding: a, resource: dependency });
  fs.unlinkSync(dependency);
  await assert.rejects(write(f.authority, a, f.resource, 'new'), error => {
    assert.equal(error.code, 'BYTE_READ_SET_STALE');
    assert.equal(error.details.repairs[0].reason, 'DEPENDENCY_ABSENT');
    return true;
  });
  await assert.rejects(f.authority.observeRead({ binding: a, resource: dependency }), { code: 'BYTE_RESOURCE_ABSENT' });
  assert.equal(inspect(f.authority, 'SELECT * FROM receipts').length, 1);
  fs.writeFileSync(dependency, 'restored');
  await f.authority.observeRead({ binding: a, resource: dependency });
  await write(f.authority, a, f.resource, 'new');
});

test('an adapter error cannot be inferred as absent, and legacy adapters cannot silently create', async t => {
  const f = fixture(t, null), a = binding('writer');
  const unavailable = Object.assign(new Error('filesystem did not answer'), { code: 'EIO' });
  const broken = createByteAuthority({ stateRoot: f.root, materialize: () => { throw unavailable; }, publish: f.publish });
  await assert.rejects(write(broken, a, f.resource, 'new'), error => error === unavailable);
  const oldAdapter = createByteAuthority({ stateRoot: f.root, materialize: f.materialize, publish: f.publish });
  await assert.rejects(write(oldAdapter, a, f.resource, 'new'), { code: 'BYTE_CREATE_ADAPTER_REQUIRED' });
  assert.equal(inspect(f.authority, 'SELECT * FROM operations').length, 0);
  assert.equal(fs.existsSync(f.resource), false);
});

for (const original of ['old', null]) {
  test('synchronous last guard catches a revocation microtask before ' + (original === null ? 'creation' : 'overwrite'), async t => {
    const f = fixture(t, original), a = binding('writer');
    let live = true, checks = 0;
    await assert.rejects(write(f.authority, a, f.resource, 'new', {
      assertCurrent: () => {
        if (!live) throw Object.assign(new Error('revoked'), { code: 'FILE_TOOL_SCOPE_REVOKED' });
        if (++checks === (original === null ? 3 : 2)) queueMicrotask(() => { live = false; });
      }
    }), { code: 'FILE_TOOL_SCOPE_REVOKED' });
    assert.equal(f.publications(), 0);
    assert.equal(fs.existsSync(f.resource), original !== null);
    if (original !== null) assert.equal(fs.readFileSync(f.resource, 'utf8'), original);
    const operation = inspect(f.authority, 'SELECT status FROM operations')[0];
    assert.equal(operation.status, 'PREPARED');
  });
}

test('post-publication revocation reports the committed write and never claims it was unapplied', async t => {
  const f = fixture(t, null), a = binding('writer');
  let live = true;
  const authority = createByteAuthority({ stateRoot: f.root, materialize: f.materialize,
    prepareCreate: f.prepareCreate, reconcileCreateStage: f.reconcileCreateStage,
    publish: input => { const result = f.publish(input); live = false; return result; } });
  await assert.rejects(write(authority, a, f.resource, 'committed', {
    assertCurrent: () => { if (!live) throw Object.assign(new Error('revoked'), { code: 'FILE_TOOL_SCOPE_REVOKED' }); }
  }), error => {
    assert.equal(error.code, 'BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED');
    assert.equal(error.details.publicationCommitted, true);
    assert.equal(inspect(authority, 'SELECT status FROM operations')[0].status, 'COMMITTED');
    assert.equal('bytes' in error.details, false);
    return true;
  });
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'committed');
});

test('closed scopes and asynchronous final guards cannot authorize whole-file writes', async t => {
  const f = fixture(t), a = binding('retired'), b = binding('async-guard');
  await f.authority.closeLaunch({ binding: a, reason: 'transport retired' });
  await assert.rejects(write(f.authority, a, f.resource, 'new'), { code: 'BYTE_SCOPE_CLOSED' });
  await assert.rejects(write(f.authority, b, f.resource, 'new', { assertCurrent: async () => {} }), { code: 'BYTE_ADAPTER_INVALID' });
  assert.equal(f.publications(), 0);
});

test('whole writes enforce the bounded Buffer contract before state or filesystem publication', async t => {
  const f = fixture(t), a = binding('writer');
  for (const bytes of ['not a Buffer', null, Buffer.alloc(MAX_RESOURCE_BYTES + 1)]) {
    await assert.rejects(f.authority.applyWrite({ binding: a, resource: f.resource, bytes }), { code: 'BYTE_WRITE_INVALID' });
  }
  assert.equal(fs.existsSync(f.authority.dataFile), false);
  assert.equal(f.publications(), 0);
});

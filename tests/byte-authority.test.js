'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { binding, fixture, change, inspect, hash } = require('./helpers/byte-authority-fixture');
const { createByteAuthority } = require('../src/lib/region-holds/byte-authority');

test('read receipts describe exactly materialized bytes and disjoint edits survive rebasing', async t => {
  const f = fixture(t, Buffer.from('ééAA\r\nBB\r\n', 'utf8'));
  const a = binding('actor-a'), b = binding('actor-b');
  const first = await f.authority.observeRead({ binding: a, resource: f.resource, startByte: 4, endByte: 6 });
  const second = await f.authority.observeRead({ binding: b, resource: f.resource, startByte: 8, endByte: 10 });
  assert.equal(first.bytes.toString(), 'AA');
  assert.equal(first.receipt.contentSha256, hash(Buffer.from('AA')));
  assert.equal(second.bytes.toString(), 'BB');
  await change(f.authority, a, f.resource, 4, 6, 'AAAA');
  await change(f.authority, b, f.resource, 10, 12, 'ZZ');
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'ééAAAA\r\nZZ\r\n');
  assert.equal(f.publications(), 2);
});

test('overlapping readers share reads, then a changed dependency demands repair', async t => {
  const f = fixture(t), a = binding('actor-a'), b = binding('actor-b');
  await f.authority.observeRead({ binding: a, resource: f.resource, startByte: 2, endByte: 5 });
  await f.authority.observeRead({ binding: b, resource: f.resource, startByte: 2, endByte: 5 });
  await change(f.authority, a, f.resource, 3, 4, 'X');
  await assert.rejects(change(f.authority, b, f.resource, 2, 3, 'Y'), error => {
    assert.equal(error.code, 'BYTE_READ_SET_STALE');
    assert.equal(error.details.repairs[0].reason, 'MEDIATED_WRITE');
    assert.equal('currentBytes' in error.details.repairs[0], false);
    return true;
  });
  assert.equal(f.publications(), 1);
  await f.authority.observeRead({ binding: b, resource: f.resource, startByte: 3, endByte: 4 });
  await change(f.authority, b, f.resource, 2, 3, 'Y');
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'abYXefghij');
});

test('a dependency on another file blocks the patch until its actual changed region is reread', async t => {
  const f = fixture(t), other = f.file('dependency.txt', 'left right');
  const a = binding('actor-a'), b = binding('actor-b');
  await f.authority.observeRead({ binding: a, resource: f.resource });
  await f.authority.observeRead({ binding: a, resource: other, startByte: 0, endByte: 4 });
  await f.authority.observeRead({ binding: b, resource: other, startByte: 0, endByte: 4 });
  await change(f.authority, b, other, 0, 4, 'LEFT');
  await assert.rejects(change(f.authority, a, f.resource, 0, 1, 'A'), error => {
    assert.equal(error.code, 'BYTE_READ_SET_STALE');
    assert.equal(error.details.repairs[0].resource.toLowerCase(), other.toLowerCase());
    return true;
  });
  await f.authority.observeRead({ binding: a, resource: other, startByte: 0, endByte: 2 });
  await assert.rejects(change(f.authority, a, f.resource, 0, 1, 'A'), { code: 'BYTE_READ_SET_STALE' });
  await f.authority.observeRead({ binding: a, resource: other, startByte: 2, endByte: 4 });
  await change(f.authority, a, f.resource, 0, 1, 'A');
});

test('a receipt from another scope cannot establish authority and missing reads do not become empty evidence', async t => {
  const f = fixture(t), a = binding('actor-a'), b = binding('actor-b');
  const observed = await f.authority.observeRead({ binding: a, resource: f.resource });
  await assert.rejects(change(f.authority, b, f.resource, 0, 1, 'X', { receiptRef: observed.receipt.receiptRef }), { code: 'BYTE_READ_REQUIRED' });
  await assert.rejects(change(f.authority, b, f.resource, 0, 1, 'X'), { code: 'BYTE_READ_REQUIRED' });
  assert.equal(f.publications(), 0);
});

test('text validation and scope revocation happen before release and cannot manufacture usable reads', async t => {
  const f = fixture(t), a = binding('actor-a');
  const invalid = Object.assign(new Error('invalid UTF8 window'), { code: 'REPO_UTF8_INVALID' });
  await assert.rejects(f.authority.observeRead({ binding: a, resource: f.resource, validateRead: () => { throw invalid; } }), error => error === invalid);
  assert.equal(inspect(f.authority, 'SELECT * FROM receipts').length, 0);
  let live = true;
  await f.authority.observeRead({ binding: a, resource: f.resource });
  await assert.rejects(f.authority.applyPatch({ binding: a, resource: f.resource,
    assertCurrent: () => { if (!live) throw Object.assign(new Error('revoked'), { code: 'FILE_TOOL_SCOPE_REVOKED' }); },
    derivePatch: () => { live = false; return { startByte: 0, endByte: 1, replacement: Buffer.from('A') }; }
  }), { code: 'FILE_TOOL_SCOPE_REVOKED' });
  assert.equal(f.publications(), 0);
});

test('scope closure is durable and a second authority cannot reopen it', async t => {
  const f = fixture(t), a = binding('actor-a');
  await f.authority.observeRead({ binding: a, resource: f.resource });
  assert.equal((await f.authority.closeLaunch({ binding: a, reason: 'session retired' })).closed, true);
  const reopened = createByteAuthority({ stateRoot: f.root, materialize: f.materialize, publish: f.publish });
  await assert.rejects(reopened.observeRead({ binding: a, resource: f.resource }), { code: 'BYTE_SCOPE_CLOSED' });
  await assert.rejects(reopened.observeRead({ binding: { ...a, principal: 'different' }, resource: f.resource }), { code: 'BYTE_SCOPE_MISMATCH' });
});

test('microtask revocation after an async admission check is caught before synchronous publication', async t => {
  const f = fixture(t), a = binding('actor-a');
  await f.authority.observeRead({ binding: a, resource: f.resource });
  let live = true, checks = 0;
  await assert.rejects(change(f.authority, a, f.resource, 0, 1, 'A', {
    assertCurrent: () => {
      if (!live) throw Object.assign(new Error('revoked'), { code: 'FILE_TOOL_SCOPE_REVOKED' });
      if (++checks === 2) queueMicrotask(() => { live = false; });
    }
  }), { code: 'FILE_TOOL_SCOPE_REVOKED' });
  assert.equal(f.publications(), 0);
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'abcdefghij');
});

test('an async publisher receives a synchronous final guard and cannot publish after revocation', async t => {
  const f = fixture(t), a = binding('actor-a');
  let live = true;
  const authority = createByteAuthority({ stateRoot: f.root, materialize: f.materialize,
    publish: async input => {
      await Promise.resolve();
      live = false;
      input.assertCurrent();
      return f.publish(input);
    } });
  await authority.observeRead({ binding: a, resource: f.resource });
  await assert.rejects(change(authority, a, f.resource, 0, 1, 'A', {
    assertCurrent: () => { if (!live) throw Object.assign(new Error('revoked'), { code: 'FILE_TOOL_SCOPE_REVOKED' }); }
  }), { code: 'FILE_TOOL_SCOPE_REVOKED' });
  assert.equal(f.publications(), 0);
});

test('revocation after publication records its committed effect without releasing content or claiming no write', async t => {
  const f = fixture(t), a = binding('actor-a');
  let live = true;
  const authority = createByteAuthority({ stateRoot: f.root, materialize: f.materialize,
    publish: input => { input.assertCurrent(); const result = f.publish(input); live = false; return result; } });
  await authority.observeRead({ binding: a, resource: f.resource });
  await assert.rejects(change(authority, a, f.resource, 0, 1, 'A', {
    assertCurrent: () => { if (!live) throw Object.assign(new Error('revoked'), { code: 'FILE_TOOL_SCOPE_REVOKED' }); }
  }), error => {
    assert.equal(error.code, 'BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED');
    assert.equal(error.details.publicationCommitted, true);
    assert.equal(error.details.causeCode, 'FILE_TOOL_SCOPE_REVOKED');
    const operation = inspect(authority, 'SELECT * FROM operations')[0];
    assert.equal(operation.id, error.details.operationId);
    assert.equal(operation.status, 'COMMITTED');
    assert.equal('bytes' in error.details, false);
    return true;
  });
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'Abcdefghij');
});

test('promise-returning final scope guards are refused before read receipt persistence', async t => {
  const f = fixture(t), a = binding('actor-a');
  await assert.rejects(f.authority.observeRead({ binding: a, resource: f.resource,
    assertCurrent: async () => {} }), { code: 'BYTE_ADAPTER_INVALID' });
  assert.equal(inspect(f.authority, 'SELECT * FROM receipts').length, 0);
});

test('unmediated changes invalidate coordinates and cannot be acknowledged by an unrelated partial reread', async t => {
  const f = fixture(t), a = binding('actor-a');
  await f.authority.observeRead({ binding: a, resource: f.resource, startByte: 4, endByte: 6 });
  fs.writeFileSync(f.resource, 'XXabcdefghij');
  await f.authority.observeRead({ binding: a, resource: f.resource, startByte: 0, endByte: 2 });
  await assert.rejects(change(f.authority, a, f.resource, 0, 1, 'Y'), { code: 'BYTE_READ_SET_STALE' });
  await f.authority.observeRead({ binding: a, resource: f.resource });
  await change(f.authority, a, f.resource, 0, 1, 'Y');
});

test('no-op patch neither publishes nor invalidates another reader', async t => {
  const f = fixture(t), a = binding('actor-a'), b = binding('actor-b');
  await f.authority.observeRead({ binding: a, resource: f.resource });
  await f.authority.observeRead({ binding: b, resource: f.resource });
  const result = await change(f.authority, a, f.resource, 0, 1, 'a');
  assert.equal(result.receipt.outcome, 'no-op');
  assert.equal(f.publications(), 0);
  await change(f.authority, b, f.resource, 1, 2, 'B');
});

test('an expired dependency must be reread and stored observations survive a fresh connection', async t => {
  let clock = 1000;
  const f = fixture(t, 'abcdefghij', { now: () => clock }), a = binding('actor-a');
  await f.authority.observeRead({ binding: a, resource: f.resource });
  clock += 60 * 60 * 1000;
  const reopened = createByteAuthority({ stateRoot: f.root, materialize: f.materialize, publish: f.publish, now: () => clock });
  await assert.rejects(change(reopened, a, f.resource, 0, 1, 'A'), { code: 'BYTE_READ_SET_STALE' });
  await reopened.observeRead({ binding: a, resource: f.resource });
  await change(reopened, a, f.resource, 0, 1, 'A');
});

test('boundary insertion preserves the left reader and requires repair by the right reader', async t => {
  const f = fixture(t, 'AA BB'), a = binding('writer'), left = binding('left'), right = binding('right');
  await f.authority.observeRead({ binding: a, resource: f.resource, startByte: 0, endByte: 3 });
  await f.authority.observeRead({ binding: left, resource: f.resource, startByte: 0, endByte: 3 });
  await f.authority.observeRead({ binding: right, resource: f.resource, startByte: 3, endByte: 5 });
  await change(f.authority, a, f.resource, 3, 3, 'XX');
  await change(f.authority, a, f.resource, 3, 5, 'YY');
  await change(f.authority, left, f.resource, 0, 1, 'a');
  await assert.rejects(change(f.authority, right, f.resource, 5, 6, 'Z'), { code: 'BYTE_READ_SET_STALE' });
  await f.authority.observeRead({ binding: right, resource: f.resource, startByte: 3, endByte: 5 });
  await change(f.authority, right, f.resource, 5, 6, 'Z');
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'aA YYZB');
});

test('a real empty-file observation admits insertion and EOF append without inventing a new receipt', async t => {
  const f = fixture(t, ''), a = binding('actor-a');
  await f.authority.observeRead({ binding: a, resource: f.resource });
  await change(f.authority, a, f.resource, 0, 0, 'abc');
  await change(f.authority, a, f.resource, 3, 3, 'def');
  await change(f.authority, a, f.resource, 4, 5, 'E');
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'abcdEf');
});

test('deleting observed bytes leaves a point repair and shifts an adjacent disjoint reader safely', async t => {
  const f = fixture(t, 'AA BB'), a = binding('writer'), stale = binding('stale'), right = binding('right');
  await f.authority.observeRead({ binding: a, resource: f.resource, startByte: 0, endByte: 2 });
  await f.authority.observeRead({ binding: stale, resource: f.resource, startByte: 0, endByte: 2 });
  await f.authority.observeRead({ binding: right, resource: f.resource, startByte: 2, endByte: 5 });
  await change(f.authority, a, f.resource, 0, 2, '');
  await change(f.authority, right, f.resource, 1, 3, 'ZZ');
  await assert.rejects(change(f.authority, stale, f.resource, 0, 0, 'A'), { code: 'BYTE_READ_SET_STALE' });
  await f.authority.observeRead({ binding: stale, resource: f.resource, startByte: 0, endByte: 0 });
  await change(f.authority, stale, f.resource, 0, 0, 'A');
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'A ZZ');
});

test('lockfile policy invalidates the whole observation and requires a whole-file repair', async t => {
  const f = fixture(t), resource = f.file('package-lock.json', '0123456789');
  const a = binding('actor-a'), b = binding('actor-b');
  await f.authority.observeRead({ binding: a, resource, startByte: 0, endByte: 1 });
  await f.authority.observeRead({ binding: b, resource, startByte: 9, endByte: 10 });
  await change(f.authority, a, resource, 0, 1, 'A');
  await assert.rejects(change(f.authority, b, resource, 9, 10, 'Z'), error => {
    assert.equal(error.code, 'BYTE_READ_SET_STALE');
    assert.equal(error.details.repairs[0].requiresWholeFileRead, true);
    return true;
  });
  await f.authority.observeRead({ binding: b, resource, startByte: 9, endByte: 10 });
  await assert.rejects(change(f.authority, b, resource, 9, 10, 'Z'), { code: 'BYTE_READ_SET_STALE' });
  await f.authority.observeRead({ binding: b, resource });
  await change(f.authority, b, resource, 9, 10, 'Z');
});

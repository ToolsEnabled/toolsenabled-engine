'use strict';

// AN EXPOSURE IS PROVENANCE, NOT A READ.
//
// search.query returns snippets and code.* returns source previews: file bytes
// are shown to an agent without it ever asking to read that file. Those are
// GLANCES. Recording them is worth doing -- it is the only record that this
// content was put in front of the agent -- but they must not behave like a
// deliberate read.
//
// THE DISTINCTION IS NOT COSMETIC. observeRead does two separate things: it
// writes a row to `receipts`, and it writes rows to `reads`. The second is the
// binding: _validateReadSet refuses a write whose scope holds a stale `reads`
// row, and _selectReceipt will only patch from a receipt that HAS `reads` rows
// covering the patched window. So an exposure that wrote a receipt and no read
// rows is, by the authority's existing construction, unable to gate a write and
// unable to be patched from. This suite pins both of those, because both are
// ways a future change could quietly turn a glance into an entitlement.
//
// What it must NOT do is the interesting half: a search must never make a later
// write refuse, and must never let an agent patch from a snippet it never read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { binding, fixture, change, hash } = require('./helpers/byte-authority-fixture');

test('an exposure records what was shown, with its own kind and the exact bytes', async t => {
  const f = fixture(t, Buffer.from('abcdefghij', 'utf8'));
  const a = binding('actor-a');
  const shown = await f.authority.recordExposure({
    binding: a, resource: f.resource, startByte: 2, endByte: 5, tool: 'search.query'
  });
  assert.equal(shown.bytes.toString(), 'cde', 'the receipt must describe the bytes actually shown');
  assert.equal(shown.receipt.contentSha256, hash(Buffer.from('cde')));
  assert.equal(shown.receipt.op, 'expose',
    'an exposure recorded as a read would claim the agent asked for this file when it did not');
  assert.equal(shown.receipt.tool, 'search.query', 'the record must say which tool showed it');
});

test('an exposure does not gate a later write on the same file', async t => {
  // THE WHOLE POINT. A snippet a search happened to show must not make an
  // ordinary write refuse, and must not need repairing when the file moves.
  const f = fixture(t, Buffer.from('abcdefghij', 'utf8'));
  const a = binding('actor-a'), b = binding('actor-b');
  await f.authority.recordExposure({ binding: a, resource: f.resource, startByte: 2, endByte: 5, tool: 'search.query' });

  // Somebody else changes exactly the exposed bytes.
  await f.authority.observeRead({ binding: b, resource: f.resource, startByte: 2, endByte: 5 });
  await change(f.authority, b, f.resource, 2, 5, 'ZZZ');

  // The exposed scope still writes, with no repair demanded of it.
  await f.authority.observeRead({ binding: a, resource: f.resource, startByte: 0, endByte: 1 });
  await change(f.authority, a, f.resource, 0, 1, 'A');
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'AbZZZfghij',
    'THE DEFECT: a glance became a dependency and blocked an unrelated write');
});

test('an exposure cannot be patched from, so a snippet is never an entitlement to edit', async t => {
  const f = fixture(t, Buffer.from('abcdefghij', 'utf8'));
  const a = binding('actor-a');
  const shown = await f.authority.recordExposure({
    binding: a, resource: f.resource, startByte: 2, endByte: 5, tool: 'code.hover'
  });
  await assert.rejects(f.authority.applyPatch({
    binding: a, resource: f.resource, receiptRef: shown.receipt.receiptRef,
    derivePatch: () => ({ startByte: 2, endByte: 5, replacement: Buffer.from('XYZ') })
  }), error => {
    assert.equal(error.code, 'BYTE_READ_REQUIRED',
      'an agent patched from bytes it was merely shown, without ever reading them');
    return true;
  });
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'abcdefghij', 'the file must be untouched');
});

test('an exposure of an absent file refuses rather than recording a glance at nothing', async t => {
  const f = fixture(t);
  await assert.rejects(f.authority.recordExposure({
    binding: binding('actor-a'), resource: f.file('gone.txt', 'x') + '.missing', tool: 'search.query'
  }), error => {
    assert.equal(error.code, 'BYTE_RESOURCE_ABSENT');
    return true;
  });
});

test('an exposure is refused without a tool name, because a record of who showed it is the point', async t => {
  const f = fixture(t, Buffer.from('abcdefghij', 'utf8'));
  for (const tool of [undefined, '', 42, 'a'.repeat(200)]) {
    await assert.rejects(f.authority.recordExposure({ binding: binding('actor-a'), resource: f.resource, tool }),
      error => {
        assert.equal(error.code, 'BYTE_EXPOSURE_TOOL_INVALID');
        return true;
      });
  }
});

test('a whole-file exposure is still only a record, and still gates nothing', async t => {
  const f = fixture(t, Buffer.from('abcdefghij', 'utf8'));
  const a = binding('actor-a'), b = binding('actor-b');
  const shown = await f.authority.recordExposure({ binding: a, resource: f.resource, tool: 'search.query' });
  assert.equal(shown.bytes.toString(), 'abcdefghij');
  await f.authority.observeRead({ binding: b, resource: f.resource, startByte: 0, endByte: 2 });
  await change(f.authority, b, f.resource, 0, 2, 'ZZ');
  await f.authority.observeRead({ binding: a, resource: f.resource, startByte: 9, endByte: 10 });
  await change(f.authority, a, f.resource, 9, 10, 'Q');
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'ZZcdefghiQ',
    'a whole-file glance blocked a later write, which is the same defect at a larger size');
});

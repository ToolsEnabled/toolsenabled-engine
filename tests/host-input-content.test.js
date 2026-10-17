'use strict';
const { useSandboxHome, sandboxCaller } = require('./lib/openshell-sandbox-home');
const HOME = useSandboxHome('host-input-content');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const work = name => path.join(HOME, 'work', name);
// A real one-pixel PNG; no image library or production file is required.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

test('real PNG is explicitly refused as image/png rather than decoded as text, including an interior window', async t => {
  const { refusal } = sandboxCaller(t);
  fs.writeFileSync(work('pixel.png'), PNG);
  for (const window of [{}, { startByte: 33, endByte: 40 }]) {
    const r = await refusal('host.read_file', { path: work('pixel.png'), ...window });
    assert.equal(r.code, 'HOST_FILE_BINARY_UNSUPPORTED');
    assert.match(r.text, /image\/png/);
    assert.match(r.text, /image.*input|image.*reader/i);
    assert.doesNotMatch(r.text, /\uFFFD/);
  }
});

test('MIME detection follows bytes rather than a text suffix; declared PNG cannot disguise another MIME', async t => {
  const { refusal } = sandboxCaller(t);
  fs.writeFileSync(work('pixel.txt'), PNG);
  assert.equal((await refusal('host.read_file', { path: work('pixel.txt') })).code, 'HOST_FILE_BINARY_UNSUPPORTED');
  fs.writeFileSync(work('wrong.png'), '%PDF-1.7\nfixture');
  const r = await refusal('host.read_file', { path: work('wrong.png') });
  assert.equal(r.code, 'HOST_FILE_MIME_MISMATCH');
  assert.match(r.text, /image\/png.*application\/pdf/);
});

test('valid UTF8 and empty text stay readable under misleading binary suffixes', async t => {
  const { call, refusal } = sandboxCaller(t);
  for (const suffix of ['png', 'pdf', 'gz']) {
    for (const content of ['ordinary text 日本語 😀', '']) {
      const target = work(`text.${suffix}`);
      fs.writeFileSync(target, content);
      assert.equal((await call('host.read_file', { path: target })).content, content);
    }
    const target = work(`invalid.${suffix}`);
    fs.writeFileSync(target, Buffer.from([0x63, 0xe9]));
    assert.equal((await refusal('host.read_file', { path: target })).code, 'HOST_FILE_TEXT_ENCODING_UNSUPPORTED');
  }
});

test('malformed PNG, non-UTF8 text and UTF8-looking binary refuse without replacement characters', async t => {
  const { refusal } = sandboxCaller(t);
  for (const [name, bytes, code] of [
    ['broken.png', PNG.subarray(0, 12), 'HOST_FILE_MALFORMED_IMAGE'],
    ['latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'HOST_FILE_TEXT_ENCODING_UNSUPPORTED'],
    ['zero.dat', Buffer.from('a\0b'), 'HOST_FILE_BINARY_UNSUPPORTED'],
    ['late.dat', Buffer.concat([Buffer.alloc(40000, 0x61), Buffer.from([0])]), 'HOST_FILE_BINARY_UNSUPPORTED'],
  ]) {
    fs.writeFileSync(work(name), bytes);
    const r = await refusal('host.read_file', { path: work(name), ...(name === 'late.dat' ? { endByte: 10 } : {}) });
    assert.equal(r.code, code, name);
    assert.doesNotMatch(r.text, /\uFFFD/);
  }
});

test('other binary MIME families and oversize inputs retain named bounded refusals', async t => {
  const { refusal } = sandboxCaller(t);
  for (const [name, bytes, mime] of [
    ['photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]), 'image/jpeg'],
    ['image.gif', Buffer.from('GIF89a\0\0'), 'image/gif'],
    ['report.pdf', Buffer.from('%PDF-1.7\n'), 'application/pdf'],
    ['bundle.zip', Buffer.from([0x50, 0x4b, 3, 4, 0]), 'application/zip'],
  ]) {
    fs.writeFileSync(work(name), bytes);
    const r = await refusal('host.read_file', { path: work(name) });
    assert.equal(r.code, 'HOST_FILE_BINARY_UNSUPPORTED');
    assert.ok(r.text.includes(mime));
  }
  fs.writeFileSync(work('too-big.png'), Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.equal((await refusal('host.read_file', { path: work('too-big.png') })).code, 'HOST_FILE_TOO_LARGE');
});

test('ordinary UTF8 text, empty text and character-aligned windows preserve exact content and receipts', async t => {
  const { call, refusal } = sandboxCaller(t);
  fs.writeFileSync(work('text.md'), 'déjà vu\n日本語\n');
  assert.equal((await call('host.read_file', { path: work('text.md') })).content, 'déjà vu\n日本語\n');
  const window = await call('host.read_file', { path: work('text.md'), startByte: 0, endByte: 3 });
  assert.equal(window.content, 'dé');
  assert.equal(window.receipt.endByte, 3);
  assert.equal((await refusal('host.read_file', { path: work('text.md'), startByte: 2, endByte: 4 })).code, 'HOST_FILE_UTF8_BOUNDARY_INVALID');
  fs.writeFileSync(work('empty.txt'), '');
  assert.equal((await call('host.read_file', { path: work('empty.txt') })).content, '');
  const bom = '\uFEFFplain text 😀';
  fs.writeFileSync(work('bom.txt'), bom);
  assert.equal((await call('host.read_file', { path: work('bom.txt') })).content, bom);
});

test('a refused binary read supplies no observation that permits replacing its bytes', async t => {
  const { refusal } = sandboxCaller(t);
  fs.writeFileSync(work('unobserved.png'), PNG);
  assert.equal((await refusal('host.read_file', { path: work('unobserved.png') })).code, 'HOST_FILE_BINARY_UNSUPPORTED');
  assert.equal((await refusal('host.write_file', { path: work('unobserved.png'), content: 'clobbered' })).code, 'HOST_FILE_READ_REQUIRED');
  assert.deepEqual(fs.readFileSync(work('unobserved.png')), PNG);
});

test('unmediated legacy reads use the same content contract and recheck the size after admission', async () => {
  const host = require('../src/lib/providers/host-control');
  const admitted = { requireRecordAsync: async () => {} };
  fs.writeFileSync(work('legacy.png'), PNG);
  await assert.rejects(host.readFile({ path: work('legacy.png') }, admitted), { code: 'HOST_FILE_BINARY_UNSUPPORTED' });
  fs.writeFileSync(work('legacy.txt'), 'déjà vu\n');
  assert.equal((await host.readFile({ path: work('legacy.txt') }, admitted)).content, 'déjà vu\n');
  await assert.rejects(host.readFile({ path: work('legacy.txt') }, {
    requireRecordAsync: async () => fs.writeFileSync(work('legacy.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
  }), { code: 'HOST_FILE_TOO_LARGE' });
});

test('workspace and link boundaries apply before any MIME result', async t => {
  const { refusal } = sandboxCaller(t);
  fs.symlinkSync(work('pixel.png'), work('linked.png'));
  assert.equal((await refusal('host.read_file', { path: work('linked.png') })).code, 'HOST_PATH_FORBIDDEN');
  assert.match((await refusal('host.read_file', { path: path.join(HOME, '..', 'outside.png') })).code, /^HOST_PATH_/);
});

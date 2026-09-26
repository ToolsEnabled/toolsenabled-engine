'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { download } = require('../src/lib/video-artifacts');

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
const URL = 'https://v3.fal.media/files/fixture.mp4';

function fixture(t, chunks = [MP4]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-artifacts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  return { directory, calls, options: {
    directory, resolveTarget: async url => { assert.equal(url, URL); return { fixture: true }; },
    requestPinned: async (target, options) => {
      calls.push({ target, options });
      return { status: 200, headers: { 'content-type': 'video/mp4' }, stream: Readable.from(chunks) };
    }
  } };
}

test('a completed MP4 has verified bytes and hash and repeated downloads never overwrite', async t => {
  const f = fixture(t, [MP4.subarray(0, 3), MP4.subarray(3, 8), MP4.subarray(8)]);
  const first = await download(URL, f.options);
  const second = await download(URL, f.options);
  assert.equal(first.bytes, MP4.length);
  assert.equal(first.sha256, crypto.createHash('sha256').update(MP4).digest('hex'));
  assert.deepEqual(fs.readFileSync(first.path), MP4);
  assert.notEqual(first.path, second.path);
  assert.equal(path.dirname(first.path), f.directory);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.part')), false);
  assert.deepEqual(Object.keys(f.calls[0].options.headers), ['accept'], 'media hosts must never receive a provider credential');
});

test('unbounded or mislabeled downloads leave no completed or partial files', async t => {
  for (const [chunks, maxBytes, code] of [
    [[MP4, Buffer.alloc(100)], 64, 'VIDEO_DOWNLOAD_TOO_LARGE'],
    [[Buffer.from('<html>expired download</html>')], 1000, 'VIDEO_DOWNLOAD_INVALID'],
    [[], 1000, 'VIDEO_DOWNLOAD_INVALID']
  ]) {
    const f = fixture(t, chunks);
    await assert.rejects(download(URL, { ...f.options, maxBytes }), error => error.code === code);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  }
});

test('redirects and oversized Content-Length are refused before writing', async t => {
  for (const [status, headers, code] of [[302, { location: 'https://elsewhere.example/redirect' }, 'VIDEO_DOWNLOAD_FAILED'],
    [200, { 'content-length': '1000000' }, 'VIDEO_DOWNLOAD_TOO_LARGE']]) {
    const f = fixture(t);
    let calls = 0;
    let stream;
    await assert.rejects(download(URL, { ...f.options, maxBytes: 64,
      requestPinned: async () => { calls += 1; stream = Readable.from([MP4]); return { status, headers, stream }; }
    }), error => error.code === code);
    assert.equal(calls, 1);
    assert.equal(stream.destroyed, true);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  }
});

test('an interrupted stream is cleaned up and preserves the caller cancellation reason', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = new Error('fixture caller cancellation');
  await assert.rejects(download(URL, { ...f.options, signal: controller.signal,
    requestPinned: async () => ({ status: 200, headers: {}, stream: Readable.from((async function* () {
      yield MP4;
      controller.abort(reason);
      yield MP4;
    })()) })
  }), error => error === reason);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('the total deadline includes a stalled body and stalled DNS lookup', async t => {
  for (const phase of ['body', 'dns']) {
    const f = fixture(t);
    let stream;
    const overrides = phase === 'dns' ? { resolveTarget: () => new Promise(() => {}) } : {
      requestPinned: async () => { stream = new Readable({ read() {} }); return { status: 200, headers: {}, stream }; }
    };
    await assert.rejects(download(URL, { ...f.options, ...overrides, timeoutMs: 30 }), error => error.code === 'VIDEO_DOWNLOAD_TIMEOUT');
    if (stream) assert.equal(stream.destroyed, true);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  }
});

test('the real resolver refuses private-address downloads without opening a socket', async t => {
  const f = fixture(t);
  let called = false;
  await assert.rejects(download('https://127.0.0.1/secret', { directory: f.directory,
    requestPinned: async () => { called = true; throw new Error('must not connect'); }
  }), error => error.code === 'VIDEO_DOWNLOAD_FAILED');
  assert.equal(called, false);
});

test('artifact paths cannot follow directory links', async t => {
  const f = fixture(t);
  const target = path.join(f.directory, 'target');
  const linked = path.join(f.directory, 'linked');
  fs.mkdirSync(target);
  fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(download(URL, { ...f.options, directory: linked }), error => error.code === 'VIDEO_ARTIFACT_PATH_UNSAFE');
  assert.deepEqual(fs.readdirSync(target), []);
});

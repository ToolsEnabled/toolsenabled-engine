'use strict';

const assert = require('node:assert/strict');
const { request } = require('../src/lib/http');

const SECRET = 'transport-only-secret-that-must-not-be-forwarded';

(async () => {
  const originalFetch = global.fetch;
  try {
    for (const status of [301, 302, 303, 307, 308]) {
      const calls = [];
      global.fetch = async (url, options) => {
        calls.push({ url, options });
        return new Response(`provider echo ${SECRET}`, {
          status,
          headers: { location: `https://redirect.example.test/echo/${SECRET}` }
        });
      };
      await assert.rejects(
        request('https://api.example.test/v2/apps', {
          method: 'POST', retries: 0, redirect: 'manual',
          headers: { authorization: `Bearer ${SECRET}` }, body: '{}'
        }),
        error => error.code === 'HTTP_REDIRECT_REFUSED' && !error.message.includes(SECRET)
      );
      assert.equal(calls.length, 1, `${status} must not trigger a second request.`);
      assert.equal(calls[0].options.redirect, 'manual');
      assert.equal(calls[0].url, 'https://api.example.test/v2/apps');
    }

    let defaultRedirect;
    global.fetch = async (_url, options) => {
      defaultRedirect = options.redirect;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await request('https://example.test/unchanged-default', { retries: 0 });
    assert.equal(defaultRedirect, 'follow', 'The additive option must not weaken the existing default.');

    global.fetch = async () => new Response('{"state":', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
    await assert.rejects(
      request('https://example.test/malformed-json', { retries: 0 }),
      error => error.code === 'HTTP_INVALID_JSON' && error.status === 200,
      'declared JSON that could not be established must differ from a definite text response'
    );
    global.fetch = async () => new Response('{"state":', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
    const definiteText = await request('https://example.test/definite-text', { retries: 0 });
    assert.equal(definiteText.body, '{"state":');

    const rawText = ' {"score":1e999,"name":"€"}\n';
    global.fetch = async () => new Response(rawText, { headers: { 'content-type': 'application/json' } });
    const raw = await request('https://example.test/raw', { retries: 0, responseMode: 'text', maxResponseBytes: 1024 });
    assert.equal(raw.body, rawText, 'raw mode must not parse/re-serialize a result before its collector can validate it');
    assert.equal(raw.bodyBytes, Buffer.byteLength(rawText));
    assert.equal(raw.truncated, false);
    global.fetch = async () => new Response('{"score":', { headers: { 'content-type': 'application/json' } });
    assert.equal((await request('https://example.test/raw-malformed', { retries: 0, responseMode: 'text', maxResponseBytes: 1024 })).body, '{"score":',
      'raw mode preserves malformed data for the collector to refuse, while the default JSON guard above remains unchanged');

    let cancelled = false;
    global.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('€€')); },
      cancel() { cancelled = true; }
    }));
    const overflow = await request('https://example.test/oversize', { retries: 0, responseMode: 'text', maxResponseBytes: 5 });
    assert.equal(overflow.truncated, true);
    assert.equal(overflow.bodyBytes, 6, 'UTF-8 bytes, not characters, govern the bound');
    assert.equal(cancelled, true, 'the remaining stream is cancelled instead of read into unbounded memory');
    global.fetch = async () => new Response('€€');
    const exact = await request('https://example.test/exact-limit', { retries: 0, responseMode: 'text', maxResponseBytes: 6 });
    assert.deepEqual({ body: exact.body, bytes: exact.bodyBytes, truncated: exact.truncated }, { body: '€€', bytes: 6, truncated: false });
    global.fetch = async () => new Response(null, { status: 204 });
    const empty = await request('https://example.test/empty', { retries: 0, responseMode: 'text', maxResponseBytes: 6 });
    assert.deepEqual({ body: empty.body, bytes: empty.bodyBytes, truncated: empty.truncated }, { body: '', bytes: 0, truncated: false });
    global.fetch = async () => new Response(Buffer.from([0xff]));
    await assert.rejects(request('https://example.test/invalid-utf8', { retries: 0, responseMode: 'text', maxResponseBytes: 6 }), /encoded data|encoding/i);
    global.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture body failure')); } }));
    await assert.rejects(request('https://example.test/failed-stream', { retries: 0, responseMode: 'text', maxResponseBytes: 6 }), /fixture body failure/);

    global.fetch = async () => new Response(JSON.stringify({
      error: `provider echoed ${SECRET} ${encodeURIComponent(SECRET)} ${Buffer.from(SECRET).toString('base64')}`
    }), { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } });
    await assert.rejects(
      request('https://example.test/token', {
        method: 'POST', retries: 0,
        headers: { authorization: `Bearer ${SECRET}` },
        body: new URLSearchParams({ access_token: SECRET })
      }),
      error => !error.message.includes(SECRET)
        && !error.message.includes(encodeURIComponent(SECRET))
        && !error.message.includes(Buffer.from(SECRET).toString('base64'))
    );

    let invalidCalls = 0;
    global.fetch = async () => { invalidCalls += 1; return new Response('{}'); };
    await assert.rejects(request('https://example.test/', { redirect: 'sometimes' }), /redirect must be/);
    for (const maxResponseBytes of [undefined, 0, -1, 1.5, 16777217, Infinity]) {
      await assert.rejects(request('https://example.test/', { responseMode: 'text', maxResponseBytes }), /maxResponseBytes/);
    }
    await assert.rejects(request('https://example.test/', { responseMode: 'unchecked' }), /responseMode/);
    assert.equal(invalidCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
  console.log('HTTP core redirect tests passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');
const { request } = require('../src/lib/http');

async function fixture(t, handler) {
  let calls = 0;
  const server = http.createServer((req, res) => { calls += 1; handler(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  return { url: `http://127.0.0.1:${server.address().port}`, calls: () => calls };
}

test('JSON provider responses obey a byte limit before parsing', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: '€'.repeat(50) }));
  });
  await assert.rejects(request(f.url, { retries: 0, maxResponseBytes: 64 }),
    error => error.code === 'HTTP_RESPONSE_TOO_LARGE' && error.status === 200);
  assert.equal(f.calls(), 1);
});

test('default JSON parsing rejects invalid UTF-8 instead of changing provider data', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.from([123, 34, 118, 34, 58, 34, 255, 34, 125]));
  });
  await assert.rejects(request(f.url, { retries: 0 }), /encoded data|encoding/i);
});

test('an already cancelled call never reaches a provider', async t => {
  const f = await fixture(t, (_req, res) => res.end('{}'));
  const controller = new AbortController();
  const reason = new Error('fixture caller cancelled');
  controller.abort(reason);
  await assert.rejects(request(f.url, { retries: 0, signal: controller.signal }), error => error === reason);
  assert.equal(f.calls(), 0);
});

test('caller cancellation stops a stalled response body and is never retried', async t => {
  const controller = new AbortController();
  const reason = new Error('fixture body cancelled');
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    controller.abort(reason);
  });
  await assert.rejects(request(f.url, { retries: 1, timeoutMs: 100, signal: controller.signal }), error => error === reason);
  assert.equal(f.calls(), 1);
});

test('caller cancellation interrupts Retry-After backoff before another request', async t => {
  const controller = new AbortController();
  const reason = new Error('fixture retry cancelled');
  const f = await fixture(t, (_req, res) => {
    res.writeHead(503, { 'retry-after': '1' });
    res.end('{}');
    setTimeout(() => controller.abort(reason), 30);
  });
  await assert.rejects(request(f.url, { retries: 1, signal: controller.signal }), error => error === reason);
  assert.equal(f.calls(), 1);
});

test('HTTP failures retain a structured status for provider job recovery', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end('{"error":"try later"}');
  });
  await assert.rejects(request(f.url, { retries: 0 }), error => error.status === 429 && error.code === 'HTTP_REQUEST_FAILED');
});

test('a non-retryable provider error mentioning network is not a transport failure', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(400);
    res.end('network access denied for this input');
  });
  await assert.rejects(request(f.url, { retries: 1 }), error => error.status === 400);
  assert.equal(f.calls(), 1);
});

test('native Headers are forwarded and Key credentials are redacted from failures', async t => {
  const key = 'fixture-fal-key-only';
  const f = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, `Key ${key}`);
    res.writeHead(401, key);
    res.end(`Provider echoed ${key}`);
  });
  await assert.rejects(request(f.url, { retries: 0, headers: new Headers({ Authorization: `Key ${key}` }) }),
    error => error.status === 401 && !error.message.includes(key));
});

test('invalid limits and retry settings refuse before network access', async t => {
  const f = await fixture(t, (_req, res) => res.end('{}'));
  for (const retries of [-1, 1.5, NaN, Infinity]) {
    await assert.rejects(request(f.url, { retries }), /retries/);
  }
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(request(f.url, { timeoutMs }), /timeoutMs/);
  }
  for (const maxResponseBytes of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(request(f.url, { maxResponseBytes }), /maxResponseBytes/);
  }
  assert.equal(f.calls(), 0);
});

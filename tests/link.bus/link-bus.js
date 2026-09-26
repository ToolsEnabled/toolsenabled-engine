// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-link-bus-link-bus-js):
// - Strengthened the bearer-token non-disclosure assertion to inspect the
//   server's actual injected log file and every response observed by this test.
//   Mutation: temporarily appended tokenRef.current to each request log line in
//   sidecars/link-bus/server.js. RED: "AssertionError [ERR_ASSERTION]: bearer
//   token must never appear in server logs" (actual: true, expected: false).
//   The product file was restored byte-for-byte; GREEN after restoration:
//   "link-bus server contract tests passed."
// - NOT-FOUND (1): no assertion is inside a possibly-empty loop/forEach.
// - NOT-FOUND (2): no assertion relies on a child-process exit status or other
//   truthy process return instead of the subject's own output.
// - NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure;
//   request()'s JSON parse fallback is followed by assertions on parsed bodies.
// - NOT-FOUND (4): no assertion checks a mock of the behavior under test.
// - NOT-FOUND (5): no skip or platform precondition can turn this file into a
//   no-op.
// - NOT-FOUND (6): no expected value is computed by the implementation under
//   test.
// - Preconditions not met: none.

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../sidecars/link-bus/store');
const {
  createServer, checkAuth, timingSafeTokenMatch, resolveLinkBusTopology, MAX_BODY_BYTES
} = require('../../sidecars/link-bus/server');

function request(port, { method = 'GET', path: reqPath, headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody === undefined
      ? (body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8'))
      : Buffer.from(rawBody, 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, method, path: reqPath,
      headers: payload ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : headers
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { /* some error paths are plain text */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  const ordinaryLanRegistry = {
    schemaVersion: 1,
    machines: { 'machine-a': { address: '10.0.0.5' }, 'machine-b': { address: '10.0.0.6' } },
    services: {}
  };
  const topology = resolveLinkBusTopology({
    configuredHost: '10.0.0.6', serviceRegistryOptions: { registry: ordinaryLanRegistry }
  });
  assert.equal(topology.host, '10.0.0.6');
  assert.equal(topology.peerHost, '10.0.0.5');
  assert.equal(topology.allowedRemoteRe.test('10.0.0.5'), true);
  assert.equal(topology.allowedRemoteRe.test('10.0.0.7'), false);

  // --- store ---
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'link-bus-store-'));
  let clock = 1000;
  const store = createStore({ stateDir: storeRoot, now: () => clock });

  const first = store.append({ channel: 'team', sender: 'claude', message: 'hello', sentAt: '2026-07-29T00:00:00.000Z' });
  assert.equal(first.sequence, 1);
  clock += 1;
  const second = store.append({ channel: 'team', sender: 'codex-b', message: 'ack', sentAt: '2026-07-29T00:00:01.000Z' });
  assert.equal(second.sequence, 2);
  clock += 1;
  const replayedSecond = store.append({ channel: 'team', sender: 'codex-b', message: 'ack', sentAt: '2026-07-29T00:00:01.000Z' });
  assert.equal(replayedSecond.sequence, 2, 'an exact replay returns the original durable id');

  const fromStart = store.list({ channel: 'team', cursor: '0' });
  assert.equal(fromStart.messages.length, 2);
  assert.equal(fromStart.cursor, '2');
  assert.equal(fromStart.requestedCursor, 0);
  assert.equal(fromStart.headSequence, 2);
  assert.equal(fromStart.backlogCount, 2);
  assert.equal(fromStart.caughtUp, false);
  assert.equal(fromStart.status, 'BACKLOG');

  const fromCursor = store.list({ channel: 'team', cursor: '1' });
  assert.equal(fromCursor.messages.length, 1);
  assert.equal(fromCursor.messages[0].sender, 'codex-b');
  assert.equal(fromCursor.cursor, '2');

  const noNew = store.list({ channel: 'team', cursor: '2' });
  assert.equal(noNew.messages.length, 0);
  assert.equal(noNew.cursor, '2'); // stable cursor lets a poller loop safely
  assert.equal(noNew.headSequence, 2);
  assert.equal(noNew.backlogCount, 0);
  assert.equal(noNew.caughtUp, true);
  assert.equal(noNew.status, 'CAUGHT_UP');

  assert.throws(
    () => store.list({ channel: 'team' }),
    error => error.code === 'LINK_BUS_CURSOR_REQUIRED'
  );

  assert.equal(store.totalCount(), 2);

  assert.throws(() => store.append({ channel: 'bad channel!', sender: 'x', message: 'm', sentAt: '2026-07-29T00:00:00.000Z' }),
    error => error.code === 'LINK_BUS_CHANNEL_INVALID');
  assert.throws(() => store.append({ channel: 'team', sender: 'x', message: 'm', sentAt: 'not-a-date' }),
    error => error.code === 'LINK_BUS_SENTAT_INVALID');
  assert.throws(() => store.append({ channel: 'team', sender: 'x', message: '', sentAt: '2026-07-29T00:00:00.000Z' }),
    error => error.code === 'LINK_BUS_MESSAGE_INVALID');

  // Durability: a fresh store instance over the same directory replays the NDJSON files.
  const reopened = createStore({ stateDir: storeRoot });
  assert.equal(reopened.totalCount(), 2);
  assert.equal(reopened.list({ channel: 'team', cursor: '0' }).messages.length, 2);
  assert.equal(reopened.append({ channel: 'team', sender: 'codex-b', message: 'ack', sentAt: '2026-07-29T00:00:01.000Z' }).sequence, 2,
    'replay protection survives restart');
  assert.equal(reopened.totalCount(), 2);

  // A stray UTF-8 BOM on a channel file (Windows PowerShell 5.1 writer habit
  // elsewhere in this repo) must not corrupt the store.
  const bomRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'link-bus-bom-'));
  fs.writeFileSync(path.join(bomRoot, 'channel-team.ndjson'),
    `﻿${JSON.stringify({ sequence: 1, channel: 'team', sender: 'claude', message: 'hi', sentAt: '2026-07-29T00:00:00.000Z', receivedAtMs: 1 })}\n`, 'utf8');
  const bomStore = createStore({ stateDir: bomRoot });
  assert.equal(bomStore.list({ channel: 'team', cursor: '0' }).messages.length, 1);

  fs.rmSync(storeRoot, { recursive: true, force: true });
  fs.rmSync(bomRoot, { recursive: true, force: true });
  process.stdout.write('link-bus store tests passed.\n');

  // --- token comparison ---
  const token = Buffer.from('a'.repeat(32), 'utf8');
  assert.equal(timingSafeTokenMatch('a'.repeat(32), token), true);
  assert.equal(timingSafeTokenMatch('b'.repeat(32), token), false);
  assert.equal(timingSafeTokenMatch('short', token), false); // different length must not throw
  assert.equal(checkAuth({ headers: {} }, token), false);
  assert.equal(checkAuth({ headers: { authorization: 'Bearer ' } }, token), false);
  assert.equal(checkAuth({ headers: { authorization: `Bearer ${'a'.repeat(32)}` } }, token), true);
  assert.equal(checkAuth({ headers: { authorization: `Basic ${'a'.repeat(32)}` } }, token), false);
  process.stdout.write('link-bus auth tests passed.\n');

  // --- server (contract-level) ---
  const serverStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'link-bus-server-'));
  const logPath = path.join(serverStateRoot, 'link-bus.log');
  const serverToken = crypto.randomBytes(24).toString('base64url');
  const server = createServer({
    token: Buffer.from(serverToken, 'utf8'),
    store: createStore({ stateDir: path.join(serverStateRoot, 'messages') }),
    logFile: logPath,
    reloadToken: () => Buffer.from(serverToken, 'utf8'),
    allowedRemoteRe: /^127\.0\.0\.1$/
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    const health = await request(port, { path: '/health' }); // no auth header at all
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.messages, 0);

    const missingAuth = await request(port, { path: '/v1/messages?channel=team' });
    assert.equal(missingAuth.status, 401);

    const badAuth = await request(port, { path: '/v1/messages?channel=team', headers: { authorization: 'Bearer wrong-token' } });
    assert.equal(badAuth.status, 401);

    const posted = await request(port, {
      method: 'POST', path: '/v1/messages', headers: { authorization: `Bearer ${serverToken}` },
      body: { channel: 'team', sender: 'codex-b', message: 'link established', sentAt: '2026-07-29T00:00:00.000Z' }
    });
    assert.equal(posted.status, 200);
    assert.equal(posted.body.id, 'team:1');

    const replayed = await request(port, {
      method: 'POST', path: '/v1/messages', headers: { authorization: `Bearer ${serverToken}` },
      body: { channel: 'team', sender: 'codex-b', message: 'link established', sentAt: '2026-07-29T00:00:00.000Z' }
    });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.id, 'team:1');

    // A malformed body under valid auth must be 400, never 401 -- the
    // contract requires 401 only for missing/invalid credentials.
    const badBody = await request(port, {
      method: 'POST', path: '/v1/messages', headers: { authorization: `Bearer ${serverToken}` },
      body: { channel: 'team', sender: 'codex-b', message: '', sentAt: '2026-07-29T00:00:00.000Z' }
    });
    assert.equal(badBody.status, 400);

    const oversized = await request(port, {
      method: 'POST', path: '/v1/messages', headers: { authorization: `Bearer ${serverToken}` },
      rawBody: 'x'.repeat(MAX_BODY_BYTES + 1)
    });
    assert.equal(oversized.status, 413, 'oversized request receives the intended bounded response');
    assert.equal(oversized.body.error, 'invalid_body');

    const healthyAfterOversize = await request(port, { path: '/health' });
    assert.equal(healthyAfterOversize.status, 200);
    assert.equal(healthyAfterOversize.body.ok, true);

    const listed = await request(port, { path: '/v1/messages?channel=team&cursor=0', headers: { authorization: `Bearer ${serverToken}` } });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.messages.length, 1);
    assert.equal(listed.body.messages[0].message, 'link established');
    assert.equal(listed.body.cursor, '1');
    assert.equal(listed.body.requestedCursor, 0);
    assert.equal(listed.body.headSequence, 1);
    assert.equal(listed.body.backlogCount, 1);
    assert.equal(listed.body.caughtUp, false);
    assert.equal(listed.body.status, 'BACKLOG');

    const missingCursor = await request(port, { path: '/v1/messages?channel=team', headers: { authorization: `Bearer ${serverToken}` } });
    assert.equal(missingCursor.status, 400);
    assert.equal(missingCursor.body.error, 'LINK_BUS_CURSOR_REQUIRED');

    const notFound = await request(port, { path: '/nope', headers: { authorization: `Bearer ${serverToken}` } });
    assert.equal(notFound.status, 404);

    const wrongMethod = await request(port, { method: 'DELETE', path: '/v1/messages?channel=team', headers: { authorization: `Bearer ${serverToken}` } });
    assert.equal(wrongMethod.status, 405);

    // The token itself must never appear in the log file.
    const observedResponses = [
      health, missingAuth, badAuth, posted, replayed, badBody, oversized,
      healthyAfterOversize, listed, missingCursor, notFound, wrongMethod
    ];
    assert.ok(!JSON.stringify(observedResponses).includes(serverToken),
      'bearer token must never appear in response bodies');
    assert.equal(fs.readFileSync(logPath, 'utf8').includes(serverToken), false,
      'bearer token must never appear in server logs');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(serverStateRoot, { recursive: true, force: true });
  }
  process.stdout.write('link-bus server contract tests passed.\n');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

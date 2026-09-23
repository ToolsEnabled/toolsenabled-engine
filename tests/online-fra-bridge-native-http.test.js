'use strict';

// Actual loopback HTTP and native Fetch, disposable tokens/data only. These
// checks qualify the two HTTP adapters, not device enrollment or hosted FRA.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createLocalBridge } = require('../src/lib/online-fra-local-bridge');
const { createCompositeBridge } = require('../src/lib/online-fra-composite-bridge');

function bounded(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Native HTTP fixture did not finish: ${label}`)), 5000);
  })]).finally(() => clearTimeout(timer));
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-bridge-native-http-'));
  const servers = [];
  const cases = [];
  let requests = 0;
  let actionCalls = 0;
  let writeAllowed = false;
  let actionToken = crypto.randomBytes(32).toString('base64url');
  let facadeToken = crypto.randomBytes(32).toString('base64url');
  const pending = new Map();
  const counts = new Map();
  const runtimeFile = path.join(scratch, 'runtime.json');
  const tokenFile = path.join(scratch, 'token.json');

  async function listen(tokenFor, isAction) {
    const sockets = new Set();
    const server = http.createServer((request, response) => {
      requests += 1;
      const route = new URL(request.url, 'http://127.0.0.1');
      const mode = route.searchParams.get('mode') || 'ok';
      counts.set(mode, (counts.get(mode) || 0) + 1);
      const authorized = request.headers.authorization === `Bearer ${tokenFor()}`;
      const originAbsent = request.headers.origin === undefined;
      if (!authorized || !originAbsent) {
        response.writeHead(401); response.end('{}'); return;
      }
      if (route.pathname === '/v1/agent/remote-status') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, mayWrite: writeAllowed })); return;
      }
      if (isAction && route.pathname === '/v1/actions/native-fixture') actionCalls += 1;
      const observation = pending.get(mode);
      if (observation) response.once('close', observation.closed.resolve);
      if (mode === 'redirect') {
        response.writeHead(302, { location: '/must-not-follow' }); response.end(); return;
      }
      if (route.pathname === '/must-not-follow') throw new Error('The bridge followed a redirect.');
      if (['204', '205', '304'].includes(mode)) {
        response.writeHead(Number(mode)); response.end(); return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'native-fixture' });
      if (mode === 'held-revoked-read') {
        response.write('{"private":"disposable-read-answer"');
        observation.release = () => response.end('}');
        observation.started.resolve();
        return;
      }
      if (mode.startsWith('stall') || mode === 'cancel' || mode === 'drop') {
        response.write('{');
        if (observation) observation.started.resolve();
        if (mode === 'drop') setImmediate(() => response.destroy());
        return;
      }
      if (mode === 'oversize' || mode === 'facade-oversize') {
        response.write(Buffer.alloc(128 * 1024 + 1, 0x61));
        if (observation) observation.started.resolve();
        return; // Only the adapter's cancellation closes this unfinished body.
      }
      if (mode === 'limit') { response.end(Buffer.alloc(128 * 1024, 0x61)); return; }
      response.end(JSON.stringify({ ok: true, authorized, originAbsent,
        contentTypePreserved: request.headers['content-type'] === 'application/json',
        acceptPreserved: request.headers.accept === 'application/json' }));
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const result = { server, sockets, origin: `http://127.0.0.1:${server.address().port}` };
    servers.push(result);
    return result;
  }
  function observe(mode) {
    const observation = { started: deferred(), closed: deferred() };
    pending.set(mode, observation);
    return observation;
  }
  function records(origin, bearer) {
    fs.writeFileSync(runtimeFile, JSON.stringify({ baseUrl: origin }), { mode: 0o600 });
    fs.writeFileSync(tokenFile, JSON.stringify({ token: bearer }), { mode: 0o600 });
  }
  const get = async response => JSON.parse(await response.text());
  let openSocketsAfterCleanup = null;
  try {
    const action = await listen(() => actionToken, true);
    const facade = await listen(() => facadeToken, false);
    records(action.origin, actionToken);
    const local = createLocalBridge({ runtimeFile, tokenFile, timeoutMs: 500 });
    const composite = createCompositeBridge({ actionBridge: local,
      facade: () => ({ origin: facade.origin, token: facadeToken }), timeoutMs: 500 });
    const forms = [
      { origin: 'https://browser.example', authorization: 'caller-value', accept: 'application/json', 'content-type': 'application/json' },
      { ORIGIN: 'https://browser.example', Authorization: 'caller-value', Accept: 'application/json', 'Content-Type': 'application/json' },
      new Headers({ origin: 'https://browser.example', authorization: 'caller-value', accept: 'application/json', 'content-type': 'application/json' }),
      [['ORIGIN', 'https://browser.example'], ['Authorization', 'caller-value'], ['Accept', 'application/json'], ['Content-Type', 'application/json']],
    ];
    for (const bridge of [local, composite]) {
      for (const headers of forms) {
        const response = await bridge.fetch(bridge === local ? '/v1/status' : '/v1/agent/native-fixture', { headers });
        assert.equal(response.status, 200);
        assert.deepEqual(await get(response), { ok: true, authorized: true, originAbsent: true,
          contentTypePreserved: true, acceptPreserved: true });
      }
    }
    cases.push('all-native-header-forms-preserve-owner-authority-and-caller-metadata');

    const beforeInvalid = requests;
    await assert.rejects(local.fetch('/v1/status', { headers: { 'bad\r\nheader': 'value' } }),
      error => error.code === 'LOCAL_BRIDGE_HEADERS_INVALID');
    await assert.rejects(local.fetch('//other-host/path'), error => error.code === 'LOCAL_BRIDGE_PATH_INVALID');
    const preAbort = new AbortController(); preAbort.abort();
    await assert.rejects(local.fetch('/v1/status', { signal: preAbort.signal }), error => error.code === 'LOCAL_BRIDGE_ABORTED');
    assert.equal(requests, beforeInvalid);
    cases.push('invalid-input-and-pre-cancel-do-not-dispatch');

    const stalled = observe('stall-local');
    await assert.rejects(local.fetch('/v1/actions/native-fixture?mode=stall-local', { method: 'POST' }), error => {
      assert.equal(error.code, 'LOCAL_BRIDGE_TIMEOUT');
      assert.match(error.message, /request may have run; check its status/i);
      assert.ok(!error.message.includes(actionToken));
      return true;
    });
    await bounded(stalled.started.promise, 'local headers');
    await bounded(stalled.closed.promise, 'local timeout socket close');
    assert.equal(counts.get('stall-local'), 1);
    cases.push('local-deadline-includes-body-and-does-not-resend-action');

    const facadeStalled = observe('stall-facade');
    const refused = await composite.fetch('/v1/agent/start?mode=stall-facade', { method: 'POST' });
    assert.equal(refused.status, 504);
    const refusal = await get(refused);
    assert.equal(refusal.error.code, 'AGENT_FACADE_TIMEOUT');
    assert.match(refusal.error.message, /request may have run; check its status/i);
    await bounded(facadeStalled.started.promise, 'facade headers');
    await bounded(facadeStalled.closed.promise, 'facade timeout socket close');
    assert.equal(counts.get('stall-facade'), 1);
    cases.push('facade-deadline-includes-body-with-unknown-outcome');

    const cancelled = observe('cancel');
    const control = new AbortController();
    const cancellation = local.fetch('/v1/actions/native-fixture?mode=cancel', { method: 'POST', signal: control.signal });
    const cancellationCheck = assert.rejects(cancellation, error => error.code === 'LOCAL_BRIDGE_ABORTED');
    await bounded(cancelled.started.promise, 'cancel headers');
    control.abort();
    await cancellationCheck;
    await bounded(cancelled.closed.promise, 'cancelled socket close');
    assert.equal(counts.get('cancel'), 1);
    cases.push('caller-cancellation-closes-body-without-resend');

    const limit = await local.fetch('/v1/status?mode=limit');
    assert.equal((await limit.arrayBuffer()).byteLength, 128 * 1024);
    assert.equal(limit.headers.get('x-request-id'), 'native-fixture');
    for (const [bridge, mode, route] of [[local, 'oversize', '/v1/status'], [composite, 'facade-oversize', '/v1/agent/native-fixture']]) {
      const excess = observe(mode);
      if (bridge === local) await assert.rejects(bridge.fetch(`${route}?mode=${mode}`), error => error.code === 'LOCAL_BRIDGE_RESPONSE_TOO_LARGE');
      else {
        const response = await bridge.fetch(`${route}?mode=${mode}`);
        assert.equal(response.status, 502);
        assert.equal((await get(response)).error.code, 'AGENT_FACADE_RESPONSE_TOO_LARGE');
      }
      await bounded(excess.closed.promise, `${mode} socket close`);
      assert.equal(counts.get(mode), 1);
    }
    cases.push('exact-body-limit-succeeds-and-unfinished-oversize-streams-close');

    const dropped = observe('drop');
    await assert.rejects(local.fetch('/v1/status?mode=drop'), error => error.code === 'LOCAL_BRIDGE_UNAVAILABLE');
    await bounded(dropped.closed.promise, 'dropped body socket');
    cases.push('connection-loss-after-headers-is-a-named-unknown-outcome');

    assert.equal((await local.fetch('/v1/status?mode=redirect')).status, 302);
    for (const code of [204, 205, 304]) {
      const response = await local.fetch(`/v1/status?mode=${code}`);
      assert.equal(response.status, code);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
    assert.equal((await (await local.fetch('/v1/status', { method: 'HEAD' })).arrayBuffer()).byteLength, 0);
    cases.push('manual-redirect-and-bodyless-response-contracts-preserved');

    actionToken = crypto.randomBytes(32).toString('base64url');
    assert.equal((await local.fetch('/v1/status')).status, 401);
    records(action.origin, actionToken);
    assert.equal((await local.fetch('/v1/status')).status, 200);
    const replacement = await listen(() => actionToken, true);
    records(replacement.origin, actionToken);
    assert.equal((await local.fetch('/v1/status')).status, 200);
    facadeToken = crypto.randomBytes(32).toString('base64url');
    assert.equal((await composite.fetch('/v1/agent/native-fixture')).status, 200);
    cases.push('rotated-token-runtime-port-and-facade-credentials-read-per-call');

    const beforeWrites = actionCalls;
    assert.equal((await composite.fetch('/v1/actions/native-fixture', { method: 'POST' })).status, 403);
    assert.equal(actionCalls, beforeWrites);
    writeAllowed = true;
    assert.equal((await composite.fetch('/v1/actions/native-fixture', { method: 'POST' })).status, 200);
    assert.equal(actionCalls, beforeWrites + 1);
    writeAllowed = false;
    assert.equal((await composite.fetch('/v1/actions/native-fixture', { method: 'POST' })).status, 403);
    assert.equal(actionCalls, beforeWrites + 1);
    assert.equal((await local.fetch('/v1/actions/native-fixture', { method: 'POST' })).status, 200);
    assert.equal(actionCalls, beforeWrites + 2);
    cases.push('native-per-call-permission-probe-revokes-web-writes-and-preserves-local-control');

    const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      index % 2 ? local.fetch('/v1/status') : composite.fetch('/v1/agent/native-fixture')));
    for (const response of concurrent) { assert.equal(response.status, 200); assert.equal((await get(response)).ok, true); }
    cases.push('concurrent-requests-and-post-failure-recovery');

    // A supervised relay keeps this admission's exact token. Revoking that
    // token while the actual local HTTP body is pending must withhold the
    // answer; a replacement credential must not authorize its old request.
    const admitted = { origin: facade.origin, token: facadeToken };
    const supervised = createCompositeBridge({ actionBridge: local, facade: admitted, timeoutMs: 500 });
    assert.equal((await supervised.fetch('/v1/status')).status, 200);
    const heldRead = observe('held-revoked-read');
    const read = supervised.fetch('/v1/status?mode=held-revoked-read');
    await bounded(heldRead.started.promise, 'pending read body');
    facadeToken = crypto.randomBytes(32).toString('base64url');
    heldRead.release();
    const revoked = await bounded(read, 'revoked read result');
    assert.equal(revoked.status, 503, 'a revoked admission must not return its pending mission read');
    assert.ok(!(await revoked.text()).includes('disposable-read-answer'));
    assert.equal(counts.get('held-revoked-read'), 1, 'the read was not fetched again');
    const beforeRefusedRead = counts.get('revoked-before-read') || 0;
    assert.equal((await supervised.fetch('/v1/status?mode=revoked-before-read')).status, 503);
    assert.equal(counts.get('revoked-before-read') || 0, beforeRefusedRead,
      'revocation before a read prevents the local HTTP request');
    assert.equal((await composite.fetch('/v1/status')).status, 200,
      'a new request may use the current independently read facade credential');
    const standalone = createCompositeBridge({ actionBridge: local });
    assert.equal((await standalone.fetch('/v1/status')).status, 200,
      'the explicit standalone no-facade mode keeps its existing read behavior');
    assert.equal((await standalone.fetch('/v1/agent/remote-status')).status, 503,
      'standalone mode still has no substitute for a native facade');
    cases.push('revoked-native-admission-withholds-pending-reads-and-refuses-new-reads');
  } finally {
    await Promise.all(servers.map(async ({ server, sockets }) => {
      const closed = Promise.all([...sockets].map(socket => new Promise(resolve => socket.once('close', resolve))));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await bounded(closed, 'fixture cleanup');
    }));
    openSocketsAfterCleanup = servers.reduce((count, entry) => count + entry.sockets.size, 0);
    fs.rmSync(scratch, { recursive: true });
  }
  assert.equal(openSocketsAfterCleanup, 0);
  assert.equal(fs.existsSync(scratch), false);
  console.log(JSON.stringify({ suite: 'online-fra-bridge-native-http', node: process.version,
    scope: 'native-loopback-HTTP-adapters-with-disposable-fixtures', cases,
    requests, openSocketsAfterCleanup, disposableRecordsRemoved: true, hostedRelay: false }));
})().catch(error => {
  console.error(error instanceof assert.AssertionError ? error : { code: error.code || error.name, message: error.message });
  process.exitCode = 1;
});

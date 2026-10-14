'use strict';

// DNS REBINDING: THE ONE ATTACK THE ORIGIN ALLOWLIST CANNOT SEE.
//
// The mission bridge admits requests that carry NO Origin, and that is correct
// and deliberate -- a CLI, a script and an agent are not browsers, and
// tests/mission-bridge-no-origin-clients.test.js records why refusing them was
// backwards. But it has a consequence the Origin check cannot cover.
//
// A page on http://attacker.example, served with a one-second DNS TTL, fetches
// http://attacker.example:<bridge port>/v1/runtime. That is SAME-ORIGIN for the
// page, so the browser sends no Origin header at all. The attacker then rebinds
// attacker.example to 127.0.0.1, and the next fetch reaches this listener --
// carrying no Origin, and a Host header naming the attacker's domain. The
// origin allowlist sees an absent Origin and admits; nothing looked at Host.
//
// What that reached: GET /v1/runtime answers BEFORE the principal is resolved,
// so the page could read {baseUrl, port, startedAt, pid}. Every other route
// still refused -- /v1/bootstrap wants a proof value from an owner-only file in
// state/, and everything else wants the bearer or an agent session credential --
// so this was a disclosure, not a takeover. T2010 / T-A21.
//
// The fix is the standard one and it belongs here rather than at each route: a
// request whose Host does not name THIS listener is not a request to this
// listener. Nothing is sent, so no route's own checks are reached.
//
// NOTHING HERE TOUCHES THE NETWORK OR A REAL BRIDGE. The listener is a fixture
// on an ephemeral loopback port, its actions surface is two stubs, and every
// request in this file is made to it.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createMissionBridgeServer } = require('../src/lib/mission-bridge/server');

/* fetch() will not let a caller set Host, which is the whole point of the
 * header -- so the requests here are raw. The socket still goes to 127.0.0.1;
 * only the header line differs, which is exactly what a rebound browser sends. */
function request(port, pathname, { host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'GET',
      headers: { ...(host === null ? {} : { host }), ...headers },
      // A Host we chose must survive Node's own defaulting.
      setHost: false
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    call.on('error', reject);
    call.end();
  });
}

async function bridgeFixture() {
  const token = crypto.randomBytes(32);
  const runtimeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-host-')), 'runtime.json');
  const bridge = createMissionBridgeServer({
    token,
    bootstrapProof: crypto.randomBytes(32),
    allowedOrigins: ['http://127.0.0.1:4600'],
    actions: { async status() { return { ok: true, probe: 'host-header-suite' }; } },
    runtimeFile, allowTestRuntimeFile: true, allowTestPortZero: true,
    runtimeDependencies: { platform: 'test' }
  });
  const address = await bridge.listen(0);
  return { bridge, token, port: address.port, close: () => bridge.close() };
}

test('a request whose Host names someone else’s domain is refused, Origin or not', async () => {
  const fixture = await bridgeFixture();
  try {
    // Exactly the shape a rebound page sends: no Origin, attacker's Host.
    const rebound = await request(fixture.port, '/v1/runtime', { host: `attacker.example:${fixture.port}` });
    assert.equal(rebound.status, 403,
      'a rebound request reached a route; the Origin allowlist cannot see this case');
    assert.match(rebound.body, /BRIDGE_HOST_REFUSED/);
    assert.equal(/"pid"|"startedAt"|"baseUrl"/.test(rebound.body), false,
      'the runtime record was disclosed to a host this listener does not answer for');

    // The same with a bearer: Host is checked before anything else, so a
    // stolen-token client cannot talk its way past it either.
    const withBearer = await request(fixture.port, '/v1/status', {
      host: `attacker.example:${fixture.port}`,
      headers: { authorization: `Bearer ${fixture.token.toString('base64url')}` }
    });
    assert.equal(withBearer.status, 403, 'Host must be checked ahead of authentication, not after');
  } finally { fixture.close(); }
});

test('every host this listener really answers for still works', async () => {
  const fixture = await bridgeFixture();
  try {
    for (const name of ['127.0.0.1', '127.0.0.2', 'localhost']) {
      const answer = await request(fixture.port, '/v1/runtime', { host: `${name}:${fixture.port}` });
      assert.equal(answer.status, 200, `${name} is a loopback name this bridge is reached by and must not be refused`);
      assert.match(answer.body, /"ok":true/);
    }
  } finally { fixture.close(); }
});

test('a Host naming the right name but the wrong port is refused', async () => {
  const fixture = await bridgeFixture();
  try {
    const other = fixture.port === 65535 ? fixture.port - 1 : fixture.port + 1;
    const answer = await request(fixture.port, '/v1/runtime', { host: `127.0.0.1:${other}` });
    assert.equal(answer.status, 403,
      'the port is half the identity of this listener; a rebound page controls the name, not the socket');
  } finally { fixture.close(); }
});

test('a missing or malformed Host is refused rather than defaulted', async () => {
  const fixture = await bridgeFixture();
  try {
    /* HTTP/1.1 requires Host, and Node answers 400 to a request without one
       before any listener runs -- so this case is NOT evidence for the check in
       server.js, and saying otherwise would be claiming a test I do not have.
       It is here because the guarantee ("an absent Host never reaches a route")
       has to keep holding whoever enforces it. hostNamesThisListener() refuses
       absence too, so it holds if Node's behaviour ever changes. */
    const absent = await request(fixture.port, '/v1/runtime', { host: null });
    assert.ok(absent.status === 400 || absent.status === 403,
      `an absent Host must not reach a route; got ${absent.status}`);
    for (const malformed of ['', '127.0.0.1:4600/evil', '127.0.0.1:notaport', '[::1]:4600',
      `user@127.0.0.1:${fixture.port}`]) {
      const answer = await request(fixture.port, '/v1/runtime', { host: malformed });
      assert.equal(answer.status, 403, `a Host of ${JSON.stringify(malformed)} must be refused`);
    }
  } finally { fixture.close(); }
});

test('the bridge still refuses an unlisted Origin, and still admits no Origin at all', async () => {
  const fixture = await bridgeFixture();
  try {
    // The Host check must not become a second origin check, nor replace the
    // first: both of these are pinned elsewhere and must keep reading true.
    const unlisted = await request(fixture.port, '/v1/status', {
      host: `127.0.0.1:${fixture.port}`, headers: { origin: 'http://evil.example:4600' }
    });
    assert.equal(unlisted.status, 403);
    assert.match(unlisted.body, /BRIDGE_ORIGIN_REFUSED/);

    const noOrigin = await request(fixture.port, '/v1/status', { host: `127.0.0.1:${fixture.port}` });
    assert.equal(noOrigin.status, 401,
      'a no-Origin client must still reach authentication, which is what refuses it');
  } finally { fixture.close(); }
});

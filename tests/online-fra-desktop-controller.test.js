'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopController, requestFor, MAX_RESPONSE_BYTES } = require('../src/lib/online-fra-desktop-controller');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const bytes = value => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });
function fixture(t, request = async () => bytes({ ok: true, facade: 'ready', mayWrite: false })) {
  const sent = [], calls = [], end = deferred(), hello = deferred();
  let clock = Date.now();
  const handle = { lease: { peerDeviceId: 'peer-b', secret: 'must-stay-private' }, leaseExpiresAtMs: clock + 60000,
    handshake: hello.promise, closed: end.promise,
    request: async (...args) => { calls.push(args); return request(...args); } };
  const controller = createDesktopController({ send: packet => sent.push(packet), now: () => clock });
  controller.attach(handle);
  t.after(() => end.resolve());
  const selected = controller.snapshot().peer.selection;
  async function ask(operation, params = {}, extras = {}) {
    const id = require('node:crypto').randomBytes(16).toString('hex');
    await controller.receive({ type: 'fra:request', id, selection: selected, operation, params, ...extras });
    return sent.find(packet => packet.type === 'fra:reply' && packet.id === id)?.value;
  }
  return { controller, handle, sent, calls, selected, ask, end, hello, advance: ms => { clock += ms; } };
}
test('fixed routes refuse addresses, arbitrary methods, query fields and oversized bodies', () => {
  assert.equal(requestFor('https://attacker.invalid', {}), null);
  assert.equal(requestFor('agent:pick-attachment', {}), null);
  assert.equal(requestFor('bridge:dispatch', {}), null);
  assert.equal(requestFor('agent:history', { authorization: 'secret' }), null);
  assert.equal(requestFor('agent:history', { limit: {} }), null);
  assert.equal(requestFor('agent:send', { text: 'x'.repeat(65536) }), null);
  assert.equal(requestFor({}, {}), null);
  assert.equal(requestFor('org:read', []), null);
  const query = requestFor('agent:requests', { scope: 'a&b', key: 'x?y' });
  assert.equal(query.path, '/v1/agent/requests?scope=a%26b&key=x%3Fy');
});
test('status reveals only public peer, opaque selection, actual expiry and readiness', async t => {
  const f = fixture(t);
  const state = f.controller.snapshot();
  assert.equal(state.state, 'waiting');
  assert.deepEqual(Object.keys(state).sort(), ['expiresAtMs', 'peer', 'state']);
  assert.deepEqual(Object.keys(state.peer).sort(), ['id', 'selection']);
  assert.match(state.peer.selection, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(f.sent).includes('must-stay-private'), false);
  f.hello.resolve({}); await Promise.resolve();
  assert.equal(f.controller.snapshot().state, 'ready');
});
test('fixed peer requests use fresh idempotency keys and carry no supplied header', async t => {
  const f = fixture(t);
  const params = { id: 'fra-check-owned', role: 'worker', provider: 'none', expectedRevision: 3 };
  assert.equal((await f.ask('org:ensure-seat', params)).ok, true);
  const [method, path, options] = f.calls[0];
  assert.equal(method, 'POST'); assert.equal(path, '/v1/org/ensure-seat');
  assert.deepEqual(JSON.parse(options.body), params);
  assert.match(options.headers['x-request-id'], /^[a-f0-9]{32}$/);
  assert.equal((await f.ask('org:release-seat', { id: params.id, expectedRevision: 4 })).ok, true);
  assert.notEqual(options.headers['x-request-id'], f.calls[1][2].headers['x-request-id']);
  assert.equal((await f.ask('org:read', {}, { headers: { authorization: 'bad' } })).code, 'REMOTE_REQUEST_REFUSED');
  assert.equal(f.calls.length, 2);
});
test('another selection, expired lease, solo leg and changed pinned peer refuse before dispatch', async t => {
  const f = fixture(t);
  assert.equal((await f.ask('org:read', {}, { selection: '1'.repeat(32) })).outcome, 'not-sent');
  f.handle.lease.peerDeviceId = 'peer-c';
  assert.equal((await f.ask('org:read')).code, 'REMOTE_CONNECTION_CHANGED');
  f.handle.lease.peerDeviceId = 'peer-b'; f.advance(60001);
  assert.equal((await f.ask('org:read')).code, 'REMOTE_CONNECTION_CHANGED');
  f.controller.attach({ solo: true, lease: { peerDeviceId: null } });
  assert.deepEqual(f.controller.snapshot(), { state: 'unavailable', peer: null });
  assert.equal(f.calls.length, 0);
});
test('lost write responses stay unknown and are never retried', async t => {
  const f = fixture(t, async () => { throw Object.assign(new Error('private transport text'), { code: 'RELAY_SHELL_REQUEST_TIMEOUT' }); });
  assert.deepEqual(await f.ask('org:ensure-seat'), { ok: false, code: 'REMOTE_OUTCOME_UNKNOWN', outcome: 'unknown' });
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(f.sent).includes('private transport text'), false);
});
test('close, replacement or expiry during a write suppresses the old successful response', async t => {
  for (const change of ['close', 'replace', 'expire']) {
    const response = deferred(); const f = fixture(t, () => response.promise);
    const pending = f.ask('org:ensure-seat');
    if (change === 'close') { f.end.resolve(); await Promise.resolve(); }
    if (change === 'replace') f.controller.attach({ solo: true });
    if (change === 'expire') f.advance(60001);
    response.resolve(bytes({ ok: true }));
    assert.equal((await pending).outcome, 'unknown', change);
    assert.equal(f.calls.length, 1);
  }
});
test('malformed or oversized responses never become confirmed writes', async t => {
  for (const response of [{ status: 200, body: Buffer.from('partial') },
    { status: 200, body: Buffer.alloc(MAX_RESPONSE_BYTES + 1) }, bytes([])]) {
    const f = fixture(t, async () => response);
    assert.equal((await f.ask('org:ensure-seat')).outcome, 'unknown');
  }
});
test('busy window is bounded and a duplicate active id cannot dispatch twice', async t => {
  const response = deferred(); const f = fixture(t, () => response.promise);
  const packets = Array.from({ length: 16 }, (_, index) => ({ type: 'fra:request', id: index.toString(16).padStart(32, '0'),
    selection: f.selected, operation: 'org:read', params: {} }));
  const requests = packets.map(packet => f.controller.receive(packet));
  await f.controller.receive(packets[0]);
  assert.equal((await f.ask('org:read')).code, 'REMOTE_REQUEST_BUSY');
  assert.equal(f.calls.length, 16);
  response.resolve(bytes({ ok: true })); await Promise.all(requests);
  assert.equal(f.calls.length, 16);
});

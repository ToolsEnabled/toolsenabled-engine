'use strict';

// Real native HTTP, synthetic in-memory vaults, and separate explicitly trusted
// injected-stream checks. No hosted service, owner custody or process spawning.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { createDeviceClaimClient, DEVICE_CREDENTIAL_VAULT_KEY } = require('../src/lib/online-fra-device-claim');
const { createPeerIntroductionClient } = require('../src/lib/online-fra-peer-introduction');
const { ensureDeviceIdentity, DEVICE_IDENTITY_VAULT_KEY } = require('../src/lib/online-fra-device-identity');
const { fetchAccountJson, AccountResponseError, MAX_ACCOUNT_RESPONSE_BYTES } = require('../src/lib/online-fra-account-response');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const marker = 'synthetic-private-diagnostic-never-project';
const checks = [];
const counts = { actualRequests: 0, remainingSockets: 0, nativeGroups: 0, injectedGroups: 0 };
const test = (name, kind, run) => checks.push({ name, kind, run });
function memoryVault() {
  const store = new Map();
  const writes = [];
  const vault = { store, writes,
    getSecret(key) {
      if (!store.has(key)) throw Object.assign(new Error('fixture absence'), { code: 'SECRET_NOT_CONFIGURED' });
      return store.get(key);
    },
    setSecret(key, value) { writes.push(key); store.set(key, value); },
  };
  ensureDeviceIdentity(vault);
  writes.length = 0;
  return vault;
}
async function bounded(promise, timeoutMs = 3000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('fixture deadline exceeded')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
async function refused(promise, code, outcome) {
  let error;
  try { await bounded(promise); } catch (caught) { error = caught; }
  assert.ok(error, 'the actual request must refuse');
  assert.equal(error.code, code);
  if (outcome !== undefined) assert.equal(error.requestOutcome, outcome);
  assert.equal(error.message.includes(marker), false, 'raw response/abort/transport diagnostics never project');
  return error;
}
async function fixture(handler, run) {
  const sockets = new Set();
  const responses = new Set();
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1; counts.actualRequests += 1;
    responses.add(response);
    response.once('close', () => responses.delete(response));
    handler(request, response);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ origin, requests: () => requests, activeResponses: () => responses.size });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    // A destroyed socket leaves this set on its own 'close' event, which is not
    // synchronous. A fixed 10ms wait is a guess about the scheduler, and on
    // Windows it measured 2 sockets still pending. Wait for the actual state
    // under a deadline, the same shape bodyClosed() already uses, so a genuine
    // leak still fails and a slow close does not.
    const closeDeadline = Date.now() + 2000;
    while (sockets.size && Date.now() < closeDeadline) await delay(10);
    counts.remainingSockets += sockets.size;
    assert.equal(sockets.size, 0, 'all disposable connections close');
    assert.equal(responses.size, 0, 'no active body survives fixture cleanup');
  }
}
async function bodyClosed(context) {
  const start = Date.now();
  while (context.activeResponses() && Date.now() - start < 2000) await delay(10);
  assert.equal(context.activeResponses(), 0, 'production cancellation closes the native response before fixture cleanup');
}
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
const DEVICE = { pairId: 'fixture-pair', deviceId: 'fixture-device', name: 'Fixture Δ🙂' };

test('native positive claim reservation, explicit accept/decline, and grant persistence', 'native', async () => {
  let base, polls = 0;
  const v = memoryVault();
  const identityBefore = v.store.get(DEVICE_IDENTITY_VAULT_KEY);
  await fixture((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.origin, base);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const sent = JSON.parse(body);
      if (request.url === '/v1/devices/claim-code') {
        assert.equal(sent.name, DEVICE.name);
        return json(response, 201, { claim: { code: 'TC-FIXT-ONLY', pollToken: 'fixture-poll', expiresAtMs: 123, intervalSeconds: 5 } });
      }
      assert.equal(request.url, '/v1/devices/claim-code/status');
      assert.equal(sent.pollToken, 'fixture-poll');
      if (sent.accept === true) return json(response, 202, { state: 'accepted' });
      if (sent.accept === false) return json(response, 200, { state: 'rejected' });
      polls += 1;
      if (polls === 1) return json(response, 200, { state: 'reserved', account: { email: 'fixture@example.invalid' }, intervalSeconds: 5 });
      return json(response, 200, { state: 'granted', device: DEVICE, deviceToken: 'synthetic-local-device-token',
        credential: { certificatePem: 'synthetic-certificate', privateKeyPem: 'synthetic-private-key' } });
    });
  }, async context => {
    base = context.origin;
    const client = createDeviceClaimClient({ baseUrl: base, vault: v, timeoutMs: 2000 });
    assert.equal((await client.openClaim({ name: DEVICE.name })).code, 'TC-FIXT-ONLY');
    assert.deepEqual(await client.pollOnce({ pollToken: 'fixture-poll' }),
      { state: 'reserved', account: { email: 'fixture@example.invalid' }, intervalSeconds: 5 });
    assert.equal(v.writes.length, 0);
    assert.equal(context.requests(), 2, 'reservation is not automatically accepted');
    assert.deepEqual(await client.decideClaim({ pollToken: 'fixture-poll', accept: true }), { state: 'accepted' });
    assert.equal(v.writes.length, 0, 'acceptance is not grant collection');
    assert.equal((await client.pollOnce({ pollToken: 'fixture-poll' })).state, 'connected');
    assert.deepEqual(v.writes, [DEVICE_CREDENTIAL_VAULT_KEY]);
    assert.equal(v.store.get(DEVICE_IDENTITY_VAULT_KEY), identityBefore);
    assert.deepEqual(await client.decideClaim({ pollToken: 'fixture-poll', accept: false }), { state: 'rejected' });
    assert.equal(context.requests(), 5);
  });
});

test('native peer introduction preserves device-token and cookie authority and actual key', 'native', async () => {
  const peer = ensureDeviceIdentity(memoryVault());
  let base;
  await fixture((request, response) => {
    assert.equal(request.headers.origin, base);
    if (request.method === 'POST') {
      assert.equal(request.headers.cookie, 'fixture_session=synthetic');
      assert.equal(request.headers.authorization, undefined);
      request.resume();
      return json(response, 201, { device: DEVICE });
    }
    assert.equal(request.headers.authorization, 'Device synthetic-device-authority');
    assert.equal(request.headers.cookie, undefined);
    return json(response, 200, { peer: { peerPairId: 'peer-pair', peerDeviceId: 'peer-device',
      peerEd25519PublicKey: peer.publicKeyWire, generation: 7, relayPairId: 'relay-pair' } });
  }, async context => {
    base = context.origin;
    const client = createPeerIntroductionClient({ baseUrl: base, deviceToken: 'synthetic-device-authority', timeoutMs: 2000 });
    const introduced = await client.fetchPeer({ pairId: DEVICE.pairId });
    const challenge = Buffer.from('fixture-key-proof');
    assert.equal(crypto.verify(null, challenge, introduced.peerPublicKey, peer.sign(challenge)), true);
    const person = createPeerIntroductionClient({ baseUrl: base, cookie: 'fixture_session=synthetic', vault: memoryVault(), timeoutMs: 2000 });
    assert.equal((await person.enrol({ name: 'Fixture' })).device.pairId, DEVICE.pairId);
    assert.equal(context.requests(), 2);
  });
});

for (const verb of ['open', 'poll', 'accept', 'peer', 'enrol']) {
  test(`native ${verb} body deadline after headers, no implicit resend`, 'native', async () => {
    const v = memoryVault();
    await fixture((request, response) => {
      request.resume(); response.writeHead(verb === 'open' || verb === 'enrol' ? 201 : 200,
        { 'content-type': 'application/json' }); response.write(`{"unfinished":"${marker}`);
    }, async context => {
      const options = { baseUrl: context.origin, vault: v, timeoutMs: 100 };
      const claim = createDeviceClaimClient(options);
      const peer = createPeerIntroductionClient({ ...options, cookie: 'fixture_session=synthetic' });
      const began = Date.now();
      const operation = verb === 'open' ? claim.openClaim({ name: 'Fixture' })
        : verb === 'poll' ? claim.pollOnce({ pollToken: 'fixture-poll' })
          : verb === 'accept' ? claim.decideClaim({ pollToken: 'fixture-poll', accept: true })
            : verb === 'peer' ? peer.fetchPeer({ pairId: DEVICE.pairId }) : peer.enrol({ name: 'Fixture' });
      await refused(operation, verb === 'peer' || verb === 'enrol' ? 'PEER_INTRODUCTION_UNREACHABLE' : 'DEVICE_CLAIM_UNREACHABLE', 'UNCERTAIN');
      assert.ok(Date.now() - began < 2500);
      await bodyClosed(context);
      assert.equal(context.requests(), 1); assert.equal(v.writes.length, 0);
    });
  });
}

test('native response trickle does not reset the whole-operation deadline', 'native', async () => {
  await fixture((request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"padding":"');
    const timer = setInterval(() => response.write('x'), 15);
    response.once('close', () => clearInterval(timer));
  }, async context => {
    const v = memoryVault();
    await refused(createDeviceClaimClient({ baseUrl: context.origin, vault: v, timeoutMs: 100 })
      .pollOnce({ pollToken: 'fixture-poll' }), 'DEVICE_CLAIM_UNREACHABLE', 'UNCERTAIN');
    await bodyClosed(context);
    assert.equal(context.requests(), 1); assert.equal(v.writes.length, 0);
  });
});

test('native uniform 404 ignores and cancels each unfinished body', 'native', async () => {
  await fixture((request, response) => {
    request.resume(); response.writeHead(404, { 'content-type': 'application/json' });
    response.write(`{"never_consult":"${marker}`);
  }, async context => {
    const peer = createPeerIntroductionClient({ baseUrl: context.origin, deviceToken: 'synthetic-authority', timeoutMs: 2000 });
    assert.equal(await peer.fetchPeer({ pairId: 'fixture-pair-a' }), null);
    await bodyClosed(context);
    assert.equal(await peer.fetchPeer({ pairId: 'fixture-pair-b' }), null);
    await bodyClosed(context);
    const claim = createDeviceClaimClient({ baseUrl: context.origin, vault: memoryVault(), timeoutMs: 2000 });
    await refused(claim.pollOnce({ pollToken: 'fixture-poll' }), 'DEVICE_CLAIM_GONE');
    await bodyClosed(context);
    assert.equal(context.requests(), 3);
  });
});

test('native caller cancellation after headers closes body and never projects its reason', 'native', async () => {
  let arrived;
  const headers = new Promise(resolve => { arrived = resolve; });
  await fixture((request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"pending":'); arrived();
  }, async context => {
    const controller = new AbortController();
    const v = memoryVault();
    const pending = createDeviceClaimClient({ baseUrl: context.origin, vault: v, signal: controller.signal, timeoutMs: 2000 })
      .pollOnce({ pollToken: 'fixture-poll' });
    const answer = refused(pending, 'DEVICE_CLAIM_UNREACHABLE', 'UNCERTAIN');
    await headers; controller.abort(new Error(marker)); await answer;
    await bodyClosed(context); assert.equal(context.requests(), 1); assert.equal(v.writes.length, 0);
  });
});

test('native exact byte ceiling accepts a valid pending response', 'native', async () => {
  const empty = JSON.stringify({ state: 'pending', padding: '' });
  const body = JSON.stringify({ state: 'pending', padding: 'x'.repeat(MAX_ACCOUNT_RESPONSE_BYTES - Buffer.byteLength(empty)) });
  assert.equal(Buffer.byteLength(body), MAX_ACCOUNT_RESPONSE_BYTES);
  await fixture((request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.end(body);
  }, async context => {
    const result = await createDeviceClaimClient({ baseUrl: context.origin, vault: memoryVault(), timeoutMs: 2000 })
      .pollOnce({ pollToken: 'fixture-poll' });
    assert.equal(result.state, 'pending'); assert.equal(context.requests(), 1);
  });
});

for (const compressed of [false, true]) {
  test(`native oversized ${compressed ? 'decompressed' : 'plain'} body refuses before credential write`, 'native', async () => {
    const body = Buffer.from(JSON.stringify({ state: 'granted', device: DEVICE, deviceToken: 'synthetic-only',
      padding: 'x'.repeat(MAX_ACCOUNT_RESPONSE_BYTES) }));
    const transmitted = compressed ? zlib.gzipSync(body) : body;
    if (compressed) assert.ok(transmitted.length < MAX_ACCOUNT_RESPONSE_BYTES);
    await fixture((request, response) => {
      request.resume(); response.writeHead(200, { 'content-type': 'application/json', 'content-length': transmitted.length,
        ...(compressed ? { 'content-encoding': 'gzip' } : {}) }); response.end(transmitted);
    }, async context => {
      const v = memoryVault();
      await refused(createDeviceClaimClient({ baseUrl: context.origin, vault: v, timeoutMs: 2000 })
        .pollOnce({ pollToken: 'fixture-poll' }), 'DEVICE_CLAIM_UNREACHABLE', 'UNCERTAIN');
      assert.equal(context.requests(), 1); assert.equal(v.writes.length, 0);
    });
  });
}

test('native redirects never replay a credential-bearing enrollment at another origin', 'native', async () => {
  await fixture((request, response) => { request.resume(); json(response, 201, { device: DEVICE }); }, async target => {
    await fixture((request, response) => {
      request.resume(); response.writeHead(307, { location: `${target.origin}/must-not-receive` }); response.end();
    }, async source => {
      const v = memoryVault();
      await refused(createPeerIntroductionClient({ baseUrl: source.origin, cookie: 'fixture_session=synthetic', vault: v, timeoutMs: 2000 })
        .enrol({ name: 'Fixture' }), 'DEVICE_ENROL_REFUSED');
      assert.equal(source.requests(), 1); assert.equal(target.requests(), 0); assert.equal(v.writes.length, 0);
    });
  });
});

test('native successful malformed JSON is a typed uncertain introduction response without raw prose', 'native', async () => {
  await fixture((request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.end(marker);
  }, async context => {
    await refused(createPeerIntroductionClient({ baseUrl: context.origin, deviceToken: 'synthetic-authority', timeoutMs: 2000 })
      .fetchPeer({ pairId: 'fixture-pair' }), 'PEER_INTRODUCTION_RESPONSE_INVALID', 'UNCERTAIN');
    assert.equal(context.requests(), 1);
  });
});

test('native incomplete body reset is an uncertain response, not a credential grant', 'native', async () => {
  await fixture((request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'application/json', 'content-length': 10000 });
    response.write('{"state":"granted",');
    setTimeout(() => response.destroy(), 30);
  }, async context => {
    const v = memoryVault();
    await refused(createDeviceClaimClient({ baseUrl: context.origin, vault: v, timeoutMs: 2000 })
      .pollOnce({ pollToken: 'fixture-poll' }), 'DEVICE_CLAIM_UNREACHABLE', 'UNCERTAIN');
    assert.equal(context.requests(), 1); assert.equal(v.writes.length, 0);
    await bodyClosed(context);
  });
});

test('native enrollment 201 without complete device IDs is typed uncertain, never raw TypeError or success', 'native', async () => {
  const bodies = [null, [], {}, { device: null }, { device: 'not-a-device' }, { device: [] }, { device: {} },
    { device: { pairId: 'fixture-pair' } }, { device: { deviceId: 'fixture-device' } },
    { device: { pairId: '', deviceId: 'fixture-device' } }, { device: { pairId: 'fixture-pair', deviceId: '' } }];
  const expectedRequests = bodies.length;
  await fixture((request, response) => {
    request.resume(); json(response, 201, bodies.shift());
  }, async context => {
    const v = memoryVault();
    const client = createPeerIntroductionClient({ baseUrl: context.origin, vault: v,
      cookie: 'fixture_session=synthetic', timeoutMs: 2000 });
    for (let i = 0; i < expectedRequests; i += 1) await refused(client.enrol({ name: 'Fixture' }), 'PEER_INTRODUCTION_RESPONSE_INVALID', 'UNCERTAIN');
    assert.equal(context.requests(), expectedRequests); assert.equal(bodies.length, 0); assert.equal(v.writes.length, 0);
  });
});

test('native expected-success claim envelopes refuse malformed or incomplete data without credential writes or resends', 'native', async () => {
  const cases = [
    ['open', marker], ['open', {}], ['open', { claim: [] }], ['open', { claim: {} }],
    ['open', { claim: { code: '', pollToken: 'fixture-poll' } }],
    ['open', { claim: { code: 'TC-FIXT-ONLY' } }],
    ['open', { claim: { code: 'TC-FIXT-ONLY', pollToken: 42 } }],
    ['poll', marker], ['poll', {}], ['poll', []],
    ['poll', { state: 'reserved', account: [] }], ['poll', { state: 'reserved', account: { email: '' } }],
    ['poll', { state: 'granted', device: {}, deviceToken: 'synthetic-only' }],
    ['poll', { state: 'granted', device: { pairId: 'fixture-pair' }, deviceToken: 'synthetic-only' }],
    ['poll', { state: 'granted', device: DEVICE, deviceToken: '' }],
    ['poll', { state: 'granted', device: [], deviceToken: 'synthetic-only' }],
    ['poll', { state: 'accepted' }],
    ['accept', marker], ['accept', {}], ['accept', { state: 'pending' }],
    ['decline', marker], ['decline', []], ['decline', { state: 'accepted' }],
  ];
  let current;
  await fixture((request, response) => {
    request.resume();
    const status = current[0] === 'open' ? 201 : current[0] === 'accept' ? 202 : 200;
    if (current[1] === marker) {
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(marker);
    } else json(response, status, current[1]);
  }, async context => {
    const v = memoryVault();
    const client = createDeviceClaimClient({ baseUrl: context.origin, vault: v, timeoutMs: 2000 });
    for (const item of cases) {
      current = item;
      const operation = item[0] === 'open' ? client.openClaim({ name: 'Fixture' })
        : item[0] === 'poll' ? client.pollOnce({ pollToken: 'fixture-poll' })
          : client.decideClaim({ pollToken: 'fixture-poll', accept: item[0] === 'accept' });
      const error = await refused(operation, 'DEVICE_CLAIM_RESPONSE_INVALID', 'UNCERTAIN');
      assert.match(error.message, /check its status before repeating/);
      assert.equal(v.writes.length, 0);
    }
    assert.equal(context.requests(), cases.length);
  });
});

test('native genuine non-success service refusals retain their established codes and prose without resends', 'native', async () => {
  await fixture((request, response) => {
    request.resume(); json(response, 403, { error: { code: 'ORIGIN_REFUSED', message: 'Fixture origin is refused.' } });
  }, async context => {
    const v = memoryVault();
    const claim = createDeviceClaimClient({ baseUrl: context.origin, vault: v, timeoutMs: 2000 });
    const peer = createPeerIntroductionClient({ baseUrl: context.origin, cookie: 'fixture_session=synthetic', vault: v, timeoutMs: 2000 });
    for (const run of [() => claim.openClaim({ name: 'Fixture' }),
      () => claim.decideClaim({ pollToken: 'fixture-poll', accept: true }), () => peer.enrol({ name: 'Fixture' })]) {
      const error = await refused(run(), 'ORIGIN_REFUSED');
      assert.equal(error.message, 'Fixture origin is refused.'); assert.equal(error.requestOutcome, undefined);
    }
    assert.equal(context.requests(), 3); assert.equal(v.writes.length, 0);
  });
});

test('native valid solo introduction preserves its explicit null peer and positive generation', 'native', async () => {
  await fixture((request, response) => {
    request.resume(); json(response, 200, { peer: { relayPairId: 'fixture-relay', peerDeviceId: null, generation: 1 } });
  }, async context => {
    const client = createPeerIntroductionClient({ baseUrl: context.origin, deviceToken: 'synthetic-authority', timeoutMs: 2000 });
    assert.deepEqual(await client.fetchPeer({ pairId: 'fixture-pair' }), { relayPairId: 'fixture-relay',
      peerPairId: null, peerDeviceId: null, peerPublicKey: null, peerPublicKeyWire: null, generation: 1 });
    assert.equal(context.requests(), 1);
  });
});

test('native incomplete solo and paired introductions are uncertain while unusable keys retain their typed refusal', 'native', async () => {
  const valid = { relayPairId: 'fixture-relay', peerPairId: 'fixture-peer-pair', peerDeviceId: 'fixture-peer',
    generation: 1, peerEd25519PublicKey: ensureDeviceIdentity(memoryVault()).publicKeyWire };
  const bodies = [null, [], {}, { peer: [] }, { peer: { peerDeviceId: null } },
    { peer: { relayPairId: '', peerDeviceId: null, generation: 1 } },
    { peer: { relayPairId: 'fixture-relay', peerDeviceId: null } },
    ...[0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map(generation => ({ peer: { ...valid, generation } })),
    { peer: { ...valid, peerDeviceId: '' } }, { peer: { ...valid, peerPairId: '' } }];
  let current;
  await fixture((request, response) => { request.resume(); json(response, 200, current); }, async context => {
    const client = createPeerIntroductionClient({ baseUrl: context.origin, deviceToken: 'synthetic-authority', timeoutMs: 2000 });
    for (const body of bodies) {
      current = body;
      await refused(client.fetchPeer({ pairId: 'fixture-pair' }), 'PEER_INTRODUCTION_RESPONSE_INVALID', 'UNCERTAIN');
    }
    current = { peer: { ...valid, peerEd25519PublicKey: 'not base64url!!' } };
    await refused(client.fetchPeer({ pairId: 'fixture-pair' }), 'DEVICE_IDENTITY_PEER_INVALID');
    assert.equal(context.requests(), bodies.length + 1);
  });
});

test('native pre-aborted clients send no request and report only the not-sent guidance', 'native', async () => {
  await fixture((request, response) => { request.resume(); json(response, 500, {}); }, async context => {
    const controller = new AbortController(); controller.abort(new Error(marker));
    const v = memoryVault();
    const claim = createDeviceClaimClient({ baseUrl: context.origin, vault: v, signal: controller.signal, timeoutMs: 2000 });
    const peer = createPeerIntroductionClient({ baseUrl: context.origin, deviceToken: 'synthetic-authority', signal: controller.signal, timeoutMs: 2000 });
    for (const [run, code] of [[() => claim.openClaim({ name: 'Fixture' }), 'DEVICE_CLAIM_UNREACHABLE'],
      [() => peer.fetchPeer({ pairId: 'fixture-pair' }), 'PEER_INTRODUCTION_UNREACHABLE']]) {
      const error = await refused(run(), code, 'NOT_ATTEMPTED');
      assert.match(error.message, /The request was not sent to the service\./);
      assert.doesNotMatch(error.message, /may have reached/);
    }
    await delay(20); assert.equal(context.requests(), 0); assert.equal(v.writes.length, 0);
  });
});

test('trusted injected late JSON cannot store a grant after the response deadline', 'injected', async () => {
  let finish, calls = 0;
  const v = memoryVault();
  const client = createDeviceClaimClient({ baseUrl: 'https://fixture.invalid', vault: v, timeoutMs: 25,
    fetchImpl: async () => { calls += 1; return { status: 200, json: () => new Promise(resolve => { finish = resolve; }) }; } });
  await refused(client.pollOnce({ pollToken: 'synthetic-poll' }), 'DEVICE_CLAIM_UNREACHABLE', 'UNCERTAIN');
  finish({ state: 'granted', device: DEVICE, deviceToken: 'synthetic-never-store' });
  await delay(10); assert.equal(v.writes.length, 0); assert.equal(calls, 1);
});

test('trusted injected stream cancellation may hang but does not retain our reader lock', 'injected', async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('{"pending":')); },
    cancel() { cancelled += 1; return new Promise(() => {}); },
  }));
  await refused(fetchAccountJson('https://fixture.invalid', {}, { timeoutMs: 25, fetchImpl: async () => response }),
    'ACCOUNT_HTTP_TIMEOUT', 'UNCERTAIN');
  await delay(10); assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
});

test('trusted injected fetch rejection cannot copy raw exception diagnostics', 'injected', async () => {
  const thrown = Object.defineProperty({}, 'message', { get() { throw new Error(marker); } });
  await refused(createPeerIntroductionClient({ baseUrl: 'https://fixture.invalid', deviceToken: 'synthetic-authority',
    timeoutMs: 25, fetchImpl: async () => { throw thrown; } }).fetchPeer({ pairId: 'fixture-pair' }),
  'PEER_INTRODUCTION_UNREACHABLE', 'UNCERTAIN');
});

test('pre-aborted and invalid-deadline inputs dispatch no request', 'injected', async () => {
  let calls = 0;
  const v = memoryVault();
  const fetchImpl = async () => { calls += 1; throw new Error(marker); };
  const controller = new AbortController(); controller.abort(new Error(marker));
  await refused(createDeviceClaimClient({ baseUrl: 'https://fixture.invalid', vault: v, fetchImpl,
    timeoutMs: 25, signal: controller.signal }).pollOnce({ pollToken: 'fixture-poll' }),
  'DEVICE_CLAIM_UNREACHABLE', 'NOT_ATTEMPTED');
  for (const timeoutMs of [0, -1, NaN, Infinity, 2 ** 31]) {
    assert.throws(() => createDeviceClaimClient({ baseUrl: 'https://fixture.invalid', vault: v, fetchImpl, timeoutMs }),
      error => error.code === 'DEVICE_CLAIM_CONFIG_INVALID');
    assert.throws(() => createPeerIntroductionClient({ baseUrl: 'https://fixture.invalid', deviceToken: 'synthetic', fetchImpl, timeoutMs }),
      error => error.code === 'PEER_INTRODUCTION_CONFIG_INVALID');
  }
  assert.equal(calls, 0); assert.equal(v.writes.length, 0);
});

test('hostile injected signal errors cannot evade the closed read-once outcome projection', 'injected', async () => {
  let reads = 0, calls = 0;
  const error = new AccountResponseError('fixture', 'fixture', 'UNCERTAIN');
  Object.defineProperty(error, 'requestOutcome', { get() { reads += 1; return reads === 1 ? 'NOT_ATTEMPTED' : marker; } });
  const signal = { aborted: false, addEventListener() { throw error; }, removeEventListener() {} };
  const fetchImpl = async () => { calls += 1; throw new Error(marker); };
  await refused(createDeviceClaimClient({ baseUrl: 'https://fixture.invalid', vault: memoryVault(),
    fetchImpl, signal }).pollOnce({ pollToken: 'fixture-poll' }), 'DEVICE_CLAIM_UNREACHABLE', 'NOT_ATTEMPTED');
  assert.equal(reads, 1); assert.equal(calls, 0);
  const throwing = Object.defineProperty(new AccountResponseError('fixture', 'fixture', 'UNCERTAIN'),
    'requestOutcome', { get() { throw new Error(marker); } });
  signal.addEventListener = () => { throw throwing; };
  await refused(createPeerIntroductionClient({ baseUrl: 'https://fixture.invalid', deviceToken: 'synthetic',
    fetchImpl, signal }).fetchPeer({ pairId: 'fixture-pair' }), 'PEER_INTRODUCTION_UNREACHABLE', 'UNCERTAIN');
  assert.equal(calls, 0);
});

(async () => {
  assert.equal(checks.length, 27, 'all authored groups execute');
  for (const check of checks) {
    await check.run();
    counts[check.kind === 'native' ? 'nativeGroups' : 'injectedGroups'] += 1;
    console.log(`ok - ${check.name}`);
  }
  assert.equal(counts.remainingSockets, 0);
  console.log(JSON.stringify({ suite: 'online-fra-account-native-http', node: process.version,
    ...counts, hostedAccountUsed: false, ownerVaultUsed: false, automaticActionRetryAdded: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });

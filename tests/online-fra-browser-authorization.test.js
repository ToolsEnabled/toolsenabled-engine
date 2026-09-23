'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, sleep, json } = require('./helpers/online-fra-browser-authority-fixture');
const { BROWSER_DISPATCH_GUARD } = require('../src/lib/online-fra-browser-authority');
const { createCompositeBridge } = require('../src/lib/online-fra-composite-bridge');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = body => ({ status: 200, headers: {}, arrayBuffer: async () => Buffer.from(JSON.stringify(body)) });

test('a non-revoking relay cannot dispatch after independently bounded account withdrawal', async () => {
  const h = await createHarness();
  try {
    const { W } = await h.browser(); assert.equal((await W.request('GET', '/v1/status')).status, 200);
    assert.equal(h.calls.length, 1); h.revoked = true;
    await sleep(280);
    await assert.rejects(W.request('GET', '/v1/status'), { code: 'TUNNEL_BROWSER_AUTHORITY_ENDED' });
    assert.equal(h.calls.length, 1); assert.equal(h.introductions, 2);
  } finally { await h.close(); }
});

test('same-identity key renewals still require independent authorization refreshes', async () => {
  const h = await createHarness();
  try {
    const { W, events } = await h.browser();
    for (let i = 0; i < 6; i++) { await sleep(280); assert.equal((await W.request('GET', '/v1/status')).status, 200); }
    assert.ok(h.introductions >= 6); assert.ok(events.some(e => e.kind === 'online_fra_web_renewed'));
  } finally { await h.close(); }
});

test('replacement browser never decrypts the previous browser response', async () => {
  const started = deferred(); const finish = deferred(); let completed = false;
  const bridge = { fetch: async (path, init) => { init[BROWSER_DISPATCH_GUARD](); started.resolve(); await finish.promise;
    completed = true; return response({ marker: 'original-browser-only' }); } };
  const h = await createHarness({ bridge }); let actualDecrypt;
  try {
    const { W: A } = await h.browser(); const old = A.request('GET', '/v1/status').catch(error => error.code); await started.promise;
    await h.browser(); assert.equal(await old, 'WEB_CLIENT_CLOSED');
    const decrypted = []; actualDecrypt = globalThis.crypto.subtle.decrypt.bind(globalThis.crypto.subtle);
    globalThis.crypto.subtle.decrypt = async (...args) => { const bytes = await actualDecrypt(...args); decrypted.push(Buffer.from(bytes).toString('utf8')); return bytes; };
    finish.resolve(); await sleep(100);
    assert.equal(completed, true, 'already started work is not cancelled');
    assert.equal(decrypted.some(value => { try { const message = JSON.parse(value); return Buffer.from(message.body || '', 'base64').toString('utf8').includes('original-browser-only'); } catch { return false; } }), false);
  } finally { if (actualDecrypt) globalThis.crypto.subtle.decrypt = actualDecrypt; finish.resolve(); await h.close(); }
});

test('a held response reaches its original browser after same-identity crypto renewal', async () => {
  const started = deferred(); const finish = deferred();
  const h = await createHarness({ bridge: { fetch: async (path, init) => { init[BROWSER_DISPATCH_GUARD](); started.resolve(); await finish.promise; return response({ marker: 'same-browser' }); } } });
  try {
    const { W, events } = await h.browser(); const result = W.request('GET', '/v1/status'); await started.promise;
    await sleep(1300); assert.ok(events.some(e => e.kind === 'online_fra_web_renewed'));
    finish.resolve(); assert.equal(JSON.parse(Buffer.from((await result).body)).marker, 'same-browser');
  } finally { finish.resolve(); await h.close(); }
});

test('a stalled authority body times out without dispatch and a late success cannot revive it', async () => {
  const h = await createHarness({ authorityTimeoutMs: 40 }); const late = deferred();
  try {
    const { W } = await h.browser(); await sleep(280);
    h.introductionLoader = async () => ({ status: 200, json: () => late.promise });
    await assert.rejects(W.request('GET', '/v1/status'), { code: 'TUNNEL_BROWSER_AUTHORITY_ENDED' });
    assert.equal(h.calls.length, 0);
    late.resolve({ webPeer: { ...h.webSession, authorizationCheckedAtMs: Date.now() + 5000 } });
    await sleep(50); assert.equal(h.calls.length, 0);
  } finally { late.resolve({}); await h.close(); }
});

test('an older account service with no authority fields refuses the browser handshake', async () => {
  const h = await createHarness();
  try {
    h.introductionLoader = async (signal, peer) => json(200, { webPeer: { webDeviceId: peer.webDeviceId, ed25519PublicKey: peer.ed25519PublicKey, expiresAtMs: peer.expiresAtMs } });
    await assert.rejects(h.browser()); assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('authority expiration during the local write-permission probe prevents action dispatch', async () => {
  const probe = deferred(); const started = deferred(); let dispatched = 0;
  const bridge = createCompositeBridge({ actionBridge: { fetch: async () => { dispatched++; return response({}); } },
    facade: () => ({ origin: 'http://127.0.0.1:4321', token: 'inert-local-token' }),
    fetchImpl: async () => { started.resolve(); await probe.promise; return new Response(JSON.stringify({ ok: true, mayWrite: true }), { status: 200 }); } });
  const h = await createHarness({ bridge });
  try {
    const { W } = await h.browser(); const result = W.request('POST', '/v1/actions/dispatch', { body: Buffer.from('{}') });
    await started.promise; await sleep(280); probe.resolve();
    await assert.rejects(result, { code: 'TUNNEL_BROWSER_AUTHORITY_ENDED' }); assert.equal(dispatched, 0);
  } finally { probe.resolve(); await h.close(); }
});

test('browser displacement during the local permission probe cannot dispatch the queued action', async () => {
  const probe = deferred(); const started = deferred(); let dispatched = 0;
  const bridge = createCompositeBridge({ actionBridge: { fetch: async () => { dispatched++; return response({}); } },
    facade: { origin: 'http://127.0.0.1:4321', token: 'inert-local-token' },
    fetchImpl: async () => { started.resolve(); await probe.promise; return new Response(JSON.stringify({ ok: true, mayWrite: true })); } });
  const h = await createHarness({ bridge });
  try {
    const { W: A } = await h.browser(); const original = A.request('POST', '/v1/actions/dispatch', { body: Buffer.from('{}') }).catch(error => error.code);
    await started.promise; await h.browser(); assert.equal(await original, 'WEB_CLIENT_CLOSED');
    probe.resolve(); await sleep(50); assert.equal(dispatched, 0);
  } finally { probe.resolve(); await h.close(); }
});

test('authenticated request pressure is bounded and its release uses one fresh account lookup', async () => {
  const finish = deferred(); const allStarted = deferred(); let count = 0;
  const h = await createHarness({ bridge: { fetch: async (path, init) => { init[BROWSER_DISPATCH_GUARD](); count++; if (count === 32) allStarted.resolve(); await finish.promise; return response({}); } } });
  try {
    const { W } = await h.browser(); const requests = Array.from({ length: 32 }, () => W.request('GET', '/v1/status').catch(error => error.code));
    await allStarted.promise;
    await assert.rejects(W.request('GET', '/v1/status'), { code: 'TUNNEL_REQUEST_LIMIT' }); assert.equal(count, 32);
    h.revoked = true; await sleep(280); finish.resolve();
    assert.ok((await Promise.all(requests)).every(code => code === 'TUNNEL_BROWSER_AUTHORITY_ENDED'));
    assert.equal(h.introductions, 2); assert.equal(count, 32);
  } finally { finish.resolve(); await h.close(); }
});

test('the browser authority fixture remains valid across consecutive clock ticks', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => ++now;
  let h;
  try {
    h = await createHarness();
    const { W } = await h.browser();
    assert.equal(h.webSession.authorizationExpiresAtMs, h.webSession.expiresAtMs);
    assert.equal((await W.request('GET', '/v1/status')).status, 200);
    assert.equal(h.calls.length, 1);
  } finally {
    try { if (h) await h.close(); } finally { Date.now = realNow; }
  }
});

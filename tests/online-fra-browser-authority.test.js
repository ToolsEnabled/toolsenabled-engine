'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBrowserAuthority, MAX_AUTHORITY_AGE_MS } = require('../src/lib/online-fra-browser-authority');

const key = () => crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
function fixture(options = {}) {
  let wall = 1_800_000_000_000; let mono = 1000; let calls = 0;
  let value = { webDeviceId: 'web-browserA', ed25519PublicKey: key(), expiresAtMs: wall + 600_000,
    authorizationExpiresAtMs: wall + 60_000, authorizationCheckedAtMs: wall + 5000 };
  let loader = async () => ({ status: 200, json: async () => ({ webPeer: value }) });
  const invalidated = [];
  const authority = createBrowserAuthority({ clock: () => wall, monotonicClock: () => mono,
    load: signal => { calls += 1; return loader(signal); },
    onInvalidated: (identity, reason) => invalidated.push({ identity, reason }), ...options });
  return { authority, invalidated, get calls() { return calls; }, get value() { return value; },
    set value(next) { value = next; }, set loader(next) { loader = next; },
    advance(ms) { wall += ms; mono += ms; }, wallBy(ms) { wall += ms; }, monoBy(ms) { mono += ms; },
    refreshTimes() { value = { ...value, authorizationCheckedAtMs: wall + 5000, authorizationExpiresAtMs: wall + 60_000, expiresAtMs: wall + 600_000 }; } };
}

test('the shipped independent authorization budget is exactly thirty seconds', () => {
  assert.equal(MAX_AUTHORITY_AGE_MS, 30_000);
  assert.throws(() => createBrowserAuthority({ load: async () => {}, maxAgeMs: 30_001 }));
});

test('an exact-bound request waits for current account authority; a poll never extends stale server time', async () => {
  const h = fixture(); await h.authority.resolve('web-browserA'); const identity = h.authority.capture('web-browserA');
  h.advance(29_999); assert.equal(h.authority.check(identity), true);
  h.advance(1); assert.equal(h.authority.check(identity), false);
  h.value = { ...h.value, authorizationCheckedAtMs: h.value.authorizationCheckedAtMs + 30_000 };
  assert.equal(await h.authority.ensure(identity), true); assert.equal(h.calls, 2);
  h.advance(30_000); assert.equal(h.authority.check(identity), false);
  assert.equal(await h.authority.ensure(identity), false, 'expired server deadline is not renewed by fetching it again');
});

test('a replayed old checked timestamp cannot refresh an expired local freshness budget', async () => {
  const h = fixture(); await h.authority.resolve('web-browserA'); const identity = h.authority.capture('web-browserA');
  h.advance(30_000);
  assert.equal(await h.authority.ensure(identity), false);
});

test('repeated bodies inside clock tolerance cannot move the thirty-second deadline', async () => {
  const h = fixture(); await h.authority.resolve('web-browserA'); const identity = h.authority.capture('web-browserA');
  h.advance(4000);
  assert.equal((await h.authority.resolve('web-forged')).reason, 'web-peer-mismatch');
  h.advance(25_999); assert.equal(h.authority.check(identity), true);
  h.advance(1); assert.equal(h.authority.check(identity), false);
});

test('synchronized clocks apply the conservative five-second allowance', async () => {
  const h = fixture(); h.value = { ...h.value, authorizationCheckedAtMs: h.value.authorizationCheckedAtMs - 5000 };
  await h.authority.resolve('web-browserA'); const identity = h.authority.capture('web-browserA');
  h.advance(24_999); assert.equal(h.authority.check(identity), true);
  h.advance(1); assert.equal(h.authority.check(identity), false);
});

test('a shorter account deadline takes precedence at its exact boundary', async () => {
  const h = fixture(); h.value = { ...h.value, authorizationExpiresAtMs: h.value.authorizationCheckedAtMs + 25 };
  await h.authority.resolve('web-browserA'); const identity = h.authority.capture('web-browserA');
  h.advance(24); assert.equal(h.authority.check(identity), true);
  h.advance(1); assert.equal(h.authority.check(identity), false);
});

for (const [name, patch] of [
  ['missing authority deadline', value => { delete value.authorizationExpiresAtMs; }],
  ['missing checked time', value => { delete value.authorizationCheckedAtMs; }],
  ['missing transport deadline', value => { delete value.expiresAtMs; }],
  ['string deadline', value => { value.authorizationExpiresAtMs = String(value.authorizationExpiresAtMs); }],
  ['infinite deadline', value => { value.authorizationExpiresAtMs = Infinity; }],
  ['fractional checked time', value => { value.authorizationCheckedAtMs += .5; }],
  ['negative checked time', value => { value.authorizationCheckedAtMs = -1; }],
  ['unsafe integer deadline', value => { value.expiresAtMs = Number.MAX_SAFE_INTEGER + 1; }],
  ['expired authority', value => { value.authorizationExpiresAtMs = value.authorizationCheckedAtMs; }],
  ['authority beyond transport', value => { value.authorizationExpiresAtMs = value.expiresAtMs + 1; }],
  ['unbounded transport', value => { value.expiresAtMs = value.authorizationCheckedAtMs + 900_001; }],
  ['wrong key type', value => { value.ed25519PublicKey = crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'); }],
  ['malformed browser identifier', value => { value.webDeviceId = 'web-\nattacker'; }]
]) test(`${name} refuses without creating authority`, async () => {
  const h = fixture(); const value = { ...h.value }; patch(value); h.value = value;
  assert.equal((await h.authority.resolve('web-browserA')).webPeer, null);
  assert.equal(h.authority.capture('web-browserA'), null);
});

test('same identity refresh preserves ownership; new key or browser never revives an old snapshot', async () => {
  const h = fixture(); await h.authority.resolve('web-browserA'); const a = h.authority.capture('web-browserA');
  h.advance(30_000); h.refreshTimes(); assert.equal(await h.authority.ensure(a), true);
  h.advance(30_000); h.refreshTimes(); h.value = { ...h.value, ed25519PublicKey: key() };
  assert.equal(await h.authority.ensure(a), false); assert.equal(h.invalidated.length, 1);
  const next = h.authority.capture('web-browserA'); assert.notEqual(next.epoch, a.epoch);
  h.value = { ...h.value, webDeviceId: 'web-browserB' };
  await h.authority.resolve('web-browserB'); assert.equal(h.authority.check(next), false);
  assert.equal(h.authority.capture('web-browserB').webDeviceId, 'web-browserB');
});

test('a forged different-ID hello is cooled down and does not evict the actual browser', async () => {
  const h = fixture(); await h.authority.resolve('web-browserA'); const a = h.authority.capture('web-browserA');
  assert.equal((await h.authority.resolve('web-forged')).reason, 'web-peer-mismatch');
  for (let i = 0; i < 20; i++) assert.equal((await h.authority.resolve('web-forged' + i)).webPeer, null);
  assert.equal(h.calls, 2); assert.equal(h.authority.check(a), true);
  assert.ok((await h.authority.resolve('web-browserA')).webPeer); assert.equal(h.calls, 2);
});

test('concurrent requests share one current account lookup', async () => {
  const h = fixture(); let finish;
  h.loader = () => new Promise(resolve => { finish = resolve; });
  const requests = Array.from({ length: 40 }, () => h.authority.resolve('web-browserA'));
  assert.equal(h.calls, 1); finish({ status: 200, json: async () => ({ webPeer: h.value }) });
  assert.ok((await Promise.all(requests)).every(x => x.webPeer));
});

test('response delay counts from request start and cannot mint fresh time on receipt', async () => {
  const h = fixture(); let finish;
  h.loader = () => new Promise(resolve => { finish = resolve; });
  const request = h.authority.resolve('web-browserA');
  h.advance(30_000); finish({ status: 200, json: async () => ({ webPeer: h.value }) });
  assert.equal((await request).webPeer, null); assert.equal(h.authority.capture('web-browserA'), null);
});

test('wall rollback cannot extend authority; a forward jump invalidates a suspended grant', async () => {
  const h = fixture(); await h.authority.resolve('web-browserA'); const a = h.authority.capture('web-browserA');
  h.wallBy(-60_000); h.monoBy(30_000); assert.equal(h.authority.check(a), false);
  const second = fixture(); await second.authority.resolve('web-browserA'); const b = second.authority.capture('web-browserA');
  second.wallBy(30_000); assert.equal(second.authority.check(b), false);
});

test('wall rollback between refreshes cannot re-anchor a replayed server observation', async () => {
  const h = fixture(); await h.authority.resolve('web-browserA'); const a = h.authority.capture('web-browserA');
  h.advance(30_000); h.wallBy(-30_000);
  assert.equal(await h.authority.ensure(a), false);
  assert.equal(h.authority.capture('web-browserA'), null);
});

test('a small server timestamp advance earns only that time after a wall rollback', async () => {
  const h = fixture(); await h.authority.resolve('web-browserA'); const a = h.authority.capture('web-browserA');
  h.advance(30_000); h.wallBy(-29_999);
  h.value = { ...h.value, authorizationCheckedAtMs: h.value.authorizationCheckedAtMs + 1 };
  assert.equal(await h.authority.ensure(a), true);
  h.monoBy(1); assert.equal(h.authority.check(a), false);
});

test('timeout aborts, fails closed and ignores a late loader success', async () => {
  const h = fixture({ timeoutMs: 15 }); let finish; let signal;
  await h.authority.resolve('web-browserA'); const a = h.authority.capture('web-browserA'); h.advance(30_000);
  h.loader = offered => { signal = offered; return new Promise(resolve => { finish = resolve; }); };
  const keepAlive = setTimeout(() => {}, 100);
  try {
    assert.equal(await h.authority.ensure(a), false); assert.equal(signal.aborted, true);
    finish({ status: 200, json: async () => ({ webPeer: h.value }) }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.authority.capture('web-browserA'), null);
  } finally { clearTimeout(keepAlive); h.authority.close(); }
});

test('a closed connection never installs an in-flight successful introduction', async () => {
  const h = fixture(); let finish;
  h.loader = () => new Promise(resolve => { finish = resolve; });
  const request = h.authority.resolve('web-browserA'); h.authority.close();
  finish({ status: 200, json: async () => ({ webPeer: h.value }) });
  assert.equal((await request).webPeer, null); assert.equal(h.authority.capture('web-browserA'), null);
});

test('a malformed or oversized account body does not install authority', async () => {
  const h = fixture(); h.loader = async () => new Response('{broken', { status: 200 });
  assert.equal((await h.authority.resolve('web-browserA')).webPeer, null);
  h.advance(5000); h.loader = async () => new Response(' '.repeat(20_000), { status: 200 });
  assert.equal((await h.authority.resolve('web-browserA')).webPeer, null);
});

test('the deadline covers a stalled streaming response body', async () => {
  const h = fixture({ timeoutMs: 15 }); let cancelled = false;
  h.loader = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }));
  const keepAlive = setTimeout(() => {}, 100);
  try { assert.equal((await h.authority.resolve('web-browserA')).webPeer, null); assert.equal(cancelled, true); }
  finally { clearTimeout(keepAlive); h.authority.close(); }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guardRelayClose, RELAY_CLOSE_TIMEOUT_MS, RELAY_CLOSE_UNCONFIRMED } = require('../src/lib/online-fra-relay-close');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimer(key) { timers.delete(key); },
    tick(ms) {
      now += ms;
      for (const [key, t] of [...timers]) if (t.at <= now) { timers.delete(key); t.fn(); }
    }
  };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('an unsolicited actual close is returned without requesting another close', async () => {
  const end = deferred(), time = clock(); let calls = 0;
  const guarded = guardRelayClose({ close() { calls++; }, closed: end.promise }, time);
  const receipt = { code: 1006, reason: 'fixture' };
  end.resolve(receipt);
  assert.equal(await guarded.closed, receipt);
  guarded.close();
  assert.equal(calls, 0);
  assert.equal(time.timers.size, 0);
});

test('normal requested close waits for the actual receipt and cancels its deadline', async () => {
  const end = deferred(), time = clock(); let calls = 0, settled = false;
  const guarded = guardRelayClose({ close() { calls++; }, closed: end.promise }, time);
  guarded.closed.then(() => { settled = true; });
  guarded.close(); await flush();
  assert.equal(settled, false);
  assert.equal(calls, 1);
  const receipt = { code: 1000, reason: '' }; end.resolve(receipt);
  assert.equal(await guarded.closed, receipt);
  assert.equal(time.timers.size, 0);
});

test('a black-holed close rejects at five seconds without claiming closure', async () => {
  const end = deferred(), time = clock(); let observed = false;
  end.promise.then(() => { observed = true; });
  const guarded = guardRelayClose({ close() {}, closed: end.promise }, time);
  assert.equal(RELAY_CLOSE_TIMEOUT_MS, 5000);
  guarded.close(); time.tick(4999); await flush();
  assert.equal(time.timers.size, 1);
  time.tick(1);
  await assert.rejects(guarded.closed, { code: RELAY_CLOSE_UNCONFIRMED });
  assert.equal(observed, false);
  assert.equal(time.timers.size, 0);
});

test('repeated close requests neither call close twice nor extend the deadline', async () => {
  const end = deferred(), time = clock(); let calls = 0;
  const guarded = guardRelayClose({ close() { calls++; }, closed: end.promise }, time);
  guarded.close(); time.tick(4000); guarded.close(); time.tick(1000);
  await assert.rejects(guarded.closed, { code: RELAY_CLOSE_UNCONFIRMED });
  assert.equal(calls, 1);
});

test('a synchronous close error stays bounded and its private message is not returned', async () => {
  const end = deferred(), time = clock();
  const guarded = guardRelayClose({ close() { throw new Error('private-fixture-detail'); }, closed: end.promise }, time);
  guarded.close(); time.tick(5000);
  await assert.rejects(guarded.closed, e => e.code === RELAY_CLOSE_UNCONFIRMED && !e.message.includes('private-fixture-detail'));
});

test('a throwing close can still be followed by a genuine close receipt', async () => {
  const end = deferred(), time = clock();
  const guarded = guardRelayClose({ close() { throw new Error('fixture'); }, closed: end.promise }, time);
  guarded.close(); end.resolve({ code: 1000 });
  assert.equal((await guarded.closed).code, 1000);
  assert.equal(time.timers.size, 0);
});

test('a late close cannot turn a terminal deadline refusal into success', async () => {
  const end = deferred(), time = clock();
  const guarded = guardRelayClose({ close() {}, closed: end.promise }, time);
  guarded.close(); time.tick(5000);
  await assert.rejects(guarded.closed, { code: RELAY_CLOSE_UNCONFIRMED });
  end.resolve({ code: 1000 }); await flush();
  await assert.rejects(guarded.closed, { code: RELAY_CLOSE_UNCONFIRMED });
  assert.equal(time.timers.size, 0);
});

test('a rejected underlying promise is not accepted as physical closure', async () => {
  const end = deferred(), time = clock();
  const guarded = guardRelayClose({ close() {}, closed: end.promise }, time);
  guarded.close(); end.reject(new Error('private-fixture-detail'));
  await assert.rejects(guarded.closed, e => e.code === RELAY_CLOSE_UNCONFIRMED && !e.message.includes('private-fixture-detail'));
  assert.equal(time.timers.size, 0);
});

test('malformed handles and nonfinite deadlines are refused before close', () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 0.5]) {
    assert.throws(() => guardRelayClose({ close() {}, closed: Promise.resolve({}) }, { timeoutMs }), TypeError);
  }
  for (const handle of [null, {}, { close() {}, closed: null }]) assert.throws(() => guardRelayClose(handle), TypeError);
});

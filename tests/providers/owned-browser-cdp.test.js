// Refusal mutation check (module SHA-256
// a38f675078f5ade89561817cefa9892e479d1f9c5d3702f21d9978cb178f2041):
// removing either the ERR_INVALID_URL null return or the indeterminate throw
// made this isolated file exit 1; each mutation landed, and each restore matched
// the hash above.

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const cdp = require('../../src/lib/providers/owned-browser-cdp');

const tests = [];
const test = (name, run) => tests.push([name, run]);
const session = Object.freeze({
  generation: 'g'.repeat(43),
  processId: '101',
  processStartKey: '2002',
  cdpProcessId: '303',
  cdpProcessStartKey: '4004',
  cdpPort: 9222,
  cdpEndpoint: 'http://127.0.0.1:9222/'
});

function unavailable(error) {
  return error && error.code === cdp.BROWSER_UNAVAILABLE;
}

function withoutWritesOrSpawns(run) {
  const calls = [];
  const replacements = [];
  for (const [owner, names, kind] of [
    [fs, ['appendFile', 'appendFileSync', 'createWriteStream', 'writeFile', 'writeFileSync'], 'write'],
    [childProcess, ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'], 'spawn']
  ]) {
    for (const name of names) {
      const original = owner[name];
      replacements.push([owner, name, original]);
      owner[name] = () => { calls.push(`${kind}:${name}`); throw new Error(`unexpected ${kind}`); };
    }
  }
  try { return { value: run(), calls }; }
  finally {
    for (const [owner, name, original] of replacements) owner[name] = original;
  }
}

test('exports the stable timeout and generic unavailable code', () => {
  assert.equal(cdp.CDP_TIMEOUT_MS, 10_000);
  assert.equal(cdp.BROWSER_UNAVAILABLE, 'OWNED_BROWSER_CDP_UNAVAILABLE');
});

test('validates session fields and a loopback endpoint whose port matches the session', () => {
  assert.equal(cdp.validSession(session), true);
  assert.equal(cdp.endpointFor(session).href, session.cdpEndpoint);
  assert.equal(cdp.validSession({ ...session, generation: 'short' }), false);
  assert.throws(() => cdp.endpointFor({ ...session, cdpEndpoint: 'http://localhost:9222/' }), unavailable);
  assert.throws(() => cdp.endpointFor({ ...session, cdpEndpoint: 'http://127.0.0.1:9333/' }), unavailable);
});

test('compares every identity field and revalidates immediately through browserOwner.attach', () => {
  assert.equal(cdp.sameSessionIdentity(session, { ...session }), true);
  assert.equal(cdp.sameSessionIdentity(session, { ...session, generation: 'x'.repeat(43) }), false);
  let attaches = 0;
  const result = cdp.revalidateSession({ attach() { attaches += 1; return { ...session }; } }, session);
  assert.equal(attaches, 1);
  assert.equal(result.endpoint.href, session.cdpEndpoint);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(
    () => cdp.revalidateSession({ attach: () => ({ ...session, processId: '102' }) }, session, 'CALLER_CODE'),
    error => error && error.code === 'CALLER_CODE' && /identity changed/.test(error.message)
  );
});

test('accepts only page debugger WebSockets on the attached loopback CDP port', () => {
  assert.equal(
    cdp.safeDebuggerUrl('ws://127.0.0.1:9222/devtools/page/page_ABC-123', session),
    'ws://127.0.0.1:9222/devtools/page/page_ABC-123'
  );
  for (const value of [
    'wss://127.0.0.1:9222/devtools/page/id',
    'ws://localhost:9222/devtools/page/id',
    'ws://127.0.0.1:9333/devtools/page/id',
    'ws://127.0.0.1:9222/devtools/browser/id'
  ]) assert.equal(cdp.safeDebuggerUrl(value, session), null, value);
});

test('returns null for the reachable ERR_INVALID_URL refusal without writing or spawning', () => {
  const refusal = withoutWritesOrSpawns(() => cdp.safeDebuggerUrl('still not a URL', session));
  assert.equal(refusal.value, null);
  assert.deepEqual(refusal.calls, []);
});

test('throws indeterminate for coercion failures without writing, spawning, or latching', () => {
  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    let conversions = 0;
    const unavailableValue = {
      toString() {
        conversions += 1;
        const error = new Error(`conversion failed: ${code}`);
        error.code = code;
        throw error;
      }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refusal = withoutWritesOrSpawns(() => assert.throws(
        () => cdp.safeDebuggerUrl(unavailableValue, session),
        error => error && error.code === cdp.DEBUGGER_URL_INDETERMINATE
          && /NOT claiming that it is absent/.test(error.message)
      ));
      assert.deepEqual(refusal.calls, []);
    }
    assert.equal(conversions, 2, `${code} must be retried rather than latched`);
  }
});

test('fetches the CDP target list at /json/list and rejects failed or malformed responses', async () => {
  let request;
  const targets = [{ id: 'page-1', type: 'page' }];
  assert.deepEqual(await cdp.targetsFor(async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => targets };
  }, new URL(session.cdpEndpoint)), targets);
  assert.equal(request.url.href, 'http://127.0.0.1:9222/json/list');
  assert.ok(request.options.signal instanceof AbortSignal);
  await assert.rejects(cdp.targetsFor(async () => ({ ok: false }), new URL(session.cdpEndpoint)), unavailable);
  await assert.rejects(cdp.targetsFor(async () => ({ ok: true, json: async () => ({}) }), new URL(session.cdpEndpoint)), unavailable);
});

test('evaluates the requested expression over CDP, validates the reply, and closes the socket', async () => {
  let socket;
  class FakeWebSocket {
    constructor(url) {
      this.url = url; this.OPEN = 1; this.readyState = 1; this.listeners = {}; socket = this;
      setImmediate(() => this.listeners.open());
    }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    send(payload) {
      this.sent = JSON.parse(payload);
      queueMicrotask(() => this.listeners.message({ data: JSON.stringify({ id: 1, result: { result: { value: 42 } } }) }));
    }
    close() { this.closed = true; }
  }
  const value = await cdp.evaluate(FakeWebSocket, 'ws://127.0.0.1:9222/devtools/page/id', '6 * 7', item => item === 42);
  assert.equal(value, 42);
  assert.equal(socket.url, 'ws://127.0.0.1:9222/devtools/page/id');
  assert.deepEqual(socket.sent, {
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: '6 * 7', returnByValue: true, awaitPromise: false }
  });
  assert.equal(socket.closed, true);
});

test('rejects an evaluated value that does not pass the caller validator', async () => {
  class InvalidValueSocket {
    constructor() {
      this.OPEN = 1; this.readyState = 1; this.listeners = {};
      setImmediate(() => this.listeners.open());
    }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    send() { queueMicrotask(() => this.listeners.message({ data: '{"id":1,"result":{"result":{"value":false}}}' })); }
    close() {}
  }
  await assert.rejects(cdp.evaluate(InvalidValueSocket, 'ws://127.0.0.1:9222/devtools/page/id', 'false', Boolean), unavailable);
});

test('focuses one already-fenced page through the generic CDP toolkit', async () => {
  let socket;
  class FocusSocket {
    constructor(url) {
      this.url = url; this.OPEN = 1; this.readyState = 1; this.listeners = {}; socket = this;
      setImmediate(() => this.listeners.open());
    }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    send(payload) {
      this.sent = JSON.parse(payload);
      queueMicrotask(() => this.listeners.message({ data: '{"id":1,"result":{}}' }));
    }
    close() { this.closed = true; }
  }
  assert.equal(await cdp.bringToFront(FocusSocket, 'ws://127.0.0.1:9222/devtools/page/id'), true);
  assert.equal(socket.url, 'ws://127.0.0.1:9222/devtools/page/id');
  assert.deepEqual(socket.sent, { id: 1, method: 'Page.bringToFront', params: {} });
  assert.equal(socket.closed, true);
});

(async () => {
  assert.ok(tests.length > 0, 'the owned-browser-cdp test registry must not be empty');
  let failures = 0;
  for (const [name, run] of tests) {
    try { await run(); console.log(`ok - ${name}`); }
    catch (error) { failures += 1; console.error(`not ok - ${name}`); console.error(error); }
  }
  if (failures) {
    console.error(`${failures} failing`);
    process.exitCode = 1;
  } else console.log(`all ${tests.length} owned-browser-cdp checks passed`);
})();

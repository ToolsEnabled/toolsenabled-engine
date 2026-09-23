'use strict';
/*
 * Mutation proof (2026-08-27):
 * - Inverting the LOCAL_BRIDGE_OPTIONS_INVALID predicate landed in the module
 *   and made this isolated file red (exit 1).
 * - Replacing LOCAL_BRIDGE_TOKEN_UNAVAILABLE at the token read landed in the
 *   module and made this isolated file red (exit 1).
 * - After each mutation the module was restored to its original SHA-256,
 *   4fc4fd3e41f02ae92e26f32e5578e046f0fc0d9a7e60907c6d1e5e101ff0d1bb.
 */
// The local bridge adapter: reads the bridge's per-boot records, refuses
// anything that is not loopback, refuses a path that is not a path, sends the
// bearer and no Origin, and re-reads the records on every call so a bridge
// restart is picked up without a restart of the shell.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  OnlineFraLocalBridgeError,
  createLocalBridge
} = require('../src/lib/online-fra-local-bridge');

let assertions = 0;
const equal = (a, b, m) => { assertions += 1; assert.equal(a, b, m); };
const rejects = async (p, code) => { assertions += 1; await assert.rejects(p, (e) => e.code === code, code); };

// Invalid construction is synchronous and cannot touch either record or
// dispatch a request. Nonexistent paths make an accidental read observable.
{
  const absentRoot = path.join(os.tmpdir(), `local-bridge-options-${process.pid}`);
  assert.throws(
    () => createLocalBridge({
      runtimeFile: path.join(absentRoot, 'runtime.json'),
      tokenFile: path.join(absentRoot, 'token.json'),
      fetchImpl: null
    }),
    (error) => {
      equal(error instanceof OnlineFraLocalBridgeError, true, 'invalid options throw the public bridge error type');
      equal(error.code, 'LOCAL_BRIDGE_OPTIONS_INVALID', 'invalid options retain their refusal code');
      equal(error.message, 'No fetch implementation; inject one.', 'invalid options explain the missing dependency');
      return true;
    }
  );
  equal(fs.existsSync(absentRoot), false, 'invalid construction writes no bridge records');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-bridge-'));
const runtimeFile = path.join(dir, 'runtime.json');
const tokenFile = path.join(dir, 'token.json');
const bearer = 'A'.repeat(43);
const write = (base, token = bearer) => { fs.writeFileSync(runtimeFile, JSON.stringify({ baseUrl: base, port: 4610 })); fs.writeFileSync(tokenFile, JSON.stringify({ token })); };

(async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: 200, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) }; };
  const bridge = createLocalBridge({ runtimeFile, tokenFile, fetchImpl });

  // Missing records are a named failure, not a crash.
  await rejects(bridge.fetch('/v1/status'), 'LOCAL_BRIDGE_RUNTIME_UNAVAILABLE');

  // A readable runtime plus an absent token reaches the token-read refusal.
  // It rejects rather than returning a response, and neither dispatches nor
  // creates the missing credential record.
  fs.writeFileSync(runtimeFile, JSON.stringify({ baseUrl: 'http://127.0.0.1:4610' }));
  const callsBeforeMissingToken = calls.length;
  await assert.rejects(
    bridge.fetch('/v1/status'),
    (error) => {
      equal(error instanceof OnlineFraLocalBridgeError, true, 'an unavailable token throws the public bridge error type');
      equal(error.code, 'LOCAL_BRIDGE_TOKEN_UNAVAILABLE', 'an absent token retains its refusal code');
      equal(error.message.includes('token.json is not readable (ENOENT).'), true, 'the refusal names the unreadable token record');
      return true;
    }
  );
  equal(calls.length, callsBeforeMissingToken, 'an unavailable token dispatches no request');
  equal(fs.existsSync(tokenFile), false, 'an unavailable token is not fabricated or written');

  write('http://127.0.0.1:4610');
  const r = await bridge.fetch('/v1/status?x=1', { method: 'GET', headers: { origin: 'https://evil.example', accept: 'application/json' } });
  equal(r.status, 200);
  equal(calls[0].url, 'http://127.0.0.1:4610/v1/status?x=1', 'path appended to the loopback base, never a URL the caller supplied');
  equal(calls[0].init.headers.authorization, `Bearer ${bearer}`, 'the bearer from the token file');
  equal(calls[0].init.headers.origin, undefined, 'no Origin: a non-browser caller');
  equal(calls[0].init.headers.accept, 'application/json', 'other headers pass');
  equal(calls[0].init.redirect, 'manual', 'redirects are not followed');

  // A restart rotates both files; the next call uses the new values without a shell restart.
  const rotated = 'B'.repeat(43);
  write('http://127.0.0.1:4611', rotated);
  await bridge.fetch('/v1/status');
  equal(calls[1].url, 'http://127.0.0.1:4611/v1/status');
  equal(calls[1].init.headers.authorization, `Bearer ${rotated}`);

  // A runtime record naming anything but loopback is refused -- it is a file somebody else wrote.
  write('http://10.0.0.5:4610');
  await rejects(bridge.fetch('/v1/status'), 'LOCAL_BRIDGE_RUNTIME_INVALID');
  write('https://127.0.0.1:4610');
  await rejects(bridge.fetch('/v1/status'), 'LOCAL_BRIDGE_RUNTIME_INVALID');

  // A bearer that is not a bearer is refused before any request is made.
  write('http://127.0.0.1:4610', 'short');
  await rejects(bridge.fetch('/v1/status'), 'LOCAL_BRIDGE_TOKEN_INVALID');

  // A path that is not a path never reaches fetch.
  write('http://127.0.0.1:4610');
  const before = calls.length;
  await rejects(bridge.fetch('https://evil.example/x'), 'LOCAL_BRIDGE_PATH_INVALID');
  await rejects(bridge.fetch('//evil.example/x'), 'LOCAL_BRIDGE_PATH_INVALID');
  await rejects(bridge.fetch('/ok\r\nInjected: header'), 'LOCAL_BRIDGE_PATH_INVALID');
  equal(calls.length, before, 'none of those were fetched');

  // A custom Response stream may ignore the fetch signal. Its reader must
  // still be cancelled and unlocked when the deadline expires; merely racing
  // the caller's promise would leave the body read pending forever.
  let cancelled = 0;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([123])); },
    cancel() { cancelled += 1; return new Promise(() => {}); }
  });
  const custom = createLocalBridge({ runtimeFile, tokenFile, timeoutMs: 5,
    fetchImpl: async () => new Response(stream) });
  const keepalive = setTimeout(() => {}, 5000);
  try {
    await rejects(custom.fetch('/v1/status'), 'LOCAL_BRIDGE_TIMEOUT');
    equal(cancelled, 1, 'the adapter cancelled the custom body on deadline');
    equal(stream.locked, false, 'the pending read settled and released its lock');
  } finally { clearTimeout(keepalive); }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`online-fra-local-bridge: ${assertions} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });

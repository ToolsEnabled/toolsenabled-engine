'use strict';
// REGRESSION for agent-coord finding/fable-review/mission-bridge-three-defects,
// items (1) and (3) against src/lib/mission-bridge/server.js. (item (2) lives
// in owner-prompts.js and is covered by tests/owner-public-prompts.test.js.)
//
// Deliberately NOT named tests/mission-bridge*.js -- that pattern is the
// census-misc-fixes lane's territory; this file exercises the same server.js
// exports through a separate, narrowly-scoped test file instead.
//
// (1) removeRuntimeDiscovery's catch was `if (error?.code !== 'ENOENT')
//     return;` -- the return and the implicit fall-through are identical, so
//     a REAL unlink failure (EACCES/EBUSY/a corrupt-JSON parse error) was
//     swallowed exactly like the expected "already gone" case, and
//     close() would resolve while the runtime discovery file still pointed
//     at a dead bridge.
// (2) the async request listener called send() at several sites outside any
//     try/catch (the CORS refusal being the very first line of the
//     handler). http's request-listener contract does not await or attach
//     a .catch() to what the listener returns, so a send() throw (writeHead
//     after headers already sent, end() on a dead socket) became an
//     unhandled promise rejection instead of a handled error.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  createMissionBridgeServer, removeRuntimeDiscovery, writeRuntimeDiscovery
} = require('../src/lib/mission-bridge/server');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-error-handling-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function validRecord() {
  return { baseUrl: 'http://127.0.0.1:4610', port: 4610, startedAt: '2026-08-10T00:00:00.000Z', pid: 4321 };
}

// A minimal fs facade covering exactly what writeRuntimeDiscovery /
// removeRuntimeDiscovery use, delegating to the real filesystem except for
// unlinkSync, which always fails with a real (non-ENOENT) error.
function fsWithFailingUnlink() {
  const error = () => Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
  return {
    readFileSync: fs.readFileSync.bind(fs),
    mkdirSync: fs.mkdirSync.bind(fs),
    writeFileSync: fs.writeFileSync.bind(fs),
    renameSync: fs.renameSync.bind(fs),
    unlinkSync() { throw error(); }
  };
}

test('writeRuntimeDiscovery distinguishes "did not happen" from "could not be established" when cleanup also fails', () => {
  const primary = Object.assign(new Error('runtime record write refused'), { code: 'EACCES' });
  const cleanup = Object.assign(new Error('temporary file cleanup refused'), { code: 'EBUSY' });
  const io = {
    mkdirSync() {},
    writeFileSync() { throw primary; },
    renameSync() { assert.fail('a failed write must not be renamed into place'); },
    unlinkSync() { throw cleanup; }
  };

  assert.throws(
    () => writeRuntimeDiscovery(validRecord(), {
      fs: io,
      runtimeFile: path.join(os.tmpdir(), 'unwritten-runtime.json'),
      allowTestRuntimeFile: true,
      platform: 'test'
    }),
    error => error.code === 'BRIDGE_RUNTIME_DISCOVERY_UNAVAILABLE'
      && error.message === 'Runtime discovery file could not be written.',
    'the caller must observe that publication could not be established, never a definite-success answer'
  );
});

test('removeRuntimeDiscovery rethrows a real unlink failure instead of swallowing it', (t) => {
  const dir = tmpDir(t);
  const runtimeFile = path.join(dir, 'runtime.json');
  const record = validRecord();
  fs.writeFileSync(runtimeFile, `${JSON.stringify(record)}\n`, 'utf8');
  assert.throws(
    () => removeRuntimeDiscovery(record, { fs: fsWithFailingUnlink(), runtimeFile }),
    error => error.code === 'EBUSY',
    'a real unlink failure (not ENOENT) must propagate, not vanish'
  );
  // And the file must still be there -- the whole point of not swallowing.
  assert.strictEqual(fs.existsSync(runtimeFile), true);
});

test('removeRuntimeDiscovery treats an already-gone file (ENOENT) as success', (t) => {
  const dir = tmpDir(t);
  const runtimeFile = path.join(dir, 'never-written.json');
  assert.doesNotThrow(() => removeRuntimeDiscovery(validRecord(), { runtimeFile }));
});

test('close() rejects when the runtime discovery file cannot be removed for a real reason', async (t) => {
  const dir = tmpDir(t);
  const runtimeFile = path.join(dir, 'runtime.json');
  const bridge = createMissionBridgeServer({
    token: crypto.randomBytes(32),
    // Injected, not minted: minting would unlink the live bridge's production
    // bootstrap proof in state/ and lock Mission Control's owner popup out.
    bootstrapProof: crypto.randomBytes(32),
    allowedOrigins: ['http://127.0.0.2:4600'],
    actions: {},
    runtimeFile,
    allowTestRuntimeFile: true,
    allowTestPortZero: true,
    runtimeDependencies: { fs: fsWithFailingUnlink(), platform: 'test' }
  });
  await bridge.listen(0);
  await assert.rejects(() => bridge.close(), error => error.code === 'EBUSY',
    'close() must surface a real runtime-discovery removal failure rather than resolving as if cleanup succeeded');
});

// A throwing fake http.ServerResponse. writeHead always throws (as the real
// one does for e.g. ERR_HTTP_HEADERS_SENT or a destroyed socket), so any
// send() call reaches it deterministically -- reproducing the failure mode
// without racing a real socket teardown.
function throwingResponse() {
  const state = { headersSent: false, writableEnded: false, destroyed: false, writeHeadCalls: 0 };
  const response = {
    get headersSent() { return state.headersSent; },
    get writableEnded() { return state.writableEnded; },
    writeHead() {
      state.writeHeadCalls += 1;
      throw Object.assign(new Error('socket is not writable'), { code: 'ERR_STREAM_DESTROYED' });
    },
    end() { state.writableEnded = true; },
    destroy() { state.destroyed = true; state.writableEnded = true; }
  };
  return { response, state };
}

test('the request listener never produces an unhandled rejection when send() itself throws', async (t) => {
  const dir = tmpDir(t);
  const bridge = createMissionBridgeServer({
    token: crypto.randomBytes(32),
    bootstrapProof: crypto.randomBytes(32),
    allowedOrigins: ['http://127.0.0.2:4600'],
    actions: {},
    runtimeFile: path.join(dir, 'runtime.json'),
    allowTestRuntimeFile: true,
    allowTestPortZero: true
  });
  t.after(() => bridge.close().catch(() => {}));

  // Drive the registered request listener directly (never call bridge.listen()
  // first) so send() throwing can be forced deterministically instead of
  // raced over a real socket.
  const listener = bridge.server.listeners('request')[0];
  assert.strictEqual(typeof listener, 'function');

  const { response, state } = throwingResponse();
  // No Origin header -> corsHeaders() returns null -> the CORS-refused
  // send() is the very FIRST statement in the handler, outside any
  // try/catch: exactly the site the finding named.
  const request = { headers: {}, method: 'GET', url: '/v1/runtime' };

  let unhandled = null;
  const onUnhandledRejection = error => { unhandled = error; };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    assert.doesNotThrow(() => listener(request, response), 'the listener itself must stay synchronous and non-throwing');
    // Let the microtask queue turn over so an unawaited rejection, if any,
    // would surface as 'unhandledRejection' before we assert on it.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }

  assert.strictEqual(unhandled, null, 'send() throwing inside the handler must not become an unhandled rejection');
  assert.ok(state.writeHeadCalls >= 1, 'the handler attempted to respond at least once');
  assert.strictEqual(state.destroyed, true, 'the fallback destroys the socket once no response could be sent');
});


/* T454: THE CAPABILITY LAYER IS NOT KILLED BY A SLOW IDENTITY PROBE.
 *
 * writeRuntimeDiscovery() reads this process's own Windows identity so the
 * discovery record can be ACLed to the owner alone. When that probe timed out
 * on a loaded machine, this file's own catch turned it into
 * BRIDGE_RUNTIME_DISCOVERY_UNAVAILABLE, listen() closed the server, and the
 * app printed `[capability-layer] not started: CAPABILITY_EXITED`. Nothing
 * retried, because nothing downstream could tell there was anything to retry.
 *
 * The two rules pinned here: an unanswered identity probe is reported with its
 * OWN retryable code, and listen() keeps the already-bound listener up while it
 * retries rather than throwing a working capability layer away. */

function identityUnavailable() {
  return Object.assign(new Error('identity not read yet'), { code: 'UAC_OWNER_PRINCIPAL_UNAVAILABLE' });
}

test('an identity probe that never answered is reported as retryable, not as a failed write', () => {
  assert.throws(
    () => writeRuntimeDiscovery(validRecord(), {
      fs: { mkdirSync() {}, writeFileSync() {}, renameSync() {}, unlinkSync() {} },
      runtimeFile: path.join(os.tmpdir(), 'identity-unavailable-runtime.json'),
      allowTestRuntimeFile: true,
      platform: 'win32',
      execFileSyncImpl: () => { throw identityUnavailable(); },
      sleepSyncImpl: () => {},
    }),
    error => error.code === 'BRIDGE_OWNER_IDENTITY_UNAVAILABLE' && error.details?.retryable === true,
    'a busy machine that has not yet named its own account reads as a broken disk, so no caller can know to retry'
  );
});

test('listen() keeps the bridge up and retries when the identity probe is slow, instead of exiting', async (t) => {
  const dir = tmpDir(t);
  const runtimeFile = path.join(dir, 'runtime.json');
  let probes = 0;
  const bridge = createMissionBridgeServer({
    token: crypto.randomBytes(32),
    // Injected, not minted: minting would unlink the live bridge's production
    // bootstrap proof in state/ and lock Mission Control's owner popup out.
    bootstrapProof: crypto.randomBytes(32),
    allowedOrigins: ['http://127.0.0.2:4600'],
    actions: {},
    runtimeFile,
    allowTestRuntimeFile: true,
    allowTestPortZero: true,
    runtimeDependencies: {
      platform: 'win32',
      /* Silent for longer than ownerPrincipal's OWN retries can absorb, so the
         first whole writeRuntimeDiscovery attempt really does fail and it is
         listen()'s retry -- the listener staying up -- that is under test here.
         ownerPrincipal makes at most IDENTITY_PROBE_ATTEMPTS x 2 probes, so six
         silences is exactly one exhausted discovery attempt; the seventh call
         answers. */
      execFileSyncImpl: () => {
        probes += 1;
        if (probes <= 6) throw Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
        return '"desktop-us8r1lb\\toolsenabled-dev","S-1-5-21-3785318353-1649235538-2134364065-1027"\r\n';
      },
      sleepSyncImpl: () => {},
      delayImpl: () => Promise.resolve(),
      spawnSyncImpl: () => ({ status: 0 }),
    },
  });
  t.after(() => bridge.close().catch(() => {}));

  const address = await bridge.listen(0);
  assert.ok(address.port > 0, 'the capability layer did not start at all');
  assert.equal(fs.existsSync(runtimeFile), true,
    'the bridge reported a start without publishing the discovery record its callers find it by');
  assert.ok(probes > 6,
    'the whole first discovery attempt was abandoned rather than retried, so one slow identity probe still takes the capability layer down');
});

test('listen() still fails fast when the discovery write is refused for a real reason', async (t) => {
  const dir = tmpDir(t);
  let attempts = 0;
  const bridge = createMissionBridgeServer({
    token: crypto.randomBytes(32),
    bootstrapProof: crypto.randomBytes(32),
    allowedOrigins: ['http://127.0.0.2:4600'],
    actions: {},
    runtimeFile: path.join(dir, 'runtime.json'),
    allowTestRuntimeFile: true,
    allowTestPortZero: true,
    runtimeDependencies: {
      platform: 'test',
      delayImpl: () => Promise.resolve(),
      fs: {
        mkdirSync() {},
        writeFileSync() { attempts += 1; throw Object.assign(new Error('refused'), { code: 'EACCES' }); },
        renameSync() {}, unlinkSync() {},
      },
    },
  });
  t.after(() => bridge.close().catch(() => {}));
  await assert.rejects(() => bridge.listen(0),
    error => error.code === 'BRIDGE_RUNTIME_DISCOVERY_UNAVAILABLE',
    'a genuinely refused write must not be retried as if it were a busy machine');
  assert.equal(attempts, 1, 'a permanent refusal was retried, which delays every real failure by the whole backoff');
});

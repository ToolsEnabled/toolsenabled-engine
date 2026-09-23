'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const fileContexts = require('../src/lib/file-tool-context');

const TOKEN = 'byte-scope-fixture-not-a-real-credential';
const NEXT_TOKEN = 'byte-scope-fixture-rotated-not-a-real-credential';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Loopback fixture did not settle')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

// Real TCP, the actual bridge implementation, and the real private context
// factory. Only unrelated vault/config/log access and the reload clock are
// isolated. The injected dispatcher observes the actual transport options;
// this suite does not claim a provider/database end-to-end proof.
function loadBridge() {
  const sourcePath = path.resolve(__dirname, '../src/remote-agent-bridge.js');
  const localRequire = createRequire(sourcePath);
  const minted = [];
  const logs = [];
  const timers = new Set();
  const registry = [{ name: 'repo.read_file', effect: 'local-read' }];
  const dependencies = {
    'node:fs': { ...fs, appendFileSync: (_file, text) => logs.push(text) },
    './lib/runtime': { getSecret() { throw new Error('Fixture must not read a vault'); }, vaultFingerprint: () => null },
    './lib/tool-registry': { TOOL_REGISTRY: registry, listTools: () => registry },
    './lib/permission-tier-policy': { guardedToolNames: () => ['repo.read_file'] },
    './lib/providers/subscription-launch-env': {},
    './lib/service-registry': { machineAddressPolicy: () => ({ entries: [] }) },
    './mcp-server': { processLine() { throw new Error('Fixture must supply its dispatcher'); }, recordMcpSurface() {} },
    './lib/file-tool-context': {
      ...fileContexts,
      createFileToolContext(options) {
        const scope = fileContexts.createFileToolContext(options);
        minted.push(scope);
        return scope;
      }
    }
  };
  const sandboxRequire = name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name);
  const module = { exports: {} };
  const source = fs.readFileSync(sourcePath, 'utf8').replace(/^#!/, '//');
  const load = vm.runInNewContext('(function(require,module,exports,__filename,__dirname){\n'
    + source + '\n})', {
    Buffer,
    process: { env: {}, pid: process.pid, cwd: () => path.dirname(sourcePath), stderr: { write() {} } },
    setTimeout, clearTimeout,
    setInterval(callback) { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
    clearInterval: timer => timers.delete(timer)
  }, { filename: sourcePath });
  load(sandboxRequire, module, module.exports, sourcePath, path.dirname(sourcePath));
  return { createBridge: module.exports.createBridge, minted, logs, poll: () => { for (const timer of timers) timer.callback(); } };
}

async function withBridge(check, dispatch) {
  const loaded = loadBridge();
  const calls = [];
  const clients = new Set();
  const accepted = new Set();
  let absent = false;
  const server = loaded.createBridge({
    token: TOKEN, allowedRemoteRe: /^127\.0\.0\.1$/,
    reloadToken() {
      if (absent) throw Object.assign(new Error('Fixture credential absent'), { code: 'SECRET_NOT_CONFIGURED' });
      return TOKEN;
    },
    logFile: path.join(__dirname, 'not-written-remote-byte-scope.log'),
    async dispatchLine(line, respond, options) {
      const message = JSON.parse(line);
      calls.push({ message, options });
      if (dispatch) await dispatch(message, options);
      respond({ jsonrpc: '2.0', id: message.id, result: { received: true } });
    }
  });
  server.on('connection', socket => { accepted.add(socket); socket.on('close', () => accepted.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await within(once(server, 'listening'));

  async function peer() {
    const connected = once(server, 'connection');
    const socket = net.createConnection(server.address().port, '127.0.0.1');
    clients.add(socket);
    socket.on('error', () => {});
    const [serverSocket] = await within(connected);
    const closed = new Promise(resolve => serverSocket.once('close', resolve));
    let buffer = '';
    const frames = [];
    const waiting = [];
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const frame = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (waiting.length) waiting.shift()(frame); else frames.push(frame);
      }
    });
    const next = () => within(frames.length ? Promise.resolve(frames.shift()) : new Promise(resolve => waiting.push(resolve)));
    const send = message => socket.write(`${JSON.stringify(message)}\n`);
    return {
      socket, closed, send,
      async authorize(token = TOKEN) { send({ type: 'authorize', token }); const reply = await next(); assert.equal(reply.type, 'authorized'); return reply; },
      async call(id, args = {}) { send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'repo.read_file', arguments: args } }); return next(); }
    };
  }
  try { await check({ ...loaded, server, calls, peer, removeCredential: () => { absent = true; } }); }
  finally {
    for (const socket of clients) socket.destroy();
    for (const socket of accepted) socket.destroy();
    if (server.listening) await within(new Promise(resolve => server.close(resolve)));
    await tick();
  }
}

function binding(scope) {
  const value = fileContexts.requireFileToolContext(scope);
  assert.equal(value.scopeKind, 'paired-desktop');
  assert.equal(value.principal, `transport:${value.runtimeScopeId}`);
  assert.equal(value.canonicalLaunchId, null);
  assert.equal(value.laneId, null);
  return value;
}
function revoked(scope) {
  assert.ok(scope, 'an authenticated scope must have existed');
  assert.throws(() => fileContexts.requireFileToolContext(scope), { code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED' });
}

test('unauthenticated and caller-labelled handshakes mint no file authority', async () => {
  await withBridge(async ({ peer, minted, calls }) => {
    for (const handshake of [
      { type: 'authorize', token: 'wrong-fixture-token' },
      { type: 'authorize', token: TOKEN, agentId: 'claimed-controller' }
    ]) {
      const connection = await peer();
      connection.send(handshake);
      await within(connection.closed);
    }
    assert.equal(minted.length, 0);
    assert.equal(calls.length, 0);
  });
});

test('each authenticated socket gets one stable anonymous scope, never a caller-supplied identity', async () => {
  await withBridge(async ({ peer, minted, calls }) => {
    const first = await peer();
    const handshake = await first.authorize();
    const second = await peer();
    await second.authorize();
    assert.equal(minted.length, 2);
    const forged = { binding: { principal: 'agent:claimed-controller' } };
    await first.call(1, { path: 'README.md', fileToolContext: forged, agentId: 'claimed-controller' });
    await first.call(2);
    await second.call(3);
    const firstScope = calls[0].options.fileToolContext;
    const secondScope = calls[2].options.fileToolContext;
    assert.equal(firstScope, calls[1].options.fileToolContext);
    assert.notEqual(firstScope, secondScope);
    assert.notEqual(binding(firstScope).runtimeScopeId, binding(secondScope).runtimeScopeId);
    assert.equal(calls[0].options.agentActor, 'codex', 'provider routing remains separate from file authority');
    assert.equal(calls[0].options.permissionSession.tier, 'guarded');
    assert.equal(Object.hasOwn(calls[0].options, 'agentId'), false);
    assert.equal(JSON.stringify(handshake).includes(binding(firstScope).runtimeScopeId), false, 'private authority must not leak in the handshake');
  });
});

test('disconnect retires only that peer and invokes its registered lease cleanup', async () => {
  await withBridge(async ({ peer, calls }) => {
    const first = await peer(); await first.authorize(); await first.call(1);
    const second = await peer(); await second.authorize(); await second.call(2);
    const firstScope = calls[0].options.fileToolContext;
    const secondScope = calls[1].options.fileToolContext;
    binding(firstScope); binding(secondScope);
    const cleaned = deferred();
    fileContexts.onFileToolContextRetired(firstScope, 'fixture-cleanup', () => cleaned.resolve());
    first.socket.destroy();
    await within(first.closed);
    revoked(firstScope);
    binding(secondScope);
    await within(cleaned.promise);
  });
});

test('token rotation revokes scopes synchronously; identical tokens preserve them and reauthentication gets a new scope', async () => {
  await withBridge(async ({ peer, calls, server }) => {
    const first = await peer(); await first.authorize(); await first.call(1);
    const oldScope = calls[0].options.fileToolContext;
    const oldBinding = binding(oldScope);
    assert.equal(server.rotateBaseToken(TOKEN), false);
    assert.equal(binding(oldScope), oldBinding);
    assert.equal(server.rotateBaseToken(NEXT_TOKEN), true);
    revoked(oldScope);
    await within(first.closed);
    const second = await peer(); await second.authorize(NEXT_TOKEN); await second.call(2);
    assert.notEqual(binding(calls[1].options.fileToolContext).runtimeScopeId, oldBinding.runtimeScopeId);
  });
});

for (const reason of ['disconnect', 'token rotation', 'shutdown']) {
  test(`queued requests cannot dispatch after ${reason}`, async () => {
    const started = deferred();
    const release = deferred();
    try {
      await withBridge(async ({ peer, calls, server }) => {
        const connection = await peer(); await connection.authorize();
        connection.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        connection.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        await within(started.promise);
        const scope = calls[0].options.fileToolContext;
        binding(scope);
        if (reason === 'disconnect') connection.socket.destroy();
        if (reason === 'token rotation') server.rotateBaseToken(NEXT_TOKEN);
        if (reason === 'shutdown') server.close();
        await within(connection.closed);
        revoked(scope);
        release.resolve();
        await tick(); await tick();
        assert.deepEqual(calls.map(call => call.message.id), [1]);
      }, async message => { if (message.id === 1) { started.resolve(); await release.promise; } });
    } finally { release.resolve(); }
  });
}

test('shutdown revokes active scopes immediately and closes authenticated and pre-authentication sockets', async () => {
  await withBridge(async ({ peer, calls, server }) => {
    const first = await peer(); await first.authorize(); await first.call(1);
    const pending = await peer();
    const scope = calls[0].options.fileToolContext;
    binding(scope);
    const closed = new Promise(resolve => server.close(resolve));
    revoked(scope);
    await within(Promise.all([closed, first.closed, pending.closed]));
    assert.equal(server.authorizedSocketCount(), 0);
  });
});

test('confirmed credential removal revokes scopes before asynchronous socket close', async () => {
  await withBridge(async ({ peer, calls, poll, removeCredential }) => {
    const connection = await peer(); await connection.authorize(); await connection.call(1);
    const scope = calls[0].options.fileToolContext;
    binding(scope);
    removeCredential();
    poll(); binding(scope);
    poll(); revoked(scope);
    await within(connection.closed);
  });
});

test('failed durable cleanup never restores file authority or prevents disconnection', async () => {
  await withBridge(async ({ peer, calls, logs }) => {
    const connection = await peer(); await connection.authorize(); await connection.call(1);
    const scope = calls[0].options.fileToolContext;
    binding(scope);
    fileContexts.onFileToolContextRetired(scope, 'fixture-refusal', () => { throw new Error('controlled cleanup failure'); });
    connection.socket.destroy();
    await within(connection.closed);
    await tick();
    revoked(scope);
    assert.ok(logs.some(line => line.includes('file scope cleanup failed')), 'cleanup failure must be observable without reviving the scope');
  });
});

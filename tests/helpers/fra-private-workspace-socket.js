'use strict';

// Real encrypted loopback dispatch into MCP, with a fresh synthetic workspace
// and inert transport audit receipts. No deployed root or owner data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const handlesPath = require.resolve('../../src/lib/providers/fra-workspace-handles');
const handles = require(handlesPath);
const coordination = require('./fra-workspace-authority-fixture');
const { createFullRemoteAccessBridge } = require('../../src/full-remote-access-bridge');
const secure = require('../../src/lib/fra-secure-session');
const bindingTools = require('../../src/lib/fra-transport-binding');
const { bridgeTrustOptions, bindableCapabilityProfile } = require('./fra-binding-fixture');
const mcp = require('../../src/mcp-server');
let activeBroker;
let activeAuthorityFactory;

function bounded(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 12000);
  })]).finally(() => clearTimeout(timer));
}

function messages(socket) {
  let buffer = '';
  const queue = [], waiters = [];
  let ended = null;
  const fail = error => {
    ended = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  socket.setEncoding('utf8');
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('FRA fixture socket closed')));
  socket.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      let value;
      try { value = JSON.parse(buffer.slice(0, end)); }
      catch (error) { fail(error); socket.destroy(); return; }
      buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value); else queue.push(value);
    }
  });
  return () => queue.length ? Promise.resolve(queue.shift())
    : ended ? Promise.reject(ended)
      : bounded(new Promise((resolve, reject) => waiters.push({ resolve, reject })), 'FRA response');
}

async function fixture(t, files) {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-socket-owned-'));
  const root = path.join(owned, 'workspace');
  const clients = [];
  let server;
  const priorExports = require.cache[handlesPath].exports;
  t.after(async () => {
    try {
      server?.destroySessions('synthetic-fixture-finished');
      for (const { socket, session } of clients) { session?.close(); socket.destroy(); }
      if (server?.listening) await bounded(new Promise(resolve => server.close(resolve)), 'listener close');
      if (server) await bounded(server.waitForFileScopeRetirements(), 'scope retirement');
      await coordination.retire();
    } finally {
      require.cache[handlesPath].exports = priorExports;
      fs.rmSync(owned, { recursive: true, force: true });
      assert.equal(fs.existsSync(owned), false, 'only this run\'s synthetic directory was removed');
      t.diagnostic(JSON.stringify({ fixtureRoot: owned, cleanupAssertedAbsent: true }));
    }
  });
  fs.mkdirSync(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const registry = { schemaVersion: 1, machines: {
    left: { address: '203.0.113.1' }, right: { address: '203.0.113.2' }
  }, services: {} };
  const audits = [];
  const auditApi = { requireRecord: (...args) => { audits.push(args); return { durable: true, anchored: true }; } };
  const authorityFactory = coordination.authorityFactory(path.join(owned, 'coordination'));
  const broker = new handles.FraWorkspaceHandleBroker({ root, serviceRegistryOptions: { registry }, auditApi });
  activeBroker = broker;
  activeAuthorityFactory = authorityFactory;
  // The registry memoizes this provider facade. Keep its dispatch target fresh
  // across serial fixtures instead of leaving later tests bound to a retired root.
  require.cache[handlesPath].exports = Object.freeze({ ...handles,
    list: (...args) => activeBroker.list(...args),
    read: (args, context) => activeBroker.read(args, context, activeAuthorityFactory),
    closeSession: (...args) => activeBroker.closeSession(...args)
  });
  const masterKey = secure.deriveMasterKey('inert-synthetic-FRA-audit-loopback-test');
  const profile = bindableCapabilityProfile({ allowedTools: ['workspace.list', 'workspace.read'] });
  server = createFullRemoteAccessBridge({ ...bridgeTrustOptions(), host: '203.0.113.2', masterKey,
    serviceRegistryOptions: { registry }, allowedRemoteRe: /^127\.0\.0\.1$/, capabilityProfile: profile,
    reloadToken: null, logFile: path.join(owned, 'bridge.log'),
    inboundReceiptWriter() {}, inboundLivenessWriter() {}, auditApi,
    dispatchLine: (line, respond, options) => mcp.processLine(line, respond, options)
  });
  await bounded(new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  }), 'listener start');

  async function connect() {
    const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
    const client = { socket, session: null };
    clients.push(client);
    const next = messages(socket);
    await bounded(new Promise((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', reject);
    }), 'FRA connect');
    const handshake = secure.beginClientHandshake({ masterKey, challenge: await next(),
      serverHost: '203.0.113.2', clientHost: '203.0.113.1', serviceRegistryOptions: { registry } });
    socket.write(JSON.stringify(handshake.response) + '\n');
    const session = client.session = handshake.complete(await next());
    const binding = JSON.parse(session.open(await next()));
    socket.write(JSON.stringify(session.seal(JSON.stringify(bindingTools.createBindingAcceptance(binding)))) + '\n');
    assert.equal(JSON.parse(session.open(await next())).type, 'fra.authorization-audited');
    let id = 1;
    return async (name, args) => {
      const request = bindingTools.createBoundRequest({ jsonrpc: '2.0', id: id++, method: 'tools/call',
        params: { name, arguments: args } }, binding.contextDigest);
      socket.write(JSON.stringify(session.seal(JSON.stringify(request))) + '\n');
      return bindingTools.validateBoundResponse(JSON.parse(session.open(await next())), {
        requestEnvelope: request, allowedTools: profile.allowedTools
      }).response;
    };
  }
  return { owned, root, broker, audits, connect };
}

module.exports = { fixture };

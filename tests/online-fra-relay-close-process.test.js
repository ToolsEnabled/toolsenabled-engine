'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Actual CLI, actual Node WebSocket and TCP. Only account/vault/peer setup is
// replaced by a local fixture. The edge accepts the upgrade but deliberately
// never acknowledges the close frame. No hosted account or owner profile is
// used. A timeout must terminate this exact child, not manufacture a close
// receipt and open a second connection beside the first one.
test('stalled real WebSocket close ends the relay child before any replacement connection', { timeout: 18000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-relay-close-'));
  fs.chmodSync(temporary, 0o700);
  const sockets = new Set(); let upgrades = 0;
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    upgrades++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.on('data', () => {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const relayUrl = 'ws://127.0.0.1:' + server.address().port;
  const entry = path.resolve(__dirname, '../tools/relay-shell.js');
  const preload = path.join(temporary, 'fixture.cjs');
  fs.writeFileSync(preload, `
    const { createRequire } = require('node:module');
    const req = createRequire(${JSON.stringify(entry)});
    const stub = (name, exports) => { const id = req.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; };
    stub('../src/lib/runtime', { getSecret() { throw Error('fixture vault must not be read'); }, setSecret() { throw Error('fixture vault must not be written'); } });
    stub('../src/lib/online-fra-local-bridge', { createLocalBridge() { return {}; } });
    stub('../src/lib/online-fra-composite-bridge', { facadeFromEnvironment() { return { origin: null, token: null }; }, createCompositeBridge() { return {}; } });
    const { connectOnlineFraRelay } = req('../src/lib/online-fra-relay-client');
    let connections = 0;
    stub('../src/lib/online-fra-relay-shell', { createRelayShell() { return { async connectToPeer() {
      console.log('fixture-connect=' + ++connections);
      const connection = await connectOnlineFraRelay({ url: ${JSON.stringify(relayUrl)}, lease: { signature: 'isolated-fixture', endpointRole: 'machine-a' }, onFrame() {} });
      return { role: 'machine-a', solo: true, handshake: Promise.resolve({ solo: true }),
        leaseExpiresAtMs: Date.now() + 30001, closed: connection.closed,
        close() { console.log('fixture-close-request'); connection.close(); },
        async renewLease() { throw Object.assign(new Error('fixture unsupported'), { code: 'RELAY_SHELL_RENEWAL_UNSUPPORTED' }); }
      };
    } }; } });
  `);
  let child;
  try {
    child = spawn(process.execPath, ['--require', preload, entry], { cwd: temporary, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const [code, signal] = await once(child, 'exit'); clearTimeout(timer);
    assert.equal(signal, null, 'the CLI itself must end its unconfirmed relay child');
    assert.equal(code, 1);
    assert.match(stderr, /RELAY_SHELL_CLOSE_UNCONFIRMED/);
    assert.doesNotMatch(stderr, /\] session closed/);
    assert.equal(upgrades, 1);
    assert.equal((stdout.match(/fixture-connect=/g) || []).length, 1);
    assert.equal((stdout.match(/fixture-close-request/g) || []).length, 1);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

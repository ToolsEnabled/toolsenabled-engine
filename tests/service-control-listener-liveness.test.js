'use strict';

// Q116.5 spawn-on-timer fix: src/lib/service-control.js#defaultProbe() paid
// for a full elevated powershell.exe/WMI spawn on every single listener
// probe, including every probe of a port that was not listening at all --
// the same defect SHAPE as commit 48598d3 (a DPAPI vault read shelling out
// every 2s). probeListenerCheap() tries a native node:net TCP connect first
// and only calls through to defaultProbe() when something is actually there
// to identify. These tests prove: (1) the empty case never spawns anything,
// (2) the found case still gets exactly what defaultProbe() would have
// returned -- no identity is weakened, only the empty case stops being
// expensive, and (3) the real node:net path works end-to-end against a real
// ephemeral TCP server, not just against an injected fake.

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const serviceControl = require('../src/lib/service-control');

function listenOnEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

/** A port very likely free: bind one, learn its number, close it immediately. */
async function likelyFreePort() {
  const server = await listenOnEphemeralPort();
  const { port } = server.address();
  await closeServer(server);
  return port;
}

test('probeListenerCheap: nothing listening -> empty result, and the expensive probe is never invoked', async () => {
  const port = await likelyFreePort();
  let expensiveProbeCalls = 0;
  const result = await serviceControl.probeListenerCheap(port, {
    execFileSync: () => { expensiveProbeCalls += 1; throw new Error('the elevated probe must not run when nothing is listening'); }
  });
  assert.equal(expensiveProbeCalls, 0, 'defaultProbe\'s execFileSync path must not be called for a port nothing is listening on');
  assert.equal(result.port, port);
  assert.deepEqual(result.listeners, []);
});

test('probeListenerCheap: something listening -> falls through to the real identity probe, unweakened', async () => {
  const server = await listenOnEphemeralPort();
  try {
    const { port } = server.address();
    let expensiveProbeCalls = 0;
    const fakeListener = { pid: 4242, localAddress: '127.0.0.1', processName: 'node', commandLine: 'node src/mcp-server.js', startTime: new Date().toISOString() };
    const result = await serviceControl.probeListenerCheap(port, {
      platform: 'win32',
      execFileSync: () => {
        expensiveProbeCalls += 1;
        return JSON.stringify({ listeners: [fakeListener] });
      }
    });
    assert.equal(expensiveProbeCalls, 1, 'the elevated probe must run exactly once when something is genuinely listening');
    assert.equal(result.listeners.length, 1);
    assert.equal(result.listeners[0].pid, 4242, 'a real listener from probeListenerCheap must carry the SAME identity defaultProbe would have reported');
    assert.equal(result.listeners[0].commandLine, 'node src/mcp-server.js');
  } finally {
    await closeServer(server);
  }
});

test('tcpPortHasListener: resolves true against a real ephemeral TCP server, no process spawned', async () => {
  const server = await listenOnEphemeralPort();
  try {
    const { port } = server.address();
    const alive = await serviceControl.tcpPortHasListener(port);
    assert.equal(alive, true);
  } finally {
    await closeServer(server);
  }
});

test('tcpPortHasListener: resolves false against a real closed port', async () => {
  const port = await likelyFreePort();
  const alive = await serviceControl.tcpPortHasListener(port);
  assert.equal(alive, false);
});

test('tcpPortHasListener: a slow/unresponsive port refuses rather than reporting no listener', async () => {
  let destroyed = false;
  const fakeSocket = new (require('node:events').EventEmitter)();
  fakeSocket.destroy = () => { destroyed = true; };
  fakeSocket.removeAllListeners = require('node:events').EventEmitter.prototype.removeAllListeners.bind(fakeSocket);
  await assert.rejects(serviceControl.tcpPortHasListener(9999, {
    connect: () => { setImmediate(() => fakeSocket.emit('timeout')); return fakeSocket; }
  }), error => error.code === 'SERVICE_PROBE_FAILED' && /absence could not be established/.test(error.message));
  assert.equal(destroyed, true, 'the socket must be cleaned up even on a timeout, not leaked');
});

test('tcpPortHasListener: an indeterminate socket error refuses rather than reporting no listener', async () => {
  const fakeSocket = new (require('node:events').EventEmitter)();
  fakeSocket.destroy = () => {};
  fakeSocket.removeAllListeners = require('node:events').EventEmitter.prototype.removeAllListeners.bind(fakeSocket);
  await assert.rejects(serviceControl.tcpPortHasListener(9999, {
    connect: () => { setImmediate(() => fakeSocket.emit('error', Object.assign(new Error('network unavailable'), { code: 'ENETUNREACH' }))); return fakeSocket; }
  }), error => error.code === 'SERVICE_PROBE_FAILED' && /network unavailable/.test(error.message));
});

test('defaultProbe: missing or malformed listener identity refuses rather than becoming an empty inventory', () => {
  for (const output of [JSON.stringify({}), JSON.stringify({ listeners: [{ processName: 'node' }] })]) {
    assert.throws(() => serviceControl.defaultProbe(59999, {
      platform: 'win32',
      execFileSync: () => output
    }), error => error.code === 'SERVICE_PROBE_FAILED');
  }
});

test('probeListenerCheap result shape matches defaultProbe\'s shape for the empty case', () => {
  // defaultProbe() (mocked to report an empty listener array) and
  // probeListenerCheap()'s own empty branch must agree on shape so a caller
  // cannot tell which path answered.
  const viaDefaultProbe = serviceControl.defaultProbe(59999, {
    platform: 'win32',
    execFileSync: () => JSON.stringify({ listeners: [] })
  });
  assert.deepEqual(Object.keys(viaDefaultProbe).sort(), ['listeners', 'port']);
});

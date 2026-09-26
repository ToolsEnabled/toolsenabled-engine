'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const {
  createBridge, validAuthorize, ALLOWED_REMOTE_RE,
  createLocalHealthServer, computeRemoteProfileAllowlist,
  EXCLUDED_NAMESPACES_FROM_REMOTE, EXCLUDED_TOOLS_FROM_REMOTE,
  REGISTERED_TOOL_NAMES, bridgeIdentity, internalErrorResponse, normalizeBridgeRequest, safeMethodDiagnostic,
  generateStrongToken, fingerprintToken, rotateVaultToken, NEW_TOKEN_BYTES, resolveBridgeTopology
} = require('../src/remote-agent-bridge');

function connectAndRead(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, host);
    socket.setEncoding('utf8');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function readOneLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        socket.removeListener('data', onData);
        resolve(JSON.parse(buffer.slice(0, end)));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function readLines(socket, count) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const lines = [];
    const onData = chunk => {
      buffer += chunk;
      while (true) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        lines.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
        if (lines.length === count) {
          socket.removeListener('data', onData);
          resolve(lines);
          return;
        }
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function expectNoData(socket, timeoutMs = 80) {
  return new Promise((resolve, reject) => {
    const onData = data => {
      clearTimeout(timer);
      reject(new Error(`unexpected bridge response: ${String(data).slice(0, 80)}`));
    };
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      resolve();
    }, timeoutMs);
    socket.once('data', onData);
  });
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const request = require('node:http').get(`http://127.0.0.1:${port}/health`, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.once('error', reject);
  });
}

async function run() {
  const token = crypto.randomBytes(24).toString('base64url');
  const tokenBuffer = Buffer.from(token, 'utf8');
  const ordinaryLanRegistry = {
    schemaVersion: 1,
    machines: { 'machine-a': { address: '10.0.0.5' }, 'machine-b': { address: '10.0.0.6' } },
    services: {}
  };
  const topology = resolveBridgeTopology({
    configuredHost: '10.0.0.5', serviceRegistryOptions: { registry: ordinaryLanRegistry }
  });
  assert.equal(topology.host, '10.0.0.5');
  assert.equal(topology.peerHost, '10.0.0.6');
  assert.equal(topology.allowedRemoteRe.test('10.0.0.6'), true);
  assert.equal(topology.allowedRemoteRe.test('10.0.0.7'), false);
  assert.throws(
    () => resolveBridgeTopology({
      configuredHost: '10.0.0.7', serviceRegistryOptions: { registry: ordinaryLanRegistry }
    }),
    error => error.code === 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED'
  );

  // --- validAuthorize unit checks ---
  assert.equal(validAuthorize({ type: 'authorize', token }, tokenBuffer), true);
  assert.equal(validAuthorize({ type: 'authorize', token: 'wrong' }, tokenBuffer), false);
  assert.equal(validAuthorize({ type: 'authorize', token, extra: 1 }, tokenBuffer), false);
  assert.equal(validAuthorize({ type: 'other', token }, tokenBuffer), false);
  assert.equal(validAuthorize(null, tokenBuffer), false);
  assert.equal(REGISTERED_TOOL_NAMES.has('system.status'), true);
  assert.deepEqual(bridgeIdentity(), {
    type: 'authorized', protocolVersion: 1, bridgeRoot: require('node:path').resolve(__dirname, '..'),
    workingDirectory: process.cwd(), rootExists: true
  });
  assert.deepEqual(JSON.parse(normalizeBridgeRequest(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'system.status', params: { marker: 'ignored-by-bridge' } }))), {
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'system.status', arguments: { marker: 'ignored-by-bridge' } }
  });
  const unknownLine = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'unknown.method', params: {} });
  assert.equal(normalizeBridgeRequest(unknownLine), unknownLine, 'only exact registered tools are direct-method normalized');
  assert.deepEqual(internalErrorResponse(JSON.stringify({ id: { unsafe: true } })), { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error.' } });
  assert.deepEqual(internalErrorResponse(JSON.stringify({ id: 'safe-id' })), { jsonrpc: '2.0', id: 'safe-id', error: { code: -32603, message: 'Internal error.' } });
  assert.equal(safeMethodDiagnostic(JSON.stringify({ method: 'system.status', params: { secret: 'not-logged' } })), 'system.status');
  assert.equal(safeMethodDiagnostic(JSON.stringify({ method: 'bad\nmethod' })), 'invalid');
  console.log('remote-agent-bridge validAuthorize tests passed.');

  // --- remote-address gate ---
  {
    const server = createBridge({ token: tokenBuffer, allowedRemoteRe: /^NEVER_MATCHES$/, logFile: require('node:path').join(require('node:os').tmpdir(), 'rab-test.log') });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const socket = await connectAndRead(port);
      const closed = new Promise(resolve => socket.once('close', resolve));
      socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      await closed; // must be destroyed with no response at all
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge remote-address gate test passed.');

  // --- happy path: authorize, then dispatch is called with agentActor hardcoded to 'codex' ---
  {
    const dispatchCalls = [];
    const fakeDispatch = async (line, respond, options) => {
      dispatchCalls.push({ line, options });
      const message = JSON.parse(line);
      respond({ jsonrpc: '2.0', id: message.id, result: { echoedActor: options.agentActor } });
    };
    const server = createBridge({
      token: tokenBuffer, allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile: require('node:path').join(require('node:os').tmpdir(), 'rab-test-2.log'),
      dispatchLine: fakeDispatch
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const socket = await connectAndRead(port);
      socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      const authAck = await readOneLine(socket);
      assert.equal(authAck.type, 'authorized');
      assert.equal(authAck.protocolVersion, 1);
      assert.equal(typeof authAck.bridgeRoot, 'string');
      assert.equal(typeof authAck.workingDirectory, 'string');
      assert.equal(authAck.rootExists, true);

      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
      const reply = await readOneLine(socket);
      assert.equal(reply.result.echoedActor, 'codex');
      // Even though the fake dispatch never looked at a client-supplied actor,
      // confirm the bridge never accepted or forwarded one -- it always hardcodes it.
      assert.equal(dispatchCalls.length, 1);
      assert.equal(dispatchCalls[0].options.agentActor, 'codex');
      assert.ok(!Object.prototype.hasOwnProperty.call(dispatchCalls[0].options, 'actor'));

      socket.destroy();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge authorize + dispatch happy-path test passed.');

  // --- direct registered tool method compatibility stays on tools/call ---
  {
    const dispatchCalls = [];
    const server = createBridge({
      token: tokenBuffer, allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile: require('node:path').join(require('node:os').tmpdir(), 'rab-direct-method.log'),
      dispatchLine: async (line, respond) => {
        const request = JSON.parse(line);
        dispatchCalls.push(request);
        respond({ jsonrpc: '2.0', id: request.id, result: { method: request.method, name: request.params.name, arguments: request.params.arguments } });
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const socket = await connectAndRead(server.address().port);
      socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      await readOneLine(socket);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'direct', method: 'system.status', params: { bounded: true } })}\n`);
      const reply = await readOneLine(socket);
      assert.deepEqual(reply.result, { method: 'tools/call', name: 'system.status', arguments: { bounded: true } });
      assert.deepEqual(dispatchCalls[0], { jsonrpc: '2.0', id: 'direct', method: 'tools/call', params: { name: 'system.status', arguments: { bounded: true } } });
      socket.destroy();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge direct-method normalization test passed.');

  // --- unexpected dispatch failure is opaque and does not end the session ---
  {
    const marker = 'PRIVATE-ARGUMENT-OR-EXCEPTION-MARKER-923847';
    const logFile = require('node:path').join(require('node:os').tmpdir(), `rab-opaque-${process.pid}.log`);
    try { require('node:fs').unlinkSync(logFile); } catch {}
    let calls = 0;
    const server = createBridge({
      token: tokenBuffer, allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile,
      dispatchLine: async (line, respond) => {
        calls += 1;
        const request = JSON.parse(line);
        if (calls === 1) throw new Error(marker);
        respond({ jsonrpc: '2.0', id: request.id, result: { recovered: true } });
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const socket = await connectAndRead(server.address().port);
      socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      await readOneLine(socket);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: { unsafe: marker }, method: 'tools/list', params: { argument: marker } })}\n`);
      assert.deepEqual(await readOneLine(socket), { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error.' } });
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'after-rejection', method: 'tools/list', params: {} })}\n`);
      assert.deepEqual(await readOneLine(socket), { jsonrpc: '2.0', id: 'after-rejection', result: { recovered: true } });
      socket.destroy();
      assert.equal(require('node:fs').readFileSync(logFile, 'utf8').includes(marker), false, 'bridge diagnostics never log arguments or exception messages');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge opaque-rejection session-recovery test passed.');

  // --- a rejecting JSON-RPC notification emits no response ---
  {
    let dispatches = 0;
    const server = createBridge({
      token: tokenBuffer, allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile: require('node:path').join(require('node:os').tmpdir(), 'rab-notification-reject.log'),
      dispatchLine: async (line, respond) => {
        dispatches += 1;
        const request = JSON.parse(line);
        if (!Object.prototype.hasOwnProperty.call(request, 'id')) throw new Error('notification rejection must stay silent');
        respond({ jsonrpc: '2.0', id: request.id, result: { sessionAlive: true } });
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const socket = await connectAndRead(server.address().port);
      socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      await readOneLine(socket);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      await expectNoData(socket);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'after-notification', method: 'tools/list', params: {} })}\n`);
      assert.deepEqual(await readOneLine(socket), { jsonrpc: '2.0', id: 'after-notification', result: { sessionAlive: true } });
      assert.equal(dispatches, 2);
      socket.destroy();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge rejecting-notification silence test passed.');

  // --- a response followed by rejection does not produce a second reply ---
  {
    let dispatches = 0;
    const server = createBridge({
      token: tokenBuffer, allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile: require('node:path').join(require('node:os').tmpdir(), 'rab-response-then-reject.log'),
      dispatchLine: async (line, respond) => {
        dispatches += 1;
        const request = JSON.parse(line);
        respond({ jsonrpc: '2.0', id: request.id, result: { ordinal: dispatches } });
        if (dispatches === 1) throw new Error('post-response rejection');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const socket = await connectAndRead(server.address().port);
      socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      await readOneLine(socket);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'responded-first', method: 'tools/list', params: {} })}\n`);
      assert.deepEqual(await readOneLine(socket), { jsonrpc: '2.0', id: 'responded-first', result: { ordinal: 1 } });
      await expectNoData(socket);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'still-ordered', method: 'tools/list', params: {} })}\n`);
      assert.deepEqual(await readOneLine(socket), { jsonrpc: '2.0', id: 'still-ordered', result: { ordinal: 2 } });
      assert.equal(dispatches, 2);
      socket.destroy();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge response-then-reject single-reply test passed.');

  // --- unknown methods stay -32601, including unsafe request IDs ---
  {
    const { processLine } = require('../src/mcp-server');
    const server = createBridge({ token: tokenBuffer, allowedRemoteRe: /^127\.0\.0\.1$/, logFile: require('node:path').join(require('node:os').tmpdir(), 'rab-unknown.log'), dispatchLine: processLine });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const socket = await connectAndRead(server.address().port);
      socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      await readOneLine(socket);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'unknown.method', params: {} })}\n`);
      const knownId = await readOneLine(socket);
      assert.equal(knownId.id, 12);
      assert.equal(knownId.error.code, -32601);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: { no: 'echo' }, method: 'unknown.method', params: {} })}\n`);
      const unsafeId = await readOneLine(socket);
      assert.equal(unsafeId.id, null);
      assert.equal(unsafeId.error.code, -32601);
      socket.destroy();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge unknown-method and ID-sanitization tests passed.');

  // --- wrong token never reaches dispatch, connection is destroyed silently ---
  {
    let dispatchCalled = false;
    const server = createBridge({
      token: tokenBuffer, allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile: require('node:path').join(require('node:os').tmpdir(), 'rab-test-3.log'),
      dispatchLine: async () => { dispatchCalled = true; }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const socket = await connectAndRead(port);
      const closed = new Promise(resolve => socket.once('close', resolve));
      socket.write(`${JSON.stringify({ type: 'authorize', token: 'totally-wrong' })}\n`);
      await closed;
      assert.equal(dispatchCalled, false);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge wrong-token rejection test passed.');

  // --- vault-token hot reload requires two CONSECUTIVE confirming polls,
  // then rotates the accepted token AND closes every already-authenticated
  // socket (R1162 N3). A single differing read must not tear a live session
  // down (transient/torn vault read protection); a confirmed rotation must
  // not leave a pre-rotation session standing (the actual N3 fix). ---
  {
    const rotatedToken = crypto.randomBytes(24).toString('base64url');
    let vaultToken = tokenBuffer;
    const server = createBridge({
      token: tokenBuffer, reloadToken: () => vaultToken,
      allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile: require('node:path').join(require('node:os').tmpdir(), 'rab-token-reload.log'),
      dispatchLine: async () => {}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      // A socket that authorized under the ORIGINAL token, before rotation.
      const liveSocket = await connectAndRead(server.address().port);
      liveSocket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      assert.equal((await readOneLine(liveSocket)).type, 'authorized');
      assert.equal(server.authorizedSocketCount(), 1);
      const liveClosed = new Promise(resolve => liveSocket.once('close', resolve));

      vaultToken = Buffer.from(rotatedToken, 'utf8');
      // One differing poll (~2s tick) must NOT rotate yet: the live socket
      // stays open and the OLD token is still accepted for a fresh connect.
      await new Promise(resolve => setTimeout(resolve, 2100));
      assert.equal(liveSocket.destroyed, false, 'a single differing poll must not rotate yet');
      const stillOldSocket = await connectAndRead(server.address().port);
      stillOldSocket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      assert.equal((await readOneLine(stillOldSocket)).type, 'authorized', 'old token still accepted before the second confirming poll');
      stillOldSocket.destroy();

      // The second consecutive poll confirms the same replacement value and
      // commits the rotation: the pre-rotation live socket is closed...
      await new Promise(resolve => setTimeout(resolve, 2100));
      await liveClosed;
      assert.equal(server.authorizedSocketCount(), 0);
      assert.equal(server.rotationState().generation, 1);
      assert.equal(server.rotationState().socketsClosedOnLastRotation, 1);

      // ...a NEW connection with the OLD token is now refused...
      const oldSocket = await connectAndRead(server.address().port);
      const oldClosed = new Promise(resolve => oldSocket.once('close', resolve));
      oldSocket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      await oldClosed;

      // ...and a NEW connection with the ROTATED token succeeds.
      const newSocket = await connectAndRead(server.address().port);
      newSocket.write(`${JSON.stringify({ type: 'authorize', token: rotatedToken })}\n`);
      assert.equal((await readOneLine(newSocket)).type, 'authorized');
      assert.equal(server.authorizedSocketCount(), 1);
      newSocket.destroy();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge hot-token-reload (two-poll-confirm + authenticated-socket close) test passed.');

  // --- server.rotateBaseToken(): rotates immediately with no polling delay,
  // and is a no-op (returns false, closes nothing) for the identical token. ---
  {
    const rotatedToken = crypto.randomBytes(24).toString('base64url');
    const server = createBridge({
      token: tokenBuffer, allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile: require('node:path').join(require('node:os').tmpdir(), 'rab-explicit-rotate.log'),
      dispatchLine: async () => {}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const socket = await connectAndRead(server.address().port);
      socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      assert.equal((await readOneLine(socket)).type, 'authorized');
      const closed = new Promise(resolve => socket.once('close', resolve));

      assert.equal(server.rotateBaseToken(tokenBuffer), false, 'rotating to the identical token is a no-op');
      assert.equal(server.authorizedSocketCount(), 1);
      assert.equal(socket.destroyed, false);

      assert.equal(server.rotateBaseToken(Buffer.from(rotatedToken, 'utf8')), true);
      await closed;
      assert.equal(server.authorizedSocketCount(), 0);
      assert.equal(server.rotationState().generation, 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge explicit rotateBaseToken() immediate-close test passed.');

  // --- rotateVaultToken(): mints a strong token and writes it through the
  // injected vault writer only -- no real vault or subprocess is touched. ---
  {
    const currentToken = Buffer.from(token, 'utf8');
    let written = null;
    const result = await rotateVaultToken({
      loadCurrent: () => Buffer.from(currentToken),
      writeToken: async next => { written = next; }
    });
    assert.equal(result.ok, true);
    assert.equal(result.vaultKey, 'custom.remote_agent_bridge_token');
    assert.equal(result.previousTokenSha256, fingerprintToken(currentToken));
    assert.equal(typeof written, 'string');
    assert.equal(fingerprintToken(written), result.newTokenSha256);
    assert.notEqual(written, token, 'a freshly generated token must not equal the current one');
    assert.equal(result.secretValuesEmitted, false);
    assert.equal(JSON.stringify(result).includes(written), false, 'the raw new token must never appear in the reported result');
  }
  console.log('remote-agent-bridge rotateVaultToken() injected-writer test passed.');

  // --- generateStrongToken(): satisfies the bridge's own TOKEN_RE shape and
  // is not a fixed/predictable value across calls. ---
  {
    const first = generateStrongToken();
    const second = generateStrongToken();
    assert.equal(typeof first, 'string');
    assert.ok(first.length >= 16 && first.length <= 4096);
    assert.notEqual(first, second);
    assert.equal(Buffer.from(first, 'base64url').length, NEW_TOKEN_BYTES);
  }
  console.log('remote-agent-bridge generateStrongToken() shape test passed.');

  // --- peer address pinned to machine B's exact IP, not the whole /24 ---
  // A review (2026-07-30) noted the original pattern accepted any host on
  // the segment.
  // The shipped one-machine default has no declared peer. Its compatibility
  // matcher must therefore admit nobody; the positive exact-peer behavior is
  // exercised above through resolveBridgeTopology's synthetic two-machine
  // registry rather than smuggling a builder-specific address into the test.
  assert.equal(ALLOWED_REMOTE_RE.test('192.0.2.10'), false, 'a fresh one-machine install admits no undeclared peer');
  assert.equal(ALLOWED_REMOTE_RE.test('192.0.2.11'), false, 'a plausible second machine is not authority to connect');
  assert.equal(ALLOWED_REMOTE_RE.test('203.0.113.50'), false, 'another host on any subnet must not be accepted');
  console.log('remote-agent-bridge peer-pinning test passed.');

  // --- connection-scoped queue: regression test for a real deadlock bug ---
  // The original `serial` promise chain was declared OUTSIDE the connection
  // callback (server-scoped), so one slow/pending call on connection A
  // stalled every call on connection B too. This proves two connections now
  // progress independently: B's call resolves while A's is still pending.
  {
    let releaseA;
    const aGate = new Promise(resolve => { releaseA = resolve; });
    const dispatchOrder = [];
    const dispatch = async (line, respond) => {
      const message = JSON.parse(line);
      dispatchOrder.push(message.params && message.params.name);
      if (message.params && message.params.name === 'slow') {
        await aGate;
        respond({ jsonrpc: '2.0', id: message.id, result: { who: 'A' } });
      } else {
        respond({ jsonrpc: '2.0', id: message.id, result: { who: 'B' } });
      }
    };
    const server = createBridge({
      token: tokenBuffer, allowedRemoteRe: /^127\.0\.0\.1$/,
      logFile: require('node:path').join(require('node:os').tmpdir(), 'rab-test-4.log'),
      dispatchLine: dispatch
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const socketA = await connectAndRead(port);
      socketA.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      await readOneLine(socketA);
      socketA.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, params: { name: 'slow' } })}\n`); // never resolves until releaseA()
      socketA.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, params: { name: 'after-slow' } })}\n`);

      const socketB = await connectAndRead(port);
      socketB.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
      await readOneLine(socketB);
      socketB.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, params: { name: 'fast' } })}\n`);
      // If the queue were still server-scoped, this would hang until
      // releaseA() fires -- it must resolve on its own right away instead.
      const replyB = await Promise.race([
        readOneLine(socketB),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out -- connection B was blocked by connection A (server-scoped queue regression)')), 3000))
      ]);
      assert.equal(replyB.result.who, 'B');
      assert.equal(dispatchOrder.includes('after-slow'), false, 'later calls on one socket stay behind its pending call');
      const repliesA = readLines(socketA, 2);
      releaseA();
      const [replyA, replyAfterA] = await repliesA;
      assert.equal(replyA.result.who, 'A');
      assert.equal(replyAfterA.result.who, 'B');
      assert.deepEqual(dispatchOrder, ['slow', 'fast', 'after-slow']);
      socketA.destroy();
      socketB.destroy();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('remote-agent-bridge connection-scoped-queue regression test passed.');

  // --- loopback dispatcher health surface ---
  {
    const health = createLocalHealthServer({
      dispatchLine: async (line, respond) => {
        const request = JSON.parse(line);
        respond({ jsonrpc: '2.0', id: request.id, result: { tools: [] } });
      }
    });
    await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
    const port = health.address().port;
    try {
      const response = await getHealth(port);
      assert.equal(response.status, 200);
      assert.equal(response.body.schemaVersion, 'remote-agent-bridge-health.v1');
      assert.equal(response.body.ok, true);
      assert.equal(response.body.dispatcherHealthy, true);
      assert.equal(response.body.responseReceived, true);
      assert.equal(response.body.dispatchSucceeded, true);
    } finally {
      await new Promise(resolve => health.close(resolve));
    }
  }
  console.log('remote-agent-bridge loopback health surface test passed.');

  // --- a JSON-RPC error response is a failed dispatcher health probe ---
  {
    const health = createLocalHealthServer({
      dispatchLine: async (line, respond) => {
        const request = JSON.parse(line);
        respond({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'probe failed' } });
      }
    });
    await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
    const port = health.address().port;
    try {
      const response = await getHealth(port);
      assert.equal(response.status, 503);
      assert.equal(response.body.ok, false);
      assert.equal(response.body.dispatcherHealthy, false);
      assert.equal(response.body.responseReceived, true);
      assert.equal(response.body.dispatchSucceeded, false);
    } finally {
      await new Promise(resolve => health.close(resolve));
    }
  }
  console.log('remote-agent-bridge dispatcher-error health regression test passed.');

  // --- timed-out health dispatch remains gated until its promise settles ---
  {
    let dispatches = 0;
    let settleFirst;
    const health = createLocalHealthServer({
      timeoutMs: 25,
      dispatchLine: (line, respond) => {
        dispatches += 1;
        if (dispatches === 1) return new Promise(resolve => { settleFirst = resolve; });
        const request = JSON.parse(line);
        respond({ jsonrpc: '2.0', id: request.id, result: { tools: [] } });
        return Promise.resolve();
      }
    });
    await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
    const port = health.address().port;
    try {
      const first = await getHealth(port);
      assert.equal(first.status, 503);
      assert.equal(dispatches, 1);
      const second = await getHealth(port);
      assert.equal(second.status, 503);
      assert.equal(dispatches, 1, 'a timed-out unresolved dispatcher is not duplicated');
      settleFirst();
      await new Promise(resolve => setImmediate(resolve));
      const recovered = await getHealth(port);
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.dispatcherHealthy, true);
      assert.equal(dispatches, 2, 'eventual settlement permits one fresh probe');
    } finally {
      await new Promise(resolve => health.close(resolve));
    }
  }
  console.log('remote-agent-bridge unresolved-health-dispatch gate test passed.');

  // --- profile allowlist: whole namespaces excluded, one tool excluded from an included namespace ---
  const fakeRegistry = [
    { name: 'clipboard.read', effect: 'local-read' }, { name: 'clipboard.write', effect: 'local-write' },
    { name: 'screen.capture', effect: 'local-read' }, { name: 'screen.read_capture', effect: 'local-read' },
    { name: 'ocr.read', effect: 'local-read' },
    { name: 'host.exec', effect: 'local-write' }, { name: 'host.read_file', effect: 'local-read' }, { name: 'host.write_file', effect: 'local-write' }, { name: 'host.list_dir', effect: 'local-read' }, { name: 'host.list_processes', effect: 'local-read' },
    { name: 'repo.read_file', effect: 'local-read' }, { name: 'repo.write_file', effect: 'local-write' }, { name: 'repo.list_dir', effect: 'local-read' },
    { name: 'system.status', effect: 'local-read' }
  ];
  const computed = computeRemoteProfileAllowlist(fakeRegistry);
  const selectors = computed.split(',');
  assert.ok(selectors.includes('clipboard.read'), 'Guarded policy follows the declared read effect, not a namespace list');
  assert.ok(selectors.includes('screen.capture'), 'Guarded policy follows the declared read effect');
  assert.ok(selectors.includes('ocr.read'), 'Guarded policy follows the declared read effect');
  assert.ok(!selectors.includes('host.exec'), 'host.exec specifically must never appear');
  assert.ok(!selectors.includes('host.write_file'), 'local writes are excluded by effect');
  for (const hostTool of ['host.read_file', 'host.list_dir', 'host.list_processes']) {
    assert.ok(selectors.includes(hostTool), `${hostTool} must be individually included`);
  }
  assert.ok(!selectors.includes('repo.write_file'), 'repo local writes are excluded by effect');
  assert.ok(selectors.includes('repo.read_file') && selectors.includes('repo.list_dir'), 'repo reads remain available');
  assert.ok(selectors.includes('system.status'), 'system reads remain available');
  // Confirm this actually validates against the real tool-registry.js selector grammar.
  const { parseToolAllowlist } = require('../src/lib/tool-registry');
  assert.doesNotThrow(() => parseToolAllowlist(computed));
  // And against the REAL, full registry (not the fake one above) -- proves
  // the exclusion sets name real namespaces/tools that actually exist today.
  const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
  const realComputed = computeRemoteProfileAllowlist(TOOL_REGISTRY);
  const realSelectors = new Set(realComputed.split(','));
  assert.ok(!realSelectors.has('host.exec'));
  for (const entry of TOOL_REGISTRY) {
    assert.equal(realSelectors.has(entry.name), ['local-read', 'external-read'].includes(entry.effect),
      `${entry.name} remote visibility must derive from its registry effect`);
  }
  console.log('remote-agent-bridge profile-allowlist computation tests passed (fake + real registry).');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

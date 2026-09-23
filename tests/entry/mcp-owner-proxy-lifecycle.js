'use strict';

// Focused owner-host proxy lifecycle checks.  This deliberately uses fake named
// pipes and an isolated capability file: it never touches the real owner host,
// local broker, state store, or network.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
// This account's own real temp root, expanded through the filesystem so an
// 8.3 short-name alias of %TEMP% does not read as a foreign directory (see
// src/lib/account-profile-boundary.js, "An 8.3 short name is the same
// account, spelled shorter"). Computed at runtime rather than hardcoded to
// one developer's account name: the fence check below only ever needed to
// prove mkdtemp lands under THIS process's own account, never under one
// specific named account, and a hardcoded literal both broke on any other
// machine and put an account name in source (see ACCOUNT-FENCE.md).
const ALLOWED_TEMP_ROOT = fs.realpathSync.native(os.tmpdir());
const ownerHostModule = require('../../src/owner-host.js');
const sessionAuthority = require('../../src/lib/agent-session-credential.js');
const { createMissionBridgeServer } = require('../../src/lib/mission-bridge/server.js');
const TEST_PRINCIPALS = Object.freeze({
  ownerPrincipal: 'TESTHOST\\test-owner',
  clientPrincipal: 'TESTHOST\\test-owner'
});

function waitForChildClose(child, label, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

/* What the CLIENT was handed, from a real spawned proxy's stdout. A session
 * that loses its tool host must answer the request it was given; before T159
 * was fixed the only thing written anywhere was one stderr line, which no MCP
 * client shows to anybody. */
function waitForStdoutAnswer(child, id, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label}: no JSON-RPC answer with id ${JSON.stringify(id)} within ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = chunk => {
      buffer += chunk;
      while (true) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed && parsed.id === id) { cleanup(); resolve(parsed); return; }
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
  });
}

function startServer(pipe, handler) {
  const sockets = new Set();
  let resolveHandled;
  let rejectHandled;
  const handled = new Promise((resolve, reject) => {
    resolveHandled = resolve;
    rejectHandled = reject;
  });
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    try { resolveHandled(Promise.resolve(handler(socket))); }
    catch (error) { rejectHandled(error); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => resolve({ server, sockets, handled }));
  });
}

async function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.destroy();
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('close', resolve)),
    new Promise(resolve => setTimeout(resolve, 1_000))
  ]);
}

function writeCapability(root, pipe) {
  fs.writeFileSync(path.join(root, 'owner-host-capability.json'), `${JSON.stringify({
    version: 2,
    pipeName: pipe,
    generation: crypto.randomUUID()
  })}\n`, 'utf8');
}

function spawnProxy(root, pipe, credential, identity = {}, entry = path.join(ROOT, 'tools', 'mcp-owner-proxy.js')) {
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      TOOLSENABLED_TEST_ISOLATED: '1',
      TOOLSENABLED_TEST_ROOT: root,
      TOOLSENABLED_TEST_OWNER_HOST_PIPE: pipe,
      TOOLSENABLED_AGENT_ACTOR: identity.provider || 'claude',
      TOOLSENABLED_AGENT_ID: identity.agentId || 'forged-other-agent',
      TOOLSENABLED_AGENT_SESSION_CREDENTIAL: credential
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.on('error', () => {});
  return child;
}

function waitForRequest(socket, credential) {
  return new Promise(resolve => {
    socket.setEncoding('utf8');
    let buffer = '';
    let authorized = false;
    socket.on('data', chunk => {
      buffer += chunk;
      while (true) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!authorized) {
          assert.deepEqual(JSON.parse(line), { type: 'authorize-session', credential });
          authorized = true;
          socket.write('{"type":"authorized","protocolVersion":2}\n');
          continue;
        }
        resolve();
        return;
      }
    });
  });
}

function connectSocket(pipe) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: pipe });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function readLine(socket, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('socket line was not received in time'));
    }, timeoutMs);
    const onData = chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      cleanup();
      resolve(buffer.slice(0, end).replace(/\r$/, ''));
    };
    const onClose = () => { cleanup(); reject(new Error('socket closed before a line was received')); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
    };
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.once('close', onClose);
  });
}

function waitForSocketClose(socket, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('socket was not refused in time')), timeoutMs);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

async function requestLine(pipe, message) {
  const socket = await connectSocket(pipe);
  socket.write(`${JSON.stringify(message)}\n`);
  const response = JSON.parse(await readLine(socket));
  socket.destroy();
  return response;
}

/* A stdin stand-in that HOLDS bytes while paused, as a paused Readable does:
 * what the client writes during a reconnect must reach the host afterwards,
 * and a fake that dropped it could not tell that apart from a proxy that did. */
function fakeInput() {
  const input = new EventEmitter();
  const held = [];
  let paused = false;
  const emit = input.emit.bind(input);
  input.emit = (event, ...args) => {
    if (event === 'data' && paused) { held.push(args); return true; }
    return emit(event, ...args);
  };
  input.pause = () => { paused = true; };
  input.resume = () => {
    paused = false;
    while (!paused && held.length) emit('data', ...held.shift());
  };
  input.pipe = () => {};
  input.unpipe = () => {};
  input.destroy = () => { input.destroyed = true; };
  return input;
}

function fakeOutput() {
  const chunks = [];
  return { chunks, write(chunk) { chunks.push(String(chunk)); return true; } };
}

function fakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.written = [];
  socket.setEncoding = () => {};
  socket.write = chunk => { socket.written.push(chunk); return true; };
  socket.destroy = () => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    socket.emit('close');
  };
  return socket;
}

function authorizeFakeSocket(socket) {
  socket.emit('connect');
  socket.emit('data', '{"type":"authorized","protocolVersion":2}\n');
}

// Drives connectOwnerHost directly with injected transport/stdio objects, so
// each lifecycle outcome is asserted as behaviour -- what the CLIENT is
// actually handed, and the exit code -- rather than by spawning a real process.
//
// T159, 2026-09-16 and 2026-09-18: a runtime-generation activation is followed
// by an app restart, the restart ends every session in the app, and the agent
// CLI processes outlive it. Until this, that arrived at the agent as a stdio
// server that vanished: the call that was running was never answered at all,
// and the one sentence written about it went to stderr, where no MCP client
// shows it. So the cases below assert the ANSWER, not the sentence.
function fakeOutputLines(output) {
  return output.chunks.join('').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

function answerFor(output, id) {
  return fakeOutputLines(output).find(message => message.id === id) || null;
}

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Waits for a CONDITION rather than a number of milliseconds: Windows timers
 * carry ~16 ms granularity and a loaded box stretches them further, so a fixed
 * sleep either flakes or pads every run. Bounded, and named when it fails. */
async function waitUntil(condition, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${label} did not happen within ${timeoutMs}ms`);
    await tick(5);
  }
}

async function testConnectOwnerHostDirectly() {
  const proxyModule = require('../../tools/mcp-owner-proxy.js');
  const credential = crypto.randomBytes(32).toString('base64url');
  const capability = Object.freeze({ pipeName: 'ignored-by-fake-connect' });
  const routed = generation => Object.freeze({ version: 2, pipeName: 'ignored-by-fake-connect', generation });
  // Every direct case injects its own record reader. The production default
  // reads this installation's real capability record, which a test must never
  // consult: the verdict under test would then depend on whether the owner's
  // app happened to be running.
  const fast = { reconnectDelayMs: 1, resolveWindowMs: 20, lingerMs: 2_000 };

  /* THE RETRY SCHEDULE, BY VALUES. Each wait is longer than the last and none
     is longer than the cap, so a host that is busy is not hammered and a host
     that is back is found within one delay. A schedule that repeated one delay
     forever, or grew past the cap, fails here on the numbers. */
  {
    const delays = [0, 1, 2, 3, 4, 5, 6].map(attempt => proxyModule.reconnectDelayFor(attempt));
    assert.equal(delays[0], proxyModule.RECONNECT_DELAY_MS, 'the first wait must be the declared base delay');
    for (let index = 1; index < delays.length; index += 1) {
      assert.ok(delays[index] >= delays[index - 1], `wait ${index} must not be shorter than wait ${index - 1}`);
      assert.ok(delays[index] <= proxyModule.RECONNECT_MAX_DELAY_MS, `wait ${index} must not exceed the cap`);
    }
    assert.ok(delays[1] > delays[0], 'the second wait must be longer than the first: a flat schedule is not a backoff');
    assert.equal(delays.at(-1), proxyModule.RECONNECT_MAX_DELAY_MS, 'a long outage must settle at the cap, not grow without bound');
    assert.deepEqual([0, 1, 2, 3].map(attempt => proxyModule.reconnectDelayFor(attempt, { baseMs: 3, maxMs: 10 })),
      [3, 6, 10, 10], 'an injected base and cap must produce the doubled-then-capped schedule');
    assert.equal(proxyModule.reconnectDelayFor(10_000), proxyModule.RECONNECT_MAX_DELAY_MS,
      'an absurd attempt count must still schedule at the cap, never at an unschedulable value');
  }

  /* THE ACTIVATION CASE. The record now names a different app instance, which
     is a complete answer and needs no polling. The call that was in flight and
     the call made afterwards are both ANSWERED, with a named code and a
     sentence, and the two answers differ: only the in-flight one says its
     outcome is unknown. */
  {
    const socket = fakeSocket();
    const input = fakeInput();
    const output = fakeOutput();
    const errorOutput = fakeOutput();
    const before = process.exitCode;
    process.exitCode = undefined;
    proxyModule.connectOwnerHost(routed('11111111-1111-4111-8111-111111111111'), credential, {
      ...fast,
      connect: () => socket,
      input,
      output,
      errorOutput,
      readCapabilityRecord: () => routed('22222222-2222-4222-8222-222222222222')
    });
    authorizeFakeSocket(socket);
    input.emit('data', '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"host.exec"}}\n');
    socket.destroyed = true;
    socket.emit('close');
    await tick(50);

    const inFlight = answerFor(output, 7);
    assert.ok(inFlight, 'the tool call that was running when the app instance was replaced was never answered');
    assert.equal(inFlight.error.data.code, proxyModule.TRANSPORT_LOST_CODES.SUPERSEDED,
      'a record naming another app instance must be named as a replaced instance, not guessed at');
    assert.ok(inFlight.error.message.includes(proxyModule.IN_FLIGHT_SUFFIX.trim()),
      'a call whose outcome cannot be known must say so rather than read as a plain failure');
    assert.equal(process.exitCode, undefined,
      'the session must keep answering after its host went away, not exit and leave a dead surface');

    input.emit('data', '{"jsonrpc":"2.0","id":8,"method":"tools/list"}\n');
    await tick(10);
    const afterwards = answerFor(output, 8);
    assert.ok(afterwards, 'a call made after the app instance was replaced was not answered at all');
    assert.equal(afterwards.error.data.code, proxyModule.TRANSPORT_LOST_CODES.SUPERSEDED);
    assert.equal(afterwards.error.message.includes(proxyModule.IN_FLIGHT_SUFFIX.trim()), false,
      'a call made after the loss was never in flight and must not claim an unknown outcome');
    assert.ok(errorOutput.chunks.join('').includes(proxyModule.TRANSPORT_LOST_CODES.SUPERSEDED),
      'the named reason must also reach the process log the owner can read');

    input.emit('end');
    assert.notEqual(process.exitCode, 0,
      'a session that ended without its tool host must not report an ordinary success');
    process.exitCode = before;
  }

  /* NOT BACK YET IS NOT GONE. An app that is restarting has withdrawn its
     record and has not published the next one. Reading that absence once and
     concluding the app is gone would convict the restart in progress, so the
     absence is polled; when the SAME instance publishes again, the session is
     served again. This is the leg where a running session actually survives. */
  {
    const first = fakeSocket();
    const second = fakeSocket();
    const sockets = [first, second];
    const input = fakeInput();
    const output = fakeOutput();
    const errorOutput = fakeOutput();
    const before = process.exitCode;
    process.exitCode = undefined;
    let reads = 0;
    const generation = '33333333-3333-4333-8333-333333333333';
    proxyModule.connectOwnerHost(routed(generation), credential, {
      ...fast,
      resolveWindowMs: 5_000,
      connect: () => sockets.shift(),
      input,
      output,
      errorOutput,
      readCapabilityRecord: () => { reads += 1; return reads <= 2 ? null : routed(generation); }
    });
    authorizeFakeSocket(first);
    // A call that was ALREADY RUNNING when the connection dropped. It cannot
    // be answered by the host and must not be silently re-sent (host.exec, a
    // purchase and a credential write all ride this transport), so the proxy
    // answers it itself -- and what it says has to match what actually
    // happened. A session that is serving again must not be described as one
    // ToolsEnabled ended and the owner should resume: that sentence stops a
    // working agent.
    input.emit('data', '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"host.exec"}}\n');
    await waitUntil(() => first.written.some(chunk => String(chunk).includes('"id":10')),
      'the in-flight call reaching the host before the drop');
    first.destroyed = true;
    first.emit('close');
    // A call the client makes WHILE the connection is down is held, not
    // refused and not dropped: it must reach the host once it is back.
    input.emit('data', '{"jsonrpc":"2.0","id":11,"method":"tools/list"}\n');
    await waitUntil(() => second.listenerCount('connect') > 0, 'the reconnect attempt against the same instance');
    assert.ok(errorOutput.chunks.join('').includes(proxyModule.TRANSPORT_RECOVERING_CODE),
      'while reconnecting, the process log must name the recoverable state rather than say nothing');
    assert.equal(answerFor(output, 11), null,
      'a call made during the reconnect was answered with an error instead of being held for the host');
    authorizeFakeSocket(second);
    await waitUntil(() => second.written.some(chunk => String(chunk).includes('"id":11')),
      'the held call reaching the reconnected host');
    assert.ok(reads > 2, 'an absent capability record was accepted as proof the app was gone after one read');
    assert.equal(process.exitCode, undefined, 'the session was ended while its app was still restarting');
    second.emit('data', '{"jsonrpc":"2.0","id":11,"result":{"held":true}}\n');
    assert.deepEqual(answerFor(output, 11), { jsonrpc: '2.0', id: 11, result: { held: true } },
      'the call held through the reconnect was not served by the reconnected host');

    input.emit('data', '{"jsonrpc":"2.0","id":12,"method":"tools/list"}\n');
    await waitUntil(() => second.written.some(chunk => String(chunk).includes('"id":12')),
      'the session\'s next call reaching the same app instance after it came back');
    second.emit('data', '{"jsonrpc":"2.0","id":12,"result":{"served":true}}\n');
    assert.deepEqual(answerFor(output, 12), { jsonrpc: '2.0', id: 12, result: { served: true } },
      'the reconnected session did not serve its next tool call');
    assert.ok(errorOutput.chunks.join('').includes('reconnected'),
      'the process log must say the session is serving again, so the recovering line does not read as the last word');
    // The interrupted call: answered, named as interrupted rather than as an
    // ended session, and carrying the do-not-repeat-blindly warning. Asserted
    // by the exported values, not by the sentence.
    const interrupted = answerFor(output, 10);
    assert.ok(interrupted, 'the call that was running when the connection dropped was never answered');
    assert.equal(interrupted.error.data.code, proxyModule.TRANSPORT_LOST_CODES.CALL_INTERRUPTED,
      'a call interrupted by a recovered drop was reported as an ended session, which would send a working agent away');
    assert.notEqual(proxyModule.TRANSPORT_LOST_CODES.CALL_INTERRUPTED,
      proxyModule.TRANSPORT_LOST_CODES.SESSION_ENDED,
      'an interrupted call and an ended session must not be the same answer');
    assert.ok(interrupted.error.message.includes(proxyModule.IN_FLIGHT_SUFFIX.trim()),
      'the interrupted call must say its outcome is unknown rather than invite a blind repeat');
    assert.equal(interrupted.error.message.includes(
      proxyModule.TRANSPORT_LOST_MESSAGES[proxyModule.TRANSPORT_LOST_CODES.SESSION_ENDED]), false,
    'a serving session was told ToolsEnabled had ended its tool access');
    input.emit('end');
    process.exitCode = before;
  }

  /* THE APP IS GONE. The record never comes back inside the window, so the
     absence is finally allowed to mean something -- and it is named. */
  {
    const socket = fakeSocket();
    const input = fakeInput();
    const output = fakeOutput();
    const before = process.exitCode;
    process.exitCode = undefined;
    proxyModule.connectOwnerHost(routed('44444444-4444-4444-8444-444444444444'), credential, {
      ...fast,
      connect: () => socket,
      input,
      output,
      errorOutput: fakeOutput(),
      readCapabilityRecord: () => null
    });
    authorizeFakeSocket(socket);
    input.emit('data', '{"jsonrpc":"2.0","id":13,"method":"tools/list"}\n');
    socket.destroyed = true;
    socket.emit('close');
    await tick(120);
    const answer = answerFor(output, 13);
    assert.ok(answer, 'a call made with no app running was not answered');
    assert.equal(answer.error.data.code, proxyModule.TRANSPORT_LOST_CODES.UNAVAILABLE,
      'no app at all must be named as no app, not as a replaced instance');
    input.emit('end');
    process.exitCode = before;
  }

  /* THE APP IS STILL RUNNING AND ENDED THIS SESSION. A revoked binding is not
     resurrected by reconnecting: the host re-checks the credential, every
     attempt is refused, and the session is told so by name. */
  {
    const sockets = [fakeSocket(), fakeSocket(), fakeSocket(), fakeSocket(), fakeSocket(), fakeSocket()];
    const opened = [...sockets];
    const input = fakeInput();
    const output = fakeOutput();
    const before = process.exitCode;
    process.exitCode = undefined;
    const generation = '55555555-5555-4555-8555-555555555555';
    let connects = 0;
    proxyModule.connectOwnerHost(routed(generation), credential, {
      ...fast,
      connect: () => {
        connects += 1;
        const next = sockets.shift();
        if (!next) throw new Error('the proxy attempted more reconnects than its declared bound');
        return next;
      },
      input,
      output,
      errorOutput: fakeOutput(),
      readCapabilityRecord: () => routed(generation)
    });
    authorizeFakeSocket(opened[0]);
    input.emit('data', '{"jsonrpc":"2.0","id":14,"method":"tools/list"}\n');
    opened[0].destroyed = true;
    opened[0].emit('close');
    // Every reconnect is refused the way a host with no such binding refuses:
    // the socket closes before any 'authorized' line. Each is refused once
    // the proxy has actually opened it, whatever the backoff schedule says.
    for (let index = 1; index < opened.length; index += 1) {
      await waitUntil(() => opened[index].listenerCount('close') > 0, `reconnect attempt ${index} being opened`);
      opened[index].destroy();
    }
    await waitUntil(() => answerFor(output, 14) !== null, 'the held call being answered after the last refusal');
    const answer = answerFor(output, 14);
    assert.ok(answer, 'a session the running app had ended was left with no answer at all');
    assert.equal(answer.error.data.code, proxyModule.TRANSPORT_LOST_CODES.SESSION_ENDED,
      'a still-published same instance that refuses the credential must be named as an ended session');
    assert.equal(connects, 1 + proxyModule.RECONNECT_ATTEMPTS,
      'the reconnect budget is not the declared constant: an unbounded retry against a host that keeps refusing is a spin, not a recovery');
    input.emit('end');
    process.exitCode = before;
  }

  // Stdin ending first is the client choosing to stop. That stays silent and
  // exits 0, even for an authorized session.
  {
    const socket = fakeSocket();
    const input = fakeInput();
    const errorOutput = fakeOutput();
    const before = process.exitCode;
    process.exitCode = undefined;
    proxyModule.connectOwnerHost(capability, credential, {
      ...fast,
      connect: () => socket,
      input,
      output: fakeOutput(),
      errorOutput,
      readCapabilityRecord: () => null
    });
    authorizeFakeSocket(socket);
    input.emit('end');
    assert.equal(process.exitCode, 0,
      'client stdin ending first after authorization must exit 0');
    assert.deepEqual(errorOutput.chunks, [],
      'client stdin ending first after authorization must write nothing to errorOutput');
    process.exitCode = before;
  }

  // Before authorization, either transport endpoint ending is unchanged: the
  // pre-authorization REFUSAL sentence, exit 1. The app never accepted this
  // connection, so there is no session to keep answering for.
  {
    const socket = fakeSocket();
    const errorOutput = fakeOutput();
    const before = process.exitCode;
    process.exitCode = undefined;
    proxyModule.connectOwnerHost(capability, credential, {
      ...fast,
      connect: () => socket,
      input: fakeInput(),
      output: fakeOutput(),
      errorOutput,
      readCapabilityRecord: () => null
    });
    socket.emit('error', new Error('simulated pre-authorization connection failure'));
    assert.equal(process.exitCode, 1,
      'a pre-authorization transport failure must exit 1');
    assert.deepEqual(errorOutput.chunks, [`${proxyModule.REFUSAL}\n`],
      'a pre-authorization transport failure must keep the unchanged REFUSAL sentence');
    process.exitCode = before;
  }

  /* The id scanner reads the front of a line and never holds the line. A tool
     result far larger than its scan budget must still clear its request, or a
     long session would answer ids that were answered hours ago. */
  {
    const seen = [];
    const scan = proxyModule.createRpcIdScanner(id => seen.push(id));
    const huge = 'A'.repeat(200_000);
    scan(Buffer.from('{"jsonrpc":"2.0","id":41,"method":"too'));
    scan(Buffer.from(`ls/call"}\n{"jsonrpc":"2.0","id":"sess-42","result":{"image":"${huge}"}}\n`));
    scan(Buffer.from('{"jsonrpc":"2.0","method":"notifications/progress"}\n'));
    assert.deepEqual(seen, [41, 'sess-42'],
      'the id scanner did not read ids across a chunk boundary, past a large payload, and skip a notification');
  }
}

(async () => {
  await testConnectOwnerHostDirectly();
  let whoamiCall = null;
  const exactPrincipal = ownerHostModule.validatedPrincipals({
    platform: 'win32',
    execFileSyncImpl(file, args, options) {
      whoamiCall = { file, args, options };
      return '"TESTHOST\\test-owner","S-1-5-21-1000"\r\n';
    }
  });
  assert.deepEqual(exactPrincipal, {
    ownerPrincipal: '*S-1-5-21-1000', clientPrincipal: '*S-1-5-21-1000'
  },
    'the owner host did not bind both halves to the exact process-token principal');
  assert.equal(whoamiCall.file, ownerHostModule.WINDOWS_WHOAMI);
  assert.deepEqual(whoamiCall.args, ['/user', '/fo', 'csv', '/nh']);
  assert.deepEqual(whoamiCall.options.env, {});
  assert.equal(ownerHostModule.systemIcacls({ SystemRoot: 'C:\\hostile-bin' }), ownerHostModule.WINDOWS_ICACLS,
    'ambient SystemRoot selected the ACL executable');
  assert.throws(() => ownerHostModule.createOwnerHost({
    principals: { ownerPrincipal: 'TESTHOST\\owner', clientPrincipal: 'TESTHOST\\other' }
  }), error => error?.code === 'OWNER_HOST_PRINCIPAL_OVERRIDE_REFUSED');

  const livePrincipal = ownerHostModule.validatedPrincipals();
  assert.match(livePrincipal.ownerPrincipal, /^\*S-\d+(?:-\d+){2,15}$/i);
  assert.equal(livePrincipal.clientPrincipal, livePrincipal.ownerPrincipal);
  const liveIcacls = spawnSync(ownerHostModule.WINDOWS_ICACLS, ['/?'], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {}
  });
  assert.equal(liveIcacls.error, undefined,
    `kernel-resolved icacls did not execute: ${liveIcacls.error?.message || 'unknown error'}`);
  assert.equal(liveIcacls.status, 0,
    `kernel-resolved icacls help failed: ${String(liveIcacls.stderr || '').slice(0, 200)}`);

  const temporary = fs.mkdtempSync(path.join(ALLOWED_TEMP_ROOT, 'toolsenabled-owner-proxy-lifecycle-'));
  if (path.dirname(temporary).toLowerCase() !== ALLOWED_TEMP_ROOT.toLowerCase()) {
    throw new Error("The owner-proxy lifecycle temp directory crossed this account's fence.");
  }
  const token = crypto.randomBytes(32);
  const servers = [];
  const children = [];
  const hosts = [];
  const bridges = [];
  const clients = [];
  try {
    // An owner-host closure while the MCP client leaves its stdin open is a
    // revocation, not an idle timeout. The client must be TOLD -- answered, in
    // the protocol, with a named reason -- and the process must not report an
    // ordinary success. T159: writing one sentence to stderr and exiting was
    // indistinguishable, from the agent's side, from a server that vanished.
    const ownerClosedPipe = `\\\\.\\pipe\\ToolsEnabledOwnerProxyClosed-${process.pid}-${crypto.randomUUID()}`;
    const ownerClosedCredential = crypto.randomBytes(32).toString('base64url');
    const ownerClosed = await startServer(ownerClosedPipe, socket => {
      return waitForRequest(socket, ownerClosedCredential).then(() => socket.destroy());
    });
    servers.push(ownerClosed);
    writeCapability(temporary, ownerClosedPipe);
    const ownerClosedProxy = spawnProxy(temporary, ownerClosedPipe, ownerClosedCredential);
    children.push(ownerClosedProxy);
    let ownerClosedStderr = '';
    ownerClosedProxy.stderr.on('data', chunk => { ownerClosedStderr += chunk; });
    ownerClosedProxy.stdin.write('{"jsonrpc":"2.0","id":"owner-closed","method":"ping"}\n');
    await ownerClosed.handled;
    // The listener goes too, so every bounded reconnect this proxy is entitled
    // to fails against a record that still names the same app instance.
    await closeServer(ownerClosed.server, ownerClosed.sockets);
    const ownerClosedAnswer = await waitForStdoutAnswer(
      ownerClosedProxy, 'owner-closed', 30_000, 'the request held when the owner host closed'
    );
    assert.equal(ownerClosedAnswer.error?.data?.code,
      require('../../tools/mcp-owner-proxy.js').TRANSPORT_LOST_CODES.SESSION_ENDED,
      'owner-host closure while stdin was still open must answer the held request with a named reason');
    assert.ok(typeof ownerClosedAnswer.error.message === 'string' && ownerClosedAnswer.error.message.length > 40,
      'the named reason must carry a sentence a person can act on');
    ownerClosedProxy.stdin.end();
    const ownerClosedResult = await waitForChildClose(ownerClosedProxy, 'proxy after owner-host closure', 30_000);
    assert.notEqual(ownerClosedResult.code, 0,
      'owner-host closure while stdin was still open must exit non-zero');
    assert.ok(ownerClosedStderr.includes(
      require('../../tools/mcp-owner-proxy.js').TRANSPORT_LOST_CODES.SESSION_ENDED
    ), 'owner-host closure must also name the lost tool access on errorOutput');

    // Client stdin EOF must terminate the proxy even if a malformed peer holds
    // its write side open.  This is the actual abandoned-stdio boundary.
    const stdinClosedPipe = `\\\\.\\pipe\\ToolsEnabledOwnerProxyStdin-${process.pid}-${crypto.randomUUID()}`;
    const stdinClosedCredential = crypto.randomBytes(32).toString('base64url');
    const stdinClosed = await startServer(stdinClosedPipe, socket => {
      return waitForRequest(socket, stdinClosedCredential);
    });
    servers.push(stdinClosed);
    writeCapability(temporary, stdinClosedPipe);
    const stdinClosedProxy = spawnProxy(temporary, stdinClosedPipe, stdinClosedCredential);
    children.push(stdinClosedProxy);
    stdinClosedProxy.stdin.write('{"jsonrpc":"2.0","id":"stdin-closed","method":"ping"}\n');
    await stdinClosed.handled;
    stdinClosedProxy.stdin.end();
    const stdinClosedResult = await waitForChildClose(stdinClosedProxy, 'proxy after client stdin EOF');
    assert.equal(stdinClosedResult.code, 0, 'client stdin EOF must end an authorized proxy cleanly');
    await closeServer(stdinClosed.server, stdinClosed.sockets);

    // The generated config launches src/mcp-server.js, not the proxy script
    // directly. Its credentialed main path must delegate to the same
    // credential-only handshake and ignore forged actor/id environment fields.
    const mcpEntryPipe = `\\\\.\\pipe\\ToolsEnabledOwnerMcpEntry-${process.pid}-${crypto.randomUUID()}`;
    const mcpEntryCredential = crypto.randomBytes(32).toString('base64url');
    const mcpEntry = await startServer(mcpEntryPipe, socket => {
      return waitForRequest(socket, mcpEntryCredential).then(() => socket.destroy());
    });
    servers.push(mcpEntry);
    writeCapability(temporary, mcpEntryPipe);
    const mcpEntryChild = spawnProxy(
      temporary,
      mcpEntryPipe,
      mcpEntryCredential,
      { provider: 'claude', agentId: 'forged-cross-agent' },
      path.join(ROOT, 'src', 'mcp-server.js')
    );
    children.push(mcpEntryChild);
    let mcpEntryStderr = '';
    mcpEntryChild.stderr.on('data', chunk => { mcpEntryStderr += chunk; });
    mcpEntryChild.stdin.write('{"jsonrpc":"2.0","id":"mcp-entry","method":"ping"}\n');
    await mcpEntry.handled;
    // The fake host destroys the socket while this child's stdin is still
    // open, the same revocation shape as the owner-closed case above, so the
    // credentialed entrypoint must answer it the same way.
    await closeServer(mcpEntry.server, mcpEntry.sockets);
    const mcpEntryAnswer = await waitForStdoutAnswer(
      mcpEntryChild, 'mcp-entry', 30_000, 'the request held by the credentialed mcp-server entrypoint'
    );
    assert.equal(mcpEntryAnswer.error?.data?.code,
      require('../../tools/mcp-owner-proxy.js').TRANSPORT_LOST_CODES.SESSION_ENDED,
      'the credentialed mcp-server entrypoint must answer its held request with a named reason');
    mcpEntryChild.stdin.end();
    const mcpEntryResult = await waitForChildClose(mcpEntryChild, 'credentialed mcp-server entrypoint', 30_000);
    assert.notEqual(mcpEntryResult.code, 0,
      'the credentialed mcp-server entrypoint must exit non-zero when the host closes the socket');
    assert.ok(mcpEntryStderr.includes(
      require('../../tools/mcp-owner-proxy.js').TRANSPORT_LOST_CODES.SESSION_ENDED
    ), 'the credentialed mcp-server entrypoint must also name the lost tool access on errorOutput');

    // Exercise the restored production host itself with an isolated pipe and
    // capability file. The dispatcher is injected, but the listener,
    // authorization, actor binding, full owner-session permission binding,
    // per-line transport, and capability cleanup are the production code.
    const hostPipe = `\\\\.\\pipe\\ToolsEnabledOwnerHost-${process.pid}-${crypto.randomUUID()}`;
    const hostCapability = path.join(temporary, 'host-capability.json');
    const hostControlCapability = path.join(temporary, 'owner-host-control.json');
    const hostToken = crypto.randomBytes(32);
    let authoritativeOrgRevision = 7;
    const authoritativeRoleRevisions = new Map([
      ['release-captain', 4],
      ['release-worker', 2]
    ]);
    // The role sheet the person can edit in the Role library. Absent means
    // the normal installed surface (functions: null).
    const authoritativeRoleFunctions = new Map();
    let dispatched = null;
    let hygieneCalls = 0;
    // Every retirement/rebind record the host writes about its sessions.
    const retirementEvents = [];
    const broker = {
      MAX_MESSAGE_BYTES: 1024 * 1024,
      recordMcpSurface: () => {},
      resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
      processLine: async (line, respond, options) => {
        dispatched = { line, options };
        const request = JSON.parse(line);
        respond({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
      }
    };
    const host = ownerHostModule.createOwnerHost({
      allowTestPaths: true,
      pipeName: hostPipe,
      capabilityFile: hostCapability,
      controlCapabilityFile: hostControlCapability,
      principals: TEST_PRINCIPALS,
      token: hostToken,
      platform: 'test',
      credentialHygiene() { hygieneCalls += 1; },
      sessionRetirementObserver(event) { retirementEvents.push(event); },
      readInstalledOrg(principal) {
        return {
          org: {
            revision: authoritativeOrgRevision,
            agents: [
              { id: 'root-alpha', role: 'release-captain', provider: 'codex', enabled: true },
              { id: 'worker-beta', role: 'release-worker', provider: 'claude', enabled: true }
            ]
          },
          // A role the library no longer holds is null, exactly as
          // custom-role-store getRoleRecord answers for an unknown id.
          roleRecord: authoritativeRoleRevisions.has(principal.roleId) ? {
            definition: {
              id: principal.roleId,
              ...(authoritativeRoleFunctions.has(principal.roleId)
                ? { functions: authoritativeRoleFunctions.get(principal.roleId) } : {})
            },
            revision: authoritativeRoleRevisions.get(principal.roleId)
          } : null
        };
      },
      broker
    });
    hosts.push(host);
    await host.listen();
    await host.listen();
    assert.equal(hygieneCalls, 1,
      'credential hygiene did not run exactly once before the app-owned host listened');
    const published = JSON.parse(fs.readFileSync(hostCapability, 'utf8'));
    assert.deepEqual(published, {
      version: 2,
      pipeName: hostPipe,
      generation: host.generation
    });
    assert.equal(fs.existsSync(hostControlCapability), false,
      'the app-owned host published a same-user-readable bind/revoke bearer');

    const bindingRequest = {
      sessionId: 'session-codex-root',
      agentId: 'root-alpha',
      provider: 'codex',
      roleId: 'release-captain',
      expectedOrgRevision: 7,
      expectedRoleRevision: 4
    };
    const bound = await host.bindSession(bindingRequest);
    assert.equal(bound.bound, true);
    assert.equal(bound.mode, 'app-owned-owner-host');
    assert.match(bound.credential, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await host.bindSession(bindingRequest), bound,
      'an exact trusted-launcher retry must return the same server-issued session credential');

    const refusedClient = await connectSocket(hostPipe);
    clients.push(refusedClient);
    refusedClient.write(`${JSON.stringify({
      type: 'authorize-session', credential: crypto.randomBytes(32).toString('base64url')
    })}\n`);
    await waitForSocketClose(refusedClient);

    const client = await connectSocket(hostPipe);
    clients.push(client);
    client.write(`${JSON.stringify({
      type: 'authorize-session', credential: bound.credential
    })}\n`);
    assert.deepEqual(JSON.parse(await readLine(client)), { type: 'authorized', protocolVersion: 2 });
    const request = { jsonrpc: '2.0', id: 'host-test', method: 'tools/list', params: {} };
    client.write(`${JSON.stringify(request)}\n`);
    assert.deepEqual(JSON.parse(await readLine(client)), {
      jsonrpc: '2.0', id: 'host-test', result: { ok: true }
    });
    assert.equal(dispatched.line, JSON.stringify(request));
    const { fileToolContext, signal: dispatchSignal, ...dispatchedOptions } = dispatched.options;
    assert.ok(dispatchSignal instanceof AbortSignal);
    assert.equal(dispatchSignal.aborted, false,
      'a live authenticated connection must dispatch with an active cancellation signal');
    assert.deepEqual(Object.keys(fileToolContext), ['binding']);
    const { runtimeScopeId, ...fileBinding } = fileToolContext.binding;
    assert.match(runtimeScopeId, /^file-scope-[a-f0-9-]{36}$/);
    assert.deepEqual(fileBinding, {
      scopeKind: 'owner-host-session', principal: 'agent:root-alpha',
      canonicalLaunchId: null, laneId: null, rosterRef: null, runId: null
    }, 'file authority must be bound to the authenticated session principal');
    assert.deepEqual(dispatchedOptions, {
      toolMode: 'ToolsEnabled only',
      agentApiMode: 'Only',
      agentRole: { functions: null, requiresDirectUserAuthorization: false },
      agentActor: 'codex',
      agentId: 'root-alpha',
      agentSessionId: 'session-codex-root',
      agentPrincipal: {
        kind: 'agent-session',
        sessionId: 'session-codex-root',
        agentId: 'root-alpha',
        provider: 'codex',
        roleId: 'release-captain',
        expectedOrgRevision: 7,
        expectedRoleRevision: 4
      },
      permissionSession: { origin: 'local', tier: 'full' }
    });

    await assert.rejects(
      host.bindSession({ ...bindingRequest, provider: 'claude' }),
      error => error.code === 'OWNER_HOST_SESSION_COLLISION'
    );

    await assert.rejects(host.bindSession({
      ...bindingRequest,
      sessionId: 'session-stale-revision',
      expectedOrgRevision: 6
    }), error => error.code === 'OWNER_HOST_SESSION_REFUSED');

    const malformed = { ...bindingRequest, sessionId: 'session-malformed' };
    delete malformed.expectedRoleRevision;
    await assert.rejects(host.bindSession(malformed), error => error.code === 'OWNER_HOST_SESSION_BINDING_INVALID');

    assert.deepEqual(await requestLine(hostPipe, {
      type: 'resolve-session',
      credential: bound.credential
    }), {
      type: 'session-resolved',
      protocolVersion: 2,
      principal: {
        sessionId: 'session-codex-root',
        agentActor: 'codex',
        agentId: 'root-alpha',
        roleId: 'release-captain',
        expectedOrgRevision: 7,
        expectedRoleRevision: 4
      }
    });

    const claudeBinding = await host.bindSession({
      sessionId: 'session-claude-worker',
      agentId: 'worker-beta',
      provider: 'claude',
      roleId: 'release-worker',
      expectedOrgRevision: 7,
      expectedRoleRevision: 2
    });
    assert.equal(claudeBinding.bound, true);
    assert.notEqual(claudeBinding.credential, bound.credential,
      'two sessions received the same server-issued credential');

    /* THE ORG MOVES ON FOR SOMEBODY ELSE; RUNNING SESSIONS STAY BOUND.
       A tree spawn declares the new circle's seat, which bumps the org
       revision. Measured 2026-09-03: that bump used to destroy every socket
       of the session that spawned. Both live sessions must keep answering,
       resolve must still name them, and only a NEW bind against the stale
       snapshot is refused. */
    authoritativeOrgRevision = 8;
    const afterSeatAdded = { jsonrpc: '2.0', id: 'after-seat-added', method: 'tools/list', params: {} };
    client.write(`${JSON.stringify(afterSeatAdded)}\n`);
    assert.deepEqual(JSON.parse(await readLine(client)), {
      jsonrpc: '2.0', id: 'after-seat-added', result: { ok: true }
    }, 'an org revision bump for another seat closed a running session\'s socket');
    assert.equal((await requestLine(hostPipe, {
      type: 'resolve-session',
      credential: bound.credential
    })).type, 'session-resolved',
    'an org revision bump for another seat made a running session unresolvable');
    assert.deepEqual(await host.bindSession(bindingRequest), bound,
      'an exact retry of a running binding was refused after an org revision bump');
    await assert.rejects(host.bindSession({
      ...bindingRequest,
      sessionId: 'session-started-from-stale-snapshot'
    }), error => error.code === 'OWNER_HOST_SESSION_REFUSED',
    'a NEW session bound against a stale org snapshot was accepted');

    const bridgeToken = crypto.randomBytes(32);
    const bridgeProof = crypto.randomBytes(32);
    const bridgeRuntime = path.join(temporary, 'mission-runtime.json');
    const surface = principal => ({
      async status() { return { ok: true, principal }; },
      ownerPromptSnapshot() { return { ok: true, principal }; },
      async queue(input) {
        return { ok: true, receipt: { action: 'queue', principal, input } };
      }
    });
    const bridge = createMissionBridgeServer({
      token: bridgeToken,
      bootstrapProof: bridgeProof,
      allowedOrigins: ['http://127.0.0.1:4600'],
      actions: surface({ kind: 'owner-ui' }),
      actionsForPrincipal: surface,
      resolveAgentSessionCredential: credential => sessionAuthority.resolveAgentSessionCredential(credential, {
        routeFile: hostCapability,
        controlFile: hostControlCapability
      }),
      runtimeFile: bridgeRuntime,
      allowTestRuntimeFile: true,
      allowTestPortZero: true,
      runtimeDependencies: { platform: 'test' }
    });
    bridges.push(bridge);
    const bridgeAddress = await bridge.listen(0);
    const statusUrl = `${bridgeAddress.baseUrl}/v1/status`;
    const ownerStatus = await fetch(statusUrl, {
      headers: { authorization: `Bearer ${bridgeToken.toString('base64url')}` }
    });
    assert.equal(ownerStatus.status, 200);
    assert.deepEqual((await ownerStatus.json()).principal, { kind: 'owner-ui' },
      'the owner bearer was projected to an organisation coordinator');

    const codexStatus = await fetch(statusUrl, {
      headers: { authorization: `Session ${bound.credential}` }
    });
    assert.equal(codexStatus.status, 200);
    assert.deepEqual((await codexStatus.json()).principal, {
      kind: 'agent-session',
      sessionId: 'session-codex-root',
      agentId: 'root-alpha',
      provider: 'codex',
      roleId: 'release-captain',
      expectedOrgRevision: 7,
      expectedRoleRevision: 4
    });

    const claudeStatus = await fetch(statusUrl, {
      headers: { authorization: `Session ${claudeBinding.credential}` }
    });
    assert.equal(claudeStatus.status, 200);
    assert.equal((await claudeStatus.json()).principal.agentId, 'worker-beta');

    const forgedQueue = await fetch(`${bridgeAddress.baseUrl}/v1/actions/queue`, {
      method: 'POST',
      headers: {
        authorization: `Session ${bound.credential}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ actor: 'worker-beta', provider: 'claude' })
    });
    assert.equal(forgedQueue.status, 200);
    assert.equal((await forgedQueue.json()).receipt.principal.agentId, 'root-alpha',
      'caller body fields overrode the transport-bound mission principal');

    const agentOwnerPrompt = await fetch(`${bridgeAddress.baseUrl}/v1/owner-prompts`, {
      headers: { authorization: `Session ${bound.credential}` }
    });
    assert.equal(agentOwnerPrompt.status, 403,
      'an agent session credential reached an owner/UI-only route');
    const malformedSession = await fetch(statusUrl, {
      headers: { authorization: 'Session malformed' }
    });
    assert.equal(malformedSession.status, 401);

    assert.deepEqual(await host.revokeSession({
      ...bindingRequest,
      credential: bound.credential
    }), { revoked: true, mode: 'app-owned-owner-host' });
    await waitForSocketClose(client);
    assert.equal(dispatchSignal.aborted, true,
      'revoking the session must abort its authenticated connection dispatch signal');
    assert.deepEqual(await requestLine(hostPipe, {
      type: 'resolve-session',
      credential: bound.credential
    }), { type: 'session-refused', protocolVersion: 2 });
    const staleHttp = await fetch(statusUrl, {
      headers: { authorization: `Session ${bound.credential}` }
    });
    assert.equal(staleHttp.status, 401,
      'a revoked session credential remained replayable through direct loopback HTTP');
    const otherStillLive = await fetch(statusUrl, {
      headers: { authorization: `Session ${claudeBinding.credential}` }
    });
    assert.equal(otherStillLive.status, 200,
      'revoking one session revoked a different agent/provider session');
    /* A ROLE EDIT REBINDS THE RUNNING SESSION IN PLACE; IT IS NOT A REVOCATION.
       MEASURED 2026-09-19 on the owner's tree: services/custom-roles.json moved
       default:controller to rev 10 and default:manager to rev 9 while both
       ran, and capability/logs/owner-host-retirements.jsonl records six
       controller/manager sessions retired with reason per-line-recheck between
       03:03Z and 03:12Z -- "MCP server is not connected" for every one of them
       from that line on. The session below is authorized, its role is edited
       under it -- the revision moves AND its function sheet is narrowed -- and
       it must keep serving, with the EDITED sheet applied to its very next
       line, its credential re-issued against the NEW revision, and the rebind
       recorded exactly once. Asserted on the socket the agent actually talks
       through, on the resolve path the mission bridge uses, and on the verbs
       the app retains the ISSUED principal for -- by values, never by
       spelling. */
    const editedWorker = await connectSocket(hostPipe);
    clients.push(editedWorker);
    editedWorker.write(`${JSON.stringify({ type: 'authorize-session', credential: claudeBinding.credential })}\n`);
    assert.deepEqual(JSON.parse(await readLine(editedWorker)), { type: 'authorized', protocolVersion: 2 });
    const rebindsBefore = retirementEvents.filter(event => event.event === 'owner-host-session-rebound').length;
    authoritativeRoleRevisions.set('release-worker', 3);
    authoritativeRoleFunctions.set('release-worker', ['system.status', 'agent_comms.send_local']);
    const afterRoleEdit = { jsonrpc: '2.0', id: 'after-role-edit', method: 'tools/list', params: {} };
    editedWorker.write(`${JSON.stringify(afterRoleEdit)}\n`);
    assert.deepEqual(JSON.parse(await readLine(editedWorker)), {
      jsonrpc: '2.0', id: 'after-role-edit', result: { ok: true }
    }, 'editing a role ended the tool access of a running session holding that role');
    assert.deepEqual(dispatched.options.agentRole,
      { functions: ['agent_comms.send_local', 'system.status'], requiresDirectUserAuthorization: false },
      "the edited role sheet was not applied to the running session's next line");
    assert.equal(dispatched.options.agentPrincipal.expectedRoleRevision, 3,
      'the running session was not re-issued against the edited role revision');
    assert.equal(host.sessionBindings.has(claudeBinding.credential), true,
      'a role edit retired the binding of a running session');
    assert.equal(retirementEvents.filter(event => event.reason === 'per-line-recheck'
      && event.sessionId === 'session-claude-worker').length, 0,
    'a role edit was recorded as a per-line retirement of the running session');
    const rebinds = retirementEvents.filter(event => event.event === 'owner-host-session-rebound'
      && event.sessionId === 'session-claude-worker');
    assert.equal(rebinds.length - rebindsBefore, 1,
      'a moved role revision must be recorded as exactly one rebind of the running session');
    assert.deepEqual(rebinds.at(-1).detail,
      { roleId: 'release-worker', fromRoleRevision: 2, toRoleRevision: 3 },
      'the rebind record must name the role and the revisions it moved between');
    // A second line under the same revision is served and records nothing new.
    editedWorker.write(`${JSON.stringify({ ...afterRoleEdit, id: 'after-role-edit-2' })}\n`);
    assert.deepEqual(JSON.parse(await readLine(editedWorker)), {
      jsonrpc: '2.0', id: 'after-role-edit-2', result: { ok: true }
    });
    assert.equal(retirementEvents.filter(event => event.event === 'owner-host-session-rebound'
      && event.sessionId === 'session-claude-worker').length, rebinds.length,
    'an unchanged revision must not be recorded as another rebind on every line');
    // The resolve path the mission bridge uses names the re-issued revision.
    const roleEditedReplay = await fetch(statusUrl, {
      headers: { authorization: `Session ${claudeBinding.credential}` }
    });
    assert.equal(roleEditedReplay.status, 200,
      "a role edit revoked a running session's credential on the resolve path");
    assert.equal((await roleEditedReplay.json()).principal.expectedRoleRevision, 3,
      'the resolve path still names the revision the credential was issued against, not the one it was rebound to');
    // The app still holds the principal it BOUND with (revision 2). Every verb
    // it names the session by must still find it after the rebind, or the app
    // could no longer stop the session it started.
    const claudeIssued = {
      sessionId: 'session-claude-worker', agentId: 'worker-beta', provider: 'claude',
      roleId: 'release-worker', expectedOrgRevision: 7, expectedRoleRevision: 2
    };
    assert.deepEqual(await host.bindSession(claudeIssued), claudeBinding,
      'an exact retry with the issued principal was refused after the rebind');
    assert.deepEqual(host.assertSession({ ...claudeIssued, credential: claudeBinding.credential }),
      { valid: true, mode: 'app-owned-owner-host' },
      'the app could no longer validate the session by the principal it bound with');
    assert.deepEqual(await host.bindSession({ ...claudeIssued, expectedRoleRevision: 3 }), claudeBinding,
      'an exact retry naming the rebound revision was refused');

    /* THE SAME ROLE EDIT, THROUGH THE OTHER BIND DOOR.
       The app does not only call bindSession in process: agent-session-
       credential's bindAgentSessionCredential sends `bind-session` over the
       owner-host control socket, and that handler keeps its own copy of the
       collision check and its own copy of the binding record. A rebind that
       only reached the in-process door left the socket door refusing the
       running session by the very principal the app retains -- the role edit
       ending the session by a second route, with the control socket destroyed
       instead of a named refusal. Asserted by VALUES on a session that was
       created through the socket door: it keeps serving, and the app can still
       name it afterwards. */
    const socketBound = {
      type: 'bind-session',
      token: hostToken.toString('base64url'),
      sessionId: 'session-codex-socket-door',
      agentId: 'root-alpha',
      provider: 'codex',
      roleId: 'release-captain',
      expectedOrgRevision: authoritativeOrgRevision,
      expectedRoleRevision: authoritativeRoleRevisions.get('release-captain')
    };
    const controlBind = await connectSocket(hostPipe);
    clients.push(controlBind);
    controlBind.write(`${JSON.stringify(socketBound)}\n`);
    const socketBindReply = JSON.parse(await readLine(controlBind));
    assert.equal(socketBindReply.type, 'session-bound',
      'the control socket refused an ordinary first bind');
    const socketDoorCredential = socketBindReply.credential;
    const socketDoorWorker = await connectSocket(hostPipe);
    clients.push(socketDoorWorker);
    socketDoorWorker.write(`${JSON.stringify({ type: 'authorize-session', credential: socketDoorCredential })}\n`);
    assert.deepEqual(JSON.parse(await readLine(socketDoorWorker)), { type: 'authorized', protocolVersion: 2 });
    // The person saves that role in the Role library: its revision moves and
    // its function sheet narrows, while this session is running.
    authoritativeRoleRevisions.set('release-captain', 5);
    authoritativeRoleFunctions.set('release-captain', ['system.status']);
    socketDoorWorker.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 'socket-door-after-edit', method: 'tools/list', params: {}
    })}\n`);
    assert.deepEqual(JSON.parse(await readLine(socketDoorWorker)), {
      jsonrpc: '2.0', id: 'socket-door-after-edit', result: { ok: true }
    }, 'a role edit ended the tool access of a session bound through the control socket');
    assert.deepEqual(dispatched.options.agentRole,
      { functions: ['system.status'], requiresDirectUserAuthorization: false },
      "the edited role sheet was not applied to the socket-bound session's next line");
    assert.equal(dispatched.options.agentPrincipal.expectedRoleRevision, 5,
      'the socket-bound session was not re-issued against the edited role revision');
    // The app still holds revision 4 -- the principal it bound with. Naming
    // the session by it must still find it, and must answer with the SAME
    // credential, or the app can no longer revoke what it started.
    const retainedRebind = await connectSocket(hostPipe);
    clients.push(retainedRebind);
    retainedRebind.write(`${JSON.stringify(socketBound)}\n`);
    assert.deepEqual(JSON.parse(await readLine(retainedRebind)), {
      type: 'session-bound', protocolVersion: 2, credential: socketDoorCredential
    }, 'the control socket refused the running session by the principal the app bound with');
    // Revoked here so the role-removal leg below measures only its own session.
    const socketDoorRevoke = await connectSocket(hostPipe);
    clients.push(socketDoorRevoke);
    socketDoorRevoke.write(`${JSON.stringify({
      type: 'revoke-session',
      token: hostToken.toString('base64url'),
      sessionId: socketBound.sessionId,
      credential: socketDoorCredential
    })}\n`);
    assert.deepEqual(JSON.parse(await readLine(socketDoorRevoke)),
      { type: 'session-revoked', protocolVersion: 2 },
      'the app could no longer revoke the socket-bound session after its role was edited');
    assert.equal(host.sessionBindings.has(socketDoorCredential), false);
    authoritativeRoleFunctions.delete('release-captain');

    // A role that NO LONGER EXISTS under the credential's name is still a
    // completed "no": the seat points at nothing, so the next line ends it.
    const missingRoleWorker = await host.bindSession({
      sessionId: 'session-claude-orphan', agentId: 'worker-beta', provider: 'claude',
      roleId: 'release-worker', expectedOrgRevision: authoritativeOrgRevision, expectedRoleRevision: 3
    });
    const orphanSocket = await connectSocket(hostPipe);
    clients.push(orphanSocket);
    orphanSocket.write(`${JSON.stringify({ type: 'authorize-session', credential: missingRoleWorker.credential })}\n`);
    assert.deepEqual(JSON.parse(await readLine(orphanSocket)), { type: 'authorized', protocolVersion: 2 });
    authoritativeRoleRevisions.delete('release-worker');
    orphanSocket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'role-gone', method: 'tools/list', params: {} })}\n`);
    await waitForSocketClose(orphanSocket);
    assert.equal(host.sessionBindings.has(missingRoleWorker.credential), false,
      'a session whose role no longer exists kept its tool access');
    authoritativeRoleRevisions.set('release-worker', 3);
    // The app revokes by the principal it bound with, after the rebind.
    assert.deepEqual(await host.revokeSession({ ...claudeIssued, credential: claudeBinding.credential }),
      { revoked: true, mode: 'app-owned-owner-host' },
      'the app could no longer revoke the session by the principal it bound with');
    await waitForSocketClose(editedWorker);
    assert.equal(host.sessionBindings.has(claudeBinding.credential), false);
    await bridge.close();
    client.destroy();
    await host.close();
    hostToken.fill(0);
    assert.equal(fs.existsSync(hostCapability), false,
      'closing the host must remove only its own capability record');
    assert.equal(fs.existsSync(hostControlCapability), false,
      'closing the host must remove its owner-only control record');

    process.stdout.write('MCP owner-proxy lifecycle tests passed.\n');
  } finally {
    for (const client of clients) client.destroy();
    for (const bridge of bridges) await bridge.close().catch(() => {});
    for (const host of hosts) await host.close();
    for (const child of children) await stopChild(child);
    for (const item of servers) await closeServer(item.server, item.sockets);
    token.fill(0);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

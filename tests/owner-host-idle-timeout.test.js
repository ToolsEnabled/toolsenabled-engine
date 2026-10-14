'use strict';

// Defect (3), IDLE DEATH: the authorized data socket's liveness timeout was a
// fixed 30-minute constant that unconditionally destroyed the socket, and its
// destruction was silent. The first fix (idleTimeoutMs option + an observed
// destroy) made the kill observable but did not stop it. The second fix
// (armIdleTimeout re-arming instead of destroying a still-bound socket) was
// itself defeated by a second, independent bug Manager 5 measured directly:
// Socket#setTimeout(msecs, callback) ADDS a 'timeout' listener rather than
// replacing one, so the original handshake-reap listener stayed attached
// after authorization and destroyed the socket on the very first idle
// window regardless of what armIdleTimeout decided. The committed fix
// removes that specific listener, by the same function reference it was
// registered with, at the moment a socket is authorized.
//
// This drives a real owner-host with createOwnerHost({ idleTimeoutMs,
// handshakeTimeoutMs }) set to a few tens of milliseconds and asserts two
// things behaviourally, never via listenerCount or any other spelling pin:
// (1) the socket is genuinely still USABLE after the idle timeout fires --
// not merely that it is not yet destroyed, and not merely that an observer
// was called -- by sending a real line and reading a real dispatched
// response back across the fired timeout, repeated across several
// consecutive idle windows; and (2) a socket that never completes the
// handshake is still reaped within the (injected, millisecond) handshake
// bound, proving the fix for (1) did not weaken that separate check.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ownerHost = require('../src/owner-host.js');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const SCRATCH_ROOT = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'toolsenabled-owner-host-idle-timeout-'));
process.once('exit', () => { try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ } });

let checks = 0;
const checkAsync = async (label, fn) => {
  try { await fn(); }
  catch (error) {
    error.message = `[${label}] ${error.message}`;
    throw error;
  }
  checks += 1;
};

const TEST_PRINCIPALS = Object.freeze({
  ownerPrincipal: 'TESTHOST\\idle-timeout',
  clientPrincipal: 'TESTHOST\\idle-timeout'
});

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
    const timer = setTimeout(() => { cleanup(); reject(new Error('no line received in time')); }, timeoutMs);
    const onData = chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      cleanup();
      resolve(buffer.slice(0, end).replace(/\r$/, ''));
    };
    const onClose = () => { cleanup(); reject(new Error('socket closed before a line was received')); };
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('close', onClose); };
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.once('close', onClose);
  });
}

function waitForSocketClose(socket, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('socket was not closed in time')), timeoutMs);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

function neverCloses(socket, waitMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, waitMs);
    socket.once('close', () => { clearTimeout(timer); reject(new Error('socket closed when it must have survived')); });
  });
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const BIND = Object.freeze({
  sessionId: 'session-idle-timeout',
  agentId: 'agent-a',
  provider: 'claude',
  roleId: 'worker',
  expectedOrgRevision: 1,
  expectedRoleRevision: 1
});

function makeHost({ idleTimeoutMs, handshakeTimeoutMs, sessionRetirementObserver }) {
  const pipeName = `\\\\.\\pipe\\ToolsEnabledOwnerHostIdle-${process.pid}-${crypto.randomUUID()}`;
  const capabilityFile = path.join(SCRATCH_ROOT, `owner-host-idle-${crypto.randomUUID()}.json`);
  const broker = {
    MAX_MESSAGE_BYTES: 1024 * 1024,
    recordMcpSurface: () => {},
    resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
    processLine: async (line, respond) => {
      const request = JSON.parse(line);
      respond({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
    }
  };
  return ownerHost.createOwnerHost({
    allowTestPaths: true,
    pipeName,
    capabilityFile,
    controlCapabilityFile: `${capabilityFile}.control`,
    principals: TEST_PRINCIPALS,
    token: crypto.randomBytes(32),
    platform: 'test',
    credentialHygiene() {},
    readInstalledOrg(principal) {
      return {
        org: { revision: 1, agents: [{ id: 'agent-a', role: 'worker', provider: 'claude', enabled: true }] },
        roleRecord: { definition: { id: principal.roleId }, revision: 1 }
      };
    },
    idleTimeoutMs,
    handshakeTimeoutMs,
    sessionRetirementObserver,
    broker
  });
}

async function main() {
  await checkAsync('an authorized session that goes idle survives one full idle window, '
    + 'observed and genuinely still usable, not merely un-destroyed', async () => {
    const observed = [];
    const idleTimeoutMs = 60;
    const host = makeHost({ idleTimeoutMs, sessionRetirementObserver: record => observed.push(record) });
    try {
      await host.listen();
      const bound = await host.bindSession(BIND);
      const socket = await connectSocket(host.pipeName);
      socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
      assert.equal(JSON.parse(await readLine(socket)).type, 'authorized');

      // No activity at all for well over one idle window: the old behaviour
      // destroyed the socket here. The fix must not.
      await neverCloses(socket, idleTimeoutMs * 3);

      assert.ok(observed.length >= 1, 'the idle window elapsing on a live session must be observed');
      const survived = observed.find(record => record.reason === 'idle-timeout-survived');
      assert.ok(survived, `expected an 'idle-timeout-survived' record; saw: ${JSON.stringify(observed)}`);
      assert.equal(survived.event, 'owner-host-session-idle-timeout',
        'a survived idle window must not be labelled owner-host-session-retired -- nothing was retired');
      assert.equal(survived.sessionId, BIND.sessionId);
      assert.ok(!JSON.stringify(survived).includes(bound.credential),
        'the idle-timeout observation must never carry the credential value');
      assert.equal(observed.some(record => record.reason.includes('orphan')), false,
        'a still-bound session must never be reaped as an orphan');

      // The actual proof of "usable": a real line, dispatched and answered,
      // sent AFTER the fired timeout, on the SAME socket. This is exactly
      // the check that catches the stale-handshake-listener bug: with that
      // listener still attached, the socket was already destroyed by the
      // time this write happens, and readLine below would reject with
      // "socket closed before a line was received" instead of resolving.
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'after-idle', method: 'tools/call', params: {} })}\n`);
      assert.deepEqual(JSON.parse(await readLine(socket)).result, { ok: true });

      // And the bound must still be armed for the NEXT window, not spent
      // after firing once: let another full window of pure inactivity pass,
      // silent for several times the bound in total across both windows.
      const observedBeforeSecondWindow = observed.length;
      await neverCloses(socket, idleTimeoutMs * 3);
      assert.ok(observed.length > observedBeforeSecondWindow,
        'the liveness bound must re-arm and keep observing every subsequent idle window');
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'after-second-idle', method: 'tools/call', params: {} })}\n`);
      assert.deepEqual(JSON.parse(await readLine(socket)).result, { ok: true });
    } finally {
      await host.close();
    }
  });

  await checkAsync('activity inside the idle window is unaffected: no survive record is needed when never idle', async () => {
    const observed = [];
    const idleTimeoutMs = 80;
    const host = makeHost({ idleTimeoutMs, sessionRetirementObserver: record => observed.push(record) });
    try {
      await host.listen();
      const bound = await host.bindSession(BIND);
      const socket = await connectSocket(host.pipeName);
      socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
      assert.equal(JSON.parse(await readLine(socket)).type, 'authorized');

      // Send three lines, each inside the idle window, spanning more total
      // elapsed time than one window: a liveness bound keyed to a fixed
      // wall-clock deadline instead of true inactivity would still fire here.
      for (let i = 0; i < 3; i += 1) {
        await delay(Math.floor(idleTimeoutMs / 2));
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: `keepalive-${i}`, method: 'tools/call', params: {} })}\n`);
        assert.equal(JSON.parse(await readLine(socket)).result.ok, true);
      }
      assert.equal(socket.destroyed, false, 'an active session must not have been touched by the idle bound');
      assert.equal(observed.length, 0, 'a session that never went idle must not be observed at all');
    } finally {
      await host.close();
    }
  });

  await checkAsync('only a socket whose binding is already gone is reaped as an orphan on idle timeout', async () => {
    const observed = [];
    const idleTimeoutMs = 60;
    const host = makeHost({ idleTimeoutMs, sessionRetirementObserver: record => observed.push(record) });
    try {
      await host.listen();
      const bound = await host.bindSession(BIND);
      const socket = await connectSocket(host.pipeName);
      socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
      assert.equal(JSON.parse(await readLine(socket)).type, 'authorized');

      // Simulate the binding having left sessionBindings by some path that
      // did not reach this exact socket (see the comment on armIdleTimeout
      // in src/owner-host.js for why this is a defensive branch rather than
      // a normally-reachable one): remove it directly through the host's own
      // exposed sessionBindings map, without going through retireBinding, so
      // this socket is never told to close.
      assert.equal(host.sessionBindings.delete(bound.credential), true,
        'precondition: the credential must be present before the direct removal');

      await waitForSocketClose(socket);

      const reaped = observed.find(record => record.reason === 'idle-timeout-orphan-reaped');
      assert.ok(reaped, `expected an 'idle-timeout-orphan-reaped' record; saw: ${JSON.stringify(observed)}`);
      assert.equal(reaped.event, 'owner-host-session-idle-timeout');
      assert.equal(reaped.sessionId, BIND.sessionId);
      assert.equal(observed.some(record => record.reason === 'idle-timeout-survived'), false,
        'an orphaned socket must not also be recorded as surviving');
    } finally {
      await host.close();
    }
  });

  await checkAsync('a socket that never completes the handshake is still closed within the handshake bound, '
    + 'proving the authorize-time listener removal did not weaken it', async () => {
    const handshakeTimeoutMs = 60;
    const host = makeHost({ idleTimeoutMs: 60_000, handshakeTimeoutMs, sessionRetirementObserver: () => {} });
    try {
      await host.listen();
      // Connect and never send anything -- no bind-session, no authorize.
      // This socket never reaches armIdleTimeout at all; only the handshake
      // bound is in play, and it must still apply.
      const socket = await connectSocket(host.pipeName);
      await waitForSocketClose(socket);
    } finally {
      await host.close();
    }
  });

  console.log(`Owner-host idle-timeout tests passed (${checks} assertions).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Defect (2), UNKNOWN MERGED WITH DENIED: the per-line re-check used to fold
// "the org/role read threw" and "the org/role read completed and said no"
// into the same `false`, and treated both as a revocation -- destroying every
// socket of an authorized, running session on a transient read failure. This
// drives a real owner-host, a real socket, and a real injected reader that
// throws, and asserts on socket/response behaviour only.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ownerHost = require('../src/owner-host.js');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const SCRATCH_ROOT = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'toolsenabled-owner-host-unknown-vs-denied-'));
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
  ownerPrincipal: 'TESTHOST\\unknown-vs-denied',
  clientPrincipal: 'TESTHOST\\unknown-vs-denied'
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

function neverCloses(socket, waitMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, waitMs);
    socket.once('close', () => { clearTimeout(timer); reject(new Error('socket closed when it must have stayed open')); });
  });
}

function waitForSocketClose(socket, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('socket was not closed in time')), timeoutMs);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

const BIND = Object.freeze({
  sessionId: 'session-unknown-vs-denied',
  agentId: 'agent-a',
  provider: 'claude',
  roleId: 'worker',
  expectedOrgRevision: 1,
  expectedRoleRevision: 1
});

async function main() {
  await checkAsync('a read that throws refuses only the one line and keeps the session running; '
    + 'a read that completes and denies still retires', async () => {
    const pipeName = `\\\\.\\pipe\\ToolsEnabledOwnerHostUnknownVsDenied-${process.pid}-${crypto.randomUUID()}`;
    const capabilityFile = path.join(SCRATCH_ROOT, `owner-host-uvd-${crypto.randomUUID()}.json`);
    const observed = [];
    let mode = 'authorized'; // 'authorized' | 'throw' | 'denied'
    const broker = {
      MAX_MESSAGE_BYTES: 1024 * 1024,
      recordMcpSurface: () => {},
      resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
      processLine: async (line, respond) => {
        const request = JSON.parse(line);
        respond({ jsonrpc: '2.0', id: request.id, result: { ok: true, echoedId: request.id } });
      }
    };
    const host = ownerHost.createOwnerHost({
      allowTestPaths: true,
      pipeName,
      capabilityFile,
      controlCapabilityFile: `${capabilityFile}.control`,
      principals: TEST_PRINCIPALS,
      token: crypto.randomBytes(32),
      platform: 'test',
      credentialHygiene() {},
      readInstalledOrg(principal) {
        if (mode === 'throw') {
          // A store that is momentarily unreadable, locked, or mid-rewrite.
          throw new Error('simulated: role-memory store unreadable right now');
        }
        return {
          org: {
            revision: 1,
            agents: [{ id: 'agent-a', role: 'worker', provider: 'claude', enabled: mode !== 'denied' }]
          },
          roleRecord: { definition: { id: principal.roleId }, revision: 1 }
        };
      },
      sessionRetirementObserver: record => { observed.push(record); },
      broker
    });
    try {
      await host.listen();
      const bound = await host.bindSession(BIND);
      const socket = await connectSocket(host.pipeName);
      socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
      assert.equal(JSON.parse(await readLine(socket)).type, 'authorized');

      // A normal line dispatches while the read is healthy.
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'before', method: 'tools/call', params: {} })}\n`);
      assert.deepEqual(JSON.parse(await readLine(socket)).result, { ok: true, echoedId: 'before' });

      // The read starts throwing. The next line must be refused by itself --
      // a distinct JSON-RPC error, not dispatch, and not a dead socket --
      // while the observer records nothing, because nothing was retired.
      mode = 'throw';
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'during-outage', method: 'tools/call', params: {} })}\n`);
      const duringOutage = JSON.parse(await readLine(socket));
      assert.equal(duringOutage.id, 'during-outage');
      assert.ok(duringOutage.error, 'a line sent while the read throws must come back as an error, not a dispatch result');
      assert.notEqual(duringOutage.error.code, -32603,
        'an unknown-authorization refusal must be distinguishable from a plain internal error');
      assert.equal(observed.length, 0, 'a read that only threw must not retire the binding');

      // Prove the socket really is still alive and the binding still bound,
      // not merely slow to close: keep it open past a generous window, then
      // send another line while still in the outage.
      await neverCloses(socket, 200);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'still-during-outage', method: 'tools/call', params: {} })}\n`);
      const stillDuring = JSON.parse(await readLine(socket));
      assert.ok(stillDuring.error, 'the session must still be refusing lines by itself, not dispatching or dying');
      assert.equal(observed.length, 0);

      // The read recovers (still authorized). The very next line must
      // dispatch normally -- the transient failure left no lasting mark.
      mode = 'authorized';
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'after-recovery', method: 'tools/call', params: {} })}\n`);
      assert.deepEqual(JSON.parse(await readLine(socket)).result, { ok: true, echoedId: 'after-recovery' });
      assert.equal(observed.length, 0, 'recovering from an outage is not itself a retirement');

      // Now a read that COMPLETES and finds the seat disabled: this is a
      // real, known denial and must still retire and close the socket,
      // exactly as before this split.
      mode = 'denied';
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'denied', method: 'tools/call', params: {} })}\n`);
      await waitForSocketClose(socket);
      assert.equal(observed.length, 1, 'a completed, negative read must still retire the binding');
      assert.equal(observed[0].reason, 'per-line-recheck');
      assert.equal(observed[0].sessionId, BIND.sessionId);
    } finally {
      await host.close();
    }
  });

  await checkAsync('a bind attempt during an outage is refused without retiring the running session it collided with', async () => {
    const pipeName = `\\\\.\\pipe\\ToolsEnabledOwnerHostUnknownVsDeniedBind-${process.pid}-${crypto.randomUUID()}`;
    const capabilityFile = path.join(SCRATCH_ROOT, `owner-host-uvd-bind-${crypto.randomUUID()}.json`);
    const observed = [];
    let throwing = false;
    const broker = {
      MAX_MESSAGE_BYTES: 1024 * 1024,
      recordMcpSurface: () => {},
      resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
      processLine: async (line, respond) => {
        const request = JSON.parse(line);
        respond({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
      }
    };
    const host = ownerHost.createOwnerHost({
      allowTestPaths: true,
      pipeName,
      capabilityFile,
      controlCapabilityFile: `${capabilityFile}.control`,
      principals: TEST_PRINCIPALS,
      token: crypto.randomBytes(32),
      platform: 'test',
      credentialHygiene() {},
      readInstalledOrg(principal) {
        if (throwing) throw new Error('simulated: org overlay unreadable right now');
        return {
          org: { revision: 1, agents: [{ id: 'agent-a', role: 'worker', provider: 'claude', enabled: true }] },
          roleRecord: { definition: { id: principal.roleId }, revision: 1 }
        };
      },
      sessionRetirementObserver: record => { observed.push(record); },
      broker
    });
    try {
      await host.listen();
      const bound = await host.bindSession(BIND);
      const socket = await connectSocket(host.pipeName);
      socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
      assert.equal(JSON.parse(await readLine(socket)).type, 'authorized');

      throwing = true;
      // An exact retry of the running binding, attempted while the read
      // throws. This must fail as a bind attempt, but it must NOT tear down
      // the already-authorized socket above.
      await assert.rejects(host.bindSession(BIND), error => {
        assert.equal(error.code, 'OWNER_HOST_SESSION_UNKNOWN');
        return true;
      });
      assert.equal(observed.length, 0, 'a bind attempt refused for an unknown read must not retire anything');
      await neverCloses(socket, 200);

      throwing = false;
      // Once the read recovers, the running session's own line still works.
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'still-alive', method: 'tools/call', params: {} })}\n`);
      assert.equal(JSON.parse(await readLine(socket)).result.ok, true);
    } finally {
      await host.close();
    }
  });

  console.log(`Owner-host per-line unknown-vs-denied tests passed (${checks} assertions).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

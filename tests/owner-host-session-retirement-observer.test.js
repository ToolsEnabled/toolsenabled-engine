'use strict';

// Defect (1), SILENCE: retireBinding used to delete a credential and destroy
// every socket bound to it without anything anywhere recording that it
// happened. This drives the real owner-host module -- real sockets over a
// real named pipe, a real bindSession/revokeSession call, a real per-line
// dispatch -- and asserts on what an injected observer actually received,
// never on source text.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ownerHost = require('../src/owner-host.js');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const SCRATCH_ROOT = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'toolsenabled-owner-host-retire-obs-'));
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
  ownerPrincipal: 'TESTHOST\\retirement-observer',
  clientPrincipal: 'TESTHOST\\retirement-observer'
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

let orgEnabled = true;

function makeHost(observed, extra = {}) {
  const pipeName = `\\\\.\\pipe\\ToolsEnabledOwnerHostRetireObs-${process.pid}-${crypto.randomUUID()}`;
  const capabilityFile = path.join(SCRATCH_ROOT, `owner-host-retire-obs-${crypto.randomUUID()}.json`);
  const controlCapabilityFile = `${capabilityFile}.control`;
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
    controlCapabilityFile,
    principals: TEST_PRINCIPALS,
    token: crypto.randomBytes(32),
    platform: 'test',
    credentialHygiene() {},
    readInstalledOrg(principal) {
      return {
        org: { revision: 1, agents: [{ id: 'agent-a', role: 'worker', provider: 'claude', enabled: orgEnabled }] },
        roleRecord: { definition: { id: principal.roleId }, revision: 1 }
      };
    },
    sessionRetirementObserver: record => { observed.push(record); },
    broker,
    ...extra
  });
}

const BIND = Object.freeze({
  sessionId: 'session-retire-observer',
  agentId: 'agent-a',
  provider: 'claude',
  roleId: 'worker',
  expectedOrgRevision: 1,
  expectedRoleRevision: 1
});

async function main() {
  // --- reason: 'revoke', and the record names no credential and no argument ---
  await checkAsync('an explicit revoke calls the observer once, with reason "revoke" and only the sessionId', async () => {
    orgEnabled = true;
    const observed = [];
    const host = makeHost(observed);
    try {
      await host.listen();
      const bound = await host.bindSession(BIND);
      const socket = await connectSocket(host.pipeName);
      socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
      assert.equal(JSON.parse(await readLine(socket)).type, 'authorized');

      // A tool-call line carrying a distinctive, secret-shaped argument. The
      // observer must never see it -- it is not on the retire path at all
      // until the credential itself is revoked below.
      const SENTINEL_ARGUMENT = 'do-not-observe-this-argument-4f11c2';
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 'call-1', method: 'tools/call',
        params: { name: 'noop', arguments: { secret: SENTINEL_ARGUMENT } }
      })}\n`);
      assert.equal(JSON.parse(await readLine(socket)).result.ok, true);
      assert.equal(observed.length, 0, 'no retirement happened yet; the observer must stay silent until one does');

      const revoked = await host.revokeSession({ ...BIND, credential: bound.credential });
      assert.equal(revoked.revoked, true);
      await waitForSocketClose(socket);

      assert.equal(observed.length, 1, 'exactly one retirement must be observed for one revoke');
      assert.equal(observed[0].reason, 'revoke');
      assert.equal(observed[0].sessionId, BIND.sessionId);
      const serialized = JSON.stringify(observed[0]);
      assert.ok(!serialized.includes(bound.credential), 'the observer record must never carry the credential value');
      assert.ok(!serialized.includes(SENTINEL_ARGUMENT), 'the observer record must never carry a tool argument');
    } finally {
      await host.close();
    }
  });

  // --- reason: 'per-line-recheck', firing exactly when a running line dies ---
  await checkAsync('a per-line authorization loss calls the observer with reason "per-line-recheck" before the socket dies', async () => {
    orgEnabled = true;
    const observed = [];
    const host = makeHost(observed);
    try {
      await host.listen();
      const bound = await host.bindSession(BIND);
      const socket = await connectSocket(host.pipeName);
      socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
      assert.equal(JSON.parse(await readLine(socket)).type, 'authorized');

      orgEnabled = false; // the seat is disabled on the org side -- a completed, negative read
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'call-2', method: 'tools/call', params: {} })}\n`);
      await waitForSocketClose(socket);

      assert.equal(observed.length, 1);
      assert.equal(observed[0].reason, 'per-line-recheck');
      assert.equal(observed[0].sessionId, BIND.sessionId);
    } finally {
      await host.close();
    }
  });

  // --- the default (uninjected) observer: durable file first, stderr as a
  // secondary mirror only. A packaged Electron build commonly does not
  // capture this process's stderr, so the file -- not the console line -- is
  // the record a person can actually read after the fact. ---
  await checkAsync('with no observer supplied, production durably records a retirement to its log file, '
    + 'and stderr is a mirror, not the record', async () => {
    orgEnabled = true;
    const pipeName = `\\\\.\\pipe\\ToolsEnabledOwnerHostRetireObsDefault-${process.pid}-${crypto.randomUUID()}`;
    const capabilityFile = path.join(SCRATCH_ROOT, `owner-host-retire-obs-default-${crypto.randomUUID()}.json`);
    const sessionRetirementLogFile = path.join(SCRATCH_ROOT, `owner-host-retirements-${crypto.randomUUID()}.jsonl`);
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
      sessionRetirementLogFile,
      principals: TEST_PRINCIPALS,
      token: crypto.randomBytes(32),
      platform: 'test',
      credentialHygiene() {},
      readInstalledOrg(principal) {
        return {
          org: { revision: 1, agents: [{ id: 'agent-a', role: 'worker', provider: 'claude', enabled: orgEnabled }] },
          roleRecord: { definition: { id: principal.roleId }, revision: 1 }
        };
      },
      broker
      // sessionRetirementObserver deliberately omitted: exercise the default.
    });
    // Prove the file survives even when stderr genuinely goes nowhere, which
    // is exactly the packaged-build condition this default exists for.
    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    // Declared out here, not inside the try, because the credential value is
    // needed by the last assertion below -- which checks that the durable log
    // does NOT contain it, and so cannot run without it.
    let bound = null;
    try {
      await host.listen();
      bound = await host.bindSession(BIND);
      await host.revokeSession({ ...BIND, credential: bound.credential });
    } finally {
      process.stderr.write = originalWrite;
      await host.close();
    }
    assert.ok(fs.existsSync(sessionRetirementLogFile), 'the default observer must have created its durable log file');
    const lines = fs.readFileSync(sessionRetirementLogFile, 'utf8').trim().split('\n');
    const recorded = lines
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .find(parsed => parsed && parsed.reason === 'revoke' && parsed.sessionId === BIND.sessionId);
    assert.ok(recorded, `the durable log file must contain the revoke; saw: ${JSON.stringify(lines)}`);
    assert.ok(!JSON.stringify(recorded).includes(bound.credential),
      'the durable log file must never carry the credential value');
  });

  console.log(`Owner-host session-retirement observer tests passed (${checks} assertions).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

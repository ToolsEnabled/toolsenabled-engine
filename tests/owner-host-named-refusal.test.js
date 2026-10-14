'use strict';

// THE ZERO-ARGUMENT CATCH. Both dispatch seams in src/owner-host.js caught the
// rejection without binding it -- `.catch(() => respond(internalError(line)))`
// -- so a handler that refused with a code naming its own refusal had that code
// and its classification discarded unconditionally, and the calling agent read
// "Internal error." instead.
//
// This is why 24e60a96 (error-taxonomy: register the tree-command refusal
// family) could not do what it exists for: reclassifying a code cannot help at
// a seam that never looks at the error. That commit is LIVE in the running
// engine, so its own ledger verification is measuring a rescue that never
// reaches the socket.
//
// Asserted by BEHAVIOUR, through a real owner-host, a real named pipe and a
// real handshake: push a line whose handler rejects with a real
// MC_TREE_COMMAND_* code and read what comes back off the wire. The expected
// sentence is COMPUTED from the taxonomy, never spelled out here, so a better
// taxonomy sentence still passes and only a lost rescue fails.
//
// Both seams are covered, because they are two separate catches: the scheduled
// lane (broker.createLineDispatcher present) and the serial chain (absent).
//
// Never the raw message: the socket-error comment beside these lines is the
// reason -- no peer data. Each rejection carries a sentinel string in its
// message and every assertion checks the whole serialized response for it.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ownerHost = require('../src/owner-host.js');
const taxonomy = require('../src/lib/error-taxonomy.js');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const SCRATCH_ROOT = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'toolsenabled-owner-host-named-refusal-'));
process.once('exit', () => { try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ } });

// Not a credential and not peer data -- a marker that stands in for whatever a
// handler's raw message happens to contain, so "never the raw message" can be
// asserted rather than assumed.
const RAW_MESSAGE_SENTINEL = 'raw-handler-detail-that-must-not-reach-the-wire';

// The six codes 24e60a96 rescued. Their sentences are read from the taxonomy at
// assertion time; nothing here pins a spelling.
const NAMED_REFUSAL_CODES = Object.freeze([
  'MC_TREE_COMMAND_NOT_BELOW_CALLER',
  'MC_TREE_COMMAND_REMOVE_NOT_BELOW_CALLER',
  'MC_TREE_COMMAND_CALLER_UNKNOWN',
  'MC_TREE_COMMAND_REMOVE_CALLER_UNKNOWN',
  'MC_TREE_COMMAND_REMOVE_PERSON_SPOKE',
  'MC_TREE_COMMAND_REMOVE_NOT_AGENT_MADE'
]);

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
  ownerPrincipal: 'TESTHOST\\named-refusal',
  clientPrincipal: 'TESTHOST\\named-refusal'
});

const BIND = Object.freeze({
  sessionId: 'session-named-refusal',
  agentId: 'agent-a',
  provider: 'claude',
  roleId: 'worker',
  expectedOrgRevision: 1,
  expectedRoleRevision: 1
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

function refusalFor(code) {
  const error = new Error(`${RAW_MESSAGE_SENTINEL}: refused because ${code}`);
  error.code = code;
  return error;
}

// One host whose dispatch rejects with whatever the current case asks for.
// `lane` selects which of the two catches is exercised: the scheduled lane is
// reached only when the broker offers createLineDispatcher and the caller
// injected no dispatchLine of its own.
async function withHost(lane, run) {
  const pipeName = `\\\\.\\pipe\\ToolsEnabledOwnerHostNamedRefusal-${process.pid}-${crypto.randomUUID()}`;
  const capabilityFile = path.join(SCRATCH_ROOT, `owner-host-named-refusal-${crypto.randomUUID()}.json`);
  let nextRejection = null;
  const dispatch = async line => {
    const request = JSON.parse(line);
    if (nextRejection) throw nextRejection;
    return request;
  };
  const broker = {
    MAX_MESSAGE_BYTES: 1024 * 1024,
    recordMcpSurface: () => {},
    resolvePermissionSession: () => ({ origin: 'local', tier: 'full' }),
    processLine: async (line, respond) => {
      if (nextRejection) throw nextRejection;
      respond({ jsonrpc: '2.0', id: JSON.parse(line).id, result: { ok: true } });
    },
    ...(lane === 'scheduled'
      ? { createLineDispatcher: () => (line, respond) => dispatch(line).then(request => {
        respond({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
      }) }
      : {})
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
      return {
        org: { revision: 1, agents: [{ id: 'agent-a', role: 'worker', provider: 'claude', enabled: true }] },
        roleRecord: { definition: { id: principal.roleId }, revision: 1 }
      };
    },
    sessionRetirementObserver: () => {},
    broker
  });
  try {
    await host.listen();
    const bound = await host.bindSession(BIND);
    const socket = await connectSocket(host.pipeName);
    socket.write(`${JSON.stringify({ type: 'authorize-session', credential: bound.credential })}\n`);
    assert.equal(JSON.parse(await readLine(socket)).type, 'authorized',
      'the handshake must succeed before anything about dispatch can be measured');

    // Prove this lane is really the one under test: with no rejection armed the
    // line dispatches, so a later failure is the catch and not a dead harness.
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'warmup', method: 'tools/call', params: {} })}\n`);
    assert.deepEqual(JSON.parse(await readLine(socket)).result, { ok: true },
      `the ${lane} lane must dispatch normally before a rejection is armed`);

    const sendAndRead = async (id, rejection) => {
      nextRejection = rejection;
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {} })}\n`);
      const response = JSON.parse(await readLine(socket));
      nextRejection = null;
      return response;
    };
    await run(sendAndRead, lane);
  } finally {
    await host.close();
  }
}

async function main() {
  for (const lane of ['serial', 'scheduled']) {
    await checkAsync(`${lane} lane: a named MC_TREE_COMMAND_* refusal reaches the caller as its own code and sentence`, async () => {
      await withHost(lane, async sendAndRead => {
        for (const [index, code] of NAMED_REFUSAL_CODES.entries()) {
          // The id deliberately does NOT contain the code: an id that echoed it
          // would make the "named code survived" assertion below pass on the
          // echo alone, which is exactly the vacuous check this seam deserves
          // least.
          const requestId = `refusal-${index}`;
          const expected = taxonomy.publicFailure(refusalFor(code));
          const response = await sendAndRead(requestId, refusalFor(code));
          const serialized = JSON.stringify(response);

          assert.equal(response.id, requestId, `${code}: the refusal must answer the line that caused it`);
          assert.ok(response.error, `${code}: a refused line must come back as an error`);

          // The taxonomy already knows this code is a refusal, not a crash.
          // That is the whole point of 24e60a96, so assert it here rather than
          // trusting it: if this fails, the fixture is wrong, not the seam.
          assert.notEqual(expected.code, 'INTERNAL_ERROR',
            `${code}: fixture check -- the taxonomy must classify this code away from INTERNAL_ERROR`);

          assert.ok(serialized.includes(code),
            `${code}: the named code must survive to the caller; got ${serialized}`);
          assert.equal(response.error.message, expected.safeSummary,
            `${code}: the caller must read the taxonomy's sentence for this code`);
          assert.notEqual(response.error.message, 'Internal error.',
            `${code}: a named refusal must not be flattened to the internal-error text`);
          assert.ok(!serialized.includes(RAW_MESSAGE_SENTINEL),
            `${code}: the handler's raw message must never reach the wire`);
        }
      });
    });

    await checkAsync(`${lane} lane: control -- an unnamed throw still yields internalError(line)`, async () => {
      await withHost(lane, async sendAndRead => {
        const unnamed = new Error(`${RAW_MESSAGE_SENTINEL}: something simply broke`);
        const response = await sendAndRead('unnamed-throw', unnamed);
        assert.deepEqual(response, {
          jsonrpc: '2.0',
          id: 'unnamed-throw',
          error: { code: -32603, message: 'Internal error.' }
        }, 'an error the taxonomy cannot name must still be the plain internal error, unchanged');
        assert.ok(!JSON.stringify(response).includes(RAW_MESSAGE_SENTINEL),
          'the unnamed error message must not reach the wire either');
      });
    });

    await checkAsync(`${lane} lane: control -- a code the taxonomy cannot name is not dressed up as a refusal`, async () => {
      await withHost(lane, async sendAndRead => {
        // A code-carrying error whose code the taxonomy still maps to
        // INTERNAL_ERROR must be treated as a crash, not promoted merely for
        // having a `code` property.
        const opaque = new Error(`${RAW_MESSAGE_SENTINEL}: opaque`);
        opaque.code = 'MC_TREE_COMMAND_QQQ_UNCLASSIFIABLE_XYZ';
        const classified = taxonomy.publicFailure(opaque);
        const response = await sendAndRead('opaque-code', opaque);
        if (classified.code === 'INTERNAL_ERROR') {
          assert.deepEqual(response, {
            jsonrpc: '2.0',
            id: 'opaque-code',
            error: { code: -32603, message: 'Internal error.' }
          }, 'a code the taxonomy cannot classify must fall back to internalError, not leak its own spelling');
        } else {
          assert.equal(response.error.message, classified.safeSummary,
            'if the taxonomy does name this code, the caller must read that sentence');
        }
        assert.ok(!JSON.stringify(response).includes(RAW_MESSAGE_SENTINEL),
          'the raw message must never reach the wire');
      });
    });
  }

  console.log(`Owner-host named refusal tests passed (${checks} checks).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

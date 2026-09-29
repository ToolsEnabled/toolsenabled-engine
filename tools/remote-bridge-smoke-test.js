#!/usr/bin/env node
'use strict';

// Verifies what is actually testable FROM MACHINE A now that the bridge's
// peer allowlist is pinned to machine B's exact registry-declared address:
// this machine's own address must be REFUSED at the connection gate, before
// authorization is even attempted. That refusal is the security property;
// it is not a failure mode to work around.
//
// The full authorize -> tools/list -> tools/call path can only be exercised
// by the real peer (machine B) now -- there is no way to test it from A
// without weakening the exact pinning this file exists to prove. Ask B to
// run tools/list and report the count instead (expected: fewer than the
// full registry, since clipboard/screen/ocr/host.exec are excluded from the
// remote profile -- see src/remote-agent-bridge.js's
// computeRemoteProfileAllowlist).
const net = require('node:net');
const { getSecret } = require('../src/lib/runtime');
const { peerMachineForAddress, resolveService } = require('../src/lib/service-registry');

// THE DIAL TARGET IS RESOLVED, NOT HARDCODED (R1116/R1117). This module used
// to default HOST to the literal '203.0.113.2' -- Machine A's own address.
// Unlike a caller-selected or agent-comms.js default, dialing the
// WRONG machine is not the risk class here: this test's entire point is to
// dial THIS machine's own address on purpose, to prove the bridge refuses a
// same-machine connection as a peer. The risk of the literal is narrower but
// real: run anywhere other than Machine A (or reason about this file
// generically) and '203.0.113.2' stops meaning "myself" and silently
// starts meaning "a specific other host", which breaks the self-dial premise
// and produces a misleading pass/fail. It now resolves role
// 'local-peer-tool-bridge-diagnostic' (self resolution, added migrating this
// file and tools/tunnel-bridge-health.js -- see
// config/service-registry.json) so the dialed address always tracks this
// process's own detected identity instead of a fixed guess, and refuses with
// a named error instead of guessing when that identity cannot be told. See
// docs/coordinator/MECHANIZE-NOT-REMEMBER.md item 1.
const REMOTE_BRIDGE_DIAGNOSTIC_SERVICE_ID = 'local-peer-tool-bridge-diagnostic';
const PORT = 8788;

class RemoteBridgeSmokeTestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemoteBridgeSmokeTestError';
    this.code = code;
  }
}

// Resolves this machine's own direct-link address BY ROLE. Never called at
// module load; only from inside main() below. Fails closed with a named
// error rather than falling back to a literal host.
function resolveOwnAddress(resolveServiceFn = resolveService) {
  const resolved = resolveServiceFn(REMOTE_BRIDGE_DIAGNOSTIC_SERVICE_ID);
  if (!resolved.ok) {
    throw new RemoteBridgeSmokeTestError('REMOTE_BRIDGE_SMOKE_TEST_ENDPOINT_UNRESOLVED',
      `This machine's own bridge-listener address could not be resolved (${resolved.code}): ${resolved.reason}`);
  }
  return resolved.host;
}

function readOneLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onClose = () => {
      socket.removeListener('data', onData);
      if (buffer.length > 0) {
        reject(new RemoteBridgeSmokeTestError(
          'REMOTE_BRIDGE_SMOKE_TEST_RESPONSE_TRUNCATED',
          `Bridge closed after sending ${Buffer.byteLength(buffer, 'utf8')} response bytes without a newline.`
        ));
        return;
      }
      resolve(null); // the connection gate refuses a peer by closing without writing anything
    };
    const onData = chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        socket.removeListener('data', onData);
        socket.removeListener('close', onClose);
        try {
          resolve(JSON.parse(buffer.slice(0, end)));
        } catch (error) {
          reject(error);
        }
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', onClose);
  });
}

async function main() {
  const token = getSecret('custom.remote_agent_bridge_token', { prompt: false });
  const host = resolveOwnAddress();
  const peerHost = peerMachineForAddress(host).address;
  const socket = net.createConnection(PORT, host);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.setEncoding('utf8');

  socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
  const reply = await readOneLine(socket);
  console.log(`connection from this machine's own address (${host}) ->`, reply === null ? 'refused (socket closed, no response)' : JSON.stringify(reply));

  const refused = reply === null;
  console.log(refused
    ? `SMOKE TEST: PASS (this machine is correctly refused as a peer -- only ${peerHost} may authenticate)`
    : 'SMOKE TEST: FAIL (this machine should never be able to authenticate to its own bridge)');
  console.log(`To verify the full authorize/tools-list/tools-call path, ask machine B (${peerHost}) to run it -- that is the only registry address this bridge now accepts.`);
  process.exitCode = refused ? 0 : 1;
}

// Guarded so tests can require() this file for resolveOwnAddress/PORT/etc.
// without triggering a real getSecret + socket connection as a side effect
// of the import -- main() previously ran unconditionally at module load.
if (require.main === module) {
  main().catch(error => {
    console.error('SMOKE TEST: ERROR', error && error.message);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  PORT,
  REMOTE_BRIDGE_DIAGNOSTIC_SERVICE_ID,
  RemoteBridgeSmokeTestError,
  resolveOwnAddress,
  main
});

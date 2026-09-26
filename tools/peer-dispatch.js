#!/usr/bin/env node
'use strict';
// peer-dispatch -- send work to the OTHER machine and read the result back,
// over the authenticated 8788 bridge, with no agent session awake there.
//
// This is the customer-facing direct-peer dispatch path: either registered
// machine can submit work to its sole peer without an interactive session
// already running there.
//
// THE SHAPE, AND WHY IT IS THIS SHAPE. Work is DISPATCHED, not executed
// remotely. This tool submits a durable record; a worker on the peer claims it
// and runs it as a LOCAL principal with full local powers. That is deliberate:
//   - host.exec is withheld from the bridge on purpose. An adversarial review on
//     2026-07-30 found it decrypts the DPAPI vault through a real shell, which
//     breaks "use credentials, never see them", and it remains parked pending an
//     owner decision on supervision.
//   - An agent running ON the peer already has host.exec locally, because it is
//     local. So dispatching a mission gets the full capability with NO credential
//     crossing the link and no boundary weakened.
// Remote shell would have been the smaller change and the worse one.
//
// This tool never needs the peer's agent session. It needs the peer's WORKER,
// which is a different thing: a registered, reboot-surviving process that claims
// queued work.

const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { RemoteAgentMcpProxy } = require(path.join(ROOT, 'tools', 'remote-agent-mcp-proxy.js'));
const { directionalMachinePair, loadRegistry } = require('../src/lib/service-registry');

function resolvePeerTopology(serviceRegistryOptions = {}) {
  const registry = loadRegistry(serviceRegistryOptions);
  const pair = directionalMachinePair({ registry });
  const machines = [pair.coordinatorMachine, pair.recipientMachine];
  const byAddress = new Map(machines.map(machine => [machine.address, machine]));
  return Object.freeze({ machines: Object.freeze(machines), byAddress });
}

function localHost({ topology = resolvePeerTopology(), networkInterfaces = require('node:os').networkInterfaces } = {}) {
  const addresses = new Set();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) if (entry && entry.family === 'IPv4') addresses.add(entry.address);
  }
  const found = topology.machines.map(machine => machine.address).filter(address => addresses.has(address));
  // Exactly one, or we do not know which machine we are and must not guess.
  return found.length === 1 ? found[0] : null;
}

function usage() {
  process.stdout.write([
    'peer-dispatch -- dispatch work to the peer machine over the 8788 bridge',
    '',
    '  node tools/peer-dispatch.js probe',
    '      Is the peer reachable, and does it have a LIVE worker able to execute?',
    '      Reports the two separately: reachable is not the same as able to run.',
    '',
        '  node tools/peer-dispatch.js tasks [--queue <q>] [--limit <n>]',
    ''
  ].join('\n'));
}

async function connect({ serviceRegistryOptions = {}, networkInterfaces, Proxy = RemoteAgentMcpProxy } = {}) {
  const topology = resolvePeerTopology(serviceRegistryOptions);
  const local = localHost({ topology, ...(networkInterfaces ? { networkInterfaces } : {}) });
  if (!local) throw new Error('this machine holds neither or both direct-link addresses; refusing to guess a peer');
  const peerMachine = topology.machines.find(machine => machine.address !== local);
  const peer = peerMachine.address;
  const proxy = new Proxy({
    host: peer, localHost: local, expectedRoot: peerMachine.root,
    enabledValue: '1', timeoutMs: 120000
  });
  await proxy.request({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'peer-dispatch', version: '1.0' } }
  });
  return { proxy, local, peer };
}

let callId = 10;
async function call(proxy, name, args) {
  const res = await proxy.request({
    jsonrpc: '2.0', id: callId++, method: 'tools/call', params: { name, arguments: args }
  });
  if (res && res.error) throw new Error(`${name}: ${res.error.code || res.error.message}`);
  const result = res && res.result;
  // A refusal arrives as isError INSIDE the result, not as a JSON-RPC error.
  // Checking only res.error reports a refused call as a success -- that exact
  // mistake was made while building this lane and must not be repeated here.
  if (result && result.isError) {
    const inner = (result.structuredContent && result.structuredContent.error) || {};
    throw new Error(`${name} refused: ${inner.code || 'UNKNOWN'} ${(inner.message || '').slice(0, 160)}`);
  }
  return (result && result.structuredContent) || result;
}

function arg(argv, flag, fallback = null) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

async function main(argv = process.argv) {
  const command = argv[2];
  if (!command || command === '--help' || command === '-h') { usage(); process.exit(0); }

  let session;
  try {
    session = await connect();
    const { proxy, local, peer } = session;

    if (command === 'probe') {
      const status = await call(proxy, 'system.status', {});
      // Reachability is the only fact this probe can report since the local
      // durable-worker lifecycle left the tool surface: a peer that answers is
      // not a peer that will run your work, so no execution verdict is claimed.
      process.stdout.write(JSON.stringify({
        ok: true,
        local, peer,
        peerRoot: (status && status.root) || null,
        reachable: true,
        verdict: 'peer is reachable; whether it executes dispatched work is not observable from here'
      }, null, 2) + '\n');
      process.exit(0);
    }

    if (command === 'tasks') {
      const args = {};
      if (arg(argv, '--queue')) args.queue = arg(argv, '--queue');
      args.limit = Number(arg(argv, '--limit', '20'));
      process.stdout.write(JSON.stringify({ ok: true, tasks: await call(proxy, 'task.list', args) }, null, 2) + '\n');
      process.exit(0);
    }

    usage();
    throw new Error(`unknown command '${command}'`);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((error && error.message) || error).slice(0, 400) }, null, 2) + '\n');
    process.exitCode = 1;
  } finally {
    if (session && session.proxy) {
      try { session.proxy.closed = true; session.proxy._dropSocket({ code: 'DONE' }); } catch {}
    }
    setImmediate(() => process.exit(process.exitCode || 0));
  }
}

if (require.main === module) main();

module.exports = Object.freeze({ arg, call, connect, localHost, main, resolvePeerTopology });

#!/usr/bin/env node
'use strict';

// Safe bridge liveness/auth check for ServerControl. The token is read and
// used in-process only; output is limited to booleans and a tool count.
const net = require('node:net');
const os = require('node:os');
const { getSecret } = require('../src/lib/runtime');
const { directionalMachinePair, loadRegistry } = require('../src/lib/service-registry');

const PORT = Number(process.env.REMOTE_AGENT_BRIDGE_PORT || 8788);
// Machine addresses/roots come from config/service-registry.json (single
// source of truth), never a literal here -- see src/lib/service-registry.js.
function registeredPair() {
  const topology = directionalMachinePair({ registry: loadRegistry() });
  return Object.freeze([topology.coordinatorMachine, topology.recipientMachine]);
}

function discoverPeer(machines) {
  const local = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal && machines.some(machine => item.address === machine.address)) local.add(item.address);
    }
  }
  if (local.size !== 1) return null;
  const localMachine = machines.find(machine => local.has(machine.address));
  return localMachine ? machines.find(machine => machine.machineId !== localMachine.machineId).address : null;
}

function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('timeout', onTimeout);
      resolve(value);
    };
    const onError = error => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('timeout', onTimeout);
      reject(error);
    };
    const onClose = () => finish(null);
    const onTimeout = () => finish(null);
    const onData = chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try { finish(JSON.parse(buffer.slice(0, end))); } catch { finish(null); }
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('timeout', onTimeout);
  });
}

async function main() {
  const machines = registeredPair();
  const peer = process.env.REMOTE_AGENT_BRIDGE_PEER || discoverPeer(machines);
  // ServerControl also uses this bounded probe for the local listener. Allow an
  // explicit target so a stale local TCP listener cannot masquerade as a
  // healthy bridge.
  const target = process.env.REMOTE_AGENT_BRIDGE_TARGET || peer;
  if (!target) { console.log(JSON.stringify({ peer: null, tcpOk: null, authOk: null, toolsOk: null, rootMatches: null, unavailableReason: 'peer-not-discovered' })); return; }
  let token;
  try { token = getSecret('custom.remote_agent_bridge_token', { prompt: false }); }
  catch { console.log(JSON.stringify({ peer: target, tcpOk: null, authOk: null, toolsOk: null, rootMatches: null, unavailableReason: 'credential-unavailable' })); return; }
  const socket = net.createConnection({ host: target, port: PORT });
  socket.setEncoding('utf8');
  // 4s covered the TCP connect and the authorize/tools-list exchange, but not a
  // real tools/call: system.kill_switch_status on the peer measured between 15s
  // and 75s. The socket therefore timed out mid-call, readLine never resolved,
  // the catch below yielded killSwitchActive=null, safetyOk went false, and the
  // lifecycle reported "peer kill-switch status is unavailable" -- a false alarm
  // manufactured by this probe's own deadline, not a peer safety condition.
  socket.setTimeout(90000);
  const tcp = await new Promise(resolve => {
    socket.once('connect', () => resolve(true));
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => resolve(false));
  });
  if (!tcp) { socket.destroy(); console.log(JSON.stringify({ peer: target, tcpOk: false, authOk: null, toolsOk: null, rootMatches: null, unavailableReason: 'tcp-unavailable' })); return; }
  socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
  const auth = await readLine(socket);
  const authOk = auth && auth.type === 'authorized' ? true : auth && auth.type === 'unauthorized' ? false : null;
  if (authOk !== true) { socket.destroy(); console.log(JSON.stringify({ peer: target, tcpOk: true, authOk, toolsOk: null, rootMatches: null, unavailableReason: authOk === false ? 'authorization-rejected' : auth ? 'authorization-unparsable' : 'authorization-no-reply' })); return; }
  const targetMachine = machines.find(machine => target === machine.address);
  const expectedRoot = targetMachine ? targetMachine.root : null;
  const rootMatches = expectedRoot !== null && typeof auth.bridgeRoot === 'string'
    && auth.bridgeRoot.toLowerCase() === expectedRoot.toLowerCase()
    && auth.rootExists === true
    ? true
    : expectedRoot === null
      ? null
      : false;
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`);
  const listed = await readLine(socket);
  const tools = listed && listed.result && Array.isArray(listed.result.tools) ? listed.result.tools : null;
  const toolsRead = !listed ? 'no-reply' : listed.error ? 'peer-error' : Array.isArray(listed.result && listed.result.tools) ? 'ok' : 'unparsable';
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'system.kill_switch_status', arguments: {} } })}\n`);
  const status = await readLine(socket);
  socket.destroy();
  // A bare catch here collapsed "the RPC never answered", "the peer returned an
  // error", and "the peer answered false" into one indistinguishable null, which
  // is what made the timeout above so hard to diagnose. Keep the null (callers
  // depend on it) but also report WHY, so an operator can tell a stalled read
  // from a genuine unsafe state.
  let killSwitchActive = null;
  let killSwitchRead = 'ok';
  if (!status) {
    killSwitchRead = 'no-reply';
  } else if (status.error) {
    killSwitchRead = 'peer-error';
  } else {
    try {
      const text = status.result && status.result.content && status.result.content[0] && status.result.content[0].text;
      const parsed = JSON.parse(text);
      if (typeof parsed.killSwitchActive === 'boolean') killSwitchActive = parsed.killSwitchActive;
      else if (typeof parsed.active === 'boolean') killSwitchActive = parsed.active;
      else killSwitchRead = 'unparsable';
    } catch {
      killSwitchRead = 'unparsable';
    }
  }
  const unavailableReason = tools === null || tools.length === 0
    ? (toolsRead === 'ok' ? 'peer-returned-no-tools' : `tools-list-${toolsRead}`)
    : rootMatches === null
      ? 'peer-not-registered'
      : !rootMatches
      ? 'peer-root-mismatch'
      : killSwitchActive !== false
        ? `kill-switch-${killSwitchRead}`
        : undefined;
  console.log(JSON.stringify({ peer: target, tcpOk: true, authOk: true, toolsOk: tools === null ? null : tools.length > 0, toolsRead, toolCount: tools === null ? null : tools.length, peerRoot: auth.bridgeRoot || null, peerCwd: auth.workingDirectory || null, rootMatches, killSwitchActive, killSwitchRead, safetyOk: killSwitchActive === false, unavailableReason }));
}

main().catch(() => {
  process.exitCode = 1;
  console.log(JSON.stringify({ peer: null, tcpOk: null, authOk: null, toolsOk: null, unavailableReason: 'registry-or-probe-error' }));
});

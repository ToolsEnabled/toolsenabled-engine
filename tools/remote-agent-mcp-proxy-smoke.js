#!/usr/bin/env node
'use strict';

// Bounded native-MCP handoff smoke.  It launches the stdio proxy exactly as
// an MCP client would, then proves initialize -> tools/list -> one safe remote
// tools/call.  The proxy reads the bridge token from the local vault; this
// script never handles or prints it.

const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { directionalMachinePair, loadRegistry } = require('../src/lib/service-registry');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const ROOT = path.resolve(__dirname, '..');
const PROXY = path.join(__dirname, 'remote-agent-mcp-proxy.js');
const TIMEOUT_MS = Number(process.env.REMOTE_AGENT_MCP_SMOKE_TIMEOUT_MS || 30_000);

function readLine(stream, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try { finish(null, JSON.parse(buffer.slice(0, end))); }
      catch (error) { finish(new Error(`proxy returned invalid JSON: ${error.message}`)); }
    };
    const onEnd = () => finish(new Error('proxy stdout ended before a response was received'));
    const onError = error => finish(new Error(`could not read proxy response: ${error.message}`));
    const timer = setTimeout(() => finish(new Error(`proxy response timed out after ${timeoutMs}ms`)), timeoutMs);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

function request(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return readLine(child.stdout);
}

function discoverPeer(machines) {
  const addresses = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item && item.family === 'IPv4' && !item.internal
          && machines.some(machine => item.address === machine.address)) {
        addresses.add(item.address);
      }
    }
  }
  if (addresses.size !== 1) return null;
  const localMachine = machines.find(machine => addresses.has(machine.address));
  return localMachine ? machines.find(machine => machine.machineId !== localMachine.machineId).address : null;
}

async function main() {
  const registry = loadRegistry();
  const topology = directionalMachinePair({ registry });
  const machines = [topology.coordinatorMachine, topology.recipientMachine];
  const peer = process.env.REMOTE_AGENT_BRIDGE_PEER || discoverPeer(machines);
  if (!peer) throw new Error('could not discover the remote agent peer');
  const peerMachine = machines.find(machine => peer === machine.address);
  if (!peerMachine) {
    throw new Error('configured remote agent peer does not match a registry address');
  }
  const localHost = machines.find(machine => machine.machineId !== peerMachine.machineId).address;
  const expectedRoot = peerMachine.root;
  const child = spawn(process.execPath, [PROXY], {
    cwd: ROOT,
    env: safeLaunchEnvironment({
      ...process.env,
      REMOTE_AGENT_PROXY_HOST: peer || '',
      REMOTE_AGENT_PROXY_LOCAL_HOST: localHost,
      REMOTE_AGENT_EXPECTED_ROOT: expectedRoot,
      TOOLSENABLED_REMOTE_BRIDGE_ENABLED: '1'
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const cleanup = () => { try { child.kill(); } catch {} };
  try {
    const initialized = await request(child, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'remote-agent-mcp-smoke', version: '1' } }
    });
    const listed = await request(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = listed && listed.result && Array.isArray(listed.result.tools) ? listed.result.tools : null;
    const safety = await request(child, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'system.kill_switch_status', arguments: {} }
    });
    let killSwitchActive = null;
    try {
      const text = safety.result.content[0].text;
      const parsed = JSON.parse(text);
      killSwitchActive = parsed.killSwitchActive === true || parsed.active === true;
    } catch {}
    const output = {
      peer,
      initializeOk: initialized && initialized.result ? Boolean(initialized.result.serverInfo) : null,
      toolCount: tools ? tools.length : null,
      hostExecAbsent: tools ? !tools.some(tool => tool && tool.name === 'host.exec') : null,
      killSwitchActive,
      stderrBytes: Buffer.byteLength(stderr, 'utf8')
    };
    output.pass = output.initializeOk && output.toolCount >= 1 && output.hostExecAbsent && output.killSwitchActive === false;
    console.log(JSON.stringify(output));
    process.exitCode = output.pass ? 0 : 1;
  } finally {
    cleanup();
  }
}

main().catch(() => {
  console.log(JSON.stringify({ pass: false }));
  process.exitCode = 1;
});

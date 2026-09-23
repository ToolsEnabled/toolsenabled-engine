#!/usr/bin/env node
'use strict';

// Secure, owner-enabled bootstrap/refresh for the Machine-A remote bridge.
// The candidate token is generated in memory, sent once over the pinned
// direct-Ethernet enrollment port, and written locally through the DPAPI vault
// stdin path. It is never printed, logged, placed in argv, or sent through the
// message relay.
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');
const {
  assertSanctionedMachineAddress,
  detectLocalMachineId,
  loadRegistry,
  peerMachineForAddress,
  ServiceRegistryError
} = require('../src/lib/service-registry');

const ROOT = path.resolve(__dirname, '..');
const SECRETS_SCRIPT = path.join(ROOT, 'tools', 'secrets.ps1');
const BRIDGE_PORT = Number(process.env.REMOTE_AGENT_BRIDGE_PORT || 8788);
const ENROLL_PORT = Number(process.env.REMOTE_AGENT_BRIDGE_ENROLL_PORT || 8791);
const ENROLL_PATH = '/v1/enroll-token';
const TOKEN_KEY = 'custom.remote_agent_bridge_token';

function discoverPeer(configuredPeer, { serviceRegistryOptions = {}, networkInterfaces = os.networkInterfaces } = {}) {
  const registry = loadRegistry(serviceRegistryOptions);
  const detected = detectLocalMachineId(registry, { networkInterfaces });
  if (!detected.ok) throw new ServiceRegistryError(detected.code, detected.reason);
  const local = registry.machines[detected.machineId].address;
  const expected = peerMachineForAddress(local, serviceRegistryOptions).address;
  if (configuredPeer) {
    assertSanctionedMachineAddress(configuredPeer, serviceRegistryOptions);
    if (configuredPeer !== expected) {
      throw new ServiceRegistryError('SERVICE_PEER_UNDETERMINED', 'Configured remote-bridge peer is not the registry-declared peer.');
    }
  }
  return expected;
}

function postToken(host, token) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ token }), 'utf8');
    const req = http.request({ host, port: ENROLL_PORT, path: ENROLL_PATH, method: 'POST',
      timeout: 5000, headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          resolve({ status: res.statusCode, body: null, parseError: error });
        }
      });
    });
    req.once('timeout', () => req.destroy(new Error('enrollment timeout')));
    req.once('error', reject);
    req.end(body);
  });
}

function writeLocalToken(token) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', SECRETS_SCRIPT, 'set-stdin', TOKEN_KEY
    ], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: safeLaunchEnvironment(process.env, { context: 'remote bridge local vault write' })
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`local vault write exited ${code}`)));
    child.stdin.end(token, 'utf8');
  });
}

function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        socket.removeListener('data', onData);
        try { resolve(JSON.parse(buffer.slice(0, end))); }
        catch (error) { reject(new Error(`bridge response was not valid JSON: ${error.message}`)); }
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('bridge closed before returning a complete response')));
  });
}

function verifyBridge(host, token) {
  return new Promise((resolve, reject) => {
    const socket = require('node:net').createConnection(BRIDGE_PORT, host);
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('bridge verification timeout')));
    socket.once('connect', async () => {
      try {
        socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
        const auth = await readLine(socket);
        if (!auth || auth.type !== 'authorized') { socket.destroy(); resolve(false); return; }
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
        const listed = await readLine(socket);
        socket.destroy();
        resolve(Boolean(listed && !listed.error && listed.result && Array.isArray(listed.result.tools)));
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.once('error', reject);
  });
}

async function main() {
  const peer = discoverPeer(process.env.REMOTE_AGENT_BRIDGE_PEER);
  const token = crypto.randomBytes(32).toString('base64url');
  let enrolled;
  try { enrolled = await postToken(peer, token); }
  catch { console.log(JSON.stringify({ ok: false, status: 'enrollment-unreachable', peer })); process.exitCode = 1; return; }
  if (enrolled.status === 200 && enrolled.parseError) {
    console.log(JSON.stringify({ ok: false, status: 'enrollment-response-invalid', peer }));
    process.exitCode = 1;
    return;
  }
  if (enrolled.status !== 200 || !enrolled.body || enrolled.body.ok !== true) {
    console.log(JSON.stringify({ ok: false, status: 'enrollment-rejected', peer, code: enrolled.status }));
    return;
  }
  try { await writeLocalToken(token); }
  catch { console.log(JSON.stringify({ ok: false, status: 'local-vault-write-failed', peer })); process.exitCode = 1; return; }
  let verified = false;
  let verificationFailure = null;
  for (let i = 0; i < 8 && !verified; i++) {
    try {
      verified = await verifyBridge(peer, token);
      verificationFailure = null;
    } catch (error) {
      verificationFailure = error;
    }
    if (!verified) await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (verificationFailure) {
    console.log(JSON.stringify({ ok: false, status: 'bridge-verification-unreachable', peer, bridgePort: BRIDGE_PORT }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: verified, status: verified ? 'connected' : 'token-accepted-awaiting-bridge-reload', peer, bridgePort: BRIDGE_PORT }));
}

main().catch(() => { console.log(JSON.stringify({ ok: false, status: 'bootstrap-failed' })); process.exitCode = 1; });

module.exports = Object.freeze({ discoverPeer });

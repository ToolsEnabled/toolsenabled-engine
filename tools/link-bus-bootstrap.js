#!/usr/bin/env node
'use strict';

// Secure, owner-enabled relay-token bootstrap/refresh. The candidate is
// generated in memory, sent once to the exact peer's 8792 enrollment window,
// and written locally through the DPAPI stdin path. No token is logged or sent
// through the relay itself.
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const {
  assertSanctionedMachineAddress,
  detectLocalMachineId,
  loadRegistry,
  peerMachineForAddress,
  ServiceRegistryError
} = require('../src/lib/service-registry');

const ROOT = path.resolve(__dirname, '..');
const SECRETS_SCRIPT = path.join(ROOT, 'tools', 'secrets.ps1');
const ENROLL_PORT = Number(process.env.LINK_BUS_ENROLL_PORT || 8792);
const RELAY_PORT = 8787;
const TOKEN_KEY = 'custom.link_bus_bridge_token';
const peer = discoverPeer(process.env.LINK_BUS_PEER);

function discoverPeer(configuredPeer, { serviceRegistryOptions = {}, networkInterfaces = os.networkInterfaces } = {}) {
  const registry = loadRegistry(serviceRegistryOptions);
  const detected = detectLocalMachineId(registry, { networkInterfaces });
  if (!detected.ok) throw new ServiceRegistryError(detected.code, detected.reason);
  const local = registry.machines[detected.machineId].address;
  const expected = peerMachineForAddress(local, serviceRegistryOptions).address;
  if (configuredPeer) {
    assertSanctionedMachineAddress(configuredPeer, serviceRegistryOptions);
    if (configuredPeer !== expected) {
      throw new ServiceRegistryError('SERVICE_PEER_UNDETERMINED', 'Configured link-bus peer is not the registry-declared peer.');
    }
  }
  return expected;
}
function post(host, port, pathName, token) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ token }), 'utf8');
    const req = http.request({ host, port, path: pathName, method: 'POST', timeout: 5000, headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('timeout', () => req.destroy(new Error('timeout'))); req.once('error', reject); req.end(body);
  });
}
function writeLocal(token) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',SECRETS_SCRIPT,'set-stdin',TOKEN_KEY], { cwd: ROOT, windowsHide: true, stdio: ['pipe','ignore','ignore'], env: safeLaunchEnvironment() });
    p.once('error', reject); p.once('exit', code => code === 0 ? resolve() : reject(new Error('vault write failed'))); p.stdin.end(token, 'utf8');
  });
}
function relayAuth(host, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: RELAY_PORT, path: '/v1/messages?channel=team&cursor=0', headers: { Authorization: `Bearer ${token}` }, timeout: 4000 }, res => { res.resume(); res.once('end', () => resolve(res.statusCode === 200)); });
    req.once('timeout', () => req.destroy(new Error('timeout'))); req.once('error', reject); req.end();
  });
}
(async () => {
  const token = crypto.randomBytes(32).toString('base64url');
  let status; try { status = await post(peer, ENROLL_PORT, '/v1/enroll-token', token); } catch { console.log(JSON.stringify({ ok: false, status: 'enrollment-unreachable', peer })); process.exitCode = 1; return; }
  if (status !== 200) { console.log(JSON.stringify({ ok: false, status: 'enrollment-rejected', peer, code: status })); return; }
  try { await writeLocal(token); } catch { console.log(JSON.stringify({ ok: false, status: 'local-vault-write-failed', peer })); process.exitCode = 1; return; }
  let ok = false;
  let verificationFailed = false;
  for (let i=0;i<8&&!ok;i++){ try { ok=await relayAuth(peer, token); } catch { verificationFailed = true; } if(!ok) await new Promise(r=>setTimeout(r,500)); }
  if (!ok && verificationFailed) {
    console.log(JSON.stringify({ ok: false, status: 'relay-verification-unreachable', peer }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok, status: ok ? 'connected' : 'token-accepted-awaiting-relay-reload', peer }));
})().catch(() => { console.log(JSON.stringify({ ok: false, status: 'bootstrap-failed' })); process.exitCode=1; });

module.exports = Object.freeze({ discoverPeer });

#!/usr/bin/env node
'use strict';

// Safe peer check for the dev-server tunnel controller. Reads the local
// relay token in-process and reports only HTTP status/booleans.
const http = require('node:http');
const { getSecret } = require('../src/lib/runtime');
const os = require('node:os');
const {
  assertSanctionedMachineAddress,
  detectLocalMachineId,
  loadRegistry,
  peerMachineForAddress,
  ServiceRegistryError
} = require('../src/lib/service-registry');

function resolveTopology() {
  const registry = loadRegistry();
  let local = process.env.LINK_BUS_LOCAL || '';
  if (local) assertSanctionedMachineAddress(local);
  else {
    const detected = detectLocalMachineId(registry, { networkInterfaces: os.networkInterfaces });
    if (!detected.ok) throw new ServiceRegistryError(detected.code, detected.reason);
    local = registry.machines[detected.machineId].address;
  }
  const expectedPeer = peerMachineForAddress(local).address;
  const peer = process.env.LINK_BUS_PEER || expectedPeer;
  assertSanctionedMachineAddress(peer);
  if (peer !== expectedPeer) throw new ServiceRegistryError('SERVICE_PEER_UNDETERMINED', 'Configured link-bus peer is not the registry-declared peer.');
  return { local, peer };
}

let local = '';
let peer = '';
try { ({ local, peer } = resolveTopology()); }
catch (error) {
  process.stdout.write(`${JSON.stringify({
    peer: null, healthOk: null, authOk: null, available: null,
    unavailableReasons: [error && error.code || 'LINK_BUS_PEER_NOT_CONFIGURED']
  })}\n`);
  process.exit(1);
}

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: peer, port: 8787, path, headers, timeout: 3000 }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    req.end();
  });
}

(async () => {
  const unavailableReasons = [];
  let health = null, auth = null;
  if (!peer) {
    unavailableReasons.push('LINK_BUS_PEER_NOT_CONFIGURED');
  } else {
    try { health = await get('/health'); } catch (error) {
      unavailableReasons.push(`HEALTH_${error && error.message === 'timeout' ? 'TIMEOUT' : 'UNREACHABLE'}`);
    }
    if (health !== 200 && !unavailableReasons.some(reason => reason.startsWith('HEALTH_'))) {
      unavailableReasons.push(`HEALTH_HTTP_${health || 'NO_STATUS'}`);
    }
  }
  try {
    const token = getSecret('custom.link_bus_bridge_token', { prompt: false });
    if (peer) {
      try {
        auth = await get('/v1/messages?channel=team&cursor=0&limit=1', { Authorization: `Bearer ${token}` });
      } catch (error) {
        unavailableReasons.push(`AUTH_${error && error.message === 'timeout' ? 'TIMEOUT' : 'UNREACHABLE'}`);
      }
      if (auth !== 200 && !unavailableReasons.some(reason => reason.startsWith('AUTH_'))) {
        unavailableReasons.push(`AUTH_HTTP_${auth || 'NO_STATUS'}`);
      }
    }
  } catch (error) {
    unavailableReasons.push(error && error.code === 'SECRET_NOT_CONFIGURED'
      ? 'LINK_BUS_TOKEN_NOT_CONFIGURED'
      : 'LINK_BUS_TOKEN_UNAVAILABLE');
  }
  const healthOk = Number.isInteger(health) ? health === 200 : null;
  const authOk = Number.isInteger(auth) ? auth === 200 : null;
  const available = healthOk === false || authOk === false
    ? false
    : healthOk === true && authOk === true
      ? true
      : null;
  const result = {
    peer: peer || null,
    healthOk,
    authOk,
    available,
    unavailableReasons,
  };
  console.log(JSON.stringify(result));
  // EXIT IS NON-ZERO WHENEVER NOT(healthOk && authOk), AND THAT COLLAPSES A
  // PARTIAL STATE. Both PowerShell callers treat a non-zero exit as
  // "healthOk=false, authOk=false" without reading the JSON:
  // full-remote-access-lifecycle.ps1 Get-TunnelStatus branches on
  // $result.exitCode -ne 0, and Tunnel-Lifecycle.ps1 leaves $peerAuthOk at its
  // $false initialisation. So (healthOk true, authOk false) -- a reachable
  // relay whose credential is not synchronised -- is indistinguishable
  // downstream from a dead listener.
  //
  // Verified safe at the time of writing: all 8 consumers of
  // tunnel.healthReady/authReady require authReady (lifecycle :833, :1001,
  // :1123, :1148, :1156, :1178-79); none branches on health-true-auth-false,
  // so no decision changes. THAT IS A PROPERTY OF TODAY'S CALLERS, NOT OF THIS
  // FILE. Anything that later wants to act on "listener up, credential stale"
  // must read unavailableReasons from stdout rather than the exit code, or
  // this line has to become narrower.
  if (result.available !== true) process.exitCode = 1;
})().catch(() => {
  console.log(JSON.stringify({
    peer: peer || null,
    healthOk: null,
    authOk: null,
    available: null,
    unavailableReasons: ['LINK_BUS_STATUS_FAILED'],
  }));
  process.exitCode = 1;
});

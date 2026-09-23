#!/usr/bin/env node
'use strict';

// Pure setup gate for the direct-link tunnel/bridge keeper.
//
// A fresh install deliberately declares one loopback machine and no peer
// services. Starting either listener from that state would turn placeholders
// into network authority. This gate requires the customer's explicit two-host
// registry, binds the current checkout to the detected local host, resolves
// every production endpoint, and verifies both independent vault tokens before
// any scheduled task or listener is started. It never prompts and never emits a
// secret, fingerprint, length, error message, path, machine id, or address.

const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const serviceRegistry = require('../src/lib/service-registry');
const { getSecret } = require('../src/lib/runtime');

const ROOT = path.resolve(__dirname, '..');
const LINK_BUS_TOKEN_KEY = 'custom.link_bus_bridge_token';
const REMOTE_BRIDGE_TOKEN_KEY = 'custom.remote_agent_bridge_token';
const TOKEN_RE = /^[\x21-\x7e]{16,4096}$/;
const REQUIRED_ENDPOINTS = Object.freeze([
  Object.freeze({ id: 'local-link-bus-diagnostic', port: 8787, owner: 'local' }),
  Object.freeze({ id: 'local-peer-tool-bridge-diagnostic', port: 8788, owner: 'local' }),
  Object.freeze({ id: 'peer-tool-bridge', port: 8788, owner: 'peer' }),
  Object.freeze({ id: 'shared-agent-bus', port: 8787, owner: 'pair' })
]);

function result(ok, code, detail = {}) {
  return Object.freeze({
    schemaVersion: 'tunnel-bridge-preflight.v1',
    ok,
    configured: ok,
    code,
    ...detail,
    secretValuesEmitted: false
  });
}

function refusal(code) {
  return result(false, code, { localRole: null, endpointsVerified: 0, tokensVerified: 0 });
}

function isDirectAddress(address) {
  if (!net.isIPv4(address)) return false;
  const first = Number(address.split('.')[0]);
  return address !== '0.0.0.0' && first !== 127 && first < 224;
}

function samePath(left, right) {
  if (typeof left !== 'string' || !path.isAbsolute(left)) return false;
  try {
    return path.resolve(left).replace(/[\\/]+$/, '').toLowerCase()
      === path.resolve(right).replace(/[\\/]+$/, '').toLowerCase();
  } catch { return false; }
}

function tokensEqual(left, right) {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  try {
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function evaluateTunnelBridgeReadiness(options = {}) {
  const registryApi = options.serviceRegistry || serviceRegistry;
  const readSecret = typeof options.readSecret === 'function' ? options.readSecret : getSecret;
  const registryOptions = options.registryOptions && typeof options.registryOptions === 'object'
    ? options.registryOptions
    : {};

  let registry;
  let pair;
  try {
    registry = registryApi.loadRegistry(registryOptions);
    pair = registryApi.directionalMachinePair({ registry });
  } catch {
    return refusal('TUNNEL_BRIDGE_TWO_MACHINE_SETUP_REQUIRED');
  }

  const machines = [pair.coordinatorMachine, pair.recipientMachine];
  if (machines.some(machine => !machine || !isDirectAddress(machine.address))) {
    return refusal('TUNNEL_BRIDGE_DIRECT_ADDRESS_REQUIRED');
  }

  let local;
  try {
    local = registryApi.detectLocalMachineId(registry, {
      ...(typeof options.from === 'string' && options.from ? { from: options.from } : {}),
      ...(typeof options.networkInterfaces === 'function'
        ? { networkInterfaces: options.networkInterfaces }
        : {})
    });
  } catch {
    return refusal('TUNNEL_BRIDGE_LOCAL_IDENTITY_REQUIRED');
  }
  if (!local || local.ok !== true) return refusal('TUNNEL_BRIDGE_LOCAL_IDENTITY_REQUIRED');

  const localMachine = registry.machines[local.machineId];
  const peerMachine = machines.find(machine => machine.machineId !== local.machineId);
  if (!localMachine || !peerMachine) return refusal('TUNNEL_BRIDGE_LOCAL_IDENTITY_REQUIRED');
  if (!samePath(localMachine.root, ROOT)) return refusal('TUNNEL_BRIDGE_ROOT_BINDING_REQUIRED');

  let endpointsVerified = 0;
  for (const expected of REQUIRED_ENDPOINTS) {
    let resolved;
    try { resolved = registryApi.resolveService(expected.id, { registry, from: local.machineId }); }
    catch { resolved = null; }
    if (!resolved || resolved.ok !== true || resolved.port !== expected.port) {
      return refusal('TUNNEL_BRIDGE_SERVICE_SETUP_REQUIRED');
    }
    const expectedHost = expected.owner === 'local'
      ? localMachine.address
      : (expected.owner === 'peer' ? peerMachine.address : null);
    if ((expectedHost && resolved.host !== expectedHost)
        || (!expectedHost && !machines.some(machine => machine.address === resolved.host))) {
      return refusal('TUNNEL_BRIDGE_SERVICE_SETUP_REQUIRED');
    }
    endpointsVerified += 1;
  }

  let linkBusToken;
  let remoteBridgeToken;
  try {
    linkBusToken = readSecret(LINK_BUS_TOKEN_KEY, { prompt: false });
    remoteBridgeToken = readSecret(REMOTE_BRIDGE_TOKEN_KEY, { prompt: false });
  } catch {
    return refusal('TUNNEL_BRIDGE_TOKEN_SETUP_REQUIRED');
  }
  if (typeof linkBusToken !== 'string' || !TOKEN_RE.test(linkBusToken)
      || typeof remoteBridgeToken !== 'string' || !TOKEN_RE.test(remoteBridgeToken)) {
    return refusal('TUNNEL_BRIDGE_TOKEN_INVALID');
  }
  if (tokensEqual(linkBusToken, remoteBridgeToken)) {
    return refusal('TUNNEL_BRIDGE_TOKEN_REUSE_REFUSED');
  }

  return result(true, 'READY', {
    localRole: local.machineId === pair.coordinatorMachine.machineId ? 'coordinator' : 'recipient',
    endpointsVerified,
    tokensVerified: 2
  });
}

function main() {
  const readiness = evaluateTunnelBridgeReadiness();
  process.stdout.write(`${JSON.stringify(readiness)}\n`);
  return readiness.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch {
    process.stdout.write(`${JSON.stringify(refusal('TUNNEL_BRIDGE_PREFLIGHT_FAILED'))}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  LINK_BUS_TOKEN_KEY,
  REMOTE_BRIDGE_TOKEN_KEY,
  REQUIRED_ENDPOINTS,
  ROOT,
  TOKEN_RE,
  evaluateTunnelBridgeReadiness,
  isDirectAddress,
  main,
  samePath,
  tokensEqual
});

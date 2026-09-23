#!/usr/bin/env node
'use strict';

// ONE-SHOT, THROWAWAY bootstrap for the remote-agent-bridge token (owner
// request R117, "get the other computer complete access to the toolsenabled
// system"). Same pattern already proven for the link bus bridge token
// (tools/link-bus-enroll-token.js), but for a SEPARATE, dedicated secret:
// the bridge grants full ToolsEnabled tool execution to Codex on machine B,
// so it gets its own credential rather than reusing the lower-stakes chat
// bus token. Unlike the chat bus token (which the owner already had), this
// one Codex mints itself (e.g. Python secrets.token_urlsafe(32)) and pushes
// once -- no owner involvement needed at all. It deliberately listens on a
// separate one-shot port (8791 by default) so a refresh never replaces the
// live JSON-RPC bridge on 8788; the explicit REPLACE environment switch is
// required when the active vault key already exists.
//
// See tools/lib/one-shot-token-enroll.js for the shared implementation.
const { createEnrollServer, runOneShot, DEFAULT_TOKEN_RE } = require('./lib/one-shot-token-enroll');
const {
  assertSanctionedMachineAddress,
  machineAddressPolicy,
  peerMachineForAddress,
  ServiceRegistryError
} = require('../src/lib/service-registry');

const PORT = 8788;
const ENROLL_PORT = Number(process.env.REMOTE_AGENT_BRIDGE_ENROLL_PORT || 8791);
const VAULT_KEY = process.env.REMOTE_AGENT_BRIDGE_ENROLL_VAULT_KEY || 'custom.remote_agent_bridge_token';
const ENROLL_PATH = '/v1/enroll-token';
const ALLOW_EXISTING = process.env.REMOTE_AGENT_BRIDGE_ENROLL_REPLACE === '1';

// Resolve topology at use time. A fresh customer install intentionally ships
// with one loopback machine and no peer; importing the tool registry must still
// work in that state. Once the customer declares a pair, an explicit host is
// checked against it, or the unique installation-host role selects this side.
// There is deliberately no machine-a/machine-b compatibility guess.
function resolveEnrollmentTopology({
  configuredHost = process.env.REMOTE_AGENT_BRIDGE_ENROLL_HOST,
  serviceRegistryOptions = {}
} = {}) {
  const policy = machineAddressPolicy(serviceRegistryOptions);
  let host = configuredHost || null;
  if (host) {
    assertSanctionedMachineAddress(host, serviceRegistryOptions);
  } else {
    const candidates = policy.entries.filter(entry => entry.role === 'installation-host');
    const selected = candidates.length === 1
      ? candidates[0]
      : policy.entries.length === 1 ? policy.entries[0] : null;
    if (!selected) {
      throw new ServiceRegistryError('SERVICE_LOCAL_MACHINE_UNKNOWN',
        'Remote bridge enrollment cannot determine this machine; declare exactly one installation-host or pass the configured host.');
    }
    host = selected.address;
  }
  const peerHost = peerMachineForAddress(host, serviceRegistryOptions).address;
  return Object.freeze({
    host,
    peerHost,
    allowedRemoteRe: new RegExp(`^${peerHost.replace(/\./g, '\\.')}$`)
  });
}

const DEFAULT_TOPOLOGY = (() => {
  try { return resolveEnrollmentTopology(); }
  catch { return null; }
})();
const HOST = DEFAULT_TOPOLOGY ? DEFAULT_TOPOLOGY.host : null;
const PEER_HOST = DEFAULT_TOPOLOGY ? DEFAULT_TOPOLOGY.peerHost : null;
const ALLOWED_REMOTE_RE = DEFAULT_TOPOLOGY ? DEFAULT_TOPOLOGY.allowedRemoteRe : /(?!)/;

function createRemoteBridgeEnrollServer(options = {}) {
  const { serviceRegistryOptions, configuredHost, ...serverOptions } = options;
  const topology = serverOptions.allowedRemoteRe
    ? null
    : resolveEnrollmentTopology({ configuredHost, serviceRegistryOptions });
  return createEnrollServer({
    vaultKey: VAULT_KEY,
    enrollPath: ENROLL_PATH,
    allowedRemoteRe: topology ? topology.allowedRemoteRe : serverOptions.allowedRemoteRe,
    ...serverOptions
  });
}

if (require.main === module) {
  Promise.resolve().then(() => {
    const topology = resolveEnrollmentTopology();
    return runOneShot({ vaultKey: VAULT_KEY, host: topology.host, port: ENROLL_PORT, enrollPath: ENROLL_PATH, allowedRemoteRe: topology.allowedRemoteRe, allowExisting: ALLOW_EXISTING });
  }).catch(error => {
    process.stderr.write(`fatal: ${error && error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createEnrollServer: createRemoteBridgeEnrollServer,
  resolveEnrollmentTopology,
  ALLOWED_REMOTE_RE, ENROLL_PATH, TOKEN_RE: DEFAULT_TOKEN_RE, VAULT_KEY, HOST, PORT, ENROLL_PORT, PEER_HOST
};

#!/usr/bin/env node
'use strict';

// ONE-SHOT, THROWAWAY bootstrap for the link bus bridge token (owner request
// R117). Not part of sidecars/link-bus/server.js and never started alongside
// it -- the owner's exact bus contract stays exactly /health + /v1/messages,
// nothing else.
//
// WHY THIS EXISTS. The bridge token already exists in an open session on the
// owner's other physical PC. The normal path (a masked local DPAPI form via
// system.credential_request) requires an interactive desktop to render a
// dialog on, which this agent's execution context does not reliably have --
// the same symptom already seen with a UAC consent prompt. The owner
// explicitly does not want to retype or email the token between the two
// machines. Both machines are the owner's own hardware, physically
// co-located and connected through the configured private network.
//
// THE TRADEOFF, STATED PLAINLY. This listens for exactly one POST carrying
// the raw token value, with NO token-based auth of its own (there is no
// token yet -- that is the whole problem). Its safety comes from everything
// else instead: reachable only from the registry-declared exact peer (enforced twice: the
// Windows Firewall rule "ToolsEnabled Link Bus (8787)" AND an app-level
// remote-address check), refuses to run at all if a token is already
// configured, accepts at most one write (first-write-wins, then the process
// exits so the port is free for the real bus), and exits itself after 15
// minutes regardless. The token is written straight to the DPAPI vault via
// tools/secrets.ps1 set-stdin -- the same primitive the masked GUI form
// itself calls -- and is never logged, echoed, or returned in any response.
//
// See tools/lib/one-shot-token-enroll.js for the shared implementation (also
// used by tools/remote-bridge-enroll-token.js).
const { createEnrollServer, runOneShot, DEFAULT_TOKEN_RE } = require('./lib/one-shot-token-enroll');
const {
  assertSanctionedMachineAddress,
  directionalMachinePair
} = require('../src/lib/service-registry');

function resolveEnrollmentTopology(serviceRegistryOptions = {}) {
  const pair = directionalMachinePair(serviceRegistryOptions);
  const configuredHost = String(process.env.LINK_BUS_ENROLL_HOST || '').trim();
  if (configuredHost) {
    assertSanctionedMachineAddress(configuredHost, serviceRegistryOptions);
    if (configuredHost !== pair.coordinatorMachine.address) {
      const error = new Error('The link-bus enrollment listener must bind the configured coordinator.');
      error.code = 'LINK_BUS_ENROLL_COORDINATOR_REQUIRED';
      throw error;
    }
  }
  return Object.freeze({
    host: pair.coordinatorMachine.address,
    peerHost: pair.recipientMachine.address
  });
}
const DEFAULT_TOPOLOGY = (() => {
  try { return resolveEnrollmentTopology(); }
  catch { return null; }
})();
const HOST = DEFAULT_TOPOLOGY ? DEFAULT_TOPOLOGY.host : '';
const PORT = 8787;
const ENROLL_PORT = Number(process.env.LINK_BUS_ENROLL_PORT || 8792);
const VAULT_KEY = process.env.LINK_BUS_ENROLL_VAULT_KEY || 'custom.link_bus_bridge_token';
const ENROLL_PATH = '/v1/enroll-token';
// Pinned to the sole recipient's exact address, not the whole /24 -- a coordinator
// security review (2026-07-30) found the shared module's default (the whole
// /24) was still in effect here even though the live bus/bridge this token
// bootstraps was separately pinned. This is the one deployment-specific
// override for this one-shot listener.
const PEER_HOST = DEFAULT_TOPOLOGY ? DEFAULT_TOPOLOGY.peerHost : '';
const ALLOWED_REMOTE_RE = PEER_HOST
  ? new RegExp(`^${PEER_HOST.replace(/\./g, '\\.')}$`)
  : /(?!)/;
const ALLOW_EXISTING = process.env.LINK_BUS_ENROLL_REPLACE === '1';

if (require.main === module) {
  if (!DEFAULT_TOPOLOGY) {
    process.stderr.write('fatal: LINK_BUS_TWO_MACHINE_SETUP_REQUIRED\n');
    process.exitCode = 1;
  } else {
    runOneShot({ vaultKey: VAULT_KEY, host: HOST, port: ENROLL_PORT, enrollPath: ENROLL_PATH, allowedRemoteRe: ALLOWED_REMOTE_RE, allowExisting: ALLOW_EXISTING }).catch(error => {
      process.stderr.write(`fatal: ${error && error.message}\n`);
      process.exitCode = 1;
    });
  }
}

module.exports = {
  createEnrollServer: opts => createEnrollServer({ vaultKey: VAULT_KEY, enrollPath: ENROLL_PATH, allowedRemoteRe: ALLOWED_REMOTE_RE, ...opts }),
  ALLOWED_REMOTE_RE, ENROLL_PATH, TOKEN_RE: DEFAULT_TOKEN_RE, VAULT_KEY, HOST, PORT, ENROLL_PORT, PEER_HOST,
  resolveEnrollmentTopology
};

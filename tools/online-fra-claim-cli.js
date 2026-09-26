#!/usr/bin/env node
'use strict';

// THE CLAIM, AS A COMMAND -- the one surface every other surface drives.
//
//   node tools/online-fra-claim-cli.js open --name "Desk PC"
//   node tools/online-fra-claim-cli.js poll --token <pollToken>
//   node tools/online-fra-claim-cli.js poll --token <pollToken> --accept true
//   node tools/online-fra-claim-cli.js poll --token <pollToken> --accept false
//   node tools/online-fra-claim-cli.js wait --token <pollToken>
//   node tools/online-fra-claim-cli.js status
//   node tools/online-fra-claim-cli.js disconnect
//
// The tray, the settings walkthrough and a bare terminal all need the same
// verbs, so they live here once, speaking JSON on stdout: one object per
// invocation, machine-readable, nothing else on that stream. Human prose goes
// to stderr, where a pipe cannot mistake it for data.
//
// `disconnect` is "Disconnect this computer": the stored credential goes, the
// machine's identity stays, and its entry on the account page stays until the
// person removes it there. Offline; it tells the service nothing.
//
// BETA, and the surface should say so: this is the hosted-account path
// (app.toolsenabled.ai), which is in beta while the relay half is unpublished.
// The direct cable path needs none of this and keeps working without it.
//
// The vault is the real one (DPAPI via tools/secrets.ps1) unless
// TOOLSENABLED_VAULT_PATH points elsewhere -- the same resolution every other
// tool uses. The account origin comes from TOOLSENABLED_ACCOUNT_ORIGIN and
// defaults to the live service.

const { createDeviceClaimClient, connectionState } = require('../src/lib/online-fra-device-claim');
const { failureDetails } = require('../src/lib/device-credential-clear-outcome');

const BASE = process.env.TOOLSENABLED_ACCOUNT_ORIGIN || 'https://app.toolsenabled.ai';

function out(object) { process.stdout.write(`${JSON.stringify(object)}\n`); }

const VERB_FLAGS = Object.freeze({
  open: ['--name'],
  poll: ['--token', '--accept'],
  wait: ['--token', '--deadline-ms'],
  status: [],
  disconnect: []
});
const ALL_FLAGS = new Set(Object.values(VERB_FLAGS).flat());
const USAGE = 'usage: online-fra-claim-cli <open --name N | poll --token T [--accept true|false] | wait --token T [--deadline-ms N] | status | disconnect>';

function usage(message) {
  const error = new Error(message);
  error.code = 'CLI_USAGE';
  throw error;
}

function parseArguments(args) {
  const verb = args[0];
  if (!Object.prototype.hasOwnProperty.call(VERB_FLAGS, verb)) usage(USAGE);
  const flags = new Map();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    if (!VERB_FLAGS[verb].includes(flag)) usage(`Unsupported argument for ${verb}. ${USAGE}`);
    if (flags.has(flag)) usage(`${flag} may only be supplied once.`);
    const value = args[index + 1];
    // Poll tokens are opaque base64url strings and can themselves begin with
    // dashes. Only an actual flag name is ambiguous in a value position.
    if (typeof value !== 'string' || !value.trim() || ALL_FLAGS.has(value)) {
      usage(`${flag} needs a value.`);
    }
    flags.set(flag, value);
  }
  if (verb === 'open' && !flags.has('--name')) usage('open needs --name "<what the account page should call this computer>"');
  if ((verb === 'poll' || verb === 'wait') && !flags.has('--token')) usage(`${verb} needs --token <pollToken from open>`);
  if (flags.has('--accept') && !['true', 'false'].includes(flags.get('--accept'))) {
    usage('poll needs --accept to be exactly true or false.');
  }
  const deadlineMs = flags.has('--deadline-ms') ? Number(flags.get('--deadline-ms')) : 11 * 60 * 1000;
  if (flags.has('--deadline-ms') && (!/^\d+$/.test(flags.get('--deadline-ms')) || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)) {
    usage('wait needs --deadline-ms to be a positive integer.');
  }
  return { verb, flags, deadlineMs };
}

function pollAnswer(result) {
  if (result.state === 'connected') {
    return { state: 'connected', pairId: result.device.pairId, deviceId: result.device.deviceId, name: result.device.name };
  }
  if (result.state === 'reserved') {
    // This is the exact account the local surface must display before it asks
    // for a decision. Keep remote text as data; never render or log it here.
    return { state: 'reserved', account: { email: result.account.email }, intervalSeconds: result.intervalSeconds };
  }
  return { state: result.state, intervalSeconds: result.intervalSeconds };
}

async function main() {
  const { verb, flags, deadlineMs } = parseArguments(process.argv.slice(2));
  // Parse the entire invocation before even loading runtime's state resolver.
  // An ambiguous local decision must not touch the vault or the account API.
  const { getSecret, setSecret, clearDeviceCredential } = require('../src/lib/runtime');
  const vault = { getSecret, setSecret, clearDeviceCredential };

  if (verb === 'status') {
    // Read-only, offline, safe to call from any surface at any cadence.
    const state = connectionState(vault);
    out(state.connected
      ? { connected: true, pairId: state.pairId, deviceId: state.deviceId, name: state.name, claimedAtMs: state.claimedAtMs }
      : { connected: false });
    return 0;
  }

  if (verb === 'open') {
    const name = flags.get('--name');
    const client = createDeviceClaimClient({ baseUrl: BASE, vault });
    const opened = await client.openClaim({ name });
    process.stderr.write(
      `\n  On any browser where you are signed in to your ToolsEnabled account,\n`
      + `  open the account page and enter this code:\n\n`
      + `      ${opened.code}\n\n`
      + `  It stops working in ten minutes. This computer is waiting.\n\n`);
    out({ code: opened.code, pollToken: opened.pollToken, expiresAtMs: opened.expiresAtMs, intervalSeconds: opened.intervalSeconds });
    return 0;
  }

  if (verb === 'poll') {
    const token = flags.get('--token');
    const client = createDeviceClaimClient({ baseUrl: BASE, vault });
    if (flags.has('--accept')) {
      // Acceptance only parks the grant. A later ordinary poll collects and
      // stores it, including recovery when the decision response was lost.
      const result = await client.decideClaim({ pollToken: token, accept: flags.get('--accept') === 'true' });
      out({ state: result.state });
      return 0;
    }
    const result = await client.pollOnce({ pollToken: token });
    out(pollAnswer(result));
    return 0;
  }

  if (verb === 'wait') {
    /* Wait until there is a local decision to make, a stored connection, an
       expired claim, or the deadline. A reservation is not passive progress:
       surface its account and stop so a terminal can explicitly accept/decline. */
    const token = flags.get('--token');
    const client = createDeviceClaimClient({ baseUrl: BASE, vault });
    const startedAt = Date.now();
    for (;;) {
      const result = await client.pollOnce({ pollToken: token });
      if (result.state === 'connected' || result.state === 'reserved') {
        out(pollAnswer(result));
        return 0;
      }
      if (Date.now() - startedAt > deadlineMs) {
        out({ state: 'timeout' });
        return 1;
      }
      if (!Number.isFinite(result.intervalSeconds) || result.intervalSeconds <= 0) {
        const error = new Error('The claim status did not provide a positive finite polling interval.');
        error.code = 'DEVICE_CLAIM_INTERVAL_INVALID';
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, result.intervalSeconds * 1000));
    }
  }

  if (verb === 'disconnect') {
    // Offline and local: the credential leaves the vault, the identity stays.
    // A second press answers wasConnected:false rather than pretending.
    const client = createDeviceClaimClient({ baseUrl: BASE, vault });
    const result = client.clearConnection();
    process.stderr.write(result.mutationOutcome === 'UNCERTAIN'
      ? `\n  The local storage result did not confirm persistence. The credential\n`
        + `  may have changed; do not treat this as a completed disconnection.\n\n`
      : result.wasConnected
        ? `\n  The stored account credential was removed and its sync calls completed.\n`
          + `  Active remote access and consent must also be stopped by the desktop.\n\n`
        : `\n  No stored account credential was observed by this operation.\n`
          + `  This does not resolve an earlier uncertain disconnection.\n\n`);
    out({ cleared: true, wasConnected: result.wasConnected, mutationOutcome: result.mutationOutcome });
    return 0;
  }

}

main().then(code => { process.exitCode = code; }).catch(error => {
  // Refusals travel as data too -- the surface decides how to say them.
  if (process.argv[2] === 'disconnect' && error.code !== 'CLI_USAGE') {
    let input;
    try { input = { code: error.localCause, mutationOutcome: error.mutationOutcome }; }
    catch { input = null; }
    out({ error: { code: 'DEVICE_CREDENTIAL_CLEAR_FAILED',
      message: 'The local vault did not confirm this computer\'s account disconnection.', ...failureDetails(input) } });
  } else if (error.code === 'DEVICE_CLAIM_UNREACHABLE' || error.code === 'DEVICE_CLAIM_RESPONSE_INVALID') {
    // The complete-response client can know it refused before dispatch. Any
    // absent/future value is ambiguous; never imply a repeated decision is safe.
    const responseInvalid = error.code === 'DEVICE_CLAIM_RESPONSE_INVALID';
    const requestOutcome = !responseInvalid && error.requestOutcome === 'NOT_ATTEMPTED' ? 'NOT_ATTEMPTED' : 'UNCERTAIN';
    out({ error: { code: responseInvalid ? 'DEVICE_CLAIM_RESPONSE_INVALID' : 'DEVICE_CLAIM_UNREACHABLE', requestOutcome,
      message: requestOutcome === 'NOT_ATTEMPTED'
        ? 'This computer did not send the account request. Check its connection settings before trying again.'
        : responseInvalid
          ? 'The account service returned an incomplete or unreadable response. This connection step may have taken effect. Check the current connection state before repeating it.'
          : 'The account service did not return a complete response. The request may have reached it. Check the current connection state before repeating the step.' } });
  } else out({ error: { code: error.code || 'CLI_FAILED', message: error.message } });
  process.exitCode = error.code === 'CLI_USAGE' ? 2 : 1;
});

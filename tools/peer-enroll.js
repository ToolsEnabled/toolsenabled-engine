#!/usr/bin/env node
'use strict';

// PAIRING A SECOND COMPUTER, WITHOUT CARRYING A SECRET BETWEEN THEM.
//
//   On the computer you already have:   node tools/peer-enroll.js invite
//   It prints a code, e.g.              TE-K7QM-4XPB
//   On the computer you are adding:     node tools/peer-enroll.js join --address <shown> --code TE-K7QM-4XPB
//
// That is the whole procedure. The code is read off your own screen and typed
// into your own other computer; it is single-use, expires in minutes, and is
// worthless afterwards. Nothing is read aloud, pasted, emailed, or written down,
// and no long-lived secret ever exists to be leaked. Compare the flow this
// replaces, which printed a 64-hex bearer token and told the operator to "share
// this with Machine B out-of-band, e.g. read aloud / Telegram".
//
// After pairing, rotation is automatic and unattended: see
// `src/lib/peer-enrollment.js` `linkSecretFor`. There is no rotate command here
// because there is nothing for a person to do.
//
// THE PROTOCOL LIVES IN src/lib/peer-enrollment.js AND HAS NO NETWORK CODE AT
// ALL. This file is the only part that opens a socket, deliberately: it keeps
// the security-relevant logic testable without a listener, and lets
// `tests/peer-enrollment.js` statically assert that the protocol module reaches
// no host and checks no licence.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const {
  IDENTITY_VAULT_KEY,
  createIdentity,
  createEnrollmentOffer,
  createEnrollmentRequest,
  redeemEnrollmentRequest,
  acceptEnrollmentResponse,
  loadPeerRegistry,
  savePeerRegistry,
  hasEnrolledPeers,
  peerById,
  revokePeer,
  normalizeCode,
  fingerprintForPublicKey,
  peerIdForPublicKey,
  publicKeyToWire
} = require('../src/lib/peer-enrollment');

const DEFAULT_PORT = 8795;
const DEFAULT_BIND = '127.0.0.1';
const MAX_BODY_BYTES = 8 * 1024;

function out(line) { process.stdout.write(`${line}\n`); }
function errorOut(line) { process.stderr.write(`${line}\n`); }

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; index += 1; }
    } else args._.push(token);
  }
  return args;
}

// --- identity ---------------------------------------------------------------

/**
 * The long-term identity key lives in the DPAPI vault. A file-backed store is
 * offered ONLY for an isolated exercise against a throwaway root, and is refused
 * outright against the real installation: a private key sitting in a plain file
 * is exactly the weakening this whole change exists to remove, and an accidental
 * `--root .` must not silently downgrade a real install's protection.
 */
function identityStore(root) {
  const isolated = path.resolve(root) !== REPO_ROOT;
  if (!isolated) {
    const runtime = require('../src/lib/runtime');
    return {
      kind: 'vault',
      read() {
        try {
          return runtime.getSecret(IDENTITY_VAULT_KEY, { prompt: false });
        } catch (error) {
          if (error && error.code === 'SECRET_NOT_CONFIGURED') return null;
          throw error;
        }
      },
      write(value) { runtime.setSecret(IDENTITY_VAULT_KEY, value); }
    };
  }
  const file = path.join(root, 'state', 'peer-identity.key');
  return {
    kind: 'file',
    file,
    read() {
      try { return fs.readFileSync(file, 'utf8').trim() || null; }
      catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    write(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  };
}

function loadIdentity(store, { create = false } = {}) {
  const existing = store.read();
  if (existing) {
    const crypto = require('node:crypto');
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(existing, 'base64url'), format: 'der', type: 'pkcs8'
    });
    const publicKey = publicKeyToWire(crypto.createPublicKey(privateKey));
    return { peerId: peerIdForPublicKey(publicKey), publicKey, privateKey: existing };
  }
  if (!create) return null;
  const identity = createIdentity();
  store.write(identity.privateKey);
  return identity;
}

function saveEnrolledPeer(root, peer) {
  const registry = loadPeerRegistry(root);
  const peers = registry.peers.filter(entry => entry.peerId !== peer.peerId).concat([peer]);
  savePeerRegistry(root, peers);
  return peers;
}

// --- status -----------------------------------------------------------------

function commandStatus(root) {
  const registry = loadPeerRegistry(root);
  // A broken or only partially valid registry cannot establish that this
  // computer is unpaired, nor can it establish a complete peer count. Keep
  // genuine absence calm, but refuse to turn an unreadable/invalid list into a
  // definite topology answer.
  if (registry.source === 'malformed' || registry.source === 'unreadable') {
    errorOut(`Could not determine paired-computer status: the paired-computer list is ${registry.source}.`);
    return 1;
  }
  if (registry.rejected.length > 0) {
    errorOut(`Could not determine complete paired-computer status: ${registry.rejected.length} entr(ies) in the list could not be trusted.`);
    return 1;
  }
  // A person with one computer must see a calm, complete answer -- never an
  // error, never an empty table implying something is missing.
  if (!hasEnrolledPeers(registry)) {
    out('This computer is working on its own. Nothing needs to be set up.');
    out('To add another computer, run:  node tools/peer-enroll.js invite');
    return 0;
  }
  out(`Paired computers (${registry.peers.length}):`);
  for (const peer of registry.peers) {
    const state = peer.revoked ? 'revoked' : 'active';
    out(`  ${peer.label}  [${state}]`);
    out(`    id          ${peer.peerId}`);
    out(`    fingerprint ${peer.fingerprint}`);
    if (peer.revoked) out(`    revoked     ${peer.revokedReason || 'revoked'}`);
  }
  return 0;
}

// --- invite ------------------------------------------------------------------

// `emit` is injected so the FIRST-RUN SETUP can call this same code and word the
// instruction in its own voice. Before that existed, this file's own guidance
// ("run node tools/peer-enroll.js join ...") was the only instruction a person
// ever saw, which is what config/invocation-registry.json recorded as the reason
// this tool was manual. The protocol must not be reimplemented behind a nicer
// screen -- one implementation, two voices.
function defaultInviteInstruction({ bind, port, code, minutes, fingerprint }) {
  return [
    'On the other computer, run:',
    '',
    `  node tools/peer-enroll.js join --address ${bind}:${port} --code ${code}`,
    '',
    `This code works once and expires in ${minutes} minute(s). Do not send it anywhere --`,
    'read it off this screen and type it on the other computer.',
    `This computer's fingerprint: ${fingerprint}`
  ];
}

function commandInvite(root, args, { emit = out, instruction = defaultInviteInstruction } = {}) {
  const store = identityStore(root);
  const identity = loadIdentity(store, { create: true });
  const bind = typeof args.bind === 'string' ? args.bind : DEFAULT_BIND;
  const port = Number.isFinite(Number(args.port)) ? Number(args.port) : DEFAULT_PORT;
  const minutes = Number.isFinite(Number(args.minutes)) ? Number(args.minutes) : 10;

  const { code, offer } = createEnrollmentOffer({
    identity,
    ttlMs: minutes * 60 * 1000,
    label: typeof args.label === 'string' ? args.label : require('node:os').hostname()
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(expiryTimer);
      if (message) emit(message);
      server.close(() => resolve(exitCode));
      // A listener holding a live pairing code must not outlive the pairing.
      server.closeAllConnections?.();
    };

    const server = http.createServer((request, response) => {
      const reply = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      // The offer's PUBLIC parameters. Deliberately not the offerer's public key
      // and not its nonce: those are withheld until a request MAC verifies, so
      // an unauthenticated caller learns nothing it can work with.
      if (request.method === 'GET' && request.url === '/offer') {
        return reply(200, { offerId: offer.offerId, codeSalt: offer.codeSalt, expiresAtMs: offer.expiresAtMs });
      }
      if (request.method !== 'POST' || request.url !== '/enroll') return reply(404, { code: 'PEER_ENROLL_NOT_FOUND' });

      const chunks = [];
      let bytes = 0;
      request.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) { request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on('end', () => {
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reply(400, { code: 'PEER_ENROLL_REQUEST_INVALID' }); }

        let redeemed;
        try {
          redeemed = redeemEnrollmentRequest({ offer, request: payload, identity, code });
        } catch (error) {
          const failureCode = (error && error.code) || 'PEER_ENROLL_REQUEST_INVALID';
          reply(403, { code: failureCode });
          errorOut(`Refused a pairing attempt: ${failureCode}`);
          // A void offer is finished. Keeping the listener open would only serve
          // further guesses against a code that can no longer succeed.
          if (failureCode === 'PEER_ENROLL_OFFER_VOID' || failureCode === 'PEER_ENROLL_CODE_ALREADY_USED') {
            finish(1, 'Pairing was stopped. Run invite again to get a new code.');
          }
          return;
        }
        reply(200, redeemed.response);
        saveEnrolledPeer(root, redeemed.peer);
        finish(0, `\nPaired with ${redeemed.peer.label} (${redeemed.peer.fingerprint}).`);
      });
    });

    const expiryTimer = setTimeout(
      () => finish(1, '\nThe pairing code expired. Run invite again to get a new one.'),
      offer.expiresAtMs - Date.now()
    );

    server.on('error', (error) => {
      errorOut(`Could not start pairing: ${error && error.code}`);
      finish(1);
    });

    server.listen(port, bind, () => {
      for (const line of instruction({
        bind, port, code, minutes, fingerprint: fingerprintForPublicKey(identity.publicKey)
      })) emit(line);
    });
  });
}

// --- join --------------------------------------------------------------------

function httpJson(options, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(options, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) { request.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.end(JSON.stringify(body));
    else request.end();
  });
}

async function commandJoin(root, args, { emit = out } = {}) {
  const address = typeof args.address === 'string' ? args.address : null;
  if (address === null) { errorOut('Give the address shown on the other computer: --address host:port'); return 2; }
  if (typeof args.code !== 'string') { errorOut('Give the pairing code shown on the other computer: --code TE-XXXX-XXXX'); return 2; }
  let normalized;
  try { normalized = normalizeCode(args.code); }
  catch { errorOut('That pairing code is not in the expected format. It looks like TE-XXXX-XXXX.'); return 2; }
  void normalized;

  const [host, portText] = address.split(':');
  const port = Number(portText || DEFAULT_PORT);
  const store = identityStore(root);
  const identity = loadIdentity(store, { create: true });

  let offerInfo;
  try {
    offerInfo = await httpJson({ host, port, path: '/offer', method: 'GET', timeout: 10_000 });
  } catch (error) {
    errorOut(`Could not reach the other computer at ${address} (${error && error.code}).`);
    errorOut('Check that it is showing a pairing code right now.');
    return 1;
  }
  if (offerInfo.status !== 200 || !offerInfo.body || typeof offerInfo.body.offerId !== 'string') {
    errorOut(`The other computer is not offering a pairing right now (status ${offerInfo.status}).`);
    return 1;
  }

  let request;
  try {
    request = createEnrollmentRequest({
      identity,
      offerId: offerInfo.body.offerId,
      codeSalt: offerInfo.body.codeSalt,
      code: args.code,
      label: typeof args.label === 'string' ? args.label : require('node:os').hostname()
    });
  } catch (error) {
    errorOut(`Could not start pairing: ${(error && error.code) || 'PEER_ENROLL_REQUEST_INVALID'}`);
    return 1;
  }

  const result = await httpJson(
    { host, port, path: '/enroll', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 15_000 },
    request
  );
  if (result.status !== 200 || !result.body) {
    errorOut(explainRefusal(result.body && result.body.code));
    return 1;
  }

  let peer;
  try {
    peer = acceptEnrollmentResponse({
      request,
      response: result.body,
      identity,
      codeSalt: offerInfo.body.codeSalt,
      code: args.code,
      // Deliberately NOT `host`. An address is how to reach a computer, never
      // what to call it; letting it become the display name is how an address
      // turns back into an identity (R1228). Absent a name from the peer, the
      // protocol falls back to the fingerprint.
      label: typeof args.peerLabel === 'string' ? args.peerLabel : undefined
    });
  } catch (error) {
    errorOut(explainRefusal(error && error.code));
    return 1;
  }
  saveEnrolledPeer(root, peer);
  emit(`Paired with ${peer.label} (${peer.fingerprint}).`);
  emit('Check the fingerprint matches the one shown on the other computer.');
  return 0;
}

function explainRefusal(code) {
  switch (code) {
    case 'PEER_ENROLL_CODE_REJECTED': return 'That pairing code is not correct. Check it and try again.';
    case 'PEER_ENROLL_CODE_EXPIRED': return 'That pairing code has expired. Get a new one from the other computer.';
    case 'PEER_ENROLL_CODE_ALREADY_USED': return 'That pairing code has already been used. Get a new one from the other computer.';
    case 'PEER_ENROLL_OFFER_VOID': return 'Too many incorrect codes were entered. Get a new code from the other computer.';
    case 'PEER_ENROLL_OFFER_UNKNOWN': return 'The other computer is not offering that pairing any more. Get a new code.';
    case 'PEER_ENROLL_REQUEST_STALE': return 'The two computers disagree about the time by too much to pair safely.';
    case 'PEER_ENROLL_SELF_REFUSED': return 'That is this same computer. Pair two different computers.';
    case 'PEER_ENROLL_PEER_UNVERIFIED': return 'The computer that answered could not prove it knows the pairing code. Pairing was refused.';
    default: return `Pairing was refused (${code || 'unknown reason'}).`;
  }
}

// --- revoke -------------------------------------------------------------------

function commandRevoke(root, args) {
  const target = typeof args.peer === 'string' ? args.peer : null;
  if (target === null) { errorOut('Name the computer to remove: --peer <id>  (see: peer-enroll.js status)'); return 2; }
  const registry = loadPeerRegistry(root);
  const existing = peerById(registry, target);
  if (existing === null) { errorOut(`No paired computer with id ${target}.`); return 1; }
  const result = revokePeer(registry, target, { reason: typeof args.reason === 'string' ? args.reason : 'removed by the owner' });
  savePeerRegistry(root, result.peers);
  const remaining = result.peers.filter(peer => peer.revoked !== true).length;
  out(result.changed ? `Removed ${existing.label}.` : `${existing.label} was already removed.`);
  // The reassurance that a shared-token design could not honestly give.
  out(`${remaining} other paired computer(s) are unaffected and need no action.`);
  return 0;
}

// --- entry ---------------------------------------------------------------------

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'status';
  const root = typeof args.root === 'string' ? path.resolve(args.root) : REPO_ROOT;

  switch (command) {
    case 'status': return commandStatus(root);
    case 'invite': return commandInvite(root, args);
    case 'join': return commandJoin(root, args);
    case 'revoke': return commandRevoke(root, args);
    default:
      out('Usage: node tools/peer-enroll.js <status|invite|join|revoke>');
      out('  status                                     what is paired with this computer');
      out('  invite [--minutes N] [--port N]            show a pairing code for another computer');
      out('  join --address host:port --code TE-...     pair this computer with another');
      out('  revoke --peer <id>                         remove one paired computer');
      return command === 'help' || args.help ? 0 : 2;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    errorOut(`peer-enroll failed: ${(error && error.code) || (error && error.message) || 'unknown'}`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  main,
  identityStore,
  loadIdentity,
  explainRefusal,
  DEFAULT_PORT,
  // Exported for the first-run setup surface (tools/mcsetup.js), which drives
  // these directly so a person is guided by the product rather than told to type
  // this file's name. One protocol implementation, two front doors.
  commandStatus,
  commandInvite,
  commandJoin,
  defaultInviteInstruction
});

#!/usr/bin/env node
'use strict';

// Sends this machine's dedicated FRA token to the exact direct-Ethernet peer
// during the peer's owner-opened one-shot enrollment window. The credential is
// authenticated and encrypted with the already-shared Bridge bootstrap secret;
// neither plaintext nor protected envelope is printed or placed in argv.

const http = require('node:http');
const {
  VAULT_KEY,
  BOOTSTRAP_VAULT_KEY,
  ENROLL_PATH,
  ENROLL_PORT,
  resolveHost,
  peerForHost,
  sealEnrollmentToken,
  runFixedRuntimeIntegrity
} = require('./full-remote-access-enroll-token');
const { getSecret } = require('../src/lib/runtime');

// The owner requires a two-hour cutover budget. The request remains one-shot
// and exact-peer pinned; this only prevents slow audit/vault/restart work from
// manufacturing another client-side timeout during the mechanical reconnect.
// 10s was far too short and produced FRA_ENROLLMENT_PEER_TIMEOUT against a
// perfectly healthy peer. The receiver does real work inside this one request:
// it validates hosts/schema/timestamp/nonce/ciphertext/tag, writes the
// plaintext to the DPAPI vault over child stdin, creates or verifies the
// host-specific runtime integrity anchor, and only then restarts FRA. Measured
// peer tool latency on this link is 15-75s, so the old deadline could expire
// mid-vault-write. Same class of defect as the 4s socket timeout in
// remote-bridge-peer-status.js that manufactured a phantom kill-switch fault.
const REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function sendEnvelope({ host, port = ENROLL_PORT, envelope, requestImpl = http.request }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(envelope), 'utf8');
    const request = requestImpl({
      host, port, method: 'POST', path: ENROLL_PATH,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
        Connection: 'close'
      },
      timeout: REQUEST_TIMEOUT_MS
    }, response => {
      const chunks = [];
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received <= 4096) chunks.push(chunk);
      });
      response.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(Object.assign(new Error('FRA_ENROLLMENT_PEER_RESPONSE_INVALID'), { code: 'FRA_ENROLLMENT_PEER_RESPONSE_INVALID' }));
          return;
        }
        if (response.statusCode === 200 && body && body.ok === true) resolve(true);
        else reject(Object.assign(new Error('FRA_ENROLLMENT_PEER_REJECTED'), { code: 'FRA_ENROLLMENT_PEER_REJECTED' }));
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('FRA_ENROLLMENT_PEER_TIMEOUT'), { code: 'FRA_ENROLLMENT_PEER_TIMEOUT' })));
    request.on('error', reject);
    request.end(payload);
  });
}

async function main({
  resolveHostFn = resolveHost,
  peerForHostFn = peerForHost,
  runIntegrityFn = runFixedRuntimeIntegrity,
  getSecretFn = getSecret,
  sealEnrollmentTokenFn = sealEnrollmentToken,
  sendEnvelopeFn = sendEnvelope,
  writeOutputFn = value => process.stdout.write(value)
} = {}) {
  const sourceHost = resolveHostFn();
  const targetHost = peerForHostFn(sourceHost);
  // Fail closed before reading either credential. A stale or unreviewed sender
  // must never extract vault material merely to discover that it cannot run.
  await runIntegrityFn({ host: sourceHost });
  let token;
  let bootstrapSecret;
  try {
    token = getSecretFn(VAULT_KEY, { prompt: false });
    bootstrapSecret = getSecretFn(BOOTSTRAP_VAULT_KEY, { prompt: false });
    const envelope = sealEnrollmentTokenFn({ token, bootstrapSecret, sourceHost, targetHost });
    token = null;
    bootstrapSecret = null;
    await sendEnvelopeFn({ host: targetHost, envelope });
    writeOutputFn(JSON.stringify({
      ok: true, code: 'FRA_PEER_ENROLLED', peer: targetHost, secretValuesEmitted: false
    }) + '\n');
  } finally {
    token = null;
    bootstrapSecret = null;
  }
}

if (require.main === module) {
  main().catch(error => {
    const code = error && /^[A-Z0-9_]{1,80}$/.test(error.code || error.message)
      ? (error.code || error.message) : 'FRA_PEER_ENROLLMENT_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ REQUEST_TIMEOUT_MS, main, sendEnvelope });

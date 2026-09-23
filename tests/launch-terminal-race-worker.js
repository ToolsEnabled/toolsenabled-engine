'use strict';

// Child half of tests/launch-terminal-race.js.  It intentionally receives only
// an ephemeral test key and an isolated SQLite path; it never touches the
// production audit ledger or vault.

const crypto = require('node:crypto');
const path = require('node:path');
const audit = require('../src/lib/audit');
const outcome = require('../src/lib/launch-outcome');
const { createAuditStore } = require('../src/lib/audit-store');

function dependencies(store, privateKey, publicKeyPem, keyId, root) {
  return {
    store,
    signer: { keyId, publicKeyPem, sign: value => crypto.sign(null, value, privateKey) },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(root, value),
    env: {},
    reportError: () => {},
    // The parent test proves SQLite serialization, not vault anchoring.  A
    // no-op test anchor keeps this ephemeral child fully isolated from the
    // host vault while audit's signed-chain verification still runs.
    anchorStore: { get: () => null, set: () => {} }
  };
}

function main(argv) {
  const [file, root, privateDerBase64, publicPemBase64, keyId, launchId, terminalState] = argv;
  if (!file || !root || !privateDerBase64 || !publicPemBase64 || !keyId || !launchId || !terminalState) {
    throw new Error('missing test worker arguments');
  }
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(privateDerBase64, 'base64'), format: 'der', type: 'pkcs8' });
  const publicKeyPem = Buffer.from(publicPemBase64, 'base64').toString('utf8');
  const store = createAuditStore({ file, busyTimeoutMs: 30_000 });
  try {
    const deps = dependencies(store, privateKey, publicKeyPem, keyId, root);
    const auditApi = { conditionalRecord: request => audit.conditionalRecord(request, deps) };
    try {
      const result = outcome.recordTerminal({ launchId, terminalState }, { audit: auditApi });
      process.stdout.write(`${JSON.stringify({ ok: true, terminalState: result.terminalState, sequence: result.auditSequence })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: error && error.code ? error.code : 'UNKNOWN' })}\n`);
    }
  } finally {
    audit.resetForTests();
    store.close();
  }
}

try { main(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }

'use strict';

// Real child-process writer used by audit-durability-multiprocess.js. The
// parent owns the temporary ledger and sends one shared test signer over stdin.
// A bounded verifier delay models the measured cold-chain cost without making
// the fixture itself tens of megabytes. If verification is inside BEGIN
// IMMEDIATE, peers exhaust their deliberately short writer budget and spool;
// if verification is outside it, all peers verify concurrently and serialize
// only their short append transactions.

const crypto = require('node:crypto');
const path = require('node:path');
const audit = require('../../src/lib/audit');
const { createAuditStore } = require('../../src/lib/audit-store');

const [database, directory, workerId, countText, verifyDelayText, retryText] = process.argv.slice(2);
const count = Number(countText);
const verifyDelayMs = Number(verifyDelayText);
const transactionRetryMs = Number(retryText);
if (!database || !directory || !workerId || !Number.isSafeInteger(count) || count < 1
    || !Number.isSafeInteger(verifyDelayMs) || verifyDelayMs < 1
    || !Number.isSafeInteger(transactionRetryMs) || transactionRetryMs < 1) {
  throw new Error('audit-durability-worker requires database, directory, worker, count, delay, and retry budget.');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const material = JSON.parse(input);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(material.privateDer, 'base64'), type: 'pkcs8', format: 'der'
  });
  const publicKeyPem = Buffer.from(material.publicPem, 'base64').toString('utf8');
  const store = createAuditStore({
    file: database,
    busyTimeoutMs: 1,
    transactionRetryMs
  });
  const verifyWithEvents = store.verifyWithEvents.bind(store);
  store.verifyWithEvents = function delayedVerifyWithEvents(options) {
    const result = verifyWithEvents(options);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, verifyDelayMs);
    return result;
  };

  let anchor = null;
  let nextId = 0;
  const dependencies = {
    store,
    signer: {
      keyId: material.keyId,
      publicKeyPem,
      sign: value => crypto.sign(null, value, privateKey)
    },
    anchorStore: {
      get: () => anchor,
      set: value => { anchor = value; }
    },
    loadPolicy: () => ({ audit: {
      enabled: true,
      jsonlFile: 'actions.jsonl',
      textFile: 'actions.log',
      emergencyFile: 'emergency.jsonl'
    } }),
    rootPath: value => path.join(directory, value),
    env: {},
    eventIdFactory: () => `durability-${workerId}-${String(++nextId).padStart(8, '0')}`,
    clock: Date.now,
    reportError: () => {}
  };

  const statuses = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const status = audit.record(`durability.worker.${workerId}`, 'temporary-ledger', { index }, dependencies);
      statuses.push({ durable: status.durable, pending: status.pending, errors: status.errors });
    }
    process.stdout.write(JSON.stringify({ workerId, statuses }));
  } finally {
    store.close();
  }
});

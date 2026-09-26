'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../../src/lib/audit');
const { createAuditStore } = require('../../src/lib/audit-store');

const [databasePath, directory, worker, countText, mode = 'normal', readyFile = ''] = process.argv.slice(2);
const count = Number(countText);
if (!databasePath || !directory || !worker || !Number.isSafeInteger(count) || count < 1) {
  throw new Error('audit-process-worker requires database, directory, worker, and count.');
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
  const store = createAuditStore({ file: databasePath, busyTimeoutMs: 60_000 });
  let anchor = null;
  let delayed = false;
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
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(directory, value),
    env: {},
    eventIdFactory: (() => { let index = 0; return () => `audit-${worker}-${String(++index).padStart(8, '0')}`; })(),
    clock: Date.now,
    reportError: () => {}
  };
  if (mode === 'slow') {
    dependencies.appendFileSync = (file, content, encoding) => {
      if (!delayed) {
        delayed = true;
        fs.writeFileSync(readyFile, 'ready', 'utf8');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      }
      fs.appendFileSync(file, content, encoding);
    };
  }
  try {
    for (let index = 0; index < count; index += 1) {
      const status = audit.record(`worker.${worker}`, 'projection', { index }, dependencies);
      if (!status.durable) throw new Error(`worker ${worker} failed to append event ${index}`);
    }
  } finally {
    store.close();
  }
});

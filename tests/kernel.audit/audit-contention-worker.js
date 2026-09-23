'use strict';

// The parent creates and initializes the temporary database before this worker
// starts.  Holding the signer inside appendEvent keeps BEGIN IMMEDIATE open,
// giving the parent a deterministic, real cross-process SQLite write conflict.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createAuditStore } = require('../../src/lib/audit-store');

const [databasePath, privateKeyDer, publicKeyPem, eventId, readyFile, holdMsText] = process.argv.slice(2);
const holdMs = Number(holdMsText);
if (!databasePath || !privateKeyDer || !publicKeyPem || !eventId || !readyFile
    || !Number.isSafeInteger(holdMs) || holdMs < 1) {
  throw new Error('audit-contention-worker requires database, signer, event, ready file, and hold duration.');
}

const privateKey = crypto.createPrivateKey({
  key: Buffer.from(privateKeyDer, 'base64'), type: 'pkcs8', format: 'der'
});
const publicKey = Buffer.from(publicKeyPem, 'base64').toString('utf8');
const store = createAuditStore({ file: databasePath, busyTimeoutMs: 30_000 });
try {
  const now = Date.now();
  store.appendEvent({
    eventId,
    occurredAtMs: now,
    createdAtMs: now,
    event: {
      timestamp: new Date(now).toISOString(), action: 'test.contention.lock-holder',
      target: 'temporary-ledger', details: {}
    }
  }, {
    keyId: 'contention-key-0001',
    sign: value => {
      fs.writeFileSync(readyFile, 'ready', 'utf8');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
      return crypto.sign(null, value, privateKey);
    }
  });
} finally {
  store.close();
}

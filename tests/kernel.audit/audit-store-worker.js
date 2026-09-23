'use strict';

const crypto = require('node:crypto');
const { createAuditStore } = require('../../src/lib/audit-store');

const [databasePath, privateKeyDer, publicKeyPem, worker, countText] = process.argv.slice(2);
const count = Number(countText);
if (!databasePath || !privateKeyDer || !publicKeyPem || !worker || !Number.isSafeInteger(count) || count < 1) {
  throw new Error('audit-store-worker requires database, keys, worker label, and positive count.');
}

const privateKey = crypto.createPrivateKey({
  key: Buffer.from(privateKeyDer, 'base64'), type: 'pkcs8', format: 'der'
});
const publicKey = Buffer.from(publicKeyPem, 'base64').toString('utf8');
const store = createAuditStore({ file: databasePath, busyTimeoutMs: 30000 });
try {
  store.registerKey({ keyId: 'concurrency-key-0001', publicKeyPem: publicKey, createdAtMs: 1 });
  for (let index = 0; index < count; index += 1) {
    const id = `event-${worker}-${String(index).padStart(6, '0')}`;
    store.appendEvent({ eventId: id, occurredAtMs: index + 1, createdAtMs: index + 1, event: { worker, index } }, {
      keyId: 'concurrency-key-0001',
      sign: value => crypto.sign(null, value, privateKey)
    });
  }
} finally {
  store.close();
}

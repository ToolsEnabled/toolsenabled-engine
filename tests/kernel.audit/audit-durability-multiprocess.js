'use strict';

// Regression for the production durability breach: full-chain verification
// must not occupy SQLite's single-writer transaction. This test uses real
// hidden child processes and a real temporary SQLite ledger. It never opens
// state/audit.sqlite3 and never relies on the production signer or vault.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const audit = require('../../src/lib/audit');
const { createAuditStore } = require('../../src/lib/audit-store');

// Match the resident writer-process cardinality measured on the launch host.
const WORKERS = 11;
const EVENTS_PER_WORKER = 2;
const VERIFY_DELAY_MS = 500;
const TRANSACTION_RETRY_MS = 200;

function keyMaterial() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = crypto.createHash('sha256')
    .update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return {
    privateKey: pair.privateKey,
    publicKeyPem,
    keyId: `audit-ed25519-${fingerprint}`,
    wire: JSON.stringify({
      privateDer: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      publicPem: Buffer.from(publicKeyPem, 'utf8').toString('base64'),
      keyId: `audit-ed25519-${fingerprint}`
    })
  };
}

function startWorker({ database, directory, workerId, material }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, 'audit-durability-worker.js'),
      database,
      directory,
      workerId,
      String(EVENTS_PER_WORKER),
      String(VERIFY_DELAY_MS),
      String(TRANSACTION_RETRY_MS)
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`durability worker ${workerId} exited ${code}: ${stdout}\n${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`durability worker ${workerId} returned invalid JSON: ${stdout}\n${stderr}`, { cause: error })); }
    });
    child.stdin.end(material.wire);
  });
}

function dependencies(directory, store, material) {
  let anchor = null;
  return {
    store,
    signer: {
      keyId: material.keyId,
      publicKeyPem: material.publicKeyPem,
      sign: value => crypto.sign(null, value, material.privateKey)
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
    clock: Date.now,
    reportError: () => {}
  };
}

async function removeTestDirectory(directory) {
  const deadline = Date.now() + 5_000;
  while (fs.existsSync(directory) && Date.now() < deadline) {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); }
    catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error && error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
  }
  if (fs.existsSync(directory)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-durability-multiprocess-'));
  const database = path.join(directory, 'audit.sqlite3');
  const material = keyMaterial();
  const initializer = createAuditStore({ file: database });
  try {
    initializer.registerKey({
      keyId: material.keyId,
      publicKeyPem: material.publicKeyPem,
      createdAtMs: Date.now()
    });
  } finally {
    initializer.close();
  }

  try {
    const results = await Promise.all(Array.from({ length: WORKERS }, (_, index) => startWorker({
      database,
      directory,
      workerId: `p${index}`,
      material
    })));
    const statuses = results.flatMap(result => result.statuses);
    const nonDurable = statuses.filter(status => status.durable !== true);
    assert.equal(statuses.length, WORKERS * EVENTS_PER_WORKER, 'every child must report every attempted record');
    assert.equal(nonDurable.length, 0,
      `ordinary multi-process contention must produce zero durability breaches: ${JSON.stringify(nonDurable)}`);

    const store = createAuditStore({ file: database });
    try {
      const verification = store.verify();
      assert.equal(verification.valid, true, `the hammered chain must remain valid: ${verification.reason}`);
      assert.equal(verification.entries, WORKERS * EVENTS_PER_WORKER,
        'every attempted event must land in the canonical ledger exactly once');
      const durability = audit.durability(dependencies(directory, store, material));
      assert.equal(durability.totalBreachCount, 0, 'the durability sidecar must retain zero lifetime breaches');
      assert.equal(durability.breachCount, 0, 'the current durability window must contain zero breaches');
      assert.equal(durability.pendingEmergency, 0, 'the emergency spool must be empty');

      // The O(1) in-lock bridge is allowed to save time, never to turn a stale
      // full verification into consent. Rewrite a historical row after a
      // trusted snapshot and prove the exact check misses before the unchanged
      // full verifier names the corrupt chain.
      const external = {
        version: 1,
        cacheable: true,
        anchor: null,
        projectionDigest: 'test-projection-digest',
        emergencyDigest: 'test-emergency-digest'
      };
      const trusted = store.verifyWithEvents({ external });
      assert.equal(trusted.verification.valid, true, 'the pre-tamper witness must be valid');
      const mutator = new DatabaseSync(database);
      try {
        const row = mutator.prepare('SELECT sequence, event_json FROM audit_events ORDER BY sequence LIMIT 1').get();
        const event = JSON.parse(row.event_json);
        event.target = 'tampered-after-full-verification';
        mutator.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = ?')
          .run(JSON.stringify(event), row.sequence);
      } finally {
        mutator.close();
      }
      const accepted = store.withProjectionLock({
        ownerId: 'durability-tamper-witness-0001',
        nowMs: Date.now()
      }, lockedStore => lockedStore.trustedVerificationMatches({ prior: trusted, external }));
      assert.equal(accepted, false,
        'a historical rewrite after full verification must miss the in-lock witness check');
      const invalid = store.verify();
      assert.equal(invalid.valid, false, 'the unchanged full verifier must still reject the rewritten chain');
      assert.equal(invalid.reason, 'event-hash', 'the corruption reason must remain the historical event hash');
    } finally {
      store.close();
    }

    process.stdout.write(`Cross-process audit durability test passed: ${statuses.length} durable writes, 0 breaches.\n`);
  } finally {
    await removeTestDirectory(directory);
  }
})().catch(error => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});

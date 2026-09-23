'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const audit = require('../../src/lib/audit');
const { AuditStoreError, createAuditStore } = require('../../src/lib/audit-store');

const KEY_ID = 'contention-key-0001';

function keyMaterial() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    privateDer: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicArgument: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString('base64')
  };
}

function waitForFile(file, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for lock holder readiness: ${file}`));
      }
    }, 5);
  });
}

function startLockHolder({ database, material, eventId, readyFile, holdMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'audit-contention-worker.js'),
      database, material.privateDer, material.publicArgument, eventId, readyFile, String(holdMs)], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`lock holder exited ${code}: ${stdout}\n${stderr}`));
    });
  });
}

function withMemoryAnchor() {
  let value = null;
  return {
    get: () => value,
    set: next => { value = next; }
  };
}

function errorShape(error) {
  return error ? {
    code: error.code || null,
    sqliteCode: error.details && error.details.sqliteCode || null,
    causeCode: error.cause && error.cause.code || null,
    causeErrcode: error.cause && error.cause.errcode || null
  } : null;
}

async function withContendedWriter({ directory, database, material, label, holdMs, retryMs, write }) {
  const readyFile = path.join(directory, `${label}.ready`);
  const holder = startLockHolder({
    database, material, eventId: `holder-${label}-0001`, readyFile, holdMs
  });
  await waitForFile(readyFile);
  let store;
  let result;
  try {
    store = createAuditStore({ file: database, busyTimeoutMs: 1, transactionRetryMs: retryMs });
    result = { value: write(store) };
  } catch (error) {
    result = { error };
  } finally {
    if (store) store.close();
  }
  await holder;
  return result;
}

function dependencies(directory, store, material) {
  let nextId = 0;
  return {
    store,
    signer: {
      keyId: KEY_ID,
      publicKeyPem: material.publicPem,
      sign: value => crypto.sign(null, value, material.privateKey)
    },
    anchorStore: withMemoryAnchor(),
    loadPolicy: () => ({ audit: {
      enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl'
    } }),
    rootPath: value => path.join(directory, value),
    env: {},
    eventIdFactory: () => `spooled-contention-${String(++nextId).padStart(8, '0')}`,
    clock: Date.now,
    reportError: () => {}
  };
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-contention-'));
  const database = path.join(directory, 'audit.sqlite3');
  const material = keyMaterial();
  const initializer = createAuditStore({ file: database });
  try {
    initializer.registerKey({ keyId: KEY_ID, publicKeyPem: material.publicPem, createdAtMs: 1 });
  } finally {
    initializer.close();
  }

  try {
    // The two processes write transactions against the same real temporary
    // ledger.  The parent deliberately has a 1 ms SQLite wait so this test
    // proves the store-owned retry rather than depending on a long driver wait.
    const transient = await withContendedWriter({
      directory, database, material, label: 'transient', holdMs: 120, retryMs: 500,
      write: store => store.appendEvent({
        eventId: 'transient-writer-0001', occurredAtMs: Date.now(), createdAtMs: Date.now(),
        event: {
          timestamp: new Date().toISOString(), action: 'test.contention.transient',
          target: 'temporary-ledger', details: {}
        }
      }, { keyId: KEY_ID, sign: value => crypto.sign(null, value, material.privateKey) })
    });

    // Keep a second conflict beyond the retry budget.  It confirms the final
    // typed wrapper exposes the actual SQLite code without paths or event data.
    const exhausted = await withContendedWriter({
      directory, database, material, label: 'exhausted', holdMs: 500, retryMs: 40,
      write: store => store.appendEvent({
        eventId: 'exhausted-writer-0001', occurredAtMs: Date.now(), createdAtMs: Date.now(),
        event: {
          timestamp: new Date().toISOString(), action: 'test.contention.exhausted',
          target: 'temporary-ledger', details: {}
        }
      }, { keyId: KEY_ID, sign: value => crypto.sign(null, value, material.privateKey) })
    });

    // This diagnostic is deliberately limited to SQLite code metadata.  On the
    // pre-fix store it records the underlying cause the AUDIT_SQLITE_ERROR
    // wrapper discarded before the assertions demonstrate the regression.
    console.log(`Audit contention observation ${JSON.stringify({ transient: errorShape(transient.error), exhausted: errorShape(exhausted.error) })}`);
    assert.equal(transient.error, undefined,
      `a bounded SQLITE_BUSY overlap must retry instead of rejecting the transaction: ${JSON.stringify(errorShape(transient.error))}`);
    assert.equal(exhausted.error instanceof AuditStoreError, true);
    assert.equal(exhausted.error.code, 'AUDIT_SQLITE_ERROR');
    assert.equal(exhausted.error.details.sqliteCode, 'SQLITE_BUSY');

    const spoolReady = path.join(directory, 'spool.ready');
    const holder = startLockHolder({
      database, material, eventId: 'holder-spool-0001', readyFile: spoolReady, holdMs: 500
    });
    await waitForFile(spoolReady);
    const contendedStore = createAuditStore({ file: database, busyTimeoutMs: 1, transactionRetryMs: 40 });
    const contendedDependencies = dependencies(directory, contendedStore, material);
    let rejected;
    try {
      rejected = audit.record('test.contention.spool', 'temporary-ledger', { safe: 'retained' }, contendedDependencies);
    } finally {
      contendedStore.close();
    }
    await holder;
    assert.equal(rejected.durable, false, 'a rejected canonical event must be visible to the caller');
    assert.equal(rejected.pending, 1, 'the rejected canonical event must be pending in the emergency spool');
    const emergency = path.join(directory, 'emergency.jsonl');
    assert.equal(fs.existsSync(emergency), true);
    assert.equal(fs.readFileSync(emergency, 'utf8').trim().split(/\r?\n/).length, 1);

    const recoveredStore = createAuditStore({ file: database });
    try {
      const recovered = audit.flush({ force: true }, dependencies(directory, recoveredStore, material));
      assert.equal(recovered.projected, true, `spooled event must drain: ${JSON.stringify(recovered)}`);
      assert.equal(fs.existsSync(emergency), false, 'a drained emergency spool must not retain the admitted event');
      const verification = recoveredStore.verify();
      assert.equal(verification.valid, true);
      assert.equal(verification.entries, 5,
        'four admitted process writes plus one drained emergency event must preserve the complete chain');
    } finally {
      recoveredStore.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }

  console.log('Cross-process audit contention tests passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

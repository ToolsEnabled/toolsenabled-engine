'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const audit = require('../../src/lib/audit');
const { createAuditStore } = require('../../src/lib/audit-store');

function keys() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = crypto.createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return {
    privateKey: pair.privateKey,
    publicKeyPem,
    keyId: `audit-ed25519-${fingerprint}`,
    input: JSON.stringify({
      privateDer: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      publicPem: Buffer.from(publicKeyPem).toString('base64'),
      keyId: `audit-ed25519-${fingerprint}`
    })
  };
}

function worker(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'audit-process-worker.js'), ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`audit process exited ${code}: ${stdout}\n${stderr}`)));
    child.stdin.end(input);
  });
}

function waitForFile(file, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(file)) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`Timed out waiting for ${file}`)); }
    }, 20);
  });
}

async function removeTestDirectory(directory) {
  // On Windows a child process can have exited while its final SQLite/JSONL
  // handle is still draining.  Keep the cleanup bounded and scoped to the
  // directory this test just created; do not turn a transient handle race into
  // a false suite failure or delete any unrelated temp data.
  const deadline = Date.now() + 5000;
  while (fs.existsSync(directory) && Date.now() < deadline) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error && error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
  }
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function dependencies(directory, store, material) {
  let anchor = null;
  return {
    store,
    signer: { keyId: material.keyId, publicKeyPem: material.publicKeyPem, sign: value => crypto.sign(null, value, material.privateKey) },
    anchorStore: { get: () => anchor, set: value => { anchor = value; } },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(directory, value),
    env: {},
    clock: Date.now,
    reportError: () => {}
  };
}

(async () => {
  {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-process-'));
    const database = path.join(directory, 'audit.sqlite3');
    const material = keys();
    try {
      await Promise.all(Array.from({ length: 4 }, (_, index) =>
        worker([database, directory, `p${index}`, '5'], material.input)));
      const store = createAuditStore({ file: database });
      try {
        const deps = dependencies(directory, store, material);
        assert.equal(audit.flush({ force: true }, deps).projected, true);
        const verification = audit.verify(deps);
        assert.equal(verification.valid, true);
        assert.equal(verification.entries, 20);
        for (const file of ['actions.jsonl', 'actions.log']) {
          assert.equal(fs.readFileSync(path.join(directory, file), 'utf8').trim().split(/\r?\n/).length, 20);
        }
      } finally { store.close(); }
    } finally { await removeTestDirectory(directory); }
  }

  {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-slow-projector-'));
    const database = path.join(directory, 'audit.sqlite3');
    const ready = path.join(directory, 'projector.ready');
    const material = keys();
    try {
      const slow = worker([database, directory, 'slow', '1', 'slow', ready], material.input);
      await waitForFile(ready);
      const observerStarted = Date.now();
      const observer = createAuditStore({ file: database, busyTimeoutMs: 5_000 });
      try {
        const status = observer.status();
        assert.ok(Number.isSafeInteger(status.headSequence));
        assert.ok(Date.now() - observerStarted < 750,
          'an already-WAL observer must not take a write lock merely to validate a current schema');
      } finally { observer.close(); }
      const started = Date.now();
      const concurrent = worker([database, directory, 'waiting', '1'], material.input);
      await Promise.all([slow, concurrent]);
      assert.ok(Date.now() - started >= 900, 'concurrent appender should wait for the live projection transaction');
      const store = createAuditStore({ file: database });
      try {
        const deps = dependencies(directory, store, material);
        assert.equal(audit.flush({ force: true }, deps).projected, true);
        assert.equal(audit.verify(deps).entries, 2);
      } finally { store.close(); }
    } finally { await removeTestDirectory(directory); }
  }

  console.log('Cross-process audit projection tests passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

'use strict';

// THE PROCESS THAT REBUILT A PROJECTION DOES NOT READ IT BACK.
//
// MEASURED 2026-09-04 on the owner's Live instance at the retention cap: every
// roll rewrote both projection files (11.5 MB + 6.7 MB) and the next admission
// in the same process read and parsed them again -- ~50 MB of allocation a
// minute in the audit worker, a 313 MB worker heap, Windows flagging the
// process for a leak. rebuildProjection now seeds the parse memo with the rows
// and digest it just wrote, so parsedProjection answers from memory.
//
// Driven the way tests/audit-projection-parse-memo.test.js drives the memo: a
// probe copy of audit.js that exports the internals, over real ledger rows.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

function loadInternals() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'audit.js'), 'utf8');
  const probe = path.join(__dirname, '..', 'src', 'lib', `.audit-rebuild-probe-${process.pid}-${crypto.randomUUID()}.cjs`);
  fs.writeFileSync(probe, `${source}\nmodule.exports.__parsedProjection = parsedProjection;\nmodule.exports.__rebuildProjection = rebuildProjection;\nmodule.exports.__projectionLine = projectionLine;\n`);
  try {
    const loaded = require(probe);
    return { parsedProjection: loaded.__parsedProjection, rebuildProjection: loaded.__rebuildProjection, projectionLine: loaded.__projectionLine };
  } finally {
    try { fs.unlinkSync(probe); } catch { /* best effort */ }
  }
}

function memoryAnchor() {
  let value = null;
  return { get: () => value, set(next) { value = next; } };
}

test('after a rebuild, parsedProjection answers from what was just written without reading the file', () => {
  const { parsedProjection, rebuildProjection, projectionLine } = loadInternals();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-rebuild-memo-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const store = createAuditStore({ file: path.join(dir, 'audit.sqlite3') });
  let nextId = 0;
  const deps = {
    store,
    signer: {
      keyId: 'rebuild-key-0001',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: value => crypto.sign(null, value, keys.privateKey)
    },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: (...parts) => path.join(dir, ...parts),
    env: {},
    eventIdFactory: () => `audit-rebuild-${String(++nextId).padStart(8, '0')}`,
    clock: Date.now,
    reportError: () => {},
    anchorStore: memoryAnchor()
  };
  try {
    for (let i = 0; i < 40; i += 1) assert.equal(audit.record('sample.action', `target-${i}`, { i }, deps).durable, true, `record ${i}`);
    const events = store.listEvents({ afterSequence: 0, limit: 100 });
    assert.equal(events.length, 40);
    const retained = events.slice(10);
    for (const sink of ['jsonl', 'text']) {
      const file = path.join(dir, sink === 'jsonl' ? 'actions.jsonl' : 'actions.log');
      rebuildProjection(store, sink, file, retained, {}, Date.now(), null);
      const realRead = fs.readFileSync;
      let reads = 0;
      fs.readFileSync = function counted(target, ...rest) {
        if (typeof target === 'string' && path.resolve(target) === path.resolve(file)) reads += 1;
        return realRead.call(fs, target, ...rest);
      };
      let rows;
      try { rows = parsedProjection(file, sink); }
      finally { fs.readFileSync = realRead; }
      assert.equal(reads, 0, `${sink}: the rebuilt projection was read back from disk`);
      assert.equal(rows.length, retained.length);
      assert.deepEqual(rows.map(row => row.sequence), retained.map(event => event.sequence));
      assert.equal(rows[0].line, projectionLine(sink, retained[0]), 'the remembered rows are the lines that were written');
      // The memo is keyed on the file's real digest: a file changed by
      // somebody else is parsed again, never answered from the stale memory.
      fs.appendFileSync(file, projectionLine(sink, events[0]));
      let readsAfterChange = 0;
      fs.readFileSync = function counted(target, ...rest) {
        if (typeof target === 'string' && path.resolve(target) === path.resolve(file)) readsAfterChange += 1;
        return realRead.call(fs, target, ...rest);
      };
      let reparsed;
      try { reparsed = parsedProjection(file, sink); }
      finally { fs.readFileSync = realRead; }
      assert.equal(readsAfterChange, 1, `${sink}: a file another writer changed must be read again`);
      assert.equal(reparsed.length, retained.length + 1);
    }
  } finally {
    try { audit.resetForTests(); } catch { /* teardown */ }
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

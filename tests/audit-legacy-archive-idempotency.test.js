'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

const keys = crypto.generateKeyPairSync('ed25519');
const signer = {
  keyId: 'legacy-archive-test-key',
  publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  sign: value => crypto.sign(null, value, keys.privateKey)
};

function memoryAnchor() {
  let value = null;
  return {
    get: () => value,
    set(next, sequence) {
      assert.equal(JSON.parse(next).sequence, sequence);
      value = next;
    }
  };
}

function dependencies(directory, store) {
  return {
    store,
    signer,
    anchorStore: memoryAnchor(),
    loadPolicy: () => ({
      audit: {
        enabled: true,
        jsonlFile: 'actions.jsonl',
        textFile: 'actions.log',
        emergencyFile: 'emergency.jsonl'
      }
    }),
    rootPath: value => path.join(directory, value),
    env: {},
    clock: () => 1_700_000_000_000,
    reportError: () => {}
  };
}

function archiveFiles(directory) {
  return fs.readdirSync(directory)
    .filter(name => /\.legacy-[a-f0-9]{16}$/.test(name))
    .sort();
}

function importIntoFreshStore(directory) {
  const store = createAuditStore({ file: ':memory:' });
  const deps = dependencies(directory, store);
  try {
    const status = audit.status(deps);
    assert.equal(audit.verify(deps).valid, true);
    return status;
  } finally {
    store.close();
  }
}

function legacyLedger(action) {
  return [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', action, target: 'one', details: { index: 1 } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', action, target: 'two', details: { index: 2 } })
  ].join('\n') + '\n';
}

audit.resetForTests();

// A second fresh store sees the canonical projection written by the first
// import, but it represents the same two logical audit events. It must not
// archive that derived projection as if it were another legacy source.
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-archive-idempotent-'));
  const source = legacyLedger('legacy.same');
  try {
    fs.writeFileSync(path.join(directory, 'actions.jsonl'), source, 'utf8');
    assert.equal(importIntoFreshStore(directory).headSequence, 2);
    assert.equal(archiveFiles(directory).length, 1);
    const projectionAfterFirstImport = fs.readFileSync(path.join(directory, 'actions.jsonl'), 'utf8');

    assert.equal(importIntoFreshStore(directory).headSequence, 2);
    const archives = archiveFiles(directory);
    assert.equal(archives.length, 1,
      `two imports of the same ledger content must leave exactly one archive on disk; found ${archives.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(directory, archives[0]), 'utf8'), source);
    const projectionAfterSecondImport = fs.readFileSync(path.join(directory, 'actions.jsonl'), 'utf8');
    assert.notEqual(projectionAfterSecondImport, projectionAfterFirstImport,
      'the regression fixture must exercise byte-changing projection recovery, not only copyArchive\'s existing equal-digest no-op');

    assert.equal(importIntoFreshStore(directory).headSequence, 2);
    assert.equal(archiveFiles(directory).length, 1);
    assert.equal(fs.readFileSync(path.join(directory, 'actions.jsonl'), 'utf8'), projectionAfterSecondImport,
      'once canonical projection fields are replayed directly, another fresh store must leave the projection bytes stable');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Distinct raw legacy content in the same location remains a distinct
// recovery source and therefore gets its own content-addressed archive.
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-archive-distinct-'));
  const first = legacyLedger('legacy.first');
  const second = legacyLedger('legacy.second');
  try {
    fs.writeFileSync(path.join(directory, 'actions.jsonl'), first, 'utf8');
    assert.equal(importIntoFreshStore(directory).headSequence, 2);
    fs.writeFileSync(path.join(directory, 'actions.jsonl'), second, 'utf8');
    fs.rmSync(path.join(directory, 'actions.log'), { force: true });
    assert.equal(importIntoFreshStore(directory).headSequence, 2);

    const archives = archiveFiles(directory);
    assert.equal(archives.length, 2, 'different legacy ledgers must leave two archives on disk');
    assert.deepEqual(new Set(archives.map(name => fs.readFileSync(path.join(directory, name), 'utf8'))), new Set([first, second]));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// A mismatch between the independently generated projections is uncertain,
// so it must take the archive-first path instead of assuming prior migration.
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-archive-divergent-projection-'));
  const source = legacyLedger('legacy.divergent');
  try {
    fs.writeFileSync(path.join(directory, 'actions.jsonl'), source, 'utf8');
    assert.equal(importIntoFreshStore(directory).headSequence, 2);
    const textFile = path.join(directory, 'actions.log');
    const divergentText = fs.readFileSync(textFile, 'utf8').replace(' | legacy.divergent | ', ' | forged.divergence | ');
    assert.notEqual(divergentText, fs.readFileSync(textFile, 'utf8'));
    fs.writeFileSync(textFile, divergentText, 'utf8');

    assert.equal(importIntoFreshStore(directory).headSequence, 2);
    const archives = archiveFiles(directory);
    assert.equal(archives.length, 3,
      'a divergent projection pair must preserve both current inputs instead of taking the no-copy path');
    const textArchive = archives.find(name => name.startsWith('actions.log.legacy-'));
    assert.ok(textArchive);
    assert.equal(fs.readFileSync(path.join(directory, textArchive), 'utf8'), divergentText);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Fail closed: a digest-named destination that already contains different
// bytes is a conflict. The migration must neither overwrite it nor import the
// unarchived source.
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-archive-conflict-'));
  const source = legacyLedger('legacy.conflict');
  const sourceFile = path.join(directory, 'actions.jsonl');
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  const archive = `${sourceFile}.legacy-${digest.slice(0, 16)}`;
  const store = createAuditStore({ file: ':memory:' });
  try {
    fs.writeFileSync(sourceFile, source, 'utf8');
    fs.writeFileSync(archive, 'conflicting archive bytes\n', 'utf8');
    assert.throws(() => audit.status(dependencies(directory, store)), error =>
      /Existing audit archive conflicts/.test(String(error?.cause?.message || error?.message)));
    assert.equal(store.status().headSequence, 0, 'a conflicting archive must abort before any legacy event is committed');
    assert.equal(archiveFiles(directory).length, 1);
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
    assert.equal(fs.readFileSync(archive, 'utf8'), 'conflicting archive bytes\n');
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

audit.resetForTests();
console.log('Audit legacy archive idempotency tests passed (4 cases).');

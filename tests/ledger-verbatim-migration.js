'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { migrateLedgerText, migrateFile, migrateAllFiles, VerbatimMigrationError } = require('../tools/ledger-verbatim-migration');

async function run() {
  let checks = 0;
  const input = '{\n  "requests": [\n    { "id": "R1", "request": "controller words", "evidence": "x" },\n    { "id": "R2", "request": "interpretation", "verbatim": "owner \\u2014 exact" },\n    { "id": "R3", "request": "prior", "verbatimAvailable": false }\n  ]\n}\n';
  const migrated = migrateLedgerText(input);
  assert.deepEqual(migrated.changedIds, ['R1']); checks += 1;
  assert.ok(migrated.text.includes('{ "id": "R1", "request": "controller words", "evidence": "x" , "verbatimAvailable": false}')); checks += 1;
  assert.ok(migrated.text.includes('"verbatim": "owner \\u2014 exact"'), 'verbatim source bytes are preserved'); checks += 1;
  assert.ok(migrated.text.includes('"request": "controller words"'), 'request source bytes are preserved'); checks += 1;
  assert.equal(migrateLedgerText(migrated.text).changedIds.length, 0, 'the migration is idempotent'); checks += 1;
  const activeInput = '{\n  "revision": 7,\n  "updatedAt": "2026-08-06",\n  "requests": [{"id":"R4","request":"interpretation"}]\n}\n';
  const active = migrateLedgerText(activeInput, { advanceRevision: true, today: '2026-08-07' });
  assert.equal(active.revisionBefore, 7); checks += 1;
  assert.equal(active.revisionAfter, 8); checks += 1;
  assert.equal(JSON.parse(active.text).revision, 8, 'an active ledger mutation advances its freshness revision once'); checks += 1;
  assert.equal(JSON.parse(active.text).updatedAt, '2026-08-07'); checks += 1;
  assert.equal(migrateLedgerText(active.text, { advanceRevision: true, today: '2026-08-08' }).revisionAfter, null, 'idempotent active re-runs do not advance revision again'); checks += 1;
  assert.throws(() => migrateLedgerText('{"requests":[{"id":"R1","verbatim":"words","verbatimAvailable":false}]}'), VerbatimMigrationError); checks += 1;
  assert.throws(() => migrateLedgerText('{"requests":[{"id":"R1","verbatimAvailable":true}]}'), VerbatimMigrationError); checks += 1;
  await assert.rejects(() => migrateAllFiles({ files: [] }), VerbatimMigrationError); checks += 1;

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-verbatim-migration-'));
  const file = path.join(directory, 'ledger.json');
  try {
    await fs.writeFile(file, input, 'utf8');
    const preview = await migrateFile(file, { advanceRevision: false });
    assert.equal(preview.changed, true); checks += 1;
    assert.equal(await fs.readFile(file, 'utf8'), input, 'check mode writes nothing'); checks += 1;
    const written = await migrateFile(file, { write: true, advanceRevision: false });
    assert.deepEqual(written.changedIds, ['R1']); checks += 1;
    const second = await migrateFile(file, { write: true, advanceRevision: false });
    assert.equal(second.changed, false); checks += 1;
    const pairedFile = path.join(directory, 'paired-ledger.json');
    await fs.writeFile(pairedFile, input, 'utf8');
    let acquired = 0;
    let released = 0;
    const paired = await migrateAllFiles({
      files: [pairedFile], write: true,
      acquireLock: () => {
        acquired += 1;
        return { release: () => { released += 1; } };
      }
    });
    assert.equal(acquired, 1); checks += 1;
    assert.equal(released, 1, 'paired writes release their capture fence'); checks += 1;
    assert.equal(paired[0].changed, true); checks += 1;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  console.log(`ledger-verbatim-migration tests passed (${checks} checks).`);
}

run().catch(error => { console.error(error); process.exit(1); });

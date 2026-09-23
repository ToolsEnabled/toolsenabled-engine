'use strict';

// The accepted d606d88 v1 durable wire format, reconstructed inside a disposable
// test database. This is not a product downgrade or an instruction to rewrite
// real historical receipts. The newer implementation must preserve these exact
// v1 JSON strings/checksums while recovering a genuinely materialized before or
// after image through real SQLite/filesystem adapters.
const assert = require('node:assert/strict');
const { binding, change, inspect, hash } = require('./byte-authority-fixture');
const { createByteAuthority } = require('../../src/lib/region-holds/byte-authority');

async function seedV1Pending(f, { materialized = false } = {}) {
  const writer = binding('legacy-writer'), peer = binding('legacy-peer');
  await f.authority.observeRead({ binding: writer, resource: f.resource });
  await f.authority.observeRead({ binding: peer, resource: f.resource });
  const interrupted = createByteAuthority({ stateRoot: f.root, materialize: f.materialize,
    publish: input => {
      if (materialized) f.publish(input);
      throw new Error('v1 fixture interruption at publication boundary');
    } });
  await assert.rejects(change(interrupted, writer, f.resource, 0, 2, 'AAAA'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(f.authority.dataFile);
  let operation;
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT * FROM operations').get();
    const current = JSON.parse(row.operation_json);
    const fields = ['operationId', 'binding', 'resource', 'receiptRef', 'beforeVersion', 'afterVersion', 'noOp',
      'startByte', 'endByte', 'replacementBase64', 'beforeSha256', 'afterSha256', 'beforeBytes', 'afterBytes',
      'preHash', 'postHash', 'createdAtMs'];
    operation = { schemaVersion: 1 };
    for (const field of fields) operation[field] = current[field];
    operation.operationSha256 = hash(Buffer.from(JSON.stringify(operation)));
    db.prepare('UPDATE operations SET operation_json=? WHERE id=?').run(JSON.stringify(operation), row.id);
    for (const receipt of db.prepare('SELECT * FROM receipts').all()) {
      const legacy = { ...JSON.parse(receipt.receipt_json), schemaVersion: 1 };
      db.prepare('UPDATE receipts SET receipt_json=? WHERE ref=?').run(JSON.stringify(legacy), receipt.ref);
    }
    for (const event of db.prepare('SELECT * FROM events').all()) {
      const payload = JSON.parse(event.payload_json);
      if (event.kind === 'patch.prepared') {
        db.prepare('UPDATE events SET schema_version=1,payload_json=? WHERE sequence=?').run(JSON.stringify(operation), event.sequence);
      } else {
        if (Object.hasOwn(payload, 'schemaVersion')) payload.schemaVersion = 1;
        db.prepare('UPDATE events SET schema_version=1,payload_json=? WHERE sequence=?').run(JSON.stringify(payload), event.sequence);
      }
    }
    db.exec('CREATE TABLE resources_v1 (resource TEXT PRIMARY KEY, version INTEGER NOT NULL, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL)');
    db.exec('INSERT INTO resources_v1 SELECT resource,version,sha256,byte_length FROM resources');
    db.exec('DROP TABLE resources; ALTER TABLE resources_v1 RENAME TO resources; UPDATE meta SET schema_version=1 WHERE id=1; COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
  return { writer, peer, operation,
    operationJson: inspect(f.authority, 'SELECT operation_json FROM operations')[0].operation_json,
    receiptRows: inspect(f.authority, 'SELECT * FROM receipts ORDER BY rowid'),
    events: inspect(f.authority, 'SELECT * FROM events ORDER BY sequence'),
    meta: inspect(f.authority, 'SELECT * FROM meta')[0]
  };
}

module.exports = { seedV1Pending };

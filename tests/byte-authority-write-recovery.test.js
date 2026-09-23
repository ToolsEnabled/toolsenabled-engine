'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { binding, fixture, change, inspect, hash } = require('./helpers/byte-authority-fixture');
const { seedV1Pending } = require('./helpers/byte-authority-v1-fixture');
const { createByteAuthority, SCHEMA_VERSION } = require('../src/lib/region-holds/byte-authority');

function authority(f, options = {}) {
  return createByteAuthority({ stateRoot: f.root, materialize: f.materialize, publish: f.publish,
    prepareCreate: f.prepareCreate, reconcileCreateStage: f.reconcileCreateStage, ...options });
}
const write = (store, actor, resource, bytes) => store.applyWrite({ binding: actor, resource, bytes: Buffer.from(bytes) });
function pending(f) { return JSON.parse(inspect(f.authority, 'SELECT operation_json FROM operations ORDER BY rowid')[0].operation_json); }

test('create journal is durable before the real no-replace publisher runs', async t => {
  const f = fixture(t, null), a = binding('writer');
  const store = authority(f, { publish: input => {
    const row = inspect(f.authority, 'SELECT * FROM operations')[0];
    assert.equal(row.status, 'PREPARED');
    const operation = JSON.parse(row.operation_json);
    assert.deepEqual(operation.createPreparation, input.createPreparation);
    assert.equal(operation.beforePresent, false);
    assert.equal(operation.beforeSha256, null);
    assert.equal(fs.existsSync(input.publicationPath), false);
    assert.equal(fs.statSync(input.createPreparation.stagingPath).nlink, 1);
    assert.equal(hash(fs.readFileSync(input.createPreparation.stagingPath)), operation.afterSha256);
    return f.publish(input);
  } });
  await write(store, a, f.resource, 'created');
  assert.equal(inspect(store, 'SELECT status FROM operations')[0].status, 'COMMITTED');
});

test('revocation after stage preparation but before its journal leaves no target or invented cleanup ownership', async t => {
  const f = fixture(t, null), a = binding('writer');
  let live = true, stage;
  const revoked = authority(f, { prepareCreate: input => {
    const preparation = f.prepareCreate(input);
    stage = preparation.stagingPath;
    live = false;
    return preparation;
  } });
  await assert.rejects(revoked.applyWrite({ binding: a, resource: f.resource, bytes: Buffer.from('staged'),
    assertCurrent: () => { if (!live) throw Object.assign(new Error('revoked'), { code: 'FILE_TOOL_SCOPE_REVOKED' }); }
  }), { code: 'FILE_TOOL_SCOPE_REVOKED' });
  assert.equal(inspect(f.authority, 'SELECT * FROM operations').length, 0);
  assert.equal(inspect(f.authority, 'SELECT * FROM receipts').length, 0);
  assert.equal(fs.existsSync(f.resource), false);
  assert.equal(fs.readFileSync(stage, 'utf8'), 'staged');
  assert.equal((await f.authority.recoverPending()).recovered.length, 0);
  assert.equal(fs.existsSync(stage), true);
});

test('failure before create publication recovers absence and retires only its exact owned stage', async t => {
  const f = fixture(t, null), a = binding('writer');
  const failing = authority(f, { publish: () => { throw new Error('before link'); } });
  await assert.rejects(write(failing, a, f.resource, 'new'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  const operation = pending(f), stage = operation.createPreparation.stagingPath;
  assert.equal(fs.existsSync(stage), true);
  assert.equal(fs.existsSync(f.resource), false);
  const result = await f.authority.recoverPending();
  assert.equal(result.recovered[0].outcome, 'unapplied');
  assert.equal(fs.existsSync(stage), false);
  assert.equal(inspect(f.authority, 'SELECT present,sha256,byte_length FROM resources')[0].present, 0);
  assert.equal(inspect(f.authority, 'SELECT sha256 FROM resources')[0].sha256, null);
  await write(f.authority, a, f.resource, 'new');
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'new');
});

for (const text of ['new contents', '']) {
  test('recovery after link before stage unlink proves exact identity for ' + (text ? 'nonempty' : 'empty') + ' creation', async t => {
    const f = fixture(t, null, { afterCreateLink: () => { throw new Error('after link before unlink'); } });
    const a = binding('writer');
    await assert.rejects(write(f.authority, a, f.resource, text), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
    const operation = pending(f), stage = operation.createPreparation.stagingPath;
    assert.equal(fs.statSync(f.resource).nlink, 2);
    assert.throws(() => f.materialize(f.resource), { code: 'FIXTURE_LINK_REFUSED' }, 'ordinary reads do not relax the hardlink guard');
    const recovered = await f.authority.recoverPending();
    assert.equal(recovered.recovered[0].outcome, 'recovered-materialized');
    assert.equal(recovered.recovered[0].receipt.noOp, false);
    assert.equal(recovered.recovered[0].receipt.beforePresent, false);
    assert.equal(fs.existsSync(stage), false);
    assert.equal(fs.statSync(f.resource).nlink, 1);
    assert.equal((await f.authority.recoverPending()).recovered.length, 0);
    const observed = await f.authority.observeRead({ binding: binding('reader'), resource: f.resource });
    assert.equal(observed.bytes.toString(), text);
  });
}

test('a failed confirmation after completed creation automatically recovers before the next real read', async t => {
  const f = fixture(t, null), a = binding('writer');
  const failing = authority(f, { publish: input => { f.publish(input); throw new Error('after stage unlink'); } });
  await assert.rejects(write(failing, a, f.resource, 'published'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  assert.equal(fs.statSync(f.resource).nlink, 1);
  const observed = await f.authority.observeRead({ binding: a, resource: f.resource });
  assert.equal(observed.bytes.toString(), 'published');
  assert.equal(JSON.parse(inspect(f.authority, 'SELECT receipt_json FROM operations')[0].receipt_json).outcome, 'recovered-materialized');
});

for (const foreign of ['foreign content', 'requested content']) {
  test('no-replace creation preserves a racing target even when ' + (foreign === 'requested content' ? 'its bytes match' : 'its bytes differ'), async t => {
    const f = fixture(t, null), a = binding('writer');
    const colliding = authority(f, { publish: input => {
      fs.writeFileSync(input.publicationPath, foreign, { flag: 'wx' });
      return f.publish(input);
    } });
    await assert.rejects(write(colliding, a, f.resource, 'requested content'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
    const stage = pending(f).createPreparation.stagingPath;
    assert.equal(fs.readFileSync(f.resource, 'utf8'), foreign);
    await assert.rejects(f.authority.recoverPending(), { code: 'BYTE_RECOVERY_UNRESOLVED' });
    assert.equal(inspect(f.authority, 'SELECT status FROM operations')[0].status, 'UNKNOWN');
    assert.equal(fs.readFileSync(stage, 'utf8'), 'requested content');
    assert.equal(fs.readFileSync(f.resource, 'utf8'), foreign);
    const other = f.file('unrelated.txt', 'old');
    await write(f.authority, binding('unrelated-writer'), other, 'new');
    assert.equal(fs.readFileSync(other, 'utf8'), 'new');
  });
}

test('an extra hard-link alias makes interrupted creation UNKNOWN without deleting any evidence', async t => {
  const f = fixture(t, null, { afterCreateLink: () => { throw new Error('after link'); } });
  await assert.rejects(write(f.authority, binding('writer'), f.resource, 'new'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  const stage = pending(f).createPreparation.stagingPath;
  const alias = path.join(f.root, 'extra-alias.txt');
  fs.linkSync(f.resource, alias);
  await assert.rejects(f.authority.recoverPending(), { code: 'BYTE_RECOVERY_UNRESOLVED' });
  assert.equal(fs.statSync(f.resource).nlink, 3);
  assert.ok([stage, alias, f.resource].every(file => fs.existsSync(file)));
});

test('substituting an equal-content target after creation is not recovered as the prepared file identity', async t => {
  const f = fixture(t, null), a = binding('writer');
  const failing = authority(f, { publish: input => { f.publish(input); throw new Error('after publication'); } });
  await assert.rejects(write(failing, a, f.resource, 'new'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  const substituted = f.file('different-inode.txt', 'new');
  fs.renameSync(substituted, f.resource);
  await assert.rejects(f.authority.recoverPending(), { code: 'BYTE_RECOVERY_UNRESOLVED' });
  assert.equal(inspect(f.authority, 'SELECT status FROM operations')[0].status, 'UNKNOWN');
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'new');
});

test('equal-content replacement between publication reconciliation and confirmation cannot commit our creation', async t => {
  const f = fixture(t, null), a = binding('writer');
  const replacing = authority(f, { publish: input => {
    const result = f.publish(input);
    fs.renameSync(f.file('replacement-inode.txt', 'new'), f.resource);
    return result;
  } });
  await assert.rejects(write(replacing, a, f.resource, 'new'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  assert.equal(inspect(f.authority, 'SELECT status FROM operations')[0].status, 'PREPARED');
  assert.equal(inspect(f.authority, 'SELECT receipt_json FROM operations')[0].receipt_json, null);
  await assert.rejects(f.authority.recoverPending(), { code: 'BYTE_RECOVERY_UNRESOLVED' });
  assert.equal(fs.readFileSync(f.resource, 'utf8'), 'new');
});

test('equal-content replacement after recovery reconciliation is detected by the final materialized identity', async t => {
  const f = fixture(t, null), a = binding('writer');
  const failing = authority(f, { publish: input => { f.publish(input); throw new Error('after publication'); } });
  await assert.rejects(write(failing, a, f.resource, 'new'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  const recovering = authority(f, { reconcileCreateStage: input => {
    const result = f.reconcileCreateStage(input);
    fs.renameSync(f.file('replacement-inode.txt', 'new'), f.resource);
    return result;
  } });
  await assert.rejects(recovering.recoverPending(), error => {
    assert.equal(error.code, 'BYTE_RECOVERY_UNRESOLVED');
    assert.equal(error.details.causeCode, 'BYTE_CREATE_IDENTITY_CHANGED');
    return true;
  });
  assert.equal(inspect(f.authority, 'SELECT status FROM operations')[0].status, 'UNKNOWN');
  assert.equal(inspect(f.authority, 'SELECT receipt_json FROM operations')[0].receipt_json, null);
});

test('a byte-only legacy materializer cannot confirm a new file without its exact staged identity', async t => {
  const f = fixture(t, null), a = binding('writer');
  const incomplete = authority(f, { materialize: file => {
    const snapshot = f.materialize(file);
    delete snapshot.identity;
    return snapshot;
  } });
  await assert.rejects(write(incomplete, a, f.resource, 'new'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  assert.equal(inspect(f.authority, 'SELECT status FROM operations')[0].status, 'PREPARED');
  assert.equal((await f.authority.recoverPending()).recovered[0].outcome, 'recovered-materialized');
});

test('a checksummed but arbitrary persisted stage path is rejected before invoking recovery adapters', async t => {
  const f = fixture(t, null), a = binding('writer');
  const failing = authority(f, { publish: () => { throw new Error('before publication'); } });
  await assert.rejects(write(failing, a, f.resource, 'new'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  const unrelated = f.file('must-not-remove.txt', 'keep');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(f.authority.dataFile);
  try {
    const row = db.prepare('SELECT * FROM operations').get();
    const operation = JSON.parse(row.operation_json);
    operation.createPreparation.stagingPath = unrelated;
    delete operation.operationSha256;
    operation.operationSha256 = hash(Buffer.from(JSON.stringify(operation)));
    db.prepare('UPDATE operations SET operation_json=? WHERE id=?').run(JSON.stringify(operation), row.id);
  } finally { db.close(); }
  let calls = 0;
  const recovery = authority(f, { reconcileCreateStage: () => { calls += 1; return { reconciled: true }; } });
  await assert.rejects(recovery.recoverPending(), { code: 'BYTE_STATE_CORRUPT' });
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
});

test('whole-write recovery invalidates old read sets exactly once without manufacturing a read', async t => {
  const f = fixture(t), a = binding('blind-writer'), b = binding('peer');
  await f.authority.observeRead({ binding: b, resource: f.resource, startByte: 2, endByte: 4 });
  const failing = authority(f, { publish: input => { f.publish(input); throw new Error('after rename'); } });
  await assert.rejects(write(failing, a, f.resource, 'replacement'), { code: 'BYTE_PUBLICATION_UNCONFIRMED' });
  await f.authority.recoverPending();
  await assert.rejects(change(f.authority, b, f.resource, 0, 1, 'X'), { code: 'BYTE_READ_SET_STALE' });
  assert.equal(inspect(f.authority, 'SELECT * FROM receipts').length, 1);
  assert.equal(inspect(f.authority, 'SELECT * FROM reads WHERE scope_id=?', a.runtimeScopeId).length, 0);
  assert.equal(inspect(f.authority, "SELECT * FROM events WHERE kind='write.recovered'").length, 1);
  await f.authority.recoverPending();
  assert.equal(inspect(f.authority, "SELECT * FROM events WHERE kind='write.recovered'").length, 1);
});

for (const materialized of [false, true]) {
  test('schema v1 migration preserves exact journal/receipt JSON and recovers the ' + (materialized ? 'after' : 'before') + ' image', async t => {
    const f = fixture(t, 'AA BB');
    const old = await seedV1Pending(f, { materialized });
    assert.equal(old.meta.schema_version, 1);
    const recovered = await f.authority.recoverPending();
    assert.equal(recovered.recovered[0].outcome, materialized ? 'recovered-materialized' : 'unapplied');
    assert.equal(inspect(f.authority, 'SELECT operation_json FROM operations')[0].operation_json, old.operationJson);
    assert.deepEqual(inspect(f.authority, 'SELECT * FROM receipts ORDER BY rowid'), old.receiptRows);
    assert.deepEqual(inspect(f.authority, 'SELECT * FROM events WHERE sequence<=? ORDER BY sequence', old.events.at(-1).sequence), old.events);
    assert.equal(inspect(f.authority, 'SELECT schema_version FROM meta')[0].schema_version, SCHEMA_VERSION);
    assert.equal(inspect(f.authority, 'SELECT authority_id FROM meta')[0].authority_id, old.meta.authority_id);
    assert.equal(inspect(f.authority, 'SELECT present FROM resources')[0].present, 1);
    if (materialized) {
      assert.equal(recovered.recovered[0].receipt.operationSchemaVersion, 1);
      await assert.rejects(change(f.authority, old.peer, f.resource, 0, 1, 'X'), { code: 'BYTE_READ_SET_STALE' });
    }
    const created = path.join(f.root, 'new-after-migration.txt');
    await write(f.authority, binding('new-writer'), created, '');
    assert.equal(fs.existsSync(created), true);
  });
}

test('failed migration rolls back schema/version and preserves its v1 journal for a later recovery', async t => {
  const f = fixture(t, 'AA BB');
  const old = await seedV1Pending(f);
  const failing = authority(f, { now: () => { throw new Error('migration event clock failed'); } });
  await assert.rejects(failing.recoverPending(), { code: 'BYTE_STATE_UNAVAILABLE' });
  assert.equal(inspect(f.authority, 'SELECT schema_version FROM meta')[0].schema_version, 1);
  assert.equal(inspect(f.authority, 'PRAGMA table_info(resources)').some(row => row.name === 'present'), false);
  assert.equal(inspect(f.authority, 'SELECT operation_json FROM operations')[0].operation_json, old.operationJson);
  assert.equal((await f.authority.recoverPending()).recovered[0].outcome, 'unapplied');
});

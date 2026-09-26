'use strict';
require('./helpers/isolated-state-root');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const sqlite = require('node:sqlite');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const filename = path.join(__dirname, '../src/lib/continuation-prune.js');
let code = fs.readFileSync(filename, 'utf8');
const mutation = process.env.CONTINUATION_PRUNE_TEST_MUTATION || '';
const mutations = {
  complete: ['snapshot.complete !== true', 'false'],
  persistence: ['snapshot.persistenceFailed !== false', 'false'],
  integrity: ['hash(row.value_json) !== row.value_hash', 'false'],
  reviewed: ["scopeHash !== undefined && scopeHash !== planned.scopeHash", 'false'],
  approvalFreshness: ["planRows(rowsFrom(source), readTreeSnapshot(), { file, limit, now: now() }).scopeHash !== planned.scopeHash", 'false'],
  empty: ['|| !Array.isArray(snapshot.nodes) || !snapshot.nodes.length', '|| !Array.isArray(snapshot.nodes)'],
  bound: ['orphaned.slice(0, limit)', 'orphaned'],
  lease: ['value.lease == null || value.lease.untilMs <= now', 'true'],
  copy: ['await backup(source, destination);', '/* copy disabled for mutation proof */'],
  approval: ['limit })) !== true)', "limit })) === 'mutation')"],
  backupBudget: ['copies.length >= MAX_RETAINED_BACKUPS', 'false'],
  prepareBusy: ['if (preparing)', 'if (false)'],
  expiry: ['!planned || planned.expires <= now()', '!planned'],
  tokenReuse: ['    pending.delete(token);\n    if (typeof confirmOwner', '    /* retain used token */\n    if (typeof confirmOwner'],
};
if (mutation) {
  const pair = mutations[mutation];
  if (!pair || code.split(pair[0]).length !== 2) throw new Error('unknown or stale test mutation');
  code = code.replace(pair[0], pair[1]);
}
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const now = Date.UTC(2026, 8, 21);
const snapshot = () => ({ complete: true, persistenceFailed: false, revision: 'a'.repeat(64),
  trees: [{ id: 'tree' }], nodes: [{ id: 'kept', treeId: 'tree' }] });

// All SQL writes use in-memory SQLite. The backup transport serializes complete
// fixture tables to retained JSON and reopens them as in-memory SQLite. Calling
// real sqlite.backup() here would unlink a rollback journal on both platforms.
// Production backup transport is not exercised by this no-deletion suite.
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'continuation-prune-retained-'));
  t.diagnostic('Retained synthetic fixture: ' + dir);
  const file = path.join(dir, 'synthetic-source.sqlite3');
  fs.writeFileSync(file, 'synthetic in-memory source marker', { flag: 'wx' });
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec('CREATE TABLE memory_entries(namespace TEXT, entry_key TEXT, value_json TEXT, value_hash TEXT, revision INTEGER, PRIMARY KEY(namespace,entry_key)); CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'preserved\')');
  const add = (key, node, lease = null, namespace = 'agent.continuation.v1') => {
    const value = JSON.stringify({ version: 1, status: 'idle', descriptor: { requestKeys: node ? { threadId: node, treeAnchors: [node] } : null }, lease });
    db.prepare('INSERT INTO memory_entries VALUES (?,?,?,?,?)').run(namespace, key, value, hash(value), 1);
  };
  add('a', 'orphan-a'); add('b', 'orphan-b'); add('k', 'kept'); add('h', null);
  add('l', 'orphan-leased', { untilMs: now + 10000 }); add('other', 'unrelated-node', null, 'another.namespace');
  let reads = 0, asks = 0, clock = now;
  const events = [];
  function readCopy(target) {
    const tables = JSON.parse(fs.readFileSync(target, 'utf8'));
    const copy = new sqlite.DatabaseSync(':memory:');
    for (const table of tables) {
      copy.exec(table.sql);
      if (!table.rows.length) continue;
      const insert = copy.prepare('INSERT INTO "' + table.name.replaceAll('"', '""') + '" VALUES (' + Object.keys(table.rows[0]).map(() => '?').join(',') + ')');
      for (const row of table.rows) insert.run(...Object.values(row));
    }
    return copy;
  }
  const fakeSqlite = {
    DatabaseSync: function (target, opts) {
      if (target === file) return new Proxy(db, { get(obj, key) {
        if (key === 'close') return () => {};
        const value = Reflect.get(obj, key, obj);
        return typeof value === 'function' ? value.bind(obj) : value;
      } });
      return readCopy(target);
    },
    backup: async (source, target) => {
      events.push('backup');
      if (options.backupFails) throw Object.assign(new Error('copy refused'), { code: 'EACCES' });
      const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(table => ({
        ...table, rows: db.prepare('SELECT * FROM "' + table.name.replaceAll('"', '""') + '"').all(),
      }));
      fs.writeFileSync(target, JSON.stringify(tables), 'utf8');
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require: name => name === 'node:sqlite' ? fakeSqlite : require(name), Buffer, console }, { filename });
  const api = module.exports.createContinuationPruner({ file, now: () => clock,
    readTreeSnapshot() { reads++; return options.tree ? options.tree(reads) : snapshot(); },
  });
  const confirmOwner = async scope => { asks++; events.push('ask');
    if (options.onAsk) return options.onAsk(scope, db);
    return true;
  };
  t.after(() => { db.close(); });
  return { api, db, dir, file, events, add, readCopy, confirmOwner, advance: value => { clock += value; }, asks: () => asks, exports: module.exports };
}
async function prune(f, plan = f.api.preview()) {
  const prepared = await f.api.prepare(plan);
  if (prepared.selected === 0) return { ...prepared, removed: 0 };
  return f.api.confirm(prepared, f.confirmOwner);
}
const count = f => f.db.prepare('SELECT count(*) AS n FROM memory_entries').get().n;

test('preview is bounded, excludes current nodes, host rows and live leases, and writes nothing', t => {
  const f = fixture(t); const plan = f.api.preview({ limit: 1 });
  assert.equal(plan.scanned, 5); assert.equal(plan.eligible, 2);
  assert.equal(plan.selected, 1); assert.equal(plan.remaining, 1);
  assert.equal(plan.rows[0].key, 'a'); assert.equal(count(f), 6);
  assert.equal(f.asks(), 0); assert.equal(fs.readdirSync(f.dir).length, 1);
});
test('explicit prune prompts once, retains dated full serialized fixture copy first, and preserves unrelated rows', async t => {
  const f = fixture(t); const plan = f.api.preview({ limit: 1 });
  const result = await prune(f, { scopeHash: plan.scopeHash, limit: 1 });
  assert.equal(result.removed, 1); assert.equal(result.remaining, 1);
  assert.equal(count(f), 5);
  assert.deepEqual(f.events, ['backup', 'ask']);
  assert.match(path.basename(result.backup), /before-prune-2026-09-21T00-00-00-000Z-/);
  const copy = f.readCopy(result.backup);
  try {
    assert.equal(copy.prepare('SELECT count(*) AS n FROM memory_entries').get().n, 6);
    assert.equal(copy.prepare('SELECT value FROM unrelated').get().value, 'preserved');
  } finally { copy.close(); }
  assert.equal(f.db.prepare('SELECT value FROM unrelated').get().value, 'preserved');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_entries WHERE namespace = ?').get('another.namespace').n, 1);
});
test('empty, partial, failed and malformed tree reads explicitly refuse', t => {
  for (const bad of [null, { ...snapshot(), nodes: [] }, { ...snapshot(), complete: false },
    { ...snapshot(), persistenceFailed: true }, { ...snapshot(), nodes: [{ id: 'x', treeId: 'missing' }] }]) {
    const f = fixture(t, { tree: () => bad });
    assert.throws(() => f.api.preview(), { code: 'CONTINUATION_PRUNE_TREES_UNAVAILABLE' });
    assert.equal(count(f), 6); assert.equal(f.asks(), 0);
  }
});
test('native confirmation declines and renderer-shaped approvals never remove', async t => {
  for (const answer of [null, false, { approved: true }]) {
    const f = fixture(t, { onAsk: () => answer }); const plan = f.api.preview();
    await assert.rejects(prune(f, plan), { code: 'CONTINUATION_PRUNE_CANCELLED' });
    assert.equal(count(f), 6); assert.deepEqual(f.events, ['backup', 'ask']);
    assert.equal(fs.readdirSync(f.dir).length, 2);
  }
});
test('changed plan is refused before asking', async t => {
  const f = fixture(t); const plan = f.api.preview(); f.add('new', 'new-orphan');
  await assert.rejects(prune(f, plan), { code: 'CONTINUATION_PRUNE_CHANGED' });
  assert.equal(f.asks(), 0); assert.equal(count(f), 7);
});
test('state changed while approval awaited is refused', async t => {
  const f = fixture(t, { onAsk: (scope, db) => {
    db.prepare('UPDATE memory_entries SET revision=2 WHERE entry_key=?').run('a');
    return true;
  } });
  await assert.rejects(prune(f), { code: 'CONTINUATION_PRUNE_CHANGED' });
  assert.equal(count(f), 6); assert.deepEqual(f.events, ['backup', 'ask']);
});
test('backup failure prevents removal', async t => {
  const f = fixture(t, { backupFails: true });
  await assert.rejects(prune(f), { code: 'EACCES' });
  assert.equal(count(f), 6);
});
test('a tree load failure after the copy prevents removal and retains the copy', async t => {
  const f = fixture(t, { tree: read => read >= 4 ? { ...snapshot(), nodes: [] } : snapshot() });
  await assert.rejects(prune(f), { code: 'CONTINUATION_PRUNE_TREES_UNAVAILABLE' });
  assert.equal(count(f), 6); assert.equal(fs.readdirSync(f.dir).length, 2);
});
test('invalid limits and corrupt memory hashes refuse', t => {
  const f = fixture(t);
  for (const limit of [0, 101, 1.5]) assert.throws(() => f.api.preview({ limit }), { code: 'CONTINUATION_PRUNE_LIMIT' });
  f.db.prepare('UPDATE memory_entries SET value_hash=? WHERE entry_key=?').run('0'.repeat(64), 'a');
  assert.throws(() => f.api.preview(), { code: 'CONTINUATION_PRUNE_CORRUPT' });
  assert.equal(count(f), 6);
});

test('state changing after backup is not removed; copy remains verifiable', async t => {
  let f;
  f = fixture(t, { tree: read => {
    if (read === 4) f.db.prepare('UPDATE memory_entries SET revision=2 WHERE entry_key=?').run('a');
    return snapshot();
  } });
  await assert.rejects(prune(f), { code: 'CONTINUATION_PRUNE_CHANGED' });
  assert.equal(count(f), 6);
  assert.equal(fs.readdirSync(f.dir).length, 2);
});
test('no eligible rows is an explicit no-op and a read exception preserves every row', async t => {
  const all = snapshot();
  for (const id of ['orphan-a', 'orphan-b', 'orphan-leased']) all.nodes.push({ id, treeId: 'tree' });
  const f = fixture(t, { tree: () => all });
  const result = await prune(f);
  assert.equal(result.removed, 0); assert.equal(result.reason, 'no_eligible_orphans');
  assert.equal(f.asks(), 0); assert.equal(count(f), 6);
  const bad = fixture(t, { tree: () => { throw Object.assign(new Error('read failed'), { code: 'EIO' }); } });
  assert.throws(() => bad.api.preview(), { code: 'EIO' }); assert.equal(count(bad), 6);
});

test('prepared tokens bind completed copies and expire or consume exactly once', async t => {
  const f = fixture(t, { onAsk: () => false });
  const prepared = await f.api.prepare({ limit: 1 });
  assert.ok(fs.statSync(prepared.backup).size > 0);
  assert.equal(f.asks(), 0);
  await assert.rejects(f.api.confirm({ token: 'invented', approved: true }, f.confirmOwner), { code: 'CONTINUATION_PRUNE_PREVIEW_REQUIRED' });
  await assert.rejects(f.api.confirm(prepared, f.confirmOwner), { code: 'CONTINUATION_PRUNE_CANCELLED' });
  await assert.rejects(f.api.confirm(prepared, f.confirmOwner), { code: 'CONTINUATION_PRUNE_PREVIEW_REQUIRED' });
  const expired = await f.api.prepare({ limit: 1 });
  f.advance(600001);
  await assert.rejects(f.api.confirm(expired, f.confirmOwner), { code: 'CONTINUATION_PRUNE_PREVIEW_REQUIRED' });
  assert.equal(count(f), 6);
});
test('a stale native preview refuses before the confirmation dialog', async t => {
  const f = fixture(t); const prepared = await f.api.prepare(); f.add('new', 'new-orphan');
  await assert.rejects(f.api.confirm(prepared, f.confirmOwner), { code: 'CONTINUATION_PRUNE_CHANGED' });
  assert.equal(f.asks(), 0); assert.equal(count(f), 7);
});

test('cancelled previews retain their copies and the persistent backup budget refuses more', async t => {
  const f = fixture(t, { onAsk: () => false });
  for (let i = 0; i < 8; i++) {
    const prepared = await f.api.prepare();
    await assert.rejects(f.api.confirm(prepared, f.confirmOwner), { code: 'CONTINUATION_PRUNE_CANCELLED' });
  }
  await assert.rejects(f.api.prepare(), { code: 'CONTINUATION_PRUNE_BACKUP_LIMIT' });
  assert.equal(fs.readdirSync(f.dir).length, 9); assert.equal(count(f), 6);
});

test('overlapping previews refuse before creating a second copy', async t => {
  const f = fixture(t);
  const first = f.api.prepare();
  await assert.rejects(f.api.prepare(), { code: 'CONTINUATION_PRUNE_PREVIEW_BUSY' });
  await first;
  assert.equal(fs.readdirSync(f.dir).length, 2); assert.equal(count(f), 6);
});

'use strict';

// loadRegistry() sits on synchronous hot paths (the tree-slot settings IPC and
// runtimePolicy() on every ledger operation). An unchanged catalogue file must
// be parsed once, a changed one must be read again, and no caller may be able
// to alter what another caller reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadRegistry } = require('../src/lib/settings-registry');

function shippedEntry() {
  return JSON.parse(JSON.stringify(loadRegistry().entries[0]));
}

function countingReads(file, run) {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function counted(target, ...rest) {
    if (typeof target === 'string' && path.resolve(target) === file) reads += 1;
    return original.call(this, target, ...rest);
  };
  try { run(); } finally { fs.readFileSync = original; }
  return reads;
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-registry-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'registry.json');
  const entry = shippedEntry();
  fs.writeFileSync(file, JSON.stringify({ entries: [entry], titles: { [entry.id]: 'First title' } }));
  return { file, entry };
}

test('an unchanged catalogue file is read and validated once', t => {
  const { file, entry } = fixture(t);
  let last;
  const reads = countingReads(file, () => { for (let index = 0; index < 50; index += 1) last = loadRegistry({ registryPath: file }); });
  assert.equal(reads, 1);
  assert.equal(last.byId.get(entry.id).id, entry.id);
  assert.equal(last.titles[entry.id], 'First title');
});

test('the shipped catalogue is served from the same cache', () => {
  const shipped = path.resolve(__dirname, '../config/settings-registry.json');
  loadRegistry();
  assert.equal(countingReads(shipped, () => { for (let index = 0; index < 20; index += 1) loadRegistry(); }), 0);
});

test('a rewritten catalogue is read again, including a same-size rewrite', t => {
  const { file, entry } = fixture(t);
  assert.equal(loadRegistry({ registryPath: file }).titles[entry.id], 'First title');
  const before = fs.statSync(file);
  // Same byte length, and the modification time is put back: only the file's
  // change time still says it was rewritten.
  fs.writeFileSync(file, JSON.stringify({ entries: [entry], titles: { [entry.id]: 'Other title' } }));
  fs.utimesSync(file, before.atime, before.mtime);
  assert.equal(fs.statSync(file).size, before.size);
  assert.equal(loadRegistry({ registryPath: file }).titles[entry.id], 'Other title');
  fs.writeFileSync(file, JSON.stringify({ entries: [entry, entry] }));
  assert.throws(() => loadRegistry({ registryPath: file }), /duplicate settings registry id/);
  fs.writeFileSync(file, JSON.stringify({ entries: [entry], titles: { [entry.id]: 'Third title, longer' } }));
  assert.equal(loadRegistry({ registryPath: file }).titles[entry.id], 'Third title, longer');
});

test('one caller cannot alter what the next caller reads', t => {
  const { file, entry } = fixture(t);
  const first = loadRegistry({ registryPath: file });
  first.entries.length = 0;
  first.byId.clear();
  first.titles[entry.id] = 'altered';
  assert.throws(() => { loadRegistry({ registryPath: file }).byId.get(entry.id).default = 'altered'; }, TypeError);
  const next = loadRegistry({ registryPath: file });
  assert.equal(next.entries.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(next.byId.get(entry.id))), entry);
  assert.equal(next.titles[entry.id], 'First title');
});

test('a missing or invalid catalogue still refuses, and is not cached', t => {
  const { file } = fixture(t);
  const missing = path.join(path.dirname(file), 'absent.json');
  assert.throws(() => loadRegistry({ registryPath: missing }), { code: 'ENOENT' });
  fs.writeFileSync(file, '{ definitely not JSON');
  assert.throws(() => loadRegistry({ registryPath: file }), SyntaxError);
  assert.throws(() => loadRegistry({ registryPath: file }), SyntaxError);
});

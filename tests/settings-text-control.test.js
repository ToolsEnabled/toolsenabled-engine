'use strict';

// AN ADDRESS IS TYPED, NOT CHOSEN.
//
// `pick` solved the model name: chosen from a list the product discovers at run
// time. The endpoint is the other half of the same problem and it is not the
// same shape - nothing can enumerate every address a person's own runtime might
// be listening on, and there is no list to choose from. Left as `readback`, the
// class for values the system maintains and shows, a person whose Ollama is not
// on the default address cannot point the product at it from the settings page
// at all.
//
// `text` is that class: a value the person types. It declares no options, like
// `pick`, and validates as a non-empty string - but it means something
// different to the window, which is the whole reason it is not `pick`: one
// draws a chooser, the other draws a field.
//
// Assertions call loadSettings and coerce with values.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const settings = require('../src/lib/settings');
const settingsSet = require('../tools/settings-set');

// Addresses a person might really type, including the one this machine uses.
const TYPED_ADDRESSES = [
  'http://127.0.0.1:11434',
  'http://localhost:11434',
  'http://192.168.1.50:11434',
  'https://ollama.example.invalid'
];

function registryOf(entries) {
  return { entries, byId: new Map(entries.map(entry => [entry.id, entry])) };
}

function temporaryPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'text-control-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'settings.json');
}

function loadWith(t, entries, values) {
  const valuesPath = temporaryPath(t);
  const provenance = {};
  for (const id of Object.keys(values)) provenance[id] = { source: 'user', atMs: 1 };
  fs.writeFileSync(valuesPath, JSON.stringify({
    schemaVersion: 1, revision: 1, updatedAtMs: 0, values, provenance
  }));
  return settings.loadSettings({ registry: registryOf(entries), valuesPath });
}

const textRow = { id: 'model.endpoint', control: 'text', default: '' };

test('an address the person typed is kept exactly as they typed it', (t) => {
  for (const address of TYPED_ADDRESSES) {
    const result = loadWith(t, [textRow], { 'model.endpoint': address });
    assert.equal(result.values['model.endpoint'], address);
    assert.deepEqual(result.rejected, [],
      `${address} is an address a person may legitimately type and must not be rejected`);
  }
});

test('a typed value still has to be something', (t) => {
  for (const empty of ['', '   ']) {
    assert.equal(loadWith(t, [textRow], { 'model.endpoint': empty }).rejected.length, 1,
      'a blank address is not an address');
  }
  assert.equal(loadWith(t, [textRow], { 'model.endpoint': 11434 }).rejected.length, 1,
    'an address is text, not a number');
});

test('the write path takes a typed address too, not only the read path', (t) => {
  // The lesson that cost three suites when `pick` was added: a class the reader
  // knows and the writer does not is a field that forgets what was typed in it.
  for (const address of TYPED_ADDRESSES) {
    assert.deepEqual(settingsSet.coerce(textRow, address), { ok: true, value: address });
  }
  const blank = settingsSet.coerce(textRow, '   ');
  assert.equal(blank.ok, false);
  assert.ok(String(blank.allowed).trim().length > 0, 'a refusal must say what would have been accepted');
});

test('adding a typed class did not loosen the classes validated against a list', (t) => {
  const entries = [
    { id: 'display.mode', control: 'seg', options: ['compact', 'full'], default: 'compact' },
    { id: 'display.theme', control: 'select', options: ['light', 'dark'], default: 'light' }
  ];
  assert.equal(loadWith(t, entries, { 'display.mode': 'anything', 'display.theme': 'anything' }).rejected.length, 2);
  assert.deepEqual(loadWith(t, entries, { 'display.mode': 'full', 'display.theme': 'dark' }).rejected, []);
});

test('a class this registry does not declare is still refused outright', (t) => {
  assert.equal(loadWith(t, [{ id: 'model.endpoint', control: 'invented', default: '' }], { 'model.endpoint': 'x' }).rejected.length, 1);
  assert.equal(settingsSet.coerce({ id: 'model.endpoint', control: 'invented', default: '' }, 'x').ok, false);
});

test('the shipped registry lets a person point the product at their own address', (t) => {
  // The end of the chain against the real catalogue: an address on another
  // machine on the person's own network, stored and read back unchanged.
  const valuesPath = temporaryPath(t);
  const address = 'http://192.168.1.50:11434';
  fs.writeFileSync(valuesPath, JSON.stringify({
    schemaVersion: 1, revision: 1, updatedAtMs: 0,
    values: { 'model.endpoint': address },
    provenance: { 'model.endpoint': { source: 'user', atMs: 1 } }
  }));
  const result = settings.loadSettings({ valuesPath });
  assert.equal(result.values['model.endpoint'], address);
  assert.equal(result.rejected.filter(item => item.id === 'model.endpoint').length, 0);
});

test('neither model row declares a fixed option list', () => {
  const registry = require('../config/settings-registry.json');
  const rows = [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (typeof node.id === 'string' && node.control) rows.push(node);
      Object.values(node).forEach(walk);
    }
  };
  walk(registry);
  for (const id of ['model.name', 'model.endpoint']) {
    const row = rows.find(item => item.id === id);
    assert.ok(row, `${id} must exist`);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'options'), false,
      `${id} is not chosen from a list this catalogue holds, so it must declare no options`);
  }
});

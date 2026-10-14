'use strict';

// A local model's name is whatever the endpoint happens to be serving. On the
// owner's machine that is "qwen3.5:9b" and two names of the form
// "hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-gguf:Q3_K_M". No static array in
// this registry can enumerate that, so the classes validated against
// entry.options - seg and select - would refuse every model the person owns.
// The row was therefore classified `readback`, the class this registry uses for
// values the system maintains and shows, and the model a person's own computer
// answers with became something they could read and not choose.
//
// `pick` is the missing class: chosen by a person, from a list discovered at
// run time rather than declared in the catalogue.
//
// These tests call loadSettings with values and assert what it accepts and
// rejects. None of them pins a class name except where the registry's own
// declaration is the thing under test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const settings = require('../src/lib/settings');

// Real names, measured from this machine's endpoint on 2026-09-04.
const SERVED_NAMES = [
  'qwen3.5:9b',
  'hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-gguf:Q3_K_M',
  'hf.co/John1604/Qwen3-Coder-30B-A3B-Instruct-gguf:q3_k_s'
];

function registryOf(entries) {
  return { entries, byId: new Map(entries.map(entry => [entry.id, entry])) };
}

function temporaryPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-control-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'settings.json');
}

function writeDocument(file, values, provenance) {
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, revision: 1, updatedAtMs: 0, values, provenance
  }));
}

function loadWith(t, entries, values) {
  const valuesPath = temporaryPath(t);
  const provenance = {};
  for (const id of Object.keys(values)) provenance[id] = { source: 'user', atMs: 1 };
  writeDocument(valuesPath, values, provenance);
  return settings.loadSettings({ registry: registryOf(entries), valuesPath });
}

const pickRow = { id: 'model.name', control: 'pick', default: '' };

test('a name a person picked from a run-time list is kept exactly as it was chosen', (t) => {
  for (const name of SERVED_NAMES) {
    const result = loadWith(t, [pickRow], { 'model.name': name });
    assert.equal(result.values['model.name'], name,
      `${name} is a name this endpoint serves and must survive unchanged`);
    assert.deepEqual(result.rejected, [],
      `${name} must not be rejected; a model the person owns is not an invalid setting`);
  }
});

test('a chooser still refuses a value that names no model at all', (t) => {
  for (const empty of ['', '   ']) {
    const result = loadWith(t, [pickRow], { 'model.name': empty });
    assert.equal(result.rejected.length, 1,
      'a blank name is not a choice and must not be stored as one');
  }
  const wrongType = loadWith(t, [pickRow], { 'model.name': true });
  assert.equal(wrongType.rejected.length, 1, 'a model name is text, not a switch');
});

test('the classes that are validated against a fixed list still are', (t) => {
  // Guard. The whole reason for a new class is that these two could not be
  // used here; they must keep refusing anything outside their declared options.
  const entries = [
    { id: 'display.mode', control: 'seg', options: ['compact', 'full'], default: 'compact' },
    { id: 'display.theme', control: 'select', options: ['light', 'dark'], default: 'light' }
  ];
  const refused = loadWith(t, entries, { 'display.mode': 'enormous', 'display.theme': 'chartreuse' });
  assert.equal(refused.rejected.length, 2, 'a declared-option class must not start accepting free text');
  const accepted = loadWith(t, entries, { 'display.mode': 'full', 'display.theme': 'dark' });
  assert.deepEqual(accepted.rejected, []);
});

test('a class this registry does not declare is still refused outright', (t) => {
  const result = loadWith(t, [{ id: 'model.name', control: 'invented', default: '' }], { 'model.name': 'anything' });
  assert.equal(result.rejected.length, 1,
    'adding one class must not open the door to any word at all in the control field');
});

test('the shipped registry lets the person keep a model this machine actually serves', (t) => {
  // The end of the whole chain, against the real catalogue rather than a
  // fixture: a name from this endpoint, stored, comes back unchanged and
  // unrejected. This is the assertion that fails if model.name is ever put
  // back into a class validated against a declared list.
  const valuesPath = temporaryPath(t);
  const name = 'hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-gguf:Q3_K_M';
  writeDocument(valuesPath, { 'model.name': name }, { 'model.name': { source: 'user', atMs: 1 } });
  const result = settings.loadSettings({ valuesPath });
  assert.equal(result.values['model.name'], name);
  assert.equal(
    result.rejected.filter(item => item.id === 'model.name').length, 0,
    'the shipped registry must not refuse a model the endpoint is serving'
  );
});

test('the write path accepts the chosen name too, not only the read path', () => {
  // A class is not usable until BOTH ends know it. Adding it to the reader
  // alone leaves a row that can be loaded and never stored, which is a chooser
  // that forgets. Three existing suites caught exactly that omission in this
  // change before it was committed, so it is asserted here rather than left to
  // them.
  const settingsSet = require('../tools/settings-set');
  const row = { id: 'model.name', control: 'pick', default: '' };
  for (const name of SERVED_NAMES) {
    assert.deepEqual(settingsSet.coerce(row, name), { ok: true, value: name },
      `${name} must be storable, not merely readable`);
  }
  const blank = settingsSet.coerce(row, '   ');
  assert.equal(blank.ok, false, 'a blank choice is not a choice');
  assert.ok(String(blank.allowed).trim().length > 0,
    'a refusal must say what would have been accepted');
});

test('the shipped model-name row carries no declared option list', () => {
  // Worker 4-1's assertion 6, mirrored on this side of the fence: a `pick` row
  // that also carried `options` would be a select wearing another name, and
  // would refuse every model discovered at run time.
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
  const row = rows.find(item => item.id === 'model.name');
  assert.ok(row, 'the model name row must still exist');
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'options'), false,
    'a run-time chooser must not declare a fixed option list');
});

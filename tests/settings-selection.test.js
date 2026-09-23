'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSettings } = require('../src/lib/settings');

test('selected rows read current values without asking unrelated capability authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selected-settings-'));
  const valuesPath = path.join(root, 'settings.json');
  let authorityReads = 0;
  const machineRecord = { resolveServicesRoot: () => { authorityReads++; throw new Error('unrelated authority'); } };
  const save = value => fs.writeFileSync(valuesPath, JSON.stringify({ revision: 1,
    values: { 'audit.activity': value, 'capability.tier': 'unrestricted' },
    provenance: { 'audit.activity': { source: 'user', atMs: 1, directive: null } } }));
  try {
    save('Essential');
    const options = { ids: ['audit.activity'], valuesPath, machineRecord };
    const first = loadSettings(options);
    assert.deepEqual(first.values, { 'audit.activity': 'Essential' });
    assert.equal(authorityReads, 0);
    save('Full');
    assert.equal(loadSettings(options).values['audit.activity'], 'Full');
    save('unknown');
    const invalid = loadSettings(options);
    assert.equal(invalid.values['audit.activity'], 'Full');
    assert.equal(invalid.rejected[0].id, 'audit.activity');
    fs.writeFileSync(valuesPath, '{');
    assert.equal(loadSettings(options).rejected[0].id, '*');
    assert.throws(() => loadSettings({ ...options, ids: ['unknown.setting'] }), /declared registry ids/);
    save('Off');
    const capability = loadSettings({ ...options, ids: ['capability.tier'] });
    assert.equal(authorityReads, 1);
    assert.equal(capability.readbacks['capability.tier'].readOnly, true);
    assert.equal(capability.rejected[0].id, 'capability.tier');
    assert.notEqual(capability.values['capability.tier'], 'unrestricted');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('kernel tuning reads the same saved values, provenance and file changes as the settings surface', () => {
  const { performanceSettings, SPECS } = require('../src/lib/tool-performance-settings');
  const ids = Object.keys(SPECS);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tuning-settings-'));
  const valuesPath = path.join(root, 'settings.json');
  const previous = process.env.TOOLSENABLED_SETTINGS_PATH;
  process.env.TOOLSENABLED_SETTINGS_PATH = valuesPath;
  const values = { [ids[0]]: 0, [ids[1]]: 2, [ids[2]]: 1 };
  const provenance = Object.fromEntries(ids.map(id => [id, { source: 'user', atMs: 1, directive: null }]));
  const defaults = Object.fromEntries(ids.map(id => [id, SPECS[id].default]));
  const save = document => fs.writeFileSync(valuesPath, JSON.stringify(document));
  const compare = expected => {
    assert.deepEqual(performanceSettings({ fresh: true }), expected);
    assert.deepEqual(loadSettings({ ids, valuesPath }).values, expected);
  };
  try {
    compare(defaults);
    save({ revision: 1, values, provenance });
    compare(values);
    for (const malformed of [
      { revision: 1, values },
      { revision: 1, values, provenance: Object.fromEntries(ids.map(id => [id, { source: 'agent' }])) },
      { revision: 1, values: Object.fromEntries(ids.map(id => [id, -1])), provenance },
      { revision: 1, values: Object.fromEntries(ids.map(id => [id, 1.5])), provenance },
      { revision: 1, values: Object.fromEntries(ids.map(id => [id, '2'])), provenance },
      { revision: 1, values: Object.fromEntries(ids.map(id => [id, SPECS[id].maximum + 1])), provenance },
      { values, provenance }, [], null,
    ]) { save(malformed); compare(defaults); }
    fs.writeFileSync(valuesPath, '{'); compare(defaults);
    save({ revision: 2, values, provenance });
    assert.deepEqual(performanceSettings({ fresh: true, now: 1000 }), values);
    save({ revision: 3, values: defaults, provenance });
    assert.deepEqual(performanceSettings({ now: 2001 }), defaults, 'same-file edits refresh after the read cache expires');
    process.env.TOOLSENABLED_SETTINGS_PATH = path.join(root, 'other.json');
    fs.writeFileSync(process.env.TOOLSENABLED_SETTINGS_PATH, JSON.stringify({ revision: 1, values, provenance }));
    assert.deepEqual(performanceSettings({ now: 2002 }), values, 'changing installation path never reuses another installation cache');
  } finally {
    if (previous === undefined) delete process.env.TOOLSENABLED_SETTINGS_PATH;
    else process.env.TOOLSENABLED_SETTINGS_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

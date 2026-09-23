'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const settings = require('../src/lib/settings');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

function fixtureRegistry() {
  const entries = [
    { id: 'feature.enabled', control: 'toggle', default: true },
    { id: 'display.mode', control: 'seg', options: ['compact', 'full'], default: 'compact' },
    { id: 'display.theme', control: 'select', options: ['light', 'dark'], default: 'light' },
    { id: 'limits.workers', control: 'number', default: 2 }
  ];
  return { entries, byId: new Map(entries.map((entry) => [entry.id, entry])) };
}

function temporaryPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'settings.json');
}

function writeDocument(file, values, provenance = {}, revision = 1) {
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision, updatedAtMs: 0, values, provenance }));
}

test('a missing values file returns every default with default provenance and revision zero', (t) => {
  const valuesPath = temporaryPath(t);
  const result = settings.loadSettings({ registry: fixtureRegistry(), valuesPath });
  assert.deepEqual(result.values, {
    'feature.enabled': true,
    'display.mode': 'compact',
    'display.theme': 'light',
    'limits.workers': 2
  });
  assert.ok(Object.values(result.provenance).every((item) => item.source === 'default'));
  assert.equal(result.revision, 0);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.valuesPath, valuesPath);
});

test('stored values override only their ids and retain recorded provenance', (t) => {
  const valuesPath = temporaryPath(t);
  writeDocument(valuesPath, { 'feature.enabled': false }, {
    'feature.enabled': { source: 'installer', atMs: 42, directive: 'R1209' }
  }, 47);
  const result = settings.loadSettings({ registry: fixtureRegistry(), valuesPath });
  assert.equal(result.values['feature.enabled'], false);
  assert.equal(result.values['display.mode'], 'compact');
  assert.deepEqual(result.provenance['feature.enabled'], { source: 'installer', atMs: 42, directive: 'R1209' });
  assert.equal(result.provenance['display.mode'].source, 'default');
  assert.equal(result.revision, 47);
});

test('a wrong value type is loudly rejected while its default remains', (t) => {
  const valuesPath = temporaryPath(t);
  writeDocument(valuesPath, { 'feature.enabled': 'yes' }, {
    'feature.enabled': { source: 'user', atMs: 5, directive: null }
  });
  const result = settings.loadSettings({ registry: fixtureRegistry(), valuesPath });
  assert.equal(result.values['feature.enabled'], true);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].id, 'feature.enabled');
  assert.equal(result.rejected[0].raw, 'yes');
  // This assertion fails if rejection reasons are dropped or cease naming the id.
  assert.match(result.rejected[0].reason, /feature\.enabled/);
  assert.ok(result.rejected[0].reason.trim().length > 'feature.enabled'.length);
});

for (const id of ['display.mode', 'display.theme']) {
  test(`${id} rejects a value outside its options`, (t) => {
    const valuesPath = temporaryPath(t);
    writeDocument(valuesPath, { [id]: 'neon' }, {
      [id]: { source: 'user', atMs: 5, directive: null }
    });
    const result = settings.loadSettings({ registry: fixtureRegistry(), valuesPath });
    assert.equal(result.values[id], fixtureRegistry().byId.get(id).default);
    assert.match(result.rejected[0].reason, new RegExp(id.replace('.', '\\.')));
  });
}

test('unknown ids are rejected and never enter resolved values', (t) => {
  const valuesPath = temporaryPath(t);
  writeDocument(valuesPath, { 'unknown.setting': 123 }, {
    'unknown.setting': { source: 'user', atMs: 5, directive: null }
  });
  const result = settings.loadSettings({ registry: fixtureRegistry(), valuesPath });
  assert.equal(Object.hasOwn(result.values, 'unknown.setting'), false);
  assert.match(result.rejected[0].reason, /unknown\.setting.*unknown/i);
});

test('malformed files return defaults and one file-level rejection', (t) => {
  const valuesPath = temporaryPath(t);
  fs.writeFileSync(valuesPath, '{not-json');
  const result = settings.loadSettings({ registry: fixtureRegistry(), valuesPath });
  assert.equal(result.values['feature.enabled'], true);
  assert.deepEqual(result.rejected.map(({ id }) => id), ['*']);
  assert.ok(result.rejected[0].reason.length > 0);
  assert.equal(result.revision, 0);
});

test('unreadable paths return defaults and one file-level rejection', (t) => {
  const valuesPath = path.dirname(temporaryPath(t));
  const result = settings.loadSettings({ registry: fixtureRegistry(), valuesPath });
  assert.equal(result.values['feature.enabled'], true);
  assert.deepEqual(result.rejected.map(({ id }) => id), ['*']);
});

test('resolveValuesPath follows the absolute override, then the canonical product service root', () => {
  const syntheticRoot = path.join(isolatedTemporaryRoot(), 'settings-location-fixture');
  const absolute = path.join(syntheticRoot, 'chosen.json');
  assert.equal(settings.resolveValuesPath({ env: {
    TOOLSENABLED_SETTINGS_PATH: absolute,
    LOCALAPPDATA: path.join(syntheticRoot, 'ignored')
  } }), absolute);
  assert.equal(settings.resolveValuesPath({ env: {
    TOOLSENABLED_SETTINGS_PATH: 'relative-is-ignored.json',
    LOCALAPPDATA: path.join(syntheticRoot, 'local'),
    TOOLSENABLED_STATE_ROOT: path.join(syntheticRoot, 'roaming', 'ToolsEnabled Test', 'capability')
  } }), path.join(syntheticRoot, 'local', 'ToolsEnabled Test', 'settings.json'));
  assert.throws(() => settings.resolveValuesPath({ env: {
    LOCALAPPDATA: path.join(syntheticRoot, 'local')
  } }), error => error.code === 'SERVICE_PRODUCT_IDENTITY_UNAVAILABLE');
});

test('the module exposes no settings write path', () => {
  assert.deepEqual(Object.keys(settings).sort(), ['loadSettings', 'resolveValuesPath']);
  assert.equal(Object.keys(settings).some((name) => /^(write|set|save|update|delete|patch)/i.test(name)), false);
});

test('an absent default registry produces a clear named error', () => {
  const registryModulePath = require.resolve('../src/lib/settings');
  const expectedRegistryPath = path.join(path.dirname(registryModulePath), 'settings-registry.js');
  if (fs.existsSync(expectedRegistryPath)) return;
  assert.throws(
    () => settings.loadSettings(),
    (error) => error.name === 'SettingsRegistryUnavailableError'
      && error.code === 'SETTINGS_REGISTRY_UNAVAILABLE'
      && /pre-loaded registry/.test(error.message)
  );
});

test('a registry initialization failure is not answered by the local declaration fallback', (t) => {
  const originalLoad = Module._load;
  const initializationFailure = Object.assign(new Error('registry initialization failed'), {
    code: 'REGISTRY_INITIALIZATION_FAILED'
  });
  Module._load = function loadWithBrokenRegistry(request, parent, isMain) {
    if (request === './settings-registry' && parent && parent.filename === require.resolve('../src/lib/settings')) {
      throw initializationFailure;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = originalLoad; });

  assert.throws(
    () => settings.loadSettings({ registry: fixtureRegistry(), valuesPath: temporaryPath(t) }),
    (error) => error === initializationFailure
  );
});

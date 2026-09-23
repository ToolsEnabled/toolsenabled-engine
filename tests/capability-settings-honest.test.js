'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const confinement = require('../src/lib/agent-session-confinement');
const registryModule = require('../src/lib/settings-registry');
const settings = require('../src/lib/settings');
const settingsSet = require('../tools/settings-set');

const TIER_ID = 'capability.tier';
const ROOTS_ID = 'capability.workspace_roots';

function capabilityRegistry() {
  const entries = [
    { id: TIER_ID, control: 'readback', default: 'set at install', enforcedBy: 'machine.json', derivedFrom: 'setup' },
    { id: ROOTS_ID, control: 'readback', default: [], enforcedBy: 'machine.json', derivedFrom: 'setup' }
  ];
  return { entries, byId: new Map(entries.map(entry => [entry.id, entry])) };
}

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-settings-honest-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('the two capability rows are read-only readbacks, not settings controls', () => {
  const registry = registryModule.loadRegistry();
  for (const id of [TIER_ID, ROOTS_ID]) {
    const entry = registry.byId.get(id);
    assert.ok(entry, `${id} must remain visible in Settings`);
    assert.equal(entry.control, 'readback', `${id} must be disabled rather than writable`);
    assert.match(entry.readOnlyReason, /read-only/i);
    assert.match(entry.readOnlyReason, /machine\.json/i);
    assert.notEqual(entry.enforcedBy.trim(), '', `${id} must name the real enforcement path`);
  }
});

test('read-only reasons cannot be blank or attached to a writable control', () => {
  const registry = registryModule.loadRegistry();
  const entry = registry.byId.get(TIER_ID);
  const blank = registryModule.validateEntry({ ...entry, readOnlyReason: '   ' });
  assert.equal(blank.ok, false);
  assert.ok(blank.errors.some(error => /readOnlyReason must be non-empty/.test(error)));

  const writable = registryModule.validateEntry({
    ...entry,
    control: 'seg',
    options: [entry.default]
  });
  assert.equal(writable.ok, false);
  assert.ok(writable.errors.some(error => /only valid for readback/.test(error)));
});

test('capability readbacks come from machine.json and stored settings cannot override them', (t) => {
  const servicesRoot = scratch(t);
  const workspace = path.join(servicesRoot, 'customer-workspace');
  fs.mkdirSync(workspace);
  const valuesPath = path.join(servicesRoot, 'settings.json');
  fs.writeFileSync(valuesPath, JSON.stringify({
    revision: 9,
    values: {
      [TIER_ID]: 'unrestricted',
      [ROOTS_ID]: [path.join(servicesRoot, 'widened-by-settings')]
    },
    provenance: {
      [TIER_ID]: { source: 'user', atMs: 99, directive: null },
      [ROOTS_ID]: { source: 'user', atMs: 99, directive: null }
    }
  }));

  const record = { tier: 'standard', workspaceRoots: [workspace], createdAtMs: 42 };
  const machineRecord = {
    resolveServicesRoot: () => servicesRoot,
    machineRecordPath: root => path.join(root, 'machine.json'),
    readMachineRecord: () => record
  };
  const resolved = settings.loadSettings({
    registry: capabilityRegistry(), valuesPath, machineRecord, servicesRoot
  });

  assert.equal(resolved.values[TIER_ID], record.tier);
  assert.deepEqual(resolved.values[ROOTS_ID], record.workspaceRoots);
  assert.equal(resolved.provenance[TIER_ID].source, 'installer');
  assert.equal(resolved.provenance[ROOTS_ID].source, 'installer');
  assert.equal(resolved.readbacks[TIER_ID].authorityPath, path.join(servicesRoot, 'machine.json'));
  assert.equal(resolved.readbacks[TIER_ID].status, 'recorded');
  assert.equal(resolved.readbacks[ROOTS_ID].status, 'recorded');
  assert.deepEqual(resolved.rejected.map(item => item.id).sort(), [ROOTS_ID, TIER_ID].sort());
  assert.ok(resolved.rejected.every(item => /read-only/i.test(item.reason)));
  const described = settingsSet.describe(resolved, TIER_ID);
  assert.match(described, new RegExp(path.join(servicesRoot, 'machine.json').replace(/[\\]/g, '\\\\')));
  assert.match(described, /read-only, recorded/);
});

test('an absent or unreadable machine record is a named fail-closed readback', (t) => {
  const servicesRoot = scratch(t);
  const machineRecord = {
    resolveServicesRoot: () => servicesRoot,
    machineRecordPath: root => path.join(root, 'machine.json'),
    readMachineRecord: () => {
      const error = new Error('seal mismatch');
      error.code = 'SETUP_MACHINE_RECORD_TAMPERED';
      throw error;
    }
  };
  const resolved = settings.loadSettings({
    registry: capabilityRegistry(),
    valuesPath: path.join(servicesRoot, 'absent-settings.json'),
    machineRecord,
    servicesRoot
  });

  assert.equal(resolved.values[TIER_ID], confinement.FAIL_CLOSED_TIER);
  assert.deepEqual(resolved.values[ROOTS_ID], []);
  assert.equal(resolved.readbacks[TIER_ID].status, 'failed-closed');
  assert.equal(resolved.readbacks[TIER_ID].reason, 'SETUP_MACHINE_RECORD_TAMPERED');
  assert.equal(resolved.readbacks[ROOTS_ID].reason, 'SETUP_MACHINE_RECORD_TAMPERED');
});

test('temporary machine-record failures are not absence answers or latched', (t) => {
  const servicesRoot = scratch(t);
  const workspace = path.join(servicesRoot, 'customer-workspace');
  let outcome;
  const machineRecord = {
    resolveServicesRoot: () => servicesRoot,
    machineRecordPath: root => path.join(root, 'machine.json'),
    readMachineRecord: () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
  };
  const options = {
    registry: capabilityRegistry(),
    valuesPath: path.join(servicesRoot, 'absent-settings.json'),
    machineRecord,
    servicesRoot
  };

  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT', 'SETUP_MACHINE_RECORD_UNREADABLE']) {
    outcome = Object.assign(new Error(`synthetic ${code}`), { code });
    assert.throws(() => settings.loadSettings(options), error =>
      error.code === 'SETTINGS_MACHINE_RECORD_UNAVAILABLE'
      && /NOT a claim.*absent/.test(error.message)
      && error.cause === outcome);
  }

  // The failure was not latched: the same dependency can answer on retry.
  outcome = { tier: 'standard', workspaceRoots: [workspace], createdAtMs: 42 };
  const recovered = settings.loadSettings(options);
  assert.equal(recovered.values[TIER_ID], 'standard');
  assert.deepEqual(recovered.values[ROOTS_ID], [workspace]);

  // Control: ordinary CommonJS caching remains intact; disabling all caching
  // is not an acceptable way to make the retry above pass.
  assert.equal(require('../src/lib/settings'), settings);
});

// The reason is the row's own, not a placeholder. This test used to assert
// `read-only; change it through the named authority instead` -- a sentence that
// names no authority, so the test's own title ("with a reason") was true of a
// refusal that told the person nothing. The catalogue already writes the
// sentence that says what to run instead; the writer now refuses in those
// words. See tests/settings-readonly-reason-is-read.test.js.
test('the human settings writer refuses the two machine-boundary readbacks with a reason', () => {
  const registry = registryModule.loadRegistry();
  for (const id of [TIER_ID, ROOTS_ID]) {
    const entry = registry.byId.get(id);
    assert.deepEqual(settingsSet.coerce(entry, 'unrestricted'), {
      ok: false,
      allowed: entry.readOnlyReason.trim()
    });
    assert.match(settingsSet.coerce(entry, 'unrestricted').allowed, /run ToolsEnabled setup again yourself/,
      `${id} must be refused with the step the person takes instead`);
  }
  assert.deepEqual(settingsSet.coerce(registry.byId.get('model.name'), 'chosen-model'), {
    ok: true,
    value: 'chosen-model'
  }, 'unrelated readback settings keep their existing write behaviour');
});

test('the human settings writer refuses an existing document with uncertain structure', (t) => {
  const directory = scratch(t);
  const valuesPath = path.join(directory, 'settings.json');
  const invalidDocuments = [
    [{ values: {}, provenance: {} }, /missing or invalid revision/],
    [{ revision: 1, provenance: {} }, /missing or invalid values/],
    [{ revision: 1, values: {} }, /missing or invalid provenance/]
  ];

  for (const [document, expected] of invalidDocuments) {
    fs.writeFileSync(valuesPath, JSON.stringify(document));
    assert.throws(() => settingsSet.readDocument(valuesPath), expected);
  }
});

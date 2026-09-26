'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const { createDurableMemoryFile } = require('../src/lib/durable-memory-file');
const { createCustomRoleStore } = require('../src/lib/custom-role-store');
const { createInstalledAgentOrgStores } = require('../src/lib/agent-org-store');
const { installedRoleMemoryFiles } = require('../src/lib/installed-role-memory');

const baselineFile = path.join(__dirname, '../config/agent-org.json');
const role = {
  id: 'stored-reader', baseDefaultRole: 'observer',
  rules: { owns: 'Read the assigned artifact.', mustNot: 'Write owner data.', handoff: 'Return evidence.' }
};

function fixture() {
  const root = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'role-files-'));
  const env = {
    ...process.env, LOCALAPPDATA: path.join(root, 'local'),
    TOOLSENABLED_STATE_ROOT: path.join(root, 'roaming', 'RoleContract', 'capability')
  };
  const [canonicalFile, legacyFile] = installedRoleMemoryFiles({ env });
  const memory = file => createDurableMemoryFile({ file });
  const roles = file => createCustomRoleStore({ stateStore: memory(file) });
  const open = options => createInstalledAgentOrgStores({ baselineFile, env, ...options });
  return { root, env, canonicalFile, legacyFile, memory, roles, open };
}

function preserve(files, operation) {
  const before = files.map(file => fs.readFileSync(file));
  operation();
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], `${path.basename(file)} changed`));
}

test('fresh state selects the app-compatible filename without creating either file', () => {
  const f = fixture();
  const stores = f.open();
  assert.deepEqual(stores.roleMemorySelection, { file: f.canonicalFile, source: 'canonical' });
  assert.deepEqual(stores.roleMemoryFiles, [f.canonicalFile, f.legacyFile]);
  stores.read();
  assert.equal(fs.existsSync(f.canonicalFile), false);
  assert.equal(fs.existsSync(f.legacyFile), false);
});

test('legacy-only history stays in place with exact revisions and unrelated memory intact', () => {
  const f = fixture();
  f.roles(f.legacyFile).createCustomRole(role);
  f.roles(f.legacyFile).editRole({ id: role.id, rules: { ...role.rules, owns: 'Read two artifacts.' }, expectedRevision: 1 });
  f.memory(f.legacyFile).setMemory({ namespace: 'unrelated', key: 'retained', value: { count: 3 } });
  preserve([f.legacyFile], () => {
    const stores = f.open();
    assert.deepEqual(stores.roleMemorySelection, { file: f.legacyFile, source: 'legacy-compatibility' });
    assert.equal(stores.roleStore.getRoleRecord(role.id).revision, 2);
    assert.ok(stores.read().roles.some(entry => entry.id === role.id));
  });
  assert.equal(fs.existsSync(f.canonicalFile), false, 'compatibility reads must not copy the legacy file');
  f.open().roleStore.editRole({ id: role.id, rules: { ...role.rules, owns: 'Read three artifacts.' }, expectedRevision: 2 });
  assert.equal(f.roles(f.legacyFile).getRoleRecord(role.id).revision, 3);
  assert.deepEqual(f.memory(f.legacyFile).getMemory({ namespace: 'unrelated', key: 'retained' }).value, { count: 3 });
  assert.equal(fs.existsSync(f.canonicalFile), false, 'a legacy-compatible edit must not fork authority');
});

test('generic legacy memory is not role history and is never copied or changed', () => {
  const f = fixture();
  f.memory(f.legacyFile).setMemory({ namespace: 'notes', key: 'custom-roles', value: 'not role authority' });
  preserve([f.legacyFile], () => {
    const stores = f.open();
    assert.equal(stores.roleMemorySelection.source, 'canonical');
    stores.roleStore.createCustomRole(role);
    assert.equal(f.open().roleStore.getRoleRecord(role.id).revision, 1);
  });
});

for (const location of ['canonical', 'legacy']) {
  test(`a no-base custom role remains readable and editable in ${location} memory`, () => {
    const f = fixture();
    const file = location === 'canonical' ? f.canonicalFile : f.legacyFile;
    const definition = { ...role, baseDefaultRole: null,
      functions: ['app.context'], requiresDirectUserAuthorization: true };
    f.roles(file).createCustomRole(definition);
    preserve([file], () => {
      const stores = f.open();
      assert.equal(stores.roleMemorySelection.file, file);
      const saved = stores.roleStore.getRoleRecord(role.id);
      assert.equal(saved.revision, 1);
      assert.equal(saved.definition.baseDefaultRole, null);
      assert.deepEqual(saved.definition.functions, definition.functions);
      assert.equal(saved.definition.requiresDirectUserAuthorization, true);
      assert.ok(stores.read().roles.some(entry => entry.id === role.id));
    });
    f.open().roleStore.editRole({ id: role.id, rules: role.rules, expectedRevision: 1 });
    assert.equal(f.open().roleStore.getRoleRecord(role.id).revision, 2);
    assert.equal(fs.existsSync(location === 'canonical' ? f.legacyFile : f.canonicalFile), false);
  });
}

test('a repeated installed read refreshes previously absent roles and later role revisions', () => {
  const f = fixture();
  const old = f.open();
  assert.equal(old.roleStore.getRoleRecord(role.id), null);
  f.open().roleStore.createCustomRole(role);
  assert.ok(old.read().roles.some(entry => entry.id === role.id));
  assert.equal(old.roleStore.getRoleRecord(role.id).revision, 1);
  f.open().roleStore.editRole({ id: role.id, rules: { ...role.rules, owns: 'Read the updated artifact.' }, expectedRevision: 1 });
  old.read();
  assert.equal(old.roleStore.getRoleRecord(role.id).revision, 2);
});

test('two histories refuse without changing either file, even with equal visible definitions', () => {
  for (const sameRevision of [true, false]) {
    const f = fixture();
    f.roles(f.canonicalFile).createCustomRole(role);
    f.roles(f.legacyFile).createCustomRole(role);
    if (!sameRevision) f.roles(f.legacyFile).editRole({ id: role.id, rules: role.rules, expectedRevision: 1 });
    preserve([f.canonicalFile, f.legacyFile], () => {
      assert.throws(() => f.open(), { code: 'INSTALLED_ROLE_MEMORY_CONFLICT' });
    });
  }
});

test('empty canonical state does not resurrect a legacy default override', () => {
  const f = fixture();
  f.memory(f.canonicalFile).setMemory({ namespace: 'temporary', key: 'removed', value: true });
  f.memory(f.canonicalFile).deleteMemory({ namespace: 'temporary', key: 'removed' });
  f.roles(f.legacyFile).editDefaultRole({ id: 'observer', rules: role.rules, expectedRevision: 0 });
  preserve([f.canonicalFile, f.legacyFile], () => {
    assert.throws(() => f.open(), { code: 'INSTALLED_ROLE_MEMORY_CONFLICT' });
  });
});

test('all role-namespace entries count as history, not only active searchable definitions', () => {
  const f = fixture();
  f.roles(f.canonicalFile).createCustomRole(role);
  f.memory(f.legacyFile).setMemory({ namespace: 'custom-roles', key: 'retired:record', value: { deleted: true } });
  assert.throws(() => f.open(), { code: 'INSTALLED_ROLE_MEMORY_CONFLICT' });
});

test('an unsearchable unsupported role-history entry cannot become a default-only vocabulary', () => {
  const f = fixture();
  f.memory(f.legacyFile).setMemory({ namespace: 'custom-roles', key: 'retired:record', value: { deleted: true } });
  assert.throws(() => f.open(), { code: 'CUSTOM_ROLE_STORE_DAMAGED' });
  assert.equal(fs.existsSync(f.canonicalFile), false);
});

test('a valid role hidden by missing search metadata refuses instead of disappearing', () => {
  const f = fixture();
  f.roles(f.legacyFile).createCustomRole(role);
  const record = JSON.parse(fs.readFileSync(f.legacyFile, 'utf8'));
  for (const entry of Object.values(record.entries)) {
    delete entry.note;
    delete entry.tags;
  }
  fs.writeFileSync(f.legacyFile, JSON.stringify(record));
  assert.throws(() => f.open(), { code: 'CUSTOM_ROLE_STORE_DAMAGED' });
  assert.equal(fs.existsSync(f.canonicalFile), false);
});

test('an installed role-memory reparse target refuses without following or altering it', () => {
  const f = fixture();
  const target = path.join(f.root, 'owned-link-target');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.dirname(f.canonicalFile), { recursive: true });
  fs.symlinkSync(target, f.canonicalFile, 'junction');
  assert.throws(() => f.open(), error => error.code === 'AGENT_CONFINEMENT_PROFILE_REPARSE_POINT'
    || error.code === 'INSTALLED_ROLE_MEMORY_UNAVAILABLE');
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.lstatSync(f.canonicalFile).isSymbolicLink(), true);
});

test('a second file appearing after construction invalidates a repeated installed read', () => {
  const f = fixture();
  f.roles(f.legacyFile).createCustomRole(role);
  const stores = f.open();
  assert.ok(stores.read().roles.some(entry => entry.id === role.id));
  f.roles(f.canonicalFile).createCustomRole(role);
  assert.throws(() => stores.read(), { code: 'INSTALLED_ROLE_MEMORY_CONFLICT' });
});

test('malformed or unreadable candidates are not silently treated as empty histories', () => {
  for (const name of ['canonicalFile', 'legacyFile']) {
    const f = fixture();
    fs.mkdirSync(path.dirname(f[name]), { recursive: true });
    fs.writeFileSync(f[name], '{ malformed');
    preserve([f[name]], () => assert.throws(() => f.open(), { code: 'DURABLE_MEMORY_DAMAGED' }));
  }
  const f = fixture();
  f.roles(f.canonicalFile).createCustomRole(role);
  const io = Object.create(fs);
  io.readFileSync = (file, ...args) => {
    if (file === f.canonicalFile) throw Object.assign(new Error('injected unreadable file'), { code: 'EACCES' });
    return fs.readFileSync(file, ...args);
  };
  assert.throws(() => f.open({ fileSystem: io }), { code: 'DURABLE_MEMORY_DAMAGED' });
});

test('explicit embedding paths are preserved and do not invoke installed compatibility selection', () => {
  const f = fixture();
  f.roles(f.canonicalFile).createCustomRole(role);
  f.roles(f.legacyFile).createCustomRole(role);
  const stores = f.open({ roleMemoryFile: f.legacyFile });
  assert.deepEqual(stores.roleMemoryFiles, [f.legacyFile]);
  assert.deepEqual(stores.roleMemorySelection, { file: f.legacyFile, source: 'explicit' });
  assert.equal(stores.roleStore.getRoleRecord(role.id).revision, 1);
});

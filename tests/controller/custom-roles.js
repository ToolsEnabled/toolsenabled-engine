'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../../src/lib/state-store');
const roles = require('../../src/lib/custom-role-store');
const org = require('../../src/lib/agent-org');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const rules = suffix => ({ owns: `Owns ${suffix}.`, mustNot: `Must not ${suffix}.`, handoff: `Hands off ${suffix}.` });
const storeForTest = () => {
  const stateStore = createStateStore({ file: ':memory:' });
  return { stateStore, store: roles.createCustomRoleStore({ stateStore }) };
};
const capabilities = overrides => ({
  orgRoot: false,
  singleSeat: false,
  mayClaimWork: false,
  mayWakeReports: false,
  requiresMutationContext: false,
  mayUseMissionBridge: false,
  mayReportMissionBridge: false,
  mayMutateMissionBridge: false,
  ...overrides
});

check('creates, reads, lists, and immutably exposes a custom role', () => {
  const { stateStore, store } = storeForTest();
  const created = store.createCustomRole({ id: 'release-captain', baseDefaultRole: 'manager', rules: rules('releases') });
  assert.strictEqual(created.created, true);
  assert.strictEqual(store.hasRole('release-captain'), true);
  assert.deepStrictEqual(store.getRole('release-captain'), {
    id: 'release-captain',
    baseDefaultRole: 'manager',
    rules: rules('releases'),
    capabilities: org.DEFAULT_ROLE_CAPABILITIES.manager,
    functions: null,
    requiresDirectUserAuthorization: false
  });
  assert.ok(store.listRoles().some(role => role.id === 'release-captain'));
  assert.throws(() => { store.defaultDefinitions[0].rules.owns = 'changed'; }, TypeError);
  stateStore.close();
});

check('baseDefaultRole is optional and defaults to null', () => {
  const { stateStore, store } = storeForTest();
  store.createCustomRole({ id: 'standalone', rules: rules('standalone work') });
  assert.strictEqual(store.getRole('standalone').baseDefaultRole, null);
  assert.deepStrictEqual(store.getRole('standalone').capabilities, capabilities({}));
  stateStore.close();
});

check('explicit workflow capabilities are stored and survive a rules edit', () => {
  const { stateStore, store } = storeForTest();
  const explicit = capabilities({ mayClaimWork: true, mayWakeReports: true });
  const created = store.createCustomRole({
    id: 'active-auditor',
    baseDefaultRole: 'observer',
    rules: rules('active audits'),
    capabilities: explicit
  });
  assert.deepStrictEqual(created.definition.capabilities, explicit);
  const edited = store.editRole({
    id: 'active-auditor',
    rules: rules('bounded active audits'),
    expectedRevision: created.revision
  });
  assert.deepStrictEqual(edited.definition.capabilities, explicit);
  stateStore.close();
});

check('edits a custom role with a revision and refuses stale writes', () => {
  const { stateStore, store } = storeForTest();
  const created = store.createCustomRole({ id: 'incident-lead', baseDefaultRole: null, rules: rules('incidents') });
  const edited = store.editRole({ id: 'incident-lead', rules: rules('responses'), expectedRevision: created.revision });
  assert.strictEqual(edited.revision, created.revision + 1);
  assert.deepStrictEqual(store.getRole('incident-lead').rules, rules('responses'));
  assert.throws(() => store.editRole({ id: 'incident-lead', rules: rules('stale'), expectedRevision: created.revision }), error => error.code === 'MEMORY_REVISION_CONFLICT');
  stateStore.close();
});

check('reopened custom roles expose their durable revision for editing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-role-revision-'));
  const file = path.join(directory, 'state.sqlite3');
  let stateStore;
  let reopenedStateStore;
  try {
    stateStore = createStateStore({ file });
    const store = roles.createCustomRoleStore({ stateStore });
    store.createCustomRole({ id: 'durable-edit', baseDefaultRole: 'worker', rules: rules('initial work') });
    stateStore.close();
    stateStore = null;

    reopenedStateStore = createStateStore({ file });
    const reopenedStore = roles.createCustomRoleStore({ stateStore: reopenedStateStore });
    const record = reopenedStore.getRoleRecord('durable-edit');
    assert.strictEqual(record.revision, 1);
    assert.deepStrictEqual(record.definition, reopenedStore.getRole('durable-edit'));
    const edited = reopenedStore.editRole({ id: 'durable-edit', rules: rules('edited work'), expectedRevision: record.revision });
    assert.strictEqual(edited.revision, record.revision + 1);
  } finally {
    if (stateStore) stateStore.close();
    if (reopenedStateStore) reopenedStateStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('an edited default rolls back byte-for-byte to the immutable baseline', () => {
  const { stateStore, store } = storeForTest();
  const baseline = JSON.stringify(roles.DEFAULT_ROLE_DEFINITIONS.find(role => role.id === 'worker'));
  assert.strictEqual(store.getRoleRecord('worker').revision, 0);
  const edited = store.editDefaultRole({ id: 'worker', rules: rules('the temporary override'), expectedRevision: 0 });
  assert.notStrictEqual(JSON.stringify(store.getRole('worker')), baseline);
  store.rollbackDefaultRole({ id: 'worker', expectedRevision: edited.revision });
  assert.strictEqual(JSON.stringify(store.getRole('worker')), baseline);
  stateStore.close();
});

check('reopened default overrides expose their revision for rollback', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-role-default-revision-'));
  const file = path.join(directory, 'state.sqlite3');
  let stateStore;
  let reopenedStateStore;
  try {
    const baseline = JSON.stringify(roles.DEFAULT_ROLE_DEFINITIONS.find(role => role.id === 'worker'));
    stateStore = createStateStore({ file });
    const store = roles.createCustomRoleStore({ stateStore });
    store.editDefaultRole({ id: 'worker', rules: rules('durable temporary override'), expectedRevision: 0 });
    stateStore.close();
    stateStore = null;

    reopenedStateStore = createStateStore({ file });
    const reopenedStore = roles.createCustomRoleStore({ stateStore: reopenedStateStore });
    const record = reopenedStore.getRoleRecord('worker');
    assert.strictEqual(record.revision, 1);
    assert.deepStrictEqual(record.definition, reopenedStore.getRole('worker'));
    reopenedStore.rollbackDefaultRole({ id: 'worker', expectedRevision: record.revision });
    assert.strictEqual(JSON.stringify(reopenedStore.getRole('worker')), baseline);
  } finally {
    if (stateStore) stateStore.close();
    if (reopenedStateStore) reopenedStateStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('custom definitions do not extend the fixed functional role vocabulary', () => {
  const { stateStore, store } = storeForTest();
  const agent = { id: 'custom-worker', displayName: 'Custom worker', role: 'release-captain', provider: 'codex', enabled: true };
  const rejectsCustomFunctionalRole = error => error.code === 'AGENT_ORG_INVALID' && error.details?.field === 'role';
  assert.throws(() => org.normalizeAgent(agent), rejectsCustomFunctionalRole);
  store.createCustomRole({ id: 'release-captain', baseDefaultRole: 'worker', rules: rules('releases') });
  assert.strictEqual(store.hasRole('release-captain'), true);
  assert.throws(() => org.normalizeAgent(agent, { customRoleRegistry: store }), rejectsCustomFunctionalRole);
  stateStore.close();
});

check('role records return null for unknown custom ids', () => {
  const { stateStore, store } = storeForTest();
  assert.strictEqual(store.getRoleRecord('unknown-custom'), null);
  stateStore.close();
});

check('default ids cannot collide with custom role ids', () => {
  const { stateStore, store } = storeForTest();
  assert.throws(() => store.createCustomRole({ id: 'worker', baseDefaultRole: null, rules: rules('collision') }), error => error.code === 'CUSTOM_ROLE_DEFAULT_COLLISION');
  stateStore.close();
});

check('custom role definitions survive closing and reopening the durable state store', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-role-durability-'));
  const file = path.join(directory, 'state.sqlite3');
  let stateStore;
  let reopenedStateStore;
  try {
    stateStore = createStateStore({ file });
    const store = roles.createCustomRoleStore({ stateStore });
    store.createCustomRole({ id: 'durable-role', baseDefaultRole: 'worker', rules: rules('durable work') });
    const expected = JSON.stringify(store.getRole('durable-role'));
    stateStore.close();
    stateStore = null;

    reopenedStateStore = createStateStore({ file });
    const reopenedStore = roles.createCustomRoleStore({ stateStore: reopenedStateStore });
    assert.strictEqual(JSON.stringify(reopenedStore.getRole('durable-role')), expected);
  } finally {
    if (stateStore) stateStore.close();
    if (reopenedStateStore) reopenedStateStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('default definition ids exactly match agent-org defaults', () => {
  assert.deepStrictEqual(roles.DEFAULT_ROLE_DEFINITIONS.map(role => role.id), org.ROLES);
});

console.log(`Custom role store tests passed (${checks} assertions).`);

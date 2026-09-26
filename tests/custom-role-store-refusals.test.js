'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function loadWithInjectedDefaultStore(request, parent, isMain) {
  if (request === './state-store' && parent?.filename.endsWith('/src/lib/custom-role-store.js')) {
    return { createStateStore: () => { throw new Error('These tests must inject their state store.'); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const {
  MAX_CUSTOM_ROLES,
  createCustomRoleStore
} = require('../src/lib/custom-role-store');
Module._load = originalLoad;

const rules = label => ({
  owns: `Owns ${label}.`,
  mustNot: `Must not ${label}.`,
  handoff: `Hands off ${label}.`
});

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

function storedCustom(id) {
  return {
    schemaVersion: 1,
    kind: 'custom',
    definition: { id, baseDefaultRole: null, rules: rules(id) }
  };
}

function fakeStateStore({ getMemory = () => null, searchMemory = () => [] } = {}) {
  const effects = { writes: [], spawns: [] };
  return {
    effects,
    store: {
      getMemory,
      searchMemory,
      setMemory(input) {
        effects.writes.push(input);
        throw new Error('A refusing operation must not write.');
      },
      spawn(input) {
        effects.spawns.push(input);
        throw new Error('A refusing operation must not spawn.');
      }
    }
  };
}

function assertRefusal(action, code, effects) {
  assert.throws(action, error => {
    assert.strictEqual(error.name, 'CustomRoleError');
    assert.strictEqual(error.code, code);
    return true;
  });
  assert.deepStrictEqual(effects.writes, [], `${code} must refuse before writing`);
  assert.deepStrictEqual(effects.spawns, [], `${code} must refuse without spawning`);
}

{
  const existing = storedCustom('duplicate');
  const { store: stateStore, effects } = fakeStateStore({
    getMemory: ({ key }) => key === 'custom:duplicate' ? { value: existing, revision: 7 } : null
  });
  const store = createCustomRoleStore({ stateStore });
  assertRefusal(
    () => store.createCustomRole({ id: 'duplicate', rules: rules('duplicate work') }),
    'CUSTOM_ROLE_COLLISION',
    effects
  );
  assert.deepStrictEqual(store.getRole('duplicate'), {
    ...existing.definition,
    functions: null,
    requiresDirectUserAuthorization: false,
    capabilities: {
      orgRoot: false,
      singleSeat: false,
      mayClaimWork: false,
      mayWakeReports: false,
      requiresMutationContext: false,
      mayUseMissionBridge: false,
      mayReportMissionBridge: false,
      mayMutateMissionBridge: false
    }
  }, 'the existing role must remain readable and is migrated fail-closed after refusal');
}

{
  const malformed = { schemaVersion: 1, kind: 'custom' };
  const { store: stateStore, effects } = fakeStateStore({
    getMemory: () => ({ value: malformed, revision: 1 })
  });
  const store = createCustomRoleStore({ stateStore });
  assertRefusal(() => store.getRole('broken'), 'CUSTOM_ROLE_CORRUPT', effects);
}

{
  const entries = Array.from({ length: MAX_CUSTOM_ROLES }, (_, index) => {
    const id = `role-${index}`;
    return { key: `custom:${id}`, value: storedCustom(id), revision: 1 };
  });
  const { store: stateStore, effects } = fakeStateStore({ searchMemory: () => entries });
  const store = createCustomRoleStore({ stateStore });
  assertRefusal(
    () => store.createCustomRole({ id: 'one-too-many', rules: rules('overflow work') }),
    'CUSTOM_ROLE_LIMIT_REACHED',
    effects
  );
  assert.strictEqual(store.listRoles().filter(role => role.id.startsWith('role-')).length, MAX_CUSTOM_ROLES,
    'the refusal must leave all existing custom roles intact');
}

{
  const { store: stateStore, effects } = fakeStateStore();
  const store = createCustomRoleStore({ stateStore });
  assertRefusal(
    () => store.editRole({ id: 'missing', rules: rules('missing work'), expectedRevision: 1 }),
    'CUSTOM_ROLE_NOT_FOUND',
    effects
  );
  assert.strictEqual(store.getRole('missing'), null, 'a refused edit must not create the missing role');
}

{
  const { store: stateStore, effects } = fakeStateStore();
  const store = createCustomRoleStore({ stateStore });
  assertRefusal(
    () => store.createCustomRole({
      id: 'partial-capabilities',
      rules: rules('partial capabilities'),
      capabilities: { mayClaimWork: true }
    }),
    'CUSTOM_ROLE_INVALID',
    effects
  );
}

for (const malformedCapabilities of [null, { mayClaimWork: true }]) {
  const existing = storedCustom('immutable-role');
  existing.definition.capabilities = capabilities({ mayClaimWork: true });
  const { store: stateStore, effects } = fakeStateStore({
    getMemory: ({ key }) => key === 'custom:immutable-role' ? { value: existing, revision: 4 } : null
  });
  const store = createCustomRoleStore({ stateStore });
  assertRefusal(
    () => store.editRole({
      id: 'immutable-role',
      rules: rules('malformed edit'),
      expectedRevision: 4,
      capabilities: malformedCapabilities
    }),
    'CUSTOM_ROLE_INVALID',
    effects
  );
}

{
  const existing = storedCustom('immutable-root');
  existing.definition.capabilities = capabilities({ orgRoot: true, singleSeat: true, mayClaimWork: true });
  const { store: stateStore, effects } = fakeStateStore({
    getMemory: ({ key }) => key === 'custom:immutable-root' ? { value: existing, revision: 2 } : null
  });
  const store = createCustomRoleStore({ stateStore });
  assertRefusal(
    () => store.editRole({
      id: 'immutable-root',
      rules: rules('structural edit'),
      expectedRevision: 2,
      capabilities: capabilities({ mayClaimWork: true })
    }),
    'CUSTOM_ROLE_STRUCTURE_READ_ONLY',
    effects
  );
  assert.deepStrictEqual(store.getRole('immutable-root').capabilities,
    capabilities({ orgRoot: true, singleSeat: true, mayClaimWork: true }),
    'the structural refusal leaves the stored definition unchanged');
}

{
  const existing = {
    schemaVersion: 1,
    kind: 'default',
    definition: {
      id: 'controller',
      baseDefaultRole: null,
      rules: rules('controller'),
      capabilities: capabilities({ orgRoot: true, singleSeat: true, mayClaimWork: true, mayWakeReports: true })
    }
  };
  const { store: stateStore, effects } = fakeStateStore({
    getMemory: ({ key }) => key === 'default:controller' ? { value: existing, revision: 5 } : null
  });
  const store = createCustomRoleStore({ stateStore });
  assertRefusal(
    () => store.editDefaultRole({
      id: 'controller',
      rules: rules('demoted controller'),
      expectedRevision: 5,
      capabilities: capabilities({ mayClaimWork: true, mayWakeReports: true })
    }),
    'CUSTOM_ROLE_STRUCTURE_READ_ONLY',
    effects
  );
}

console.log('Custom role refusal tests passed (9 driven refusal paths).');

/* Mutation check (2026-08-27):
 * Changed editRole's baseDefaultRole from existing.definition.baseDefaultRole to null.
 * The one-line module mutation landed: yes.
 * The file went red: could not measure; Node 20 lacks the required node:sqlite module.
 * The runner exited 1 during module loading, before this test's assertions ran.
 */
'use strict';

const assert = require('node:assert/strict');

const { createStateStore } = require('../src/lib/state-store');
const {
  CustomRoleError,
  DEFAULT_ROLE_DEFINITIONS,
  MAX_CUSTOM_ROLES,
  createCustomRoleStore
} = require('../src/lib/custom-role-store');

const rules = subject => ({
  owns: `Owns ${subject}.`,
  mustNot: `Must not abandon ${subject}.`,
  handoff: `Hands off ${subject} with context.`
});

const stateStore = createStateStore({ file: ':memory:' });

try {
  const store = createCustomRoleStore({ stateStore });
  const baselineIds = DEFAULT_ROLE_DEFINITIONS.map(role => role.id);

  assert.equal(store.listRoles().length, baselineIds.length);
  assert.deepEqual(store.listRoles().map(role => role.id), baselineIds);
  assert.equal(store.hasRole('release-captain'), false);

  const created = store.createCustomRole({
    id: 'release-captain',
    baseDefaultRole: 'manager',
    rules: rules('release readiness')
  });
  assert.equal(created.created, true);
  assert.equal(created.revision, 1);
  assert.deepEqual(store.getRole('release-captain'), created.definition);

  const edited = store.editRole({
    id: 'release-captain',
    expectedRevision: created.revision,
    rules: rules('production releases')
  });
  assert.equal(edited.revision, 2);
  assert.equal(edited.definition.baseDefaultRole, 'manager',
    'editing rules must preserve the custom role\'s default-role inheritance');
  assert.deepEqual(store.getRoleRecord('release-captain'), {
    definition: edited.definition,
    revision: edited.revision
  });

  assert.throws(
    () => store.createCustomRole({ id: 'worker', rules: rules('collision') }),
    error => error instanceof CustomRoleError && error.code === 'CUSTOM_ROLE_DEFAULT_COLLISION'
  );
  assert.throws(
    () => store.createCustomRole({ id: 'bad role', rules: rules('invalid ids') }),
    error => error instanceof CustomRoleError && error.code === 'CUSTOM_ROLE_INVALID'
  );
  assert.equal(MAX_CUSTOM_ROLES, 10);

  const longContext = 'Start here:\n\n' + 'Current task context. '.repeat(250) + 'Return evidence.';
  const withContext = store.editRole({ id: 'release-captain', expectedRevision: 2,
    rules: { ...rules('context delivery'), owns: longContext } });
  assert.equal(store.getRole('release-captain').rules.owns, longContext,
    'long, multiline assignment context must survive the real role store');
  assert.throws(() => store.editRole({ id: 'release-captain', expectedRevision: withContext.revision,
    rules: { ...rules('oversize'), owns: 'x'.repeat(6001) } }), { code: 'CUSTOM_ROLE_INVALID' });
  assert.equal(store.getRole('release-captain').rules.owns, longContext, 'a refused edit must preserve the previous context');

  console.log('custom-role-store behaviour passed: defaults, create/read, edit inheritance, records, and validation');
} finally {
  stateStore.close();
}

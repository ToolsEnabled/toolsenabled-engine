'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCustomRoleStore, MAX_RULE_TEXT } = require('../src/lib/custom-role-store');
const { createDurableMemoryFile } = require('../src/lib/durable-memory-file');
const { storedRoleDefinition } = require('../src/lib/agent-roles');
const empty = { owns: '', mustNot: '', handoff: '' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-role-directions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'custom-roles.json');
  return () => createCustomRoleStore({ stateStore: createDurableMemoryFile({ file }) });
}
test('empty custom directions survive create, edit, fresh store reads and onboarding projection without changing policy', t => {
  const open = fixture(t);
  const created = open().createCustomRole({ id: 'empty-helper', baseDefaultRole: null, rules: empty,
    functions: ['app.context'], requiresDirectUserAuthorization: true });
  assert.equal(created.revision, 1);
  let saved = open().getRoleRecord('empty-helper');
  assert.deepEqual(saved, { definition: created.definition, revision: 1 });
  assert.deepEqual(saved.definition.rules, empty);
  const projected = storedRoleDefinition(saved.definition);
  assert.ok(projected);
  assert.deepEqual(Object.fromEntries(Object.keys(empty).map(key => [key, projected[key]])), empty);
  assert.deepEqual(projected.rules, [], 'a base-less role must not inherit invented operating instructions');
  assert.deepEqual(projected.capabilities, created.definition.capabilities);
  open().editRole({ id: 'empty-helper', expectedRevision: 1, rules: { ...empty, owns: 'One requested responsibility.' } });
  open().editRole({ id: 'empty-helper', expectedRevision: 2, rules: empty });
  saved = open().getRoleRecord('empty-helper');
  assert.equal(saved.revision, 3);
  assert.deepEqual(saved.definition, created.definition, 'clearing text cannot change the identity, base, capabilities, function subset or direct-user policy');
  const worker = open().getRoleRecord('worker');
  open().editDefaultRole({ id: 'worker', expectedRevision: worker.revision, rules: empty });
  const editedWorker = open().getRoleRecord('worker').definition;
  assert.deepEqual(editedWorker, { ...worker.definition, rules: empty });
  assert.deepEqual(storedRoleDefinition(editedWorker).capabilities, worker.definition.capabilities);
});
test('empty is a valid string, not permission to omit fields or accept malformed text and policy', t => {
  const open = fixture(t);
  for (const value of [undefined, null, false, 0, [], {}, ' ', '\u0000', 'x'.repeat(MAX_RULE_TEXT + 1)]) {
    for (const field of Object.keys(empty)) {
      assert.throws(() => open().createCustomRole({ id: 'invalid-helper', rules: { ...empty, [field]: value } }), { code: 'CUSTOM_ROLE_INVALID' });
    }
  }
  for (const change of [{ id: 'owner' }, { capabilities: { orgRoot: false } }, { requiresDirectUserAuthorization: 'true' }, { functions: ['app.*'] }]) {
    assert.throws(() => open().createCustomRole({ id: 'invalid-helper', rules: empty, ...change }));
  }
  assert.equal(open().hasRole('invalid-helper'), false);
});

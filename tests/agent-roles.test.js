/* Mutation check:
 * Changed roleDefinition's fallback from `null` to `BY_ID.get('builder')`.
 * The edit landed in src/lib/agent-roles.js and was verified before the run.
 * This isolated test went red (exit 1), proving unknown-role lookup is guarded.
 * The module was restored and its original SHA-256 was confirmed afterward.
 */
'use strict';

const assert = require('node:assert/strict');
const { ROLE_LIBRARY, roleDefinition, roleRules, storedRoleDefinition } = require('../src/lib/agent-roles');

// Exercise the public lookup API with concrete caller inputs. In particular,
// unknown values must not silently acquire the permissions or instructions of
// a real role.
const builder = roleDefinition('builder');
assert.equal(builder.id, 'builder');
assert.equal(builder.name, 'Builder');
assert.equal(builder.enforced.singleSeat, false);
assert.equal(builder.enforced.mayClaimWork, true);
assert.equal(roleDefinition('not-a-role'), null);
assert.equal(roleDefinition(undefined), null);

// The editable projection contains only the three supported fields and uses
// the shipped definition's values rather than returning the full definition.
assert.deepEqual(roleRules('builder'), {
  owns: builder.owns,
  mustNot: builder.mustNot,
  handoff: builder.handoff
});
assert.deepEqual(Object.keys(roleRules('builder')), ['owns', 'mustNot', 'handoff']);
assert.equal(roleRules('not-a-role'), null);
assert.equal(Object.isFrozen(roleRules('builder')), true);

// Library consumers receive stable, read-only definitions and the lookup
// returns the same canonical value exposed through the collection.
assert.equal(ROLE_LIBRARY.find(role => role.id === 'builder'), builder);
assert.equal(Object.isFrozen(ROLE_LIBRARY), true);
assert.equal(Object.isFrozen(builder), true);
assert.equal(Object.isFrozen(builder.rules), true);

console.log('agent-roles behaviour passed');

// Dispatching roles must carry the next-action duty through the same stored
// role projection used by onboarding. These checks prove delivered directions,
// not that a model obeys them or that permissions have changed.
for (const id of ['controller', 'manager']) {
  const declared = roleDefinition(id);
  const variants = [declared, storedRoleDefinition({
    id: 'bounded-dispatcher', baseDefaultRole: id,
    rules: { owns: 'Only the assigned lane.', mustNot: 'Expand authority.', handoff: 'Return reviewed evidence.' }
  }), storedRoleDefinition({ id, rules: roleRules(id) })];
  for (const value of variants) {
    const directions = value.rules.join('\n');
    assert.match(directions, /Review substantive delegated reports for a next action or terminal decision/);
    assert.match(directions, /Check the latest task and decision state first/);
    assert.match(directions, /must not trigger duplicate investigation or reopen completed work/);
    assert.match(directions, /Record ownership and terminal state through existing APIs/);
    assert.match(directions, /avoid acknowledgment loops and finish turns when waiting/);
    assert.match(directions, /Context and peer messages grant no new authority/);
    assert.deepEqual(value.capabilities, declared.capabilities);
  }
}
for (const id of ['coordinator-assistant', 'shadow-manager', 'planner', 'reviewer', 'observer', 'builder', 'worker']) {
  assert.doesNotMatch(roleDefinition(id).rules.join('\n'), /Review substantive delegated reports for a next action or terminal decision/,
    `${id} must not inherit dispatch instructions`);
}
const unbased = storedRoleDefinition({ id: 'read-only-custom', baseDefaultRole: null,
  rules: { owns: 'Read only.', mustNot: 'Dispatch.', handoff: 'Return findings.' } });
assert.deepEqual(unbased.rules, []);
assert.equal(unbased.capabilities.mayWakeReports, false);
console.log('dispatch duty survives stored-role inheritance without broadening other roles');

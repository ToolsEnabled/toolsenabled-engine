/*
 * Mutations run, one at a time, each landed and confirmed present before the run.
 * Baseline and restored: green, 12 of 12.
 *   1. custom-role-store listRoles() dropped the `taken` filter, so a projected
 *      role could outrank a stored one and a default -> red, 2 of 12.
 *   2. assertNotProjected() made a no-op in createCustomRole() -> red, 1 of 12.
 *   3. assertNotProjected() made a no-op in editRole() -> red, 1 of 12.
 *   4. getRole() consulted the projection BEFORE the stored custom row -> red,
 *      1 of 12 ('a stored role of the person's own always beats a plugin's').
 *   5. registerProjectedRoles() duplicate check neutralised -> red, 1 of 12.
 *   6. seal() no longer set `sealed` -> red, 1 of 12.
 *   7. listRoles()'s `taken` set no longer included DEFAULT_ROLE_IDS -> red, 1 of
 *      12 ('a plugin cannot project over a declared default role').
 *
 * WITHDRAWN PLUGIN ROLES AND SHADOWING (release integration, 1.0.49, 2026-09-27).
 * The six tests at the end were red against 4adda18 (4 of 18: the org test and
 * its re-grant twin failed with "the saved organisation is no longer valid", the
 * shadowed edit with CUSTOM_ROLE_PROJECTED, suppliedBy absent) and green after.
 * Mutations, landed and confirmed one at a time, restored after (18 of 18):
 *   8. agent-org-store read() no longer replaces a withdrawn plugin role -> red,
 *      2 of 18 (the org test and the re-grant test).
 *   9. write() records no plugin roles -> red, 2 of 18 (same two).
 *   10. a recorded role that is known again is replaced anyway -> red, 2 of 18.
 *   11. any unknown role replaced, recorded or not -> red, 1 of 18 ('a role of the
 *       person's own that disappears is still reported as damage'). It SURVIVED
 *       while that test held no plugin role; the test now holds both.
 *   12. editRole() refuses every projected id again -> red, 1 of 18.
 *   13. suppliedBy() ignores a stored role of the same id -> red, 1 of 18.
 *   Dropping the early `!recorded.size` return is an equivalent mutant (the
 *   per-seat check makes the same decision) and survives, as it should.
 *
 * ONE DESIGN ERROR THIS SUITE FOUND, before any mutation: the projection sealed on
 * first READ, copying tool-pack-registry's rule into a place it does not fit.
 * createCustomRole() calls listRoles() to count, so a person saving a role of
 * their own locked plugin activation out entirely. Sealing is now an explicit act
 * by plugin-activation.js after it registers, and 'reading the vocabulary does not
 * seal it' is the test that keeps it that way.
 */
'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const projection = require('../src/lib/plugin-role-projection');
const { CustomRoleStore } = require('../src/lib/custom-role-store');

afterEach(() => projection.resetForTests());

/* The three memory methods custom-role-store uses, with the same contract. */
function fakeStore() {
  const rows = new Map();
  return {
    rows,
    getMemory({ namespace, key }) {
      const row = rows.get(`${namespace}\u0000${key}`);
      return row ? { value: JSON.parse(JSON.stringify(row.value)), revision: row.revision } : null;
    },
    setMemory({ namespace, key, value, note, tags, expectedRevision }) {
      const id = `${namespace}\u0000${key}`;
      const prior = rows.get(id);
      if (expectedRevision !== undefined && (prior ? prior.revision : 0) !== expectedRevision) {
        const error = new Error('conflict'); error.code = 'MEMORY_REVISION_CONFLICT'; throw error;
      }
      const revision = (prior ? prior.revision : 0) + 1;
      rows.set(id, { value: JSON.parse(JSON.stringify(value)), revision, note, tags, key });
      return { entry: { revision }, created: !prior, replayed: false };
    },
    searchMemory({ namespace, query, limit }) {
      const out = [];
      for (const [id, row] of rows) {
        if (!id.startsWith(`${namespace}\u0000`) || !String(row.note).includes(query)) continue;
        out.push({ key: row.key, value: JSON.parse(JSON.stringify(row.value)), revision: row.revision })
        if (out.length >= limit) break;
      }
      return out;
    }
  };
}

const RULES = Object.freeze({
  owns: 'The index: what is in it, and where each note came from.',
  mustNot: 'Never delete a note it did not create.',
  handoff: 'Hands a finished index to the curator with the folder it was built from.'
});

function role(id, plugin = 'notes') {
  return { id, plugin, pluginId: 'plugin-abc', rules: { ...RULES } };
}

function store() {
  return new CustomRoleStore({ stateStore: fakeStore() });
}

test('with nothing projected, the role vocabulary is exactly what it always was', () => {
  // THE SHIPPED CASE. This is the assertion that makes the whole projection safe
  // to add to an authority path: with no plugin activated, nothing changes.
  const roles = store();
  const listed = roles.listRoles();
  assert.equal(listed.length, 9, 'the nine declared defaults and nothing else');
  assert.equal(roles.getRole('notes-archivist'), null);
  assert.equal(roles.hasRole('notes-archivist'), false);
  assert.deepEqual(projection.projectedRoles(), []);
});

test('a projected role is visible, usable and shaped like a stored one', () => {
  projection.registerProjectedRoles([role('notes-archivist')]);
  const roles = store();
  assert.equal(roles.hasRole('notes-archivist'), true);
  const definition = roles.getRole('notes-archivist');
  assert.equal(definition.rules.owns, RULES.owns);
  // Nothing downstream can tell it from a stored role by its shape: it carries the
  // same fields, including the capabilities and function policy the PRODUCT
  // chooses -- which is also why a plugin's role file may not name them.
  assert.ok(Object.hasOwn(definition, 'capabilities'))
  assert.ok(Object.hasOwn(definition, 'functions'))
  assert.equal(definition.baseDefaultRole, null)
  assert.equal(roles.listRoles().length, 10)
  assert.equal(roles.listRoles().at(-1).id, 'notes-archivist')
});

test('nothing was written: the projection leaves the durable store empty', () => {
  const backing = fakeStore();
  const roles = new CustomRoleStore({ stateStore: backing });
  projection.registerProjectedRoles([role('notes-archivist'), role('notes-indexer')]);
  assert.equal(roles.listRoles().length, 11);
  // The whole argument for projecting rather than installing: the person's
  // authority document is untouched, so a revoked grant has nothing to clean up.
  assert.equal(backing.rows.size, 0, 'a projected role must never reach the durable file');
});

test('a withdrawn grant takes its roles with it, with no reconciliation', () => {
  projection.registerProjectedRoles([role('notes-archivist')]);
  const roles = store();
  assert.equal(roles.hasRole('notes-archivist'), true);
  // What a revoke amounts to on the next start: the plugin is not activated, so
  // nothing projects it.
  projection.resetForTests();
  projection.registerProjectedRoles([]);
  assert.equal(roles.hasRole('notes-archivist'), false);
  assert.equal(roles.listRoles().length, 9);
});

test('a stored role of the person\'s own always beats a plugin\'s', () => {
  const roles = store();
  roles.createCustomRole({ id: 'notes-archivist', rules: { owns: 'MINE', mustNot: 'mine', handoff: 'mine' } });
  projection.registerProjectedRoles([role('notes-archivist')]);
  assert.equal(roles.getRole('notes-archivist').rules.owns, 'MINE',
    'a plugin cannot take over an id somebody is already using');
  // And it appears exactly once, not twice.
  const matching = roles.listRoles().filter(entry => entry.id === 'notes-archivist');
  assert.equal(matching.length, 1);
  assert.deepEqual(projection.shadowedBy(roles.listRoles().map(entry => entry.id)), ['notes-archivist'],
    'the shadowing is reported, not silently resolved');
});

test('a projected id cannot be written over, and the refusal says what to do', () => {
  projection.registerProjectedRoles([role('notes-archivist')]);
  const roles = store();
  for (const attempt of [
    () => roles.createCustomRole({ id: 'notes-archivist', rules: { owns: 'x', mustNot: 'y', handoff: 'z' } }),
    () => roles.editRole({ id: 'notes-archivist', expectedRevision: 1, rules: { owns: 'x', mustNot: 'y', handoff: 'z' } }),
  ]) {
    assert.throws(attempt, (error) => {
      assert.equal(error.code, 'CUSTOM_ROLE_PROJECTED');
      assert.match(error.message, /supplied by the plugin "notes"/);
      // Both ways out, named.
      assert.match(error.message, /give it a different name/);
      assert.match(error.message, /withdraw that plugin's permission to add roles/);
      return true;
    });
  }
});

test('a plugin cannot project over a declared default role', () => {
  // rolesFor() namespaces a plugin's role ids so this should be unreachable, but a
  // second fence costs one line and the first one lives in another module.
  projection.registerProjectedRoles([role('manager')]);
  const roles = store();
  assert.notEqual(roles.getRole('manager'), null);
  assert.notEqual(roles.getRole('manager').rules.owns, RULES.owns, 'the default wording is what is in force');
  assert.equal(roles.listRoles().length, 9, 'and the projection adds no row');
});

test('two plugins claiming one role id is refused outright', () => {
  assert.throws(
    () => projection.registerProjectedRoles([role('notes-archivist', 'notes'), role('notes-archivist', 'other')]),
    (error) => {
      assert.equal(error.code, 'PLUGIN_ROLE_PROJECTION_COLLISION');
      assert.match(error.message, /a role nobody can say the wording of/);
      return true;
    }
  );
  assert.deepEqual(projection.projectedRoles(), [], 'a refused registration projects nothing');
});

test('reading the vocabulary does not seal it', () => {
  // THE BUG THIS TEST FOUND. Sealing on first read copied tool-pack-registry's
  // rule into a place it does not fit: createCustomRole() calls listRoles() to
  // count, so a person saving a role of their own locked plugin activation out
  // entirely. A read must seal nothing.
  const roles = store();
  roles.createCustomRole({ id: 'mine', rules: { owns: 'x', mustNot: 'y', handoff: 'z' } });
  projection.projectedRoles();
  roles.listRoles();
  projection.registerProjectedRoles([role('notes-archivist')]);
  assert.equal(roles.hasRole('notes-archivist'), true);
});

test('a projection registered after activation sealed it is refused', () => {
  // The rule is kept; only the trigger moved. Nothing legitimate registers after
  // activation has, and an attempt to replace the vocabulary mid-run says so.
  projection.registerProjectedRoles([role('notes-indexer')]);
  projection.seal();
  assert.throws(() => projection.registerProjectedRoles([role('notes-archivist')]), (error) => {
    assert.equal(error.code, 'PLUGIN_ROLE_PROJECTION_SEALED');
    assert.match(error.message, /Register them during startup/);
    return true;
  });
});

test('a malformed projected role is refused, not partially accepted', () => {
  for (const bad of [
    { id: 'Notes-Archivist', rules: RULES },
    { id: 'notes_archivist', rules: RULES },
    { id: 'notes-archivist' },
    { id: 'notes-archivist', rules: { owns: '', mustNot: 'y', handoff: 'z' } },
    { id: 'notes-archivist', rules: { owns: ' padded ', mustNot: 'y', handoff: 'z' } },
  ]) {
    assert.throws(() => projection.registerProjectedRoles([bad]),
      (error) => (assert.match(error.code, /^PLUGIN_ROLE_PROJECTION_/), true),
      `${JSON.stringify(bad)} was accepted`);
    projection.resetForTests();
  }
});

test('the projection is bounded', () => {
  const many = Array.from({ length: projection.MAX_PROJECTED_ROLES + 1 },
    (_, index) => role(`notes-r${index}`));
  assert.throws(() => projection.registerProjectedRoles(many), (error) => {
    assert.equal(error.code, 'PLUGIN_ROLE_PROJECTION_LIMIT');
    return true;
  });
});

/* 1.0.50 RELEASE REVIEW F3. The plugin host requires a role's own id to be
   "lowercase words joined by underscores" and names it `<plugin>-<role>`; this
   module accepted no underscore at all. So the documented two-word form was
   refused here, and -- registered in one call for every plugin -- it took every
   plugin's roles with it. Red before the fix (PLUGIN_ROLE_PROJECTION_INVALID on
   the first register), green after. */
test('a two-word plugin role id, the documented form, is projected and served by the role store', () => {
  projection.registerProjectedRoles([role('notes-code_reviewer'), role('notes-archivist'), role('my-notes-index_keeper_two')]);
  const roles = store();
  assert.equal(roles.hasRole('notes-code_reviewer'), true);
  assert.equal(roles.getRole('notes-code_reviewer').rules.owns, RULES.owns);
  assert.deepEqual(roles.listRoles().slice(9).map(entry => entry.id),
    ['my-notes-index_keeper_two', 'notes-archivist', 'notes-code_reviewer']);
  assert.deepEqual(roles.suppliedBy('notes-code_reviewer'), { plugin: 'notes', pluginId: 'plugin-abc' });
});

test('every projected id fits the role store\'s own id rule, including its 64-character cap', () => {
  // The store serves a projected role by id, so an id it cannot look up would be
  // projected and then unreachable. agent-org's ROLE_ID is the store's shape (the
  // store's own suite asserts the two agree).
  const { ROLE_ID } = require('../src/lib/agent-org');
  const longest = `notes-${'a'.repeat(projection.MAX_PROJECTED_ROLE_ID - 'notes-'.length)}`;
  assert.equal(longest.length, 64);
  for (const id of ['notes-archivist', 'notes-code_reviewer', 'a-b-c_d_e', longest]) {
    projection.resetForTests();
    assert.doesNotThrow(() => projection.registerProjectedRoles([role(id)]), `${id} was refused`);
    assert.match(id, ROLE_ID, `${id} is projected but the role store could not serve it`);
  }
  for (const bad of [`${longest}b`, 'notes-code_', 'notes-_reviewer', 'notes_code-reviewer', 'notes-code__reviewer']) {
    projection.resetForTests();
    assert.throws(() => projection.registerProjectedRoles([role(bad)]),
      (error) => (assert.equal(error.code, 'PLUGIN_ROLE_PROJECTION_INVALID'), true), `${bad} was accepted`);
  }
});

test('a plugin\'s roles use none of the person\'s own allowance of custom roles', () => {
  // 1.0.50 release review F4: the allowance counted listRoles(), projected roles
  // included, so with ten plugin roles projected a person could not create a role
  // of their own, and the refusal blamed roles they never stored. Red before (the
  // first create was refused), green after.
  const { MAX_CUSTOM_ROLES } = require('../src/lib/custom-role-store');
  projection.registerProjectedRoles(Array.from({ length: MAX_CUSTOM_ROLES }, (_, index) => role(`notes-r${index}`)));
  const backing = fakeStore();
  const roles = new CustomRoleStore({ stateStore: backing });
  for (let index = 0; index < MAX_CUSTOM_ROLES; index += 1) {
    roles.createCustomRole({ id: `mine-${index}`, rules: { owns: 'x', mustNot: 'y', handoff: 'z' } });
  }
  assert.equal(backing.rows.size, MAX_CUSTOM_ROLES, 'every one of the person\'s own roles was stored');
  assert.equal(roles.listRoles().length, 9 + MAX_CUSTOM_ROLES + MAX_CUSTOM_ROLES, 'and the plugin\'s are still listed beside them');
  // The allowance itself still holds, counted over what the person stored.
  assert.throws(() => roles.createCustomRole({ id: 'one-too-many', rules: { owns: 'x', mustNot: 'y', handoff: 'z' } }),
    (error) => (assert.equal(error.code, 'CUSTOM_ROLE_LIMIT_REACHED'), true));
});

test('checkProjectedRoles applies registration\'s rules to one plugin\'s roles and registers nothing', () => {
  const checked = projection.checkProjectedRoles([role('notes-code_reviewer')]);
  assert.deepEqual(checked.map(entry => entry.id), ['notes-code_reviewer']);
  assert.deepEqual(projection.projectedRoles(), [], 'a check is not a registration');
  assert.throws(() => projection.checkProjectedRoles([role('Notes-x')]),
    (error) => (assert.equal(error.code, 'PLUGIN_ROLE_PROJECTION_INVALID'), true));
  assert.throws(() => projection.checkProjectedRoles([role('notes-x'), role('notes-x', 'other')]),
    (error) => (assert.equal(error.code, 'PLUGIN_ROLE_PROJECTION_COLLISION'), true));
  // A check after the seal is still only a check.
  projection.seal();
  assert.doesNotThrow(() => projection.checkProjectedRoles([role('notes-x')]));
});

// --- WHEN A ROLE AN AGENT HOLDS GOES AWAY WITH ITS PLUGIN -------------------
//
// Found in the real app (1.0.49 plugins walk, HP-36/HP-37): an agent given a
// plugin's role, then the plugin withdrawn or edited by one byte. The saved
// organisation stopped validating, the app showed the shipped default, the work
// service would not start (BRIDGE_ACTOR_AUTHORITY_UNAVAILABLE) and every
// organisation edit was refused as AGENT_ORG_STORE_DAMAGED, across restarts. A
// withdrawn grant has to take its roles with it without taking the person's
// organisation too.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentOrg = require('../src/lib/agent-org');
const { createAgentOrgStore } = require('../src/lib/agent-org-store');

const ORG = Object.freeze({
  schemaVersion: 1,
  revision: 1,
  agents: [
    { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] },
    { id: 'astra', displayName: 'Astra', role: 'builder', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] },
    { id: 'beta', displayName: 'Beta', role: 'worker', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] }
  ],
  relationships: [
    { from: 'controller', to: 'astra', type: 'manages' },
    { from: 'controller', to: 'beta', type: 'manages' }
  ]
});

function orgFiles() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-role-org-'));
  const baselineFile = path.join(directory, 'baseline.json');
  fs.writeFileSync(baselineFile, JSON.stringify(ORG, null, 2));
  return { directory, baselineFile, overlayFile: path.join(directory, 'agent-org.json') };
}

/* A fresh org store over the same files and the same role backing, the way the
   next launch builds one. */
function orgStore(files, roles) {
  return createAgentOrgStore({ baselineFile: files.baselineFile, overlayFile: files.overlayFile, customRoles: roles });
}

/* What a restart after a withdrawal (or a one-byte edit) amounts to: activation
   runs again and nothing projects the role. */
function restartWithout() {
  projection.resetForTests();
  projection.registerProjectedRoles([]);
}

test('an agent holding a plugin\'s role keeps working as a Worker when the role goes away, and the saved organisation still loads', () => {
  const files = orgFiles();
  try {
    const backing = fakeStore();
    projection.registerProjectedRoles([role('notes-curator')]);
    orgStore(files, new CustomRoleStore({ stateStore: backing })).assignRole({ agentId: 'astra', role: 'notes-curator' });
    // Reparent Beta under Astra as well: an edit the person made that must survive.
    orgStore(files, new CustomRoleStore({ stateStore: backing })).reparent({ agentId: 'beta', parentId: 'astra' });

    restartWithout();
    const view = orgStore(files, new CustomRoleStore({ stateStore: backing })).read();
    assert.equal(view.damaged, null, 'the saved organisation is not reported as damaged');
    assert.equal(view.source, 'overlay', 'it is the person\'s organisation, not the shipped default');
    const astra = view.org.agents.find(agent => agent.id === 'astra');
    assert.equal(astra.role, 'worker', 'the seat works as a Worker, the base every plugin role is given');
    assert.equal(agentOrg.managerOf(view.org, 'beta'), 'astra', 'the person\'s other edits are all still there');
    assert.deepEqual(view.withdrawnPluginRoles, [{ agentId: 'astra', displayName: 'Astra', role: 'notes-curator' }],
      'and the read says which seat lost which role, so a screen can tell the person');
    assert.deepEqual(view.org.roleCapabilitiesByRole.worker, agentOrg.DEFAULT_ROLE_CAPABILITIES.worker,
      'with exactly the abilities the plugin\'s role carried: nothing is gained by the role going away');

    // An edit is not refused as a damaged organisation, and it keeps the substitution.
    const edited = orgStore(files, new CustomRoleStore({ stateStore: backing })).reparent({ agentId: 'beta', parentId: 'controller' });
    assert.equal(edited.org.agents.find(agent => agent.id === 'astra').role, 'worker');
    const after = orgStore(files, new CustomRoleStore({ stateStore: backing })).read();
    assert.equal(after.damaged, null);
    assert.equal(after.withdrawnPluginRoles, undefined, 'once written, the seat simply holds Worker');
    assert.equal(backing.rows.size, 0, 'and nothing reached the person\'s role file at any point');
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('a plugin role that comes back before any edit is the one the seat holds again', () => {
  const files = orgFiles();
  try {
    const backing = fakeStore();
    projection.registerProjectedRoles([role('notes-curator')]);
    orgStore(files, new CustomRoleStore({ stateStore: backing })).assignRole({ agentId: 'astra', role: 'notes-curator' });
    restartWithout();
    assert.equal(orgStore(files, new CustomRoleStore({ stateStore: backing })).read().org.agents
      .find(agent => agent.id === 'astra').role, 'worker');
    // Re-granted: reading wrote nothing, so the saved choice is still there.
    projection.resetForTests();
    projection.registerProjectedRoles([role('notes-curator')]);
    const view = orgStore(files, new CustomRoleStore({ stateStore: backing })).read();
    assert.equal(view.org.agents.find(agent => agent.id === 'astra').role, 'notes-curator');
    assert.equal(view.withdrawnPluginRoles, undefined);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('with no plugin role held, the saved organisation is written exactly as before', () => {
  const files = orgFiles();
  try {
    projection.registerProjectedRoles([role('notes-curator')]);
    orgStore(files, store()).reparent({ agentId: 'beta', parentId: 'astra' });
    const saved = JSON.parse(fs.readFileSync(files.overlayFile, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['baselineContentHash', 'org', 'savedAt', 'schemaVersion'],
      'a plugin that is only installed changes nothing in the organisation file');
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('a role of the person\'s own that disappears is still reported as damage, never quietly replaced', () => {
  // The substitution is for a role a plugin supplied and nothing else. A stored
  // custom role that vanished is the case agent-org-store.js reports as damage,
  // and it stays that way.
  // One organisation holding both: a plugin's role (recorded) on Astra and the
  // person's own role on Beta. Both go away; only the plugin's may be replaced.
  const files = orgFiles();
  try {
    const backing = fakeStore();
    new CustomRoleStore({ stateStore: backing })
      .createCustomRole({ id: 'night-shift', baseDefaultRole: 'builder', rules: { owns: 'x', mustNot: 'y', handoff: 'z' } });
    projection.registerProjectedRoles([role('notes-curator')]);
    orgStore(files, new CustomRoleStore({ stateStore: backing })).assignRole({ agentId: 'astra', role: 'notes-curator' });
    orgStore(files, new CustomRoleStore({ stateStore: backing })).assignRole({ agentId: 'beta', role: 'night-shift' });
    assert.deepEqual(JSON.parse(fs.readFileSync(files.overlayFile, 'utf8')).pluginRoles, ['notes-curator'],
      'only the plugin\'s role is recorded as one');
    restartWithout();
    const orphaned = orgStore(files, store()).read();
    assert.equal(orphaned.source, 'baseline');
    assert.match(String(orphaned.damaged), /no longer valid/);
    assert.equal(orphaned.withdrawnPluginRoles, undefined);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('a role of the person\'s own that hides a plugin\'s is theirs to edit', () => {
  // Found in the real app: while a plugin projected an id, editing the person's
  // OWN role of that id was refused with a sentence saying the role came from the
  // plugin. Their stored role is the one in force, so it is theirs to change.
  const roles = store();
  const created = roles.createCustomRole({ id: 'notes-archivist', rules: { owns: 'MINE', mustNot: 'mine', handoff: 'mine' } });
  projection.registerProjectedRoles([role('notes-archivist')]);
  const edited = roles.editRole({
    id: 'notes-archivist', expectedRevision: created.revision, rules: { owns: 'MINE, edited', mustNot: 'mine', handoff: 'mine' }
  });
  assert.equal(edited.definition.rules.owns, 'MINE, edited');
  assert.equal(roles.getRole('notes-archivist').rules.owns, 'MINE, edited');
  assert.equal(roles.suppliedBy('notes-archivist'), null, 'a hidden projection supplies nothing');
});

test('suppliedBy names the plugin behind a role only while that plugin\'s role is the one in force', () => {
  const roles = store();
  assert.equal(roles.suppliedBy('notes-archivist'), null);
  assert.equal(roles.suppliedBy('worker'), null, 'a default is never a plugin\'s');
  projection.registerProjectedRoles([role('notes-archivist')]);
  assert.deepEqual(roles.suppliedBy('notes-archivist'), { plugin: 'notes', pluginId: 'plugin-abc' });
});

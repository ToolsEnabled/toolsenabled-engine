/*
 * Mutations run, one at a time, each landed in src/lib/plugin-activation.js and
 * confirmed present before the run. Baseline and restored: green, 12 of 12.
 *   1. assertOrdering() made a no-op -> red, 1 of 12 ('activation after the tool
 *      registry is loaded is refused with a sentence naming the entrypoint').
 *   2. the per-plugin try/catch around host.activate() removed -> red, 1 of 12
 *      ('one broken plugin does not stop the engine, and is not silent either').
 *   3. the `if (!described.inForce.length)` skip removed -> red, 2 of 12 (the
 *      undecided package and the withdrawn one).
 *   4. the whole-pass catch around listPackages() re-threw -> red, 1 of 12 ('a
 *      pass that fails entirely is not the same as there being no plugins').
 *   5. `if (outcome) return outcome` removed from activate() -> red, 1 of 12
 *      ('activation is idempotent, because two entrypoints share one process').
 *   6. the roleProjection.seal() call removed -> red, 1 of 12.
 *
 * THE LATE-PASS RULE (release integration, 1.0.49): a pass that finds the tool
 * registry already loaded is refused only when a granted plugin's tools would be
 * lost. Before it, every late pass was refused, and the app's owner host did not
 * start on a machine with no plugin. The three late-pass tests were red against
 * that first version (3 of 14) and green after. Mutations, landed and confirmed
 * one at a time, restored after (14 of 14):
 *   10. `if (late) assertNothingLost(...)` removed -> red, 1 of 14 (the granted
 *       plugin's tools would be lost in silence).
 *   11. every late pass refused again -> red, 3 of 14 (no plugin, and no tools).
 *   12. the check moved below the loop that activates packages -> red, 1 of 14:
 *       it still refuses, but only after a package's directories were prepared.
 *   13. "loses tools" read as "granted anything" -> red, 1 of 14 (roles only).
 *   14. `late` hard-wired to false -> red, 1 of 14.
 *
 * THE SHARED DURABLE-STATE DOOR (review finding F1, 2026-09-27). The two child
 * tests below were red against 4adda18 (2 of 16: the pass read grants after the
 * seal, and 3 handles to toolsenabled.sqlite3 stayed open after it) and green
 * after. Mutation: activate() given its own createStateStore() again -> red, 2 of
 * 16.
 *
 * ALSO ASSERTED HERE, MECHANICALLY: that src/mcp-server.js and
 * tools/mission-bridge.js require plugin activation ABOVE the tool registry. That
 * is the ordering the whole feature rests on whenever a plugin holds a grant to run
 * tools, and a reader is not a mechanism. The runtime refusal catches it too, but
 * only once something exercises that entrypoint with such a plugin installed; the
 * text check catches the edit itself.
 *
 * Mutations run against that text check (release integration, 1.0.49), each
 * landed in the entrypoint and confirmed present before the run. All red:
 *   7. tools/mission-bridge.js: activation moved below
 *      require('../src/lib/mission-bridge/server') in main(). Before the check
 *      named the mission-bridge modules as registry loaders, this PASSED: the file
 *      never names tool-registry, and a file with no registry require was skipped.
 *   8. tools/mission-bridge.js: mission-bridge/server required at the top of
 *      main(), above activation.
 *   9. src/mcp-server.js: activation moved below the tool-registry require.
 *   15. tools/mission-bridge.js: the tool registry required at module scope.
 *   16. tools/mission-bridge.js: mission-bridge/server required at module scope.
 *   17. tools/mission-bridge.js: mission-bridge/actions required inside
 *       parseArgs().
 *   15, 16 and 17 PASSED while the check compared the bridge inside main() only;
 *   it now reads the whole file with usage()'s body blanked.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const activation = require('../src/lib/plugin-activation');
const projection = require('../src/lib/plugin-role-projection');

afterEach(() => activation.resetForTests());

const RULES = Object.freeze({
  owns: 'The index: what is in it, and where each note came from.',
  mustNot: 'Never delete a note it did not create.',
  handoff: 'Hands a finished index on with the folder it was built from.'
});

function described(overrides = {}) {
  return {
    id: 'plugin-abc0000000000000',
    sha256: 'a'.repeat(64),
    root: '/packages/notes',
    name: 'notes',
    displayName: 'Notes',
    requested: ['subprocess', 'roles'],
    granted: ['subprocess', 'roles'],
    inForce: ['subprocess', 'roles'],
    withheld: [],
    effectFloor: 'local-write',
    revoked: null,
    ...overrides
  };
}

function plugin(overrides = {}) {
  return {
    identity: { id: 'plugin-abc0000000000000', sha256: 'a'.repeat(64), root: '/packages/notes' },
    manifest: { name: 'notes', displayName: 'Notes', provides: { tools: [{ name: 'reindex' }] } },
    capabilities: ['subprocess', 'roles'],
    effectFloor: 'local-write',
    ...overrides
  };
}

/* A host with the real shapes and a recorder. */
function fakeHost(options = {}) {
  const {
    packages = [described()], refused = [], activateThrows = null, rolesThrows = null,
    roles = [{ id: 'notes-archivist', rules: { ...RULES } }], packThrows = null,
    listThrows = null, skin = {}, settings = [], settingsThrows = null, activated = plugin()
  } = options;
  const calls = [];
  return {
    calls,
    listPackages: (opts) => { calls.push('listPackages'); if (listThrows) throw listThrows; return { root: '/packages', packages, refused }; },
    activate: (root) => { calls.push(`activate:${root}`); if (activateThrows) throw activateThrows; return activated; },
    rolesFor: () => { calls.push('rolesFor'); if (rolesThrows) throw rolesThrows; return roles; },
    // As the real one: only a plugin holding `subprocess` contributes a pack.
    registerActivatedPlugins: (list) => {
      calls.push('register');
      if (packThrows) throw packThrows;
      return list.filter(p => p.capabilities.includes('subprocess')).map(p => `plugin-${p.manifest.name}`);
    },
    skinFor: () => skin,
    settingsFor: () => { if (settingsThrows) throw settingsThrows; return settings; }
  };
}

const GRANTS = Object.freeze({ capabilitiesFor: () => [], record: () => null, approvalWaived: () => false });

test('a fresh install activates nothing, and status says so rather than nothing', () => {
  assert.equal(activation.status(), null, 'status before activation is null, not an empty pass');
  const outcome = activation.activate({ host: fakeHost({ packages: [] }), grants: GRANTS });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.activated, []);
  assert.deepEqual(outcome.refused, []);
  assert.deepEqual(outcome.skipped, []);
  const status = activation.status();
  assert.equal(status.ok, true);
  assert.deepEqual(status.activated, []);
});

test('a granted plugin is activated, its pack registered and its roles projected', () => {
  const host = fakeHost();
  const outcome = activation.activate({ host, grants: GRANTS });
  assert.equal(outcome.activated.length, 1);
  const [entry] = outcome.activated;
  assert.equal(entry.name, 'notes');
  assert.deepEqual(entry.capabilities, ['subprocess', 'roles']);
  assert.deepEqual(entry.roleIds, ['notes-archivist']);
  assert.equal(entry.toolCount, 1);
  assert.deepEqual(outcome.registeredPacks, ['plugin-notes']);
  assert.deepEqual(projection.projectedRoles().map(role => role.id), ['notes-archivist']);
  // The projected role carries which package it came from, so a screen can say so.
  assert.equal(projection.projectedRole('notes-archivist').plugin, 'notes');
});

test('activation seals the role projection when it is done', () => {
  activation.activate({ host: fakeHost(), grants: GRANTS });
  // Nothing legitimate registers after this point, and an attempt to says so
  // instead of quietly replacing the vocabulary mid-run.
  assert.throws(() => projection.registerProjectedRoles([]), (error) => {
    assert.equal(error.code, 'PLUGIN_ROLE_PROJECTION_SEALED');
    return true;
  });
});

test('a package nobody has decided about is skipped with the reason', () => {
  const host = fakeHost({ packages: [described({ granted: [], inForce: [], withheld: ['subprocess', 'roles'] })] });
  const outcome = activation.activate({ host, grants: GRANTS });
  assert.deepEqual(outcome.activated, []);
  assert.equal(outcome.skipped.length, 1);
  assert.equal(outcome.skipped[0].reason, 'it has not been allowed anything yet');
  // Not an error and not silence: "why is my plugin not working" has an answer at
  // the first place anybody looks.
  assert.deepEqual(outcome.refused, []);
  assert.ok(!host.calls.some(call => call.startsWith('activate:')), 'nothing was activated');
});

test('a withdrawn package is skipped, and says it was withdrawn', () => {
  const host = fakeHost({
    packages: [described({ granted: [], inForce: [], revoked: { at: '2026-09-26T00:00:00Z', by: 'owner', reason: null } })]
  });
  const outcome = activation.activate({ host, grants: GRANTS });
  assert.equal(outcome.skipped[0].reason, 'its permissions were withdrawn');
});

test('one broken plugin does not stop the engine, and is not silent either', () => {
  const broken = Object.assign(new Error('This plugin needs python3, and none of the places this build looks for it has it.'),
    { code: 'PLUGIN_INTERPRETER_MISSING' });
  const outcome = activation.activate({ host: fakeHost({ activateThrows: broken }), grants: GRANTS });
  // The engine started.
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.activated, []);
  // And the plugin's own sentence survived to where somebody will read it.
  assert.equal(outcome.refused.length, 1);
  assert.equal(outcome.refused[0].code, 'PLUGIN_INTERPRETER_MISSING');
  assert.match(outcome.refused[0].message, /needs python3/);
});

test('a refusal names the package and the part that did not start, so a screen can put it on the right card', () => {
  // 1.0.50 release review F6: refusals reached only the console, keyed by a name
  // two versions of one plugin can share. Red before (no digest, no part).
  const sha256 = described().sha256;
  const cases = [
    [{ activateThrows: Object.assign(new Error('needs python3'), { code: 'PLUGIN_INTERPRETER_MISSING' }) }, 'package'],
    [{ rolesThrows: Object.assign(new Error('bad role'), { code: 'PLUGIN_ROLE_INVALID' }) }, 'roles'],
    // A code the real pack registry can raise. This case used to say
    // TOOL_PACK_DUPLICATE, which nothing raises: a same-named plugin's tools never
    // reached this catch, they broke the registry (see the same-name tests below).
    [{ packThrows: Object.assign(new Error('pack refused'), { code: 'PLUGIN_TOOL_PACK_REFUSED' }) }, 'tools']
  ];
  for (const [options, part] of cases) {
    activation.resetForTests();
    const outcome = activation.activate({ host: fakeHost(options), grants: GRANTS });
    assert.deepEqual(outcome.refused.map(entry => [entry.sha256, entry.part]), [[sha256, part]]);
  }
});

test('a directory the host refused is carried through, not re-summarised', () => {
  const outcome = activation.activate({
    host: fakeHost({
      packages: [],
      refused: [{ directory: 'broken', code: 'PLUGIN_MANIFEST_UNKNOWN_FIELD', message: 'plugin.json has trustLevel.' }]
    }),
    grants: GRANTS
  });
  assert.equal(outcome.refused.length, 1);
  assert.match(outcome.refused[0].message, /trustLevel/)
});

test('a bad role file loses the roles and keeps the tools', () => {
  // Refusing the whole package for a typo in one JSON file is a bigger punishment
  // than the mistake, and the tools were validated separately.
  const outcome = activation.activate({
    host: fakeHost({ rolesThrows: Object.assign(new Error('roles/archivist.json has capabilities.'), { code: 'PLUGIN_ROLE_UNKNOWN_FIELD' }) }),
    grants: GRANTS
  });
  assert.equal(outcome.activated.length, 1, 'the package is still activated');
  assert.deepEqual(outcome.activated[0].roleIds, []);
  assert.deepEqual(outcome.registeredPacks, ['plugin-notes'], 'its tools still registered');
  assert.equal(outcome.refused.length, 1);
  assert.match(outcome.refused[0].directory, /\(roles\)$/);
});

test('a pass that fails entirely is not the same as there being no plugins', () => {
  const outcome = activation.activate({
    host: fakeHost({ listThrows: Object.assign(new Error('the durable state store will not open'), { code: 'STATE_SCHEMA_INVALID' }) }),
    grants: GRANTS
  });
  // ok:false, with the reason. An empty-and-ok pass would read as "nothing is
  // installed", which is the reading that makes a person stop looking.
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'STATE_SCHEMA_INVALID');
  assert.match(outcome.reason, /will not open/);
  assert.equal(activation.status().ok, false);
  assert.deepEqual(activation.skins(), {}, 'a failed pass contributes no skin');
  assert.deepEqual(activation.settings(), [], 'and no settings rows');
});

test('activation is idempotent, because two entrypoints share one process', () => {
  const host = fakeHost();
  const first = activation.activate({ host, grants: GRANTS });
  const second = activation.activate({ host, grants: GRANTS });
  assert.equal(first, second, 'the same frozen outcome, not a second pass');
  assert.equal(host.calls.filter(call => call === 'register').length, 1,
    'a pack registered twice would throw from tool-pack-registry');
});

/* THE GRANT READS GO THROUGH THE PROCESS'S ONE DURABLE-STATE DOOR.
 *
 * Found by review, 2026-09-27: with no store handed in, activation built a grant
 * store over a SQLite connection of its own (createStateStore(), not
 * getStateStore()). The app's Erase seals and closes only the shared one
 * (sealAndCloseStateStore()), so with any folder in plugin-packages -- granted or
 * not -- the process kept toolsenabled.sqlite3, -wal and -shm open through Erase:
 * on Windows a database file the sweep cannot delete, under a reset card saying
 * it was removed. Each check runs in a child, because sealing the shared store is
 * one-way for the process that does it. */
function activationChild(body) {
  const { execFileSync } = require('node:child_process');
  const base = fs.mkdtempSync(path.join(os.homedir(), '.te-plugin-activation-seal-'));
  const pkg = path.join(base, 'plugin-packages', 'notes');
  fs.mkdirSync(path.join(pkg, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'plugin.json'), JSON.stringify({
    schemaVersion: 1, name: 'notes', displayName: 'Notes', summary: 'A fixture with one role.',
    requires: ['roles'], provides: { roles: ['roles/archivist.json'] }
  }));
  fs.writeFileSync(path.join(pkg, 'roles', 'archivist.json'), JSON.stringify({
    id: 'archivist', displayName: 'Archivist', summary: 'Files notes.', ...RULES
  }));
  const program = `
    const activation = require(${JSON.stringify(require.resolve('../src/lib/plugin-activation'))});
    const realHost = require(${JSON.stringify(require.resolve('../src/lib/plugin-host'))});
    const stateStore = require(${JSON.stringify(require.resolve('../src/lib/state-store'))});
    const host = { ...realHost, listPackages: (options) => realHost.listPackages({ ...options, root: ${JSON.stringify(path.join(base, 'plugin-packages'))} }) };
    // The durable-state database this process would open (a constructed store
    // opens nothing), matched with its -wal and -shm beside it. Named by the
    // store rather than here: the isolated runner renames it.
    const databaseFile = new stateStore.StateStore().file;
    const openDatabaseFiles = () => {
      if (process.platform !== 'linux') return null;
      const fs = require('node:fs');
      return fs.readdirSync('/proc/self/fd').filter((fd) => {
        try { return fs.readlinkSync('/proc/self/fd/' + fd).startsWith(databaseFile); } catch { return false; }
      }).length;
    };
    ${body}
  `;
  try {
    return JSON.parse(execFileSync(process.execPath, ['-e', program], { encoding: 'utf8', env: process.env }));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('with no store handed in, a pass reads grants through the shared durable-state door', () => {
  // Sealed first: a pass that opened a connection of its own would not notice.
  const outcome = activationChild(`
    stateStore.sealAndCloseStateStore();
    const outcome = activation.activate({ host });
    process.stdout.write(JSON.stringify({ skipped: outcome.skipped.length, refused: outcome.refused.map(entry => entry.code) }));
  `);
  // The package's grant could not be read, so it is refused with the store's own
  // code -- never listed as "not allowed anything", which is what a second
  // connection opened behind the seal would have answered.
  assert.deepEqual(outcome, { skipped: 0, refused: ['STATE_STORE_CLOSED'] });
});

test('after a pass that found a plugin, sealing the shared store leaves no database file open', { skip: process.platform !== 'linux' && 'reads /proc/self/fd' }, () => {
  const seen = activationChild(`
    const outcome = activation.activate({ host });
    const during = openDatabaseFiles();
    stateStore.sealAndCloseStateStore();
    process.stdout.write(JSON.stringify({ ok: outcome.ok, skipped: outcome.skipped.length, during, after: openDatabaseFiles() }));
  `);
  assert.equal(seen.ok, true);
  assert.equal(seen.skipped, 1, 'the package was listed, so its grant was read');
  assert.ok(seen.during > 0, 'the grant read opened the database');
  assert.equal(seen.after, 0, 'and the seal Erase uses closed every handle to it');
});

/* ONE PLUGIN'S ROLES NEVER COST ANOTHER PLUGIN ITS ROLES (1.0.50 release review F3).
 *
 * Every plugin's roles were registered in one call, and that call refuses its whole
 * list for one bad entry. With a two-word role id -- the documented form, which the
 * projection then refused -- no plugin role from any plugin reached the role
 * library, and the only trace was a console line. These four were red before the
 * fix (each projected nothing and reported '(plugin roles)') and green after. */
function rolesHost(plugins) {
  const byRoot = new Map(plugins.map(entry => [entry.root, entry]));
  return {
    listPackages: () => ({
      root: '/packages',
      packages: plugins.map(entry => described({
        id: `plugin-${entry.name.padEnd(16, '0').slice(0, 16)}`, root: entry.root, name: entry.name,
        requested: ['roles'], granted: ['roles'], inForce: ['roles'], effectFloor: 'local-read'
      })),
      refused: []
    }),
    activate: (root) => plugin({
      identity: { id: `plugin-${byRoot.get(root).name.padEnd(16, '0').slice(0, 16)}`, sha256: 'b'.repeat(64), root },
      manifest: { name: byRoot.get(root).name, displayName: byRoot.get(root).name, provides: { roles: ['r.json'] } },
      capabilities: ['roles'],
      effectFloor: 'local-read'
    }),
    rolesFor: (activated) => byRoot.get(activated.identity.root).roles.map(id => ({ id, rules: { ...RULES } })),
    registerActivatedPlugins: () => [],
    skinFor: () => ({}),
    settingsFor: () => []
  };
}

test('a two-word role id is projected, beside another plugin\'s roles', () => {
  const outcome = activation.activate({
    host: rolesHost([
      { root: '/packages/notes', name: 'notes', roles: ['notes-code_reviewer'] },
      { root: '/packages/drafts', name: 'drafts', roles: ['drafts-editor'] }
    ]),
    grants: GRANTS
  });
  assert.deepEqual(outcome.refused, []);
  assert.deepEqual(projection.projectedRoles().map(role => role.id), ['drafts-editor', 'notes-code_reviewer']);
  assert.deepEqual(outcome.activated.map(entry => [entry.name, [...entry.roleIds]]),
    [['notes', ['notes-code_reviewer']], ['drafts', ['drafts-editor']]]);
});

test('a role the projection would refuse costs its own plugin\'s roles and no other plugin\'s', () => {
  const tooLong = `notes-${'x'.repeat(64)}`;
  const outcome = activation.activate({
    host: rolesHost([
      { root: '/packages/notes', name: 'notes', roles: ['notes-archivist', tooLong] },
      { root: '/packages/drafts', name: 'drafts', roles: ['drafts-editor'] }
    ]),
    grants: GRANTS
  });
  assert.deepEqual(projection.projectedRoles().map(role => role.id), ['drafts-editor'],
    'the other plugin\'s role is still there');
  assert.equal(outcome.refused.length, 1);
  assert.equal(outcome.refused[0].directory, 'notes (roles)', 'named against the plugin it belongs to');
  assert.equal(outcome.refused[0].code, 'PLUGIN_ROLE_PROJECTION_INVALID');
  assert.deepEqual(outcome.activated.map(entry => [entry.name, [...entry.roleIds]]),
    [['notes', []], ['drafts', ['drafts-editor']]], 'and roleIds say what was actually projected');
  assert.throws(() => projection.registerProjectedRoles([]), (error) => (assert.equal(error.code, 'PLUGIN_ROLE_PROJECTION_SEALED'), true),
    'the projection was registered and sealed, not abandoned');
});

test('a role id two plugins both add is used by neither, and their other roles stay', () => {
  const outcome = activation.activate({
    host: rolesHost([
      { root: '/packages/notes-a', name: 'notes', roles: ['notes-archivist', 'notes-shared'] },
      { root: '/packages/notes-b', name: 'notes', roles: ['notes-shared', 'notes-curator'] }
    ]),
    grants: GRANTS
  });
  assert.deepEqual(projection.projectedRoles().map(role => role.id), ['notes-archivist', 'notes-curator']);
  assert.deepEqual(outcome.refused.map(entry => [entry.directory, entry.code]),
    [['notes (roles)', 'PLUGIN_ROLE_PROJECTION_COLLISION'], ['notes (roles)', 'PLUGIN_ROLE_PROJECTION_COLLISION']]);
  assert.match(outcome.refused[0].message, /"notes-shared"/);
});

test('the bound on projected roles is applied per plugin: the plugins before it keep theirs', () => {
  const sixteen = name => Array.from({ length: 16 }, (_, index) => `${name}-r${index}`);
  const names = ['a', 'b', 'c', 'd', 'e'];
  const outcome = activation.activate({
    host: rolesHost(names.map(name => ({ root: `/packages/${name}`, name, roles: sixteen(name) }))),
    grants: GRANTS
  });
  assert.equal(projection.projectedRoles().length, projection.MAX_PROJECTED_ROLES);
  assert.deepEqual(outcome.activated.map(entry => entry.roleIds.length), [16, 16, 16, 16, 0]);
  assert.deepEqual(outcome.refused.map(entry => [entry.directory, entry.code]), [['e (roles)', 'PLUGIN_ROLE_PROJECTION_LIMIT']]);
});

/* TWO ALLOWED PLUGINS THAT SHARE A NAME (1.0.50 review, high 1).
 *
 * A plugin's tools are named from its manifest name alone
 * (`plugin.<name>.<tool>`), and grants are keyed by digest, so two packages
 * called "notes" -- 1.1 unpacked beside 1.0, or two unrelated authors -- can both
 * be allowed to run programs. Both packs were registered, and the clash surfaced
 * only when src/lib/tool-registry.js threw "Duplicate tool name" at module load:
 * the app's owner host did not start, every agent start failed with
 * OWNER_HOST_START_FAILED, and both cards said running. The fake host above
 * could not see it (it threw a code the real registry never raises), so the
 * first test here uses the real host, the real grant store and the real
 * registry, in a child, because a registry cannot be unloaded.
 *
 * Red before the fix, 2 of 25: the child's require of the registry threw
 * "Duplicate tool name 'plugin.notes.reindex'." with nothing refused, and the
 * fake-host case registered both. Green after, 25 of 25. Mutations, landed one
 * at a time in src/lib/plugin-activation.js and restored after:
 *   18. the `continue` after the collision refusal removed -> red, 2 of 25 (the
 *       registry throws again; the later pack is registered).
 *   19. tool names claimed before registration rather than after it -> red, 1 of
 *       25 (a plugin whose pack failed still held its names). */
function toolsPackage(dir, { name = 'notes', tools = ['reindex'], version = '1.0' } = {}) {
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    schemaVersion: 1, name, displayName: `Notes ${version}`, summary: `A fixture that runs one program (${version}).`,
    requires: ['subprocess'],
    provides: {
      tools: tools.map(tool => ({
        name: tool, summary: 'Rebuild the index.', effect: 'local-read',
        run: { interpreter: 'node', script: 'tools/reindex.js' }, params: []
      }))
    }
  }));
  fs.writeFileSync(path.join(dir, 'tools', 'reindex.js'), `process.stdout.write('${version}');\n`);
}

test('end to end: two allowed plugins with the same name -- the later one\'s tools are refused, the registry still loads', () => {
  const { execFileSync } = require('node:child_process');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-activation-same-name-'));
  try {
    const packages = path.join(scratch, 'plugin-packages');
    toolsPackage(path.join(packages, 'notes-1.0'), { version: '1.0' });
    toolsPackage(path.join(packages, 'notes-1.1'), { version: '1.1' });
    const program = `
      const activation = require(${JSON.stringify(require.resolve('../src/lib/plugin-activation'))});
      const realHost = require(${JSON.stringify(require.resolve('../src/lib/plugin-host'))});
      const { PluginGrantStore } = require(${JSON.stringify(require.resolve('../src/lib/plugin-host/grants'))});
      const path = require('node:path');
      const memory = new Map();
      const stateStore = {
        getMemory: ({ namespace, key }) => memory.get(namespace + '\\u0000' + key) || null,
        setMemory: ({ namespace, key, value }) => {
          const prior = memory.get(namespace + '\\u0000' + key);
          const entry = { key, value: JSON.parse(JSON.stringify(value)), revision: prior ? prior.revision + 1 : 1 };
          memory.set(namespace + '\\u0000' + key, entry);
          return { entry, created: !prior, replayed: false };
        },
        searchMemory: () => []
      };
      const grants = new PluginGrantStore({ stateStore, now: () => '2026-10-13T00:00:00Z' });
      const packages = ${JSON.stringify(packages)};
      const digests = {};
      for (const folder of ['notes-1.0', 'notes-1.1']) {
        const { identity, manifest } = realHost.inspect(path.join(packages, folder));
        grants.grant({ identity, manifest, capabilities: ['subprocess'], actor: 'owner' });
        digests[folder] = identity.sha256;
      }
      const stateRoot = () => ${JSON.stringify(path.join(scratch, 'state'))};
      const host = {
        ...realHost,
        listPackages: (options) => realHost.listPackages({ ...options, root: packages }),
        activate: (root, options) => realHost.activate(root, { ...options, stateRoot })
      };
      const outcome = activation.activate({ host, grants });
      let registry = null;
      try {
        const loaded = require(${JSON.stringify(require.resolve('../src/lib/tool-registry'))});
        registry = { names: loaded.TOOL_REGISTRY.map(entry => entry.name).filter(name => name.startsWith('plugin.')) };
      } catch (error) {
        registry = { threw: String(error && error.message) };
      }
      process.stdout.write(JSON.stringify({
        digests,
        activated: outcome.activated.map(entry => entry.sha256),
        registeredPacks: outcome.registeredPacks,
        refused: outcome.refused.map(entry => ({ ...entry })),
        registry
      }));
    `;
    const seen = JSON.parse(execFileSync(process.execPath, ['-e', program], { encoding: 'utf8', env: process.env }));
    const first = seen.digests['notes-1.0'];
    const later = seen.digests['notes-1.1'];
    assert.deepEqual(seen.registry, { names: ['plugin.notes.reindex'] },
      'the registry loads, so the owner host and every agent start; the name is served once');
    assert.deepEqual(seen.activated, [first, later], 'both packages were brought up');
    assert.deepEqual(seen.registeredPacks, [`plugin-${first.slice(0, 16)}`], 'only the first one\'s tools were registered');
    assert.equal(seen.refused.length, 1, 'one refusal, on the later plugin only');
    const [refusal] = seen.refused;
    assert.equal(refusal.sha256, later, 'on the later plugin\'s card');
    assert.equal(refusal.part, 'tools');
    assert.equal(refusal.code, 'PLUGIN_TOOL_NAME_COLLISION');
    assert.equal(refusal.directory, 'notes (tools)');
    assert.match(refusal.message, /"notes-1\.0"/, 'it names the folder of the plugin that kept the name');
    assert.match(refusal.message, /plugin\.notes\.reindex/, 'and the tool the two share');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

function toolsHost(entries) {
  const byRoot = new Map(entries.map(entry => [entry.root, entry]));
  const calls = [];
  return {
    calls,
    listPackages: () => ({
      root: '/packages',
      packages: entries.map(entry => described({
        id: entry.id, sha256: entry.sha256, root: entry.root, name: entry.name,
        requested: ['subprocess'], granted: ['subprocess'], inForce: ['subprocess']
      })),
      refused: []
    }),
    activate: (root) => {
      const entry = byRoot.get(root);
      return plugin({
        identity: { id: entry.id, sha256: entry.sha256, root },
        manifest: { name: entry.name, displayName: entry.name, provides: { tools: entry.tools.map(name => ({ name })) } },
        capabilities: ['subprocess']
      });
    },
    rolesFor: () => [],
    registerActivatedPlugins: (list) => list.map((activated) => {
      calls.push(activated.identity.root);
      const entry = byRoot.get(activated.identity.root);
      if (entry.packThrows) throw entry.packThrows;
      return activated.identity.id;
    }),
    skinFor: () => ({}),
    settingsFor: () => []
  };
}

function toolsEntry(folder, digit, name, tools, extra = {}) {
  return { root: `/packages/${folder}`, name, tools, id: `plugin-${folder}`, sha256: digit.repeat(64), ...extra };
}

test('a tool name another allowed plugin already provides refuses only the later plugin\'s tools', () => {
  const entries = [
    toolsEntry('notes-1.0', '1', 'notes', ['reindex', 'search']),
    toolsEntry('notes-1.1', '2', 'notes', ['reindex', 'export']),
    toolsEntry('drafts', '3', 'drafts', ['reindex'])
  ];
  const host = toolsHost(entries);
  const outcome = activation.activate({ host, grants: GRANTS });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.activated.map(entry => entry.sha256), entries.map(entry => entry.sha256),
    'all three were brought up');
  assert.deepEqual(host.calls, ['/packages/notes-1.0', '/packages/drafts'],
    'the later "notes" was never handed to the tool registry; a different name reusing a tool name is not a clash');
  assert.deepEqual(outcome.registeredPacks, ['plugin-notes-1.0', 'plugin-drafts']);
  assert.deepEqual(outcome.refused.map(entry => ({ ...entry, message: undefined })), [{
    directory: 'notes (tools)', sha256: entries[1].sha256, part: 'tools', code: 'PLUGIN_TOOL_NAME_COLLISION', message: undefined
  }]);
  const { message } = outcome.refused[0];
  assert.match(message, /"notes-1\.0"/);
  assert.match(message, /plugin\.notes\.reindex/);
  assert.doesNotMatch(message, /plugin\.notes\.export/, 'it names only the tool the two share');
  assert.match(message, /withdraw/i, 'and says what to do');
});

test('a plugin whose same-named sibling could not register its tools keeps its own', () => {
  // Names are claimed by tools that were REGISTERED, not by tools that were
  // declared: a plugin refused for another reason holds nothing.
  const entries = [
    toolsEntry('notes-1.0', '1', 'notes', ['reindex'], { packThrows: Object.assign(new Error('pack refused'), { code: 'PLUGIN_TOOL_PACK_REFUSED' }) }),
    toolsEntry('notes-1.1', '2', 'notes', ['reindex'])
  ];
  const outcome = activation.activate({ host: toolsHost(entries), grants: GRANTS });
  assert.deepEqual(outcome.registeredPacks, ['plugin-notes-1.1']);
  assert.deepEqual(outcome.refused.map(entry => [entry.sha256, entry.code]), [[entries[0].sha256, 'PLUGIN_TOOL_PACK_REFUSED']]);
});

test('end to end with the real host: a role file whose id is two words reaches the role library', () => {
  const realHost = require('../src/lib/plugin-host');
  const { PluginGrantStore } = require('../src/lib/plugin-host/grants');
  const { CustomRoleStore } = require('../src/lib/custom-role-store');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-activation-roles-'));
  try {
    const pkg = path.join(scratch, 'plugin-packages', 'notes');
    fs.mkdirSync(path.join(pkg, 'roles'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'plugin.json'), JSON.stringify({
      schemaVersion: 1, name: 'notes', displayName: 'Notes', summary: 'A fixture with one two-word role.',
      requires: ['roles'], provides: { roles: ['roles/reviewer.json'] }
    }));
    fs.writeFileSync(path.join(pkg, 'roles', 'reviewer.json'), JSON.stringify({ id: 'code_reviewer', ...RULES }));
    const memory = new Map();
    const stateStore = {
      getMemory: ({ namespace, key }) => memory.get(`${namespace}\u0000${key}`) || null,
      setMemory: ({ namespace, key, value }) => {
        const prior = memory.get(`${namespace}\u0000${key}`);
        const entry = { key, value: JSON.parse(JSON.stringify(value)), revision: prior ? prior.revision + 1 : 1 };
        memory.set(`${namespace}\u0000${key}`, entry);
        return { entry, created: !prior, replayed: false };
      },
      searchMemory: () => []
    };
    const grants = new PluginGrantStore({ stateStore, now: () => '2026-10-13T00:00:00Z' });
    const { identity, manifest } = realHost.inspect(pkg);
    grants.grant({ identity, manifest, capabilities: ['roles'], actor: 'owner' });
    const host = { ...realHost, listPackages: (options) => realHost.listPackages({ ...options, root: path.join(scratch, 'plugin-packages') }) };
    const outcome = activation.activate({ host, grants });
    assert.deepEqual(outcome.refused, []);
    assert.deepEqual([...outcome.activated[0].roleIds], ['notes-code_reviewer']);
    const roles = new CustomRoleStore({ stateStore });
    assert.equal(roles.getRole('notes-code_reviewer').rules.owns, RULES.owns, 'the role library serves it');
    assert.equal(roles.listRoles().at(-1).id, 'notes-code_reviewer');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// EVERY TEST FROM HERE ON RUNS WITH THE REAL TOOL REGISTRY LOADED, which is the
// real condition: a late pass is one that finds src/lib/tool-registry.js already in
// require.cache. The registry cannot be unloaded, so these stay last.

test('a late pass that would lose a granted plugin\'s tools is refused with a sentence naming the entrypoint', () => {
  // A require() ordering mistake in this repository is a build error, and a build
  // error must not be discoverable only by somebody wondering where their plugin
  // went. THIS is the ordering the entrypoints' text check below protects.
  require('../src/lib/tool-registry');
  const host = fakeHost();
  assert.throws(() => activation.activate({ host, grants: GRANTS }), (error) => {
    assert.match(error.message, /ran after src\/lib\/tool-registry\.js was already loaded/);
    assert.match(error.message, /Move the require of src\/lib\/plugin-activation\.js above/);
    assert.match(error.message, /notes holds a grant to run tools/);
    assert.equal(error.code, 'PLUGIN_ACTIVATION_AFTER_REGISTRY');
    assert.deepEqual([...error.plugins], ['notes']);
    return true;
  });
  // Refused BEFORE anything was brought up: host.activate() prepares a plugin's
  // directories, so a refusal that came after it would leave them behind.
  assert.deepEqual(host.calls, ['listPackages'], 'nothing was activated, registered or projected');
  assert.equal(activation.status(), null, 'a refused pass records no outcome');
  assert.deepEqual(projection.projectedRoles(), []);
  assert.doesNotThrow(() => projection.registerProjectedRoles([]), 'and it did not seal the projection');
});

test('a late pass with no plugin installed is not refused, and reads and writes nothing', () => {
  // The machine with no plugins, which is every machine today. Before this rule a
  // late pass threw here too, and the app's owner host -- whose organisation record
  // loads the registry first -- did not start. Real host, real listing, an empty
  // packages root; the grant store is a recorder, and it must not be asked anything.
  require('../src/lib/tool-registry');
  const realHost = require('../src/lib/plugin-host');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-activation-late-'));
  try {
    const asked = [];
    const stateStore = {
      getMemory: (request) => { asked.push(['getMemory', request]); return null; },
      setMemory: (request) => { asked.push(['setMemory', request]); return null; },
      searchMemory: (request) => { asked.push(['searchMemory', request]); return []; }
    };
    const host = { ...realHost, listPackages: (options) => realHost.listPackages({ ...options, root: path.join(scratch, 'plugin-packages') }) };
    const outcome = activation.activate({ host, stateStore });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.activated, []);
    assert.deepEqual(outcome.refused, []);
    assert.deepEqual(outcome.skipped, []);
    assert.deepEqual(outcome.registeredPacks, []);
    assert.deepEqual(asked, [], 'the grant store was never read or written');
    assert.deepEqual(fs.readdirSync(scratch), [], 'no directory was created');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a late pass whose grants run no tools is not refused, and is the pass an early one would be', () => {
  // Undecided, withdrawn, and granted roles only: none of them contributes a tool
  // pack, so none of them loses anything to the registry being built. Roles are
  // read through the projection on every read, so projecting them now is on time.
  require('../src/lib/tool-registry');
  const rolesOnly = plugin({
    capabilities: ['roles'],
    effectFloor: 'local-read',
    manifest: { name: 'notes', displayName: 'Notes', provides: { roles: ['roles/archivist.json'] } }
  });
  const host = fakeHost({
    activated: rolesOnly,
    packages: [
      described({ requested: ['roles'], granted: ['roles'], inForce: ['roles'], effectFloor: 'local-read' }),
      described({ id: 'plugin-def0000000000000', name: 'drafts', granted: [], inForce: [], withheld: ['subprocess', 'roles'] }),
      described({ id: 'plugin-fed0000000000000', name: 'old', granted: [], inForce: [], revoked: { at: '2026-09-26T00:00:00Z', by: 'owner', reason: null } })
    ]
  });
  const outcome = activation.activate({ host, grants: GRANTS });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.activated.map(entry => entry.name), ['notes']);
  assert.deepEqual(outcome.activated[0].roleIds, ['notes-archivist']);
  assert.equal(outcome.activated[0].toolCount, 0);
  assert.deepEqual(outcome.registeredPacks, [], 'no pack, so nothing was registered after the freeze');
  assert.deepEqual(outcome.skipped.map(entry => entry.reason),
    ['it has not been allowed anything yet', 'its permissions were withdrawn']);
  assert.deepEqual(outcome.refused, []);
  assert.deepEqual(projection.projectedRoles().map(role => role.id), ['notes-archivist']);
});

test('both payload entrypoints require plugin activation above the tool registry', () => {
  // THE ORDERING, CHECKED AS TEXT. The runtime assertion above catches it too, but
  // only if something exercises that entrypoint; this catches the edit itself.
  //
  // tools/mission-bridge.js never names the tool registry: it reaches it through
  // src/lib/mission-bridge/server (which loads mission-bridge/actions, which loads
  // the registry), so the mission-bridge modules count as loaders too. Its usage()
  // requires mission-bridge/server for --help, where no plugin needs to be up, so
  // usage()'s body -- and only that -- is blanked, and the REST OF THE FILE is
  // compared: a loader at module scope, in parseArgs() or at the top of main() is
  // above activation and fails. Scoping the comparison to main() instead missed the
  // first two of those. A file in which no known loader is found fails rather than
  // being skipped: a skipped file was how moving the bridge's activation line below
  // the server once still passed.
  const REGISTRY_LOADER = /require\(\s*['"][^'"]*(?:tool-registry|mission-bridge\/server|mission-bridge\/actions)['"]\s*\)/;
  const ENTRYPOINTS = [
    { file: 'src/mcp-server.js', blank: null },
    { file: 'tools/mission-bridge.js', blank: /\nfunction usage\(\)\s*\{[\s\S]*?\n\}\n/ }
  ];
  for (const { file, blank } of ENTRYPOINTS) {
    let source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ');
    if (blank) {
      assert.match(source, blank, `${file} no longer has usage() where this check expects it; update the check rather than skip the file`);
      source = source.replace(blank, (body) => ' '.repeat(body.length));
    }
    const activationAt = source.search(/require\(\s*['"][^'"]*plugin-activation['"]\s*\)/);
    const registryAt = source.search(REGISTRY_LOADER);
    assert.notEqual(activationAt, -1, `${file} does not require plugin activation at all`);
    assert.notEqual(registryAt, -1,
      `${file} reaches the tool registry through no require this check knows; name the new loader here`);
    assert.ok(activationAt < registryAt,
      `${file} requires the tool registry (at ${registryAt}) before plugin activation (at ${activationAt}); `
      + 'every activated plugin\'s tools would be absent from the registry');
  }
});

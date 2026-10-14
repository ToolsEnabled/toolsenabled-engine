/*
 * Mutations run, one at a time, each landed in src/lib/plugin-host/index.js and
 * confirmed present before the run. Baseline and restored: green, 23 of 23.
 *   1. capabilitiesInForce() returned `manifest.requires` instead of intersecting
 *      it with what was granted -> red, 4 of 23 (nothing-in-force, withheld,
 *      contributes-nothing, grant-does-not-survive-a-changed-byte).
 *   2. removed rolesFor()'s `capabilities.includes('roles')` gate -> red, 1 of 23.
 *   3. removed skinFor()'s `capabilities.includes('skin')` gate -> red, 1 of 23.
 *   4. rolesFor() used `value.id` instead of `${plugin.manifest.name}-${value.id}`
 *      -> red, 1 of 23: the fixture role called itself `manager` and got it.
 *   5. `if (absent.length)` -> `if (false && absent.length)` in inspect() -> red,
 *      1 of 23: a manifest naming a script the package does not ship was admitted.
 *   6. added `const loadPluginHook = (dir) => require(dir + '/hook.js');` -> red,
 *      1 of 23. This is the mutation that matters most, because "the host never
 *      require()s plugin code" is the design's load-bearing claim and this is the
 *      shape that would break it.
 *   7. removed settingsFor()'s `capabilities.includes('settings')` gate -> red, 1.
 *   8. removed restrictionsFor()'s gate -> red, 1 of 23.
 *   9. settingStatements() accepted an absent capabilities/risks list -> red, 1.
 *  10. the unknown-field refusal in a settings row neutralised -> red, 1 of 23:
 *      a row naming `section: 'A'` placed itself in the product's own settings.
 *  11. a select's default no longer checked against its own options -> red, 1.
 *  12. the unknown-field refusal in a restrictions file neutralised -> red, 1 of
 *      23: a plugin shipped its own tool surface and egress allowlist.
 *
 * Mutations 7 to 12 were added because 7 SURVIVED on the first pass: settingsFor()
 * and restrictionsFor() had been written without tests, and a mutation run is the
 * only thing that says so out loud.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const host = require('../src/lib/plugin-host');
const { PluginGrantStore } = require('../src/lib/plugin-host/grants');

function fakeStore() {
  const rows = new Map();
  return {
    getMemory({ namespace, key }) {
      const row = rows.get(`${namespace}\u0000${key}`);
      return row ? { value: JSON.parse(JSON.stringify(row.value)), revision: row.revision, key } : null;
    },
    setMemory({ namespace, key, value, note, expectedRevision }) {
      const id = `${namespace}\u0000${key}`;
      const prior = rows.get(id);
      if (expectedRevision !== undefined && (prior ? prior.revision : 0) !== expectedRevision) {
        const error = new Error('conflict'); error.code = 'MEMORY_REVISION_CONFLICT'; throw error;
      }
      const revision = (prior ? prior.revision : 0) + 1;
      rows.set(id, { value: JSON.parse(JSON.stringify(value)), revision, note, key });
      return { entry: { revision }, created: !prior, replayed: false };
    },
    searchMemory({ namespace, query, limit }) {
      const out = [];
      for (const [id, row] of rows) {
        if (!id.startsWith(`${namespace}\u0000`) || !String(row.note).includes(query)) continue;
        out.push({ key: row.key, value: JSON.parse(JSON.stringify(row.value)), revision: row.revision });
        if (out.length >= limit) break;
      }
      return out;
    }
  };
}

const MANIFEST = {
  schemaVersion: 1,
  name: 'notes',
  displayName: 'Notes',
  summary: 'Keeps a searchable index of your own notes.',
  requires: ['storage', 'subprocess', 'network', 'roles', 'settings', 'skin'],
  provides: {
    roles: ['roles/archivist.json'],
    tools: [{
      name: 'reindex',
      summary: 'Rebuild the index for a folder of notes.',
      effect: 'local-read',
      run: { interpreter: 'node', script: 'tools/reindex.js' },
      params: [{ name: 'root', type: 'path', description: 'The folder to index.' }]
    }],
    settings: 'settings/rows.json',
    restrictions: 'settings/restrictions.json',
    skin: { accent: '#0b6', badge: 'Notes' }
  }
};

const ROLE = {
  id: 'archivist',
  displayName: 'Archivist',
  summary: 'Files a note where it will be found again.',
  owns: 'The index and its provenance: every note in it, and the folder each came from.',
  mustNot: 'Never delete a note, and never rewrite one it did not create.',
  handoff: 'Hands a finished index to the curator with the folder it was built from.'
};

// Fixtures under $HOME: src/lib/providers/host-control.js fences paths to the home
// directory, and a fixture in /tmp fails with HOST_PATH_OUTSIDE_PROFILE first.
const ROWS = {
  note: 'Every row says what it grants and what it costs, separately.',
  rows: [
    {
      key: 'reindex_on_open',
      label: 'Rebuild the index when a folder is opened',
      control: 'toggle',
      default: true,
      consequence: 'On, opening a folder rebuilds its index before anything reads it.',
      capabilities: ['Off, a folder opens straight away.'],
      risks: ['Off, a search can miss a note that was added since the last rebuild.']
    },
    {
      key: 'snapshot_copies',
      label: 'Snapshots of the index to keep',
      control: 'select',
      default: 'Two',
      options: ['One', 'Two', 'Three'],
      consequence: 'How many snapshots of the index are kept.',
      capabilities: ['One snapshot uses less disk.'],
      risks: ['One round misses what a second reader would have found.']
    }
  ]
};

const RESTRICTIONS = {
  note: 'Deny by default, and this file can only narrow.',
  hardBlocks: [{ rule: 'No note is deleted without asking', why: 'Filing is a human decision with the owner\'s name on it.' }],
  requiresHumanApproval: ['Any deletion of a note']
};

function fixture({
  manifest = MANIFEST, role = ROLE, withRoleFile = true, withScript = true,
  rows = ROWS, restrictions = RESTRICTIONS
} = {}) {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.te-plugin-host-'));
  const pkg = path.join(base, 'packages', 'notes');
  fs.mkdirSync(path.join(pkg, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'plugin.json'), JSON.stringify(manifest, null, 2));
  if (withScript) fs.writeFileSync(path.join(pkg, 'tools', 'reindex.js'), 'process.stdout.write("{}");\n');
  if (withRoleFile) fs.writeFileSync(path.join(pkg, 'roles', 'archivist.json'), JSON.stringify(role, null, 2));
  fs.mkdirSync(path.join(pkg, 'settings'), { recursive: true });
  if (rows) fs.writeFileSync(path.join(pkg, 'settings', 'rows.json'), JSON.stringify(rows, null, 2));
  if (restrictions) fs.writeFileSync(path.join(pkg, 'settings', 'restrictions.json'), JSON.stringify(restrictions, null, 2));
  const state = path.join(base, 'state-root');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  return { base, pkg, packagesDir: path.join(base, 'packages'), stateRoot: () => state };
}

function grantStore() {
  return new PluginGrantStore({ stateStore: fakeStore(), now: () => '2026-09-26T00:00:00Z' });
}

test('inspect reads identity and manifest and consults no grant', () => {
  const f = fixture();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    assert.match(identity.id, /^plugin-[0-9a-f]{16}$/);
    assert.equal(manifest.name, 'notes');
    assert.equal(identity.fileCount, 5, 'plugin.json, the script, the role, the rows and the restrictions');
    // No directory was created as a side effect of looking.
    assert.equal(fs.existsSync(path.join(f.base, 'state-root', 'state', 'plugins')), false);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a manifest that names files the package does not ship is refused before any decision', () => {
  const f = fixture({ withScript: false });
  try {
    assert.throws(() => host.inspect(f.pkg), (error) => {
      assert.equal(error.code, 'PLUGIN_DECLARED_FILE_MISSING');
      assert.match(error.message, /tools\/reindex\.js/);
      assert.match(error.message, /describing a different package/);
      return true;
    });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('nothing is in force until the owner grants it', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const described = host.describe(f.pkg, { grants });
    assert.deepEqual(described.requested, ['storage', 'subprocess', 'network', 'roles', 'settings', 'skin']);
    assert.deepEqual(described.granted, []);
    assert.deepEqual(described.inForce, []);
    assert.throws(() => host.activate(f.pkg, { grants, stateRoot: f.stateRoot }), (error) => {
      assert.equal(error.code, 'PLUGIN_NOT_GRANTED');
      assert.match(error.message, /Nothing is granted by installing a plugin/);
      return true;
    });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a withheld capability is reported as withheld, not merely absent', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['storage', 'subprocess', 'roles'], actor: 'owner' });
    const described = host.describe(f.pkg, { grants });
    assert.deepEqual(described.inForce, ['storage', 'subprocess', 'roles']);
    // The sentence a person actually needs: it asked for these and does not have them.
    assert.deepEqual(described.withheld, ['network', 'settings', 'skin']);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a plugin contributes nothing for a capability it was not granted', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    assert.deepEqual(plugin.capabilities, ['subprocess']);
    assert.deepEqual(host.rolesFor(plugin), [], 'roles not granted, so its roles do not exist');
    assert.deepEqual(host.skinFor(plugin), {}, 'skin not granted, so its tokens do not exist');
    // A directory is created only for a capability in force.
    assert.equal(fs.existsSync(plugin.paths.workspace), true);
    assert.equal(plugin.paths.storage, null);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a plugin role id is namespaced so it cannot name a default role', () => {
  const f = fixture({ role: { ...ROLE, id: 'manager' } });
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess', 'roles'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    const [role] = host.rolesFor(plugin);
    assert.equal(role.id, 'notes-manager', 'a plugin cannot become the manager by calling itself one');
    assert.deepEqual(Object.keys(role).sort(), ['id', 'rules']);
    assert.deepEqual(Object.keys(role.rules).sort(), ['handoff', 'mustNot', 'owns']);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a two-word role id keeps its underscore, and the whole id must fit the role store', () => {
  // 1.0.50 release review F3: the host's own rule is "lowercase words joined by
  // underscores", and the id it builds from one has to be accepted everywhere
  // after it. The length check is new: red before (an overlong id was returned
  // and only refused, for every plugin at once, at the next start).
  const twoWords = fixture({ role: { ...ROLE, id: 'code_reviewer' } });
  const overlong = fixture({ role: { ...ROLE, id: 'r'.repeat(64 - 'notes-'.length + 1) } });
  try {
    for (const [f, check] of [
      [twoWords, (plugin) => assert.deepEqual(host.rolesFor(plugin).map(role => role.id), ['notes-code_reviewer'])],
      [overlong, (plugin) => assert.throws(() => host.rolesFor(plugin), (error) => {
        assert.equal(error.code, 'PLUGIN_ROLE_INVALID');
        assert.match(error.message, /longer than 64 characters/);
        return true;
      })]
    ]) {
      const grants = grantStore();
      const { identity, manifest } = host.inspect(f.pkg);
      grants.grant({ identity, manifest, capabilities: ['subprocess', 'roles'], actor: 'owner' });
      check(host.activate(f.pkg, { grants, stateRoot: f.stateRoot }));
    }
  } finally {
    fs.rmSync(twoWords.base, { recursive: true, force: true });
    fs.rmSync(overlong.base, { recursive: true, force: true });
  }
});

test('a plugin role that would take a built-in role\'s name is refused against its file', () => {
  // 1.0.50 release review F14: "coordinator" + "assistant" is the built-in
  // coordinator-assistant; the role library hid the plugin's role and the page
  // still counted it as added. Red before (rolesFor returned the id), green after.
  const f = fixture({ manifest: { ...MANIFEST, name: 'coordinator' }, role: { ...ROLE, id: 'assistant' } });
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess', 'roles'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    assert.throws(() => host.rolesFor(plugin), (error) => {
      assert.equal(error.code, 'PLUGIN_ROLE_INVALID');
      assert.match(error.message, /"coordinator-assistant", which is the name of a built-in role/);
      return true;
    });
    // And the page's read reports it rather than counting it.
    const read = host.contributions(f.pkg, { grants });
    assert.deepEqual(read.roles, []);
    assert.deepEqual(read.refused.map(entry => [entry.what, entry.code]), [['roles', 'PLUGIN_ROLE_INVALID']]);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a role file cannot carry a capability, a function policy or an authorization flag', () => {
  const f = fixture({ role: { ...ROLE, capabilities: { orgRoot: true } } });
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess', 'roles'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    assert.throws(() => host.rolesFor(plugin), (error) => {
      assert.equal(error.code, 'PLUGIN_ROLE_UNKNOWN_FIELD');
      assert.match(error.message, /a decision the product makes, not the plugin/);
      return true;
    });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('the skin becomes custom properties and nothing else', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess', 'skin'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    assert.deepEqual(host.skinFor(plugin), { '--plugin-accent': '#0b6', '--plugin-badge': 'Notes' });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('the effect floor rises with the grant, and describe() shows both numbers', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess', 'network'], actor: 'owner' });
    const described = host.describe(f.pkg, { grants });
    assert.equal(described.effectFloor, 'external-read');
    const [tool] = described.tools;
    assert.equal(tool.name, 'plugin.notes.reindex');
    assert.equal(tool.declaredEffect, 'local-read', 'what the plugin said');
    assert.equal(tool.effect, 'external-read', 'what it counts as');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a grant does not survive a changed byte', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess'], actor: 'owner' });
    assert.deepEqual(host.describe(f.pkg, { grants }).inForce, ['subprocess']);
    // One character in a script the owner reviewed.
    fs.appendFileSync(path.join(f.pkg, 'tools', 'reindex.js'), '// and now something else\n');
    const after = host.describe(f.pkg, { grants });
    assert.notEqual(after.sha256, identity.sha256);
    assert.deepEqual(after.inForce, [], 'the owner sees the grant screen again for code they have not read');
    assert.deepEqual(after.granted, []);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a package that cannot be read is reported in the listing, never quietly skipped', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    // A second package with a broken manifest.
    const broken = path.join(f.packagesDir, 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'plugin.json'), '{"schemaVersion":1,');
    const listing = host.listPackages({ root: f.packagesDir, grants });
    assert.deepEqual(listing.packages.map(entry => entry.name), ['notes']);
    assert.equal(listing.refused.length, 1);
    assert.equal(listing.refused[0].directory, 'broken');
    assert.equal(listing.refused[0].code, 'PLUGIN_MANIFEST_UNPARSEABLE');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('an empty or absent packages directory is an empty listing, not a crash', () => {
  const f = fixture();
  try {
    const listing = host.listPackages({ root: path.join(f.base, 'not-there'), grants: grantStore() });
    assert.deepEqual(listing.packages, []);
    assert.deepEqual(listing.refused, []);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a missing packages folder is created for the page, and one that cannot be read is not called empty', () => {
  // 1.0.50 release review F13: nothing created the folder the page names, and every
  // read error was drawn as "No plugins added". Red before (nothing created; a file
  // in the folder's place listed as empty), green after.
  const f = fixture();
  try {
    const missing = path.join(f.base, 'fresh', 'plugin-packages');
    assert.deepEqual(host.listPackages({ root: missing, grants: grantStore() }).packages, []);
    assert.equal(fs.existsSync(missing), false, 'a read without create writes nothing (engine start)');
    assert.deepEqual(host.listPackages({ root: missing, grants: grantStore(), create: true }).packages, []);
    assert.equal(fs.statSync(missing).isDirectory(), true, 'the page\'s read makes the folder it names');
    if (process.platform === 'linux') assert.equal(fs.statSync(missing).mode & 0o777, 0o700);
    const notAFolder = path.join(f.base, 'a-file');
    fs.writeFileSync(notAFolder, 'x');
    assert.throws(() => host.listPackages({ root: notAFolder, grants: grantStore(), create: true }), (error) => {
      assert.equal(error.code, 'PLUGIN_PACKAGES_UNREADABLE');
      assert.match(error.message, /could not be read \(ENOTDIR\)/);
      return true;
    });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('an interpreter is resolved to an absolute path this repository chose', () => {
  assert.equal(host.resolveInterpreter('node'), process.execPath);
  assert.throws(() => host.resolveInterpreter('bash'), (error) => {
    assert.equal(error.code, 'PLUGIN_INTERPRETER_UNKNOWN');
    return true;
  });
  // PATH is not searched, and a package's own binary is never a candidate.
  const missing = { ...fs, statSync: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } };
  assert.throws(() => host.resolveInterpreter('python3', { fsImpl: missing }), (error) => {
    assert.equal(error.code, 'PLUGIN_INTERPRETER_MISSING');
    assert.match(error.message, /does not search PATH|will not run one a package supplied/);
    return true;
  });
});

test('the tool pack name carries the WHOLE digest, so two versions are two packs', () => {
  // This name was first written with `.slice(0, 12)`, and the comment beside it
  // claimed that two versions registering both would be "a loud duplicate rather
  // than a silent last-one-wins". That was false: tool-pack-registry keeps packs in
  // a Map keyed by name, so agreeing names overwrite in silence, and 48 bits is a
  // birthday bound near 2^24. The test asserts the whole digest, because the claim
  // in that comment is the thing being relied on.
  const f = fixture();
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    const pack = host.toolPackFor(plugin);
    assert.equal(pack.name, `plugin-notes-${identity.sha256}`);
    assert.ok(!pack.name.includes(identity.sha256.slice(0, 12) + '-'),
      'no truncated form of the digest is what names the pack');
    assert.equal(pack.name.length, 'plugin-notes-'.length + 64);
    assert.match(pack.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'tool-pack-registry requires a lowercase-dashed name');
    assert.equal(typeof pack.definitions, 'function');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('two packages that differ anywhere produce two different pack names', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const before = host.inspect(f.pkg).identity.sha256;
    const first = host.toolPackFor({
      identity: { sha256: before }, manifest: { name: 'notes' }, capabilities: []
    }).name;
    fs.appendFileSync(path.join(f.pkg, 'tools', 'reindex.js'), '// one more byte\n');
    const after = host.inspect(f.pkg).identity.sha256;
    const second = host.toolPackFor({
      identity: { sha256: after }, manifest: { name: 'notes' }, capabilities: []
    }).name;
    assert.notEqual(first, second, 'a changed package must not reuse its pack name');
    // And the difference is not confined to a prefix that a truncation would lose.
    assert.notEqual(before.slice(0, 12) === after.slice(0, 12), null);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('activation refuses rather than advertising tools that cannot run', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess'], actor: 'owner' });
    const missing = {
      ...fs,
      statSync: (target) => {
        if (String(target).endsWith('node') || target === process.execPath) {
          throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        }
        return fs.statSync(target);
      }
    };
    assert.throws(() => host.activate(f.pkg, { grants, fsImpl: missing, stateRoot: f.stateRoot }), (error) => {
      assert.equal(error.code, 'PLUGIN_INTERPRETER_MISSING');
      return true;
    });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('settings rows and the restrictions floor need the settings grant', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    assert.deepEqual(host.settingsFor(plugin), [], 'settings not granted, so its rows do not exist');
    assert.equal(host.restrictionsFor(plugin), null);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a settings row id is namespaced under the plugin and carries no section', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess', 'settings'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    const rows = host.settingsFor(plugin);
    assert.deepEqual(rows.map(row => row.id),
      ['plugin.notes.reindex_on_open', 'plugin.notes.snapshot_copies']);
    // A plugin row is NOT an entry in config/settings-registry.json, so it carries
    // none of the fields that place a setting inside the product's own account of
    // itself. A plugin that could name a section could put its switch under a
    // heading the person already trusts.
    for (const row of rows) {
      for (const forbidden of ['section', 'depth', 'enforcedBy', 'derivedFrom']) {
        assert.equal(Object.hasOwn(row, forbidden), false, `${forbidden} must not reach a plugin row`);
      }
    }
    assert.deepEqual(rows[1].options, ['One', 'Two', 'Three']);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a row must state its capabilities and its risks, separately', () => {
  for (const drop of ['capabilities', 'risks']) {
    const rows = JSON.parse(JSON.stringify(ROWS));
    delete rows.rows[0][drop];
    const f = fixture({ rows });
    const grants = grantStore();
    try {
      const { identity, manifest } = host.inspect(f.pkg);
      grants.grant({ identity, manifest, capabilities: ['subprocess', 'settings'], actor: 'owner' });
      const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
      assert.throws(() => host.settingsFor(plugin), (error) => {
        assert.equal(error.code, 'PLUGIN_SETTING_INVALID');
        assert.match(error.message, /Saying there is none is allowed; leaving it out is not/);
        return true;
      }, `omitting ${drop} must be refused`);
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  }
});

test('a row cannot place itself in the product\'s own settings sections', () => {
  const rows = JSON.parse(JSON.stringify(ROWS));
  rows.rows[0].section = 'A';
  const f = fixture({ rows });
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess', 'settings'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    assert.throws(() => host.settingsFor(plugin), (error) => {
      assert.equal(error.code, 'PLUGIN_SETTING_UNKNOWN_FIELD');
      assert.match(error.message, /under a heading the person already trusts/);
      return true;
    });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a select whose default is not one of its own options is refused', () => {
  const rows = JSON.parse(JSON.stringify(ROWS));
  rows.rows[1].default = 'Four';
  const f = fixture({ rows });
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess', 'settings'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    assert.throws(() => host.settingsFor(plugin), (error) => {
      assert.equal(error.code, 'PLUGIN_SETTING_INVALID');
      assert.match(error.message, /not one of its own options/);
      return true;
    });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a restrictions file may only narrow: no tool surface, no egress allowlist', () => {
  const restrictions = {
    ...RESTRICTIONS,
    toolSurface: { mode: 'deny-by-default', admit: ['notes.*', 'shell.run'] },
    egress: { alwaysAdmit: ['github.com'] }
  };
  const f = fixture({ restrictions });
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess', 'settings'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    assert.throws(() => host.restrictionsFor(plugin), (error) => {
      assert.equal(error.code, 'PLUGIN_RESTRICTION_UNKNOWN_FIELD');
      assert.match(error.message, /never by a file the plugin ships/);
      return true;
    });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('the restrictions floor is read back as the plugin\'s own hard blocks', () => {
  const f = fixture();
  const grants = grantStore();
  try {
    const { identity, manifest } = host.inspect(f.pkg);
    grants.grant({ identity, manifest, capabilities: ['subprocess', 'settings'], actor: 'owner' });
    const plugin = host.activate(f.pkg, { grants, stateRoot: f.stateRoot });
    const floor = host.restrictionsFor(plugin);
    assert.equal(floor.hardBlocks.length, 1);
    assert.equal(floor.hardBlocks[0].rule, 'No note is deleted without asking');
    assert.deepEqual(floor.requiresHumanApproval, ['Any deletion of a note']);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('no module in the plugin host loads code from a plugin package', () => {
  // THE INVARIANT THIS WHOLE DESIGN RESTS ON, asserted mechanically rather than
  // left to review: nothing under src/lib/plugin-host/ calls require() or import()
  // on anything but a relative sibling or a node builtin. In particular there is
  // no computed specifier -- the shape that would let a path a plugin controls
  // become a module in this process.
  const directory = path.join(__dirname, '..', 'src', 'lib', 'plugin-host');
  const offenders = [];
  let specifiers = 0;
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.js'))) {
    // Comments are stripped first: these modules argue about require() in prose,
    // and a scanner that reads its own documentation as code finds six loads that
    // do not exist and misses the one that would matter.
    const source = fs.readFileSync(path.join(directory, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ')
      .replace(/([^:'"\\])\/\/.*$/gm, '$1');
    for (const match of source.matchAll(/(?:^|[^\w.$])(require|import)\s*\(([^)]*)\)/g)) {
      specifiers += 1;
      const argument = match[2].trim();
      const literal = /^'([^']*)'$/.exec(argument) || /^"([^"]*)"$/.exec(argument);
      if (!literal) { offenders.push(`${file}: ${match[1]}() with a computed specifier: ${argument || '(empty)'}`); continue; }
      const specifier = literal[1];
      if (!(specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'))) {
        offenders.push(`${file}: ${specifier} is neither a builtin nor a module of this repository`);
      }
      if (/plugin-packages|[/\\]plugins[/\\]/.test(specifier)) {
        offenders.push(`${file}: ${specifier} reaches plugin data`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a plugin host must never require() a path a plugin controls');
  // A scan that found nothing to check would pass for the wrong reason.
  assert.ok(specifiers >= 8, `expected to have inspected the real require() calls, saw ${specifiers}`);
});

test('a plugin tool is refused at the Full Remote Access tier even when the reviewed binding names it', () => {
  // MEASURED BEFORE THE FIX: with a granted plugin's tools written into a reviewed FRA
  // binding, assertToolAllowed ADMITTED them at the Manifest tier. That is remote reach
  // to local script execution -- the one thing classifying `plugin.*` as unconfinable is
  // meant to prevent. The Guarded lane already refused them by effect, so only the Full
  // Remote Access lane was open.
  //
  // The cause was the shape of the fence, not an oversight: ALWAYS_BLOCKED_NAMESPACES
  // held exactly one entry and the `plugin` namespace is younger than that list, so it
  // was admitted by silence. A name list could never have fixed it either --
  // REQUIRED_EXCLUDED_TOOLS enumerates tools one at a time, and plugin tool names come
  // from whatever the owner installed.
  const tier = require('../src/lib/permission-tier-policy');
  const fra = require('../src/lib/fra-capability-manifest');

  const names = ['plugin.notes.read_index', 'plugin.notes.push_index'];
  const binding = { allowedToolNames: names, allowedToolNamesDigest: fra.toolNameDigest(names) };
  for (const name of names) {
    assert.throws(
      () => tier.assertToolAllowed({ name, effect: 'local-write', approvalEligible: true },
        { tier: 'manifest', origin: 'remote', manifest: binding }),
      (error) => {
        assert.equal(error.code, 'PERMISSION_MANIFEST_EXCLUSION_REFUSED');
        return true;
      },
      `${name} must not be reachable over Full Remote Access`);
  }
  assert.ok(fra.ALWAYS_BLOCKED_NAMESPACES.has('plugin'),
    'one set is read by both the tier check and the manifest builder');
  // host.exec is refused by name for the same reason a plugin tool now is: it runs
  // whatever it is handed. Kept adjacent to say these are one policy, not two.
  assert.ok(fra.REQUIRED_EXCLUDED_TOOLS.has('host.exec'));
});

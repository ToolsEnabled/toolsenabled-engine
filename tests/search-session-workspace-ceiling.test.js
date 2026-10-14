'use strict';

// 1.0.50 review L5: search.query AND search.status RESPECT THE SESSION'S
// NARROWED WORKSPACE CEILING.
//
// search.query without `root` answered from every root recorded on this
// computer, because the handler was registered context-free and never saw the
// owner host's narrowed `workspaceRoots`. A circle bound to one client folder
// got snippets and absolute paths from another indexed folder, and
// search.status listed every indexed root. This exercises the real search
// module and SQLite index, and drives executeTool() so the registry wiring is
// on trial too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('./lib/isolated-environment').activate('search-session-workspace-ceiling');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'search-session-ceiling-'));
process.env.TOOLSENABLED_SEARCH_DB = path.join(scratch, 'index.sqlite');
const registry = require('../src/lib/tool-registry');
const audit = require('../src/lib/audit');
const originalRoots = registry.confinedWorkspaceRoots;
const originalRecord = audit.record;
audit.record = () => {};
const acme = path.join(scratch, 'clients-acme');
const personal = path.join(scratch, 'personal');
fs.mkdirSync(acme);
fs.mkdirSync(personal);
fs.writeFileSync(path.join(acme, 'notes.md'), 'quarterly orchid sunlight plan for the acme client, synthetic');
fs.writeFileSync(path.join(personal, 'diary.md'), 'private orchid sunlight diary entry, synthetic');
// Both folders are recorded workspace roots on this computer.
registry.confinedWorkspaceRoots = () => [acme, personal];
const search = require('../src/lib/search');

test.after(() => {
  search.close();
  registry.confinedWorkspaceRoots = originalRoots;
  audit.record = originalRecord;
  fs.rmSync(scratch, { recursive: true, force: true });
});

test.before(async () => {
  await search.indexPath({ root: acme, embedder: 'lexical' });
  await search.indexPath({ root: personal, embedder: 'lexical' });
});

test('premise: an unscoped caller with no session ceiling sees both indexed roots', async () => {
  const all = await search.query({ query: 'orchid sunlight', k: 10 });
  assert.equal(all.matches.length, 2);
  const status = await search.status();
  assert.deepEqual(status.roots.map(row => row.root).sort(), [acme, personal].sort());
});

test('a session narrowed to one root sees only that root, with or without `root`', async () => {
  const scoped = await search.query({ query: 'orchid sunlight', k: 10 }, { workspaceRoots: [acme] });
  assert.deepEqual(scoped.matches.map(row => row.path), [path.join(acme, 'notes.md')]);
  await assert.rejects(search.query({ query: 'orchid sunlight', root: personal }, { workspaceRoots: [acme] }),
    { code: 'SEARCH_ROOT_OUTSIDE_ROOT' });
  const none = await search.query({ query: 'orchid sunlight', k: 10 }, { workspaceRoots: [] });
  assert.deepEqual(none.matches, [], 'a session with no workspace roots sees nothing');
  const status = await search.status({ workspaceRoots: [acme] });
  assert.deepEqual(status.roots.map(row => row.root), [acme], 'search.status lists only the session\'s roots');
  assert.equal(status.files, 1);
  assert.equal(JSON.stringify(status).includes(personal), false);
});

test('executeTool hands the owner host\'s narrowed roots to both search tools', async () => {
  const CONFINED = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
  const context = { permissionSession: CONFINED, workspaceRoots: [acme] };
  const scoped = await registry.executeTool('search.query', { query: 'orchid sunlight', k: 10 }, context);
  assert.deepEqual(scoped.matches.map(row => row.path), [path.join(acme, 'notes.md')],
    'search.query must be called with the session context, not (args) alone');
  const status = await registry.executeTool('search.status', {}, context);
  assert.deepEqual(status.roots.map(row => row.root), [acme]);
});

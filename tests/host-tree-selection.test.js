'use strict';
require('./lib/isolated-environment').activate('host-tree-selection');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const store = require('../src/lib/openshell-tree-store');
const cli = require('../bin/toolsenabled-host');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tree-select-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actor = { agentId: 'host-owner', actor: null, displayName: 'Chosen lead name' };
  function put(key, identity = actor) {
    const folder = path.join(root, store.TREE_FOLDER, key);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const document = { v: 1, treeKey: key, root: identity, counter: 7,
      nodes: [{ nodeId: 'worker-7', state: 'stopped', turn: 'idle', threadId: 'thread-history',
        brief: 'Keep this assignment.', model: 'chosen-model', role: 'observer',
        lastTurn: { status: 'completed', text: 'Keep this report.' }, pending: { effort: 'high' } }],
      inbox: [{ text: 'Existing report.', deliveredAt: null }], updatedAt: '2026-10-01T00:00:00.000Z' };
    const file = path.join(folder, 'tree.json');
    fs.writeFileSync(file, JSON.stringify(document) + '\n', { mode: 0o600 });
    return { folder, file, document };
  }
  return { root, actor, put, take: key => store.acquireTree({
    stateRoot: root, baseKey: 'host-owner', root: { ...actor, displayName: 'Lead' }, preferredKey: key }) };
}

test('explicit same-root stopped tree is chosen over earlier free trees without rewriting history or actor', t => {
  const f = fixture(t);
  const early = f.put('host-owner');
  const selected = f.put('host-owner-3');
  const before = fs.readFileSync(selected.file, 'utf8');
  const tree = f.take('host-owner-3');
  assert.equal(tree.treeKey, 'host-owner-3');
  assert.deepEqual(tree.document, selected.document);
  assert.equal(tree.document.root.actor, null);
  assert.equal(tree.document.root.displayName, 'Chosen lead name');
  assert.equal(fs.readFileSync(selected.file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(early.folder, 'owner.json')), false);
  assert.throws(() => f.take('host-owner-3'), { code: 'OPENSHELL_TREE_BUSY' });
  tree.release();
  assert.equal(fs.readFileSync(selected.file, 'utf8'), before);
});

test('invalid family, wrong recorded root and missing tree refuse without allocating fallback', t => {
  const f = fixture(t);
  f.put('host-owner');
  for (const key of ['codex', 'codex-3', '../host-owner', 'host-owner-1', 'host-owner-33', '', 'host-owner-03']) {
    assert.throws(() => f.take(key), { code: 'OPENSHELL_TREE_KEY_INVALID' });
  }
  assert.throws(() => f.take('host-owner-3'), { code: 'OPENSHELL_TREE_NOT_FOUND' });
  const foreign = f.put('host-owner-3', { agentId: 'codex', actor: 'codex' });
  const before = fs.readFileSync(foreign.file, 'utf8');
  assert.throws(() => f.take('host-owner-3'), { code: 'OPENSHELL_TREE_ROOT_MISMATCH' });
  assert.equal(fs.readFileSync(foreign.file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(foreign.folder, 'owner.json')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.root, store.TREE_FOLDER)).sort(), ['host-owner', 'host-owner-3']);
});

test('explicit corrupt record and alias refuse, preserving bytes and no set-aside replacement', t => {
  const f = fixture(t);
  const selected = f.put('host-owner-3');
  fs.writeFileSync(selected.file, '{"truncated":');
  assert.throws(() => f.take('host-owner-3'), { code: 'OPENSHELL_TREE_UNREADABLE' });
  assert.equal(fs.readFileSync(selected.file, 'utf8'), '{"truncated":');
  assert.deepEqual(fs.readdirSync(selected.folder), ['tree.json']);
  fs.symlinkSync(selected.folder, path.join(f.root, store.TREE_FOLDER, 'host-owner-4'));
  assert.throws(() => f.take('host-owner-4'), { code: 'OPENSHELL_TREE_PATH_INVALID' });
});

test('a real other-process owner makes explicit selection busy, then the exact stopped tree can be selected', async t => {
  const f = fixture(t);
  const selected = f.put('host-owner-3');
  const code = "const store=require(process.argv[1]); const tree=store.acquireTree(JSON.parse(process.argv[2])); process.stdout.write('ready\\n'); process.stdin.once('data',()=>{tree.release();process.exit(0);});";
  const child = spawn(process.execPath, ['-e', code, require.resolve('../src/lib/openshell-tree-store'), JSON.stringify({
    stateRoot: f.root, baseKey: 'host-owner', root: f.actor, preferredKey: 'host-owner-3',
  })], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const ready = await once(child.stdout, 'data');
  assert.match(ready[0].toString(), /ready/);
  const before = fs.readFileSync(selected.file, 'utf8');
  assert.throws(() => f.take('host-owner-3'), { code: 'OPENSHELL_TREE_BUSY' });
  assert.equal(fs.readFileSync(selected.file, 'utf8'), before);
  child.stdin.write('release');
  await once(child, 'exit');
  const resumed = f.take('host-owner-3');
  assert.equal(resumed.document.nodes[0].threadId, 'thread-history');
  resumed.release();
});

test('automatic allocation remains the default; CLI selection never invents an actor', t => {
  const f = fixture(t);
  f.put('host-owner'); f.put('host-owner-3');
  const automatic = store.acquireTree({ stateRoot: f.root, baseKey: 'host-owner', root: f.actor });
  assert.equal(automatic.treeKey, 'host-owner');
  automatic.release();
  const parsed = cli.parseArgs(['serve', '--state-root', f.root, '--tree-key', 'host-owner-3']);
  assert.equal(parsed.treeKey, 'host-owner-3');
  assert.equal(parsed.actor, undefined);
  assert.throws(() => cli.parseArgs(['status', '--tree-key', 'host-owner-3']), /only to serve/);
  assert.throws(() => cli.parseArgs(['serve', '--tree-key', 'host-owner-3', '--tree-key', 'host-owner']), /only one/);
});

test('host mode actually loads selected tree and preserves stopped node settings and root display name', async t => {
  const f = fixture(t);
  const stateRoot = path.join(f.root, 'host');
  const workers = path.join(stateRoot, 'workers');
  const folder = path.join(workers, store.TREE_FOLDER, 'host-owner-3');
  const old = f.put('host-owner-3');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.copyFileSync(old.file, path.join(folder, 'tree.json'));
  const mode = require('../src/lib/host-agent-mode').startHostAgentMode({
    config: { mode: 'host', workers: true, workspace: f.root, stateRoot },
    treeKey: 'host-owner-3', actor: undefined, listen: false, installTreeSpawnHost() {},
    env: { TOOLSENABLED_RUNTIME_MODE: 'host' },
    createLauncher: () => ({ start() { throw new Error('No worker was requested.'); } }),
  });
  t.after(() => mode.close());
  await mode.ready;
  assert.equal(mode.treeKey, 'host-owner-3');
  assert.equal(mode.context.agentId, 'host-owner');
  const record = JSON.parse(fs.readFileSync(path.join(folder, 'tree.json'), 'utf8'));
  assert.deepEqual(record.nodes, old.document.nodes);
  assert.equal(record.root.actor, null);
  assert.equal(record.root.displayName, 'Chosen lead name');
});

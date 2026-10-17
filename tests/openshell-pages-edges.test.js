'use strict';
/* The terminal pages inside a sandbox, asked for something that is not
 * there: each says so and exits with a failure, rather than printing an
 * empty page as if it had answered. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'toolsenabled-openshell.js');

function cli(home, args) {
  const env = { HOME: home, PATH: process.env.PATH, OPENSHELL_SANDBOX: '1' };
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
}

test('settings get names a setting that does not exist, or asks for one, and fails', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-pages-'));
  const unknown = cli(home, ['settings', 'get', 'audit.enabeld']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^There is no setting audit\.enabeld\./);
  const missing = cli(home, ['settings', 'get']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^Use: toolsenabled settings get <id>/);
  const noId = cli(home, ['settings', 'set']);
  assert.equal(noId.status, 1);
  assert.match(noId.stderr, /^Use: toolsenabled settings set <id> <value>/);
  const known = cli(home, ['settings', 'get', 'audit.enabled']);
  assert.equal(known.status, 0, known.stderr);
  assert.match(known.stdout, /audit\.enabled.*false/);
});

test('the tree page shows a waiting role or provider change in words', () => {
  const store = require('../src/lib/openshell-tree-store');
  const node = (nodeId, pending) => ({ nodeId, displayName: 'Worker 1', parentNodeId: null, provider: 'codex', model: 'gpt-5.6-luna', role: 'worker', state: 'stopped', turn: 'none', pending });
  const lines = store.formatTrees([{ treeKey: 'claude', live: false, owner: null, document: { root: { displayName: 'Claude Code', actor: 'claude' }, nodes: [
    node('openshell-node-1-a', { when: 'next-session', role: 'reviewer', surface: { names: ['memory.get', 'task.list'], requiresDirectUserAuthorization: false, withheld: [] } }),
    node('openshell-node-2-b', { provider: 'claude', tier: 'claude-opus', model: 'opus', effort: null, when: 'next-start' }),
  ], inbox: [] } }]).join('\n');
  assert.match(lines, /openshell-node-1-a .* pending when=next-session,role=reviewer,surface=\[memory.get\|task.list\]$/m);
  assert.match(lines, /openshell-node-2-b .* pending provider=claude,tier=claude-opus,model=opus,effort=,when=next-start$/m);
  assert.doesNotMatch(lines, /\[object Object\]|=null/);
});

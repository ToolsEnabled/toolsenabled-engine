'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('memory JSON lists and searches literal text without creating state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-memory-view-'));
  const run = (...args) => spawnSync(process.execPath,
    [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'memory', ...args],
    { env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root }, encoding: 'utf8' });
  try {
    const empty = run('--json');
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(JSON.parse(empty.stdout).schema, 'ai.toolsenabled/fleet-memory/v1');
    assert.deepEqual(fs.readdirSync(root), []);
    fs.mkdirSync(path.join(root, 'state'));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'state', 'toolsenabled.sqlite3'));
    db.exec('CREATE TABLE memory_entries (namespace TEXT, entry_key TEXT, value_json TEXT, note TEXT, tags_json TEXT, revision INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)');
    const insert = db.prepare('INSERT INTO memory_entries VALUES (?, ?, ?, ?, ?, 1, 1, ?)');
    insert.run('first', 'one', '{"text":"a%\u001b[31m"}', 'literal %', '["tag"]', 3);
    insert.run('second', 'two', '{"text":"plain"}', null, '[]', 4);
    insert.run('first', 'three', '{"text":"plain"}', 'literal %', '[]', 2);
    db.close();
    const page = JSON.parse(run('--json', '--namespace', 'first', '--query', '%').stdout);
    assert.equal(page.total, 2);
    assert.equal(page.records[0].key, 'one');
    assert.deepEqual(page.namespaces, [{ name: 'first', count: 2 }, { name: 'second', count: 1 }]);
    assert.notEqual(page.revision, JSON.parse(run('--json', '--namespace', 'second', '--query', '%').stdout).revision);
    assert.equal(JSON.parse(run('--json', '--query', '-missing').stdout).total, 0);
    assert.notEqual(run('--json', '--query', 'line\nbreak').status, 0);
    assert.equal(JSON.parse(run('--json', '--namespace', '--synthetic').stdout).total, 0);
    const first = run('--text', '--surface', 'codex-hook', '--width', '240', '--limit', '1',
      '--namespace', 'first', '--query', '%');
    assert.equal(first.status, 0, first.stderr);
    const next = first.stdout.trimEnd().split('\n').at(-1).replace(/^more: /, '');
    const continued = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'),
      'fleet-command', '--input', next, '--surface', 'codex-hook'], {
      env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root }, encoding: 'utf8'
    });
    assert.equal(continued.status, 0, continued.stderr);
    const after = JSON.parse(continued.stdout);
    assert.match(after.text, /first\/three/);
    assert.doesNotMatch(after.text, /second\/two/);
    const detail = JSON.parse(run('get', 'first', 'one', '--json').stdout);
    assert.equal(detail.records[0].valueText.includes('\u001b'), false);
    assert.equal(detail.records[0].valueTruncated, false);
    const stale = run('--json', '--revision', '0'.repeat(64));
    assert.notEqual(stale.status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Long-lived installations hold tens of MB of ordinary memory (one measured
// state DB is 29.8 MB). The per-read copy bound is 256 MiB, the inspector's
// maximum: a DB of exactly that size is read, one byte more is refused with
// its own message, and the hook says so instead of "changed, reload".
const STATE_VIEW_BOUND = 256 * 1024 * 1024;

test('state pane reads a real DB at the 256 MiB copy bound and refuses one byte more clearly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-large-state-'));
  const scratch = path.join(root, 'tmp');
  fs.mkdirSync(scratch);
  const entry = path.join(__dirname, '../bin/toolsenabled-openshell.js');
  const env = { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: path.join(root, 'fleet'), TMPDIR: scratch };
  const run = (...args) => spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 60000 });
  try {
    const file = path.join(root, 'fleet', 'state', 'toolsenabled.sqlite3');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE tasks (id TEXT, queue_name TEXT, task_type TEXT, status TEXT, attempt INTEGER,
      max_attempts INTEGER, lease_worker_label TEXT, lease_expires_at_ms INTEGER, checkpoint_revision INTEGER,
      checkpoint_json TEXT, error_code TEXT, error_message TEXT, created_at_ms INTEGER,
      updated_at_ms INTEGER, completed_at_ms INTEGER, available_at_ms INTEGER,
      cancel_requested_at_ms INTEGER, cancel_reason TEXT, body_json TEXT, result_json TEXT);
      CREATE TABLE memory_entries (namespace TEXT, entry_key TEXT, value_json TEXT, note TEXT,
      tags_json TEXT, revision INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER);`);
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('task-bound', 'fleet', 'review', 'queued', 0, 3, null, null, 0, null, null, null,
        1, 1, null, 1, null, null, '{"title":"Bound task","objective":"x"}', null);
    db.prepare('INSERT INTO memory_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('notes', 'bound', '{"text":"ordinary note"}', 'kept across sessions', '[]', 1, 1, 1);
    db.close();
    assert.equal(fs.existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size > 0, false, 'fixture must be checkpointed');
    // Real pages first, then a sparse tail: SQLite reads its own page count.
    fs.truncateSync(file, STATE_VIEW_BOUND);
    const tasks = run('tasks', '--json');
    assert.equal(tasks.status, 0, tasks.stderr);
    assert.ok(JSON.parse(tasks.stdout).records.some(row => row.title === 'Bound task'));
    const memory = run('memory', '--json');
    assert.equal(memory.status, 0, memory.stderr);
    assert.ok(JSON.parse(memory.stdout).records.some(row => row.namespace === 'notes' && row.key === 'bound'));
    assert.deepEqual(fs.readdirSync(scratch), [], 'the private view copy is removed');

    fs.truncateSync(file, STATE_VIEW_BOUND + 1);
    for (const args of [['tasks', '--json'], ['memory', '--json'], ['memory', '--text'], ['memory']]) {
      const refused = run(...args);
      assert.equal(refused.status, 1, args.join(' '));
      assert.match(refused.stderr, /Fleet state is too large to view/, args.join(' '));
      assert.match(refused.stderr, /256 MiB/, args.join(' '));
    }
    const hook = run('fleet-command', '--input', '/fleet/memory', '--surface', 'codex-hook', '--emit');
    assert.equal(hook.status, 0, hook.stderr);
    const shown = JSON.parse(hook.stdout);
    assert.equal(shown.decision, 'block');
    assert.match(shown.reason, /too large to view/);
    assert.doesNotMatch(shown.reason, /unavailable or changed|Reload the view/);
    assert.deepEqual(fs.readdirSync(scratch), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tasks JSON is an empty, read-only, versioned page before state exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tasks-view-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'tasks', '--json'], {
      env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout);
    assert.equal(page.schema, 'ai.toolsenabled/fleet-tasks/v1');
    assert.deepEqual(page.records, []);
    assert.equal(page.total, 0);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tasks filters before paging, sanitizes detail and rejects a changed revision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tasks-view-'));
  const dbDir = path.join(root, 'state');
  fs.mkdirSync(dbDir);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dbDir, 'toolsenabled.sqlite3'));
  db.exec(`CREATE TABLE tasks (id TEXT, queue_name TEXT, task_type TEXT, status TEXT, attempt INTEGER,
    max_attempts INTEGER, lease_worker_label TEXT, lease_expires_at_ms INTEGER, checkpoint_revision INTEGER,
    checkpoint_json TEXT, error_code TEXT, error_message TEXT, created_at_ms INTEGER,
    updated_at_ms INTEGER, completed_at_ms INTEGER, available_at_ms INTEGER,
    cancel_requested_at_ms INTEGER, cancel_reason TEXT, body_json TEXT, result_json TEXT);`);
  db.exec('CREATE TABLE task_checkpoints (task_id TEXT, revision INTEGER, checkpoint_json TEXT, created_at_ms INTEGER)');
  const insert = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, 1, 2, ?, ?, ?, ?, NULL, NULL, 1, ?, NULL, ?, ?, ?, ?, ?)');
  insert.run('task-done', 'fleet', 'x', 'succeeded', null, null, 0, null, 3, 1, null, null, '{"title":"Done"}', '{"summary":"complete"}');
  insert.run('task-open', 'fleet', 'x', 'running', 'worker\u001b[31m', 1, 1, '{"summary":"step\u001b[31m"}', 2, 1, 2, 'stop later', '{"title":"Open work"}', null);
  db.prepare('INSERT INTO task_checkpoints VALUES (?, ?, ?, ?)').run('task-open', 1, '{"summary":"step"}', 2);
  db.close();
  const before = fs.readdirSync(dbDir).sort();
  const run = (...args) => spawnSync(process.execPath,
    [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'tasks', ...args],
    { env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root }, encoding: 'utf8' });
  try {
    const first = run('--json', '--limit', '1');
    assert.equal(first.status, 0, first.stderr);
    const page = JSON.parse(first.stdout);
    assert.equal(page.total, 1);
    assert.equal(page.records[0].id, 'task-open');
    assert.equal(page.records[0].status, 'uncertain');
    assert.equal(page.records[0].title, 'Open work');
    assert.equal(page.records[0].cancellation.reason, 'stop later');
    assert.equal(page.records[0].claimant.includes('\u001b'), false);
    assert.equal(page.nextOffset, null);
    const detail = JSON.parse(run('get', 'task-open', '--json').stdout);
    assert.equal(detail.records[0].checkpoint.includes('\u001b'), false);
    assert.equal(detail.records[0].checkpoints.length, 1);
    assert.equal(detail.records[0].payloadText.includes('Open work'), true);
    const changed = new DatabaseSync(path.join(dbDir, 'toolsenabled.sqlite3'));
    changed.prepare('UPDATE task_checkpoints SET checkpoint_json = ? WHERE task_id = ?').run('{"summary":"changed history"}', 'task-open');
    changed.close();
    const staleHistory = run('get', 'task-open', '--json', '--revision', detail.revision);
    assert.notEqual(staleHistory.status, 0, 'changed checkpoint history accepted a pinned detail revision');
    assert.equal(JSON.parse(run('get', 'task-done', '--json').stdout).records[0].resultText.includes('complete'), true);
    assert.equal(JSON.parse(run('--json', '--all').stdout).total, 2);
    const stale = run('--json', '--revision', '0'.repeat(64));
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /changed/i);
    assert.deepEqual(fs.readdirSync(dbDir).sort(), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('shared pane text redacts provider-shaped credentials', () => {
  const secret = ['sk-', 'A'.repeat(24)].join('');
  assert.equal(require('../src/lib/fleet-read-view').bounded(`report ${secret}`).text,
    '[redacted credential-shaped text]');
});

test('selected state path rejects symlinked ancestors before reading', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-view-symlink-'));
  try {
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(root, 'alias'));
    assert.throws(() => require('../src/lib/fleet-read-view').assertDirectPath(path.join(root, 'alias', 'state', 'toolsenabled.sqlite3')),
      /link|ancestor/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

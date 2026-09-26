'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const CHILD = path.join(__dirname, 'fixtures', 'elevation-shared-writes-child.js');
const roots = [];

function temporary(label) {
  // A real host.write must stay inside the installation owner's profile;
  // Linux /tmp does not meet that contract. This checkout is already owned.
  const root = fs.mkdtempSync(path.join(process.platform === 'win32' ? path.dirname(__dirname) : os.homedir(), `.settings-proof-${label}-`));
  roots.push(root);
  return root;
}

function writeSettings(file, { durationMinutes, survivesRestart, concurrentSharedWrites = false }) {
  const values = {
    'capability.elevation_duration': durationMinutes,
    'capability.elevation_survives_restart': survivesRestart,
    'fleet.concurrent_shared_writes': concurrentSharedWrites
  };
  const provenance = Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user', atMs: Date.now(), directive: null }]));
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 1, updatedAtMs: Date.now(), values, provenance }), 'utf8');
}

function environment(root, settings, extra = {}) {
  return {
    ...process.env,
    TOOLSENABLED_STATE_PATH: path.join(root, 'state.sqlite3'),
    TOOLSENABLED_STATE_ROOT: path.join(root, 'product-user-data', 'capability'),
    TOOLSENABLED_SETTINGS_PATH: settings,
    ...extra
  };
}

function child(mode, env) {
  const result = spawnSync(process.execPath, [CHILD, mode], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  const parsed = line ? JSON.parse(line) : null;
  return { ...result, parsed };
}

const only = process.env.PROOF_ONLY || 'all';
const selected = name => only === 'all' || only === name;

if (selected('expiry')) test('temporary capability grant expires through real profile authorization after the configured interval', async () => {
  const root = temporary('expiry');
  const settings = path.join(root, 'settings.json');
  writeSettings(settings, { durationMinutes: 0.02, survivesRestart: true });
  const base = environment(root, settings, { PROOF_PROFILE_ID: 'expiry.proof', PROOF_TASK_KEY: 'expiry-proof-task' });
  const created = child('create-authorize', base);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.parsed.status, 'active');
  assert.equal(created.parsed.before.ok, true);
  assert.match(created.parsed.before.requestHash, /^[a-f0-9]{64}$/i);
  assert.equal(created.parsed.expiresAtMs - created.parsed.compiledAtMs, 1200,
    'the configured 0.02 minute interval must remain exact');
  // The census observed the separate "before" process start after the entire
  // 1.2s lease had expired. Only the first authorization shares the creating
  // process; the expired read below still crosses a real process restart.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, created.parsed.expiresAtMs - Date.now() + 10)));
  const after = child('authorize', { ...base, PROOF_TASK_ID: created.parsed.taskId, PROOF_REQUEST_ID: 'expiry-after-00001' });
  assert.equal(after.status, 3, after.stdout);
  assert.match(after.stderr, /CAPABILITY_MANIFEST_EXPIRED/);
});

if (selected('restart')) test('temporary capability restart policy preserves ON and revokes OFF across actual process restarts', () => {
  for (const survivesRestart of [true, false]) {
    const root = temporary(survivesRestart ? 'restart-on' : 'restart-off');
    const settings = path.join(root, 'settings.json');
    writeSettings(settings, { durationMinutes: 1, survivesRestart });
    const env = environment(root, settings, {
      PROOF_PROFILE_ID: survivesRestart ? 'restart.on.proof' : 'restart.off.proof',
      PROOF_TASK_KEY: survivesRestart ? 'restart-on-task' : 'restart-off-task'
    });
    const created = child('create', env);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.parsed.status, 'active');
    const restarted = child('inspect', env);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(restarted.parsed.status, survivesRestart ? 'active' : 'revoked');
  }
});

if (selected('shared')) test('two concurrent whole-file writers name and refuse the second writer when protection is OFF', async () => {
  const root = temporary('shared-write');
  const settings = path.join(root, 'settings.json');
  writeSettings(settings, { durationMinutes: 1, survivesRestart: false, concurrentSharedWrites: false });
  const target = path.join(root, 'shared-target.txt');
  const releaseFile = path.join(root, 'release-first-writer');
  const base = environment(root, settings, { PROOF_TARGET: target });
  const first = spawn(process.execPath, [CHILD, 'write'], {
    cwd: path.join(__dirname, '..'), env: { ...base, PROOF_CONTENT: 'first', PROOF_RELEASE_FILE: releaseFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let firstOut = '';
  let firstErr = '';
  // Retain the exit observation before any await: a completed writer must
  // never leave this test waiting for an event that has already happened.
  const firstExit = new Promise(resolve => {
    first.once('exit', (code, signal) => resolve({ code, signal }));
    first.once('error', error => resolve({ error }));
  });
  first.stdout.setEncoding('utf8');
  first.stderr.setEncoding('utf8');
  first.stdout.on('data', chunk => { firstOut += chunk; });
  first.stderr.on('data', chunk => { firstErr += chunk; });
  try {
    await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`first writer never held the lock: ${firstErr}`)), 20_000);
    first.stdout.on('data', () => {
      if (firstOut.includes('WRITE_LOCK_HELD')) { clearTimeout(timeout); resolve(); }
    });
    first.once('exit', code => {
      if (!firstOut.includes('WRITE_LOCK_HELD')) { clearTimeout(timeout); reject(new Error(`first writer exited ${code}: ${firstErr}`)); }
    });
    });
    // Hold the first writer until the competing process has answered. A fixed
    // 1.2s pause previously expired during slow-machine startup of the second.
    const second = child('write', { ...base, PROOF_CONTENT: 'second', PROOF_HOLD_MS: '0' });
    assert.equal(second.status, 3, second.stdout);
    assert.match(second.stderr, /SHARED_WRITE_CONFLICT/);
  } finally {
    fs.writeFileSync(releaseFile, 'release', 'utf8');
    const exited = await firstExit;
    assert.deepEqual(exited, { code: 0, signal: null }, firstErr);
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'first');
  fs.rmSync(target, { force: true });
});

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

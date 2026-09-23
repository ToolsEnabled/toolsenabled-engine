'use strict';

const isolated = require('./lib/isolated-environment').activate('standing-protected');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { configure } = require('./lib/isolated-environment');
const { runIsolatedChild } = require('./lib/isolated-child');
const ROOT = path.resolve(__dirname, '..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// Copy the actual hook and its actual library tree into a disposable repo.
// ROOT-relative logs, authorizations, settings and queue fixtures must never
// resolve to the checkout or an owner's files. No handler/authority is mocked.
function fixture() {
  const home = fs.mkdtempSync(path.join(isolated.root, 'protected-write-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src', 'lib'), path.join(repo, 'src', 'lib'), { recursive: true });
  const hook = path.join(repo, 'tools', 'standing-orders-hook.js');
  fs.copyFileSync(path.join(ROOT, 'tools', 'standing-orders-hook.js'), hook);
  const hookHash = digest(fs.readFileSync(hook));
  const file = relative => path.join(repo, relative);
  const write = (relative, bytes) => {
    fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
    fs.writeFileSync(file(relative), bytes, { mode: 0o600 });
  };
  write('package.json', '{"name":"protected-write-fixture","private":true}\n');
  write('STANDING-ORDERS.md', '# Disposable standing orders\n');
  write('.claude/settings.json', '{"fixture":true}\n');
  write('notes.txt', 'ordinary fixture\n');
  const environment = {};
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    environment[key] = path.join(home, key.toLowerCase());
    fs.mkdirSync(environment[key], { recursive: true });
  }
  configure(path.join(home, 'runtime'), environment);
  environment.STANDING_ORDERS_HOOK_LEDGER_FILE = path.join(home, 'absent-fixture-ledger.json');
  // runIsolatedChild owns stdin's wrapper and every hook descendant. The
  // wrapper only supplies exact input bytes and propagates the real exit code.
  const driver = path.join(home, 'stdin.cjs');
  fs.writeFileSync(driver, `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, [process.argv[2]], {
  input: fs.readFileSync(process.argv[3]), encoding: 'utf8', windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.signal || !Number.isInteger(result.status)) {
  process.stderr.write('FIXTURE_HOOK_LAUNCH_FAILED\\n'); process.exitCode = 97;
} else process.exitCode = result.status;
`);
  const authDirectory = file('state/standing-orders-protected-write-authorizations');
  const markerFile = target => path.join(authDirectory, digest(target.toLowerCase()) + '.json');
  async function execute(args) {
    const result = await runIsolatedChild(process.execPath, args, {
      cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      timeout: 30000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, null, result.error?.message);
    assert.equal(result.signal ?? null, null);
    assert.equal(result.cleanupConfirmed, true, 'every real hook descendant must be closed');
    assert.equal(digest(fs.readFileSync(hook)), hookHash, 'the hook cannot rewrite its own control source');
    return result;
  }
  async function invoke(tool, relative, fields = {}, cwd = repo) {
    const target = file(relative);
    const before = fs.readFileSync(target);
    const tool_input = { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: target, ...fields };
    const input = path.join(home, crypto.randomUUID() + '.json');
    fs.writeFileSync(input, JSON.stringify({ tool_name: tool, tool_input, cwd }), { mode: 0o600 });
    const result = await execute([driver, hook, input]);
    assert.deepEqual(fs.readFileSync(target), before, 'a PreToolUse decision must not apply the requested write');
    return result;
  }
  async function authorize(target) {
    return execute([hook, 'authorize-protected-write', '--path', target, '--reason', 'Disposable contract maintenance']);
  }
  function marker(target) { return JSON.parse(fs.readFileSync(markerFile(target), 'utf8')); }
  function putMarker(target, value) {
    fs.mkdirSync(authDirectory, { recursive: true });
    fs.writeFileSync(markerFile(target), JSON.stringify(value), { mode: 0o600 });
  }
  function log() {
    const logFile = file('logs/standing-orders-hook.log');
    return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  }
  return { home, repo, file, write, invoke, authorize, marker, markerFile, putMarker, log,
    close() { fs.rmSync(home, { recursive: true, force: true }); } };
}

function allowed(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}
function denied(result, target) {
  assert.equal(result.status, 2, 'the actual native hook must block before the caller writes');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^STANDING-ORDERS\.md Class SYNC, rule 7:/);
  assert.ok(result.stderr.includes(target));
}
function authorized(result, target) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `Protected write authorized once for ${target}; expires in five minutes.\n`);
}

test('actual native Edit, Write and NotebookEdit distinguish protected targets from ordinary files', async () => {
  const f = fixture();
  try {
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      denied(await f.invoke(tool, 'package.json', { old_string: 'fixture', new_string: 'changed', content: 'changed', new_source: 'changed' }), 'package.json');
      allowed(await f.invoke(tool, 'notes.txt', { old_string: 'ordinary', new_string: 'changed', content: 'changed', new_source: 'changed' }));
    }
    allowed(await f.invoke('Read', 'package.json'));
    assert.equal(f.log().filter(row => row.decision === 'block').length, 3);
    assert.equal(f.log().some(row => row.decision === 'fail-open'), false);
  } finally { f.close(); }
});

test('native path classification uses canonical protected identity through an alternate directory', async () => {
  const f = fixture();
  try {
    const alias = path.join(f.home, 'repo-alias');
    fs.symlinkSync(f.repo, alias, 'junction');
    denied(await f.invoke('Edit', 'package.json', { file_path: path.join(alias, 'package.json') }), 'package.json');
    fs.mkdirSync(f.file('nested'));
    denied(await f.invoke('NotebookEdit', 'package.json', { notebook_path: '../package.json' }, f.file('nested')), 'package.json');
    assert.equal(f.log().some(row => row.decision === 'fail-open'), false);
  } finally { f.close(); }
});

test('real native authorization is target-bound, hash-bound and consumed once', async () => {
  const f = fixture();
  try {
    authorized(await f.authorize('package.json'), 'package.json');
    const initial = f.marker('package.json');
    assert.equal(initial.schemaVersion, 1);
    assert.equal(initial.target, 'package.json');
    assert.equal(initial.expectedSha256, digest(fs.readFileSync(f.file('package.json'))));
    assert.equal(initial.expiresAtMs - initial.createdAtMs, 300000);
    denied(await f.invoke('Edit', 'STANDING-ORDERS.md'), 'STANDING-ORDERS.md');
    assert.deepEqual(f.marker('package.json'), initial, 'another target cannot consume this permission');
    allowed(await f.invoke('Edit', 'package.json'));
    assert.equal(fs.existsSync(f.markerFile('package.json')), false);
    denied(await f.invoke('Write', 'package.json'), 'package.json');

    authorized(await f.authorize('package.json'), 'package.json');
    const concurrent = await Promise.all([f.invoke('Edit', 'package.json'), f.invoke('Write', 'package.json')]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), [0, 2], 'one real marker cannot authorize two concurrent hook processes');
    for (const result of concurrent) {
      if (result.status === 0) allowed(result);
      else denied(result, 'package.json');
    }
    assert.equal(fs.existsSync(f.markerFile('package.json')), false);

    authorized(await f.authorize('package.json'), 'package.json');
    fs.appendFileSync(f.file('package.json'), ' ');
    denied(await f.invoke('NotebookEdit', 'package.json'), 'package.json');
    assert.equal(fs.existsSync(f.markerFile('package.json')), false, 'stale authority must be discarded');
    const decisions = f.log().map(row => row.decision);
    assert.equal(decisions.filter(value => value === 'allow-authorized-once').length, 2);
    assert.ok(decisions.includes('discard-stale-authorization'));
    assert.equal(decisions.includes('fail-open'), false);
  } finally { f.close(); }
});

test('malformed, expired and mismatched authorization markers cannot permit a protected native write', async () => {
  const f = fixture();
  try {
    for (const change of [
      marker => ({ ...marker, target: 'standing-orders.md' }),
      marker => ({ ...marker, schemaVersion: 2 }),
      marker => ({ ...marker, createdAtMs: 1, expiresAtMs: 2 }),
      marker => ({ ...marker, expiresAtMs: marker.createdAtMs + 300001 }),
    ]) {
      authorized(await f.authorize('package.json'), 'package.json');
      f.putMarker('package.json', change(f.marker('package.json')));
      denied(await f.invoke('Write', 'package.json'), 'package.json');
      assert.equal(fs.existsSync(f.markerFile('package.json')), false);
    }
    assert.equal(f.log().filter(row => row.decision === 'discard-invalid-authorization').length, 4);
    assert.equal(f.log().some(row => row.decision === 'fail-open'), false);
  } finally { f.close(); }
});

test('guard controls refuse both the authorization CLI and an otherwise valid synthetic marker', async () => {
  const f = fixture();
  try {
    authorized(await f.authorize('package.json'), 'package.json');
    const template = f.marker('package.json');
    for (const control of ['.claude/settings.json', 'tools/standing-orders-hook.js']) {
      const refusal = await f.authorize(control);
      assert.equal(refusal.status, 2);
      assert.equal(refusal.stdout, '');
      assert.match(refusal.stderr, /guard control files have no native Edit\/Write authorization escape/);
      assert.equal(fs.existsSync(f.markerFile(control)), false);
      f.putMarker(control, { ...template, target: control, expectedSha256: digest(fs.readFileSync(f.file(control))) });
      for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
        const result = await f.invoke(tool, control);
        denied(result, control);
        assert.match(result.stderr, /guard itself.*no escape/);
      }
      assert.equal(fs.existsSync(f.markerFile(control)), true, 'self-protection precedes generic marker consumption');
    }
    assert.equal(f.log().filter(row => row.decision === 'block-self-protection').length, 6);
    assert.equal(f.log().some(row => row.decision === 'fail-open'), false);
  } finally { f.close(); }
});

test('BUILD-QUEUE permits only a receipt-first structural close through native Edit', async () => {
  const f = fixture();
  try {
    const phase = '## Q1 — Fixture phase\n**Status:** OPEN\nKeep this fixture instruction until its receipt exists.\n\n';
    const next = '## Q2 — Retained phase\n**Status:** OPEN\nUnrelated fixture instructions.\n\n';
    const before = '# Fixture build queue\n\n' + phase + next + '## Completed\n';
    const receipt = '- **Q1: Fixture phase:** completed in this disposable contract.\n';
    f.write('BUILD-QUEUE.md', before);
    denied(await f.invoke('Edit', 'BUILD-QUEUE.md', { old_string: phase, new_string: '' }), 'BUILD-QUEUE.md');
    denied(await f.invoke('Write', 'BUILD-QUEUE.md', { content: before + receipt }), 'BUILD-QUEUE.md');
    denied(await f.invoke('NotebookEdit', 'BUILD-QUEUE.md', { new_source: before + receipt }), 'BUILD-QUEUE.md');
    const generic = await f.authorize('BUILD-QUEUE.md');
    assert.equal(generic.status, 2);
    assert.match(generic.stderr, /BUILD-QUEUE\.md has no generic escape/);

    allowed(await f.invoke('Edit', 'BUILD-QUEUE.md', { old_string: '## Completed\n', new_string: '## Completed\n' + receipt }));
    // The hook never applies the edit: simulate only the approved native write
    // against this disposable queue before requesting the second decision.
    f.write('BUILD-QUEUE.md', before + receipt);
    denied(await f.invoke('Edit', 'BUILD-QUEUE.md', { old_string: '## Q1 — Fixture phase\n**Status:** OPEN\n', new_string: '' }), 'BUILD-QUEUE.md');
    denied(await f.invoke('Edit', 'BUILD-QUEUE.md', { old_string: phase + next, new_string: '' }), 'BUILD-QUEUE.md');
    denied(await f.invoke('Edit', 'BUILD-QUEUE.md', { old_string: '**Status:** OPEN', new_string: '**Status:** INVALID', replace_all: true }), 'BUILD-QUEUE.md');
    allowed(await f.invoke('Edit', 'BUILD-QUEUE.md', { old_string: phase, new_string: '' }));
    f.write('BUILD-QUEUE.md', (before + receipt).replace(phase, ''));
    assert.ok(fs.readFileSync(f.file('BUILD-QUEUE.md'), 'utf8').includes(next + '## Completed\n' + receipt));
    assert.equal(f.log().filter(row => row.decision === 'allow-build-queue-close').length, 2);
    assert.equal(f.log().some(row => row.decision === 'fail-open'), false);
  } finally { f.close(); }
});

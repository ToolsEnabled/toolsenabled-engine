'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadSettings } = require('../src/lib/settings');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-reset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  const env = { ...process.env, TOOLSENABLED_SETTINGS_PATH: file, TOOLSENABLED_INSTALLER: '1' };
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../tools/settings-set.js'), ...args], { env, encoding: 'utf8' });
  return { file, env, run };
}

test('the public CLI restores unconfigured model defaults and preserves unrelated choices', t => {
  const f = fixture(t);
  for (const [id, value] of [['model.endpoint', 'http://127.0.0.1:4827'], ['model.name', 'qwen2.5:0.5b'], ['model.local_context_tokens', '512']]) {
    const result = f.run(id, value, '--source', 'installer');
    assert.equal(result.status, 0, result.stderr);
  }
  const original = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  for (const id of ['model.endpoint', 'model.name']) {
    const result = f.run('--reset', id, '--source', 'installer');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /source\s+default/);
    const settings = loadSettings({ env: f.env });
    assert.equal(settings.values[id], '');
    assert.equal(settings.provenance[id].source, 'default');
    assert.equal(settings.rejected.some(row => row.id === id), false);
  }
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(saved.revision, original.revision + 2);
  for (const id of ['model.endpoint', 'model.name']) {
    assert.equal(Object.hasOwn(saved.values, id), false);
    assert.equal(Object.hasOwn(saved.provenance, id), false);
  }
  assert.equal(saved.values['model.local_context_tokens'], 512);
  assert.deepEqual(saved.provenance['model.local_context_tokens'], original.provenance['model.local_context_tokens']);
  assert.notEqual(f.run('model.endpoint', '', '--source', 'installer').status, 0, 'an empty configured address remains invalid');
});

test('reset retains human-channel and machine/vault read-only fences without mutating state', t => {
  const f = fixture(t);
  assert.equal(f.run('model.endpoint', 'http://127.0.0.1:4827', '--source', 'installer').status, 0);
  const before = fs.readFileSync(f.file);
  for (const args of [
    ['--reset', 'model.endpoint'],
    ['--reset', 'capability.tier', '--source', 'installer'],
    ['--reset', 'model.api_key', '--source', 'installer'],
    ['--reset', 'model.endpoint', 'extra', '--source', 'installer'],
    ['--reset', 'no.such.setting', '--source', 'installer']
  ]) {
    assert.notEqual(f.run(...args).status, 0, args.join(' '));
    assert.deepEqual(fs.readFileSync(f.file), before);
  }
  delete f.env.TOOLSENABLED_INSTALLER;
  assert.notEqual(f.run('--reset', 'model.endpoint', '--source', 'installer').status, 0);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('reset is discoverable and refuses malformed settings rather than replacing them', t => {
  const f = fixture(t);
  assert.match(f.run('--help').stdout, /--reset <id>/);
  assert.match(f.run('--list', 'model.endpoint').stdout, /--reset <id>/);
  fs.writeFileSync(f.file, '{owned malformed fixture');
  const result = f.run('--reset', 'model.endpoint', '--source', 'installer');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{owned malformed fixture');
});

test('reset of either API compatibility name removes both overrides', t => {
  const f = fixture(t);
  for (const id of ['agent.agent_api', 'agent.tool_mode']) {
    const changed = f.run('agent.agent_api', 'Enabled', '--source', 'installer');
    assert.equal(changed.status, 0, changed.stderr);
    const reset = f.run('--reset', id, '--source', 'installer');
    assert.equal(reset.status, 0, reset.stderr);
    const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    for (const alias of ['agent.agent_api', 'agent.tool_mode']) {
      assert.equal(Object.hasOwn(saved.values, alias), false);
      assert.equal(Object.hasOwn(saved.provenance, alias), false);
    }
    const settings = loadSettings({ env: f.env });
    assert.equal(settings.values['agent.agent_api'], 'Only');
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('status JSON reports a bounded read-only health snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-status-view-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'status', '--json'], {
      env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout);
    assert.equal(page.schema, 'ai.toolsenabled/fleet-status/v1');
    assert.equal(page.runtime.mode, 'openshell');
    assert.equal(page.mcp.connected, null);
    assert.equal(page.health.state, 'not-initialized');
    assert.equal(typeof page.safety.killSwitch.active, 'boolean');
    assert.ok(page.providers.detected);
    assert.equal(typeof page.sandbox.advisor, 'string');
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('every OpenShell status rendering stays local and leaves installed state untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-status-local-'));
  const marker = path.join(root, 'network-attempt');
  const preload = path.join(root, 'deny-network.cjs');
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(stateRoot);
  fs.writeFileSync(preload, `globalThis.fetch = () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'fetch'); throw new Error('NETWORK_ATTEMPTED'); };`);
  const before = fs.readdirSync(stateRoot);
  try {
    for (const flags of [[], ['--text'], ['--json'], ['--denials']]) {
      const result = spawnSync(process.execPath, ['--require', preload,
        path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'status', ...flags], {
        env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: stateRoot }, encoding: 'utf8'
      });
      assert.equal(result.status, 0, `${flags.join(' ')}: ${result.stderr}`);
      assert.equal(fs.existsSync(marker), false, `${flags.join(' ')} attempted a network request`);
      assert.deepEqual(fs.readdirSync(stateRoot), before, `${flags.join(' ')} changed installed state`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('every human and JSON OpenShell view avoids network and state writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-views-local-'));
  const stateRoot = path.join(root, 'state');
  const marker = path.join(root, 'network-attempt');
  const preload = path.join(root, 'deny-network.cjs');
  fs.mkdirSync(stateRoot);
  fs.writeFileSync(preload, [
    "const fs=require('node:fs');",
    `const mark=()=>{fs.writeFileSync(${JSON.stringify(marker)},'network'); throw new Error('NETWORK_ATTEMPTED');};`,
    'globalThis.fetch=mark;',
    "require('node:net').connect=mark;",
    "require('node:http').request=mark;",
    "require('node:https').request=mark;"
  ].join('\n'));
  const before = fs.readdirSync(stateRoot);
  try {
    for (const command of ['ledger', 'tasks', 'memory', 'audit', 'settings', 'status']) {
      for (const flag of ['', '--json', '--text']) {
        const result = spawnSync(process.execPath, ['--require', preload,
          path.join(__dirname, '../bin/toolsenabled-openshell.js'), command, ...(flag ? [flag] : [])], {
          env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: stateRoot }, encoding: 'utf8'
        });
        assert.equal(result.status, 0, `${command} ${flag}: ${result.stderr}`);
        assert.equal(fs.existsSync(marker), false, `${command} ${flag} attempted network`);
        assert.deepEqual(fs.readdirSync(stateRoot), before, `${command} ${flag} changed state`);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('status shows configured worker limits and scrubbed model endpoints', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-status-providers-'));
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    '[model_providers.demo]',
    'name = "Demo"',
    'base_url = "https://person:secret@models.example.test/v1?token=secret"',
    'wire_api = "responses"',
    'model = "demo-model"',
    ''
  ].join('\n'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'status', '--json'], {
      env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root,
        CODEX_HOME: codexHome, TOOLSENABLED_OPENSHELL_PROVIDERS: 'claude,codex',
        TOOLSENABLED_OPENSHELL_MAX_TIER: 'standard' }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout);
    assert.deepEqual(page.providers.configured, ['claude', 'codex']);
    assert.equal(page.providers.maxTier, 'standard');
    assert.equal(page.providers.modelEndpoints[0].origin, 'https://models.example.test');
    assert.doesNotMatch(result.stdout, /person|secret|token=/);
    const human = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'status', '--text'], {
      env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root,
        CODEX_HOME: codexHome, TOOLSENABLED_OPENSHELL_PROVIDERS: 'claude,codex',
        TOOLSENABLED_OPENSHELL_MAX_TIER: 'standard' }, encoding: 'utf8'
    });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Agent providers\s+claude, codex/);
    assert.match(human.stdout, /Max worker tier\s+standard/);
    assert.match(human.stdout, /Model endpoints\s+demo \(models.example.test\)/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('status --denials offers the full read-only denial view', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-status-denials-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'status', '--denials'], {
      env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ToolsEnabled Fleet — Recent denials/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('one denial cannot forge another terminal row', () => {
  const { formatDenials } = require('../src/lib/fleet-status-view');
  const lines = formatDenials({ sandbox: { advisor: 'on', denialsState: 'available',
    denials: [{ kind: 'network', host: 'example.test', reason: 'denied', explanation: 'Blocked\nApproved by owner' }] } });
  assert.equal(lines.filter(line => line.includes('Approved by owner')).length, 1);
  assert.ok(lines.every(line => !line.includes('\n')));
});

test('all five host plugin panes use a verified binding and leave state untouched', () => {
  const root = fs.mkdtempSync(path.join(os.userInfo().homedir, 'fleet-pane-host-'));
  const stateRoot = path.join(root, 'state');
  const workspace = path.join(root, 'project');
  try {
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.writeFileSync(path.join(stateRoot, 'host-mode.json'), JSON.stringify({
      schemaVersion: 1, mode: 'host', setupKind: 'plugin', workers: true, tier: 'standard',
      stateRoot, workspace, installRoot: path.join(__dirname, '..'), nodePath: process.execPath
    }), { mode: 0o600 });
    const before = fs.readdirSync(stateRoot).sort();
    const entry = path.join(__dirname, '../bin/toolsenabled-host.js');
    for (const [name, schema] of [['tasks', 'fleet-tasks'], ['memory', 'fleet-memory'],
      ['audit', 'fleet-audit'], ['settings', 'fleet-settings'], ['status', 'fleet-status']]) {
      const result = spawnSync(process.execPath, [entry, name, '--json', '--plugin', '--state-root', stateRoot], {
        env: { ...process.env, HOME: root, OPENSHELL_SANDBOX: '' }, encoding: 'utf8'
      });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).schema, `ai.toolsenabled/${schema}/v1`);
      assert.deepEqual(fs.readdirSync(stateRoot).sort(), before, `${name} created state`);
    }
    for (const flags of [[], ['--text']]) {
      const result = spawnSync(process.execPath, [entry, 'status', ...flags, '--plugin', '--state-root', stateRoot], {
        env: { ...process.env, HOME: root, OPENSHELL_SANDBOX: '' }, encoding: 'utf8'
      });
      assert.equal(result.status, 0, `human status: ${result.stderr}`);
      assert.deepEqual(fs.readdirSync(stateRoot).sort(), before, 'human status created state');
      assert.equal(fs.existsSync(path.join(root, '.toolsenabled-local-profile.json')), false);
    }
    for (const command of ['ledger', 'settings', 'tree']) {
      const result = spawnSync(process.execPath, [entry, command, '--plugin', '--state-root', stateRoot], {
        env: { ...process.env, HOME: root, OPENSHELL_SANDBOX: '' }, encoding: 'utf8'
      });
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      assert.deepEqual(fs.readdirSync(stateRoot).sort(), before, `${command} created state`);
      assert.equal(fs.existsSync(path.join(stateRoot, '.toolsenabled-local-profile.json')), false);
      assert.equal(fs.existsSync(path.join(stateRoot, 'services')), false);
    }
    assert.deepEqual(fs.readdirSync(stateRoot).sort(), before);
    const preview = spawnSync(process.execPath, [entry, 'ledger', '--json', '--plugin', '--state-root', stateRoot], {
      env: { ...process.env, HOME: root, OPENSHELL_SANDBOX: '' }, encoding: 'utf8'
    });
    assert.equal(preview.status, 0, preview.stderr);
    const action = spawnSync(process.execPath, [entry, 'ledger', 'apply', '--plugin', '--state-root', stateRoot], {
      env: { ...process.env, HOME: root, OPENSHELL_SANDBOX: '' },
      input: JSON.stringify({ action: 'add-task', words: 'Review host setup', expectedRevision: JSON.parse(preview.stdout).revision }), encoding: 'utf8'
    });
    assert.equal(action.status, 0, action.stderr);
    assert.equal(JSON.parse(action.stdout).schema, 'ai.toolsenabled/fleet-ledger-action/v1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('status refuses corrupt durability state instead of reporting healthy defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-status-corrupt-'));
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'audit-durability.json'), 'not-json');
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'status', '--json'], {
      env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root }, encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /durability file could not be read or parsed/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

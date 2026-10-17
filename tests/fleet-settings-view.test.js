'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('settings JSON shows effective values with provenance without creating state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-settings-view-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'settings', '--json'], {
      env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout);
    assert.equal(page.schema, 'ai.toolsenabled/fleet-settings/v1');
    assert.ok(page.records.length > 0);
    assert.equal(typeof page.records[0].provenance.source, 'string');
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('setting display masks URL userinfo and query values', () => {
  const { displayValue } = require('../src/lib/fleet-settings-view');
  assert.equal(displayValue('https://user:secret@example.test/?token=secret').text, '[redacted credential-shaped value]');
});

test('settings view rejects corrupt state and binds rejection changes to its revision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-settings-revision-'));
  const values = path.join(root, 'settings.json');
  const env = { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root,
    TOOLSENABLED_SETTINGS_PATH: values };
  const run = (...args) => spawnSync(process.execPath,
    [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'settings', '--json', ...args], { env, encoding: 'utf8' });
  try {
    fs.writeFileSync(values, JSON.stringify({ revision: 1, values: {}, provenance: {} }));
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const revision = JSON.parse(first.stdout).revision;
    fs.writeFileSync(values, JSON.stringify({ revision: 1, values: { 'unknown-fixture-setting': 'fixture' }, provenance: {} }));
    const stale = run('--revision', revision);
    assert.notEqual(stale.status, 0);
    fs.writeFileSync(values, 'not-json');
    const corrupt = run();
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr, /could not be read or parsed/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

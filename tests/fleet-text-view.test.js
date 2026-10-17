'use strict';
require('./lib/isolated-environment').activate('fleet-text-view');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin/toolsenabled-openshell.js');

test('read-only paging accepts --text and rejects a mixed JSON/text request', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-text-cli-'));
  try {
    const env = { ...process.env, TOOLSENABLED_STATE_ROOT: home };
    const good = spawnSync(process.execPath, [cli, 'tasks', '--text', '--offset', '0', '--limit', '2'], { env, encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /^Fleet · Tasks · /);
    const json = spawnSync(process.execPath, [cli, 'tasks', '--json', '--offset', '0', '--limit', '2'], { env, encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const snapshot = JSON.parse(json.stdout);
    const pinned = spawnSync(process.execPath, [cli, 'tasks', '--text', '--offset', '0', '--limit', '2',
      '--revision', snapshot.revision], { env, encoding: 'utf8' });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.match(pinned.stdout, new RegExp(`0 shown of ${snapshot.total}`));
    assert.match(pinned.stdout, new RegExp(`Snapshot ${snapshot.revision}`));
    const bad = spawnSync(process.execPath, [cli, 'tasks', '--json', '--text'], { env, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('same snapshot renders bounded plain text for every view and surface', () => {
  const { render } = require('../src/lib/fleet-text-view');
  for (const width of [60, 100, 160]) for (const name of ['ledger', 'tasks', 'memory', 'audit', 'settings', 'status']) {
    const record = name === 'ledger' ? { id: 'T1', status: 'open', title: 'bad\x1b]52;c;copy\x07\rname' }
      : name === 'tasks' ? { id: 't1', status: 'running', title: 'bad\x1b]52;c;copy\x07\rname' }
      : name === 'memory' ? { namespace: 'n', key: 'k', note: 'bad\x1b]52;c;copy\x07\rname' }
      : name === 'audit' ? { sequence: 1, action: 'test', eventId: 'e1', eventText: 'bad\x1b]52;c;copy\x07\rname' }
      : name === 'settings' ? { id: 's1', valueText: 'bad\x1b]52;c;copy\x07\rname', provenance: { source: 'default' } }
      : null;
    const page = { schema: `ai.toolsenabled/fleet-${name}/v1`, records: record ? [record] : [],
      total: 25, offset: 0, limit: 20, nextOffset: 20, revision: name === 'ledger' ? 4 : 'a'.repeat(64),
      setup: { state: 'configured', tier: 'standard', workspace: '/project' },
      runtime: { version: '1.8.0', mode: 'host', insideSandbox: false },
      health: { state: 'healthy', audit: 'healthy' },
      safety: { killSwitch: { active: false }, approvals: { enabled: false } },
      providers: { detected: {} }, sandbox: { advisor: 'off', networkRules: null, denials: [] },
      mcp: { connected: null }, agents: { enabled: true }, lastError: null };
    const result = render(name, page, { width, surface: 'codex-hook' });
    // An audit page without a full verification is always marked unverified.
    assert.match(result.text, new RegExp(`^Fleet · ${name[0].toUpperCase()}${name.slice(1)}${name === 'audit' ? ' \\(unverified\\)' : ''} · `));
    assert.ok(result.text.split('\n').every(line => [...line].length <= width), `${name}/${width}`);
    assert.doesNotMatch(result.text, /\x1b|\x07|\r/);
    assert.match(result.more, /^more: \/fleet\//);
    assert.match(result.more, /--revision/);
  }
});

test('hook status stays within twenty rows when denials are full', () => {
  const { render } = require('../src/lib/fleet-text-view');
  const page = { schema: 'ai.toolsenabled/fleet-status/v1', revision: 'a'.repeat(64),
    setup: { state: 'configured', tier: 'standard', workspace: '/project' },
    runtime: { version: '1.8.0', mode: 'host', insideSandbox: false },
    health: { state: 'healthy', audit: 'healthy' },
    safety: { killSwitch: { active: false }, approvals: { enabled: false } },
    providers: { detected: {} }, sandbox: { advisor: 'off', networkRules: null,
      denials: Array.from({ length: 5 }, (_, index) => ({ kind: 'network', host: `example${index}.invalid`, reason: 'refused' })) },
    mcp: { connected: null }, agents: { enabled: true }, lastError: null };
  const result = render('status', page, { surface: 'codex-hook' });
  assert.ok(result.text.split('\n').length <= 22); // title, at most 20 rows, snapshot
  assert.match(result.text, /Last error/);
});

test('narrow continuation retains every revision digit in displayed text', () => {
  const { render } = require('../src/lib/fleet-text-view');
  const revision = 'abcdef0123456789'.repeat(4);
  const page = { schema: 'ai.toolsenabled/fleet-memory/v1', revision, records: [],
    total: 2, offset: 0, limit: 1, nextOffset: 1 };
  for (const width of [60, 100]) {
    const shown = render('memory', page, { width, surface: 'codex-hook' });
    assert.ok(shown.text.split('\n').every(item => [...item].length <= width));
    assert.match(shown.more, new RegExp(revision));
    assert.ok(shown.text.replace(/\n  /g, '').includes(revision), `revision lost at width ${width}`);
    assert.doesNotMatch(shown.text, /--revision [a-f0-9]*…/);
  }
});

test('continuations preserve memory selection, page size and all-task scope', () => {
  const { render } = require('../src/lib/fleet-text-view');
  const { match } = require('../src/lib/fleet-command-dispatch');
  const revision = '1234567890abcdef'.repeat(4);
  const memory = { schema: 'ai.toolsenabled/fleet-memory/v1', revision,
    records: [{ namespace: 'alpha', key: 'one', note: '' }], total: 2, offset: 0, limit: 1, nextOffset: 1,
    namespace: 'alpha beta', query: 'literal "quote" $HOME' };
  const hooked = render('memory', memory, { surface: 'codex-hook', width: 240 });
  const parsed = match(hooked.more.slice('more: '.length));
  assert.deepEqual(parsed.options, ['--limit', '1', '--namespace', 'alpha beta', '--query', 'literal "quote" $HOME',
    '--offset', '1', '--revision', revision]);
  const plain = render('memory', memory, { surface: 'plain', width: 240 });
  assert.match(plain.more, /--namespace 'alpha beta'/);
  assert.match(plain.more, /--query 'literal "quote" \$HOME'/);
  const tasks = { schema: 'ai.toolsenabled/fleet-tasks/v1', revision, records: [],
    total: 2, offset: 0, limit: 1, nextOffset: 1, view: 'all' };
  assert.match(render('tasks', tasks, { surface: 'codex-hook' }).more, /--all --offset 1/);
});

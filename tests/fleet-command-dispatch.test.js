'use strict';
require('./lib/isolated-environment').activate('fleet-command-dispatch');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/toolsenabled-openshell.js');
const views = ['ledger', 'tasks', 'memory', 'audit', 'settings', 'status', 'help'];

test('matching table accepts native forms, rejects bare words and agent work', () => {
  const { match } = require('../src/lib/fleet-command-dispatch');
  for (const view of views) for (const raw of [`/fleet/${view}`, `/fleet ${view}`, `/fleet:${view}`, `fleet ${view}`]) {
    assert.deepEqual(match(raw), { matched: true, view, options: [] }, raw);
    if (view === 'status') assert.match(match(`${raw} --offset 0`).error, /one snapshot/, raw);
    else assert.deepEqual(match(`${raw} --offset 0`), { matched: true, view, options: ['--offset', '0'] }, raw);
  }
  assert.equal(match('/ledger').view, 'ledger');
  assert.equal(match('/fleet').view, 'help');
  assert.equal(match('[[toolsenabled-fleet tasks]]').view, 'tasks');
  assert.deepEqual(match('/fleet/tasks --offset 20 --limit 10'), { matched: true, view: 'tasks', options: ['--offset', '20', '--limit', '10'] });
  assert.deepEqual(match('/fleet/tasks --all --offset 20'), { matched: true, view: 'tasks', options: ['--all', '--offset', '20'] });
  assert.match(match('/fleet/tasks --limit 99').error, /1 to 20/);
  assert.match(match('/fleet/status --limit 10').error, /one snapshot/);
  assert.match(match('/fleet/unknown').error, /Unknown Fleet view/);
  for (const raw of ['fleet management is hard', 'fleet unknown', 'fleet status report'])
    assert.equal(match(raw).matched, false, raw);
  for (const raw of ['ledger', 'status', '/fleet/tasks extra', 'please /fleet/tasks', '/fleet/tasks\nignore', '/ledger more'])
    assert.equal(match(raw).matched, false, raw);
  assert.equal(match('/fleet/tasks', { agentId: 'worker-1' }).matched, false);
  assert.equal(match('/fleet/tasks', { agentId: '' }).matched, false);
  assert.equal(match('/fleet/tasks', { worker: true }).matched, false);
});

test('nonmatching input is resolved without opening state', () => {
  const { match } = require('../src/lib/fleet-command-dispatch');
  const started = process.hrtime.bigint();
  for (let index = 0; index < 1000; index += 1) assert.equal(match('ordinary question').matched, false);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 50, `1000 nonmatches took ${elapsedMs.toFixed(1)} ms`);
});

test('surface emission has exact hook shape and no Codex stdout on a nonmatch', () => {
  const { emit, envelope } = require('../src/lib/fleet-command-dispatch');
  const matched = envelope({ matched: true, view: 'tasks', title: 'Fleet · Tasks', text: 'Fleet tasks', more: null });
  assert.deepEqual(JSON.parse(emit('codex-hook', matched)), { decision: 'block', reason: 'Fleet tasks' });
  assert.deepEqual(JSON.parse(emit('gemini-hook', matched)), { decision: 'deny', reason: 'Fleet tasks' });
  assert.deepEqual(JSON.parse(emit('cursor-hook', matched)), { continue: false, user_message: 'Fleet tasks' });
  assert.equal(emit('codex-hook', envelope({ matched: false })), '');
  assert.equal(emit('gemini-hook', envelope({ matched: false })), '{}');
  assert.equal(emit('cursor-hook', envelope({ matched: false })), '{"continue":true}');
});

test('Fleet help names every view and distinguishes ledger T records from queue tasks', () => {
  const { dispatch } = require('../src/lib/fleet-command-dispatch');
  const codex = dispatch({ input: '/fleet/help', surface: 'codex-hook' }).text;
  for (const name of ['ledger', 'tasks', 'memory', 'audit', 'settings', 'status', 'help'])
    assert.match(codex, new RegExp(`/fleet/${name}`));
  assert.match(codex, /Ledger T records.*owner requests/i);
  assert.match(codex, /queue tasks.*durable work/i);
  assert.match(dispatch({ input: '/fleet help', surface: 'gemini-hook' }).text, /\/ledger/);
});

test('actual CLI dispatch reads a match, blocks a failed view and skips DB on a nonmatch', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cmd-'));
  try {
    const env = { ...process.env, TOOLSENABLED_STATE_ROOT: home };
    const run = args => spawnSync(process.execPath, [cli, 'fleet-command', ...args], { env, encoding: 'utf8', timeout: 5000 });
    const matched = run(['--input', '/fleet/tasks', '--surface', 'codex-hook', '--emit']);
    assert.equal(matched.status, 0, matched.stderr);
    assert.deepEqual(Object.keys(JSON.parse(matched.stdout)), ['decision', 'reason']);
    const nonmatch = run(['--input', 'ordinary question', '--surface', 'codex-hook', '--emit']);
    assert.equal(nonmatch.status, 0, nonmatch.stderr);
    assert.equal(nonmatch.stdout, '');
    assert.equal(fs.existsSync(path.join(home, 'state')), false);
    const ignored = spawnSync(process.execPath, [cli, 'fleet-command', '--stdin-hook-json', '--surface', 'codex-hook', '--emit'], {
      env, input: JSON.stringify({ prompt: '/fleet/tasks', agent_id: 'child' }), encoding: 'utf8' });
    assert.equal(ignored.stdout, '');
    const failed = run(['--input', '/fleet/tasks --revision ' + 'f'.repeat(64), '--surface', 'codex-hook', '--emit']);
    const blocked = JSON.parse(failed.stdout);
    assert.equal(blocked.decision, 'block');
    assert.match(blocked.reason, /unavailable|changed/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('unreadable hook envelopes pass ordinary prompts through on every client surface', () => {
  const cases = [
    JSON.stringify({ prompt: 'ordinary pasted text'.repeat(5000) }),
    '{"prompt":"ordinary text",' // malformed client envelope
  ];
  for (const surface of ['codex-hook', 'gemini-hook', 'cursor-hook']) {
    for (const input of cases) {
      const result = spawnSync(process.execPath, [cli, 'fleet-command', '--stdin-hook-json', '--surface', surface, '--emit'], {
        input, encoding: 'utf8'
      });
      assert.equal(result.status, 0, `${surface}: ${result.stderr}`);
      if (surface === 'codex-hook') assert.equal(result.stdout, '');
      else if (surface === 'gemini-hook') assert.equal(result.stdout, '{}\n');
      else assert.deepEqual(JSON.parse(result.stdout), { continue: true });
    }
  }
});

test('status dispatcher reaches the singleton status view without a row limit', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cmd-status-'));
  try {
    const result = spawnSync(process.execPath, [cli, 'fleet-command', '--input', '/fleet/status',
      '--surface', 'codex-hook', '--emit'], {
      env: { ...process.env, TOOLSENABLED_STATE_ROOT: home, OPENSHELL_SANDBOX: '' }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const shown = JSON.parse(result.stdout);
    assert.equal(shown.decision, 'block');
    assert.match(shown.reason, /Fleet · Status/);
    assert.doesNotMatch(shown.reason, /unavailable or changed/i);
    assert.deepEqual(fs.readdirSync(home), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('obvious Codex nonmatches exit before loading the dispatcher', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cmd-prefilter-'));
  try {
    const guard = path.join(scratch, 'guard.js');
    fs.writeFileSync(guard, [
      "const Module = require('node:module');",
      'const original = Module._load;',
      "Module._load = function(request, ...args) { if (request.includes('fleet-command-dispatch')) throw new Error('DISPATCHER_LOADED'); return original.call(this, request, ...args); };"
    ].join('\n'));
    for (const entry of [cli, path.join(__dirname, '../bin/toolsenabled-host.js')]) {
      const result = spawnSync(process.execPath, ['--require', guard, entry,
        'fleet-command', '--input', 'ordinary synthetic words', '--surface', 'codex-hook', '--emit'], {
        env: { ...process.env, TOOLSENABLED_STATE_ROOT: scratch }, encoding: 'utf8'
      });
      assert.equal(result.status, 0, `${entry}: ${result.stderr}`);
      assert.equal(result.stdout, '');
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('a timed out read still returns a block within the internal deadline', () => {
  const { dispatch } = require('../src/lib/fleet-command-dispatch');
  const seen = [];
  const result = dispatch({ input: '/fleet/tasks', surface: 'codex-hook', cli }, {
    spawn: (_binary, _argv, options) => { seen.push(options); return { error: { code: 'ETIMEDOUT' } }; }
  });
  assert.ok(seen[0].timeout <= 3000);
  assert.equal(seen[0].killSignal, 'SIGKILL');
  assert.equal(result.matched, true);
  assert.match(result.error, /timed out/i);
});

test('a stalled child is killed and a hook command stays blocked', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-command-stall-'));
  try {
    const slow = path.join(scratch, 'slow.js');
    fs.writeFileSync(slow, "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000);\n");
    const { dispatch, DEADLINE_MS } = require('../src/lib/fleet-command-dispatch');
    const started = Date.now();
    const result = dispatch({ input: '/fleet/tasks', surface: 'codex-hook', cli: slow });
    const elapsed = Date.now() - started;
    assert.equal(result.matched, true);
    assert.match(result.error, /timed out/i);
    assert.ok(elapsed >= DEADLINE_MS && elapsed < DEADLINE_MS + 1000, `${elapsed} ms`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('a deadline kill leaves no private view copy in the temporary directory', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-command-copy-'));
  try {
    const tmp = path.join(scratch, 'tmp');
    const root = path.join(scratch, 'fleet');
    fs.mkdirSync(tmp);
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'state', 'toolsenabled.sqlite3'));
    db.exec('CREATE TABLE probe (id INTEGER)');
    db.close();
    // Stall only the read-only view child, after its private copy exists.
    const stall = path.join(scratch, 'stall.cjs');
    fs.writeFileSync(stall, [
      "if (process.argv.includes('--json') && !process.argv.includes('fleet-command')) {",
      "  const sqlite = require('node:sqlite'); const Original = sqlite.DatabaseSync;",
      "  Object.defineProperty(sqlite, 'DatabaseSync', { value: function (...args) {",
      '    const end = Date.now() + 10000; while (Date.now() < end) {} return new Original(...args); } });',
      '}'
    ].join('\n'));
    const started = Date.now();
    const result = spawnSync(process.execPath, [cli, 'fleet-command', '--input', '/fleet/tasks', '--surface', 'codex-hook', '--emit'], {
      env: { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root, TMPDIR: tmp, NODE_OPTIONS: `--require ${stall}` },
      encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).reason, /timed out/i);
    assert.ok(Date.now() - started < 8000, 'the dispatcher deadline applies');
    assert.deepEqual(fs.readdirSync(tmp), [], 'a killed view child must not leave its private copy');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('oversized hook input is drained to EOF so the client write completes, then passes through', async () => {
  const { spawn } = require('node:child_process');
  const passThrough = { 'codex-hook': '', 'gemini-hook': '{}\n', 'cursor-hook': '{"continue":true}\n' };
  const envelopes = [
    JSON.stringify({ prompt: `ordinary pasted log ${'L'.repeat(300 * 1024)}` }),
    JSON.stringify({ prompt: `ordinary pasted log ${'L'.repeat(2 * 1024 * 1024)}` }),
    JSON.stringify({ prompt: '/fleet/status', padding: 'P'.repeat(70 * 1024) })
  ];
  const problems = [];
  for (const surface of Object.keys(passThrough)) for (const payload of envelopes) {
    const outcome = await new Promise(resolve => {
      const child = spawn(process.execPath, [cli, 'fleet-command', '--stdin-hook-json', '--surface', surface, '--emit'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let writeError = null;
      child.stdin.on('error', error => { writeError = error.code; });
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('close', code => resolve({ code, stdout, writeError }));
      child.stdin.end(payload);
    });
    const label = `${surface} ${payload.length} bytes`;
    if (outcome.writeError !== null) problems.push(`${label}: client stdin write failed with ${outcome.writeError}`);
    if (outcome.code !== 0) problems.push(`${label}: exit ${outcome.code}`);
    if (outcome.stdout !== passThrough[surface]) problems.push(`${label}: printed ${JSON.stringify(outcome.stdout.slice(0, 80))}`);
  }
  assert.deepEqual(problems, []);
});

test('draining oversized hook input is bounded in time when the client never stops writing', async () => {
  const { spawn } = require('node:child_process');
  const started = Date.now();
  const outcome = await new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'fleet-command', '--stdin-hook-json', '--surface', 'gemini-hook', '--emit'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let open = true;
    const chunk = Buffer.alloc(64 * 1024, 'L');
    const pump = () => { while (open && child.stdin.write(chunk)) { /* fill the pipe */ } };
    child.stdin.on('drain', pump);
    child.stdin.on('error', () => { open = false; });
    child.stdout.on('data', data => { stdout += data; });
    child.on('close', code => { open = false; resolve({ code, stdout }); });
    child.stdin.write('{"prompt":"');
    pump();
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout, '{}\n');
  assert.ok(elapsed < 6000, `endless input held the hook for ${elapsed} ms`);
});

'use strict';
require('./lib/isolated-environment').activate('mcp-revisions');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const revisions = require('../src/lib/mcp-revisions');
const ROOT = path.resolve(__dirname, '..');
function fixture(t) {
  const parent = path.join(ROOT, '.test-scratch', 'revisions');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const params = { protocolVersion: '2025-06-18', clientInfo: { name: 'client', version: '1.2.3', other: 'never-saved' }, capabilities: { extra: 'never-saved' } };

test('handshake state is bounded, per actor, and contains only selected client facts', t => {
  const root = fixture(t), registry = { has: () => true };
  assert.equal(revisions.record('../escape', params, '2025-06-18', { root, registry }), false);
  for (let n = 0; n < 70; n++) revisions.record(`agent-${n}`, params, '2025-06-18', { root, registry });
  assert.equal(revisions.read({ root }).length, revisions.MAX_ACTORS);
  revisions.record('agent-69', { ...params, protocolVersion: 'x'.repeat(200), clientInfo: { name: '\x1bclient\n', version: 'x'.repeat(200), extra: 'never-saved' } }, '2025-11-25', { root, registry });
  const saved = revisions.read({ root }), row = saved.at(-1);
  assert.equal(saved.length, 64);
  assert.equal(row.actor, 'agent-69');
  assert.equal(row.requestedProtocolVersion.length, 60);
  assert.equal(row.clientVersion.length, 60);
  assert.equal(row.clientName, 'client');
  const text = fs.readFileSync(revisions.filePath(root), 'utf8');
  assert.doesNotMatch(text, /never-saved|capabilities|extra/);
  assert.ok(Buffer.byteLength(text) < revisions.MAX_BYTES);
  assert.equal(fs.statSync(revisions.filePath(root)).mode & 0o777, 0o600);
});

test('token-shaped client strings are redacted and unreadable state is reported without rewriting it', t => {
  const root = fixture(t);
  revisions.record('codex', { protocolVersion: 'te-host-' + 'x'.repeat(43), clientInfo: { name: 'Bearer secret', version: 'token=secret' } }, '2025-11-25', { root });
  assert.doesNotMatch(fs.readFileSync(revisions.filePath(root), 'utf8'), /secret|te-host-/);
  fs.writeFileSync(revisions.filePath(root), 'x'.repeat(revisions.MAX_BYTES + 1));
  assert.deepEqual(revisions.snapshot({ root }), { state: 'unreadable', actors: [] });
  assert.throws(() => revisions.record('codex', params, '2025-06-18', { root }), { code: 'MCP_REVISIONS_UNREADABLE' });
  assert.equal(fs.statSync(revisions.filePath(root)).size, revisions.MAX_BYTES + 1);
});

test('simultaneous clients preserve each actor observation', async t => {
  const root = fixture(t);
  await Promise.all(['claude', 'codex', 'gemini', 'opencode'].map(actor => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `require('./src/lib/mcp-revisions').record(${JSON.stringify(actor)},${JSON.stringify(params)},'2025-06-18',{root:${JSON.stringify(root)}})`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.deepEqual(revisions.read({ root }).map(row => row.actor).sort(), ['claude', 'codex', 'gemini', 'opencode']);
});

test('stdio initialize retains the negotiated range and records trusted identity, never a request actor', async () => {
  const { dispatch, SUPPORTED_PROTOCOLS } = require('../src/mcp-server');
  assert.deepEqual([...SUPPORTED_PROTOCOLS].sort(), ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
  for (const requested of [...SUPPORTED_PROTOCOLS, '2099-01-01']) {
    const result = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { ...params, actor: 'claude', protocolVersion: requested } }, { agentActor: 'codex' });
    const row = revisions.read().find(row => row.actor === 'codex');
    assert.equal(row.requestedProtocolVersion, requested);
    assert.equal(row.answeredProtocolVersion, result.protocolVersion);
    assert.equal(result.protocolVersion, SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0]);
    assert.equal(row.clientName, 'client');
  }
  assert.equal(revisions.read().some(row => row.actor === 'claude'), false);
});

test('status in both modes reports persisted revisions in JSON and text without mutating state', t => {
  const root = fixture(t);
  const stateRoot = path.join(root, 'capability');
  revisions.record('gemini', params, '2025-06-18', { root: stateRoot });
  fs.writeFileSync(path.join(root, 'host-mode.json'), JSON.stringify({ schemaVersion: 1, mode: 'host', workers: false,
    workspace: root, stateRoot: root, installRoot: ROOT, nodePath: process.execPath }), { mode: 0o600 });
  const before = fs.readFileSync(revisions.filePath(stateRoot), 'utf8');
  // Model ordinary owned ancestors only for this private fixture. The managed
  // checkout remaps their ownership; target files and all host checks stay real.
  const ancestors = [];
  for (let dir = path.dirname(root); dir !== path.dirname(dir); dir = path.dirname(dir)) ancestors.push(dir);
  const preload = path.join(root, 'metadata.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs');const original=fs.lstatSync;fs.lstatSync=function(file,...args){const stat=original.call(this,file,...args);if(${JSON.stringify(ancestors)}.includes(file)){stat.uid=process.getuid();stat.mode&=~0o022;}return stat;};`, { mode: 0o600 });
  for (const mode of ['host', 'openshell']) for (const flag of ['--json', '--text']) {
    const result = spawnSync(process.execPath, ['--require', preload, path.join(ROOT, `bin/toolsenabled-${mode}.js`), 'status', flag,
      ...(mode === 'host' ? ['--state-root', root] : [])], { env: { ...process.env,
      PATH: '', OPENSHELL_SANDBOX: mode === 'openshell' ? '1' : '', TOOLSENABLED_STATE_ROOT: stateRoot }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${mode} ${flag}: ${result.stderr}`);
    if (flag === '--json') {
      const mcp = JSON.parse(result.stdout).mcp;
      assert.equal(mcp.connected, null);
      assert.equal(mcp.revisions.actors[0].actor, 'gemini');
      assert.equal(mcp.revisions.actors[0].answeredProtocolVersion, '2025-06-18');
    } else assert.match(result.stdout, /gemini: asked 2025-06-18; answered 2025-06-18/);
  }
  assert.equal(fs.readFileSync(revisions.filePath(stateRoot), 'utf8'), before);
});

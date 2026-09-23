'use strict';

const isolated = require('./lib/isolated-environment').activate('mcp-call-permission');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runIsolatedChild } = require('./lib/isolated-child');
const { configure } = require('./lib/isolated-environment');
const { ROOT } = require('../tools/mcp-call');

test('standalone CLI cannot borrow a caller-declared owner session or escalate its request', async () => {
  const scratch = path.join(ROOT, 'scratch');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(scratch, 'permission-contract-'));
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
    'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  configure(isolated.root, env);
  function assertMemoryAbsent() {
    const store = require('../src/lib/state-store').createStateStore({ file: env.TOOLSENABLED_STATE_PATH });
    try {
      assert.equal(store.getMemory({ namespace: 'fixture', key: 'permission-refusal' }), null,
        'a refused request must not mutate the actual isolated durable store');
    } finally { store.close(); }
  }
  const outputs = [];
  async function invoke(request, extraEnvironment = {}) {
    const input = path.join(directory, 'request.json');
    fs.writeFileSync(input, JSON.stringify(request), { mode: 0o600 });
    const name = `permission-contract-${randomUUID()}.json`;
    const output = path.join(ROOT, 'scratch', 'mcp-call-output', name);
    outputs.push(output);
    const result = await runIsolatedChild(process.execPath, [path.join(ROOT, 'tools', 'mcp-call.js'),
      '--input', path.relative(ROOT, input), '--output-name', name], {
      cwd: ROOT, env: { ...env, ...extraEnvironment }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, null, result.error?.message);
    assert.equal(result.signal ?? null, null);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.stderr, '');
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    return { status: result.status, summary: JSON.parse(lines[0]),
      raw: fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null };
  }
  try {
    const write = { tool: 'memory.set', arguments: { namespace: 'fixture', key: 'permission-refusal', value: 'never-written' } };
    assertMemoryAbsent();
    const absent = await invoke(write);
    assert.equal(absent.status, 1);
    assert.equal(absent.summary.failure.code, 'PERMISSION_CONFINED_EFFECT_REFUSED',
      'a fresh unconfigured instance must actually apply its read-only permission session');
    assertMemoryAbsent();

    const claimed = await invoke({ ...write, permissionSession: { origin: 'local', tier: 'full' } });
    assert.equal(claimed.status, 1);
    assert.deepEqual(claimed.summary, { ok: false, code: 'MCP_CALL_INPUT_SHAPE_INVALID' });
    assert.equal(claimed.raw, null, 'caller permission metadata must be refused before transport');
    assertMemoryAbsent();

    const status = { tool: 'system.kill_switch_status', arguments: {} };
    for (const binding of [
      { TOOLSENABLED_AGENT_ID: 'fixture-agent' },
      { TOOLSENABLED_AGENT_SESSION_CREDENTIAL: Buffer.alloc(32, 7).toString('base64url') },
    ]) {
      const named = await invoke(status, binding);
      assert.equal(named.status, 1);
      assert.equal(named.summary.code, 'MCP_CALL_TRANSPORT_CLOSED');
      assert.match(named.summary.stderrHint, /^REFUSING TO SERVE:/);
      assert.equal(named.raw, null, 'a bound session without its owner host cannot fall back to anonymous dispatch');
      assert.doesNotMatch(JSON.stringify(named.summary), /fixture-agent|BwcHBwcH/);
    }
    const anonymous = await invoke(status);
    assert.equal(anonymous.status, 0, 'the same harmless request remains usable for an unbound standalone caller');
    assert.equal(anonymous.summary.ok, true);
  } finally {
    for (const output of outputs) fs.rmSync(output, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

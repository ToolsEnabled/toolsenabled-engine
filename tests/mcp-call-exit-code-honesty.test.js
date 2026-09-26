'use strict';

const isolated = require('./lib/isolated-environment').activate('mcp-call-exit');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runIsolatedChild } = require('./lib/isolated-child');
const { configure } = require('./lib/isolated-environment');
const { ROOT } = require('../tools/mcp-call');

// Real CLI -> real owner proxy -> real stdio dispatcher. Only disposable
// requests/state are supplied; no replacement broker response or handler.
test('MCP CLI exit status agrees with success, protocol refusal and policy refusal', async () => {
  const scratch = path.join(ROOT, 'scratch');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(scratch, 'exit-contract-'));
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
    'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  configure(isolated.root, env);
  const outputs = [];
  async function invoke(request) {
    const input = path.join(directory, 'request.json');
    fs.writeFileSync(input, JSON.stringify(request), { mode: 0o600 });
    const name = `exit-contract-${randomUUID()}.json`;
    const output = path.join(ROOT, 'scratch', 'mcp-call-output', name);
    outputs.push(output);
    const result = await runIsolatedChild(process.execPath, [path.join(ROOT, 'tools', 'mcp-call.js'),
      '--input', path.relative(ROOT, input), '--output-name', name], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, null, result.error?.message);
    assert.equal(result.signal ?? null, null);
    assert.equal(result.cleanupConfirmed, true, 'all CLI/proxy descendants must be closed');
    assert.equal(result.stderr, '');
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, 'stdout is exactly one bounded public summary');
    return { status: result.status, summary: JSON.parse(lines[0]), raw: JSON.parse(fs.readFileSync(output, 'utf8')) };
  }
  try {
    const good = await invoke({ tool: 'system.kill_switch_status', arguments: {} });
    assert.equal(good.status, 0);
    assert.equal(good.summary.ok, true);
    assert.equal(good.summary.isError, false);
    assert.equal(good.raw.result.isError, undefined);
    assert.ok(Array.isArray(good.raw.result.content));
    assert.equal(good.raw.result.structuredContent.active, false);
    assert.equal(good.raw.result.structuredContent.path, env.TOOLSENABLED_KILLSWITCH_PATH);
    assert.deepEqual(JSON.parse(good.raw.result.content[0].text), good.raw.result.structuredContent);

    const rpc = await invoke({ tool: 'phantom.mcp_tool', arguments: {} });
    assert.equal(rpc.status, 1, 'a delivered JSON-RPC error must fail the CLI');
    assert.deepEqual(rpc.summary, { ok: false, tool: 'phantom.mcp_tool', code: -32602, error: 'MCP_RPC_ERROR' });
    assert.equal(rpc.raw.error.code, -32602);

    const denied = await invoke({ tool: 'memory.set', arguments: {
      namespace: 'fixture', key: 'cli-refusal', value: 'fixture-value-never-written',
    } });
    assert.equal(denied.status, 1, 'a delivered tool refusal must fail the CLI');
    assert.equal(denied.summary.ok, false);
    assert.equal(denied.summary.isError, true);
    assert.equal(denied.summary.failure.code, 'PERMISSION_CONFINED_EFFECT_REFUSED');
    assert.equal(denied.raw.result.isError, true);
    assert.equal(denied.raw.result.structuredContent.error.code, 'PERMISSION_CONFINED_EFFECT_REFUSED');
    assert.doesNotMatch(JSON.stringify(denied.summary), /fixture-value-never-written|cli-refusal/);
  } finally {
    for (const output of outputs) fs.rmSync(output, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

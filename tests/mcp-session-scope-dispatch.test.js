'use strict';
const { activate } = require('./lib/isolated-environment');
const isolated = activate('mcp-session-scope-dispatch');
const test = require('node:test');
const assert = require('node:assert/strict');
const mcp = require('../src/mcp-server');
const { createDispatchScheduler } = require('../src/lib/tool-dispatch-scheduler');

for (const agentApiMode of ['Only', 'Enabled']) test(`${agentApiMode}: MCP tool dispatch preserves an explicit empty authenticated workspace ceiling`, async () => {
  const responses = [];
  const recordPath = require.resolve('../src/lib/setup/machine-record');
  const original = require(recordPath);
  let fallbackReads = 0;
  require.cache[recordPath].exports = { ...original, readMachineRecord() {
    fallbackReads++; throw new Error('machine-root fallback must not run');
  } };
  try { await mcp.processMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'terraform.validate', arguments: { cwd: isolated.root } } },
  // Match the authenticated session context: its tool mode was captured before
  // dispatch. An unrelated settings/catalogue read is not a workspace fallback.
  value => responses.push(value), { agentActor: 'claude', agentApiMode,
    permissionSession: { origin: 'local', tier: 'confined', profile: 'workspace' }, workspaceRoots: [] });
  } finally { require.cache[recordPath].exports = original; }
  assert.equal(fallbackReads, 0, 'with the session API mode captured, the explicit empty ceiling must not fall back to machine-wide roots');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result?.isError, true);
  assert.match(JSON.stringify(responses[0]), /workspace|confined|boundary/i);
});

test('a request cannot replace the authenticated disabled tool mode', async () => {
  const responses = [];
  const recordPath = require.resolve('../src/lib/setup/machine-record');
  const original = require(recordPath);
  let fallbackReads = 0;
  require.cache[recordPath].exports = { ...original, readMachineRecord() {
    fallbackReads++; throw new Error('bound authority must not read ambient settings');
  } };
  try { await mcp.processMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'terraform.validate', agentApiMode: 'Enabled',
      toolMode: 'ToolsEnabled and native tools', arguments: { cwd: isolated.root } } },
  value => responses.push(value), { agentActor: 'claude', agentApiMode: 'Disabled',
    permissionSession: { origin: 'local', tier: 'confined', profile: 'workspace' }, workspaceRoots: [] });
  } finally { require.cache[recordPath].exports = original; }
  assert.equal(fallbackReads, 0);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result?.isError, true);
  assert.equal(responses[0].result.structuredContent.error.code, 'TOOL_API_DISABLED');
});

for (const mode of ['fast', 'strict']) test(`${mode}: actual scheduler revalidates scope only after queued write is admitted`, async () => {
  const scheduler = createDispatchScheduler({ mode: 'serial' });
  let release;
  const held = scheduler.run({ lane: 'scope', kind: 'write' }, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  let allowed = true; let checks = 0;
  const responses = [];
  const handle = mcp.createLineDispatcher({ parallelScheduler: scheduler, serialScheduler: scheduler, modeOf: () => mode });
  const pending = handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'host.exec', arguments: { command: 'NEVER_EXECUTE_THIS_SCOPE_TEST' } } }),
  value => responses.push(value), { agentActor: 'claude', permissionSession: { origin: 'local', tier: 'full' },
    resolveDispatchContext() {
      checks++;
      assert.equal(allowed, false);
      responses.push({ id: 2, error: { code: -32000, message: 'scope revoked before execution' } });
      return null;
    } }, 'scope');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 0, 'intake must not resolve authority intended for execution');
  allowed = false; release();
  await Promise.all([held, pending]);
  assert.equal(checks, 1); assert.equal(responses.length, 1);
  assert.equal(responses[0].error.message, 'scope revoked before execution');
});

'use strict';
require('./lib/isolated-environment').activate('host-worker-elicitation');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHostWorkerLauncher } = require('../src/lib/host-worker-session');
const { CodexAdapter, CODEX_CLI_VERSION } = require('../src/lib/agent-engine/codex-adapter');

// Ported from the Windows host line (639b479). A launcher without an
// interaction route keeps 1.9.0's answer: decline, counted in the completion
// (the tree host turns that count into the report's sentence).
test('real worker event path declines elicitation without a route and continues', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-input-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let receive, adapter;
  const events = [], writes = [];
  const env = { HOME: path.join(root, 'home'), PATH: '/usr/bin',
    TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1', TOOLSENABLED_TOOL_ALLOWLIST: 'task.list',
    TOOLSENABLED_STATE_ROOT: path.join(root, 'state/capability') };
  const launcher = createHostWorkerLauncher({ env, config: { mode: 'host', workers: true, stateRoot: path.join(root, 'state') },
    workspaceRoot: root, socketPath: path.join(root, 'socket'), checkNative: () => {}, agentApiMode: () => 'Enabled',
    startCodex: async options => {
      assert.equal(options.requestInput, undefined, 'workers must not install an automatic answer callback');
      adapter = new CodexAdapter({ codexVersion: CODEX_CLI_VERSION, transport: {
        onData(fn) { receive = fn; return () => {}; },
        write(line) {
          const p = JSON.parse(line); writes.push(p);
          if (p.method === 'initialize') reply({ id: p.id, result: { userAgent: 'offline' } });
          if (p.method === 'turn/start') reply({ id: p.id, result: { turn: { id: 'turn-1' } } });
        }
      } });
      adapter.onEvent(options.onEvent);
      await adapter.initialize();
      return { adapter, threadId: 'thread-1', close: () => adapter.close(), resolvedSandbox: { type: 'workspaceWrite' } };
    }
  });
  function reply(p) { receive(JSON.stringify(p) + '\n'); }
  const session = await launcher.start({ provider: 'codex', nodeId: 'worker-1', sessionId: 'session-1',
    nodeFolder: path.join(root, 'state/nodes/worker-1'), linkToken: 'synthetic-link', onEvent: e => events.push(e),
    serverEnv: { TOOLSENABLED_TOOL_ALLOWLIST: 'task.list' } });
  t.after(() => session.close());
  await adapter.sendTurn({ threadId: 'thread-1', text: 'fixture' });
  reply({ id: 'input', method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', turnId: 'turn-1',
    serverName: 'fixture', mode: 'form', message: 'Input', requestedSchema: { type: 'object', properties: {} } } });
  assert.deepEqual(writes.at(-1).result, { action: 'decline' });
  assert.equal(adapter.closed, null);
  reply({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(events.at(-1).status, 'completed');
  assert.deepEqual(events.at(-1).payload?.promptDeclined, { count: 1, from: ['fixture'] });
  assert.equal(writes.some(p => p.result?.decision === 'accept'), false);
});

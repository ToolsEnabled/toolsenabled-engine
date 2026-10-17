'use strict';
// A CLI signed in to several providers lists every model of each; one provider alone can offer several hundred.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');

async function start(t, count) {
  let listener;
  const emit = packet => listener?.(JSON.stringify(packet) + '\n');
  const ids = Array.from({ length: count }, (_, i) => `provider/model-${i}`);
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') emit({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      if (request.method === 'session/new') emit({ jsonrpc: '2.0', id: request.id, result: { sessionId: 's',
        models: { currentModelId: ids[0], availableModels: ids.map(modelId => ({ modelId, name: modelId })) },
        configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: ids[0], options: ids.map(value => ({ value, name: value })) }] } });
    }
  };
  const adapter = new AcpAdapter({ transport, defaultCwd: process.cwd() });
  t.after(() => adapter.close());
  await adapter.initialize();
  return adapter.startThread();
}

test('a session offering several hundred models starts', async t => {
  await start(t, 900);
});

test('a session offering more models than any CLI lists is still refused as out of bounds', async t => {
  await assert.rejects(start(t, 5000), { code: 'ACP_PROTOCOL_INVALID' });
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');
const tick = () => new Promise(resolve => setImmediate(resolve));
const modes = { currentModeId: 'ask', availableModes: [{ id: 'ask' }, { id: 'plan' }, { id: 'auto' }] };
const config = value => [{ id: 'reasoning_effort', category: 'thought_level', type: 'select',
  currentValue: value, options: [{ value: 'low' }, { value: 'high' }] }];
async function setup(t) {
  let listen;
  const sent = [];
  const emit = packet => listen?.(JSON.stringify(packet) + '\n');
  const reply = (request, result) => emit({ jsonrpc: '2.0', id: request.id, result });
  const adapter = new AcpAdapter({ defaultCwd: process.cwd(), transport: {
    onData(fn) { listen = fn; return () => { listen = null; }; },
    write(line) {
      const request = JSON.parse(line); sent.push(request);
      if (request.method === 'initialize') reply(request, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      if (request.method === 'session/new') reply(request, { sessionId: 's', modes,
        models: { currentModelId: 'a', availableModels: [{ modelId: 'a' }, { modelId: 'b' }] },
        configOptions: config('low') });
    }
  } });
  t.after(() => adapter.close());
  await adapter.initialize(); await adapter.startThread();
  return { adapter, sent, reply, notify(mode) {
    emit({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 's', update: { sessionUpdate: 'current_mode_update', currentModeId: mode } } });
  } };
}
test('a conflicting current notification after ACK but before continuation wins', async t => {
  const h = await setup(t);
  const pending = h.adapter.selectMode('s', 'plan');
  const refused = assert.rejects(pending, { code: 'ACP_MODE_SELECTION_UNCONFIRMED' });
  await tick();
  h.reply(h.sent.at(-1), {});
  h.notify('auto');
  await refused;
  assert.equal(h.adapter.getSessionModes('s').currentModeId, 'auto');
});
test('model ACK followed immediately by close must not return applied success', async t => {
  const h = await setup(t);
  const pending = h.adapter.selectModel('s', 'b');
  const outcome = pending.then(value => ({ value }), error => ({ code: error.code }));
  h.reply(h.sent.at(-1), {});
  h.adapter.close();
  assert.deepEqual(await outcome, { code: 'ACP_ADAPTER_CLOSED' });
  assert.equal(h.adapter.getSessionModels('s').currentModelId, 'a');
});
test('effort ACK followed immediately by close must not return applied success', async t => {
  const h = await setup(t);
  const pending = h.adapter.selectEffort('s', 'high');
  const outcome = pending.then(value => ({ value }), error => ({ code: error.code }));
  h.reply(h.sent.at(-1), { configOptions: config('high') });
  h.adapter.close();
  assert.deepEqual(await outcome, { code: 'ACP_ADAPTER_CLOSED' });
  assert.equal(h.adapter.getSessionConfigOptions('s')[0].currentValue, 'low');
});
test('mode and model mutations must not overlap on one session', async t => {
  const h = await setup(t);
  const mode = h.adapter.selectMode('s', 'plan');
  await tick();
  const modeRequest = h.sent.at(-1);
  const model = h.adapter.selectModel('s', 'b').then(value => ({ value }), error => ({ code: error.code }));
  const overlapping = h.sent.filter(r => r.method === 'session/set_model');
  // Settle any observed requests before asserting, so a failing review leaves no pending work.
  for (const request of overlapping) h.reply(request, {});
  h.reply(modeRequest, {});
  await mode; await tick();
  if (!overlapping.length) for (const request of h.sent.filter(r => r.method === 'session/set_model')) h.reply(request, {});
  await model;
  assert.equal(overlapping.length, 0, 'model mutation reached the wire before mode selection settled');
});

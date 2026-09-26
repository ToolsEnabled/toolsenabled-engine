'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');
const tick = () => new Promise(resolve => setImmediate(resolve));
const config = (model = 'a', effort = 'low') => [
  { id: 'model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'a' }, { value: 'b' }] },
  { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: effort, options: [{ value: 'low' }, { value: 'high' }] }
];
async function setup(t, configModel = false) {
  let listen;
  const sent = [];
  const emit = packet => listen?.(JSON.stringify(packet) + '\n');
  const reply = (r, result) => emit({ jsonrpc: '2.0', id: r.id, result });
  const session = () => ({ sessionId: 's', modes: { currentModeId: 'ask', availableModes: [{ id: 'ask' }, { id: 'plan' }] },
    models: { currentModelId: 'a', availableModels: [{ modelId: 'a' }, { modelId: 'b' }] },
    configOptions: configModel ? config() : config().slice(1) });
  const adapter = new AcpAdapter({ defaultCwd: process.cwd(), transport: {
    onData(fn) { listen = fn; return () => { listen = null; }; },
    write(line) {
      const r = JSON.parse(line); sent.push(r);
      if (r.method === 'initialize') reply(r, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      if (r.method === 'session/new') reply(r, session());
    }
  } });
  t.after(() => adapter.close());
  await adapter.initialize(); await adapter.startThread();
  return { adapter, sent, reply, emit, notify(options) {
    emit({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 's', update: { sessionUpdate: 'config_option_update', configOptions: options } } });
  } };
}

test('startup model then effort then mode is serialized and each confirmed choice is retained', async t => {
  const h = await setup(t, true);
  const model = h.adapter.selectModel('s', 'b');
  const effort = h.adapter.selectEffort('s', 'high');
  const mode = h.adapter.selectMode('s', 'plan');
  assert.equal(h.sent.at(-1).params.configId, 'model');
  h.reply(h.sent.at(-1), { configOptions: config('b') });
  assert.equal(await model, 'b');
  await tick();
  assert.equal(h.sent.at(-1).params.configId, 'reasoning_effort');
  h.reply(h.sent.at(-1), { configOptions: config('b', 'high') });
  assert.equal(await effort, 'high');
  await tick();
  assert.equal(h.sent.at(-1).method, 'session/set_mode');
  h.reply(h.sent.at(-1), {});
  assert.equal((await mode).currentModeId, 'plan');
  assert.equal(h.adapter.getSessionConfigOptions('s')[0].currentValue, 'b');
  assert.equal(h.adapter.getSessionConfigOptions('s')[1].currentValue, 'high');
});

test('config model ACK followed by close cannot commit model selection', async t => {
  const h = await setup(t, true);
  const pending = h.adapter.selectModel('s', 'b');
  const failed = assert.rejects(pending, { code: 'ACP_ADAPTER_CLOSED' });
  h.reply(h.sent.at(-1), { configOptions: config('b') });
  h.adapter.close();
  await failed;
  assert.equal(h.adapter.getSessionConfigOptions('s')[0].currentValue, 'a');
});

test('session replacement fences pending and queued settings despite a reused session id', async t => {
  for (const kind of ['model', 'effort', 'mode']) {
    const h = await setup(t);
    const pending = kind === 'model' ? h.adapter.selectModel('s', 'b')
      : kind === 'effort' ? h.adapter.selectEffort('s', 'high') : h.adapter.selectMode('s', 'plan');
    const failed = assert.rejects(pending, { code: 'ACP_SESSION_CHANGED' });
    const request = h.sent.at(-1);
    const queued = h.adapter.selectMode('s', 'plan');
    const queuedFailure = assert.rejects(queued, { code: 'ACP_SESSION_CHANGED' });
    await h.adapter.startThread();
    h.reply(request, kind === 'effort' ? { configOptions: config('a', 'high').slice(1) } : {});
    await Promise.all([failed, queuedFailure]);
    assert.equal(h.adapter.getSessionModes('s').currentModeId, 'ask');
    assert.equal(h.adapter.getSessionModels('s').currentModelId, 'a');
    assert.equal(h.adapter.getSessionConfigOptions('s')[0].currentValue, 'low');
  }
});

test('config notifications supersede a pending effort ACK without being overwritten', async t => {
  for (const value of ['low', 'high']) {
    const h = await setup(t);
    const pending = h.adapter.selectEffort('s', 'high');
    const result = value === 'low' ? assert.rejects(pending, { code: 'ACP_EFFORT_SELECTION_UNCONFIRMED' }) : pending;
    h.reply(h.sent.at(-1), { configOptions: config('a', 'high').slice(1) });
    h.notify(config('a', value).slice(1));
    await result;
    assert.equal(h.adapter.getSessionConfigOptions('s')[0].currentValue, value);
  }
});

test('model and effort reserve the same prompt and load fence as mode', async t => {
  for (const kind of ['model', 'effort']) {
    const h = await setup(t);
    const pending = kind === 'model' ? h.adapter.selectModel('s', 'b') : h.adapter.selectEffort('s', 'high');
    const request = h.sent.at(-1);
    const before = h.sent.length;
    await assert.rejects(h.adapter.sendTurn({ threadId: 's', text: 'hello' }), { code: 'ACP_ADAPTER_BUSY' });
    await assert.rejects(h.adapter.resumeThread('s'), { code: 'ACP_ADAPTER_BUSY' });
    assert.equal(h.sent.length, before);
    h.reply(request, kind === 'effort' ? { configOptions: config('a', 'high').slice(1) } : {});
    await pending;
  }
});

test('recovery without advertisements cannot reuse previous model or effort availability', async t => {
  const h = await setup(t);
  const loading = h.adapter.resumeThread('s');
  h.reply(h.sent.at(-1), {});
  await loading;
  await assert.rejects(h.adapter.selectModel('s', 'b'), { code: 'ACP_MODEL_UNAVAILABLE' });
  await assert.rejects(h.adapter.selectEffort('s', 'high'), { code: 'ACP_EFFORT_UNAVAILABLE' });
  assert.equal(h.adapter.getSessionModels('s'), null);
  assert.equal(h.adapter.getSessionConfigOptions('s'), null);
});

test('transport replacement cannot confirm an old adapter request', async t => {
  const h = await setup(t);
  const original = h.adapter.transport;
  const pending = h.adapter.selectModel('s', 'b');
  const failed = assert.rejects(pending, { code: 'ACP_SESSION_CHANGED' });
  h.adapter.transport = { ...original };
  h.reply(h.sent.at(-1), {});
  await failed;
  assert.equal(h.adapter.getSessionModels('s').currentModelId, 'a');
});

test('model and effort refuse during a prompt and normal sequential sends recover', async t => {
  const h = await setup(t);
  const prompt = h.adapter.sendTurn({ threadId: 's', text: 'hello' });
  const request = h.sent.at(-1);
  await assert.rejects(h.adapter.selectModel('s', 'b'), { code: 'ACP_ADAPTER_BUSY' });
  await assert.rejects(h.adapter.selectEffort('s', 'high'), { code: 'ACP_ADAPTER_BUSY' });
  h.reply(request, { stopReason: 'end_turn' });
  await prompt;
  const model = h.adapter.selectModel('s', 'b');
  h.reply(h.sent.at(-1), {});
  assert.equal(await model, 'b');
});

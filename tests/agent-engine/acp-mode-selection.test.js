'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');
const tick = () => new Promise(resolve => setImmediate(resolve));
const advertised = () => ({ currentModeId: 'ask', availableModes: [{ id: 'ask' }, { id: 'plan' }, { id: 'auto' }] });

async function setup(t, modes = advertised()) {
  let listener;
  const requests = [];
  const emit = packet => listener?.(JSON.stringify(packet) + '\n');
  const reply = (request, result) => emit({ jsonrpc: '2.0', id: request.id, result });
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.method === 'initialize') reply(request, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      if (request.method === 'session/new') reply(request, { sessionId: 's', ...(modes ? { modes } : {}) });
    }
  };
  const adapter = new AcpAdapter({ transport, defaultCwd: process.cwd() });
  t.after(() => adapter.close());
  await adapter.initialize();
  await adapter.startThread();
  return { adapter, requests, reply, emit, notify(mode) {
    emit({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 's', update: { sessionUpdate: 'current_mode_update', currentModeId: mode }
    } });
  }, selections: () => requests.filter(r => r.method === 'session/set_mode') };
}

test('advertised mode changes only after an ACK and returns a frozen confirmed receipt', async t => {
  const h = await setup(t);
  const selection = h.adapter.selectMode('s', 'plan');
  await tick();
  assert.equal(h.adapter.getSessionModes('s').currentModeId, 'ask');
  assert.deepEqual(h.selections()[0].params, { sessionId: 's', modeId: 'plan' });
  h.reply(h.selections()[0], {});
  const receipt = await selection;
  assert.equal(receipt.currentModeId, 'plan');
  assert.ok(Object.isFrozen(receipt));
  await h.adapter.selectMode('s', 'plan');
  assert.equal(h.selections().length, 1);
});

test('unadvertised, missing and partial mode advertisements refuse without wire traffic', async t => {
  for (const modes of [advertised(), null, { currentModeId: 'ask' }]) {
    const h = await setup(t, modes);
    await assert.rejects(h.adapter.selectMode('s', 'invented'), { code: 'ACP_MODE_UNAVAILABLE' });
    await assert.rejects(h.adapter.selectMode('unknown', 'plan'), { code: 'ACP_MODE_UNAVAILABLE' });
    assert.equal(h.selections().length, 0);
  }
});

test('concurrent choices serialize and a refused RPC does not poison the next choice', async t => {
  const h = await setup(t);
  const first = h.adapter.selectMode('s', 'plan');
  const rejected = assert.rejects(first, { code: 'ACP_REQUEST_FAILED' });
  const second = h.adapter.selectMode('s', 'auto');
  await tick();
  assert.equal(h.selections().length, 1);
  h.emit({ jsonrpc: '2.0', id: h.selections()[0].id, error: { code: -32602, message: 'refused' } });
  await rejected;
  await tick();
  assert.equal(h.selections().length, 2);
  assert.equal(h.adapter.getSessionModes('s').currentModeId, 'ask');
  h.reply(h.selections()[1], {});
  assert.equal((await second).currentModeId, 'auto');
});

test('conflicting notifications win over ACK; matching notifications are confirmed', async t => {
  for (const mode of ['auto', 'plan']) {
    const h = await setup(t);
    const pending = h.adapter.selectMode('s', 'plan');
    const outcome = mode === 'auto' ? assert.rejects(pending, { code: 'ACP_MODE_SELECTION_UNCONFIRMED' }) : pending;
    await tick();
    h.notify(mode);
    h.reply(h.selections()[0], {});
    await outcome;
    assert.equal(h.adapter.getSessionModes('s').currentModeId, mode);
  }
});

test('close fences both queued requests and ACK continuations; a new adapter owns recovery', async t => {
  const h = await setup(t);
  const first = h.adapter.selectMode('s', 'plan');
  const second = h.adapter.selectMode('s', 'auto');
  const failures = [first, second].map(p => assert.rejects(p, { code: 'ACP_ADAPTER_CLOSED' }));
  await tick();
  h.reply(h.selections()[0], {});
  h.adapter.close();
  await Promise.all(failures);
  assert.equal(h.adapter.getSessionModes('s').currentModeId, 'ask');
  assert.equal(h.selections().length, 1);
  const recovered = await setup(t);
  assert.equal(recovered.adapter.getSessionModes('s').currentModeId, 'ask');
});

test('prompt and load cannot overlap a selection, and selection cannot overlap a prompt or load', async t => {
  const h = await setup(t);
  const choice = h.adapter.selectMode('s', 'plan');
  await assert.rejects(h.adapter.sendTurn({ threadId: 's', text: 'hello' }), { code: 'ACP_ADAPTER_BUSY' });
  await assert.rejects(h.adapter.resumeThread('s'), { code: 'ACP_ADAPTER_BUSY' });
  await tick();
  h.reply(h.selections()[0], {});
  await choice;
  const prompt = h.adapter.sendTurn({ threadId: 's', text: 'hello' });
  await assert.rejects(h.adapter.selectMode('s', 'auto'), { code: 'ACP_ADAPTER_BUSY' });
  h.reply(h.requests.at(-1), { stopReason: 'end_turn' });
  await prompt;
  const load = h.adapter.resumeThread('s');
  await assert.rejects(h.adapter.selectMode('s', 'auto'), { code: 'ACP_ADAPTER_BUSY' });
  h.reply(h.requests.at(-1), {});
  await load;
  assert.equal(h.adapter.getSessionModes('s'), null);
  await assert.rejects(h.adapter.selectMode('s', 'auto'), { code: 'ACP_MODE_UNAVAILABLE' });
});

test('a load ACK received just before close cannot restore session mode state', async t => {
  const h = await setup(t);
  const loading = h.adapter.resumeThread('s');
  const refused = assert.rejects(loading, { code: 'ACP_ADAPTER_CLOSED' });
  h.reply(h.requests.at(-1), { modes: { ...advertised(), currentModeId: 'auto' } });
  h.adapter.close();
  await refused;
  assert.equal(h.adapter.getSessionModes('s').currentModeId, 'ask');
});

test('close while awaiting the provider rejects queued and pending choices', async t => {
  const h = await setup(t);
  const pending = h.adapter.selectMode('s', 'plan');
  const queued = h.adapter.selectMode('s', 'auto');
  const failures = [pending, queued].map(p => assert.rejects(p, { code: 'ACP_ADAPTER_CLOSED' }));
  await tick();
  h.adapter.close();
  await Promise.all(failures);
  assert.equal(h.selections().length, 1);
  assert.equal(h.adapter.getSessionModes('s').currentModeId, 'ask');
});

test('malformed ACK does not manufacture confirmation', async t => {
  for (const result of [null, { currentModeId: 'plan' }]) {
    const h = await setup(t);
    const pending = h.adapter.selectMode('s', 'plan');
    const failure = assert.rejects(pending, { code: 'ACP_PROTOCOL_INVALID' });
    await tick();
    h.reply(h.selections()[0], result);
    await failure;
    assert.equal(h.adapter.getSessionModes('s').currentModeId, 'ask');
  }
});

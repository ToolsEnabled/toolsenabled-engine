'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexAdapter, CODEX_CLI_VERSION } = require('../../src/lib/agent-engine/codex-adapter');
const contract = require('../../src/lib/agent-engine/engine-contract');

function fixture() {
  let receive;
  const writes = [];
  const transport = {
    onData(fn) { receive = fn; return () => {}; },
    write(line) {
      const request = JSON.parse(line); writes.push(request);
      if (request.method === 'initialize') receive(JSON.stringify({ id: request.id, result: { userAgent: 'speed-fixture', platformFamily: 'unix', platformOs: 'linux', codexHome: '/tmp/speed-fixture' } }) + '\n');
      if (request.method === 'thread/start') receive(JSON.stringify({ id: request.id, result: { thread: { id: 'new-speed-thread' } } }) + '\n');
      if (request.method === 'turn/start') receive(JSON.stringify({ id: request.id, result: { turn: { id: 'speed-turn' } } }) + '\n');
    }
  };
  return { writes, adapter: new CodexAdapter({ transport, codexVersion: CODEX_CLI_VERSION }) };
}

for (const [speed, serviceTier] of [['fast', 'fast'], ['standard', 'default']]) {
  test(`neutral ${speed} maps to Codex ${serviceTier} without other overrides`, async () => {
    const { adapter, writes } = fixture();
    await adapter.initialize();
    await adapter.sendTurn({ threadId: 'speed-thread', text: 'fixture', options: { speed } });
    const request = writes.find(x => x.method === 'turn/start');
    assert.equal(request.params.serviceTier, serviceTier);
    assert.equal(request.params.speed, undefined);
    assert.equal(request.params.model, undefined);
    assert.equal(request.params.effort, undefined);
    adapter.close();
  });
}

test('inherited speed stays omitted and conflicting or Ultrafast overrides are refused', async () => {
  const { adapter, writes } = fixture();
  await adapter.initialize();
  await adapter.sendTurn({ threadId: 'speed-thread', text: 'fixture' });
  assert.equal(writes.find(x => x.method === 'turn/start').params.serviceTier, undefined);
  assert.throws(() => contract.validateThreadOptions({ speed: 'fast', serviceTier: 'default' }));
  assert.throws(() => contract.validateThreadOptions({ speed: 'ultrafast' }));
  adapter.close();
});


test('thread startup also translates neutral speed and never leaks it onto the provider wire', async () => {
  const { adapter, writes } = fixture(); await adapter.initialize();
  await adapter.startThread({ speed: 'fast' });
  const request = writes.find(x => x.method === 'thread/start');
  assert.equal(request.params.serviceTier, 'fast');
  assert.equal(request.params.speed, undefined);
  adapter.close();
});

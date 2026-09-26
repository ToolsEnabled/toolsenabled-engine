'use strict';
const assert = require('node:assert/strict');
const { CodexAdapter } = require('../../src/lib/agent-engine/codex-adapter');
async function run() {
  let listener, reply, rpcError;
  const writes = [];
  const adapter = new CodexAdapter({ codexVersion: '0.154.0', transport: {
    onData(fn) { listener = fn; return () => {}; },
    write(line) {
      const message = JSON.parse(line); writes.push(message);
      if (!message.id) return;
      const result = message.method === 'initialize' ? {} : reply;
      listener(JSON.stringify(rpcError && message.method !== 'initialize'
        ? { id: message.id, error: rpcError } : { id: message.id, result }) + '\n');
    }
  }});
  await assert.rejects(adapter.listCollaborationModes());
  await adapter.initialize();
  reply = { data: [{ name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'high' }, { name: 'Default', mode: 'default' }, { name: 'Future', mode: 'future-mode' }] };
  const result = await adapter.listCollaborationModes();
  assert.deepEqual(result, { modes: [
    { name: 'Plan', mode: 'plan', model: null, reasoningEffort: 'high' },
    { name: 'Default', mode: 'default', model: null, reasoningEffort: null },
    { name: 'Future', mode: 'future-mode', model: null, reasoningEffort: null }
  ] });
  assert.equal(writes.at(-1).method, 'collaborationMode/list');
  assert.deepEqual(writes.at(-1).params, {});
  assert.throws(() => { result.modes[0].mode = 'auto'; }, TypeError);
  assert.throws(() => result.modes.push({}), TypeError);
  for (const invalid of [{}, { data: null }, { data: [{ name: 'Bad', mode: 3 }] }, { data: [{ mode: 'plan' }] }, { data: Array.from({length:129}, () => ({name:'Plan'})) }]) {
    reply = invalid;
    await assert.rejects(adapter.listCollaborationModes(), { code: 'CODEX_PROTOCOL_INVALID' });
  }
  rpcError = { code: -32601, message: 'Method not found' };
  await assert.rejects(adapter.listCollaborationModes(), error => error.rpcCode === -32601);
  assert.equal(writes.some(row => ['turn/start', 'thread/settings/update'].includes(row.method)), false);
  adapter.close();
  await assert.rejects(adapter.listCollaborationModes());
  console.log('Codex collaboration catalog behavior passed: metadata, optional fields, immutable results, malformed/bounded refusals, unavailable RPC, no turn or mutation.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

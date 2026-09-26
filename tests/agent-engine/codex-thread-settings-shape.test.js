'use strict';
const assert = require('node:assert/strict');
const { CodexAdapter } = require('../../src/lib/agent-engine/codex-adapter');
async function read(result, operation = 'readThread') {
  let listener;
  const adapter = new CodexAdapter({ codexVersion: '0.154.0', transport: {
    onData(fn) { listener = fn; return () => {}; },
    write(line) {
      const message = JSON.parse(line);
      if (!message.id) return;
      listener(JSON.stringify({ id: message.id, result: message.method === 'initialize' ? {} : result }) + '\n');
    }
  }});
  try {
    await adapter.initialize();
    return operation === 'startThread' ? await adapter.startThread() : await adapter[operation]('t');
  } finally { adapter.close(); }
}
async function run() {
  // Installed 0.154.0 ThreadReadResponse has only thread at the outer level.
  const nested = await read({ thread: { id: 't', model: 'configured-model', reasoningEffort: 'high', turns: [] } });
  assert.equal(nested.model, 'configured-model');
  assert.equal(nested.reasoningEffort, 'high');
  for (const operation of ['readThread', 'startThread', 'resumeThread', 'forkThread']) {
    const legacy = await read({ thread: { id: 't', turns: [] }, model: 'legacy-model', reasoningEffort: 'medium' }, operation);
    assert.equal(legacy.model, 'legacy-model');
    assert.equal(legacy.reasoningEffort, 'medium');
    const unavailable = await read({ thread: { id: 't', model: null, reasoningEffort: null } }, operation);
    assert.equal(unavailable.model, null);
    assert.equal(unavailable.reasoningEffort, null);
    const missing = await read({ thread: { id: 't' } }, operation);
    assert.equal(missing.model, null);
    assert.equal(missing.reasoningEffort, null);
  }
  const both = await read({ thread: { id: 't', model: 'persisted-model', reasoningEffort: 'low' }, model: 'resolved-model', reasoningEffort: null }, 'resumeThread');
  assert.equal(both.model, 'resolved-model');
  assert.equal(both.reasoningEffort, null, 'Explicit top-level null must not be replaced with persisted effort');
  const mixed = await read({ thread: { id: 't', reasoningEffort: 'high' }, model: 'resolved-model' });
  assert.equal(mixed.model, 'resolved-model');
  assert.equal(mixed.reasoningEffort, 'high');
  for (const thread of [{ id: 't', model: 17 }, { id: 't', reasoningEffort: false }]) {
    await assert.rejects(read({ thread }), { code: 'CODEX_PROTOCOL_INVALID' });
  }
  console.log('Codex thread settings shape passed: installed nested read, legacy top-level, explicit null, absent values, mixed fields, malformed nested refusals.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

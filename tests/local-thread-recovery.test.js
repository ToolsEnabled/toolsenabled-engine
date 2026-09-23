'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { LocalNodeAdapter } = require('../src/lib/agent-engine/local-node-adapter');
const { createLocalThreadStore, MAX_THREAD_BYTES, MAX_THREADS } = require('../src/lib/agent-engine/local-thread-store');

function storeFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return createLocalThreadStore({ directory });
}

test('a fresh process resumes the saved transcript, model and usage without a live model or tool', async t => {
  const store = storeFor(t);
  const tools = [
    { name: 'allowed.recovered', description: 'Harmless recovery stub', inputSchema: { type: 'object' } },
    { name: 'allowed.padding', description: 'x'.repeat(13000), inputSchema: { type: 'object' } }
  ];
  let rounds = 0;
  const adapter = new LocalNodeAdapter({ model: 'test:9b', threadStore: store,
    tools: { list: () => tools, call: async () => { throw new Error('discovery does not execute a tool'); } },
    transport: { async chat(_body, { onPacket }) {
      if (++rounds === 1) return onPacket({ message: { content: '', tool_calls: [{ function: { name: 'local_tools_discover', arguments: { names: ['allowed.recovered'] } } }] }, done: true });
      onPacket({ message: { content: 'saved answer' }, done: true, prompt_eval_count: 5, eval_count: 2 });
    } } });
  const { threadId } = await adapter.startThread({});
  await adapter.sendTurnWithSessionInstructions({ threadId, text: 'saved question' }, { rules: 'saved standing rule', role: 'saved assigned role' });
  adapter.close();
  const script = `
    const { LocalNodeAdapter } = require('./src/lib/agent-engine/local-node-adapter');
    const { createLocalThreadStore } = require('./src/lib/agent-engine/local-thread-store');
    const { createLocalToolView } = require('./src/lib/agent-engine/local-tool-discovery');
    const store = createLocalThreadStore({ directory: process.argv[1] });
    const adapter = new LocalNodeAdapter({ model: 'test:9b', threadStore: store, transport: { chat: async () => { throw new Error('no model call allowed'); } } });
    adapter.resumeThread(process.argv[2]).then(result => {
      const restoredTools = createLocalToolView({ list: () => ${JSON.stringify(tools)} }, store.load(process.argv[2]), 8192).list().map(tool => tool.name);
      console.log(JSON.stringify({ result, usage: adapter.getUsage(), restoredTools, instructions: store.load(process.argv[2]).sessionInstructions })); adapter.close();
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const recovered = JSON.parse(execFileSync(process.execPath, ['-e', script, store.directory, threadId], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 10000
  }));
  assert.equal(recovered.result.threadId, threadId);
  assert.equal(recovered.result.model, 'test:9b');
  assert.deepEqual(recovered.result.turns[0].said, [{ who: 'you', text: 'saved question' }, { who: 'agent', text: 'saved answer' }]);
  assert.equal(recovered.result.turns[0].status, 'success');
  assert.deepEqual(recovered.instructions, { rules: 'saved standing rule', role: 'saved assigned role' });
  assert.equal(recovered.usage.total.totalTokens, 7);
  assert.ok(recovered.restoredTools.includes('allowed.recovered'), 'exact schema selection survives a real process boundary');
  assert.equal(recovered.restoredTools.includes('allowed.padding'), false);
});

test('damaged and oversized history is refused; existing saved data is preserved', t => {
  const store = storeFor(t);
  const id = randomUUID();
  const record = { model: 'test:9b', messages: [], usage: null, cwd: null };
  store.save(id, record);
  const file = path.join(store.directory, `${id}.json`);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.save(id, { ...record, messages: [{ role: 'user', content: 'x'.repeat(MAX_THREAD_BYTES), turnId: randomUUID() }] }),
    error => error.code === 'LOCAL_NODE_THREAD_TOO_LARGE');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, 'damaged');
  assert.throws(() => store.load(id), error => error.code === 'LOCAL_NODE_THREAD_UNREADABLE');
  assert.equal(fs.readFileSync(file, 'utf8'), 'damaged');
  assert.throws(() => store.load('../escape'), error => error.code === 'LOCAL_NODE_THREAD_UNKNOWN');
});

test('recovery keeps a bounded number of snapshots and ephemeral sessions write none', async t => {
  const store = storeFor(t);
  const record = { model: 'test:9b', messages: [], usage: null, cwd: null };
  let newest;
  for (let index = 0; index <= MAX_THREADS; index += 1) { newest = randomUUID(); store.save(newest, record); }
  assert.equal(fs.readdirSync(store.directory).length, MAX_THREADS);
  assert.equal(store.load(newest).model, 'test:9b');
  const adapter = new LocalNodeAdapter({ model: 'test:9b', threadStore: store, transport: { chat: async () => {} } });
  const ephemeral = await adapter.startThread({ ephemeral: true });
  assert.equal(fs.existsSync(path.join(store.directory, `${ephemeral.threadId}.json`)), false);
  adapter.close();
});

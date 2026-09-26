'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalNodeAdapter } = require('../src/lib/agent-engine/local-node-adapter');
const { createLocalToolView, CORE_NAMES, HELPER_NAME, wireTool } = require('../src/lib/agent-engine/local-tool-discovery');

function catalogue() {
  return [...CORE_NAMES.map(name => ({ name, description: `Actual coordination tool ${name}`, inputSchema: { type: 'object', properties: {} } })),
    ...Array.from({ length: 40 }, (_, index) => ({ name: `allowed.task_${index}`, description: `Task ${index}. ${'Description. '.repeat(32)}`,
      inputSchema: { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'] } }))];
}

test('large catalogues retain real coordination schemas and expose only authorized search results', async () => {
  const tools = catalogue();
  const view = createLocalToolView({ list: () => tools, call: async () => { throw new Error('discovery must not execute'); } }, {}, 8192);
  assert.equal(view.compact, true);
  for (const name of CORE_NAMES) assert.deepEqual(view.list().find(tool => tool.name === name), tools.find(tool => tool.name === name));
  assert.ok(view.list().length < tools.length);
  const result = await view.call(view.discoveryToolName, { query: 'allowed.task_3' });
  const found = JSON.parse(result.text);
  assert.equal(found.mode, 'search');
  assert.equal(Object.hasOwn(found, 'schemas'), false, 'search does not imply empty or missing schemas');
  assert.match(found.nextStep, /exact tool names/);
  assert.ok(found.matches.length > 0 && found.matches.length <= 8);
  assert.ok(found.matches.every(row => tools.some(tool => tool.name === row.name)));
  assert.equal(found.grantsAuthority, false);
  const denied = await view.call(view.discoveryToolName, { names: ['forbidden.secret'] });
  assert.equal(denied.isError, true);
  assert.equal(view.list().some(tool => tool.name === 'forbidden.secret'), false);
});

test('discovery selects exact schemas for the next round and actual execution uses the unchanged surface', async () => {
  const tools = catalogue();
  const originalCalls = [];
  const emitted = [];
  let rounds = 0;
  const adapter = new LocalNodeAdapter({ model: 'test:9b', tools: { list: () => tools,
    async call(name, args, options) { originalCalls.push({ name, args, signal: options.signal }); return { text: 'harmless stub result', isError: false }; } },
    transport: { async chat(body, callbacks) {
      rounds += 1;
      const available = body.tools.map(tool => tool.function.name);
      const packet = fn => callbacks.onPacket({ message: { content: '', tool_calls: [{ function: fn }] }, done: true });
      if (rounds === 1) {
        assert.equal(available.includes('allowed.task_4'), false);
        return packet({ name: HELPER_NAME, arguments: { query: 'allowed.task_4' } });
      }
      if (rounds === 2) {
        assert.equal(JSON.parse(body.messages.at(-1).content).mode, 'search');
        return packet({ name: HELPER_NAME, arguments: { names: ['allowed.task_4'] } });
      }
      if (rounds === 3) {
        assert.equal(JSON.parse(body.messages.at(-1).content).mode, 'schemas-loaded');
        assert.deepEqual(body.tools.find(tool => tool.function.name === 'allowed.task_4'), wireTool(tools.find(tool => tool.name === 'allowed.task_4')));
        return packet({ name: 'allowed.task_4', arguments: { value: 'safe' } });
      }
      assert.equal(body.messages.at(-1).content, 'harmless stub result');
      callbacks.onPacket({ message: { content: 'done' }, done: true });
    } } });
  adapter.onEvent(event => emitted.push(event));
  const { threadId } = await adapter.startThread({});
  const result = await adapter.sendTurn({ threadId, text: 'use one allowed task' });
  assert.equal(result.status, 'success');
  assert.equal(rounds, 4);
  assert.equal(originalCalls.length, 1, 'discovery never bypasses the surface by executing itself');
  assert.equal(originalCalls[0].name, 'allowed.task_4');
  assert.deepEqual(originalCalls[0].args, { value: 'safe' });
  assert.ok(originalCalls[0].signal instanceof AbortSignal);
  assert.deepEqual(emitted.filter(event => event.type === 'tool_call').map(event => event.tool), [HELPER_NAME, HELPER_NAME, 'allowed.task_4']);
  adapter.close();
});

test('small explicit tool surfaces preserve every schema and call path', async () => {
  const surface = { list: () => catalogue().slice(0, 2), call: async () => ({ text: 'same', isError: false }) };
  assert.equal(createLocalToolView(surface, {}, 8192), surface);
});

test('a real tool with the helper name remains distinct and callable after exact selection', async () => {
  const tools = catalogue();
  tools.push({ name: HELPER_NAME, description: 'An actual server tool whose name collides.', inputSchema: { type: 'object' } });
  const called = [];
  const view = createLocalToolView({ list: () => tools, call: async name => { called.push(name); return { text: 'original', isError: false }; } }, {}, 8192);
  assert.notEqual(view.discoveryToolName, HELPER_NAME);
  assert.equal((await view.call(view.discoveryToolName, { names: [HELPER_NAME] })).isError, false);
  assert.equal((await view.call(HELPER_NAME, {})).text, 'original');
  assert.deepEqual(called, [HELPER_NAME]);
});

test('selection/search bounds refuse oversized schemas and never call undiscovered tools', async () => {
  const tools = catalogue();
  tools.push({ name: 'allowed.giant', description: 'Huge', inputSchema: { type: 'object', description: 'x'.repeat(20000) } });
  let calls = 0;
  const record = {};
  const view = createLocalToolView({ list: () => tools, call: async () => { calls += 1; } }, record, 8192);
  for (const args of [{ query: 'x'.repeat(201) }, { names: Array(5).fill('allowed.task_1') }, { names: ['allowed.giant'] }, { hiddenOverride: true }]) {
    assert.equal((await view.call(view.discoveryToolName, args)).isError, true);
  }
  assert.equal((await view.call('allowed.task_1', { value: 'not selected' })).isError, true);
  assert.equal(calls, 0);
  assert.deepEqual(record.localToolNames, []);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await view.call(view.discoveryToolName, { names: ['allowed.task_1'] }, { signal: controller.signal })).isError, true);
  assert.deepEqual(record.localToolNames, []);
});

test('saved selections survive resume, reset on a new thread, and drop tools no longer authorized', async () => {
  const tools = catalogue();
  const record = {};
  const surface = { list: () => tools, call: async () => {} };
  const view = createLocalToolView(surface, record, 8192);
  await view.call(view.discoveryToolName, { names: ['allowed.task_1'] });
  const restored = createLocalToolView(surface, JSON.parse(JSON.stringify(record)), 8192);
  assert.ok(restored.list().some(tool => tool.name === 'allowed.task_1'));
  assert.equal(createLocalToolView(surface, {}, 8192).list().some(tool => tool.name === 'allowed.task_1'), false);
  const narrowed = createLocalToolView({ ...surface, list: () => tools.filter(tool => tool.name !== 'allowed.task_1') }, record, 8192);
  assert.equal(narrowed.list().some(tool => tool.name === 'allowed.task_1'), false);
  assert.deepEqual(record.localToolNames, []);
});

test('the real production catalogue fits compact advertisement with unchanged coordination schemas', () => {
  const tools = require('../src/lib/tool-registry').listTools();
  const view = createLocalToolView({ list: () => tools, call: async () => { throw new Error('no actual execution'); } }, {}, 8192);
  assert.ok(view.compact, 'production catalogue must exercise compact selection');
  assert.ok(JSON.stringify(view.list().map(wireTool)).length <= 16384);
  for (const name of ['agent.spawn', 'agent_comms.send_local', 'agent_comms.local_roster']) {
    assert.deepEqual(view.list().find(tool => tool.name === name), tools.find(tool => tool.name === name));
  }
});

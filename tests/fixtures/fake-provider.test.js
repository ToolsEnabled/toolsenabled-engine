'use strict';

const assert = require('node:assert/strict');
const ScriptedFakeProvider = require('../helpers/scripted-provider');

async function testFakeProvider() {
  const provider = new ScriptedFakeProvider([
    { text: 'First response text', toolCalls: [], finishReason: 'stop' },
    {
      text: 'Response with tool',
      toolCalls: [{ name: 'read_file', args: { filePath: 'package.json' } }],
      finishReason: 'tool_calls'
    },
    { error: 'Simulated model timeout', code: 'PROVIDER_TIMEOUT' },
    { response: null }
  ]);

  const first = await provider.generate({ messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(first.text, 'First response text');
  assert.deepEqual(provider.receivedRequests[0].messages, [{ role: 'user', content: 'Hello' }]);

  const events = [];
  for await (const event of provider.stream({ messages: [{ role: 'user', content: 'Do tool' }] })) {
    events.push(event);
  }
  assert.deepEqual(events, [
    { type: 'chunk', text: 'Response ' },
    { type: 'chunk', text: 'with ' },
    { type: 'chunk', text: 'tool ' },
    { type: 'tool_call', call: { name: 'read_file', args: { filePath: 'package.json' } } },
    { type: 'finish', finishReason: 'tool_calls' }
  ]);
  assert.deepEqual(provider.receivedRequests[1].messages, [
    { role: 'user', content: 'Do tool' }
  ]);

  await assert.rejects(
    () => provider.generate({ messages: [] }),
    error => error.code === 'PROVIDER_TIMEOUT' && /Simulated model timeout/.test(error.message)
  );
  assert.equal(await provider.generate({ messages: [] }), null);
  await assert.rejects(
    () => provider.generate({ messages: [] }),
    error => error.code === 'SCRIPT_EXHAUSTED' && /Scripted provider exhausted/.test(error.message)
  );

  const cancellationProvider = new ScriptedFakeProvider([
    { text: 'too late', toolCalls: [], finishReason: 'stop', delayMs: 1000 }
  ]);
  const controller = new AbortController();
  const pending = cancellationProvider.generate({ messages: [] }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    () => pending,
    error => error.name === 'AbortError' && error.code === 'ABORT_ERR'
  );

  console.log('Scripted fake provider regression tests passed.');
}

testFakeProvider().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

"use strict";
require('./lib/isolated-environment').activate('host-interaction-watch');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createInteractionBroker } = require('../src/lib/host-worker-interactions');
const { startInteractionTerminal, runInteractionTerminal } = require('../src/lib/host-interaction-terminal');
const owner = { nodeId: 'fixture-worker', sessionId: 'fixture-session', parentSessionId: 'fixture-parent', level: 2 };
const request = { inputId: 'fixture-input', threadId: 'fixture-thread', turnId: 'fixture-turn', kind: 'form',
  sourceName: 'fixture-only', message: 'Synthetic test decision', schema: { type: 'object', properties: {} } };
async function fixture(t, timeoutMs = 2000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-watch-'));
  const stateRoot = path.join(root, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  const broker = createInteractionBroker({ timeoutMs });
  const terminal = await startInteractionTerminal({ stateRoot, broker, env: {} });
  t.after(async () => { await terminal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { stateRoot, broker };
}
function blockedQuestion(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
test('watch waits for future requests and requires a separate exact decision for each', async t => {
  const f = await fixture(t); const stop = new AbortController();
  const results = [], decisions = ['1', 'accept', '{}', '1', 'decline'];
  let waits = 0, delivered = 0, readers = 0;
  const result = await runInteractionTerminal({ ...f, env: {}, watch: true, pollIntervalMs: 10,
    signal: stop.signal, input: { isTTY: true }, output: { isTTY: true, write(text) {
      if (text.includes('Waiting for Fleet requests') && ++waits <= 2)
        results.push(f.broker.request(owner, { ...request, inputId: 'fixture-' + waits }));
      if (text.includes('Decision delivered') && ++delivered === 2) stop.abort();
    } }, makeReader() { readers++; return { question: async () => decisions.shift(), close() {} }; } });
  assert.deepEqual(result, { handled: 2, stopped: true });
  assert.equal(readers, 2); assert.equal(decisions.length, 0);
  assert.deepEqual(await Promise.all(results), [{ action: 'accept', content: {} }, { action: 'decline', content: null }]);
});
test('stopping an empty watch sends no decision and leaves no polling timer', async t => {
  const f = await fixture(t); const stop = new AbortController(); let calls = 0;
  const result = await runInteractionTerminal({ ...f, env: {}, watch: true, pollIntervalMs: 10,
    signal: stop.signal, input: { isTTY: true }, output: { isTTY: true, write() { stop.abort(); } },
    makeReader() { calls++; throw new Error('No request should be displayed.'); } });
  assert.deepEqual(result, { handled: 0, stopped: true }); assert.equal(calls, 0);
});
for (const stage of [0, 1, 2]) test('expiry clears unanswered prompt stage ' + stage + ' without acceptance', async t => {
  const f = await fixture(t, 200); const pending = f.broker.request(owner, request);
  let questions = 0, closed = 0, text = '';
  const result = await runInteractionTerminal({ ...f, env: {}, input: { isTTY: true },
    output: { isTTY: true, write(s) { text += s; } }, makeReader: () => ({
      question: async (_message, { signal }) => {
        const index = questions++;
        if (index === stage) return blockedQuestion(signal);
        return ['1', 'accept', '{}'][index];
      }, close() { closed++; } }) });
  assert.deepEqual(result, { handled: 0, expired: true });
  assert.equal(questions, stage + 1); assert.equal(closed, 1);
  assert.deepEqual(await pending, { action: 'cancel', content: null });
  assert.doesNotMatch(text, /Decision delivered.*accept/);
});
test('a late reader response cannot turn an expired request into acceptance', async t => {
  const f = await fixture(t, 100); const pending = f.broker.request(owner, request);
  const result = await runInteractionTerminal({ ...f, env: {}, input: { isTTY: true },
    output: { isTTY: true, write() {} }, makeReader: () => ({
      question: async () => { await new Promise(r => setTimeout(r, 150)); return '1'; }, close() {} }) });
  assert.deepEqual(result, { handled: 0, expired: true });
  assert.deepEqual(await pending, { action: 'cancel', content: null });
});
test('watch exits on reader EOF or SIGINT without making an approval', async t => {
  for (const event of ['close', 'SIGINT']) {
    const f = await fixture(t); const pending = f.broker.request(owner, request);
    const reader = new EventEmitter(); let closed = 0;
    reader.question = async (_message, { signal }) => { queueMicrotask(() => reader.emit(event)); return blockedQuestion(signal); };
    reader.close = () => { closed++; reader.emit('close'); };
    const result = await runInteractionTerminal({ ...f, env: {}, watch: true, input: { isTTY: true },
      output: { isTTY: true, write() {} }, makeReader: () => reader });
    assert.deepEqual(result, { handled: 0, stopped: true }); assert.equal(closed, 1);
    // No selection was made. Stopping this terminal does not cancel another owner's unselected request.
    assert.equal(f.broker.list().length, 1); f.broker.close();
    assert.deepEqual(await pending, { action: 'cancel', content: null });
    assert.equal(reader.listenerCount('close'), 0); assert.equal(reader.listenerCount('SIGINT'), 0);
  }
});
test('watch clears an expired request and then reviews a distinct future request', async t => {
  const f = await fixture(t, 200); const old = f.broker.request(owner, request);
  const stop = new AbortController(); let generation = 0, fresh, answers = ['1', 'decline'];
  const result = await runInteractionTerminal({ ...f, env: {}, watch: true, pollIntervalMs: 10,
    signal: stop.signal, input: { isTTY: true }, output: { isTTY: true, write(s) {
      if (s.includes('expired or was resolved')) fresh = f.broker.request(owner, { ...request, inputId: 'new-request' });
      if (s.includes('Decision delivered')) stop.abort();
    } }, makeReader() { const first = ++generation === 1; return {
      question: async (_message, { signal }) => first ? blockedQuestion(signal) : answers.shift(), close() {} }; } });
  assert.deepEqual(result, { handled: 1, stopped: true });
  assert.deepEqual(await old, { action: 'cancel', content: null });
  assert.deepEqual(await fresh, { action: 'decline', content: null });
});
test('watch rejects noninteractive input and invalid cadence before touching state', async () => {
  await assert.rejects(runInteractionTerminal({ stateRoot: '/absent-fixture', watch: true,
    input: { isTTY: false }, output: { isTTY: true } }), { code: 'HOST_INPUT_HUMAN_TERMINAL_REQUIRED' });
  await assert.rejects(runInteractionTerminal({ stateRoot: '/absent-fixture', watch: true, pollIntervalMs: 0,
    input: { isTTY: true }, output: { isTTY: true } }), { code: 'HOST_INPUT_INVALID' });
});

// Found by the real-model smoke of this port: a host server that its client
// ended left its descriptor and socket file, and descriptors piled up towards
// the 128-session cap at which interactions refuses to run.
test('a new terminal removes descriptors of servers that are gone and keeps live ones', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-watch-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  const live = await startInteractionTerminal({ stateRoot, broker: createInteractionBroker(), env: {} });
  const folder = path.join(stateRoot, 'interactions');
  // A descriptor whose socket file is gone.
  const missing = path.join(folder, '00000000-0000-4000-8000-000000000000.json');
  fs.writeFileSync(missing, JSON.stringify({ v: 1, id: '00000000-0000-4000-8000-000000000000',
    socketPath: path.join(root, 'gone.sock'), token: 'x'.repeat(43) }) + '\n', { mode: 0o600 });
  // A server killed outright: its descriptor and socket file stay, nothing listens.
  const killed = require('node:child_process').spawn(process.execPath, ['-e', `
    process.env.TOOLSENABLED_TEST_ISOLATED = process.env.TOOLSENABLED_TEST_ISOLATED || '';
    const { createInteractionBroker } = require(${JSON.stringify(require.resolve('../src/lib/host-worker-interactions'))});
    const { startInteractionTerminal } = require(${JSON.stringify(require.resolve('../src/lib/host-interaction-terminal'))});
    startInteractionTerminal({ stateRoot: ${JSON.stringify(stateRoot)}, broker: createInteractionBroker(), env: {} })
      .then(terminal => process.stdout.write(JSON.stringify({ descriptorPath: terminal.descriptorPath }) + '\\n'));
    setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
  const { descriptorPath } = await new Promise(resolve => killed.stdout.once('data', data => resolve(JSON.parse(String(data)))));
  const deadSocket = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')).socketPath;
  killed.kill('SIGKILL'); await new Promise(resolve => killed.once('exit', resolve));
  assert.equal(fs.existsSync(deadSocket), true, 'a killed server leaves its socket file');
  const next = await startInteractionTerminal({ stateRoot, broker: createInteractionBroker(), env: {} });
  assert.equal(fs.existsSync(missing), false, 'a descriptor without a socket was removed');
  assert.equal(fs.existsSync(descriptorPath), false, 'a descriptor whose server is gone was removed');
  assert.equal(fs.existsSync(deadSocket), false, 'and so was its dead socket file');
  assert.equal(fs.existsSync(live.descriptorPath), true, 'a live server keeps its descriptor');
  await next.close(); await live.close();
  assert.deepEqual(fs.readdirSync(folder), [], 'closing removes each descriptor');
});

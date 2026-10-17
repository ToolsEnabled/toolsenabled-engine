'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexAdapter, CODEX_CLI_VERSION } = require('../../src/lib/agent-engine/codex-adapter');

async function fixture(t, options = {}) {
  let receive;
  let turn = 0;
  const writes = [], events = [];
  const adapter = new CodexAdapter({ codexVersion: CODEX_CLI_VERSION, ...options, transport: {
    onData(listener) { receive = listener; return () => {}; },
    write(line) {
      const p = JSON.parse(line); writes.push(p);
      if (p.method === 'initialize') reply({ id: p.id, result: { userAgent: 'offline-test' } });
      if (p.method === 'turn/start') reply({ id: p.id, result: { turn: { id: `turn-${++turn}` } } });
      if (p.method === 'turn/interrupt') reply({ id: p.id, result: {} });
    }
  } });
  function reply(p) { return receive(JSON.stringify(p) + '\n'); }
  adapter.onEvent(e => events.push(e));
  t.after(() => adapter.close());
  await adapter.initialize();
  await adapter.sendTurn({ threadId: 'thread-1', text: 'fixture' });
  function request(extra = {}, id = 'elicitation-1') {
    reply({ id, method: 'mcpServer/elicitation/request', params: {
      threadId: 'thread-1', turnId: 'turn-1', serverName: 'fixture-server', mode: 'form',
      message: 'Choose a title', requestedSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      ...extra
    } });
  }
  return { adapter, writes, events, reply, request };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function result(f, id = 'elicitation-1') { return f.writes.filter(p => p.id === id && !p.method); }
function complete(f, status = 'completed', turnId = 'turn-1') {
  f.reply({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status } } });
}

// Ported from the Windows host line (639b479). Without a host interaction route
// this build keeps 1.9.0's answer (decline, counted in the turn's completion)
// instead of the Windows line's cancel.
test('unattended MCP elicitation is declined and the same connection completes and starts another turn', async t => {
  const f = await fixture(t);
  f.request(); await settle();
  assert.equal(f.adapter.closed, null);
  assert.deepEqual(f.writes.at(-1), { jsonrpc: '2.0', id: 'elicitation-1', result: { action: 'decline' } });
  f.reply({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(f.events.at(-1).status, 'completed');
  assert.deepEqual(f.events.at(-1).payload, { promptDeclined: { count: 1, from: ['fixture-server'] } });
  assert.deepEqual(await f.adapter.sendTurn({ threadId: 'thread-1', text: 'next' }), { turnId: 'turn-2' });
});

test('explicit form answer is correlated, validated, and sent without persisting content', async t => {
  let shown;
  const f = await fixture(t, { requestInput(request) { shown = request; return { action: 'accept', content: { title: 'human-reviewed' } }; } });
  f.request(); await settle();
  assert.equal(shown.kind, 'form');
  assert.equal(shown.sourceName, 'fixture-server');
  assert.equal(shown.threadId, 'thread-1');
  assert.equal(shown.turnId, 'turn-1');
  assert.ok(Object.isFrozen(shown.schema.properties));
  assert.deepEqual(result(f)[0].result, { action: 'accept', content: { title: 'human-reviewed' } });
  assert.ok(!JSON.stringify(f.events).includes('human-reviewed'));
  assert.ok(!JSON.stringify(f.events).includes('Choose a title'));
  assert.equal(f.adapter.inputs.size, 0);
});

for (const action of ['decline', 'cancel']) test(`explicit ${action} is preserved`, async t => {
  const f = await fixture(t, { requestInput: () => ({ action }) });
  f.request(); await settle();
  assert.deepEqual(result(f)[0].result, { action, content: null });
  assert.equal(f.adapter.closed, null);
});

test('URL request reaches only the explicit host callback and acceptance sends no data', async t => {
  let shown;
  const f = await fixture(t, { requestInput: request => { shown = request; return { action: 'accept' }; } });
  f.request({ mode: 'url', requestedSchema: undefined, url: 'https://example.test/flow', elicitationId: 'flow-1' });
  await settle();
  assert.equal(shown.url, 'https://example.test/flow');
  assert.equal(shown.schema, undefined);
  assert.deepEqual(result(f)[0].result, { action: 'accept', content: null });
  assert.ok(!JSON.stringify(f.events).includes('example.test'));
});

for (const turnId of [null, undefined]) test(`optional turnId ${turnId} binds only to the active turn`, async t => {
  const f = await fixture(t, { requestInput: request => { assert.equal(request.turnId, 'turn-1'); return { action: 'decline' }; } });
  f.request({ turnId }); await settle();
  assert.deepEqual(result(f)[0].result, { action: 'decline', content: null });
});

for (const [name, extra] of [
  ['extended form not opted in', { mode: 'openai/form' }],
  ['unknown mode', { mode: 'future-mode' }],
  ['missing server', { serverName: undefined }],
  ['oversized message', { message: 'x'.repeat(16385) }],
  ['oversized schema', { requestedSchema: { type: 'object', properties: { title: { type: 'string', description: 'x'.repeat(70000) } } } }],
  ['schema with unsupported keyword', { requestedSchema: { type: 'object', properties: { title: { type: 'string', pattern: '(a+)+$' } } } }],
  ['nested schema', { requestedSchema: { type: 'object', properties: { title: { type: 'object', properties: {} } } } }],
  ['credential URL', { mode: 'url', url: 'https://user:secret@example.test/', elicitationId: 'id' }],
  ['script URL', { mode: 'url', url: 'javascript:alert(1)', elicitationId: 'id' }],
  ['URL missing id', { mode: 'url', url: 'https://example.test/' }],
  ['insecure public URL', { mode: 'url', url: 'http://example.test/', elicitationId: 'id' }],
]) test(`${name} is refused without presenting input or closing the connection`, async t => {
  let calls = 0;
  const f = await fixture(t, { requestInput: () => { calls++; return { action: 'accept', content: { title: 'x' } }; } });
  f.request(extra); await settle();
  assert.equal(calls, 0);
  assert.equal(result(f)[0].error.code, -32602);
  assert.equal(f.adapter.closed, null);
});

for (const answer of [undefined, {}, { action: 'accept' }, { action: 'accept', content: { title: 3 } },
  { action: 'accept', content: { title: 'x', extra: 'secret' } }, { action: 'accept', content: { title: 'x'.repeat(70000) } },
  { action: 'decline', content: { title: 'x' } }, { action: 'acceptForSession', content: { title: 'x' } }]) {
  test(`invalid host answer ${JSON.stringify(answer)?.slice(0, 85)} cancels with no content`, async t => {
    const f = await fixture(t, { requestInput: () => answer });
    f.request(); await settle();
    assert.deepEqual(result(f)[0].result, { action: 'cancel', content: null });
    assert.equal(f.adapter.closed, null);
  });
}

for (const reject of [false, true]) test(`host ${reject ? 'rejects promise' : 'throws'} without failing the turn`, async t => {
  const f = await fixture(t, { requestInput: () => { if (reject) return Promise.reject(new Error('private')); throw new Error('private'); } });
  f.request(); await settle();
  assert.deepEqual(result(f)[0].result, { action: 'cancel', content: null });
  assert.equal(f.adapter.closed, null);
  assert.ok(!JSON.stringify(f.events).includes('private'));
});

for (const extra of [{ threadId: 'other-thread' }, { turnId: 'other-turn' }]) test(`mismatched correlation ${JSON.stringify(extra)} cancels without borrowing authority`, async t => {
  const f = await fixture(t, { requestInput: () => assert.fail('must not present') });
  f.request(extra); await settle();
  assert.deepEqual(result(f)[0].result, { action: 'cancel', content: null });
  assert.equal(f.adapter.activeTurns.get('thread-1').turnId, 'turn-1');
  assert.equal(f.adapter.closed, null);
});

for (const status of ['completed', 'interrupted', 'failed']) test(`${status} aborts pending input and ignores late user answers after id reuse`, async t => {
  const first = deferred(), second = deferred(); let signal, count = 0, oldId, newId;
  const f = await fixture(t, { requestInput: (request, context) => {
    if (!count++) { oldId = request.inputId; signal = context.signal; return first.promise; }
    newId = request.inputId; return second.promise;
  } });
  f.request(); await settle(); complete(f, status);
  assert.equal(signal.aborted, true);
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'next' });
  f.request({ turnId: 'turn-2' }); await settle();
  first.resolve({ action: 'accept', content: { title: 'stale' } }); await settle();
  assert.equal(result(f).length, 0);
  second.resolve({ action: 'decline' }); await settle();
  assert.notEqual(oldId, newId);
  assert.deepEqual(result(f)[0].result, { action: 'decline', content: null });
  f.request({ turnId: 'turn-1' }, 'late'); await settle();
  assert.deepEqual(result(f, 'late')[0].result, { action: 'cancel', content: null });
  assert.equal(f.adapter.closed, null);
});

test('server resolution matches request and thread, aborts UI, and suppresses late answers', async t => {
  const held = deferred(); let signal;
  const f = await fixture(t, { requestInput: (_, context) => { signal = context.signal; return held.promise; } });
  f.request(); await settle();
  f.reply({ method: 'serverRequest/resolved', params: { threadId: 'other-thread', requestId: 'elicitation-1' } });
  assert.equal(signal.aborted, false);
  f.reply({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'elicitation-1' } });
  assert.equal(signal.aborted, true);
  held.resolve({ action: 'accept', content: { title: 'too late' } }); await settle();
  assert.equal(result(f).length, 0);
  assert.equal(f.adapter.inputs.size, 0);
});

test('duplicate pending request cancels once without presenting twice', async t => {
  const held = deferred(); let calls = 0, signal;
  const f = await fixture(t, { requestInput: (_, context) => { calls++; signal = context.signal; return held.promise; } });
  f.request(); await settle(); f.request(); await settle();
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.deepEqual(result(f).map(p => p.result), [{ action: 'cancel', content: null }]);
  held.resolve({ action: 'accept', content: { title: 'old' } }); await settle();
  assert.equal(result(f).length, 1);
  assert.equal(f.adapter.closed, null);
});

test('numeric and string RPC ids stay distinct', async t => {
  const holds = [deferred(), deferred()]; let count = 0;
  const f = await fixture(t, { requestInput: () => holds[count++].promise });
  f.request({}, 1); f.request({}, '1'); await settle();
  holds[0].resolve({ action: 'decline' }); holds[1].resolve({ action: 'cancel' }); await settle();
  assert.deepEqual(result(f, 1).at(-1).result, { action: 'decline', content: null });
  assert.deepEqual(result(f, '1')[0].result, { action: 'cancel', content: null });
});

test('interrupt cancels before provider response and rejects late input', async t => {
  const held = deferred(); let signal;
  const f = await fixture(t, { requestInput: (_, context) => { signal = context.signal; return held.promise; } });
  f.request(); await settle();
  await f.adapter.interrupt({ threadId: 'thread-1', turnId: 'turn-1' });
  assert.equal(signal.aborted, true);
  assert.deepEqual(result(f)[0].result, { action: 'cancel', content: null });
  held.resolve({ action: 'accept', content: { title: 'old' } }); await settle();
  assert.equal(result(f).length, 1);
});

test('timeout cancels and aborts UI without closing session', async t => {
  let signal;
  const f = await fixture(t, { inputTimeoutMs: 5, requestInput: (_, context) => { signal = context.signal; return new Promise(() => {}); } });
  f.request(); await new Promise(r => setTimeout(r, 30));
  assert.equal(signal.aborted, true);
  assert.deepEqual(result(f)[0].result, { action: 'cancel', content: null });
  assert.equal(f.adapter.closed, null);
});

test('connection close aborts pending input without writing', async t => {
  const held = deferred(); let signal;
  const f = await fixture(t, { requestInput: (_, context) => { signal = context.signal; return held.promise; } });
  f.request(); await settle(); f.adapter.close();
  assert.equal(signal.aborted, true);
  held.resolve({ action: 'accept', content: { title: 'old' } }); await settle();
  assert.equal(result(f).length, 0);
  assert.equal(f.adapter.inputs.size, 0);
});

test('pending input is bounded without closing or presenting the overflow', async t => {
  let calls = 0;
  const f = await fixture(t, { requestInput: () => { calls++; return new Promise(() => {}); } });
  for (let i = 0; i < 33; i++) f.request({}, `request-${i}`);
  await settle();
  assert.equal(calls, 32);
  assert.deepEqual(result(f, 'request-32')[0].result, { action: 'cancel', content: null });
  assert.equal(f.adapter.closed, null);
});

test('standard scalar, titled enum, multiselect and numeric limits validate without default synthesis', async t => {
  const content = { count: -2, choice: 'blue', enabled: false, colors: ['red'], when: '2026-10-07', email: 'a@example.test' };
  const f = await fixture(t, { requestInput: () => ({ action: 'accept', content }) });
  f.request({ requestedSchema: { type: 'object', properties: {
    count: { type: 'integer', minimum: -5, maximum: 5 }, choice: { type: 'string', oneOf: [{ const: 'blue', title: 'Blue' }] },
    enabled: { type: 'boolean', default: true }, colors: { type: 'array', items: { anyOf: [{ const: 'red', title: 'Red' }] } },
    when: { type: 'string', format: 'date' }, email: { type: 'string', format: 'email' },
    optional: { type: 'string', default: 'never synthesize' }
  }, required: ['count', 'choice', 'enabled', 'colors'] } });
  await settle();
  assert.deepEqual(result(f)[0].result, { action: 'accept', content });
});

test('review regression: old server resolution cannot remove a fresh reused input RPC id', async t => {
  const held = deferred(); let calls = 0, signal;
  const f = await fixture(t, { requestInput: (_, context) => {
    if (!calls++) return { action: 'decline' };
    signal = context.signal; return held.promise;
  } });
  f.request(); await settle(); f.request(); await settle();
  f.reply({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'elicitation-1' } });
  assert.equal(signal.aborted, false);
  held.resolve({ action: 'accept', content: { title: 'fresh' } }); await settle();
  assert.deepEqual(result(f).map(p => p.result), [{ action: 'decline', content: null }, { action: 'accept', content: { title: 'fresh' } }]);
});

test('review regression: input resolution cannot remove a fresh native approval with the reused id', async t => {
  const f = await fixture(t);
  f.request(); await settle();
  f.reply({ id: 'elicitation-1', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file', startedAtMs: 1 } });
  const approval = f.events.find(e => e.type === 'approval_request').approval;
  f.reply({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'elicitation-1' } });
  f.adapter.answerApproval({ approvalId: approval.approvalId, response: { decision: 'decline' } });
  assert.deepEqual(result(f).at(-1).result, { decision: 'decline' });
});

test('review regression: synchronous abort cleanup happens only after the selected response is written', async t => {
  let f, completedAtAbort = false;
  f = await fixture(t, { requestInput: (_, { signal }) => {
    signal.addEventListener('abort', () => {
      completedAtAbort = result(f).some(p => p.result?.action === 'accept');
      complete(f);
    }, { once: true });
    return { action: 'accept', content: { title: 'current' } };
  } });
  f.request(); await settle();
  assert.equal(completedAtAbort, true, 'untrusted cleanup must not invalidate correlation before the response');
  assert.equal(result(f).length, 1);
});

test('review regression: rejected input event delivery follows the owned failure path', async t => {
  const f = await fixture(t, { requestInput: () => ({ action: 'decline' }) });
  const rejection = Promise.reject(new Error('fixture sink failure'));
  // Observe the promise in the RED version too, so failure is an assertion,
  // not an uncaught rejection leaking out of the test runner.
  rejection.catch(() => {});
  const originalEmit = f.adapter._emit.bind(f.adapter);
  f.adapter._emit = event => event.type === 'input_resolved' ? rejection : originalEmit(event);
  f.request(); await settle();
  assert.ok(f.adapter.closed, 'adapter must settle connection ownership after failed durable delivery');
});

test('review regression: RFC3339 rejects hour 24 instead of normalizing to the next day', async t => {
  const f = await fixture(t, { requestInput: () => ({ action: 'accept', content: { when: '2026-10-07T24:00:00Z' } }) });
  f.request({ requestedSchema: { type: 'object', properties: { when: { type: 'string', format: 'date-time' } }, required: ['when'] } });
  await settle();
  assert.deepEqual(result(f)[0].result, { action: 'cancel', content: null });
});

for (const scenario of ['stale', 'no-active', 'capacity', 'invalid-shape']) {
  test(`early-reply regression: ${scenario} resolution cannot consume the next RPC generation`, async t => {
    const held = deferred(); let signal;
    const f = await fixture(t, { requestInput: (_, context) => { signal = context.signal; return held.promise; } });
    if (scenario === 'no-active') complete(f);
    if (scenario === 'capacity') f.adapter.activeTurns.get('thread-1').inputCount = 256;
    f.request(scenario === 'stale' ? { turnId: 'old-turn' } : scenario === 'invalid-shape' ? { mode: 'openai/form' } : {});
    await settle();
    assert.equal(result(f).length, 1);
    if (scenario === 'no-active') await f.adapter.sendTurn({ threadId: 'thread-1', text: 'new' });
    if (scenario === 'capacity') f.adapter.activeTurns.get('thread-1').inputCount = 0;
    f.request({ turnId: scenario === 'no-active' ? 'turn-2' : 'turn-1' }); await settle();
    f.reply({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'elicitation-1' } });
    assert.equal(signal.aborted, false);
    held.resolve({ action: 'accept', content: { title: 'new generation' } }); await settle();
    assert.deepEqual(result(f).at(-1).result, { action: 'accept', content: { title: 'new generation' } });
    assert.equal(f.adapter.closed, null);
  });
}

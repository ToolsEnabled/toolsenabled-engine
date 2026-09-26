'use strict';

// THE TRANSPORT NO LONGER ANSWERS ONE LINE AT A TIME. createLineDispatcher()
// classifies each incoming line by its tool's effect and runs it under the
// scheduler; `tools.throughput = strict` puts the old chain back per lane.
// These checks drive the dispatcher with a stand-in scheduler and the real
// classifier so the wiring -- not the scheduler's own rules, which
// tests/tool-dispatch-scheduler.test.js pins -- is what is proven.

const assert = require('node:assert/strict');
const test = require('node:test');
const mcp = require('../src/mcp-server');

function recordingScheduler(mode) {
  const calls = [];
  return {
    mode,
    calls,
    run({ lane, kind }, task) { calls.push({ lane, kind }); return task(); },
    stats: () => ({ mode, calls: calls.length })
  };
}

const line = message => JSON.stringify({ jsonrpc: '2.0', ...message });

test('the classifier reads the tool effect and treats everything else as control', () => {
  assert.equal(mcp.classifyMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }), 'control');
  assert.equal(mcp.classifyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), 'control');
  assert.equal(mcp.classifyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'system.status' } }), 'read');
  assert.equal(mcp.classifyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'host.exec' } }), 'write');
  assert.equal(mcp.classifyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no.such_tool' } }), 'control');
  assert.equal(mcp.classifyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'system.status' } }, { allowedToolNames: ['host.exec'] }), 'control',
    'a tool outside the allowlist is dispatched as control so the registry can refuse it itself');
});

test('fast mode routes lines to the parallel scheduler with the caller\'s lane and the tool\'s kind', async () => {
  const parallel = recordingScheduler('parallel');
  const serial = recordingScheduler('serial');
  const handle = mcp.createLineDispatcher({ parallelScheduler: parallel, serialScheduler: serial, modeOf: () => 'fast' });
  const writes = [];
  await handle(line({ id: 1, method: 'ping' }), value => writes.push(value), {}, 'session-1');
  await handle(line({ id: 2, method: 'tools/call', params: { name: 'system.status', arguments: {} } }), value => writes.push(value), {}, 'session-1');
  assert.deepEqual(parallel.calls, [{ lane: 'session-1', kind: 'control' }, { lane: 'session-1', kind: 'read' }]);
  assert.equal(serial.calls.length, 0);
  assert.equal(writes[0].id, 1);
  assert.deepEqual(writes[0].result, {});
  assert.equal(writes[1].id, 2, 'the tool call answered (with a result or a refusal) through the dispatcher');
});

test('strict mode routes every line to the serial scheduler', async () => {
  const parallel = recordingScheduler('parallel');
  const serial = recordingScheduler('serial');
  const handle = mcp.createLineDispatcher({ parallelScheduler: parallel, serialScheduler: serial, modeOf: () => 'strict' });
  const writes = [];
  await handle(line({ id: 7, method: 'ping' }), value => writes.push(value), {}, 'session-2');
  assert.deepEqual(serial.calls, [{ lane: 'session-2', kind: 'control' }]);
  assert.equal(parallel.calls.length, 0);
  assert.equal(writes[0].id, 7);
});

test('malformed lines and notifications keep their JSON-RPC contract through the dispatcher', async () => {
  const handle = mcp.createLineDispatcher({ parallelScheduler: recordingScheduler('parallel'), serialScheduler: recordingScheduler('serial'), modeOf: () => 'fast' });
  const writes = [];
  await handle('{not-json', value => writes.push(value), {}, 'x');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].error.code, -32700);
  writes.length = 0;
  await handle(line({ method: 'notifications/initialized', params: {} }), value => writes.push(value), {}, 'x');
  await handle(line({ method: 'notifications/cancelled', params: { requestId: 99 } }), value => writes.push(value), {}, 'x');
  await handle('   ', value => writes.push(value), {}, 'x');
  assert.equal(writes.length, 0, 'notifications and blank lines never receive a response');
});

for (const mode of ['fast', 'strict']) test(`${mode}: a cancellation notification aborts the matching queued call in its lane`, async () => {
  // A scheduler that parks the task until told to run it: the call is queued,
  // the cancellation arrives, and only then does the task reach executeTool,
  // whose very first check refuses an already-aborted signal.
  let startTask;
  const parked = new Promise(resolve => { startTask = resolve; });
  const scheduler = { mode, async run(_, task) { await parked; return task(); }, stats: () => ({}) };
  const unused = recordingScheduler('unused');
  const handle = mcp.createLineDispatcher({
    parallelScheduler: mode === 'fast' ? scheduler : unused,
    serialScheduler: mode === 'strict' ? scheduler : unused,
    modeOf: () => mode
  });
  const writes = [];
  const call = handle(line({ id: 5, method: 'tools/call', params: { name: 'system.status', arguments: {} } }), value => writes.push(value), {}, 'lane-z');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handle.stats().cancellable, 1, 'the queued call holds an abort controller');
  await handle(line({ method: 'notifications/cancelled', params: { requestId: 5 } }), () => {}, {}, 'lane-z');
  startTask();
  await call;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 5, 'the cancelled call still answers its own id');
  assert.equal(writes[0].result.isError, true);
  assert.equal(writes[0].result.structuredContent.error.code, 'ABORT_ERR');
  assert.deepEqual(writes[0].result.structuredContent.error.taxonomy, {
    schemaVersion: '1.0.0', code: 'OPERATION_CANCELLED', classification: 'terminal',
    retryable: false, safeSummary: 'The operation was cancelled.'
  }, 'cancellation is terminal and never asks the caller to retry');
  assert.equal(writes[0].result.content[0].text, 'The operation was cancelled.');
  assert.match(JSON.stringify(writes[0]), /cancelled/i, 'and the answer says it was cancelled');
  assert.equal(writes[0].result.structuredContent.error.taxonomy.code, 'OPERATION_CANCELLED');
  assert.equal(writes[0].result.structuredContent.error.taxonomy.retryable, false);
  assert.equal(handle.stats().cancellable, 0, 'the controller was released after the call settled');
  assert.equal(unused.calls.length, 0, 'cancellation does not change the selected scheduling policy');
});

test('cancellation keeps source prose and details off both MCP representations', () => {
  for (const name of ['AbortError', 'StateStoreError']) {
    const result = mcp.toolError(Object.assign(new Error('synthetic private cancellation reason'), {
      name, code: 'ABORT_ERR', details: { operationId: 'synthetic-private-operation' }
    }));
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'ABORT_ERR');
    assert.equal(result.structuredContent.error.taxonomy.code, 'OPERATION_CANCELLED');
    assert.equal(result.structuredContent.error.taxonomy.classification, 'terminal');
    assert.equal(result.structuredContent.error.taxonomy.retryable, false);
    assert.equal(result.structuredContent.error.message, 'The operation was cancelled.');
    assert.equal(result.content[0].text, 'The operation was cancelled.');
    assert.equal(Object.hasOwn(result.structuredContent.error, 'details'), false);
    assert.doesNotMatch(JSON.stringify(result), /synthetic private cancellation reason|synthetic-private-operation/);
  }
});

test('a cancellation for another lane or an unknown id is ignored', async () => {
  const parallel = recordingScheduler('parallel');
  const handle = mcp.createLineDispatcher({ parallelScheduler: parallel, serialScheduler: recordingScheduler('serial'), modeOf: () => 'fast' });
  const writes = [];
  await handle(line({ method: 'notifications/cancelled', params: { requestId: 123 } }), value => writes.push(value), {}, 'lane-a');
  await handle(line({ id: 8, method: 'ping' }), value => writes.push(value), {}, 'lane-a');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 8);
});

for (const { name, target, other } of [
  { name: 'numeric and string request IDs', target: { lane: 'lane-a', id: 1 }, other: { lane: 'lane-a', id: '1' } },
  { name: 'lane and ID values containing spaces', target: { lane: 'lane-a b', id: 'c' }, other: { lane: 'lane-a', id: 'b c' } }
]) {
  test(`cancellation distinguishes ${name}`, async () => {
    let release;
    const parked = new Promise(resolve => { release = resolve; });
    const parallel = { mode: 'parallel', async run(_, task) { await parked; return task(); }, stats: () => ({}) };
    const handle = mcp.createLineDispatcher({ parallelScheduler: parallel, modeOf: () => 'fast' });
    const replies = [[], []];
    // No permission session is supplied. An uncancelled request must reach the
    // permission refusal, so no tool handler, process or provider is invoked.
    const calls = [target, other].map((request, index) => handle(line({ id: request.id, method: 'tools/call',
      params: { name: 'system.status', arguments: {} } }), value => replies[index].push(value), {}, request.lane));
    const pending = handle.stats().cancellable;
    await handle(line({ method: 'notifications/cancelled', params: { requestId: target.id } }), () => {}, {}, target.lane);
    release();
    await Promise.all(calls);
    assert.deepEqual(replies.map(rows => rows.length), [1, 1]);
    assert.equal(replies[0][0].id, target.id);
    assert.equal(replies[1][0].id, other.id);
    assert.equal(replies[0][0].result.structuredContent.error.taxonomy.code, 'OPERATION_CANCELLED', 'only the requested call is cancelled');
    assert.equal(replies[1][0].result.structuredContent.error.code, 'PERMISSION_SESSION_REQUIRED', 'the other call retains its own signal');
    assert.equal(pending, 2, 'both calls remain independently cancellable');
    assert.equal(handle.stats().cancellable, 0, 'both controller entries are released');
  });
}

for (const mode of ['strict', 'fast']) {
  test(`${mode} queued cancellation answers while the real scheduler's predecessor is still held`, async () => {
    const { createDispatchScheduler } = require('../src/lib/tool-dispatch-scheduler');
    const scheduler = createDispatchScheduler({ mode: mode === 'strict' ? 'serial' : 'parallel', readConcurrency: 1 });
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const predecessor = scheduler.run({ lane: 'cancel-queue', kind: 'read' }, () => hold);
    const handle = mcp.createLineDispatcher({ serialScheduler: scheduler, parallelScheduler: scheduler, modeOf: () => mode });
    const replies = [];
    const call = handle(line({ id: 42, method: 'tools/call', params: { name: 'system.status', arguments: {} } }),
      reply => replies.push(reply), {}, 'cancel-queue');
    try {
      await new Promise(setImmediate);
      await handle(line({ method: 'notifications/cancelled', params: { requestId: 42 } }), () => {}, {}, 'cancel-queue');
      await new Promise(setImmediate);
      assert.equal(replies.length, 1, 'the cancelled call answers before its predecessor is released');
      assert.equal(replies[0].id, 42);
      assert.equal(replies[0].result.structuredContent.error.taxonomy.code, 'OPERATION_CANCELLED');
      assert.equal(handle.stats().cancellable, 0);
      assert.equal(scheduler.stats().inFlight, 1, 'the unrelated predecessor remains active');
    } finally { release(); await Promise.all([predecessor, call]); }
    await new Promise(setImmediate);
    assert.equal(replies.length, 1, 'the old queue entry cannot answer a second time');
  });
}

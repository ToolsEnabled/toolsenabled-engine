'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');

const OPTIONS = [
  { optionId: 'always-allow', name: 'always allow', kind: 'allow_always' },
  { optionId: 'allow-once', name: 'allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'reject once', kind: 'reject_once' }
];
const CANCELLED = { outcome: { outcome: 'cancelled' } };

async function fixture(t) {
  let listener;
  const writes = [], events = [], turns = [];
  const adapter = new AcpAdapter({ transport: {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) { writes.push(JSON.parse(line)); }
  } });
  const emit = packet => listener?.(`${JSON.stringify({ jsonrpc: '2.0', ...packet })}\n`);
  adapter.onEvent(event => events.push(event));
  t.after(async () => { adapter.close(); await Promise.allSettled(turns); });
  const initialized = adapter.initialize();
  emit({ id: writes.at(-1).id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  await initialized;
  return {
    adapter, writes, events, emit,
    start(sessionId = 'session-one') {
      const pending = adapter.sendTurn({ threadId: sessionId, text: 'Read the process count.' });
      // Own rejected turns immediately, including protocol failure cases.
      pending.catch(() => {});
      turns.push(pending);
      return { pending, request: writes.at(-1) };
    },
    permission({ id = 0, sessionId = 'session-one', options = OPTIONS } = {}) {
      const count = events.length;
      emit({ id, method: 'session/request_permission', params: { sessionId,
        toolCall: { toolCallId: 'tool-one', title: 'toolsenabled__host_list_processes',
          rawInput: { nameFilter: 'ToolsEnabled' } }, options } });
      return events.slice(count).find(event => event.type === 'approval_request');
    }
  };
}

for (const option of OPTIONS) {
  test(`shared host decision selects exactly ${option.kind}`, async t => {
    const f = await fixture(t);
    f.start();
    const approval = f.permission();
    f.adapter.answerApproval({ approvalId: approval.approval.approvalId,
      response: { decision: option.optionId } });
    assert.deepEqual(f.writes.at(-1), { jsonrpc: '2.0', id: 0,
      result: { outcome: { outcome: 'selected', optionId: option.optionId } } });
    assert.throws(() => f.adapter.answerApproval({ approvalId: approval.approval.approvalId,
      response: { decision: option.optionId } }), { code: 'ACP_APPROVAL_UNKNOWN' });
  });
}

test('a session approval is never guessed from an always-allow option', async t => {
  const f = await fixture(t);
  f.start();
  const approval = f.permission();
  const before = f.writes.length;
  for (const decision of ['acceptForSession', 'accept', 'decline', 'not-offered']) {
    assert.throws(() => f.adapter.answerApproval({ approvalId: approval.approval.approvalId,
      response: { decision } }), { code: 'ACP_APPROVAL_INVALID' });
  }
  assert.equal(f.writes.length, before);
  assert.equal(f.adapter.approvals.size, 1);
});

test('native outcome answers remain supported', async t => {
  const f = await fixture(t);
  f.start();
  const approval = f.permission();
  f.adapter.answerApproval({ approvalId: approval.approval.approvalId, response: CANCELLED });
  assert.deepEqual(f.writes.at(-1).result, CANCELLED);
});

test('closing the adapter cancels pending permission requests before retiring the wire', async t => {
  const f = await fixture(t);
  f.start();
  const approval = f.permission();
  f.adapter.close();
  assert.deepEqual(f.writes.at(-1), { jsonrpc: '2.0', id: 0, result: CANCELLED });
  assert.equal(f.adapter.approvals.size, 0);
  assert.throws(() => f.adapter.answerApproval({ approvalId: approval.approval.approvalId,
    response: { decision: 'allow-once' } }), { code: 'ACP_APPROVAL_UNKNOWN' });
});

test('a broken approval response write cannot become success or a later grant', async t => {
  const f = await fixture(t);
  f.start();
  const approval = f.permission();
  const before = f.writes.length;
  f.adapter.transport.write = () => { throw new Error('fixture broken pipe'); };
  assert.throws(() => f.adapter.answerApproval({ approvalId: approval.approval.approvalId,
    response: { decision: 'allow-once' } }), { code: 'ACP_TRANSPORT_WRITE_FAILED' });
  assert.equal(f.writes.length, before);
  assert.equal(f.adapter.approvals.size, 0);
  assert.throws(() => f.adapter.answerApproval({ approvalId: approval.approval.approvalId,
    response: { decision: 'allow-once' } }), { code: 'ACP_APPROVAL_UNKNOWN' });
});

test('Stop cancels only its own pending permissions and rejects later clicks', async t => {
  const f = await fixture(t);
  f.start();
  f.start('session-two');
  const one = f.permission();
  const two = f.permission({ id: 1, sessionId: 'session-two' });
  await f.adapter.interrupt({ threadId: one.threadId, turnId: one.turnId });
  assert(f.writes.some(row => row.method === 'session/cancel' && row.params.sessionId === 'session-one'));
  assert.deepEqual(f.writes.find(row => row.id === 0 && row.result)?.result, CANCELLED);
  assert.throws(() => f.adapter.answerApproval({ approvalId: one.approval.approvalId,
    response: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }), { code: 'ACP_APPROVAL_UNKNOWN' });
  f.adapter.answerApproval({ approvalId: two.approval.approvalId,
    response: { outcome: { outcome: 'selected', optionId: 'reject-once' } } });
  assert.equal(f.writes.at(-1).id, 1);
  assert.equal(f.writes.at(-1).result.outcome.optionId, 'reject-once');
  const before = f.events.length;
  f.permission({ id: 2 });
  assert.equal(f.events.length, before, 'permission arriving after Stop must not become a new approval');
  assert.deepEqual(f.writes.at(-1), { jsonrpc: '2.0', id: 2, result: CANCELLED });
});

for (const terminal of [{ result: { stopReason: 'end_turn' } },
  { error: { code: -32603, message: 'fixture prompt failed' } }]) {
  test(`prompt ${terminal.result ? 'completion' : 'failure'} retires permissions before another wire packet`, async t => {
    const f = await fixture(t);
    const turn = f.start();
    const approval = f.permission();
    f.emit({ id: turn.request.id, ...terminal });
    // Deliberately before the promise continuation/finally gets its turn.
    assert.throws(() => f.adapter.answerApproval({ approvalId: approval.approval.approvalId,
      response: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }), { code: 'ACP_APPROVAL_UNKNOWN' });
    assert.deepEqual(f.writes.find(row => row.id === 0 && row.result)?.result, CANCELLED);
    const before = f.events.length;
    f.permission({ id: 2 });
    assert.equal(f.events.length, before);
    assert.deepEqual(f.writes.at(-1), { jsonrpc: '2.0', id: 2, result: CANCELLED });
    await Promise.allSettled([turn.pending]);
  });
}

test('a permission outside an active prompt is cancelled without a grant or UI request', async t => {
  const f = await fixture(t);
  assert.equal(f.permission({ sessionId: 'unknown-session' }), undefined);
  assert.equal(f.adapter.approvals.size, 0);
  assert.deepEqual(f.writes.at(-1), { jsonrpc: '2.0', id: 0, result: CANCELLED });
});

test('reusing a native request id cannot attach an old click to a new request', async t => {
  const f = await fixture(t);
  const firstTurn = f.start();
  const first = f.permission();
  f.adapter.answerApproval({ approvalId: first.approval.approvalId, response: CANCELLED });
  f.emit({ id: firstTurn.request.id, result: { stopReason: 'end_turn' } });
  await firstTurn.pending;
  f.start();
  const second = f.permission();
  assert.notEqual(second.approval.approvalId, first.approval.approvalId);
  assert.throws(() => f.adapter.answerApproval({ approvalId: first.approval.approvalId,
    response: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }), { code: 'ACP_APPROVAL_UNKNOWN' });
  assert.equal(f.adapter.approvals.size, 1);
});

test('numeric and string RPC ids are distinct while duplicate pending ids fail closed', async t => {
  const f = await fixture(t);
  f.start();
  const numeric = f.permission({ id: 0 });
  const string = f.permission({ id: '0' });
  assert.notEqual(numeric?.approval.approvalId, string?.approval.approvalId);
  assert.equal(f.adapter.approvals.size, 2);
  f.permission({ id: 0 });
  assert.equal(f.adapter.closed?.code, 'ACP_PROTOCOL_INVALID');
  assert.equal(f.adapter.approvals.size, 0);
});

for (const option of [{ optionId: 'yes', name: 'yes' },
  { optionId: 'yes', name: 'yes', kind: 'invented_scope' },
  { optionId: 'yes', kind: 'allow_once' }]) {
  test(`malformed permission option cannot offer a mislabeled grant: ${JSON.stringify(option)}`, async t => {
    const f = await fixture(t);
    f.start();
    assert.equal(f.permission({ options: [option] }), undefined);
    assert.equal(f.adapter.closed?.code, 'ACP_PROTOCOL_INVALID');
  });
}

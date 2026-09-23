'use strict';

// Offline protocol interleavings. The adapter is real; the transport observes
// outbound approval grants without launching a provider or using an account.
const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexAdapter, CODEX_CLI_VERSION } = require('../../src/lib/agent-engine/codex-adapter');

function fixture({ acknowledgeTurns = true } = {}) {
  let receive;
  let nextTurn = 0;
  const writes = [];
  const events = [];
  const adapter = new CodexAdapter({ codexVersion: CODEX_CLI_VERSION, transport: {
    onData(listener) { receive = listener; return () => {}; },
    write(line) {
      const packet = JSON.parse(line);
      writes.push(packet);
      if (packet.method === 'initialize') reply({ id: packet.id, result: {
        userAgent: 'offline-governance-fixture', codexHome: '/fixture', platformFamily: 'fixture', platformOs: 'fixture'
      } });
      if (packet.method === 'turn/start' && acknowledgeTurns) reply({ id: packet.id, result: { turn: { id: `turn-${++nextTurn}` } } });
    }
  } });
  function reply(packet) { receive(`${JSON.stringify(packet)}\n`); }
  adapter.onEvent(event => events.push(event));
  return { adapter, writes, events, reply };
}

const kinds = [
  { method: 'item/commandExecution/requestApproval', extra: { command: 'harmless fixture', cwd: '/fixture' },
    response: { decision: 'acceptForSession' } },
  { method: 'item/fileChange/requestApproval', extra: { grantRoot: '/fixture' },
    response: { decision: 'acceptForSession' } },
  { method: 'item/permissions/requestApproval', extra: { cwd: '/fixture', environmentId: null,
    permissions: { network: { enabled: true }, fileSystem: null } },
    response: { permissions: { network: { enabled: true }, fileSystem: null }, scope: 'session', strictAutoReview: true } }
];

function request(f, kind, { id = 'approval-rpc', threadId = 'thread-1', turnId = 'turn-1' } = {}) {
  f.reply({ id, method: kind.method, params: { threadId, turnId, itemId: `item-${String(id)}`,
    startedAtMs: 1, reason: 'governance fixture', ...kind.extra } });
  return f.events.filter(event => event.type === 'approval_request').at(-1)?.approval.approvalId;
}
function complete(f, status = 'completed') {
  f.reply({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status } } });
}
async function initialized(t, options) {
  const f = fixture(options);
  t.after(() => f.adapter.close());
  await f.adapter.initialize();
  return f;
}

for (const kind of kinds) {
  test(`${kind.method}: a live approval grants exactly once`, async t => {
    const f = await initialized(t);
    await f.adapter.sendTurn({ threadId: 'thread-1', text: 'first turn' });
    const approvalId = request(f, kind);
    assert.equal(typeof approvalId, 'string');
    f.adapter.answerApproval({ approvalId, response: kind.response });
    assert.deepEqual(f.writes.at(-1), { jsonrpc: '2.0', id: 'approval-rpc', result: kind.response });
    assert.throws(() => f.adapter.answerApproval({ approvalId, response: kind.response }), { code: 'CODEX_APPROVAL_UNKNOWN' });
  });

  for (const status of ['completed', 'interrupted', 'failed']) {
    test(`${kind.method}: ${status} retires the previous turn's approval before a new turn`, async t => {
      const f = await initialized(t);
      await f.adapter.sendTurn({ threadId: 'thread-1', text: 'first turn' });
      const approvalId = request(f, kind);
      complete(f, status);
      await f.adapter.sendTurn({ threadId: 'thread-1', text: 'second turn' });
      const before = f.writes.length;
      assert.throws(() => f.adapter.answerApproval({ approvalId, response: kind.response }),
        { code: 'CODEX_APPROVAL_UNKNOWN' }, 'an answer from a retired turn cannot grant session-wide authority');
      assert.equal(f.writes.length, before, 'no grant may be written to the provider');
    });
  }
}

test('an approval request outside an active turn fails closed without exposing a prompt', async t => {
  const f = await initialized(t);
  request(f, kinds[0]);
  assert.equal(f.events.filter(event => event.type === 'approval_request').length, 0);
  assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
});

test('a late approval request from a retired turn is refused while the next turn stays active', async t => {
  const f = await initialized(t);
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'first turn' });
  complete(f);
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'second turn' });
  request(f, kinds[0]);
  assert.equal(f.events.filter(event => event.type === 'approval_request').length, 0);
  assert.equal(f.writes.at(-1).id, 'approval-rpc');
  assert.equal(f.writes.at(-1).error?.code, -32600);
  assert.equal(f.adapter.closed, null);
  assert.equal(f.adapter.activeTurns.get('thread-1').turnId, 'turn-2');
});

test('reusing a provider RPC id cannot bind an old UI answer to a new approval', async t => {
  const f = await initialized(t);
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'first turn' });
  const oldId = request(f, kinds[0]);
  f.adapter.answerApproval({ approvalId: oldId, response: { decision: 'decline' } });
  complete(f);
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'second turn' });
  const freshId = request(f, kinds[0], { turnId: 'turn-2' });
  assert.notEqual(freshId, oldId, 'host approval handles identify individual requests, not reusable RPC ids');
  const before = f.writes.length;
  assert.throws(() => f.adapter.answerApproval({ approvalId: oldId, response: kinds[0].response }), { code: 'CODEX_APPROVAL_UNKNOWN' });
  assert.equal(f.writes.length, before);
  f.adapter.answerApproval({ approvalId: freshId, response: kinds[0].response });
  assert.deepEqual(f.writes.at(-1).result, kinds[0].response);
});

for (const selectors of [{ threadId: 'other-thread' }, { turnId: 'other-turn' }]) {
  test(`an approval for ${JSON.stringify(selectors)} cannot borrow the active turn`, async t => {
    const f = await initialized(t);
    await f.adapter.sendTurn({ threadId: 'thread-1', text: 'first turn' });
    request(f, kinds[0], selectors);
    assert.equal(f.events.filter(event => event.type === 'approval_request').length, 0);
    assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
  });
}

test('a request before the turn/start response binds to that pending turn', async t => {
  const f = await initialized(t, { acknowledgeTurns: false });
  const pending = f.adapter.sendTurn({ threadId: 'thread-1', text: 'first turn' });
  const start = f.writes.at(-1);
  const approvalId = request(f, kinds[0]);
  assert.equal(typeof approvalId, 'string');
  f.reply({ id: start.id, result: { turn: { id: 'turn-1' } } });
  await pending;
  f.adapter.answerApproval({ approvalId, response: kinds[0].response });
  assert.deepEqual(f.writes.at(-1).result, kinds[0].response);
});

test('a rejected turn/start retires approvals received before its response', async t => {
  const f = await initialized(t, { acknowledgeTurns: false });
  const pending = f.adapter.sendTurn({ threadId: 'thread-1', text: 'first turn' });
  const start = f.writes.at(-1);
  const approvalId = request(f, kinds[0]);
  f.reply({ id: start.id, error: { code: -32603, message: 'fixture start rejected' } });
  await assert.rejects(pending, { code: 'CODEX_APP_SERVER_ERROR' });
  assert.throws(() => f.adapter.answerApproval({ approvalId, response: kinds[0].response }), { code: 'CODEX_APPROVAL_UNKNOWN' });
});

test('pending RPC ids stay unique across approval kinds while numeric and string ids stay distinct', async t => {
  const f = await initialized(t);
  await f.adapter.sendTurn({ threadId: 'thread-1', text: 'first turn' });
  const first = request(f, kinds[0], { id: 1 });
  const second = request(f, kinds[1], { id: '1' });
  assert.notEqual(first, second);
  assert.equal(f.events.filter(event => event.type === 'approval_request').length, 2);
  request(f, kinds[2], { id: 1 });
  assert.equal(f.events.filter(event => event.type === 'approval_request').length, 2);
  assert.equal(f.adapter.closed?.code, 'CODEX_PROTOCOL_INVALID');
  assert.throws(() => f.adapter.answerApproval({ approvalId: first, response: kinds[0].response }), { code: 'CODEX_APPROVAL_UNKNOWN' });
});

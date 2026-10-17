'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createControlDelivery, LIMITS } = require(process.env.F1_CONTROL_TEST_MODULE || '../src/lib/control-delivery');
function controlFixture({ steer, commit = () => {}, journal = {}, clock } = {}) {
  const state = { treeKey: 'tree-a', nodeId: 'manager', sessionId: 'session-a',
    threadId: 'thread-a', turnId: 'turn-a', generation: 1, state: 'running', turn: 'running', interactionPending: false };
  const child = { ...state, nodeId: 'child', parentNodeId: 'manager', turn: 'idle' };
  const messages = [{ id: 'message-11', text: 'finish the assigned checkpoint' }];
  const calls = [];
  const adapter = steer === false ? {} : { async steerTurn(request) {
    calls.push(request); return steer ? steer(request) : { threadId: request.threadId, turnId: request.turnId }; } };
  const controller = createControlDelivery({ snapshot: id => id === 'child' ? child : id === 'manager' ? state : null,
    children: id => id === 'manager' ? ['child'] : [],
    queue: () => messages, adapter: () => adapter, format: (id, batch) => batch.map(m => m.text).join('\n'),
    commit, journal, ...(clock ? { clock } : {}) });
  const begin = (requestId = 1, timeoutMs = 100) => controller.beginBoundary({ nodeId: 'manager', requestId, timeoutMs });
  const end = (boundary, signal, nodeId = 'manager') => controller.endBoundary({ boundaryId: boundary.boundaryId, nodeId, signal });
  return { state, child, messages, calls, controller, journal, begin, end };
}
test('current turn receives one batch with provider acknowledgement and no repeated effect', async () => {
  const f = controlFixture(); const result = await f.end(f.begin());
  assert.equal(result.status, 'accepted'); assert.equal(result.modelCompliance, 'unknown');
  assert.deepEqual(f.calls[0], { threadId: 'thread-a', turnId: 'turn-a', text: 'finish the assigned checkpoint' });
  assert.equal(f.messages.length, 0); assert.equal((await f.end(f.begin(2))).status, 'empty'); assert.equal(f.calls.length, 1);
});
test('wrong tree session generation thread or turn refuses before steering', async () => {
  for (const field of ['treeKey', 'sessionId', 'generation', 'threadId', 'turnId']) {
    const f = controlFixture(); const bound = f.begin(); f.state[field] = 'changed';
    await assert.rejects(f.end(bound), { code: 'CONTROL_IDENTITY_CHANGED' });
    assert.equal(f.calls.length, 0); assert.equal(f.messages.length, 1);
  }
});
test('a different node cannot settle another node boundary', async () => {
  const f = controlFixture(); const bound = f.begin();
  await assert.rejects(f.end(bound, undefined, 'child'), { code: 'CONTROL_BOUNDARY_SCOPE_REFUSED' });
  assert.equal(f.controller.activeOperations('manager'), 1);
  assert.equal((await f.end(bound)).status, 'accepted');
});
test('missing identity is unknown and cannot start a boundary', () => {
  const f = controlFixture(); f.state.sessionId = null;
  assert.throws(() => f.begin(), { code: 'CONTROL_IDENTITY_UNKNOWN' }); assert.equal(f.calls.length, 0);
});
test('idle session tracks admitted tool operation without inventing a receiving turn', async () => {
  const f = controlFixture(); f.state.turn = 'idle'; f.state.turnId = null;
  let boundary; assert.doesNotThrow(() => { boundary = f.begin(); });
  assert.equal(Object.hasOwn(boundary.identity, 'turnId'), false);
  assert.equal(f.controller.checkpoint('manager', 'owner').status, 'draining');
  assert.throws(() => f.begin(2), { code: 'CONTROL_DRAIN_HELD' });
  assert.equal((await f.end(boundary)).reason, 'no-active-turn');
  assert.equal(f.controller.status('manager').status, 'drained');
  assert.equal(f.calls.length, 0); assert.equal(f.messages.length, 1);
});
test('idle operation never acquires a later turn as its steering recipient', async () => {
  const f = controlFixture(); f.state.turn = 'idle'; f.state.turnId = null;
  const boundary = f.begin(); f.state.turn = 'running'; f.state.turnId = 'later-turn';
  assert.equal((await f.end(boundary)).reason, 'no-active-turn'); assert.equal(f.calls.length, 0);
});
test('session work without known provider thread or turn never fabricates delivery identity', async () => {
  const f = controlFixture(); f.state.turn = 'idle'; f.state.turnId = null; f.state.threadId = null;
  let boundary; assert.doesNotThrow(() => { boundary = f.begin(); });
  assert.equal(Object.hasOwn(boundary.identity, 'threadId'), false);
  assert.equal((await f.end(boundary)).reason, 'no-active-turn'); assert.equal(f.calls.length, 0);
});
test('protocol discovery remains possible while unknown delivery still blocks protected tools', async () => {
  const f = controlFixture({ journal: { attempts: [{ identity: { nodeId: 'manager' },
    status: 'unknown', messageIds: ['message-11'] }] } });
  const protocol = f.controller.beginBoundary({ nodeId: 'manager', requestId: 'protocol', protectedWork: false });
  assert.equal((await f.end(protocol)).status, 'unknown');
  assert.throws(() => f.begin(), { code: 'CONTROL_DELIVERY_UNRESOLVED' }); assert.equal(f.calls.length, 0);
});
test('unsupported adapter retains messages and performs no alternate lifecycle', async () => {
  const f = controlFixture({ steer: false });
  assert.equal((await f.end(f.begin())).status, 'unsupported'); assert.equal(f.messages.length, 1);
  assert.equal(f.journal.attempts.length, 0);
});
test('protected concurrent operation prevents steering until the last boundary', async () => {
  const f = controlFixture(); const first = f.begin(1), second = f.begin('1');
  assert.equal((await f.end(first)).status, 'held'); assert.equal(f.calls.length, 0);
  assert.equal((await f.end(second)).status, 'accepted'); assert.equal(f.calls.length, 1);
});
test('pending human interaction prevents steering', async () => {
  const f = controlFixture(); f.state.interactionPending = true;
  assert.equal((await f.end(f.begin())).status, 'held'); assert.equal(f.calls.length, 0);
});
test('wrong acknowledgement is unresolved and cannot be replayed', async () => {
  for (const response of [{ threadId: 'wrong', turnId: 'turn-a' }, { threadId: 'thread-a', turnId: 'wrong' }]) {
    const f = controlFixture({ steer: () => response });
    assert.equal((await f.end(f.begin())).status, 'unknown'); assert.equal(f.messages.length, 1);
    assert.throws(() => f.begin(2), { code: 'CONTROL_DELIVERY_UNRESOLVED' }); assert.equal(f.calls.length, 1);
  }
});
test('lost response hits bounded deadline and remains unknown through restart', async () => {
  const f = controlFixture({ steer: () => new Promise(() => {}) });
  assert.equal((await f.end(f.begin(1, 10))).reason, 'CONTROL_DELIVERY_DEADLINE');
  assert.equal(f.messages.length, 1); assert.equal(f.calls.length, 1);
  const recovered = controlFixture({ journal: structuredClone(f.journal) });
  assert.throws(() => recovered.begin(), { code: 'CONTROL_DELIVERY_UNRESOLVED' }); assert.equal(recovered.calls.length, 0);
  assert.equal(recovered.controller.reconciliation().automaticRetry, false);
});
test('pre-request cancellation sends nothing', async () => {
  const f = controlFixture(); const abort = new AbortController(); abort.abort();
  await assert.rejects(f.end(f.begin(), abort.signal), { code: 'ABORT_ERR' }); assert.equal(f.calls.length, 0);
});
test('cancellation after submission leaves unknown and never interrupts or retries', async () => {
  const abort = new AbortController();
  const f = controlFixture({ steer: () => { abort.abort(); return new Promise(() => {}); } });
  assert.equal((await f.end(f.begin(), abort.signal)).reason, 'ABORT_ERR');
  assert.throws(() => f.begin(2), { code: 'CONTROL_DELIVERY_UNRESOLVED' }); assert.equal(f.calls.length, 1);
});
test('durability refusal precedes every provider effect', async () => {
  const f = controlFixture({ commit: () => { throw new Error('fixture storage refusal'); } });
  await assert.rejects(f.end(f.begin()), { code: 'CONTROL_DURABILITY_REQUIRED' });
  assert.equal(f.calls.length, 0); assert.equal(f.messages.length, 1);
});
test('accepted durable tombstone retires retained queue bytes after restart without replay', async () => {
  const journal = { attempts: [{ attemptId: 'old', identity: { nodeId: 'manager' }, messageIds: ['message-11'], status: 'accepted' }] };
  const f = controlFixture({ journal }); assert.equal((await f.end(f.begin())).status, 'empty');
  assert.equal(f.messages.length, 0); assert.equal(f.calls.length, 0);
});
test('recovered in-flight submission stays unknown', async () => {
  const journal = { attempts: [{ attemptId: 'old', identity: { nodeId: 'manager' }, messageIds: ['message-11'], status: 'submitting' }] };
  const f = controlFixture({ journal }); assert.throws(() => f.begin(), { code: 'CONTROL_DELIVERY_UNRESOLVED' }); assert.equal(f.calls.length, 0);
});
test('late acknowledgement from a replaced turn never clears current queue', async () => {
  const f = controlFixture({ steer: request => { f.state.turnId = 'turn-b'; return { threadId: request.threadId, turnId: request.turnId }; } });
  assert.equal((await f.end(f.begin())).status, 'unknown'); assert.equal(f.messages.length, 1);
});
test('wait wakes after registered notification and timeout is explicit', async () => {
  const f = controlFixture(); let ready = false;
  const waiting = f.controller.waitUntil(() => ready, { timeoutMs: 100 });
  ready = true; f.controller.notify(); assert.equal((await waiting).timedOut, false);
  assert.equal((await f.controller.waitUntil(() => false, { timeoutMs: 10 })).timedOut, true);
});
test('drain holds new work while exact current turn finishes with no termination', async () => {
  const f = controlFixture(); const boundary = f.begin();
  const draining = f.controller.drain('manager', 'owner', { timeoutMs: 100 });
  assert.throws(() => f.controller.admitWork('manager'), { code: 'CONTROL_DRAIN_HELD' });
  assert.throws(() => f.controller.admitWork('child'), { code: 'CONTROL_DRAIN_HELD' });
  assert.equal(f.controller.status('manager').idle, false);
  await f.end(boundary); f.state.turn = 'idle'; f.state.turnId = null; f.controller.notify();
  assert.equal((await draining).status, 'drained');
  assert.equal(f.controller.release('manager').startedWork, false);
});
test('drain deadline never claims idle or releases its hold', async () => {
  const f = controlFixture(); const result = await f.controller.drain('manager', 'owner', { timeoutMs: 10 });
  assert.equal(result.status, 'unresolved'); assert.equal(result.idle, false);
  assert.throws(() => f.controller.admitWork('manager'), { code: 'CONTROL_DRAIN_HELD' });
});
test('drain cancellation leaves admission blocked', async () => {
  const f = controlFixture(); const abort = new AbortController();
  const waiting = f.controller.drain('manager', 'owner', { timeoutMs: 100, signal: abort.signal });
  abort.abort(); await assert.rejects(waiting, { code: 'ABORT_ERR' });
  assert.throws(() => f.controller.admitWork('manager'), { code: 'CONTROL_DRAIN_HELD' });
});
test('release cannot bypass stopped session or session replacement', () => {
  const f = controlFixture(); f.controller.checkpoint('manager', 'owner'); f.state.state = 'stopped';
  assert.throws(() => f.controller.release('manager'), { code: 'CONTROL_STOP_FENCE' });
  f.state.state = 'running'; f.state.sessionId = 'replaced';
  assert.throws(() => f.controller.release('manager'), { code: 'CONTROL_SESSION_CHANGED' });
});
test('checkpoint on already idle session is observed without inventing active turn', () => {
  const f = controlFixture(); f.state.turn = 'idle'; f.state.turnId = null;
  assert.equal(f.controller.checkpoint('manager', 'owner').status, 'drained');
});
test('deadline and duplicate typed request bounds are enforced', () => {
  const f = controlFixture(); for (const value of [0, -1, LIMITS.deadlineMs + 1, 1.5])
    assert.throws(() => f.begin(1, value), { code: 'CONTROL_DEADLINE_INVALID' });
  f.begin(1); assert.throws(() => f.begin(1), { code: 'CONTROL_REQUEST_DUPLICATE' }); f.begin('1');
  for (const value of [true, {}]) assert.throws(() => f.begin(value), { code: 'CONTROL_REQUEST_INVALID' });
  f.begin(null);
});
test('cyclic tree refuses work admission without a guessed ancestor', () => {
  const f = controlFixture(); f.child.parentNodeId = 'child';
  assert.throws(() => f.controller.admitWork('child'), { code: 'CONTROL_TREE_INVALID' });
});
test('a settled or absent boundary refuses duplicate settlement', async () => {
  const f = controlFixture(); const bound = f.begin(); await f.end(bound);
  await assert.rejects(f.end(bound), { code: 'CONTROL_BOUNDARY_UNKNOWN' }); assert.equal(f.calls.length, 1);
});
test('journal and active-operation limits refuse rather than discard history', async () => {
  const f = controlFixture(); for (let i = 0; i < LIMITS.operations; i++) f.begin(i);
  assert.throws(() => f.begin(LIMITS.operations + 1), { code: 'CONTROL_OPERATION_LIMIT' });
  const full = controlFixture({ journal: { attempts: Array.from({ length: LIMITS.attempts }, () => ({ identity: { nodeId: 'other' }, status: 'unknown', messageIds: [] })) } });
  await assert.rejects(full.end(full.begin()), { code: 'CONTROL_JOURNAL_FULL' }); assert.equal(full.calls.length, 0);
});
test('submitting delivery prevents new protected work admission until acknowledgement', async () => {
  let resolve; const f = controlFixture({ steer: request => new Promise(done => { resolve = () => done({ threadId: request.threadId, turnId: request.turnId }); }) });
  const submitted = f.end(f.begin()); await new Promise(done => setImmediate(done));
  assert.throws(() => f.begin(2), { code: 'CONTROL_DELIVERY_UNRESOLVED' });
  resolve(); assert.equal((await submitted).status, 'accepted');
});
test('interaction becoming protected at persistence fence prevents provider request', async () => {
  const f = controlFixture({ commit: () => { f.state.interactionPending = true; } });
  assert.equal((await f.end(f.begin())).reason, 'CONTROL_OPERATION_PROTECTED'); assert.equal(f.calls.length, 0);
});
test('late response stays unknown even when the event loop delays its timer', async () => {
  let tick = 0; const f = controlFixture({ clock: () => tick, steer: request => {
    tick = 11; return { threadId: request.threadId, turnId: request.turnId }; } });
  assert.equal((await f.end(f.begin(1, 10))).reason, 'CONTROL_DELIVERY_DEADLINE'); assert.equal(f.messages.length, 1);
});
test('idle drain remains unresolved for its own or descendant uncertain delivery', async () => {
  for (const owner of ['manager', 'child']) {
    const f = controlFixture({ journal: { attempts: [{ attemptId: 'lost', identity: { nodeId: owner },
      messageIds: ['message-11'], status: 'unknown', reason: 'CONTROL_PROVIDER_RESPONSE_LOST' }] } });
    f.state.turn = 'idle'; f.state.turnId = null;
    const result = f.controller.checkpoint('manager', 'owner');
    assert.equal(result.status, 'unresolved'); assert.equal(result.idle, false); assert.equal(result.unresolvedDeliveries, 1);
    assert.equal((await f.controller.drain('manager', 'owner', { timeoutMs: 5 })).idle, false);
  }
});
test('descendant work and replaced session prevent manager drained state', () => {
  const f = controlFixture(); f.state.turn = 'idle'; f.child.turn = 'running';
  assert.equal(f.controller.checkpoint('manager', 'owner').status, 'draining');
  f.child.turn = 'idle'; assert.equal(f.controller.status('manager').status, 'drained');
  f.child.sessionId = 'replaced'; assert.equal(f.controller.status('manager').status, 'unresolved');
});
test('accepted history beyond active capacity is preserved and still retires queue on recovery', async () => {
  const accepted = Array.from({ length: LIMITS.attempts }, (_, i) => ({ attemptId: 'past-' + i,
    identity: { nodeId: 'other' }, status: 'accepted', messageIds: ['old-' + i] }));
  const f = controlFixture({ journal: { attempts: structuredClone(accepted) } });
  let result; await assert.doesNotReject(async () => { result = await f.end(f.begin()); });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(f.journal.history, accepted); assert.equal(f.journal.attempts.length, 1);
  const saved = structuredClone(f.journal); saved.history.push(saved.attempts.pop());
  const recovered = controlFixture({ journal: saved });
  assert.equal((await recovered.end(recovered.begin())).status, 'empty');
  assert.equal(recovered.calls.length, 0); assert.equal(recovered.journal.history.length, LIMITS.attempts + 1);
});
test('drain scope refuses cycles or more than 4096 nodes before holding work', () => {
  for (const cyclic of [true, false]) {
    let writes = 0;
    const control = createControlDelivery({ snapshot: nodeId => ({ treeKey: 'fixture', nodeId,
      sessionId: 's', threadId: 't', generation: 1, turnId: null, state: 'running', turn: 'idle' }),
      children: id => cyclic ? [id] : Number(id) < 4096 ? [String(Number(id) + 1)] : [],
      queue: () => [], adapter: () => ({}), format: () => '', commit: () => { writes++; } });
    assert.throws(() => control.checkpoint('0', 'owner'), { code: 'CONTROL_TREE_INVALID' });
    assert.equal(writes, 0);
  }
});
test('formatted batch over the declared character bound stays held without provider effect', async () => {
  const f = controlFixture(); f.messages[0].text = 'x'.repeat(LIMITS.chars + 1);
  assert.equal((await f.end(f.begin())).status, 'held');
  assert.equal(f.messages.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.journal.attempts.length, 0);
});
test('unknown starting descendant identity retains a hold and cannot claim drained', () => {
  const f = controlFixture(); f.state.turn = 'idle'; f.child.sessionId = null; f.child.state = 'starting';
  const result = f.controller.checkpoint('manager', 'owner');
  assert.equal(result.status, 'unresolved'); assert.equal(result.reason, 'descendant-identity-unknown');
  assert.equal(result.newWorkHeld, true); assert.equal(result.idle, false);
  assert.throws(() => f.controller.admitWork('child'), { code: 'CONTROL_DRAIN_HELD' });
});

// Found by the per-provider review of the Windows host line's d4fa08a: an
// attempt that never reached the provider was recorded as unknown, which then
// refused every later tool call of that worker, across restarts.
test('an adapter refusal before sending leaves no unresolved attempt and keeps the messages', async () => {
  const f = controlFixture({ steer: () => { throw Object.assign(new Error('turn changed'), { code: 'FIXTURE_TURN_CHANGED', notSubmitted: true }); } });
  const result = await f.end(f.begin());
  assert.equal(result.status, 'not-delivered'); assert.equal(result.reason, 'FIXTURE_TURN_CHANGED');
  assert.equal(f.messages.length, 1); assert.equal(f.journal.attempts.length, 0);
  assert.ok(f.begin(2).boundaryId, 'later protected work is admitted');
});
test('a check that fails before the provider request records nothing uncertain', async () => {
  const f = controlFixture({ commit: () => { f.state.interactionPending = true; } });
  const result = await f.end(f.begin());
  assert.equal(result.status, 'not-delivered'); assert.equal(result.reason, 'CONTROL_OPERATION_PROTECTED');
  assert.equal(f.calls.length, 0); assert.equal(f.journal.attempts.length, 0);
});
test('a failure after the request was sent stays unknown', async () => {
  const f = controlFixture({ steer: () => { throw Object.assign(new Error('lost'), { code: 'FIXTURE_LOST' }); } });
  assert.equal((await f.end(f.begin())).status, 'unknown');
  assert.throws(() => f.begin(2), { code: 'CONTROL_DELIVERY_UNRESOLVED' });
});
test('retire removes a node\'s open boundaries and frees their request ids', () => {
  const f = controlFixture(); f.begin(7);
  assert.equal(f.controller.activeOperations('manager'), 1);
  assert.equal(f.controller.retire('manager'), 1);
  assert.equal(f.controller.activeOperations('manager'), 0);
  assert.ok(f.begin(7).boundaryId);
});

'use strict';

// MULTIPLE QUEUES THAT RECONCILE. Reads run side by side; writes keep their
// order per lane and run side by side across lanes; exclusive tasks run one
// at a time across the process; control messages never queue; serial mode is
// the old single chain per lane. A read never waits behind a write.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDispatchScheduler, dispatchKindOf } = require('../src/lib/tool-dispatch-scheduler');

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('reads run concurrently, bounded by the read limit', async () => {
  const scheduler = createDispatchScheduler({ readConcurrency: 3 });
  const gates = [gate(), gate(), gate(), gate()];
  let started = 0;
  const tasks = gates.map(g => scheduler.run({ lane: 'a', kind: 'read' }, async () => { started += 1; await g.promise; return started; }));
  await tick();
  assert.equal(started, 3, 'three reads started at once, the fourth waits for a permit');
  gates[0].release();
  await tick(); await tick();
  assert.equal(started, 4, 'the fourth read started when a permit freed');
  gates.slice(1).forEach(g => g.release());
  await Promise.all(tasks);
  assert.equal(scheduler.stats().read, 4);
});

test('writes keep their order within a lane and run side by side across lanes', async () => {
  const scheduler = createDispatchScheduler();
  const order = [];
  const first = gate();
  const laneA1 = scheduler.run({ lane: 'a', kind: 'write' }, async () => { order.push('a1-start'); await first.promise; order.push('a1-end'); });
  const laneA2 = scheduler.run({ lane: 'a', kind: 'write' }, async () => { order.push('a2'); });
  const laneB1 = scheduler.run({ lane: 'b', kind: 'write' }, async () => { order.push('b1'); });
  await tick(); await tick();
  assert.deepEqual(order, ['a1-start', 'b1'], 'lane b ran while lane a was still busy; a2 waited for a1');
  first.release();
  await Promise.all([laneA1, laneA2, laneB1]);
  assert.deepEqual(order, ['a1-start', 'b1', 'a1-end', 'a2']);
});

test('a read never waits behind a write in the same lane', async () => {
  const scheduler = createDispatchScheduler();
  const hold = gate();
  const order = [];
  const write = scheduler.run({ lane: 'a', kind: 'write' }, async () => { await hold.promise; order.push('write'); });
  const read = scheduler.run({ lane: 'a', kind: 'read' }, async () => { order.push('read'); });
  await read;
  assert.deepEqual(order, ['read']);
  hold.release();
  await write;
});

test('exclusive tasks run one at a time across every lane', async () => {
  const scheduler = createDispatchScheduler();
  const hold = gate();
  const order = [];
  const one = scheduler.run({ lane: 'a', kind: 'exclusive' }, async () => { order.push('one-start'); await hold.promise; order.push('one-end'); });
  const two = scheduler.run({ lane: 'b', kind: 'exclusive' }, async () => { order.push('two'); });
  await tick(); await tick();
  assert.deepEqual(order, ['one-start']);
  hold.release();
  await Promise.all([one, two]);
  assert.deepEqual(order, ['one-start', 'one-end', 'two']);
});

test('a rejected task does not poison its lane', async () => {
  const scheduler = createDispatchScheduler();
  await assert.rejects(scheduler.run({ lane: 'a', kind: 'write' }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await scheduler.run({ lane: 'a', kind: 'write' }, async () => 'after'), 'after');
  await assert.rejects(scheduler.run({ lane: 'a', kind: 'exclusive' }, async () => { throw new Error('boom2'); }), /boom2/);
  assert.equal(await scheduler.run({ lane: 'b', kind: 'exclusive' }, async () => 'after2'), 'after2');
});

test('serial mode is one chain per lane regardless of kind', async () => {
  const scheduler = createDispatchScheduler({ mode: 'serial' });
  const hold = gate();
  const order = [];
  const write = scheduler.run({ lane: 'a', kind: 'write' }, async () => { await hold.promise; order.push('write'); });
  const read = scheduler.run({ lane: 'a', kind: 'read' }, async () => { order.push('read'); });
  const other = scheduler.run({ lane: 'b', kind: 'read' }, async () => { order.push('other-lane'); });
  await other;
  await tick();
  assert.deepEqual(order, ['other-lane'], 'the read waited behind the write in its own lane; another lane ran');
  hold.release();
  await Promise.all([write, read]);
  assert.deepEqual(order, ['other-lane', 'write', 'read']);
  assert.equal(scheduler.mode, 'serial');
});

test('dispatchKindOf classifies by effect and honours an exclusive declaration', () => {
  assert.equal(dispatchKindOf({ effect: 'local-read' }), 'read');
  assert.equal(dispatchKindOf({ effect: 'external-read' }), 'read');
  assert.equal(dispatchKindOf({ effect: 'local-write' }), 'write');
  assert.equal(dispatchKindOf({ effect: 'external-write' }), 'write');
  assert.equal(dispatchKindOf({ effect: 'local-read', dispatch: 'exclusive' }), 'exclusive');
  assert.equal(dispatchKindOf(undefined), 'control');
});

for (const kind of ['read', 'write', 'exclusive']) {
  test(`cancelling a queued ${kind} settles before the occupied slot is released`, async () => {
    const scheduler = createDispatchScheduler({ readConcurrency: 1, writeConcurrency: 1 });
    const hold = gate();
    const first = scheduler.run({ lane: 'first', kind }, () => hold.promise);
    await tick();
    const controller = new AbortController();
    let invoked = 0, settled = false;
    const second = scheduler.run({ lane: 'second', kind, signal: controller.signal }, () => { invoked += 1; });
    const result = second.then(() => ({ ok: true }), error => ({ error })).then(value => { settled = true; return value; });
    try {
      controller.abort(new Error('private caller reason'));
      await tick();
      assert.equal(settled, true, 'cancellation must not wait for an unrelated task to finish');
      const value = await result;
      assert.equal(value.error?.code, 'ABORT_ERR');
      assert.equal(value.error?.name, 'AbortError');
      assert.doesNotMatch(value.error.message, /private caller reason/);
      assert.equal(invoked, 0);
      assert.equal(scheduler.stats().inFlight, 1, 'the original task retains its permit');
      if (kind === 'read') assert.equal(scheduler.stats().readsWaiting, 0);
      if (kind === 'write') assert.equal(scheduler.stats().writesWaiting, 0);
    } finally { hold.release(); await Promise.all([first, result]); }
    await tick();
    assert.equal(invoked, 0, 'a cancelled task never runs when the slot later opens');
    assert.equal(scheduler.stats().inFlight, 0);
    assert.equal(scheduler.stats().readsActive, 0);
    assert.equal(scheduler.stats().writesActive, 0);
  });
}

for (const mode of ['serial', 'parallel']) {
  test(`a cancelled ${mode} lane entry cannot let its successor overtake active work`, async () => {
    const scheduler = createDispatchScheduler({ mode });
    const hold = gate(), order = [];
    const first = scheduler.run({ lane: 'same', kind: 'write' }, async () => { order.push('first-start'); await hold.promise; order.push('first-end'); });
    const controller = new AbortController();
    let settled = false;
    const cancelled = scheduler.run({ lane: 'same', kind: 'write', signal: controller.signal }, () => order.push('cancelled'))
      .then(() => 'ran', error => { settled = true; return error.code; });
    const last = scheduler.run({ lane: 'same', kind: 'write' }, () => order.push('last'));
    try {
      await tick(); controller.abort(); await tick();
      assert.equal(settled, true);
      assert.deepEqual(order, ['first-start']);
      assert.equal(await cancelled, 'ABORT_ERR');
    } finally { hold.release(); await Promise.all([first, cancelled, last]); }
    assert.deepEqual(order, ['first-start', 'first-end', 'last']);
    await tick();
    assert.equal(scheduler.stats().lanes, 0);
  });
}

test('cancelling an already running task keeps its actual outcome and permit until it finishes', async () => {
  const scheduler = createDispatchScheduler({ readConcurrency: 1 });
  const hold = gate(), controller = new AbortController();
  let settled = false, nextStarted = false;
  const first = scheduler.run({ kind: 'read', signal: controller.signal }, async () => { await hold.promise; return 'actual-result'; })
    .then(value => { settled = true; return value; });
  await tick();
  const next = scheduler.run({ kind: 'read' }, () => { nextStarted = true; });
  try {
    controller.abort(); await tick();
    assert.equal(settled, false, 'running work must finish through its own cancellation handling');
    assert.equal(nextStarted, false, 'abort alone cannot free an occupied permit');
    assert.equal(scheduler.stats().readsActive, 1);
  } finally { hold.release(); await Promise.all([first, next]); }
  assert.equal(await first, 'actual-result');
  assert.equal(nextStarted, true);
});

test('cancellation before the first task microtask returns an acquired permit without invoking the task', async () => {
  const { getEventListeners } = require('node:events');
  const scheduler = createDispatchScheduler({ readConcurrency: 1 });
  const controller = new AbortController();
  let invoked = 0;
  const task = scheduler.run({ kind: 'read', signal: controller.signal }, () => { invoked += 1; });
  controller.abort();
  await assert.rejects(task, error => error.code === 'ABORT_ERR');
  await tick();
  assert.equal(invoked, 0);
  assert.equal(scheduler.stats().readsActive, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(scheduler.run({ kind: 'read', signal: controller.signal }, () => { invoked += 1; }), error => error.code === 'ABORT_ERR');
  assert.equal(invoked, 0, 'an already aborted call never enters the queue');
  assert.equal(await scheduler.run({ kind: 'read' }, () => 'next'), 'next');
});

'use strict';

// THE MEMORY-MUTATION AUDIT EVENT LEAVES THE MAIN THREAD -- WITHOUT LEAVING.
//
// memory.mutation is n=93 in Builder 5's full-record ranking. The event was
// recorded with the SYNCHRONOUS coordinatorAudit.write(), which runs the whole
// admission (writer-lock spin, projection digests, redaction) on the caller's
// thread, while the off-thread route (writeAsync -> the group-commit queue)
// already existed and was wired for policy and approval decisions only.
//
// THE POINT OF THESE TESTS IS THE SECOND HALF OF THAT SENTENCE. A repair that
// trades a stall for a lost record is a worse product than the stall, so every
// assertion here is about the record STILL BEING WRITTEN -- to the queue in
// fast mode, and synchronously in strict mode -- never about the call
// returning sooner. Nothing here measures time.

const assert = require('node:assert/strict');
const test = require('node:test');
const memory = require('../src/lib/providers/memory');
const throughput = require('../src/lib/throughput-mode');

const VALUE_HASH = 'a'.repeat(64);

function fakeState(saved = {}) {
  return {
    setMemory: () => ({
      entry: {
        namespace: 'notes', key: 'k1', valueHash: VALUE_HASH, revision: 3,
        createdAt: '2026-09-06T00:00:00.000Z', createdAtMs: 1788000000000,
        updatedAt: '2026-09-06T00:00:01.000Z', updatedAtMs: 1788000001000
      },
      created: false,
      replayed: false,
      ...saved
    })
  };
}

function fakeQueue() {
  const submitted = [];
  return {
    submitted,
    submit: item => { submitted.push(item); return Promise.resolve({ ok: true, durable: true, anchored: false }); }
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a memory mutation still records its audit event, admitted through the queue rather than the caller thread', async () => {
  const queue = fakeQueue();
  const state = fakeState();

  const output = memory.set({ namespace: 'notes', key: 'k1', value: 'v' }, { state, admissionQueue: queue });

  // The local mutation is returned to the caller as before.
  assert.equal(output.namespace, 'notes');
  assert.equal(output.key, 'k1');
  assert.equal(output.revision, 3);

  await settle();

  // THE RECORD MUST EXIST. A "fix" that simply stopped writing would pass any
  // timing assertion and fail this one.
  assert.equal(queue.submitted.length, 1, 'the memory mutation must still be recorded, not dropped');
  const item = queue.submitted[0];
  assert.equal(item.action, 'coordinator.audit.memory.mutation');
  assert.equal(item.anchorRequired, false, 'this event is required:false and must not start demanding an anchor');
  assert.equal(typeof item.eventId, 'string');
  assert.ok(item.eventId.length > 0, 'the content-derived event id write() would have used must survive');
  assert.equal(item.occurredAtMs, 1788000001000, 'the event keeps the mutation time, not the admission time');
  // The record must still DESCRIBE the mutation, not just exist.
  assert.equal(item.details.kind, 'memory.mutation');
  assert.equal(item.details.hashes.memoryValue, VALUE_HASH, 'the recorded event must still carry the mutated value hash');
  assert.equal(item.details.summary.revision, 3, 'and the revision it recorded');
});

test('the audit record is not awaited, so an unavailable audit store cannot throw away a committed local write', async () => {
  const state = fakeState();
  const queue = {
    submitted: [],
    submit: item => { queue.submitted.push(item); return Promise.reject(new Error('audit store unreachable')); }
  };

  // The local mutation has already committed by the time the event is
  // recorded; a failing audit sink must not turn that into a thrown call.
  const output = memory.set({ namespace: 'notes', key: 'k1', value: 'v' }, { state, admissionQueue: queue });
  assert.equal(output.revision, 3);
  await settle();
  assert.equal(queue.submitted.length, 1, 'the attempt is still made');
});

test('with grouping off (strict), the record is still written synchronously and is not silently queued away', async () => {
  // The module's own test seam, not the env var: throughputMode() caches its
  // answer for 5 s, so setting the environment after first read would be
  // ignored and this test would silently assert nothing.
  throughput.setThroughputModeForTests('strict');
  try {
    const recorded = [];
    const queue = fakeQueue();
    const state = fakeState();

    memory.set({ namespace: 'notes', key: 'k1', value: 'v' }, {
      state,
      admissionQueue: queue,
      auditRecord: (action, target, details) => {
        recorded.push({ action, target, details });
        return { ok: true, durable: true, recorded: true, projected: true, partial: false, anchored: false, errors: [] };
      }
    });
    await settle();

    assert.equal(recorded.length, 1, 'strict mode must still record, on the caller thread as before');
    assert.equal(recorded[0].action, 'coordinator.audit.memory.mutation');
    assert.equal(queue.submitted.length, 0, 'strict mode must NOT divert the record to the group-commit queue');
  } finally {
    throughput.setThroughputModeForTests(null);
  }
});

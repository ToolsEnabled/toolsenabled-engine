'use strict';

/* WHEN ADMISSION FALLS BACK ONTO THE CALLING THREAD, IT MUST LEAVE A TRACE.
 *
 * The queue admits batches on a worker so the ledger's synchronous SQLite and
 * vault work never blocks the thread the desktop app draws on. If the worker
 * cannot start, or answers wrongly, admission moves back in-thread and keeps
 * going. That is the right behaviour -- durability must not depend on a thread
 * starting -- but the only evidence was one stderr line, and stderr here is
 * collected nowhere. So "did admission fall back during that stall?" could only
 * ever be answered "I could not look", which is a strictly weaker claim than
 * "it did not happen".
 *
 * These cases pin the difference. Nothing here asserts on stderr; they assert
 * that the fallback is COUNTED and leaves a DURABLE line, and that a healthy
 * worker produces neither.
 *
 *   node --test tests/audit-admission-fallback-sink.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdmissionQueue } = require('../src/lib/audit-admission');

function fakeStatus(index) {
  return {
    ok: true, durable: true, projected: true, recorded: true, partial: false, anchored: true,
    protectedSequence: 100 + index, disabled: false, eventId: `evt-${index}`, sequence: 100 + index,
    eventHash: 'a'.repeat(64), sinks: { jsonl: true, text: true }, pending: 0, errors: []
  };
}

function sinkPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b3-admission-')), 'fallbacks.jsonl');
}

const linesIn = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

// A stand-in for the real worker thread. `reply` decides what it answers with.
function fakeWorker(reply) {
  const handlers = new Map();
  return {
    on(event, handler) { handlers.set(event, handler); },
    unref() {}, ref() {}, terminate() {},
    postMessage(message) {
      queueMicrotask(() => {
        const handler = handlers.get('message');
        if (handler) handler(reply(message));
      });
    }
  };
}

/* The queue only reaches its worker branch when it is NOT given a recordBatch,
   so the in-thread admission is injected through the audit api instead. */
function queueWith({ startWorker, fallbackFile, admitted = items => items.map((item, index) => fakeStatus(index)) }) {
  return createAdmissionQueue({
    coalesceMs: 0,
    worker: true,
    startWorker,
    fallbackFile,
    reportError: () => {},
    audit: { recordBatch: admitted }
  });
}

test('a worker that cannot start is counted and leaves a durable line, and the record is still admitted', async () => {
  const file = sinkPath();
  const queue = queueWith({ startWorker: () => null, fallbackFile: file });

  const status = await queue.submit({ action: 'mcp.tool.succeeded', target: 'a', details: {} });

  assert.equal(status.ok, true, 'falling back must not cost the caller its record');
  assert.equal(queue.stats().workerFallbacks, 1,
    'a worker that cannot start is a fallback and must be counted as one');
  const lines = linesIn(file);
  assert.equal(lines.length, 1, 'the fallback must leave exactly one durable line');
  assert.equal(lines[0].reason, 'worker-unavailable');
  assert.equal(typeof lines[0].at, 'string', 'the line must say when');
  assert.equal(lines[0].pid, process.pid, 'and which process');
});

test('a worker that answers malformedly is counted and recorded too, under its own reason', async () => {
  const file = sinkPath();
  const queue = queueWith({
    startWorker: () => fakeWorker(message => ({ id: message.id, result: ['too', 'many', 'statuses'] })),
    fallbackFile: file
  });

  const status = await queue.submit({ action: 'mcp.tool.succeeded', target: 'b', details: {} });

  assert.equal(status.ok, true);
  assert.equal(queue.stats().workerFallbacks, 1);
  const lines = linesIn(file);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'malformed-reply',
    'a wrong answer and an absent worker are different failures and must not share a label');
});

/* The control. If this ever goes red alongside the others, the suite is
   detecting an edit rather than the defect. */
test('a healthy worker writes nothing and counts nothing', async () => {
  const file = sinkPath();
  const queue = queueWith({
    startWorker: () => fakeWorker(message => ({ id: message.id, result: message.items.map((item, index) => fakeStatus(index)) })),
    fallbackFile: file
  });

  const status = await queue.submit({ action: 'mcp.tool.succeeded', target: 'c', details: {} });

  assert.equal(status.ok, true);
  assert.equal(queue.stats().workerFallbacks, 0, 'a healthy worker is not a fallback');
  assert.equal(queue.stats().workerBatches, 1);
  assert.equal(linesIn(file).length, 0, 'nothing to report means nothing written');
});

/* The sink runs on an error path. If it cannot write, that is one more thing
   to count -- never a reason to fail the admission it was only observing. */
test('a sink that cannot be written is counted, and admission still succeeds', async () => {
  const unwritable = path.join(os.tmpdir(), 'b3-admission-nonexistent-dir', 'nested', 'fallbacks.jsonl');
  const queue = queueWith({ startWorker: () => null, fallbackFile: unwritable });

  const status = await queue.submit({ action: 'mcp.tool.succeeded', target: 'd', details: {} });

  assert.equal(status.ok, true, 'a broken log must not cost the caller its record');
  assert.equal(queue.stats().workerFallbacks, 1, 'the fallback still happened and is still counted');
  assert.equal(queue.stats().fallbackSinkFailures, 1, 'and the unwritable sink is itself visible');
});

'use strict';

// THE GROUP-COMMIT QUEUE: records that arrive together share one admission,
// every caller gets exactly its own status back, order within a batch is
// arrival order, a failing batch fails every waiter honestly, and an item
// that asked for the anchor is refused by the requireRecord contract when the
// batch did not make it durable.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAdmissionQueue, failedStatus } = require('../src/lib/audit-admission');
const audit = require('../src/lib/audit');

function fakeStatus(index, extra = {}) {
  return {
    ok: true, durable: true, projected: true, recorded: true, partial: false, anchored: true,
    protectedSequence: 100 + index, disabled: false, eventId: `evt-${index}`, sequence: 100 + index,
    eventHash: 'a'.repeat(64), sinks: { jsonl: true, text: true }, pending: 0, errors: [], ...extra
  };
}

test('records submitted in the same tick are admitted as one batch, in order, each getting its own status', async () => {
  const batches = [];
  const queue = createAdmissionQueue({
    coalesceMs: 5,
    recordBatch: items => { batches.push(items.map(item => item.target)); return items.map((item, index) => fakeStatus(index, { eventId: item.target })); }
  });
  const results = await Promise.all(['a', 'b', 'c', 'd'].map(target => queue.submit({ action: 'mcp.tool.succeeded', target, details: {} })));
  assert.deepEqual(batches, [['a', 'b', 'c', 'd']], 'one batch, arrival order');
  assert.deepEqual(results.map(status => status.eventId), ['a', 'b', 'c', 'd'], 'each caller received its own status');
  assert.equal(queue.stats().batches, 1);
  assert.equal(queue.stats().largestBatch, 4);
});

test('records that arrive while a batch is in flight form the next batch', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const batches = [];
  const queue = createAdmissionQueue({
    coalesceMs: 0,
    recordBatch: items => { batches.push(items.length); return items.map((item, index) => fakeStatus(index)); }
  });
  // First submit starts a batch on its own; the drain awaits the async
  // recordBatch below, so the two later submits queue behind it.
  const slowQueue = createAdmissionQueue({
    coalesceMs: 0,
    recordBatch: async items => { batches.push(items.length); if (batches.length === 1) await gate; return items.map((item, index) => fakeStatus(index)); }
  });
  const first = slowQueue.submit({ action: 'x', target: '1', details: {} });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = slowQueue.submit({ action: 'x', target: '2', details: {} });
  const third = slowQueue.submit({ action: 'x', target: '3', details: {} });
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(batches, [1, 2], 'the second and third records shared the batch after the one in flight');
  assert.equal(queue.stats().batches, 0);
});

test('a batch that throws fails every waiter with a non-durable status', async () => {
  const queue = createAdmissionQueue({
    coalesceMs: 0,
    reportError: () => {},
    recordBatch: () => { const error = new Error('ledger down'); error.code = 'AUDIT_UNAVAILABLE'; throw error; }
  });
  const statuses = await Promise.all([
    queue.submit({ action: 'x', target: '1', details: {} }),
    queue.submit({ action: 'mcp.tool.intent', target: '2', details: {}, anchorRequired: true })
  ]);
  for (const status of statuses) {
    assert.equal(status.ok, false);
    assert.equal(status.durable, false);
    assert.equal(status.errors[0].code, 'AUDIT_UNAVAILABLE');
  }
  assert.throws(() => audit.requireDurableStatus(statuses[1]), /Durable audit intent could not be recorded/,
    'an anchored request that did not land is refused exactly as requireRecord refuses it');
  assert.equal(queue.stats().failed, 2);
});

test('failedStatus has the shape of an audit status', () => {
  const status = failedStatus(Object.assign(new Error('x'), { code: 'AUDIT_X' }));
  for (const key of ['ok', 'durable', 'projected', 'anchored', 'sequence', 'eventHash', 'sinks', 'errors']) {
    assert.ok(Object.prototype.hasOwnProperty.call(status, key), key);
  }
  assert.equal(status.errors[0].code, 'AUDIT_X');
});

test('flush admits everything queued and waits for the batch in flight', async () => {
  const seen = [];
  const queue = createAdmissionQueue({
    coalesceMs: 50,
    recordBatch: items => { seen.push(...items.map(item => item.target)); return items.map((item, index) => fakeStatus(index)); }
  });
  const pending = [queue.submit({ action: 'x', target: 'a', details: {} }), queue.submit({ action: 'x', target: 'b', details: {} })];
  assert.equal(queue.size(), 2, 'nothing admitted before the coalesce window');
  await queue.flush();
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(queue.size(), 0);
  await Promise.all(pending);
});

test('configured zero-window batches retain their size limit and close waits for all admitted work', async () => {
  const batches = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const queue = createAdmissionQueue({
    performanceSettings: () => ({ 'tools.audit_batch_window_ms': 0, 'tools.audit_batch_size': 2 }),
    recordBatch: async items => {
      batches.push(items.map(item => item.target));
      await held;
      return items.map((item, index) => fakeStatus(index, { eventId: item.target }));
    },
  });
  const pending = ['a', 'b', 'c', 'd', 'e'].map(target => queue.submit({ action: 'x', target, details: {} }));
  let closed = false;
  const closing = queue.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'close must not discard the in-flight batch');
  release();
  await closing;
  assert.deepEqual(batches, [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual((await Promise.all(pending)).map(status => status.eventId), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(queue.size(), 0);
});


test('idle retirement drains admitted audit work without a shutdown timeout and closes the owned worker once', async () => {
  const { EventEmitter } = require('node:events');
  let active, answer, closes = 0, terminations = 0, retired = false;
  const queue = createAdmissionQueue({ worker: true, coalesceMs: 0, maxBatch: 8,
    performanceSettings: () => ({}), startWorker({ onExit }) {
      active = new EventEmitter(); active.unref = () => {};
      active.terminate = async () => { terminations++; onExit(1); };
      active.postMessage = message => {
        if (message.kind === 'close') { closes++; queueMicrotask(() => active.emit('message', { id: message.id, result: { closed: true } })); }
        else answer = statuses => active.emit('message', { id: message.id, statuses });
      };
      return active;
    } });
  const first = queue.submit({ action: 'x', target: 'signed' });
  const second = queue.submit({ action: 'x', target: 'refused' });
  await new Promise(resolve => setImmediate(resolve));
  const retirement = queue.retireWhenIdle();
  assert.equal(queue.retireWhenIdle(), retirement, 'concurrent retirement shares custody');
  retirement.then(() => { retired = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual([retired, closes, terminations], [false, 0, 0], 'turning off does not terminate admitted work');
  const success = fakeStatus(1), refused = failedStatus(Object.assign(Error('anchor refused'), { code: 'AUDIT_HEAD_UNAVAILABLE' }));
  answer([success, refused]);
  assert.deepEqual(await first, success);
  assert.deepEqual(await second, refused);
  await retirement;
  assert.deepEqual([closes, terminations, queue.stats().worker, queue.stats().workerBroken], [1, 1, false, false]);
  assert.equal((await queue.submit({ action: 'x', target: 'late' })).errors[0].code, 'AUDIT_LANE_RETIRING');
});


test('retirement waits for a shared meter request and retries refused close without replaying it', async () => {
  const { EventEmitter } = require('node:events');
  let active, meterReply, closeCalls = 0, meterCalls = 0, terminated = 0;
  const queue = createAdmissionQueue({ worker: true, startWorker({ onExit }) {
    active = new EventEmitter(); active.unref = () => {};
    active.terminate = async () => { terminated++; onExit(1); };
    active.postMessage = message => {
      if (message.kind === 'tool-meter') { meterCalls++; meterReply = () => active.emit('message', { id: message.id, result: { recordCount: 1 } }); }
      else if (message.kind === 'close') {
        closeCalls++;
        queueMicrotask(() => active.emit('message', closeCalls === 1
          ? { id: message.id, result: {} }
          : closeCalls === 2 ? { id: message.id, error: { code: 'AUDIT_CLOSE_FAILED', message: 'close refused' } }
          : { id: message.id, result: { closed: true } }));
      }
    };
    return active;
  } });
  const meter = queue.recordToolMeterBatch([{ event: 'usage' }], 'fixture-meter.js');
  const retiring = queue.retireWhenIdle();
  const refused = assert.rejects(retiring, { code: 'AUDIT_CLOSE_UNCONFIRMED' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closeCalls, 0, 'a shared meter write is still admitted work');
  meterReply();
  assert.deepEqual(await meter, { recordCount: 1 });
  await refused;
  assert.deepEqual([terminated, queue.stats().worker], [0, true], 'failed close retains its owned worker for retry');
  await assert.rejects(queue.retireWhenIdle(), { code: 'AUDIT_CLOSE_FAILED' });
  assert.equal(terminated, 0);
  await queue.retireWhenIdle();
  assert.deepEqual([closeCalls, terminated, meterCalls], [3, 1, 1]);
});

for (const viaDefault of [false, true]) test(`retirement retains rejected termination until owned confirmation through ${viaDefault ? 'default queue' : 'actual queue'}`, async () => {
  const { EventEmitter } = require('node:events');
  const workers = [];
  class Worker extends EventEmitter {
    constructor() { super(); this.messages = []; this.terminations = 0; workers.push(this); }
    unref() {}
    postMessage(message) {
      this.messages.push(message);
      queueMicrotask(() => this.emit('message', message.kind === 'close'
        ? { id: message.id, result: { closed: true } }
        : { id: message.id, statuses: message.items.map((_, index) => fakeStatus(index)) }));
    }
    async terminate() { this.terminations++; throw Object.assign(Error('synthetic termination refused without exit'), { code: 'TERMINATION_REJECTED' }); }
  }
  let queue, retire;
  if (viaDefault) {
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const { createRequire } = require('node:module');
    const filename = require.resolve('../src/lib/audit-admission'), realRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext('(function(require,module,exports,__dirname) {' + fs.readFileSync(filename, 'utf8') + '\n})',
      { process, Buffer, setTimeout, clearTimeout, setImmediate, clearImmediate }, { filename })
      (id => id === 'node:worker_threads' ? { Worker, isMainThread: true }
        : id === './tool-performance-settings' ? { performanceSettings: () => ({ 'tools.audit_batch_window_ms': 0, 'tools.audit_batch_size': 8 }) }
        : realRequire(id), module, module.exports, path.dirname(filename));
    queue = module.exports.defaultAdmissionQueue(); retire = module.exports.retireDefaultAdmissionQueue;
  } else {
    queue = createAdmissionQueue({ worker: true, coalesceMs: 0, maxBatch: 8, startWorker({ onExit }) {
      const worker = new Worker(); worker.on('exit', onExit); return worker;
    } });
    retire = () => queue.retireWhenIdle();
  }
  const admitted = await queue.submit({ action: 'fixture', target: 'one' });
  assert.equal(admitted.durable, true); assert.equal(workers.length, 1);
  await assert.rejects(retire(), { code: 'TERMINATION_REJECTED' });
  try {
    assert.equal(queue.stats().worker, true, 'rejected termination without exit retains the worker');
    await assert.rejects(retire(), { code: 'TERMINATION_REJECTED' });
    assert.equal(workers.length, 1, 'cleanup retry cannot spawn a new worker');
    assert.equal(workers[0].messages.filter(row => row.kind === 'events').length, 1, 'admitted writes never replay');
    assert.equal(workers[0].messages.filter(row => row.kind === 'close').length, 1, 'positive database closure is preserved across termination retry');
    workers[0].emit('exit', 1);
    await retire();
    assert.equal(queue.stats().worker, false);
    assert.equal(queue.stats().workerBroken, false, 'owned exit following confirmed close is an intentional stop');
    assert.equal((await queue.submit({ action: 'late', target: 'one' })).errors[0].code, 'AUDIT_LANE_RETIRING');
  } finally { workers[0].emit('exit', 1); await retire(); }
});

test('concurrent Engine closes share deferred termination without releasing admitted custody early', async () => {
  const { EventEmitter } = require('node:events');
  let active, finish, terminations = 0, closeCalls = 0;
  const terminated = new Promise(resolve => { finish = resolve; });
  const queue = createAdmissionQueue({ worker: true, coalesceMs: 0, maxBatch: 8, startWorker() {
    active = new EventEmitter(); active.unref = () => {};
    active.terminate = () => { terminations++; return terminated; };
    active.postMessage = message => {
      if (message.kind === 'close') closeCalls++;
      queueMicrotask(() => active.emit('message', message.kind === 'close'
        ? { id: message.id, result: { closed: true } }
        : { id: message.id, statuses: message.items.map((_, index) => fakeStatus(index)) }));
    };
    return active;
  } });
  assert.equal((await queue.submit({ action: 'one', target: 'owned' })).durable, true);
  const retirement = queue.retireWhenIdle();
  await new Promise(resolve => setImmediate(resolve));
  const concurrent = queue.close(); let settled = false;
  concurrent.then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(queue.stats().worker, true);
    assert.deepEqual([closeCalls, terminations], [1, 1]);
    finish(0); await Promise.all([retirement, concurrent]);
    assert.equal(queue.stats().worker, false);
    assert.equal((await queue.submit({ action: 'late', target: 'owned' })).errors[0].code, 'AUDIT_LANE_RETIRING');
  } finally { finish(0); await queue.close(); }
});

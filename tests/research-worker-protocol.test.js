'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { PREFIX, MAX_FRAME_BYTES, createWorkerControlSession, runSupervisedWorker } = require('../src/lib/research/worker-protocol');

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture({ createWorker, closeDatabase, signal }) {
  const input = new PassThrough(); const output = new PassThrough();
  const instanceId = crypto.randomUUID(); const secret = crypto.randomBytes(32).toString('hex');
  const ready = deferred(); const started = deferred(); const stopped = deferred();
  const errors = [];
  const parent = createWorkerControlSession({ input: output, output: input, instanceId, secret,
    onMessage(value) { ({ ready, started, stopped })[value.type]?.resolve(value); },
    onError(error) { errors.push(error.code); }, onEnd() {} });
  const run = runSupervisedWorker({ input, output, createWorker, closeDatabase, initTimeoutMs: 100, signal });
  run.catch(() => {});
  input.write(JSON.stringify({ version: 1, type: 'init', instanceId, secret }) + '\n');
  return { input, output, parent, run, ready, started, stopped, errors,
    close() { parent.close(); input.destroy(); output.destroy(); } };
}

test('quiesce before start is a real no-DB path; construction is behind the private start command', async () => {
  let constructed = 0; let closed = 0;
  const f = fixture({ createWorker() { constructed += 1; throw new Error('must not construct'); }, closeDatabase() { closed += 1; } });
  try {
    await f.ready.promise;
    await f.parent.send({ type: 'quiesce', sequence: 1 });
    await f.run;
    const stopped = await f.stopped.promise;
    assert.equal(stopped.databaseOpened, false); assert.equal(stopped.workerDbClosed, true);
    assert.equal(constructed, 0); assert.equal(closed, 0); assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('the signed stopped acknowledgement waits for both run drain and successful DB close', async () => {
  const run = deferred(); const db = deferred(); const closeEntered = deferred();
  let stopCalls = 0; let acknowledged = false;
  const f = fixture({ createWorker: () => ({ runForever: () => run.promise, stop() { stopCalls += 1; } }),
    closeDatabase() { closeEntered.resolve(); return db.promise; } });
  f.stopped.promise.then(() => { acknowledged = true; });
  try {
    await f.ready.promise; await f.parent.send({ type: 'start', sequence: 1 }); await f.started.promise;
    await f.parent.send({ type: 'quiesce', sequence: 2 });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(stopCalls >= 1); assert.equal(acknowledged, false);
    run.resolve(); await closeEntered.promise;
    assert.equal(acknowledged, false, 'drain alone cannot attest DB closure');
    db.resolve(); await f.run;
    assert.equal((await f.stopped.promise).workerDbClosed, true);
  } finally { run.resolve(); db.resolve(); await f.run.catch(() => {}); f.close(); }
});

test('replayed start seals and drains the worker without a second construction', async () => {
  const active = deferred(); let creates = 0; let closes = 0;
  const f = fixture({ createWorker() { creates += 1; return { runForever: () => active.promise, stop: active.resolve }; },
    closeDatabase() { closes += 1; } });
  try {
    await f.ready.promise; await f.parent.send({ type: 'start', sequence: 1 }); await f.started.promise;
    await f.parent.send({ type: 'start', sequence: 1 });
    await assert.rejects(f.run, { code: 'RESEARCH_WORKER_CONTROL_REPLAY' });
    assert.equal(creates, 1); assert.equal(closes, 1);
    assert.equal((await f.stopped.promise).workerDbClosed, true);
  } finally { active.resolve(); f.close(); }
});

test('unsigned caller JSON and a forged signature cannot grant worker admission', async () => {
  for (const payload of ['{"type":"start","sequence":1}\n', `${PREFIX}e30= ${'0'.repeat(64)}\n`]) {
    let creates = 0;
    const f = fixture({ createWorker() { creates += 1; throw new Error('must not construct'); }, closeDatabase() {} });
    try {
      await f.ready.promise; f.input.write(payload);
      await assert.rejects(f.run, error => /^RESEARCH_WORKER_CONTROL_/.test(error.code));
      assert.equal(creates, 0);
      assert.equal((await f.stopped.promise).databaseOpened, false);
    } finally { f.close(); }
  }
});

test('unbounded control input is rejected before any DB construction', async () => {
  let creates = 0;
  const f = fixture({ createWorker() { creates += 1; throw new Error('must not construct'); }, closeDatabase() {} });
  try {
    await f.ready.promise; f.input.write('x'.repeat(MAX_FRAME_BYTES + 1));
    await assert.rejects(f.run, { code: 'RESEARCH_WORKER_CONTROL_TOO_LARGE' });
    assert.equal(creates, 0);
  } finally { f.close(); }
});

test('a stop signal before the private start command cannot admit later work', async () => {
  const controller = new AbortController(); let creates = 0;
  const f = fixture({ signal: controller.signal, createWorker() { creates += 1; throw new Error('must not construct'); }, closeDatabase() {} });
  try {
    await f.ready.promise; controller.abort();
    await assert.rejects(f.run, { code: 'RESEARCH_WORKER_STOP_REQUESTED' });
    await f.parent.send({ type: 'start', sequence: 1 });
    assert.equal(creates, 0);
    assert.equal((await f.stopped.promise).databaseOpened, false);
  } finally { f.close(); }
});

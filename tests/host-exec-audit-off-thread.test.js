'use strict';

/* host.exec's AUDIT-BEFORE-RUN NO LONGER PARKS THE THREAD IT IS CALLED ON.
 *
 * MEASURED 2026-09-04 on the owner's Live main process, four circles: 53
 * main-thread stalls of 2 to 4 s in fifteen minutes, 46 of them containing a
 * host.exec.intent record, with the process spawning powershell (the vault
 * anchor a REQUIRED record forces) inside every stall window. The provider
 * called audit.requireRecord() synchronously and the owner host runs inside
 * the desktop app's main process, so every agent's shell command froze the
 * person's window for two PowerShell starts.
 *
 * The guarantee this file pins is the same one the synchronous call gave --
 * nothing is spawned until the admission has answered durable, and a refusal
 * means no launch -- plus the property the synchronous call could not have:
 * while the admission is in flight, the calling thread keeps running.
 *
 * The admission is injected, so no ledger, vault or PowerShell is touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const host = require('../src/lib/providers/host-control');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4180;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

test('the calling thread keeps running while the intent record is being admitted', async () => {
  let releaseAdmission;
  const admission = new Promise(resolve => { releaseAdmission = resolve; });
  const child = fakeChild();
  let launches = 0;
  const ticksWhileWaiting = [];

  const pending = host.exec({ command: 'Write-Output off-thread', timeoutMs: 5000 }, {
    requireRecordAsync: () => admission,
    recordAsync: async () => ({ ok: true, durable: true }),
    spawnInJobImpl: () => { launches += 1; return child; }
  });

  // Three timer turns pass on this thread while the admission is outstanding.
  // A synchronous requireRecord() would have made this loop wait for the
  // vault; here it runs, and the launch has not happened.
  for (let i = 0; i < 3; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    ticksWhileWaiting.push(launches);
  }
  assert.deepEqual(ticksWhileWaiting, [0, 0, 0], 'the command must not launch before its intent record is durable');

  releaseAdmission({ ok: true, durable: true, anchored: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 1, 'once the admission answers, the command launches exactly once');

  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
});

test('a refused admission launches nothing and rejects with the refusal', async () => {
  let launches = 0;
  const refusal = Object.assign(new Error('test audit unavailable'), { code: 'AUDIT_UNAVAILABLE' });
  const pending = host.exec({ command: 'Write-Output refused', timeoutMs: 5000 }, {
    requireRecordAsync: () => Promise.reject(refusal),
    recordAsync: async () => ({ ok: true }),
    spawnInJobImpl: () => { launches += 1; return fakeChild(); }
  });
  await assert.rejects(pending, error => error && error.code === 'AUDIT_UNAVAILABLE');
  assert.equal(launches, 0, 'an unlogged command must never run');
});

test('the result record is admitted the same way and the answer waits for it', async () => {
  const child = fakeChild();
  const recorded = [];
  let resolveResultRecord;
  const resultRecord = new Promise(resolve => { resolveResultRecord = resolve; });
  const pending = host.exec({ command: 'Write-Output result', timeoutMs: 5000 }, {
    requireRecordAsync: async () => ({ ok: true, durable: true, anchored: true }),
    recordAsync: (action, target, details) => { recorded.push({ action, details }); return resultRecord; },
    spawnInJobImpl: () => child
  });
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.emit('data', Buffer.from('hello'));
  child.emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].action, 'host.exec.result');
  assert.equal(recorded[0].details.stdoutBytes, 5);

  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the answer waits for the result record, as the synchronous record made it');
  resolveResultRecord({ ok: true });
  const result = await pending;
  assert.equal(result.stdout, 'hello');
});

test('validation still refuses synchronously, before any admission is asked for', () => {
  let asked = 0;
  assert.throws(() => host.exec({ command: '' }, { requireRecordAsync: () => { asked += 1; return Promise.resolve({}); } }),
    error => error && error.code === 'HOST_INPUT_INVALID');
  assert.equal(asked, 0);
});

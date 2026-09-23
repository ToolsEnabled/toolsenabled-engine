'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createStartupCleanup } = require('../../src/lib/agent-engine/codex-startup-cleanup');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(receipt = { type: 'terminated', activeProcesses: 0 }) {
  const child = new EventEmitter();
  child.pid = 123;
  child.terminateJob = async () => receipt;
  return { child, cleanup: createStartupCleanup(child) };
}

test('empty tree receipt alone cannot release a provider read before actual pipe closure', async () => {
  const { child, cleanup } = fixture();
  let settled = false;
  const pending = cleanup.confirmClosed(1000).finally(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  child.emit('close', 0, null);
  assert.equal((await pending).activeProcesses, 0);
});

test('actual root close cannot substitute for empty descendant proof', async () => {
  const { child, cleanup } = fixture({ type: 'terminated', activeProcesses: 1 });
  child.emit('close', 0, null);
  await assert.rejects(cleanup.confirmClosed(100), { code: 'CODEX_PROCESS_CLEANUP_UNPROVEN' });
});

test('closure deadline refuses measurement and retains a retry on the same owned handle', async () => {
  const { child, cleanup } = fixture();
  let failure;
  await assert.rejects(cleanup.confirmClosed(30), error => {
    failure = error;
    return error.code === 'CODEX_PROCESS_CLEANUP_UNPROVEN' && typeof error.retryCleanup === 'function';
  });
  assert.equal(Object.keys(failure).includes('retryCleanup'), false);
  child.emit('close', 0, null);
  assert.equal((await failure.retryCleanup()).activeProcesses, 0);
});

test('adapter closure failure rejects even with an empty termination receipt', async () => {
  const { child, cleanup } = fixture();
  child.jobClosed = Promise.resolve({ failure: 'fixture custody protocol failure' });
  child.emit('close', 0, null);
  await assert.rejects(cleanup.confirmClosed(100), { code: 'CODEX_PROCESS_CLEANUP_UNPROVEN' });
});

test('concurrent closure requests share termination and completed close evidence', async () => {
  const { child, cleanup } = fixture();
  let calls = 0;
  child.terminateJob = async () => { calls++; return { type: 'terminated', activeProcesses: 0 }; };
  const first = cleanup.confirmClosed(1000);
  const second = cleanup.confirmClosed(1000);
  assert.equal(first, second);
  child.emit('close', 0, null);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('retained empty outcome and actual close release a stalled termination request', async () => {
  const child = new EventEmitter();
  const outcome = Promise.withResolvers();
  child.jobOutcome = outcome.promise;
  child.terminateJob = () => new Promise(() => {});
  const cleanup = createStartupCleanup(child);
  const pending = cleanup.confirmClosed(1000);
  await tick();
  outcome.resolve({ type: 'exit', activeProcesses: 0 });
  child.emit('close', 0, null);
  assert.equal((await pending).type, 'exit');
});

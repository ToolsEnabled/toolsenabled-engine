'use strict';

// The shared work record's refusals as an agent inside an OpenShell sandbox
// reads them: each must reach it as its own sentence, which says what to do
// next, never as "internal error".

const { useSandboxHome, sandboxCaller } = require('./lib/openshell-sandbox-home');
useSandboxHome('openshell-work-record');

const test = require('node:test');
const assert = require('node:assert/strict');

const INTERNAL = /internal error/;

test('a task record id that does not exist, and blank words, are refused with their own sentences', async (t) => {
  const { call, refusal } = sandboxCaller(t);
  const filed = await call('t_ledger.file', { actor: 'codex', scope: 'global', words: 'Write the notes.' });
  assert.equal(filed.id, 'T1');
  for (const [tool, args] of [
    ['t_ledger.complete', { actor: 'codex', id: 'T99' }],
    ['t_ledger.progress', { actor: 'codex', id: 'T99', status: 'in-progress', reason: 'started' }]
  ]) {
    const refused = await refusal(tool, args);
    assert.equal(refused.code, 'R_LEDGER_ENTRY_UNKNOWN', tool);
    assert.doesNotMatch(refused.text, INTERNAL, tool);
    assert.match(refused.text, /T99 is not in the ledger/, tool);
  }
  for (const [tool, args] of [
    ['t_ledger.file', { actor: 'codex', scope: 'global', words: '  \n\t ' }],
    ['a_ledger.file', { actor: 'codex', scope: 'global', words: ' ' }]
  ]) {
    const refused = await refusal(tool, args);
    assert.equal(refused.code, 'R_LEDGER_WORDS_EMPTY', tool);
    assert.match(refused.text, /the request is empty/, tool);
  }
});

test('a task cancelled while an agent works on it refuses completion with a sentence naming how to acknowledge it', async (t) => {
  const { call, refusal } = sandboxCaller(t);
  const submit = (idempotencyKey) => call('task.submit', { queue: 'refusals', type: 'work', idempotencyKey,
    payload: { title: 'Write the notes', objective: 'Write the release notes.' }, expiryPolicy: 'retry', maxAttempts: 2 });
  await submit('cancel-while-running');
  const { handle } = await call('task.claim', { queue: 'refusals', workerLabel: 'codex' });
  await call('task.start', { handle });
  await call('task.cancel', { taskId: handle.taskId, reason: 'no longer needed' });
  assert.equal((await call('task.heartbeat', { handle })).cancellationRequested, true);
  for (const [tool, args] of [
    ['task.complete', { handle, result: { summary: 'done' } }],
    ['task.checkpoint', { handle, checkpointKey: 'checkpoint-0001', expectedRevision: 0, checkpoint: { summary: 'half' } }]
  ]) {
    const refused = await refusal(tool, args);
    assert.equal(refused.code, 'TASK_CANCEL_REQUESTED', tool);
    assert.doesNotMatch(refused.text, INTERNAL, tool);
    assert.match(refused.text, /task\.fail with disposition cancelled/, tool);
  }
  assert.equal((await call('task.fail', { handle, disposition: 'cancelled', code: 'CANCELLED' })).status, 'cancelled');
  // Cancelled before it started: the start refuses the same way.
  await submit('cancel-before-start');
  const leased = await call('task.claim', { queue: 'refusals', workerLabel: 'codex' });
  await call('task.cancel', { taskId: leased.handle.taskId });
  const start = await refusal('task.start', { handle: leased.handle });
  assert.equal(start.code, 'TASK_CANCEL_REQUESTED');
  assert.match(start.text, /task\.fail with disposition cancelled/);
  // Acknowledging a cancellation nobody asked for is refused with its reason.
  await submit('cancel-not-asked');
  const running = await call('task.claim', { queue: 'refusals', workerLabel: 'codex' });
  await call('task.start', { handle: running.handle });
  const unasked = await refusal('task.fail', { handle: running.handle, disposition: 'cancelled', code: 'CANCELLED' });
  assert.equal(unasked.code, 'TASK_CANCEL_NOT_REQUESTED');
  assert.match(unasked.text, /only after it was requested/);
});

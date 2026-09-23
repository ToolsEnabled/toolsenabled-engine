'use strict';

require('./helpers/isolated-state-root');

/* A TURN SENT FOR A TASK THAT NO LONGER EXISTS.
 *
 * agent-ledger-continuation's tick() reads the T records synchronously,
 * reserves the task it picked, then defers the claim, the checkpoint write and
 * the send through Promise.resolve().then(). A category reset
 * (owner-request-store resetKind) is an ordinary synchronous write, and readAll
 * drops reset records entirely, so a reset committing between the read and the
 * microtask leaves the deferred half acting on a record that is gone.
 *
 * THE WINDOW IS NOT INVENTED. Each test resets BETWEEN the synchronous tick()
 * and the setImmediate that flushes the microtask, which is the same ordering
 * the existing continuation tests already use to observe a send. Without the
 * revalidation these fail by sending a turn for the cleared task.
 *
 * WHAT A FENCE MUST NOT DO is as load-bearing as what it must do. A reset is
 * not a session failure, so it may not stop the session, refuse later work, or
 * prevent a resume after Stop. Those are asserted beside the suppression.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const store = require('../src/lib/owner-request-store');
const { createLedgerContinuation, SETTING_ID, INTERVAL_MS } = require('../src/lib/agent-ledger-continuation');
const { createContinuationState, DEFAULT_BASE_DELAY_MS } = require('../src/lib/agent-continuation-state');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'reset-delayed-consumers-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return { dir, opts: { rootPath, needsApproval: false } };
}

function resetTasks(opts) {
  const preview = store.previewResetKind({ kind: 'T', actor: 'owner' }, opts);
  return store.resetKind({ kind: 'T', actor: 'owner', revision: preview.revision, token: preview.token }, opts);
}

function harness(opts, clock) {
  const sent = [];
  const paused = [];
  const runner = createLedgerContinuation({
    stateFactory: () => createContinuationState({ file: opts.rootPath('continuations.sqlite'), now: () => clock.value }),
    now: () => clock.value,
    canSend: () => true,
    readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
    readTasks: () => store.readAll({ ...opts, kinds: ['T'] }).records,
    send: async (_, text) => { sent.push(text); },
    onPause: (_, words) => paused.push(words),
  });
  return { runner, sent, paused };
}

const SESSION = { sessionId: 'session-a', threadId: 'thread-a',
  treeRequestIdentity: { threadId: 'node-a', treeAnchors: ['node-a'] } };
const flush = () => new Promise(resolve => setImmediate(resolve));

function idle(runner) {
  runner.remember(SESSION, { sessionId: SESSION.sessionId, resumeThreadId: SESSION.threadId, resumeThreadProvider: 'codex', requestKeys: SESSION.treeRequestIdentity });
  runner.started(SESSION, 'person');
  runner.completed(SESSION, { status: 'completed' });
}

async function approachDue(runner, clock) {
  for (let elapsed = INTERVAL_MS; elapsed < DEFAULT_BASE_DELAY_MS; elapsed += INTERVAL_MS) {
    clock.value += INTERVAL_MS; runner.tick(); await flush();
  }
  clock.value += INTERVAL_MS;
}

test('a reset between the ledger read and the deferred send sends no turn for the cleared task', async () => {
  const { dir, opts } = sandbox();
  const clock = { value: 0 };
  const task = store.fileTask({ scope: 'thread', key: 'node-a', words: 'Work to continue' }, opts);
  const { runner, sent } = harness(opts, clock);
  try {
    idle(runner);
    await approachDue(runner, clock);
    runner.tick();                    // reads, reserves, schedules the microtask
    const cleared = resetTasks(opts); // the window: the reset lands before the flush
    assert.equal(cleared.count, 1, 'the reset must actually clear the task, or this test proves nothing');
    await flush();
    assert.deepEqual(sent, [], `a turn was sent naming ${task.id} after that task was reset away`);
  } finally { runner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the cleared task leaves no reservation, so new work filed afterwards still flows', async () => {
  const { dir, opts } = sandbox();
  const clock = { value: 0 };
  store.fileTask({ scope: 'thread', key: 'node-a', words: 'Work to continue' }, opts);
  const { runner, sent } = harness(opts, clock);
  try {
    idle(runner);
    await approachDue(runner, clock);
    runner.tick();
    resetTasks(opts);
    await flush();
    assert.deepEqual(sent, []);
    /* Work filed AFTER the reset is new work and must be taken. If the fence
       had stopped the session or held the stale reservation, this fails. */
    const next = store.fileTask({ scope: 'thread', key: 'node-a', words: 'New work filed after the reset' }, opts);
    clock.value += INTERVAL_MS;
    runner.tick();
    await flush();
    assert.equal(sent.length, 1, 'the session refused new work after a reset');
    assert.match(sent[0], new RegExp(`lists ${next.id} `));
  } finally { runner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a reset raises no pause, so a person resuming after Stop is not blocked', async () => {
  const { dir, opts } = sandbox();
  const clock = { value: 0 };
  store.fileTask({ scope: 'thread', key: 'node-a', words: 'Work to continue' }, opts);
  const { runner, sent, paused } = harness(opts, clock);
  try {
    idle(runner);
    await approachDue(runner, clock);
    runner.tick();
    resetTasks(opts);
    await flush();
    assert.deepEqual(paused, [],
      'a category reset is not a session failure and must not raise a pause the person has to clear');
    const resumed = store.fileTask({ scope: 'thread', key: 'node-a', words: 'Work after the person resumed' }, opts);
    idle(runner);                     // the person sends a turn again
    await approachDue(runner, clock);
    runner.tick();
    await flush();
    assert.equal(sent.length, 1);
    assert.match(sent[0], new RegExp(`lists ${resumed.id} `));
  } finally { runner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a task that survives the window is still dispatched, so the fence refuses only what vanished', async () => {
  const { dir, opts } = sandbox();
  const clock = { value: 0 };
  const task = store.fileTask({ scope: 'thread', key: 'node-a', words: 'Work to continue' }, opts);
  const { runner, sent } = harness(opts, clock);
  try {
    idle(runner);
    await approachDue(runner, clock);
    runner.tick();
    await flush();
    assert.equal(sent.length, 1, 'the ordinary path must still dispatch');
    assert.match(sent[0], new RegExp(`lists ${task.id} `));
  } finally { runner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fresh runner after restart does not resume a task the reset removed', async () => {
  const { dir, opts } = sandbox();
  const clock = { value: 0 };
  store.fileTask({ scope: 'thread', key: 'node-a', words: 'Work to continue' }, opts);
  const first = harness(opts, clock);
  try {
    idle(first.runner);
    await approachDue(first.runner, clock);
    first.runner.tick();
    resetTasks(opts);
    await flush();
    assert.deepEqual(first.sent, []);
  } finally { first.runner.close(); }
  const second = harness(opts, clock);   // restart reads the same durable ledger
  try {
    idle(second.runner);
    await approachDue(second.runner, clock);
    second.runner.tick();
    await flush();
    assert.deepEqual(second.sent, [],
      'a restarted runner sent a turn for a task the reset had already removed');
  } finally { second.runner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ONBOARDING: THE HYPOTHESIS DID NOT HOLD, AND THAT IS THE FINDING.
 *
 * The brief asked me to trace a delayed injection in agent-onboarding.js and
 * fence a stale cached R if one survived a reset. Traced, and there is no such
 * window to fence. Measured on this file:
 *   - agent-onboarding.js contains zero async functions, zero awaits and zero
 *     deferral primitives (no Promise.then, setTimeout, setImmediate or
 *     queueMicrotask). Its packet build is one synchronous call.
 *   - collectOwnerRequests() requires ./r-ledger inside the function and reads
 *     through owner-request-store on every call. It holds no cache.
 *   - r-ledger.js likewise has zero deferral primitives.
 * So the read and the render happen in the same synchronous turn, and there is
 * no interval in which a reset could land between them. Adding a fence there
 * would be fencing an imaginary race.
 *
 * WHAT IS WORTH PINNING is the property the brief actually wants guaranteed:
 * a fresh read after a reset must not return the cleared rules. That is
 * currently true because readAll filters reset records, which is a behaviour
 * of the store rather than a promise anyone wrote down. If it ever stops being
 * true, onboarding hands a reset rule to a new agent as if the person still
 * meant it, and no test here would have noticed.
 */
test('a fresh owner-request read after an R reset returns no cleared rule', () => {
  const { dir, opts } = sandbox();
  try {
    store.fileRequest({ scope: 'global', words: 'a standing rule the person filed' }, opts);
    assert.equal(store.readAll({ ...opts, kinds: ['R'] }).records.length, 1);
    const preview = store.previewResetKind({ kind: 'R', actor: 'owner' }, opts);
    const cleared = store.resetKind({ kind: 'R', actor: 'owner', revision: preview.revision, token: preview.token }, opts);
    assert.equal(cleared.count, 1);
    assert.deepEqual(store.readAll({ ...opts, kinds: ['R'] }).records, [],
      'a reset rule came back from a fresh read, so onboarding would hand it to a new agent as if the person still meant it');
    /* Including the removed rows, to show the record is retained rather than
       destroyed: the reset is a tombstone, and only the live read excludes it. */
    assert.equal(store.readAll({ ...opts, kinds: ['R'], includeRemoved: true }).records.length, 0,
      'reset records are filtered from every read, not merely hidden from the default one');
    /* And a rule filed after the reset is the person speaking again: it must
       reach a fresh onboarding read. */
    const next = store.fileRequest({ scope: 'global', words: 'a rule filed after the reset' }, opts);
    assert.deepEqual(store.readAll({ ...opts, kinds: ['R'] }).records.map(row => row.id), [next.id]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

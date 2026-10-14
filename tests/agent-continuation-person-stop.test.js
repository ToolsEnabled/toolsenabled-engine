'use strict';

require('./helpers/isolated-state-root'); // Redirect TOOLSENABLED_STATE_ROOT off the live root before anything below resolves it.

// A PERSON STOP DESCRIBED AS A STORAGE FAULT.
//
// The person stopped Codex Terra circle node-8-0dbad425. Its saved row went to
// status 'stopped', fence 9, reason person_stopped. The Controller later
// resumed that node into a NEW session; it used tools and sent real work, and
// its chat then said:
//
//   "Autonomous+ paused because its saved continuation could not be updated
//    (CONTINUATION_FENCE_LOST)."
//
// Nothing failed to be written. The person's Stop was holding, exactly as it
// should. The chain, in src/lib/agent-ledger-continuation.js:
//
//   remember()  -> storage.track(descriptor) with no resume returns the prior
//                  STOPPED row unchanged, because track() has
//                  `if (prior && !resume) return publicRow(prior)`.
//   started()   -> passes resume only for origin 'person' or 'brief', then
//                  begins only for idle/ready/retry_wait. 'stopped' is in
//                  neither, so begin is skipped and the handle stays stopped.
//   completed() -> storage.success(handle), whose readHandle accepts only
//                  ['idle','running']. 'stopped' is in neither, so it raises
//                  CONTINUATION_FENCE_LOST.
//   persist()   -> its catch announces "could not be updated", which describes
//                  a write failure that did not happen.
//
// The outcome was already safe: no continuation was dispatched. Only the
// sentence was false, and it pointed the person at storage when the truth was
// that their own Stop was still in force.
//
// WHAT THESE TESTS FIX IN PLACE. The Stop must keep holding. Nothing here
// widens success()'s accepted statuses, retries a stale fence, or lets an
// agent-origin start clear a Stop. The assertions pin the saved row's status,
// fence and reason as UNCHANGED across the agent-origin turn, so a repair that
// makes the sentence true by reviving the row fails here instead of passing.
//
// Three statuses, not one. 'blocked' (a recorded hard failure) and 'uncertain'
// (unresolved custody) reach the same false sentence by the same route, and
// save() already treats all three as rows it will not write.
//
// EVERY CASE BELOW RUNS THE REAL continuation-state store, on a real SQLite
// file, through createContinuationState. Nothing here stubs storage.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const store = require('../src/lib/owner-request-store');
const { createLedgerContinuation, SETTING_ID, HELD_PAUSE, INTERVAL_MS, MAX_UNCHANGED_TURNS } = require('../src/lib/agent-ledger-continuation');
const { createContinuationState, DEFAULT_BASE_DELAY_MS } = require('../src/lib/agent-continuation-state');

// The false sentence, from persist()'s catch. These tests assert its ABSENCE,
// so a repair that still announces a failed write cannot pass by rewording
// anything else. The exact replacement wording lives in HELD_PAUSE, one place,
// so the person can change the words without touching a test.
const STORAGE_FAULT = /could not be updated/i;
const ERROR_CODE = /CONTINUATION_[A-Z_]+/;

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'continuation-person-stop-'));
  const opts = { rootPath: (...parts) => path.join(dir, ...parts), needsApproval: false };
  let time = 0, live = true, busy = false, runner, storage;
  const sent = [], pauses = [], otherStores = [];
  const task = store.fileTask({ scope: 'thread', key: 'saved-node', words: 'Finish the next authorized workflow step' }, opts);
  // A NEW host session for each resume: the reported bug arrived through the
  // Controller opening a different session against the same saved node, and
  // the saved key is derived from the tree anchors, not from the session id.
  const session = (id = 'saved-session') => ({ sessionId: id, threadId: 'native-thread-uuid',
    treeRequestIdentity: { threadId: 'saved-node', treeAnchors: ['saved-root', 'saved-node'] } });
  const descriptorFor = (id = 'saved-session') => ({ sessionId: id, resumeThreadId: 'native-thread-uuid',
    resumeThreadProvider: 'codex', cwd: dir, tier: 'gpt-6-terra', effort: 'ultra', resumeAccount: 'saved-account',
    requestKeys: session(id).treeRequestIdentity });
  const open = () => {
    runner = createLedgerContinuation({ now: () => time, isLive: () => live, canSend: () => live && !busy,
      stateFactory: () => (storage = createContinuationState({ file: path.join(dir, 'continuations.sqlite'), now: () => time })),
      readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
      readTasks: () => { assert.equal(store.verifyHistory(opts).ok, true); return store.readAll({ ...opts, kinds: ['T'] }).records; },
      send: async (worker, text) => { sent.push(text); runner.started(worker, 'continuation'); runner.completed(worker, { status: 'completed' }); },
      onPause: (_, reason) => pauses.push(reason),
      ...overrides,
    });
    return runner;
  };
  /* ONE HOST POLL, at the real interval. agent-host.cjs runs tick() on a
     5-second timer while completed() schedules the next review 15 seconds out,
     so two polls in every three arrive BEFORE the row is due. Nothing here
     advances the clock past that early path. */
  const poll = async () => { time += INTERVAL_MS; runner.tick(); await new Promise(resolve => setImmediate(resolve)); };
  /* One whole scheduling interval, polled the way the host polls it. */
  const round = async () => { for (let spent = 0; spent < DEFAULT_BASE_DELAY_MS; spent += INTERVAL_MS) await poll(); };
  t.after(() => {
    runner?.close();
    // Close every fixture-owned connection before unlinking SQLite on Windows.
    for (const other of otherStores) other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  open();
  return { session, descriptorFor, task, opts, sent, pauses, poll, round, open,
    storeFile: path.join(dir, 'continuations.sqlite'), clock: () => time,
    openOtherStore: () => {
      const other = createContinuationState({ file: path.join(dir, 'continuations.sqlite'), now: () => time });
      otherStores.push(other);
      return other;
    },
    get runner() { return runner; }, get storage() { return storage; },
    row: () => storage.list()[0],
    advance: ms => { time += ms; }, live: value => { live = value; }, busy: value => { busy = value; } };
}

// Drive the saved row into one of the three statuses that legitimately hold a
// continuation, using only the scheduler's own public calls.
function holdAt(f, status) {
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  if (status === 'stopped') {
    f.runner.completed(session, { status: 'completed' });
    f.runner.stopSaved(f.row().key);                                  // the person's Stop
  } else if (status === 'blocked') {
    f.runner.completed(session, { status: 'failed', code: 'PERMISSION_DENIED' });
  } else {
    f.runner.exited(session, { code: 'PROVIDER_PROCESS_EXITED' });    // unresolved custody
  }
  assert.equal(f.row().status, status, `the fixture must actually reach ${status}`);
  return f.row();
}

test('a person Stop, a hard failure and unresolved custody keep holding when an agent-origin session resumes the node', async t => {
  for (const status of ['stopped', 'blocked', 'uncertain']) {
    const f = fixture(t);
    const held = holdAt(f, status);

    // The Controller resumes this exact node in a NEW host session, through a
    // restarted scheduler and a reopened store, and real work completes.
    f.runner.close();
    f.open();
    const resumed = f.session('controller-resumed-session');
    f.runner.remember(resumed, f.descriptorFor('controller-resumed-session'));
    f.runner.started(resumed, 'agent');
    f.runner.completed(resumed, { status: 'completed' });

    // 1. No storage fault, because none happened.
    assert.deepEqual(f.pauses.filter(text => STORAGE_FAULT.test(text)), [],
      `${status}: a held row must never be announced as a failed write`);
    assert.deepEqual(f.pauses.filter(text => ERROR_CODE.test(text)), [],
      `${status}: the person is not shown a continuation error code`);

    // 2. The person is told the truth instead, exactly once.
    assert.deepEqual(f.pauses, [HELD_PAUSE[status]], `${status}: one honest sentence`);

    // 3. The hold itself is untouched. This is the anti-widening assertion: a
    //    repair that revives the row to make the sentence true fails here.
    const after = f.row();
    assert.equal(after.status, status, `${status}: an agent-origin start cannot change the saved status`);
    assert.equal(after.fence, held.fence, `${status}: the fence must not advance`);
    assert.equal(after.reason, held.reason, `${status}: the recorded reason must not be rewritten`);

    // 4. And nothing is dispatched, before or after any due time.
    f.advance(120000);
    await f.round(); await f.round();
    assert.deepEqual(f.sent, [], `${status}: a held row authorizes no continuation`);
    assert.deepEqual(f.runner.pendingRecoveries().filter(row => row.status === status), [],
      `${status}: a held row is not offered as a recovery`);
  }
});

test('an explicit person message resumes the stopped node with its new host descriptor and durable checkpoints', async t => {
  const f = fixture(t);
  const held = holdAt(f, 'stopped');
  f.runner.close(); f.open();

  // The agent-origin attempt first, so the person resume has to lift a hold
  // that is genuinely in force rather than a fresh row.
  const resumed = f.session('controller-resumed-session');
  f.runner.remember(resumed, f.descriptorFor('controller-resumed-session'));
  f.runner.started(resumed, 'agent');
  f.runner.completed(resumed, { status: 'completed' });
  assert.equal(f.row().status, 'stopped');

  // Now the person types to that exact circle.
  f.runner.started(resumed, 'person');
  const revived = f.row();
  // track(resume) writes the resumed row and begin() then takes the running
  // lease, so the fence advances twice. What matters is that it advanced past
  // the Stop and the row is live again.
  assert.ok(revived.fence > held.fence, 'a person resume advances past the stopped fence');
  assert.equal(revived.status, 'running', 'and the hold is lifted for this turn');
  assert.equal(revived.descriptor.sessionId, 'controller-resumed-session', 'the new host descriptor is saved');
  assert.equal(revived.descriptor.requestKeys.threadId, 'saved-node', 'and it is still the same saved node');
  assert.equal(revived.key, held.key, 'the saved identity follows the tree anchors, not the session id');

  f.runner.completed(resumed, { status: 'completed' });
  // Polled at the real interval, through the early polls rather than over them.
  await f.round();
  assert.equal(f.sent.length, 1, 'the person resume restores automatic continuation');
  assert.match(f.sent[0], new RegExp(`lists ${f.task.id} `));
  const checkpoint = f.row().checkpoint;
  assert.equal(checkpoint.taskId, f.task.id, 'and the continuation writes a durable checkpoint');
  assert.match(checkpoint.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.pauses.filter(text => STORAGE_FAULT.test(text)), []);
});

test('active custody, repeated completion and a closed store never bypass the hold', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');

  // A live lease is held by this running attempt. A competing resume of the
  // same saved node must be refused rather than stealing custody.
  const running = f.row();
  assert.equal(running.status, 'running');
  assert.ok(running.leaseUntilMs > 0, 'the running attempt owns a live lease');
  assert.throws(() => f.storage.track(f.descriptorFor('second-session'), { resume: true }),
    { code: 'CONTINUATION_ACTIVE' }, 'a live lease refuses a competing resume');

  // Repeated completion is not a second turn.
  f.runner.completed(session, { status: 'completed' });
  const settled = f.row();
  f.runner.completed(session, { status: 'completed' });
  assert.equal(f.row().revision, settled.revision, 'a repeated completion writes nothing');

  // A Stop, then a closed scheduler: every later call is inert, and shutting
  // down produces no sentence about storage.
  f.runner.stopSaved(settled.key);
  f.runner.close();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'agent');
  f.runner.completed(session, { status: 'completed' });
  assert.deepEqual(f.pauses.filter(text => STORAGE_FAULT.test(text)), [],
    'a closed scheduler announces nothing at all');
  f.open();
  f.runner.remember(session, f.descriptorFor()); // instantiates the reopened store
  assert.equal(f.row().status, 'stopped', 'the Stop survived the close and reopen');
});

test('a retryable failure still retries a finite number of times and then blocks', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  // Driven through the store rather than started(), because a person-origin
  // start deliberately writes a fresh row with retries 0: a new instruction
  // begins a new episode. The retry ledger is the store's, and this is the
  // same real SQLite file the scheduler is using.
  let handle = f.storage.track(f.descriptorFor());
  handle = f.storage.begin(handle, { observed: true });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    handle = f.storage.failed(handle, { code: 'ECONNRESET' }, { retrySafe: true });
    assert.equal(handle.status, 'retry_wait', `attempt ${attempt} is retryable`);
    assert.equal(handle.retries, attempt, 'each retry is counted durably');
    f.advance(3600000);
    const claimed = f.storage.claim(handle);
    assert.ok(claimed, `attempt ${attempt} becomes claimable once due`);
    handle = f.storage.begin(claimed);
  }
  handle = f.storage.failed(handle, { code: 'ECONNRESET' }, { retrySafe: true });
  assert.equal(handle.status, 'blocked', 'the sixth failure exhausts the retry limit');
  assert.equal(handle.reason, 'retry_limit');
  assert.deepEqual(f.pauses.filter(text => STORAGE_FAULT.test(text)), [],
    'a real failure path is not a storage fault either');
  f.advance(3600000);
  await f.round();
  assert.deepEqual(f.sent, [], 'a blocked row dispatches nothing');
});

// THE SAME FALSE SENTENCE BY A SECOND ROUTE: tick()'s heartbeat.
//
// stopSaved() marks the session stopped but leaves state.handle on the row the
// turn began with, and tick()'s persist loop runs for EVERY state before its
// stopped filter. So the stale handle still says 'running' with a claimId, the
// heartbeat fires against a durable row that is now stopped, readHandle raises
// CONTINUATION_FENCE_LOST, and persist()'s catch announces a failed write once
// every five seconds. The descriptorDirty save() above it fails the same way.
//
// A Stop from another host handle is worse: this process is never told, so
// state.stopped is not even set locally.
test('a Stop during a running turn ends the heartbeat instead of reporting a lost fence', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  const running = f.row();
  assert.equal(running.status, 'running');
  assert.ok(running.leaseUntilMs > 0, 'the turn owns a live lease to heartbeat');

  f.runner.update(session, { effort: 'max' }); // leaves a descriptor save pending
  f.runner.stopSaved(running.key);             // the person's Stop, mid-turn
  const stopped = f.row();
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.leaseUntilMs, null, 'Stop releases the lease it interrupted');

  // Several ticks BEFORE the turn reports anything.
  for (let count = 0; count < 3; count += 1) await f.poll();

  assert.deepEqual(f.pauses.filter(text => STORAGE_FAULT.test(text)), [],
    'a heartbeat against a stopped row is not a failed write');
  assert.deepEqual(f.pauses.filter(text => ERROR_CODE.test(text)), [],
    'and the person is shown no continuation error code');
  assert.deepEqual(f.sent, [], 'a stopped row dispatches nothing');
  const after = f.row();
  assert.equal(after.status, 'stopped', 'the Stop is unchanged');
  assert.equal(after.fence, stopped.fence, 'no tick advanced its fence');
  assert.equal(after.revision, stopped.revision, 'no tick wrote to it at all');
  assert.equal(after.leaseUntilMs, null, 'and no tick refreshed the released lease');

  // The turn finishing later still says nothing false.
  f.runner.completed(session, { status: 'completed' });
  assert.deepEqual(f.pauses.filter(text => STORAGE_FAULT.test(text)), []);
  assert.equal(f.row().status, 'stopped');
});

test('a Stop issued by another host handle mid-turn settles this scheduler without a lost fence', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  const running = f.row();
  assert.equal(running.status, 'running');

  // A SECOND real store on the SAME database file, as another host process
  // would hold. This scheduler is never told; only the durable row changes.
  const other = f.openOtherStore();
  const stopped = other.stop(running.key);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.reason, 'person_stopped');

  for (let count = 0; count < 3; count += 1) await f.poll();

  assert.deepEqual(f.pauses.filter(text => STORAGE_FAULT.test(text)), [],
    'an unannounced Stop is still not a failed write');
  assert.deepEqual(f.sent, [], 'and it authorizes no continuation');
  const after = f.row();
  assert.equal(after.status, 'stopped');
  assert.equal(after.revision, stopped.revision, 'this scheduler wrote nothing to the stopped row');
});

// THE CONTROL. Suppressing the storage sentence for held rows must not suppress
// it when storage really is unavailable, which is the one case it described
// correctly all along. This passes before and after the repair; it exists so a
// blanket suppression cannot pass the two tests above.
test('storage that is genuinely unavailable is still reported as a fault', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  f.storage.close(); // a real store closed underneath a scheduler still running
  f.runner.completed(session, { status: 'completed' });
  assert.equal(f.pauses.length, 1, 'a real fault is announced');
  assert.match(f.pauses[0], STORAGE_FAULT, 'and it still says the write could not be made');
  assert.match(f.pauses[0], /CONTINUATION_CLOSED/, 'naming what actually went wrong');
});

// THE EARLY POLL MUST COST NOTHING.
//
// The host polls every INTERVAL_MS. completed() schedules the next ledger
// review DEFAULT_BASE_DELAY_MS out. At 5 seconds and 15 seconds, two polls in
// every three arrive before the row is due.
//
// tick() did not know that. An early poll passed the success gate, SELECTED a
// task, incremented state.unchanged, took a reservation and stamped
// lastSentAt -- and only then called storage.claim(), which refused the row as
// not yet due and returned null. The dispatch read that null as a lost race
// and set state.stopped = true, which nothing but a person turn ever clears.
// So Autonomous+ stopped permanently at the first poll after the first
// completed turn, silently, with no pause and no error.
//
// Before b591f18d both numbers were 5000 and the first poll was always exactly
// due, which is why this never showed. Raising the durability delay to 15000
// exposed it, and advancing a fixture straight to 15000 hides it again. These
// cases poll at the real interval, so every dispatch is reached THROUGH the
// early path.
test('polls that arrive before the row is due wait, and spend nothing', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });
  const ready = f.row();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.dueAtMs, DEFAULT_BASE_DELAY_MS, 'the next review is one durability delay out');

  for (const mark of ['+5s', '+10s']) {
    await f.poll();
    assert.deepEqual(f.sent, [], `${mark}: nothing is dispatched before the row is due`);
    assert.deepEqual(f.pauses, [], `${mark}: and the person is told nothing`);
    const waiting = f.row();
    assert.equal(waiting.status, 'ready', `${mark}: the row is still waiting, not stopped`);
    assert.equal(waiting.revision, ready.revision, `${mark}: an early poll writes nothing at all`);
    assert.equal(waiting.checkpoint, null, `${mark}: and spends no checkpoint`);
  }

  await f.poll();
  assert.equal(f.sent.length, 1, '+15s: the scheduled review is dispatched');
  assert.deepEqual(f.pauses, []);

  // Still alive for the NEXT turn, which that dispatch completed.
  assert.equal(f.row().status, 'ready', 'the finished continuation schedules another review');
  await f.poll(); await f.poll();
  assert.equal(f.sent.length, 1, 'the next two early polls are quiet too');
  await f.poll();
  assert.equal(f.sent.length, 2, 'and the next due poll dispatches again');
  assert.deepEqual(f.pauses, []);
});

test('the unchanged-task budget is spent by dispatches, not by early polls', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });

  // One dispatch per scheduling interval against the same unchanged task. If an
  // early poll consumed budget, the pause would arrive after fewer sends.
  for (let round = 0; round < MAX_UNCHANGED_TURNS; round += 1) await f.round();
  assert.equal(f.sent.length, MAX_UNCHANGED_TURNS, 'one dispatch per interval, no more and no fewer');
  assert.deepEqual(f.pauses, [], 'the budget is not exhausted early');
  assert.equal(f.row().checkpoint.unchanged, MAX_UNCHANGED_TURNS - 1);

  await f.round();
  assert.equal(f.sent.length, MAX_UNCHANGED_TURNS, 'the next round sends nothing');
  assert.equal(f.pauses.length, 1, 'and pauses on the unchanged task');
  assert.match(f.pauses[0], new RegExp(f.task.id));
});

test('early polls still wait after the store is closed, reopened and recovered', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });
  /* Reach the row's own scheduled time before the restart, because a recovery
     is only offered for a row that is already due. The early-poll assertions
     below run against the NEW due time that recover() schedules, so nothing
     here hops over the early path being tested. */
  f.advance(DEFAULT_BASE_DELAY_MS);
  // The host is gone, so no live session holds this row; that is what makes it
  // a recovery rather than a running continuation.
  f.runner.close(); f.live(false); f.open();

  const restored = f.session('restored-session');
  const [pending] = f.runner.pendingRecoveries();
  assert.ok(pending, 'the finished row is offered for recovery');
  const answer = await f.runner.recover(pending, async descriptor => {
    f.live(true); f.runner.remember(restored, descriptor);
    return { sessionId: restored.sessionId, threadId: descriptor.resumeThreadId, resumed: { turns: [{ status: 'completed' }] } };
  });
  f.runner.attached(answer.continuation.key, answer.sessionId, answer.continuation.revision);
  assert.equal(f.row().status, 'ready');

  await f.poll(); await f.poll();
  assert.deepEqual(f.sent, [], 'a recovered row is waited for on its early polls, not abandoned');
  assert.deepEqual(f.pauses, []);
  assert.equal(f.row().status, 'ready');
  await f.poll();
  assert.equal(f.sent.length, 1, 'and it dispatches once it is due');
});

// THE CONTROL FOR WAITING. Waiting for an early row must not soften a genuine
// refusal: another owner taking the row at the moment it becomes due is a lost
// race, not a reason to wait, and this session must dispatch nothing.
test('a competing claim on the due row still refuses and is not mistaken for waiting', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });

  const other = f.openOtherStore();
  await f.poll(); await f.poll();
  f.advance(INTERVAL_MS);
  const stolen = other.claim(other.get(f.row().key));
  assert.ok(stolen, 'the competing owner holds the claim');
  assert.equal(f.row().status, 'claimed');

  f.runner.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent, [], 'a lost race dispatches nothing');
  assert.equal(f.row().status, 'claimed', 'and the competing claim keeps its custody');
});


// Actual settings change after task selection but before the reserved dispatch.
for (const mode of ['disabled', 'unreadable']) test(`dispatch rechecks ${mode} settings before claiming or sending`, async t => {
  let readable = true, enabled = true;
  const f = fixture(t, { readSettings: () => {
    if (!readable) throw new Error('fixture unreadable settings');
    return { values: { [SETTING_ID]: enabled }, provenance: { [SETTING_ID]: { source: 'user' } } };
  } });
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });
  const before = f.row();
  f.advance(DEFAULT_BASE_DELAY_MS);
  f.runner.tick();
  if (mode === 'disabled') enabled = false; else readable = false;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent, [], 'revoked or unreadable enablement authorizes no send');
  assert.deepEqual(f.row(), before, 'the cancelled dispatch spends no claim, checkpoint or durable retry');
  assert.deepEqual(f.pauses, [], 'settings disablement is not a storage error');
  enabled = readable = true;
  await f.poll();
  assert.equal(f.sent.length, 1, 'a later freshly enabled poll may dispatch normally');
  assert.equal(f.row().checkpoint.unchanged, 0, 'the aborted dispatch did not spend the unchanged-task budget');
});

test('a missing durable backend cannot authorize an automatic turn', async t => {
  const f = fixture(t, { stateFactory: () => null });
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });
  f.advance(DEFAULT_BASE_DELAY_MS);
  f.runner.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent, [], 'no persistence receipt means no automatic send');
});


test('a settings refusal inside persistence cannot masquerade as a successful claim', async t => {
  let dispatchReads = null;
  const f = fixture(t, { readSettings: () => {
    const allowed = dispatchReads === null || ++dispatchReads === 1;
    return { values: { [SETTING_ID]: allowed }, provenance: { [SETTING_ID]: { source: 'user' } } };
  } });
  const session = f.session();
  f.runner.remember(session, f.descriptorFor()); f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });
  const before = f.row(); f.advance(DEFAULT_BASE_DELAY_MS); f.runner.tick();
  dispatchReads = 0;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.row(), before);
  assert.deepEqual(f.pauses, []);
});

test('a refused checkpoint write cannot send and still reports the actual storage fault', async t => {
  let failSave = false, actual, f;
  f = fixture(t, { stateFactory: () => {
    actual = createContinuationState({ file: ':memory:', now: () => f.clock() });
    return { ...actual, save(handle, patch) {
      if (failSave) throw Object.assign(new Error('fixture checkpoint unavailable'), { code: 'CONTINUATION_CHECKPOINT_UNAVAILABLE' });
      return actual.save(handle, patch);
    } };
  } });
  const session = f.session();
  f.runner.remember(session, f.descriptorFor()); f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });
  f.advance(DEFAULT_BASE_DELAY_MS); failSave = true;
  f.runner.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent, []);
  assert.equal(actual.list()[0].status, 'running', 'the refused checkpoint never pretends this attempt completed');
  assert.equal(actual.list()[0].checkpoint, null);
  assert.equal(f.pauses.length, 1);
  assert.match(f.pauses[0], /CONTINUATION_CHECKPOINT_UNAVAILABLE/);
});

for (const mutation of ['person-stop', 'other-stop', 'competing-attempt', 'observed-completion', 'person-resume']) {
  test(`a delayed scheduled refusal preserves ${mutation} outcome ownership`, async t => {
    let rejectSend, f;
    const error = Object.assign(new Error('fixture pre-accept reset'), { code: 'ECONNRESET' });
    f = fixture(t, { send: (session, text) => {
      f.sent.push(text); f.runner.started(session, 'continuation');
      return new Promise((_, reject) => { rejectSend = reject; });
    } });
    const session = f.session();
    f.runner.remember(session, f.descriptorFor()); f.runner.started(session, 'person');
    f.runner.completed(session, { status: 'completed' });
    await f.round();
    assert.equal(f.sent.length, 1); assert.equal(typeof rejectSend, 'function');
    const running = f.row(); assert.equal(running.status, 'running');
    if (mutation === 'person-stop' || mutation === 'person-resume') f.runner.stopSaved(running.key);
    if (mutation === 'other-stop' || mutation === 'competing-attempt') {
      const other = f.openOtherStore(); other.stop(running.key);
      if (mutation === 'competing-attempt') {
        const otherTurn = other.track(f.descriptorFor('other-owner'), { resume: true });
        other.begin(otherTurn, { observed: true });
      }
    }
    if (mutation === 'observed-completion') f.runner.completed(session, { status: 'completed' });
    if (mutation === 'person-resume') { f.runner.started(session, 'person'); f.runner.completed(session, { status: 'completed' }); }
    const settled = f.row();
    rejectSend(error); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.row(), settled, 'the stale rejection cannot rewrite the current durable outcome');
    if (mutation === 'competing-attempt') {
      assert.equal(f.pauses.length, 1); assert.match(f.pauses[0], /CONTINUATION_FENCE_LOST/);
    } else {
      assert.deepEqual(f.pauses.filter(text => STORAGE_FAULT.test(text)), [], 'a legitimate Stop or actual completion is not a lost write');
    }
    assert.equal(f.row().retries, 0, 'the old rejection cannot create an extra retry');
  });
}


test('a closed scheduler never settles or warns about a delayed send rejection', async t => {
  let rejectSend, f;
  f = fixture(t, { send: session => {
    f.runner.started(session, 'continuation');
    return new Promise((_, reject) => { rejectSend = reject; });
  } });
  const session = f.session();
  f.runner.remember(session, f.descriptorFor()); f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' }); await f.round();
  const running = f.row();
  f.runner.close();
  rejectSend(Object.assign(new Error('late fixture refusal'), { code: 'ECONNRESET' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.pauses, [], 'closed ownership emits no new storage fault');
  f.open(); f.runner.remember(session, f.descriptorFor());
  assert.deepEqual(f.row(), running, 'a delayed rejection after close does not claim an observed terminal outcome');
});


test('owned heartbeats and descriptor saves keep a pending refusal on its current lease revision', async t => {
  let rejectSend, f;
  f = fixture(t, { send: session => {
    f.runner.started(session, 'continuation');
    return new Promise((_, reject) => { rejectSend = reject; });
  } });
  const session = f.session();
  f.runner.remember(session, f.descriptorFor()); f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' }); await f.round();
  const initial = f.row();
  f.runner.update(session, { effort: 'high' }); await f.poll();
  const latest = f.row();
  assert.equal(latest.fence, initial.fence, 'this is the same owned attempt');
  assert.ok(latest.revision > initial.revision, 'the real store advanced its owned metadata/heartbeat revision');
  rejectSend(Object.assign(new Error('fixture delayed refusal'), { code: 'ECONNRESET' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.pauses, [], 'our own acknowledged heartbeat is not a competing custody change');
  assert.equal(f.row().status, 'retry_wait');
  assert.equal(f.row().retries, 1);
  assert.equal(f.row().descriptor.effort, 'high');
});

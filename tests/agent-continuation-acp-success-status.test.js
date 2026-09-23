'use strict';

require('./helpers/isolated-state-root'); // Redirect TOOLSENABLED_STATE_ROOT off the live root before anything below resolves it.

/* A LEGITIMATE ACP SUCCESS MUST NOT STOP AUTONOMOUS+.
 *
 * THE DEFECT (Controller, 2026-09-12): a real Grok ACP turn ends turn_completed
 * status 'end_turn' -- the raw ACP session/prompt stopReason, forwarded
 * verbatim (src/lib/agent-engine/acp-adapter.js: `status: stopReason`,
 * requiredString, no local enum). src/lib/agent-ledger-continuation.js's
 * completed() only ever recognized the literal string 'completed' as
 * success; everything else, including a genuinely successful 'end_turn',
 * fell into storage.failed() with retrySafe:false -- the same conservative
 * path a real failure takes -- and could block Autonomous+ on a turn that
 * had actually succeeded. The same gap existed one level lower, in
 * agent-continuation-state.js's reconcile(), which a saved-conversation
 * recovery calls with the same raw status.
 *
 * MEASURED, NOT GUESSED. 'end_turn' is this repository's own measured ACP
 * success spelling: this file's existing fixtures already use it
 * (tests/agent-engine/acp-process.test.js, tests/agent-engine/claude-
 * adapter.js, tests/agent-engine/claude-live-turn.js), and it is the exact
 * value Controller reports a real native Grok turn emitting on success.
 * Antigravity's own adapter (antigravity-cli-adapter.js) already normalizes
 * its native SUCCESS to 'completed' before either continuation module ever
 * sees it, so it needed nothing added -- confirmed by reading that adapter's
 * own turn_completed emission before writing anything here.
 *
 * WHAT THIS SUITE PINS, on the same two real, unstubbed stores the sibling
 * suites already use (createLedgerContinuation over a real
 * createContinuationState, and createContinuationState directly):
 *   - 'completed' and 'end_turn' both settle a row to 'ready' -- a genuine
 *     success, not a held row.
 *   - the ACP protocol's other documented terminal spellings this file has
 *     NOT measured a producer emit (cancelled, refusal, max_tokens,
 *     max_turn_requests) and one wholly synthetic unrecognized status all
 *     still fall to the SAME conservative held path a real failure takes --
 *     nothing here widens what counts as success beyond the one measured
 *     addition.
 *   - a person's Stop still wins even when the turn that raced it reports a
 *     legitimate 'end_turn' success.
 *   - the recovery path (reconcile(), and the full recover() orchestration
 *     above it, including its own "verified terminal turn" gate) treats
 *     'end_turn' exactly as it already treats 'completed', and still refuses
 *     an unrecognized terminal status precisely as before.
 *
 * Run alone with:
 *   node --test tests/agent-continuation-acp-success-status.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const store = require('../src/lib/owner-request-store');
const { createLedgerContinuation, SETTING_ID, HELD_PAUSE, INTERVAL_MS } = require('../src/lib/agent-ledger-continuation');
const { createContinuationState, DEFAULT_BASE_DELAY_MS } = require('../src/lib/agent-continuation-state');

/* THE ACP PROTOCOL'S OTHER DOCUMENTED stopReason VALUES, named here as
   examples of statuses this fix must NOT sweep into success -- not claimed
   as measured from a real transcript the way 'end_turn' is. A synthetic,
   wholly unrecognized string is included beside them so the property under
   test is general (anything but the one measured addition stays held), not
   a hardcoded list this fix happens to special-case. */
const NON_SUCCESS_ACP_STATUSES = ['cancelled', 'refusal', 'max_tokens', 'max_turn_requests', 'not-a-real-status-xyz'];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'continuation-acp-success-'));
  const opts = { rootPath: (...parts) => path.join(dir, ...parts), needsApproval: false };
  let time = 0, live = true, busy = false, runner, storage;
  const sent = [], pauses = [];
  const task = store.fileTask({ scope: 'thread', key: 'saved-node', words: 'Finish the next authorized workflow step' }, opts);
  const session = (id = 'saved-session') => ({ sessionId: id, threadId: 'native-thread-uuid',
    treeRequestIdentity: { threadId: 'saved-node', treeAnchors: ['saved-root', 'saved-node'] } });
  const descriptorFor = (id = 'saved-session') => ({ sessionId: id, resumeThreadId: 'native-thread-uuid',
    resumeThreadProvider: 'grok', cwd: dir, tier: 'grok-4', effort: 'medium', resumeAccount: 'saved-account',
    requestKeys: session(id).treeRequestIdentity });
  const open = () => {
    runner = createLedgerContinuation({ now: () => time, isLive: () => live, canSend: () => live && !busy,
      stateFactory: () => (storage = createContinuationState({ file: path.join(dir, 'continuations.sqlite'), now: () => time })),
      readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
      readTasks: () => { assert.equal(store.verifyHistory(opts).ok, true); return store.readAll({ ...opts, kinds: ['T'] }).records; },
      send: async (worker, text) => { sent.push(text); runner.started(worker, 'continuation'); runner.completed(worker, { status: 'completed' }); },
      onPause: (_, reason) => pauses.push(reason),
    });
    return runner;
  };
  const poll = async () => { time += INTERVAL_MS; runner.tick(); await new Promise(resolve => setImmediate(resolve)); };
  const round = async () => { for (let spent = 0; spent < DEFAULT_BASE_DELAY_MS; spent += INTERVAL_MS) await poll(); };
  t.after(() => { runner?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  open();
  return { session, descriptorFor, task, opts, sent, pauses, poll, round, open,
    storeFile: path.join(dir, 'continuations.sqlite'), clock: () => time,
    get runner() { return runner; }, get storage() { return storage; },
    row: () => storage.list()[0],
    advance: ms => { time += ms; }, live: value => { live = value; }, busy: value => { busy = value; } };
}

test('a real ACP end_turn success settles the row to ready, exactly as completed does', async t => {
  for (const status of ['completed', 'end_turn']) {
    const f = fixture(t);
    const session = f.session();
    f.runner.remember(session, f.descriptorFor());
    f.runner.started(session, 'person');
    f.runner.completed(session, { status });
    const after = f.row();
    assert.equal(after.status, 'ready', `${status}: a genuine success must settle the row to ready`);
    assert.equal(after.reason, 'turn_completed', `${status}: the success reason is unchanged`);
    assert.deepEqual(f.pauses, [], `${status}: a genuine success pauses nothing`);
    await f.round();
    assert.equal(f.sent.length, 1, `${status}: Autonomous+ actually continues on a genuine success`);
  }
});

test('the ACP protocol other documented stopReason values, and one wholly unrecognized status, are never guessed into success', async t => {
  for (const status of NON_SUCCESS_ACP_STATUSES) {
    const f = fixture(t);
    const session = f.session();
    f.runner.remember(session, f.descriptorFor());
    f.runner.started(session, 'person');
    f.runner.completed(session, { status });
    const after = f.row();
    assert.notEqual(after.status, 'ready', `${status}: a non-success status must never settle the row to ready`);
    assert.equal(after.status, 'blocked', `${status}: falls to the same held path a real failure takes`);
    // The actual, already-existing conservative behavior: the event that
    // first blocks a row does not itself announce HELD_PAUSE (that fires on
    // a LATER attempt against an already-held row, see agent-continuation-
    // person-stop.test.js) -- asserted here as fact, not assumed.
    assert.deepEqual(f.pauses, [], `${status}: the first blocking event announces nothing on its own`);
    await f.round();
    assert.deepEqual(f.sent, [], `${status}: a held row authorizes no continuation`);

    // The same hold, met by a fresh agent-origin start, now announces itself
    // -- the exact HELD_PAUSE sentence the sibling Stop suite pins.
    f.runner.close(); f.open();
    const resumed = f.session(`${status}-resumed-session`);
    f.runner.remember(resumed, f.descriptorFor(`${status}-resumed-session`));
    f.runner.started(resumed, 'agent');
    f.runner.completed(resumed, { status: 'completed' });
    assert.equal(f.pauses.length, 1, `${status}: a fresh attempt on the held row is told the truth`);
    assert.equal(f.pauses[0], HELD_PAUSE.blocked);
    assert.equal(f.row().status, 'blocked', `${status}: the agent-origin attempt did not lift the hold`);
  }
});

test('Stop still wins even when the turn that raced it reports a legitimate end_turn success', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });
  f.runner.stopSaved(f.row().key);
  // Read only AFTER stopSaved(): this is the actual stopped row, the fence
  // and reason the Stop itself produced -- not a pre-Stop snapshot.
  const stoppedRow = f.row();
  assert.equal(stoppedRow.status, 'stopped');

  // The Controller resumes the exact node in a NEW agent-origin session, and
  // THAT turn genuinely succeeds with a real end_turn -- not a guess, the
  // measured success spelling this fix adds.
  f.runner.close(); f.open();
  const resumed = f.session('controller-resumed-session');
  f.runner.remember(resumed, f.descriptorFor('controller-resumed-session'));
  f.runner.started(resumed, 'agent');
  f.runner.completed(resumed, { status: 'end_turn' });

  const after = f.row();
  assert.equal(after.status, 'stopped', 'a real success on an agent-origin resume must not lift the persons own Stop');
  assert.equal(after.fence, stoppedRow.fence, 'the fence must not advance past the actual stopped row');
  assert.equal(after.reason, stoppedRow.reason, 'the recorded Stop reason must not be rewritten by a success event');
  assert.deepEqual(f.pauses, [HELD_PAUSE.stopped]);
  f.advance(120000);
  await f.round();
  assert.deepEqual(f.sent, [], 'the held row still authorizes no continuation despite the real success underneath it');
});

/* THE RECOVERY PATH, ONE LEVEL LOWER: agent-continuation-state.js's own
   reconcile(), driven directly against a real claimed row -- the same
   pattern tests/state-store-close.test.js already uses for 'completed'. */
function continuationFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-acp-recover-'));
  const file = path.join(directory, 'continuation.sqlite3');
  let stamp = 100000;
  const opened = [];
  const settings = { file, now: () => stamp, leaseMs: 1000, baseDelayMs: 1000, maxDelayMs: 4000, ...options };
  const open = () => { const store = createContinuationState(settings); opened.push(store); return store; };
  t.after(() => { for (const store of opened) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const descriptor = { sessionId: 'host-original', resumeThreadId: 'provider-thread', resumeThreadProvider: 'grok',
    resumeAccount: 'synthetic-account', cwd: directory, tier: 'grok-4', effort: 'medium',
    requestKeys: { threadId: 'circle', treeAnchors: ['tree', 'circle'] },
    treeIdentity: { selfName: 'Worker', managerName: 'Coordinator' }, profileId: 'synthetic-profile',
    roleBinding: { id: 'worker', agentId: 'worker-seat', expectedOrgRevision: 2, expectedRoleRevision: 3 }, agentId: 'worker-seat' };
  return { file, descriptor, open, store: open(), advance: amount => { stamp += amount; }, now: () => stamp };
}
function reconcilingClaim(f) {
  // The same minimal path tests/state-store-close.test.js's own reconcile()
  // coverage uses: begin(), let the lease expire, claim the row that lease
  // expiry offers as uncertain.
  f.store.begin(f.store.track(f.descriptor));
  f.advance(1001);
  const [uncertain] = f.store.dueRecoveries({ includeUncertain: true });
  return f.store.claim(uncertain);
}

test('reconcile() settles a claimed row to ready for end_turn exactly as it already does for completed', t => {
  for (const terminalStatus of ['completed', 'end_turn']) {
    const f = continuationFixture(t);
    const claim = reconcilingClaim(f);
    assert.equal(claim.status, 'reconciling');
    const resolved = f.store.reconcile(claim, { observedThreadId: f.descriptor.resumeThreadId, terminalStatus });
    assert.equal(resolved.status, 'ready', `${terminalStatus}: reconcile must settle to ready`);
    assert.equal(resolved.reason, 'turn_completed');
  }
});

test('reconcile() still refuses an unrecognized terminal status, never guessing it into success', t => {
  const f = continuationFixture(t);
  const claim = reconcilingClaim(f);
  assert.throws(
    () => f.store.reconcile(claim, { observedThreadId: f.descriptor.resumeThreadId, terminalStatus: 'refusal' }),
    { code: 'CONTINUATION_RECONCILE_REFUSED' },
  );
});

test('the full recover() orchestration accepts a resumed conversation whose last turn ended end_turn, exactly as it already accepts completed', async t => {
  for (const status of ['completed', 'end_turn']) {
    const f = fixture(t);
    const session = f.session();
    f.runner.remember(session, f.descriptorFor());
    f.runner.started(session, 'person');
    f.runner.completed(session, { status: 'completed' });
    f.advance(DEFAULT_BASE_DELAY_MS);
    f.runner.close(); f.live(false); f.open();

    const restored = f.session('restored-session');
    const [pending] = f.runner.pendingRecoveries();
    assert.ok(pending, `${status}: the finished row is offered for recovery`);
    const answer = await f.runner.recover(pending, async descriptor => {
      f.live(true); f.runner.remember(restored, descriptor);
      return { sessionId: restored.sessionId, threadId: descriptor.resumeThreadId, resumed: { turns: [{ status }] } };
    });
    f.runner.attached(answer.continuation.key, answer.sessionId, answer.continuation.revision);
    assert.equal(f.row().status, 'ready', `${status}: recover() must accept this saved conversation turn as a real success`);
  }
});

test('the full recover() orchestration still refuses a saved conversation whose last turn has no verified terminal status', async t => {
  const f = fixture(t);
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });
  f.advance(DEFAULT_BASE_DELAY_MS);
  f.runner.close(); f.live(false); f.open();

  const restored = f.session('restored-session');
  const [pending] = f.runner.pendingRecoveries();
  await assert.rejects(
    f.runner.recover(pending, async descriptor => {
      f.live(true); f.runner.remember(restored, descriptor);
      return { sessionId: restored.sessionId, threadId: descriptor.resumeThreadId, resumed: { turns: [{ status: 'refusal' }] } };
    }),
    /no verified terminal turn/,
  );
});

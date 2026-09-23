'use strict';

require('./helpers/isolated-state-root'); // Redirect TOOLSENABLED_STATE_ROOT off the live root before anything below resolves it.

// T17. THE HALF OF persist() THAT NEVER TOLD ANYBODY.
//
// persist() in ledger-continuation-controller.js had two failure modes and
// announced only one of them:
//
//   catch        -> state.stopped = true, onPause("could not be updated")
//   short-circuit-> return false, in silence
//
// and no caller looked at the return value. So every success and failure write
// this scheduler makes could be skipped without a pause, a log or any other
// signal, leaving the saved row exactly as it was.
//
// That matters most at completed(), because how a turn ended is the one fact
// the scheduler cannot reconstruct later. A skipped write there leaves the row
// `running` for ever: it looks busy, nothing revisits it, and the person is
// told nothing. That is the shape of the measured T17 silence -- the owner's
// agent failed twice on an account usage limit and its row stayed
// status "running" / reason "running", retries 0, until they intervened.
//
// A SECOND, INDEPENDENT CONFUSION reached the same silent guard.
// allowed() was `try { return enabled(readSettings()); } catch { return false }`,
// so a transient failure to READ the setting was indistinguishable from the
// person having switched Autonomous+ OFF. One of those is a decision and the
// other is a fault, and they must not look alike.
//
// WHAT THESE TESTS FIX IN PLACE.
//   - "off" stays SILENT. The person turned it off; a pause would be noise,
//     and a repair that announces it fails here.
//   - "cannot read the setting" is ANNOUNCED, and its words do not claim a
//     write failed, because none did.
//   - a tracked session whose completion was not recorded is ANNOUNCED.
//   - a session this scheduler never tracked stays SILENT, so an untracked
//     session cannot make every ordinary turn pause.
//
//   node tests/agent-continuation-persist-silence.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const store = require('../src/lib/owner-request-store');
const { createLedgerContinuation, SETTING_ID } = require('../src/lib/agent-ledger-continuation');
const { createContinuationState } = require('../src/lib/agent-continuation-state');

// The catch path's words, which describe a write that failed. The setting-read
// fault must NOT borrow them: nothing failed to be written there.
const STORAGE_FAULT = /could not be updated/i;

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'continuation-persist-silence-'));
  const opts = { rootPath: (...parts) => path.join(dir, ...parts), needsApproval: false };
  let time = 0, storage;
  const sent = [], pauses = [];
  store.fileTask({ scope: 'thread', key: 'saved-node', words: 'Finish the next authorized workflow step' }, opts);
  const session = (id = 'saved-session') => ({ sessionId: id, threadId: 'native-thread-uuid',
    treeRequestIdentity: { threadId: 'saved-node', treeAnchors: ['saved-root', 'saved-node'] } });
  const descriptorFor = (id = 'saved-session') => ({ sessionId: id, resumeThreadId: 'native-thread-uuid',
    resumeThreadProvider: 'codex', cwd: dir, tier: 'gpt-6-terra', effort: 'ultra', resumeAccount: 'saved-account',
    requestKeys: session(id).treeRequestIdentity });
  const runner = createLedgerContinuation({ now: () => time, isLive: () => true, canSend: () => true,
    stateFactory: () => (storage = createContinuationState({ file: path.join(dir, 'continuations.sqlite'), now: () => time })),
    readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
    readTasks: () => store.readAll({ ...opts, kinds: ['T'] }).records,
    send: async (worker, text) => { sent.push(text); },
    onPause: (_, reason) => pauses.push(reason),
    ...overrides,
  });
  t.after(() => { runner.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { runner, session, descriptorFor, pauses, sent, opts,
    get storage() { return storage; }, row: () => storage?.list()[0] };
}

const SETTING_ON = { values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } };
const SETTING_OFF = { values: { [SETTING_ID]: false }, provenance: { [SETTING_ID]: { source: 'user' } } };

test('the setting switched OFF records nothing and says nothing: that is the person\'s decision, not a fault', async (t) => {
  let settings = SETTING_ON;
  const f = fixture(t, { readSettings: () => settings });
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  assert.ok(f.row(), 'the row must exist while the setting is on, or this test is not measuring the off case');

  settings = SETTING_OFF;
  f.runner.completed(session, { status: 'failed' });

  assert.deepEqual(f.pauses, [],
    `switching Autonomous+ off must not announce anything; a person who turned it off is not reporting a fault. Saw: ${JSON.stringify(f.pauses)}`);
});

test('a setting that CANNOT BE READ is announced, and is not described as a failed write', async (t) => {
  let settings = SETTING_ON;
  const f = fixture(t, { readSettings: () => {
    if (settings === 'unreadable') throw Object.assign(new Error('settings unavailable'), { code: 'EACCES' });
    return settings;
  } });
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');

  settings = 'unreadable';
  f.runner.completed(session, { status: 'failed' });

  assert.equal(f.pauses.length, 1,
    `an unreadable setting must be announced exactly once, or it stays indistinguishable from the setting being off. Saw: ${JSON.stringify(f.pauses)}`);
  assert.match(f.pauses[0], /could not be read/i,
    `the announcement must say the setting could not be read: ${JSON.stringify(f.pauses[0])}`);
  assert.doesNotMatch(f.pauses[0], STORAGE_FAULT,
    `it must NOT borrow the catch path's "could not be updated" wording, because no write failed here: ${JSON.stringify(f.pauses[0])}`);
});

test('a tracked session whose completion was not recorded is announced, rather than left looking busy', async (t) => {
  /* THE STORE ITSELF IS UNAVAILABLE. persist() returns false without throwing
     whenever backend() yields nothing -- the saved-continuation store could not
     be opened at all -- and before this change no caller looked at that answer.
     The session is still tracked (remember() set the descriptor) and the
     setting is still on, so the person is entitled to know their agent will not
     continue. This does not simulate a store operation declining: the real
     store either returns a row or throws, and the throw is the catch path's
     business, which is already announced. */
  const f = fixture(t, { stateFactory: () => null });
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  assert.deepEqual(f.pauses, [],
    `nothing should be announced before the completion, or this test cannot attribute the report: ${JSON.stringify(f.pauses)}`);

  f.runner.completed(session, { status: 'failed' });

  assert.equal(f.pauses.length, 1,
    `a completion that was not recorded must be announced; silence here is the defect, because the row still reads "running" and nothing will revisit it. Saw: ${JSON.stringify(f.pauses)}`);
  assert.match(f.pauses[0], /could not record how that turn ended/i,
    `the announcement must name what was lost: ${JSON.stringify(f.pauses[0])}`);
});

test('a session this scheduler never tracked stays silent, so an untracked session cannot make every turn pause', async (t) => {
  const f = fixture(t, {});
  const session = f.session('never-remembered');
  // No remember(), so there is no descriptor: this scheduler is not tracking it.
  f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });
  f.runner.completed(session, { status: 'failed' });

  assert.deepEqual(f.pauses, [],
    `a session with no descriptor is not this scheduler's to report on; announcing it would pause ordinary turns. Saw: ${JSON.stringify(f.pauses)}`);
});

test('an ordinary recorded completion still announces nothing', async (t) => {
  const f = fixture(t, {});
  const session = f.session();
  f.runner.remember(session, f.descriptorFor());
  f.runner.started(session, 'person');
  f.runner.completed(session, { status: 'completed' });

  assert.deepEqual(f.pauses, [],
    `a completion that WAS recorded must stay silent, or the new report is just noise on every turn. Saw: ${JSON.stringify(f.pauses)}`);
});

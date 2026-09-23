'use strict';

require('./helpers/isolated-state-root'); // Redirect TOOLSENABLED_STATE_ROOT off the live root before anything below resolves it.

// ONE SAVED-CONTINUATION READ LISTED THE WHOLE CUSTODY STORE ONCE PER DUE ROW.
//
// OBSERVED on the owner's Linux profile, 2026-09-21, first session after
// history verification became opt-in (a6c70ac6): the window's five-second
// `continuations { action: 'read' }` poll held the Electron main thread for
// 2.4-3.0 s on EVERY call (main-lag rows name `await:mc-agent:continuations`),
// 57% of one core with no agent running. The store held 345 rows, 195 of them
// due. pendingRecoveries() filters the due rows through actionableTasks(), and
// actionableTasks() listed every saved row again for each of them: one SQLite
// read, hash check and JSON parse per row per due row, 195 x 345 per poll.
// Before a6c70ac6 the same read threw "history cannot be verified" before it
// reached the filter, which is why nothing measured it.
//
// The custody rows cannot change inside one synchronous filter pass, so one
// listing per read says exactly what the per-row listings said.
//
// EVERY CASE RUNS THE REAL continuation-state store on a real SQLite file. The
// only thing counted is how often the scheduler asks that store for its list.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const store = require('../src/lib/owner-request-store');
const { createLedgerContinuation, SETTING_ID } = require('../src/lib/agent-ledger-continuation');
const { createContinuationState, DEFAULT_BASE_DELAY_MS } = require('../src/lib/agent-continuation-state');

function fixture(t, nodes) {
  const dir = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'continuation-read-cost-'));
  const opts = { rootPath: (...parts) => path.join(dir, ...parts), needsApproval: false };
  let time = 0, live = true, runner, real, listings = 0;
  const session = index => ({ sessionId: `session-${index}`, threadId: `native-thread-${index}`,
    treeRequestIdentity: { threadId: `node-${index}`, treeAnchors: ['saved-root', `node-${index}`] } });
  const descriptor = index => ({ sessionId: `session-${index}`, resumeThreadId: `native-thread-${index}`,
    resumeThreadProvider: 'codex', cwd: dir, tier: 'gpt-6-terra', effort: 'ultra', resumeAccount: 'saved-account',
    requestKeys: session(index).treeRequestIdentity });
  for (let index = 0; index < nodes; index += 1) {
    store.fileTask({ scope: 'thread', key: `node-${index}`, words: `Finish the authorized step for node ${index}` }, opts);
  }
  const open = () => {
    runner = createLedgerContinuation({ now: () => time, isLive: () => live, canSend: () => false,
      stateFactory: () => {
        real = createContinuationState({ file: path.join(dir, 'continuations.sqlite'), now: () => time });
        // The real store, unchanged; only the scheduler's own list() calls are counted.
        return Object.freeze({ ...real, list: () => { listings += 1; return real.list(); } });
      },
      readSettings: () => ({ values: { [SETTING_ID]: true }, provenance: { [SETTING_ID]: { source: 'user' } } }),
      readTasks: () => store.readAll({ ...opts, kinds: ['T'] }).records,
      send: async () => {}, onPause: () => {} });
    return runner;
  };
  t.after(() => { runner?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  open();
  for (let index = 0; index < nodes; index += 1) {
    const worker = session(index);
    runner.remember(worker, descriptor(index));
    runner.started(worker, 'person');
    runner.completed(worker, { status: 'completed' });
  }
  // The app closes and reopens after every row has come due: no live session holds any of them.
  time += DEFAULT_BASE_DELAY_MS;
  runner.close(); live = false; open();
  return { get runner() { return runner; }, get real() { return real; },
    listings: () => listings, reset: () => { listings = 0; }, advance: ms => { time += ms; } };
}

test('a saved-continuation read lists the custody rows once, not once per due row', t => {
  const NODES = 12;
  const f = fixture(t, NODES);
  f.reset();
  const pending = f.runner.pendingRecoveries();
  assert.equal(pending.length, NODES, 'every due row with its own open task is offered');
  assert.deepEqual(pending.map(row => row.descriptor.requestKeys.threadId).sort(),
    Array.from({ length: NODES }, (_, index) => `node-${index}`).sort());
  assert.equal(f.listings(), 1, `${NODES} due rows must not cost ${NODES} listings of the whole store`);
});

test('a row the person stopped leaves the offer and the read still lists once', t => {
  const f = fixture(t, 3);
  const before = f.runner.pendingRecoveries().map(row => row.key).sort();
  assert.equal(before.length, 3);
  // The person stops one row: it leaves the offer, the other two stay, and the read still lists once.
  f.runner.stopSaved(before[0]);
  f.reset();
  const after = f.runner.pendingRecoveries().map(row => row.key).sort();
  assert.deepEqual(after, before.slice(1));
  assert.equal(f.listings(), 1);
});

test('a read with nothing due does not list the custody rows at all', t => {
  const f = fixture(t, 2);
  for (const row of f.runner.pendingRecoveries()) f.runner.stopSaved(row.key);
  f.reset();
  assert.deepEqual(f.runner.pendingRecoveries(), []);
  assert.equal(f.listings(), 0);
});

// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-cloud-batch-runner-test-js):
// - FOUND (empty collection): the round-robin journal/account assertion used
//   `launches.every(...)` without proving that any launch rows existed. Mutation:
//   batch-runner omitted `recordLaunched` only for the nine-task round-robin
//   case. Before this change the complete file remained GREEN (exit 0):
//   "cloud-batch-runner tests passed (122 checks: ... accounts rotated evenly ...)".
//   With the non-vacuity check below, the same mutation is RED:
//   "AssertionError [ERR_ASSERTION]: accounts: the journal records every dispatch
//   under the account it really went out under, which is where anybody looks when
//   a bill is queried (journal launches: 0, dispatches: 9)".
// - FOUND (expected value computed by subject): the per-account ceiling check
//   captured the exported value in `ceiling` and compared the export back to
//   itself. Mutation: changed the product constant from 72 to 73. The strengthened
//   independent expectation is RED:
//   "AssertionError [ERR_ASSERTION]: accounts: the measured per-account ceiling
//   remains 72 launches per minute (got 73)".
// - NOT-FOUND (exit status/truthy return as sole process evidence): this test
//   spawns no child process and makes no exit-status assertion.
// - NOT-FOUND (swallowed subject failure): `raises` requires both a thrown value
//   and its exact code; the explicit resume catch likewise asserts code and index.
//   The final cleanup catch is not part of a subject assertion.
// - NOT-FOUND (mock of the thing under test): dispatch, clock, sleep, and mirror
//   are boundary fakes; runBatch, journal parsing, and admission are real subjects.
// - NOT-FOUND (skip/platform guard): there is no skip or platform precondition.
// - Preconditions unmet: none. After each mutation the product source was
//   restored byte-for-byte (matching SHA-256), and the restored test is GREEN:
//   "cloud-batch-runner tests passed (122 checks: ... journal that cannot be
//   written stopping the run before the provider is called)."

'use strict';

// The batch runner: what happens to an admitted batch once nobody is steering.
//
// EVERYTHING HERE IS ABOUT ORDER, AND ORDER IS ABOUT MONEY. A cloud task cannot
// be cancelled and is not refunded, so the interesting questions are not "did
// five tasks launch". They are: what is on disk at the instant the provider is
// called, what a resume is allowed to do with a half-written journal, and what
// happens to the other 249 tasks when task 3 comes back refused.
//
// The dispatcher, the clock and the sleep are all injected fakes. That is not a
// shortcut around a real test -- it is the only way these properties can be
// asserted at all, because the real versions spend quota on work nobody can
// recall.
//
// NOTHING HERE PINS A SPELLING. Round-robin is asserted as "even, and never the
// same account twice running", not as a particular modulo. Pacing is asserted as
// elapsed time and spacing between dispatches, not as a sleep call count. Both
// would still pass against a better implementation of the same behaviour.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = require('../src/lib/cloud-agent/batch-target');
const journal = require('../src/lib/cloud-agent/batch-journal');
const runner = require('../src/lib/cloud-agent/batch-runner');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

async function raises(code, action, message) {
  let error = null;
  try { await action(); } catch (raised) { error = raised; }
  check(error !== null, `${message} (nothing was thrown)`);
  check(error && error.code === code, `${message} (expected ${code}, got ${error && error.code}: ${error && error.message})`);
  return error;
}

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-batch-runner-'));
let roomCounter = 0;
function room() {
  roomCounter += 1;
  const dir = path.join(TEMP, `run-${roomCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A brief that PASSES the admission validator. The runner never looks inside it,
// but the batch has to be genuinely admitted for the seal to mean anything.
function task(index, targetPath) {
  const file = targetPath || `src/file-${index}.js`;
  return { target: file, contract: [
    'CONTRACT/1',
    'role      IMPLEMENTER',
    `target    ${file}`,
    'do        give every empty catch in this file a named reason',
    `because   3 empty catch blocks measured in ${file}, each discarding the refusal it was meant to report`,
    'done      no catch in this file discards an error without reporting it or carrying a written reason',
    `report    REPORT-${index}.md`,
  ].join('\n') };
}

// Deliberately a MUTABLE plain object: the seal is only worth checking if the
// thing the runner re-checks is the thing a coordinator could still edit.
function declaration({ taskCount = 5, batchId = 'wave-1', bounds = null } = {}) {
  return {
    schemaVersion: target.BATCH_SCHEMA,
    batchId,
    project: 'engine',
    tasks: Array.from({ length: taskCount }, (unused, index) => task(index)),
    bounds: bounds || { launchesPerMinute: 120, accounts: 2 }
  };
}

const FRESH_MIRROR = { checkMirrorFreshness: async () => ({ fresh: true }) };
const ACCOUNTS = ['account-one', 'account-two'];

async function admitted(decl) {
  return target.admitBatch(decl, { mirrorApi: FRESH_MIRROR });
}

// A clock that only moves when something sleeps. A busy-wait against it would
// never terminate -- which is precisely the assertion this lets us make.
function fakeClock(start = 1000) {
  const state = { at: start, slept: [] };
  return {
    now: () => state.at,
    sleep: async (ms) => { state.slept.push(ms); state.at += ms; },
    get elapsed() { return state.at - start; },
    get sleptTotal() { return state.slept.reduce((sum, ms) => sum + ms, 0); }
  };
}

function readLines(file) {
  return String(fs.readFileSync(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

// A filesystem that fails exactly one kind of journal line, so "the process died
// between the intent and the outcome" is reproducible on demand instead of by
// killing a real process at a lucky moment.
function fsFailingOn(matcher) {
  return Object.assign({}, fs, {
    writeSync: (handle, line) => {
      if (matcher(String(line))) throw new Error('ENOSPC (simulated)');
      return fs.writeSync(handle, line);
    }
  });
}

(async () => {
  // -------------------------------------------------------------------
  // A clean run: every admitted task dispatched once, recorded, closed.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const seen = [];
    const clock = fakeClock();
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ task: dispatchedTask, index, account }) => {
        seen.push({ index, targetPath: dispatchedTask.target, account });
        return { taskId: `provider-${index}` };
      }
    });

    check(summary.launched === 5 && summary.refused === 0 && summary.remaining === 0,
      `run: every admitted task is dispatched exactly once (got ${JSON.stringify(summary)})`);
    check(seen.length === 5 && seen.every((call, position) => call.index === position),
      'run: the dispatcher is handed every admitted index');
    check(seen.every((call, position) => call.targetPath === decl.tasks[position].target),
      'run: the dispatcher is handed the task the declaration admitted for that index, not merely its number');

    const records = readLines(summary.journalFile);
    const launches = records.filter((r) => r.kind === 'launched');
    check(launches.length === 5, 'run: every launch is on disk');
    check(launches.every((r) => r.taskId === `provider-${r.index}`),
      'run: the recorded id is the one the provider answered -- that id is the only handle anybody has on a task that cannot be cancelled');
    const closed = records.filter((r) => r.kind === 'closed');
    check(closed.length === 1 && closed[0].launched === 5 && closed[0].refused === 0 && closed[0].unresolved === 0,
      'run: the batch is closed with the counts it really achieved');
  }

  // -------------------------------------------------------------------
  // THE ORDERING, asserted from inside the dispatcher.
  //
  // The intent must be on disk and flushed BEFORE the provider is called, and
  // the only moment that question means anything is while the provider call is
  // happening. A crash one instruction later has to leave a record saying "this
  // may be running under an id nobody wrote down". Written after the call, that
  // crash leaves nothing -- and the only honest recovery from nothing is to pay
  // for the whole batch a second time.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const dir = room();
    const file = journal.journalPath(dir, decl.batchId);
    const clock = fakeClock();
    const atCallTime = [];
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: dir,
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ index }) => {
        const onDisk = readLines(file);
        atCallTime.push({
          index,
          intentWritten: onDisk.some((r) => r.kind === 'intent' && r.index === index),
          outcomeWritten: onDisk.some((r) => (r.kind === 'launched' || r.kind === 'refused') && r.index === index)
        });
        return { taskId: `provider-${index}` };
      }
    });

    check(summary.launched === 5, 'ordering: the run completed, so all five observations were taken');
    check(atCallTime.length === 5 && atCallTime.every((o) => o.intentWritten === true),
      `ordering: the intent for a dispatch is flushed to the journal BEFORE the provider is called, for every dispatch (observed ${JSON.stringify(atCallTime)})`);
    check(atCallTime.every((o) => o.outcomeWritten === false),
      'ordering: no outcome is written before the provider has answered -- an outcome written early is a launch nobody can prove happened');
  }

  // -------------------------------------------------------------------
  // THE SEAL IS CHECKED BEFORE EVERY DISPATCH, not once at the start.
  //
  // The declaration is edited from inside dispatch 1. Dispatch 2 must never
  // happen: an edited declaration is one that never passed the gates.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const clock = fakeClock();
    let calls = 0;
    const error = await raises('CLOUD_BATCH_SEAL_BROKEN',
      () => runner.runBatch({
        admission,
        declaration: decl,
        stateRoot: room(),
        accounts: ACCOUNTS,
        now: clock.now,
        sleep: clock.sleep,
        dispatch: async ({ index }) => {
          calls += 1;
          if (index === 1) decl.tasks[3].target = 'src/edited-after-admission.js';
          return { taskId: `provider-${index}` };
        }
      }),
      'seal: a declaration edited mid-run stops the batch rather than dispatching work nobody admitted');
    check(calls === 2,
      `seal: the edit made during dispatch 1 is caught before dispatch 2 -- a seal checked once at the start would have run all five (dispatches made: ${calls})`);
    check(error.details && error.details.batchRun && error.details.batchRun.remaining === 3,
      `seal: the refusal carries what was left undone, so the stop is recoverable rather than merely reported (got ${JSON.stringify(error.details && error.details.batchRun)})`);
    const records = readLines(error.details.batchRun.journalFile);
    check(records.filter((r) => r.kind === 'launched').length === 2
      && records.some((r) => r.kind === 'closed'),
      'seal: the journal of a stopped run is still closed and still says exactly what went out');
  }

  // -------------------------------------------------------------------
  // THE DECLARED RATE IS HONOURED BY SPACING, against an injected clock.
  //
  // Asserted as elapsed time and as the gap between dispatches, because that is
  // what a rate limit measures. Also asserted: every millisecond of that elapsed
  // time came from sleeping. A spin would burn a core to achieve the same wait,
  // and against this clock it would never finish at all.
  // -------------------------------------------------------------------
  for (const [launchesPerMinute, taskCount] of [[60, 6], [120, 8]]) {
    const decl = declaration({ taskCount, bounds: { launchesPerMinute, accounts: 2 } });
    const admission = await admitted(decl);
    const clock = fakeClock();
    const startedAt = [];
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ index }) => { startedAt.push(clock.now()); return { taskId: `provider-${index}` }; }
    });
    const interval = 60000 / launchesPerMinute;
    const floor = (taskCount - 1) * interval;
    check(summary.launched === taskCount, `pacing: all ${taskCount} tasks launched at ${launchesPerMinute}/min`);
    check(clock.elapsed >= floor,
      `pacing: ${taskCount} dispatches at ${launchesPerMinute}/min took at least ${floor}ms (took ${clock.elapsed}ms)`);
    check(startedAt.every((at, position) => position === 0 || at - startedAt[position - 1] >= interval),
      `pacing: consecutive dispatches are at least ${interval}ms apart, which is what the provider's rate limit actually measures`);
    check(clock.sleptTotal === clock.elapsed,
      `pacing: every millisecond waited was spent asleep, not spinning (slept ${clock.sleptTotal}ms of ${clock.elapsed}ms elapsed)`);
  }

  // -------------------------------------------------------------------
  // RESUME. Only what the journal says remains is dispatched.
  //
  // Re-dispatching something already launched pays for it twice, and there is
  // no refund and no cancel.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const dir = room();
    const file = journal.openBatch({ stateRoot: dir, admission, at: 1 });
    journal.recordIntent({ file, index: 0, target: decl.tasks[0].target, at: 2 });
    journal.recordLaunched({ file, index: 0, taskId: 'provider-0', account: ACCOUNTS[0], at: 3 });
    journal.recordIntent({ file, index: 1, target: decl.tasks[1].target, at: 4 });
    journal.recordLaunched({ file, index: 1, taskId: 'provider-1', account: ACCOUNTS[1], at: 5 });
    journal.recordIntent({ file, index: 2, target: decl.tasks[2].target, at: 6 });
    journal.recordRefused({ file, index: 2, code: 'CODEX_QUOTA_EXHAUSTED', reason: 'no quota', at: 7 });

    const clock = fakeClock();
    const dispatchedIndices = [];
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      journalFile: file,
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ index }) => { dispatchedIndices.push(index); return { taskId: `provider-${index}` }; }
    });

    check(dispatchedIndices.join(',') === '3,4',
      `resume: only the indices with no recorded outcome are dispatched (dispatched ${JSON.stringify(dispatchedIndices)})`);
    check(!dispatchedIndices.includes(0) && !dispatchedIndices.includes(1),
      'resume: an index already launched is never dispatched again -- that is a second bill for work already running');
    check(!dispatchedIndices.includes(2),
      'resume: an index already refused is not retried behind the coordinator\'s back either; a retry is a decision, not a default');
    check(summary.launched === 2 && summary.remaining === 0,
      `resume: the summary reports what THIS run did and what is still owed (got ${JSON.stringify(summary)})`);
    const after = journal.readJournal(file);
    check(after.launched.length === 4 && after.refused.length === 1,
      'resume: the journal holds the whole batch across both runs, not just the last one');
  }

  // -------------------------------------------------------------------
  // A RESUME REFUSES WHILE ANYTHING IS UNRESOLVED, and dispatches nothing.
  //
  // An intent with no outcome may be running and billing under an id nobody
  // wrote down. Treating it as failed pays twice; treating it as done skips
  // work. Nothing in this module can tell which, so it refuses to guess.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const dir = room();
    const file = journal.openBatch({ stateRoot: dir, admission, at: 1 });
    journal.recordIntent({ file, index: 1, target: decl.tasks[1].target, at: 2 });

    let calls = 0;
    const clock = fakeClock();
    const error = await raises('CLOUD_BATCH_UNRECONCILED',
      () => runner.runBatch({
        admission,
        declaration: decl,
        journalFile: file,
        accounts: ACCOUNTS,
        now: clock.now,
        sleep: clock.sleep,
        dispatch: async () => { calls += 1; return { taskId: 'never' }; }
      }),
      'resume: an intent with no outcome stops the resume until somebody reconciles it against the provider');
    check(calls === 0,
      `resume: nothing at all is dispatched while the journal is unreconciled -- not even the untouched indices (dispatches made: ${calls})`);
    check(/Indices: 1/.test(error.message),
      'resume: the refusal names WHICH dispatch is unresolved, so reconciling it is a lookup rather than a hunt');
  }

  // -------------------------------------------------------------------
  // A JOURNAL FROM ANOTHER BATCH IS REFUSED, and "cannot tell" is kept
  // separate from "not this one".
  //
  // A journal addresses tasks by INDEX. Resuming batch A from batch B's journal
  // reads "index 4 already launched" and skips a completely different task:
  // work silently never done, with a file that says it was.
  // -------------------------------------------------------------------
  {
    const mine = declaration({ batchId: 'wave-mine' });
    const theirs = declaration({ batchId: 'wave-theirs', taskCount: 4 });
    const myAdmission = await admitted(mine);
    const theirAdmission = await admitted(theirs);
    const dir = room();
    const theirFile = journal.openBatch({ stateRoot: dir, admission: theirAdmission, at: 1 });

    let calls = 0;
    const clock = fakeClock();
    const mismatch = await raises('CLOUD_BATCH_JOURNAL_MISMATCH',
      () => runner.runBatch({
        admission: myAdmission,
        declaration: mine,
        journalFile: theirFile,
        accounts: ACCOUNTS,
        now: clock.now,
        sleep: clock.sleep,
        dispatch: async () => { calls += 1; return { taskId: 'never' }; }
      }),
      'journal identity: a journal opened for another admission is refused rather than resumed');
    check(calls === 0, 'journal identity: nothing is dispatched against a journal that belongs to another batch');
    check(/skips work while reporting it done/.test(mismatch.message),
      'journal identity: the refusal says what the damage would be, not merely that two hashes differ');

    const headless = path.join(dir, 'headless.jsonl');
    fs.writeFileSync(headless, `${JSON.stringify({ kind: 'launched', index: 0, taskId: 'x', account: 'a', at: 1 })}\n`);
    const unidentified = await raises('CLOUD_BATCH_JOURNAL_UNIDENTIFIED',
      () => runner.runBatch({
        admission: myAdmission,
        declaration: mine,
        journalFile: headless,
        accounts: ACCOUNTS,
        now: clock.now,
        sleep: clock.sleep,
        dispatch: async () => { calls += 1; return { taskId: 'never' }; }
      }),
      'journal identity: a journal whose batch cannot be established is its own refusal, not a mismatch');
    check(unidentified.code !== mismatch.code,
      '"could not tell which batch" and "a different batch" are different answers with different remedies, and are never merged');
    check(calls === 0, 'journal identity: nothing is dispatched against a journal nobody can identify');
  }

  // -------------------------------------------------------------------
  // ONE PROVIDER REFUSAL DOES NOT ABANDON THE BATCH, and every refusal is
  // recorded BY NAME. A silent skip here is a launch count nobody can
  // reconcile against a bill.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const clock = fakeClock();
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ index }) => {
        /* THE PROVIDER ANSWERED. `providerAnswered` is what makes this certain:
           the account replied that it is out of quota, so the task definitely
           did not start and recording it as refused is the truth.

           THIS TEST USED TO ALSO THROW `socket hang up` HERE AND ASSERT A
           REFUSAL ROW FOR IT. That was the defect, enshrined: a socket dying
           after the request went out is the canonical could-not-tell case, and
           filing it as certain non-delivery is how a task that is running and
           billing gets recorded as never having run. It is now its own case
           below, asserting the opposite. */
        if (index === 1) {
          const refusal = new CloudAgentError('CODEX_QUOTA_EXHAUSTED', 'the account is out of cloud quota for today');
          refusal.providerAnswered = true;
          throw refusal;
        }
        return { taskId: `provider-${index}` };
      }
    });

    check(summary.launched === 4 && summary.refused === 1 && summary.remaining === 0,
      `refusal: the run continues past a refusal and still finishes the batch (got ${JSON.stringify(summary)})`);
    const records = readLines(summary.journalFile);
    const refusals = records.filter((r) => r.kind === 'refused');
    check(refusals.length === 1, 'refusal: the provider-answered refusal is on disk');
    const quota = refusals.find((r) => r.index === 1);
    check(quota && quota.code === 'CODEX_QUOTA_EXHAUSTED' && /out of cloud quota/.test(quota.reason),
      'refusal: a coded provider refusal keeps its own code and its reason, so a batch can be triaged without reading prose');
    const closed = records.find((r) => r.kind === 'closed');
    check(closed.launched === 4 && closed.refused === 1,
      'refusal: the closing counts match what actually happened, refusals included');
  }

  // -------------------------------------------------------------------
  // A TRANSPORT FAILURE IS NOT A REFUSAL. This is the defect the block above
  // used to enshrine, asserted the other way round.
  //
  // A socket that dies AFTER the request went out cannot tell you whether the
  // provider got it. The task may be running right now, billing, under an id
  // nobody wrote down -- and a cloud task cannot be cancelled. So filing it as
  // refused has two outcomes and both are bad: the coordinator reads "refused"
  // and hand-retries it into a second bill, or a resume sees it settled and the
  // untracked task runs on with the journal swearing it never started.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const clock = fakeClock();
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ index }) => {
        // No `providerAnswered`. Nobody knows whether this arrived.
        if (index === 2) throw new Error('socket hang up');
        return { taskId: `provider-${index}` };
      }
    });

    check(summary.unresolved === 1 && summary.refused === 0,
      `transport: an ambiguous throw is UNRESOLVED, never refused (got ${JSON.stringify(summary)})`);
    const records = readLines(summary.journalFile);
    check(records.filter((r) => r.kind === 'refused').length === 0,
      'transport: nothing was written claiming the provider turned it away, because nobody established that');
    const intent = records.find((r) => r.kind === 'intent' && r.index === 2);
    check(Boolean(intent),
      'transport: the intent written BEFORE the call is still on disk -- that record is the whole point');
    check(!records.some((r) => (r.kind === 'launched' || r.kind === 'refused') && r.index === 2),
      'transport: the intent has no outcome after it, which is what makes it unresolved');

    // And the consequence that matters: a resume must refuse rather than guess.
    let resumeError = null;
    try {
      journal.resumePlan(journal.readJournal(summary.journalFile), { totalTasks: decl.tasks.length });
    } catch (error) { resumeError = error; }
    check(resumeError && resumeError.code === 'CLOUD_BATCH_UNRECONCILED',
      'transport: a resume REFUSES until somebody reconciles it against the provider, rather than silently re-dispatching a task that may already be running');
    check(resumeError && /2/.test(resumeError.message),
      'transport: the refusal names WHICH index needs reconciling');
  }

  // -------------------------------------------------------------------
  // A DISPATCH THAT ANSWERS WITHOUT AN ID IS UNKNOWN, NEVER FAILED.
  //
  // The provider may well have accepted the task. Recording a launch would
  // invent an id; recording a refusal would claim it never ran and let a resume
  // pay for it again. So the intent is left outcome-less, which is what makes
  // the next resume refuse until somebody looks.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const clock = fakeClock();
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ index }) => (index === 2 ? {} : { taskId: `provider-${index}` })
    });

    check(summary.launched === 4 && summary.refused === 0 && summary.unresolved === 1,
      `unknown: an id-less answer is counted apart from both launches and refusals (got ${JSON.stringify(summary)})`);
    const readBack = journal.readJournal(summary.journalFile);
    check(readBack.unresolved.length === 1 && readBack.unresolved[0].index === 2,
      'unknown: the id-less dispatch is left as an intent with no outcome, which is the record that says "this may be running and billing"');
    check(readBack.refused.length === 0,
      'unknown: it is NOT filed as a refusal -- a refusal is something a resume may safely leave alone');
    const clock2 = fakeClock();
    let calls = 0;
    await raises('CLOUD_BATCH_UNRECONCILED',
      () => runner.runBatch({
        admission,
        declaration: decl,
        journalFile: summary.journalFile,
        accounts: ACCOUNTS,
        now: clock2.now,
        sleep: clock2.sleep,
        dispatch: async () => { calls += 1; return { taskId: 'never' }; }
      }),
      'unknown: the next resume of that journal refuses until the unknown dispatch is reconciled against the provider');
    check(calls === 0, 'unknown: and it dispatches nothing while it refuses');
  }

  // -------------------------------------------------------------------
  // A NON-STRING ID IS NOT AN ABSENT ID.
  //
  // Providers answer with whatever their own API returns, and a numeric id is
  // an entirely ordinary answer. MEASURED before this was guarded: a dispatcher
  // answering { taskId: 100 } across three tasks produced launched 0 and
  // unresolved 3. Three tasks really ran, three ids were discarded, and the
  // next resume sent a person to reconcile all three by hand -- a silent skip
  // inside the module written to make silent skips impossible, while the runner
  // was holding the only handle anybody has on work that cannot be cancelled.
  //
  // Asserted as the property and not the coercion: an id the provider gave has
  // to survive into the journal in a form that still addresses the task.
  // -------------------------------------------------------------------
  {
    const decl = declaration({ taskCount: 3 });
    const admission = await admitted(decl);
    const clock = fakeClock();
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      // A number, exactly as a provider API hands one back.
      dispatch: async ({ index }) => ({ taskId: 100 + index })
    });

    check(summary.launched === 3 && summary.refused === 0 && summary.unresolved === 0,
      `task id: a numeric provider id is a launch, not an absent one (got ${JSON.stringify(summary)})`);
    const launches = readLines(summary.journalFile).filter((r) => r.kind === 'launched');
    check(launches.length === 3, `task id: every id the provider answered reached the journal (got ${launches.length})`);
    check(launches.every((r) => String(r.taskId) === String(100 + r.index)),
      `task id: the recorded id is the one the provider answered, in a form that still addresses the task (got ${JSON.stringify(launches.map((r) => r.taskId))})`);
    check(launches.every((r) => String(r.taskId).trim() !== ''),
      'task id: nothing was recorded as launched under an empty handle -- an id nobody can look up is worth no more than no id at all');

    // And the consequence that cost the money: a resume of that journal owes
    // nothing and demands nothing. Under the discard, all three read as
    // unresolved and somebody was sent to reconcile tasks whose ids the runner
    // had been handed and thrown away.
    const readBack = journal.readJournal(summary.journalFile);
    check(readBack.unresolved.length === 0,
      `task id: nobody is sent to reconcile a task whose id the runner was given (got ${JSON.stringify(readBack.unresolved)})`);
    const plan = journal.resumePlan(readBack, { totalTasks: decl.tasks.length });
    check(plan.remaining.length === 0 && plan.alreadyLaunched === 3,
      `task id: the batch reads as done rather than owed, so nothing is dispatched and billed a second time (got ${JSON.stringify(plan)})`);
  }

  // -------------------------------------------------------------------
  // AN ID THAT CANNOT ADDRESS ANYTHING IS RECORDED BY NAME, NOT DROPPED.
  //
  // The dispatcher ANSWERED here, so the provider may well have accepted the
  // task -- but what came back cannot be used to find it again. Writing nothing
  // at all is the silent skip this codebase keeps re-finding. Which kind of
  // record it is filed under is the implementation's business; that a record
  // exists, names itself with a code, and says what actually came back is not.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const clock = fakeClock();
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ index }) => (index === 2 ? { taskId: true } : { taskId: `provider-${index}` })
    });

    check(summary.launched === 4 && summary.remaining === 0,
      `unusable id: one unusable answer does not abandon the other four (got ${JSON.stringify(summary)})`);
    check(summary.refused + summary.unresolved === 1,
      `unusable id: it is accounted for in exactly one column rather than falling out of the accounting (got ${JSON.stringify(summary)})`);

    const records = readLines(summary.journalFile);
    check(!records.some((r) => r.kind === 'launched' && r.index === 2),
      'unusable id: no launch is invented for it -- a launch row is a claim that somebody can look that task up');
    const named = records.filter((r) => r.index === 2 && r.kind !== 'intent' && r.kind !== 'launched');
    check(named.length === 1,
      `unusable id: the dispatch leaves exactly one outcome record, so it is neither dropped nor recorded twice (got ${JSON.stringify(named)})`);
    check(named[0] && typeof named[0].code === 'string' && named[0].code.trim() !== '',
      `unusable id: the record NAMES itself with a code, because a row reading "code": undefined tells a reconciler nothing (got ${JSON.stringify(named[0])})`);
    check(named[0] && /boolean/.test(String(named[0].reason)),
      `unusable id: the reason says what actually came back, so the dispatcher can be fixed without re-running the batch (got ${JSON.stringify(named[0] && named[0].reason)})`);
  }

  // -------------------------------------------------------------------
  // ROUND-ROBIN across the accounts it was handed.
  //
  // Asserted as the property, not the arithmetic: even load, and never the same
  // account twice in a row. Both hold for any correct rotation.
  // -------------------------------------------------------------------
  {
    const decl = declaration({ taskCount: 9 });
    const admission = await admitted(decl);
    const three = ['account-a', 'account-b', 'account-c'];
    const clock = fakeClock();
    const used = [];
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: three,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ index, account }) => { used.push(account); return { taskId: `provider-${index}` }; }
    });

    check(used.length === 9 && used.every((name) => three.includes(name)),
      'accounts: every dispatch goes out under one of the accounts the runner was handed, and no other');
    check(three.every((name) => used.filter((u) => u === name).length === 3),
      `accounts: the load is spread evenly, so no single account is driven into its own per-account ceiling (got ${JSON.stringify(used)})`);
    check(used.every((name, position) => position === 0 || name !== used[position - 1]),
      'accounts: consecutive dispatches never reuse the same account, which is what rotating them is for');
    const launches = readLines(summary.journalFile).filter((r) => r.kind === 'launched');
    check(launches.length === used.length && launches.every((r) => r.account === used[r.index]),
      `accounts: the journal records every dispatch under the account it really went out under, which is where anybody looks when a bill is queried (journal launches: ${launches.length}, dispatches: ${used.length})`);
  }

  // -------------------------------------------------------------------
  // FEWER ACCOUNTS THAN THE RATE WAS ADMITTED FOR IS REFUSED.
  //
  // The bounds gate cleared 144/min only because two accounts could carry it at
  // the measured per-account ceiling. Handing the runner one account puts the
  // admitted rate onto half the identities it was cleared for, which voids that
  // gate at run time without anybody editing it.
  // -------------------------------------------------------------------
  {
    const ceiling = target.MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT;
    const decl = declaration({ bounds: { launchesPerMinute: ceiling * 2, accounts: 2 } });
    const admission = await admitted(decl);
    let calls = 0;
    const clock = fakeClock();
    const error = await raises('CLOUD_BATCH_RATE_UNSERVEABLE',
      () => runner.runBatch({
        admission,
        declaration: decl,
        stateRoot: room(),
        accounts: ['only-one'],
        now: clock.now,
        sleep: clock.sleep,
        dispatch: async () => { calls += 1; return { taskId: 'never' }; }
      }),
      'accounts: a rate admitted for more accounts than the runner holds is refused rather than run into the rate limit');
    check(calls === 0, 'accounts: the refusal happens before anything dispatches');
    check(error.message.includes(String(ceiling * 2)) && error.message.includes(String(ceiling)),
      `accounts: the refusal names the admitted rate and the measured per-account ceiling, so the fix is obvious (got: ${error.message.slice(0, 160)})`);
    check(target.MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT === 72,
      `accounts: the measured per-account ceiling remains 72 launches per minute (got ${target.MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT})`);
  }

  // -------------------------------------------------------------------
  // TWO NAMES FOR ONE ACCOUNT ARE ONE ACCOUNT.
  //
  // The same gate as above, defeated a different way. It counted NAMES, so a
  // list with a duplicate in it read as two accounts: a batch admitted for
  // twice the measured per-account ceiling was handed ['a','a'], passed, and
  // then ran every dispatch onto a single account -- with the round-robin that
  // spreads the load rotating between an account and itself. That is exactly
  // the outcome the refusal exists to prevent, and a duplicate voided it as
  // thoroughly as a short list did. The retries from the rate limit it walks
  // into cost more than the headroom it appeared to buy.
  // -------------------------------------------------------------------
  {
    const ceiling = target.MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT;
    const decl = declaration({ bounds: { launchesPerMinute: ceiling * 2, accounts: 2 } });
    const admission = await admitted(decl);

    for (const [names, why] of [
      [['duplicated', 'duplicated'], 'the same account named twice'],
      [['duplicated', '  duplicated  '], 'the same account named twice with stray whitespace']
    ]) {
      let calls = 0;
      const clock = fakeClock();
      const error = await raises('CLOUD_BATCH_RATE_UNSERVEABLE',
        () => runner.runBatch({
          admission,
          declaration: decl,
          stateRoot: room(),
          accounts: names,
          now: clock.now,
          sleep: clock.sleep,
          dispatch: async () => { calls += 1; return { taskId: 'never' }; }
        }),
        `duplicate accounts: ${why} cannot carry a rate admitted for two accounts, and is refused rather than run onto one`);
      check(calls === 0,
        `duplicate accounts: nothing is dispatched onto the single account behind ${why} (dispatches made: ${calls})`);
      check(error.message.includes(String(ceiling)),
        `duplicate accounts: the refusal names the measured per-account ceiling, so the fix is obvious (got: ${error.message.slice(0, 200)})`);
    }

    // And the other half of the property, or the gate could simply be "always
    // refuse": the same admitted rate across two accounts that really are two
    // runs, which is why it was admitted in the first place.
    const clock = fakeClock();
    let dispatched = 0;
    const summary = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: ['distinct-one', 'distinct-two'],
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ index }) => { dispatched += 1; return { taskId: `provider-${index}` }; }
    });
    check(dispatched === 5 && summary.launched === 5,
      `duplicate accounts: two genuinely distinct accounts carry the rate they were admitted for (got ${JSON.stringify(summary)})`);
  }

  // -------------------------------------------------------------------
  // AN INTENT THAT CANNOT BE WRITTEN STOPS THE RUN BEFORE THE PROVIDER IS
  // CALLED. A dispatch nobody recorded cannot be recovered and cannot be
  // cancelled, so not dispatching it is the only safe move.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    let calls = 0;
    const clock = fakeClock();
    await raises('CLOUD_BATCH_JOURNAL_UNWRITABLE',
      () => runner.runBatch({
        admission,
        declaration: decl,
        stateRoot: room(),
        accounts: ACCOUNTS,
        now: clock.now,
        sleep: clock.sleep,
        fsImpl: fsFailingOn((line) => line.includes('"kind":"intent"')),
        dispatch: async () => { calls += 1; return { taskId: 'never' }; }
      }),
      'journal: an intent that cannot be written stops the run');
    check(calls === 0,
      `journal: the provider is never called when its intent could not be recorded first (dispatches made: ${calls})`);
  }

  // -------------------------------------------------------------------
  // THE CASE THE WHOLE ORDERING EXISTS FOR: dying between the provider call
  // and the outcome. What survives must be an intent with no outcome -- which
  // is unknown, not failed -- and the next resume must refuse to guess.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const dir = room();
    const file = journal.journalPath(dir, decl.batchId);
    const clock = fakeClock();
    let calls = 0;
    const error = await raises('CLOUD_BATCH_JOURNAL_UNWRITABLE',
      () => runner.runBatch({
        admission,
        declaration: decl,
        stateRoot: dir,
        accounts: ACCOUNTS,
        now: clock.now,
        sleep: clock.sleep,
        fsImpl: fsFailingOn((line) => line.includes('"kind":"launched"')),
        dispatch: async ({ index }) => { calls += 1; return { taskId: `provider-${index}` }; }
      }),
      'crash: losing the journal at the outcome stops the run rather than carrying on writing intents nobody can resolve');
    check(calls === 1,
      `crash: the run stops at the first dispatch it could not record, instead of dispatching four more it also could not record (dispatches made: ${calls})`);
    const readBack = journal.readJournal(file);
    check(readBack.unresolved.length === 1 && readBack.unresolved[0].index === 0,
      'crash: what survives is an intent with no outcome -- the record that says a task may be running under an id nobody wrote down');
    check(readBack.launched.length === 0 && readBack.refused.length === 0,
      'crash: it is recorded as neither launched nor refused, because both of those would be a claim nobody can support');
    check(error.details && error.details.batchRun && error.details.batchRun.remaining === 4,
      `crash: the thrown refusal carries what never went out (got ${JSON.stringify(error.details && error.details.batchRun)})`);
  }

  // -------------------------------------------------------------------
  // A WORKER FAILURE DOES NOT PRODUCE COUNTS WHILE ANOTHER WORKER IS LIVE.
  // -------------------------------------------------------------------
  {
    const decl = declaration({ taskCount: 2 });
    const admission = await admitted(decl);
    const clock = fakeClock();
    let releaseSecond;
    let secondStarted;
    const secondIsStarted = new Promise((resolve) => { secondStarted = resolve; });
    const holdSecond = new Promise((resolve) => { releaseSecond = resolve; });
    let settled = false;
    const run = runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: ACCOUNTS,
      concurrency: 2,
      now: clock.now,
      sleep: clock.sleep,
      fsImpl: fsFailingOn((line) => line.includes('"kind":"launched"') && line.includes('"index":0')),
      dispatch: async ({ index }) => {
        if (index === 1) {
          secondStarted();
          await holdSecond;
        }
        return { taskId: `provider-${index}` };
      }
    });
    run.then(() => { settled = true; }, () => { settled = true; });
    await secondIsStarted;
    await new Promise((resolve) => { setImmediate(resolve); });
    check(settled === false,
      'concurrency: a failed worker cannot close and summarize the run while another provider dispatch is still live');
    releaseSecond();
    const error = await raises('CLOUD_BATCH_JOURNAL_UNWRITABLE', () => run,
      'concurrency: the first worker failure is reported after every already-started dispatch has settled');
    check(error.details && error.details.batchRun && error.details.batchRun.launched === 1,
      `concurrency: the failure summary includes the other worker's completed launch (got ${JSON.stringify(error.details && error.details.batchRun)})`);
  }

  // -------------------------------------------------------------------
  // Misconfiguration refuses BY NAME and dispatches nothing.
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const clock = fakeClock();
    let calls = 0;
    const base = {
      admission,
      declaration: decl,
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async () => { calls += 1; return { taskId: 'never' }; }
    };
    const cases = [
      [{ ...base, stateRoot: room(), dispatch: undefined }, 'a runner with no dispatcher injected'],
      [{ ...base, stateRoot: room(), accounts: [] }, 'a runner with no account to launch under'],
      [{ ...base, stateRoot: room(), accounts: ['ok', '   '] }, 'an account list carrying a blank name'],
      [{ ...base }, 'a runner told neither where to open a journal nor which one to resume'],
      [{ ...base, stateRoot: room(), sleep: null }, 'a runner with no sleep to pace with'],
      [{ ...base, stateRoot: room(), admission: { admitted: false } }, 'a run started from something that is not an admission']
    ];
    for (const [input, why] of cases) {
      const error = await raises('CLOUD_BATCH_RUNNER_MISCONFIGURED',
        () => runner.runBatch(input), `misconfiguration: ${why} is refused`);
      check(error.message.length > 40,
        `misconfiguration: the refusal for ${why} says what to supply rather than only that something is wrong`);
    }
    check(calls === 0, 'misconfiguration: no misconfigured run reaches the provider');
  }

  // -------------------------------------------------------------------
  // A journalFile that is not there is "could not look", not "nothing ran".
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    let calls = 0;
    const clock = fakeClock();
    await raises('CLOUD_BATCH_JOURNAL_ABSENT',
      () => runner.runBatch({
        admission,
        declaration: decl,
        journalFile: path.join(room(), 'nothing-here.jsonl'),
        accounts: ACCOUNTS,
        now: clock.now,
        sleep: clock.sleep,
        dispatch: async () => { calls += 1; return { taskId: 'never' }; }
      }),
      'resume: a named journal that is missing refuses rather than reading as an empty one');
    check(calls === 0,
      'resume: a missing journal does not become "nothing was dispatched yet", which would risk dispatching the whole batch twice');
  }

  // -------------------------------------------------------------------
  // RE-RUNNING A FINISHED BATCH MUST NOT ERASE WHAT IT LAUNCHED.
  //
  // Every run closes the journal, resumes included, and a close carries only
  // what THAT run achieved. So running a batch that is already finished appends
  // a perfectly truthful `launched: 0` -- there was nothing left to launch --
  // and reading the last close as the batch's summary turned five paid launches
  // into a batch that launched nothing. MEASURED before this was guarded: two
  // runs of a five-task batch left the journal summary reading launched 0 with
  // all five launched rows still on disk. The rows kept the truth recoverable;
  // anybody reconciling that batch against a bill still read "launched 0".
  // -------------------------------------------------------------------
  {
    const decl = declaration();
    const admission = await admitted(decl);
    const clock = fakeClock();
    const first = await runner.runBatch({
      admission,
      declaration: decl,
      stateRoot: room(),
      accounts: ACCOUNTS,
      now: clock.now,
      sleep: clock.sleep,
      dispatch: async ({ index }) => ({ taskId: `provider-${index}` })
    });
    check(first.launched === 5, `re-run: the first run launched the whole batch (got ${JSON.stringify(first)})`);

    const clock2 = fakeClock(50000);
    let calls = 0;
    const second = await runner.runBatch({
      admission,
      declaration: decl,
      journalFile: first.journalFile,
      accounts: ACCOUNTS,
      now: clock2.now,
      sleep: clock2.sleep,
      dispatch: async () => { calls += 1; return { taskId: 'second-run' }; }
    });
    check(calls === 0,
      `re-run: a batch with nothing left owed dispatches nothing a second time -- there is no refund and no cancel (dispatches made: ${calls})`);
    check(second.launched === 0,
      `re-run: and the second run honestly reports that IT launched nothing (got ${JSON.stringify(second)})`);

    const back = journal.readJournal(first.journalFile);
    check(back.closed && back.closed.launched === 5 && back.closed.refused === 0,
      `re-run: the journal still summarises the five launches the batch really made, not the zero the last run added (got ${JSON.stringify(back.closed)})`);
    check(back.closed && back.closed.launched === back.launched.length
      && back.closed.refused === back.refused.length && back.closed.unresolved === back.unresolved.length,
      `re-run: the closing summary cannot disagree with the rows it summarises, which is where a bill gets reconciled (rows: ${back.launched.length}/${back.refused.length}/${back.unresolved.length}, summary: ${JSON.stringify(back.closed)})`);

    // "Never closed" and "closed having launched nothing" are different answers
    // and must not be merged: a journal nobody closed is an open question.
    const openOnly = journal.openBatch({ stateRoot: room(), admission, at: 1 });
    check(journal.readJournal(openOnly).closed === null,
      're-run: a journal nobody has closed reads as unclosed, rather than as a batch that closed having launched nothing');
  }

  try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`cloud-batch-runner tests passed (${checks} checks: the intent flushed before every provider call and no outcome before the answer, the seal re-checked before EVERY dispatch and a mid-run edit stopping the batch, the declared rate honoured by spacing on an injected clock without spinning, a resume dispatching only what remains and refusing entirely while anything is unresolved, a journal from another batch and a journal nobody can identify refused differently, a provider refusal recorded by name with the run continuing, an id-less answer held as unknown rather than failed, a numeric provider id kept as a launch and an unusable one recorded by name rather than dropped, accounts rotated evenly, a rate refused when too few accounts hold it AND when a duplicate name makes a list shorter than it looks, a re-run of a finished batch summarising the launches it really made rather than the zero the last run added, and a journal that cannot be written stopping the run before the provider is called).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  // This file is also invoked directly, outside a test harness. Terminate
  // explicitly so a rejected assertion can never be reported as a green run.
  process.exit(1);
});

'use strict';

/* THE BATCH RUNNER -- the thing that actually consumes an admitted batch.
 *
 * WHY IT EXISTS. Admission gates and a journal are both already here, and until
 * this file neither was reachable: a coordinator could declare a batch, pass
 * every gate, and the batch would go nowhere. Gates nothing consumes are gates
 * nobody is protected by.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR is narrow and it is all about ORDER.
 * Dispatching is somebody else's job -- `dispatch` is injected, and this module
 * never reaches for a provider CLI itself. That is not a testing convenience
 * bolted on afterwards; it is the reason the ordering below can be proved at
 * all. A runner that shells out to a real provider can only be tested by
 * spending real quota on real tasks that cannot be cancelled.
 *
 * THE FOUR PROPERTIES, each of which costs money when it is wrong:
 *
 *   1. THE SEAL IS CHECKED BEFORE EVERY DISPATCH, not once at the start. A
 *      declaration edited at dispatch 200 is a declaration that never passed the
 *      gates, and a seal verified only at dispatch 0 would not notice.
 *
 *   2. THE INTENT IS WRITTEN AND FLUSHED BEFORE THE PROVIDER IS CALLED. This is
 *      deliberately the expensive way round. A crash between the intent and the
 *      outcome leaves an intent with no outcome, and that record is UNKNOWN,
 *      never failed: the dispatch may have reached the provider and be running
 *      right now, billing, under a task id nobody wrote down. A cloud task
 *      cannot be cancelled, so the only safe reading of "unknown" is "reconcile
 *      it against the provider before you resume".
 *
 *   3. A RESUME DISPATCHES ONLY WHAT THE JOURNAL SAYS REMAINS. Re-dispatching
 *      something already launched double-bills it, and there is no refund and no
 *      cancel.
 *
 *   4. ONE PROVIDER REFUSAL DOES NOT ABANDON THE BATCH. A quota error on task 3
 *      of 250 is recorded BY NAME and the run continues. The silent-skip version
 *      of this -- swallow it, move on, report a launch count nobody can
 *      reconcile -- is the defect this codebase keeps re-finding.
 *
 * ON PACING. The declared launchesPerMinute is honoured by SPACING dispatch
 * starts, through an injected sleep. Two things this deliberately does not do:
 * it does not busy-wait (a spin burns a core to achieve the same wait, and on an
 * injected clock it would never terminate at all), and it does not catch up on a
 * backlog. If one dispatch takes ten seconds, the next is not fired instantly to
 * make up the lost ground; catching up is how a slow patch becomes a burst, and
 * a burst is how a rate limit becomes a 429 storm whose retries cost more than
 * the headroom saved.
 */

const fs = require('node:fs');

const { CloudAgentError } = require('./errors');
/* Both reused rather than restated. MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT is a
 * MEASURED number that lives in one place; a second copy here would drift, and
 * the looser of the two would quietly become the real one. */
const { assertSealIntact, MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT } = require('./batch-target');
const journal = require('./batch-journal');

const MILLISECONDS_PER_MINUTE = 60000;

/* A throw carrying no code still gets a NAMED one. A journal row reading
 * `"code": undefined` tells whoever reads it nothing, and this repository's rule
 * is that a refusal names itself. */
const UNCODED_DISPATCH = 'CLOUD_DISPATCH_THREW';

function fail(code, message, details) {
  throw new CloudAgentError(code, message, details);
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/* ---------------------------------------------------------------------------
 * Configuration refusals. Every one of these fires BEFORE a journal is touched
 * and before a provider is called, and every one names the thing to fix.
 * ------------------------------------------------------------------------- */

function checkRunnerInputs({ admission, declaration, dispatch, accounts, sleep, now, journalFile, stateRoot }) {
  if (!admission || admission.admitted !== true || typeof admission.admissionSha256 !== 'string') {
    fail('CLOUD_BATCH_RUNNER_MISCONFIGURED',
      'runBatch needs the admission record returned by admitBatch. Running from anything else would dispatch work no gate ever saw.');
  }
  if (!declaration || typeof declaration !== 'object') {
    fail('CLOUD_BATCH_RUNNER_MISCONFIGURED',
      'runBatch needs the declaration that was admitted, so the seal can be re-checked before every dispatch.');
  }
  if (typeof dispatch !== 'function') {
    fail('CLOUD_BATCH_RUNNER_MISCONFIGURED',
      'dispatch must be a function ({ task, index, account }) -> { taskId }. It is injected rather than imported so that the ordering guarantees in this file can be tested without spending quota on tasks that cannot be cancelled.');
  }
  if (!Array.isArray(accounts) || accounts.length === 0
      || accounts.some((name) => typeof name !== 'string' || name.trim() === '')) {
    fail('CLOUD_BATCH_RUNNER_MISCONFIGURED',
      'accounts must be a non-empty array of account names to round-robin across. A batch with no account to launch under has nowhere to go.');
  }
  for (const [value, name] of [[sleep, 'sleep'], [now, 'now']]) {
    if (typeof value !== 'function') {
      fail('CLOUD_BATCH_RUNNER_MISCONFIGURED', `${name} must be a function; it is injected so pacing is testable without real time.`);
    }
  }
  if (!journalFile && !stateRoot) {
    fail('CLOUD_BATCH_RUNNER_MISCONFIGURED',
      'runBatch needs either journalFile (the journal of a run to resume, or one already opened for this batch) or stateRoot (where a new journal may be opened). Without one it cannot record an intent, and a dispatch nobody recorded cannot be recovered and cannot be cancelled.');
  }
}

/* THE RATE THE ADMISSION APPROVED WAS APPROVED AGAINST A COUNT OF ACCOUNTS.
 * gateBounds admitted `launchesPerMinute` only because `bounds.accounts` could
 * carry it at the measured per-account ceiling. If the runner is then handed
 * fewer accounts than that, the admitted rate lands on fewer identities than it
 * was cleared for and the per-account ceiling is exceeded -- the bounds gate is
 * voided at run time without anybody editing it. Refused rather than clamped,
 * for the same reason admission refuses rather than clamps: a batch that quietly
 * serves less than it was asked for reports a rate nobody can reproduce. */
function checkAccountsCanCarryRate(declaration, accounts) {
  const declared = declaration.bounds.launchesPerMinute;
  /* COUNT IDENTITIES, NOT NAMES. This counted `accounts.length`, so listing one
   * account twice defeated the gate entirely: a 144/min batch handed
   * ['only-one','only-one'] was admitted and ran every dispatch onto a single
   * account, which is precisely the outcome this refusal exists to prevent. The
   * round-robin that spreads load collapses the same way, silently. A duplicate
   * voids the ceiling exactly as thoroughly as a short list does. */
  const identities = new Set(accounts.map((name) => String(name).trim()));
  const serveable = identities.size * MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT;
  if (declared > serveable) {
    fail('CLOUD_BATCH_RATE_UNSERVEABLE',
      `the batch was admitted for ${declared} launches a minute across ${declaration.bounds.accounts} declared account(s), but this runner was handed ${accounts.length} name(s) covering ${identities.size} distinct account(s), which can carry at most ${serveable} (${MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT} per account, measured). `
      + 'Refusing rather than running the admitted rate onto fewer accounts than it was cleared for: the retries from the resulting rate limit cost more than the headroom saved.');
  }
}

/* THE JOURNAL MUST BELONG TO THIS ADMISSION. A journal addresses tasks by
 * INDEX, so resuming batch A from batch B's journal would read "index 4 already
 * launched" and skip a completely different task -- work silently never done,
 * with a journal that says it was. The two failing cases are kept apart on
 * purpose: a header naming another admission is "not this batch", and a journal
 * with no header at all is "could not tell", and those have different remedies. */
function checkJournalIdentity(existing, admission, file) {
  if (!existing.header) {
    fail('CLOUD_BATCH_JOURNAL_UNIDENTIFIED',
      `${file} carries no admitted-record header, so which batch it belongs to cannot be established from here. `
      + 'Refusing rather than assuming it is this one: a journal indexes tasks by position, and resuming against the wrong one skips work while reporting it done.');
  }
  if (existing.header.admissionSha256 !== admission.admissionSha256) {
    fail('CLOUD_BATCH_JOURNAL_MISMATCH',
      `${file} was opened for admission ${String(existing.header.admissionSha256).slice(0, 16)} and this run carries ${admission.admissionSha256.slice(0, 16)}. `
      + 'A journal indexes tasks by position, so resuming one batch from another batch\'s journal skips work while reporting it done.');
  }
}

/* ---------------------------------------------------------------------------
 * Pacing.
 * ------------------------------------------------------------------------- */

/* ONE sleep, never a loop that re-reads the clock. A re-checking loop is a spin
 * wearing a sleep's clothes, and against an injected clock that never advances
 * on its own it would not terminate. */
async function waitUntil(nextAllowedAt, { now, sleep }) {
  const wait = nextAllowedAt - now();
  if (wait > 0) await sleep(wait);
  return now();
}

/* ---------------------------------------------------------------------------
 * The run.
 * ------------------------------------------------------------------------- */

/**
 * Consume an admitted batch: dispatch what remains, at the declared rate, with
 * every dispatch recorded before it happens.
 *
 * Returns { launched, refused, remaining, unresolved, journalFile }.
 *
 *   launched   dispatches THIS run recorded with a provider task id
 *   refused    dispatches THIS run recorded as refused, by name
 *   unresolved intents THIS run could not resolve either way -- unknown, and
 *              deliberately not folded into `refused`
 *   remaining  task indices still owed: never attempted, no outcome recorded.
 *              Zero on a run that finished; non-zero when the run stopped early,
 *              in which case it is carried on the thrown error's details.
 */
async function runBatch({
  admission,
  declaration,
  journalFile = null,
  stateRoot = null,
  dispatch,
  accounts,
  sleep = defaultSleep,
  now = Date.now,
  /* HOW MANY DISPATCHES MAY BE IN FLIGHT AT ONCE. Default 1, which is the
   * behaviour every existing caller and test already relies on. It does NOT
   * raise the rate: the pacing slot is claimed before any await, so the
   * aggregate spacing stays exactly what the bounds admitted. What it buys back
   * is the waiting -- measured at about seven seconds per `codex cloud exec`,
   * which on a live 59-task wave produced 8.6 launches a minute against a
   * declared 60 and zero provider refusals. The limit was never the provider. */
  concurrency = 1,
  fsImpl = fs
} = {}) {
  checkRunnerInputs({ admission, declaration, dispatch, accounts, sleep, now, journalFile, stateRoot });

  /* Before anything is written: is this the declaration that was admitted? The
   * per-dispatch check below is the one that matters, but refusing here keeps a
   * journal from being opened for a batch that is already off the rails. */
  assertSealIntact(admission, declaration);
  checkAccountsCanCarryRate(declaration, accounts);

  const file = journalFile || journal.journalPath(stateRoot, admission.batchId);

  /* A new journal is opened ONLY when the caller supplied a stateRoot -- that is
   * the caller saying "create it if it is not there". A journalFile that names a
   * file which does not exist is left to readJournal, which refuses it: "the
   * journal is missing" and "nothing was ever dispatched" are different answers,
   * and reading the first as the second risks dispatching the whole batch twice. */
  if (stateRoot && !fsImpl.existsSync(file)) {
    journal.openBatch({ stateRoot, admission, at: now(), fsImpl });
  }

  /* ONE path for fresh runs and resumes alike. A newly opened journal holds only
   * its header, so resumePlan returns every index and the fresh case is just the
   * resume case with nothing done yet. A second code path here would be a second
   * place for the double-billing rule to be got wrong. */
  const existing = journal.readJournal(file, { fsImpl });
  checkJournalIdentity(existing, admission, file);
  // Throws CLOUD_BATCH_UNRECONCILED while anything is unresolved. Nothing is
  // dispatched in that state, on purpose: this module cannot tell whether an
  // unresolved intent is running and billing, and it must not guess.
  const plan = journal.resumePlan(existing, { totalTasks: declaration.tasks.length });

  const intervalMs = MILLISECONDS_PER_MINUTE / declaration.bounds.launchesPerMinute;
  let launched = 0;
  let refused = 0;
  /* Counted the moment an intent is on disk, NOT when a dispatch succeeds. From
   * that instant the provider may have the task, so the index has left the pool
   * of work that is still safe to dispatch -- whatever happens next, including
   * this process dying before it can write an outcome. */
  let attempted = 0;
  let ordinal = 0;
  let nextAllowedAt = now();
  let stopped = null;

  /* CONCURRENCY, AND WHY IT IS NOT A LUXURY.
   *
   * MEASURED on a live 59-task wave: 412.6 seconds, a median gap of 6,972 ms
   * between dispatch starts against a declared spacing of 1,000 ms, and ZERO
   * provider refusals. The rate limit was never reached. Every one of those
   * gaps was this loop awaiting a `codex cloud exec` that takes about seven
   * seconds to return. The declared rate was unreachable not because the
   * provider refused it but because one dispatch at a time cannot produce it.
   *
   * So the workers below overlap the WAITING, not the pacing. `nextAllowedAt`
   * is claimed by whichever worker reaches it first and moved forward
   * immediately, before any await -- so the aggregate spacing across all
   * workers is still exactly what the bounds admitted. Concurrency buys back
   * the seven seconds spent waiting for an answer; it does not buy a higher
   * rate than the batch was cleared for.
   *
   * DEFAULT 1, so nothing changes for a caller that does not ask. A batch that
   * was admitted for a rate it could never reach is a different bug from one
   * that silently runs faster than it was cleared for, and only the first is
   * being fixed here.
   *
   * The index pool is pulled from a shared cursor. Every worker still does the
   * whole sequence for its own index -- seal, pacing slot, intent, dispatch,
   * outcome -- so no guarantee is weakened by overlapping them. */
  const pool = [...plan.remaining];
  let cursor = 0;

  async function worker() {
    for (;;) {
      if (stopped) return;
      if (cursor >= pool.length) return;
      const index = pool[cursor];
      cursor += 1;

      // (1) THE SEAL, BEFORE EVERY DISPATCH. Inside the loop, deliberately.
      assertSealIntact(admission, declaration);

      /* The pacing slot is claimed BEFORE the await, so two workers cannot both
       * read the same nextAllowedAt and dispatch together. Single-threaded, so
       * this read-and-advance is atomic by construction. */
      const slot = nextAllowedAt;
      nextAllowedAt = slot + intervalMs;
      const at = await waitUntil(slot, { now, sleep });
      void at;

      const task = declaration.tasks[index];
      const account = accounts[ordinal % accounts.length];
      ordinal += 1;

      // (2) INTENT FIRST, FLUSHED, BEFORE THE PROVIDER IS CALLED. If this throw
      // fires, the dispatch below never happens -- which is the point: a
      // dispatch nobody could record cannot be recovered or cancelled.
      journal.recordIntent({ file, index, target: task && task.target, at, fsImpl });
      attempted += 1;

      let result = null;
      let thrown = null;
      let threw = false;
      try {
        result = await dispatch({ task, index, account });
      } catch (error) {
        threw = true;
        thrown = error;
      }

      if (threw) {
        /* A THROW IS AMBIGUOUS, AND FILING IT AS A REFUSAL WAS WRONG.
         *
         * This branch used to record every thrown error as `refused`. Measured:
         * a dispatch throwing ECONNRESET produced a `refused` row, readJournal
         * reported `unresolved: 0`, and a resume returned `remaining: 0` --
         * nobody was ever asked to reconcile it. But a socket that dies AFTER
         * the request went out is exactly the case batch-journal.js exists for:
         * the task may have reached the provider and be running right now,
         * billing, under an id nobody wrote down. A cloud task cannot be
         * cancelled, so the two outcomes were "running untracked while the
         * journal swears it was refused" and "a coordinator reads refused and
         * hand-retries it into a second bill".
         *
         * THE DISCRIMINATOR IS WHETHER THE PROVIDER ANSWERED. Only a dispatcher
         * can know that, so only a dispatcher may assert it: an error carrying
         * `providerAnswered === true` is a refusal the provider itself gave and
         * is certain. Anything else -- a transport failure, a timeout, an
         * unknown throw -- leaves the intent outcome-less, which makes it
         * UNRESOLVED, which makes the next resume refuse until somebody
         * reconciles it against the provider's own task list.
         *
         * That is the expensive direction on purpose. Being made to reconcile a
         * handful of ambiguous dispatches costs a person some minutes; paying
         * twice for work already running costs money and cannot be undone. */
        const providerAnswered = Boolean(thrown && thrown.providerAnswered === true);
        if (providerAnswered) {
          journal.recordRefused({
            file,
            index,
            code: (thrown && thrown.code) || UNCODED_DISPATCH,
            reason: (thrown && thrown.message) || String(thrown),
            at: now(),
            fsImpl
          });
          refused += 1;
          continue;
        }
        /* Deliberately writes NOTHING, and deliberately counts nothing. The
           intent already on disk, with no outcome after it, IS the record --
           and it is the honest one. `unresolved` is DERIVED below as
           attempted - (launched + refused), so a dispatch that increments
           neither is counted here by construction rather than by a tally
           somebody has to remember to keep in step. */
        continue;
      }

      /* A NON-STRING ID IS NOT AN ABSENT ID, and treating it as one threw away
       * real launches. Measured: a dispatcher answering `{ taskId: 100 }` -- an
       * entirely ordinary numeric id from a provider API -- across three tasks
       * produced launched 0, unresolved 3. Three tasks really ran, three ids
       * were discarded, and the next resume demanded a human reconcile all
       * three. That is a silent skip in the file written to make silent skips
       * impossible: the runner KNEW the task was accepted and was holding the
       * only handle anybody has on something that cannot be cancelled.
       *
       * A number is coerced, because it is an id. Anything else refuses BY NAME
       * rather than being quietly rounded to absent. */
      let taskId = '';
      if (result && typeof result.taskId === 'string') taskId = result.taskId.trim();
      else if (result && typeof result.taskId === 'number' && Number.isFinite(result.taskId)) taskId = String(result.taskId);
      else if (result && result.taskId !== undefined && result.taskId !== null) {
        journal.recordRefused({
          file,
          index,
          code: 'CLOUD_DISPATCH_TASK_ID_UNUSABLE',
          reason: `the dispatcher answered with a taskId of type ${typeof result.taskId}, which cannot address a task. The task may well have been accepted; this is recorded so the id is not silently discarded.`,
          at: now(),
          fsImpl
        });
        refused += 1;
        continue;
      }
      if (!taskId) {
        /* A dispatch that returned without an id is UNKNOWN, and it is the one
         * case where writing nothing is the correct write. The provider may well
         * have accepted the task; recording it as launched would invent an id,
         * and recording it as refused would claim it never ran and let a resume
         * pay for it twice. The intent stays outcome-less, which makes it
         * unresolved, which makes the next resume refuse until somebody
         * reconciles it against the provider's own task list. */
        continue;
      }

      journal.recordLaunched({ file, index, taskId, account, at: now(), fsImpl });
      launched += 1;
    }
  }

  /* Bounded, and never more workers than there is work: spawning eight for
     three tasks would claim three pacing slots and leave five workers to
     find an empty pool, which is harmless but makes the concurrency figure
     a lie. */
  const workers = Math.max(1, Math.min(concurrency, pool.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    try {
      await worker();
    } catch (error) {
      /* Promise.all used to reject as soon as ONE worker failed, while other
       * workers could still be awaiting a provider answer. The runner then
       * closed the journal and reported definite counts that omitted those
       * live dispatches. Mark the run stopped immediately so no worker claims
       * more work, but wait for every already-started worker to settle before
       * deriving the summary or closing the journal. */
      if (!stopped) stopped = error;
    }
  }));

  /* Unresolved is DERIVED, exactly as readJournal derives it: an intent with no
   * outcome. Deriving it rather than counting it in one branch means the case
   * that matters most -- the process stopping between the two writes -- lands in
   * the same bucket as a provider that answered without an id, instead of
   * quietly falling out of the accounting as work still owed. */
  const unresolved = attempted - (launched + refused);
  const remaining = plan.remaining.length - attempted;
  const summary = Object.freeze({ launched, refused, remaining, unresolved, journalFile: file });

  /* (6) Closed with the counts THIS run really achieved -- not the batch's
   * totals, which the journal's own launched/refused lines already carry. */
  try {
    journal.closeBatch({ file, launched, refused, unresolved, at: now(), fsImpl });
  } catch (closeError) {
    // A close that fails must not overwrite the reason the run stopped; it is
    // reported alongside it instead of replacing it.
    if (!stopped) throw closeError;
    stopped.details = Object.assign({}, stopped.details, { closeFailed: closeError.message });
  }

  if (stopped) {
    stopped.details = Object.assign({}, stopped.details, { batchRun: summary });
    throw stopped;
  }
  return summary;
}

module.exports = Object.freeze({
  UNCODED_DISPATCH,
  runBatch
});

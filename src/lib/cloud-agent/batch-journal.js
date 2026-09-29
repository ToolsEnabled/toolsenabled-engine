'use strict';

/* THE BATCH JOURNAL -- so a partial run is never a lost run.
 *
 * WHY. A batch is admitted once and then runs unattended, at up to seventy-odd
 * launches a minute. If the runner dies at dispatch 180 of 257, three things
 * must survive: which tasks launched, what the provider called them, and which
 * never went out. Without that the only honest recovery is to re-dispatch
 * everything -- which double-bills every task that already succeeded, and a
 * Codex Cloud task cannot be cancelled once the provider accepts it.
 *
 * THE ORDERING IS THE WHOLE MECHANISM, and it is deliberately the expensive way
 * round. INTENT is written and flushed BEFORE the provider is called. Outcome
 * is written after. So a crash between them leaves an intent with no outcome --
 * and that record is the point of the file.
 *
 * AN INTENT WITH NO OUTCOME IS `unknown`, NEVER `failed`. This is the
 * unknown-versus-absent rule applied where it costs real money. The dispatch
 * may have reached the provider and be running right now, billing, with a task
 * id nobody wrote down. Reading that as "failed" and re-dispatching is how one
 * crash becomes two paid runs of the same work. Recovery must RECONCILE those
 * against the provider's own task list, and this file refuses to guess for it.
 *
 * WHY JSONL AND NOT A DATABASE. Appending one line per event, flushed, is the
 * only shape where a process killed mid-write loses at most the line it was
 * writing. A rewritten JSON document can lose the whole file to a partial write
 * -- which is exactly the failure this exists to prevent.
 */

const fs = require('node:fs');
const path = require('node:path');

const { CloudAgentError } = require('./errors');

const JOURNAL_SCHEMA = 'toolsenabled.cloud-batch.journal/v1';

const KINDS = Object.freeze({
  ADMITTED: 'admitted',
  INTENT: 'intent',
  LAUNCHED: 'launched',
  REFUSED: 'refused',
  CLOSED: 'closed'
});

function fail(code, message, details) {
  throw new CloudAgentError(code, message, details);
}

function journalPath(stateRoot, batchId) {
  return path.join(stateRoot, `${batchId}.jsonl`);
}

/* Appended and FLUSHED individually. The open/write/fsync/close per line is
 * slower than holding a handle, and that cost is the feature: a batch that
 * loses its last twenty lines to an OS buffer on a hard kill has lost exactly
 * the records that matter most -- the ones nearest the crash. */
function append(file, record, { fsImpl = fs } = {}) {
  const line = `${JSON.stringify(record)}\n`;
  let handle = null;
  let writeFailure = null;
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    handle = fsImpl.openSync(file, 'a');
    fsImpl.writeSync(handle, line);
    fsImpl.fsyncSync(handle);
  } catch (error) {
    writeFailure = error;
  }
  if (handle !== null) {
    try { fsImpl.closeSync(handle); }
    catch (error) { if (writeFailure === null) writeFailure = error; }
  }
  if (writeFailure !== null) {
    fail('CLOUD_BATCH_JOURNAL_UNWRITABLE',
      `the batch journal at ${file} could not be written and flushed: ${writeFailure && writeFailure.message}. Refusing to dispatch, because a dispatch nobody recorded cannot be recovered and cannot be cancelled.`);
  }
}

function openBatch({ stateRoot, admission, at = null, fsImpl = fs }) {
  const file = journalPath(stateRoot, admission.batchId);
  append(file, {
    schemaVersion: JOURNAL_SCHEMA,
    kind: KINDS.ADMITTED,
    batchId: admission.batchId,
    project: admission.project,
    taskCount: admission.taskCount,
    bounds: admission.bounds,
    admissionSha256: admission.admissionSha256,
    /* The harvester enumerates a wave from THIS journal (the provider list
     * caps at 20 rows), so the landing branch and verification bar travel in
     * the same file that names the tasks. Declared once, sealed with the rest. */
    harvest: admission.declaration && admission.declaration.harvest ? admission.declaration.harvest : null,
    at
  }, { fsImpl });
  return file;
}

/** Written and flushed BEFORE the provider is called. Never after. */
function recordIntent({ file, index, target, at = null, fsImpl = fs }) {
  append(file, { kind: KINDS.INTENT, index, target, at }, { fsImpl });
}

/** Written after the provider answers, carrying the id that makes it findable. */
function recordLaunched({ file, index, taskId, account, at = null, fsImpl = fs }) {
  append(file, { kind: KINDS.LAUNCHED, index, taskId, account, at }, { fsImpl });
}

/** A dispatch the provider refused. Distinct from an intent with no outcome. */
function recordRefused({ file, index, code, reason, at = null, fsImpl = fs }) {
  append(file, { kind: KINDS.REFUSED, index, code, reason: String(reason || '').slice(0, 400), at }, { fsImpl });
}

function closeBatch({ file, launched, refused, unresolved, at = null, fsImpl = fs }) {
  append(file, { kind: KINDS.CLOSED, launched, refused, unresolved, at }, { fsImpl });
}

/**
 * Read a journal back into the three states recovery actually needs.
 *
 * A TRUNCATED LAST LINE IS EXPECTED, NOT AN ERROR. It is what a kill mid-write
 * looks like, and it is precisely the case this file was shaped around. It is
 * dropped and COUNTED, so "the journal was cut short" is visible rather than
 * silently rounded away.
 */
function readJournal(file, { fsImpl = fs } = {}) {
  let contents;
  try {
    contents = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fail('CLOUD_BATCH_JOURNAL_ABSENT',
        `no batch journal at ${file}. Whether that batch ever dispatched cannot be established from here, and assuming it did not would risk dispatching it twice.`);
    }
    const reason = error && error.message ? error.message : String(error);
    fail('CLOUD_BATCH_JOURNAL_UNREADABLE',
      `the batch journal at ${file} could not be read: ${reason}. This is NOT claiming the journal is absent; the machine could not determine its contents.`);
  }
  const lines = String(contents).split(/\r?\n/).filter(Boolean);
  const intents = new Map();
  const launched = new Map();
  const refused = new Map();
  let header = null;
  let lastClose = null;
  let closeCount = 0;
  let truncated = 0;

  lines.forEach((line, position) => {
    let record;
    try { record = JSON.parse(line); }
    catch {
      // Only the FINAL line may legitimately be half-written. A broken line
      // anywhere else means something other than a kill damaged this file, and
      // that is a different problem which must not be filed under "expected".
      if (position === lines.length - 1) { truncated += 1; return; }
      fail('CLOUD_BATCH_JOURNAL_CORRUPT',
        `${file} line ${position + 1} is not valid JSON, and it is not the last line. A kill mid-write damages only the final record, so this file was damaged some other way.`);
    }
    if (record.kind === KINDS.ADMITTED) header = record;
    else if (record.kind === KINDS.INTENT) intents.set(record.index, record);
    else if (record.kind === KINDS.LAUNCHED) launched.set(record.index, record);
    else if (record.kind === KINDS.REFUSED) refused.set(record.index, record);
    else if (record.kind === KINDS.CLOSED) { lastClose = record; closeCount += 1; }
  });

  /* THE RECORD THIS FILE EXISTS FOR. An intent with neither a launch nor a
   * refusal is UNRESOLVED -- it may be running and billing under a task id
   * nobody wrote down. It is returned as its own category so no caller can
   * accidentally sum it into "failed". */
  const unresolved = [...intents.keys()]
    .filter((index) => !launched.has(index) && !refused.has(index))
    .map((index) => intents.get(index));

  /* A CLOSE RECORD IS PER-RUN, SO THE LAST ONE IS NOT THE BATCH'S TOTAL.
   *
   * Every run closes the journal, resumes included, and each close carries only
   * what THAT run achieved. So re-running a batch with nothing left to do
   * appends an entirely truthful `launched: 0` -- there was nothing left to
   * launch -- and reading the last close as the batch's summary turns paid
   * launches into a batch that launched nothing. MEASURED: two runs of a
   * five-task batch left this function returning `closed.launched === 0` with
   * all five launched rows still on disk. The rows kept it recoverable; anybody
   * reconciling that batch against a bill still read "launched 0".
   *
   * THE ROWS ARE THE FACT, so the counts are DERIVED FROM THEM and the summary
   * cannot disagree with the records it summarises. Refusing a second close was
   * the other way to fix this and it is the wrong one here: a resume
   * legitimately closes a journal that was already closed, so refusing would
   * break recovery -- the one path this whole file exists to keep open -- to
   * protect a number that can simply be computed correctly instead.
   *
   * WHETHER A BATCH WAS EVER CLOSED IS STILL A SEPARATE ANSWER. No close record
   * leaves this null, because "never closed" and "closed having launched
   * nothing" are different states with different remedies, and merging them is
   * the mistake this codebase keeps paying for. */
  const closed = lastClose === null ? null : Object.freeze({
    kind: KINDS.CLOSED,
    launched: launched.size,
    refused: refused.size,
    unresolved: unresolved.length,
    at: lastClose.at === undefined ? null : lastClose.at,
    /* Stated in the data rather than left for a reader to assume: these counts
     * came from the rows, not from the record on the last line. */
    derivedFromRows: true,
    closes: closeCount,
    /* What the final run itself reported, kept rather than discarded -- it is
     * how a reader sees that the last run added nothing to the batch. */
    lastRun: Object.freeze({
      launched: lastClose.launched,
      refused: lastClose.refused,
      unresolved: lastClose.unresolved
    })
  });

  return Object.freeze({
    file,
    header,
    closed,
    truncatedLines: truncated,
    launched: [...launched.values()],
    refused: [...refused.values()],
    unresolved,
    /* Indices never even attempted. Safe to dispatch: no intent was written, so
     * the provider was never called for them. */
    notAttempted: (indexCount) => {
      const attempted = new Set([...intents.keys()]);
      const out = [];
      for (let index = 0; index < indexCount; index += 1) if (!attempted.has(index)) out.push(index);
      return out;
    }
  });
}

/**
 * What a resume may safely do, stated rather than inferred by the caller.
 *
 * It REFUSES to produce a resume plan while anything is unresolved. Those have
 * to be reconciled against the provider's own task list first, because the only
 * two options otherwise are to skip work that never ran or to pay twice for
 * work that did -- and nothing in this file can tell which.
 */
function resumePlan(journal, { totalTasks }) {
  if (journal.unresolved.length > 0) {
    fail('CLOUD_BATCH_UNRECONCILED',
      `${journal.unresolved.length} dispatch(es) in ${journal.file} recorded an intent and no outcome, so whether they reached the provider is unknown. `
      + 'Reconcile them against the provider task list before resuming: treating them as failed may pay twice for work already running, and a cloud task cannot be cancelled. '
      + `Indices: ${journal.unresolved.map((r) => r.index).join(', ')}.`);
  }
  const done = new Set([...journal.launched.map((r) => r.index), ...journal.refused.map((r) => r.index)]);
  const remaining = [];
  for (let index = 0; index < totalTasks; index += 1) if (!done.has(index)) remaining.push(index);
  return Object.freeze({
    alreadyLaunched: journal.launched.length,
    alreadyRefused: journal.refused.length,
    remaining
  });
}

module.exports = Object.freeze({
  JOURNAL_SCHEMA,
  KINDS,
  closeBatch,
  journalPath,
  openBatch,
  readJournal,
  recordIntent,
  recordLaunched,
  recordRefused,
  resumePlan
});

/* MUTATION RECORD
 * Module mutation: restored the existsSync-then-read implementation that folds
 * an existsSync I/O failure into journal absence.
 * The edit landed: yes (the old existsSync guard was found at line 126).
 * This isolated test went red: yes (exit 1; EMFILE became JOURNAL_ABSENT).
 * Restored SHA-256: 57f32a1a3672c1e92642d93ebffba910f61ea6b4cbc5517a7ef0c860e43bd425.
 */
// EXECUTABLE CHANGE
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const journal = require('../src/lib/cloud-agent/batch-journal');

let checks = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

function raises(code, action, message) {
  assert.throws(action, (error) => error && error.code === code, message);
  checks += 1;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-journal-test-'));

try {
  check(journal.JOURNAL_SCHEMA, 'toolsenabled.cloud-batch.journal/v1',
    'the exported journal schema remains the public v1 identifier');
  check(journal.KINDS,
    { ADMITTED: 'admitted', INTENT: 'intent', LAUNCHED: 'launched', REFUSED: 'refused', CLOSED: 'closed' },
    'the exported event kinds name every persisted lifecycle event');
  check(journal.journalPath('/state', 'batch-17'), path.join('/state', 'batch-17.jsonl'),
    'journalPath gives each batch its own JSONL file');

  const file = journal.openBatch({
    stateRoot: temp,
    admission: {
      batchId: 'wave-7',
      project: 'engine',
      taskCount: 5,
      bounds: { launchesPerMinute: 60, accounts: 2 },
      admissionSha256: 'sealed',
      declaration: { harvest: { branch: 'landing', verification: 'node test.js' } }
    },
    at: '2026-08-27T00:00:00Z'
  });
  journal.recordIntent({ file, index: 0, target: 'src/paid.js', at: 'intent-0' });
  journal.recordLaunched({ file, index: 0, taskId: 'task-99', account: 'first@example.test', at: 'launch-0' });
  journal.recordIntent({ file, index: 1, target: 'src/refused.js', at: 'intent-1' });
  journal.recordRefused({ file, index: 1, code: 'QUOTA', reason: 'x'.repeat(450), at: 'refusal-1' });
  journal.recordIntent({ file, index: 2, target: 'src/unknown.js', at: 'intent-2' });
  journal.closeBatch({ file, launched: 1, refused: 1, unresolved: 1, at: 'close-1' });
  // A resumed no-op run must not erase the totals established by event rows.
  journal.closeBatch({ file, launched: 0, refused: 0, unresolved: 0, at: 'close-2' });

  const read = journal.readJournal(file);
  check(read.header,
    {
      schemaVersion: 'toolsenabled.cloud-batch.journal/v1', kind: 'admitted', batchId: 'wave-7',
      project: 'engine', taskCount: 5, bounds: { launchesPerMinute: 60, accounts: 2 },
      admissionSha256: 'sealed', harvest: { branch: 'landing', verification: 'node test.js' },
      at: '2026-08-27T00:00:00Z'
    }, 'openBatch persists the admitted batch and its harvesting contract');
  check(read.launched.map(({ index, taskId, account }) => ({ index, taskId, account })),
    [{ index: 0, taskId: 'task-99', account: 'first@example.test' }],
    'a successful provider outcome remains attributable to its index and account');
  check(read.refused.map(({ index, code, reason }) => ({ index, code, reasonLength: reason.length })),
    [{ index: 1, code: 'QUOTA', reasonLength: 400 }],
    'a refusal is distinct from an unknown outcome and bounds persisted provider text');
  check(read.unresolved.map(({ index, target }) => ({ index, target })),
    [{ index: 2, target: 'src/unknown.js' }],
    'an intent without a provider outcome is unresolved, never failed or safe to retry');
  check(read.notAttempted(5), [3, 4],
    'notAttempted returns only indices for which no intent was persisted');
  check(read.closed,
    {
      kind: 'closed', launched: 1, refused: 1, unresolved: 1, at: 'close-2',
      derivedFromRows: true, closes: 2,
      lastRun: { launched: 0, refused: 0, unresolved: 0 }
    }, 'multiple closes preserve batch totals derived from rows and expose the last run separately');
  raises('CLOUD_BATCH_UNRECONCILED', () => journal.resumePlan(read, { totalTasks: 5 }),
    'resume refuses to risk paying twice while an intent has no recorded outcome');

  journal.recordRefused({ file, index: 2, code: 'RECONCILED', reason: 'provider confirms no launch' });
  const reconciled = journal.readJournal(file);
  check(journal.resumePlan(reconciled, { totalTasks: 5 }),
    { alreadyLaunched: 1, alreadyRefused: 2, remaining: [3, 4] },
    'after reconciliation, resume skips every terminal outcome and returns untouched work');

  fs.appendFileSync(file, '{"kind":"intent"');
  check(journal.readJournal(file).truncatedLines, 1,
    'a torn final JSONL record is counted and ignored');
  raises('CLOUD_BATCH_JOURNAL_ABSENT',
    () => journal.readJournal(path.join(temp, 'missing.jsonl')),
    'an absent journal is unknown history, not permission to redispatch');

  let busyReads = 0;
  const busyFs = {
    // existsSync historically folds I/O failures into false. The journal must
    // use the read result itself to distinguish absence from could-not-read.
    existsSync: () => false,
    readFileSync: () => {
      busyReads += 1;
      const error = new Error('file table is busy');
      error.code = 'EMFILE';
      throw error;
    }
  };
  raises('CLOUD_BATCH_JOURNAL_UNREADABLE',
    () => journal.readJournal(file, { fsImpl: busyFs }),
    'EMFILE means the journal could not be inspected, not that it is absent');
  raises('CLOUD_BATCH_JOURNAL_UNREADABLE',
    () => journal.readJournal(file, { fsImpl: busyFs }),
    'a could-not-read result is not cached or latched for the process lifetime');
  check(busyReads, 2, 'each retry performs a fresh read after a transient failure');

  let absentReads = 0;
  const absentFs = {
    readFileSync: () => {
      absentReads += 1;
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
  };
  raises('CLOUD_BATCH_JOURNAL_ABSENT',
    () => journal.readJournal(file, { fsImpl: absentFs }),
    'CONTROL: the one genuine absence error retains its established answer');
  check(absentReads, 1, 'CONTROL: genuine absence is decided by one read attempt');

  const corrupt = path.join(temp, 'corrupt.jsonl');
  fs.writeFileSync(corrupt, '{broken\n{"kind":"closed"}\n');
  raises('CLOUD_BATCH_JOURNAL_CORRUPT', () => journal.readJournal(corrupt),
    'invalid JSON before the final record is corruption rather than an expected torn write');

  console.log(`cloud-agent batch-journal tests passed (${checks} checks)`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

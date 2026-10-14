'use strict';

require('./helpers/isolated-state-root'); // Keep TOOLSENABLED_STATE_ROOT off the live root before anything below resolves it.

// QUALITY SIGNAL ON A TASK: a review must be filed as a review.
//
// The decision kind on a T record is not read off the words -- it is whichever
// store function ran. progressTask hardcodes `decision: 'progress'` and never
// writes failedReviewCount; recordTaskReview hardcodes `decision: 'review'` and
// is the only writer of that counter. Measured on the live store (copy taken
// 2026-09-24 20:13 PDT): 8,947 progress rows, 126 review rows, 2 failures --
// so `failedReviewCount` is 0 on all but two of 1,994 tasks and no task can
// look troubled. 87 of those progress rows assert a pass/fail verdict in prose
// (L4's measure.cjs re-run on the revision 12997 copy for the T1997 packet;
// an earlier draft of this header said 88).
//
// What these tests hold:
//   1. a passing review is recorded, with its verdict and reason, count unchanged;
//   2. a failing review increments the cumulative failed-review count;
//   3. a review filed as free prose through t_ledger.progress is caught. Whether
//      it is REFUSED (L4's behaviour: typed code, the call to make instead,
//      nothing written) or WARNED (written exactly as before, the receipt says
//      what to send instead) is the open product question O11. Both are held
//      here; the default is warn, the base behaviour for every current caller,
//      and refuse is one explicit switch away;
//   4. a verdict with no reason is refused -- a count nobody can explain is not signal.
//
// The ledger under test is a copy of three real task records from the live
// store, kept beside this test at tests/fixtures/t-ledger-review-signal/.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { after } = require('node:test');

const gate = require('../src/lib/minor-ledger-agent-gate');
const store = require('../src/lib/owner-request-store');

const FIXTURE = path.join(__dirname, 'fixtures', 't-ledger-review-signal', 'reports', 'OWNER-REQUEST-LEDGER.json');
const auditEnabled = () => ({ values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } } });

// A fresh copy of the lane's ledger fixture per test. Nothing here reads or
// writes the live store.
const sandboxes = [];
after(() => { for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true }); });
function fixtureSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l4-review-signal-'));
  sandboxes.push(dir);
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(dir, 'reports', 'OWNER-REQUEST-LEDGER.json'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return { dir, opts: { rootPath } };
}

function control(opts, extra = {}) {
  const audits = [];
  const made = new gate.MinorLedgerAgentControl({
    loadSettings: auditEnabled,
    auditRequire: (action, target, details) => { audits.push({ action, target, details }); return { durable: true }; },
    store,
    ledgerOptions: opts,
    ...extra
  });
  return { control: made, audits };
}

function taskIds(opts) {
  const doc = JSON.parse(fs.readFileSync(opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8'));
  return doc.requests.filter(record => String(record.id).startsWith('T')).map(record => record.id);
}

function savedRecord(opts, id) {
  const doc = JSON.parse(fs.readFileSync(opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8'));
  return doc.requests.find(record => record.id === id);
}

test('the lane fixture is a real ledger with task records and no review signal yet', () => {
  const { opts } = fixtureSandbox();
  const ids = taskIds(opts);
  assert.ok(ids.length >= 3, 'the fixture carries at least three task records');
  for (const id of ids) {
    const record = savedRecord(opts, id);
    assert.deepEqual(record.decisions, [], `${id} starts with no decisions`);
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'failedReviewCount'), false,
      `${id} starts with no failed-review count, exactly like a live legacy task`);
  }
});

test('a passing review is recorded as a review, with its verdict and reason, and the count stays 0', async () => {
  const { opts } = fixtureSandbox();
  const { control: c, audits } = control(opts);
  const id = taskIds(opts)[0];

  const reviewed = c.review({
    actor: 'codex', id, reviewId: 'l4-pass-1', outcome: 'passed',
    reason: 'Read the diff and ran the one changed suite; 12 of 12 assertions hold.'
  });

  assert.equal(reviewed.reviewed, true);
  assert.equal(reviewed.changed, true);
  assert.equal(reviewed.outcome, 'passed');
  assert.equal(reviewed.failedReviewCount, 0, 'a passing review does not raise the failed count');
  assert.equal(audits[0].action, 't_ledger.review');

  const record = savedRecord(opts, id);
  assert.equal(record.decisions.length, 1);
  assert.equal(record.decisions[0].decision, 'review', 'it lands as a review, not as progress');
  assert.equal(record.decisions[0].outcome, 'passed');
  assert.match(record.decisions[0].reason, /12 of 12/);
  assert.equal(record.failedReviewCount, 0);
});

test('a failing review increments the cumulative failed-review count, so the task can look troubled', async () => {
  const { opts } = fixtureSandbox();
  const { control: c } = control(opts);
  const id = taskIds(opts)[0];

  const first = c.review({
    actor: 'codex', id, reviewId: 'l4-fail-1', outcome: 'failed',
    reason: 'The new door is never reached: progress writes before the check runs.'
  });
  assert.equal(first.outcome, 'failed');
  assert.equal(first.failedReviewCount, 1, 'one unique failed review, count 1');
  assert.equal(savedRecord(opts, id).failedReviewCount, 1, 'the count is durable on the record');

  // A second, distinct failure counts again; a replay of the first does not.
  const second = c.review({
    actor: 'codex', id, reviewId: 'l4-fail-2', outcome: 'failed',
    reason: 'Second pass: the refusal message does not name the reviewId field.'
  });
  assert.equal(second.failedReviewCount, 2);

  const replay = c.review({
    actor: 'codex', id, reviewId: 'l4-fail-1', outcome: 'failed',
    reason: 'The new door is never reached: progress writes before the check runs.'
  });
  assert.equal(replay.changed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.failedReviewCount, 2, 'a replay cannot inflate the count');

  const record = savedRecord(opts, id);
  assert.equal(record.failedReviewCount, 2);
  assert.equal(record.decisions.filter(row => row.decision === 'review').length, 2);
  assert.equal(record.decisions.filter(row => row.decision === 'progress').length, 0);
});

test('refuse-vs-warn is one explicit switch; it defaults to warn while O11 is open', () => {
  assert.deepEqual([...gate.REVIEW_AS_PROGRESS_MODES], ['warn', 'refuse']);
  assert.equal(gate.REVIEW_AS_PROGRESS_DEFAULT, 'warn', 'the default is the non-refusing behaviour the base already had');
  const { opts } = fixtureSandbox();
  assert.equal(control(opts).control.reviewAsProgress, 'warn');
  assert.equal(control(opts, { reviewAsProgress: 'refuse' }).control.reviewAsProgress, 'refuse');
  for (const wrong of ['Refuse', 'block', '', null, true]) {
    assert.throws(() => control(opts, { reviewAsProgress: wrong }), { code: 'T_LEDGER_REVIEW_AS_PROGRESS_MODE_INVALID' },
      `a misspelt switch (${JSON.stringify(wrong)}) is refused, not silently read as either behaviour`);
  }
});

test('by default (warn) a review filed as free prose through t_ledger.progress is recorded exactly as before, and the receipt says what to send instead', async () => {
  const { opts } = fixtureSandbox();
  const { control: c, audits } = control(opts);
  const id = taskIds(opts)[0];
  const reason = 'Reviewed the change end to end: review passed, suites green, no blockers.';

  const updated = await c.progress({ actor: 'codex', id, status: 'in-progress', reason });
  assert.equal(updated.updated, true);
  assert.equal(updated.status, 'in-progress');
  assert.equal(updated.warning.code, 'T_LEDGER_REVIEW_AS_PROGRESS');
  for (const needed of [/t_ledger\.review/, new RegExp(id), /"passed" or "failed"/, /reviewId/, /reason/, /failed-review count/, /was recorded/]) {
    assert.match(updated.warning.message, needed);
  }
  assert.equal(audits.at(-1).action, 't_ledger.progress');

  // The row is the row the base always wrote: a progress decision carrying
  // exactly the fields progressTask writes, nothing added for the warning.
  const record = savedRecord(opts, id);
  assert.equal(record.decisions.length, 1);
  const row = record.decisions[0];
  assert.deepEqual(Object.keys(row).sort(), ['actor', 'at', 'decision', 'reason', 'status']);
  assert.equal(row.decision, 'progress');
  assert.equal(row.reason, reason);
  assert.equal(record.status, 'in-progress');
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'failedReviewCount'), false,
    'warning does not invent a verdict: the count is untouched');
});

test('under the refuse switch (L4, available for O11) a review filed as free prose through t_ledger.progress is refused, and says what to send instead', async () => {
  const { opts } = fixtureSandbox();
  const { control: c } = control(opts, { reviewAsProgress: 'refuse' });
  const id = taskIds(opts)[0];

  await assert.rejects(
    () => c.progress({
      actor: 'codex', id, status: 'in-progress',
      reason: 'Reviewed the change end to end: review passed, suites green, no blockers.'
    }),
    error => {
      assert.equal(error.code, 'T_LEDGER_REVIEW_AS_PROGRESS');
      // The refusal has to be actionable: the tool, the task, the verdict
      // values, the reviewId and the reason all have to be nameable from it.
      assert.match(error.message, /t_ledger\.review/);
      assert.match(error.message, new RegExp(id));
      assert.match(error.message, /"passed" or "failed"/);
      assert.match(error.message, /reviewId/);
      assert.match(error.message, /reason/);
      assert.match(error.message, /failed-review count/);
      assert.match(error.message, /nothing was filed/);
      return true;
    }
  );

  const record = savedRecord(opts, id);
  assert.deepEqual(record.decisions, [], 'the refused prose was not filed as progress either');
  assert.equal(record.status, 'open', 'and the status did not move');
});

test('an ordinary checkpoint that merely mentions a review still files as progress', async () => {
  const { opts } = fixtureSandbox();
  const { control: c } = control(opts);
  const id = taskIds(opts)[0];

  // Measured against the live store, a co-occurrence rule refused 913 of 8,947
  // real checkpoints. The door must not tax honest work notes.
  const updated = await c.progress({
    actor: 'codex', id, status: 'in-progress',
    reason: 'Rebased onto the review head; 25 of 25 tests pass. Still writing the fixture.'
  });
  assert.equal(updated.updated, true);
  assert.equal(Object.prototype.hasOwnProperty.call(updated, 'warning'), false, 'no warning for an honest work note');
  const record = savedRecord(opts, id);
  assert.equal(record.decisions.length, 1);
  assert.equal(record.decisions[0].decision, 'progress');

  // Same note under the refuse switch: still files.
  const refusing = control(opts, { reviewAsProgress: 'refuse' }).control;
  const again = await refusing.progress({
    actor: 'codex', id, status: 'blocked-external',
    reason: 'Waiting on the review head to be rebased; 25 of 25 tests pass.'
  });
  assert.equal(again.updated, true);
  assert.equal(savedRecord(opts, id).decisions.length, 2);
});

test('a checkpoint that talks ABOUT the failed-review count is not a verdict', async () => {
  const { opts } = fixtureSandbox();
  const { control: c } = control(opts);
  const id = taskIds(opts)[0];

  // "the failed-review count is 0" discusses the counter; it passes and fails
  // nothing. This compound noun was the largest false-positive family left in
  // the live data.
  const updated = await c.progress({
    actor: 'codex', id, status: 'in-progress',
    reason: 'Counted the live store: the failed-review count is still 0 on all but two of 1,994 tasks.'
  });
  assert.equal(updated.updated, true);
  assert.equal(Object.prototype.hasOwnProperty.call(updated, 'warning'), false);
  assert.equal(savedRecord(opts, id).decisions[0].decision, 'progress');

  const refusing = control(opts, { reviewAsProgress: 'refuse' }).control;
  const again = await refusing.progress({
    actor: 'codex', id, status: 'blocked-external',
    reason: 'Recounted: failed review counts are 1 at most, on two tasks.'
  });
  assert.equal(again.updated, true, 'counter talk is not refused under the refuse switch either');
});

test('a verdict with no reason is refused: a count nobody can explain is not signal', () => {
  const { opts } = fixtureSandbox();
  const { control: c } = control(opts);
  const id = taskIds(opts)[0];

  for (const reason of [undefined, '', '   ']) {
    assert.throws(
      () => c.review({ actor: 'codex', id, reviewId: 'l4-noreason', outcome: 'failed', reason }),
      error => {
        assert.equal(error.code, 'T_LEDGER_REVIEW_REASON_REQUIRED');
        assert.match(error.message, /needs a reason/);
        return true;
      }
    );
  }
  const record = savedRecord(opts, id);
  assert.deepEqual(record.decisions, []);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'failedReviewCount'), false);
});

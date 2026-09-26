'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeTaskDifficulty, newTaskDifficultyFields,
  difficultyAfterFailedReviews, planTaskDifficultyReview,
} = require('../src/lib/task-difficulty');

const review = (reviewId, outcome = 'failed') => ({ reviewId, outcome });
const graded = (difficulty = 'easy', failedReviewCount = 0) => ({ difficulty, failedReviewCount });

test('enabled new filing requires one accepted difficulty, while off adds no fields', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    assert.deepEqual(newTaskDifficultyFields({ difficulty, enabled: true }), { difficulty, failedReviewCount: 0 });
    assert.equal(normalizeTaskDifficulty(difficulty), difficulty);
  }
  for (const difficulty of [undefined, null]) {
    assert.throws(() => newTaskDifficultyFields({ difficulty, enabled: true }), { code: 'T_LEDGER_DIFFICULTY_REQUIRED' });
  }
  for (const difficulty of ['', 'Easy', 'medium ', 'expert', 2, {}, []]) {
    assert.throws(() => newTaskDifficultyFields({ difficulty, enabled: true }), { code: 'T_LEDGER_DIFFICULTY_INVALID' });
  }
  assert.deepEqual(newTaskDifficultyFields(), {});
  assert.deepEqual(newTaskDifficultyFields({ enabled: false }), {});
  assert.deepEqual(newTaskDifficultyFields({ enabled: false, difficulty: 'hard' }), {});
});

test('cumulative failures raise easy to medium then hard without any demotion', () => {
  for (const [grade, count, expected] of [
    ['easy', 0, 'easy'], ['easy', 1, 'medium'], ['easy', 2, 'hard'],
    ['easy', 10, 'hard'], ['medium', 0, 'medium'], ['medium', 1, 'medium'],
    ['medium', 2, 'hard'], ['hard', 0, 'hard'], ['hard', 1, 'hard'],
  ]) assert.equal(difficultyAfterFailedReviews(grade, count), expected);
});

test('two distinct failed reviews plan both regrades with a successful review between them', () => {
  const first = planTaskDifficultyReview(graded(), review('first'), { enabled: true });
  assert.equal(first.difficulty, 'medium');
  assert.equal(first.failedReviewCount, 1);
  assert.equal(first.review.reviewId, 'first');
  assert.equal(first.review.outcome, 'failed');
  assert.equal(first.regrade.from, 'easy');
  assert.equal(first.regrade.to, 'medium');
  assert.equal(first.regrade.failedReviewCount, 1);
  assert.ok(first.regrade.reason.length > 0);

  const passed = planTaskDifficultyReview(graded(first.difficulty, first.failedReviewCount), review('passed', 'passed'), { enabled: true });
  assert.equal(passed.difficulty, 'medium');
  assert.equal(passed.failedReviewCount, 1);
  assert.equal(passed.regrade, null);
  assert.equal(passed.review.outcome, 'passed');

  const second = planTaskDifficultyReview(graded(passed.difficulty, passed.failedReviewCount), review('second'), { enabled: true });
  assert.equal(second.difficulty, 'hard');
  assert.equal(second.failedReviewCount, 2);
  assert.equal(second.regrade.from, 'medium');
  assert.equal(second.regrade.to, 'hard');
  assert.equal(second.regrade.failedReviewCount, 2);
});

test('grading off still records explicit outcomes/counts and preserves the existing grade', () => {
  const failed = planTaskDifficultyReview(graded('easy', 5), review('off-failure'), { enabled: false });
  assert.equal(failed.changed, true);
  assert.equal(failed.failedReviewCount, 6);
  assert.equal(failed.difficulty, 'easy');
  assert.equal(failed.regrade, null);
  const passed = planTaskDifficultyReview(graded('hard', 6), review('off-pass', 'passed'));
  assert.equal(passed.failedReviewCount, 6);
  assert.equal(passed.difficulty, 'hard');
  assert.equal(passed.regrade, null);
});

test('legacy ungraded tasks record reviews without acquiring a synthetic difficulty', () => {
  for (const enabled of [false, true]) {
    const legacy = Object.freeze({ id: 'T1' });
    const first = planTaskDifficultyReview(legacy, review('legacy-first'), { enabled });
    assert.equal(first.failedReviewCount, 1);
    assert.equal(Object.hasOwn(first, 'difficulty'), false);
    assert.equal(first.regrade, null);
    const later = planTaskDifficultyReview({ failedReviewCount: 8 }, review('legacy-later'), { enabled });
    assert.equal(later.failedReviewCount, 9);
    assert.equal(Object.hasOwn(later, 'difficulty'), false);
    assert.deepEqual(legacy, { id: 'T1' });
  }
});

test('reenabling grading uses cumulative failed reviews without changing an intervening success', () => {
  const passed = planTaskDifficultyReview(graded('easy', 3), review('after-enable-pass', 'passed'), { enabled: true });
  assert.equal(passed.difficulty, 'easy');
  assert.equal(passed.failedReviewCount, 3);
  assert.equal(passed.regrade, null);
  const failed = planTaskDifficultyReview(graded('easy', 3), review('after-enable-fail'), { enabled: true });
  assert.equal(failed.difficulty, 'hard');
  assert.equal(failed.failedReviewCount, 4);
});

test('persisted duplicate events are no-ops in enabled, disabled and legacy states', () => {
  for (const enabled of [false, true]) {
    for (const record of [graded('hard', 5), { failedReviewCount: 5 }]) {
      for (const outcome of ['failed', 'passed']) {
        const event = review('already-recorded', outcome);
        const result = planTaskDifficultyReview(record, event, { enabled, previousReview: { ...event, failedReviewCount: 1 } });
        assert.equal(result.changed, false);
        assert.equal(result.replayed, true);
        assert.equal(Object.hasOwn(result, 'failedReviewCount'), false, 'replay must not reset later failures to the old event count');
        assert.equal(Object.hasOwn(result, 'regrade'), false);
        assert.equal(record.failedReviewCount, 5);
      }
    }
  }
});

test('a reused event ID cannot contradict its persisted outcome in any grading state', () => {
  for (const enabled of [false, true]) {
    for (const record of [graded(), {}]) {
      assert.throws(() => planTaskDifficultyReview(record, review('same'), {
        enabled, previousReview: review('same', 'passed'),
      }), { code: 'T_LEDGER_REVIEW_EVENT_CONFLICT' });
    }
  }
  assert.throws(() => planTaskDifficultyReview(graded(), review('incoming'), {
    enabled: true, previousReview: review('unrelated'),
  }), { code: 'T_LEDGER_REVIEW_EVENT_MISMATCH' });
});

test('invalid outcomes and bounded review identities refuse before planning changes', () => {
  assert.throws(() => planTaskDifficultyReview(graded(), { eventId: 'old-name', outcome: 'failed' }, { enabled: true }), { code: 'T_LEDGER_REVIEW_EVENT_INVALID' });
  for (const reviewId of ['', ' ', 'bad id', 'x'.repeat(129), null, 1]) {
    assert.throws(() => planTaskDifficultyReview(graded(), review(reviewId), { enabled: true }), { code: 'T_LEDGER_REVIEW_EVENT_INVALID' });
  }
  assert.equal(planTaskDifficultyReview(graded(), review('x'.repeat(128)), { enabled: true }).failedReviewCount, 1);
  for (const outcome of [undefined, null, '', 'rejected', 'FAILED']) {
    assert.throws(() => planTaskDifficultyReview(graded(), { reviewId: 'outcome', outcome }), { code: 'T_LEDGER_REVIEW_OUTCOME_INVALID' });
  }
});

test('invalid or overflowing counters refuse instead of dropping failures or regrading from corrupt data', () => {
  for (const count of [-1, 0.5, NaN, Infinity, null, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => planTaskDifficultyReview(graded('easy', count), review('count'), { enabled: true }), { code: 'T_LEDGER_REVIEW_COUNT_INVALID' });
  }
  assert.throws(() => planTaskDifficultyReview(graded('hard', Number.MAX_SAFE_INTEGER), review('overflow'), { enabled: true }), { code: 'T_LEDGER_REVIEW_COUNT_INVALID' });
  assert.equal(planTaskDifficultyReview(graded('hard', Number.MAX_SAFE_INTEGER), review('pass', 'passed'), { enabled: true }).failedReviewCount, Number.MAX_SAFE_INTEGER);
});

test('planning does not mutate the task, event or persisted review', () => {
  const record = Object.freeze(graded());
  const event = Object.freeze(review('immutable'));
  const result = planTaskDifficultyReview(record, event, { enabled: true });
  assert.deepEqual(record, graded());
  assert.deepEqual(event, review('immutable'));
  assert.equal(result.difficulty, 'medium');
  assert.equal(result.failedReviewCount, 1);
  const prior = Object.freeze({ ...event, failedReviewCount: 1 });
  assert.equal(planTaskDifficultyReview(record, event, { enabled: true, previousReview: prior }).changed, false);
  assert.equal(prior.failedReviewCount, 1);
});

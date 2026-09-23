'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createMapLedgerFixture } = require('./lib/task-waiting-memory-fixture.cjs');

const engine = process.env.T850_ENGINE_ROOT || path.resolve(__dirname, '..');
const lib = process.env.T850_COMPOSITION_LIB || path.join(engine, 'src', 'lib');
const SETTING = 'agent.task_difficulty_enabled';

function fixture(enabled = false) {
  const f = createMapLedgerFixture({ engine, lib, label: 'task-difficulty-store' });
  const originalSettings = f.opts.loadSettings;
  const state = { enabled };
  f.opts.loadSettings = () => {
    const snapshot = originalSettings();
    return { ...snapshot, values: { ...snapshot.values, [SETTING]: state.enabled } };
  };
  const file = extra => f.store.fileTask({ scope: 'global', words: 'Inert graded task', filedBy: 'codex', ...extra }, f.opts);
  const review = (id, extra = {}) => f.store.recordTaskReview({
    id, reviewId: 'review-one', outcome: 'failed', reason: 'Inert independent review', actor: 'codex', ...extra
  }, f.opts);
  const record = id => f.store.readAll({ ...f.opts, kinds: ['T'], includeRemoved: true }).records.find(row => row.id === id);
  const snapshot = () => ({ ledger: f.fileBytes(f.ledgerFile), history: f.fileBytes(f.historyFile) });
  const unchanged = before => assert.deepEqual(snapshot(), before);
  const edit = (id, mutate) => {
    const document = f.readLedger();
    mutate(document.requests.find(row => row.id === id));
    f.memory.writeFileSync(f.ledgerFile, JSON.stringify(document));
  };
  return { ...f, state, file, review, record, snapshot, unchanged, edit };
}

test('grading off and ordinary legacy reads or progress never invent grade fields', () => {
  const f = fixture();
  const task = f.file({ difficulty: 'hard', enabled: true, failedReviewCount: 99 });
  assert.equal(Object.hasOwn(task, 'difficulty'), false);
  assert.equal(Object.hasOwn(task, 'failedReviewCount'), false);
  const before = f.snapshot();
  const record = f.record(task.id);
  assert.equal(Object.hasOwn(record, 'difficulty'), false);
  assert.equal(Object.hasOwn(record, 'failedReviewCount'), false);
  f.unchanged(before);
  f.state.enabled = true;
  f.store.progressTask({ id: task.id, status: 'in-progress', reason: 'Ordinary progress only', actor: 'codex' }, f.opts);
  assert.equal(Object.hasOwn(f.record(task.id), 'difficulty'), false);
  assert.equal(Object.hasOwn(f.record(task.id), 'failedReviewCount'), false);
  assert.equal(f.store.verifyHistory(f.opts).ok, true);
});

test('enabled filing requires a valid difficulty and refuses without publishing a record', () => {
  const f = fixture();
  f.file();
  f.state.enabled = true;
  for (const difficulty of [undefined, null, '', 'HARD', 1, {}, 'invalid']) {
    const before = f.snapshot();
    assert.throws(() => f.file({ difficulty }), {
      code: difficulty == null ? 'T_LEDGER_DIFFICULTY_REQUIRED' : 'T_LEDGER_DIFFICULTY_INVALID'
    });
    f.unchanged(before);
  }
});

test('enabled one-shot and recurring filing persist the chosen grade and zero count', () => {
  const f = fixture(true);
  for (const difficulty of ['easy', 'medium', 'hard']) {
    for (const recurrence of [null, { interval: 'inert-daily' }]) {
      const task = f.file({ difficulty, recurrence, failedReviewCount: 50 });
      assert.equal(task.difficulty, difficulty);
      assert.equal(task.failedReviewCount, 0);
      assert.equal(f.record(task.id).difficulty, difficulty);
      assert.equal(f.record(task.id).failedReviewCount, 0);
      assert.equal(task.status, recurrence ? 'recurring' : 'open');
    }
  }
  assert.equal(f.store.verifyHistory(f.opts).ok, true);
});

test('superseding filing validates its grade before changing the old task', () => {
  const f = fixture(true);
  const old = f.file({ difficulty: 'hard' });
  const before = f.snapshot();
  assert.throws(() => f.file({ supersedes: old.id }), { code: 'T_LEDGER_DIFFICULTY_REQUIRED' });
  f.unchanged(before);
  assert.equal(f.record(old.id).status, 'open');
  const replacement = f.file({ supersedes: old.id, difficulty: 'easy' });
  assert.equal(replacement.difficulty, 'easy');
  assert.equal(replacement.failedReviewCount, 0);
  assert.equal(f.record(old.id).status, 'superseded');
  assert.equal(f.record(old.id).difficulty, 'hard');
  assert.equal(f.store.verifyHistory(f.opts).ok, true);
});

test('unique failed reviews raise easy to medium then hard and journal each factual review', () => {
  const f = fixture(true);
  const task = f.file({ difficulty: 'easy' });
  for (const [index, grade] of ['medium', 'hard', 'hard'].entries()) {
    const result = f.review(task.id, { reviewId: 'failed-' + index });
    assert.equal(result.reviewed, true);
    assert.equal(result.changed, true);
    assert.equal(result.replayed, false);
    assert.equal(result.difficulty, grade);
    assert.equal(result.failedReviewCount, index + 1);
    assert.equal(result.status, 'open');
    assert.equal(f.record(task.id).difficulty, grade);
  }
  const passed = f.review(task.id, { reviewId: 'passed-one', outcome: 'passed' });
  assert.equal(passed.failedReviewCount, 3);
  assert.equal(passed.difficulty, 'hard');
  assert.equal(passed.regrade, null);
  const events = f.readHistory().trim().split('\n').map(line => JSON.parse(line));
  const reviews = events.filter(event => event.operation?.type === 'task-review');
  assert.equal(reviews.length, 4);
  assert.deepEqual(reviews.map(event => event.operation.outcome), ['failed', 'failed', 'failed', 'passed']);
  assert.deepEqual(reviews.slice(0, 2).map(event => [event.operation.regrade.from, event.operation.regrade.to]),
    [['easy', 'medium'], ['medium', 'hard']]);
  assert.equal(reviews[2].operation.regrade, null);
  assert.equal(f.record(task.id).decisions.filter(row => row.decision === 'review').length, 4);
  assert.equal(f.store.verifyHistory(f.opts).ok, true);
});

test('reviews preserve stronger grades and can review a done task without reopening it', () => {
  const f = fixture(true);
  for (const difficulty of ['medium', 'hard']) {
    const task = f.file({ difficulty });
    f.store.completeTask({ id: task.id, actor: 'codex' }, f.opts);
    const result = f.review(task.id);
    assert.equal(result.difficulty, difficulty);
    assert.equal(result.status, 'done');
    assert.equal(f.record(task.id).status, 'done');
    assert.equal(result.regrade, null);
  }
});

test('off-state reviews preserve factual failures without regrading until a new enabled failure', () => {
  const f = fixture(true);
  const task = f.file({ difficulty: 'easy' });
  f.state.enabled = false;
  const first = f.review(task.id);
  assert.equal(first.failedReviewCount, 1);
  assert.equal(first.difficulty, 'easy');
  assert.equal(first.regrade, null);
  f.state.enabled = true;
  const passed = f.review(task.id, { reviewId: 'later-pass', outcome: 'passed' });
  assert.equal(passed.difficulty, 'easy');
  assert.equal(passed.failedReviewCount, 1);
  const second = f.review(task.id, { reviewId: 'later-failure' });
  assert.equal(second.difficulty, 'hard');
  assert.equal(second.failedReviewCount, 2);
});

test('explicit legacy reviews count outcomes while off or on without synthesizing a grade', () => {
  const f = fixture();
  const task = f.file();
  for (const [index, enabled] of [false, true].entries()) {
    f.state.enabled = enabled;
    const result = f.review(task.id, { reviewId: 'legacy-' + index });
    assert.equal(result.failedReviewCount, index + 1);
    assert.equal(Object.hasOwn(result, 'difficulty'), false);
    assert.equal(Object.hasOwn(f.record(task.id), 'difficulty'), false);
    assert.equal(result.regrade, null);
  }
  assert.equal(f.store.verifyHistory(f.opts).ok, true);
});

test('same semantic review replays at a new time without settings reads or any new write', () => {
  const f = fixture(true);
  const task = f.file({ difficulty: 'easy' });
  const first = f.review(task.id, { now: () => new Date('2026-01-01T00:00:00Z') });
  f.review(task.id, { reviewId: 'second', now: () => new Date('2026-01-02T00:00:00Z') });
  const before = f.snapshot();
  f.opts.loadSettings = () => ({ values: { 'ledger.verify_history': false,
    get [SETTING]() { throw new Error('replay must not reapply grading policy'); } } });
  const replay = f.review(task.id, { reason: '  Inert independent review  ', now: () => new Date('2026-01-03T00:00:00Z') });
  assert.equal(replay.reviewed, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.changed, false);
  assert.equal(replay.failedReviewCount, 2, 'receipt returns current saved count');
  assert.equal(replay.difficulty, 'hard', 'receipt returns current saved grade');
  assert.equal(replay.recordedAt, first.recordedAt);
  assert.deepEqual(replay.regrade, first.regrade, 'regrade belongs to the original review');
  f.unchanged(before);
});

test('duplicate review refuses malformed present grade without changing stored bytes', () => {
  for (const difficulty of [null, '', 'HARD', 'unknown', 5, {}, ['easy']]) {
    const f = fixture(true), task = f.file({ difficulty: 'easy' });
    f.review(task.id);
    f.edit(task.id, row => { row.difficulty = difficulty; });
    const before = f.snapshot();
    assert.throws(() => f.review(task.id), { code: 'T_LEDGER_DIFFICULTY_INVALID' });
    f.unchanged(before);
  }
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const f = fixture(true), task = f.file({ difficulty });
    const first = f.review(task.id);
    const before = f.snapshot(), replay = f.review(task.id);
    assert.equal(replay.replayed, true);
    assert.equal(replay.difficulty, first.difficulty);
    assert.equal(replay.recordedAt, first.recordedAt);
    f.unchanged(before);
  }
  const legacy = fixture(), task = legacy.file();
  legacy.review(task.id);
  const before = legacy.snapshot(), replay = legacy.review(task.id);
  assert.equal(replay.replayed, true);
  assert.equal(Object.hasOwn(replay, 'difficulty'), false);
  legacy.unchanged(before);
});

test('same review identity refuses different actor reason or outcome without a partial write', () => {
  const f = fixture(true);
  const task = f.file({ difficulty: 'easy' });
  f.review(task.id);
  for (const changed of [{ actor: 'claude' }, { reason: 'Different finding' }, { outcome: 'passed' }]) {
    const before = f.snapshot();
    assert.throws(() => f.review(task.id, changed), { code: 'T_LEDGER_REVIEW_EVENT_CONFLICT' });
    f.unchanged(before);
  }
});

test('invalid review values refuse and a bounded valid reviewId is accepted', () => {
  const f = fixture(true);
  const task = f.file({ difficulty: 'hard' });
  for (const reviewId of ['', null, 5, 'contains space', 'a'.repeat(129)]) {
    const before = f.snapshot();
    assert.throws(() => f.review(task.id, { reviewId }), { code: 'T_LEDGER_REVIEW_EVENT_INVALID' });
    f.unchanged(before);
  }
  const before = f.snapshot();
  assert.throws(() => f.review(task.id, { outcome: 'maybe' }), { code: 'T_LEDGER_REVIEW_OUTCOME_INVALID' });
  f.unchanged(before);
  assert.equal(f.review(task.id, { reviewId: 'a'.repeat(128) }).reviewed, true);
});

test('unsafe persisted counts refuse rather than corrupting the next count', () => {
  for (const count of [-1, '2', Number.MAX_SAFE_INTEGER, 1.5]) {
    const f = fixture(true);
    const task = f.file({ difficulty: 'easy' });
    f.edit(task.id, row => { row.failedReviewCount = count; });
    const before = f.snapshot();
    assert.throws(() => f.review(task.id), { code: 'T_LEDGER_REVIEW_COUNT_INVALID' });
    f.unchanged(before);
  }
});

test('removed superseded and reset tasks cannot receive reviews', () => {
  for (const mode of ['removed', 'superseded', 'reset']) {
    const f = fixture(true);
    const task = f.file({ difficulty: 'easy' });
    if (mode === 'removed') f.store.removeTask({ id: task.id, actor: 'codex' }, f.opts);
    // A task is never declined (decide() takes R ids only); its other retirement is supersession.
    if (mode === 'superseded') {
      assert.throws(() => f.store.decide({ id: task.id, decision: 'decline', actor: 'owner' }, f.opts), { code: 'R_LEDGER_ID_INVALID' });
      f.file({ difficulty: 'easy', supersedes: task.id });
      assert.equal(f.record(task.id).status, 'superseded');
    }
    if (mode === 'reset') f.edit(task.id, row => {
      row.reset = { batchId: '00000000-0000-4000-8000-000000000001', kind: 'T', at: '2026-01-01T00:00:00.000Z', actor: 'owner', revision: 0 };
    });
    const before = f.snapshot();
    assert.throws(() => f.review(task.id), { code: mode === 'reset' ? 'R_LEDGER_ENTRY_RESET' : 'R_LEDGER_STATUS_INVALID' });
    f.unchanged(before);
  }
});

test('history core binds grade count and full review identity rather than only decision length', () => {
  for (const tamper of [
    row => { row.difficulty = 'hard'; },
    row => { row.failedReviewCount = 99; },
    row => { row.decisions.at(-1).reviewId = 'different'; },
    row => { row.decisions.at(-1).outcome = 'passed'; },
    row => { row.decisions.at(-1).reason = 'changed reason'; },
    row => { row.decisions.at(-1).actor = 'claude'; },
  ]) {
    const f = fixture(true);
    const task = f.file({ difficulty: 'easy' });
    f.review(task.id);
    assert.equal(f.store.verifyHistory(f.opts).ok, true);
    f.edit(task.id, tamper);
    const verification = f.store.verifyHistory(f.opts);
    assert.equal(verification.ok, false);
    assert.ok(verification.drift.includes(task.id));
  }
});

test('settings are read under the store lock and public flags cannot override them', () => {
  const f = fixture(false);
  let gradeReads = 0;
  f.opts.loadSettings = () => ({ values: { 'ledger.verify_history': false,
    get [SETTING]() {
      gradeReads++;
      assert.equal(f.files.has(f.ledgerFile + f.store.LOCK_SUFFIX), true);
      return false;
    }
  } });
  const task = f.file({ difficulty: 'hard', enabled: true, gradingEnabled: true });
  assert.equal(gradeReads, 1);
  assert.equal(Object.hasOwn(task, 'difficulty'), false);
  const result = f.review(task.id, { enabled: true, gradingEnabled: true, failedReviewCount: 50, previousReview: {} });
  assert.equal(gradeReads, 2);
  assert.equal(result.failedReviewCount, 1);
  assert.equal(Object.hasOwn(result, 'difficulty'), false);
});

test('unavailable asynchronous or malformed settings refuse new filing and reviews', () => {
  for (const loadSettings of [
    () => { throw new Error('inert settings failure'); },
    () => Promise.resolve({ values: { [SETTING]: true } }),
    () => ({ values: { [SETTING]: 'true' } }),
    () => ({ values: { [SETTING]: false }, rejected: [{ id: SETTING }] }),
    () => ({ values: { [SETTING]: false }, rejected: [{ id: '*' }] }),
    () => null,
  ]) {
    const f = fixture(false);
    const task = f.file();
    f.opts.loadSettings = loadSettings;
    const before = f.snapshot();
    assert.throws(() => f.file({ difficulty: 'easy' }), { code: 'T_LEDGER_DIFFICULTY_SETTINGS_UNAVAILABLE' });
    f.unchanged(before);
    assert.throws(() => f.review(task.id), { code: 'T_LEDGER_DIFFICULTY_SETTINGS_UNAVAILABLE' });
    f.unchanged(before);
  }
});

test('document publication failure throws and never returns a reviewed receipt', () => {
  const f = fixture(true);
  const task = f.file({ difficulty: 'easy' });
  const before = f.snapshot();
  const write = f.memory.writeFileSync;
  f.memory.writeFileSync = (file, ...args) => {
    const target = typeof file === 'number' ? f.descriptors.get(file)?.file : null;
    if (target?.startsWith(f.ledgerFile + '.') && !target.startsWith(f.ledgerFile + f.store.LOCK_SUFFIX)) {
      throw Object.assign(new Error('inert document write failure'), { code: 'EIO' });
    }
    return write(file, ...args);
  };
  try { assert.throws(() => f.review(task.id), { code: 'EIO' }); }
  finally { f.memory.writeFileSync = write; }
  f.unchanged(before);
  assert.equal(f.record(task.id).failedReviewCount, 0);
});

test('failed journal append never returns success and retry cannot double-apply the saved review', () => {
  const f = fixture(true);
  const task = f.file({ difficulty: 'easy' });
  const historyBefore = f.fileBytes(f.historyFile);
  const write = f.memory.writeSync;
  f.memory.writeSync = () => { throw Object.assign(new Error('inert append failure'), { code: 'EIO' }); };
  try { assert.throws(() => f.review(task.id), { code: 'R_LEDGER_CHAIN_APPEND_FAILED' }); }
  finally { f.memory.writeSync = write; }
  assert.equal(f.record(task.id).failedReviewCount, 1, 'document publication precedes the unconfirmed append');
  assert.deepEqual(f.fileBytes(f.historyFile), historyBefore);
  const beforeRetry = f.snapshot();
  assert.throws(() => f.review(task.id), { code: 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED' });
  f.unchanged(beforeRetry);
});

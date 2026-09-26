'use strict';

// Adapter coverage for task difficulty and review identity. The direct gate tests
// use an inert store so they prove argument forwarding and refusal ordering
// without touching the owner ledger. Registry/schema and permission checks use
// the real definitions; the task bridge test uses a throwaway root only.

require('./lib/isolated-environment').activate('task-difficulty-adapters');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MinorLedgerAgentControl } = require('../src/lib/minor-ledger-agent-gate');
const ledger = require('../src/lib/r-ledger');
const store = require('../src/lib/owner-request-store');
const registry = require('../src/lib/tool-registry');
const policy = require('../src/lib/permission-tier-policy');
const surface = require('../src/lib/confined-tool-surface');
const { assertValid } = require('../src/lib/schema-validator');
const { bindAgentActor } = require('../src/mcp-server');

const STANDARD = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
const GUIDED = Object.freeze({ origin: 'local', tier: 'confined', profile: 'read-only' });
const auditSettings = () => ({
  values: { 'audit.enabled': true },
  provenance: { 'audit.enabled': { source: 'user' } }
});

class InertStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function inertStore(reviewResult) {
  const calls = { file: [], review: [] };
  return {
    OwnerRequestStoreError: InertStoreError,
    calls,
    fileTask(args, options) {
      calls.file.push({ args, options });
      return { id: 'T1', status: 'open', filedBy: args.filedBy };
    },
    recordTaskReview(args, options) {
      calls.review.push({ args, options });
      return typeof reviewResult === 'function' ? reviewResult(args, options) : reviewResult;
    }
  };
}

function flatReview(overrides = {}) {
  return {
    reviewed: true,
    changed: true,
    replayed: false,
    id: 'T1',
    reviewId: 'r1',
    outcome: 'passed',
    status: 'open',
    failedReviewCount: 0,
    revision: 1,
    recordedAt: '2026-09-22T10:00:00.000Z',
    regrade: null,
    ...overrides
  };
}

function control(storeOverride, options = {}, auditRequire = () => ({ durable: true })) {
  const audits = [];
  const control = new MinorLedgerAgentControl({
    store: storeOverride,
    ledgerOptions: options,
    loadSettings: auditSettings,
    auditRequire: (action, target, details) => {
      audits.push({ action, target, details });
      return auditRequire(action, target, details);
    }
  });
  return { control, audits };
}

test('the gate forwards difficulty and only the public review fields, with store-owned time and policy', () => {
  const options = Object.freeze({ marker: 'adapter-test' });
  const reviewResult = {
    reviewed: true,
    changed: true,
    replayed: false,
    id: 'T1',
    reviewId: 'review-1',
    outcome: 'failed',
    status: 'open',
    failedReviewCount: 1,
    difficulty: 'medium',
    revision: 3,
    recordedAt: '2026-09-22T10:00:00.000Z',
    regrade: { from: 'easy', to: 'medium', failedReviewCount: 1, reason: 'Failed review count 1 raised difficulty.' }
  };
  const inert = inertStore(reviewResult);
  const { control: gate, audits } = control(inert, options);

  const filed = gate.file({
    actor: 'codex',
    scope: 'global',
    words: 'record a graded task',
    why: 'adapter coverage',
    difficulty: 'hard',
    now: 'caller time must not cross this gate'
  });
  assert.equal(filed.filed, true);
  assert.deepEqual(inert.calls.file[0], {
    args: {
      scope: 'global',
      key: undefined,
      words: 'record a graded task',
      filedBy: 'codex',
      why: 'adapter coverage',
      recurrence: null,
      difficulty: 'hard'
    },
    options
  });

  const result = gate.review({
    actor: 'codex',
    id: 'T1',
    reviewId: 'review-1',
    outcome: 'failed',
    reason: 'The bounded adapter check failed.',
    now: 'caller time must be ignored',
    enabled: true,
    failedReviewCount: 99,
    previousReview: { reviewId: 'old', outcome: 'passed' }
  });
  assert.deepEqual(result, reviewResult, 'the public result preserves the flat B14 receipt exactly');
  assert.deepEqual(inert.calls.review[0], {
    args: {
      id: 'T1',
      reviewId: 'review-1',
      outcome: 'failed',
      reason: 'The bounded adapter check failed.',
      actor: 'codex'
    },
    options
  });
  assert.equal(Object.hasOwn(inert.calls.review[0].args, 'now'), false);
  assert.equal(Object.hasOwn(inert.calls.review[0].args, 'enabled'), false);
  assert.equal(Object.hasOwn(inert.calls.review[0].args, 'failedReviewCount'), false);
  assert.equal(Object.hasOwn(inert.calls.review[0].args, 'previousReview'), false);
  assert.deepEqual(audits.map(row => row.action), ['t_ledger.file', 't_ledger.review']);
  assert.deepEqual(audits[1].details, { actor: 'codex', reviewId: 'review-1', outcome: 'failed' });
});

test('the review gate preserves unique and replay receipt states', () => {
  const inert = inertStore(args => args.reviewId === 'unique'
    ? {
        reviewed: true,
        changed: true,
        replayed: false,
        id: 'T1',
        reviewId: 'unique',
        outcome: 'failed',
        status: 'open',
        failedReviewCount: 1,
        difficulty: 'medium',
        revision: 4,
        recordedAt: '2026-09-22T10:01:00.000Z',
        regrade: {
          from: 'easy',
          to: 'medium',
          failedReviewCount: 1,
          reason: 'Failed review count 1 raised difficulty.'
        }
      }
    : {
        reviewed: true,
        changed: false,
        replayed: true,
        id: 'T1',
        reviewId: 'replay',
        outcome: 'failed',
        status: 'in-progress',
        failedReviewCount: 2,
        difficulty: 'hard',
        revision: 6,
        recordedAt: '2026-09-22T10:01:00.000Z',
        regrade: {
          from: 'easy',
          to: 'medium',
          failedReviewCount: 1,
          reason: 'The original review raised difficulty.'
        }
      });
  const { control: gate } = control(inert);

  const unique = gate.review({
    actor: 'codex',
    id: 'T1',
    reviewId: 'unique',
    outcome: 'failed',
    reason: 'The unique review failed.'
  });
  assert.equal(unique.changed, true);
  assert.equal(unique.replayed, false);
  assert.equal(unique.failedReviewCount, 1);
  assert.equal(unique.status, 'open');
  assert.equal(unique.difficulty, 'medium');
  assert.equal(unique.regrade.to, 'medium');

  const replay = gate.review({
    actor: 'codex',
    id: 'T1',
    reviewId: 'replay',
    outcome: 'failed',
    reason: 'The replayed review is unchanged.'
  });
  assert.equal(replay.changed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.recordedAt, '2026-09-22T10:01:00.000Z');
  assert.equal(replay.regrade.reason, 'The original review raised difficulty.');
  assert.equal(replay.status, 'in-progress');
  assert.equal(replay.failedReviewCount, 2);
  assert.equal(replay.difficulty, 'hard');
  assert.equal(replay.revision, 6);
});

test('the review gate refuses a missing, malformed or asynchronous store result', () => {
  const results = [
    { value: undefined, code: 'R_LEDGER_REVIEW_RESULT_INVALID' },
    { value: null, code: 'R_LEDGER_REVIEW_RESULT_INVALID' },
    { value: Promise.resolve(flatReview()), code: 'R_LEDGER_REVIEW_RESULT_INVALID' },
    { value: {}, code: 'R_LEDGER_REVIEW_RESULT_INVALID' },
    { value: flatReview({ failedReviewCount: undefined }), code: 'R_LEDGER_REVIEW_COUNT_INVALID' },
    { value: flatReview({ failedReviewCount: -1 }), code: 'R_LEDGER_REVIEW_COUNT_INVALID' },
    { value: flatReview({ id: 'T2' }), code: 'R_LEDGER_REVIEW_RESULT_INVALID' },
    { value: flatReview({ reviewId: 'other' }), code: 'R_LEDGER_REVIEW_RESULT_INVALID' },
    { value: flatReview({ outcome: 'unknown' }), code: 'R_LEDGER_REVIEW_RESULT_INVALID' }
  ];
  for (const { value: reviewResult, code } of results) {
    const inert = inertStore(reviewResult);
    const { control: gate } = control(inert);
    assert.throws(
      () => gate.review({
        actor: 'codex',
        id: 'T1',
        reviewId: 'r1',
        outcome: 'passed',
        reason: 'The store result is intentionally incomplete.'
      }),
      error => error.code === code
    );
  }
});

test('review keeps the existing audit and secret-shape refusals before the store call', () => {
  const inert = inertStore({
    id: 'T1',
    reviewId: 'r1',
    outcome: 'passed'
  });
  const { control: gate } = control(inert, {}, () => ({ durable: false }));
  assert.throws(() => gate.review({
    actor: 'codex',
    id: 'T1',
    reviewId: 'r1',
    outcome: 'passed',
    reason: 'The audit must be durable.'
  }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  assert.equal(inert.calls.review.length, 0);

  const { control: secretGate } = control(inert);
  const tokenShapedReason = 'The api key is ' + ['sk', 'live'].join('_') + '_' + 'a'.repeat(40);
  assert.throws(() => secretGate.review({
    actor: 'codex',
    id: 'T1',
    reviewId: 'r2',
    outcome: 'failed',
    reason: tokenShapedReason
  }), { code: 'R_LEDGER_WORDS_REFUSED' });
  assert.equal(inert.calls.review.length, 0);
});

test('the T bridge forwards difficulty only when authoritative grading is enabled; R and A stay unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-difficulty-adapter-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  const enabled = {
    rootPath,
    loadSettings: () => ({
      values: { 'agent.task_difficulty_enabled': true },
      provenance: { 'agent.task_difficulty_enabled': { source: 'user' } }
    })
  };
  const disabled = {
    rootPath,
    loadSettings: () => ({
      values: { 'agent.task_difficulty_enabled': false },
      provenance: { 'agent.task_difficulty_enabled': { source: 'user' } }
    })
  };

  const task = ledger.fileRequest({
    kind: 'T',
    scope: 'global',
    words: 'bridge a hard task',
    filedBy: 'codex',
    difficulty: 'hard'
  }, enabled);
  assert.equal(task.id, 'T1');
  assert.equal(store.readAll({ ...enabled, kinds: ['T'] }).records[0].difficulty, 'hard');

  const offTask = ledger.fileRequest({
    kind: 'T',
    scope: 'global',
    words: 'bridge an ungraded task',
    filedBy: 'codex',
    difficulty: 'hard'
  }, disabled);
  const offRecord = store.readAll({ ...disabled, kinds: ['T'] }).records.find(record => record.id === offTask.id);
  assert.equal(Object.hasOwn(offRecord, 'difficulty'), false);

  const ask = ledger.fileRequest({
    kind: 'A',
    scope: 'global',
    words: 'bridge an ask',
    filedBy: 'codex',
    difficulty: 'hard'
  }, enabled);
  const rule = ledger.fileRequest({
    scope: 'global',
    words: 'bridge a rule',
    filedBy: 'codex',
    difficulty: 'hard'
  }, enabled);
  assert.equal(ask.id, 'A1');
  assert.equal(rule.id, 'R1');
  for (const record of store.readAll({ ...enabled, kinds: ['A', 'R'] }).records) {
    assert.equal(Object.hasOwn(record, 'difficulty'), false, `${record.id} must retain its non-task shape`);
  }
});

test('the real registry carries the review schema, handler, confinement and tier decisions', () => {
  const review = registry.getTool('t_ledger.review');
  assert.ok(review);
  assert.equal(Object.hasOwn(review, 'handler'), false, 'public descriptors must not expose handlers');
  const internalReview = registry.assertToolRegistered('t_ledger.review');
  assert.equal(typeof internalReview.handler, 'function', 'the internal registry route retains the review handler');
  const handlerInput = Object.freeze({
    actor: 'codex',
    id: 'T1',
    reviewId: 'review-1',
    outcome: 'failed',
    reason: 'The observed check failed.'
  });
  const sentinel = Object.freeze({ routed: true });
  let observed;
  const originalReview = Object.getOwnPropertyDescriptor(MinorLedgerAgentControl.prototype, 'review');
  assert.ok(originalReview, 'the gate prototype review method must be restorable');
  try {
    Object.defineProperty(MinorLedgerAgentControl.prototype, 'review', {
      ...originalReview,
      value(args) {
        observed = args;
        return sentinel;
      }
    });
    assert.strictEqual(internalReview.handler(handlerInput), sentinel);
    assert.deepEqual(observed, handlerInput);
  } finally {
    Object.defineProperty(MinorLedgerAgentControl.prototype, 'review', originalReview);
  }
  assert.equal(review.effect, 'local-write');
  assert.equal(review.annotations.idempotentHint, true);
  assert.equal(surface.classify('t_ledger.review'), 'contained');
  policy.assertToolAllowed(review, STANDARD);
  assert.throws(() => policy.assertToolAllowed(review, GUIDED), { code: 'PERMISSION_CONFINED_EFFECT_REFUSED' });

  assert.deepEqual(Object.keys(review.baseInputSchema.properties).sort(),
    ['actor', 'id', 'outcome', 'reason', 'reviewId']);
  assert.deepEqual(review.baseInputSchema.required, ['actor', 'id', 'reviewId', 'outcome', 'reason']);
  const valid = {
    actor: 'codex',
    id: 'T1',
    reviewId: 'review-1',
    outcome: 'failed',
    reason: 'The observed check failed.'
  };
  assert.doesNotThrow(() => assertValid(review.inputSchema, valid, { path: '$' }));
  assert.doesNotThrow(() => assertValid(review.inputSchema, { ...valid, reviewId: 'x'.repeat(128), reason: 'x'.repeat(300) }, { path: '$' }));
  for (const field of ['enabled', 'failedReviewCount', 'previousReview', 'now']) {
    assert.throws(() => assertValid(review.inputSchema, { ...valid, [field]: field === 'enabled' ? true : 1 }, { path: '$' }),
      error => error && error.name === 'SchemaValidationError',
      `public review schema must reject ${field}`);
  }
  assert.throws(() => assertValid(review.inputSchema, { ...valid, reviewId: 'bad id' }, { path: '$' }),
    { name: 'SchemaValidationError' });
  assert.throws(() => assertValid(review.inputSchema, { ...valid, reviewId: 'x'.repeat(129) }, { path: '$' }),
    { name: 'SchemaValidationError' });
  assert.throws(() => assertValid(review.inputSchema, { ...valid, reason: '' }, { path: '$' }),
    { name: 'SchemaValidationError' });
  assert.throws(() => assertValid(review.inputSchema, { ...valid, reason: 'x'.repeat(301) }, { path: '$' }),
    { name: 'SchemaValidationError' });

  const file = registry.getTool('t_ledger.file');
  assert.ok(file);
  assert.deepEqual(file.baseInputSchema.properties.difficulty.enum, ['easy', 'medium', 'hard']);
  assert.doesNotThrow(() => assertValid(file.inputSchema, {
    actor: 'codex', scope: 'global', words: 'a task', difficulty: 'easy'
  }, { path: '$' }));

  const actions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'actions.json'), 'utf8'));
  assert.ok(actions.actions.read.says.includes('review'));
  assert.equal(actions.idOverrides['t_ledger.review'], 'change');
});

test('task review is actor-bound across the real transport seam', () => {
  const matching = { actor: 'codex', id: 'T1', reviewId: 'r1', outcome: 'passed', reason: 'reviewed' };
  assert.equal(bindAgentActor('t_ledger.review', matching, 'codex'), matching);
  assert.equal(bindAgentActor('t_ledger.review', matching, ' CODEX '), matching);
  assert.throws(() => bindAgentActor('t_ledger.review', { ...matching, actor: 'claude' }, 'codex'),
    error => error.code === -32602 && /ledger actor must match/i.test(error.message));
  assert.throws(() => bindAgentActor('t_ledger.review', matching, ''),
    error => error.code === -32602 && /ledger mutation requires/i.test(error.message));
  assert.throws(() => bindAgentActor('t_ledger.review', { ...matching, actor: 'human' }, 'human'),
    error => error.code === -32602);
});


// T1295 composition cases. The explicit engine/lib arguments bind this fixture to
// the test checkout; T850_ENGINE_ROOT is intentionally not consulted here.
// The test requires the T1172 Map fixture and the composed T1224 store API.
const { createMapLedgerFixture: createT1295MapLedgerFixture } = require('./lib/task-waiting-memory-fixture.cjs');
const T1295_ENGINE_ROOT = path.resolve(__dirname, '..');
const T1295_LIB_ROOT = path.join(T1295_ENGINE_ROOT, 'src', 'lib');
const T1295_DIFFICULTY_SETTING = 'agent.task_difficulty_enabled';

function t1295ActualFixture(enabled, label) {
  const fixture = createT1295MapLedgerFixture({
    engine: T1295_ENGINE_ROOT,
    lib: T1295_LIB_ROOT,
    label
  });
  const inheritedLoadSettings = fixture.opts.loadSettings;
  const state = { enabled };
  fixture.opts.loadSettings = () => {
    const snapshot = inheritedLoadSettings();
    return {
      ...snapshot,
      values: { ...snapshot.values, [T1295_DIFFICULTY_SETTING]: state.enabled }
    };
  };

  assert.equal(typeof fixture.store.readAll, 'function',
    'T1172 memory fixture must expose the real exported-store reader');
  assert.equal(typeof fixture.store.fileTask, 'function',
    'T1224 composition must expose the real fileTask API');
  assert.equal(typeof fixture.store.recordTaskReview, 'function',
    'T1224 composition must expose the real recordTaskReview API');

  // Use the existing synchronous-audit helper with the actual store. The
  // fixture gate() seam only supplies auditRequireAsync.
  const { control: gate } = control(fixture.store, fixture.opts);
  return { fixture, state, gate };
}

test('T1295 composed gate requires a grade and persists an actual filing', () => {
  const { fixture, gate } = t1295ActualFixture(true, 'task-difficulty-adapter-required');

  assert.throws(() => gate.file({
    actor: 'codex',
    scope: 'global',
    words: 'A task that needs a grade.'
  }), error => error && error.code === 'T_LEDGER_DIFFICULTY_REQUIRED');
  assert.equal(fixture.readTasks().length, 0);

  const filed = gate.file({
    actor: 'codex',
    scope: 'global',
    words: 'A graded task.',
    difficulty: 'easy'
  });
  assert.equal(filed.filed, true);
  const saved = fixture.findTask(filed.id);
  assert.ok(saved);
  assert.equal(saved.difficulty, 'easy');
  assert.equal(saved.failedReviewCount, 0);
});

test('T1295 composed gate persists unique, second and matching replay receipts', () => {
  const { fixture, gate } = t1295ActualFixture(true, 'task-difficulty-adapter-replay');
  const filed = gate.file({
    actor: 'codex',
    scope: 'global',
    words: 'A task with review history.',
    difficulty: 'easy'
  });

  const first = gate.review({
    actor: 'codex',
    id: filed.id,
    reviewId: 't1295-first',
    outcome: 'failed',
    reason: 'The first composed review failed.'
  });
  assert.equal(first.reviewed, true);
  assert.equal(first.changed, true);
  assert.equal(first.replayed, false);
  assert.equal(first.failedReviewCount, 1);
  assert.equal(first.difficulty, 'medium');
  assert.equal(fixture.findTask(filed.id).failedReviewCount, 1);
  assert.equal(fixture.findTask(filed.id).difficulty, 'medium');

  const second = gate.review({
    actor: 'codex',
    id: filed.id,
    reviewId: 't1295-second',
    outcome: 'failed',
    reason: 'The second composed review failed.'
  });
  assert.equal(second.changed, true);
  assert.equal(second.replayed, false);
  assert.equal(second.failedReviewCount, 2);
  assert.equal(second.difficulty, 'hard');
  assert.equal(fixture.findTask(filed.id).failedReviewCount, 2);
  assert.equal(fixture.findTask(filed.id).difficulty, 'hard');

  const beforeLedger = fixture.fileBytes(fixture.ledgerFile);
  const beforeHistory = fixture.fileBytes(fixture.historyFile);
  const replay = gate.review({
    actor: 'codex',
    id: filed.id,
    reviewId: 't1295-first',
    outcome: 'failed',
    reason: 'The first composed review failed.'
  });
  assert.equal(replay.reviewed, true);
  assert.equal(replay.changed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.recordedAt, first.recordedAt);
  assert.equal(replay.status, 'open');
  assert.equal(replay.failedReviewCount, 2);
  assert.equal(replay.difficulty, 'hard');
  assert.deepEqual(replay.regrade, first.regrade);
  assert.equal(replay.regrade.from, 'easy');
  assert.equal(replay.regrade.to, 'medium');
  assert.deepEqual(fixture.fileBytes(fixture.ledgerFile), beforeLedger);
  assert.deepEqual(fixture.fileBytes(fixture.historyFile), beforeHistory);

  const reviewEvents = fixture.readHistory().trim().split('\n')
    .map(line => JSON.parse(line))
    .filter(event => event.operation?.type === 'task-review');
  assert.equal(reviewEvents.length, 2);
  assert.deepEqual(reviewEvents.map(event => event.operation.reviewId),
    ['t1295-first', 't1295-second']);
  assert.equal(fixture.findTask(filed.id).decisions.filter(row => row.decision === 'review').length, 2);
});

test('T1295 composed gate records factual failures while grading is off and on legacy tasks', () => {
  const off = t1295ActualFixture(true, 'task-difficulty-adapter-off');
  const graded = off.gate.file({
    actor: 'codex',
    scope: 'global',
    words: 'A graded task reviewed while grading is off.',
    difficulty: 'easy'
  });
  off.state.enabled = false;
  const offResult = off.gate.review({
    actor: 'codex',
    id: graded.id,
    reviewId: 't1295-off',
    outcome: 'failed',
    reason: 'The off-state review still records a fact.'
  });
  assert.equal(offResult.failedReviewCount, 1);
  assert.equal(offResult.difficulty, 'easy');
  assert.equal(offResult.regrade, null);
  assert.equal(off.fixture.findTask(graded.id).failedReviewCount, 1);
  assert.equal(off.fixture.findTask(graded.id).difficulty, 'easy');

  const legacy = t1295ActualFixture(false, 'task-difficulty-adapter-legacy');
  const legacyFiled = legacy.gate.file({
    actor: 'codex',
    scope: 'global',
    words: 'A legacy task without a grade.'
  });
  const legacyResult = legacy.gate.review({
    actor: 'codex',
    id: legacyFiled.id,
    reviewId: 't1295-legacy',
    outcome: 'failed',
    reason: 'The legacy review still records a fact.'
  });
  assert.equal(legacyResult.failedReviewCount, 1);
  assert.equal(Object.hasOwn(legacyResult, 'difficulty'), false);
  assert.equal(legacyResult.regrade, null);
  const legacySaved = legacy.fixture.findTask(legacyFiled.id);
  assert.equal(legacySaved.failedReviewCount, 1);
  assert.equal(Object.hasOwn(legacySaved, 'difficulty'), false);

  legacy.state.enabled = true;
  const enabledLegacyResult = legacy.gate.review({
    actor: 'codex',
    id: legacyFiled.id,
    reviewId: 't1295-legacy-enabled',
    outcome: 'failed',
    reason: 'Enabling grading must not invent a legacy grade.'
  });
  assert.equal(enabledLegacyResult.failedReviewCount, 2);
  assert.equal(Object.hasOwn(enabledLegacyResult, 'difficulty'), false);
  assert.equal(enabledLegacyResult.regrade, null);
  const enabledLegacySaved = legacy.fixture.findTask(legacyFiled.id);
  assert.equal(enabledLegacySaved.failedReviewCount, 2);
  assert.equal(Object.hasOwn(enabledLegacySaved, 'difficulty'), false);
});

test('T1295 composed gate refuses setting failure and publication failure', () => {
  const rejected = t1295ActualFixture(false, 'task-difficulty-adapter-settings-refusal');
  rejected.fixture.opts.loadSettings = () => Promise.resolve({
    values: { [T1295_DIFFICULTY_SETTING]: true }
  });
  assert.throws(() => rejected.gate.file({
    actor: 'codex',
    scope: 'global',
    words: 'This filing has unavailable settings.',
    difficulty: 'easy'
  }), error => error && error.code === 'T_LEDGER_DIFFICULTY_SETTINGS_UNAVAILABLE');
  assert.equal(rejected.fixture.readTasks().length, 0);

  const reviewRejected = t1295ActualFixture(false, 'task-difficulty-adapter-review-settings-refusal');
  const legacy = reviewRejected.gate.file({
    actor: 'codex',
    scope: 'global',
    words: 'This legacy task will face unavailable settings.'
  });
  const beforeRejectedLedger = reviewRejected.fixture.fileBytes(reviewRejected.fixture.ledgerFile);
  const beforeRejectedHistory = reviewRejected.fixture.fileBytes(reviewRejected.fixture.historyFile);
  reviewRejected.fixture.opts.loadSettings = () => {
    throw new Error('T1295 settings unavailable');
  };
  assert.throws(() => reviewRejected.gate.review({
    actor: 'codex',
    id: legacy.id,
    reviewId: 't1295-settings',
    outcome: 'failed',
    reason: 'Settings are intentionally unavailable.'
  }), error => error && error.code === 'T_LEDGER_DIFFICULTY_SETTINGS_UNAVAILABLE');
  assert.deepEqual(reviewRejected.fixture.fileBytes(reviewRejected.fixture.ledgerFile), beforeRejectedLedger);
  assert.deepEqual(reviewRejected.fixture.fileBytes(reviewRejected.fixture.historyFile), beforeRejectedHistory);
  assert.equal(Object.hasOwn(reviewRejected.fixture.findTask(legacy.id), 'failedReviewCount'), false);

  const publication = t1295ActualFixture(true, 'task-difficulty-adapter-publication-refusal');
  const publicationTask = publication.gate.file({
    actor: 'codex',
    scope: 'global',
    words: 'This review publication will fail.',
    difficulty: 'easy'
  });
  const beforePublicationLedger = publication.fixture.fileBytes(publication.fixture.ledgerFile);
  const beforePublicationHistory = publication.fixture.fileBytes(publication.fixture.historyFile);
  const originalWriteFileSync = publication.fixture.memory.writeFileSync;
  publication.fixture.memory.writeFileSync = (file, ...args) => {
    const target = typeof file === 'number'
      ? publication.fixture.descriptors.get(file)?.file
      : null;
    if (target?.startsWith(publication.fixture.ledgerFile + '.')
      && !target.startsWith(publication.fixture.ledgerFile + publication.fixture.store.LOCK_SUFFIX)) {
      throw Object.assign(new Error('T1295 publication failure'), { code: 'EIO' });
    }
    return originalWriteFileSync.call(publication.fixture.memory, file, ...args);
  };
  try {
    assert.throws(() => publication.gate.review({
      actor: 'codex',
      id: publicationTask.id,
      reviewId: 't1295-publication',
      outcome: 'failed',
      reason: 'Publication is intentionally refused.'
    }), error => error && error.code === 'EIO');
  } finally {
    publication.fixture.memory.writeFileSync = originalWriteFileSync;
  }
  assert.deepEqual(publication.fixture.fileBytes(publication.fixture.ledgerFile), beforePublicationLedger);
  assert.deepEqual(publication.fixture.fileBytes(publication.fixture.historyFile), beforePublicationHistory);
  const publicationSaved = publication.fixture.findTask(publicationTask.id);
  assert.equal(publicationSaved.failedReviewCount, 0);
  assert.equal(publicationSaved.difficulty, 'easy');
});

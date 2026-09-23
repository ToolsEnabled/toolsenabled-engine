'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const actions = require('../src/lib/mission-bridge/actions');
const { resolveTaskAssignment } = require('../src/lib/task-difficulty');

const TIERS = actions.TIERS;
const GRADE_TO_TIER = Object.freeze({
  easy: 'luna',
  medium: 'terra',
  hard: 'sol',
});
const CODEX_EFFORTS = Object.freeze([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function recipientFor(tier) {
  const row = TIERS[tier];
  assert.ok(row, 'test fixture tier ' + tier + ' is declared');
  return {
    nodeId: 'node-' + tier,
    tier,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
  };
}

function stubResolver(calls) {
  return (args = {}, dependencies = {}) => {
    calls.push({ ...args });
    const tiers = dependencies.tiers || TIERS;
    const row = tiers[args.tier];
    if (!row) {
      throw Object.assign(new Error('unknown test tier'), { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' });
    }
    if (args.provider !== undefined && args.provider !== row.provider) {
      throw Object.assign(new Error('provider does not match the declared tier'), {
        code: 'AGENT_TASK_DIFFICULTY_MISMATCH',
      });
    }
    if (args.model !== undefined && args.model !== row.model && args.model !== row.cliModel) {
      throw Object.assign(new Error('model does not match the declared tier'), {
        code: 'AGENT_TASK_DIFFICULTY_MISMATCH',
      });
    }
    if (args.effort !== undefined) {
      const supported = row.provider === 'codex'
        ? CODEX_EFFORTS
        : row.provider === 'claude' ? CLAUDE_EFFORTS : [];
      if (!supported.includes(args.effort)) {
        throw Object.assign(new Error('effort is not supported by the declared provider'), {
          code: 'AGENT_TASK_DIFFICULTY_MISMATCH',
        });
      }
    }
    return Object.freeze({
      provider: row.provider,
      model: row.model,
      effort: row.provider === 'claude' && args.effort === 'ultra' ? 'max' : args.effort,
    });
  };
}

function options(calls, extra = {}) {
  return {
    gradingEnabled: true,
    tiers: TIERS,
    resolveModelChoice: stubResolver(calls),
    ...extra,
  };
}

function expected(taskDifficulty, recipientTier) {
  const requiredTier = TIERS[GRADE_TO_TIER[taskDifficulty]];
  const recipient = recipientFor(recipientTier);
  return {
    required: true,
    difficulty: taskDifficulty,
    requiredStrength: requiredTier.tier,
    requiredEffort: requiredTier.effort,
    recipient: {
      tier: recipient.tier,
      provider: recipient.provider,
      model: recipient.model,
      effort: recipient.effort,
    },
  };
}

test('enabled grades require the declared minimum strength and strongest declared default effort', () => {
  for (const [difficulty, tier] of Object.entries(GRADE_TO_TIER)) {
    const calls = [];
    const recipient = recipientFor(tier);
    const result = resolveTaskAssignment(
      { id: 'T-' + difficulty, difficulty, failedReviewCount: 0 },
      recipient,
      options(calls)
    );
    assert.deepEqual(result, expected(difficulty, tier));
    assert.ok(calls.length >= 2, difficulty + ': the injected model resolver validated required and actual values');
    const efforts = calls.map(call => call.effort);
    assert.ok(efforts.includes(result.requiredEffort), difficulty + ': required effort floor was validated');
    assert.ok(efforts.includes(recipient.effort), difficulty + ': recipient effort was validated');
  }
});

test('an existing recipient at the same or stronger declared class is accepted', () => {
  const easyCalls = [];
  assert.deepEqual(
    resolveTaskAssignment(
      { id: 'T-easy', difficulty: 'easy', failedReviewCount: 0 },
      recipientFor('terra'),
      options(easyCalls)
    ),
    expected('easy', 'terra')
  );

  const mediumCalls = [];
  assert.deepEqual(
    resolveTaskAssignment(
      { id: 'T-medium', difficulty: 'medium', failedReviewCount: 0 },
      recipientFor('sol'),
      options(mediumCalls)
    ),
    expected('medium', 'sol')
  );
});

test('grading off and legacy ungraded tasks return no-policy results without invoking model resolution', () => {
  const calls = [];
  assert.deepEqual(
    resolveTaskAssignment(
      { id: 'T-off', difficulty: 'hard', failedReviewCount: 0 },
      recipientFor('sol'),
      options(calls, { gradingEnabled: false })
    ),
    { required: false, reason: 'grading-disabled' }
  );
  assert.deepEqual(
    resolveTaskAssignment(
      { id: 'T-legacy' },
      recipientFor('sol'),
      options(calls)
    ),
    { required: false, reason: 'legacy-ungraded-task' }
  );
  assert.equal(calls.length, 0);
});

test('invalid task grades or review counts refuse before recipient selection', () => {
  const invalidGradeCalls = [];
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-invalid-grade', difficulty: 'expert' },
      recipientFor('luna'),
      options(invalidGradeCalls)
    ),
    { code: 'AGENT_TASK_DIFFICULTY_INVALID' }
  );
  assert.equal(invalidGradeCalls.length, 0);

  const invalidCountCalls = [];
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-invalid-count', difficulty: 'easy', failedReviewCount: -1 },
      recipientFor('luna'),
      options(invalidCountCalls)
    ),
    { code: 'AGENT_TASK_DIFFICULTY_INVALID' }
  );
  assert.equal(invalidCountCalls.length, 0);

  const missingCountCalls = [];
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-missing-count', difficulty: 'easy' },
      recipientFor('luna'),
      options(missingCountCalls)
    ),
    { code: 'AGENT_TASK_DIFFICULTY_INVALID' }
  );
  assert.equal(missingCountCalls.length, 0);
});

test('stored difficulty remains authoritative and failed count does not silently regrade on assignment', () => {
  const calls = [];
  const result = resolveTaskAssignment(
    { id: 'T-count', difficulty: 'easy', failedReviewCount: 2 },
    recipientFor('luna'),
    options(calls)
  );
  assert.deepEqual(result, expected('easy', 'luna'));
});

test('a lower recipient class is refused rather than replaced with another agent', () => {
  const calls = [];
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-hard', difficulty: 'hard', failedReviewCount: 0 },
      recipientFor('luna'),
      options(calls)
    ),
    { code: 'AGENT_TASK_DIFFICULTY_MISMATCH' }
  );
  assert.equal(calls.length, 0);
});

test('unknown or incomplete recipient state refuses as unavailable', () => {
  const unknownCalls = [];
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-unknown', difficulty: 'medium', failedReviewCount: 0 },
      { nodeId: 'node-unknown', tier: 'not-declared', provider: 'codex', model: 'not-declared', effort: 'high' },
      options(unknownCalls)
    ),
    { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' }
  );
  assert.equal(unknownCalls.length, 0);

  const incompleteCalls = [];
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-missing', difficulty: 'medium', failedReviewCount: 0 },
      { nodeId: 'node-missing', tier: 'terra', provider: 'codex' },
      options(incompleteCalls)
    ),
    { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' }
  );
  assert.equal(incompleteCalls.length, 0);
});

test('authoritative provider, model and effort mismatches refuse without inventing a replacement', () => {
  const badProvider = recipientFor('terra');
  badProvider.provider = 'claude';
  const badModel = recipientFor('terra');
  badModel.model = TIERS.sol.model;
  const badEffort = recipientFor('terra');
  badEffort.effort = 'medium';

  for (const recipient of [badProvider, badModel, badEffort]) {
    const calls = [];
    assert.throws(
      () => resolveTaskAssignment(
        { id: 'T-medium-mismatch', difficulty: 'medium', failedReviewCount: 0 },
        recipient,
        options(calls)
      ),
      { code: 'AGENT_TASK_DIFFICULTY_MISMATCH' }
    );
    assert.equal(calls.length, recipient === badEffort ? 2 : 0);
  }
});

test('unknown tier, missing effort floor, missing resolver or missing tiers refuse as unavailable', () => {
  const unknownFloorCalls = [];
  const incompleteTiers = { ...TIERS };
  delete incompleteTiers.luna;
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-easy-missing-tier', difficulty: 'easy', failedReviewCount: 0 },
      recipientFor('terra'),
      options(unknownFloorCalls, { tiers: incompleteTiers })
    ),
    { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' }
  );
  assert.equal(unknownFloorCalls.length, 0);

  const missingResolverCalls = [];
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-no-resolver', difficulty: 'easy', failedReviewCount: 0 },
      recipientFor('luna'),
      { gradingEnabled: true, tiers: TIERS }
    ),
    { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' }
  );
  assert.equal(missingResolverCalls.length, 0);

  const missingTiersCalls = [];
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-no-tiers', difficulty: 'easy', failedReviewCount: 0 },
      recipientFor('luna'),
      { gradingEnabled: true, resolveModelChoice: stubResolver(missingTiersCalls) }
    ),
    { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' }
  );
  assert.equal(missingTiersCalls.length, 0);
});

test('an invalid or defaultless required-strength declaration refuses before model resolution', () => {
  const malformedCalls = [];
  const malformedTiers = {
    ...TIERS,
    luna: { ...TIERS.luna, effort: 'not-a-supported-effort' },
  };
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-easy-malformed-default', difficulty: 'easy', failedReviewCount: 0 },
      recipientFor('luna'),
      options(malformedCalls, { tiers: malformedTiers })
    ),
    { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' }
  );
  assert.equal(malformedCalls.length, 0);

  const defaultlessCalls = [];
  const defaultlessTiers = Object.fromEntries(Object.entries(TIERS).map(([name, row]) => {
    if (!row || row.tier !== 'cheap') return [name, row];
    const copy = { ...row };
    delete copy.effort;
    return [name, copy];
  }));
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-easy-no-default', difficulty: 'easy', failedReviewCount: 0 },
      recipientFor('luna'),
      options(defaultlessCalls, { tiers: defaultlessTiers })
    ),
    { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' }
  );
  assert.equal(defaultlessCalls.length, 0);
});

test('provider support rejection and invalid resolver normalization remain unavailable', () => {
  const supportCalls = [];
  const rejectingResolver = (args) => {
    supportCalls.push({ ...args });
    throw new Error('declared provider rejected the requested effort');
  };
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-medium-unsupported', difficulty: 'medium', failedReviewCount: 0 },
      recipientFor('terra'),
      options(supportCalls, { resolveModelChoice: rejectingResolver })
    ),
    { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' }
  );
  assert.equal(supportCalls.length, 1);

  const normalizationCalls = [];
  const invalidNormalizedResolver = (args) => {
    normalizationCalls.push({ ...args });
    return {
      provider: TIERS.terra.provider,
      model: TIERS.terra.model,
      effort: 'not-supported-by-provider',
    };
  };
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-medium-invalid-normalization', difficulty: 'medium', failedReviewCount: 0 },
      recipientFor('terra'),
      options(normalizationCalls, { resolveModelChoice: invalidNormalizedResolver })
    ),
    { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' }
  );
  assert.equal(normalizationCalls.length, 2);
});

test('a Claude recipient with explicit effort is normalized even when its TIERS row has no default', () => {
  const calls = [];
  const recipient = { ...recipientFor('claude-fable'), effort: 'ultra' };
  const result = resolveTaskAssignment(
    { id: 'T-easy-claude', difficulty: 'easy', failedReviewCount: 0 },
    recipient,
    options(calls)
  );
  assert.deepEqual(result, {
    required: true,
    difficulty: 'easy',
    requiredStrength: 'cheap',
    requiredEffort: 'medium',
    recipient: {
      tier: 'claude-fable',
      provider: 'claude',
      model: 'claude/fable',
      effort: 'max',
    },
  });
  assert.deepEqual(calls.map(({ tier, provider, model, effort }) => ({
    tier, provider, model, effort,
  })), [
    { tier: 'claude-fable', provider: 'claude', model: 'claude/fable', effort: 'medium' },
    { tier: 'claude-fable', provider: 'claude', model: 'claude/fable', effort: 'ultra' },
  ]);
  assert.equal(TIERS['claude-fable'].effort, undefined);
});

test('a local recipient with an explicit named effort refuses when authority reports no support', () => {
  const calls = [];
  const recipient = { ...recipientFor('local'), effort: 'medium' };
  assert.throws(
    () => resolveTaskAssignment(
      { id: 'T-easy-local', difficulty: 'easy', failedReviewCount: 0 },
      recipient,
      options(calls)
    ),
    { code: 'AGENT_TASK_DIFFICULTY_UNAVAILABLE' }
  );
  assert.equal(calls.length, 1);
});

test('selector inputs remain unchanged after a successful compatibility receipt', () => {
  const task = Object.freeze({
    id: 'T-frozen',
    difficulty: 'easy',
    failedReviewCount: 0,
  });
  const recipient = Object.freeze(recipientFor('luna'));
  const tiers = Object.freeze({ ...TIERS });
  const taskBefore = { ...task };
  const recipientBefore = { ...recipient };
  const rowBefore = { ...tiers.luna };
  const calls = [];

  const result = resolveTaskAssignment(
    task,
    recipient,
    options(calls, { tiers })
  );

  assert.deepEqual(result, expected('easy', 'luna'));
  assert.deepEqual(task, taskBefore);
  assert.deepEqual(recipient, recipientBefore);
  assert.deepEqual(tiers.luna, rowBefore);
  assert.deepEqual(Object.keys(tiers), Object.keys(TIERS));
});

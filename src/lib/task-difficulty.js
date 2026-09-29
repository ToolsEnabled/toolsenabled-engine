'use strict';

const TASK_DIFFICULTY_SETTING_ID = 'agent.task_difficulty_enabled';
const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);
const MAX_REVIEW_ID_LENGTH = 128;

function refuse(code, message) {
  throw Object.assign(new Error(message), { code });
}

function normalizeTaskDifficulty(value) {
  if (!DIFFICULTIES.includes(value)) {
    refuse('T_LEDGER_DIFFICULTY_INVALID', 'Task difficulty must be easy, medium or hard.');
  }
  return value;
}

function newTaskDifficultyFields({ difficulty, enabled = false } = {}) {
  if (enabled !== true) return Object.freeze({});
  if (difficulty === undefined || difficulty === null) {
    refuse('T_LEDGER_DIFFICULTY_REQUIRED', 'Choose easy, medium or hard when filing a task.');
  }
  return Object.freeze({ difficulty: normalizeTaskDifficulty(difficulty), failedReviewCount: 0 });
}

function failedReviewCount(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse('T_LEDGER_REVIEW_COUNT_INVALID', 'The task failed-review count must be a non-negative safe integer.');
  }
  return value;
}

function difficultyAfterFailedReviews(difficulty, count) {
  const grade = normalizeTaskDifficulty(difficulty);
  const failures = failedReviewCount(count);
  const floor = failures >= 2 ? 2 : failures === 1 ? 1 : 0;
  return DIFFICULTIES[Math.max(DIFFICULTIES.indexOf(grade), floor)];
}

function normalizeReviewEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
      || typeof event.reviewId !== 'string'
      || event.reviewId.length > MAX_REVIEW_ID_LENGTH
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(event.reviewId)) {
    refuse('T_LEDGER_REVIEW_EVENT_INVALID', 'A task review needs a stable reviewId of at most 128 letters, digits, dots, underscores, colons or hyphens.');
  }
  if (event.outcome !== 'passed' && event.outcome !== 'failed') {
    refuse('T_LEDGER_REVIEW_OUTCOME_INVALID', 'A task review outcome must be passed or failed.');
  }
  return Object.freeze({ reviewId: event.reviewId, outcome: event.outcome });
}

// The store must call this inside its transaction, looking up previousReview by
// reviewId in persisted history. Persist the returned review and optional regrade
// together with the count/grade; this helper neither writes nor reads state.
function planTaskDifficultyReview(record, event, { enabled = false, previousReview = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    refuse('T_LEDGER_REVIEW_TASK_INVALID', 'A task review needs the current task record.');
  }
  const incoming = normalizeReviewEvent(event);
  if (previousReview !== null && previousReview !== undefined) {
    const previous = normalizeReviewEvent(previousReview);
    if (previous.reviewId !== incoming.reviewId) {
      refuse('T_LEDGER_REVIEW_EVENT_MISMATCH', 'The persisted review does not match the incoming reviewId.');
    }
    if (previous.outcome !== incoming.outcome) {
      refuse('T_LEDGER_REVIEW_EVENT_CONFLICT', 'This reviewId already has a different outcome.');
    }
    return Object.freeze({ changed: false, replayed: true, reason: 'duplicate-review' });
  }
  const hasDifficulty = Object.prototype.hasOwnProperty.call(record, 'difficulty');
  const difficulty = hasDifficulty ? record.difficulty : undefined;
  if (enabled === true && hasDifficulty) normalizeTaskDifficulty(difficulty);
  const count = failedReviewCount(record.failedReviewCount);
  if (incoming.outcome === 'failed' && count === Number.MAX_SAFE_INTEGER) {
    refuse('T_LEDGER_REVIEW_COUNT_INVALID', 'The task failed-review count cannot be incremented safely.');
  }
  const nextCount = count + (incoming.outcome === 'failed' ? 1 : 0);
  // Explicit reviews remain factual while grading is off or a legacy task has
  // no grade. Only an enabled, graded failed review may change difficulty.
  const nextDifficulty = enabled === true && hasDifficulty && incoming.outcome === 'failed'
    ? difficultyAfterFailedReviews(difficulty, nextCount) : difficulty;
  const review = Object.freeze({ ...incoming, failedReviewCount: nextCount });
  const regrade = nextDifficulty === difficulty ? null : Object.freeze({
    from: difficulty, to: nextDifficulty, failedReviewCount: nextCount,
    reason: 'Failed review count ' + nextCount + ' raised difficulty from ' + difficulty + ' to ' + nextDifficulty + '.',
  });
  return Object.freeze({
    changed: true,
    ...(hasDifficulty ? { difficulty: nextDifficulty } : {}),
    failedReviewCount: nextCount, review, regrade,
  });
}

const ASSIGNMENT_STRENGTH = Object.freeze({ easy: 'cheap', medium: 'standard', hard: 'premium' });
const STRENGTH_ORDER = Object.freeze(['cheap', 'standard', 'premium']);
const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

// The assignment transaction supplies the locked task, its settings snapshot,
// and a trusted configuration for an existing recipient. resolveModelChoice is
// the same pure provider/model/effort validator used by the actual tree path.
// This returns a compatibility receipt; it never applies a configuration.
function resolveTaskAssignment(task, targetConfiguration, {
  gradingEnabled = false, tiers, resolveModelChoice,
} = {}) {
  if (gradingEnabled !== true) return Object.freeze({ required: false, reason: 'grading-disabled' });
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    refuse('AGENT_TASK_DIFFICULTY_INVALID', 'Task assignment needs the locked task record.');
  }
  if (!Object.prototype.hasOwnProperty.call(task, 'difficulty')) {
    return Object.freeze({ required: false, reason: 'legacy-ungraded-task' });
  }
  if (!DIFFICULTIES.includes(task.difficulty)) {
    refuse('AGENT_TASK_DIFFICULTY_INVALID', 'The task has no valid difficulty for assignment.');
  }
  // The stored grade is authoritative. Historical failures while grading was
  // off do not silently regrade a task during assignment.
  if (!Number.isSafeInteger(task.failedReviewCount) || task.failedReviewCount < 0) {
    refuse('AGENT_TASK_DIFFICULTY_INVALID', 'The task failed-review count is invalid.');
  }
  if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)
      || typeof resolveModelChoice !== 'function'
      || !targetConfiguration || typeof targetConfiguration !== 'object') {
    refuse('AGENT_TASK_DIFFICULTY_UNAVAILABLE', 'The existing recipient configuration and declared model policy could not be established.');
  }
  const { tier, provider, model, effort } = targetConfiguration;
  if (typeof tier !== 'string' || !Object.prototype.hasOwnProperty.call(tiers, tier)) {
    refuse('AGENT_TASK_DIFFICULTY_UNAVAILABLE', 'The existing recipient has no declared model tier.');
  }
  const row = tiers[tier];
  const requiredStrength = ASSIGNMENT_STRENGTH[task.difficulty];
  if (!row || !STRENGTH_ORDER.includes(row.tier)) {
    refuse('AGENT_TASK_DIFFICULTY_UNAVAILABLE', 'The recipient tier has no declared assignment strength.');
  }
  if (STRENGTH_ORDER.indexOf(row.tier) < STRENGTH_ORDER.indexOf(requiredStrength)) {
    refuse('AGENT_TASK_DIFFICULTY_MISMATCH', 'The existing recipient is weaker than this task requires.');
  }
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model
      || typeof effort !== 'string' || !EFFORT_ORDER.includes(effort)) {
    refuse('AGENT_TASK_DIFFICULTY_UNAVAILABLE', 'The recipient provider, model and effective effort must be known before assigning this graded task.');
  }
  if (provider !== row.provider || ![row.model, row.cliModel].includes(model)) {
    refuse('AGENT_TASK_DIFFICULTY_MISMATCH', 'The existing recipient configuration does not match its declared tier.');
  }
  // Defaults are not a provider's accepted effort set. Derive the grade's
  // minimum from declared defaults, then validate support using the real
  // authority below rather than inferring support from a missing default.
  const strengthRows = Object.values(tiers).filter(candidate => candidate && candidate.tier === requiredStrength);
  if (strengthRows.some(candidate => candidate.effort !== undefined && !EFFORT_ORDER.includes(candidate.effort))) {
    refuse('AGENT_TASK_DIFFICULTY_UNAVAILABLE', 'The declared reasoning-effort policy for this task strength is invalid.');
  }
  const defaults = strengthRows
    .filter(candidate => EFFORT_ORDER.includes(candidate.effort))
    .map(candidate => EFFORT_ORDER.indexOf(candidate.effort));
  if (defaults.length === 0) {
    refuse('AGENT_TASK_DIFFICULTY_UNAVAILABLE', 'No reasoning-effort requirement is declared for this task strength.');
  }
  const floor = EFFORT_ORDER[Math.max(...defaults)];
  let required, actual;
  try {
    required = resolveModelChoice({ tier, provider, model, effort: floor }, { tiers });
    actual = resolveModelChoice({ tier, provider, model, effort }, { tiers });
  } catch {
    refuse('AGENT_TASK_DIFFICULTY_UNAVAILABLE', 'The provider cannot confirm the required and existing recipient model/effort settings.');
  }
  if (!required || !actual || required.provider !== provider || actual.provider !== provider
      || required.model !== model || actual.model !== model
      || !EFFORT_ORDER.includes(required.effort) || !EFFORT_ORDER.includes(actual.effort)) {
    refuse('AGENT_TASK_DIFFICULTY_UNAVAILABLE', 'The model authority did not confirm the existing recipient configuration.');
  }
  if (EFFORT_ORDER.indexOf(actual.effort) < EFFORT_ORDER.indexOf(required.effort)) {
    refuse('AGENT_TASK_DIFFICULTY_MISMATCH', 'The existing recipient reasoning effort is below this task requirement.');
  }
  return Object.freeze({
    required: true, difficulty: task.difficulty, requiredStrength, requiredEffort: required.effort,
    recipient: Object.freeze({ tier, provider, model, effort: actual.effort }),
  });
}

module.exports = {
  TASK_DIFFICULTY_SETTING_ID, DIFFICULTIES, MAX_REVIEW_ID_LENGTH, normalizeTaskDifficulty,
  newTaskDifficultyFields, difficultyAfterFailedReviews, planTaskDifficultyReview, resolveTaskAssignment,
};

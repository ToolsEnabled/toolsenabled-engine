'use strict';

// THE TWO CALLS EVERYTHING ELSE USES.
//
//   recommend(promptText, opts)  the small block that rides every turn.
//   find(query, opts)            the fuller answer when an agent asks.
//
// recommend() NEVER THROWS. It rides a person's turn, and a missing or broken
// index must produce a turn with no note -- never a turn that does not happen.
// That is the same fail-closed direction src/lib/agent-tool-summary.js chose
// for the static note, and for the same reason: an introduction is not worth
// refusing a session over. Every refusal is a named code the caller can log.
//
// find() DOES answer on failure, in words, because an agent that asked a
// question is owed an answer and "the index could not be read" is one.
//
// THE SETTING IS REAL. agent.capability_recall (config/settings-registry.json,
// default on) names this file as its enforcer, and off means recommend()
// returns { text: '', outcome: 'disabled' } without opening the index. Same
// arrangement as agent.tool_summary and src/lib/agent-tool-summary.js: the row,
// the control and the enforcement, or the row does not get to exist.
//
// NO PROMPT TEXT IS EVER WRITTEN ANYWHERE. lean_rag logs every query string,
// which is right for a research instrument over public documentation and wrong
// here: the query IS the person's words. The optional observer below receives
// term COUNTS, result ids, scores and timings -- never the prompt, never a
// matched word. A recommender that quietly builds a transcript of everything
// its user typed would be a far larger thing than a recommender.

const { load, loadFrom, ArtifactUnavailableError } = require('./artifact');
const { allowedIdsForTier } = require('./allowlist');
const { composeAuto, composeQuery, AUTO_BUDGET_TOKENS, QUERY_BUDGET_TOKENS } = require('./compose');
const { rank } = require('./score');

const AUTO_LIMIT = 3;
const QUERY_LIMIT = 10;

const CAPABILITY_RECALL_SETTING_ID = 'agent.capability_recall';

/* Required lazily, so a caller that passes `enabled` explicitly -- the tests,
 * the eval harness -- never loads the settings layer at all. */
function settingsModule() { return require('../settings'); }
function settingsRegistryModule() { return require('../settings-registry'); }

/**
 * Is the per-prompt block switched on for this installation?
 *
 * THE SHAPE IS COPIED FROM agent-tool-summary.js toolSummaryEnabled(),
 * INCLUDING WHICH WAY IT FAILS, because the two rows make the person the same
 * promise and must not answer differently when the settings layer is sick:
 *
 *   registry loads and does NOT carry the row  -> OFF. A row that is not in
 *     this build's catalogue is a switch the person has never been shown, and
 *     a feature nobody can turn off must not be on.
 *   no settings file exists yet                -> the registry DEFAULT, which
 *     is on. That is the rule src/lib/settings.js applies on a fresh install.
 *   an existing settings file cannot be read   -> REFUSE to answer whether the
 *     feature is enabled. The loader records that uncertainty in `rejected`;
 *     substituting the default would turn "could not read" into a definite on.
 *   the row is present and set false           -> OFF.
 *
 * IT IS READ ON EVERY CALL, WHICH IS ONCE PER TURN, AND THAT IS DELIBERATE.
 * Measured on the shipped catalogue: the read costs about 0.9 ms against the
 * 0.06 ms the query itself costs -- real, and nothing beside a turn that is
 * about to wait on a model. What it buys is that switching this off takes
 * effect on the person's NEXT MESSAGE rather than their next session, which is
 * the only honest cadence for a per-message feature. A caller that has already
 * decided (the tests, the eval harness) passes `enabled` and pays nothing.
 */
function capabilityRecallEnabled({ valuesPath, env } = {}) {
  const registry = settingsRegistryModule().loadRegistry();
  if (!registry.byId.has(CAPABILITY_RECALL_SETTING_ID)) return false;
  const resolved = settingsModule().loadSettings({ registry, valuesPath, env });
  const documentFailure = resolved.rejected.find(rejection => rejection.id === '*');
  if (documentFailure) {
    const error = new Error(documentFailure.reason);
    error.code = 'CAPABILITY_RECALL_SETTINGS_UNAVAILABLE';
    throw error;
  }
  return resolved.values[CAPABILITY_RECALL_SETTING_ID] !== false;
}

function resolveArtifact(options) {
  if (options.artifact) return options.artifact;
  if (options.artifactPath) return loadFrom(options.artifactPath);
  return load();
}

function documentsFor(artifact, results) {
  return results.map(result => artifact.docs[result.index]);
}

function observe(options, record) {
  if (typeof options.observer !== 'function') return;
  try { options.observer(record); } catch { /* an observer must never break a turn */ }
}

/**
 * The block to append to a turn, or nothing.
 *
 * Returns `{ text, tools, ... }` where `text` is '' whenever there is nothing
 * worth saying -- which is the correct answer for "hi", for "thanks", and for
 * any prompt whose best candidate does not clear the floor. The caller appends
 * `text` only when it is non-empty and otherwise does nothing at all.
 */
function recommend(promptText, options = {}) {
  const started = process.hrtime.bigint();

  /* THE SWITCH IS READ FIRST, BEFORE THE INDEX IS EVEN OPENED. agent.capability_recall
   * is this module's row and this module is its named enforcer; off means the
   * block never exists, not that it is composed and dropped somewhere later. */
  let isOn;
  try {
    isOn = typeof options.enabled === 'boolean'
      ? options.enabled
      : capabilityRecallEnabled({ valuesPath: options.valuesPath, env: options.env });
  } catch (error) {
    return Object.freeze({
      text: '', tools: [], outcome: 'unavailable',
      code: error.code || 'CAPABILITY_RECALL_SETTINGS_UNAVAILABLE',
      why: error.message, estimatedTokens: 0, floor: null, durationMs: 0,
    });
  }
  if (!isOn) {
    return Object.freeze({
      text: '', tools: [], outcome: 'disabled', code: 'CAPABILITY_RECALL_DISABLED',
      why: `${CAPABILITY_RECALL_SETTING_ID} is off, so no tools were looked up.`,
      estimatedTokens: 0, floor: null, durationMs: 0,
    });
  }

  let artifact;
  try {
    artifact = resolveArtifact(options);
  } catch (error) {
    const code = error instanceof ArtifactUnavailableError ? error.code : 'CAPABILITY_INDEX_UNAVAILABLE';
    return Object.freeze({
      text: '', tools: [], outcome: 'unavailable', code, why: error.message,
      estimatedTokens: 0, floor: null, durationMs: 0,
    });
  }

  const limit = Number.isInteger(options.limit) ? options.limit : AUTO_LIMIT;
  const floor = typeof options.floor === 'number' ? options.floor : artifact.constants.floorAuto;
  const ranked = rank(artifact, promptText, {
    floor,
    limit,
    allowedIds: options.allowedIds,
    constants: options.constants,
  });
  const documents = documentsFor(artifact, ranked.results);
  const composed = composeAuto(documents, { budgetTokens: options.budgetTokens || AUTO_BUDGET_TOKENS });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  observe(options, {
    mode: 'auto',
    termCount: ranked.query.terms.length,
    candidateCount: ranked.candidates.length,
    returned: ranked.results.map(result => ({ id: result.id, score: Number(result.score.toFixed(4)) })),
    belowFloor: ranked.belowFloor,
    durationMs,
  });

  return Object.freeze({
    text: composed.text,
    tools: ranked.results.map((result, position) => ({
      id: result.id,
      score: result.score,
      phrase: result.phrase,
      matchedWords: result.matchedWords,
      clause: documents[position].clause,
    })),
    outcome: ranked.results.length ? 'hit' : 'silent',
    code: null,
    why: ranked.results.length
      ? null
      : (ranked.bestRejected
        ? `nothing cleared the floor of ${floor}; the closest was ${ranked.bestRejected.id} at ${ranked.bestRejected.score.toFixed(3)}`
        : `no tool matched (${ranked.reason})`),
    estimatedTokens: composed.estimatedTokens,
    detailLevel: composed.detailLevel,
    overBudget: composed.overBudget,
    floor,
    bestRejected: ranked.bestRejected,
    durationMs,
  });
}

/**
 * The answer to an explicit query from an agent.
 *
 * Always has text. `outcome` is 'hit', 'miss' or 'unavailable', following the
 * vocabulary tools/retrieval/index.js established so a third surface does not
 * invent a fourth one.
 */
function find(queryText, options = {}) {
  const started = process.hrtime.bigint();
  let artifact;
  try {
    artifact = resolveArtifact(options);
  } catch (error) {
    const code = error instanceof ArtifactUnavailableError ? error.code : 'CAPABILITY_INDEX_UNAVAILABLE';
    return Object.freeze({
      text: `The ToolsEnabled capability index could not be consulted (${code}). ${error.message} `
        + 'This is NOT a finding that no tool exists for this -- nothing was searched.',
      tools: [], outcome: 'unavailable', code, estimatedTokens: 0, durationMs: 0,
    });
  }

  const limit = Number.isInteger(options.limit) ? options.limit : QUERY_LIMIT;
  const floor = typeof options.floor === 'number' ? options.floor : artifact.constants.floorQuery;
  const ranked = rank(artifact, queryText, {
    floor,
    limit,
    allowedIds: options.allowedIds,
    constants: options.constants,
  });
  const documents = documentsFor(artifact, ranked.results);
  const searchedCount = options.allowedIds instanceof Set
    ? artifact.docs.filter(document => options.allowedIds.has(document.id)).length
    : artifact.N;
  const composed = composeQuery(documents, {
    query: String(queryText || '').slice(0, 120),
    corpusSize: artifact.N,
    searchedCount,
    bestRejected: ranked.bestRejected,
    floor,
    budgetTokens: options.budgetTokens || QUERY_BUDGET_TOKENS,
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  observe(options, {
    mode: 'query',
    termCount: ranked.query.terms.length,
    candidateCount: ranked.candidates.length,
    returned: ranked.results.map(result => ({ id: result.id, score: Number(result.score.toFixed(4)) })),
    belowFloor: ranked.belowFloor,
    durationMs,
  });

  return Object.freeze({
    text: composed.text,
    tools: ranked.results.map((result, position) => ({
      id: result.id,
      score: result.score,
      phrase: result.phrase,
      matchedWords: result.matchedWords,
      clause: documents[position].clause,
      effect: documents[position].effect,
      readOnly: documents[position].ro,
    })),
    outcome: composed.outcome,
    code: null,
    estimatedTokens: composed.estimatedTokens,
    detailLevel: composed.detailLevel,
    overBudget: composed.overBudget,
    floor,
    corpusSize: artifact.N,
    searchedCount,
    bestRejected: ranked.bestRejected,
    durationMs,
  });
}

module.exports = Object.freeze({
  AUTO_LIMIT,
  CAPABILITY_RECALL_SETTING_ID,
  QUERY_LIMIT,
  allowedIdsForTier,
  capabilityRecallEnabled,
  find,
  recommend,
});

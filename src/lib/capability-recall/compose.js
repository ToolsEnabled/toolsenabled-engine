'use strict';

// WHAT THE AGENT ACTUALLY READS.
//
// Two renderers, two budgets, one rule: the note is a MAP, never an
// instruction. It says "these exist and may fit"; it never says "use these".
// An agent told to use a tool will use it, and a recommender that can compel a
// tool call is a recommender that can be wrong expensively.
//
// THE BUDGET IS A CONTRACT, NOT AN ASPIRATION -- the phrasing and the mechanism
// are both taken from src/lib/agent-tool-summary.js, which shipped this
// discipline first. Over budget, DETAIL is shed in a fixed order and never a
// whole result: a tool dropped to save tokens is an agent taught the capability
// does not exist. If even the barest composition is over, it is returned over
// budget and says so, because a silently truncated note is worse than a long one.
//
// Token estimate is four characters to a token, the same crude ratio
// agent-tool-summary.js uses. It is crude on purpose: an estimator that needs a
// tokenizer would be a dependency, and this only has to be right enough to
// decide which of four compositions to send.

const AUTO_BUDGET_TOKENS = 120;
const QUERY_BUDGET_TOKENS = 500;

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function clip(text, maximum) {
  const value = String(text || '').trim();
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function annotationTag(document) {
  const parts = [];
  if (document.ro) parts.push('read-only');
  if (document.destructive) parts.push('hard to undo');
  if (document.ext) parts.push('reaches outside this machine');
  return parts.length ? ` [${parts.join(', ')}]` : '';
}

function parameterLine(document) {
  if (!document.params || document.params.length === 0) return 'no inputs';
  return document.params.map(parameter => (parameter.required ? `${parameter.name}*` : parameter.name)).join(', ');
}

/* ---------------------------------------------------------------- auto mode */

const AUTO_HEADER = 'ToolsEnabled tools on this computer that may fit what was just asked. '
  + 'Call one by its exact id if it helps, or ignore them:';
const AUTO_HEADER_SHORT = 'ToolsEnabled tools that may fit, by exact id:';

/**
 * The block that rides a turn. Empty string when there is nothing worth saying.
 *
 * Levels shed detail in this order:
 *   2  full header, id + clause
 *   1  full header, id + clipped clause
 *   0  short header, id + clipped clause
 *  -1  short header, ids only
 */
function composeAuto(documents, { budgetTokens = AUTO_BUDGET_TOKENS } = {}) {
  if (!documents.length) return { text: '', estimatedTokens: 0, detailLevel: null, overBudget: false };

  for (const level of [2, 1, 0, -1]) {
    const header = level >= 1 ? AUTO_HEADER : AUTO_HEADER_SHORT;
    const lines = documents.map(document => {
      if (level <= -1) return `- ${document.id}`;
      const clause = level >= 2 ? document.clause : clip(document.clause, 72);
      return clause ? `- ${document.id} — ${clause}` : `- ${document.id}`;
    });
    const text = [header, ...lines].join('\n');
    const tokens = estimateTokens(text);
    if (tokens <= budgetTokens || level === -1) {
      return { text, estimatedTokens: tokens, detailLevel: level, overBudget: tokens > budgetTokens };
    }
  }
  /* istanbul ignore next -- the loop always returns at level -1. */
  return { text: '', estimatedTokens: 0, detailLevel: null, overBudget: false };
}

/* --------------------------------------------------------------- query mode */

const QUERY_TRUST = 'These are a map, not authority: read the tool\'s own schema before calling it.';

/**
 * The answer to an explicit "what can help me with X".
 *
 * Unlike the auto block, this ALWAYS says something -- an agent that asked a
 * question is owed an answer, and "nothing matched" is one. The three shapes
 * are kept apart on purpose, following tools/retrieval/index.js: a genuine gap
 * and a near-miss held back by the floor are different claims, and collapsing
 * them into "no results" is the absence-read-as-consent failure this codebase
 * has hit repeatedly.
 */
function composeQuery(documents, context) {
  const { query, corpusSize, searchedCount, bestRejected, floor, budgetTokens = QUERY_BUDGET_TOKENS } = context;

  const hasMeasuredSearch = Number.isInteger(corpusSize) && corpusSize >= 0
    && Number.isInteger(searchedCount) && searchedCount >= 0 && searchedCount <= corpusSize;
  if (!hasMeasuredSearch || searchedCount === 0) {
    const measured = hasMeasuredSearch
      ? `zero of ${corpusSize} tools were available to search at this permission level`
      : 'the number of tools searched was not measured reliably';
    const text = `The ToolsEnabled catalogue could not establish an answer for "${query}" because ${measured}. `
      + 'This is NOT a finding that no matching tool exists.';
    return {
      text,
      estimatedTokens: estimateTokens(text),
      detailLevel: null,
      overBudget: false,
      outcome: 'unavailable',
    };
  }

  if (!documents.length) {
    const searchScope = searchedCount === corpusSize
      ? `All ${corpusSize} tools were searched`
      : `All ${searchedCount} tools offered at this permission level were searched (${corpusSize} in the catalogue)`;
    const text = bestRejected
      ? `No ToolsEnabled tool matched "${query}" well enough to name. ${searchScope}; the closest, `
        + `${bestRejected.id}, scored ${bestRejected.score.toFixed(2)} against a floor of ${floor.toFixed(2)}. `
        + 'It is withheld rather than returned, because a confidently wrong tool costs more than none. '
        + 'Try naming the thing you want to act on rather than the action.'
      : `No ToolsEnabled tool matched "${query}". ${searchScope} by id, description and everyday `
        + 'wording, and none of the words in that question appears in the catalogue. This is a genuine gap, not an '
        + 'unread index.';
    return { text, estimatedTokens: estimateTokens(text), detailLevel: null, overBudget: false, outcome: 'miss' };
  }

  for (const level of [2, 1, 0]) {
    const header = `ToolsEnabled tools for "${query}" — ${searchedCount} of ${corpusSize} searched`
      + `${searchedCount !== corpusSize ? ' (restricted to those offered at this permission level)' : ''}`
      + `; ${documents.length} returned:`;
    const lines = documents.map(document => {
      const tag = annotationTag(document);
      if (level <= 0) return `- ${document.id}${tag} — ${clip(document.clause, 70)}`;
      const body = level >= 2 ? document.summary || document.clause : document.clause;
      return `- ${document.id}${tag} — ${clip(body, level >= 2 ? 240 : 120)}\n  inputs: ${parameterLine(document)}`;
    });
    const text = [header, ...lines, QUERY_TRUST].join('\n');
    const tokens = estimateTokens(text);
    if (tokens <= budgetTokens || level === 0) {
      return { text, estimatedTokens: tokens, detailLevel: level, overBudget: tokens > budgetTokens, outcome: 'hit' };
    }
  }
  /* istanbul ignore next -- the loop always returns at level 0. */
  return { text: '', estimatedTokens: 0, detailLevel: null, overBudget: false, outcome: 'hit' };
}

module.exports = Object.freeze({
  AUTO_BUDGET_TOKENS,
  AUTO_HEADER,
  AUTO_HEADER_SHORT,
  QUERY_BUDGET_TOKENS,
  QUERY_TRUST,
  annotationTag,
  clip,
  composeAuto,
  composeQuery,
  estimateTokens,
  parameterLine,
});

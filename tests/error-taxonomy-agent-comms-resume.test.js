'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const taxonomy = require('../src/lib/error-taxonomy');
const { StateStoreError } = require('../src/lib/state-store');
const { toolError } = require('../src/mcp-server');

const BACKLOG_CODE = 'FABRIC_RECIPIENT_BACKLOG_FULL';
const BACKLOG_SENTENCE = 'That agent has not yet read the messages already waiting for it, so this one cannot be queued without discarding one it has never seen. Nothing was lost; send it again once the agent has caught up.';
const ACCOUNT_LIMIT_CODE = 'AGENT_RESUME_ACCOUNT_LIMIT';
const ACCOUNT_LIMIT_SENTENCES = Object.freeze([
  'The provider has refused this saved conversation’s account: its allowance is spent. Wait for it to reset, or continue on another account with a new session.',
  'The saved conversation account cannot serve right now, and this copy could not tell whether the provider or a limit on the Accounts page refused it. Check that account on the Accounts page, or continue on another account with a new session.'
]);

function sourceError(code, message) {
  return Object.assign(new Error(message), { code });
}

test('a full recipient backlog remains retryable and keeps its actionable source sentence', () => {
  const source = sourceError(BACKLOG_CODE, BACKLOG_SENTENCE);
  const failure = taxonomy.publicFailure(taxonomy.adaptProviderError(source));

  assert.equal(failure.code, 'UNAVAILABLE');
  assert.equal(failure.classification, 'retry-after-time');
  assert.equal(failure.retryable, true);
  assert.equal(failure.retryAfterMs, 5_000);
  assert.equal(taxonomy.decideRetry(failure, { attempt: 1, effect: 'local-read' }).disposition, 'retry');

  const result = toolError(source);
  assert.equal(result.structuredContent.error.message, BACKLOG_SENTENCE);
  assert.equal(result.structuredContent.error.code, BACKLOG_CODE);
  assert.equal(result.structuredContent.error.taxonomy.code, 'UNAVAILABLE');
  assert.equal(result.content[0].text, BACKLOG_SENTENCE);
});

test('each account resume limit sentence remains actionable and non-retryable', () => {
  assert.equal(ACCOUNT_LIMIT_SENTENCES.length, 2);
  for (const sentence of ACCOUNT_LIMIT_SENTENCES) {
    const source = sourceError(ACCOUNT_LIMIT_CODE, sentence);
    const failure = taxonomy.publicFailure(taxonomy.adaptProviderError(source));

    assert.equal(failure.code, 'INPUT_REQUIRED');
    assert.equal(failure.classification, 'retry-after-input');
    assert.equal(failure.retryable, false);
    assert.equal(Object.hasOwn(failure, 'retryAfterMs'), false);
    assert.equal(taxonomy.decideRetry(failure, { attempt: 1, effect: 'local-read' }).disposition, 'blocked');

    const result = toolError(source);
    assert.equal(result.structuredContent.error.message, sentence);
    assert.equal(result.structuredContent.error.code, ACCOUNT_LIMIT_CODE);
    assert.equal(result.structuredContent.error.taxonomy.code, 'INPUT_REQUIRED');
    assert.equal(result.content[0].text, sentence);
    assert.notEqual(result.content[0].text, 'The operation stopped safely because of an internal error.');
  }
});

test('arbitrary prose and unknown source-code variants stay fail-closed', () => {
  const hostile = 'private arbitrary provider prose must never cross this boundary';
  const known = [
    [BACKLOG_CODE, 'UNAVAILABLE'],
    [ACCOUNT_LIMIT_CODE, 'INPUT_REQUIRED']
  ];
  for (const [code, expected] of known) {
    const result = toolError(sourceError(code, hostile));
    assert.equal(result.structuredContent.error.taxonomy.code, expected);
    assert.equal(result.structuredContent.error.message,
      result.structuredContent.error.taxonomy.safeSummary);
    assert.equal(result.content[0].text, result.structuredContent.error.taxonomy.safeSummary);
    assert.doesNotMatch(JSON.stringify(result), /private arbitrary provider prose/);
  }

  const boundedSentences = [
    [BACKLOG_CODE, BACKLOG_SENTENCE, 'UNAVAILABLE'],
    ...ACCOUNT_LIMIT_SENTENCES.map(sentence => [ACCOUNT_LIMIT_CODE, sentence, 'INPUT_REQUIRED'])
  ];
  for (const [code, sentence, expected] of boundedSentences) {
    const taintedMessage = sentence + ' ' + hostile;
    const result = toolError(sourceError(code, taintedMessage));
    const serialized = JSON.stringify(result);
    assert.equal(result.structuredContent.error.taxonomy.code, expected, code);
    assert.equal(result.structuredContent.error.message,
      result.structuredContent.error.taxonomy.safeSummary, code);
    assert.equal(result.content[0].text, result.structuredContent.error.taxonomy.safeSummary, code);
    assert.equal(serialized.includes(hostile), false, code);
    assert.equal(serialized.includes(taintedMessage), false, code);
  }

  for (const [code, sentence, expected] of boundedSentences) {
    const tainted = new StateStoreError(code, sentence + ' ' + hostile, {
      prose: hostile,
      nested: { prose: hostile }
    });
    const result = toolError(tainted);
    const serialized = JSON.stringify(result);
    assert.equal(result.structuredContent.error.taxonomy.code, expected, code);
    assert.equal(result.structuredContent.error.message,
      result.structuredContent.error.taxonomy.safeSummary, code);
    assert.equal(result.content[0].text, result.structuredContent.error.taxonomy.safeSummary, code);
    assert.equal(serialized.includes(hostile), false, code);
  }

  const unknownCodes = [
    'FABRIC_RECIPIENT_BACKLOG_FULL_SUFFIX',
    'AGENT_RESUME_ACCOUNT_LIMIT_SUFFIX',
    'AGENT_RESUME_ACCOUNT_LIM',
  ];
  for (const code of unknownCodes) {
    const result = toolError(sourceError(code, hostile));
    assert.equal(result.structuredContent.error.taxonomy.code, 'INTERNAL_ERROR', code);
    assert.equal(result.content[0].text, result.structuredContent.error.taxonomy.safeSummary, code);
    assert.doesNotMatch(JSON.stringify(result), /private arbitrary provider prose/, code);
  }

  const proseOnly = toolError(new Error(BACKLOG_CODE + ': ' + hostile));
  assert.equal(proseOnly.structuredContent.error.taxonomy.code, 'INTERNAL_ERROR');
  assert.equal(proseOnly.content[0].text, proseOnly.structuredContent.error.taxonomy.safeSummary);
  assert.doesNotMatch(JSON.stringify(proseOnly), /private arbitrary provider prose/);
});

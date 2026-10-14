'use strict';
/* B38 (the 1.0.48 soak, tree-child-codex): a helper started while the
 * Computers page re-renders is left "not started yet", and the agent that asked
 * for it reads "The operation stopped safely because of an internal error."
 *
 * The application answers such a start MC_TREE_COMMAND_START_FAILED (and, from
 * the 1.0.49 app on, MC_TREE_COMMAND_VIEW_DESTROYED when its page was rebuilt
 * under the start). No word of either code matched the taxonomy's ladder, so
 * both classified INTERNAL_ERROR -- terminal, and its message withheld. A start
 * that did not happen is a retry, and the agent has to be told so in words
 * that fit it, with the application's reason when it gave one.
 *
 *   node --test tests/b38-tree-start-failed-retryable.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const taxonomy = require('../src/lib/error-taxonomy.js');
const { toolError } = require('../src/mcp-server.js');

const INTERNAL = 'The operation stopped safely because of an internal error.';
const refusal = (code, message) => Object.assign(new Error(message), { code });

test('a tree circle whose agent did not start is retryable, not an internal error', () => {
  for (const code of ['MC_TREE_COMMAND_START_FAILED', 'MC_TREE_COMMAND_VIEW_DESTROYED']) {
    const failure = taxonomy.publicFailure(refusal(code, 'x'));
    assert.equal(failure.code, 'UNAVAILABLE', code);
    assert.equal(failure.retryable, true, code);
    assert.equal(failure.classification, 'retry-after-time', code);
    assert.equal(taxonomy.decideRetry(failure).disposition, 'retry', `${code}: one more attempt is the honest advice`);
  }
});

test('only those exact codes move; their neighbours keep the classification they had', () => {
  assert.equal(taxonomy.publicFailure({ code: 'MC_TREE_COMMAND_STOP_FAILED' }).code, 'INTERNAL_ERROR',
    'an unclassified cleanup failure is still not evidence of anything');
  for (const code of ['MC_TREE_COMMAND_START_FAILED_LATER', 'OTHER_MC_TREE_COMMAND_START_FAILED', 'MC_TREE_COMMAND_VIEW_DESTROYED_TWICE']) {
    assert.equal(taxonomy.publicFailure({ code }).code, 'INTERNAL_ERROR', code);
    assert.equal(taxonomy.retryableSourceSentence({ code }), null, code);
  }
  for (const code of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(taxonomy.retryableSourceSentence({ code }), null, `${code}: an inherited name is never a sentence`);
  }
});

test('a failed start reaches the agent as a named sentence carrying the application\'s reason', () => {
  const appLine = 'The application could not add that assistant to the tree (MC_TREE_COMMAND_START_FAILED). You’ve hit your weekly limit · resets Oct 1, 12am';
  const result = JSON.parse(JSON.stringify(toolError(refusal('MC_TREE_COMMAND_START_FAILED', appLine))));
  const text = result.content[0].text;
  assert.notEqual(text, INTERNAL);
  assert.match(text, /^The circle is on the tree, but its agent did not start, so nothing is running there yet\./);
  assert.match(text, /send the same request once more/);
  assert.ok(text.endsWith(`The application said: ${appLine}`), `the reason must reach the agent: ${text}`);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'MC_TREE_COMMAND_START_FAILED');
  assert.equal(result.structuredContent.error.taxonomy.code, 'UNAVAILABLE');
  assert.equal(result.structuredContent.error.taxonomy.retryable, true);
});

test('the application\'s words are redacted before they are appended, and absent words add nothing', () => {
  const leaky = toolError(refusal('MC_TREE_COMMAND_START_FAILED', 'Start refused: api_key=abc123-private-value'));
  assert.doesNotMatch(leaky.content[0].text, /abc123-private-value/);
  assert.match(leaky.content[0].text, /api_key=REDACTED/);
  const bare = toolError(refusal('MC_TREE_COMMAND_START_FAILED', ''));
  assert.doesNotMatch(bare.content[0].text, /The application said/);
});

test('a page rebuilt under the start says so, and only in the engine\'s own words', () => {
  const appLine = 'The page this circle is on rebuilt itself while the command was still waiting to be answered, so nothing was done.';
  const result = toolError(refusal('MC_TREE_COMMAND_VIEW_DESTROYED', appLine));
  assert.equal(result.content[0].text,
    'The Computers page was rebuilt while this request was being carried out, so nothing was started. Nothing was refused: send the same request again.');
  assert.equal(result.structuredContent.error.taxonomy.retryable, true);
});

test('through agent.spawn\'s own seam: the host\'s rejection keeps its code all the way to the text', async () => {
  const tree = require('../src/lib/agent-tree-spawn');
  const appLine = 'The application could not add that assistant to the tree (MC_TREE_COMMAND_START_FAILED).';
  tree.installTreeSpawnHost({ isTreeSession: () => true, async spawn() { throw refusal('MC_TREE_COMMAND_START_FAILED', appLine); } });
  try {
    let caught;
    try { await tree.spawnOnTree({ parentSessionId: 'parent-session', tier: 'luna', brief: 'x' }); }
    catch (error) { caught = error; }
    assert.equal(caught?.code, 'MC_TREE_COMMAND_START_FAILED');
    const text = toolError(caught).content[0].text;
    assert.notEqual(text, INTERNAL);
    assert.match(text, /its agent did not start/);
  } finally {
    tree.clearTreeSpawnHost();
  }
});

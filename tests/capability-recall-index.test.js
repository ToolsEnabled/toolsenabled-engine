/* Mutation check (2026-08-27):
 * Changed `const AUTO_LIMIT = 3;` to `const AUTO_LIMIT = 4;` in the required module.
 * The edit landed: yes (the mutated line was printed and verified).
 * This isolated test went red: yes (exit code 1; expected 3 but received 4).
 */

'use strict';

const assert = require('node:assert/strict');

const {
  AUTO_LIMIT,
  CAPABILITY_RECALL_SETTING_ID,
  QUERY_LIMIT,
  find,
  recommend,
} = require('../src/lib/capability-recall');

assert.equal(AUTO_LIMIT, 3);
assert.equal(QUERY_LIMIT, 10);
assert.equal(CAPABILITY_RECALL_SETTING_ID, 'agent.capability_recall');

const disabled = recommend('take a picture of what is on my screen', {
  enabled: false,
  artifactPath: '/this/path/must/not/be-opened.json',
});
assert.deepEqual(
  {
    outcome: disabled.outcome,
    code: disabled.code,
    text: disabled.text,
    tools: disabled.tools,
  },
  {
    outcome: 'disabled',
    code: 'CAPABILITY_RECALL_DISABLED',
    text: '',
    tools: [],
  },
  'disabling recall must short-circuit before attempting to load an artifact'
);
assert.ok(Object.isFrozen(disabled), 'recommend() results must be immutable');

const recommendation = recommend('take a picture of what is on my screen', {
  enabled: true,
  allowedIds: new Set(['screen.capture']),
});
assert.equal(recommendation.outcome, 'hit');
assert.deepEqual(recommendation.tools.map(tool => tool.id), ['screen.capture']);
assert.match(recommendation.text, /screen\.capture/);
assert.equal(recommendation.code, null);

const silence = recommend('hi', { enabled: true });
assert.equal(silence.outcome, 'silent');
assert.equal(silence.text, '');
assert.deepEqual(silence.tools, []);
assert.match(silence.why, /no tool matched/);

const found = find('I need to get a file from the other computer', {
  allowedIds: new Set(['workspace.read']),
});
assert.equal(found.outcome, 'hit');
assert.deepEqual(found.tools.map(tool => tool.id), ['workspace.read']);
assert.equal(found.tools[0].readOnly, true);
assert.match(found.text, /workspace\.read \[read-only\]/);
assert.equal(found.searchedCount, 1);
assert.equal(found.code, null);
assert.ok(Object.isFrozen(found), 'find() results must be immutable');

// These existing orchestration tools were absent from the shipped index even
// though the runtime registry still exposed them. Exercise ordinary requests
// against the entire real index, including competition from unrelated tools.
for (const [query, expected] of [
  ['spawn a subagent', 'agent.spawn'],
  ['stop an agent', 'agent.stop'],
  ['restart an agent', 'agent.restart'],
  ['remove an agent', 'agent.remove'],
  ['add an item to the build queue', 'build_queue.open'],
  ['claim an item from the build queue', 'build_queue.claim'],
  ['close an item in the build queue', 'build_queue.close'],
]) {
  const result = find(query);
  assert.equal(result.outcome, 'hit', `the shipped index must find ${expected} for ${JSON.stringify(query)}`);
  assert.equal(result.tools[0]?.id, expected, `the requested orchestration tool must rank first for ${JSON.stringify(query)}`);
}

console.log('capability-recall-index: assertions passed');

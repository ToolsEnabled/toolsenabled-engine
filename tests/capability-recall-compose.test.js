/* Mutation check:
 * Changed estimateTokens from Math.ceil(text.length / 4) to Math.floor(text.length / 4).
 * The edit landed in src/lib/capability-recall/compose.js and changed its SHA-256.
 * This isolated test went red with exit code 1 on the rounding-up assertion.
 * The module was then restored to its original SHA-256.
 */
'use strict';

const assert = require('node:assert/strict');

const {
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
} = require('../src/lib/capability-recall/compose');

assert.equal(AUTO_BUDGET_TOKENS, 120);
assert.equal(QUERY_BUDGET_TOKENS, 500);
assert.equal(estimateTokens('12345'), 2, 'token estimates round character quarters up');
assert.equal(clip('  abcdef  ', 5), 'abcd…', 'long text is trimmed and ellipsized to the limit');
assert.equal(clip('  abc  ', 5), 'abc', 'short text is trimmed without an ellipsis');
assert.equal(annotationTag({ ro: true, destructive: true, ext: true }),
  ' [read-only, hard to undo, reaches outside this machine]');
assert.equal(annotationTag({}), '');
assert.equal(parameterLine({ params: [] }), 'no inputs');
assert.equal(parameterLine({ params: [{ name: 'path', required: true }, { name: 'limit', required: false }] }),
  'path*, limit');

assert.deepEqual(composeAuto([]), {
  text: '', estimatedTokens: 0, detailLevel: null, overBudget: false,
});

const autoDocument = { id: 'screen.capture', clause: 'Capture the currently visible screen.' };
const fullAuto = composeAuto([autoDocument]);
assert.equal(fullAuto.text, `${AUTO_HEADER}\n- screen.capture — Capture the currently visible screen.`);
assert.equal(fullAuto.detailLevel, 2);
assert.equal(fullAuto.estimatedTokens, estimateTokens(fullAuto.text));
assert.equal(fullAuto.overBudget, false);

const minimalAuto = composeAuto([autoDocument], { budgetTokens: 1 });
assert.equal(minimalAuto.text, `${AUTO_HEADER_SHORT}\n- screen.capture`);
assert.equal(minimalAuto.detailLevel, -1, 'auto composition retains every tool id when detail cannot fit');
assert.equal(minimalAuto.overBudget, true, 'the irreducible auto composition reports its budget overflow');

const unavailable = composeQuery([], {
  query: 'take a screenshot', corpusSize: 4, searchedCount: 0, floor: 0.5,
});
assert.equal(unavailable.outcome, 'unavailable');
assert.match(unavailable.text, /zero of 4 tools were available to search/);
assert.match(unavailable.text, /NOT a finding that no matching tool exists/);

const rejected = composeQuery([], {
  query: 'take a screenshot', corpusSize: 4, searchedCount: 4,
  bestRejected: { id: 'screen.capture', score: 0.42 }, floor: 0.5,
});
assert.equal(rejected.outcome, 'miss');
assert.match(rejected.text, /screen\.capture, scored 0\.42 against a floor of 0\.50/);
assert.match(rejected.text, /withheld rather than returned/);

const queryDocument = {
  id: 'files.remove',
  clause: 'Remove a file.',
  summary: 'Remove a file from remote storage.',
  ro: true,
  destructive: true,
  ext: true,
  params: [{ name: 'path', required: true }, { name: 'force', required: false }],
};
const hit = composeQuery([queryDocument], {
  query: 'remove the backup', corpusSize: 10, searchedCount: 7, floor: 0.5,
});
assert.equal(hit.outcome, 'hit');
assert.equal(hit.detailLevel, 2);
assert.match(hit.text, /7 of 10 searched \(restricted to those offered at this permission level\)/);
assert.match(hit.text, /files\.remove \[read-only, hard to undo, reaches outside this machine\] — Remove a file from remote storage\./);
assert.match(hit.text, /inputs: path\*, force/);
assert.ok(hit.text.endsWith(QUERY_TRUST));
assert.equal(hit.estimatedTokens, estimateTokens(hit.text));

const compactHit = composeQuery([queryDocument], {
  query: 'remove the backup', corpusSize: 10, searchedCount: 10, floor: 0.5, budgetTokens: 1,
});
assert.equal(compactHit.detailLevel, 0);
assert.equal(compactHit.overBudget, true);
assert.doesNotMatch(compactHit.text, /inputs:/, 'compact query composition sheds parameter detail');
assert.match(compactHit.text, /files\.remove \[read-only, hard to undo, reaches outside this machine\]/);

console.log('capability-recall-compose: behaviour assertions passed');

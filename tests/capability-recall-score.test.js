'use strict';

// Behavioural coverage for the public surface of capability-recall/score.
// Run alone with: node tests/capability-recall-score.test.js

const assert = require('node:assert/strict');

const {
  DEFAULT_K1,
  FIELDS,
  detectActions,
  idfOf,
  prepareQuery,
} = require('../src/lib/capability-recall/score');

assert.equal(DEFAULT_K1, 1.2, 'the scorer exposes its BM25 saturation default');
assert.deepEqual(FIELDS, ['identity', 'title', 'body', 'alias'], 'BM25F searches all four documented fields');
assert.equal(Object.isFrozen(FIELDS), true, 'callers cannot mutate the scorer field list');

assert.equal(
  idfOf(10, 1),
  Math.log(1 + 9.5 / 1.5),
  'idfOf applies the BM25 inverse-document-frequency formula',
);
assert.ok(idfOf(10, 1) > idfOf(10, 5), 'rarer terms carry more evidence');

const prepared = prepareQuery('Capture captures capture', { stemDiscount: 0.4 });
assert.deepEqual(prepared.rawWords, ['capture', 'captures'], 'raw query words are normalized and deduplicated');
assert.equal(prepared.phrase, 'capture captures capture', 'phrase matching receives normalized input');
assert.deepEqual(
  prepared.terms,
  [
    { term: 'capture', word: 'capture', multiplier: 1 },
    { term: '~captur', word: 'captur', multiplier: 0.4 },
    { term: 'captures', word: 'captures', multiplier: 1 },
  ],
  'query preparation keeps exact terms and discounts generated stems',
);

const actionByWord = {
  show: ['read'],
  send: ['write'],
  share: ['write'],
};
assert.deepEqual(
  detectActions(['show', 'send', 'share'], actionByWord),
  new Set(['write']),
  'the action with the most vocabulary votes wins',
);
assert.deepEqual(
  detectActions(['show', 'send'], actionByWord),
  new Set(['read', 'write']),
  'equally supported actions are preserved rather than arbitrarily narrowed',
);
assert.equal(detectActions(['unknown'], actionByWord), null, 'no action is invented without a vote');
assert.equal(detectActions(['show'], null), null, 'action detection can be disabled by omitting its vocabulary');

process.stdout.write('capability-recall score behaviour: ok\n');

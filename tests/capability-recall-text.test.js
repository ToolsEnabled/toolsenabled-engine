/* Mutation check:
 * Module edit: `return [...expand(text).keys()];` -> `return [...expand(text).keys()].reverse();`.
 * Landed: yes; the replacement was printed from the module before the run.
 * Result: RED; this file exited 1 on the first-seen-order assertion.
 * Restore: confirmed against the module's original SHA-256.
 */
'use strict';

// Behavioural coverage for src/lib/capability-recall/text.js. Run alone with:
//   node tests/capability-recall-text.test.js

const assert = require('node:assert/strict');
const {
  CORPUS_COMMON,
  STOPWORDS,
  TOKENIZER_VERSION,
  corpusCommon,
  expand,
  normalizePhrase,
  stem,
  tokenize,
  words,
} = require('../src/lib/capability-recall/text');

let checks = 0;
function check(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  checks += 1;
}

check('the artifact compatibility version is stable', TOKENIZER_VERSION, 'capability-tokenizer-v1');
check('the exported stopword set contains query filler', STOPWORDS.has('how'), true);
check('the exported common-term set identifies corpus vocabulary', CORPUS_COMMON.has('tool'), true);

check(
  'words splits identifier boundaries and filters stopwords, one-letter words, and numbers',
  words('How do HTTPServer.captureWindow_v2 and X use 123 screenshots?'),
  ['server', 'capture', 'window', 'v2', 'use', 'screenshots']
);
check('words safely coerces non-string and null input', [words(420), words(null)], [[], []]);

check(
  'stem handles composed plurals, inflected verbs, and protected base words',
  ['settings', 'running', 'captured', 'capture', 'access'].map(stem),
  ['setting', 'run', 'captur', 'captur', 'access']
);

check(
  'expand counts both exact and morphological terms, including unchanged stems',
  [...expand('capture captures capture').entries()],
  [['capture', 2], ['~captur', 3], ['captures', 1]]
);
check(
  'tokenize de-duplicates terms while preserving first-seen order',
  tokenize('Running agents run agents'),
  ['running', '~run', 'agents', '~agent', 'run']
);

check('corpusCommon accepts exact and stem-space common terms',
  [corpusCommon('write'), corpusCommon('~tools'), corpusCommon('screenshot')],
  [true, true, false]);
check('normalizePhrase lowercases and single-spaces punctuation-delimited text',
  normalizePhrase('  Screen.Capture_WINDOW -- V2!  '),
  'screen capture window v2');
check('normalizePhrase safely handles null', normalizePhrase(null), '');

process.stdout.write(`PASS capability-recall text behaviour (${checks} checks)\n`);

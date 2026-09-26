// Mutation check (module SHA-256: ea2529c623d6e031e5dddf5bb30eb8903bf12f30291777e3717c8aa47b0aabbe):
// Changed the first interrogative grammar action from 'read' to 'create'.
// The edit landed: yes (the mutated module differed from the saved original).
// This isolated test went red: yes (exit 1; expected { read: 2 }).
// The module was restored and its SHA-256 matched the value above.

'use strict';

const assert = require('node:assert/strict');
const { GRAMMAR, grammarVotes } = require('../src/lib/capability-recall/grammar');

function votes(value) {
  return Object.fromEntries(grammarVotes(value));
}

assert.ok(Object.isFrozen(GRAMMAR), 'the exported grammar collection must be immutable');
assert.ok(GRAMMAR.every(entry => entry[0] instanceof RegExp && typeof entry[1] === 'string'),
  'every exported grammar entry must pair a regular expression with an action');

assert.deepEqual(votes('What is there?'), { read: 2 },
  'each matching read construction should contribute its own vote');
assert.deepEqual(votes('SHOW ME what is there and let her know'), { read: 3, send: 1 },
  'grammarVotes should normalize case and retain votes for multiple actions');
assert.deepEqual(votes('Please get rid of that, then set up a replacement and kick off the job.'),
  { remove: 1, create: 1, run: 1 },
  'multi-word verbs should map to their intended actions');
assert.deepEqual(votes('showcase the setup'), {},
  'word boundaries should prevent partial words from producing votes');
assert.deepEqual(votes(null), {}, 'null should be treated as empty text');
assert.deepEqual(votes({ toString: () => 'pull up anything' }), { read: 2 },
  'non-string input should be converted to text before matching');

console.log('capability-recall grammar behaviour: PASS');

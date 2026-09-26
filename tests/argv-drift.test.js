// Mutation record (2026-08-27): in src/lib/argv-drift.js, replaced the
// whitespace branch's `if (started) { tokens.push(...) }` with an unconditional
// `{ tokens.push(...) }`, making repeated trailing whitespace emit empty tokens.
// The edit landed (confirmed by exact-source match and a changed SHA-256).
// This file initially stayed green; the behavioural assertion below was added.
// With that same mutation it then went red, and with the module restored it is green.
'use strict';
require('./surface.policy/argv-drift.test.js');

const assert = require('node:assert/strict');
const drift = require('../src/lib/argv-drift.js');

assert.deepEqual(
  drift.tokenizeCommandLine('node a.js --serve  '),
  ['node', 'a.js', '--serve'],
  'repeated trailing whitespace must not produce empty argv tokens'
);

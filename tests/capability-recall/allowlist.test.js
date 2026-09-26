/* Mutation check:
 * Changed the unknown-tier refusal branch in allowlist.js from `return null`
 * to `return new Set()`.
 * The mutation landed, and this file went red on its unknown-tier assertion.
 */
'use strict';

const assert = require('node:assert/strict');
const { allowedIdsForTier } = require('../../src/lib/capability-recall/allowlist');

const guided = allowedIdsForTier('guided');
const standard = allowedIdsForTier('standard');
const unrestricted = allowedIdsForTier('unrestricted');

assert.ok(guided instanceof Set && guided.size > 0,
  'guided must resolve to a populated Set of callable tool ids');
assert.ok(standard instanceof Set && standard.size > guided.size,
  'standard must expose a populated surface wider than guided');
assert.ok(unrestricted instanceof Set && unrestricted.size > standard.size,
  'unrestricted must expose a populated surface wider than standard');

assert.equal(guided.has('screen.capture'), false,
  'guided must withhold screen capture');
assert.equal(standard.has('screen.capture'), true,
  'standard must allow screen capture');
assert.equal(standard.has('host.exec'), false,
  'standard must withhold unrestricted host command execution');
assert.equal(unrestricted.has('host.exec'), true,
  'unrestricted must allow host command execution');

assert.equal(allowedIdsForTier('not-a-real-tier'), null,
  'an unknown tier must be reported as absent, not as an empty or widened allowlist');

console.log('capability-recall allowlist behavior tests passed');

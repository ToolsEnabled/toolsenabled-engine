'use strict';

const assert = require('node:assert/strict');

const { isPlausibleRelativePath } = require('../src/lib/fleet-supervisor/planning.js');

// Planner-provided paths cross a trust boundary before they are used to build
// lane briefs. Exercise the public predicate with concrete values so directory
// traversal cannot become an accepted repo-relative file path.
assert.equal(
  isPlausibleRelativePath('src/lib/fleet-supervisor/planning.js'),
  true,
  'a nested repository file is a plausible planner path'
);
assert.equal(
  isPlausibleRelativePath('src/lib/../secrets.json'),
  false,
  'a planner path containing a parent-directory segment is rejected'
);
assert.equal(
  isPlausibleRelativePath('../outside.json'),
  false,
  'a planner path cannot escape from the repository root'
);

console.log('fleet-supervisor planning path tests passed (3 checks)');

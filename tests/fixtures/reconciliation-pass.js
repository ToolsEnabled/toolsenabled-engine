#!/usr/bin/env node
'use strict';

// Fixture for tests/test-run-reconciliation.test.js. Lives under fixtures/ so
// tools/test-census.js excludes it from the candidate set: a fixture that
// counted as a test would inflate the very census this suite exists to keep
// honest. Exits 0, deliberately trivially.
process.exitCode = 0;

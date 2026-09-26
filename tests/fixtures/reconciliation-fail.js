#!/usr/bin/env node
'use strict';

// Fixture for tests/test-run-reconciliation.test.js. Exits nonzero on purpose
// so the suite can drive the runner's fail-fast path against a known answer.
// Exit 3 rather than 1 so the assertion proves the real child exit code is
// carried through rather than a generic failure being substituted.
process.exitCode = 3;

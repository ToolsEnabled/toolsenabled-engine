// EXECUTABLE CHANGE
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

require('./desktop.browser/playwright-gateway.js');

// The delegated suite only checked the resolved npx executable inside a
// Windows-and-cache conditional.  On every other resolution path those
// assertions could not execute.  Exercise the resolver on this platform and
// require each advertised source to have the corresponding independently
// known executable shape.
const { resolveNpxInvocation } = require('../src/playwright-gateway');
const npxInvocation = resolveNpxInvocation('@playwright/mcp@0.0.78');

switch (npxInvocation.source) {
  case 'cache':
    assert.equal(npxInvocation.executable, process.execPath);
    assert.match(npxInvocation.prefix[0], /[\\/]@playwright[\\/]mcp[\\/]cli\.js$/i);
    break;
  case 'npx':
    assert.equal(npxInvocation.executable, process.execPath);
    assert.match(npxInvocation.prefix[0], /[\\/]npm[\\/]bin[\\/]npx-cli\.js$/i);
    break;
  case 'fallback':
    assert.match(path.basename(npxInvocation.executable), /^npx(?:\.(?:cmd|bat|ps1))?$/i);
    assert.deepEqual(npxInvocation.prefix, []);
    break;
  default:
    assert.fail(`resolveNpxInvocation returned unknown source: ${npxInvocation.source}`);
}

// Mutation report (src/playwright-gateway.js was restored byte-for-byte):
// - Strengthened assertion: resolveNpxInvocation executable/prefix contract.
// - Mutation: fallback returned process.execPath instead of the discovered npx.
// - RED: "AssertionError [ERR_ASSERTION]: The input did not match the regular
//   expression /^npx(?:\.(?:cmd|bat|ps1))?$/i. Input: 'node'"
// - Restored GREEN: "Playwright gateway intent/outcome tests passed."
// Census: empty loop/forEach NOT-FOUND (all three loop inputs are non-empty
// literals); exit-status/truthy-only evidence NOT-FOUND; swallowed failure
// NOT-FOUND (try/finally only, and the terminal catch sets exitCode); mock of
// subject NOT-FOUND; same-code expected value NOT-FOUND. The platform
// precondition above was the only silent assertion no-op found and is now
// covered on every resolver path. Unmet preconditions: Windows cache and
// Windows npx-cli branches were not available in this Linux environment.

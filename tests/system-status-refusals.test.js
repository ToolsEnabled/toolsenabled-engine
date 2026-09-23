'use strict';

require('./lib/isolated-environment').activate('system-status-refusals');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const policyPath = require.resolve('../src/lib/policy');
const stateStorePath = require.resolve('../src/lib/state-store');
const toolRegistryPath = require.resolve('../src/lib/tool-registry');
const originalPolicy = require(policyPath);

function cachedModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

// Load the subject with a policy collaborator that fails without supplying its
// own code. This reaches system-status's fallback rather than policy.js's code.
require.cache[policyPath].exports = {
  ...originalPolicy,
  httpConfiguration() { throw new Error('malformed HTTP policy'); }
};
delete require.cache[require.resolve('../src/lib/system-status')];
const subject = require('../src/lib/system-status');
require.cache[policyPath].exports = originalPolicy;

let writes = 0;
let spawns = 0;
const restorers = [];
for (const name of ['appendFileSync', 'writeFileSync']) {
  const original = fs[name];
  fs[name] = (...args) => { writes += 1; return original(...args); };
  restorers.push(() => { fs[name] = original; });
}
for (const name of ['exec', 'execFile', 'fork', 'spawn', 'spawnSync']) {
  const original = childProcess[name];
  childProcess[name] = (...args) => { spawns += 1; return original(...args); };
  restorers.push(() => { childProcess[name] = original; });
}

try {
  const google = subject.googleAccountReadiness({
    list() { throw new Error('account registry unreadable'); }
  });
  assert.equal(google.error.code, 'GOOGLE_ACCOUNTS_UNREADABLE');
  assert.equal(google.configured, null);
  assert.equal(google.accounts, null);

  const http = subject.httpState({ http: { allowedHosts: [] } });
  assert.equal(http.error.code, 'HTTP_POLICY_INVALID');
  assert.equal(http.configured, true);
  assert.equal(http.allowedHosts, undefined);

  const previousStateStore = require.cache[stateStorePath];
  require.cache[stateStorePath] = cachedModule(stateStorePath, {
    getStateStore() { throw new Error('state database unavailable'); }
  });
  try {
    const state = subject.transactionalState();
    assert.equal(state.ok, false);
    assert.equal(state.error.code, 'STATE_UNAVAILABLE');
    assert.match(state.error.message, /state database unavailable/);
  } finally {
    if (previousStateStore) require.cache[stateStorePath] = previousStateStore;
    else delete require.cache[stateStorePath];
  }

  const previousRegistry = require.cache[toolRegistryPath];
  require.cache[toolRegistryPath] = cachedModule(toolRegistryPath, {
    listTools() { throw new Error('registry unavailable'); }
  });
  try {
    const surface = subject.mcpToolSurfaceStatus();
    assert.equal(surface.state, 'unavailable');
    assert.equal(surface.reason, 'MCP_TOOL_SURFACE_STATUS_UNAVAILABLE');
    assert.equal(surface.counts, null);
    assert.equal(surface.directSessionScopeUnverified, null);
  } finally {
    if (previousRegistry) require.cache[toolRegistryPath] = previousRegistry;
    else delete require.cache[toolRegistryPath];
  }

  assert.equal(writes, 0, 'refusal paths must not write files');
  assert.equal(spawns, 0, 'refusal paths must not spawn processes');
} finally {
  for (const restore of restorers.reverse()) restore();
  require.cache[policyPath].exports = originalPolicy;
}

console.log('System status driven refusal tests passed.');

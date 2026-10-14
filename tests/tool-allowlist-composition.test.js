'use strict';

/* AN OPERATOR'S TOOL FILTER MUST NOT BE ESCAPED BY A REQUEST-BOUND PROFILE.
 *
 * src/lib/tool-registry.js carries two name-shaped narrowings:
 * TOOLSENABLED_TOOL_ALLOWLIST, a process-global environment variable, and
 * `allowedToolNames`, a request-bound array. registeredTools() used to pick ONE
 * -- `if (exactNames) { ... } else { parseToolAllowlist() ... }` -- so a
 * request-bound profile replaced the operator's filter instead of narrowing it,
 * and could name a tool that filter had removed.
 *
 * The env var is load-bearing. src/remote-agent-bridge.js start() assigns it the
 * remote profile before the listener binds a port, and
 * src/lib/setup/machine-record.js stamps the recorded install level's narrowed
 * list into every generated .mcp.json entry.
 *
 * NOTHING HERE DISPATCHES A TOOL. Both questions are asked of the enumeration
 * view and of assertToolRegistered(), which is the gate executeToolWithinPolicy()
 * consults; host.exec is named because it is the clearest thing to lose, and it
 * is never executed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/lib/tool-registry.js');
const { TOOL_ALLOWLIST_ENV } = registry;

const PROBE = 'host.exec';

function withOperatorFilter(value, run) {
  const saved = process.env[TOOL_ALLOWLIST_ENV];
  process.env[TOOL_ALLOWLIST_ENV] = value;
  try { return run(); } finally {
    if (saved === undefined) delete process.env[TOOL_ALLOWLIST_ENV];
    else process.env[TOOL_ALLOWLIST_ENV] = saved;
  }
}

const names = view => registry.registeredTools(view).map(entry => entry.name);
function registered(name, view) {
  try { registry.assertToolRegistered(name, view); return true; }
  catch { return false; }
}

test('the fixture is real: the operator filter alone removes the probe tool', () => {
  withOperatorFilter('ledger.*', () => {
    assert.equal(names({}).includes(PROBE), false,
      'the operator filter is not removing the tool, so nothing below tests anything');
    assert.equal(registered(PROBE, {}), false, 'and the dispatch gate refuses it');
  });
  assert.equal(names({}).includes(PROBE), true, 'and without the filter it is there again');
});

test('a request-bound profile narrows the operator filter, it does not replace it', () => {
  withOperatorFilter('ledger.*', () => {
    const view = { allowedToolNames: [PROBE, 'ledger.read'] };
    assert.equal(names(view).includes(PROBE), false,
      'a request-bound profile restored a tool the operator filter had removed');
    assert.equal(registered(PROBE, view), false,
      'and it reached the dispatch gate, which is where it would actually run');
    // The narrowing still works in the other direction: a name the operator
    // permits but the request does not ask for stays out.
    assert.deepEqual(names(view), ['ledger.read'],
      'the answer must be the intersection of the two filters, not either one alone');
  });
});

test('with no operator filter set, a request-bound profile behaves exactly as before', () => {
  const saved = process.env[TOOL_ALLOWLIST_ENV];
  delete process.env[TOOL_ALLOWLIST_ENV];
  try {
    assert.deepEqual(names({ allowedToolNames: [PROBE, 'ledger.read'] }).sort(), [PROBE, 'ledger.read'].sort(),
      'the ordinary case -- no env var -- must be untouched by the composition');
    assert.equal(registered(PROBE, { allowedToolNames: [PROBE] }), true);
  } finally {
    if (saved !== undefined) process.env[TOOL_ALLOWLIST_ENV] = saved;
  }
});

test('an operator filter that permits everything the request asks for changes nothing', () => {
  withOperatorFilter('host.*,ledger.*', () => {
    assert.deepEqual(names({ allowedToolNames: [PROBE, 'ledger.read'] }).sort(), [PROBE, 'ledger.read'].sort());
    assert.equal(registered(PROBE, { allowedToolNames: [PROBE] }), true,
      'composing must not refuse a tool both filters permit');
  });
});

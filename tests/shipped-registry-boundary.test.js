// NOTHING FOUND
/*
 * TEST-CAN-FAIL REPORT (testcanfail-tests-shipped-registry-boundary-test-js)
 *
 * No assertion required strengthening; no executable test code was changed.
 *
 * MUTATION OBSERVATIONS (all product files were restored byte-for-byte):
 * - Forbidden graph edge: temporarily required src/lib/entitlement.js from
 *   src/mcp-server.js. RED: `actual: [ 'src/lib/entitlement.js' ], expected: [],
 *   operator: 'deepStrictEqual'` (the assertion at the shipped-graph boundary).
 * - Ignored pre-load registration: temporarily made registerToolPack return for
 *   boundary-probe. RED: `actual: false, expected: true, operator: '=='` (the
 *   packedTools.has('boundary.probe') assertion).
 * - Wrong late-registration failure: temporarily retained the thrown failure but
 *   changed its diagnostic to "late pack rejected". RED: `expected:
 *   /registered after src\/lib\/tool-registry\.js was already built/,
 *   operator: 'match'`. This proves the test does not accept non-zero alone.
 * - Restored run GREEN: the shipped-registry boundary test passed after each
 *   mutation was reverted.
 *
 * SHAPE AUDIT:
 * 1. NOT-FOUND -- no loop/forEach contains an assertion. The two filter-based
 *    absence assertions compare their complete results, and their probe lists
 *    are non-empty literals (8 module paths and 10 tool names).
 * 2. NOT-FOUND -- runNode requires successful execution and parseable subject
 *    output; late registration additionally matches the subject's diagnostic,
 *    and the wrong-diagnostic mutation went RED despite its non-zero status.
 * 3. NOT-FOUND -- the sole catch records stderr for assertions; it does not
 *    swallow the tested failure. No optional chaining occurs.
 * 4. NOT-FOUND -- the test starts real Node processes over the real registries;
 *    it does not mock the registry, entrypoint, or pack implementation.
 * 5. NOT-FOUND -- there are no skips or platform/precondition guards.
 * 6. NOT-FOUND -- expected forbidden paths/names and probe name are independent
 *    literals; the +1 relationship compares independent clean processes rather
 *    than deriving an expected registry through the implementation under test.
 *
 * PRECONDITION: Node >=22.19 is required by package.json. The shell initially
 * selected Node 20.20.2 (missing node:sqlite); mutation and restored-green runs
 * used the installed Node 22.22.2 runtime.
 */
'use strict';

// WHAT THE INSTALLER PAYLOAD MAY LOAD, MEASURED BY LOADING IT.
//
// The release boundary classifies owner identity, account-specific model access,
// OAuth authorization, and commercial licensing modules as must-not-ship.
// Packaging walks literal require() calls from the installer entrypoints, so the
// boundary holds only while the shipped GRAPH does not reach those modules.
//
// WHY THIS TEST LOADS CODE INSTEAD OF READING IT. The obvious test greps the
// entrypoints, or the registry, for the forbidden names. That test passes over a
// tree where the require is still there but the tool is gone, and it passes over
// a tree where the require moved one file further away -- because dead text and
// live text look identical to a text search. It also fails over a comment that
// merely mentions a filename. So this asks Node: load the shipped entrypoint in a
// clean process and report every file that ended up in require.cache. A module
// that is in the cache was loaded; a module that is not was not. That is the same
// question the packer asks, answered by the runtime rather than a second parser.
//
// The second half proves the public pack mechanism still works without importing
// the owner's private pack sources. config/payload-boundary.json explicitly says
// src/lib/tool-packs belongs to the owner's private MCP entry, and that directory
// has never been tracked in this public repository. Requiring it here made the
// published product gate permanently red while testing bytes this repository
// neither owns nor ships. A synthetic pack exercises the same registry boundary:
// pre-load registration must widen the registry, while late registration must
// still fail loudly rather than disappearing from the frozen tool surface.

const { activate } = require('./lib/isolated-environment');
activate('shipped-registry-boundary');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const CAPABILITY_INDEX = require('../config/capability-index.json');
const { assertShippedToolInventory } = require('./lib/shipped-tool-inventory');

const ROOT = path.resolve(__dirname, '..');
// Anti-vacuity must name the product we still ship, not require filler tools
// to meet an obsolete count after deliberate integration retirements. Exact
// index/registry membership is checked below and the builder has its own
// truncation guard. These independent core witnesses cannot vanish with it.
const REQUIRED_CORE_TOOLS = Object.freeze([
  'system.status', 'system.doctor', 'system.kill_switch_status',
  'system.kill_switch_activate', 'system.resource_status', 'system.resource_advice',
  'agent.spawn', 'agent.stop', 'agent.restart', 'agent.remove',
  'capability.find', 'agent.set_account', 'agent.set_effort',
  'agent.set_model', 'agent.set_provider', 'agent.set_role',
  'agent_comms.send', 'agent_comms.read', 'agent_comms.local_roster',
  'host.read_file', 'host.write_file', 'host.exec',
  'memory.set', 'memory.get', 'memory.search',
  'task.submit', 'task.get', 'task.list',
  'build_queue.open', 'build_queue.claim', 'build_queue.close',
  'research.project_list', 'research.run_status', 'research.result_list'
]);
const ACTIVE_SHIPPED_PROVIDER_DESCRIPTORS = new Set([
  'codexCloud', 'extension', 'firebase', 'github', 'google', 'googleCloud',
  'instagram', 'paddle', 'stripe', 'web', 'falVideo'
]);

// Known owner-only and commercial modules that must remain outside the shipped
// entrypoint graph. Kept as relative paths so a rename shows up as a changed
// boundary rather than silently weakening this test.
const MUST_NOT_LOAD = [
  'src/lib/providers/vertex-gemini.js',
  'src/lib/providers/vertex-gemini-strong.js',
  'src/lib/providers/vertex-gemini-seat.js',
  'src/lib/providers/chrome-web-store-oauth.js',
  // The paid licensing surface. entitlement.js carries the commercial tier table
  // and prices, providers/license.js is the mechanism a paid tier is enforced
  // with, and license-store.js is its revocation store. All three are reached
  // ONLY through src/lib/tool-packs/vendor-license-issuance.js. Listing them here
  // is what stops a future top-level require() in tool-registry.js from quietly
  // putting the business model back in the open payload -- which is exactly how
  // they got there in the first place.
  'src/lib/entitlement.js',
  'src/lib/providers/license.js',
  'src/lib/license-store.js'
];

// The private tools those modules carry. They must be absent from the shipped
// registry. Their private implementations are tested in the owner source tree;
// this public gate tests the pack mechanism below without fabricating them.
const PACK_TOOLS = [
  'owner_identity.profile_status',
  'owner_identity.bootstrap_from_publisher_evidence',
  'vertex.gemini_complete',
  'vertex.gemini_strong_complete',
  'vertex.gemini_seat_complete',
  'gcloud.vertex_service_enable',
  'chrome_web_store.oauth_authorize',
  'license.key_issue',
  'license.key_verify',
  'license.key_revoke'
];

function runNode(source) {
  const out = execFileSync(process.execPath, ['-e', source], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, TOOLSENABLED_TOOL_ALLOWLIST: '' }
  });
  return JSON.parse(out.trim().split('\n').pop());
}

// 1. THE SHIPPED ENTRYPOINT. src/mcp-server.js only starts when it is the main
// module, so requiring it loads exactly the graph the packer walks.
const shipped = runNode(
  "require('./src/mcp-server.js');"
  + "const registry = require('./src/lib/tool-registry');"
  + "console.log(JSON.stringify({"
  + "  loaded: Object.keys(require.cache),"
  + "  tools: registry.TOOL_REGISTRY.map(t => t.name),"
  + "  providers: registry.TOOL_REGISTRY.map(t => t.provider).filter(Boolean)"
  + "}));"
);

const loaded = new Set(shipped.loaded.map((file) => path.relative(ROOT, file).split(path.sep).join('/')));
const leaked = MUST_NOT_LOAD.filter((relative) => loaded.has(relative));
assert.deepEqual(leaked, [], `the shipped MCP entrypoint loaded modules classified must-not-ship: ${leaked.join(', ')}`);

// Guard the guard: if the entrypoint stopped loading the registry at all, the
// check above would pass by loading nothing.
assert.ok(loaded.has('src/lib/tool-registry.js'), 'the shipped entrypoint must still load the tool registry');
assertShippedToolInventory(shipped.tools);

const shippedTools = new Set(shipped.tools);
assert.deepEqual(REQUIRED_CORE_TOOLS.filter(name => !shippedTools.has(name)), [],
  'the actual shipped entrypoint must expose each required core capability');
assert.equal(CAPABILITY_INDEX.N, shipped.tools.length,
  'the generated capability index count must equal the shipped registry count');
assert.deepEqual(
  CAPABILITY_INDEX.docs.map((document) => document.id).sort(),
  [...shippedTools].sort(),
  'the generated capability index and shipped registry must name exactly the same tools'
);
const unexpectedProviders = [...new Set(shipped.providers)]
  .filter((provider) => !ACTIVE_SHIPPED_PROVIDER_DESCRIPTORS.has(provider)).sort();
assert.deepEqual(unexpectedProviders, [],
  `the shipped registry contains a provider outside the active post-removal set: ${unexpectedProviders.join(', ')}`);
const stillShipped = PACK_TOOLS.filter((name) => shippedTools.has(name));
assert.deepEqual(stillShipped, [], `pack tools are still in the shipped registry: ${stillShipped.join(', ')}`);

// 2. PRE-LOAD PACK REGISTRATION. This is the public mechanism an owner-only
// entry uses. Register a disposable definition before the frozen registry is
// built and prove that it becomes a real tool descriptor.
const packed = runNode(
  "const packs = require('./src/lib/tool-pack-registry');"
  + "packs.registerToolPack({"
  + "  name: 'boundary-probe',"
  + "  definitions: ({ define, schema }) => ["
  + "    define('boundary.probe', 'Synthetic test-only pack tool.', schema(), () => ({ ok: true }), { effect: 'local-read' })"
  + "  ]"
  + "});"
  + "const registry = require('./src/lib/tool-registry');"
  + "console.log(JSON.stringify({ tools: registry.TOOL_REGISTRY.map(t => t.name) }));"
);
const packedTools = new Set(packed.tools);
assert.ok(packedTools.has('boundary.probe'), 'a pack registered before registry construction must add its tool');
assert.ok(
  packed.tools.length === shipped.tools.length + 1,
  `one pre-loaded pack definition must widen the registry by exactly one tool (${packed.tools.length} vs ${shipped.tools.length})`
);

// 3. THE ORDERING GUARD. A pack registered after the registry was built would be
// silently absent, which is the failure mode that would quietly undo half of
// this. It must throw instead.
let threw = null;
try {
  execFileSync(process.execPath, ['-e',
    "require('./src/lib/tool-registry');"
    + "require('./src/lib/tool-pack-registry').registerToolPack({ name: 'late-boundary-probe', definitions: () => [] });"
  ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
} catch (error) {
  threw = `${error.stderr || ''}`;
}
assert.ok(threw, 'registering a tool pack after the registry was built must throw, not pass silently');
assert.match(threw, /registered after src\/lib\/tool-registry\.js was already built/,
  'the late-registration refusal must say what actually went wrong');

console.log(
  `Shipped-registry boundary tests passed (${shipped.tools.length} shipped tools, ${packed.tools.length} with a pre-loaded probe pack; `
  + `${MUST_NOT_LOAD.length} must-not-ship modules absent from the shipped graph).`
);

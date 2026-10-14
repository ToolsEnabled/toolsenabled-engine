'EXECUTABLE CHANGE';
'use strict';

// DISCRIMINATION REPORT (testcanfail-tests-claude-confined-home-test-js)
// Strengthened assertions:
// - Both settings grant assertions formerly calculated their expectation with
//   claudeServerPermissionRule(), the same production helper used to generate
//   the files. Mutation: changed that helper's `mcp__` prefix to `BROKEN__`.
//   Before this change the suite remained green:
//     "PASS - claude-confined-home (108 checks, 0 failing)"
//   With the independent expectations below, the mutation is rejected:
//     "not ok - theToolSurfaceCarriesToolsAndTouchesNoCredential"
//     "+   'BROKEN__toolsenabled-readonly'"
//     "-   'mcp__toolsenabled-readonly'"
//     "not ok - mcpDocumentIsWrittenWithTheStamps"
//     "AssertionError [ERR_ASSERTION]: the settings grant does not match the servers the plan configured"
//     "+   'BROKEN__playwright'"
//     "-   'mcp__playwright'"
//     "FAIL - claude-confined-home (102 checks, 2 failing)"
// NOT-FOUND (1): every assertion-bearing iteration has a prior non-empty
// assertion or iterates a non-empty test literal.
// NOT-FOUND (2): no exit-status or merely-truthy child-process assertion.
// NOT-FOUND (3): no assertion failure is swallowed; the only catches probe
// hard-link support or perform best-effort cleanup outside the suites.
// NOT-FOUND (4): injected collaborators are used only to prove that the
// injection seam was consulted, not as an oracle for their own result.
// NOT-FOUND (5): there is no file/suite skip. The hard-link-only inode check is
// explicitly paired with a copy-mode assertion on filesystems without links.
// NOT-FOUND (6), beyond the two fixed grant assertions: comparisons between
// two plans intentionally assert parity, while all absolute product values
// have literal or independently constructed expectations.
// Preconditions: the default Node 20.20.2 lacks node:sqlite, so mutation and
// restoration runs used installed Node 22.22.2. The scratch filesystem
// supported hard links, so the hard-link branch also executed.

// THE CONFINED HOME A CLAUDE SESSION RUNS AGAINST, and the two leaks it ends.
//
// WHAT WAS MEASURED, from inside the product on 2026-08-19. An in-app Claude
// session (a) carried ZERO of the product's MCP tools -- its own words on
// record: "no ToolsEnabled MCP server is connected" -- and (b) read the OWNER'S
// global CLAUDE.md, because with no CLAUDE_CONFIG_DIR the official CLI resolves
// ~/.claude and injects that directory's CLAUDE.md into every conversation.
// The Codex engine has had neither problem since agent-session-confinement.js:
// its sessions read a home this installation owns. This suite is the same
// mechanism for the other engine.
//
// THE MEASUREMENTS THIS SUITE STANDS ON, taken against the installed
// claude 2.1.186 on this machine (scrubbed environment, scratch directories,
// never the owner's real home):
//
//   CLAUDE_CONFIG_DIR=<empty dir>  claude auth status --json
//       -> {"loggedIn":false,"authMethod":"none"}         exit 1
//   CLAUDE_CONFIG_DIR=<dir with hard-linked .credentials.json> auth status
//       -> {"loggedIn":true,"authMethod":"claude.ai",
//           "subscriptionType":"max"}                     exit 0
//   the same directory, a real minimal --print turn
//       -> {"is_error":false,"result":"ok"}               exit 0
//   a CLAUDE.md canary in the pointed directory
//       -> quoted back by the session verbatim
//   the same question from a pointed directory with no CLAUDE.md
//       -> "NONE"
//   MCP tool calls, WITHOUT the settings grant (acceptEdits, --print)
//       -> servers connected, every call permission-denied
//   with the grant, under acceptEdits
//       -> memory set/get round-tripped, 0 permission_denials
//   with the grant, under `plan` (the guided tier's mode)
//       -> a cross-session memory_get returned a value this session could not
//          have guessed, 0 denials -- the read-only tier's tools really run
//
// So: auth is scoped to the config directory; ONE linked file carries the
// person's own subscription sign-in into a directory this installation owns;
// the pointed directory's CLAUDE.md -- and nobody else's -- is the session's
// user-memory surface; and the settings grant is what turns connected servers
// into callable ones at every confined mode.
//
// NOTE ON THE PERMISSION-RULE STYLE: the generated grant uses the CLI's bare
// server-level form (`mcp__<name>`, from claudeServerPermissionRule). The
// repo's own developer files (.claude/settings.json.template and friends) use
// tool-level `mcp__<name>__*` styles for their own reasons; that divergence is
// deliberate -- do not "fix" the generated form to match the developer files.
//
// A LIVE TURN IS NOT RUN HERE, for the same reason the codex confinement suite
// gives: it costs a model call and needs a sign-in. Every seam that decides
// the confinement is asserted instead.
//
//   node tests/run-isolated.js tests/claude-confined-home.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const confinement = require('../src/lib/agent-session-confinement');
const machineRecord = require('../src/lib/setup/machine-record');

let checks = 0;
const temporary = [];
const previousDefaultConfigDir = process.env.CLAUDE_CONFIG_DIR;
const defaultConfigDir = scratch('default-config');
process.env.CLAUDE_CONFIG_DIR = defaultConfigDir;

function scratch(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `claude-confined-${prefix}-`));
  temporary.push(directory);
  /* EXPANDED ONCE, HERE, so every expectation built from this root is a
     LOCATION rather than a spelling. %TEMP% arrives as an 8.3 short name on
     this machine, and the confinement boundary returns the path Windows really
     calls the directory; comparing the two spellings failed six assertions
     that were about the SHAPE of the home, not about which alias the harness
     happened to be handed. Cleanup still uses the same string. */
  try { return fs.realpathSync.native(directory); } catch { return directory; }
}

function writeRecord(servicesRoot, tier, { workspace = scratch('ws') } = {}) {
  const record = machineRecord.buildMachineRecord({
    tier,
    installRoot: path.join(__dirname, '..'),
    servicesRoot,
    nodePath: process.execPath,
    workspaceRoots: [workspace]
  });
  machineRecord.writeMachineRecord(record, { servicesRoot });
  return record;
}

// A user home a person "signed into": the sign-in file with FAKE bytes. The
// suite never goes near the owner's real ~/.claude; that is a rule of the lane,
// and the reason every home here is a scratch directory.
// Native Claude tool-surface checks. The credential-relocation API was removed.

function theToolSurfaceCarriesToolsAndOnlyPointsAtTheOwnedCredentialHome() {
  // The half that ships. It must produce a callable tool surface and must NOT
  // copy a home or credential. It may point the official client at the owning
  // profile's existing config directory, which preserves sign-in in place.
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'standard');
  const tier = confinement.agentConfinement('standard');

  const surface = confinement.prepareClaudeToolSurface(tier, { record, servicesRoot });

  assert.equal(surface.mcpConfig, path.join(servicesRoot, 'agent-tools', 'claude', 'standard', '.mcp.json'));
  assert.equal(surface.settings, path.join(servicesRoot, 'agent-tools', 'claude', 'standard', 'settings.json'));
  assert.ok(surface.servers.length > 0, 'a surface with no servers is the defect this path exists to end');
  const profileRoot = confinement.installationProfileRoot();
  assert.equal(surface.configDir, defaultConfigDir,
    'the shipped surface did not pin the native configuration directory from the app environment');
  assert.equal(surface.env.USERPROFILE, profileRoot);
  assert.equal(surface.env.HOME, profileRoot);
  assert.equal(surface.credential, undefined, 'the shipped surface must not link a credential');
  const directory = path.dirname(surface.mcpConfig);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['.mcp.json', 'settings.json'],
    'the tool surface directory holds something other than the two generated files');
  checks += 8;

  // The grant names the plan's servers, at the tier's own mode -- without it
  // every configured tool answers permission-not-granted in a --print session.
  const grant = JSON.parse(fs.readFileSync(surface.settings, 'utf8'));
  assert.equal(grant.permissions.defaultMode, tier.claudePermissionMode);
  assert.deepEqual(grant.permissions.allow, surface.servers.map(name => `mcp__${name}`));
  checks += 2;

  // And the document is the generator's own, stamped for this engine.
  const document = JSON.parse(fs.readFileSync(surface.mcpConfig, 'utf8'));
  assert.deepEqual(Object.keys(document.mcpServers).sort(), [...surface.servers].sort());
  checks += 1;
}

function theShippedPlanPinsTheOwnedHomeWithoutCopyingACredential() {
  // THE POINT OF THE WHOLE LEG, asserted on the plan the app actually calls:
  // tools arrive as arguments, while configDir and profile variables name only
  // this installation's OS account. The credential remains in place.
  const servicesRoot = scratch('root');
  writeRecord(servicesRoot, 'standard');
  const plan = confinement.claudeToolsSessionPlan({ servicesRoot });

  assert.equal(plan.ok, true);
  const profileRoot = confinement.installationProfileRoot();
  assert.equal(plan.configDir, defaultConfigDir);
  assert.equal(plan.env.USERPROFILE, profileRoot);
  assert.equal(plan.env.HOME, profileRoot);
  assert.equal(plan.env.APPDATA, path.join(profileRoot, 'AppData', 'Roaming'));
  assert.equal(plan.env.LOCALAPPDATA, path.join(profileRoot, 'AppData', 'Local'));
  assert.ok(typeof plan.mcpConfig === 'string' && plan.mcpConfig.length > 0);
  assert.ok(typeof plan.settings === 'string' && plan.settings.length > 0);
  assert.equal(plan.claudePermissionMode, confinement.agentConfinement('standard').claudePermissionMode);
  assert.ok(plan.servers.length > 0);
  checks += 10;

  /* Success and refusal answer the same keys, so a caller never learns a
     field's existence from the outcome -- the rule the two home plans follow. */
  const refused = confinement.claudeToolsSessionPlan({ servicesRoot, account: 'a bare string' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'AGENT_CONFINEMENT_ACCOUNT_INVALID');
  assert.deepEqual(Object.keys(plan).sort(), Object.keys(refused).sort());
  checks += 3;
}

function shippedToolSurfaceRefusesMalformedEntries() {
  const servicesRoot = scratch('bad-surface'), record = writeRecord(servicesRoot, 'guided');
  for (const [entry, code] of [
    [null, 'AGENT_CONFINEMENT_SERVER_ENTRY_INVALID'],
    [{ args: [] }, 'AGENT_CONFINEMENT_SERVER_COMMAND_INVALID'],
    [{ command: '\x43:\\app\\ToolsEnabled.exe', args: [] }, 'AGENT_CONFINEMENT_RUNTIME_NOT_NODE']
  ]) {
    assert.throws(() => confinement.prepareClaudeToolSurface(confinement.agentConfinement('guided'), {
      servicesRoot, record, generate: () => ({ document: { mcpServers: { toolsenabled: entry } } })
    }), error => error.code === code);
    checks++;
  }
}

function theCodexRenderingConsultsTheInjectedRuntimeSeam() {
  // The function's own comment promises "the seam a test injects is the seam
  // this consults", and the JSON rendering passed its injected module while
  // the TOML rendering dropped it -- so the codex path silently consulted the
  // real module and its runtime tests were not testing the seam they named.
  const tier = confinement.agentConfinement('standard');
  const packaged = { mcpServers: { toolsenabled: { command: '\x43:\\app\\ToolsEnabled.exe', args: [] } } };
  let asked = 0;
  const injected = {
    runtimeNeedsNodeMode: () => { asked += 1; return true; }
  };
  assert.throws(
    () => confinement.confinedCodexConfig(tier, packaged, injected),
    error => error.code === 'AGENT_CONFINEMENT_RUNTIME_NOT_NODE'
  );
  assert.ok(asked > 0, 'the injected runtime module was never consulted by the TOML rendering');
  checks += 2;
}

// -----------------------------------------------------------------------------

function aChosenNativeConfigDirectoryIsPreserved() {
  const servicesRoot = scratch('native-root');
  writeRecord(servicesRoot, 'standard');
  const selected = scratch('native-config');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = selected;
  try {
    const plan = confinement.claudeToolsSessionPlan({ servicesRoot });
    assert.equal(plan.ok, true);
    assert.equal(plan.configDir, selected);
    assert.deepEqual(fs.readdirSync(selected), [],
      'planning a native session must not provision or relocate its sign-in');
    checks += 3;
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

function selectedAccountGetsToolsWithoutProvisioningItsSignIn() {
  const servicesRoot = scratch('account-root');
  writeRecord(servicesRoot, 'guided');
  const selected = scratch('account-config');
  const plan = confinement.claudeToolsSessionPlan({ servicesRoot, account: {
    name: 'selected', resolvedHome: selected
  } });
  assert.equal(plan.ok, true);
  assert.equal(plan.configDir, selected);
  assert.equal(plan.claudePermissionMode, 'plan');
  assert.deepEqual(fs.readdirSync(selected), []);
  assert.deepEqual(fs.readdirSync(path.dirname(plan.mcpConfig)).sort(), ['.mcp.json', 'settings.json']);
  checks += 5;
}

const suites = [
  aChosenNativeConfigDirectoryIsPreserved,
  selectedAccountGetsToolsWithoutProvisioningItsSignIn,
  theToolSurfaceCarriesToolsAndOnlyPointsAtTheOwnedCredentialHome,
  theShippedPlanPinsTheOwnedHomeWithoutCopyingACredential,
  shippedToolSurfaceRefusesMalformedEntries,
  theCodexRenderingConsultsTheInjectedRuntimeSeam
];

let failures = 0;
for (const suite of suites) {
  try {
    suite();
    process.stdout.write(`ok - ${suite.name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`not ok - ${suite.name}\n  ${error && (error.stack || error.message)}\n`);
  }
}

if (previousDefaultConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
else process.env.CLAUDE_CONFIG_DIR = previousDefaultConfigDir;

for (const directory of temporary) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} - claude-confined-home (${checks} checks, ${failures} failing)\n`);
process.exitCode = failures === 0 ? 0 : 1;

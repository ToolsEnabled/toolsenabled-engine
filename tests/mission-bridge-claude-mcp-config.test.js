// EXECUTABLE CHANGE
//
// Discrimination report (2026-08-26):
// - VACUOUS COLLECTION LOOP: FOUND below. Mutation: make the production
//   pathsNamedByMcpConfig() return []; before this change the complete file
//   remained green ("mission-bridge-claude-mcp-config: 9 checks passed"). The
//   new cardinality assertion made that mutant RED with:
//     AssertionError [ERR_ASSERTION]: a generated config must name at least one path to validate
// - EXIT STATUS/TRUTHY RETURN AS SOLE EVIDENCE: NOT-FOUND.
// - SWALLOWING TRY/CATCH OR OPTIONAL CHAIN: NOT-FOUND. refusalFrom rethrows a
//   missing refusal as an AssertionError; cleanup's catch is not test evidence.
// - MOCK OF THE SUBJECT: NOT-FOUND.
// - SKIP OR SILENT PLATFORM PRECONDITION: NOT-FOUND.
// - EXPECTED VALUE COMPUTED BY THE SUBJECT: NOT-FOUND.
// - RESTORATION: src/lib/setup/machine-record.js was restored byte-for-byte
//   (SHA-256 1decb56b86923f98a1cc390a350f74c569af89b59c38765c8eff323185b88a59),
//   then this file was green: "mission-bridge-claude-mcp-config: 9 checks passed".
// - PRECONDITION: PATH's Node 20 lacks node:sqlite. All executable checks used
//   the installed Node 24.15.0 runtime instead.

'use strict';

// A CLAUDE LANE MUST NEVER LAUNCH WITHOUT THE TOOL CONFIG IT WAS TOLD TO USE.
//
// claudeArgs emits `--mcp-config <root>/.mcp.json --strict-mcp-config`. The
// second flag is the dangerous one: it means "use ONLY this file". Pointed at a
// path that does not exist, Claude does not fail -- it starts with an empty MCP
// server set. The seat spawns, heartbeats, reports healthy, spends tokens, and
// has none of the product's tools. A crippled lane that still looks perfectly
// alive is the single most expensive failure shape in this codebase, so the
// absence has to be caught BEFORE the spawn, not observed afterwards.
//
// MEASURED 2026-08-13, and this is why the bug existed at all: the dispatch root
// and the config's write target are two different directories, each correct on
// its own terms and neither aware of the other.
//
//   dispatch root   <userData>/workspace   shell/main.cjs WORKSPACE_ROOT --
//                                          "the one real directory the product
//                                          owns on a customer's disk"
//   config written  <primaryWorkspace>     src/lib/setup/plan.js:256 -- the
//                                          folder the PERSON chose during setup
//
// On the builder's machine those can coincide. On a packaged install they do
// not, which is why no source test caught it -- the same blind spot that let the
// shipped org declare one provider-less controller.
//
// WHAT THIS FILE USED TO BE, and why it is written this way now. Three of its
// four checks asserted nothing about the product: one built a closure that threw
// an error the test itself had written and then asserted that it threw, and one
// compared two string literals. The function under test was not even exported.
// The only suite that reached dispatch() injected the guard away through
// `ensureMcpConfig`, so the real code path had zero coverage -- and hid a call to
// `readMachineRecord()` with no servicesRoot, which throws ERR_INVALID_ARG_TYPE
// and made the generate path unreachable on EVERY machine, correctly set up or
// not. Every check below therefore runs the real ensureLaneMcpConfig against the
// real machine-record module, in temporary directories. `servicesRoot` is the
// only injected value; nothing here reads or writes %LOCALAPPDATA%, and nothing
// writes into a real dispatch root.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const actions = require('../src/lib/mission-bridge/actions');
const confinement = require('../src/lib/agent-session-confinement');
const machineRecord = require('../src/lib/setup/machine-record');

const REPO_ROOT = path.resolve(__dirname, '..');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

// assert.throws returns undefined, so it cannot answer "which refusal was it".
// The code, the status and the cause are the whole contract here -- a refusal
// that merely throws is indistinguishable from a crash.
function refusalFrom(fn) {
  try { fn(); }
  catch (error) { return error; }
  throw new assert.AssertionError({ message: 'the call was expected to refuse and returned instead' });
}

const temporaries = [];
function scratch(prefix) {
  const tempRoot = process.platform === 'win32'
    ? path.join(confinement.installationProfileRoot(), 'AppData', 'Local', 'Temp')
    : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(tempRoot, prefix));
  temporaries.push(directory);
  return directory;
}

// A record this machine could actually run: the recorded runtime is the Node
// executing this test, and the install root is this checkout, so the server
// scripts generateMcpConfig names are genuinely present. Anything less and the
// generator would refuse for a reason that has nothing to do with what is
// under test.
function recordAt(servicesRoot, tier) {
  return machineRecord.buildMachineRecord({
    tier,
    installRoot: REPO_ROOT,
    servicesRoot,
    nodePath: process.execPath,
    workspaceRoots: [REPO_ROOT],
    machineId: 'mcp-config-test',
    machineLabel: 'mcp config test'
  });
}

function installedRecord(tier) {
  const servicesRoot = scratch('mcp-services-');
  machineRecord.writeMachineRecord(recordAt(servicesRoot, tier), { servicesRoot });
  return servicesRoot;
}

// A per-check target for the lane document, so checks that are not about WHERE
// it lives cannot see each other's file. Dispatch never passes one: it always
// writes actions.laneMcpConfigFile(), which the checks further down pin.
function laneTarget(prefix) {
  return path.join(scratch(prefix), 'state', 'mission-bridge-mcp', actions.LANE_MCP_CONFIG_FILE);
}

function readConfig(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function insidePath(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// The path the lane is actually handed, read off the real argv, so the checks
// below test what Claude would load rather than what a helper says it would.
function namedConfigFile(root) {
  const args = actions.claudeArgs({
    root,
    tier: { cliModel: 'test-model' },
    permissionSession: { origin: 'local', tier: 'full' }
  });
  const at = args.indexOf('--mcp-config');
  assert.ok(at >= 0, 'the claude lane must be given an mcp config');
  return args[at + 1];
}

/* THE ACTOR GOES TO THE BROKER, AND ONLY TO THE BROKER. machine-record.js
 * stamps TOOLSENABLED_AGENT_ACTOR onto the entries that run the ToolsEnabled
 * MCP server (the allowlist-reading script) and deliberately withholds it from
 * catalogue children such as the Playwright gateway -- "do not hand the opaque
 * authority bearer to Playwright" -- and tests/setup/first-run-setup.test.js
 * asserts that absence. This test used to demand the actor on EVERY server,
 * which contradicted both, and was red on a pristine tree (2026-09-02). */
function assertClaudeActor(document) {
  const entries = Object.entries(document.mcpServers || {});
  assert.ok(entries.length > 0, 'the generated document must contain at least one server');
  let brokers = 0;
  for (const [name, entry] of entries) {
    const args = Array.isArray(entry.args) ? entry.args : [];
    const isBroker = args.some(value => typeof value === 'string' && /mcp-server\.js$/i.test(value.replace(/\\/g, '/')));
    if (isBroker) {
      brokers += 1;
      assert.equal(entry.env && entry.env.TOOLSENABLED_AGENT_ACTOR, 'claude',
        `broker "${name}" must know the Claude lane is its calling actor`);
    } else {
      assert.equal(entry.env && entry.env.TOOLSENABLED_AGENT_ACTOR, undefined,
        `catalogue child "${name}" must not be handed the caller identity`);
    }
  }
  assert.ok(brokers > 0, 'the generated document must contain at least one ToolsEnabled broker');
}

// Every server the lane is handed is started by the runtime running this
// engine. A planted entry is, by construction, something else.
function assertOnlyEngineServers(document) {
  assertClaudeActor(document);
  for (const [name, entry] of Object.entries(document.mcpServers)) {
    assert.equal(entry.command, process.execPath, `server "${name}" must be started by this engine's own runtime`);
  }
}

/* WHERE THE LANE'S DOCUMENT LIVES IS A SECURITY BOUNDARY (1.0.50 security H1).
 *
 * The dispatch root is the lane's own working directory: a standard-tier Claude
 * lane (acceptEdits + Write) and a Codex lane (`workspace-write --cd root`) can
 * both write there. A document the lane is handed from that directory is a
 * document the lane wrote, and Claude Code starts every stdio server in it at
 * init -- as the person, unsandboxed, whatever --permission-mode/--tools say. */
check('claudeArgs names the dispatcher\'s own document in the state root, never a file in the dispatch root', () => {
  // laneConfinement requires a readable session; local/full is the
  // unrestricted lane that ships today, and it is the one whose argv carries
  // --strict-mcp-config, so it is the right case to pin.
  const root = scratch('mcp-args-');
  const named = namedConfigFile(root);
  assert.equal(insidePath(root, named), false,
    'the lane must never be handed an MCP document from the directory it can write to');
  assert.equal(named, actions.laneMcpConfigFile());
  assert.equal(path.basename(named), actions.LANE_MCP_CONFIG_FILE);
  const args = actions.claudeArgs({ root, tier: { cliModel: 'test-model' }, permissionSession: { origin: 'local', tier: 'full' } });
  // The flag that turns a missing file into a silent zero-tool session.
  assert.ok(args.includes('--strict-mcp-config'),
    'strict mode is deliberate; this test exists because of what it does when the file is absent');
});

check('a document planted in the dispatch root is never adopted, with or without a stale sidecar', () => {
  // MEASURED by the 1.0.50 audit: a planted `{command:'/bin/sh'}` document was
  // adopted both with no sidecar and with a stale one, and launched by the next
  // Claude lane dispatch at every tier.
  const servicesRoot = installedRecord('standard');
  for (const sidecar of [null, { fingerprint: '0'.repeat(64) }]) {
    const root = scratch('mcp-planted-');
    const planted = { mcpServers: { planted: { command: '/bin/sh', args: ['-c', 'exit 0'] } } };
    fs.writeFileSync(path.join(root, actions.LANE_MCP_CONFIG_FILE), JSON.stringify(planted, null, 2), 'utf8');
    if (sidecar) {
      fs.writeFileSync(path.join(root, 'mission-bridge-mcp-origin.local.json'), JSON.stringify(sidecar, null, 2), 'utf8');
    }

    const result = actions.ensureLaneMcpConfig({ root, servicesRoot });

    assert.notEqual(result.adopted, true, `a planted document must not be adopted (sidecar: ${sidecar ? 'stale' : 'none'})`);
    const handed = readConfig(namedConfigFile(root));
    assert.equal(Object.hasOwn(handed.mcpServers, 'planted'), false,
      'the planted server must not reach the document the lane is handed');
    assertOnlyEngineServers(handed);
  }
});

check('a lane document edited after dispatch is regenerated at the next dispatch', () => {
  // The audit's other route: editing the generated file broke its fingerprint,
  // so it was adopted "by hand" from then on -- and wake respawns reuse the
  // same path. Nothing about the file on disk is trusted now; it is rewritten
  // whenever it is not byte for byte what this dispatcher generates.
  const root = scratch('mcp-edited-');
  const servicesRoot = installedRecord('unrestricted');
  actions.ensureLaneMcpConfig({ root, servicesRoot });
  const file = namedConfigFile(root);
  const generated = readConfig(file);
  const edited = {
    ...generated,
    mcpServers: { ...generated.mcpServers, 'added-by-hand': { command: '/bin/sh', args: ['-c', 'exit 0'] } }
  };
  fs.writeFileSync(file, JSON.stringify(edited, null, 2), 'utf8');

  const result = actions.ensureLaneMcpConfig({ root, servicesRoot });

  assert.notEqual(result.adopted, true, 'an edited lane document must not be adopted');
  assert.equal(result.generated, true, 'an edited lane document must be rewritten');
  assert.deepEqual(readConfig(file), generated, 'the edit must not survive a dispatch');
});

check('a document in place does not excuse an unreadable machine record', () => {
  // This used to be the opposite rule ("a foreign document that is already in
  // place is never made to depend on it"), which is what let a planted file
  // stand in for the record. Every dispatch now generates, so every dispatch
  // needs the record.
  const root = scratch('mcp-noread-');
  fs.writeFileSync(path.join(root, actions.LANE_MCP_CONFIG_FILE), JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
  const servicesRoot = scratch('mcp-noreadservices-');
  fs.writeFileSync(path.join(servicesRoot, 'machine.json'), '{ not configuration', 'utf8');

  const error = refusalFrom(() => actions.ensureLaneMcpConfig({ root, servicesRoot }));
  assert.equal(error.code, 'BRIDGE_MCP_CONFIG_UNAVAILABLE');
  assert.equal(error.details.cause, 'SETUP_MACHINE_RECORD_MALFORMED');
});

check('a generated server that is not this engine\'s own runtime and script is refused, and nothing is written', () => {
  // Defence in depth on the generator itself: the document is checked before
  // it is written, with the same shape rules the confined session surfaces use
  // plus the lane's own rule that every server is this engine's catalogue entry.
  const servicesRoot = installedRecord('standard');
  const engineRoot = confinement.generationRecord({}).installRoot;
  const broker = path.join(engineRoot, 'src', 'mcp-server.js');
  const gateway = path.join(engineRoot, 'src', 'playwright-gateway.js');
  const cases = [
    ['a shell', { toolsenabled: { command: '/bin/sh', args: ['-c', 'exit 0'], cwd: engineRoot } }],
    // Passes the shared runtime rule (it claims node mode); only the lane rule stops it.
    ['a shell that claims node mode', { toolsenabled: { command: '/bin/sh', args: ['-c', 'exit 0'], cwd: engineRoot, env: { ELECTRON_RUN_AS_NODE: '1' } } }],
    ['inline code on the right runtime', { toolsenabled: { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: engineRoot } }],
    ['a script outside the engine', { toolsenabled: { command: process.execPath, args: [path.join(os.tmpdir(), 'mcp-server.js')], cwd: engineRoot } }],
    ['a runtime flag the generator never emits', { toolsenabled: { command: process.execPath, args: ['--require=/tmp/x.js', broker], cwd: engineRoot } }],
    ['a server the catalogue does not name', { extra: { command: process.execPath, args: [broker], cwd: engineRoot } }],
    ['a different browser package', { playwright: { command: process.execPath, args: [gateway, 'evil-package@1.0.0'], cwd: engineRoot } }],
    ['a server name the CLI would misread', { 'a__b': { command: process.execPath, args: [broker], cwd: engineRoot } }],
    ['no server map at all', null]
  ];
  for (const [label, mcpServers] of cases) {
    const root = scratch('mcp-refused-');
    const file = laneTarget('mcp-refusedtarget-');
    const recordApi = { ...machineRecord, generateMcpConfig: () => ({ document: { mcpServers }, skipped: [] }) };

    const error = refusalFrom(() => actions.ensureLaneMcpConfig({ root, servicesRoot, recordApi, file }));
    assert.equal(error.code, 'BRIDGE_MCP_CONFIG_UNAVAILABLE', `${label} must be refused`);
    assert.equal(error.status, 503);
    assert.equal(fs.existsSync(file), false, `${label}: a refused document must not be written`);
    assert.equal(fs.existsSync(path.join(root, actions.LANE_MCP_CONFIG_FILE)), false,
      `${label}: nothing may be written into the dispatch root either`);
  }
});

check('an absent config is generated from the machine record, naming only paths that exist', () => {
  const root = scratch('mcp-generate-');
  const file = laneTarget('mcp-generatetarget-');
  assert.equal(fs.existsSync(file), false, 'a fresh installation has no lane document -- that is the whole defect');

  const result = actions.ensureLaneMcpConfig({ root, servicesRoot: installedRecord('unrestricted'), file });

  assert.equal(result.generated, true, 'a missing config must be produced, not merely reported');
  assert.equal(result.file, file);
  assert.equal(fs.existsSync(path.join(root, actions.LANE_MCP_CONFIG_FILE)), false,
    'nothing is written into the dispatch root');
  const document = readConfig(file);
  assert.ok(Object.keys(document.mcpServers).length > 0, 'a generated config with no servers is the crippled lane again');
  assertOnlyEngineServers(document);
  // The acceptance property the generator promises, asserted rather than
  // assumed: --strict-mcp-config plus a path that is not there is the same
  // silent zero-tool session by another route.
  const namedPaths = machineRecord.pathsNamedByMcpConfig(document);
  assert.ok(namedPaths.length > 0, 'a generated config must name at least one path to validate');
  for (const named of namedPaths) {
    assert.ok(fs.existsSync(named), `the generated config names ${named}, which is not on this computer`);
  }
});

check('the default lane document is written where claudeArgs points', () => {
  // The two halves agree by construction -- both call laneMcpConfigFile() --
  // and this pins that they keep doing so.
  const root = scratch('mcp-default-');
  const result = actions.ensureLaneMcpConfig({ root, servicesRoot: installedRecord('guided') });
  assert.equal(result.file, actions.laneMcpConfigFile());
  assert.equal(result.file, namedConfigFile(root));
  assertOnlyEngineServers(readConfig(result.file));
});

check('a packaged install root, which holds no engine payload, still generates servers', () => {
  // THE SHAPE NO OTHER CHECK IN THIS FILE HAS, and the blind spot this file's own
  // header names: every record above records `installRoot: REPO_ROOT`, so the
  // script generateMcpConfig resolves against it is genuinely there and the
  // generator has nothing to skip. A packaged build records the APPLICATION
  // directory, and the engine ships inside it as an extraResource under
  // `resources/capability` -- so the recorded root holds no `src` at all, every
  // catalogue entry is skipped for "not present in this installation", and the
  // generated document is an empty server map. That file, plus the
  // --strict-mcp-config this suite pins above, is the same crippled lane the
  // whole file is about, reached with the document PRESENT rather than missing.
  //
  // MEASURED on a packaged installation 2026-08-29: two dispatched INVESTIGATOR
  // lanes both came back reporting no repo tools, no code tools and no shell,
  // over a lane document that carried this dispatcher's own fingerprint sidecar
  // and so had been generated here rather than adopted from anyone.
  const root = scratch('mcp-packaged-');
  const file = laneTarget('mcp-packagedtarget-');
  const servicesRoot = scratch('mcp-packagedservices-');
  const applicationRoot = scratch('mcp-packagedapp-');
  assert.equal(fs.existsSync(path.join(applicationRoot, 'src')), false,
    'the premise of this check is a recorded install root with no engine payload under it');
  machineRecord.writeMachineRecord(machineRecord.buildMachineRecord({
    tier: 'unrestricted',
    installRoot: applicationRoot,
    servicesRoot,
    nodePath: process.execPath,
    workspaceRoots: [REPO_ROOT],
    machineId: 'mcp-config-test',
    machineLabel: 'mcp config test'
  }), { servicesRoot });

  actions.ensureLaneMcpConfig({ root, servicesRoot, file });

  const document = readConfig(file);
  assert.ok(Object.keys(document.mcpServers).length > 0,
    'a packaged install generated a document with no servers, which is a lane that starts with zero tools and reports healthy');
  assertClaudeActor(document);
  const namedPaths = machineRecord.pathsNamedByMcpConfig(document);
  assert.ok(namedPaths.length > 0, 'a generated config must name at least one path to validate');
  for (const named of namedPaths) {
    assert.ok(fs.existsSync(named), `the generated config names ${named}, which is not on this computer`);
    assert.equal(named.startsWith(applicationRoot), false,
      'the servers must resolve against the engine that is running, not against the recorded application directory');
  }
});

check('a dispatch root with no machine record refuses, and writes nothing', () => {
  // The refusal is the point of the guard: an installation that was never set
  // up cannot be told which tools it may use, and starting the lane anyway is
  // the failure this whole file exists to prevent.
  const root = scratch('mcp-norecord-');
  const file = laneTarget('mcp-norecordtarget-');
  const emptyServices = scratch('mcp-noservices-');

  const error = refusalFrom(() => actions.ensureLaneMcpConfig({ root, servicesRoot: emptyServices, file }));
  assert.match(error.message, /machine record/i, 'the refusal must say what is missing');
  assert.equal(error.code, 'BRIDGE_MCP_CONFIG_UNAVAILABLE');
  // BRIDGE_CLAUDE_UNAVAILABLE means "the executable could not be resolved" and
  // sends someone to install Claude. A missing tool config is a setup problem on
  // a machine where Claude is present and fine; collapsing the two would send a
  // person to reinstall something that was never broken.
  assert.notEqual(error.code, 'BRIDGE_CLAUDE_UNAVAILABLE');
  assert.equal(error.status, 503);
  assert.equal(error.details.cause, 'MACHINE_RECORD_ABSENT');
  assert.equal(fs.existsSync(file), false, 'a refusal must not leave a half-written config behind');
});

check('a machine record that cannot be read refuses rather than guessing a surface', () => {
  const root = scratch('mcp-badrecord-');
  const file = laneTarget('mcp-badrecordtarget-');
  const servicesRoot = scratch('mcp-badservices-');
  fs.writeFileSync(path.join(servicesRoot, 'machine.json'), '{ this is not configuration', 'utf8');

  const error = refusalFrom(() => actions.ensureLaneMcpConfig({ root, servicesRoot, file }));
  assert.equal(error.code, 'BRIDGE_MCP_CONFIG_UNAVAILABLE');
  assert.equal(error.details.cause, 'SETUP_MACHINE_RECORD_MALFORMED');
  assert.equal(fs.existsSync(file), false);
});

check('a config we wrote is regenerated when the recorded level changes under it', () => {
  // THE MEASURED STALENESS, not a hypothetical one. At `unrestricted` the
  // write-capable `toolsenabled` server is emitted with no allowlist, which the
  // server reads as no limit -- the full tool surface. At `guided` that server
  // is not emitted at all. A file left behind by a level change therefore does
  // not go slightly out of date; it hands a confined installation the machine.
  const root = scratch('mcp-drift-');
  const file = laneTarget('mcp-drifttarget-');
  const servicesRoot = scratch('mcp-driftservices-');
  machineRecord.writeMachineRecord(recordAt(servicesRoot, 'unrestricted'), { servicesRoot });
  actions.ensureLaneMcpConfig({ root, servicesRoot, file });

  const wide = readConfig(file);
  assert.ok(Object.hasOwn(wide.mcpServers, 'toolsenabled'),
    'the unrestricted document is expected to carry the write-capable server; the drift being tested is its removal');
  assert.equal(wide.mcpServers.toolsenabled.env.TOOLSENABLED_TOOL_ALLOWLIST, undefined,
    'no allowlist on that server is exactly what the runtime reads as no limit');
  assert.equal(wide.mcpServers.toolsenabled.env.TOOLSENABLED_AGENT_ACTOR, 'claude',
    'the actor stamp must not be mistaken for a tool-surface restriction');

  // The owner narrows the installation.
  machineRecord.writeMachineRecord(recordAt(servicesRoot, 'guided'), { servicesRoot });
  const refreshed = actions.ensureLaneMcpConfig({ root, servicesRoot, file });

  assert.equal(refreshed.generated, true, 'a stale document must be rewritten, not reused');
  assert.equal(refreshed.refreshed, true);
  const narrow = readConfig(file);
  assert.equal(Object.hasOwn(narrow.mcpServers, 'toolsenabled'), false,
    'the narrowed level does not configure the write-capable server, so neither may the file the lane is handed');
  const allowlist = narrow.mcpServers['toolsenabled-readonly'].env.TOOLSENABLED_TOOL_ALLOWLIST.split(',');
  assert.ok(allowlist.length > 0 && allowlist.length < 200,
    'the surviving server must be a bounded named list, since an empty one is read as no limit');
});

check('the application state root is stamped into every strict-config server', () => {
  const root = scratch('mcp-state-root-');
  const file = laneTarget('mcp-state-roottarget-');
  const stateRoot = scratch('mcp-application-state-');
  const before = process.env.TOOLSENABLED_STATE_ROOT;
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot;
  try {
    actions.ensureLaneMcpConfig({ root, servicesRoot: installedRecord('unrestricted'), file });
  } finally {
    if (before === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = before;
  }
  const document = readConfig(file);
  assertClaudeActor(document);
  for (const entry of Object.values(document.mcpServers)) {
    assert.equal(entry.env.TOOLSENABLED_STATE_ROOT, stateRoot,
      'every server must write to the same application-owned state tree the UI reads');
  }
});

check('an unchanged record rewrites nothing', () => {
  // The document is GENERATED on every dispatch, but rewriting identical bytes
  // would churn the file under concurrent lanes and make its timestamp
  // meaningless. A difference is the trigger, not arrival.
  const root = scratch('mcp-stable-');
  const file = laneTarget('mcp-stabletarget-');
  const servicesRoot = installedRecord('standard');
  actions.ensureLaneMcpConfig({ root, servicesRoot, file });
  const before = fs.readFileSync(file, 'utf8');
  const beforeMtimeMs = fs.statSync(file).mtimeMs;

  const again = actions.ensureLaneMcpConfig({ root, servicesRoot, file });

  assert.equal(again.generated, false, 'a current document must not be rewritten');
  assert.equal(again.refreshed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, beforeMtimeMs, 'no write means no new mtime');
});

for (const directory of temporaries) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* temp dir */ }
}

process.stdout.write(`mission-bridge-claude-mcp-config: ${checks} checks passed\n`);

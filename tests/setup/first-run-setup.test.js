// EXECUTABLE CHANGE — testcanfail-tests-setup-first-run-setup-test-js
//
// Mutation report (the production files were restored byte-for-byte afterward):
// - Returning an empty server catalogue from generateMcpConfig left the checkout-runtime
//   walk green before this change.  After adding the cardinality assertion it was RED:
//   "AssertionError: checkout setup should configure at least one server".
// - Exporting an empty AGENT_ACTORS list left the accepted-actor walk green before this
//   change.  It is now RED: "AssertionError: setup must accept at least one caller".
// - Returning a plan with empty steps left both step walks green before this change.  They
//   are now RED: "AssertionError: setup must plan at least one step".
// - Returning a plan with empty hosts left the host walk green before this change.  It is
//   now RED: "AssertionError: setup must declare at least one sign-in host".
// - Exporting an empty tier list left the remote-lane walk green before this change.  It is
//   now RED: "AssertionError: setup must define at least one permission tier".
// - Returning no named paths from pathsNamedByMcpConfig left the end-to-end path walk green
//   before this change.  It is now RED: "AssertionError: the written configuration must name at least one executable path".
// Restored targeted plan run: "# pass 3", "# fail 0".  The restored full-file
// run reached "# pass 35", "# fail 20" because this container's Node 20 lacks
// node:sqlite; the failures all precede or are unrelated to the restored mutations.
// NOT-FOUND: assertions based only on non-zero exit/truthy process results; swallowed
// failures in try/catch or optional chains; assertions against a mock of their subject;
// platform skip/precondition guards; expected values computed by the same code under test.
// Precondition not met: Node with the built-in node:sqlite module, required for a
// completely green restored full-file run in this container.
'use strict';

// FIRST-RUN SETUP -- the acceptance this repository can actually run today.
//
// The property under test is the owner's, stated about the machine that will
// test this product: a person who has just installed it must be able to connect,
// sign in, and set anything up WITHOUT hand-editing JSON. So the cases below are
// weighted toward the person who has done nothing wrong and knows nothing:
//
//   - a computer that has never been set up must report that calmly, not fail;
//   - a generated configuration must never name a path that is not on this
//     computer, because a client that cannot launch a server it was told about
//     looks broken to the user;
//   - every step of the plan must declare its writes and must not need
//     administrator rights, because zero UAC prompts is a shipping requirement
//     and an assertion nobody runs is not a requirement;
//   - a workspace that would put the assistant inside the program's own source,
//     at a drive root, or over a whole user profile must be refused with a
//     sentence a person can act on.
//
// The end-to-end case is the one that matters most: it runs the real command a
// real person runs, against a real temporary folder, and then asks the product's
// own verifier whether what it wrote is true.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const machineRecord = require('../../src/lib/setup/machine-record');
const setupPlan = require('../../src/lib/setup/plan');
const workspaceModule = require('../../src/lib/setup/workspace');
const providerAuth = require('../../src/lib/setup/provider-auth');
const pairing = require('../../src/lib/setup/pairing');
const mcsetup = require('../../tools/mcsetup');

function tempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ } });
  return directory;
}

function baseRecord(overrides = {}) {
  return machineRecord.buildMachineRecord({
    tier: 'guided',
    installRoot: REPO_ROOT,
    servicesRoot: path.join(os.tmpdir(), 'te-services'),
    nodePath: process.execPath,
    workspaceRoots: [path.join(os.tmpdir(), 'te-workspace')],
    ...overrides
  });
}

// --- the machine record (T6) -------------------------------------------------

test('a computer that has never been set up reports that instead of failing', (t) => {
  const servicesRoot = tempDirectory(t, 'setup-empty-');
  assert.equal(machineRecord.readMachineRecord({ servicesRoot }), null);
});

test('a record that exists but is damaged is refused rather than silently replaced', (t) => {
  const servicesRoot = tempDirectory(t, 'setup-damaged-');
  fs.writeFileSync(machineRecord.machineRecordPath(servicesRoot), '{ this is not json', 'utf8');
  assert.throws(
    () => machineRecord.readMachineRecord({ servicesRoot }),
    error => error.code === 'SETUP_MACHINE_RECORD_MALFORMED'
  );
});

test('the runtime recorded is the one running setup, never a pinned absolute path', () => {
  const record = baseRecord();
  assert.equal(record.nodePath, path.resolve(process.execPath));
  const syntheticCurrentRuntime = path.join(os.tmpdir(), 'runtime-selected-by-current-process.exe');
  assert.equal(
    machineRecord.resolveNodePath({ execPath: syntheticCurrentRuntime, exists: () => false }),
    syntheticCurrentRuntime,
    'without an override, runtime selection follows the executing process and does not consult a pinned candidate'
  );
});

test('a runtime override that is not on this computer is refused before anything is written', () => {
  assert.throws(
    () => machineRecord.resolveNodePath({ override: path.join(os.tmpdir(), 'no-such-node-runtime.exe') }),
    error => error.code === 'SETUP_NODE_NOT_FOUND'
  );
});

test('a record that names a non-loopback bind is refused, because the bridge would refuse it too', () => {
  const validation = machineRecord.validateMachineRecord({
    ...baseRecord(),
    loopbackHost: '0.0.0.0'
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(entry => entry.includes('loopbackHost')));
});

test('a record whose ports fall outside the allowed ranges is refused', () => {
  const validation = machineRecord.validateMachineRecord({
    ...baseRecord(),
    shellPortRange: { first: 80, last: 90 }
  });
  assert.equal(validation.ok, false);
});

// --- the generated .mcp.json (T6 acceptance) ---------------------------------

test('the generated assistant configuration names no path that does not exist', () => {
  const record = baseRecord();
  const { document } = machineRecord.generateMcpConfig(record);
  const named = machineRecord.pathsNamedByMcpConfig(document);
  assert.ok(named.length > 0, 'a guided install should still configure at least one server');
  for (const target of named) {
    assert.equal(fs.existsSync(target), true, `${target} is named in the generated configuration but is not on this computer`);
  }
});

test('the generated configuration carries no other person\'s home directory and no pinned runtime', (t) => {
  const runtimeRoot = tempDirectory(t, 'setup-selected-runtime-');
  const selectedRuntime = path.join(runtimeRoot, 'current-runtime.exe');
  fs.writeFileSync(selectedRuntime, 'fixture runtime selected by the current process', 'utf8');
  const record = baseRecord({ nodePath: selectedRuntime });
  const { document } = machineRecord.generateMcpConfig(record);
  const serialised = JSON.stringify(document);
  assert.equal(serialised.includes(JSON.stringify(selectedRuntime).slice(1, -1)), true,
    'the generated configuration carries the runtime selected for this setup invocation');
  assert.equal(serialised.includes('C:\\\\agent-apps'), false);
  // The historical leak this pins was the owner's own retired legacy tree
  // (the selected installation root)
  // bleeding into a freshly generated config. A literal "owner" here would
  // make this a no-op on any computer but the owner's -- it would never see
  // the same class of leak on someone else's machine. Building the candidate
  // from THIS machine's own home directory, escaped the same way
  // JSON.stringify(document) escapes it, keeps the check live everywhere.
  // Case must stay exact except for the drive letter: folding case would make
  // "ToolsEnabled" match as a prefix of "engine-checkout" (REPO_ROOT),
  // which legitimately appears in this same document as the real install root.
  const retiredLegacyTree = path.join(os.homedir(), 'Desktop', 'ToolsEnabled');
  const escapedRetiredLegacyTree = JSON.stringify(retiredLegacyTree).slice(1, -1);
  const driveLower = escapedRetiredLegacyTree.charAt(0).toLowerCase() + escapedRetiredLegacyTree.slice(1);
  const driveUpper = escapedRetiredLegacyTree.charAt(0).toUpperCase() + escapedRetiredLegacyTree.slice(1);
  // A PATH, NOT A PREFIX. The retired tree is `...\Desktop\ToolsEnabled`; a
  // legitimate checkout at `...\Desktop\ToolsEnabled-1.0.41-WorkingFolder\engine`
  // starts with the same characters and must not trip this (measured
  // 2026-09-02: this check went red purely because of where the clone lived).
  // In JSON.stringify output a path segment ends at an escaped backslash
  // (`\`), a forward slash, or the closing quote.
  const boundaries = ['\\\\', '/', '\"'];
  const leaks = [driveLower, driveUpper].flatMap(candidate => boundaries.map(boundary => candidate + boundary));
  assert.equal(leaks.some(leak => serialised.includes(leak)), false,
    'the retired legacy tree must not appear as a path in the generated configuration');
});

test('the suggested workspace follows the real Documents folder when the caller can name it', () => {
  /* OneDrive's "Back up your folders" moves the real Documents known folder to
     `%USERPROFILE%\OneDrive\Documents`; a relocated Documents can sit on
     another drive. The shell asks Electron where Documents actually is and
     passes it in; this module must honour that answer, keep the historical
     guess for plain-Node callers, and never join a relative override. */
  const profile = path.join(os.tmpdir(), 'fixture-profile');
  const documents = path.join(profile, 'OneDrive', 'Documentos');
  const env = { USERPROFILE: profile };
  assert.equal(
    workspaceModule.defaultWorkspacePath({ env, documentsDir: documents }),
    path.join(documents, 'AI Workspace')
  );
  assert.equal(
    workspaceModule.defaultWorkspacePath({ env }),
    path.join(profile, 'Documents', 'AI Workspace'),
    'without a known-folder answer the historical guess stands'
  );
  for (const ignored of ['', '   ', 'Documents', null, undefined]) {
    assert.equal(
      workspaceModule.defaultWorkspacePath({ env, documentsDir: ignored }),
      path.join(profile, 'Documents', 'AI Workspace'),
      `a non-absolute override (${JSON.stringify(ignored)}) is ignored, not joined`
    );
  }
});

test('the guided level configures a read-only surface and nothing that can write', () => {
  const { document, skipped } = machineRecord.generateMcpConfig(baseRecord({ tier: 'guided' }));
  const names = Object.keys(document.mcpServers);
  assert.deepEqual(names, ['toolsenabled-readonly']);
  assert.ok(skipped.some(entry => entry.name === 'toolsenabled'));
});

test('a read-only surface is narrowed by the variable the server actually reads, not an invented one', () => {
  const { document } = machineRecord.generateMcpConfig(baseRecord({ tier: 'guided' }), {
    readOnlyTools: () => ['system.status', 'task.list']
  });
  const entry = document.mcpServers['toolsenabled-readonly'];
  // NODE_OPTIONS joined this set on 2026-09-03 and is the memory ceiling every
  // generated server now carries; see tests/mcp-server-footprint.test.js. The
  // narrowing variable is still the one this case is about.
  assert.deepEqual(Object.keys(entry.env), ['NODE_OPTIONS', 'TOOLSENABLED_AGENT_TOOL_MODE', 'TOOLSENABLED_TOOL_ALLOWLIST']);
  assert.equal(entry.env.TOOLSENABLED_AGENT_TOOL_MODE, 'ToolsEnabled only');
  assert.equal(entry.env.TOOLSENABLED_TOOL_ALLOWLIST, 'system.status,task.list');
  // The name is load-bearing: src/lib/tool-registry.js reads exactly this
  // variable, and any other spelling silently produces the FULL tool surface
  // behind a read-only label.
  const registrySource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'lib', 'tool-registry.js'), 'utf8');
  assert.ok(registrySource.includes("TOOL_ALLOWLIST_ENV = 'TOOLSENABLED_TOOL_ALLOWLIST'"));
});

test('the read-only tool list is derived from the registry, and an empty one fails closed', () => {
  const derived = machineRecord.readOnlyToolAllowlist();
  assert.ok(derived.length > 0);
  assert.ok(derived.includes('system.status'), 'a read-only profile should still be able to report status');
  assert.equal(derived.includes('host.write_file'), false, 'a read-only profile must not carry a writing tool');
  assert.throws(
    () => machineRecord.generateMcpConfig(baseRecord({ tier: 'guided' }), { readOnlyTools: () => [] }),
    error => error instanceof Error
  );
});

test('the write-capable server is narrowed by the level, not left at the full surface', () => {
  // The defect this pins: only the READ-ONLY server used to be narrowed, so a
  // `standard` install generated a `toolsenabled` server with no allowlist at
  // all -- which src/lib/tool-registry.js reads as the full surface, host.exec
  // included, under the level whose own words are "cannot reach the rest of the
  // computer".
  const { document } = machineRecord.generateMcpConfig(baseRecord({ tier: 'standard' }));
  const names = document.mcpServers.toolsenabled.env.TOOLSENABLED_TOOL_ALLOWLIST.split(',');
  assert.ok(names.length > 0);
  for (const escape of ['host.exec', 'host.read_file', 'host.write_file', 'repo.write_file', 'clipboard.read']) {
    assert.equal(names.includes(escape), false, `standard must not hand over ${escape}`);
  }
  // Still write-capable, or it would be the read-only level under another name.
  assert.equal(names.includes('gmail.send'), true);
});

test('the level narrows the read-only server too, so the guided level cannot read the whole disk', () => {
  const guided = machineRecord.generateMcpConfig(baseRecord({ tier: 'guided' }))
    .document.mcpServers['toolsenabled-readonly'].env.TOOLSENABLED_TOOL_ALLOWLIST.split(',');
  // `host.read_file` and `repo.read_file` are local-read, so an effect-derived
  // read-only profile admitted them -- and the guided level generates this
  // server and nothing else.
  for (const escape of ['host.read_file', 'host.list_dir', 'repo.read_file', 'repo.list_dir', 'clipboard.read']) {
    assert.equal(guided.includes(escape), false, `the guided level must not hand over ${escape}`);
  }
  assert.equal(guided.includes('system.status'), true);
});

test('the level that grants the whole machine writes no allowlist, rather than a list that will go stale', () => {
  const { document } = machineRecord.generateMcpConfig(baseRecord({ tier: 'unrestricted' }));
  // The env is no longer absent -- every server carries a memory ceiling since
  // 2026-09-03 -- but the ALLOWLIST is, which is what this case is about.
  assert.equal(document.mcpServers.toolsenabled.env.TOOLSENABLED_TOOL_ALLOWLIST, undefined);
  // And that is a deliberate omission, not a broken derivation: the narrower
  // levels on the same code path do write one.
  assert.equal(machineRecord.tierToolAllowlist('unrestricted'), null);
  assert.ok(machineRecord.tierToolAllowlist('standard').length > 0);
});

// --- the runtime the document names, and who it says is calling --------------

/* A RECORD WHOSE RUNTIME IS THIS PRODUCT'S OWN BINARY, which is what EVERY
 * packaged installation records: resolveNodePath() answers `process.execPath`,
 * and the process that runs setup is the application. The file is real because
 * generateMcpConfig refuses a runtime that is not on the computer. */
function packagedRuntimeRecord(t, tier = 'standard') {
  const directory = tempDirectory(t, 'te-packaged-runtime-');
  const runtime = path.join(directory, 'ToolsEnabled.exe');
  fs.writeFileSync(runtime, 'not a real binary; only its NAME is under test');
  return baseRecord({ tier, nodePath: runtime });
}

test('a packaged install tells every server to run as Node, or it starts the application instead', (t) => {
  /* MEASURED 2026-08-18 on a staged packaged build, which is why this is an
   * assertion and not a precaution:
   *   "<app>.exe" "<engine>\src\mcp-server.js"  without the variable
   *      -> no answer to `initialize`, 0 tools advertised, 5 new top-level
   *         windows owned by that child (it booted the whole application)
   *   the same command WITH ELECTRON_RUN_AS_NODE=1
   *      -> `initialize` answered, the allowlist advertised exactly, 0 windows
   * So the user-visible "a second ToolsEnabled pops up when I start an agent"
   * and "an app-started session has none of the product's own tools" are the
   * same defect, and this is the line that decides both. */
  const { document } = machineRecord.generateMcpConfig(packagedRuntimeRecord(t, 'standard'));
  const names = Object.keys(document.mcpServers);
  assert.ok(names.length >= 2, 'the standard level should configure more than one server');
  for (const name of names) {
    assert.equal(document.mcpServers[name].env?.ELECTRON_RUN_AS_NODE, '1',
      `${name} would be started by the application binary with nothing telling it to behave as Node`);
  }
  // Merged, never replacing: the narrowing the level applies must survive.
  const readOnly = document.mcpServers['toolsenabled-readonly'].env;
  assert.ok(readOnly.TOOLSENABLED_TOOL_ALLOWLIST.length > 0, 'the allowlist was replaced rather than merged');
  assert.deepEqual(Object.keys(readOnly), ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'TOOLSENABLED_AGENT_TOOL_MODE', 'TOOLSENABLED_TOOL_ALLOWLIST']);
  assert.equal(readOnly.TOOLSENABLED_AGENT_TOOL_MODE, 'ToolsEnabled only');
});

test('a checkout install, whose runtime IS node, gets byte-identical output', () => {
  /* The regression risk of the line above. `node` ignores ELECTRON_RUN_AS_NODE
   * -- it is an Electron-only variable -- so setting it there would be harmless
   * but would still change a document thousands of installations already have.
   * It is not set, and this is the check that says so in bytes rather than in
   * prose. */
  const record = baseRecord({ tier: 'standard', nodePath: process.execPath });
  assert.equal(path.basename(process.execPath).toLowerCase().replace(/\.exe$/, ''), 'node',
    'this test only means anything when the test runner IS node');
  const { document } = machineRecord.generateMcpConfig(record);
  const servers = Object.values(document.mcpServers);
  assert.ok(servers.length > 0, 'checkout setup should configure at least one server');
  for (const entry of servers) {
    assert.equal(entry.env?.ELECTRON_RUN_AS_NODE, undefined);
  }
});

test('an unrecognised runtime is treated as ours rather than assumed to be node', (t) => {
  /* The safe direction, asserted. The set of names this product's binary can
   * have is open (it has been renamed once already); the set of names a plain
   * Node has is closed. So the question asked is "is this node", and anything
   * else gets the variable -- which a real Node would ignore anyway. */
  const runtimeFixtureRoot = path.join(os.tmpdir(), 'fixture-runtime');
  assert.equal(machineRecord.runtimeNeedsNodeMode(path.join(runtimeFixtureRoot, 'node.exe')), false);
  assert.equal(machineRecord.runtimeNeedsNodeMode('/usr/bin/node'), false);
  assert.equal(machineRecord.runtimeNeedsNodeMode(path.join(runtimeFixtureRoot, 'ToolsEnabled.exe')), true);
  assert.equal(machineRecord.runtimeNeedsNodeMode(path.join(runtimeFixtureRoot, 'Mission Control.exe')), true);
  assert.equal(machineRecord.runtimeNeedsNodeMode(path.join(runtimeFixtureRoot, 'electron.exe')), true);
  const { document } = machineRecord.generateMcpConfig(packagedRuntimeRecord(t, 'guided'));
  assert.equal(document.mcpServers['toolsenabled-readonly'].env.ELECTRON_RUN_AS_NODE, '1');
});

test('the exact agent-session bearer reaches only the server that consumes it', () => {
  /* The agent CLI starts every catalogue child from this document.  Identity is
   * needed by ToolsEnabled's own MCP process, but an unrelated server such as
   * Playwright neither validates nor needs the opaque bearer.  Giving it the
   * credential would let a compromised unrelated child impersonate the agent
   * at the owner proxy. */
  const record = baseRecord({ tier: 'standard' });
  const sessionCredential = Buffer.alloc(32, 0xa7).toString('base64url');
  const stamped = machineRecord.generateMcpConfig(record, {
    agentActor: 'codex',
    agentId: 'fixture-agent',
    sessionCredential
  }).document;
  const names = Object.keys(stamped.mcpServers);
  assert.ok(names.length >= 2);
  for (const name of ['toolsenabled-readonly', 'toolsenabled']) {
    assert.equal(stamped.mcpServers[name].env?.TOOLSENABLED_AGENT_ACTOR, 'codex', `${name} carries no provider`);
    assert.equal(stamped.mcpServers[name].env?.TOOLSENABLED_AGENT_ID, 'fixture-agent', `${name} carries no agent id`);
    assert.equal(stamped.mcpServers[name].env?.TOOLSENABLED_AGENT_SESSION_CREDENTIAL, sessionCredential,
      `${name} carries no exact session credential`);
  }
  assert.equal(stamped.mcpServers.playwright.env?.TOOLSENABLED_AGENT_ACTOR, undefined);
  assert.equal(stamped.mcpServers.playwright.env?.TOOLSENABLED_AGENT_ID, undefined);
  assert.equal(stamped.mcpServers.playwright.env?.TOOLSENABLED_AGENT_SESSION_CREDENTIAL, undefined,
    'an unrelated catalogue process must never receive an agent authority bearer');
  // Merged onto the allowlist rather than replacing it.
  assert.ok(stamped.mcpServers.toolsenabled.env.TOOLSENABLED_TOOL_ALLOWLIST.length > 0);
});

test('no caller named means the document is byte-identical to the one this has always written', () => {
  /* The regression risk the option carries: `null` must stamp NOTHING, so an
   * install-time `.mcp.json` is unchanged for every existing installation.
   * Asserted as bytes, not as a field-by-field walk, because a field-by-field
   * walk only checks the fields whoever wrote it thought of. */
  const record = baseRecord({ tier: 'standard' });
  const control = JSON.stringify(machineRecord.generateMcpConfig(record).document);
  const explicitNull = JSON.stringify(machineRecord.generateMcpConfig(record, { agentActor: null }).document);
  assert.equal(explicitNull, control);
  assert.equal(control.includes('TOOLSENABLED_AGENT_ACTOR'), false);
});

test('a caller this product cannot name is refused, not silently dropped', () => {
  /* A mis-spelled principal that were merely omitted would produce a server
   * whose actor-bound tools refuse at runtime, in a grandchild process nobody is
   * watching, with a message nobody is looking for. */
  const record = baseRecord({ tier: 'standard' });
  assert.ok(machineRecord.AGENT_ACTORS.length > 0, 'setup must accept at least one caller');
  for (const hostile of ['Codex', 'codex ', '', 'openai', 5, {}, []]) {
    assert.throws(
      () => machineRecord.generateMcpConfig(record, { agentActor: hostile }),
      error => error.code === 'SETUP_AGENT_ACTOR_INVALID',
      `${JSON.stringify(hostile) ?? String(hostile)} must be refused`
    );
  }
  /* `undefined` is the option being ABSENT -- a destructuring default, not a
     value -- and must behave exactly like `null`: stamp nothing. Stated because
     the two are easy to conflate and the difference is whether an existing
     caller that passes an options object without the key starts throwing. */
  assert.equal(
    JSON.stringify(machineRecord.generateMcpConfig(record, { agentActor: undefined }).document),
    JSON.stringify(machineRecord.generateMcpConfig(record).document)
  );
  for (const accepted of machineRecord.AGENT_ACTORS) {
    const { document } = machineRecord.generateMcpConfig(record, { agentActor: accepted });
    assert.equal(document.mcpServers.toolsenabled.env.TOOLSENABLED_AGENT_ACTOR, accepted);
  }
});

test('every server is told where this installation keeps its records, or none is', () => {
  /* THE DEFECT, MEASURED BY A TWO-NODE DRIVE. The application sets
   * TOOLSENABLED_STATE_ROOT for the capability layer it starts itself. An MCP
   * server is NOT that child: the agent CLI spawns it out of this document, so
   * it inherits nothing and falls back to the payload's per-user default -- a
   * different directory. An agent registered in the application's own directory
   * file could not be found by a server reading the other one, and the refusal
   * was correct about what it could see. Everything stateful an app-started
   * session does was landing where the application never looks. */
  const root = path.join(os.tmpdir(), 'te-state-root-fixture');
  const { document } = machineRecord.generateMcpConfig(baseRecord({ tier: 'standard' }), { stateRoot: root });
  const names = Object.keys(document.mcpServers);
  assert.ok(names.length >= 2);
  for (const name of names) {
    assert.equal(document.mcpServers[name].env?.TOOLSENABLED_STATE_ROOT, root,
      `${name} would keep its records somewhere the application never reads`);
  }
});

test('a records directory that is not a full path is refused, not written', () => {
  /* src/lib/runtime-state-root.js refuses a relative value when it READS it, so
   * generating one produces a server that dies at startup inside a grandchild
   * nobody is watching. Refused here, where there is still somebody to tell. */
  const record = baseRecord({ tier: 'standard' });
  for (const hostile of ['relative/path', '', '   ', 5, {}, []]) {
    assert.throws(
      () => machineRecord.generateMcpConfig(record, { stateRoot: hostile }),
      error => error.code === 'SETUP_STATE_ROOT_INVALID',
      `${JSON.stringify(hostile)} must be refused`
    );
  }
  /* Absent means "not an agent session" and must stamp nothing -- byte-identical
     for every installation that already has a document. */
  const control = JSON.stringify(machineRecord.generateMcpConfig(record).document);
  assert.equal(JSON.stringify(machineRecord.generateMcpConfig(record, { stateRoot: null }).document), control);
  assert.equal(control.includes('TOOLSENABLED_STATE_ROOT'), false);
});

test('a level this program does not recognise produces no configuration at all', () => {
  assert.throws(
    () => machineRecord.tierToolAllowlist('admin'),
    error => error.code === 'PERMISSION_INSTALL_TIER_REFUSED'
  );
  assert.throws(
    () => machineRecord.tierToolAllowlist(undefined),
    error => error.code === 'PERMISSION_INSTALL_TIER_REFUSED'
  );
  // The record validator refuses it first, so no path reaches generation with
  // an unknown level and quietly writes an unlimited profile.
  assert.equal(machineRecord.validateMachineRecord({ ...baseRecord(), tier: 'admin' }).ok, false);
});

test('a server added without saying whether the level narrows it is refused, not left unnarrowed', () => {
  // The hidden fallback this closes: `allowlisted` absent reads as false, the
  // entry is written with no allowlist, and no allowlist is the FULL surface.
  // It is invisible to every test that only exercises today's three entries.
  // EACH FIXTURE TRIPS EXACTLY ONE GUARD. The first fixture here named
  // `src/mcp-server.js`, which trips BOTH -- so the assertion below was only
  // distinguishing them by its message regex, and loosening that regex would
  // have let the second guard satisfy the first assertion. That is the same
  // "passing on the backstop" shape this suite exists to catch, one level in.
  // A script that does not read the variable can only fail the declaration
  // check, so the assertion now isolates the guard it names.
  const undeclared = [{ name: 'future-gateway', script: 'src/some-future-gateway.js', tiers: ['guided'], readOnly: false }];
  assert.throws(
    () => machineRecord.assertServerCatalogue(undeclared),
    error => error.code === 'SETUP_SERVER_CATALOGUE_INVALID' && /does not say whether/.test(error.message),
    'the declaration guard must refuse a server that never stated whether the level narrows it'
  );
  // Saying "no" is not enough either, for a server that runs the program which
  // reads the variable. This fixture declares the property, so only the second
  // guard can fire.
  assert.throws(
    () => machineRecord.assertServerCatalogue([{ name: 'toolsenabled-future', script: 'src/mcp-server.js', tiers: ['guided'], readOnly: false, allowlisted: false }]),
    error => error.code === 'SETUP_SERVER_CATALOGUE_INVALID' && /reads the tool allowlist/.test(error.message),
    'the allowlist-reading guard must refuse an mcp-server-backed server that opted out of narrowing'
  );
  // The catalogue that actually ships passes its own check.
  assert.equal(machineRecord.assertServerCatalogue(machineRecord.SERVER_CATALOGUE).length, 3);
});

test('the recorded level and the enforced level are one list, not two that can drift apart', () => {
  const policy = require('../../src/lib/permission-tier-policy');
  assert.equal(machineRecord.TIERS, policy.INSTALL_TIERS);
});

test('setup never writes a remote lane, because it cannot know the other computer\'s install path', () => {
  assert.ok(machineRecord.TIERS.length > 0, 'setup must define at least one permission tier');
  for (const tier of machineRecord.TIERS) {
    const { document } = machineRecord.generateMcpConfig(baseRecord({ tier }));
    const names = Object.keys(document.mcpServers);
    assert.ok(names.length > 0, `${tier} must configure at least one server`);
    for (const name of names) {
      assert.equal(/remote/.test(name), false, `${name} was generated for ${tier} but setup cannot resolve a peer root`);
    }
  }
});

// --- the workspace (T10) -----------------------------------------------------

test('a folder inside the program\'s own source is refused, with a sentence a person can act on', () => {
  const verdict = workspaceModule.checkWorkspaceCandidate(path.join(REPO_ROOT, 'src'), { installRoot: REPO_ROOT, tier: 'guided' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'SETUP_WORKSPACE_INSIDE_INSTALL_REFUSED');
  assert.ok(/choose a folder of your own/i.test(verdict.message));
});

test('the top of a drive and a whole user profile are both refused', () => {
  const driveRoot = path.parse(process.cwd()).root;
  assert.equal(workspaceModule.checkWorkspaceCandidate(driveRoot, { installRoot: REPO_ROOT }).code, 'SETUP_WORKSPACE_DRIVE_ROOT_REFUSED');
  const home = os.homedir();
  assert.equal(
    workspaceModule.checkWorkspaceCandidate(home, { installRoot: REPO_ROOT, env: { USERPROFILE: home } }).code,
    'SETUP_WORKSPACE_PROFILE_ROOT_REFUSED'
  );
});

test('an ordinary folder is accepted and created, and setup says whether undo will work', (t) => {
  const parent = tempDirectory(t, 'setup-workspace-');
  const target = path.join(parent, 'AI Workspace');
  const result = workspaceModule.provisionWorkspace(target, { installRoot: REPO_ROOT, tier: 'guided' });
  assert.equal(result.workspace, target);
  assert.equal(fs.existsSync(target), true);
  assert.equal(typeof result.undoAvailable, 'boolean');
  if (result.undoAvailable !== true) {
    assert.equal(typeof result.undoUnavailableReason, 'string');
  }
});

test('undo without an earlier state refuses in plain words rather than throwing', (t) => {
  const parent = tempDirectory(t, 'setup-undo-');
  const result = workspaceModule.undoToCheckpoint(parent, null, {});
  assert.equal(result.ok, false);
  assert.ok(/no earlier state/i.test(result.reason));
});

// --- the plan (T7) -----------------------------------------------------------

function samplePlan(t, overrides = {}) {
  const servicesRoot = tempDirectory(t, 'setup-plan-services-');
  const workspace = tempDirectory(t, 'setup-plan-workspace-');
  return setupPlan.plan({
    tier: 'guided',
    facts: {
      shellPort: { chosen: 4601, range: machineRecord.SHELL_PORT_RANGE },
      bridgePort: { chosen: 4610, range: machineRecord.BRIDGE_PORT_RANGE },
      git: { present: true }
    },
    installRoot: REPO_ROOT,
    servicesRoot,
    nodePath: process.execPath,
    workspaceRoots: [workspace],
    ...overrides
  });
}

test('no step of a plan requires administrator rights', (t) => {
  const built = samplePlan(t);
  assert.ok(built.steps.length > 0, 'setup must plan at least one step');
  for (const entry of built.steps) {
    assert.equal(entry.elevation, false, `${entry.id} must not require elevation`);
  }
  assert.equal(built.requiresElevation, false);
});

test('every write in a plan lands inside a folder the plan declared', (t) => {
  const built = samplePlan(t);
  const verdict = setupPlan.checkPlanContainment(built);
  assert.deepEqual(verdict.escaping, []);
  assert.deepEqual(verdict.elevating, []);
  assert.equal(verdict.ok, true);
});

test('a plan is refused outright if any step would write outside its declared folders', () => {
  assert.throws(
    () => setupPlan.assertWritesContained({
      writeRoots: [path.join(os.tmpdir(), 'declared')],
      steps: [{ id: 'rogue', writes: [path.join(os.homedir(), 'Desktop', 'somewhere-else.txt')], elevation: false }]
    }),
    error => error.code === 'SETUP_PLAN_UNCONTAINED'
  );
});

test('a step with no stated origin cannot be built, because explain would have nothing to say', () => {
  assert.throws(
    () => setupPlan.step({ id: 'guessed', phase: 'resolve', name: 'A guess', value: 42, provenance: '' }),
    error => error.code === 'SETUP_PLAN_PROVENANCE_MISSING'
  );
});

test('every step can be explained, and every value says where it came from', (t) => {
  const built = samplePlan(t);
  assert.ok(built.steps.length > 0, 'setup must plan at least one step');
  for (const entry of built.steps) {
    const explained = setupPlan.explainStep(built, entry.id);
    assert.equal(explained.id, entry.id);
    assert.ok(explained.provenance.length > 0);
  }
});

test('the only hosts a plan contacts are the sign-in ones, declared in advance', (t) => {
  const built = samplePlan(t);
  assert.ok(built.hosts.length > 0, 'setup must declare at least one sign-in host');
  for (const host of built.hosts) {
    assert.ok(/openai\.com$|chatgpt\.com$/.test(host), `${host} is contacted by setup but was not expected`);
  }
});

// --- signing in (T9) ---------------------------------------------------------

function fakeRunner(responses) {
  return (command, args) => {
    const key = `${command} ${(args || []).join(' ')}`;
    if (Object.prototype.hasOwnProperty.call(responses, key)) return responses[key];
    return { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' };
  };
}

test('a signed-out computer is walked to a displayed code, never to a password box', () => {
  const runner = fakeRunner({
    'codex --version': { status: 0, stdout: 'codex 1.0.0', stderr: '' },
    'codex login status': { status: 1, stdout: '', stderr: 'not logged in' },
    'codex login --device-auth': { status: 0, stdout: 'Open https://auth.openai.com/device and enter ABCD-1234\n', stderr: '' }
  });
  const started = providerAuth.startCodexDeviceLogin({ runner, env: {} });
  assert.equal(started.started, true);
  assert.equal(started.userCode, 'ABCD-1234');
  assert.equal(started.verificationUrl, 'https://auth.openai.com/device');
});

test('a signed-in computer verifies without prompting for anything', () => {
  const runner = fakeRunner({
    'codex --version': { status: 0, stdout: 'codex 1.0.0', stderr: '' },
    'codex login status': { status: 0, stdout: 'logged in', stderr: '' }
  });
  assert.deepEqual(providerAuth.verifyCodexSignIn({ runner, env: {} }), { signedIn: true });
  const probed = providerAuth.probeProvider('codex', { runner, env: {} });
  assert.equal(probed.installed, true);
  assert.equal(probed.signedIn, true);
});

test('a computer without the assistant program is told that, not told it is signed out', () => {
  const probed = providerAuth.probeProvider('codex', { runner: fakeRunner({}), env: {} });
  assert.equal(probed.installed, false);
  assert.equal(probed.signedIn, false);
  assert.ok(/not on this computer/i.test(probed.detail));
});

test('the guided level offers exactly one sign-in route and it is the compliant one', () => {
  const options = providerAuth.providerOptionsForTier('guided', { runner: fakeRunner({}), env: {} });
  assert.deepEqual(options.routes.map(route => route.route), ['device-code']);
});

test('the claude routes are a pasted key and a handoff -- there is no claude.ai login form anywhere', () => {
  const options = providerAuth.providerOptionsForTier('standard', { runner: fakeRunner({}), env: {} });
  const claudeRoutes = options.routes.filter(route => route.provider === 'claude').map(route => route.route);
  assert.deepEqual(claudeRoutes.sort(), ['deep-link', 'paste-key']);
  const surface = Object.keys(providerAuth).join(' ').toLowerCase();
  assert.equal(/password|passphrase/.test(surface), false, 'setup must never collect a provider password');
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'lib', 'setup', 'provider-auth.js'), 'utf8');
  assert.equal(/claude\.ai\/login|console\.anthropic\.com\/login/.test(source), false);
});

test('a pasted key is checked by shape and never returned by the function that stores it', () => {
  assert.equal(providerAuth.checkClaudeApiKeyShape('hello there').ok, false);
  assert.equal(providerAuth.checkClaudeApiKeyShape('sk-ant-0123456789012345678').ok, true);
  const written = [];
  const result = providerAuth.storeClaudeApiKey('sk-ant-0123456789012345678', {
    setSecret: (key, value) => written.push({ key, length: value.length })
  });
  assert.deepEqual(result, { stored: true, vaultKey: providerAuth.CLAUDE_API_KEY_VAULT_KEY });
  assert.equal(written.length, 1);
  assert.equal(JSON.stringify(result).includes('sk-ant-'), false);
});

test('the helper handoff code carries the choices made so far and no credential', () => {
  const handoff = providerAuth.helperHandoffCode({ tier: 'guided', workspace: path.join(os.tmpdir(), 'AI Workspace') });
  assert.match(handoff.code, /^TE-[A-Z0-9]{5}$/);
  assert.equal(handoff.carriesCredential, false);
  assert.equal(handoff.resumes.tier, 'guided');
});

// --- adding a second computer (priority 2) -----------------------------------

test('pairing nothing reads as a normal, complete state rather than an empty list', (t) => {
  const root = tempDirectory(t, 'setup-pairing-');
  const status = pairing.pairingStatus(root);
  assert.equal(status.paired, false);
  assert.equal(status.count, 0);
  assert.ok(/working on its own/i.test(status.summary));
});

test('pairing status does not report an unreadable or malformed registry as definitely unpaired', (t) => {
  const root = tempDirectory(t, 'setup-pairing-broken-');
  const unreadable = pairing.pairingStatus(root, {
    fs: {
      readFileSync() {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
    }
  });
  assert.equal(unreadable.paired, null);
  assert.equal(unreadable.source, 'unreadable');
  assert.match(unreadable.warning, /could not be read/i);
  assert.match(unreadable.summary, /status is unknown/i);
  assert.doesNotMatch(unreadable.summary, /working on its own/i);
  assert.equal(unreadable.nextStep, null);

  const malformed = pairing.pairingStatus(root, {
    fs: { readFileSync: () => '{not json' }
  });
  assert.equal(malformed.paired, null);
  assert.equal(malformed.source, 'malformed');
  assert.match(malformed.warning, /malformed/i);
  assert.doesNotMatch(malformed.summary, /nothing needs to be set up/i);
});

test('the pairing instruction names the product command, never the internal tool path', () => {
  const lines = pairing.inviteInstruction({
    bind: '127.0.0.1', port: 8795, code: 'TE-K7QM-4XPB', minutes: 10, fingerprint: 'aa:bb', joinCommand: 'node tools/mcsetup.js pair join'
  }).join('\n');
  assert.ok(lines.includes('node tools/mcsetup.js pair join'));
  assert.equal(lines.includes('peer-enroll'), false);
  assert.ok(/do not send it anywhere/i.test(lines));
});

test('setup really drives the pairing tool, so it is no longer a command a person is left to find', () => {
  const peerEnroll = require('../../tools/peer-enroll');
  assert.equal(typeof peerEnroll.commandInvite, 'function');
  assert.equal(typeof peerEnroll.commandJoin, 'function');
  const source = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'mcsetup.js'), 'utf8');
  assert.ok(source.includes("require('./peer-enroll')"), 'the setup surface must call the pairing tool itself');
});

test('the pairing tool is no longer registered as a command a human must run by hand', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'invocation-registry.json'), 'utf8'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(registry.entries, 'tools/peer-enroll.js'),
    false,
    'setup now calls tools/peer-enroll.js, so its manual-invocation entry must stay deleted'
  );
});

// --- end to end: two computers, paired through the product -------------------

// Two real processes against two isolated installations, because the whole point
// of pairing is that the two halves are separate. `tests/peer-enroll-cli.js`
// already proves the listener's lifecycle; what is proved HERE is narrower and is
// the thing that was missing: the PRODUCT'S OWN command completes a pairing, so a
// person is never left to find an internal tool path.
function startProductInvite(t, { root, port }) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(REPO_ROOT, 'tools', 'mcsetup.js'), 'pair', 'invite',
      '--install-root', root, '--port', String(port), '--minutes', '2'
    ], { cwd: REPO_ROOT });
    let stdout = '';
    let settled = false;
    t.after(() => { if (!child.killed) child.kill(); });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/--address (\S+) --code (\S+)/);
      if (match && !settled) {
        settled = true;
        resolve({ address: match[1], code: match[2], banner: stdout });
      }
    });
    child.on('close', () => { if (!settled) reject(new Error(`invite exited before showing a code: ${stdout}`)); });
  });
}

function runProduct(args) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'tools', 'mcsetup.js'), ...args], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('two computers pair through the product command, and neither person is sent to a tool path', async (t) => {
  const rootA = tempDirectory(t, 'setup-pair-a-');
  const rootB = tempDirectory(t, 'setup-pair-b-');

  const invite = await startProductInvite(t, { root: rootA, port: 8874 });
  assert.ok(invite.banner.includes('node tools/mcsetup.js pair join'), 'the invite must name the product command');
  assert.equal(invite.banner.includes('tools/peer-enroll.js'), false, 'the invite must not name the internal tool');

  const joined = await runProduct([
    'pair', 'join', '--install-root', rootB, '--address', invite.address, '--code', invite.code
  ]);
  assert.equal(joined.code, 0, `pairing must succeed: ${joined.stdout}${joined.stderr}`);
  assert.match(joined.stdout, /Paired with/);

  // Both sides recorded it, which is what makes the pairing real rather than a
  // message on one screen.
  assert.equal(fs.existsSync(pairing.peerRegistryPath(rootB)), true);
  const statusB = pairing.pairingStatus(rootB);
  assert.equal(statusB.paired, true);
  assert.equal(statusB.count, 1);

  const reported = await runProduct(['pair', 'status', '--install-root', rootB]);
  assert.equal(reported.code, 0);
  assert.match(reported.stdout, /paired with this one/i);
});

// --- end to end: the command a real person runs ------------------------------

test('a person can set this computer up with one command and the product then verifies itself', async (t) => {
  const servicesRoot = tempDirectory(t, 'setup-e2e-services-');
  const workspaceParent = tempDirectory(t, 'setup-e2e-workspace-');
  const workspace = path.join(workspaceParent, 'AI Workspace');

  // Capture the real command's human-readable output in its own process. Its
  // `ok` verification lines are not TAP results from this node:test program.
  const applied = await runProduct([
    'apply',
    '--tier', 'guided',
    '--workspace', workspace,
    '--services-root', servicesRoot,
    '--install-root', REPO_ROOT
  ]);
  assert.equal(applied.code, 0, `setup must complete: ${applied.stdout}${applied.stderr}`);

  // Nothing was hand-edited: the two files a working configuration needs now
  // exist, and were written by the command above.
  const recordFile = machineRecord.machineRecordPath(servicesRoot);
  assert.equal(fs.existsSync(recordFile), true);
  const generated = path.join(workspace, '.mcp.json');
  assert.equal(fs.existsSync(generated), true);

  const record = machineRecord.readMachineRecord({ servicesRoot });
  assert.equal(record.tier, 'guided');
  assert.deepEqual(record.workspaceRoots, [workspace]);

  const document = JSON.parse(fs.readFileSync(generated, 'utf8'));
  const namedPaths = machineRecord.pathsNamedByMcpConfig(document);
  assert.ok(namedPaths.length > 0, 'the written configuration must name at least one executable path');
  for (const target of namedPaths) {
    assert.equal(fs.existsSync(target), true, `${target} was written into the configuration but does not exist`);
  }

  const verified = await runProduct([
    'verify', '--services-root', servicesRoot, '--install-root', REPO_ROOT
  ]);
  assert.equal(verified.code, 0, `the product must verify its own configuration: ${verified.stdout}${verified.stderr}`);
  assert.match(verified.stdout, /^\s+ok\s+assistant-config:/m);
  assert.match(verified.stdout, /This computer is set up and everything it points at exists\./);
});

test('verification refuses an assistant configuration that names zero paths', async (t) => {
  const servicesRoot = tempDirectory(t, 'setup-zero-path-services-');
  const workspace = tempDirectory(t, 'setup-zero-path-workspace-');
  const record = baseRecord({ servicesRoot, workspaceRoots: [workspace] });
  machineRecord.writeMachineRecord(record, { servicesRoot });
  fs.writeFileSync(path.join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf8');

  const verified = await runProduct([
    'verify', '--services-root', servicesRoot, '--install-root', REPO_ROOT
  ]);
  assert.equal(verified.code, 1, 'zero scanned paths must not make verification pass vacuously');
  assert.match(verified.stdout, /^\s+FAIL\s+assistant-config:.*names no paths/m);
  assert.doesNotMatch(verified.stdout, /This computer is set up and everything it points at exists\./);
});

test('setup refuses to start on a screen that cannot ask, and says exactly what to type instead', async () => {
  const refused = await runProduct(['run']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /this is not an interactive screen/);
  assert.match(refused.stderr, /node tools\/mcsetup\.js apply --tier guided --workspace/);
});

test('an unknown level is refused by name rather than silently defaulting to a wider one', () => {
  assert.throws(
    () => mcsetup.resolveTier({ tier: 'admin' }),
    error => error.code === 'SETUP_TIER_UNKNOWN'
  );
});

// The configuration and requested write policy are real. They do not establish
// that a running assistant cannot read beyond its working folders. Keep that
// distinction visible before either form of the command-line choice.

test('the level question discloses requested write policy and broader possible read access before the answer', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'mcsetup.js'), 'utf8');
  const notice = mcsetup.TIER_LIMIT_NOTICE.join('\n');

  const disclosure = notice.replace(/\s+/g, ' ');
  assert.match(disclosure, /available ToolsEnabled tools and the requested write policy/);
  assert.match(disclosure, /Guided requests read-only.*Standard can request writes/);
  assert.match(disclosure, /tools and roles can narrow this further/);
  assert.match(disclosure, /can still read files elsewhere/);
  assert.match(disclosure, /session's reported permissions/);
  assert.doesNotMatch(disclosure, /not built yet|cannot reach anything else/);

  // It is printed where the choice is made, not only where it is audited.
  const askTier = source.slice(source.indexOf('async function askTier()'), source.indexOf('async function askWorkspace'));
  assert.ok(
    askTier.includes('outTierLimitNotice(TIER_LIMIT_LEAD_BEFORE)'),
    'the level question must print the notice before it prompts for an answer'
  );
  assert.ok(
    askTier.indexOf('outTierLimitNotice') < askTier.indexOf('Choose 1, 2 or 3'),
    'the notice must come before the prompt, so it is read before the answer is typed'
  );
});

test('a level given on the command line still shows the same notice, exactly once', async (t) => {
  const servicesRoot = tempDirectory(t, 'setup-notice-services-');
  const workspaceParent = tempDirectory(t, 'setup-notice-workspace-');
  const workspace = path.join(workspaceParent, 'AI Workspace');

  const applied = await runProduct([
    'apply',
    '--tier', 'guided',
    '--workspace', workspace,
    '--services-root', servicesRoot,
    '--install-root', REPO_ROOT
  ]);
  assert.equal(applied.code, 0, `setup must complete: ${applied.stdout}${applied.stderr}`);

  const marker = 'These modes can still read files elsewhere.';
  assert.ok(
    applied.stdout.includes(marker),
    `a person who passed --tier must still be told that write policy does not establish a read boundary: ${applied.stdout}`
  );
  assert.equal(
    applied.stdout.split(marker).length - 1,
    1,
    'the notice is a disclosure, not a nag: exactly one copy per run'
  );
});

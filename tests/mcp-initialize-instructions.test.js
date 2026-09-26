'use strict';

// THE SESSION-START TOOL NOTE HAS TO ARRIVE, AND IT HAS TO POINT AT OUR VAULT.
//
// A live pre-beta report on 1.0.30, 2026-08-25: agents "have to be prompted to
// use the credential manager, and they come back having used Google's or
// Windows' credential manager instead of ours."
//
// Two separate defects sit under that one sentence, and this file pins both:
//
//   DELIVERY   src/lib/agent-tool-summary.js wrote a correct, budgeted,
//              settings-gated note, and tests/agent-tool-summary.test.js proved
//              it true -- and no product code ever read it. The MCP handshake
//              in src/mcp-server.js returned protocolVersion, capabilities and
//              serverInfo, with no `instructions` field, so what the note said
//              reached no agent on any install. A note nobody is handed and a
//              note that does not exist are the same thing from the agent's
//              side, which is why every test here goes through dispatch() --
//              the real handshake -- rather than calling briefToolSummary().
//
//   STEERING   removing an agent's built-in shell and web tools forces our
//              tools for shell and web; it does nothing at all about a
//              credential store, because Windows Credential Manager and a
//              browser password manager are not built-in agent tools -- they
//              are places an agent goes when nothing told it where ours is. So
//              the note and the credential tools' own descriptions have to name
//              the wrong stores, not merely praise the right one.
//
// EVERY ASSERTION HERE CALLS THE PRODUCT WITH VALUES. The handshake is driven
// with real permission sessions built from src/lib/permission-tier-policy.js,
// the advertised surface is read back from a real tools/list on the same
// session, and the setting is switched with a settings file this test writes.
// Nothing greps a source file for the string it hopes is there.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A scratch state root BEFORE the first src/lib require -- the standing trap in
// this codebase is that state modules decide their root at first require.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-init-instructions-'));
process.env.TOOLSENABLED_STATE_ROOT = path.join(SCRATCH, 'state');
fs.mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true });

const mcpServer = require('../src/mcp-server');
const policy = require('../src/lib/permission-tier-policy');
const REGISTERED = new Set(require('../src/lib/tool-registry').registeredTools().map(tool => tool.name));

const HANDSHAKE = Object.freeze({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
const LIST = Object.freeze({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

function settingsFileWith(toolSummaryValue) {
  const directory = fs.mkdtempSync(path.join(SCRATCH, 'settings-'));
  const valuesPath = path.join(directory, 'settings.json');
  const id = require('../src/lib/agent-tool-summary').TOOL_SUMMARY_SETTING_ID;
  fs.writeFileSync(valuesPath, JSON.stringify({
    revision: 1,
    values: { [id]: toolSummaryValue },
    provenance: { [id]: { source: 'user', atMs: 1, directive: null } }
  }), 'utf8');
  return valuesPath;
}

async function handshake(options) {
  return mcpServer.dispatch({ ...HANDSHAKE }, options);
}

// The names a tool id is made of, so an assertion finds "system.credential_request"
// as a whole id and not as a substring of a longer one.
function namesIn(text) {
  return new Set(text.match(/[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+/g) || []);
}

async function testHandshakeCarriesTheNote() {
  console.log('🧪 The MCP handshake actually hands the agent the tool note...');
  for (const tier of policy.INSTALL_TIERS) {
    const permissionSession = policy.installTierSession(tier);
    const result = await handshake({ permissionSession });
    assert.equal(typeof result.instructions, 'string',
      `${tier}: the handshake carried no instructions -- the session-start note reaches nobody`);
    assert.ok(result.instructions.length > 0, `${tier}: the handshake carried an empty note`);
    // This is the real MCP initialize path, not just a direct composer call.
    // It has no verified native provider census; a Claude controller must not
    // infer that a Codex child has lost its native tools from this API note.
    assert.match(result.instructions, /Native tools vary by provider\/session, including children; this API list does not measure them/);
    assert.doesNotMatch(result.instructions, /Your (?:own )?built-in|switched off for this session|shell, web and messaging are off/);
    const summary = require('../src/lib/agent-tool-summary');
    assert.ok(summary.estimateTokens(result.instructions) <= summary.DEFAULT_BUDGET_TOKENS,
      `${tier}: delivered instructions exceed the existing token budget`);
    const listed = await mcpServer.dispatch({ ...LIST }, { permissionSession });
    const offered = new Set(listed.tools.map(tool => tool.name));
    if (offered.has('host.exec')) assert.match(result.instructions, /ToolsEnabled execution: host\.exec/);
    else if (offered.has('sandbox.exec')) assert.match(result.instructions, /ToolsEnabled execution: sandbox\.exec in a leased sandbox/);
    else assert.match(result.instructions, /ToolsEnabled offers no shell at this level/);
    // The handshake still answers its own contract; the note is an addition,
    // never a replacement.
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.equal(result.serverInfo.name, 'toolsenabled');
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    console.log(`  ${tier}: ${result.instructions.length} characters of note delivered.`);
  }
  console.log('  ✅ every install level is handed its note by the real handshake.');
}

async function testTheNoteNamesOurCredentialVaultAndNotTheOthers() {
  console.log('🧪 The delivered note points at OUR vault and names the stores it is not...');
  const permissionSession = policy.installTierSession('standard');
  const { instructions } = await handshake({ permissionSession });

  // Precondition, measured rather than assumed: this level really does carry
  // the credential requester, or the assertions below prove nothing.
  const listed = await mcpServer.dispatch({ ...LIST }, { permissionSession });
  const advertised = new Set(listed.tools.map(tool => tool.name));
  assert.ok(advertised.has('system.credential_request'),
    'precondition: Standard must advertise system.credential_request');

  assert.ok(namesIn(instructions).has('system.credential_request'),
    'the delivered note never names the credential requester, so an agent has to be told it exists -- the customer\'s exact complaint');
  assert.match(instructions, /vault/i,
    'the delivered note never mentions a vault');
  // The steer that was missing. The customer watched agents land in these two
  // stores; a note that only praises ours does not move an agent away from the
  // one it has seen a thousand times.
  assert.match(instructions, /Windows/,
    'the delivered note never tells the agent NOT to use Windows Credential Manager');
  assert.match(instructions, /Google/,
    'the delivered note never tells the agent NOT to use Google\'s password manager');
  console.log('  ✅ the note names the requester, the vault, and both wrong stores.');
}

async function testTheNoteNeverAdvertisesAToolThisSessionRefuses() {
  console.log('🧪 The note describes the surface this very connection advertises...');
  for (const tier of policy.INSTALL_TIERS) {
    const permissionSession = policy.installTierSession(tier);
    const { instructions } = await handshake({ permissionSession });
    const listed = await mcpServer.dispatch({ ...LIST }, { permissionSession });
    const advertised = new Set(listed.tools.map(tool => tool.name));
    const absentClause = instructions.indexOf('Not at this level');
    const offeredHalf = absentClause === -1 ? instructions : instructions.slice(0, absentClause);
    for (const name of namesIn(offeredHalf)) {
      // Prose that merely looks like an id is ignored the same way
      // tests/agent-tool-summary.test.js ignores it: only names the registry
      // actually knows are held to this.
      if (!REGISTERED.has(name)) continue;
      assert.ok(advertised.has(name),
        `${tier}: the note offers "${name}", which this session's own tools/list does not advertise`);
    }
    console.log(`  ${tier}: note agrees with all ${advertised.size} advertised tools.`);
  }
  console.log('  ✅ the note and tools/list cannot disagree.');
}

async function testTheSettingDecidesWhetherANoteExists() {
  console.log('🧪 agent.tool_summary off means the handshake carries no note at all...');
  const permissionSession = policy.installTierSession('standard');
  const on = await handshake({ permissionSession, valuesPath: settingsFileWith(true) });
  const off = await handshake({ permissionSession, valuesPath: settingsFileWith(false) });
  assert.equal(typeof on.instructions, 'string', 'the row set true produced no note');
  assert.equal(off.instructions, undefined,
    'the row set false still shipped a note -- the owner-visible setting is decorative');
  assert.ok(!Object.prototype.hasOwnProperty.call(off, 'instructions'),
    'the field is present-but-undefined rather than omitted, which serialises differently on the wire');
  console.log('  ✅ the setting is the one that decides.');
}

async function testASessionThatIsNotAnInstallLevelGetsNoNote() {
  console.log('🧪 A session shape that is not one of the three install levels gets no note, not a wrong one...');
  // A remote FRA / manifest binding is a real session, but it is not an install
  // level and must not be described as one. Same for no session at all.
  const manifestish = Object.freeze({ origin: 'remote', tier: 'manifest', profile: undefined });
  const noSession = await handshake({});
  const foreign = await handshake({ permissionSession: manifestish });
  assert.equal(noSession.instructions, undefined, 'a handshake with no permission session invented a note');
  assert.equal(foreign.instructions, undefined, 'a non-install session shape was described as an install level');
  // ...and the handshake itself still succeeds. A session must never fail to
  // start over its own introduction.
  assert.equal(noSession.serverInfo.name, 'toolsenabled');
  assert.equal(foreign.serverInfo.name, 'toolsenabled');
  assert.equal(mcpServer.installTierOfSession(manifestish, policy), undefined);
  for (const tier of policy.INSTALL_TIERS) {
    assert.equal(mcpServer.installTierOfSession(policy.installTierSession(tier), policy), tier,
      `${tier}: a session built from this level did not map back to it`);
  }
  console.log('  ✅ unknown session shape -> no note, handshake intact.');
}

async function testCredentialToolsDescribeThemselvesAsTheCredentialManager() {
  console.log('🧪 The credential tools\' own descriptions steer an agent to our vault...');
  const permissionSession = policy.installTierSession('standard');
  const listed = await mcpServer.dispatch({ ...LIST }, { permissionSession });
  const byName = new Map(listed.tools.map(tool => [tool.name, tool.description]));

  // This is what an MCP client is actually handed and what the model actually
  // reads when it decides which tool answers "I need an API key stored".
  const request = byName.get('system.credential_request');
  assert.equal(typeof request, 'string', 'system.credential_request is not advertised at Standard');
  assert.match(request, /\bAPI key\b/,
    'system.credential_request never says it is how an API key gets stored, so an agent looking for one does not find it');
  assert.match(request, /Windows Credential Manager/,
    'system.credential_request never names Windows Credential Manager as the wrong store');
  assert.match(request, /password manager/,
    'system.credential_request never names a browser/Google password manager as the wrong store');
  // The security facts the old description carried must survive the rewrite.
  assert.match(request, /never returned to the agent/,
    'the rewrite dropped the promise that the entered value never comes back to the agent');
  assert.match(request, /cannot be caller-supplied/,
    'the rewrite dropped the requester-derivation fact');

  const remove = byName.get('system.credential_remove');
  assert.equal(typeof remove, 'string', 'system.credential_remove is not advertised at Standard');
  assert.match(remove, /Windows Credential Manager/,
    'system.credential_remove never says which store it does NOT touch');
  assert.match(remove, /system\.doctor/,
    'system.credential_remove never points at the tool that lists what is stored');

  const doctor = byName.get('system.doctor');
  assert.equal(typeof doctor, 'string', 'system.doctor is not advertised at Standard');
  assert.match(doctor, /present or missing/,
    'system.doctor undersells itself: it never says it reports which credentials are already held');
  console.log('  ✅ all three descriptions lead with purpose and name the wrong stores.');
}

/* THE TEST THAT WOULD HAVE CAUGHT THE DEFECT THE FIRST SIX DID NOT.
 *
 * Every other test in this file runs in a bare process. THE PRODUCT NEVER DOES.
 * Both src/mcp-server.js entries in the generated .mcp.json are spawned with
 * TOOLSENABLED_TOOL_ALLOWLIST stamped on them by
 * src/lib/setup/machine-record.js -- the recorded level's own allowlist on the
 * write-capable entry, read-only-intersect-level on the read-only one -- and
 * registeredTools() applies that variable. So the note's default denominator
 * arrives pre-narrowed to the numerator, the withheld set empties, and the
 * sentence about credentials silently disappears from the served note while
 * every bare-process test still passes.
 *
 * That is exactly what happened: this file was green, and the note the product
 * actually served on a Guided install said only "Not at this level: every tool
 * that changes anything -- this toolkit only reads." Two other lanes measured
 * it from outside before anyone here noticed. A test that runs in conditions
 * the product never runs in is not evidence about the product.
 *
 * AND IT PINS AGREEMENT, NOT JUST CORRECTNESS. The desktop shell composes the
 * same note from the Electron main process, which carries no allowlist. Two
 * paths that are each defensible alone but disagree in one session hand the
 * agent a contradiction it cannot resolve. So the assertion is equality with
 * the shell's own composition, byte for byte, at every level.
 *
 * TWO OF THE THREE LEVELS ARE EVIDENCE; THE THIRD IS NOT, and a later reader
 * must not count it. tierToolAllowlist() answers 106 names at guided, 236 at
 * standard, and NULL at unrestricted -- and machine-record.js:874 stamps
 * TOOLSENABLED_TOOL_ALLOWLIST only when there is a catalogue to stamp. So an
 * unrestricted server carries no allowlist at all, its denominator was never
 * narrowed, and it agrees BY CONSTRUCTION. Measured by reverting the fix in
 * agent-tool-summary.js: guided and standard both DIFFER, unrestricted stays
 * EQUAL. The unrestricted row is a guard against a future change that starts
 * stamping that level, not proof about today. If this test ever goes red at
 * only two of three levels, that is the whole story and not a partial
 * failure. */
async function testTheServedNoteSurvivesTheServersOwnToolAllowlist() {
  const machineRecord = require('../src/lib/setup/machine-record');
  const summary = require('../src/lib/agent-tool-summary');
  const previous = process.env.TOOLSENABLED_TOOL_ALLOWLIST;

  for (const tier of ['guided', 'standard', 'unrestricted']) {
    // Composed FIRST, with the environment still clean: this is the Electron
    // main process's reading, and it must be taken before the env is dirtied.
    const shellNote = summary.briefToolSummary({ tier });
    assert.equal(typeof (shellNote && shellNote.text), 'string',
      `the shell path composed no note at ${tier}`);

    const allowlist = machineRecord.tierToolAllowlist(tier);
    try {
      if (allowlist) process.env.TOOLSENABLED_TOOL_ALLOWLIST = allowlist.join(',');
      else delete process.env.TOOLSENABLED_TOOL_ALLOWLIST;

      const served = (await handshake({ permissionSession: policy.installTierSession(tier) })).instructions;
      assert.equal(typeof served, 'string',
        `${tier}: the handshake carried no instructions under the server's own allowlist`);
      assert.equal(served, shellNote.text,
        `${tier}: the note the server SERVES and the note the desktop shell INJECTS disagree. ` +
        'One session would receive both. Served: ' + JSON.stringify(served.slice(0, 400)));
    } finally {
      if (previous === undefined) delete process.env.TOOLSENABLED_TOOL_ALLOWLIST;
      else process.env.TOOLSENABLED_TOOL_ALLOWLIST = previous;
    }
  }

  // The specific sentence, at the specific level, that the customer's report is
  // about -- asserted by itself so a future regression names itself precisely
  // rather than arriving as a diff of two long strings.
  const guidedAllowlist = machineRecord.tierToolAllowlist('guided');
  try {
    process.env.TOOLSENABLED_TOOL_ALLOWLIST = guidedAllowlist.join(',');
    const served = (await handshake({ permissionSession: policy.installTierSession('guided') })).instructions;
    assert.match(served, /Not at this level: asking for or storing credentials/,
      'Guided: the served note no longer tells the agent that credentials are withheld AT THIS LEVEL -- ' +
      'the sentence whose absence sends agents to Windows Credential Manager');
    assert.match(served, /system.credential_request/,
      'Guided: the served note never names the tool that would ask for a credential');
  } finally {
    if (previous === undefined) delete process.env.TOOLSENABLED_TOOL_ALLOWLIST;
    else process.env.TOOLSENABLED_TOOL_ALLOWLIST = previous;
  }

  console.log('  ✅ the served note survives the server allowlist and matches the shell note, byte for byte.');
}

(async () => {
  await testHandshakeCarriesTheNote();
  await testTheNoteNamesOurCredentialVaultAndNotTheOthers();
  await testTheNoteNeverAdvertisesAToolThisSessionRefuses();
  await testTheSettingDecidesWhetherANoteExists();
  await testASessionThatIsNotAnInstallLevelGetsNoNote();
  await testCredentialToolsDescribeThemselvesAsTheCredentialManager();
  await testTheServedNoteSurvivesTheServersOwnToolAllowlist();
  console.log('\n✅ mcp-initialize-instructions: all tests passed');
})().catch(error => {
  console.error(`\n❌ ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});

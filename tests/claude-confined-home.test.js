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
function signedInUserHome() {
  const home = scratch('user-home');
  fs.writeFileSync(path.join(home, '.credentials.json'), '{"fake":"test-credential"}');
  return home;
}

const defaultHome = (servicesRoot, tier) => path.join(servicesRoot, 'agent-home', 'claude', tier, '@default');

// --- 1. the home is the product's own, and no live home contains another -----

function homeIsBuiltUnderTheProviderSegment() {
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'standard');
  const userHome = signedInUserHome();

  const built = confinement.prepareConfinedClaudeHome(confinement.agentConfinement('standard'), {
    record, servicesRoot, userClaudeHome: userHome
  });

  assert.equal(built.configDir, defaultHome(servicesRoot, 'standard'),
    'the confined Claude home is not at agent-home/claude/<tier>/@default');
  assert.ok(fs.existsSync(built.configDir), 'the home was never created');
  checks += 2;

  // THE COLLISION THIS LAYOUT EXISTS TO AVOID: a codex ACCOUNT named "claude"
  // lives at agent-home/<tier>/claude; the provider segment comes FIRST here,
  // so no account name -- which a person types into a file -- can ever address
  // the Claude provider's directory.
  const codexAccountHome = path.join(servicesRoot, 'agent-home', 'standard', 'claude');
  assert.notEqual(built.configDir.toLowerCase(), codexAccountHome.toLowerCase(),
    'a codex account named "claude" would share the Claude provider home');
  checks += 1;

  // AND NO LIVE HOME CONTAINS ANOTHER: the default home is a SIBLING of the
  // account homes, so nothing the CLI enumerates under one config dir can
  // reach another session's credential. `@` cannot come out of accountSegment,
  // so no account name can claim the default leaf.
  const account = confinement.prepareConfinedClaudeHome(confinement.agentConfinement('standard'), {
    record, servicesRoot, userClaudeHome: signedInUserHome(), accountName: 'edu'
  });
  assert.equal(path.dirname(account.configDir), path.dirname(built.configDir),
    'an account home is nested inside the default home instead of beside it');
  assert.equal(confinement.accountSegment('@default'), 'default',
    'accountSegment can produce the default leaf, so an account could claim it');
  checks += 2;
}

// --- 2. the generated document is written, in the shape this CLI reads -------

function mcpDocumentIsWrittenWithTheStamps() {
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'unrestricted');
  const userHome = signedInUserHome();
  const stateRoot = scratch('state-root');

  const hadStateRoot = Object.hasOwn(process.env, 'TOOLSENABLED_STATE_ROOT');
  const previous = process.env.TOOLSENABLED_STATE_ROOT;
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot;
  let built;
  try {
    built = confinement.prepareConfinedClaudeHome(confinement.agentConfinement('unrestricted'), {
      record, servicesRoot, userClaudeHome: userHome
    });
  } finally {
    if (hadStateRoot) process.env.TOOLSENABLED_STATE_ROOT = previous;
    else delete process.env.TOOLSENABLED_STATE_ROOT;
  }

  assert.equal(built.mcpConfig, path.join(built.configDir, '.mcp.json'),
    'the plan does not name the file it wrote');
  const document = JSON.parse(fs.readFileSync(built.mcpConfig, 'utf8'));
  const names = Object.keys(document.mcpServers || {});
  assert.ok(names.length > 0, 'the generated document names no servers at all');
  assert.deepEqual([...built.servers].sort(), names.sort(),
    'the plan reports a different server list than the file it wrote');
  checks += 3;

  /* THE STAMPS RIDE THE TOOLSENABLED ENTRIES, AND DELIBERATELY NOT THE OTHERS.
   *
   * This loop used to assert the identity stamps on EVERY entry. It had never
   * run: the suite died at check 3 on an unrelated path fault, so nothing
   * exercised it. It is wrong, and wrong in the dangerous direction --
   * satisfying it would mean handing the opaque session bearer to Playwright,
   * which src/lib/setup/machine-record.js refuses on purpose:
   *
   *   "do not hand the opaque authority bearer to Playwright or any other
   *    catalogue child merely because it shares this generated document."
   *
   * The rule is `server.script === 'src/mcp-server.js'`: only the ToolsEnabled
   * broker consumes the agent-session identity. So the boundary is asserted in
   * BOTH directions below -- the broker must carry it, and a catalogue child
   * must not -- which is the property that actually matters and the one a
   * regression would break. */
  const brokerEntries = [];
  const catalogueEntries = [];
  for (const [name, entry] of Object.entries(document.mcpServers)) {
    const argv = [entry.command, ...(entry.args || [])].join(' ').replace(/\\/g, '/');
    (argv.includes('src/mcp-server.js') ? brokerEntries : catalogueEntries).push([name, entry]);
  }
  assert.ok(brokerEntries.length > 0, 'no ToolsEnabled broker entry was generated at all');
  checks += 1;

  for (const [name, entry] of catalogueEntries) {
    assert.equal(entry.env && entry.env.TOOLSENABLED_AGENT_ACTOR, undefined,
      `${name} is a catalogue child and must not be told which assistant called`);
    assert.equal(entry.env && entry.env.TOOLSENABLED_AGENT_SESSION_CREDENTIAL, undefined,
      `${name} is a catalogue child and must never receive the session bearer`);
    checks += 2;
  }

  for (const [name, entry] of brokerEntries) {
    assert.equal(entry.env && entry.env.TOOLSENABLED_AGENT_ACTOR, 'claude',
      `${name} does not name the calling assistant`);
    assert.equal(entry.env && entry.env.TOOLSENABLED_STATE_ROOT, stateRoot,
      `${name} does not carry the application's own state root`);
    // On a checkout the runtime is a plain node and needs no ELECTRON_RUN_AS_NODE;
    // the packaged-runtime case is the refusal asserted below.
    checks += 2;
  }

  // THE GRANT AND THE CEILING, in the home's own settings.json. The rule
  // grammar comes from the adapter -- the module that owns this CLI's other
  // measured strings -- so a CLI bump has one place to update. defaultMode
  // writes the tier's mode INTO the home, so the file bounds what the argv
  // bounds, the same both-places rule the codex config.toml follows.
  const settings = JSON.parse(fs.readFileSync(path.join(built.configDir, 'settings.json'), 'utf8'));
  assert.deepEqual(
    [...settings.permissions.allow].sort(),
    names.map(name => `mcp__${name}`).sort(),
    'the settings grant does not match the servers the plan configured'
  );
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions',
    'the home does not state the tier\'s own permission mode');
  assert.deepEqual(Object.keys(settings), ['permissions'],
    'the confined settings.json carries more than the permission block');
  checks += 3;
}

function malformedEntriesAreRefusedIdenticallyToTheTomlSide() {
  // ONE VALIDATOR, BOTH RENDERINGS. Before it existed the codex side refused
  // malformed entries as a side effect of TOML quoting while the JSON side
  // wrote them verbatim -- advertised-but-broken servers on exactly one
  // engine. Each shape gets its typed refusal, on BOTH renderings.
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'standard');
  const userHome = signedInUserHome();
  const tier = confinement.agentConfinement('standard');
  const prepareWith = mcpServers => () => confinement.prepareConfinedClaudeHome(tier, {
    record, servicesRoot, userClaudeHome: userHome,
    generate: () => ({ document: { mcpServers }, skipped: [] })
  });

  // A name outside the identifier rule, and a name whose `__` would turn the
  // server-wide grant into a grant for TOOL `b` of SERVER `a` -- a different
  // principal than the plan named.
  for (const name of ['evil name!', 'a__b']) {
    assert.throws(prepareWith({ [name]: { command: process.execPath, args: [] } }),
      error => error.code === 'AGENT_CONFINEMENT_HOME_UNWRITABLE', `name ${JSON.stringify(name)}`);
    assert.throws(
      () => confinement.confinedCodexConfig(tier, { mcpServers: { [name]: { command: process.execPath, args: [] } } }),
      error => error.code === 'AGENT_CONFINEMENT_HOME_UNWRITABLE', `codex rendering, name ${JSON.stringify(name)}`);
    checks += 2;
  }
  // An entry that is not an object, and a command that is missing -- which
  // would otherwise sail past the runtime check, because
  // runtimeNeedsNodeMode(undefined) is false.
  assert.throws(prepareWith({ toolsenabled: null }),
    error => error.code === 'AGENT_CONFINEMENT_SERVER_ENTRY_INVALID');
  assert.throws(prepareWith({ toolsenabled: { args: [] } }),
    error => error.code === 'AGENT_CONFINEMENT_SERVER_COMMAND_INVALID');
  checks += 2;
}

function aPackagedRuntimeWithoutNodeModeIsRefused() {
  // MEASURED 2026-08-18 on the codex side and exactly as fatal here: an entry
  // whose command is the packaged app without ELECTRON_RUN_AS_NODE starts a
  // second copy of the application instead of a server. The two renderings of
  // the one document must refuse it identically.
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'standard');
  const userHome = signedInUserHome();
  const packagedEntry = {
    command: path.join(servicesRoot, 'App.exe'),
    args: [path.join(servicesRoot, 'mcp-server.js')],
    cwd: servicesRoot
  };

  assert.throws(
    () => confinement.prepareConfinedClaudeHome(confinement.agentConfinement('standard'), {
      record, servicesRoot, userClaudeHome: userHome,
      generate: () => ({ document: { mcpServers: { toolsenabled: { ...packagedEntry } } }, skipped: [] })
    }),
    error => error.code === 'AGENT_CONFINEMENT_RUNTIME_NOT_NODE'
  );
  checks += 1;

  // And WITH the stamp the same entry is written through verbatim.
  const built = confinement.prepareConfinedClaudeHome(confinement.agentConfinement('standard'), {
    record, servicesRoot, userClaudeHome: userHome,
    generate: () => ({
      document: { mcpServers: { toolsenabled: { ...packagedEntry, env: { ELECTRON_RUN_AS_NODE: '1' } } } },
      skipped: []
    })
  });
  const written = JSON.parse(fs.readFileSync(built.mcpConfig, 'utf8'));
  assert.equal(written.mcpServers.toolsenabled.env.ELECTRON_RUN_AS_NODE, '1');
  checks += 1;

  // The runtime check consults the INJECTED machine-record module, so the seam
  // a test injects is the seam the refusal reads. A stub that calls every
  // runtime non-Node must refuse even a plain node command.
  assert.throws(
    () => confinement.prepareConfinedClaudeHome(confinement.agentConfinement('standard'), {
      record, servicesRoot, userClaudeHome: userHome,
      machineRecord: { ...machineRecord, runtimeNeedsNodeMode: () => true },
      generate: () => ({ document: { mcpServers: { toolsenabled: { command: process.execPath, args: [] } } }, skipped: [] })
    }),
    error => error.code === 'AGENT_CONFINEMENT_RUNTIME_NOT_NODE',
    'the runtime check bypassed the injected machine-record module'
  );
  checks += 1;
}

// --- 3. the credential: linked, refreshed, forked, and revoked ----------------

function credentialIsLinkedAndRefreshedOnEveryPrepare() {
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'standard');
  const userHome = signedInUserHome();
  const tier = confinement.agentConfinement('standard');

  const built = confinement.prepareConfinedClaudeHome(tier, { record, servicesRoot, userClaudeHome: userHome });
  const target = path.join(built.configDir, '.credentials.json');
  assert.ok(fs.existsSync(target), 'no credential reached the confined home');
  /* 'copy' is legitimate on a volume that cannot hard-link (os.tmpdir() on
     exFAT or a network profile); what MATTERS is the refresh contract below,
     which both modes must honour. On a linking volume the mode must be the
     link, because a copy is a second credential on disk. */
  const linking = (() => {
    const probe = path.join(scratch('probe'), 'a');
    fs.writeFileSync(probe, 'x');
    try { fs.linkSync(probe, `${probe}-link`); return true; } catch { return false; }
  })();
  if (linking) assert.equal(built.credential, 'hardlink', 'a linking volume must link, not copy');
  else assert.equal(built.credential, 'copy');
  checks += 2;

  if (linking) {
    // One file, two names: bytes written through the SOURCE name are visible
    // through the target name. (Fake test bytes; nothing here is a credential.)
    fs.writeFileSync(path.join(userHome, '.credentials.json'), '{"fake":"rotated-in-place"}');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"fake":"rotated-in-place"}',
      'the confined home holds a second copy rather than a second name');
    checks += 1;
  }

  // A NEW SIGN-IN replaces the source through a rename, which leaves an
  // existing link pointing at the superseded inode. Re-preparing must re-link.
  fs.rmSync(path.join(userHome, '.credentials.json'));
  fs.writeFileSync(path.join(userHome, '.credentials.json'), '{"fake":"renamed-replacement"}');
  confinement.prepareConfinedClaudeHome(tier, { record, servicesRoot, userClaudeHome: userHome });
  assert.equal(fs.readFileSync(target, 'utf8'), '{"fake":"renamed-replacement"}',
    'a re-prepare kept the stale link, so a running session would sign in as yesterday');
  checks += 1;
}

function aRefreshedConfinedCredentialIsKeptNotResurrected() {
  // THE FORK. A confined session's own token refresh rewrites the credential
  // under the CONFINED name (temp file + rename), splitting the hard link:
  // the newest token lives here, the person's own home keeps the superseded
  // one. Re-linking blindly would resurrect the OLDER token over the newer --
  // and with provider-side refresh-token rotation, that kills the agent's
  // sign-in without fixing anybody's. The newer side must win.
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'standard');
  const userHome = signedInUserHome();
  const tier = confinement.agentConfinement('standard');

  const built = confinement.prepareConfinedClaudeHome(tier, { record, servicesRoot, userClaudeHome: userHome });
  const target = path.join(built.configDir, '.credentials.json');

  // The confined session refreshes: its name is replaced with new bytes...
  fs.rmSync(target);
  fs.writeFileSync(target, '{"fake":"refreshed-by-the-session"}');
  // ...and the person's own file is the OLDER of the two.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(userHome, '.credentials.json'), past, past);

  const reprepared = confinement.prepareConfinedClaudeHome(tier, { record, servicesRoot, userClaudeHome: userHome });
  assert.equal(reprepared.credential, 'kept-refreshed');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"fake":"refreshed-by-the-session"}',
    'the superseded token was resurrected over the refreshed one');
  checks += 2;

  // The other direction still heals: when the person signs in FRESH (their
  // side newer), the new sign-in wins and is re-linked.
  const older = new Date(Date.now() - 120_000);
  fs.utimesSync(target, older, older);
  fs.rmSync(path.join(userHome, '.credentials.json'));
  fs.writeFileSync(path.join(userHome, '.credentials.json'), '{"fake":"fresh-sign-in"}');
  confinement.prepareConfinedClaudeHome(tier, { record, servicesRoot, userClaudeHome: userHome });
  assert.equal(fs.readFileSync(target, 'utf8'), '{"fake":"fresh-sign-in"}');
  checks += 1;
}

function aSignedOutHomeRefusesAndLeavesNothingStartable() {
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'standard');
  const userHome = signedInUserHome();
  const tier = confinement.agentConfinement('standard');

  // A complete, working home from an earlier prepare...
  const built = confinement.prepareConfinedClaudeHome(tier, { record, servicesRoot, userClaudeHome: userHome });
  assert.ok(fs.existsSync(path.join(built.configDir, '.credentials.json')));

  // ...then the person signs out: their own credential file is gone.
  fs.rmSync(path.join(userHome, '.credentials.json'));
  assert.throws(
    () => confinement.prepareConfinedClaudeHome(tier, { record, servicesRoot, userClaudeHome: userHome }),
    error => error.code === 'AGENT_CONFINEMENT_SIGNED_OUT'
  );
  checks += 2;

  // NOTHING STARTABLE SURVIVES. The linked credential's bytes would otherwise
  // outlive the person's own revocation, beside a tool document and a grant
  // pre-approving it -- a durable authenticated artifact that is not this
  // product's to keep.
  for (const file of ['.credentials.json', '.mcp.json', 'settings.json']) {
    assert.ok(!fs.existsSync(path.join(built.configDir, file)),
      `${file} survived the sign-out refusal`);
    checks += 1;
  }
}

// --- 4. the account fence is the one planted memory surface -----------------

function accountFenceIsSyncedIntoEveryConfinedClaudeHome() {
  const accountHome = scratch('account-home');
  const fencePath = path.join(accountHome, 'ACCOUNT-FENCE.md');
  const firstFence = Buffer.from(`# local account fence\nfirst-${process.pid}\n`);
  fs.writeFileSync(fencePath, firstFence);
  const cases = [
    { tier: 'guided', servicesRoot: scratch('fence-guided'), accountName: null },
    { tier: 'standard', servicesRoot: scratch('fence-standard'), accountName: 'Work Account' },
    { tier: 'unrestricted', servicesRoot: scratch('fence-unrestricted'), accountName: null }
  ];

  for (const item of cases) {
    const built = confinement.prepareConfinedClaudeHome(confinement.agentConfinement(item.tier), {
      servicesRoot: item.servicesRoot,
      userClaudeHome: signedInUserHome(),
      accountHome,
      accountName: item.accountName,
      record: null
    });
    assert.deepEqual(
      fs.readFileSync(path.join(built.configDir, 'CLAUDE.md')),
      firstFence,
      `${item.tier}/${item.accountName || '@default'} did not receive the current account fence bytes`
    );
    checks += 1;
  }

  const refreshedFence = Buffer.from(`# local account fence\nrefreshed-${process.pid}\n`);
  fs.writeFileSync(fencePath, refreshedFence);
  for (const item of cases) {
    const rebuilt = confinement.prepareConfinedClaudeHome(confinement.agentConfinement(item.tier), {
      servicesRoot: item.servicesRoot,
      userClaudeHome: signedInUserHome(),
      accountHome,
      accountName: item.accountName,
      record: null
    });
    assert.deepEqual(
      fs.readFileSync(path.join(rebuilt.configDir, 'CLAUDE.md')),
      refreshedFence,
      `${item.tier}/${item.accountName || '@default'} retained stale account-fence bytes`
    );
    checks += 1;
  }
}

function noMemoryFileIsPlantedInTheConfinedHome() {
  // The whole point of the isolation: the session's user-memory surface is the
  // pointed directory's CLAUDE.md, so the confined home must start with NONE --
  // not a copy of anyone's, and not a product essay pretending to be the
  // person's memory. What the session itself writes there later is its own.
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'guided');
  const accountHome = scratch('account-home-without-fence');
  const userClaudeHome = signedInUserHome();
  const built = confinement.prepareConfinedClaudeHome(confinement.agentConfinement('guided'), {
    record, servicesRoot, userClaudeHome, accountHome
  });
  assert.ok(!fs.existsSync(path.join(built.configDir, 'CLAUDE.md')),
    'the confined home was given a CLAUDE.md nobody wrote');
  fs.writeFileSync(path.join(built.configDir, 'CLAUDE.md'), 'stale directives from an earlier account\n');
  confinement.prepareConfinedClaudeHome(confinement.agentConfinement('guided'), {
    record, servicesRoot, userClaudeHome, accountHome
  });
  assert.ok(!fs.existsSync(path.join(built.configDir, 'CLAUDE.md')),
    'an absent current fence retained stale CLAUDE.md directives');
  checks += 2;
}

// --- 5. one home per account, chosen by name, and NAMED so slugs cannot lie --

function accountsGetTheirOwnHomes() {
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'standard');
  const tier = confinement.agentConfinement('standard');
  const first = confinement.prepareConfinedClaudeHome(tier, {
    record, servicesRoot, userClaudeHome: signedInUserHome(), accountName: 'Work Account'
  });
  const second = confinement.prepareConfinedClaudeHome(tier, {
    record, servicesRoot, userClaudeHome: signedInUserHome(), accountName: 'personal'
  });
  assert.equal(first.configDir, path.join(servicesRoot, 'agent-home', 'claude', 'standard', 'work-account'));
  assert.equal(second.configDir, path.join(servicesRoot, 'agent-home', 'claude', 'standard', 'personal'));
  assert.equal(first.account, 'Work Account');
  checks += 3;
}

function slugCollisionsAreRefusedByTheHomeItself() {
  // accountSegment() is lossy by design, so two DIFFERENT names can share one
  // leaf: Win32 drops a trailing dot at create time, so `work` and `work.`
  // are one directory. The home records WHOSE it is on first prepare, and a
  // second name resolving to the same folder is refused rather than silently
  // re-signing a possibly-running session as somebody else.
  assert.equal(confinement.accountSegment('work.'), 'work',
    'the sanitizer keeps a trailing dot Win32 would silently drop');
  checks += 1;

  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'standard');
  const tier = confinement.agentConfinement('standard');
  confinement.prepareConfinedClaudeHome(tier, {
    record, servicesRoot, userClaudeHome: signedInUserHome(), accountName: 'work'
  });
  assert.throws(
    () => confinement.prepareConfinedClaudeHome(tier, {
      record, servicesRoot, userClaudeHome: signedInUserHome(), accountName: 'Work.'
    }),
    error => error.code === 'AGENT_CONFINEMENT_ACCOUNT_COLLISION'
  );
  // The SAME account keeps working; the marker refuses different names only.
  confinement.prepareConfinedClaudeHome(tier, {
    record, servicesRoot, userClaudeHome: signedInUserHome(), accountName: 'work'
  });
  checks += 2;
}

// --- 6. the legacy copied-home plan ------------------------------------------
// This surface has no native-tool restriction transport. Its historical home
// and account cases explicitly select Enabled; the shipped Only surface is
// exercised separately below without changing the default setting.

function planCarriesEverythingAStartNeeds() {
  const servicesRoot = scratch('root');
  writeRecord(servicesRoot, 'standard');
  const userHome = signedInUserHome();

  const plan = confinement.confinedClaudeSessionPlan({ agentApiMode: 'Enabled', servicesRoot, userClaudeHome: userHome });
  assert.equal(plan.ok, true);
  assert.equal(plan.tier, 'standard');
  assert.equal(plan.isolated, true);
  assert.deepEqual(plan.threadOptions, { sandbox: 'workspace-write', approvalPolicy: 'never' });
  assert.equal(plan.configDir, defaultHome(servicesRoot, 'standard'));
  assert.equal(plan.mcpConfig, path.join(plan.configDir, '.mcp.json'));
  assert.ok(fs.existsSync(plan.mcpConfig), 'the plan names a file that was never written');
  assert.ok(Array.isArray(plan.servers) && plan.servers.length > 0, 'the plan carries no servers');
  /* The recorded level's CLI mode rides the plan, so the one recorded level
     has ONE reader instead of a second table derived from the sandbox word. */
  assert.equal(plan.claudePermissionMode, 'acceptEdits');
  // The sign-in travels as `configDir`; the environment carries only the owning
  // account's ordinary profile roots, never a second CLAUDE_CONFIG_DIR selector.
  assert.equal(plan.env.USERPROFILE, confinement.installationProfileRoot());
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, undefined);
  checks += 10;
}

function planRefusesRatherThanFallingBackToTheOwnersHome() {
  const servicesRoot = scratch('root');
  writeRecord(servicesRoot, 'standard');
  const emptyHome = scratch('signed-out');

  const plan = confinement.confinedClaudeSessionPlan({ agentApiMode: 'Enabled', servicesRoot, userClaudeHome: emptyHome });
  assert.equal(plan.ok, false, 'a home that could not be built still reported a startable plan');
  assert.equal(plan.code, 'AGENT_CONFINEMENT_SIGNED_OUT');
  assert.equal(plan.configDir, null,
    'a failed plan still points at a directory, which the shell would pass to the spawn');
  assert.equal(plan.mcpConfig, null);
  assert.deepEqual([...plan.servers], []);
  // The process ceiling is already resolved and still stated, so a caller that
  // reports the refusal can say what level it WOULD have run at.
  assert.deepEqual(plan.threadOptions, { sandbox: 'workspace-write', approvalPolicy: 'never' });
  checks += 6;
}

function planPinsTheAccountItWasGiven() {
  const servicesRoot = scratch('root');
  writeRecord(servicesRoot, 'standard');
  const accountHome = signedInUserHome();

  const plan = confinement.confinedClaudeSessionPlan({ agentApiMode: 'Enabled',
    servicesRoot,
    account: { name: 'edu', resolvedHome: accountHome }
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.account, 'edu');
  assert.equal(plan.configDir, path.join(servicesRoot, 'agent-home', 'claude', 'standard', 'edu'));
  assert.ok(fs.existsSync(path.join(plan.configDir, '.credentials.json')),
    'the account\'s own sign-in never reached the account\'s own confined home');
  checks += 4;
}

function malformedAccountsAreRefusedNotHelped() {
  // Both of these used to run as the WRONG IDENTITY while every visible signal
  // said success: a string account was silently DISCARDED (session from the
  // owner's default home, account: null), and an account object with no
  // resolvedHome spread `undefined` into the prepare, fired its destructuring
  // default, and linked the OWNER'S credential into a home wearing somebody
  // else's name.
  const servicesRoot = scratch('root');
  writeRecord(servicesRoot, 'standard');

  const asString = confinement.confinedClaudeSessionPlan({ agentApiMode: 'Enabled', servicesRoot, account: 'work' });
  assert.equal(asString.ok, false);
  assert.equal(asString.code, 'AGENT_CONFINEMENT_ACCOUNT_INVALID');

  const noHome = confinement.confinedClaudeSessionPlan({ agentApiMode: 'Enabled', servicesRoot, account: { name: 'edu' } });
  assert.equal(noHome.ok, false);
  assert.equal(noHome.code, 'AGENT_CONFINEMENT_ACCOUNT_UNRESOLVED');
  assert.equal(noHome.account, 'edu');

  // The codex plan is built by the same builder and must refuse identically.
  const codexString = confinement.confinedSessionPlan({ agentApiMode: 'Enabled', servicesRoot, account: 'work' });
  assert.equal(codexString.ok, false);
  assert.equal(codexString.code, 'AGENT_CONFINEMENT_ACCOUNT_INVALID');
  checks += 6;
}

function aCallerSuppliedRecordCannotOutvoteTheDisk() {
  // `...options` is spread FIRST and the resolved values LAST, and this is the
  // assertion that keeps that ordering: a hostile or stale `record` key would
  // otherwise write one tier's tool width into another tier's home, because
  // resolveAgentConfinement() ignores options.record while the generator would
  // not -- tier and document desyncing inside one plan.
  const servicesRoot = scratch('root');
  writeRecord(servicesRoot, 'guided');
  const wideRecord = machineRecord.buildMachineRecord({
    tier: 'unrestricted',
    installRoot: path.join(__dirname, '..'),
    servicesRoot: scratch('elsewhere'),
    nodePath: process.execPath,
    workspaceRoots: [scratch('ws')]
  });

  const plan = confinement.confinedClaudeSessionPlan({ agentApiMode: 'Enabled',
    servicesRoot, userClaudeHome: signedInUserHome(), record: wideRecord
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.tier, 'guided', 'the caller-supplied record outvoted the disk record');
  assert.equal(plan.claudePermissionMode, 'plan');
  // Guided generates the read-only server and nothing else; an unrestricted
  // document here would be the desync this test exists to catch.
  assert.deepEqual([...plan.servers], ['toolsenabled-readonly']);
  checks += 4;
}

function theTwoEnginesPlansShareOneShape() {
  // The builder is shared so the two engines cannot drift apart in what a plan
  // carries. Outside each engine's own surface fields, the key sets are the
  // SAME -- for success and for refusal alike -- so a caller that learns one
  // plan's shape has learned both.
  const servicesRoot = scratch('root');
  writeRecord(servicesRoot, 'standard');
  const claudeSurface = ['configDir', 'mcpConfig', 'claudePermissionMode'];
  const codexSurface = ['codexHome'];
  const shared = plan => Object.keys(plan).filter(key => ![...claudeSurface, ...codexSurface].includes(key)).sort();

  const codexHome = scratch('codex-user');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"fake":"test"}');
  const codexOk = confinement.confinedSessionPlan({ agentApiMode: 'Enabled', servicesRoot, userCodexHome: codexHome });
  const claudeOk = confinement.confinedClaudeSessionPlan({ agentApiMode: 'Enabled', servicesRoot, userClaudeHome: signedInUserHome() });
  assert.equal(codexOk.ok, true);
  assert.equal(claudeOk.ok, true);
  assert.deepEqual(shared(claudeOk), shared(codexOk),
    'the two engines\' successful plans no longer share a shape');

  const codexRefused = confinement.confinedSessionPlan({ agentApiMode: 'Enabled', servicesRoot, userCodexHome: scratch('empty') });
  const claudeRefused = confinement.confinedClaudeSessionPlan({ agentApiMode: 'Enabled', servicesRoot, userClaudeHome: scratch('empty') });
  assert.equal(codexRefused.ok, false);
  assert.equal(claudeRefused.ok, false);
  assert.deepEqual(shared(claudeRefused), shared(codexRefused),
    'the two engines\' refusals no longer share a shape');
  /* And within one engine, success and refusal answer the same keys, so a
     caller never learns a field's existence from the outcome. */
  assert.deepEqual(Object.keys(claudeOk).sort(), Object.keys(claudeRefused).sort());
  checks += 5;
}

// --- 9. THE SHIPPED PATH: tools by argument, no home, no credential ----------

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
  assert.equal(surface.configDir, path.join(profileRoot, '.claude'),
    'the shipped surface did not pin the existing config directory in the owning profile');
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
  assert.equal(plan.configDir, path.join(profileRoot, '.claude'));
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

function aRefusalThatIsNotASignOutKeepsTheCredential() {
  // THE CROSS-ACCOUNT DENIAL OF SERVICE, in the shape that made it reachable.
  // scrubStartableHome() runs in the catch of EVERY prepare failure, but the
  // try opens well before the credential is linked -- and assertAccountMarker()
  // throws FIRST. So merely ATTEMPTING to start under a second account name
  // that slugs to the same folder ("work." beside "work") used to delete the
  // sign-in out of the FIRST account's home, possibly while a session was
  // running from it. Nobody signed out; a name did that.
  const servicesRoot = scratch('root');
  const record = writeRecord(servicesRoot, 'standard');
  const userHome = signedInUserHome();
  const tier = confinement.agentConfinement('standard');

  const built = confinement.prepareConfinedClaudeHome(tier, {
    record, servicesRoot, userClaudeHome: userHome, accountName: 'work'
  });
  const credential = path.join(built.configDir, '.credentials.json');
  assert.ok(fs.existsSync(credential));

  assert.throws(
    () => confinement.prepareConfinedClaudeHome(tier, {
      record, servicesRoot, userClaudeHome: userHome, accountName: 'work.'
    }),
    error => error.code === 'AGENT_CONFINEMENT_ACCOUNT_COLLISION'
  );
  assert.ok(fs.existsSync(credential),
    'a colliding account NAME deleted the other account\'s sign-in; that is a denial of service, not a scrub');
  checks += 3;

  // The generated pair is still scrubbed on that refusal -- they are the
  // product's own and cost nothing to rewrite.
  for (const file of ['.mcp.json', 'settings.json']) {
    assert.ok(!fs.existsSync(path.join(built.configDir, file)), `${file} survived a refusal`);
    checks += 1;
  }

  // And a REAL sign-out still takes the credential with it (the P0-C rule).
  fs.rmSync(path.join(userHome, '.credentials.json'));
  assert.throws(
    () => confinement.prepareConfinedClaudeHome(tier, {
      record, servicesRoot, userClaudeHome: userHome, accountName: 'work'
    }),
    error => error.code === 'AGENT_CONFINEMENT_SIGNED_OUT'
  );
  assert.ok(!fs.existsSync(credential), 'the sign-in outlived the revocation it was linked from');
  checks += 2;
}

function theCodexRenderingConsultsTheInjectedRuntimeSeam() {
  // The function's own comment promises "the seam a test injects is the seam
  // this consults", and the JSON rendering passed its injected module while
  // the TOML rendering dropped it -- so the codex path silently consulted the
  // real module and its runtime tests were not testing the seam they named.
  const tier = confinement.agentConfinement('standard');
  const packaged = { mcpServers: { toolsenabled: { command: 'C:\\app\\ToolsEnabled.exe', args: [] } } };
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

const suites = [
  theToolSurfaceCarriesToolsAndOnlyPointsAtTheOwnedCredentialHome,
  theShippedPlanPinsTheOwnedHomeWithoutCopyingACredential,
  aRefusalThatIsNotASignOutKeepsTheCredential,
  theCodexRenderingConsultsTheInjectedRuntimeSeam,
  homeIsBuiltUnderTheProviderSegment,
  mcpDocumentIsWrittenWithTheStamps,
  malformedEntriesAreRefusedIdenticallyToTheTomlSide,
  aPackagedRuntimeWithoutNodeModeIsRefused,
  credentialIsLinkedAndRefreshedOnEveryPrepare,
  aRefreshedConfinedCredentialIsKeptNotResurrected,
  aSignedOutHomeRefusesAndLeavesNothingStartable,
  accountFenceIsSyncedIntoEveryConfinedClaudeHome,
  noMemoryFileIsPlantedInTheConfinedHome,
  accountsGetTheirOwnHomes,
  slugCollisionsAreRefusedByTheHomeItself,
  planCarriesEverythingAStartNeeds,
  planRefusesRatherThanFallingBackToTheOwnersHome,
  planPinsTheAccountItWasGiven,
  malformedAccountsAreRefusedNotHelped,
  aCallerSuppliedRecordCannotOutvoteTheDisk,
  theTwoEnginesPlansShareOneShape
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

for (const directory of temporary) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} - claude-confined-home (${checks} checks, ${failures} failing)\n`);
process.exitCode = failures === 0 ? 0 : 1;

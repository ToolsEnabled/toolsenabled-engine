'use strict';

// THE RECORDED LEVEL NOW CONFINES A RUNNING ASSISTANT'S TOOL SURFACE.
//
// First-run setup asks one question -- "how much should the assistant be allowed
// to do?" -- and records the answer. Until this suite, that answer shaped only
// the read-only server: a `standard` install generated a `toolsenabled` server
// with NO allowlist, which src/lib/tool-registry.js reads as the full 307-tool
// surface, `host.exec` included. The level whose own words are "cannot reach the
// rest of the computer" handed over the tool that runs any program on it.
//
// WHAT IS PROVED HERE, AND WHAT IS NOT. Every case below drives the REAL
// dispatch seam -- src/mcp-server.js `processLine()` -- under exactly the
// environment the generated `.mcp.json` hands that server. A tool outside the
// recorded level is refused there, on every call, by the server itself.
//
// THE SEAM MOVED UNDER THIS SUITE, AND THIS COMMENT SAID OTHERWISE FOR A WHILE.
// When these cases were written, `start()` called `processLine(line)` with no
// options, so passing none here WAS the production shape. It since resolves a
// permission session once at startup and calls
// `processLine(line, undefined, {...options, permissionSession})`. So the
// two-argument calls below now isolate ONE axis -- the generated
// TOOLSENABLED_TOOL_ALLOWLIST, which is what this lane built -- rather than
// reproducing the whole production call. That is still worth proving on its own,
// because it is the only narrowing that applies to a client which supplies its
// own session; it is simply not the same claim, and saying it was would be this
// suite asserting a fidelity it no longer has. The composition of the two
// mechanisms is proved separately, in section 6.
//
// That is the TOOL surface and only the tool surface. The OS-level sandbox that
// would bound the agent process's own file reads and writes
// (`codex --sandbox workspace-write`, `claude --permission-mode`) is the other
// half of T5, lives in src/lib/mission-bridge/actions.js, and is not built. Nor
// does any of this reach the Codex lane, which disables every MCP server
// outright (actions.js: `mcp_servers.toolsenabled.enabled=false`) and so is
// confined by nothing written here. The disclosure the product shows at the
// point of choice is therefore NOT relaxed by this suite.
//
// PROBES DO NOT EXECUTE ANYTHING. Every call carries one property no tool's
// closed schema accepts, so an ADMITTED tool stops at schema validation --
// which runs strictly after the allowlist and tier checks -- and a REFUSED tool
// never gets that far. `INVALID_PARAMS` naming the probe therefore means
// "this level would have let it run", with nothing run.

const isolated = require('./lib/isolated-environment').activate('install-tier-enforcement');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const policy = require('../src/lib/permission-tier-policy');
const machineRecord = require('../src/lib/setup/machine-record');
const { TOOL_REGISTRY, executeTool } = require('../src/lib/tool-registry');
const mcpServer = require('../src/mcp-server');

void isolated;

const REPO_ROOT = path.resolve(__dirname, '..');
const ALLOWLIST_ENV = 'TOOLSENABLED_TOOL_ALLOWLIST';
const PROBE = Object.freeze({ __install_tier_probe__: true });

let checks = 0;
const check = (description, fn) => { fn(); checks += 1; void description; };

function recordFor(tier) {
  return machineRecord.buildMachineRecord({
    tier,
    installRoot: REPO_ROOT,
    servicesRoot: path.join(os.tmpdir(), 'install-tier-enforcement-services'),
    nodePath: process.execPath,
    workspaceRoots: [path.join(os.tmpdir(), 'install-tier-enforcement-workspace')]
  });
}

// The environment the generated configuration actually hands the write-capable
// server, per level. Read for every level BEFORE any of them is applied,
// because the derivation itself reads this variable: computing one level's list
// while another level's list is in force would narrow it twice and prove
// nothing about either.
function generatedServerEnvironments() {
  const byTier = {};
  for (const tier of machineRecord.TIERS) {
    const servers = machineRecord.generateMcpConfig(recordFor(tier)).document.mcpServers;
    const entry = servers.toolsenabled || servers['toolsenabled-readonly'];
    assert.ok(entry, `${tier}: the generated configuration must carry an assistant server`);
    byTier[tier] = entry.env === undefined ? undefined : entry.env[ALLOWLIST_ENV];
  }
  return byTier;
}

function applyGeneratedEnvironment(value) {
  if (value === undefined) delete process.env[ALLOWLIST_ENV];
  else process.env[ALLOWLIST_ENV] = value;
}

// One JSON line into src/mcp-server.js, shaped exactly as the stdio transport
// shapes it, with no options object -- so nothing in this test can supply a
// narrowing the real server would not have.
// BIND THE SESSION THE WAY THE RUNNING SERVER DOES.
//
// This called processLine() with no options, so no permission session reached
// the dispatcher -- and executeTool() now refuses an unbound dispatch outright,
// which made every row here fail. The refusal is correct; this helper was the
// thing that was wrong. In production nothing calls processLine() unbound:
// start() resolves the session ONCE from the machine record before reading the
// first line, and both remote bridges construct their own and pass it in.
//
// So this now does what start() does, using the level the row is exercising --
// which makes the helper MORE faithful to production, not less. The verdicts
// are unchanged, because assertToolRegistered() runs before the tier check and
// the generated allowlist is still what refuses the 'refused' rows; the tier is
// a second, independent boundary behind it.
async function callThroughServer(name, id, tier) {
  let response = null;
  await mcpServer.processLine(
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: PROBE } }),
    value => { response = value; },
    { permissionSession: policy.installTierSession(tier) }
  );
  assert.ok(response, `${name}: the server produced no response`);
  return response;
}

// WHICH GATE REFUSED, NOT MERELY THAT ONE DID.
//
// This returned a single 'refused' for any refusal, and that made the rows below
// kill their mutants BY ACCIDENT. Removing the generated allowlist entirely does
// not make a row dispatch -- the tier refuses it a moment later -- so the row
// still failed, but only because a tier refusal fell through to the
// `unexpected:` branch. Anyone tidying this function to treat every PERMISSION_*
// refusal as 'refused' would have made the suite green with the whole mechanism
// this lane built deleted. That is the vacuity this file exists to prevent,
// reintroduced by the shape of the check rather than by any assertion.
//
// So the two refusals are now distinct verdicts and the rows name the one they
// mean. Both boundaries are real and this suite asserts both: the allowlist is
// what refuses first, and the tier stands behind it independently.
function serverVerdict(response) {
  const serialised = JSON.stringify(response);
  if (/not registered in the current MCP profile/.test(serialised)) return 'refused-by-allowlist';
  if (/PERMISSION_[A-Z_]+/.test(serialised)) return 'refused-by-tier';
  if (/__install_tier_probe__/.test(serialised)) return 'admitted';
  return `unexpected: ${serialised.slice(0, 200)}`;
}

async function main() {
  // --- 1. ONE VOCABULARY -----------------------------------------------------

  check('the level list the record validates against is the list the policy enforces', () => {
    assert.equal(machineRecord.TIERS, policy.INSTALL_TIERS,
      'machine-record.TIERS must BE the policy list, not a second copy that can drift from it');
    assert.deepEqual([...policy.INSTALL_TIERS], ['guided', 'standard', 'unrestricted']);
  });

  check('each recorded level resolves to exactly one enforced session', () => {
    assert.deepEqual(
      policy.INSTALL_TIERS.map(tier => {
        const resolved = policy.installTierSession(tier);
        return `${tier}=${resolved.origin}/${resolved.tier}/${resolved.profile || '-'}`;
      }),
      ['guided=local/confined/read-only', 'standard=local/confined/workspace', 'unrestricted=local/full/-']
    );
    assert.ok(policy.TIERS.includes('confined'));
    // Confined is a LOCAL installation's level. The remote lanes stay Guarded
    // (8788) and Manifest (8790); neither may borrow this word to widen itself.
    assert.throws(() => policy.session({ origin: 'remote', tier: 'confined', profile: 'workspace' }),
      error => error?.code === 'PERMISSION_CONFINED_ORIGIN_REFUSED');
    // An unnamed or invented profile must not fall through to the widest one.
    for (const profile of [undefined, null, '', 'full', 'READ-ONLY', 'toString']) {
      assert.throws(() => policy.session({ origin: 'local', tier: 'confined', profile }),
        error => error?.code === 'PERMISSION_CONFINED_PROFILE_REFUSED',
        `profile ${JSON.stringify(profile)} must be refused`);
    }
  });

  // --- 2. FAIL CLOSED --------------------------------------------------------
  //
  // An unreadable or unrecognised level must answer "refuse". It must never
  // answer "allow everything", and it must never answer with the absent
  // allowlist that src/lib/tool-registry.js reads AS everything.

  check('a missing, malformed, or unknown level is refused rather than defaulted', () => {
    for (const candidate of [undefined, null, '', 'admin', 'GUIDED', 'full', 42, {}, ['guided']]) {
      assert.throws(() => policy.installTierSession(candidate),
        error => error?.code === 'PERMISSION_INSTALL_TIER_REFUSED',
        `${JSON.stringify(candidate)} must be refused, not resolved`);
      assert.throws(() => machineRecord.tierToolAllowlist(candidate),
        error => error?.code === 'PERMISSION_INSTALL_TIER_REFUSED',
        `${JSON.stringify(candidate)} must not produce a tool list`);
    }
  });

  check('an unreadable machine record cannot yield a level', () => {
    for (const candidate of [null, undefined, 'guided', [], { tier: 'admin' }, {}]) {
      assert.throws(() => policy.installTierSessionFromRecord(candidate),
        error => error?.code === 'PERMISSION_INSTALL_TIER_UNREADABLE' || error?.code === 'PERMISSION_INSTALL_TIER_REFUSED');
    }
    assert.equal(policy.installTierFromRecord({ tier: 'standard' }), 'standard');
  });

  check('a level that cannot be worked out stops the configuration from being written', () => {
    for (const tier of ['guided', 'standard']) {
      assert.throws(
        () => machineRecord.generateMcpConfig(recordFor(tier), {
          readOnlyTools: () => [],
          tierTools: () => []
        }),
        error => error?.code === 'SETUP_READ_ONLY_PROFILE_EMPTY' || error?.code === 'SETUP_TIER_PROFILE_EMPTY',
        `${tier}: an empty list is read by the server as NO limit and must refuse`
      );
    }
  });

  check('the permanent exclusions failing to load refuses the surface instead of opening it', () => {
    const manifestPath = require.resolve('../src/lib/fra-capability-manifest');
    const saved = require.cache[manifestPath];
    // The exclusion set is read from the module that owns it. If that module
    // cannot answer, "no exclusions" would mean "nothing is excluded" -- the
    // exact inversion this file exists to prevent.
    require.cache[manifestPath] = { id: manifestPath, filename: manifestPath, loaded: true, exports: {} };
    try {
      const harmless = TOOL_REGISTRY.find(entry => entry.name === 'system.status');
      assert.throws(() => policy.assertToolAllowed(harmless, { origin: 'local', tier: 'confined', profile: 'workspace' }),
        error => error?.code === 'PERMISSION_EXCLUSIONS_UNREADABLE');
      assert.throws(() => policy.installTierToolNames(TOOL_REGISTRY, 'standard'),
        error => error?.code === 'PERMISSION_EXCLUSIONS_UNREADABLE');
    } finally {
      if (saved === undefined) delete require.cache[manifestPath];
      else require.cache[manifestPath] = saved;
    }
    // Restored, and still enforcing.
    assert.ok(policy.installTierToolNames(TOOL_REGISTRY, 'standard').length > 0);
  });

  // --- 3. THE LEVELS ARE GENUINELY DIFFERENT SURFACES -------------------------

  const surfaces = Object.fromEntries(
    policy.INSTALL_TIERS.map(tier => [tier, new Set(policy.installTierToolNames(TOOL_REGISTRY, tier))])
  );

  check('a narrower level is a strict subset of a wider one, and none of them is empty', () => {
    assert.ok(surfaces.guided.size > 0 && surfaces.standard.size > surfaces.guided.size);
    assert.ok(surfaces.unrestricted.size > surfaces.standard.size);
    for (const name of surfaces.guided) assert.ok(surfaces.standard.has(name), `${name} vanished at standard`);
    for (const name of surfaces.standard) assert.ok(surfaces.unrestricted.has(name), `${name} vanished at unrestricted`);
  });

  check('the tools that reach past any workspace are refused below unrestricted', () => {
    for (const name of ['host.exec', 'host.write_file', 'host.read_file', 'host.list_dir',
      'repo.write_file', 'repo.read_file', 'repo.list_dir', 'clipboard.read', 'clipboard.write']) {
      assert.equal(surfaces.guided.has(name), false, `guided must not carry ${name}`);
      assert.equal(surfaces.standard.has(name), false, `standard must not carry ${name}`);
      assert.equal(surfaces.unrestricted.has(name), true, `unrestricted grants the whole machine, including ${name}`);
    }
    // Not a read-only tier wearing another name: standard really can still write.
    assert.ok(surfaces.standard.has('gmail.send'));
    assert.equal(surfaces.guided.has('gmail.send'), false);
  });

  // --- 4. THE POLICY REFUSES AT THE DISPATCHER, NOT ONLY IN A LIST ------------

  await assert.rejects(
    () => executeTool('host.exec', PROBE, { permissionSession: policy.installTierSession('standard') }),
    error => error?.code === 'PERMISSION_CONFINED_EXCLUSION_REFUSED' && error.details?.tool === 'host.exec'
  );
  await assert.rejects(
    () => executeTool('gmail.send', PROBE, { permissionSession: policy.installTierSession('guided') }),
    error => error?.code === 'PERMISSION_CONFINED_EFFECT_REFUSED' && error.details?.effect === 'external-write'
  );
  // Guided refuses reading any file on the computer, which a purely
  // effect-derived read-only surface admitted: host.read_file is `local-read`.
  await assert.rejects(
    () => executeTool('host.read_file', PROBE, { permissionSession: policy.installTierSession('guided') }),
    error => error?.code === 'PERMISSION_CONFINED_EXCLUSION_REFUSED'
  );
  checks += 1;
  // The same tool, one level wider, reaches schema validation -- i.e. the tier
  // check is what refused it above, not something else on the way.
  await assert.rejects(
    () => executeTool('host.exec', PROBE, { permissionSession: policy.installTierSession('unrestricted') }),
    error => /__install_tier_probe__/.test(String(error?.message))
  );
  checks += 3;

  // --- 5. A RUNNING SERVER, UNDER THE GENERATED CONFIGURATION -----------------
  //
  // The definition of done: a tool ALLOWED at one recorded level and REFUSED at
  // a more restrictive one, by actually exercising the check that runs in
  // production. Nothing below supplies a tool view of its own.

  const generated = generatedServerEnvironments();
  const savedEnvironment = Object.prototype.hasOwnProperty.call(process.env, ALLOWLIST_ENV)
    ? process.env[ALLOWLIST_ENV]
    : undefined;

  // Every refusal below names the ALLOWLIST, because the allowlist is what this
  // lane built and `assertToolRegistered()` runs before the session check. If a
  // row ever reports 'refused-by-tier' instead, the generated allowlist stopped
  // narrowing that server and the tier is silently covering for it -- which is
  // exactly the state that must fail loudly rather than pass quietly.
  const CASES = Object.freeze([
    // tool,             guided,                 standard,               unrestricted
    ['system.status', 'admitted', 'admitted', 'admitted'],
    ['gmail.send', 'refused-by-allowlist', 'admitted', 'admitted'],
    ['host.exec', 'refused-by-allowlist', 'refused-by-allowlist', 'admitted'],
    ['repo.write_file', 'refused-by-allowlist', 'refused-by-allowlist', 'admitted'],
    ['clipboard.read', 'refused-by-allowlist', 'refused-by-allowlist', 'admitted']
  ]);

  try {
    let index = 0;
    for (const [tierIndex, tier] of policy.INSTALL_TIERS.entries()) {
      applyGeneratedEnvironment(generated[tier]);
      for (const row of CASES) {
        index += 1;
        const expected = row[tierIndex + 1];
        const verdict = serverVerdict(await callThroughServer(row[0], `${tier}-${index}`, tier));
        assert.equal(verdict, expected,
          `${tier}: ${row[0]} should be ${expected} through the real server, got ${verdict}`);
        checks += 1;
      }
    }

    // THE TIER IS A SECOND, INDEPENDENT BOUNDARY BEHIND THE ALLOWLIST, and that
    // is asserted here rather than inferred from the rows above -- where the
    // allowlist always wins first, so those rows say nothing about it.
    //
    // Widest possible tool view (the unrestricted level writes no allowlist at
    // all) with a narrow session bound: the tier alone must still refuse. This
    // is the case that would catch the generated allowlist being deleted, and it
    // is the reason deleting it does not silently open the surface.
    applyGeneratedEnvironment(generated.unrestricted);
    for (const [tier, tool] of [['guided', 'host.exec'], ['standard', 'host.exec'], ['guided', 'gmail.send']]) {
      const verdict = serverVerdict(await callThroughServer(tool, `second-boundary-${tier}-${tool}`, tier));
      assert.equal(verdict, 'refused-by-tier',
        `${tier}: with no allowlist at all, the tier alone must still refuse ${tool}`);
      checks += 1;
    }
    // ...and that boundary is not refusing everything indiscriminately.
    assert.equal(serverVerdict(await callThroughServer('system.status', 'second-boundary-allow', 'guided')), 'admitted');
    checks += 1;

    // The unrestricted level deliberately writes no allowlist, because a
    // snapshot of every registered name would be a list that goes stale. Proved
    // rather than assumed, since "no variable" is also what a BROKEN generation
    // would leave behind -- the row above is what tells them apart.
    assert.equal(generated.unrestricted, undefined);
    assert.equal(generated.guided.split(',').length, surfaces.guided.size);
    assert.equal(generated.standard.split(',').length, surfaces.standard.size);
    checks += 3;
  } finally {
    applyGeneratedEnvironment(savedEnvironment);
  }

  /* EVERY GENERATED SERVER MUST BE ABLE TO START, NOT MERELY BE LISTED.
   *
   * This suite proved at length what each level's servers are ALLOWED to do and
   * never once asked whether one of them could run. The browser server could not.
   * src/playwright-gateway.js refuses unless its own process.argv[2] is a pinned
   * @playwright/mcp version -- it writes "A pinned @playwright/mcp version is
   * required." and exits 2 otherwise -- and generateMcpConfig emitted
   * `args: [scriptPath]` and nothing else. So argv[2] was undefined on every
   * configuration this function has ever produced, which is every installed build
   * and every lane whose surface comes from here. The document advertised a browser
   * server that died at spawn, every time, silently.
   *
   * MEASURED 2026-08-16 before the fix: at `standard` and `unrestricted` the
   * generated args were ["...\\playwright-gateway.js"], argv[2] undefined. The
   * CONTROL was this repository's own checked-in .mcp.json, which passes
   * "@playwright/mcp@0.0.78" -- as do install.ps1, tools/playwright-mcp.cmd,
   * tools/playwright-call.js, adapters/codex/config.toml.example and
   * src/lib/providers/workstation.js:446. Every writer of that argument was correct
   * except the one that writes what ships.
   *
   * The check is written against the CATALOGUE rather than against the name
   * "playwright", so a second server added with a package pin is covered the day it
   * is added rather than the day someone remembers this file. */
  const PACKAGE_SPEC_RE = /^@playwright\/mcp@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
  check('a generated server that needs a pinned package version is given one', () => {
    let pinned = 0;
    for (const tier of machineRecord.TIERS) {
      const servers = machineRecord.generateMcpConfig(recordFor(tier)).document.mcpServers;
      for (const [name, entry] of Object.entries(servers)) {
        assert.ok(Array.isArray(entry.args) && entry.args.length >= 1, `${tier}/${name}: no arguments at all`);
        for (const argument of entry.args) {
          assert.equal(typeof argument, 'string', `${tier}/${name}: a non-string argument reaches the command line`);
          assert.notEqual(argument, '', `${tier}/${name}: an empty argument reaches the command line`);
        }
        if (name !== 'playwright') continue;
        pinned += 1;
        assert.equal(entry.args.length, 2,
          `${tier}: the browser gateway is spawned with ${entry.args.length} argument(s); without a pinned version it exits 2 before starting`);
        assert.match(entry.args[1], PACKAGE_SPEC_RE,
          `${tier}: the browser gateway's own guard would refuse ${JSON.stringify(entry.args[1])}`);
      }
    }
    // Guided ships no browser server, so two of the three levels carry one. If
    // that ever becomes zero this case would pass by measuring nothing.
    assert.equal(pinned, 2, `expected the browser gateway at two levels, generated it at ${pinned}`);
    checks += 1;
  });

  check('the pinned version here and the one the workstation writer uses cannot drift apart', () => {
    /* The canonical constant lives in providers/workstation.js, which
       machine-record.js deliberately does not require -- it would pull the whole
       workstation provider and its elevation chain into a setup module. The value
       is therefore mirrored, and this is what makes the mirror safe. */
    const { PLAYWRIGHT_PACKAGE } = require('../src/lib/providers/workstation');
    const generated = machineRecord.generateMcpConfig(recordFor('standard')).document.mcpServers.playwright;
    assert.equal(generated.args[1], PLAYWRIGHT_PACKAGE,
      'the generated configuration and the workstation writer name different @playwright/mcp versions');
    checks += 1;
  });

  console.log(`Install tier enforcement tests passed (${checks} checks, ${policy.INSTALL_TIERS.length} levels exercised through the real server).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

// EXECUTABLE CHANGE
// testcanfail audit report (2026-08-26):
// - STRENGTHENED: the refusal-message try/catch below. Mutation: changed
//   assertNoBillingCredentials' `if (leaked.length > 0)` to `if (false)` and
//   temporarily isolated this assertion from the preceding assert.throws. It
//   was green before this change because catch swallowed assert.fail. After
//   this change it was RED with: "AssertionError [ERR_ASSERTION]: the caught
//   error must come from assertNoBillingCredentials, not from the test failing
//   to observe a refusal" (exit 1).
// - RESTORE: the mutated source was restored byte-for-byte (cmp succeeded).
//   The restored test was GREEN with: "Provider launch scrub: 10 launcher
//   modules, 7 provider spawn sites, 0 violations." and "Provider launch scrub
//   tests passed."
// - NOT-FOUND (1): empty collection loops without an independent non-empty
//   guard; dynamic census collections have explicit launcher/site floors, and
//   the gateway extraction has both a size floor and a name-pinned subset.
// - NOT-FOUND (2): exit-status/truthy-return assertions used as subject output.
// - NOT-FOUND (4): assertions against a mock of the scrub under test; injected
//   spawn only captures options produced by the real launch paths.
// - NOT-FOUND (5): a skip/precondition capable of making the whole file a
//   no-op. The optional multi-account block does not gate the other checks.
// - NOT-FOUND (6): expected values computed solely by the implementation being
//   checked; source-derived names are independently pinned by name.
// - PRECONDITION: host Node v20.20.2 lacks node:sqlite, so executions used a
//   preload shim for that unavailable built-in. An attempted Node 22 fetch was
//   blocked by registry policy (HTTP 403); no product behavior was shimmed.
'use strict';
// Every path that launches a subscription CLI must scrub the ambient
// credentials first. This test exists because writing that rule down did not
// work: providerEnvironment()'s comment in cli-provider-gateway.js already
// described the R1186 outage in detail, and nine of the ten modules importing
// executableFor() still did not call it (measured 2026-08-10).
//
// It has two halves, and both are needed:
//
//   BEHAVIOUR  -- poison an environment, drive each real launch path with an
//                 injected spawn, and read the env the child would actually
//                 have received. This proves the scrub, rather than proving a
//                 function with the right name is mentioned somewhere.
//
//   CENSUS     -- scan for provider-CLI spawn sites and fail on any that pass
//                 the ambient environment or omit `env` entirely. This is what
//                 catches the NEXT launcher somebody adds. The behavioural
//                 half cannot, because it only knows about today's callers.
//
// NOTHING HERE ASSERTS ON A SECRET'S VALUE. The sentinel below is a fake
// string this test invents; the assertions are about which variable NAMES
// survive. A test that compared a real key's value would itself be a leak.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const gateway = require('../src/lib/providers/cli-provider-gateway.js');
const {
  BILLING_TRIPWIRE,
  assertNoBillingCredentials,
  safeLaunchEnvironment,
  subscriptionLaunchEnvironment
} = require('../src/lib/providers/subscription-launch-env.js');

// A fabricated value. It is never compared against anything real.
const SENTINEL = 'sk-ant-TEST-SENTINEL-NOT-A-REAL-KEY';

function poisonedEnvironment(extra = {}) {
  const env = { PATH: 'safe-path', USERPROFILE: 'profile', KEEP_ME: 'keep' };
  for (const name of BILLING_TRIPWIRE) env[name] = SENTINEL;
  return { ...env, ...extra };
}

function assertScrubbed(env, label) {
  const survivors = BILLING_TRIPWIRE.filter(name => env[name] !== undefined);
  assert.deepEqual(survivors, [], `${label} must not forward billing credentials to the child; these survived: ${survivors.join(', ')}`);
  // The scrub must be surgical, not a blanket wipe: a launcher that handed the
  // child an empty environment would "pass" a credential check and then fail
  // to find the CLI at all.
  assert.equal(env.KEEP_ME, 'keep', `${label} must preserve ordinary environment variables`);
  // Windows preserves the spelling already present in the parent block (often
  // `Path`, while synthetic fixtures commonly use `PATH`) but resolves the
  // name case-insensitively. Exact property casing is not part of the child
  // environment contract; presence of one unambiguous, non-empty PATH entry is.
  const pathEntries = Object.entries(env)
    .filter(([name]) => name.toLowerCase() === 'path');
  assert.equal(pathEntries.length, 1,
    `${label} must preserve exactly one case-insensitive PATH entry`);
  assert.ok(typeof pathEntries[0][1] === 'string' && pathEntries[0][1].length > 0,
    `${label} must preserve PATH or the CLI cannot be found`);
}

// ---------------------------------------------------------------------------
// 1. The shared scrub itself.
// ---------------------------------------------------------------------------
{
  const scrubbed = subscriptionLaunchEnvironment(poisonedEnvironment());
  assertScrubbed(scrubbed, 'subscriptionLaunchEnvironment');

  // The trap this whole module exists for: a single provider's scrub is NOT
  // enough, because it only strips its own family.
  const codexOnly = gateway.providerEnvironment('codex', poisonedEnvironment());
  assert.equal(codexOnly.ANTHROPIC_API_KEY, SENTINEL,
    'guard assumption: providerEnvironment("codex") is expected to LEAVE ANTHROPIC_API_KEY; if this ever fails the union below may no longer be necessary, but do not delete it without re-measuring');
  assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined,
    'the union must strip ANTHROPIC_API_KEY even when the launched provider is not claude');

  // The union must dominate every individual provider scrub. This is the
  // drift guard: add a credential to the gateway for any provider and it is
  // inherited here automatically, and this assertion proves the composition
  // really happened rather than a hand-copied list keeping pace by luck.
  for (const providerId of gateway.PROVIDER_IDS) {
    const single = gateway.providerEnvironment(providerId, poisonedEnvironment());
    for (const name of Object.keys(poisonedEnvironment())) {
      if (single[name] === undefined) {
        assert.equal(scrubbed[name], undefined,
          `the union must strip everything providerEnvironment("${providerId}") strips, but ${name} survived`);
      }
    }
  }

  // The tripwire must actually refuse rather than warn.
  assert.throws(() => assertNoBillingCredentials({ ANTHROPIC_API_KEY: SENTINEL }, { context: 'unit' }),
    /LAUNCH_BILLING_CREDENTIAL_PRESENT|survived the environment scrub/,
    'assertNoBillingCredentials must throw when a billing credential survives');

  // ...and the refusal must not quote the value it caught.
  try {
    assertNoBillingCredentials({ ANTHROPIC_API_KEY: SENTINEL }, { context: 'unit' });
    assert.fail('expected a refusal');
  } catch (error) {
    // Do not let this catch turn the assert.fail above into the "refusal" it
    // was meant to require. Without this discriminator, a regression where
    // assertNoBillingCredentials simply returns still passes this block.
    assert.notEqual(error && error.code, 'ERR_ASSERTION',
      'the caught error must come from assertNoBillingCredentials, not from the test failing to observe a refusal');
    assert.ok(!String(error.message).includes(SENTINEL),
      'the refusal message must name the variable, never its value');
  }

  assertScrubbed(safeLaunchEnvironment(poisonedEnvironment()), 'safeLaunchEnvironment');
}

// ---------------------------------------------------------------------------
// 2. Behaviour: the real launch paths, driven with an injected spawn.
// ---------------------------------------------------------------------------
function fakeChild() {
  const listeners = new Map();
  const stream = { on: () => {}, setEncoding: () => {} };
  const child = {
    stdout: stream,
    stderr: stream,
    stdin: { write: () => {}, end: () => {} },
    kill: () => {},
    pid: 4242,
    on(event, handler) {
      listeners.set(event, handler);
      // Close immediately so the caller's promise settles.
      if (event === 'close') setImmediate(() => handler(0));
      return child;
    },
    once(event, handler) { return child.on(event, handler); },
    removeListener: () => child
  };
  return child;
}

async function capturedLaunchEnvironment(invoke) {
  const captured = [];
  const spawnImpl = (command, args, options) => {
    captured.push({ command, args, env: (options && options.env) || {} });
    return fakeChild();
  };
  const saved = { ...process.env };
  try {
    // Make the ambient environment exactly as hostile as the owner's machine.
    for (const name of BILLING_TRIPWIRE) process.env[name] = SENTINEL;
    process.env.KEEP_ME = 'keep';
    await invoke(spawnImpl);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    for (const [name, value] of Object.entries(saved)) process.env[name] = value;
  }
  return captured;
}

(async () => {
  // -- fleet-supervisor reviewer ------------------------------------------
  {
    const review = require('../src/lib/fleet-supervisor/review.js');
    const captured = await capturedLaunchEnvironment(spawnImpl => review.runReviewer({
      // codex, because review.js defines reviewer invocations only for codex
      // and gemini. The leak still matters for a non-claude reviewer: a codex
      // child that inherits ANTHROPIC_API_KEY can spawn a claude CLI, which is
      // precisely why the scrub is the union across providers.
      providerId: 'codex',
      prompt: 'probe',
      cwd: root,
      spawnImpl,
      resolveExecutable: () => ({ command: 'claude', prefixArgs: [] }),
      parseOutput: () => ({ text: '' })
    }));
    assert.equal(captured.length, 1, 'runReviewer must have spawned exactly one reviewer');
    assertScrubbed(captured[0].env, 'fleet-supervisor runReviewer');
  }

  // -- intent-fidelity checker --------------------------------------------
  {
    const intent = require('../src/lib/intent-fidelity.js');
    const captured = await capturedLaunchEnvironment(spawnImpl => intent.runIntentChecker({
      prompt: 'probe',
      cwd: root,
      spawnImpl,
      resolveExecutable: () => ({ command: 'codex', prefixArgs: [] }),
      parseOutput: () => ({ text: '' })
    }));
    assert.equal(captured.length, 1, 'runIntentChecker must have spawned exactly one checker');
    assertScrubbed(captured[0].env, 'intent-fidelity runIntentChecker');
  }

  // -- mission-bridge dispatch --------------------------------------------
  {
    const actions = require('../src/lib/mission-bridge/actions.js');
    const scrubbed = actions.scrubEnvironment(poisonedEnvironment());
    assertScrubbed(scrubbed, 'mission-bridge scrubEnvironment');
    // Its own name-pattern sweep never matched these: they do not look like
    // keys, but each one reroutes a subscription CLI onto a billed API path.
    for (const name of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'GOOGLE_GENAI_USE_VERTEXAI']) {
      assert.equal(scrubbed[name], undefined,
        `mission-bridge scrubEnvironment must strip ${name}; a name-pattern sweep for API_KEY/TOKEN does not catch it`);
    }
  }

  // -- the multi-account launcher, if the sibling lane has landed it -------
  // Two implementations of one rule is exactly how drift starts, so if both
  // exist they must agree exactly.
  //
  // This block used to wrap the require in `try { ... } catch { launch = null }`
  // and skip on null. multi-account-build reproduced the hole rather than
  // arguing it: with launch.js moved out of the tree entirely, this test still
  // exited 0 and printed "passed", the only difference being one line of
  // stdout nothing asserted on. A syntax error, a rename, or a broken
  // transitive require landed in exactly that same silent-green place -- so
  // the drift protection could disappear without anything going red.
  //
  // existsSync keeps it genuinely optional for the only benign case (the
  // sibling module does not exist yet). Once the file IS there, a load failure
  // or a missing export is a hard failure: "absent" and "broken" must not be
  // indistinguishable, because only one of them is harmless.
  {
    const launchPath = path.resolve(__dirname, '..', 'src', 'lib', 'multi-account', 'launch.js');
    if (fs.existsSync(launchPath)) {
      // Deliberately NOT wrapped: a throw here must fail the test.
      const launch = require(launchPath);
      assert.equal(typeof launch.scrubbedEnvironment, 'function',
        'src/lib/multi-account/launch.js exists but exposes no scrubbedEnvironment(); the cross-implementation drift check cannot run, and silently not running it is how the protection is lost');
      const mine = subscriptionLaunchEnvironment(poisonedEnvironment());
      const theirs = launch.scrubbedEnvironment(poisonedEnvironment());
      delete theirs.CODEX_HOME;
      delete mine.CODEX_HOME;
      assert.deepEqual(Object.keys(theirs).sort(), Object.keys(mine).sort(),
        'src/lib/multi-account/launch.js and subscription-launch-env.js must strip exactly the same variables; they are two implementations of one rule and have drifted');
      console.log('  multi-account launcher agrees with the shared scrub.');
    }
  }

  // -- independent authority: the shared rule declaration ------------------
  // The drift check above proves the two implementations AGREE. It cannot
  // prove either is RIGHT -- if providerEnvironment() ever stopped stripping
  // something, both would stop together and both would still agree.
  // The dependency-light launch module now owns the provider-specific name
  // sets used by both the gateway and the control plane. Extract its bounded
  // rule table, then pin and behavior-test those names below; scanning the
  // gateway's providerEnvironment body would find only the shared constant
  // reference and falsely report that the scrub disappeared.
  {
    const launchEnvironmentSource = fs.readFileSync(
      path.join(root, 'src', 'lib', 'supervision', 'launch-environment.js'), 'utf8');
    const start = launchEnvironmentSource.indexOf('const ENVIRONMENT_RULES');
    const end = launchEnvironmentSource.indexOf('].map(', start);
    assert.ok(start > 0 && end > start,
      'could not locate the bounded ENVIRONMENT_RULES declaration; this extraction needs updating');
    const body = launchEnvironmentSource.slice(start, end + 1);
    const declared = new Set();
    for (const match of body.matchAll(
      /\[\s*'([A-Z][A-Z0-9_]{3,})'\s*,\s*'(?:codex|claude|gemini)'\s*,\s*(?:true|false)\s*\]/g
    )) {
      declared.add(match[1]);
    }

    assert.ok(declared.size >= 20,
      `only ${declared.size} scrubbed variable names were extracted from ENVIRONMENT_RULES; the extraction is probably broken rather than the policy suddenly tiny`);

    // A SIZE FLOOR IS NOT ENOUGH, and reasoning about the smallest real
    // degradation is what shows why. The expected set derives FROM the gateway
    // source, so deleting a variable from providerEnvironment() shrinks both
    // sides at once and the survivors check below passes trivially. The floor
    // is then the only guard -- and measured against the live gateway (23
    // names) a floor of 20 tolerates losing any THREE. Nine of the 23 are not
    // in BILLING_TRIPWIRE either, and they include AWS_ACCESS_KEY_ID,
    // AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN. Losing exactly those three
    // would slip past the floor and past the tripwire, silently.
    //
    // So pin the NAMES, not the count. This is a subset assertion: adding a
    // credential to the gateway is fine and needs no change here, but removing
    // one of these goes red and has to be justified deliberately.
    const EXPECTED_GATEWAY_SCRUB = Object.freeze([
      // codex
      'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
      // claude, incl. the Bedrock/Vertex/Foundry routing switches
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'AWS_BEARER_TOKEN_BEDROCK', 'AWS_BEDROCK_API_KEY', 'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION',
      'AWS_DEFAULT_REGION',
      // gemini
      'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'
    ]);
    const dropped = EXPECTED_GATEWAY_SCRUB.filter(name => !declared.has(name)).sort();
    assert.deepEqual(dropped, [],
      `the shared provider launch policy no longer scrubs: ${dropped.join(', ')}. If that removal is intentional, change this list deliberately and say why -- it must not be able to happen quietly.`);

    // The tripwire must cover every real credential and every redirection
    // vector the gateway strips. The scrub is the mechanism; the tripwire is
    // what REFUSES the launch when the mechanism fails, and a credential
    // protected only by the layer above it is not protected.
    //
    // This is a RULE, not a second hardcoded list, so a credential added to
    // the gateway later is required on the tripwire automatically instead of
    // waiting for someone to notice. Region and project selectors are exempt:
    // they carry no secret and name no endpoint. See the remainder note in
    // subscription-launch-env.js for why AWS_PROFILE is the closest call.
    const mustBeOnTripwire = name =>
      /API_KEY|ACCESS_KEY|SECRET|_TOKEN|BASE_URL|USE_(?:BEDROCK|VERTEX|FOUNDRY)|USE_VERTEXAI/.test(name);
    const unguarded = [...declared].filter(name => mustBeOnTripwire(name) && !BILLING_TRIPWIRE.includes(name)).sort();
    assert.deepEqual(unguarded, [],
      `these are credentials or redirection vectors that the gateway strips but the launch tripwire would not catch, so nothing refuses the launch if the scrub regresses: ${unguarded.join(', ')}`);

    // Poison with the union of both, so a newly added gateway variable is
    // covered too rather than waiting for someone to update the list.
    const poisoned = {};
    for (const name of new Set([...declared, ...EXPECTED_GATEWAY_SCRUB])) poisoned[name] = SENTINEL;
    poisoned.KEEP_ME = 'keep';
    const scrubbed = subscriptionLaunchEnvironment(poisoned);
    const survivors = Object.keys(poisoned).filter(name => name !== 'KEEP_ME' && scrubbed[name] !== undefined).sort();
    assert.deepEqual(survivors, [],
      `every credential/routing variable named in cli-provider-gateway.js must be absent from a launch environment; these survived: ${survivors.join(', ')}`);
    console.log(`  ${declared.size} gateway-declared variables all absent from the launch environment (${EXPECTED_GATEWAY_SCRUB.length} pinned by name).`);
  }

  // -------------------------------------------------------------------------
  // 3. Census: catch the NEXT launcher, not just today's.
  // -------------------------------------------------------------------------
  const SPAWN_CALL = /\b(?:spawnSync|spawnImpl|spawn|execFileSync|execFile)\s*\(/g;
  // The same launch, expressed through the shared fleet harness. When the
  // supervisor lanes moved to runHarnessCommand({ executable, args }, { env }),
  // the provider CLI stopped being the first argument of a spawn and became an
  // object PROPERTY of a function that is not a spawn at all; the inner spawn
  // the harness performs then receives a callback parameter, `spawnImpl(file,
  // ...)`. The first-argument convention below can see neither, so two real
  // provider launches stopped being counted while this census went on
  // reporting success. That is the failure this file exists to prevent, so the
  // harness shape is matched directly and held to the same environment rule.
  const HARNESS_CALL = /\brunHarnessCommand\s*\(/g;

  function callText(source, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) return source.slice(openIndex, i + 1);
      }
    }
    return source.slice(openIndex, openIndex + 2000);
  }

  function collectFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectFiles(full, out);
      else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.includes('.test.')) out.push(full);
    }
    return out;
  }

  const scanRoots = [path.join(root, 'src', 'lib'), path.join(root, 'tools')];
  const files = scanRoots.flatMap(dir => (fs.existsSync(dir) ? collectFiles(dir) : []));

  function checkEnvironment(where, text) {
    if (!/(?:^|[{,\s])env\s*(?::|,|\}|$)/m.test(text)) {
      violations.push(`${where} spawns a provider CLI with no env option, so it inherits the ambient ANTHROPIC_API_KEY`);
      return;
    }
    if (/env\s*:\s*(?:\{\s*\.\.\.\s*process\.env\s*\}|process\.env)\s*[,}]/.test(text)) {
      violations.push(`${where} spawns a provider CLI with the raw ambient environment`);
    }
  }

  const launchers = [];
  const violations = [];
  let providerSpawnSites = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/cli-provider-gateway/.test(source) || !/\bexecutableFor\b/.test(source)) continue;
    const relative = path.relative(root, file).replace(/\\/g, '/');
    launchers.push(relative);

    SPAWN_CALL.lastIndex = 0;
    let match;
    while ((match = SPAWN_CALL.exec(source)) !== null) {
      const open = source.indexOf('(', match.index);
      const text = callText(source, open);
      const firstArg = text.slice(1, (text.indexOf(',') + 1 || text.length) - 1).trim();

      // Only provider-CLI launches are in scope. A `git`/`node` spawn in the
      // same file is somebody else's concern, and forcing a scrub on it would
      // teach people to add meaningless markers.
      const spawnsProviderCli = /\.command\b/.test(firstArg) || /^(?:command|cmd|executable)$/.test(firstArg);
      if (!spawnsProviderCli) continue;
      providerSpawnSites += 1;

      const line = source.slice(0, match.index).split('\n').length;
      const where = `${relative}:${line}`;

      // `env: value` or the shorthand `env,` / `env }`. Shorthand is the
      // common form here, and rejecting it would have produced three false
      // violations on paths that are in fact scrubbed.
      checkEnvironment(where, text);
    }

    HARNESS_CALL.lastIndex = 0;
    while ((match = HARNESS_CALL.exec(source)) !== null) {
      const open = source.indexOf('(', match.index);
      const text = callText(source, open);
      // The harness also runs plans it was handed by its own callers; only a
      // call that names the executable inline is a launch site in this module.
      if (!/\bexecutable\s*:/.test(text)) continue;
      providerSpawnSites += 1;
      const line = source.slice(0, match.index).split('\n').length;
      // The environment is declared on the harness call, not on the inner
      // spawn, so it is the harness call that has to carry a scrubbed env.
      checkEnvironment(`${relative}:${line}`, text);
    }
  }

  // Anti-vacuity. If the scan silently stops finding launchers -- a moved
  // directory, a renamed import -- it would pass while checking nothing. That
  // failure mode is exactly what this test is for, so it is asserted.
  assert.ok(launchers.length >= 8,
    `census found only ${launchers.length} modules importing executableFor; the scan is probably broken rather than the repo suddenly clean`);
  // The floor was 5 while the census could only see 4, so the guard spent that
  // whole window telling the truth about itself and being ignored. Full
  // accounting, measured 2026-09-10 against the 7 sites the 2026-08-26 audit
  // record above quotes:
  //
  //   STILL PRESENT, and were INVISIBLE until the harness matcher above:
  //     src/lib/fleet-supervisor/lane-runner.js   (now via runHarnessCommand)
  //     src/lib/fleet-supervisor/review.js        (now via runHarnessCommand)
  //   STILL PRESENT and always counted:
  //     src/lib/intent-fidelity.js
  //     src/lib/providers/claude-auth-probe.js
  //     src/lib/providers/gemini-agentic.js
  //   GENUINELY GONE, proof recorded rather than assumed:
  //     tools/role-sweep-runner.js -- DELETED in 81b14e15
  //     src/lib/providers/subscription-launch-env.js -- still present but no
  //       longer references the gateway or executableFor and performs no spawn
  //       at all; it became a pure environment builder
  //   ADDED SINCE:
  //     src/lib/providers/claude-usage-probe.js
  //
  // 5 surviving + 1 added = 6. Both newly visible sites were checked by hand
  // and are scrubbed -- lane-runner through
  // deleteEnvNames(subscriptionLaunchEnvironment(...)), review through
  // safeLaunchEnvironment(process.env, ...) -- so this change exposed no leak.
  // It closed a blind spot: 2 of 6 real launches, a third of the census, were
  // going unexamined while this file reported success.
  assert.ok(providerSpawnSites >= 6,
    `census found only ${providerSpawnSites} provider-CLI spawn sites; the call-site matcher is probably broken`);

  assert.deepEqual(violations, [],
    `every provider-CLI spawn must pass a scrubbed environment:\n${violations.join('\n')}`);

  console.log(`Provider launch scrub: ${launchers.length} launcher modules, ${providerSpawnSites} provider spawn sites, 0 violations.`);
  console.log('Provider launch scrub tests passed.');
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

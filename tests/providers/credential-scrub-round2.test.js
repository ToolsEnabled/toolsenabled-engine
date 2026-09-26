// EXECUTABLE CHANGE: explicit cardinality checks keep every collection-driven assertion non-vacuous.
'use strict';
/* TEST-CAN-FAIL AUDIT (testcanfail-tests-providers-credential-scrub-round2-test-js)
 *
 * FOUND -- EMPTY COLLECTIONS:
 * - Mutated `invalidEnvironments` to `[]`. Before this change the test stayed
 *   green; now it exits 1 with:
 *     "not ok - detection THROWS on a non-object rather than answering \"clean\""
 *     "the invalid-environment cases must not be empty"
 *     "1 failing"
 * - Mutated `tokenSpellings` to `[]`. Before this change its loop made no
 *   environment claim; now it exits 1 with:
 *     "not ok - CLAUDE_CODE_OAUTH_TOKEN is scrubbed and tripwired in both spellings"
 *     "the token-spelling cases must not be empty"
 *     "1 failing"
 * - Mutated the test registrar to discard every registration. Before this
 *   change the runner reported success with zero tests; now it exits 1 with:
 *     "AssertionError [ERR_ASSERTION]: the credential-scrub test registry must not be empty"
 *
 * NOT-FOUND -- EXIT STATUS / TRUTHY RETURN AS SUBJECT EVIDENCE: childResolves
 * checks spawn errors and requires the child's own PRESENT/ABSENT protocol;
 * the runner's exit status is only aggregation.
 * NOT-FOUND -- SWALLOWED FAILURE: try/finally blocks only restore global state,
 * and the runner catch records every caught test failure.
 * NOT-FOUND -- MOCK OF SUBJECT: every environment claim uses a real child.
 * NOT-FOUND -- SKIP / PLATFORM NO-OP: there are no skips or early platform
 * returns; childLookup selects the spelling that the platform can resolve.
 * NOT-FOUND -- EXPECTED VALUE COMPUTED BY SUBJECT: expectations are literal
 * PRESENT/ABSENT, booleans, names, values, error codes, and error patterns.
 *
 * RESTORATION / GREEN: each mutation above was restored byte-for-byte. The
 * restored file exits 0 and ends with:
 *     "# 17 environment claims, 17 real child spawns"
 *     "all 18 credential-scrub round-2 checks passed"
 * PRECONDITION: the installed Node v20.20.2 lacks node:sqlite. Node 22 could
 * not be fetched (npm E403), so the run used a preload that supplies only a
 * placeholder node:sqlite DatabaseSync export; this test never instantiates
 * it. Environment scrubbers and all 17 spawned children remained real.
 */
/* ROUND 2 of the credential-scrub defect class, against REAL SPAWNED CHILDREN.
 *
 * WHY THE REAL-CHILD RULE IS ABSOLUTE HERE. The suite this one supplements
 * claimed in its commit message that "every case SPAWNS A REAL CHILD". When an
 * adversarial reviewer instrumented it, it made 27 checks and 9 spawns: the
 * detection, over-removal and clean-environment sections never launched
 * anything. The gap matters because every defect in this class is a
 * DISAGREEMENT between what a plain JavaScript object says and what the OS
 * hands the child -- an object-only assertion is written in the vocabulary of
 * the bug. So this file counts its own spawns and FAILS if the count does not
 * match the number of environment claims it makes.
 *
 * Nothing here prints a credential value. Children report PRESENT/ABSENT for a
 * canonical name lookup and nothing else; the planted values are synthetic
 * markers that are not credentials for anything.
 */

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const scrub = require('../../src/lib/env-scrub.js');
const gateway = require('../../src/lib/providers/cli-provider-gateway.js');
const launchEnv = require('../../src/lib/providers/subscription-launch-env.js');
const evidence = require('../../src/lib/fleet-supervisor/evidence.js');
const laneRunner = require('../../src/lib/fleet-supervisor/lane-runner.js');
const lunaExecutor = require('../../src/lib/fleet-supervisor/luna-executor.js');
const geminiAgentic = require('../../src/lib/providers/gemini-agentic.js');
const multiAccount = require('../../src/lib/multi-account/launch.js');
const geminiFleet = require('../../tools/gemini-fleet.js');

const MARKER = 'SYNTHETIC-ROUND2-MARKER-NOT-A-CREDENTIAL';

// A Windows child resolves environment names case-insensitively. A POSIX
// child does not, so a lowercase fixture must be queried by that exact spelling
// there or the control reports ABSENT before the scrub even runs.
const childLookup = (canonical, planted = canonical) => process.platform === 'win32' ? canonical : planted;

let spawns = 0;
let environmentClaims = 0;

/* Ask a REAL child, through the OS's own case-insensitive resolution, whether
 * `name` resolves. This is the only permitted way to make a claim about what an
 * environment does. */
function childResolves(env, name) {
  spawns += 1;
  const script = `const v=process.env[${JSON.stringify(name)}];process.stdout.write(v===undefined?'ABSENT':'PRESENT');`;
  const result = spawnSync(process.execPath, ['-e', script], {
    env, encoding: 'utf8', windowsHide: true, timeout: 30_000
  });
  assert.ok(!result.error, `child failed to spawn: ${result.error && result.error.message}`);
  const out = String(result.stdout).trim();
  assert.ok(out === 'PRESENT' || out === 'ABSENT', `child said ${JSON.stringify(out)} (status ${result.status})`);
  return out;
}

function assertChildCannotSee(env, name, what) {
  environmentClaims += 1;
  assert.equal(childResolves(env, name), 'ABSENT', `${what}: a real child still resolved ${name}`);
}

function assertChildCanSee(env, name, what) {
  environmentClaims += 1;
  assert.equal(childResolves(env, name), 'PRESENT', `${what}: the control failed -- a real child did NOT resolve ${name}, so this test proves nothing`);
}

/* A parent environment with every provider credential stripped, plus one
 * planted spelling. Deleting BEFORE planting is required: `process.env` on
 * Windows is case-INSENSITIVE, so planting `gemini_api_key` and then deleting
 * `GEMINI_API_KEY` removes the thing just planted -- a mistake that silently
 * turns this whole file green. */
function parentWith(spelling, value = MARKER) {
  const base = {};
  for (const key of Object.keys(process.env)) {
    if (/^(anthropic|claude_code|openai|codex|gemini|google_a|google_api|google_cloud|google_genai|aws_|stripe_|telegram_|github_token|gh_token|toolsenabled_tool_allowlist)/i.test(key)) continue;
    base[key] = process.env[key];
  }
  base[spelling] = value;
  return base;
}

function withAmbient(planted, run) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(planted)) process.env[key] = value;
    return run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------------ */
/* THE CONTROL. If this ever stops failing, every ABSENT below is worthless. */
test('control: an unscrubbed lowercase spelling DOES reach a real child', () => {
  assertChildCanSee(parentWith('anthropic_api_key'), childLookup('ANTHROPIC_API_KEY', 'anthropic_api_key'),
    'control for the whole file');
});

/* ------------------------------------------------------------------ */
/* Defect 3: inherited enumerable properties. */
function withPollutedPrototype(spelling, run) {
  Object.defineProperty(Object.prototype, spelling, {
    value: MARKER, enumerable: true, configurable: true, writable: true
  });
  try { return run(); } finally { delete Object.prototype[spelling]; }
}

test('an enumerable key on Object.prototype reaches a child (the control)', () => {
  withPollutedPrototype('anthropic_api_key', () => {
    assertChildCanSee({ SAFE: 'yes' }, childLookup('ANTHROPIC_API_KEY', 'anthropic_api_key'),
      "node's child env builder walks inherited enumerable properties");
  });
});

test('deleteEnvNames removes an INHERITED enumerable credential', () => {
  withPollutedPrototype('anthropic_api_key', () => {
    const env = scrub.deleteEnvNames({ SAFE: 'yes' }, ['ANTHROPIC_API_KEY']);
    assertChildCannotSee(env, childLookup('ANTHROPIC_API_KEY', 'anthropic_api_key'), 'deleteEnvNames on a polluted prototype');
  });
});

test('the removal SURVIVES a later { ...spread }', () => {
  /* The first fix used a NON-ENUMERABLE shadow. It removed the key correctly and
   * was then silently discarded by the next spread -- spread copies own
   * ENUMERABLE properties only -- so the fresh object inherited the polluted
   * prototype again. subscriptionLaunchEnvironment() folds providerEnvironment()
   * over three providers and each one re-spreads, so the shadow was undone twice
   * per launch and a real child read the key. Measured; hence the tombstone. */
  withPollutedPrototype('anthropic_api_key', () => {
    const once = scrub.deleteEnvNames({ SAFE: 'yes' }, ['ANTHROPIC_API_KEY']);
    const respread = { ...{ ...once } };
    assertChildCannotSee(respread, childLookup('ANTHROPIC_API_KEY', 'anthropic_api_key'), 'scrubbed env spread twice more');
  });
});

test('the shared detectors SEE an inherited credential', () => {
  withPollutedPrototype('anthropic_api_key', () => {
    const polluted = { SAFE: 'yes' };
    assert.equal(scrub.hasEnvName(polluted, ['ANTHROPIC_API_KEY']), true);
    assert.deepEqual(gateway.presentEnvironmentNames(polluted, ['ANTHROPIC_API_KEY']), ['ANTHROPIC_API_KEY']);
    assert.throws(() => launchEnv.assertNoBillingCredentials(polluted, { context: 'round2' }),
      /LAUNCH_BILLING_CREDENTIAL_PRESENT|survived the environment scrub/);
  });
});

test('subscriptionLaunchEnvironment survives prototype pollution end to end', () => {
  withPollutedPrototype('anthropic_api_key', () => {
    const env = launchEnv.subscriptionLaunchEnvironment({ SAFE: 'yes' });
    assertChildCannotSee(env, childLookup('ANTHROPIC_API_KEY', 'anthropic_api_key'), 'subscriptionLaunchEnvironment under a polluted prototype');
  });
});

/* ------------------------------------------------------------------ */
/* Defect 4: detection must not fail open. */
test('detection FAILS CLOSED on null/undefined, which node reads as inherit-everything', () => {
  withAmbient({ ANTHROPIC_API_KEY: MARKER }, () => {
    assert.equal(scrub.hasEnvName(null, ['ANTHROPIC_API_KEY']), true,
      'null must resolve to process.env, because that is what the child would get');
    assert.equal(scrub.hasEnvName(undefined, ['ANTHROPIC_API_KEY']), true);
    assert.deepEqual(gateway.presentEnvironmentNames(null, ['ANTHROPIC_API_KEY']), ['ANTHROPIC_API_KEY']);
    assert.throws(() => launchEnv.assertNoBillingCredentials(null, { context: 'round2' }),
      error => error.code === 'LAUNCH_ENVIRONMENT_INHERITS_AMBIENT');
    assert.throws(() => launchEnv.assertNoBillingCredentials(undefined, { context: 'round2' }),
      error => error.code === 'LAUNCH_ENVIRONMENT_INHERITS_AMBIENT');
  });
  // And node really does inherit everything from a null env -- the reason the
  // above is not merely pedantic.
  withAmbient({ ANTHROPIC_API_KEY: MARKER }, () => {
    assertChildCanSee(null, 'ANTHROPIC_API_KEY', 'spawn with { env: null }');
  });
});

test('detection THROWS on a non-object rather than answering "clean"', () => {
  const invalidEnvironments = ['a string', 42, true];
  assert.ok(invalidEnvironments.length > 0, 'the invalid-environment cases must not be empty');
  for (const bad of invalidEnvironments) {
    assert.throws(() => scrub.hasEnvName(bad, ['ANTHROPIC_API_KEY']), /must be an object/);
    assert.throws(() => scrub.presentEnvNames(bad, ['ANTHROPIC_API_KEY']), /must be an object/);
  }
});

/* ------------------------------------------------------------------ */
/* Defect 2: CLAUDE_CODE_OAUTH_TOKEN. */
test('CLAUDE_CODE_OAUTH_TOKEN is scrubbed and tripwired in both spellings', () => {
  assert.ok(launchEnv.BILLING_TRIPWIRE.includes('CLAUDE_CODE_OAUTH_TOKEN'),
    'the token claude-process.js calls "a second credential that outranks the subscription session" must be on the tripwire');
  const tokenSpellings = ['CLAUDE_CODE_OAUTH_TOKEN', 'claude_code_oauth_token'];
  assert.ok(tokenSpellings.length > 0, 'the token-spelling cases must not be empty');
  for (const spelling of tokenSpellings) {
    const env = launchEnv.safeLaunchEnvironment(parentWith(spelling), { context: 'round2' });
    assertChildCannotSee(env, childLookup('CLAUDE_CODE_OAUTH_TOKEN', spelling), `safeLaunchEnvironment with ${spelling}`);
  }
});

/* ------------------------------------------------------------------ */
/* Defect 12: the over-removal decision, pinned so it stays a decision. */
test('the Unicode fold DELIBERATELY over-removes a Windows-distinct lookalike', () => {
  const kelvin = 'ANTHROPIC_API_\u212AEY'; // U+212A KELVIN SIGN in place of K
  assert.equal(kelvin.toLowerCase(), 'anthropic_api_key',
    'JavaScript folds KELVIN SIGN to ASCII k; this is the premise of the trade');
  assert.notEqual(kelvin, 'ANTHROPIC_API_KEY');

  // The two names really are DISTINCT to this OS: a child given only the Kelvin
  // spelling cannot resolve the canonical name. So removing it is genuine
  // over-removal, chosen because under-removal bills the owner and this does not.
  const parent = parentWith(kelvin);
  environmentClaims += 1;
  assert.equal(childResolves(parent, 'ANTHROPIC_API_KEY'), 'ABSENT',
    'if this ever says PRESENT, the OS folds these names and the trade below is not a trade at all');

  const scrubbed = scrub.deleteEnvNames({ ...parent }, ['ANTHROPIC_API_KEY']);
  assert.ok(!Object.keys(scrubbed).some(k => k === kelvin && scrubbed[k] !== undefined),
    'the deliberate over-removal must actually happen');
});

test('the fold does NOT remove prefixed or suffixed neighbours', () => {
  const env = scrub.deleteEnvNames({
    ANTHROPIC_API_KEY_BACKUP: 'keep', MY_ANTHROPIC_API_KEY: 'keep', KEEP_ME: 'keep',
    anthropic_api_key: MARKER
  }, ['ANTHROPIC_API_KEY']);
  assert.equal(env.ANTHROPIC_API_KEY_BACKUP, 'keep');
  assert.equal(env.MY_ANTHROPIC_API_KEY, 'keep');
  assert.equal(env.KEEP_ME, 'keep');
  assertChildCannotSee(env, childLookup('ANTHROPIC_API_KEY', 'anthropic_api_key'), 'exact-name removal only');
});

/* ------------------------------------------------------------------ */
/* Defects 6-11: every call site that built its own exact-case scrub. */
test('evidence.js harnessEnvironment scrubs a lowercase spelling', () => {
  const env = evidence.harnessEnvironment(parentWith('openai_api_key'));
  assertChildCannotSee(env, childLookup('OPENAI_API_KEY', 'openai_api_key'), 'harnessEnvironment (a MODEL chooses this command)');
});

test('gemini-fleet subscriptionEnvironment scrubs lowercase, AND the cross-provider key', () => {
  withAmbient(parentWith('gemini_api_key'), () => {
    const env = geminiFleet.subscriptionEnvironment();
    assertChildCannotSee(env, childLookup('GEMINI_API_KEY', 'gemini_api_key'), 'gemini-fleet subscriptionEnvironment');
  });
  // It never called the cross-provider scrub at all, so a gemini lane inherited
  // the owner's ANTHROPIC_API_KEY and anything it spawned billed the API.
  withAmbient(parentWith('anthropic_api_key'), () => {
    const env = geminiFleet.subscriptionEnvironment();
    assertChildCannotSee(env, childLookup('ANTHROPIC_API_KEY', 'anthropic_api_key'), 'gemini-fleet must start from the cross-provider scrub');
  });
});

test('lane-runner laneEnvironment does not reopen the hole after the shared scrub', () => {
  withAmbient(parentWith('google_application_credentials'), () => {
    const { env } = laneRunner.laneEnvironment({ laneId: 'round2', backend: 'subscription', baseEnv: process.env });
    assertChildCannotSee(env, childLookup('GOOGLE_APPLICATION_CREDENTIALS', 'google_application_credentials'), 'laneEnvironment(subscription)');
  });
});

test('gemini-agentic environmentFor does not reopen the hole after the shared scrub', () => {
  withAmbient(parentWith('google_application_credentials'), () => {
    const env = geminiAgentic._testing.environmentFor({}, 'subscription', 'round2');
    assertChildCannotSee(env, childLookup('GOOGLE_APPLICATION_CREDENTIALS', 'google_application_credentials'), 'environmentFor(subscription)');
  });
});

test('multi-account scrubbedEnvironment removes a lowercase CODEX_HOME', () => {
  const env = multiAccount.scrubbedEnvironment(parentWith('codex_home'));
  assertChildCannotSee(env, childLookup('CODEX_HOME', 'codex_home'), 'scrubbedEnvironment (a surviving CODEX_HOME selects an account nobody chose)');
});

test('the OLDER multi-account tripwire is case-insensitive too', () => {
  assert.throws(() => multiAccount.assertNoBillingCredentials(parentWith('anthropic_api_key'), { account: 'round2' }),
    /LAUNCH_BILLING_CREDENTIAL_PRESENT|survived the environment scrub/,
    'the detection sweep that fixed the newer tripwire missed this older twin entirely');
});

test('luna-executor scrubEnvironment handles inherited keys, not just casing', () => {
  const scrubEnvironment = lunaExecutor.scrubEnvironment
    || (lunaExecutor._testing && lunaExecutor._testing.scrubEnvironment);
  if (typeof scrubEnvironment !== 'function') {
    assert.fail('luna-executor must export scrubEnvironment so a real child can be spawned from it');
  }
  withPollutedPrototype('openai_api_key', () => {
    assertChildCannotSee(scrubEnvironment({ SAFE: 'yes' }), childLookup('OPENAI_API_KEY', 'openai_api_key'), 'luna scrubEnvironment');
  });
});

/* ------------------------------------------------------------------ */
async function main() {
  assert.ok(tests.length > 0, 'the credential-scrub test registry must not be empty');
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}\n    ${error && error.message}`);
    }
  }

  /* The claim this file's predecessor got wrong, made checkable. */
  console.log(`# ${environmentClaims} environment claims, ${spawns} real child spawns`);
  if (spawns < environmentClaims) {
    console.error(`not ok - REAL-CHILD RULE: ${environmentClaims} environment claims but only ${spawns} spawns`);
    failed += 1;
  }
  if (failed > 0) {
    console.error(`\n${failed} failing`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nall ${tests.length} credential-scrub round-2 checks passed`);
}

main();

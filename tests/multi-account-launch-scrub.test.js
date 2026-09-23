'use strict';
// The launch path must never forward a billing credential, and must always pin
// the account it claims to be running.
//
// This is the expensive-to-get-wrong test. ANTHROPIC_API_KEY is persisted in
// HKCU:\Environment on this machine and Claude Code gives it PRECEDENCE over
// the claude.ai subscription login. A launch that forwards it bills the API
// silently while still reporting "logged in": no error, no exit code, just a
// bill. The R1186 sweeps burned hours on "Credit balance is too low" for
// exactly this reason.
//
// The scrub list is deliberately NOT restated here. This test EXTRACTS the real
// list from cli-provider-gateway.js's own source and asserts the launcher
// removes every name in it. That is what makes it a test rather than lore: add
// a variable to the gateway tomorrow and this test starts requiring it here
// too, with no edit.

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

const { launchEnvironment, scrubbedEnvironment, assertNoBillingCredentials, BILLING_TRIPWIRE, SCRUBBED_HOME_VARIABLES } = require('../src/lib/multi-account/launch.js');
const { MultiAccountError, PROVIDERS, signInFilePath } = require('../src/lib/multi-account/registry.js');
const {
  PROVIDER_ENVIRONMENT_NAMES,
  BILLING_TRIPWIRE: SUPERVISION_BILLING_TRIPWIRE
} = require('../src/lib/supervision/launch-environment.js');

// The names, pinned. Extracting the expected set FROM the gateway is necessary
// but not sufficient: delete a variable there and both sides of the survivors
// assertion shrink together, so it passes trivially and only the count notices.
// That leaves a floor as the sole guard, which is a bet on how many are deleted
// at once -- and losing three lands exactly on the floor. Measured here: 14 of
// these 23 are not on BILLING_TRIPWIRE either, including AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN, so nothing else would have
// caught their removal.
//
// Pinning the names inverts the default. Adding a credential to the gateway
// needs no edit here; REMOVING one goes red and has to be argued for.
const EXPECTED_GATEWAY_SCRUB = Object.freeze([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
  'XAI_API_KEY', 'GROK_API_KEY', 'GROK_API_BASE_URL',
  'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_AUTH_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_BEDROCK_API_KEY', 'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION',
  'AWS_DEFAULT_REGION',
  // Added 2026-08-11. It was missing from the gateway AND from
  // BILLING_TRIPWIRE while claude-process.js's own scrub removed it and called
  // it "a second credential that outranks the subscription session" -- two
  // scrubs disagreeing that a credential exists. Measured: a real child read
  // both spellings straight through safeLaunchEnvironment().
  'CLAUDE_CODE_OAUTH_TOKEN'
]);

/* The anti-vacuity floor, DERIVED rather than typed.
 *
 * It was the literal 20, chosen as "23 real names minus the three the fixture
 * removes". Both numbers then had to be retyped whenever a credential was
 * ADDED -- which is backwards for a pin whose stated contract is "adding a
 * credential needs no edit here; REMOVING one goes red". Adding
 * CLAUDE_CODE_OAUTH_TOKEN turned that contract into two red checks that said
 * nothing about a leak.
 *
 * Derived, the property the floor is actually for holds at any list length:
 * losing the SMALLEST provider family (codex, 4 names) always drops below it. */
const EXTRACTION_FLOOR = EXPECTED_GATEWAY_SCRUB.length - 3;
const HOME = path.join(os.tmpdir(), 'fixture-multi-account-home');
const ATTACKER_PROFILE = path.join(os.tmpdir(), 'fixture-attacker-profile');
const ABSOLUTE_PROFILE = path.join(os.tmpdir(), 'fixture-account-homes', 'subscription');
const ACCOUNT = Object.freeze({
  name: 'fixture-subscription',
  role: 'institutional',
  provider: 'codex',
  profileDir: '.codex-fixture',
  expectEmail: null,
  priority: 1
});

// Read the production declaration used by providerEnvironment(). The gateway
// now imports this table; scraping its function body would correctly find no
// inline names and silently under-test the shared policy.
function gatewayScrubbedNames(providerNames = PROVIDER_ENVIRONMENT_NAMES) {
  assert.deepStrictEqual(Object.keys(providerNames).sort(), ['claude', 'codex', 'gemini', 'grok'],
    'the shared policy must declare exactly the supported subscription provider families');
  const names = new Set();
  for (const provider of ['codex', 'claude', 'gemini', 'grok']) {
    assert.ok(Array.isArray(providerNames[provider]) && providerNames[provider].length > 0,
      `${provider} must declare a non-empty scrub set`);
    for (const name of providerNames[provider]) {
      assert.match(name, /^[A-Z][A-Z0-9_]{2,}$/);
      names.add(name);
    }
  }
  // Anti-vacuity floor -- see EXTRACTION_FLOOR. It sits just under the real
  // count rather than far under it: at a loose floor an extraction that
  // silently lost a WHOLE provider family still passes, and this test's entire
  // value is that it cannot quietly weaken. Losing the smallest family (codex,
  // 4 names) always drops below the floor and goes red here.
  assert.ok(names.size >= EXTRACTION_FLOOR,
    `Only ${names.size} scrubbed names were extracted from the gateway; the extraction has drifted and would silently under-test.`);
  return [...names];
}

function fakeFs({ authFiles = [] } = {}) {
  return {
    statSync(file) {
      if (authFiles.some(candidate => path.resolve(candidate) === path.resolve(file))) return { isFile: () => true };
      const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error;
    }
  };
}

const PROVISIONED = fakeFs({ authFiles: [path.join(HOME, '.codex-fixture', 'auth.json')] });

const checks = [];
function check(name, fn) { checks.push([name, fn]); }

check('every environment variable the gateway scrubs is absent from a launch environment', () => {
  const names = gatewayScrubbedNames();
  const base = { PATH: 'p', USERPROFILE: HOME };
  for (const name of names) base[name] = `sentinel-${name}`;

  const env = launchEnvironment(ACCOUNT, { homeDir: HOME, baseEnvironment: base, fsImpl: PROVISIONED });

  const survivors = names.filter(name => env[name] !== undefined);
  assert.deepStrictEqual(survivors, [],
    `These variables survived into the launch environment: ${survivors.join(', ')}`);
  // The scrub must not be achieved by throwing everything away.
  assert.strictEqual(env.PATH, 'p');
});

check('the gateway still declares every variable this launcher relies on it to scrub', () => {
  // The pin. A gateway that quietly stops scrubbing something fails HERE,
  // where the survivors assertion cannot: that one compares the launcher
  // against a set derived from the gateway, so a deletion shrinks both sides
  // and it passes while checking less.
  const declared = new Set(gatewayScrubbedNames());
  const missing = EXPECTED_GATEWAY_SCRUB.filter(name => !declared.has(name));
  assert.deepStrictEqual(missing, [],
    `cli-provider-gateway.js no longer scrubs: ${missing.join(', ')}. If that removal is deliberate, justify it and update EXPECTED_GATEWAY_SCRUB; until then this launcher is forwarding them.`);
});

check('a shared policy that silently stopped scrubbing three credentials is detected', () => {
  // Proves the pin above can actually fail, and does so for the RIGHT reason.
  // The three removed here are real credentials that no other check covers:
  // they are absent from BILLING_TRIPWIRE, and removing exactly three still
  // clears the anti-vacuity floor -- so the floor alone would report a pass.
  // Before the pin existed this was a silent green.
  const removed = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);
  const weakened = Object.fromEntries(Object.entries(PROVIDER_ENVIRONMENT_NAMES)
    .map(([provider, names]) => [provider, names.filter(name => !removed.has(name))]));
  const declared = new Set(gatewayScrubbedNames(weakened));
  // The floor does NOT catch this, which is the point. Asserted as ">= floor"
  // rather than "== a typed number": the weakened declaration still clears
  // the floor, so only the independent name pin catches the lost credentials.
  assert.ok(declared.size >= EXTRACTION_FLOOR,
    `the fixture must still clear the anti-vacuity floor (${declared.size} < ${EXTRACTION_FLOOR}) to reproduce the silent case`);
  const missing = EXPECTED_GATEWAY_SCRUB.filter(name => !declared.has(name));
  assert.deepStrictEqual(missing.sort(),
    ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
    'the pin must name exactly the credentials that stopped being scrubbed');
  // The immutable production declaration must be untouched by this check.
  assert.strictEqual(new Set(gatewayScrubbedNames()).size, EXPECTED_GATEWAY_SCRUB.length);
});

check('ANTHROPIC_API_KEY specifically is stripped, even though this is a Codex launch', () => {
  // providerEnvironment('codex', ...) alone does NOT strip ANTHROPIC_API_KEY --
  // each provider only strips its own family. A Codex child that inherits it
  // can spawn a Claude CLI that then bills the API. Composing every provider's
  // scrub is what closes that path, so this asserts the union, not the codex
  // list.
  const env = launchEnvironment(ACCOUNT, {
    homeDir: HOME,
    baseEnvironment: { PATH: 'p', ANTHROPIC_API_KEY: 'sk-should-never-survive' },
    fsImpl: PROVISIONED
  });
  assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
});

check('the union really is broader than any single provider scrub', () => {
  const { providerEnvironment } = require('../src/lib/providers/cli-provider-gateway.js');
  const base = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' };
  // Guard the premise of the test above: if the gateway ever made the codex
  // scrub cover Anthropic on its own, this assertion fails loudly rather than
  // leaving the union test passing for a reason that no longer holds.
  assert.strictEqual(providerEnvironment('codex', base).ANTHROPIC_API_KEY, 'a');
  const scrubbed = scrubbedEnvironment(base);
  assert.strictEqual(scrubbed.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(scrubbed.OPENAI_API_KEY, undefined);
  assert.strictEqual(scrubbed.GEMINI_API_KEY, undefined);
});

check('the scrub itself removes a caller-supplied CODEX_HOME', () => {
  // Asserted against scrubbedEnvironment() directly, and NOT via
  // launchEnvironment(), on purpose. launchEnvironment() assigns the pin last,
  // so its final CODEX_HOME is correct whether or not the scrub removed the
  // caller's value -- an assertion there passes for a reason other than the
  // mechanism it claims to check, and a mutation run proved exactly that:
  // deleting the scrub line left the launch test green. scrubbedEnvironment()
  // is exported and usable on its own, so the removal has to be pinned where
  // it actually happens.
  assert.strictEqual(scrubbedEnvironment({ PATH: 'p', CODEX_HOME: ATTACKER_PROFILE }).CODEX_HOME, undefined);
});

check('the scrub removes a caller-supplied GEMINI_CLI_HOME the same way, in any spelling', () => {
  // Gemini is a folder-based provider now, and its CLI reads GEMINI_CLI_HOME
  // the way Codex reads CODEX_HOME: an inherited value selects an account
  // nobody chose. Same rule, same place, both spellings.
  assert.strictEqual(scrubbedEnvironment({ PATH: 'p', GEMINI_CLI_HOME: ATTACKER_PROFILE }).GEMINI_CLI_HOME, undefined);
  const lower = scrubbedEnvironment({ PATH: 'p', gemini_cli_home: ATTACKER_PROFILE });
  assert.strictEqual(lower.gemini_cli_home, undefined);
  assert.strictEqual(lower.GEMINI_CLI_HOME, undefined);
  assert.deepStrictEqual([...SCRUBBED_HOME_VARIABLES], ['CODEX_HOME', 'GEMINI_CLI_HOME', 'GROK_HOME']);
});

check('a Grok launch scrubs inherited selectors and pins only the selected signed-in home', () => {
  assert.strictEqual(scrubbedEnvironment({ PATH: 'p', grok_home: ATTACKER_PROFILE }).grok_home, undefined);
  const grok = { name: 'fixture-grok', provider: 'grok', configDir: '.grok-fixture', priority: 1 };
  const selectedHome = path.join(HOME, '.grok-fixture');
  const env = launchEnvironment(grok, {
    homeDir: HOME,
    baseEnvironment: { PATH: 'p', GROK_HOME: ATTACKER_PROFILE, GEMINI_CLI_HOME: ATTACKER_PROFILE, XAI_API_KEY: 'sentinel' },
    fsImpl: fakeFs({ authFiles: [signInFilePath(selectedHome, PROVIDERS.grok)] })
  });
  assert.strictEqual(env.GROK_HOME, selectedHome);
  assert.strictEqual(env.GEMINI_CLI_HOME, undefined);
  assert.strictEqual(env.XAI_API_KEY, undefined);
});

check('a Gemini launch pins GEMINI_CLI_HOME to its home, judged by the sign-in file one level down', () => {
  const gemini = { name: 'fixture-gemini', provider: 'gemini', homeDir: '.gemini-fixture', priority: 1 };
  const signedIn = fakeFs({ authFiles: [path.join(HOME, '.gemini-fixture', '.gemini', 'oauth_creds.json')] });
  const env = launchEnvironment(gemini, {
    homeDir: HOME,
    baseEnvironment: { PATH: 'p', GEMINI_CLI_HOME: ATTACKER_PROFILE, CODEX_HOME: ATTACKER_PROFILE },
    fsImpl: signedIn
  });
  assert.strictEqual(env.GEMINI_CLI_HOME, path.join(HOME, '.gemini-fixture'));
  // A Gemini launch names its own variable and nothing of the other provider's.
  assert.strictEqual(env.CODEX_HOME, undefined);

  // Without the sign-in file the launch refuses, naming the right program.
  let thrown = null;
  try {
    launchEnvironment(gemini, { homeDir: HOME, baseEnvironment: { PATH: 'p' }, fsImpl: fakeFs({ authFiles: [] }) });
  } catch (error) { thrown = error; }
  assert.ok(thrown instanceof MultiAccountError);
  assert.strictEqual(thrown.code, 'ACCOUNT_PROFILE_UNAVAILABLE');
  assert.ok(thrown.message.includes('signed-in Gemini home'), thrown.message);
});

check('a Claude launch pins CLAUDE_CONFIG_DIR to its home, and names no other program\'s variable', () => {
  const claude = { name: 'fixture-claude', provider: 'claude', configDir: '.claude-fixture', priority: 1 };
  const home = path.join(HOME, '.claude-fixture');
  // The sign-in file is whatever the provider table says it is; nothing here names it.
  const signedIn = fakeFs({ authFiles: [signInFilePath(home, PROVIDERS.claude)] });
  const env = launchEnvironment(claude, {
    homeDir: HOME,
    baseEnvironment: { PATH: 'p', CODEX_HOME: ATTACKER_PROFILE, GEMINI_CLI_HOME: ATTACKER_PROFILE },
    fsImpl: signedIn
  });
  assert.strictEqual(env.CLAUDE_CONFIG_DIR, home, 'a Claude launch did not pin the folder Claude reads');
  assert.strictEqual(env.CODEX_HOME, undefined);
  assert.strictEqual(env.GEMINI_CLI_HOME, undefined);

  let thrown = null;
  try {
    launchEnvironment(claude, { homeDir: HOME, baseEnvironment: { PATH: 'p' }, fsImpl: fakeFs({ authFiles: [] }) });
  } catch (error) { thrown = error; }
  assert.ok(thrown instanceof MultiAccountError);
  assert.strictEqual(thrown.code, 'ACCOUNT_PROFILE_UNAVAILABLE');
  assert.ok(thrown.message.includes('signed-in Claude home'), thrown.message);
});

check('a caller-supplied CODEX_HOME cannot survive into a launch', () => {
  const env = launchEnvironment(ACCOUNT, {
    homeDir: HOME,
    baseEnvironment: { PATH: 'p', CODEX_HOME: ATTACKER_PROFILE },
    fsImpl: PROVISIONED
  });
  assert.strictEqual(env.CODEX_HOME, path.join(HOME, '.codex-fixture'));
});

check('the launch pins CODEX_HOME to the account it says it is running', () => {
  const env = launchEnvironment(ACCOUNT, { homeDir: HOME, baseEnvironment: { PATH: 'p' }, fsImpl: PROVISIONED });
  assert.strictEqual(env.CODEX_HOME, path.join(HOME, '.codex-fixture'));
});

check('an absolute profileDir is honoured verbatim', () => {
  const account = { ...ACCOUNT, profileDir: ABSOLUTE_PROFILE };
  const env = launchEnvironment(account, {
    homeDir: HOME,
    baseEnvironment: { PATH: 'p' },
    fsImpl: fakeFs({ authFiles: [path.join(ABSOLUTE_PROFILE, 'auth.json')] })
  });
  assert.strictEqual(env.CODEX_HOME, path.resolve(ABSOLUTE_PROFILE));
});

check('an unprovisioned account REFUSES the launch instead of falling back to the ambient default', () => {
  // Falling back is how the 2026-08-09 wrong-identity incident stayed
  // invisible: dispatch scrubbed CODEX_HOME, pinned nothing, and every worker
  // silently ran as whatever ~/.codex held.
  assert.throws(
    () => launchEnvironment(ACCOUNT, { homeDir: HOME, baseEnvironment: { PATH: 'p' }, fsImpl: fakeFs({ authFiles: [] }) }),
    error => error instanceof MultiAccountError && error.code === 'ACCOUNT_PROFILE_UNAVAILABLE'
  );
});

check('a failed provisioning read refuses without claiming the account is unprovisioned', () => {
  const unreadableFs = {
    statSync() {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
  };
  assert.throws(
    () => launchEnvironment(ACCOUNT, { homeDir: HOME, baseEnvironment: { PATH: 'p' }, fsImpl: unreadableFs }),
    error => error instanceof MultiAccountError &&
      error.code === 'ACCOUNT_PROFILE_CHECK_FAILED' &&
      error.details.failureCode === 'EACCES' &&
      !error.message.includes('has no signed-in Codex home')
  );
});

check('the billing tripwire refuses a launch when a credential survives, naming it without printing it', () => {
  let thrown = null;
  try {
    assertNoBillingCredentials({ ANTHROPIC_API_KEY: 'sk-secret-value-here', PATH: 'p' }, { account: 'fixture-subscription' });
  } catch (error) { thrown = error; }
  assert.ok(thrown instanceof MultiAccountError, 'a surviving billing credential must refuse the launch');
  assert.strictEqual(thrown.code, 'LAUNCH_BILLING_CREDENTIAL_PRESENT');
  assert.ok(thrown.message.includes('ANTHROPIC_API_KEY'), 'the refusal must name the variable');
  assert.ok(!thrown.message.includes('sk-secret-value-here'), 'the refusal must NEVER contain the value');
});

check('the tripwire covers every credential the gateway scrubs, not just billing keys', () => {
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
    assert.ok(BILLING_TRIPWIRE.includes(name), `${name} must be on the billing tripwire`);
  }
  // The AWS access-key triple was uncovered until measured: the gateway strips
  // it, but the tripwire is the layer that refuses the launch if the scrub ever
  // stops working, and a credential protected only by the layer above it is not
  // protected.
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
    assert.ok(BILLING_TRIPWIRE.includes(name), `${name} is a real credential and must be on the billing tripwire`);
  }
  // CLAUDE_CODE_OAUTH_TOKEN is a session bearer credential -- the EXPECTED_
  // GATEWAY_SCRUB comment above calls it exactly that ("a second credential
  // that outranks the subscription session"). This check used to stop at the
  // AWS triple and a comment here claimed "the remaining uncovered names are
  // config and redirect flags, not credentials", which was false for this one
  // and let it stay off BILLING_TRIPWIRE undetected. Named individually,
  // not folded into the AWS loop above, so a future removal of this exact
  // name fails on a line that says what it is.
  assert.ok(BILLING_TRIPWIRE.includes('CLAUDE_CODE_OAUTH_TOKEN'),
    'CLAUDE_CODE_OAUTH_TOKEN is a session bearer credential and must be on the billing tripwire');
});

check('the launcher does not carry its own second copy of the billing tripwire', () => {
  // MEASURED before this fix: multi-account/launch.js declared its own
  // BILLING_TRIPWIRE (12 names) instead of importing supervision/launch-
  // environment.js's (19). Seven names were only on the shared list --
  // ANTHROPIC_BASE_URL, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK,
  // CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_USE_FOUNDRY, OPENAI_BASE_URL,
  // GOOGLE_GENAI_USE_VERTEXAI -- and assertNoBillingCredentials() here did not
  // throw for an environment carrying CLAUDE_CODE_OAUTH_TOKEN while the
  // supervision copy of the identical check refused it. Same rule, same
  // credential, two answers. Asserted as reference equality, not
  // deepStrictEqual: a future re-split back into two lists that HAPPEN to
  // match today is the same bug waiting for the next addition, and only
  // identity catches that it is one list again.
  assert.strictEqual(BILLING_TRIPWIRE, SUPERVISION_BILLING_TRIPWIRE,
    'multi-account/launch.js must import BILLING_TRIPWIRE from supervision/launch-environment.js, not declare its own');
});

check('a leaked CLAUDE_CODE_OAUTH_TOKEN refuses the launch through this launcher specifically', () => {
  // The regression pin for the bug above, exercised the same way a real
  // caller would hit it: through assertNoBillingCredentials() as exported by
  // multi-account/launch.js (tool-registry.js, research/runners.js,
  // status-injection.js and cloud-agent/codex-cloud-launch.js all reach the
  // tripwire only through this module, not through supervision/launch-
  // environment.js directly).
  let thrown = null;
  try {
    assertNoBillingCredentials(
      { PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-should-never-survive' },
      { account: 'fixture-subscription' }
    );
  } catch (error) { thrown = error; }
  assert.ok(thrown instanceof MultiAccountError, 'a surviving Claude OAuth token must refuse the launch');
  assert.strictEqual(thrown.code, 'LAUNCH_BILLING_CREDENTIAL_PRESENT');
  assert.ok(thrown.message.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'the refusal must name the variable');
  assert.ok(!thrown.message.includes('sk-ant-oat01-should-never-survive'), 'the refusal must NEVER contain the value');
});

check('a clean environment passes the tripwire', () => {
  assert.doesNotThrow(() => assertNoBillingCredentials({ PATH: 'p', CODEX_HOME: 'x' }));
});

let failures = 0;
for (const [name, fn] of checks) {
  try { fn(); process.stdout.write(`ok   ${name}\n`); }
  catch (error) { failures += 1; process.stdout.write(`FAIL ${name}\n     ${error.message}\n`); }
}
process.stdout.write(`\n${checks.length - failures}/${checks.length} checks passed\n`);
process.exitCode = failures === 0 ? 0 : 1;

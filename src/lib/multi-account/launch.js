'use strict';
// The launch path: build the environment a chosen account runs under.
//
// Two things happen here and they are ONE operation. Splitting them is how this
// system has failed before, twice:
//
//   1. SCRUB the ambient environment of every credential that would override
//      the subscription login. On Windows, ANTHROPIC_API_KEY is routinely
//      persisted machine-wide in HKCU:\Environment -- by a user, by an
//      installer, by an experiment nobody remembers running -- and Claude Code
//      gives it PRECEDENCE over the claude.ai subscription login, so a session
//      launched without the scrub silently bills the API while still reporting
//      "logged in". Measured on a real deployment: a worker sweep died on
//      "Credit balance is too low" for hours for exactly this reason (R1186)
//      and nothing surfaced it.
//
//   2. PIN the account by setting the provider's home variable to that
//      account's own home: CODEX_HOME for a Codex account, GEMINI_CLI_HOME for
//      a Gemini one. Measured on a real deployment: dispatch scrubbed
//      CODEX_HOME and pinned nothing, so every worker ran as whatever ~/.codex
//      happened to hold -- the wrong account, silently.
//
// Do one without the other and you get a correct-looking launch that bills the
// wrong thing or runs as the wrong person. Neither is visible from the outside.
//
// The scrub list is NOT duplicated here. It is composed from the gateway's own
// providerEnvironment() across every provider, so this launcher strips the
// union of what the gateway strips and automatically inherits anything added
// there later. tests/multi-account-launch-scrub.test.js extracts the gateway's
// real scrub list from its source and proves this launcher removes all of it.
//
// WHICH FILE AND WHICH VARIABLE come from the one table registry.js keeps
// (PROVIDERS): the account's own provider says what its sign-in file is called
// and which environment name selects its home. This launcher used to spell
// both out for Codex alone; a third folder-based provider made that a second
// copy of the table, so it now reads the table.

const fs = require('node:fs');
const path = require('node:path');

const { executableFor, providerEnvironment } = require('../providers/cli-provider-gateway.js');
const { MultiAccountError, PROVIDERS, providerSpec, resolveProfileDir, signInFilePath } = require('./registry.js');
const { deleteEnvNames, presentEnvNames } = require('../env-scrub.js');
const { BILLING_TRIPWIRE } = require('../supervision/launch-environment.js');
const providerIsolation = require('../provider-session-isolation');

// Composing every provider's scrub, not just the launched provider's, is
// deliberate. providerEnvironment('codex', ...) does NOT strip
// ANTHROPIC_API_KEY -- each provider only strips its own family. A Codex child
// that inherits ANTHROPIC_API_KEY can spawn a Claude CLI that then bills the
// API. The union closes that path.
const SCRUBBED_PROVIDERS = Object.freeze(['codex', 'claude', 'gemini', 'grok']);

// Defence in depth only. The scrub above is the mechanism; this is a tripwire
// that refuses to launch if a billing credential somehow survived it, so the
// failure is a loud refusal instead of a silent charge.
//
// BILLING_TRIPWIRE ITSELF USED TO BE A SECOND, HAND-TYPED COPY OF THIS LIST,
// RIGHT HERE. Two independent name lists is exactly the shape that drifts: the
// 2026-08-11 sweep that fixed this tripwire's case-sensitivity bug (see the
// history above -- envScrub.presentEnvNames replaced an exact-case lookup)
// updated the DETECTOR the two files share, but each file still declared its
// own CONTENTS for that detector to walk, and only supervision/launch-
// environment.js's copy grew a seventh provider-redirect/credential entry
// afterwards. MEASURED against this tree before this fix: this file's local
// array had 12 names against launch-environment.js's 19, missing
// ANTHROPIC_BASE_URL, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK,
// CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_USE_FOUNDRY, OPENAI_BASE_URL and
// GOOGLE_GENAI_USE_VERTEXAI -- CLAUDE_CODE_OAUTH_TOKEN among them, a literal
// session bearer credential. assertNoBillingCredentials() below did not throw
// for an environment carrying it, while launch-environment.js's own copy of
// this same check refused that exact environment. The scrub above already
// removes all of these (providerEnvironment() imports the same table this now
// imports), which is why the gap stayed silent: this tripwire only mattered
// on the day the scrub above it stopped working, and on that day it would not
// have fired for a real bearer token. Importing the list fixes the cause --
// there is one BILLING_TRIPWIRE now, not two that can disagree -- rather than
// re-typing the missing seven and leaving the next addition to drift again.
// See tests/multi-account-launch-scrub.test.js.

// The home variables a launch is allowed to SET and therefore must never
// INHERIT. A caller-supplied CODEX_HOME or GEMINI_CLI_HOME would silently
// select an account nobody chose, so both are removed here and set only from
// the registry below. Read off the provider table so the list cannot drift
// from the variables launchEnvironment() pins.
const SCRUBBED_HOME_VARIABLES = Object.freeze([PROVIDERS.codex.homeEnv, PROVIDERS.gemini.homeEnv, PROVIDERS.grok.homeEnv]);

function scrubbedEnvironment(baseEnvironment = process.env) {
  let environment = { ...baseEnvironment };
  for (const provider of SCRUBBED_PROVIDERS) {
    environment = providerEnvironment(provider, environment);
  }
  // This was `delete environment.CODEX_HOME` -- exact-case, so a lowercase
  // `codex_home` survived this exported scrub and a real child read canonical
  // CODEX_HOME, i.e. selected an account nobody chose. launchEnvironment()
  // below happens to overwrite it afterwards, so the defect was in what this
  // function PROMISES its callers rather than in that one wrapper's result --
  // which is worse, because the promise is what the next caller relies on.
  // GEMINI_CLI_HOME joined the list when Gemini became a folder-based
  // provider: the Gemini CLI reads it the way Codex reads CODEX_HOME.
  return deleteEnvNames(environment, SCRUBBED_HOME_VARIABLES);
}

// The provider's name as a person reads it, for the sentences below.
const PROVIDER_WORD = Object.freeze({ codex: 'Codex', claude: 'Claude', gemini: 'Gemini', grok: 'Grok' });

function assertNoBillingCredentials(environment, { account } = {}) {
  /* CASE-INSENSITIVE, and it walks what the CHILD would receive.
   *
   * This filtered on `environment[name] !== undefined` -- an exact-case lookup
   * on a plain object -- while Windows resolves environment names
   * case-insensitively and node enumerates inherited enumerable properties into
   * the child. MEASURED: this tripwire accepted an environment carrying
   * `anthropic_api_key` while a real child spawned from it read the canonical
   * name. A tripwire blind to exactly the case that leaks certifies the leak.
   *
   * subscription-launch-env.js's newer tripwire had the same defect and the
   * detection sweep that fixed it missed this older twin entirely. Both now
   * share one detector, so there is one place left to be wrong. */
  const leaked = presentEnvNames(environment, BILLING_TRIPWIRE);
  if (leaked.length > 0) {
    // Names only. The values are exactly what must never be printed.
    throw new MultiAccountError('LAUNCH_BILLING_CREDENTIAL_PRESENT',
      `Refusing to launch${account ? ` account "${account}"` : ''}: ${leaked.join(', ')} survived the environment scrub and would take precedence over the subscription login.`,
      { variables: leaked });
  }
}

// Fail closed. A configured account whose home is missing or signed out REFUSES
// rather than falling back to the ambient default -- falling back is how the
// wrong-identity incident stayed invisible.
function launchEnvironment(account, {
  homeDir = process.env.USERPROFILE || process.env.HOME || '',
  baseEnvironment = process.env,
  fsImpl = fs
} = {}) {
  if (!account || typeof account.name !== 'string') {
    throw new MultiAccountError('ACCOUNTS_ENTRY_INVALID', 'No account was given to launch.');
  }
  let environment = scrubbedEnvironment(baseEnvironment);
  const resolved = resolveProfileDir(account, { homeDir });
  // The account's own provider names the sign-in file and the home variable.
  // Defaulting to Codex keeps an account literal built before this launcher
  // knew about other providers asking exactly the question it always asked.
  const spec = providerSpec(account.provider) || PROVIDERS.codex;
  environment = providerIsolation.providerSessionEnvironment(environment, { provider: spec.id, home: resolved, requireHome: true });
  providerIsolation.assertIsolatedPath(signInFilePath(resolved, spec), providerIsolation.isolationContext(environment),
    { field: 'provider sign-in file' });
  const word = PROVIDER_WORD[spec.id] || spec.id;

  let provisioned;
  try {
    provisioned = fsImpl.statSync(signInFilePath(resolved, spec)).isFile();
  } catch (error) {
    // ENOENT/ENOTDIR establish that the sign-in file is absent. Other failures
    // do not: for example, EACCES says the provisioning check could not read
    // the path, not that the account is unprovisioned. Preserve that
    // uncertainty while still refusing the launch instead of collapsing it
    // into a definite ACCOUNT_PROFILE_UNAVAILABLE answer.
    if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
      throw new MultiAccountError('ACCOUNT_PROFILE_CHECK_FAILED',
        `Could not verify the signed-in ${word} home for account "${account.name}" at ${resolved}; refusing to launch.`,
        { account: account.name, profileDir: resolved, failureCode: error && error.code });
    }
    provisioned = false;
  }
  if (!provisioned) {
    throw new MultiAccountError('ACCOUNT_PROFILE_UNAVAILABLE',
      `Account "${account.name}" has no signed-in ${word} home at ${resolved}.`,
      { account: account.name, profileDir: resolved });
  }

  environment[spec.homeEnv] = resolved;
  assertNoBillingCredentials(environment, { account: account.name });
  return environment;
}

function codexExecutable() {
  return executableFor('codex');
}

module.exports = Object.freeze({
  BILLING_TRIPWIRE,
  SCRUBBED_HOME_VARIABLES,
  SCRUBBED_PROVIDERS,
  assertNoBillingCredentials,
  codexExecutable,
  launchEnvironment,
  scrubbedEnvironment
});

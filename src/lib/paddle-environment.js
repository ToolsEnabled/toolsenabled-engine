'use strict';

// WHICH PADDLE ACCOUNT THIS INSTALLATION BILLS AGAINST.
//
// WHAT WAS WRONG. `providers/paddle.js` did not have a sandbox DEFAULT; it had
// a sandbox PIN. The API host was a constant, the two vault key names were
// constants, two guards threw on any other key, and the tool schema in
// `tool-registry.js` carried single-value enums so the guards could not even be
// reached from the tool surface. The consequence was not "safe by default": it
// was that no amount of merchant-account setup could make a real charge
// possible, and the only way to take money was to edit source. A payment
// integration that requires a code change to be paid with is not a payment
// integration.
//
// WHAT THIS IS. One place that answers, for the whole tree, "sandbox or live?"
// and returns everything that follows from the answer -- host, API key name,
// webhook secret name. Nothing else in the tree is allowed to spell those out,
// because the failure that matters here is DISAGREEMENT: a build that talks to
// the live host while stamping `environment: 'sandbox'` on its audit record
// would record real charges as tests, which is worse than either environment
// consistently applied.
//
// WHY IT LIVES AT THIS LAYER, not next to the provider. Readiness reporting,
// credential metadata, the secret-store requirement table and the MCP tool
// schemas all need the key names, and none of them should
// have to require the provider stack (HTTP, audit, policy, state) to learn two
// strings. This module uses only the runtime path helper and Node builtins,
// without loading the provider stack.
//
// HOW IT FAILS. CLOSED, and the distinction below is the whole point:
//
//   A RECORDED CHOICE is the only thing that selects `live`. Absent config,
//   unreadable config, unparsable config, a document with no `environment`
//   field, or a field naming something we do not recognise all resolve to
//   SANDBOX. Every one of those is a state an installation can reach without
//   anybody deciding anything, and none of them may put real money in motion.
//   This codebase's dominant defect is ABSENCE READ AS CONSENT; going live is
//   precisely the place it would be most expensive.
//
//   AN EXPLICIT VALUE THROWS when it is not recognised. `environmentProfile()`
//   is for callers that already hold a value and are asserting it -- the same
//   shape as the vault-key guards in `providers/paddle.js`, which throw rather
//   than substituting a default. Silently downgrading a caller who wrote
//   `live` (mistyped, say, as `production`) to sandbox would hide the mistake
//   behind working-looking sandbox traffic. Silently downgrading a *config
//   file* is different and is the right answer there: nobody is waiting on a
//   return value, and a broken file must not stop the product from running.

const fs = require('node:fs');
const path = require('node:path');
const { statePath } = require('./runtime-state-root');

// Per-installation, exactly like config/entitlement.profile.json beside it: one
// operator's decision about their own merchant account, not a product fact.
// Absence is a NORMAL, fully working install -- see FAIL_CLOSED_ENVIRONMENT --
// so there is no shipped template to go with it, and it is gitignored.
const CONFIG_RELATIVE_PATH = path.join('config', 'paddle-environment.json');

// Named rather than written inline at each fallback so that the answer to "what
// happens when nothing is configured?" is one grep and one line, not five.
const FAIL_CLOSED_ENVIRONMENT = 'sandbox';

const ENVIRONMENTS = Object.freeze({
  sandbox: Object.freeze({
    environment: 'sandbox',
    label: 'Paddle sandbox',
    apiRoot: 'https://sandbox-api.paddle.com',
    apiVaultKey: 'paddle_sandbox_api_key',
    webhookVaultKey: 'paddle_sandbox_webhook_secret',
    // Stated as data rather than left implicit in the host name, so a surface
    // deciding whether to warn a human does not have to pattern-match a URL.
    chargesRealMoney: false
  }),
  live: Object.freeze({
    environment: 'live',
    label: 'Paddle live',
    apiRoot: 'https://api.paddle.com',
    // Deliberately NOT the sandbox names. Sharing one key name across
    // environments would mean a single vault write silently repoints every
    // charge, and would make "which account did that transaction hit?"
    // unanswerable after the fact.
    apiVaultKey: 'paddle_live_api_key',
    webhookVaultKey: 'paddle_live_webhook_secret',
    chargesRealMoney: true
  })
});

const ENVIRONMENT_NAMES = Object.freeze(Object.keys(ENVIRONMENTS));
// Sandbox first in both lists: these become the tool-schema enums, and the
// first option is what a reader skims as the ordinary case.
const API_VAULT_KEYS = Object.freeze(ENVIRONMENT_NAMES.map(name => ENVIRONMENTS[name].apiVaultKey));
const WEBHOOK_VAULT_KEYS = Object.freeze(ENVIRONMENT_NAMES.map(name => ENVIRONMENTS[name].webhookVaultKey));

class PaddleEnvironmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaddleEnvironmentError';
    this.code = 'PADDLE_ENVIRONMENT_INVALID';
  }
}

function known(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ENVIRONMENTS, name);
}

/**
 * The profile for an environment a caller is ASSERTING.
 *
 * Throws on anything unrecognised. See the header: an explicit value is a claim
 * and a wrong claim must surface, while a config file is a state and a broken
 * state must fail closed.
 */
function environmentProfile(name) {
  if (!known(name)) {
    throw new PaddleEnvironmentError(`Paddle environment must be one of: ${ENVIRONMENT_NAMES.join(', ')}.`);
  }
  return ENVIRONMENTS[name];
}

function decision(environment, reason, configPath) {
  return Object.freeze({
    environment,
    profile: ENVIRONMENTS[environment],
    // True only when a recorded document named this environment. Every fallback
    // reports false, so a surface can say "nothing has been recorded" instead of
    // presenting the fail-closed answer as somebody's decision.
    recorded: reason === 'recorded',
    reason,
    configPath
  });
}

/**
 * What environment this installation is configured for, and why.
 *
 * `reason` is one of: recorded, absent, unreadable, unparsable, malformed,
 * undeclared, unrecognised. It is returned rather than logged because the
 * callers that care (paddle.doctor, readiness reporting) are the ones that can
 * put it in front of a human; a module at this layer must not decide that for
 * them.
 */
function resolvePaddleEnvironment({ root, configPath, readFile = fs.readFileSync } = {}) {
  // The merchant choice belongs to this installation's writable state. An
  // explicit root/configPath remains a deliberate diagnostic or setup target;
  // ordinary installed calls must not borrow another profile's program config.
  const resolved = configPath !== undefined ? path.resolve(configPath)
    : root !== undefined ? path.join(root, CONFIG_RELATIVE_PATH)
      : statePath('config', 'paddle-environment.json');
  let text;
  try {
    text = readFile(resolved, 'utf8');
  } catch (error) {
    // ENOENT is the shipped state of every fresh checkout and is not a fault.
    // Anything else (permissions, a directory in the way) is a fault, and it is
    // reported as one -- but it still resolves to sandbox, because a file this
    // process cannot read is not evidence that anybody chose to go live.
    return decision(FAIL_CLOSED_ENVIRONMENT, error && error.code === 'ENOENT' ? 'absent' : 'unreadable', resolved);
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return decision(FAIL_CLOSED_ENVIRONMENT, 'unparsable', resolved);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return decision(FAIL_CLOSED_ENVIRONMENT, 'malformed', resolved);
  }
  if (!Object.prototype.hasOwnProperty.call(document, 'environment')) {
    return decision(FAIL_CLOSED_ENVIRONMENT, 'undeclared', resolved);
  }
  if (!known(document.environment)) {
    return decision(FAIL_CLOSED_ENVIRONMENT, 'unrecognised', resolved);
  }
  return decision(document.environment, 'recorded', resolved);
}

/** The profile alone, for the many callers that need only the key names. */
function paddleProfile(options) {
  return resolvePaddleEnvironment(options).profile;
}

module.exports = {
  API_VAULT_KEYS,
  CONFIG_RELATIVE_PATH,
  ENVIRONMENTS,
  ENVIRONMENT_NAMES,
  FAIL_CLOSED_ENVIRONMENT,
  PaddleEnvironmentError,
  WEBHOOK_VAULT_KEYS,
  environmentProfile,
  paddleProfile,
  resolvePaddleEnvironment
};

'use strict';

// Dependency-light child environment policy for the health control plane.
//
// The observer must never inherit ambient provider credentials, but it must
// also remain loadable while provider and fleet code is broken or mid-edit.
// This module therefore depends only on the pure, built-ins-only env-scrub
// helper. Launchers and the observer share one policy and one credential list.

const envScrub = require('../env-scrub.js');
const { stripPowerShellSevenModulePathEntries } = require('./powershell-module-path.js');

const SUBSCRIPTION_PROVIDER_IDS = Object.freeze(['codex', 'claude', 'gemini', 'grok']);

// One declaration owns both the provider-specific removal sets and the
// fail-closed billing tripwire. `tripwire: false` is deliberate for selectors
// that must not redirect a subscription child but are not themselves a secret
// or endpoint. Keeping that distinction on each record avoids maintaining two
// overlapping name lists by hand.
const ENVIRONMENT_RULES = Object.freeze([
  ['ANTHROPIC_API_KEY', 'claude', true],
  ['ANTHROPIC_AUTH_TOKEN', 'claude', true],
  ['ANTHROPIC_BASE_URL', 'claude', true],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'claude', true],
  ['CLAUDE_CODE_USE_BEDROCK', 'claude', true],
  ['CLAUDE_CODE_USE_VERTEX', 'claude', true],
  ['CLAUDE_CODE_USE_FOUNDRY', 'claude', true],
  ['AWS_BEARER_TOKEN_BEDROCK', 'claude', true],
  ['AWS_BEDROCK_API_KEY', 'claude', true],
  ['AWS_ACCESS_KEY_ID', 'claude', true],
  ['AWS_SECRET_ACCESS_KEY', 'claude', true],
  ['AWS_SESSION_TOKEN', 'claude', true],
  ['OPENAI_API_KEY', 'codex', true],
  ['OPENAI_BASE_URL', 'codex', true],
  ['CODEX_API_KEY', 'codex', true],
  ['CODEX_ACCESS_TOKEN', 'codex', true],
  ['GEMINI_API_KEY', 'gemini', true],
  ['GOOGLE_API_KEY', 'gemini', true],
  ['GOOGLE_GENAI_USE_VERTEXAI', 'gemini', true],
  ['XAI_API_KEY', 'grok', true],
  ['GROK_API_KEY', 'grok', true],
  ['GROK_API_BASE_URL', 'grok', true],
  ['GROK_CLI_CHAT_PROXY_BASE_URL', 'grok', true],
  ['GROK_AUTH_TOKEN', 'grok', true],
  ['AWS_PROFILE', 'claude', false],
  ['AWS_REGION', 'claude', false],
  ['AWS_DEFAULT_REGION', 'claude', false],
  ['GOOGLE_CLOUD_PROJECT', 'gemini', false],
  ['GOOGLE_CLOUD_LOCATION', 'gemini', false]
].map(([name, provider, tripwire]) => Object.freeze({ name, provider, tripwire })));

const PROVIDER_ENVIRONMENT_NAMES = Object.freeze(Object.fromEntries(
  SUBSCRIPTION_PROVIDER_IDS.map(provider => [provider, Object.freeze(
    ENVIRONMENT_RULES.filter(rule => rule.provider === provider).map(rule => rule.name)
  )])
));
const BILLING_TRIPWIRE = Object.freeze(
  ENVIRONMENT_RULES.filter(rule => rule.tripwire).map(rule => rule.name)
);

class LaunchEnvironmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LaunchEnvironmentError';
    this.code = code;
    this.details = details;
  }
}

function subscriptionLaunchEnvironment(baseEnvironment = process.env) {
  if (!baseEnvironment || typeof baseEnvironment !== 'object') {
    throw new LaunchEnvironmentError(
      'LAUNCH_ENVIRONMENT_INVALID',
      'A subscription CLI launch environment could not be constructed.'
    );
  }
  // Retain the established provider-fold shape exactly. Each spread makes a
  // caller-owned environment immutable from this function's point of view;
  // envScrub preserves the Windows case-insensitive and inherited-key rules.
  let environment = { ...baseEnvironment };
  for (const providerId of SUBSCRIPTION_PROVIDER_IDS) {
    environment = envScrub.deleteEnvNames(
      { ...environment }, PROVIDER_ENVIRONMENT_NAMES[providerId]
    );
  }
  return environment;
}

function assertNoBillingCredentials(environment, { context = '' } = {}) {
  if (environment === null || environment === undefined) {
    throw new LaunchEnvironmentError(
      'LAUNCH_ENVIRONMENT_INHERITS_AMBIENT',
      `Refusing to launch a subscription CLI${context ? ` (${context})` : ''}: the launch environment is ${String(environment)}, which node treats as "inherit the full ambient environment" -- including every credential this scrub exists to remove.`,
      { variables: [] }
    );
  }
  const leaked = envScrub.presentEnvNames(environment, BILLING_TRIPWIRE);
  if (leaked.length > 0) {
    throw new LaunchEnvironmentError(
      'LAUNCH_BILLING_CREDENTIAL_PRESENT',
      `Refusing to launch a subscription CLI${context ? ` (${context})` : ''}: ${leaked.join(', ')} survived the environment scrub and would take precedence over the subscription login.`,
      { variables: leaked }
    );
  }
  return environment;
}

function applyPowerShellSevenModulePathScrub(environment, { platform = process.platform, childExecutable } = {}) {
  if (!childExecutable) return environment;
  return stripPowerShellSevenModulePathEntries(environment, { platform, childExecutable });
}

function safeLaunchEnvironment(baseEnvironment = process.env, { context = '', platform, childExecutable } = {}) {
  const environment = assertNoBillingCredentials(subscriptionLaunchEnvironment(baseEnvironment), { context });
  return applyPowerShellSevenModulePathScrub(environment, { platform, childExecutable });
}

module.exports = Object.freeze({
  BILLING_TRIPWIRE,
  LaunchEnvironmentError,
  PROVIDER_ENVIRONMENT_NAMES,
  SUBSCRIPTION_PROVIDER_IDS,
  assertNoBillingCredentials,
  safeLaunchEnvironment,
  subscriptionLaunchEnvironment
});

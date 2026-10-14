'use strict';

// The credential catalogue is deliberately closed for automatic prompts.  A
// tool may only ask for a known provider field while it is already executing;
// arbitrary vault keys remain opt-in through system.credential_request.

const GOOGLE_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CUSTOM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function definition(label) {
  return Object.freeze({ label });
}

const DEFINITIONS = Object.freeze({
  ig_access_token: definition('Instagram access token'),
  ig_user_id: definition('Instagram user ID'),
  cws_access_token: definition('Chrome Web Store access token'),
  cws_refresh_token: definition('Chrome Web Store refresh token'),
  cws_client_id: definition('Chrome Web Store OAuth client ID'),
  cws_client_secret: definition('Chrome Web Store OAuth client secret'),
  cws_publisher_id: definition('Chrome Web Store fixed publisher ID'),
  google_access_token: definition('Google OAuth access token'),
  google_refresh_token: definition('Google OAuth refresh token'),
  google_client_id: definition('Google OAuth client ID'),
  google_client_secret: definition('Google OAuth client secret'),
  // RELABELLED, NOT PURGED. Discord left the product on 2026-08-22 (owner
  // ruling, O4). Nothing reads these two keys any more and neither is a
  // diagnostic input below. They stay in the catalogue so an owner who stored
  // one still sees it listed, with a label that says what to do. Deleting
  // owner-supplied secret material on upgrade, without a decision, is not
  // something this codebase does.
  //
  // WHAT "REMOVE IT" MEANS NOW. src/lib/runtime.js still deliberately exports
  // no generic deleteSecret(key); provider code must not acquire an unmediated
  // destructive primitive. The product surface is the approval-gated
  // system.credential_remove tool, which calls the one lifecycle-manager
  // `remove` operation and records its bounded reason. These legacy keys stay
  // visible in the catalogue precisely so an owner can name either one there.
  discord_bot_token: definition('Discord bot token — no longer used; remove it'),
  discord_owner_channel_id: definition('Discord owner channel ID — no longer used; remove it'),
  github_pat: definition('GitHub personal access token'),
  tavily_api_key: definition('Tavily API key'),
  fal_api_key: definition('fal API key for Seedance video generation'),
  user_model_api_key: definition('Your model provider API key'),
  stripe_restricted_key: definition('Stripe restricted API key'),
  stripe_secret_key: definition('Stripe secret API key'),
  // BOTH ENVIRONMENTS ARE CATALOGUED, and the labels say which is which. The
  // vault has to be able to HOLD a live credential before an installation can
  // record that it is live -- a catalogue listing only the sandbox names made
  // going live impossible through every prompt in the product. Listing the live
  // names selects nothing: src/lib/paddle-environment.js decides which pair is
  // in force, and an unrecorded installation still resolves to sandbox.
  paddle_sandbox_api_key: definition('Paddle sandbox API key'),
  paddle_sandbox_webhook_secret: definition('Paddle sandbox webhook signing secret'),
  paddle_live_api_key: definition('Paddle live API key (real charges)'),
  paddle_live_webhook_secret: definition('Paddle live webhook signing secret (real charges)'),
  // The generic default vault target of gcloud.service_account_key_to_vault;
  // the key never leaves the vault after capture.
  gcp_service_account_key: definition('Google Cloud service-account JSON'),
  vercel_token: definition('Vercel token'),
  cloudflare_api_token: definition('Cloudflare API token'),
  cloudflare_account_id: definition('Cloudflare account ID')
});

// Keep doctor output compatible and focused on registered MCP providers.
const DIAGNOSTIC_CREDENTIAL_KEYS = Object.freeze([
  'ig_access_token', 'ig_user_id',
  'cws_access_token', 'cws_refresh_token', 'cws_client_id', 'cws_client_secret', 'cws_publisher_id',
  'google_access_token', 'google_refresh_token', 'google_client_id', 'google_client_secret',
  'github_pat',
  'tavily_api_key',
  'fal_api_key',
  'stripe_restricted_key', 'stripe_secret_key',
  // Both Paddle pairs are DIAGNOSED, deliberately. This list drives "what is in
  // the vault", not "what is required": src/lib/system-status.js filters it to
  // the keys actually present, so listing the live pair reports a live
  // credential that exists and stays silent about one that does not. Whether
  // the live pair is REQUIRED is a separate question, answered by the recorded
  // environment in src/lib/secret-store/requirements.js.
  'paddle_sandbox_api_key', 'paddle_sandbox_webhook_secret',
  'paddle_live_api_key', 'paddle_live_webhook_secret',
  'gcp_service_account_key',
  'vercel_token', 'cloudflare_api_token', 'cloudflare_account_id'
]);

const PROBE_REQUIRED_CREDENTIAL_KEYS = new Set(['ig_access_token', 'ig_user_id']);
const PROMPTABLE_CREDENTIAL_KEYS = Object.freeze(
  Object.keys(DEFINITIONS).filter(key => !PROBE_REQUIRED_CREDENTIAL_KEYS.has(key))
);
const GOOGLE_OAUTH_CREDENTIAL_KEYS = new Set([
  'google_access_token', 'google_refresh_token', 'google_client_id', 'google_client_secret'
]);

/* OWN PROPERTY, NOT ANY PROPERTY. DEFINITIONS is an ordinary object literal, so it
   inherits from Object.prototype and `DEFINITIONS['constructor']` is a truthy
   function. Read with a bare index, this answered a definition for `constructor`,
   `toString`, `hasOwnProperty`, `valueOf` and `__proto__` -- five names that are
   not credentials -- each shaped { key, label: undefined }.

   NOTHING IS EXPLOITABLE THROUGH IT TODAY, and that is the reason to fix it rather
   than a reason not to: every caller happens to validate further. captureCredential
   rejects it because `typeof definition.label !== 'string'`, and
   resolveCredentialRequest refuses these names outright. So the guarantee this
   function is supposed to provide -- "this name is a credential this product
   declares" -- is currently supplied by its callers instead. The first caller that
   trusts the return, which is what the return promises, gets a credential record
   with no name. */
function staticDefinition(key) {
  const item = Object.hasOwn(DEFINITIONS, key) ? DEFINITIONS[key] : undefined;
  return item ? { key, label: item.label } : null;
}

function credentialDefinitionForKey(key) {
  if (typeof key !== 'string') return null;
  const direct = staticDefinition(key);
  if (direct) return direct;

  // OAuth credentials can be namespaced to a registered Google account.  The
  // alias is constrained by google-accounts.js and is never used as prompt
  // prose, so a missing account field can still be captured when it is used.
  const match = /^(google_(?:access_token|refresh_token|client_id|client_secret))__([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(key);
  if (!match || !GOOGLE_ALIAS_RE.test(match[2])) return null;
  const base = staticDefinition(match[1]);
  return base ? { key, label: base.label } : null;
}

function customCredentialKey(name) {
  if (typeof name !== 'string' || !CUSTOM_NAME_RE.test(name)) {
    throw new Error('customName must use 1 through 80 letters, digits, underscores, or hyphens and begin with a letter or digit.');
  }
  return `custom.${name}`;
}

const FRIENDLY_ACRONYMS = Object.freeze({
  api: 'API',
  cws: 'CWS',
  gcp: 'GCP',
  id: 'ID',
  oauth: 'OAuth'
});

function customCredentialLabel(name) {
  return String(name).split(/[-_]+/).filter(Boolean).map(part => {
    const lower = part.toLowerCase();
    return FRIENDLY_ACRONYMS[lower] || `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
  }).join(' ');
}

function resolveCredentialRequest({ credential, customName, account } = {}) {
  if (credential === 'custom') {
    if (account !== undefined) throw new Error('account is not valid for a custom credential.');
    const key = customCredentialKey(customName);
    return { key, label: customCredentialLabel(customName) };
  }
  const direct = staticDefinition(credential);
  if (!direct) throw new Error('credential must identify a supported credential or custom.');
  if (PROBE_REQUIRED_CREDENTIAL_KEYS.has(credential)) {
    const error = new Error('Instagram credentials may be surfaced only by an attributed instagram.verify missing-secret operation.');
    error.code = 'CREDENTIAL_PROVIDER_PROBE_REQUIRED';
    throw error;
  }
  if (customName !== undefined) throw new Error('customName is valid only when credential is custom.');
  if (account === undefined) return direct;
  if (!GOOGLE_OAUTH_CREDENTIAL_KEYS.has(credential)) {
    throw new Error('account is valid only for Google OAuth credentials.');
  }
  if (typeof account !== 'string' || !GOOGLE_ALIAS_RE.test(account)) {
    throw new Error('account must be a valid Google account alias.');
  }
  return credentialDefinitionForKey(`${credential}__${account}`);
}

module.exports = {
  CUSTOM_NAME_RE,
  DEFINITIONS,
  DIAGNOSTIC_CREDENTIAL_KEYS,
  GOOGLE_ALIAS_RE,
  GOOGLE_OAUTH_CREDENTIAL_KEYS,
  PROBE_REQUIRED_CREDENTIAL_KEYS,
  PROMPTABLE_CREDENTIAL_KEYS,
  credentialDefinitionForKey,
  customCredentialKey,
  resolveCredentialRequest
};

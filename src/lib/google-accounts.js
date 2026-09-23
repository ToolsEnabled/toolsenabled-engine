'use strict';

// Multi-account registry for Google identities (Drive/Gmail/Calendar). Account
// aliases are USER DATA, exactly like config/machines.profile.json's machine
// topology (see src/lib/machine-profile.js): they map to emails and to
// namespaced vault keys so one OAuth client can hold a separate refresh token
// per account. The caller selects an account by alias or email; everything
// else resolves from here.
//
// The roster is per-installation and MUST NOT be committed: it holds one
// person's Google account aliases and emails.
// config/google-accounts.example.json is the shipped template (placeholders
// only); config/google-accounts.profile.json is the live, gitignored file,
// following the same convention as config/machines.profile.json. Absence is
// NORMAL: a fresh install has zero registered accounts until the owner runs
// tools/google-oauth-login.js, and every caller here must treat that as a
// legitimate, honestly-reported empty state -- never an error, never a silent
// empty result, and never a prompt.
//
// Vault key scheme per alias A:
//   google_access_token__A    google_refresh_token__A
//   google_client_id[__A]     google_client_secret[__A]   (per-alias overrides an
//                                                           optional shared client)

const { readJson, writeJsonAtomic, secretExists } = require('./runtime');
const { statePath } = require('./runtime-state-root');

// config contains shipped policy as well as this mutable account roster, so
// rootPath('config', ...) deliberately selects program files. Select the
// installation state explicitly for account data. In a source checkout the
// state root is the checkout; an installed or isolated profile has its own.
const CONFIG = () => statePath('config', 'google-accounts.profile.json');
const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) {
    throw new Error(`Invalid account alias '${alias}'. Use letters, digits, dot, underscore, hyphen.`);
  }
  return alias;
}

function load() {
  // readJson() returns the fallback on ENOENT (absence is normal) but THROWS
  // on a present-but-unparsable file. Propagate that failure: a corrupted
  // profile cannot honestly be reported as an empty account roster.
  const data = readJson(CONFIG(), {});
  const accounts = (data && typeof data.accounts === 'object' && data.accounts) || {};
  /* A CONFIGURED DEFAULT IS ONLY A DEFAULT IF IT IS STILL REGISTERED. This chose
     the configured value on TRUTHINESS, so a profile naming an account that has
     since been removed -- or carrying a stale whitespace string -- returned that
     name, and resolve() handed it to the caller as the account to use. Downstream
     that is a lookup into `accounts` that yields undefined, on a path whose own
     comment records these exact callers: gmail.list, calendar.list and drive.find.
     Falling through to a registered account is right, and having NO account at all
     is right too, because that produces GOOGLE_ACCOUNT_NOT_CONFIGURED -- a
     sentence that tells somebody what to run. Naming an account that is not there
     produces neither. */
  const configuredDefault = data && typeof data.defaultAccount === 'string' ? data.defaultAccount.trim() : '';
  const defaultAccount = (configuredDefault && Object.prototype.hasOwnProperty.call(accounts, configuredDefault)
    ? configuredDefault
    : Object.keys(accounts)[0]) || null;
  // A Store publisher ID is captured later into the vault.  It is not a
  // Google-login alias.  In particular, legacy cwsPublisherAccount is
  // deliberately ignored rather than migrated or used as a fallback.
  const cwsLoginAccount = data && Object.prototype.hasOwnProperty.call(data, 'cwsLoginAccount')
    ? data.cwsLoginAccount : null;
  // Duo/UCR sign-in identity, same shape as cwsLoginAccount: an institutional
  // SSO account is a distinct role from the default personal account and is
  // never inferred from it.
  const duoAccount = data && Object.prototype.hasOwnProperty.call(data, 'duoAccount')
    ? data.duoAccount : null;
  // Which registered account backs each Gemini consumption lane.  Same
  // configuration-only shape as cwsLoginAccount/duoAccount: never inferred
  // from the default account, and absent means "this installation has no such
  // lane", not "guess one".  These live here rather than being read out of
  // the Vertex provider modules because which account pays for a Vertex seat
  // or an API-credit pool is account configuration, not provider mechanics --
  // and because the dashboard needs the answer without importing a provider.
  const vertexSeatAccount = data && Object.prototype.hasOwnProperty.call(data, 'vertexSeatAccount')
    ? data.vertexSeatAccount : null;
  const vertexApiAccount = data && Object.prototype.hasOwnProperty.call(data, 'vertexApiAccount')
    ? data.vertexApiAccount : null;
  return { defaultAccount, cwsLoginAccount, duoAccount, vertexSeatAccount, vertexApiAccount, accounts };
}

// CWS login identity is deliberately configuration-only: callers cannot
// substitute an alias or email through a tool input, and a missing/malformed
// explicit selection never falls back to the normal Google default.  It may
// intentionally be the default account; the CWS publisher ID is a distinct
// vault value and must never be inferred from this alias.
function validateCwsLoginConfig({ accounts, cwsLoginAccount }) {
  if (typeof cwsLoginAccount !== 'string' || cwsLoginAccount.trim() !== cwsLoginAccount) {
    throw new Error('The Chrome Web Store login account is not explicitly configured.');
  }
  assertAlias(cwsLoginAccount);
  const details = accounts[cwsLoginAccount];
  if (!details || typeof details !== 'object' || typeof details.email !== 'string' || !EMAIL_RE.test(details.email)) {
    throw new Error('The configured Chrome Web Store login account is not registered with a valid email.');
  }
  return Object.freeze({ alias: cwsLoginAccount, email: details.email });
}

function cwsLoginAccount() { return validateCwsLoginConfig(load()); }

// Duo/UCR sign-in identity: same "configuration-only, never inferred" shape
// as validateCwsLoginConfig above, for the same reasons -- an institutional
// SSO account is not interchangeable with the default personal account.
function validateDuoAccountConfig({ accounts, duoAccount }) {
  if (typeof duoAccount !== 'string' || duoAccount.trim() !== duoAccount) {
    throw new Error('The Duo sign-in account is not explicitly configured.');
  }
  assertAlias(duoAccount);
  const details = accounts[duoAccount];
  if (!details || typeof details !== 'object' || typeof details.email !== 'string' || !EMAIL_RE.test(details.email)) {
    throw new Error('The configured Duo sign-in account is not registered with a valid email.');
  }
  return Object.freeze({ alias: duoAccount, email: details.email });
}

function duoAccount() { return validateDuoAccountConfig(load()); }

function list() {
  const { accounts, defaultAccount } = load();
  return Object.entries(accounts).map(([alias, meta]) => ({
    alias, email: (meta && meta.email) || '', label: (meta && meta.label) || '',
    isDefault: alias === defaultAccount,
    authorized: secretExists(`google_refresh_token__${alias}`)
  }));
}

// Resolve a selector (alias, email, or undefined -> default) to a known alias.
function resolve(selector) {
  const { accounts, defaultAccount } = load();
  if (selector === undefined || selector === null || selector === '') {
    if (!defaultAccount) {
      // The same code cli-provider-gateway.js already uses for this exact
      // condition, so "no Google account is set up here" is one code
      // everywhere it can be said. Measured on the 2026-08-19 sweep: this
      // sentence reached gmail.list, calendar.list and drive.find agents with
      // no machine code at all.
      const error = new Error('No Google accounts are registered. Run: node tools/google-oauth-login.js --account <alias> --email <email>');
      error.code = 'GOOGLE_ACCOUNT_NOT_CONFIGURED';
      throw error;
    }
    return defaultAccount;
  }
  const s = String(selector).trim();
  if (accounts[s]) return s;
  const lower = s.toLowerCase();
  const byEmail = Object.keys(accounts).find(a => (accounts[a].email || '').toLowerCase() === lower);
  if (byEmail) return byEmail;
  const byAliasCi = Object.keys(accounts).find(a => a.toLowerCase() === lower);
  if (byAliasCi) return byAliasCi;
  const unknown = new Error(`Unknown Google account '${selector}'. Known: ${Object.keys(accounts).join(', ') || '(none)'}`);
  unknown.code = 'GOOGLE_ACCOUNT_NOT_FOUND';
  throw unknown;
}

function register(alias, email, { label, makeDefault = false } = {}) {
  assertAlias(alias);
  if (typeof email !== 'string' || !email.includes('@')) throw new Error('A valid email is required to register an account.');
  const data = readJson(CONFIG(), {});
  if (!data.accounts || typeof data.accounts !== 'object') data.accounts = {};
  const prior = data.accounts[alias] || {};
  data.accounts[alias] = { email, label: label || prior.label || '' };
  if (makeDefault || !data.defaultAccount) data.defaultAccount = alias;
  writeJsonAtomic(CONFIG(), data);
  return load();
}

// Vault key set for an account, with shared-client fallback.
function oauthKeysFor(selector) {
  const alias = resolve(selector);
  const perId = `google_client_id__${alias}`;
  const perSecret = `google_client_secret__${alias}`;
  return {
    account: alias,
    accessKey: `google_access_token__${alias}`,
    refreshKey: `google_refresh_token__${alias}`,
    clientIdKey: secretExists(perId) ? perId : 'google_client_id',
    clientSecretKey: secretExists(perSecret) ? perSecret : 'google_client_secret'
  };
}

module.exports = {
  load, list, resolve, register, oauthKeysFor, assertAlias,
  cwsLoginAccount, validateCwsLoginConfig, duoAccount, validateDuoAccountConfig
};

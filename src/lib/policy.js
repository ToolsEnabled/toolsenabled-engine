const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { rootPath, readJson } = require('./runtime');

const APPROVAL_ACTION = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
const STANDING_AUTHORIZATION_ID = /^[a-z0-9][a-z0-9._-]{2,119}$/;
const STANDING_AUTHORIZATION_ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const STANDING_AUTHORIZATION_FORBIDDEN_ACTIONS = new Set([
  'browser.stop', 'window.close', 'chrome_web_store.publish'
]);

// UNAVAILABLE is not the same as EMPTY, and the difference is a security default.
//
// loadPolicy used to fall back to a bare `{}` when the policy file was MISSING --
// indistinguishable from a policy that is present and simply declares nothing.
// requiresApproval() reads `approvals.enabled !== true` as "no approval required", so
// a deleted policy silently disabled the approval gate for every non-external tool.
// The mode check in assertActive does fail closed, but it runs only for `external-*`
// effects, so it never covered that path.
//
// PRECISELY MISSING, and not "unreadable or corrupt" -- an earlier version of this
// comment said the latter and was wrong. readJson (src/lib/runtime.js:20-25) returns
// its fallback ONLY on ENOENT and rethrows everything else, so a corrupt or
// permission-denied policy has always failed closed by throwing, and still does. The
// security property holds across all three states but by TWO different mechanisms,
// and only the deletion case runs through this marker. Stated exactly because a future
// maintainer who believes the marker covers corruption will reason from a false map.
//
// The reachable case is the sharpest possible illustration: `browser.stop` is
// declared `effect: 'local-write'` with `approvalEligible: true`, and it is one of
// the three actions in STANDING_AUTHORIZATION_FORBIDDEN_ACTIONS above -- deliberately
// singled out as too sensitive to EVER run under a standing authorization, i.e. it
// must take a fresh approval every single time. With no policy file it took none.
// The one action marked un-delegatable was the one that became ungated.
//
// This sentinel lets callers tell the two states apart. It is deliberately a plain
// data marker rather than a thrown error: loadPolicy has many callers that read
// unrelated fields (killSwitchPath, mode checks) and must keep working on a degraded
// policy. Only the decisions that GRANT something consult it.
const POLICY_UNAVAILABLE = Symbol.for('toolsenabled.policy.unavailable');

function loadPolicy() {
  const fallback = { [POLICY_UNAVAILABLE]: true };
  return readJson(rootPath('config', 'toolsenabled.policy.json'), fallback);
}

function policyUnavailable(policy) {
  return Boolean(policy && policy[POLICY_UNAVAILABLE]);
}

function killSwitchPath(policy = loadPolicy(), environment = process.env) {
  const configured = typeof environment.TOOLSENABLED_KILLSWITCH_PATH === 'string'
    ? environment.TOOLSENABLED_KILLSWITCH_PATH.trim() : '';
  return configured ? path.resolve(configured) : rootPath(policy.killswitchFile || 'KILLSWITCH');
}

function killSwitchActive(killFile) {
  // Unlike existsSync(), statSync() does not collapse an unreadable path into
  // "absent". Only a definite ENOENT becomes undefined; permission and I/O
  // failures propagate so outward work is refused rather than silently enabled.
  return fs.statSync(killFile, { throwIfNoEntry: false }) !== undefined;
}

function assertActive(action, options = {}) {
  const policy = loadPolicy();
  const killFile = killSwitchPath(policy);
  if (options.outward !== false && killSwitchActive(killFile)) {
    const error = new Error(`KILLSWITCH is active. '${action}' was not executed.`);
    error.code = 'KILLSWITCH_ACTIVE';
    throw error;
  }
  if (policy.mode !== 'autonomous') {
    throw new Error(`ToolsEnabled policy mode is '${policy.mode}', not autonomous.`);
  }
  const providerByAction = {
    instagram: 'instagram', firebase: 'firebase', gcloud: 'googleCloud', terraform: 'googleCloud', chromeWebStore: 'chromeWebStore', extension: 'extension',
    gmail: 'google', calendar: 'google', drive: 'google', github: 'github',
    vercel: 'vercel', cloudflare: 'cloudflare', stripe: 'stripe'
  };
  const provider = options.provider || providerByAction[String(action).split('.')[0]];
  assertProviderEnabled(provider, action, policy);
  return policy;
}

function assertProviderEnabled(provider, action = 'operation', policy = loadPolicy()) {
  if (provider) {
    const configured = policy.providers && policy.providers[provider];
    if (!configured || configured.enabled !== true) {
      throw new Error(`Provider '${provider}' is not explicitly enabled by local policy; '${action}' was not executed.`);
    }
  }
  return policy;
}

function approvalTimeoutSeconds(policy = loadPolicy()) {
  const value = policy && policy.approvals && policy.approvals.timeoutSeconds;
  return Number.isSafeInteger(value) && value >= 5 && value <= 900 ? value : 60;
}

/* Optional tool confirmations follow a readable resolved setting. Basic ships
 * without these prompts; explicit user/installer choices still win. Missing,
 * rejected or unreadable settings are uncertainty, not a permission grant.
 * Permission tiers, reserved actions and the kill switch are enforced separately. */
const APPROVAL_SETTING_ID = 'agent.tool_approvals';
const CHOOSING_PROVENANCE = new Set(['default', 'user', 'installer']);

function approvalsTurnedOffByOwner(loadSettingsImpl) {
  let settings;
  try {
    const loader = loadSettingsImpl || require('./settings').loadSettings;
    settings = loader();
  } catch {
    // Unreadable settings must not grant. Keep whatever the policy file decides.
    return false;
  }
  if (Array.isArray(settings?.rejected) && settings.rejected.some(row => row.id === '*' || row.id === APPROVAL_SETTING_ID)) return false;
  const values = settings && settings.values;
  if (!values || !Object.prototype.hasOwnProperty.call(values, APPROVAL_SETTING_ID)) return false;
  if (values[APPROVAL_SETTING_ID] !== false) return false;
  const recorded = settings.provenance ? settings.provenance[APPROVAL_SETTING_ID] : null;
  const source = recorded && typeof recorded.source === 'string' ? recorded.source : null;
  return CHOOSING_PROVENANCE.has(source) && (source !== 'default' || Array.isArray(settings.rejected));
}

function requiresApproval(action, effect, policy = loadPolicy(), { loadSettings: loadSettingsImpl } = {}) {
  // FAIL CLOSED on an unreadable policy. Returning false here is a decision to GRANT
  // -- it says "no approval needed" -- and a grant must never be the consequence of a
  // missing file. Erring this way can only ever add an approval prompt; erring the
  // other way silently removed the gate on every approvalEligible non-external tool.
  if (policyUnavailable(policy)) return true;
  // The resolved Basic default or saved answer, after the policy proved readable.
  if (approvalsTurnedOffByOwner(loadSettingsImpl)) return false;
  const approvals = policy && policy.approvals;
  if (!approvals || approvals.enabled !== true) return false;
  const listed = Array.isArray(approvals.actions) ? approvals.actions : [];
  // An explicit required-action rule always wins over the narrowly scoped
  // browser-launch exception below.
  if (listed.includes(action)) return true;
  if (action === 'browser.start' && approvals.autoApproveBrowserStart === true) return false;
  /* THE SAME NARROW SHAPE AS THE BROWSER EXCEPTION ABOVE, AND FOR THE SAME
   * REASON: one named action, opt-in, and beaten by an explicit required-action
   * rule (the `listed.includes` check runs first and always wins).
   *
   * Why this one earned an exception. The owner drives Codex Cloud in waves --
   * dozens of launches in a sitting -- and every one is `external-write`, so
   * every one raised a sixty-second dialog. His instruction, 2026-08-27: "MY
   * SETTINGS SHOULD BE LEVEL 0 NO ASKING FROM ME FOR ANYTHING JUST DO IT."
   * Standing authorizations cannot serve this: they match arguments with
   * isDeepStrictEqual, so a grant covers exactly one prompt string and nothing
   * else. The alternative was `externalWrites: false` or `enabled: false`, and
   * both are far wider than what he asked for.
   *
   * WHAT THIS DOES NOT TOUCH, and the distinction is the point. It exempts ONE
   * action, cloud.task_launch, which spends the owner's Codex allowance -- a
   * budget he has said is lost if unused. Every other external write still
   * prompts, including anything that reaches a card, an account, or a payment
   * processor. His standing reservation that any spend of his money needs his
   * word line by line is untouched, because this is not that money and not that
   * path.
   *
   * Default is off. A policy that does not set it keeps the prompt. */
  if (action === 'cloud.task_launch' && approvals.autoApproveCloudLaunch === true) return false;
  return approvals.externalWrites === true && effect === 'external-write';
}

function standingAuthorizationError(message) {
  const error = new Error(message);
  error.code = 'STANDING_AUTHORIZATION_POLICY_INVALID';
  return error;
}

function standingAuthorizationForbidden(action, metadata = {}) {
  if (STANDING_AUTHORIZATION_FORBIDDEN_ACTIONS.has(action)) return true;
  if (typeof action !== 'string') return true;
  // A standing mission grant must never reach a cancellation, charge/trial,
  // teardown, or an action the registry classifies as destructive.  The
  // registry passes its hints below, so this remains true as tools evolve.
  if (/(?:^|[._-])(cancel|teardown|destroy|delete|remove|revoke|rollback|close|stop)(?:$|[._-])/.test(action)) return true;
  if (/^(?:billing|stripe|pay)\./.test(action)) return true;
  return metadata.effect === 'local-write' || metadata.destructiveHint === true;
}

function copyExactValue(value, label, depth = 0) {
  if (depth > 12) throw standingAuthorizationError(`${label} is nested too deeply.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw standingAuthorizationError(`${label} must be JSON-compatible.`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 8192) throw standingAuthorizationError(`${label} is too long.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw standingAuthorizationError(`${label} has too many values.`);
    return Object.freeze(value.map((item, index) => copyExactValue(item, `${label}[${index}]`, depth + 1)));
  }
  if (!plainObject(value)) throw standingAuthorizationError(`${label} must be a JSON-compatible exact value.`);
  const keys = Object.keys(value);
  if (keys.length > 100) throw standingAuthorizationError(`${label} has too many properties.`);
  const copied = {};
  for (const key of keys) {
    // Only the root keys name tool parameters. Nested objects contain exact
    // argument data, including ordinary HTTP headers such as content-type.
    // Keep the existing depth/count/string bounds and prototype-key refusal.
    if ((depth === 0 && !STANDING_AUTHORIZATION_ARGUMENT_NAME.test(key))
      || key.length > 8192 || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw standingAuthorizationError(`${label} has an unsupported property '${key}'.`);
    }
    Object.defineProperty(copied, key, {
      value: copyExactValue(value[key], `${label}.${key}`, depth + 1), enumerable: true, writable: false, configurable: false
    });
  }
  return Object.freeze(copied);
}

// Durable standing authorizations are intentionally a small policy language:
// each record names one mission, one exact action, and one closed map of exact
// arguments.  There are no wildcards, optional values, or partial matches.
function standingAuthorizationConfiguration(policy = loadPolicy()) {
  const approvals = policy && policy.approvals;
  const configured = approvals && approvals.standingAuthorizations;
  if (configured === undefined) return Object.freeze([]);
  if (!Array.isArray(configured) || configured.length > 50) {
    throw standingAuthorizationError('approvals.standingAuthorizations must be an array of at most 50 records.');
  }
  const ids = new Set();
  const grants = configured.map((raw, index) => {
    const label = `approvals.standingAuthorizations[${index}]`;
    if (!plainObject(raw)) throw standingAuthorizationError(`${label} must be an object.`);
    const keys = Object.keys(raw);
    if (keys.some(key => !['id', 'mission', 'action', 'arguments'].includes(key)) || keys.length !== 4) {
      throw standingAuthorizationError(`${label} must contain only id, mission, action, and arguments.`);
    }
    if (typeof raw.id !== 'string' || !STANDING_AUTHORIZATION_ID.test(raw.id)) {
      throw standingAuthorizationError(`${label}.id must be a stable lowercase identifier.`);
    }
    if (ids.has(raw.id)) throw standingAuthorizationError(`${label}.id must be unique.`);
    ids.add(raw.id);
    if (typeof raw.mission !== 'string' || !STANDING_AUTHORIZATION_ID.test(raw.mission)) {
      throw standingAuthorizationError(`${label}.mission must be a stable lowercase identifier.`);
    }
    if (typeof raw.action !== 'string' || !APPROVAL_ACTION.test(raw.action)) {
      throw standingAuthorizationError(`${label}.action must name one exact tool action.`);
    }
    if (standingAuthorizationForbidden(raw.action)) {
      throw standingAuthorizationError(`${label}.action is never eligible for standing authorization.`);
    }
    if (!plainObject(raw.arguments)) throw standingAuthorizationError(`${label}.arguments must be a closed object.`);
    return Object.freeze({
      id: raw.id,
      mission: raw.mission,
      action: raw.action,
      arguments: copyExactValue(raw.arguments, `${label}.arguments`)
    });
  });
  return Object.freeze(grants);
}

function standingAuthorizationFor(action, argumentsValue, policy = loadPolicy(), metadata = {}) {
  if (!plainObject(argumentsValue) || standingAuthorizationForbidden(action, metadata)) return null;
  return standingAuthorizationConfiguration(policy).find(grant => (
    grant.action === action && isDeepStrictEqual(grant.arguments, argumentsValue)
  )) || null;
}

function allowsScheduledActions(policy = loadPolicy()) {
  const approvals = policy && policy.approvals;
  return Boolean(approvals && approvals.enabled === true && approvals.allowScheduledActions === true);
}

function localInferenceConfiguration(policy = loadPolicy()) {
  const localInference = policy && policy.localInference;
  if (!plainObject(localInference)) {
    throw new Error('localInference policy must be an object.');
  }
  for (const key of Object.keys(localInference)) {
    if (!['hermesAdvisoryEnabled', 'strongAdvisoryEnabled'].includes(key)) {
      throw new Error(`localInference policy has an unsupported property '${key}'.`);
    }
  }
  if (typeof localInference.hermesAdvisoryEnabled !== 'boolean') {
    throw new Error('localInference.hermesAdvisoryEnabled must be a boolean.');
  }
  if (typeof localInference.strongAdvisoryEnabled !== 'boolean') {
    throw new Error('localInference.strongAdvisoryEnabled must be a boolean.');
  }
  return {
    hermesAdvisoryEnabled: localInference.hermesAdvisoryEnabled,
    strongAdvisoryEnabled: localInference.strongAdvisoryEnabled
  };
}

function assertHermesAdvisoryAllowed(policy = loadPolicy()) {
  if (localInferenceConfiguration(policy).hermesAdvisoryEnabled !== true) {
    throw new Error('Local Hermes advisory inference is disabled by policy.');
  }
}

function assertStrongAdvisoryAllowed(policy = loadPolicy()) {
  if (localInferenceConfiguration(policy).strongAdvisoryEnabled !== true) {
    throw new Error('Strong local advisory inference is disabled by policy.');
  }
}

function overnightAdvisoryConfiguration(policy = loadPolicy()) {
  const configured = policy && policy.overnightAdvisory;
  if (!plainObject(configured)) throw new Error('overnightAdvisory policy must be an object.');
  for (const key of Object.keys(configured)) {
    if (key !== 'enabled') throw new Error(`overnightAdvisory policy has an unsupported property '${key}'.`);
  }
  if (typeof configured.enabled !== 'boolean') throw new Error('overnightAdvisory.enabled must be a boolean.');
  return { enabled: configured.enabled };
}

function assertOvernightAdvisoryAllowed(policy = loadPolicy()) {
  if (overnightAdvisoryConfiguration(policy).enabled !== true) {
    throw new Error('Overnight local advisory work is disabled by policy.');
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function policyError(message) {
  const error = new Error(message);
  error.code = 'HTTP_POLICY_INVALID';
  return error;
}

function httpHost(value, label) {
  if (typeof value !== 'string' || !value || value.length > 253) throw policyError(`${label} must be a host suffix string.`);
  const host = value.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..') || !host.includes('.')) {
    throw policyError(`${label} must be a normalized DNS host suffix.`);
  }
  return host;
}

function httpHostList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw policyError(`${label} must be an array of at most 100 host suffixes.`);
  const hosts = value.map((item, index) => httpHost(item, `${label}[${index}]`));
  if (new Set(hosts).size !== hosts.length) throw policyError(`${label} must not contain duplicate host suffixes.`);
  return hosts;
}

function httpAuthStyle(value, label) {
  if (value === 'bearer') return value;
  if (typeof value !== 'string' || value.length > 160) throw policyError(`${label} must be bearer, header:<name>, or query:<param>.`);
  const match = /^(header|query):(.+)$/.exec(value);
  if (!match) throw policyError(`${label} must be bearer, header:<name>, or query:<param>.`);
  if (match[1] === 'header' && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(match[2])) {
    throw policyError(`${label} has an invalid header name.`);
  }
  if (match[1] === 'query' && !/^[A-Za-z0-9_.~-]{1,100}$/.test(match[2])) {
    throw policyError(`${label} has an invalid query parameter name.`);
  }
  return value;
}

function httpConfiguration(policy = loadPolicy()) {
  const configured = policy && policy.http;
  if (configured === undefined) return { allowedHosts: [], vaultKeys: {} };
  if (!plainObject(configured)) throw policyError('http policy must be an object.');
  for (const key of Object.keys(configured)) {
    if (!['allowedHosts', 'vaultKeys'].includes(key)) throw policyError(`http policy has an unsupported property '${key}'.`);
  }
  const allowedHosts = httpHostList(configured.allowedHosts, 'http.allowedHosts');
  const rawVaultKeys = configured.vaultKeys === undefined ? {} : configured.vaultKeys;
  if (!plainObject(rawVaultKeys) || Object.keys(rawVaultKeys).length > 100) {
    throw policyError('http.vaultKeys must be an object with at most 100 entries.');
  }
  const vaultKeys = {};
  for (const [vaultKey, binding] of Object.entries(rawVaultKeys)) {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(vaultKey)) throw policyError(`http.vaultKeys has an invalid vault key '${vaultKey}'.`);
    if (!plainObject(binding)) throw policyError(`http.vaultKeys.${vaultKey} must be an object.`);
    for (const key of Object.keys(binding)) {
      if (!['hosts', 'authStyle'].includes(key)) throw policyError(`http.vaultKeys.${vaultKey} has an unsupported property '${key}'.`);
    }
    const hosts = httpHostList(binding.hosts, `http.vaultKeys.${vaultKey}.hosts`);
    if (!hosts.length) throw policyError(`http.vaultKeys.${vaultKey}.hosts must not be empty.`);
    vaultKeys[vaultKey] = { hosts, authStyle: httpAuthStyle(binding.authStyle, `http.vaultKeys.${vaultKey}.authStyle`) };
  }
  return { allowedHosts, vaultKeys };
}

function httpHostAllowed(host, allowedHosts) {
  if (typeof host !== 'string' || !Array.isArray(allowedHosts)) return false;
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some(suffix => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function assertHttps(url, label = 'URL') {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`${label} must be a valid URL.`); }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  return parsed;
}

module.exports = {
  allowsScheduledActions, approvalTimeoutSeconds, assertActive, assertHermesAdvisoryAllowed, assertHttps, assertOvernightAdvisoryAllowed, assertProviderEnabled,
  assertStrongAdvisoryAllowed, httpConfiguration, httpHostAllowed, killSwitchPath, loadPolicy,
  localInferenceConfiguration, overnightAdvisoryConfiguration, requiresApproval,
  standingAuthorizationConfiguration, standingAuthorizationFor, standingAuthorizationForbidden
};

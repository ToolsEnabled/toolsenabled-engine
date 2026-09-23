'use strict';

// WHICH CODEX CLOUD ENVIRONMENTS IS THIS INSTALLATION AUTHORIZED TO USE, AND
// WHAT REPOSITORY IS EACH ONE BOUND TO.
//
// THE GAP THIS CLOSES. `codex cloud exec` cannot run without `--env <ENV_ID>`,
// until this module nothing in this product could produce that id without a
// human reading it off a web page: codex-cli 0.146.0 has no environment
// subcommand (measured: `codex cloud --help` lists exec/status/list/apply/diff
// only), and `codex cloud list --json` reports every task with
// `environment_id: null` and only a display `environment_label` (measured
// against a live signed-in account, not inferred from documentation). A product
// feature whose one required argument can only be obtained by hand is not a
// product feature: the CLI exposes no noninteractive environment discovery at
// all.
//
// WHAT IS USED INSTEAD, AND WHY IT IS NOT SCRAPING. The provider serves the
// environment list the Codex CLI's own browser uses, as JSON, over the same
// authenticated session the CLI already holds. This module performs ONE bounded
// GET against that documented-shape surface per account and parses the fields it
// needs. Nothing is rendered, no page is driven, and no markup is parsed --
// that distinction is the whole reason this is not scraping.
//
// CREDENTIAL DISCIPLINE, WHICH IS THE WHOLE RISK HERE. The account's local Codex
// sign-in is read to authorize the call. That value:
//   - is read from the account's OWN Codex home (the same CODEX_HOME the
//     launcher pins), never from the ambient one, so discovery answers for the
//     account it says it answered for;
//   - is sent to the provider host and nowhere else -- the URL is a constant in
//     this file, redirects are refused rather than followed, and there is no
//     caller-supplied URL anywhere in this module;
//   - is never returned, never logged, never placed in an error, and never
//     written to disk by this module.
// Everything this module reports about an account is its NAME and what the
// provider said about its environments.
//
// FAIL CLOSED, IN THE THREE PLACES ABSENCE HAS BEEN READ AS CONSENT HERE BEFORE:
//   1. An account that could not be asked is `unknown`, never "has no
//      environments". The merged result carries `complete: false` so a caller
//      cannot render an incomplete list as the whole truth.
//   2. An environment whose repository binding cannot be determined -- absent,
//      unparseable, or ambiguous because the environment carries more than one
//      repository -- is returned with `repository: null` and
//      `launchable: false`. It is never defaulted to the first repository found.
//   3. A default branch that the provider did not state stays null. It is never
//      defaulted to "main"; a caller that needs a branch must obtain a real one.

const fs = require('node:fs');
const path = require('node:path');

const { resolveProfileDir } = require('../multi-account/registry.js');

// The provider surface. A constant, deliberately: this is the one host the
// account's sign-in may be sent to, so it is not configurable by a caller and
// not assembled from anything a caller supplies. It is the same origin the task
// URLs in codex-cloud-launch.js are built from.
const PROVIDER_ORIGIN = 'https://chatgpt.com';
const ENVIRONMENTS_PATH = '/backend-api/wham/environments';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ENVIRONMENT_ID = /^[0-9a-f]{32}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

// Reported instead of an exception, because one unreadable account must not
// delete the other accounts' answers.
const READING = Object.freeze({
  AUTHORIZED: 'authorized',
  SIGNED_OUT: 'signed-out',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown'
});

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/* The account's local sign-in, read from ITS OWN home.
 *
 * Returns the token in a closure-free plain object that the callers below pass
 * straight into one request and then drop. It is never part of any value this
 * module returns. A missing file is "this account is signed out", which is a
 * reportable state. An unreadable or malformed file is unknown: neither
 * failure establishes that the account is signed out. */
function readAccountSession(account, { homeDir, fsImpl = fs } = {}) {
  let profileDir;
  try { profileDir = resolveProfileDir(account, { homeDir }); }
  catch { return { ok: false, reading: READING.UNKNOWN, reason: 'This account has no resolvable Codex home, so it could not be asked.' }; }
  let raw;
  try { raw = fsImpl.readFileSync(path.join(profileDir, 'auth.json'), 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, reading: READING.SIGNED_OUT, reason: 'This account has no signed-in Codex home, so it can list no environments.' };
    }
    return { ok: false, reading: READING.UNKNOWN, reason: 'This account\'s Codex sign-in could not be read, so its environments are unknown.' };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, reading: READING.UNKNOWN, reason: 'This account\'s Codex sign-in could not be parsed, so its environments are unknown.' }; }
  const tokens = plainObject(parsed) && plainObject(parsed.tokens) ? parsed.tokens : null;
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) {
    return { ok: false, reading: READING.SIGNED_OUT, reason: 'This account\'s Codex sign-in is not usable, so it can list no environments.' };
  }
  return {
    ok: true,
    accessToken: tokens.access_token,
    accountId: typeof tokens.account_id === 'string' ? tokens.account_id : ''
  };
}

/* Read a response body under a hard byte cap. An oversized body is refused
   rather than truncated: a truncated JSON document parses as nothing useful and
   a silently truncated one would parse as a SHORTER environment list, which is
   the failure this file's third fail-closed rule is about. */
async function readBounded(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return { ok: false };
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES ? { ok: false } : { ok: true, text };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* the cap is the outcome */ }
      return { ok: false };
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return { ok: true, text };
}

/* One environment, reduced to what a launch and a receipt actually need.
 *
 * `repository` is the load-bearing field: it is the declared-binding half of
 * "never submit work into an unrelated environment". It is populated ONLY when
 * the environment names exactly one repository. An environment carrying two
 * would make "the repository this task lands in" a guess, and a guess is the
 * thing a binding exists to remove -- so it comes back null with a reason and
 * `launchable: false`. */
function normalizeEnvironment(raw) {
  if (!plainObject(raw)) return null;
  const environmentId = boundedString(raw.id, 64);
  if (!environmentId || !ENVIRONMENT_ID.test(environmentId)) return null;

  const repoMap = plainObject(raw.repo_map) ? raw.repo_map : null;
  const entries = repoMap
    ? Object.values(repoMap).filter(plainObject).map(entry => ({
      repository: boundedString(entry.repository_full_name, 220),
      defaultBranch: boundedString(entry.default_branch, 200),
      visibility: boundedString(entry.visibility, 40)
    })).filter(entry => entry.repository !== null && REPOSITORY.test(entry.repository))
    : [];

  let repository = null;
  let defaultBranch = null;
  let visibility = null;
  let reason = null;
  if (entries.length === 1) {
    repository = entries[0].repository;
    defaultBranch = entries[0].defaultBranch !== null && BRANCH.test(entries[0].defaultBranch) && !entries[0].defaultBranch.includes('..')
      ? entries[0].defaultBranch
      : null;
    visibility = entries[0].visibility;
    if (defaultBranch === null) {
      reason = 'The provider did not state a default branch for this environment, so a branch must be given explicitly.';
    }
  } else if (entries.length > 1) {
    reason = `This environment is bound to ${entries.length} repositories, so which one a task would land in cannot be established here.`;
  } else {
    reason = 'This environment names no readable repository, so a task cannot be bound to a source repository.';
  }

  return Object.freeze({
    environmentId,
    label: boundedString(raw.label, 256),
    repository,
    repositories: Object.freeze(entries.map(entry => entry.repository)),
    defaultBranch,
    visibility,
    // A launch is offered only for an environment whose repository binding is
    // established. Everything else is shown and refused, never hidden: a person
    // who cannot see the environment cannot fix its binding.
    launchable: repository !== null,
    reason
  });
}

/**
 * The environments ONE account is authorized for.
 *
 * Never throws for a provider-side or account-side condition: every such
 * outcome is a `reading` value with a reason a person can act on. It throws
 * only for a programming error (no account given).
 */
async function listEnvironmentsForAccount(account, {
  homeDir = process.env.USERPROFILE || process.env.HOME || '',
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!plainObject(account) || typeof account.name !== 'string') {
    throw new TypeError('listEnvironmentsForAccount requires an account entry.');
  }
  const base = { account: account.name, role: typeof account.role === 'string' ? account.role : null };
  const session = readAccountSession(account, { homeDir, fsImpl });
  if (!session.ok) {
    return Object.freeze({ ...base, reading: session.reading, reason: session.reason, environments: Object.freeze([]) });
  }
  if (typeof fetchImpl !== 'function') {
    return Object.freeze({
      ...base,
      reading: READING.UNKNOWN,
      reason: 'This runtime has no HTTP client, so the authorized environments could not be read.',
      environments: Object.freeze([])
    });
  }

  let response;
  try {
    response = await fetchImpl(`${PROVIDER_ORIGIN}${ENVIRONMENTS_PATH}`, {
      method: 'GET',
      headers: {
        // The account's own sign-in, to the provider that issued it. Nothing
        // else in this request identifies the machine or the user.
        authorization: `Bearer ${session.accessToken}`,
        ...(session.accountId ? { 'chatgpt-account-id': session.accountId } : {}),
        accept: 'application/json'
      },
      // A redirect is refused rather than followed: following one would hand
      // this account's bearer to whatever host the redirect names.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return Object.freeze({
      ...base,
      reading: READING.UNKNOWN,
      // The message is the transport's own; it carries no credential because
      // none was placed in the URL.
      reason: `The authorized environments could not be read (${boundedString(error && error.name, 60) || 'request failed'}).`,
      environments: Object.freeze([])
    });
  }

  if (response.status === 401 || response.status === 403) {
    return Object.freeze({
      ...base,
      reading: READING.REJECTED,
      reason: 'The provider refused this account\'s stored sign-in. Sign this account in again, then read the environments once more.',
      environments: Object.freeze([])
    });
  }
  if (!response.ok) {
    return Object.freeze({
      ...base,
      reading: READING.UNKNOWN,
      reason: `The provider answered ${response.status} when asked for this account's environments, so its list is unknown.`,
      environments: Object.freeze([])
    });
  }

  let body;
  try {
    body = await readBounded(response);
  } catch {
    return Object.freeze({
      ...base,
      reading: READING.UNKNOWN,
      reason: 'The provider\'s environment list could not be read, so it is reported unknown rather than empty.',
      environments: Object.freeze([])
    });
  }
  if (!body.ok) {
    return Object.freeze({
      ...base,
      reading: READING.UNKNOWN,
      reason: 'The provider\'s environment list was larger than this reader accepts, so it was refused rather than truncated.',
      environments: Object.freeze([])
    });
  }
  let parsed = null;
  try { parsed = JSON.parse(body.text); } catch { parsed = null; }
  // An envelope this reader does not recognise is UNKNOWN, never an empty list:
  // "the shape changed" and "you have no environments" send a person to two
  // different places.
  const rows = Array.isArray(parsed) ? parsed : (plainObject(parsed) && Array.isArray(parsed.environments) ? parsed.environments : null);
  if (rows === null) {
    return Object.freeze({
      ...base,
      reading: READING.UNKNOWN,
      reason: 'The provider\'s environment list did not arrive in a shape this reader recognises, so it is reported unknown rather than empty.',
      environments: Object.freeze([])
    });
  }

  const environments = rows.map(normalizeEnvironment);
  if (environments.some(entry => entry === null)) {
    return Object.freeze({
      ...base,
      reading: READING.UNKNOWN,
      reason: 'At least one provider environment could not be identified, so the account\'s environment list is reported unknown rather than incomplete.',
      environments: Object.freeze([])
    });
  }
  return Object.freeze({
    ...base,
    reading: READING.AUTHORIZED,
    reason: environments.length === 0
      ? 'This account is signed in and has no Codex Cloud environment of its own.'
      : null,
    environments: Object.freeze(environments)
  });
}

/**
 * The environments every configured account is authorized for, merged.
 *
 * A Codex Cloud environment is scoped to the account that created it (measured;
 * see codex-cloud-launch.js SAFE_TO_FAILOVER_AFTER), so `accounts` on each
 * merged row is not decoration -- it is the set of accounts a launch into that
 * environment can actually be served by.
 *
 * `complete` is false whenever ANY account's answer was unknown. A caller that
 * shows this list must say so; an incomplete list rendered as a complete one is
 * how "the environment is not authorized" gets shown for an environment that
 * simply could not be asked about.
 */
async function discoverCloudEnvironments({ accounts = [] } = {}, dependencies = {}) {
  const readOne = dependencies.readAccountEnvironments || listEnvironmentsForAccount;
  const readings = [];
  for (const account of accounts) {
    try {
      readings.push(await readOne(account, dependencies));
    } catch (error) {
      readings.push(Object.freeze({
        account: account && account.name,
        role: null,
        reading: READING.UNKNOWN,
        reason: `This account's environments could not be read (${boundedString(error && error.code, 80) || 'reader failed'}).`,
        environments: Object.freeze([])
      }));
    }
  }

  const merged = new Map();
  for (const reading of readings) {
    for (const environment of reading.environments) {
      const existing = merged.get(environment.environmentId);
      if (existing) {
        if (!existing.accounts.includes(reading.account)) existing.accounts.push(reading.account);
        const previousRepository = typeof existing.repository === 'string' ? existing.repository.toLowerCase() : null;
        const nextRepository = typeof environment.repository === 'string' ? environment.repository.toLowerCase() : null;
        if (previousRepository !== nextRepository) {
          // An environment id is the launch authority, so two signed-in
          // accounts disagreeing about what it names cannot be resolved by
          // array order. Keep the row visible for repair, but remove every
          // field a registration or launch could mistake for authority.
          const repositories = [];
          for (const candidate of [
            ...(Array.isArray(existing.repositories) ? existing.repositories : []),
            ...(Array.isArray(environment.repositories) ? environment.repositories : []),
            existing.repository,
            environment.repository
          ]) {
            if (typeof candidate === 'string'
                && !repositories.some(value => value.toLowerCase() === candidate.toLowerCase())) repositories.push(candidate);
          }
          existing.repository = null;
          existing.repositories = repositories;
          existing.defaultBranch = null;
          existing.visibility = null;
          existing.launchable = false;
          existing.reason = 'Signed-in accounts reported conflicting repository bindings for this environment. Reconcile the environment so every account reports the same single repository, then refresh.';
        }
        continue;
      }
      merged.set(environment.environmentId, { ...environment, accounts: [reading.account] });
    }
  }

  return Object.freeze({
    environments: Object.freeze([...merged.values()]
      .sort((a, b) => String(a.label || a.environmentId).localeCompare(String(b.label || b.environmentId)))
      .map(entry => Object.freeze({ ...entry, accounts: Object.freeze(entry.accounts) }))),
    accounts: Object.freeze(readings.map((reading, index) => Object.freeze({
      account: reading.account,
      /* POSITIONAL, NOT RE-DERIVED FROM `reading`. readings[] has exactly one
       * entry per accounts[] entry, pushed in the same order by the loop
       * directly above -- one push per iteration, nothing filters or
       * reorders between them. Threaded through because a NAME is unique
       * only WITHIN one provider (registry.js's own duplicate check is
       * scoped "<provider>:<name>"), so two different accounts -- one on
       * each of two different providers -- can share one name. A caller
       * that matches a reading back to an account by name alone lands on
       * whichever entry this array happens to hold for that name, provider
       * unchecked. MEASURED live 2026-09-03 on this installation's own
       * registry: a non-Codex account and the configured Codex account
       * share a name, and cloud.account_list reported the non-Codex row as
       * authorized for the Codex account's environments. See
       * codex-cloud-launch.js's listCloudAccounts(), which now matches on
       * (name, provider) rather than name alone. */
      provider: accounts[index] && typeof accounts[index].provider === 'string' ? accounts[index].provider : null,
      reading: reading.reading,
      reason: reading.reason,
      count: reading.environments.length
    }))),
    complete: readings.every(reading => reading.reading !== READING.UNKNOWN),
    readAt: new Date().toISOString()
  });
}

module.exports = Object.freeze({
  ENVIRONMENT_ID,
  PROVIDER_ORIGIN,
  READING,
  discoverCloudEnvironments,
  listEnvironmentsForAccount,
  normalizeEnvironment
});

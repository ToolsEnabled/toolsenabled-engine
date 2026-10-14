'use strict';

// Codex Cloud authentication belongs to the official CLI. The CLI currently
// has no machine-readable repository/environment catalog; discovery reports
// unknown and exposes the native picker/manual-ID route without reading sign-in.
const { redactText } = require('../providers/provider-safety.js');
const { plaintextCredentialPattern } = require('../secret-patterns');
const { projectNativeCloudRoute } = require('./native-cloud-route');
const PROVIDER_ORIGIN = 'https://chatgpt.com';
const ENVIRONMENT_ID = /^[0-9a-f]{32}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const READING = Object.freeze({ AUTHORIZED: 'authorized', SIGNED_OUT: 'signed-out', REJECTED: 'rejected', UNKNOWN: 'unknown' });
function boundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}
function boundedDisplayString(value, maximum, secret) {
  if (typeof value !== 'string') return null;
  const projected = redactText(value, secret, Math.max(value.length, maximum + 1))
    .replace(plaintextCredentialPattern('gi'), '[REDACTED]');
  return boundedString(projected, maximum);
}
function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeEnvironment(raw, { secret = null } = {}) {
  if (!plainObject(raw)) return null;
  const environmentId = boundedString(raw.id, 64);
  if (!environmentId || !ENVIRONMENT_ID.test(environmentId)) return null;

  const repoMap = plainObject(raw.repo_map) ? raw.repo_map : null;
  const entries = repoMap
    ? Object.values(repoMap).filter(plainObject).map(entry => ({
      repository: boundedString(entry.repository_full_name, 220),
      defaultBranch: boundedDisplayString(entry.default_branch, 200, secret),
      visibility: boundedDisplayString(entry.visibility, 40, secret)
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
    label: boundedDisplayString(raw.label, 256, secret),
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

function readAccountSession(account, { nativeSelection = null } = {}) {
  const unknown = reason => Object.freeze({ ok: false, reading: 'unknown', reason });
  const plain = value => value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const text = (value, max) => typeof value === 'string' && value.length > 0
    && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  if (!plain(account)) return unknown('NATIVE_CLOUD_ACCOUNT_INVALID');
  const data = value => Object.values(Object.getOwnPropertyDescriptors(value))
    .every(descriptor => Object.prototype.hasOwnProperty.call(descriptor, 'value'));
  if (!data(account)) return unknown('NATIVE_CLOUD_INPUT_ACCESSOR');
  if (account.provider !== 'codex') return unknown('NATIVE_CLOUD_PROVIDER_UNSUPPORTED');
  if (!text(account.name, 128)) return unknown('NATIVE_CLOUD_ACCOUNT_INVALID');
  let selection = null;
  if (nativeSelection !== null) {
    if (!plain(nativeSelection)) return unknown('NATIVE_CLOUD_SELECTION_INVALID');
    if (!data(nativeSelection)) return unknown('NATIVE_CLOUD_INPUT_ACCESSOR');
    if (nativeSelection.account !== account.name || nativeSelection.provider !== 'codex') {
      return unknown('NATIVE_CLOUD_SELECTION_OWNER_MISMATCH');
    }
    if (typeof nativeSelection.environmentId !== 'string'
        || !/^[0-9a-f]{32}$/.test(nativeSelection.environmentId)) {
      return unknown('NATIVE_CLOUD_ENVIRONMENT_INVALID');
    }
    const repository = nativeSelection.repository == null ? null : nativeSelection.repository;
    if (repository !== null && (!text(repository, 201)
        || !/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repository))) {
      return unknown('NATIVE_CLOUD_REPOSITORY_INVALID');
    }
    const branch = nativeSelection.branch == null ? null : nativeSelection.branch;
    if (branch !== null && (!text(branch, 200)
        || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes('..'))) {
      return unknown('NATIVE_CLOUD_BRANCH_INVALID');
    }
    selection = Object.freeze({
      account: account.name, provider: 'codex',
      environmentId: nativeSelection.environmentId,
      declaredRepository: repository, branch,
      source: 'owner-declared',
      environmentSource: 'person-entered', providerConfirmed: false,
      requiresProviderBinding: false,
      argv: Object.freeze(['cloud', 'exec', '--env', nativeSelection.environmentId,
        ...(branch === null ? [] : ['--branch', branch])])
    });
  }
  return Object.freeze({
    ok: true, reading: 'unknown', reason: 'NATIVE_CLOUD_CATALOG_UNAVAILABLE',
    route: Object.freeze({
      auth: 'native-cli', credentialCustody: 'vendor-cli', account: account.name,
      provider: 'codex', signIn: 'unknown', catalog: 'unavailable',
      picker: Object.freeze({ argv: Object.freeze(['cloud']), interactive: true }),
      manualSelection: selection
    })
  });
}

async function listEnvironmentsForAccount(account, dependencies = {}) {
  const session = readAccountSession(account, dependencies);
  if (!session.ok) return Object.freeze({
    account: null, role: null, reading: 'unknown', reason: session.reason,
    environments: Object.freeze([]), availability: 'refused', nativeRoute: null
  });
  // No documented machine-readable catalog. IDs are declarations, not rows
  // in the provider-confirmed repository catalog used by the current launcher.
  return Object.freeze({
    account: account.name,
    role: typeof account.role === 'string' && account.role.length <= 128
      && !/[\u0000-\u001f\u007f]/.test(account.role) ? account.role : null,
    reading: 'unknown',
    reason: 'NATIVE_CLOUD_CATALOG_UNAVAILABLE: Native Codex owns sign-in. Use its interactive cloud picker or an explicit environment identifier; provider repository verification remains required for the application launcher.',
    environments: Object.freeze([]),
    availability: 'native-picker-or-explicit-id', nativeRoute: session.route
  });
}

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
        reason: 'This account\'s environments could not be read (reader failed).',
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
      count: reading.environments.length,
      ...projectNativeCloudRoute(reading.nativeRoute, {
        account: accounts[index] && accounts[index].name,
        provider: accounts[index] && accounts[index].provider
      })
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

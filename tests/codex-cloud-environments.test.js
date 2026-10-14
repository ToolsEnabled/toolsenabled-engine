'use strict';

// Native credentials remain vendor-owned. Normalization and merge checks
// preserve repository ambiguity and unknown/empty distinctions.
const assert = require('node:assert');
const { READING, discoverCloudEnvironments, listEnvironmentsForAccount, normalizeEnvironment }
  = require('../src/lib/cloud-agent/codex-cloud-environments');
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; }
const ENVIRONMENT = 'a'.repeat(32);
const SECOND_ENVIRONMENT = 'b'.repeat(32);
const ACCOUNT = Object.freeze({ name: 'first', provider: 'codex', role: 'work' });
const OTHER_ACCOUNT = Object.freeze({ name: 'second', provider: 'codex', role: 'personal' });

function environmentRow(overrides = {}) {
  return {
    id: ENVIRONMENT,
    label: 'Owner/repo',
    repos: ['github-1'],
    repo_map: {
      'github-1': {
        repository_full_name: 'Owner/repo',
        default_branch: 'main',
        visibility: 'private'
      }
    },
    ...overrides
  };
}

// --------------------------------------------------------------------------
// normalizeEnvironment: the binding, and the three ways it is not established.
// --------------------------------------------------------------------------
{
  const one = normalizeEnvironment(environmentRow());
  check(one.environmentId === ENVIRONMENT, 'a 32-hex id is carried through');
  check(one.repository === 'Owner/repo', 'a single repository becomes the binding');
  check(one.defaultBranch === 'main', 'the provider default branch is carried through');
  check(one.launchable === true, 'an environment with one repository can take a task');
  check(one.reason === null, 'a fully bound environment needs no reason');

  const two = normalizeEnvironment(environmentRow({
    repo_map: {
      'github-1': { repository_full_name: 'Owner/repo', default_branch: 'main' },
      'github-2': { repository_full_name: 'Owner/other', default_branch: 'main' }
    }
  }));
  check(two.repository === null, 'two repositories leave the binding unestablished rather than guessing the first');
  check(two.launchable === false, 'an ambiguous environment cannot take a task');
  check(/2 repositories/.test(two.reason), 'the ambiguity is stated in the reason');

  const none = normalizeEnvironment(environmentRow({ repo_map: {} }));
  check(none.repository === null, 'no repository map leaves the binding unestablished');
  check(none.launchable === false, 'an unbound environment cannot take a task');

  const noBranch = normalizeEnvironment(environmentRow({
    repo_map: { 'github-1': { repository_full_name: 'Owner/repo' } }
  }));
  check(noBranch.defaultBranch === null, 'an absent default branch stays null and is never defaulted to main');
  check(noBranch.launchable === true, 'an absent default branch does not block a launch with an explicit branch');
  check(/default branch/.test(noBranch.reason), 'the missing branch is stated');

  check(normalizeEnvironment({ id: 'not-an-id', repo_map: {} }) === null, 'an id this launcher cannot use is dropped');
  check(normalizeEnvironment(null) === null, 'a non-object row is dropped');
}

(async () => {
  let fileReads = 0, httpRequests = 0;
  const native = await listEnvironmentsForAccount(ACCOUNT, {
    fsImpl: { readFileSync() { fileReads++; throw new Error('unexpected sign-in read'); } },
    fetchImpl: async () => { httpRequests++; throw new Error('unexpected backend request'); }
  });
  check(fileReads === 0, 'the app must never read native Codex authentication');
  check(httpRequests === 0, 'the app must never call a token-authenticated ChatGPT backend');
  check(native.reading === 'unknown', 'unsupported native catalog discovery remains unknown');
  check(native.environments.length === 0, 'a CLI route plan must not invent a provider catalog');
  check(native.nativeRoute.credentialCustody === 'vendor-cli', 'sign-in stays with the official CLI');
  // ------------------------------------------------------------------------
  // The merge.
  // ------------------------------------------------------------------------
  {
    const merged = await discoverCloudEnvironments({ accounts: [ACCOUNT, OTHER_ACCOUNT] }, {
      readAccountEnvironments: async account => (account.name === 'first'
        ? { account: 'first', role: 'work', reading: READING.AUTHORIZED, reason: null, environments: [normalizeEnvironment(environmentRow())] }
        : {
          account: 'second',
          role: 'personal',
          reading: READING.AUTHORIZED,
          reason: null,
          environments: [
            normalizeEnvironment(environmentRow()),
            normalizeEnvironment(environmentRow({ id: SECOND_ENVIRONMENT, label: 'Owner/second' }))
          ]
        })
    });
    check(merged.environments.length === 2, 'an environment both accounts can see appears once');
    const shared = merged.environments.find(entry => entry.environmentId === ENVIRONMENT);
    check(shared.accounts.length === 2, 'the shared environment names both accounts that can serve it');
    check(merged.complete === true, 'two authorized readings are a complete reading');
    check(typeof merged.readAt === 'string', 'the reading carries the time it was taken');
  }

  {
    const conflicting = normalizeEnvironment(environmentRow({
      label: 'Elsewhere/other',
      repo_map: {
        'github-2': {
          repository_full_name: 'Elsewhere/other',
          default_branch: 'main',
          visibility: 'private'
        }
      }
    }));
    const merged = await discoverCloudEnvironments({ accounts: [ACCOUNT, OTHER_ACCOUNT] }, {
      readAccountEnvironments: async account => ({
        account: account.name,
        role: account.role,
        reading: READING.AUTHORIZED,
        reason: null,
        environments: [account.name === 'first' ? normalizeEnvironment(environmentRow()) : conflicting]
      })
    });
    const ambiguous = merged.environments[0];
    check(ambiguous.repository === null && ambiguous.launchable === false,
      'conflicting bindings for one environment id remove repository authority instead of trusting account order');
    check(ambiguous.accounts.length === 2 && ambiguous.repositories.includes('Owner/repo')
      && ambiguous.repositories.includes('Elsewhere/other'),
      'the ambiguous row stays visible with both reporting accounts and both conflicting repositories');
    check(/conflicting repository bindings/.test(ambiguous.reason),
      'the ambiguous row gives a fixed actionable reason rather than attributing either repository to both accounts');
  }

  {
    const merged = await discoverCloudEnvironments({ accounts: [ACCOUNT, OTHER_ACCOUNT] }, {
      readAccountEnvironments: async account => (account.name === 'first'
        ? { account: 'first', role: 'work', reading: READING.AUTHORIZED, reason: null, environments: [normalizeEnvironment(environmentRow())] }
        : { account: 'second', role: 'personal', reading: READING.UNKNOWN, reason: 'could not ask', environments: [] })
    });
    check(merged.complete === false, 'one unknown account makes the whole reading incomplete');
    check(merged.environments.length === 1, 'the accounts that did answer still contribute');
  }

  {
    const merged = await discoverCloudEnvironments({ accounts: [ACCOUNT] }, {
      readAccountEnvironments: async () => { const error = new Error('reader exploded'); error.code = 'READER_FAILED'; throw error; }
    });
    check(merged.complete === false, 'a reader that throws is an incomplete reading, not an empty one');
    check(merged.environments.length === 0, 'and it contributes nothing');
  }

  {
    const merged = await discoverCloudEnvironments({ accounts: [] }, {});
    check(merged.complete === true, 'no configured accounts is a complete reading of nothing');
    check(merged.environments.length === 0, 'with no environments');
  }

  console.log(`codex-cloud-environments: ${checks} checks passed`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

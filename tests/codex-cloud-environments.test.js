// EXECUTABLE CHANGE
//
// Mutation evidence (performed in a detached scratch worktree; the production
// source in this worktree was never edited):
// - PROVIDER_ORIGIN was changed from https://chatgpt.com to
//   https://mutant.invalid.  The literal request-target check added below went
//   RED with:
//     AssertionError [ERR_ASSERTION]: the request target is the pinned Codex provider endpoint
// - Each READING value was separately prefixed with "mutant-".  The four
//   corresponding literal state checks added below went RED with:
//     AssertionError [ERR_ASSERTION]: the authorized state has its stable wire value
//     AssertionError [ERR_ASSERTION]: the signed-out state has its stable wire value
//     AssertionError [ERR_ASSERTION]: the rejected state has its stable wire value
//     AssertionError [ERR_ASSERTION]: the unknown state has its stable wire value
// The scratch source was restored to its original SHA-256 byte-for-byte, after
// which `node tests/codex-cloud-environments.test.js` was GREEN with:
//   codex-cloud-environments: 45 checks passed
//
// Census of the requested shapes:
// - EMPTY LOOP / FOREACH: NOT-FOUND (no assertion is inside an input-dependent
//   loop or forEach).
// - EXIT STATUS / TRUTHY RETURN: NOT-FOUND.
// - SWALLOWED FAILURE: NOT-FOUND (the terminal catch sets a failing exit code).
// - MOCK OF SUBJECT: NOT-FOUND (the injected account reader is a dependency of
//   the merge operation, not the merge operation under test).
// - SKIP / PLATFORM PRECONDITION: NOT-FOUND.
// - EXPECTED VALUE COMPUTED BY SUBJECT: FOUND for PROVIDER_ORIGIN and READING;
//   the independent literal assertions below make those checks discriminate.
// Preconditions not met: NONE.

'use strict';

// Behavioural tests for non-interactive Codex Cloud environment discovery.
//
// Everything is injected: no network, no real Codex home, no real account
// registry. Each assertion carries a DISTINCT message so a mutant that dies for
// a new reason stays visible.
//
// What is pinned here is the fail-closed half, because that is the half a
// discovery feature gets wrong. Three distinct facts must never collapse into
// each other:
//   - "this account has no environments"        (a complete, empty answer)
//   - "this account could not be asked"         (unknown -> the merged reading
//                                                is INCOMPLETE, and a caller
//                                                may not treat a missing
//                                                environment as unauthorized)
//   - "this environment has no single repository" (present, shown, refused)
// And one credential rule: the account's stored sign-in authorizes the call and
// appears in NOTHING this module returns.

const assert = require('node:assert');

const {
  PROVIDER_ORIGIN,
  READING,
  discoverCloudEnvironments,
  listEnvironmentsForAccount,
  normalizeEnvironment
} = require('../src/lib/cloud-agent/codex-cloud-environments');

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const ENVIRONMENT = 'a'.repeat(32);
const SECOND_ENVIRONMENT = 'b'.repeat(32);
const TOKEN = 'sk-test-not-a-real-token-0123456789';

const ACCOUNT = Object.freeze({ name: 'first', role: 'work', profileDir: 'C:\\codex-first' });
const OTHER_ACCOUNT = Object.freeze({ name: 'second', role: 'personal', profileDir: 'C:\\codex-second' });

function fakeFs(files) {
  return {
    readFileSync(target) {
      for (const [name, contents] of Object.entries(files)) {
        if (String(target).toLowerCase().includes(name.toLowerCase())) return contents;
      }
      const error = new Error(`ENOENT: ${target}`);
      error.code = 'ENOENT';
      throw error;
    }
  };
}

const SIGNED_IN = fakeFs({ 'codex-first': JSON.stringify({ tokens: { access_token: TOKEN, account_id: 'acct-1' } }) });

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

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

// --------------------------------------------------------------------------
// The per-account read.
// --------------------------------------------------------------------------
(async () => {
  {
    let seenUrl = null;
    let seenInit = null;
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home',
      fsImpl: SIGNED_IN,
      fetchImpl: async (url, init) => { seenUrl = url; seenInit = init; return jsonResponse([environmentRow()]); }
    });
    check(reading.reading === READING.AUTHORIZED, 'a 200 with rows is an authorized reading');
    check(reading.reading === 'authorized', 'the authorized state has its stable wire value');
    check(reading.environments.length === 1, 'the row is normalized into one environment');
    check(String(seenUrl).startsWith(PROVIDER_ORIGIN), 'the request goes to the provider origin constant and nowhere else');
    check(String(seenUrl) === 'https://chatgpt.com/backend-api/wham/environments', 'the request target is the pinned Codex provider endpoint');
    check(seenInit.redirect === 'error', 'a redirect is refused rather than followed with the account bearer');
    check(seenInit.headers.authorization.includes(TOKEN), 'the account sign-in authorizes the call');
    check(!JSON.stringify(reading).includes(TOKEN), 'no credential value appears in what is returned');
  }

  {
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home',
      fsImpl: fakeFs({}),
      fetchImpl: async () => { throw new Error('the network must not be reached for a signed-out account'); }
    });
    check(reading.reading === READING.SIGNED_OUT, 'an account with no auth file is signed out');
    check(reading.reading === 'signed-out', 'the signed-out state has its stable wire value');
    check(reading.environments.length === 0, 'a signed-out account contributes no environments');
  }

  {
    const unreadableFs = { readFileSync() { const error = new Error('permission denied'); error.code = 'EACCES'; throw error; } };
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home', fsImpl: unreadableFs, fetchImpl: async () => { throw new Error('network must not be reached'); }
    });
    check(reading.reading === READING.UNKNOWN, 'an unreadable auth file is unknown, not signed out');
  }

  {
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home', fsImpl: fakeFs({ 'codex-first': '{broken-json' }), fetchImpl: async () => { throw new Error('network must not be reached'); }
    });
    check(reading.reading === READING.UNKNOWN, 'a malformed auth file is unknown, not signed out');
  }

  {
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home', fsImpl: SIGNED_IN, fetchImpl: async () => jsonResponse({ error: 'nope' }, { status: 401 })
    });
    check(reading.reading === READING.REJECTED, 'a refused sign-in is its own reading, not an empty list');
    check(reading.reading === 'rejected', 'the rejected state has its stable wire value');
    check(/sign this account in again/i.test(reading.reason), 'the refusal says what to do about it');
  }

  {
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home', fsImpl: SIGNED_IN, fetchImpl: async () => jsonResponse({}, { status: 500 })
    });
    check(reading.reading === READING.UNKNOWN, 'a provider error is unknown, never an empty list');
    check(reading.reading === 'unknown', 'the unknown state has its stable wire value');
  }

  {
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home', fsImpl: SIGNED_IN, fetchImpl: async () => jsonResponse('<html>signed in?</html>')
    });
    check(reading.reading === READING.UNKNOWN, 'an unrecognised envelope is unknown, never an empty list');
  }

  {
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home', fsImpl: SIGNED_IN, fetchImpl: async () => jsonResponse([environmentRow(), { id: 'not-an-id' }])
    });
    check(reading.reading === READING.UNKNOWN, 'one unidentifiable row makes the provider list unknown rather than shorter');
    check(reading.environments.length === 0, 'an uncertain provider list contributes no partial definitive count');
  }

  {
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home',
      fsImpl: SIGNED_IN,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        async text() { throw new Error('body read failed'); }
      })
    });
    check(reading.reading === READING.UNKNOWN, 'a response-body read failure is unknown');
    check(!/larger/.test(reading.reason), 'a response-body read failure is not misreported as an oversized body');
  }

  {
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home', fsImpl: SIGNED_IN, fetchImpl: async () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; }
    });
    check(reading.reading === READING.UNKNOWN, 'a transport failure is unknown, never an empty list');
    check(!JSON.stringify(reading).includes(TOKEN), 'a failure path leaks no credential either');
  }

  {
    // `null`, not `undefined`: an omitted option takes the module's default
    // (the real fetch), which is exactly what a test must not reach. Passing
    // null is how "this runtime has no HTTP client" is stated without arranging
    // for a live request to be attempted.
    const reading = await listEnvironmentsForAccount(ACCOUNT, {
      homeDir: 'C:\\home', fsImpl: SIGNED_IN, fetchImpl: null
    });
    check(reading.reading === READING.UNKNOWN, 'a runtime with no HTTP client reports unknown rather than empty');
  }

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

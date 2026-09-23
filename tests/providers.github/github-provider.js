'use strict';

require('../lib/isolated-environment').activate('github-provider');
const assert = require('node:assert/strict');
const github = require('../../src/lib/providers/github');
const { createStateStore } = require('../../src/lib/state-store');

let now = 1_800_000_000_000;
const state = createStateStore({ file: ':memory:', ownerId: 'github-provider-test', clock: () => now });

function issue(number = 7, overrides = {}) {
  return {
    id: 1000 + number, number, node_id: `I_${number}`, title: `Issue ${number}`, state: 'open',
    html_url: `https://github.com/acme/widgets/issues/${number}`,
    url: `https://api.github.com/repos/acme/widgets/issues/${number}`,
    user: { login: 'accta' }, labels: [{ name: 'bug' }], assignees: [{ login: 'octocat' }],
    created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T01:00:00Z', closed_at: null,
    body: `Issue body ${number}`, ...overrides
  };
}

function pull(number = 8, overrides = {}) {
  return {
    id: 2000 + number, number, node_id: `PR_${number}`, title: `Pull ${number}`, state: 'open',
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    url: `https://api.github.com/repos/acme/widgets/pulls/${number}`,
    user: { login: 'accta' }, draft: false, merged: false,
    head: { label: 'accta:feature', ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'accta/widgets' } },
    base: { label: 'acme:main', ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'acme/widgets' } },
    created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T01:00:00Z', closed_at: null,
    body: `Pull body ${number}`, ...overrides
  };
}

function release(id = 9, overrides = {}) {
  return {
    id, node_id: `R_${id}`, tag_name: `v1.${id}.0`, target_commitish: 'main', name: `Release ${id}`,
    html_url: `https://github.com/acme/widgets/releases/tag/v1.${id}.0`, draft: false, prerelease: false,
    created_at: '2026-07-23T00:00:00Z', published_at: '2026-07-23T01:00:00Z', author: { login: 'accta' }, assets: [], ...overrides
  };
}

function comment(id = 10, overrides = {}) {
  return {
    id, node_id: `C_${id}`, html_url: `https://github.com/acme/widgets/issues/7#issuecomment-${id}`,
    url: `https://api.github.com/repos/acme/widgets/issues/comments/${id}`,
    user: { login: 'accta' }, body: 'Comment body', created_at: '2026-07-23T00:00:00Z',
    updated_at: '2026-07-23T01:00:00Z', ...overrides
  };
}

function fixture(response) {
  const calls = [];
  return {
    calls,
    dependencies: {
      state,
      now: () => now,
      assertActive: (...args) => calls.push(['active', ...args]),
      getSecret: key => {
        calls.push(['secret', key]);
        assert.equal(key, 'github_pat');
        return `github_pat_${'a'.repeat(82)}`;
      },
      record: (...args) => calls.push(['audit', ...args]),
      request: async (url, options) => {
        calls.push(['request', String(url), options]);
        return response(String(url), options);
      }
    }
  };
}

/*
EXECUTABLE CHANGE
Strengthened the x-github-api-version assertion at line 112 (line 89 at mutation time).
Mutation: changed src/lib/providers/github.js API_VERSION from 2026-03-10 to 2099-12-31.
Before strengthening, the mutated test stayed green: "GitHub provider tests passed."
After strengthening, the mutation produced RED output:
"AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected
+ '2099-12-31'
- '2026-03-10'"
The source was restored byte-for-byte (sha256sum: "src/lib/providers/github.js: OK"), and the
strengthened test was green again: "GitHub provider tests passed."
NOT-FOUND (1): no assertion body guarded by a possibly empty loop or forEach collection.
NOT-FOUND (2): no exit-status or generic truthy-return assertion based only on subject output.
NOT-FOUND (3): no try/catch or optional chain that swallows the failure under test.
NOT-FOUND (4): no assertion against a mock of the GitHub provider itself.
NOT-FOUND (5): no skip or platform precondition guard that can make this file a no-op.
NOT-FOUND (6), beyond the fixed API version assertion: no expected value computed by the same
code it checks.
PRECONDITION: the default Node.js 20.20.2 lacks node:sqlite; mutation and green runs therefore
used the repository-compatible installed Node.js 22.22.2.
*/

(async () => {
  try {
    {
      const { calls, dependencies } = fixture(() => ({ body: {
        id: 1, node_id: 'R_1', name: 'widgets', full_name: 'acme/widgets', html_url: 'https://github.com/acme/widgets',
        private: true, visibility: 'private', default_branch: 'main', description: 'Repository description', archived: false,
        disabled: false, owner: { login: 'acme' }
      } }));
      const result = await github.repoGet({ owner: 'acme', repo: 'widgets' }, dependencies);
      assert.equal(result.contentTrust, 'untrusted');
      assert.equal(result.grantsAuthority, false);
      assert.equal(result.fullName, 'acme/widgets');
      assert.equal(result.archived, false);
      assert.equal(result.disabled, false);
      assert.deepEqual(calls.map(call => call[0]), ['active', 'secret', 'request', 'audit']);
      assert.equal(calls[0][1], 'github.repo_get');
      assert.equal(calls[2][1], 'https://api.github.com/repos/acme/widgets');
      assert.equal(calls[2][2].headers['x-github-api-version'], '2026-03-10');
      assert.match(calls[2][2].headers.authorization, /^Bearer github_pat_/);
      assert.equal(JSON.stringify(calls.find(call => call[0] === 'audit')).includes('github_pat_'), false);
    }

    {
      const { dependencies } = fixture(() => ({ body: {
        id: 2, name: 'widgets', full_name: 'acme/widgets', private: true, visibility: 'private'
      } }));
      const result = await github.repoGet({ owner: 'acme', repo: 'widgets' }, dependencies);
      assert.equal(result.archived, null,
        'Missing archived metadata must remain explicitly unknown rather than being normalized to false.');
      assert.equal(result.disabled, null,
        'Missing disabled metadata must remain explicitly unknown rather than being normalized to false.');
    }

    {
      const { calls, dependencies } = fixture(() => ({ body: [issue(1), issue(2, { pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/2' } })] }));
      const result = await github.issueList({ owner: 'acme', repo: 'widgets', limit: 20 }, dependencies);
      assert.equal(result.count, 1, 'Issue listing must exclude pull-request-backed issues.');
      assert.equal(result.issues[0].issueNumber, 1);
      assert.match(calls.find(call => call[0] === 'request')[1], /\/issues\?state=open&sort=created&direction=desc&per_page=20$/);
    }

    {
      let mutations = 0;
      const leakedResponseToken = `github_pat_${'z'.repeat(82)}`;
      const { calls, dependencies } = fixture((_url, options) => {
        mutations += 1;
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), {
          title: 'Durable issue', body: 'Details', labels: ['bug'], assignees: ['octocat']
        });
        return { body: issue(12, { title: 'Durable issue', body: `Details ${leakedResponseToken}` }) };
      });
      const input = {
        owner: 'acme', repo: 'widgets', title: 'Durable issue', body: 'Details', labels: ['bug'], assignees: ['octocat'],
        idempotencyKey: 'github-issue-create-0001'
      };
      const created = await github.issueCreate(input, dependencies);
      assert.equal(created.replayed, false);
      assert.equal(created.issueNumber, 12);
      assert.doesNotMatch(created.body, new RegExp(leakedResponseToken));
      assert.match(created.body, /REDACTED/);
      const replay = await github.issueCreate(input, dependencies);
      assert.equal(replay.replayed, true);
      assert.doesNotMatch(replay.body, new RegExp(leakedResponseToken));
      assert.equal(mutations, 1, 'A completed mutation must replay without another provider request.');
      await assert.rejects(github.issueCreate({ ...input, title: 'Different input' }, dependencies), error => error && error.code === 'OPERATION_INPUT_CONFLICT');
      assert.equal(calls.filter(call => call[0] === 'audit').length, 1);
    }

    {
      const { dependencies } = fixture(() => { throw new Error('simulated GitHub timeout'); });
      const input = {
        owner: 'acme', repo: 'widgets', title: 'Uncertain issue', idempotencyKey: 'github-issue-create-0002'
      };
      await assert.rejects(github.issueCreate(input, dependencies), /simulated GitHub timeout/);
      assert.equal(state.getOperation({ type: 'github.issue_create', key: input.idempotencyKey }).status, 'uncertain');
      await assert.rejects(github.issueCreate(input, dependencies), error => error && error.code === 'OPERATION_UNCERTAIN');
    }

    {
      const { calls, dependencies } = fixture((_url, options) => {
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), {
          title: 'Create PR', head: 'accta:feature', base: 'main', body: 'PR details', draft: true, maintainer_can_modify: false
        });
        return { body: pull(13, { title: 'Create PR', draft: true }) };
      });
      const result = await github.pullRequestCreate({
        owner: 'acme', repo: 'widgets', title: 'Create PR', head: 'accta:feature', base: 'main', body: 'PR details',
        draft: true, maintainerCanModify: false, idempotencyKey: 'github-pr-create-00001'
      }, dependencies);
      assert.equal(result.draft, true);
      assert.match(calls.find(call => call[0] === 'request')[1], /\/pulls$/);
    }

    {
      const { calls, dependencies } = fixture((_url, options) => {
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { body: 'An issue comment' });
        return { body: comment(14, { body: 'An issue comment' }) };
      });
      const result = await github.issueCommentCreate({
        owner: 'acme', repo: 'widgets', issueNumber: 7, body: 'An issue comment', idempotencyKey: 'github-comment-create-1'
      }, dependencies);
      assert.equal(result.id, 14);
      assert.match(calls.find(call => call[0] === 'request')[1], /\/issues\/7\/comments$/);
    }

    {
      const { calls, dependencies } = fixture((_url, options) => {
        assert.equal(options.method, 'POST');
        return { body: release(15) };
      });
      const result = await github.releaseCreate({
        owner: 'acme', repo: 'widgets', tagName: 'v1.15.0', name: 'Release 15', body: 'Release notes',
        generateReleaseNotes: true, idempotencyKey: 'github-release-create-01'
      }, dependencies);
      assert.equal(result.tagName, 'v1.15.0');
      const body = JSON.parse(calls.find(call => call[0] === 'request')[2].body);
      assert.equal(body.tag_name, 'v1.15.0');
      assert.equal(body.generate_release_notes, true);
      assert.equal(Object.hasOwn(body, 'target_commitish'), false);
    }

    {
      const { calls, dependencies } = fixture((_url, options) => {
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { event_type: 'release-ready', client_payload: { version: 'v1.0.0', stable: true } });
        return { status: 204, body: {} };
      });
      const result = await github.repositoryDispatch({
        owner: 'acme', repo: 'widgets', eventType: 'release-ready', clientPayload: { version: 'v1.0.0', stable: true },
        idempotencyKey: 'github-dispatch-create-1'
      }, dependencies);
      assert.deepEqual(result, {
        repository: 'acme/widgets', eventType: 'release-ready', dispatched: true,
        contentTrust: 'untrusted', grantsAuthority: false, replayed: false
      });
      assert.match(calls.find(call => call[0] === 'request')[1], /\/dispatches$/);
      await assert.rejects(github.repositoryDispatch({
        owner: 'acme', repo: 'widgets', eventType: 'bad', clientPayload: { api_token: 'not-allowed' },
        idempotencyKey: 'github-dispatch-create-2'
      }, dependencies), /not permitted/);
    }

    {
      const { dependencies } = fixture(url => {
        if (url.includes('/pulls?')) return { body: [pull(16)] };
        if (url.includes('/releases?')) return { body: [release(16)] };
        if (url.endsWith('/issues/16')) return { body: issue(16) };
        if (url.endsWith('/pulls/16')) return { body: pull(16) };
        throw new Error(`Unexpected read URL ${url}`);
      });
      assert.equal((await github.pullRequestList({ owner: 'acme', repo: 'widgets' }, dependencies)).count, 1);
      assert.equal((await github.releaseList({ owner: 'acme', repo: 'widgets' }, dependencies)).count, 1);
      assert.equal((await github.issueGet({ owner: 'acme', repo: 'widgets', issueNumber: 16 }, dependencies)).body, 'Issue body 16');
      assert.equal((await github.pullRequestGet({ owner: 'acme', repo: 'widgets', pullNumber: 16 }, dependencies)).body, 'Pull body 16');
    }

    assert.throws(() => github.dispatchPayload({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11 }), /at most 10/);
    assert.throws(() => github.dispatchPayload({ nested: { access_token: 'not-allowed' } }), /not permitted/);
    assert.throws(() => github.dispatchPayload({ nested: { accessToken: 'not-allowed' } }), /not permitted/);
    console.log('GitHub provider tests passed.');
  } finally {
    state.close();
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

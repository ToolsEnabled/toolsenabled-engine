'use strict';

const crypto = require('node:crypto');
const { plaintextCredentialPattern } = require('../secret-patterns');
const { getSecret } = require('../runtime');
const { assertActive } = require('../policy');
const { record, scrubText } = require('../audit');
const { request } = require('../http');
const { getStateStore, hashInput } = require('../state-store');

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const OPERATION_LEASE_MS = 3 * 60 * 1000;
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });
const OWNER_OR_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const EVENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const PLAINTEXT_SECRET = plaintextCredentialPattern();
const SENSITIVE_KEY = /(?:(?:^|[_-])(?:token|secret|password|authorization|cookie|api[_-]?key|credential|session)(?:$|[_-])|(?:token|secret|password|authorization|cookie|credential|session|apiKey|privateKey)$)/i;

function dependencies(overrides = {}) {
  return {
    assertActive: overrides.assertActive || assertActive,
    getSecret: overrides.getSecret || getSecret,
    record: overrides.record || record,
    request: overrides.request || request,
    state: overrides.state,
    hashInput: overrides.hashInput || hashInput,
    now: overrides.now || (() => Date.now())
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requiredString(value, label, maximum, { pattern, allowEmpty = false, forbidNewlines = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || /\x00/.test(value)
    || (forbidNewlines && /[\r\n]/.test(value)) || (pattern && !pattern.test(value))) {
    throw new TypeError(`${label} is invalid.`);
  }
  if (PLAINTEXT_SECRET.test(value)) {
    throw new TypeError(`${label} appears to contain a plaintext credential; use the vault instead.`);
  }
  return value;
}

function optionalString(value, label, maximum, options = {}) {
  return value === undefined ? '' : requiredString(value, label, maximum, { ...options, allowEmpty: true });
}

function vaultSecret(value, label, maximum = 4096) {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\x00\r\n]/.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function boundedInteger(value, label, defaultValue, minimum, maximum) {
  const actual = value === undefined ? defaultValue : value;
  if (!Number.isSafeInteger(actual) || actual < minimum || actual > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return actual;
}

function repository(owner, repo) {
  return {
    owner: requiredString(owner, 'owner', 100, { pattern: OWNER_OR_REPO, forbidNewlines: true }),
    repo: requiredString(repo, 'repo', 100, { pattern: OWNER_OR_REPO, forbidNewlines: true })
  };
}

function repositoryPath(owner, repo) {
  const value = repository(owner, repo);
  return { ...value, path: `/repos/${encodeURIComponent(value.owner)}/${encodeURIComponent(value.repo)}` };
}

function idempotencyKey(value) {
  return requiredString(value, 'idempotencyKey', 200, { pattern: IDEMPOTENCY_KEY, forbidNewlines: true });
}

function arrayOfText(value, label, { maximumItems, maximumLength, pattern } = {}) {
  const items = value === undefined ? [] : value;
  if (!Array.isArray(items) || items.length > maximumItems) {
    throw new TypeError(`${label} must be an array of at most ${maximumItems} values.`);
  }
  const normalized = items.map((item, index) => requiredString(item, `${label}[${index}]`, maximumLength, { pattern, forbidNewlines: true }));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} must not contain duplicates.`);
  return normalized;
}

function assertJsonPayload(value, label = 'clientPayload', depth = 0, seen = new Set()) {
  if (depth > 24) throw new TypeError(`${label} nesting exceeds the GitHub repository-dispatch limit.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain only finite JSON numbers.`);
    return value;
  }
  if (typeof value === 'string') {
    if (PLAINTEXT_SECRET.test(value)) throw new TypeError(`${label} appears to contain a plaintext credential; use the vault instead.`);
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError(`${label} must be a non-circular JSON value.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonPayload(entry, `${label}[${index}]`, depth + 1, seen));
  } else {
    if (!isPlainObject(value)) throw new TypeError(`${label} must contain only plain JSON objects.`);
    for (const [key, entry] of Object.entries(value)) {
      if (!key || key.length > 100 || SENSITIVE_KEY.test(key)) {
        throw new TypeError(`${label}.${key} is not permitted in a repository-dispatch payload.`);
      }
      assertJsonPayload(entry, `${label}.${key}`, depth + 1, seen);
    }
  }
  seen.delete(value);
  return value;
}

function dispatchPayload(value) {
  const payload = value === undefined ? {} : value;
  if (!isPlainObject(payload)) throw new TypeError('clientPayload must be a plain JSON object.');
  if (Object.keys(payload).length > 10) throw new TypeError('clientPayload may contain at most 10 top-level properties.');
  assertJsonPayload(payload);
  let json;
  try { json = JSON.stringify(payload); } catch { throw new TypeError('clientPayload must be JSON-serializable.'); }
  if (Buffer.byteLength(json, 'utf8') >= 64 * 1024) throw new TypeError('clientPayload must be smaller than 64 KiB.');
  return payload;
}

function githubToken(d) {
  return vaultSecret(d.getSecret('github_pat'), 'github_pat vault secret');
}

function headers(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': API_VERSION,
    'user-agent': 'ToolsEnabled/1.4.0'
  };
}

async function api(path, token, d, options = {}) {
  const result = await d.request(`${API_ROOT}${path}`, {
    ...options,
    headers: { ...headers(token), ...(options.headers || {}) }
  });
  if (!result || !Object.prototype.hasOwnProperty.call(result, 'body')) {
    throw new Error('GitHub returned an invalid response envelope.');
  }
  return result.body;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function clipped(value, maximum = 16_000) {
  return typeof value === 'string' ? scrubText(value, maximum) : null;
}

function apiObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`GitHub returned an invalid ${label} response.`);
  return value;
}

function apiArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`GitHub returned an invalid ${label} response.`);
  return value;
}

function login(value) {
  return value && typeof value.login === 'string' ? clipped(value.login, 100) : null;
}

function labels(value) {
  return Array.isArray(value) ? value.map(label => typeof label === 'string' ? label : label && label.name)
    .filter(label => typeof label === 'string').slice(0, 50).map(label => clipped(label, 100)) : [];
}

function issueRecord(raw, { includeBody = false } = {}) {
  const value = apiObject(raw, 'issue');
  if (!Number.isSafeInteger(value.number) || value.number < 1) throw new Error('GitHub returned an issue without a valid number.');
  return compact({
    id: Number.isSafeInteger(value.id) ? value.id : null,
    issueNumber: value.number,
    nodeId: clipped(value.node_id, 200),
    title: clipped(value.title, 500),
    state: clipped(value.state, 30),
    htmlUrl: clipped(value.html_url, 2048),
    url: clipped(value.url, 2048),
    author: login(value.user),
    labels: labels(value.labels),
    assignees: Array.isArray(value.assignees) ? value.assignees.map(login).filter(Boolean).slice(0, 50) : [],
    isPullRequest: Boolean(value.pull_request),
    createdAt: clipped(value.created_at, 100),
    updatedAt: clipped(value.updated_at, 100),
    closedAt: clipped(value.closed_at, 100),
    body: includeBody ? clipped(value.body) : undefined
  });
}

function pullRequestRecord(raw, { includeBody = false } = {}) {
  const value = apiObject(raw, 'pull request');
  if (!Number.isSafeInteger(value.number) || value.number < 1) throw new Error('GitHub returned a pull request without a valid number.');
  const ref = side => value[side] && typeof value[side] === 'object' ? compact({
    label: clipped(value[side].label, 300), ref: clipped(value[side].ref, 300), sha: clipped(value[side].sha, 200),
    repository: value[side].repo && typeof value[side].repo.full_name === 'string' ? clipped(value[side].repo.full_name, 300) : null
  }) : null;
  return compact({
    id: Number.isSafeInteger(value.id) ? value.id : null,
    pullNumber: value.number,
    nodeId: clipped(value.node_id, 200),
    title: clipped(value.title, 500),
    state: clipped(value.state, 30),
    htmlUrl: clipped(value.html_url, 2048),
    url: clipped(value.url, 2048),
    author: login(value.user),
    draft: value.draft === true,
    merged: value.merged === true,
    head: ref('head'),
    base: ref('base'),
    createdAt: clipped(value.created_at, 100),
    updatedAt: clipped(value.updated_at, 100),
    closedAt: clipped(value.closed_at, 100),
    body: includeBody ? clipped(value.body) : undefined
  });
}

function releaseRecord(raw) {
  const value = apiObject(raw, 'release');
  if (!Number.isSafeInteger(value.id) || value.id < 1 || typeof value.tag_name !== 'string' || !value.tag_name) {
    throw new Error('GitHub returned an invalid release response.');
  }
  return compact({
    id: value.id,
    nodeId: clipped(value.node_id, 200),
    tagName: clipped(value.tag_name, 300),
    targetCommitish: clipped(value.target_commitish, 300),
    name: clipped(value.name, 500),
    htmlUrl: clipped(value.html_url, 2048),
    draft: value.draft === true,
    prerelease: value.prerelease === true,
    createdAt: clipped(value.created_at, 100),
    publishedAt: clipped(value.published_at, 100),
    author: login(value.author),
    assetCount: Array.isArray(value.assets) ? value.assets.length : 0
  });
}

function commentRecord(raw) {
  const value = apiObject(raw, 'issue comment');
  if (!Number.isSafeInteger(value.id) || value.id < 1) throw new Error('GitHub returned an invalid issue-comment response.');
  return compact({
    id: value.id,
    nodeId: clipped(value.node_id, 200),
    htmlUrl: clipped(value.html_url, 2048),
    url: clipped(value.url, 2048),
    author: login(value.user),
    body: clipped(value.body),
    createdAt: clipped(value.created_at, 100),
    updatedAt: clipped(value.updated_at, 100)
  });
}

function repositoryRecord(raw) {
  const value = apiObject(raw, 'repository');
  return compact({
    id: Number.isSafeInteger(value.id) ? value.id : null,
    nodeId: clipped(value.node_id, 200),
    name: clipped(value.name, 200),
    fullName: clipped(value.full_name, 300),
    htmlUrl: clipped(value.html_url, 2048),
    private: value.private === true,
    visibility: clipped(value.visibility, 30),
    defaultBranch: clipped(value.default_branch, 300),
    description: clipped(value.description, 4_000),
    archived: typeof value.archived === 'boolean' ? value.archived : null,
    disabled: typeof value.disabled === 'boolean' ? value.disabled : null,
    owner: login(value.owner)
  });
}

function untrusted(value) {
  return { ...value, ...UNTRUSTED_CONTENT };
}

function operationOwner(operationType, key) {
  return `github-${crypto.createHash('sha256').update(`${operationType}\u0000${key}`).digest('hex').slice(0, 32)}`;
}

function errorCode(error, fallback) {
  return error && typeof error.code === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(error.code) ? error.code : fallback;
}

function uncertainCompletionError() {
  const error = new Error('GitHub completed a provider request, but durable completion could not be recorded. Automatic replay is blocked pending reconciliation.');
  error.code = 'GITHUB_EXTERNAL_COMMIT_UNRECORDED';
  return error;
}

async function mutate({ operationType, key, input, action, subject, details, execute }, d) {
  const state = d.state || getStateStore();
  const reservation = state.reserveOperation({
    type: operationType,
    key,
    inputHash: d.hashInput(input),
    ownerId: operationOwner(operationType, key),
    leaseMs: OPERATION_LEASE_MS
  });
  if (reservation.disposition === 'replay') return { ...(reservation.result || {}), replayed: true };
  if (reservation.disposition !== 'reserved' || !reservation.handle) throw new Error('GitHub mutation reservation returned an invalid state.');

  let handle = reservation.handle;
  let providerAttempted = false;
  let result;
  try {
    handle = state.markOperationExecuting(handle, { leaseMs: OPERATION_LEASE_MS }).handle;
    providerAttempted = true;
    result = await execute();
    try { state.succeedOperation(handle, { result }); }
    catch {
      try {
        state.markOperationUncertain(handle, {
          errorCode: 'GITHUB_EXTERNAL_COMMIT_UNRECORDED',
          errorMessage: 'GitHub returned success but durable completion could not be recorded.'
        });
      } catch { /* Preserve the external-commit uncertainty. */ }
      throw uncertainCompletionError();
    }
  } catch (error) {
    try {
      if (providerAttempted) {
        state.markOperationUncertain(handle, {
          errorCode: errorCode(error, 'GITHUB_EXTERNAL_OUTCOME_UNCERTAIN'),
          errorMessage: 'The GitHub request began, so its external outcome is uncertain and automatic replay is blocked.'
        });
      } else {
        state.failOperation(handle, {
          errorCode: errorCode(error, 'GITHUB_PRE_REQUEST_FAILED'),
          errorMessage: 'The GitHub request did not begin; a retry may be safe after the error is corrected.',
          retryAtMs: Number(d.now())
        });
      }
    } catch { /* Preserve the original error over a best-effort state transition. */ }
    throw error;
  }

  // The provider mutation is durably complete, so an audit failure must not mark
  // its external outcome uncertain. It must still reach the caller rather than
  // turning an unrecorded operation into a definite successful answer.
  d.record(action, subject(result), details(result));
  return { ...result, replayed: false };
}

async function repoGet({ owner, repo }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.repo_get', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  const output = untrusted(repositoryRecord(await api(target.path, githubToken(d), d)));
  d.record('github.repo_get', `${target.owner}/${target.repo}`, {});
  return output;
}

async function issueList({ owner, repo, state = 'open', sort = 'created', direction = 'desc', limit = 20 }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.issue_list', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  if (!['open', 'closed', 'all'].includes(state)) throw new TypeError('state must be open, closed, or all.');
  if (!['created', 'updated', 'comments'].includes(sort)) throw new TypeError('sort must be created, updated, or comments.');
  if (!['asc', 'desc'].includes(direction)) throw new TypeError('direction must be asc or desc.');
  const requested = boundedInteger(limit, 'limit', 20, 1, 20);
  const query = new URLSearchParams({ state, sort, direction, per_page: String(requested) });
  const raw = apiArray(await api(`${target.path}/issues?${query}`, githubToken(d), d), 'issue list');
  const issues = raw.map(item => issueRecord(item)).filter(item => !item.isPullRequest).slice(0, requested);
  d.record('github.issue_list', `${target.owner}/${target.repo}`, { state, sort, direction, resultCount: issues.length });
  return { issues, count: issues.length, ...UNTRUSTED_CONTENT };
}

async function issueGet({ owner, repo, issueNumber }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.issue_get', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  const number = positiveInteger(issueNumber, 'issueNumber');
  const output = untrusted(issueRecord(await api(`${target.path}/issues/${number}`, githubToken(d), d), { includeBody: true }));
  d.record('github.issue_get', `${target.owner}/${target.repo}#${number}`, { isPullRequest: output.isPullRequest });
  return output;
}

async function issueCreate({ owner, repo, title, body = '', labels: rawLabels = [], assignees: rawAssignees = [], idempotencyKey: rawKey }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.issue_create', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  const key = idempotencyKey(rawKey);
  const input = {
    owner: target.owner, repo: target.repo,
    title: requiredString(title, 'title', 500, { forbidNewlines: true }),
    body: optionalString(body, 'body', 65_536),
    labels: arrayOfText(rawLabels, 'labels', { maximumItems: 20, maximumLength: 100 }),
    assignees: arrayOfText(rawAssignees, 'assignees', { maximumItems: 10, maximumLength: 39, pattern: LOGIN })
  };
  return mutate({
    operationType: 'github.issue_create', key, input, action: 'github.issue_create',
    subject: result => `${target.owner}/${target.repo}#${result.issueNumber}`,
    details: result => ({ titleLength: input.title.length, bodyLength: input.body.length, labelCount: input.labels.length, assigneeCount: input.assignees.length, issueNumber: result.issueNumber }),
    execute: async () => untrusted(issueRecord(await api(`${target.path}/issues`, githubToken(d), d, {
      method: 'POST', retries: 0, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels, assignees: input.assignees })
    }), { includeBody: true }))
  }, d);
}

async function issueCommentCreate({ owner, repo, issueNumber, body, idempotencyKey: rawKey }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.issue_comment_create', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  const key = idempotencyKey(rawKey);
  const input = {
    owner: target.owner, repo: target.repo, issueNumber: positiveInteger(issueNumber, 'issueNumber'),
    body: requiredString(body, 'body', 65_536)
  };
  return mutate({
    operationType: 'github.issue_comment_create', key, input, action: 'github.issue_comment_create',
    subject: result => `${target.owner}/${target.repo}#${input.issueNumber}:comment:${result.id}`,
    details: result => ({ issueNumber: input.issueNumber, commentId: result.id, bodyLength: input.body.length }),
    execute: async () => untrusted(commentRecord(await api(`${target.path}/issues/${input.issueNumber}/comments`, githubToken(d), d, {
      method: 'POST', retries: 0, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: input.body })
    })))
  }, d);
}

async function pullRequestList({ owner, repo, state = 'open', sort = 'created', direction = 'desc', limit = 20 }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.pull_request_list', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  if (!['open', 'closed', 'all'].includes(state)) throw new TypeError('state must be open, closed, or all.');
  if (!['created', 'updated', 'popularity', 'long-running'].includes(sort)) throw new TypeError('sort is invalid.');
  if (!['asc', 'desc'].includes(direction)) throw new TypeError('direction must be asc or desc.');
  const requested = boundedInteger(limit, 'limit', 20, 1, 20);
  const query = new URLSearchParams({ state, sort, direction, per_page: String(requested) });
  const pullRequests = apiArray(await api(`${target.path}/pulls?${query}`, githubToken(d), d), 'pull-request list')
    .map(item => pullRequestRecord(item)).slice(0, requested);
  d.record('github.pull_request_list', `${target.owner}/${target.repo}`, { state, sort, direction, resultCount: pullRequests.length });
  return { pullRequests, count: pullRequests.length, ...UNTRUSTED_CONTENT };
}

async function pullRequestGet({ owner, repo, pullNumber }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.pull_request_get', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  const number = positiveInteger(pullNumber, 'pullNumber');
  const output = untrusted(pullRequestRecord(await api(`${target.path}/pulls/${number}`, githubToken(d), d), { includeBody: true }));
  d.record('github.pull_request_get', `${target.owner}/${target.repo}!${number}`, {});
  return output;
}

async function pullRequestCreate({ owner, repo, title, head, base, body = '', draft = false, maintainerCanModify = true, idempotencyKey: rawKey }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.pull_request_create', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  if (typeof draft !== 'boolean' || typeof maintainerCanModify !== 'boolean') throw new TypeError('draft and maintainerCanModify must be booleans.');
  const key = idempotencyKey(rawKey);
  const input = {
    owner: target.owner, repo: target.repo,
    title: requiredString(title, 'title', 500, { forbidNewlines: true }),
    head: requiredString(head, 'head', 300, { forbidNewlines: true }),
    base: requiredString(base, 'base', 300, { forbidNewlines: true }),
    body: optionalString(body, 'body', 65_536), draft, maintainerCanModify
  };
  return mutate({
    operationType: 'github.pull_request_create', key, input, action: 'github.pull_request_create',
    subject: result => `${target.owner}/${target.repo}!${result.pullNumber}`,
    details: result => ({ pullNumber: result.pullNumber, titleLength: input.title.length, bodyLength: input.body.length, draft }),
    execute: async () => untrusted(pullRequestRecord(await api(`${target.path}/pulls`, githubToken(d), d, {
      method: 'POST', retries: 0, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: input.title, head: input.head, base: input.base, body: input.body, draft, maintainer_can_modify: maintainerCanModify })
    }), { includeBody: true }))
  }, d);
}

async function releaseList({ owner, repo, limit = 20 }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.release_list', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  const requested = boundedInteger(limit, 'limit', 20, 1, 20);
  const releases = apiArray(await api(`${target.path}/releases?${new URLSearchParams({ per_page: String(requested) })}`, githubToken(d), d), 'release list')
    .map(item => releaseRecord(item)).slice(0, requested);
  d.record('github.release_list', `${target.owner}/${target.repo}`, { resultCount: releases.length });
  return { releases, count: releases.length, ...UNTRUSTED_CONTENT };
}

async function releaseCreate({ owner, repo, tagName, targetCommitish = '', name = '', body = '', draft = false, prerelease = false, generateReleaseNotes = false, idempotencyKey: rawKey }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.release_create', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  if (typeof draft !== 'boolean' || typeof prerelease !== 'boolean' || typeof generateReleaseNotes !== 'boolean') {
    throw new TypeError('draft, prerelease, and generateReleaseNotes must be booleans.');
  }
  const key = idempotencyKey(rawKey);
  const input = {
    owner: target.owner, repo: target.repo,
    tagName: requiredString(tagName, 'tagName', 300, { forbidNewlines: true }),
    targetCommitish: optionalString(targetCommitish, 'targetCommitish', 300, { forbidNewlines: true }),
    name: optionalString(name, 'name', 500, { forbidNewlines: true }),
    body: optionalString(body, 'body', 65_536), draft, prerelease, generateReleaseNotes
  };
  return mutate({
    operationType: 'github.release_create', key, input, action: 'github.release_create',
    subject: result => `${target.owner}/${target.repo}@${result.tagName}`,
    details: result => ({ releaseId: result.id, tagName: result.tagName, nameLength: input.name.length, bodyLength: input.body.length, draft, prerelease }),
    execute: async () => untrusted(releaseRecord(await api(`${target.path}/releases`, githubToken(d), d, {
      method: 'POST', retries: 0, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: input.tagName,
        target_commitish: input.targetCommitish || undefined,
        name: input.name || undefined,
        body: input.body || undefined,
        draft, prerelease, generate_release_notes: generateReleaseNotes
      })
    })))
  }, d);
}

async function repositoryDispatch({ owner, repo, eventType, clientPayload = {}, idempotencyKey: rawKey }, overrides = {}) {
  const d = dependencies(overrides);
  d.assertActive('github.repository_dispatch', { provider: 'github' });
  const target = repositoryPath(owner, repo);
  const key = idempotencyKey(rawKey);
  const input = {
    owner: target.owner, repo: target.repo,
    eventType: requiredString(eventType, 'eventType', 100, { pattern: EVENT_TYPE, forbidNewlines: true }),
    clientPayload: dispatchPayload(clientPayload)
  };
  return mutate({
    operationType: 'github.repository_dispatch', key, input, action: 'github.repository_dispatch',
    subject: () => `${target.owner}/${target.repo}:${input.eventType}`,
    details: () => ({ eventType: input.eventType, payloadKeys: Object.keys(input.clientPayload) }),
    execute: async () => {
      await api(`${target.path}/dispatches`, githubToken(d), d, {
        method: 'POST', retries: 0, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event_type: input.eventType, client_payload: input.clientPayload })
      });
      return { repository: `${target.owner}/${target.repo}`, eventType: input.eventType, dispatched: true, ...UNTRUSTED_CONTENT };
    }
  }, d);
}

module.exports = {
  API_ROOT,
  API_VERSION,
  OPERATION_LEASE_MS,
  UNTRUSTED_CONTENT,
  dispatchPayload,
  issueCommentCreate,
  issueCreate,
  issueGet,
  issueList,
  pullRequestCreate,
  pullRequestGet,
  pullRequestList,
  releaseCreate,
  releaseList,
  repoGet,
  repositoryDispatch
};

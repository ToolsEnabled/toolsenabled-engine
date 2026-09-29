'use strict';

// Detection and a small `policy.local` client for running INSIDE a person's
// own OpenShell sandbox. Everything here uses only documented interfaces:
// the `OPENSHELL_SANDBOX` marker (the one marker the workload reliably sees
// in OpenShell 0.1.2 -- the supervisor deliberately withholds the endpoint,
// token and sandbox id) and the `policy.local` agent API
// (https://docs.nvidia.com/openshell/latest/how-it-works/policies/advisor, "Agent API"). This module never talks to the OpenShell gateway itself and
// holds no gateway credential of any kind -- it cannot, because the workload
// is never given one.

const DEFAULT_BASE_URL = 'http://policy.local';
const DEFAULT_TIMEOUT_MS = 5_000;
const SANDBOX_MARKER = 'OPENSHELL_SANDBOX';

/**
 * Reads the one marker the workload was seen to receive reliably. Returns
 * a frozen record (not a bare boolean) so a setup check can show the raw
 * value when it is present but not "1" -- that is more useful than a plain
 * "not detected" for whoever is debugging their own sandbox.
 */
function describeSandboxDetection(env = process.env) {
  const present = Object.prototype.hasOwnProperty.call(env, SANDBOX_MARKER);
  const rawValue = present ? env[SANDBOX_MARKER] : null;
  return Object.freeze({
    insideSandbox: rawValue === '1',
    marker: SANDBOX_MARKER,
    rawValue
  });
}

function isInsideOpenShellSandbox(env = process.env) {
  return describeSandboxDetection(env).insideSandbox;
}

/**
 * A `policy.local` route answered outside its documented contract. `code`
 * distinguishes the cases a caller actually needs to act on differently:
 *   ADVISOR_DISABLED    -- 404 feature_disabled (advisor off for this sandbox)
 *   ADVISOR_TIMEOUT      -- no answer inside the given timeout
 *   ADVISOR_UNREACHABLE  -- fetch itself failed (DNS, connection refused, ...)
 *   ADVISOR_HTTP_ERROR   -- any other non-2xx status
 *   ADVISOR_BAD_RESPONSE -- a 2xx body that did not parse as declared
 */
class PolicyAdvisorError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PolicyAdvisorError';
    this.code = code;
    Object.assign(this, extra);
  }
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new PolicyAdvisorError('ADVISOR_TIMEOUT', `Timed out after ${timeoutMs}ms waiting for ${url}`, { url, timeoutMs });
    }
    throw new PolicyAdvisorError('ADVISOR_UNREACHABLE', `Could not reach ${url}: ${error && error.message}`, { url, cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A thin, timeout-bound client for the five documented `policy.local` routes.
 * Everything is read-only except `submitProposals`, and even that never
 * changes the policy by itself -- a proposal only queues for the person (or
 * automatic approval) to decide, per advisor.mdx. This client never
 * approves or rejects a proposal: from inside a sandbox that route does not
 * exist (advisor.mdx, "Agent cannot approve itself" -- confirmed live in the
 * checked live on OpenShell 0.1.2: every approve route answers 404 from inside).
 */
class PolicyLocalClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('PolicyLocalClient requires a fetch implementation (global fetch is unavailable in this runtime)');
    }
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async _request(path, init, { timeoutMs = this.timeoutMs } = {}) {
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}${path}`, init, timeoutMs);
    const text = await response.text();
    if (response.status === 404) {
      throw new PolicyAdvisorError(
        'ADVISOR_DISABLED',
        'The policy advisor is off for this sandbox (policy.local answered 404 feature_disabled). ' +
          'Ask the person to run: openshell settings set <sandbox-name> --key agent_policy_proposals_enabled --value true',
        { status: 404, body: text }
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PolicyAdvisorError('ADVISOR_HTTP_ERROR', `policy.local answered ${response.status}: ${text.slice(0, 500)}`, {
        status: response.status,
        body: text
      });
    }
    if (text === '') return null;
    const contentType = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') : null;
    if (contentType && contentType.includes('json')) {
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new PolicyAdvisorError('ADVISOR_BAD_RESPONSE', `policy.local returned invalid JSON: ${error.message}`, { body: text });
      }
    }
    // /v1/policy/current is documented as returning YAML, not JSON.
    return text;
  }

  /**
   * GET /v1/policy/current -- the sandbox's effective policy, as YAML text.
   *
   * advisor.mdx documents this route as returning YAML directly, but the
   * gateway (OpenShell v0.1.2, checked live on 2026-09-28) actually
   * answers with a JSON envelope, `{"format":"yaml","policy_yaml":"<yaml>"}`.
   * This method accepts either shape and always resolves to the plain YAML
   * string, so every other caller in this file (and the setup check) never
   * has to know which server shape it is talking to. A response matching
   * neither shape raises ADVISOR_BAD_RESPONSE rather than handing back
   * something that silently is not a string.
   */
  async getCurrentPolicy(options) {
    const body = await this._request('/v1/policy/current', { method: 'GET' }, options);
    if (typeof body === 'string') return body;
    if (body && typeof body.policy_yaml === 'string') return body.policy_yaml;
    throw new PolicyAdvisorError(
      'ADVISOR_BAD_RESPONSE',
      'policy.local answered /v1/policy/current with neither YAML text nor a {policy_yaml} envelope.',
      { body }
    );
  }

  /**
   * GET /v1/denials?last=N -- recent denials as log lines, newest first.
   * advisor.mdx does not pin down the exact JSON shape; the private test
   * gateway (v0.1.2, live-probed 2026-09-28) answers
   * `{"denials": [...line strings...], "log_available": true}`. This method
   * returns that parsed body as-is (unlike `getCurrentPolicy`, there is no
   * single well-known field to unwrap here) -- pass each string in
   * `.denials` to `openshell-denial-explainer.js`'s `parseDenialLine`.
   */
  getDenials({ last = 10, ...options } = {}) {
    const count = Math.min(Math.max(1, Number(last) || 10), 100);
    return this._request(`/v1/denials?last=${count}`, { method: 'GET' }, options);
  }

  /** POST /v1/proposals -- submit one or more proposed rule additions. */
  submitProposals(body, options) {
    return this._request(
      '/v1/proposals',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      options
    );
  }

  /** GET /v1/proposals/{id} -- pending | approved | rejected. */
  getProposal(chunkId, options) {
    return this._request(`/v1/proposals/${encodeURIComponent(chunkId)}`, { method: 'GET' }, options);
  }

  /**
   * GET /v1/proposals/{id}/wait?timeout=N -- blocks until a decision or the
   * server-side timeout. The client's own request timeout is given a buffer
   * over the server-side wait so a slow-but-answering server is not mistaken
   * for an unreachable one.
   */
  waitForProposal(chunkId, { timeoutSec = 60, timeoutMs, ...options } = {}) {
    const boundSec = Math.max(1, Math.floor(timeoutSec));
    return this._request(
      `/v1/proposals/${encodeURIComponent(chunkId)}/wait?timeout=${boundSec}`,
      { method: 'GET' },
      { timeoutMs: timeoutMs || boundSec * 1000 + 5_000, ...options }
    );
  }
}

// ---------------------------------------------------------------------------
// A deliberately narrow scan of the effective policy's YAML for exactly one
// thing: the top-level rule-name keys under `network_policies:`. This is NOT
// a YAML parser -- this engine has no YAML dependency (checked: no `yaml` or
// `js-yaml` in package.json) and this scan is not worth adding one for a first
// slice. A rule name is a line indented by exactly two spaces, ending in
// `:`, directly under the `network_policies:` line (or under a less-indented
// continuation of it); anything more deeply indented (an endpoint's own
// `host:`/`path:` fields, list items, etc.) is not a rule name and is
// skipped. A policy this scan cannot make sense of yields an empty list
// rather than a guess.
// ---------------------------------------------------------------------------

function listNetworkPolicyRuleNames(policyYamlText) {
  if (typeof policyYamlText !== 'string' || policyYamlText === '') return [];
  const lines = policyYamlText.split(/\r?\n/);
  const sectionIndex = lines.findIndex(line => /^network_policies:\s*$/.test(line));
  if (sectionIndex === -1) return [];
  const names = [];
  for (let i = sectionIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const topLevelMatch = /^\S/.exec(line);
    if (topLevelMatch) break; // dedented back to a sibling top-level section
    const ruleMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (ruleMatch) {
      names.push(ruleMatch[1]);
    }
  }
  return names;
}

/**
 * Provider policy entries use reserved `_provider_<name>` keys, with dashes
 * in the provider instance name turned into underscores (profiles.mdx,
 * "Policy Composition" -- a provider named `work-github` contributes
 * `_provider_work_github`). Returns true if a rule with that composed name
 * exists in the effective policy's `network_policies` section.
 */
function hasProviderRule(policyYamlText, providerInstanceName) {
  if (typeof providerInstanceName !== 'string' || providerInstanceName === '') return false;
  const composedName = `_provider_${providerInstanceName.replace(/-/g, '_')}`;
  return listNetworkPolicyRuleNames(policyYamlText).includes(composedName);
}

/**
 * A weaker fallback than `hasProviderRule`: true if the host string appears
 * anywhere in the policy's `network_policies` section, so a plain
 * user-authored rule (not a provider layer) that already covers the host
 * still counts as "there is a rule," not "missing."
 */
function policyMentionsHostForProvider(policyYamlText, host) {
  if (typeof policyYamlText !== 'string' || typeof host !== 'string' || host === '') return false;
  const lines = policyYamlText.split(/\r?\n/);
  const sectionIndex = lines.findIndex(line => /^network_policies:\s*$/.test(line));
  if (sectionIndex === -1) return false;
  // An endpoint's `host:` field is usually a YAML sequence item (`- host: x`),
  // so strip one optional leading "- " before comparing the trimmed line.
  const needle = `host: ${host}`;
  for (let i = sectionIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const trimmed = line.trim().replace(/^-\s*/, '');
    if (trimmed === needle) return true;
  }
  return false;
}

module.exports = Object.freeze({
  DEFAULT_BASE_URL,
  SANDBOX_MARKER,
  describeSandboxDetection,
  isInsideOpenShellSandbox,
  PolicyAdvisorError,
  PolicyLocalClient,
  listNetworkPolicyRuleNames,
  hasProviderRule,
  policyMentionsHostForProvider
});

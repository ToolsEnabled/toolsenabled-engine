'use strict';

// Compliance-first research acquisition adapters. The public MCP surface
// deliberately returns search snippets or evidence metadata only; page bodies
// remain in the local evidence store for the later extraction phase.

const crypto = require('node:crypto');
const http = require('node:http');
const { Readable, Transform } = require('node:stream');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { ensureDir, getSecret, rootPath } = require('../runtime');
const { assertActive, loadPolicy } = require('../policy');
const ssrf = require('../ssrf-guard');
const { getStateStore } = require('../state-store');
const { safeLaunchEnvironment } = require('./subscription-launch-env');

const TAVILY_URL = 'https://api.tavily.com/search';
const TAVILY_VAULT_KEY = 'tavily_api_key';
// Provenance allowlist. Every SearXNG result must name at least one engine from
// this set, so a misconfigured or tampered instance cannot smuggle in results
// from a provider whose terms disallow automated access (notably Google/Bing).
//
// This MUST stay in sync with research/searxng/settings.yml `keep_only`. Before
// 2026-07-24 it listed only the four scholarly engines while the instance was
// also serving general-web engines, so every general query threw
// WEB_SEARXNG_ENGINE_FORBIDDEN — and lookup() swallowed it, making the whole
// research system return zero evidence with no visible error.
const SEARXNG_ENGINES = Object.freeze([
  // general web discovery
  'duckduckgo', 'brave', 'mojeek', 'startpage', 'qwant', 'marginalia', 'mwmbl',
  // reference
  'wikipedia', 'wikidata',
  // technical / developer
  'github', 'stackoverflow', 'hackernews', 'mdn',
  // scholarly
  'arxiv', 'crossref', 'openalex', 'pubmed', 'semantic scholar'
]);
const USER_AGENT = 'ToolsEnabledResearch/1.0';
const MAX_QUERY_CHARS = 500;
const MAX_SEARCH_RESULTS = 10;
const MAX_LOOKUP_EXTRACT_CHARS = 2000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const HOST_INTERVAL_MS = 5_000;
const GLOBAL_CONCURRENCY = 4;
const SEARCH_RETRIES = 2;
const EVIDENCE_DB_PATH = process.env.TOOLSENABLED_RESEARCH_DB || rootPath('state', 'research-evidence.sqlite');
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

function classifyQueryIntent(query) {
  if (typeof query !== 'string') return 'general';
  const q = query.toLowerCase();
  if (/\b(price|pricing|cost|subscription|plan|buy|tier|usd|dollar|fee|billing)\b/.test(q)) return 'commercial/pricing';
  if (/\b(api|docs|reference|error|sdk|npm|github|guide|install|version|bug)\b/.test(q)) return 'technical-docs';
  if (/\b(paper|arxiv|doi|journal|study|research|author|citation|abstract)\b/.test(q)) return 'scholarly';
  if (/\b(news|release|today|announced|latest|update|vulnerability|cve)\b/.test(q)) return 'news/current';
  return 'general';
}

let evidenceDb = null;

function webError(code, message) {
  const error = new Error(message);
  error.name = 'WebProviderError';
  error.code = code;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedText(value, label, maximum, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
    throw webError('WEB_INPUT_INVALID', `${label} must be ${required ? 'a non-empty ' : 'a '}string of at most ${maximum} characters without control characters.`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw webError('WEB_INPUT_INVALID', `${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function safeUrl(value, { allowHttp = false } = {}) {
  let url;
  try { url = value instanceof URL ? new URL(value.toString()) : new URL(String(value)); }
  catch { throw webError('WEB_URL_INVALID', 'url must be a valid HTTP or HTTPS URL.'); }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw webError('WEB_HTTPS_REQUIRED', 'url must use HTTPS unless the local research policy explicitly permits HTTP.');
  }
  if (url.username || url.password) throw webError('WEB_URL_CREDENTIALS_FORBIDDEN', 'url must not contain embedded credentials.');
  const defaultPort = url.protocol === 'http:' ? '80' : '443';
  if (url.port && url.port !== defaultPort) throw webError('WEB_PORT_FORBIDDEN', 'url may use only its default protocol port.');
  return url;
}

function hostKey(url) {
  return `${url.protocol}//${ssrf.normalizedHostname(url.hostname)}:${url.port || (url.protocol === 'http:' ? '80' : '443')}`;
}

function searchInput(value = {}) {
  if (!plainObject(value)) throw webError('WEB_INPUT_INVALID', 'web.search input must be an object.');
  const allowed = new Set(['query', 'provider', 'maxResults', 'topic', 'searchDepth', 'purpose']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw webError('WEB_INPUT_INVALID', `web.search does not support '${key}'.`);
  }
  const query = boundedText(value.query, 'query', MAX_QUERY_CHARS, { required: true }).trim();
  if (/(?:^|\s)!!(?:\s|$)/.test(query)) {
    throw webError('WEB_QUERY_SYNTAX_FORBIDDEN', 'web.search does not accept SearXNG external-bang syntax.');
  }
  const provider = value.provider === undefined ? undefined : boundedText(value.provider, 'provider', 20, { required: true });
  if (provider !== undefined && !['tavily', 'searxng'].includes(provider)) {
    throw webError('WEB_INPUT_INVALID', 'provider must be tavily or searxng.');
  }
  const topic = value.topic === undefined ? 'general' : boundedText(value.topic, 'topic', 20, { required: true });
  if (!['general', 'news', 'finance'].includes(topic)) throw webError('WEB_INPUT_INVALID', 'topic must be general, news, or finance.');
  const searchDepth = value.searchDepth === undefined ? 'basic' : boundedText(value.searchDepth, 'searchDepth', 20, { required: true });
  if (!['basic', 'advanced', 'fast', 'ultra-fast'].includes(searchDepth)) {
    throw webError('WEB_INPUT_INVALID', 'searchDepth must be basic, advanced, fast, or ultra-fast.');
  }
  const purpose = value.purpose === undefined ? 'routine' : value.purpose;
  if (!['routine', 'research'].includes(purpose)) {
    throw webError('WEB_INPUT_INVALID', "purpose must be 'routine' or 'research'.");
  }
  return {
    query, provider, topic, searchDepth, purpose,
    maxResults: boundedInteger(value.maxResults, 'maxResults', 1, MAX_SEARCH_RESULTS, 5)
  };
}

function lookupInput(value = {}) {
  if (!plainObject(value)) throw webError('WEB_INPUT_INVALID', 'web.lookup input must be an object.');
  const allowed = new Set(['query', 'freshness', 'preferred_domains', 'max_sources']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw webError('WEB_INPUT_INVALID', `web.lookup does not support '${key}'.`);
  }
  const query = boundedText(value.query, 'query', MAX_QUERY_CHARS, { required: true }).trim();
  const freshness = boundedText(value.freshness, 'freshness', 10);
  let freshnessMs;
  if (freshness) {
    const duration = /^([1-9][0-9]*)([hdwmy])$/.exec(freshness);
    const units = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000, y: 31536000000 };
    freshnessMs = duration && Number(duration[1]) * units[duration[2]];
    if (!Number.isSafeInteger(freshnessMs) || freshnessMs > 10 * units.y) {
      throw webError('WEB_INPUT_INVALID', 'freshness must be a positive duration such as 7d, using h/d/w/m/y, at most ten years.');
    }
  }
  const domains = value.preferred_domains === undefined ? [] : value.preferred_domains;
  if (!Array.isArray(domains) || domains.length > 10) {
    throw webError('WEB_INPUT_INVALID', 'preferred_domains must contain at most ten domain names.');
  }
  const preferredDomains = [...new Set(domains.map(value => {
    const domain = boundedText(value, 'preferred_domains entry', 255, { required: true }).trim().toLowerCase().replace(/\.$/, '');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
      throw webError('WEB_INPUT_INVALID', 'preferred_domains entries must be domain names without URLs, paths, ports or search syntax.');
    }
    return domain;
  }))];
  const maxSources = boundedInteger(value.max_sources, 'max_sources', 1, 10, 5);
  return { query, freshnessMs, preferredDomains, max_sources: maxSources };
}

function fetchInput(value = {}) {
  if (!plainObject(value)) throw webError('WEB_INPUT_INVALID', 'web.fetch input must be an object.');
  if (Object.keys(value).some(key => key !== 'url')) throw webError('WEB_INPUT_INVALID', 'web.fetch accepts only url.');
  return { url: boundedText(value.url, 'url', 4096, { required: true }) };
}

function positivePolicyInteger(value, label, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw webError('WEB_POLICY_INVALID', `${label} must be an integer from 0 through ${maximum}.`);
  }
  return value;
}

function researchConfiguration(source = {}) {
  const research = source === undefined ? {} : source;
  if (!plainObject(research)) throw webError('WEB_POLICY_INVALID', 'research policy must be an object.');
  for (const key of Object.keys(research)) {
    // 'tavily' belongs here: this function validates research.tavily below and
    // returns a tavily block. Omitting it from this allowlist made every research
    // call throw WEB_POLICY_INVALID against the shipped policy file.
    if (!['search', 'fetch', 'tavily'].includes(key)) throw webError('WEB_POLICY_INVALID', `research policy has an unsupported property '${key}'.`);
  }
  const search = research.search === undefined ? {} : research.search;
  const fetch = research.fetch === undefined ? {} : research.fetch;
  if (!plainObject(search) || !plainObject(fetch)) throw webError('WEB_POLICY_INVALID', 'research search and fetch policy must be objects.');
  const tavily = research.tavily === undefined ? {} : research.tavily;
  if (!plainObject(tavily)) throw webError('WEB_POLICY_INVALID', 'research.tavily policy must be an object.');
  for (const key of Object.keys(search)) {
    if (!['provider', 'searxngUrl'].includes(key)) throw webError('WEB_POLICY_INVALID', `research.search has an unsupported property '${key}'.`);
  }
  for (const key of Object.keys(fetch)) {
    if (!['allowHttp', 'robotsTtlMs', 'hostIntervalMs', 'globalConcurrency', 'maxResponseBytes', 'maxRedirects', 'timeoutMs'].includes(key)) {
      throw webError('WEB_POLICY_INVALID', `research.fetch has an unsupported property '${key}'.`);
    }
  }
  for (const key of Object.keys(tavily)) {
    if (!['routineMonthlyPool', 'researchMonthlyPool', 'applicationHardStop'].includes(key)) {
      throw webError('WEB_POLICY_INVALID', `research.tavily has an unsupported property '${key}'.`);
    }
  }
  const provider = search.provider === undefined ? 'tavily' : search.provider;
  if (!['tavily', 'searxng'].includes(provider)) throw webError('WEB_POLICY_INVALID', 'research.search.provider must be tavily or searxng.');
  const searxngUrl = search.searxngUrl;
  if (provider === 'searxng' && searxngUrl === undefined) {
    throw webError('WEB_POLICY_INVALID', 'research.search.searxngUrl is required when the SearXNG provider is selected.');
  }
  let parsedSearxng = null;
  try { parsedSearxng = searxngUrl === undefined ? null : new URL(searxngUrl); }
  catch { throw webError('WEB_POLICY_INVALID', 'research.search.searxngUrl must be a valid loopback URL.'); }
  if (parsedSearxng && (parsedSearxng.protocol !== 'http:' || parsedSearxng.hostname !== '127.0.0.1'
    || parsedSearxng.pathname !== '/search' || parsedSearxng.search || parsedSearxng.hash || parsedSearxng.username || parsedSearxng.password)) {
    throw webError('WEB_POLICY_INVALID', 'research.search.searxngUrl must be a loopback SearXNG /search endpoint.');
  }
  if (fetch.allowHttp !== undefined && typeof fetch.allowHttp !== 'boolean') {
    throw webError('WEB_POLICY_INVALID', 'research.fetch.allowHttp must be a boolean.');
  }
  return Object.freeze({
    search: Object.freeze({ provider, searxngUrl: parsedSearxng ? parsedSearxng.toString() : null }),
    fetch: Object.freeze({
      allowHttp: fetch.allowHttp === true,
      robotsTtlMs: positivePolicyInteger(fetch.robotsTtlMs, 'research.fetch.robotsTtlMs', ROBOTS_TTL_MS, ROBOTS_TTL_MS),
      hostIntervalMs: positivePolicyInteger(fetch.hostIntervalMs, 'research.fetch.hostIntervalMs', HOST_INTERVAL_MS, 60_000),
      globalConcurrency: positivePolicyInteger(fetch.globalConcurrency, 'research.fetch.globalConcurrency', GLOBAL_CONCURRENCY, GLOBAL_CONCURRENCY) || 1,
      maxResponseBytes: positivePolicyInteger(fetch.maxResponseBytes, 'research.fetch.maxResponseBytes', MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES) || 1,
      maxRedirects: positivePolicyInteger(fetch.maxRedirects, 'research.fetch.maxRedirects', MAX_REDIRECTS, MAX_REDIRECTS),
      timeoutMs: positivePolicyInteger(fetch.timeoutMs, 'research.fetch.timeoutMs', MAX_TIMEOUT_MS, MAX_TIMEOUT_MS) || 1
    }),
    tavily: Object.freeze({
      routineMonthlyPool: positivePolicyInteger(tavily.routineMonthlyPool, 'research.tavily.routineMonthlyPool', 700, 10000),
      researchMonthlyPool: positivePolicyInteger(tavily.researchMonthlyPool, 'research.tavily.researchMonthlyPool', 200, 10000),
      applicationHardStop: positivePolicyInteger(tavily.applicationHardStop, 'research.tavily.applicationHardStop', 900, 10000)
    })
  });
}

function currentConfiguration(dependencies) {
  if (dependencies.config !== undefined) return researchConfiguration(dependencies.config);
  const policy = dependencies.policy || loadPolicy();
  return researchConfiguration(policy && policy.research);
}

function responseStream(response) {
  if (response && response.stream && typeof response.stream.pipe === 'function') return response.stream;
  if (response && response.stream && typeof response.stream[Symbol.asyncIterator] === 'function') return Readable.from(response.stream);
  if (!response || response.body === undefined || response.body === null) return Readable.from([]);
  if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) return Readable.from([response.body]);
  throw webError('WEB_RESPONSE_INVALID', 'The web transport returned an invalid response body.');
}

function boundedStream(source, maximum, code) {
  let bytes = 0;
  const guard = new Transform({
    transform(chunk, encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      bytes += value.length;
      if (bytes > maximum) return callback(webError(code, 'The web response exceeded its byte limit.'));
      return callback(null, value);
    }
  });
  source.pipe(guard);
  return guard;
}

function decodedStream(source, headers = {}) {
  const encoding = String(headers['content-encoding'] || '').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return source;
  if (encoding === 'gzip' || encoding === 'x-gzip') return source.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return source.pipe(zlib.createInflate());
  if (encoding === 'br') return source.pipe(zlib.createBrotliDecompress());
  throw webError('WEB_CONTENT_ENCODING_UNSUPPORTED', 'The web response uses an unsupported content encoding.');
}

function destroy(value) {
  try {
    if (value && typeof value.destroy === 'function') value.destroy();
    else if (value && typeof value.resume === 'function') value.resume();
  } catch { /* A discarded response must not replace the policy outcome. */ }
}

function discard(response) {
  destroy(response && response.stream);
}

async function readBounded(response, maximum, timeoutMs) {
  const advertised = Number(response && response.headers && response.headers['content-length']);
  if (Number.isFinite(advertised) && advertised > maximum && !response.headers['content-encoding']) {
    discard(response);
    throw webError('WEB_BYTE_CAP', 'The web response exceeded its byte limit.');
  }
  const source = responseStream(response);
  // Cap the wire body as well as decoded output. The shared code keeps the
  // public error deterministic while enforcing the decompression-bomb guard.
  const compressed = boundedStream(source, maximum, 'WEB_BYTE_CAP');
  const decoded = decodedStream(compressed, response && response.headers || {});
  const chunks = [];
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    destroy(decoded);
    destroy(compressed);
    destroy(source);
  }, Math.max(1, timeoutMs));
  try {
    for await (const value of decoded) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (bytes + chunk.length > maximum) {
        destroy(decoded);
        destroy(compressed);
        destroy(source);
        throw webError('WEB_BYTE_CAP', 'The web response exceeded its byte limit.');
      }
      chunks.push(chunk);
      bytes += chunk.length;
    }
  } catch (error) {
    if (timedOut) throw webError('WEB_TIMEOUT', 'The web response timed out.');
    if (error && /^WEB_/.test(error.code || '')) throw error;
    throw webError('WEB_RESPONSE_DECODE_FAILED', 'The web response could not be decoded.');
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks, bytes);
}

function remaining(deadline, label) {
  const value = deadline - Date.now();
  if (value < 1) throw webError('WEB_TIMEOUT', `${label} timed out.`);
  return value;
}

function withinDeadline(promise, deadline, label, onTimeout = () => undefined) {
  const timeoutMs = Math.max(0, deadline - Date.now());
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => {
      try { onTimeout(); } catch { /* Timeout cleanup must not replace the bounded outcome. */ }
      finish(webError('WEB_TIMEOUT', `${label} timed out.`));
    }, timeoutMs);
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}

function contentType(headers = {}) {
  return String(headers['content-type'] || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase() || 'application/octet-stream';
}

function compactResult(value, provider) {
  if (!plainObject(value)) return null;
  let url;
  try {
    url = new URL(String(value.url || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  } catch { return null; }
  const title = String(value.title || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500);
  const snippetSource = value.content === undefined ? value.snippet : value.content;
  const snippet = String(snippetSource || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 2000);
  const result = { url: url.toString(), title, snippet, provider };
  if (Number.isFinite(value.score)) result.score = Math.round(Number(value.score) * 100000) / 100000;
  return result;
}

function compactSearchResults(source, prepared, provider) {
  const results = [];
  let undated = 0;
  for (const row of source) {
    const result = compactResult(row, provider);
    if (!result) continue;
    if (prepared.preferredDomains?.length) {
      const host = new URL(result.url).hostname.toLowerCase();
      if (!prepared.preferredDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) continue;
    }
    if (prepared.freshnessSinceMs !== undefined) {
      const date = row.publishedDate ?? row.published_date;
      const publishedAtMs = typeof date === 'string' && date.length <= 100 ? Date.parse(date) : NaN;
      if (Number.isFinite(publishedAtMs)) {
        if (publishedAtMs < prepared.freshnessSinceMs || publishedAtMs > prepared.lookupNowMs) continue;
        result.publishedDate = new Date(publishedAtMs).toISOString();
      } else if (provider === 'searxng') {
        // SearXNG forwards time_range only to engines which support it. An
        // undated result cannot prove the requested range was respected.
        undated += 1;
        continue;
      }
      // Tavily applies start_date at the provider and does not promise a date
      // in each result. Keep its filtered results, still marked untrusted.
    }
    results.push(result);
  }
  return {
    results: results.slice(0, prepared.maxResults),
    ...(undated ? { diagnostics: [{ code: 'WEB_FRESHNESS_UNVERIFIED', message: `${undated} undated SearXNG results were omitted because their freshness could not be checked.` }] } : {})
  };
}

function searxngFailureDiagnostics(value) {
  // This is a remote report, not an inventory of configured or queried engines.
  // An absent/empty list does not establish that search coverage was complete.
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return [];
  if (!Array.isArray(value)) {
    return [{ code: 'WEB_SEARXNG_AVAILABILITY_UNVERIFIED', message: 'SearXNG returned malformed engine availability information; search coverage could not be checked.' }];
  }
  const failures = [];
  const seen = new Set();
  let detailsOmitted = value.length > 64;
  for (const row of value.slice(0, 64)) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length > 80) {
      detailsOmitted = true;
      continue;
    }
    const engine = row[0].trim().toLowerCase();
    if (!SEARXNG_ENGINES.includes(engine)) { detailsOmitted = true; continue; }
    if (seen.has(engine)) { detailsOmitted = true; continue; }
    seen.add(engine);
    // Never echo backend exception strings: they may contain secrets, markup or
    // instructions. Only these known labels receive a more specific diagnosis.
    const reason = typeof row[1] === 'string' && row[1].length <= 80 ? row[1].trim().toLowerCase() : '';
    let reasonCode = 'UNAVAILABLE';
    let message = 'SearXNG reported that the engine was unavailable.';
    switch (reason) {
      case 'captcha': reasonCode = 'CAPTCHA'; message = 'The engine reported a CAPTCHA challenge.'; break;
      case 'timeout': reasonCode = 'TIMEOUT'; message = 'The engine did not respond before its timeout.'; break;
      case 'access denied': reasonCode = 'ACCESS_DENIED'; message = 'The engine denied access to search results.'; break;
      case 'too many request':
      case 'too many requests': reasonCode = 'RATE_LIMITED'; message = 'The engine reported a request rate limit.'; break;
      default: detailsOmitted = true;
    }
    if (row.length !== 2) detailsOmitted = true;
    failures.push({ engine, reasonCode, message });
  }
  return [{
    code: 'WEB_SEARXNG_PARTIAL_FAILURE',
    message: 'SearXNG reported unavailable engines; returned search results may be incomplete.',
    failures,
    ...(detailsOmitted ? { detailsOmitted: true } : {})
  }];
}

function parseJson(buffer, label) {
  try { return JSON.parse(Buffer.from(buffer).toString('utf8')); }
  catch { throw webError('WEB_PROVIDER_RESPONSE_INVALID', `${label} returned invalid JSON.`); }
}

function localSearxRequest(url, timeoutMs, dependencies = {}) {
  if (typeof dependencies.searxRequest === 'function') return dependencies.searxRequest(url, timeoutMs);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname, port: url.port || 80, path: `${url.pathname}${url.search}`,
      method: 'GET', headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, agent: false,
      timeout: timeoutMs
    }, response => resolve({
      status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value || '')])),
      stream: response, remoteAddress: response.socket && response.socket.remoteAddress
    }));
    request.on('error', () => reject(webError('WEB_SEARXNG_UNAVAILABLE', 'The local restricted SearXNG service is unavailable.')));
    request.on('timeout', () => request.destroy(webError('WEB_TIMEOUT', 'The local restricted SearXNG service timed out.')));
    request.end();
  });
}

function createRateLimiter({ now = () => Date.now(), sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), intervalMs, concurrency }) {
  const tails = new Map();
  const started = new Map();
  let active = 0;
  const waiters = [];
  async function acquire() {
    if (active < concurrency) { active += 1; return; }
    await new Promise(resolve => waiters.push(resolve));
    active += 1;
  }
  function release() {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  }
  /* A TIMESTAMP OLDER THAN THE INTERVAL CANNOT AFFECT ANYTHING AGAIN.
   *
   * `started` held one entry per host for the life of the process and nothing
   * ever removed it, so an agent that fetched from a thousand origins kept a
   * thousand numbers it could no longer use. The delay is
   * `started + intervalMs - now()`, so once `now()` has passed
   * `started + intervalMs` the entry can only ever produce a delay of zero --
   * which is exactly what a MISSING entry produces, via `|| 0`. Dropping it is
   * therefore not a behaviour change; it is deleting a value whose only
   * possible answer is already the default.
   *
   * Swept on use rather than on a timer: a timer here would be a second thing
   * to shut down, and this map only grows when `run` is called anyway. */
  function sweepStarted() {
    const cutoff = now() - intervalMs;
    for (const [host, at] of started) if (at <= cutoff) started.delete(host);
  }

  function run(host, operation) {
    const previous = tails.get(host) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await acquire();
      try {
        const delay = Math.max(0, (started.get(host) || 0) + intervalMs - now());
        if (delay) await sleep(delay);
        started.set(host, now());
        sweepStarted();
        return await operation();
      } finally {
        release();
      }
    });
    const tail = current.then(() => undefined, () => undefined);
    tails.set(host, tail);
    /* THE SETTLED TAIL WAS KEPT FOREVER TOO, one per host, and a settled
       promise is indistinguishable from the `Promise.resolve()` the lookup
       falls back to -- so holding it bought nothing.
       THE IDENTITY GUARD IS LOAD-BEARING, not tidiness: by the time this
       settles another call may have queued behind it and replaced the entry
       with a NEWER tail. Deleting unconditionally would drop that one, and the
       next call for the same host would then start with Promise.resolve() and
       run CONCURRENTLY with work already in flight -- turning a leak fix into a
       rate-limit breach. Only remove it if it is still the tail we put there. */
    tail.then(() => { if (tails.get(host) === tail) tails.delete(host); });
    return current;
  }
  return {
    run,
    /* Read-only, for the test that pins the growth. Nothing in the product
       reads these; a leak that cannot be observed cannot be regression-tested,
       and this file's whole defect was that nobody could see the maps. */
    sizes: () => ({ tails: tails.size, started: started.size }),
  };
}

async function requestFollowing(initial, configuration, dependencies, limiter, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || configuration.fetch.timeoutMs);
  let url = safeUrl(initial, { allowHttp: configuration.fetch.allowHttp });
  let redirects = 0;
  while (true) {
    const current = url;
    const response = await limiter.run(hostKey(current), async () => {
      // The entry check prevents a request when the action begins. Check again
      // immediately before each network hop so an operator can activate the
      // kill switch while robots, rate limiting, or a redirect is in progress.
      if (typeof options.assertActive === 'function') options.assertActive();
      const target = await ssrf.resolveTarget(current, dependencies, { allowHttp: configuration.fetch.allowHttp });
      return ssrf.requestPinned(target, {
        method: 'GET', headers: { Accept: options.accept || '*/*', 'User-Agent': USER_AGENT }, timeoutMs: remaining(deadline, 'Web request')
      }, dependencies);
    });
    const location = response.headers && response.headers.location;
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      return { response, finalUrl: current, redirects };
    }
    if (redirects >= configuration.fetch.maxRedirects) {
      discard(response);
      throw webError('WEB_REDIRECT_CAP', 'The web request exceeded its redirect limit.');
    }
    let next;
    try { next = safeUrl(new URL(location, current), { allowHttp: configuration.fetch.allowHttp }); }
    catch (error) {
      discard(response);
      throw error;
    }
    discard(response);
    if (typeof options.beforeRedirect === 'function') {
      const permission = await options.beforeRedirect(next);
      if (permission && permission.allowed === false) return { blocked: permission, finalUrl: next, redirects: redirects + 1 };
    }
    url = next;
    redirects += 1;
  }
}

function parseRobots(text, url) {
  const groups = [];
  let group = null;
  let sawRule = false;
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 10_000);
  for (const rawLine of lines) {
    const line = rawLine.slice(0, 4096).replace(/#.*/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!value) continue;
      if (!group || sawRule) {
        if (group) groups.push(group);
        group = { agents: [], rules: [] };
        sawRule = false;
      }
      group.agents.push(value.toLowerCase());
      continue;
    }
    if ((field === 'allow' || field === 'disallow') && group) {
      sawRule = true;
      if (value) group.rules.push({ allow: field === 'allow', value });
    }
  }
  if (group) groups.push(group);
  const product = USER_AGENT.split('/', 1)[0].toLowerCase();
  let best = 0;
  const selected = [];
  for (const candidate of groups) {
    let length = 0;
    for (const agent of candidate.agents) {
      if (agent === '*') length = Math.max(length, 1);
      else if (product.includes(agent)) length = Math.max(length, agent.length);
    }
    if (!length) continue;
    if (length > best) { best = length; selected.length = 0; }
    if (length === best) selected.push(...candidate.rules);
  }
  const path = `${url.pathname || '/'}${url.search || ''}`;
  let winner = null;
  for (const rule of selected) {
    const anchored = rule.value.endsWith('$');
    const source = anchored ? rule.value.slice(0, -1) : rule.value;
    const pattern = `^${source.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`;
    let matches = false;
    try { matches = new RegExp(pattern).test(path); } catch { continue; }
    if (!matches) continue;
    const specificity = source.replace(/\*/g, '').length;
    if (!winner || specificity > winner.specificity || (specificity === winner.specificity && rule.allow && !winner.allow)) {
      winner = { ...rule, specificity };
    }
  }
  return { allowed: !winner || winner.allow === true, matchedRule: winner ? winner.value : null };
}

function robotsResult(allowed, reason, details = {}) {
  return { allowed, reason, matchedRule: null, robotsUrl: null, fetchedAtMs: Date.now(), ...details };
}

function databaseIsOpen(database) {
  if (!database) return false;
  try {
    if (typeof database.isOpen === 'boolean') return database.isOpen;
  } catch {
    return false;
  }
  return true;
}

function evidenceDatabase() {
  if (databaseIsOpen(evidenceDb)) return evidenceDb;
  evidenceDb = null;
  ensureDir(require('node:path').dirname(EVIDENCE_DB_PATH));
  evidenceDb = new DatabaseSync(EVIDENCE_DB_PATH);
  evidenceDb.exec('PRAGMA journal_mode = WAL;');
  evidenceDb.exec('PRAGMA synchronous = NORMAL;');
  evidenceDb.exec(`
    CREATE TABLE IF NOT EXISTS evidence_sources (
      evidence_id TEXT PRIMARY KEY,
      requested_url TEXT NOT NULL,
      final_url TEXT NOT NULL,
      host TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      fetched_at_ms INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      body_bytes INTEGER NOT NULL,
      body BLOB NOT NULL,
      redirects INTEGER NOT NULL,
      robots_url TEXT,
      robots_fetched_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_sources_hash ON evidence_sources(content_hash);
    CREATE INDEX IF NOT EXISTS idx_evidence_sources_host_fetched ON evidence_sources(host, fetched_at_ms DESC);
  `);
  return evidenceDb;
}

function storeEvidence({ requestedUrl, finalUrl, response, body, redirects, robots }) {
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const evidenceId = `evidence-${crypto.randomUUID()}`;
  evidenceDatabase().prepare(`
    INSERT INTO evidence_sources(
      evidence_id, requested_url, final_url, host, http_status, mime_type,
      fetched_at_ms, content_hash, body_bytes, body, redirects, robots_url, robots_fetched_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    evidenceId, requestedUrl.toString(), finalUrl.toString(), ssrf.normalizedHostname(finalUrl.hostname), response.status,
    contentType(response.headers), Date.now(), hash, body.length, body, redirects,
    robots && robots.robotsUrl || null, robots && robots.fetchedAtMs || null
  );
  return {
    evidenceId, contentHash: `sha256:${hash}`, mimeType: contentType(response.headers), bytes: body.length,
    fetchedAtMs: Date.now()
  };
}

function evidenceMetadata(evidenceId) {
  if (typeof evidenceId !== 'string' || !/^evidence-[A-Za-z0-9-]{10,}$/.test(evidenceId)) return null;
  const row = evidenceDatabase().prepare(`
    SELECT evidence_id AS evidenceId, requested_url AS requestedUrl, final_url AS finalUrl,
      host, http_status AS httpStatus, mime_type AS mimeType, fetched_at_ms AS fetchedAtMs,
      content_hash AS contentHash, body_bytes AS bytes, redirects
    FROM evidence_sources WHERE evidence_id = ?
  `).get(evidenceId);
  return row ? { ...row, contentHash: `sha256:${row.contentHash}` } : null;
}

function closeEvidenceStore() {
  if (!databaseIsOpen(evidenceDb)) { evidenceDb = null; return false; }
  const current = evidenceDb;
  evidenceDb = null;
  current.close();
  return true;
}

function createWebProvider(baseDependencies = {}) {
  const robotsCache = new Map();
  const dependencies = { ...baseDependencies };
  const state = dependencies.state || (dependencies.state = getStateStore());
  const now = typeof dependencies.now === 'function' ? dependencies.now : () => Date.now();
  const sleep = typeof dependencies.sleep === 'function' ? dependencies.sleep : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  let limiter = null;
  let limiterKey = null;
  function getLimiter(configuration) {
    const nextKey = `${configuration.fetch.hostIntervalMs}:${configuration.fetch.globalConcurrency}`;
    if (!limiter || limiterKey !== nextKey) {
      limiter = createRateLimiter({ now, sleep, intervalMs: configuration.fetch.hostIntervalMs, concurrency: configuration.fetch.globalConcurrency });
      limiterKey = nextKey;
    }
    return limiter;
  }
  function activate(action) {
    (dependencies.assertActive || assertActive)(action, { provider: 'web' });
  }
  async function permissionFor(url, configuration) {
    const key = hostKey(url);
    const cached = robotsCache.get(key);
    if (cached && cached.expiresAtMs > now()) return cached.evaluate(url);
    const robotsUrl = new URL('/robots.txt', `${url.protocol}//${url.host}`);
    let evaluate;
    try {
      const request = await requestFollowing(robotsUrl, configuration, dependencies, getLimiter(configuration), {
        accept: 'text/plain, text/*;q=0.9, */*;q=0.1', timeoutMs: configuration.fetch.timeoutMs,
        assertActive: () => activate('web.fetch')
      });
      if (request.blocked) {
        evaluate = () => robotsResult(false, 'robots_redirect_blocked', { robotsUrl: robotsUrl.toString() });
      } else if ([404, 410].includes(request.response.status)) {
        discard(request.response);
        evaluate = () => robotsResult(true, 'robots_missing', { robotsUrl: request.finalUrl.toString() });
      } else if (request.response.status >= 200 && request.response.status < 300) {
        const body = await readBounded(request.response, MAX_ROBOTS_BYTES, configuration.fetch.timeoutMs);
        const text = body.toString('utf8');
        const robotsLocation = request.finalUrl.toString();
        evaluate = target => {
          const parsed = parseRobots(text, target);
          return robotsResult(parsed.allowed, parsed.allowed ? 'robots_allowed' : 'robots_disallowed', {
            matchedRule: parsed.matchedRule, robotsUrl: robotsLocation
          });
        };
      } else {
        discard(request.response);
        throw webError(
          'WEB_ROBOTS_UNAVAILABLE',
          `The robots policy endpoint returned HTTP ${request.response.status}; this does not mean robots.txt is absent.`
        );
      }
    } catch (error) {
      if (error && (error.code === 'HTTP_SSRF_ADDRESS_FORBIDDEN' || error.code === 'HTTP_DNS_REBIND_BLOCKED')) throw error;
      if (error && error.code === 'WEB_ROBOTS_UNAVAILABLE') throw error;
      // Fail closed, but do not turn an I/O/resource failure into a cached claim
      // that robots.txt denied the request. The caller can retry once the machine
      // is healthy; only an actual 404/410 is reported as robots_missing.
      const cause = error && error.code ? ` (${error.code})` : '';
      throw webError(
        'WEB_ROBOTS_UNAVAILABLE',
        `The robots policy could not be read${cause}; this does not mean robots.txt is absent.`
      );
    }
    /* AN EXPIRED ROBOTS ENTRY WAS NEVER REMOVED, ONLY IGNORED.
     *
     * The read above already refuses a stale entry -- `cached.expiresAtMs >
     * now()` -- and the entry is replaced when the SAME host is visited again.
     * What never happened is removal for a host that is not revisited, so a run
     * that fetched from a thousand origins held a thousand evaluator closures,
     * each carrying that host's parsed rules, none of them usable.
     *
     * Deleting an expired entry cannot change an answer: the only path that
     * reads it already treats it as absent. Swept here, where an entry is being
     * added, so the cost falls on the operation that grows the map. */
    for (const [cachedKey, cachedEntry] of robotsCache) {
      if (cachedEntry.expiresAtMs <= now()) robotsCache.delete(cachedKey);
    }
    const entry = { expiresAtMs: now() + configuration.fetch.robotsTtlMs, evaluate };
    robotsCache.set(key, entry);
    return entry.evaluate(url);
  }
  async function tavilySearch(prepared, configuration) {
    const secret = (dependencies.getSecret || getSecret)(TAVILY_VAULT_KEY);
    const yearMonth = new Date(now()).toISOString().slice(0, 7);
    const usage = state.getTavilyUsage(yearMonth) || { routineCredits: 0, researchCredits: 0 };
    const totalUsed = usage.routineCredits + usage.researchCredits;
    if (totalUsed >= configuration.tavily.applicationHardStop) {
      throw webError('WEB_PROVIDER_BUDGET_EXCEEDED', 'Tavily monthly credit budget has been reached.');
    }
    if (prepared.purpose === 'routine' && usage.routineCredits >= configuration.tavily.routineMonthlyPool) {
      throw webError('WEB_PROVIDER_BUDGET_EXCEEDED', 'Tavily routine credit pool has been reached for this month.');
    }
    if (prepared.purpose === 'research' && usage.researchCredits >= configuration.tavily.researchMonthlyPool) {
      throw webError('WEB_PROVIDER_BUDGET_EXCEEDED', 'Tavily research credit pool has been reached for this month.');
    }
    const deadline = Date.now() + configuration.fetch.timeoutMs;
    let lastStatus = null;
    for (let attempt = 0; attempt <= SEARCH_RETRIES; attempt += 1) {
      try {
        const endpoint = safeUrl(TAVILY_URL);
        // Do not let a retry cross a newly activated kill switch.
        activate('web.search');
        const target = await ssrf.resolveTarget(endpoint, dependencies);
        const body = Buffer.from(JSON.stringify({
          query: prepared.query, max_results: prepared.maxResults, topic: prepared.topic,
          search_depth: prepared.searchDepth, include_answer: false, include_raw_content: false, include_images: false,
          ...(prepared.preferredDomains?.length ? { include_domains: prepared.preferredDomains } : {}),
          // Tavily accepts dates, not timestamps. Round toward newer sources
          // so its undated results cannot extend beyond the requested window.
          ...(prepared.freshnessSinceMs === undefined ? {} : { start_date: new Date(Math.ceil(prepared.freshnessSinceMs / 86400000) * 86400000).toISOString().slice(0, 10) })
        }), 'utf8');
        const response = await ssrf.requestPinned(target, {
          method: 'POST', headers: {
            Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': String(body.length),
            authorization: `Bearer ${secret}`, 'User-Agent': USER_AGENT
          }, body, timeoutMs: remaining(deadline, 'Tavily search')
        }, dependencies);
        lastStatus = response.status;
        if (response.status >= 200 && response.status < 300) {
          state.recordTavilyUsage({
            yearMonth,
            routineCredits: prepared.purpose === 'routine' ? 1 : 0,
            researchCredits: prepared.purpose === 'research' ? 1 : 0
          });
          const payload = parseJson(await readBounded(response, Math.min(configuration.fetch.maxResponseBytes, 1024 * 1024), remaining(deadline, 'Tavily search')), 'Tavily');
          return { provider: 'tavily', query: prepared.query, ...compactSearchResults(Array.isArray(payload.results) ? payload.results : [], prepared, 'tavily'), ...UNTRUSTED_CONTENT };
        }
        discard(response);
        if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === SEARCH_RETRIES) break;
      } catch (error) {
        if (attempt === SEARCH_RETRIES || (error && /^(?:SECRET_|CREDENTIAL_|WEB_(?:INPUT|URL|HTTPS|PORT|CONTENT))/.test(error.code || ''))) {
          throw error;
        }
      }
      await sleep(Math.min(500 * (2 ** attempt), 2_000));
    }
    const code = [429, 500, 502, 503, 504].includes(lastStatus) ? 'WEB_PROVIDER_EXHAUSTED' : 'WEB_PROVIDER_REJECTED';
    throw webError(code, 'Tavily search did not return a usable result.');
  }
  async function searxngSearch(prepared, configuration) {
    const url = new URL(configuration.search.searxngUrl);
    const domainQuery = prepared.preferredDomains?.length
      ? `(${prepared.preferredDomains.map(domain => `site:${domain}`).join(' OR ')}) ${prepared.query}`
      : prepared.query;
    url.searchParams.set('q', domainQuery);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', 'general,science,scientific publications');
    if (prepared.freshnessSinceMs !== undefined) {
      const ageDays = (prepared.lookupNowMs - prepared.freshnessSinceMs) / 86400000;
      if (ageDays <= 365) url.searchParams.set('time_range', ageDays <= 1 ? 'day' : ageDays <= 30 ? 'month' : 'year');
    }
    const deadline = Date.now() + configuration.fetch.timeoutMs;
    let response;
    let lastStatus = null;
    for (let attempt = 0; attempt <= SEARCH_RETRIES; attempt += 1) {
      let cancelled = false;
      const scheduled = getLimiter(configuration).run('web.search:searxng', () => {
        if (cancelled) throw webError('WEB_TIMEOUT', 'SearXNG search timed out before its rate-limited request started.');
        activate('web.search');
        return localSearxRequest(url, remaining(deadline, 'SearXNG search'), dependencies);
      });
      response = await withinDeadline(scheduled, deadline, 'SearXNG search', () => { cancelled = true; });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) break;
      discard(response);
      response = null;
      const retryable = lastStatus === 408 || lastStatus === 429 || (lastStatus >= 500 && lastStatus <= 599);
      if (!retryable || attempt === SEARCH_RETRIES) break;
      const delay = Math.min(500 * (2 ** attempt), 2_000);
      if (remaining(deadline, 'SearXNG search') <= delay) {
        throw webError('WEB_TIMEOUT', 'SearXNG search timed out before its next retry.');
      }
      await withinDeadline(sleep(delay), deadline, 'SearXNG search');
    }
    if (!response) {
      const exhausted = lastStatus === 408 || lastStatus === 429 || (lastStatus >= 500 && lastStatus <= 599);
      throw webError(
        exhausted ? 'WEB_PROVIDER_EXHAUSTED' : 'WEB_SEARXNG_UNAVAILABLE',
        exhausted
          ? 'SearXNG search exhausted its bounded retry budget.'
          : 'The local restricted SearXNG service did not return a successful JSON response.'
      );
    }
    const payload = parseJson(await readBounded(
      response, Math.min(configuration.fetch.maxResponseBytes, 1024 * 1024), remaining(deadline, 'SearXNG search')
    ), 'SearXNG');
    const source = Array.isArray(payload.results) ? payload.results : [];
    for (const row of source) {
      if (!plainObject(row) || !Array.isArray(row.engines) || row.engines.length === 0) {
        throw webError('WEB_SEARXNG_PROVENANCE_INVALID', 'Every SearXNG result must name at least one approved engine.');
      }
      if (row.engines.some(engine => typeof engine !== 'string' || !SEARXNG_ENGINES.includes(engine.trim().toLowerCase()))) {
        throw webError('WEB_SEARXNG_ENGINE_FORBIDDEN', 'The local SearXNG response named an engine outside the restricted configuration.');
      }
    }
    const compact = compactSearchResults(source, prepared, 'searxng');
    const diagnostics = [...(compact.diagnostics || []), ...searxngFailureDiagnostics(payload.unresponsive_engines)];
    return {
      provider: 'searxng', query: prepared.query,
      ...compact,
      ...(diagnostics.length ? { diagnostics } : {}),
      ...UNTRUSTED_CONTENT
    };
  }
  async function search(value = {}) {
    return searchPrepared(searchInput(value));
  }
  async function searchPrepared(prepared) {
    activate('web.search');
    const configuration = currentConfiguration(dependencies);
    if ((prepared.provider || configuration.search.provider) === 'tavily') {
      const tavilyKey = (dependencies.getSecret || getSecret)(TAVILY_VAULT_KEY, { optional: true });
      if (!tavilyKey) throw webError('WEB_PROVIDER_UNAVAILABLE', 'Tavily API key is not configured.');
      return tavilySearch(prepared, configuration);
    }
    return searxngSearch(prepared, configuration);
  }
  async function fetch(value = {}) {
    activate('web.fetch');
    const prepared = fetchInput(value);
    const configuration = currentConfiguration(dependencies);
    const requestedUrl = safeUrl(prepared.url, { allowHttp: configuration.fetch.allowHttp });
    const initialPermission = await permissionFor(requestedUrl, configuration);
    if (!initialPermission.allowed) {
      return { status: 'skipped_robots', url: requestedUrl.toString(), robots: initialPermission, ...UNTRUSTED_CONTENT };
    }
    const request = await requestFollowing(requestedUrl, configuration, dependencies, getLimiter(configuration), {
      beforeRedirect: next => permissionFor(next, configuration),
      assertActive: () => activate('web.fetch')
    });
    if (request.blocked) {
      return { status: 'skipped_robots', url: request.finalUrl.toString(), robots: request.blocked, ...UNTRUSTED_CONTENT };
    }
    if (request.response.status < 200 || request.response.status >= 300) {
      discard(request.response);
      throw webError('WEB_FETCH_STATUS', 'The remote server did not return a successful fetch response.');
    }
    const body = await readBounded(request.response, configuration.fetch.maxResponseBytes, configuration.fetch.timeoutMs);
    const finalPermission = await permissionFor(request.finalUrl, configuration);
    if (!finalPermission.allowed) {
      // The final host was checked before its redirect hop; retain this guard in
      // case a cache changes while a response is in flight.
      return { status: 'skipped_robots', url: request.finalUrl.toString(), robots: finalPermission, ...UNTRUSTED_CONTENT };
    }
    return {
      status: 'fetched', requestedUrl: requestedUrl.toString(), finalUrl: request.finalUrl.toString(),
      httpStatus: request.response.status, redirects: request.redirects,
      ...storeEvidence({ requestedUrl, finalUrl: request.finalUrl, response: request.response, body, redirects: request.redirects, robots: finalPermission }),
      ...UNTRUSTED_CONTENT
    };
  }
  async function lookup(value = {}) {
    activate('web.lookup');
    const prepared = lookupInput(value);
    const lookupNowMs = now();
    const freshnessSinceMs = prepared.freshnessMs === undefined ? undefined : lookupNowMs - prepared.freshnessMs;

    // Provider failures were previously swallowed entirely, so a broken
    // instance or a stale engine allowlist looked identical to "the web has
    // no answer". Every failure at every tier is recorded here and returned
    // to the caller. Declared before the direct-URL tier so a Tier-3 failure
    // is recorded too, not just the search tiers below.
    const diagnostics = [];

    async function lookupSearch(provider) {
      const base = { ...searchInput({ provider, query: prepared.query, maxResults: prepared.max_sources }), freshnessSinceMs, lookupNowMs };
      const collected = [];
      const seen = new Set();
      let packet;
      for (const preferredDomains of prepared.preferredDomains.length ? [prepared.preferredDomains, []] : [[]]) {
        try {
          packet = await searchPrepared({ ...base, preferredDomains });
        } catch (error) {
          diagnostics.push({ stage: `search:${provider}`, code: error?.code || 'WEB_PROVIDER_UNAVAILABLE', message: String(error?.message || error).slice(0, 300) });
          continue;
        }
        for (const diagnostic of packet.diagnostics || []) diagnostics.push({ stage: `search:${provider}`, ...diagnostic });
        for (const result of packet.results) {
          if (!seen.has(result.url)) { seen.add(result.url); collected.push(result); }
        }
        if (collected.length >= prepared.max_sources) break;
      }
      return { ...packet, results: collected.slice(0, prepared.max_sources) };
    }

    // Tier 1: Evidence Cache & Tier 3: Direct Official Source
    // If the query is a direct URL, bypass search providers.
    let queryUrl;
    try { queryUrl = new URL(prepared.query); } catch (e) { }

    if (queryUrl && ['http:', 'https:'].includes(queryUrl.protocol)) {
      const urlStr = queryUrl.toString();
      
      // Tier 1: Evidence Cache
      const cached = evidenceDatabase().prepare(`SELECT evidence_id AS evidenceId, content_hash AS contentHash, final_url AS finalUrl
        FROM evidence_sources WHERE (requested_url = ? OR final_url = ?)
        ${freshnessSinceMs === undefined ? '' : 'AND fetched_at_ms >= ? AND fetched_at_ms <= ?'}
        ORDER BY fetched_at_ms DESC LIMIT 1`).get(urlStr, urlStr, ...(freshnessSinceMs === undefined ? [] : [freshnessSinceMs, lookupNowMs]));
      if (cached) {
        const title = queryUrl.hostname;
        const result = { url: cached.finalUrl, title, snippet: '' };
        const evidence = { url: cached.finalUrl, title, snippet: '', evidenceId: cached.evidenceId, contentHash: `sha256:${cached.contentHash}` };
        return { status: 'success', query: prepared.query, results: [result], evidence: [evidence], ...UNTRUSTED_CONTENT };
      }

      // Tier 3: Direct Official Source
      try {
        const fetchResult = await fetch({ url: urlStr });
        if (fetchResult.status === 'fetched') {
          const title = queryUrl.hostname;
          const result = { url: fetchResult.finalUrl, title, snippet: '' };
          const evidence = { url: fetchResult.finalUrl, title, snippet: '', evidenceId: fetchResult.evidenceId, contentHash: fetchResult.contentHash };
          return { status: 'success', query: prepared.query, results: [result], evidence: [evidence], ...UNTRUSTED_CONTENT };
        }
        // A TIER-3 REFUSAL THAT DID NOT THROW IS STILL A TIER-3 REFUSAL.
        //
        // fetch() answers `skipped_robots` as a RETURN VALUE for all three of
        // its robots checks -- the requested host, a redirect hop, and the
        // final host re-checked after the body is read -- and only the throwing
        // paths were being recorded. So the one URL the caller actually named
        // could be declined and the fall-through to search left no trace of it:
        // with a search hit the packet said `success`, and with none it said
        // `no_results`, which states that the web has no answer about a page
        // this provider was told not to read. The comment above this whole
        // block already promised the opposite -- "Every failure at every tier
        // is recorded here and returned to the caller ... so a Tier-3 failure
        // is recorded too" -- and this is the half of Tier 3 it did not cover.
        //
        // Recorded through the same diagnostics channel and shape as the throw
        // below, which is also what makes the packet come back `degraded`
        // rather than `success`: this module's own rule is that a packet is
        // fully successful only when every attempted tier completed.
        diagnostics.push({
          stage: 'fetch:direct',
          url: String(queryUrl).slice(0, 200),
          code: `WEB_FETCH_${String(fetchResult && fetchResult.status || 'UNKNOWN').toUpperCase()}`,
          // The matched rule comes out of a remote robots.txt, so it is bounded
          // like every other remote string that reaches a diagnostic.
          message: fetchResult && fetchResult.status === 'skipped_robots'
            ? `The site's robots.txt did not allow this fetch (rule: ${String(fetchResult.robots && fetchResult.robots.matchedRule || 'none').slice(0, 120)}).`
            : 'The direct fetch did not return a retrieved page.'
        });
      } catch (fetchError) {
        // Fall through to search, but record why the direct fetch failed —
        // otherwise a broken direct-fetch path is indistinguishable from a
        // URL that simply was not queried directly.
        diagnostics.push({
          stage: 'fetch:direct',
          url: String(queryUrl).slice(0, 200),
          code: (fetchError && fetchError.code) || 'WEB_FETCH_FAILED',
          message: String((fetchError && fetchError.message) || fetchError).slice(0, 200)
        });
      }
    }

    // Tier 4: SearXNG
    let searchResults;
    try {
      searchResults = await lookupSearch('searxng');
    } catch (searxngError) {
      diagnostics.push({
        stage: 'search:searxng',
        code: (searxngError && searxngError.code) || 'WEB_SEARXNG_UNAVAILABLE',
        message: String((searxngError && searxngError.message) || searxngError).slice(0, 300)
      });
    }

    // Tier 5: Tavily Fallback
    if (!searchResults || searchResults.results.length === 0) {
      try {
        const tavilyKey = (dependencies.getSecret || getSecret)(TAVILY_VAULT_KEY, { optional: true });
        if (tavilyKey) {
          searchResults = await lookupSearch('tavily');
        } else {
          diagnostics.push({
            stage: 'search:tavily',
            code: 'WEB_PROVIDER_UNAVAILABLE',
            message: 'Tavily API key is not configured.'
          });
        }
      } catch (tavilyError) {
        diagnostics.push({
          stage: 'search:tavily',
          code: (tavilyError && tavilyError.code) || 'WEB_TAVILY_UNAVAILABLE',
          message: String((tavilyError && tavilyError.message) || tavilyError).slice(0, 300)
        });
      }
    }

    if (!searchResults || searchResults.results.length === 0) {
      const status = diagnostics.length > 0 ? 'degraded' : 'no_results';
      return { status, query: prepared.query, results: [], evidence: [], diagnostics };
    }

    const intent = classifyQueryIntent(prepared.query);
    const evidence = [];
    for (const result of searchResults.results.slice(0, prepared.max_sources)) {
      try {
        // Some engines (notably arxiv) hand back http:// permalinks. The fetch
        // layer requires HTTPS, so upgrade the scheme rather than discarding an
        // otherwise good source; the fetch still revalidates the final URL.
        let candidateUrl = result.url;
        if (typeof candidateUrl === 'string' && candidateUrl.startsWith('http://')) {
          candidateUrl = `https://${candidateUrl.slice('http://'.length)}`;
        }
        const fetchResult = await fetch({ url: candidateUrl });
        if (fetchResult.status === 'fetched') {
          // Instead of returning snippet from search, let's also extract if possible?
          // For now, follow the simple packet builder pattern
          const extraction = await extract({ evidenceId: fetchResult.evidenceId });
          let excerpt = extraction.text.slice(0, MAX_LOOKUP_EXTRACT_CHARS);
          if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
          evidence.push({
            url: fetchResult.finalUrl, title: result.title, snippet: result.snippet,
            evidenceId: fetchResult.evidenceId, contentHash: fetchResult.contentHash,
            extracted_text: excerpt, extracted_title: extraction.title,
            extracted_text_truncated: excerpt.length < extraction.text.length,
            extracted_text_length: extraction.text.length
          });
        } else {
          diagnostics.push({
            stage: 'fetch', url: String(result.url || '').slice(0, 200),
            code: `WEB_FETCH_${String(fetchResult?.status || 'UNKNOWN').toUpperCase()}`,
            message: fetchResult?.status === 'skipped_robots'
              ? 'The site\'s robots.txt did not allow this fetch.'
              : 'The source fetch did not return a retrieved page.'
          });
        }
      } catch (fetchError) {
        diagnostics.push({
          stage: 'fetch',
          url: String(result.url || '').slice(0, 200),
          code: (fetchError && fetchError.code) || 'WEB_FETCH_FAILED',
          message: String((fetchError && fetchError.message) || fetchError).slice(0, 200)
        });
      }
    }
    // A result packet is only fully successful when every attempted tier and
    // evidence fetch completed. Previously, a single fetched source collapsed
    // failures from any other contributing search/fetch into `success`.
    const finalStatus = diagnostics.length > 0 ? 'degraded' : 'success';
    return { status: finalStatus, query: prepared.query, intent, results: searchResults.results, evidence, diagnostics, ...UNTRUSTED_CONTENT };
  }
  
  async function extract(value = {}) {
    activate('web.extract');
    if (!plainObject(value)) throw webError('WEB_INPUT_INVALID', 'web.extract input must be an object.');
    const evidenceId = boundedText(value.evidenceId, 'evidenceId', 100, { required: true });
    
    // Read from python extractor
    const pythonEnv = process.platform === 'win32'
      ? rootPath('state', 'research-python', 'Scripts', 'python.exe')
      : rootPath('state', 'research-python', 'bin', 'python');
    const extractScript = rootPath('research', 'extract.py');
    const { execFile } = require('node:child_process');
    const dbPath = process.env.TOOLSENABLED_RESEARCH_DB || rootPath('state', 'research-evidence.sqlite');
    
    return new Promise((resolve, reject) => {
      // The extractor is a short-lived console-subsystem Python process. Keep
      // its stdio bounded and explicitly hide its console on Windows; relying
      // on the broker's hidden parent still permits a conhost flash on some
      // desktop builds.
      execFile(pythonEnv, [extractScript, dbPath, evidenceId], {
        windowsHide: true,
        shell: false,
        timeout: 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
        env: safeLaunchEnvironment(process.env, { context: 'web evidence extractor' })
      }, (error, stdout, stderr) => {
        if (error) {
          // R1239: this used to reject with the bare string 'Extraction process
          // failed.', discarding error.code, the signal, and stderr. That is the
          // same silent-swallow shape that kept the 2026-07-24 zero-evidence
          // bugs invisible for weeks, and it was actively hiding a live one:
          // `state/research-python/` is not provisioned in this tree, so every
          // extraction died ENOENT while lookup() reported only that some
          // unspecified thing "failed". An absent interpreter is the expected
          // first-run state, not a mystery -- name it and say how to fix it.
          if (error.code === 'ENOENT') {
            return reject(webError(
              'WEB_EXTRACT_UNPROVISIONED',
              `The research extractor's Python interpreter is not installed at ${pythonEnv}. `
                + (process.platform === 'win32'
                  ? 'Run `pwsh tools/provision-research.ps1 -Python` to provision it. '
                  : 'Create a Python virtual environment at state/research-python under this installation\'s state root and install the pinned research/requirements.lock dependencies. ')
                + 'Until then web.extract and web.lookup return no evidence.'
            ));
          }
          const detail = error.killed || error.signal
            ? `timed out or was killed (signal ${error.signal || 'none'})`
            : `exited with ${error.code === undefined ? 'an unknown code' : `code ${error.code}`}`;
          const tail = String(stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400);
          return reject(webError(
            'WEB_EXTRACT_ERROR',
            `The research extractor ${detail}.${tail ? ` Extractor stderr: ${tail}` : ' It produced no stderr.'}`
          ));
        }
        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            return reject(webError('WEB_EXTRACT_ERROR', result.error));
          }
          resolve({ text: result.text || '', title: result.title || '', ...UNTRUSTED_CONTENT });
        } catch (e) {
          reject(webError('WEB_EXTRACT_ERROR', 'Invalid JSON from extractor.'));
        }
      });
    });
  }

  async function expand(value = {}) {
    activate('web.expand');
    if (!plainObject(value)) throw webError('WEB_INPUT_INVALID', 'web.expand input must be an object.');
    const evidenceId = boundedText(value.evidenceId, 'evidenceId', 100, { required: true });
    // In a real implementation this would take a locator or offset.
    // We just reuse extract and slice it for now.
    const fullExtract = await extract({ evidenceId });
    const offset = parseInt(value.offset || 0, 10) || 0;
    const length = Math.min(parseInt(value.length || 2000, 10) || 2000, 2000);
    const span = (fullExtract.text || '').substring(offset, offset + length);
    return { status: 'success', evidenceId, offset, length, span, ...UNTRUSTED_CONTENT };
  }

  return { fetch, search, permissionFor, robotsCache, lookup, extract, expand };
}

// The convenience methods below bind to a single lazily-created provider.
// Creating the provider opens the durable state store (getStateStore now
// eagerly validates the schema on first open, R1231), so instantiating it at
// module load would perform database I/O merely because something imported this
// module -- including the tool registry, whose consumers legitimately load it
// without a real SQLite binding. Defer creation to first use so importing the
// module stays side-effect-free.
let defaultProviderInstance = null;
function defaultProvider() {
  if (!defaultProviderInstance) defaultProviderInstance = createWebProvider();
  return defaultProviderInstance;
}

module.exports = {
  EVIDENCE_DB_PATH,
  GLOBAL_CONCURRENCY,
  HOST_INTERVAL_MS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_ROBOTS_BYTES,
  MAX_TIMEOUT_MS,
  ROBOTS_TTL_MS,
  SEARXNG_ENGINES,
  TAVILY_VAULT_KEY,
  USER_AGENT,
  classifyQueryIntent,
  closeEvidenceStore,
  compactResult,
  createWebProvider,
  evidenceMetadata,
  expand: (...args) => defaultProvider().expand(...args),
  extract: (...args) => defaultProvider().extract(...args),
  fetch: (...args) => defaultProvider().fetch(...args),
  lookup: (...args) => defaultProvider().lookup(...args),
  parseRobots,
  researchConfiguration,
  search: (...args) => defaultProvider().search(...args),
  webError
};

// EXECUTABLE CHANGE — testcanfail-tests-providers-web-web-js
// Strengthened assertion: the fetched contentHash now has an independently
// calculated oracle. Mutation: WebProvider's SHA-256 input was temporarily
// replaced with Buffer.from('mutated hash input'). Before this change the test
// stayed green; afterward it failed red with:
//   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
//   + 'sha256:cd2a25a0e0a15d5db00e1079540c2455d2d6b07e0d588f7e82652599b5b52dca'
//   - 'sha256:320c591a9b54d17eefc6e3afda06537660ce0402e48aa477e4fda87215a50998'
// The product source was restored byte-for-byte (cmp succeeded), and the
// restored test passed: "Web research adapter tests passed (robots, SSRF,
// redirects, byte cap, kill switch, evidence, SearX retries/provenance)."
// Census: (1) NOT-FOUND (the sole assertion loop uses a non-empty literal);
// (2) NOT-FOUND; (3) NOT-FOUND (cleanup catches do not guard assertions);
// (4) NOT-FOUND; (5) NOT-FOUND: the provider policy is exercised from the
// tracked production allowlist and every network operation uses owned local
// fixtures; (6) FOUND and fixed above. Named precondition: a Node release with
// node:sqlite is required.

'use strict';

// R1 compliance tests deliberately use a local fixture server behind a test
// transport. Production still resolves and pins public addresses; the fake
// transport is only how these tests exercise redirects and body handling
// without granting the broker a localhost-fetch exception.

require('../lib/isolated-environment').activate('web');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'te-web-'));
process.env.TOOLSENABLED_RESEARCH_DB = path.join(dbRoot, 'research-evidence.sqlite');

const web = require('../../src/lib/providers/web');
const { getTool, executeTool } = require('../helpers/dispatch');
const killSwitch = require('../../src/lib/kill-switch');

const PUBLIC_IP = '93.184.216.34';
const POLICY = {
  search: { provider: 'tavily', searxngUrl: 'http://127.0.0.1:8888/search' },
  fetch: {
    allowHttp: false, robotsTtlMs: 86400000, hostIntervalMs: 0, globalConcurrency: 4,
    maxResponseBytes: 1024, maxRedirects: 5, timeoutMs: 5000
  }
};

function responseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value || '')]));
}

function jsonResponse(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? '' : JSON.stringify(payload)
  };
}

function fixtureTransport(port, calls) {
  return spec => new Promise((resolve, reject) => {
    calls.push({ host: spec.hostname, path: `${spec.url.pathname}${spec.url.search}`, headers: spec.headers });
    const request = http.request({
      host: '127.0.0.1', port, path: `${spec.url.pathname}${spec.url.search}`,
      method: spec.method, headers: spec.headers, timeout: spec.timeoutMs
    }, response => resolve({
      status: response.statusCode, headers: responseHeaders(response.headers), stream: response, remoteAddress: spec.address
    }));
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('fixture timeout')));
    if (spec.body) request.write(spec.body);
    request.end();
  });
}

function startFixture() {
  const calls = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    if (url.pathname === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('User-agent: *\nDisallow: /blocked\nAllow: /blocked/public\n');
      return;
    }
    if (url.pathname === '/allowed' || url.pathname === '/blocked/public') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('safe fixture evidence');
      return;
    }
    if (url.pathname === '/large') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('x'.repeat(2048));
      return;
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: '/allowed' });
      response.end();
      return;
    }
    if (url.pathname === '/redirect-private') {
      response.writeHead(302, { location: 'https://private.fixture.test/secret' });
      response.end();
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls }));
  });
}

function providerFor(port, calls, overrides = {}) {
  const config = {
    ...POLICY,
    search: { ...POLICY.search, ...(overrides.search || {}) },
    fetch: { ...POLICY.fetch, ...(overrides.fetch || {}) }
  };
  return web.createWebProvider({
    config,
    assertActive: overrides.assertActive || (() => undefined),
    getSecret: overrides.getSecret || (() => 'fixture-tavily-key'),
    resolve: async hostname => {
      if (hostname === 'private.fixture.test') return [{ address: '127.0.0.1', family: 4 }];
      return [{ address: PUBLIC_IP, family: 4 }];
    },
    transport: overrides.transport || fixtureTransport(port, calls),
    searxRequest: overrides.searxRequest,
    now: overrides.now,
    sleep: overrides.sleep || (async () => undefined)
  });
}

(async () => {
  const searchTool = getTool('web.search');
  const fetchTool = getTool('web.fetch');
  assert.equal(searchTool.effect, 'external-read');
  assert.equal(searchTool.provider, 'web');
  assert.equal(searchTool.annotations.readOnlyHint, true);
  assert.equal(searchTool.annotations.openWorldHint, true);
  assert.equal(fetchTool.effect, 'external-read');
  assert.equal(fetchTool.provider, 'web');
  assert.equal(fetchTool.annotations.readOnlyHint, false, 'web.fetch persists durable local evidence.');
  assert.equal(fetchTool.annotations.openWorldHint, true);
  assert.equal(getTool('web.lookup').annotations.readOnlyHint, false, 'web.lookup can persist fetched local evidence.');

  // Regression: providers/web.js must re-export `extract`/`expand` from its
  // default provider instance onto module.exports, the same way fetch/search/
  // lookup already are (see the `defaultProvider.*` assignments in that
  // file's module.exports). Without this, the registered web.extract and
  // web.expand tools call an undefined property and throw "web.extract is
  // not a function" on every single invocation -- a tool that is registered,
  // schema-validated, and documented, but whose implementation is never
  // reachable.
  const extractTool = getTool('web.extract');
  const expandTool = getTool('web.expand');
  assert.equal(extractTool.effect, 'local-read');
  assert.equal(expandTool.effect, 'local-read');
  assert.equal(typeof web.extract, 'function', 'web.js must export extract from its default provider instance.');
  assert.equal(typeof web.expand, 'function', 'web.js must export expand from its default provider instance.');
  // R1239: the accepted code set widened from the single WEB_EXTRACT_ERROR
  // because extract() now separates "the extractor ran and failed" from "the
  // extractor was never provisioned" (WEB_EXTRACT_UNPROVISIONED, raised when
  // state/research-python/ is absent -- the actual state of a fresh clone, and
  // the state this machine is in). Both are fail-closed WebProviderErrors, so
  // the original bite is intact: a raw TypeError from an unreachable
  // implementation still fails this assertion. The message check below is the
  // new half -- an absent precondition must NAME itself, because a generic
  // "Extraction process failed." is what hid this defect in the first place.
  await assert.rejects(
    web.extract({ evidenceId: 'nonexistent-test-evidence-id' }),
    error => error && error.name === 'WebProviderError'
      && ['WEB_EXTRACT_ERROR', 'WEB_EXTRACT_UNPROVISIONED'].includes(error.code)
      && typeof error.message === 'string'
      && error.message !== 'Extraction process failed.'
      && error.message.length > 0,
    'web.extract must fail closed with a WebProviderError naming a real cause, not a raw "not a function" TypeError and not a bare "Extraction process failed."'
  );

  assert.ok(web.SEARXNG_ENGINES.length > 0, 'the provenance allowlist must never become vacuously empty');
  assert.ok(web.SEARXNG_ENGINES.includes('duckduckgo'));
  assert.ok(web.SEARXNG_ENGINES.includes('pubmed'));
  assert.equal(web.SEARXNG_ENGINES.includes('google'), false, 'Google must not be an accepted provenance engine.');
  assert.equal(web.SEARXNG_ENGINES.includes('bing'), false, 'Bing must not be an accepted provenance engine.');

  assert.equal(web.parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/public\n', new URL('https://fixture.test/private')).allowed, false);
  assert.equal(web.parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/public\n', new URL('https://fixture.test/private/public')).allowed, true);
  assert.equal(web.parseRobots('User-agent: other\nDisallow: /\n', new URL('https://fixture.test/open')).allowed, true);

  const fixture = await startFixture();
  try {
    const provider = providerFor(fixture.port, fixture.calls);
    const blocked = await provider.fetch({ url: 'https://fixture.test/blocked' });
    assert.equal(blocked.status, 'skipped_robots');
    assert.equal(blocked.robots.reason, 'robots_disallowed');
    assert.equal(fixture.calls.filter(call => call.path === '/blocked').length, 0, 'robots refusal must happen before content is fetched.');

    const allowed = await provider.fetch({ url: 'https://fixture.test/allowed' });
    assert.equal(allowed.status, 'fetched');
    assert.equal(allowed.contentHash, 'sha256:320c591a9b54d17eefc6e3afda06537660ce0402e48aa477e4fda87215a50998');
    assert.equal(allowed.bytes, Buffer.byteLength('safe fixture evidence'));
    assert.equal(allowed.contentTrust, 'untrusted');
    assert.equal(allowed.grantsAuthority, false);
    const evidence = web.evidenceMetadata(allowed.evidenceId);
    assert.equal(evidence.finalUrl, 'https://fixture.test/allowed');
    assert.equal(evidence.bytes, allowed.bytes);
    assert.equal(evidence.contentHash, allowed.contentHash);
    assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'body'), false, 'metadata API must not return the stored body.');

    const callsBeforeLookup = fixture.calls.length;
    const cachedLookup = await provider.lookup({ query: 'https://fixture.test/allowed' });
    assert.equal(cachedLookup.evidence[0].evidenceId, allowed.evidenceId);
    assert.equal(cachedLookup.evidence[0].contentHash, 'sha256:320c591a9b54d17eefc6e3afda06537660ce0402e48aa477e4fda87215a50998');
    assert.equal(fixture.calls.length, callsBeforeLookup, 'a cached lookup should reuse the stored source without a request.');

    const redirected = await provider.fetch({ url: 'https://fixture.test/redirect' });
    assert.equal(redirected.finalUrl, 'https://fixture.test/allowed');
    assert.equal(redirected.redirects, 1);
    const cachedRedirect = await provider.lookup({ query: 'https://fixture.test/redirect' });
    assert.equal(cachedRedirect.results[0].url, 'https://fixture.test/allowed');
    assert.equal(cachedRedirect.evidence[0].url, 'https://fixture.test/allowed');
    assert.equal(cachedRedirect.evidence[0].evidenceId, redirected.evidenceId);
    assert.equal(cachedRedirect.evidence[0].contentHash, redirected.contentHash);

    const fixtureDb = new (require('node:sqlite').DatabaseSync)(process.env.TOOLSENABLED_RESEARCH_DB);
    try {
      fixtureDb.prepare('UPDATE evidence_sources SET fetched_at_ms = ? WHERE evidence_id = ?')
        .run(Date.now() - 30 * 86400000, redirected.evidenceId);
      const refreshed = await provider.lookup({ query: 'https://fixture.test/redirect', freshness: '7d' });
      assert.notEqual(refreshed.evidence[0].evidenceId, redirected.evidenceId, 'a seven-day freshness requirement must not reuse a thirty-day-old source.');
      assert.equal(refreshed.evidence[0].contentHash, redirected.contentHash);
    } finally { fixtureDb.close(); }

    const lookupQueries = [];
    const lookupTime = Date.parse('2026-09-08T12:00:00Z');
    const lookupProvider = providerFor(fixture.port, [], {
      now: () => lookupTime,
      getSecret: () => undefined,
      searxRequest: async url => {
        lookupQueries.push({ query: url.searchParams.get('q'), range: url.searchParams.get('time_range') });
        const preferred = url.searchParams.get('q').includes('site:official.test');
        return jsonResponse(200, { results: preferred ? [
          { url: 'https://official.test.evil.test/outside', title: 'wrong domain', engines: ['duckduckgo'], publishedDate: '2026-09-07T12:00:00Z' },
          { url: 'https://official.test/old', title: 'old', engines: ['duckduckgo'], publishedDate: '2026-08-01T12:00:00Z' },
          { url: 'https://official.test/undated', title: 'unknown age', engines: ['duckduckgo'] },
          { url: 'https://docs.official.test/fresh', title: 'preferred', engines: ['duckduckgo'], publishedDate: '2026-09-07T12:00:00Z' }
        ] : [
          { url: 'https://docs.official.test/fresh', title: 'duplicate', engines: ['duckduckgo'], publishedDate: '2026-09-07T12:00:00Z' },
          { url: 'https://other.test/fresh', title: 'fallback', engines: ['duckduckgo'], publishedDate: '2026-09-06T12:00:00Z' }
        ] });
      },
      transport: async spec => ({ status: 200, remoteAddress: spec.address, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' })
    });
    const preferredLookup = await lookupProvider.lookup({ query: 'release notes', preferred_domains: ['OFFICIAL.TEST'], freshness: '7d', max_sources: 2 });
    assert.deepEqual(lookupQueries, [{ query: '(site:official.test) release notes', range: 'month' }, { query: 'release notes', range: 'month' }]);
    assert.deepEqual(preferredLookup.results.map(result => result.url), ['https://docs.official.test/fresh', 'https://other.test/fresh']);
    assert.equal(preferredLookup.results[0].publishedDate, '2026-09-07T12:00:00.000Z');
    assert.ok(preferredLookup.diagnostics.some(item => item.code === 'WEB_FRESHNESS_UNVERIFIED'));
    for (const input of [{ freshness: 'yesterday' }, { freshness: '0d' }, { preferred_domains: ['example.test OR other.test'] }, { preferred_domains: ['https://example.test/'] }]) {
      await assert.rejects(lookupProvider.lookup({ query: 'release notes', ...input }), error => error.code === 'WEB_INPUT_INVALID');
    }
    assert.equal(lookupQueries.length, 2, 'invalid lookup options must fail before reaching a search provider.');

    const tavilyLookupBodies = [];
    const tavilyLookup = providerFor(fixture.port, [], {
      now: () => lookupTime,
      searxRequest: async () => jsonResponse(200, { results: [] }),
      transport: async spec => {
        if (spec.url.hostname === 'api.tavily.com') {
          tavilyLookupBodies.push(JSON.parse(spec.body.toString('utf8')));
          return { ...jsonResponse(200, { results: [{ url: 'https://official.test/fresh', title: 'filtered result', content: 'fixture' }] }), remoteAddress: spec.address };
        }
        return { status: 200, remoteAddress: spec.address, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' };
      }
    });
    const tavilyFiltered = await tavilyLookup.lookup({ query: 'release notes', preferred_domains: ['official.test'], freshness: '7d', max_sources: 1 });
    assert.equal(tavilyLookupBodies.length, 1);
    assert.equal(tavilyLookupBodies[0].start_date, '2026-09-02', 'date-only search bounds must not include sources older than the exact cutoff.');
    assert.deepEqual(tavilyLookupBodies[0].include_domains, ['official.test']);
    assert.equal(tavilyFiltered.results[0].url, 'https://official.test/fresh');
    assert.equal(tavilyFiltered.status, 'degraded', 'a search hit whose page is robots-blocked must not be reported as a complete lookup.');
    assert.ok(tavilyFiltered.diagnostics.some(item => item.code === 'WEB_FETCH_SKIPPED_ROBOTS'));

    const partialLookup = providerFor(fixture.port, [], {
      getSecret: () => undefined,
      searxRequest: async url => {
        if (!url.searchParams.get('q').includes('site:official.test')) throw Object.assign(new Error('general search unavailable'), { code: 'WEB_SEARXNG_UNAVAILABLE' });
        return jsonResponse(200, { results: [{ url: 'https://official.test/partial', title: 'preferred source', engines: ['duckduckgo'] }] });
      },
      transport: async spec => ({ status: 200, remoteAddress: spec.address, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' })
    });
    const partial = await partialLookup.lookup({ query: 'release notes', preferred_domains: ['official.test'], max_sources: 2 });
    assert.equal(partial.results[0].url, 'https://official.test/partial', 'failure while filling remaining slots must preserve a successful preferred-domain result.');
    assert.equal(partial.status, 'degraded');
    assert.ok(partial.diagnostics.some(item => item.code === 'WEB_SEARXNG_UNAVAILABLE'));

    await assert.rejects(
      provider.fetch({ url: 'https://private.fixture.test/secret' }),
      error => error && error.code === 'HTTP_SSRF_ADDRESS_FORBIDDEN'
    );
    await assert.rejects(
      provider.fetch({ url: 'https://fixture.test/redirect-private' }),
      error => error && error.code === 'HTTP_SSRF_ADDRESS_FORBIDDEN'
    );
    assert.equal(fixture.calls.filter(call => call.path === '/secret').length, 0, 'a private redirect must be refused before a connection starts.');

    const capped = providerFor(fixture.port, fixture.calls, { fetch: { maxResponseBytes: 32 } });
    await assert.rejects(
      capped.fetch({ url: 'https://fixture.test/large' }),
      error => error && error.code === 'WEB_BYTE_CAP'
    );

    const interruptedFetchCalls = [];
    let interruptedFetchChecks = 0;
    const interruptedFetch = providerFor(fixture.port, interruptedFetchCalls, {
      assertActive: () => {
        interruptedFetchChecks += 1;
        if (interruptedFetchChecks >= 3) throw new Error('KILLSWITCH is active. web.fetch was not executed.');
      }
    });
    await assert.rejects(
      interruptedFetch.fetch({ url: 'https://fixture.test/allowed' }),
      /KILLSWITCH is active/
    );
    assert.deepEqual(interruptedFetchCalls.map(call => call.path), ['/robots.txt'],
      'A kill switch activated after robots must stop the content request before DNS or transport.');

    const tavilyCalls = [];
    const tavily = providerFor(fixture.port, tavilyCalls, {
      transport: async spec => {
        tavilyCalls.push(spec);
        return {
          status: 200, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ results: [{ url: 'https://example.com/article', title: 'Fixture', content: 'bounded snippet', score: 0.9 }] }),
          remoteAddress: spec.address
        };
      }
    });
    const searched = await tavily.search({ query: 'fixture research' });
    assert.equal(searched.provider, 'tavily');
    assert.deepEqual(searched.results, [{ url: 'https://example.com/article', title: 'Fixture', snippet: 'bounded snippet', provider: 'tavily', score: 0.9 }]);
    assert.equal(tavilyCalls.length, 1, 'a successful provider result must not fall back to another engine.');
    assert.equal(tavilyCalls[0].headers.authorization, 'Bearer fixture-tavily-key');

    const interruptedSearchCalls = [];
    let interruptedSearchChecks = 0;
    const interruptedSearch = providerFor(fixture.port, interruptedSearchCalls, {
      assertActive: () => {
        interruptedSearchChecks += 1;
        if (interruptedSearchChecks >= 2) throw new Error('KILLSWITCH is active. web.search was not executed.');
      }
    });
    await assert.rejects(
      interruptedSearch.search({ query: 'cancel before Tavily transport' }),
      /KILLSWITCH is active/
    );
    assert.equal(interruptedSearchCalls.length, 0,
      'A kill switch activated after search validation must stop Tavily before DNS or transport.');

    const retryStatuses = [408, 429, 200];
    const retrySleeps = [];
    let retryCalls = 0;
    const retryingSearx = providerFor(fixture.port, [], {
      searxRequest: async () => {
        const status = retryStatuses[retryCalls];
        retryCalls += 1;
        return jsonResponse(status, status === 200 ? {
          results: [{
            url: 'https://example.com/retried', title: 'Retried result',
            content: 'approved provenance', engines: ['wikipedia']
          }]
        } : { results: [] });
      },
      sleep: async milliseconds => { retrySleeps.push(milliseconds); }
    });
    const retried = await retryingSearx.search({ query: 'retry fixture', provider: 'searxng' });
    assert.equal(retried.provider, 'searxng');
    assert.equal(retried.results.length, 1);
    assert.equal(retryCalls, 3, 'SearXNG 408/429 responses must retry within the fixed attempt budget.');
    assert.deepEqual(retrySleeps, [500, 1000], 'SearXNG retry backoff must be deterministic and bounded.');

    const exhaustedSleeps = [];
    let exhaustedCalls = 0;
    const exhaustedSearx = providerFor(fixture.port, [], {
      searxRequest: async () => {
        exhaustedCalls += 1;
        return jsonResponse(503, { results: [] });
      },
      sleep: async milliseconds => { exhaustedSleeps.push(milliseconds); }
    });
    await assert.rejects(
      exhaustedSearx.search({ query: 'exhausted fixture', provider: 'searxng' }),
      error => error && error.code === 'WEB_PROVIDER_EXHAUSTED'
    );
    assert.equal(exhaustedCalls, 3, 'SearXNG retry exhaustion must stop after the fixed attempt budget.');
    assert.deepEqual(exhaustedSleeps, [500, 1000]);

    let deadlineCalls = 0;
    const deadlineSleeps = [];
    const deadlineBoundSearx = providerFor(fixture.port, [], {
      fetch: { timeoutMs: 400 },
      searxRequest: async () => {
        deadlineCalls += 1;
        return jsonResponse(429, { results: [] });
      },
      sleep: async milliseconds => { deadlineSleeps.push(milliseconds); }
    });
    await assert.rejects(
      deadlineBoundSearx.search({ query: 'deadline fixture', provider: 'searxng' }),
      error => error && error.code === 'WEB_TIMEOUT'
    );
    assert.equal(deadlineCalls, 1, 'SearXNG must not start another request when backoff would cross the search deadline.');
    assert.deepEqual(deadlineSleeps, [], 'SearXNG must not sleep beyond the bounded search deadline.');

    let rateClock = 10_000;
    const rateSleeps = [];
    const rateLimitedSearx = providerFor(fixture.port, [], {
      fetch: { hostIntervalMs: 250 },
      now: () => rateClock,
      sleep: async milliseconds => {
        rateSleeps.push(milliseconds);
        rateClock += milliseconds;
      },
      searxRequest: async () => jsonResponse(200, {
        results: [{
          url: 'https://example.com/rate-limited', title: 'Rate limited result',
          content: 'approved provenance', engines: ['openalex']
        }]
      })
    });
    await rateLimitedSearx.search({ query: 'first rate fixture', provider: 'searxng' });
    await rateLimitedSearx.search({ query: 'second rate fixture', provider: 'searxng' });
    assert.deepEqual(rateSleeps, [250], 'SearXNG calls must share the configured per-host pacing interval.');

    let releaseRateWait;
    let boundedRateCalls = 0;
    const deadlineRateLimitedSearx = providerFor(fixture.port, [], {
      fetch: { hostIntervalMs: 1000, timeoutMs: 50 },
      sleep: () => new Promise(resolve => { releaseRateWait = resolve; }),
      searxRequest: async () => {
        boundedRateCalls += 1;
        return jsonResponse(200, {
          results: [{
            url: 'https://example.com/deadline-rate', title: 'Deadline rate result',
            content: 'approved provenance', engines: ['crossref']
          }]
        });
      }
    });
    await deadlineRateLimitedSearx.search({ query: 'first deadline rate fixture', provider: 'searxng' });
    await assert.rejects(
      deadlineRateLimitedSearx.search({ query: 'second deadline rate fixture', provider: 'searxng' }),
      error => error && error.code === 'WEB_TIMEOUT'
    );
    assert.equal(boundedRateCalls, 1, 'A rate-limited SearXNG request must not start after its deadline expires.');
    assert.equal(typeof releaseRateWait, 'function');
    releaseRateWait();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(boundedRateCalls, 1, 'A timed-out queued SearXNG request must remain cancelled when the limiter advances.');

    const invalidProvenance = [
      { row: null, code: 'WEB_SEARXNG_PROVENANCE_INVALID' },
      { row: { url: 'https://example.com/missing', title: 'Missing', content: 'missing engines' }, code: 'WEB_SEARXNG_PROVENANCE_INVALID' },
      { row: { url: 'https://example.com/empty', title: 'Empty', content: 'empty engines', engines: [] }, code: 'WEB_SEARXNG_PROVENANCE_INVALID' },
      { row: { url: 'https://example.com/malformed', title: 'Malformed', content: 'malformed engines', engines: 'wikipedia' }, code: 'WEB_SEARXNG_PROVENANCE_INVALID' },
      { row: { url: 'https://example.com/forbidden', title: 'Forbidden', content: 'forbidden engine', engines: ['google'] }, code: 'WEB_SEARXNG_ENGINE_FORBIDDEN' }
    ];
    for (const [index, test] of invalidProvenance.entries()) {
      const provider = providerFor(fixture.port, [], {
        searxRequest: async () => jsonResponse(200, { results: [test.row] })
      });
      await assert.rejects(
        provider.search({ query: `provenance fixture ${index}`, provider: 'searxng' }),
        error => error && error.code === test.code
      );
    }

    killSwitch.activate();
    try {
      await assert.rejects(
        executeTool('web.fetch', { url: 'https://fixture.test/allowed' }),
        /KILLSWITCH is active/
      );
    } finally {
      killSwitch.deactivate();
    }
  } finally {
    await new Promise(resolve => fixture.server.close(resolve));
  }

  console.log('Web research adapter tests passed (robots, SSRF, redirects, byte cap, kill switch, evidence, SearX retries/provenance).');
})()
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => {
    try { web.closeEvidenceStore(); } catch { /* preserve original failure */ }
    try { fs.rmSync(dbRoot, { recursive: true, force: true }); } catch { /* preserve original failure */ }
  });

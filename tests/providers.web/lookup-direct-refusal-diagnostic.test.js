'use strict';

// A TIER-3 REFUSAL THAT DID NOT THROW IS STILL A TIER-3 REFUSAL.
//
// lookup()'s own header promises "Every failure at every tier is recorded here
// and returned to the caller. Declared before the direct-URL tier so a Tier-3
// failure is recorded too, not just the search tiers below." Only the THROWING
// half of Tier 3 was recorded. fetch() answers `skipped_robots` as a RETURN
// VALUE at all three of its robots checks, so a direct URL the caller named
// could be declined and the fall-through to search left no trace: with a search
// hit the packet said `success`, and with none it said `no_results` -- which
// states the web has no answer about a page this provider was told not to read.
//
// These checks assert BEHAVIOUR through the public lookup(): they drive a real
// robots.txt that disallows everything and read the returned packet. They never
// reach into the module's internals and never spell a private constant.

require('../lib/isolated-environment').activate('web-lookup-direct-refusal');
const assert = require('node:assert/strict');
const web = require('../../src/lib/providers/web');

const BASE = {
  search: { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8888/search' },
  fetch: {
    allowHttp: false, robotsTtlMs: 1000, hostIntervalMs: 0, globalConcurrency: 1,
    maxResponseBytes: 1024, maxRedirects: 0, timeoutMs: 1000
  },
  tavily: { routineMonthlyPool: 2, researchMonthlyPool: 2, applicationHardStop: 3 }
};

function response(status, body = '', headers = {}) {
  return { status, body, headers };
}

const DISALLOW_ALL = 'User-agent: *\nDisallow: /\n';

/* A provider whose robots.txt refuses everything, so fetch() RETURNS
   skipped_robots instead of throwing, and whose search tier answers however the
   caller asks. */
function provider({ searxRequest } = {}) {
  const seen = { pageRequests: 0 };
  return {
    seen,
    api: web.createWebProvider({
      config: BASE,
      state: { getTavilyUsage: () => ({ routineCredits: 0, researchCredits: 0 }), recordTavilyUsage: () => {} },
      assertActive: () => undefined,
      getSecret: () => undefined,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async spec => {
        if (spec.url.pathname === '/robots.txt') return { remoteAddress: spec.address, ...response(200, DISALLOW_ALL, { 'content-type': 'text/plain' }) };
        seen.pageRequests += 1;
        return { remoteAddress: spec.address, ...response(200, 'the page body') };
      },
      searxRequest: searxRequest || (async () => response(404)),
      sleep: async () => undefined
    })
  };
}

(async () => {
  // 1. The page was never read, and the packet says so rather than staying
  //    silent about the one URL the caller actually named.
  {
    const { api, seen } = provider();
    const result = await api.lookup({ query: 'https://example.test/page' });
    assert.equal(seen.pageRequests, 0, 'a robots-disallowed page must never be fetched');
    const direct = (result.diagnostics || []).filter(item => item.stage === 'fetch:direct');
    assert.equal(direct.length, 1,
      `the declined direct fetch left no diagnostic; got ${JSON.stringify(result.diagnostics || [])}`);
    assert.match(direct[0].code, /ROBOTS/, `the diagnostic did not say why: ${JSON.stringify(direct[0])}`);
    assert.match(direct[0].message, /robots\.txt/, `the diagnostic did not name robots.txt: ${direct[0].message}`);
    assert.match(direct[0].url, /example\.test/, 'the diagnostic did not name the URL it was about');
  }

  // 2. "I was told not to read it" is not "the web has no answer". With no
  //    search results either, the packet must not settle on no_results.
  {
    const { api } = provider();
    const result = await api.lookup({ query: 'https://example.test/page' });
    assert.notEqual(result.status, 'no_results',
      'a declined direct fetch was reported as the web having nothing to say');
    assert.equal(result.status, 'degraded');
    assert.deepEqual(result.results, []);
  }

  // 3. And a search that DID answer must not launder the refusal into success:
  //    this module's rule is that a packet is fully successful only when every
  //    attempted tier completed.
  {
    const { api } = provider({
      searxRequest: async () => response(200, JSON.stringify({
        results: [{ url: 'https://other.test/a', title: 'another source', content: 'text' }]
      }), { 'content-type': 'application/json' })
    });
    const result = await api.lookup({ query: 'https://example.test/page' });
    assert.notEqual(result.status, 'success',
      'a declined direct fetch was laundered into success by an unrelated search hit');
    assert.ok((result.diagnostics || []).some(item => item.stage === 'fetch:direct'),
      'the refusal did not survive into the packet that reported other sources');
  }

  // 4. The tier that DOES succeed is unchanged: a page robots allows still
  //    returns straight from Tier 3 with no diagnostic invented for it.
  {
    const api = web.createWebProvider({
      config: BASE,
      state: { getTavilyUsage: () => ({ routineCredits: 0, researchCredits: 0 }), recordTavilyUsage: () => {} },
      assertActive: () => undefined,
      getSecret: () => undefined,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async spec => (spec.url.pathname === '/robots.txt'
        ? { remoteAddress: spec.address, ...response(404) }
        : { remoteAddress: spec.address, ...response(200, 'the page body', { 'content-type': 'text/html' }) }),
      searxRequest: async () => assert.fail('an allowed direct fetch must not reach the search tiers'),
      sleep: async () => undefined
    });
    const result = await api.lookup({ query: 'https://example.test/page' });
    assert.equal(result.status, 'success');
    assert.equal(result.evidence.length, 1);
    assert.equal(result.diagnostics, undefined, 'a clean direct fetch must not carry diagnostics');
  }

  console.log('web lookup direct-refusal diagnostic passed (4 checks: a declined direct fetch is recorded, is not reported as no_results, is not laundered into success by a search hit, and an allowed direct fetch is unchanged)');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

'use strict';

require('../lib/isolated-environment').activate('web-refusal-coverage');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const childProcess = require('node:child_process');
const originalExecFile = childProcess.execFile;
let spawned = 0;
childProcess.execFile = (...args) => { spawned += 1; return originalExecFile(...args); };
const web = require('../../src/lib/providers/web');

const BASE = {
  search: { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8888/search' },
  fetch: { allowHttp: false, robotsTtlMs: 1000, hostIntervalMs: 0, globalConcurrency: 1,
    maxResponseBytes: 1024, maxRedirects: 0, timeoutMs: 1000 },
  tavily: { routineMonthlyPool: 2, researchMonthlyPool: 2, applicationHardStop: 3 }
};

function response(status, body = '', headers = {}) {
  return { status, body, headers };
}

function harness(overrides = {}) {
  const effects = { requests: 0, usageWrites: 0 };
  const state = overrides.state || {
    getTavilyUsage: () => ({ routineCredits: 0, researchCredits: 0 }),
    recordTavilyUsage: () => { effects.usageWrites += 1; }
  };
  const provider = web.createWebProvider({
    config: overrides.config || BASE,
    state,
    assertActive: () => undefined,
    getSecret: overrides.getSecret || (() => 'key'),
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async spec => {
      effects.requests += 1;
      const result = await overrides.transport(spec, effects);
      return { remoteAddress: spec.address, ...result };
    },
    searxRequest: overrides.searxRequest,
    sleep: async () => undefined
  });
  return { provider, effects };
}

async function refuses(promise, code) {
  await assert.rejects(promise, error => error && error.name === 'WebProviderError' && error.code === code);
}

(async () => {
  // Pure validation refusals happen before network, persistence, or process work.
  for (const [input, code] of [
    [{ query: '' }, 'WEB_INPUT_INVALID'],
    [{ query: 'cats !! dogs' }, 'WEB_QUERY_SYNTAX_FORBIDDEN']
  ]) {
    const h = harness({ transport: async () => { throw new Error('must not request'); } });
    await refuses(h.provider.search(input), code);
    assert.deepEqual(h.effects, { requests: 0, usageWrites: 0 });
  }

  for (const [url, code] of [
    ['http://example.test/page', 'WEB_HTTPS_REQUIRED'],
    ['https://example.test:444/page', 'WEB_PORT_FORBIDDEN']
  ]) {
    const h = harness({ transport: async () => { throw new Error('must not request'); } });
    await refuses(h.provider.fetch({ url }), code);
    assert.deepEqual(h.effects, { requests: 0, usageWrites: 0 });
  }

  const unavailable = harness({ getSecret: () => undefined, transport: async () => { throw new Error('must not request'); } });
  await refuses(unavailable.provider.search({ query: 'x', provider: 'tavily' }), 'WEB_PROVIDER_UNAVAILABLE');
  assert.deepEqual(unavailable.effects, { requests: 0, usageWrites: 0 });

  const budget = harness({
    state: { getTavilyUsage: () => ({ routineCredits: 3, researchCredits: 0 }), recordTavilyUsage: () => assert.fail('must not write usage') },
    transport: async () => { throw new Error('must not request'); }
  });
  await refuses(budget.provider.search({ query: 'x', provider: 'tavily' }), 'WEB_PROVIDER_BUDGET_EXCEEDED');
  assert.equal(budget.effects.requests, 0);

  const rejected = harness({ transport: async () => response(403) });
  await refuses(rejected.provider.search({ query: 'x', provider: 'tavily' }), 'WEB_PROVIDER_REJECTED');
  assert.equal(rejected.effects.requests, 1);
  assert.equal(rejected.effects.usageWrites, 0);

  const invalidProviderResponse = harness({ searxRequest: async () => response(200, '{not json') , transport: async () => assert.fail('unused') });
  await refuses(invalidProviderResponse.provider.search({ query: 'x' }), 'WEB_PROVIDER_RESPONSE_INVALID');
  assert.deepEqual(invalidProviderResponse.effects, { requests: 0, usageWrites: 0 });

  async function fetchRefusal(pageResponse, code) {
    const h = harness({ transport: async spec => spec.url.pathname === '/robots.txt'
      ? response(404)
      : pageResponse() });
    await refuses(h.provider.fetch({ url: 'https://example.test/page' }), code);
    assert.equal(h.effects.requests, 2);
    assert.equal(h.effects.usageWrites, 0);
  }
  await fetchRefusal(() => response(503), 'WEB_FETCH_STATUS');
  await fetchRefusal(() => response(200, 'body', { 'content-encoding': 'compress' }), 'WEB_CONTENT_ENCODING_UNSUPPORTED');
  await fetchRefusal(() => response(200, Buffer.from('not gzip'), { 'content-encoding': 'gzip' }), 'WEB_RESPONSE_DECODE_FAILED');
  await fetchRefusal(() => response(200, { invalid: true }), 'WEB_RESPONSE_INVALID');

  const redirect = harness({ transport: async spec => spec.url.pathname === '/robots.txt'
    ? response(404)
    : { status: 302, headers: { location: '/again' }, stream: Readable.from([]) } });
  await refuses(redirect.provider.fetch({ url: 'https://example.test/page' }), 'WEB_REDIRECT_CAP');
  assert.equal(redirect.effects.requests, 2);
  assert.equal(redirect.effects.usageWrites, 0);

  // WEB_FETCH_FAILED is a caller-visible lookup diagnostic fallback for an
  // untyped direct-fetch exception, rather than a thrown WebProviderError.
  let activations = 0;
  const fallback = web.createWebProvider({
    config: BASE, state: { getTavilyUsage: () => ({ routineCredits: 0, researchCredits: 0 }) },
    assertActive(action) { if (action === 'web.fetch' && ++activations === 1) throw new Error('injected fetch failure'); },
    getSecret: () => undefined,
    searxRequest: async () => response(404),
    sleep: async () => undefined
  });
  const result = await fallback.lookup({ query: 'https://example.test/page' });
  assert.equal(result.status, 'degraded');
  assert.equal(result.evidence.length, 0);
  assert.ok(result.diagnostics.some(item => item.stage === 'fetch:direct' && item.code === 'WEB_FETCH_FAILED'));
  assert.equal(spawned, 0, 'refusal paths must not spawn the evidence extractor');

  console.log('web refusal coverage passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

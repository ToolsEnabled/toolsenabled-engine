'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

// Node 20 does not expose node:sqlite. This test never opens the evidence store,
// so a load-only stand-in keeps the focused robots test runnable there too.
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'node:sqlite') return { DatabaseSync: class DatabaseSync {} };
  return originalLoad.call(this, request, parent, isMain);
};
const { createWebProvider } = require('../../src/lib/providers/web');
Module._load = originalLoad;

const config = {
  search: { provider: 'tavily' },
  fetch: {
    allowHttp: false,
    robotsTtlMs: 86_400_000,
    hostIntervalMs: 0,
    globalConcurrency: 1,
    maxResponseBytes: 1024,
    maxRedirects: 1,
    timeoutMs: 1000
  }
};

let robotsAttempts = 0;
const provider = createWebProvider({
  config,
  state: {},
  assertActive: () => undefined,
  resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  transport: async spec => {
    assert.equal(spec.url.pathname, '/robots.txt', 'a denied target must never be fetched');
    robotsAttempts += 1;
    if (robotsAttempts === 1) {
      const error = new Error('fixture machine is busy');
      error.code = 'EBUSY';
      throw error;
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'User-agent: *\nDisallow: /blocked\n',
      remoteAddress: spec.address
    };
  },
  sleep: async () => undefined
});

(async () => {
  await assert.rejects(
    provider.fetch({ url: 'https://fixture.test/blocked' }),
    error => error && error.code === 'WEB_ROBOTS_UNAVAILABLE'
      && /does not mean robots\.txt is absent/i.test(error.message),
    'EBUSY must be reported as could-not-read, not as a definite robots refusal.'
  );

  const retry = await provider.fetch({ url: 'https://fixture.test/blocked' });
  assert.equal(retry.status, 'skipped_robots', 'the provider must retry after an indeterminate read.');
  assert.equal(retry.robots.reason, 'robots_disallowed');

  const cached = await provider.fetch({ url: 'https://fixture.test/blocked' });
  assert.equal(cached.status, 'skipped_robots');
  assert.equal(robotsAttempts, 2, 'a successfully read robots policy must still be cached.');

  console.log('robots indeterminate-read regression test passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

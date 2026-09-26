/*
 * Mutation: changed `unavailable ? 'not recorded'` to `unavailable ? 'recorded'`
 * in render-image.js.
 * Mutation landed: yes (the replacement was printed from the module).
 * Result: RED (the isolated test exited 1 on the explicit-description assertion).
 */
'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const {
  DEFAULT_TIMEOUT_MS,
  DEVICE_SCALE,
  PHONE_HEIGHT,
  PHONE_WIDTH,
  captureReportPng,
  renderReportCardHtml,
  renderReportImage
} = require('../src/lib/agent-digest/render-image');

function state() {
  return {
    observedAtMs: Date.UTC(2026, 7, 27, 12, 0, 0),
    observed: { meters: { state: 'durable', providers: [] }, runs: {} },
    gaps: [],
    delta: { available: false, reason: 'first report' }
  };
}

function fakeChromium(png = Buffer.from('png-bytes')) {
  const calls = { launch: [], contexts: [], routes: [], contents: [], screenshots: [], contextCloses: 0, browserCloses: 0 };
  const page = {
    route: async (...args) => { calls.routes.push(args); },
    setContent: async (...args) => { calls.contents.push(args); },
    screenshot: async options => { calls.screenshots.push(options); return png; }
  };
  const context = {
    newPage: async () => page,
    close: async () => { calls.contextCloses += 1; }
  };
  const browser = {
    newContext: async options => { calls.contexts.push(options); return context; },
    close: async () => { calls.browserCloses += 1; }
  };
  return {
    calls,
    chromium: { launch: async options => { calls.launch.push(options); return browser; } }
  };
}

async function main() {
  const html = renderReportCardHtml({
    state: state(),
    kind: 'digest',
    fireKey: '<owner-slot>',
    mode: 'full & final',
    metrics: [
      { label: '<Queue & load>', value: null, note: 'meter <missing>', tone: 'bad' },
      { label: 'Completed', value: 17, note: 'durable', tone: 'good' }
    ]
  });

  assert.match(html, /<div class="title">Digest<\/div>/, 'kind selects the Digest title');
  assert.match(html, /<div class="tv"[^>]*>not recorded<\/div>/,
    'unknown metric values are explicitly described as not recorded');
  assert.match(html, /border:1px dashed #[0-9a-f]{6}/, 'unknown metrics use the unavailable dashed border');
  assert.ok(html.includes('&lt;Queue &amp; load&gt;'), 'metric labels are HTML escaped');
  assert.ok(html.includes('meter &lt;missing&gt;'), 'metric notes are HTML escaped');
  assert.ok(html.includes('slot &lt;owner-slot&gt; · generation full &amp; final'), 'header values are HTML escaped');
  assert.ok(!html.includes('<Queue & load>'), 'raw metric markup is never emitted');

  const fake = fakeChromium();
  const captured = await captureReportPng({ html, chromium: fake.chromium, timeoutMs: 1_000 });
  assert.deepEqual(captured, Buffer.from('png-bytes'));
  assert.deepEqual(fake.calls.launch, [{ headless: true }]);
  assert.deepEqual(fake.calls.contexts, [{
    viewport: { width: PHONE_WIDTH, height: PHONE_HEIGHT },
    deviceScaleFactor: DEVICE_SCALE,
    colorScheme: 'dark'
  }]);
  assert.equal(fake.calls.routes.length, 1);
  assert.equal(fake.calls.routes[0][0], '**/*', 'all network requests are intercepted');
  let aborted = false;
  fake.calls.routes[0][1]({ abort: () => { aborted = true; } });
  assert.equal(aborted, true, 'the route handler aborts intercepted network requests');
  assert.deepEqual(fake.calls.contents, [[html, { waitUntil: 'load', timeout: 1_000 }]]);
  assert.deepEqual(fake.calls.screenshots, [{ fullPage: true, type: 'png' }]);
  assert.equal(fake.calls.contextCloses, 1);
  assert.equal(fake.calls.browserCloses, 1, 'the browser closes after a successful capture');

  const combined = fakeChromium(Buffer.from('combined'));
  const result = await renderReportImage({
    state: state(),
    metrics: [{ label: 'Runs', value: 2, note: 'observed', tone: 'info' }],
    chromium: combined.chromium
  });
  assert.deepEqual(result.image, Buffer.from('combined'));
  assert.equal(result.bytes, 8);
  assert.match(result.html, /Runs/);

  await assert.rejects(captureReportPng({ html: '' }), error => {
    assert.equal(error.code, 'AGENT_DIGEST_IMAGE_NO_HTML');
    return true;
  });

  // A transient loader failure is not "not installed" and is not latched.
  // The following successful lookup is cached, preserving the dependency
  // lookup cost that the cache exists to avoid.
  const originalRequire = Module.prototype.require;
  let playwrightLookups = 0;
  const dependency = fakeChromium(Buffer.from('dependency'));
  Module.prototype.require = function requireWithBusyFirst(id) {
    if (id !== 'playwright') return originalRequire.apply(this, arguments);
    playwrightLookups += 1;
    if (playwrightLookups === 1) {
      throw Object.assign(new Error("Cannot find module 'playwright'"), { code: 'MODULE_NOT_FOUND' });
    }
    if (playwrightLookups === 2) throw Object.assign(new Error('loader busy'), { code: 'EBUSY' });
    return { chromium: dependency.chromium };
  };
  try {
    await assert.rejects(captureReportPng({ html }), error =>
      error.code === 'AGENT_DIGEST_IMAGE_PLAYWRIGHT_MISSING');
    await assert.rejects(captureReportPng({ html }), error => {
      assert.equal(error.code, 'AGENT_DIGEST_IMAGE_PLAYWRIGHT_LOOKUP_INDETERMINATE');
      assert.match(error.message, /NOT claiming that Playwright is absent/);
      return true;
    });
    assert.deepEqual(await captureReportPng({ html }), Buffer.from('dependency'),
      'a transient lookup failure is retried');
    assert.deepEqual(await captureReportPng({ html }), Buffer.from('dependency'));
    assert.equal(playwrightLookups, 3, 'only the successful dependency lookup is cached');
  } finally {
    Module.prototype.require = originalRequire;
  }
  assert.equal(DEFAULT_TIMEOUT_MS, 45_000);

  process.stdout.write('PASS agent-digest render-image behaviour\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

'use strict';

// First focused behavioural test for src/lib/agent-digest/render.js. Exercise
// the public surface with concrete values rather than inspecting its source or
// duplicating its implementation.

const assert = require('node:assert/strict');

const {
  buildQuickMetrics,
  duration,
  htmlEscape,
  mix
} = require('../src/lib/agent-digest/render');

let checks = 0;
function check(label, run) {
  run();
  checks += 1;
  process.stdout.write(`  ok ${label}\n`);
}

check('duration renders minute, hour, and day boundaries without rounding up', () => {
  assert.equal(duration(-1), 'unknown');
  assert.equal(duration(59_999), '0m');
  assert.equal(duration(60 * 60_000 + 59 * 60_000), '1h 59m');
  assert.equal(duration(49 * 60 * 60_000), '2d 1h');
});

check('htmlEscape makes every HTML-significant character inert', () => {
  assert.equal(
    htmlEscape(`<script title="owner's">run & report</script>`),
    '&lt;script title=&quot;owner&#39;s&quot;&gt;run &amp; report&lt;/script&gt;'
  );
  assert.equal(htmlEscape(null), '');
});

check('mix blends colours and clamps out-of-range blend factors', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#123456', '#abcdef', -4), '#123456');
  assert.equal(mix('#123456', '#abcdef', 4), '#abcdef');
});

check('quick metrics distinguish recorded zeroes from unavailable values', () => {
  const unavailable = buildQuickMetrics({ queue: null, observed: {} });
  assert.deepEqual(
    unavailable.slice(0, 4).map(metric => [metric.key, metric.value, metric.tone]),
    [
      ['inFlight', null, 'unavailable'],
      ['blocked', null, 'unavailable'],
      ['active', null, 'unavailable'],
      ['queueDepth', null, 'neutral']
    ]
  );

  const recorded = buildQuickMetrics({
    queue: { inFlight: [], blocked: [], depth: 0, phases: [] },
    observed: {
      runs: { active: 0, openHelp: 0 },
      auditState: 'verified',
      provenance: { state: 'signed' },
      freshness: 'fresh',
      eventsInWindow: 0,
      meters: { state: 'verified-durable', subscriptionUsage: 'recorded' }
    }
  });
  assert.deepEqual(
    recorded.map(metric => [metric.key, metric.value, metric.tone]),
    [
      ['inFlight', 0, 'good'],
      ['blocked', 0, 'good'],
      ['active', 0, 'good'],
      ['queueDepth', 0, 'neutral'],
      ['ledger', 'verified', 'good'],
      ['auditEvents', 0, 'neutral'],
      ['openHelp', 0, 'good'],
      ['meters', 'verified-durable', 'good']
    ]
  );
});

process.stdout.write(`agent-digest render: ${checks} checks passed\n`);

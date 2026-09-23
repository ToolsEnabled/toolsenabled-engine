'use strict';

// A --serve cycle that examined 0 candidates while skipping 47 wrote the same
// quiet intent-cycle line as a healthy caught-up cycle -- a checker checking
// NOTHING was indistinguishable from a checker with nothing to check.
// tools/intent-check.js now emits a distinct intent-serve-starved event
// (carrying the skip-reason histogram) once every eligible item has been
// skipped and zero examined for STARVED_AFTER_CYCLES consecutive cycles, and
// keeps serving. This proves the event actually fires -- from the serve loop
// itself, not just the helper -- and that real work or genuine idleness
// resets it.
//
// Run: node tests/intent-check-starvation.js

const assert = require('node:assert/strict');
const fs = require('node:fs');

const tool = require('../tools/intent-check.js');
const killSwitch = require('../src/lib/kill-switch.js');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const checkAsync = async (label, fn) => { await fn(); checks += 1; void label; };

const skippedItems = (count) => Array.from({ length: count }, (unused, index) => ({
  kind: 'lane', workId: `lane-${index}`, requestId: null,
  reason: index % 2 === 0
    ? 'queue item names no owner request in its BUILD-QUEUE heading, so there is no verbatim to grade against'
    : 'ledger has no R999'
}));

const starvedOutcome = (count) => ({ discovered: 0, skipped: skippedItems(count), results: [] });

// ---------------------------------------------------------------------------
// The monitor: threshold, histogram, reset, re-emission
// ---------------------------------------------------------------------------

check('the monitor stays quiet below the threshold and fires AT it with the histogram', () => {
  const monitor = tool.makeStarvationMonitor({ threshold: 3 });
  assert.equal(monitor(starvedOutcome(47)), null);
  assert.equal(monitor(starvedOutcome(47)), null);
  const event = monitor(starvedOutcome(47));
  assert.ok(event, 'the third consecutive starved cycle must be loud');
  assert.equal(event.consecutiveStarvedCycles, 3);
  assert.equal(event.examined, 0);
  assert.equal(event.skipped, 47);
  const bucketed = Object.values(event.skipReasons).reduce((sum, n) => sum + n, 0);
  assert.equal(bucketed, 47, 'every skip lands in exactly one histogram bucket');
  assert.equal(Object.keys(event.skipReasons).length, 2, 'two distinct reasons, two buckets');
});

check('examining ANY item resets the count, and an idle cycle (nothing skipped) is healthy, not starved', () => {
  const monitor = tool.makeStarvationMonitor({ threshold: 2 });
  assert.equal(monitor(starvedOutcome(5)), null);
  assert.equal(monitor({ discovered: 1, skipped: skippedItems(5), results: [{ workId: 'lane-x' }] }), null,
    'a cycle that examined work is never starved, whatever it also skipped');
  assert.equal(monitor(starvedOutcome(5)), null, 'the count restarted after real work');
  assert.ok(monitor(starvedOutcome(5)), 'two NEW consecutive starved cycles fire again');
  const idleMonitor = tool.makeStarvationMonitor({ threshold: 1 });
  assert.equal(idleMonitor({ discovered: 0, skipped: [], results: [] }), null,
    'caught-up (nothing to skip, nothing to examine) must stay quiet');
});

check('a long starvation re-emits at each threshold multiple, not every cycle', () => {
  const monitor = tool.makeStarvationMonitor({ threshold: 2 });
  const fired = [];
  for (let index = 0; index < 6; index += 1) {
    const event = monitor(starvedOutcome(3));
    if (event) fired.push(event.consecutiveStarvedCycles);
  }
  assert.deepEqual(fired, [2, 4, 6]);
});

// ---------------------------------------------------------------------------
// The serve loop itself, which is where the state was invisible
// ---------------------------------------------------------------------------

// serve() sleeps between cycles on an UNREF'D timer; with nothing else on the
// event loop Node would exit 0 mid-await and abandon the async checks below as
// a silent false pass -- the exact failure shape this file exists to close.
// A ref'd keep-alive holds the loop open, and the exit guard turns an
// abandoned run into a failure instead of a pass.
let finished = false;
const keepAlive = setInterval(() => {}, 1000);
process.on('exit', () => {
  if (!finished && !process.exitCode) {
    console.error('intent-check-starvation: async checks were abandoned before completing -- refusing to exit 0');
    process.exitCode = 1;
  }
});

(async () => {
  assert.equal(fs.existsSync(tool.STOP_FILE), false,
    `precondition failed: ${tool.STOP_FILE} exists, so serve() would exit before any cycle; run --clear-stop first`);
  assert.equal(killSwitch.status().active, false,
    'precondition failed: KILLSWITCH is active, so serve() would exit before any cycle');

  await checkAsync('serve() emits intent-serve-starved once everything is skipped for N consecutive cycles', async () => {
    const events = [];
    const logger = (event, detail) => events.push({ event, ...detail });
    const cyclesRun = await tool.serve({
      logger, model: 'scripted', effort: 'low', timeoutMs: 1000, maxPerCycle: 4,
      pollMs: 1, maxCycles: tool.STARVED_AFTER_CYCLES, dryRun: false,
      runCycle: async () => starvedOutcome(47)
    });
    assert.equal(cyclesRun, tool.STARVED_AFTER_CYCLES);
    const starved = events.filter(entry => entry.event === 'intent-serve-starved');
    assert.equal(starved.length, 1, 'fires exactly once at the threshold within this window');
    assert.equal(starved[0].consecutiveStarvedCycles, tool.STARVED_AFTER_CYCLES);
    assert.equal(starved[0].skipped, 47);
    assert.ok(starved[0].skipReasons && Object.keys(starved[0].skipReasons).length > 0, 'the histogram rides the event');
    assert.equal(events[events.length - 1].event, 'intent-serve-stopped',
      'starvation is made visible, never turned into a stop or a throw');
  });

  await checkAsync('a serve window that examines work never emits the starved event', async () => {
    const events = [];
    const logger = (event, detail) => events.push({ event, ...detail });
    await tool.serve({
      logger, model: 'scripted', effort: 'low', timeoutMs: 1000, maxPerCycle: 4,
      pollMs: 1, maxCycles: tool.STARVED_AFTER_CYCLES + 1, dryRun: false,
      runCycle: async () => ({ discovered: 47, skipped: skippedItems(46), results: [{ workId: 'lane-x', verdict: 'PASS' }] })
    });
    assert.deepEqual(events.filter(entry => entry.event === 'intent-serve-starved'), [],
      'skipping SOME while examining others is normal bounded operation, not starvation');
  });

  console.log(`Intent-check starvation tests passed (${checks} checks; a starved serve loop is loud and distinct, a working or idle one stays quiet).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  finished = true;
  clearInterval(keepAlive);
});

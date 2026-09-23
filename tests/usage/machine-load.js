'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const {
  MIN_SAMPLE_INTERVAL_MS,
  MAX_SAMPLE_INTERVAL_MS,
  UNKNOWN_REASON,
  createMachineLoadReader
} = require('../../src/lib/usage/machine-load');

let checks = 0;
function check(label, fn) {
  const out = fn();
  if (out && typeof out.then === 'function') throw new Error('use checkAsync for async cases');
  checks += 1;
  console.log(`  ok  ${label}`);
}
async function checkAsync(label, fn) {
  await fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

function core(idle, total) {
  // total = user+nice+sys+idle+irq; put every non-idle tick into `sys` so
  // the fixture stays simple while still exercising the real times shape.
  return { model: 'fixture', speed: 0, times: { user: 0, nice: 0, sys: total - idle, idle, irq: 0 } };
}

function sequencedReadCpus(samples) {
  let call = 0;
  return () => {
    const sample = samples[Math.min(call, samples.length - 1)];
    call += 1;
    return sample;
  };
}

function noWait() {
  return Promise.resolve();
}

(async function run() {
  console.log('machine load (os.cpus delta)');

  check('constructor rejects a non-function readCpus/wait/now', () => {
    assert.throws(() => createMachineLoadReader({ readCpus: 'nope' }), TypeError);
    assert.throws(() => createMachineLoadReader({ wait: 'nope' }), TypeError);
    assert.throws(() => createMachineLoadReader({ now: 'nope' }), TypeError);
  });

  check('constructor rejects a sampleIntervalMs outside the bounded range', () => {
    assert.throws(() => createMachineLoadReader({ sampleIntervalMs: MIN_SAMPLE_INTERVAL_MS - 1 }), TypeError);
    assert.throws(() => createMachineLoadReader({ sampleIntervalMs: MAX_SAMPLE_INTERVAL_MS + 1 }), TypeError);
    assert.throws(() => createMachineLoadReader({ sampleIntervalMs: NaN }), TypeError);
  });

  await checkAsync('a readCpus that throws ENOENT-shaped is UNKNOWN, not a fabricated 0%', async () => {
    const readMachineLoad = createMachineLoadReader({
      readCpus: () => { throw Object.assign(new Error('no cpu info'), { code: 'ENOENT' }); },
      wait: noWait
    });
    const result = await readMachineLoad();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, UNKNOWN_REASON.CPU_SAMPLE_UNAVAILABLE);
  });

  await checkAsync('an empty core list is UNKNOWN, never treated as zero cores of zero load', async () => {
    const readMachineLoad = createMachineLoadReader({ readCpus: () => [], wait: noWait });
    const result = await readMachineLoad();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, UNKNOWN_REASON.CORE_COUNT_UNAVAILABLE);
  });

  await checkAsync('a core entry missing the times shape is shape drift, not a guess', async () => {
    const readMachineLoad = createMachineLoadReader({ readCpus: () => [{ model: 'x' }], wait: noWait });
    const result = await readMachineLoad();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, UNKNOWN_REASON.CPU_SAMPLE_SHAPE_DRIFT);
  });

  await checkAsync('negative or overflowing counters are shape drift, not a definite utilization', async () => {
    for (const times of [
      { user: -1, nice: 0, sys: 0, idle: 1, irq: 0 },
      { user: Number.MAX_VALUE, nice: Number.MAX_VALUE, sys: 0, idle: 0, irq: 0 }
    ]) {
      const readMachineLoad = createMachineLoadReader({
        readCpus: () => [{ model: 'invalid', times }],
        wait: noWait
      });
      const result = await readMachineLoad();
      assert.equal(result.status, 'UNKNOWN');
      assert.equal(result.reason, UNKNOWN_REASON.CPU_SAMPLE_SHAPE_DRIFT);
    }
  });

  await checkAsync('core count changing between the two samples is inconsistent, not re-scoped silently', async () => {
    const readMachineLoad = createMachineLoadReader({
      readCpus: sequencedReadCpus([
        [core(1000, 2000)],
        [core(1000, 2000), core(1000, 2000)]
      ]),
      wait: noWait
    });
    const result = await readMachineLoad();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, UNKNOWN_REASON.CPU_SAMPLE_INCONSISTENT);
  });

  await checkAsync('a counter that moves backward is inconsistent, never reported as negative or clamped load', async () => {
    const readMachineLoad = createMachineLoadReader({
      readCpus: sequencedReadCpus([
        [core(1000, 2000)],
        [core(1200, 1900)] // idle went UP while total went DOWN: impossible for a real counter
      ]),
      wait: noWait
    });
    const result = await readMachineLoad();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, UNKNOWN_REASON.CPU_SAMPLE_INCONSISTENT);
  });

  await checkAsync('zero elapsed CPU time is inconsistent, not a measured 0% idle machine', async () => {
    const readMachineLoad = createMachineLoadReader({
      readCpus: sequencedReadCpus([
        [core(1000, 2000)],
        [core(1000, 2000)] // identical: no time passed in the counters at all
      ]),
      wait: noWait
    });
    const result = await readMachineLoad();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, UNKNOWN_REASON.CPU_SAMPLE_INCONSISTENT);
  });

  await checkAsync('a clean two-sample delta measures utilization as a weighted aggregate, not an average of percentages', async () => {
    // Core A: totalDelta=100, idleDelta=0   -> 100% busy, small weight
    // Core B: totalDelta=900, idleDelta=900 -> 0% busy, large weight
    // Naive average of per-core percentages would say 50%; the weighted
    // aggregate (sum idle / sum total) says 10%, and that is what a
    // dispatch decision should actually see.
    const readMachineLoad = createMachineLoadReader({
      readCpus: sequencedReadCpus([
        [core(0, 0), core(0, 0)],
        [core(0, 100), core(900, 900)]
      ]),
      wait: noWait,
      now: () => 4242
    });
    const result = await readMachineLoad();
    assert.equal(result.status, 'MEASURED');
    assert.equal(result.source, 'os-cpus-delta');
    assert.equal(result.coreCount, 2);
    assert.equal(result.utilizationPercent, 10);
    assert.deepEqual(result.perCoreUtilizationPercent, [100, 0]);
    assert.equal(result.observedAtMs, 4242);
  });

  await checkAsync('the configured sampleIntervalMs is echoed back, not silently substituted', async () => {
    const readMachineLoad = createMachineLoadReader({
      readCpus: sequencedReadCpus([[core(0, 0)], [core(50, 100)]]),
      wait: noWait,
      sampleIntervalMs: 333
    });
    const result = await readMachineLoad();
    assert.equal(result.sampleIntervalMs, 333);
  });

  // Against the real machine, not a fixture -- must produce an honest result
  // either way, never throw and never invent a number.
  await checkAsync('reads real CPU utilization on this machine, or says precisely why not', async () => {
    const readMachineLoad = createMachineLoadReader({ sampleIntervalMs: 150 });
    const result = await readMachineLoad();
    if (result.status === 'MEASURED') {
      assert.equal(result.source, 'os-cpus-delta');
      assert.equal(result.coreCount, os.cpus().length, 'core count should match the live machine');
      assert.ok(result.utilizationPercent >= 0 && result.utilizationPercent <= 100, 'utilization must be a real percent');
      assert.equal(result.perCoreUtilizationPercent.length, result.coreCount);
      for (const p of result.perCoreUtilizationPercent) {
        assert.ok(p === null || (p >= 0 && p <= 100), 'each per-core reading is null or a real percent, never fabricated');
      }
      console.log(`      (real machine: ${result.coreCount} cores, ${result.utilizationPercent}% utilization over ${result.sampleIntervalMs}ms)`);
    } else {
      assert.ok(Object.values(UNKNOWN_REASON).includes(result.reason), `named reason: ${result.reason}`);
      console.log(`      (real machine load unavailable: ${result.reason} -- ${result.detail})`);
    }
  });

  console.log(`\n${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

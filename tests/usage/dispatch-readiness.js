// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-usage-dispatch-readiness-js):
// - SAME-CODE ORACLE: every verdict/reason assertion formerly derived its
//   expected value from the module under test's exported VERDICT/REASON
//   objects. Each affected contract member was independently mutated from X
//   to MUTATED_X: DISPATCH_OK, HOLD, UNKNOWN,
//   CPU_UTILIZATION_ABOVE_THRESHOLD, AI_ALLOWANCE_ABOVE_THRESHOLD,
//   WITHIN_THRESHOLDS, MACHINE_LOAD_UNKNOWN, AI_ALLOWANCE_UNKNOWN,
//   MACHINE_LOAD_SOURCE_THREW, MACHINE_LOAD_RESPONSE_INVALID,
//   AI_ALLOWANCE_SOURCE_THREW, AI_ALLOWANCE_RESPONSE_INVALID, and
//   AI_ALLOWANCE_NO_BINDING_LIMIT. Before the fix, the WITHIN_THRESHOLDS
//   mutation left the complete file green (`16 checks passed`). Expectations
//   below are now independent contract literals. After the fix, every one of
//   the 13 independent mutations exited 1 at its first affected assertion,
//   with RED output `AssertionError [ERR_ASSERTION]`; for example the
//   WITHIN_THRESHOLDS mutation reported:
//     AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
//     + actual - expected
//       [
//     +   'MUTATED_WITHIN_THRESHOLDS'
//     -   'WITHIN_THRESHOLDS'
//       ]
// - NOT-FOUND empty loop/forEach; exit-status/truthy-return-only evidence;
//   swallowed failure via try/catch or optional chaining; mock of the subject;
//   platform skip or silent precondition guard.
// - PRECONDITIONS: none unmet. The product mutation was restored byte-for-byte
//   (SHA-256 9d00439d3e83469cacbcacbec9577503c9f362e5ceae8dd40e516ba7d1d67937),
//   and the restored-source run ended with `16 checks passed`.

'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createDispatchReadinessReader } = require('../../src/lib/usage/dispatch-readiness');
const { createMachineLoadReader } = require('../../src/lib/usage/machine-load');
const { createClaudeCachedUtilizationAdapter } = require('../../src/lib/usage/adapters/claude-cached-utilization');
const { createOrderedClaudeUsageSource } = require('../../src/lib/usage/claude-usage-source');

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

function measuredLoad(utilizationPercent) {
  return async () => Object.freeze({ status: 'MEASURED', source: 'fixture', coreCount: 8, utilizationPercent, observedAtMs: 1 });
}
function unknownLoad(reason) {
  return async () => Object.freeze({ status: 'UNKNOWN', reason, detail: null });
}
function measuredAllowance(percent, kind = 'weekly_scoped') {
  return async () => Object.freeze({ status: 'MEASURED', bindingLimit: Object.freeze({ kind, percent }) });
}
function unknownAllowance(reason) {
  return async () => Object.freeze({ status: 'UNKNOWN', reason, detail: null });
}

(async function run() {
  console.log('dispatch readiness (load + AI allowance combined)');

  check('constructor rejects missing readMachineLoad/readAiAllowance', () => {
    assert.throws(() => createDispatchReadinessReader({ readAiAllowance: measuredAllowance(1) }), TypeError);
    assert.throws(() => createDispatchReadinessReader({ readMachineLoad: measuredLoad(1) }), TypeError);
  });

  check('constructor rejects out-of-range thresholds', () => {
    assert.throws(() => createDispatchReadinessReader({
      readMachineLoad: measuredLoad(1), readAiAllowance: measuredAllowance(1),
      thresholds: { maxCpuUtilizationPercent: 101 }
    }), TypeError);
    assert.throws(() => createDispatchReadinessReader({
      readMachineLoad: measuredLoad(1), readAiAllowance: measuredAllowance(1),
      thresholds: { maxAiAllowanceUsedPercent: -1 }
    }), TypeError);
  });

  await checkAsync('both comfortably under threshold -> DISPATCH_OK', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: measuredLoad(20),
      readAiAllowance: measuredAllowance(30)
    });
    const result = await read();
    assert.equal(result.verdict, 'DISPATCH_OK');
    assert.deepEqual(result.reasons, ['WITHIN_THRESHOLDS']);
    assert.equal(result.load.utilizationPercent, 20);
    assert.equal(result.aiAllowance.usedPercent, 30);
    assert.equal(result.aiAllowance.remainingPercent, 70);
  });

  await checkAsync('CPU at/over threshold -> HOLD naming the CPU reason', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: measuredLoad(90),
      readAiAllowance: measuredAllowance(10)
    });
    const result = await read();
    assert.equal(result.verdict, 'HOLD');
    assert.deepEqual(result.reasons, ['CPU_UTILIZATION_ABOVE_THRESHOLD']);
  });

  await checkAsync('AI allowance at/over threshold -> HOLD naming the allowance reason', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: measuredLoad(10),
      readAiAllowance: measuredAllowance(95)
    });
    const result = await read();
    assert.equal(result.verdict, 'HOLD');
    assert.deepEqual(result.reasons, ['AI_ALLOWANCE_ABOVE_THRESHOLD']);
  });

  await checkAsync('both over threshold -> HOLD naming both reasons', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: measuredLoad(99),
      readAiAllowance: measuredAllowance(99)
    });
    const result = await read();
    assert.equal(result.verdict, 'HOLD');
    assert.deepEqual(result.reasons, ['CPU_UTILIZATION_ABOVE_THRESHOLD', 'AI_ALLOWANCE_ABOVE_THRESHOLD']);
  });

  await checkAsync('custom thresholds are honoured exactly, not the built-in defaults', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: measuredLoad(50),
      readAiAllowance: measuredAllowance(50),
      thresholds: { maxCpuUtilizationPercent: 40, maxAiAllowanceUsedPercent: 95 }
    });
    const result = await read();
    assert.equal(result.verdict, 'HOLD');
    assert.deepEqual(result.reasons, ['CPU_UTILIZATION_ABOVE_THRESHOLD']);
  });

  await checkAsync('load UNKNOWN -> combined verdict is UNKNOWN, never answered from the allowance half alone', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: unknownLoad('CPU_SAMPLE_INCONSISTENT'),
      readAiAllowance: measuredAllowance(10)
    });
    const result = await read();
    assert.equal(result.verdict, 'UNKNOWN');
    assert.ok(result.reasons.includes('MACHINE_LOAD_UNKNOWN'));
    assert.equal(result.load.status, 'UNKNOWN');
    assert.equal(result.load.reason, 'MACHINE_LOAD_UNKNOWN');
  });

  await checkAsync('allowance UNKNOWN -> combined verdict is UNKNOWN, never answered from the load half alone', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: measuredLoad(10),
      readAiAllowance: unknownAllowance('CLAUDE_CACHE_STALE')
    });
    const result = await read();
    assert.equal(result.verdict, 'UNKNOWN');
    assert.ok(result.reasons.includes('AI_ALLOWANCE_UNKNOWN'));
  });

  await checkAsync('both UNKNOWN -> combined verdict names both', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: unknownLoad('CPU_SAMPLE_UNAVAILABLE'),
      readAiAllowance: unknownAllowance('CLAUDE_CACHE_ABSENT')
    });
    const result = await read();
    assert.equal(result.verdict, 'UNKNOWN');
    assert.deepEqual(result.reasons, ['MACHINE_LOAD_UNKNOWN', 'AI_ALLOWANCE_UNKNOWN']);
  });

  await checkAsync('a MEASURED allowance with no unambiguous binding limit is UNKNOWN, never a silent 0%', async () => {
    // Mirrors claude-cached-utilization.js's real contract: MEASURED with
    // bindingLimit: null happens when zero or more than one window is active.
    const read = createDispatchReadinessReader({
      readMachineLoad: measuredLoad(10),
      readAiAllowance: async () => Object.freeze({ status: 'MEASURED', bindingLimit: null })
    });
    const result = await read();
    assert.equal(result.verdict, 'UNKNOWN');
    assert.equal(result.aiAllowance.status, 'UNKNOWN');
    assert.equal(result.aiAllowance.reason, 'AI_ALLOWANCE_NO_BINDING_LIMIT');
    assert.deepEqual(result.reasons, ['AI_ALLOWANCE_NO_BINDING_LIMIT']);
  });

  await checkAsync('a NOT_APPLICABLE binding limit (percent: null) is UNKNOWN, never rendered as 0%', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: measuredLoad(10),
      readAiAllowance: async () => Object.freeze({
        status: 'MEASURED',
        bindingLimit: Object.freeze({ kind: 'weekly_opus', percent: null })
      })
    });
    const result = await read();
    assert.equal(result.verdict, 'UNKNOWN');
    assert.equal(result.aiAllowance.reason, 'AI_ALLOWANCE_NO_BINDING_LIMIT');
    assert.deepEqual(result.reasons, ['AI_ALLOWANCE_NO_BINDING_LIMIT']);
  });

  await checkAsync('a load source that throws is UNKNOWN, not a crash and not a fabricated figure', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: async () => { throw new Error('boom'); },
      readAiAllowance: measuredAllowance(10)
    });
    const result = await read();
    assert.equal(result.verdict, 'UNKNOWN');
    assert.equal(result.load.reason, 'MACHINE_LOAD_SOURCE_THREW');
    assert.deepEqual(result.reasons, ['MACHINE_LOAD_SOURCE_THREW']);
  });

  await checkAsync('an allowance source that throws is UNKNOWN, not a crash and not a fabricated figure', async () => {
    const read = createDispatchReadinessReader({
      readMachineLoad: measuredLoad(10),
      readAiAllowance: async () => { throw new Error('boom'); }
    });
    const result = await read();
    assert.equal(result.verdict, 'UNKNOWN');
    assert.equal(result.aiAllowance.reason, 'AI_ALLOWANCE_SOURCE_THREW');
    assert.deepEqual(result.reasons, ['AI_ALLOWANCE_SOURCE_THREW']);
  });

  await checkAsync('a malformed response shape from either source is UNKNOWN, never guessed at', async () => {
    const readBadLoad = createDispatchReadinessReader({
      readMachineLoad: async () => ({ nonsense: true }),
      readAiAllowance: measuredAllowance(10)
    });
    const badLoadResult = await readBadLoad();
    assert.equal(badLoadResult.verdict, 'UNKNOWN');
    assert.deepEqual(badLoadResult.reasons, ['MACHINE_LOAD_RESPONSE_INVALID']);

    const readBadAllowance = createDispatchReadinessReader({
      readMachineLoad: measuredLoad(10),
      readAiAllowance: async () => 'not an object'
    });
    const badAllowanceResult = await readBadAllowance();
    assert.equal(badAllowanceResult.verdict, 'UNKNOWN');
    assert.deepEqual(badAllowanceResult.reasons, ['AI_ALLOWANCE_RESPONSE_INVALID']);
  });

  // Against the real machine and the real Claude usage cache on this box, not
  // fixtures -- must produce an honest, well-shaped verdict either way.
  await checkAsync('combines the real CPU signal with the real Claude usage cache on this machine, or says precisely why not', async () => {
    const readMachineLoad = createMachineLoadReader({ sampleIntervalMs: 150 });
    const realClaudeJson = path.join(os.homedir(), '.claude.json');
    const readAiAllowance = createOrderedClaudeUsageSource([
      {
        name: 'claude-cached-utilization',
        read: createClaudeCachedUtilizationAdapter({
          readCache: () => fs.readFileSync(realClaudeJson, 'utf8'),
          freshnessBudgetMs: 365 * 24 * 60 * 60_000
        })
      }
    ]);
    const read = createDispatchReadinessReader({ readMachineLoad, readAiAllowance });
    const result = await read();

    assert.ok(['DISPATCH_OK', 'HOLD', 'UNKNOWN'].includes(result.verdict), `named verdict: ${result.verdict}`);
    assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0, 'a verdict always carries at least one named reason');
    assert.ok(['MEASURED', 'UNKNOWN'].includes(result.load.status));
    assert.ok(['MEASURED', 'UNKNOWN'].includes(result.aiAllowance.status));
    if (result.verdict !== 'UNKNOWN') {
      // A non-UNKNOWN verdict is only honest if BOTH inputs actually resolved.
      assert.equal(result.load.status, 'MEASURED');
      assert.equal(result.aiAllowance.status, 'MEASURED');
    }
    console.log(`      (real machine: verdict=${result.verdict} reasons=[${result.reasons.join(', ')}] load=${result.load.status}${result.load.status === 'MEASURED' ? `(${result.load.utilizationPercent}%)` : `(${result.load.reason})`} aiAllowance=${result.aiAllowance.status}${result.aiAllowance.status === 'MEASURED' ? `(${result.aiAllowance.usedPercent}% of ${result.aiAllowance.bindingLimitKind})` : `(${result.aiAllowance.reason})`})`);
  });

  console.log(`\n${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

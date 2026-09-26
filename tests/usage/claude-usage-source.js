// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-usage-claude-usage-source-js):
// - FOUND shape 6 at the reason assertions: their expected values came from
//   UNKNOWN_REASON, the same product object used to construct the actual values.
//   Mutations applied separately: prefix STALE, FUTURE_TIMESTAMP, SHAPE_DRIFT,
//   CACHE_ABSENT, KEY_ABSENT, and CACHE_UNPARSEABLE with "MUTANT_". Before the
//   fix, mutating CACHE_ABSENT stayed green: "17 checks passed". After the fix,
//   every mutation exited 1; representative RED output for each was
//   "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"
//   followed respectively by "+ 'MUTANT_CLAUDE_CACHE_STALE'",
//   "+ 'MUTANT_CLAUDE_CACHE_FUTURE_TIMESTAMP'",
//   "+ 'MUTANT_CLAUDE_CACHE_SHAPE_DRIFT'",
//   "+ 'MUTANT_CLAUDE_CACHE_ABSENT'",
//   "+ 'MUTANT_CLAUDE_CACHE_KEY_ABSENT'", and
//   "+ 'MUTANT_CLAUDE_CACHE_UNPARSEABLE'". The real-cache accepted-reason
//   assertion was strengthened for the same defect and produced RED output
//   "AssertionError [ERR_ASSERTION]: named reason: MUTANT_CACHE_ABSENT".
// - NOT-FOUND shape 1: the malformed collection is a fixed non-empty literal;
//   the real-cache loop is preceded by a non-empty assertion and every loop
//   iteration executes one of the branch assertions.
// - NOT-FOUND shape 2: no exit-status or bare truthy-return assertion exists.
// - NOT-FOUND shape 3: no test assertion failure is swallowed; the terminal
//   catch reports the error and exits 1.
// - NOT-FOUND shape 4: injected readers provide inputs/fallbacks; no assertion
//   is made against a mock implementation of the subject being exercised.
// - NOT-FOUND shape 5: there is no skip or whole-file precondition guard.
// - RESTORATION: the product file's SHA-256 was restored byte-for-byte to
//   bb18c8a24c614a6dd76c36e491566e2b0bce02c983c8cf94020880c5c2b8e500.
//   The restored run was GREEN: "17 checks passed".
// - UNMET PRECONDITION: ~/.claude.json is absent on this machine, reported by
//   the restored run as "real cache unavailable: CLAUDE_CACHE_ABSENT".

'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {
  APPLICABILITY,
  UNKNOWN_REASON,
  createClaudeCachedUtilizationAdapter
} = require('../../src/lib/usage/adapters/claude-cached-utilization');
const { createOrderedClaudeUsageSource } = require('../../src/lib/usage/claude-usage-source');
const {
  CLAUDE_AGENT_SDK_USAGE_METHOD,
  createClaudeAgentSdkUsageReader,
  createClaudeSubscriptionAdapter
} = require('../../src/lib/usage/adapters/claude-subscription');

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

const NOW = 1785774255142 + 60_000;
const FIXTURE = {
  cachedUsageUtilization: {
    fetchedAtMs: 1785774255142,
    accountUuid: 'acct-1',
    utilization: {
      seven_day_opus: null,
      limits: [
        { kind: 'session', group: 'session', percent: 27, resets_at: '2026-08-03T21:00:00Z', scope: null, is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: 47, resets_at: '2026-08-07T04:00:00Z', scope: null, is_active: false },
        {
          kind: 'weekly_scoped', group: 'weekly', percent: 64, resets_at: '2026-08-07T04:00:00Z',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true
        },
        { kind: 'weekly_opus', group: 'weekly', percent: null, resets_at: null, scope: null, is_active: false }
      ]
    }
  }
};

function adapter(overrides = {}) {
  return createClaudeCachedUtilizationAdapter({
    readCache: () => JSON.stringify(FIXTURE),
    now: () => NOW,
    ...overrides
  });
}

(async function run() {
  console.log('claude cached utilization + ordered source');

  check('reads the binding window, which is the one actually constraining the account', () => {
    const result = adapter()();
    assert.equal(result.status, 'MEASURED');
    assert.equal(result.bindingLimit.kind, 'weekly_scoped');
    assert.equal(result.bindingLimit.percent, 64);
    assert.equal(result.bindingLimit.model, 'Fable');
  });

  check('a null window is NOT_APPLICABLE, never zero', () => {
    const result = adapter()();
    const opus = result.limits.find((l) => l.kind === 'weekly_opus');
    assert.equal(opus.applicability, APPLICABILITY.NOT_APPLICABLE);
    assert.equal(opus.percent, null, 'an inapplicable window must not be reported as 0');
  });

  check('the highest number is not mistaken for the binding one', () => {
    const result = adapter()();
    const highest = result.limits
      .filter((l) => l.applicability === APPLICABILITY.MEASURED)
      .reduce((a, b) => (b.percent > a.percent ? b : a));
    assert.equal(highest.kind, 'weekly_scoped');
    assert.equal(result.bindingLimit.kind, highest.kind);
    // and when the active flag moves, the binding limit moves with it rather
    // than staying on the largest figure
    const shifted = JSON.parse(JSON.stringify(FIXTURE));
    shifted.cachedUsageUtilization.utilization.limits[2].is_active = false;
    shifted.cachedUsageUtilization.utilization.limits[0].is_active = true;
    const moved = adapter({ readCache: () => JSON.stringify(shifted) })();
    assert.equal(moved.bindingLimit.kind, 'session');
    assert.equal(moved.bindingLimit.percent, 27);
  });

  check('duplicate keys parse rather than throwing, as node keeps the last occurrence', () => {
    // This is the shape that breaks PowerShell's parser outright.  The adapter
    // must survive it, because the real file on this machine has it.
    const dup = '{"cachedUsageUtilization":{"fetchedAtMs":1,"utilization":{"limits":[]}},'
      + '"cachedUsageUtilization":' + JSON.stringify(FIXTURE.cachedUsageUtilization) + '}';
    const result = createClaudeCachedUtilizationAdapter({ readCache: () => dup, now: () => NOW })();
    assert.equal(result.status, 'MEASURED', 'last occurrence wins and is the real payload');
    assert.equal(result.bindingLimit.percent, 64);
  });

  check('a stale cache withholds the number instead of presenting it as current', () => {
    const result = adapter({ now: () => 1785774255142 + 60 * 60_000 })();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'CLAUDE_CACHE_STALE');
    assert.equal(result.percent, undefined, 'a stale read must not carry a value at all');
  });

  check('a future-dated cache is UNKNOWN rather than fresh measured usage', () => {
    const result = adapter({ now: () => FIXTURE.cachedUsageUtilization.fetchedAtMs - 1 })();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'CLAUDE_CACHE_FUTURE_TIMESTAMP');
    assert.equal(result.ageMs, undefined, 'an untrustworthy read must not expose a negative age');
  });

  check('a cache with no fetch timestamp is UNKNOWN, because its age is unknowable', () => {
    const noStamp = { cachedUsageUtilization: { utilization: { limits: [{ kind: 'session', percent: 12 }] } } };
    const result = createClaudeCachedUtilizationAdapter({ readCache: () => JSON.stringify(noStamp), now: () => NOW })();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'CLAUDE_CACHE_SHAPE_DRIFT');
  });

  check('a malformed limit cannot be dropped from an otherwise measured result', () => {
    const partial = JSON.parse(JSON.stringify(FIXTURE));
    partial.cachedUsageUtilization.utilization.limits.push({ kind: 'unknown', percent: 81 });
    const result = adapter({ readCache: () => JSON.stringify(partial) })();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, UNKNOWN_REASON.SHAPE_DRIFT);
  });

  check('an unmeasurable clock cannot produce a definite freshness answer', () => {
    const result = adapter({ now: () => Number.NaN })();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, UNKNOWN_REASON.SHAPE_DRIFT);
  });

  check('absent file, absent key, and unparseable content each name their own reason', () => {
    const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
    assert.equal(
      createClaudeCachedUtilizationAdapter({ readCache: () => { throw enoent; } })().reason,
      'CLAUDE_CACHE_ABSENT'
    );
    assert.equal(
      createClaudeCachedUtilizationAdapter({ readCache: () => '{}' })().reason,
      'CLAUDE_CACHE_KEY_ABSENT'
    );
    assert.equal(
      createClaudeCachedUtilizationAdapter({ readCache: () => 'not json' })().reason,
      'CLAUDE_CACHE_UNPARSEABLE'
    );
  });

  await checkAsync('the primary source answers when it is available', async () => {
    const read = createOrderedClaudeUsageSource([
      { name: 'sdk', read: () => ({ status: 'MEASURED', bindingLimit: { percent: 64 } }) },
      { name: 'cache', read: adapter() }
    ]);
    const result = await read();
    assert.equal(result.answeredBy, 'sdk');
  });

  await checkAsync('the exported SDK reader shape is accepted as the primary source', async () => {
    const sdkRead = createClaudeAgentSdkUsageReader({
      [CLAUDE_AGENT_SDK_USAGE_METHOD]: async () => ({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 61.27, resets_at: null } }
      })
    });
    const read = createOrderedClaudeUsageSource([
      { name: 'sdk', read: sdkRead },
      { name: 'cache', read: adapter() }
    ]);
    const result = await read();
    assert.equal(result.answeredBy, 'sdk');
    assert.equal(result.bindingLimit.kind, 'five_hour');
    assert.equal(result.bindingLimit.percent, 61.27);
  });

  await checkAsync('a UsageReader-backed exported subscription adapter shape is accepted', async () => {
    const subscription = createClaudeSubscriptionAdapter({
      readUsage: async () => ({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 61.27, resets_at: null } }
      })
    });
    const account = { accountId: 'claude-account', provider: 'claude', lane: 'subscription-plan' };
    const read = createOrderedClaudeUsageSource([
      { name: 'subscription', read: () => subscription.read(account, { nowMs: NOW }) },
      { name: 'cache', read: adapter() }
    ]);
    const result = await read();
    assert.equal(result.answeredBy, 'subscription');
    assert.equal(result.bindingLimit.percent, 61.27);
  });

  await checkAsync('malformed MEASURED primaries fall through to a valid measured cache', async () => {
    for (const malformed of [
      { status: 'MEASURED' },
      { status: 'MEASURED', bindingLimit: null },
      { status: 'MEASURED', bindingLimit: { percent: -1 } },
      { status: 'MEASURED', bindingLimit: { percent: 101 } },
      { status: 'MEASURED', bindingLimit: { percent: Number.NaN } }
    ]) {
      const read = createOrderedClaudeUsageSource([
        { name: 'sdk', read: () => malformed },
        { name: 'cache', read: adapter() }
      ]);
      const result = await read();
      assert.equal(result.answeredBy, 'cache');
      assert.equal(result.bindingLimit.percent, 64);
      assert.equal(result.declined[0].reason, 'SOURCE_RETURNED_UNRECOGNISED_SHAPE');
    }
  });

  // The dissent's exact 3am failure mode, made impossible.
  await checkAsync('an absent primary falls through to the cache rather than reporting UNKNOWN', async () => {
    const read = createOrderedClaudeUsageSource([
      { name: 'sdk', read: () => ({ status: 'UNKNOWN', reason: 'SDK_NOT_INSTALLED' }) },
      { name: 'cache', read: adapter() }
    ]);
    const result = await read();
    assert.equal(result.status, 'MEASURED');
    assert.equal(result.answeredBy, 'cache');
    assert.equal(result.bindingLimit.percent, 64);
    assert.equal(result.declined[0].reason, 'SDK_NOT_INSTALLED', 'and it still records why the primary declined');
  });

  await checkAsync('a primary that throws does not blind the reading', async () => {
    const read = createOrderedClaudeUsageSource([
      { name: 'sdk', read: () => { throw new Error('module not found'); } },
      { name: 'cache', read: adapter() }
    ]);
    const result = await read();
    assert.equal(result.answeredBy, 'cache');
    assert.equal(result.declined[0].reason, 'SOURCE_THREW');
  });

  await checkAsync('UNKNOWN only when every source declined, and it says what each one said', async () => {
    const read = createOrderedClaudeUsageSource([
      { name: 'sdk', read: () => ({ status: 'UNKNOWN', reason: 'SDK_NOT_INSTALLED' }) },
      { name: 'cache', read: () => ({ status: 'UNKNOWN', reason: UNKNOWN_REASON.STALE }) }
    ]);
    const result = await read();
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.reason, 'ALL_CLAUDE_USAGE_SOURCES_DECLINED');
    assert.match(result.detail, /sdk: SDK_NOT_INSTALLED/);
    assert.match(result.detail, /cache: CLAUDE_CACHE_STALE/);
  });

  await checkAsync('disagreeing sources are never merged into a number nobody measured', async () => {
    const read = createOrderedClaudeUsageSource([
      { name: 'sdk', read: () => ({ status: 'MEASURED', bindingLimit: { percent: 10 } }) },
      { name: 'cache', read: () => ({ status: 'MEASURED', bindingLimit: { percent: 90 } }) }
    ]);
    const result = await read();
    assert.equal(result.bindingLimit.percent, 10, 'the first source wins outright');
    assert.equal(result.answeredBy, 'sdk');
  });

  // Against the real file on this machine, not a fixture.
  await checkAsync('reads the real cache on this machine, or says precisely why not', async () => {
    const real = path.join(os.homedir(), '.claude.json');
    const read = createClaudeCachedUtilizationAdapter({
      readCache: () => fs.readFileSync(real, 'utf8'),
      freshnessBudgetMs: 365 * 24 * 60 * 60_000
    });
    const result = read();
    if (result.status === 'MEASURED') {
      assert.ok(result.limits.length > 0);
      for (const limit of result.limits) {
        if (limit.applicability === APPLICABILITY.MEASURED) {
          assert.ok(limit.percent >= 0 && limit.percent <= 100, `${limit.kind} percent in range`);
        } else {
          assert.equal(limit.percent, null);
        }
      }
      console.log(`      (real cache: ${result.limits.length} windows, binding=${result.bindingLimit ? result.bindingLimit.kind + ' ' + result.bindingLimit.percent + '%' : 'none'})`);
    } else {
      assert.ok([
        'CLAUDE_CACHE_ABSENT',
        'CLAUDE_CACHE_UNREADABLE',
        'CLAUDE_CACHE_UNPARSEABLE',
        'CLAUDE_CACHE_KEY_ABSENT',
        'CLAUDE_CACHE_SHAPE_DRIFT',
        'CLAUDE_CACHE_FUTURE_TIMESTAMP',
        'CLAUDE_CACHE_STALE'
      ].includes(result.reason), `named reason: ${result.reason}`);
      console.log(`      (real cache unavailable: ${result.reason})`);
    }
  });

  console.log(`\n${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

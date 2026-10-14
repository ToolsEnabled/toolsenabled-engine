// EXECUTABLE CHANGE
//
// Discriminating audit (2026-08-26): the default-load assertion computed its
// expected verification time from the module's exported measurement. Mutating
// MEASURED_MS_PER_EVENT from `3900 / 34895` to `4000 / 34895` therefore left
// the original suite green: `audit-retention: 12/12 checks passed`. The added
// independent measurement anchor made that mutation red:
//
//   not ok - the default is bounded, and its disclosed cost matches the measured one
//   AssertionError [ERR_ASSERTION]: the projection must stay anchored to the measured 3,900 ms for 34,895 events
//   1146 !== 1118
//   audit-retention: 11/12 checks passed
//
// The source was then restored byte-for-byte. The restored run was green:
// `audit-retention: 12/12 checks passed`.
//
// NOT-FOUND (1): no assertion depends solely on a possibly-empty collection;
// static loop inputs are non-empty, and the preset loop is backed by a
// non-vacuous exact modes assertion. NOT-FOUND (2): no exit-status or truthy
// process-return assertion. NOT-FOUND (3): no swallowed subject failure; the
// harness catch records failure and produces a failing exit. NOT-FOUND (4):
// no mock of the subject. NOT-FOUND (5): no skip or platform precondition.
// FOUND (6): the exported measurement was used to compute the expectation;
// fixed with the independently recorded benchmark below. Unmet preconditions:
// none.

'use strict';

// RETENTION DECIDES WHEN AUDIT HISTORY LEAVES THE LIVE LEDGER.
//
// It is the trigger for the only operation in the audit system that deletes
// evidence, so the cases that matter most here are the ones where it must
// REFUSE to fire: an unreadable setting, a nonsense window, a mode nobody
// recognises. Every one of those resolves to 'forever' -- keep everything --
// because a ledger that grows too large is a visible, fixable problem, and
// history deleted on a misparsed setting is not recoverable at all.
//
// The load projections are asserted too, because the owner's directive was
// that the customer must be shown what each choice costs before choosing it.
// A disclosure that drifts away from the measured cost is worse than none.

const assert = require('node:assert/strict');
const retention = require('../src/lib/audit-retention');

const {
  DEFAULT_RETENTION, MINIMUM_EVENT_WINDOW, MINIMUM_TIME_WINDOW_MS,
  resolveRetention, retentionPlan, projectedLoad, eventWindowSlack
} = retention;

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('anything unreadable resolves to keeping everything, never to deleting', () => {
  // The whole failure philosophy of this module, in one case.
  for (const bad of [
    null, undefined, 0, 42, 'sometimes', [], {},
    { mode: 'events' },                              // no value
    { mode: 'events', value: 0 },
    { mode: 'events', value: -1 },
    { mode: 'events', value: 1.5 },
    { mode: 'nonsense', value: 1000 },
    { mode: 'time', value: null }
  ]) {
    const resolved = resolveRetention(bad);
    assert.equal(resolved.mode, 'forever',
      `${JSON.stringify(bad)} must resolve to forever, not to a guess and not to a deletion`);
    assert.equal(retentionPlan({ policy: resolved, total: 1_000_000 }).shouldRoll, false,
      'and must never trigger a roll, however large the ledger is');
  }
});

check('a window below the floor is refused rather than obeyed', () => {
  // A typo'd "10" must not strip the ledger to ten events.
  const tiny = resolveRetention({ mode: 'events', value: 10 });
  assert.equal(tiny.mode, 'forever');
  assert.equal(tiny.resolved, 'below-floor');

  const atFloor = resolveRetention({ mode: 'events', value: MINIMUM_EVENT_WINDOW });
  assert.equal(atFloor.mode, 'events', 'the floor itself is allowed');
  assert.equal(atFloor.value, MINIMUM_EVENT_WINDOW);

  const shortTime = resolveRetention({ mode: 'time', value: 1000 });
  assert.equal(shortTime.mode, 'forever');
  assert.equal(shortTime.resolved, 'below-floor');
  assert.equal(resolveRetention({ mode: 'time', value: MINIMUM_TIME_WINDOW_MS }).mode, 'time');
});

check('forever is a real choice, and it never rolls', () => {
  for (const value of ['forever', { mode: 'forever' }]) {
    const resolved = resolveRetention(value);
    assert.equal(resolved.mode, 'forever');
    assert.equal(resolved.resolved, 'explicit', 'an explicit forever is distinguishable from an unreadable one');
    const plan = retentionPlan({ policy: resolved, total: 10_000_000 });
    assert.equal(plan.shouldRoll, false);
    assert.equal(plan.reason, 'retention-forever');
  }
});

check('an event window rolls only once it is over the window by more than its slack', () => {
  const policy = resolveRetention({ mode: 'events', value: 1000 });
  const slack = eventWindowSlack(1000);
  // 2026-09-04: five percent, not one. A roll rewrites both projection files
  // for the whole window and invalidates every process's parse memo; at one
  // percent the owner's Live instance at the cap rolled every minute or two.
  assert.equal(slack, 50, 'five percent of the window, at least one, at most two thousand');
  assert.equal(eventWindowSlack(16), 1);
  assert.equal(eventWindowSlack(500000), 2000);
  assert.equal(retentionPlan({ policy, total: 999 }).shouldRoll, false);
  assert.equal(retentionPlan({ policy, total: 1000 }).shouldRoll, false, 'at the window is not over it');
  assert.equal(retentionPlan({ policy, total: 1000 + slack }).shouldRoll, false,
    'inside the slack nothing rolls: this is what keeps the roll from rewriting the projections on every append at the cap');
  const over = retentionPlan({ policy, total: 1000 + slack + 1 });
  assert.equal(over.shouldRoll, true);
  assert.equal(over.reason, 'over-event-window');
  assert.equal(over.excess, slack + 1, 'the roll brings the window back to exactly the policy value, never below it');
  assert.equal(retentionPlan({ policy, total: 5000 }).excess, 4000,
    'a large excess is still reported honestly');
});

check('a time window needs a known age, and refuses the decision without one', () => {
  const policy = resolveRetention({ mode: 'time', value: 86_400_000 });
  const now = 1_000_000_000_000;
  assert.equal(retentionPlan({ policy, total: 10, oldestOccurredAtMs: now - 1000, nowMs: now }).shouldRoll, false);
  const old = retentionPlan({ policy, total: 10, oldestOccurredAtMs: now - 86_400_001, nowMs: now });
  assert.equal(old.shouldRoll, true);
  assert.equal(old.reason, 'over-time-window');
  // A missing timestamp is not evidence that the window is still within its limit.
  assert.throws(() => retentionPlan({ policy, total: 10, nowMs: now }),
    /requires safe-integer oldestOccurredAtMs and nowMs/);
});

check('only an established empty ledger is reported as empty', () => {
  const policy = resolveRetention({ mode: 'events', value: 1000 });
  assert.equal(retentionPlan({ policy, total: 0 }).shouldRoll, false);
  for (const total of [-1, null, undefined, 1.5]) {
    assert.throws(() => retentionPlan({ policy, total }), /non-negative safe integer/);
  }
});

check('unresolved policies and load measurements cannot masquerade as definite results', () => {
  const malformed = { mode: 'events', value: undefined };
  assert.equal(retentionPlan({ policy: malformed, total: 10_000 }).reason, 'retention-forever');
  assert.equal(projectedLoad(malformed).mode, 'forever');
  const policy = resolveRetention({ mode: 'events', value: 1000 });
  for (const options of [
    { eventsPerDay: NaN }, { eventsPerDay: -1 },
    { startsPerHour: Infinity }, { startsPerHour: -1 }
  ]) {
    assert.throws(() => projectedLoad(policy, options), /non-negative finite number/);
  }
});

check('the default is bounded, and its disclosed cost matches the measured one', () => {
  const resolved = resolveRetention(DEFAULT_RETENTION);
  assert.equal(resolved.mode, 'events', 'the default must actually bound the ledger');
  const load = projectedLoad(resolved);
  assert.equal(load.bounded, true);
  assert.equal(load.events, DEFAULT_RETENTION.value);
  // Derived from the measured per-event cost, not a hand-written number.
  const expectedMs = Math.round(DEFAULT_RETENTION.value * retention.MEASURED_MS_PER_EVENT);
  assert.equal(load.verifyMs, expectedMs);
  assert.equal(load.verifyMs, 1118,
    'the projection must stay anchored to the measured 3,900 ms for 34,895 events');
  assert.ok(load.cpuPercentOfOneCore > 0 && load.cpuPercentOfOneCore < 10,
    `the default must be a genuinely small share of one core, got ${load.cpuPercentOfOneCore}%`);
  assert.ok(load.days > 1, 'and must still hold a useful amount of live history');
});

check('forever discloses that it is unbounded, and what a year of it costs', () => {
  // The disclosure exists because "forever" does not feel expensive until it
  // is. Reporting only today's cost would be the misleading answer.
  const load = projectedLoad(resolveRetention('forever'));
  assert.equal(load.bounded, false);
  assert.ok(load.afterOneYear, 'a forever choice must state where it ends up, not just where it starts');
  assert.ok(load.afterOneYear.cpuPercentOfOneCore > load.cpuPercentOfOneCore,
    'the one-year figure must be worse than the one-month figure, or the disclosure is not saying anything');
  assert.match(String(load.note), /grow/i);
});

check('a bigger window is disclosed as genuinely more expensive', () => {
  // Monotonicity: the numbers a customer compares must actually order.
  const small = projectedLoad(resolveRetention({ mode: 'events', value: 5000 }));
  const large = projectedLoad(resolveRetention({ mode: 'events', value: 50000 }));
  assert.ok(large.verifyMs > small.verifyMs);
  assert.ok(large.cpuPercentOfOneCore > small.cpuPercentOfOneCore);
  assert.ok(large.days > small.days);
});

check('load projections scale with the machine, not with a hardcoded install', () => {
  // A quiet machine and a busy one must not be told the same story.
  const policy = resolveRetention({ mode: 'events', value: 10000 });
  const quiet = projectedLoad(policy, { eventsPerDay: 100, startsPerHour: 10 });
  const busy = projectedLoad(policy, { eventsPerDay: 5000, startsPerHour: 200 });
  assert.ok(quiet.days > busy.days, 'the same window is more days of history on a quieter machine');
  assert.ok(busy.cpuPercentOfOneCore > quiet.cpuPercentOfOneCore, 'and costs more on a busier one');
});

check('every preset a customer can pick resolves, and offers both axes plus forever', () => {
  const labels = Object.keys(retention.RETENTION_PRESETS);
  const modes = new Set();
  for (const label of labels) {
    const resolved = retention.resolvePreset(label);
    assert.equal(resolved.resolved, 'explicit', `preset "${label}" must resolve explicitly, not fall back`);
    modes.add(resolved.mode);
    const load = projectedLoad(resolved);
    assert.ok(Number.isFinite(load.verifyMs) && load.verifyMs > 0,
      `preset "${label}" must be able to state what it costs`);
  }
  // The owner asked for a count, a duration, and forever. All three must be
  // reachable from the menu, or the setting does not offer what was specified.
  assert.deepEqual([...modes].sort(), ['events', 'forever', 'time']);
  assert.ok(labels.includes(retention.DEFAULT_RETENTION_LABEL), 'the default must be one of the offered options');
  assert.equal(retention.resolvePreset(retention.DEFAULT_RETENTION_LABEL).value, DEFAULT_RETENTION.value,
    'the default label and the default policy must not drift apart');
});

check('an unknown or hand-edited preset label keeps everything rather than guessing', () => {
  for (const label of ['Newest 10 events', '', null, undefined, 'forever', 'Keep Everything']) {
    const resolved = retention.resolvePreset(label);
    assert.equal(resolved.mode, 'forever',
      `an unrecognised label (${JSON.stringify(label)}) must never select a window that deletes`);
  }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-retention: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

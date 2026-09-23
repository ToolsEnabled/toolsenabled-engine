'use strict';
/* One limit per window: the weekly allowance and the five-hour allowance.
 *
 * THE CASE THIS EXISTS FOR, measured on the owner's own machine 2026-09-03.
 * Two Claude accounts sat at 90% and 91% of their WEEK, with 96% and 65% of
 * their five-hour window still free. A single 90% threshold stopped both of
 * them on the strength of the slow window alone, and the fleet was pushed off
 * accounts that had hours of immediate room left.
 *
 * The two windows are not the same kind of thing. A weekly allowance is spent
 * over days and is worth leaving early. A five-hour window refills fast enough
 * that the same figure would park an account about to be fine again. So each
 * gets its own number, and a registry naming only the old single one keeps
 * exactly the behaviour it had.
 *
 *   node --test tests/window-thresholds.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { STATUS, classifyProbe } = require('../src/lib/multi-account/health.js');

const ACCOUNT = Object.freeze({ name: 'acct', provider: 'codex', home: '.codex-acct', expectEmail: null, priority: 1 });
const IDENTITY = Object.freeze({ account: { email: 'acct@example.test', planType: 'pro' } });
const SHORT_RESET = 1_756_900_000;
const LONG_RESET = 1_757_300_000;

/* `primary` is the five-hour window, `secondary` the weekly one, exactly as
   account/rateLimits/read reports them. */
function reading(hourlyUsed, weeklyUsed) {
  return {
    rateLimits: {
      primary: { usedPercent: hourlyUsed, windowMinutes: 300, resetsAt: SHORT_RESET },
      secondary: { usedPercent: weeklyUsed, windowMinutes: 10_080, resetsAt: LONG_RESET },
    },
  };
}

const classify = (hourlyUsed, weeklyUsed, thresholds) => classifyProbe({
  account: ACCOUNT,
  accountRead: IDENTITY,
  rateLimitsResult: reading(hourlyUsed, weeklyUsed),
  ...thresholds,
});

test('one number still judges both windows, so a registry written before this behaves identically', () => {
  const spentWeek = classify(4, 90, { exhaustedAtPercent: 90 });
  assert.equal(spentWeek.status, STATUS.EXHAUSTED);
  assert.equal(spentWeek.canServe, false);

  const roomEverywhere = classify(4, 89, { exhaustedAtPercent: 90 });
  assert.equal(roomEverywhere.status, STATUS.HEALTHY);
  assert.equal(roomEverywhere.canServe, true);

  const spentHour = classify(90, 4, { exhaustedAtPercent: 90 });
  assert.equal(spentHour.status, STATUS.EXHAUSTED, 'the short window still stops an account on its own');
});

test("the owner's own accounts: a spent week with a fresh five-hour window can be given its own limit", () => {
  /* 91% of the week, 35% of the five-hour window: the owner's own account on
     the night this was written. Under one 90% number it stopped. */
  assert.equal(classify(35, 91, { exhaustedAtPercent: 90 }).status, STATUS.EXHAUSTED,
    'this is what happened on the night');

  const kept = classify(35, 91, {
    exhaustedAtPercent: 90, exhaustedAtPercentWeekly: 95, exhaustedAtPercentHourly: 90,
  });
  assert.equal(kept.status, STATUS.HEALTHY, 'a weekly limit of 95 leaves 91% of the week usable');
  assert.equal(kept.canServe, true);
});

test('each window is judged against its own limit, in both directions', () => {
  const thresholds = { exhaustedAtPercent: 90, exhaustedAtPercentHourly: 80, exhaustedAtPercentWeekly: 95 };

  const hourlyOver = classify(85, 10, thresholds);
  assert.equal(hourlyOver.status, STATUS.EXHAUSTED);
  assert.match(hourlyOver.reason, /85% of its 5-hour allowance \(threshold 80%\)/);

  const weeklyOver = classify(10, 96, thresholds);
  assert.equal(weeklyOver.status, STATUS.EXHAUSTED);
  assert.match(weeklyOver.reason, /96% of its weekly allowance \(threshold 95%\)/);

  assert.equal(classify(79, 94, thresholds).status, STATUS.HEALTHY, 'under both limits is healthy');
});

test('when both windows are past their limits the reason names the one further past', () => {
  const both = classify(99, 96, {
    exhaustedAtPercent: 90, exhaustedAtPercentHourly: 80, exhaustedAtPercentWeekly: 95,
  });
  assert.equal(both.status, STATUS.EXHAUSTED);
  assert.match(both.reason, /5-hour/, 'the short window is 19 points past its limit, the weekly only 1');
});

test('a per-window limit outside 0..100 is not a limit, and never silently becomes one', () => {
  for (const bad of [-1, 101, Number.NaN, null, undefined, '90']) {
    const answer = classify(4, 91, { exhaustedAtPercent: 90, exhaustedAtPercentWeekly: bad });
    assert.equal(answer.status, STATUS.EXHAUSTED,
      `a weekly limit of ${JSON.stringify(bad)} must fall back to the single number, which 91% is past`);
  }
});

test('an account with no valid single threshold is still not called healthy', () => {
  const answer = classify(4, 10, { exhaustedAtPercent: Number.NaN });
  assert.equal(answer.status, STATUS.TRANSIENT);
  assert.equal(answer.canServe, false,
    'a configuration failure must not collapse into "fine", which this file already guarded against');
});

/* ------------------------------------------------------------------------
 * THE SECOND HALF: the limits have to REACH the decision.
 *
 * The tests above prove classifyProbe divides the two windows correctly. They
 * passed while the feature did nothing at all, because rotation.js handed its
 * probes the single number and neither per-window field -- so every one of
 * them fell back and the account was judged exactly as before. A rule that is
 * right in the function nobody passes it to is not a rule.
 *
 * Claude is the provider this was reported on, and the Claude path never
 * touches classifyProbe: it decides in claude-allowance.js for a cached
 * reading and in rotation.js for a live one. Both are covered here.
 * ---------------------------------------------------------------------- */

const fs = require('node:fs');
const nodePath = require('node:path');
const { NOT_MEASURED, claudeAllowance } = require('../src/lib/multi-account/claude-allowance.js');

const SRC = nodePath.join(__dirname, '..', 'src', 'lib');

/* 35% of the five-hour window, 91% of the week: the owner's own account, as measured. */
function claudeCache(hourlyPercent, weeklyPercent) {
  const text = JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(),
      accountUuid: 'account-uuid-not-a-secret',
      utilization: {
        limits: [
          { kind: 'session', group: 'session', percent: hourlyPercent, severity: 'normal', resets_at: '2026-09-02T16:50:00.000000+00:00', scope: null, is_active: true },
          { kind: 'weekly_all', group: 'weekly', percent: weeklyPercent, severity: 'normal', resets_at: '2026-09-03T17:00:00.000000+00:00', scope: null, is_active: true }
        ]
      }
    }
  });
  return { readFileSync: () => text };
}

test('the Claude cache path judges each window against its own limit', () => {
  const fsImpl = claudeCache(35, 91);

  const oneNumber = claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 90 });
  assert.notEqual(oneNumber, NOT_MEASURED);
  assert.equal(oneNumber.exhausted, true, 'one 90% number stops it on the week alone: what was reported');

  const perWindow = claudeAllowance('/home/.claude-a', {
    fsImpl, exhaustedAtPercent: 90, exhaustedAtPercentHourly: 90, exhaustedAtPercentWeekly: 95
  });
  assert.equal(perWindow.exhausted, false, 'a weekly limit of 95 leaves 91% of the week usable');
  assert.equal(perWindow.usedPercent, 91,
    'the figure every surface shows is still the worst window; only the DECISION changed');

  const hourSpent = claudeAllowance('/home/.claude-a', {
    fsImpl: claudeCache(96, 10), exhaustedAtPercent: 90, exhaustedAtPercentHourly: 95, exhaustedAtPercentWeekly: 99
  });
  assert.equal(hourSpent.exhausted, true, 'the five-hour window still stops an account on its own');
});

test('a Claude registry naming only the old single field is judged exactly as before', () => {
  for (const [hourly, weekly, expected] of [[35, 91, true], [4, 89, false], [90, 4, true], [4, 90, true]]) {
    const answer = claudeAllowance('/home/.claude-a', {
      fsImpl: claudeCache(hourly, weekly), exhaustedAtPercent: 90
    });
    assert.equal(answer.exhausted, expected,
      `${hourly}% of the hour and ${weekly}% of the week under a single 90% threshold`);
  }
});

test('the canonical status reader uses readAccountUsage and the probe threshold factory', () => {
  /* The behavioral cases above prove both windows are judged independently.
     This narrow wiring guard prevents a status-only reader from silently
     reviving the old scalar path: status delegates to rotation's canonical
     reader, which constructs probes with the registry threshold object. */
  const status = fs.readFileSync(nodePath.join(SRC, 'status-injection.js'), 'utf8');
  const rotation = fs.readFileSync(nodePath.join(SRC, 'multi-account', 'rotation.js'), 'utf8');
  const registry = fs.readFileSync(nodePath.join(SRC, 'multi-account', 'registry.js'), 'utf8');
  assert.match(status, /readCanonicalQuota[\s\S]*require\('\.\/multi-account\/rotation'\)[\s\S]*readAccountUsage/,
    'status injection no longer delegates quota reads to rotation.readAccountUsage');
  assert.match(rotation, /function readAccountUsage\([\s\S]*defaultProbeFor\([\s\S]*exhaustionThresholds\(registry\)/,
    'canonical account usage no longer reaches the per-account probe factory with registry thresholds');
  assert.match(registry, /function exhaustionThresholds\(source\)/,
    'the canonical threshold factory is missing');
  for (const [rel, source] of [['status-injection.js', status], ['multi-account/rotation.js', rotation], ['tool-registry.js', fs.readFileSync(nodePath.join(SRC, 'tool-registry.js'), 'utf8')]]) {
    for (const dropped of ['exhaustedAtPercent: registry.exhaustedAtPercent', 'exhaustedAtPercent: policy.exhaustedAtPercent']) {
      assert.ok(!source.includes(dropped),
        `${rel} hands down "${dropped}", which drops the two per-window limits`);
    }
  }
});

test('the live Claude reading and the cached one apply the same rule', () => {
  /* They are two functions in two files that answer the same question about
     the same account, and which one runs depends only on whether a probe
     replied in time. If they disagreed, an account would be spent or not
     according to probe timing. */
  const rotation = fs.readFileSync(nodePath.join(SRC, 'multi-account', 'rotation.js'), 'utf8');
  const start = rotation.indexOf('function claudeAllowanceFromReading(');
  assert.ok(start > 0, 'claudeAllowanceFromReading is no longer in rotation.js');
  /* A generous slice, not a claim about the function's length: the first
     lone "}" after the name closes the destructured parameter list, so
     cutting there read only the signature and missed the body entirely. */
  const body = rotation.slice(start, start + 2000);
  assert.match(body, /spentWindow\(/, 'the live reading is not judged per window');
  assert.match(body, /exhaustedAtPercentWeekly/, 'the live reading never receives the weekly limit');

  const cached = fs.readFileSync(nodePath.join(SRC, 'multi-account', 'claude-allowance.js'), 'utf8');
  assert.match(cached, /spentWindow\(/, 'the cached reading is not judged per window');
});

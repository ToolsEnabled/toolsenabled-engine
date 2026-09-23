'use strict';
// THE TWO WINDOWS, NORMALISED: slot boundaries, the active-entry preference,
// and null-is-not-zero, driven from the shapes both providers were measured
// to produce.
//
// The Claude fixture is the `limits` array Claude Code 2.1.258 answered on
// 2026-09-02 (live `get_usage` reply and the `.claude.json` cache it wrote,
// same payload), after the cache adapter's normalisation: kinds `session`,
// `weekly_all`, `weekly_scoped`, with `is_active` on the scoped weekly entry
// only. Those are the real names; the earlier draft of claudeWindows knew only
// `five_hour` and `seven_day*` and dropped every one of them.
//
//   node --test tests/multi-account/usage-windows.test.js

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NO_WINDOWS,
  SHORT_WINDOW_MAX_MINUTES,
  SHORT_WINDOW_RESET_MAX_MS,
  anyWindowMeasured,
  bindingWindow,
  claudeWindows,
  codexWindows,
  headroomPercent,
  measuredWindows,
  windowRecord
} = require('../../src/lib/multi-account/usage-windows.js');

const LIVE_LIMITS = Object.freeze([
  { kind: 'session', group: 'session', applicability: 'MEASURED', percent: 21, resetsAt: '2026-09-02T16:50:00.425796+00:00', model: null, isActive: false, index: 0 },
  { kind: 'weekly_all', group: 'weekly', applicability: 'MEASURED', percent: 25, resetsAt: '2026-09-03T17:00:00.425819+00:00', model: null, isActive: false, index: 1 },
  { kind: 'weekly_scoped', group: 'weekly', applicability: 'MEASURED', percent: 46, resetsAt: '2026-09-03T17:00:00.426044+00:00', model: 'Fable', isActive: true, index: 2 }
]);

const EPOCH_SECONDS = 1_800_000_000;
const EPOCH_ISO = new Date(EPOCH_SECONDS * 1000).toISOString();

test('Claude legacy model windows stay scoped in live and cached normalized readings', () => {
  const { normalizeUsageReply } = require('../../src/lib/providers/claude-usage-probe');
  const live = normalizeUsageReply({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10 }, seven_day: { utilization: 20 },
    seven_day_opus: { utilization: 100 }, seven_day_sonnet: { utilization: 30 }
  } });
  const cached = { limits: [
    { kind: 'five_hour', percent: 10 }, { kind: 'seven_day', percent: 20 },
    { kind: 'seven_day_opus', percent: 100 }, { kind: 'seven_day_sonnet', percent: 30 }
  ] };
  for (const reading of [live, cached]) {
    const sonnet = claudeWindows(reading, { model: 'claude/sonnet' });
    const opus = claudeWindows(reading, { model: 'claude/opus' });
    assert.equal(sonnet.weekly.usedPercent, 30, 'Opus-only exhaustion must not affect Sonnet');
    assert.equal(sonnet.weekly.model, 'Sonnet');
    assert.equal(opus.weekly.usedPercent, 100, 'the requested Opus ceiling must still apply');
    assert.equal(opus.weekly.model, 'Opus');
    assert.deepEqual(sonnet.weeklyWindows.map(row => row.model), [null, 'Opus', 'Sonnet']);
  }
});

test('Claude legacy scope recovery preserves explicit metadata and unknown/shared ceilings', () => {
  const explicit = claudeWindows({ limits: [{ kind: 'seven_day_opus', model: 'Sonnet', percent: 40 }] }, { model: 'claude/sonnet' });
  assert.equal(explicit.weekly.model, 'Sonnet');
  assert.equal(explicit.weekly.usedPercent, 40);
  for (const kind of ['seven_day', 'weekly_unrecognized']) {
    const windows = claudeWindows({ limits: [{ kind, percent: 100 }, { kind: 'seven_day_sonnet', percent: 30 }] }, { model: 'claude/sonnet' });
    assert.equal(windows.weekly.usedPercent, 100, 'shared or unknown scope must remain conservative');
    assert.equal(windows.weekly.model, null, 'an unknown scope must not be assigned a model');
  }
});

test('Claude provider display names bind only their selected model family', () => {
  const { normalizeUsageReply } = require('../../src/lib/providers/claude-usage-probe');
  for (const [opusName, sonnetName] of [
    ['Claude Opus', 'Claude Sonnet'],
    ['Opus 4.6', 'Sonnet 4.5'],
    ['Claude Opus 4.6', 'Claude Sonnet 4.5']
  ]) {
    const reading = normalizeUsageReply({ rate_limits_available: true, rate_limits: { limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 20, is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 91, is_active: true, scope: { model: { display_name: opusName } } },
      { kind: 'weekly_scoped', group: 'weekly', percent: 30, is_active: false, scope: { model: { display_name: sonnetName } } }
    ] } });
    for (const model of ['claude-sonnet-4-5', sonnetName]) {
      const windows = claudeWindows(reading, { model });
      assert.equal(windows.weekly.usedPercent, 30, `${model} must not bind the Opus ceiling`);
      assert.equal(windows.weekly.model, sonnetName, 'retain the provider display name');
      assert.deepEqual(windows.weeklyWindows.map(row => row.model), [null, opusName, sonnetName]);
    }
    assert.equal(claudeWindows(reading, { model: 'claude/opus' }).weekly.usedPercent, 91);
    assert.equal(claudeWindows(reading, { model: 'future-model' }).weekly.usedPercent, 91);
  }
  const unknown = { limits: [{ kind: 'weekly_scoped', percent: 100, model: 'Claude Unknown' },
    { kind: 'weekly_scoped', percent: 30, model: 'Claude Sonnet' }] };
  assert.equal(claudeWindows(unknown, { model: 'claude/sonnet' }).weekly.usedPercent, 100);
});

test('codexWindows: the stated window length decides the slot, at the one-day boundary', () => {
  assert.equal(SHORT_WINDOW_MAX_MINUTES, 24 * 60);
  const table = [
    { minutes: 300, slot: 'hourly', other: 'weekly' },
    { minutes: SHORT_WINDOW_MAX_MINUTES, slot: 'hourly', other: 'weekly' },
    { minutes: SHORT_WINDOW_MAX_MINUTES + 1, slot: 'weekly', other: 'hourly' },
    { minutes: 7 * 24 * 60, slot: 'weekly', other: 'hourly' }
  ];
  for (const row of table) {
    const windows = codexWindows({ primary: { usedPercent: 40, windowMinutes: row.minutes, resetsAt: EPOCH_SECONDS } });
    assert.ok(windows[row.slot], `${row.minutes} minutes must land in the ${row.slot} slot`);
    assert.equal(windows[row.other], null, `${row.minutes} minutes must leave the ${row.other} slot unread`);
    assert.equal(windows[row.slot].usedPercent, 40);
    assert.equal(windows[row.slot].remainingPercent, 60);
    assert.equal(windows[row.slot].kind, row.slot);
    assert.equal(windows[row.slot].label, `primary · ${row.minutes} min`);
    assert.equal(windows[row.slot].resetsAt, EPOCH_ISO, 'epoch seconds become an ISO string');
    assert.ok(Object.isFrozen(windows));
    assert.ok(Object.isFrozen(windows[row.slot]));
  }
});

test('codexWindows: without a stated length, a reset within six hours leaves the field name as the fallback', () => {
  /* The clock sits an hour before the reset: near enough that the reset time
     says nothing, so the field name decides as it always did. */
  const windows = codexWindows({
    primary: { usedPercent: 10, resetsAt: EPOCH_SECONDS },
    secondary: { usedPercent: 90 }
  }, { now: EPOCH_SECONDS * 1000 - 60 * 60 * 1000 });
  assert.equal(windows.hourly.usedPercent, 10);
  assert.equal(windows.hourly.label, 'primary');
  assert.equal(windows.weekly.usedPercent, 90);
  assert.equal(windows.weekly.label, 'secondary');
  assert.equal(windows.weekly.resetsAt, null, 'a missing reset is null, not invented');
});

test('codexWindows: two readings for one slot keep the more constrained one', () => {
  const windows = codexWindows({
    primary: { usedPercent: 30, windowMinutes: 300 },
    secondary: { usedPercent: 70, windowMinutes: 600 }
  });
  assert.equal(windows.hourly.usedPercent, 70, 'the freer of two same-slot readings must not win');
  assert.equal(windows.weekly, null);
});

test('codexWindows: an unread window is null, never zero', () => {
  assert.equal(codexWindows(null), NO_WINDOWS);
  assert.equal(codexWindows('primary'), NO_WINDOWS);
  assert.equal(codexWindows([]), NO_WINDOWS);
  for (const usedPercent of [null, undefined, -1, 101, '50', Number.NaN]) {
    const windows = codexWindows({ primary: { usedPercent, windowMinutes: 300 } });
    assert.equal(windows.hourly, null, `usedPercent ${String(usedPercent)} is not a reading`);
    assert.equal(windows.weekly, null);
  }
  assert.equal(codexWindows({ primary: { usedPercent: 0, windowMinutes: 300 } }).hourly.usedPercent, 0,
    'a real zero is still a reading');
  assert.deepEqual(codexWindows(null).weeklyWindows, [], 'nothing read lists no weekly ceiling');
});

test('codexWindows: one program that meters one week still answers the list, so a surface has one rule', () => {
  const windows = codexWindows({
    primary: { usedPercent: 30, windowMinutes: 300 },
    secondary: { usedPercent: 70, windowMinutes: 7 * 24 * 60 }
  });
  assert.deepEqual(windows.weeklyWindows.map(window => window.usedPercent), [70]);
  assert.equal(windows.weeklyWindows[0], windows.weekly, 'the listed week and the slot are the same record');
  assert.equal(windows.weekly.model, null, 'Codex scopes no ceiling to a model, and null says so rather than guessing');
  assert.deepEqual(codexWindows({ primary: { usedPercent: 30, windowMinutes: 300 } }).weeklyWindows, [],
    'an account with only a short window lists no weekly ceiling');
});

test('claudeWindows: the live limits map by group, and the active weekly ceiling fills the weekly slot', () => {
  const windows = claudeWindows({ limits: LIVE_LIMITS });
  assert.equal(windows.hourly.usedPercent, 21);
  assert.equal(windows.hourly.kind, 'hourly');
  assert.equal(windows.hourly.label, 'session');
  assert.equal(windows.hourly.resetsAt, '2026-09-02T16:50:00.425796+00:00');
  assert.equal(windows.weekly.usedPercent, 46);
  assert.equal(windows.weekly.kind, 'weekly');
  assert.equal(windows.weekly.label, 'weekly_scoped · Fable');
  assert.equal(headroomPercent(windows), 54);
  assert.equal(bindingWindow(windows).kind, 'weekly');
});

test('a Fable ceiling cannot block Opus, while shared and Opus ceilings still bind', () => {
  const limits = [
    { kind: 'session', group: 'session', percent: 0, isActive: false },
    { kind: 'weekly_all', group: 'weekly', percent: 97, isActive: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 100, isActive: true, model: 'Fable' },
  ];
  for (const model of ['claude/opus', 'claude-opus-4-6', 'Opus']) {
    assert.equal(headroomPercent(claudeWindows({ limits }, { model })), 3);
  }
  for (const model of ['claude/fable', 'claude-fable-5', 'Fable']) {
    assert.equal(headroomPercent(claudeWindows({ limits }, { model })), 0);
  }
  assert.equal(headroomPercent(claudeWindows({ limits }, { model: 'future-model' })), 0);
  limits.push({ kind: 'weekly_scoped', group: 'weekly', percent: 99, isActive: false, model: 'Opus' });
  assert.equal(headroomPercent(claudeWindows({ limits }, { model: 'opus' })), 1);
  limits[1].percent = 100;
  assert.equal(headroomPercent(claudeWindows({ limits }, { model: 'opus' })), 0);
});

test('claudeWindows: BOTH weekly ceilings are carried, and the slot that decides does not move', () => {
  /* Owner, 2026-09-03: "i think fable weekly limit instead of all models weekly
     limit is shown for claude we should include both". The reply meters two
     weeks at once; the `weekly` slot holds the active one, so a menu drawing
     that slot alone showed the Fable ceiling and gave a person no way to tell
     it from the all-models one. */
  const windows = claudeWindows({ limits: LIVE_LIMITS });
  assert.deepEqual(
    windows.weeklyWindows.map(window => [window.label, window.usedPercent, window.model]),
    [['weekly_all', 25, null], ['weekly_scoped · Fable', 46, 'Fable']],
    'both weekly ceilings are carried, in the provider order, each saying which models it covers');
  assert.equal(windows.weeklyWindows[0].remainingPercent, 75, 'a carried window is a whole reading, not a percentage');
  assert.ok(Object.isFrozen(windows.weeklyWindows));
  assert.ok(Object.isFrozen(windows.weeklyWindows[0]));

  /* AND NOTHING THAT DECIDES MOVED. The second entry is for a surface to draw;
     if it reached the ranker, an inactive 25% ceiling could pick the account. */
  assert.equal(windows.weekly.usedPercent, 46, 'the active entry is still the whole of the weekly slot');
  assert.equal(headroomPercent(windows), 54, 'a second weekly bar must not change the room the ranker reads');
  assert.deepEqual(measuredWindows(windows).map(window => window.usedPercent), [46, 21],
    'measuredWindows reads the two slots only -- the carried entry never ranks an account');
});

test('claudeWindows: one weekly ceiling is a list of one, and no weekly ceiling is an empty list', () => {
  const single = claudeWindows({ limits: [
    { kind: 'session', group: 'session', percent: 10, isActive: true },
    { kind: 'weekly_all', group: 'weekly', percent: 30, isActive: false }
  ] });
  assert.deepEqual(single.weeklyWindows.map(window => window.usedPercent), [30]);
  assert.equal(single.weeklyWindows[0], single.weekly, 'the one weekly reading and the slot are the same record');

  const hourlyOnly = claudeWindows({ limits: [{ kind: 'session', group: 'session', percent: 10, isActive: true }] });
  assert.deepEqual(hourlyOnly.weeklyWindows, [], 'a measured account with no weekly ceiling lists none');
  assert.equal(hourlyOnly.weekly, null);
  assert.deepEqual(NO_WINDOWS.weeklyWindows, [], 'nothing read lists nothing, rather than leaving the field absent');

  /* A NOT-APPLICABLE WEEKLY IS NOT A WEEKLY. Rule 2 of the module header,
     asserted on the list as well as on the slot: a bar drawn for a `percent:
     null` ceiling would be a picture of room the plan does not have. */
  const inapplicable = claudeWindows({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: null, isActive: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 60, isActive: false, model: 'Fable' }
  ] });
  assert.deepEqual(inapplicable.weeklyWindows.map(window => window.model), ['Fable']);
});

/* The same fact asserted from the other side: the LIST is what a surface draws
   and the SLOT is what a ranking reads, so the two are checked against each
   other -- the slot has to BE one of the listed records, and the pair the
   ranker compares has to stay two entries however many ceilings are listed. */
test('claudeWindows: the drawn list and the ranked slot are the same records, and the ranked pair is still two', () => {
  const windows = claudeWindows({ limits: LIVE_LIMITS });
  assert.deepEqual(
    windows.weeklyWindows.map(window => [window.label, window.model, window.usedPercent, window.remainingPercent]),
    [['weekly_all', null, 25, 75], ['weekly_scoped · Fable', 'Fable', 46, 54]],
    'both ceilings, in the order the provider listed them, each naming the model it is scoped to');
  assert.equal(windows.weeklyWindows[1], windows.weekly, 'the slot IS one of the listed ceilings, not a second copy of it');
  assert.equal(headroomPercent(windows), 54, 'headroom still reads the slot alone -- 75% free on the other week must not rank this account');
  assert.deepEqual(measuredWindows(windows).map(window => window.usedPercent), [46, 21],
    'the pair a ranking compares is still the two slots, not one entry per ceiling');
  assert.equal(windows.hourly.model, null, 'a ceiling that covers the whole plan says so with null, and keeps the provider word in label');
  assert.equal(windows.hourly.label, 'session');
});

test('claudeWindows: an active entry beats a worse inactive one; without one the worst stands in', () => {
  const activeWins = claudeWindows({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 80, isActive: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 40, isActive: true, model: 'Opus' }
  ] });
  assert.equal(activeWins.weekly.usedPercent, 40, 'the provider says which ceiling binds; an inactive 80% must not rank the account');
  assert.equal(activeWins.weekly.label, 'weekly_scoped · Opus');

  const noneActive = claudeWindows({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 80, isActive: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 40, isActive: false }
  ] });
  assert.equal(noneActive.weekly.usedPercent, 80, 'with no active entry the most constrained one stands in');

  const flagMissing = claudeWindows({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 80 },
    { kind: 'weekly_scoped', group: 'weekly', percent: 40 }
  ] });
  assert.equal(flagMissing.weekly.usedPercent, 80, 'a missing flag is not an active flag');

  const twoActive = claudeWindows({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 30, isActive: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 60, isActive: true }
  ] });
  assert.equal(twoActive.weekly.usedPercent, 60, 'among active entries the worst still wins');

  const perSlot = claudeWindows({ limits: [
    { kind: 'session', group: 'session', percent: 90, isActive: false },
    { kind: 'weekly_all', group: 'weekly', percent: 10, isActive: true }
  ] });
  assert.equal(perSlot.hourly.usedPercent, 90, 'the active preference is per slot, not across slots');
  assert.equal(perSlot.weekly.usedPercent, 10);
});

test('claudeWindows: legacy five_hour and seven_day kinds still map by prefix without a group', () => {
  const windows = claudeWindows({ limits: [
    { kind: 'five_hour', percent: 81, isActive: false },
    { kind: 'seven_day', percent: 12, isActive: false },
    { kind: 'seven_day_opus', percent: 96, isActive: false, model: 'Claude Opus' }
  ] });
  assert.equal(windows.hourly.usedPercent, 81);
  assert.equal(windows.weekly.usedPercent, 96, 'the most constrained seven_day* entry is the weekly slot when none is active');
  assert.equal(windows.weekly.label, 'seven_day_opus · Claude Opus');
});

test('claudeWindows: not-applicable and unrecognised windows are dropped, never counted as room', () => {
  const windows = claudeWindows({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: null, isActive: true },
    { kind: 'tangelo', group: null, percent: 5, isActive: true },
    { kind: 'monthly_all', group: 'monthly', percent: 5, isActive: true },
    'not an entry',
    { percent: 5, isActive: true }
  ] });
  assert.deepEqual(windows, { hourly: null, weekly: null, weeklyWindows: [] });
  assert.equal(claudeWindows({}), NO_WINDOWS);
  assert.equal(claudeWindows({ limits: 'x' }), NO_WINDOWS);
  assert.equal(claudeWindows(null), NO_WINDOWS);
});

test('bindingWindow, headroomPercent and anyWindowMeasured: worst window wins, nothing read is null', () => {
  assert.equal(bindingWindow(NO_WINDOWS), null);
  assert.equal(headroomPercent(NO_WINDOWS), null);
  assert.equal(anyWindowMeasured(NO_WINDOWS), false);
  assert.equal(anyWindowMeasured(null), false);
  assert.deepEqual(measuredWindows(undefined), []);

  const windows = {
    hourly: windowRecord({ kind: 'hourly', percent: 30 }),
    weekly: windowRecord({ kind: 'weekly', percent: 75 })
  };
  assert.equal(bindingWindow(windows).kind, 'weekly');
  assert.equal(headroomPercent(windows), 25, 'headroom is the worst window, never the average');
  assert.deepEqual(measuredWindows(windows).map(window => window.kind), ['weekly', 'hourly']);
  assert.equal(anyWindowMeasured(windows), true);
  assert.equal(anyWindowMeasured({ hourly: windows.hourly, weekly: null }), true);
});

test('windowRecord refuses anything but a finite percentage in range', () => {
  for (const percent of [null, undefined, -0.1, 100.1, '10', Number.POSITIVE_INFINITY]) {
    assert.equal(windowRecord({ kind: 'hourly', percent }), null);
  }
  const record = windowRecord({ kind: 'weekly', percent: 100, resetsAt: '', label: '' });
  assert.equal(record.remainingPercent, 0);
  assert.equal(record.resetsAt, null, 'an empty reset string is no reset');
  assert.equal(record.label, null, 'an empty label is no label');
});

test('codexWindows: without a stated length, a reset days away is the weekly window (Codex Pro reports only that one)', () => {
  /* Owner, 2026-09-02: "codex doesnt have 5 hour windows for some of my codex
     accounts since they are pro". Such an account answers one window, called
     primary, with no length, resetting days out. It is the week; the 5-hour
     slot stays empty rather than wearing it. */
  const now = EPOCH_SECONDS * 1000 - 6 * 24 * 60 * 60 * 1000;
  const windows = codexWindows({ primary: { usedPercent: 87, resetsAt: EPOCH_SECONDS } }, { now });
  assert.equal(windows.hourly, null, 'a window resetting in six days is not the 5-hour one');
  assert.equal(windows.weekly.usedPercent, 87);
  assert.equal(windows.weekly.kind, 'weekly');
  assert.equal(windows.weekly.label, 'primary');
  assert.equal(windows.weekly.resetsAt, EPOCH_ISO);
  /* Six hours and one minute out is still the week; five hours out is the field name. */
  assert.equal(codexWindows({ primary: { usedPercent: 1, resetsAt: EPOCH_SECONDS } }, { now: EPOCH_SECONDS * 1000 - (6 * 60 + 1) * 60 * 1000 }).weekly?.usedPercent, 1);
  assert.equal(codexWindows({ primary: { usedPercent: 1, resetsAt: EPOCH_SECONDS } }, { now: EPOCH_SECONDS * 1000 - 5 * 60 * 60 * 1000 }).hourly?.usedPercent, 1);
  /* A stated length still wins over the reset time. */
  assert.equal(codexWindows({ primary: { usedPercent: 2, windowMinutes: 300, resetsAt: EPOCH_SECONDS } }, { now }).hourly?.usedPercent, 2);
  assert.equal(SHORT_WINDOW_RESET_MAX_MS, 6 * 60 * 60 * 1000);
});

test('retry waits for every full window on an account, then picks the first account reset',()=>{
  const {recoveryTiming}=require('../../src/lib/multi-account/usage-windows');
  const now=Date.parse('2026-09-10T12:00:00Z'),thresholds={exhaustedAtPercent:99};
  const attempts=[{account:'one',status:'exhausted',windows:{
    hourly:{usedPercent:100,resetsAt:'2026-09-10T13:00:00Z'},weekly:{usedPercent:100,resetsAt:'2026-09-12T12:00:00Z'}}},
    {account:'two',status:'exhausted',usedPercent:100,resetsAt:'2026-09-10T14:00:00Z'}];
  const timing=recoveryTiming(attempts,thresholds,now);
  assert.equal(timing.resetAt,'2026-09-10T14:00:00.000Z');assert.equal(timing.nextAttemptAt,'2026-09-10T14:00:01.000Z');
  assert.equal(timing.reason,'observed-reset');assert.equal(timing.allQuotaExhausted,true);
});
test('unknown and stale resets get honest bounded rechecks, not fabricated provider timestamps',()=>{
  const {recoveryTiming}=require('../../src/lib/multi-account/usage-windows');
  const now=Date.parse('2026-09-10T12:00:00Z'),thresholds={exhaustedAtPercent:99};
  const attempts=[{account:'one',status:'exhausted',windows:{hourly:{usedPercent:100,resetsAt:'2026-09-10T13:00:00Z'},weekly:{usedPercent:100,resetsAt:null}}},
    {account:'two',status:'transient'}];
  const timing=recoveryTiming(attempts,thresholds,now);
  assert.equal(timing.resetAt,null);assert.equal(timing.nextAttemptAt,'2026-09-10T12:00:30.000Z');assert.equal(timing.allQuotaExhausted,false);
  assert.equal(recoveryTiming(attempts,thresholds,now,{recheckAttempt:99}).nextAttemptAt,'2026-09-10T12:05:00.000Z');
  const stale=recoveryTiming([{status:'exhausted',usedPercent:100,resetsAt:'2026-09-10T11:00:00Z'}],thresholds,now);
  assert.equal(stale.resetAt,null);assert.equal(stale.nextAttemptAt,'2026-09-10T12:00:30.000Z');
  assert.equal(recoveryTiming([{status:'exhausted',usedPercent:null}],thresholds,now).allQuotaExhausted,false,'billing or access refusal must not become confirmed empty quota');
  assert.equal(recoveryTiming([{status:'exhausted',usedPercent:40,resetsAt:'2026-09-10T13:00:00Z'}],{exhaustedAtPercent:40},now).allQuotaExhausted,false,'an owner reserve is not proof of empty provider quota');
  assert.equal(recoveryTiming([{status:'account_mismatch'},...attempts],thresholds,now).nextAttemptAt,null);
});

'use strict';
// EVERY MODE, DRIVEN BY THE READINGS THE REVIEW FOUND IT WRONG ON.
//
// Table-driven on purpose: each row is one set of readings and the order plus
// the sentence every mode must produce from it. The rows are the edge cases
// named in the multi-lens review of this lane -- an hour spent while the week
// is free, equal headroom with a different other window, an unread account,
// reserve at 0 and 100, the dynamic boundary, nothing read at all, and a mode
// the build does not know -- so a regression on any of them names the row.
//
// Nothing here probes anything. Readings are built with the real windowRecord
// so the shape is the one rotation.js hands orderAccounts.
//
//   node --test tests/multi-account/selection-modes.test.js

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_EXHAUSTED_AT_PERCENT,
  DEFAULT_RESERVE_PERCENT,
  DEFAULT_SELECTION_MODE,
  MODE,
  SELECTION_MODES,
  SELECTION_MODE_IDS,
  UNRECOGNISED_SELECTION_MODE,
  DEFAULT_RANK_WINDOW,
  LEGACY_SELECTION_MODES,
  RANK_WINDOW,
  RANK_WINDOW_IDS,
  normalizeRankWindow,
  isAutomatic,
  normalizeExhaustedAtPercent,
  normalizeReservePercent,
  normalizeSelectionMode,
  orderAccounts,
  selectionMode
} = require('../../src/lib/multi-account/selection-modes.js');
const { windowRecord } = require('../../src/lib/multi-account/usage-windows.js');
const registry = require('../../src/lib/multi-account/registry.js');

const RANKED_MODES = [MODE.MOST_AVAILABLE, MODE.LEAST_AVAILABLE, MODE.EVEN, MODE.DYNAMIC, MODE.RESETS_SOONEST];
const LISTED = 'In the order the accounts are listed.';
const NOTHING_READ = 'No account reported how much of its allowance is left, so the listed order was used.';

test('Rotate starts after the persisted account, wraps, and needs no allowance ranking', () => {
  const accounts = accountsNamed(['alpha', 'beta', 'gamma']);
  for (const [previousAccount, expected] of [
    [null, ['alpha', 'beta', 'gamma']],
    ['alpha', ['beta', 'gamma', 'alpha']],
    ['gamma', ['alpha', 'beta', 'gamma']],
    ['removed', ['alpha', 'beta', 'gamma']],
  ]) {
    const result = orderAccounts({ mode: MODE.ROTATE, accounts, previousAccount });
    assert.deepEqual(result.names, expected);
    assert.equal(result.measuredCount, null);
    assert.equal(result.unmeasuredCount, null);
    assert.equal(result.mode, 'rotate');
  }
  assert.equal(isAutomatic('rotate'), true);
  assert.deepEqual(orderAccounts({ mode: 'rotate', accounts: [] }).names, []);
  const allowanceOnly = orderAccounts({ mode: 'rotate', accounts });
  assert.equal(allowanceOnly.why, 'Accounts take turns in the listed order. Signed-out or limited accounts are skipped.',
    'an allowance refresh has no persisted cursor and must not name the next account');
});

/* A reading in the shape rotation.js hands over: `windows` from usage-windows.
   `null` for a slot is "not read". A whole reading of null is an unread
   account. */
function reading({ hourly = null, weekly = null, hourlyResets = null, weeklyResets = null } = {}) {
  return {
    windows: {
      hourly: hourly === null ? null : windowRecord({ kind: 'hourly', percent: hourly, resetsAt: hourlyResets }),
      weekly: weekly === null ? null : windowRecord({ kind: 'weekly', percent: weekly, resetsAt: weeklyResets })
    }
  };
}

/* A fixed clock for the expiring-first sentences, so "in 40 min" is the same
   words on every run. Reset times are built relative to it. */
const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = ms => new Date(NOW + ms).toISOString();

function accountsNamed(names) {
  return names.map((name, index) => ({ name, provider: 'claude', configDir: `.claude-${name}`, priority: index + 1 }));
}

function order(mode, readings, options = {}) {
  return orderAccounts({ mode, accounts: accountsNamed(Object.keys(readings)), readings, ...options });
}

/* Visible strings must be plain sentences under 25 words. Asserted on every
   sentence every row produces, so a longer sentence cannot slip in unseen. */
function assertPlainSentences(why) {
  for (const sentence of why.split(/(?<=\.)\s+/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    assert.ok(words.length > 0 && words.length < 25, `sentence must be under 25 words: "${sentence}"`);
    assert.match(sentence, /\.$/, `sentence must end with a full stop: "${sentence}"`);
    assert.doesNotMatch(sentence, /\d{4}-\d{2}-\d{2}T/, `no machine timestamp in a sentence: "${sentence}"`);
  }
}

const ROWS = [
  {
    title: 'hourly spent, weekly free: the spent hour goes to the back in every ranked mode',
    readings: { alpha: reading({ hourly: 100, weekly: 10 }), beta: reading({ hourly: 20, weekly: 60 }) },
    expect: {
      [MODE.MANUAL]: { names: ['alpha', 'beta'], why: LISTED },
      [MODE.PRIORITY]: { names: ['alpha', 'beta'], why: LISTED },
      [MODE.MOST_AVAILABLE]: {
        names: ['beta', 'alpha'],
        why: '"beta" has the most left: 40% free this week. "alpha" has spent its hour and waits at the back until it resets.'
      },
      [MODE.LEAST_AVAILABLE]: {
        names: ['beta', 'alpha'],
        why: '"beta" is closest to its limit and is being finished first: 40% free this week. "alpha" has spent its hour and waits at the back until it resets.'
      },
      [MODE.EVEN]: {
        names: ['beta', 'alpha'],
        why: '"beta" is the least spent this week: 40% free this week. "alpha" has spent its hour and waits at the back until it resets.'
      },
      [MODE.DYNAMIC]: {
        names: ['beta', 'alpha'],
        why: 'Plenty spare (40% free on the freest account), so "beta" is being finished first: 40% free this week. "alpha" has spent its hour and waits at the back until it resets.'
      }
    }
  },
  {
    title: 'equal headroom: the other window breaks the tie before registry order',
    readings: { alpha: reading({ hourly: 50, weekly: 30 }), beta: reading({ hourly: 50, weekly: 10 }) },
    expect: {
      [MODE.MOST_AVAILABLE]: { names: ['beta', 'alpha'], why: '"beta" has the most left: 50% free this hour.' },
      [MODE.LEAST_AVAILABLE]: { names: ['alpha', 'beta'], why: '"alpha" is closest to its limit and is being finished first: 50% free this hour.' },
      [MODE.EVEN]: { names: ['beta', 'alpha'], why: '"beta" is the least spent this week: 90% free this week.' },
      [MODE.DYNAMIC]: { names: ['alpha', 'beta'], why: 'Plenty spare (50% free on the freest account), so "alpha" is being finished first: 50% free this hour.' }
    }
  },
  {
    title: 'one unread account stays behind the read one and the sentence says so',
    readings: { alpha: null, beta: reading({ hourly: 30 }) },
    measured: { measuredCount: 1, unmeasuredCount: 1 },
    expect: {
      [MODE.MOST_AVAILABLE]: {
        names: ['beta', 'alpha'],
        why: '"beta" has the most left: 70% free this hour. 1 of 2 accounts did not report their allowance and were left in the listed order behind the rest.'
      },
      [MODE.LEAST_AVAILABLE]: {
        names: ['beta', 'alpha'],
        why: '"beta" is closest to its limit and is being finished first: 70% free this hour. 1 of 2 accounts did not report their allowance and were left in the listed order behind the rest.'
      },
      [MODE.EVEN]: {
        names: ['beta', 'alpha'],
        why: '"beta" has no weekly reading; 70% free this hour. 1 of 2 accounts did not report their allowance and were left in the listed order behind the rest.'
      },
      [MODE.DYNAMIC]: {
        names: ['beta', 'alpha'],
        why: 'Plenty spare (70% free on the freest account), so "beta" is being finished first: 70% free this hour. 1 of 2 accounts did not report their allowance and were left in the listed order behind the rest.'
      }
    }
  },
  {
    title: 'nothing read at all: every ranked mode degrades to the listed order and says so',
    readings: { alpha: null, beta: null },
    measured: { measuredCount: 0, unmeasuredCount: 2 },
    expect: Object.fromEntries(RANKED_MODES.map(mode => [mode, { names: ['alpha', 'beta'], why: NOTHING_READ }]))
  },
  {
    title: 'even ranks on the week and splits equal weeks by the hour',
    readings: {
      alpha: reading({ hourly: 60, weekly: 40 }),
      beta: reading({ hourly: 20, weekly: 40 }),
      gamma: reading({ hourly: 5, weekly: 70 })
    },
    expect: {
      [MODE.EVEN]: { names: ['beta', 'alpha', 'gamma'], why: '"beta" is the least spent this week: 60% free this week.' }
    }
  },
  {
    title: 'several spent hours are named together, behind the one account still able to serve',
    readings: {
      alpha: reading({ hourly: 100, weekly: 10 }),
      beta: reading({ hourly: 99, weekly: 20 }),
      gamma: reading({ hourly: 5, weekly: 5 })
    },
    expect: {
      // Among the waiting, the same rule as among the ready: 1% headroom
      // ranks above 0% under most-available, so beta comes before alpha.
      [MODE.MOST_AVAILABLE]: {
        names: ['gamma', 'beta', 'alpha'],
        why: '"gamma" has the most left: 95% free this hour. "beta" and "alpha" have spent their hour and wait at the back until it resets.'
      },
      [MODE.LEAST_AVAILABLE]: {
        names: ['gamma', 'alpha', 'beta'],
        why: '"gamma" is closest to its limit and is being finished first: 95% free this hour. "alpha" and "beta" have spent their hour and wait at the back until it resets.'
      }
    }
  }
];

for (const row of ROWS) {
  test(row.title, () => {
    for (const [mode, expected] of Object.entries(row.expect)) {
      const result = order(mode, row.readings);
      assert.deepEqual([...result.names], expected.names, `${mode}: order`);
      assert.equal(result.why, expected.why, `${mode}: why`);
      assert.equal(result.mode, mode);
      assertPlainSentences(result.why);
      if (row.measured) {
        assert.equal(result.measuredCount, row.measured.measuredCount, `${mode}: measuredCount`);
        assert.equal(result.unmeasuredCount, row.measured.unmeasuredCount, `${mode}: unmeasuredCount`);
      }
    }
  });
}

test('manual and priority consult no reading: counts are null, not zero', () => {
  for (const mode of [MODE.MANUAL, MODE.PRIORITY]) {
    const result = order(mode, { alpha: reading({ hourly: 100 }), beta: null });
    assert.deepEqual([...result.names], ['alpha', 'beta']);
    assert.equal(result.measuredCount, null);
    assert.equal(result.unmeasuredCount, null);
    assert.equal(result.why, LISTED);
  }
});

test('dynamic spreads remaining capacity when the only reserve account has spent its hour', () => {
  const result = order(MODE.DYNAMIC, {
    reserve: reading({ hourly: 55, weekly: 10 }),
    tight: reading({ hourly: 10, weekly: 90 }),
    freer: reading({ hourly: 10, weekly: 80 })
  }, { exhaustedAtPercentHourly: 50, reservePercent: 25 });
  assert.deepEqual(result.names, ['freer', 'tight', 'reserve']);
  assert.match(result.why, /Every available account is under 25% free/);
  assert.match(result.why, /reserve.*has spent its hour/);
});

test('dynamic: reserve 0 always concentrates, reserve 100 always spreads, and the boundary concentrates', () => {
  const readings = { alpha: reading({ hourly: 40 }), beta: reading({ hourly: 70 }) };
  const concentrate = order(MODE.DYNAMIC, readings, { reservePercent: 0 });
  assert.deepEqual([...concentrate.names], ['beta', 'alpha']);
  assert.equal(concentrate.why, 'Plenty spare (60% free on the freest account), so "beta" is being finished first: 30% free this hour.');

  const spread = order(MODE.DYNAMIC, readings, { reservePercent: 100 });
  assert.deepEqual([...spread.names], ['alpha', 'beta']);
  assert.equal(spread.why, 'Every account is under 100% free, so the load is being spread: "alpha" has the most left at 60% free this hour.');

  assert.deepEqual([...order(MODE.DYNAMIC, readings, { reservePercent: 60 }).names], ['beta', 'alpha'],
    'freest exactly at the reserve still counts as plenty spare');
  assert.deepEqual([...order(MODE.DYNAMIC, readings, { reservePercent: 61 }).names], ['alpha', 'beta'],
    'one point under the reserve flips to spreading');
  assert.equal(order(MODE.DYNAMIC, readings, { reservePercent: 61 }).why,
    'Every account is under 61% free, so the load is being spread: "alpha" has the most left at 60% free this hour.');
});

test('even demotes on the exhaustion threshold, never on the reserve', () => {
  const readings = { alpha: reading({ hourly: 100, weekly: 5 }), beta: reading({ hourly: 10, weekly: 50 }) };
  for (const reservePercent of [0, 25, 60, 100]) {
    const result = order(MODE.EVEN, readings, { reservePercent });
    assert.deepEqual([...result.names], ['beta', 'alpha'], `reserve ${reservePercent} must not change the even order`);
    assert.equal(result.why, '"beta" is the least spent this week: 50% free this week. "alpha" has spent its hour and waits at the back until it resets.');
  }
  const nearlySpent = { alpha: reading({ hourly: 99.5, weekly: 5 }), beta: reading({ hourly: 10, weekly: 50 }) };
  assert.deepEqual([...order(MODE.EVEN, nearlySpent).names], ['beta', 'alpha'], 'at the default threshold 99.5% is spent');
  const lifted = order(MODE.EVEN, nearlySpent, { exhaustedAtPercent: 100 });
  assert.deepEqual([...lifted.names], ['alpha', 'beta'], 'under a 100% threshold 99.5% is not yet spent');
  assert.equal(lifted.why, '"alpha" is the least spent this week: 95% free this week.');
  assert.deepEqual([...order(MODE.EVEN, nearlySpent, { exhaustedAtPercent: 'bogus' }).names], ['beta', 'alpha'],
    'an unusable threshold falls back to the default rather than to no threshold');
});

test('the same hourly demotion applies to most, least and dynamic, on the threshold', () => {
  const spent = { alpha: reading({ hourly: 100, weekly: 10 }), beta: reading({ hourly: 20, weekly: 60 }) };
  const nearly = { alpha: reading({ hourly: 99, weekly: 10 }), beta: reading({ hourly: 20, weekly: 60 }) };
  for (const mode of [MODE.MOST_AVAILABLE, MODE.LEAST_AVAILABLE, MODE.DYNAMIC]) {
    assert.deepEqual([...order(mode, spent).names], ['beta', 'alpha'], `${mode}: the spent hour must not be first`);
    assert.deepEqual([...order(mode, spent, { exhaustedAtPercent: 100 }).names], ['beta', 'alpha'],
      `${mode}: a 100% hour is spent at a 100% threshold too`);
    assert.deepEqual([...order(mode, nearly).names], ['beta', 'alpha'],
      `${mode}: 99% is spent at the default 99% threshold`);
    assert.deepEqual([...order(mode, nearly, { exhaustedAtPercent: 100 }).names],
      mode === MODE.MOST_AVAILABLE ? ['beta', 'alpha'] : ['alpha', 'beta'],
      `${mode}: at a 100% threshold 99% is not spent, and the mode's own rule decides`);
  }
  const under = { alpha: reading({ hourly: 90, weekly: 10 }), beta: reading({ hourly: 20, weekly: 60 }) };
  assert.deepEqual([...order(MODE.LEAST_AVAILABLE, under).names], ['alpha', 'beta'],
    'a 90% hour under a 99% threshold is not demoted; it simply has the least room');
  assert.equal(order(MODE.LEAST_AVAILABLE, under).why,
    '"alpha" is closest to its limit and is being finished first: 10% free this hour.');
});

test('when every account that reported has spent its hour, the head is named as waiting', () => {
  const readings = { alpha: reading({ hourly: 100, weekly: 10 }), beta: reading({ hourly: 100, weekly: 50 }) };
  const most = order(MODE.MOST_AVAILABLE, readings);
  assert.deepEqual([...most.names], ['alpha', 'beta'], 'both at 0% headroom; the freer week goes first');
  assert.equal(most.why, 'Every account that reported has spent its hour, so "alpha" is first and waits for its hour to reset.');
  assertPlainSentences(most.why);
  const least = order(MODE.LEAST_AVAILABLE, readings);
  assert.deepEqual([...least.names], ['beta', 'alpha'], 'ascending on the other window when the worst is tied');
  assert.equal(least.why, 'Every account that reported has spent its hour, so "beta" is first and waits for its hour to reset.');
  const even = order(MODE.EVEN, readings);
  assert.deepEqual([...even.names], ['alpha', 'beta']);
  assert.equal(even.why, 'Every account that reported has spent its hour, so "alpha" is first and waits for its hour to reset.');
});

test('even names hourly room in hourly words when the head has no weekly reading', () => {
  const result = order(MODE.EVEN, { alpha: reading({ hourly: 10 }), beta: reading({ hourly: 30, weekly: 50 }) });
  assert.deepEqual([...result.names], ['alpha', 'beta']);
  assert.equal(result.why, '"alpha" has no weekly reading; 90% free this hour.');
  assert.doesNotMatch(result.why, /this week/, 'an hourly figure must never be spoken as the week');
});

test('the order is stable: equal readings fall to registry priority, then name, and unlisted priority goes last', () => {
  const accounts = [
    { name: 'zed', provider: 'claude', configDir: '.z', priority: 3 },
    { name: 'alpha', provider: 'claude', configDir: '.a', priority: 1 },
    { name: 'mid', provider: 'claude', configDir: '.m', priority: 2 },
    { name: 'beta', provider: 'claude', configDir: '.b' },
    { name: 'aardvark', provider: 'claude', configDir: '.aa' }
  ];
  const same = reading({ hourly: 10, weekly: 10 });
  const readings = Object.fromEntries(accounts.map(account => [account.name, same]));
  for (const mode of RANKED_MODES) {
    const first = orderAccounts({ mode, accounts, readings });
    const second = orderAccounts({ mode, accounts: [...accounts].reverse(), readings });
    assert.deepEqual([...first.names], ['alpha', 'mid', 'zed', 'aardvark', 'beta'], `${mode}: registry order on equal readings`);
    assert.deepEqual([...second.names], [...first.names], `${mode}: input order must not leak into the answer`);
    assert.equal(first.accounts[0], accounts[1], 'the registry objects themselves come back, not copies');
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.accounts));
  }
});

test('a mode this build does not know is manual, and reads nothing', () => {
  const result = order('bogus', { alpha: reading({ hourly: 100 }), beta: reading({ hourly: 0 }) });
  assert.equal(result.mode, MODE.MANUAL);
  assert.deepEqual([...result.names], ['alpha', 'beta']);
  assert.equal(result.measuredCount, null);
  assert.equal(normalizeSelectionMode('bogus'), MODE.MANUAL);
  assert.equal(normalizeSelectionMode(undefined), MODE.MANUAL);
  assert.equal(normalizeSelectionMode(MODE.EVEN), MODE.EVEN);
  assert.equal(orderAccounts().mode, MODE.PRIORITY, 'no arguments at all is the default (walk the list) and still an answer');
  assert.deepEqual([...orderAccounts().names], []);
  assert.equal(orderAccounts({ mode: MODE.MOST_AVAILABLE, accounts: 'nope', readings: 'nope' }).why, NOTHING_READ);
});

test('malformed readings are unread, not zero', () => {
  const readings = { alpha: { windows: 'x' }, beta: { windows: { hourly: { usedPercent: 5 } } }, gamma: reading({ hourly: 5 }) };
  const result = order(MODE.MOST_AVAILABLE, readings);
  assert.deepEqual([...result.names], ['gamma', 'alpha', 'beta']);
  assert.equal(result.measuredCount, 1);
  const viaMap = orderAccounts({ mode: MODE.MOST_AVAILABLE, accounts: accountsNamed(['alpha', 'beta']),
    readings: new Map([['beta', reading({ hourly: 5 })]]) });
  assert.deepEqual([...viaMap.names], ['beta', 'alpha'], 'a Map of readings is read the same way');
});

test('ids, defaults and automatic flags are exactly as the app and the registry expect', () => {
  assert.deepEqual([...SELECTION_MODE_IDS], ['manual', 'priority', 'rotate', 'most-available', 'least-available', 'even', 'dynamic', 'resets-soonest']);
  assert.deepEqual({ ...LEGACY_SELECTION_MODES }, { 'expiring-first': 'resets-soonest' }, 'the id this mode shipped under for a few hours still reads');
  assert.equal(normalizeSelectionMode('expiring-first'), 'resets-soonest');
  assert.deepEqual([...RANK_WINDOW_IDS], ['either', 'hourly', 'weekly']);
  assert.equal(DEFAULT_RANK_WINDOW, 'either');
  assert.equal(normalizeRankWindow('weekly'), 'weekly');
  assert.equal(normalizeRankWindow('nope'), 'either');
  assert.deepEqual(SELECTION_MODES.map(mode => mode.automatic), [false, true, true, true, true, true, true, true]);
  assert.equal(DEFAULT_SELECTION_MODE, 'priority', 'nobody chose: walk the list (owner, 2026-09-02: added accounts should rotate)');
  assert.equal(UNRECOGNISED_SELECTION_MODE, 'manual', 'chose something this build cannot read: stop');
  assert.equal(DEFAULT_RESERVE_PERCENT, 25);
  assert.equal(DEFAULT_EXHAUSTED_AT_PERCENT, registry.DEFAULT_EXHAUSTED_AT_PERCENT,
    'the order and the health check must call the same number spent');
  assert.equal(isAutomatic('manual'), false);
  assert.equal(isAutomatic('bogus'), false);
  assert.equal(isAutomatic(undefined), false);
  for (const mode of [MODE.PRIORITY, MODE.ROTATE, ...RANKED_MODES]) assert.equal(isAutomatic(mode), true);
  assert.deepEqual(selectionMode('even'), { id: 'even', automatic: true });
  assert.equal(selectionMode('nope'), null);
  // The engine table carries no words. The accounts menu owns the label and
  // the help sentence for each id, and it is tested there, not here.
  for (const mode of SELECTION_MODES) {
    assert.deepEqual(Object.keys(mode).sort(), ['automatic', 'id'], `${mode.id}: the engine table must carry ids and the automatic flag only`);
  }
});

test('reserve and threshold normalisation: out of range means the default, never no rule', () => {
  for (const value of [-1, 101, Number.NaN, '50', null, undefined, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizeReservePercent(value), 25, `reserve ${String(value)}`);
    assert.equal(normalizeExhaustedAtPercent(value), 99, `threshold ${String(value)}`);
  }
  assert.equal(normalizeReservePercent(0), 0);
  assert.equal(normalizeReservePercent(100), 100);
  assert.equal(normalizeExhaustedAtPercent(0), 99, 'a zero threshold would call every account spent; refused');
  assert.equal(normalizeExhaustedAtPercent(100), 100);
  assert.equal(normalizeExhaustedAtPercent(0.5), 0.5);
});

/* ---- EXPIRING FIRST: room that is about to be lost is spent before room that keeps ---- */

test('resets soonest: the window that resets soonest goes first, and a tie goes to the account with more to lose', () => {
  const readings = {
    alpha: reading({ hourly: 40, hourlyResets: at(4 * HOUR), weekly: 20, weeklyResets: at(3 * DAY) }),
    beta: reading({ hourly: 40, hourlyResets: at(1 * HOUR) }),
    gamma: reading({ hourly: 90, hourlyResets: at(30 * MINUTE) })
  };
  const result = order(MODE.RESETS_SOONEST, readings, { now: NOW });
  assert.deepEqual([...result.names], ['gamma', 'beta', 'alpha']);
  assert.equal(result.why, '"gamma" resets soonest (in 30 min): 10% free this hour.');
  assertPlainSentences(result.why);
  assert.equal(result.measuredCount, 3);

  const tied = order(MODE.RESETS_SOONEST, {
    alpha: reading({ hourly: 60, hourlyResets: at(2 * HOUR) }),
    beta: reading({ hourly: 20, hourlyResets: at(2 * HOUR) })
  }, { now: at(0) });
  assert.deepEqual([...tied.names], ['beta', 'alpha'], 'same reset moment: the account with more room left would lose more, so it goes first');
  assert.equal(tied.why, '"beta" resets soonest (in 2h): 80% free this hour.');
  assert.equal(order(MODE.RESETS_SOONEST, readings).why, '"gamma" resets soonest: 10% free this hour.',
    'without a clock the order is the same and the sentence simply names no time');
  assert.equal(order(MODE.RESETS_SOONEST, readings, { now: 'not a date' }).why, '"gamma" resets soonest: 10% free this hour.');
});

test('resets soonest: a spent window is not an expiry, and a spent hour still waits at the back', () => {
  const readings = {
    alpha: reading({ hourly: 100, hourlyResets: at(5 * MINUTE), weekly: 10, weeklyResets: at(2 * DAY) }),
    beta: reading({ hourly: 20, hourlyResets: at(3 * HOUR) })
  };
  const result = order(MODE.RESETS_SOONEST, readings, { now: NOW });
  assert.deepEqual([...result.names], ['beta', 'alpha'],
    'the spent hour of alpha resets first but has nothing to lose; its expiring room is the week, and its spent hour demotes it anyway');
  assert.equal(result.why, '"beta" resets soonest (in 3h): 80% free this hour. "alpha" has spent its hour and waits at the back until it resets.');
  assertPlainSentences(result.why);

  const onlyWeek = order(MODE.RESETS_SOONEST, {
    alpha: reading({ hourly: 100, hourlyResets: at(5 * MINUTE), weekly: 10, weeklyResets: at(2 * DAY) })
  }, { now: NOW });
  assert.equal(onlyWeek.why, 'Every account that reported has spent its hour, so "alpha" is first and waits for its hour to reset.');
});

test('resets soonest: an account that named no reset time waits behind the timed ones and is named', () => {
  const result = order(MODE.RESETS_SOONEST, {
    alpha: reading({ hourly: 30 }),
    beta: reading({ hourly: 30, hourlyResets: at(2 * HOUR) }),
    gamma: reading({ weekly: 30 })
  }, { now: NOW });
  assert.deepEqual([...result.names], ['beta', 'alpha', 'gamma']);
  assert.equal(result.why, '"beta" resets soonest (in 2h): 70% free this hour. "alpha" and "gamma" did not say when they reset and stay behind in the listed order.');
  assertPlainSentences(result.why);
  const one = order(MODE.RESETS_SOONEST, { alpha: reading({ hourly: 30 }), beta: reading({ hourly: 30, hourlyResets: at(2 * HOUR) }) });
  assert.equal(one.why, '"beta" resets soonest: 70% free this hour. "alpha" did not say when it resets and stays behind in the listed order.');
  assert.equal(one.measuredCount, 2, 'an untimed account was still measured; it is not an unread one');
});

test('resets soonest: when nobody named a reset time the listed order is used and the sentence says so', () => {
  const result = order(MODE.RESETS_SOONEST, { alpha: reading({ hourly: 30 }), beta: null, gamma: reading({ weekly: 5 }) });
  assert.deepEqual([...result.names], ['alpha', 'gamma', 'beta'], 'measured-but-untimed first in registry order, unread last');
  assert.equal(result.why, 'No account reported when its allowance resets, so the listed order was used. 1 of 3 accounts did not report their allowance and were left in the listed order behind the rest.');
  assertPlainSentences(result.why);
  assert.equal(result.measuredCount, 2);
  assert.equal(result.unmeasuredCount, 1);
});

test('resets soonest: the relative time reads in minutes, hours or days, and a reset already due says so', () => {
  const sentence = ms => order(MODE.RESETS_SOONEST, { alpha: reading({ hourly: 50, hourlyResets: at(ms) }) }, { now: NOW }).why;
  assert.equal(sentence(20 * 1000), '"alpha" resets soonest (in 1 min): 50% free this hour.', 'never "in 0 min"');
  assert.equal(sentence(59 * MINUTE), '"alpha" resets soonest (in 59 min): 50% free this hour.');
  assert.equal(sentence(5 * HOUR), '"alpha" resets soonest (in 5h): 50% free this hour.');
  assert.equal(sentence(47 * HOUR), '"alpha" resets soonest (in 47h): 50% free this hour.');
  assert.equal(sentence(6 * DAY), '"alpha" resets soonest (in 6 days): 50% free this hour.');
  assert.equal(sentence(-1), '"alpha" resets soonest (due to reset): 50% free this hour.');
  for (const ms of [20 * 1000, 6 * DAY, -1]) assertPlainSentences(sentence(ms));
});

test('resets soonest is automatic, so a manual switch is honoured once and the ranking then resumes', () => {
  assert.equal(isAutomatic(MODE.RESETS_SOONEST), true);
  assert.deepEqual(selectionMode('resets-soonest'), { id: 'resets-soonest', automatic: true });
  assert.deepEqual(selectionMode('expiring-first'), { id: 'resets-soonest', automatic: true }, 'the old id finds the same row');
});

/* ---- RANK ON ONE WINDOW (owner, 2026-09-02: "maybe a weekly/hourly choice") ---- */

test('rank on the weekly window: room and resets are read off the week alone, and an account without a week is unread', () => {
  const readings = {
    alpha: reading({ hourly: 10, weekly: 80, hourlyResets: at(1 * HOUR), weeklyResets: at(5 * DAY) }),
    beta: reading({ hourly: 90, weekly: 20, hourlyResets: at(2 * HOUR), weeklyResets: at(2 * DAY) }),
    gamma: reading({ hourly: 5 })
  };
  const most = order(MODE.MOST_AVAILABLE, readings, { rankWindow: RANK_WINDOW.WEEKLY });
  assert.deepEqual([...most.names], ['beta', 'alpha', 'gamma'], 'beta has the most of its week; gamma reported no week and waits behind');
  assert.equal(most.why, '"beta" has the most left: 80% free this week. 1 of 3 accounts did not report their weekly window and were left in the listed order behind the rest.');
  assert.equal(most.measuredCount, 2);
  const soonest = order(MODE.RESETS_SOONEST, readings, { rankWindow: RANK_WINDOW.WEEKLY, now: NOW });
  assert.deepEqual([...soonest.names], ['beta', 'alpha', 'gamma'], 'beta\'s week resets first, whatever the hours say');
  assert.equal(soonest.why, '"beta" resets soonest (in 2 days): 80% free this week. 1 of 3 accounts did not report their weekly window and were left in the listed order behind the rest.');
  const none = order(MODE.MOST_AVAILABLE, { gamma: reading({ hourly: 5 }) }, { rankWindow: RANK_WINDOW.WEEKLY });
  assert.equal(none.why, 'No account reported its weekly window, so the listed order was used.');
  for (const result of [most, soonest, none]) assertPlainSentences(result.why);
});

test('rank on the 5-hour window: even levels the hour, least-available reads the hour, and either stays the whole-account view', () => {
  const readings = {
    alpha: reading({ hourly: 60, weekly: 10 }),
    beta: reading({ hourly: 20, weekly: 70 })
  };
  const even = order(MODE.EVEN, readings, { rankWindow: RANK_WINDOW.HOURLY });
  assert.deepEqual([...even.names], ['beta', 'alpha'], 'the least-spent hour goes first');
  const least = order(MODE.LEAST_AVAILABLE, readings, { rankWindow: RANK_WINDOW.HOURLY });
  assert.deepEqual([...least.names], ['alpha', 'beta']);
  assert.equal(least.why, '"alpha" is closest to its limit and is being finished first: 40% free this hour.');
  const either = order(MODE.LEAST_AVAILABLE, readings);
  assert.deepEqual([...either.names], ['beta', 'alpha'], 'whole-account: beta\'s week at 30% free is the tighter window');
  assert.equal(order(MODE.LEAST_AVAILABLE, readings, { rankWindow: 'bogus' }).names[0], 'beta', 'an unknown window choice is the whole-account view');
});

/* THE GUARD FOR usability.js's LONGHAND STATUS NAMES.
 *
 * usability.js deliberately requires nothing: importing STATUS from health.js
 * closes a require cycle (health -> registry -> selection-modes -> usability ->
 * health), and CommonJS does not fail loudly on that -- selection-modes would
 * receive a half-built registry and the breakage would surface somewhere
 * unrelated. The price is a second copy of the status names, written out.
 *
 * THIS IS WHAT MAKES THAT PRICE SAFE TO PAY. Somebody will eventually add or
 * rename a status in health.js. Without this, the new name would simply fall to
 * `unknown` here -- an account would silently stop being classified and nothing
 * would say so, which is the quiet-wrong answer this lane keeps re-finding.
 * A test may require both modules freely: the cycle only matters for the
 * production load order, and usability.js requires nothing.
 */
test('usability.js knows exactly the statuses health.js defines, no more and no fewer', () => {
  const usability = require('../../src/lib/multi-account/usability.js');
  const health = require('../../src/lib/multi-account/health.js');
  assert.deepEqual(
    Object.values(usability.STATUS).slice().sort(),
    Object.values(health.STATUS).slice().sort(),
    'a status was added to or renamed in one of the two and not the other'
  );
  /* Every status health defines must also have been DECIDED about here, and
     that is asked with isClassified rather than by looking at the answer.
     `transient` is classified UNKNOWN deliberately -- we do not know that the
     account is spent -- while a status nobody taught this module answers
     UNKNOWN too. Checking the answer would read the first as the second and
     would have failed on `transient`, which is the correct classification. */
  for (const status of Object.values(health.STATUS)) {
    assert.equal(usability.isClassified(status), true,
      `the "${status}" status reached usability.js without anyone deciding what it means`);
  }
});

/* THE DISTINCTION THAT MUST NOT COLLAPSE, asserted as behaviour rather than as
   a spelling: a spent allowance returns on its own, a signed-out account does
   not. Collapsing these would either strand a person on their worst accounts
   or hide a provider they only need to sign in to. */
test('a spent allowance and a signed-out account are not the same unavailability', () => {
  const usability = require('../../src/lib/multi-account/usability.js');
  assert.equal(usability.recoversWithoutPerson('exhausted'), true);
  assert.equal(usability.needsPerson('exhausted'), false);
  assert.equal(usability.needsPerson('signed_out'), true);
  assert.equal(usability.recoversWithoutPerson('signed_out'), false);
  assert.equal(usability.needsPerson('not_provisioned'), true);
  /* Only a healthy account can serve right now, and an unread one is neither
     usable nor dead -- it ranks ahead of everything known to be unusable. */
  assert.equal(usability.canServeNow('healthy'), true);
  assert.equal(usability.canServeNow('transient'), false);
  assert.ok(usability.selectionTier('transient') < usability.selectionTier('exhausted'));
  assert.ok(usability.selectionTier('exhausted') < usability.selectionTier('signed_out'));
  assert.ok(usability.selectionTier('healthy') < usability.selectionTier('transient'));
});

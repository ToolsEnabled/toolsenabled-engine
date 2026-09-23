'use strict';
/* Moving running agents off an account that has reached its limit, and the
 * cases where moving one would be worse than leaving it alone.
 *
 * The rule this file exists to hold: a session is never moved off an account
 * unless somewhere proven better exists. A spent account still answers turns
 * until its window resets, so moving an agent to nowhere -- or to an account
 * nobody measured -- turns "you are near your weekly limit" into "your work
 * stopped". That is a worse outcome than the one the limit exists to avoid.
 *
 *   node --test tests/account-handover.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { HANDOVER, draining, handoverPlan, handoverReport, ready } = require('../src/lib/multi-account/handover.js');

const LIMITS = Object.freeze({
  exhaustedAtPercent: 90,
  exhaustedAtPercentHourly: 90,
  exhaustedAtPercentWeekly: 95,
});

/* The shape health.js produces: the two windows, whether the account said it
   can serve, and the worst figure. Only the parts this decision reads. */
function reading(hourlyUsed, weeklyUsed, canServe = true) {
  return {
    canServe,
    windows: {
      hourly: { kind: 'hourly', usedPercent: hourlyUsed, remainingPercent: 100 - hourlyUsed, resetsAt: null },
      weekly: { kind: 'weekly', usedPercent: weeklyUsed, remainingPercent: 100 - weeklyUsed, resetsAt: null },
    },
  };
}

test('an account past a limit of its own is draining; one that was never read is not', () => {
  const limits = { hourlyLimit: 90, weeklyLimit: 95 };
  assert.equal(draining(reading(10, 96), limits), true, 'past the weekly limit');
  assert.equal(draining(reading(95, 10), limits), true, 'past the hourly limit');
  assert.equal(draining(reading(10, 94), limits), false, 'under both');

  /* An account that reported no figure at all but said it cannot serve is
     spent, and saying so is not the same as being silent. */
  assert.equal(draining({ canServe: false, windows: null }, limits), true);

  /* SILENCE IS NOT A VERDICT. A probe that timed out must not empty a fleet. */
  assert.equal(draining(null, limits), false);
  assert.equal(draining(undefined, limits), false);
});

test('somewhere to move TO is a stricter question than somewhere to move OFF', () => {
  const limits = { hourlyLimit: 90, weeklyLimit: 95 };
  assert.equal(ready(reading(10, 20), limits), true);
  assert.equal(ready(reading(10, 96), limits), false, 'past its own weekly limit');
  assert.equal(ready({ canServe: false, windows: null }, limits), false);
  assert.equal(ready(null, limits), false, 'an account nobody measured is a guess, not a target');
  /* Measured, under both limits, but it never said it could serve. */
  assert.equal(ready({ windows: reading(10, 20).windows }, limits), false);
});

test('agents on a spent account move to the head of the order this computer prefers', () => {
  /* An account at 91% of its week with the weekly limit at 95 is fine; take it
     past 95 and its agents should go somewhere with room. */
  const plan = handoverPlan({
    limits: LIMITS,
    order: ['spent', 'roomy', 'alsoRoomy'],
    readings: {
      spent: reading(35, 96),
      roomy: reading(10, 20),
      alsoRoomy: reading(15, 30),
    },
    sessions: [
      { id: 's1', account: 'spent' },
      { id: 's2', account: 'spent' },
      { id: 's3', account: 'roomy' },
    ],
  });

  assert.deepEqual(plan.moves, [
    { sessionId: 's1', from: 'spent', to: 'roomy', why: HANDOVER.MOVED },
    { sessionId: 's2', from: 'spent', to: 'roomy', why: HANDOVER.MOVED },
  ]);
  assert.deepEqual(plan.held, [], 'there was somewhere to go, so nothing was held');
  assert.deepEqual(plan.draining, ['spent']);
  assert.deepEqual(plan.ready, ['roomy', 'alsoRoomy']);
});

test('a session on an account that is fine is not mentioned at all', () => {
  /* Listing it as "held" would read as though something had been considered
     and refused, and nothing was. */
  const plan = handoverPlan({
    limits: LIMITS,
    order: ['roomy'],
    readings: { roomy: reading(10, 20) },
    sessions: [{ id: 's1', account: 'roomy' }],
  });
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.held, []);
});

test('with nowhere proven better, the session is HELD and keeps running', () => {
  /* THE CASE THIS FILE EXISTS FOR. Every account is past a limit. A spent
     account still answers turns until its window resets, so leaving the agent
     where it is beats stopping it. */
  const plan = handoverPlan({
    limits: LIMITS,
    order: ['spentA', 'spentB'],
    readings: { spentA: reading(35, 96), spentB: reading(99, 10) },
    sessions: [{ id: 's1', account: 'spentA' }],
  });

  assert.deepEqual(plan.moves, [], 'nothing is moved to nowhere');
  assert.deepEqual(plan.held, [{ sessionId: 's1', from: 'spentA', why: HANDOVER.HELD_NO_TARGET }]);
  assert.deepEqual(plan.ready, []);
});

test('an unmeasured account is never a destination, and the hold says which silence it was', () => {
  const nothingRead = handoverPlan({
    limits: LIMITS,
    order: ['spent', 'unknown'],
    readings: { spent: { canServe: false, windows: null } },
    sessions: [{ id: 's1', account: 'spent' }],
  });
  assert.deepEqual(nothingRead.moves, [], 'an account nobody read is a guess, not a target');
  assert.equal(nothingRead.held[0].why, HANDOVER.HELD_NO_TARGET,
    'one account WAS read, so the check ran; it just found nowhere to go');

  const noneRead = handoverPlan({
    limits: LIMITS,
    order: ['a', 'b'],
    readings: {},
    sessions: [{ id: 's1', account: 'a' }],
  });
  assert.deepEqual(noneRead.moves, []);
  assert.deepEqual(noneRead.held, [], 'an account nobody read is not draining, so nothing was decided about it');
});

test('a session is never handed back to the account it is already on', () => {
  /* The only ready account is the one the session is running on, which can
     happen when canServe is false while both windows are still under their
     limits. Moving it to itself would be a stop and a resume for nothing. */
  const plan = handoverPlan({
    limits: LIMITS,
    order: ['odd'],
    readings: { odd: { canServe: false, windows: reading(10, 20).windows } },
    sessions: [{ id: 's1', account: 'odd' }],
  });
  assert.deepEqual(plan.moves, []);
  assert.equal(plan.held[0].why, HANDOVER.HELD_NO_TARGET);
});

test('one number for both windows still decides, so a registry written before this behaves the same', () => {
  const single = { exhaustedAtPercent: 90 };
  const plan = handoverPlan({
    limits: single,
    order: ['week91', 'roomy'],
    readings: { week91: reading(35, 91), roomy: reading(10, 20) },
    sessions: [{ id: 's1', account: 'week91' }],
  });
  assert.deepEqual(plan.draining, ['week91'], '91% of the week is past a single 90 number');
  assert.equal(plan.moves.length, 1);

  /* And the owner's own case: the same account, with a weekly limit of its
     own, is left alone and its agents are not disturbed. */
  const perWindow = handoverPlan({
    limits: LIMITS,
    order: ['week91', 'roomy'],
    readings: { week91: reading(35, 91), roomy: reading(10, 20) },
    sessions: [{ id: 's1', account: 'week91' }],
  });
  assert.deepEqual(perWindow.draining, []);
  assert.deepEqual(perWindow.moves, []);
});

test('the session shape the app host actually produces is the one this reads', () => {
  /* THE JOIN, PINNED. shell/agent-host.cjs sessionAccountRows() answers rows of
     { sessionId, account, provider, pinnedHome }. This function answered with
     `sessionId` from the start but read `id`, so every real row would have been
     skipped -- and a plan that skips every session looks exactly like a fleet
     with nothing to move. Nothing would have failed loudly. */
  const hostRows = [
    { sessionId: 's1', account: 'spent', provider: 'claude', pinnedHome: 'C:/x/.claude' },
    { sessionId: 's2', account: 'roomy', provider: 'claude', pinnedHome: 'C:/y/.claude' },
  ];
  const plan = handoverPlan({
    limits: LIMITS,
    order: ['spent', 'roomy'],
    readings: { spent: reading(35, 96), roomy: reading(10, 20) },
    sessions: hostRows,
  });
  assert.deepEqual(plan.moves, [{ sessionId: 's1', from: 'spent', to: 'roomy', why: HANDOVER.MOVED }]);

  /* `id` is accepted beside it, because the shape is obvious enough to write
     either way and the cost of guessing wrong is silence. */
  const shorthand = handoverPlan({
    limits: LIMITS,
    order: ['spent', 'roomy'],
    readings: { spent: reading(35, 96), roomy: reading(10, 20) },
    sessions: [{ id: 's1', account: 'spent' }],
  });
  assert.deepEqual(shorthand.moves, [{ sessionId: 's1', from: 'spent', to: 'roomy', why: HANDOVER.MOVED }]);
});

test('rubbish in the session list is skipped rather than throwing', () => {
  /* This runs at a turn boundary in the host. A malformed entry must not be
     able to end somebody's session. */
  const plan = handoverPlan({
    limits: LIMITS,
    order: ['spent', 'roomy'],
    readings: { spent: reading(35, 96), roomy: reading(10, 20) },
    sessions: [null, 'nope', {}, { id: 's1' }, { account: 'spent' }, { id: 's2', account: 'spent' }],
  });
  assert.deepEqual(plan.moves, [{ sessionId: 's2', from: 'spent', to: 'roomy', why: HANDOVER.MOVED }]);
});

test('called with nothing at all it answers an empty plan', () => {
  const plan = handoverPlan();
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.held, []);
  assert.deepEqual(plan.draining, []);
  assert.deepEqual(plan.ready, []);
  assert.ok(Object.isFrozen(plan));
});

/* ------------------------------------------------------------------
 * handoverReport: the same decision over a whole computer, as a report.
 * ------------------------------------------------------------------ */

/* One account row exactly as readAccountUsage() answers them. */
function usageRow(name, provider, hourlyUsed, weeklyUsed, canServe = true) {
  return { name, provider, priority: 1, ...reading(hourlyUsed, weeklyUsed, canServe) };
}

function usageAnswer(accounts, orders, readAt = '2026-09-03T10:00:00.000Z') {
  return { ok: true, readAt, policy: LIMITS, accounts, orders };
}

test('the report runs one program at a time, so a Claude session is never sent to a Codex account', () => {
  /* THE CATEGORY ERROR THIS SPLIT EXISTS TO PREVENT. Both programs have an
     account called "work". Claude's is spent and Codex's is roomy, so a report
     that merged the two tables would answer that the Claude session should
     carry on where it is -- reading Codex's healthy "work" -- and that the
     Codex session on a spent "spare" should move onto a CLAUDE account. */
  const report = handoverReport({
    usage: usageAnswer(
      [
        usageRow('work', 'claude', 35, 99),
        usageRow('backup', 'claude', 10, 20),
        usageRow('work', 'codex', 5, 10),
        usageRow('spare', 'codex', 5, 99),
      ],
      [
        { provider: 'claude', names: ['work', 'backup'] },
        { provider: 'codex', names: ['work', 'spare'] },
      ],
    ),
    sessions: [
      { sessionId: 's1', agentId: 'agent-a', account: 'work', provider: 'claude' },
      { sessionId: 's2', agentId: 'agent-b', account: 'spare', provider: 'codex' },
    ],
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.moves, [
    { sessionId: 's1', from: 'work', to: 'backup', why: HANDOVER.MOVED, provider: 'claude', agentId: 'agent-a' },
    { sessionId: 's2', from: 'spare', to: 'work', why: HANDOVER.MOVED, provider: 'codex', agentId: 'agent-b' },
  ]);
  assert.deepEqual(report.held, []);
  assert.deepEqual(report.unknown, []);
  assert.equal(report.readAt, '2026-09-03T10:00:00.000Z');
});

test('the report carries the agent each session belongs to, which is what puts an account on an agent card', () => {
  /* THE WHOLE JOIN, END TO END. The app host answers rows of
     { sessionId, agentId, account, provider }; nothing else on the computer
     can say which declared agent is spending which sign-in. */
  const report = handoverReport({
    usage: usageAnswer(
      [usageRow('spent', 'claude', 35, 99), usageRow('roomy', 'claude', 10, 20)],
      [{ provider: 'claude', names: ['spent', 'roomy'] }],
    ),
    sessions: [
      { sessionId: 's1', agentId: 'coordinator-1', account: 'spent', provider: 'claude' },
      { sessionId: 's2', agentId: null, account: 'spent', provider: 'claude' },
      { sessionId: 's3', agentId: 'helper-9', account: 'roomy', provider: 'claude' },
    ],
  });
  assert.deepEqual(report.moves.map(move => [move.sessionId, move.agentId, move.to]), [
    ['s1', 'coordinator-1', 'roomy'],
    ['s2', null, 'roomy'],
  ]);
  /* s3 is measured, under both limits and on nothing that is draining, so it
     appears nowhere: there is nothing to decide about it, and listing it as
     held would read as though something had been considered and refused. */
  assert.deepEqual(report.held, []);
  assert.deepEqual(report.unknown, []);
  assert.deepEqual(report.providers.map(entry => [entry.provider, entry.draining, entry.ready]),
    [['claude', ['spent'], ['roomy']]]);
});

test('a session nobody measured is named with its reason, never dropped into silence', () => {
  /* "The check has not run" and "nothing needs to move" are different answers.
     handoverPlan drops an unread account correctly -- draining(null) is false
     -- so the report has to carry that difference itself or a fleet on six
     spent accounts reads as a fleet with nothing to do. */
  const report = handoverReport({
    usage: usageAnswer(
      [usageRow('measured', 'claude', 10, 20)],
      [{ provider: 'claude', names: ['measured', 'never-read'] }],
    ),
    sessions: [
      { sessionId: 's1', agentId: 'a1', account: 'never-read', provider: 'claude' },
      { sessionId: 's2', agentId: 'a2', account: 'measured', provider: 'claude' },
      /* A program the usage answer never covered at all. */
      { sessionId: 's3', agentId: 'a3', account: 'anything', provider: 'gemini' },
    ],
  });
  assert.deepEqual(report.unknown, [
    { sessionId: 's1', agentId: 'a1', provider: 'claude', from: 'never-read', why: HANDOVER.UNKNOWN_ACCOUNT_NOT_READ },
    { sessionId: 's3', agentId: 'a3', provider: 'gemini', from: 'anything', why: HANDOVER.UNKNOWN_ACCOUNT_NOT_READ },
  ]);
  assert.deepEqual(report.moves, []);
  assert.deepEqual(report.held, []);
});

test('no usage answer at all names every running session rather than reporting a quiet fleet', () => {
  const report = handoverReport({
    usage: null,
    sessions: [{ sessionId: 's1', agentId: 'a1', account: 'work', provider: 'claude' }],
  });
  assert.equal(report.ok, false);
  assert.equal(report.code, HANDOVER.UNKNOWN_NOTHING_READ);
  assert.deepEqual(report.unknown, [
    { sessionId: 's1', agentId: 'a1', provider: 'claude', from: 'work', why: HANDOVER.UNKNOWN_NOTHING_READ },
  ]);
  assert.deepEqual(report.moves, []);
  assert.equal(report.readAt, null);

  /* A read that refused is the same fact as no read. */
  const refused = handoverReport({
    usage: { ok: false, code: 'ACCOUNT_USAGE_UNAVAILABLE', accounts: [], orders: [] },
    sessions: [{ sessionId: 's1', account: 'work', provider: 'claude' }],
  });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.unknown.map(row => row.sessionId), ['s1']);
});

test('the report holds a session when nowhere proven better exists, and says which silence it was', () => {
  const everySpent = handoverReport({
    usage: usageAnswer(
      [usageRow('one', 'claude', 99, 99), usageRow('two', 'claude', 99, 99)],
      [{ provider: 'claude', names: ['one', 'two'] }],
    ),
    sessions: [{ sessionId: 's1', agentId: 'a1', account: 'one', provider: 'claude' }],
  });
  assert.deepEqual(everySpent.held, [
    { sessionId: 's1', from: 'one', why: HANDOVER.HELD_NO_TARGET, provider: 'claude', agentId: 'a1' },
  ]);
  assert.deepEqual(everySpent.moves, []);

  /* THROUGH THE REPORT, A HELD SESSION ALWAYS SAYS HELD_NO_TARGET, and that is
     a fact about the report rather than a gap in it. Being held at all means
     the account under the session was found draining, which means it WAS read
     -- so "nothing was measured" can never be the reason. A session nothing
     measured is not held; it is unknown, which is the list below. */
  const cannotServe = handoverReport({
    usage: usageAnswer(
      [{ name: 'one', provider: 'claude', canServe: false, windows: null }],
      [{ provider: 'claude', names: ['one', 'two'] }],
    ),
    sessions: [{ sessionId: 's1', agentId: 'a1', account: 'one', provider: 'claude' }],
  });
  assert.deepEqual(cannotServe.held.map(row => row.why), [HANDOVER.HELD_NO_TARGET]);
  assert.deepEqual(cannotServe.unknown, []);
});

test('the report moves nothing and answers a frozen record', () => {
  /* IT IS A REPORT. There is no seam here that could act: the function is
     handed a usage answer and a list of rows and returns a value. This pins
     the frozen answer so a caller cannot edit the report and hand it on as
     though the computer had said it. */
  const report = handoverReport({
    usage: usageAnswer(
      [usageRow('spent', 'claude', 35, 99), usageRow('roomy', 'claude', 10, 20)],
      [{ provider: 'claude', names: ['spent', 'roomy'] }],
    ),
    sessions: [{ sessionId: 's1', agentId: 'a1', account: 'spent', provider: 'claude' }],
  });
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.moves));
  assert.ok(Object.isFrozen(report.moves[0]));
  assert.ok(Object.isFrozen(report.providers[0]));
});

test('rubbish in either input is skipped rather than throwing', () => {
  const report = handoverReport({
    usage: usageAnswer(
      [usageRow('spent', 'claude', 35, 99), usageRow('roomy', 'claude', 10, 20), null, 'nope'],
      [{ provider: 'claude', names: ['spent', 'roomy', '', null] }, null, 'nope', { names: ['x'] }],
    ),
    sessions: [null, 'nope', {}, { sessionId: 's1' }, { account: 'spent' },
      { sessionId: 's2', account: 'spent', provider: 'claude' }],
  });
  assert.deepEqual(report.moves.map(move => move.sessionId), ['s2']);
  assert.deepEqual(handoverReport().unknown, []);
  assert.equal(handoverReport().ok, false);
});

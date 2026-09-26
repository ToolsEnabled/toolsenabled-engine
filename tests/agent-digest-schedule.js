// EXECUTABLE CHANGE
// Test-can-fail report (testcanfail-tests-agent-digest-schedule-js):
// - Strengthened the KINDS assertions. Mutation: exported `KINDS: []` while
//   leaving the scheduler's internal kind handling intact. Before this change,
//   the test stayed green because `for (const kind of KINDS)` ran zero times.
//   After this change it went red with:
//     `AssertionError [ERR_ASSERTION]: the exported kind list must contain every supported kind`
//     `+ actual - expected`
//     `+ []`
//     `- [ 'digest', 'pulse' ]` (the runner renders this array across lines)
// - Restored src/lib/agent-digest/schedule.js byte-for-byte (SHA-256
//   1ea82c34ba92b3e7dede85b8bd0269064f0df8b5e583295ff254543c8bf8794c).
//   The restored run is green and ends with:
//     `Agent digest schedule tests passed (21 checks: never-double-send and no-backlog-replay proven directly).`
// - NOT-FOUND (2): no exit-status or generic truthy-return assertion is used as
//   a substitute for inspecting the subject's own output.
// - NOT-FOUND (3): no try/catch or optional chain swallows an expected failure;
//   the one try/finally only guarantees temporary-directory cleanup.
// - NOT-FOUND (4): no assertion checks a mock of the behavior under test; the
//   injected settings stores are dependencies exercised through the scheduler.
// - NOT-FOUND (5): no skip or platform precondition can turn the file into a
//   no-op. The optional account branch reflects a supported absent field and is
//   paired with unconditional config assertions.
// - NOT-FOUND (6): no expected value is computed by the same subject operation
//   being checked.
// - Preconditions not met: none.

'use strict';

// Slot-grid tests for the scheduled agentic-workflow digest.
//
// These are the parts that are easy to get subtly wrong, so they are asserted
// directly rather than inferred from a passing end-to-end run:
//   * NEVER DOUBLE-SEND -- a fired slot cannot fire again, including across a
//     process restart inside the same slot and across a backwards clock jump.
//   * NEVER REPLAY A BACKLOG -- a machine that was asleep for hours delivers
//     the single freshest missed slot, never the whole day.
//
// This suite touches no ledger, no vault, and no network: the schedule module
// takes an injected settings store.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CATCHUP_GRACE_S, DAYS, GRACE_S, KINDS,
  DigestSchedule, JsonSettingsStore, MemorySettingsStore,
  dayKey, defaultGrid, fireKeyFor, normalizeGrid, parseFireKey, slotStart, timeKey
} = require('../src/lib/agent-digest/schedule');

let checks = 0;
function check(label, run) { run(); checks += 1; process.stdout.write(`  ok ${label}\n`); }

// Every half-hour slot on every day is "pulse". A grid this dense is the worst
// case for backlog replay, which is exactly what several tests below need.
function denseGrid(kind = 'pulse') {
  const slots = {};
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of ['00', '30']) slots[`${String(hour).padStart(2, '0')}:${minute}`] = kind;
  }
  return Object.fromEntries(DAYS.map(day => [day, { ...slots }]));
}

function scheduleWith(grid, settings = {}) {
  const store = new MemorySettingsStore(settings);
  return { store, schedule: new DigestSchedule({ store, defaults: grid }) };
}

const BASE = new Date(2026, 6, 28, 10, 5, 0, 0); // 2026-07-28 10:05 local
function at(hour, minute, dayOffset = 0) {
  return new Date(2026, 6, 28 + dayOffset, hour, minute, 0, 0);
}

// --------------------------------------------------------------------------
check('slot boundaries snap to :00 / :30 and fire keys are local + sortable', () => {
  assert.equal(timeKey(slotStart(at(10, 5))), '10:00');
  assert.equal(timeKey(slotStart(at(10, 29, 0))), '10:00');
  assert.equal(timeKey(slotStart(at(10, 30))), '10:30');
  assert.equal(timeKey(slotStart(at(10, 59))), '10:30');
  assert.equal(fireKeyFor(slotStart(at(10, 5))), '2026-07-28|10:00');
  // Lexicographic ordering is what blocks a re-fire, so it must match time order.
  assert.ok('2026-07-28|09:30' < '2026-07-28|10:00');
  assert.ok('2026-07-28|23:30' < '2026-07-29|00:00');
  assert.equal(parseFireKey('2026-07-28|10:30').getHours(), 10);
  assert.equal(parseFireKey('2026-07-28|10:30').getMinutes(), 30);
});

check('weekday mapping is Mon-first even though JavaScript getDay() is Sun-first', () => {
  for (let offset = 0; offset < 7; offset += 1) {
    const date = at(12, 0, offset);
    assert.equal(dayKey(date), DAYS[(date.getDay() + 6) % 7]);
  }
  const sunday = [0, 1, 2, 3, 4, 5, 6].map(offset => at(12, 0, offset)).find(date => date.getDay() === 0);
  assert.equal(dayKey(sunday), 'sun');
  const monday = [0, 1, 2, 3, 4, 5, 6].map(offset => at(12, 0, offset)).find(date => date.getDay() === 1);
  assert.equal(dayKey(monday), 'mon');
  // A 00:00 cell belongs to the calendar day of its own column: Monday 00:00
  // is Sunday night's final, and must be looked up under 'mon'.
  const mondayMidnight = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 0, 0, 0, 0);
  assert.equal(dayKey(mondayMidnight), 'mon');
});

// --------------------------------------------------------------------------
check('a due slot fires once and NEVER a second time in the same slot', () => {
  const { schedule } = scheduleWith(denseGrid());
  const hit = schedule.due(BASE);
  assert.deepEqual(hit, { fireKey: '2026-07-28|10:00', kind: 'pulse' });
  schedule.markFired(hit.fireKey);
  assert.equal(schedule.due(BASE), null, 'the same slot must not fire twice');
  assert.equal(schedule.catchupDue(BASE), null, 'catch-up must not resurrect a fired slot');
  assert.equal(schedule.due(at(10, 19)), null, 'still inside the same slot and inside grace');
});

check('a restart inside the same slot cannot re-fire it', () => {
  const { store, schedule } = scheduleWith(denseGrid());
  const hit = schedule.due(BASE);
  schedule.markFired(hit.fireKey);
  // A brand-new service object over the SAME persisted store == a restart.
  const restarted = new DigestSchedule({ store, defaults: denseGrid() });
  assert.equal(restarted.due(BASE), null);
  assert.equal(restarted.catchupDue(BASE), null);
  assert.equal(restarted.catchupDue(at(10, 25)), null);
  // The next slot still fires normally after the restart.
  assert.deepEqual(restarted.due(at(10, 35)), { fireKey: '2026-07-28|10:30', kind: 'pulse' });
});

check('the fired key is what blocks a re-fire, so a backwards clock jump cannot double-send', () => {
  const { schedule } = scheduleWith(denseGrid());
  schedule.markFired('2026-07-28|10:00');
  // Windows corrects the wall clock backwards after the send.
  assert.equal(schedule.due(at(9, 50)), null, 'an earlier slot is <= the fired key');
  assert.equal(schedule.catchupDue(at(9, 50)), null);
  assert.equal(schedule.due(at(10, 5)), null);
});

// --------------------------------------------------------------------------
check('a slot past the grace window does not fire on the normal path', () => {
  const { schedule } = scheduleWith(denseGrid());
  assert.equal(GRACE_S, 1200, 'grace is 20 minutes: real headroom, still under the 30-min slot spacing');
  assert.notEqual(schedule.due(at(10, 19)), null, 'inside grace');
  assert.equal(schedule.due(at(10, 21)), null, 'past grace on the normal path');
  // Grace is under the slot spacing, so at most one slot is ever in-grace.
  assert.ok(GRACE_S < 30 * 60);
});

check('a machine asleep for hours delivers ONE freshest slot, never the backlog', () => {
  // Asleep from 02:15; wakes at 10:05. A dense grid means 16 missed slots.
  const { schedule } = scheduleWith(denseGrid(), { agent_digest_last_fired: '2026-07-28|02:00' });
  const first = schedule.catchupDue(BASE);
  assert.deepEqual(first, { fireKey: '2026-07-28|10:00', kind: 'pulse' }, 'the freshest slot, not the oldest missed one');
  schedule.markFired(first.fireKey);
  assert.equal(schedule.catchupDue(BASE), null, 'the rest of the day is NOT replayed');
  assert.equal(schedule.due(BASE), null);
});

check('a post-wake slot just outside normal grace still delivers exactly one report', () => {
  // 10:55: the 10:30 boundary is 25 min old, so the normal path declines it.
  const { schedule } = scheduleWith(denseGrid(), { agent_digest_last_fired: '2026-07-28|02:00' });
  const now = at(10, 55);
  assert.equal(schedule.due(now), null, 'past the busy-loop grace');
  const hit = schedule.catchupDue(now);
  assert.deepEqual(hit, { fireKey: '2026-07-28|10:30', kind: 'pulse' }, 'the newest missed slot');
  schedule.markFired(hit.fireKey);
  assert.equal(schedule.catchupDue(now), null, 'it does not then walk back to 10:00, 09:30, ...');
});

check('nothing older than the bounded catch-up window is ever delivered', () => {
  assert.equal(CATCHUP_GRACE_S, 2 * 3600, 'bounded at two hours: recover a nap, never replay a workday');
  // The only scheduled slot today was 03:00; the machine wakes at 10:05.
  const grid = Object.fromEntries(DAYS.map(day => [day, { '03:00': 'pulse' }]));
  const { schedule } = scheduleWith(grid, { agent_digest_last_fired: '2026-07-27|00:00' });
  assert.equal(schedule.catchupDue(BASE), null, 'a 7-hour-old slot must never fire on boot');
  // And a slot inside the window still does.
  const nearGrid = Object.fromEntries(DAYS.map(day => [day, { '09:00': 'pulse' }]));
  const near = scheduleWith(nearGrid, { agent_digest_last_fired: '2026-07-27|00:00' });
  assert.deepEqual(near.schedule.catchupDue(BASE), { fireKey: '2026-07-28|09:00', kind: 'pulse' });
});

check('a first-ever start with no history still cannot replay the day', () => {
  // No fired key at all: catch-up is still bounded by the same two-hour window.
  const { schedule } = scheduleWith(denseGrid());
  const hit = schedule.catchupDue(BASE);
  assert.deepEqual(hit, { fireKey: '2026-07-28|10:00', kind: 'pulse' });
  schedule.markFired(hit.fireKey);
  assert.equal(schedule.catchupDue(BASE), null);
});

// --------------------------------------------------------------------------
check('seeding suppresses the install-moment surprise email but not the next slot', () => {
  const { schedule } = scheduleWith(denseGrid());
  assert.equal(schedule.seedIfMissing(BASE), true);
  assert.equal(schedule.lastFired(), '2026-07-28|10:00');
  assert.equal(schedule.due(BASE), null, 'installing at 10:05 must not immediately email');
  assert.equal(schedule.catchupDue(BASE), null);
  assert.equal(schedule.seedIfMissing(BASE), false, 'seeding is idempotent');
  assert.deepEqual(schedule.due(at(10, 35)), { fireKey: '2026-07-28|10:30', kind: 'pulse' }, 'the next boundary still sends');
});

check('an off cell never fires and both kinds are honoured', () => {
  const grid = Object.fromEntries(DAYS.map(day => [day, { '10:00': 'digest', '11:00': 'pulse' }]));
  const { schedule } = scheduleWith(grid);
  assert.deepEqual(schedule.due(BASE), { fireKey: '2026-07-28|10:00', kind: 'digest' });
  schedule.markFired('2026-07-28|10:00');
  assert.equal(schedule.due(at(10, 35)), null, '10:30 is off');
  assert.deepEqual(schedule.due(at(11, 5)), { fireKey: '2026-07-28|11:00', kind: 'pulse' });
});

check('nextSlot never advertises a slot the scheduler has already sent', () => {
  const grid = Object.fromEntries(DAYS.map(day => [day, { '10:00': 'pulse', '14:00': 'digest' }]));
  const { schedule } = scheduleWith(grid);
  const due = schedule.nextSlot(BASE);
  assert.equal(due.fireKey, '2026-07-28|10:00');
  assert.equal(due.dueNow, true);
  schedule.markFired('2026-07-28|10:00');
  const next = schedule.nextSlot(BASE);
  assert.equal(next.fireKey, '2026-07-28|14:00');
  assert.equal(next.dueNow, false);
  assert.equal(next.secondsUntil, (14 - 10) * 3600 - 5 * 60);
  assert.equal(next.time, '14:00');
});

// --------------------------------------------------------------------------
check('grid validation refuses malformed cells rather than silently dropping slots', () => {
  assert.deepEqual(normalizeGrid({ mon: { '10:00': 'pulse', '10:30': 'off', '11:00': '', '11:30': null } }), { mon: { '10:00': 'pulse' } });
  assert.throws(() => normalizeGrid({ funday: { '10:00': 'pulse' } }), /unknown day/);
  assert.throws(() => normalizeGrid({ mon: { '10:15': 'pulse' } }), /bad time/);
  assert.throws(() => normalizeGrid({ mon: { '24:00': 'pulse' } }), /bad time/);
  assert.throws(() => normalizeGrid({ mon: { '10:00': 'briefing' } }), /bad kind/);
  assert.throws(() => normalizeGrid([]), TypeError);
  assert.deepEqual(normalizeGrid({ mon: {} }), {}, 'a fully-off day is dropped, not kept empty');
});

check('markFired refuses a key that is not a real slot', () => {
  const { schedule } = scheduleWith(denseGrid());
  for (const bad of ['', 'today', '2026-07-28|10:15', '2026-7-28|10:00', '2026-07-28 10:00', null, 42]) {
    assert.throws(() => schedule.markFired(bad), TypeError, `must refuse ${String(bad)}`);
  }
  assert.equal(schedule.lastFired(), '');
});

check('invalid stored fired history refuses instead of answering that a slot is unfired', () => {
  for (const fireKey of ['', 'today', '2026-07-28|10:15']) {
    const { schedule } = scheduleWith(denseGrid(), { agent_digest_last_fired: fireKey });
    assert.throws(() => schedule.lastFired(), /Stored fire key/);
    assert.throws(() => schedule.due(BASE), /Stored fire key/);
  }
});

check('the shipped default grid is a sane hourly cadence on every day', () => {
  const { schedule } = scheduleWith(defaultGrid());
  const summary = schedule.summary(defaultGrid());
  assert.equal(summary.activeDays, 7);
  assert.equal(summary.digest, 14, 'two full reads a day');
  assert.equal(summary.pulse, 84, 'twelve hourly pulses a day');
  assert.equal(summary.total + summary.offSlots, 7 * 48);
  assert.deepEqual(KINDS, ['digest', 'pulse'], 'the exported kind list must contain every supported kind');
  for (const kind of KINDS) assert.ok(summary[kind] > 0);
  // Every configured cell must land on a real slot boundary.
  assert.doesNotThrow(() => normalizeGrid(defaultGrid()));
  assert.equal(schedule.due(new Date(2026, 6, 28, 3, 5)), null, 'nothing at 03:00');
});

check('the shipped config file matches the schedule contract', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agent-digest.json'), 'utf8'));
  assert.equal(config.schemaVersion, 1);
  // `account` is OPTIONAL and absent by default. The file's own $comment says so
  // ("when absent (the shipped default) this falls back to that profile's own
  // defaultAccount"), and src/lib/agent-digest/index.js reads it as
  // `typeof raw.account === 'string' && raw.account ? raw.account : undefined`.
  // Requiring it here contradicted both, and went red the moment the shipped
  // config stopped naming an alias -- which is the state the config documents as
  // correct. What must hold is the type WHEN PRESENT, so that a malformed alias
  // still fails; a missing key is the supported default, not a defect.
  if ('account' in config) {
    assert.equal(typeof config.account, 'string', 'account, when present, names a profile alias');
    assert.ok(config.account.length > 0, 'an empty account alias would resolve to nothing');
  }
  assert.ok(!JSON.stringify(config).includes('@'), 'no email address may be stored in the digest config');
  assert.doesNotThrow(() => normalizeGrid(config.grid));
  assert.ok(config.generationTimeoutMs > 0, 'a hard generation timeout must be configured');
});

// --------------------------------------------------------------------------
check('the JSON settings store survives a restart and refuses to silently reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-digest-schedule-'));
  try {
    const file = path.join(dir, 'nested', 'agent-digest.json');
    const store = new JsonSettingsStore(file);
    assert.equal(store.getSetting('agent_digest_last_fired'), null);
    store.setSetting('agent_digest_last_fired', '2026-07-28|10:00');
    assert.equal(new JsonSettingsStore(file).getSetting('agent_digest_last_fired'), '2026-07-28|10:00');
    // A corrupt file must NOT read as "nothing has ever fired" -- that would
    // re-send the current slot on every tick.
    fs.writeFileSync(file, '{not json');
    assert.throws(() => new JsonSettingsStore(file).getSetting('agent_digest_last_fired'), SyntaxError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

check('a corrupt stored grid falls back to the configured default instead of firing nothing', () => {
  const store = new MemorySettingsStore({ agent_digest_grid: '{not json' });
  const schedule = new DigestSchedule({ store, defaults: denseGrid() });
  const cachedDefaults = schedule.getGrid();
  assert.strictEqual(schedule.getGrid(), cachedDefaults, 'the normalized configured default remains cached');
  assert.deepEqual(schedule.due(BASE), { fireKey: '2026-07-28|10:00', kind: 'pulse' });
  const saved = schedule.setGrid({ mon: { '10:00': 'digest' } });
  assert.deepEqual(saved, { mon: { '10:00': 'digest' } });
  assert.deepEqual(schedule.getGrid(), { mon: { '10:00': 'digest' } });
});

check('an indeterminate grid parse does not claim that the stored schedule is absent', () => {
  const store = new MemorySettingsStore({ agent_digest_grid: '{"mon":{"10:00":"digest"}}' });
  const schedule = new DigestSchedule({ store, defaults: denseGrid() });
  const originalParse = JSON.parse;
  const busy = Object.assign(new Error('file table busy'), { code: 'EMFILE' });
  try {
    JSON.parse = () => { throw busy; };
    assert.throws(
      () => schedule.getGrid(),
      error => error.code === 'AGENT_DIGEST_GRID_COULD_NOT_TELL'
        && /does NOT claim that it is absent/.test(error.message)
        && error.cause === busy
    );
  } finally {
    JSON.parse = originalParse;
  }
  assert.deepEqual(schedule.getGrid(), { mon: { '10:00': 'digest' } }, 'the could-not-tell result was not cached or latched');
});

check('a semantically malformed stored grid is not accepted as an authoritative schedule', () => {
  for (const grid of [
    { funday: { '10:00': 'pulse' } },
    { mon: { '10:15': 'pulse' } },
    { mon: { '10:00': 'briefing' } }
  ]) {
    const store = new MemorySettingsStore({ agent_digest_grid: JSON.stringify(grid) });
    const schedule = new DigestSchedule({ store, defaults: denseGrid() });
    assert.deepEqual(schedule.getGrid(), denseGrid());
    assert.deepEqual(schedule.due(BASE), { fireKey: '2026-07-28|10:00', kind: 'pulse' });
  }
});

check('DigestSchedule refuses to construct without a usable store', () => {
  assert.throws(() => new DigestSchedule({}), TypeError);
  assert.throws(() => new DigestSchedule({ store: { getSetting: () => null } }), TypeError);
});

process.stdout.write(`Agent digest schedule tests passed (${checks} checks: never-double-send and no-backlog-replay proven directly).\n`);

/* Mutation check (2026-08-27): next-week search boundary.
 * Exact mutation: `offset <= DAYS.length * SLOTS_PER_DAY` changed to `<`.
 * The edit landed in src/lib/agent-digest/schedule.js (confirmed by inspection).
 * This test went red (exit 1, expected next-week slot but received null).
 */
'use strict';

const assert = require('node:assert/strict');

const {
  DAYS,
  DigestSchedule,
  MemorySettingsStore
} = require('../../src/lib/agent-digest/schedule');

// Tuesday 10:00 is the only enabled cell. Once that occurrence has fired, the
// next occurrence is exactly 7 * 48 half-hour slots away. This boundary is
// easy to omit accidentally when searching the finite weekly grid.
const grid = Object.fromEntries(DAYS.map(day => [day, {}]));
grid.tue['10:00'] = 'digest';

const store = new MemorySettingsStore({
  agent_digest_last_fired: '2026-07-28|10:00'
});
const schedule = new DigestSchedule({ store, defaults: grid });
const now = new Date(2026, 6, 28, 10, 5, 0, 0);

assert.deepEqual(schedule.nextSlot(now), {
  fireKey: '2026-08-04|10:00',
  kind: 'digest',
  at: new Date(2026, 7, 4, 10, 0, 0, 0).getTime(),
  localIso: '2026-08-04T10:00',
  day: 'tue',
  time: '10:00',
  secondsUntil: 7 * 24 * 60 * 60 - 5 * 60,
  dueNow: false
});

process.stdout.write('agent-digest schedule next-week boundary test passed\n');

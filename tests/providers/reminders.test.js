/* Mutation check:
 * Changed NAMESPACE from 'personal.reminders' to 'personal.reminders-mutated' in src/lib/providers/reminders.js.
 * The edit landed: yes (the mutated declaration was printed from the module).
 * This file went red: yes (exit 1 at the NAMESPACE equality assertion).
 * The module was restored and its original SHA-256 was confirmed.
 */
'use strict';

require('../lib/isolated-environment').activate('providers-reminders');
const assert = require('node:assert/strict');
const reminders = require('../../src/lib/providers/reminders');
const { createStateStore } = require('../../src/lib/state-store');

const store = createStateStore({ file: ':memory:', ownerId: 'providers-reminders-test' });
const dependencies = { state: store };
const ID = 'reminder-11111111-1111-4111-8111-111111111111';

try {
  assert.equal(reminders.NAMESPACE, 'personal.reminders');

  assert.deepEqual(reminders.parseScheduleHints('Water plants every Monday to Friday at 8:30 p.m.'), {
    recurrence: 'custom-weekdays',
    weekdays: [1, 2, 3, 4, 5],
    localTime: '20:30',
    scheduleHint: 'weekday:1,2,3,4,5'
  });

  const created = reminders.create({
    reminderId: ID,
    title: '  Submit the weekly report  ',
    dueAt: '2026-09-04T09:00:00-04:00',
    timezone: 'America/New_York',
    localTime: '09:00',
    recurrence: 'custom-weekdays',
    weekdays: [5, 1],
    note: 'Attach the figures.'
  }, dependencies);
  assert.equal(created.reminderId, ID);
  assert.equal(created.title, 'Submit the weekly report');
  assert.equal(created.dueAt, '2026-09-04T13:00:00.000Z');
  assert.deepEqual(created.weekdays, [1, 5]);
  assert.equal(created.status, 'active');
  assert.equal(created.created, true);
  assert.equal(created.contentTrust, 'untrusted');
  assert.equal(created.grantsAuthority, false);

  assert.throws(
    () => reminders.create({ title: 'Bad schedule', recurrence: 'custom-weekdays' }, dependencies),
    error => error.code === 'REMINDER_INVALID_ARGUMENT' && error.details.field === 'weekdays'
  );

  const captured = reminders.capture({ text: 'Call Sam every Tuesday at 7 p.m.' }, dependencies);
  assert.equal(captured.status, 'needs-confirmation');
  assert.equal(captured.needsConfirmation, true);
  assert.equal(captured.parsedSchedule.localTime, '19:00');
  assert.deepEqual(captured.parsedSchedule.weekdays, [2]);
  assert.equal(captured.recurrence, 'custom-weekdays');

  const listed = reminders.list({ limit: 10 }, dependencies);
  assert.equal(listed.count, 2);
  assert.deepEqual(listed.reminders.map(item => item.reminderId), [ID, captured.reminderId]);

  const due = reminders.due({ before: '2026-09-05T00:00:00Z' }, dependencies);
  assert.deepEqual(due.reminders.map(item => item.reminderId), [ID]);

  assert.throws(
    () => reminders.complete({ reminderId: ID, expectedRevision: created.revision + 1 }, dependencies),
    error => error.code === 'REMINDER_REVISION_CONFLICT' && error.details.actualRevision === created.revision
  );
  const completed = reminders.complete({ reminderId: ID, expectedRevision: created.revision }, dependencies);
  assert.equal(completed.status, 'completed');
  assert.match(completed.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  const replay = reminders.complete({ reminderId: ID }, dependencies);
  assert.equal(replay.replayed, true);
  assert.equal(reminders.list({}, dependencies).count, 1);
  assert.equal(reminders.list({ includeCompleted: true }, dependencies).count, 2);

  assert.throws(
    () => reminders.publicRecord({ key: 'damaged', value: { type: 'not-a-reminder' } }),
    error => error.code === 'REMINDER_DATA_INVALID'
  );

  const longStatement = `${'Keep the full captured owner wording. '.repeat(8)}Final detail: bring the café 雪 notebook.`;
  assert.ok(longStatement.length > 240 && longStatement.length <= 2000);
  const longCapture = reminders.capture({ text: longStatement }, dependencies);
  assert.equal(longCapture.capturedText, longStatement);
  assert.equal(store.getMemory({ namespace: reminders.NAMESPACE, key: longCapture.reminderId }).value.note, longStatement,
    'the durable note must retain the full statement beyond the displayed title');
  assert.equal(reminders.list({}, dependencies).reminders.find(item => item.reminderId === longCapture.reminderId).note, longStatement,
    'a later reader must recover the full owner statement without the capture response');

  for (const invalidDate of ['2026-02-30T09:00:00-08:00', '2025-02-29T09:00:00Z', '1900-02-29T09:00:00Z', '2026-04-31T09:00:00Z', '2026-09-08T24:00:00Z']) {
    assert.throws(() => reminders.create({ title: 'Invalid calendar date', dueAt: invalidDate }, dependencies),
      error => error.code === 'REMINDER_INVALID_ARGUMENT' && error.details.field === 'dueAt', invalidDate);
    assert.throws(() => reminders.due({ before: invalidDate }, dependencies),
      error => error.code === 'REMINDER_INVALID_ARGUMENT', 'a cutoff must not silently move to a different date either');
  }
  const leapDay = reminders.create({ title: 'Valid leap day', dueAt: '2000-02-29T09:00:00+14:00' }, dependencies);
  assert.equal(leapDay.dueAt, '2000-02-28T19:00:00.000Z');

  console.log('Reminders provider behavior tests passed.');
} finally {
  store.close();
}

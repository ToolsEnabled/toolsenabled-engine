'use strict';

require('../lib/isolated-environment').activate('personal-calendar');
const assert = require('node:assert/strict');
const reminders = require('../../src/lib/providers/reminders');
const { createStateStore } = require('../../src/lib/state-store');
const registry = require('../../src/lib/tool-registry');

const store = createStateStore({ file: ':memory:', ownerId: 'personal-calendar-test' });

try {
  const captured = reminders.capture({ text: 'Quiz on Wednesday', timezone: 'America/Los_Angeles' }, { state: store });
  assert.equal(captured.needsConfirmation, true);
  assert.equal(captured.status, 'needs-confirmation');
  assert.equal(captured.contentTrust, 'untrusted');
  assert.match(captured.reminderId, /^reminder-[a-f0-9-]{36}$/);

  const classCapture = reminders.capture({ text: 'I have class every Monday–Thursday at 10am', timezone: 'America/Los_Angeles' }, { state: store });
  assert.deepEqual(classCapture.parsedSchedule.weekdays, [1, 2, 3, 4]);
  assert.equal(classCapture.parsedSchedule.localTime, '10:00');
  assert.equal(classCapture.recurrence, 'custom-weekdays');
  assert.equal(classCapture.localTime, '10:00');

  const dueAt = '2026-07-29T17:00:00-07:00';
  const confirmed = reminders.create({
    title: 'Submit quiz', dueAt, timezone: 'America/Los_Angeles',
    recurrence: 'none', note: 'Personal Calendar only.'
  }, { state: store });
  assert.equal(confirmed.status, 'active');
  assert.equal(confirmed.dueAt, '2026-07-30T00:00:00.000Z');
  assert.equal(confirmed.revision, 1);

  const listed = reminders.list({}, { state: store });
  assert.equal(listed.contentTrust, 'untrusted');
  assert.equal(listed.count, 3);
  assert.equal(listed.reminders.some(item => item.title === 'Submit quiz'), true);

  const completed = reminders.complete({ reminderId: confirmed.reminderId, expectedRevision: confirmed.revision }, { state: store });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.revision, 2);
  assert.equal(reminders.list({}, { state: store }).reminders.some(item => item.reminderId === confirmed.reminderId), false);
  assert.equal(reminders.list({ includeCompleted: true }, { state: store }).reminders.some(item => item.reminderId === confirmed.reminderId), true);
  const due = reminders.due({ before: '2026-07-31T00:00:00Z' }, { state: store });
  assert.equal(due.reminders.some(item => item.reminderId === confirmed.reminderId), false, 'completed reminders are excluded from due reads');

  assert.throws(() => reminders.create({ title: 'Bad', dueAt: 'tomorrow' }, { state: store }), error => error && error.code === 'REMINDER_INVALID_ARGUMENT');
  assert.throws(() => reminders.create({ title: 'Bad', recurrence: 'custom-weekdays' }, { state: store }), error => error && error.code === 'REMINDER_INVALID_ARGUMENT');
  assert.throws(() => reminders.create({ title: 'Bad', note: 'ghp_12345678901234567890' }, { state: store }), error => error && error.code === 'MEMORY_SECRET_REJECTED');

  assert.ok(registry.getTool('personal_calendar.capture'));
  assert.ok(registry.getTool('personal_calendar.create'));
  assert.ok(registry.getTool('personal_calendar.list'));
  assert.ok(registry.getTool('personal_calendar.due'));
  assert.ok(registry.getTool('personal_calendar.complete'));
  assert.equal(registry.validateRegistry().valid, true);

  const olderDue = reminders.create({ title: 'Older deadline must remain visible', dueAt: '2026-07-29T08:00:00Z' }, { state: store });
  const newerFuture = Array.from({ length: 21 }, (_, index) => reminders.create({
    title: `Newer future reminder ${index}`, dueAt: '2027-01-01T08:00:00Z'
  }, { state: store }));
  assert.deepEqual(reminders.due({ before: '2026-07-31T00:00:00Z' }, { state: store }).reminders.map(item => item.reminderId), [olderDue.reminderId],
    'future entries must be filtered before the bounded result limit');
  assert.equal(reminders.list({ limit: 1 }, { state: store }).reminders[0].reminderId, olderDue.reminderId,
    'limit must select the earliest due reminder, not the most recently updated ones');
  for (const item of newerFuture) reminders.complete({ reminderId: item.reminderId, expectedRevision: item.revision }, { state: store });
  assert.equal(reminders.list({ limit: 1 }, { state: store }).reminders[0].reminderId, olderDue.reminderId,
    'completed entries must also be filtered before the limit');

  const conflictTarget = reminders.create({ title: 'Concurrent owner edit', note: 'Original note' }, { state: store });
  let interleaved = false;
  const interleavingState = {
    getMemory(selector) {
      const read = store.getMemory(selector);
      if (!interleaved && selector.key === conflictTarget.reminderId) {
        interleaved = true;
        store.setMemory({ ...selector, value: { ...read.value, note: 'New owner detail must survive' },
          note: read.note, tags: read.tags, expectedRevision: read.revision });
      }
      return read;
    },
    setMemory(input) { return store.setMemory(input); }
  };
  assert.throws(() => reminders.complete({ reminderId: conflictTarget.reminderId, expectedRevision: 1 }, { state: interleavingState }),
    error => error.code === 'REMINDER_REVISION_CONFLICT' && error.details.actualRevision === 2,
    'a real store write between read and commit must not be overwritten by stale completion');
  const stillActive = store.getMemory({ namespace: reminders.NAMESPACE, key: conflictTarget.reminderId });
  assert.equal(stillActive.value.status, 'active');
  assert.equal(stillActive.value.note, 'New owner detail must survive');
  assert.equal(stillActive.revision, 2);

  const sameId = 'reminder-33333333-3333-4333-8333-333333333333';
  let competingCreate = false;
  const creatingState = {
    getMemory(selector) {
      const read = store.getMemory(selector);
      if (!competingCreate && selector.key === sameId) {
        competingCreate = true;
        reminders.create({ reminderId: sameId, title: 'First committed owner title' }, { state: store });
      }
      return read;
    },
    setMemory(input) { return store.setMemory(input); }
  };
  assert.throws(() => reminders.create({ reminderId: sameId, title: 'Must not replace the first title' }, { state: creatingState }),
    error => error.code === 'REMINDER_EXISTS', 'absence must also be checked atomically when creating an explicit ID');
  const firstCreate = store.getMemory({ namespace: reminders.NAMESPACE, key: sameId });
  assert.equal(firstCreate.value.title, 'First committed owner title');
  assert.equal(firstCreate.revision, 1);

  console.log('Personal Calendar tests passed.');
} finally {
  store.close();
}

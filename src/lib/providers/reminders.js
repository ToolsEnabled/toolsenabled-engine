'use strict';

// Local-only Personal Calendar commitments/reminders. This does not create a
// Google Calendar event
// or schedule a Windows task: an agent may capture a thought, then the owner
// can confirm a durable reminder. Values are kept in the existing memory table, which gives
// us the same bounded size, secret rejection, optimistic-concurrency, and
// signed audit behavior as memory.set.
const crypto = require('node:crypto');
const { getStateStore } = require('../state-store');
const memory = require('./memory');

const NAMESPACE = 'personal.reminders';
const KIND = 'reminder';
const MAX_TITLE = 240;
const MAX_NOTE = 2000;
const MAX_CAPTURE = 2000;
const MAX_LIST = 20;
const ID_RE = /^reminder-[a-f0-9-]{36}$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const RECURRENCES = new Set(['none', 'daily', 'weekdays', 'weekly', 'custom-weekdays']);
const STATUSES = new Set(['active', 'needs-confirmation', 'completed']);
const WEEKDAY_NAMES = Object.freeze({
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6
});
const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

function state(dependencies = {}) {
  return dependencies.state || getStateStore();
}

function fail(code, message, details) {
  const error = new TypeError(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function string(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fail('REMINDER_INVALID_ARGUMENT', `${field} is required.`, { field });
    return undefined;
  }
  if (typeof value !== 'string' || value.length < (required ? 1 : 0) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw fail('REMINDER_INVALID_ARGUMENT', `${field} must be a clean string up to ${max} characters.`, { field });
  }
  return value;
}

function dueAt(value) {
  if (value === undefined) return undefined;
  const candidate = string(value, 'dueAt', 40);
  const parts = RFC3339_RE.exec(candidate);
  if (!parts || !Number.isFinite(Date.parse(candidate))) {
    throw fail('REMINDER_INVALID_ARGUMENT', 'dueAt must be a valid RFC3339 timestamp with an explicit timezone.', { field: 'dueAt' });
  }
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse normalizes impossible dates such as February 30 and accepts
  // hour 24. Validate the owner's local date before converting its offset.
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59) {
    throw fail('REMINDER_INVALID_ARGUMENT', 'dueAt must be a valid RFC3339 timestamp with an explicit timezone.', { field: 'dueAt' });
  }
  return new Date(candidate).toISOString();
}

function localTime(value) {
  if (value === undefined) return undefined;
  const candidate = string(value, 'localTime', 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(candidate)) {
    throw fail('REMINDER_INVALID_ARGUMENT', 'localTime must use 24-hour HH:mm notation.', { field: 'localTime' });
  }
  return candidate;
}

function parseScheduleHints(text) {
  const lower = text.toLowerCase();
  const names = [...lower.matchAll(/\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b/g)]
    .map(match => match[1]);
  // Prefer the explicit full/short forms map; malformed partial matches simply
  // remain an unparsed owner statement and still require confirmation.
  let weekdays = [...new Set(names.map(name => WEEKDAY_NAMES[name]).filter(day => day !== undefined))].sort((left, right) => left - right);
  const range = lower.match(/\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b\s*(?:-|–|—|\bto\b)\s*\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b/);
  if (range) {
    const start = WEEKDAY_NAMES[range[1]];
    const end = WEEKDAY_NAMES[range[2]];
    if (start !== undefined && end !== undefined && start <= end) {
      weekdays = Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
  }
  const at = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/);
  let parsedTime;
  if (at) {
    let hour = Number(at[1]);
    const minute = Number(at[2] || '00');
    const pm = at[3].startsWith('p');
    if (hour >= 1 && hour <= 12) {
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
      parsedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }
  const every = /\bevery\b/.test(lower);
  const recurrenceValue = every && weekdays.length > 0 ? 'custom-weekdays' : 'none';
  const scheduleHint = weekdays.length > 0 ? `weekday:${weekdays.join(',')}` : undefined;
  return { recurrence: recurrenceValue, weekdays: weekdays.length > 0 ? weekdays : undefined, localTime: parsedTime, scheduleHint };
}

function recurrence(value, weekdays) {
  const selected = value === undefined ? 'none' : string(value, 'recurrence', 32);
  if (!RECURRENCES.has(selected)) throw fail('REMINDER_INVALID_ARGUMENT', 'recurrence is not supported.', { field: 'recurrence' });
  let days;
  if (weekdays !== undefined) {
    if (!Array.isArray(weekdays) || weekdays.length < 1 || weekdays.length > 7 || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw fail('REMINDER_INVALID_ARGUMENT', 'weekdays must contain one through seven unique values from 0 (Sunday) through 6 (Saturday).', { field: 'weekdays' });
    }
    days = [...new Set(weekdays)].sort((left, right) => left - right);
    if (days.length !== weekdays.length) throw fail('REMINDER_INVALID_ARGUMENT', 'weekdays must not contain duplicates.', { field: 'weekdays' });
  }
  if (selected === 'custom-weekdays' && !days) throw fail('REMINDER_INVALID_ARGUMENT', 'custom-weekdays requires weekdays.', { field: 'weekdays' });
  if (selected !== 'custom-weekdays' && days) throw fail('REMINDER_INVALID_ARGUMENT', 'weekdays is only valid with custom-weekdays.', { field: 'weekdays' });
  return { recurrence: selected, weekdays: days };
}

function normalizeId(value) {
  if (value === undefined) return `reminder-${crypto.randomUUID()}`;
  const candidate = string(value, 'reminderId', 80);
  if (!ID_RE.test(candidate)) throw fail('REMINDER_INVALID_ARGUMENT', 'reminderId must be a generated reminder ID.', { field: 'reminderId' });
  return candidate;
}

function publicRecord(entry) {
  if (!entry || !entry.value || entry.value.type !== KIND) {
    throw fail('REMINDER_DATA_INVALID', 'Stored reminder data could not be validated.', {
      reminderId: entry && entry.key
    });
  }
  return {
    reminderId: entry.key,
    title: entry.value.title,
    dueAt: entry.value.dueAt || null,
    timezone: entry.value.timezone || null,
    localTime: entry.value.localTime || null,
    recurrence: entry.value.recurrence,
    weekdays: entry.value.weekdays || null,
    scheduleHint: entry.value.scheduleHint || null,
    note: entry.value.note || null,
    status: entry.value.status,
    createdAt: entry.value.createdAt,
    completedAt: entry.value.completedAt || null,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
    valueHash: entry.valueHash
  };
}

function readEntry(id, dependencies = {}) {
  const entry = state(dependencies).getMemory({ namespace: NAMESPACE, key: id });
  if (!entry) return null;
  publicRecord(entry);
  return entry;
}

function save(entry, dependencies = {}) {
  let saved;
  try {
    saved = memory.set({
      namespace: NAMESPACE,
      key: entry.reminderId,
      value: entry.value,
      note: `reminder ${entry.value.status} ${entry.value.title}`,
      tags: ['reminder', entry.value.status],
      expectedRevision: entry.expectedRevision
    }, dependencies);
  } catch (error) {
    if (error.code !== 'MEMORY_REVISION_CONFLICT') throw error;
    if (entry.expectedRevision === 0) {
      throw fail('REMINDER_EXISTS', 'A reminder with this ID already exists.', { reminderId: entry.reminderId });
    }
    throw fail('REMINDER_REVISION_CONFLICT', 'Reminder changed before completion.', {
      reminderId: entry.reminderId, expectedRevision: entry.expectedRevision, actualRevision: error.details.actualRevision
    });
  }
  // Return the committed revision, without a second read that could instead
  // observe a subsequent writer's value and misattribute it to this operation.
  const committed = { key: entry.reminderId, value: entry.value, ...saved };
  return { ...publicRecord(committed), created: saved.created, replayed: saved.replayed, ...UNTRUSTED_CONTENT };
}

function create(input = {}, dependencies = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('REMINDER_INVALID_ARGUMENT', 'Reminder input must be an object.');
  const reminderId = normalizeId(input.reminderId);
  if (readEntry(reminderId, dependencies)) throw fail('REMINDER_EXISTS', 'A reminder with this ID already exists.', { reminderId });
  const title = string(input.title, 'title', MAX_TITLE, { required: true }).trim();
  if (!title) throw fail('REMINDER_INVALID_ARGUMENT', 'title must not be blank.', { field: 'title' });
  const due = dueAt(input.dueAt);
  const repeat = recurrence(input.recurrence, input.weekdays);
  const timezone = string(input.timezone, 'timezone', 80);
  const time = localTime(input.localTime);
  const scheduleHint = string(input.scheduleHint, 'scheduleHint', 120);
  const note = string(input.note, 'note', MAX_NOTE);
  const status = input.status === undefined ? 'active' : string(input.status, 'status', 32);
  if (!STATUSES.has(status) || status === 'completed') throw fail('REMINDER_INVALID_ARGUMENT', 'New reminders must be active or needs-confirmation.', { field: 'status' });
  const now = new Date().toISOString();
  return save({ reminderId, expectedRevision: 0, value: {
    type: KIND, title, dueAt: due, timezone, recurrence: repeat.recurrence,
    weekdays: repeat.weekdays, localTime: time, scheduleHint, note, status, createdAt: now
  } }, dependencies);
}

function capture(input = {}, dependencies = {}) {
  const text = string(input.text, 'text', MAX_CAPTURE, { required: true }).trim();
  if (!text) throw fail('REMINDER_INVALID_ARGUMENT', 'text must not be blank.', { field: 'text' });
  // Capture is intentionally an inbox item.  It gives the coordinator a durable,
  // searchable handoff without silently guessing a date, timezone, or an
  // external calendar mutation.  After clarification the agent calls create.
  const parsed = parseScheduleHints(text);
  const selectedRecurrence = input.recurrence || parsed.recurrence;
  const selectedWeekdays = input.weekdays || (selectedRecurrence === 'custom-weekdays' ? parsed.weekdays : undefined);
  const reminder = create({
    title: text.slice(0, MAX_TITLE),
    dueAt: input.dueAt,
    timezone: input.timezone,
    localTime: input.localTime || parsed.localTime,
    recurrence: selectedRecurrence,
    weekdays: selectedWeekdays,
    scheduleHint: parsed.scheduleHint,
    // The bounded title is a display summary. Preserve the complete statement
    // in the existing durable note so a later reader can confirm every detail.
    note: text,
    status: 'needs-confirmation'
  }, dependencies);
  return { ...reminder, capturedText: text, parsedSchedule: parsed, needsConfirmation: true, action: 'confirm-then-create-or-update', ...UNTRUSTED_CONTENT };
}

function list(input = {}, dependencies = {}) {
  const includeCompleted = input.includeCompleted === true;
  const before = input.dueBefore === undefined ? undefined : dueAt(input.dueBefore);
  const limit = input.limit === undefined ? MAX_LIST : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) throw fail('REMINDER_INVALID_ARGUMENT', 'limit must be an integer from 1 through 20.', { field: 'limit' });
  const rows = state(dependencies).listReminderEntries({ namespace: NAMESPACE, includeCompleted, dueBefore: before, limit })
    .map(publicRecord);
  return { reminders: rows, count: rows.length, ...UNTRUSTED_CONTENT };
}

function due(input = {}, dependencies = {}) {
  const before = input.before === undefined ? new Date().toISOString() : dueAt(input.before);
  return list({ dueBefore: before, includeCompleted: false, limit: input.limit }, dependencies);
}

function complete(input = {}, dependencies = {}) {
  const reminderId = normalizeId(input.reminderId);
  const existing = readEntry(reminderId, dependencies);
  if (!existing) throw fail('REMINDER_NOT_FOUND', 'Reminder was not found.', { reminderId });
  if (existing.value.status === 'completed') return { ...publicRecord(existing), replayed: true, ...UNTRUSTED_CONTENT };
  if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
    throw fail('REMINDER_REVISION_CONFLICT', 'Reminder changed before completion.', { reminderId, expectedRevision: input.expectedRevision, actualRevision: existing.revision });
  }
  const value = { ...existing.value, status: 'completed', completedAt: new Date().toISOString() };
  return save({ reminderId, value, expectedRevision: existing.revision }, dependencies);
}

module.exports = { NAMESPACE, capture, complete, create, due, list, parseScheduleHints, publicRecord };

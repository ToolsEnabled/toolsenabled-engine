'use strict';

// Five RFC3339-timestamp fields in tool-registry.js declared maxLength: 40,
// a number that does not match what either of the two literal patterns those
// fields actually use can ever produce.
//
// MEASURED before this fix:
//   personal_calendar.capture.dueAt, personal_calendar.create.dueAt,
//   personal_calendar.list.dueBefore, personal_calendar.due.before all use
//   pattern ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$
//     base "YYYY-MM-DDTHH:MM:SS"        = 19 chars (fixed)
//   + optional ".ffffff"                =  0 or 2..7 chars
//   + mandatory "Z" or "+HH:MM"/"-HH:MM" =  1 or 6 chars
//   longest possible match: 19 + 7 + 6 = 32 chars, never 40.
//
//   paddle.subscription_cancel.expectedUpdatedAt (built by the providerTimestamp()
//   helper) uses the stricter Z-only pattern
//   ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$
//   longest possible match: 19 + 7 + 1 = 27 chars, never 40.
//
// A caller who trusts only the numeric bounds (the part of the schema that
// does not require decoding a regex) would believe a 33-40 character
// timestamp is accepted by all five fields; none of them ever were, because
// schema-validator.js applies minLength/maxLength/pattern independently --
// none of the three short-circuits another (see validateNode() in
// src/lib/schema-validator.js) -- so the pattern already rejected anything
// past 32 (or 27) regardless of what the stated ceiling claimed. Two
// independent provider-level checks confirm the same ceiling was never live
// downstream either: src/lib/providers/reminders.js's own dueAt() calls
// string(value, 'dueAt', 40) before testing the identical RFC3339_RE, and
// src/lib/providers/paddle.js's own providerTimestamp() calls
// safety.text(value, label, 40, /.../) before testing the identical Z-only
// pattern -- both cap at the same wrong 40 and both were already moot for
// the same reason. So this fix changes zero caller-visible behavior; it only
// makes the declared bound equal to what the field has always actually
// accepted.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Per the standing trap (state modules decide their root at first require):
// a scratch state root BEFORE the first src/lib require.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc3339-schema-bounds-'));
process.env.TOOLSENABLED_STATE_ROOT = path.join(SCRATCH, 'state');
fs.mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true });

const { getTool } = require('../src/lib/tool-registry');
const { validate } = require('../src/lib/schema-validator');

// The longest string either pattern can ever match, spelled out as literal
// examples rather than computed, so a reader can check the arithmetic by eye:
//   19 fixed chars + ".123456" (7) + "+05:30" (6) = 32
const LONGEST_OFFSET_TIMESTAMP = '2026-09-03T12:00:00.123456+05:30';
//   19 fixed chars + ".123456" (7) + "Z" (1) = 27
const LONGEST_Z_ONLY_TIMESTAMP = '2026-09-03T12:00:00.123456Z';
assert.equal(LONGEST_OFFSET_TIMESTAMP.length, 32, 'test fixture arithmetic must be right before it proves anything');
assert.equal(LONGEST_Z_ONLY_TIMESTAMP.length, 27, 'test fixture arithmetic must be right before it proves anything');

// Real shape every one of these fields actually receives day to day: what
// new Date().toISOString() produces (fixed millisecond precision, Z-only).
const REAL_ISO_TIMESTAMP = new Date('2026-09-03T12:00:00.000Z').toISOString();
assert.equal(REAL_ISO_TIMESTAMP, '2026-09-03T12:00:00.000Z');

const OFFSET_FIELDS = [
  ['personal_calendar.capture', 'dueAt'],
  ['personal_calendar.create', 'dueAt'],
  ['personal_calendar.list', 'dueBefore'],
  ['personal_calendar.due', 'before']
];

function propertyOf(toolName, field) {
  const tool = getTool(toolName);
  assert.ok(tool, `${toolName} must be registered`);
  const prop = tool.inputSchema.properties[field];
  assert.ok(prop, `${toolName}.${field} must be declared`);
  return prop;
}

test('personal_calendar RFC3339 fields: declared maxLength equals the longest string the pattern admits (32), not 40', () => {
  for (const [toolName, field] of OFFSET_FIELDS) {
    const prop = propertyOf(toolName, field);
    assert.match(LONGEST_OFFSET_TIMESTAMP, new RegExp(prop.pattern),
      `${toolName}.${field}'s pattern must accept the 32-character longest-form timestamp`);
    assert.equal(prop.minLength, 20, `${toolName}.${field}.minLength must stay 20`);
    assert.equal(prop.maxLength, 32,
      `${toolName}.${field}.maxLength must equal 32 (the longest the pattern admits), not a wider number nothing can ever be`);
  }
});

test('paddle.subscription_cancel.expectedUpdatedAt: declared maxLength equals the longest string its Z-only pattern admits (27), not 40', () => {
  const prop = propertyOf('paddle.subscription_cancel', 'expectedUpdatedAt');
  assert.match(LONGEST_Z_ONLY_TIMESTAMP, new RegExp(prop.pattern),
    "expectedUpdatedAt's pattern must accept the 27-character longest-form timestamp");
  assert.equal(prop.minLength, 20, 'expectedUpdatedAt.minLength must stay 20');
  assert.equal(prop.maxLength, 27,
    'expectedUpdatedAt.maxLength must equal 27 (the longest the pattern admits), not a wider number nothing can ever be');
});

test('personal_calendar RFC3339 fields: the longest real value validates cleanly end to end', () => {
  for (const [toolName, field] of OFFSET_FIELDS) {
    const schema = getTool(toolName).inputSchema;
    const base = toolName === 'personal_calendar.create' ? { title: 'x' } : (toolName === 'personal_calendar.capture' ? { text: 'x' } : {});
    assert.deepEqual(validate(schema, { ...base, [field]: LONGEST_OFFSET_TIMESTAMP }), [],
      `${toolName}.${field} must accept its own longest-admitted value with zero schema errors`);
    assert.deepEqual(validate(schema, { ...base, [field]: REAL_ISO_TIMESTAMP }), [],
      `${toolName}.${field} must accept a real toISOString() value with zero schema errors`);
  }
});

function paddleSubscriptionCancelBase() {
  // Every OTHER field paddle.subscription_cancel requires, so validate()
  // reports errors for expectedUpdatedAt alone rather than drowning the
  // assertion in unrelated missing-field noise.
  return {
    subscriptionId: 'sub_' + 'a'.repeat(26),
    effectiveFrom: 'immediately',
    expectedStatus: 'active',
    idempotencyKey: 'cancel-test-0001'
  };
}

test('paddle.subscription_cancel.expectedUpdatedAt: the longest real Z-only value validates cleanly end to end', () => {
  const schema = getTool('paddle.subscription_cancel').inputSchema;
  const base = paddleSubscriptionCancelBase();
  assert.deepEqual(validate(schema, { ...base, expectedUpdatedAt: LONGEST_Z_ONLY_TIMESTAMP }), [],
    'expectedUpdatedAt must accept its own longest-admitted value with zero schema errors');
  assert.deepEqual(validate(schema, { ...base, expectedUpdatedAt: REAL_ISO_TIMESTAMP }), [],
    'expectedUpdatedAt must accept a real toISOString() value with zero schema errors');
});

test('personal_calendar RFC3339 fields and expectedUpdatedAt: a 40-character string was already refused before this fix, and stays refused', () => {
  // Not a new rejection: proves the earlier maxLength:40 never actually let
  // a 33-40 char value through either, because the pattern always gated it
  // underneath (see validateNode() applying minLength/maxLength/pattern
  // independently). This fix only makes the stated bound honest.
  const oversizedOffset = LONGEST_OFFSET_TIMESTAMP + 'X'.repeat(40 - LONGEST_OFFSET_TIMESTAMP.length);
  assert.equal(oversizedOffset.length, 40);
  for (const [toolName, field] of OFFSET_FIELDS) {
    const schema = getTool(toolName).inputSchema;
    const base = toolName === 'personal_calendar.create' ? { title: 'x' } : (toolName === 'personal_calendar.capture' ? { text: 'x' } : {});
    const errors = validate(schema, { ...base, [field]: oversizedOffset });
    assert.ok(errors.length > 0, `${toolName}.${field} must still refuse a 40-char value`);
  }

  const oversizedZOnly = LONGEST_Z_ONLY_TIMESTAMP + 'X'.repeat(40 - LONGEST_Z_ONLY_TIMESTAMP.length);
  assert.equal(oversizedZOnly.length, 40);
  const paddleSchema = getTool('paddle.subscription_cancel').inputSchema;
  const paddleErrors = validate(paddleSchema, { ...paddleSubscriptionCancelBase(), expectedUpdatedAt: oversizedZOnly });
  assert.ok(paddleErrors.length > 0, 'expectedUpdatedAt must still refuse a 40-char value');
});

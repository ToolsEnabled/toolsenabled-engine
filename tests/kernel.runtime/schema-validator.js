'use strict';

const assert = require('node:assert/strict');
const { SchemaValidationError, validate, assertValid } = require('../../src/lib/schema-validator');

const profileSchema = {
  type: 'object',
  properties: {
    profile: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        active: { type: 'boolean' }
      },
      required: ['name'],
      additionalProperties: false
    },
    scores: { type: 'array', items: { type: 'number' } },
    mode: { type: 'string', enum: ['safe', 'fast'] }
  },
  required: ['profile', 'mode'],
  additionalProperties: false
};

const valid = {
  profile: { name: 'Ada', age: 37, active: true },
  scores: [1, 2.5, 3],
  mode: 'safe'
};

assert.deepEqual(validate(profileSchema, valid), []);
assert.strictEqual(assertValid(profileSchema, valid), valid);

assert.deepEqual(validate(profileSchema, { profile: {}, mode: 'safe' }), [
  { path: '$.profile.name', keyword: 'required', message: 'is required' }
]);

assert.deepEqual(validate(profileSchema, {
  profile: { name: 'Ada', extra: true }, mode: 'safe', unexpected: 1
}), [
  { path: '$.profile.extra', keyword: 'additionalProperties', message: 'additional property is not allowed' },
  { path: '$.unexpected', keyword: 'additionalProperties', message: 'additional property is not allowed' }
]);

const typeErrors = validate(profileSchema, {
  profile: { name: 4, age: 2.5, active: 'yes' },
  scores: [1, 'two', Number.POSITIVE_INFINITY],
  mode: 'unsafe'
});
assert.deepEqual(typeErrors, [
  { path: '$.profile.name', keyword: 'type', message: 'expected string, received number' },
  { path: '$.profile.age', keyword: 'type', message: 'expected integer, received number' },
  { path: '$.profile.active', keyword: 'type', message: 'expected boolean, received string' },
  { path: '$.scores[1]', keyword: 'type', message: 'expected number, received string' },
  { path: '$.scores[2]', keyword: 'type', message: 'expected number, received non-finite number' },
  { path: '$.mode', keyword: 'enum', message: 'must be one of "safe", "fast"' }
]);

assert.deepEqual(validate({ type: 'object' }, { anything: true }), []);
assert.deepEqual(validate({
  type: 'object', properties: {}, additionalProperties: { type: 'string', maxLength: 3 }
}, { first: 'ok', second: 4, third: 'long' }), [
  { path: '$.second', keyword: 'type', message: 'expected string, received number' },
  { path: '$.third', keyword: 'maxLength', message: 'must contain at most 3 characters; received 4' }
]);
assert.deepEqual(validate({ type: 'array' }, [1, 'unconstrained']), []);
assert.deepEqual(validate({ enum: [{ role: 'admin' }, null] }, { role: 'admin' }), []);
assert.deepEqual(validate({ type: 'string' }, null), [
  { path: '$', keyword: 'type', message: 'expected string, received null' }
]);

assert.deepEqual(validate({
  type: 'object',
  properties: { 'display-name': { type: 'string' } },
  additionalProperties: false
}, { 'display-name': 42 }), [
  { path: '$["display-name"]', keyword: 'type', message: 'expected string, received number' }
]);

assert.throws(
  () => assertValid(profileSchema, { profile: {}, mode: 'unsafe', extra: true }),
  error => {
    assert.ok(error instanceof SchemaValidationError);
    assert.equal(error.name, 'SchemaValidationError');
    assert.equal(error.code, 'INVALID_PARAMS');
    assert.equal(error.errors.length, 3);
    assert.match(error.message, /^Invalid input: \$\.profile\.name: is required;/);
    assert.match(error.message, /\$\.mode: must be one of "safe", "fast"/);
    assert.match(error.message, /\$\.extra: additional property is not allowed$/);
    return true;
  }
);
assert.throws(() => new SchemaValidationError(), /requires at least one validation error/);
assert.throws(() => new SchemaValidationError([]), /requires at least one validation error/);

assert.throws(() => validate({ type: 'date' }, '2026-01-01'), /unsupported type 'date'/);
assert.throws(() => validate({ type: 'object', required: 'name' }, {}), /required list/);
assert.throws(() => validate({ enum: 'safe' }, 'safe'), /enum.*must be an array/);

const bounded = {
  type: 'object',
  properties: {
    count: { type: 'integer', minimum: 1, maximum: 3 },
    ratio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
    label: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' },
    items: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } }
  },
  required: ['count', 'ratio', 'label', 'items'],
  additionalProperties: false
};
assert.deepEqual(validate(bounded, { count: 0, ratio: 1, label: 'A', items: [] }).map(error => error.keyword),
  ['minimum', 'exclusiveMaximum', 'minLength', 'pattern', 'minItems']);
assert.deepEqual(validate(bounded, { count: 2, ratio: 0.5, label: 'safe', items: ['a'] }), []);
assert.throws(() => validate({ type: 'object', properties: {}, required: ['missing'] }, {}), /not declared/);
assert.throws(() => validate({ type: 'object', additionalProperties: 'invalid' }, {}), /additionalProperties/);
assert.throws(() => validate({ type: 'string', pattern: '[' }, 'x'), /not a valid regular expression/);

// uniqueItems (tool-registry.js declares this on seven fields, e.g.
// the former durable-run submit's allowedWorkers; MEASURED 2026-09-03 that this validator
// read minItems and maxItems but never uniqueItems, so a caller could repeat
// the same entry up to maxItems times and receive zero errors). A duplicate
// primitive is caught, and the reported keyword/path/index match the style
// every other array keyword already uses here.
const uniqueArraySchema = { type: 'array', uniqueItems: true, items: { type: 'string' } };
assert.deepEqual(validate(uniqueArraySchema, ['codex', 'claude']), []);
assert.deepEqual(validate(uniqueArraySchema, ['codex', 'codex']), [
  { path: '$', keyword: 'uniqueItems', message: 'must not contain duplicate items (repeated at index 1)' }
]);
// Equality is by value, matching how `enum` above already compares with
// isDeepStrictEqual -- a repeated object is caught by content, not identity.
assert.deepEqual(validate({ type: 'array', uniqueItems: true, items: { type: 'object' } },
  [{ role: 'admin' }, { role: 'admin' }]).map(error => error.keyword), ['uniqueItems']);
// An array with NO uniqueItems keyword is unaffected: duplicates stay legal
// everywhere this was not explicitly declared (e.g. github issue labels).
assert.deepEqual(validate({ type: 'array', items: { type: 'string' } }, ['bug', 'bug', 'bug']), []);
// Malformed uniqueItems fails the same way a malformed enum already does:
// loudly, at schema-definition time, not silently ignored at validation time.
assert.throws(() => validate({ type: 'array', uniqueItems: 'true', items: { type: 'string' } }, ['a']),
  /uniqueItems.*must be a boolean/);

// AN EXPLICIT EMPTY ROOT NAMES NO FIELD, AND MUST NOT PRINT ONE.
//
// tool-registry.js#executeTool validates a tool's actual, flat call
// arguments this way: the value already IS the object the schema describes,
// so there is no enclosing field to label. Before this, only a non-empty
// options.path was honored -- '' was read as falsy and silently replaced
// with the '$' default (see validate()'s `options.path` check above) -- and
// separately, propertyPath('', 'x') printed the leading-dot artifact ".x".
// Both are pinned here directly, not only through the tool-registry.js
// integration test in tests/purchase-request-tool.test.js, so a regression in
// EITHER function is caught at the unit that owns it.
assert.deepEqual(validate(profileSchema, { profile: {}, mode: 'safe' }, { path: '' }), [
  { path: 'profile.name', keyword: 'required', message: 'is required' }
]);
assert.deepEqual(validate({
  type: 'object',
  properties: { 'display-name': { type: 'string' } },
  additionalProperties: false
}, { 'display-name': 42 }, { path: '' }), [
  { path: '["display-name"]', keyword: 'type', message: 'expected string, received number' }
]);
assert.throws(
  () => assertValid(bounded, {}, { path: '' }),
  error => {
    assert.ok(error instanceof SchemaValidationError);
    // No '$', no '.arguments', no leading dot: every name below is exactly
    // one of bounded's own top-level properties, spelled the way its schema
    // (and so a caller correcting a real tool call) spells it.
    assert.equal(error.message, 'Invalid input: count: is required; ratio: is required; '
      + 'label: is required; items: is required');
    return true;
  }
);
// options.path omitted entirely still defaults to '$' -- '' is a choice a
// caller states, never an accident of a falsy check.
assert.deepEqual(validate({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, {}), [
  { path: '$.a', keyword: 'required', message: 'is required' }
]);

// The caller must be able to trim an overlong Ledger checkpoint in one try.
// Report the length the validator actually measured, without echoing content.
const progressSchema = { type: 'object', properties: { reason: { type: 'string', maxLength: 300 } } };
const longReason = 'private checkpoint '.repeat(17);
assert.deepEqual(validate(progressSchema, { reason: 'x'.repeat(300) }), []);
assert.throws(() => assertValid(progressSchema, { reason: longReason }, { path: '' }), error => {
  assert.equal(error.code, 'INVALID_PARAMS');
  assert.equal(error.message, `Invalid input: reason: must contain at most 300 characters; received ${longReason.length}`);
  assert.equal(error.message.includes(longReason), false);
  return true;
});

console.log('Schema validator tests passed.');

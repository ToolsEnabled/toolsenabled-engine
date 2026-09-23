'use strict';

// tool-registry.js declares `uniqueItems: true` on seven array fields, and
// src/lib/schema-validator.js -- the shared engine every tool schema is
// checked against -- read minItems and maxItems on an array node but never
// looked at uniqueItems. MEASURED before this fix: validating
// overnight_advisory.submit's real registered schema against
// { ..., allowedWorkers: ['codex', 'codex', 'codex', 'codex'] } (four
// copies, still inside minItems:1/maxItems:4) returned an EMPTY error array.
// The schema promised rejection of a repeated entry; the validator carried
// out no such thing for any caller, on any of the seven fields.
//
// This suite has two parts. The first proves the fix concretely on the four
// fields where uniqueItems is not moot (i.e. maxItems > 1, so a duplicate
// can actually occur without also tripping maxItems on its own). The second
// walks the ENTIRE live registry for every uniqueItems declaration -- known
// today or added later -- and proves each one is actually enforced, so this
// suite need not be hand-extended the next time a tool adds one.
//
// Per the standing trap (state modules decide their root at first require):
// a scratch state root BEFORE the first src/lib require.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-items-schema-'));
process.env.TOOLSENABLED_STATE_ROOT = path.join(SCRATCH, 'state');
fs.mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true });

const { getTool, TOOL_REGISTRY } = require('../src/lib/tool-registry');
const { validate } = require('../src/lib/schema-validator');

function schemaOf(toolName) {
  const tool = getTool(toolName);
  assert.ok(tool, `${toolName} must be registered`);
  return tool.inputSchema;
}

function errorKeywords(schema, input) {
  return validate(schema, input, { path: '$.arguments' }).map(error => error.keyword);
}

// -- Part 1: the four fields where a duplicate is possible without also
// -- being a length violation (maxItems > 1 on all four).

test('overnight_advisory.submit: acceptanceChecklist rejects a repeated line, accepts distinct ones', () => {
  const schema = schemaOf('overnight_advisory.submit');
  assert.equal(schema.properties.acceptanceChecklist.uniqueItems, true);
  const base = {
    actor: 'human', idempotencyKey: 'idem-key-0000000002', title: 't', prompt: 'p'
  };
  assert.deepEqual(
    errorKeywords(schema, { ...base, acceptanceChecklist: ['same line', 'same line'] }),
    ['uniqueItems']
  );
  assert.deepEqual(errorKeywords(schema, { ...base, acceptanceChecklist: ['first line', 'second line'] }), []);
});

test('personal_calendar.capture: weekdays rejects a repeated day, accepts distinct ones', () => {
  const schema = schemaOf('personal_calendar.capture');
  assert.equal(schema.properties.weekdays.uniqueItems, true);
  assert.deepEqual(
    errorKeywords(schema, { text: 'quiz', recurrence: 'custom-weekdays', weekdays: [1, 1, 1] }),
    ['uniqueItems']
  );
  assert.deepEqual(
    errorKeywords(schema, { text: 'quiz', recurrence: 'custom-weekdays', weekdays: [1, 3, 5] }), []
  );
});

test('personal_calendar.create: weekdays rejects a repeated day, accepts distinct ones', () => {
  const schema = schemaOf('personal_calendar.create');
  assert.equal(schema.properties.weekdays.uniqueItems, true);
  assert.deepEqual(
    errorKeywords(schema, { title: 'quiz', recurrence: 'custom-weekdays', weekdays: [0, 0] }),
    ['uniqueItems']
  );
  assert.deepEqual(
    errorKeywords(schema, { title: 'quiz', recurrence: 'custom-weekdays', weekdays: [0, 6] }), []
  );
});

// -- Part 2: walk the live registry for every uniqueItems declaration and
// -- prove each is enforced, so a future eighth field is covered for free.

function sampleFor(itemSchema) {
  if (Array.isArray(itemSchema.enum)) {
    return { value: itemSchema.enum[0], supported: true };
  }
  if (itemSchema.type === 'integer' || itemSchema.type === 'number') {
    const base = itemSchema.minimum !== undefined ? itemSchema.minimum : 0;
    return { value: base, supported: true };
  }
  if (itemSchema.type === 'string' && itemSchema.pattern === undefined) {
    const length = Math.max(itemSchema.minLength || 1, 1);
    return { value: 'x'.repeat(Math.min(length, itemSchema.maxLength || length)), supported: true };
  }
  return { value: undefined, supported: false };
}

// A duplicate-probe array must itself stay inside the field's own
// minItems/maxItems, or the probe would also trip THOSE keywords and the
// "exactly one error, and it is uniqueItems" assertion below would be
// testing the wrong thing. When maxItems caps the field below 2 items, no
// array of that field can ever contain a duplicate -- uniqueItems is
// declared but structurally unreachable, not broken (this is the case for
// the two fieldIds acknowledgement lists this repo fixes at length 1).
function duplicateProbeLength(schema) {
  const minItems = schema.minItems === undefined ? 0 : schema.minItems;
  const maxItems = schema.maxItems;
  if (maxItems !== undefined && maxItems < 2) return null;
  return Math.max(minItems, 2);
}

function findUniqueItemsNodes(schema, jsonPath, out, seen) {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return;
  seen.add(schema);
  if (schema.type === 'array' && schema.uniqueItems === true && schema.items) {
    out.push({ jsonPath, schema });
  }
  if (schema.type === 'array' && schema.items) {
    findUniqueItemsNodes(schema.items, `${jsonPath}[]`, out, seen);
  }
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      findUniqueItemsNodes(child, `${jsonPath}.${key}`, out, seen);
    }
  }
}

test('registry sweep: every uniqueItems array field declared anywhere in TOOL_REGISTRY is actually enforced', () => {
  const found = [];
  const seen = new WeakSet();
  for (const descriptor of TOOL_REGISTRY) {
    findUniqueItemsNodes(descriptor.inputSchema, descriptor.name, found, seen);
  }

  // Pin today's measured count so a field silently losing its declaration
  // (or this sweep silently losing its reach) is visible as a number
  // changing, not just as fewer assertions quietly running.
  assert.ok(found.length >= 5,
    `expected at least 5 uniqueItems array fields across the registry, found ${found.length}: ${found.map(f => f.jsonPath).join(', ')}`);

  let checked = 0;
  let moot = 0;
  for (const { jsonPath, schema } of found) {
    const length = duplicateProbeLength(schema);
    if (length === null) { moot += 1; continue; }
    const sample = sampleFor(schema.items);
    if (!sample.supported) {
      // Only reached if a future field's item shape this generator does not
      // know how to instantiate (e.g. a pattern-constrained string) is
      // added. Fails loudly rather than skipping quietly, so it gets a
      // hand-written case instead of silent non-coverage.
      assert.fail(`${jsonPath}: sampleFor() cannot build a duplicate-probe value for items shape ${JSON.stringify(schema.items)}; add a case above instead of skipping it`);
    }
    const duplicate = new Array(length).fill(sample.value);
    const errors = validate(schema, duplicate, { path: jsonPath });
    assert.deepEqual(errors.map(error => error.keyword), ['uniqueItems'],
      `${jsonPath}: ${length} copies of ${JSON.stringify(sample.value)} should be refused for uniqueItems alone (path=${jsonPath}, got ${JSON.stringify(errors)})`);
    checked += 1;
  }
  // Every field this sweep found was either actually probed, or is moot
  // because maxItems caps it below 2 (mathematically no duplicate can
  // occur) -- never silently skipped for any other reason.
  assert.equal(checked + moot, found.length);
  assert.ok(checked >= 4, `expected at least 4 fields where a duplicate is actually reachable, checked ${checked}`);
});

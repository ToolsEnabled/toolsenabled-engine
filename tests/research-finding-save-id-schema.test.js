'use strict';

// research.finding_save's findingId/supersedes fields are a fixed-width
// format -- state-store.js#saveResearchFinding mints ids as
// F-<4-digit year>-<2-digit month><2-digit day>-<3-digit sequence>, e.g.
// F-2026-0903-001, and the tool's own pattern (^F-[0-9]{4}-[0-9]{4}-[0-9]{3}$)
// admits that exact 15-character shape and nothing else. The schema's
// minLength/maxLength are meant to tell a caller the same fact without
// decoding the regex; they must equal the one length the pattern actually
// admits, not some wider range that never lets a shorter or longer string
// through anyway because the pattern still gates it underneath.
//
// MEASURED before this fix: findingId and supersedes both declared
// minLength: 12, maxLength: 20 -- a caller reading only those two numbers
// would believe a 12- or 20-character id is acceptable; neither is, because
// the pattern accepts only exactly 15.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Per the standing trap (state modules decide their root at first require):
// a scratch state root BEFORE the first src/lib require.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-save-schema-'));
process.env.TOOLSENABLED_STATE_ROOT = path.join(SCRATCH, 'state');
fs.mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true });

const { getTool } = require('../src/lib/tool-registry');
const { validate } = require('../src/lib/schema-validator');

const REAL_FINDING_ID = 'F-2026-0903-001';
const BASE_INPUT = Object.freeze({ actor: 'human', projectId: 'rp-1234abcd', claim: 'A claim.' });

function findingSaveSchema() {
  const tool = getTool('research.finding_save');
  assert.ok(tool, 'research.finding_save must be registered');
  return tool.inputSchema;
}

test('research.finding_save: findingId/supersedes declared bounds equal the one length their own pattern admits', () => {
  const schema = findingSaveSchema();
  for (const field of ['findingId', 'supersedes']) {
    const prop = schema.properties[field];
    assert.ok(prop, `${field} must be declared`);
    assert.match(REAL_FINDING_ID, new RegExp(prop.pattern), `${field}'s pattern must accept a real generated finding id`);
    assert.equal(prop.minLength, REAL_FINDING_ID.length,
      `${field}.minLength must equal the fixed length the pattern admits (${REAL_FINDING_ID.length}), not a wider range`);
    assert.equal(prop.maxLength, REAL_FINDING_ID.length,
      `${field}.maxLength must equal the fixed length the pattern admits (${REAL_FINDING_ID.length}), not a wider range`);
  }
});

test('research.finding_save: a real generated findingId (update) and supersedes value still validate cleanly', () => {
  const schema = findingSaveSchema();
  assert.deepEqual(validate(schema, { ...BASE_INPUT, findingId: REAL_FINDING_ID }), []);
  assert.deepEqual(validate(schema, { ...BASE_INPUT, supersedes: REAL_FINDING_ID }), []);
});

test('research.finding_save: omitting findingId (create) still validates, matching "omit to create"', () => {
  const schema = findingSaveSchema();
  assert.deepEqual(validate(schema, { ...BASE_INPUT }), []);
});

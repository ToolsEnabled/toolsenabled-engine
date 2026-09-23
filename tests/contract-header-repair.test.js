'use strict';
/* A MECHANICAL FAULT THE READER CAN FIX IS NOT WORTH A ROUND TRIP.
 *
 * MEASURED 2026-09-03 on the owner's ledger: the single commonest agent.spawn
 * refusal was one sentence listing FIVE faults --
 *
 *   "no CONTRACT/1 header; missing required field: role; missing required
 *    field: target; missing required field: do; missing required field:
 *    because"
 *
 * -- of which four were false. Every field was present; the parse returned
 * before it read any of them. The managing agent then had to notice, rewrite
 * and re-send through a queue measured at a median of 17 s per errand, for a
 * missing line the reader could supply itself.
 *
 * THE HALF THAT MATTERS MORE is that nothing else is forgiven. The repair
 * restores the FIELDS; validate() still judges them, unchanged. Most of this
 * file is spent proving that a headerless contract is held to exactly the same
 * gates as one that arrived correctly, and that prose is never mistaken for a
 * contract at all.
 *
 *   node --test tests/contract-header-repair.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const contract = require('../tools/agent-contract.js');

const GOOD_BODY = [
  'role Worker',
  'target src/lib/example.js',
  'do stop the probe throwing when no backend is configured',
  'because 21 of 21 calls failed with MODEL_NO_GPU_PEER_CONFIGURED',
  'done tests/local-tiers-absence.test.js passes and the ledger stops recording it',
  'report say which codes are answered and which still throw',
].join('\n');

test('a contract WITH its header is unaffected, and reports no repair', () => {
  const parsed = contract.parse(`CONTRACT/1\n${GOOD_BODY}`);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.fields.role, 'WORKER');
  assert.equal(parsed.repaired, undefined, 'nothing was assumed, so nothing is claimed');
});

test('a contract missing ONLY its header is repaired, and says so', () => {
  const parsed = contract.parse(GOOD_BODY);
  assert.deepEqual(parsed.errors, [], 'the four false "missing field" errors are gone');
  assert.equal(parsed.fields.role, 'WORKER');
  assert.equal(parsed.fields.target, 'src/lib/example.js');
  assert.ok(Array.isArray(parsed.repaired) && parsed.repaired.length === 1,
    'the assumption is reported, never silent');
  assert.match(parsed.repaired[0], /header was missing and was assumed/);
});

/* ---- WHAT THE REPAIR MUST NOT DO -------------------------------------- */

test('prose is never read as a contract', () => {
  for (const text of [
    'please go and fix the login page\nit is broken',
    'Read the file and tell me what is wrong',
    '',
    'CONTRACT/2\nrole Worker',
  ]) {
    const parsed = contract.parse(text);
    assert.deepEqual(parsed.errors, ['no CONTRACT/1 header'], JSON.stringify(text.slice(0, 40)));
    assert.equal(Object.keys(parsed.fields).length, 0);
  }
});

test('a headerless contract missing any required field stays refused', () => {
  /* The repair is accepted only on proof that the whole contract is there.
     A partial one is exactly the case where guessing would be wrong. */
  for (const missing of contract.REQUIRED) {
    const body = GOOD_BODY.split('\n').filter(line => !line.startsWith(`${missing} `)).join('\n');
    const parsed = contract.parse(body);
    assert.deepEqual(parsed.errors, ['no CONTRACT/1 header'], `without ${missing}`);
  }
});

test('a headerless body with an unparseable line stays refused', () => {
  const parsed = contract.parse(`Some stray sentence up front.\n${GOOD_BODY}`);
  assert.deepEqual(parsed.errors, ['no CONTRACT/1 header'],
    'a body that did not read cleanly is not proof of anything');
});

/* ---- EVERY SEMANTIC GATE STILL RUNS ON A REPAIRED CONTRACT ------------- */

function validateHeaderless(replace) {
  const body = GOOD_BODY.split('\n').map(replace).join('\n');
  const parsed = contract.parse(body);
  assert.deepEqual(parsed.errors, [], 'this case is about validate(), so the parse must succeed');
  return contract.validate(parsed.fields);
}

test('an unknown role is still refused after a repair', () => {
  const errors = validateHeaderless(l => (l.startsWith('role ') ? 'role Wizard' : l));
  assert.ok(errors.some(e => /role must be one of/.test(e)), JSON.stringify(errors));
});

test('a "because" with no measurement is still refused after a repair', () => {
  const errors = validateHeaderless(l => (l.startsWith('because ') ? 'because it feels wrong' : l));
  assert.ok(errors.some(e => /states no measurement/.test(e)), JSON.stringify(errors));
});

test('an uncheckable "done" is still refused after a repair', () => {
  const errors = validateHeaderless(l => (l.startsWith('done ') ? 'done when it is properly cleaned up' : l));
  assert.ok(errors.some(e => /checkable/.test(e)), JSON.stringify(errors));
});

test('a repaired contract that is otherwise correct passes validate cleanly', () => {
  /* The point of the repair: the SAME text now reaches the same verdict it
     would have reached with the header typed in. */
  const withHeader = contract.validate(contract.parse(`CONTRACT/1\n${GOOD_BODY}`).fields);
  const without = contract.validate(contract.parse(GOOD_BODY).fields);
  assert.deepEqual(without, withHeader);
  assert.deepEqual(without, []);
});

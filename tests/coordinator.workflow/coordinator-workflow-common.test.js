/* Mutation check:
 * Replaced `return Buffer.byteLength(text, 'utf8');` with `return text.length;`
 * in src/lib/coordinator-workflow/common.js.
 * The edit landed, and this test file went red (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const common = require('../../src/lib/coordinator-workflow/common');

const {
  CHARS_PER_TOKEN,
  IDENTIFIER,
  CoordinatorWorkflowError,
  canonicalJson,
  clone,
  compareText,
  estimateTokens,
  exactKeys,
  fail,
  hashCanonical,
  identifier,
  integer,
  isoTime,
  pathKey,
  plainObject,
  safePath,
  safeText,
  sha256,
  unique
} = common;

function expectWorkflowError(action, code, field) {
  assert.throws(action, error => {
    assert.ok(error instanceof CoordinatorWorkflowError);
    assert.equal(error.code, code);
    assert.equal(error.details.field, field);
    return true;
  });
}

assert.equal(CHARS_PER_TOKEN, 1);
assert.equal(IDENTIFIER.test('mission.run:001'), true);
assert.equal(IDENTIFIER.test('no'), false);

const source = { zebra: 2, alpha: { y: true, x: null } };
assert.equal(canonicalJson(source), '{"alpha":{"x":null,"y":true},"zebra":2}');
assert.equal(
  hashCanonical(source),
  crypto.createHash('sha256').update(canonicalJson(source), 'utf8').digest('hex')
);
assert.equal(estimateTokens('A😀'), 5, 'token estimate is the pessimistic UTF-8 byte count');
assert.equal(estimateTokens({ b: 1, a: 2 }), Buffer.byteLength('{"a":2,"b":1}', 'utf8'));

const copy = clone(source);
assert.deepEqual(copy, { alpha: { x: null, y: true }, zebra: 2 });
copy.alpha.y = false;
assert.equal(source.alpha.y, true, 'clone does not alias nested source values');

assert.equal(compareText('alpha', 'beta'), -1);
assert.equal(compareText('same', 'same'), 0);
assert.equal(compareText('zeta', 'beta'), 1);
assert.equal(identifier('mission.run:001', 'missionId'), 'mission.run:001');
assert.equal(integer(4, 'attempts', { min: 1, max: 5 }), 4);
assert.equal(isoTime('2026-08-27T12:34:56.789Z', 'createdAt'), '2026-08-27T12:34:56.789Z');
assert.equal(safePath('artifacts/run-1/result.json', 'artifactPath'), 'artifacts/run-1/result.json');
assert.equal(pathKey('Artifacts/RESULT.json'), 'artifacts/result.json');
assert.equal(safeText('review complete', 'summary', { max: 20 }), 'review complete');
const digest = 'a'.repeat(64);
assert.equal(sha256(digest, 'artifactHash'), digest);
assert.deepEqual(unique(['worker-a', 'worker-b'], 'workers'), ['worker-a', 'worker-b']);

const nullPrototype = Object.create(null);
nullPrototype.answer = 42;
const snapshot = plainObject(nullPrototype, 'payload');
assert.equal(Object.getPrototypeOf(snapshot), null);
assert.equal(snapshot.answer, 42);
exactKeys(snapshot, ['answer'], 'payload');

expectWorkflowError(() => identifier('no', 'missionId'), 'COORDINATOR_WORKFLOW_INVALID_ARGUMENT', 'missionId');
expectWorkflowError(() => integer(1.5, 'attempts'), 'COORDINATOR_WORKFLOW_INVALID_ARGUMENT', 'attempts');
expectWorkflowError(() => isoTime('2026-02-30T00:00:00Z', 'createdAt'), 'COORDINATOR_WORKFLOW_INVALID_ARGUMENT', 'createdAt');
expectWorkflowError(() => safePath('../secret', 'artifactPath'), 'COORDINATOR_WORKFLOW_PATH_INVALID', 'artifactPath');
expectWorkflowError(() => safeText('token=abcdefghijklmnop', 'summary'), 'COORDINATOR_WORKFLOW_SENSITIVE_CONTENT', 'summary');
expectWorkflowError(() => sha256('ABC', 'artifactHash'), 'COORDINATOR_WORKFLOW_HASH_INVALID', 'artifactHash');
expectWorkflowError(() => unique(['worker-a', 'worker-a'], 'workers'), 'COORDINATOR_WORKFLOW_DUPLICATE', 'workers');
expectWorkflowError(() => exactKeys({ answer: 42, extra: true }, ['answer'], 'payload'), 'COORDINATOR_WORKFLOW_UNKNOWN_KEY', 'payload');
expectWorkflowError(() => plainObject([], 'payload'), 'COORDINATOR_WORKFLOW_INVALID_ARGUMENT', 'payload');
expectWorkflowError(() => canonicalJson(-0), 'COORDINATOR_WORKFLOW_CANONICAL_INVALID', 'value');

assert.throws(
  () => fail('COORDINATOR_WORKFLOW_TEST_FAILURE', 'deliberate failure', { field: 'fixture' }),
  error => error instanceof CoordinatorWorkflowError &&
    error.name === 'CoordinatorWorkflowError' &&
    error.code === 'COORDINATOR_WORKFLOW_TEST_FAILURE' &&
    error.message === 'deliberate failure' &&
    error.details.field === 'fixture'
);

console.log('ok - coordinator-workflow common exports preserve canonicalization and validation behaviour');

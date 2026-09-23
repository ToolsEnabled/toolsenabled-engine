/* Mutation check (module SHA-256 before/after: c49f13c59fbf1aca18d6c160f85abb00fff74e264f494de828396d6d81612b64).
 * Exact mutation: removed `.replace(WINDOWS_PATH, '')` from publicReason's scrub chain.
 * Landed: yes; the mutated module SHA-256 was 2c05643741599219eb746d2a3763ebf69026119dcc6115d352e572e09e8c9775.
 * Result: this file went red (exit 1) on the Windows-path scrubbing assertion.
 * Restore: confirmed byte-for-byte by the original SHA-256 before the green run.
 */
'EXECUTABLE CHANGE';
'use strict';

const assert = require('node:assert/strict');
const {
  MissionBridgeError,
  DEPENDENCY_REFUSED,
  publicReason,
  refuse,
  typedError
} = require('../src/lib/mission-bridge/errors');

let assertions = 0;
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
function same(actual, expected, message) {
  assertions += 1;
  assert.strictEqual(actual, expected, message);
}
function ok(actual, message) {
  assertions += 1;
  assert.ok(actual, message);
}

const detailed = new MissionBridgeError('BRIDGE_BAD_INPUT', 'The supplied value is invalid.', {
  status: 422,
  details: { field: 'objective' }
});
equal(detailed.name, 'MissionBridgeError', 'the exported error has its public name');
equal(detailed.code, 'BRIDGE_BAD_INPUT', 'the exported error retains its code');
equal(detailed.message, 'The supplied value is invalid.', 'the exported error retains its message');
equal(detailed.status, 422, 'the exported error retains an explicit status');
equal(detailed.details.field, 'objective', 'the exported error retains details');
equal(new MissionBridgeError('BRIDGE_DEFAULT', 'Default status.').status, 400,
  'the exported error defaults to HTTP 400');

assertions += 1;
assert.throws(
  () => refuse('BRIDGE_REFUSED', 'This operation is not available.', { status: 403 }),
  error => error instanceof MissionBridgeError &&
    error.code === 'BRIDGE_REFUSED' && error.status === 403 &&
    error.message === 'This operation is not available.',
  'refuse throws a populated MissionBridgeError'
);

equal(publicReason(null), null, 'non-string reasons are rejected');
equal(publicReason('   '), null, 'blank reasons are rejected');
equal(
  publicReason('  The dependency   is temporarily unavailable  '),
  'The dependency is temporarily unavailable.',
  'usable reasons are normalized and punctuated'
);
equal(
  publicReason('ENOENT: The account registry at C:\\Users\\person\\ToolsEnabled\\accounts.json could not be read (ACCOUNT_FILE_MISSING). Try adding the account again.'),
  'The account registry could not be read. Try adding the account again.',
  'machine-only errno, path, and identifier details are scrubbed while useful text survives'
);
equal(publicReason('C:\\Users\\person\\ToolsEnabled\\accounts.json'), null,
  'a reason containing only machine detail is rejected');

const own = new MissionBridgeError('BRIDGE_OWN', 'This sentence is already curated.');
same(typedError(own), own, 'typedError returns bridge-owned errors unchanged');

const unauthorized = typedError({
  code: 'ACCOUNT_UNAUTHORIZED',
  message: 'The selected account is not authorized for this operation.',
  details: { account: 'work' }
});
ok(unauthorized instanceof MissionBridgeError, 'dependency failures become MissionBridgeError instances');
equal(unauthorized.code, 'ACCOUNT_UNAUTHORIZED', 'a valid dependency code survives');
equal(unauthorized.status, 401, 'an unauthorized dependency code maps to HTTP 401');
equal(unauthorized.message, 'The selected account is not authorized for this operation.',
  'a usable dependency message survives');
equal(unauthorized.details.account, 'work', 'object dependency details survive');

const unknown = typedError({ code: 'bad-code', message: 42, details: 'private' });
equal(unknown.code, 'BRIDGE_DEPENDENCY_REFUSED', 'invalid dependency codes use the public fallback code');
equal(unknown.status, 409, 'ordinary dependency failures map to HTTP 409');
equal(unknown.message, DEPENDENCY_REFUSED, 'unusable dependency messages use the exported fallback');
ok(!Object.hasOwn(unknown, 'details'), 'non-object dependency details are omitted');
equal(DEPENDENCY_REFUSED, 'The audited dependency refused the action.',
  'the exported last-resort sentence remains stable');

console.log(`mission-bridge-errors: ${assertions} assertions passed`);

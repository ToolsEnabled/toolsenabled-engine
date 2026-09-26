/* Mutation check (2026-08-27):
 * In src/lib/env-scrub.js, changed `return String(name).toLowerCase();`
 * to `return String(name);`, disabling case-insensitive environment-name matching.
 * The edit landed, and this test file went red (exit 1).
 */
'use strict';

const assert = require('node:assert/strict');
const {
  deleteEnvMatching,
  deleteEnvNames,
  envValues,
  hasEnvName,
  presentEnvNames
} = require('../src/lib/env-scrub.js');

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('deleteEnvNames removes every casing, preserves unrelated values, and returns its input', () => {
  const env = {
    API_KEY: 'upper-secret',
    api_key: 'lower-secret',
    SAFE_VALUE: 'keep-me'
  };

  assert.equal(deleteEnvNames(env, ['Api_Key']), env);
  assert.deepEqual(env, { SAFE_VALUE: 'keep-me' });
});

test('deleteEnvMatching removes only names selected by the predicate', () => {
  const env = { SESSION_TOKEN: 'secret', SAFE_TOKEN_COUNT: '2', REGION: 'west' };

  assert.equal(deleteEnvMatching(env, (name) => name.endsWith('_TOKEN')), env);
  assert.deepEqual(env, { SAFE_TOKEN_COUNT: '2', REGION: 'west' });
});

test('presentEnvNames reports requested canonical spellings once and ignores undefined values', () => {
  const env = { service_token: 'secret', SERVICE_URL: undefined, UNRELATED: 'value' };

  assert.deepEqual(
    presentEnvNames(env, ['SERVICE_TOKEN', 'SERVICE_URL', 'MISSING']),
    ['SERVICE_TOKEN']
  );
});

test('hasEnvName detects names without regard to casing', () => {
  assert.equal(hasEnvName({ Mixed_Case_Name: 'value' }, ['MIXED_CASE_NAME']), true);
  assert.equal(hasEnvName({ OTHER_NAME: 'value' }, ['MIXED_CASE_NAME']), false);
});

test('envValues returns non-empty string values from every matching casing', () => {
  const env = {
    ACCESS_KEY: 'first-secret',
    access_key: 'second-secret',
    Access_Key_Empty: '',
    ACCESS_KEY_NUMBER: 42
  };

  assert.deepEqual(
    envValues(env, ['access_key', 'ACCESS_KEY_EMPTY', 'access_key_number']),
    ['first-secret', 'second-secret']
  );
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}

if (failures > 0) {
  process.stderr.write(`${failures} env-scrub test(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`all ${tests.length} env-scrub tests passed\n`);
}

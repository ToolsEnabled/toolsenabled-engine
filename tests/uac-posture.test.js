/* Mutation check (2026-08-27):
 * In src/lib/uac-posture.js, changed `if (admin === 0)` to `if (admin === -1)`.
 * The edit landed (the replacement was found exactly once and verified in place).
 * This isolated test file went red with exit code 1 on that mutation.
 * The module was restored and its original SHA-256 was confirmed afterward.
 */

'use strict';

// Behavioural coverage for the public UAC-posture API. All machine-dependent
// readers are replaced with values so this file runs on every platform.

const assert = require('node:assert/strict');
const {
  readPosture,
  describeForOperation,
  frequencyLabel,
  parseRegQuery,
  parseTokenGroups,
} = require('../src/lib/uac-posture');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error.stack);
  }
}

test('registry and token output are parsed without consulting this machine', () => {
  assert.equal(parseRegQuery('    EnableLUA    REG_DWORD    0x1\r\n', 'EnableLUA'), 1);
  assert.equal(parseRegQuery('EnableLUA REG_SZ 1', 'EnableLUA'), null);

  const filtered = parseTokenGroups([
    '"Group Name","Type","SID","Attributes"',
    '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"',
  ].join('\r\n'));
  assert.deepEqual(filtered, { administrator: true, tokenFiltered: true });
  assert.deepEqual(parseTokenGroups('unexpected diagnostic'), {
    administrator: null,
    tokenFiltered: null,
  });
});

test('readPosture derives a readable Windows posture from injected readers', () => {
  const registry = {
    EnableLUA: 1,
    ConsentPromptBehaviorAdmin: 0,
    ConsentPromptBehaviorUser: 3,
    PromptOnSecureDesktop: 1,
    FilterAdministratorToken: 0,
  };
  const posture = readPosture({
    platform: 'win32',
    readRegistryValue: (name) => registry[name],
    readTokenGroups: () => '"BUILTIN\\\\Administrators","Alias","S-1-5-32-544","Enabled group"',
  });

  assert.equal(posture.readable, true);
  assert.equal(posture.uacEnabled, true);
  assert.deepEqual(posture.account, { administrator: true, tokenFiltered: false });
  assert.equal(posture.values.consentPromptBehaviorAdmin, 0);
  assert.deepEqual(posture.unreadable, []);
  assert.equal(Object.isFrozen(posture), true);
});

test('an administrator configured to elevate without prompting gets a silent answer', () => {
  const answer = describeForOperation({
    windows: true,
    readable: true,
    uacEnabled: true,
    account: { administrator: true, tokenFiltered: true },
    values: { consentPromptBehaviorAdmin: 0 },
  }, 'elevation-request');

  assert.equal(answer.outcome, 'silent');
  assert.equal(answer.tier, 1);
  assert.match(answer.sentence, /without asking you anything/);
  assert.equal(Object.isFrozen(answer), true);

  assert.deepEqual(frequencyLabel('sometimes', answer), {
    tier: 1,
    source: 'measured',
    label: 'On your computer: runs without asking you.',
    detail: answer.sentence,
    declared: 'sometimes',
  });
});

test('unknown operation needs are rejected instead of guessed', () => {
  assert.throws(
    () => describeForOperation({}, 'registry-mutation'),
    { name: 'TypeError', message: 'unknown operation need: registry-mutation' },
  );
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\n4 tests passed');
}

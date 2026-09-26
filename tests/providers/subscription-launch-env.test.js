/* Mutation check (2026-08-27):
 * Changed `for (const providerId of PROVIDER_IDS) {` to
 * `for (const providerId of []) {` in subscription-launch-env.js.
 * The edit landed: yes.
 * This isolated test went red: yes (exit 1).
 */
'use strict';

const assert = require('node:assert/strict');
const {
  BILLING_TRIPWIRE,
  LaunchEnvironmentError,
  assertNoBillingCredentials,
  safeLaunchEnvironment,
  subscriptionLaunchEnvironment
} = require('../../src/lib/providers/subscription-launch-env.js');

const SECRET = 'synthetic-secret-that-must-not-appear';
let assertions = 0;

function test(name, run) {
  try {
    run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n`);
    throw error;
  }
}

function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}

function deepEqual(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function throws(run, validate, message) {
  assertions += 1;
  assert.throws(run, validate, message);
}

test('subscriptionLaunchEnvironment removes billing credentials without mutating or over-scrubbing', () => {
  const input = {
    PATH: '/bin',
    KEEP_ME: 'preserved',
    ANTHROPIC_API_KEY: SECRET,
    openai_api_key: SECRET,
    GEMINI_API_KEY: SECRET
  };

  const result = subscriptionLaunchEnvironment(input);

  deepEqual(result, { PATH: '/bin', KEEP_ME: 'preserved' });
  equal(input.ANTHROPIC_API_KEY, SECRET, 'the caller-owned input must not be mutated');
  equal(input.openai_api_key, SECRET, 'case-insensitive removal must not mutate the input');
  equal(result === input, false, 'the scrub must return a new environment object');
});

test('subscriptionLaunchEnvironment rejects values that cannot describe an environment', () => {
  for (const invalid of [null, false, 'PATH=/bin', 42]) {
    throws(
      () => subscriptionLaunchEnvironment(invalid),
      error => error instanceof LaunchEnvironmentError &&
        error.name === 'LaunchEnvironmentError' &&
        error.code === 'LAUNCH_ENVIRONMENT_INVALID' &&
        error.message === 'A subscription CLI launch environment could not be constructed.' &&
        Object.keys(error.details).length === 0,
      `expected ${String(invalid)} to be rejected with the documented typed error`
    );
  }
});

test('assertNoBillingCredentials returns a clean object unchanged', () => {
  const clean = { PATH: '/bin', HOME: '/home/test' };
  equal(assertNoBillingCredentials(clean), clean);
});

test('assertNoBillingCredentials refuses inherited ambient environments', () => {
  for (const invalid of [null, undefined]) {
    throws(
      () => assertNoBillingCredentials(invalid, { context: 'unit launch' }),
      error => error instanceof LaunchEnvironmentError &&
        error.code === 'LAUNCH_ENVIRONMENT_INHERITS_AMBIENT' &&
        error.message.includes('(unit launch)') &&
        error.message.includes(String(invalid)) &&
        deepDetails(error.details, []),
      `expected ${String(invalid)} to be refused rather than inherit process.env`
    );
  }
});

test('assertNoBillingCredentials names every leak canonically without exposing its value', () => {
  throws(
    () => assertNoBillingCredentials({ anthropic_api_key: SECRET, OPENAI_API_KEY: SECRET }, { context: 'account A' }),
    error => error instanceof LaunchEnvironmentError &&
      error.code === 'LAUNCH_BILLING_CREDENTIAL_PRESENT' &&
      error.message.includes('(account A)') &&
      error.message.includes('ANTHROPIC_API_KEY, OPENAI_API_KEY') &&
      !error.message.includes(SECRET) &&
      deepDetails(error.details, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']),
    'a leaked credential must cause a value-safe, contextual refusal'
  );
});

function deepDetails(details, variables) {
  try {
    assert.deepEqual(details, { variables });
    return true;
  } catch {
    return false;
  }
}

test('safeLaunchEnvironment composes the scrub and tripwire', () => {
  const result = safeLaunchEnvironment({ PATH: '/custom/bin', CODEX_ACCESS_TOKEN: SECRET, SAFE: 'yes' });
  deepEqual(result, { PATH: '/custom/bin', SAFE: 'yes' });
});

test('the exported tripwire is a frozen list containing representative provider credentials and redirects', () => {
  equal(Object.isFrozen(BILLING_TRIPWIRE), true);
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'GEMINI_API_KEY']) {
    equal(BILLING_TRIPWIRE.includes(name), true, `${name} must remain protected by the exported tripwire`);
  }
});

assert.equal(assertions, 20, 'every intended behavioural assertion must execute');
process.stdout.write(`subscription-launch-env: ${assertions} assertions passed\n`);

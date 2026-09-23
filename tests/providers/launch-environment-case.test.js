// EXECUTABLE CHANGE — assertion-discrimination audit, 2026-08-26.
'use strict';

/*
 * CAN A CHILD PROCESS STILL READ A CREDENTIAL WE THINK WE REMOVED?
 *
 * Every scrub in this codebase was written as `delete environment.NAME`. That
 * looks like it removes the variable. On Windows it removes one SPELLING of it.
 *
 * Windows environment variables are case-INSENSITIVE and `process.env` honours
 * that, but `{ ...process.env }` is a plain object whose property access is
 * case-SENSITIVE. So an exact-case delete leaves every other casing sitting in
 * the object, and the child -- whose OS lookup is case-insensitive -- reads the
 * survivor. Measured before the fix, through subscription-launch-env.js into a
 * REAL spawned child:
 *
 *     set as ANTHROPIC_API_KEY  -> child sees it: ABSENT
 *     set as anthropic_api_key  -> child sees it: PRESENT
 *     set as Anthropic_Api_Key  -> child sees it: PRESENT
 *
 * Two of three casings bypassed the AUTHORITATIVE scrub completely, and
 * `setx anthropic_api_key ...` is an entirely ordinary thing for a user or an
 * installer to do. The owner already has ANTHROPIC_API_KEY persisted in
 * HKCU:\Environment. A lowercase sibling would sail through every guard we
 * have and reproduce the R1186 outage -- hours billed to a drained API account
 * while reporting logged in -- with the guard in place and reporting success.
 *
 * WHY THIS SPAWNS A REAL CHILD. Asserting on the returned object catches only
 * half of what makes this dangerous. The object is not the authority; the OS
 * is. A test that checks `env.anthropic_api_key === undefined` and stops has
 * verified our bookkeeping, not the thing we actually care about, which is
 * whether the process we start can read the key. So every case below asks a
 * real child what it actually sees.
 *
 * THE MIXED CASE IS NOT DECORATION. A fix that lowercases only the needle, or
 * that special-cases the all-lowercase spelling, passes a lowercase-only test
 * and still leaks `Anthropic_Api_Key`. Both forms are required here for that
 * reason.
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  safeLaunchEnvironment,
  assertNoBillingCredentials,
  subscriptionLaunchEnvironment,
  LaunchEnvironmentError,
  BILLING_TRIPWIRE
} = require('../../src/lib/providers/subscription-launch-env.js');

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

// A value that would be actively harmful if inherited, so a pass means the
// variable was REMOVED rather than merely absent on the machine running this.
// Never printed: assertions below report names and booleans only.
const SENTINEL = 'sentinel-would-bill-a-metered-account';

const CASINGS = [
  ['ANTHROPIC_API_KEY', 'the canonical spelling -- the only one the old scrub removed'],
  ['anthropic_api_key', 'all lowercase, exactly what `setx anthropic_api_key ...` leaves behind'],
  ['Anthropic_Api_Key', 'mixed case -- survives any fix that only special-cases the lowercase form']
];

/* What the OS actually gives a child, which is the only answer that matters.
 * Returns a string rather than the value itself so a failure can never print a
 * credential. */
function childSees(environment, variableName) {
  const result = spawnSync(
    process.execPath,
    ['-e', `console.log(process.env[${JSON.stringify(variableName)}] === undefined ? 'ABSENT' : 'PRESENT')`],
    { env: environment, encoding: 'utf8' }
  );
  assert.equal(result.status, 0,
    'the probe child failed to run, so this test proved nothing about what a child can see');
  return String(result.stdout || '').trim();
}

function withOnly(casing, run) {
  const saved = new Map();
  for (const [name] of CASINGS) {
    saved.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
    delete process.env[name];
  }
  process.env[casing] = SENTINEL;
  try {
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/* ---------- no casing reaches a real child ---------- */

for (const [casing, why] of CASINGS) {
  withOnly(casing, () => {
    // Prove the fixture really set it. Without this, "the child cannot see it"
    // is satisfied by a machine where it was never there.
    check(process.env[casing] === SENTINEL,
      `the fixture failed to set ${casing}, so every assertion below would prove nothing`);
    // Prove the control according to the host's actual environment semantics:
    // Windows must resolve every spelling through the canonical name, while a
    // case-sensitive host must expose the spelling that was actually set. The
    // scrub below remains deliberately case-insensitive on every platform.
    const controlName = process.platform === 'win32' ? 'ANTHROPIC_API_KEY' : casing;
    check(childSees({ ...process.env }, controlName) === 'PRESENT',
      `${casing} was not readable by an unscrubbed child as ${controlName}, so the fixture did not establish its control`);

    const launched = safeLaunchEnvironment(process.env, { context: 'case test' });

    // The object, and then the thing that actually decides.
    const survivors = Object.keys(launched).filter(key => key.toLowerCase() === 'anthropic_api_key');
    check(survivors.length === 0,
      `${casing} survived safeLaunchEnvironment() as ${survivors.join(', ')} -- ${why}`);
    check(childSees(launched, casing) === 'ABSENT',
      `a REAL child could still read the credential set as ${casing} -- ${why}`);
    check(childSees(launched, 'ANTHROPIC_API_KEY') === 'ABSENT',
      `a REAL child could still read the credential under its canonical name after it was set as ${casing} -- this is the bypass in its most dangerous form, because the scrub reported success`);
  });
}

/* ---------- the tripwire can SEE a mis-cased survivor ---------- */

// The detection half of the same defect. A tripwire that looks for the exact
// spelling cannot see the survivor that bypassed the scrub, so it reports
// all-clear on precisely the environment that leaks -- certifying the leak.
for (const [casing] of CASINGS) {
  assert.throws(
    () => assertNoBillingCredentials({ PATH: 'x', [casing]: SENTINEL }, { context: 'case test' }),
    (error) => {
      assert.ok(error instanceof LaunchEnvironmentError,
        `assertNoBillingCredentials did not raise a LaunchEnvironmentError for ${casing}`);
      assert.equal(error.code, 'LAUNCH_BILLING_CREDENTIAL_PRESENT',
        `the refusal for ${casing} carried the wrong code`);
      // Reported under the CANONICAL name, so a reader is not left to work out
      // that a lowercase spelling is the same variable.
      assert.ok(error.message.includes('ANTHROPIC_API_KEY'),
        `the refusal for ${casing} did not name the credential canonically`);
      assert.equal(error.message.includes(SENTINEL), false,
        `the refusal for ${casing} printed the credential VALUE, which is the one thing it must never do`);
      return true;
    },
    `assertNoBillingCredentials did NOT refuse an environment containing ${casing}: a tripwire blind to the casing that bypasses the scrub is worse than none, because it certifies the leak`
  );
  checks += 1;
}

/* ---------- the scrub still takes away nothing else ---------- */

// A scrub that removes a capability is a different bug, not a safer one. The
// case-insensitive match must not become a prefix or substring match.
{
  const kept = {
    PATH: 'C:/keep',
    APPDATA: 'C:/appdata',
    CODEX_HOME: 'C:/the-users-own-home',
    // Deliberately adjacent to real tripwire names without being them.
    ANTHROPIC_API_KEY_BACKUP: 'not-a-credential-we-name',
    MY_OPENAI_API_KEY: 'not-a-credential-we-name',
    anthropic_api_key_note: 'not-a-credential-we-name'
  };
  const launched = subscriptionLaunchEnvironment({ ...kept, anthropic_api_key: SENTINEL });
  for (const [name, value] of Object.entries(kept)) {
    check(launched[name] === value,
      `${name} was removed by the scrub: matching must be on the WHOLE name, case-insensitively, not by prefix or substring`);
  }
  check(Object.keys(launched).some(key => key.toLowerCase() === 'anthropic_api_key' && key !== 'anthropic_api_key_note') === false,
    'the mis-cased credential survived alongside the look-alike names');
}

/* ---------- the tripwire list is a named list, not a pattern ---------- */

{
  check(Array.isArray(BILLING_TRIPWIRE) && BILLING_TRIPWIRE.length > 0,
    'BILLING_TRIPWIRE is empty, so every assertion in this file would pass vacuously');
  const clean = safeLaunchEnvironment({ PATH: 'C:/keep', HOME: 'C:/home' }, { context: 'case test' });
  check(clean.PATH === 'C:/keep' && clean.HOME === 'C:/home',
    'an environment with no credentials in it was altered, so the scrub is filtering rather than removing named variables');
}

// Do not let either table-driven section become vacuous. This is deliberately
// a literal rather than a value derived from CASINGS or kept: computing the
// expected count from the same collections would preserve the empty-loop bug.
assert.equal(checks, 27,
  'the test did not execute every case-sensitive scrub and preservation check');

/*
 * MUTATION EVIDENCE
 * - Strengthened assertion above: temporarily changed `const CASINGS = [...]`
 *   to `const CASINGS = []`. Before this count assertion the file stayed green
 *   with `launch-environment-case: 9 checks passed on linux`. With it, the
 *   same mutation went RED:
 *     AssertionError [ERR_ASSERTION]: the test did not execute every
 *     case-sensitive scrub and preservation check
 *     9 !== 27
 * - Restored CASINGS byte-for-byte. `node
 *   tests/providers/launch-environment-case.test.js` is green again:
 *     launch-environment-case: 27 checks passed on linux
 *
 * SIX-SHAPE CENSUS
 * 1 EMPTY LOOP: FOUND and fixed for both CASINGS loops with the independent
 *   total above; the fixed-literal `kept` loop contributes to the same total.
 * 2 EXIT/TRUTHY WITHOUT SUBJECT OUTPUT: NOT-FOUND. childSees first requires a
 *   zero exit and callers then require the probe's exact ABSENT/PRESENT output.
 * 3 SWALLOWED FAILURE: NOT-FOUND. The only try/finally restores process.env and
 *   does not catch a failure; there is no optional chaining.
 * 4 MOCK OF SUBJECT: NOT-FOUND. Every environment observation uses a real
 *   spawnSync child.
 * 5 SKIP/PRECONDITION NO-OP: NOT-FOUND. Platform selection changes only the
 *   control variable spelling and never skips a case or the file.
 * 6 EXPECTED FROM SAME CODE: NOT-FOUND. Expected spellings, probe output,
 *   error type/code, preserved values, and the new total are independent
 *   literals; the total is intentionally not calculated from a test table.
 *
 * PRECONDITIONS NOT MET: Windows was unavailable, so the restored green run
 * and mutation run exercised linux environment semantics only.
 */

console.log(`launch-environment-case: ${checks} checks passed on ${process.platform}`);

// EXECUTABLE CHANGE
// Assertion audit (testcanfail-tests-full-remote-access-release-enroll-js):
// - EMPTY-ITERATION: NOT-FOUND; this test contains no loop or forEach assertion.
// - EXIT-STATUS/TRUTHY-RETURN: NOT-FOUND; every check examines an in-process
//   value produced by main rather than treating a process status as evidence.
// - SWALLOWED-FAILURE: FOUND. Mutation `await enroll()` ->
//   `try { await enroll(); } catch {}` stayed green before the rejection-identity
//   check below. With that check it went RED with:
//   "AssertionError [ERR_ASSERTION]: Missing expected rejection."
// - SELF-MOCK: NOT-FOUND; the injected enrollment function is a collaborator,
//   while the subject remains the release entry point's orchestration.
// - SKIP/PRECONDITION: NOT-FOUND; this file has no platform guard or skip.
// - SAME-CODE EXPECTATION: NOT-FOUND; all expected values are test literals.
// Existing-assertion mutations also went RED: suppressing `enroll()` produced
// "actual: [], expected: [ 'enroll' ]"; changing output `ok` to false produced
// "ok: false" versus "ok: true"; returning instead of throwing for unexpected
// arguments produced "AssertionError [ERR_ASSERTION]: Missing expected rejection."
// The product file was restored byte-for-byte (SHA-256
// e6d9a98e7e99624b44efe56ca3ba9e1d0be1960ad134e49ce005f7c459cff4ca).
// Restored green run: "FRA-only enrollment entry point is decoupled from product promotion."
// Preconditions not met: NONE.
'use strict';

const assert = require('node:assert/strict');
const { main } = require('../tools/full-remote-access-release-enroll');

(async () => {
  const events = [];
  let output = '';
  await main([], {
    async runCredentialEnrollment() { events.push('enroll'); },
    writeOutput(value) { output += value; }
  });
  assert.deepEqual(events, ['enroll']);
  assert.deepEqual(JSON.parse(output), {
    ok: true,
    code: 'FRA_CONTROL_PLANE_ENROLLMENT_STARTING',
    secretValuesEmitted: false
  });

  const enrollmentFailure = new Error('sentinel enrollment failure');
  await assert.rejects(
    () => main([], {
      async runCredentialEnrollment() { throw enrollmentFailure; },
      writeOutput() {}
    }),
    error => error === enrollmentFailure
  );

  await assert.rejects(() => main(['--unexpected'], {}), error => error && error.code === 'FRA_RELEASE_ENROLL_ARGUMENTS_REFUSED');
  console.log('FRA-only enrollment entry point is decoupled from product promotion.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

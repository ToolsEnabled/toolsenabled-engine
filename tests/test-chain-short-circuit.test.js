'use strict';

// A TEST-RUNNING NPM SCRIPT MAY NOT JOIN ITS STEPS WITH A SHELL OPERATOR.
//
// WHY THIS EXISTS
// ---------------
// This repository has now found the same defect at three different altitudes,
// and each time the fix was applied to one instance rather than to the class:
//
//   1. tests/run-isolated.js stopped at the first failing suite. Measured
//      2026-08-10: 139 statically-wired suites sat behind a non-passing sibling
//      and were never executed by the battery that claims to run them. Fixed by
//      making continuation the default.
//   2. `pretest` was nine `&&`-joined steps. Measured 2026-08-08: step 2 was
//      failing in committed HEAD, so steps 3-9 -- including the credential
//      fence -- were not running. Fixed by tools/check-chain-runner.js.
//   3. `test` itself was still seven `&&`-joined segments. Segment 1 contains a
//      suite that hangs, so test:fra (30 files), test:coverage-audit (28),
//      test:invocation-orphans (25) and three more steps never ran. 84 test
//      files were neither passing nor failing; they were absent, and the output
//      did not say so.
//
// Fixing (3) leaves nothing stopping a fourth. `&&` is the natural thing to
// type, it looks like sequencing rather than like a policy decision, and the
// resulting hole is invisible: the run still exits non-zero, so it reads as
// "we have a failure" rather than "we did not measure 84 files".
//
// WHY ALL THREE OPERATORS, NOT JUST `&&`
// --------------------------------------
//   `&&`  later steps do not run; their state is unknown and unreported.
//   `;`   later steps DO run, but only the last step's exit code survives, so
//         an earlier failure is silently discarded. That is worse than `&&`:
//         it produces a green verdict over a red step.
//   `||`  the second step runs only if the first FAILED, and success of either
//         is reported as success. A test chain must never be an alternative.
//
// WHAT IS NOT AN OFFENCE
// ----------------------
// A script that does not execute tests may sequence with `&&` freely; that is
// ordinary shell. The rule is scoped to scripts that run tests, because those
// are the ones whose short-circuit converts unmeasured work into apparent work.
//
// THIS TEST PROVES ITS OWN DETECTOR (see SELF-CHECK below). A rule that only
// asserts "the current tree is clean" degrades into a test that cannot fail the
// moment somebody weakens the matcher, and this repository has been finding
// exactly that class of test by hand. So the file also feeds the detector the
// real pre-fix command string and requires it to be rejected.

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// A shell operator that joins two commands. Deliberately does not match `|`
// (a pipe is one command's output feeding another, not a concealed step) and
// does not match `&&` inside a quoted argument, because npm scripts here never
// quote one.
const JOINERS = [
  { token: '&&', why: 'later steps do not run at all, and nothing reports their absence' },
  { token: '||', why: 'the later step runs only when the earlier one FAILED, and either outcome reports success' },
  { token: ';', why: 'later steps run but only the last exit code survives, so an earlier failure is discarded' }
];

// Does this script execute tests? Three independent signals, because the repo
// spells it three ways: the isolated runner, a package directory runner, and a
// delegation to another test:* script.
function runsTests(command) {
  return command.includes('run-isolated')
    || /tests[\\/][\w.-]+[\\/]run\.js/.test(command)
    || /\bnpm run test:/.test(command)
    || /\btests[\\/][\w./\\-]+\.(?:js|cjs|mjs)\b/.test(command);
}

/**
 * Find test-running scripts whose steps are joined by a short-circuiting shell
 * operator. Pure over a scripts object so it can be exercised on synthetic
 * input -- that is what stops this file becoming a test that cannot fail.
 */
function findShortCircuitedTestChains(scripts) {
  const offences = [];
  for (const [name, command] of Object.entries(scripts || {})) {
    if (typeof command !== 'string') continue;
    if (!runsTests(command)) continue;
    for (const joiner of JOINERS) {
      // `;` appears inside no legitimate command here, but require whitespace
      // around `&&`/`||` so a filename containing them could not false-positive.
      const pattern = joiner.token === ';'
        ? /;/
        : new RegExp(`\\s\\${joiner.token[0]}\\${joiner.token[1]}\\s`);
      if (pattern.test(command)) {
        offences.push({ script: name, joiner: joiner.token, why: joiner.why });
      }
    }
  }
  return offences;
}

// ---------------------------------------------------------------------------
// SELF-CHECK: the detector must reject the string this rule was written for.
//
// This is the exact `npm test` command as it stood before commit 7fb15e9,
// abbreviated in the middle only. If a future edit loosens `runsTests` or the
// joiner patterns, this goes red BEFORE the real-tree assertion below can go
// quietly green.
// ---------------------------------------------------------------------------
const PRE_FIX_TEST_COMMAND = 'node tests/run-isolated.js tests/schema-validator.js tests/smoke.js'
  + ' && npm run test:fra && npm run test:coverage-audit && npm run test:idle-cpu';

const selfCheck = findShortCircuitedTestChains({ test: PRE_FIX_TEST_COMMAND });
assert.equal(selfCheck.length, 1, 'the detector must flag the real pre-fix npm test command');
assert.equal(selfCheck[0].joiner, '&&');

assert.equal(
  findShortCircuitedTestChains({ bad: 'node tests/a.js ; node tests/b.js' }).length, 1,
  'the detector must flag `;`, which discards every exit code but the last'
);
assert.equal(
  findShortCircuitedTestChains({ bad: 'node tests/a.js || node tests/b.js' }).length, 1,
  'the detector must flag `||`, which reports either outcome as success'
);

// A non-test script sequencing with && is ordinary shell and must NOT be
// flagged; without this the rule would be unusable and would get deleted.
assert.equal(
  findShortCircuitedTestChains({ build: 'node tools/reindex.js && node tools/check.js' }).length, 0,
  'a script that runs no tests may sequence freely'
);

// The aggregating form must pass, or the fix this rule protects would itself be
// an offence.
assert.equal(
  findShortCircuitedTestChains({
    test: 'node tools/check-chain-runner.js --name test --then node tests/run-isolated.js tests/a.js --then npm run test:fra'
  }).length, 0,
  'the check-chain-runner form is the sanctioned way to sequence test steps'
);

// ---------------------------------------------------------------------------
// THE REAL TREE
// ---------------------------------------------------------------------------
const scripts = require(path.join(ROOT, 'package.json')).scripts || {};
const offences = findShortCircuitedTestChains(scripts);

assert.deepEqual(
  offences.map(offence => `${offence.script}: joined with \`${offence.joiner}\` -- ${offence.why}`),
  [],
  'A test-running npm script must sequence its steps with tools/check-chain-runner.js '
  + '(--then), never with a shell operator. Every step then runs, the exit code is still '
  + 'non-zero if any step failed, and the summary names which steps failed.'
);

// Guard against the rule silently applying to nothing: if no script in this
// repository runs tests, `runsTests` has been broken rather than the tree made
// clean, and the assertion above would pass vacuously.
const testRunningScripts = Object.entries(scripts).filter(([, command]) =>
  typeof command === 'string' && runsTests(command));
assert.ok(
  testRunningScripts.length >= 10,
  `expected many test-running npm scripts, matched ${testRunningScripts.length} -- `
  + 'the detector has stopped recognising them, so a clean result proves nothing'
);

console.log(
  `test-chain short-circuit rule: ${testRunningScripts.length} test-running npm scripts checked, `
  + '0 joined by a shell operator.'
);

module.exports = { findShortCircuitedTestChains, runsTests };

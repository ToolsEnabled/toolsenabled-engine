'use strict';

// An investigation wave's answer has to come home.
//
// THE DEFECT THIS PINS, measured 2026-08-25. A 42-task wave was dispatched with
// a brief that said, in as many words: run this red test, and if it cannot run
// here for a reason about the environment rather than the code, FIX NOTHING and
// name the missing precondition. Forty-two agents did exactly that. All 42
// graded NO_DIFF, and every one of those answers was unreachable from this
// machine -- `cloud status` prints a bracket state and the words "no diff",
// `cloud diff` has nothing to show, and the CLI has no command that returns an
// agent's message at all. The wave was correct, the pipeline was correct, and
// the deliverable was lost between them.
//
// The fence already TOLERATED a REPORT- file: grade() skips one when deciding
// whether a diff stayed in bounds. It never READ one. So the whole mechanism for
// carrying an answer home existed except for its last step, and briefs were
// being written to FORBID the file rather than to use it.
//
// NOTHING HERE PINS A SPELLING. The assertions are about what a reader of the
// manifest can learn: that the answer arrives, that a report-only task is not
// silently empty, that a cut-off answer says it was cut off, and that adding a
// report never changes the fence verdict a diff would otherwise have earned.

const assert = require('node:assert');

const { grade } = require('../src/lib/cloud-agent/batch-harvest');

function reportDiff(file, lines) {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function targetDiff(file) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-const before = 1',
    '+const after = 2',
  ].join('\n');
}

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; console.log(`ok - ${label}`); };

check('the answer a task was sent to get arrives in the manifest', () => {
  const answer = [
    'NOTHING FOUND',
    '(b) is true: this image runs Node 20 and the module imports node:sqlite,',
    'so the test cannot run here. ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite',
  ];
  const diff = `${reportDiff('REPORT-orphan.md', answer)}\n${targetDiff('tests/thing.js')}`;
  const graded = grade(diff, 'tests/thing.js');

  assert.equal(graded.findings.length, 1, 'the report the task wrote is not in the graded result');
  assert.equal(graded.findings[0].file, 'REPORT-orphan.md');
  // The whole answer, not a summary of it: a harvester that paraphrased would be
  // a second opinion about work nobody can re-run.
  for (const line of answer) {
    assert.ok(graded.findings[0].text.includes(line), `the report's own words are missing: ${line}`);
  }
});

check('a task that correctly changed NOTHING but the report is not an empty result', () => {
  // THE CASE THE WHOLE CHANGE EXISTS FOR. An agent that answers "the environment
  // is at fault, I changed nothing" is obeying its brief. Before this, that task
  // was indistinguishable from one that found nothing to say.
  const diff = reportDiff('REPORT-only.md', ['NOTHING FOUND', 'the precondition is a signed-in vault']);
  const graded = grade(diff, 'tests/thing.js');

  assert.notEqual(graded.verdict, 'NO_DIFF', 'a task whose whole deliverable is its answer graded as though it said nothing');
  assert.equal(graded.findings.length, 1);
  assert.ok(graded.findings[0].text.includes('the precondition is a signed-in vault'));
});

check('a genuinely empty diff still says nothing, and says it the same way as before', () => {
  const graded = grade('', 'tests/thing.js');
  assert.equal(graded.verdict, 'NO_DIFF', 'an empty diff is still the honest nothing-to-report answer');
  assert.deepEqual(graded.files, []);
  assert.ok(!graded.findings || graded.findings.length === 0, 'an empty diff invented a finding');
});

check('a cut-off answer says that it was cut off', () => {
  // A truncated answer read as a whole one is the same defect class this
  // repository keeps finding: a partial result presented as a complete one.
  const long = ['x'.repeat(9000)];
  const graded = grade(reportDiff('REPORT-long.md', long), 'tests/thing.js');

  assert.equal(graded.findings.length, 1);
  assert.equal(graded.findings[0].truncated, true, 'a cut-off answer did not declare itself cut off');
  assert.ok(graded.findings[0].text.length < long[0].length, 'nothing was actually cut');
});

check('carrying the answer never changes the verdict the diff had earned', () => {
  // The fence decides landing; findings are cargo. If adding a report could move
  // a diff from OUT_OF_FENCE to IN_FENCE, a task could talk its way in.
  const stray = [
    'diff --git a/src/lib/unrelated.js b/src/lib/unrelated.js',
    '--- a/src/lib/unrelated.js',
    '+++ b/src/lib/unrelated.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n');

  const withoutReport = grade(`${targetDiff('tests/thing.js')}\n${stray}`, 'tests/thing.js');
  const withReport = grade(
    `${reportDiff('REPORT-x.md', ['NOTHING FOUND'])}\n${targetDiff('tests/thing.js')}\n${stray}`,
    'tests/thing.js',
  );

  assert.equal(withoutReport.verdict, 'OUT_OF_FENCE');
  assert.equal(withReport.verdict, 'OUT_OF_FENCE', 'a report changed the fence verdict, so a stray file could ride in behind an answer');
  assert.equal(withReport.findings.length, 1, 'the answer was dropped just because the diff was out of fence -- an out-of-fence task still explains itself');
});

check('a report with no added lines is not a finding', () => {
  // A rename or a deletion touching a REPORT- path is not an answer, and an
  // empty finding in a manifest is a row a reader has to check to learn nothing.
  const emptied = [
    'diff --git a/REPORT-gone.md b/REPORT-gone.md',
    'deleted file mode 100644',
    '--- a/REPORT-gone.md',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-it used to say this',
  ].join('\n');
  const graded = grade(`${emptied}\n${targetDiff('tests/thing.js')}`, 'tests/thing.js');
  assert.equal((graded.findings || []).length, 0, 'a removed report was reported as an answer');
});

console.log(`# checks ${checks}`);

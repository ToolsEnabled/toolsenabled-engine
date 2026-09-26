// EXECUTABLE CHANGE
'use strict';

/* TEST-CAN-FAIL REPORT (testcanfail-tests-cloud-batch-plan-test-js)
 *
 * STRENGTHENED -- drift precondition at the real-git integration case.
 * Precondition mutation: ran this file with PATH=/nonexistent so every git
 * spawn failed and `base` stayed empty. Before this change the `if` skipped the
 * case and the file stayed green; now the RED output is:
 *   "AssertionError [ERR_ASSERTION]: drift precondition: real git initialized
 *    and committed the fixture (got \"\")"
 * Named precondition: a usable git executable, identity configuration, and a
 * successful fixture commit that produces a full 40-character object id.
 *
 * STRENGTHENED -- malformed numeric CLI input must emit the planner's own
 * CLOUD_BATCH_PLAN_USAGE/positive-integer diagnostic. Product mutation:
 * temporarily made the CLI's require.main branch return status 2 with no
 * output for the `60abc` invocation. The old status-only assertion stayed
 * green; the new assertion produced this RED output:
 *   "AssertionError [ERR_ASSERTION]: cli: the malformed bound is refused by
 *    the planner's own integer diagnostic, not merely by any process failure ()"
 *
 * STRENGTHENED -- that same refusal must leave `never-2.json` absent. Product
 * mutation: temporarily wrote that output in the CLOUD_BATCH_PLAN_USAGE catch
 * only when launches-per-minute was `60abc`. The new assertion produced:
 *   "AssertionError [ERR_ASSERTION]: cli: refusing a malformed bound writes no
 *    declaration"
 * Both temporary edits to tools/cloud-batch-plan.js were restored byte-for-byte
 * (`cmp` and matching SHA-256), and the restored run was GREEN:
 *   "cloud-batch-plan tests passed (77 checks: ...)."
 *
 * Shape census: (1) NOT-FOUND -- the only assertion loop has a literal,
 * non-empty three-name input; task `.every()` assertions are preceded by the
 * exact planned/task count assertion. (2) FOUND and fixed as above; all other
 * process-status assertions are paired with subject output and/or filesystem
 * evidence. (3) NOT-FOUND -- `raises` checks both that an error exists and its
 * code; the cleanup catch is not test evidence. (4) NOT-FOUND -- filesystem
 * and freshness/drift doubles inject dependencies rather than mock the planner
 * behavior asserted. (5) FOUND and fixed as above. (6) NOT-FOUND -- imported
 * ceilings are boundary ownership, while seals are cross-checked through the
 * independent admission module; no expected value is produced by the planner
 * operation it checks.
 */

// The batch planner: a directory of briefs in, ONE declaration out.
//
// WHAT THESE TESTS ARE ACTUALLY DEFENDING. The planner's whole value is that
// its output is a COUNT as much as it is a file -- read, validated, excluded,
// with every exclusion named. So most of what follows builds a corpus with
// something wrong in it and then asserts that the wrongness is VISIBLE: the
// invalid brief is named and its text never reaches the declaration, the
// colliding pair is named on both sides, the unreadable brief stops the plan
// instead of quietly shrinking it.
//
// EVERY ASSERTION CALLS SOMETHING WITH VALUES. Nothing here pins a sentence, a
// key order, or an implementation spelling: the refusals are asserted on their
// `code` and on the FILENAMES they name, because naming the file is the
// behaviour that was asked for. The one number imported rather than typed is
// the rate ceiling -- taken from batch-target.js so this test cannot drift from
// the module that owns it.
//
// THE SHAPE IS PROVED BY USE, NOT BY INSPECTION. The declaration is written to
// disk, read back with JSON.parse, and handed to admitBatch against a stub
// mirror; the seal the planner predicted is compared with the seal admission
// computes. A shape test that only checked keys would pass on a declaration
// admission refuses.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const planner = require('../tools/cloud-batch-plan.js');
const batchTarget = require('../src/lib/cloud-agent/batch-target');

const CLI = path.join(__dirname, '..', 'tools', 'cloud-batch-plan.js');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-batch-plan-'));

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

async function raises(code, action, message) {
  let error = null;
  try { await action(); } catch (raised) { error = raised; }
  check(error !== null, `${message} (nothing was thrown)`);
  check(error && error.code === code, `${message} (expected ${code}, got ${error && error.code}: ${error && error.message})`);
  return error;
}

const FRESH_MIRROR = { checkMirrorFreshness: async () => ({ fresh: true }) };

/* A brief that PASSES tools/agent-contract.js. The validator refuses a
   `because` that names no measurement and a `done` only the agent itself could
   check, so these have to be real. Writing them out in full is this test paying
   the price a corpus author pays. */
function brief({ target, task = 'give every empty catch in this file a named reason', because, done, report = 'REPORT-x.md', role = 'IMPLEMENTER' }) {
  return [
    'CONTRACT/1',
    `role      ${role}`,
    `target    ${target}`,
    `do        ${task}`,
    `because   ${because || `3 empty catch blocks measured in ${target}, each discarding the refusal it was meant to report`}`,
    `done      ${done || 'no catch in this file discards an error without reporting it or carrying a written reason'}`,
    `report    ${report}`,
    ''
  ].join('\n');
}

function corpus(name, files) {
  const dir = path.join(TEMP, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), contents, 'utf8');
  return dir;
}

/* Delegates to the real fs except where a test needs a specific failure. Built
   by delegation rather than by spreading the module so an untouched call can
   never silently become undefined. */
function fsWith(overrides) {
  return {
    readdirSync: (...args) => fs.readdirSync(...args),
    readFileSync: (...args) => fs.readFileSync(...args),
    existsSync: (...args) => fs.existsSync(...args),
    lstatSync: (...args) => fs.lstatSync(...args),
    mkdirSync: (...args) => fs.mkdirSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    ...overrides
  };
}

function refusalOf(error) { return `${error && error.code}: ${error && error.message}`; }

(async () => {
  // -------------------------------------------------------------------
  // The whole job on a corpus that has something wrong with it.
  // -------------------------------------------------------------------
  const INVALID_MARKER = 'tidy-up-the-vibes-in-this-module';
  const mixed = corpus('mixed', {
    // The task name in the filename deliberately does NOT match the target, so
    // a planner that derived targets from filenames would be caught.
    'engine__alpha.contract': brief({ target: 'src/renamed-alpha.js' }),
    'engine__beta.contract': brief({ target: 'src/beta.js' }),
    'engine__gamma.contract': brief({ target: 'src/gamma.js' }),
    // Invalid: `because` names no measurement, which is the commonest way a
    // brief sends an agent to fix something that is not broken.
    'engine__broken.contract': brief({ target: 'src/broken.js', task: INVALID_MARKER, because: 'it feels a bit messy in there' }),
    // A perfectly good brief -- for another repository.
    'app__delta.contract': brief({ target: 'src/delta.js' }),
    // A brief whose repository cannot be established from its name.
    'stray.contract': brief({ target: 'src/stray.js' }),
    // Not a brief at all.
    'README.txt': 'not a contract\n'
  });

  const plan = planner.planBatch({
    corpusDir: mixed, project: 'engine', batchId: 'wave-1', launchesPerMinute: 60, accounts: 2
  });

  check(plan.summary.read === 6,
    `summary: every .contract file is counted as read, and nothing else is (got ${plan.summary.read})`);
  check(plan.summary.planned === 3 && plan.declaration.tasks.length === 3,
    `summary: exactly the briefs that validated are planned (got ${plan.summary.planned})`);
  check(plan.summary.read === plan.summary.planned + plan.summary.excluded.length,
    'summary: read = planned + excluded, so nothing can be lost between the corpus and the declaration without showing up in the arithmetic');

  const excludedByFile = new Map(plan.summary.excluded.map((item) => [item.file, item]));
  check(excludedByFile.get('engine__broken.contract')
    && excludedByFile.get('engine__broken.contract').code === planner.EXCLUSION.BRIEF_INVALID,
    'exclusion: the invalid brief is reported BY NAME, not counted anonymously');
  check(String(excludedByFile.get('engine__broken.contract').reason).length > 20,
    'exclusion: the invalid brief carries the validator\'s own reason, so the author can fix it without re-running anything');
  check(excludedByFile.get('app__delta.contract')
    && excludedByFile.get('app__delta.contract').code === planner.EXCLUSION.OTHER_REPO,
    'exclusion: a brief for another repository is named and given its own reason -- it is not "invalid", it is not for this batch');
  check(excludedByFile.get('stray.contract')
    && excludedByFile.get('stray.contract').code === planner.EXCLUSION.NAME_SHAPE,
    'exclusion: a filename that does not say which repo it belongs to is refused rather than guessed at');

  // THE POINT OF VALIDATING AT ALL: the bad brief is not in the declaration.
  check(plan.declaration.tasks.every((task) => !task.contract.includes(INVALID_MARKER)),
    'validation: the text of a brief that failed validation never reaches the declaration -- it is excluded, not carried through unvalidated');

  check(plan.declaration.tasks.some((task) => task.target === 'src/renamed-alpha.js'),
    'target: a task takes the target from the contract\'s own target field, which is what the collision gate keys on -- not from the filename');
  check(plan.declaration.tasks.every((task) => typeof task.source === 'string' && task.source.endsWith('.contract')),
    'traceability: every task names the brief file it came from, so a journal line that records index 155 can be traced back to a file');
  check(plan.declaration.tasks.every((task) => !task.source.includes(path.sep) && !task.source.includes('/')),
    'traceability: the source is a basename -- an absolute path would bind a sealed declaration to the machine that planned it');

  // The printed summary carries the names too. A count with no names is a
  // number the operator has to take on trust.
  const printed = planner.summaryLines(plan.summary, path.join(TEMP, 'out.json')).join('\n');
  for (const named of ['engine__broken.contract', 'app__delta.contract', 'stray.contract']) {
    check(printed.includes(named), `summary print: ${named} is named in the printed summary, not just counted`);
  }
  check(/\b6\b/.test(printed) && /\b3\b/.test(printed),
    'summary print: the counts read and planned both appear, because "how many were dropped" is the difference between a plan and a guess');

  // -------------------------------------------------------------------
  // Determinism. Task INDEX is the journal's identity for a dispatch, so the
  // same corpus must plan the same way twice or a resume re-dispatches the
  // wrong work.
  // -------------------------------------------------------------------
  {
    const again = planner.planBatch({
      corpusDir: mixed, project: 'engine', batchId: 'wave-1', launchesPerMinute: 60, accounts: 2
    });
    check(again.summary.admissionSha256 === plan.summary.admissionSha256,
      'determinism: planning the same corpus twice produces the same seal, so a journal header still identifies the declaration it ran from');
    check(again.declaration.tasks.map((t) => t.source).join(',') === plan.declaration.tasks.map((t) => t.source).join(','),
      'determinism: task order is stable, because resumePlan hands back indices and a reordered plan would resume the wrong tasks');
  }

  // -------------------------------------------------------------------
  // THE SHAPE, PROVED BY USE: written to disk, read back, admitted.
  // -------------------------------------------------------------------
  {
    const outFile = path.join(TEMP, 'declaration-a.json');
    const exit = await planner.main([
      '--corpus', mixed, '--project', 'engine', '--batch-id', 'wave-1',
      '--launches-per-minute', '60', '--accounts', '2', '--out', outFile
    ], { log: () => {}, logError: () => {} });
    check(exit === 0, `cli: a corpus that plans exits 0 (got ${exit})`);

    const fromDisk = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const admitted = await batchTarget.admitBatch(fromDisk, { mirrorApi: FRESH_MIRROR });
    check(admitted.admitted === true,
      'shape: the declaration this planner writes is admitted by the real admission gate, mirror stub and all');
    check(admitted.taskCount === 3, `shape: admission sees the planned tasks (got ${admitted.taskCount})`);
    check(admitted.admissionSha256 === plan.summary.admissionSha256,
      'shape: the seal the planner printed is the seal admission computes, so an operator can match a journal header to the file that produced it');
    check(batchTarget.assertSealIntact(admitted, fromDisk) === true,
      'shape: the file on disk still seals intact after a JSON round trip -- key order and whitespace do not move it');
  }

  // -------------------------------------------------------------------
  // WHAT THE AGENTS WILL SEE. batch-target.js gained an optional
  // `against.publishedCommit` after this planner was commissioned, and now
  // refuses a batch that declares neither that nor a mirror. Both modes are
  // driven here against the real gates, because a declaration this planner
  // writes that admission refuses is a declaration nobody can use.
  // -------------------------------------------------------------------
  {
    const commit = 'a'.repeat(40);
    const drifted = planner.planBatch({
      corpusDir: mixed, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1, againstCommit: commit
    });
    check(drifted.declaration.against && drifted.declaration.against.publishedCommit === commit,
      'source: a declared published commit reaches the declaration, where admission\'s drift gate can key on it');
    check(plan.declaration.against === undefined,
      'source: with no commit declared the key is absent, which is mirror mode -- never inferred from a mirror being unreachable');

    // Admitted against a tree where none of the planned targets moved.
    const admitted = await batchTarget.admitBatch(drifted.declaration, { changedSince: async () => new Set(['docs/unrelated.md']) });
    check(admitted.admitted === true && admitted.admissionSha256 === drifted.summary.admissionSha256,
      'source: the published-commit declaration is admitted by the drift gate at the seal the planner predicted');

    // And refused, by name, when a planned target is one of the files that moved.
    const movedTarget = drifted.declaration.tasks[0].target;
    const refusal = await raises('CLOUD_BATCH_REFUSED',
      () => batchTarget.admitBatch(drifted.declaration, { changedSince: async () => new Set([movedTarget]) }),
      'source: a target that moved since the published commit is refused by admission, on a declaration this planner wrote');
    check(refusal.message.includes(movedTarget),
      'source: the drift refusal names the file, which is only possible because the task target came from the contract');

    // A commit id the module will not accept is refused by the module's own
    // rule -- this planner does not keep a second copy of it.
    await raises('CLOUD_BATCH_MALFORMED',
      () => planner.planBatch({
        corpusDir: mixed, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1, againstCommit: 'abc1234'
      }),
      'source: an abbreviated commit is refused by parseBatchTarget before anything is written, rather than by a rule restated here');
  }

  // -------------------------------------------------------------------
  // Two briefs, one target. Refuse the plan and name BOTH files.
  // -------------------------------------------------------------------
  {
    const clashing = corpus('collision', {
      'engine__first.contract': brief({ target: 'src/lib/shared.js' }),
      'engine__second.contract': brief({ target: 'src/lib/shared.js' }),
      'engine__other.contract': brief({ target: 'src/lib/elsewhere.js' })
    });
    const error = await raises('CLOUD_BATCH_PLAN_TARGET_COLLISION',
      () => planner.planBatch({ corpusDir: clashing, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1 }),
      'collision: two briefs on one target refuse the whole plan rather than the planner picking one');
    check(error.message.includes('engine__first.contract') && error.message.includes('engine__second.contract'),
      `collision: BOTH files are named, which is the value of refusing here -- admission can only say "tasks 0 and 1" (${refusalOf(error)})`);

    // Same file, spelled two ways. The filesystem this batch runs against does
    // not distinguish them, so neither does the planner.
    const spelled = corpus('collision-spelling', {
      'engine__one.contract': brief({ target: 'src/lib/Shared.js' }),
      'engine__two.contract': brief({ target: 'src\\lib\\shared.js' })
    });
    const spellingError = await raises('CLOUD_BATCH_PLAN_TARGET_COLLISION',
      () => planner.planBatch({ corpusDir: spelled, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1 }),
      'collision: one file spelled with a different case and separator is still one file');
    check(spellingError.message.includes('engine__one.contract') && spellingError.message.includes('engine__two.contract'),
      'collision: the spelling variant names both files too');

    // Nothing is written when a plan is refused.
    const outFile = path.join(TEMP, 'declaration-collision.json');
    const exit = await planner.main([
      '--corpus', clashing, '--project', 'engine', '--batch-id', 'w',
      '--launches-per-minute', '10', '--accounts', '1', '--out', outFile
    ], { log: () => {}, logError: () => {} });
    check(exit === 1, `cli: a refused plan exits nonzero (got ${exit})`);
    check(fs.existsSync(outFile) === false,
      'cli: a refused plan writes no declaration -- a half-written plan on disk is one somebody runs');
  }

  // -------------------------------------------------------------------
  // "Could not look" is never "nothing there".
  // -------------------------------------------------------------------
  {
    const outUnreadable = path.join(TEMP, 'out-unreadable.json');
    const outputErrors = [];
    const outputExit = await planner.main([
      '--corpus', mixed, '--project', 'engine', '--batch-id', 'w',
      '--launches-per-minute', '10', '--accounts', '1', '--out', outUnreadable
    ], {
      fsImpl: fsWith({ lstatSync: () => { const error = new Error('lookup denied'); error.code = 'EACCES'; throw error; } }),
      log: () => {},
      logError: (line) => outputErrors.push(line)
    });
    check(outputExit === 1 && outputErrors.some((line) => line.includes('CLOUD_BATCH_PLAN_OUT_UNVERIFIED')),
      'output: a failed existence lookup refuses instead of converting could-not-look into an absent path');
    check(fs.existsSync(outUnreadable) === false,
      'output: an unverified destination is not written');

    const absent = await raises('CLOUD_BATCH_PLAN_CORPUS_ABSENT',
      () => planner.planBatch({ corpusDir: path.join(TEMP, 'no-such-corpus'), project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1 }),
      'corpus: a path that does not exist says so');

    const unreadable = await raises('CLOUD_BATCH_PLAN_CORPUS_UNREADABLE',
      () => planner.planBatch({
        corpusDir: mixed, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1,
        fsImpl: fsWith({ readdirSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } })
      }),
      'corpus: a directory that could not be read is a DIFFERENT answer from one that is not there');
    check(absent.code !== unreadable.code,
      'corpus: the two answers carry different codes, so no caller can merge them by accident');

    await raises('CLOUD_BATCH_PLAN_CORPUS_EMPTY',
      () => planner.planBatch({
        corpusDir: corpus('no-briefs', { 'README.md': '# nothing here\n' }),
        project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1
      }),
      'corpus: a directory with no briefs in it refuses rather than writing a declaration with no work in it');
  }

  // -------------------------------------------------------------------
  // A SELECTED brief that cannot be read stops the plan. An excluded one
  // cannot.
  // -------------------------------------------------------------------
  {
    const locked = path.join(mixed, 'engine__beta.contract');
    const error = await raises('CLOUD_BATCH_PLAN_BRIEF_UNREADABLE',
      () => planner.planBatch({
        corpusDir: mixed, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1,
        fsImpl: fsWith({
          readFileSync: (file, ...rest) => {
            if (String(file) === locked) { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }
            return fs.readFileSync(file, ...rest);
          }
        })
      }),
      'unreadable brief: a brief this batch would have dispatched, which nobody could read, refuses the whole plan');
    check(error.message.includes('engine__beta.contract'),
      `unreadable brief: the file is named (${refusalOf(error)})`);
    check(error.code !== planner.EXCLUSION.BRIEF_INVALID && !error.message.includes('invalid'),
      'unreadable brief: "could not read it" is not filed as "it was invalid" -- whether it was valid is exactly what is unknown');

    // A brief that was never going to be dispatched cannot stop the plan: it is
    // excluded before anything tries to read it.
    const strayFile = path.join(mixed, 'stray.contract');
    const stillPlans = planner.planBatch({
      corpusDir: mixed, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1,
      fsImpl: fsWith({
        readFileSync: (file, ...rest) => {
          if (String(file) === strayFile) { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }
          return fs.readFileSync(file, ...rest);
        }
      })
    });
    check(stillPlans.summary.planned === 3,
      'unreadable brief: a file already excluded from this batch is never read, so a locked file nobody was going to dispatch does not stop the plan');
  }

  // -------------------------------------------------------------------
  // A selection that comes back empty says why, and names what it did see.
  // -------------------------------------------------------------------
  {
    const others = corpus('other-repos', {
      'app__one.contract': brief({ target: 'src/one.js' }),
      'website__two.contract': brief({ target: 'src/two.js' })
    });
    const error = await raises('CLOUD_BATCH_PLAN_EMPTY',
      () => planner.planBatch({ corpusDir: others, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1 }),
      'empty selection: a corpus holding nothing for this project refuses instead of writing an empty declaration');
    check(error.message.includes('app') && error.message.includes('website'),
      `empty selection: the repo prefixes actually present are named, so "wrong --project" is one read away (${refusalOf(error)})`);
  }

  // -------------------------------------------------------------------
  // Bounds. The ceiling is imported from the module that measured it, never
  // retyped here.
  // -------------------------------------------------------------------
  {
    const accounts = 2;
    const ceiling = batchTarget.MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT * accounts;
    const atCeiling = planner.planBatch({
      corpusDir: mixed, project: 'engine', batchId: 'w', launchesPerMinute: ceiling, accounts
    });
    check(atCeiling.summary.bounds.launchesPerMinute === ceiling,
      'bounds: exactly the measured ceiling is planned, not clamped down to something the operator did not ask for');
    await raises('CLOUD_BATCH_PLAN_BOUNDS',
      () => planner.planBatch({ corpusDir: mixed, project: 'engine', batchId: 'w', launchesPerMinute: ceiling + 1, accounts }),
      'bounds: one launch a minute over the ceiling is refused at planning time rather than writing a file admission would refuse');
  }

  // -------------------------------------------------------------------
  // A brief written by a different editor is the same brief.
  // -------------------------------------------------------------------
  {
    const body = brief({ target: 'src/crlf.js' });
    const withBom = corpus('line-endings', { 'engine__crlf.contract': `﻿${body.replace(/\n/g, '\r\n')}` });
    const lf = corpus('line-endings-lf', { 'engine__crlf.contract': body });
    const bomPlan = planner.planBatch({ corpusDir: withBom, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1 });
    const lfPlan = planner.planBatch({ corpusDir: lf, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1 });
    check(bomPlan.summary.planned === 1,
      'normalization: a BOM and CRLF line endings do not make a valid brief unreadable');
    check(bomPlan.summary.admissionSha256 === lfPlan.summary.admissionSha256,
      'normalization: the same brief saved by two editors seals identically -- a seal that fires on line endings is a seal somebody turns off');
  }

  // -------------------------------------------------------------------
  // A BRIEF OVER THE DISPATCHER'S COMMAND-LINE CEILING IS EXCLUDED AT PLAN
  // TIME, BY NAME. The prompt travels in argv and Windows caps CreateProcess
  // at 32,767 characters; before this gate, an oversized brief failed at
  // DISPATCH, after admission sealed it, as a silent unresolved intent --
  // measured on the two largest briefs of a 20-task wave, twice. The ceiling
  // is imported from the dispatcher, not restated, so the two cannot drift.
  // -------------------------------------------------------------------
  {
    const dispatcher = require('../src/lib/cloud-agent/codex-dispatcher.js');
    /* Valid CONTRACT/1, merely enormous: the payload rides inside the `do`
       field the way a base64 diff would, so the brief passes the same
       validation admission runs and reaches the ceiling gate on its merits. */
    const oversized = brief({
      target: 'src/huge.js',
      task: `review the attached payload ${'x'.repeat(dispatcher.MAX_PROMPT_CHARS + 1)}`
    });
    const bigCorpus = corpus('oversized-brief', {
      'engine__huge.contract': oversized,
      'engine__fits.contract': brief({ target: 'src/fits.js' })
    });
    const plan = planner.planBatch({ corpusDir: bigCorpus, project: 'engine', batchId: 'w', launchesPerMinute: 10, accounts: 1 });
    check(plan.summary.planned === 1 && plan.declaration.tasks[0].target === 'src/fits.js',
      'ceiling: the brief that fits is still planned');
    const dropped = plan.summary.excluded.find((entry) => entry.code === planner.EXCLUSION.PROMPT_TOO_LONG);
    check(Boolean(dropped) && dropped.file === 'engine__huge.contract',
      'ceiling: the oversized brief is EXCLUDED BY NAME at plan time -- failing at dispatch after admission sealed it is the measured silent path this closes');
    check(/32,?767|command-line|dispatch/.test(dropped ? dropped.reason : ''),
      'ceiling: the reason teaches the constraint, not merely that something was wrong');
  }

  // -------------------------------------------------------------------
  // THE DRIFT GATE AGAINST A REAL GIT REPOSITORY, WITH THE PROJECT IN A
  // SUBDIRECTORY.
  //
  // This uses real git on purpose. `driftedSince` takes an exec implementation,
  // so a stubbed one would have passed with the bug present -- the stub decides
  // what the paths look like, and the paths were the entire defect.
  //
  // A task's `target` is relative to the PROJECT root. `git diff --name-only`
  // prints paths relative to the REPOSITORY root whatever -C says, while
  // `git ls-files` prints them relative to -C. When a project sits in a
  // subdirectory those are two namespaces, the diffs can never match a target,
  // and the gate silently passes every stale target through while still firing
  // on untracked files -- alive enough to look healthy.
  //
  // Measured on the site project (toolsenabled/operator-services/website):
  // 37 of 39 targets had drifted and the gate dropped none.
  // -------------------------------------------------------------------
  {
    const repo = path.join(TEMP, 'driftrepo');
    const project = path.join(repo, 'sub');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(project, 'src', 'moved.js'), 'const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(project, 'src', 'still.js'), 'const b = 2;\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = String(spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim();
    fs.writeFileSync(path.join(project, 'src', 'moved.js'), 'const a = 99;\n', 'utf8');
    git('commit', '-qam', 'move one file');

    check(base.length === 40,
      `drift precondition: real git initialized and committed the fixture (got ${JSON.stringify(base)})`);
    {
      const driftCorpus = corpus('drift-subproject', {
        'engine__moved.contract': brief({ target: 'src/moved.js' }),
        'engine__still.contract': brief({ target: 'src/still.js' })
      });
      const out = path.join(TEMP, 'drift-subproject.json');
      const run = spawnSync(process.execPath, [
        CLI, '--corpus', driftCorpus, '--project', 'engine', '--batch-id', 'drift-sub',
        '--launches-per-minute', '10', '--accounts', '1',
        '--against-commit', base, '--drift-check', project, '--out', out
      ], { encoding: 'utf8' });

      check(run.status === 0, `drift: the plan runs against a sub-project (exit ${run.status}) ${run.stderr}`);
      check(run.stdout.includes('engine__moved.contract'),
        'drift: a target that moved is EXCLUDED and named, even though the project is not the repository root -- '
        + 'the whole bug was that git answered in repo-root paths while targets are project-relative');
      const planned = JSON.parse(fs.readFileSync(out, 'utf8'));
      check(planned.tasks.length === 1 && planned.tasks[0].target === 'src/still.js',
        `drift: the unmoved target is still planned and the moved one is not (got ${planned.tasks.map((t) => t.target).join(',')})`);
    }
  }

  // -------------------------------------------------------------------
  // The command line itself: refusing to clobber, and refusing to guess.
  // -------------------------------------------------------------------
  {
    const outFile = path.join(TEMP, 'declaration-cli.json');
    const first = spawnSync(process.execPath, [
      CLI, '--corpus', mixed, '--project', 'engine', '--batch-id', 'wave-2',
      '--launches-per-minute', '60', '--accounts', '2', '--out', outFile
    ], { encoding: 'utf8' });
    check(first.status === 0, `cli: the documented command line runs (exit ${first.status}) ${first.stderr}`);
    check(first.stdout.includes('engine__broken.contract'),
      'cli: the run prints the excluded brief by name on stdout, where the operator will see it');
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    check(written.tasks.length === 3 && written.bounds.launchesPerMinute === 60,
      'cli: --out carries the declaration, with the bounds that were asked for');
    check(batchTarget.parseBatchTarget(written).batchId === 'wave-2',
      'cli: --batch-id lands in the declaration and survives parseBatchTarget');

    const second = spawnSync(process.execPath, [
      CLI, '--corpus', mixed, '--project', 'engine', '--batch-id', 'wave-2',
      '--launches-per-minute', '60', '--accounts', '2', '--out', outFile
    ], { encoding: 'utf8' });
    check(second.status === 1,
      `cli: an --out that already exists refuses rather than overwriting a declaration a journal may point at (exit ${second.status})`);
    check(second.stderr.includes('CLOUD_BATCH_PLAN_OUT_EXISTS'),
      'cli: the refusal names itself, so a script can branch on it without reading English');

    const missing = spawnSync(process.execPath, [
      CLI, '--corpus', mixed, '--project', 'engine', '--batch-id', 'wave-3',
      '--launches-per-minute', '60', '--out', path.join(TEMP, 'never.json')
    ], { encoding: 'utf8' });
    check(missing.status === 2, `cli: a missing required flag is a usage error, distinct from a refused plan (exit ${missing.status})`);
    check(missing.stderr.includes('accounts'), 'cli: the usage error names the flag that was missing');
    check(fs.existsSync(path.join(TEMP, 'never.json')) === false, 'cli: a usage error writes nothing');

    const badNumber = spawnSync(process.execPath, [
      CLI, '--corpus', mixed, '--project', 'engine', '--batch-id', 'wave-4',
      '--launches-per-minute', '60abc', '--accounts', '2', '--out', path.join(TEMP, 'never-2.json')
    ], { encoding: 'utf8' });
    check(badNumber.status === 2,
      `cli: a bound that is not an integer refuses instead of being rounded into one nobody typed (exit ${badNumber.status})`);
    check(badNumber.stderr.includes('CLOUD_BATCH_PLAN_USAGE') && badNumber.stderr.includes('positive integer'),
      `cli: the malformed bound is refused by the planner's own integer diagnostic, not merely by any process failure (${badNumber.stderr})`);
    check(fs.existsSync(path.join(TEMP, 'never-2.json')) === false,
      'cli: refusing a malformed bound writes no declaration');
  }

  try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`cloud-batch-plan tests passed (${checks} checks: every brief validated with the same call the admission gate makes, an invalid brief named and its text kept out of the declaration, a brief for another repo and a brief with no repo in its name each excluded under their own reason, targets read from the contract's own field, two briefs on one target refusing the plan and naming BOTH files across case and separator spellings, an unreadable SELECTED brief refusing while an already-excluded one cannot, absent versus unreadable corpora answered differently, an empty selection naming the prefixes it did see, the imported rate ceiling honoured at and above the limit, BOM and CRLF sealing identically, both source modes driven through the real gates -- a stub mirror and a stub changedSince -- and the written file admitted by admitBatch at the seal the planner predicted).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

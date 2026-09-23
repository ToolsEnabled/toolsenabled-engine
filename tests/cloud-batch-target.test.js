// EXECUTABLE CHANGE
'use strict';

/* TEST-CAN-FAIL REPORT (testcanfail-tests-cloud-batch-target-test-js)
 *
 * Strengthened assertion: the exported batch schema is now pinned to the
 * public v1 identifier instead of being trusted as the test fixture's own
 * expected value. Mutation applied to the code under test: changed
 * BATCH_SCHEMA from `toolsenabled.cloud-batch.target/v1` to
 * `toolsenabled.cloud-batch.target/MUTATED`. Before this assertion, the test
 * stayed green with all 102 checks. With this assertion, the mutation was red:
 *
 *   AssertionError [ERR_ASSERTION]: schema: the exported identifier is the public v1 contract, not an expectation copied from the implementation
 *
 * The source was restored byte-for-byte (SHA-256
 * 4644187877c6746d78ce76fa40313e7ed8f663a27b5bce7b678de57e89f93df4).
 * The restored run is green:
 *
 *   cloud-batch tests passed (103 checks: ...)
 *
 * NOT-FOUND (1): no assertion loop iterates over a possibly empty collection;
 * the only assertion loop uses the four-element literal `cases`.
 * NOT-FOUND (2): no exit-status or generic truthy-return assertion is used as
 * evidence for process output; this test spawns no process.
 * NOT-FOUND (3): no try/catch or optional chain swallows the failure under
 * test. `raises` captures errors and requires both an error and its exact code;
 * the adjective-gate catch is followed by `refusal === null`. The final catch
 * reports an uncaught test failure and sets a failing exit code.
 * NOT-FOUND (4): no assertion measures a mock of the operation under test.
 * Injected mirror/drift/fs collaborators provide boundary conditions, while
 * assertions measure batch-target and batch-journal behavior.
 * NOT-FOUND (5): there are no skips or platform precondition guards.
 * NOT-FOUND (6), after the schema fix: no expected assertion value is computed
 * by the same subject code it checks.
 * Preconditions not met: none.
 */

// The batch target and its journal.
//
// THE TWO PROPERTIES UNDER TEST ARE THE TWO THE OWNER NAMED. A coordinator
// declares everything up front and then LOSES CONTROL of the batch; and a
// partial run is never a lost run. Both are only worth anything if they hold
// when something goes wrong, so most of what follows is about being killed
// halfway, being edited after admission, and being handed a declaration that
// does not say enough.
//
// THE REFUSALS ARE ASSERTED ON THEIR CONTENT, not only their code. A batch is
// admitted once by a coordinator who then stops watching; if a refusal does not
// say what to change, the coordinator's only move is to guess, and guessing at
// admission is how people start bypassing it.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = require('../src/lib/cloud-agent/batch-target');
const journal = require('../src/lib/cloud-agent/batch-journal');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

async function raises(code, action, message) {
  let error = null;
  try { await action(); } catch (raised) { error = raised; }
  check(error !== null, `${message} (nothing was thrown)`);
  check(error && error.code === code, `${message} (expected ${code}, got ${error && error.code}: ${error && error.message})`);
  return error;
}

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-batch-'));

/* A brief that PASSES the validator. It has to be a real one now: the brief
   gate runs tools/agent-contract.js, which refuses a `because` naming no
   measurement and a `done` only the agent could check. Writing these out in
   full is the test paying the same price a coordinator pays. */
function task(index, targetPath) {
  const file = targetPath || `src/file-${index}.js`;
  return { target: file, contract: [
    'CONTRACT/1',
    'role      IMPLEMENTER',
    `target    ${file}`,
    'do        give every empty catch in this file a named reason',
    `because   3 empty catch blocks measured in ${file}, each discarding the refusal it was meant to report`,
    'done      no catch in this file discards an error without reporting it or carrying a written reason',
    `report    REPORT-${index}.md`,
  ].join('\n') };
}

function declaration(overrides = {}) {
  return {
    schemaVersion: target.BATCH_SCHEMA,
    batchId: 'wave-1',
    project: 'engine',
    tasks: [task(0), task(1), task(2)],
    bounds: { launchesPerMinute: 60, accounts: 2 },
    ...overrides
  };
}

const FRESH_MIRROR = { checkMirrorFreshness: async () => ({ fresh: true }) };

(async () => {
  check(target.BATCH_SCHEMA === 'toolsenabled.cloud-batch.target/v1',
    'schema: the exported identifier is the public v1 contract, not an expectation copied from the implementation');

  // -------------------------------------------------------------------
  // Admission: everything up front, or a reason why not.
  // -------------------------------------------------------------------
  {
    const admitted = await target.admitBatch(declaration(), { mirrorApi: FRESH_MIRROR });
    check(admitted.admitted === true, 'admission: a complete declaration against a fresh mirror is admitted');
    check(admitted.taskCount === 3 && admitted.bounds.launchesPerMinute === 60,
      'admission: the admitted record carries the bounds the coordinator declared');
    check(/^[0-9a-f]{64}$/.test(admitted.admissionSha256),
      'admission: a seal is computed, because losing control is only safe if the thing admitted cannot then change');
  }

  // -------------------------------------------------------------------
  // EVERY refusal is returned, not the first.
  //
  // A coordinator about to stop steering has to fix everything in one pass.
  // Refusing one reason at a time turns admission into a guessing game.
  // -------------------------------------------------------------------
  {
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration({
        tasks: [task(0, 'src/same.js'), task(1, 'src/same.js'), { target: 'src/x.js' }],
        bounds: { launchesPerMinute: 5000, accounts: 1 }
      }), { mirrorApi: FRESH_MIRROR }),
      'admission: a declaration with several faults is refused');
    check(error.details && error.details.findings.length >= 3,
      'admission: ALL findings are returned together, so one pass fixes the declaration');
    const text = error.message;
    check(/both target/.test(text), 'admission: the collision finding names both offending tasks');
    check(/no CONTRACT\/1|carries no CONTRACT/.test(text), 'admission: the unbriefed task is named');
    check(/measured ceiling/.test(text), 'admission: the rate finding cites the measured ceiling rather than an opinion');
  }

  // -------------------------------------------------------------------
  // UNDERSPECIFIED BRIEFS ARE REFUSED, and this gate is deliberately strict.
  //
  // A batch is admitted once and then runs unattended. A brief nobody checked
  // reaches an agent with nobody left to notice it was vague, and the cost is
  // not a bad diff -- it is a paid dispatch that produces something no one can
  // use. The validator reused here is the one whose every rule this project
  // bought with a wasted wave.
  // -------------------------------------------------------------------
  {
    const withField = (name, value) => {
      const lines = ['CONTRACT/1', 'role      IMPLEMENTER', 'target    src/u.js',
        'do        fix the thing', 'because   3 occurrences measured in src/u.js',
        'done      the count is zero when the drive is re-run', 'report    R.md'];
      return lines.map((line) => (line.startsWith(name) ? `${name}${' '.repeat(Math.max(1, 10 - name.length))}${value}` : line)).join('\n');
    };
    const cases = [
      ['because', 'it looks messy and should be cleaner', /measurement/i,
        'a because naming no measurement is how an agent gets sent to fix something that is not broken'],
      ['done', 'the file is properly cleaned up', /checkable by anybody but the agent/i,
        'a done only the agent can judge cannot be verified by whoever reads the result'],
      ['role', 'WIZARD', /role must be one of/i,
        'an unknown role is refused rather than passed through to an agent that cannot act on it'],
      ['do', 'fix the bug at src/u.js:412', /file:line/i,
        'a file:line citation addresses different code on a different branch, which cost this project three whole waves'],
    ];
    for (const [field, value, expected, why] of cases) {
      const error = await raises('CLOUD_BATCH_REFUSED',
        () => target.admitBatch(declaration({ tasks: [{ target: 'src/u.js', contract: withField(field, value) }] }),
          { mirrorApi: FRESH_MIRROR }),
        `brief gate: an underspecified ${field} is refused -- ${why}`);
      check(expected.test(error.message),
        `brief gate: the refusal for ${field} says what to change, not merely that something is wrong (got: ${error.message.slice(0, 120)})`);
      check(/task 0 \(src\/u\.js\)/.test(error.message),
        `brief gate: the refusal for ${field} names WHICH task and WHICH file, so a 257-task batch is fixable`);
    }

    /* THE ADJECTIVE GATE MUST NOT READ A FILENAME AS AN OPINION.
     *
     * `done` is required to name the file the diff may touch, and this tree
     * contains `tools/require-clean-tree.mjs`. `\bclean\b` matched inside that
     * filename, so a correct brief was refused and the only way to pass the
     * gate was to stop naming the target -- which is the one thing `done` is
     * for. Both directions are pinned: the filename passes, and the opinion it
     * was mistaken for still fails. */
    {
      const naming = withField('done', 'the diff touches no file except tools/require-clean-tree.mjs and node --check exits 0');
      let refusal = null;
      try {
        await target.admitBatch(declaration({ tasks: [{ target: 'src/u.js', contract: naming }] }),
          { mirrorApi: FRESH_MIRROR });
      } catch (raised) { refusal = raised; }
      check(refusal === null,
        `brief gate: a done that NAMES a file whose name contains an adjective is admitted (got: ${refusal && refusal.message})`);

      const opinion = withField('done', 'the tree is left clean and the run is tidy');
      const error = await raises('CLOUD_BATCH_REFUSED',
        () => target.admitBatch(declaration({ tasks: [{ target: 'src/u.js', contract: opinion }] }),
          { mirrorApi: FRESH_MIRROR }),
        'brief gate: a genuinely subjective done is still refused after paths are excused');
      check(/checkable by anybody but the agent/i.test(error.message),
        'brief gate: excusing filenames did not weaken the rule the gate exists for');
    }
  }

  // -------------------------------------------------------------------
  // Collision is refused, because two diffs on one file cannot both apply.
  // -------------------------------------------------------------------
  {
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration({ tasks: [task(0, 'src/a.js'), task(1, 'src/A.JS')] }), { mirrorApi: FRESH_MIRROR }),
      'admission: two tasks targeting one file refuse even when the paths differ only in case');
    check(/cannot both apply/.test(error.message),
      'admission: the collision refusal says WHY it matters rather than only that it happened');
  }

  // -------------------------------------------------------------------
  // A stale mirror refuses the whole batch at admission.
  //
  // This is the measured one: the app's cloud branch sat 467 commits behind
  // local HEAD and its harvests came back useless, while the engine's, 5
  // behind, came back clean.
  // -------------------------------------------------------------------
  {
    const stale = { checkMirrorFreshness: async () => ({ fresh: false }) };
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration(), { mirrorApi: stale }),
      'admission: a mirror behind local HEAD refuses the batch before anything dispatches');
    check(/stale source/.test(error.message),
      'admission: the mirror refusal explains that every agent would diff against stale source');
  }
  {
    const unreachable = { checkMirrorFreshness: async () => { const e = new Error('registry absent'); e.code = 'CLOUD_MIRROR_NOT_REGISTERED'; throw e; } };
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration(), { mirrorApi: unreachable }),
      'admission: a mirror that cannot be CHECKED refuses too -- unknown is not fresh');
    check(/could not be confirmed current/.test(error.message),
      'admission: the unknown case is worded as unconfirmed rather than as stale, because they have different remedies');
  }
  {
    const unanswered = { checkMirrorFreshness: async () => undefined };
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration(), { mirrorApi: unanswered }),
      'admission: a mirror check that returns no verdict refuses rather than treating undefined as fresh');
    check(/no definite fresh answer/.test(error.message),
      'admission: a malformed mirror response is reported as unestablished rather than stale');
  }

  // -------------------------------------------------------------------
  // The network gate is not reached while the declaration is malformed.
  // -------------------------------------------------------------------
  {
    let asked = 0;
    const counting = { checkMirrorFreshness: async () => { asked += 1; return { fresh: true }; } };
    await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration({ tasks: [task(0, 'src/same.js'), task(1, 'src/same.js')] }), { mirrorApi: counting }),
      'admission: a colliding declaration is refused');
    check(asked === 0, 'admission: a malformed declaration costs no network round trip -- gates run cheapest first');
  }

  // -------------------------------------------------------------------
  // THE SEAL. Editing a declaration after admission stops the batch.
  // -------------------------------------------------------------------
  {
    const original = declaration();
    const admitted = await target.admitBatch(original, { mirrorApi: FRESH_MIRROR });
    check(target.assertSealIntact(admitted, original) === true,
      'seal: the unmodified declaration passes at dispatch time');

    // Key order and whitespace must NOT break the seal, or it fires on
    // formatting and the first person to hit that disables it.
    const reordered = { bounds: original.bounds, tasks: original.tasks, project: original.project, batchId: original.batchId, schemaVersion: original.schemaVersion };
    check(target.assertSealIntact(admitted, reordered) === true,
      'seal: the seal is over MEANING -- reordering keys does not break it');

    const edited = declaration({ tasks: [...original.tasks, task(3)] });
    await raises('CLOUD_BATCH_SEAL_BROKEN',
      () => target.assertSealIntact(admitted, edited),
      'seal: a task added after admission stops the batch rather than dispatching work that never passed the gates');
  }

  // -------------------------------------------------------------------
  // THE DRIFT GATE -- the mirror's guarantee, per task, when there is no
  // mirror.
  //
  // MEASURED, and it is why this gate is per-task rather than per-batch: engine
  // harvests were CLEAN at 5 commits behind the published branch and USELESS at
  // 467. The distance is not what decides it. Whether this task's own file
  // moved is. Of a 150-task engine corpus measured against 11 unpublished
  // commits, 119 targets had not moved and 31 had.
  // -------------------------------------------------------------------
  const COMMIT = 'a'.repeat(40);

  {
    const moved = new Set(['src/moved.js']);
    const changedSince = async () => moved;
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration({
        against: { publishedCommit: COMMIT },
        tasks: [task(0, 'src/still.js'), task(1, 'src/moved.js')]
      }), { changedSince }),
      'drift: a task whose target moved since the published commit is refused');
    check(/src\/moved\.js/.test(error.message) && !/src\/still\.js/.test(error.message),
      'drift: ONLY the moved target is named -- refusing the whole batch for one moved file would throw away the 119 that are fine');
    check(/older copy of the one file it was sent to edit/.test(error.message),
      'drift: the refusal says what the agent would actually experience, not merely that a hash differs');
  }

  {
    const changedSince = async () => new Set(['src/elsewhere.js']);
    const admitted = await target.admitBatch(declaration({
      against: { publishedCommit: COMMIT },
      tasks: [task(0, 'src/still.js'), task(1, 'src/also-still.js')]
    }), { changedSince });
    check(admitted.admitted === true,
      'drift: tasks whose targets did not move are admitted against a behind-but-published branch -- the distance is irrelevant when the file is byte-identical');
    check(admitted.declaration.against.publishedCommit === COMMIT,
      'drift: the admitted record carries WHAT it was dispatched against, so a harvest can tell later');
  }

  {
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration({ against: { publishedCommit: COMMIT } }),
        { changedSince: async () => undefined }),
      'drift: an absent changed-file result refuses rather than becoming an empty set');
    check(/not returned as a Set or array/.test(error.message),
      'drift: the refusal identifies that drift was not measured');
  }

  // A batch that can vouch for nothing must not be admitted. This is the case
  // that would otherwise let a batch silently lose the mirror's guarantee.
  {
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration(), {}),
      'drift: a batch with neither a mirror to check nor a declared published commit is refused');
    check(/unvouched-for source|unestablished/.test(error.message),
      'drift: the refusal names the real problem -- what the agents would see was never established');
  }

  // "Could not look" is not "did not move".
  {
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration({ against: { publishedCommit: COMMIT } }), {}),
      'drift: declaring a published commit with no way to ask what changed is refused');
    check(/could not look/.test(error.message),
      'drift: an unanswerable drift question refuses rather than admitting tasks nobody checked');
  }
  {
    const exploding = async () => { throw new Error('not a git repository'); };
    const error = await raises('CLOUD_BATCH_REFUSED',
      () => target.admitBatch(declaration({ against: { publishedCommit: COMMIT } }), { changedSince: exploding }),
      'drift: a drift check that throws refuses rather than admitting');
    check(/not a git repository/.test(error.message),
      'drift: the underlying reason is forwarded, so the coordinator can fix the real thing');
  }

  // An abbreviated commit cannot be compared reliably against a diff.
  {
    await raises('CLOUD_BATCH_MALFORMED',
      () => target.admitBatch(declaration({ against: { publishedCommit: 'abc1234' } }), { changedSince: async () => new Set() }),
      'drift: an abbreviated commit id is refused -- it cannot be compared against a diff reliably');
  }

  // THE MODES ARE EXCLUSIVE, and declared rather than inferred. A batch against
  // a published commit must not ALSO be silently judged against a mirror.
  {
    let mirrorAsked = 0;
    const mirrorApi = { checkMirrorFreshness: async () => { mirrorAsked += 1; return { fresh: false }; } };
    const admitted = await target.admitBatch(declaration({
      against: { publishedCommit: COMMIT },
      tasks: [task(0, 'src/still.js')]
    }), { mirrorApi, changedSince: async () => new Set() });
    check(admitted.admitted === true && mirrorAsked === 0,
      'drift: a published-commit batch does not consult a mirror -- there is no mirror in that mode, and a stale one must not refuse a batch that never relied on it');
  }

  // The seal covers the mode. Swapping a mirror batch for a published-commit
  // batch after admission is exactly the silent-guarantee-loss this prevents.
  {
    const original = declaration({ against: { publishedCommit: COMMIT }, tasks: [task(0, 'src/still.js')] });
    const admitted = await target.admitBatch(original, { changedSince: async () => new Set() });
    const swapped = { ...original, against: null };
    await raises('CLOUD_BATCH_SEAL_BROKEN',
      () => target.assertSealIntact(admitted, swapped),
      'drift: removing the declared source after admission breaks the seal -- otherwise a batch could shed the guarantee it was admitted under');
  }

  // -------------------------------------------------------------------
  // THE JOURNAL. A partial run is never a lost run.
  // -------------------------------------------------------------------
  {
    const stateRoot = path.join(TEMP, 'journal-a');
    const admitted = await target.admitBatch(declaration(), { mirrorApi: FRESH_MIRROR });
    const file = journal.openBatch({ stateRoot, admission: admitted });

    journal.recordIntent({ file, index: 0, target: 'src/file-0.js' });
    journal.recordLaunched({ file, index: 0, taskId: 'task_aaa', account: 'cloud-a' });
    journal.recordIntent({ file, index: 1, target: 'src/file-1.js' });
    journal.recordRefused({ file, index: 1, code: 'RATE_LIMITED', reason: '429' });
    // Index 2: intent written, then the process dies. This is the case the
    // whole file exists for.
    journal.recordIntent({ file, index: 2, target: 'src/file-2.js' });

    const read = journal.readJournal(file);
    check(read.launched.length === 1 && read.launched[0].taskId === 'task_aaa',
      'journal: a launched dispatch keeps the provider id that makes it findable again');
    check(read.refused.length === 1, 'journal: a provider refusal is recorded distinctly');
    check(read.unresolved.length === 1 && read.unresolved[0].index === 2,
      'journal: an intent with no outcome is UNRESOLVED -- it may be running and billing under an id nobody wrote down');

    await raises('CLOUD_BATCH_UNRECONCILED',
      () => journal.resumePlan(read, { totalTasks: 3 }),
      'journal: a resume REFUSES while anything is unresolved -- guessing either skips work or pays twice, and a cloud task cannot be cancelled');
  }

  // -------------------------------------------------------------------
  // A clean partial run resumes at exactly the right place.
  // -------------------------------------------------------------------
  {
    const stateRoot = path.join(TEMP, 'journal-b');
    const admitted = await target.admitBatch(declaration(), { mirrorApi: FRESH_MIRROR });
    const file = journal.openBatch({ stateRoot, admission: admitted });
    journal.recordIntent({ file, index: 0, target: 'a' });
    journal.recordLaunched({ file, index: 0, taskId: 'task_a', account: 'cloud-a' });

    const plan = journal.resumePlan(journal.readJournal(file), { totalTasks: 3 });
    check(plan.alreadyLaunched === 1, 'journal: a resume knows what already went out');
    check(plan.remaining.join(',') === '1,2',
      'journal: a resume dispatches exactly what never went out -- not everything, which would double-bill');
  }

  // -------------------------------------------------------------------
  // A KILL MID-WRITE. The expected damage, and only the expected damage.
  // -------------------------------------------------------------------
  {
    const stateRoot = path.join(TEMP, 'journal-c');
    const admitted = await target.admitBatch(declaration(), { mirrorApi: FRESH_MIRROR });
    const file = journal.openBatch({ stateRoot, admission: admitted });
    journal.recordIntent({ file, index: 0, target: 'a' });
    journal.recordLaunched({ file, index: 0, taskId: 'task_a', account: 'cloud-a' });
    fs.appendFileSync(file, '{"kind":"intent","index":1,"targ');   // killed mid-line

    const read = journal.readJournal(file);
    check(read.truncatedLines === 1,
      'journal: a half-written final line is COUNTED, so "this journal was cut short" is visible rather than silently rounded away');
    check(read.launched.length === 1,
      'journal: everything written before the kill survives -- which is the entire reason each line is flushed on its own');

    // Damage anywhere but the last line is a different problem and must not be
    // filed under "expected".
    const midDamaged = path.join(stateRoot, 'mid.jsonl');
    fs.writeFileSync(midDamaged, '{"kind":"admitted"}\nNOT JSON\n{"kind":"intent","index":9}\n');
    await raises('CLOUD_BATCH_JOURNAL_CORRUPT',
      () => journal.readJournal(midDamaged),
      'journal: a broken line that is NOT the last one refuses -- a kill damages only the final record, so this file was damaged some other way');
  }

  // -------------------------------------------------------------------
  // An absent journal is not an empty one.
  // -------------------------------------------------------------------
  {
    await raises('CLOUD_BATCH_JOURNAL_ABSENT',
      () => journal.readJournal(path.join(TEMP, 'nope', 'missing.jsonl')),
      'journal: an absent journal refuses rather than reading as "nothing was dispatched" -- which would risk dispatching the whole batch twice');
  }

  // -------------------------------------------------------------------
  // An unwritable journal refuses BEFORE any dispatch.
  // -------------------------------------------------------------------
  {
    const exploding = {
      mkdirSync: () => {},
      openSync: () => { const e = new Error('EACCES'); throw e; }
    };
    await raises('CLOUD_BATCH_JOURNAL_UNWRITABLE',
      () => journal.recordIntent({ file: path.join(TEMP, 'x.jsonl'), index: 0, target: 'a', fsImpl: exploding }),
      'journal: if the intent cannot be recorded the dispatch does not happen -- a dispatch nobody recorded cannot be recovered and cannot be cancelled');
  }

  // -------------------------------------------------------------------
  // THE HARVEST SPEC -- the last half of "specify everything up front".
  //
  // Until this, `harvest` passed through unvalidated and consumed by nothing:
  // an API surface that reads as specified and does nothing, the settings-
  // that-enforce-nothing defect one layer up. Now it is validated at
  // admission, sealed with the declaration, and written into the journal
  // header -- the same file the harvester enumerates the wave from.
  // -------------------------------------------------------------------
  {
    const parsed = target.parseBatchTarget(declaration());
    check(parsed.harvest.branch === 'harvest/batch' && parsed.harvest.mutationSample === 5,
      'harvest: an undeclared spec gets DECLARED defaults, visible in the sealed declaration, not an absence');

    const custom = target.parseBatchTarget(declaration({ harvest: { branch: 'harvest/wave9', mutationSample: 8 } }));
    check(custom.harvest.branch === 'harvest/wave9' && custom.harvest.mutationSample === 8,
      'harvest: a declared spec is carried exactly');

    await raises('CLOUD_BATCH_MALFORMED',
      () => target.parseBatchTarget(declaration({ harvest: { branch: 'ok', skipVerification: true } })),
      'harvest: an unknown field refuses -- accepted-but-ignored reads as specified and does nothing');
    await raises('CLOUD_BATCH_MALFORMED',
      () => target.parseBatchTarget(declaration({ harvest: { mutationSample: 0 } })),
      'harvest: a mutation sample of nought refuses -- a landed test never shown able to go red guards nothing, and skipping the check is not offered');

    // Sealed: changing the harvest spec after admission stops the batch.
    const original = declaration({ harvest: { branch: 'harvest/a', mutationSample: 5 } });
    const admission = await target.admitBatch(original, { mirrorApi: FRESH_MIRROR });
    await raises('CLOUD_BATCH_SEAL_BROKEN',
      () => target.assertSealIntact(admission, declaration({ harvest: { branch: 'harvest/b', mutationSample: 5 } })),
      'harvest: repointing the landing branch after admission breaks the seal -- the coordinator specified it and then lost control of it');

    // And it reaches the journal header, where the harvester actually reads.
    const stateRoot = path.join(TEMP, 'harvest-header');
    const file = journal.openBatch({ stateRoot, admission });
    const read = journal.readJournal(file);
    check(read.header.harvest && read.header.harvest.branch === 'harvest/a',
      'harvest: the spec travels in the journal header, the same file that names the tasks -- the provider list caps at 20 rows, so the journal is where a harvester looks');
  }

  // -------------------------------------------------------------------
  // THE PROVIDER BLOCK: dispatch coordinates inside the seal.
  //
  // The CLI's handoff comment named this gap from the start: coordinates
  // taken from flags would let a sealed batch be pointed at an environment
  // nobody admitted. The block is optional -- absent keeps the old contract
  // exactly -- but declared, it is validated whole and sealed with the rest.
  // -------------------------------------------------------------------
  {
    const parsed = target.parseBatchTarget(declaration());
    check(parsed.provider === null,
      'provider: a declaration without one parses with provider null -- nothing that admitted yesterday refuses today');

    const full = target.parseBatchTarget(declaration({
      provider: { environments: { 'cloud-b': 'b'.repeat(32), 'cloud-a': 'a'.repeat(32) }, concurrency: 10 }
    }));
    check(full.provider.branch === 'main', 'provider: branch defaults to main rather than to a guess');
    check(full.provider.concurrency === 10, 'provider: declared concurrency is carried');
    check(Object.keys(full.provider.environments).join(',') === 'cloud-a,cloud-b',
      'provider: environments are canonically ordered, so the seal is over meaning and not key order');
    check(Object.isFrozen(full.provider) && Object.isFrozen(full.provider.environments),
      'provider: the parsed block is frozen -- specified once, then out of reach');

    await raises('CLOUD_BATCH_MALFORMED',
      () => target.parseBatchTarget(declaration({ provider: { environments: { a: 'a'.repeat(32), b: 'b'.repeat(32) }, repository: 'x' } })),
      'provider: an unknown field is refused rather than accepted-and-ignored');
    await raises('CLOUD_BATCH_MALFORMED',
      () => target.parseBatchTarget(declaration({ provider: { environments: { a: 'not-hex' } } })),
      'provider: an environment id that is not 32 hex characters is refused by name');
    await raises('CLOUD_BATCH_MALFORMED',
      () => target.parseBatchTarget(declaration({ provider: { environments: { only: 'c'.repeat(32) } } })),
      'provider: an account roster that disagrees with bounds.accounts is refused while the coordinator is still steering');

    const sealedWith = await target.admitBatch(declaration({
      provider: { environments: { a: 'a'.repeat(32), b: 'b'.repeat(32) } }
    }), { mirrorApi: FRESH_MIRROR });
    await raises('CLOUD_BATCH_SEAL_BROKEN',
      () => target.assertSealIntact(sealedWith, declaration({
        provider: { environments: { a: 'a'.repeat(32), b: 'd'.repeat(32) } }
      })),
      'provider: repointing an environment after admission breaks the seal -- the destination is exactly what the seal exists to pin');
  }

  try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`cloud-batch tests passed (${checks} checks: admission returning ALL findings with actionable reasons, collision refused case-insensitively, a stale mirror and an UNCHECKABLE mirror refused differently, gates ordered so a malformed declaration costs no round trip, the seal surviving key reorder and catching a post-admission edit, an intent with no outcome held as UNRESOLVED rather than failed, a resume refusing until those are reconciled, a kill mid-write losing only its final line, an absent or unwritable journal refusing rather than reading as empty, and THE DRIFT GATE: only the moved target named, unmoved targets admitted against a behind-but-published branch, a batch that can vouch for nothing refused, could-not-look separated from did-not-move, the two modes exclusive, and the declared source covered by the seal, plus THE PROVIDER BLOCK: absent meaning the old contract, defaults and canonical order, unknown fields and bad ids and a roster disagreeing with bounds.accounts refused by name, and a repointed environment breaking the seal).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

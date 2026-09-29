#!/usr/bin/env node
'use strict';

/* THE PLANNER -- a directory of briefs in, ONE declaration out.
 *
 * WHY THIS EXISTS AS A PROGRAM AND NOT AS A PASTE. src/lib/cloud-agent/
 * batch-target.js says a coordinator declares everything up front and then
 * LOSES CONTROL of the batch. That property is only worth having if the
 * declaration was BUILT by something reproducible. A hand-assembled list of
 * 257 tasks is exactly the hand-driven wave that module was written to end:
 * whoever assembles it decides, brief by brief, which ones to include, and
 * nobody afterwards can say what was left out or why.
 *
 * SO THE OUTPUT OF THIS FILE IS A COUNT AS MUCH AS IT IS A FILE. Read,
 * validated, excluded -- with every excluded brief named. A plan that reports
 * only what it included is indistinguishable from a plan that quietly lost
 * six briefs, and this codebase keeps re-finding the silent skip.
 *
 * THE ORDER IS DETERMINISTIC ON PURPOSE, and it is not cosmetic. Task INDEX is
 * the identity the journal records (batch-journal.js `recordIntent`) and the
 * identity a resume works from (`resumePlan` returns `remaining` as indices).
 * If re-planning the same corpus produced a different order, resuming an
 * interrupted batch would re-dispatch the wrong tasks -- paying twice for some
 * and skipping others. Files are therefore sorted by codepoint, not by locale
 * (`localeCompare` orders differently on differently-configured machines, which
 * would make the plan depend on the machine that produced it).
 *
 * FOR THE SAME REASON THE CONTRACT TEXT IS NORMALIZED before it enters a task:
 * BOM stripped, CRLF folded to LF, trailing whitespace removed. Those three
 * differ between checkouts by git's autocrlf setting and by which editor last
 * touched the file, and none of them changes what the brief says. Left alone
 * they change `admissionSha256`, and a seal that fires on line endings is a
 * seal somebody turns off.
 *
 * WHAT IT REFUSES, each refusal naming itself and the files involved:
 *   - a corpus that is absent, versus one that could not be read: DIFFERENT
 *     answers, different codes. Never merged.
 *   - a brief that would have been dispatched but could not be read. See
 *     `readOrRefuse` below for why that one refuses instead of excluding.
 *   - two briefs on one target, naming BOTH files. batch-target.js's collision
 *     gate refuses this too, but it can only say "tasks 41 and 155" -- it never
 *     saw a filename. Refusing here is what makes the answer actionable.
 *   - bounds above the measured ceiling, checked against the constant
 *     batch-target.js exports rather than a number restated here.
 *   - an --out path that already exists, because a journal header carries the
 *     admissionSha256 of a declaration and overwriting the file it came from
 *     destroys the only record of what was admitted.
 *
 * IT DOES NOT CALL assertActive, and that is deliberate rather than forgotten.
 * Planning has no outward effect: no provider, no network, no quota. The
 * kill-switch gate belongs on the dispatch that spends money, and putting it
 * here would only mean an operator cannot even prepare a plan while the switch
 * is down.
 *
 *   node tools/cloud-batch-plan.js --corpus <dir> --project <key> \
 *        --batch-id <id> --launches-per-minute <n> --accounts <n> \
 *        --out <declaration.json> [--against-commit <sha40>]
 *
 * WHY --against-commit EXISTS, since it is not in the shape this file was
 * commissioned to write. batch-target.js changed while this was being built
 * (an earlier commit): a
 * declaration must now say what its agents see, and admission REFUSES a batch
 * that declares neither `against.publishedCommit` nor a mirror to check. Absent
 * the flag this planner emits no `against`, which is mirror mode -- exactly the
 * shape it was asked for. With it, the declaration carries the published commit
 * the batch dispatches against and admission runs its per-task drift gate
 * instead. The value is passed straight through to parseBatchTarget, which owns
 * the rule for what a commit id must look like; restating that rule here would
 * make two standards out of one.
 *
 * Exit codes: 0 the plan was written; 1 the plan was refused, by name, and
 * nothing was written; 2 the command line itself was wrong.
 */

const fs = require('node:fs');
const path = require('node:path');
/* Only reached by --drift-check, which is a local git read. Planning still
 * performs no outward effect: no provider, no network, no quota. */
const { execFileSync } = require('node:child_process');

/* THE VALIDATOR IS REUSED, NOT RESTATED -- the same call batch-target.js's
 * brief gate makes. A second standard here would drift from that one, and the
 * looser of the two would become the real one: this planner would admit briefs
 * the gate then refuses at admission, 257 tasks after anyone could fix them. */
const agentContract = require('./agent-contract.js');
/* Only for MAX_PROMPT_CHARS -- the dispatcher owns the command-line ceiling,
 * and a second copy of that number here would drift from the one that fails. */
const codexDispatcher = require('../src/lib/cloud-agent/codex-dispatcher.js');
const batchTarget = require('../src/lib/cloud-agent/batch-target');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');

const CORPUS_SUFFIX = '.contract';

/* The corpus naming convention: `<repo>__<name>.contract`. The repo half is
 * load-bearing, not decoration -- a declaration names ONE mirror project, and a
 * brief for another repository dispatched against this project's mirror would
 * have an agent editing paths that do not exist in the tree it was given. The
 * non-greedy first group splits on the FIRST `__`, so a task name may contain
 * one. */
const CORPUS_NAME = /^([A-Za-z0-9][A-Za-z0-9._-]*?)__(.+)\.contract$/i;

const EXCLUSION = Object.freeze({
  NAME_SHAPE: 'NAME_SHAPE',
  OTHER_REPO: 'OTHER_REPO',
  BRIEF_INVALID: 'BRIEF_INVALID',
  DRIFTED: 'DRIFTED',
  PROMPT_TOO_LONG: 'PROMPT_TOO_LONG'
});

/* `accounts` is required: the declaration's bounds are cleared against it. */
const REQUIRED_FLAGS = Object.freeze(['corpus', 'project', 'batch-id', 'launches-per-minute', 'out']);
/* Optional, and absent means MIRROR mode -- the default and the strong case.
 * It is never inferred: batch-target.js refuses to let a batch fall back to a
 * published commit because a mirror was unreachable, and a planner that filled
 * this in on its own would reintroduce exactly that fallback. */
/* `--provider auto` used to resolve the dispatch coordinates by reading each
 * account's Codex Cloud environments. That reader used the Codex sign-in
 * outside the official CLI and was removed, so `auto` now refuses and the
 * flags that only fed it (--registry, --repository, --branch, --concurrency)
 * are gone. */
const OPTIONAL_FLAGS = Object.freeze(['against-commit', 'provider', 'drift-check', 'accounts']);
const FLAGS = Object.freeze([...REQUIRED_FLAGS, ...OPTIONAL_FLAGS]);

function fail(code, message, details) {
  throw new CloudAgentError(code, message, details);
}

/* --drift-check is meaningless without a commit to be stale RELATIVE TO, and
 * silently ignoring it would leave an operator believing stale briefs were
 * dropped when nothing was checked. */
function requireAgainstCommitFor(options) {
  if (options['against-commit'] === undefined) {
    throw usage('--drift-check needs --against-commit: in mirror mode the agents see this tree, so no target can be stale relative to it.');
  }
  return options['against-commit'];
}

/* Read and parse only. What a provider block must CONTAIN is owned by
 * parseBatchTarget, which the plan runs before writing anything; owning a
 * second copy of that shape here would make the looser copy the real one. */
function readProviderFile(file, fsImpl) {
  let raw;
  try {
    raw = fsImpl.readFileSync(path.resolve(file), 'utf8');
  } catch (error) {
    fail('CLOUD_BATCH_PLAN_PROVIDER_UNREADABLE',
      `--provider ${file} could not be read (${error && error.code}): ${error && error.message}. Nothing was written.`);
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail('CLOUD_BATCH_PLAN_PROVIDER_UNREADABLE',
      `--provider ${file} is not valid JSON: ${error && error.message}. Nothing was written.`);
  }
}

function usage(message) {
  return new CloudAgentError('CLOUD_BATCH_PLAN_USAGE',
    `${message} Usage: node tools/cloud-batch-plan.js ${REQUIRED_FLAGS.map((f) => `--${f} <value>`).join(' ')}`
    + ` ${OPTIONAL_FLAGS.map((f) => `[--${f} <value>]`).join(' ')}`);
}

/* Codepoint order, chosen over localeCompare so the same corpus produces the
 * same task indices on any machine. See the header: index is the journal's
 * identity for a dispatch. */
function byCodepoint(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/* Differences that change the seal without changing the brief. */
function normalizeContract(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/* THE COLLISION KEY IS STRICTER THAN THE ONE THE GATE USES, on purpose.
 * batch-target.js keys on `target.trim().toLowerCase()`; this also folds
 * backslashes to forward slashes and drops a trailing separator, so
 * `src\lib\a.js` and `src/lib/a.js` are caught as the one file they are on the
 * filesystem this batch will run against. Refusing a superset of what the gate
 * refuses is safe; the reverse would let a real collision through. */
function collisionKey(target) {
  return String(target).trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

function listCorpus(dir, fsImpl) {
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch (error) {
    /* "Could not look" and "not there" are different answers and never merge.
     * An absent corpus is a mistyped path; an unreadable one is a corpus that
     * may be full of briefs nobody can see. */
    if (error && error.code === 'ENOENT') {
      fail('CLOUD_BATCH_PLAN_CORPUS_ABSENT',
        `there is no corpus directory at ${dir}. Nothing was planned. This is "not there", not "could not look": the path does not exist.`);
    }
    fail('CLOUD_BATCH_PLAN_CORPUS_UNREADABLE',
      `the corpus directory at ${dir} could not be read: ${error && error.message}. Whether it holds briefs cannot be established from here, so nothing was planned.`);
  }
  const briefs = names.filter((name) => String(name).toLowerCase().endsWith(CORPUS_SUFFIX)).sort(byCodepoint);
  if (briefs.length === 0) {
    fail('CLOUD_BATCH_PLAN_CORPUS_EMPTY',
      `the corpus at ${dir} holds ${names.length} entr(y|ies) and none of them ends in ${CORPUS_SUFFIX}, so there is nothing to plan. `
      + 'A corpus holds one CONTRACT/1 brief per file, named <repo>__<name>.contract.');
  }
  return briefs;
}

/**
 * Read one brief that has already been SELECTED for this batch.
 *
 * IT REFUSES THE WHOLE PLAN RATHER THAN EXCLUDING THE FILE, and that asymmetry
 * with the invalid-brief case is the point. An invalid brief is a known defect
 * in a named file: the operator can read it, fix it, or accept its exclusion.
 * A brief that cannot be read is an UNKNOWN -- whether it was valid, whether it
 * collided with another task, and whether it was the important one are all
 * unanswerable. Dropping it and dispatching the other 256 would file "could not
 * look" under "nothing there", which is the one merge this project forbids.
 * Only briefs that passed selection reach this function, so a locked file the
 * batch was never going to dispatch cannot stop the plan.
 */
function readOrRefuse(file, name, fsImpl) {
  try {
    return normalizeContract(fsImpl.readFileSync(file, 'utf8'));
  } catch (error) {
    return fail('CLOUD_BATCH_PLAN_BRIEF_UNREADABLE',
      `${name} was selected for this batch and could not be read: ${error && error.message}. `
      + 'Refusing the whole plan rather than dispatching the rest: whether that brief was valid, and whether it targeted a file another task also targets, cannot be established, and "could not look" is not "nothing there".',
      { file: name });
  }
}

/**
 * Build one batch declaration from a corpus directory.
 *
 * Returns { declaration, summary }. Throws CloudAgentError, always with a code
 * and always naming the files involved.
 */
/* THE SAME THREE QUESTIONS tools/cloud-lane.js asks its drift gate, asked here
 * so the planner and the gate can never disagree about what "moved" means:
 * moved in history, differs in the working tree, or tracked at no commit at
 * all. A union can only ever exclude MORE than one question alone. Kept as a
 * plain git read -- planning still performs no outward effect and touches no
 * provider. Any git failure raises rather than returning a partial set: a
 * partial drift answer would admit exactly the tasks it failed to check. */
function driftedSince(repoRoot, publishedCommit, execImpl) {
  /* maxBuffer matches cloud-mirror.js's MAX_GIT_BUFFER_BYTES rather than
   * node's 1MB default. Found 2026-08-28 dispatching the launch corpus: the
   * website project's sourceRoot is the whole Desktop repository, its ls-files
   * -z output alone overruns 1MB, and drift-check died with spawnSync git
   * ENOBUFS while the dispatch-time drift gate handled the same tree fine --
   * the two halves of the same question were reading git through different
   * sized straws. */
  const run = (args) => String(execImpl('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 512 * 1024 * 1024 }) || '');
  try {
    run(['rev-parse', '--verify', `${publishedCommit}^{commit}`]);
  } catch (error) {
    fail('CLOUD_BATCH_PLAN_DRIFT_UNANSWERED',
      `${repoRoot} holds no commit ${publishedCommit} (${error && error.message}), so which files moved since it is unanswerable. Fetch it there or name a commit this checkout has; unanswerable is not "nothing moved".`);
  }
  const moved = new Set();
  const collect = (args, question) => {
    let out;
    try {
      out = run(args);
    } catch (error) {
      fail('CLOUD_BATCH_PLAN_DRIFT_UNANSWERED',
        `${question} could not be established in ${repoRoot} (${error && error.message}). Refusing rather than planning against the part of the answer that did work.`);
    }
    for (const entry of out.split('\0')) if (entry.length > 0) moved.add(entry);
  };
  /* `--relative` IS LOAD-BEARING WHEN THE PROJECT IS NOT THE REPOSITORY ROOT.
   *
   * A task's `target` is relative to the PROJECT root. `git -C <dir> diff
   * --name-only` prints paths relative to the REPOSITORY root regardless of
   * -C, while `git -C <dir> ls-files` prints them relative to <dir>. So when a
   * project lives in a subdirectory of a bigger repository, these three
   * questions were being answered in TWO DIFFERENT NAMESPACES: the two diffs
   * could never match a target, and only the untracked-files answer could.
   *
   * A gate that fires for one of three reasons is worse than one that never
   * fires, because it looks alive. Measured 2026-08-25 on the site project,
   * which lives at toolsenabled/operator-services/website inside its repo:
   * the diffs returned 3181 repo-root paths where 127 project-relative ones
   * were the real answer, and 37 of that wave's 39 targets HAD drifted while
   * the gate dropped none of them -- every one of those agents was handed an
   * older copy of the file it was sent to fix. Worse, the repo happens to also
   * carry a top-level `public/app/...`, so three targets sat in a coincidental
   * name collision and could have been dropped for a reason that had nothing
   * to do with them.
   *
   * `--relative` makes all three agree, and it is a no-op when the project IS
   * the repository root -- which is why every engine and app wave was correct
   * and nothing surfaced this until a project moved off the root. */
  collect(['diff', '--name-only', '--no-renames', '--relative', '-z', publishedCommit, 'HEAD'], 'which files moved between the published commit and HEAD');
  collect(['diff', '--name-only', '--no-renames', '--relative', '-z', publishedCommit], 'which files differ in the working tree from the published commit');
  collect(['ls-files', '--others', '--exclude-standard', '-z'], 'which files are present here and tracked at no commit');
  return moved;
}

function planBatch({ corpusDir, project, batchId, launchesPerMinute, accounts, againstCommit = null, provider = null, driftedTargets = null, fsImpl = fs }) {
  const dir = path.resolve(String(corpusDir));
  const names = listCorpus(dir, fsImpl);

  const tasks = [];
  const excluded = [];
  const collisions = [];
  const claimed = new Map();
  const reposSeen = new Set();

  for (const name of names) {
    /* Cheapest first, as batch-target.js orders its gates: a brief that is not
     * for this project costs no read. */
    const match = CORPUS_NAME.exec(name);
    if (!match) {
      excluded.push({
        file: name,
        code: EXCLUSION.NAME_SHAPE,
        reason: 'the filename does not carry the <repo>__<name>.contract shape, so which repository this brief belongs to cannot be established. Not guessing: a brief planned into the wrong project diffs against a tree that does not contain its target.'
      });
      continue;
    }
    const repo = match[1].toLowerCase();
    reposSeen.add(repo);
    if (repo !== String(project).toLowerCase()) {
      excluded.push({
        file: name,
        code: EXCLUSION.OTHER_REPO,
        reason: `names repo ${match[1]}, and this batch declares project ${project}. A cloud agent diffs against the project's mirror, so this brief's target would not exist in the tree it was handed.`
      });
      continue;
    }

    const text = readOrRefuse(path.join(dir, name), name, fsImpl);

    /* THE SAME TWO CALLS THE ADMISSION GATE MAKES. Anything that passes here
     * passes there; anything that fails here is named and never reaches the
     * declaration -- it is not silently dropped, and it is not carried through
     * unvalidated in the hope that admission will catch it. */
    const parsed = agentContract.parse(text);
    const problems = [...parsed.errors, ...agentContract.validate(parsed.fields)];
    if (problems.length > 0) {
      excluded.push({ file: name, code: EXCLUSION.BRIEF_INVALID, reason: problems.join('; ') });
      continue;
    }

    /* THE PROMPT TRAVELS IN ARGV AND WINDOWS CAPS A COMMAND LINE AT 32,767.
     * A brief over the dispatcher's ceiling cannot launch -- and before this
     * check it failed at DISPATCH, after admission sealed it, as a silent
     * unresolved intent the runner closed over with exit 0. Measured
     * 2026-08-25: the two largest briefs of a 20-task wave (large diffs
     * riding base64) died exactly that way, twice. The ceiling is the
     * dispatcher's own exported number, not a second standard. */
    if (text.length > codexDispatcher.MAX_PROMPT_CHARS) {
      excluded.push({
        file: name,
        code: EXCLUSION.PROMPT_TOO_LONG,
        reason: `the brief is ${text.length} characters and the dispatcher's command-line ceiling caps prompts at ${codexDispatcher.MAX_PROMPT_CHARS}. It would fail at dispatch, after admission sealed it. Shrink the brief or carry its payload another way.`
      });
      continue;
    }

    /* THE TARGET IS THE CONTRACT'S OWN `target` FIELD, never something derived
     * from the filename. The collision gate keys on task.target, so a target
     * invented here would let two briefs that really do edit one file pass a
     * gate that thought they were distinct. */
    const target = parsed.fields.target;

    /* A TARGET THAT HAS ALREADY MOVED IS EXCLUDED HERE, NOT REFUSED LATER.
     *
     * Admission's drift gate refuses the WHOLE batch when any one task targets
     * a file that changed since the published commit -- correctly, because the
     * agent would edit an older copy of the very file it was sent to. But a
     * corpus is planned against a tree other lanes are still committing to, so
     * on a 150-brief corpus that gate turns into a loop: plan, learn two names,
     * delete two briefs, re-plan, learn two more. Measured here: three rounds
     * revealed 2, then 2, then 12 more.
     *
     * The gate is not weakened -- nothing stale is ever dispatched either way.
     * This only stops writing tasks the gate is already known to refuse, and
     * every dropped brief is NAMED in the summary rather than silently missing.
     * Absent --drift-check the behaviour is exactly as before. */
    if (driftedTargets && driftedTargets.has(target)) {
      excluded.push({ file: name, code: EXCLUSION.DRIFTED, reason: `${target} has changed since ${String(againstCommit).slice(0, 12)}, the commit this batch dispatches against` });
      continue;
    }

    const key = collisionKey(target);
    if (claimed.has(key)) {
      collisions.push({ target, files: [claimed.get(key).file, name] });
      continue;
    }
    claimed.set(key, { file: name, target });

    /* `source` rides along so a refusal or a journal line can be traced back to
     * a file. The journal records an INDEX; without this, mapping index 155
     * back to the brief that produced it means re-running the planner and
     * hoping it ordered the corpus the same way. The BASENAME only: an absolute
     * path would bind a sealed declaration to the machine that planned it. */
    tasks.push({ target, contract: text, source: name });
  }

  if (collisions.length > 0) {
    /* NAMING BOTH FILES IS THE WHOLE VALUE OF REFUSING HERE. Admission refuses
     * the same collision, but it has only indices to name. */
    fail('CLOUD_BATCH_PLAN_TARGET_COLLISION',
      `${collisions.length} target(s) are claimed by more than one brief, so the whole plan is refused and nothing was written: `
      + collisions.map((c) => `${c.files[0]} and ${c.files[1]} both target ${c.target}`).join(' | ')
      + '. Two agents editing one file produce two diffs that cannot both apply. Pick one brief per target rather than letting the planner pick for you.',
      { collisions });
  }

  if (tasks.length === 0) {
    fail('CLOUD_BATCH_PLAN_EMPTY',
      `no brief in ${dir} could be planned for project ${project}: ${names.length} file(s) read, ${excluded.length} excluded. `
      + `Repo prefixes present in the corpus: ${reposSeen.size ? [...reposSeen].sort(byCodepoint).join(', ') : 'none -- no filename carried the <repo>__<name>.contract shape'}. `
      /* THE FIRST REASONS, IN THE SENTENCE. details carries every exclusion,
       * but an all-excluded corpus almost always fails one way 150 times --
       * and the operator who hit this with a corpus of EXPANDED briefs read
       * the prefix hint above, concluded the filenames were wrong, and spent
       * the diagnosis on the half that was fine. The corpus file is the raw
       * CONTRACT/1 spec; the expansion is what the agent-contract expander
       * PRINTS, and a brief that stores it fails parse here as BRIEF_INVALID. */
      + `First exclusions: ${excluded.slice(0, 3).map((e) => `${e.file} [${e.code}] ${String(e.reason || '').slice(0, 140)}`).join(' | ')}. `
      + 'A declaration with no tasks is a call nobody meant to make, so nothing was written.',
      { excluded });
  }

  /* THE CEILING IS IMPORTED, NOT RESTATED. batch-target.js owns the measured
   * number; a copy here would drift from it and the looser one would win. */
  const ceiling = batchTarget.MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT * accounts;
  if (launchesPerMinute > ceiling) {
    fail('CLOUD_BATCH_PLAN_BOUNDS',
      `--launches-per-minute ${launchesPerMinute} is above the measured ceiling of ${ceiling} for ${accounts} account(s) `
      + `(${batchTarget.MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT} per account), so admission would refuse this declaration. `
      + 'Refused at planning time instead of writing a file that cannot be admitted.');
  }

  const declaration = {
    schemaVersion: batchTarget.BATCH_SCHEMA,
    batchId,
    project,
    tasks,
    bounds: { launchesPerMinute, accounts },
    /* Omitted entirely rather than written as null when no commit was declared,
     * so the file says "mirror mode" by the absence the module reads, not by a
     * key an operator might later fill in by hand. */
    ...(againstCommit ? { against: { publishedCommit: againstCommit } } : {}),
    harvest: null,
    /* Same omission rule as `against`: absent means the old dispatch contract
     * (a caller-supplied dispatcher), never a half-filled block. The content
     * is passed through unexamined here -- parseBatchTarget below owns what a
     * provider block must look like, and refusing there names the field. */
    ...(provider ? { provider } : {})
  };

  /* Proving the shape before anything is written. parseBatchTarget is the
   * function admission calls first; if it refuses, the operator learns now
   * rather than from a file they will hand to a runner. */
  const parsedDeclaration = batchTarget.parseBatchTarget(declaration);

  return {
    declaration,
    summary: {
      corpus: dir,
      project,
      batchId,
      read: names.length,
      validated: tasks.length,
      planned: tasks.length,
      excluded,
      bounds: { launchesPerMinute, accounts },
      /* What the agents in this batch will actually see, printed because it is
       * the difference between a clean harvest and 250 diffs against source
       * that moved. */
      source: againstCommit ? `published commit ${againstCommit}` : `the mirror for ${project}, checked at admission`,
      /* The seal admission WILL compute, printed so an operator can match a
       * journal header against the file that produced it. Not stored inside the
       * declaration: a seal is taken over the declaration, so putting it in
       * would change the thing it measures. */
      admissionSha256: batchTarget.sealOf(parsedDeclaration)
    }
  };
}

function summaryLines(summary, outPath) {
  const lines = [];
  lines.push(`corpus            ${summary.corpus}`);
  lines.push(`project           ${summary.project}    batch ${summary.batchId}`);
  lines.push(`bounds            ${summary.bounds.launchesPerMinute}/min across ${summary.bounds.accounts} account(s)`);
  lines.push(`agents will see   ${summary.source}`);
  lines.push(`briefs read       ${summary.read}`);
  lines.push(`validated         ${summary.validated}`);
  lines.push(`excluded          ${summary.excluded.length}`);
  /* EVERY EXCLUSION BY NAME. A count with no names is a number the operator
   * has to take on trust, and taking exclusions on trust is how a wave comes
   * back missing work nobody can account for. */
  for (const item of summary.excluded) {
    lines.push(`  [${item.code}] ${item.file}: ${item.reason}`);
  }
  lines.push(`tasks planned     ${summary.planned}`);
  lines.push(`admission seal    ${summary.admissionSha256}`);
  if (outPath) lines.push(`written           ${outPath}`);
  return lines;
}

function parseCliArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (typeof flag !== 'string' || !flag.startsWith('--')) throw usage(`expected a --flag, got '${flag}'.`);
    const name = flag.slice(2);
    if (!FLAGS.includes(name)) throw usage(`unknown flag --${name}.`);
    if (name in options) throw usage(`duplicate flag --${name}.`);
    const value = argv[i + 1];
    if (value === undefined) throw usage(`flag --${name} requires a value.`);
    options[name] = value;
  }
  for (const name of REQUIRED_FLAGS) if (!(name in options)) throw usage(`--${name} is required.`);
  return options;
}

/* Strict, because Number('12abc') is NaN but parseInt('12abc') is 12 -- and a
 * bound the operator did not type is a bound nobody can reproduce. */
function positiveInteger(raw, flag) {
  if (!/^[0-9]+$/.test(String(raw).trim()) || Number(raw) < 1) {
    throw usage(`--${flag} must be a positive integer, got '${raw}'.`);
  }
  return Number(raw);
}

async function main(argv, { fsImpl = fs, log = console.log, logError = console.error } = {}) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    logError(`REFUSED [${error.code}] ${error.message}`);
    return 2;
  }

  const outPath = path.resolve(options.out);
  let outputWriteAttempted = false;
  try {
    /* An --out that already exists is refused rather than overwritten. A batch
     * journal's header carries the admissionSha256 of the declaration it ran
     * from; overwriting that file leaves a live journal pointing at a
     * declaration nobody can produce again. */
    let outputExists;
    try {
      fsImpl.lstatSync(outPath);
      outputExists = true;
    } catch (error) {
      if (error && error.code === 'ENOENT') outputExists = false;
      else {
        fail('CLOUD_BATCH_PLAN_OUT_UNVERIFIED',
          `whether --out ${outPath} already exists could not be established (${error && error.code}): ${error && error.message}. `
          + 'Refusing rather than treating an unreadable path as absent and risking replacement of a declaration a journal may point at.');
      }
    }
    if (outputExists) {
      fail('CLOUD_BATCH_PLAN_OUT_EXISTS',
        `${outPath} already exists and was not overwritten. A journal header carries the admissionSha256 of the declaration its batch ran from, so replacing that file destroys the only record of what was admitted. Write to a new path, or remove that one deliberately.`);
    }

    /* THE PROVIDER BLOCK: hand-written, or absent. `auto` refuses: it resolved
     * the block by reading Codex Cloud environments through a reader that is
     * no longer part of this build. */
    let providerBlock = null;
    if (options.provider === 'auto') {
      fail('CLOUD_BATCH_PLAN_AUTO_UNAVAILABLE',
        '--provider auto resolved accounts and environments through a Codex Cloud environment reader that is not part of this build. '
        + 'Pass --provider <file> holding { branch, environments, concurrency }, and --accounts. Nothing was written.');
    } else if (options.provider !== undefined) {
      providerBlock = readProviderFile(options.provider, fsImpl);
    }
    if (options.accounts === undefined) {
      throw usage('--accounts is required.');
    }

    const { declaration, summary } = planBatch({
      corpusDir: options.corpus,
      project: options.project,
      batchId: options['batch-id'],
      launchesPerMinute: positiveInteger(options['launches-per-minute'], 'launches-per-minute'),
      accounts: positiveInteger(options.accounts, 'accounts'),
      /* Passed through unexamined. parseBatchTarget owns what a commit id must
       * look like and refuses an abbreviation with its own reason; a second
       * check here would be a second standard. */
      againstCommit: options['against-commit'] === undefined ? null : options['against-commit'],
      /* --provider names a JSON file holding { branch, environments,
       * concurrency } -- the dispatch coordinates the declaration SEALS, so a
       * planned batch can be run by tools/cloud-lane.js batch with no harness
       * composed outside the repo. A file, not inline JSON: environment ids
       * are 32-hex values an operator should paste once, and Windows shells
       * eat inline JSON quoting in ways this project has been burned by. */
      provider: providerBlock,
      /* --drift-check <repoRoot> drops briefs whose target has already moved
       * since --against-commit, instead of writing a batch admission will
       * refuse for naming one. Requires --against-commit: in mirror mode the
       * agents see the local tree, so nothing can be stale relative to it. */
      driftedTargets: options['drift-check'] === undefined
        ? null
        : driftedSince(path.resolve(options['drift-check']), requireAgainstCommitFor(options), execFileSync),
      fsImpl
    });

    fsImpl.mkdirSync(path.dirname(outPath), { recursive: true });
    outputWriteAttempted = true;
    fsImpl.writeFileSync(outPath, `${JSON.stringify(declaration, null, 2)}\n`, 'utf8');
    for (const line of summaryLines(summary, outPath)) log(line);
    return 0;
  } catch (error) {
    if (error && error.code === 'CLOUD_BATCH_PLAN_USAGE') {
      logError(`REFUSED [${error.code}] ${error.message}`);
      return 2;
    }
    const code = error && error.code ? String(error.code) : 'CLOUD_BATCH_PLAN_UNEXPECTED';
    logError(`REFUSED [${code}] ${error && error.message ? error.message : String(error)}`);
    if (outputWriteAttempted) {
      logError(`Writing ${outPath} was attempted but did not complete successfully; inspect and remove any partial output before retrying.`);
    } else {
      logError('Nothing was written.');
    }
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      // main() catches its own refusals; reaching here is the tool breaking.
      console.error(`REFUSED [CLOUD_BATCH_PLAN_UNEXPECTED] ${error && error.message ? error.message : String(error)}`);
      console.error('Nothing was written.');
      process.exitCode = 1;
    }
  );
}

module.exports = Object.freeze({
  CORPUS_NAME,
  CORPUS_SUFFIX,
  EXCLUSION,
  FLAGS,
  OPTIONAL_FLAGS,
  REQUIRED_FLAGS,
  collisionKey,
  main,
  normalizeContract,
  parseCliArgs,
  planBatch,
  summaryLines
});

#!/usr/bin/env node

// Ratchet gate over the whole discovered test tree.
//
// WHY THIS EXISTS, and why it is deliberately NOT a plain "must be green" gate.
//
// This suite has never been green. Measured 2026-08-11: the full tree is 734
// candidate test files, of which tools/test-census.js reports 527 reachable and
// the rest orphaned, and the last full recorded run was 666 pass / 12 fail /
// 5 timeout over 58 minutes. A gate that demands zero failures on a tree in
// that state is bypassed or deleted within a day, and a bypassed gate is worse
// than no gate because it still reads as protection.
//
// The concrete harm of a permanently-red suite is not the red. It is that a
// lane CANNOT TELL ITS OWN BREAKAGE FROM INHERITED RED. Seventeen failures
// before your change and seventeen after is indistinguishable from seventeen
// before and a different seventeen after. So this ratchets against a committed
// baseline of failures BY NAME:
//
//   - a failure NOT in the baseline is a regression          -> block (exit 1)
//   - a baselined failure that now passes is an improvement  -> block (exit 1),
//     and say "lower the baseline", because a ratchet that silently absorbs
//     improvement stops ratcheting inside a month
//   - measurement that cannot be trusted                     -> refuse (exit 2)
//   - anything else                                          -> pass  (exit 0)
//
// By NAME and not by count, deliberately: a count alone lets a newly broken
// test hide behind a newly fixed one. Seventeen and seventeen is not evidence.
//
// WHY IT BASELINES BY FILE PATH AND NOT BY TEST TITLE
// --------------------------------------------------
// The sibling implementation in the packaged-app tree parses TAP and baselines
// by top-level test title, because that tree's runner is `node --test`. This
// tree's runner is tests/run-isolated.js, which spawns one child process per
// FILE and reports a per-file status. The file path is the stable identity
// here: test titles inside these files are prose that gets reworded, whereas a
// path change is a rename that shows up in review. It also means this gate
// keeps working while other lanes restructure the npm chain underneath it.
//
// WHY IT DOES NOT SPAWN `npm test`
// --------------------------------
// The sibling ratchet spawns `npm test` so the runner and the gate cannot
// drift. That is the right call in that tree and the WRONG call here, because
// in this tree `npm test` currently measures NOTHING. `pretest` exits non-zero
// when a repository gate is red, and npm does not execute the `test` body when a
// pretest fails -- verified mechanically 2026-08-11 with a throwaway package:
// a failing pretest yields exit 1 having run NO part of `test` and NO part of
// `posttest`. So "npm test failed" in this tree does not mean "tests are red",
// it means "zero test files ran". A ratchet fronted by that lifecycle would
// inherit the same blindness and would report a clean baseline for an empty
// measurement.
//
// So this drives tools/test-run.js --all directly. That tool runs
// `[...census.reachable, ...census.orphaned]` -- every CANDIDATE test file,
// including the orphaned ones that no npm script reaches -- batches them, and
// writes a per-file record. It is the widest measurement in this repo.
//
// IT IS NOT, HOWEVER, THE ENTIRE TREE, AND THIS COMMENT USED TO SAY IT WAS.
// tools/test-census.js excludes package runners, helpers, workers, fixtures and
// anything it cannot read as a suite; measured 2026-08-25, that was 71 of 856
// files under tests/. Excluding them is right -- a package runner run as a suite
// runs its whole package a second time. Believing they were included was not:
// three of the 71 were real assertion suites that matched the census's `run-`
// PREFIX rule rather than any actual runner name, and nothing anywhere named
// them, so "we ran less than the whole tree" was indistinguishable from "the
// whole tree passed". The census now reports `excluded` as a NAMED list with a
// reason per file, tools/test-run.js copies it into every run record as
// `excludedFromMeasurement` and prints the shortfall beside the pass count, and
// tests/test-census.test.js pins all of that. Read the census's own report
// before describing a run here as complete.
//
// --output is passed a scratch directory ON PURPOSE. tools/test-run.js writes
// state/test-runs/latest.json by default, and other lanes poll that file as
// authoritative; a gate run must never overwrite it.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// CommonJS module: `module.exports = Object.freeze({...})` is not statically
// analysable by cjs-module-lexer, so a NAMED import throws SyntaxError at load.
// Default-import then destructure. (Measured: the named form fails outright.)
import subscriptionLaunchEnv from "../src/lib/providers/subscription-launch-env.js";
import testCompletion from "./lib/test-completion.js";
import lifecycleRecords from "./lib/strict-lifecycle-record.js";

const { safeLaunchEnvironment } = subscriptionLaunchEnv;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const BASELINE_PATH = path.join(HERE, "test-baseline.json");

const EXIT_PASS = 0;
const EXIT_RATCHET = 1;
const EXIT_BROKEN_MEASUREMENT = 2;

// run-isolated/test-run vocabulary, in three groups: 'pass', the failure
// statuses (fail, timeout, config-mutation), and 'skip' -- see SKIP_STATUS
// below for why the third is not folded into the second. These two are a
// FOURTH thing again: they mean "we never got a verdict" rather than "we got a
// bad verdict", so they invalidate the MEASUREMENT rather than counting as
// failures. Treating an absence as a failure would let a run that measured
// nothing produce a baseline full of fake entries; treating it as a pass is
// worse.
const ABSENCE_STATUSES = new Set(["not-run", "no-record"]);

// A SKIP IS A THIRD THING, and collapsing it into either of the other two is a
// lie in a different direction each way.
//
// tests/run-isolated.js reports `skip` for a suite behind an opt-in environment
// gate -- today the two Windows Task Scheduler mutation smoke tests, which
// create and delete real Scheduled Tasks and refuse to do that without an
// explicit env var. Nobody sets that var on an ordinary run, so those two files
// report `skip` on EVERY run there has ever been.
//
// This gate treated "not exactly pass" as failure, which made those two
// permanent failures. The consequence was not cosmetic: `--ship` refuses while
// any failure stands, so `npm run test:ratchet:ship` could NEVER print SHIP OK,
// no matter how green the tree got. A release gate whose success state is
// unreachable is not a strict gate; it is a gate that will be bypassed, and
// then nothing is checked at all.
//
// Counting a skip as a PASS would be the opposite error and a worse one -- a
// file that never ran would become evidence that it works. So skips are their
// own category throughout: excluded from `failures`, counted and listed
// separately in every verdict including SHIP OK, and still fully ratcheted --
//   * a skip whose baseline entry also says `skip` is expected: reported, no block
//   * a skip that is NOT in the baseline, or is in it with any other status, is
//     a file the baseline says should RUN, so it is a REGRESSION and blocks
//   * a baselined `skip` that now passes is an improvement and blocks until the
//     baseline comes down, exactly like any other fixed entry
// The only thing that changed is that a suite honestly declaring it did not run
// stops being counted as a suite that ran and failed.
const SKIP_STATUS = "skip";

function runMeasurement(outputDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, "tools", "test-run.js"), "--all", "--output", outputDirectory],
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
        // node is a GENERAL INTERPRETER and therefore never exempt: this child
        // is the whole test suite, which spawns provider CLIs of its own.
        env: safeLaunchEnvironment(process.env, { context: "test-ratchet measurement run" }),
      },
    );
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) {
    throw new Error(
      `no baseline at ${path.relative(REPO_ROOT, baselinePath)}. ` +
        "Create one with `node tools/test-ratchet.mjs --update`, and COMMIT it, " +
        "so the failures it records are visible in review rather than implied.",
    );
  }
  const parsed = JSON.parse(await readFile(baselinePath, "utf8"));
  if (!Array.isArray(parsed.knownFailures)) {
    throw new Error(`${path.relative(REPO_ROOT, baselinePath)} has no knownFailures array`);
  }
  return parsed;
}

/**
 * Read a run record and refuse to rule on anything this gate cannot trust.
 *
 * Every check here is a way a run can LOOK green while having measured less
 * than it claims, and each one has been observed in this repo's own history --
 * see the comments in tools/test-run.js for the 2026-08-09 vanishing-denominator
 * run and the 2026-08-10 runs killed at batch 70 of 73 that wrote nothing.
 */
function validateRun(run, sourceLabel, maxAgeHours = null) {
  const problems = [];
  if (!run || typeof run !== "object") {
    return { problems: [`${sourceLabel} is not a JSON object`] };
  }

  // FRESHNESS. Only checked when the caller asked for it, because a lane
  // ruling on a record it just produced does not need it -- but the cheap
  // gate wired into `npm test` DOES: it rules on whatever
  // state/test-runs/latest.json happens to hold, and without this a record
  // from last week would certify today's tree. That is a stale measurement
  // read as a current verdict, which is the same absence-as-consent shape as
  // every other refusal in this function.
  if (maxAgeHours != null) {
    const stamp = typeof run.generatedAt === "string" ? Date.parse(run.generatedAt) : Number.NaN;
    if (!Number.isFinite(stamp)) {
      // Missing is NOT fresh. A record that cannot say when it was measured
      // must never be treated as if it were measured just now.
      problems.push(
        `the run record has no usable generatedAt timestamp (${JSON.stringify(run.generatedAt ?? null)}), ` +
          "so its age cannot be established and it cannot be called fresh",
      );
    } else {
      const ageHours = (Date.now() - stamp) / 3_600_000;
      if (ageHours > maxAgeHours) {
        problems.push(
          `the run was measured ${ageHours.toFixed(1)}h ago, older than the ${maxAgeHours}h freshness window. ` +
            "Re-measure; a stale record describes a tree that no longer exists.",
        );
      } else if (ageHours < -0.25) {
        // A record from the future is a clock problem or a hand-edited file.
        // Either way the timestamp is not evidence of anything.
        problems.push(
          `the run record is dated ${Math.abs(ageHours).toFixed(1)}h in the FUTURE, so its timestamp cannot be trusted`,
        );
      }
    }
  }
  const files = Array.isArray(run.files) ? run.files : null;
  if (!files) return { problems: [`${sourceLabel} has no files array`] };

  if (files.length === 0) {
    problems.push("the run measured ZERO test files; a green reading here means the suite vanished, not that it passed");
  }
  // `!== true`, deliberately not `=== false`. Found 2026-08-11 while ruling on
  // a real record: state/test-runs/latest.json from 02:57Z carries NO `complete`
  // field at all (it predates the partial-snapshot fix in tools/test-run.js),
  // and `=== false` waved it straight through as a finished run. A record that
  // does not say whether it finished has not said it finished. Same shape as
  // every other absence in this file: unknown is not yes.
  if (run.complete !== true) {
    const stated = run.complete === false
      ? `a partial snapshot (${run.completedBatches}/${run.totalBatches} batches complete)`
      : `not marked complete (complete=${JSON.stringify(run.complete ?? null)})`;
    problems.push(
      `the run is ${stated}. Its failure list may be a prefix of the truth rather than the truth.`,
    );
  }
  const totals = run.totals;
  const totalFields = {
    requested: null,
    total: null,
    passed: "pass",
    failed: "fail",
    timedOut: "timeout",
    configMutation: "config-mutation",
    notRun: "not-run",
    noRecord: "no-record",
    skipped: "skip",
    other: null,
  };
  if (!totals || typeof totals !== "object" || Array.isArray(totals)) {
    problems.push("the run record has no usable totals object, so its reported counts cannot be established");
  } else {
    for (const field of Object.keys(totalFields)) {
      if (!Number.isInteger(totals[field]) || totals[field] < 0) {
        problems.push(`the run record has no usable totals.${field} count (${JSON.stringify(totals[field] ?? null)})`);
      }
    }
  }
  if (Number.isInteger(totals?.requested) && totals.requested !== files.length) {
    problems.push(
      `the run requested ${totals.requested} files but recorded ${files.length}; ` +
        "files left the numerator and the denominator together, which is invisible in a ratio",
    );
  }

  // Recount from the raw records rather than trusting the totals block, and
  // refuse if the two readings disagree. Two independent counts of the same
  // thing is the cheapest guard against a summariser bug, and this repo has
  // already shipped one (11 config-mutation records once sat in the total and
  // in no category, and the run still exited 0).
  const recounted = new Map();
  for (const entry of files) {
    const status = entry && typeof entry.status === "string" ? entry.status : "(missing status)";
    recounted.set(status, (recounted.get(status) || 0) + 1);
  }
  if (totals && typeof totals === "object") {
    const knownStatuses = new Set(Object.values(totalFields).filter(Boolean));
    const recountedOther = files.filter((entry) => !knownStatuses.has(entry?.status)).length;
    const expectedCounts = {
      total: files.length,
      ...Object.fromEntries(
        Object.entries(totalFields)
          .filter(([, status]) => status)
          .map(([field, status]) => [field, recounted.get(status) || 0]),
      ),
      other: recountedOther,
    };
    for (const [field, count] of Object.entries(expectedCounts)) {
      if (Number.isInteger(totals[field]) && totals[field] !== count) {
        problems.push(
          `the run disagrees with itself: totals.${field}=${totals[field]} but the file records recount to ${count}`,
        );
      }
    }
    if (recountedOther > 0) {
      problems.push(
        `${recountedOther} file record(s) have an unknown or missing status; they cannot be called failures or passes`,
      );
    }
  }

  const absences = files.filter((entry) => entry && ABSENCE_STATUSES.has(entry.status));
  if (absences.length > 0) {
    problems.push(
      `${absences.length} file(s) were requested and never reported a verdict ` +
        `(${absences.slice(0, 5).map((entry) => entry.file).join(", ")}${absences.length > 5 ? ", ..." : ""}). ` +
        "An absence is not a pass and not a failure, so this gate cannot rule.",
    );
  }

  return { problems, recounted, files };
}

function sortByFile(entries) {
  return entries.sort((left, right) => left.file.localeCompare(right.file));
}

// Everything that is not a pass, split into the two kinds. `notPassing` is the
// union and is what the improvement check must read: a file that skipped did
// not start passing, and reporting it as FIXED would tell an operator to lower
// a baseline entry that is still earning its place.
function partitionNonPassing(files) {
  const failures = [];
  const skips = [];
  for (const entry of files) {
    if (!entry || entry.status === "pass") continue;
    const record = { file: entry.file, status: entry.status, reason: entry.reason };
    (entry.status === SKIP_STATUS ? skips : failures).push(record);
  }
  return { failures: sortByFile(failures), skips: sortByFile(skips), notPassing: sortByFile([...failures, ...skips]) };
}

async function writeBaseline(baselinePath, baseline, failures, notesByFile) {
  const next = {
    ...baseline,
    $comment: baseline.$comment ?? [
      "Known-failing test files, by path. Maintained by tools/test-ratchet.mjs.",
      "A failure NOT listed here is a regression and blocks. A file listed here",
      "that now passes also blocks, with 'lower the baseline' -- a ratchet that",
      "silently absorbs improvement stops ratcheting.",
      "NEVER add an entry to make a red run go green without saying why in the",
      "note. The note is the only thing standing between this file and a",
      "quarantine list.",
    ],
    knownFailures: failures.map((entry) => ({
      file: entry.file,
      status: entry.status,
      note: notesByFile.get(entry.file) ?? "",
    })),
    updated: new Date().toISOString(),
  };
  await writeFile(baselinePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function report(label, entries, notesByFile) {
  console.log(`\n${label}`);
  for (const entry of entries) {
    const status = entry.status ? ` [${entry.status}]` : "";
    console.log(`  - ${entry.file}${status}`);
    const note = notesByFile.get(entry.file);
    if (note) console.log(`      note: ${note}`);
  }
}

function parseArguments(argv) {
  const options = { update: false, ship: false, strict: testCompletion.strictRequested(), fromSummary: null, baselinePath: BASELINE_PATH, maxAgeHours: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--update") options.update = true;
    else if (argument === "--ship") options.ship = true;
    else if (argument === "--max-age-hours") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--max-age-hours requires a positive number of hours");
      options.maxAgeHours = value;
      index += 1;
    } else if (argument === "--from-summary") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--from-summary requires a path");
      options.fromSummary = path.resolve(REPO_ROOT, value);
      index += 1;
    } else if (argument === "--baseline") {
      // A FLAG and deliberately not an environment variable. This gate can be
      // neutered by pointing it at a baseline that already lists every failure,
      // so the choice of baseline must be visible in the command line that a
      // reviewer and tools/invocation-graph.js both read. An env var would make
      // that same substitution invisible. It grants no new authority -- anyone
      // who can pass this flag can already edit the default baseline file --
      // but it keeps the substitution on the record. Its real use is the gate's
      // own tests, which must be able to rule against fixture baselines.
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--baseline requires a path");
      options.baselinePath = path.resolve(REPO_ROOT, value);
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.update && options.ship) {
    // --ship asks "may this tree be released"; --update asks "record whatever
    // the tree does today". Answering both at once would let a release run
    // rewrite the very baseline it is being judged against.
    throw new Error("--update and --ship are mutually exclusive");
  }
  if (options.strict && options.update) throw new Error('strict lifecycle forbids baseline updates');
  if (options.strict && !options.fromSummary) throw new Error('strict lifecycle requires the declared --from-summary input; it will not launch a census run');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.strict) {
    // The ordinary ratchet below still compares an explicitly selected legacy
    // census record. Strict uses ONLY receipts from this actual npm lifecycle;
    // the package's legacy summary argument grants no substitute authority.
    const context = lifecycleRecords.readContext();
    lifecycleRecords.assertInvocation(context, 'verifier', ['node', 'tools/test-ratchet.mjs', ...process.argv.slice(2)]);
    const evidence = lifecycleRecords.verify(context);
    console.log(`Strict mandatory evidence complete: ${evidence.mandatoryFileOccurrences} selected file occurrences; actual npm terminal confirmation remains pending.`);
    return EXIT_PASS;
  }
  // --update may deliberately create a baseline that does not exist yet, but
  // it must not turn an unreadable or malformed EXISTING baseline into an
  // empty one. The former is an explicit bootstrap; the latter used to swallow
  // the read/parse failure and overwrite evidence with this run's answer.
  const baseline = options.update && !existsSync(options.baselinePath)
    ? { knownFailures: [] }
    : await readBaseline(options.baselinePath);
  const notesByFile = new Map(baseline.knownFailures.map((entry) => [entry.file, entry.note ?? ""]));

  // --- measure ------------------------------------------------------------

  let runPath;
  if (options.fromSummary) {
    // Reusing an already-measured run. Offered because a full measurement is
    // ~58 minutes, so a release tier that has just run the suite should be able
    // to ask this gate for a verdict without paying for it twice.
    runPath = options.fromSummary;
    if (!existsSync(runPath)) {
      // Say what to DO. A gate whose failure message is a bare path sends the
      // reader looking for a bug in the gate instead of running the one command
      // that produces the record it is asking for.
      throw new Error(
        `--from-summary path does not exist: ${runPath}\n` +
          "  Nothing has been measured. Produce a run record first with `npm run test:all`\n" +
          "  (node tools/test-run.js --all), which writes state/test-runs/latest.json.",
      );
    }
    console.log(`Test ratchet: ruling on the existing run record at ${runPath}`);
  } else {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "test-ratchet-"));
    console.log(`Test ratchet: running \`node tools/test-run.js --all\` (this measures the WHOLE tree and takes tens of minutes) ...`);
    console.log(`  run records -> ${outputDirectory}  (state/test-runs/latest.json is deliberately NOT touched)`);
    const { code, signal } = await runMeasurement(outputDirectory);
    runPath = path.join(outputDirectory, "latest.json");
    if (!existsSync(runPath)) {
      throw new Error(
        `tools/test-run.js produced no run record at ${runPath} ` +
          `(exit ${code}${signal ? `, signal ${signal}` : ""}). Nothing was measured.`,
      );
    }
    // The measurement tool's own exit code is NOT the verdict -- it is non-zero
    // whenever any test failed, which is the normal state of this tree and the
    // entire reason this gate exists. It is recorded, not obeyed.
    console.log(`Measurement finished (tools/test-run.js exit ${code}${signal ? `, signal ${signal}` : ""}).`);
  }

  const run = JSON.parse(await readFile(runPath, "utf8"));
  const { problems, files } = validateRun(run, path.relative(REPO_ROOT, runPath) || runPath, options.maxAgeHours);
  if (problems.length > 0) {
    throw new Error(`the run record cannot be trusted:\n  - ${problems.join("\n  - ")}`);
  }

  const { failures, skips, notPassing } = partitionNonPassing(files);
  const totals = run.totals || {};
  console.log(
    `\nMeasured ${files.length} test files: ${totals.passed ?? "?"} pass, ${failures.length} failing ` +
      `(${totals.failed ?? 0} fail, ${totals.timedOut ?? 0} timeout, ${totals.configMutation ?? 0} config-mutation), ` +
      `${skips.length} skipped (did not run; counted separately, never as a pass).`,
  );
  // --- the ratchet --------------------------------------------------------

  const baselineByFile = new Map(baseline.knownFailures.map((entry) => [entry.file, entry]));
  const actualByFile = new Map(notPassing.map((entry) => [entry.file, entry]));

  // A skip is a regression unless the baseline ALSO says skip. Two shapes reach
  // here: a file that used to run and now silently does not (its baseline entry
  // says fail/timeout, or it is absent because it used to pass), and a genuinely
  // new opt-in-gated suite. Both are "the baseline says this should run and it
  // did not", which is coverage quietly leaving the tree -- exactly the thing a
  // ratchet exists to make visible.
  const regressions = notPassing.filter((entry) => {
    const known = baselineByFile.get(entry.file);
    if (!known) return true;
    return entry.status === SKIP_STATUS && known.status !== SKIP_STATUS;
  });
  const improvements = baseline.knownFailures
    .filter((entry) => !actualByFile.has(entry.file))
    .map((entry) => ({ file: entry.file, status: entry.status }));
  // A baselined file that changed HOW it fails. Reported always, because
  // fail -> timeout is a different defect wearing the same name; blocking only
  // under --ship because timeouts genuinely do move with machine load and a
  // per-commit gate that cries wolf gets ignored.
  const regressionFiles = new Set(regressions.map((entry) => entry.file));
  const drift = notPassing.filter((entry) => {
    // Already named as a regression above (a skip the baseline says should run).
    // Reporting it twice under two labels reads as two problems.
    if (regressionFiles.has(entry.file)) return false;
    const known = baselineByFile.get(entry.file);
    return known && known.status && known.status !== entry.status;
  }).map((entry) => ({ file: entry.file, status: `${baselineByFile.get(entry.file).status} -> ${entry.status}` }));

  if (options.update) {
    // notPassing, not failures: an expected skip must stay ON the baseline, or
    // the next run sees an unbaselined skip and calls it a regression.
    await writeBaseline(options.baselinePath, baseline, notPassing, notesByFile);
    console.log(
      `\nBaseline UPDATED: ${notPassing.length} known non-passing file(s) ` +
        `(${failures.length} failing, ${skips.length} skipped) written to ` +
        // The path actually written, not the default. Reporting the default
        // here while --baseline sent the bytes elsewhere is a small lie that
        // sends the next reader to inspect an unchanged file.
        `${path.relative(REPO_ROOT, options.baselinePath)}.`,
    );
    console.log("Commit that file so the change is visible in review, and write a note on every entry you added.");
    return EXIT_PASS;
  }

  let verdict = EXIT_PASS;

  if (regressions.length > 0) {
    report(`REGRESSION -- ${regressions.length} non-passing file(s) the baseline does not account for:`, regressions, notesByFile);
    const skippedRegressions = regressions.filter((entry) => entry.status === SKIP_STATUS);
    if (skippedRegressions.length > 0) {
      console.log(
        `\n${skippedRegressions.length} of these SKIPPED rather than failed. A file that the baseline says should ` +
          "run and did not is coverage leaving the tree silently, which is why it blocks like any other regression.",
      );
    }
    console.log(
      "\nThese are new. Fix them; or if you are deliberately accepting them, run " +
        "`node tools/test-ratchet.mjs --update` and commit the raised baseline with a note, so someone sees you do it.",
    );
    verdict = EXIT_RATCHET;
  }

  // Reported on EVERY run, blocking or not, and never folded into the pass
  // line. The two Windows scheduler mutation suites skip on every ordinary run,
  // so if this gate stopped saying so, "the tree is green" would quietly come
  // to mean "the tree is green except for the part nobody has run in months".
  const expectedSkips = skips.filter((entry) => !regressionFiles.has(entry.file));
  if (expectedSkips.length > 0) {
    report(
      `SKIPPED -- ${expectedSkips.length} file(s) did not run and are recorded as skips in the baseline ` +
        "(NOT counted as passes, NOT counted as failures):",
      expectedSkips,
      notesByFile,
    );
    for (const entry of expectedSkips) {
      if (entry.reason) console.log(`      why: ${entry.reason}`);
    }
  }

  if (improvements.length > 0) {
    report(`FIXED -- ${improvements.length} baselined file(s) now pass:`, improvements, notesByFile);
    console.log(
      "\nGood news, but the baseline must come down or the ratchet stops ratcheting. " +
        "Run `node tools/test-ratchet.mjs --update` and commit the lower baseline.",
    );
    console.log("If any entry carries an environment note, read it first -- it may have flipped because the environment changed rather than because anyone fixed it.");
    verdict = EXIT_RATCHET;
  }

  if (drift.length > 0) {
    report(`STATUS DRIFT -- ${drift.length} baselined file(s) fail differently now:`, drift, notesByFile);
    if (options.ship) {
      console.log("\nUnder --ship this blocks: a file that changed how it fails has changed, and the baseline no longer describes it.");
      verdict = EXIT_RATCHET;
    } else {
      console.log("\nReported, not blocking, outside --ship. Timeouts move with machine load.");
    }
  }

  if (verdict === EXIT_PASS && !options.ship) {
    console.log(
      `\nRatchet OK: all ${failures.length} failing file(s) are known, ${expectedSkips.length} file(s) skipped as ` +
        "recorded, and none were fixed without the baseline coming down.",
    );
  }

  // --- the ship gate ------------------------------------------------------
  //
  // Permissive by default, strict when something is actually being shipped.
  // The default verdict above answers "did YOU break something", which is what
  // a lane needs on every change. --ship answers a different question: "is this
  // tree fit to leave the machine", and the answer cannot be yes while any test
  // in it is known to fail. A known failure is still a failure; the baseline
  // records that we know about it, not that it is acceptable.
  //
  // It reads `failures`, not `notPassing`: an expected, baselined skip is a
  // suite that declared it did not run, not one that ran and failed, and
  // holding a release for it made SHIP OK unreachable forever (see SKIP_STATUS
  // above). It is still printed here, every time, so nobody reads SHIP OK as
  // "everything ran". An UNEXPECTED skip does not reach this branch at all --
  // it is a regression, and the regression check above has already blocked.
  if (options.ship) {
    if (failures.length > 0) {
      console.log(
        `\nSHIP REFUSED: ${failures.length} test file(s) are failing. ` +
          `${regressions.length} are new; ${failures.length - regressions.length} are on the baseline.`,
      );
      console.log("A baselined failure is a failure that is KNOWN, not one that is allowed. The baseline must reach zero to cut a release.");
      report("Still failing:", failures, notesByFile);
      verdict = EXIT_RATCHET;
    } else if (verdict === EXIT_RATCHET) {
      // Zero failures measured, but the ratchet is already blocking -- the only
      // way to reach here is a baseline that still names files which now pass.
      // Saying "SHIP OK" alone would be a lie by omission: the tree is clean
      // and the RECORD of it is stale, and the record is what a release is
      // judged against later.
      console.log(
        `\nSHIP BLOCKED: the measured tree has zero failing test files, but the ratchet is blocking -- the ` +
          `baseline names ${baseline.knownFailures.length} entr(ies) and the tree no longer matches it ` +
          `(${improvements.length} now pass, ${regressions.length} unaccounted, ${drift.length} changed status). ` +
          "Lower or correct the baseline and re-run; a release must not be cut against a baseline that no " +
          "longer describes the tree.",
      );
    } else if (expectedSkips.length > 0) {
      // SHIP OK, but never bare. The release is being cut over files that were
      // NOT measured, and the reader of this line is the person who has to know
      // that. Naming them is the whole difference between an honest pass and a
      // green light that quietly covers unrun coverage.
      console.log(
        `\nSHIP OK: the measured tree has zero failing test files. ` +
          `${expectedSkips.length} file(s) did NOT run -- they are opt-in gated and recorded as skips in the ` +
          "baseline, so this release is being cut WITHOUT their coverage:",
      );
      for (const entry of expectedSkips) {
        console.log(`  - ${entry.file}${entry.reason ? ` -- ${entry.reason}` : ""}`);
      }
    } else {
      console.log("\nSHIP OK: the measured tree has zero failing test files, nothing was skipped, and the baseline is empty.");
    }
  }

  return verdict;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`\nTest ratchet could not measure the suite: ${error.message}`);
    // Distinct from the ratchet verdict on purpose. "I could not measure" must
    // never be reported with the same code as "I measured and it was fine",
    // and must never be zero -- an UNKNOWN that exits 0 is the exact shape this
    // whole effort exists to remove.
    process.exitCode = EXIT_BROKEN_MEASUREMENT;
  });

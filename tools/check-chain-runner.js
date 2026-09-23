#!/usr/bin/env node
'use strict';

/**
 * Aggregating runner for a list of check steps.
 *
 * WHY THIS EXISTS
 * ---------------
 * `pretest` was nine `&&`-joined steps. `&&` short-circuits: the first failing
 * step silently prevents every later step from running, and the suite still
 * reports a single failure. A chain of N checks joined by `&&` is really a
 * promise to run only the checks up to the first failure -- the rest are
 * unverified, and nothing in the output says so. Measured on 2026-08-08: step 2
 * (tools/invocation-guard.js) was failing in committed HEAD, so steps 3-9 --
 * including the claude credential fence and both agent-engine steps -- were not
 * running at all. They were not passing; they were absent.
 *
 * This runner replaces the short-circuit with aggregation:
 *   1. Every step RUNS, even after an earlier step failed.
 *   2. The exit code is non-zero if ANY step failed or was skipped.
 *   3. The summary names exactly WHICH steps failed, so aggregation does not
 *      trade "later steps are invisible" for "which step failed is invisible".
 *
 * NOT SOLVED BY REORDERING. Promoting the most important check to the front
 * only moves the shadow onto whatever is now last.
 *
 * WHY THE STEPS STAY IN package.json
 * ----------------------------------
 * The obvious design is a chain-definition module this runner imports. Do not
 * do that. tools/invocation-graph.js proves reachability by parsing the command
 * lines of npm scripts, and in JavaScript it counts a path string ONLY inside a
 * spawn/exec span or a resolved require() -- deliberately, because prose in a
 * string literal once made an unwired registrar look wired. Step paths sitting
 * in an array literal in some chains.js are invisible to it. Moving the list
 * out of package.json was tried first and made tools/invocation-guard.js,
 * tools/ledger-truth.js and six test files report as
 * having NO invocation path -- it blinded the guard that exists to catch code
 * that never runs. So the steps stay on the npm command line, where the guard
 * can see them, and this runner takes them as argv.
 *
 * USAGE
 *   node tools/check-chain-runner.js --name <label> --then <cmd...> --then <cmd...>
 *
 * Steps are separated by the literal token `--then`. Nothing is quoted, so
 * every step path stays a bare token on the npm command line. A step whose own
 * arguments need to contain the literal string `--then` is not expressible;
 * none do.
 *
 * Optional per-step flags, placed immediately after `--then`:
 *   --id <name>      override the auto-derived step id shown in the summary
 *   --needs <id>     declare a genuine prerequisite (see GATES below)
 *   --why <text...>  why that prerequisite is real; required with --needs
 *
 * GATES
 * -----
 * A step may declare `--needs <earlier id>` ONLY if a failure of that earlier
 * step would make this step report a confusing downstream symptom instead of
 * the real cause -- typically because the earlier step produces an artifact
 * this one consumes. Such a step is SKIPPED (never "passed") when its
 * prerequisite failed; the skip is named in the summary and counts as a
 * non-zero outcome. Skipping is scoped to declared dependents only, so a failed
 * prerequisite never silences an unrelated check.
 *
 * Every `--needs` must carry a `--why`; the runner refuses a chain where one
 * does not. If you cannot name the artifact or state that flows between two
 * steps, they are not in a prerequisite relationship -- they were merely
 * adjacent in a chain someone appended to. Leave them independent so both run.
 *
 * PREREQUISITE AUDIT (2026-08-08): all nine pretest steps were examined. NONE
 * is a genuine prerequisite for any later step -- no step writes a file, lock,
 * manifest, fixture or process that a later step reads. The chain was
 * sequential by habit. That is why no step in package.json declares --needs.
 *
 * THE RATCHET (2026-08-11)
 * ------------------------
 * Aggregation fixed "later steps are invisible". It did not fix the second
 * blindness, which is what actually let ~15 defects ship: the chain has been
 * red for months, so its exit code carries no information. N failing steps
 * before your change and N after -- or a DIFFERENT N after -- are the same
 * single non-zero byte. Worse, `pretest` is one of these chains, and npm skips
 * the entire `test` body when `pretest` exits non-zero. Measured 2026-08-11 in
 * this tree: a red pretest means ZERO test files run. "The suite is failing"
 * and "the suite did not execute" were indistinguishable, and the second was
 * the truth.
 *
 * So a chain may carry a BASELINE of known-failing step ids
 * (tools/check-chain-baseline.json, `--baseline <path>` to override):
 *
 *   - a failing step NOT in the baseline           -> REGRESSION, exit 1
 *   - a baselined step that now passes             -> exit 1, "lower the baseline"
 *   - a baseline id that is not a step of the chain-> exit 1, stale immunity
 *   - every failure baselined                      -> exit 0, printed LOUDLY
 *   - a run-isolated link whose only non-passes
 *     are DECLARED PLATFORM SKIPS                 -> a third outcome: named
 *     with its count and skipped file names, and counted as neither a pass
 *     nor a regression. See isolatedSummaryProbe below for why the child's
 *     exit code alone cannot express this, and why it is off under --strict.
 *   - a baseline that cannot be trusted            -> exit 2, rules on nothing
 *
 * By step ID, never by count: a count lets a newly broken step hide behind a
 * newly fixed one.
 *
 * ABSENCE IS NOT CONSENT, and this is the part to preserve if this file is ever
 * rewritten. Every missing thing means STRICT, never "tolerate":
 *   - no --baseline flag and no default baseline file  -> strict
 *   - a baseline file with no entry for THIS chain     -> strict for this chain
 *   - an entry with no id, or an id that is not a
 *     non-empty string, or an entry with no note       -> exit 2, not "wildcard"
 * An empty `steps` array for a chain is a POSITIVE statement ("this chain is
 * expected clean") and is honoured as such; a chain key that is simply absent
 * is not a statement at all and gets no tolerance. Those two must never be
 * collapsed: collapsing them is how a truncated or half-written baseline would
 * come to mean "everything is allowed".
 *
 * `--strict` forces zero tolerance regardless of the baseline. Use it on any
 * path that decides whether something leaves the machine; a baselined failure
 * is a failure that is KNOWN, not one that is acceptable.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { STRICT_ENV, strictRequested, validateCompletion } = require('./lib/test-completion');
const lifecycleRecords = require('./lib/strict-lifecycle-record');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASELINE_PATH = path.join(__dirname, 'check-chain-baseline.json');

const EXIT_OK = 0;
const EXIT_RATCHET = 1;
// Distinct from EXIT_RATCHET on purpose: "I cannot rule" must never be reported
// with the same code as "I ruled and it was fine", and must never be 0.
const EXIT_UNTRUSTED = 2;

const STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  SKIP: 'SKIP',
  // A link that ran, whose only non-passing files declared a platform they
  // require and did not get. Four characters so the summary table's columns
  // stay aligned with PASS/FAIL/SKIP; the detail line spells it out in full.
  DECLARED_SKIP: 'DSKP'
};

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '     -';
  return `${(ms / 1000).toFixed(1)}s`.padStart(6);
}

function describe(step) {
  if (step.npm) return `npm run ${step.npm}`;
  return step.run.join(' ');
}

/**
 * Resolve a step to an argv we can spawn.
 *
 * `npm run <script>` steps are spawned through the npm CLI that invoked us
 * (`npm_execpath`), executed by this same node binary. That keeps each npm
 * script definition as the single source of truth rather than duplicating the
 * underlying command here, where it would silently drift.
 */
function resolveCommand(step) {
  if (step.npm) {
    const npmCli = process.env.npm_execpath;
    if (npmCli && /\.[cm]?js$/i.test(npmCli)) {
      return { file: process.execPath, args: [npmCli, 'run', step.npm], shell: false };
    }
    // Fallback for a direct invocation outside npm. `shell: true` is required
    // on Windows: since the CVE-2024-27980 fix node refuses to spawn .cmd shims
    // without a shell. These arguments are fixed tokens from the chain
    // definition, never user input.
    return {
      file: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', step.npm],
      shell: true
    };
  }
  const [file, ...args] = step.run;
  // `node` means THIS node, not whatever a PATH lookup happens to find.
  if (file === 'node') return { file: process.execPath, args, shell: false };
  return { file, args, shell: false };
}

/**
 * Ask a run-isolated step for the per-file record behind its exit code.
 *
 * WHY. tests/run-isolated.js records a platform-gated suite as
 * `status: 'skip'` with a reason and then sets a NON-ZERO exit code on
 * purpose, so that nothing downstream can read its zero "as proof that
 * everything requested actually ran". That is the right call there and the
 * wrong signal here. runStep read ONLY the child exit code, so the pretest link
 * `orphans-wired-0905` -- measured on Linux at 35 passed, 1 declared
 * Windows-only skip, 0 failed -- was reported as a REGRESSION. REGRESSION is a
 * claim that something broke. Nothing broke, and a ratchet that cries
 * regression at a platform boundary teaches its readers to discount it.
 *
 * The exit code cannot carry this: it is one byte, and the thing that must be
 * reported is WHICH files were not run. So use the record run-isolated already
 * knows how to write, through its existing opt-in `--summary` flag.
 *
 * DELIBERATELY NOT ON THE STRICT PATH, for two independent reasons:
 *   - `--strict` asks "may this leave the machine". There a declared skip is
 *     missing coverage, which is exactly what strict must not tolerate, so the
 *     third outcome would be wrong even if it were available.
 *   - under a strict lifecycle recipe it is not available. The child's own
 *     assertInvocation (tools/lib/strict-lifecycle-record.js) compares its real
 *     argv against the recipe built from package.json and throws "actual
 *     invocation differs from strict recipe" on any difference. A flag added
 *     here is not in that recipe. Injecting argv into a strict run is refused
 *     by design, and this respects that rather than working around it.
 */
function isolatedSummaryProbe(step, args, options) {
  const script = String(step.run?.[1] || '').replaceAll('\\', '/');
  if (script !== 'tests/run-isolated.js') return null;
  if (options.strict || options.lifecycle) return null;
  const declared = args.indexOf('--summary');
  if (declared >= 0) {
    // The chain already asked for a record. Read THAT one: passing --summary
    // twice makes run-isolated refuse the whole batch.
    const target = args[declared + 1];
    if (!target || target.startsWith('--')) return null;
    return { path: path.resolve(options.cwd || ROOT, target), args, temporary: false };
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'check-chain-summary-'));
  const target = path.join(directory, 'summary.json');
  return { path: target, directory, args: [...args, '--summary', target], temporary: true };
}

/**
 * Decide whether a non-zero run-isolated batch was NOTHING BUT declared
 * platform skips. Returns null for every other case, and that list is the
 * point of this function -- null means "this stays a failure":
 *
 *   - any file that failed, timed out, never ran, or mutated config
 *   - a skip that names NO platform. An opt-in gate and a missing precondition
 *     are absences somebody chose, not ones the platform forced; tolerating
 *     them here would quietly widen this hole from "cannot run on Linux" to
 *     "did not run, for any reason at all".
 *   - a record with no files, no files array, or one this runner cannot read
 *     or parse
 *
 * ABSENCE IS NOT CONSENT. A record that cannot be read rules on nothing and
 * leaves the child's own exit code standing.
 */
function readDeclaredSkips(summaryPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) return null;
  const skipped = [];
  for (const entry of parsed.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (entry.status === 'pass') continue;
    if (entry.status !== 'skip') return null;
    if (typeof entry.requiresPlatform !== 'string' || entry.requiresPlatform.trim() === '') return null;
    if (typeof entry.file !== 'string' || entry.file.trim() === '') return null;
    skipped.push(entry);
  }
  if (skipped.length === 0) return null;
  return {
    count: skipped.length,
    passed: parsed.files.length - skipped.length,
    files: skipped.map((entry) => entry.file).sort(),
    platforms: [...new Set(skipped.map((entry) => entry.requiresPlatform))].sort()
  };
}

/**
 * One line for the ratchet record: counts and file names only. No verdict
 * words -- whether missing Windows coverage is acceptable is not this runner's
 * to assert, and a reader who can see the names can decide for themselves.
 */
function describeDeclaredSkips(declared) {
  const platforms = declared.platforms.map((platform) => `platform=${platform}`).join(', ');
  return `declared-skip: ${declared.count} files, ${platforms}; ${declared.files.join(', ')}`;
}

function runStep(step, options) {
  const resolved = resolveCommand(step);
  const probe = isolatedSummaryProbe(step, resolved.args, options);
  try {
    return runResolvedStep(step, resolved, probe, options);
  } finally {
    // The record is this runner's scratch, not an artifact of the step.
    if (probe && probe.temporary) fs.rmSync(probe.directory, { recursive: true, force: true });
  }
}

function runResolvedStep(step, resolved, probe, options) {
  const { file, shell } = resolved;
  const args = probe ? probe.args : resolved.args;
  // Aggregators own their individual children; their concatenated TAP is not
  // one test suite. Direct commands must not launder truncated TAP via exit 0.
  const script = String(step.run?.[1] || '').replaceAll('\\', '/');
  const aggregate = step.npm || script === 'tests/run-isolated.js' || script === 'tools/check-chain-runner.js'
    || /^tests\/[^/]+\/run\.js$/.test(script);
  const inspect = options.strict && !aggregate;
  const started = Date.now();
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    ...(inspect ? { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 } : { stdio: 'inherit' }),
    shell,
    windowsHide: true,
    env: options.environment || (options.strict ? { ...process.env, [STRICT_ENV]: '1' } : process.env)
  });
  const durationMs = Date.now() - started;
  let evidence;
  if (inspect) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    try {
      evidence = validateCompletion(result);
      if (evidence.counts) process.stdout.write(`STRICT EVIDENCE: ${step.id}; ${evidence.counts.pass} passed; ${evidence.unexecuted} UNEXECUTED (within-suite skips)\n`);
    } catch (error) {
      return { status: STATUS.FAIL, exitCode: result.status, signal: result.signal, durationMs, detail: `incomplete evidence: ${error.message}` };
    }
  }

  if (result.error) {
    // A step we could not even launch is that step's failure, not a crash of
    // the runner. Throwing here would take the remaining steps down with it --
    // exactly the shadowing this runner exists to remove.
    return { status: STATUS.FAIL, exitCode: null, durationMs, detail: `could not launch: ${result.error.message}` };
  }
  if (result.signal) {
    return { status: STATUS.FAIL, exitCode: null, signal: result.signal, durationMs, detail: `killed by signal ${result.signal}` };
  }
  const code = result.status === null ? 1 : result.status;
  if (code !== 0 && probe) {
    const declared = readDeclaredSkips(probe.path);
    if (declared) {
      return { status: STATUS.DECLARED_SKIP, exitCode: code, evidence, durationMs, declared,
        detail: describeDeclaredSkips(declared) };
    }
  }
  return {
    status: code === 0 ? STATUS.PASS : STATUS.FAIL,
    exitCode: code,
    evidence,
    durationMs,
    detail: code === 0 ? '' : `exit ${code}`
  };
}

function runRecordedStep(step, options) {
  const context = options.lifecycle;
  if (!context) return runStep(step, options);
  const id = `${context.node.id}/step:${encodeURIComponent(step.id)}`;
  const node = context.contract.recipe.nodes.find(entry => entry.id === id);
  if (!node) throw new Error(`undeclared lifecycle step: ${step.id}`);
  const owned = ['npm', 'command', 'verifier'].includes(node.kind);
  const environment = node.kind === 'command' ? lifecycleRecords.clearAuthority()
    : lifecycleRecords.proofEnvironment(context, node.id);
  if (owned) lifecycleRecords.record(context, node, 'start');
  let outcome;
  try {
    outcome = runStep(step, { ...options, environment });
    return outcome;
  } finally {
    if (owned) lifecycleRecords.record(context, node, 'end', { status: outcome?.status === STATUS.PASS ? 'pass' : 'fail',
      exitCode: outcome?.exitCode ?? null, signal: outcome?.signal ?? null, ms: outcome?.durationMs ?? null,
      evidence: outcome?.evidence });
  }
}

/**
 * Run every step, aggregating results.
 * Returns { results, failed, skipped, passed, totalMs, ok }.
 */
function runChain(steps, options = {}) {
  const cwd = options.cwd || ROOT;
  const log = options.log || ((line) => process.stdout.write(`${line}\n`));
  const name = options.name || 'chain';
  const total = steps.length;
  const outcomes = new Map();
  const results = [];
  const chainStarted = Date.now();

  steps.forEach((step, index) => {
    const position = `[${index + 1}/${total}]`;

    const unmet = (step.needs || []).filter((id) => outcomes.get(id) !== STATUS.PASS);
    if (unmet.length > 0) {
      const reason = `prerequisite not met: ${unmet
        .map((id) => `${id} (${outcomes.get(id) || 'not run'})`)
        .join(', ')}`;
      log('');
      log(`=== ${position} ${step.id} -- SKIPPED, ${reason}`);
      if (step.why) log(`    why this is a gate: ${step.why}`);
      outcomes.set(step.id, STATUS.SKIP);
      results.push({ step, status: STATUS.SKIP, durationMs: null, detail: reason });
      return;
    }

    log('');
    log(`=== ${position} ${step.id} -- ${describe(step)}`);
    const outcome = runRecordedStep(step, { cwd, strict: options.strict || strictRequested(), lifecycle: options.lifecycle });
    outcomes.set(step.id, outcome.status);
    results.push({ step, ...outcome });
    const suffix = outcome.detail ? ` (${outcome.detail})` : '';
    log(`--- ${position} ${step.id} ${outcome.status}${suffix} in ${formatDuration(outcome.durationMs).trim()}`);
  });

  const totalMs = Date.now() - chainStarted;
  const failed = results.filter((r) => r.status === STATUS.FAIL);
  const skipped = results.filter((r) => r.status === STATUS.SKIP);
  const declared = results.filter((r) => r.status === STATUS.DECLARED_SKIP);
  const passed = results.filter((r) => r.status === STATUS.PASS);

  const rule = '='.repeat(72);
  log('');
  log(rule);
  log(`check chain "${name}" -- ${total} step${total === 1 ? '' : 's'}`);
  log(rule);
  results.forEach((r, index) => {
    const suffix = r.detail ? `  ${r.detail}` : '';
    log(`  ${String(index + 1).padStart(2)} ${r.status.padEnd(4)} ${formatDuration(r.durationMs)}  ${r.step.id}${suffix}`);
  });
  log('-'.repeat(72));
  // A declared platform skip is not counted into passed: it did not pass. It
  // is reported on its own line, with its own count, so that neither number
  // absorbs the other.
  const declaredSuffix = declared.length === 0 ? ''
    : `, ${declared.length} declared-skip`;
  if (failed.length === 0 && skipped.length === 0) {
    log(`OK: ${passed.length} passed${declaredSuffix} in ${(totalMs / 1000).toFixed(1)}s`);
  } else {
    log(`FAILED: ${failed.length} failed, ${skipped.length} skipped, ${passed.length} passed${declaredSuffix} in ${(totalMs / 1000).toFixed(1)}s`);
    if (failed.length > 0) log(`  failed steps:  ${failed.map((r) => r.step.id).join(', ')}`);
    if (skipped.length > 0) log(`  skipped steps: ${skipped.map((r) => r.step.id).join(', ')}`);
  }
  // Named, never silent: a skip nobody can see is the defect this file exists
  // to remove, and that is as true of a legitimate skip as of a hidden one.
  for (const r of declared) log(`  declared-skip:  ${r.step.id}  ${r.detail}`);
  log(rule);

  return { results, failed, skipped, declared, passed, totalMs, ok: failed.length === 0 && skipped.length === 0 };
}

/**
 * Read the chain baseline, refusing anything this gate cannot trust.
 *
 * Returns { present, knownIds, notes, problems }. `present:false` means STRICT,
 * and is returned for every kind of absence: no file, no `chains` object, or no
 * key for this chain. `problems` is non-empty only for a file that exists and
 * is malformed -- an untrustworthy baseline is a refusal (exit 2), never a
 * quiet fallback to strict, because silently ignoring a corrupted baseline
 * would hide the corruption for as long as the chain happened to be green.
 */
function readChainBaseline(baselinePath, chainName) {
  const empty = { present: false, knownIds: new Set(), notes: new Map(), problems: [], path: baselinePath };
  let raw;
  try {
    raw = fs.readFileSync(baselinePath, 'utf8');
  } catch (error) {
    // existsSync collapses every stat failure to false. In particular, an
    // unreadable path used to look exactly like an intentionally absent
    // baseline, which selected strict mode and could let a green chain exit 0
    // without ever establishing what immunity the baseline granted. Only
    // definite absence means "no baseline"; every other read failure refuses.
    if (error && error.code === 'ENOENT') return empty;
    return { ...empty, problems: [`${baselinePath} could not be read: ${error.message}`] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ...empty, problems: [`${baselinePath} is not valid JSON: ${error.message}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...empty, problems: [`${baselinePath} is not a JSON object`] };
  }
  const chains = parsed.chains;
  if (chains === undefined) return empty;
  if (!chains || typeof chains !== 'object' || Array.isArray(chains)) {
    return { ...empty, problems: [`${baselinePath} has a "chains" field that is not an object`] };
  }
  if (!Object.prototype.hasOwnProperty.call(chains, chainName)) return empty;

  const entry = chains[chainName];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.steps)) {
    return { ...empty, problems: [`${baselinePath} chain "${chainName}" has no steps array`] };
  }

  const problems = [];
  const knownIds = new Set();
  const notes = new Map();
  entry.steps.forEach((step, index) => {
    const where = `${baselinePath} chain "${chainName}" step ${index + 1}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      problems.push(`${where} is not an object`);
      return;
    }
    if (typeof step.id !== 'string' || step.id.trim() === '') {
      // An entry with no usable id cannot match any step, and must not be
      // shrugged off: a reader would see "3 known failures" in the file and a
      // gate that tolerates two of them.
      problems.push(`${where} has no id`);
      return;
    }
    if (typeof step.note !== 'string' || step.note.trim() === '') {
      // The note is the only thing standing between this file and a quarantine
      // list. An entry nobody had to justify is an entry nobody will remove.
      problems.push(`${where} ("${step.id}") has no note saying why it is known-failing`);
      return;
    }
    if (knownIds.has(step.id)) {
      problems.push(`${where} duplicates id "${step.id}"`);
      return;
    }
    knownIds.add(step.id);
    notes.set(step.id, step.note);
  });

  return { present: true, knownIds, notes, problems, path: baselinePath };
}

/**
 * Rule on a completed chain. Pure: takes the run results and a baseline, gives
 * back a verdict and the lines to print. No I/O, so the ruling is testable
 * without spawning a chain.
 */
function rateChain({ chainName, results, baseline, strict }) {
  const lines = [];
  // THE THIRD OUTCOME. A link that ran, whose only non-passing files declared a
  // platform they did not get, is neither a pass nor a regression, so it is
  // held out of notPass and cannot be called REGRESSION. Under --strict it is
  // held out of nothing: there a declared skip is missing coverage, and missing
  // coverage is exactly what a release path must not wave through.
  const declared = strict ? [] : results.filter((entry) => entry.status === STATUS.DECLARED_SKIP);
  const declaredIds = new Set(declared.map((entry) => entry.step.id));
  const notPass = results.filter((entry) => entry.status !== STATUS.PASS && !declaredIds.has(entry.step.id));
  const notPassIds = new Set(notPass.map((entry) => entry.step.id));
  const chainIds = new Set(results.map((entry) => entry.step.id));

  if (baseline.problems.length > 0) {
    lines.push('CHAIN RATCHET: the baseline cannot be trusted, so this chain was not ruled on.');
    for (const problem of baseline.problems) lines.push(`  - ${problem}`);
    lines.push('  Fix the baseline, or delete it to run strict. A gate that cannot read its own record must not pass anything.');
    return { code: EXIT_UNTRUSTED, lines };
  }

  if (declared.length > 0) {
    lines.push(`CHAIN RATCHET: ${declared.length} step(s) recorded a DECLARED PLATFORM SKIP -- the step ran, and these files did not:`);
    for (const entry of declared) lines.push(`  - ${entry.step.id}      ${entry.detail}`);
    lines.push('  Not a pass and not a regression. This coverage is absent on this platform; run it where it applies.');
  }

  if (strict || !baseline.present) {
    if (strict) lines.push('CHAIN RATCHET: --strict, so no failure is tolerated regardless of the baseline.');
    else if (notPass.length > 0) {
      lines.push(`CHAIN RATCHET: no baseline entry for chain "${chainName}", so nothing is tolerated.`);
      lines.push(`  A missing record is not permission. Record the known failures with --update-baseline if they are genuinely inherited.`);
    }
    return { code: notPass.length === 0 ? EXIT_OK : EXIT_RATCHET, lines };
  }

  const regressions = notPass.filter((entry) => !baseline.knownIds.has(entry.step.id));
  // A baselined step that recorded a declared platform skip did NOT start
  // passing, so it is not an improvement and must not trigger "lower the
  // baseline". Its known failure was simply not measured on this platform;
  // discharging the entry on that basis would drop the immunity AND the record
  // of why it was granted, on evidence that never ran.
  const improvements = [...baseline.knownIds]
    .filter((id) => chainIds.has(id) && !notPassIds.has(id) && !declaredIds.has(id));
  const stale = [...baseline.knownIds].filter((id) => !chainIds.has(id));
  const tolerated = notPass.filter((entry) => baseline.knownIds.has(entry.step.id));

  let code = EXIT_OK;

  if (regressions.length > 0) {
    lines.push(`CHAIN RATCHET: REGRESSION -- ${regressions.length} step(s) failed that the baseline does not know about:`);
    for (const entry of regressions) lines.push(`  - ${entry.step.id} (${entry.status})${entry.detail ? `  ${entry.detail}` : ''}`);
    lines.push('  These are new. Fix them, or record them with --update-baseline and a note, so someone sees you do it.');
    code = EXIT_RATCHET;
  }

  if (improvements.length > 0) {
    lines.push(`CHAIN RATCHET: FIXED -- ${improvements.length} baselined step(s) now pass:`);
    for (const id of improvements) lines.push(`  - ${id}      note: ${baseline.notes.get(id)}`);
    lines.push('  Good news, but the baseline must come down or the ratchet stops ratcheting. Re-run with --update-baseline.');
    code = EXIT_RATCHET;
  }

  if (stale.length > 0) {
    // A baseline id that matches no step is immunity granted to nothing --
    // until someone adds a step with that id back, at which point it is
    // immunity granted invisibly.
    lines.push(`CHAIN RATCHET: STALE -- ${stale.length} baselined id(s) are not steps of chain "${chainName}":`);
    for (const id of stale) lines.push(`  - ${id}      note: ${baseline.notes.get(id)}`);
    lines.push('  The step was renamed or removed. Remove the entry so it cannot silently re-arm.');
    code = EXIT_RATCHET;
  }

  if (tolerated.length > 0) {
    lines.push(`CHAIN RATCHET: tolerating ${tolerated.length} KNOWN-FAILING step(s) -- these are broken, not fine:`);
    for (const entry of tolerated) {
      lines.push(`  - ${entry.step.id} (${entry.status})      note: ${baseline.notes.get(entry.step.id)}`);
    }
  }

  const baselinedDeclared = declared.filter((entry) => baseline.knownIds.has(entry.step.id));
  if (baselinedDeclared.length > 0) {
    lines.push(`CHAIN RATCHET: ${baselinedDeclared.length} baselined step(s) declared a platform skip rather than running; their baseline entries stand:`);
    for (const entry of baselinedDeclared) lines.push(`  - ${entry.step.id}      note: ${baseline.notes.get(entry.step.id)}`);
  }

  if (code === EXIT_OK) {
    lines.push(
      tolerated.length === 0 && baselinedDeclared.length === 0
        ? `CHAIN RATCHET OK: chain "${chainName}" is clean and its baseline is empty.`
        : `CHAIN RATCHET OK: no NEW failures in chain "${chainName}". ${tolerated.length + baselinedDeclared.length} known failure(s) remain, ${baselinedDeclared.length} of them unmeasured on this platform; the baseline must reach zero before this tree ships.`
    );
  }

  return { code, lines };
}

function writeChainBaseline(baselinePath, chainName, results) {
  let document = { $comment: undefined, chains: {} };
  if (fs.existsSync(baselinePath)) {
    const existing = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      document = { ...existing, chains: (existing.chains && typeof existing.chains === 'object' && !Array.isArray(existing.chains)) ? { ...existing.chains } : {} };
    }
  }
  document.$comment = document.$comment ?? [
    'Known-failing steps of tools/check-chain-runner.js chains, BY STEP ID.',
    'A failing step that is not listed here is a regression and blocks. A listed',
    'step that now passes also blocks, with "lower the baseline".',
    'A chain that is ABSENT from this file gets no tolerance at all; an empty',
    'steps array is the positive statement "this chain is expected clean".',
    'Every entry needs a note. NEVER add one just to make a red chain go green.'
  ];

  const previousNotes = new Map(
    ((document.chains[chainName] || {}).steps || [])
      .filter((step) => step && typeof step.id === 'string')
      .map((step) => [step.id, typeof step.note === 'string' ? step.note : ''])
  );

  const steps = results
    // A declared platform skip is not a known failure, and recording it as one
    // would hand that step id standing immunity -- which would then cover a
    // REAL failure the first time the skip stops happening.
    .filter((entry) => entry.status !== STATUS.PASS && entry.status !== STATUS.DECLARED_SKIP)
    .map((entry) => ({
      id: entry.step.id,
      status: entry.status,
      note: previousNotes.get(entry.step.id) || `recorded ${new Date().toISOString().slice(0, 10)}: inherited red, cause not yet diagnosed`
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  document.chains[chainName] = { updated: new Date().toISOString(), steps };
  fs.writeFileSync(baselinePath, `${JSON.stringify(document, null, 2)}\n`);
  return steps;
}

// The repo's own source roots, preferred so that `node tests/run-isolated.js
// tests/a.js tests/b.js` is identified by the runner rather than by its first
// argument.
const SCRIPT_TOKEN = /^(?:tools|tests|src|bin|scripts|sidecars|adapters)[\\/][\w./\\-]+\.(?:js|cjs|mjs|ps1|sh)$/;
// Any other path that names something executable. Without this fallback a step
// outside the source roots is labelled "node" in the summary, which identifies
// nothing -- and a summary that cannot name the failing step is the second
// blindness this runner exists to avoid.
const ANY_SCRIPT_TOKEN = /\.(?:js|cjs|mjs|ps1|sh)$/;

/** Human-meaningful id for a step, derived from what it actually runs. */
function deriveId(tokens) {
  if (tokens[0] === 'npm' && tokens[1] === 'run' && tokens[2]) return tokens[2];
  const script = tokens.find((t) => SCRIPT_TOKEN.test(t)) || tokens.find((t) => ANY_SCRIPT_TOKEN.test(t));
  if (script) return script.split('\\').join('/');
  return tokens[0];
}

/** Split argv into steps on the literal `--then` separator. */
function parseSteps(argv) {
  const steps = [];
  let current = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--then') {
      current = { tokens: [], needs: [], why: null, id: null };
      steps.push(current);
      continue;
    }
    if (!current) continue; // pre-step options are handled by the caller
    if (current.tokens.length === 0 && token === '--id') {
      current.id = argv[i + 1];
      i += 1;
      continue;
    }
    if (current.tokens.length === 0 && token === '--needs') {
      current.needs.push(argv[i + 1]);
      i += 1;
      continue;
    }
    if (current.tokens.length === 0 && token === '--why') {
      current.why = argv[i + 1];
      i += 1;
      continue;
    }
    current.tokens.push(token);
  }
  return steps.map((raw) => {
    const step = {
      id: raw.id || deriveId(raw.tokens),
      needs: raw.needs,
      why: raw.why
    };
    if (raw.tokens[0] === 'npm' && raw.tokens[1] === 'run') step.npm = raw.tokens[2];
    else step.run = raw.tokens;
    return step;
  });
}

function validateChain(name, steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`chain "${name}" has no steps`);
  }
  const seen = new Set();
  steps.forEach((step, index) => {
    if (!step || typeof step.id !== 'string' || step.id === '') {
      throw new Error(`chain "${name}" step ${index + 1} has no id`);
    }
    if (seen.has(step.id)) {
      throw new Error(`chain "${name}" has a duplicate step id: ${step.id}`);
    }
    if (!step.npm && (!Array.isArray(step.run) || step.run.length === 0)) {
      throw new Error(`chain "${name}" step "${step.id}" has no command`);
    }
    for (const need of step.needs || []) {
      if (!seen.has(need)) {
        // A needs edge pointing at a step that does not run earlier can never
        // be satisfied, so the dependent would skip forever while a reader of
        // the exit code alone might call the tree "green enough".
        throw new Error(`chain "${name}" step "${step.id}" needs "${need}", which is not an earlier step`);
      }
      if (!step.why) {
        throw new Error(`chain "${name}" step "${step.id}" declares needs but no why -- a gate must say why it is a gate`);
      }
    }
    seen.add(step.id);
  });
  return steps;
}

function main(argv, lifecycle = null) {
  const args = argv.slice(2);
  let name = 'chain';
  let listOnly = false;
  // This marker can only make the gate stricter. A release invocation carries
  // it through npm's pretest/test/posttest lifecycle and nested chain runners.
  let strict = strictRequested();
  let updateBaseline = false;
  let baselinePath = DEFAULT_BASELINE_PATH;
  for (let i = 0; i < args.length && args[i] !== '--then'; i += 1) {
    if (args[i] === '--name') {
      name = args[i + 1];
      i += 1;
    } else if (args[i] === '--baseline') {
      // A FLAG, deliberately not an environment variable. This gate can be
      // neutered by pointing it at a baseline that already lists every step, so
      // the substitution must be visible on the command line a reviewer reads.
      baselinePath = path.resolve(ROOT, args[i + 1] || '');
      i += 1;
    } else if (args[i] === '--strict') {
      strict = true;
    } else if (args[i] === '--update-baseline') {
      updateBaseline = true;
    } else if (args[i] === '--list') {
      listOnly = true;
    }
  }

  if (strict && updateBaseline) {
    // --strict asks "may this leave the machine"; --update-baseline says
    // "record whatever it does today". Answering both at once would let a
    // release run rewrite the record it is being judged against.
    process.stderr.write('--strict and --update-baseline are mutually exclusive\n');
    return EXIT_UNTRUSTED;
  }

  let steps;
  try {
    steps = validateChain(name, parseSteps(args));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write(
      'usage: node tools/check-chain-runner.js --name <label> [--baseline <path>] [--strict|--update-baseline] --then <cmd...> [--then <cmd...>]\n'
    );
    return EXIT_UNTRUSTED;
  }

  if (listOnly) {
    steps.forEach((step, index) => {
      const gate = step.needs.length ? `  needs: ${step.needs.join(', ')}` : '';
      process.stdout.write(`${String(index + 1).padStart(2)}  ${step.id}  ${describe(step)}${gate}\n`);
    });
    return EXIT_OK;
  }

  // Read the baseline BEFORE running, so a malformed one is reported in a
  // second rather than after a 20-minute chain.
  const baseline = updateBaseline
    ? { present: false, knownIds: new Set(), notes: new Map(), problems: [], path: baselinePath }
    : readChainBaseline(baselinePath, name);
  if (baseline.problems.length > 0) {
    for (const problem of baseline.problems) process.stderr.write(`chain baseline: ${problem}\n`);
    process.stderr.write('Refusing to run a chain whose baseline cannot be read; fix or delete it.\n');
    return EXIT_UNTRUSTED;
  }

  const outcome = runChain(steps, { name, cwd: ROOT, strict, lifecycle });

  if (updateBaseline) {
    const recorded = writeChainBaseline(baselinePath, name, outcome.results);
    process.stdout.write(
      `\nCHAIN BASELINE UPDATED: ${recorded.length} known-failing step(s) recorded for chain "${name}" in ${path.relative(ROOT, baselinePath)}.\n`
    );
    process.stdout.write('Commit that file, and write a real note on every entry you added.\n');
    return EXIT_OK;
  }

  const verdict = rateChain({ chainName: name, results: outcome.results, baseline, strict });
  if (verdict.lines.length > 0) {
    process.stdout.write('\n');
    for (const line of verdict.lines) process.stdout.write(`${line}\n`);
  }
  return verdict.code;
}

module.exports = {
  runChain,
  validateChain,
  parseSteps,
  resolveCommand,
  deriveId,
  readChainBaseline,
  rateChain,
  isolatedSummaryProbe,
  readDeclaredSkips,
  describeDeclaredSkips,
  writeChainBaseline,
  STATUS,
  EXIT_OK,
  EXIT_RATCHET,
  EXIT_UNTRUSTED,
  DEFAULT_BASELINE_PATH
};

if (require.main === module) {
  let lifecycle;
  let started = false;
  try {
    lifecycle = lifecycleRecords.readContext();
    lifecycleRecords.assertInvocation(lifecycle, 'chain', ['node', 'tools/check-chain-runner.js', ...process.argv.slice(2)]);
    if (lifecycle) {
      lifecycleRecords.record(lifecycle, lifecycle.node, 'start');
      started = true;
    }
    process.exitCode = main(process.argv, lifecycle);
  } catch (error) {
    process.stderr.write(`Check-chain could not complete: ${error.message}\n`);
    process.exitCode = EXIT_UNTRUSTED;
  } finally {
    if (started) lifecycleRecords.record(lifecycle, lifecycle.node, 'end', {
      status: process.exitCode === 0 ? 'pass' : 'fail', exitCode: process.exitCode
    });
  }
}

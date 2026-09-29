#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildCensus } = require('./test-census');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'tests', 'run-isolated.js');
const DEFAULT_OUTPUT_DIRECTORY = path.join(ROOT, 'state', 'test-runs');
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_FILES_PER_BATCH = 25;

function parsePositiveInteger(value, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseArguments(argv) {
  const options = { all: false, timeoutMs: null, outputDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--all') options.all = true;
    else if (argv[index] === '--timeout-ms') {
      if (options.timeoutMs != null) throw new Error('--timeout-ms may only be supplied once');
      options.timeoutMs = parsePositiveInteger(argv[index + 1], '--timeout-ms');
      index += 1;
    } else if (argv[index] === '--output') {
      if (options.outputDirectory != null) throw new Error('--output may only be supplied once');
      const value = argv[index + 1];
      if (!value) throw new Error('--output requires a directory');
      options.outputDirectory = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argv[index]}`);
    }
  }
  if (!options.all) throw new Error('--all is required');
  if (options.timeoutMs == null && process.env.TOOLSENABLED_TEST_TIMEOUT_MS) {
    options.timeoutMs = parsePositiveInteger(process.env.TOOLSENABLED_TEST_TIMEOUT_MS, 'TOOLSENABLED_TEST_TIMEOUT_MS');
  }
  options.timeoutMs ??= DEFAULT_TIMEOUT_MS;
  // --output beats the env var beats the real state/test-runs/ default. Exists
  // so exercising this tool (or its --summary/persistence behaviour) never has
  // a chance to overwrite the one latest.json other lanes treat as
  // authoritative -- observed live on 2026-08-10: a live poller read a
  // transient dev-run record for about a minute before the real file was
  // restored. Point ANY non-production invocation here instead.
  options.outputDirectory ??= process.env.TOOLSENABLED_TEST_RUN_OUTPUT_DIR || null;
  options.outputDirectory = options.outputDirectory
    ? path.resolve(ROOT, options.outputDirectory)
    : DEFAULT_OUTPUT_DIRECTORY;
  return options;
}

function packageName(testPath) {
  const parts = testPath.split('/');
  return parts.length > 2 ? parts[1] : 'root';
}

function batchTests(testPaths) {
  const packages = new Map();
  for (const testPath of testPaths) {
    const name = packageName(testPath);
    if (!packages.has(name)) packages.set(name, []);
    packages.get(name).push(testPath);
  }
  const batches = [];
  for (const [name, files] of [...packages.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sortedFiles = files.sort();
    const chunks = Math.ceil(sortedFiles.length / MAX_FILES_PER_BATCH);
    for (let offset = 0; offset < sortedFiles.length; offset += MAX_FILES_PER_BATCH) {
      const index = Math.floor(offset / MAX_FILES_PER_BATCH) + 1;
      batches.push({
        name: chunks === 1 ? name : `${name}-${String(index).padStart(3, '0')}`,
        files: sortedFiles.slice(offset, offset + MAX_FILES_PER_BATCH)
      });
    }
  }
  return batches;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function readBatchSummary(summaryPath, files, batchDurationMs, runnerResult) {
  const exitCode = Number.isInteger(runnerResult.status) ? runnerResult.status : 1;
  if (!fs.existsSync(summaryPath)) {
    return files.map((file) => ({ file, status: 'fail', exitCode, ms: batchDurationMs }));
  }
  const recorded = JSON.parse(fs.readFileSync(summaryPath, 'utf8')).files || [];

  if (!Array.isArray(recorded)) {
    throw new Error(`Batch summary ${summaryPath} has a non-array files field`);
  }
  const requested = new Set(files);
  const recordedCounts = new Map();
  for (const entry of recorded) {
    if (!entry || typeof entry.file !== 'string') {
      throw new Error(`Batch summary ${summaryPath} has a record without a file name`);
    }
    if (!requested.has(entry.file)) {
      throw new Error(`Batch summary ${summaryPath} contains unrequested file ${entry.file}`);
    }
    const count = (recordedCounts.get(entry.file) || 0) + 1;
    if (count > 1) {
      throw new Error(`Batch summary ${summaryPath} contains duplicate records for ${entry.file}`);
    }
    recordedCounts.set(entry.file, count);
  }

  // Reconcile against what was REQUESTED, not just what came back.
  //
  // run-isolated writes its summary from a finally block, so a throw partway
  // through a batch still produces a summary that is present, valid JSON, and
  // SHORT. Returning `.files` verbatim then shrinks the denominator instead of
  // reporting a gap. Measured on the 2026-08-09 baseline: 709 files requested
  // across 73 batches, 670 records returned, and the run printed "564/670" --
  // 39 files vanished from the numerator AND the denominator, so the omission
  // was invisible in the very number meant to prove completeness.
  //
  // A file that was asked for and did not report is not a pass and not a
  // failure; it is an absence, and it says so.
  const seen = new Set(recorded.map((entry) => entry && entry.file));
  const missing = files
    .filter((file) => !seen.has(file))
    .map((file) => ({ file, status: 'no-record', exitCode: exitCode || 1, ms: 0 }));
  return [...recorded, ...missing];
}

// A file whose batch has not been attempted yet. Reuses the vocabulary
// run-isolated already spends on "asked for, did not run" (see readBatchSummary's
// own not-run/no-record split above) rather than inventing a second one --
// downstream readers (tools/invocation-guard.js, tools/invocation-graph.js)
// already treat any status !== 'pass' as no-coverage, so this is honest to
// them for free. exitCode/ms are null/0 to match run-isolated's own shape for
// an abandoned file, not this tool's synthesized 'fail' shape.
function notRunPlaceholder(file) {
  return { file, status: 'not-run', exitCode: null, ms: 0 };
}

function computeTotals(effectiveResults, requested) {
  const countStatus = (status) => effectiveResults.filter((result) => result.status === status).length;
  // Every status run-isolated can emit is counted here, and `other` catches any
  // it learns to emit later. The previous breakdown counted only pass/fail/
  // timeout: the 2026-08-09 baseline printed "564/670 passed; 91 failed; 4
  // timed out", which sums to 659, so 11 config-mutation records sat in the
  // total and in no category. A run whose ONLY defect was config mutation also
  // exited 0, because the old exit rule looked at failed/timedOut alone.
  return {
    requested,
    total: effectiveResults.length,
    passed: countStatus('pass'),
    failed: countStatus('fail'),
    timedOut: countStatus('timeout'),
    configMutation: countStatus('config-mutation'),
    // `not-run` covers both a batch run-isolated itself abandoned AND a batch
    // this tool never got to before being interrupted -- more precise than
    // `no-record` (which is this tool inferring an absence from a short
    // summary). Counted separately: collapsing them would hide which side of
    // the boundary lost the file.
    notRun: countStatus('not-run'),
    noRecord: countStatus('no-record'),
    // `skip` is NAMED rather than left in `other`, for the same reason `not-run`
    // and `no-record` are named: an absence that shares a bucket with "anything
    // this tool has not heard of" is an absence nobody reads. run-isolated emits
    // it for a suite behind an opt-in environment gate and for one whose fixture
    // is a file this checkout does not contain -- 46 of the 305 files in the
    // root `test` battery on 2026-08-22. It is counted here and it is NEVER a
    // pass: the exit rule below compares `passed` against `requested`, so a run
    // full of skips still ends non-zero.
    skipped: countStatus('skip'),
    other: effectiveResults.filter((result) => !['pass', 'fail', 'timeout', 'config-mutation', 'not-run', 'no-record', 'skip'].includes(result.status)).length
  };
}

// Persist a truthful snapshot RIGHT NOW, whatever has been measured so far.
//
// WHY THIS EXISTS. The previous shape accumulated every result in memory and
// called fs.writeFileSync exactly once, after the last batch. Measured on
// 2026-08-10: two full-tree runs were killed by the launching harness's ~65
// minute cap, one of them after reaching batch 70 of 73 (~660 files actually
// measured). Both wrote nothing at all -- an interruption destroyed 100% of
// the measurement instead of the ~4% (3 of 73 batches) it actually cost, and
// state/test-runs/latest.json was left holding a run from hours earlier.
// tests/run-isolated.js already solved exactly this for a single batch by
// writing its --summary from a finally block; this is that same fix one
// level up, called after every batch instead of only at the very end.
//
// completedResults holds only batches that actually finished; every file in a
// batch at or past `completedBatchCount` is synthesized as not-run so the
// file list, and therefore every total computed from it, always accounts for
// every requested file -- a killed run yields a smaller true number, never a
// missing one. `complete` lets a reader (a human, or a future --resume flag)
// tell a finished record from a snapshot apart without inspecting timestamps.
function writeSummary({ runPath, latestPath, startedAt, options, census, batches, completedResults, completedBatchCount }) {
  const requested = batches.reduce((count, batch) => count + batch.files.length, 0);
  const remaining = batches
    .slice(completedBatchCount)
    .flatMap((batch) => batch.files.map((file) => notRunPlaceholder(file)));
  const effectiveResults = [...completedResults, ...remaining];
  const totals = computeTotals(effectiveResults, requested);
  const summary = {
    generatedAt: new Date().toISOString(),
    complete: completedBatchCount === batches.length,
    completedBatches: completedBatchCount,
    totalBatches: batches.length,
    wallClockMs: Date.now() - startedAt,
    timeoutMs: options.timeoutMs,
    census: census.counts,
    // THE FILES THIS RUN DID NOT MEASURE, BY NAME.
    //
    // `files` below is drawn from census.reachable + census.orphaned, so every
    // file the census EXCLUDED is absent from this record entirely -- and until
    // 2026-08-25 the only trace of them was census.excluded, a bare integer
    // (71 of 856 on that day) with nothing behind it. A reader could not tell
    // whether a suite was missing because it passed, because it was never run,
    // or because it was never discovered. Same rule as `no-record` and
    // `not-run` above: an absence that is not named is an absence nobody reads.
    // This never enters totals -- these files were not requested, so counting
    // them as failures would be as dishonest as omitting them.
    excludedFromMeasurement: census.excluded,
    maxFilesPerBatch: MAX_FILES_PER_BATCH,
    totals,
    batches: batches.map((batch) => ({ name: batch.name, files: batch.files.length })),
    files: effectiveResults
  };
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  // Write latest.json second: a reader polling that one file never observes a
  // run.json/latest.json pair from two different moments.
  fs.writeFileSync(runPath, serialized);
  fs.writeFileSync(latestPath, serialized);
  return summary;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\nUsage: node tools/test-run.js --all [--timeout-ms <n>] [--output <dir>]\n`);
    process.stdout.write(`VERDICT: FAILED ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const startedAt = Date.now();
  const census = buildCensus();
  const files = [...new Set([...census.reachable, ...census.orphaned])].sort();
  if (files.length === 0) {
    process.stderr.write('Test census returned zero files; refusing to report an empty run as successful.\n');
    process.stdout.write('VERDICT: FAILED test census returned zero files\n');
    process.exitCode = 1;
    return;
  }
  const batches = batchTests(files);
  const runStamp = timestamp();
  const outputDirectory = options.outputDirectory;
  fs.mkdirSync(outputDirectory, { recursive: true });
  const runPath = path.join(outputDirectory, `${runStamp}.json`);
  const latestPath = path.join(outputDirectory, 'latest.json');
  const results = [];
  const persist = (completedBatchCount) => writeSummary({
    runPath, latestPath, startedAt, options, census, batches,
    completedResults: results, completedBatchCount
  });

  // Written before batch 1 even starts: a run killed in the first second still
  // replaces a stale latest.json with an honest "0 of N done" record instead
  // of leaving hours-old data silently masquerading as current.
  persist(0);

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const batchSummaryPath = path.join(outputDirectory, `.batch-${runStamp}-${String(index + 1).padStart(3, '0')}.json`);
    const batchStartedAt = Date.now();
    process.stdout.write(`\n[${index + 1}/${batches.length}] ${batch.name}: ${batch.files.length} files\n`);
    const result = spawnSync(process.execPath, [
      RUNNER,
      '--continue',
      '--timeout-ms', String(options.timeoutMs),
      '--summary', batchSummaryPath,
      ...batch.files
    ], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    const batchDurationMs = Date.now() - batchStartedAt;
    try {
      results.push(...readBatchSummary(batchSummaryPath, batch.files, batchDurationMs, result));
    } catch (error) {
      process.stderr.write(`Could not read batch summary for ${batch.name}: ${error.message}\n`);
      results.push(...batch.files.map((file) => ({ file, status: 'fail', exitCode: 1, ms: batchDurationMs })));
    } finally {
      fs.rmSync(batchSummaryPath, { force: true });
    }
    persist(index + 1);
  }

  const summary = persist(batches.length);
  const { totals, wallClockMs } = summary;
  process.stdout.write(`\nSummary: ${runPath}\n`);
  process.stdout.write(`Measured ${totals.passed}/${totals.requested} passed; ${totals.failed} failed; ${totals.timedOut} timed out; ${totals.configMutation} config-mutation; ${totals.skipped} skipped (did not run, never a pass); ${totals.notRun} not-run; ${totals.noRecord} no-record; ${totals.other} other; ${formatDuration(wallClockMs)} wall clock.\n`);
  if (totals.total !== totals.requested) {
    process.stdout.write(`Records (${totals.total}) do not match requested files (${totals.requested}); the difference is reported as no-record.\n`);
  }
  // Said out loud, next to the number people quote, because this run is NOT the
  // whole tree and the sentence "N/N passed" invites exactly that reading.
  if (census.counts.excluded > 0) {
    process.stdout.write(
      `Not measured: ${census.counts.excluded} of ${census.counts.javascriptFiles} files under tests/ are excluded from the census `
      + `(runners, helpers, workers, fixtures). They are named with their reasons in ${runPath} under excludedFromMeasurement, `
      + `and by \`node tools/test-census.js\`.\n`
    );
  }
  const allPassed = totals.passed === totals.requested;
  const verdict = allPassed ? 'PASS' : totals.failed || totals.timedOut || totals.configMutation ? 'FAIL' : 'INCOMPLETE';
  process.stdout.write(`VERDICT: ${verdict}; measurement recorded: ${totals.passed}/${totals.requested} in ${formatDuration(wallClockMs)}\n`);

  // The denominator is what was ASKED for. Anything that is not an observed
  // pass -- including an absence -- keeps this nonzero.
  process.exitCode = allPassed ? 0 : 1;
}

if (require.main === module) main();

module.exports = { readBatchSummary, batchTests, writeSummary, notRunPlaceholder };

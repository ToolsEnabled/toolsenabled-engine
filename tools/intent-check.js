#!/usr/bin/env node
'use strict';

// The always-running adversarial intent-fidelity checker (owner request R97).
//
//   node tools/intent-check.js --status            what has been checked, what is returned
//   node tools/intent-check.js --returns           only the work currently FAILED back
//   node tools/intent-check.js --list              what a cycle WOULD check, and why
//   node tools/intent-check.js --request R44       check one ledger request now
//   node tools/intent-check.js --lane q22-ms5...   check one accepted fleet lane now
//   node tools/intent-check.js --once              one bounded cycle over new completed work
//   node tools/intent-check.js --serve             the persistent loop
//   node tools/intent-check.js --stop              sentinel: a serving loop drains and exits
//
// WHY A STANDALONE LOOP rather than a stage inside the fleet supervisor: the
// work this grades is not only fleet work. Controller-completed ledger requests
// are the larger and more dangerous half -- R44, the incident that motivated
// this, was never a fleet lane at all. A stage inside the supervisor could only
// ever see lanes. It reads fleet state (read-only) to pick up accepted lanes and
// writes nothing into it.
//
// TWO OPERATIONAL RULES LEARNED THE HARD WAY TONIGHT, both mechanised here:
//   * --serve writes to logs/intent-fidelity.log, a FILE. Its stdout stays
//     silent unless --verbose. An undrained pipe wedged two long-running
//     processes tonight, and a serving loop nobody is reading is exactly the
//     shape that happens to. (The provider child's own pipes are drained
//     unconditionally in src/lib/intent-fidelity.js.)
//   * A single-instance PID lock makes a second --serve fail fast instead of
//     double-checking every item and double-spending the provider.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const intent = require('../src/lib/intent-fidelity.js');
const killSwitch = require('../src/lib/kill-switch.js');
const { acquireLock, AgentDigestLockError } = require('../src/lib/process-claim-lock.js');

const PROCESS_LOCK = path.join(ROOT, 'state', 'intent-check.pid.lock');
const STOP_FILE = path.join(ROOT, 'state', 'intent-check.stop');
const LOG_FILE = path.join(ROOT, 'logs', 'intent-fidelity.log');

const DEFAULT_POLL_MS = 120_000;
// A cycle is bounded so a first run against a full ledger cannot spend the
// whole provider budget in one go. Work not reached this cycle is picked up on
// the next one; nothing is lost, because discovery is derived from content
// hashes rather than from a cursor.
const DEFAULT_MAX_PER_CYCLE = 4;
// A serve cycle that skips everything it can see and examines nothing writes
// the same quiet intent-cycle line as a healthy caught-up cycle -- a checker
// checking NOTHING looked identical to a checker with nothing to check. After
// this many consecutive such cycles the loop says so out loud (with the
// skip-reason histogram) and keeps serving.
const STARVED_AFTER_CYCLES = 3;

function flag(name) { return process.argv.includes(`--${name}`); }

function option(name, fallback = null) {
  const withEquals = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1];
  return fallback;
}

function integerOption(name, fallback) {
  const raw = option(name, null);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer; got ${raw}`);
  return value;
}

function appendLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch { /* logging must never take the checker down */ }
}

// Unlike existsSync(), this distinguishes an absent sentinel from a sentinel
// whose state could not be established (for example, because its parent is
// unreadable). Gates must not turn the latter into a confident "not present".
function fileExists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function makeLogger({ toStdout }) {
  return (event, detail) => {
    const entry = { event, ...detail };
    appendLog(entry);
    if (toStdout) process.stdout.write(`${JSON.stringify(entry)}\n`);
  };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function queueCorpusUnavailable(laneId, error) {
  return {
    ok: false,
    code: 'INTENT_QUEUE_CORPUS_UNAVAILABLE',
    laneId,
    queueCode: (error && error.code) || 'QUEUE_CORPUS_UNAVAILABLE',
    note: 'repair the BUILD-QUEUE corpus before resolving this lane\'s owner request'
  };
}

function storeFile() { return option('store-file', null) || intent.defaultStoreFile(ROOT); }

function loadStore() {
  return intent.readStore(storeFile());
}

// A compact, honest summary. Every number here is counted from the store; none
// is derived from a running total that could drift away from the records.
//
// EXPORTED AND GUARANTEED NON-THROWING so another status surface can compose it
// in the same way tools/fleet-supervisor.js already composes ownerChat.summarize()
// into its --status payload. A summary that can throw is a summary that can take
// down the thing that embeds it, and a dangling require in a fleet entry point
// cost 45 minutes tonight. It starts no process and writes nothing.
function summarize() {
  try { return summarizeInner(); }
  catch (error) {
    return {
      headline: 'intent-fidelity summary unavailable',
      unavailable: String((error && error.message) || error).slice(0, 200),
      openReturns: [], checksRecorded: null
    };
  }
}

function summarizeInner() {
  const store = loadStore();
  const entries = Object.values(store.checks || {});
  const returns = intent.openReturns(store);
  const byVerdict = entries.reduce((totals, entry) => {
    totals[entry.verdict] = (totals[entry.verdict] || 0) + 1;
    return totals;
  }, {});
  const durations = entries.map(entry => entry.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
  const tokens = entries.map(entry => entry.usage && entry.usage.totalTokens).filter(Number.isFinite);
  const credits = entries.map(entry => entry.credits).filter(Number.isFinite);
  const mean = list => (list.length ? Number((list.reduce((sum, value) => sum + value, 0) / list.length).toFixed(1)) : null);
  return {
    headline: returns.length
      ? `${returns.length} completed work item(s) RETURNED as not-done by the intent checker`
      : (entries.length ? 'no outstanding intent-fidelity returns' : 'the intent checker has not run yet'),
    storeFile: storeFile(),
    storeError: store.error || null,
    checksRecorded: entries.length,
    byVerdict,
    openReturns: returns.map(entry => ({
      workKey: entry.workKey, requestId: entry.requestId, checkedAt: entry.checkedAt,
      reason: entry.reason,
      // Only grounded, counting gaps are shown here: those are the ones that
      // quote his actual words AND assert an actual absence.
      gaps: (entry.gaps || []).filter(gap => gap.counts).map(gap => ({ quote: gap.quote, source: gap.quoteSource, why: gap.why }))
    })),
    // MEASURED, from the provider's own reported usage. Null when nothing has
    // been measured yet -- never an estimate.
    cost: {
      checks: entries.length,
      meanDurationMs: mean(durations),
      medianDurationMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
      minDurationMs: durations.length ? durations[0] : null,
      maxDurationMs: durations.length ? durations[durations.length - 1] : null,
      meanTotalTokens: mean(tokens),
      meanCredits: credits.length ? Number(mean(credits).toFixed(4)) : null,
      note: 'durations and tokens are provider-reported per check; credits are derived from the rate card recorded in config/agent-org.json'
    },
    stopFilePresent: fileExists(STOP_FILE),
    logFile: LOG_FILE
  };
}

async function runOne(candidate, { logger, model, effort, timeoutMs, dryRun }) {
  if (dryRun) {
    logger('intent-check-dry-run', { requestId: candidate.requestId, kind: candidate.kind, workId: candidate.workId });
    return { ok: false, dryRun: true, verdict: null, ...candidate };
  }
  try {
    return await intent.checkOne({
      repoRoot: ROOT,
      requestId: candidate.requestId,
      kind: candidate.kind,
      workId: candidate.workId,
      storeFile: storeFile(),
      model, reasoningEffort: effort, timeoutMs, logger
    });
  } catch (error) {
    logger('intent-check-error', {
      requestId: candidate.requestId, workId: candidate.workId,
      code: (error && error.code) || 'UNEXPECTED', message: String(error && error.message).slice(0, 300)
    });
    return { ok: false, verdict: null, code: (error && error.code) || 'UNEXPECTED', reason: String(error && error.message).slice(0, 300), ...candidate };
  }
}

async function cycle({ logger, model, effort, timeoutMs, maxPerCycle, dryRun }) {
  const store = loadStore();
  const discovery = intent.discoverCompletedWork({ repoRoot: ROOT, store });
  const batch = discovery.candidates.slice(0, maxPerCycle);
  logger('intent-cycle', {
    candidates: discovery.candidates.length, skipped: discovery.skipped.length,
    checking: batch.length, dryRun
  });
  const results = [];
  for (const candidate of batch) {
    results.push(await runOne(candidate, { logger, model, effort, timeoutMs, dryRun }));
  }
  return { discovered: discovery.candidates.length, skipped: discovery.skipped, results };
}

// Tracks consecutive starved cycles (something was skippable, nothing was
// examined). Returns the intent-serve-starved detail when the state must be
// emitted, null otherwise. A cycle that examines anything -- or a genuinely
// idle one with nothing skipped either -- resets the count. A long starvation
// re-emits at each threshold multiple rather than every cycle, so the state
// stays visible in the log without flooding it.
function makeStarvationMonitor({ threshold = STARVED_AFTER_CYCLES } = {}) {
  let consecutive = 0;
  return (outcome) => {
    const skipped = (outcome && outcome.skipped) || [];
    const examined = ((outcome && outcome.results) || []).length;
    if (examined > 0 || skipped.length === 0) { consecutive = 0; return null; }
    consecutive += 1;
    if (consecutive < threshold || consecutive % threshold !== 0) return null;
    const skipReasons = {};
    for (const item of skipped) {
      const reason = String((item && item.reason) || 'unspecified').slice(0, 160);
      skipReasons[reason] = (skipReasons[reason] || 0) + 1;
    }
    return { consecutiveStarvedCycles: consecutive, examined: 0, skipped: skipped.length, skipReasons };
  };
}

async function serve({ logger, model, effort, timeoutMs, maxPerCycle, pollMs, maxCycles, dryRun, runCycle = cycle }) {
  let cycles = 0;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const starvation = makeStarvationMonitor();
  logger('intent-serve-started', { pollMs, maxPerCycle, model, effort });
  while (!stopping && cycles < maxCycles) {
    if (fileExists(STOP_FILE)) { logger('intent-serve-stop-file', { stopFile: STOP_FILE }); break; }
    const kill = killSwitch.status();
    if (kill.active) { logger('intent-serve-killswitch', { path: kill.path }); break; }
    try {
      const outcome = await runCycle({ logger, model, effort, timeoutMs, maxPerCycle, dryRun });
      const starved = starvation(outcome);
      if (starved) logger('intent-serve-starved', starved);
    }
    catch (error) {
      logger('intent-cycle-error', { message: String(error && error.message).slice(0, 300) });
      throw error;
    }
    cycles += 1;
    if (stopping || cycles >= maxCycles) break;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  logger('intent-serve-stopped', { cycles });
  return cycles;
}

async function main() {
  if (flag('help') || process.argv.length <= 2) {
    process.stdout.write([
      'Adversarial intent-fidelity checker (owner request R97)',
      '',
      'Grades COMPLETED work against the OWNER\'S VERBATIM in reports/OWNER-REQUEST-LEDGER.json.',
      'Never against the controller\'s "(interpretation)" paraphrase -- that is the drift it exists',
      'to catch. Verdicts: PASS / FAIL-WITH-GAPS / UNCERTAIN. A FAIL RETURNS the work as not-done;',
      'it never re-dispatches anything, because returning is a verdict, not a re-assignment.',
      '',
      '  --status                  what has been checked and what is currently returned',
      '  --returns                 only the outstanding returns',
      '  --list                    what a cycle would check now (and what it skips, with reasons)',
      '  --request <Rnn>           check one ledger request against its own verbatim',
      '  --lane <laneId>           check one accepted fleet lane against its phase\'s owner request',
      '  --once                    one bounded cycle over newly completed work',
      '  --serve                   the persistent loop (logs to a file; stdout stays quiet)',
      '  --stop / --clear-stop     stop sentinel for a serving loop',
      '  --dry-run                 discover and log, dispatch nothing',
      `  --model <id>              ${intent.ALLOWED_CHECKER_MODELS.join(' | ')} (default ${intent.DEFAULT_CHECKER_MODEL}, the 0.2x tier)`,
      `  --effort <level>          ${intent.ALLOWED_REASONING_EFFORTS.join(' | ')} (default ${intent.DEFAULT_REASONING_EFFORT})`,
      `  --max-per-cycle <n>       checks per cycle (default ${DEFAULT_MAX_PER_CYCLE})`,
      `  --poll-ms <n>             cycle interval when serving (default ${DEFAULT_POLL_MS})`,
      '  --max-cycles <n>          exit after n cycles (default: never)',
      '  --store-file <path>       use a different durable verdict store',
      '  --verbose                 also mirror log lines to stdout while serving',
      ''
    ].join('\n'));
    return;
  }

  if (flag('status')) { print(summarize()); return; }

  if (flag('returns')) {
    const returns = intent.openReturns(loadStore());
    print({ openReturns: returns.length, returned: returns });
    return;
  }

  if (flag('stop')) {
    fs.mkdirSync(path.dirname(STOP_FILE), { recursive: true });
    fs.writeFileSync(STOP_FILE, `${JSON.stringify({ requestedBy: process.pid, at: new Date().toISOString() })}\n`, 'utf8');
    print({ ok: true, stopFile: STOP_FILE, note: 'a serving intent checker exits at its next cycle boundary' });
    return;
  }
  if (flag('clear-stop')) {
    try { fs.rmSync(STOP_FILE, { force: true }); }
    catch (error) {
      print({ ok: false, code: 'STOP_FILE_CLEAR_FAILED', stopFile: STOP_FILE, reason: String(error && error.message).slice(0, 300) });
      process.exitCode = 7;
      return;
    }
    print({ ok: true, cleared: !fileExists(STOP_FILE), stopFile: STOP_FILE });
    return;
  }

  if (flag('list')) {
    const discovery = intent.discoverCompletedWork({ repoRoot: ROOT, store: loadStore() });
    print({
      ledgerFile: discovery.ledgerFile,
      wouldCheck: discovery.candidates,
      skipped: discovery.skipped
    });
    return;
  }

  const model = intent.assertCheckerModel(option('model', null));
  const effort = intent.assertReasoningEffort(option('effort', null));
  const timeoutMs = integerOption('timeout-ms', intent.DEFAULT_TIMEOUT_MS);
  const maxPerCycle = integerOption('max-per-cycle', DEFAULT_MAX_PER_CYCLE);
  const dryRun = flag('dry-run');

  const requestId = option('request', null);
  const laneId = option('lane', null);
  const once = flag('once');
  const serving = flag('serve');

  if (!requestId && !laneId && !once && !serving) {
    process.stderr.write('Nothing to do: pass --status, --returns, --list, --request, --lane, --once, --serve, --stop or --clear-stop.\n');
    process.exitCode = 2;
    return;
  }

  const kill = killSwitch.status();
  if (kill.active) {
    print({ ok: false, code: 'KILLSWITCH_ACTIVE', path: kill.path });
    process.exitCode = 3;
    return;
  }
  if ((once || serving) && fileExists(STOP_FILE)) {
    print({ ok: false, code: 'STOP_FILE_PRESENT', stopFile: STOP_FILE, note: 'run --clear-stop first' });
    process.exitCode = 5;
    return;
  }

  let lock;
  try { lock = acquireLock(PROCESS_LOCK); }
  catch (error) {
    if (error instanceof AgentDigestLockError) {
      print({ ok: false, code: 'ALREADY_RUNNING', holderPid: error.holderPid });
      process.exitCode = 4;
      return;
    }
    throw error;
  }

  // Serving stays off stdout by default; a single --request/--lane/--once run
  // is an operator asking a question, so it answers on stdout.
  const logger = makeLogger({ toStdout: flag('verbose') || (!serving && !flag('quiet')) });

  try {
    if (requestId || laneId) {
      const candidate = laneId
        ? { kind: 'lane', workId: laneId, requestId: requestId || null }
        : { kind: 'request', workId: requestId, requestId };
      if (candidate.kind === 'lane' && !candidate.requestId) {
        let queueText;
        try { queueText = intent.readQueueText(ROOT, { fsImpl: fs }); }
        catch (error) {
          print(queueCorpusUnavailable(laneId, error));
          process.exitCode = 6;
          return;
        }
        let fleetState;
        const fleetStateFile = path.join(ROOT, 'state', 'fleet-supervisor.json');
        try { fleetState = JSON.parse(fs.readFileSync(fleetStateFile, 'utf8')); }
        catch (error) {
          print({
            ok: false, code: 'INTENT_FLEET_STATE_UNAVAILABLE', laneId,
            stateFile: fleetStateFile, reason: String(error && error.message).slice(0, 300)
          });
          process.exitCode = 6;
          return;
        }
        const lane = fleetState && fleetState.lanes ? fleetState.lanes[laneId] : null;
        candidate.requestId = lane ? intent.requestIdForQueueItem(lane.itemId, queueText) : null;
        if (!candidate.requestId) {
          print({ ok: false, code: 'INTENT_NO_REQUEST_FOR_LANE', laneId, note: 'pass --request <Rnn> explicitly, or add "(owner request Rnn)" to the phase heading' });
          process.exitCode = 6;
          return;
        }
      }
      const result = await runOne(candidate, { logger, model, effort, timeoutMs, dryRun });
      print(result);
      if (result.verdict === 'FAIL-WITH-GAPS') process.exitCode = 10;
      else if (!result.ok && !result.dryRun) process.exitCode = 11;
      return;
    }

    if (once) {
      const outcome = await cycle({ logger, model, effort, timeoutMs, maxPerCycle, dryRun });
      print({
        discovered: outcome.discovered,
        checked: outcome.results.length,
        verdicts: outcome.results.map(result => ({ workId: result.workId, requestId: result.requestId, verdict: result.verdict, code: result.code || null })),
        skipped: outcome.skipped.length
      });
      return;
    }

    const cycles = await serve({
      logger, model, effort, timeoutMs, maxPerCycle, dryRun,
      pollMs: integerOption('poll-ms', DEFAULT_POLL_MS),
      maxCycles: integerOption('max-cycles', 0) || Infinity
    });
    print({ ok: true, cycles, ...summarize() });
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  main().catch(error => {
    appendLog({ event: 'fatal', code: (error && error.code) || null, message: String(error && error.message).slice(0, 400) });
    process.stderr.write(`${String((error && error.stack) || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { LOG_FILE, PROCESS_LOCK, ROOT, STARVED_AFTER_CYCLES, STOP_FILE, makeStarvationMonitor, queueCorpusUnavailable, serve, summarize };

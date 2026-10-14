#!/usr/bin/env node
'use strict';

// Entry point for the persistent Gemini fleet supervisor.
//
//   node tools/fleet-supervisor.js --status            honest live state, exits
//   node tools/fleet-supervisor.js --plan              what it WOULD pick, exits
//   node tools/fleet-supervisor.js --dry-run --once    one cycle, launches nothing
//   node tools/fleet-supervisor.js --once              one real cycle, then drains
//   node tools/fleet-supervisor.js --serve             the persistent loop
//
// --serve is what the scheduled task runs. A single-instance PID lock makes a
// second --serve fail fast instead of racing the first one's claims.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { FleetSupervisor, OWNER_AUTHORIZED_LANE_CEILING, stopFileFor } = require('../src/lib/fleet-supervisor/supervisor.js');
const reviewStage = require('../src/lib/fleet-supervisor/review.js');
const stateStore = require('../src/lib/fleet-supervisor/state.js');
const queueReader = require('../src/lib/fleet-supervisor/queue.js');
const laneModels = require('../src/lib/fleet-supervisor/lane-models.js');
const killSwitch = require('../src/lib/kill-switch.js');
const { acquireLock, AgentDigestLockError } = require('../src/lib/process-claim-lock.js');

const PROCESS_LOCK = path.join(ROOT, 'state', 'fleet-supervisor.pid.lock');
// TOOLSENABLED_FLEET_SUPERVISOR_LOG_PATH lets an isolated test run (see
// tests/lib/isolated-environment.js) redirect this lifecycle log to a per-run
// temp root instead of the real repo, the same pattern already used for the
// audit store, state db, vault, and kill switch below.
const LOG_FILE = process.env.TOOLSENABLED_FLEET_SUPERVISOR_LOG_PATH || path.join(ROOT, 'logs', 'fleet-supervisor.log');

// argv is a parameter with a process.argv default rather than a closed-over
// global, so the startup refusal below can be unit-tested against a synthetic
// command line without spawning a process. Every existing call site keeps its
// current two-argument shape.
function flag(name, argv = process.argv) { return argv.includes(`--${name}`); }

function option(name, fallback, argv = process.argv) {
  const withEquals = argv.find(arg => arg.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  return fallback;
}

function integerOption(name, fallback) {
  const raw = option(name, null);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer; got ${raw}`);
  return value;
}

function configuredQueueFile() {
  return path.resolve(option('queue-file', queueReader.defaultQueueFile(ROOT)));
}

function appendLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* logging must never take the supervisor down */ }
}

// existsSync collapses every lookup error into `false`. That is unsafe for
// control sentinels: an unreadable parent directory must not be interpreted as
// proof that the stop file is absent (and therefore that launching is allowed).
function pathExists(pathname) {
  try {
    fs.lstatSync(pathname);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function makeSupervisor() {
  // The review stage is ON for the real fleet. That is what makes the lane cap
  // a function of REVIEW THROUGHPUT instead of a fixed number: with review
  // running, the fleet may fill up to the owner's authorized ceiling, and the
  // thing that actually stops it launching is the unreviewed backlog.
  const reviewEnabled = !flag('no-review');
  const defaultConcurrency = reviewEnabled
    ? OWNER_AUTHORIZED_LANE_CEILING
    : undefined; // no review stage: keep the conservative library default
  return new FleetSupervisor({
    repoRoot: ROOT,
    queueFile: configuredQueueFile(),
    // A rehearsal must not spend the real fleet's retry budget.
    stateFile: option('state-file', null),
    concurrency: integerOption('concurrency', Number(process.env.TOOLSENABLED_FLEET_CONCURRENCY) || defaultConcurrency),
    review: {
      enabled: reviewEnabled,
      concurrency: integerOption('review-concurrency', undefined),
      backlogThreshold: integerOption('review-backlog', undefined),
      timeoutMs: integerOption('review-timeout-ms', undefined),
      maxAttempts: integerOption('review-max-attempts', undefined),
      maxReclaims: integerOption('review-max-reclaims', undefined),
      reviewerPreference: (option('reviewer', null) || '').split(',').map(id => id.trim()).filter(Boolean)
    },
    planning: {
      enabled: !flag('no-planning'),
      timeoutMs: integerOption('planning-timeout-ms', undefined),
      maxPerTick: integerOption('planning-max-per-tick', undefined)
    },
    maxAttempts: integerOption('max-attempts', undefined),
    maxNoProgressAttempts: integerOption('max-no-progress', undefined),
    pollMs: integerOption('poll-ms', undefined),
    laneTimeoutMs: integerOption('lane-timeout-ms', undefined),
    maxIdleCycles: integerOption('max-idle-cycles', 0),
    // Validated against the fleet model floor; an off-floor model is a
    // refusal at construction, never a silent fallback.
    laneModel: option('model', process.env.TOOLSENABLED_FLEET_MODEL || null),
    // Dedicated Google Cloud project for CLI quota (GOOGLE_CLOUD_PROJECT in
    // each lane). Optional; never hardcoded here; recorded per lane.
    laneProject: option('project', process.env.TOOLSENABLED_FLEET_PROJECT || null),
    laneBackend: option('backend', process.env.TOOLSENABLED_FLEET_BACKEND || null),
    keepWorktrees: flag('keep'),
    dryRun: flag('dry-run'),
    logger: entry => {
      appendLog(entry);
      if (!flag('quiet')) process.stdout.write(`${JSON.stringify(entry)}\n`);
    }
  });
}

// --- STARTUP REFUSAL (R100) -------------------------------------------------
//
// VERIFIED FAILURE THIS CLOSES, measured 2026-07-29, not inferred:
//   live pid 21556 = `node.exe tools/fleet-supervisor.js --serve --quiet`
//   config/managed-processes.json declares --project <id> --backend vertex
//   logs/fleet-supervisor.log: FLEET_VERTEX_PROJECT_MISSING, and
//   "fell back to WHOLE-PHASE dispatch. Decomposition is NOT running."
//
// Why it happened: `--project` was read here with a NULL DEFAULT (still is --
// see makeSupervisor's laneProject) and the only validation lived per-lane at
// src/lib/fleet-supervisor/lane-runner.js:104. So the supervisor booted
// happily, reported healthy, and failed ONE LANE AT A TIME for hours. That is
// LATE VALIDATION: the process is wrong from the instant it starts, but the
// evidence arrives scattered across dozens of lane failures.
//
// This moves the check to the BOUNDARY. lane-runner's check STAYS -- defence in
// depth: this one catches the wrong launch, that one catches a lane that
// somehow reaches execution without a project anyway.
//
// The vertex/no-project pair is a refusal rather than a warning because
// laneModels.DEFAULT_BACKEND is 'vertex': omitting --backend does not mean
// "no backend", it means "vertex", so an argv with neither flag is a fleet
// that cannot run a single lane.
const REFUSAL_EXIT_CODE = 6;

function declaredArgvHint() {
  try {
    const managedProcesses = require('../src/lib/managed-processes.js');
    return managedProcesses.getProcess('fleet-supervisor').declaredArgv.join(' ');
  } catch {
    // The registry being unreadable must not turn a clear refusal into a crash.
    return null;
  }
}

// PURE: argv and env in, a refusal record (or null) out. No fs, no spawn.
function resolveLaunchRefusal({ argv = process.argv, env = process.env } = {}) {
  // Only a real launch is gated. --status / --plan / --stop / --clear-stop /
  // --prune-worktrees / --help must keep working on a misconfigured machine:
  // refusing to REPORT state because the state is bad is how an operator gets
  // locked out of the exact information they need.
  if (!flag('once', argv) && !flag('serve', argv)) return null;

  // A dry run claims and parks bookkeeping only and launches no lane, so it
  // cannot bill anything or fail a lane. Gating it would break rehearsal on a
  // machine that is deliberately not configured for vertex.
  if (flag('dry-run', argv)) return null;

  const requestedBackend = option('backend', env.TOOLSENABLED_FLEET_BACKEND || null, argv);
  let backend;
  try {
    backend = laneModels.assertBackend(requestedBackend);
  } catch (error) {
    return {
      code: error.code || 'FLEET_BACKEND_INVALID',
      flag: '--backend',
      backend: requestedBackend,
      message: `${error.message} Refusing to start.`
    };
  }
  if (backend !== 'vertex') return null;

  const project = option('project', env.TOOLSENABLED_FLEET_PROJECT || null, argv);
  if (typeof project === 'string' && project.trim() !== '') return null;

  const backendSource = requestedBackend === null || requestedBackend === undefined
    ? `defaulted to '${laneModels.DEFAULT_BACKEND}' (no --backend given)`
    : `requested explicitly as '${requestedBackend}'`;
  const declared = declaredArgvHint();

  return {
    code: 'FLEET_VERTEX_PROJECT_MISSING',
    flag: '--project',
    backend,
    backendSource,
    declaredArgv: declared,
    message: [
      `Refusing to start: backend ${backendSource}, and a vertex lane requires an explicit`,
      'Google Cloud project id, but no --project was given and TOOLSENABLED_FLEET_PROJECT is unset.',
      'Starting anyway would boot a supervisor that reports healthy and then fails EVERY lane',
      'individually with FLEET_VERTEX_PROJECT_MISSING, falling back to whole-phase dispatch with',
      'decomposition silently off.',
      '',
      'Fix by passing --project <google-cloud-project-id>, or --backend subscription if you',
      'deliberately want the subscription lane instead.',
      declared ? `\nconfig/managed-processes.json declares: ${declared}` : ''
    ].join(' ').trim()
  };
}

function openItemIds(queueFile = configuredQueueFile()) {
  const queue = queueReader.readBuildQueue(queueFile);
  return queueReader.openPhases(queue.phases).map(phase => phase.id);
}

async function main() {
  if (flag('help') || process.argv.length <= 2) {
    process.stdout.write([
      'ToolsEnabled Gemini fleet supervisor',
      '',
      '  --status                  print honest observable state and exit',
      '  --plan                    print the open BUILD-QUEUE phases in pick order and exit',
      '  --dry-run --once          run one cycle, claim/park bookkeeping only, launch nothing',
      '  --once                    run exactly one real cycle, then drain and exit',
      '  --serve                   run the persistent supervision loop',
      '  --stop                    write the stop sentinel: the serving supervisor drains and exits',
      '  --clear-stop              remove the stop sentinel so --serve can start again',
      '  --prune-worktrees         retention: keep newest fleet-lane worktree per item (+active), remove older',
      `  --concurrency <n>         lanes to keep filled (default ${OWNER_AUTHORIZED_LANE_CEILING} with review on, 4 with --no-review)`,
      '  --no-review               disable the review stage (lanes then accumulate unreviewed)',
      '  --no-planning             disable the planning pass (every phase dispatches whole, as before)',
      '  --planning-timeout-ms <n> wall-clock cap per planning call (default 300000)',
      '  --planning-max-per-tick <n> new phases planned per cycle (default 3)',
      `  --review-concurrency <n>  reviews to run in parallel (default ${reviewStage.DEFAULT_REVIEW_CONCURRENCY})`,
      `  --review-backlog <n>      stop launching lanes at this many unreviewed lanes (default ${reviewStage.DEFAULT_REVIEW_BACKLOG_THRESHOLD})`,
      '  --review-timeout-ms <n>   wall-clock cap per review (default 900000)',
      '  --review-max-attempts <n> review attempts before a lane is marked stalled (default 3)',
      `  --review-max-reclaims <n> takeovers from a dead reviewer before a lane stalls (default ${reviewStage.DEFAULT_MAX_REVIEW_RECLAIMS}; these do NOT spend review attempts)`,
      `  --reviewer <a,b>          reviewer provider preference (default ${reviewStage.DEFAULT_REVIEWER_PREFERENCE.join(',')}; never the lane's own provider)`,
      `  --model <id>              lane model (floor-validated; default ${laneModels.DEFAULT_VERTEX_LANE_MODEL}, HIGH thinking)`,
      '  --project <id>            dedicated Google Cloud project for lane CLI quota (GOOGLE_CLOUD_PROJECT)',
      '  --backend <name>          vertex (default, bills the configured Vertex credit) or subscription',
      '  --max-attempts <n>        attempts before a queue item is parked (default 3)',
      '  --max-no-progress <n>     zero-diff attempts before parking (default 2)',
      '  --poll-ms <n>             cycle interval when serving (default 30000)',
      '  --lane-timeout-ms <n>     wall-clock cap per lane (default 1200000)',
      '  --max-idle-cycles <n>     exit after n cycles with nothing to launch (0 = never)',
      '  --state-file <path>       use a different durable state file (also honored by --status)',
      '  --queue-file <path>       read an explicit BUILD-QUEUE root (for isolated rehearsals)',
      '  --keep                    do not remove lane worktrees after a lane ends',
      '  --quiet                   log to logs/fleet-supervisor.log only',
      ''
    ].join('\n'));
    return;
  }

  if (flag('plan')) {
    const queue = queueReader.readBuildQueue(configuredQueueFile());
    const open = queueReader.openPhases(queue.phases);
    process.stdout.write(`${JSON.stringify({
      queueFile: queue.file,
      totalPhases: queue.phases.length,
      openCount: open.length,
      pickOrder: open.map(phase => ({ id: phase.id, status: phase.status, title: phase.title })),
      firstPick: open.length ? open[0].id : null,
      notOpen: queue.phases.filter(p => !queueReader.isOpen(p)).map(p => ({ id: p.id, status: p.status }))
    }, null, 2)}\n`);
    return;
  }

  if (flag('status')) {
    // --state-file is honored here too, so tests and rehearsals can read an
    // isolated fleet instead of the live one.
    const stateFile = option('state-file', null) || stateStore.defaultStateFile(ROOT);
    let ids = null;
    const queueFile = configuredQueueFile();
    try { ids = openItemIds(queueFile); } catch { /* queue unreadable is not a reason to hide state */ }
    const supervisor = new FleetSupervisor({
      repoRoot: ROOT, stateFile, queueFile, logger: () => {},
      // Read-only: this reports the launch gate the serving supervisor uses;
      // constructing it does not start a review or a planning call.
      review: { enabled: !flag('no-review'), backlogThreshold: integerOption('review-backlog', undefined) },
      planning: { enabled: !flag('no-planning') }
    });
    // Read-only, additive, and computed HERE rather than inside
    // src/lib/fleet-supervisor/** so the supervisor's own state shape is
    // untouched. An operator reading fleet status is exactly the reader who
    // needs to know the owner is sitting unanswered -- ownerChat.summarize()
    // never throws and never starts a process, so it cannot break --status.
    // It is the FIRST key, carrying its own `headline`, so it is the first
    // thing a human or a machine reads. It stays INSIDE the JSON: --status's
    // stdout is a parsed contract (tests/fleet-supervisor.js parses it), so a
    // loose banner line printed alongside it would break every reader.
    const ownerChat = require('../src/lib/owner-chat.js');
    process.stdout.write(`${JSON.stringify({ ownerChat: ownerChat.summarize(), ...supervisor.status(ids) }, null, 2)}\n`);
    if (!pathExists(stateFile)) process.stdout.write('(no durable state yet: the supervisor has never run)\n');
    return;
  }

  const stopFile = stopFileFor(ROOT);
  if (flag('stop')) {
    fs.mkdirSync(path.dirname(stopFile), { recursive: true });
    fs.writeFileSync(stopFile, `${JSON.stringify({ requestedBy: process.pid, at: new Date().toISOString() })}\n`, 'utf8');
    appendLog({ at: new Date().toISOString(), event: 'stop-file-written', stopFile });
    process.stdout.write(`${JSON.stringify({ ok: true, stopFile, note: 'serving supervisor will drain in-flight lanes and exit at its next cycle' })}\n`);
    return;
  }
  if (flag('clear-stop')) {
    // A failed removal is a failed control action, not an `ok` response. Let
    // the top-level fatal handler refuse with exit 1 and preserve the error.
    fs.rmSync(stopFile, { force: true });
    process.stdout.write(`${JSON.stringify({ ok: true, cleared: !pathExists(stopFile), stopFile })}\n`);
    return;
  }

  if (flag('prune-worktrees')) {
    const worktrees = require('../src/lib/fleet-supervisor/worktree.js');
    const stateFile = option('state-file', null) || stateStore.defaultStateFile(ROOT);
    // Never remove the worktree of a lane that is (or may be) still running.
    const state = stateStore.readState(stateFile);
    const activeLaneIds = Object.values(state.lanes)
      .filter(lane => lane.status === 'starting' || lane.status === 'running'
        || lane.orphanWatch === true
        || stateStore.hasUnprovenCleanup(lane)
        // A lane awaiting a verdict is NOT prunable: its worktree is the only
        // place a reviewer can execute the artifact against real data, and
        // deleting it converts a reviewable lane into an unverifiable one.
        || reviewStage.awaitsReview(lane)
        || (Number.isSafeInteger(lane.pid) && stateStore.pidAlive(lane.pid)))
      .map(lane => lane.laneId);
    const report = worktrees.pruneLaneWorktrees({ repoRoot: ROOT, activeLaneIds });
    appendLog({
      at: new Date().toISOString(), event: 'worktrees-pruned',
      removed: report.removed.map(entry => entry.path),
      kept: report.kept.length, refused: report.refused.length
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const once = flag('once');
  const serve = flag('serve');
  if (!once && !serve) {
    process.stderr.write('Nothing to do: pass --status, --plan, --once, --serve, --stop, --clear-stop or --prune-worktrees.\n');
    process.exitCode = 2;
    return;
  }

  // Checked BEFORE the stop file, the kill switch and the pid lock: those all
  // describe a machine that is deliberately holding the fleet back, whereas
  // this describes an argv that can never work. Reporting "already running"
  // for a launch that was malformed to begin with sends the next debugger to
  // the wrong place.
  const refusal = resolveLaunchRefusal();
  if (refusal) {
    appendLog({ at: new Date().toISOString(), event: 'startup-refused', code: refusal.code, flag: refusal.flag, backend: refusal.backend });
    process.stderr.write(`${refusal.message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, code: refusal.code, flag: refusal.flag, backend: refusal.backend, backendSource: refusal.backendSource })}\n`);
    process.exitCode = REFUSAL_EXIT_CODE;
    return;
  }

  if (pathExists(stopFile)) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'STOP_FILE_PRESENT', stopFile, note: 'run --clear-stop first; the sentinel makes restarts an explicit two-step' })}\n`);
    process.exitCode = 5;
    return;
  }

  const kill = killSwitch.status();
  if (kill.active) {
    appendLog({ at: new Date().toISOString(), event: 'killswitch-refused-start', path: kill.path });
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'KILLSWITCH_ACTIVE', path: kill.path })}\n`);
    process.exitCode = 3;
    return;
  }

  let lock;
  try {
    lock = acquireLock(PROCESS_LOCK);
  } catch (error) {
    if (error instanceof AgentDigestLockError) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: 'ALREADY_RUNNING', holderPid: error.holderPid })}\n`);
      process.exitCode = 4;
      return;
    }
    throw error;
  }

  const supervisor = makeSupervisor();
  const shutdown = () => supervisor.stop();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await supervisor.run({ maxCycles: once ? 1 : Infinity });
    process.stdout.write(`${JSON.stringify(supervisor.status(openItemIds(configuredQueueFile())), null, 2)}\n`);
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  main().catch(error => {
    appendLog({ at: new Date().toISOString(), event: 'fatal', message: String(error && error.message).slice(0, 400) });
    process.stderr.write(`${String(error && error.stack || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { LOG_FILE, PROCESS_LOCK, REFUSAL_EXIT_CODE, ROOT, resolveLaunchRefusal };

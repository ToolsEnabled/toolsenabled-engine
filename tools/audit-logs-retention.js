#!/usr/bin/env node
'use strict';

// logs/ retention.
//
// WHY THIS EXISTS. logs/ had grown to ~783 MB on this machine with nothing
// anywhere that prunes it. The audit projections are NOT the problem -- they
// are 37 MB of that. The bulk is material nothing has ever had a policy for:
// 274 MB of `actions.jsonl.legacy-*` / `actions.log.legacy-*` migration
// archives (one full copy of the pre-migration file per legacy import), 291 MB
// of lane console captures, and two ~70-85 MB service logs.
//
// A one-off script that reclaims disk once is not retention. Retention is a
// thing that RUNS, on its own, with defaults a person never has to think
// about. So this tool is three things at once:
//
//   1. A PROTECT LIST. The pass must never be able to delete something the
//      audit system still needs to prove itself, so eligibility is built
//      inside-out from what is protected, never from a delete list.
//   2. A DECLARED POLICY. `--policy install` (the default) is the answer to
//      "what should a customer's machine keep without anyone thinking about
//      it": a per-class age table plus a total-size budget. `--policy
//      audit-only` is the conservative pass that touches audit residue alone.
//   3. A SCHEDULED ENTRY. config/managed-processes.json declares
//      `logs-retention`, tools/logs-retention-task.ps1 registers it, and
//      --heartbeat writes the state file the control plane's `functioning`
//      rung reads. An unregistered task shows up in
//      `node tools/register-managed-tasks.js`.
//
// THE PROTECT LIST, in full. None of these is a candidate under ANY flag
// combination, and tests/kernel.audit/audit-logs-retention.js asserts that
// across the whole flag matrix rather than for one representative run:
//
//   * The live sinks (actions.jsonl, actions.log, the emergency spool), the
//     durability sidecar, and the rotation record itself.
//   * Any file the rotation record NAMES. verify() re-reads and re-hashes
//     every referenced segment, so deleting one turns a valid ledger into a
//     permanently failed verification. This is checked by PATH, before any
//     name or size rule, because a referenced segment that happens to be 20 MB
//     must not be reachable through the service-log rule.
//   * EVERY segment-shaped file when the rotation record cannot be read. A
//     referenced segment and an orphan are indistinguishable by name; only the
//     record tells them apart. "Cannot read" includes an unparseable record AND
//     a record that is ABSENT while segment-shaped files exist on disk -- an
//     absent record next to live segments means the record was lost or moved,
//     which is the same cannot-tell case, not an all-clear.
//   * Emergency ingest and quarantine files: unrecovered audit events are the
//     last thing that may ever be deleted.
//   * Anything modified inside the class's age floor, whatever class it is.
//     That is what keeps the pass from racing a live writer without having to
//     guess which files are open.
//   * Anything reached through a symlink or a junction. This repo has already
//     had a recursive delete empty a shared node_modules through a junction,
//     and there are ~250 live worktrees with junctions on this machine. A
//     reparse point is never followed and never a candidate; Node reports a
//     Windows junction as a symlink dirent, which is asserted by a test rather
//     than assumed.
//   * Anything outside the resolved logs root, and any root that does not
//     carry positive evidence of being a logs directory.
//
// Usage:
//   node tools/audit-logs-retention.js                       # report only
//   node tools/audit-logs-retention.js --apply --heartbeat   # the scheduled run
//   node tools/audit-logs-retention.js --list                # name every candidate
//   node tools/audit-logs-retention.js --policy audit-only --apply
//   node tools/audit-logs-retention.js --json --min-age-days 30
//
// Exit codes: 0 ok, 1 a delete failed, 3 the size budget could not be reached
// without touching protected or unclassified files, 4 refused (bad arguments,
// missing or unsafe root).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'state', 'logs-retention-heartbeat.json');
const STOP_FILE = path.join(ROOT, 'state', 'logs-retention.stop');

const DEFAULT_KEEP_LEGACY = 1;
// A service log has to be genuinely large before an automated pass will touch
// it; a small one is not worth the risk of deleting something diagnostic.
const SERVICE_LOG_MIN_BYTES = 16 * 1024 * 1024;
// Nothing under this age is ever taken by the size-budget backstop, however
// far over budget the directory is. Disk pressure is not a reason to race a
// writer, and two days is longer than any lane on this machine lives.
const BUDGET_HARD_FLOOR_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const NEVER = null;                                  // "not a candidate class"

// THE DEFAULTS A CUSTOMER INSTALL GETS.
//
// Measured, not guessed. On this machine 112 lane consoles reached 291 MB in
// 6.5 days, which is why the console floor is 7 days and not the 14 the first
// draft used: a 14-day console floor on a busy machine is a 600 MB directory.
// The per-class ages answer "how long is this still worth reading"; the budget
// answers "and what if the machine is busier than whoever picked those ages
// imagined". Both are needed -- an install that silently grows to 800 MB of
// logs is a defect a customer meets, and an age table alone cannot promise a
// ceiling.
const POLICIES = Object.freeze({
  install: Object.freeze({
    name: 'install',
    maxTotalMb: 256,
    ages: Object.freeze({
      'atomic-temp': 2,                 // a 2-day-old temp file is a crash remnant
      'rotation-segment-orphan': 14,
      'legacy-archive': 14,             // plus --keep-legacy newest per sink family
      'lane-console': 7,
      'service-log': 30,                // >=16 MB only; a small log is never automatic
      other: NEVER                      // unclassified: reported, never deleted
    })
  }),
  // The conservative pass: audit residue only. Ordinary operational logs are
  // opt-in here, which is the right default for a shared build machine where
  // deleting another session's console output is not one lane's call.
  'audit-only': Object.freeze({
    name: 'audit-only',
    maxTotalMb: NEVER,
    ages: Object.freeze({
      'atomic-temp': 14,
      'rotation-segment-orphan': 14,
      'legacy-archive': 14,
      'lane-console': NEVER,
      'service-log': NEVER,
      other: NEVER
    })
  })
});
const DEFAULT_POLICY = 'install';

// What --include-consoles / --include-service-logs mean when the active policy
// excludes the class: the install policy's own floor, never zero.
const OPT_IN_AGES = Object.freeze({ 'lane-console': 7, 'service-log': 30 });

// Never candidates. Listed as a class so that adding a class cannot silently
// make it prunable: prunableClass() consults this first.
const PROTECTED_CLASSES = new Set([
  'live-sink', 'emergency-spool', 'rotation-segment-referenced', 'rotation-segment-unknown'
]);

const SEGMENT_NAME_RE = /\.rotated-\d+-\d+-[0-9a-f]+$/;
const EMERGENCY_NAME_RE = /^audit-emergency\..*(ingest-|quarantine-)|\.(ingest|quarantine)-[0-9a-f]+$/;
const LEGACY_NAME_RE = /\.legacy-[0-9a-f]+$/;

function parseArgs(argv) {
  const options = {
    apply: false, json: false, help: false, list: false, heartbeat: false,
    includeConsoles: false, includeServiceLogs: false,
    minAgeDays: null, keepLegacy: DEFAULT_KEEP_LEGACY,
    policy: DEFAULT_POLICY, maxTotalMb: undefined, root: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--heartbeat') options.heartbeat = true;
    else if (arg === '--include-consoles') options.includeConsoles = true;
    else if (arg === '--include-service-logs') options.includeServiceLogs = true;
    else if (arg === '--min-age-days') { options.minAgeDays = Number(argv[++index]); }
    else if (arg === '--keep-legacy') { options.keepLegacy = Number(argv[++index]); }
    else if (arg === '--policy') { options.policy = String(argv[++index]); }
    else if (arg === '--max-total-mb') { options.maxTotalMb = Number(argv[++index]); }
    else if (arg === '--no-budget') { options.maxTotalMb = NEVER; }
    else if (arg === '--root') { options.root = argv[++index]; }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      process.stderr.write(`audit-logs-retention: unknown argument ${arg}\n`);
      options.help = true;
      options.invalid = true;
    }
  }
  return options;
}

// Resolves the logs directory the audit system itself is using, so this can
// never be pointed at an unrelated tree by accident.
function resolveLogsRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  const override = process.env.TOOLSENABLED_AUDIT_EMERGENCY_PATH;
  if (override && path.isAbsolute(override)) return path.dirname(path.resolve(override));
  const { loadPolicy } = require('../src/lib/policy');
  const { rootPath } = require('../src/lib/runtime');
  const policy = loadPolicy();
  const configured = (policy.audit && policy.audit.emergencyFile) || 'logs/audit-emergency.jsonl';
  return path.dirname(path.resolve(rootPath(configured)));
}

// --root is the one way to aim this at a directory the audit policy did not
// choose, so it is the one place a typo becomes a recursive delete somewhere
// else. Refuse anything that is not demonstrably a logs directory, rather than
// trusting the caller. The check is positive evidence, not a denylist: a
// denylist of system paths is a list of the mistakes someone already made.
function safeRootProblem(root, io = fs) {
  const parsed = path.parse(root);
  if (parsed.root === root) return 'a filesystem root is never a logs directory';
  let stat;
  try { stat = io.lstatSync(root); } catch { return 'not readable'; }
  if (stat.isSymbolicLink()) {
    return 'the root is a symlink or junction; a retention pass must not act through a reparse point';
  }
  if (!stat.isDirectory()) return 'not a directory';

  if (path.basename(root).toLowerCase() === 'logs') return null;
  let names;
  try { names = io.readdirSync(root); } catch { return 'not readable'; }
  const evidence = names.some(name =>
    name === 'actions.jsonl' || name === 'actions.log' || name.startsWith('audit-'));
  if (evidence) return null;
  return 'no evidence this is a ToolsEnabled logs directory (expected a directory named "logs", '
    + 'or one containing actions.jsonl / actions.log / audit-*)';
}

// THE ENVIRONMENT MAY ADD TO THIS LIST. IT MAY NOT SHORTEN IT.
//
// The first version wrote `env.TOOLSENABLED_AUDIT_JSONL_PATH || <root>/actions.jsonl`,
// so setting the override REMOVED the conventional name from the protect list.
// The suite caught it the first time it ran under a harness that points the
// audit environment elsewhere: a 300 MB actions.jsonl fell through to the
// size-based service-log class and was deleted. A file called actions.jsonl in
// a logs directory is never something a retention pass may take, and "the
// environment says the live one is somewhere else" is not evidence that this
// one is disposable -- it is usually evidence that the environment is a test
// harness, or a second install, or stale.
function protectedNames(root) {
  const names = new Set();
  const add = value => {
    if (!value) return;
    const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    names.add(resolved);
  };
  // Unconditional: the names this codebase writes by convention.
  add(path.join(root, 'actions.jsonl'));
  add(path.join(root, 'actions.log'));
  add(path.join(root, 'audit-emergency.jsonl'));
  add(path.join(root, 'audit-durability.json'));
  add(path.join(root, 'audit-projection-rotation.json'));
  // Additive: wherever the environment currently points, if it lands in here.
  add(process.env.TOOLSENABLED_AUDIT_JSONL_PATH);
  add(process.env.TOOLSENABLED_AUDIT_TEXT_PATH);
  add(process.env.TOOLSENABLED_AUDIT_EMERGENCY_PATH);
  return names;
}

// Rotation segments still referenced by the rotation record are load-bearing:
// verify() reads and re-hashes each one.
//
// `known` is "this pass can tell a referenced segment from an orphan". It is
// false for an unparseable record AND for an absent record that has
// segment-shaped files sitting next to it -- a record that vanished while its
// segments did not is exactly the case where guessing "nothing is referenced"
// deletes the ledger's evidence. Absent record and no segments on disk is the
// only genuinely empty case.
function referencedSegments(root, { segmentFilesOnDisk = 0 } = {}) {
  const file = path.join(root, 'audit-projection-rotation.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return segmentFilesOnDisk === 0
        ? { known: true, files: new Set(), reason: 'no rotation record and no segments on disk' }
        : { known: false, files: new Set(), reason: `rotation record is ABSENT while ${segmentFilesOnDisk} segment-shaped file(s) exist on disk` };
    }
    return { known: false, files: new Set(), reason: `rotation record unreadable (${(error && error.code) || 'error'})` };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { known: false, files: new Set(), reason: 'rotation record is not valid JSON' }; }
  if (!parsed || parsed.version !== 1 || !parsed.sinks) {
    return { known: false, files: new Set(), reason: 'rotation record has an unrecognised shape' };
  }
  const files = new Set();
  for (const sink of Object.values(parsed.sinks)) {
    for (const segment of (sink && Array.isArray(sink.segments) ? sink.segments : [])) {
      if (segment && typeof segment.file === 'string') files.add(path.resolve(root, segment.file));
    }
    if (sink && sink.pending && typeof sink.pending.file === 'string') {
      files.add(path.resolve(root, sink.pending.file));
    }
  }
  return { known: true, files, reason: `rotation record names ${files.size} segment(s)` };
}

function classify(entry, context) {
  const name = path.basename(entry.path);
  if (context.protectedPaths.has(entry.path)) return 'live-sink';
  // BY PATH, AND FIRST. A file the rotation record names is load-bearing
  // whatever it is called and however large it is. Reaching the name and size
  // rules below with a referenced segment is how one would end up inside the
  // service-log class and be deleted by --include-service-logs.
  if (context.segments.files.has(entry.path)) return 'rotation-segment-referenced';
  if (EMERGENCY_NAME_RE.test(name)) return 'emergency-spool';
  if (SEGMENT_NAME_RE.test(name)) {
    return context.segments.known ? 'rotation-segment-orphan' : 'rotation-segment-unknown';
  }
  if (LEGACY_NAME_RE.test(name)) return 'legacy-archive';
  if (name.endsWith('.tmp')) return 'atomic-temp';
  if (entry.relative.split(path.sep)[0] === 'lane-consoles') return 'lane-console';
  // "service-log" means, precisely: anything left that is at or over the size
  // floor. It is a SIZE class, not a name class -- the two files it was built
  // for (85 MB durable-worker.log, 67 MB sol-coordinator-run1.log) share no
  // naming convention with each other or with anything else. Everything the
  // audit system needs has already been claimed above, by path, before size is
  // ever consulted.
  if (entry.size >= SERVICE_LOG_MIN_BYTES) return 'service-log';
  return 'other';
}

// The active age floor for a class, in days, or null for "never a candidate".
// Resolved once and reported, so the run says what it applied rather than
// leaving the reader to recombine flags in their head.
function resolveAges(options) {
  const policy = POLICIES[options.policy];
  const ages = { ...policy.ages };
  if (options.includeConsoles && ages['lane-console'] === NEVER) ages['lane-console'] = OPT_IN_AGES['lane-console'];
  if (options.includeServiceLogs && ages['service-log'] === NEVER) ages['service-log'] = OPT_IN_AGES['service-log'];
  if (options.minAgeDays !== null) {
    // An explicit floor overrides every ELIGIBLE class. It never promotes a
    // class the policy excludes: --min-age-days is an age control, not an
    // opt-in, and conflating the two is how "make it prune a bit older" turns
    // into "and also start deleting a category you never enabled".
    for (const klass of Object.keys(ages)) {
      if (ages[klass] !== NEVER) ages[klass] = options.minAgeDays;
    }
  }
  return ages;
}

function prunableClass(klass, ages) {
  if (PROTECTED_CLASSES.has(klass)) return false;
  return Object.hasOwn(ages, klass) && ages[klass] !== NEVER;
}

function walk(root) {
  const entries = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const directory = stack.pop();
    if (seen.has(directory)) continue;                // cycle belt-and-braces
    seen.add(directory);
    let names;
    try { names = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      throw new Error(`refused: could not enumerate ${directory} (${(error && error.code) || 'error'})`);
    }
    for (const dirent of names) {
      const full = path.join(directory, dirent.name);
      // Never follow a symlink or junction out of the tree, and never treat
      // one as a candidate: deleting through a reparse point is exactly how a
      // "logs cleanup" turns into something else entirely. Node reports a
      // Windows junction as a symlink dirent -- asserted in the test suite,
      // because this repo has already lost a shared node_modules this way.
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) { stack.push(full); continue; }
      if (!dirent.isFile()) continue;
      let stat;
      try { stat = fs.lstatSync(full); }
      catch (error) {
        throw new Error(`refused: could not inspect ${full} (${(error && error.code) || 'error'})`);
      }
      if (!stat.isFile()) continue;
      const resolved = path.resolve(full);
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      entries.push({ path: resolved, relative, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return entries;
}

// Re-checked immediately before the unlink rather than trusting the decision
// taken over the walk snapshot: between the two, a lane can replace a console
// with a junction. Cheap, and the failure mode it prevents is not cheap.
function removeFile(target, root) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('refused: path escapes the logs root');
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error('refused: became a symlink or junction');
  if (!stat.isFile()) throw new Error('refused: no longer a regular file');
  fs.unlinkSync(target);
}

function megabytes(bytes) { return Math.round((bytes / 1024 / 1024) * 10) / 10; }
function ageDays(entry, nowMs) { return (nowMs - entry.mtimeMs) / DAY_MS; }

// existsSync deliberately collapses every lookup failure into false. That is
// unsafe for the owner's stop switch: an unreadable sentinel is not evidence
// that the owner has allowed deletion to proceed.
function stopSentinelPresent(file = STOP_FILE) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw new Error(`refused: could not inspect stop sentinel ${file} (${(error && error.code) || 'error'})`);
  }
}

function writeHeartbeat(record, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so the state-fresh rung never reads a half-written file
  // and reports a parse failure as a subsystem failure.
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function usage() {
  return `Usage: node tools/audit-logs-retention.js [options]

  --apply                 actually delete (default: report only)
  --list                  name every candidate file, largest first
  --json                  machine-readable report
  --policy NAME           install (default) | audit-only
  --min-age-days N        override the age floor of every eligible class
  --keep-legacy N         newest legacy archives kept per sink family (default ${DEFAULT_KEEP_LEGACY})
  --include-consoles      make lane consoles eligible under audit-only
  --include-service-logs  make large service logs eligible under audit-only
  --max-total-mb N        size budget backstop (install default ${POLICIES.install.maxTotalMb})
  --no-budget             disable the size budget
  --heartbeat             write state/logs-retention-heartbeat.json
  --root DIR              operate on DIR instead of the configured logs directory

Policies (age floor in days; a class not listed is never a candidate):
${Object.values(POLICIES).map(policy => `  ${policy.name.padEnd(11)} budget ${policy.maxTotalMb === NEVER ? 'none' : `${policy.maxTotalMb} MB`}  `
    + Object.entries(policy.ages).filter(([, age]) => age !== NEVER).map(([klass, age]) => `${klass}=${age}d`).join(' ')).join('\n')}

Live sinks, the emergency spool, referenced rotation segments, and every
segment when the rotation record cannot be read are protected unconditionally
and are never candidates under any flag combination.
Exit: 0 ok, 1 a delete failed, 3 budget unreachable, 4 refused.
`;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return options.invalid ? 4 : 0;
  }
  if (!Object.hasOwn(POLICIES, options.policy)) {
    process.stderr.write(`audit-logs-retention: unknown --policy ${options.policy} (known: ${Object.keys(POLICIES).join(', ')})\n`);
    return 4;
  }
  if (options.minAgeDays !== null && (!Number.isFinite(options.minAgeDays) || options.minAgeDays < 0)) {
    process.stderr.write('audit-logs-retention: --min-age-days must be a non-negative number.\n');
    return 4;
  }
  if (!Number.isSafeInteger(options.keepLegacy) || options.keepLegacy < 0) {
    process.stderr.write('audit-logs-retention: --keep-legacy must be a non-negative integer.\n');
    return 4;
  }
  if (options.maxTotalMb !== undefined && options.maxTotalMb !== NEVER
      && (!Number.isFinite(options.maxTotalMb) || options.maxTotalMb <= 0)) {
    process.stderr.write('audit-logs-retention: --max-total-mb must be a positive number (use --no-budget to disable).\n');
    return 4;
  }

  // The owner's off switch outranks any schedule, exactly as every other
  // keeper on this machine treats its sentinel.
  if (options.apply && stopSentinelPresent()) {
    process.stdout.write(`audit-logs-retention: stop sentinel present (${STOP_FILE}); deleting nothing.\n`);
    if (options.heartbeat) {
      writeHeartbeat({ generatedAt: new Date().toISOString(), applied: false, reason: 'noop: stop sentinel present', removedFiles: 0, removedBytes: 0 });
    }
    return 0;
  }

  const root = resolveLogsRoot(options.root);
  const problem = safeRootProblem(root);
  if (problem) {
    process.stderr.write(`audit-logs-retention: refusing to operate on ${root}: ${problem}\n`);
    return 4;
  }

  const nowMs = Date.now();
  const raw = walk(root);
  // The segment-shape census has to happen before the rotation record is
  // interpreted, because "record absent" only means "nothing referenced" when
  // there is also nothing segment-shaped left behind.
  const segmentFilesOnDisk = raw.filter(entry => SEGMENT_NAME_RE.test(path.basename(entry.path))).length;
  const context = {
    protectedPaths: protectedNames(root),
    segments: referencedSegments(root, { segmentFilesOnDisk })
  };
  const ages = resolveAges(options);
  const policy = POLICIES[options.policy];
  const budgetMb = options.maxTotalMb === undefined ? policy.maxTotalMb : options.maxTotalMb;

  const entries = raw.map(entry => ({ ...entry, class: classify(entry, context) }));

  // Keep the newest legacy archives per sink family: they are the most likely
  // to still be wanted for a manual comparison against a recent migration.
  const keptLegacy = new Set();
  const families = new Map();
  for (const entry of entries.filter(item => item.class === 'legacy-archive')) {
    const family = path.basename(entry.path).replace(LEGACY_NAME_RE, '');
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(entry);
  }
  for (const group of families.values()) {
    group.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const entry of group.slice(0, options.keepLegacy)) keptLegacy.add(entry.path);
  }

  const decisions = entries.map(entry => {
    const decision = { ...entry, ageDays: ageDays(entry, nowMs) };
    if (!prunableClass(entry.class, ages)) return { ...decision, action: 'protected', reason: entry.class };
    if (keptLegacy.has(entry.path)) return { ...decision, action: 'protected', reason: 'newest-legacy-archive' };
    if (decision.ageDays < ages[entry.class]) return { ...decision, action: 'protected', reason: 'younger-than-min-age' };
    return { ...decision, action: 'prune', reason: entry.class };
  });

  // THE BUDGET BACKSTOP. An age table alone cannot promise a ceiling: it is
  // sized for an imagined rate, and a busy machine beats the imagination. When
  // the directory would still be over budget after the age pass, take the
  // OLDEST files that are already of an eligible class and were spared only by
  // their age, and only down to a hard floor no flag can lower.
  //
  // It cannot reach a protected class, an unclassified file, or the newest
  // legacy archive of a family, because those are not spared for age. If the
  // budget cannot be met inside those limits, the run says so and exits 3 --
  // it does not go looking for something else to delete.
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const budgetBytes = budgetMb === NEVER ? null : budgetMb * 1024 * 1024;
  let projected = totalBytes - decisions.filter(d => d.action === 'prune').reduce((sum, d) => sum + d.size, 0);
  let budgetMet = true;
  let budgetTaken = 0;
  if (budgetBytes !== null && projected > budgetBytes) {
    const pool = decisions
      .filter(decision => decision.action === 'protected'
        && decision.reason === 'younger-than-min-age'
        && decision.ageDays >= BUDGET_HARD_FLOOR_DAYS)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const decision of pool) {
      if (projected <= budgetBytes) break;
      decision.action = 'prune';
      decision.reason = 'over-budget';
      projected -= decision.size;
      budgetTaken += 1;
    }
    budgetMet = projected <= budgetBytes;
  }

  const summary = new Map();
  for (const decision of decisions) {
    const key = `${decision.class}:${decision.action}`;
    const row = summary.get(key) || { class: decision.class, action: decision.action, count: 0, bytes: 0 };
    row.count += 1;
    row.bytes += decision.size;
    summary.set(key, row);
  }

  const pruneList = decisions.filter(decision => decision.action === 'prune')
    .sort((left, right) => right.size - left.size);
  const removed = [];
  const failed = [];
  if (options.apply) {
    for (const decision of pruneList) {
      try { removeFile(decision.path, root); removed.push(decision); }
      catch (error) { failed.push({ file: decision.relative, error: String(error && error.message) }); }
    }
  }

  const protectedBytes = decisions
    .filter(decision => decision.action === 'protected' && PROTECTED_CLASSES.has(decision.class))
    .reduce((sum, decision) => sum + decision.size, 0);

  const report = {
    root,
    policy: options.policy,
    applied: options.apply,
    ages,
    keepLegacy: options.keepLegacy,
    maxTotalMb: budgetMb,
    budgetHardFloorDays: BUDGET_HARD_FLOOR_DAYS,
    budgetMet,
    budgetTakenFiles: budgetTaken,
    includeConsoles: options.includeConsoles,
    includeServiceLogs: options.includeServiceLogs,
    rotationRecordReadable: context.segments.known,
    rotationRecordReason: context.segments.reason,
    totalFiles: entries.length,
    totalBytes,
    protectedBytes,
    projectedBytes: projected,
    prunableFiles: pruneList.length,
    prunableBytes: pruneList.reduce((sum, entry) => sum + entry.size, 0),
    removedFiles: removed.length,
    removedBytes: removed.reduce((sum, entry) => sum + entry.size, 0),
    failures: failed,
    classes: [...summary.values()].sort((left, right) => right.bytes - left.bytes),
    prune: pruneList.map(decision => ({
      file: decision.relative, bytes: decision.size,
      ageDays: Math.round(decision.ageDays * 10) / 10, class: decision.class, reason: decision.reason
    }))
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`logs retention for ${root}\n`);
    process.stdout.write(`  policy ${report.policy}, budget ${budgetMb === NEVER ? 'none' : `${budgetMb} MB`}, keep-legacy ${report.keepLegacy}\n`);
    process.stdout.write(`  age floors: ${Object.entries(ages).map(([klass, age]) => `${klass}=${age === NEVER ? 'never' : `${age}d`}`).join(', ')}\n`);
    process.stdout.write(`  ${report.totalFiles} files, ${megabytes(report.totalBytes)} MB total\n`);
    if (!context.segments.known) {
      process.stdout.write(`  NOTE: ${context.segments.reason}; EVERY rotation segment is being treated as referenced.\n`);
    }
    for (const row of report.classes) {
      process.stdout.write(`  ${row.action === 'prune' ? 'PRUNE   ' : 'protect '}${row.class.padEnd(28)} ${String(row.count).padStart(5)} files  ${String(megabytes(row.bytes)).padStart(8)} MB\n`);
    }
    if (options.list) {
      process.stdout.write(`  --- ${pruneList.length} file(s) ${options.apply ? 'removed' : 'that would be removed'} ---\n`);
      for (const decision of pruneList) {
        process.stdout.write(`  ${String(megabytes(decision.size)).padStart(8)} MB  ${String(Math.round(decision.ageDays * 10) / 10).padStart(6)}d  ${decision.reason.padEnd(24)} ${decision.relative}\n`);
      }
    }
    process.stdout.write(options.apply
      ? `  removed ${report.removedFiles} files, reclaimed ${megabytes(report.removedBytes)} MB\n`
      : `  would remove ${report.prunableFiles} files, reclaiming ${megabytes(report.prunableBytes)} MB (dry run; pass --apply)\n`);
    if (!budgetMet) {
      process.stdout.write(`  BUDGET NOT MET: ${megabytes(projected)} MB remains against a ${budgetMb} MB budget. `
        + `${megabytes(protectedBytes)} MB of that is protected audit state and nothing here will delete it.\n`);
    }
    for (const failure of failed) process.stdout.write(`  FAILED ${failure.file}: ${failure.error}\n`);
  }

  if (options.heartbeat) {
    writeHeartbeat({
      generatedAt: new Date().toISOString(),
      root, policy: report.policy, applied: report.applied,
      totalBytes: report.totalBytes, projectedBytes: report.projectedBytes,
      removedFiles: report.removedFiles, removedBytes: report.removedBytes,
      budgetMet: report.budgetMet, failures: failed.length,
      rotationRecordReadable: report.rotationRecordReadable
    });
  }

  if (failed.length) return 1;
  if (!budgetMet) return 3;
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`audit-logs-retention: ${(error && error.stack) || error}\n`);
    process.exitCode = 4;
  }
}

module.exports = {
  BUDGET_HARD_FLOOR_DAYS, POLICIES, PROTECTED_CLASSES, STATE_FILE, STOP_FILE,
  classify, main, prunableClass, referencedSegments, resolveAges, resolveLogsRoot, safeRootProblem
};

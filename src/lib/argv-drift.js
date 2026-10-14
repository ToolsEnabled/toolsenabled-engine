'use strict';

// LIVE argv drift detection (R100, coordinator port).
//
// config/managed-processes.json says what each subsystem is supposed to be
// launched as. Until now nothing compared that against what is ACTUALLY
// running. The existing 'argv-match' rung in health-invariants.js compares the
// SCHEDULED TASK's registered argument string -- which says nothing at all
// about a process someone started by hand, and is `undefined` for a subsystem
// whose task was never registered. Both of those describe the fleet supervisor
// exactly.
//
// THE VERIFIED CASE THIS MODULE EXISTS FOR (2026-07-29, measured, not inferred):
//   declared: --serve --quiet --concurrency 4 --project <id> --backend vertex
//   live pid 21556: "node.exe" tools/fleet-supervisor.js --serve --quiet
// The supervisor booted happily, then failed one lane at a time with
// FLEET_VERTEX_PROJECT_MISSING, because tools/fleet-supervisor.js read
// --project with a null default and only lane-runner.js validated it.
//
// TWO RULES THIS MODULE WILL NOT BREAK:
//
// 1. DRIFT IS ITS OWN FACT, NEVER A LIVENESS VERDICT. "No live process matches
//    the declaration" is reported as UNKNOWN/not-observable, NOT as DOWN and
//    NOT as DRIFT. Collapsing "I cannot compare" into "it is broken" is the
//    exact mistake that made health-observer emit FALSE DOWN for two
//    demonstrably-alive processes: rung evaluation stopped at `registered` and
//    reported "not running" for something that was running fine.
//
// 2. DRIFT IS NOT A DEFECT VERDICT EITHER. A deliberate temporary override and
//    a regression look identical from here. This module reports BOTH argv
//    strings and names the differing tokens; deciding which one is right is a
//    judgement duty that belongs to a human.
//
// Dependency-free beyond node builtins + the registry loader + the observer's
// already-batched process collector, because a consumer of this module is a
// health path and a health path must not be takeable-down by the thing it
// watches.

const fs = require('node:fs');
const path = require('node:path');

const managedProcesses = require('./managed-processes.js');
const observer = require('./supervision/observer.js');

const DRIFT = Object.freeze({
  MATCH: 'MATCH',       // a live process was found and its argv equals the declaration
  DRIFT: 'DRIFT',       // a live process was found and its argv differs
  UNKNOWN: 'UNKNOWN'    // nothing could be compared; says nothing about liveness
});

// Why a comparison could not be made. Kept separate from DRIFT so a reader
// never has to guess whether UNKNOWN means "absent" or "could not look".
const NOT_OBSERVABLE = Object.freeze({
  PROCESS_TABLE_UNREADABLE: 'PROCESS_TABLE_UNREADABLE',
  NO_MATCHING_PROCESS: 'NO_MATCHING_PROCESS',
  COMMAND_LINE_UNREADABLE: 'COMMAND_LINE_UNREADABLE',
  PID_LOCK_UNREADABLE: 'PID_LOCK_UNREADABLE',
  NO_ENTRY_POINT_TOKEN: 'NO_ENTRY_POINT_TOKEN',
  NOT_DECLARED_FOR_COMPARISON: 'NOT_DECLARED_FOR_COMPARISON',
  PROCESS_UNAVAILABLE: 'PROCESS_UNAVAILABLE'
});

// --- Tokenising ------------------------------------------------------------

// Splits a Windows command line into argv tokens, honouring double quotes.
//
// LIMIT, stated rather than hidden: this does NOT implement the full
// CommandLineToArgvW backslash-escape rules (\" inside a quoted run). Every
// command line this module compares is one WE declared and WE launched --
// `node.exe "<entry>" --flag value` -- so the quote-toggling rule is exact for
// them. A path containing a literal escaped quote would tokenise wrong, and
// that is a known, bounded blind spot, not a silent one.
function tokenizeCommandLine(commandLine) {
  if (typeof commandLine !== 'string') return [];
  const tokens = [];
  let current = '';
  let started = false;
  let inQuotes = false;

  for (const ch of commandLine) {
    if (ch === '"') { inQuotes = !inQuotes; started = true; continue; }
    if (!inQuotes && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

// `--project=x` and `--project x` are the same instruction to
// tools/fleet-supervisor.js#option(), so they must be the same thing here too.
// Normalising both sides means a registrar that writes one form and an operator
// who types the other do not produce a phantom drift report.
function normalizeArgv(argv) {
  const out = [];
  for (const raw of argv || []) {
    const token = String(raw);
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 2) {
      out.push(token.slice(0, eq), token.slice(eq + 1));
    } else {
      out.push(token);
    }
  }
  return out;
}

function isFlag(token) { return typeof token === 'string' && token.startsWith('--'); }

function normalizeSlashes(value) { return String(value).replace(/\\/g, '/').toLowerCase(); }

// --- Pure comparison -------------------------------------------------------

// Multiset diff, so a repeated token is not silently satisfied by one
// occurrence. Order is deliberately NOT compared: `--serve --quiet` and
// `--quiet --serve` are the same launch, and reporting that as drift would
// train a reader to ignore this module.
function multisetDiff(wanted, have) {
  const remaining = new Map();
  for (const token of have) remaining.set(token, (remaining.get(token) || 0) + 1);
  const missing = [];
  for (const token of wanted) {
    const count = remaining.get(token) || 0;
    if (count > 0) remaining.set(token, count - 1);
    else missing.push(token);
  }
  return { missing, leftover: remaining };
}

function valueFor(tokens, flag) {
  const index = tokens.indexOf(flag);
  if (index === -1) return undefined;
  const next = tokens[index + 1];
  if (next === undefined || isFlag(next)) return null;   // present as a bare switch
  return next;
}

// compareArgv is PURE: two token arrays in, a precise difference record out.
// No fs, no process table, no registry. Everything below it is plumbing.
function compareArgv(declaredArgv, observedArgv) {
  const declared = normalizeArgv(declaredArgv);
  const observed = normalizeArgv(observedArgv);

  const forward = multisetDiff(declared, observed);
  const backward = multisetDiff(observed, declared);

  const declaredFlags = declared.filter(isFlag);
  const observedFlags = observed.filter(isFlag);
  const missingFlags = declaredFlags.filter(flag => !observedFlags.includes(flag));
  const extraFlags = observedFlags.filter(flag => !declaredFlags.includes(flag));

  const changedValues = [];
  for (const flag of declaredFlags) {
    if (!observedFlags.includes(flag)) continue;
    const want = valueFor(declared, flag);
    const got = valueFor(observed, flag);
    if (want !== got) changedValues.push({ flag, declared: want, observed: got });
  }

  return Object.freeze({
    matched: forward.missing.length === 0 && backward.missing.length === 0
      && changedValues.length === 0,
    declared: Object.freeze(declared),
    observed: Object.freeze(observed),
    missing: Object.freeze(forward.missing),     // declared but not running
    extra: Object.freeze(backward.missing),      // running but not declared
    missingFlags: Object.freeze(missingFlags),
    extraFlags: Object.freeze(extraFlags),
    changedValues: Object.freeze(changedValues)
  });
}

// --- Live detection --------------------------------------------------------

function allRows(processes) {
  return processes instanceof Map ? [...processes.values()] : processes;
}

function isReadableProcessTable(processes) {
  return processes instanceof Map || Array.isArray(processes);
}

function candidateProcesses(processes, entryPattern) {
  const wanted = normalizeSlashes(entryPattern);
  if (!wanted) return [];
  return allRows(processes).filter(row => row && typeof row.commandLine === 'string'
    && normalizeSlashes(row.commandLine).includes(wanted));
}

// A process whose CommandLine came back null. VERIFIED 2026-07-29: once
// fleet-supervisor was launched by its S4U scheduled task, Win32_Process
// reported CommandLine = NULL for pid 36128 from an unelevated session, while
// the same query read the hand-launched pid 21556 fine. The dashboard listener
// (pid 29420) has always been opaque for the same reason.
//
// This distinction is the whole point. "I read every command line and none was
// yours" and "four command lines were unreadable and yours may be one of them"
// are completely different facts, and reporting the second as the first is the
// same class of lie as reporting UNKNOWN as DOWN.
function opaqueProcesses(processes) {
  return allRows(processes).filter(row => row && typeof row.commandLine !== 'string');
}

// The declared pid lock turns "maybe one of these opaque rows" into a specific
// answer: if the lock holds a pid that is opaque, the subsystem IS running and
// its argv is simply unreadable from here. Best-effort by construction -- a
// ENOENT is the one result that establishes there is no lock. Other read
// failures do not establish absence and must remain distinguishable to the
// caller; in particular, a busy machine must not turn EIO/EMFILE/EAGAIN/EBUSY
// (or an unclassified throw) into a definite "no lock" answer.
function lockedPid(entry, root = managedProcesses.ROOT) {
  if (!entry.pidLockFile) return { pid: null, unreadable: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(root, entry.pidLockFile), 'utf8'));
    const pid = Number(parsed && parsed.pid);
    return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, unreadable: false };
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') {
      return { pid: null, unreadable: false };
    }
    return { pid: null, unreadable: true };
  }
}

// Splits a live command line into { launcher, entryPointToken, args }. The
// entry point is located by entryPattern rather than by position, because the
// launcher may be `node.exe`, an absolute node path, or a quoted path with
// spaces -- all three are live on this machine right now.
function splitAtEntryPoint(tokens, entryPattern) {
  const wanted = normalizeSlashes(entryPattern);
  if (!wanted) return null;
  for (let i = 0; i < tokens.length; i += 1) {
    if (normalizeSlashes(tokens[i]).endsWith(wanted)) {
      return { launcher: tokens.slice(0, i), entryPointToken: tokens[i], args: tokens.slice(i + 1) };
    }
  }
  return null;
}

function unknown(entry, code, reason, extra = {}) {
  return Object.freeze({
    id: entry.id,
    displayName: entry.displayName,
    state: DRIFT.UNKNOWN,
    observable: false,
    notObservable: code,
    reason,
    declaredArgv: Object.freeze([...entry.declaredArgv]),
    candidates: Object.freeze([]),
    ...extra
  });
}

/**
 * Compare a subsystem's LIVE command line against config/managed-processes.json.
 *
 * @param {string} id                managed process id
 * @param {object} [options]
 * @param {Map|Array} [options.processes]  pre-collected process rows
 *        ({pid, commandLine, startedAt}). `undefined` means "the process table
 *        could not be read" and yields UNKNOWN -- pass an empty array/Map to
 *        mean "read fine, nothing matched".
 * @param {string} [options.registryFile]  alternate registry (tests)
 */
function detectDrift(id, { processes, registryFile, root = managedProcesses.ROOT } = {}) {
  const entry = managedProcesses.getProcess(id, registryFile);

  if (typeof entry.entryPattern === 'string' && entry.entryPattern.trim() === '') {
    return unknown(entry, NOT_OBSERVABLE.PROCESS_UNAVAILABLE,
      `${entry.id} declares no installed entry point, so argv drift is unavailable and no live process may be matched to it`);
  }

  // The owner launches this one by hand and it has no declared argv to compare
  // against; asserting a command line here would invent a contract nobody agreed
  // to. Same reasoning as the registry's own `correct: unobservable` rung.
  if (entry.ownerLaunched === true) {
    return unknown(entry, NOT_OBSERVABLE.NOT_DECLARED_FOR_COMPARISON,
      `${entry.id} is owner-launched and declares no authoritative argv, so drift is not defined for it`);
  }

  if (!isReadableProcessTable(processes)) {
    return unknown(entry, NOT_OBSERVABLE.PROCESS_TABLE_UNREADABLE,
      'the live process table could not be read, so argv drift is unknown. This is NOT a statement about liveness.');
  }

  const rows = candidateProcesses(processes, entry.entryPattern);
  if (rows.length === 0) {
    const opaque = opaqueProcesses(processes);
    const lock = lockedPid(entry, root);
    const pid = lock.pid;
    const opaquePids = opaque.map(row => row.pid);

    if (opaque.length > 0 && lock.unreadable) {
      return unknown(entry, NOT_OBSERVABLE.PID_LOCK_UNREADABLE,
        `the pid lock for ${entry.id} could not be read while ${opaque.length} process command line(s) were also `
        + 'unreadable, so the process identity cannot be settled. This is NOT claiming the pid lock or process is absent.',
        { opaquePids: Object.freeze(opaquePids), lockedPid: null });
    }

    if (pid !== null && opaquePids.includes(pid)) {
      return unknown(entry, NOT_OBSERVABLE.COMMAND_LINE_UNREADABLE,
        `${entry.id} IS running as pid ${pid} (its declared pid lock says so) but Win32_Process returns a null `
        + 'CommandLine for it from this session, so its argv cannot be compared. This happens to every process '
        + 'launched by an S4U scheduled task. Elevation would settle it; guessing would not.',
        { opaquePids: Object.freeze(opaquePids), lockedPid: pid });
    }
    if (opaque.length > 0) {
      return unknown(entry, NOT_OBSERVABLE.COMMAND_LINE_UNREADABLE,
        `no READABLE command line contains ${entry.entryPattern}, but ${opaque.length} process(es) `
        + `(pid ${opaquePids.join(', ')}) returned a null CommandLine and could not be examined at all. `
        + `${entry.id} may be one of them. This is NOT a DOWN verdict and NOT a "not running" claim.`,
        { opaquePids: Object.freeze(opaquePids), lockedPid: pid });
    }
    return unknown(entry, NOT_OBSERVABLE.NO_MATCHING_PROCESS,
      `every command line in the process table was readable and none contains ${entry.entryPattern}, `
      + 'so there is no argv to compare. This is still NOT a DOWN verdict -- liveness is decided by the '
      + 'pid lock / port / task rungs, never here.',
      { opaquePids: Object.freeze([]), lockedPid: pid });
  }

  const candidates = [];
  for (const row of rows) {
    const tokens = tokenizeCommandLine(row.commandLine);
    const split = splitAtEntryPoint(tokens, entry.entryPattern);
    if (!split) {
      candidates.push({
        pid: row.pid, startedAt: row.startedAt || null, commandLine: row.commandLine,
        comparable: false, notObservable: NOT_OBSERVABLE.NO_ENTRY_POINT_TOKEN,
        reason: `the command line matched ${entry.entryPattern} but no single token ends with it, so its arguments cannot be located`
      });
      continue;
    }
    const comparison = compareArgv(entry.declaredArgv, split.args);
    candidates.push({
      pid: row.pid,
      startedAt: row.startedAt || null,
      commandLine: row.commandLine,
      comparable: true,
      entryPointToken: split.entryPointToken,
      observedArgv: comparison.observed,
      ...comparison
    });
  }

  const comparable = candidates.filter(candidate => candidate.comparable);
  if (comparable.length === 0) {
    return unknown(entry, NOT_OBSERVABLE.NO_ENTRY_POINT_TOKEN,
      `${rows.length} process(es) mention ${entry.entryPattern} but none could be split into arguments`,
      { candidates: Object.freeze(candidates) });
  }

  // AMBIGUITY RESOLVES TOWARD LOUD. With more than one live instance nobody can
  // say which is "the" declared process, so if ANY of them drifts the record
  // says DRIFT. A silently-drifted second instance is precisely the failure this
  // module exists to catch, and reporting MATCH because a sibling was fine would
  // hide it.
  const drifted = comparable.filter(candidate => !candidate.matched);
  const state = drifted.length > 0 ? DRIFT.DRIFT : DRIFT.MATCH;

  return Object.freeze({
    id: entry.id,
    displayName: entry.displayName,
    state,
    observable: true,
    notObservable: null,
    declaredArgv: Object.freeze([...entry.declaredArgv]),
    candidateCount: comparable.length,
    ambiguous: comparable.length > 1,
    candidates: Object.freeze(candidates),
    // Flattened view of the worst candidate, so a consumer that only wants one
    // answer does not have to walk the array.
    missing: Object.freeze([...(drifted[0] || comparable[0]).missing]),
    extra: Object.freeze([...(drifted[0] || comparable[0]).extra]),
    missingFlags: Object.freeze([...(drifted[0] || comparable[0]).missingFlags]),
    extraFlags: Object.freeze([...(drifted[0] || comparable[0]).extraFlags]),
    changedValues: Object.freeze([...(drifted[0] || comparable[0]).changedValues]),
    reason: state === DRIFT.MATCH
      ? `live argv for ${entry.id} matches every declared token`
      : describeDifference(entry, drifted[0])
  });
}

function describeDifference(entry, candidate) {
  const parts = [];
  if (candidate.missingFlags.length > 0) parts.push(`missing declared flag(s) ${candidate.missingFlags.join(' ')}`);
  const missingValuesOnly = candidate.missing.filter(token => !isFlag(token));
  if (missingValuesOnly.length > 0) parts.push(`missing value(s) ${missingValuesOnly.join(' ')}`);
  if (candidate.extraFlags.length > 0) parts.push(`undeclared flag(s) ${candidate.extraFlags.join(' ')}`);
  for (const change of candidate.changedValues) {
    parts.push(`${change.flag} declared ${JSON.stringify(change.declared)} but running ${JSON.stringify(change.observed)}`);
  }
  if (parts.length === 0) parts.push('token multiset differs from the declaration');
  return `live pid ${candidate.pid} ${parts.join('; ')}`;
}

// One human-readable line. Deliberately reports BOTH argv strings: this module
// does not know whether a drift is a deliberate override or a defect, and a
// reader cannot make that call without seeing both.
function describeDrift(record) {
  if (!record) return 'argv drift: no record';
  const head = `argv ${record.state}: ${record.id}`;
  if (record.state === DRIFT.UNKNOWN) return `${head} -- ${record.reason}`;
  if (record.state === DRIFT.MATCH) {
    return `${head} (pid ${record.candidates[0] && record.candidates[0].pid}) -- ${record.reason}`;
  }
  const worst = record.candidates.find(candidate => candidate.comparable && !candidate.matched);
  return [
    `${head} -- ${record.reason}`,
    `  declared: ${record.declaredArgv.join(' ')}`,
    `  running : ${(worst ? worst.observedArgv : []).join(' ')}`,
    '  Whether this drift is an intended override or a defect is a human decision.'
  ].join('\n');
}

// Collects the process table ONCE and compares every declared subsystem. The
// collector shells out to PowerShell, so a per-subsystem call would mean eight
// CIM queries per cycle.
function detectAllDrift({ processes, registryFile, root = managedProcesses.ROOT, collect = observer.collectProcesses } = {}) {
  const table = processes === undefined && typeof collect === 'function' ? collect() : processes;
  const records = {};
  for (const entry of managedProcesses.listProcesses(registryFile)) {
    records[entry.id] = detectDrift(entry.id, { processes: table, registryFile, root });
  }
  return {
    observedAtMs: Date.now(),
    processTableReadable: isReadableProcessTable(table),
    drifted: Object.values(records).filter(record => record.state === DRIFT.DRIFT).map(record => record.id),
    unknown: Object.values(records).filter(record => record.state === DRIFT.UNKNOWN).map(record => record.id),
    records
  };
}

module.exports = Object.freeze({
  DRIFT,
  NOT_OBSERVABLE,
  ROOT: managedProcesses.ROOT,
  compareArgv,
  describeDrift,
  detectAllDrift,
  detectDrift,
  normalizeArgv,
  tokenizeCommandLine
});

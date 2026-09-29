#!/usr/bin/env node
'use strict';

// Audit durability health check.
//
// Why this exists: audit.record() is deliberately fail-safe. When the canonical
// chain cannot be written it spools the event to emergency storage and returns
// { ok: false, durable: false, pending: 1 } instead of throwing, because
// throwing would take the whole system down on a transient lock. That is the
// right behaviour and this check does not change it. What was missing was any
// way to notice: non-durable writes spread over hours produced one stderr line
// each, no health state, and no alert.
//
// Two things make a window observable here that a naive probe would miss:
//   1. It reads the durability sidecar, which remembers a breach AFTER the
//      emergency spool has been drained. prepare() ingests the spool on the
//      very next record(), so spool depth alone reads green within seconds.
//   2. It clusters breaches into windows, so scattered failures that each
//      recover in seconds still surface as one long degraded period.
//
// It never takes the audit write lock and never triggers emergency ingestion,
// so it is safe to run against a live ledger on a schedule.
//
// Exit codes are distinct on purpose -- "I could not tell" must never be
// reported as "healthy":
//   0  ok        - nothing non-durable in the 7-day retention window
//   1  warn      - degraded, but NOT failing right now: either a mild open
//                  window, or a severe window that has since recovered
//   2  critical  - FAILING NOW: events spooled at this moment, or a severe
//                  window that is still open
//   3  unknown   - the state could not be read; NOT a healthy answer
//   4  error     - the check itself failed to run
//
// 2 MEANS "NOW", NOT "THIS WEEK". That distinction is the whole contract.
// Retention is 7 days and a severe window is only 5 breaches, so scoring
// state over the whole retention made one bad hour latch exit 2 for a week
// with no way to clear it. Callers consult this before an external write and
// read 2 as a live outage, so a recovered incident kept reading as a current
// one. History is still reported in full under `historical` -- it is the
// STATE that now answers "is it failing right now".

const audit = require('../src/lib/audit');

const EXIT = { ok: 0, disabled: 0, warn: 1, critical: 2, unknown: 3 };

function parseArgs(argv) {
  const options = { json: false, quiet: false, checkpoint: false, outboxDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--checkpoint') options.checkpoint = true;
    else if (arg === '--outbox-dir') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || !value.trim()) {
        process.stderr.write('audit-durability-check: --outbox-dir needs a directory\n');
        options.help = true;
        options.invalid = true;
      } else {
        options.outboxDir = value;
        index += 1;
      }
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      process.stderr.write(`audit-durability-check: unknown argument ${arg}\n`);
      options.help = true;
      options.invalid = true;
    }
  }
  return options;
}

async function emitCheckpoint(options) {
  try {
    const result = await audit.checkpoint(options.outboxDir ? { outboxDir: options.outboxDir } : {});
    const report = { ok: true, result };
    if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else if (result && result.disabled) process.stdout.write('audit checkpoint: disabled by policy\n');
    else process.stdout.write(`audit checkpoint: ${result && result.file ? result.file : 'emitted'}\n`);
    return 0;
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'AUDIT_CHECKPOINT_FAILED';
    const message = String((error && error.message) || error).slice(0, 500);
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, code, error: message })}\n`);
    else process.stderr.write(`audit checkpoint: ${code}: ${message}\n`);
    return 4;
  }
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function stamp(ms) {
  if (ms === null) return 'never';
  if (!Number.isSafeInteger(ms)) return 'unknown';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString();
}

function render(summary) {
  const lines = [`audit durability: ${String(summary.state).toUpperCase()}`];
  if (summary.disabled) {
    lines.push('  durable audit is disabled by policy');
    return lines.join('\n');
  }
  lines.push(`  spooled right now : ${summary.pendingEmergency === null ? 'UNREADABLE' : summary.pendingEmergency}`);
  lines.push(`  breaches retained : ${summary.breachCount} (lifetime ${summary.totalBreachCount})`);
  lines.push(`  last breach       : ${stamp(summary.lastBreachAtMs)}`);
  lines.push(`  last durable write: ${stamp(summary.lastDurableAtMs)}`);
  lines.push(`  state file        : ${summary.stateFile}${summary.stateFilePresent ? '' : ' (absent - no breach has been recorded)'}`);
  if (summary.current) {
    lines.push(`  FAILING NOW       : ${summary.current.failing ? 'YES' : 'no'}${summary.current.failing ? '' : summary.current.quietForMs === null ? '' : ` (quiet for ${duration(summary.current.quietForMs)})`}`);
    lines.push(`  refused ext.writes: ${summary.current.refusedExternalWrites} now / ${summary.historical ? summary.historical.refusedExternalWrites : '?'} in 7d`);
  }
  if (summary.historical) {
    lines.push(`  history (7d)      : ${summary.historical.breachCount} breach(es), ${summary.historical.severeWindowCount} severe window(s)`);
    // These are deliberately one sentence. New entries always record
    // requiredKnown, so provenance-unknown can honestly be zero while every
    // retained entry still lacks the failure code needed to explain WHY the
    // write went non-durable. Printing the zero alone looks like reassurance.
    lines.push(`  classification    : ${summary.historical.unknownProvenance} of ${summary.historical.breachCount} provenance unknown; `
      + `${summary.historical.unclassified} of ${summary.historical.breachCount} failure-code unclassified`);
  }
  if (summary.openWindow) {
    lines.push(`  OPEN window       : ${summary.openWindow.count} breach(es), ${duration(summary.openWindow.ageMs)} since ${stamp(summary.openWindow.startMs)}`);
  }
  for (const window of summary.windows || []) {
    lines.push(`  window            : ${window.count} breach(es) over ${duration(window.durationMs)} from ${stamp(window.startMs)}`);
  }
  for (const reason of summary.reasons || []) lines.push(`  ! ${reason}`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node tools/audit-durability-check.js [--json] [--quiet] [--checkpoint [--outbox-dir DIR]]\n');
    return options.invalid ? 4 : 0;
  }
  if (options.outboxDir && !options.checkpoint) {
    process.stderr.write('audit-durability-check: --outbox-dir is only valid with --checkpoint\n');
    return 4;
  }
  if (options.checkpoint) return emitCheckpoint(options);
  let summary;
  try {
    summary = audit.durability();
  } catch (error) {
    const message = error && error.message ? String(error.message).slice(0, 500) : String(error);
    if (options.json) process.stdout.write(`${JSON.stringify({ state: 'error', reasons: [message] })}\n`);
    else process.stderr.write(`audit durability: ERROR - the check could not run: ${message}\n`);
    return 4;
  }
  if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else if (!options.quiet || summary.state !== 'ok') process.stdout.write(`${render(summary)}\n`);
  return Object.prototype.hasOwnProperty.call(EXIT, summary.state) ? EXIT[summary.state] : 3;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 4;
  });
}

module.exports = { emitCheckpoint, main, parseArgs, render, duration };

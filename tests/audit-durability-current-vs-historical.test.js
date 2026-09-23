'use strict';
// THE DURABILITY CHECK MUST SAY "FAILING NOW", NOT "FAILED SOMETIME THIS WEEK".
//
// The defect, measured on this machine 2026-08-11: durabilitySummary() scored
// state over the whole 7-day retention window. A severe window is only 5
// breaches, so a single bad hour pinned `state: critical` -- exit code 2 from
// tools/audit-durability-check.js -- for seven days, and no amount of healthy
// operation could clear it before the window rolled.
//
// That matters because this check is what agents consult before an external
// write. Exit 2 reads as "the audit is broken right now", so a recovered
// incident kept presenting as a live outage: three lanes refused
// identity-bearing work against a ledger that was verifying clean and
// accepting every gated write.
//
// The second half of the same defect: a best-effort audit.record() that spools
// is recovered by the next prepare() and blocks nothing, whereas a
// requireRecord() failure REFUSES an external write. Both landed in the
// sidecar as one undifferentiated "breach", so a window made entirely of
// harmless post-hoc diagnostics was indistinguishable from external writes
// actually being refused. On the live installation that day, 198 of 200
// retained breaches were best-effort; the two that were not were hours old.
//
// These checks pin BOTH halves, and -- the point of the suite -- they pin them
// in the direction that can still fail. A summary that simply reported `ok`
// would pass a naive "does it clear" test; checks 1, 5 and 6 fail on it.
//
// Nothing here weakens the alarm: the retained history is still reported in
// full under `historical`, and a currently-open severe window is still
// critical. What changed is which question `state` answers.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const audit = require('../src/lib/audit');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 7, 11, 18, 0, 0);

const checks = [];
function check(name, run) { checks.push([name, run]); }

// The same guard tests/audit-lock-scope.test.js uses: the two suites that
// deliberately write a durability sidecar must never write the installation's.
function assertIsolatedLedger() {
  const ledger = process.env.TOOLSENABLED_AUDIT_DB;
  assert.ok(ledger && !path.resolve(ledger).endsWith(path.join('state', 'audit.sqlite3')),
    'this suite only ever runs against an isolated ledger; run it via tests/run-isolated.js');
}

function sidecarPath() {
  const emergency = process.env.TOOLSENABLED_AUDIT_EMERGENCY_PATH;
  assert.ok(emergency, 'the isolated environment must define TOOLSENABLED_AUDIT_EMERGENCY_PATH');
  return path.join(path.dirname(emergency), 'audit-durability.json');
}

// Plant a sidecar directly. This is the only way to exercise a 7-day-old
// window without waiting seven days, and it is confined to the isolated root.
function plant(breaches, { lastDurableAtMs = NOW } = {}) {
  assertIsolatedLedger();
  const file = sidecarPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    breaches: breaches.map(breach => ({
      atMs: breach.atMs,
      action: breach.action || 'probe.action',
      code: breach.code || null,
      message: breach.message || 'The audit ledger rejected a transaction.',
      spooled: breach.spooled !== false,
      ...(breach.required === undefined ? {} : { required: breach.required })
    })),
    totalBreachCount: breaches.length,
    lastDurableAtMs,
    updatedAtMs: NOW
  })}\n`);
}

function burst({ endMs, count, gapMs = MINUTE, required = false, action = 'mcp.tool.succeeded' }) {
  return Array.from({ length: count }, (_, index) => ({
    atMs: endMs - (count - 1 - index) * gapMs, required, action
  }));
}

function summarize() {
  return audit.durability({ clock: () => NOW });
}

// ---------------------------------------------------------------------------
// 1. THE CONTROL STILL FIRES. An open severe window is still critical.
//    If this suite only proved that things go green, it would be proving the
//    alarm had been disabled rather than corrected.
// ---------------------------------------------------------------------------
check('a severe window that is still open reports critical', () => {
  plant(burst({ endMs: NOW - MINUTE, count: 6 }));
  const summary = summarize();
  assert.equal(summary.state, 'critical', 'breaches one minute ago must still be critical');
  assert.equal(summary.current.failing, true, 'an open window is a current failure');
  assert.ok(summary.reasons.some(reason => /STILL OPEN/.test(reason)),
    'the reason must say the window is open, so a reader can tell now from history');
});

// ---------------------------------------------------------------------------
// 2. THE LATCH IS GONE. The same severe window, once quiet, must not be
//    critical -- this is the assertion the pre-fix build fails.
// ---------------------------------------------------------------------------
check('a severe window that has gone quiet reports warn, not critical', () => {
  plant(burst({ endMs: NOW - 3 * HOUR, count: 6 }));
  const summary = summarize();
  assert.notEqual(summary.state, 'critical',
    'a recovered incident must not keep reporting a live outage for the rest of the retention window');
  assert.equal(summary.state, 'warn', 'it is still degraded history, so it is not silently ok either');
  assert.equal(summary.current.failing, false, 'nothing is failing now');
  assert.ok(summary.reasons.some(reason => /HISTORICAL ONLY/.test(reason)),
    'the reason must name itself as history');
});

// ---------------------------------------------------------------------------
// 2b. "HISTORICAL ONLY" MUST STATE WHEN IT STOPS BEING TRUE. The reason
//     string already says how long writing has been quiet; a reader still
//     has to know DURABILITY_RETENTION_MS and do the arithmetic by hand to
//     learn when this stops mattering. State the clock instead of the
//     homework.
// ---------------------------------------------------------------------------
check('the historical-only reason states the clock time the warn expires', () => {
  const lastBreachAtMs = NOW - 3 * HOUR;
  plant(burst({ endMs: lastBreachAtMs, count: 6 }));
  const summary = summarize();
  const expiryIso = new Date(lastBreachAtMs + 7 * 24 * HOUR).toISOString();
  assert.ok(summary.reasons.some(reason => reason.includes(expiryIso)),
    'the HISTORICAL ONLY reason must state the exact clock time the warn expires, not just how long it has been quiet');
});

// ---------------------------------------------------------------------------
// 3. HISTORY IS REPORTED, NOT ERASED. Downgrading the state must not be
//    achieved by forgetting what happened.
// ---------------------------------------------------------------------------
check('a recovered incident is still fully reported in history', () => {
  plant(burst({ endMs: NOW - 3 * HOUR, count: 6 }));
  const summary = summarize();
  assert.equal(summary.historical.breachCount, 6, 'every retained breach is still counted');
  assert.equal(summary.historical.severeWindowCount, 1, 'the severe window is still identified as severe');
  assert.ok(summary.historical.worstWindow && summary.historical.worstWindow.count === 6,
    'the worst window is still described');
  assert.equal(summary.breachCount, 6, 'the pre-existing breachCount field is unchanged for existing readers');
});

// ---------------------------------------------------------------------------
// 4. A breach older than retention drops out entirely, as it always did.
// ---------------------------------------------------------------------------
check('a window older than the 7-day retention is no longer reported', () => {
  plant(burst({ endMs: NOW - 8 * 24 * HOUR, count: 6 }));
  const summary = summarize();
  assert.equal(summary.state, 'ok', 'nothing inside retention means ok');
  assert.equal(summary.historical.breachCount, 0, 'and nothing is retained');
});

// ---------------------------------------------------------------------------
// 5. BEST-EFFORT IS NOT A REFUSAL. An open window of spooled diagnostics must
//    report that nothing was refused, or a reader infers an outage from it.
// ---------------------------------------------------------------------------
check('an open window of best-effort spools reports zero refused external writes', () => {
  plant(burst({ endMs: NOW - MINUTE, count: 6, required: false }));
  const summary = summarize();
  assert.equal(summary.current.refusedExternalWrites, 0, 'no gated write failed');
  assert.equal(summary.historical.refusedExternalWrites, 0, 'and none failed in the week either');
  assert.ok(summary.reasons.some(reason => /no external write was refused/.test(reason)),
    'the summary must say so in words, not only in a field');
});

// ---------------------------------------------------------------------------
// 6. A REAL REFUSAL IS COUNTED. The distinction must not be one-directional:
//    a requireRecord() failure has to be visible as a refusal.
// ---------------------------------------------------------------------------
check('an open window containing a gated failure reports the refused write', () => {
  plant([
    ...burst({ endMs: NOW - 5 * MINUTE, count: 5, required: false }),
    { atMs: NOW - MINUTE, required: true, action: 'mcp.tool.intent' }
  ]);
  const summary = summarize();
  assert.equal(summary.current.refusedExternalWrites, 1, 'the gated failure is counted as a refusal');
  assert.equal(summary.state, 'critical', 'and an open severe window is still critical');
  assert.ok(summary.reasons.some(reason => /1 external write\(s\) were REFUSED/.test(reason)),
    'the refusal must be stated, not left to be derived');
});

// ---------------------------------------------------------------------------
// 7. END TO END, AGAINST THE REAL WRITER. Everything above plants a sidecar;
//    this drives a genuine requireRecord() failure through record()'s own
//    catch and asserts the entry it writes carries required:true. Without
//    this, the producer and the reader could disagree and every check above
//    would still pass.
// ---------------------------------------------------------------------------
check('a genuine requireRecord failure is persisted as a refused external write', () => {
  assertIsolatedLedger();
  try { fs.rmSync(sidecarPath(), { force: true }); } catch { /* first run */ }

  assert.throws(
    () => audit.requireRecord('durability.gated', 'refused', { phase: 7 }, {
      setMonotonicSecret: () => { throw new Error('the vault refused the anchor write'); }
    }),
    error => error && error.name === 'AuditRequiredError',
    'a failed anchor write must still refuse the external mutation'
  );

  const planted = JSON.parse(fs.readFileSync(sidecarPath(), 'utf8'));
  const gated = planted.breaches.filter(breach => breach.required === true);
  assert.equal(gated.length, 1, 'the refused gated write must be marked required in the sidecar');
  assert.equal(gated[0].action, 'durability.gated', 'and must name the action that was refused');

  // And a best-effort record() beside it must NOT be marked required.
  audit.record('durability.besteffort', 'spooled', { phase: 7 }, {
    setMonotonicSecret: () => { throw new Error('the vault refused the anchor write'); }
  });
  const after = JSON.parse(fs.readFileSync(sidecarPath(), 'utf8'));
  const bestEffort = after.breaches.filter(breach => breach.action === 'durability.besteffort');
  assert.equal(bestEffort.length, 1, 'the best-effort failure is still recorded');
  assert.equal(bestEffort[0].required, false, 'but it is NOT a refused external write');
});

let failures = 0;
for (const [name, run] of checks) {
  try {
    run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL - ${name}\n  ${error && error.message}\n`);
  }
}
process.stdout.write(`\naudit-durability-current-vs-historical: ${checks.length - failures}/${checks.length} checks passed\n`);
process.exitCode = failures ? 1 : 0;

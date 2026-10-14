'use strict';
// SURFACING THE NEWEST BREACH CODE.
//
// durability.newest and durability.current.codes exist because neither
// audit.status() nor system.status() names WHICH code caused the most
// recent non-durable write, or how the codes inside the currently-open
// window break down -- only counts. Measured this session (see
// W4\REPORT-durability-warn-greenable.md, "LIVE STATUS UPDATE" and
// "AMENDMENT REVIEW" sections): a 12-breach AUDIT_SQLITE_ERROR burst and
// five required:true AUDIT_PROJECTION_DIVERGED refusals were both visible
// only as bare counts in system.status()'s own JSON, never by name.
//
// These checks assert the fields' BEHAVIOUR (what value they carry for a
// planted breach), never an implementation spelling.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const audit = require('../src/lib/audit');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 7, 11, 18, 0, 0);

const checks = [];
function check(name, run) { checks.push([name, run]); }

// Same guard as tests/audit-durability-current-vs-historical.test.js.
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

function summarize() {
  return audit.durability({ clock: () => NOW });
}

// ---------------------------------------------------------------------------
// 1. durability.newest carries the newest retained breach's own fields.
// ---------------------------------------------------------------------------
check('durability.newest reports the newest breach\'s own code, atMs, action, required and message', () => {
  const atMs = NOW - MINUTE;
  plant([{
    atMs, code: 'AUDIT_SQLITE_ERROR', required: false,
    action: 'coordinator.audit.policy.decision', message: 'The audit ledger rejected a transaction.'
  }]);
  const summary = summarize();
  assert.deepEqual(summary.newest, {
    code: 'AUDIT_SQLITE_ERROR', atMs, action: 'coordinator.audit.policy.decision',
    required: false, message: 'The audit ledger rejected a transaction.'
  }, 'newest must carry the planted breach\'s own five fields, unchanged');
});

// ---------------------------------------------------------------------------
// 2. current.codes counts every distinct code inside the OPEN window.
// ---------------------------------------------------------------------------
check('current.codes counts two different codes both inside the open window', () => {
  plant([
    { atMs: NOW - 2 * MINUTE, code: 'AUDIT_PROJECTION_DIVERGED', required: true },
    { atMs: NOW - MINUTE, code: 'AUDIT_SQLITE_ERROR', required: false }
  ]);
  const summary = summarize();
  assert.ok(summary.current.failing, 'both breaches are within the cluster gap of NOW, so a window is open');
  assert.deepEqual(summary.current.codes, { AUDIT_PROJECTION_DIVERGED: 1, AUDIT_SQLITE_ERROR: 1 },
    'each distinct code in the open window must be counted separately');
  assert.equal(summary.newest.code, 'AUDIT_SQLITE_ERROR', 'newest is still the later of the two');
});

// ---------------------------------------------------------------------------
// 3. A breach outside the open window still appears in `newest` (the
//    7-day-retention-scoped field) but never in `current.codes` (the
//    open-window-scoped field) -- the deliberate asymmetry from the spec.
// ---------------------------------------------------------------------------
check('a breach older than the open window appears in newest but not in current.codes', () => {
  const atMs = NOW - 3 * HOUR;
  plant([{ atMs, code: 'AUDIT_PROJECTION_DIVERGED', required: true }]);
  const summary = summarize();
  assert.equal(summary.current.failing, false, 'a 3-hour-old breach is well outside the 30-minute cluster gap');
  assert.equal(summary.newest.code, 'AUDIT_PROJECTION_DIVERGED', 'newest still names it -- it is the only retained breach');
  assert.deepEqual(summary.current.codes, {}, 'current.codes is empty: there is no open window to scope it to');
});

// ---------------------------------------------------------------------------
// 4. The genuinely-clean case: no retained breach at all.
// ---------------------------------------------------------------------------
check('durability.newest is null when nothing is retained', () => {
  plant([]);
  const summary = summarize();
  assert.strictEqual(summary.newest, null, 'an empty sidecar has no newest breach to report');
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL - ${name}: ${error && error.message || error}`); }
}
console.log(`audit-durability-newest-breach: ${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exitCode = 1;

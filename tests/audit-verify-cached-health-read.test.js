'use strict';

// A HEALTH POLL MUST NOT COST A FULL LEDGER WALK EVERY TIME.
//
// system-status.js's auditState() is what system.status and system.doctor
// return, and both are polled. It called audit.verify(), which is deliberately
// uncached -- a complete chain-and-signature walk of every live event. On the
// owner's install (10,019 live rows) that is 1.6 s, paid on every poll, on the
// same single-writer ledger that every tool call has to get through. Measured
// there: system.status p50 9.6 s, system.doctor p50 21.9 s.
//
// verify({ cached: true }) is the opt-in that lets a health read reuse the
// verification the write path already trusts. What these checks pin:
//
//  1. It is the SAME ANSWER. A cheaper health check that could disagree with
//     the authoritative one would be worse than a slow one.
//  2. It actually avoids the walk -- asserted on the counters, not on a clock,
//     because a wall-clock threshold on a loaded machine manufactures failures.
//  3. The `audit.verify` TOOL still does the full walk. Someone asking the
//     product to verify the ledger is asking for the signatures to be checked.
//  4. It still reports invalid when the ledger really is invalid; the cache
//     must never be able to hold a stale "valid" over a broken ledger.

const assert = require('node:assert/strict');
const path = require('node:path');
const audit = require('../src/lib/audit');

const checks = [];
function check(name, run) { checks.push([name, run]); }

// These checks append to whatever ledger the runner points at. Only ever an
// isolated one -- tests/run-isolated.js redirects the ledger, projections,
// spool and vault into a scratch root.
function assertIsolatedLedger() {
  const ledger = process.env.TOOLSENABLED_AUDIT_DB;
  assert.ok(ledger && !path.resolve(ledger).endsWith(path.join('state', 'audit.sqlite3')),
    'this suite only ever runs against an isolated ledger; run it via tests/run-isolated.js');
}

function seed(n = 3) {
  assertIsolatedLedger();
  for (let i = 0; i < n; i += 1) audit.record('verifycached.seed', 'probe', { i });
}

check('the cached health read returns the same verdict as the authoritative walk', () => {
  seed(3);
  const full = audit.verify();
  const cached = audit.verify({ cached: true });
  assert.equal(full.valid, true, `precondition: the seeded ledger must verify: ${full.reason || ''}`);
  assert.equal(cached.valid, full.valid, 'a cached health read must not disagree about validity');
  assert.equal(cached.entries, full.entries, 'it must describe the same ledger');
  assert.equal(cached.headSequence, full.headSequence, 'it must describe the same head');
});

check('the cached health read does not walk the ledger again', () => {
  seed(2);
  audit.verify();                       // warm: pays the full walk once
  const before = audit.verificationStats();
  assert.ok(before && Number.isInteger(before.fullVerifications),
    'verificationStats() must expose integer counters or this check proves nothing');

  const result = audit.verify({ cached: true });
  const after = audit.verificationStats();

  assert.equal(result.valid, true);
  assert.equal(after.fullVerifications, before.fullVerifications,
    `a warm cached health read must add no full walk; went ${before.fullVerifications} -> ${after.fullVerifications}`);
  assert.ok(['cache-hit', 'incremental'].includes(after.lastResult),
    `the cached read must be served by the cache or the incremental path, saw ${after.lastResult}`);
});

check('the audit.verify tool still pays for a real signature walk', () => {
  seed(2);
  audit.verify();
  const before = audit.verificationStats();
  audit.verify();                       // no options: the tool's own call shape
  const after = audit.verificationStats();
  assert.equal(after.fullVerifications, before.fullVerifications + 1,
    'verify() with no options must remain a full walk every time it is asked');
  assert.equal(after.lastResult, 'full');
});

check('a cached health read still reports an invalid ledger as invalid', () => {
  assertIsolatedLedger();
  seed(2);
  audit.verify();
  const store = require('../src/lib/audit-store').createAuditStore({ file: process.env.TOOLSENABLED_AUDIT_DB });
  try {
    // Rewrite a committed row's payload and leave its stored hash alone: the
    // chain recheck the incremental path performs is exactly what must catch
    // this, so a cached read cannot serve a remembered "valid" over it.
    const db = store._open();
    const row = db.prepare('SELECT sequence, event_json FROM audit_events ORDER BY sequence DESC LIMIT 1').get();
    const tampered = JSON.stringify({ ...JSON.parse(row.event_json), target: 'tampered-by-test' });
    db.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = ?').run(tampered, row.sequence);
  } finally { try { store.close(); } catch { /* best effort */ } }

  audit.resetForTests();
  const cached = audit.verify({ cached: true });
  assert.equal(cached.valid, false,
    'a rewritten event must fail a cached health read too -- the cache may never outlive the bytes it described');
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-verify-cached-health-read: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

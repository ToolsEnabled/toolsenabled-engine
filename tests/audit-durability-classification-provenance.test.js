// EXECUTABLE CHANGE
//
// CAN-FAIL AUDIT
// - FOUND (2): the spooled-state check asserted only that `summary.current`
//   was truthy. Mutation: immediately before the emergency-spool verdict in
//   src/lib/audit.js, replace a non-empty spool's `summary.current` with `{}`.
//   The unmodified test stayed GREEN (6/6). With the field assertion below the
//   mutation was rejected. RED output:
//     FAIL - a critical spooled state still reports current and historical
//       the current-health block must still report that this open window is failing
// - NOT-FOUND (1): the runner loop cannot be empty because this file registers
//   six literal checks; `.some()` results are asserted directly, not iterated.
// - NOT-FOUND (3): the runner catch records every failure and makes the process
//   fail; there is no optional chain or failure-swallowing catch.
// - NOT-FOUND (4): injected secret access is a failing collaborator used to
//   produce a real audit breach; neither audit.durability nor render is mocked.
// - NOT-FOUND (5): isolation requirements are assertions that fail loudly, not
//   skips, and there is no platform guard.
// - NOT-FOUND (6): expected counts, booleans, text, and codes are independent
//   literals rather than values computed by the subject.
//
// RESTORATION: src/lib/audit.js was restored byte-for-byte after mutation. The
// restored run was GREEN:
//   audit-durability-classification-provenance: 6/6 checks passed
'use strict';
// A DURABILITY RECORD THAT CANNOT SAY WHICH FAILURE IT WAS MUST SAY SO.
//
// Measured on this installation 2026-08-11: 200 of 200 retained breaches
// carried `code: null` and `required: false`. The check reported
// "refused ext.writes: 0 now / 0 in 7d" as a finding. It was not a finding --
// it was the shape of a default. Every one of those entries had been written
// by a long-lived process still running an audit.js from before the
// classification fields existed (five mcp-server.js processes on this host had
// been up since 2026-08-09; the fields landed 2026-08-10 17:09), so nothing
// had ever looked, and the sidecar could not answer the only question it
// exists to answer: WHY writing went non-durable.
//
// Defaulting an absent field to the safe value is correct for COUNTING.
// Reporting that count as a fact about the population is the codebase's
// recurring absence-read-as-consent defect, and these checks pin the
// difference. They are written in the direction that can still fail: a build
// that silently folds unknown into false fails checks 1, 2 and 4.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const audit = require('../src/lib/audit');
const { render } = require('../tools/audit-durability-check');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 7, 11, 18, 0, 0);

const checks = [];
function check(name, run) { checks.push([name, run]); }

// The same guard the sibling durability suites use: a suite that deliberately
// writes a durability sidecar must never write the installation's.
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

// Plant a sidecar directly, omitting keys where the test means "this build
// never wrote that field" rather than "this build wrote false".
function plant(breaches) {
  assertIsolatedLedger();
  const file = sidecarPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    breaches: breaches.map(breach => ({
      atMs: breach.atMs,
      action: breach.action || 'mcp.tool.succeeded',
      message: breach.message || 'The audit ledger rejected a transaction.',
      spooled: breach.spooled !== false,
      ...(breach.code === undefined ? {} : { code: breach.code }),
      ...(breach.required === undefined ? {} : { required: breach.required })
    })),
    totalBreachCount: breaches.length,
    lastDurableAtMs: NOW,
    updatedAtMs: NOW
  })}\n`);
}

function readSidecar() {
  return JSON.parse(fs.readFileSync(sidecarPath(), 'utf8'));
}

function summarize() {
  return audit.durability({ clock: () => NOW });
}

// A record() that is guaranteed to fail, so the sidecar is read and rewritten.
// The anchor READ is on every admission path, unlike the anchor write, which
// only happens on a checkpoint -- so refusing the read is the reliable way to
// make a best-effort record() spool.
function forceBreach(action) {
  assertIsolatedLedger();
  const status = audit.record(action, 'probe', { phase: 1 }, {
    getSecret: () => { throw new Error('the vault refused the anchor read'); }
  });
  assert.equal(status.durable, false, 'the probe must actually have failed to be durable');
  return status;
}

// ---------------------------------------------------------------------------
// 1. AN ENTRY THAT PREDATES THE FIELD IS UNKNOWN, NOT PROVEN-HARMLESS.
// ---------------------------------------------------------------------------
check('breaches written before the classification fields are reported as unknown provenance', () => {
  plant([
    { atMs: NOW - 3 * HOUR },
    { atMs: NOW - 3 * HOUR + MINUTE },
    { atMs: NOW - 3 * HOUR + 2 * MINUTE }
  ]);
  const summary = summarize();
  assert.equal(summary.historical.breachCount, 3, 'all three are retained');
  assert.equal(summary.historical.refusedExternalWrites, 0, 'none can be shown to have refused a write');
  assert.equal(summary.historical.unknownProvenance, 3,
    'and the count of entries that question could not be answered for must be reported, not hidden behind the zero');
  assert.equal(summary.historical.unclassified, 3, 'none of them names a failure code either');
  assert.ok(summary.reasons.some(reason => /cannot say WHY/.test(reason)),
    'the summary must say in words that it cannot explain the failures');
});

// ---------------------------------------------------------------------------
// 2. AN OPEN WINDOW OF UNKNOWN-PROVENANCE BREACHES MUST NOT CLAIM SAFETY.
//    "no external write was refused" is a reassuring sentence and it must only
//    be printed when it was actually checked.
//
//    This runs before the check that forces a real breach: that one leaves an
//    event in the emergency spool, and a non-empty spool is critical on its
//    own and returns before the reason lines below are reached.
// ---------------------------------------------------------------------------
check('an open window of unknown-provenance breaches refuses to claim nothing was refused', () => {
  plant([
    { atMs: NOW - 2 * MINUTE },
    { atMs: NOW - MINUTE }
  ]);
  const summary = summarize();
  assert.equal(summary.current.failing, true, 'the window is open');
  assert.equal(summary.current.unknownProvenance, 2, 'neither breach recorded its provenance');
  assert.ok(!summary.reasons.some(reason => /^no external write was refused in the open window/.test(reason)),
    'the unqualified all-clear must not be printed over entries nobody classified');
  assert.ok(summary.reasons.some(reason => /not proof that none was/.test(reason)),
    'it must say instead that the absence of a known refusal is not proof of none');
});

// ---------------------------------------------------------------------------
// 3. THE UNKNOWN SURVIVES A REWRITE. noteDurabilityBreach reads the whole
//    sidecar and writes it back on every breach, so a default applied on read
//    becomes a fact on disk unless the absence round-trips.
// ---------------------------------------------------------------------------
check('an unknown provenance is not laundered into false by the next breach', () => {
  plant([{ atMs: NOW - 3 * HOUR, action: 'legacy.entry' }]);
  forceBreach('provenance.rewrite');

  const after = readSidecar();
  const legacy = after.breaches.find(breach => breach.action === 'legacy.entry');
  assert.ok(legacy, 'the inherited entry is still retained');
  assert.equal(legacy.required, null,
    'an entry whose provenance was never recorded must persist as null, not as a manufactured false');

  const fresh = after.breaches.find(breach => breach.action === 'provenance.rewrite');
  assert.ok(fresh, 'the new breach was recorded');
  assert.equal(fresh.required, false,
    'this build DID look at the new one, so its answer is a boolean fact');

  const summary = summarize();
  assert.equal(summary.historical.unknownProvenance, 1,
    'exactly the inherited entry stays unknown after the round trip');
});

// ---------------------------------------------------------------------------
// 3. CONTROL. An entry that genuinely recorded `required: false` is KNOWN, and
//    must not be swept into the unknown bucket -- otherwise the new signal
//    would be as useless as the old one, in the other direction.
// ---------------------------------------------------------------------------
check('an entry that recorded required=false is known, not unknown', () => {
  plant([
    { atMs: NOW - 3 * HOUR, required: false, code: 'AUDIT_SQLITE_ERROR' },
    { atMs: NOW - 3 * HOUR + MINUTE, required: true, code: 'AUDIT_SQLITE_ERROR' }
  ]);
  const summary = summarize();
  assert.equal(summary.historical.unknownProvenance, 0, 'both entries recorded their provenance');
  assert.equal(summary.historical.unclassified, 0, 'and both name a failure code');
  assert.equal(summary.historical.refusedExternalWrites, 1, 'exactly one refused an external write');
  assert.ok(!summary.reasons.some(reason => /cannot say WHY/.test(reason)),
    'a fully classified record must not claim it cannot explain itself');
});

// ---------------------------------------------------------------------------
// 4. AN ABSENT CODE AND AN EXPLICIT NULL CODE ARE BOTH "NO CLASSIFICATION",
//    and a code that is not a mechanical code is not one either.
// ---------------------------------------------------------------------------
check('unclassified counts absent, null, and non-mechanical codes alike', () => {
  plant([
    { atMs: NOW - 3 * HOUR, required: false },
    { atMs: NOW - 3 * HOUR + MINUTE, required: false, code: null },
    { atMs: NOW - 3 * HOUR + 2 * MINUTE, required: false, code: 'not a mechanical code' },
    { atMs: NOW - 3 * HOUR + 3 * MINUTE, required: false, code: 'AUDIT_SQLITE_ERROR' }
  ]);
  const summary = summarize();
  assert.equal(summary.historical.breachCount, 4);
  assert.equal(summary.historical.unclassified, 3,
    'three of the four name no usable failure code');
  assert.equal(summary.historical.unknownProvenance, 0,
    'a missing code is not a missing provenance; the two absences are tracked separately');
  const classificationLine = render(summary).split(/\r?\n/)
    .find(line => /^\s*classification\s*:/.test(line));
  assert.match(classificationLine,
    /0 of 4 provenance unknown; 3 of 4 failure-code unclassified/,
    'the provenance zero and failure-code absence must be one sentence so the zero cannot be read alone');
});

// ---------------------------------------------------------------------------
// 6. A SPOOLED EVENT IS CRITICAL, AND STILL CARRIES ITS HISTORY. The two
//    spool verdicts used to return before `current`/`historical` existed, so
//    the one state that most needed a week of context reported none of it.
// ---------------------------------------------------------------------------
check('a critical spooled state still reports current and historical', () => {
  plant([{ atMs: NOW - 3 * HOUR, action: 'legacy.entry' }]);
  forceBreach('provenance.spooled');
  const summary = summarize();
  assert.equal(summary.state, 'critical', 'an event in the emergency spool is still critical');
  assert.ok(summary.pendingEmergency > 0, 'and the spool is genuinely non-empty');
  assert.ok(summary.historical, 'history must not vanish exactly when it is most needed');
  assert.ok(summary.current, 'nor must the current-health block');
  assert.equal(summary.current.failing, true,
    'the current-health block must still report that this open window is failing');
  assert.equal(summary.historical.unknownProvenance, 1, 'the inherited entry is still unknown');
});

// ---------------------------------------------------------------------------
// 7. "COULD NOT LOOK" MUST NEVER STAND IN FOR A "NOT THERE" ALREADY MEASURED.
//    pendingEmergency and the breach-history sidecar are two independent
//    files with independent failure modes. Check 6's fix only reordered the
//    verdicts INSIDE the state-readable path; the state-UNREADABLE early
//    return above it still reported 'unknown' unconditionally, even when the
//    spool -- read successfully, moments earlier, in this same call -- was
//    positively non-empty. A genuinely active outage (events sitting outside
//    the canonical chain right now) read as merely "could not tell" whenever
//    the unrelated sidecar happened to be corrupt.
// ---------------------------------------------------------------------------
check('a spooled event is still critical even when the durability sidecar itself is unreadable', () => {
  forceBreach('provenance.spooled.sidecar-unreadable');
  // Corrupt the sidecar AFTER the breach recorded it, so the corruption --
  // not forceBreach()'s own rewrite -- is what summarize() below actually
  // reads.
  fs.writeFileSync(sidecarPath(), 'not valid json{{{\n');
  const summary = summarize();
  assert.equal(summary.stateReadable, false,
    'the sidecar must actually be unreadable for this case to mean anything');
  assert.ok(summary.pendingEmergency > 0, 'and the spool must be genuinely non-empty');
  assert.equal(summary.state, 'critical',
    'a positively-measured non-empty spool must report critical, not unknown, however the unrelated sidecar reads');
  assert.ok(summary.reasons.some(reason => reason.includes('audit event(s) are spooled')),
    'the reasons must name the active spool, not just the unreadable sidecar');
  assert.ok(summary.reasons.some(reason => reason.includes('could not be read')),
    'the sidecar unreadability must still be disclosed, not swallowed by the critical verdict');
});

// ---------------------------------------------------------------------------
// 8. THE SAME MASKING, MIRRORED. Check 7 pins the ordering when the spool is
//    the file that reads fine. The reverse combination is just as real: the
//    sidecar can independently confirm an OPEN, SEVERE non-durable window
//    while the emergency spool -- an unrelated file -- happens to be
//    unreadable at the exact moment this runs. `pendingEmergency === null`
//    must not stand in for "nothing is wrong" when the breach history,
//    read successfully, already says otherwise.
// ---------------------------------------------------------------------------
check('a confirmed severe window is still critical even when the emergency spool itself cannot be read', () => {
  plant([
    { atMs: NOW - 5 * MINUTE, required: true },
    { atMs: NOW - 4 * MINUTE, required: true },
    { atMs: NOW - 3 * MINUTE, required: true },
    { atMs: NOW - 2 * MINUTE, required: true },
    { atMs: NOW - MINUTE, required: true }
  ]);
  const emergencyPath = process.env.TOOLSENABLED_AUDIT_EMERGENCY_PATH;
  fs.mkdirSync(path.dirname(emergencyPath), { recursive: true });
  fs.writeFileSync(emergencyPath, '{}\n');
  // Only the emergency file's own read fails -- the durability-state sidecar
  // (a different path) still reads through the real fs untouched, so this
  // isolates exactly the one independent failure this case is about.
  const spoolUnreadableFs = new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'readFileSync') {
        return (file, ...rest) => {
          if (path.resolve(String(file)) === path.resolve(emergencyPath)) {
            throw new Error('simulated: emergency spool unreadable');
          }
          return target.readFileSync(file, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const summary = audit.durability({ clock: () => NOW, fs: spoolUnreadableFs });
  assert.equal(summary.pendingEmergency, null,
    'the spool must actually be unreadable for this case to mean anything');
  assert.ok(summary.openWindow, 'the sidecar must show a currently open window');
  assert.ok(summary.openWindow.count >= 5, 'and that window must actually meet the severe threshold');
  assert.equal(summary.state, 'critical',
    'a positively-confirmed severe open window must report critical, not unknown, however the unrelated spool reads');
  assert.ok(summary.reasons.some(reason => reason.includes('STILL OPEN')),
    'the reasons must name the active window, not just the unreadable spool');
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
process.stdout.write(`\naudit-durability-classification-provenance: ${checks.length - failures}/${checks.length} checks passed\n`);
process.exitCode = failures ? 1 : 0;

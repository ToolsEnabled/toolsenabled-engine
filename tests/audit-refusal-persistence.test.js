'use strict';

// E2 / R33, REFUSAL PERSISTENCE.
//
// The durability sidecar keeps at most MAX_DURABILITY_BREACHES (200) rows. A
// required:true breach is the one class that represents a real operation the
// person ASKED FOR and did not get -- a launch, a shell command, a policy
// decision -- and it is evicted by the same rolling window as the noisy
// best-effort spools. Measured 2026-09-07: totalBreachCount 440 against 200
// retained, so 240 rows are already gone, with no rotated or backup copy under
// capability\logs. That history cannot be made retrospective.
//
// Per W4\SPEC-refusal-persistence-20260907.md: required refusals get their own
// append-only record that is never evicted, and durabilitySummary carries the
// lifetime count BESIDE the windowed one, with "window" and "lifetime" in the
// names rather than only in a comment.
//
// The spec's RED shape is a required breach evicted behind 200 best-effort
// ones. This drives the REAL writer (noteDurabilityBreach) for all 201 rows
// rather than planting the sidecar by hand, so the eviction under test is the
// production eviction and not a fixture of it.
//
// Behaviour only: nothing here asserts a regex, a file format detail beyond
// what the spec names, or a spelling.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const audit = require('../src/lib/audit');

const MINUTE = 60 * 1000;
const NOW = Date.UTC(2026, 8, 7, 18, 0, 0);

let checks = 0;
const check = (label, fn) => {
  try { fn(); }
  catch (error) {
    error.message = `[${label}] ${error.message}`;
    throw error;
  }
  checks += 1;
};

// Same guard the neighbouring durability suites use: this file writes real
// sidecar rows, so it must never run against the live ledger.
function assertIsolatedLedger() {
  const ledger = process.env.TOOLSENABLED_AUDIT_DB;
  assert.ok(ledger && !path.resolve(ledger).endsWith(path.join('state', 'audit.sqlite3')),
    'this suite only ever runs against an isolated ledger; run it via tests/run-isolated.js');
}

function isolatedFiles() {
  const emergency = process.env.TOOLSENABLED_AUDIT_EMERGENCY_PATH;
  assert.ok(emergency, 'the isolated environment must define TOOLSENABLED_AUDIT_EMERGENCY_PATH');
  fs.mkdirSync(path.dirname(emergency), { recursive: true });
  return { emergency };
}

const FILES = (() => { assertIsolatedLedger(); return isolatedFiles(); })();
const LOG_DIR = path.dirname(FILES.emergency);
const SIDECAR = path.join(LOG_DIR, 'audit-durability.json');
const REFUSALS = path.join(LOG_DIR, 'audit-refusals.jsonl');

function reset() {
  for (const file of [SIDECAR, REFUSALS]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
}

function breach(atMs, { required = false, code = 'AUDIT_SQLITE_ERROR', action = 'probe.action' } = {}) {
  return {
    atMs,
    action,
    code,
    message: 'The audit ledger rejected a transaction.',
    spooled: !required,
    required
  };
}

function note(entry, dependencies = {}) {
  return audit.noteDurabilityBreach(FILES, entry, dependencies);
}

function summarize() {
  return audit.durability({ clock: () => NOW });
}

function refusalLines() {
  if (!fs.existsSync(REFUSALS)) return null;
  return fs.readFileSync(REFUSALS, 'utf8').split(/\r?\n/).filter(Boolean);
}

function sidecarRows() {
  return JSON.parse(fs.readFileSync(SIDECAR, 'utf8')).breaches;
}

// The scenario the spec describes, built once and reused: one required refusal,
// then 200 best-effort breaches that evict it from the rolling window.
const REQUIRED_AT = NOW - (500 * MINUTE);
const REQUIRED_CODE = 'AUDIT_PROJECTION_DIVERGED';
function evictedRequiredRefusal() {
  reset();
  note(breach(REQUIRED_AT, { required: true, code: REQUIRED_CODE, action: 'launch.execute' }));
  for (let i = 0; i < 200; i += 1) {
    note(breach(NOW - ((200 - i) * MINUTE)));
  }
}

function main() {
  check('premise: the required refusal really is evicted from the rolling window', () => {
    evictedRequiredRefusal();
    const rows = sidecarRows();
    assert.strictEqual(rows.length, 200, 'the sidecar must be full at its cap');
    assert.ok(!rows.some(row => row.required === true),
      'the required refusal must have been evicted, or this scenario proves nothing');
    const summary = summarize();
    // This is the LOSS, and it stays true after the fix: the windowed number
    // is honest about its own window. The fix adds a second number, it does
    // not silently change this one.
    assert.strictEqual(summary.historical.refusedExternalWrites, 0,
      'the windowed count must still report 0 -- the fix must not change what this field means');
    assert.strictEqual(summary.totalBreachCount, 201, 'the lifetime breach counter must still see all 201');
  });

  check('the evicted required refusal is still recorded, with its atMs and code', () => {
    evictedRequiredRefusal();
    const lines = refusalLines();
    assert.ok(lines !== null, 'a required refusal must leave a record that outlives the rolling window');
    assert.strictEqual(lines.length, 1, `exactly the one required refusal must be recorded; got ${lines.length}`);
    const row = JSON.parse(lines[0]);
    assert.strictEqual(row.atMs, REQUIRED_AT, 'the recorded refusal must carry the planted time');
    assert.strictEqual(row.code, REQUIRED_CODE, 'the recorded refusal must carry the planted code');
    assert.strictEqual(row.required, true, 'only required refusals belong in this record');
  });

  check('the summary carries a LIFETIME count beside the windowed one, named as such', () => {
    evictedRequiredRefusal();
    const summary = summarize();
    assert.strictEqual(summary.historical.refusedExternalWritesLifetime, 1,
      'the lifetime count must survive eviction, which is the entire point');
    // Two similar numbers in one object invite the confusion this exists to
    // remove, so assert they are genuinely different here and both present.
    assert.strictEqual(summary.historical.refusedExternalWrites, 0,
      'the windowed count is unchanged and still means "over the retained window"');
  });

  check('best-effort breaches are never written to the refusals record', () => {
    reset();
    for (let i = 0; i < 20; i += 1) note(breach(NOW - ((20 - i) * MINUTE)));
    const lines = refusalLines();
    assert.ok(lines === null || lines.length === 0,
      `only required:true breaches belong in the refusals record; got ${lines && lines.length}`);
    assert.strictEqual(summarize().historical.refusedExternalWritesLifetime, 0,
      'a run with no refusals must report a lifetime of zero, not unknown');
  });

  check('the record is append-only and uncapped: it outlives many windows', () => {
    reset();
    // Three required refusals separated by full windows of best-effort noise.
    const stamps = [];
    for (let round = 0; round < 3; round += 1) {
      const at = NOW - ((900 - (round * 300)) * MINUTE);
      stamps.push(at);
      note(breach(at, { required: true, code: REQUIRED_CODE }));
      for (let i = 0; i < 200; i += 1) note(breach(at + ((i + 1) * MINUTE)));
    }
    const lines = refusalLines();
    assert.strictEqual(lines.length, 3, 'every required refusal is kept; the record has no cap');
    assert.deepStrictEqual(lines.map(line => JSON.parse(line).atMs), stamps,
      'the record is append-only and in the order the refusals happened');
    assert.strictEqual(summarize().historical.refusedExternalWritesLifetime, 3);
  });

  check('a failed append never alters the refusal or the sidecar', () => {
    reset();
    note(breach(NOW - (10 * MINUTE)));
    const before = sidecarRows().length;
    // An fs whose append fails and whose every other operation works. The spec
    // is explicit: the append happens after the breach is already recorded and
    // must never throw into the refusal path.
    const brokenAppend = new Proxy(fs, {
      get(target, property) {
        if (property === 'appendFileSync') {
          return () => { throw new Error('simulated: the refusals record is not writable right now'); };
        }
        return target[property];
      }
    });
    const result = note(breach(NOW - (5 * MINUTE), { required: true, code: REQUIRED_CODE }), { fs: brokenAppend });
    assert.strictEqual(result, true,
      'a breach whose refusals-record append failed is still a recorded breach');
    const rows = sidecarRows();
    assert.strictEqual(rows.length, before + 1, 'the sidecar row must still have been written');
    assert.strictEqual(rows[rows.length - 1].required, true, 'and it must still be the required refusal');
  });

  check('an unreadable refusals record reports unknown, never zero', () => {
    reset();
    note(breach(NOW - (10 * MINUTE), { required: true, code: REQUIRED_CODE }));
    assert.strictEqual(summarize().historical.refusedExternalWritesLifetime, 1, 'premise: it reads 1 when readable');
    // Replace the file with a directory: present, but not readable as a file.
    fs.rmSync(REFUSALS, { force: true });
    fs.mkdirSync(REFUSALS, { recursive: true });
    try {
      const lifetime = summarize().historical.refusedExternalWritesLifetime;
      assert.notStrictEqual(lifetime, 0,
        '"could not look" must never be reported as "not there" -- 0 would be a lie about a lost refusal');
      assert.strictEqual(lifetime, null, 'an unreadable record is unknown');
    } finally {
      fs.rmSync(REFUSALS, { recursive: true, force: true });
    }
  });

  console.log(`Audit refusal persistence tests passed (${checks} checks).`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  reset();
}

'use strict';

// A PROJECTION FILE THAT DURABLY LEADS THE COMMITTED HEAD IS NOT CORRUPTION.
//
// MEASURED 2026-09-04 against a read-only copy of the owner's Live ledger
// (%APPDATA%\ToolsEnabled-Live\capability, engine 3d920d8 -- the build the
// owner actually runs). tests/fixtures/audit-live-projection-divergence-
// sanitized.json records that state's shape: archive boundary 8356, live
// window 10,053 events, head 18409, both sink cursors 18409, actions.jsonl
// 12.0 MB and actions.log 7.0 MB. capability\logs\audit-durability.json on the
// same install held totalBreachCount 389 with AUDIT_PROJECTION_DIVERGED still
// firing at 2026-09-04T04:11:36Z -- on a build that already contains 96fc6ec,
// the third fix for this bug family.
//
// WHY 96fc6ec DID NOT COVER IT. projectSinks() appends a sink's line with a
// plain durable fs append and only then marks the cursor, both inside the one
// writer transaction record() holds; the in-lock anchor reconciliation then
// reads the vault, which on this install spawns powershell.exe and can hold
// that transaction open for seconds. Every OTHER process in the fleet verifies
// its own admission OUTSIDE that lock (verifyAdmissionOutsideLock), so it reads
// a projection file that holds a line whose event is not committed yet -- and
// holds it STABLY, long enough that the retry guards (fresh external digest,
// trustedVerificationMatches) see nothing move and let the refusal through.
//
// 96fc6ec loosened the CURSOR comparison to `rows.length < cursor -
// boundarySequence`. Replayed on the owner's own state with the head rolled
// back by one, that is `10053 < 10052` -- false, so the loosened check passes.
// The refusal simply moved one clause to the right: projectionMatches()
// requires `rows.length <= events.length`, the same "durably ahead" condition
// re-tested absolutely, and it still threw
//   AUDIT_PROJECTION_DIVERGED { sink: 'jsonl', projectionLines: 10053, sinkCursor: 18408 }
// (evidence/F/lab-cases-before-after.txt).
//
// COST. On that same copy, one admission verification costs 3.2-3.5 ms with
// the store's trusted prefix intact and 3.1-4.4 s without it. The refusal path
// called invalidateVerificationCache(), so every following tool call paid the
// full O(N) chain walk -- a self-sustaining 100% CPU period on the main
// process. Both halves are pinned below.
//
// This file is deliberately structural: it rebuilds its own ledger with its own
// throwaway ed25519 key from the fixture's redacted shapes. No owner ledger
// bytes, paths, command lines, keys or signatures are reproduced.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'audit-live-projection-divergence-sanitized.json'), 'utf8'));

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: `audit-ed25519-${crypto.createHash('sha256').update(der).digest('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

function createHarness(label) {
  audit.resetForTests();
  audit.resetProjectionVerifyCache();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `audit-overhang-${label}-`));
  const databaseFile = path.join(directory, 'audit.sqlite3');
  const files = {
    jsonl: path.join(directory, 'actions.jsonl'),
    text: path.join(directory, 'actions.log'),
    emergency: path.join(directory, 'emergency.jsonl')
  };
  const store = createAuditStore({ file: databaseFile });
  const signer = testSigner();
  let anchor = null;
  let eventNumber = 0;
  let now = 1_700_000_000_000;
  const errors = [];
  const dependencies = {
    store,
    signer,
    anchorStore: { get: () => anchor, set: value => { anchor = value; } },
    loadPolicy: () => ({
      audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' }
    }),
    loadSettings: () => ({ values: {}, rejected: [] }),
    rootPath: (...parts) => path.join(directory, ...parts),
    env: {},
    clock: () => now++,
    eventIdFactory: () => `audit-overhang-${label}-${String(++eventNumber).padStart(5, '0')}`,
    reportError: message => errors.push(message)
  };
  const lines = sink => {
    const content = fs.readFileSync(files[sink], 'utf8');
    return content.length ? content.slice(0, -1).split('\n') : [];
  };
  return {
    dependencies, directory, databaseFile, errors, files, signer, store,
    // Replay the fixture's redacted shapes through the real admission path.
    recordFixture() {
      const statuses = [];
      for (const event of fixture.events) {
        const status = audit.record(event.action, event.target, event.details, dependencies);
        assert.equal(status.ok, true,
          `setting up the fixture window must succeed: ${JSON.stringify(status.errors)}`);
        statuses.push(status);
      }
      return statuses;
    },
    record(action = 'probe.write', details = { n: eventNumber }) {
      return audit.record(action, label, details, dependencies);
    },
    lines,
    // WHAT ANOTHER PROCESS SEES MID-TRANSACTION. projectSinks() has already
    // appended the head event's line to both files; the transaction that would
    // commit that event and its cursor mark has not committed. Reproduced here
    // by removing the committed row and rewinding the cursors, which leaves the
    // filesystem and the database in exactly the state a concurrent reader
    // observes -- byte for byte, no synthesized lines.
    rollBackCommittedHeadKeepingProjection() {
      store.close();
      const database = new DatabaseSync(databaseFile);
      const head = database.prepare('SELECT MAX(sequence) AS sequence FROM audit_events').get().sequence;
      const previous = database.prepare(
        'SELECT sequence, event_hash FROM audit_events WHERE sequence = ?').get(head - 1);
      database.exec(`DELETE FROM audit_events WHERE sequence = ${head}`);
      database.prepare('UPDATE audit_sink_state SET last_sequence = ?, last_hash = ?')
        .run(previous.sequence, previous.event_hash);
      database.close();
      return { head, committedHead: previous.sequence };
    },
    // A genuine ledger tamper: the canonical row itself is rewritten in place.
    tamperCommittedEvent() {
      store.close();
      const database = new DatabaseSync(databaseFile);
      const row = database.prepare(
        'SELECT sequence, event_json FROM audit_events ORDER BY sequence LIMIT 1 OFFSET 2').get();
      const payload = JSON.parse(row.event_json);
      payload.action = 'attacker.rewrote.this';
      database.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = ?')
        .run(JSON.stringify(payload), row.sequence);
      database.close();
      return row.sequence;
    },
    rewriteProjection(sink, rows) {
      fs.writeFileSync(files[sink], rows.length ? `${rows.join('\n')}\n` : '', 'utf8');
      audit.resetProjectionVerifyCache();
    },
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      audit.resetForTests();
      audit.resetProjectionVerifyCache();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function firstError(status) { return (status.errors || [])[0] || {}; }

const checks = [];
function check(name, run) { checks.push([name, run]); }

// ---------------------------------------------------------------------------
// 1. The divergence itself, from the owner's measured shape.
// ---------------------------------------------------------------------------

check('a projection line durably ahead of the committed head is tolerated, not refused as divergence', () => {
  const test = createHarness('ahead');
  try {
    test.recordFixture();
    const before = test.lines('jsonl').length;
    assert.equal(before, fixture.events.length,
      `the fixture window must project one line per event; measured ${before}`);

    const rolled = test.rollBackCommittedHeadKeepingProjection();
    assert.equal(test.lines('jsonl').length, before,
      'the projection keeps the head line -- a durable fs append is not inside SQLite\'s rollback scope');
    assert.equal(rolled.committedHead, rolled.head - 1, 'and the committed head is now one behind it');

    const status = test.record('probe.after_uncommitted_head');
    assert.notEqual(firstError(status).code, 'AUDIT_PROJECTION_DIVERGED',
      'THE LIVE FAILURE: a file one line ahead of the committed head must not be reported as a diverged '
      + `projection; measured ${JSON.stringify(status.errors)}`);
    assert.equal(status.ok, true,
      `and the admission must complete: ${JSON.stringify(status.errors)}`);
  } finally { test.cleanup(); }
});

check('the tolerated overhang is erased by the next projection pass, never read back as ledger truth', () => {
  const test = createHarness('erased');
  try {
    test.recordFixture();
    test.rollBackCommittedHeadKeepingProjection();
    const status = test.record('probe.heals');
    assert.equal(status.ok, true, `the admission must complete: ${JSON.stringify(status.errors)}`);

    // projectSinks()' own untrusted path rebuilds the file from the database,
    // so the uncommitted line is gone and every remaining line is a committed
    // event. That is what makes tolerating the overhang safe.
    const rows = test.lines('jsonl').map(line => JSON.parse(line));
    const database = new DatabaseSync(test.databaseFile);
    const committed = database.prepare('SELECT sequence, event_hash FROM audit_events ORDER BY sequence').all();
    database.close();
    assert.equal(rows.length, committed.length,
      `the projection must end up exactly the committed window; measured ${rows.length} vs ${committed.length}`);
    rows.forEach((row, index) => {
      assert.equal(row.sequence, committed[index].sequence, `row ${index} must be the committed sequence`);
      assert.equal(row.eventHash, committed[index].event_hash, `row ${index} must be the committed hash`);
    });
    assert.equal(audit.verify(test.dependencies).valid, true, 'and the ledger must still verify end to end');
  } finally { test.cleanup(); }
});

// ---------------------------------------------------------------------------
// 2. Fail-closed. None of these may become acceptable.
// ---------------------------------------------------------------------------

check('FAIL CLOSED: a projection BEHIND its cursor is still refused (durable content the file lost)', () => {
  const test = createHarness('behind');
  try {
    test.recordFixture();
    const rows = test.lines('jsonl');
    test.rewriteProjection('jsonl', rows.slice(0, rows.length - 1));

    const status = test.record('probe.after_truncation');
    assert.equal(status.ok, false, 'a projection missing durable content must not be admitted');
    assert.equal(firstError(status).code, 'AUDIT_PROJECTION_DIVERGED',
      `and it must refuse as a divergence: ${JSON.stringify(status.errors)}`);
  } finally { test.cleanup(); }
});

check('FAIL CLOSED: a forged tail line that is not a contiguous continuation is still refused', () => {
  const test = createHarness('forged-tail');
  try {
    test.recordFixture();
    const rows = test.lines('jsonl');
    const last = JSON.parse(rows[rows.length - 1]);
    // Sequence-contiguity is what separates "a writer mid-transaction" from
    // "somebody appended a line". This one skips ahead.
    test.rewriteProjection('jsonl', rows.concat([JSON.stringify({ ...last, sequence: last.sequence + 50 })]));

    const status = test.record('probe.after_forged_tail');
    assert.equal(status.ok, false, 'a stray appended line must not be admitted');
    assert.equal(firstError(status).code, 'AUDIT_PROJECTION_DIVERGED',
      `and it must refuse as a divergence: ${JSON.stringify(status.errors)}`);
  } finally { test.cleanup(); }
});

check('FAIL CLOSED: a rewritten row INSIDE the committed window is still refused', () => {
  const test = createHarness('rewritten-row');
  try {
    test.recordFixture();
    const rows = test.lines('jsonl');
    const target = Math.max(0, rows.length - 3);
    const payload = JSON.parse(rows[target]);
    payload.action = 'attacker.rewrote.this';
    rows[target] = JSON.stringify(payload);
    test.rewriteProjection('jsonl', rows);

    const status = test.record('probe.after_rewritten_row');
    assert.equal(status.ok, false, 'a rewritten projection row must not be admitted');
    assert.equal(firstError(status).code, 'AUDIT_PROJECTION_DIVERGED',
      `and it must refuse as a divergence: ${JSON.stringify(status.errors)}`);
  } finally { test.cleanup(); }
});

check('FAIL CLOSED: a genuinely tampered ledger row still refuses the durability gate', () => {
  const test = createHarness('tampered-ledger');
  try {
    test.recordFixture();
    const sequence = test.tamperCommittedEvent();

    const status = test.record('probe.after_ledger_tamper');
    assert.equal(status.ok, false, `rewriting canonical event ${sequence} must refuse the admission`);
    assert.equal(firstError(status).code, 'AUDIT_LEDGER_INVALID',
      `and it must refuse as an invalid ledger, not something softer: ${JSON.stringify(status.errors)}`);
    assert.equal(status.durable, false, 'nothing may be reported durable on a tampered ledger');
  } finally { test.cleanup(); }
});

// ---------------------------------------------------------------------------
// 3. Cost. A refusal must not turn every later tool call into a full pass.
// ---------------------------------------------------------------------------

check('a projection refusal keeps the store\'s trusted verification prefix (3 ms admissions, not 3 s)', () => {
  const test = createHarness('keeps-prefix');
  try {
    test.recordFixture();
    const rows = test.lines('jsonl');
    test.rewriteProjection('jsonl', rows.slice(0, rows.length - 1));

    const refused = test.record('probe.refused');
    assert.equal(firstError(refused).code, 'AUDIT_PROJECTION_DIVERGED', 'set-up: the admission must refuse');

    const cache = test.store.verificationCacheStatus();
    assert.equal(cache.cached, true,
      'a disagreeing projection FILE says nothing about the ledger chain: dropping the trusted prefix here '
      + 'is what made every following tool call pay a full O(N) signature walk (3.1-4.4 s measured on the '
      + `owner's ledger, against 3.2-3.5 ms with the prefix kept); measured ${JSON.stringify(cache.cached)}`);
  } finally { test.cleanup(); }
});

check('a stable divergence is decided once and then memoized, not re-parsed on every tool call', () => {
  const test = createHarness('memoized');
  try {
    test.recordFixture();
    const rows = test.lines('jsonl');
    test.rewriteProjection('jsonl', rows.slice(0, rows.length - 1));

    const first = test.record('probe.first');
    assert.equal(firstError(first).code, 'AUDIT_PROJECTION_DIVERGED', 'set-up: the first admission must refuse');
    assert.notEqual((firstError(first).details || {}).memoized, true,
      'the first refusal is the one that actually reads and parses the file');

    const second = test.record('probe.second');
    assert.equal(firstError(second).code, 'AUDIT_PROJECTION_DIVERGED',
      `the refusal must not weaken on repetition: ${JSON.stringify(second.errors)}`);
    assert.equal((firstError(second).details || {}).memoized, true,
      'and the second must be decided from the remembered verdict rather than re-reading and re-parsing both '
      + `projection files (0.64 s per call on the owner's 19 MB of projections); measured `
      + JSON.stringify(firstError(second).details));
  } finally { test.cleanup(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-projection-window-overhang: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

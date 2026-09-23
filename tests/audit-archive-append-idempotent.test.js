'use strict';

// A RETRIED ROLL MUST NOT DUPLICATE THE ROW IT ALREADY ARCHIVED.
//
// MEASURED on the live install (capability\state\audit-archive.jsonl): one
// retried sequence range holding 2-4 byte-identical duplicate lines per
// sequence, tapering either side of the window. rollOldestEventOut()
// (src/lib/audit-store.js) runs the archive-then-delete callback inside the
// caller's already-open admission transaction. When something LATER in that
// same transaction fails for an unrelated reason, the SQL DELETE rolls back
// but the durable fs append appendArchiveEvent() already made does not --
// the next admission attempt sees the same oldest row still live and
// re-archives it.
//
// This pins the write-side fix by BEHAVIOUR: drive a roll whose archive
// write succeeds, then fault something AFTER it in the same transaction
// (the projection rebuild's atomic rename -- a plain filesystem rename,
// same as the archive append itself, not part of the SQL transaction) so
// the roll's SQL rolls back while the archive line stays. Retry the same
// admission and assert the archive file still holds exactly one line for
// that sequence, not two.
//
// Deliberately does not touch verifyArchiveSegment() (the read side of this
// same finding, a separate lane) -- only rollOldestEventOut()/
// appendArchiveEvent() and the new archiveTailSequence() helper are
// exercised here.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const retentionPath = require.resolve('../src/lib/audit-retention');
const realRetention = require(retentionPath);
const testPolicy = realRetention.resolveRetention({ mode: 'events', value: realRetention.MINIMUM_EVENT_WINDOW });
const beforeRollCount = testPolicy.value + realRetention.eventWindowSlack(testPolicy.value);
require.cache[retentionPath].exports = Object.freeze({
  ...realRetention,
  resolvePreset: () => testPolicy
});

const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: `audit-ed25519-${crypto.createHash('sha256').update(der).digest('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

// A thin proxy over the real fs module that can be armed to fail exactly one
// renameSync call whose DESTINATION is one of the two projection files --
// the atomic-rename step writeAtomic() uses to publish a rebuilt jsonl/text
// projection. renameSync is also used elsewhere in the same admission (the
// durability sidecar, lock files); matching on destination is what keeps
// the fault aimed at the projection rebuild specifically and not one of
// those. Everything else delegates straight through, unchanged.
function faultableFs(projectionFiles) {
  const state = { armed: false, faults: 0 };
  const targets = new Set(projectionFiles);
  const proxy = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'renameSync') {
        return (...args) => {
          const destination = args[1];
          if (state.armed && targets.has(destination)) {
            state.armed = false;
            state.faults += 1;
            throw new Error('SIMULATED transient fault renaming a rebuilt projection file');
          }
          return target.renameSync(...args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return { proxy, state };
}

function createHarness(label) {
  audit.resetForTests();
  audit.resetProjectionVerifyCache();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `audit-archive-idempotent-${label}-`));
  const files = {
    jsonl: path.join(directory, 'actions.jsonl'),
    text: path.join(directory, 'actions.log'),
    emergency: path.join(directory, 'emergency.jsonl'),
    archive: path.join(directory, 'state', 'audit-archive.jsonl')
  };
  const store = createAuditStore({ file: path.join(directory, 'audit.sqlite3') });
  const signer = testSigner();
  const { proxy: faultFs, state: faultState } = faultableFs([files.jsonl, files.text]);
  let anchor = null;
  let eventNumber = 0;
  let now = 1_700_000_000_000;
  const dependencies = {
    store,
    signer,
    fs: faultFs,
    anchorStore: { get: () => anchor, set: value => { anchor = value; } },
    loadPolicy: () => ({
      audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' }
    }),
    loadSettings: () => ({ values: {}, rejected: [] }),
    rootPath: (...parts) => path.join(directory, ...parts),
    env: {},
    clock: () => now++,
    eventIdFactory: () => `audit-archive-idempotent-${label}-${String(++eventNumber).padStart(5, '0')}`,
    reportError: () => {}
  };
  return {
    dependencies, directory, files, signer, store,
    armRenameFault() { faultState.armed = true; },
    renameFaults() { return faultState.faults; },
    record(details = { n: eventNumber }) { return audit.record('probe.write', label, details, dependencies); },
    archiveSequenceCounts() {
      if (!fs.existsSync(files.archive)) return new Map();
      const content = fs.readFileSync(files.archive, 'utf8');
      const lines = content.length ? content.replace(/\n$/, '').split('\n') : [];
      const counts = new Map();
      for (const line of lines) {
        const row = JSON.parse(line);
        counts.set(row.sequence, (counts.get(row.sequence) || 0) + 1);
      }
      return counts;
    },
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      audit.resetForTests();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('a roll retried after a later unrelated fault in the same transaction archives each row exactly once, not once per retry', () => {
  const test = createHarness('retry');
  try {
    for (let i = 0; i < beforeRollCount; i += 1) {
      const status = test.record({ i });
      assert.equal(status.ok, true, `record ${i} must succeed to set up the case: ${JSON.stringify(status.errors)}`);
    }

    // The triggering record pushes total to beforeRollCount + 1, which is
    // `excess` = (beforeRollCount + 1) - testPolicy.value over the cap; a
    // single admission rolls its WHOLE excess in one pass (enforceRetention-
    // AfterAppend's own design, not a bug), so this one record's roll loop
    // archives `excess` rows -- all of them, durably -- before either
    // projection file is rebuilt. The fault fires on the first rebuild
    // rename after that loop, so the whole transaction (every one of those
    // SQL deletes, the boundary, both rebuilds) rolls back, but none of the
    // archive lines already written can be.
    const excess = (beforeRollCount + 1) - testPolicy.value;
    assert.ok(excess >= 2, `this case needs a multi-row roll to be a faithful reproduction; computed excess ${excess}`);

    test.armRenameFault();
    const firstFault = test.record({ triggersRoll: true });
    assert.equal(test.renameFaults(), 1, 'the first attempt must actually hit the armed fault');
    assert.equal(firstFault.ok, false, 'the faulted attempt must be reported as a failure, not swallowed');

    const afterFirst = test.archiveSequenceCounts();
    const archivedSequences = [...afterFirst.keys()].sort((a, b) => a - b);
    assert.equal(archivedSequences.length, excess,
      `the whole excess must have been archived by the first attempt's roll loop; expected ${excess}, got ${JSON.stringify(archivedSequences)}`);
    for (const seq of archivedSequences) {
      assert.equal(afterFirst.get(seq), 1, `sequence ${seq} must have exactly one archive line after the first faulted attempt`);
    }

    // Second attempt: retention is still over its cap (none of the deletes
    // committed), so this retries the SAME roll for the SAME rows. Pre-fix,
    // appendArchiveEvent() writes a second identical line for every one of
    // them here.
    test.armRenameFault();
    const secondFault = test.record({ triggersRoll: true });
    assert.equal(test.renameFaults(), 2, 'the second attempt must also hit the armed fault, or this case proves nothing');
    assert.equal(secondFault.ok, false, 'the second faulted attempt must also fail');

    const afterSecond = test.archiveSequenceCounts();
    for (const seq of archivedSequences) {
      assert.equal(afterSecond.get(seq), 1,
        `the retried roll must not duplicate the archive line for sequence ${seq}; measured ${afterSecond.get(seq)} copies`);
    }

    // Let the roll actually succeed now, then confirm the ledger recovered
    // and the archive still shows exactly one line per rolled sequence.
    const recovered = test.record({ afterFault: true });
    assert.equal(recovered.ok, true, `the ledger must recover once nothing is faulted: ${JSON.stringify(recovered.errors)}`);

    const afterRecovery = test.archiveSequenceCounts();
    for (const seq of archivedSequences) {
      assert.equal(afterRecovery.get(seq), 1, `still exactly one archive line for sequence ${seq} after recovery`);
    }
    const anyDuplicated = [...afterRecovery.entries()].filter(([, count]) => count > 1);
    assert.equal(anyDuplicated.length, 0, `no sequence in the archive may be duplicated at all; found ${JSON.stringify(anyDuplicated)}`);

    const verified = audit.verify(test.dependencies);
    assert.equal(verified.valid, true, `the live ledger must still verify end to end: ${JSON.stringify(verified)}`);
  } finally { test.cleanup(); }
});

// THE SAME GUARD, A DIFFERENT ORIGIN STORY.
//
// row.sequence <= tail is also what a fresh/re-genesised audit.sqlite3
// would produce if audit-archive.jsonl (a separate file, on a separate
// path, with no coupling to the DB except the signed boundary metadata
// that lives INSIDE the DB) survives that reset with an old, unrelated
// tail. Nothing in prepare()/genesis cross-checks the archive file's
// content against a fresh DB's sequence range -- readArchiveBoundary()
// only ever reads the small signed metadata record, never opens the
// archive file itself -- so this is a real, reachable state, not a
// hypothetical. Skipping on sequence alone there would delete rows from
// live (the roll's SQL half still runs) while silently never archiving
// them: loss the pre-fix code could not produce. These checks call
// appendArchiveEvent() directly against a synthetic pre-existing archive
// file -- the exported function's actual contract, not a simulation of
// how a real DB reset would reach it -- because that contract is exactly
// what is in question.

function archiveLine(overrides = {}) {
  const base = {
    sequence: 11, eventId: `audit-${crypto.randomUUID()}`, occurredAtMs: 1_700_000_000_000,
    eventJson: JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', action: 'probe', target: 'x', details: {} }),
    previousHash: 'a'.repeat(64), eventHash: 'b'.repeat(64),
    keyId: 'audit-ed25519-' + 'c'.repeat(64), signature: 'd'.repeat(88), createdAtMs: 1_700_000_000_000
  };
  return { ...base, ...overrides };
}

function seedArchive(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = rows.map(row => JSON.stringify(row) + '\n').join('');
  fs.writeFileSync(file, content);
}

check('appendArchiveEvent refuses rather than silently skips when the row behind the tail does not match what the archive already holds there', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-archive-behind-mismatch-'));
  const file = path.join(directory, 'audit-archive.jsonl');
  try {
    seedArchive(file, [
      archiveLine({ sequence: 10, eventHash: 'e10'.padEnd(64, '0') }),
      archiveLine({ sequence: 11, eventHash: 'e11'.padEnd(64, '0') }),
      archiveLine({ sequence: 12, eventHash: 'e12'.padEnd(64, '0') })
    ]);
    const before = fs.readFileSync(file, 'utf8');

    // Same sequence the file already holds (11), but a DIFFERENT eventHash --
    // exactly what a stale archive next to a reset DB would present: a
    // sequence number that collided by coincidence, not by retry.
    const mismatched = archiveLine({ sequence: 11, eventHash: 'f'.repeat(64) });
    assert.throws(
      () => audit.appendArchiveEvent(mismatched, { archiveFile: file }),
      error => error && error.code === 'AUDIT_ARCHIVE_BEHIND',
      'a sequence that collides with a different event at that position must refuse loudly, not skip silently'
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the archive file must be byte-for-byte unchanged after a refused write');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

check('appendArchiveEvent still skips silently -- correctly -- when the row behind the tail is verified byte-identical to what is already archived', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-archive-behind-match-'));
  const file = path.join(directory, 'audit-archive.jsonl');
  try {
    const rows = [
      archiveLine({ sequence: 10, eventHash: 'e10'.padEnd(64, '0') }),
      archiveLine({ sequence: 11, eventHash: 'e11'.padEnd(64, '0') }),
      archiveLine({ sequence: 12, eventHash: 'e12'.padEnd(64, '0') })
    ];
    seedArchive(file, rows);
    const before = fs.readFileSync(file, 'utf8');

    // Same sequence AND same eventHash as row 11 already on disk -- a
    // genuine retry of the same logical roll, the case this whole lane
    // exists to fix.
    const retry = archiveLine({ sequence: 11, eventHash: rows[1].eventHash });
    audit.appendArchiveEvent(retry, { archiveFile: file });
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a verified retry of an already-archived row must not change the file at all');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

check('appendArchiveEvent still appends normally when the row is genuinely new (ahead of the tail)', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-archive-new-row-'));
  const file = path.join(directory, 'audit-archive.jsonl');
  try {
    seedArchive(file, [archiveLine({ sequence: 10, eventHash: 'e10'.padEnd(64, '0') })]);
    const row = archiveLine({ sequence: 11, eventHash: 'e11'.padEnd(64, '0') });
    audit.appendArchiveEvent(row, { archiveFile: file });
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 2, 'a genuinely new row must be appended');
    assert.equal(JSON.parse(lines[1]).sequence, 11, 'the appended line must be the new row');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// A FIXED LOOKBEHIND WINDOW SIZED FOR "SMALL" LINES UNDERCOUNTS A REAL
// BATCH OF LARGE EVENTS.
//
// MEASURED on the live archive (Controller 4): 108,650,376 bytes over
// 82,807 lines = ~1,312 bytes/line average -- a fixed 2 MiB window (this
// lane's first amendment, commit 06041022) reaches back only ~1,600 lines,
// short of the 2000-row ceiling it was meant to cover, and every line
// embeds the full eventJson, bounded by MAX_EVENT_BYTES (audit-store.js),
// not "small". This check builds a batch of events near that real ceiling
// and retries a lookup for the batch's FIRST (earliest, furthest-back) row
// -- the one an undersized fixed window misses first.
const { MAX_EVENT_BYTES } = require('../src/lib/audit-store');

// Comfortably exceeds the OLD fixed 2 MiB window (2,097,152 bytes) while
// staying far under the new construction-derived hard ceiling
// (ARCHIVE_RETRY_BATCH_CEILING=2000 * ~66 KB/line =~ 126 MiB) -- this
// number only has to be big enough to prove the point, not the full 2000-
// row ceiling itself (which would cost ~126 MB of file per test run for
// no additional signal).
const LARGE_BATCH_ROWS = 40;
// archiveEventLine() runs the WHOLE line (framing fields plus eventJson,
// escaped, as a nested string) through canonicalJson()'s own MAX_EVENT_BYTES
// check -- confirmed by hitting AUDIT_EVENT_TOO_LARGE while sizing this
// constant. 1000 bytes of margin below the ceiling comfortably covers the
// measured framing (~530 bytes: sequence, eventId, timestamps, both
// hashes, keyId, signature, JSON punctuation) plus eventJson's own quote-
// escaping overhead (~25 bytes) when embedded as a string value.
const LARGE_EVENT_JSON_BYTES = MAX_EVENT_BYTES - 1000; // near the ceiling, still valid once framing is included

function largeEventJson() {
  // Pad a valid event object's `details.padding` field so the whole
  // eventJson string lands at LARGE_EVENT_JSON_BYTES exactly.
  const shell = { timestamp: '2026-01-01T00:00:00.000Z', action: 'probe', target: 'x', details: { padding: '' } };
  const shellBytes = Buffer.byteLength(JSON.stringify(shell), 'utf8');
  const padLength = Math.max(0, LARGE_EVENT_JSON_BYTES - shellBytes);
  shell.details.padding = 'x'.repeat(padLength);
  return JSON.stringify(shell);
}

check('a retried batch whose events sit near MAX_EVENT_BYTES is still found within the archive\'s own construction-derived lookbehind ceiling, not a fixed byte guess', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-archive-large-batch-'));
  const file = path.join(directory, 'audit-archive.jsonl');
  try {
    const rows = [];
    for (let sequence = 1; sequence <= LARGE_BATCH_ROWS; sequence += 1) {
      rows.push(archiveLine({
        sequence, eventJson: largeEventJson(),
        eventHash: crypto.createHash('sha256').update(`row-${sequence}`).digest('hex')
      }));
    }
    seedArchive(file, rows);
    const fileBytes = fs.statSync(file).size;
    assert.ok(fileBytes > 2 * 1024 * 1024,
      `this batch must exceed the old fixed 2 MiB window to prove the point; measured ${fileBytes} bytes for ${LARGE_BATCH_ROWS} rows`);

    // Retry the FIRST row -- the furthest back from the tail, and the one
    // an undersized fixed window misses first.
    const retry = archiveLine({ sequence: 1, eventJson: rows[0].eventJson, eventHash: rows[0].eventHash });
    // appendArchiveEvent() itself is exercised, not just the lookup helper,
    // so this pins the actual public contract this whole lane is about.
    audit.appendArchiveEvent(retry, { archiveFile: file });
    const after = fs.readFileSync(file, 'utf8');
    const afterLines = after.trimEnd().split('\n');
    assert.equal(afterLines.length, LARGE_BATCH_ROWS,
      `a verified retry this far back must still skip silently, not append a duplicate; measured ${afterLines.length} lines for ${LARGE_BATCH_ROWS} rows`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// END TO END, NOT JUST THE UNIT UNDER TEST.
//
// Worker 10's independent trace of this lane (W4\REPORT-archive-guard-
// second-reader-20260907.md) found that every check above calls
// appendArchiveEvent() directly against a synthetic archive and never
// exercises the real chain: AUDIT_ARCHIVE_BEHIND is thrown inside
// rollOldestEventOut()'s persist callback, before the SQL DELETE, and
// propagates unrelabelled up through rollArchiveOnce() and
// enforceRetentionAfterAppend() into the triggering record()'s own
// transaction -- so record() itself refuses, fails closed, and nothing
// about that admission (the delete, the new event, the boundary) commits.
// This check produces the real scenario with two real AuditStore instances
// -- one seeds a genuine archive by actually rolling, a second, completely
// independent store (the "DB was reset" case) is pointed at that same
// archive file and made to roll into it -- rather than asserting the
// propagation would happen; RED is not expected here (06041022 already
// gets this right structurally), the point is coverage of the path the
// unit checks above cannot reach.
check('a fresh store sharing an old archive file refuses end to end -- record() itself fails closed, nothing commits, the shared archive is untouched', () => {
  const seed = createHarness('behind-e2e-seed');
  const fresh = createHarness('behind-e2e-fresh');
  try {
    // Seed a REAL archive: roll `seed` past its cap once, so the archive
    // file holds genuine, signed content at sequences 1..excess.
    for (let i = 0; i < beforeRollCount; i += 1) {
      assert.equal(seed.record({ i }).ok, true, `seed record ${i} must succeed to set up the case`);
    }
    const seededRoll = seed.record({ triggersRoll: true });
    assert.equal(seededRoll.ok, true, `seeding the archive must itself succeed: ${JSON.stringify(seededRoll.errors)}`);
    assert.ok(fs.existsSync(seed.files.archive), 'the archive file must exist after seeding');
    const archiveBefore = fs.readFileSync(seed.files.archive, 'utf8');
    assert.ok(archiveBefore.length > 0, 'the seeded archive must actually hold content');

    // Point the FRESH, independent store's archive writes at the SAME
    // file -- the "DB reset next to an old archive" scenario, produced
    // directly with two real stores, not simulated.
    fresh.dependencies.archiveFile = seed.files.archive;

    for (let i = 0; i < beforeRollCount; i += 1) {
      const status = fresh.record({ i });
      assert.equal(status.ok, true, `fresh-store record ${i} must succeed to set up its own roll: ${JSON.stringify(status.errors)}`);
    }
    const preAttemptHead = fresh.store.status().headSequence;

    const refused = fresh.record({ triggersRoll: true });
    assert.equal(refused.ok, false, "the fresh store's roll must be refused, not silently admitted");
    // CAPTURED, not assumed: print every code record() actually returned,
    // in case something upstream (rollOldestEventOut's preservesClassification
    // check, or a wrapping AUDIT_ARCHIVE_ROLL_FAILED from a DIFFERENT throw
    // site) relabels this before it reaches the caller.
    console.log('  [captured] refused.errors codes:', refused.errors.map(entry => entry.code));
    const error = refused.errors.find(entry => entry.code === 'AUDIT_ARCHIVE_BEHIND');
    assert.ok(error, `record() itself must refuse as AUDIT_ARCHIVE_BEHIND, end to end: ${JSON.stringify(refused.errors)}`);

    // The shared archive file: byte-for-byte unchanged. The mismatch is
    // hit on the very first row of the roll, before this attempt's own
    // append ever runs.
    const archiveAfter = fs.readFileSync(seed.files.archive, 'utf8');
    assert.equal(archiveAfter, archiveBefore, 'the shared archive file must be byte-unchanged after the refused roll');

    // The fresh store's own live rows: intact. The whole transaction --
    // the DELETE, and the triggering event's own append -- rolled back
    // with the throw, so nothing was deleted and nothing new committed.
    const postAttemptHead = fresh.store.status().headSequence;
    assert.equal(postAttemptHead, preAttemptHead,
      `the fresh store must have deleted nothing and committed nothing new; before=${preAttemptHead} after=${postAttemptHead}`);

    // The sidecar: carries the same code and the archive-naming message.
    const state = audit.readDurabilityState(fresh.files, fresh.dependencies);
    const newest = state.breaches[state.breaches.length - 1];
    console.log('  [captured] sidecar newest breach:', JSON.stringify({ code: newest.code, message: newest.message }));
    assert.equal(newest.code, 'AUDIT_ARCHIVE_BEHIND', 'the sidecar breach must carry the same code record() refused with');
    assert.ok(/archive/i.test(newest.message || ''), `the sidecar message must name the archive; got ${JSON.stringify(newest.message)}`);
  } finally { seed.cleanup(); fresh.cleanup(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-archive-append-idempotent: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

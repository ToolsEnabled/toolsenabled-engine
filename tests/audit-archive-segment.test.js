'EXECUTABLE CHANGE';
'use strict';

// TEST-CAN-FAIL REPORT (testcanfail-tests-audit-archive-segment-test-js)
//
// Finding: the shorter-prefix check only asserted that tailSequence was not
// the original row count. A verifier that omitted the tail (undefined) still
// passed that assertion. The exact-prefix sequence and hash checks below make
// the returned boundary evidence complete.
//
// MUTATION: for a four-line `tampered-*` file, return tailSequence: undefined.
// Before strengthening, the complete file stayed green: "audit-archive-segment:
// 5/5 checks passed". After strengthening, RED was:
// "AssertionError [ERR_ASSERTION]: the verifier must report the exact tail
// sequence of the retained prefix, not merely something other than the boundary
// undefined !== 4" and "audit-archive-segment: 4/5 checks passed".
// MUTATION: for that same file, return tailHash: undefined. RED was:
// "AssertionError [ERR_ASSERTION]: the verifier must report the exact tail hash
// that a signed boundary comparison consumes" with "+ undefined", followed by
// "audit-archive-segment: 4/5 checks passed".
// Both mutations were restored byte-for-byte (matching SHA-256
// 0d54120a8f091610c6c769cf6d5a268e31bdf2bb68e965e34c932393611d1c4f).
// Restored-source GREEN: "audit-archive-segment: 5/5 checks passed".
//
// Census of the requested remaining shapes:
// NOT-FOUND (1) vacuous collection assertion: `cases` is a five-element local
// literal, and every other loop is test setup rather than an assertion loop.
// NOT-FOUND (2) exit-status/truthy-return-only evidence: this file spawns no
// process and makes no exit-status assertion.
// NOT-FOUND (3) swallowed failure: cleanup uses finally, and the runner catch
// counts failures and sets process.exitCode; there is no optional chaining.
// NOT-FOUND (4) mock of the subject: writer and verifier are the real exports.
// NOT-FOUND (5) skip/platform no-op: all five checks are registered without a
// precondition guard. Precondition met with Node 22.22.2; the default Node 20
// could not load node:sqlite (ERR_UNKNOWN_BUILTIN_MODULE).
// NOT-FOUND (6) same-code oracle: expected hashes/sequences come from the
// independently persisted signed ledger rows, not verifyArchiveSegment.

// THE ARCHIVE MUST BE VERIFIABLE ON ITS OWN, TO THE SAME STANDARD AS THE LIVE
// LEDGER -- NOT MERELY REACHABLE THROUGH THE BOUNDARY.
//
// Bounding the audit ledger (owner directive 2026-08-17) moves the oldest
// events out of the live SQLite table into a flat, append-only cold-storage
// file. A signed boundary roots the live chain above wherever the archive
// ends, but the boundary only vouches for the archive's TAIL -- it says
// nothing about whether the bytes in between are what was actually signed.
// That is verifyArchiveSegment()'s job, and it has to hold up under the same
// tamper table _verifySnapshot is tested against, because an archive that
// LOOKS complete but silently accepts edited history would still let legal's
// "any auditor can run a complete verification and every signature checks"
// claim quietly become false for anything old enough to have been archived.
//
// This suite drives the writer and verifier directly against a real,
// in-process signed ledger -- never the production database or vault.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { canonicalJson, createAuditStore } = require('../src/lib/audit-store');
const { appendArchiveEvent, verifyArchiveSegment } = require('../src/lib/audit');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-archive-segment-'));
  return { dir, dbFile: path.join(dir, 'a.sqlite3'), archiveFile: path.join(dir, 'archive.jsonl'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: `audit-ed25519-${crypto.createHash('sha256').update(der).digest('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

function archiveRow(row) {
  return {
    sequence: row.sequence, eventId: row.event_id, occurredAtMs: row.occurred_at_ms,
    eventJson: row.event_json, previousHash: row.previous_hash, eventHash: row.event_hash,
    keyId: row.key_id, signature: row.signature, createdAtMs: row.created_at_ms
  };
}

function buildArchivedLedger(space, count = 4) {
  const signer = testSigner();
  const store = createAuditStore({ file: space.dbFile });
  store.registerKey(signer);
  for (let i = 1; i <= count; i += 1) {
    store.appendEvent({
      event: { timestamp: new Date(i).toISOString(), action: 'probe', target: 't', details: { i } },
      occurredAtMs: i, createdAtMs: i, eventId: crypto.randomUUID()
    }, signer);
  }
  store.close();
  const raw = new DatabaseSync(space.dbFile);
  const rows = raw.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
  const keyRows = raw.prepare('SELECT * FROM audit_keys').all();
  raw.close();
  for (const row of rows) appendArchiveEvent(archiveRow(row), { archiveFile: space.archiveFile });
  const keys = keyRows.map(k => ({
    keyId: k.key_id, publicKeyPem: k.public_key_pem, publicKeyHash: k.public_key_hash, algorithm: k.algorithm
  }));
  return { signer, rows, keys };
}

function tamperedCopy(space, mutate) {
  const lines = fs.readFileSync(space.archiveFile, 'utf8').replace(/\n$/, '').split('\n').map(l => JSON.parse(l));
  mutate(lines);
  const out = path.join(space.dir, `tampered-${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(out, lines.map(l => `${JSON.stringify(l)}\n`).join(''), 'utf8');
  return out;
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('an untouched archive verifies, and its tail matches the live chain it came from', () => {
  const space = scratch();
  try {
    const { rows, keys } = buildArchivedLedger(space);
    const result = verifyArchiveSegment(space.archiveFile, keys);
    assert.equal(result.valid, true, `a clean archive must verify: ${JSON.stringify(result)}`);
    assert.equal(result.entries, rows.length);
    assert.equal(result.tailSequence, rows[rows.length - 1].sequence);
    assert.equal(result.tailHash, rows[rows.length - 1].event_hash,
      'the archive tail must be exactly the hash the boundary is supposed to root against');
  } finally { space.cleanup(); }
});

check('an archive that has never been written to (nothing rolled yet) is valid and empty', () => {
  const space = scratch();
  try {
    const result = verifyArchiveSegment(space.archiveFile, []);
    assert.equal(result.valid, true);
    assert.equal(result.entries, 0);
  } finally { space.cleanup(); }
});

check('the tamper table: every one of the live ledger\'s attacks, replayed against cold storage', () => {
  const space = scratch();
  try {
    const { keys } = buildArchivedLedger(space);
    const cases = [
      ['edit content, leave eventHash stale', lines => {
        lines[1].eventJson = canonicalJson({ timestamp: '2000-01-01T00:00:00.000Z', action: 'evil', target: 't', details: {} });
      }, 'event-hash'],
      ['edit previousHash', lines => { lines[2].previousHash = 'f'.repeat(64); }, 'previous-hash'],
      ['delete a middle line', lines => { lines.splice(1, 1); }, 'sequence-gap'],
      ['replace every signature with junk', lines => {
        for (const line of lines) line.signature = Buffer.alloc(64, 0x41).toString('base64');
      }, 'signature'],
      ['non-canonical eventJson', lines => { lines[0].eventJson = lines[0].eventJson.replace('"action"', '"action" '); }, 'event-json-canonical']
    ];
    for (const [label, mutate, expectedReason] of cases) {
      const file = tamperedCopy(space, mutate);
      const result = verifyArchiveSegment(file, keys);
      assert.equal(result.valid, false, `${label}: must be refused`);
      assert.equal(result.reason, expectedReason, `${label}: wrong reason (${JSON.stringify(result)})`);
    }
  } finally { space.cleanup(); }
});

check('key material substituted under the derived key id is refused, same as the live ledger', () => {
  const space = scratch();
  try {
    const { signer, keys } = buildArchivedLedger(space);
    const attacker = crypto.generateKeyPairSync('ed25519');
    const attackerDer = attacker.publicKey.export({ type: 'spki', format: 'der' });
    const substituted = keys.map(k => k.keyId === signer.keyId ? {
      ...k,
      publicKeyPem: attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      publicKeyHash: crypto.createHash('sha256').update(attackerDer).digest('hex')
    } : k);
    const result = verifyArchiveSegment(space.archiveFile, substituted);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'public-key-identity');
  } finally { space.cleanup(); }
});

check('an archive rewritten wholesale to a shorter, internally-consistent prefix is still refused via the boundary', () => {
  // verifyArchiveSegment alone cannot see this -- a shorter but fully
  // self-consistent archive verifies on its own terms. What catches it is the
  // caller comparing the returned tail against the SIGNED boundary, which is
  // exactly what the roll (BUILD 3's remaining piece) must do before trusting
  // an archive read back from disk. Pinning the shape of that requirement
  // here, even though the wiring itself is not built yet.
  const space = scratch();
  try {
    const { rows, keys } = buildArchivedLedger(space, 6);
    const shorterButValid = tamperedCopy(space, lines => { lines.length = 4; });
    const result = verifyArchiveSegment(shorterButValid, keys);
    assert.equal(result.valid, true, 'a truncated-but-internally-consistent prefix verifies on its own -- expected');
    assert.notEqual(result.tailSequence, rows.length,
      'and that is exactly why a caller must compare the tail against the signed boundary, not trust verifyArchiveSegment alone');
    assert.equal(result.tailSequence, rows[3].sequence,
      'the verifier must report the exact tail sequence of the retained prefix, not merely something other than the boundary');
    assert.equal(result.tailHash, rows[3].event_hash,
      'the verifier must report the exact tail hash that a signed boundary comparison consumes');
  } finally { space.cleanup(); }
});

// A retried retention roll can leave the exact same archived line appended
// twice: appendArchiveEvent() is a plain fs write outside the SQL
// transaction that deletes the live row, so a roll that gets far enough to
// write the archive line and then has its enclosing transaction rolled back
// (a later busy/lock error, an outer admission retry) re-selects the same
// still-live oldest row on retry and re-archives it byte-for-byte. That is
// benign -- the same signed content, twice -- but the walker below used to
// treat the second copy as a sequence gap, so a benign retry made the whole
// archive read as corrupt.
check('a byte-identical repeat of the immediately preceding archived line is tolerated as a no-op', () => {
  const space = scratch();
  try {
    const { rows, keys } = buildArchivedLedger(space);
    const duplicated = tamperedCopy(space, lines => { lines.splice(2, 0, { ...lines[1] }); });
    const result = verifyArchiveSegment(duplicated, keys);
    assert.equal(result.valid, true, `a byte-identical repeat must not read as a sequence gap: ${JSON.stringify(result)}`);
    assert.equal(result.entries, rows.length + 1, 'entries still counts the physical line the repeat occupies');
    assert.equal(result.tailSequence, rows[rows.length - 1].sequence,
      'the tolerated repeat must not shift the reported tail away from the true chain end');
    assert.equal(result.tailHash, rows[rows.length - 1].event_hash,
      'the tolerated repeat must not shift the reported tail hash away from the true chain end');
  } finally { space.cleanup(); }
});

check('a repeat that differs from the line it repeats by even one byte is still refused', () => {
  const space = scratch();
  try {
    const { keys } = buildArchivedLedger(space);
    const file = tamperedCopy(space, lines => {
      const original = lines[1];
      const flippedLastChar = original.signature.slice(-1) === 'A' ? 'B' : 'A';
      const repeat = { ...original, signature: original.signature.slice(0, -1) + flippedLastChar };
      lines.splice(2, 0, repeat);
    });
    const result = verifyArchiveSegment(file, keys);
    assert.equal(result.valid, false,
      `a repeat that differs from its original by even one byte must still be refused: ${JSON.stringify(result)}`);
  } finally { space.cleanup(); }
});

// THE LIVE SHAPE: REPEATED BLOCKS, NOT REPEATED LINES.
//
// Worker 6's full census of the live archive (W4/REPORT-archive-duplicates-
// full-20260907.md, all 512 duplicated sequences, every copy byte-identical)
// found copy 2 of a repeated sequence ~501 lines after copy 1 -- the width
// of the retried retention-roll batch, not the next line -- with copy 3 and
// copy 4 further batches out, and a taper at each edge where fewer waves
// covered the same sequence. A fixture that only repeats one line adjacent
// to itself (the checks above) does not exercise that shape at all.
// WRITTEN AS A RAW DUPLICATED FILE, NOT THROUGH THE WRITE SIDE.
//
// appendArchiveEvent()/rollOldestEventOut() are the WRITE side of this pair
// (Worker 9's lane, landing alongside this fix) and are expected to make a
// retry idempotent by sequence -- i.e. to stop producing a duplicated file
// in the first place. This suite's job is the READ side: prove
// verifyArchiveSegment tolerates a duplicated file regardless of how it came
// to exist, so it must build one directly rather than depend on the write
// path still being willing to write the same sequence twice. Wave 1 is
// written once through the real writer, to capture the exact canonical line
// text for each sequence (so a signed line stays a real, verifiable line);
// every later wave is a raw fs.appendFileSync of that SAME text, bypassing
// appendArchiveEvent (and whatever idempotency guard it or the roll path
// enforces) entirely.
function buildWaveDuplicatedArchive(space, rows, waveRanges) {
  const file = path.join(space.dir, `wave-${crypto.randomUUID()}.jsonl`);
  const [firstWave, ...laterWaves] = waveRanges;
  const [firstFrom, firstTo] = firstWave;
  for (const row of rows) {
    if (row.sequence >= firstFrom && row.sequence <= firstTo) appendArchiveEvent(archiveRow(row), { archiveFile: file });
  }
  const canonicalLineBySequence = new Map(
    fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').map(line => [JSON.parse(line).sequence, line])
  );
  for (const [from, to] of laterWaves) {
    for (const row of rows) {
      if (row.sequence >= from && row.sequence <= to) {
        fs.appendFileSync(file, `${canonicalLineBySequence.get(row.sequence)}\n`, 'utf8');
      }
    }
  }
  const expectedLines = waveRanges.reduce((sum, [from, to]) => sum + (to - from + 1), 0);
  const actualLines = fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').length;
  assert.equal(actualLines, expectedLines,
    `fixture setup: the raw-duplicated file must physically hold every wave's line, repeats included -- built ${actualLines}, expected ${expectedLines}`);
  return file;
}

// wave 1: every sequence 1-30 (one pass). wave 2: 6-25 (2nd copy). wave 3:
// 9-22 (3rd copy). wave 4: 12-19 (4th copy, the fully-quadruplicated core).
// So 1-5/26-30 appear once, 6-8/23-25 appear twice, 9-11/20-22 three times,
// 12-19 four times -- the same taper shape as the live census, at a size a
// unit test can run in milliseconds instead of minutes.
const LIVE_SHAPE_WAVES = [[1, 30], [6, 25], [9, 22], [12, 19]];

check('the live shape -- a retried batch re-archiving a whole taper of sequences, none of it adjacent -- verifies', () => {
  const space = scratch();
  try {
    const { rows, keys } = buildArchivedLedger(space, 30);
    const file = buildWaveDuplicatedArchive(space, rows, LIVE_SHAPE_WAVES);
    const result = verifyArchiveSegment(file, keys);
    assert.equal(result.valid, true, `a live-shaped taper of byte-identical repeats must verify: ${JSON.stringify(result)}`);
    const expectedLines = LIVE_SHAPE_WAVES.reduce((sum, [from, to]) => sum + (to - from + 1), 0);
    assert.equal(result.entries, expectedLines, 'entries counts every physical line, repeats included');
    assert.equal(result.tailSequence, rows[rows.length - 1].sequence,
      'none of the repeated waves may shift the reported tail');
    assert.equal(result.tailHash, rows[rows.length - 1].event_hash,
      'none of the repeated waves may shift the reported tail hash');
  } finally { space.cleanup(); }
});

check('in the live shape, a repeated copy that differs from its original by even one byte is still refused', () => {
  const space = scratch();
  try {
    const { rows, keys } = buildArchivedLedger(space, 30);
    const file = buildWaveDuplicatedArchive(space, rows, LIVE_SHAPE_WAVES);
    // Line index of wave 2's copy of sequence 10: wave 1 is 30 lines (0-29);
    // wave 2 starts at sequence 6, so sequence 10 is the 5th line of wave 2,
    // index 30 + (10 - 6) = 34.
    const lines = fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').map(l => JSON.parse(l));
    assert.equal(lines[34].sequence, 10, 'fixture assumption: wave 2 copy of sequence 10 sits at index 34');
    const flippedLastChar = lines[34].signature.slice(-1) === 'A' ? 'B' : 'A';
    lines[34] = { ...lines[34], signature: lines[34].signature.slice(0, -1) + flippedLastChar };
    fs.writeFileSync(file, lines.map(l => `${JSON.stringify(l)}\n`).join(''), 'utf8');
    const result = verifyArchiveSegment(file, keys);
    assert.equal(result.valid, false,
      `a repeated copy altered by one byte, deep inside a live-shaped taper, must still be refused: ${JSON.stringify(result)}`);
  } finally { space.cleanup(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-archive-segment: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

'use strict';

// "audit.verify: ok" HAS NEVER SAID ANYTHING ABOUT THE ARCHIVE.
//
// verify() chain-walks the live window, matches the two live projection
// sinks, reconciles the anchor, and counts the emergency backlog -- and stops
// there. The archive boundary it roots the live chain against is itself a
// signed claim, and reconcileAnchor/readArchiveBoundary already confirm THAT
// signature -- but that only proves the boundary was minted by this
// installation's key, not that the bytes sitting in audit-archive.jsonl
// between genesis and that boundary still match what was actually signed.
// Nothing before this flag existed ever opened that file
// (W4/REPORT-archive-verify-exposure-20260907.md, method 1-3 + a scheduler
// scan, all agreeing: zero production callers of verifyArchiveSegment).
//
// includeArchive is opt-in and off by default specifically so the
// system.status/system.doctor poller (audit.verify({cached:true}) on a
// timer) and every other existing caller keep paying nothing and see no
// shape change -- the whole point of the `'archive' in result` assertions
// below.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// configuredRetention() (src/lib/audit.js) only accepts a settings-store
// value that names a preset LABEL (audit-retention.js#resolvePreset), and the
// smallest shipped preset is 10,000 events -- far too many to drive a roll
// here. Same override tests/audit-retention-roll-fault-recovery.test.js
// already established: replace the cached module audit.js is about to
// require with one whose resolvePreset() always returns the module's own
// floor (MINIMUM_EVENT_WINDOW, 100 events), so a real roll -- through the
// real audit.record() admission path, not a hand-built store -- is reachable
// without inventing a new customer-facing preset.
const retentionPath = require.resolve('../src/lib/audit-retention');
const realRetention = require(retentionPath);
const testPolicy = realRetention.resolveRetention({ mode: 'events', value: realRetention.MINIMUM_EVENT_WINDOW });
const testSlack = realRetention.eventWindowSlack(testPolicy.value);
const rollAtCount = testPolicy.value + testSlack + 1;
// An event-mode window rolls its WHOLE excess in one pass (audit-
// retention.js), and the plan only fires once the window is over by more
// than its slack -- so the first crossing always rolls exactly slack+1
// events, never one, regardless of how small the floor is made.
const firstRollExcess = testSlack + 1;
require.cache[retentionPath].exports = Object.freeze({ ...realRetention, resolvePreset: () => testPolicy });

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

function createHarness(label) {
  audit.resetForTests();
  audit.resetProjectionVerifyCache();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `audit-verify-archive-${label}-`));
  const store = createAuditStore({ file: path.join(directory, 'audit.sqlite3') });
  const signer = testSigner();
  let anchor = null;
  let now = 1_700_000_000_000;
  let eventNumber = 0;
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
    eventIdFactory: () => `audit-verify-archive-${label}-${String(++eventNumber).padStart(5, '0')}`,
    reportError: () => {}
  };
  return {
    dependencies, directory, store, signer,
    archiveFile: path.join(directory, 'state', 'audit-archive.jsonl'),
    record(details) { return audit.record('probe.write', label, details || {}, dependencies); },
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      audit.resetForTests();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

// One event over the window: rollAtCount is exactly the count at which the
// retention plan fires and rolls exactly one event out (the plan only fires
// once the window is over by more than its slack -- see audit-retention.js
// -- and event-mode windows resolve their whole excess in one pass, which at
// the first crossing is exactly 1).
function seedThroughOneRoll(test) {
  for (let i = 0; i < rollAtCount; i += 1) {
    const status = test.record({ i });
    assert.equal(status.ok, true, `record ${i} must succeed to set up the fixture: ${JSON.stringify(status.errors)}`);
  }
  assert.ok(fs.existsSync(test.archiveFile), 'fixture setup: a roll must have happened by now');
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('verify({includeArchive:true}) returns an archive field; without the flag, no field at all', () => {
  const test = createHarness('presence');
  try {
    seedThroughOneRoll(test);
    const plain = audit.verify(test.dependencies);
    assert.equal(plain.valid, true, `precondition: the ledger must verify: ${JSON.stringify(plain)}`);
    assert.equal('archive' in plain, false, 'without the flag, no archive field -- existing callers see no shape change');

    const withArchive = audit.verify({ ...test.dependencies, includeArchive: true });
    assert.equal(withArchive.valid, true, `the archived event is genuine and untampered: ${JSON.stringify(withArchive)}`);
    assert.ok(withArchive.archive, 'includeArchive:true must return an archive field');
    assert.equal(withArchive.archive.valid, true);
    assert.equal(withArchive.archive.entries, firstRollExcess,
      'the first crossing rolls its whole excess (slack + 1) in one pass, not one event at a time');
    assert.equal(withArchive.archive.boundaryMatches, true,
      'the archive tail must match the signed boundary that roots the live chain');
  } finally { test.cleanup(); }
});

// THE RED THIS FILE EXISTS TO NAME: verify() reports valid with no archive
// complaint even when the archive on disk has been tampered with, because
// nothing before this flag ever looked.
check('a tampered archive line is caught only when includeArchive is asked for', () => {
  const test = createHarness('tamper');
  try {
    seedThroughOneRoll(test);
    const lines = fs.readFileSync(test.archiveFile, 'utf8').replace(/\n$/, '').split('\n').map(l => JSON.parse(l));
    // Flip a character well clear of any trailing base64 '=' padding -- a
    // padding byte can be replaced without changing the decoded signature at
    // all, which would make this fixture assert nothing.
    const mid = Math.floor(lines[0].signature.length / 2);
    const flippedMidChar = lines[0].signature[mid] === 'A' ? 'B' : 'A';
    lines[0] = { ...lines[0], signature: lines[0].signature.slice(0, mid) + flippedMidChar + lines[0].signature.slice(mid + 1) };
    fs.writeFileSync(test.archiveFile, lines.map(l => `${JSON.stringify(l)}\n`).join(''), 'utf8');

    const plain = audit.verify(test.dependencies);
    assert.equal(plain.valid, true,
      `THE EXPOSURE GAP, pinned: without the flag, a tampered archive is not caught at all: ${JSON.stringify(plain)}`);
    assert.equal('archive' in plain, false);

    const withArchive = audit.verify({ ...test.dependencies, includeArchive: true });
    assert.equal(withArchive.valid, false, `with the flag, the same tamper must be caught: ${JSON.stringify(withArchive)}`);
    assert.equal(withArchive.archive.valid, false);
  } finally { test.cleanup(); }
});

check('boundaryMatches catches an archive that is internally consistent on its own but no longer what the signed boundary claims', () => {
  const test = createHarness('boundary-mismatch');
  try {
    seedThroughOneRoll(test);
    // Push the live window over its cap again so a SECOND roll happens,
    // moving the boundary to name a later sequence -- then truncate the
    // archive file back to just its first line. That one line is still a
    // perfectly valid, internally-consistent one-entry chain from genesis
    // (verifyArchiveSegment alone would pass it -- audit-archive-
    // segment.test.js's "rewritten wholesale to a shorter, internally-
    // consistent prefix" case pins exactly this shape), but it is no longer
    // the archive the CURRENT boundary claims exists.
    for (let i = 0; i < 10; i += 1) {
      assert.equal(test.record({ i }).ok, true);
    }
    const lines = fs.readFileSync(test.archiveFile, 'utf8').replace(/\n$/, '').split('\n');
    assert.ok(lines.length >= 2, `fixture setup: a second roll must have happened by now, saw ${lines.length} archived line(s)`);
    fs.writeFileSync(test.archiveFile, `${lines[0]}\n`, 'utf8');

    const withArchive = audit.verify({ ...test.dependencies, includeArchive: true });
    assert.equal(withArchive.archive.valid, true,
      `the truncated prefix must still verify on its own terms: ${JSON.stringify(withArchive.archive)}`);
    assert.equal(withArchive.archive.boundaryMatches, false,
      'the truncated archive no longer matches the signed boundary, which now names a later event');
    assert.equal(withArchive.valid, false,
      'a mismatched boundary must fail the overall verify() result, not just be reported and ignored');
  } finally { test.cleanup(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-verify-include-archive: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

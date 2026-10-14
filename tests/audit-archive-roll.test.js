'use strict';

// THE ROLL IS THE ONLY OPERATION IN THE AUDIT SYSTEM THAT DELETES EVIDENCE.
//
// Everything else in this subsystem only ever appends. Bounding the ledger
// (owner directive 2026-08-17: a customer machine must not be taxed forever,
// and the ledger must stay fully auditable) requires the oldest event to
// physically leave audit_events -- so this is the one path where a bug loses
// an audit record permanently rather than merely reporting one wrongly.
//
// What these cases pin, in order of how badly they would hurt:
//
//  1. ORDERING. The archive file must be durable BEFORE the live row is
//     deleted. A crash in between must leave the event in both places
//     (recoverable duplicate), never in neither (permanent loss).
//  2. ATOMICITY. The delete and the new signed boundary must commit together.
//     A ledger whose boundary disagrees with what was actually archived is
//     either unverifiable or, worse, quietly accepts a gap.
//  3. END-TO-END VERIFIABILITY. After rolling, the live ledger must still
//     verify when rooted at the new boundary -- and must still FAIL when
//     rooted at genesis, because that is the truncation detection this whole
//     mechanism must not cost.
//  4. REFUSALS. Never empty the ledger; never archive an event a projection
//     sink has not caught up to, which would strand that sink permanently.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuditStore } = require('../src/lib/audit-store');
const audit = require('../src/lib/audit');
const {
  rollArchiveOnce, verifyArchiveSegment, verifiedArchiveBoundary,
  readArchiveBoundary, ARCHIVE_BOUNDARY_METADATA_KEY
} = audit;

function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: `audit-ed25519-${crypto.createHash('sha256').update(der).digest('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, privateKey)
  };
}

// A ledger with `count` events whose projection sinks are fully caught up, so
// the sink guard is satisfied and the roll is actually reachable.
function ledger(count = 5) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-archive-roll-'));
  const dbFile = path.join(dir, 'a.sqlite3');
  const archiveFile = path.join(dir, 'archive.jsonl');
  const signer = testSigner();
  const store = createAuditStore({ file: dbFile });
  store.registerKey(signer);
  const events = [];
  for (let i = 1; i <= count; i += 1) {
    const appended = store.appendEvent({
      event: { timestamp: new Date(i).toISOString(), action: 'probe', target: 't', details: { i } },
      occurredAtMs: i, createdAtMs: i, eventId: crypto.randomUUID()
    }, signer).event;
    events.push(appended);
    for (const sink of ['jsonl', 'text']) {
      store.markSinkSuccess({ sink, sequence: appended.sequence, eventHash: appended.eventHash, updatedAtMs: i });
    }
  }
  return {
    dir, dbFile, archiveFile, signer, store, events,
    deps: { archiveFile, clock: () => 1 },
    keys: () => {
      const raw = new DatabaseSync(dbFile);
      const rows = raw.prepare('SELECT * FROM audit_keys').all();
      raw.close();
      return rows.map(k => ({ keyId: k.key_id, publicKeyPem: k.public_key_pem, publicKeyHash: k.public_key_hash, algorithm: k.algorithm }));
    },
    liveSequences: () => {
      const raw = new DatabaseSync(dbFile);
      const rows = raw.prepare('SELECT sequence FROM audit_events ORDER BY sequence').all().map(r => r.sequence);
      raw.close();
      return rows;
    },
    cleanup() { try { store.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('one roll moves exactly one event: out of the live table, into the archive, with a signed boundary', () => {
  const test = ledger(5);
  try {
    const result = rollArchiveOnce(test.store, test.signer, test.deps, { nowMs: 1 });
    assert.equal(result.rolled, true, `the roll must happen: ${JSON.stringify(result)}`);
    assert.equal(result.sequence, 1, 'the OLDEST event is the one that leaves');
    assert.deepEqual(test.liveSequences(), [2, 3, 4, 5], 'exactly one row leaves the live table');

    const archived = verifyArchiveSegment(test.archiveFile, test.keys());
    assert.equal(archived.valid, true, 'the archive must verify on its own');
    assert.equal(archived.entries, 1);
    assert.equal(archived.tailHash, test.events[0].eventHash, 'the archived event is the one that was removed');

    const boundary = verifiedArchiveBoundary(result.boundary, test.signer);
    assert.ok(boundary, 'the minted boundary must be signed by this installation');
    assert.equal(boundary.archivedThroughSequence, 1);
    assert.equal(boundary.eventHash, test.events[0].eventHash,
      'the boundary must name the archived event, so the live chain has something to root against');
  } finally { test.cleanup(); }
});

check('after rolling, the live ledger verifies at the new boundary and STILL fails at genesis', () => {
  // This is the property the whole mechanism is judged on: bounding the ledger
  // must not cost front-truncation detection.
  const test = ledger(5);
  try {
    rollArchiveOnce(test.store, test.signer, test.deps, { nowMs: 1 });
    const stored = readArchiveBoundary(test.store, test.signer);
    assert.ok(stored, 'the boundary must have been persisted inside the same transaction as the delete');

    const rooted = test.store.verifyWithEvents({ boundary: stored });
    assert.equal(rooted.verification.valid, true,
      `rooted at its own boundary the rolled ledger must verify: ${JSON.stringify(rooted.verification)}`);

    const atGenesis = test.store.verifyWithEvents({ boundary: null });
    assert.equal(atGenesis.verification.valid, false,
      'without the boundary the missing oldest event must still read as truncation');
    assert.equal(atGenesis.verification.reason, 'sequence-gap');
  } finally { test.cleanup(); }
});

check('rolling repeatedly keeps the ledger verifiable at every step', () => {
  const test = ledger(6);
  try {
    for (let expected = 1; expected <= 3; expected += 1) {
      const result = rollArchiveOnce(test.store, test.signer, test.deps, { nowMs: 1 });
      assert.equal(result.rolled, true, `roll ${expected} must succeed: ${JSON.stringify(result)}`);
      assert.equal(result.sequence, expected, 'each roll takes the next-oldest event');

      const stored = readArchiveBoundary(test.store, test.signer);
      const rooted = test.store.verifyWithEvents({ boundary: stored });
      assert.equal(rooted.verification.valid, true,
        `the ledger must verify after roll ${expected}: ${JSON.stringify(rooted.verification)}`);
    }
    assert.deepEqual(test.liveSequences(), [4, 5, 6]);

    const archived = verifyArchiveSegment(test.archiveFile, test.keys());
    assert.equal(archived.valid, true, 'the accumulated archive must verify as one continuous chain');
    assert.equal(archived.entries, 3);
    assert.equal(archived.tailSequence, 3);
    // The archive tail and the live boundary must agree -- this is the
    // comparison that catches a wholesale-truncated archive, which the segment
    // verifier cannot detect on its own.
    const stored = readArchiveBoundary(test.store, test.signer);
    assert.equal(archived.tailSequence, stored.archivedThroughSequence,
      'archive tail and signed boundary must agree about how much was archived');
    assert.equal(archived.tailHash, stored.eventHash);
  } finally { test.cleanup(); }
});

check('the roll never empties the ledger', () => {
  const test = ledger(2);
  try {
    assert.equal(rollArchiveOnce(test.store, test.signer, test.deps, { nowMs: 1, minimumRetained: 2 }).rolled, false,
      'at the retention floor the roll must refuse');
    const single = ledger(1);
    try {
      const result = rollArchiveOnce(single.store, single.signer, single.deps, { nowMs: 1 });
      assert.equal(result.rolled, false, 'a one-event ledger can never be rolled empty');
      assert.equal(result.reason, 'window-not-exceeded');
      assert.deepEqual(single.liveSequences(), [1], 'and the event is still there');
    } finally { single.cleanup(); }
  } finally { test.cleanup(); }
});

check('the roll refuses to archive an event a projection sink has not caught up to', () => {
  // Archiving past a lagging sink strands it permanently: the events it still
  // needs would no longer exist in the live table to re-project from.
  const test = ledger(5);
  try {
    test.store.setSinkPosition({ sink: 'text', sequence: 0, eventHash: '0'.repeat(64), updatedAtMs: 1 });
    const result = rollArchiveOnce(test.store, test.signer, test.deps, { nowMs: 1 });
    assert.equal(result.rolled, false, 'a lagging sink must block the roll');
    assert.equal(result.reason, 'sink-behind');
    assert.equal(result.sink, 'text');
    assert.deepEqual(test.liveSequences(), [1, 2, 3, 4, 5], 'nothing may be deleted when the roll is refused');
    assert.equal(fs.existsSync(test.archiveFile) && fs.readFileSync(test.archiveFile, 'utf8').length > 0, false,
      'and nothing may be written to the archive either -- the guard runs before the durable write');
  } finally { test.cleanup(); }
});

check('a failure during the durable write leaves the event in the live ledger, never lost', () => {
  // The ordering guarantee, tested by forcing the dangerous case: if the
  // archive write throws, the transaction must roll back with the event still
  // present. Losing it here would be unrecoverable.
  const test = ledger(5);
  try {
    const exploded = () => {
      const brokenDeps = {
        archiveFile: test.archiveFile,
        appendFileSync: () => { throw new Error('disk full'); }
      };
      rollArchiveOnce(test.store, test.signer, brokenDeps, { nowMs: 1 });
    };
    // The diagnosis must survive the transaction. Without an AUDIT_* code the
    // rollback would relabel a full disk as "the audit ledger rejected a
    // transaction", sending an operator to debug SQLite instead of storage.
    assert.throws(exploded, error => {
      assert.equal(error.code, 'AUDIT_ARCHIVE_WRITE_FAILED',
        'a failed archive write must be reported as one, not as a generic ledger fault');
      assert.match(String(error.cause && error.cause.message), /disk full/,
        'and the underlying cause must be preserved');
      return true;
    });
    assert.deepEqual(test.liveSequences(), [1, 2, 3, 4, 5],
      'a failed archive write must NOT have deleted the live row');
    assert.equal(readArchiveBoundary(test.store, test.signer), null,
      'and must not have advanced the boundary');
    const stillValid = test.store.verifyWithEvents({ boundary: null });
    assert.equal(stillValid.verification.valid, true,
      'the untouched ledger must still verify at genesis, exactly as before the attempt');
  } finally { test.cleanup(); }
});

check('the boundary and the delete commit together, or not at all', () => {
  // If setMetadata succeeded but the delete did not (or vice versa), the
  // ledger and its boundary would disagree. Forcing the boundary write to
  // throw must leave BOTH un-done.
  const test = ledger(5);
  try {
    const original = test.store.setMetadata.bind(test.store);
    test.store.setMetadata = () => { throw new Error('metadata write refused'); };
    try {
      assert.throws(() => rollArchiveOnce(test.store, test.signer, test.deps, { nowMs: 1 }), error => {
        assert.equal(error.code, 'AUDIT_ARCHIVE_WRITE_FAILED');
        assert.match(String(error.cause && error.cause.message), /metadata write refused/);
        return true;
      });
    } finally { test.store.setMetadata = original; }

    assert.deepEqual(test.liveSequences(), [1, 2, 3, 4, 5],
      'a failed boundary write must not leave the row deleted');
    assert.equal(readArchiveBoundary(test.store, test.signer), null, 'and no boundary may be recorded');
  } finally { test.cleanup(); }
});

check('rolling requires the vault signer -- it cannot be done unsigned', () => {
  const test = ledger(5);
  try {
    for (const bad of [null, undefined, {}, { keyId: 'x' }, { sign: () => Buffer.alloc(64) }]) {
      assert.throws(() => rollArchiveOnce(test.store, bad, test.deps, { nowMs: 1 }),
        error => error && error.code === 'AUDIT_ARCHIVE_ROLL_UNAVAILABLE',
        'an unsigned roll must be refused outright, never silently produce an unsigned boundary');
    }
    assert.deepEqual(test.liveSequences(), [1, 2, 3, 4, 5]);
  } finally { test.cleanup(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-archive-roll: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

'use strict';

// ONE WRITER TRANSACTION PER RECORD, AND NOTHING TRADED FOR IT.
//
// record() used to take the ledger's single cross-process writer lock TWICE:
// once to admit and append the canonical event, and again, microseconds later,
// to write that same event's two projection lines. Measured 2026-08-12 on an
// 8000-event ledger (5.0 MB jsonl + 1.6 MB text), that was 2 exclusive
// acquisitions and ~120 ms of held lock per record; folding the projection
// into the lease the append already holds took it to 1 acquisition and ~69 ms,
// and lifted 4-worker throughput 3.62 -> 4.74 calls/s.
//
// The whole point of these checks is that the speedup bought nothing at the
// ledger's expense. An audit record is not allowed to become "durable later":
//   * the canonical event must be committed before record() returns, provable
//     from a SEPARATE connection that never saw this process's transaction;
//   * the projection lines must be on disk before record() returns, so
//     status.projected keeps meaning what it has always meant;
//   * a projection that fails must still not destroy the admitted canonical
//     event -- the projection now runs INSIDE the append's transaction, so
//     this is the one genuinely new way the change could have gone wrong;
//   * ordering and the tamper-evidence chain must be unchanged, and a rewritten
//     historical row must still be caught.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const audit = require('../../src/lib/audit');
const { AuditStore, createAuditStore } = require('../../src/lib/audit-store');

const checks = [];
function check(name, run) {
  try { run(); checks.push({ name, ok: true }); console.log(`  ok  ${name}`); }
  catch (error) {
    checks.push({ name, ok: false, error });
    console.error(`  FAIL  ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

function memoryAnchor() {
  let value = null;
  return {
    get: () => value,
    set(next, sequence) {
      if (value !== null && sequence < JSON.parse(value).sequence) {
        throw new Error('anchor cannot move backward');
      }
      value = next;
    }
  };
}

// Deliberately binds the ledger through storeOptions rather than by injecting
// a store instance. An injected store makes audit.prepare() treat the call as
// isolated and re-run its one-time migration under a projection lease on EVERY
// record, which would hide the very cost this suite measures behind a
// test-only artefact. storeOptions is the shape a real process uses.
function harness(label, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `te-audit-batching-${label}-`));
  const keys = crypto.generateKeyPairSync('ed25519');
  const file = path.join(dir, 'audit.sqlite3');
  let nextId = 0;
  const dependencies = {
    storeOptions: { file },
    signer: {
      keyId: 'batching-key-0001',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: value => crypto.sign(null, value, keys.privateKey)
    },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(dir, value),
    env: {},
    eventIdFactory: () => `audit-batch-${String(++nextId).padStart(8, '0')}`,
    clock: Date.now,
    reportError: () => {},
    anchorStore: memoryAnchor(),
    ...overrides
  };
  const opened = [];
  return {
    dir, file, keys, dependencies,
    // A second, independent handle on the same ledger: used for verification
    // and inspection so no check reads through the connection under test.
    verifier() {
      const store = createAuditStore({ file });
      opened.push(store);
      return store;
    },
    close() {
      for (const store of opened) { try { store.close(); } catch { /* test teardown */ } }
      try { audit.resetForTests(); }
      finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
    }
  };
}

function lines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
}

// Counts every BEGIN IMMEDIATE issued while it is installed. That statement,
// not the JavaScript helper around it, is what actually excludes every other
// process on the machine, so it is the honest unit for "how much serialization
// does one record cost".
function countingWriterTransactions() {
  const counts = { begin: 0 };
  const original = AuditStore.prototype._beginImmediate;
  AuditStore.prototype._beginImmediate = function counted(db) {
    counts.begin += 1;
    return original.call(this, db);
  };
  return { counts, restore() { AuditStore.prototype._beginImmediate = original; } };
}

check('one record takes exactly one cross-process writer transaction', () => {
  const test = harness('single-lock');
  try {
    // The first record in a process also pays prepare()'s one-time migration
    // lease and the signing key's one real registration, neither of which is
    // part of the steady-state cost being pinned here.
    audit.record('warm.up', 'target', {}, test.dependencies);
    const counting = countingWriterTransactions();
    try {
      const status = audit.record('provider.commit', 'safe-target', { safe: 'retained' }, test.dependencies);
      assert.equal(status.durable, true, 'the record must be durable');
      assert.equal(status.projected, true, 'the projection must complete before record() returns');
      assert.equal(status.pending, 0);
      assert.deepEqual(status.sinks, { jsonl: true, text: true });
    } finally { counting.restore(); }
    assert.equal(counting.counts.begin, 1,
      `a steady-state record must serialize the ledger exactly once, not ${counting.counts.begin} times`);
  } finally { test.close(); }
});

check('a durable answer is already committed and already projected, on disk', () => {
  const test = harness('no-window');
  try {
    audit.record('warm.up', 'target', {}, test.dependencies);
    const status = audit.record('provider.commit', 'safe-target', { safe: 'retained' }, test.dependencies);
    assert.equal(status.durable, true);

    // A SEPARATE connection cannot see an uncommitted transaction, so finding
    // the event here proves the commit happened before record() returned --
    // this is the assertion that would fail if the projection had been turned
    // into a write-behind queue that answers the caller early.
    const observer = new DatabaseSync(test.file, { readOnly: true });
    try {
      const row = observer.prepare('SELECT event_id, sequence, event_hash FROM audit_events WHERE event_id = ?')
        .get(status.eventId);
      assert.ok(row, 'the canonical event must be committed before the caller is told it is durable');
      assert.equal(row.sequence, status.sequence);
      assert.equal(row.event_hash, status.eventHash);
    } finally { observer.close(); }

    const jsonl = lines(path.join(test.dir, 'actions.jsonl'));
    const text = lines(path.join(test.dir, 'actions.log'));
    assert.equal(jsonl.length, status.sequence, 'every admitted event must already be in the jsonl projection');
    assert.equal(text.length, status.sequence, 'every admitted event must already be in the text projection');
    assert.equal(JSON.parse(jsonl[jsonl.length - 1]).eventHash, status.eventHash);
    assert.match(text[text.length - 1], new RegExp(`^${status.sequence} \\| ${status.eventHash} \\|`));
  } finally { test.close(); }
});

check('a total projection failure still cannot roll back the admitted event', () => {
  // The projection now runs inside the append's own transaction. If a sink
  // error escaped, it would abort that transaction and destroy an event the
  // ledger had already admitted -- silently losing an audit record, which is
  // the worst failure this module has. Prove it does not.
  const test = harness('projection-throws', {
    appendFileSync: () => { throw new Error('projection unavailable password=must-not-leak'); }
  });
  try {
    audit.record('warm.up', 'target', {}, test.dependencies);
    const status = audit.record('provider.outcome', 'safe-target', {}, test.dependencies);
    assert.equal(status.durable, true, 'a projection failure must never un-admit the canonical event');
    assert.equal(status.projected, false, 'and must be reported honestly rather than claimed');
    assert.deepEqual(status.sinks, { jsonl: false, text: false });
    assert.doesNotMatch(JSON.stringify(status), /must-not-leak/);

    const observer = new DatabaseSync(test.file, { readOnly: true });
    try {
      const row = observer.prepare('SELECT sequence FROM audit_events WHERE event_id = ?').get(status.eventId);
      assert.ok(row, 'the committed event must survive the failed projection in the shared ledger');
    } finally { observer.close(); }
    assert.equal(test.verifier().verify().valid, true, 'the chain must remain valid across a failed projection');
  } finally { test.close(); }
});

check('ordering and the tamper-evidence chain survive the merged transaction', () => {
  const test = harness('chain');
  try {
    const written = [];
    for (let index = 0; index < 6; index += 1) {
      written.push(audit.record('provider.commit', `target-${index}`, { index }, test.dependencies));
    }
    for (const status of written) assert.equal(status.durable, true);
    const sequences = written.map(status => status.sequence);
    assert.deepEqual(sequences, sequences.slice().sort((a, b) => a - b), 'sequences must be strictly ordered');
    assert.deepEqual(sequences, Array.from({ length: 6 }, (_, index) => index + 1), 'no gaps may appear');

    const verification = test.verifier().verify();
    assert.equal(verification.valid, true);
    assert.equal(verification.entries, 6);

    const jsonl = lines(path.join(test.dir, 'actions.jsonl'));
    assert.equal(jsonl.length, 6, 'the projection must hold every record, in order');
    assert.deepEqual(jsonl.map(line => JSON.parse(line).sequence), sequences);
  } finally { test.close(); }
});

check('an edited historical record is still detected after a merged write', () => {
  const test = harness('tamper');
  try {
    for (let index = 0; index < 4; index += 1) {
      assert.equal(audit.record('provider.commit', `target-${index}`, { index }, test.dependencies).durable, true);
    }
    assert.equal(test.verifier().verify().valid, true);
    const mutator = new DatabaseSync(test.file);
    try {
      const row = mutator.prepare('SELECT sequence, event_json FROM audit_events ORDER BY sequence LIMIT 1').get();
      const event = JSON.parse(row.event_json);
      event.target = 'rewritten-after-the-fact';
      mutator.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = ?').run(JSON.stringify(event), row.sequence);
    } finally { mutator.close(); }
    const verification = test.verifier().verify();
    assert.equal(verification.valid, false, 'a rewritten historical record must still be caught');
    assert.equal(verification.reason, 'event-hash');
  } finally { test.close(); }
});

check('a missing record is still detected after a merged write', () => {
  const test = harness('deletion');
  try {
    for (let index = 0; index < 4; index += 1) {
      assert.equal(audit.record('provider.commit', `target-${index}`, { index }, test.dependencies).durable, true);
    }
    const mutator = new DatabaseSync(test.file);
    try {
      mutator.exec('PRAGMA foreign_keys=ON; DELETE FROM audit_events WHERE sequence = 2;');
    } finally { mutator.close(); }
    const verification = test.verifier().verify();
    assert.equal(verification.valid, false, 'a removed record must still be caught');
  } finally { test.close(); }
});

check('the writer-lock acquisition restores the configured busy timeout', () => {
  // _beginImmediate narrows PRAGMA busy_timeout so SQLite's own busy handler
  // hands control back to the store's fair, jittered polling loop instead of
  // parking a waiter in a sleep that saturates at 100 ms. Leaving the narrow
  // value in place afterwards would make every statement inside the
  // transaction fail fast, so the restore is load-bearing, not cosmetic.
  const test = harness('busy-timeout');
  try {
    const holder = test.verifier();
    const observed = [];
    holder.withProjectionLock({ ownerId: 'batching-probe-0001', nowMs: Date.now() }, locked => {
      observed.push(locked._db.prepare('PRAGMA busy_timeout').get().timeout);
    });
    assert.deepEqual(observed, [holder.busyTimeoutMs],
      'the configured busy timeout must be in force for statements inside the transaction');
    const after = holder._db.prepare('PRAGMA busy_timeout').get().timeout;
    assert.equal(after, holder.busyTimeoutMs, 'and must remain in force after the transaction ends');
  } finally { test.close(); }
});

check('a store configured to fail fast still fails fast', () => {
  // The R1162 operator override bounds how long a contended write may block
  // before falling into the emergency spool. The fair-polling loop must not
  // have quietly extended that budget.
  const test = harness('fail-fast');
  try {
    const holder = test.verifier();
    const contended = createAuditStore({ file: test.file, busyTimeoutMs: 1, transactionRetryMs: 30 });
    try {
      const started = Date.now();
      let failure = null;
      holder.withProjectionLock({ ownerId: 'batching-holder-0001', nowMs: Date.now() }, () => {
        try { contended.setMetadata('batching-probe', { blocked: true }); }
        catch (error) { failure = error; }
      });
      const elapsed = Date.now() - started;
      assert.ok(failure, 'a writer that cannot acquire within its budget must fail rather than block');
      assert.equal(failure.code, 'AUDIT_SQLITE_ERROR');
      assert.equal(failure.details.sqliteCode, 'SQLITE_BUSY');
      assert.ok(elapsed < 5_000, `the bounded budget must be honoured, waited ${elapsed}ms`);
    } finally { contended.close(); }
  } finally { test.close(); }
});

const failed = checks.filter(entry => !entry.ok);
console.log(`\naudit-projection-batching: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exitCode = 1;

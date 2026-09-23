// EXECUTABLE CHANGE — testcanfail-tests-kernel-audit-audit-store-js
//
// Discrimination report:
// - VACUOUS-LOOP: the verify-snapshot loop formerly allowed all observations
//   to occur before the writer's first commit (or after its last), so its
//   snapshot assertions did not prove that they exercised concurrent writes.
//   It now requires an observed in-flight snapshot (0 < entries < 400).
//   Mutation: bypass AuditStore._readTransaction so verification's reads are
//   not held in one SQLite snapshot. RED output from the mutation run:
//   "AssertionError [ERR_ASSERTION]: concurrent verification must remain valid:
//   {\"valid\":false,\"entries\":0,\"headSequence\":1,...,
//   \"reason\":\"verification-state-changed\"}"
// - EXIT-STATUS-ONLY: NOT-FOUND. The worker helper requires status zero; the
//   ledger count, exact contiguous sequences, integrity, and signatures are
//   independently checked from the worker's persisted output.
// - SWALLOWED-FAILURE: NOT-FOUND. Cleanup finally blocks do not catch assertion
//   failures; the transaction catch rolls back and rethrows; the top-level
//   catch reports the error and makes the process fail.
// - MOCK-OF-SUBJECT: NOT-FOUND. Injected clocks/signers and the WAL fake isolate
//   dependencies; assertions inspect real AuditStore behavior and state.
// - SKIP-OR-PRECONDITION-GUARD: NOT-FOUND. This file has no skip/platform guard.
// - SAME-CODE-EXPECTED-VALUE: NOT-FOUND. Expected canonical JSON, sequences,
//   hashes' shape/linkage, schema results, error codes, and query plan facts are
//   specified independently rather than derived by the checked operation.
// - RESTORE: src/lib/audit-store.js was restored byte-for-byte after mutation.
//   SHA-256 before/after:
//   c84ae885ba7605d9fc15059690db50eef725990a862e8abe7e703962cf8aa3a8.
//   Restored green output: "Canonical audit-store tests passed."
// - PRECONDITIONS: Node.js 22+ with node:sqlite is required; satisfied with
//   /root/.nvm/versions/node/v22.22.2/bin/node (the default Node.js 20 cannot
//   load node:sqlite and was not used as mutation evidence).

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const {
  AUDIT_APPLICATION_ID, AUDIT_SCHEMA_VERSION, AuditStoreError, EVENT_SELECTOR_QUERY, ZERO_HASH,
  canonicalJson, createAuditStore, ensureWalMode, eventHashInput
} = require('../../src/lib/audit-store');
const audit = require('../../src/lib/audit');

function fixture(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `te-audit-${label}-`));
  return { dir, file: path.join(dir, 'audit.sqlite3') };
}

function cleanup(test) {
  // Windows can report a just-exited SQLite worker's final handle as EBUSY
  // for a few scheduler ticks. Keep cleanup bounded and scoped to this test's
  // freshly-created temp directory instead of turning handle drain into a
  // false ledger failure.
  fs.rmSync(test.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

function pair() {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: keys.privateKey,
    publicPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateDer: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  };
}

function signer(keys, keyId = 'audit-key-0001') {
  return { keyId, sign: value => crypto.sign(null, value, keys.privateKey) };
}

function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof AuditStoreError && error.code === code);
}

{
  const calls = [];
  const modes = ['delete', 'delete', 'wal'];
  const fakeDb = { prepare: sql => ({ get: () => { calls.push(sql); return { journal_mode: modes.shift() }; } }) };
  let clock = 0;
  const waits = [];
  const mode = ensureWalMode(fakeDb, 100, {
    now: () => clock,
    wait: milliseconds => { waits.push(milliseconds); clock += milliseconds; }
  });
  assert.equal(mode, 'wal');
  assert.deepEqual(waits, [10], 'a non-throwing unchanged journal mode must yield before re-observation');
  assert.deepEqual(calls, ['PRAGMA journal_mode', 'PRAGMA journal_mode=WAL', 'PRAGMA journal_mode']);
}

function raw(file, callback) {
  const db = new DatabaseSync(file, { allowExtension: false, enableForeignKeyConstraints: true });
  try { return callback(db); } finally { db.close(); }
}

function runWorker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'audit-store-worker.js'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`audit worker exited ${code}: ${stdout}\n${stderr}`)));
  });
}

(async () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: false } }), '{"a":{"x":false,"y":true},"z":1}');

  {
    const test = fixture('identity-could-not-look');
    const store = createAuditStore({ file: test.file });
    const external = { version: 1, cacheable: true, witness: 'identity-control' };
    const originalRealpathSync = fs.realpathSync;
    try {
      assert.equal(store.verifyWithEvents({ external }).verification.valid, true);
      assert.equal(store.verifyWithEvents({ external }).verification.valid, true);
      assert.equal(store.verificationCacheStatus().cacheHits, 1,
        'control: a successfully inspected identity still enables the existing verification cache');

      fs.realpathSync = () => { const error = new Error('file table is busy'); error.code = 'EMFILE'; throw error; };
      assert.throws(() => store.verifyWithEvents({ external }), error =>
        error instanceof AuditStoreError
          && error.code === 'AUDIT_STORE_IDENTITY_UNAVAILABLE'
          && error.details.systemCode === 'EMFILE'
          && /does not claim.*absent/i.test(error.message));
      assert.equal(store.verificationCacheStatus().cached, false,
        'a could-not-inspect result must neither reuse nor retain cached trust');
    } finally {
      fs.realpathSync = originalRealpathSync;
      store.close();
      cleanup(test);
    }
  }

  {
    const test = fixture('lifecycle');
    const keys = pair();
    const wrong = pair();
    const store = createAuditStore({ file: test.file, clock: () => 1000 });
    try {
      assert.deepEqual(store.status(), {
        ok: true, path: path.resolve(test.file), schemaVersion: AUDIT_SCHEMA_VERSION,
        applicationId: AUDIT_APPLICATION_ID, headSequence: 0, headHash: ZERO_HASH, headKeyId: null,
        keys: [],
        projectionLease: { ownerId: null, fence: 0, expiresAtMs: null, updatedAtMs: 0, held: false, expired: false },
        sinks: {
          jsonl: { sink: 'jsonl', lastSequence: 0, lastHash: ZERO_HASH, failureCount: 0, retryAtMs: null, lastError: null, updatedAtMs: 0, backlog: 0, aheadOfHead: false },
          text: { sink: 'text', lastSequence: 0, lastHash: ZERO_HASH, failureCount: 0, retryAtMs: null, lastError: null, updatedAtMs: 0, backlog: 0, aheadOfHead: false }
        }
      });
      const registered = store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: keys.publicPem, createdAtMs: 1 });
      assert.equal(registered.replayed, false);
      assert.equal(store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: keys.publicPem, createdAtMs: 2 }).replayed, true);
      expectCode(() => store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: wrong.publicPem }), 'AUDIT_KEY_CONFLICT');

      const one = store.appendEvent({
        eventId: 'event-00000001', occurredAtMs: 10, createdAtMs: 11,
        event: { target: 'safe', details: { retained: true } }
      }, signer(keys));
      assert.equal(one.replayed, false);
      assert.equal(one.event.sequence, 1);
      assert.equal(one.event.previousHash, ZERO_HASH);
      assert.match(one.event.eventHash, /^[a-f0-9]{64}$/);
      assert.equal(store.appendEvent({
        eventId: 'event-00000001', occurredAtMs: 10, createdAtMs: 999,
        event: { details: { retained: true }, target: 'safe' }
      }, signer(keys)).replayed, true, 'createdAt is not re-evaluated on exact logical replay');
      expectCode(() => store.appendEvent({
        eventId: 'event-00000001', occurredAtMs: 10, event: { target: 'different' }
      }, signer(keys)), 'AUDIT_EVENT_CONFLICT');
      expectCode(() => store.appendEvent({
        eventId: 'event-00000002', occurredAtMs: 12, event: { target: 'safe' }
      }, { keyId: 'audit-key-0001', sign: value => crypto.sign(null, value, wrong.privateKey) }), 'AUDIT_SIGNATURE_INVALID');

      const two = store.appendEvent({
        eventId: 'event-00000002', occurredAtMs: 12, createdAtMs: 13, event: { action: 'second' }
      }, signer(keys));
      assert.equal(two.event.sequence, 2);
      assert.equal(two.event.previousHash, one.event.eventHash);
      assert.deepEqual(store.listEvents({ afterSequence: 0, limit: 10 }).map(item => item.eventId), ['event-00000001', 'event-00000002']);
      assert.equal(store.getEvent({ eventId: 'event-00000002' }).sequence, 2);
      assert.equal(store.getEvent({ sequence: 1 }).event.target, 'safe');

      expectCode(() => store.markSinkSuccess({ sink: 'jsonl', sequence: 2, eventHash: two.event.eventHash }), 'AUDIT_SINK_GAP');
      const projected = store.markSinkSuccess({ sink: 'jsonl', sequence: 1, eventHash: one.event.eventHash, updatedAtMs: 20 });
      assert.equal(projected.backlog, 1);
      assert.equal(store.markSinkSuccess({ sink: 'jsonl', sequence: 1, eventHash: one.event.eventHash }).lastSequence, 1);
      const failed = store.markSinkFailure({ sink: 'text', error: 'disk unavailable', retryAtMs: 100, updatedAtMs: 21 });
      assert.equal(failed.failureCount, 1);
      assert.equal(failed.backlog, 2);
      assert.deepEqual(store.getMetadata('legacy-import'), null);
      assert.deepEqual(store.setMetadata('legacy-import', { status: 'complete', records: 0 }, 22).value,
        { records: 0, status: 'complete' });
      assert.equal(store.getMetadata('legacy-import').updatedAtMs, 22);
      assert.equal(store.setSinkPosition({ sink: 'text', sequence: 2, eventHash: two.event.eventHash, updatedAtMs: 23 }).backlog, 0);

      const projectionResult = store.withProjectionLock({ ownerId: 'projection-owner-0001', nowMs: 30 }, (locked, lease) => {
        assert.equal(lease.acquired, true);
        assert.equal(lease.fence, 1);
        assert.equal(locked.projectionLease(30).held, true);
        assert.equal(locked.status().projectionLease.ownerId, 'projection-owner-0001');
        return 'projected';
      });
      assert.equal(projectionResult, 'projected');
      assert.equal(store.projectionLease(31).held, false);
      assert.equal(store.status().projectionLease.fence, 1);
      assert.equal(store.verify().valid, true);
      assert.equal(store.integrity().ok, true);
    } finally { store.close(); cleanup(test); }
  }

  {
    const test = fixture('mutation');
    const keys = pair();
    let store = createAuditStore({ file: test.file, clock: () => 1 });
    store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: keys.publicPem });
    store.appendEvent({ eventId: 'event-00000001', occurredAtMs: 1, event: { value: 1 } }, signer(keys));
    store.close();
    raw(test.file, db => db.prepare("UPDATE audit_events SET event_json = '{\"value\":2}' WHERE sequence = 1").run());
    store = createAuditStore({ file: test.file });
    try {
      assert.deepEqual(store.verify(), { valid: false, entries: 1, invalidSequence: 1, reason: 'event-hash' });
    } finally { store.close(); cleanup(test); }
  }

  {
    const test = fixture('deletion');
    const keys = pair();
    let store = createAuditStore({ file: test.file, clock: () => 1 });
    store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: keys.publicPem });
    for (let index = 1; index <= 3; index++) store.appendEvent({ eventId: `event-${String(index).padStart(8, '0')}`, occurredAtMs: index, event: { index } }, signer(keys));
    store.close();
    raw(test.file, db => db.prepare('DELETE FROM audit_events WHERE sequence = 2').run());
    store = createAuditStore({ file: test.file });
    try { assert.equal(store.verify().reason, 'sequence-gap'); }
    finally { store.close(); cleanup(test); }
  }

  {
    const test = fixture('signature');
    const keys = pair();
    let store = createAuditStore({ file: test.file, clock: () => 1 });
    store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: keys.publicPem });
    store.appendEvent({ eventId: 'event-00000001', occurredAtMs: 1, event: { value: 1 } }, signer(keys));
    store.close();
    raw(test.file, db => db.prepare("UPDATE audit_events SET signature = ? WHERE sequence = 1").run(Buffer.alloc(64, 7).toString('base64')));
    store = createAuditStore({ file: test.file });
    try { assert.equal(store.verify().reason, 'signature'); }
    finally { store.close(); cleanup(test); }
  }

  {
    const test = fixture('canonical-json');
    const keys = pair();
    let store = createAuditStore({ file: test.file, clock: () => 1 });
    store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: keys.publicPem });
    store.appendEvent({ eventId: 'event-00000001', occurredAtMs: 1, event: { value: 1 } }, signer(keys));
    store.close();
    raw(test.file, db => db.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = 1').run('{ "value": 1 }'));
    store = createAuditStore({ file: test.file });
    try { assert.equal(store.verify().reason, 'event-json-canonical'); }
    finally { store.close(); cleanup(test); }
  }

  {
    const test = fixture('public-key-hash');
    const keys = pair();
    let store = createAuditStore({ file: test.file, clock: () => 1 });
    store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: keys.publicPem });
    store.appendEvent({ eventId: 'event-00000001', occurredAtMs: 1, event: { value: 1 } }, signer(keys));
    store.close();
    raw(test.file, db => db.prepare('UPDATE audit_keys SET public_key_hash = ?').run('f'.repeat(64)));
    store = createAuditStore({ file: test.file });
    try { assert.equal(store.verify().reason, 'public-key-hash'); }
    finally { store.close(); cleanup(test); }
  }

  {
    // A KEY ROW MUST NOT BE ABLE TO VOUCH FOR ITSELF.
    //
    // The public-key-hash check above only proves a row is SELF-consistent, and
    // public_key_hash and public_key_pem are both columns in the same
    // attacker-writable table -- so rewriting the PAIR consistently satisfies
    // it, which is exactly what this fixture does.
    //
    // What actually ties a registered key to the material that signed the
    // history is key_id: audit.js derives it as `audit-ed25519-${sha256(spki
    // der)}` and key_id is committed inside every event_hash. Substituting
    // material under an existing derived key_id changes no event hash, leaves
    // the chain recomputing cleanly, and would then let forged APPENDS verify
    // against the attacker's key.
    //
    // Note the neighbouring fixtures all use 'audit-key-0001', which does not
    // claim the derived form and is therefore untouched by this rule. That is
    // the point of scoping it to the prefix: injected test signers are
    // in-process doubles, not a tampering surface.
    const test = fixture('public-key-identity');
    const keys = pair();
    const spkiDer = crypto.createPublicKey(keys.publicPem).export({ type: 'spki', format: 'der' });
    const derivedId = `audit-ed25519-${crypto.createHash('sha256').update(spkiDer).digest('hex')}`;
    let store = createAuditStore({ file: test.file, clock: () => 1 });
    store.registerKey({ keyId: derivedId, publicKeyPem: keys.publicPem });
    store.appendEvent({ eventId: 'event-00000001', occurredAtMs: 1, event: { value: 1 } }, signer(keys, derivedId));
    assert.equal(store.verify().valid, true, 'precondition: a derived key id must verify before substitution');
    store.close();

    const attacker = pair();
    const attackerDer = crypto.createPublicKey(attacker.publicPem).export({ type: 'spki', format: 'der' });
    raw(test.file, db => db.prepare('UPDATE audit_keys SET public_key_pem = ?, public_key_hash = ?')
      .run(attacker.publicPem, crypto.createHash('sha256').update(attackerDer).digest('hex')));
    store = createAuditStore({ file: test.file });
    try {
      assert.equal(store.verify().reason, 'public-key-identity',
        'material substituted under a derived key id must be refused, even though the row is self-consistent');
    } finally { store.close(); cleanup(test); }
  }

  {
    // THE CHAIN ROOT IS A PARAMETER, SO COLD STORAGE DOES NOT BREAK THE LEDGER.
    //
    // The audit ledger is never bounded today: measured 1,527 events/day on the
    // owner's install, ~557,000 after a year, and every short-lived process
    // re-verifies all of it. Moving the oldest events to signed cold storage is
    // what bounds that, and it needs the live rows to start above sequence 1
    // chained to something other than ZERO_HASH.
    //
    // What must NOT be bought with that: front-truncation detection. Today it is
    // free -- rows starting above sequence 1 fail the contiguity check. These
    // cases pin that it stays caught when no boundary is supplied, and that a
    // boundary only ever satisfies verification when it names the exact sequence
    // and hash the live chain actually continues from.
    //
    // Note the deletion below does not trip the schema's
    // `(sequence = 1 AND previous_hash = ZERO_HASH) OR sequence > 1` CHECK: it
    // constrains only sequence 1, so archiving it out leaves every remaining row
    // on the `sequence > 1` branch. That is why bounding the ledger needs no
    // migration, and this fixture is what proves it.
    const test = fixture('archive-boundary');
    const keys = pair();
    let store = createAuditStore({ file: test.file, clock: () => 1 });
    store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: keys.publicPem });
    const chain = [];
    for (let index = 1; index <= 5; index++) {
      chain.push(store.appendEvent({ eventId: `event-${String(index).padStart(8, '0')}`, occurredAtMs: index, event: { index } }, signer(keys)).event);
    }
    assert.equal(store.verify().valid, true, 'precondition: the seeded chain must verify');
    store.close();

    raw(test.file, db => db.prepare('DELETE FROM audit_events WHERE sequence <= 2').run());

    // _verifySnapshot takes the boundary as an argument rather than reading it,
    // because a boundary is only meaningful once its signature has been checked
    // against vault key material -- which is the caller's job. Until that caller
    // exists, drive it the way tests/audit-lock-scope.test.js drives
    // withProjectionLock: wrap the shared prototype.
    const probe = createAuditStore({ file: ':memory:' });
    const proto = Object.getPrototypeOf(probe);
    probe.close();
    const unwrapped = proto._verifySnapshot;
    const rootedAt = boundary => {
      const scoped = createAuditStore({ file: test.file });
      proto._verifySnapshot = function (db) { return unwrapped.call(this, db, boundary); };
      try { return scoped.verify(); }
      finally { proto._verifySnapshot = unwrapped; scoped.close(); }
    };

    try {
      assert.equal(rootedAt(null).reason, 'sequence-gap',
        'with no boundary, archived-away events must still read as truncation');
      assert.equal(rootedAt({ archivedThroughSequence: 2, eventHash: chain[1].eventHash }).valid, true,
        'a boundary naming the real archived head must let the live chain verify');
      assert.equal(rootedAt({ archivedThroughSequence: 2, eventHash: 'b'.repeat(64) }).reason, 'previous-hash',
        'a boundary whose hash is not what the live chain continues from must be refused');
      assert.equal(rootedAt({ archivedThroughSequence: 3, eventHash: chain[2].eventHash }).reason, 'sequence-gap',
        'a boundary claiming more was archived than actually was must be refused');
    } finally { proto._verifySnapshot = unwrapped; cleanup(test); }
  }

  {
    const test = fixture('tail');
    const keys = pair();
    let store = createAuditStore({ file: test.file, clock: () => 1 });
    store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: keys.publicPem });
    const events = [];
    for (let index = 1; index <= 2; index++) events.push(store.appendEvent({ eventId: `event-${String(index).padStart(8, '0')}`, occurredAtMs: index, event: { index } }, signer(keys)).event);
    for (const event of events) store.markSinkSuccess({ sink: 'jsonl', sequence: event.sequence, eventHash: event.eventHash });
    store.close();
    raw(test.file, db => db.prepare('DELETE FROM audit_events WHERE sequence = 2').run());
    store = createAuditStore({ file: test.file });
    try { assert.equal(store.verify().reason, 'sink-ahead-of-head'); }
    finally { store.close(); cleanup(test); }
  }

  {
    const test = fixture('exact-selector');
    const keys = pair();
    const store = createAuditStore({ file: test.file, clock: () => 1 });
    try {
      store.registerKey({ keyId: 'audit-key-0001', publicKeyPem: keys.publicPem });
      const write = (id, action, target) => store.appendEvent({
        eventId: id, occurredAtMs: Number(id.slice(-2)), event: {
          timestamp: new Date(Number(id.slice(-2))).toISOString(), action, target, details: {}
        }
      }, signer(keys));
      write('event-selector-00000001', 'controller.agent.launch', 'launch-one');
      write('event-selector-00000002', 'other.action', 'launch-one');
      write('event-selector-00000003', 'controller.agent.launch', 'launch-one');
      write('event-selector-00000004', 'controller.agent.launch', 'launch-two');
      assert.deepEqual(
        store.findEvents({ action: 'controller.agent.launch', target: 'launch-one', limit: 5 }).map(event => event.eventId),
        ['event-selector-00000001', 'event-selector-00000003'],
        'the exact selector returns only the requested action/target pair in ledger order'
      );
      assert.deepEqual(
        store.findEvents({ action: 'controller.agent.launch', target: 'launch-one', limit: 1 }).map(event => event.eventId),
        ['event-selector-00000001'],
        'the selector keeps the caller-provided bounded result cap'
      );
      expectCode(() => store.findEvents({ action: '', target: 'launch-one' }), 'AUDIT_INVALID_ARGUMENT');
      expectCode(() => store.findEvents({ action: 'controller.agent.launch', target: 'launch-one', limit: 201 }), 'AUDIT_INVALID_ARGUMENT');
      /* EXPLAIN THE QUERY PRODUCTION PREPARES, NOT A HAND-COPIED TWIN.
       *
       * This EXPLAINed a SQL string written into the test, so it proved an index
       * backs a query that only the test contains. MEASURED: wrapping both
       * operands of the real query in CAST(... AS TEXT) -- which cannot use an
       * expression index -- took the real plan from "SEARCH audit_events USING
       * INDEX audit_events_action_target_sequence_idx" to "SCAN audit_events"
       * while returning byte-identical rows. Every functional assertion above
       * stayed green, and so did this one, because it went on planning its own
       * copy. Nothing else would have caught it: the 10,001-event scale block
       * below asserts row contents, never a timing or plan budget.
       *
       * EVENT_SELECTOR_QUERY is now imported from the module under test, so the
       * two cannot drift. */
      const plan = raw(test.file, db => db.prepare(`EXPLAIN QUERY PLAN ${EVENT_SELECTOR_QUERY}`)
        .all('controller.agent.launch', 'launch-one', 5));
      assert.ok(plan.some(row => JSON.stringify(row).includes('audit_events_action_target_sequence_idx')),
        'the exact selector query production prepares is backed by the schema-owned selector index');
      assert.equal(plan.some(row => /SCAN audit_events/.test(String(row.detail))), false,
        'the exact selector query degraded to a full ledger scan');
    } finally { store.close(); cleanup(test); }
  }

  {
    // The former broker-side scan rejected the entire lookup as soon as the
    // ledger head exceeded 10,000.  Build a genuine signed 10,001-event chain
    // in an isolated database and prove audit.findEvents() still performs its
    // normal full-chain verification before returning the exact indexed match.
    const test = fixture('exact-selector-scale');
    const keys = pair();
    const keyId = 'audit-key-0001';
    let store = createAuditStore({ file: test.file, clock: () => 1 });
    store.registerKey({ keyId, publicKeyPem: keys.publicPem, createdAtMs: 1 });
    store.close();
    raw(test.file, db => {
      const insert = db.prepare(`INSERT INTO audit_events(sequence, event_id, occurred_at_ms, event_json, previous_hash,
        event_hash, key_id, signature, created_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let previousHash = ZERO_HASH;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (let sequence = 1; sequence <= 10_001; sequence += 1) {
          const action = sequence === 10_001 ? 'controller.agent.launch' : 'scale.filler';
          const target = sequence === 10_001 ? 'launch-scale-match' : `scale-${sequence % 17}`;
          const event = { timestamp: new Date(sequence).toISOString(), action, target, details: {} };
          const eventJson = canonicalJson(event);
          const eventId = `scale-event-${String(sequence).padStart(8, '0')}`;
          const eventHash = crypto.createHash('sha256').update(eventHashInput({
            sequence, eventId, occurredAtMs: sequence, eventJson, previousHash, keyId, createdAtMs: sequence
          })).digest('hex');
          const signature = crypto.sign(null, Buffer.from(eventHash, 'hex'), keys.privateKey).toString('base64');
          insert.run(sequence, eventId, sequence, eventJson, previousHash, eventHash, keyId, signature, sequence);
          previousHash = eventHash;
        }
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    });
    store = createAuditStore({ file: test.file, clock: () => 20_000 });
    let protectedHead = null;
    const auditDeps = {
      store,
      signer: { keyId, publicKeyPem: keys.publicPem, sign: value => crypto.sign(null, value, keys.privateKey) },
      loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
      rootPath: value => path.join(test.dir, value),
      env: {},
      clock: () => 20_000,
      reportError: () => {},
      anchorStore: { get: () => protectedHead, set: value => { protectedHead = value; } }
    };
    try {
      assert.equal(store.status().headSequence, 10_001);
      const matches = audit.findEvents({ action: 'controller.agent.launch', target: 'launch-scale-match', limit: 2 }, auditDeps);
      assert.equal(matches.length, 1, 'a verified exact lookup remains available above the former 10,000-event ceiling');
      assert.equal(matches[0].sequence, 10_001);
      assert.equal(matches[0].event.target, 'launch-scale-match');
    } finally {
      audit.resetForTests();
      store.close();
      cleanup(test);
    }
  }

  {
    const test = fixture('v1-migration');
    let store = createAuditStore({ file: test.file });
    store.close();
    raw(test.file, db => db.exec('DROP INDEX audit_events_action_target_sequence_idx; DROP TABLE audit_projection_lease; PRAGMA user_version = 1;'));
    store = createAuditStore({ file: test.file });
    try {
      assert.equal(store.status().schemaVersion, AUDIT_SCHEMA_VERSION);
      assert.equal(store.status().projectionLease.fence, 0);
      assert.equal(store.integrity().ok, true);
    } finally { store.close(); cleanup(test); }
  }

  {
    const test = fixture('v2-migration');
    let store = createAuditStore({ file: test.file });
    store.close();
    raw(test.file, db => db.exec('DROP INDEX audit_events_action_target_sequence_idx; PRAGMA user_version = 2;'));
    store = createAuditStore({ file: test.file });
    try {
      assert.equal(store.status().schemaVersion, AUDIT_SCHEMA_VERSION);
      assert.equal(store.integrity().ok, true);
      const indexes = raw(test.file, db => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name").all().map(row => row.name));
      assert.ok(indexes.includes('audit_events_action_target_sequence_idx'), 'v2 migration creates the exact-selector index');
    } finally { store.close(); cleanup(test); }
  }

  {
    const test = fixture('schema-tamper');
    let store = createAuditStore({ file: test.file });
    store.close();
    raw(test.file, db => db.exec('ALTER TABLE audit_events ADD COLUMN unexpected TEXT;'));
    expectCode(() => createAuditStore({ file: test.file }), 'AUDIT_SCHEMA_INVALID');
    cleanup(test);
  }

  {
    const test = fixture('future');
    let store = createAuditStore({ file: test.file });
    store.close();
    raw(test.file, db => db.exec(`PRAGMA user_version = ${AUDIT_SCHEMA_VERSION + 1};`));
    expectCode(() => createAuditStore({ file: test.file }), 'AUDIT_SCHEMA_TOO_NEW');
    cleanup(test);
  }

  {
    const test = fixture('concurrency');
    const keys = pair();
    const initializer = createAuditStore({ file: test.file, busyTimeoutMs: 30000 });
    initializer.registerKey({ keyId: 'concurrency-key-0001', publicKeyPem: keys.publicPem, createdAtMs: 1 });
    initializer.close();
    const publicArgument = Buffer.from(keys.publicPem, 'utf8').toString('base64');
    const workers = 4, perWorker = 30;
    await Promise.all(Array.from({ length: workers }, (_, index) => runWorker([
      test.file, keys.privateDer, publicArgument, `worker${index}`, String(perWorker)
    ])));
    const store = createAuditStore({ file: test.file, busyTimeoutMs: 30000 });
    try {
      const verification = store.verify();
      assert.equal(verification.valid, true);
      assert.equal(verification.entries, workers * perWorker);
      assert.deepEqual(store.listEvents({ limit: 1000 }).map(item => item.sequence), Array.from({ length: workers * perWorker }, (_, index) => index + 1));
      assert.equal(store.integrity().ok, true);
    } finally { store.close(); cleanup(test); }
  }

  {
    const test = fixture('verify-snapshot');
    const keys = pair();
    const initializer = createAuditStore({ file: test.file, busyTimeoutMs: 30000 });
    initializer.registerKey({ keyId: 'concurrency-key-0001', publicKeyPem: keys.publicPem, createdAtMs: 1 });
    initializer.close();
    const writer = runWorker([
      test.file, keys.privateDer, Buffer.from(keys.publicPem, 'utf8').toString('base64'), 'snapshot', '400'
    ]);
    const observer = createAuditStore({ file: test.file, busyTimeoutMs: 30000 });
    const observedEntries = new Set();
    try {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const verification = observer.verify();
        observedEntries.add(verification.entries);
        assert.equal(verification.valid, true,
          `concurrent verification must remain valid: ${JSON.stringify(verification)}`);
        assert.equal(verification.entries, verification.headSequence,
          'verification rows and head must come from the same SQLite snapshot');
        if (verification.entries === 400) break;
      }
      await writer;
      assert.ok([...observedEntries].some(entries => entries > 0 && entries < 400),
        `precondition: verification must overlap an in-flight writer; observed entries: ${[...observedEntries].join(', ')}`);
      assert.equal(observer.verify().entries, 400);
    } finally { observer.close(); cleanup(test); }
  }

  console.log('Canonical audit-store tests passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

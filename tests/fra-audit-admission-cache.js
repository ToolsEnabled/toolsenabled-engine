// EXECUTABLE CHANGE
// testcanfail-tests-fra-audit-admission-cache-js
//
// Strengthened assertion: the archive-boundary fixture now derives each event
// hash with an independent canonical encoder instead of accepting appendEvent's
// returned hash as its own oracle. Mutation attempted: change audit-store's
// event-hash domain to "toolsenabled.audit.event.MUTANT". RED output could not
// be obtained because this host has Node 20.20.2 and fails while loading the
// test with `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module:
// node:sqlite`; Node 22.19.0 installation was also blocked by HTTP 403. This
// unmet Node >=22.19.0 precondition also prevented the restored green run.
// NOT-FOUND (1): no assertion is solely inside a possibly-empty collection
// iteration; all assertion-bearing loops have literal positive bounds.
// NOT-FOUND (2): no exit-status or truthy process-return assertion.
// NOT-FOUND (3): no test failure is swallowed by try/catch or optional chaining;
// cleanup catches only named transient filesystem errors.
// NOT-FOUND (4): no assertion checks a mock of the cache implementation.
// NOT-FOUND (5): no skip or platform precondition guard turns this file off.
// NOT-FOUND (6), elsewhere: no other expected assertion value is computed by
// the same production operation that it checks.
'use strict';

// R1020: isolated coverage for the FRA audit-admission cache.  Every fixture
// uses a temporary SQLite database, temporary projections, and an injected
// signing/anchor store; the canonical ledger and live FRA listener are never
// opened.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const audit = require('../src/lib/audit');
const { canonicalJson, createAuditStore } = require('../src/lib/audit-store');

const SLO_MS = 5000;

// Deliberately independent of audit-store's canonicalJson/eventHashInput. This
// is a test oracle, not another call through the implementation being checked.
function independentCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${independentCanonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function independentEventHash({ sequence, eventId, occurredAtMs, event, previousHash, keyId, createdAtMs }) {
  const encoded = independentCanonicalJson({
    domain: 'toolsenabled.audit.event.v1', sequence, eventId, occurredAtMs,
    event, previousHash, keyId, createdAtMs
  });
  return crypto.createHash('sha256').update(encoded, 'utf8').digest('hex');
}

function fixture(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-fra-cache-${label}-`));
  const keys = crypto.generateKeyPairSync('ed25519');
  const signer = {
    keyId: 'fra-cache-key-0001',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, keys.privateKey)
  };
  let anchor = null;
  const store = createAuditStore({ file: path.join(dir, 'audit.sqlite3'), busyTimeoutMs: 30000 });
  const makeDependencies = selectedStore => ({
    store: selectedStore,
    signer,
    anchorStore: { get: () => anchor, set: value => { anchor = value; } },
    rootPath: (...parts) => path.join(dir, ...parts),
    loadPolicy: () => ({ audit: {
      enabled: true,
      jsonlFile: 'logs/actions.jsonl',
      textFile: 'logs/actions.log',
      emergencyFile: 'logs/audit-emergency.jsonl'
    } }),
    env: {},
    reportError: () => {}
  });
  return { dir, store, signer, makeDependencies, getAnchor: () => anchor };
}

function closeFixture(test) {
  try { test.store.close(); } finally {
    audit.resetForTests();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(test.dir, { recursive: true, force: true }); return; }
      catch (error) {
        if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
    fs.rmSync(test.dir, { recursive: true, force: true });
  }
}

function recordThree(test) {
  const dependencies = test.makeDependencies(test.store);
  for (let index = 1; index <= 3; index += 1) {
    const started = performance.now();
    const result = audit.requireRecord('fra.cache.admission', `peer-${index}`, { index }, dependencies);
    assert.equal(result.durable, true);
    assert.equal(result.projected, true);
    result.durationMs = performance.now() - started;
  }
  return dependencies;
}

function expectAuditUnavailable(fn) {
  assert.throws(fn, error => error && error.code === 'AUDIT_UNAVAILABLE');
}

function buildLedger(test, count) {
  const dependencies = test.makeDependencies(test.store);
  test.store.registerKey({ keyId: test.signer.keyId, publicKeyPem: test.signer.publicKeyPem, createdAtMs: 1 });
  for (let sequence = 1; sequence <= count; sequence += 1) {
    test.store.appendEvent({
      eventId: `fra-cache-seed-${String(sequence).padStart(8, '0')}`,
      occurredAtMs: sequence,
      createdAtMs: sequence,
      event: { timestamp: new Date(sequence).toISOString(), action: 'fra.cache.seed', target: `seed-${sequence}`, details: {} }
    }, test.signer);
  }
  const flushed = audit.flush({ force: true }, { ...dependencies, verificationCacheDisabled: true });
  assert.equal(flushed.projected, true);
  assert.equal(flushed.pending, 0);
  return dependencies;
}

(async () => {
  {
    const test = fixture('warm');
    try {
      const dependencies = recordThree(test);
      const warm = test.store.verificationCacheStatus();
      assert.equal(warm.fullVerifications, 1, 'three sequential admissions share one cold chain verification');
      assert.ok(warm.cacheHits >= 2, 'later admissions use the trusted fast path');
      assert.equal(warm.cacheAdvances, 3, 'each exact anchored append advances the trusted snapshot');
      const warmed = audit.warm(dependencies);
      assert.equal(warmed.valid, true, 'startup warmup validates the canonical ledger and projections');
      assert.equal(test.store.verificationCacheStatus().fullVerifications, 1,
        'startup warmup reuses the process-local verified cache');
      const explicit = audit.verify(dependencies);
      assert.equal(explicit.valid, true, 'explicit audit.verify remains valid');
      const afterExplicit = test.store.verificationCacheStatus();
      assert.ok(afterExplicit.fullVerifications >= 2, 'explicit audit.verify performs an uncached verification');
      // An uncached pass reads nothing from the cache and still writes it: it
      // is the most complete verification this process can do, so it is the
      // best cache entry there is. Forgetting it was measured 2026-09-02 as
      // the reason every audited tool call after a status report paid a full
      // signature pass over the whole ledger (system-status verify() nulled
      // the admission cache; the next record found no trusted head to extend).
      assert.equal(afterExplicit.cached, true, 'explicit audit.verify leaves its own full result as the trusted cache');
      assert.equal(afterExplicit.cachedHead.sequence, explicit.headSequence, 'the cached head is the head the explicit pass verified');
    } finally { closeFixture(test); }
  }

  {
    const test = fixture('projection-tamper');
    try {
      const dependencies = recordThree(test);
      const file = path.join(test.dir, 'logs', 'actions.jsonl');
      fs.appendFileSync(file, 'tampered\n', 'utf8');
      expectAuditUnavailable(() => audit.requireRecord('fra.cache.tamper', 'projection', {}, dependencies));
      // A DISAGREEING PROJECTION FILE IS NOT EVIDENCE ABOUT THE LEDGER CHAIN.
      //
      // This used to pin `cached === false`. The refusal above is the
      // fail-closed part and is unchanged; what changed is what the refusal
      // COSTS. MEASURED 2026-09-04 on a copy of the owner's Live ledger
      // (10,053 live events): one admission verification is 3.2-3.5 ms with
      // the trusted prefix kept and 3.1-4.4 s with it dropped -- and because a
      // refused admission spools and the NEXT tool call hits the same
      // unchanged file, dropping it made every following call pay that full
      // O(N) Ed25519 walk, which is the 100% CPU period the install kept dying
      // in (REPORT-crash-20260903/F-REPORT.md). Keeping the prefix changes what
      // is recomputed, never what is proven: every consumer re-proves it
      // against a freshly read fingerprint before it may be used.
      assert.equal(test.store.verificationCacheStatus().cached, true,
        'a projection refusal keeps the trusted chain prefix; the refusal itself is what fails closed');
      assert.equal(audit.flush({ force: true }, dependencies).projected, true, 'explicit flush repairs a projection');
      assert.equal(audit.verify(dependencies).valid, true);
    } finally { closeFixture(test); }
  }

  {
    const test = fixture('ordinary-record-hot-path');
    try {
      const dependencies = recordThree(test);
      const before = test.store.verificationCacheStatus();
      const first = audit.record('fra.cache.ordinary', 'first', { ordinary: true }, dependencies);
      assert.equal(first.durable, true);
      assert.equal(first.projected, true);
      const afterFirst = test.store.verificationCacheStatus();
      assert.ok(afterFirst.cacheHits >= before.cacheHits + 1,
        'ordinary audit.record uses the trusted admission cache');
      assert.ok(afterFirst.cacheAdvances >= before.cacheAdvances + 1,
        'ordinary audit.record advances the trusted snapshot without a new anchor');
      const second = audit.record('fra.cache.ordinary', 'second', { ordinary: true }, dependencies);
      assert.equal(second.durable, true);
      assert.equal(second.projected, true);
      const afterSecond = test.store.verificationCacheStatus();
      assert.equal(afterSecond.fullVerifications, before.fullVerifications,
        'ordinary audit.record admissions stay on the hot path');
      assert.ok(afterSecond.cacheHits >= before.cacheHits + 2);
      assert.ok(afterSecond.cacheAdvances >= before.cacheAdvances + 2);
    } finally { closeFixture(test); }
  }

  {
    const test = fixture('raw-sink-cursor-tamper');
    try {
      const dependencies = recordThree(test);
      const before = test.store.verificationCacheStatus();
      const db = new DatabaseSync(path.join(test.dir, 'audit.sqlite3'));
      try {
        db.prepare('UPDATE audit_sink_state SET last_hash = ? WHERE sink = ?')
          .run('0'.repeat(64), 'jsonl');
      } finally { db.close(); }
      const rejected = audit.record('fra.cache.tamper', 'raw-sink-cursor', {}, dependencies);
      assert.equal(rejected.durable, false, 'a raw sink-cursor tamper rejects admission');
      assert.equal(rejected.pending, 1, 'the rejected admission is retained in the bounded emergency spool');
      const after = test.store.verificationCacheStatus();
      assert.ok(after.fullVerifications > before.fullVerifications,
        'the raw sink-cursor change forces a cold verification');
      assert.equal(after.cached, false, 'a failed sink-cursor verification clears cache trust');
      assert.ok(rejected.errors.length > 0, 'the rejected sink-cursor admission reports an audit error');
    } finally { closeFixture(test); }
  }

  {
    const test = fixture('anchor-tamper');
    try {
      const dependencies = recordThree(test);
      const forged = JSON.parse(test.getAnchor());
      forged.eventHash = '0'.repeat(64);
      test.store.verificationCacheStatus();
      dependencies.anchorStore.set(JSON.stringify(forged));
      expectAuditUnavailable(() => audit.requireRecord('fra.cache.tamper', 'anchor', {}, dependencies));
      assert.equal(test.store.verificationCacheStatus().cached, false, 'anchor divergence clears the cache');
    } finally { closeFixture(test); }
  }

  {
    const test = fixture('anchor-change-race');
    try {
      recordThree(test);
      let anchor = test.getAnchor();
      const originalAnchor = anchor;
      let reads = 0;
      const forged = JSON.parse(anchor);
      forged.eventHash = 'f'.repeat(64);
      const dependencies = {
        ...test.makeDependencies(test.store),
        anchorStore: {
          get: () => {
            reads += 1;
            if (reads >= 4) anchor = JSON.stringify(forged);
            return anchor;
          },
          set: value => { anchor = value; }
        }
      };
      const rejected = audit.record('fra.cache.race', 'anchor-change', {}, dependencies);
      assert.ok(reads >= 4, 'the fixture reached the post-reconciliation anchor witness');
      assert.equal(anchor, JSON.stringify(forged), 'the deterministic fixture changed the anchor witness');
      assert.equal(originalAnchor !== anchor, true);
      assert.equal(rejected.durable, false, 'an anchor change after reconciliation rejects admission');
      assert.ok(rejected.errors.length > 0, 'the rejected anchor race reports an audit error');
    } finally { closeFixture(test); }
  }

  {
    const test = fixture('projection-race-after-witness');
    try {
      const baseDependencies = recordThree(test);
      const projection = path.join(test.dir, 'logs', 'actions.jsonl');
      const databasePath = path.join(test.dir, 'audit.sqlite3');
      let jsonlReads = 0;
      let sqliteAttempted = false;
      let sqliteBlocked = false;
      const adversarialFs = { ...fs };
      adversarialFs.readFileSync = (file, ...options) => {
        const bytes = fs.readFileSync(file, ...options);
        if (path.resolve(String(file)) === path.resolve(projection)) {
          jsonlReads += 1;
          // The fourth JSONL read is the final witness digest in this
          // admission path. Mutate the projection after that read returns,
          // before the append guard gets its own digest.
          if (jsonlReads === 4) {
            fs.appendFileSync(projection, 'post-witness-tamper\n', 'utf8');
            sqliteAttempted = true;
            try {
              const competing = new DatabaseSync(databasePath, { timeout: 1 });
              try {
                competing.prepare('UPDATE audit_sink_state SET failure_count = failure_count + 1 WHERE sink = ?')
                  .run('jsonl');
              } finally { competing.close(); }
            } catch { sqliteBlocked = true; }
          }
        }
        return bytes;
      };
      const dependencies = { ...baseDependencies, fs: adversarialFs };
      const rejected = audit.record('fra.cache.race', 'projection-after-witness', {}, dependencies);
      assert.ok(jsonlReads >= 4, 'the fixture reached the final witness digest');
      assert.equal(sqliteAttempted, true, 'the two-connection SQLite mutation was attempted');
      assert.equal(sqliteBlocked, true, 'BEGIN IMMEDIATE blocks the competing SQLite mutation');
      assert.equal(rejected.durable, false, 'a projection replacement after the witness rejects admission');
      assert.equal(rejected.pending, 1, 'the rejected race is retained in the bounded emergency spool');
      assert.equal(test.store.status().headSequence, 3, 'the rejected race appends no canonical event');
      assert.equal(test.store.verificationCacheStatus().cached, false, 'the race clears cache trust');
    } finally { closeFixture(test); }
  }

  {
    const test = fixture('emergency-spool');
    try {
      const dependencies = recordThree(test);
      const before = test.store.verificationCacheStatus().fullVerifications;
      const emergency = path.join(test.dir, 'logs', 'audit-emergency.jsonl');
      fs.writeFileSync(emergency, `${JSON.stringify({
        eventId: 'fra-cache-emergency-0001', occurredAtMs: 50, createdAtMs: 50,
        event: { timestamp: new Date(50).toISOString(), action: 'fra.cache.emergency', target: 'spool', details: {} }
      })}\n`, 'utf8');
      const recovered = audit.requireRecord('fra.cache.emergency', 'recovered', {}, dependencies);
      assert.equal(recovered.durable, true);
      assert.ok(test.store.verificationCacheStatus().fullVerifications > before,
        'emergency-spool ingestion invalidates the warm cache before admission');
    } finally { closeFixture(test); }
  }

  {
    const test = fixture('row-tamper');
    try {
      const dependencies = recordThree(test);
      const db = new DatabaseSync(path.join(test.dir, 'audit.sqlite3'));
      try {
        const forged = canonicalJson({ action: 'forged', details: {}, target: 'seed', timestamp: new Date(1).toISOString() });
        db.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = 1').run(forged);
      } finally { db.close(); }
      expectAuditUnavailable(() => audit.requireRecord('fra.cache.tamper', 'row', {}, dependencies));
    } finally { closeFixture(test); }
  }

  {
    const test = fixture('key-rotation-and-restart');
    let reopened;
    try {
      const dependencies = recordThree(test);
      const before = test.store.verificationCacheStatus().fullVerifications;
      const next = crypto.generateKeyPairSync('ed25519');
      test.store.registerKey({
        keyId: 'fra-cache-key-0002',
        publicKeyPem: next.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        createdAtMs: 99
      });
      audit.requireRecord('fra.cache.rotation', 'key-set', {}, dependencies);
      assert.ok(test.store.verificationCacheStatus().fullVerifications > before, 'key-set change forces a cold verification');
      test.store.close();
      audit.resetForTests();
      reopened = createAuditStore({ file: path.join(test.dir, 'audit.sqlite3'), busyTimeoutMs: 30000 });
      const restarted = test.makeDependencies(reopened);
      assert.equal(reopened.verificationCacheStatus().cached, false,
        'closing and reopening the same store does not carry process-local cache trust');
      audit.requireRecord('fra.cache.restart', 'process', {}, restarted);
      assert.equal(reopened.verificationCacheStatus().fullVerifications, 1, 'a new process/store cannot reuse the old cache');
    } finally {
      if (reopened) reopened.close();
      closeFixture(test);
    }
  }

  {
    const test = fixture('on-disk-replacement-path-identity');
    let reopened;
    try {
      recordThree(test);
      const databasePath = path.join(test.dir, 'audit.sqlite3');
      // The fixture store remains open, so checkpoint its WAL before making a
      // standalone replacement copy.  Warm again after the checkpoint so the
      // cache witness describes the exact on-disk identity under test.
      const checkpointDb = new DatabaseSync(databasePath);
      try { checkpointDb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
      finally { checkpointDb.close(); }
      audit.warm(test.makeDependencies(test.store));
      const before = test.store.verificationCacheStatus();
      assert.ok(before.cachedExternal, 'the fixture has a complete external verification witness');
      const external = { version: 1, cacheable: true, ...before.cachedExternal };
      const hit = test.store.verifyWithEvents({ external });
      assert.equal(hit.verification.valid, true);
      const afterHit = test.store.verificationCacheStatus();
      assert.equal(afterHit.fullVerifications, before.fullVerifications);
      assert.ok(afterHit.cacheHits > before.cacheHits);

      const replacementPath = path.join(test.dir, 'audit-replacement.sqlite3');
      fs.copyFileSync(databasePath, replacementPath);
      const replacement = createAuditStore({ file: replacementPath, busyTimeoutMs: 30000 });
      try {
        replacement.appendEvent({
          eventId: 'fra-cache-replacement-0001', occurredAtMs: 90, createdAtMs: 90,
          event: { timestamp: new Date(90).toISOString(), action: 'fra.cache.replacement', target: 'path', details: {} }
        }, test.signer);
      } finally { replacement.close(); }
      const replacementDb = new DatabaseSync(replacementPath);
      try {
        const forged = canonicalJson({ action: 'fra.cache.replacement.forged', details: {}, target: 'path', timestamp: new Date(1).toISOString() });
        replacementDb.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = 1').run(forged);
      } finally { replacementDb.close(); }
      const beforeIdentity = test.store._storeIdentity().value;
      fs.copyFileSync(replacementPath, databasePath);
      const afterIdentity = test.store._storeIdentity().value;
      assert.notDeepEqual(afterIdentity, beforeIdentity, 'the database path identity changed after replacement');
      const cold = test.store.verifyWithEvents({ external });
      assert.equal(cold.verification.valid, true);
      const afterReplacement = test.store.verificationCacheStatus();
      assert.equal(afterReplacement.fullVerifications, afterHit.fullVerifications + 1,
        'an on-disk replacement forces cold verification instead of reusing the cache');
      assert.equal(afterReplacement.cacheHits, afterHit.cacheHits,
        'the replacement is not admitted as a cache hit');

      // The current connection may still hold the pre-replacement SQLite
      // descriptor. Reopen the exact path so the corrupt replacement is read
      // from disk, then prove both startup warmup and required admission fail
      // closed instead of trusting the prior process-local witness.
      test.store.close();
      audit.resetForTests();
      reopened = createAuditStore({ file: databasePath, busyTimeoutMs: 30000 });
      const damaged = test.makeDependencies(reopened);
      assert.throws(() => audit.warm(damaged), /canonical audit ledger|audit ledger|invalid/i);
      expectAuditUnavailable(() => audit.requireRecord('fra.cache.replacement', 'corrupt', {}, damaged));
      assert.equal(reopened.verificationCacheStatus().cached, false,
        'a corrupt on-disk replacement never restores cache trust');
    } finally {
      if (reopened) reopened.close();
      closeFixture(test);
    }
  }

  {
    const test = fixture('real-ledger-slo');
    try {
      const count = 2000;
      buildLedger(test, count);
      test.store.close();
      audit.resetForTests();
      const reopened = createAuditStore({ file: path.join(test.dir, 'audit.sqlite3'), busyTimeoutMs: 30000 });
      try {
        const dependencies = test.makeDependencies(reopened);
        const timings = [];
        for (let index = 1; index <= 3; index += 1) {
          const started = performance.now();
          const result = audit.requireRecord('fra.cache.slo', `peer-${index}`, { index }, dependencies);
          assert.equal(result.durable, true);
          timings.push(Number((performance.now() - started).toFixed(1)));
        }
        const cache = reopened.verificationCacheStatus();
        assert.equal(cache.fullVerifications, 1, 'the real SQLite ledger has one cold verification for three admissions');
        assert.ok(cache.cacheHits >= 2);
        assert.ok(Math.max(...timings) < SLO_MS, `real-ledger admission SLO exceeded: ${JSON.stringify(timings)}`);
        console.log(`FRA audit-admission cache tests passed (seed=${count}, timingsMs=${JSON.stringify(timings)}, cache=${JSON.stringify(cache)}; limit=${SLO_MS}ms).`);
      } finally { reopened.close(); }
    } finally { closeFixture(test); }
  }
  {
    // AN ARCHIVE BOUNDARY MUST NOT BE ABLE TO HIDE BEHIND A STALE CACHE.
    //
    // Bounding the audit ledger (owner directive 2026-08-17: minimal cost
    // beyond system start, no unbounded growth) means the oldest events
    // eventually leave the live table, and audit-store roots the chain at a
    // signed boundary instead of genesis. verifyWithEvents/_verifyWithCache
    // cache a VALID result and can reuse it on a later call -- so if the
    // boundary were not part of what gets cached, a result computed under one
    // boundary could be served after the boundary moved (an archive roll
    // advanced it), silently vouching for a chain root that no longer matches
    // what is actually rooted.
    //
    // This drives the store layer directly (verifyWithEvents({ boundary }))
    // rather than through audit.js, because wiring a live boundary into
    // record()/requireRecord()/warm() is later work; what is being pinned here
    // is the caching primitive itself.
    const test = fixture('boundary-cache-identity');
    try {
      test.store.registerKey({ keyId: test.signer.keyId, publicKeyPem: test.signer.publicKeyPem, createdAtMs: 1 });
      const events = [];
      for (let index = 1; index <= 6; index += 1) {
        const eventId = `event-${String(index).padStart(8, '0')}`;
        const previousHash = index === 1 ? '0'.repeat(64) : events[index - 2].eventHash;
        const appended = test.store.appendEvent(
          { eventId, occurredAtMs: index, createdAtMs: index, event: { index } }, test.signer
        ).event;
        const expectedHash = independentEventHash({
          sequence: index, eventId, occurredAtMs: index, createdAtMs: index,
          event: { index }, previousHash, keyId: test.signer.keyId
        });
        assert.equal(appended.eventHash, expectedHash,
          `event ${index} hash must agree with the independent boundary oracle`);
        events.push(appended);
      }
      // Genuinely archive the two oldest, so boundaryAt2 is correct for this
      // ledger state and boundaryAt3 is not.
      test.store.close();
      const raw = new DatabaseSync(path.join(test.dir, 'audit.sqlite3'));
      raw.prepare('DELETE FROM audit_events WHERE sequence <= 2').run();
      raw.close();
      const store = createAuditStore({ file: path.join(test.dir, 'audit.sqlite3') });
      try {
        const boundaryAt2 = { archivedThroughSequence: 2, eventHash: events[1].eventHash };
        const boundaryAt3 = { archivedThroughSequence: 3, eventHash: events[2].eventHash };
        const external = { version: 1, cacheable: true, anchor: null, projectionDigest: 'p', emergencyDigest: 'e' };

        const first = store.verifyWithEvents({ boundary: boundaryAt2, external });
        assert.equal(first.verification.valid, true, 'a true boundary must verify');
        const afterFirst = store.verificationCacheStatus();
        assert.equal(afterFirst.cached, true, 'precondition: the valid result must actually be cached');
        assert.deepEqual(afterFirst.cachedBoundary, boundaryAt2,
          'the cached fingerprint must record which boundary it was verified under');

        const second = store.verifyWithEvents({ boundary: boundaryAt2, external });
        assert.equal(second.verification.valid, true);
        assert.equal(store.verificationCacheStatus().fullVerifications, afterFirst.fullVerifications,
          'the identical boundary must be served from cache, not re-verified');

        const beforeThird = store.verificationCacheStatus().fullVerifications;
        const third = store.verifyWithEvents({ boundary: boundaryAt3, external });
        assert.equal(store.verificationCacheStatus().fullVerifications, beforeThird + 1,
          'a DIFFERENT boundary against the identical ledger state must force a fresh verification, never reuse the prior cache entry');
        assert.equal(third.verification.valid, false,
          'boundaryAt3 does not describe this ledger state (sequence 3 is still live) and must fail on its own merits');
        assert.equal(third.verification.reason, 'sequence-gap');
        console.log('archive-boundary cache identity: verified (identical boundary hits cache, a changed boundary never reuses a prior result).');
      } finally { store.close(); }
    } finally { closeFixture(test); }
  }
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

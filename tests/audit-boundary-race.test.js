'use strict';

// A MOVED ARCHIVE BOUNDARY IS A RACE TO RETRY, NOT A CORRUPT LEDGER.
//
// MEASURED 2026-09-04 15:27-15:34Z on the owner's Live ledger (10,080 live
// rows at the 10,000-row cap, seventeen circles): six admissions were refused
// AUDIT_LEDGER_INVALID (sequence-gap) and spooled, every write tool paid the
// retry-then-refuse latency, and verify() of the same ledger a minute later
// was VALID. A concurrent writer had rolled the oldest rows to the archive
// between this process's prepare() (which read the boundary) and its
// verification (which walked the live rows against that stale root).
//
// This drives exactly that interleaving with one process: a store wrapper
// performs a roll the first time the admission asks it to verify, so the
// admission's context.boundary is stale by the time the chain is walked. The
// record must still come back durable, the archive must hold the rolled
// event, and the ledger must verify afterwards.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

function memoryAnchor() {
  let value = null;
  return {
    get: () => value,
    set(next, sequence) {
      if (value !== null && sequence < JSON.parse(value).sequence) throw new Error('anchor cannot move backward');
      value = next;
    }
  };
}

function harness(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `te-audit-boundary-${label}-`));
  const keys = crypto.generateKeyPairSync('ed25519');
  const file = path.join(dir, 'audit.sqlite3');
  let nextId = 0;
  const signer = {
    keyId: 'boundary-key-0001',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, keys.privateKey)
  };
  const base = {
    signer,
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    // rollArchiveOnce resolves rootPath('state', 'audit-archive.jsonl'): join
    // every segment, or the archive lands as a FILE named `state`.
    rootPath: (...parts) => path.join(dir, ...parts),
    env: {},
    eventIdFactory: () => `audit-boundary-${String(++nextId).padStart(8, '0')}`,
    clock: Date.now,
    reportError: () => {},
    anchorStore: memoryAnchor()
  };
  return {
    dir, file, signer, base,
    archiveLines: () => {
      const archive = path.join(dir, 'state', 'audit-archive.jsonl');
      return fs.existsSync(archive) ? fs.readFileSync(archive, 'utf8').split('\n').filter(Boolean) : [];
    },
    close(stores) {
      for (const store of stores) { try { store.close(); } catch { /* teardown */ } }
      try { audit.resetForTests(); }
      finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
    }
  };
}

// The store the admission under test sees: real in every respect except that
// the FIRST verification it is asked for is preceded by a roll performed
// through a second handle on the same ledger -- the concurrent writer.
function rollingStore(real, roller, onRoll) {
  let rolled = false;
  return new Proxy(real, {
    get(target, property) {
      if (property === 'verifyWithEvents') {
        return options => {
          if (!rolled) { rolled = true; onRoll(roller); }
          return target.verifyWithEvents(options);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

test('an admission whose boundary another writer advanced retries and lands, instead of calling the ledger invalid', () => {
  const h = harness('race');
  const real = createAuditStore({ file: h.file });
  const roller = createAuditStore({ file: h.file });
  try {
    const deps = { ...h.base, store: real };
    for (let i = 0; i < 3; i += 1) {
      const status = audit.record('seed.event', `seed-${i}`, { i }, deps);
      assert.equal(status.durable, true, `seed ${i} durable`);
    }
    let rolls = 0;
    const racing = { ...h.base, store: rollingStore(real, roller, store => {
      const roll = audit.rollArchiveOnce(store, h.signer, { ...h.base, store }, { nowMs: Date.now(), minimumRetained: 1 });
      assert.equal(roll.rolled, true, 'the concurrent writer must actually archive an event');
      // A real roll (enforceRetentionAfterAppend) rewrites both fast views to
      // the post-roll live window in the same step; do the same here so the
      // only thing this admission finds changed is the boundary.
      const archived = roll.boundary.archivedThroughSequence;
      const jsonl = path.join(h.dir, 'actions.jsonl');
      fs.writeFileSync(jsonl, fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean)
        .filter(line => JSON.parse(line).sequence > archived).map(line => `${line}\n`).join(''));
      const text = path.join(h.dir, 'actions.log');
      fs.writeFileSync(text, fs.readFileSync(text, 'utf8').split('\n').filter(Boolean)
        .filter(line => Number(line.split(' | ')[0]) > archived).map(line => `${line}\n`).join(''));
      rolls += 1;
    }) };
    const status = audit.record('after.roll', 'ledger', { raced: true }, racing);
    assert.equal(rolls, 1, 'the roll happened during this admission');
    assert.equal(status.durable, true, `the raced record is durable; errors: ${JSON.stringify(status.errors)}`);
    assert.equal(status.errors.length, 0, 'no canonical error was recorded for a race that resolved');
    assert.equal(status.sequence, 4, 'the record took the next sequence after the three seeds');
    assert.equal(h.archiveLines().length, 1, `exactly the rolled event sits in the archive; archive: ${JSON.stringify(h.archiveLines().map(line => JSON.parse(line).sequence))}; state dir: ${JSON.stringify(fs.existsSync(path.join(h.dir, 'state')) ? fs.readdirSync(path.join(h.dir, 'state')) : null)}`);
    const verification = createAuditStore({ file: h.file });
    try {
      const boundary = audit.readArchiveBoundary(verification, h.signer);
      assert.equal(boundary.archivedThroughSequence, 1, 'the boundary names the archived event');
      const checked = verification.verifyWithEvents({ external: null, boundary });
      assert.equal(checked.verification.valid, true, `the ledger verifies from the moved boundary: ${checked.verification.reason || ''}`);
      assert.equal(checked.verification.headSequence, 4);
    } finally { verification.close(); }
    const emergency = path.join(h.dir, 'emergency.jsonl');
    assert.equal(fs.existsSync(emergency) && fs.readFileSync(emergency, 'utf8').trim() !== '', false, 'nothing was spooled');
  } finally { h.close([real, roller]); }
});

test('a genuine gap with an unmoved boundary is still refused as invalid', () => {
  const h = harness('gap');
  const real = createAuditStore({ file: h.file });
  try {
    const deps = { ...h.base, store: real };
    for (let i = 0; i < 3; i += 1) assert.equal(audit.record('seed.event', `seed-${i}`, { i }, deps).durable, true);
    // Front-truncate the live rows without minting a boundary: the exact
    // tamper the sequence check exists to catch.
    const db = real._open();
    db.exec('DELETE FROM audit_events WHERE sequence = 1');
    // Uncached on purpose: this case is about the boundary logic, not about
    // whether the trusted-verification cache notices a raw row deletion.
    const status = audit.record('after.tamper', 'ledger', {}, { ...deps, auditVerificationUncached: true });
    assert.equal(status.durable, false, 'a truncated ledger with no boundary is not admitted');
    assert.ok(status.errors.some(error => /sequence-gap/.test(String(error.message || error))),
      `the refusal names the gap: ${JSON.stringify(status.errors)}`);
  } finally { h.close([real]); }
});

'use strict';

// A TRANSIENT FAULT DURING A RETENTION ROLL MUST NEVER WEDGE THE LEDGER.
//
// MEASURED on the live install 2026-09-03 (capability\logs\audit-durability.json):
// 382 breaches, the last 200 kept, every one AUDIT_PROJECTION_DIVERGED, clustered
// immediately after capability\state\audit-archive.jsonl rolled at 17:07:36 local
// -- and every external-write tool in the product stayed refused for hours
// afterward. Reproduced here on a private, isolated ledger with one simulated
// one-time fault: before this fix, that single fault left every later record()
// throwing AUDIT_PROJECTION_DIVERGED forever, exactly matching the incident.
//
// enforceRetentionAfterAppend() (src/lib/audit.js) rewrites the jsonl/text
// projection files onto the ASSUMED post-roll live window (rebuildProjection,
// a durable filesystem rename) and only THEN performs the rollArchiveOnce()
// call(s) that assumption depends on. Both run inside the one SQL transaction
// withProjectionLock opens around the whole admission, so a roll failure rolls
// that transaction back -- undoing the event append and the sink-position
// advance -- but not the already-renamed file. Every later admission's
// validateProjectionState() then compares the file's now-wrong content against
// the (correctly unchanged) database and refuses forever, because that refusal
// runs before projectSinks() ever gets a chance to notice and repair it.
//
// Two things had to be fixed together, and this file pins both:
//   1. Roll before rebuilding, so a roll failure never touches either
//      projection file at all (case one).
//   2. validateProjectionState() must tolerate a file that is AHEAD of the
//      database's own cursor cache -- the ordinary, single-line version of the
//      same rollback gap, from projectSinks()'s own per-event append, which
//      happens whether or not a roll is even attempted -- provided every row
//      still verifies against the real, already signature-checked event chain
//      (case two; case one alone is not enough to recover on the very next
//      call).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// configuredRetention() (src/lib/audit.js) only accepts a settings value that
// names a preset LABEL (audit-retention.js#resolvePreset), and the smallest
// shipped preset is 10,000 events -- far too many to drive here. Replace the
// cached module audit.js is about to require with one whose resolvePreset
// always returns the module's own MINIMUM_EVENT_WINDOW (100, the floor "the
// floor itself is allowed" already pins in audit-retention.test.js), so the
// roll is reachable without inventing a new customer-facing preset.
const retentionPath = require.resolve('../src/lib/audit-retention');
const realRetention = require(retentionPath);
const testPolicy = realRetention.resolveRetention({ mode: 'events', value: realRetention.MINIMUM_EVENT_WINDOW });
// Reach the actual roll boundary, not the retired 1% slack's fixed 101 rows.
// Retention-policy tests own the slack promise; this test owns fault recovery.
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

function createHarness(label) {
  audit.resetForTests();
  audit.resetProjectionVerifyCache();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `audit-roll-fault-${label}-`));
  const files = {
    jsonl: path.join(directory, 'actions.jsonl'),
    text: path.join(directory, 'actions.log'),
    emergency: path.join(directory, 'emergency.jsonl')
  };
  const store = createAuditStore({ file: path.join(directory, 'audit.sqlite3') });
  const signer = testSigner();
  let anchor = null;
  let eventNumber = 0;
  let now = 1_700_000_000_000;
  const errors = [];
  let archiveFaultArmed = false;
  let archiveFaults = 0;
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
    eventIdFactory: () => `audit-roll-fault-${label}-${String(++eventNumber).padStart(5, '0')}`,
    reportError: message => errors.push(message),
    appendFileSync: (file, ...rest) => {
      if (archiveFaultArmed && String(file).includes('audit-archive')) {
        archiveFaultArmed = false;
        archiveFaults += 1;
        throw new Error('SIMULATED transient fault writing the archive file');
      }
      return fs.appendFileSync(file, ...rest);
    }
  };
  return {
    dependencies, directory, errors, files, signer, store,
    armArchiveFault() { archiveFaultArmed = true; },
    archiveFaults() { return archiveFaults; },
    record(details = { n: eventNumber }) { return audit.record('probe.write', label, details, dependencies); },
    projectionRows(sink) {
      const content = fs.readFileSync(files[sink], 'utf8');
      return content.length ? content.trimEnd().split('\n').length : 0;
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

check('a fault partway through a roll leaves the projection files exactly one line ahead, never truncated onto the roll\'s assumed outcome', () => {
  const test = createHarness('untouched');
  try {
    for (let i = 0; i < beforeRollCount; i += 1) {
      const status = test.record({ i });
      assert.equal(status.ok, true, `record ${i} must succeed to set up the case: ${JSON.stringify(status.errors)}`);
    }
    const beforeRows = test.projectionRows('jsonl');
    assert.equal(beforeRows, beforeRollCount, 'every successful record must still be on disk, with no roll yet');
    assert.equal(test.store.status().sinks.jsonl.lastSequence, beforeRollCount, 'and the DB cursor must agree');

    test.armArchiveFault();
    const faulted = test.record({ triggersRoll: true });
    assert.equal(test.archiveFaults(), 1, 'the actual archive write must encounter the armed fault');
    assert.equal(faulted.ok, false, 'the archive fault must be reported as a failure, not swallowed');
    assert.equal(faulted.errors[0].code, 'AUDIT_ARCHIVE_WRITE_FAILED',
      `must fail as the injected archive fault, not something else: ${JSON.stringify(faulted.errors)}`);

    const afterRows = test.projectionRows('jsonl');
    assert.equal(afterRows, beforeRows + 1,
      `the projection must gain exactly the one line projectSinks() ordinarily appends for this record, ` +
      `never be rewritten to a smaller retained-events count the failed roll only assumed; measured ${afterRows}`);
  } finally { test.cleanup(); }
});

check('the ledger recovers on the very next record after a mid-roll fault, instead of refusing forever', () => {
  const test = createHarness('recovers');
  try {
    for (let i = 0; i < beforeRollCount; i += 1) assert.equal(test.record({ i }).ok, true);

    test.armArchiveFault();
    const faulted = test.record({ triggersRoll: true });
    assert.equal(test.archiveFaults(), 1, 'the actual archive write must encounter the armed fault');
    assert.equal(faulted.ok, false, 'the fault must still bite exactly once, or this case proves nothing');

    const recovered = test.record({ afterFault: true });
    assert.equal(recovered.ok, true,
      `the very next record must succeed; measured errors: ${JSON.stringify(recovered.errors)}`);
    assert.notEqual((recovered.errors[0] || {}).code, 'AUDIT_PROJECTION_DIVERGED',
      'must not be the permanent-divergence failure the live incident hit');

    // Five more, ordinary records: the ledger must keep working, not merely
    // have survived one lucky retry.
    for (let i = 0; i < 5; i += 1) {
      const status = test.record({ settle: i });
      assert.equal(status.ok, true, `record ${i} after recovery must succeed: ${JSON.stringify(status.errors)}`);
    }

    const verified = audit.verify(test.dependencies);
    assert.equal(test.archiveFaults(), 1, 'recovery must not depend on repeated injected faults');
    assert.equal(verified.valid, true, `the ledger must still verify end to end: ${JSON.stringify(verified)}`);
  } finally { test.cleanup(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-retention-roll-fault-recovery: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

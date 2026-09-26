'use strict';

// THE CLASSIFIER KNOWS WHY; NOBODY DOWNSTREAM CAN ASK IT.
//
// projectionDivergenceReason() (src/lib/audit.js) picks one of four named
// reasons -- 'cursor-range', 'behind-cursor', 'not-a-continuation',
// 'overhang-too-long' -- every time validateProjectionState() refuses an
// admission with AUDIT_PROJECTION_DIVERGED. Before this fix that reason
// existed only inside the function call that computed it: the thrown
// error's `details` carried `{ sink, projectionLines, sinkCursor }`, and
// noteDurabilityBreach()'s persisted sidecar record carried `{ atMs,
// action, code, message, spooled, required }` -- neither had a field for
// it. A live incident could show "AUDIT_PROJECTION_DIVERGED, five times,
// tonight" and nothing durable could say which of the four conditions was
// actually true at any of those five moments.
//
// This pins the fix by BEHAVIOUR, not by calling the classifier directly:
// force a real divergence the same way the file's own reason would occur
// in production -- the DB's sink cursor believing more rows exist than the
// projection file actually holds, i.e. `behind-cursor`, the literal "durable
// content the DB believes exists but the file does not" case
// validateProjectionState()'s own comment names as the one divergence that
// is real loss, not a caching lag -- then read the answer back from the two
// places a caller can actually reach: the thrown error, and the sidecar.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

const VALID_REASONS = new Set(['cursor-range', 'behind-cursor', 'not-a-continuation', 'overhang-too-long']);

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `audit-divergence-reason-${label}-`));
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
  const dependencies = {
    store,
    signer,
    anchorStore: { get: () => anchor, set: value => { anchor = value; } },
    loadPolicy: () => ({
      audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' }
    }),
    // No retention preset resolves here (an empty settings store falls
    // through to 'forever'), so nothing rolls -- this fixture is about the
    // divergence reason travelling through, not about retention.
    loadSettings: () => ({ values: {}, rejected: [] }),
    rootPath: (...parts) => path.join(directory, ...parts),
    env: {},
    clock: () => now++,
    eventIdFactory: () => `audit-divergence-reason-${label}-${String(++eventNumber).padStart(5, '0')}`,
    reportError: () => {}
  };
  return {
    dependencies, directory, files, signer, store,
    record(details = { n: eventNumber }) { return audit.record('probe.write', label, details, dependencies); },
    // Drop the projection file's last `n` lines directly -- the DB's sink
    // cursor keeps claiming every row it already advanced past, so the file
    // is now durably BEHIND what the DB believes exists. This is the real
    // failure class validateProjectionState() exists to catch, produced
    // directly rather than raced into through a timing-dependent fault.
    truncateProjectionTail(sink, dropLines) {
      const content = fs.readFileSync(files[sink], 'utf8');
      const lines = content.length ? content.slice(0, -1).split('\n') : [];
      const kept = lines.slice(0, Math.max(0, lines.length - dropLines));
      fs.writeFileSync(files[sink], kept.length ? `${kept.join('\n')}\n` : '');
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

check('a projection durably behind its DB cursor throws AUDIT_PROJECTION_DIVERGED with details.reason set, and the sidecar\'s newest breach carries the same reason', () => {
  const test = createHarness('behind-cursor');
  try {
    for (let i = 0; i < 10; i += 1) {
      const status = test.record({ i });
      assert.equal(status.ok, true, `record ${i} must succeed to set up the case: ${JSON.stringify(status.errors)}`);
    }

    // The DB cursor (and the live event count) now sit at 10. Drop the last
    // two lines from the jsonl projection file only: the file no longer
    // holds what the DB's sink cursor already advanced past.
    test.truncateProjectionTail('jsonl', 2);

    const diverged = test.record({ triggersDivergence: true });
    assert.equal(diverged.ok, false, 'the desynced projection must be refused, not silently admitted');
    const error = diverged.errors.find(entry => entry.code === 'AUDIT_PROJECTION_DIVERGED');
    assert.ok(error, `must refuse specifically as AUDIT_PROJECTION_DIVERGED: ${JSON.stringify(diverged.errors)}`);
    assert.ok(error.details, 'the refusal must carry a details object at all');
    assert.equal(error.details.sink, 'jsonl', 'must name the sink that actually diverged');
    assert.ok(VALID_REASONS.has(error.details.reason),
      `details.reason must be one of the four named reasons; got ${JSON.stringify(error.details.reason)}`);
    assert.equal(error.details.reason, 'behind-cursor',
      'a file missing rows the DB cursor already advanced past is exactly the behind-cursor case');

    const state = audit.readDurabilityState(test.files, test.dependencies);
    assert.equal(state.readable, true, 'the sidecar must be readable after the breach');
    assert.ok(state.breaches.length > 0, 'the breach must have been recorded at all');
    const newest = state.breaches[state.breaches.length - 1];
    assert.equal(newest.code, 'AUDIT_PROJECTION_DIVERGED', 'the newest breach must be this refusal');
    assert.ok(newest.detail, 'the newest breach must carry a detail object for a projection divergence');
    assert.equal(newest.detail.sink, 'jsonl', 'the sidecar detail must name the same sink as the thrown error');
    assert.equal(newest.detail.reason, error.details.reason,
      'the sidecar must persist the exact same reason the thrown error carried, not a re-derived or different one');
  } finally { test.cleanup(); }
});

check('a breach that is not a projection divergence carries no detail object', () => {
  const test = createHarness('non-divergence');
  try {
    // AUDIT_LEDGER_INVALID from a bare store swap: no sink, no reason, no
    // divergence -- the additive field must not appear where it does not
    // apply, or "detail present" would stop meaning "this was a divergence".
    const brokenDependencies = { ...test.dependencies, store: { status: () => { throw new Error('SIMULATED unrelated failure'); } } };
    const status = audit.record('probe.write', 'non-divergence', { n: 0 }, brokenDependencies);
    assert.equal(status.ok, false, 'the simulated failure must actually fail the record');

    const state = audit.readDurabilityState(test.files, test.dependencies);
    assert.ok(state.breaches.length > 0, 'a breach must still be recorded for this unrelated failure');
    const newest = state.breaches[state.breaches.length - 1];
    assert.notEqual(newest.code, 'AUDIT_PROJECTION_DIVERGED', 'this breach must not be misclassified as a projection divergence');
    assert.equal(newest.detail, null, 'a non-divergence breach must carry no detail object, not an empty one');
  } finally { test.cleanup(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.error(error); }
}
console.log(`\naudit-projection-divergence-reason: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;

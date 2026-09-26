'use strict';
// A FORKED ANCHOR HEALS; A TAMPERED LEDGER STILL ALARMS.
//
// MEASURED 2026-09-02 on an installed 1.0.41 with twelve agent processes on
// one ledger: the anchor is stored inside the ledger transaction before
// COMMIT. One COMMIT lost a race and rolled back after its anchor for event
// 10268 was already in the vault; a sibling committed its own 10268; and from
// then on every admission on the machine failed closed with
// AUDIT_ANCHOR_INTEGRITY_ALARM until the anchor was rewritten by hand. This
// suite plants exactly that state and requires the next write to heal it, in
// both shapes (fork below the head, fork at the head), and requires a real
// signature failure to keep alarming.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('../src/lib/audit');
const { canonicalJson, createAuditStore } = require('../src/lib/audit-store');

function memoryAnchor() {
  let value = null;
  return { get: () => value, set: (next) => { value = next; }, peek: () => value };
}

function harness(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `te-audit-fork-${label}-`));
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = `audit-ed25519-${crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
  const store = createAuditStore({ file: path.join(dir, 'audit.sqlite3'), clock: () => 1000 });
  let nextId = 0;
  const reports = [];
  const anchorStore = memoryAnchor();
  const dependencies = {
    store,
    signer: { keyId, publicKeyPem, sign: value => crypto.sign(null, value, keys.privateKey) },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(dir, value),
    env: {},
    eventIdFactory: () => `audit-fork-${String(++nextId).padStart(8, '0')}`,
    clock: () => 1000 + nextId,
    reportError: message => reports.push(message),
    anchorStore
  };
  return {
    dir, store, keys, keyId, dependencies, reports, anchorStore,
    close() { try { store.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  };
}

function signedAnchor(keys, keyId, sequence, eventHash) {
  const payload = { domain: 'toolsenabled.audit.head.v1', version: 1, sequence, eventHash, keyId };
  return JSON.stringify({
    ...payload,
    signature: crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), keys.privateKey).toString('base64')
  });
}

function rolledBackHash() {
  // The hash of an event that never committed: any 64-hex value the ledger
  // does not hold at that sequence.
  return crypto.createHash('sha256').update(`rolled-back-${Math.random()}`).digest('hex');
}

// What a writer leaves behind when it dies between its in-lock anchor write
// and COMMIT: the intent record naming exactly the anchor it stored.
function plantIntent(test, sequence, eventHash, pid = 424242) {
  const directory = path.join(test.dir, 'state', 'audit-anchor-intents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${pid}.json`), `${canonicalJson({ version: 1, sequence, eventHash, keyId: test.keyId, pid, atMs: 1 })}\n`, 'utf8');
  return path.join(directory, `${pid}.json`);
}

const checks = [];
function check(name, run) { checks.push([name, run]); }

check('a fork BELOW the head heals: the next write re-anchors the real head and succeeds', () => {
  const test = harness('below');
  try {
    for (let index = 1; index <= 3; index += 1) audit.requireRecord('fork.seed', `seed-${index}`, { index }, test.dependencies);
    const head = test.store.status().headSequence;
    assert.equal(head, 3);
    // The vault holds an anchor for sequence 2 whose event was rolled back;
    // the ledger's sequence 2 is a sibling's event under the same trusted key;
    // and the writer that died left its intent record naming that anchor.
    const gone = rolledBackHash();
    test.anchorStore.set(signedAnchor(test.keys, test.keyId, 2, gone));
    const intent = plantIntent(test, 2, gone);
    const status = audit.requireRecord('fork.after', 'healed', { phase: 'below' }, test.dependencies);
    assert.equal(status.durable, true);
    assert.equal(status.anchored, true, 'the write is protected again');
    assert.equal(status.protectedSequence, 4, 'the anchor names the event just written');
    assert.ok(test.reports.some(line => /uncommitted event at sequence 2/.test(line)), 'the heal is reported, not silent');
    const anchor = JSON.parse(test.anchorStore.peek());
    assert.equal(anchor.sequence, 4);
    assert.equal(anchor.eventHash, test.store.getEvent({ sequence: 4 }).eventHash);
    assert.equal(fs.existsSync(intent), false, 'the intent is consumed by the heal');
    assert.equal(audit.verify(test.dependencies).valid, true);
    assert.equal(audit.status(test.dependencies).anchor.sequence, 4, 'status no longer alarms');
  } finally { test.close(); }
});

check('a fork AT the head heals: the next write anchors its own event and succeeds', () => {
  const test = harness('at-head');
  try {
    for (let index = 1; index <= 3; index += 1) audit.requireRecord('fork.seed', `seed-${index}`, { index }, test.dependencies);
    const gone = rolledBackHash();
    test.anchorStore.set(signedAnchor(test.keys, test.keyId, 3, gone));
    plantIntent(test, 3, gone);
    assert.equal(audit.status(test.dependencies).anchor.forked, true, 'status reports the fork rather than throwing');
    const status = audit.requireRecord('fork.after', 'healed', { phase: 'at-head' }, test.dependencies);
    assert.equal(status.durable, true);
    assert.equal(status.anchored, true);
    assert.equal(status.protectedSequence, 4);
    assert.equal(JSON.parse(test.anchorStore.peek()).sequence, 4);
    assert.equal(audit.verify(test.dependencies).valid, true);
  } finally { test.close(); }
});

check('the same mismatch with NO intent record is a genuine alarm, not a fork', () => {
  const test = harness('no-intent');
  try {
    for (let index = 1; index <= 3; index += 1) audit.requireRecord('fork.seed', `seed-${index}`, { index }, test.dependencies);
    test.anchorStore.set(signedAnchor(test.keys, test.keyId, 2, rolledBackHash()));
    let threw = null;
    try { audit.status(test.dependencies); } catch (error) { threw = error; }
    assert.ok(threw && threw.code === 'AUDIT_ANCHOR_INTEGRITY_ALARM', 'status alarms');
    assert.throws(() => audit.requireRecord('fork.after', 'refused', {}, test.dependencies),
      error => error && error.code === 'AUDIT_UNAVAILABLE', 'the next external write is refused');
  } finally { test.close(); }
});

check('a successful admission leaves no intent behind', () => {
  const test = harness('clean');
  try {
    audit.requireRecord('fork.seed', 'seed-1', {}, test.dependencies);
    const directory = path.join(test.dir, 'state', 'audit-anchor-intents');
    const left = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    assert.deepEqual(left, [], 'the intent written before the anchor is removed after COMMIT');
  } finally { test.close(); }
});

check('an anchor that was NOT signed by the trusted key still alarms', () => {
  const test = harness('foreign-key');
  try {
    for (let index = 1; index <= 2; index += 1) audit.requireRecord('fork.seed', `seed-${index}`, { index }, test.dependencies);
    const stranger = crypto.generateKeyPairSync('ed25519');
    test.anchorStore.set(signedAnchor(stranger, test.keyId, 2, rolledBackHash()));
    assert.throws(() => audit.requireRecord('fork.after', 'refused', {}, test.dependencies),
      error => error && error.code === 'AUDIT_UNAVAILABLE', 'a forged anchor is a refusal, never a heal');
  } finally { test.close(); }
});

check('a rewritten ledger row still alarms even though its anchor mismatch looks like a fork', () => {
  const test = harness('rewritten-row');
  try {
    for (let index = 1; index <= 3; index += 1) audit.requireRecord('fork.seed', `seed-${index}`, { index }, test.dependencies);
    // Keep the true anchor (sequence 3) but rewrite row 2 behind the ledger's
    // back: the ledger no longer verifies, so this is not the fork signature.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(test.dir, 'audit.sqlite3'));
    try {
      const forged = canonicalJson({ action: 'forged', details: {}, target: 'seed-2', timestamp: new Date(2).toISOString() });
      db.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = 2').run(forged);
    } finally { db.close(); }
    assert.throws(() => audit.requireRecord('fork.after', 'refused', {}, test.dependencies),
      error => error && error.code === 'AUDIT_UNAVAILABLE', 'a ledger that does not verify is refused');
  } finally { test.close(); }
});

let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.log(`not ok - ${name}`); console.log(error && error.stack ? error.stack : error); }
}
console.log(`audit-anchor-fork-heals: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);

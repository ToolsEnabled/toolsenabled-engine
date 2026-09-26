'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep a mechanical watch on the process boundary.  All vault, signer, store,
// and path dependencies are injected below, so a refusal has no reason to
// launch an external credential helper.
let spawns = 0;
const originalSpawnSync = childProcess.spawnSync;
const originalExecFileSync = childProcess.execFileSync;
childProcess.spawnSync = function countedSpawnSync(...args) {
  spawns += 1;
  return originalSpawnSync.apply(this, args);
};
childProcess.execFileSync = function countedExecFileSync(...args) {
  spawns += 1;
  return originalExecFileSync.apply(this, args);
};

const { createAuditStore } = require('../src/lib/audit-store');
const audit = require('../src/lib/audit');

function signer() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    keyId: `audit-refusal-${crypto.randomUUID()}`,
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: bytes => crypto.sign(null, bytes, pair.privateKey)
  };
}

function fixture(extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-driven-refusal-'));
  const files = {
    jsonl: path.join(directory, 'actions.jsonl'),
    text: path.join(directory, 'actions.log'),
    emergency: path.join(directory, 'audit-emergency.jsonl')
  };
  let anchor = null;
  const store = createAuditStore({ file: ':memory:' });
  const dependencies = {
    store,
    signer: signer(),
    anchorStore: { get: () => anchor, set: value => { anchor = value; } },
    env: {
      TOOLSENABLED_AUDIT_JSONL_PATH: files.jsonl,
      TOOLSENABLED_AUDIT_TEXT_PATH: files.text,
      TOOLSENABLED_AUDIT_EMERGENCY_PATH: files.emergency
    },
    rootPath: value => path.join(directory, value),
    reportError: () => {},
    ...extra
  };
  return { directory, files, store, dependencies, setAnchor: value => { anchor = value; } };
}

function proxyStore(store, overrides) {
  return new Proxy(store, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function bytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function refuseAndProveNoCanonicalWrite(subject, expectedCode) {
  const before = {
    head: subject.store.status().headSequence,
    jsonl: bytes(subject.files.jsonl),
    text: bytes(subject.files.text),
    spawns
  };
  const result = audit.record('refusal.probe', 'external-effect', {}, subject.dependencies);
  const canonical = result.errors.find(error => error.sink === 'canonical');

  assert.equal(result.ok, false, `${expectedCode} must fail the record`);
  assert.equal(result.durable, false, `${expectedCode} must not claim durability`);
  assert.equal(result.recorded, false, `${expectedCode} must not claim a projection write`);
  assert.equal(result.pending, 1, `${expectedCode} must preserve the refused intent in the emergency spool`);
  assert.ok(canonical, `${expectedCode} must be reported as the canonical refusal`);
  assert.equal(canonical.code, expectedCode);
  assert.equal(subject.store.status().headSequence, before.head, `${expectedCode} must not append to the ledger`);
  assert.deepEqual(bytes(subject.files.jsonl), before.jsonl, `${expectedCode} must not alter the JSONL projection`);
  assert.deepEqual(bytes(subject.files.text), before.text, `${expectedCode} must not alter the text projection`);
  assert.equal(spawns, before.spawns, `${expectedCode} must not spawn a helper process`);
}

function anchorRefusal(raw, code) {
  audit.resetForTests();
  const subject = fixture();
  subject.setAnchor(raw);
  refuseAndProveNoCanonicalWrite(subject, code);
}

anchorRefusal('{not-json', 'AUDIT_ANCHOR_MALFORMED');
anchorRefusal(JSON.stringify({ domain: 'not-an-audit-anchor', version: 1 }), 'AUDIT_ANCHOR_INVALID');

{
  audit.resetForTests();
  const subject = fixture();
  subject.dependencies.store = proxyStore(subject.store, {
    verifyWithEvents: () => ({
      verification: { valid: false, reason: 'mutation-fixture-invalid-chain' },
      events: []
    })
  });
  refuseAndProveNoCanonicalWrite(subject, 'AUDIT_LEDGER_INVALID');
}

{
  audit.resetForTests();
  const subject = fixture({ auditAdmissionRetryLimit: 0 });
  subject.dependencies.store = proxyStore(subject.store, {
    trustedVerificationMatches: () => false
  });
  refuseAndProveNoCanonicalWrite(subject, 'AUDIT_ADMISSION_CONTENTION');
}

{
  audit.resetForTests();
  const subject = fixture();
  const seed = audit.record('refusal.seed', 'fixture', {}, subject.dependencies);
  assert.equal(seed.durable, true, 'projection-unreadable fixture must first create a valid ledger');
  fs.writeFileSync(subject.files.jsonl, '{not-json\n', 'utf8');
  refuseAndProveNoCanonicalWrite(subject, 'AUDIT_PROJECTION_UNREADABLE');
}

console.log('Driven audit refusal tests passed (5 refusal codes).');

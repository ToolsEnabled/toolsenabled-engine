'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { activate } = require('./lib/isolated-environment');
activate('audit-identity-maintenance');
const audit = require('../src/lib/audit');
const stores = require('../src/lib/audit-store');
const maintenance = require('../src/lib/audit-identity-maintenance');
const guard = require('../src/lib/audit-maintenance-guard');
const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(path.dirname(__dirname), '.audit-identity-test-'));
  roots.push(root);
  const vault = new Map([['unrelated.existing', 'owned-fixture-record']]);
  const unreadable = new Set();
  const privatePem = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  vault.set(audit.SIGNING_VAULT_KEY, privatePem);
  const signer = audit.signerFromPrivateKey(privatePem);
  const env = { ...process.env, TOOLSENABLED_STATE_ROOT: root, TOOLSENABLED_AUDIT_DB: path.join(root, 'state', 'audit.sqlite3'),
    TOOLSENABLED_AUDIT_JSONL_PATH: path.join(root, 'logs', 'actions.jsonl'), TOOLSENABLED_AUDIT_TEXT_PATH: path.join(root, 'logs', 'actions.log'), TOOLSENABLED_AUDIT_EMERGENCY_PATH: path.join(root, 'logs', 'audit-emergency.jsonl') };
  const policy = { audit: { enabled: true } };
  const options = { stateRoot: root, env, getSecret(key) { if (unreadable.has(key)) throw Object.assign(new Error('damaged fixture ciphertext'), { code: 'SECRET_VAULT_UNREADABLE' }); if (!vault.has(key)) throw Object.assign(new Error('not configured'), { code: 'SECRET_NOT_CONFIGURED' }); return vault.get(key); },
    setSecretPair(firstKey, firstValue, secondKey, secondValue) { vault.set(firstKey, firstValue); vault.set(secondKey, secondValue); }, loadPolicy: () => policy };
  // Injected custody model for deterministic transaction/crash tests. The
  // separate native suite qualifies the real DPAPI/GNOME ciphertext contract.
  options.auditPair = {
    inspect: () => ({ version: 1, digest: crypto.createHash('sha256').update(JSON.stringify([vault.get(audit.SIGNING_VAULT_KEY) || null, vault.get(audit.HEAD_VAULT_KEY) || null])).digest('hex'),
      signing: !vault.has(audit.SIGNING_VAULT_KEY) ? 'missing' : unreadable.has(audit.SIGNING_VAULT_KEY) ? 'unreadable' : 'readable',
      head: !vault.has(audit.HEAD_VAULT_KEY) ? 'missing' : unreadable.has(audit.HEAD_VAULT_KEY) ? 'unreadable' : 'readable',
      owner: { platform: process.platform, id: 'disposable-owner', elevated: false } }),
    replace(expected, signing, head) {
      if (this.inspect().digest !== expected) throw Object.assign(new Error('changed'), { code: 'AUDIT_REKEY_VAULT_CHANGED' });
      vault.set(audit.SIGNING_VAULT_KEY, signing); vault.set(audit.HEAD_VAULT_KEY, head);
      unreadable.clear();
      return this.inspect();
    }
  };
  const store = stores.createAuditStore({ file: env.TOOLSENABLED_AUDIT_DB });
  const deps = { store, signer, env, loadPolicy: () => policy, rootPath: (...parts) => path.join(root, ...parts),
    anchorStore: { get: () => vault.get(audit.HEAD_VAULT_KEY) || null, set: value => vault.set(audit.HEAD_VAULT_KEY, value) }, anchorRequired: true, reportError: () => {} };
  const event = audit.record('fixture.seed', 'benign', { purpose: 'disposable identity maintenance fixture' }, deps);
  assert.equal(event.durable, true);
  assert.equal(event.projected, true);
  store.close();
  return { root, vault, env, options, signer, deps, store, unreadable };
}
function bytes(root) {
  const result = {};
  function walk(directory) {
    for (const row of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, row.name);
      if (row.isDirectory()) walk(full);
      else result[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  }
  walk(root);
  return result;
}
test.after(async () => { await audit.close(); for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test('read-only identity probe preserves all file bytes and vault records', () => {
  const f = fixture();
  const before = bytes(f.root);
  const keys = [...f.vault.entries()];
  const result = maintenance.probe(f.options);
  assert.equal(result.canRotate, true, result.reason);
  assert.equal(result.headSequence, 1);
  assert.deepEqual(bytes(f.root), before);
  assert.deepEqual([...f.vault.entries()], keys);
});

// Closing any raw descriptor for a SQLite file drops this process's POSIX
// locks, including locks owned by other connections or worker threads.
function assertLedgerLocked(file) {
  const result = require('node:child_process').spawnSync('python3', ['-c',
    'import fcntl,sys\nf=open(sys.argv[1],"r+b")\ntry:\n fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n print("unlocked")\nexcept BlockingIOError:\n print("locked")', file], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'locked', 'inspection must preserve the live SQLite lock');
}

test('a copy that never turned audit on has no identity yet and is not sent to repair its vault', () => {
  // T1504: a fresh install read 'Unlock or repair the supported vault backend first'
  // although no audit key existed and the vault was fine.
  const root = fs.mkdtempSync(path.join(path.dirname(__dirname), '.audit-identity-test-'));
  roots.push(root);
  const env = { ...process.env, TOOLSENABLED_STATE_ROOT: root, TOOLSENABLED_AUDIT_DB: path.join(root, 'state', 'audit.sqlite3'),
    TOOLSENABLED_AUDIT_JSONL_PATH: path.join(root, 'logs', 'actions.jsonl'), TOOLSENABLED_AUDIT_TEXT_PATH: path.join(root, 'logs', 'actions.log'), TOOLSENABLED_AUDIT_EMERGENCY_PATH: path.join(root, 'logs', 'audit-emergency.jsonl') };
  const missing = key => { throw Object.assign(new Error(`${key} not configured`), { code: 'SECRET_NOT_CONFIGURED' }); };
  const pair = { inspect: () => ({ version: 1, digest: 'none', signing: 'missing', head: 'missing', owner: { platform: process.platform, id: 'disposable-owner', elevated: false } }),
    replace() { throw new Error('a probe never replaces custody'); } };
  const options = { stateRoot: root, env, getSecret: missing, setSecretPair() { throw new Error('a probe never writes the vault'); }, loadPolicy: () => ({ audit: { enabled: false } }), auditPair: pair };
  const before = bytes(root);
  const fresh = maintenance.probe(options);
  assert.equal(fresh.status, 'none', fresh.reason);
  assert.match(fresh.reason, /no audit signing identity yet/);
  assert.doesNotMatch(fresh.reason, /Unlock or repair/);
  assert.equal(fresh.canRotate || fresh.canRepair || fresh.canRecover, false, 'nothing to rotate, repair or recover');
  assert.deepEqual(bytes(root), before, 'the probe wrote nothing');
  // A key the vault cannot read is not 'never enabled'.
  const damaged = maintenance.probe({ ...options, getSecret: () => { throw Object.assign(new Error('damaged'), { code: 'SECRET_VAULT_UNREADABLE' }); } });
  assert.notEqual(damaged.status, 'none');
  // Existing audit history without a key is not 'never enabled' either.
  const f = fixture();
  f.vault.delete(audit.SIGNING_VAULT_KEY);
  assert.notEqual(maintenance.probe(f.options).status, 'none');
});

test('read-only ledger inspection preserves an open connection’s POSIX locks', { skip: process.platform !== 'linux' }, () => {
  const f = fixture();
  const store = stores.createAuditStore({ file: f.env.TOOLSENABLED_AUDIT_DB });
  try {
    assertLedgerLocked(store.file);
    const inspected = stores.withReadOnlyLedger(store.file, view => view.verify(null));
    assert.equal(inspected.verification.valid, true);
    assertLedgerLocked(store.file);
    assert.equal(inspected.status.headSequence, 1);
  } finally { store.close(); }
});

test('the Settings audit probe preserves locks while fingerprinting live files', { skip: process.platform !== 'linux' }, () => {
  const f = fixture();
  const store = stores.createAuditStore({ file: f.env.TOOLSENABLED_AUDIT_DB });
  try {
    assertLedgerLocked(store.file);
    const result = maintenance.probe(f.options);
    assert.equal(result.canRotate, true, result.reason);
    assertLedgerLocked(store.file);
  } finally { store.close(); }
});

test('healthy rotation archives real signed history and starts a verified genesis, preserving unrelated records', () => {
  const f = fixture();
  const current = maintenance.probe(f.options);
  const oldKey = f.vault.get(audit.SIGNING_VAULT_KEY);
  const result = maintenance.rotate({ ...f.options, fingerprint: current.fingerprint });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'rotated');
  assert.notEqual(f.vault.get(audit.SIGNING_VAULT_KEY), oldKey);
  assert.equal(f.vault.get('unrelated.existing'), 'owned-fixture-record');
  const manifest = JSON.parse(fs.readFileSync(path.join(result.archivePath, 'manifest.json')));
  for (const file of manifest.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(result.archivePath, 'history', file.relative))).digest('hex'), file.sha256);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.archivePath, 'unsigned-break.json'))).signed, false);
  const observed = maintenance.probe(f.options);
  assert.equal(observed.canRotate, true, observed.reason);
  assert.equal(observed.headSequence, 1);
  assert.equal(observed.lastArchivePath, result.archivePath);
  assert.equal(maintenance.revealArchive(result.archivePath, f.options), result.archivePath);
  assert.throws(() => maintenance.revealArchive(f.root, f.options), { code: 'AUDIT_REKEY_ARCHIVE_UNKNOWN' });
});

test('stale state, unreadable custody and unknown archive paths refuse without discarding state', () => {
  const f = fixture();
  const before = bytes(f.root);
  assert.throws(() => maintenance.rotate({ ...f.options, fingerprint: '0'.repeat(64) }), { code: 'AUDIT_REKEY_STATE_CHANGED' });
  const unavailable = maintenance.probe({ ...f.options, getSecret() { throw Object.assign(new Error('locked'), { code: 'SECRET_BACKEND_LOCKED' }); } });
  assert.equal(unavailable.canRotate, false);
  assert.equal(unavailable.code, 'AUDIT_REKEY_CUSTODY_UNAVAILABLE');
  assert.deepEqual(bytes(f.root), before);
});

test('malformed maintenance records never become an absent lock or a fresh generation', () => {
  const f = fixture();
  for (const file of [guard.lockPath(f.env.TOOLSENABLED_AUDIT_DB), guard.generationPath(f.env.TOOLSENABLED_AUDIT_DB)]) {
    for (const value of ['null', '[]', 'true', '"record"', '{']) {
      fs.writeFileSync(file, value);
      assert.throws(() => stores.createAuditStore({ file: f.env.TOOLSENABLED_AUDIT_DB }), { code: 'AUDIT_MAINTENANCE_INVALID' });
      const result = maintenance.probe(f.options);
      assert.equal(result.canRotate, false);
      assert.equal(result.canRecover, false);
      assert.equal(fs.readFileSync(file, 'utf8'), value);
    }
    fs.unlinkSync(file);
  }
  assert.equal(maintenance.probe(f.options).canRotate, true);
});

for (const point of ['prepared', 'archived', 'installed', 'vault-committed']) test(`interruption after ${point} is recovered from real key identity`, () => {
  const f = fixture();
  const oldKey = f.vault.get(audit.SIGNING_VAULT_KEY);
  const current = maintenance.probe(f.options);
  assert.throws(() => maintenance.rotate({ ...f.options, fingerprint: current.fingerprint, fault(phase) {
    if (phase === point) throw Object.assign(new Error('process stop fixture'), { code: 'SIMULATED_PROCESS_STOP' });
  } }), { code: 'SIMULATED_PROCESS_STOP' });
  const pending = maintenance.probe(f.options);
  assert.equal(pending.canRecover, true, pending.reason);
  assert.throws(() => stores.createAuditStore({ file: f.env.TOOLSENABLED_AUDIT_DB }), { code: 'AUDIT_MAINTENANCE_REQUIRED' });
  const recovered = maintenance.recover(f.options);
  assert.equal(recovered.status, point === 'vault-committed' ? 'rotated' : 'rolled-back');
  assert.equal(f.vault.get(audit.SIGNING_VAULT_KEY) === oldKey, point !== 'vault-committed');
  assert.equal(f.vault.get('unrelated.existing'), 'owned-fixture-record');
  assert.equal(maintenance.probe(f.options).canRotate, true);
});

test('old audit store generation cannot resume writes after a completed rotation', () => {
  const f = fixture();
  const old = stores.createAuditStore({ file: f.env.TOOLSENABLED_AUDIT_DB });
  old.close(); // retain the old generation while releasing the Windows handle
  maintenance.rotate({ ...f.options, fingerprint: maintenance.probe(f.options).fingerprint });
  assert.throws(() => old.setMetadata('stale-write', { attempted: true }), { code: 'AUDIT_GENERATION_CHANGED' });
  const fresh = stores.createAuditStore({ file: f.env.TOOLSENABLED_AUDIT_DB });
  assert.equal(fresh.getMetadata('stale-write'), null);
  fresh.close();
});

test('a failed vault-pair update restores old history; a committed but uncertain reply finishes the new generation', () => {
  for (const committed of [false, true]) {
    const f = fixture();
    const write = f.options.setSecretPair;
    const options = { ...f.options, fingerprint: maintenance.probe(f.options).fingerprint, setSecretPair(...args) {
      if (committed) write(...args);
      throw Object.assign(new Error('fixture vault outcome'), { code: 'SECRET_VAULT_WRITE_UNCERTAIN' });
    } };
    if (committed) assert.equal(maintenance.rotate(options).status, 'rotated');
    else assert.throws(() => maintenance.rotate(options), { code: 'SECRET_VAULT_WRITE_UNCERTAIN' });
    assert.equal(maintenance.probe(f.options).canRotate, true);
    assert.equal(fs.existsSync(guard.lockPath(f.env.TOOLSENABLED_AUDIT_DB)), false);
  }
});

function damage(f, kind) {
  if (kind === 'missing-key') f.vault.delete(audit.SIGNING_VAULT_KEY);
  else if (kind === 'unreadable-key') { f.vault.set(audit.SIGNING_VAULT_KEY, 'damaged-fixture-ciphertext'); f.unreadable.add(audit.SIGNING_VAULT_KEY); }
  else if (kind === 'invalid-key') f.vault.set(audit.SIGNING_VAULT_KEY, 'not a signing key');
  else if (kind === 'invalid-head') f.vault.set(audit.HEAD_VAULT_KEY, 'not a protected head');
  else if (kind === 'opaque-history') fs.writeFileSync(f.env.TOOLSENABLED_AUDIT_DB, 'opaque damaged database fixture');
  else {
    const db = new DatabaseSync(f.env.TOOLSENABLED_AUDIT_DB);
    try { db.prepare('UPDATE audit_events SET signature = ? WHERE sequence = 1').run(Buffer.alloc(64, 3).toString('base64')); }
    finally { db.close(); }
  }
}
for (const kind of ['missing-key', 'unreadable-key', 'invalid-key', 'invalid-head', 'invalid-history', 'opaque-history']) test(`explicit ${kind} repair preserves unverified history and starts a verified signed identity`, () => {
  const f = fixture(); damage(f, kind);
  const before = bytes(f.root);
  const current = maintenance.probe(f.options);
  assert.equal(current.canRepair, true, current.reason);
  assert.equal(current.canRotate, false);
  assert.equal(current.repairReason, kind === 'opaque-history' ? 'invalid-history' : kind);
  assert.deepEqual(bytes(f.root), before, 'inspection does not rewrite damaged history');
  assert.throws(() => maintenance.repair({ ...f.options, fingerprint: current.fingerprint }), { code: 'AUDIT_REKEY_BUSY' });
  const result = maintenance.repair({ ...f.options, fingerprint: current.fingerprint, quiesced: true });
  assert.equal(result.status, 'repaired');
  assert.equal(result.restartRequired, true);
  assert.equal(f.vault.get('unrelated.existing'), 'owned-fixture-record');
  const manifest = JSON.parse(fs.readFileSync(path.join(result.archivePath, 'manifest.json')));
  assert.equal(manifest.priorHistoryVerified, false);
  assert.equal(manifest.repairReason, current.repairReason);
  for (const file of manifest.files) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(result.archivePath, 'history', file.relative))).digest('hex'), file.sha256);
  }
  for (const file of manifest.unverifiedInputFiles) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(result.archivePath, 'unverified-input', file.relative))).digest('hex'), before[file.relative]);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.archivePath, 'unsigned-break.json'))).signed, false);
  const checked = stores.withReadOnlyLedger(f.env.TOOLSENABLED_AUDIT_DB, store => store.verify());
  assert.equal(checked.verification.valid, true);
  assert.equal(checked.events[0].event.action, 'audit.identity.repaired');
  assert.equal(checked.events[0].event.details.priorHistoryVerified, false);
  assert.equal(maintenance.probe(f.options).canRotate, true);
});

for (const point of ['lock-created', 'inputs-preserved', 'prepared', 'archived', 'installed', 'vault-committed']) test(`interrupted broken-key repair after ${point} follows exact old/new custody`, () => {
  const f = fixture(); damage(f, 'unreadable-key');
  const old = bytes(f.root);
  assert.throws(() => maintenance.repair({ ...f.options, quiesced: true, fingerprint: maintenance.probe(f.options).fingerprint, fault(phase) {
    if (phase === point) throw Object.assign(new Error('simulated process exit'), { code: 'SIMULATED_PROCESS_STOP' });
  } }), { code: 'SIMULATED_PROCESS_STOP' });
  assert.equal(maintenance.probe(f.options).canRecover, true);
  assert.throws(() => maintenance.recover(f.options), { code: 'AUDIT_REKEY_BUSY' });
  const result = maintenance.recover({ ...f.options, quiesced: true });
  assert.equal(result.status, point === 'vault-committed' ? 'repaired' : 'rolled-back');
  if (point !== 'vault-committed') {
    for (const [file, digest] of Object.entries(old)) assert.equal(bytes(f.root)[file], digest);
    assert.equal(maintenance.probe(f.options).canRepair, true);
  } else assert.equal(maintenance.probe(f.options).canRotate, true);
  assert.equal(f.vault.get('unrelated.existing'), 'owned-fixture-record');
});

test('repair refuses unproven whole-vault custody, unknown owner identity, and ambiguous journals', () => {
  const f = fixture(); damage(f, 'missing-key');
  const original = bytes(f.root);
  for (const pair of [
    { inspect() { throw Object.assign(new Error('whole vault unreadable'), { code: 'AUDIT_REKEY_VAULT_UNAVAILABLE' }); } },
    { inspect: () => ({ ...f.options.auditPair.inspect(), owner: { platform: 'win32', id: 'owned-fixture' } }) },
    { inspect: () => ({ ...f.options.auditPair.inspect(), owner: null }) }
  ]) {
    const refused = maintenance.probe({ ...f.options, auditPair: pair });
    assert.equal(refused.canRepair, false);
    assert.deepEqual(bytes(f.root), original);
  }
  fs.writeFileSync(guard.lockPath(f.env.TOOLSENABLED_AUDIT_DB), '{"version":2,"operation":"repair"}');
  assert.equal(maintenance.probe(f.options).canRepair, false);
  assert.equal(maintenance.probe(f.options).canRecover, false);
});

test('a changed unverified historical row after confirmation or the writer marker is refused', () => {
  for (const moment of ['before', 'lock-created']) {
    const f = fixture(); damage(f, 'missing-key');
    const fingerprint = maintenance.probe(f.options).fingerprint;
    const mutate = () => damage(f, 'invalid-history');
    if (moment === 'before') mutate();
    assert.throws(() => maintenance.repair({ ...f.options, quiesced: true, fingerprint,
      fault: phase => { if (phase === moment) mutate(); } }), { code: 'AUDIT_REKEY_STATE_CHANGED' });
    assert.equal(f.vault.has(audit.SIGNING_VAULT_KEY), false);
    assert.equal(fs.existsSync(guard.lockPath(f.env.TOOLSENABLED_AUDIT_DB)), false);
  }
});

test('checkpointing preserves repair confirmation but a changed projection does not', () => {
  const f = fixture(); damage(f, 'missing-key');
  const db = new DatabaseSync(f.env.TOOLSENABLED_AUDIT_DB);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.prepare('UPDATE audit_events SET signature = ? WHERE sequence = 1').run(Buffer.alloc(64, 9).toString('base64'));
    const current = maintenance.probe(f.options);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(maintenance.probe(f.options).fingerprint, current.fingerprint);
    fs.appendFileSync(f.env.TOOLSENABLED_AUDIT_JSONL_PATH, 'changed projection fixture\n');
    assert.notEqual(maintenance.probe(f.options).fingerprint, current.fingerprint);
  } finally { db.close(); }
});

test('pair CAS preserves an unrelated update and refuses an unknown audit generation without removing its journal', () => {
  for (const unrelated of [true, false]) {
    const f = fixture(); damage(f, 'unreadable-key');
    const expected = maintenance.probe(f.options).fingerprint;
    const operation = () => maintenance.repair({ ...f.options, quiesced: true, fingerprint: expected,
      fault(phase) { if (phase === 'installed') f.vault.set(unrelated ? 'unrelated.existing' : audit.HEAD_VAULT_KEY, 'concurrent fixture update'); } });
    if (unrelated) {
      assert.equal(operation().status, 'repaired');
      assert.equal(f.vault.get('unrelated.existing'), 'concurrent fixture update');
    } else {
      assert.throws(operation, { code: 'AUDIT_REKEY_RECOVERY_REQUIRED' });
      assert.equal(maintenance.probe(f.options).canRecover, false);
      assert.equal(f.vault.get(audit.HEAD_VAULT_KEY), 'concurrent fixture update');
      assert.equal(fs.existsSync(guard.lockPath(f.env.TOOLSENABLED_AUDIT_DB)), true);
    }
  }
});

test('an uncertain reply after fixed audit-pair replacement finishes only a provable committed generation', () => {
  for (const committed of [false, true]) {
    const f = fixture(); damage(f, 'missing-key');
    const original = f.options.auditPair.replace.bind(f.options.auditPair);
    f.options.auditPair.replace = (...args) => { if (committed) original(...args); throw Object.assign(new Error('uncertain fixture reply'), { code: 'SECRET_VAULT_WRITE_UNCERTAIN' }); };
    const operation = () => maintenance.repair({ ...f.options, quiesced: true, fingerprint: maintenance.probe(f.options).fingerprint });
    if (committed) assert.equal(operation().status, 'repaired');
    else assert.throws(operation, { code: 'SECRET_VAULT_WRITE_UNCERTAIN' });
    assert.equal(fs.existsSync(guard.lockPath(f.env.TOOLSENABLED_AUDIT_DB)), false);
    assert.equal(maintenance.probe(f.options)[committed ? 'canRotate' : 'canRepair'], true);
  }
});

test('opaque WAL bytes bind consent and are preserved exactly before SQLite may discard them', () => {
  const f = fixture(); damage(f, 'missing-key');
  const wal = `${f.env.TOOLSENABLED_AUDIT_DB}-wal`;
  const original = Buffer.from('OWNED_OPAQUE_WAL_BEFORE_REPAIR');
  fs.writeFileSync(wal, original);
  const first = maintenance.probe(f.options);
  assert.equal(first.canRepair, true);
  assert.deepEqual(fs.readFileSync(wal), original, 'inspection leaves the original WAL bytes unchanged');
  fs.writeFileSync(wal, 'A different and longer opaque WAL fixture');
  assert.notEqual(maintenance.probe(f.options).fingerprint, first.fingerprint);
  assert.throws(() => maintenance.repair({ ...f.options, quiesced: true, fingerprint: first.fingerprint }), { code: 'AUDIT_REKEY_STATE_CHANGED' });
  fs.writeFileSync(wal, original);
  const result = maintenance.repair({ ...f.options, quiesced: true, fingerprint: maintenance.probe(f.options).fingerprint });
  assert.equal(result.status, 'repaired');
  const manifest = JSON.parse(fs.readFileSync(path.join(result.archivePath, 'manifest.json')));
  const entry = manifest.unverifiedInputFiles.find(row => row.relative === path.relative(f.root, wal));
  assert.ok(entry);
  assert.deepEqual(fs.readFileSync(path.join(result.archivePath, 'unverified-input', entry.relative)), original);
});

for (const kind of ['fresh', 'healthy', 'missing-key', 'unreadable-key', 'invalid-key', 'invalid-head', 'invalid-history']) test(`default writer first open: ${kind} uses real store startup and preserves opaque inputs on refusal`, async () => {
  await audit.close();
  const f = fixture();
  let reads = 0;
  const deps = { ...f.deps, store: undefined, signer: undefined, storeOptions: { file: f.env.TOOLSENABLED_AUDIT_DB },
    getSecret(key) { if (key === audit.SIGNING_VAULT_KEY) reads++; return f.options.getSecret(key); },
    getOrCreateSecret(key, value) { if (!f.vault.has(key)) f.vault.set(key, value); return f.vault.get(key); } };
  let walBytes;
  if (kind === 'fresh') {
    fs.rmSync(f.root, { recursive: true, force: true }); fs.mkdirSync(f.root, { mode: 0o700 });
    f.vault.delete(audit.SIGNING_VAULT_KEY); f.vault.delete(audit.HEAD_VAULT_KEY);
  } else if (kind !== 'healthy') {
    damage(f, kind);
    walBytes = Buffer.from('OWNED_OPAQUE_WAL_MUST_SURVIVE_DEFAULT_WRITER_REFUSAL');
    fs.writeFileSync(`${f.env.TOOLSENABLED_AUDIT_DB}-wal`, walBytes);
  }
  try {
    if (walBytes) {
      assert.throws(() => audit.requireRecord('default.fixture', 'disposable', {}, deps));
      assert.deepEqual(fs.readFileSync(`${f.env.TOOLSENABLED_AUDIT_DB}-wal`), walBytes);
    } else {
      const result = audit.requireRecord('default.fixture', 'disposable', {}, deps);
      assert.equal(result.durable, true); assert.equal(result.anchored, true);
      if (kind === 'healthy') assert.equal(reads, 1, 'the successful preflight uses the normal signer cache');
    }
  } finally { await audit.close(); }
  if (walBytes) assert.deepEqual(fs.readFileSync(`${f.env.TOOLSENABLED_AUDIT_DB}-wal`), walBytes);
});

test('healthy reused WAL and a legitimate unanchored suffix pass the conditional read-only startup proof', async () => {
  await audit.close();
  const f = fixture();
  const writer = stores.createAuditStore({ file: f.env.TOOLSENABLED_AUDIT_DB });
  const connection = new DatabaseSync(f.env.TOOLSENABLED_AUDIT_DB);
  try {
    for (let index = 0; index < 12; index++) audit.requireRecord('fixture.reused-wal', 'disposable', { index }, { ...f.deps, store: writer });
    const priorAnchor = f.vault.get(audit.HEAD_VAULT_KEY);
    connection.exec('PRAGMA wal_checkpoint(PASSIVE)');
    audit.requireRecord('fixture.reused-wal', 'next', {}, { ...f.deps, store: writer });
    f.vault.set(audit.HEAD_VAULT_KEY, priorAnchor); // normal append before its next protected-head update
    assert.ok(require('../src/lib/audit-wal-input').opaqueWalFingerprint(f.env.TOOLSENABLED_AUDIT_DB), 'the real reused WAL retains obsolete tail frames');
    let signingReads = 0;
    const result = audit.requireRecord('fixture.first-open', 'disposable', {}, { ...f.deps, store: undefined, signer: undefined,
      storeOptions: { file: f.env.TOOLSENABLED_AUDIT_DB }, getSecret(key) { if (key === audit.SIGNING_VAULT_KEY) signingReads++; return f.options.getSecret(key); } });
    assert.equal(result.durable, true); assert.equal(result.anchored, true);
    assert.equal(signingReads, 1);
  } finally { await audit.close(); connection.close(); writer.close(); }
});

test('every archive input ancestor is synchronized before the live writer barrier', () => {
  const f = fixture(); damage(f, 'missing-key');
  const observed = new Set();
  const synchronize = guard.syncDirectory;
  try {
    guard.syncDirectory = directory => { observed.add(directory); return synchronize(directory); };
    assert.throws(() => maintenance.repair({ ...f.options, quiesced: true, fingerprint: maintenance.probe(f.options).fingerprint,
      fault(phase) {
        if (phase !== 'inputs-preserved') return;
        const pending = JSON.parse(fs.readFileSync(guard.lockPath(f.env.TOOLSENABLED_AUDIT_DB)));
        const folder = path.join(f.root, 'audit-identity-archives', pending.operationId);
        for (const directory of [f.root, path.dirname(folder), folder, path.join(folder, 'unverified-input'),
          path.join(folder, 'unverified-input', 'state'), path.join(folder, 'unverified-input', 'logs')]) assert.ok(observed.has(directory), directory);
        throw Object.assign(new Error('stop before live barrier'), { code: 'SIMULATED_PROCESS_STOP' });
      } }), { code: 'SIMULATED_PROCESS_STOP' });
  } finally { guard.syncDirectory = synchronize; }
  assert.equal(maintenance.recover({ ...f.options, quiesced: true }).status, 'rolled-back');
});

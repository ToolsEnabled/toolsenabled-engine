'use strict';

// Local, explicit identity rotation. This module never deletes or replaces the
// vault: exactly the audit key/head pair is changed by the existing atomic
// vault writer. An interrupted file/key cutover leaves a persistent lock and a
// secret-free journal. Recovery follows the key identity actually in custody.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const audit = require('./audit');
const storeApi = require('./audit-store');
const runtime = require('./runtime');
const guard = require('./audit-maintenance-guard');
const { loadPolicy } = require('./policy');
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function fail(code, reason) { throw guard.failure(code, reason); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function safePath(root, candidate) {
  const selected = path.resolve(candidate);
  if (!inside(root, selected)) fail('AUDIT_REKEY_PATH_UNSUPPORTED', 'Audit identity maintenance supports only files inside this installation’s state directory.');
  const relative = path.relative(root, selected);
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) fail('AUDIT_REKEY_PATH_UNSUPPORTED', 'Audit identity maintenance refuses symbolic links and junctions.');
  }
  return selected;
}
function configuration(options = {}) {
  const env = options.env || process.env;
  const stateRoot = options.stateRoot || env.TOOLSENABLED_STATE_ROOT;
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) fail('AUDIT_STATE_ROOT_INVALID', 'This installation has no absolute audit state directory.');
  const root = path.resolve(stateRoot);
  const real = fs.realpathSync(root);
  if ((process.platform === 'win32' ? real.toLowerCase() : real) !== (process.platform === 'win32' ? root.toLowerCase() : root)) fail('AUDIT_REKEY_PATH_UNSUPPORTED', 'The audit state directory must be a direct owned path.');
  const db = safePath(root, env.TOOLSENABLED_AUDIT_DB || path.join(root, 'state', 'audit.sqlite3'));
  const policy = (options.loadPolicy || loadPolicy)();
  const files = audit.resolveFiles(policy, (...parts) => path.join(root, ...parts), env);
  for (const file of Object.values(files)) safePath(root, file);
  const archiveRoot = safePath(root, path.join(root, 'audit-identity-archives'));
  /* THE AUTHORITY ANSWERS WHERE THIS INSTALL'S VAULT IS; this file only checks
   * that the running process agrees. It used to build `root/vault/secrets.json`
   * itself, which is a second copy of src/lib/vault-location.js's layout rule --
   * the copy that goes silently wrong the day the layout changes, on the one
   * code path that rewrites the audit key. vaultReaderContext() pins the state
   * root and ignores any ambient TOOLSENABLED_VAULT_PATH, which is exactly the
   * question being asked here: not "where is this process pointed" but "where
   * does THIS installation keep its vault". Verified equal to the old
   * expression for a named state root before the swap. The refusal is
   * unchanged, including its code. */
  if (!options.getSecret) {
    let expected = null;
    try { expected = require('./vault-location').vaultReaderContext(root, env).location.file; }
    catch { expected = null; }
    if (expected === null || path.resolve(runtime.vaultFilePath()) !== path.resolve(expected)) {
      fail('AUDIT_REKEY_PATH_UNSUPPORTED', 'Audit maintenance must use this installation’s own vault.');
    }
  }
  return { root, db, files, archiveRoot, policy, env, options,
    readSecret: options.getSecret || runtime.getSecret,
    writePair: options.setSecretPair || runtime.setSecretPair,
    pair: options.auditPair || {
      inspect: () => require('./audit-vault-pair').forStateRoot(root, env).inspect(),
      replace: (...args) => require('./audit-vault-pair').forStateRoot(root, env).replace(...args)
    } };
}
function allowedFiles(cfg) {
  const files = new Set([cfg.db, `${cfg.db}-wal`, `${cfg.db}-shm`, ...Object.values(cfg.files),
    path.join(cfg.root, 'state', 'audit-archive.jsonl'),
    path.join(path.dirname(cfg.files.emergency), 'audit-durability.json'),
    path.join(path.dirname(cfg.files.emergency), 'audit-refusals.jsonl')]);
  const directory = path.dirname(cfg.files.emergency);
  const base = path.basename(cfg.files.emergency);
  const stem = path.basename(cfg.files.emergency, path.extname(cfg.files.emergency));
  if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
    if (name.startsWith(`${base}.quarantine-`) || name.startsWith(`${stem}.ingest-`)) files.add(path.join(directory, name));
  }
  const intents = path.join(cfg.root, 'state', 'audit-anchor-intents');
  safePath(cfg.root, intents);
  if (fs.existsSync(intents)) for (const name of fs.readdirSync(intents)) {
    if (!/^\d+\.json$/.test(name)) fail('AUDIT_REKEY_PATH_UNSUPPORTED', 'The audit intent directory contains an unrecognized file.');
    files.add(path.join(intents, name));
  }
  return [...files].map(file => safePath(cfg.root, file));
}
function fingerprintFile(file) {
  return require('./audit-file-inspection').fingerprintFiles([file])[0];
}
function inventory(cfg) {
  const selected = allowedFiles(cfg);
  const fingerprints = require('./audit-file-inspection').fingerprintFiles(selected);
  const files = selected.flatMap((file, index) => {
    const detail = fingerprints[index];
    return detail ? [{ relative: path.relative(cfg.root, file), ...detail }] : [];
  }).sort((a, b) => a.relative.localeCompare(b.relative));
  if (files.length > 128) fail('AUDIT_REKEY_FILE_LIMIT', 'There are too many audit sidecars for one maintenance operation. Review pending audit activity first.');
  return files;
}

function identity(cfg) {
  try {
    const signer = audit.signerFromPrivateKey(cfg.readSecret(audit.SIGNING_VAULT_KEY));
    const anchor = audit.readAnchor({ getSecret: cfg.readSecret }, { fresh: true });
    if (!anchor) fail('AUDIT_REKEY_ANCHOR_UNAVAILABLE', 'The audit identity has no readable protected head.');
    if (signer.keyId !== anchor.keyId) fail('AUDIT_REKEY_IDENTITY_MISMATCH', 'The readable audit key does not match the protected head.');
    return { signer, anchor };
  } catch (error) {
    if (String(error.code || '').startsWith('AUDIT_REKEY_')) throw error;
    fail('AUDIT_REKEY_CUSTODY_UNAVAILABLE', 'The existing audit key and protected head must be readable in this operating-system account. Unlock or repair the supported vault backend first; no vault record was replaced.');
  }
}
/* NEVER TURNED ON IS NOT BROKEN (T1504). A copy where Signed activity audit was
   never enabled has no signing key in the vault and no audit files on disk.
   identity() turned that into 'Unlock or repair the supported vault backend',
   sending a new person to repair a vault that is fine. Only a key the vault
   reports as not configured, with no audit file present, is this state; an
   unreadable vault or any existing history keeps the existing answers. */
function neverEnabled(cfg) {
  try { if (cfg.readSecret(audit.SIGNING_VAULT_KEY)) return false; }
  catch (error) { if (error?.code !== 'SECRET_NOT_CONFIGURED') return false; }
  try { return inventory(cfg).length === 0; } catch { return false; }
}
function snapshot(cfg, keys) {
  return storeApi.withReadOnlyLedger(cfg.db, store => {
    if (store.integrity().join(',') !== 'ok') fail('AUDIT_REKEY_LEDGER_UNHEALTHY', 'The existing audit database failed its integrity check.');
    audit.validateAnchor(keys.anchor, store);
    const boundary = audit.readArchiveBoundary(store, keys.signer);
    const verified = store.verify(boundary);
    if (!verified.verification.valid || verified.status?.headKeyId !== keys.signer.keyId || verified.status?.headSequence !== keys.anchor.sequence) {
      fail('AUDIT_REKEY_LEDGER_UNHEALTHY', 'The existing audit ledger and protected head do not form a verified current identity.');
    }
    if (!audit.verifyReadOnlyProjections(verified.events, cfg.files)) fail('AUDIT_REKEY_PROJECTION_UNHEALTHY', 'Finish or repair pending audit projections before rotating the identity.');
    if (verified.status.projectionLease.held) fail('AUDIT_REKEY_BUSY', 'An audit projection writer still holds its lease.');
    return { headSequence: verified.status.headSequence, headHash: verified.status.headHash, keyId: keys.signer.keyId };
  });
}
const REPAIR_REASONS = Object.freeze(['missing-key', 'unreadable-key', 'invalid-key', 'invalid-head', 'invalid-history']);
function sameOwner(first, second) { return first?.platform === second?.platform && first?.id === second?.id; }
function repairAssessment(cfg) {
  // A damaged audit entry may be replaced only after the *whole* vault's
  // format, owner, backend and ability to preserve its other ciphertext have
  // been independently established. A failed ordinary get is insufficient.
  const pair = cfg.pair.inspect();
  if (!pair || pair.version !== 1 || !HASH.test(pair.digest || '') || !pair.owner?.id
      || typeof pair.owner.elevated !== 'boolean') fail('AUDIT_REKEY_VAULT_UNAVAILABLE', 'The owned encrypted vault could not be inspected safely.');
  let reason = pair.signing === 'missing' ? 'missing-key' : pair.signing === 'unreadable' ? 'unreadable-key' : null;
  let keys = null;
  if (!reason) {
    let signer;
    try { signer = audit.signerFromPrivateKey(cfg.readSecret(audit.SIGNING_VAULT_KEY)); }
    catch (error) {
      if (String(error.code || '').startsWith('SECRET_')) fail('AUDIT_REKEY_VAULT_UNAVAILABLE', 'The vault backend changed while its audit key was inspected.');
      reason = 'invalid-key';
    }
    if (signer) {
      if (pair.head !== 'readable') reason = 'invalid-head';
      else {
        try {
          const anchor = audit.readAnchor({ getSecret: cfg.readSecret }, { fresh: true });
          if (!anchor || signer.keyId !== anchor.keyId) reason = 'invalid-head';
          else keys = { signer, anchor };
        } catch { reason = 'invalid-head'; }
      }
    }
  }
  let observedHeadSequence = null;
  let ledgerDigest = null;
  if (fingerprintFile(cfg.db)) {
    try {
      storeApi.withReadOnlyLedger(cfg.db, store => {
        const status = store.status();
        if (status.projectionLease.held) fail('AUDIT_REKEY_BUSY', 'An audit projection writer still holds its lease.');
        observedHeadSequence = status.headSequence;
        if (store.integrity().join(',') === 'ok') ledgerDigest = store.unverifiedContentDigest();
      });
    } catch (error) {
      if (error.code === 'AUDIT_REKEY_BUSY') throw error;
      // An unreadable database is archived as opaque bytes, never described
      // as verified. Filesystem/path failures are still terminal.
      if (['EACCES', 'EPERM', 'EIO'].includes(error.code)) throw error;
      reason ||= 'invalid-history';
    }
  } else reason ||= 'invalid-history';
  if (!reason && keys) {
    try { snapshot(cfg, keys); return null; }
    catch (error) {
      if (error.code === 'AUDIT_REKEY_BUSY') throw error;
      reason = 'invalid-history';
    }
  }
  if (!REPAIR_REASONS.includes(reason)) fail('AUDIT_REKEY_VAULT_UNAVAILABLE', 'The audit repair state could not be classified safely.');
  const files = inventory(cfg);
  if (!files.length) fail('AUDIT_REKEY_NOT_NEEDED', 'There is no existing audit history to archive. Normal first-run initialization does not require repair.');
  const sqliteFiles = new Set([cfg.db, `${cfg.db}-wal`, `${cfg.db}-shm`].map(file => path.relative(cfg.root, file)));
  const boundFiles = ledgerDigest ? files.filter(item => !sqliteFiles.has(item.relative)) : files;
  const contentFingerprint = hash(JSON.stringify({ operation: 'repair', pair, ledgerDigest, files: boundFiles, generation: guard.generation(cfg.db) }));
  return { pair, reason, observedHeadSequence, files, contentFingerprint,
    fingerprint: hash(JSON.stringify({ contentFingerprint, opaqueWal: require('./audit-wal-input').opaqueWalFingerprint(cfg.db) })) };
}
function archivePath(cfg, name) {
  if (!UUID.test(name || '')) fail('AUDIT_REKEY_JOURNAL_INVALID', 'The audit maintenance archive identity is invalid.');
  return safePath(cfg.root, path.join(cfg.archiveRoot, name));
}
function listArchives(cfg) {
  if (!fs.existsSync(cfg.archiveRoot)) return [];
  return fs.readdirSync(cfg.archiveRoot).filter(name => UUID.test(name)).slice(-100).flatMap(name => {
    const selected = archivePath(cfg, name);
    const manifest = guard.read(safePath(cfg.root, path.join(selected, 'manifest.json')));
    const outcome = guard.read(safePath(cfg.root, path.join(selected, 'outcome.json')));
    return manifest?.version === 1 ? [{ archivePath: selected, createdAt: manifest.createdAt, headSequence: manifest.oldHeadSequence, status: outcome?.status || 'interrupted' }] : [];
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
function journal(cfg) {
  const record = guard.read(guard.lockPath(cfg.db));
  if (!record) return null;
  const repair = record.version === 2 && record.operation === 'repair';
  if ((!repair && record.version !== 1) || !UUID.test(record.operationId || '') || !['preparing', 'ready'].includes(record.phase)
      || (!repair && typeof record.oldKeyId !== 'string') || !HASH.test(record.fingerprint || '')
      || (repair && (!HASH.test(record.oldPairDigest || '') || !record.owner?.id || !REPAIR_REASONS.includes(record.repairReason)))) fail('AUDIT_REKEY_JOURNAL_INVALID', 'The interrupted audit maintenance record needs manual review.');
  archivePath(cfg, record.operationId);
  if (record.phase === 'ready') {
    if (typeof record.newKeyId !== 'string' || !HASH.test(record.newAnchorHash || '') || !Array.isArray(record.oldFiles) || !Array.isArray(record.newFiles)) fail('AUDIT_REKEY_JOURNAL_INVALID', 'The interrupted audit maintenance plan is incomplete.');
  }
  if (record.phase === 'ready' || (repair && record.inputFiles)) {
    if ((record.inputFiles !== undefined && !Array.isArray(record.inputFiles))
        || (record.checkpointFiles !== undefined && !Array.isArray(record.checkpointFiles))) fail('AUDIT_REKEY_JOURNAL_INVALID', 'The preserved input plan is invalid.');
    const fixed = new Set(allowedFiles(cfg).map(file => path.relative(cfg.root, file)));
    for (const item of [...(record.oldFiles || []), ...(record.newFiles || []), ...(record.inputFiles || []), ...(record.checkpointFiles || [])]) {
      const normalized = path.relative(cfg.root, safePath(cfg.root, path.join(cfg.root, item.relative || '')));
      // Only canonical audit paths are admitted. A journal cannot become an
      // arbitrary file move command, even if it was edited after a crash.
      const emergencyDirectory = path.relative(cfg.root, path.dirname(cfg.files.emergency));
      const extra = path.dirname(normalized) === emergencyDirectory && (path.basename(normalized).startsWith(`${path.basename(cfg.files.emergency)}.quarantine-`) || path.basename(normalized).startsWith(`${path.basename(cfg.files.emergency, path.extname(cfg.files.emergency))}.ingest-`));
      const intent = path.dirname(normalized) === path.join('state', 'audit-anchor-intents') && /^\d+\.json$/.test(path.basename(normalized));
      if (normalized !== item.relative || (!fixed.has(normalized) && !extra && !intent) || !HASH.test(item.sha256 || '') || !Number.isSafeInteger(item.size) || item.size < 0) fail('AUDIT_REKEY_JOURNAL_INVALID', 'The interrupted audit maintenance plan names an unsupported file.');
    }
  }
  return record;
}
function probe(options = {}) {
  let cfg;
  try {
    cfg = configuration(options);
    const archives = listArchives(cfg);
    const base = { ok: true, available: true, archiveRoot: cfg.archiveRoot, archives, lastArchivePath: archives[0]?.archivePath || null };
    const pending = journal(cfg);
    const generation = guard.generation(cfg.db);
    if (pending?.version === 2) {
      const pair = cfg.pair.inspect();
      const owned = sameOwner(pair.owner, pending.owner);
      let known = owned && pair.digest === pending.oldPairDigest;
      if (!known && owned && pending.phase === 'ready') {
        try {
          const current = identity(cfg);
          known = current.signer.keyId === pending.newKeyId && hash(storeApi.canonicalJson(current.anchor)) === pending.newAnchorHash;
        } catch { /* No known old/new generation: keep the journal closed. */ }
      }
      return { ...base, status: 'interrupted', canRotate: false, canRepair: false, canRecover: known,
        fingerprint: hash(JSON.stringify({ pending, pair, files: inventory(cfg) })),
        reason: known ? 'Audit repair was interrupted. Recovery preserves the old files or completes the verified replacement identity.'
          : 'The interrupted repair does not match the current vault generation. Preserve it for review.' };
    }
    if (!pending && neverEnabled(cfg)) {
      return { ...base, status: 'none', canRotate: false, canRepair: false, canRecover: false,
        reason: 'There is no audit signing identity yet. One is created when Signed activity audit is turned on.' };
    }
    const keys = identity(cfg);
    if (pending) {
      const known = [pending.oldKeyId, pending.newKeyId].includes(keys.signer.keyId);
      return { ...base, status: 'interrupted', canRotate: false, canRepair: false, canRecover: known, headSequence: keys.anchor.sequence,
        fingerprint: hash(JSON.stringify({ pending, keyId: keys.signer.keyId, anchor: keys.anchor, files: inventory(cfg) })),
        reason: known ? 'A prior rotation was interrupted. Recovery follows the key generation actually stored in the vault.' : 'The interrupted rotation does not match the readable vault identity.' };
    }
    const checked = snapshot(cfg, keys);
    // SQLite may checkpoint or remove an empty WAL when a read handle closes.
    // The verified head/anchor bind its logical history; physical DB/WAL/SHM
    // bytes are hashed again for the archive after the writer barrier.
    const sqliteFiles = new Set([cfg.db, `${cfg.db}-wal`, `${cfg.db}-shm`].map(file => path.relative(cfg.root, file)));
    const files = inventory(cfg).filter(item => !sqliteFiles.has(item.relative));
    return { ...base, status: 'healthy', canRotate: true, canRepair: false, canRecover: false, headSequence: checked.headSequence,
      fingerprint: hash(JSON.stringify({ checked, anchor: keys.anchor, generation, files })), reason: 'The current audit identity is readable and its live ledger is verified.' };
  } catch (error) {
    // An existing or ambiguous journal must never be bypassed by starting a
    // second repair. Likewise an active writer or unsafe path is not damage.
    if (cfg && !['AUDIT_REKEY_BUSY', 'AUDIT_MAINTENANCE_INVALID', 'AUDIT_REKEY_PATH_UNSUPPORTED',
      'AUDIT_REKEY_JOURNAL_INVALID', 'AUDIT_REKEY_FILE_UNSUPPORTED'].includes(error.code)) {
      try {
        if (!journal(cfg)) {
          const assessment = repairAssessment(cfg);
          if (assessment) return { ok: true, available: true, status: 'repairable', canRotate: false, canRepair: true, canRecover: false,
            repairReason: assessment.reason, custody: assessment.pair.owner, headSequence: assessment.observedHeadSequence, fingerprint: assessment.fingerprint,
            archiveRoot: cfg.archiveRoot, archives: listArchives(cfg), lastArchivePath: listArchives(cfg)[0]?.archivePath || null,
            reason: 'The audit key, protected head, or old history cannot be verified. Repair can preserve that history in an unverified archive and start a new signed chain.' };
        }
      } catch (repairError) {
        if (repairError.code === 'AUDIT_REKEY_BUSY') error = repairError;
      }
    }
    return { ok: true, available: true, canRotate: false, canRepair: false, canRecover: false, status: 'unavailable', code: error.code || 'AUDIT_REKEY_UNAVAILABLE',
      reason: error.code ? error.message : 'The audit identity could not be inspected safely.', archiveRoot: cfg?.archiveRoot || null, archives: [] };
  }
}
function move(source, destination, cfg) {
  safePath(cfg.root, source); safePath(cfg.root, destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.renameSync(source, destination);
  guard.syncDirectory(path.dirname(source)); guard.syncDirectory(path.dirname(destination));
}
function matches(file, expected) {
  const observed = fingerprintFile(file);
  return Boolean(observed && observed.size === expected.size && observed.sha256 === expected.sha256);
}
function preserveInputs(cfg, folder, files) {
  for (const item of files) {
    const source = safePath(cfg.root, path.join(cfg.root, item.relative));
    const saved = safePath(cfg.root, path.join(folder, 'unverified-input', item.relative));
    fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, saved, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(saved, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Flush the whole new directory chain, not just the leaf: a durable
    // copied WAL is useless if a crash loses its UUID/input-directory entry.
    for (let directory = path.dirname(saved); ; directory = path.dirname(directory)) {
      guard.syncDirectory(directory);
      if (directory === cfg.root) break;
    }
    if (!matches(saved, item) || !matches(source, item)) fail('AUDIT_REKEY_STATE_CHANGED', 'An audit input changed before it could be preserved.');
  }
}
function stageGenesis(cfg, folder, operationId, manifestDigest, repairReason = null) {
  const generated = crypto.generateKeyPairSync('ed25519');
  const privatePem = generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signer = audit.signerFromPrivateKey(privatePem);
  const stageRoot = path.join(folder, 'staging');
  const stageDb = path.join(stageRoot, path.relative(cfg.root, cfg.db));
  const env = { ...cfg.env, TOOLSENABLED_STATE_ROOT: stageRoot, TOOLSENABLED_AUDIT_DB: stageDb };
  for (const [sink, name] of [['jsonl', 'TOOLSENABLED_AUDIT_JSONL_PATH'], ['text', 'TOOLSENABLED_AUDIT_TEXT_PATH'], ['emergency', 'TOOLSENABLED_AUDIT_EMERGENCY_PATH']]) env[name] = path.join(stageRoot, path.relative(cfg.root, cfg.files[sink]));
  let anchor = null;
  const store = storeApi.createAuditStore({ file: stageDb });
  try {
    const result = audit.record(repairReason ? 'audit.identity.repaired' : 'audit.identity.rotated', 'local-settings', {
      operationId, archiveManifestDigest: manifestDigest,
      ...(repairReason ? { repairReason, priorHistoryVerified: false } : {}),
      continuity: 'New signing identity. Prior history remains in the archive; this signature does not attest that prior history.'
    }, { store, signer, rootPath: (...parts) => path.join(stageRoot, ...parts), env,
      loadPolicy: () => ({ ...cfg.policy, audit: { ...cfg.policy.audit, enabled: true } }),
      anchorStore: { get: () => anchor, set: value => { anchor = value; } }, anchorRequired: true, reportError: () => {} });
    if (!result.durable || !result.anchored || !result.projected || !anchor) fail('AUDIT_REKEY_STAGING_FAILED', 'The replacement audit genesis could not be durably staged.');
  } finally { store.close(); }
  return { privatePem, signer, anchor, stageRoot, files: inventory({ ...cfg, root: stageRoot, db: stageDb,
    files: Object.fromEntries(Object.entries(cfg.files).map(([sink, file]) => [sink, path.join(stageRoot, path.relative(cfg.root, file))])) }) };
}
function release(cfg) {
  fs.unlinkSync(guard.lockPath(cfg.db));
  guard.syncDirectory(path.dirname(cfg.db));
}
function recover(options = {}) {
  const cfg = configuration(options);
  const pending = journal(cfg);
  if (!pending) fail('AUDIT_REKEY_NOT_PENDING', 'There is no interrupted audit identity operation.');
  const isRepair = pending.version === 2;
  if (isRepair && options.quiesced !== true) fail('AUDIT_REKEY_BUSY', 'Close the application’s audit writers before recovering repair.');
  const pair = isRepair ? cfg.pair.inspect() : null;
  if (isRepair && !sameOwner(pair.owner, pending.owner)) fail('AUDIT_REKEY_RECOVERY_CONFLICT', 'The interrupted repair belongs to a different operating-system identity.');
  let keys;
  const old = isRepair ? pair.digest === pending.oldPairDigest : (keys = identity(cfg)).signer.keyId === pending.oldKeyId;
  const folder = archivePath(cfg, pending.operationId);
  if (isRepair && pending.inputFiles) {
    for (const item of pending.inputFiles) if (!matches(safePath(cfg.root, path.join(folder, 'unverified-input', item.relative)), item)) {
      fail('AUDIT_REKEY_RECOVERY_CONFLICT', 'A preserved pre-maintenance audit input is missing or changed. The journal was retained.');
    }
    if (old && pending.phase === 'preparing') {
      const expected = pending.checkpointFiles || pending.inputFiles;
      if (JSON.stringify(inventory(cfg)) !== JSON.stringify(expected)) fail('AUDIT_REKEY_RECOVERY_CONFLICT', 'The interrupted writer barrier has an uncertain file outcome. Preserved original inputs and the journal were retained for review.');
    }
  }
  if (old) {
    if (pending.phase === 'ready') {
      for (const item of pending.newFiles) {
        const live = safePath(cfg.root, path.join(cfg.root, item.relative));
        if (!fingerprintFile(live)) continue;
        const prior = pending.oldFiles.find(old => old.relative === item.relative);
        if (prior && matches(live, prior)) continue;
        if (!matches(live, item)) fail('AUDIT_REKEY_RECOVERY_CONFLICT', 'An audit file changed after the interrupted rotation. It was preserved for review.');
        move(live, path.join(folder, 'staging', item.relative), cfg);
      }
      for (const item of pending.oldFiles) {
        const live = safePath(cfg.root, path.join(cfg.root, item.relative));
        const archived = safePath(cfg.root, path.join(folder, 'history', item.relative));
        if (matches(live, item)) continue;
        if (fingerprintFile(live) || !matches(archived, item)) fail('AUDIT_REKEY_RECOVERY_CONFLICT', 'The original audit file cannot be restored without overwriting changed data.');
        move(archived, live, cfg);
      }
    }
    if (!isRepair) snapshot(cfg, keys);
    guard.durableJson(path.join(folder, 'outcome.json'), { version: 1, status: 'rolled-back', at: new Date().toISOString() });
    release(cfg);
    return { ok: true, status: 'rolled-back', archivePath: folder, restartRequired: isRepair,
      reason: isRepair ? 'The audit pair was not replaced. Its working history was retained or restored, and pre-maintenance input copies remain in the archive; restart before inspecting repair again.'
        : 'The old key remained in custody, so the original audit history was restored.' };
  }
  keys ||= identity(cfg);
  if (pending.phase !== 'ready' || keys.signer.keyId !== pending.newKeyId || hash(storeApi.canonicalJson(keys.anchor)) !== pending.newAnchorHash) fail('AUDIT_REKEY_RECOVERY_CONFLICT', 'The vault identity does not prove a recoverable audit generation.');
  for (const item of pending.newFiles) {
    const live = safePath(cfg.root, path.join(cfg.root, item.relative));
    if (matches(live, item)) continue;
    const staged = safePath(cfg.root, path.join(folder, 'staging', item.relative));
    if (fingerprintFile(live) || !matches(staged, item)) fail('AUDIT_REKEY_RECOVERY_CONFLICT', 'The new audit file is missing or changed. The recovery journal was preserved.');
    move(staged, live, cfg);
  }
  for (const item of pending.oldFiles) if (!matches(safePath(cfg.root, path.join(folder, 'history', item.relative)), item)) fail('AUDIT_REKEY_RECOVERY_CONFLICT', 'An archived audit file is missing or changed. The recovery journal was preserved.');
  snapshot(cfg, keys);
  guard.durableJson(guard.generationPath(cfg.db), { version: 1, generation: pending.operationId });
  guard.durableJson(path.join(folder, 'outcome.json'), { version: 1, status: 'complete', at: new Date().toISOString() });
  release(cfg);
  return { ok: true, status: isRepair ? 'repaired' : 'rotated', archivePath: folder, restartRequired: true,
    reason: 'The prior audit history was archived and a new signing identity started. Restart the app before starting agents.' };
}
function repair(options = {}) {
  const cfg = configuration(options);
  if (options.quiesced !== true) fail('AUDIT_REKEY_BUSY', 'Close the application’s audit writers before repair.');
  const before = probe(options);
  if (!before.canRepair || before.fingerprint !== options.fingerprint) fail('AUDIT_REKEY_STATE_CHANGED', 'The audit state changed. Inspect and confirm repair again.');
  const assessed = repairAssessment(cfg);
  if (assessed.fingerprint !== before.fingerprint) fail('AUDIT_REKEY_STATE_CHANGED', 'Audit activity changed during inspection. Inspect and confirm again.');
  const operationId = crypto.randomUUID();
  const folder = archivePath(cfg, operationId);
  const pending = { version: 2, operation: 'repair', operationId, phase: 'preparing', fingerprint: before.fingerprint,
    oldPairDigest: assessed.pair.digest, owner: assessed.pair.owner, repairReason: assessed.reason };
  guard.durableJson(guard.lockPath(cfg.db), pending, { exclusive: true });
  try {
    options.fault?.('lock-created');
    preserveInputs(cfg, folder, assessed.files);
    const manifest = { version: 1, operationId, createdAt: new Date().toISOString(), operation: 'repair',
      oldHeadSequence: assessed.observedHeadSequence, oldKeyId: null, files: [], owner: assessed.pair.owner,
      priorHistoryVerified: false, repairReason: assessed.reason, unverifiedInputFiles: assessed.files,
      continuity: 'Exact pre-maintenance input bytes are preserved in unverified-input. Working history after the writer barrier is in history. The new identity does not attest either.' };
    guard.durableJson(path.join(folder, 'manifest.json'), manifest, { exclusive: true });
    pending.inputFiles = assessed.files;
    guard.durableJson(guard.lockPath(cfg.db), pending);
    options.fault?.('inputs-preserved');
    if (repairAssessment(cfg).fingerprint !== before.fingerprint) fail('AUDIT_REKEY_STATE_CHANGED', 'Audit activity changed while its original inputs were preserved. Inspect and confirm again.');
    // Take the normal writer barrier whenever SQLite can read the old file.
    // NOTADB/CORRUPT means no supported audit transaction can append; those
    // bytes (including WAL) are preserved opaquely after app quiescence.
    if (fingerprintFile(cfg.db)) {
      let db;
      try {
        db = new DatabaseSync(process.platform === 'win32' ? path.toNamespacedPath(cfg.db) : cfg.db, { allowExtension: false });
        db.exec('PRAGMA busy_timeout=1000'); db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
        const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (Object.values(checkpoint)[0] !== 0) fail('AUDIT_REKEY_BUSY', 'Another audit writer prevented a complete checkpoint.');
      } catch (error) {
        if (![11, 26].includes(error.errcode)) throw error;
      } finally { db?.close(); }
    }
    const guarded = repairAssessment(cfg);
    if (guarded.contentFingerprint !== assessed.contentFingerprint) fail('AUDIT_REKEY_STATE_CHANGED', 'Audit activity changed before the writer barrier. Inspect and confirm repair again.');
    const oldFiles = guarded.files;
    pending.checkpointFiles = oldFiles;
    guard.durableJson(guard.lockPath(cfg.db), pending);
    Object.assign(manifest, { files: oldFiles, missingFiles: allowedFiles(cfg).filter(file => !fingerprintFile(file)).map(file => path.relative(cfg.root, file)) });
    guard.durableJson(path.join(folder, 'manifest.json'), manifest);
    guard.durableJson(path.join(folder, 'unsigned-break.json'), { version: 1, operationId, signed: false, repairReason: assessed.reason,
      reason: 'The person requested repair of audit custody or history. The archive is unverified and this marker grants it no authenticity.' }, { exclusive: true });
    const staged = stageGenesis(cfg, folder, operationId, hash(JSON.stringify(manifest)), assessed.reason);
    Object.assign(pending, { phase: 'ready', oldFiles, newFiles: staged.files, newKeyId: staged.signer.keyId, newAnchorHash: hash(staged.anchor) });
    guard.durableJson(guard.lockPath(cfg.db), pending);
    options.fault?.('prepared');
    for (const item of oldFiles) {
      const source = path.join(cfg.root, item.relative);
      if (!matches(source, item)) fail('AUDIT_REKEY_STATE_CHANGED', 'An audit file changed during repair.');
      move(source, path.join(folder, 'history', item.relative), cfg);
    }
    options.fault?.('archived');
    for (const item of staged.files) move(path.join(staged.stageRoot, item.relative), path.join(cfg.root, item.relative), cfg);
    options.fault?.('installed');
    cfg.pair.replace(pending.oldPairDigest, staged.privatePem, staged.anchor);
    options.fault?.('vault-committed');
    return recover(options);
  } catch (error) {
    if (error.code === 'SIMULATED_PROCESS_STOP') throw error;
    try { const outcome = recover(options); if (outcome.status === 'repaired') return outcome; }
    catch { fail('AUDIT_REKEY_RECOVERY_REQUIRED', 'Audit repair stopped with its recovery journal preserved. Inspect and recover it before new audit writes.'); }
    throw error;
  }
}
function rotate(options = {}) {
  const cfg = configuration(options);
  const before = probe(options);
  if (!before.canRotate || options.fingerprint !== before.fingerprint) fail('AUDIT_REKEY_STATE_CHANGED', 'The audit state changed. Inspect it again before confirming rotation.');
  const keys = identity(cfg);
  const operationId = crypto.randomUUID();
  const folder = archivePath(cfg, operationId);
  const pending = { version: 1, operationId, phase: 'preparing', oldKeyId: keys.signer.keyId, fingerprint: before.fingerprint };
  guard.durableJson(guard.lockPath(cfg.db), pending, { exclusive: true });
  try {
    // The marker is visible before the SQLite writer barrier. Any older
    // transaction completes first; newer transactions recheck the marker
    // after BEGIN IMMEDIATE and refuse before their callback can mutate.
    const db = new DatabaseSync(process.platform === 'win32' ? path.toNamespacedPath(cfg.db) : cfg.db, { allowExtension: false });
    try {
      db.exec('PRAGMA busy_timeout=1000');
      db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (Object.values(checkpoint)[0] !== 0) fail('AUDIT_REKEY_BUSY', 'Another audit connection prevented a complete checkpoint.');
    } finally { db.close(); }
    const checked = snapshot(cfg, keys);
    const oldFiles = inventory(cfg);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const manifest = { version: 1, operationId, createdAt: new Date().toISOString(), oldHeadSequence: checked.headSequence,
      oldKeyId: checked.keyId, files: oldFiles, continuity: 'Archived prior identity; the replacement identity does not attest this history.' };
    guard.durableJson(path.join(folder, 'manifest.json'), manifest, { exclusive: true });
    guard.durableJson(path.join(folder, 'unsigned-break.json'), { version: 1, operationId, signed: false,
      reason: 'The person explicitly requested a new audit signing identity. This marker has no cryptographic authority over the archived history.' }, { exclusive: true });
    const staged = stageGenesis(cfg, folder, operationId, hash(JSON.stringify(manifest)));
    Object.assign(pending, { phase: 'ready', oldFiles, newFiles: staged.files, newKeyId: staged.signer.keyId, newAnchorHash: hash(staged.anchor) });
    guard.durableJson(guard.lockPath(cfg.db), pending);
    options.fault?.('prepared');
    for (const item of oldFiles) {
      const source = path.join(cfg.root, item.relative);
      if (!matches(source, item)) fail('AUDIT_REKEY_STATE_CHANGED', 'An audit writer changed a file during rotation.');
      move(source, path.join(folder, 'history', item.relative), cfg);
    }
    options.fault?.('archived');
    for (const item of staged.files) move(path.join(staged.stageRoot, item.relative), path.join(cfg.root, item.relative), cfg);
    options.fault?.('installed');
    cfg.writePair(audit.SIGNING_VAULT_KEY, staged.privatePem, audit.HEAD_VAULT_KEY, staged.anchor);
    options.fault?.('vault-committed');
    return recover(options);
  } catch (error) {
    if (error.code === 'SIMULATED_PROCESS_STOP') throw error;
    try { const outcome = recover(options); if (outcome.status === 'rotated') return outcome; }
    catch { fail('AUDIT_REKEY_RECOVERY_REQUIRED', 'Audit rotation stopped with a recovery journal preserved. Inspect and recover it in Settings before new audit writes.'); }
    throw error;
  }
}
function revealArchive(archive, options = {}) {
  const cfg = configuration(options);
  if (typeof archive !== 'string' || !listArchives(cfg).some(item => item.archivePath === archive)) fail('AUDIT_REKEY_ARCHIVE_UNKNOWN', 'Choose an archive reported by this installation’s audit inspection.');
  return safePath(cfg.root, archive);
}

module.exports = { probe, rotate, repair, recover, revealArchive };

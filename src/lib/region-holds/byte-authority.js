'use strict';

// Exact exposure coordination for mediated file tools. The authority does not
// infer semantic dependence, and cannot fence writes that bypass its adapters.
//
// A SQLite writer transaction in lock.sqlite remains open for the complete
// operation. SQLite's OS locks have no age-steal rule and are released if the
// process dies. Data commits use a separate database, so PREPARED can be durable
// before publication without releasing that lifetime lock.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertAccountProfilePath } = require('../account-profile-boundary');
const { statePath } = require('../runtime-state-root');

// @source(repo.read_file/repo.write_file/repo.patch_file materialization bound).
const MAX_RESOURCE_BYTES = 512 * 1024;
// @source(worktree-lease-state default acquisition budget and polling interval).
const LOCK_TIMEOUT_MS = 10000;
const LOCK_RETRY_MS = 10;
// @source(BUILDOUT-2026-08-25 defaults: adaptive per-key read-claim lifetime).
const SOLO_LEASE_MS = 60 * 60 * 1000;
const CONTENDED_LEASE_MS = 60 * 1000;
// @source(this append/receipt format; increments require explicit migration).
const SCHEMA_VERSION = 2;
const APPLICATION_ID = 0x54454259; // "TEBY".
const SHA256 = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^operation-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// @source(Node BigIntStats dev/ino fields; zero inode cannot identify a stage).
const DEVICE_ID = /^(?:0|[1-9][0-9]{0,19})$/;
const INODE_ID = /^[1-9][0-9]{0,19}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SCOPE_KINDS = new Set(['owner-host-session', 'standalone-mcp', 'paired-desktop']);
const WHOLE_FILE_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'cargo.lock', 'poetry.lock', 'gemfile.lock', 'composer.lock'
]);

class ByteCoordinationRefusal extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ByteCoordinationRefusal';
    this.code = code;
    this.details = Object.freeze(details);
  }
}
function refuse(code, message, details, cause) {
  throw new ByteCoordinationRefusal(code, message, details, cause);
}
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function json(value) { return JSON.stringify(value); }
function token(prefix) { return prefix + '-' + crypto.randomUUID(); }
function identifier(value, field) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    refuse('BYTE_BINDING_INVALID', 'A private coordination binding is missing or invalid.', { field });
  }
  return value;
}
function normalizeBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SCOPE_KINDS.has(value.scopeKind)) {
    refuse('BYTE_BINDING_INVALID', 'A host-issued coordination scope is required.');
  }
  const result = {
    principal: identifier(value.principal, 'principal'),
    runtimeScopeId: identifier(value.runtimeScopeId, 'runtimeScopeId'),
    scopeKind: value.scopeKind
  };
  for (const field of ['canonicalLaunchId', 'laneId', 'runId', 'rosterRef']) {
    result[field] = value[field] == null ? null : identifier(value[field], field);
  }
  return Object.freeze(result);
}
function resourceKey(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    refuse('BYTE_RESOURCE_INVALID', 'The provider must supply an absolute canonical resource.');
  }
  const admitted = assertAccountProfilePath(value, { field: 'byte coordination resource' });
  return process.platform === 'win32' ? admitted.toLowerCase() : admitted;
}
function checkedRange(start, end, size, { empty = true } = {}) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > size || (!empty && start === end)) {
    refuse('BYTE_RANGE_INVALID', 'The byte range is outside the materialized file.', {
      startByte: start, endByte: end, totalBytes: size
    });
  }
}
function intersects(a, b, c, d) {
  // A point records an empty-file/EOF observation or a deletion requiring
  // repair. Equal insertion points conflict; adjacent nonempty spans do not.
  if (a === b && c === d) return a === c;
  if (a === b) return c <= a && a < d;
  if (c === d) return a <= c && c < b;
  return a < d && c < b;
}
function covers(a, b, c, d) {
  // Reading a span observes both of its coordinate boundaries. Inserting at
  // its end does not invalidate another reader of only the left-hand bytes.
  return a <= c && b >= d;
}
function isBusy(error) {
  return error && ((Number.isInteger(error.errcode) && [5, 6].includes(error.errcode & 255))
    || /database (?:is )?(?:busy|locked)/i.test(String(error.message)));
}
function parse(value, label) {
  try { return JSON.parse(value); }
  catch (error) { refuse('BYTE_STATE_CORRUPT', 'The byte coordination state is corrupt.', { record: label }, error); }
}
function safeFile(file, { missing = true } = {}) {
  const admitted = assertAccountProfilePath(file, { field: 'byte coordination store', requireOwnedProfile: true });
  try {
    const stat = fs.lstatSync(admitted);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      refuse('BYTE_STATE_UNAVAILABLE', 'The byte coordination database is not a regular unlinked file.');
    }
  } catch (error) {
    if (!(missing && error.code === 'ENOENT')) throw error;
  }
  return admitted;
}

const RESOURCE_TABLE = 'CREATE TABLE resources (resource TEXT PRIMARY KEY, version INTEGER NOT NULL, sha256 TEXT, byte_length INTEGER NOT NULL, present INTEGER NOT NULL CHECK(present IN (0,1)), CHECK((present=0 AND sha256 IS NULL AND byte_length=0) OR (present=1 AND sha256 IS NOT NULL AND byte_length>=0)))';
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, authority_id TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS scopes (scope_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0)',
  RESOURCE_TABLE.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '),
  'CREATE TABLE IF NOT EXISTS receipts (ref TEXT PRIMARY KEY, scope_id TEXT NOT NULL, resource TEXT NOT NULL, created_ms INTEGER NOT NULL, receipt_json TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS receipts_by_scope_resource ON receipts(scope_id, resource, created_ms DESC)',
  'CREATE TABLE IF NOT EXISTS reads (id TEXT PRIMARY KEY, receipt_ref TEXT NOT NULL, scope_id TEXT NOT NULL, resource TEXT NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, observed BLOB NOT NULL, version INTEGER NOT NULL, expires_ms INTEGER NOT NULL, stale_reason TEXT)',
  'CREATE INDEX IF NOT EXISTS reads_by_scope ON reads(scope_id, resource)',
  'CREATE INDEX IF NOT EXISTS reads_by_receipt ON reads(receipt_ref, scope_id, resource)',
  'CREATE INDEX IF NOT EXISTS reads_by_interval ON reads(resource, start_byte, end_byte)',
  'CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, status TEXT NOT NULL, operation_json TEXT NOT NULL, receipt_json TEXT)',
  'CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, kind TEXT NOT NULL, at_ms INTEGER NOT NULL, payload_json TEXT NOT NULL)'
].join(';');

// A separate instance keeps its own store directory, so resources of different
// providers (repo.* package paths, host.* profile paths) can never share rows.
const STORE_NAME = /^byte-coordination(?:-[a-z0-9]+)*$/;
// @source(host-control.js MAX_FILE_BYTES; the largest provider bound admitted).
const MAX_CONFIGURABLE_RESOURCE_BYTES = 2 * 1024 * 1024;

class ByteAuthority {
  // Every option after lockTimeoutMs is opt-in; the defaults are exactly the
  // repo.* authority's historical behaviour and store.
  //   storeName             directory under <stateRoot>/state (default byte-coordination)
  //   maxResourceBytes      materialization/write bound (default MAX_RESOURCE_BYTES)
  //   readSetScope          'scope' validates and recovers the scope's whole read
  //                         set; 'resource' only the resource being written
  //   writeRequiresObservation  replacing an existing file requires this scope's
  //                         current observations to cover every current byte
  //   observeOwnWrites      a committed whole-file write leaves its writer a
  //                         current observation of exactly the confirmed bytes
  //   pruneCommittedPayloads    a committed operation keeps hashes/receipts but
  //                         drops its replacement payload from the journal
  constructor({ stateRoot, materialize, publish, prepareCreate, reconcileCreateStage, now = () => Date.now(), lockTimeoutMs = LOCK_TIMEOUT_MS,
    storeName = 'byte-coordination', maxResourceBytes = MAX_RESOURCE_BYTES, readSetScope = 'scope',
    writeRequiresObservation = false, observeOwnWrites = false, pruneCommittedPayloads = false } = {}) {
    if (typeof materialize !== 'function' || typeof publish !== 'function' || typeof now !== 'function'
        || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
      refuse('BYTE_ADAPTER_INVALID', 'Byte coordination requires private materialize and publish adapters.');
    }
    if (typeof storeName !== 'string' || !STORE_NAME.test(storeName)
        || !Number.isSafeInteger(maxResourceBytes) || maxResourceBytes < 1 || maxResourceBytes > MAX_CONFIGURABLE_RESOURCE_BYTES
        || !['scope', 'resource'].includes(readSetScope)
        || typeof writeRequiresObservation !== 'boolean' || typeof observeOwnWrites !== 'boolean'
        || typeof pruneCommittedPayloads !== 'boolean') {
      refuse('BYTE_ADAPTER_INVALID', 'Byte coordination options are invalid.');
    }
    const directory = stateRoot
      ? path.join(assertAccountProfilePath(stateRoot, { field: 'byte coordination state root', requireOwnedProfile: true }), 'state', storeName)
      : statePath('state', storeName);
    this.directory = assertAccountProfilePath(directory, { field: 'byte coordination directory', requireOwnedProfile: true });
    this.lockFile = path.join(this.directory, 'lock.sqlite');
    this.dataFile = path.join(this.directory, 'data.sqlite');
    this.materialize = materialize;
    this.publish = publish;
    this.prepareCreate = prepareCreate;
    this.reconcileCreateStage = reconcileCreateStage;
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
    this.maxResourceBytes = maxResourceBytes;
    this.readSetScope = readSetScope;
    this.writeRequiresObservation = writeRequiresObservation;
    this.observeOwnWrites = observeOwnWrites;
    this.pruneCommittedPayloads = pruneCommittedPayloads;
    this.callbackErrors = new WeakSet();
  }

  async _call(callback, argument) {
    try { return await callback(argument); }
    catch (error) {
      if (error && (typeof error === 'object' || typeof error === 'function')) this.callbackErrors.add(error);
      throw error;
    }
  }

  async _assertCurrent(callback) {
    if (callback !== undefined) {
      if (typeof callback !== 'function') refuse('BYTE_ADAPTER_INVALID', 'assertCurrent must be a private callback.');
      await this._call(callback);
    }
  }

  _assertCurrentNow(callback) {
    if (callback === undefined) return;
    if (typeof callback !== 'function') refuse('BYTE_ADAPTER_INVALID', 'assertCurrent must be a private callback.');
    let result;
    try { result = callback(); }
    catch (error) {
      if (error && (typeof error === 'object' || typeof error === 'function')) this.callbackErrors.add(error);
      throw error;
    }
    if (result && typeof result.then === 'function') {
      // Final publication/release checks must not introduce a microtask gap.
      // Consume a rejected promise without accepting it as a valid guard.
      Promise.resolve(result).catch(() => {});
      refuse('BYTE_ADAPTER_INVALID', 'The final private scope guard must be synchronous.');
    }
  }

  _time() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) refuse('BYTE_CLOCK_INVALID', 'The coordination clock is unavailable.');
    return value;
  }

  async _locked(callback) {
    // No module-load database access. All paths are checked before SQLite opens
    // them, including existing SQLite sidecars, which must not redirect writes.
    assertAccountProfilePath(this.directory, { field: 'byte coordination directory', requireOwnedProfile: true });
    fs.mkdirSync(this.directory, { recursive: true });
    for (const base of [this.lockFile, this.dataFile]) {
      for (const suffix of ['', '-journal', '-wal', '-shm']) safeFile(base + suffix);
    }
    const { DatabaseSync } = require('node:sqlite');
    const deadline = performance.now() + this.lockTimeoutMs;
    let lock;
    for (;;) {
      try {
        lock = new DatabaseSync(this.lockFile, { allowExtension: false });
        lock.exec('PRAGMA busy_timeout=0; PRAGMA temp_store=MEMORY; BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if (lock) { try { lock.close(); } catch {} lock = null; }
        if (!isBusy(error)) refuse('BYTE_STATE_UNAVAILABLE', 'The byte coordination authority could not be opened.', {}, error);
        if (performance.now() >= deadline) {
          refuse('BYTE_AUTHORITY_BUSY', 'Another file operation is still publishing; retry this operation.', {});
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(LOCK_RETRY_MS, Math.max(1, deadline - performance.now()))));
      }
    }
    let db;
    let completed = false;
    try {
      lock.exec('CREATE TABLE IF NOT EXISTS authority (id INTEGER PRIMARY KEY CHECK(id=1), authority_id TEXT NOT NULL)');
      const existing = lock.prepare('SELECT authority_id FROM authority WHERE id=1').get();
      if (existing && !fs.existsSync(this.dataFile)) {
        refuse('BYTE_STATE_MISSING', 'The recorded byte coordination database is missing; existing observations cannot be treated as empty.');
      }
      db = new DatabaseSync(safeFile(this.dataFile), { allowExtension: false, enableForeignKeyConstraints: true });
      db.exec('PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=0');
      const application = db.prepare('PRAGMA application_id').get().application_id;
      if (application !== 0 && application !== APPLICATION_ID) refuse('BYTE_STATE_CORRUPT', 'This database belongs to a different service.');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(SCHEMA);
        let meta = db.prepare('SELECT * FROM meta WHERE id=1').get();
        if (!meta) {
          if (existing) refuse('BYTE_STATE_CORRUPT', 'The byte coordination schema identity is missing.');
          meta = { schema_version: SCHEMA_VERSION, authority_id: token('authority') };
          db.prepare('INSERT INTO meta VALUES(1,?,?)').run(meta.schema_version, meta.authority_id);
          db.exec('PRAGMA application_id=' + APPLICATION_ID);
        }
        if (![1, SCHEMA_VERSION].includes(meta.schema_version) || (existing && existing.authority_id !== meta.authority_id)) {
          refuse('BYTE_STATE_CORRUPT', 'The byte coordination database identity or schema does not match.');
        }
        if (meta.schema_version === 1) {
          // Every v1 resource came from a successful existing-file observation.
          // Its operation/receipt JSON and integrity checksums remain untouched;
          // pending v1 patches are interpreted only after their original hash
          // is checked. A failed migration rolls back with this transaction.
          db.exec(RESOURCE_TABLE.replace('CREATE TABLE resources ', 'CREATE TABLE resources_v2 '));
          db.exec('INSERT INTO resources_v2(resource,version,sha256,byte_length,present) SELECT resource,version,sha256,byte_length,1 FROM resources');
          db.exec('DROP TABLE resources; ALTER TABLE resources_v2 RENAME TO resources');
          db.prepare('UPDATE meta SET schema_version=? WHERE id=1').run(SCHEMA_VERSION);
          this._event(db, 'authority.schema-migrated', { fromSchemaVersion: 1, toSchemaVersion: SCHEMA_VERSION });
        }
        if (!existing) lock.prepare('INSERT INTO authority VALUES(1,?)').run(meta.authority_id);
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      const result = await callback(db);
      completed = true;
      return result;
    } catch (error) {
      if (error instanceof ByteCoordinationRefusal || (error && this.callbackErrors.has(error))) throw error;
      refuse('BYTE_STATE_UNAVAILABLE', 'The byte coordination operation could not be completed.', {}, error);
    } finally {
      if (db) { try { db.close(); } catch {} }
      // Commit the lock database's initialization even when an operation is
      // refused: losing data.sqlite after first use must not create a new store.
      try { await this._releaseLock(lock); }
      catch (error) {
        try { lock.exec('ROLLBACK'); } catch {}
        if (completed) refuse('BYTE_AUTHORITY_RELEASE_FAILED', 'The operation completed but authority release could not be confirmed.', {}, error);
      } finally { lock.close(); }
    }
  }

  // Releasing the lock is a COMMIT, and a COMMIT needs SQLite's EXCLUSIVE lock.
  // A competing acquirer holds SHARED for the instant its own BEGIN IMMEDIATE
  // is being refused, which is enough to make this COMMIT return SQLITE_BUSY on
  // a connection pinned at busy_timeout=0. That is transient contention, not a
  // failed release: the transaction stays live and a later COMMIT lands the same
  // writes. Retry it on the acquisition budget, because giving up here reports a
  // COMMITTED operation to its caller as unconfirmed and discards the authority
  // identity row that keeps a lost data.sqlite from being read as a new store.
  async _releaseLock(lock) {
    const deadline = performance.now() + this.lockTimeoutMs;
    for (;;) {
      try { lock.exec('COMMIT'); return; }
      catch (error) {
        if (!isBusy(error) || performance.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(LOCK_RETRY_MS, Math.max(1, deadline - performance.now()))));
      }
    }
  }

  _transaction(db, callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  _event(db, kind, payload) {
    const result = db.prepare('INSERT INTO events(schema_version,kind,at_ms,payload_json) VALUES(?,?,?,?)')
      .run(SCHEMA_VERSION, kind, this._time(), json(payload));
    return Number(result.lastInsertRowid);
  }

  _scope(db, binding, { permitClosed = false } = {}) {
    const existing = db.prepare('SELECT * FROM scopes WHERE scope_id=?').get(binding.runtimeScopeId);
    if (existing) {
      if (existing.binding_json !== json(binding)) refuse('BYTE_SCOPE_MISMATCH', 'This runtime scope is bound to a different identity.');
      if (existing.closed && !permitClosed) refuse('BYTE_SCOPE_CLOSED', 'This runtime scope has closed; a new host-issued scope and fresh read are required.');
      return;
    }
    this._transaction(db, () => {
      db.prepare('INSERT INTO scopes(scope_id,binding_json) VALUES(?,?)').run(binding.runtimeScopeId, json(binding));
      this._event(db, 'scope.opened', { binding });
    });
  }

  async _snapshot(resource, materialize = this.materialize) {
    const canonical = resourceKey(resource);
    const value = await this._call(materialize, canonical);
    if (value && value.present === false && (value.bytes === undefined || value.bytes === null)) {
      return { present: false, bytes: null };
    }
    if (!value || (value.present !== undefined && value.present !== true)
        || !Buffer.isBuffer(value.bytes) || value.bytes.length > this.maxResourceBytes) {
      refuse('BYTE_MATERIALIZATION_INVALID', 'The provider did not return a bounded Buffer of the current file.');
    }
    return { present: true, bytes: Buffer.from(value.bytes), identity: typeof value.identity === 'string' ? value.identity : null };
  }

  async _bytes(resource) {
    const snapshot = await this._snapshot(resource);
    if (!snapshot.present) refuse('BYTE_RESOURCE_ABSENT', 'The file is absent; no byte-read receipt was created.', { resource });
    return snapshot.bytes;
  }

  _resource(db, resource, { present, bytes }) {
    const digest = present ? hash(bytes) : null;
    const length = present ? bytes.length : 0;
    const existing = db.prepare('SELECT * FROM resources WHERE resource=?').get(resource);
    if (existing && existing.present === Number(present) && existing.sha256 === digest && existing.byte_length === length) return existing;
    if (!existing && (db.prepare('SELECT 1 FROM reads WHERE resource=? LIMIT 1').get(resource)
        || db.prepare('SELECT 1 FROM receipts WHERE resource=? LIMIT 1').get(resource))) {
      refuse('BYTE_STATE_CORRUPT', 'A previously observed resource lost its version record; its read set cannot be re-created as empty.', { resource });
    }
    const version = existing ? existing.version + 1 : 1;
    this._transaction(db, () => {
      db.prepare('INSERT INTO resources(resource,version,sha256,byte_length,present) VALUES(?,?,?,?,?) ON CONFLICT(resource) DO UPDATE SET version=excluded.version,sha256=excluded.sha256,byte_length=excluded.byte_length,present=excluded.present')
        .run(resource, version, digest, length, Number(present));
      if (existing) {
        // Unmediated edits provide no trustworthy coordinate transform.
        db.prepare("UPDATE reads SET stale_reason='UNMEDIATED_CHANGE' WHERE resource=?").run(resource);
        this._event(db, 'resource.unmediated-change', {
          resource, beforeSha256: existing.sha256, afterSha256: digest, resourceVersion: version,
          beforePresent: existing.present === 1, afterPresent: present
        });
      }
    });
    return { resource, version, sha256: digest, byte_length: length, present: Number(present) };
  }

  _insertRead(db, row) {
    db.prepare('INSERT INTO reads VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      row.id || token('read'), row.receipt_ref, row.scope_id, row.resource,
      row.start_byte, row.end_byte, row.observed, row.version, row.expires_ms,
      row.stale_reason == null ? null : row.stale_reason
    );
  }

  _replaceObserved(db, binding, resource, start, end, fullLength) {
    const prior = db.prepare('SELECT * FROM reads WHERE scope_id=? AND resource=?').all(binding.runtimeScopeId, resource);
    for (const row of prior) {
      if (['UNMEDIATED_CHANGE', 'WHOLE_FILE_WRITE'].includes(row.stale_reason) && !(start === 0 && end === fullLength)) continue;
      if (!(start === 0 && end === fullLength) && !intersects(row.start_byte, row.end_byte, start, end)
          && !covers(start, end, row.start_byte, row.end_byte)) continue;
      db.prepare('DELETE FROM reads WHERE id=?').run(row.id);
      if (start === 0 && end === fullLength) continue;
      const observed = Buffer.from(row.observed);
      if (row.start_byte < start) {
        this._insertRead(db, { ...row, id: token('read'), end_byte: start,
          observed: row.stale_reason ? observed : observed.subarray(0, start - row.start_byte) });
      }
      if (row.end_byte > end) {
        this._insertRead(db, { ...row, id: token('read'), start_byte: end,
          observed: row.stale_reason ? observed : observed.subarray(end - row.start_byte) });
      }
    }
  }

  _pending(db) {
    return db.prepare("SELECT * FROM operations WHERE status IN ('PREPARED','UNKNOWN')").all();
  }

  async _recoverRelevant(db, resource, binding) {
    // A resource-scoped authority never lets another file's unresolved
    // publication freeze this file's reads or writes.
    if (this.readSetScope === 'resource') return this._recoverPendingLocked(db, new Set([resource]));
    const relevant = new Set([resource]);
    for (const row of db.prepare('SELECT DISTINCT resource FROM reads WHERE scope_id=?').all(binding.runtimeScopeId)) relevant.add(row.resource);
    // Recovery uses the same lifetime transaction as admission. A failed
    // adapter must not permanently strand an ordinary retry, and an unresolved
    // publication on an unrelated resource must not freeze all file tools.
    return this._recoverPendingLocked(db, relevant);
  }

  async observeRead({ binding: rawBinding, resource: rawResource, startByte, endByte, materializeRead, validateRead, assertCurrent } = {}) {
    const binding = normalizeBinding(rawBinding);
    const resource = resourceKey(rawResource);
    if (validateRead !== undefined && typeof validateRead !== 'function') refuse('BYTE_ADAPTER_INVALID', 'validateRead must be an internal callback.');
    if (materializeRead !== undefined && typeof materializeRead !== 'function') refuse('BYTE_ADAPTER_INVALID', 'materializeRead must be an internal callback.');
    return this._locked(async db => {
      await this._assertCurrent(assertCurrent);
      this._scope(db, binding);
      await this._recoverRelevant(db, resource, binding);
      // A handle adapter may impose a stricter expected identity on this
      // observation. Recovery still uses the shared current-state adapter;
      // the requested descriptor read happens only after relevant recovery,
      // under this same lifetime transaction. This is not caller JSON.
      const snapshot = await this._snapshot(resource, materializeRead || this.materialize);
      if (!snapshot.present) refuse('BYTE_RESOURCE_ABSENT', 'The file is absent; no byte-read receipt was created.', { resource });
      const full = snapshot.bytes;
      const start = startByte === undefined ? 0 : startByte;
      const end = endByte === undefined ? full.length : endByte;
      checkedRange(start, end, full.length);
      const bytes = Buffer.from(full.subarray(start, end));
      if (validateRead) await this._call(validateRead, { bytes, startByte: start, endByte: end });
      this._assertCurrentNow(assertCurrent);
      const current = this._resource(db, resource, { present: true, bytes: full });
      const at = this._time();
      const other = db.prepare('SELECT 1 FROM reads WHERE resource=? AND scope_id<>? AND expires_ms>? LIMIT 1')
        .get(resource, binding.runtimeScopeId, at);
      const expires = at + (other ? CONTENDED_LEASE_MS : SOLO_LEASE_MS);
      const receipt = {
        schemaVersion: SCHEMA_VERSION, receiptRef: token('receipt'), op: 'read', binding, resource,
        startByte: start, endByte: end, bytes: bytes.length, totalBytes: full.length,
        contentSha256: hash(bytes), fileSha256: current.sha256, resourceVersion: current.version,
        createdAtMs: at, expiresAtMs: expires
      };
      this._transaction(db, () => {
        this._replaceObserved(db, binding, resource, start, end, full.length);
        if (other) db.prepare('UPDATE reads SET expires_ms=MIN(expires_ms,?) WHERE resource=?').run(at + CONTENDED_LEASE_MS, resource);
        receipt.sequence = this._event(db, 'read.observed', receipt);
        db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(receipt.receiptRef, binding.runtimeScopeId, resource, at, json(receipt));
        this._insertRead(db, { receipt_ref: receipt.receiptRef, scope_id: binding.runtimeScopeId, resource,
          start_byte: start, end_byte: end, observed: bytes, version: current.version, expires_ms: expires });
      });
      const invalidations = this.readSetScope === 'resource'
        ? db.prepare('SELECT resource,receipt_ref,stale_reason FROM reads WHERE scope_id=? AND resource=? AND stale_reason IS NOT NULL')
          .all(binding.runtimeScopeId, resource)
        : db.prepare('SELECT resource,receipt_ref,stale_reason FROM reads WHERE scope_id=? AND stale_reason IS NOT NULL')
          .all(binding.runtimeScopeId);
      this._assertCurrentNow(assertCurrent);
      return { bytes, receipt: Object.freeze(receipt), invalidations };
    });
  }

  async _validateReadSet(db, binding, snapshots, onlyResource = null) {
    // A resource-scoped authority validates only the target's observations:
    // another file this scope once read cannot block this write.
    const inScope = row => onlyResource === null || row.resource === onlyResource;
    const initial = db.prepare('SELECT DISTINCT resource FROM reads WHERE scope_id=?').all(binding.runtimeScopeId).filter(inScope);
    const unavailable = [];
    for (const row of initial) {
      let snapshot = snapshots.get(row.resource);
      if (!snapshot) {
        try { snapshot = await this._snapshot(row.resource); snapshots.set(row.resource, snapshot); }
        catch (error) {
          unavailable.push({ resource: row.resource, reason: 'DEPENDENCY_UNREADABLE', cause: error && error.code || 'READ_FAILED' });
          continue;
        }
      }
      this._resource(db, row.resource, snapshot);
      if (!snapshot.present) unavailable.push({ resource: row.resource, reason: 'DEPENDENCY_ABSENT',
        currentPresent: false, requiresWholeFileRead: true });
    }
    const stale = [...unavailable];
    const at = this._time();
    for (const row of db.prepare('SELECT * FROM reads WHERE scope_id=?').all(binding.runtimeScopeId).filter(inScope)) {
      const snapshot = snapshots.get(row.resource);
      if (!snapshot || !snapshot.present) continue;
      const bytes = snapshot.bytes;
      const actual = bytes.subarray(Math.min(row.start_byte, bytes.length), Math.min(row.end_byte, bytes.length));
      const reason = row.stale_reason || (row.expires_ms <= at ? 'OBSERVATION_EXPIRED'
        : row.end_byte > bytes.length || hash(actual) !== hash(Buffer.from(row.observed)) ? 'OBSERVED_BYTES_CHANGED' : null);
      if (reason) stale.push({
        resource: row.resource, receiptRef: row.receipt_ref, reason,
        startByte: row.start_byte, endByte: row.end_byte,
        expectedContentSha256: hash(Buffer.from(row.observed)), currentContentSha256: hash(actual),
        // Refusal metadata does not release freshly materialized file content:
        // receiving that content must go through observeRead and get a receipt.
        currentFileSha256: hash(bytes),
        requiresWholeFileRead: ['UNMEDIATED_CHANGE', 'WHOLE_FILE_WRITE'].includes(reason)
      });
    }
    if (stale.length) refuse('BYTE_READ_SET_STALE', 'Files read by this scope changed or their observations expired; read the indicated regions and reconcile the write. An absent dependency needs restoration and a real reread; absence is not an acknowledged byte read.', { repairs: stale });
  }

  _selectReceipt(db, binding, resource, receiptRef, start, end) {
    const candidates = receiptRef
      ? db.prepare('SELECT * FROM receipts WHERE ref=? AND scope_id=? AND resource=?').all(receiptRef, binding.runtimeScopeId, resource)
      : db.prepare('SELECT * FROM receipts WHERE scope_id=? AND resource=? ORDER BY created_ms DESC,rowid DESC').all(binding.runtimeScopeId, resource);
    for (const candidate of candidates) {
      const rows = db.prepare('SELECT * FROM reads WHERE receipt_ref=? AND scope_id=? AND resource=? ORDER BY start_byte')
        .all(candidate.ref, binding.runtimeScopeId, resource);
      if (start === undefined) return parse(candidate.receipt_json, 'receipt');
      let cursor = start;
      for (const row of rows) {
        if (row.stale_reason || row.expires_ms <= this._time()) continue;
        if (start === end && covers(row.start_byte, row.end_byte, start, end)) return parse(candidate.receipt_json, 'receipt');
        if (row.start_byte <= cursor && row.end_byte > cursor) cursor = row.end_byte;
        if (cursor >= end && end > start) return parse(candidate.receipt_json, 'receipt');
      }
    }
    refuse('BYTE_READ_REQUIRED', 'Read the bytes this patch changes through this runtime scope before patching them.', { resource, receiptRef: receiptRef || null });
  }

  _rebaseReads(db, operation) {
    const { resource, startByte: start, endByte: end, replacementBase64, binding } = operation;
    const replacement = Buffer.from(replacementBase64, 'base64');
    const delta = replacement.length - (end - start);
    const rows = db.prepare('SELECT * FROM reads WHERE resource=?').all(resource);
    const wholeFile = WHOLE_FILE_NAMES.has(path.basename(resource).toLowerCase());
    for (const row of rows) {
      const same = row.scope_id === binding.runtimeScopeId;
      const overlap = intersects(row.start_byte, row.end_byte, start, end)
        || (same && start === end && row.end_byte === start);
      if (wholeFile && !same) {
        db.prepare("UPDATE reads SET stale_reason='WHOLE_FILE_WRITE',version=? WHERE id=?").run(operation.afterVersion, row.id);
        continue;
      }
      if (!overlap) {
        const shift = row.start_byte >= end ? delta : 0;
        db.prepare('UPDATE reads SET start_byte=start_byte+?,end_byte=end_byte+?,version=? WHERE id=?')
          .run(shift, shift, operation.afterVersion, row.id);
        continue;
      }
      db.prepare('DELETE FROM reads WHERE id=?').run(row.id);
      const observed = Buffer.from(row.observed);
      const common = { ...row, id: undefined, version: operation.afterVersion };
      if (row.start_byte < start) {
        this._insertRead(db, { ...common, end_byte: start,
          observed: row.stale_reason ? observed : observed.subarray(0, start - row.start_byte) });
      }
      this._insertRead(db, { ...common, start_byte: start, end_byte: start + replacement.length,
        observed: same ? replacement : observed,
        stale_reason: same ? null : 'MEDIATED_WRITE' });
      if (row.end_byte > end) {
        this._insertRead(db, { ...common, start_byte: end + delta, end_byte: row.end_byte + delta,
          observed: row.stale_reason ? observed : observed.subarray(end - row.start_byte) });
      }
    }
  }

  _commitOperation(db, operation, { recovered = false, preparedSequence = null } = {}) {
    const op = operation.op || 'patch';
    const receipt = {
      schemaVersion: SCHEMA_VERSION, operationSchemaVersion: operation.schemaVersion,
      receiptRef: token('write'), op, operationId: operation.operationId,
      binding: operation.binding, resource: operation.resource,
      beforePresent: operation.beforePresent !== false, afterPresent: true,
      writeIntent: op === 'write' ? 'blind-whole-file' : null,
      startByte: operation.startByte, endByte: operation.endByte,
      replacedBytes: operation.endByte - operation.startByte,
      replacementBytes: Buffer.from(operation.replacementBase64, 'base64').length,
      preHash: operation.preHash, postHash: operation.postHash,
      beforeFileSha256: operation.beforeSha256, fileSha256: operation.afterSha256,
      resourceVersion: operation.afterVersion, bytes: operation.afterBytes,
      recovered, noOp: operation.noOp === true,
      outcome: operation.noOp ? (recovered ? 'recovered-no-op' : 'no-op')
        : recovered ? 'recovered-materialized' : 'committed'
    };
    this._transaction(db, () => {
      if (!operation.noOp) {
        if (op === 'write') {
          // Whole-file input is publication intent, not newly exposed content.
          // Do not manufacture/expand a receipt, even for the writer. Existing
          // observations need a real whole-file reread after replacement.
          db.prepare("UPDATE reads SET stale_reason='WHOLE_FILE_WRITE',version=? WHERE resource=?")
            .run(operation.afterVersion, operation.resource);
        } else this._rebaseReads(db, operation);
      }
      db.prepare('UPDATE resources SET version=?,sha256=?,byte_length=?,present=1 WHERE resource=?')
        .run(operation.afterVersion, operation.afterSha256, operation.afterBytes, operation.resource);
      receipt.sequence = this._event(db, op + (recovered ? '.recovered' : '.committed'), receipt);
      db.prepare("UPDATE operations SET status='COMMITTED',receipt_json=? WHERE id=?").run(json(receipt), operation.operationId);
      if (this.pruneCommittedPayloads) this._prunePayload(db, operation, op, preparedSequence);
    });
    return receipt;
  }

  // Retention bound for committed operations. Recovery reads only PREPARED and
  // UNKNOWN rows, so once COMMITTED is durable in this same transaction the
  // replacement bytes serve no recovery purpose. Hashes, sizes, ranges, the
  // original integrity checksum and the receipt remain; only the payload goes.
  _prunePayload(db, operation, op, preparedSequence) {
    const replacementBytes = Buffer.from(operation.replacementBase64, 'base64').length;
    const pruned = json({ ...operation, replacementBase64: null,
      payloadPruned: { replacementBytes, postHash: operation.postHash } });
    db.prepare('UPDATE operations SET operation_json=? WHERE id=?').run(pruned, operation.operationId);
    const sequence = preparedSequence !== null ? preparedSequence
      : db.prepare("SELECT sequence FROM events WHERE kind=? AND json_extract(payload_json,'$.operationId')=?")
        .get(op + '.prepared', operation.operationId)?.sequence;
    if (sequence !== undefined && sequence !== null) {
      db.prepare('UPDATE events SET payload_json=? WHERE sequence=? AND kind=?').run(pruned, sequence, op + '.prepared');
    }
  }

  // AN EXPOSURE IS PROVENANCE, NOT A READ.
  //
  // search.query returns snippets and code.* returns source previews: file
  // bytes are put in front of an agent that never asked to read that file.
  // Recording them is worth doing -- it is the only record that this content
  // was shown -- but a glance must not behave like a deliberate read.
  //
  // SO THIS WRITES A RECEIPT AND NO `reads` ROW, and that single omission is
  // the whole policy, because of two things the authority already does:
  //   _validateReadSet refuses a write whose scope holds a stale `reads` row,
  //     so an exposure can never gate a later write; and
  //   _selectReceipt will only patch from a receipt that HAS `reads` rows
  //     covering the patched window, so an exposure receipt is refused
  //     BYTE_READ_REQUIRED and a snippet is never an entitlement to edit.
  // Neither of those needed changing. Read-before-write stays anchored to the
  // deliberate read tools alone, which is the point.
  //
  // It takes no lease and never shortens anyone else's: a glance is not
  // contention, and letting one clip a real reader's lease would make an
  // incidental snippet slow somebody else's work down.
  async recordExposure({ binding: rawBinding, resource: rawResource, startByte, endByte, tool, materializeRead, assertCurrent } = {}) {
    const binding = normalizeBinding(rawBinding);
    const resource = resourceKey(rawResource);
    // The tool name is required: a record of exposure that cannot say what did
    // the exposing is not provenance, it is only a timestamp.
    if (typeof tool !== 'string' || !tool || tool.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(tool)) {
      refuse('BYTE_EXPOSURE_TOOL_INVALID', 'An exposure receipt must name the tool that showed the bytes.');
    }
    if (materializeRead !== undefined && typeof materializeRead !== 'function') refuse('BYTE_ADAPTER_INVALID', 'materializeRead must be an internal callback.');
    return this._locked(async db => {
      await this._assertCurrent(assertCurrent);
      this._scope(db, binding);
      const snapshot = await this._snapshot(resource, materializeRead || this.materialize);
      if (!snapshot.present) refuse('BYTE_RESOURCE_ABSENT', 'The file is absent; no byte-exposure receipt was created.', { resource });
      const full = snapshot.bytes;
      const start = startByte === undefined ? 0 : startByte;
      const end = endByte === undefined ? full.length : endByte;
      checkedRange(start, end, full.length);
      const bytes = Buffer.from(full.subarray(start, end));
      this._assertCurrentNow(assertCurrent);
      const current = this._resource(db, resource, { present: true, bytes: full });
      const at = this._time();
      const receipt = {
        schemaVersion: SCHEMA_VERSION, receiptRef: token('receipt'), op: 'expose', tool, binding, resource,
        startByte: start, endByte: end, bytes: bytes.length, totalBytes: full.length,
        contentSha256: hash(bytes), fileSha256: current.sha256, resourceVersion: current.version,
        createdAtMs: at
      };
      this._transaction(db, () => {
        receipt.sequence = this._event(db, 'bytes.exposed', receipt);
        db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(receipt.receiptRef, binding.runtimeScopeId, resource, at, json(receipt));
      });
      return { bytes, receipt: Object.freeze(receipt) };
    });
  }

  async applyPatch({ binding: rawBinding, resource: rawResource, receiptRef, derivePatch, assertCurrent } = {}) {
    const binding = normalizeBinding(rawBinding);
    const resource = resourceKey(rawResource);
    if (typeof derivePatch !== 'function' || (receiptRef !== undefined && typeof receiptRef !== 'string')) {
      refuse('BYTE_ADAPTER_INVALID', 'A private patch derivation callback is required.');
    }
    return this._locked(async db => {
      await this._assertCurrent(assertCurrent);
      this._scope(db, binding);
      await this._recoverRelevant(db, resource, binding);
      const before = await this._bytes(resource);
      const snapshot = { present: true, bytes: before };
      this._resource(db, resource, snapshot);
      await this._validateReadSet(db, binding, new Map([[resource, snapshot]]), this.readSetScope === 'resource' ? resource : null);
      const latest = this._selectReceipt(db, binding, resource, receiptRef);
      const patch = await this._call(derivePatch, { bytes: Buffer.from(before), currentReceipt: latest });
      if (!patch || !Buffer.isBuffer(patch.replacement)) refuse('BYTE_PATCH_INVALID', 'The patch adapter must return a byte replacement.');
      checkedRange(patch.startByte, patch.endByte, before.length);
      this._selectReceipt(db, binding, resource, receiptRef, patch.startByte, patch.endByte);
      const replacement = Buffer.from(patch.replacement);
      const after = Buffer.concat([before.subarray(0, patch.startByte), replacement, before.subarray(patch.endByte)]);
      if (after.length > this.maxResourceBytes) refuse('BYTE_PATCH_INVALID', 'The resulting file exceeds the repository file bound.');
      const current = db.prepare('SELECT * FROM resources WHERE resource=?').get(resource);
      const noOp = before.equals(after);
      const operation = {
        schemaVersion: SCHEMA_VERSION, operationId: token('operation'), binding, resource,
        op: 'patch', writeIntent: null, publicationPath: assertAccountProfilePath(rawResource, { field: 'byte publication path' }),
        beforePresent: true, afterPresent: true, publicationMode: 'replace-existing', createPreparation: null,
        receiptRef: latest.receiptRef, beforeVersion: current.version, afterVersion: current.version + (noOp ? 0 : 1), noOp,
        startByte: patch.startByte, endByte: patch.endByte, replacementBase64: replacement.toString('base64'),
        beforeSha256: hash(before), afterSha256: hash(after), beforeBytes: before.length, afterBytes: after.length,
        preHash: hash(before.subarray(patch.startByte, patch.endByte)), postHash: hash(replacement), createdAtMs: this._time()
      };
      const receipt = await this._publishOperation(db, operation, before, after, assertCurrent);
      return { receipt, startByte: receipt.startByte, endByte: receipt.endByte,
        replacedBytes: receipt.replacedBytes, replacementBytes: receipt.replacementBytes,
        preHash: receipt.preHash, postHash: receipt.postHash, bytes: receipt.bytes };
    });
  }

  async applyWrite({ binding: rawBinding, resource: rawResource, bytes, assertCurrent } = {}) {
    const binding = normalizeBinding(rawBinding);
    const resource = resourceKey(rawResource);
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maxResourceBytes) {
      refuse('BYTE_WRITE_INVALID', 'A whole-file write requires a bounded Buffer.');
    }
    // Capture caller-supplied intent before waiting for cross-process authority.
    // These bytes are never recorded as content observed through a read tool.
    const after = Buffer.from(bytes);
    return this._locked(async db => {
      await this._assertCurrent(assertCurrent);
      this._scope(db, binding);
      await this._recoverRelevant(db, resource, binding);
      const before = await this._snapshot(resource);
      const current = this._resource(db, resource, before);
      await this._validateReadSet(db, binding, new Map([[resource, before]]), this.readSetScope === 'resource' ? resource : null);
      if (this.writeRequiresObservation && before.present) this._assertWholeObservation(db, binding, resource, before.bytes.length);
      const noOp = before.present && before.bytes.equals(after);
      const operation = {
        schemaVersion: SCHEMA_VERSION, operationId: token('operation'), binding, resource,
        op: 'write', writeIntent: 'blind-whole-file', publicationPath: assertAccountProfilePath(rawResource, { field: 'byte publication path' }),
        beforePresent: before.present, afterPresent: true,
        publicationMode: before.present ? 'replace-existing' : 'create-only', createPreparation: null,
        receiptRef: null, beforeVersion: current.version, afterVersion: current.version + (noOp ? 0 : 1), noOp,
        startByte: 0, endByte: before.present ? before.bytes.length : 0, replacementBase64: after.toString('base64'),
        beforeSha256: before.present ? hash(before.bytes) : null, afterSha256: hash(after),
        beforeBytes: before.present ? before.bytes.length : 0, afterBytes: after.length,
        preHash: before.present ? hash(before.bytes) : null, postHash: hash(after), createdAtMs: this._time()
      };
      if (!before.present) {
        if (typeof this.prepareCreate !== 'function' || typeof this.reconcileCreateStage !== 'function') {
          refuse('BYTE_CREATE_ADAPTER_REQUIRED', 'Creation requires a durable staged identity and an atomic no-replace publication adapter.');
        }
        const preparation = await this._call(this.prepareCreate, {
          resource, publicationPath: operation.publicationPath, operationId: operation.operationId,
          stagingPath: this._stagingPath(operation), after: Buffer.from(after), afterSha256: operation.afterSha256,
          assertCurrent: () => this._assertCurrentNow(assertCurrent)
        });
        this._validateCreatePreparation(operation, preparation);
        operation.createPreparation = { ...preparation };
      }
      const receipt = await this._publishOperation(db, operation, before.bytes, after, assertCurrent);
      const observation = this.observeOwnWrites ? this._observePublished(db, operation, after) : null;
      return { receipt, bytes: receipt.bytes, created: !before.present, ...(observation ? { observation } : {}) };
    });
  }

  // Replacing an existing file must not overwrite bytes this scope never saw.
  // _validateReadSet has already refused any stale, expired or changed row, so
  // every remaining row is current; together they must cover the whole file.
  _assertWholeObservation(db, binding, resource, length) {
    const rows = db.prepare('SELECT start_byte,end_byte,stale_reason,expires_ms FROM reads WHERE scope_id=? AND resource=? ORDER BY start_byte,end_byte')
      .all(binding.runtimeScopeId, resource);
    const at = this._time();
    let cursor = 0;
    let covered = false;
    for (const row of rows) {
      if (row.stale_reason || row.expires_ms <= at) continue;
      if (length === 0) { if (row.start_byte === 0) { covered = true; break; } continue; }
      if (row.start_byte <= cursor && row.end_byte > cursor) cursor = row.end_byte;
      if (cursor >= length) { covered = true; break; }
    }
    if (!covered) {
      refuse('BYTE_READ_REQUIRED', 'Read the whole current file through this runtime scope before replacing it; a whole-file write must not replace bytes this scope has not observed.', {
        resource, currentBytes: length, observedThroughByte: cursor, requiresWholeFileRead: true
      });
    }
  }

  // Under the same lifetime transaction that just confirmed the published
  // bytes (hash, length and, for creation, identity), the writer's knowledge
  // of the file is exact. Record it as a current whole-file observation so a
  // follow-up edit by the same scope needs no reread. Any later change by
  // anyone else invalidates it through the ordinary rules. Never used for
  // recovered operations: their original caller may not have seen success.
  _observePublished(db, operation, after) {
    const { binding, resource } = operation;
    const at = this._time();
    const other = db.prepare('SELECT 1 FROM reads WHERE resource=? AND scope_id<>? AND expires_ms>? LIMIT 1')
      .get(resource, binding.runtimeScopeId, at);
    const expires = at + (other ? CONTENDED_LEASE_MS : SOLO_LEASE_MS);
    const receipt = {
      schemaVersion: SCHEMA_VERSION, receiptRef: token('receipt'), op: 'read', source: 'own-publication',
      operationId: operation.operationId, binding, resource,
      startByte: 0, endByte: after.length, bytes: after.length, totalBytes: after.length,
      contentSha256: operation.afterSha256, fileSha256: operation.afterSha256, resourceVersion: operation.afterVersion,
      createdAtMs: at, expiresAtMs: expires
    };
    this._transaction(db, () => {
      db.prepare('DELETE FROM reads WHERE scope_id=? AND resource=?').run(binding.runtimeScopeId, resource);
      if (other) db.prepare('UPDATE reads SET expires_ms=MIN(expires_ms,?) WHERE resource=?').run(at + CONTENDED_LEASE_MS, resource);
      receipt.sequence = this._event(db, 'read.own-publication', receipt);
      db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(receipt.receiptRef, binding.runtimeScopeId, resource, at, json(receipt));
      this._insertRead(db, { receipt_ref: receipt.receiptRef, scope_id: binding.runtimeScopeId, resource,
        start_byte: 0, end_byte: after.length, observed: Buffer.from(after), version: operation.afterVersion, expires_ms: expires });
    });
    return Object.freeze(receipt);
  }

  // A read that finds the file absent observes that absence. It releases no
  // content and creates no receipt, but it retires this scope's own stale
  // observations of the vanished file, so the scope may create it again
  // (create-only, never replacing a file another writer made first).
  async observeAbsence({ binding: rawBinding, resource: rawResource, assertCurrent } = {}) {
    const binding = normalizeBinding(rawBinding);
    const resource = resourceKey(rawResource);
    return this._locked(async db => {
      await this._assertCurrent(assertCurrent);
      this._scope(db, binding);
      await this._recoverRelevant(db, resource, binding);
      const snapshot = await this._snapshot(resource);
      if (snapshot.present) return { absent: false, retiredObservations: 0 };
      if (db.prepare('SELECT 1 FROM resources WHERE resource=?').get(resource)) this._resource(db, resource, snapshot);
      const retired = this._transaction(db, () => {
        const count = Number(db.prepare('DELETE FROM reads WHERE scope_id=? AND resource=?').run(binding.runtimeScopeId, resource).changes);
        if (count) this._event(db, 'read.absence-observed', { binding, resource, retiredObservations: count });
        return count;
      });
      this._assertCurrentNow(assertCurrent);
      return { absent: true, retiredObservations: retired };
    });
  }

  _stagingPath(operation) {
    return path.join(path.dirname(operation.publicationPath), '.te-' + operation.operationId + '.create.tmp');
  }

  _validateCreatePreparation(operation, preparation) {
    const keys = ['stagingPath', 'device', 'inode', 'sha256', 'bytes'];
    // Validate the closed shape and derived sibling spelling before an adapter
    // can touch any persisted path. No journal field may name an arbitrary
    // cleanup target; actual identity/link-count/digest checks remain mandatory
    // inside the provider's private creation/recovery adapter.
    const expected = this._stagingPath(operation);
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!preparation || typeof preparation !== 'object' || Array.isArray(preparation)
        || Object.keys(preparation).length !== keys.length || !keys.every(field => Object.hasOwn(preparation, field))
        || typeof preparation.stagingPath !== 'string' || key(preparation.stagingPath) !== key(expected)
        || typeof preparation.device !== 'string' || !DEVICE_ID.test(preparation.device)
        || typeof preparation.inode !== 'string' || !INODE_ID.test(preparation.inode)
        || preparation.sha256 !== operation.afterSha256 || preparation.bytes !== operation.afterBytes) {
      refuse('BYTE_CREATE_PREPARATION_INVALID', 'Creation did not establish the exact operation-owned staged identity.', { operationId: operation.operationId });
    }
  }

  async _publishOperation(db, operation, before, after, assertCurrent) {
    operation.operationSha256 = hash(Buffer.from(json(operation)));
    await this._assertCurrent(assertCurrent);
    let preparedSequence = null;
    this._transaction(db, () => {
      db.prepare('INSERT INTO operations VALUES(?,?,?,NULL)').run(operation.operationId, 'PREPARED', json(operation));
      preparedSequence = this._event(db, operation.op + '.prepared', operation);
    });
    try {
      const assertPublicationCurrent = () => this._assertCurrentNow(assertCurrent);
      assertPublicationCurrent();
      const result = operation.noOp ? { published: true } : await this.publish({
        resource: operation.resource, publicationPath: operation.publicationPath, operationId: operation.operationId,
        op: operation.op, publicationMode: operation.publicationMode, beforePresent: operation.beforePresent,
        createPreparation: operation.createPreparation ? { ...operation.createPreparation } : null,
        before: before === null ? null : Buffer.from(before), after: Buffer.from(after),
        beforeSha256: operation.beforeSha256, afterSha256: operation.afterSha256,
        assertCurrent: assertPublicationCurrent
      });
      if (!result || result.published !== true
          || (!operation.beforePresent && result.publicationMode !== 'create-only')) {
        refuse('BYTE_PUBLICATION_UNCONFIRMED', 'The provider did not confirm the required publication mode; recovery must inspect the prepared operation.', { operationId: operation.operationId });
      }
      const actual = await this._snapshot(operation.resource);
      if (!actual.present || hash(actual.bytes) !== operation.afterSha256 || actual.bytes.length !== operation.afterBytes
          || (!operation.beforePresent && actual.identity !== this._creationIdentity(operation))) {
        refuse('BYTE_PUBLICATION_UNCONFIRMED', 'The published bytes could not be confirmed; the prepared operation remains unresolved.', { operationId: operation.operationId });
      }
      const receipt = this._commitOperation(db, operation, { preparedSequence });
      try { this._assertCurrentNow(assertCurrent); }
      catch (error) {
        refuse('BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED', 'The write committed before this scope closed; no further content is released. Do not assume the write was refused.', {
          publicationCommitted: true, operationId: operation.operationId, resource: operation.resource,
          noOp: operation.noOp, causeCode: typeof error.code === 'string' ? error.code : null
        }, error);
      }
      return receipt;
    } catch (error) {
      if (error && error.publicationNotApplied === true && !operation.beforePresent
          && !(error instanceof ByteCoordinationRefusal)) await this._abortUnappliedCreate(db, operation, error);
      if (error instanceof ByteCoordinationRefusal || (error && this.callbackErrors.has(error))) throw error;
      refuse('BYTE_PUBLICATION_UNCONFIRMED', 'File publication did not finish with a committed receipt; inspect recovery before retrying.', { operationId: operation.operationId }, error);
    }
  }

  // A create-only adapter reports that its atomic no-replace publication was
  // refused because another writer created the target first. Trust nothing but
  // the filesystem: under this same lock the target must exist with an identity
  // that is not this operation's stage, and the operation-owned stage must be
  // gone. Only then is the PREPARED operation provably unapplied and ABORTED;
  // otherwise it stays PREPARED for ordinary recovery.
  async _abortUnappliedCreate(db, operation, cause) {
    let snapshot = null;
    try { snapshot = await this._snapshot(operation.resource); } catch { snapshot = null; }
    const stage = operation.createPreparation && operation.createPreparation.stagingPath;
    let stageGone = false;
    try { fs.lstatSync(stage); } catch (error) { stageGone = error.code === 'ENOENT'; }
    if (!snapshot || !snapshot.present || snapshot.identity === this._creationIdentity(operation) || !stageGone) return;
    this._transaction(db, () => {
      db.prepare("UPDATE operations SET status='ABORTED' WHERE id=?").run(operation.operationId);
      this._event(db, operation.op + '.create-conflict', { operationId: operation.operationId, resource: operation.resource,
        observedSha256: hash(snapshot.bytes), observedPresent: true });
    });
    refuse('BYTE_CREATE_CONFLICT', 'Another writer created this file first; nothing was published.', {
      operationId: operation.operationId, resource: operation.resource
    }, cause);
  }

  async recoverPending({ resources } = {}) {
    if (resources !== undefined && (!Array.isArray(resources) || resources.some(value => typeof value !== 'string'))) {
      refuse('BYTE_RESOURCE_INVALID', 'Recovery resources must be an explicit array of canonical resource paths.');
    }
    const selected = resources === undefined ? null : new Set(resources.map(resourceKey));
    return this._locked(db => this._recoverPendingLocked(db, selected));
  }

  async _recoverPendingLocked(db, selected) {
    const recovered = [];
    for (const row of this._pending(db)) {
      const stored = parse(row.operation_json, 'prepared operation');
      if (selected && stored && !selected.has(stored.resource)) continue;
      const operation = this._validateOperation(db, row, stored);
      let snapshot;
      try {
        if (!operation.beforePresent) {
          if (typeof this.reconcileCreateStage !== 'function') {
            refuse('BYTE_CREATE_ADAPTER_REQUIRED', 'Creation recovery requires the private staged-identity adapter.');
          }
          const result = await this._call(this.reconcileCreateStage, {
            resource: operation.resource, publicationPath: operation.publicationPath, operationId: operation.operationId,
            createPreparation: { ...operation.createPreparation }, afterSha256: operation.afterSha256, afterBytes: operation.afterBytes
          });
          if (!result || result.reconciled !== true) {
            refuse('BYTE_CREATE_RECONCILIATION_UNCONFIRMED', 'The operation-owned create stage could not be reconciled.');
          }
        }
        snapshot = await this._snapshot(operation.resource);
      } catch (error) {
        this._recoveryUnknown(db, operation, { causeCode: error && error.code || 'MATERIALIZATION_FAILED' }, error);
      }
      const digest = snapshot.present ? hash(snapshot.bytes) : null;
      const length = snapshot.present ? snapshot.bytes.length : 0;
      if (!operation.beforePresent && snapshot.present && snapshot.identity !== this._creationIdentity(operation)) {
        this._recoveryUnknown(db, operation, { causeCode: 'BYTE_CREATE_IDENTITY_CHANGED',
          observedSha256: digest, observedPresent: true });
      }
      const matchesBefore = snapshot.present === operation.beforePresent
        && digest === operation.beforeSha256 && length === operation.beforeBytes;
      const matchesAfter = snapshot.present && digest === operation.afterSha256 && length === operation.afterBytes;
      if (operation.noOp && matchesBefore) {
        const receipt = this._commitOperation(db, operation, { recovered: true });
        recovered.push({ operationId: row.id, outcome: 'recovered-no-op', receipt });
      } else if (matchesBefore) {
        this._transaction(db, () => {
          db.prepare("UPDATE operations SET status='ABORTED' WHERE id=?").run(row.id);
          this._event(db, operation.op + '.recovered-unapplied', { operationId: row.id, observedSha256: digest, observedPresent: snapshot.present });
        });
        recovered.push({ operationId: row.id, outcome: 'unapplied', receipt: null });
      } else if (matchesAfter) {
        // Recovery attests observed materialization, not that the original
        // caller saw success or that an arbitrary external actor did nothing.
        const receipt = this._commitOperation(db, operation, { recovered: true });
        recovered.push({ operationId: row.id, outcome: 'recovered-materialized', receipt });
      } else {
        this._recoveryUnknown(db, operation, { observedSha256: digest, observedPresent: snapshot.present });
      }
    }
    return { recovered };
  }

  _creationIdentity(operation) {
    return operation.createPreparation.device + ':' + operation.createPreparation.inode;
  }

  _recoveryUnknown(db, operation, observation, cause) {
    this._transaction(db, () => {
      db.prepare("UPDATE operations SET status='UNKNOWN' WHERE id=?").run(operation.operationId);
      this._event(db, operation.op + '.recovery-unresolved', { operationId: operation.operationId, ...observation });
    });
    refuse('BYTE_RECOVERY_UNRESOLVED', 'The recorded publication state cannot be proved; preserve the target and its staged evidence and resolve this operation explicitly.', {
      operationId: operation.operationId, resource: operation.resource, beforeSha256: operation.beforeSha256,
      afterSha256: operation.afterSha256, beforePresent: operation.beforePresent, ...observation
    }, cause);
  }

  _validateOperation(db, row, operation) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      refuse('BYTE_STATE_CORRUPT', 'A pending publication record is not an operation.');
    }
    const { operationSha256, ...unsigned } = operation;
    const replacement = typeof operation.replacementBase64 === 'string'
      ? Buffer.from(operation.replacementBase64, 'base64') : null;
    const legacy = operation.schemaVersion === 1;
    const beforePresent = legacy ? true : operation.beforePresent;
    const invalid = operation.operationId !== row.id || !OPERATION_ID.test(operation.operationId)
      || ![1, SCHEMA_VERSION].includes(operation.schemaVersion)
      || !SHA256.test(operationSha256) || operationSha256 !== hash(Buffer.from(json(unsigned)))
      || (beforePresent ? !SHA256.test(operation.beforeSha256) || !SHA256.test(operation.preHash)
        : operation.beforeSha256 !== null || operation.preHash !== null)
      || !SHA256.test(operation.afterSha256) || !SHA256.test(operation.postHash)
      || !Number.isSafeInteger(operation.beforeBytes) || operation.beforeBytes < 0 || operation.beforeBytes > this.maxResourceBytes
      || !Number.isSafeInteger(operation.afterBytes) || operation.afterBytes < 0 || operation.afterBytes > this.maxResourceBytes
      || !Number.isSafeInteger(operation.beforeVersion) || operation.beforeVersion < 1
      || operation.afterVersion !== operation.beforeVersion + (operation.noOp ? 0 : 1)
      || typeof operation.noOp !== 'boolean' || typeof operation.resource !== 'string'
      || !replacement || replacement.toString('base64') !== operation.replacementBase64
      || hash(replacement) !== operation.postHash
      || !Number.isSafeInteger(operation.startByte) || !Number.isSafeInteger(operation.endByte)
      || operation.startByte < 0 || operation.endByte < operation.startByte || operation.endByte > operation.beforeBytes
      || operation.afterBytes !== operation.beforeBytes + replacement.length - (operation.endByte - operation.startByte);
    if (invalid) refuse('BYTE_STATE_CORRUPT', 'A pending publication record has invalid fields or an invalid integrity checksum.');
    if (!legacy) {
      const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
      if (!['patch', 'write'].includes(operation.op) || typeof beforePresent !== 'boolean' || operation.afterPresent !== true
          || typeof operation.publicationPath !== 'string' || key(operation.publicationPath) !== operation.resource
          || operation.publicationMode !== (beforePresent ? 'replace-existing' : 'create-only')
          || operation.noOp !== (beforePresent && operation.beforeSha256 === operation.afterSha256 && operation.beforeBytes === operation.afterBytes)
          || (operation.op === 'write' && (operation.writeIntent !== 'blind-whole-file' || operation.receiptRef !== null
            || operation.startByte !== 0 || operation.endByte !== operation.beforeBytes
            || operation.preHash !== operation.beforeSha256 || operation.afterSha256 !== operation.postHash))
          || (operation.op === 'patch' && (operation.writeIntent !== null || !beforePresent || typeof operation.receiptRef !== 'string'))
          || (!beforePresent && (operation.op !== 'write' || operation.beforeBytes !== 0))
          || (beforePresent && operation.createPreparation !== null)) {
        refuse('BYTE_STATE_CORRUPT', 'A v2 pending publication has inconsistent presence, operation, or publication-mode fields.');
      }
      if (!beforePresent) {
        try { this._validateCreatePreparation(operation, operation.createPreparation); }
        catch (error) { refuse('BYTE_STATE_CORRUPT', 'A pending creation has an invalid staged identity or cleanup path.', {}, error); }
      }
    }
    const binding = normalizeBinding(operation.binding);
    const scope = db.prepare('SELECT * FROM scopes WHERE scope_id=?').get(binding.runtimeScopeId);
    const resource = db.prepare('SELECT * FROM resources WHERE resource=?').get(operation.resource);
    if (!scope || scope.binding_json !== json(binding) || !resource
        || resource.version !== operation.beforeVersion || resource.sha256 !== operation.beforeSha256
        || resource.byte_length !== operation.beforeBytes || resource.present !== Number(beforePresent)
        || resourceKey(operation.resource) !== operation.resource) {
      refuse('BYTE_STATE_CORRUPT', 'The pending publication no longer matches its recorded scope and base resource.');
    }
    return legacy ? { ...operation, op: 'patch', beforePresent: true, afterPresent: true,
      publicationMode: 'replace-existing', publicationPath: operation.resource, createPreparation: null, writeIntent: null } : operation;
  }

  async closeLaunch({ binding: rawBinding, reason } = {}) {
    const binding = normalizeBinding(rawBinding);
    if (typeof reason !== 'string' || !reason.trim()) refuse('BYTE_BINDING_INVALID', 'Scope closure requires a reason.');
    return this._locked(async db => {
      this._scope(db, binding, { permitClosed: true });
      return this._transaction(db, () => {
        const existing = db.prepare('SELECT closed FROM scopes WHERE scope_id=?').get(binding.runtimeScopeId);
        if (existing.closed) return { closed: false, runtimeScopeId: binding.runtimeScopeId };
        db.prepare('UPDATE scopes SET closed=1 WHERE scope_id=?').run(binding.runtimeScopeId);
        db.prepare('DELETE FROM reads WHERE scope_id=?').run(binding.runtimeScopeId);
        this._event(db, 'scope.closed', { binding, reason });
        return { closed: true, runtimeScopeId: binding.runtimeScopeId };
      });
    });
  }
}

function createByteAuthority(options) { return new ByteAuthority(options); }
module.exports = Object.freeze({
  ByteCoordinationRefusal, createByteAuthority, normalizeBinding, intersects,
  MAX_RESOURCE_BYTES, LOCK_TIMEOUT_MS, LOCK_RETRY_MS, SOLO_LEASE_MS,
  CONTENDED_LEASE_MS, SCHEMA_VERSION
});

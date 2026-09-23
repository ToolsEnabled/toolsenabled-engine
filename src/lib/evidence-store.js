'use strict';

// P10 is an additive, default-off service. Nothing in the provider registry,
// MCP surface, or worker runtime constructs this store yet.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, rootPath } = require('./runtime');
const identity = require('../../schemas/generated/platform.identity');
const provenance = require('../../schemas/generated/platform.provenance');
const redaction = require('../../schemas/generated/platform.redaction');
const POLICY = require('../../schemas/platform/evidence-store-policy.json');

function loadDatabaseSync() {
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...args) {
    const message = warning instanceof Error ? warning.message : String(warning);
    const type = warning instanceof Error ? warning.name : args[0];
    if (type === 'ExperimentalWarning' && message === 'SQLite is an experimental feature and might change at any time') return;
    return Reflect.apply(original, this, [warning, ...args]);
  };
  try {
    return require('node:sqlite').DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
}

const DatabaseSync = loadDatabaseSync();

// Node 22's experimental DatabaseSync surface does not expose the later
// isOpen/isTransaction accessors. These stores own their handles and track
// transaction scope, so preserve the accessors when available without
// reopening a retained connection or skipping required rollbacks.
function databaseIsOpen(database) {
  if (!database) return false;
  if (typeof database.isOpen === 'boolean') return database.isOpen;
  return true;
}

function databaseIsTransaction(database) {
  if (!database) return false;
  return typeof database.isTransaction === 'boolean' && database.isTransaction;
}

const SCHEMA_VERSION = POLICY.database.schemaVersion;
const APPLICATION_ID = POLICY.database.applicationId;
const DEFAULT_ROOT = rootPath('state', 'evidence');
const DEFAULT_DB_FILE = path.join(DEFAULT_ROOT, 'evidence.sqlite3');
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const SOURCE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/;
const CONTROL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REASON_CODES = new Set(POLICY.retention.deletion.reasonCodes);
const RECORD_KINDS = new Set(POLICY.recordKinds);
const PUBLIC_FORMATS = new Set(POLICY.contentFormats.public);
const PROTECTED_FORMATS = new Set(POLICY.contentFormats.protected);
const LOCATOR_KINDS = new Set(POLICY.locatorKinds);
const RETENTION_CLASSES = new Set(Object.keys(POLICY.retention.classes));
const READ_CHUNK_BYTES = 1024 * 1024;

const SCHEMA_V1 = `
  CREATE TABLE evidence_records (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE
      CHECK(length(evidence_id) = 35 AND substr(evidence_id, 1, 3) = 'ev_' AND substr(evidence_id, 4) NOT GLOB '*[^A-Za-z0-9_-]*'),
    task_id TEXT NOT NULL
      CHECK(length(task_id) = 36 AND substr(task_id, 1, 4) = 'tsk_' AND substr(task_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'),
    scope_id TEXT NOT NULL
      CHECK(length(scope_id) = 36 AND substr(scope_id, 1, 4) = 'ctx_' AND substr(scope_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'),
    tool_request_id TEXT NOT NULL
      CHECK(length(tool_request_id) = 36 AND substr(tool_request_id, 1, 4) = 'evt_' AND substr(tool_request_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'),
    kind TEXT NOT NULL CHECK(kind IN ('fact','calculation','tool-output','file','browser-trace','test-log','approval')),
    media_type TEXT NOT NULL CHECK(length(media_type) BETWEEN 3 AND 192),
    summary TEXT NOT NULL
      CHECK(length(summary) BETWEEN 1 AND ${POLICY.limits.summaryCharacters}),
    protected_sha256 TEXT NOT NULL
      CHECK(length(protected_sha256) = 64 AND protected_sha256 NOT GLOB '*[^0-9a-f]*'),
    protected_size_bytes INTEGER NOT NULL
      CHECK(protected_size_bytes BETWEEN 0 AND ${POLICY.limits.protectedObjectBytes}),
    protected_format TEXT NOT NULL CHECK(protected_format IN ('text','json','binary')),
    public_sha256 TEXT NOT NULL
      CHECK(length(public_sha256) = 64 AND public_sha256 NOT GLOB '*[^0-9a-f]*'),
    public_size_bytes INTEGER NOT NULL
      CHECK(public_size_bytes BETWEEN 0 AND ${POLICY.limits.publicObjectBytes}),
    public_format TEXT NOT NULL CHECK(public_format IN ('text','json')),
    provenance_json TEXT NOT NULL
      CHECK(json_valid(provenance_json) AND length(CAST(provenance_json AS BLOB)) BETWEEN 2 AND ${POLICY.limits.metadataJsonBytes}),
    source_version TEXT NOT NULL
      CHECK(length(source_version) BETWEEN 1 AND ${POLICY.limits.sourceVersionCharacters}),
    locator_json TEXT NOT NULL
      CHECK(json_valid(locator_json) AND length(CAST(locator_json AS BLOB)) BETWEEN 2 AND ${POLICY.limits.metadataJsonBytes}),
    redaction_report_json TEXT NOT NULL
      CHECK(json_valid(redaction_report_json) AND length(CAST(redaction_report_json AS BLOB)) BETWEEN 2 AND ${POLICY.limits.metadataJsonBytes}),
    retention_class TEXT NOT NULL CHECK(retention_class IN ('transient','standard','durable')),
    expires_at TEXT
      CHECK(expires_at IS NULL OR (length(expires_at) = 24 AND substr(expires_at, 24, 1) = 'Z')),
    created_at TEXT NOT NULL
      CHECK(length(created_at) = 24 AND substr(created_at, 24, 1) = 'Z'),
    record_hash TEXT NOT NULL UNIQUE
      CHECK(length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*')
  ) STRICT;

  CREATE INDEX evidence_records_task_scope_idx
    ON evidence_records(task_id, scope_id, sequence);
  CREATE INDEX evidence_records_protected_hash_idx
    ON evidence_records(protected_sha256);
  CREATE INDEX evidence_records_public_hash_idx
    ON evidence_records(public_sha256);
  CREATE INDEX evidence_records_expiry_idx
    ON evidence_records(expires_at, sequence) WHERE expires_at IS NOT NULL;

  CREATE TABLE evidence_tombstones (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    tombstone_id TEXT NOT NULL UNIQUE
      CHECK(length(tombstone_id) = 36 AND substr(tombstone_id, 1, 4) = 'evt_' AND substr(tombstone_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'),
    evidence_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL
      CHECK(length(task_id) = 36 AND substr(task_id, 1, 4) = 'tsk_' AND substr(task_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'),
    scope_id TEXT NOT NULL
      CHECK(length(scope_id) = 36 AND substr(scope_id, 1, 4) = 'ctx_' AND substr(scope_id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'),
    record_hash TEXT NOT NULL
      CHECK(length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
    protected_sha256 TEXT NOT NULL
      CHECK(length(protected_sha256) = 64 AND protected_sha256 NOT GLOB '*[^0-9a-f]*'),
    public_sha256 TEXT NOT NULL
      CHECK(length(public_sha256) = 64 AND public_sha256 NOT GLOB '*[^0-9a-f]*'),
    reason TEXT NOT NULL CHECK(reason IN ('retention','user-request','corrupt','superseded')),
    deleted_at TEXT NOT NULL
      CHECK(length(deleted_at) = 24 AND substr(deleted_at, 24, 1) = 'Z'),
    tombstone_hash TEXT NOT NULL UNIQUE
      CHECK(length(tombstone_hash) = 64 AND tombstone_hash NOT GLOB '*[^0-9a-f]*'),
    FOREIGN KEY(evidence_id) REFERENCES evidence_records(evidence_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX evidence_tombstones_deleted_idx
    ON evidence_tombstones(deleted_at, sequence);

  PRAGMA application_id = ${APPLICATION_ID};
  PRAGMA user_version = ${SCHEMA_VERSION};
`;

class EvidenceStoreError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'EvidenceStoreError';
    this.code = code;
    this.details = details;
  }
}

function evidenceError(code, message, details, cause) {
  return new EvidenceStoreError(code, message, details || {}, cause ? { cause } : {});
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw evidenceError('EVIDENCE_INVALID_ARGUMENT', `${label} must be a plain object.`, { field: label });
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw evidenceError('EVIDENCE_INVALID_ARGUMENT', `${label} has invalid fields.`, { field: label });
  }
  return value;
}

function assertSafeInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw evidenceError('EVIDENCE_INVALID_ARGUMENT', `${label} is outside its allowed integer range.`, { field: label });
  }
  return value;
}

function assertBoundedString(value, label, maximumCharacters, { nonempty = true, controls = false } = {}) {
  if (typeof value !== 'string' || (nonempty && value.length === 0) || [...value].length > maximumCharacters ||
      (!controls && /[\u0000-\u001f\u007f]/.test(value))) {
    throw evidenceError('EVIDENCE_INVALID_ARGUMENT', `${label} is invalid.`, { field: label });
  }
  return value;
}

function canonicalJson(value, label, maximumBytes = POLICY.limits.metadataJsonBytes) {
  let output;
  try {
    output = identity.canonicalString(value);
  } catch (error) {
    throw evidenceError('EVIDENCE_INVALID_ARGUMENT', `${label} must use the platform canonical JSON subset.`, { field: label }, error);
  }
  if (Buffer.byteLength(output, 'ascii') > maximumBytes) {
    throw evidenceError('EVIDENCE_INVALID_ARGUMENT', `${label} is too large.`, { field: label });
  }
  return output;
}

function rawSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function databaseFingerprint(db) {
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  return rawSha256(Buffer.from(JSON.stringify(rows.map(row => [
    row.type, row.name, row.tbl_name, String(row.sql).replace(/\s+/g, ' ').trim()
  ])), 'utf8'));
}

let expectedFingerprintValue;
function expectedFingerprint() {
  if (expectedFingerprintValue) return expectedFingerprintValue;
  const db = new DatabaseSync(':memory:', {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false
  });
  try {
    db.exec(SCHEMA_V1);
    expectedFingerprintValue = databaseFingerprint(db);
    return expectedFingerprintValue;
  } finally {
    db.close();
  }
}

function safeTimestamp(milliseconds, label = 'clock result') {
  assertSafeInteger(milliseconds, label);
  let value;
  try {
    value = new Date(milliseconds).toISOString();
    identity.parseControlTimestamp(value);
  } catch (error) {
    throw evidenceError('EVIDENCE_INVALID_ARGUMENT', `${label} is outside the supported UTC timestamp range.`, { field: label }, error);
  }
  return value;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function lstatOrNull(filename) {
  try {
    return fs.lstatSync(filename);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertSafeDirectory(directory, root) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw evidenceError('EVIDENCE_STORAGE_UNSAFE', 'Evidence storage contains an unsafe directory entry.');
  }
  const real = fs.realpathSync.native(directory);
  if (!isWithin(root, real)) throw evidenceError('EVIDENCE_STORAGE_UNSAFE', 'Evidence storage escaped its configured root.');
  return real;
}

function objectRelativePath(digest) {
  if (!HASH_PATTERN.test(digest || '')) throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'Content digest is invalid.', { field: 'sha256' });
  return path.join('objects', 'sha256', digest.slice(0, 2), digest.slice(2, 4), `${digest}.blob`);
}

function recordHashPayload(record) {
  const output = { ...record };
  delete output.recordHash;
  return output;
}

function tombstoneHashPayload(tombstone) {
  const output = { ...tombstone };
  delete output.tombstoneHash;
  return output;
}

function rowRecord(row) {
  if (!row) return null;
  return {
    schemaVersion: POLICY.policyVersion,
    evidenceId: row.evidence_id,
    taskId: row.task_id,
    scopeId: row.scope_id,
    toolRequestId: row.tool_request_id,
    kind: row.kind,
    mediaType: row.media_type,
    summary: row.summary,
    protectedContent: {
      sha256: row.protected_sha256,
      sizeBytes: row.protected_size_bytes,
      format: row.protected_format
    },
    publicContent: {
      sha256: row.public_sha256,
      sizeBytes: row.public_size_bytes,
      format: row.public_format
    },
    provenance: JSON.parse(row.provenance_json),
    sourceVersion: row.source_version,
    locator: JSON.parse(row.locator_json),
    redactionReport: JSON.parse(row.redaction_report_json),
    retentionClass: row.retention_class,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    recordHash: row.record_hash
  };
}

function rowTombstone(row) {
  if (!row) return null;
  return {
    schemaVersion: POLICY.policyVersion,
    tombstoneId: row.tombstone_id,
    evidenceId: row.evidence_id,
    taskId: row.task_id,
    scopeId: row.scope_id,
    recordHash: row.record_hash,
    protectedSha256: row.protected_sha256,
    publicSha256: row.public_sha256,
    reason: row.reason,
    deletedAt: row.deleted_at,
    tombstoneHash: row.tombstone_hash
  };
}

function validateStoredRecord(record) {
  try {
    identity.validateId(POLICY.identifiers.evidenceIdKind, record.evidenceId);
    identity.validateId(POLICY.identifiers.taskIdKind, record.taskId);
    identity.validateId(POLICY.identifiers.scopeIdKind, record.scopeId);
    identity.validateId(POLICY.identifiers.toolRequestIdKind, record.toolRequestId);
    if (!RECORD_KINDS.has(record.kind) || typeof record.mediaType !== 'string' || !MEDIA_TYPE_PATTERN.test(record.mediaType)) {
      throw new TypeError('record classification');
    }
    assertBoundedString(record.summary, 'summary', POLICY.limits.summaryCharacters);
    if (!record.protectedContent || !HASH_PATTERN.test(record.protectedContent.sha256 || '') ||
        !Number.isSafeInteger(record.protectedContent.sizeBytes) || record.protectedContent.sizeBytes < 0 ||
        record.protectedContent.sizeBytes > POLICY.limits.protectedObjectBytes ||
        !PROTECTED_FORMATS.has(record.protectedContent.format)) throw new TypeError('protected descriptor');
    if (!record.publicContent || !HASH_PATTERN.test(record.publicContent.sha256 || '') ||
        !Number.isSafeInteger(record.publicContent.sizeBytes) || record.publicContent.sizeBytes < 0 ||
        record.publicContent.sizeBytes > POLICY.limits.publicObjectBytes ||
        !PUBLIC_FORMATS.has(record.publicContent.format)) throw new TypeError('public descriptor');
    provenance.validateEnvelope(record.provenance);
    assertBoundedString(record.sourceVersion, 'sourceVersion', POLICY.limits.sourceVersionCharacters);
    if (!SOURCE_VERSION_PATTERN.test(record.sourceVersion)) throw new TypeError('source version');
    assertExactKeys(record.locator, ['kind', 'value'], 'locator');
    if (!LOCATOR_KINDS.has(record.locator.kind)) throw new TypeError('locator kind');
    assertBoundedString(record.locator.value, 'locator.value', POLICY.limits.locatorValueCharacters);
    const report = redaction.validateReport(record.redactionReport);
    if (report.egress !== POLICY.publicExport.egress) throw new TypeError('redaction egress');
    if (!RETENTION_CLASSES.has(record.retentionClass)) throw new TypeError('retention class');
    const created = identity.parseControlTimestamp(record.createdAt);
    const maxAgeMs = POLICY.retention.classes[record.retentionClass].maxAgeMs;
    const expectedExpiry = maxAgeMs === null ? null : safeTimestamp(created.getTime() + maxAgeMs, 'retention expiry');
    if (record.expiresAt !== expectedExpiry) throw new TypeError('retention expiry');
    if (!HASH_PATTERN.test(record.recordHash || '') ||
        identity.canonicalHash(POLICY.recordHash.domain, recordHashPayload(record)) !== record.recordHash) {
      throw new TypeError('record hash');
    }
    return record;
  } catch (error) {
    if (error instanceof EvidenceStoreError && error.code === 'EVIDENCE_RECORD_TAMPERED') throw error;
    throw evidenceError('EVIDENCE_RECORD_TAMPERED', 'Stored evidence metadata failed integrity validation.', {
      evidenceId: typeof record?.evidenceId === 'string' ? record.evidenceId : undefined
    }, error);
  }
}

function validateStoredTombstone(tombstone, record) {
  try {
    identity.validateId(POLICY.identifiers.tombstoneIdKind, tombstone.tombstoneId);
    identity.validateId(POLICY.identifiers.evidenceIdKind, tombstone.evidenceId);
    identity.validateId(POLICY.identifiers.taskIdKind, tombstone.taskId);
    identity.validateId(POLICY.identifiers.scopeIdKind, tombstone.scopeId);
    identity.parseControlTimestamp(tombstone.deletedAt);
    if (!REASON_CODES.has(tombstone.reason) ||
        !HASH_PATTERN.test(tombstone.recordHash || '') ||
        !HASH_PATTERN.test(tombstone.protectedSha256 || '') ||
        !HASH_PATTERN.test(tombstone.publicSha256 || '') ||
        !HASH_PATTERN.test(tombstone.tombstoneHash || '') ||
        identity.canonicalHash(POLICY.tombstoneHash.domain, tombstoneHashPayload(tombstone)) !== tombstone.tombstoneHash) {
      throw new TypeError('tombstone');
    }
    if (record && (tombstone.evidenceId !== record.evidenceId || tombstone.taskId !== record.taskId ||
        tombstone.scopeId !== record.scopeId || tombstone.recordHash !== record.recordHash ||
        tombstone.protectedSha256 !== record.protectedContent.sha256 ||
        tombstone.publicSha256 !== record.publicContent.sha256)) throw new TypeError('tombstone binding');
    return tombstone;
  } catch (error) {
    throw evidenceError('EVIDENCE_TOMBSTONE_TAMPERED', 'Stored evidence tombstone failed integrity validation.', {
      evidenceId: typeof tombstone?.evidenceId === 'string' ? tombstone.evidenceId : undefined
    }, error);
  }
}

function safeRecord(record, sequence, tombstoned = false, replayed = false) {
  const output = {
    schemaVersion: record.schemaVersion,
    sequence,
    evidenceId: record.evidenceId,
    taskId: record.taskId,
    scopeId: record.scopeId,
    toolRequestId: record.toolRequestId,
    kind: record.kind,
    mediaType: record.mediaType,
    summary: record.summary,
    publicContent: Object.freeze({ ...record.publicContent }),
    provenance: provenance.safeDisplay(record.provenance),
    retentionClass: record.retentionClass,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    recordHash: record.recordHash,
    tombstoned,
    replayed
  };
  return Object.freeze(output);
}

function writeReceipt(record, sequence, tombstoned = false, replayed = false) {
  return Object.freeze({
    ...safeRecord(record, sequence, tombstoned, replayed),
    evidenceRef: Object.freeze({
      evidenceId: record.evidenceId,
      contentHash: record.protectedContent.sha256
    })
  });
}

function translateSqliteError(error) {
  if (error instanceof EvidenceStoreError) return error;
  if (error && error.code === 'ERR_SQLITE_ERROR') {
    const base = Number(error.errcode) & 0xff;
    if (base === 5 || base === 6) {
      return evidenceError('EVIDENCE_BUSY', 'The evidence database is busy.', { sqliteCode: error.errcode }, error);
    }
    if (base === 19) {
      return evidenceError('EVIDENCE_CONSTRAINT', 'An evidence database constraint was violated.', { sqliteCode: error.errcode }, error);
    }
    return evidenceError('EVIDENCE_SQLITE_ERROR', 'The evidence database rejected an operation.', { sqliteCode: error.errcode }, error);
  }
  return error;
}

function verifySchema(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const applicationId = db.prepare('PRAGMA application_id').get().application_id;
  if (version !== SCHEMA_VERSION) {
    throw evidenceError('EVIDENCE_SCHEMA_INVALID', 'The evidence schema version is invalid.', { version, supported: SCHEMA_VERSION });
  }
  if (applicationId !== APPLICATION_ID) {
    throw evidenceError('EVIDENCE_DATABASE_IDENTITY', 'The configured database is not a ToolsEnabled evidence database.', { applicationId });
  }
  if (databaseFingerprint(db) !== expectedFingerprint()) {
    throw evidenceError('EVIDENCE_SCHEMA_INVALID', 'The evidence DDL fingerprint does not match this build.');
  }
  if (expectedFingerprint() !== POLICY.database.schemaFingerprint) {
    throw evidenceError('EVIDENCE_SCHEMA_INVALID', 'The evidence policy fingerprint does not match this build.');
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) {
    throw evidenceError('EVIDENCE_SCHEMA_INVALID', 'The evidence database has invalid foreign-key references.');
  }
}

function openReadOnlyDatabase(filename, busyTimeoutMs = 60_000) {
  if (typeof filename !== 'string' || !filename || filename === ':memory:') {
    throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'A file-backed evidence database is required.', { field: 'dbFile' });
  }
  const resolved = path.resolve(filename);
  let databaseEntry;
  try {
    databaseEntry = fs.lstatSync(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw evidenceError('EVIDENCE_DATABASE_MISSING', 'The evidence database does not exist.', {}, error);
    }
    throw evidenceError(
      'EVIDENCE_DATABASE_UNAVAILABLE',
      'The evidence database could not be inspected; this does not claim that it is absent.',
      { errorCode: error && error.code ? error.code : 'UNKNOWN' },
      error
    );
  }
  if (!databaseEntry.isFile()) {
    throw evidenceError('EVIDENCE_DATABASE_UNAVAILABLE', 'The evidence database path is not a regular file; this does not claim that it is absent.');
  }
  let db;
  try {
    db = new DatabaseSync(resolved, {
      readOnly: true,
      timeout: busyTimeoutMs,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      readBigInts: false,
      returnArrays: false,
      allowBareNamedParameters: true,
      allowUnknownNamedParameters: false
    });
    db.exec(`PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs};`);
    verifySchema(db);
    return db;
  } catch (error) {
    if (databaseIsOpen(db)) {
      try { db.close(); } catch { /* preserve original */ }
    }
    throw translateSqliteError(error);
  }
}

function resolveObjectForRead(objectRoot, digest) {
  if (!HASH_PATTERN.test(digest || '')) return { ok: false, reason: 'digest' };
  const root = path.resolve(objectRoot);
  const rootStat = lstatOrNull(root);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, reason: 'storage-root' };
  const rootReal = fs.realpathSync.native(root);
  let directory = rootReal;
  for (const segment of ['objects', 'sha256', digest.slice(0, 2), digest.slice(2, 4)]) {
    directory = path.join(directory, segment);
    const directoryStat = lstatOrNull(directory);
    if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return { ok: false, reason: 'unsafe-object' };
    }
    const realDirectory = fs.realpathSync.native(directory);
    if (!isWithin(rootReal, realDirectory)) return { ok: false, reason: 'unsafe-object' };
    directory = realDirectory;
  }
  const filename = path.join(directory, `${digest}.blob`);
  const stat = lstatOrNull(filename);
  if (!stat) return { ok: false, reason: 'missing' };
  if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: 'unsafe-object' };
  const real = fs.realpathSync.native(filename);
  if (!isWithin(rootReal, real)) return { ok: false, reason: 'unsafe-object' };
  return { ok: true, rootReal, filename: real };
}

function verifyOpenDescriptor(descriptor, digest, expectedBytes) {
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size !== expectedBytes) return { ok: false, reason: 'size', actualBytes: before.size };
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, expectedBytes)));
    let position = 0;
    while (position < expectedBytes) {
      const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, expectedBytes - position), position);
      if (count <= 0) return { ok: false, reason: 'short-read' };
      hash.update(chunk.subarray(0, count));
      position += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { ok: false, reason: 'changed-during-read' };
    const actualDigest = hash.digest('hex');
    return actualDigest === digest ? { ok: true, stat: after } : { ok: false, reason: 'hash', actualDigest };
  } catch (error) {
    return { ok: false, reason: 'io', errorCode: error && error.code ? error.code : 'UNKNOWN' };
  }
}

function verifyObjectFile(objectRoot, digest, expectedBytes) {
  const resolved = resolveObjectForRead(objectRoot, digest);
  if (!resolved.ok) return resolved;
  let descriptor;
  try {
    descriptor = fs.openSync(resolved.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const checked = verifyOpenDescriptor(descriptor, digest, expectedBytes);
    return checked.ok ? { ok: true } : checked;
  } catch (error) {
    return { ok: false, reason: 'io', errorCode: error && error.code ? error.code : 'UNKNOWN' };
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* verification already has a result */ }
    }
  }
}

function verifyEvidenceStore({ dbFile, objectRoot, busyTimeoutMs = 60_000 } = {}) {
  busyTimeoutMs = assertSafeInteger(busyTimeoutMs, 'busyTimeoutMs', 1, 300_000);
  const db = openReadOnlyDatabase(dbFile, busyTimeoutMs);
  try {
    const quick = db.prepare('PRAGMA quick_check').all();
    if (quick.length !== 1 || quick[0].quick_check !== 'ok') {
      return { ok: false, code: 'EVIDENCE_DATABASE_CORRUPT', records: 0, activeRecords: 0, tombstones: 0, failures: [] };
    }
    const rows = db.prepare(`SELECT r.*, t.tombstone_id
      FROM evidence_records r LEFT JOIN evidence_tombstones t ON t.evidence_id = r.evidence_id
      ORDER BY r.sequence`).all();
    const tombstoneRows = db.prepare('SELECT * FROM evidence_tombstones ORDER BY sequence').all();
    const failures = [];
    const recordsById = new Map();
    let activeRecords = 0;
    let objectsVerified = 0;
    for (const row of rows) {
      let record;
      try {
        record = validateStoredRecord(rowRecord(row));
        recordsById.set(record.evidenceId, record);
      } catch {
        failures.push({ evidenceId: row.evidence_id, part: 'record', reason: 'invalid' });
        continue;
      }
      if (row.tombstone_id !== null) continue;
      activeRecords += 1;
      for (const [part, descriptor] of [['protected', record.protectedContent], ['public', record.publicContent]]) {
        const checked = verifyObjectFile(objectRoot, descriptor.sha256, descriptor.sizeBytes);
        if (!checked.ok) failures.push({ evidenceId: record.evidenceId, part, reason: checked.reason });
        else objectsVerified += 1;
      }
    }
    for (const row of tombstoneRows) {
      try {
        const tombstone = rowTombstone(row);
        validateStoredTombstone(tombstone, recordsById.get(tombstone.evidenceId));
      } catch {
        failures.push({ evidenceId: row.evidence_id, part: 'tombstone', reason: 'invalid' });
      }
    }
    return Object.freeze({
      ok: failures.length === 0,
      code: failures.length === 0 ? 'OK' : 'EVIDENCE_INTEGRITY_FAILURE',
      schemaVersion: SCHEMA_VERSION,
      records: rows.length,
      activeRecords,
      tombstones: tombstoneRows.length,
      objectsVerified,
      failures: Object.freeze(failures.map(item => Object.freeze(item)))
    });
  } finally {
    db.close();
  }
}

class EvidenceStore {
  constructor(options = {}) {
    assertPlainObject(options, 'options');
    const selectedRoot = options.objectRoot === undefined ? DEFAULT_ROOT : options.objectRoot;
    const selectedDb = options.dbFile === undefined ? DEFAULT_DB_FILE : options.dbFile;
    if (typeof selectedRoot !== 'string' || !selectedRoot || selectedRoot.length > 4096) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'objectRoot is invalid.', { field: 'objectRoot' });
    }
    if (typeof selectedDb !== 'string' || !selectedDb || selectedDb.length > 4096) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'dbFile is invalid.', { field: 'dbFile' });
    }
    this.objectRoot = path.resolve(selectedRoot);
    this.dbFile = selectedDb === ':memory:' ? selectedDb : path.resolve(selectedDb);
    this.busyTimeoutMs = options.busyTimeoutMs === undefined
      ? 60_000 : assertSafeInteger(options.busyTimeoutMs, 'busyTimeoutMs', 1, 300_000);
    this.maxProtectedBytes = options.maxProtectedBytes === undefined
      ? POLICY.limits.protectedObjectBytes
      : assertSafeInteger(options.maxProtectedBytes, 'maxProtectedBytes', 1, POLICY.limits.protectedObjectBytes);
    this.maxPublicBytes = options.maxPublicBytes === undefined
      ? POLICY.limits.publicObjectBytes
      : assertSafeInteger(options.maxPublicBytes, 'maxPublicBytes', 1, POLICY.limits.publicObjectBytes);
    this.maxSpanBytes = options.maxSpanBytes === undefined
      ? POLICY.limits.spanBytes
      : assertSafeInteger(options.maxSpanBytes, 'maxSpanBytes', 1, POLICY.limits.spanBytes);
    this.clock = options.clock === undefined ? (() => Date.now()) : options.clock;
    if (typeof this.clock !== 'function') throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'clock must be a function.', { field: 'clock' });
    this.authorize = options.authorize === undefined ? null : options.authorize;
    if (this.authorize !== null && typeof this.authorize !== 'function') {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'authorize must be a function.', { field: 'authorize' });
    }
    this._db = null;
    this._transactionActive = false;
    this._rootReal = null;
    this._prepareStorage();
    this._open();
  }

  _now() {
    const value = this.clock();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    assertSafeInteger(milliseconds, 'clock result');
    return { milliseconds, timestamp: safeTimestamp(milliseconds) };
  }

  _prepareStorage() {
    ensureDir(this.objectRoot);
    const rootStat = fs.lstatSync(this.objectRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw evidenceError('EVIDENCE_STORAGE_UNSAFE', 'The evidence object root must be a real directory.');
    }
    this._rootReal = fs.realpathSync.native(this.objectRoot);
    for (const relative of [['objects'], ['objects', 'sha256'], ['tmp'], ['trash']]) {
      const directory = path.join(this._rootReal, ...relative);
      ensureDir(directory);
      assertSafeDirectory(directory, this._rootReal);
    }
  }

  _assertRootStable() {
    const stat = fs.lstatSync(this.objectRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(this.objectRoot) !== this._rootReal) {
      throw evidenceError('EVIDENCE_STORAGE_UNSAFE', 'The evidence object root changed after startup.');
    }
  }

  _open() {
    if (databaseIsOpen(this._db)) return this._db;
    if (this.dbFile !== ':memory:') ensureDir(path.dirname(this.dbFile));
    let db;
    try {
      db = new DatabaseSync(this.dbFile, {
        timeout: this.busyTimeoutMs,
        allowExtension: false,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        readBigInts: false,
        returnArrays: false,
        allowBareNamedParameters: true,
        allowUnknownNamedParameters: false
      });
      this._db = db;
      const preflightVersion = db.prepare('PRAGMA user_version').get().user_version;
      const preflightApplicationId = db.prepare('PRAGMA application_id').get().application_id;
      if (preflightApplicationId !== 0 && preflightApplicationId !== APPLICATION_ID) {
        throw evidenceError('EVIDENCE_DATABASE_IDENTITY', 'The configured path belongs to another SQLite application.', {
          applicationId: preflightApplicationId
        });
      }
      if (preflightVersion > SCHEMA_VERSION) {
        throw evidenceError('EVIDENCE_SCHEMA_TOO_NEW', 'The evidence schema is newer than this build.', {
          version: preflightVersion,
          supported: SCHEMA_VERSION
        });
      }
      if (preflightVersion > 0 && preflightApplicationId !== APPLICATION_ID) {
        throw evidenceError('EVIDENCE_DATABASE_IDENTITY', 'A versioned database is missing the evidence application identity.');
      }
      if (preflightVersion === 0) {
        const prior = db.prepare(`SELECT name FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL LIMIT 1`).get();
        if (prior) throw evidenceError('EVIDENCE_SCHEMA_INVALID', 'A version-zero evidence database is not empty.');
      }
      // Identity and supported migration source are proven before the first
      // persistent PRAGMA mutation. A rejected foreign DB keeps its journal.
      const journalMode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
      if (this.dbFile !== ':memory:' && journalMode !== POLICY.database.journalMode) {
        throw evidenceError('EVIDENCE_WAL_UNAVAILABLE', 'The evidence database could not enable WAL mode.', { journalMode });
      }
      db.exec(`PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${this.busyTimeoutMs};`);
      this._migrateAndValidate();
      return db;
    } catch (error) {
      if (databaseIsOpen(db)) {
        try { db.close(); } catch { /* preserve original */ }
      }
      this._db = null;
      throw translateSqliteError(error);
    }
  }

  _migrateAndValidate() {
    const db = this._db;
    let transactionStarted = false;
    try {
      this._transactionActive = true;
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const applicationId = db.prepare('PRAGMA application_id').get().application_id;
      if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
        throw evidenceError('EVIDENCE_DATABASE_IDENTITY', 'The configured path belongs to another SQLite application.', { applicationId });
      }
      if (version > SCHEMA_VERSION) {
        throw evidenceError('EVIDENCE_SCHEMA_TOO_NEW', 'The evidence schema is newer than this build.', { version, supported: SCHEMA_VERSION });
      }
      if (version === 0) {
        const prior = db.prepare(`SELECT name FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL LIMIT 1`).get();
        if (prior) throw evidenceError('EVIDENCE_SCHEMA_INVALID', 'A version-zero evidence database is not empty.');
        db.exec(SCHEMA_V1);
      } else if (version !== SCHEMA_VERSION) {
        throw evidenceError('EVIDENCE_SCHEMA_UNSUPPORTED', 'The evidence schema cannot be upgraded by this build.', { version });
      }
      verifySchema(db);
      db.exec('COMMIT');
    } catch (error) {
      if (transactionStarted || databaseIsTransaction(db)) db.exec('ROLLBACK');
      throw error;
    } finally {
      this._transactionActive = false;
    }
  }

  _transaction(callback) {
    const db = this._open();
    if (this._transactionActive || databaseIsTransaction(db)) throw evidenceError('EVIDENCE_TRANSACTION_NESTED', 'Nested evidence transactions are not supported.');
    let transactionStarted = false;
    this._transactionActive = true;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback(db);
      if (result && typeof result.then === 'function') {
        throw evidenceError('EVIDENCE_TRANSACTION_ASYNC', 'Evidence transactions must be synchronous.');
      }
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (transactionStarted || databaseIsTransaction(db)) db.exec('ROLLBACK');
      throw translateSqliteError(error);
    } finally {
      this._transactionActive = false;
    }
  }

  _authorize(operation, access, binding) {
    if (!this.authorize) throw evidenceError('EVIDENCE_ACCESS_DENIED', 'Evidence access was denied.');
    let allowed;
    try {
      allowed = this.authorize(Object.freeze({
        operation,
        access,
        binding: Object.freeze({ ...binding })
      }));
    } catch (error) {
      throw evidenceError('EVIDENCE_ACCESS_DENIED', 'Evidence access was denied.', {}, error);
    }
    if (allowed && typeof allowed.then === 'function') {
      throw evidenceError('EVIDENCE_ACCESS_DENIED', 'Evidence authorization must be synchronous.');
    }
    if (allowed !== true) throw evidenceError('EVIDENCE_ACCESS_DENIED', 'Evidence access was denied.');
  }

  _validateBinding(input) {
    try {
      identity.validateId(POLICY.identifiers.taskIdKind, input.taskId);
      identity.validateId(POLICY.identifiers.scopeIdKind, input.scopeId);
      identity.validateId(POLICY.identifiers.toolRequestIdKind, input.toolRequestId);
    } catch (error) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'Evidence identity binding is invalid.', { field: 'binding' }, error);
    }
    return { taskId: input.taskId, scopeId: input.scopeId, toolRequestId: input.toolRequestId };
  }

  _validateEvidenceId(value) {
    try {
      return identity.validateId(POLICY.identifiers.evidenceIdKind, value);
    } catch (error) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'evidenceId is invalid.', { field: 'evidenceId' }, error);
    }
  }

  _validateLocator(value) {
    assertExactKeys(value, ['kind', 'value'], 'locator');
    if (!LOCATOR_KINDS.has(value.kind)) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'locator.kind is invalid.', { field: 'locator.kind' });
    }
    assertBoundedString(value.value, 'locator.value', POLICY.limits.locatorValueCharacters);
    canonicalJson(value, 'locator');
    return { kind: value.kind, value: value.value };
  }

  _validateProvenance(value) {
    try {
      const checked = provenance.validateEnvelope(value);
      canonicalJson(checked, 'provenance');
      return checked;
    } catch (error) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'provenance is invalid.', { field: 'provenance' }, error);
    }
  }

  _preparePublicExport(value) {
    let checked;
    try {
      checked = redaction.verifyPreparedEgress(value, POLICY.publicExport.egress);
    } catch (error) {
      throw evidenceError('EVIDENCE_REDACTION_REQUIRED', 'publicExport must pass the P09 evidence-export gate.', {}, error);
    }
    const payload = assertExactKeys(checked.payload, POLICY.publicExport.payloadFields, 'publicExport.payload');
    const summary = assertBoundedString(payload.summary, 'publicExport.payload.summary', POLICY.limits.summaryCharacters);
    if (!PUBLIC_FORMATS.has(payload.format)) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'publicExport.payload.format is invalid.', { field: 'publicExport.payload.format' });
    }
    let bytes;
    if (payload.format === 'text') {
      if (typeof payload.content !== 'string') {
        throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'Public text content must be a string.', { field: 'publicExport.payload.content' });
      }
      bytes = Buffer.from(payload.content, 'utf8');
    } else {
      bytes = Buffer.from(canonicalJson(payload.content, 'publicExport.payload.content', this.maxPublicBytes), 'ascii');
    }
    if (bytes.length > this.maxPublicBytes) {
      throw evidenceError('EVIDENCE_OBJECT_TOO_LARGE', 'Public evidence content is too large.', { maximumBytes: this.maxPublicBytes });
    }
    canonicalJson(checked.redactionReport, 'publicExport.redactionReport');
    return {
      summary,
      format: payload.format,
      bytes,
      redactionReport: checked.redactionReport
    };
  }

  _prepareProtectedContent(value) {
    assertPlainObject(value, 'protectedContent');
    if (value.type === 'text') {
      assertExactKeys(value, ['type', 'text'], 'protectedContent');
      if (typeof value.text !== 'string') {
        throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'protectedContent.text must be a string.', { field: 'protectedContent.text' });
      }
      return { source: 'buffer', format: 'text', bytes: Buffer.from(value.text, 'utf8') };
    }
    if (value.type === 'json') {
      assertExactKeys(value, ['type', 'value'], 'protectedContent');
      return { source: 'buffer', format: 'json', bytes: Buffer.from(canonicalJson(value.value, 'protectedContent.value', this.maxProtectedBytes), 'ascii') };
    }
    if (value.type === 'bytes') {
      assertExactKeys(value, ['type', 'bytes'], 'protectedContent');
      if (!Buffer.isBuffer(value.bytes) && !(value.bytes instanceof Uint8Array)) {
        throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'protectedContent.bytes must be bytes.', { field: 'protectedContent.bytes' });
      }
      return { source: 'buffer', format: 'binary', bytes: Buffer.from(value.bytes) };
    }
    if (value.type === 'file') {
      assertExactKeys(value, ['type', 'path'], 'protectedContent');
      if (typeof value.path !== 'string' || !value.path || value.path.length > 4096) {
        throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'protectedContent.path is invalid.', { field: 'protectedContent.path' });
      }
      return { source: 'file', format: 'binary', path: path.resolve(value.path) };
    }
    throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'protectedContent.type is invalid.', { field: 'protectedContent.type' });
  }

  _temporaryFile() {
    this._assertRootStable();
    const directory = assertSafeDirectory(path.join(this._rootReal, 'tmp'), this._rootReal);
    const filename = path.join(directory, `${process.pid}-${crypto.randomBytes(18).toString('hex')}.tmp`);
    const descriptor = fs.openSync(filename,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
      0o600);
    return { filename, descriptor };
  }

  _commitTemporaryObject(tempFile, digest, sizeBytes) {
    this._assertRootStable();
    const first = path.join(this._rootReal, 'objects', 'sha256', digest.slice(0, 2));
    const second = path.join(first, digest.slice(2, 4));
    ensureDir(first);
    assertSafeDirectory(first, this._rootReal);
    ensureDir(second);
    assertSafeDirectory(second, this._rootReal);
    const destination = path.join(second, `${digest}.blob`);
    try {
      const prior = lstatOrNull(destination);
      if (prior) {
        const checked = verifyObjectFile(this._rootReal, digest, sizeBytes);
        if (!checked.ok) {
          throw evidenceError('EVIDENCE_OBJECT_TAMPERED', 'An existing content-addressed object failed verification.', { sha256: digest, reason: checked.reason });
        }
        return { sha256: digest, sizeBytes, replayed: true };
      }
      try {
        fs.linkSync(tempFile, destination);
      } catch (error) {
        if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
          const checked = verifyObjectFile(this._rootReal, digest, sizeBytes);
          if (checked.ok) return { sha256: digest, sizeBytes, replayed: true };
        }
        throw error;
      }
      const destinationStat = fs.lstatSync(destination);
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
        throw evidenceError('EVIDENCE_STORAGE_UNSAFE', 'The committed evidence object is not a regular file.');
      }
      const realDestination = fs.realpathSync.native(destination);
      if (!isWithin(this._rootReal, realDestination)) {
        throw evidenceError('EVIDENCE_STORAGE_UNSAFE', 'The committed evidence object escaped its storage root.');
      }
      try { fs.chmodSync(destination, 0o440); } catch { /* Windows ACLs remain the controlling boundary. */ }
      const checked = verifyObjectFile(this._rootReal, digest, sizeBytes);
      if (!checked.ok) {
        throw evidenceError('EVIDENCE_OBJECT_TAMPERED', 'The committed evidence object failed verification.', { sha256: digest, reason: checked.reason });
      }
      return { sha256: digest, sizeBytes, replayed: false };
    } finally {
      try { fs.unlinkSync(tempFile); } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          // An orphan temporary file is safe and can be removed by maintenance.
        }
      }
    }
  }

  _stageBuffer(buffer, maximumBytes) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (buffer.length > maximumBytes) {
      throw evidenceError('EVIDENCE_OBJECT_TOO_LARGE', 'Evidence content is too large.', { maximumBytes });
    }
    const temporary = this._temporaryFile();
    try {
      let written = 0;
      while (written < buffer.length) written += fs.writeSync(temporary.descriptor, buffer, written, buffer.length - written);
      fs.fsyncSync(temporary.descriptor);
    } catch (error) {
      try { fs.closeSync(temporary.descriptor); } catch { /* preserve original */ }
      try { fs.unlinkSync(temporary.filename); } catch { /* best effort temporary cleanup */ }
      throw error;
    }
    fs.closeSync(temporary.descriptor);
    return { tempFile: temporary.filename, sha256: rawSha256(buffer), sizeBytes: buffer.length };
  }

  _stageSourceFile(filename, maximumBytes) {
    const sourceStat = fs.lstatSync(filename);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'Protected source must be a regular file.', { field: 'protectedContent.path' });
    }
    if (sourceStat.size > maximumBytes) {
      throw evidenceError('EVIDENCE_OBJECT_TOO_LARGE', 'Evidence content is too large.', { maximumBytes });
    }
    const source = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    // _temporaryFile() can itself throw (root-stability check, unsafe
    // directory, or O_CREAT|O_EXCL failure). It runs before the try below, so
    // without this guard every such failure leaked the source descriptor —
    // one fd per failed protected-file capture in a long-lived process.
    let temporary;
    try {
      temporary = this._temporaryFile();
    } catch (error) {
      try { fs.closeSync(source); } catch { /* preserve original */ }
      throw error;
    }
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    try {
      const before = fs.fstatSync(source);
      if (!before.isFile() || before.size > maximumBytes) {
        throw evidenceError('EVIDENCE_OBJECT_TOO_LARGE', 'Evidence content is too large.', { maximumBytes });
      }
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, before.size)));
      while (sizeBytes < before.size) {
        const count = fs.readSync(source, chunk, 0, Math.min(chunk.length, before.size - sizeBytes), sizeBytes);
        if (count <= 0) throw evidenceError('EVIDENCE_SOURCE_CHANGED', 'Protected source changed while it was captured.');
        let written = 0;
        while (written < count) written += fs.writeSync(temporary.descriptor, chunk, written, count - written);
        hash.update(chunk.subarray(0, count));
        sizeBytes += count;
      }
      const after = fs.fstatSync(source);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw evidenceError('EVIDENCE_SOURCE_CHANGED', 'Protected source changed while it was captured.');
      }
      fs.fsyncSync(temporary.descriptor);
    } catch (error) {
      try { fs.closeSync(source); } catch { /* preserve original */ }
      try { fs.closeSync(temporary.descriptor); } catch { /* preserve original */ }
      try { fs.unlinkSync(temporary.filename); } catch { /* best effort temporary cleanup */ }
      throw error;
    }
    fs.closeSync(source);
    fs.closeSync(temporary.descriptor);
    return { tempFile: temporary.filename, sha256: hash.digest('hex'), sizeBytes };
  }

  _commitStagedObject(staged) {
    return this._commitTemporaryObject(staged.tempFile, staged.sha256, staged.sizeBytes);
  }

  _discardStagedObject(staged) {
    if (!staged || typeof staged.tempFile !== 'string') return;
    try { fs.unlinkSync(staged.tempFile); } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        // The bounded maintenance sweep handles a safe leftover temp file.
      }
    }
  }

  _logicalReplayMatches(record, candidate) {
    const fields = [
      'evidenceId', 'taskId', 'scopeId', 'toolRequestId', 'kind', 'mediaType', 'summary',
      'sourceVersion', 'retentionClass'
    ];
    if (fields.some(field => record[field] !== candidate[field])) return false;
    return identity.canonicalString(record.protectedContent) === identity.canonicalString(candidate.protectedContent) &&
      identity.canonicalString(record.publicContent) === identity.canonicalString(candidate.publicContent) &&
      identity.canonicalString(record.provenance) === identity.canonicalString(candidate.provenance) &&
      identity.canonicalString(record.locator) === identity.canonicalString(candidate.locator) &&
      identity.canonicalString(record.redactionReport) === identity.canonicalString(candidate.redactionReport);
  }

  writeEvidence(input = {}) {
    assertPlainObject(input, 'input');
    const binding = this._validateBinding(input);
    this._authorize('write', input.access, binding);
    const evidenceId = input.evidenceId === undefined
      ? identity.newId(POLICY.identifiers.evidenceIdKind)
      : this._validateEvidenceId(input.evidenceId);
    if (!RECORD_KINDS.has(input.kind)) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'kind is invalid.', { field: 'kind' });
    }
    if (typeof input.mediaType !== 'string' || !MEDIA_TYPE_PATTERN.test(input.mediaType)) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'mediaType is invalid.', { field: 'mediaType' });
    }
    const sourceVersion = assertBoundedString(input.sourceVersion, 'sourceVersion', POLICY.limits.sourceVersionCharacters);
    if (!SOURCE_VERSION_PATTERN.test(sourceVersion)) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'sourceVersion must be an opaque ASCII version token.', { field: 'sourceVersion' });
    }
    const locator = this._validateLocator(input.locator);
    const checkedProvenance = this._validateProvenance(input.provenance);
    const retentionClass = input.retentionClass === undefined ? POLICY.retention.defaultClass : input.retentionClass;
    if (!RETENTION_CLASSES.has(retentionClass)) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'retentionClass is invalid.', { field: 'retentionClass' });
    }
    const publicExport = this._preparePublicExport(input.publicExport);
    const protectedInput = this._prepareProtectedContent(input.protectedContent);
    let publicObject;
    let protectedObject;
    try {
      publicObject = this._stageBuffer(publicExport.bytes, this.maxPublicBytes);
      protectedObject = protectedInput.source === 'file'
        ? this._stageSourceFile(protectedInput.path, this.maxProtectedBytes)
        : this._stageBuffer(protectedInput.bytes, this.maxProtectedBytes);
    } catch (error) {
      this._discardStagedObject(publicObject);
      this._discardStagedObject(protectedObject);
      throw error;
    }
    const candidate = {
      schemaVersion: POLICY.policyVersion,
      evidenceId,
      ...binding,
      kind: input.kind,
      mediaType: input.mediaType,
      summary: publicExport.summary,
      protectedContent: {
        sha256: protectedObject.sha256,
        sizeBytes: protectedObject.sizeBytes,
        format: protectedInput.format
      },
      publicContent: {
        sha256: publicObject.sha256,
        sizeBytes: publicObject.sizeBytes,
        format: publicExport.format
      },
      provenance: checkedProvenance,
      sourceVersion,
      locator,
      redactionReport: publicExport.redactionReport,
      retentionClass
    };
    try {
      return this._transaction(db => {
        const priorRow = db.prepare(`SELECT r.*, t.tombstone_id FROM evidence_records r
          LEFT JOIN evidence_tombstones t ON t.evidence_id = r.evidence_id WHERE r.evidence_id = ?`).get(evidenceId);
        if (priorRow) {
          if (priorRow.tombstone_id !== null) {
            throw evidenceError('EVIDENCE_TOMBSTONED', 'A tombstoned evidence ID cannot be reused.', { evidenceId });
          }
          const prior = validateStoredRecord(rowRecord(priorRow));
          if (!this._logicalReplayMatches(prior, candidate)) {
            throw evidenceError('EVIDENCE_CONFLICT', 'The evidence ID was replayed with different content.', { evidenceId });
          }
          // The DB write lock prevents retention/GC from removing a just-linked
          // object before this replay has verified or restored its CAS entry.
          this._commitStagedObject(publicObject);
          this._commitStagedObject(protectedObject);
          return writeReceipt(prior, priorRow.sequence, false, true);
        }
        const now = this._now();
        const maxAgeMs = POLICY.retention.classes[retentionClass].maxAgeMs;
        const expiresAt = maxAgeMs === null ? null : safeTimestamp(now.milliseconds + maxAgeMs, 'retention expiry');
        const record = { ...candidate, expiresAt, createdAt: now.timestamp };
        record.recordHash = identity.canonicalHash(POLICY.recordHash.domain, recordHashPayload(record));
        validateStoredRecord(record);
        // Link both staged files and append their metadata while the same
        // BEGIN IMMEDIATE lock excludes the collector. A crash can leave only
        // an unreferenced CAS object, never a committed dangling record.
        this._commitStagedObject(publicObject);
        this._commitStagedObject(protectedObject);
        db.prepare(`INSERT INTO evidence_records(
          evidence_id, task_id, scope_id, tool_request_id, kind, media_type, summary,
          protected_sha256, protected_size_bytes, protected_format,
          public_sha256, public_size_bytes, public_format,
          provenance_json, source_version, locator_json, redaction_report_json,
          retention_class, expires_at, created_at, record_hash
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          record.evidenceId, record.taskId, record.scopeId, record.toolRequestId, record.kind, record.mediaType, record.summary,
          record.protectedContent.sha256, record.protectedContent.sizeBytes, record.protectedContent.format,
          record.publicContent.sha256, record.publicContent.sizeBytes, record.publicContent.format,
          identity.canonicalString(record.provenance), record.sourceVersion, identity.canonicalString(record.locator),
          identity.canonicalString(record.redactionReport), record.retentionClass, record.expiresAt, record.createdAt, record.recordHash
        );
        const row = db.prepare('SELECT * FROM evidence_records WHERE evidence_id = ?').get(record.evidenceId);
        return writeReceipt(record, row.sequence, false, false);
      });
    } finally {
      this._discardStagedObject(publicObject);
      this._discardStagedObject(protectedObject);
    }
  }

  _authorizedRow(operation, selector, { validateRecord = true } = {}) {
    assertPlainObject(selector, 'selector');
    const binding = {
      taskId: selector.taskId,
      scopeId: selector.scopeId,
      toolRequestId: selector.toolRequestId
    };
    try {
      identity.validateId(POLICY.identifiers.taskIdKind, binding.taskId);
      identity.validateId(POLICY.identifiers.scopeIdKind, binding.scopeId);
      this._validateEvidenceId(selector.evidenceId);
    } catch {
      throw evidenceError('EVIDENCE_ACCESS_DENIED', 'Evidence access was denied.');
    }
    this._authorize(operation, selector.access, { taskId: binding.taskId, scopeId: binding.scopeId, evidenceId: selector.evidenceId });
    const row = this._open().prepare(`SELECT r.*, t.tombstone_id FROM evidence_records r
      LEFT JOIN evidence_tombstones t ON t.evidence_id = r.evidence_id
      WHERE r.evidence_id = ? AND r.task_id = ? AND r.scope_id = ?`).get(
      selector.evidenceId, binding.taskId, binding.scopeId
    );
    if (!row) throw evidenceError('EVIDENCE_ACCESS_DENIED', 'Evidence access was denied.');
    if (validateRecord) validateStoredRecord(rowRecord(row));
    if (row.tombstone_id !== null) throw evidenceError('EVIDENCE_TOMBSTONED', 'Evidence content has been tombstoned.', { evidenceId: selector.evidenceId });
    return row;
  }

  getPublicRecord(selector = {}) {
    const row = this._authorizedRow('read-public', selector);
    return safeRecord(validateStoredRecord(rowRecord(row)), row.sequence, false, false);
  }

  listPublicRecords({ access, taskId, scopeId, afterSequence = 0, limit = 100 } = {}) {
    try {
      identity.validateId(POLICY.identifiers.taskIdKind, taskId);
      identity.validateId(POLICY.identifiers.scopeIdKind, scopeId);
    } catch {
      throw evidenceError('EVIDENCE_ACCESS_DENIED', 'Evidence access was denied.');
    }
    afterSequence = assertSafeInteger(afterSequence, 'afterSequence');
    limit = assertSafeInteger(limit, 'limit', 1, POLICY.limits.listRecords);
    this._authorize('list-public', access, { taskId, scopeId });
    return this._open().prepare(`SELECT r.* FROM evidence_records r
      LEFT JOIN evidence_tombstones t ON t.evidence_id = r.evidence_id
      WHERE r.task_id = ? AND r.scope_id = ? AND r.sequence > ? AND t.evidence_id IS NULL
      ORDER BY r.sequence LIMIT ?`).all(taskId, scopeId, afterSequence, limit)
      .map(row => safeRecord(validateStoredRecord(rowRecord(row)), row.sequence, false, false));
  }

  _readVerifiedSpan(descriptor, offset, length) {
    offset = assertSafeInteger(offset, 'offset');
    length = assertSafeInteger(length, 'length', 1, this.maxSpanBytes);
    if (offset > descriptor.sizeBytes || length > descriptor.sizeBytes - offset) {
      throw evidenceError('EVIDENCE_SPAN_INVALID', 'The requested evidence span is outside the object.', { offset, length });
    }
    const resolved = resolveObjectForRead(this._rootReal, descriptor.sha256);
    if (!resolved.ok) {
      const code = resolved.reason === 'missing' ? 'EVIDENCE_OBJECT_MISSING' : 'EVIDENCE_OBJECT_TAMPERED';
      throw evidenceError(code, 'Evidence object integrity verification failed.', { sha256: descriptor.sha256, reason: resolved.reason });
    }
    const file = fs.openSync(resolved.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      // Hash and span reads use the same open descriptor. Replacing the path
      // after verification cannot substitute bytes for this read.
      const checked = verifyOpenDescriptor(file, descriptor.sha256, descriptor.sizeBytes);
      if (!checked.ok) {
        throw evidenceError('EVIDENCE_OBJECT_TAMPERED', 'Evidence object integrity verification failed.', {
          sha256: descriptor.sha256,
          reason: checked.reason
        });
      }
      const output = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = fs.readSync(file, output, read, length - read, offset + read);
        if (count <= 0) throw evidenceError('EVIDENCE_OBJECT_TAMPERED', 'Evidence object changed during span read.');
        read += count;
      }
      const after = fs.fstatSync(file);
      if (after.size !== checked.stat.size || after.mtimeMs !== checked.stat.mtimeMs) {
        throw evidenceError('EVIDENCE_OBJECT_TAMPERED', 'Evidence object changed during span read.');
      }
      return Object.freeze({
        bytes: output,
        offset,
        length,
        totalBytes: descriptor.sizeBytes,
        sha256: descriptor.sha256
      });
    } finally {
      fs.closeSync(file);
    }
  }

  readPublicSpan(selector = {}) {
    const row = this._authorizedRow('read-public', selector);
    const record = validateStoredRecord(rowRecord(row));
    return this._readVerifiedSpan(record.publicContent, selector.offset, selector.length);
  }

  readProtectedSpan(selector = {}) {
    const row = this._authorizedRow('read-protected', selector);
    const record = validateStoredRecord(rowRecord(row));
    return this._readVerifiedSpan(record.protectedContent, selector.offset, selector.length);
  }

  verifyEvidence(selector = {}) {
    const row = this._authorizedRow('verify', selector, { validateRecord: false });
    const failures = [];
    let record;
    try {
      record = validateStoredRecord(rowRecord(row));
    } catch {
      failures.push({ part: 'record', reason: 'invalid' });
      return Object.freeze({
        ok: false,
        evidenceId: row.evidence_id,
        recordHash: HASH_PATTERN.test(row.record_hash || '') ? row.record_hash : null,
        failures: Object.freeze(failures.map(item => Object.freeze(item)))
      });
    }
    for (const [part, descriptor] of [['protected', record.protectedContent], ['public', record.publicContent]]) {
      const checked = verifyObjectFile(this._rootReal, descriptor.sha256, descriptor.sizeBytes);
      if (!checked.ok) failures.push({ part, reason: checked.reason });
    }
    return Object.freeze({
      ok: failures.length === 0,
      evidenceId: record.evidenceId,
      recordHash: record.recordHash,
      failures: Object.freeze(failures.map(item => Object.freeze(item)))
    });
  }

  _appendTombstone(db, row, reason, deletedAt, tombstoneId = identity.newId(POLICY.identifiers.tombstoneIdKind)) {
    try {
      identity.validateId(POLICY.identifiers.tombstoneIdKind, tombstoneId);
    } catch (error) {
      throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'tombstoneId is invalid.', { field: 'tombstoneId' }, error);
    }
    if (!REASON_CODES.has(reason)) throw evidenceError('EVIDENCE_INVALID_ARGUMENT', 'reason is invalid.', { field: 'reason' });
    const record = validateStoredRecord(rowRecord(row));
    const tombstone = {
      schemaVersion: POLICY.policyVersion,
      tombstoneId,
      evidenceId: record.evidenceId,
      taskId: record.taskId,
      scopeId: record.scopeId,
      recordHash: record.recordHash,
      protectedSha256: record.protectedContent.sha256,
      publicSha256: record.publicContent.sha256,
      reason,
      deletedAt
    };
    tombstone.tombstoneHash = identity.canonicalHash(POLICY.tombstoneHash.domain, tombstoneHashPayload(tombstone));
    db.prepare(`INSERT INTO evidence_tombstones(
      tombstone_id, evidence_id, task_id, scope_id, record_hash, protected_sha256,
      public_sha256, reason, deleted_at, tombstone_hash
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      tombstone.tombstoneId, tombstone.evidenceId, tombstone.taskId, tombstone.scopeId,
      tombstone.recordHash, tombstone.protectedSha256, tombstone.publicSha256,
      tombstone.reason, tombstone.deletedAt, tombstone.tombstoneHash
    );
    return tombstone;
  }

  _collectDigest(digest) {
    let trashFile = null;
    const result = this._transaction(db => {
      const references = db.prepare(`SELECT * FROM evidence_records
        WHERE protected_sha256 = ? OR public_sha256 = ? ORDER BY sequence`).all(digest, digest);
      const tombstoneQuery = db.prepare('SELECT * FROM evidence_tombstones WHERE evidence_id = ?');
      let live = false;
      for (const row of references) {
        const record = validateStoredRecord(rowRecord(row));
        const tombstoneRow = tombstoneQuery.get(record.evidenceId);
        if (!tombstoneRow) {
          live = true;
          continue;
        }
        validateStoredTombstone(rowTombstone(tombstoneRow), record);
      }
      if (live) return { sha256: digest, collected: false, reason: 'live-reference' };
      const resolved = resolveObjectForRead(this._rootReal, digest);
      if (!resolved.ok && resolved.reason === 'missing') return { sha256: digest, collected: false, reason: 'missing' };
      if (!resolved.ok) {
        throw evidenceError('EVIDENCE_STORAGE_UNSAFE', 'An evidence object is not a regular file.', { sha256: digest });
      }
      const trashDirectory = assertSafeDirectory(path.join(this._rootReal, 'trash'), this._rootReal);
      trashFile = path.join(trashDirectory, `${digest}.${crypto.randomBytes(12).toString('hex')}.trash`);
      fs.renameSync(resolved.filename, trashFile);
      return { sha256: digest, collected: true, reason: 'unreferenced' };
    });
    if (trashFile) {
      try {
        fs.unlinkSync(trashFile);
      } catch (error) {
        return Object.freeze({
          ...result,
          collected: null,
          reason: 'delete-unconfirmed',
          errorCode: error && error.code ? error.code : 'UNKNOWN'
        });
      }
    }
    return Object.freeze(result);
  }

  tombstoneEvidence(selector = {}) {
    assertPlainObject(selector, 'selector');
    let evidenceId;
    try {
      evidenceId = this._validateEvidenceId(selector.evidenceId);
      identity.validateId(POLICY.identifiers.taskIdKind, selector.taskId);
      identity.validateId(POLICY.identifiers.scopeIdKind, selector.scopeId);
    } catch {
      throw evidenceError('EVIDENCE_ACCESS_DENIED', 'Evidence access was denied.');
    }
    this._authorize('delete', selector.access, {
      taskId: selector.taskId,
      scopeId: selector.scopeId,
      evidenceId
    });
    const reason = selector.reason === undefined ? 'user-request' : selector.reason;
    const now = this._now().timestamp;
    const tombstone = this._transaction(db => {
      const row = db.prepare(`SELECT r.*, t.tombstone_id FROM evidence_records r
        LEFT JOIN evidence_tombstones t ON t.evidence_id = r.evidence_id
        WHERE r.evidence_id = ? AND r.task_id = ? AND r.scope_id = ?`).get(
        evidenceId, selector.taskId, selector.scopeId
      );
      if (!row) throw evidenceError('EVIDENCE_ACCESS_DENIED', 'Evidence access was denied.');
      if (row.tombstone_id !== null) {
        return validateStoredTombstone(
          rowTombstone(db.prepare('SELECT * FROM evidence_tombstones WHERE evidence_id = ?').get(evidenceId)),
          validateStoredRecord(rowRecord(row))
        );
      }
      return this._appendTombstone(db, row, reason, now, selector.tombstoneId);
    });
    const collected = [...new Set([tombstone.protectedSha256, tombstone.publicSha256])].map(digest => this._collectDigest(digest));
    return Object.freeze({ tombstone: Object.freeze(tombstone), collected: Object.freeze(collected) });
  }

  applyRetention({ access, nowMs, limit = 100 } = {}) {
    limit = assertSafeInteger(limit, 'limit', 1, POLICY.limits.listRecords);
    const now = nowMs === undefined ? this._now() : {
      milliseconds: assertSafeInteger(nowMs, 'nowMs'),
      timestamp: safeTimestamp(nowMs, 'nowMs')
    };
    this._authorize('retention', access, { before: now.timestamp });
    const rows = this._open().prepare(`SELECT r.* FROM evidence_records r
      LEFT JOIN evidence_tombstones t ON t.evidence_id = r.evidence_id
      WHERE t.evidence_id IS NULL AND r.expires_at IS NOT NULL AND r.expires_at <= ?
      ORDER BY r.expires_at, r.sequence LIMIT ?`).all(now.timestamp, limit);
    const tombstones = [];
    const digests = new Set();
    for (const row of rows) {
      const tombstone = this._transaction(db => {
        const current = db.prepare(`SELECT r.*, t.tombstone_id FROM evidence_records r
          LEFT JOIN evidence_tombstones t ON t.evidence_id = r.evidence_id WHERE r.evidence_id = ?`).get(row.evidence_id);
        if (!current || current.tombstone_id !== null || current.expires_at === null || current.expires_at > now.timestamp) return null;
        validateStoredRecord(rowRecord(current));
        return this._appendTombstone(db, current, 'retention', now.timestamp);
      });
      if (tombstone) {
        tombstones.push(Object.freeze(tombstone));
        digests.add(tombstone.protectedSha256);
        digests.add(tombstone.publicSha256);
      }
    }
    const collected = [...digests].map(digest => this._collectDigest(digest));
    return Object.freeze({
      before: now.timestamp,
      tombstones: Object.freeze(tombstones),
      collected: Object.freeze(collected)
    });
  }

  sweepOrphans({ access, nowMs, limit = POLICY.maintenance.maximumSweepFiles } = {}) {
    limit = assertSafeInteger(limit, 'limit', 1, POLICY.maintenance.maximumSweepFiles);
    const now = nowMs === undefined ? this._now() : {
      milliseconds: assertSafeInteger(nowMs, 'nowMs'),
      timestamp: safeTimestamp(nowMs, 'nowMs')
    };
    this._authorize('maintenance', access, { before: now.timestamp });
    const cutoff = now.milliseconds - POLICY.maintenance.orphanGraceMs;
    const result = {
      inspected: 0,
      removedTemp: 0,
      removedTrash: 0,
      collectedObjects: 0,
      retainedObjects: 0,
      unconfirmedObjects: 0,
      unsafeEntries: 0
    };
    const removeOldFiles = (relative, pattern, field) => {
      const directory = assertSafeDirectory(path.join(this._rootReal, relative), this._rootReal);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (result.inspected >= limit) return;
        if (!pattern.test(entry.name)) continue;
        result.inspected += 1;
        const filename = path.join(directory, entry.name);
        const details = lstatOrNull(filename);
        if (!details || !details.isFile() || details.isSymbolicLink()) {
          result.unsafeEntries += 1;
          continue;
        }
        const real = fs.realpathSync.native(filename);
        if (!isWithin(this._rootReal, real)) {
          result.unsafeEntries += 1;
          continue;
        }
        if (details.mtimeMs <= cutoff) {
          fs.unlinkSync(real);
          result[field] += 1;
        }
      }
    };
    removeOldFiles('tmp', /^[0-9]+-[a-f0-9]{36}\.tmp$/, 'removedTemp');
    if (result.inspected < limit) {
      removeOldFiles('trash', /^[a-f0-9]{64}\.[a-f0-9]{24}\.trash$/, 'removedTrash');
    }
    if (result.inspected < limit) {
      const cas = assertSafeDirectory(path.join(this._rootReal, 'objects', 'sha256'), this._rootReal);
      outer:
      for (const first of fs.readdirSync(cas, { withFileTypes: true })) {
        if (!/^[a-f0-9]{2}$/.test(first.name)) continue;
        const firstPath = path.join(cas, first.name);
        const firstStat = lstatOrNull(firstPath);
        if (!firstStat || !firstStat.isDirectory() || firstStat.isSymbolicLink()) {
          result.unsafeEntries += 1;
          continue;
        }
        const firstReal = fs.realpathSync.native(firstPath);
        if (!isWithin(this._rootReal, firstReal)) {
          result.unsafeEntries += 1;
          continue;
        }
        for (const second of fs.readdirSync(firstReal, { withFileTypes: true })) {
          if (!/^[a-f0-9]{2}$/.test(second.name)) continue;
          const secondPath = path.join(firstReal, second.name);
          const secondStat = lstatOrNull(secondPath);
          if (!secondStat || !secondStat.isDirectory() || secondStat.isSymbolicLink()) {
            result.unsafeEntries += 1;
            continue;
          }
          const secondReal = fs.realpathSync.native(secondPath);
          if (!isWithin(this._rootReal, secondReal)) {
            result.unsafeEntries += 1;
            continue;
          }
          for (const entry of fs.readdirSync(secondReal, { withFileTypes: true })) {
            if (result.inspected >= limit) break outer;
            const match = /^([a-f0-9]{64})\.blob$/.exec(entry.name);
            if (!match || match[1].slice(0, 2) !== first.name || match[1].slice(2, 4) !== second.name) continue;
            result.inspected += 1;
            const filename = path.join(secondReal, entry.name);
            const details = lstatOrNull(filename);
            if (!details || !details.isFile() || details.isSymbolicLink()) {
              result.unsafeEntries += 1;
              continue;
            }
            if (details.mtimeMs > cutoff) continue;
            const collected = this._collectDigest(match[1]);
            if (collected.collected === true) result.collectedObjects += 1;
            else if (collected.collected === false) result.retainedObjects += 1;
            else result.unconfirmedObjects += 1;
          }
        }
      }
    }
    return Object.freeze({ before: now.timestamp, ...result });
  }

  health() {
    const db = this._open();
    return Object.freeze({
      ok: true,
      schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      applicationId: db.prepare('PRAGMA application_id').get().application_id,
      records: db.prepare('SELECT COUNT(*) AS count FROM evidence_records').get().count,
      activeRecords: db.prepare(`SELECT COUNT(*) AS count FROM evidence_records r
        LEFT JOIN evidence_tombstones t ON t.evidence_id = r.evidence_id WHERE t.evidence_id IS NULL`).get().count,
      tombstones: db.prepare('SELECT COUNT(*) AS count FROM evidence_tombstones').get().count,
      runtimeRouteEnabled: POLICY.activation.runtimeRouteEnabled
    });
  }

  close() {
    if (!this._db) return false;
    const db = this._db;
    this._db = null;
    if (databaseIsOpen(db)) db.close();
    return true;
  }
}

module.exports = Object.freeze({
  APPLICATION_ID,
  DEFAULT_DB_FILE,
  DEFAULT_ROOT,
  EvidenceStore,
  EvidenceStoreError,
  POLICY,
  SCHEMA_V1,
  SCHEMA_VERSION,
  expectedFingerprint,
  objectRelativePath,
  recordHashPayload,
  tombstoneHashPayload,
  verifyEvidenceStore
});

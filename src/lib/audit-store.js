'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, rootPath } = require('./runtime');
const maintenance = require('./audit-maintenance-guard');

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

let DatabaseSync;
function openDatabaseSync(...args) {
  // Loading node:sqlite is deferred until the audit ledger is actually used.
  // Consumers that only load a dependency graph must not require SQLite.
  if (!DatabaseSync) DatabaseSync = loadDatabaseSync();
  if (process.platform === 'win32' && typeof args[0] === 'string' && path.isAbsolute(args[0])) args[0] = path.toNamespacedPath(args[0]);
  return new DatabaseSync(...args);
}
const AUDIT_SCHEMA_VERSION = 3;
const AUDIT_APPLICATION_ID = 0x54454155; // "TEAU"
const DEFAULT_AUDIT_DB = rootPath('state', 'audit.sqlite3');
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_ERROR_LENGTH = 1000;
const ZERO_HASH = '0'.repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const SINKS = Object.freeze(['jsonl', 'text']);
const DEFAULT_BUSY_TIMEOUT_MS = 60_000;
const DEFAULT_TRANSACTION_RETRY_MS = 5_000;
// How long the SQLite driver may block inside one BEGIN IMMEDIATE attempt
// before control returns to _beginImmediate's own fair polling loop, and the
// ceiling on that loop's backoff. Both are deliberately far below the ~70 ms
// a holder spends outside the lock between two records: a waiter has to be
// able to observe that window, which a driver sleep saturating at 100 ms
// cannot. See _beginImmediate for the starvation this exists to fix.
const WRITER_ACQUIRE_SLICE_MS = 2;
const WRITER_RETRY_CAP_MS = 15;
const SQLITE_PRIMARY_CODES = Object.freeze({
  1: 'SQLITE_ERROR', 2: 'SQLITE_INTERNAL', 3: 'SQLITE_PERM', 4: 'SQLITE_ABORT',
  5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 7: 'SQLITE_NOMEM', 8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT', 10: 'SQLITE_IOERR', 11: 'SQLITE_CORRUPT', 12: 'SQLITE_NOTFOUND',
  13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN', 15: 'SQLITE_PROTOCOL', 16: 'SQLITE_EMPTY',
  17: 'SQLITE_SCHEMA', 18: 'SQLITE_TOOBIG', 19: 'SQLITE_CONSTRAINT', 20: 'SQLITE_MISMATCH',
  21: 'SQLITE_MISUSE', 22: 'SQLITE_NOLFS', 23: 'SQLITE_AUTH', 24: 'SQLITE_FORMAT',
  25: 'SQLITE_RANGE', 26: 'SQLITE_NOTADB', 27: 'SQLITE_NOTICE', 28: 'SQLITE_WARNING'
});

// Node 22's experimental DatabaseSync does not expose the later isOpen and
// isTransaction accessors. The store owns its handle lifetime and tracks
// transaction scope itself, so retain those accessors when available without
// reopening the same ledger on every read or recursively missing nested state.
function databaseIsOpen(database) {
  if (!database) return false;
  // An accessor failure is not evidence that the handle is closed. Propagate
  // it so callers refuse instead of skipping close/reopen work on a guessed
  // state.
  if (typeof database.isOpen === 'boolean') return database.isOpen;
  return true;
}

function databaseIsTransaction(database) {
  if (!database) return false;
  // Likewise, a driver that cannot report transaction state must not be
  // treated as confidently outside a transaction.
  return typeof database.isTransaction === 'boolean' && database.isTransaction;
}

const PROJECTION_LEASE_SCHEMA = `
  CREATE TABLE audit_projection_lease (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    owner_id TEXT CHECK(owner_id IS NULL OR length(owner_id) BETWEEN 8 AND 200),
    token_hash TEXT CHECK(token_hash IS NULL OR (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*')),
    fence INTEGER NOT NULL CHECK(fence >= 0),
    expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
    CHECK((owner_id IS NULL AND token_hash IS NULL AND expires_at_ms IS NULL) OR
      (owner_id IS NOT NULL AND token_hash IS NOT NULL AND expires_at_ms IS NOT NULL))
  ) STRICT;
  INSERT INTO audit_projection_lease(singleton, owner_id, token_hash, fence, expires_at_ms, updated_at_ms)
    VALUES(1, NULL, NULL, 0, NULL, 0);
`;

// Exact action/target selectors are intentionally indexed rather than
// implemented as an ever-growing broker-side ledger scan.  The index is used
// only by the internal, bounded audit.findEvents() helper; it does not expose
// a broad audit browsing surface.
const EVENT_SELECTOR_INDEX_SCHEMA = `
  CREATE INDEX audit_events_action_target_sequence_idx
    ON audit_events(json_extract(event_json, '$.action'), json_extract(event_json, '$.target'), sequence);
`;

/* THE ONE AND ONLY EXACT-SELECTOR QUERY, hoisted so a test can EXPLAIN the query
 * production actually prepares.
 *
 * It used to be a template literal inline in findEvents(), unreachable from
 * outside. The suite therefore EXPLAINed a hand-copied TWIN written into the test
 * itself, which proves an index backs a query only the test contains. MEASURED:
 * wrapping both operands in CAST(... AS TEXT) -- which cannot use an expression
 * index -- took the real plan from
 *   SEARCH audit_events USING INDEX audit_events_action_target_sequence_idx
 * to
 *   SCAN audit_events
 * while returning byte-identical rows, so every functional assertion stayed green
 * and the EXPLAIN assertion went on planning the test's copy. The index this
 * index exists for could be lost with the suite fully green.
 *
 * Any edit to this string must keep it a shape the expression index above can
 * serve: the indexed expressions are the bare json_extract() calls, so wrapping
 * either operand in a function defeats it. */
const EVENT_SELECTOR_QUERY = `SELECT * FROM audit_events
      WHERE json_extract(event_json, '$.action') = ? AND json_extract(event_json, '$.target') = ?
      ORDER BY sequence LIMIT ?`;

const SCHEMA = `
  CREATE TABLE audit_keys (
    key_id TEXT PRIMARY KEY CHECK(length(key_id) BETWEEN 8 AND 200),
    algorithm TEXT NOT NULL CHECK(algorithm = 'ed25519'),
    public_key_pem TEXT NOT NULL CHECK(length(public_key_pem) BETWEEN 80 AND 10000),
    public_key_hash TEXT NOT NULL CHECK(length(public_key_hash) = 64 AND public_key_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
  ) STRICT;

  CREATE TABLE audit_events (
    sequence INTEGER PRIMARY KEY CHECK(sequence >= 1),
    event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 8 AND 200),
    occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
    event_json TEXT NOT NULL CHECK(json_valid(event_json) AND length(CAST(event_json AS BLOB)) BETWEEN 2 AND ${MAX_EVENT_BYTES}),
    previous_hash TEXT NOT NULL CHECK(length(previous_hash) = 64 AND previous_hash NOT GLOB '*[^0-9a-f]*'),
    event_hash TEXT NOT NULL UNIQUE CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
    key_id TEXT NOT NULL,
    signature TEXT NOT NULL CHECK(length(signature) BETWEEN 80 AND 120),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    FOREIGN KEY(key_id) REFERENCES audit_keys(key_id),
    CHECK((sequence = 1 AND previous_hash = '${ZERO_HASH}') OR sequence > 1)
  ) STRICT;
  CREATE INDEX audit_events_occurred_idx ON audit_events(occurred_at_ms, sequence);
  ${EVENT_SELECTOR_INDEX_SCHEMA}

  CREATE TABLE audit_sink_state (
    sink TEXT PRIMARY KEY CHECK(sink IN ('jsonl','text')),
    last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
    last_hash TEXT NOT NULL CHECK(length(last_hash) = 64 AND last_hash NOT GLOB '*[^0-9a-f]*'),
    failure_count INTEGER NOT NULL CHECK(failure_count >= 0),
    retry_at_ms INTEGER CHECK(retry_at_ms IS NULL OR retry_at_ms >= 0),
    last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= ${MAX_ERROR_LENGTH}),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
    CHECK((last_sequence = 0 AND last_hash = '${ZERO_HASH}') OR last_sequence > 0)
  ) STRICT;
  INSERT INTO audit_sink_state(sink, last_sequence, last_hash, failure_count, retry_at_ms, last_error, updated_at_ms)
    VALUES('jsonl', 0, '${ZERO_HASH}', 0, NULL, NULL, 0);
  INSERT INTO audit_sink_state(sink, last_sequence, last_hash, failure_count, retry_at_ms, last_error, updated_at_ms)
    VALUES('text', 0, '${ZERO_HASH}', 0, NULL, NULL, 0);

  CREATE TABLE audit_metadata (
    key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 200),
    value_json TEXT NOT NULL CHECK(json_valid(value_json) AND length(CAST(value_json AS BLOB)) BETWEEN 1 AND ${MAX_EVENT_BYTES}),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
  ) STRICT;

  ${PROJECTION_LEASE_SCHEMA}

  PRAGMA application_id = ${AUDIT_APPLICATION_ID};
  PRAGMA user_version = ${AUDIT_SCHEMA_VERSION};
`;

class AuditStoreError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'AuditStoreError';
    this.code = code;
    this.details = details;
  }
}

function auditError(code, message, details, cause) {
  return new AuditStoreError(code, message, details || {}, cause ? { cause } : {});
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw auditError('AUDIT_INVALID_ARGUMENT', `${label} must be a plain object.`, { field: label });
  }
  return value;
}

function assertInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw auditError('AUDIT_INVALID_ARGUMENT', `${label} must be an integer of at least ${minimum}.`, { field: label });
  }
  return value;
}

// A present-but-blank environment variable is treated as absent, matching
// TOOLSENABLED_AUDIT_DB's own convention below. A present, non-blank value is
// validated by the caller via assertInteger so a typo fails closed at open()
// rather than silently keeping the built-in default.
function environmentInteger(name) {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : undefined;
}

function assertIdentifier(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw auditError('AUDIT_INVALID_ARGUMENT', `${label} is invalid.`, { field: label });
  }
  return value;
}

function canonicalJson(value) {
  const seen = new Set();
  function encode(entry, inArray = false, depth = 0) {
    if (depth > 32) throw auditError('AUDIT_JSON_INVALID', 'Audit event nesting exceeds 32 levels.');
    if (entry === null) return 'null';
    if (entry === undefined) return inArray ? 'null' : undefined;
    if (typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw auditError('AUDIT_JSON_INVALID', 'Audit events may contain only finite numbers.');
      return JSON.stringify(entry);
    }
    if (typeof entry !== 'object' || typeof entry.toJSON === 'function') {
      throw auditError('AUDIT_JSON_INVALID', 'Audit events must be JSON-compatible values.');
    }
    if (seen.has(entry)) throw auditError('AUDIT_JSON_INVALID', 'Circular audit events are not supported.');
    seen.add(entry);
    let output;
    if (Array.isArray(entry)) {
      output = `[${Array.from({ length: entry.length }, (_, index) => encode(entry[index], true, depth + 1)).join(',')}]`;
    } else {
      if (Object.getPrototypeOf(entry) !== Object.prototype) {
        seen.delete(entry);
        throw auditError('AUDIT_JSON_INVALID', 'Audit event objects must use the ordinary object prototype.');
      }
      output = `{${Object.keys(entry).sort().flatMap(key => {
        const encoded = encode(entry[key], false, depth + 1);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      }).join(',')}}`;
    }
    seen.delete(entry);
    return output;
  }
  const json = encode(value);
  if (json === undefined) throw auditError('AUDIT_JSON_INVALID', 'The audit event may not be undefined.');
  if (Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES) {
    throw auditError('AUDIT_EVENT_TOO_LARGE', `Audit events may not exceed ${MAX_EVENT_BYTES} bytes.`);
  }
  return json;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ONE SYSCALL, NOT A WALK OF EVERY PATH COMPONENT.
//
// fs.realpathSync is implemented in JavaScript and lstat()s each component of
// the path in turn; fs.realpathSync.native hands the whole question to the
// operating system in one call. They return the same string for the ledger,
// and this file asks the question often: _storeIdentity() runs on every
// _verificationFingerprint(), and one record() reaches that roughly eight
// times -- to verify, to compare before against after, to advance the cache.
//
// MEASURED 2026-09-03 on the owner's machine, against the live ledger path:
// 0.62 ms per JavaScript call against 0.12 ms per native call. That is about
// 4.4 ms off every audit record, twice per consequential tool call, for no
// change in what the identity witnesses: the same file, still paired with the
// same dev/ino/size/mtime/ctime from the same stat, still fail-closed on
// anything but ENOENT.
//
// THE STRING CAN DIFFER, AND THAT IS SAFE HERE FOR ONE SPECIFIC REASON. On
// Windows the component walk leaves an 8.3 short name in place while the
// native call expands it, so the same ledger under %TEMP% resolves to
// ...\SHORTNM~2\... one way and ...	he-full-profile-name\... the other. Both name
// the same file -- same dev, same ino -- and the native form is the more
// faithful of the two. What makes the difference inert is that this value
// never leaves the process: it is folded into stableDigest, coreDigest,
// snapshotDigest and digest, and every one of those is only ever compared
// against a fingerprint this same store instance took earlier. Nothing writes
// one to disk, sends one to another process, or reads one back across a
// restart, so no stored or shared value has to agree with it.
//
// RESOLVED AT CALL TIME, NEVER CAPTURED AT LOAD. Hoisting this into a module
// constant broke tests/kernel.audit/audit-store.js's identity-could-not-look
// case immediately: it proves the EMFILE path fails closed by replacing
// fs.realpathSync, and a captured reference sails straight past the
// replacement. Reading the property on each call keeps that fault injection
// working -- a substitute that carries no `.native` simply becomes the
// resolver -- and matches how the rest of this function already reaches fs.
function resolveRealPath(file) {
  const native = fs.realpathSync.native;
  return typeof native === 'function' ? native(file) : fs.realpathSync(file);
}

// AN OBJECT THIS FUNCTION HAS ALREADY DEEP-FROZEN NEVER NEEDS WALKING AGAIN.
//
// _rememberVerification() freezes the whole verification result, and
// `result.events` is the entire live window: ~10,000 row objects, each with a
// nested event object carrying its own details object. The `seen` set was
// per-call, so every remembered verification re-walked and re-froze roughly
// 30,000 objects that were already frozen -- measured on the owner's ledger at
// 20-29 ms per record, which is most of a warm tool call now that the O(N)
// signature walk is gone.
//
// The incremental path builds its next result as `[...priorEvents, actual]`, so
// all but one of those objects are the SAME objects the previous pass froze.
// Remembering them across calls turns the walk into one lookup each: measured
// 20.3 ms on the first pass and 0.3-0.5 ms on every pass after it.
//
// The memo is module-level and weak, so it holds nothing alive and needs no
// invalidation -- a frozen object can never become unfrozen, which is what
// makes skipping it sound. It deliberately records only what THIS function
// froze rather than testing Object.isFrozen(): an object frozen elsewhere may
// still have unfrozen children, and inferring depth from a shallow flag is the
// kind of shortcut that would silently stop freezing the details payload.
const deepFrozen = new WeakSet();

function freezeDeep(value, seen = deepFrozen) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function sameDigest(left, right) {
  return Boolean(left && right && left.digest === right.digest);
}

function sqliteErrorCode(error) {
  if (!error) return null;
  const errcode = Number(error.errcode);
  if (Number.isSafeInteger(errcode) && errcode > 0) {
    // Extended SQLite result codes retain their primary code in the low byte;
    // SQLITE_BUSY_SNAPSHOT (517), for example, is still SQLITE_BUSY.
    return SQLITE_PRIMARY_CODES[errcode & 0xff] || `SQLITE_ERRCODE_${errcode}`;
  }
  if (typeof error.code === 'string' && /^SQLITE_[A-Z0-9_]+$/.test(error.code)) return error.code;
  const message = String(error.message || '');
  if (/database is busy/i.test(message)) return 'SQLITE_BUSY';
  if (/database is locked/i.test(message)) return 'SQLITE_LOCKED';
  return null;
}

function sqliteBusy(error) {
  const code = sqliteErrorCode(error);
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

function sqliteErrorDetails(error) {
  const sqliteCode = sqliteErrorCode(error);
  return sqliteCode ? { sqliteCode } : {};
}

// A DELIBERATE AUDIT CLASSIFICATION SURVIVES THE TRANSACTION WRAPPER.
//
// Callbacks run inside _transaction()/_readTransaction() include the audit
// layer's own integrity checks, which throw errors carrying an AUDIT_* code
// precisely so a caller can tell "this is audit-integrity evidence, alarm"
// apart from "a busy or locked database" without pattern-matching text.
// Relabeling those as AUDIT_SQLITE_ERROR / "The audit ledger rejected a
// transaction." destroyed exactly the classification they were created to
// carry: on 2026-08-10 an AUDIT_ANCHOR_INTEGRITY_ALARM raised inside
// withProjectionLock() reached every tool as a generic transaction rejection,
// and three separate investigations spent the day chasing SQLITE_BUSY
// contention that was never happening. The cause chain did preserve the
// original, but nothing on the surface read it.
//
// The pass-through is narrow on purpose: only an Error that carries an AUDIT_*
// code AND shows no SQLite signal at all. A genuine busy/locked failure always
// carries a SQLite code and still becomes AUDIT_SQLITE_ERROR exactly as before.
function preservesClassification(error) {
  if (!(error instanceof Error)) return false;
  if (typeof error.code !== 'string' || !/^AUDIT_[A-Z0-9_]+$/.test(error.code)) return false;
  return sqliteErrorCode(error) === null;
}

function waitSynchronously(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ensureWalMode(db, busyTimeoutMs, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const wait = dependencies.wait || (milliseconds => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  });
  let mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  if (mode === 'wal') return mode;
  const deadline = now() + busyTimeoutMs;
  while (mode !== 'wal' && now() < deadline) {
    try { mode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode; }
    catch (error) { if (!sqliteBusy(error)) throw error; }
    if (mode === 'wal') break;
    // SQLite may report the unchanged mode instead of throwing BUSY. Yield in
    // both cases so a competing first opener can finish the one-time switch.
    wait(10);
    try { mode = db.prepare('PRAGMA journal_mode').get().journal_mode; }
    catch (error) { if (!sqliteBusy(error)) throw error; }
  }
  return mode;
}

function publicKeyHash(publicKeyPem) {
  let key;
  try { key = crypto.createPublicKey(publicKeyPem); }
  catch (error) { throw auditError('AUDIT_KEY_INVALID', 'The audit public key is invalid.', {}, error); }
  if (key.asymmetricKeyType !== 'ed25519') throw auditError('AUDIT_KEY_INVALID', 'Audit signing keys must use Ed25519.');
  return { key, hash: sha256(key.export({ type: 'spki', format: 'der' })) };
}

function eventHashInput({ sequence, eventId, occurredAtMs, eventJson, previousHash, keyId, createdAtMs }) {
  return Buffer.from(canonicalJson({
    domain: 'toolsenabled.audit.event.v1', sequence, eventId, occurredAtMs,
    event: JSON.parse(eventJson), previousHash, keyId, createdAtMs
  }), 'utf8');
}

function decodeSignature(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw auditError('AUDIT_SIGNATURE_INVALID', 'The audit signature must be a base64 string or Buffer.');
  }
  return Buffer.from(value, 'base64');
}

function databaseFingerprint(db) {
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  return sha256(JSON.stringify(rows.map(row => [
    row.type, row.name, row.tbl_name, String(row.sql).replace(/\s+/g, ' ').trim()
  ])));
}

let expectedFingerprintValue;
function expectedFingerprint() {
  if (expectedFingerprintValue) return expectedFingerprintValue;
  const db = openDatabaseSync(':memory:', { allowExtension: false, enableForeignKeyConstraints: true });
  try {
    db.exec(SCHEMA);
    expectedFingerprintValue = databaseFingerprint(db);
    return expectedFingerprintValue;
  } finally { db.close(); }
}

let expectedV2FingerprintValue;
function expectedV2Fingerprint() {
  if (expectedV2FingerprintValue) return expectedV2FingerprintValue;
  const db = openDatabaseSync(':memory:', { allowExtension: false, enableForeignKeyConstraints: true });
  try {
    db.exec(SCHEMA);
    db.exec('DROP INDEX audit_events_action_target_sequence_idx; PRAGMA user_version = 2;');
    expectedV2FingerprintValue = databaseFingerprint(db);
    return expectedV2FingerprintValue;
  } finally { db.close(); }
}

let expectedLegacyFingerprintValue;
function expectedLegacyFingerprint() {
  if (expectedLegacyFingerprintValue) return expectedLegacyFingerprintValue;
  const db = openDatabaseSync(':memory:', { allowExtension: false, enableForeignKeyConstraints: true });
  try {
    db.exec(SCHEMA);
    // v1 predated both the projection lease (v2) and the exact-selector
    // index (v3).  Preserve its actual DDL fingerprint rather than deriving
    // a false legacy shape from the current schema.
    db.exec('DROP INDEX audit_events_action_target_sequence_idx; DROP TABLE audit_projection_lease; PRAGMA user_version = 1;');
    expectedLegacyFingerprintValue = databaseFingerprint(db);
    return expectedLegacyFingerprintValue;
  } finally { db.close(); }
}

function rowEvent(row) {
  if (!row) return null;
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    occurredAtMs: row.occurred_at_ms,
    event: JSON.parse(row.event_json),
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    keyId: row.key_id,
    signature: row.signature,
    createdAtMs: row.created_at_ms
  };
}

function rowSink(row, headSequence) {
  return {
    sink: row.sink,
    lastSequence: row.last_sequence,
    lastHash: row.last_hash,
    failureCount: row.failure_count,
    retryAtMs: row.retry_at_ms,
    lastError: row.last_error,
    updatedAtMs: row.updated_at_ms,
    backlog: Math.max(0, headSequence - row.last_sequence),
    aheadOfHead: row.last_sequence > headSequence
  };
}

function rowProjectionLease(row, now) {
  return {
    ownerId: row.owner_id,
    fence: row.fence,
    expiresAtMs: row.expires_at_ms,
    updatedAtMs: row.updated_at_ms,
    held: row.owner_id !== null && row.expires_at_ms > now,
    expired: row.owner_id !== null && row.expires_at_ms <= now
  };
}

class AuditStore {
  constructor(options = {}) {
    assertPlainObject(options, 'options');
    const environmentPath = typeof process.env.TOOLSENABLED_AUDIT_DB === 'string' && process.env.TOOLSENABLED_AUDIT_DB.trim()
      ? process.env.TOOLSENABLED_AUDIT_DB.trim() : undefined;
    const selected = options.file === undefined ? (environmentPath || DEFAULT_AUDIT_DB) : options.file;
    if (typeof selected !== 'string' || !selected || selected.length > 4096) throw auditError('AUDIT_INVALID_ARGUMENT', 'file is invalid.', { field: 'file' });
    this.file = selected === ':memory:' ? selected : path.resolve(selected);
    this._auditGeneration = maintenance.generation(this.file);
    // busyTimeoutMs/transactionRetryMs were already caller-overridable options
    // (bb8dd98); this adds an operator-facing environment override at the
    // same defaulting point so a contended write can be bounded to fail fast
    // into the existing emergency-spool path instead of blocking the whole
    // process for up to ~65s under sustained concurrent tool-call load (see
    // docs/coordinator/R1162-AUDIT-CONTENTION-REPORT.md). Both defaults are
    // unchanged, so behavior does not change unless one is configured.
    const environmentBusyTimeoutMs = environmentInteger('TOOLSENABLED_AUDIT_BUSY_TIMEOUT_MS');
    const environmentTransactionRetryMs = environmentInteger('TOOLSENABLED_AUDIT_TRANSACTION_RETRY_MS');
    this.busyTimeoutMs = options.busyTimeoutMs !== undefined
      ? assertInteger(options.busyTimeoutMs, 'busyTimeoutMs', 1)
      : environmentBusyTimeoutMs !== undefined
        ? assertInteger(environmentBusyTimeoutMs, 'TOOLSENABLED_AUDIT_BUSY_TIMEOUT_MS', 1)
        : DEFAULT_BUSY_TIMEOUT_MS;
    this.transactionRetryMs = options.transactionRetryMs !== undefined
      ? assertInteger(options.transactionRetryMs, 'transactionRetryMs')
      : environmentTransactionRetryMs !== undefined
        ? assertInteger(environmentTransactionRetryMs, 'TOOLSENABLED_AUDIT_TRANSACTION_RETRY_MS')
        : DEFAULT_TRANSACTION_RETRY_MS;
    this.clock = options.clock || (() => Date.now());
    if (typeof this.clock !== 'function') throw auditError('AUDIT_INVALID_ARGUMENT', 'clock must be a function.', { field: 'clock' });
    this._db = null;
    this._projectionDb = null;
    this._transactionActive = false;
    this._storeInstanceId = crypto.randomUUID();
    this._mutationEpoch = 0;
    this._verificationCache = null;
    this._lastTrustedVerification = null;
    this._verificationStats = {
      fullVerifications: 0, cacheHits: 0, cacheMisses: 0,
      cacheInvalidations: 0, cacheAdvances: 0, cacheRebinds: 0, incrementalVerifications: 0, lastResult: null
    };
    this._open();
  }

  _now() {
    const raw = this.clock();
    return assertInteger(raw instanceof Date ? raw.getTime() : Number(raw), 'clock result');
  }

  _invalidateVerificationCache() {
    this._mutationEpoch += 1;
    this._verificationCache = null;
    this._verificationStats.cacheInvalidations += 1;
  }

  _storeIdentity() {
    if (this.file === ':memory:') {
      return { reliable: true, value: { kind: 'memory', instanceId: this._storeInstanceId } };
    }
    const absolute = path.resolve(this.file);
    try {
      const realpath = resolveRealPath(absolute);
      const stat = fs.statSync(absolute);
      const numberOrNull = value => Number.isSafeInteger(value) ? value : null;
      return {
        reliable: Boolean(realpath && Number.isSafeInteger(stat.size) && Number.isFinite(stat.mtimeMs)
          && Number.isFinite(stat.ctimeMs)),
        value: {
          kind: 'file', path: absolute, realpath,
          dev: numberOrNull(stat.dev), ino: numberOrNull(stat.ino),
          size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs
        }
      };
    } catch (error) {
      // ENOENT really does mean that the pathname has no identity to inspect.
      // Resource exhaustion and I/O failures do not: treating (for example)
      // EMFILE as the same "unavailable" value lets verification continue with
      // a guessed identity. Refuse explicitly, and discard any previously
      // latched trust so a later retry must establish the identity again.
      if (!error || error.code !== 'ENOENT') {
        this._clearVerificationTrust();
        throw auditError('AUDIT_STORE_IDENTITY_UNAVAILABLE',
          'The audit store identity could not be inspected; this does not claim that the store is absent.',
          { systemCode: error && typeof error.code === 'string' ? error.code : null }, error);
      }
      return { reliable: false, value: { kind: 'file', path: absolute, unavailable: true } };
    }
  }

  // `boundary`, when supplied, must already be caller-verified -- see the note
  // on _verifySnapshot's own boundary parameter. It is folded into `stable`
  // (not just `fingerprint`) so it reaches every one of stableDigest, coreDigest,
  // snapshotDigest and digest through the existing spreads below, with no
  // separate line needed at each. That matters because those four digests are
  // exactly what trustedVerificationMatches, rebindVerificationCache,
  // advanceVerificationCache and the cache-hit check in _verifyWithCache compare
  // against a PRIOR fingerprint: if the boundary moves (an archive roll
  // advances it) between one call and the next, stable now differs, so every one
  // of those comparisons fails closed and re-verifies -- a cached result from
  // before a roll can never be extended or reused as if the roll never
  // happened, without a single boundary-specific branch in any of them.
  _verificationFingerprint(db, external, boundary = null) {
    const identity = this._storeIdentity();
    const schema = {
      applicationId: db.prepare('PRAGMA application_id').get().application_id,
      schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      ddlDigest: databaseFingerprint(db)
    };
    const keyRows = db.prepare(`SELECT key_id, algorithm, public_key_pem, public_key_hash, created_at_ms
      FROM audit_keys ORDER BY key_id`).all().map(row => ({
      keyId: row.key_id, algorithm: row.algorithm, publicKeyPem: row.public_key_pem,
      publicKeyHash: row.public_key_hash, createdAtMs: row.created_at_ms
    }));
    const sinkRows = db.prepare(`SELECT sink, last_sequence, last_hash, failure_count,
      retry_at_ms, last_error, updated_at_ms FROM audit_sink_state ORDER BY sink`).all().map(row => ({
      sink: row.sink, lastSequence: row.last_sequence, lastHash: row.last_hash,
      failureCount: row.failure_count, retryAtMs: row.retry_at_ms,
      lastError: row.last_error, updatedAtMs: row.updated_at_ms
    }));
    const head = db.prepare('SELECT sequence, event_hash, key_id FROM audit_events ORDER BY sequence DESC LIMIT 1').get() || null;
    const dataVersion = db.prepare('PRAGMA data_version').get().data_version;
    const stable = {
      store: identity.value,
      schema,
      keySetDigest: sha256(canonicalJson(keyRows)),
      boundary: boundary ? { archivedThroughSequence: boundary.archivedThroughSequence, eventHash: boundary.eventHash } : null
    };
    const fingerprint = {
      version: 1,
      stable,
      dataVersion,
      mutationEpoch: this._mutationEpoch,
      head: head ? { sequence: head.sequence, hash: head.event_hash, keyId: head.key_id } : {
        sequence: 0, hash: ZERO_HASH, keyId: null
      },
      sinkDigest: sha256(canonicalJson(sinkRows)),
      external: external === undefined ? null : external
    };
    // PRAGMA data_version is connection-global and can advance while this
    // connection retains a consistent WAL read snapshot. It remains part of
    // the cross-call cache digest, but not the within-snapshot stability
    // digest used before/after one verification transaction.
    const snapshotStore = stable.store && stable.store.kind === 'file'
      ? {
          kind: stable.store.kind,
          path: stable.store.path,
          realpath: stable.store.realpath,
          dev: stable.store.dev,
          ino: stable.store.ino
        }
      : stable.store;
    const snapshotFingerprint = {
      version: fingerprint.version,
      stable: { ...fingerprint.stable, store: snapshotStore },
      mutationEpoch: fingerprint.mutationEpoch,
      head: fingerprint.head,
      sinkDigest: fingerprint.sinkDigest,
      external: fingerprint.external
    };
    const coreFingerprint = { ...fingerprint, external: null };
    return {
      cacheable: identity.reliable && external !== undefined && Boolean(external && external.cacheable !== false),
      fingerprint,
      stableDigest: sha256(canonicalJson(stable)),
      coreDigest: sha256(canonicalJson(coreFingerprint)),
      snapshotDigest: sha256(canonicalJson(snapshotFingerprint)),
      digest: sha256(canonicalJson(fingerprint))
    };
  }

  _rememberVerification(fingerprint, result, { cache = true } = {}) {
    const frozen = freezeDeep(result);
    const trusted = { fingerprint, result: frozen, token: {} };
    this._lastTrustedVerification = trusted;
    this._verificationCache = cache && fingerprint.cacheable ? trusted : null;
    return frozen;
  }

  _clearVerificationTrust() {
    this._verificationCache = null;
    this._lastTrustedVerification = null;
  }

  _open() {
    maintenance.assertAvailable(this.file, this._auditGeneration);
    if (databaseIsOpen(this._db)) return this._db;
    if (this.file !== ':memory:') ensureDir(path.dirname(this.file));
    let db;
    try {
      db = openDatabaseSync(this.file, {
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
      // Reasserting WAL on every process open requests a schema/write lock,
      // even when the database is already in WAL mode.  That serialized every
      // short-lived audit writer and could starve durable-task checkpoints behind
      // unrelated launch-record traffic.  Steady-state opens stay read-only;
      // only a database that is not yet WAL performs the mode transition.
      const mode = this.file === ':memory:'
        ? db.prepare('PRAGMA journal_mode').get().journal_mode
        : ensureWalMode(db, this.busyTimeoutMs);
      if (this.file !== ':memory:' && mode !== 'wal') throw auditError('AUDIT_WAL_UNAVAILABLE', 'The audit ledger could not enable WAL mode.', { journalMode: mode });
      db.exec(`PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${this.busyTimeoutMs};`);
      this._migrateAndValidate();
      return db;
    } catch (error) {
      if (databaseIsOpen(db)) { try { db.close(); } catch { /* retain original */ } }
      this._db = null;
      if (error instanceof AuditStoreError) throw error;
      throw auditError('AUDIT_SQLITE_ERROR', 'The audit ledger could not be opened.', sqliteErrorDetails(error), error);
    }
  }

  _migrateAndValidate() {
    const db = this._db;
    // The overwhelmingly common path is an already-current canonical ledger.
    // Do not take BEGIN IMMEDIATE merely to discover that no migration is
    // needed: doing so turns every new CLI/process into a write-lock waiter.
    // WAL readers can validate the stable schema while another process owns a
    // legitimate append/projection transaction.
    const observedApplicationId = db.prepare('PRAGMA application_id').get().application_id;
    const observedVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (observedApplicationId === AUDIT_APPLICATION_ID && observedVersion === AUDIT_SCHEMA_VERSION) {
      this._validateSchema();
      if (db.prepare('PRAGMA foreign_key_check').all().length) {
        throw auditError('AUDIT_SCHEMA_INVALID', 'The audit ledger has invalid foreign-key references.');
      }
      return;
    }
    let transactionStarted = false;
    this._beginImmediate(db);
    transactionStarted = true;
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const applicationId = db.prepare('PRAGMA application_id').get().application_id;
      if (applicationId !== 0 && applicationId !== AUDIT_APPLICATION_ID) {
        throw auditError('AUDIT_DATABASE_IDENTITY', 'The configured audit path belongs to another SQLite application.', { applicationId });
      }
      if (version > AUDIT_SCHEMA_VERSION) throw auditError('AUDIT_SCHEMA_TOO_NEW', 'The audit schema is newer than this build.', { version, supported: AUDIT_SCHEMA_VERSION });
      if (version === 0) db.exec(SCHEMA);
      else if (version === 1) {
        if (databaseFingerprint(db) !== expectedLegacyFingerprint()) {
          throw auditError('AUDIT_SCHEMA_INVALID', 'The audit v1 DDL fingerprint does not match the supported migration source.');
        }
        db.exec(`${PROJECTION_LEASE_SCHEMA} ${EVENT_SELECTOR_INDEX_SCHEMA} PRAGMA user_version = ${AUDIT_SCHEMA_VERSION};`);
      } else if (version === 2) {
        if (databaseFingerprint(db) !== expectedV2Fingerprint()) {
          throw auditError('AUDIT_SCHEMA_INVALID', 'The audit v2 DDL fingerprint does not match the supported migration source.');
        }
        db.exec(`${EVENT_SELECTOR_INDEX_SCHEMA} PRAGMA user_version = ${AUDIT_SCHEMA_VERSION};`);
      } else if (version !== AUDIT_SCHEMA_VERSION) throw auditError('AUDIT_SCHEMA_UNSUPPORTED', 'The audit schema cannot be upgraded by this build.', { version });
      this._validateSchema();
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw auditError('AUDIT_SCHEMA_INVALID', 'The audit ledger has invalid foreign-key references.');
      this._executeBusyRetry(db, 'COMMIT', Date.now() + this.transactionRetryMs);
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted || databaseIsTransaction(db)) db.exec('ROLLBACK');
      throw error;
    }
  }

  _validateSchema() {
    const db = this._db;
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (applicationId !== AUDIT_APPLICATION_ID) throw auditError('AUDIT_DATABASE_IDENTITY', 'The audit database application identity is invalid.', { applicationId });
    if (version !== AUDIT_SCHEMA_VERSION) throw auditError('AUDIT_SCHEMA_INVALID', 'The audit schema version is invalid.', { version });
    if (databaseFingerprint(db) !== expectedFingerprint()) throw auditError('AUDIT_SCHEMA_INVALID', 'The audit DDL fingerprint does not match this schema version.');
    const sinks = db.prepare('SELECT * FROM audit_sink_state ORDER BY sink').all();
    if (sinks.length !== 2 || sinks[0].sink !== 'jsonl' || sinks[1].sink !== 'text') {
      throw auditError('AUDIT_SCHEMA_INVALID', 'The audit sink singleton rows are invalid.');
    }
    if (db.prepare('SELECT COUNT(*) AS count FROM audit_projection_lease WHERE singleton = 1').get().count !== 1) {
      throw auditError('AUDIT_SCHEMA_INVALID', 'The audit projection lease singleton row is invalid.');
    }
  }

  _executeBusyRetry(db, statement, deadline) {
    let delayMs = 5;
    for (;;) {
      try {
        db.exec(statement);
        return;
      } catch (error) {
        const remainingMs = deadline - Date.now();
        if (!sqliteBusy(error) || remainingMs <= 0) throw error;
        waitSynchronously(Math.min(delayMs, remainingMs));
        delayMs = Math.min(delayMs * 2, 100);
      }
    }
  }

  // THE WRITER LOCK WAS NOT MERELY CONTENDED, IT WAS STARVING WAITERS OUTRIGHT.
  //
  // Measured 2026-08-12 on an 8000-event ledger with 2 and 4 resident writer
  // processes looping audit.record(): ONE process performed 100% of the calls
  // and every other process completed ZERO in a 20 s window -- per-worker
  // counts [0, 106] at two workers and [0, 0, 106, 0] at four. Total
  // throughput went DOWN as workers were added (9.1 -> 4.6 -> 3.8 calls/s),
  // which is not contention, it is a livelock in the acquisition path.
  //
  // The mechanism is SQLite's own busy handler. `timeout:` on the connection
  // (60 s by default here) makes db.exec('BEGIN IMMEDIATE') block INSIDE the
  // driver, where sqlite3_busy_timeout sleeps on an escalating schedule that
  // saturates at 100 ms. Because it never returns SQLITE_BUSY within that
  // window, the store's own _executeBusyRetry loop above never ran at all for
  // an acquisition -- it was unreachable code on the default configuration.
  // A holder finishes its ~120 ms of in-lock work, commits, does ~70 ms of
  // out-of-lock work, and re-acquires; a waiter parked in a 100 ms driver
  // sleep misses that ~70 ms window essentially every time, forever.
  //
  // The fix is to take the waiting back from the driver: narrow the busy
  // timeout to a short acquisition slice so BUSY is returned promptly, then
  // poll from here on a small, JITTERED backoff whose cap sits well below the
  // holder's out-of-lock gap. Jitter matters as much as the cap -- competing
  // processes that back off on identical deterministic schedules re-collide in
  // lockstep. Math.random is correct here and is not a security choice: this
  // decides nothing, it only decorrelates two sleeps.
  //
  // THE TOTAL WAIT BUDGET IS DELIBERATELY UNCHANGED. Today's effective budget
  // for an acquisition is busyTimeoutMs (the driver's block), not
  // transactionRetryMs (which was never consulted), so the deadline below is
  // the larger of the two. A caller that configures a short busyTimeoutMs to
  // fail fast into the emergency spool -- the R1162 operator override, and
  // what tests/kernel.audit/audit-contention.js pins -- keeps exactly the
  // behaviour it had.
  _beginImmediate(db) {
    const slice = Math.max(1, Math.min(this.busyTimeoutMs, WRITER_ACQUIRE_SLICE_MS));
    const deadline = Date.now() + Math.max(this.transactionRetryMs, this.busyTimeoutMs);
    let delayMs = 1;
    try {
      db.exec(`PRAGMA busy_timeout=${slice}`);
      for (;;) {
        try {
          db.exec('BEGIN IMMEDIATE');
          return;
        } catch (error) {
          const remainingMs = deadline - Date.now();
          if (!sqliteBusy(error) || remainingMs <= 0) throw error;
          const jittered = Math.max(1, Math.round(delayMs * (0.5 + Math.random())));
          waitSynchronously(Math.min(jittered, remainingMs));
          delayMs = Math.min(delayMs * 2, WRITER_RETRY_CAP_MS);
        }
      }
    } finally {
      // Restore the configured timeout for the statements that run inside the
      // transaction. A failure to restore leaves the connection's execution
      // policy unknown, so refuse rather than continuing with the acquisition
      // outcome as though the configured timeout were in force.
      db.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs}`);
    }
  }

  _transaction(callback) {
    const db = this._open();
    if (this._transactionActive || databaseIsTransaction(db)) {
      throw auditError('AUDIT_TRANSACTION_NESTED', 'Nested audit transactions are not supported.');
    }
    let transactionStarted = false;
    this._transactionActive = true;
    try {
      this._beginImmediate(db);
      transactionStarted = true;
      maintenance.assertAvailable(this.file, this._auditGeneration);
      const value = callback(db);
      if (value && typeof value.then === 'function') throw auditError('AUDIT_TRANSACTION_ASYNC', 'Audit transactions must be synchronous.');
      this._executeBusyRetry(db, 'COMMIT', Date.now() + this.transactionRetryMs);
      transactionStarted = false;
      return value;
    } catch (error) {
      if (transactionStarted || databaseIsTransaction(db)) db.exec('ROLLBACK');
      if (error instanceof AuditStoreError) throw error;
      if (preservesClassification(error)) throw error;
      throw auditError('AUDIT_SQLITE_ERROR', 'The audit ledger rejected a transaction.', sqliteErrorDetails(error), error);
    } finally {
      this._transactionActive = false;
    }
  }

  _readTransaction(callback) {
    const db = this._open();
    if (this._transactionActive || databaseIsTransaction(db)) {
      throw auditError('AUDIT_TRANSACTION_NESTED', 'Nested audit transactions are not supported.');
    }
    let transactionStarted = false;
    this._transactionActive = true;
    try {
      this._executeBusyRetry(db, 'BEGIN DEFERRED', Date.now() + this.transactionRetryMs);
      transactionStarted = true;
      const value = callback(db);
      if (value && typeof value.then === 'function') throw auditError('AUDIT_TRANSACTION_ASYNC', 'Audit transactions must be synchronous.');
      this._executeBusyRetry(db, 'COMMIT', Date.now() + this.transactionRetryMs);
      transactionStarted = false;
      return value;
    } catch (error) {
      if (transactionStarted || databaseIsTransaction(db)) db.exec('ROLLBACK');
      if (error instanceof AuditStoreError) throw error;
      if (preservesClassification(error)) throw error;
      throw auditError('AUDIT_SQLITE_ERROR', 'The audit ledger rejected a read transaction.', sqliteErrorDetails(error), error);
    } finally {
      this._transactionActive = false;
    }
  }

  registerKey({ keyId, publicKeyPem, createdAtMs } = {}) {
    keyId = assertIdentifier(keyId, 'keyId', KEY_ID_PATTERN);
    if (typeof publicKeyPem !== 'string') throw auditError('AUDIT_KEY_INVALID', 'publicKeyPem must be a string.');
    const normalized = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'pem' }).toString();
    const inspected = publicKeyHash(normalized);
    const now = createdAtMs === undefined ? this._now() : assertInteger(createdAtMs, 'createdAtMs');
    // RE-REGISTERING THE KEY THAT IS ALREADY THERE IS NOT A WRITE.
    //
    // audit.prepare() calls registerSigner() -> registerKey() on EVERY entry,
    // so every single record() opened a BEGIN IMMEDIATE -- the ledger's one
    // cross-process writer lock -- purely to re-read a row that has not
    // changed since the installation was created, and then commit nothing.
    // Measured 2026-08-12, that was a whole exclusive acquisition per record
    // on top of the append's own, taken before the append and released
    // immediately, which is pure serialization for zero state change.
    //
    // The fast path is a plain read and is only taken when the row is already
    // byte-identical to what is being registered. It cannot lose the
    // check-and-insert atomicity that matters: registered key material is
    // immutable (a differing row raises AUDIT_KEY_CONFLICT rather than being
    // updated), so "identical row already present" is a stable answer that
    // cannot be invalidated by a concurrent writer. Anything else -- absent,
    // or present with different material -- falls through to the transaction
    // below, which re-reads under the lock and decides there exactly as before.
    const existing = this._open().prepare('SELECT public_key_pem, public_key_hash FROM audit_keys WHERE key_id = ?').get(keyId);
    if (existing && existing.public_key_hash === inspected.hash && existing.public_key_pem === normalized) {
      return { keyId, publicKeyHash: inspected.hash, replayed: true };
    }
    return this._transaction(db => {
      const prior = db.prepare('SELECT * FROM audit_keys WHERE key_id = ?').get(keyId);
      if (prior) {
        if (prior.public_key_hash !== inspected.hash || prior.public_key_pem !== normalized) {
          throw auditError('AUDIT_KEY_CONFLICT', 'The audit key ID is already registered with different key material.', { keyId });
        }
        return { keyId, publicKeyHash: inspected.hash, replayed: true };
      }
      db.prepare(`INSERT INTO audit_keys(key_id, algorithm, public_key_pem, public_key_hash, created_at_ms)
        VALUES(?, 'ed25519', ?, ?, ?)`).run(keyId, normalized, inspected.hash, now);
      this._invalidateVerificationCache();
      return { keyId, publicKeyHash: inspected.hash, replayed: false };
    });
  }

  appendEvent(input = {}, signer = {}) {
    assertPlainObject(input, 'event input');
    assertPlainObject(signer, 'signer');
    const eventId = assertIdentifier(input.eventId, 'eventId', EVENT_ID_PATTERN);
    const occurredAtMs = assertInteger(input.occurredAtMs, 'occurredAtMs');
    const eventJson = canonicalJson(assertPlainObject(input.event, 'event'));
    const keyId = assertIdentifier(signer.keyId, 'signer.keyId', KEY_ID_PATTERN);
    if (typeof signer.sign !== 'function') throw auditError('AUDIT_INVALID_ARGUMENT', 'signer.sign must be a synchronous function.', { field: 'signer.sign' });
    const operation = db => {
      const prior = db.prepare('SELECT * FROM audit_events WHERE event_id = ?').get(eventId);
      if (prior) {
        if (prior.occurred_at_ms !== occurredAtMs || prior.event_json !== eventJson || prior.key_id !== keyId) {
          throw auditError('AUDIT_EVENT_CONFLICT', 'The audit event ID was replayed with different content.', { eventId });
        }
        return { event: rowEvent(prior), replayed: true };
      }
      const keyRow = db.prepare('SELECT * FROM audit_keys WHERE key_id = ?').get(keyId);
      if (!keyRow) throw auditError('AUDIT_KEY_NOT_FOUND', 'The audit signing key is not registered.', { keyId });
      const head = db.prepare('SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1').get();
      const sequence = head ? head.sequence + 1 : 1;
      const previousHash = head ? head.event_hash : ZERO_HASH;
      const createdAtMs = input.createdAtMs === undefined ? this._now() : assertInteger(input.createdAtMs, 'createdAtMs');
      const signingInput = eventHashInput({ sequence, eventId, occurredAtMs, eventJson, previousHash, keyId, createdAtMs });
      const eventHash = sha256(signingInput);
      let rawSignature;
      try { rawSignature = signer.sign(Buffer.from(eventHash, 'hex')); }
      catch (error) { throw auditError('AUDIT_SIGNING_FAILED', 'The audit event could not be signed.', { keyId }, error); }
      if (rawSignature && typeof rawSignature.then === 'function') throw auditError('AUDIT_SIGNING_FAILED', 'The audit signer must be synchronous.', { keyId });
      const signatureBytes = decodeSignature(rawSignature);
      const publicKey = crypto.createPublicKey(keyRow.public_key_pem);
      if (!crypto.verify(null, Buffer.from(eventHash, 'hex'), publicKey, signatureBytes)) {
        throw auditError('AUDIT_SIGNATURE_INVALID', 'The audit signer does not match the registered public key.', { keyId });
      }
      const signature = signatureBytes.toString('base64');
      db.prepare(`INSERT INTO audit_events(sequence, event_id, occurred_at_ms, event_json, previous_hash,
        event_hash, key_id, signature, created_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        sequence, eventId, occurredAtMs, eventJson, previousHash, eventHash, keyId, signature, createdAtMs
      );
      this._invalidateVerificationCache();
      return { event: rowEvent(db.prepare('SELECT * FROM audit_events WHERE sequence = ?').get(sequence)), replayed: false };
    };
    return this._projectionDb ? operation(this._projectionDb) : this._transaction(operation);
  }

  getEvent(selector = {}) {
    assertPlainObject(selector, 'selector');
    let row;
    if (selector.sequence !== undefined) row = this._open().prepare('SELECT * FROM audit_events WHERE sequence = ?').get(assertInteger(selector.sequence, 'sequence', 1));
    else if (selector.eventId !== undefined) row = this._open().prepare('SELECT * FROM audit_events WHERE event_id = ?').get(assertIdentifier(selector.eventId, 'eventId', EVENT_ID_PATTERN));
    else throw auditError('AUDIT_INVALID_ARGUMENT', 'Select an audit event by sequence or eventId.');
    return rowEvent(row);
  }

  listEvents({ afterSequence = 0, limit = 100 } = {}) {
    afterSequence = assertInteger(afterSequence, 'afterSequence');
    limit = assertInteger(limit, 'limit', 1);
    if (limit > 1000) throw auditError('AUDIT_INVALID_ARGUMENT', 'limit may not exceed 1000.', { field: 'limit' });
    const db = this._projectionDb || this._open();
    return db.prepare('SELECT * FROM audit_events WHERE sequence > ? ORDER BY sequence LIMIT ?').all(afterSequence, limit).map(rowEvent);
  }

  // This is deliberately a narrow, bounded internal selector.  action and
  // target are both exact bound parameters, result count is capped, and the
  // schema-owned expression index keeps it usable after the ledger grows past
  // the old 10,000-event broker scan ceiling.
  findEvents({ action, target, limit = 100 } = {}) {
    if (typeof action !== 'string' || !action || action.length > 160) {
      throw auditError('AUDIT_INVALID_ARGUMENT', 'event action selector is invalid.', { field: 'action' });
    }
    if (typeof target !== 'string' || !target || target.length > 240) {
      throw auditError('AUDIT_INVALID_ARGUMENT', 'event target selector is invalid.', { field: 'target' });
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw auditError('AUDIT_INVALID_ARGUMENT', 'event limit selector is invalid.', { field: 'limit' });
    }
    const db = this._projectionDb || this._open();
    return db.prepare(EVENT_SELECTOR_QUERY).all(action, target, limit).map(rowEvent);
  }

  head() {
    return rowEvent((this._projectionDb || this._open()).prepare('SELECT * FROM audit_events ORDER BY sequence DESC LIMIT 1').get());
  }

  getKey(keyId) {
    keyId = assertIdentifier(keyId, 'keyId', KEY_ID_PATTERN);
    const row = this._open().prepare('SELECT * FROM audit_keys WHERE key_id = ?').get(keyId);
    return row ? {
      keyId: row.key_id, algorithm: row.algorithm, publicKeyPem: row.public_key_pem,
      publicKeyHash: row.public_key_hash, createdAtMs: row.created_at_ms
    } : null;
  }

  markSinkSuccess({ sink, sequence, eventHash: expectedHash, updatedAtMs } = {}) {
    if (!SINKS.includes(sink)) throw auditError('AUDIT_INVALID_ARGUMENT', 'sink must be jsonl or text.', { field: 'sink' });
    sequence = assertInteger(sequence, 'sequence', 1);
    if (!HASH_PATTERN.test(expectedHash || '')) throw auditError('AUDIT_INVALID_ARGUMENT', 'eventHash must be a SHA-256 digest.', { field: 'eventHash' });
    const now = updatedAtMs === undefined ? this._now() : assertInteger(updatedAtMs, 'updatedAtMs');
    const operation = db => {
      const state = db.prepare('SELECT * FROM audit_sink_state WHERE sink = ?').get(sink);
      if (sequence === state.last_sequence) {
        if (state.last_hash !== expectedHash) throw auditError('AUDIT_SINK_CONFLICT', 'The sink cursor hash conflicts with its replay.', { sink, sequence });
        return rowSink(state, this._headSequence(db));
      }
      if (sequence !== state.last_sequence + 1) throw auditError('AUDIT_SINK_GAP', 'Sink cursors must advance one event at a time.', { sink, expected: state.last_sequence + 1, actual: sequence });
      const event = db.prepare('SELECT event_hash FROM audit_events WHERE sequence = ?').get(sequence);
      if (!event || event.event_hash !== expectedHash) throw auditError('AUDIT_SINK_CONFLICT', 'The sink cursor does not match the canonical event.', { sink, sequence });
      db.prepare(`UPDATE audit_sink_state SET last_sequence = ?, last_hash = ?, failure_count = 0,
        retry_at_ms = NULL, last_error = NULL, updated_at_ms = ? WHERE sink = ?`).run(sequence, expectedHash, now, sink);
      this._invalidateVerificationCache();
      return rowSink(db.prepare('SELECT * FROM audit_sink_state WHERE sink = ?').get(sink), this._headSequence(db));
    };
    return this._projectionDb ? operation(this._projectionDb) : this._transaction(operation);
  }

  markSinkFailure({ sink, error = 'Audit sink write failed.', retryAtMs, updatedAtMs } = {}) {
    if (!SINKS.includes(sink)) throw auditError('AUDIT_INVALID_ARGUMENT', 'sink must be jsonl or text.', { field: 'sink' });
    if (typeof error !== 'string') error = String(error);
    error = error.slice(0, MAX_ERROR_LENGTH);
    const now = updatedAtMs === undefined ? this._now() : assertInteger(updatedAtMs, 'updatedAtMs');
    const retry = retryAtMs === undefined ? null : assertInteger(retryAtMs, 'retryAtMs');
    const operation = db => {
      db.prepare(`UPDATE audit_sink_state SET failure_count = failure_count + 1, retry_at_ms = ?,
        last_error = ?, updated_at_ms = ? WHERE sink = ?`).run(retry, error, now, sink);
      this._invalidateVerificationCache();
      return rowSink(db.prepare('SELECT * FROM audit_sink_state WHERE sink = ?').get(sink), this._headSequence(db));
    };
    return this._projectionDb ? operation(this._projectionDb) : this._transaction(operation);
  }

  setSinkPosition({ sink, sequence, eventHash: expectedHash, updatedAtMs } = {}) {
    if (!SINKS.includes(sink)) throw auditError('AUDIT_INVALID_ARGUMENT', 'sink must be jsonl or text.', { field: 'sink' });
    sequence = assertInteger(sequence, 'sequence');
    const expected = sequence === 0 ? ZERO_HASH : expectedHash;
    if (!HASH_PATTERN.test(expected || '')) throw auditError('AUDIT_INVALID_ARGUMENT', 'eventHash must be a SHA-256 digest.', { field: 'eventHash' });
    const now = updatedAtMs === undefined ? this._now() : assertInteger(updatedAtMs, 'updatedAtMs');
    const operation = db => {
      if (sequence > 0) {
        const event = db.prepare('SELECT event_hash FROM audit_events WHERE sequence = ?').get(sequence);
        if (!event || event.event_hash !== expected) throw auditError('AUDIT_SINK_CONFLICT', 'The sink position does not match a canonical event.', { sink, sequence });
      }
      db.prepare(`UPDATE audit_sink_state SET last_sequence = ?, last_hash = ?, failure_count = 0,
        retry_at_ms = NULL, last_error = NULL, updated_at_ms = ? WHERE sink = ?`).run(sequence, expected, now, sink);
      this._invalidateVerificationCache();
      return rowSink(db.prepare('SELECT * FROM audit_sink_state WHERE sink = ?').get(sink), this._headSequence(db));
    };
    return this._projectionDb ? operation(this._projectionDb) : this._transaction(operation);
  }

  getMetadata(key) {
    if (typeof key !== 'string' || !key || key.length > 200) throw auditError('AUDIT_INVALID_ARGUMENT', 'metadata key is invalid.', { field: 'key' });
    const row = (this._projectionDb || this._open()).prepare('SELECT value_json, updated_at_ms FROM audit_metadata WHERE key = ?').get(key);
    return row ? { key, value: JSON.parse(row.value_json), updatedAtMs: row.updated_at_ms } : null;
  }

  setMetadata(key, value, updatedAtMs) {
    if (typeof key !== 'string' || !key || key.length > 200) throw auditError('AUDIT_INVALID_ARGUMENT', 'metadata key is invalid.', { field: 'key' });
    const valueJson = canonicalJson(value);
    const now = updatedAtMs === undefined ? this._now() : assertInteger(updatedAtMs, 'updatedAtMs');
    const operation = db => {
      db.prepare(`INSERT INTO audit_metadata(key, value_json, updated_at_ms) VALUES(?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`).run(key, valueJson, now);
      this._invalidateVerificationCache();
      return { key, value: JSON.parse(valueJson), updatedAtMs: now };
    };
    return this._projectionDb ? operation(this._projectionDb) : this._transaction(operation);
  }

  // ROLL EXACTLY ONE EVENT OUT OF THE LIVE LEDGER, IN THE ONLY SAFE ORDER.
  //
  // The audit ledger is unbounded today -- 1,527 events/day measured, ~557,000
  // after a year -- and every short-lived process pays a full verification of
  // all of it. Bounding it is the fix, and bounding it means the oldest event
  // physically leaves this table. That is the single most dangerous operation
  // in the whole audit system, so the ordering is enforced here structurally
  // rather than left to a comment in a caller:
  //
  //   1. select the oldest row, under the writer lock
  //   2. run every guard below
  //   3. hand the row to `persist`, which must durably write it to cold storage
  //      AND record the new signed boundary
  //   4. ONLY THEN delete the row
  //
  // `persist` throwing, or this transaction rolling back, leaves the event in
  // BOTH places -- duplicated, still fully verifiable, recoverable. The reverse
  // order (delete first, write after) can lose an audit event permanently on a
  // crash, which is not a tradeoff worth any amount of speed. Same reasoning as
  // the jsonl/text projections' append-then-mark ordering in audit.js.
  //
  // The signing itself is in-memory (the private key is already loaded), so no
  // powershell.exe vault process runs inside the lock -- the budget
  // tests/audit-lock-scope.test.js polices.
  rollOldestEventOut({ nowMs, minimumRetained = 1 } = {}, persist) {
    if (typeof persist !== 'function') {
      throw auditError('AUDIT_INVALID_ARGUMENT', 'rollOldestEventOut requires a persist callback.', { field: 'persist' });
    }
    const retain = assertInteger(minimumRetained, 'minimumRetained');
    if (retain < 1) throw auditError('AUDIT_INVALID_ARGUMENT', 'minimumRetained must be at least 1.', { field: 'minimumRetained' });
    const now = nowMs === undefined ? this._now() : assertInteger(nowMs, 'nowMs');
    const operation = db => {
      const total = db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count;
      // NEVER empty the ledger. An empty audit_events with a boundary claiming
      // everything was archived is indistinguishable from total destruction of
      // the live table, and leaves nothing for the chain to be rooted against.
      if (total <= retain) return { rolled: false, reason: 'window-not-exceeded', total };
      const row = db.prepare('SELECT * FROM audit_events ORDER BY sequence ASC LIMIT 1').get();
      if (!row) return { rolled: false, reason: 'empty-ledger', total };

      // A sink that has not yet projected this event can never catch up once
      // the event leaves the live table -- there would be nothing left to
      // re-project from. _verifySnapshot reports exactly this as
      // 'sink-behind-boundary'; refusing here is what stops that state from
      // being created in the first place.
      const sinks = db.prepare('SELECT sink, last_sequence FROM audit_sink_state ORDER BY sink').all();
      for (const sink of sinks) {
        if (sink.last_sequence < row.sequence) {
          return { rolled: false, reason: 'sink-behind', sink: sink.sink, sinkSequence: sink.last_sequence, sequence: row.sequence, total };
        }
      }

      // Durable write + boundary FIRST. Anything this throws aborts the
      // transaction with the row still present.
      //
      // `_projectionDb` is published for the callback's duration exactly as
      // withProjectionLock does, so the setMetadata() that records the new
      // boundary joins THIS transaction instead of trying to open its own and
      // dying on the AUDIT_TRANSACTION_NESTED guard. That is not a convenience:
      // it is what makes the delete and the boundary commit or roll back
      // together. A boundary written in a separate transaction could survive a
      // rolled-back delete, leaving the ledger claiming an event was archived
      // while it is still live -- or the reverse.
      const previousProjectionDb = this._projectionDb;
      this._projectionDb = db;
      try {
        persist(Object.freeze({
          sequence: row.sequence, eventId: row.event_id, occurredAtMs: row.occurred_at_ms,
          eventJson: row.event_json, previousHash: row.previous_hash, eventHash: row.event_hash,
          keyId: row.key_id, signature: row.signature, createdAtMs: row.created_at_ms
        }), this, now);
      } catch (error) {
        // SAY WHAT ACTUALLY BROKE.
        //
        // _transaction rewrites any error lacking an AUDIT_* code as
        // AUDIT_SQLITE_ERROR / "The audit ledger rejected a transaction"
        // (preservesClassification). A full disk or a read-only archive
        // directory would therefore reach the operator as a ledger fault --
        // sending them to debug SQLite while the real cause is storage. Same
        // erasure already fixed for the head anchor's two throws today.
        //
        // The rollback is unaffected either way; this only preserves the
        // diagnosis. The original error is kept as `cause`.
        if (preservesClassification(error)) throw error;
        throw auditError('AUDIT_ARCHIVE_WRITE_FAILED',
          'The audit archive could not be written, so no event was removed from the ledger.',
          { sequence: row.sequence }, error);
      } finally {
        this._projectionDb = previousProjectionDb;
      }

      const deleted = db.prepare('DELETE FROM audit_events WHERE sequence = ?').run(row.sequence);
      if (Number(deleted.changes) !== 1) {
        throw auditError('AUDIT_ARCHIVE_ROLL_FAILED', 'The archive roll did not remove exactly one event.', { sequence: row.sequence, changes: Number(deleted.changes) });
      }
      this._invalidateVerificationCache();
      return { rolled: true, sequence: row.sequence, eventHash: row.event_hash, total: total - 1 };
    };
    return this._projectionDb ? operation(this._projectionDb) : this._transaction(operation);
  }

  // RUN SEVERAL APPENDS UNDER ONE COMMIT, WHICH IS ONE fsync.
  //
  // appendEvent() opens its own BEGIN IMMEDIATE/COMMIT when no outer
  // transaction is published, and the ledger runs `PRAGMA synchronous=FULL`
  // in WAL mode, so every COMMIT is a real fsync of the WAL.
  //
  // MEASURED 2026-09-03 (win32, node v22.14.0, 200-record emergency-spool
  // drain): 206 BEGIN / 206 COMMIT for 200 records, 1112-1347 ms of flush,
  // 5.56-6.74 ms per record, of which 1.39-1.81 ms per record was time
  // inside COMMIT itself. The same 200 appends under one transaction cost
  // one COMMIT.
  //
  // This is a COST seam, not a durability seam, and it is deliberately
  // narrower than withProjectionLock: it takes no projection lease and
  // changes no lease fence, because a batch of appends is not a claim on
  // projection ownership. What it does is exactly what the retention roll
  // already does a few lines up -- publish `_projectionDb` for the
  // callback's duration so the appendEvent() calls inside join THIS
  // transaction instead of opening their own and dying on the
  // AUDIT_TRANSACTION_NESTED guard.
  //
  // DURABILITY IS UNCHANGED, AND THE FAIL-CLOSED PROPERTY IS THE REASON THE
  // BATCH IS SAFE RATHER THAN AN EXCEPTION TO IT:
  //   - The chain still links inside the batch. Each appendEvent() re-reads
  //     the head from `db`, and rows this transaction has already inserted
  //     are visible to it, so sequence and previous_hash advance exactly as
  //     they do across separate transactions.
  //   - A crash mid-batch commits NOTHING from that batch -- SQLite rolls
  //     the whole transaction back. Compared with per-record commits, that
  //     is strictly less partial state, never more. It is safe only because
  //     every caller here drives an idempotent, re-drainable source and
  //     retires that source AFTER the commit, so a rolled-back batch is
  //     re-applied rather than lost.
  //   - Nothing observable escapes the batch early: the callback's writes
  //     become visible to other processes only at COMMIT, which is where
  //     they became visible before.
  //
  // The batch is a transaction, so it is all-or-nothing. A caller that needs
  // per-record survival across a failure must size its batches accordingly
  // rather than assume partial application.
  withAppendBatch(callback) {
    if (typeof callback !== 'function') throw auditError('AUDIT_INVALID_ARGUMENT', 'append batch callback must be a function.', { field: 'callback' });
    // An outer transaction is already published (a projection lock, a
    // retention roll). Joining it is correct and is what a nested batch
    // means; opening a second one would be refused by the nesting guard.
    if (this._projectionDb) return callback(this);
    return this._transaction(db => {
      const previousProjectionDb = this._projectionDb;
      this._projectionDb = db;
      try {
        const result = callback(this);
        if (result && typeof result.then === 'function') {
          throw auditError('AUDIT_TRANSACTION_ASYNC', 'The append batch callback must be synchronous.');
        }
        return result;
      } finally {
        this._projectionDb = previousProjectionDb;
      }
    });
  }

  projectionLease(nowMs) {
    const now = nowMs === undefined ? this._now() : assertInteger(nowMs, 'nowMs');
    return rowProjectionLease(this._open().prepare('SELECT * FROM audit_projection_lease WHERE singleton = 1').get(), now);
  }

  withProjectionLock({ ownerId, nowMs } = {}, callback) {
    ownerId = assertIdentifier(ownerId, 'ownerId', EVENT_ID_PATTERN);
    if (typeof callback !== 'function') throw auditError('AUDIT_INVALID_ARGUMENT', 'projection callback must be a function.', { field: 'callback' });
    const now = nowMs === undefined ? this._now() : assertInteger(nowMs, 'nowMs');
    return this._transaction(db => {
      const prior = db.prepare('SELECT * FROM audit_projection_lease WHERE singleton = 1').get();
      const fence = prior.fence + 1;
      const tokenHash = sha256(crypto.randomBytes(32));
      db.prepare(`UPDATE audit_projection_lease SET owner_id = ?, token_hash = ?, fence = ?,
        expires_at_ms = ?, updated_at_ms = ? WHERE singleton = 1`).run(ownerId, tokenHash, fence, Number.MAX_SAFE_INTEGER, now);
      this._projectionDb = db;
      try {
        const result = callback(this, { ownerId, fence, acquired: true });
        if (result && typeof result.then === 'function') {
          throw auditError('AUDIT_TRANSACTION_ASYNC', 'The projection callback must be synchronous.');
        }
        db.prepare(`UPDATE audit_projection_lease SET owner_id = NULL, token_hash = NULL,
          expires_at_ms = NULL, updated_at_ms = ? WHERE singleton = 1`).run(now);
        return result;
      } finally {
        this._projectionDb = null;
      }
    });
  }

  _headSequence(db = this._open()) {
    return db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM audit_events').get().sequence;
  }

  _status(db, now = this._now()) {
    const head = rowEvent(db.prepare('SELECT * FROM audit_events ORDER BY sequence DESC LIMIT 1').get());
    const headSequence = head ? head.sequence : 0;
    return {
      ok: true,
      path: this.file,
      schemaVersion: AUDIT_SCHEMA_VERSION,
      applicationId: AUDIT_APPLICATION_ID,
      headSequence,
      headHash: head ? head.eventHash : ZERO_HASH,
      headKeyId: head ? head.keyId : null,
      keys: db.prepare('SELECT key_id AS keyId, public_key_hash AS publicKeyHash, created_at_ms AS createdAtMs FROM audit_keys ORDER BY created_at_ms, key_id').all(),
      sinks: Object.fromEntries(db.prepare('SELECT * FROM audit_sink_state ORDER BY sink').all().map(row => [row.sink, rowSink(row, headSequence)])),
      projectionLease: rowProjectionLease(db.prepare('SELECT * FROM audit_projection_lease WHERE singleton = 1').get(), now)
    };
  }

  status() {
    return this._projectionDb ? this._status(this._projectionDb) : this._readTransaction(db => this._status(db));
  }

  // `boundary`, when supplied, must ALREADY have had its signature verified by
  // the caller against vault-supplied key material. See the note at the chain
  // root below for why this is a parameter rather than a read.
  _verifySnapshot(db, boundary = null) {
    const rows = db.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
    const keys = new Map(db.prepare('SELECT * FROM audit_keys').all().map(row => [row.key_id, row]));
    // publicKeyHash() already parses each PEM into a KeyObject to compute its
    // hash; keep that parsed object instead of re-parsing the same PEM again
    // for every single event row below. Same key material, same verification
    // result, just no redundant per-row crypto.createPublicKey() calls on a
    // ledger that can hold thousands of entries.
    const keyObjects = new Map();
    for (const key of keys.values()) {
      let inspected;
      try { inspected = publicKeyHash(key.public_key_pem); }
      catch { return { verification: { valid: false, entries: rows.length, reason: 'public-key' }, events: rows.map(rowEvent) }; }
      if (key.algorithm !== 'ed25519' || key.public_key_hash !== inspected.hash) {
        return { verification: { valid: false, entries: rows.length, reason: 'public-key-hash', keyId: key.key_id }, events: rows.map(rowEvent) };
      }
      // A KEY ROW MUST NOT BE ABLE TO VOUCH FOR ITSELF.
      //
      // The check above only proves the row is SELF-consistent: public_key_hash
      // and public_key_pem are both columns in the same attacker-writable table,
      // so rewriting the pair consistently satisfies it. Nothing else here tied
      // a registered key to the material that actually signed the history.
      //
      // key_id does tie them, because audit.js:348-355 derives it as
      // `audit-ed25519-${sha256(spki der)}` -- the same digest publicKeyHash()
      // returns -- and key_id is committed inside every single event_hash. So
      // requiring the id to match the material makes every historical event
      // transitively bind to real key bytes, through a check that runs on every
      // pass rather than one that can be checkpointed away.
      //
      // Without it: swap public_key_pem + public_key_hash consistently under an
      // existing key_id and no event hash changes, the chain still recomputes,
      // and forged APPENDS then verify against the substituted key.
      //
      // Conditional on the derived prefix, deliberately. Injected signers use
      // ids of other shapes (tests/audit-error-classification.test.js mints
      // `audit-test-<uuid>`), and those are in-process doubles, not a tampering
      // surface. The rule enforced is narrower and exactly right: a key that
      // CLAIMS the derived form must actually be that material.
      if (key.key_id.startsWith('audit-ed25519-') && key.key_id !== `audit-ed25519-${inspected.hash}`) {
        return { verification: { valid: false, entries: rows.length, reason: 'public-key-identity', keyId: key.key_id }, events: rows.map(rowEvent) };
      }
      keyObjects.set(key.key_id, inspected.key);
    }
    // WHERE THE CHAIN IS ROOTED, AND WHY THAT IS A PARAMETER.
    //
    // With no boundary this is genesis -- sequence 1 chained to ZERO_HASH --
    // which is byte-for-byte today's behaviour and the only behaviour any
    // caller can currently produce, because nothing mints a boundary yet.
    //
    // A boundary exists so the oldest events can be moved to signed cold
    // storage without the live ledger losing its root. It says "everything up
    // to sequence M has been archived, and event M hashed to H", so the live
    // rows start at M+1 chaining to H instead of at 1 chaining to zeros.
    //
    // IT IS A PARAMETER, NOT A READ. _verifySnapshot deliberately does not
    // fetch this from audit_metadata itself: a boundary is only meaningful once
    // its signature has been checked against vault-supplied key material, and a
    // function that read its own root out of the very database it is auditing
    // would be trusting the surface it exists to check. The caller verifies,
    // then passes. An unverified or absent boundary must arrive here as null and
    // fall back to genesis -- never as "trust whatever the table says".
    //
    // Front-truncation stays detectable, which is the property this must not
    // cost: deleting the oldest live rows leaves rows[0].sequence above M+1 and
    // fails the sequence check below; forging a matching boundary needs the
    // signing key; and dropping the archive segment breaks its digest.
    const rooted = boundary
      ? { sequence: boundary.archivedThroughSequence, hash: boundary.eventHash }
      : { sequence: 0, hash: ZERO_HASH };
    let previousHash = rooted.hash;
    let expectedSequence = rooted.sequence + 1;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.sequence !== expectedSequence) return { verification: { valid: false, entries: rows.length, invalidSequence: expectedSequence, reason: 'sequence-gap' }, events: rows.map(rowEvent) };
      expectedSequence += 1;
      if (row.previous_hash !== previousHash) return { verification: { valid: false, entries: rows.length, invalidSequence: row.sequence, reason: 'previous-hash' }, events: rows.map(rowEvent) };
      const key = keys.get(row.key_id);
      if (!key) return { verification: { valid: false, entries: rows.length, invalidSequence: row.sequence, reason: 'missing-key' }, events: rows.map(rowEvent) };
      let expectedHash;
      try {
        if (canonicalJson(JSON.parse(row.event_json)) !== row.event_json) {
          return { verification: { valid: false, entries: rows.length, invalidSequence: row.sequence, reason: 'event-json-canonical' }, events: rows.map(rowEvent) };
        }
        expectedHash = sha256(eventHashInput({
          sequence: row.sequence, eventId: row.event_id, occurredAtMs: row.occurred_at_ms,
          eventJson: row.event_json, previousHash: row.previous_hash, keyId: row.key_id, createdAtMs: row.created_at_ms
        }));
      } catch {
        return { verification: { valid: false, entries: rows.length, invalidSequence: row.sequence, reason: 'event-json' }, events: rows.map(rowEvent) };
      }
      if (row.event_hash !== expectedHash) return { verification: { valid: false, entries: rows.length, invalidSequence: row.sequence, reason: 'event-hash' }, events: rows.map(rowEvent) };
      let validSignature = false;
      try {
        validSignature = crypto.verify(null, Buffer.from(row.event_hash, 'hex'), keyObjects.get(row.key_id), Buffer.from(row.signature, 'base64'));
      } catch { validSignature = false; }
      if (!validSignature) return { verification: { valid: false, entries: rows.length, invalidSequence: row.sequence, reason: 'signature' }, events: rows.map(rowEvent) };
      previousHash = row.event_hash;
    }
    const status = this._status(db);
    for (const sink of Object.values(status.sinks)) {
      if (sink.aheadOfHead) return { verification: { valid: false, entries: rows.length, invalidSequence: rooted.sequence + rows.length + 1, reason: 'sink-ahead-of-head', sink: sink.sink }, events: rows.map(rowEvent), status };
      if (sink.lastSequence > 0) {
        // rows[0] is sequence rooted.sequence + 1, not necessarily 1, so the
        // offset has to be relative to the root. Without a boundary
        // rooted.sequence is 0 and this is the original `lastSequence - 1`.
        const offset = sink.lastSequence - rooted.sequence - 1;
        if (offset < 0) {
          // The sink cursor sits at or below the archive boundary. Exactly AT it
          // is legitimate -- the projection is complete through the last
          // archived event -- and the boundary's own hash is what it must match.
          // BELOW it is not: the projection would be missing events that are no
          // longer in the live ledger to re-project from, so it can never catch
          // up on its own. Fail closed and say which, rather than reporting the
          // undefined row lookup this used to produce as a generic sink-hash.
          if (sink.lastSequence === rooted.sequence && sink.lastHash === rooted.hash) continue;
          return { verification: { valid: false, entries: rows.length, invalidSequence: sink.lastSequence, reason: 'sink-behind-boundary', sink: sink.sink }, events: rows.map(rowEvent), status };
        }
        const projected = rows[offset];
        if (!projected || projected.event_hash !== sink.lastHash) {
          return { verification: { valid: false, entries: rows.length, invalidSequence: sink.lastSequence, reason: 'sink-hash', sink: sink.sink }, events: rows.map(rowEvent), status };
        }
      }
    }
    return { verification: {
      valid: true, entries: rows.length, headSequence: status.headSequence,
      headHash: status.headHash, headKeyId: status.headKeyId, signaturesValid: true, sinks: status.sinks
    }, events: rows.map(rowEvent), status };
  }

  // INCREMENTAL VERIFICATION FROM A TRUSTED HEAD.
  //
  // MEASURED 2026-09-02 on an installed 1.0.41 with twelve agent processes
  // sharing one ledger: every tool call re-verified every row's signature,
  // because a sibling process had appended since this process last looked and
  // the cache only knew how to extend itself by this process's OWN append
  // (advanceVerificationCache). Each MCP server ran at half a core doing
  // nothing but that, the cost grew with the ledger, and the fleet page lagged.
  //
  // This extends the trusted prefix by the rows OTHER processes appended,
  // checked exactly as the full pass checks them: the trusted head row is
  // still the trusted head row, every new row continues the sequence and the
  // previous-hash chain from it, its JSON is canonical, its hash recomputes,
  // its signature verifies under a key whose identity matches its material,
  // and the sink cursors still name real hashes. The trust model is the one
  // the cache already had; only the number of events it can advance by
  // changed. Anything this cannot prove returns null and the caller pays the
  // full pass, which is also what names the failure reason.
  _verifyIncremental(db, cached, before, boundary = null) {
    const trusted = cached && cached.result && cached.result.verification;
    const priorFp = cached && cached.fingerprint && cached.fingerprint.fingerprint;
    if (!trusted || !trusted.valid || !priorFp || !before.fingerprint) return null;
    if (canonicalJson(priorFp.stable) !== canonicalJson(before.fingerprint.stable)) return null;
    const head = before.fingerprint.head;
    if (!head || head.sequence < trusted.headSequence) return null;
    const rooted = boundary
      ? { sequence: boundary.archivedThroughSequence, hash: boundary.eventHash }
      : { sequence: 0, hash: ZERO_HASH };
    const priorEvents = Array.isArray(cached.result.events) ? cached.result.events : null;
    if (!priorEvents || priorEvents.length !== trusted.headSequence - rooted.sequence) return null;
    if (trusted.headSequence > rooted.sequence) {
      const headRow = db.prepare('SELECT event_hash FROM audit_events WHERE sequence = ?').get(trusted.headSequence);
      if (!headRow || headRow.event_hash !== trusted.headHash) return null;
    } else if (trusted.headHash !== rooted.hash) {
      return null;
    }
    const rows = db.prepare('SELECT * FROM audit_events WHERE sequence > ? ORDER BY sequence').all(trusted.headSequence);
    const keys = new Map(db.prepare('SELECT * FROM audit_keys').all().map(row => [row.key_id, row]));
    const keyObjects = new Map();
    for (const key of keys.values()) {
      let inspected;
      try { inspected = publicKeyHash(key.public_key_pem); } catch { return null; }
      if (key.algorithm !== 'ed25519' || key.public_key_hash !== inspected.hash) return null;
      if (key.key_id.startsWith('audit-ed25519-') && key.key_id !== `audit-ed25519-${inspected.hash}`) return null;
      keyObjects.set(key.key_id, inspected.key);
    }
    // ANOTHER CONNECTION WROTE THE DATABASE, so the rows this process already
    // verified are re-proved by hash and chain (not by signature) before the
    // new rows are trusted to extend them. A rewritten event whose stored
    // hash was not recomputed fails here; one whose hash WAS recomputed
    // breaks the chain into the trusted head, which is checked above and
    // pinned by the vault anchor. Per-row signatures add nothing to that
    // once the head is anchored, and cost 1.7 s per pass on this ledger.
    if (priorFp.dataVersion !== before.fingerprint.dataVersion
        || priorFp.mutationEpoch !== before.fingerprint.mutationEpoch) {
      const prefix = db.prepare(`SELECT sequence, event_id, occurred_at_ms, event_json, previous_hash, event_hash, key_id, created_at_ms
        FROM audit_events WHERE sequence <= ? ORDER BY sequence`).all(trusted.headSequence);
      if (prefix.length !== priorEvents.length) return null;
      let chain = rooted.hash;
      let expected = rooted.sequence + 1;
      for (const row of prefix) {
        if (row.sequence !== expected || row.previous_hash !== chain) return null;
        expected += 1;
        let recomputed;
        try {
          recomputed = sha256(eventHashInput({
            sequence: row.sequence, eventId: row.event_id, occurredAtMs: row.occurred_at_ms,
            eventJson: row.event_json, previousHash: row.previous_hash, keyId: row.key_id, createdAtMs: row.created_at_ms
          }));
        } catch { return null; }
        if (row.event_hash !== recomputed) return null;
        chain = row.event_hash;
      }
      if (chain !== trusted.headHash) return null;
    }
    let previousHash = trusted.headHash;
    let expectedSequence = trusted.headSequence + 1;
    for (const row of rows) {
      if (row.sequence !== expectedSequence || row.previous_hash !== previousHash) return null;
      expectedSequence += 1;
      if (!keys.has(row.key_id)) return null;
      let expectedHash;
      try {
        if (canonicalJson(JSON.parse(row.event_json)) !== row.event_json) return null;
        expectedHash = sha256(eventHashInput({
          sequence: row.sequence, eventId: row.event_id, occurredAtMs: row.occurred_at_ms,
          eventJson: row.event_json, previousHash: row.previous_hash, keyId: row.key_id, createdAtMs: row.created_at_ms
        }));
      } catch { return null; }
      if (row.event_hash !== expectedHash) return null;
      let validSignature = false;
      try {
        validSignature = crypto.verify(null, Buffer.from(row.event_hash, 'hex'), keyObjects.get(row.key_id), Buffer.from(row.signature, 'base64'));
      } catch { validSignature = false; }
      if (!validSignature) return null;
      previousHash = row.event_hash;
    }
    if (head.sequence !== expectedSequence - 1 || head.hash !== previousHash) return null;
    const events = [...priorEvents, ...rows.map(rowEvent)];
    const status = this._status(db);
    if (status.headSequence !== head.sequence || status.headHash !== head.hash) return null;
    for (const sink of Object.values(status.sinks)) {
      if (sink.aheadOfHead) return null;
      if (sink.lastSequence > 0) {
        const offset = sink.lastSequence - rooted.sequence - 1;
        if (offset < 0) {
          if (sink.lastSequence === rooted.sequence && sink.lastHash === rooted.hash) continue;
          return null;
        }
        const projected = events[offset];
        if (!projected || projected.eventHash !== sink.lastHash) return null;
      }
    }
    return { verification: {
      valid: true, entries: events.length, headSequence: status.headSequence,
      headHash: status.headHash, headKeyId: status.headKeyId, signaturesValid: true, sinks: status.sinks
    }, events, status };
  }

  _sinkStateMatchesHead(db, status) {
    for (const sink of Object.values(status.sinks || {})) {
      if (!sink || sink.aheadOfHead || sink.lastSequence > status.headSequence) return false;
      if (sink.lastSequence > 0) {
        const event = db.prepare('SELECT event_hash FROM audit_events WHERE sequence = ?').get(sink.lastSequence);
        if (!event || event.event_hash !== sink.lastHash) return false;
      } else if (sink.lastHash !== ZERO_HASH) {
        return false;
      }
    }
    return true;
  }

  _externalProjectionStable(previous, next) {
    const left = previous && previous.fingerprint && previous.fingerprint.external;
    const right = next && next.fingerprint && next.fingerprint.external;
    return Boolean(left && right && left.projectionDigest === right.projectionDigest
      && left.emergencyDigest === right.emergencyDigest);
  }

  verificationCacheStatus() {
    const cached = this._verificationCache;
    const head = cached && cached.fingerprint && cached.fingerprint.fingerprint
      ? cached.fingerprint.fingerprint.head : null;
    const external = cached && cached.fingerprint && cached.fingerprint.fingerprint
      ? cached.fingerprint.fingerprint.external : null;
    const boundary = cached && cached.fingerprint && cached.fingerprint.fingerprint
      ? cached.fingerprint.fingerprint.stable.boundary : null;
    return {
      ...this._verificationStats,
      cached: Boolean(cached),
      cachedHead: head ? { sequence: head.sequence, hash: head.hash, keyId: head.keyId } : null,
      cachedExternal: external ? {
        anchor: external.anchor || null,
        projectionDigest: external.projectionDigest || null,
        emergencyDigest: external.emergencyDigest || null
      } : null,
      // Surfaced for operators, not consumed internally: what the cached
      // verification believes the live chain is rooted at, if anything.
      cachedBoundary: boundary,
      mutationEpoch: this._mutationEpoch
    };
  }

  invalidateVerificationCache() {
    this._clearVerificationTrust();
    this._verificationStats.cacheInvalidations += 1;
  }

  // Admission verifies the complete chain in a read transaction before it
  // competes for SQLite's single-writer lock. Once that lock is held, this
  // method is the fail-closed bridge between the two phases: only the exact
  // result object this store most recently produced as a valid verification
  // can match, and every fingerprint input must still be byte-for-byte the
  // same. An intervening append, historical-row/schema/key/sink mutation,
  // store-identity change, or external witness change returns false. It never
  // performs a replacement full verification while the caller holds the
  // writer transaction.
  trustedVerificationMatches({ prior, external, boundary = null } = {}) {
    const trusted = this._lastTrustedVerification;
    if (!trusted || trusted.result !== prior || !prior || !prior.verification
        || prior.verification.valid !== true) return false;
    const run = db => {
      const current = this._verificationFingerprint(db, external, boundary);
      if (!sameDigest(current, trusted.fingerprint)) {
        // LOSING THIS RACE INVALIDATES THE WITNESS, NOT THE PREFIX.
        //
        // The digest compared here is the FULL fingerprint, which folds in
        // PRAGMA data_version -- so any other connection's commit makes it
        // differ. That is exactly right as a race detector, and the admission
        // decision must still fail closed. But this used to call
        // _clearVerificationTrust(), which nulls the exact-witness token AND
        // the verification cache, and only the witness is stale.
        //
        // _verificationCache is the trusted prefix _verifyIncremental() extends,
        // and _verifyWithCache can only reach that path through it. Nulling it
        // meant the retry fell straight through to a full O(N) row read and
        // Ed25519 walk of every live event -- roughly 1.7 s per pass on a
        // 10,000-event ledger -- and then re-entered the same race with the same
        // odds, up to the 32-retry limit with no sleep between attempts. The
        // incremental path exists for precisely this case ("a sibling process
        // appended since this process last looked", see its header) and was
        // being destroyed at the exact moment it was needed.
        //
        // Keeping the cache changes what is RECOMPUTED, never what is PROVEN.
        // Every consumer re-proves it first: the cache-hit branch needs a full
        // digest match against a freshly read fingerprint, which a bumped
        // data_version cannot satisfy; and _verifyIncremental re-compares the
        // stable fingerprint, re-reads the trusted head row against its stored
        // hash, and -- exactly when dataVersion or mutationEpoch moved -- re-
        // chains and re-hashes the ENTIRE prefix before it will verify the new
        // rows. The head itself stays pinned by the vault anchor, and the
        // in-lock exact-witness check below is still what admits the append.
        this._lastTrustedVerification = null;
        return false;
      }
      this._lastTrustedVerification = trusted;
      return true;
    };
    return this._projectionDb ? run(this._projectionDb) : this._readTransaction(run);
  }

  rebindVerificationCache({ prior, external, boundary = null } = {}) {
    const trusted = this._lastTrustedVerification;
    if (!trusted || trusted.result !== prior || !prior || !prior.verification || prior.verification.valid !== true) {
      return false;
    }
    const run = db => {
      const current = this._verificationFingerprint(db, external, boundary);
      if (!current.cacheable || current.coreDigest !== trusted.fingerprint.coreDigest
          || !this._externalProjectionStable(trusted.fingerprint, current)) {
        this._clearVerificationTrust();
        return false;
      }
      this._rememberVerification(current, prior, { cache: true });
      this._verificationStats.cacheRebinds += 1;
      return true;
    };
    return this._projectionDb ? run(this._projectionDb) : this._readTransaction(run);
  }

  // `event` advances by one appended row; `events` (an ordered array) advances
  // by a whole admission batch in one read transaction. Both forms demand the
  // same thing of the ledger: the rows after the trusted head must be exactly
  // the events the caller says it appended, chained one to the next, and
  // nothing may follow them.
  advanceVerificationCache({ prior, event, events, external, boundary = null } = {}) {
    const trusted = this._lastTrustedVerification;
    const appendedEvents = Array.isArray(events) ? events : (event === undefined ? [] : [event]);
    if (!trusted || trusted.result !== prior || !prior || !prior.verification || prior.verification.valid !== true
        || appendedEvents.length === 0 || appendedEvents.some(item => !item || typeof item !== 'object')) return false;
    const base = trusted.fingerprint.fingerprint;
    const priorEvents = Array.isArray(prior.events) ? prior.events : [];
    // COUNT THE LIVE WINDOW, NOT THE ABSOLUTE HEAD.
    //
    // `prior.events` holds the rows the live ledger still has; `head.sequence`
    // is an absolute sequence that keeps counting through everything the
    // archive roll has already moved out. The two are equal only while
    // NOTHING has ever been archived, so comparing them directly made this
    // advance start failing the moment the first retention roll happened --
    // permanently, because the boundary only ever grows.
    //
    // The consequence was not a wrong answer, it was a silent cost: an append
    // invalidates this process's verification cache, this advance is what puts
    // it back, and once it always returned false every following record() fell
    // through to a full O(N) signature walk. Measured on the owner's install
    // (10,019 live rows, boundary 678): 1.7 s per record, ~2 records per tool
    // call. _verifyIncremental roots itself on the boundary for exactly this
    // reason (see its `rooted`); this is the same arithmetic, and the two must
    // agree or the cache is established by one and rejected by the other.
    const rootedSequence = boundary ? boundary.archivedThroughSequence : 0;
    if (priorEvents.length !== base.head.sequence - rootedSequence) return false;
    const run = db => {
      const current = this._verificationFingerprint(db, external, boundary);
      if (!current.cacheable || current.stableDigest !== trusted.fingerprint.stableDigest) {
        this._clearVerificationTrust();
        return false;
      }
      const actualRows = db.prepare('SELECT * FROM audit_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?')
        .all(base.head.sequence, appendedEvents.length + 1).map(rowEvent);
      // Exactly the appended rows must follow the trusted head: one fewer and
      // the append did not land, one more and another writer got in behind it.
      if (actualRows.length !== appendedEvents.length) {
        this._clearVerificationTrust();
        return false;
      }
      let expectedSequence = base.head.sequence;
      let expectedPreviousHash = base.head.hash;
      for (let index = 0; index < actualRows.length; index += 1) {
        const actual = actualRows[index];
        if (!actual || actual.sequence !== expectedSequence + 1 || actual.previousHash !== expectedPreviousHash) {
          this._clearVerificationTrust();
          return false;
        }
        try {
          if (canonicalJson(actual) !== canonicalJson(appendedEvents[index])) {
            this._clearVerificationTrust();
            return false;
          }
        } catch {
          this._clearVerificationTrust();
          return false;
        }
        expectedSequence = actual.sequence;
        expectedPreviousHash = actual.eventHash;
      }
      const actual = actualRows[actualRows.length - 1];
      const status = this._status(db);
      if (!this._sinkStateMatchesHead(db, status)) {
        this._clearVerificationTrust();
        return false;
      }
      const next = {
        verification: {
          valid: true, entries: priorEvents.length + actualRows.length,
          headSequence: actual.sequence, headHash: actual.eventHash, headKeyId: actual.keyId,
          signaturesValid: true, sinks: status.sinks
        },
        events: [...priorEvents, ...actualRows], status
      };
      const refreshed = this._verificationFingerprint(db, external, boundary);
      if (current.snapshotDigest !== refreshed.snapshotDigest) {
        this._clearVerificationTrust();
        return false;
      }
      this._rememberVerification(refreshed, next, { cache: true });
      this._verificationStats.cacheAdvances += 1;
      return true;
    };
    return this._projectionDb ? run(this._projectionDb) : this._readTransaction(run);
  }

  _verifyWithCache(db, external, uncached, boundary = null) {
    const before = this._verificationFingerprint(db, external, boundary);
    if (!uncached && before.cacheable && this._verificationCache
        && sameDigest(before, this._verificationCache.fingerprint)) {
      this._verificationStats.cacheHits += 1;
      this._verificationStats.lastResult = 'cache-hit';
      this._lastTrustedVerification = this._verificationCache;
      return this._verificationCache.result;
    }
    if (!uncached) this._verificationStats.cacheMisses += 1;
    let result = !uncached && before.cacheable && this._verificationCache
      ? this._verifyIncremental(db, this._verificationCache, before, boundary)
      : null;
    if (result) {
      this._verificationStats.incrementalVerifications += 1;
      this._verificationStats.lastResult = 'incremental';
    } else {
      this._verificationStats.fullVerifications += 1;
      this._verificationStats.lastResult = 'full';
      result = this._verifySnapshot(db, boundary);
    }
    if (!result.verification.valid) {
      this._clearVerificationTrust();
      return result;
    }
    const after = this._verificationFingerprint(db, external, boundary);
    if (before.snapshotDigest !== after.snapshotDigest) {
      this._clearVerificationTrust();
      return {
        ...result,
        verification: { ...result.verification, valid: false, reason: 'verification-state-changed' }
      };
    }
    // An uncached pass reads nothing from the cache; it still WRITES it. It is
    // the most complete verification this process can do, so it is the best
    // possible cache entry, and forgetting it instead was measured 2026-09-02
    // as the reason every audited tool call after a status report paid a full
    // signature pass over the whole ledger: system-status verify() nulled the
    // admission cache, the next record found no trusted head to extend, and
    // the cycle repeated on every status poll.
    return this._rememberVerification(after, result, { cache: true });
  }

  verifyWithEvents(options = {}) {
    const uncached = Boolean(options && options.uncached === true);
    const external = options && Object.prototype.hasOwnProperty.call(options, 'external')
      ? options.external : undefined;
    // `boundary` must already be caller-verified -- audit-store.js has no vault
    // access, so it cannot check a boundary's signature itself, and it must
    // never trust one unchecked. No current caller supplies one; every audit.js
    // call site still gets today's genesis-rooted behaviour until the archive
    // roll (which mints and verifies the boundary) is wired in.
    const boundary = options && options.boundary ? options.boundary : null;
    const run = db => this._verifyWithCache(db, external, uncached, boundary);
    return this._projectionDb ? run(this._projectionDb) : this._readTransaction(run);
  }

  verify() {
    return this.verifyWithEvents({ uncached: true }).verification;
  }

  integrity() {
    const db = this._open();
    const result = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]);
    const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check').all();
    return { ok: result.length === 1 && result[0] === 'ok' && foreignKeyFailures.length === 0, result, foreignKeyFailures };
  }

  close() {
    if (!databaseIsOpen(this._db)) { this._db = null; return false; }
    const db = this._db;
    this._db = null;
    this._clearVerificationTrust();
    db.close();
    return true;
  }
}

function createAuditStore(options = {}) { return new AuditStore(options); }

// The settings probe must not initialize schema, migrate projections, or mint
// a key. Reuse the canonical verifier against a strictly read-only handle.
function withReadOnlyLedger(file, callback) {
  // SQLite's readOnly flag still creates a missing WAL/shared-memory file.
  // Inspect a disposable DB+WAL snapshot so even that bookkeeping cannot
  // mutate the original. A racing/inconsistent copy fails verification.
  const scratch = fs.mkdtempSync(path.join(path.dirname(path.resolve(file)), '.audit-inspect-'));
  const copy = path.join(scratch, 'audit.sqlite3');
  let db;
  try {
    require('./audit-file-inspection').copyLedgerFiles(file, copy);
    db = openDatabaseSync(copy, { readOnly: true, allowExtension: false });
  } catch (error) { fs.rmSync(scratch, { recursive: true, force: true }); throw error; }
  const view = Object.create(AuditStore.prototype);
  view.file = path.resolve(file);
  view.clock = Date.now;
  view._open = () => db;
  try {
    db.exec('BEGIN DEFERRED');
    const adapter = {
      getKey: keyId => view.getKey(keyId),
      getEvent: selector => view.getEvent(selector),
      getMetadata: key => view.getMetadata(key),
      verify: boundary => ({ ...view._verifySnapshot(db, boundary), status: view._status(db) }),
      integrity: () => db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]),
      // Repair must bind even a tampered historical row, while a harmless
      // WAL checkpoint during writer shutdown must not invalidate consent.
      // This is a digest of unverified content, never a verification result.
      unverifiedContentDigest: () => {
        if (databaseFingerprint(db) !== expectedFingerprint()) throw auditError('AUDIT_SCHEMA_INVALID', 'The audit DDL fingerprint does not match this schema version.');
        const digest = crypto.createHash('sha256');
        digest.update(canonicalJson({ applicationId: db.prepare('PRAGMA application_id').get().application_id,
          schemaVersion: db.prepare('PRAGMA user_version').get().user_version, ddl: databaseFingerprint(db) }));
        for (const [table, order] of [['audit_keys', 'key_id'], ['audit_events', 'sequence'],
          ['audit_metadata', 'key'], ['audit_sink_state', 'sink']]) {
          digest.update(`\n${table}\n`);
          for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) digest.update(`${JSON.stringify(row)}\n`);
        }
        return digest.digest('hex');
      },
      status: () => view._status(db)
    };
    const result = callback(adapter);
    if (result && typeof result.then === 'function') throw auditError('AUDIT_TRANSACTION_ASYNC', 'Read-only inspection must be synchronous.');
    db.exec('ROLLBACK');
    return result;
  } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
}

// Negative-only migration probe for operational idempotency. These rows are
// NOT verified audit evidence and may only block replay. No signer, anchor,
// schema initialization or history walk runs at this boundary.
function hasLegacyOperation({ actions, target, file = process.env.TOOLSENABLED_AUDIT_DB || DEFAULT_AUDIT_DB } = {}, dependencies = {}) {
  if (!Array.isArray(actions) || !actions.length || actions.length > 4 || actions.some(action => typeof action !== 'string' || !action || action.length > 160)
      || typeof target !== 'string' || !target || target.length > 240) throw auditError('AUDIT_INVALID_ARGUMENT', 'Legacy custody selector is invalid.');
  let stat;
  try { stat = (dependencies.stat || fs.lstatSync)(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw auditError('AUDIT_LEGACY_CUSTODY_UNKNOWN', 'Legacy custody is not a direct regular file.');
  const db = (dependencies.open || openDatabaseSync)(file, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100; BEGIN DEFERRED;');
    if (db.prepare('PRAGMA application_id').get().application_id !== AUDIT_APPLICATION_ID
        || db.prepare('PRAGMA user_version').get().user_version !== AUDIT_SCHEMA_VERSION
        || databaseFingerprint(db) !== expectedFingerprint()) throw auditError('AUDIT_LEGACY_CUSTODY_UNKNOWN', 'Legacy custody schema is unknown.');
    // Older archived rows are not an absence proof. Reconciliation is explicit.
    if (db.prepare('SELECT 1 FROM audit_metadata WHERE key = ?').get('archive-boundary-v1')) throw auditError('AUDIT_LEGACY_CUSTODY_UNKNOWN', 'Legacy custody includes archived history.');
    return actions.some(action => db.prepare(EVENT_SELECTOR_QUERY).all(action, target, 1).length > 0);
  } finally { db.close(); }
}

module.exports = {
  hasLegacyOperation,
  AUDIT_APPLICATION_ID, AUDIT_SCHEMA_VERSION, AuditStore, AuditStoreError,
  DEFAULT_AUDIT_DB, MAX_EVENT_BYTES, ZERO_HASH, canonicalJson, createAuditStore,
  // Exported so the suite can EXPLAIN the query production prepares rather than a
  // hand-copied twin that drifts silently. Not part of the public audit surface.
  EVENT_SELECTOR_QUERY,
  ensureWalMode, eventHashInput, expectedFingerprint, publicKeyHash, sha256, withReadOnlyLedger
};

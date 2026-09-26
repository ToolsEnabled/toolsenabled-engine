'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { rootPath, ensureDir } = require('./runtime');

// Node 22's experimental DatabaseSync surface does not expose the later
// isOpen/isTransaction accessors. LicenseStore owns its retained handle, so
// use the newer accessors when present and local transaction state otherwise.
function databaseIsOpen(database) {
  if (!database) return false;
  if (typeof database.isOpen === 'boolean') return database.isOpen;
  return true;
}

function databaseIsTransaction(database) {
  if (!database) return false;
  return typeof database.isTransaction === 'boolean' && database.isTransaction;
}

const LICENSE_APPLICATION_ID = 0x54454c43; // "TELC"
const LICENSE_SCHEMA_VERSION = 1;
const DEFAULT_LICENSE_DB = rootPath('state', 'licenses.sqlite3');

function absoluteDatabasePath(environment = process.env) {
  const configured = typeof environment.TOOLSENABLED_LICENSE_DB_PATH === 'string'
    ? environment.TOOLSENABLED_LICENSE_DB_PATH.trim() : '';
  if (!configured) return DEFAULT_LICENSE_DB;
  if (!path.isAbsolute(configured)) throw new Error('TOOLSENABLED_LICENSE_DB_PATH must be an absolute path.');
  return path.resolve(configured);
}

function assertLicenseId(value) {
  if (typeof value !== 'string' || !/^lic_[A-Za-z0-9_-]{8,120}$/.test(value)) {
    throw new Error('licenseId is invalid.');
  }
  return value;
}

function assertRevocation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('revocation must be an object.');
  const licenseId = assertLicenseId(input.licenseId);
  if (!Number.isSafeInteger(input.revokedAtMs) || input.revokedAtMs < 0) throw new Error('revokedAtMs is invalid.');
  if (typeof input.reason !== 'string' || input.reason.length > 1000 || /[\x00]/.test(input.reason)) {
    throw new Error('reason must be a string of at most 1000 characters without NUL bytes.');
  }
  if (typeof input.keyId !== 'string' || !/^license-ed25519-[a-f0-9]{64}$/.test(input.keyId)) {
    throw new Error('keyId is invalid.');
  }
  if (typeof input.signature !== 'string' || !/^[A-Za-z0-9_-]{80,100}$/.test(input.signature)) {
    throw new Error('signature is invalid.');
  }
  return { licenseId, revokedAtMs: input.revokedAtMs, reason: input.reason, keyId: input.keyId, signature: input.signature };
}

function rowRevocation(row) {
  return row ? {
    licenseId: row.license_id,
    revokedAtMs: row.revoked_at_ms,
    reason: row.reason,
    keyId: row.key_id,
    signature: row.signature
  } : null;
}

class LicenseStore {
  constructor(options = {}) {
    this.file = options.file ? path.resolve(options.file) : absoluteDatabasePath(options.environment);
    this._db = null;
    this._transactionActive = false;
  }

  _open() {
    if (databaseIsOpen(this._db)) return this._db;
    ensureDir(path.dirname(this.file));
    const existed = fs.existsSync(this.file);
    const db = new DatabaseSync(this.file, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5000
    });
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA busy_timeout = 5000');
      const applicationId = db.prepare('PRAGMA application_id').get().application_id;
      const userVersion = db.prepare('PRAGMA user_version').get().user_version;
      if (existed && applicationId !== 0 && applicationId !== LICENSE_APPLICATION_ID) {
        throw new Error('The license database belongs to another application.');
      }
      if (userVersion > LICENSE_SCHEMA_VERSION) {
        throw new Error(`The license database schema ${userVersion} is newer than supported schema ${LICENSE_SCHEMA_VERSION}.`);
      }
      if (userVersion === 0) {
        let transactionStarted = false;
        this._transactionActive = true;
        try {
          db.exec('BEGIN IMMEDIATE');
          transactionStarted = true;
          db.exec(`
            CREATE TABLE IF NOT EXISTS license_revocations (
              license_id TEXT PRIMARY KEY,
              revoked_at_ms INTEGER NOT NULL CHECK(revoked_at_ms >= 0),
              reason TEXT NOT NULL CHECK(length(reason) <= 1000),
              key_id TEXT NOT NULL,
              signature TEXT NOT NULL
            ) STRICT;
          `);
          db.exec(`PRAGMA application_id = ${LICENSE_APPLICATION_ID}`);
          db.exec(`PRAGMA user_version = ${LICENSE_SCHEMA_VERSION}`);
          db.exec('COMMIT');
        } catch (error) {
          if (transactionStarted || databaseIsTransaction(db)) db.exec('ROLLBACK');
          throw error;
        } finally {
          this._transactionActive = false;
        }
      }
      this._db = db;
      return db;
    } catch (error) {
      if (databaseIsOpen(db)) db.close();
      throw error;
    }
  }

  get(licenseId) {
    const row = this._open().prepare('SELECT * FROM license_revocations WHERE license_id = ?').get(assertLicenseId(licenseId));
    return rowRevocation(row);
  }

  revoke(input) {
    const revocation = assertRevocation(input);
    const db = this._open();
    if (this._transactionActive || databaseIsTransaction(db)) throw new Error('Nested license transactions are not supported.');
    let transactionStarted = false;
    this._transactionActive = true;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const prior = rowRevocation(db.prepare('SELECT * FROM license_revocations WHERE license_id = ?').get(revocation.licenseId));
      if (prior) {
        db.exec('COMMIT');
        return { ...prior, replayed: true };
      }
      db.prepare(`INSERT INTO license_revocations(license_id, revoked_at_ms, reason, key_id, signature)
        VALUES(?, ?, ?, ?, ?)`).run(
        revocation.licenseId, revocation.revokedAtMs, revocation.reason, revocation.keyId, revocation.signature
      );
      db.exec('COMMIT');
      return { ...revocation, replayed: false };
    } catch (error) {
      if (transactionStarted || databaseIsTransaction(db)) db.exec('ROLLBACK');
      throw error;
    } finally {
      this._transactionActive = false;
    }
  }

  status() {
    const db = this._open();
    const integrity = db.prepare('PRAGMA quick_check').all().map(row => Object.values(row)[0]);
    return {
      ok: integrity.length === 1 && integrity[0] === 'ok',
      path: this.file,
      schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      applicationId: db.prepare('PRAGMA application_id').get().application_id,
      revocations: db.prepare('SELECT COUNT(*) AS count FROM license_revocations').get().count,
      integrity
    };
  }

  close() {
    if (!databaseIsOpen(this._db)) {
      this._db = null;
      return false;
    }
    const db = this._db;
    this._db = null;
    db.close();
    return true;
  }
}

let defaultStore = null;
function getLicenseStore() {
  if (!defaultStore) defaultStore = new LicenseStore();
  return defaultStore;
}

module.exports = {
  DEFAULT_LICENSE_DB,
  LICENSE_APPLICATION_ID,
  LICENSE_SCHEMA_VERSION,
  LicenseStore,
  absoluteDatabasePath,
  getLicenseStore
};

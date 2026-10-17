'use strict';
// Pane reads only resolve the selected state root. They never adopt a legacy
// root or open the writable StateStore, whose constructor migrates SQLite.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveStateRoot } = require('./runtime-state-root');
const { terminalDisplayText } = require('./terminal-safe-text');

function fail(code, message) { return Object.assign(new Error(message), { code }); }
// Per-read DB+WAL copies are bounded by the inspector's maximum. Real
// long-lived state reaches tens of MB of ordinary memory, so the state bound
// is that maximum. Exceeding a bound is permanent, not a changed snapshot.
const STATE_VIEW_COPY_BYTES = 256 * 1024 * 1024;
function tooLarge(what, limit) {
  return fail('FLEET_VIEW_TOO_LARGE', `${what} is too large to view: the database and its WAL exceed the ${limit} view copy limit.`);
}
function copyForView(file, copy, maxBytes, what, limit) {
  try { require('./audit-file-inspection').copyLedgerFiles(file, copy, maxBytes); }
  catch (error) { throw error && error.code === 'AUDIT_VIEW_COPY_TOO_LARGE' ? tooLarge(what, limit) : error; }
}
function validatePage({ offset = 0, limit = 50, revision } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw fail('FLEET_VIEW_RANGE_INVALID', 'Use a non-negative offset and a limit from 1 to 100.');
  if (revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)))
    throw fail('FLEET_VIEW_RANGE_INVALID', 'Revision must be a 64-character snapshot digest.');
}
function pageOptions(args, command, commands) {
  const paged = ['offset', 'limit', 'revision'].some(key => args[key] !== undefined);
  if (paged && (!commands.includes(command) || !(args.json || args.text))) {
    throw fail('FLEET_VIEW_RANGE_INVALID', 'Paging requires a read-only --json or --text view.');
  }
  const options = { offset: 0, limit: 50, revision: undefined };
  for (const key of ['offset', 'limit']) {
    if (args[key] !== undefined) {
      if (!/^\d+$/.test(String(args[key]))) throw fail('FLEET_VIEW_RANGE_INVALID', `--${key} needs a non-negative integer.`);
      options[key] = Number(args[key]);
    }
  }
  if (!Number.isSafeInteger(options.offset) || options.offset < 0 || !Number.isSafeInteger(options.limit)
    || options.limit < 1 || options.limit > 100) throw fail('FLEET_VIEW_RANGE_INVALID', 'Use a non-negative offset and a limit from 1 to 100.');
  if (args.revision !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(String(args.revision))) throw fail('FLEET_VIEW_RANGE_INVALID', '--revision needs a 64-character snapshot digest.');
    options.revision = args.revision;
  }
  if (args.text && args.limit === undefined) options.limit = 20;
  if (args.text && args.surface !== 'plain' && args.surface !== 'console') options.limit = Math.min(options.limit, 20);
  return options;
}
function bounded(value, max = 8192) {
  const raw = String(value ?? '');
  if (require('./secret-patterns').plaintextCredentialOutsideGeneratedIds(raw)) {
    return { text: '[redacted credential-shaped text]', truncated: false, redacted: true };
  }
  const chars = Array.from(terminalDisplayText(raw));
  return { text: chars.slice(0, max).join(''), truncated: chars.length > max, redacted: false };
}
function safe(value, max = 8192) { return bounded(value, max).text; }
function digest(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row)).update('\n');
  return hash.digest('hex');
}
function assertDirectPath(file) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  const segments = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || index < segments.length - 1 && !stat.isDirectory())
      throw fail('FLEET_VIEW_PATH_INVALID', 'The selected state path has a link or non-directory ancestor.');
  }
}
function withStateDb(callback) {
  const file = path.join(resolveStateRoot().root, 'state', 'toolsenabled.sqlite3');
  assertDirectPath(file);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return callback(null);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw fail('FLEET_VIEW_STORE_INVALID', 'The state database is not a non-empty direct regular file.');
  // SQLite can create a -shm sidecar even for a readOnly handle. Inspect a
  // disposable DB+WAL copy so a pane never writes into the installed state.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), '.fleet-view-'));
  const copy = path.join(scratch, 'toolsenabled.sqlite3');
  let db;
  try {
    copyForView(file, copy, STATE_VIEW_COPY_BYTES, 'Fleet state', '256 MiB');
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(copy, { readOnly: true, allowExtension: false });
    db.exec('PRAGMA query_only=ON; BEGIN DEFERRED');
    return callback(db);
  } finally {
    if (db) { try { db.exec('ROLLBACK'); } finally { db.close(); } }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
function tableExists(db, name) {
  return Boolean(db && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function assertRevision(expected, actual) {
  if (expected !== undefined && expected !== actual) throw fail('FLEET_VIEW_CHANGED', 'The view changed. Reload from offset 0.');
}
module.exports = Object.freeze({ fail, tooLarge, STATE_VIEW_COPY_BYTES, validatePage, pageOptions, bounded, safe, digest, withStateDb, tableExists, assertDirectPath, assertRevision });

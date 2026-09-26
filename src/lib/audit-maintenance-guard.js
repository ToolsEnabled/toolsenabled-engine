'use strict';

// A crashed rotation stays closed until its journal is reconciled. A durable
// generation also fences old processes after the lock has been released:
// their cached SQLite handles and signing keys cannot extend the new ledger.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function lockPath(file) { return `${path.resolve(file)}.maintenance.json`; }
function generationPath(file) { return `${path.resolve(file)}.generation.json`; }
function read(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw failure('AUDIT_MAINTENANCE_INVALID', 'The audit maintenance record is not a regular bounded file.');
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid maintenance record');
    return record;
  }
  catch { throw failure('AUDIT_MAINTENANCE_INVALID', 'The audit maintenance record cannot be read.'); }
}
function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'EBADF', 'EACCES'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function durableJson(file, value, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = exclusive ? file : `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (!exclusive) fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}
function generation(file) {
  if (file === ':memory:') return 'memory';
  const record = read(generationPath(file));
  if (!record) return 'original';
  if (record.version !== 1 || !/^[a-f0-9-]{36}$/.test(record.generation || '')) throw failure('AUDIT_MAINTENANCE_INVALID', 'The audit generation record is invalid.');
  return record.generation;
}
function assertAvailable(file, expectedGeneration) {
  if (file === ':memory:') return;
  if (read(lockPath(file))) throw failure('AUDIT_MAINTENANCE_REQUIRED', 'Audit identity maintenance is in progress or was interrupted. Open Settings to inspect or recover it.');
  if (expectedGeneration !== undefined && generation(file) !== expectedGeneration) {
    throw failure('AUDIT_GENERATION_CHANGED', 'The audit identity changed. Restart this writer before recording more activity.');
  }
}
function isRefusal(error) { return ['AUDIT_MAINTENANCE_REQUIRED', 'AUDIT_MAINTENANCE_INVALID', 'AUDIT_GENERATION_CHANGED'].includes(error?.code); }

module.exports = { assertAvailable, durableJson, failure, generation, generationPath, isRefusal, lockPath, read, syncDirectory };

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function admissionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function defaultAdmissionGuardPath() {
  // HOME/LOCALAPPDATA/TMP are deliberately private in DEV and CUT. The one
  // shared physical-resource budget uses the OS account, just as the daemon
  // connection does. Never store session records, credentials or PIDs here.
  const home = os.userInfo().homedir;
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    throw admissionError('SANDBOX_CREATE_GUARD_INVALID', 'The sandbox admission owner home is unavailable.');
  }
  return path.join(fs.realpathSync(home), '.toolsenabled-sandbox-admission-v1', 'create.sqlite3');
}

function prepareGuardFile(file) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || (process.platform !== 'win32' && (parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0))) {
    throw admissionError('SANDBOX_CREATE_GUARD_INVALID', 'The sandbox admission directory must be private to the OS owner.');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0), 0o600);
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw admissionError('SANDBOX_CREATE_GUARD_INVALID', 'The sandbox admission file must not be a link.');
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1
      || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw admissionError('SANDBOX_CREATE_GUARD_INVALID', 'The sandbox admission file must be a private, regular owner file.');
    }
  } finally { fs.closeSync(descriptor); }
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw admissionError('SANDBOX_CREATE_GUARD_INVALID', 'The sandbox admission file must not be a link.');
  }
}

function withSandboxAdmissionLock(file, callback) {
  prepareGuardFile(file);
  const database = new DatabaseSync(file, { allowExtension: false, enableDoubleQuotedStringLiterals: false });
  try {
    // A live sibling returns BUSY immediately. Kernel/SQLite lock ownership
    // ends when the connection closes or its process dies; there is no stale
    // PID sweep and the shared file is never unlinked/replaced on release.
    try { database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
    catch (error) {
      if (error.errcode === 5 || error.errcode === 6 || /database (?:is )?locked/i.test(error.message || '')) {
        throw admissionError('SANDBOX_CREATE_BUSY', 'Another session is admitting a sandbox against the shared host budget.');
      }
      throw error;
    }
    const result = callback();
    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).catch(() => {});
      throw admissionError('SANDBOX_CREATE_GUARD_INVALID', 'Sandbox admission must complete synchronously.');
    }
    return result;
  } finally { database.close(); }
}

module.exports = { defaultAdmissionGuardPath, withSandboxAdmissionLock };

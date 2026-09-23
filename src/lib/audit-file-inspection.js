'use strict';

// Raw reads/copies must run in another PROCESS. On POSIX, closing a raw
// descriptor drops every SQLite lock this process holds on that inode,
// including locks in worker threads. A worker thread is not isolation here.
// https://sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('./supervision/launch-environment');

function regularFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('Audit inspection requires direct regular files.'), { code: 'AUDIT_REKEY_FILE_UNSUPPORTED' });
  }
  return stat;
}

function inspectFiles(request) {
  if (request.operation === 'copy') {
    for (const suffix of ['', '-wal']) {
      const source = `${request.file}${suffix}`;
      if (!regularFile(source)) {
        if (suffix) continue;
        throw Object.assign(new Error('The audit database is missing.'), { code: 'ENOENT' });
      }
      fs.copyFileSync(source, `${request.copy}${suffix}`, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(`${request.copy}${suffix}`, 0o600);
    }
    return true;
  }
  if (request.operation === 'fingerprint') {
    return request.files.map(file => {
      const stat = regularFile(file);
      if (!stat) return null;
      return { size: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    });
  }
  throw new Error('Unknown audit inspection operation.');
}

function isolatedInspection(request) {
  const result = spawnSync(process.execPath, [__filename], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 30000,
    maxBuffer: 1024 * 1024, windowsHide: true,
    env: safeLaunchEnvironment({ ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
      { context: 'isolated audit file inspection' })
  });
  if (result.error || result.status !== 0) {
    throw Object.assign(new Error('The audit files could not be inspected in a separate process.', { cause: result.error }),
      { code: 'AUDIT_FILE_INSPECTION_UNAVAILABLE' });
  }
  const response = JSON.parse(result.stdout);
  if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  return response.value;
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify({ value: inspectFiles(JSON.parse(fs.readFileSync(0, 'utf8'))) })); }
  catch (error) { process.stdout.write(JSON.stringify({ error: { code: error.code || 'AUDIT_FILE_INSPECTION_UNAVAILABLE', message: error.message } })); }
}

module.exports = {
  copyLedgerFiles: (file, copy) => isolatedInspection({ operation: 'copy', file, copy }),
  fingerprintFiles: files => isolatedInspection({ operation: 'fingerprint', files })
};

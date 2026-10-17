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
    const maxBytes = request.maxBytes;
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024))
      throw Object.assign(new Error('The view copy limit is invalid.'), { code: 'AUDIT_VIEW_COPY_LIMIT_INVALID' });
    const sources = ['', '-wal'].map(suffix => ({ suffix, source: `${request.file}${suffix}` }))
      .map(item => ({ ...item, stat: regularFile(item.source) })).filter(item => item.stat);
    if (!sources.some(item => item.suffix === ''))
      throw Object.assign(new Error('The audit database is missing.'), { code: 'ENOENT' });
    if (maxBytes !== undefined && sources.reduce((sum, item) => sum + item.stat.size, 0) > maxBytes)
      throw Object.assign(new Error('The database and WAL exceed the view copy limit.'), { code: 'AUDIT_VIEW_COPY_TOO_LARGE' });
    let copied = 0;
    for (const { suffix, source } of sources) {
      const destination = `${request.copy}${suffix}`;
      if (maxBytes === undefined) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      else {
        const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        let output;
        try {
          output = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
          const chunk = Buffer.alloc(64 * 1024);
          for (;;) {
            const read = fs.readSync(input, chunk, 0, Math.min(chunk.length, maxBytes - copied + 1), null);
            if (read === 0) break;
            copied += read;
            if (copied > maxBytes) throw Object.assign(new Error('The database and WAL exceed the view copy limit.'), { code: 'AUDIT_VIEW_COPY_TOO_LARGE' });
            let written = 0;
            while (written < read) written += fs.writeSync(output, chunk, written, read - written);
          }
        } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
      }
      fs.chmodSync(destination, 0o600);
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
  copyLedgerFiles: (file, copy, maxBytes) => isolatedInspection({ operation: 'copy', file, copy, maxBytes }),
  fingerprintFiles: files => isolatedInspection({ operation: 'fingerprint', files })
};

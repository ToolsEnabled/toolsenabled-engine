'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

function opaqueWalFingerprint(dbFile) {
  // SQLite ignores torn/obsolete frames. They are still the owner's bytes:
  // bind them to consent, then preserve them before SQLite may normalize the
  // live file. The published format defines these checksums and byte orders:
  // https://sqlite.org/fileformat2.html#wal_file_format
  if (dbFile === ':memory:') return null;
  const file = `${dbFile}-wal`;
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('The audit WAL is not a direct regular file.'), { code: 'AUDIT_WAL_INPUT_UNSUPPORTED' });
  if (stat.size === 0) return null;
  const bytes = fs.readFileSync(file);
  const opaque = () => ({ size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  if (bytes.length < 32) return opaque();
  const magic = bytes.readUInt32BE(0), pageSize = bytes.readUInt32BE(8);
  if (![0x377f0682, 0x377f0683].includes(magic) || bytes.readUInt32BE(4) !== 3007000
      || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0
      || (bytes.length - 32) % (pageSize + 24) !== 0) return opaque();
  let first = 0, second = 0;
  const word = offset => magic === 0x377f0682 ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  function checksum(start, end) {
    for (let offset = start; offset < end; offset += 8) {
      first = (first + word(offset) + second) >>> 0;
      second = (second + word(offset + 4) + first) >>> 0;
    }
  }
  checksum(0, 24);
  if (first !== bytes.readUInt32BE(24) || second !== bytes.readUInt32BE(28)) return opaque();
  let committed = true;
  for (let offset = 32; offset < bytes.length; offset += pageSize + 24) {
    if (bytes.readUInt32BE(offset) === 0 || bytes.readUInt32BE(offset + 8) !== bytes.readUInt32BE(16)
        || bytes.readUInt32BE(offset + 12) !== bytes.readUInt32BE(20)) return opaque();
    checksum(offset, offset + 8); checksum(offset + 24, offset + 24 + pageSize);
    if (first !== bytes.readUInt32BE(offset + 16) || second !== bytes.readUInt32BE(offset + 20)) return opaque();
    committed = bytes.readUInt32BE(offset + 4) > 0;
  }
  return committed ? null : opaque();
}
module.exports = { opaqueWalFingerprint };

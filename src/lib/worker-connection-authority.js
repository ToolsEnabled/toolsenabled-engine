'use strict';

// An operator-issued seal, not an API credential. The issuer is reached only
// by the operator connection command; no MCP tool exposes it. Host file tools
// protect the canonical runtime/control roots and refuse the private key even
// for reads. This distinguishes a mediated model from its operator, not from
// arbitrary native code running as the same OS account.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 4096;
function refused() {
  throw Object.assign(new Error('The host model connection has no current operator authorization. Run worker add with the intended connection before using a host credential.'),
    { code: 'OPENSHELL_MODEL_CONNECTION_AUTHORITY_REQUIRED' });
}
function directories(file) {
  let cursor = path.parse(file).root;
  for (const part of path.relative(cursor, path.dirname(file)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refused();
  }
}
function readPrivate(file, limit = MAX_BYTES) {
  let fd;
  try {
    directories(file);
    const before = fs.lstatSync(file);
    const same = stat => stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid())
      && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(name => stat[name] === before[name]);
    if (!same(before) || before.size < 1 || before.size > limit) refused();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!same(fs.fstatSync(fd))) refused();
    const buffer = Buffer.alloc(limit + 1);
    let size = 0, count;
    do { count = fs.readSync(fd, buffer, size, buffer.length - size, null); size += count; } while (count && size < buffer.length);
    if (size !== before.size || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) refused();
    return buffer.subarray(0, size);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function locations(stateRoot, name) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) refused();
  const root = path.resolve(stateRoot), directory = path.join(root, 'state', 'worker-connection-authority');
  return { root, directory, record: path.join(directory, `${name}.json`), key: path.join(root, 'state', 'private-key.worker-connections.key') };
}
function signature(key, root, connection) {
  return crypto.createHmac('sha256', key).update('Fleet host connection authority v1\0')
    .update(fs.realpathSync(root)).update('\0').update(JSON.stringify(connection)).digest('hex');
}
function atomicPrivate(file, content) {
  directories(file);
  const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let fd, created = false;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true; fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    directories(file);
    try { readPrivate(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) { try { fs.unlinkSync(temporary); } catch { /* Published or already removed. */ } }
  }
}
function issue(connection, stateRoot) {
  try {
    const files = locations(stateRoot, connection.name);
    directories(files.key);
    let key;
    try { key = readPrivate(files.key, 32); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Never adopt existing authorizations when their key disappeared.
      if (fs.existsSync(files.directory) && fs.readdirSync(files.directory).length) refused();
      key = crypto.randomBytes(32);
      let fd;
      try {
        fd = fs.openSync(files.key, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, key); fs.fsyncSync(fd);
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    if (key.length !== 32) refused();
    try { fs.mkdirSync(files.directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const directory = fs.lstatSync(files.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
      || typeof process.getuid === 'function' && directory.uid !== process.getuid()) refused();
    atomicPrivate(files.record, `${JSON.stringify({ schemaVersion: 1, mac: signature(key, files.root, connection) })}\n`);
  } catch { refused(); }
}
function verify(connection, stateRoot) {
  try {
    const files = locations(stateRoot, connection.name), key = readPrivate(files.key, 32);
    const record = JSON.parse(readPrivate(files.record).toString('utf8'));
    if (key.length !== 32 || record?.schemaVersion !== 1 || Object.keys(record).sort().join(',') !== 'mac,schemaVersion'
      || typeof record.mac !== 'string' || !/^[0-9a-f]{64}$/.test(record.mac)
      || !crypto.timingSafeEqual(Buffer.from(record.mac, 'hex'), Buffer.from(signature(key, files.root, connection), 'hex'))) refused();
  } catch { refused(); }
}
function revoke(name, stateRoot) {
  try {
    const files = locations(stateRoot, name);
    readPrivate(files.record);
    fs.unlinkSync(files.record);
  } catch (error) { if (error.code !== 'ENOENT') refused(); }
}
module.exports = Object.freeze({ issue, verify, revoke, refused });

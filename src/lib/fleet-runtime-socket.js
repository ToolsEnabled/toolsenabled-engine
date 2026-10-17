'use strict';
// Worker IPC lives apart from durable tree records: a long account HOME must
// not consume Linux sun_path. Every directory we create is a private per-user
// directory; no selected socket path may cross a link or foreign owner.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const link = require('./openshell-tree-link');

function refusal(message) {
  return Object.assign(new Error(message), { code: 'FLEET_RUNTIME_SOCKET_UNSAFE' });
}
function uid() {
  if (typeof process.getuid !== 'function') throw refusal('Private Unix worker sockets need a local user identity.');
  return process.getuid();
}
function directAncestors(folder) {
  const absolute = path.resolve(folder);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw refusal('The worker runtime path crosses a link or non-directory.');
    if (stat.uid !== 0 && stat.uid !== uid()) throw refusal('The worker runtime path crosses a foreign owner.');
    if ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000)))
      throw refusal('The worker runtime path crosses an untrusted writable directory.');
  }
}
function privateDirectory(folder, create) {
  directAncestors(path.dirname(folder));
  let stat;
  try { stat = fs.lstatSync(folder); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) { if (error.code === 'ENOENT') return; throw error; }
    try { fs.mkdirSync(folder, { mode: 0o700 }); fs.chmodSync(folder, 0o700); }
    catch (race) { if (race.code !== 'EEXIST') throw race; }
    stat = fs.lstatSync(folder);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o777) !== 0o700)
    throw refusal('Worker runtime directories must be direct, owned by you and mode 0700.');
}
function validXdg(root) {
  if (!root || typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) return false;
  try {
    directAncestors(root);
    const stat = fs.lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid() && (stat.mode & 0o777) === 0o700;
  } catch { return false; }
}
function runtimeBase(env = process.env) {
  if (process.platform === 'win32') return null;
  const xdg = env.XDG_RUNTIME_DIR;
  if (validXdg(xdg) && Buffer.byteLength(path.join(xdg, 'tef', 'ffffffffffff', 'ffffffffffffffff.sock')) <= link.MAX_SOCKET_PATH_BYTES)
    return path.join(xdg, 'tef');
  const tmp = '/tmp';
  const stat = fs.lstatSync(tmp);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || !(stat.uid === 0 && (stat.mode & 0o1000) || stat.uid === uid() && (stat.mode & 0o777) === 0o700))
    throw refusal('The system temporary directory is not a trusted direct directory.');
  return path.join(tmp, `tef-${uid()}`);
}
function runtimeSocketPath(preferred, { env = process.env, create = true } = {}) {
  if (typeof preferred !== 'string' || !path.isAbsolute(preferred) || path.resolve(preferred) !== preferred)
    throw refusal('A worker socket needs a normalized absolute identity.');
  if (process.platform === 'win32') return link.socketPathFor(preferred);
  const name = path.basename(preferred);
  if (!/^[a-z0-9_-]{1,16}\.sock$/.test(name)) throw refusal('A worker socket needs a bounded basename.');
  const base = runtimeBase(env);
  const digest = crypto.createHash('sha256').update(path.dirname(preferred)).digest('hex').slice(0, 12);
  const parent = path.join(base, digest);
  const socket = path.join(parent, name);
  if (Buffer.byteLength(socket) > link.MAX_SOCKET_PATH_BYTES) throw refusal('The worker runtime socket path exceeds the Linux limit.');
  privateDirectory(base, create);
  privateDirectory(parent, create);
  return socket;
}
function assertPrivateRuntimeSocketPath(socket, { env = process.env } = {}) {
  const base = runtimeBase(env);
  if (typeof socket !== 'string' || !path.isAbsolute(socket)
      || !socket.startsWith(base + path.sep)
      || !/^[a-f0-9]{12}$/.test(path.basename(path.dirname(socket)))
      || !/^[a-z0-9_-]{1,16}\.sock$/.test(path.basename(socket)))
    throw refusal('The worker socket is outside its private runtime directory.');
  privateDirectory(base, false);
  privateDirectory(path.dirname(socket), false);
  if (!fs.existsSync(base) || !fs.existsSync(path.dirname(socket))) throw refusal('The worker runtime directory is missing.');
  return socket;
}
module.exports = Object.freeze({ runtimeBase, runtimeSocketPath, assertPrivateRuntimeSocketPath });

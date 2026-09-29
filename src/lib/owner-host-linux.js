'use strict';

// Linux authority for the app-owned MCP transport. A pathname socket gives us
// kernel-enforced directory/socket permissions; SO_PEERCRED establishes the
// actual peer before either client sends its opaque session credential.
//
// Linux prerequisite: root-managed /usr/bin/python3 with its standard library.
// Node has no public SO_PEERCRED API. The isolated interpreter receives a dup
// of the connected socket at fd 3, calls getsockopt, and exits without reading
// or writing the transport. No shell, PATH lookup, user site, PYTHONPATH, or
// caller-selected helper participates. Failure never permits a bearer-only
// fallback. See unix(7), SO_PEERCRED, and child_process options.stdio.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// sockaddr_un.sun_path is a fixed 108-byte field INCLUDING its NUL
// terminator, so 107 bytes is the longest path that survives. The kernel
// truncates anything longer instead of refusing it, and listen() then reports
// success with no socket on disk -- measured here at 211 bytes: listen()
// succeeded, the file did not exist, the directory was empty. This is the
// kernel's limit, deliberately NOT the tighter self-imposed budget the test
// runner uses for its temp roots: importing that 100 here would refuse
// perfectly bindable 100-107 byte paths in a real install.
const SUN_PATH_BYTES = 108;
const PYTHON = '/usr/bin/python3';
const PEER_TIMEOUT_MS = 3000;
const MAX_PEER_BYTES = 128;
const GENERATION_RE = /^[a-f0-9-]{36}$/;
const PEER_PROGRAM = [
  'import json, socket, struct, sys',
  'if len(sys.argv) == 2 and sys.argv[1] == "probe":',
  '    s, other = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)',
  'else:',
  '    s = socket.socket(fileno=3)',
  'if s.family != socket.AF_UNIX or s.type != socket.SOCK_STREAM:',
  '    raise RuntimeError("unsupported transport")',
  'pid, uid, gid = struct.unpack("iII", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("iII")))',
  'print(json.dumps({"pid": pid, "uid": uid, "gid": gid}))'
].join('\n');

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validId(value) {
  return Number.isSafeInteger(value) && value >= 0 && value < 0xffffffff;
}

function currentIdentity(processInfo = process) {
  let uid, gid, euid, egid;
  try {
    uid = processInfo.getuid();
    gid = processInfo.getgid();
    euid = processInfo.geteuid();
    egid = processInfo.getegid();
  } catch {
    refuse('OWNER_HOST_PRINCIPAL_INVALID', 'The Linux process credentials could not be established.');
  }
  if (!validId(uid) || !validId(gid) || uid === 0 || gid === 0 || uid !== euid || gid !== egid) {
    refuse('OWNER_HOST_PRINCIPAL_INVALID', 'The Linux owner host requires one non-elevated operating-system account.');
  }
  return Object.freeze({ uid, gid, principal: `uid:${uid}` });
}

function checkedAbsolute(value) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value)
      || value !== path.posix.normalize(value) || /[\0\r\n]/.test(value)) {
    refuse('OWNER_HOST_LINUX_PATH_REFUSED', 'The Linux owner-host path is invalid.');
  }
  return value;
}

function socketPath(generation, identity = currentIdentity()) {
  if (typeof generation !== 'string' || !GENERATION_RE.test(generation)) {
    refuse('OWNER_HOST_LINUX_PATH_REFUSED', 'The Linux owner-host generation is invalid.');
  }
  return `/run/user/${identity.uid}/toolsenabled-owner-host/${generation}.sock`;
}

function validSocketPath(value) {
  return typeof value === 'string' && path.posix.isAbsolute(value)
    && value === path.posix.normalize(value) && !/[\0\r\n]/.test(value)
    && Buffer.byteLength(value, 'utf8') < SUN_PATH_BYTES;
}

function validEndpoint(value, generation, { custom = false } = {}) {
  return validSocketPath(value) && GENERATION_RE.test(generation)
    && (custom || value === socketPath(generation));
}

// Walk one component at a time, rejecting a symlink before looking beneath
// it. A root-owned sticky directory such as /tmp may contain an owner-private
// test directory. Otherwise no other account may replace a path component.
// Beneath a 0700 owner directory, group bits on descendants confer no access
// to outside accounts. The IPC directory itself must still be exactly 0700.
function checkedDirectory(directory, { create = false, privateLeaf = false } = {}) {
  checkedAbsolute(directory);
  const { uid } = currentIdentity();
  let insidePrivate = false;
  let cursor = '/';
  let finalStat;
  const parts = directory.split('/').filter(Boolean);
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) cursor = path.posix.join(cursor, parts[index]);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (!create || error?.code !== 'ENOENT') throw error;
      try { fs.mkdirSync(cursor, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
      stat = fs.lstatSync(cursor);
    }
    const stickyRoot = stat.uid === 0 && Boolean(stat.mode & 0o1000);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || (stat.uid !== 0 && stat.uid !== uid)
        || (!insidePrivate && (stat.mode & 0o022) !== 0 && !stickyRoot)) {
      refuse('OWNER_HOST_LINUX_PATH_REFUSED', 'The Linux owner-host directory is not trusted.');
    }
    if (stat.uid === uid && (stat.mode & 0o077) === 0) insidePrivate = true;
    finalStat = stat;
  }
  if (privateLeaf && (finalStat.uid !== uid || (finalStat.mode & 0o7777) !== 0o700)) {
    refuse('OWNER_HOST_LINUX_PATH_REFUSED', 'The Linux owner-host socket directory must be owner-only.');
  }
  return finalStat;
}

function prepareSocketDirectory(file) {
  if (!validSocketPath(file)) {
    // Two unrelated faults arrive here and the caller has to be able to tell
    // them apart. "Invalid or too long" reads as "your path is malformed",
    // which sends an operator looking for a typo when the real answer is that
    // the path is a measurable number of bytes over a fixed kernel limit --
    // the one fault that is actually fixable, by installing somewhere
    // shallower. Name the count and the limit so the refusal is actionable.
    const bytes = typeof file === 'string' ? Buffer.byteLength(file, 'utf8') : null;
    if (bytes !== null && bytes >= SUN_PATH_BYTES) {
      refuse('OWNER_HOST_LINUX_PATH_REFUSED',
        `The Linux owner-host socket path is ${bytes} bytes; at most ${SUN_PATH_BYTES - 1} fit in `
        + `sockaddr_un.sun_path (${SUN_PATH_BYTES} bytes including its terminator). A longer path is `
        + 'truncated by the kernel rather than refused, so binding it would report success while '
        + 'creating no socket. Refusing instead.');
    }
    refuse('OWNER_HOST_LINUX_PATH_REFUSED', 'The Linux owner-host socket path is invalid.');
  }
  checkedDirectory(path.dirname(file), { create: true, privateLeaf: true });
  try {
    fs.lstatSync(file);
    refuse('OWNER_HOST_LINUX_PATH_REFUSED', 'The Linux owner-host socket path is already occupied.');
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function protectSocket(file) {
  checkedDirectory(path.dirname(file), { privateLeaf: true });
  const before = fs.lstatSync(file);
  if (!before.isSocket() || before.uid !== currentIdentity().uid) {
    refuse('OWNER_HOST_LINUX_PATH_REFUSED', 'The Linux owner-host socket is not owned by this account.');
  }
  fs.chmodSync(file, 0o600);
  assertSocket(file);
}

function assertSocket(file) {
  if (!validSocketPath(file)) {
    refuse('OWNER_HOST_LINUX_PATH_REFUSED', 'The Linux owner-host endpoint is invalid.');
  }
  checkedDirectory(path.dirname(file), { privateLeaf: true });
  const stat = fs.lstatSync(file);
  if (!stat.isSocket() || stat.uid !== currentIdentity().uid || (stat.mode & 0o7777) !== 0o600) {
    refuse('OWNER_HOST_LINUX_PATH_REFUSED', 'The Linux owner-host endpoint is not an owner-only socket.');
  }
  return stat;
}

function prepareRecordDirectory(file) {
  checkedAbsolute(file);
  checkedDirectory(path.dirname(file), { create: true });
}

function readPrivateRecord(file, maxBytes = 4096) {
  checkedAbsolute(file);
  checkedDirectory(path.dirname(file));
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.uid !== currentIdentity().uid || stat.nlink !== 1
        || (stat.mode & 0o7777) !== 0o600 || stat.size < 2 || stat.size > maxBytes) {
      refuse('OWNER_HOST_LINUX_PATH_REFUSED', 'The Linux owner-host route is not an owner-only regular file.');
    }
    return JSON.parse(fs.readFileSync(handle, 'utf8'));
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function trustedPython() {
  try {
    for (const directory of ['/usr', '/usr/bin']) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error();
    }
    const resolved = fs.realpathSync(PYTHON);
    if (path.dirname(resolved) !== '/usr/bin') throw new Error();
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) throw new Error();
    return PYTHON;
  } catch {
    refuse('OWNER_HOST_LINUX_PEER_UNAVAILABLE', 'Linux owner-host authentication requires the root-managed /usr/bin/python3 interpreter.');
  }
}

function readPeerCredentials(socket, { spawnImpl = spawn, timeoutMs = PEER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    let output = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.off('close', onSocketClose);
      if (error) {
        child?.kill();
        reject(error);
      } else resolve(value);
    };
    const unavailable = () => Object.assign(new Error('Linux socket peer credentials could not be verified.'), {
      code: 'OWNER_HOST_LINUX_PEER_UNAVAILABLE'
    });
    const onSocketClose = () => finish(unavailable());
    try {
      // Access to Node's pipe fd is the only internal API involved. If Node or
      // Electron stops exposing it, refuse before any authority is exchanged.
      const fd = socket?._handle?.fd;
      if (socket && (socket.destroyed || !Number.isSafeInteger(fd) || fd < 0)) throw unavailable();
      child = spawnImpl(trustedPython(), ['-I', '-S', '-c', PEER_PROGRAM, ...(!socket ? ['probe'] : [])], {
        cwd: '/', env: {}, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore', ...(socket ? [fd] : [])]
      });
      timer = setTimeout(() => finish(unavailable()), timeoutMs);
      socket?.once('close', onSocketClose);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (Buffer.byteLength(output, 'utf8') > MAX_PEER_BYTES) finish(unavailable());
      });
      child.once('error', () => finish(unavailable()));
      child.once('close', code => {
        if (code !== 0) { finish(unavailable()); return; }
        let peer;
        try { peer = JSON.parse(output); } catch { finish(unavailable()); return; }
        if (!peer || Object.keys(peer).sort().join(',') !== 'gid,pid,uid'
            || !Number.isSafeInteger(peer.pid) || peer.pid <= 0
            || !validId(peer.uid) || !validId(peer.gid)) {
          finish(unavailable());
          return;
        }
        finish(null, Object.freeze({ pid: peer.pid, uid: peer.uid, gid: peer.gid }));
      });
    } catch { finish(unavailable()); }
  });
}

async function assertPeer(socket, expectedUid = currentIdentity().uid, options) {
  const peer = await readPeerCredentials(socket, options);
  if (peer.uid !== expectedUid) {
    refuse('OWNER_HOST_LINUX_PEER_REFUSED', 'The Linux owner-host peer belongs to a different operating-system account.');
  }
  return peer;
}

async function checkPrerequisite() {
  await assertPeer(null);
}

module.exports = Object.freeze({
  PYTHON,
  currentIdentity,
  socketPath,
  validSocketPath,
  validEndpoint,
  prepareSocketDirectory,
  protectSocket,
  assertSocket,
  prepareRecordDirectory,
  readPrivateRecord,
  readPeerCredentials,
  assertPeer,
  checkPrerequisite
});

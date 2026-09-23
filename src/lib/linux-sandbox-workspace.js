'use strict';

// Linux only. No project/home permissions: the caller supplies the provider's
// exact disposable root and an already-created, empty workspace beneath it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('./supervision/launch-environment');
const CODE = 'SANDBOX_LINUX_WORKSPACE_REFUSED';
function refuse() { throw Object.assign(new Error('The local sandbox workspace ownership could not be verified.'), { code: CODE }); }
function parseJson(text) { try { return JSON.parse(text); } catch { refuse(); } }
function identity(stat) { return `${stat.dev.toString()}:${stat.ino.toString()}`; }
function assertDirectoryIdentity(expected, opened, named, uid) {
  if (![opened, named].every(s => s.isDirectory() && !s.isSymbolicLink() && s.uid === BigInt(uid)
      && identity(s) === identity(expected))) refuse();
}
function trustedExecutable(file) {
  try {
    const resolved = fs.realpathSync(file);
    if (path.dirname(resolved) !== '/usr/bin') refuse();
    for (const p of ['/usr', '/usr/bin', resolved]) {
      const s = fs.lstatSync(p);
      if (s.uid !== 0 || (s.mode & 0o022) || (p === resolved && (!s.isFile() || !(s.mode & 0o111)))) refuse();
    }
    return resolved;
  } catch { refuse(); } // A missing ACL/Python helper is not evidence Docker is absent.
}
function parseMap(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 16384) refuse();
  const rows = text.trim().split('\n').map(line => {
    if (!/^\s*\d+\s+\d+\s+\d+\s*$/.test(line)) refuse();
    const row = line.trim().split(/\s+/).map(Number);
    if (row.some(n => !Number.isSafeInteger(n) || n < 0) || row[2] === 0
        || row[0] + row[2] > 4294967295 || row[1] + row[2] > 4294967295) refuse();
    return row;
  });
  if (rows.length > 340) refuse();
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    for (const column of [0, 1]) if (rows[i][column] < rows[j][column] + rows[j][2]
        && rows[j][column] < rows[i][column] + rows[i][2]) refuse();
  }
  return rows;
}
function mappedId(rows, id) {
  const row = rows.find(([inside, , count]) => id >= inside && id < inside + count);
  if (!row) refuse();
  return row[1] + id - row[0];
}
const PEER = [
  'import socket,struct,sys,json,os',
  's=socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect(sys.argv[1])',
  'pid,uid,gid=struct.unpack("iII",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))',
  'base="/proc/"+str(pid)+"/"',
  'before=open(base+"stat").read().rsplit(")",1)[1].split()[19]',
  'um=open(base+"uid_map").read(); gm=open(base+"gid_map").read()',
  'ns=os.readlink(base+"ns/user"); exe=os.readlink(base+"exe")',
  'after=open(base+"stat").read().rsplit(")",1)[1].split()[19]',
  'assert before==after',
  'print(json.dumps(dict(pid=pid,uid=uid,gid=gid,start=before,uidMap=um,gidMap=gm,userNamespace=ns,exe=exe)))',
].join('\n');
const CONTAINER_PROBE = "const f=require('fs');console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),uidMap:f.readFileSync('/proc/self/uid_map','utf8'),gidMap:f.readFileSync('/proc/self/gid_map','utf8')}))";
function aclEntries(hostUid, sandboxUid) {
  const entries = ['user::rwx', `user:${hostUid}:rwx`, `user:${sandboxUid}:rwx`, 'group::---', 'mask::rwx', 'other::---'];
  return [...entries, ...entries.map(entry => `default:${entry}`)];
}
function verifyAcl(text, expected) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).sort();
  if (JSON.stringify(lines) !== JSON.stringify([...expected].sort())) refuse();
}

function selectEndpoint(environment, inspectContext, uid) {
  // Explicit Docker choices are never replaced, even when they are unusable.
  if (environment.DOCKER_CONTEXT) return inspectContext(environment.DOCKER_CONTEXT).endpoint;
  if (environment.DOCKER_HOST) return environment.DOCKER_HOST;
  const selected = inspectContext();
  // A fresh/sterile profile has Docker's built-in rootful default, not the
  // owner's CLI context. This provider supports rootless Linux only. Select
  // the conventional per-UID endpoint here, then subject it to ALL of the
  // socket ownership, private ancestry, peer credential and namespace checks
  // below. Never use HOME, XDG_RUNTIME_DIR or an unverified context as proof.
  if (selected.name === 'default' && selected.endpoint === 'unix:///var/run/docker.sock') {
    if (!Number.isSafeInteger(uid) || uid <= 0) refuse();
    return `unix:///run/user/${uid}/docker.sock`;
  }
  return selected.endpoint;
}

function createLinuxSandboxWorkspace({ disposableRoot, auditIntent, environment = process.env } = {}) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0
      || typeof disposableRoot !== 'string' || !path.isAbsolute(disposableRoot) || typeof auditIntent !== 'function') refuse();
  const uid = process.getuid();
  const gid = process.getgid();
  if (uid !== process.geteuid() || gid !== process.getegid() || gid === 0) refuse();
  const binaries = Object.fromEntries(['docker', 'python3', 'setfacl', 'getfacl'].map(name => [name, trustedExecutable(`/usr/bin/${name}`)]));
  const env = safeLaunchEnvironment(environment);
  for (const key of Object.keys(env)) if (key.startsWith('LD_') || key.startsWith('DYLD_') || key.startsWith('PYTHON')) delete env[key];
  function command(name, args, extra = {}) {
    const result = spawnSync(binaries[name], args, { env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 32768, ...extra });
    if (result.error || result.status !== 0) refuse();
    return result.stdout;
  }
  const endpoint = selectEndpoint(env, context => {
    const lines = command('docker', ['context', 'inspect', ...(context ? [context] : []),
      '--format', '{{.Name}}\n{{.Endpoints.docker.Host}}']).trim().split('\n');
    if (lines.length !== 2 || !lines[0] || !lines[1]) refuse();
    return { name: lines[0], endpoint: lines[1] };
  }, uid);
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///') || /[\0\r\n]/.test(endpoint)) refuse();
  const socketPath = endpoint.slice(7);
  if (path.resolve(socketPath) !== socketPath) refuse();
  // A private owner directory must precede the socket. Never grant filesystem
  // access based on a public socket or an endpoint belonging to another user.
  let cursor = '/'; let privateAncestor = false;
  for (const segment of path.dirname(socketPath).split('/').filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const s = fs.lstatSync(cursor);
    if (!s.isDirectory() || s.isSymbolicLink() || ![0, uid].includes(s.uid)) refuse();
    if (!privateAncestor && (s.mode & 0o022)) refuse();
    if (s.uid === uid && (s.mode & 0o077) === 0) privateAncestor = true;
  }
  if (!privateAncestor) refuse();
  function readPeer() {
    const socket = fs.lstatSync(socketPath, { bigint: true });
    if (!socket.isSocket() || socket.uid !== BigInt(uid)) refuse();
    const peer = parseJson(command('python3', ['-I', '-c', PEER, socketPath]));
    const after = fs.lstatSync(socketPath, { bigint: true });
    if (!after.isSocket() || after.uid !== BigInt(uid) || identity(after) !== identity(socket)) refuse();
    if (!peer || peer.uid !== uid || peer.gid !== gid || !Number.isSafeInteger(peer.pid) || peer.pid <= 0
        || typeof peer.start !== 'string' || !/^\d+$/.test(peer.start)
        || typeof peer.userNamespace !== 'string' || !/^user:\[\d+\]$/.test(peer.userNamespace)
        || peer.exe !== trustedExecutable('/usr/bin/dockerd')) refuse();
    const uidMap = parseMap(peer.uidMap); const gidMap = parseMap(peer.gidMap);
    if (mappedId(uidMap, 0) !== uid || mappedId(gidMap, 0) !== gid
        || [0, uid].includes(mappedId(uidMap, 10001)) || [0, gid].includes(mappedId(gidMap, 10001))) refuse();
    return { ...peer, socketIdentity: identity(socket), uidMap, gidMap };
  }
  const pinned = readPeer();
  const signature = value => JSON.stringify(value);
  function assertEndpoint() { if (signature(readPeer()) !== signature(pinned)) refuse(); }
  const dockerEnv = safeLaunchEnvironment(env);
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[key];
  function runDocker(args, options = {}) {
    assertEndpoint();
    const result = spawnSync(binaries.docker, ['--host', endpoint, ...args], {
      cwd: options.cwd, env: dockerEnv, shell: false, windowsHide: true, encoding: 'utf8',
      timeout: options.timeoutMs || 30000, maxBuffer: options.maxBuffer || 1048576,
    });
    assertEndpoint();
    return result;
  }
  let probedImage = null;
  function probeNamespace(imageId) {
    if (probedImage === imageId) return;
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) refuse();
    const name = `te-workspace-probe-${crypto.randomUUID()}`;
    auditIntent('sandbox.workspace.namespace_probe.intent', name, { imageId });
    try {
      const result = runDocker(['run', '--rm', '--pull', 'never', '--name', name,
        '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--user', '10001:10001', '--pids-limit', '32', '--memory', '64m', '--memory-swap', '64m', '--cpus', '0.25',
        imageId, 'node', '-e', CONTAINER_PROBE]);
      if (result.error || result.status !== 0) refuse();
      const output = parseJson(result.stdout);
      if (!output || output.uid !== 10001 || output.gid !== 10001
          || signature(parseMap(output.uidMap)) !== signature(pinned.uidMap)
          || signature(parseMap(output.gidMap)) !== signature(pinned.gidMap)) refuse();
      probedImage = imageId;
    } finally {
      // This exact random name was created solely by this call; no broad reap.
      const result = runDocker(['container', 'inspect', name]);
      if (result.status === 0) {
        const removed = runDocker(['container', 'rm', '--force', name]);
        if (removed.error || removed.status !== 0) refuse();
      } else if (!/no such|not found/i.test(result.stderr || '')) refuse();
    }
  }
  function prepare({ workspace, imageId }) {
    assertEndpoint();
    probeNamespace(imageId);
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) refuse();
    const root = fs.realpathSync(disposableRoot);
    const parent = path.dirname(workspace);
    if (path.dirname(parent) !== root || !/^sbx-[a-f0-9]{20}$/.test(path.basename(parent)) || path.basename(workspace) !== 'workspace') refuse();
    const validated = new Map();
    for (const p of [disposableRoot, parent, workspace, path.join(workspace, 'artifacts')]) {
      const s = fs.lstatSync(p, { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(uid) || fs.realpathSync(p) !== p) refuse();
      if ((p === disposableRoot || p === parent) && (s.mode & 0o022n)) refuse();
      validated.set(p, s);
    }
    const bindingFile = path.join(parent, '.linux-workspace-binding.json');
    const binding = JSON.stringify({ version: 1, endpoint, peer: pinned });
    let bindingFd;
    try {
      try {
        auditIntent('sandbox.workspace.binding.intent', path.basename(parent), { endpoint });
        bindingFd = fs.openSync(bindingFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(bindingFd, binding);
        fs.fsyncSync(bindingFd);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        bindingFd = fs.openSync(bindingFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const s = fs.fstatSync(bindingFd);
        if (!s.isFile() || s.uid !== uid || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > 32768
            || fs.readFileSync(bindingFd, 'utf8') !== binding) refuse();
      }
    } finally { if (bindingFd !== undefined) fs.closeSync(bindingFd); }
    const entries = aclEntries(uid, mappedId(pinned.uidMap, 10001));
    for (const target of [workspace, path.join(workspace, 'artifacts')]) {
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const before = fs.fstatSync(fd, { bigint: true });
        assertDirectoryIdentity(validated.get(target), before, fs.lstatSync(target, { bigint: true }), uid);
        auditIntent('sandbox.workspace.acl.intent', path.basename(parent), { mappedUid: mappedId(pinned.uidMap, 10001), target: path.basename(target) });
        assertDirectoryIdentity(validated.get(target), before, fs.lstatSync(target, { bigint: true }), uid);
        // Passing the retained directory FD avoids a path-swap between lstat
        // and setfacl. There is no recursive traversal and no mode 0777.
        command('setfacl', ['--set', entries.join(','), '/proc/self/fd/3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
        verifyAcl(command('getfacl', ['--numeric', '--omit-header', '/proc/self/fd/3'], { stdio: ['ignore', 'pipe', 'pipe', fd] }), entries);
        assertDirectoryIdentity(validated.get(target), fs.fstatSync(fd, { bigint: true }), fs.lstatSync(target, { bigint: true }), uid);
      } finally { fs.closeSync(fd); }
    }
    assertEndpoint();
  }
  return Object.freeze({ pinnedEndpoint: endpoint, runDocker, prepare, assertEndpoint });
}

module.exports = { createLinuxSandboxWorkspace, parseMap, mappedId, aclEntries, verifyAcl, assertDirectoryIdentity, selectEndpoint };

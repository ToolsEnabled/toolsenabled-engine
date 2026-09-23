'use strict';

// Controller-owned collision backstop for source files under serial review.
// This is not a same-user security sandbox. It serializes freeze operations,
// pins open-file identities and bytes, makes ordinary writes fail, and makes a
// deliberate chmod/path replacement visible before verify or thaw succeeds.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'toolsenabled-source-freeze-v2';
const LOCK_DIRECTORY_NAME = '.toolsenabled-source-freeze.lock';
const ACTIVE_RECORD_RELATIVE = 'artifacts/source-freeze-active.json';
const OWNER_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_FILE_COUNT = 256;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const SOURCE_PREFIXES = Object.freeze([
  'src/', 'tools/', 'tests/', 'docs/', 'config/', 'packages/', 'plugins/',
  '.agents/skills/', '.agents/plugins/', '.cursor/skills/', '.claude/skills/'
]);
const SOURCE_ROOT_FILES = new Set([
  'AGENTS.md', 'STANDING-ORDERS.md', 'BUILD-QUEUE.md', 'package.json', 'package-lock.json'
]);
const FORBIDDEN_COMPONENTS = new Set([
  '.git', 'node_modules', 'state', 'logs', 'vault', 'vaults', 'profiles',
  'browser-profile', 'browser-profiles', 'cookies', 'credentials'
]);
const FORBIDDEN_EXTENSIONS = new Set([
  '.db', '.sqlite', '.sqlite3', '.pfx', '.p12', '.pem', '.key', '.lock'
]);

class SourceFreezeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceFreezeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SourceFreezeError(code, message);
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(root, candidate) {
  const rootKey = pathKey(root);
  const candidateKey = pathKey(candidate);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${path.sep}`);
}

function realRepoRoot(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    fail('SOURCE_FREEZE_REPO_REQUIRED', 'repoRoot must be a non-empty string');
  }
  const absolute = path.resolve(repoRoot);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    fail('SOURCE_FREEZE_REPO_MISSING', `repoRoot is unavailable: ${error.code || error.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('SOURCE_FREEZE_REPO_UNSAFE', 'repoRoot must be a real directory, not a link');
  }
  return fs.realpathSync.native(absolute);
}

function normalizeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    fail('SOURCE_FREEZE_PATH_REQUIRED', 'each frozen path must be a non-empty relative path');
  }
  if (path.isAbsolute(relativePath)) {
    fail('SOURCE_FREEZE_PATH_ABSOLUTE', `absolute paths are forbidden: ${relativePath}`);
  }
  const portable = relativePath.replace(/\\/g, '/');
  const normalized = path.posix.normalize(portable);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) {
    fail('SOURCE_FREEZE_PATH_TRAVERSAL', `path escapes or does not name a file: ${relativePath}`);
  }
  return normalized;
}

function assertFreezableSourcePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const allowed = SOURCE_ROOT_FILES.has(normalized) || SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  if (!allowed) {
    fail('SOURCE_FREEZE_NON_SOURCE_PATH', `path is outside the bounded source surface: ${normalized}`);
  }
  const components = normalized.split('/').map((item) => item.toLowerCase());
  if (components.some((item) => FORBIDDEN_COMPONENTS.has(item)) || normalized.toUpperCase() === 'KILLSWITCH') {
    fail('SOURCE_FREEZE_RUNTIME_PATH_REFUSED', `runtime, credential, or control path is forbidden: ${normalized}`);
  }
  const lower = normalized.toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(path.posix.extname(lower)) || lower.endsWith('/killswitch')
      || lower === '.env' || lower.endsWith('/.env')) {
    fail('SOURCE_FREEZE_RUNTIME_PATH_REFUSED', `runtime, credential, or control file is forbidden: ${normalized}`);
  }
  return normalized;
}

function assertNoLinkedComponents(repoRoot, absolutePath, { allowMissingLeaf = false } = {}) {
  if (!isWithin(repoRoot, absolutePath) || pathKey(repoRoot) === pathKey(absolutePath)) {
    fail('SOURCE_FREEZE_PATH_OUTSIDE_REPO', `path is outside the repository: ${absolutePath}`);
  }
  const segments = path.relative(repoRoot, absolutePath).split(path.sep).filter(Boolean);
  const inspectCount = allowMissingLeaf ? segments.length - 1 : segments.length;
  let cursor = repoRoot;
  for (let index = 0; index < inspectCount; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch {
      fail('SOURCE_FREEZE_PATH_MISSING', `path component is unavailable: ${segments.slice(0, index + 1).join('/')}`);
    }
    if (stat.isSymbolicLink()) {
      fail('SOURCE_FREEZE_REPARSE_REFUSED', `linked path component is forbidden: ${segments.slice(0, index + 1).join('/')}`);
    }
    if (index < inspectCount - 1 && !stat.isDirectory()) {
      fail('SOURCE_FREEZE_PATH_NOT_DIRECTORY', `parent component is not a directory: ${segments.slice(0, index + 1).join('/')}`);
    }
  }
  if (!allowMissingLeaf) {
    const real = fs.realpathSync.native(absolutePath);
    if (pathKey(real) !== pathKey(absolutePath)) {
      fail('SOURCE_FREEZE_REPARSE_REFUSED', `resolved path differs from requested path: ${path.relative(repoRoot, absolutePath)}`);
    }
  }
}

function resolveManifestPath(repoRoot, manifestPath, { mustExist = false } = {}) {
  if (typeof manifestPath !== 'string' || manifestPath.trim() === '') {
    fail('SOURCE_FREEZE_MANIFEST_REQUIRED', 'manifestPath must be a non-empty path');
  }
  const absolute = path.resolve(repoRoot, manifestPath);
  if (!isWithin(repoRoot, absolute) || pathKey(absolute) === pathKey(repoRoot)) {
    fail('SOURCE_FREEZE_MANIFEST_OUTSIDE_REPO', 'manifestPath must be below repoRoot');
  }
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
  const lower = relative.toLowerCase();
  if (!lower.startsWith('artifacts/') || !lower.endsWith('.json')
      || lower === ACTIVE_RECORD_RELATIVE.toLowerCase()
      || lower.includes('.staging-') || lower.endsWith('.recovery.json')
      || lower.endsWith('.released.json')) {
    fail('SOURCE_FREEZE_MANIFEST_PATH_REFUSED', 'manifest must be a non-reserved .json path below artifacts/');
  }
  const parent = path.dirname(absolute);
  if (!pathExistsOrThrow(parent, 'SOURCE_FREEZE_MANIFEST_PARENT_UNAVAILABLE', 'manifest parent')) {
    fail('SOURCE_FREEZE_MANIFEST_PARENT_MISSING', 'manifest parent must already exist');
  }
  assertNoLinkedComponents(repoRoot, parent);
  if (mustExist) assertNoLinkedComponents(repoRoot, absolute);
  else assertNoLinkedComponents(repoRoot, absolute, { allowMissingLeaf: true });
  return absolute;
}

function validateOwner(owner) {
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) {
    fail('SOURCE_FREEZE_OWNER_INVALID', 'owner must match [A-Za-z0-9._:-] and be 1-128 characters');
  }
  return owner;
}

function frozenModeFor(originalMode) {
  return originalMode & ~0o222;
}

function identityOf(stat) {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function pathExistsOrThrow(absolutePath, code, label) {
  try {
    fs.lstatSync(absolutePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    fail(code, `${label} could not be inspected; this does not mean it is absent: ${error.code || error.message}`);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readPinnedBytes(fd, stat, label, maxBytes = MAX_SOURCE_BYTES) {
  if (stat.size < 0n || stat.size > BigInt(maxBytes)) {
    fail('SOURCE_FREEZE_FILE_TOO_LARGE', `file exceeds the ${maxBytes}-byte read limit: ${label}`);
  }
  const size = Number(stat.size);
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) fail('SOURCE_FREEZE_SHORT_READ', `file ended during inspection: ${label}`);
    offset += count;
  }
  return bytes;
}

function assertPathStillPins(handle, { expectedNlink = 1n } = {}) {
  let pathStat;
  try {
    pathStat = fs.lstatSync(handle.absolute, { bigint: true });
  } catch {
    fail('SOURCE_FREEZE_PATH_REPLACED', `pinned path disappeared: ${handle.path}`);
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== expectedNlink
      || !sameIdentity(identityOf(pathStat), handle.identity)) {
    fail('SOURCE_FREEZE_PATH_REPLACED', `pinned path identity changed: ${handle.path}`);
  }
}

function openPinnedFile(repoRoot, relativePath, { requireReadOnly = false, label = null, maxBytes = MAX_SOURCE_BYTES } = {}) {
  const normalized = normalizeRelativePath(relativePath);
  const absolute = path.resolve(repoRoot, ...normalized.split('/'));
  assertNoLinkedComponents(repoRoot, absolute);
  let fd;
  try {
    fd = fs.openSync(absolute, 'r');
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) {
      fail('SOURCE_FREEZE_NOT_REGULAR_FILE', `only regular files may be pinned: ${normalized}`);
    }
    if (before.nlink !== 1n) {
      fail('SOURCE_FREEZE_HARDLINK_REFUSED', `hard-linked files may not be pinned: ${normalized}`);
    }
    const handle = { fd, path: normalized, absolute, identity: identityOf(before), maxBytes };
    assertPathStillPins(handle);
    const bytes = readPinnedBytes(fd, before, label || normalized, maxBytes);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(identityOf(after), handle.identity) || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
      fail('SOURCE_FREEZE_FILE_CHANGED_DURING_READ', `file changed while inspected: ${normalized}`);
    }
    if (requireReadOnly && (after.mode & 0o222n) !== 0n) {
      fail('SOURCE_FREEZE_NOT_READ_ONLY', `frozen file is writable: ${normalized}`);
    }
    return {
      ...handle,
      bytes,
      sha256: sha256Bytes(bytes),
      size: Number(after.size),
      mode: Number(after.mode & 0o777n)
    };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw error;
  }
}

function closePinned(handles) {
  for (const handle of handles) {
    try { fs.closeSync(handle.fd); } catch { /* preserve the operation result */ }
  }
}

function inspectPinnedAgain(handle, { requireReadOnly = false } = {}) {
  const before = fs.fstatSync(handle.fd, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || !sameIdentity(identityOf(before), handle.identity)) {
    fail('SOURCE_FREEZE_FILE_IDENTITY_DRIFT', `open file identity changed: ${handle.path}`);
  }
  assertPathStillPins(handle);
  const bytes = readPinnedBytes(handle.fd, before, handle.path, handle.maxBytes || MAX_SOURCE_BYTES);
  const after = fs.fstatSync(handle.fd, { bigint: true });
  if (!sameIdentity(identityOf(after), handle.identity) || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
    fail('SOURCE_FREEZE_FILE_CHANGED_DURING_READ', `file changed during verification: ${handle.path}`);
  }
  if (requireReadOnly && (after.mode & 0o222n) !== 0n) {
    fail('SOURCE_FREEZE_NOT_READ_ONLY', `frozen file is writable: ${handle.path}`);
  }
  return {
    sha256: sha256Bytes(bytes),
    size: Number(after.size),
    mode: Number(after.mode & 0o777n),
    identity: identityOf(after)
  };
}

function withRepoLock(repoRoot, action, operation) {
  const lockPath = path.join(repoRoot, LOCK_DIRECTORY_NAME);
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      fail('SOURCE_FREEZE_OPERATION_LOCKED', `another source-freeze operation or crash residue owns ${LOCK_DIRECTORY_NAME}`);
    }
    throw error;
  }
  const lockRecordPath = path.join(lockPath, 'record.json');
  const lockRecord = Buffer.from(`${JSON.stringify({
    schemaVersion: 'toolsenabled-source-freeze-lock-v1',
    pid: process.pid,
    action,
    nonce: crypto.randomBytes(16).toString('hex'),
    startedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
  try {
    const fd = fs.openSync(lockRecordPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, lockRecord);
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, 0o444);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    try { fs.rmdirSync(lockPath); } catch { /* retain fail-closed residue */ }
    throw error;
  }
  let operationError;
  try {
    return operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      fs.unlinkSync(lockRecordPath);
      fs.rmdirSync(lockPath);
    } catch (releaseError) {
      if (!operationError) {
        fail('SOURCE_FREEZE_LOCK_RELEASE_FAILED', `operation completed but its lock could not be removed: ${releaseError.code || releaseError.message}`);
      }
    }
  }
}

function atomicPublishExclusive(repoRoot, finalPath, bytes) {
  if (!isWithin(repoRoot, finalPath) || pathKey(repoRoot) === pathKey(finalPath)) {
    fail('SOURCE_FREEZE_PUBLICATION_OUTSIDE_REPO', 'publication path escaped repoRoot');
  }
  assertNoLinkedComponents(repoRoot, path.dirname(finalPath));
  const stagingPath = `${finalPath}.staging-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let fd;
  let linked = false;
  try {
    fd = fs.openSync(stagingPath, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o444);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(stagingPath, finalPath);
    linked = true;
    fs.unlinkSync(stagingPath);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve original failure */ }
    }
    if (linked) {
      try { fs.unlinkSync(finalPath); } catch { /* a valid, read-only residue fails closed */ }
    }
    if (fs.existsSync(stagingPath)) {
      try {
        fs.chmodSync(stagingPath, 0o600);
        fs.unlinkSync(stagingPath);
      } catch { /* a staging residue never exposes a partial final manifest */ }
    }
    if (error && error.code === 'EEXIST') {
      fail('SOURCE_FREEZE_MANIFEST_EXISTS', 'manifest already exists; refusing to overwrite it');
    }
    throw error;
  }
}

function removePinnedArtifact(repoRoot, artifactPath, expectedDigest) {
  const relative = path.relative(repoRoot, artifactPath).split(path.sep).join('/');
  const handle = openPinnedFile(repoRoot, relative, {
    requireReadOnly: true,
    label: 'source-freeze evidence record',
    maxBytes: MAX_MANIFEST_BYTES
  });
  try {
    const actual = inspectPinnedAgain(handle, { requireReadOnly: true });
    if (actual.sha256 !== expectedDigest) {
      fail('SOURCE_FREEZE_RECOVERY_DRIFT', 'recovery journal changed; refusing to remove it');
    }
    assertPathStillPins(handle);
    fs.unlinkSync(artifactPath);
  } finally {
    closePinned([handle]);
  }
}

function activeRecordPath(repoRoot) {
  const absolute = path.resolve(repoRoot, ...ACTIVE_RECORD_RELATIVE.split('/'));
  assertNoLinkedComponents(repoRoot, path.dirname(absolute));
  return absolute;
}

function activeRecordDocument(repoRoot, manifestAbsolute, manifestDigest, owner, handles) {
  return {
    schemaVersion: 'toolsenabled-source-freeze-active-v1',
    state: 'active',
    repoRoot,
    manifestPath: path.relative(repoRoot, manifestAbsolute).split(path.sep).join('/'),
    manifestSha256: manifestDigest,
    owner,
    createdAt: new Date().toISOString(),
    files: handles.map((handle) => ({ path: handle.path, identity: handle.identity }))
  };
}

function openAndValidateActiveRecord(repoRoot, manifestAbsolute, manifestDigest, manifest) {
  const absolute = activeRecordPath(repoRoot);
  if (!pathExistsOrThrow(absolute, 'SOURCE_FREEZE_ACTIVE_RECORD_UNAVAILABLE', 'active record')) {
    fail('SOURCE_FREEZE_ACTIVE_RECORD_MISSING', 'no repo-global active freeze record exists');
  }
  const handle = openPinnedFile(repoRoot, ACTIVE_RECORD_RELATIVE, {
    requireReadOnly: true,
    label: 'source-freeze active record',
    maxBytes: MAX_MANIFEST_BYTES
  });
  try {
    const current = inspectPinnedAgain(handle, { requireReadOnly: true });
    if (current.sha256 !== handle.sha256) {
      fail('SOURCE_FREEZE_ACTIVE_RECORD_CHANGED', 'active record changed after it was opened');
    }
    let record;
    try { record = JSON.parse(handle.bytes.toString('utf8')); } catch {
      fail('SOURCE_FREEZE_ACTIVE_RECORD_INVALID', 'active record is not valid JSON');
    }
    assertExactKeys(record,
      ['schemaVersion', 'state', 'repoRoot', 'manifestPath', 'manifestSha256', 'owner', 'createdAt', 'files'],
      'active record');
    if (record.schemaVersion !== 'toolsenabled-source-freeze-active-v1' || record.state !== 'active'
        || pathKey(record.repoRoot) !== pathKey(repoRoot) || record.owner !== manifest.owner
        || record.manifestSha256 !== manifestDigest || !Array.isArray(record.files)
        || record.files.length !== manifest.files.length) {
      fail('SOURCE_FREEZE_ACTIVE_RECORD_MISMATCH', 'active record does not match the pinned manifest');
    }
    const expectedRelative = path.relative(repoRoot, manifestAbsolute).split(path.sep).join('/');
    if (record.manifestPath !== expectedRelative) {
      fail('SOURCE_FREEZE_ACTIVE_RECORD_MISMATCH', 'manifest path is not the repo-global active manifest');
    }
    for (let index = 0; index < record.files.length; index += 1) {
      const actual = record.files[index];
      const expected = manifest.files[index];
      assertExactKeys(actual, ['path', 'identity'], 'active record file');
      assertExactKeys(actual.identity, ['dev', 'ino'], 'active record file identity');
      if (actual.path !== expected.path || !sameIdentity(actual.identity, expected.identity)) {
        fail('SOURCE_FREEZE_ACTIVE_RECORD_MISMATCH', `active record identity differs for ${expected.path}`);
      }
    }
    return { absolute, handle, digest: handle.sha256, record };
  } catch (error) {
    closePinned([handle]);
    throw error;
  }
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SOURCE_FREEZE_MANIFEST_INVALID', `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('SOURCE_FREEZE_MANIFEST_INVALID', `${label} has unexpected or missing fields`);
  }
}

function rollbackModes(handles, modeSelector) {
  const failures = [];
  for (const handle of handles) {
    try {
      fs.fchmodSync(handle.fd, modeSelector(handle));
      assertPathStillPins(handle);
    } catch (error) {
      failures.push(`${handle.path}:${error.code || error.message}`);
    }
  }
  return failures;
}

function freezeSources({ repoRoot, manifestPath, owner, paths }) {
  const root = realRepoRoot(repoRoot);
  return withRepoLock(root, 'freeze', () => {
    const normalizedOwner = validateOwner(owner);
    if (!Array.isArray(paths) || paths.length === 0) {
      fail('SOURCE_FREEZE_PATHS_REQUIRED', 'at least one path is required');
    }
    if (paths.length > MAX_FILE_COUNT) {
      fail('SOURCE_FREEZE_FILE_COUNT_LIMIT', `source set exceeds the ${MAX_FILE_COUNT}-file limit`);
    }
    const normalizedPaths = paths.map(assertFreezableSourcePath);
    const keys = normalizedPaths.map((item) => process.platform === 'win32' ? item.toLowerCase() : item);
    if (new Set(keys).size !== keys.length) {
      fail('SOURCE_FREEZE_DUPLICATE_PATH', 'the frozen path list contains a duplicate');
    }
    const manifestAbsolute = resolveManifestPath(root, manifestPath);
    const activeAbsolute = activeRecordPath(root);
    if (pathExistsOrThrow(activeAbsolute, 'SOURCE_FREEZE_ACTIVE_RECORD_UNAVAILABLE', 'active record')) {
      fail('SOURCE_FREEZE_ALREADY_ACTIVE', 'a repo-global source freeze is already active');
    }
    if (pathExistsOrThrow(manifestAbsolute, 'SOURCE_FREEZE_MANIFEST_UNAVAILABLE', 'manifest destination')) {
      fail('SOURCE_FREEZE_MANIFEST_EXISTS', 'manifest already exists; refusing to overwrite it');
    }
    if (pathExistsOrThrow(`${manifestAbsolute}.released`, 'SOURCE_FREEZE_RELEASE_UNAVAILABLE', 'released manifest')) {
      fail('SOURCE_FREEZE_RELEASE_EXISTS', 'released manifest already exists; use a new manifest name');
    }
    const recoveryPath = `${manifestAbsolute}.recovery`;
    if (pathExistsOrThrow(recoveryPath, 'SOURCE_FREEZE_RECOVERY_UNAVAILABLE', 'recovery journal')) {
      fail('SOURCE_FREEZE_RECOVERY_EXISTS', 'recovery journal already exists; inspect it and the operation lock before proceeding');
    }

    const handles = [];
    const changed = [];
    let recoveryDigest = null;
    let manifestPublished = false;
    let activeDigest = null;
    let activePublished = false;
    try {
      let remainingBytes = MAX_TOTAL_BYTES;
      for (const relative of normalizedPaths) {
        const handle = openPinnedFile(root, relative, {
          maxBytes: Math.min(MAX_SOURCE_BYTES, remainingBytes)
        });
        handles.push(handle);
        remainingBytes -= handle.size;
      }
      const recovery = {
        schemaVersion: 'toolsenabled-source-freeze-recovery-v1',
        owner: normalizedOwner,
        state: 'preparing',
        repoRoot: root,
        manifestPath: path.relative(root, manifestAbsolute).split(path.sep).join('/'),
        createdAt: new Date().toISOString(),
        files: handles.map((handle) => ({
          path: handle.path,
          sha256: handle.sha256,
          size: handle.size,
          originalMode: handle.mode,
          identity: handle.identity
        }))
      };
      const recoveryBytes = Buffer.from(`${JSON.stringify(recovery, null, 2)}\n`, 'utf8');
      if (recoveryBytes.length > MAX_MANIFEST_BYTES) {
        fail('SOURCE_FREEZE_MANIFEST_TOO_LARGE', 'recovery journal exceeds the manifest size limit');
      }
      atomicPublishExclusive(root, recoveryPath, recoveryBytes);
      recoveryDigest = sha256Bytes(recoveryBytes);
      for (const handle of handles) {
        fs.fchmodSync(handle.fd, frozenModeFor(handle.mode));
        changed.push(handle);
        const verified = inspectPinnedAgain(handle, { requireReadOnly: true });
        if (verified.sha256 !== handle.sha256 || verified.size !== handle.size) {
          fail('SOURCE_FREEZE_FILE_CHANGED_DURING_FREEZE', `file changed while frozen: ${handle.path}`);
        }
      }

      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        owner: normalizedOwner,
        state: 'active',
        repoRoot: root,
        frozenAt: new Date().toISOString(),
        files: handles.map((handle) => ({
          path: handle.path,
          sha256: handle.sha256,
          size: handle.size,
          originalMode: handle.mode,
          identity: handle.identity
        }))
      };
      const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      if (bytes.length > MAX_MANIFEST_BYTES) {
        fail('SOURCE_FREEZE_MANIFEST_TOO_LARGE', 'manifest exceeds the manifest size limit');
      }
      const manifestDigest = sha256Bytes(bytes);
      const activeBytes = Buffer.from(`${JSON.stringify(
        activeRecordDocument(root, manifestAbsolute, manifestDigest, normalizedOwner, handles), null, 2
      )}\n`, 'utf8');
      if (activeBytes.length > MAX_MANIFEST_BYTES) {
        fail('SOURCE_FREEZE_MANIFEST_TOO_LARGE', 'active record exceeds the manifest size limit');
      }
      activeDigest = sha256Bytes(activeBytes);
      atomicPublishExclusive(root, activeAbsolute, activeBytes);
      activePublished = true;
      atomicPublishExclusive(root, manifestAbsolute, bytes);
      manifestPublished = true;
      let recoveryJournalRetained = false;
      try {
        removePinnedArtifact(root, recoveryPath, recoveryDigest);
      } catch {
        recoveryJournalRetained = true;
      }
      const result = {
        ok: true,
        manifestPath: manifestAbsolute,
        manifestSha256: manifestDigest,
        owner: normalizedOwner,
        fileCount: handles.length
      };
      if (recoveryJournalRetained) {
        result.recoveryJournalPath = recoveryPath;
        result.recoveryJournalSha256 = recoveryDigest;
      }
      return result;
    } catch (error) {
      if (manifestPublished) throw error;
      if (activePublished) {
        try { removePinnedArtifact(root, activeAbsolute, activeDigest); } catch { /* retained fail-closed */ }
      }
      const failures = rollbackModes(changed, (handle) => handle.mode);
      if (failures.length > 0) {
        const wrapped = new SourceFreezeError('SOURCE_FREEZE_ROLLBACK_FAILED',
          `freeze failed and mode rollback was incomplete: ${failures.join(', ')}`);
        wrapped.recoveryJournalPath = recoveryDigest ? recoveryPath : null;
        wrapped.cause = error;
        throw wrapped;
      }
      if (recoveryDigest) {
        try { removePinnedArtifact(root, recoveryPath, recoveryDigest); } catch { /* retained for diagnosis */ }
      }
      throw error;
    } finally {
      closePinned(handles);
    }
  });
}

function parseAndValidateManifest(handle, repoRoot, expectedDigest) {
  if (!SHA256_RE.test(expectedDigest || '')) {
    fail('SOURCE_FREEZE_DIGEST_REQUIRED', 'an exact lowercase manifest SHA-256 is required');
  }
  const actual = inspectPinnedAgain(handle, { requireReadOnly: true });
  if (handle.bytes.length > MAX_MANIFEST_BYTES) {
    fail('SOURCE_FREEZE_MANIFEST_TOO_LARGE', 'manifest exceeds the manifest size limit');
  }
  const digest = sha256Bytes(handle.bytes);
  if (!crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expectedDigest, 'hex'))) {
    fail('SOURCE_FREEZE_DIGEST_MISMATCH', 'manifest digest does not match the pinned digest');
  }
  if (actual.sha256 !== digest || actual.size !== handle.bytes.length) {
    fail('SOURCE_FREEZE_MANIFEST_CHANGED', 'manifest changed after it was opened');
  }
  let manifest;
  try {
    manifest = JSON.parse(handle.bytes.toString('utf8'));
  } catch {
    fail('SOURCE_FREEZE_MANIFEST_INVALID', 'manifest is not valid JSON');
  }
  assertExactKeys(manifest,
    ['schemaVersion', 'owner', 'state', 'repoRoot', 'frozenAt', 'files'], 'manifest');
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || manifest.state !== 'active'
      || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILE_COUNT
      || typeof manifest.frozenAt !== 'string' || Number.isNaN(Date.parse(manifest.frozenAt))) {
    fail('SOURCE_FREEZE_MANIFEST_INVALID', 'manifest shape or schema is invalid');
  }
  validateOwner(manifest.owner);
  if (pathKey(manifest.repoRoot) !== pathKey(repoRoot)) {
    fail('SOURCE_FREEZE_REPO_MISMATCH', 'manifest belongs to a different repository root');
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const expected of manifest.files) {
    assertExactKeys(expected, ['path', 'sha256', 'size', 'originalMode', 'identity'], 'manifest file entry');
    assertExactKeys(expected.identity, ['dev', 'ino'], 'manifest file identity');
    const relative = assertFreezableSourcePath(expected.path);
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (seen.has(key)) fail('SOURCE_FREEZE_MANIFEST_INVALID', 'manifest contains duplicate paths');
    seen.add(key);
    if (!SHA256_RE.test(expected.sha256 || '') || !Number.isSafeInteger(expected.size) || expected.size < 0
        || !Number.isSafeInteger(expected.originalMode) || expected.originalMode < 0 || expected.originalMode > 0o777
        || !expected.identity || !/^\d+$/.test(expected.identity.dev || '') || !/^\d+$/.test(expected.identity.ino || '')) {
      fail('SOURCE_FREEZE_MANIFEST_INVALID', `manifest metadata is invalid for ${relative}`);
    }
    totalBytes += expected.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      fail('SOURCE_FREEZE_TOTAL_TOO_LARGE', `manifest source set exceeds the ${MAX_TOTAL_BYTES}-byte aggregate limit`);
    }
  }
  return { manifest, digest };
}

function openManifest(repoRoot, manifestPath, expectedDigest) {
  const absolute = resolveManifestPath(repoRoot, manifestPath, { mustExist: true });
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
  const handle = openPinnedFile(repoRoot, relative, {
    requireReadOnly: true,
    label: 'source-freeze manifest',
    maxBytes: MAX_MANIFEST_BYTES
  });
  try {
    const parsed = parseAndValidateManifest(handle, repoRoot, expectedDigest);
    return { handle, absolute, ...parsed };
  } catch (error) {
    closePinned([handle]);
    throw error;
  }
}

function openAndVerifySources(repoRoot, manifest) {
  const handles = [];
  try {
    for (const expected of manifest.files) {
      const handle = openPinnedFile(repoRoot, expected.path, { requireReadOnly: true });
      handles.push(handle);
      const actual = inspectPinnedAgain(handle, { requireReadOnly: true });
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size
          || !sameIdentity(actual.identity, expected.identity)) {
        fail('SOURCE_FREEZE_CONTENT_DRIFT', `frozen content or identity changed: ${expected.path}`);
      }
    }
    return handles;
  } catch (error) {
    closePinned(handles);
    throw error;
  }
}

function verifySources({ repoRoot, manifestPath, manifestSha256 }) {
  const root = realRepoRoot(repoRoot);
  return withRepoLock(root, 'verify', () => {
    const loaded = openManifest(root, manifestPath, manifestSha256);
    const active = openAndValidateActiveRecord(root, loaded.absolute, loaded.digest, loaded.manifest);
    let sources = [];
    try {
      sources = openAndVerifySources(root, loaded.manifest);
      return {
        ok: true,
        manifestPath: loaded.absolute,
        manifestSha256: loaded.digest,
        owner: loaded.manifest.owner,
        fileCount: loaded.manifest.files.length
      };
    } finally {
      closePinned(sources);
      closePinned([active.handle]);
      closePinned([loaded.handle]);
    }
  });
}

function releaseManifestNoClobber(loaded) {
  const releasedPath = `${loaded.absolute}.released`;
  assertPathStillPins(loaded.handle);
  try {
    fs.linkSync(loaded.absolute, releasedPath);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      fail('SOURCE_FREEZE_RELEASE_EXISTS', 'released manifest destination already exists');
    }
    throw error;
  }
  try {
    const linked = fs.lstatSync(releasedPath, { bigint: true });
    if (!sameIdentity(identityOf(linked), loaded.handle.identity)) {
      fail('SOURCE_FREEZE_RELEASE_IDENTITY_MISMATCH', 'released manifest link does not name the pinned manifest');
    }
    assertPathStillPins(loaded.handle, { expectedNlink: 2n });
    fs.unlinkSync(loaded.absolute);
  } catch (error) {
    try { fs.unlinkSync(releasedPath); } catch { /* leave a visible fail-closed residue */ }
    throw error;
  }
  return releasedPath;
}

function thawSources({ repoRoot, manifestPath, owner, manifestSha256 }) {
  const root = realRepoRoot(repoRoot);
  return withRepoLock(root, 'thaw', () => {
    const normalizedOwner = validateOwner(owner);
    const loaded = openManifest(root, manifestPath, manifestSha256);
    const active = openAndValidateActiveRecord(root, loaded.absolute, loaded.digest, loaded.manifest);
    let sources = [];
    const restored = [];
    const releaseRecoveryPath = `${loaded.absolute}.release-recovery`;
    let releaseRecoveryDigest = null;
    let released = false;
    let activeRemoved = false;
    try {
      if (loaded.manifest.owner !== normalizedOwner) {
        fail('SOURCE_FREEZE_OWNER_MISMATCH', 'only the manifest owner may thaw this source set');
      }
      sources = openAndVerifySources(root, loaded.manifest);
      if (pathExistsOrThrow(releaseRecoveryPath, 'SOURCE_FREEZE_RELEASE_RECOVERY_UNAVAILABLE', 'release recovery journal')) {
        fail('SOURCE_FREEZE_RELEASE_RECOVERY_EXISTS', 'release recovery journal already exists; inspect it before thaw');
      }
      const releaseRecovery = {
        schemaVersion: 'toolsenabled-source-freeze-release-recovery-v1',
        state: 'releasing',
        repoRoot: root,
        owner: normalizedOwner,
        manifestPath: path.relative(root, loaded.absolute).split(path.sep).join('/'),
        manifestSha256: loaded.digest,
        activeRecordSha256: active.digest,
        createdAt: new Date().toISOString(),
        files: loaded.manifest.files.map((expected) => ({
          path: expected.path,
          sha256: expected.sha256,
          frozenMode: frozenModeFor(expected.originalMode),
          restoreMode: expected.originalMode,
          identity: expected.identity
        }))
      };
      const releaseRecoveryBytes = Buffer.from(`${JSON.stringify(releaseRecovery, null, 2)}\n`, 'utf8');
      if (releaseRecoveryBytes.length > MAX_MANIFEST_BYTES) {
        fail('SOURCE_FREEZE_MANIFEST_TOO_LARGE', 'release recovery journal exceeds the manifest size limit');
      }
      releaseRecoveryDigest = sha256Bytes(releaseRecoveryBytes);
      atomicPublishExclusive(root, releaseRecoveryPath, releaseRecoveryBytes);
      for (let index = 0; index < sources.length; index += 1) {
        const handle = sources[index];
        const expected = loaded.manifest.files[index];
        const finalCheck = inspectPinnedAgain(handle, { requireReadOnly: true });
        if (finalCheck.sha256 !== expected.sha256 || finalCheck.size !== expected.size
            || !sameIdentity(finalCheck.identity, expected.identity)) {
          fail('SOURCE_FREEZE_CONTENT_DRIFT', `frozen content or identity changed before thaw: ${expected.path}`);
        }
        fs.fchmodSync(handle.fd, expected.originalMode);
        restored.push({
          handle,
          originalMode: expected.originalMode,
          frozenMode: frozenModeFor(expected.originalMode)
        });
        assertPathStillPins(handle);
      }
      const releasedManifestPath = releaseManifestNoClobber(loaded);
      released = true;
      removePinnedArtifact(root, active.absolute, active.digest);
      activeRemoved = true;
      let releaseRecoveryRetained = false;
      try { removePinnedArtifact(root, releaseRecoveryPath, releaseRecoveryDigest); } catch {
        releaseRecoveryRetained = true;
      }
      const result = {
        ok: true,
        releasedManifestPath,
        manifestSha256: loaded.digest,
        owner: normalizedOwner,
        fileCount: sources.length
      };
      if (releaseRecoveryRetained) {
        result.releaseRecoveryPath = releaseRecoveryPath;
        result.releaseRecoverySha256 = releaseRecoveryDigest;
      }
      return result;
    } catch (error) {
      const frozenModes = new Map(restored.map((item) => [item.handle.fd, item.frozenMode]));
      const failures = rollbackModes(
        restored.map((item) => item.handle),
        (handle) => frozenModes.get(handle.fd)
      );
      if (failures.length > 0) {
        const wrapped = new SourceFreezeError('SOURCE_FREEZE_THAW_ROLLBACK_FAILED',
          `thaw failed and read-only rollback was incomplete: ${failures.join(', ')}`);
        wrapped.cause = error;
        wrapped.releaseRecoveryPath = releaseRecoveryPath;
        wrapped.releaseRecoverySha256 = releaseRecoveryDigest;
        throw wrapped;
      }
      if (!released && releaseRecoveryDigest) {
        try {
          removePinnedArtifact(root, releaseRecoveryPath, releaseRecoveryDigest);
        } catch {
          error.releaseRecoveryPath = releaseRecoveryPath;
          error.releaseRecoverySha256 = releaseRecoveryDigest;
        }
      }
      if (released && !activeRemoved) error.releaseRecoveryPath = releaseRecoveryPath;
      throw error;
    } finally {
      closePinned(sources);
      closePinned([active.handle]);
      closePinned([loaded.handle]);
    }
  });
}

function sourceFreezeStatus({ repoRoot }) {
  const root = realRepoRoot(repoRoot);
  const lockPath = path.join(root, LOCK_DIRECTORY_NAME);
  let operationLock = null;
  if (pathExistsOrThrow(lockPath, 'SOURCE_FREEZE_LOCK_UNAVAILABLE', 'operation lock')) {
    const lockStat = fs.lstatSync(lockPath);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
      fail('SOURCE_FREEZE_LOCK_UNSAFE', 'operation lock path is not a real directory');
    }
    const recordPath = path.join(lockPath, 'record.json');
    let record;
    try {
      const bytes = fs.readFileSync(recordPath);
      if (bytes.length > 64 * 1024) fail('SOURCE_FREEZE_LOCK_INVALID', 'lock record is oversized');
      record = JSON.parse(bytes.toString('utf8'));
      assertExactKeys(record, ['schemaVersion', 'pid', 'action', 'nonce', 'startedAt'], 'lock record');
      if (record.schemaVersion !== 'toolsenabled-source-freeze-lock-v1'
          || !Number.isSafeInteger(record.pid) || record.pid <= 0
          || !['freeze', 'verify', 'thaw'].includes(record.action)
          || !/^[a-f0-9]{32}$/.test(record.nonce || '') || Number.isNaN(Date.parse(record.startedAt))) {
        fail('SOURCE_FREEZE_LOCK_INVALID', 'lock record shape is invalid');
      }
    } catch (error) {
      if (error instanceof SourceFreezeError) throw error;
      fail('SOURCE_FREEZE_LOCK_INVALID', 'operation lock exists without a readable valid record');
    }
    let pidAppearsAlive = true;
    try { process.kill(record.pid, 0); } catch (error) {
      if (error && error.code === 'ESRCH') pidAppearsAlive = false;
      else if (!error || error.code !== 'EPERM') {
        fail('SOURCE_FREEZE_LOCK_OWNER_UNMEASURED',
          `lock owner liveness could not be measured: ${error && (error.code || error.message)}`);
      }
    }
    operationLock = { ...record, pidAppearsAlive };
  }

  const activePath = activeRecordPath(root);
  let activeFreeze = null;
  if (pathExistsOrThrow(activePath, 'SOURCE_FREEZE_ACTIVE_RECORD_UNAVAILABLE', 'active record')) {
    const handle = openPinnedFile(root, ACTIVE_RECORD_RELATIVE, {
      requireReadOnly: true,
      label: 'source-freeze active record',
      maxBytes: MAX_MANIFEST_BYTES
    });
    try {
      let record;
      try { record = JSON.parse(handle.bytes.toString('utf8')); } catch {
        fail('SOURCE_FREEZE_ACTIVE_RECORD_INVALID', 'active record is not valid JSON');
      }
      assertExactKeys(record,
        ['schemaVersion', 'state', 'repoRoot', 'manifestPath', 'manifestSha256', 'owner', 'createdAt', 'files'],
        'active record');
      if (record.schemaVersion !== 'toolsenabled-source-freeze-active-v1' || record.state !== 'active'
          || typeof record.manifestPath !== 'string' || !SHA256_RE.test(record.manifestSha256 || '')
          || !Array.isArray(record.files)) {
        fail('SOURCE_FREEZE_ACTIVE_RECORD_INVALID', 'active record shape is invalid');
      }
      activeFreeze = {
        manifestPath: record.manifestPath,
        manifestSha256: record.manifestSha256,
        owner: record.owner,
        fileCount: record.files.length,
        activeRecordSha256: handle.sha256
      };
    } finally {
      closePinned([handle]);
    }
  }
  return { ok: true, repoRoot: root, operationLock, activeFreeze };
}

module.exports = {
  SCHEMA_VERSION,
  LOCK_DIRECTORY_NAME,
  ACTIVE_RECORD_RELATIVE,
  SourceFreezeError,
  freezeSources,
  verifySources,
  thawSources,
  sourceFreezeStatus,
  sha256Bytes,
  _testing: {
    isWithin,
    normalizeRelativePath,
    openPinnedFile,
    inspectPinnedAgain,
    withRepoLock,
    atomicPublishExclusive,
    frozenModeFor
  }
};

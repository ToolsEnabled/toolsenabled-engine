'use strict';

// This is a pre-activation contract, not a production backup runner.  The
// duty itself is permanently inert; the only writer is a test fixture seam
// which accepts paths below the operating system temporary directory.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DEFAULT_RETENTION = 7;
const REPOSITORY_STATE_DIRECTORY = 'state';
const MANAGED_BACKUP_DIRECTORY = 'backups';
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_DIGEST_FILE = 'manifest.sha256';
const SNAPSHOT_NAME = /^snapshot-(\d{8}T\d{6}Z)$/;
const MAX_FILE_BYTES = 1024 * 1024;
const INSPECTION_UNAVAILABLE_CODES = new Set(['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']);

// The inclusion set is intentionally narrow.  A future owner-approved
// production implementation must not widen it implicitly.
const INCLUDED_EXTENSIONS = Object.freeze(['.js', '.json', '.md', '.txt', '.ts', '.yaml', '.yml']);

// Every category that may carry credentials or authenticated-session state is
// denied before any file is read or copied.  Tests exercise every entry below.
const EXCLUDED_PATH_SEGMENTS = Object.freeze([
  'credentials',
  'secrets',
  'vault',
  'vaults',
  'profiles',
  'browser-profile',
  'chrome',
  'edge',
  'firefox',
  'sessions',
  'session-state',
  '.session'
]);
const EXCLUDED_FILE_NAMES = Object.freeze([
  '.env',
  '.env.local',
  'credentials.json',
  'secrets.json',
  'cookies',
  'login data',
  'local state',
  'web data',
  'session.json',
  'session-state.json'
]);
const EXCLUDED_EXTENSIONS = Object.freeze(['.key', '.kdbx', '.p12', '.pem', '.pfx']);
const SENSITIVE_CONTENT_MARKERS = Object.freeze([
  'credential',
  'password',
  'passphrase',
  'private key',
  'authorization'
]);

const BACKUP_DUTY_POLICY = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  mode: 'default-off',
  cadenceMs: 86_400_000,
  destination: Object.freeze({
    kind: 'repository-state',
    stateDirectory: REPOSITORY_STATE_DIRECTORY,
    backupDirectory: MANAGED_BACKUP_DIRECTORY,
    resolvedAtRuntime: true
  }),
  retention: Object.freeze({ maxSnapshots: DEFAULT_RETENTION }),
  includedExtensions: INCLUDED_EXTENSIONS,
  exclusions: Object.freeze({
    pathSegments: EXCLUDED_PATH_SEGMENTS,
    fileNames: EXCLUDED_FILE_NAMES,
    extensions: EXCLUDED_EXTENSIONS,
    contentMarkers: SENSITIVE_CONTENT_MARKERS
  }),
  integrity: Object.freeze({ manifest: MANIFEST_FILE, manifestDigest: MANIFEST_DIGEST_FILE, algorithm: 'sha256' }),
  scheduledTaskRegistration: false,
  productionActivation: 'owner-required'
});

function frozen(value) {
  return Object.freeze(value);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function relativeSegments(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
  const segments = relativePath.replace(/\\/g, '/').split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return null;
  return segments;
}

function isExcludedRelativePath(relativePath) {
  const segments = relativeSegments(relativePath);
  if (segments === null) return true;
  const lowered = segments.map(segment => segment.toLowerCase());
  const fileName = lowered[lowered.length - 1];
  const extension = path.extname(fileName);
  return lowered.some(segment => EXCLUDED_PATH_SEGMENTS.includes(segment))
    || EXCLUDED_FILE_NAMES.includes(fileName)
    || EXCLUDED_EXTENSIONS.includes(extension);
}

function hasSensitiveContent(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.includes(0)) return true;
  const text = bytes.toString('utf8').toLowerCase();
  return SENSITIVE_CONTENT_MARKERS.some(marker => text.includes(marker));
}

function isIncludedRelativePath(relativePath) {
  if (isExcludedRelativePath(relativePath)) return false;
  return INCLUDED_EXTENSIONS.includes(path.extname(relativePath).toLowerCase());
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isInsideOrSame(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isSamePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function isInspectionUnavailable(error) {
  return Boolean(error && INSPECTION_UNAVAILABLE_CODES.has(error.code));
}

function inspectionUnavailableResult(error) {
  return frozen({
    status: 'inspection-unavailable',
    verified: false,
    code: 'BACKUP_INSPECTION_UNAVAILABLE',
    causeCode: error.code,
    message: 'Backup inspection could not complete; this does not claim that the backup is absent.'
  });
}

// This is intentionally a resolver rather than a stored absolute path.  The
// future production implementation gets one ToolsEnabled-owned destination
// below its state root, regardless of which machine hosts the repository.
function resolveManagedBackupDestination({ repoRoot = path.resolve(__dirname, '..', '..'), stateRoot } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
  if (stateRoot !== undefined && (typeof stateRoot !== 'string' || stateRoot.length === 0)) return null;
  const repository = path.resolve(repoRoot);
  const state = path.resolve(stateRoot || path.join(repository, REPOSITORY_STATE_DIRECTORY));
  const destination = path.resolve(state, MANAGED_BACKUP_DIRECTORY);
  if (!isInsideOrSame(repository, state) || !isInside(state, destination)) return null;
  return destination;
}

function testOnlyPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(candidate);
  return isInside(tempRoot, resolved) ? resolved : null;
}

// The fixture writer and pruner must not traverse a link anywhere between the
// temporary root and their target.  Existing roots are required so there is no
// implicit creation through a potentially replaced parent path.
function isExistingPathWithoutLinks(root, candidate, expectedKind) {
  try {
    const boundary = path.resolve(root);
    const target = path.resolve(candidate);
    if (!isInsideOrSame(boundary, target)) return false;
    const relative = path.relative(boundary, target);
    const segments = relative === '' ? [] : relative.split(path.sep);
    let current = boundary;
    for (let index = 0; index <= segments.length; index += 1) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      const isLast = index === segments.length;
      if (!isLast && !stat.isDirectory()) return false;
      if (isLast && expectedKind === 'directory' && !stat.isDirectory()) return false;
      if (isLast && expectedKind === 'file' && !stat.isFile()) return false;
      if (!isLast) current = path.join(current, segments[index]);
    }
    return true;
  } catch (error) {
    // Absence is an ordinary negative observation. Resource exhaustion and I/O
    // failures are not: let the public operation report that it could not tell.
    if (isInspectionUnavailable(error)) throw error;
    return false;
  }
}

function safeTestOnlyDirectory(candidate) {
  const resolved = testOnlyPath(candidate);
  if (resolved === null) return null;
  return isExistingPathWithoutLinks(path.resolve(os.tmpdir()), resolved, 'directory') ? resolved : null;
}

function isDirectoryTreeWithoutLinks(managedRoot, directory) {
  if (!isInside(managedRoot, directory) || !isExistingPathWithoutLinks(managedRoot, directory, 'directory')) return false;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.resolve(directory, entry.name);
      if (!isInside(directory, child)) return false;
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!isDirectoryTreeWithoutLinks(managedRoot, child)) return false;
      } else if (!stat.isFile()) {
        return false;
      }
    }
    return true;
  } catch (error) {
    if (isInspectionUnavailable(error)) throw error;
    return false;
  }
}

function snapshotTimestamp(snapshotName) {
  if (typeof snapshotName !== 'string') return null;
  const match = SNAPSHOT_NAME.exec(snapshotName);
  if (match === null) return null;
  const stamp = match[1];
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? time : null;
}

function inactiveResult() {
  return frozen({
    schemaVersion: SCHEMA_VERSION,
    kind: 'backup-duty',
    status: 'inactive',
    mode: 'default-off',
    writes: 0,
    scheduledTaskRegistered: false,
    productionActivation: 'owner-required'
  });
}

// The duty host may call this safely on every tick.  It deliberately takes no
// parameters so a caller cannot smuggle an activation or destination into it.
function runBackupDuty() {
  return inactiveResult();
}

function walkIncludedFiles(sourceRoot) {
  const selected = [];

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(sourceRoot, absolute).replace(/\\/g, '/');
      if (isExcludedRelativePath(relative)) continue;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile() || !isIncludedRelativePath(relative) || stat.size > MAX_FILE_BYTES) continue;
      const bytes = fs.readFileSync(absolute);
      if (!hasSensitiveContent(bytes)) selected.push(frozen({ relativePath: relative, bytes }));
    }
  }

  walk(sourceRoot);
  return frozen(selected);
}

function manifestFor(snapshotName, files) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'test-only-backup-manifest',
    snapshotName,
    createdAt: new Date(snapshotTimestamp(snapshotName)).toISOString(),
    artifacts: files.map(file => ({ path: file.relativePath, bytes: file.bytes.byteLength, sha256: sha256(file.bytes) }))
  };
}

function verifyWrittenBackup(destinationRoot, snapshotName) {
  try {
    const destination = safeTestOnlyDirectory(destinationRoot);
    if (destination === null || snapshotTimestamp(snapshotName) === null) return frozen({ status: 'unavailable', verified: false });
    const snapshotRoot = path.resolve(destination, snapshotName);
    if (!isInside(destination, snapshotRoot) || !isExistingPathWithoutLinks(destination, snapshotRoot, 'directory')) {
      return frozen({ status: 'integrity-failed', verified: false });
    }
    const manifestPath = path.resolve(snapshotRoot, MANIFEST_FILE);
    const manifestDigestPath = path.resolve(snapshotRoot, MANIFEST_DIGEST_FILE);
    if (!isInside(snapshotRoot, manifestPath) || !isInside(snapshotRoot, manifestDigestPath)
      || !isExistingPathWithoutLinks(snapshotRoot, manifestPath, 'file')
      || !isExistingPathWithoutLinks(snapshotRoot, manifestDigestPath, 'file')) {
      return frozen({ status: 'integrity-failed', verified: false });
    }
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifestDigest = fs.readFileSync(manifestDigestPath, 'utf8').trim();
    if (sha256(manifestBytes) !== manifestDigest) return frozen({ status: 'integrity-failed', verified: false });
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || manifest.kind !== 'test-only-backup-manifest'
      || manifest.snapshotName !== snapshotName || !Array.isArray(manifest.artifacts)) {
      return frozen({ status: 'integrity-failed', verified: false });
    }
    for (const artifact of manifest.artifacts) {
      if (!artifact || typeof artifact.path !== 'string' || !Number.isSafeInteger(artifact.bytes)
        || artifact.bytes < 0 || typeof artifact.sha256 !== 'string' || !isIncludedRelativePath(artifact.path)) {
        return frozen({ status: 'integrity-failed', verified: false });
      }
      const target = path.resolve(snapshotRoot, artifact.path);
      if (!isInside(snapshotRoot, target) || !isExistingPathWithoutLinks(snapshotRoot, target, 'file')) {
        return frozen({ status: 'integrity-failed', verified: false });
      }
      const bytes = fs.readFileSync(target);
      if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256 || hasSensitiveContent(bytes)) {
        return frozen({ status: 'integrity-failed', verified: false });
      }
    }
    return frozen({ status: 'verified', verified: true, artifactCount: manifest.artifacts.length });
  } catch (error) {
    if (isInspectionUnavailable(error)) return inspectionUnavailableResult(error);
    return frozen({ status: 'integrity-failed', verified: false });
  }
}

function snapshotDirectories(destination) {
  try {
    if (!isExistingPathWithoutLinks(path.resolve(os.tmpdir()), destination, 'directory')) return null;
    const snapshots = [];
    for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
      const time = snapshotTimestamp(entry.name);
      if (time === null) continue;
      const snapshotRoot = path.resolve(destination, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory() || !isInside(destination, snapshotRoot)
        || !isExistingPathWithoutLinks(destination, snapshotRoot, 'directory')) {
        return null;
      }
      snapshots.push(frozen({ name: entry.name, time }));
    }
    return frozen(snapshots.sort((left, right) => left.time - right.time || left.name.localeCompare(right.name)));
  } catch {
    return null;
  }
}

function pruneTestOnlyRetention({ destinationRoot, managedDestinationRoot, maxSnapshots } = {}) {
  const destination = safeTestOnlyDirectory(destinationRoot);
  const managedDestination = safeTestOnlyDirectory(managedDestinationRoot);
  if (destination === null || managedDestination === null || !isSamePath(destination, managedDestination)
    || !Number.isSafeInteger(maxSnapshots) || maxSnapshots < 1 || maxSnapshots > DEFAULT_RETENTION) {
    return frozen({ status: 'refused', removed: 0 });
  }
  const snapshots = snapshotDirectories(destination);
  if (snapshots === null) return frozen({ status: 'refused', removed: 0 });
  const toRemove = snapshots.slice(0, Math.max(0, snapshots.length - maxSnapshots));
  const removalRoots = toRemove.map(snapshot => path.resolve(destination, snapshot.name));
  if (removalRoots.some(snapshotRoot => !isInside(managedDestination, snapshotRoot)
    || !isDirectoryTreeWithoutLinks(managedDestination, snapshotRoot))) {
    return frozen({ status: 'refused', removed: 0 });
  }
  try {
    for (const snapshotRoot of removalRoots) fs.rmSync(snapshotRoot, { recursive: true, force: false });
    return frozen({ status: 'pruned', removed: removalRoots.length, retained: snapshots.length - removalRoots.length });
  } catch {
    // A recursive removal can have changed the tree before throwing, so zero
    // would be a fabricated count rather than an observation.
    return frozen({ status: 'refused', removed: null });
  }
}

// This writer is intentionally not the duty runner.  It exists only so the
// deterministic manifest, retention, and integrity contracts can be exercised
// with throwaway fixtures.  Both read and write roots must be below os.tmpdir.
function writeTestOnlyBackup({ testOnly, sourceRoot, destinationRoot, snapshotName, maxSnapshots = DEFAULT_RETENTION } = {}) {
  const source = safeTestOnlyDirectory(sourceRoot);
  const destination = safeTestOnlyDirectory(destinationRoot);
  if (testOnly !== true || source === null || destination === null || snapshotTimestamp(snapshotName) === null) {
    return frozen({ status: 'refused', written: false });
  }
  let mutationStarted = false;
  try {
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return frozen({ status: 'refused', written: false });
    const files = walkIncludedFiles(source);
    // An empty selection cannot demonstrate that a backup captured anything.
    // Refuse rather than allowing a zero-artifact manifest to certify itself.
    if (files.length === 0) return frozen({ status: 'refused', written: false });
    const staging = path.join(destination, `.${snapshotName}.staging`);
    const finalSnapshot = path.join(destination, snapshotName);
    if (fs.existsSync(staging) || fs.existsSync(finalSnapshot)) return frozen({ status: 'refused', written: false });
    mutationStarted = true;
    fs.mkdirSync(staging, { recursive: true });
    for (const file of files) {
      const target = path.resolve(staging, file.relativePath);
      if (!isInside(staging, target)) throw new Error('invalid artifact path');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes, { flag: 'wx' });
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifestFor(snapshotName, files)), 'utf8');
    fs.writeFileSync(path.join(staging, MANIFEST_FILE), manifestBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(staging, MANIFEST_DIGEST_FILE), `${sha256(manifestBytes)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(staging, finalSnapshot);
    const integrity = verifyWrittenBackup(destination, snapshotName);
    if (!integrity.verified) {
      fs.rmSync(finalSnapshot, { recursive: true, force: true });
      return frozen({ status: 'integrity-failed', written: false });
    }
    const retention = pruneTestOnlyRetention({
      destinationRoot: destination,
      managedDestinationRoot: destination,
      maxSnapshots
    });
    if (retention.status !== 'pruned') {
      return frozen({ status: 'retention-failed', written: true, snapshotName, artifactCount: files.length, integrity: integrity.status, retention });
    }
    return frozen({ status: 'written', written: true, snapshotName, artifactCount: files.length, integrity: integrity.status, retention });
  } catch {
    // Once mutation starts, an exception does not establish that nothing was
    // written (a recursive cleanup can also fail after changing the tree).
    return frozen({ status: 'refused', written: mutationStarted ? null : false });
  }
}

module.exports = frozen({
  SCHEMA_VERSION,
  DEFAULT_RETENTION,
  BACKUP_DUTY_POLICY,
  INCLUDED_EXTENSIONS,
  EXCLUDED_PATH_SEGMENTS,
  EXCLUDED_FILE_NAMES,
  EXCLUDED_EXTENSIONS,
  SENSITIVE_CONTENT_MARKERS,
  isExcludedRelativePath,
  isIncludedRelativePath,
  resolveManagedBackupDestination,
  runBackupDuty,
  writeTestOnlyBackup,
  verifyWrittenBackup,
  pruneTestOnlyRetention
});

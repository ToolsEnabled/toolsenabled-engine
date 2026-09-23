'use strict';

// The artifact manifest is an authority boundary: callers may name an artifact,
// but may never supply its digest or size.  Everything returned here is read
// from a descriptor rooted in the broker-owned run workspace and verified again
// after the descriptor has been hashed.

const nodeCrypto = require('node:crypto');
const nodeChildProcess = require('node:child_process');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const {
  CoordinatorWorkflowError,
  compareText,
  canonicalJson,
  exactKeys,
  fail,
  identifier,
  integer,
  pathKey,
  plainObject,
  safePath,
  safeText,
  sha256
} = require('./common');

const MAX_ARTIFACTS = 100;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_PATH_BYTES = 1024;
const MAX_PATH_SEGMENTS = 32;
const MAX_WINDOWS_REPARSE_SCAN_PATHS = 4096;
const WIN32_REPARSE_BATCH_PROBE = "$ErrorActionPreference='Stop';$raw=[Console]::In.ReadToEnd();$paths=ConvertFrom-Json -InputObject $raw;if($paths.Count -lt 1){throw 'empty reparse probe'};$bits=foreach($p in $paths){$a=[System.IO.File]::GetAttributes([string]$p);if(($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){1}else{0}};[Console]::Out.Write('['+($bits -join ',')+']')";

function artifactFail(code, message, details) {
  fail(`COORDINATOR_WORKFLOW_ARTIFACT_${code}`, message, details);
}

function resolverOptions(value = {}) {
  const source = plainObject(value, 'trusted artifact resolver options');
  exactKeys(source, ['fs', 'path', 'crypto', 'childProcess', 'platform', 'maxArtifacts', 'maxArtifactBytes', 'onBeforeOpen', 'onAfterOpen', 'isReparsePoint'], 'trusted artifact resolver options');
  const output = {
    fs: source.fs || nodeFs,
    path: source.path || nodePath,
    crypto: source.crypto || nodeCrypto,
    childProcess: source.childProcess || nodeChildProcess,
    platform: source.platform === undefined ? process.platform : source.platform,
    windowsReparsePoints: null,
    maxArtifacts: source.maxArtifacts === undefined ? MAX_ARTIFACTS : integer(source.maxArtifacts, 'options.maxArtifacts', { min: 1, max: MAX_ARTIFACTS }),
    maxArtifactBytes: source.maxArtifactBytes === undefined ? MAX_ARTIFACT_BYTES : integer(source.maxArtifactBytes, 'options.maxArtifactBytes', { min: 1, max: MAX_ARTIFACT_BYTES }),
    onBeforeOpen: source.onBeforeOpen,
    onAfterOpen: source.onAfterOpen,
    isReparsePoint: source.isReparsePoint
  };
  for (const name of ['onBeforeOpen', 'onAfterOpen', 'isReparsePoint']) {
    if (output[name] !== undefined && typeof output[name] !== 'function') {
      artifactFail('INVALID', `options.${name} must be a function when supplied.`, { field: `options.${name}` });
    }
  }
  if (typeof output.platform !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(output.platform)) {
    artifactFail('INVALID', 'options.platform must be a normalized platform name.', { field: 'options.platform' });
  }
  if (!output.fs || !output.path || !output.crypto) artifactFail('INVALID', 'Resolver dependencies are incomplete.');
  return output;
}

function bigintStat(fs, target, operation) {
  let stat;
  try {
    stat = fs.lstatSync(target, { bigint: true });
  } catch (error) {
    artifactFail('UNRESOLVABLE', `${operation} could not be resolved.`, { operation, cause: error && error.code });
  }
  if (!stat || typeof stat.size !== 'bigint' || typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || typeof stat.nlink !== 'bigint') {
    artifactFail('UNSUPPORTED', 'The filesystem adapter must return BigInt lstat metadata.', { operation });
  }
  return stat;
}

function bigintFstat(fs, fd, operation) {
  let stat;
  try {
    stat = fs.fstatSync(fd, { bigint: true });
  } catch (error) {
    artifactFail('UNRESOLVABLE', `${operation} could not be inspected.`, { operation, cause: error && error.code });
  }
  if (!stat || typeof stat.size !== 'bigint' || typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || typeof stat.nlink !== 'bigint') {
    artifactFail('UNSUPPORTED', 'The filesystem adapter must return BigInt fstat metadata.', { operation });
  }
  return stat;
}

function times(stat, operation) {
  if (typeof stat.mtimeNs !== 'bigint' || typeof stat.ctimeNs !== 'bigint') {
    artifactFail('UNSUPPORTED', 'The filesystem adapter must expose BigInt modification and change times.', { operation });
  }
  return { mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function signature(stat, operation, { file = false } = {}) {
  const output = { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, ...times(stat, operation) };
  if (file) output.size = stat.size;
  return output;
}

function sameSignature(left, right) {
  return Object.keys(left).every(key => left[key] === right[key]) && Object.keys(right).every(key => left[key] === right[key]);
}

function windowsReparsePoint(target, options) {
  const key = options.path.resolve(target);
  if (!(options.windowsReparsePoints instanceof Map) || !options.windowsReparsePoints.has(key)) {
    artifactFail('REPARSE_PROBE_FAILED', 'Windows reparse-point inspection did not cover an exact resolved path; refusing trusted artifact resolution.');
  }
  return options.windowsReparsePoints.get(key);
}

function prepareWindowsReparseScan(request, options) {
  if (options.platform !== 'win32') return;
  const paths = [];
  const seen = new Set();
  const add = target => {
    const canonical = options.path.resolve(target);
    if (!seen.has(canonical)) { seen.add(canonical); paths.push(canonical); }
  };
  let workspace = options.path.resolve(request.trustedRoot);
  add(workspace);
  for (const segment of request.workspaceSegments) {
    workspace = options.path.join(workspace, segment);
    add(workspace);
  }
  for (const artifact of request.artifacts) {
    let target = workspace;
    for (const segment of artifact.path.split('/')) {
      target = options.path.join(target, segment);
      add(target);
    }
  }
  if (paths.length < 1 || paths.length > MAX_WINDOWS_REPARSE_SCAN_PATHS) {
    artifactFail('REPARSE_PROBE_LIMIT', 'Trusted artifact resolution exceeded the bounded Windows reparse-point scan.', { paths: paths.length });
  }
  try {
    const output = options.childProcess.execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN32_REPARSE_BATCH_PROBE
    ], {
      input: JSON.stringify(paths), encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const bits = JSON.parse(String(output));
    if (!Array.isArray(bits) || bits.length !== paths.length || bits.some(bit => bit !== 0 && bit !== 1)) {
      artifactFail('REPARSE_PROBE_FAILED', 'Windows reparse-point inspection returned an invalid bounded result.');
    }
    options.windowsReparsePoints = new Map(paths.map((target, index) => [target, bits[index] === 1]));
    return;
  } catch {
    // A host unable to make the fixed local attribute query cannot safely
    // distinguish arbitrary reparse tags, so Windows resolution fails closed.
  }
  artifactFail('REPARSE_PROBE_FAILED', 'Windows reparse-point inspection is unavailable; refusing trusted artifact resolution.');
}

function isReparse(stat, target, options) {
  // Node catches symlinks and junctions.  Windows additionally performs a
  // fixed local GetAttributes probe for every traversed component so mount
  // points and other reparse tags are refused too.
  if (stat.isSymbolicLink()) return true;
  if (options.platform === 'win32' && windowsReparsePoint(target, options)) return true;
  if (!options.isReparsePoint) return false;
  try { return Boolean(options.isReparsePoint(stat, target)); }
  catch { artifactFail('REPARSE_PROBE_FAILED', 'The configured reparse-point inspection failed; refusing trusted artifact resolution.'); }
}

function assertDirectory(stat, target, options, operation) {
  if (!stat.isDirectory() || isReparse(stat, target, options)) {
    artifactFail('PATH_INVALID', `${operation} must be a real directory, never a link or reparse point.`, { target: String(target) });
  }
}

function assertRegularFile(stat, target, options, operation) {
  if (!stat.isFile() || isReparse(stat, target, options) || stat.nlink !== 1n) {
    artifactFail('FILE_INVALID', `${operation} must be a single-link regular file, never a link, device, or reparse point.`, { target: String(target) });
  }
}

function nativeRealpath(fs, target, operation) {
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    return realpath(target);
  } catch (error) {
    artifactFail('UNRESOLVABLE', `${operation} could not be canonicalized.`, { operation, cause: error && error.code });
  }
}

function containedBy(path, root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(path, left, right, options) {
  // Windows path identity is case-insensitive.  Exact case is enforced from
  // directory entries below, so this comparison only answers containment.
  return options.platform === 'win32'
    ? String(left).toLowerCase() === String(right).toLowerCase()
    : String(left) === String(right);
}

function assertExactEntry(fs, path, parent, segment, options, operation) {
  let names;
  try { names = fs.readdirSync(parent); }
  catch (error) { artifactFail('UNRESOLVABLE', `${operation} parent could not be enumerated.`, { operation, cause: error && error.code }); }
  const aliases = names.filter(name => String(name).toLowerCase() === segment.toLowerCase());
  if (aliases.length !== 1 || aliases[0] !== segment) {
    artifactFail('CASE_ALIAS', `${operation} must use the exact stored path casing.`, { segment });
  }
  const target = path.join(parent, segment);
  const stat = bigintStat(fs, target, operation);
  if (isReparse(stat, target, options)) artifactFail('PATH_INVALID', `${operation} must not traverse a link or reparse point.`, { target });
  return { target, stat };
}

function safeRunId(value) {
  identifier(value, 'runId');
  if (!SAFE_SEGMENT.test(value) || value.endsWith('.') || /^\.(?:\.)?$/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)) {
    artifactFail('PATH_INVALID', 'runId cannot be represented as a safe workspace path segment.', { field: 'runId' });
  }
  return value;
}

function boundedSafePath(value, label) {
  const safe = safePath(value, label);
  if (Buffer.byteLength(safe, 'utf8') > MAX_PATH_BYTES || safe.split('/').length > MAX_PATH_SEGMENTS) {
    artifactFail('PATH_INVALID', `${label} exceeds trusted artifact path bounds.`, { field: label });
  }
  return safe;
}

function input(value, options) {
  const source = plainObject(value, 'trusted artifact input');
  exactKeys(source, ['trustedRoot', 'runId', 'workspacePath', 'artifacts'], 'trusted artifact input');
  if (typeof source.trustedRoot !== 'string' || !options.path.isAbsolute(source.trustedRoot)) {
    artifactFail('PATH_INVALID', 'trustedRoot must be an absolute broker-fixed path.', { field: 'trustedRoot' });
  }
  const runId = safeRunId(source.runId);
  const workspacePath = boundedSafePath(source.workspacePath, 'workspacePath');
  const workspaceSegments = workspacePath.split('/');
  if (workspaceSegments[0].toLowerCase() !== runId.toLowerCase()) {
    artifactFail('WORKSPACE_INVALID', 'workspacePath must begin with its exact runId segment.', { field: 'workspacePath' });
  }
  if (!Array.isArray(source.artifacts) || source.artifacts.length < 1 || source.artifacts.length > options.maxArtifacts) {
    artifactFail('INVALID', `artifacts must contain one through ${options.maxArtifacts} entries.`, { field: 'artifacts' });
  }
  const artifacts = source.artifacts.map((entry, index) => {
    const item = plainObject(entry, `artifacts[${index}]`);
    // Hash and size are deliberately not accepted, including as stale hints.
    exactKeys(item, ['artifactId', 'path', 'kind'], `artifacts[${index}]`);
    return {
      artifactId: identifier(item.artifactId, `artifacts[${index}].artifactId`),
      path: boundedSafePath(item.path, `artifacts[${index}].path`),
      kind: safeText(item.kind, `artifacts[${index}].kind`, { min: 1, max: 40, pattern: /^[a-z_]+$/ })
    };
  });
  const ids = new Set();
  const paths = new Set();
  for (const item of artifacts) {
    if (ids.has(item.artifactId)) artifactFail('DUPLICATE', 'Artifact identifiers must be unique.', { artifactId: item.artifactId });
    if (paths.has(pathKey(item.path))) artifactFail('DUPLICATE', 'Artifact paths must be unique without case aliases.', { path: item.path });
    ids.add(item.artifactId);
    paths.add(pathKey(item.path));
  }
  return { trustedRoot: source.trustedRoot, runId, workspacePath, workspaceSegments, artifacts };
}

function resolveWorkspace(request, options) {
  const { fs, path } = options;
  const lexicalRoot = path.resolve(request.trustedRoot);
  const rootPre = bigintStat(fs, lexicalRoot, 'trusted root');
  assertDirectory(rootPre, lexicalRoot, options, 'trusted root');
  const root = nativeRealpath(fs, lexicalRoot, 'trusted root');
  if (!samePath(path, lexicalRoot, root, options)) artifactFail('PATH_INVALID', 'trustedRoot must already be canonical and must not resolve through a link.', { field: 'trustedRoot' });

  let cursor = root;
  const ancestry = [{ target: root, signature: signature(rootPre, 'trusted root') }];
  for (let index = 0; index < request.workspaceSegments.length; index += 1) {
    const segment = request.workspaceSegments[index];
    const child = assertExactEntry(fs, path, cursor, segment, options, `workspace segment ${index}`);
    assertDirectory(child.stat, child.target, options, `workspace segment ${index}`);
    cursor = child.target;
    ancestry.push({ target: cursor, signature: signature(child.stat, `workspace segment ${index}`) });
  }
  if (request.workspaceSegments[0] !== request.runId) {
    artifactFail('WORKSPACE_INVALID', 'workspacePath must begin with its exact runId segment.', { field: 'workspacePath' });
  }
  const workspace = nativeRealpath(fs, cursor, 'run workspace');
  if (!containedBy(path, root, workspace) || !samePath(path, workspace, cursor, options)) {
    artifactFail('WORKSPACE_INVALID', 'The run workspace must remain canonically contained by the trusted root.', { workspacePath: request.workspacePath });
  }
  return { root, workspace, ancestry };
}

function verifyAncestry(ancestry, options) {
  for (const entry of ancestry) {
    const current = bigintStat(options.fs, entry.target, 'workspace ancestry');
    assertDirectory(current, entry.target, options, 'workspace ancestry');
    if (!sameSignature(entry.signature, signature(current, 'workspace ancestry'))) {
      artifactFail('RACE_DETECTED', 'Trusted root or run workspace changed while resolving artifacts.', { target: entry.target });
    }
  }
}

function resolveArtifact(item, workspaceState, options) {
  const { fs, path, crypto } = options;
  const segments = item.path.split('/');
  let parent = workspaceState.workspace;
  const parents = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    const child = assertExactEntry(fs, path, parent, segments[index], options, `artifact parent ${index}`);
    assertDirectory(child.stat, child.target, options, `artifact parent ${index}`);
    parents.push({ target: child.target, signature: signature(child.stat, `artifact parent ${index}`) });
    parent = child.target;
  }
  const leaf = assertExactEntry(fs, path, parent, segments[segments.length - 1], options, 'artifact leaf');
  assertRegularFile(leaf.stat, leaf.target, options, 'artifact leaf');
  const pre = signature(leaf.stat, 'artifact leaf', { file: true });
  const expectedTarget = leaf.target;
  const expectedRealpath = nativeRealpath(fs, expectedTarget, 'artifact leaf');
  if (!containedBy(path, workspaceState.workspace, expectedRealpath) || !samePath(path, expectedTarget, expectedRealpath, options)) {
    artifactFail('PATH_INVALID', 'Artifact resolution escaped its immutable run workspace.', { path: item.path });
  }

  if (options.onBeforeOpen) options.onBeforeOpen({ artifact: { ...item }, target: expectedTarget });
  let fd;
  try {
    // O_NOFOLLOW closes the leaf-link race on platforms which support it; the
    // lstat/fstat identity checks below remain mandatory on every platform.
    const noFollow = Number.isInteger(fs.constants && fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(expectedTarget, fs.constants.O_RDONLY | noFollow);
    const opened = bigintFstat(fs, fd, 'opened artifact');
    assertRegularFile(opened, expectedTarget, options, 'opened artifact');
    if (!sameSignature(pre, signature(opened, 'opened artifact', { file: true }))) {
      artifactFail('RACE_DETECTED', 'Artifact changed between path validation and file open.', { path: item.path });
    }
    if (opened.size > BigInt(options.maxArtifactBytes)) {
      artifactFail('TOO_LARGE', `Artifact exceeds the ${options.maxArtifactBytes}-byte resolver limit.`, { path: item.path });
    }
    if (options.onAfterOpen) options.onAfterOpen({ artifact: { ...item }, target: expectedTarget, fd });
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, options.maxArtifactBytes));
    let offset = 0n;
    while (offset < opened.size) {
      const wanted = Number((opened.size - offset) > BigInt(buffer.length) ? BigInt(buffer.length) : opened.size - offset);
      const bytes = fs.readSync(fd, buffer, 0, wanted, Number(offset));
      if (!Number.isSafeInteger(bytes) || bytes <= 0) artifactFail('RACE_DETECTED', 'Artifact ended or changed while it was being hashed.', { path: item.path });
      hash.update(buffer.subarray(0, bytes));
      offset += BigInt(bytes);
    }
    const closed = bigintFstat(fs, fd, 'hashed artifact');
    assertRegularFile(closed, expectedTarget, options, 'hashed artifact');
    if (!sameSignature(signature(opened, 'opened artifact', { file: true }), signature(closed, 'hashed artifact', { file: true }))) {
      artifactFail('RACE_DETECTED', 'Artifact changed while it was being hashed.', { path: item.path });
    }
    for (const entry of parents) {
      const current = bigintStat(fs, entry.target, 'artifact parent');
      assertDirectory(current, entry.target, options, 'artifact parent');
      if (!sameSignature(entry.signature, signature(current, 'artifact parent'))) artifactFail('RACE_DETECTED', 'Artifact parent changed while resolving the artifact.', { path: item.path });
    }
    const post = bigintStat(fs, expectedTarget, 'artifact leaf');
    assertRegularFile(post, expectedTarget, options, 'artifact leaf');
    if (!sameSignature(pre, signature(post, 'artifact leaf', { file: true }))) {
      artifactFail('RACE_DETECTED', 'Artifact path changed while it was being hashed.', { path: item.path });
    }
    const postRealpath = nativeRealpath(fs, expectedTarget, 'artifact leaf');
    if (!samePath(path, expectedRealpath, postRealpath, options) || !containedBy(path, workspaceState.workspace, postRealpath)) {
      artifactFail('RACE_DETECTED', 'Artifact re-resolution changed while it was being hashed.', { path: item.path });
    }
    return {
      artifact: { artifactId: item.artifactId, path: item.path, kind: item.kind, sha256: hash.digest('hex'), sizeBytes: Number(opened.size) },
      deviceIdentity: `${opened.dev}:${opened.ino}`,
      identity: signature(opened, 'opened artifact', { file: true })
    };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch (error) {
        artifactFail('UNRESOLVABLE', 'The hashed artifact descriptor could not be closed; refusing trusted artifact resolution.', {
          operation: 'close hashed artifact',
          cause: error && error.code
        });
      }
    }
  }
}

function resolveArtifactDetails(value, options) {
  const request = input(value, options);
  // The batch scan precedes all lstat/open work and covers every exact
  // canonical component this pass may touch.  Later identity/re-resolution
  // checks make a replacement after this scan fail closed without spawning a
  // process for each path.
  prepareWindowsReparseScan(request, options);
  const workspaceState = resolveWorkspace(request, options);
  const resolved = [];
  const identities = new Set();
  for (const item of request.artifacts) {
    const resolvedArtifact = resolveArtifact(item, workspaceState, options);
    // A single-link file should make this impossible, but retain the device
    // identity guard for injected adapters and unusual filesystems.
    if (identities.has(resolvedArtifact.deviceIdentity)) artifactFail('DUPLICATE', 'Artifacts must not alias the same filesystem object.', { path: item.path });
    identities.add(resolvedArtifact.deviceIdentity);
    resolved.push(resolvedArtifact);
  }
  verifyAncestry(workspaceState.ancestry, options);
  resolved.sort((left, right) => compareText(left.artifact.artifactId, right.artifact.artifactId));
  return { request, workspaceState, resolved };
}

function identitySnapshot(value) {
  const output = Object.create(null);
  for (const [key, item] of Object.entries(value)) output[key] = String(item);
  return output;
}

function snapshotFromDetails(details) {
  const root = details.workspaceState.ancestry[0];
  const workspace = details.workspaceState.ancestry.at(-1);
  return {
    schemaVersion: 1,
    // Persist the resolver-observed canonical root, never an equivalent raw
    // spelling supplied by the caller, so a broker token binds one identity.
    trustedRoot: details.workspaceState.root,
    runId: details.request.runId,
    workspacePath: details.request.workspacePath,
    rootIdentity: identitySnapshot(root.signature),
    workspaceIdentity: identitySnapshot(workspace.signature),
    ancestry: details.workspaceState.ancestry.map((entry, index) => ({
      relativePath: index === 0 ? '' : details.request.workspaceSegments.slice(0, index).join('/'),
      identity: identitySnapshot(entry.signature)
    })),
    artifacts: details.resolved.map(entry => ({ ...entry.artifact, identity: identitySnapshot(entry.identity) }))
  };
}

function resolveTrustedArtifacts(value, overrides = {}) {
  const details = resolveArtifactDetails(value, resolverOptions(overrides));
  return details.resolved.map(entry => entry.artifact);
}

function resolveTrustedArtifactSnapshot(value, overrides = {}) {
  const details = resolveArtifactDetails(value, resolverOptions(overrides));
  return {
    artifacts: details.resolved.map(entry => entry.artifact),
    snapshot: snapshotFromDetails(details)
  };
}

function snapshotIdentity(value, label, { file = false } = {}) {
  const source = plainObject(value, label);
  const keys = file ? ['dev', 'ino', 'mode', 'nlink', 'mtimeNs', 'ctimeNs', 'size'] : ['dev', 'ino', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'];
  exactKeys(source, keys, label);
  const output = Object.create(null);
  for (const key of keys) {
    if (typeof source[key] !== 'string' || !/^\d+$/.test(source[key])) {
      artifactFail('SNAPSHOT_INVALID', `${label}.${key} must be a decimal identity value.`, { field: `${label}.${key}` });
    }
    output[key] = source[key];
  }
  return output;
}

function snapshotInput(value) {
  const source = plainObject(value, 'trusted artifact snapshot');
  exactKeys(source, ['schemaVersion', 'trustedRoot', 'runId', 'workspacePath', 'rootIdentity', 'workspaceIdentity', 'ancestry', 'artifacts'], 'trusted artifact snapshot');
  if (source.schemaVersion !== 1) artifactFail('SNAPSHOT_INVALID', 'trusted artifact snapshot has an unsupported schema version.', { field: 'schemaVersion' });
  if (typeof source.trustedRoot !== 'string' || !nodePath.isAbsolute(source.trustedRoot)) artifactFail('SNAPSHOT_INVALID', 'trusted artifact snapshot has an invalid trusted root.', { field: 'trustedRoot' });
  const runId = safeRunId(source.runId);
  const workspacePath = boundedSafePath(source.workspacePath, 'snapshot.workspacePath');
  const segments = workspacePath.split('/');
  if (segments[0] !== runId) artifactFail('SNAPSHOT_INVALID', 'trusted artifact snapshot does not bind its run workspace.', { field: 'workspacePath' });
  const rootIdentity = snapshotIdentity(source.rootIdentity, 'snapshot.rootIdentity');
  const workspaceIdentity = snapshotIdentity(source.workspaceIdentity, 'snapshot.workspaceIdentity');
  if (!Array.isArray(source.ancestry) || source.ancestry.length !== segments.length + 1) artifactFail('SNAPSHOT_INVALID', 'trusted artifact snapshot ancestry is incomplete.', { field: 'ancestry' });
  const ancestry = source.ancestry.map((entry, index) => {
    const item = plainObject(entry, `snapshot.ancestry[${index}]`);
    exactKeys(item, ['relativePath', 'identity'], `snapshot.ancestry[${index}]`);
    const relativePath = index === 0 ? '' : boundedSafePath(item.relativePath, `snapshot.ancestry[${index}].relativePath`);
    const expected = index === 0 ? '' : segments.slice(0, index).join('/');
    if (relativePath !== expected) artifactFail('SNAPSHOT_INVALID', 'trusted artifact snapshot ancestry does not exactly bind the workspace path.', { field: `snapshot.ancestry[${index}].relativePath` });
    return { relativePath, identity: snapshotIdentity(item.identity, `snapshot.ancestry[${index}].identity`) };
  });
  if (canonicalJson(ancestry[0].identity) !== canonicalJson(rootIdentity) || canonicalJson(ancestry.at(-1).identity) !== canonicalJson(workspaceIdentity)) {
    artifactFail('SNAPSHOT_INVALID', 'trusted artifact snapshot root or workspace identity is inconsistent.', {});
  }
  if (!Array.isArray(source.artifacts) || source.artifacts.length < 1 || source.artifacts.length > MAX_ARTIFACTS) artifactFail('SNAPSHOT_INVALID', 'trusted artifact snapshot artifacts are invalid.', { field: 'artifacts' });
  const artifacts = source.artifacts.map((entry, index) => {
    const item = plainObject(entry, `snapshot.artifacts[${index}]`);
    exactKeys(item, ['artifactId', 'path', 'kind', 'sha256', 'sizeBytes', 'identity'], `snapshot.artifacts[${index}]`);
    const sizeBytes = integer(item.sizeBytes, `snapshot.artifacts[${index}].sizeBytes`, { min: 0, max: MAX_ARTIFACT_BYTES });
    const identity = snapshotIdentity(item.identity, `snapshot.artifacts[${index}].identity`, { file: true });
    if (identity.size !== String(sizeBytes)) artifactFail('SNAPSHOT_INVALID', 'trusted artifact snapshot size does not match its file identity.', { field: `snapshot.artifacts[${index}].sizeBytes` });
    return {
      artifactId: identifier(item.artifactId, `snapshot.artifacts[${index}].artifactId`),
      path: boundedSafePath(item.path, `snapshot.artifacts[${index}].path`),
      kind: safeText(item.kind, `snapshot.artifacts[${index}].kind`, { min: 1, max: 40, pattern: /^[a-z_]+$/ }),
      sha256: sha256(item.sha256, `snapshot.artifacts[${index}].sha256`),
      sizeBytes,
      identity
    };
  });
  const ids = new Set();
  const paths = new Set();
  for (const artifact of artifacts) {
    if (ids.has(artifact.artifactId) || paths.has(pathKey(artifact.path))) artifactFail('SNAPSHOT_INVALID', 'trusted artifact snapshot contains duplicate artifact aliases.', {});
    ids.add(artifact.artifactId); paths.add(pathKey(artifact.path));
  }
  return { schemaVersion: 1, trustedRoot: source.trustedRoot, runId, workspacePath, rootIdentity, workspaceIdentity, ancestry, artifacts };
}

function verifyTrustedArtifactSnapshot(value, overrides = {}) {
  const snapshot = validateTrustedArtifactSnapshot(value);
  const current = resolveTrustedArtifactSnapshot({
    trustedRoot: snapshot.trustedRoot,
    runId: snapshot.runId,
    workspacePath: snapshot.workspacePath,
    artifacts: snapshot.artifacts.map(({ artifactId, path, kind }) => ({ artifactId, path, kind }))
  }, overrides);
  if (canonicalJson(snapshot) !== canonicalJson(current.snapshot)) {
    artifactFail('SNAPSHOT_MISMATCH', 'Trusted artifact snapshot no longer matches the broker-owned workspace.', {});
  }
  return current;
}

// This is deliberately filesystem-free so the broker can validate a persisted
// snapshot during restart/replay before deciding whether to perform its fresh
// pre-ACCEPTED verification pass.
function validateTrustedArtifactSnapshot(value) {
  return snapshotInput(value);
}

module.exports = {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS,
  TrustedArtifactResolverError: CoordinatorWorkflowError,
  resolveTrustedArtifacts,
  resolveTrustedArtifactSnapshot,
  validateTrustedArtifactSnapshot,
  verifyTrustedArtifactSnapshot
};

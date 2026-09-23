'use strict';

// Transitional trust-on-first-use integrity gate for the direct-peer FRA
// runtime. The config anchor names every file and directory in the fixed
// runtime roots. Verification never follows reparse points and rereads both
// the tree and anchor before returning, so missing, extra, replaced, or
// changed runtime input fails before the lifecycle controller stops a listener
// and again before the service process binds.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { machineAddressPolicy } = require('./service-registry');
const {
  machineConfigPath, resolveMachineIdentity, assertFilenameSafeMachineId, FraMachineIdentityError
} = require('./fra-machine-identity');

// v2, not v1. The anchor used to identify its machine by IP ADDRESS, both in
// its filename and in a `host` field the parser compares exactly. Moving the
// machine to another network therefore broke the anchor twice over -- the file
// could not be found, and if found its identity field no longer matched.
// v2 identifies the machine by its stable registry id instead (`machine`), so
// a network move is one edit to config/service-registry.json and re-anchors
// nothing. Both endpoints in this tree are cut together; the anchor is a local
// file read, never a wire format, so no peer sees this change mid-flight.
const SCHEMA_VERSION = 'fra-runtime-integrity.v2';
const HASH_ALGORITHM = 'sha256';
const DIGEST_RE = /^[a-f0-9]{64}$/;
// Only immutable executable inputs belong in the FRA anchor. Runtime state,
// audit/vault/profile data, owner messages, package worktrees, and the relay's
// mutable sidecar state stay outside this tree by design. The exact standalone
// tool/config files below are included without hashing their entire mutable
// parent directories.
// FRA pins its control plane, not the whole ToolsEnabled application. Peer
// machines intentionally have different provider inventories and registry
// declarations; forcing src/, schemas/, and node_modules/ to be byte-identical
// turned an authenticated reconnect into a 500+ file repository promotion.
// Each server verifies this exact local boundary. Its peer validates the
// separately pinned canonical declaration for that host.
const RUNTIME_ROOTS = Object.freeze([]);
// Python bytecode caches are mutable derivatives of the anchored source files,
// not inputs to the Node FRA listener. Including them makes a harmless Python
// import rewrite the runtime anchor. Only the conventional cache directory is
// excluded; an adjacent .pyc or any other executable-looking file remains an
// anchored input. A future FRA process that executes Python directly must use a
// separate reviewed Python-runtime anchor rather than widening this exception.
const EPHEMERAL_RUNTIME_DIRECTORY_NAMES = Object.freeze(['__pycache__']);
// "Anchor immutable executable inputs only" is the rule stated at the top of
// this module, and the standing-orders documents broke it. They are narrative
// policy files that agents are required to edit every time the owner gives an
// instruction; no code in the FRA request path reads either. Anchoring them
// guaranteed two paired machines would drift apart during correct, routine
// work -- and they did, in a real deployment, exactly that way. They are gone
// from this list and from POLICY_FILES in fra-transport-binding.js.
// The guard against quietly re-adding them lives in
// tests/fra-runtime-integrity.js.
// The per-machine capability manifests are NOT listed here. They used to be,
// by their IP-derived filenames, which froze one deployment's two addresses
// into every install's anchor. They are now derived from
// config/service-registry.json by machine id in topLevelFiles() below, so the
// anchored set follows whatever machines the registry actually declares.
const STATIC_TOP_LEVEL_FILES = Object.freeze([
  'config/service-registry.json',
  'config/toolsenabled.policy.json',
  'config/uac-delegation-allowlist.json',
  'src/full-remote-access-bridge.js',
  'src/lib/action-guards.js',
  'src/lib/approvals.js',
  'src/lib/audit-store.js',
  'src/lib/audit.js',
  'src/lib/credential-metadata.js',
  'src/lib/egress-preflight.js',
  'src/lib/fra-capability-manifest.js',
  'src/lib/fra-machine-identity.js',
  'src/lib/fra-root-access.js',
  'src/lib/fra-runtime-integrity.js',
  'src/lib/fra-secure-session.js',
  'src/lib/fra-transport-binding.js',
  'src/lib/fra-workspace-policy.js',
  'src/lib/providers/fra-workspace-handles.js',
  'src/lib/policy.js',
  'src/lib/policy-authorizations.js',
  'src/lib/runtime.js',
  'src/lib/scoped-approvals.js',
  'src/lib/service-registry.js',
  'src/lib/state-store.js',
  'src/lib/tool-registry.js',
  'src/mcp-server.js',
  'src/remote-agent-bridge.js',
  'tools/fra-lifecycle-tunnel-notice.js',
  'tools/fra-root-access-control.ps1',
  'tools/fra-root-access-probe.ps1',
  'tools/fra-token-enrollment-a.js',
  'tools/fra-token-enrollment-lifecycle.js',
  'tools/fra-token-enrollment-receiver.js',
  'tools/fra-token-enrollment-vault-helper.ps1',
  'tools/full-remote-access-control.ps1',
  'tools/full-remote-access-enroll-peer.js',
  'tools/full-remote-access-enroll-token.js',
  'tools/full-remote-access-firewall.ps1',
  'tools/full-remote-access-listener-host.js',
  'tools/full-remote-access-lifecycle.ps1',
  'tools/full-remote-access-mcp-proxy.js',
  'tools/lib/fra-token-enrollment-vault.js',
  'tools/lib/fra-token-enrollment.js',
  'tools/lib/one-shot-token-enroll.js',
  'tools/lib/service-registry.ps1',
  'tools/lib/special-session-sealed-transport.js',
  'tools/fra-peer-identity-probe.js',
  'tools/remote-agent-mcp-proxy.js',
  'tools/secrets.ps1'
]);
// Matches both the identity-keyed anchor name this module now writes
// (fra-runtime-integrity.machine-a.json) and the legacy dotted-quad name still
// present in trees that have not been migrated. Its job is to stop an anchor
// from ever appearing inside its own hashed file list, so it must recognize
// every shape an anchor can have on disk, not just the current one.
const ANCHOR_RE = /^config\/fra-runtime-integrity\.[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?\.json$/;
const MANIFEST_BASENAME = 'fra-capability-manifest';
const ANCHOR_BASENAME = 'fra-runtime-integrity';
const BUFFER_BYTES = 1024 * 1024;

// The anchored capability-manifest entries, derived from the registry's
// declared machines rather than enumerated as this lab's two addresses.
function capabilityManifestEntries(serviceRegistryOptions = {}) {
  const policy = machineAddressPolicy(serviceRegistryOptions);
  return policy.entries.map(entry =>
    `config/${MANIFEST_BASENAME}.${assertFilenameSafeMachineId(entry.machineId)}.json`);
}

function anchoredTopLevelFiles(serviceRegistryOptions = {}) {
  return Object.freeze(
    [...STATIC_TOP_LEVEL_FILES, ...capabilityManifestEntries(serviceRegistryOptions)].sort(compareText)
  );
}

function resolveTopLevelFiles(expected, serviceRegistryOptions = {}) {
  return expected === undefined ? anchoredTopLevelFiles(serviceRegistryOptions) : expected;
}

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function isEphemeralRuntimeDirectory(relative) {
  const normalized = normalizeRelative(relative);
  const leaf = normalized.slice(normalized.lastIndexOf('/') + 1);
  return EPHEMERAL_RUNTIME_DIRECTORY_NAMES.includes(leaf);
}

class FraRuntimeIntegrityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FraRuntimeIntegrityError';
    this.code = code;
  }
}

function fail(code, message) { throw new FraRuntimeIntegrityError(code, message); }

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')
      || value !== value.normalize('NFC') || value.includes('\\') || path.posix.isAbsolute(value)) {
    fail('FRA_RUNTIME_PATH_INVALID', 'Runtime manifest contains an invalid relative path.');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')
      || normalized.startsWith('./') || normalized.includes('/../')) {
    fail('FRA_RUNTIME_PATH_INVALID', 'Runtime manifest path escapes or aliases the runtime root.');
  }
  return normalized;
}

function normalizeList(values, label) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
    fail('FRA_RUNTIME_MANIFEST_INVALID', `${label} must be an array of strings.`);
  }
  const normalized = values.map(normalizeRelative);
  const sorted = [...normalized].sort(compareText);
  if (sorted.length !== normalized.length || sorted.some((value, index) => value !== normalized[index])
      || new Set(normalized.map(value => value.toLowerCase())).size !== normalized.length) {
    fail('FRA_RUNTIME_MANIFEST_INVALID', `${label} must be case-unique and canonically sorted.`);
  }
  return normalized;
}

function normalizeExpectedList(values, label) {
  const normalized = [...values].map(normalizeRelative).sort(compareText);
  if (new Set(normalized.map(value => value.toLowerCase())).size !== normalized.length) {
    fail('FRA_RUNTIME_CONFIGURATION_INVALID', `${label} contains a case alias.`);
  }
  return Object.freeze(normalized);
}

const IDENTITY_REFUSALS = ['FRA_MACHINE_IDENTITY_INVALID', 'FRA_MACHINE_IDENTITY_UNSANCTIONED', 'FRA_MACHINE_ID_INVALID'];

function identityOrFail(selector, serviceRegistryOptions = {}) {
  try { return resolveMachineIdentity(selector, serviceRegistryOptions); }
  catch (error) {
    if (error instanceof FraMachineIdentityError && IDENTITY_REFUSALS.includes(error.code)) {
      fail('FRA_RUNTIME_HOST_INVALID', 'Runtime anchor host must name one registry-sanctioned machine.');
    }
    throw error;
  }
}

function assertRuntimeHost(host, serviceRegistryOptions = {}) {
  identityOrFail(host, serviceRegistryOptions);
}

// Identity-keyed, with a migration ramp: a tree that still carries the
// legacy address-named anchor keeps working for reads, while every write
// targets the identity name so the tree migrates itself forward.
function resolveAnchorPath(root, host, serviceRegistryOptions = {}, fsApi) {
  try {
    return machineConfigPath({
      root,
      basename: ANCHOR_BASENAME,
      selector: host,
      serviceRegistryOptions,
      ...(fsApi ? { fsApi } : {})
    });
  } catch (error) {
    if (error instanceof FraMachineIdentityError && IDENTITY_REFUSALS.includes(error.code)) {
      fail('FRA_RUNTIME_HOST_INVALID', 'Runtime anchor host must name one registry-sanctioned machine.');
    }
    throw error;
  }
}

function manifestPathForHost(root, host, serviceRegistryOptions = {}, fsApi) {
  return resolveAnchorPath(root, host, serviceRegistryOptions, fsApi).path;
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function identityOf(stat) {
  return stat && typeof stat.dev === 'bigint' && typeof stat.ino === 'bigint'
    && typeof stat.nlink === 'bigint' && typeof stat.size === 'bigint'
    && typeof stat.mtimeNs === 'bigint' && typeof stat.ctimeNs === 'bigint'
    ? {
        dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size,
        mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs
      }
    : null;
}

function sameIdentity(left, right) {
  const a = identityOf(left);
  const b = identityOf(right);
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs);
}

function assertPathChainNoReparse(root, candidate, fsApi = fs) {
  const repositoryRoot = path.resolve(root);
  const target = path.resolve(candidate);
  if (!insideRoot(repositoryRoot, target)) {
    fail('FRA_RUNTIME_PATH_ESCAPE', 'Runtime path resolves outside the repository.');
  }
  const relative = path.relative(repositoryRoot, target);
  const segments = relative ? relative.split(path.sep) : [];
  let current = repositoryRoot;
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index]);
    let stat;
    let real;
    try {
      stat = fsApi.lstatSync(current, { bigint: true });
      real = fsApi.realpathSync(current);
    } catch {
      fail('FRA_RUNTIME_PATH_INVALID', 'Runtime path component is missing or unreadable.');
    }
    if (stat.isSymbolicLink() || !insideRoot(repositoryRoot, path.resolve(real))) {
      fail('FRA_RUNTIME_REPARSE_REFUSED', 'Runtime paths must not traverse reparse points.');
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      fail('FRA_RUNTIME_PATH_INVALID', 'Runtime path has a non-directory parent component.');
    }
  }
}

function assertRegular(stat, code = 'FRA_RUNTIME_NONREGULAR_REFUSED') {
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()
      || (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink())) {
    fail(code, 'Runtime integrity accepts regular files only.');
  }
  const identity = identityOf(stat);
  if (!identity || identity.dev <= 0n || identity.ino <= 0n || identity.nlink !== 1n || identity.size < 0n) {
    fail('FRA_RUNTIME_FILE_IDENTITY_INVALID', 'Runtime file identity is not strong and single-link.');
  }
}

function assertDirectory(root, candidate, fsApi = fs) {
  let stat;
  let real;
  try {
    assertPathChainNoReparse(root, candidate, fsApi);
    stat = fsApi.lstatSync(candidate, { bigint: true });
    real = fsApi.realpathSync(candidate);
  } catch (error) {
    if (error instanceof FraRuntimeIntegrityError) throw error;
    fail('FRA_RUNTIME_DIRECTORY_INVALID', 'Runtime directory is missing or unreadable.');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('FRA_RUNTIME_REPARSE_REFUSED', 'Runtime directories must not be reparse points.');
  }
  if (!identityOf(stat) || stat.dev <= 0n || stat.ino <= 0n) {
    fail('FRA_RUNTIME_DIRECTORY_IDENTITY_INVALID', 'Runtime directory identity is not strong.');
  }
  if (!insideRoot(root, real)) fail('FRA_RUNTIME_PATH_ESCAPE', 'Runtime directory resolves outside the repository.');
  return stat;
}

function readAndHashRegularFile(root, candidate, { capture = false, fsApi = fs } = {}) {
  let before;
  let real;
  try {
    assertPathChainNoReparse(root, candidate, fsApi);
    before = fsApi.lstatSync(candidate, { bigint: true });
    real = fsApi.realpathSync(candidate);
  } catch (error) {
    if (error instanceof FraRuntimeIntegrityError) throw error;
    fail('FRA_RUNTIME_FILE_INVALID', 'Runtime file is missing or unreadable.');
  }
  assertRegular(before);
  if (!insideRoot(root, real)) fail('FRA_RUNTIME_PATH_ESCAPE', 'Runtime file resolves outside the repository.');

  let handle;
  let opened;
  let after;
  let pathAfter;
  const hash = crypto.createHash(HASH_ALGORITHM);
  const chunks = capture ? [] : null;
  let total = 0n;
  try {
    handle = fsApi.openSync(candidate, 'r');
    opened = fsApi.fstatSync(handle, { bigint: true });
    assertRegular(opened);
    if (!sameIdentity(before, opened)) fail('FRA_RUNTIME_FILE_CHANGED', 'Runtime file changed while it was opened.');
    const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    while (true) {
      const count = fsApi.readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      if (chunks) chunks.push(Buffer.from(bytes));
      total += BigInt(count);
    }
    after = fsApi.fstatSync(handle, { bigint: true });
  } catch (error) {
    if (error instanceof FraRuntimeIntegrityError) throw error;
    fail('FRA_RUNTIME_FILE_READ_FAILED', 'Runtime file could not be read safely.');
  } finally {
    if (handle !== undefined) {
      try { fsApi.closeSync(handle); } catch {}
    }
  }
  try { pathAfter = fsApi.lstatSync(candidate, { bigint: true }); }
  catch { fail('FRA_RUNTIME_FILE_CHANGED', 'Runtime file disappeared during verification.'); }
  if (!sameIdentity(opened, after) || !sameIdentity(after, pathAfter) || total !== after.size) {
    fail('FRA_RUNTIME_FILE_CHANGED', 'Runtime file changed during verification.');
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('FRA_RUNTIME_FILE_TOO_LARGE', 'Runtime file size cannot be represented safely.');
  }
  return Object.freeze({
    bytes: Number(total),
    sha256: hash.digest('hex'),
    ...(chunks ? { content: Buffer.concat(chunks) } : {})
  });
}

function collectRuntimeLayout({
  root,
  expectedRoots = RUNTIME_ROOTS,
  expectedTopLevelFiles,
  serviceRegistryOptions = {},
  fsApi = fs
} = {}) {
  const repositoryRoot = path.resolve(root);
  const roots = normalizeExpectedList(expectedRoots, 'runtime roots');
  const topLevelFiles = normalizeExpectedList(
    resolveTopLevelFiles(expectedTopLevelFiles, serviceRegistryOptions), 'top-level files');
  const directories = [];
  const files = [];

  function visit(relativeDirectory) {
    const absolute = path.resolve(repositoryRoot, ...relativeDirectory.split('/'));
    const before = assertDirectory(repositoryRoot, absolute, fsApi);
    directories.push(relativeDirectory);
    let entries;
    try { entries = fsApi.readdirSync(absolute, { withFileTypes: true }); }
    catch { fail('FRA_RUNTIME_DIRECTORY_INVALID', 'Runtime directory could not be enumerated.'); }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || entry.name !== entry.name.normalize('NFC')
          || entry.name === '.' || entry.name === '..' || /[\\/\0]/.test(entry.name)) {
        fail('FRA_RUNTIME_PATH_INVALID', 'Runtime directory contains an invalid entry name.');
      }
      const relative = `${relativeDirectory}/${entry.name}`;
      const normalized = normalizeRelative(relative);
      const candidate = path.resolve(repositoryRoot, ...normalized.split('/'));
      let stat;
      try { stat = fsApi.lstatSync(candidate, { bigint: true }); }
      catch { fail('FRA_RUNTIME_ENTRY_INVALID', 'Runtime entry changed during enumeration.'); }
      if (stat.isSymbolicLink()) fail('FRA_RUNTIME_REPARSE_REFUSED', 'Runtime entries must not be reparse points.');
      if (stat.isDirectory() && isEphemeralRuntimeDirectory(normalized)) {
        // Validate that the excluded cache node itself is a real directory; its
        // mutable derived contents are deliberately outside the Node anchor.
        assertDirectory(repositoryRoot, candidate, fsApi);
      } else if (stat.isDirectory()) visit(normalized);
      else if (stat.isFile()) {
        if (!ANCHOR_RE.test(normalized)) files.push(normalized);
      } else {
        fail('FRA_RUNTIME_NONREGULAR_REFUSED', 'Runtime tree contains a non-regular entry.');
      }
    }
    const after = assertDirectory(repositoryRoot, absolute, fsApi);
    if (!sameIdentity(before, after)) {
      fail('FRA_RUNTIME_TREE_CHANGED', 'Runtime directory changed during enumeration.');
    }
  }

  for (const runtimeRoot of roots) visit(runtimeRoot);
  for (const relative of topLevelFiles) {
    const candidate = path.resolve(repositoryRoot, ...relative.split('/'));
    let stat;
    try { stat = fsApi.lstatSync(candidate, { bigint: true }); }
    catch { fail('FRA_RUNTIME_FILE_INVALID', 'Required top-level runtime file is missing.'); }
    assertRegular(stat);
    files.push(relative);
  }
  directories.sort(compareText);
  files.sort(compareText);
  // A caller can override both policy lists. Refuse an empty effective policy
  // rather than producing a successful manifest after hashing no runtime
  // inputs at all.
  if (files.length === 0) {
    fail('FRA_RUNTIME_SCAN_EMPTY', 'Runtime integrity must scan at least one file.');
  }
  if (new Set(directories.map(value => value.toLowerCase())).size !== directories.length
      || new Set(files.map(value => value.toLowerCase())).size !== files.length) {
    fail('FRA_RUNTIME_CASE_ALIAS_REFUSED', 'Runtime tree contains a case alias.');
  }
  return Object.freeze({
    roots: Object.freeze([...roots]),
    topLevelFiles: Object.freeze([...topLevelFiles]),
    directories: Object.freeze(directories),
    files: Object.freeze(files)
  });
}

function runtimeDigest(files) {
  const hash = crypto.createHash(HASH_ALGORITHM);
  for (const file of files) hash.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`, 'utf8');
  return hash.digest('hex');
}

function canonicalManifest(manifest) {
  const canonical = {
    schemaVersion: manifest.schemaVersion,
    algorithm: manifest.algorithm,
    machine: manifest.machine,
    roots: manifest.roots,
    topLevelFiles: manifest.topLevelFiles,
    directoryCount: manifest.directoryCount,
    directories: manifest.directories,
    fileCount: manifest.fileCount,
    files: manifest.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    runtimeDigest: manifest.runtimeDigest
  };
  return `${JSON.stringify(canonical)}\n`;
}

function buildRuntimeManifest({
  root,
  host,
  expectedRoots = RUNTIME_ROOTS,
  expectedTopLevelFiles,
  fsApi = fs,
  serviceRegistryOptions = {}
} = {}) {
  const identity = identityOrFail(host, serviceRegistryOptions);
  const repositoryRoot = path.resolve(root);
  const layoutOptions = { root: repositoryRoot, expectedRoots, expectedTopLevelFiles, serviceRegistryOptions, fsApi };
  const first = collectRuntimeLayout(layoutOptions);
  const files = first.files.map(relative => {
    const result = readAndHashRegularFile(repositoryRoot,
      path.resolve(repositoryRoot, ...relative.split('/')), { fsApi });
    return Object.freeze({ path: relative, bytes: result.bytes, sha256: result.sha256 });
  });
  const second = collectRuntimeLayout(layoutOptions);
  if (JSON.stringify(first.directories) !== JSON.stringify(second.directories)
      || JSON.stringify(first.files) !== JSON.stringify(second.files)) {
    fail('FRA_RUNTIME_TREE_CHANGED', 'Runtime tree changed while the manifest was built.');
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    algorithm: HASH_ALGORITHM,
    machine: identity.machineId,
    roots: Object.freeze([...first.roots]),
    topLevelFiles: Object.freeze([...first.topLevelFiles]),
    directoryCount: first.directories.length,
    directories: Object.freeze([...first.directories]),
    fileCount: files.length,
    files: Object.freeze(files),
    runtimeDigest: runtimeDigest(files)
  });
}

function parseAndValidateManifest(content, {
  host,
  machine,
  expectedRoots = RUNTIME_ROOTS,
  expectedTopLevelFiles,
  serviceRegistryOptions = {}
} = {}) {
  const expectedMachine = machine !== undefined
    ? assertFilenameSafeMachineId(machine)
    : identityOrFail(host, serviceRegistryOptions).machineId;
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { fail('FRA_RUNTIME_MANIFEST_INVALID', 'Runtime integrity anchor is invalid JSON.'); }
  if (!plainObject(parsed)) fail('FRA_RUNTIME_MANIFEST_INVALID', 'Runtime integrity anchor must be an object.');
  const expectedKeys = [
    'algorithm', 'directories', 'directoryCount', 'fileCount', 'files', 'machine',
    'roots', 'runtimeDigest', 'schemaVersion', 'topLevelFiles'
  ];
  const keys = Object.keys(parsed).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    fail('FRA_RUNTIME_MANIFEST_INVALID', 'Runtime integrity anchor has unsupported or missing fields.');
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.algorithm !== HASH_ALGORITHM
      || parsed.machine !== expectedMachine) {
    fail('FRA_RUNTIME_MANIFEST_INVALID', 'Runtime integrity anchor identity is invalid.');
  }
  const roots = normalizeList(parsed.roots, 'roots');
  const topLevelFiles = normalizeList(parsed.topLevelFiles, 'topLevelFiles');
  const expectedRootList = normalizeExpectedList(expectedRoots, 'runtime roots');
  const expectedTopList = normalizeExpectedList(
    resolveTopLevelFiles(expectedTopLevelFiles, serviceRegistryOptions), 'top-level files');
  if (JSON.stringify(roots) !== JSON.stringify(expectedRootList)
      || JSON.stringify(topLevelFiles) !== JSON.stringify(expectedTopList)) {
    fail('FRA_RUNTIME_ROOTS_MISMATCH', 'Runtime integrity roots do not match the fixed policy.');
  }
  const directories = normalizeList(parsed.directories, 'directories');
  if (!Number.isSafeInteger(parsed.directoryCount) || parsed.directoryCount !== directories.length) {
    fail('FRA_RUNTIME_MANIFEST_INVALID', 'Runtime directory count is invalid.');
  }
  if (!Array.isArray(parsed.files) || !Number.isSafeInteger(parsed.fileCount) || parsed.fileCount < 1
      || parsed.fileCount !== parsed.files.length) {
    fail('FRA_RUNTIME_MANIFEST_INVALID', 'Runtime file count is invalid.');
  }
  const files = parsed.files.map(file => {
    if (!plainObject(file) || Object.keys(file).sort().join(',') !== 'bytes,path,sha256'
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || typeof file.sha256 !== 'string' || !DIGEST_RE.test(file.sha256)) {
      fail('FRA_RUNTIME_MANIFEST_INVALID', 'Runtime file record is invalid.');
    }
    return Object.freeze({ path: normalizeRelative(file.path), bytes: file.bytes, sha256: file.sha256 });
  });
  const filePaths = files.map(file => file.path);
  normalizeList(filePaths, 'file paths');
  if (filePaths.some(file => ANCHOR_RE.test(file))) {
    fail('FRA_RUNTIME_MANIFEST_INVALID', 'Runtime integrity anchors must not recursively hash themselves.');
  }
  if (typeof parsed.runtimeDigest !== 'string' || !DIGEST_RE.test(parsed.runtimeDigest)
      || parsed.runtimeDigest !== runtimeDigest(files)) {
    fail('FRA_RUNTIME_DIGEST_MISMATCH', 'Runtime aggregate digest is invalid.');
  }
  const normalized = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    algorithm: HASH_ALGORITHM,
    machine: expectedMachine,
    roots: Object.freeze([...roots]),
    topLevelFiles: Object.freeze([...topLevelFiles]),
    directoryCount: directories.length,
    directories: Object.freeze([...directories]),
    fileCount: files.length,
    files: Object.freeze(files),
    runtimeDigest: parsed.runtimeDigest
  });
  if (canonicalManifest(normalized) !== content) {
    fail('FRA_RUNTIME_MANIFEST_NONCANONICAL', 'Runtime integrity anchor is not canonical JSON.');
  }
  return normalized;
}

function verifyRuntimeIntegrity({
  root,
  host,
  manifestPath,
  expectedRoots = RUNTIME_ROOTS,
  expectedTopLevelFiles,
  fsApi = fs,
  serviceRegistryOptions = {}
} = {}) {
  const repositoryRoot = path.resolve(root);
  const resolved = resolveAnchorPath(repositoryRoot, host, serviceRegistryOptions, fsApi);
  const anchor = manifestPath ? path.resolve(manifestPath) : resolved.path;
  if (anchor !== resolved.path || !insideRoot(repositoryRoot, anchor)) {
    fail('FRA_RUNTIME_MANIFEST_PATH_INVALID', 'Runtime integrity anchor path is not the fixed config path.');
  }
  const firstAnchor = readAndHashRegularFile(repositoryRoot, anchor, { capture: true, fsApi });
  const content = firstAnchor.content.toString('utf8');
  const manifest = parseAndValidateManifest(content, {
    machine: resolved.identity.machineId, expectedRoots, expectedTopLevelFiles, serviceRegistryOptions
  });
  const layout = collectRuntimeLayout({
    root: repositoryRoot, expectedRoots, expectedTopLevelFiles, serviceRegistryOptions, fsApi
  });
  if (JSON.stringify(layout.directories) !== JSON.stringify(manifest.directories)
      || JSON.stringify(layout.files) !== JSON.stringify(manifest.files.map(file => file.path))) {
    fail('FRA_RUNTIME_LAYOUT_MISMATCH', 'Runtime tree has missing or extra entries.');
  }
  for (const expected of manifest.files) {
    const actual = readAndHashRegularFile(repositoryRoot,
      path.resolve(repositoryRoot, ...expected.path.split('/')), { fsApi });
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      fail('FRA_RUNTIME_FILE_HASH_MISMATCH', `Runtime file hash mismatch: ${expected.path}`);
    }
  }
  const finalLayout = collectRuntimeLayout({
    root: repositoryRoot, expectedRoots, expectedTopLevelFiles, serviceRegistryOptions, fsApi
  });
  if (JSON.stringify(finalLayout.directories) !== JSON.stringify(layout.directories)
      || JSON.stringify(finalLayout.files) !== JSON.stringify(layout.files)) {
    fail('FRA_RUNTIME_TREE_CHANGED', 'Runtime tree changed during verification.');
  }
  const finalAnchor = readAndHashRegularFile(repositoryRoot, anchor, { fsApi });
  if (finalAnchor.bytes !== firstAnchor.bytes || finalAnchor.sha256 !== firstAnchor.sha256) {
    fail('FRA_RUNTIME_MANIFEST_CHANGED', 'Runtime integrity anchor changed during verification.');
  }
  return Object.freeze({
    valid: true,
    // `host` stays the resolved ADDRESS so every existing caller keeps its
    // meaning; `machine`/`anchorKeying` expose what the anchor is actually
    // keyed on now.
    host: resolved.identity.address,
    machine: resolved.identity.machineId,
    anchorKeying: resolved.keying,
    fileCount: manifest.fileCount,
    directoryCount: manifest.directoryCount,
    runtimeDigest: manifest.runtimeDigest,
    manifestSha256: firstAnchor.sha256,
    secretValuesEmitted: false
  });
}

// Read a peer declaration without pretending the peer's files live under the
// local repository root. The declaration remains fixed-path, canonical,
// schema-validated, and content-addressed. Only the server that owns `host`
// calls verifyRuntimeIntegrity() against the actual files.
function readRuntimeIntegrityDeclaration({
  root,
  host,
  manifestPath,
  expectedRoots = RUNTIME_ROOTS,
  expectedTopLevelFiles,
  fsApi = fs,
  serviceRegistryOptions = {}
} = {}) {
  const repositoryRoot = path.resolve(root);
  const resolved = resolveAnchorPath(repositoryRoot, host, serviceRegistryOptions, fsApi);
  const anchor = manifestPath ? path.resolve(manifestPath) : resolved.path;
  if (anchor !== resolved.path || !insideRoot(repositoryRoot, anchor)) {
    fail('FRA_RUNTIME_MANIFEST_PATH_INVALID', 'Runtime integrity anchor path is not the fixed config path.');
  }
  const anchored = readAndHashRegularFile(repositoryRoot, anchor, { capture: true, fsApi });
  const content = anchored.content.toString('utf8');
  const manifest = parseAndValidateManifest(content, {
    machine: resolved.identity.machineId, expectedRoots, expectedTopLevelFiles, serviceRegistryOptions
  });
  return Object.freeze({
    valid: true,
    declared: true,
    host: resolved.identity.address,
    machine: resolved.identity.machineId,
    anchorKeying: resolved.keying,
    fileCount: manifest.fileCount,
    directoryCount: manifest.directoryCount,
    runtimeDigest: manifest.runtimeDigest,
    manifestSha256: anchored.sha256,
    secretValuesEmitted: false
  });
}

function writeRuntimeManifest({
  root,
  host,
  expectedPreimage,
  expectedRoots = RUNTIME_ROOTS,
  expectedTopLevelFiles,
  fsApi = fs,
  serviceRegistryOptions = {}
} = {}) {
  if (expectedPreimage !== 'absent' && (typeof expectedPreimage !== 'string' || !DIGEST_RE.test(expectedPreimage))) {
    fail('FRA_RUNTIME_PREIMAGE_REQUIRED', 'An absent or SHA-256 preimage is required.');
  }
  const repositoryRoot = path.resolve(root);
  // Always the identity-keyed name, never the legacy one a reader may still be
  // falling back to: a write is how a tree migrates itself forward.
  const anchor = resolveAnchorPath(repositoryRoot, host, serviceRegistryOptions, fsApi).identityPath;
  const exists = fsApi.existsSync(anchor);
  if (expectedPreimage === 'absent' && exists) fail('FRA_RUNTIME_PREIMAGE_CHANGED', 'Runtime anchor already exists.');
  if (expectedPreimage !== 'absent') {
    if (!exists) fail('FRA_RUNTIME_PREIMAGE_CHANGED', 'Runtime anchor is missing.');
    const current = readAndHashRegularFile(repositoryRoot, anchor, { fsApi });
    if (current.sha256 !== expectedPreimage) fail('FRA_RUNTIME_PREIMAGE_CHANGED', 'Runtime anchor preimage changed.');
  }
  const manifest = buildRuntimeManifest({
    root: repositoryRoot, host, expectedRoots, expectedTopLevelFiles, fsApi, serviceRegistryOptions
  });
  const bytes = Buffer.from(canonicalManifest(manifest), 'utf8');
  assertPathChainNoReparse(repositoryRoot, path.dirname(anchor), fsApi);
  fsApi.mkdirSync(path.dirname(anchor), { recursive: true });
  if (expectedPreimage === 'absent') {
    let handle;
    try {
      handle = fsApi.openSync(anchor, 'wx', 0o600);
      fsApi.writeFileSync(handle, bytes);
      fsApi.fsyncSync(handle);
    } catch (error) {
      if (error instanceof FraRuntimeIntegrityError) throw error;
      fail('FRA_RUNTIME_MANIFEST_WRITE_FAILED', 'Runtime anchor could not be created exclusively.');
    } finally {
      if (handle !== undefined) {
        try { fsApi.closeSync(handle); } catch {}
      }
    }
  } else {
    const temporary = `${anchor}.${process.pid}.${Date.now()}.tmp`;
    let handle;
    try {
      handle = fsApi.openSync(temporary, 'wx', 0o600);
      fsApi.writeFileSync(handle, bytes);
      fsApi.fsyncSync(handle);
      fsApi.closeSync(handle);
      handle = undefined;
      assertPathChainNoReparse(repositoryRoot, temporary, fsApi);
      const current = readAndHashRegularFile(repositoryRoot, anchor, { fsApi });
      if (current.sha256 !== expectedPreimage) fail('FRA_RUNTIME_PREIMAGE_CHANGED', 'Runtime anchor changed before replacement.');
      fsApi.renameSync(temporary, anchor);
    } catch (error) {
      try { fsApi.unlinkSync(temporary); } catch {}
      if (error instanceof FraRuntimeIntegrityError) throw error;
      fail('FRA_RUNTIME_MANIFEST_WRITE_FAILED', 'Runtime anchor replacement failed.');
    } finally {
      if (handle !== undefined) {
        try { fsApi.closeSync(handle); } catch {}
      }
    }
  }
  return verifyRuntimeIntegrity({
    root: repositoryRoot, host, expectedRoots, expectedTopLevelFiles, fsApi, serviceRegistryOptions
  });
}

function legacyAnchorPathFor(root, host, serviceRegistryOptions = {}, fsApi = fs) {
  return resolveAnchorPath(path.resolve(root), host, serviceRegistryOptions, fsApi).legacyPath;
}

function parseCli(argv) {
  const values = { mode: null, host: null, expectedPreimage: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check' || flag === '--write') {
      if (values.mode) fail('FRA_RUNTIME_CLI_INVALID', 'Choose one runtime-integrity action.');
      values.mode = flag.slice(2);
    } else if (flag === '--host' || flag === '--expected-preimage') {
      const value = argv[++index];
      if (!value) fail('FRA_RUNTIME_CLI_INVALID', 'Runtime-integrity option value is missing.');
      values[flag === '--host' ? 'host' : 'expectedPreimage'] = value;
    } else {
      fail('FRA_RUNTIME_CLI_INVALID', 'Unsupported runtime-integrity option.');
    }
  }
  if (!values.mode || (values.mode === 'write' && !values.expectedPreimage)
      || (values.mode === 'check' && values.expectedPreimage)) {
    fail('FRA_RUNTIME_CLI_INVALID', 'Runtime-integrity action is incomplete.');
  }
  try { assertRuntimeHost(values.host); }
  catch (error) {
    if (error instanceof FraRuntimeIntegrityError && error.code === 'FRA_RUNTIME_HOST_INVALID') {
      fail('FRA_RUNTIME_CLI_INVALID', 'Runtime-integrity action is incomplete.');
    }
    throw error;
  }
  return values;
}

if (require.main === module) {
  try {
    const values = parseCli(process.argv.slice(2));
    const root = path.resolve(__dirname, '..', '..');
    const result = values.mode === 'write'
      ? writeRuntimeManifest({ root, host: values.host, expectedPreimage: values.expectedPreimage })
      : verifyRuntimeIntegrity({ root, host: values.host });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const code = error && typeof error.code === 'string' && /^[A-Z0-9_.-]{1,80}$/.test(error.code)
      ? error.code : 'FRA_RUNTIME_INTEGRITY_FAILED';
    process.stdout.write(`${JSON.stringify({ ok: false, code, secretValuesEmitted: false })}\n`);
    process.exitCode = 1;
  }
}

const exported = {
  SCHEMA_VERSION,
  HASH_ALGORITHM,
  RUNTIME_ROOTS,
  EPHEMERAL_RUNTIME_DIRECTORY_NAMES,
  STATIC_TOP_LEVEL_FILES,
  anchoredTopLevelFiles,
  capabilityManifestEntries,
  FraRuntimeIntegrityError,
  manifestPathForHost,
  resolveAnchorPath,
  legacyAnchorPathFor,
  canonicalManifest,
  runtimeDigest,
  isEphemeralRuntimeDirectory,
  collectRuntimeLayout,
  buildRuntimeManifest,
  parseAndValidateManifest,
  readRuntimeIntegrityDeclaration,
  verifyRuntimeIntegrity,
  writeRuntimeManifest
};

// TOP_LEVEL_FILES is no longer a static array: two of its entries are the
// per-machine capability manifests, and those are now derived from whatever
// machines config/service-registry.json declares. It stays exported under the
// same name, and still reads as a frozen array, so existing consumers keep
// working -- it is simply computed when read rather than when this module
// loads, because reading the registry at load time would make an unreadable
// registry a module-load crash instead of a named refusal.
Object.defineProperty(exported, 'TOP_LEVEL_FILES', {
  enumerable: true,
  get() { return anchoredTopLevelFiles(); }
});

module.exports = Object.freeze(exported);

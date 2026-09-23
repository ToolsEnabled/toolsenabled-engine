'use strict';

// Scoped repo file access for a remote MCP caller.
//
// WHY IT EXISTS (R117). A paired second machine can already execute the full
// ToolsEnabled tool surface through src/remote-agent-bridge.js, and the
// requirement was that the remote side get COMPLETE access to the system --
// which execution alone does not give it. A remote agent implementing a queued
// build phase has to make real, persistent, verifiable changes to THIS
// repository's tracked files, and nothing else in the tool surface reaches the
// live tree (sandbox.workspace_read/write is scoped to an isolated, disposable
// sandbox root, deliberately not this repo).
//
// Path safety mirrors the exact pattern already used throughout this
// codebase (owner-host.js's inside(), agent-sandbox.js's sandboxPaths()):
// resolve, then require path.relative(root, resolved) to be free of '..'
// and not absolute.
//
// WRITE PROTECTION. A handful of files are this session's own trust
// anchors -- the owner-request ledger, standing orders, the elevation
// allowlist, the model floor, package.json -- and must never be overwritten
// wholesale by a generic file-write tool, even by an agent with otherwise
// "complete access." Each of those already has its own narrow, purpose-built
// writer (tools/owner-capture.js for the ledger, a reviewed local-write
// authorization for STANDING-ORDERS.md, etc.); this tool is not a substitute
// for any of them.
// state/, vault/, logs/, profiles/, .git/, node_modules/ are excluded
// entirely (read AND write) as tool-managed runtime data, matching the
// "do not explore" convention already documented for this repo.
//
// An adversarial review of this module found it had NO assertActive
// (kill-switch) call and NO audit record at all -- unlike every other
// consequential tool in this registry -- and that its write protection was
// missing exactly the files that matter most: config/toolsenabled.policy.json
// (which names the kill-switch file, the approvals list, and the
// http.vaultKeys bindings -- rewriting it can silently disable the kill
// switch or redirect a vault secret to an attacker host), the governance
// files an agent is judged by (CLAUDE.md, BUILD-QUEUE.md,
// docs/ROLE-OPERATIONS.md), and the scheduled-process entry points
// config/managed-processes.json declares (sidecars/local-coder/bin/server.js
// and neighbours, tools/fleet-supervisor.js, ...) --
// writing one of those is a delayed-execution path with no host.exec
// required at all, since a scheduled task or the next restart runs it as the
// owner. Rather than protect config/ file by file (the same enumerated-list
// mistake that missed toolsenabled.policy.json in the first place),
// WRITE_PROTECTED_DIR_NAMES now excludes the whole directory from writes
// while keeping it readable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { assertActive } = require('../policy');
const audit = require('../audit');
const operationAudit = require('../operation-audit');
const { canonicalizeForContainment } = require('../canonical-path');
const { withSharedWrite } = require('../shared-write-guard');
const fileToolContext = require('../file-tool-context');

let coordinatedAuthority;
let coordinatedStateRoot;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function coordinationResource(resource, publicationPath = resource) {
  const relative = path.relative(getCanonicalRoot(), publicationPath).split(path.sep).join('/');
  // This is an authority-owned canonical resource, not a public path input.
  // FRA handles can name legitimate paths longer than repo's input bound.
  const located = resolveRepoLocation(relative);
  const canonical = path.join(getCanonicalRoot(), ...located.canonicalRelative.split('/'));
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (key(canonical) !== key(resource)) fail('REPO_FILE_PATH_FORBIDDEN', 'The coordinated resource identity changed; read the canonical file again.');
  // The authority's Windows comparison key is case-folded. Use the actual
  // canonical spelling for filesystem publication so rename does not also
  // silently change the user's filename casing.
  return { ...located, resolved: canonical };
}

function materializeCoordinated(resource) {
  const { resolved, relative } = coordinationResource(resource);
  let descriptor;
  let openedSnapshot = false;
  const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
  try {
    const before = fs.lstatSync(resolved, { bigint: true });
    openedSnapshot = true;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      fail('REPO_FILE_PATH_FORBIDDEN', 'Coordinated reads require a regular file without symbolic or hard-link aliases.');
    }
    if (before.size > BigInt(MAX_FILE_BYTES)) fail('REPO_FILE_TOO_LARGE', `${relative} is larger than the ${MAX_FILE_BYTES}-byte limit.`);
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!same(before, fs.fstatSync(descriptor, { bigint: true }))) fail('REPO_FILE_CHANGED_DURING_READ', 'The file changed while opening it; read it again.');
    // Bounded descriptor reads also reject a file that grows after stat.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_FILE_BYTES) fail('REPO_FILE_TOO_LARGE', `${relative} grew beyond the ${MAX_FILE_BYTES}-byte limit.`);
    const after = fs.fstatSync(descriptor, { bigint: true });
    coordinationResource(resource);
    if (!same(before, after) || !same(after, fs.lstatSync(resolved, { bigint: true })) || BigInt(length) !== after.size) {
      fail('REPO_FILE_CHANGED_DURING_READ', 'The file changed while its bytes were being observed; read it again.');
    }
    return { bytes: Buffer.from(buffer.subarray(0, length)), identity: `${after.dev}:${after.ino}` };
  } catch (error) {
    if (error?.code === 'ENOENT' && !openedSnapshot) return { present: false };
    if (error?.code === 'ENOENT') fail('REPO_FILE_CHANGED_DURING_READ', 'The file disappeared while its bytes were being observed; read it again.');
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function publishCoordinated(publication) {
  // Keep the legacy whole-file writers in this publication boundary while
  // those remaining adapters are migrated. This callback is synchronous:
  // withSharedWrite must never release its lock around an unfinished Promise.
  return withSharedWrite(publication.resource, () => publishCoordinatedLocked(publication));
}

function publishCoordinatedLocked(publication) {
  assertWritableRepo();
  const { resource, publicationPath, operationId, before, after, beforeSha256, afterSha256, assertCurrent, op } = publication;
  const { resolved, relative, canonicalRelative } = coordinationResource(resource, publicationPath);
  if (isWriteProtectedPath(relative.toLowerCase()) || isWriteProtectedPath(canonicalRelative.toLowerCase())) {
    fail('REPO_FILE_WRITE_PROTECTED', `${relative} has a dedicated writer and cannot be patched through this tool.`);
  }
  if (!Buffer.isBuffer(after) || after.length > MAX_FILE_BYTES || sha256(after) !== afterSha256) fail('REPO_FILE_PATCH_INVALID', 'The prepared patch bytes are invalid.');
  if (publication.beforePresent === false) return publishCoordinatedCreate(publication);
  const current = materializeCoordinated(resource).bytes;
  if (!current || sha256(current) !== beforeSha256 || !current.equals(before)) fail('REPO_FILE_CHANGED_BEFORE_WRITE', 'The file changed outside mediated coordination; no write was published.');
  if (typeof assertCurrent !== 'function') fail('REPO_FILE_COORDINATION_IDENTITY_REQUIRED', 'Publication requires a live private transport scope.');
  assertCurrent();
  operationAudit.requireRecord(op === 'write' ? 'repo.write_file.intent' : 'repo.patch_file.intent', relative, {
    operationId, bytes: after.length, beforeSha256, afterSha256
  });
  const mode = fs.lstatSync(resolved).mode;
  const temporary = path.join(path.dirname(resolved), `.te-replace-${process.pid}-${crypto.randomUUID()}.tmp`);
  let descriptor;
  let temporaryOwned = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    temporaryOwned = true;
    fs.writeFileSync(descriptor, after);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    // The authority holds its cross-process transaction throughout. An
    // unmediated editor is outside that lock; observed drift still refuses.
    if (!materializeCoordinated(resource).bytes?.equals(before)) fail('REPO_FILE_CHANGED_BEFORE_WRITE', 'The file changed before publication; no write was published.');
    // There is no await between this private revocation check and publication.
    // An earlier awaited authority check alone leaves a microtask race here.
    assertCurrent();
    fs.renameSync(temporary, resolved);
    return { published: true };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    // Only this call's exact, exclusively-created temporary leaf is removed.
    if (temporaryOwned) {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function creationPaths({ resource, publicationPath, operationId, stagingPath, createPreparation }) {
  assertWritableRepo();
  const located = coordinationResource(resource, publicationPath);
  if (isWriteProtectedPath(located.relative.toLowerCase()) || isWriteProtectedPath(located.canonicalRelative.toLowerCase())) {
    fail('REPO_FILE_WRITE_PROTECTED', 'The creation target has a dedicated writer.');
  }
  if (typeof operationId !== 'string' || !/^operation-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)) {
    fail('REPO_FILE_CREATE_IDENTITY_INVALID', 'Creation requires an authority-owned operation identity.');
  }
  const expected = path.join(path.dirname(publicationPath), '.te-' + operationId + '.create.tmp');
  if ((stagingPath || createPreparation?.stagingPath) !== expected || path.dirname(expected) !== path.dirname(located.resolved)) {
    fail('REPO_FILE_CREATE_IDENTITY_INVALID', 'The staged creation path is not the exact operation-owned sibling.');
  }
  return { ...located, stagingPath: expected };
}

function creationStat(filename) {
  try { return fs.lstatSync(filename, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function verifyCreationLeaf(filename, preparation, links) {
  const before = creationStat(filename);
  const matches = stat => stat && stat.isFile() && !stat.isSymbolicLink()
    && stat.dev.toString() === preparation.device && stat.ino.toString() === preparation.inode
    && stat.size === BigInt(preparation.bytes) && stat.nlink === BigInt(links);
  if (!matches(before)) fail('REPO_FILE_CREATE_IDENTITY_INVALID', 'The creation leaf no longer has its prepared identity and exact link count.');
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!matches(fs.fstatSync(descriptor, { bigint: true }))) fail('REPO_FILE_CREATE_IDENTITY_INVALID', 'The creation leaf changed while opening.');
    const buffer = Buffer.alloc(preparation.bytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const final = creationStat(filename);
    if (!matches(after) || !matches(final) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || after.mtimeNs !== final.mtimeNs || after.ctimeNs !== final.ctimeNs
        || count !== preparation.bytes || sha256(buffer.subarray(0, count)) !== preparation.sha256) {
      fail('REPO_FILE_CREATE_IDENTITY_INVALID', 'The creation leaf changed while its prepared bytes were verified.');
    }
  } finally { fs.closeSync(descriptor); }
}

function prepareCoordinatedCreate(preparation) {
  const { resource, operationId, after, afterSha256, assertCurrent } = preparation;
  const located = creationPaths(preparation);
  if (!Buffer.isBuffer(after) || after.length > MAX_FILE_BYTES || sha256(after) !== afterSha256 || typeof assertCurrent !== 'function') {
    fail('REPO_FILE_CREATE_IDENTITY_INVALID', 'Creation requires bounded prepared bytes and a live private scope.');
  }
  assertCurrent();
  operationAudit.requireRecord('repo.write_file.intent', located.relative, {
    operationId, bytes: after.length, beforeSha256: null, afterSha256, publicationMode: 'create-only'
  });
  fs.mkdirSync(path.dirname(located.resolved), { recursive: true });
  creationPaths(preparation);
  const descriptor = fs.openSync(located.stagingPath, 'wx');
  // Before PREPARED, a crash can leave an unreferenced exclusive stage. It is
  // never a published target, and recovery must not infer ownership by age.
  try {
    fs.writeFileSync(descriptor, after);
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const result = { stagingPath: located.stagingPath, device: stat.dev.toString(), inode: stat.ino.toString(), sha256: afterSha256, bytes: after.length };
    coordinationResource(resource, preparation.publicationPath);
    verifyCreationLeaf(located.stagingPath, result, 1);
    assertCurrent();
    return result;
  } finally { fs.closeSync(descriptor); }
}

function publishCoordinatedCreate(publication) {
  const { resolved, stagingPath } = creationPaths(publication);
  const { createPreparation, assertCurrent } = publication;
  if (publication.op !== 'write' || publication.publicationMode !== 'create-only') {
    fail('REPO_FILE_CREATE_IDENTITY_INVALID', 'Creation must use atomic no-replace publication.');
  }
  verifyCreationLeaf(stagingPath, createPreparation, 1);
  creationPaths(publication);
  assertCurrent();
  // Unlike rename, link is an atomic no-replace operation. EEXIST never erases
  // an intervening editor's file. PREPARED already names the stage's identity.
  fs.linkSync(stagingPath, resolved);
  reconcileCoordinatedCreate({ ...publication, afterBytes: publication.after.length });
  return { published: true, publicationMode: 'create-only' };
}

function reconcileCoordinatedCreate(publication) {
  const { resolved, stagingPath } = creationPaths(publication);
  const { createPreparation: preparation, afterSha256, afterBytes } = publication;
  if (!preparation || preparation.sha256 !== afterSha256 || preparation.bytes !== afterBytes
      || !Number.isSafeInteger(afterBytes) || afterBytes < 0 || afterBytes > MAX_FILE_BYTES) {
    fail('REPO_FILE_CREATE_IDENTITY_INVALID', 'Creation recovery requires the exact bounded prepared digest.');
  }
  const stage = creationStat(stagingPath);
  const target = creationStat(resolved);
  const links = stage && target ? 2 : 1;
  // Matching bytes alone are not our publication identity. A replaced target,
  // an unrelated hard link or a changed stage remains UNKNOWN and untouched.
  if (target) verifyCreationLeaf(resolved, preparation, links);
  if (stage) {
    verifyCreationLeaf(stagingPath, preparation, links);
    creationPaths(publication);
    fs.unlinkSync(stagingPath);
  }
  if (target) verifyCreationLeaf(resolved, preparation, 1);
  return { reconciled: true };
}

function byteAuthority(scope) {
  const stateRoot = require('../runtime-state-root').statePath();
  if (!coordinatedAuthority || coordinatedStateRoot !== stateRoot) {
    coordinatedAuthority = require('../region-holds/byte-authority').createByteAuthority({
      stateRoot, materialize: materializeCoordinated, publish: publishCoordinated,
      prepareCreate: prepareCoordinatedCreate, reconcileCreateStage: reconcileCoordinatedCreate
    });
    coordinatedStateRoot = stateRoot;
  }
  if (scope) {
    const binding = fileToolContext.requireFileToolContext(scope);
    const authority = coordinatedAuthority;
    fileToolContext.onFileToolContextRetired(scope, authority, reason => authority.closeLaunch({ binding, reason }));
  }
  return coordinatedAuthority;
}

function decodeWindow(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('REPO_FILE_UTF8_BOUNDARY_INVALID', 'The returned byte window is not complete UTF-8 text; use character-aligned offsets or a binary-capable reader.'); }
}

function assertCoordinatedPath(resolved, relative) {
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    fail('REPO_FILE_PATH_FORBIDDEN', 'Coordinated file tools refuse symbolic links.');
  }
  if (!stat.isFile()) fail('REPO_FILE_NOT_FOUND', `${relative} is not a regular file.`);
  // Hard-link checks happen in private materialization AFTER relevant journal
  // recovery. Only an exact PREPARED create may retire its second stage link.
}

const ROOT = path.resolve(__dirname, '..', '..', '..');
// Canonicalized on first use so merely importing this provider does not touch
// the filesystem. The canonical-form containment check below still compares
// like with like. An adversarial security review found the
// companion host-control.js module's lexical-only path checks
// defeated by a Windows reparse point in the ancestor chain; this module has
// the same lexical-containment/final-lstat-only shape (resolveInsideRepo,
// readFile, writeFile, listDir), so it gets the identical fix even though no
// reparse point is observed inside the live repo today -- one created later
// (locally, or a future Windows profile alias) would otherwise bypass
// EXCLUDED_DIR_NAMES/WRITE_PROTECTED_* the same way.
let canonicalRoot;

function getCanonicalRoot() {
  if (canonicalRoot === undefined) canonicalRoot = fs.realpathSync.native(ROOT);
  return canonicalRoot;
}
const MAX_FILE_BYTES = 512 * 1024;
const MAX_PATH_LENGTH = 400;
const MAX_LIST_ENTRIES = 2000;

const EXCLUDED_DIR_NAMES = new Set(['state', 'vault', 'logs', 'profiles', '.git', 'node_modules']);
// Whole directories that stay readable but refuse every write.
// `bin` is here because this list named a CONVENTION and not this package's
// declared entry points -- the same miss found in the companion host-control.js
// fence on 2026-08-25. package.json `bin` maps `fallback` -> bin/fallback.js and
// `localcode` -> bin/localcode.js, and both are listed in
// config/invocation-registry.json and config/payload-boundary.json, so they are
// shipped, invoked code by the repo's own declarations. They were WRITE-ALLOWED
// through repo.write_file/repo.patch_file until this line, which is the same
// class as src/mcp-server.js being protected two lists down.
//
// `shell` is deliberately NOT added: ROOT here is the module's own package root
// (path.resolve(__dirname,'..','..','..')), which in the desktop payload is
// .../desktop-app/capability, so that tree's shell/main.cjs is outside this
// resolver's reach entirely. It is fenced in host-control.js, where it IS
// reachable. Adding an unreachable rule would be decoration, not a fence.
const WRITE_PROTECTED_DIR_NAMES = new Set([
  'config', 'src', 'bin', 'tools', 'scripts', 'sidecars', 'packages', 'captures', 'scratch', 'tmp'
]);
// Credential/history files reachable from the repo surface are excluded from
// read, list, and write alike. Keep this bounded so an ordinary repo file
// remains usable beside a protected store.
const EXCLUDED_FILE_PATTERNS = [
  /(?:^|[\\/])\.npmrc$/i,
  /(?:^|[\\/])\.pypirc$/i,
  /(?:^|[\\/])NuGet[\\/]NuGet\.Config$/i,
  /(?:^|[\\/])\.nuget[\\/]NuGet\.Config$/i,
  /(?:^|[\\/])\.azure[\\/](?:azureProfile\.json|AzureRmContext\.json|accessTokens\.json|msal_token_cache\.bin)$/i,
  /(?:^|[\\/])\.terraform\.d[\\/]credentials\.tfrc\.json$/i,
  /(?:^|[\\/])\.config[\\/]gh[\\/]hosts\.ya?ml$/i,
  /(?:^|[\\/])(?:WindowsPowerShell|PowerShell)[\\/]PSReadLine[\\/]ConsoleHost_history\.txt$/i,
  /(?:^|[\\/])ConsoleHost_history\.txt$/i,
  /(?:^|[\\/])\.(?:bash_history|zsh_history|fish_history|python_history)$/i
];
const COMMON_CREDENTIAL_STORE_PATTERN = /(?:^|[\\/])(?:\.(?:auth|token|tokens|cookie|cookies|credential|credentials|session|sessions)|auth|token|tokens|cookie|cookies|credential|credentials|session|sessions)(?:[._-][^\\/]*)?\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|db|sqlite3?)$/i;

function isProtectedEnvironmentPath(relativePath) {
  const basename = path.posix.basename(String(relativePath).replace(/\\/g, '/')).toLowerCase();
  if (basename === '.env') return true;
  if (!basename.startsWith('.env.')) return false;
  return !['.env.example', '.env.template', '.env.sample'].includes(basename);
}

function isCredentialOrHistoryPath(relativePath) {
  return EXCLUDED_FILE_PATTERNS.some(pattern => pattern.test(relativePath))
    || COMMON_CREDENTIAL_STORE_PATTERN.test(relativePath)
    || isProtectedEnvironmentPath(relativePath);
}

// Files that define and run the local native-write guard are declared here,
// beside the files they protect.  The hook imports these sets lazily; keeping
// this metadata in the same module prevents a second hand-maintained
// protected-files list from drifting away from repo.write_file's boundary.
const WRITE_GUARD_CONTROL_FILES = new Set([
  '.claude/settings.json',
  'tools/standing-orders-hook.js'
].map(p => p.toLowerCase()));

const WRITE_PROTECTED_FILES = new Set([
  ...WRITE_GUARD_CONTROL_FILES,
  'reports/OWNER-REQUEST-LEDGER.json',
  'reports/OWNER-REQUEST-LEDGER.json.bak',
  'reports/TOOLSENABLED-SUGGESTIONS.md',
  'STANDING-ORDERS.md',
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  'BUILD-QUEUE.md',
  'KILLSWITCH',
  'docs/ROLE-OPERATIONS.md',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  // The vault decryptor itself, and every process entry point/registrar a
  // scheduled task or the elevated UAC helper runs by repo-relative path
  // (config/managed-processes.json + config/uac-delegation-allowlist.json).
  // Writing any of these is arbitrary-code-execution-on-a-timer, not a file
  // edit; none of them are legitimate BUILD-QUEUE targets.
  'tools/secrets.ps1',
  'sidecars/local-coder/bin/overnight-advisory-worker.js',
  'sidecars/local-coder/bin/controller-projection-worker.js',
  'src/job-runner.js',
  'src/mcp-server.js',
  'src/owner-host.js',
  'src/remote-agent-bridge.js',
  'src/uac-delegation-helper.js',
  'src/agent-digest.js',
  'tools/fleet-supervisor.js',
  'tools/health-observer.js',
  'tools/coordinator-duty-host.js',
  'tools/register-managed-tasks.js'
].map(p => p.toLowerCase()));

// This resolver names the running package, not the caller's workspace. Every
// byte of a cut payload is integrity checked, including newly added reports.
function assertWritableRepo() {
  if (require('../runtime-state-root').isPackagedPayload(ROOT)) {
    fail('REPO_FILE_WRITE_PROTECTED', 'This repository is the installed app payload. Save your work in an explicit writable workspace outside the installation.');
  }
}

function isWriteProtectedPath(relativeLower) {
  if (require('../runtime-state-root').isPackagedPayload(ROOT)) return true;
  if (WRITE_PROTECTED_FILES.has(relativeLower)) return true;
  const firstSegment = relativeLower.split('/')[0];
  if (WRITE_PROTECTED_DIR_NAMES.has(firstSegment)) return true;
  // Every *.ps1 under tools/ is a potential elevated-helper or scheduled-task
  // script; config/uac-delegation-allowlist.json:91-95 already documents that
  // a writable registrar script defeats the elevation allowlist regardless of
  // which operation id is invoked.
  if (/^tools\/.*\.ps1$/.test(relativeLower)) return true;
  return false;
}

class RepoFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RepoFileError';
    this.code = code;
  }
}

function fail(code, message) { throw new RepoFileError(code, message); }

// Runs the containment + excluded-directory check against ONE candidate
// resolved path, compared to ONE root. Called twice by resolveInsideRepo:
// once for the lexical (path.resolve) form against ROOT, once for the
// canonical (reparse-point-resolved) form against CANONICAL_ROOT.
function checkRepoContainment(candidateResolved, root, { allowRoot = false } = {}) {
  const relative = path.relative(root, candidateResolved);
  if ((!allowRoot && relative === '') || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('REPO_FILE_PATH_INVALID', 'path escaped the repository root.');
  }
  const firstSegment = relative.split(path.sep)[0].toLowerCase();
  if (EXCLUDED_DIR_NAMES.has(firstSegment)) {
    fail('REPO_FILE_PATH_FORBIDDEN', `path is inside a tool-managed directory (${firstSegment}) and is never exposed here.`);
  }
  return relative;
}

function checkRepoFileExclusion(relativePath) {
  if (isCredentialOrHistoryPath(relativePath)) {
    fail('REPO_FILE_PATH_FORBIDDEN', 'path is a credential, session, environment-secret, or shell-history store and is never exposed here.');
  }
}

// Returns the resolved absolute path for a caller-supplied relative path, or
// throws. Never returns a path outside ROOT, and never one whose FIRST
// path segment is an excluded directory name -- checked on both the lexical
// path and its real, reparse-point-resolved canonical form (see the header
// comment and src/lib/canonical-path.js). canonicalRelative equals relative
// whenever the two forms agree, which is the common case.
function resolveInsideRepo(relativePath, { allowRoot = false } = {}) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    fail('REPO_FILE_PATH_INVALID', 'path must be a non-empty string.');
  }
  if (relativePath.length > MAX_PATH_LENGTH) fail('REPO_FILE_PATH_INVALID', `path must be at most ${MAX_PATH_LENGTH} characters.`);
  return resolveRepoLocation(relativePath, { allowRoot });
}

function resolveRepoLocation(relativePath, { allowRoot = false } = {}) {
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    fail('REPO_FILE_PATH_INVALID', 'path must be relative to the repository root.');
  }
  const resolved = path.resolve(ROOT, relativePath);
  const relative = checkRepoContainment(resolved, ROOT, { allowRoot });
  const relativeForward = relative.split(path.sep).join('/');
  checkRepoFileExclusion(relativeForward);
  let canonical;
  try { canonical = canonicalizeForContainment(resolved); }
  catch { fail('REPO_FILE_PATH_INVALID', 'path could not be canonicalized against the real filesystem.'); }
  const canonicalRelative = canonical === resolved ? relative : checkRepoContainment(canonical, getCanonicalRoot(), { allowRoot });
  const canonicalForward = canonicalRelative.split(path.sep).join('/');
  if (canonical !== resolved) checkRepoFileExclusion(canonicalForward);
  return {
    resolved,
    relative: relativeForward,
    canonicalRelative: canonicalForward
  };
}

function readFile({ path: relativePath, startByte, endByte } = {}, options) {
  assertActive('repo.read_file');
  const { resolved, relative, canonicalRelative } = resolveInsideRepo(relativePath);
  if (options && (Object.hasOwn(options, 'fileToolContext') || Object.hasOwn(options, 'fileToolInvocation'))) {
    const scope = options.fileToolContext;
    const binding = fileToolContext.requireFileToolContext(scope);
    const invocation = options.fileToolInvocation;
    const currentToolInvocation = fileToolContext.consumeFileToolInvocation(invocation, scope, 'repo.read_file');
    assertCoordinatedPath(resolved, relative);
    const resource = path.join(getCanonicalRoot(), ...canonicalRelative.split('/'));
    const assertCurrent = () => { assertActive('repo.read_file'); return fileToolContext.assertFileToolInvocationCurrent(invocation, scope, 'repo.read_file'); };
    return byteAuthority(scope).observeRead({
      binding, resource, startByte, endByte,
      assertCurrent,
      validateRead: ({ bytes }) => decodeWindow(bytes)
    }).then(observed => {
      assertCurrent();
      return { path: relative, content: decodeWindow(observed.bytes), bytes: observed.bytes.length,
        receipt: observed.receipt, invalidations: observed.invalidations, currentToolInvocation };
    });
  }
  // Direct provider calls are an unmediated compatibility surface, not an
  // attributed read. The registry always supplies a private transport scope.
  if (startByte !== undefined || endByte !== undefined) fail('REPO_FILE_COORDINATION_IDENTITY_REQUIRED', 'Byte-window reads require the mediated repository tool.');
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch (error) {
    if (error && error.code === 'ENOENT') fail('REPO_FILE_NOT_FOUND', `${relative} does not exist.`);
    throw error;
  }
  if (stat.isSymbolicLink()) fail('REPO_FILE_PATH_FORBIDDEN', 'symbolic links are not readable through this tool.');
  if (!stat.isFile()) fail('REPO_FILE_NOT_FOUND', `${relative} is not a regular file.`);
  if (stat.size > MAX_FILE_BYTES) fail('REPO_FILE_TOO_LARGE', `${relative} is larger than the ${MAX_FILE_BYTES}-byte limit.`);
  const content = fs.readFileSync(resolved, 'utf8');
  operationAudit.record('repo.read_file', relative, { bytes: stat.size });
  return { path: relative, content, bytes: Buffer.byteLength(content, 'utf8') };
}

function writeFile({ path: relativePath, content } = {}, options) {
  assertActive('repo.write_file');
  assertWritableRepo();
  const { resolved, relative, canonicalRelative } = resolveInsideRepo(relativePath);
  // Checked on BOTH forms: a target whose lexical spelling looks harmless
  // but whose real, reparse-point-resolved location is a protected file
  // (or vice versa) must be caught either way.
  if (isWriteProtectedPath(relative.toLowerCase()) || isWriteProtectedPath(canonicalRelative.toLowerCase())) {
    fail('REPO_FILE_WRITE_PROTECTED', `${relative} has its own dedicated writer (or is a scheduled/elevated entry point) and is never overwritten through this generic tool.`);
  }
  if (typeof content !== 'string') fail('REPO_FILE_CONTENT_INVALID', 'content must be a string.');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) fail('REPO_FILE_TOO_LARGE', `content is larger than the ${MAX_FILE_BYTES}-byte limit.`);
  if (options && (Object.hasOwn(options, 'fileToolContext') || Object.hasOwn(options, 'fileToolInvocation'))) {
    const scope = options.fileToolContext;
    const binding = fileToolContext.requireFileToolContext(scope);
    const invocation = options.fileToolInvocation;
    const currentToolInvocation = fileToolContext.consumeFileToolInvocation(invocation, scope, 'repo.write_file');
    assertCoordinatedPath(resolved, relative);
    const bytes = Buffer.from(content, 'utf8');
    if (decodeWindow(bytes) !== content) fail('REPO_FILE_CONTENT_INVALID', 'Content must not contain unmatched UTF-16 surrogates.');
    const resource = path.join(getCanonicalRoot(), ...canonicalRelative.split('/'));
    const assertCurrent = () => { assertActive('repo.write_file'); return fileToolContext.assertFileToolInvocationCurrent(invocation, scope, 'repo.write_file'); };
    return byteAuthority(scope).applyWrite({ binding, resource, bytes, assertCurrent }).then(applied => {
      try { assertCurrent(); }
      catch (error) {
        throw Object.assign(new RepoFileError('BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED',
          'The whole-file write committed before this scope was revoked; inspect before retrying.'), {
          details: { publicationCommitted: true, operationId: applied.receipt.operationId,
            noOp: applied.receipt.noOp, resource, causeCode: error.code || 'SCOPE_REVOKED' }
        });
      }
      return { path: relative, ...applied, currentToolInvocation };
    });
  }
  let existingIsSymlink = false;
  try { existingIsSymlink = fs.lstatSync(resolved).isSymbolicLink(); }
  catch (error) {
    // ENOENT is the sole positive answer that there is no existing target.
    // Resource exhaustion, I/O failure, and timeouts mean the filesystem did
    // not answer; treating those as absence would incorrectly permit a write.
    if (!error || error.code !== 'ENOENT') {
      fail(
        'REPO_FILE_EXISTENCE_UNKNOWN',
        `${relative} could not be checked for an existing file; this is not a claim that it is absent.`
      );
    }
  }
  if (existingIsSymlink) fail('REPO_FILE_PATH_FORBIDDEN', 'refusing to write through a symbolic link.');
  const canonicalTarget = path.join(getCanonicalRoot(), ...canonicalRelative.split('/'));
  return withSharedWrite(canonicalTarget, () => {
    // requireRecord (not record): if the durable audit write fails, the write
    // does not happen. An unlogged repo write is exactly the gap the review found.
    operationAudit.requireRecord('repo.write_file.intent', relative, { bytes: Buffer.byteLength(content, 'utf8') });
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const temp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, resolved);
    return { path: relative, bytes: Buffer.byteLength(content, 'utf8') };
  });
}

// Replace one exact, unique span instead of making callers resend an entire
// file. Requiring a unique match makes the caller's read/modify/write intent
// explicit and prevents a stale or underspecified edit from changing the
// wrong occurrence.
function patchFile({ path: relativePath, oldText, newText } = {}, options) {
  assertActive('repo.patch_file');
  assertWritableRepo();
  const { resolved, relative, canonicalRelative } = resolveInsideRepo(relativePath);
  if (isWriteProtectedPath(relative.toLowerCase()) || isWriteProtectedPath(canonicalRelative.toLowerCase())) {
    fail('REPO_FILE_WRITE_PROTECTED', `${relative} has its own dedicated writer (or is a scheduled/elevated entry point) and is never patched through this generic tool.`);
  }
  if (typeof oldText !== 'string' || oldText.length === 0) {
    fail('REPO_FILE_PATCH_INVALID', 'oldText must be a non-empty string.');
  }
  if (typeof newText !== 'string') fail('REPO_FILE_PATCH_INVALID', 'newText must be a string.');

  if (options && (Object.hasOwn(options, 'fileToolContext') || Object.hasOwn(options, 'fileToolInvocation'))) {
    const scope = options.fileToolContext;
    const binding = fileToolContext.requireFileToolContext(scope);
    const invocation = options.fileToolInvocation;
    const currentToolInvocation = fileToolContext.consumeFileToolInvocation(invocation, scope, 'repo.patch_file');
    assertCoordinatedPath(resolved, relative);
    const resource = path.join(getCanonicalRoot(), ...canonicalRelative.split('/'));
    const expected = Buffer.from(oldText, 'utf8');
    const replacement = Buffer.from(newText, 'utf8');
    if (decodeWindow(expected) !== oldText || decodeWindow(replacement) !== newText) fail('REPO_FILE_PATCH_INVALID', 'Patch text must not contain unmatched UTF-16 surrogates.');
    const assertCurrent = () => { assertActive('repo.patch_file'); return fileToolContext.assertFileToolInvocationCurrent(invocation, scope, 'repo.patch_file'); };
    return byteAuthority(scope).applyPatch({
      binding, resource,
      assertCurrent,
      derivePatch: ({ bytes }) => {
        const first = bytes.indexOf(expected);
        if (first === -1) fail('REPO_FILE_PATCH_MISMATCH', 'oldText was not found; read the file again and retry with an exact span.');
        if (bytes.indexOf(expected, first + 1) !== -1) fail('REPO_FILE_PATCH_AMBIGUOUS', 'oldText occurs more than once; include more surrounding text.');
        if (bytes.length - expected.length + replacement.length > MAX_FILE_BYTES) fail('REPO_FILE_TOO_LARGE', 'The patched file exceeds the repository byte limit.');
        return { startByte: first, endByte: first + expected.length, replacement };
      }
    }).then(applied => {
      try { assertCurrent(); }
      catch (error) {
        // Revocation can also arrive while the resolved store promise travels
        // back through this adapter. Never describe an already committed write
        // as if an ordinary identity refusal proved that no effect occurred.
        throw Object.assign(new RepoFileError('BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED',
          'The patch committed before this scope was revoked; no additional content is released.'), {
          details: { publicationCommitted: true, operationId: applied.receipt.operationId,
            resource, causeCode: error.code || 'SCOPE_REVOKED' }
        });
      }
      return { path: relative, ...applied, replacements: 1, currentToolInvocation };
    });
  }

  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch (error) {
    if (error && error.code === 'ENOENT') fail('REPO_FILE_NOT_FOUND', `${relative} does not exist.`);
    throw error;
  }
  if (stat.isSymbolicLink()) fail('REPO_FILE_PATH_FORBIDDEN', 'refusing to patch through a symbolic link.');
  if (!stat.isFile()) fail('REPO_FILE_NOT_FOUND', `${relative} is not a regular file.`);
  if (stat.size > MAX_FILE_BYTES) fail('REPO_FILE_TOO_LARGE', `${relative} is larger than the ${MAX_FILE_BYTES}-byte limit.`);

  /* THIS READ-MODIFY-WRITE WAS UNGUARDED, ON CUSTOMER FILES, THIRTY LINES BELOW
   * THE GUARD THAT PROTECTS writeFile.
   *
   * writeFile takes withSharedWrite on the canonical target before it writes
   * (see above). patchFile read the file, spliced it, and renamed a temp over it
   * with nothing held. Two concurrent patches -- or a patch racing a write --
   * therefore lost an update: both read the same bytes, both computed a patch
   * against them, and whichever renamed last erased the other. Atomic rename
   * prevents torn bytes; it does nothing about this.
   *
   * THE READ HAS TO BE INSIDE THE GUARD, not just the write, and that is the
   * part it would be easy to get wrong. Guarding only the write still lets both
   * callers read the pre-patch content, and the uniqueness check below would
   * pass for BOTH of them -- oldText really does occur exactly once in what each
   * one read -- so the second would overwrite the first while every check it
   * made was satisfied. The lost update would look like a successful patch.
   *
   * THE KEY MUST MATCH writeFile's. canonicalTarget is computed the same way
   * here, from getCanonicalRoot() and canonicalRelative, so a patch and a write
   * to one file contend for one lock. Two different spellings of the same path
   * would take two different locks and exclude nothing, which is the failure
   * mode that looks exactly like success. */
  const canonicalTarget = path.join(getCanonicalRoot(), ...canonicalRelative.split('/'));
  return withSharedWrite(canonicalTarget, () => {
    const content = fs.readFileSync(resolved, 'utf8');
    const firstMatch = content.indexOf(oldText);
    if (firstMatch === -1) fail('REPO_FILE_PATCH_MISMATCH', 'oldText was not found; read the file again and retry with an exact span.');
    if (content.indexOf(oldText, firstMatch + 1) !== -1) {
      fail('REPO_FILE_PATCH_AMBIGUOUS', 'oldText occurs more than once; include more surrounding text so the match is unique.');
    }
    const patched = content.slice(0, firstMatch) + newText + content.slice(firstMatch + oldText.length);
    const bytes = Buffer.byteLength(patched, 'utf8');
    if (bytes > MAX_FILE_BYTES) fail('REPO_FILE_TOO_LARGE', `patched content is larger than the ${MAX_FILE_BYTES}-byte limit.`);

    operationAudit.requireRecord('repo.patch_file.intent', relative, {
      bytes,
      replacedBytes: Buffer.byteLength(oldText, 'utf8'),
      replacementBytes: Buffer.byteLength(newText, 'utf8')
    });
    const temp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, patched, { encoding: 'utf8', mode: stat.mode });
    fs.renameSync(temp, resolved);
    return { path: relative, bytes, replacements: 1 };
  });
}

function listDir({ path: relativePath = '.' } = {}) {
  assertActive('repo.list_dir');
  const { resolved, relative } = resolveInsideRepo(relativePath === '' ? '.' : relativePath, { allowRoot: true });
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch (error) {
    if (error && error.code === 'ENOENT') fail('REPO_FILE_NOT_FOUND', `${relative || '.'} does not exist.`);
    throw error;
  }
  if (!stat.isDirectory()) fail('REPO_FILE_PATH_INVALID', `${relative || '.'} is not a directory.`);
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
    .filter(entry => !EXCLUDED_DIR_NAMES.has(entry.name.toLowerCase()))
    .filter(entry => !isCredentialOrHistoryPath(path.posix.join(relative || '.', entry.name)))
    .slice(0, MAX_LIST_ENTRIES)
    .map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file'
    }));
  return { path: relative || '.', entries };
}

module.exports = {
  RepoFileError, ROOT, MAX_FILE_BYTES, MAX_PATH_LENGTH, EXCLUDED_DIR_NAMES,
  EXCLUDED_FILE_PATTERNS, WRITE_PROTECTED_FILES, WRITE_PROTECTED_DIR_NAMES, WRITE_GUARD_CONTROL_FILES,
  isWriteProtectedPath,
  isCredentialOrHistoryPath, resolveInsideRepo, readFile, writeFile, patchFile, listDir,
  // Internal adapter seam, never a registered tool or serialized capability.
  coordinationAuthority: byteAuthority,
  coordinationRoot: getCanonicalRoot
};

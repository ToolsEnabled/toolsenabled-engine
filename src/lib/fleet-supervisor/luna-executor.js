'use strict';

// Q66: collision-free Luna Max lane executor.
//
// This module is deliberately a boundary, not a coordinator.  It consumes a
// controller-issued, signed launch receipt, creates one detached worktree,
// runs one Luna Max process and one declared verification command, and leaves
// both the worktree and bounded evidence in place for the controller.  It
// never merges, deletes, appends to the shared audit ledger, or writes the
// shared checkout.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const audit = require('../audit.js');
const { deleteEnvMatching, deleteEnvNames } = require('../env-scrub.js');
const onboarding = require('../agent-onboarding.js');
const launchRecords = require('../controller-launch-record.js');
const { safeLaunchEnvironment } = require('../providers/subscription-launch-env.js');
const { spawnHidden } = require('../proc/hidden-spawn');
const worktree = require('./worktree.js');
const { scopePathsOverlap } = require('./worktree-lease.js');

const SCHEMA_VERSION = 1;
const LUNA_MODEL = 'gpt-5.6-luna';
const LANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ITEM_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const COMMIT_RE = /^[a-f0-9]{40,64}$/;
const LAUNCH_ID_RE = /^launch_[A-Za-z0-9_-]{16,64}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const MIN_OUTPUT_BUDGET_BYTES = 1_024;
const MAX_OUTPUT_BUDGET_BYTES = 16 * 1024 * 1024;
const MAX_TASK_BRIEF_BYTES = 128 * 1024;
const MAX_ALLOWLIST_ENTRIES = 128;
const MAX_PATH_BYTES = 240;
const MAX_VERIFICATION_ARGS = 64;
const MAX_ARG_BYTES = 8 * 1024;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30 * 1_000;
const MARKER_FILE = '.toolsenabled-fleet-lane.json';
const RESERVATION_DIRECTORY = '.luna-executor-reservations';
const RESERVATION_LOCK_DIRECTORY = '.reservation-lock';
const RESERVATION_SCHEMA_VERSION = 1;
const RESERVATION_LOCK_TIMEOUT_MS = 5_000;
const RESERVATION_LOCK_RETRY_MS = 15;
const RESERVATION_LOCK_STAGE_PREFIX = '.reservation-lock.staging-';
const WINDOWS_DEVICE_SEGMENT_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

// These are controller-owned coordination and policy surfaces.  An executor
// must refuse them even if a malformed controller proposal includes them in
// its allowlist.  Keep this list explicit: a broad "anything under src" rule
// would make a future policy move silently change the lane boundary.
const CONTROLLER_ONLY_EXACT = Object.freeze(new Set([
  'build-queue.md',
  'standing-orders.md',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'config/agent-org.json',
  'config/audit-policy.json',
  'config/launch-policy.json',
  'config/model-floor.json',
  'config/standing-orders.json',
  'config/uac-delegation-allowlist.json',
  'src/lib/audit.js',
  'src/lib/audit-store.js',
  'src/lib/controller-launch-record.js',
  'src/lib/coordinator-audit-events.js',
  'src/lib/launch-outcome.js',
  'src/lib/policy-authorizations.js',
  'tools/standing-orders-hook.js',
  'reports/owner-request-ledger.json',
  'reports/owner-request-ledger.json.bak'
]));

class LunaExecutorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LunaExecutorError';
    this.code = code;
    this.details = details;
  }
}

function refuse(code, message, details) {
  throw new LunaExecutorError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, allowed, required, label) {
  if (!plain(value)) refuse('LUNA_INPUT_INVALID', `${label} must be a plain object.`);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key))) {
    refuse('LUNA_INPUT_INVALID', `${label} contains an unsupported field.`);
  }
  if (required.some(key => !Object.hasOwn(value, key))) {
    refuse('LUNA_INPUT_INVALID', `${label} is missing a required field.`);
  }
}

function asSafeText(value, label, { maxBytes = MAX_ARG_BYTES, nonEmpty = true } = {}) {
  if (typeof value !== 'string' || (nonEmpty && !value.trim()) || value.includes('\0')) {
    refuse('LUNA_INPUT_INVALID', `${label} must be a safe string.`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    refuse('LUNA_INPUT_INVALID', `${label} exceeds its byte bound.`);
  }
  return value;
}

function assertWindowsUnambiguousSegment(segment, label) {
  // Windows silently aliases trailing dots and reserved device names.  Permit
  // neither at this authority boundary; a POSIX-looking allowlist must have
  // exactly one meaning on the host that executes it.
  if (process.platform !== 'win32') return;
  if (/[. ]$/.test(segment) || WINDOWS_DEVICE_SEGMENT_RE.test(segment)) {
    refuse('LUNA_PATH_AMBIGUOUS', `${label} contains a Windows-ambiguous path segment.`);
  }
}

function assertWindowsUnambiguousPath(value, label) {
  if (process.platform !== 'win32') return;
  for (const segment of value.split(/[\\/]+/)) {
    if (!segment || /^[A-Za-z]:$/.test(segment)) continue;
    assertWindowsUnambiguousSegment(segment, label);
  }
}

function safeAbsolutePath(value, label) {
  asSafeText(value, label, { maxBytes: 4 * 1024 });
  if (!path.isAbsolute(value)) refuse('LUNA_INPUT_INVALID', `${label} must be absolute.`);
  assertWindowsUnambiguousPath(value, label);
  return path.resolve(value);
}

function normalizePosixPath(value, label) {
  asSafeText(value, label, { maxBytes: MAX_PATH_BYTES });
  if (value.includes('\\') || value.includes(':')) {
    refuse('LUNA_INPUT_INVALID', `${label} must use one safe relative POSIX path.`);
  }
  const pieces = value.split('/');
  if (!pieces.length || pieces.some(piece => !piece || piece === '.' || piece === '..')) {
    refuse('LUNA_INPUT_INVALID', `${label} must not contain empty, dot, or traversal segments.`);
  }
  if (pieces.some(piece => !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(piece))) {
    refuse('LUNA_INPUT_INVALID', `${label} contains an unsafe path segment.`);
  }
  pieces.forEach(piece => assertWindowsUnambiguousSegment(piece, label));
  return pieces.join('/');
}

function pathKey(value) {
  const normalized = value.toLowerCase();
  return process.platform === 'win32' ? normalized : value;
}

function sameLocalPath(left, right) {
  return pathKey(path.resolve(left)) === pathKey(path.resolve(right));
}

function isControllerOnly(relative) {
  const lower = relative.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf('/') + 1);
  return CONTROLLER_ONLY_EXACT.has(lower)
    || ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(basename)
    || lower.startsWith('reports/owner-request-ledger.json.');
}

function normalizeAllowedPaths(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ALLOWLIST_ENTRIES) {
    refuse('LUNA_INPUT_INVALID', `allowedPaths must contain 1-${MAX_ALLOWLIST_ENTRIES} exact paths.`);
  }
  const result = value.map((entry, index) => normalizePosixPath(entry, `allowedPaths[${index}]`));
  const keys = result.map(pathKey);
  if (new Set(keys).size !== keys.length) refuse('LUNA_INPUT_INVALID', 'allowedPaths must not contain duplicates.');
  for (const entry of result) {
    if (isControllerOnly(entry)) {
      refuse('LUNA_CONTROLLER_SCOPE', `Controller-owned path ${entry} cannot be delegated to a Luna lane.`);
    }
  }
  return Object.freeze([...result].sort((a, b) => pathKey(a).localeCompare(pathKey(b))));
}

function normalizeLaunchReceipt(value) {
  exactKeys(value, ['launchId', 'recordHash', 'auditSequence', 'auditEventHash'],
    ['launchId', 'recordHash', 'auditSequence', 'auditEventHash'], 'launchReceipt');
  if (typeof value.launchId !== 'string' || !LAUNCH_ID_RE.test(value.launchId)) {
    refuse('LUNA_LAUNCH_INVALID', 'launchReceipt.launchId is not a valid launch id.');
  }
  if (typeof value.recordHash !== 'string' || !HASH_RE.test(value.recordHash)) {
    refuse('LUNA_LAUNCH_INVALID', 'launchReceipt.recordHash is not a SHA-256 digest.');
  }
  if (!Number.isSafeInteger(value.auditSequence) || value.auditSequence < 1) {
    refuse('LUNA_LAUNCH_INVALID', 'launchReceipt.auditSequence is invalid.');
  }
  if (typeof value.auditEventHash !== 'string' || !HASH_RE.test(value.auditEventHash)) {
    refuse('LUNA_LAUNCH_INVALID', 'launchReceipt.auditEventHash is not a SHA-256 digest.');
  }
  // This exact order is durable protocol, not presentation.  Reservation
  // replay checks use receiptMatches() fieldwise, so a JSON parser's key order
  // can never become a replay bypass.
  return Object.freeze({
    launchId: value.launchId,
    recordHash: value.recordHash,
    auditSequence: value.auditSequence,
    auditEventHash: value.auditEventHash
  });
}

function normalizeVerificationCommand(value) {
  exactKeys(value, ['command', 'args'], ['command', 'args'], 'verificationCommand');
  const command = asSafeText(value.command, 'verificationCommand.command', { maxBytes: 4 * 1024 });
  if (!Array.isArray(value.args) || value.args.length > MAX_VERIFICATION_ARGS) {
    refuse('LUNA_INPUT_INVALID', `verificationCommand.args must contain at most ${MAX_VERIFICATION_ARGS} arguments.`);
  }
  const args = value.args.map((arg, index) => asSafeText(arg, `verificationCommand.args[${index}]` , { nonEmpty: false }));
  return Object.freeze({ command, args: Object.freeze(args) });
}

function normalizeInput(input) {
  exactKeys(input,
    ['repoRoot', 'baseCommit', 'laneId', 'itemId', 'launchReceipt', 'allowedPaths',
      'verificationCommand', 'taskBrief', 'timeoutMs', 'outputBudgetBytes', 'evidenceRoot'],
    ['repoRoot', 'baseCommit', 'laneId', 'itemId', 'launchReceipt', 'allowedPaths',
      'verificationCommand', 'taskBrief', 'timeoutMs', 'outputBudgetBytes', 'evidenceRoot'],
    'luna executor input');
  const repoRoot = safeAbsolutePath(input.repoRoot, 'repoRoot');
  const baseCommit = asSafeText(input.baseCommit, 'baseCommit', { maxBytes: 64 });
  if (!COMMIT_RE.test(baseCommit)) refuse('LUNA_BASE_INVALID', 'baseCommit must be a lower-case immutable git commit digest.');
  const laneId = asSafeText(input.laneId, 'laneId', { maxBytes: 64 });
  if (!LANE_ID_RE.test(laneId)) refuse('LUNA_LANE_INVALID', 'laneId must be one safe path segment.');
  assertWindowsUnambiguousSegment(laneId, 'laneId');
  const itemId = asSafeText(input.itemId, 'itemId', { maxBytes: 64 });
  if (!ITEM_ID_RE.test(itemId)) refuse('LUNA_ITEM_INVALID', 'itemId must be a safe phase identifier.');
  assertWindowsUnambiguousSegment(itemId, 'itemId');
  const taskBrief = asSafeText(input.taskBrief, 'taskBrief', { maxBytes: MAX_TASK_BRIEF_BYTES });
  const timeoutMs = input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    refuse('LUNA_INPUT_INVALID', `timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`);
  }
  const outputBudgetBytes = input.outputBudgetBytes;
  if (!Number.isSafeInteger(outputBudgetBytes) || outputBudgetBytes < MIN_OUTPUT_BUDGET_BYTES
      || outputBudgetBytes > MAX_OUTPUT_BUDGET_BYTES) {
    refuse('LUNA_INPUT_INVALID', `outputBudgetBytes must be between ${MIN_OUTPUT_BUDGET_BYTES} and ${MAX_OUTPUT_BUDGET_BYTES}.`);
  }
  return Object.freeze({
    repoRoot,
    baseCommit,
    laneId,
    itemId,
    launchReceipt: normalizeLaunchReceipt(input.launchReceipt),
    allowedPaths: normalizeAllowedPaths(input.allowedPaths),
    verificationCommand: normalizeVerificationCommand(input.verificationCommand),
    taskBrief,
    timeoutMs,
    outputBudgetBytes,
    evidenceRoot: safeAbsolutePath(input.evidenceRoot, 'evidenceRoot')
  });
}

function executorAuthorityPayload(input) {
  return {
    repoRoot: input.repoRoot,
    baseCommit: input.baseCommit,
    laneId: input.laneId,
    itemId: input.itemId,
    allowedPaths: input.allowedPaths,
    verificationCommand: input.verificationCommand,
    taskBrief: input.taskBrief,
    timeoutMs: input.timeoutMs,
    outputBudgetBytes: input.outputBudgetBytes,
    evidenceRoot: input.evidenceRoot
  };
}

function normalizedExecutorPayloadHash(input) {
  return launchRecords.executorPayloadHash(executorAuthorityPayload(input));
}

// Public convenience for controllers and tests that hold the raw executor
// request.  The actual hash algorithm and canonical field order live in the
// controller launch-record module; this wrapper only performs executor input
// normalization before invoking that single canonical helper.
function executorPayloadHash(rawInput) {
  return normalizedExecutorPayloadHash(normalizeInput(rawInput));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeErrorCode(error, fallback = 'UNKNOWN') {
  return error && typeof error.code === 'string' ? error.code.slice(0, 120) : fallback;
}

function defaultGitRun(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    env: safeLaunchEnvironment(),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_PATCH_BYTES
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error || null
  };
}

function defaultGitExec(command, args, options) {
  return execFileSync(command, args, {
    ...options,
    env: safeLaunchEnvironment(options && options.env),
    shell: false,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_PATCH_BYTES
  });
}

function gitChecked(deps, args, cwd, code = 'LUNA_GIT_FAILED') {
  const result = deps.gitRun(args, cwd);
  if (result && result.error) refuse(code, 'git could not be started.', { cause: safeErrorCode(result.error, 'GIT_START_FAILED') });
  if (!result || result.status !== 0) {
    refuse(code, 'git command failed.', { command: args[0], stderr: String(result && result.stderr || '').slice(-500) });
  }
  return String(result.stdout || '');
}

function assertExistingEvidenceAncestors(fsImpl, target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fsImpl.existsSync(current)) break;
    let stat;
    try { stat = fsImpl.lstatSync(current); }
    catch (error) { refuse('LUNA_EVIDENCE_REPARSE', `${label} changed during evidence boundary inspection.`, { cause: safeErrorCode(error) }); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      refuse('LUNA_EVIDENCE_REPARSE', `${label} traverses a symlink, junction, reparse point, or non-directory ancestor.`);
    }
  }
}

function assertCanonicalEvidenceBoundary(fsImpl, boundary) {
  let stat;
  try { stat = fsImpl.lstatSync(boundary.requestedRoot); }
  catch (error) { refuse('LUNA_EVIDENCE_REPARSE', 'The evidence root disappeared during execution.', { cause: safeErrorCode(error) }); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    refuse('LUNA_EVIDENCE_REPARSE', 'The evidence root is a symlink, junction, reparse point, or non-directory.');
  }
  const real = realpathChecked(fsImpl, boundary.requestedRoot, 'LUNA_EVIDENCE_REPARSE');
  if (!sameLocalPath(real, boundary.canonicalRoot)) {
    refuse('LUNA_EVIDENCE_REPARSE', 'The evidence root changed its canonical realpath during execution.');
  }
  if (isWithinPath(boundary.canonicalRepoRoot, real)) {
    refuse('LUNA_EVIDENCE_SCOPE', 'The canonical evidence root resolves inside the shared repository checkout.');
  }
  return real;
}

function assertEvidenceChild(fsImpl, boundary, candidate, kind, label) {
  const requested = path.resolve(candidate);
  if (!isWithinPath(boundary.requestedRoot, requested)) {
    refuse('LUNA_EVIDENCE_REPARSE', `${label} escapes the requested evidence root.`);
  }
  assertCanonicalEvidenceBoundary(fsImpl, boundary);
  let stat;
  try { stat = fsImpl.lstatSync(requested); }
  catch (error) { refuse('LUNA_EVIDENCE_REPARSE', `${label} could not be inspected after creation.`, { cause: safeErrorCode(error) }); }
  if (stat.isSymbolicLink() || (kind === 'directory' && !stat.isDirectory()) || (kind === 'file' && !stat.isFile())) {
    refuse('LUNA_EVIDENCE_REPARSE', `${label} is a symlink, junction, reparse point, or unexpected file type.`);
  }
  const real = realpathChecked(fsImpl, requested, 'LUNA_EVIDENCE_REPARSE');
  if (!isWithinPath(boundary.canonicalRoot, real)) {
    refuse('LUNA_EVIDENCE_REPARSE', `${label} resolves outside the canonical evidence root.`);
  }
  if (isWithinPath(boundary.canonicalRepoRoot, real)) {
    refuse('LUNA_EVIDENCE_SCOPE', `${label} resolves inside the shared repository checkout.`);
  }
  return real;
}

function establishCanonicalEvidenceRoot(fsImpl, input) {
  const requestedRoot = path.resolve(input.evidenceRoot);
  const requestedRepoRoot = path.resolve(input.repoRoot);
  if (isWithinPath(requestedRepoRoot, requestedRoot)) {
    refuse('LUNA_EVIDENCE_SCOPE', 'evidenceRoot must be outside the shared repository checkout.');
  }
  // Do not let recursive mkdir traverse a pre-existing parent link.  Once
  // created, the root is lstat/realpath checked again and frozen as the only
  // acceptable evidence boundary for every subsequent child operation.
  assertExistingEvidenceAncestors(fsImpl, requestedRoot, 'evidenceRoot');
  try { fsImpl.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 }); }
  catch (error) { refuse('LUNA_EVIDENCE_REPARSE', 'The evidence root could not be created safely.', { cause: safeErrorCode(error) }); }
  const canonicalRepoRoot = realpathChecked(fsImpl, requestedRepoRoot, 'LUNA_EVIDENCE_SCOPE');
  const boundary = Object.freeze({
    requestedRoot,
    canonicalRoot: realpathChecked(fsImpl, requestedRoot, 'LUNA_EVIDENCE_REPARSE'),
    canonicalRepoRoot: path.resolve(canonicalRepoRoot)
  });
  assertCanonicalEvidenceBoundary(fsImpl, boundary);
  return boundary;
}

function verifyLaunchReceipt(receipt, { auditApi = audit, launchApi = launchRecords } = {}) {
  const normalized = normalizeLaunchReceipt(receipt);
  if (!auditApi || typeof auditApi.findEvents !== 'function') {
    refuse('LUNA_LAUNCH_UNVERIFIED', 'The canonical signed audit reader is unavailable.');
  }
  let events;
  try {
    events = auditApi.findEvents({
      action: launchApi.LAUNCH_ACTION,
      target: normalized.launchId,
      limit: 2
    });
  } catch (error) {
    refuse('LUNA_LAUNCH_UNVERIFIED', 'The canonical launch receipt could not be read.', { cause: safeErrorCode(error) });
  }
  if (!Array.isArray(events) || events.length !== 1) {
    refuse('LUNA_LAUNCH_UNVERIFIED', 'The launch receipt did not resolve to exactly one canonical event.');
  }
  const event = events[0];
  if (!Number.isSafeInteger(event.sequence) || event.sequence !== normalized.auditSequence
      || typeof event.eventHash !== 'string' || event.eventHash !== normalized.auditEventHash
      || !HASH_RE.test(event.eventHash)) {
    refuse('LUNA_LAUNCH_UNVERIFIED', 'The launch receipt does not match the canonical event anchor.');
  }
  if (typeof event.signature !== 'string' || !event.signature || typeof event.keyId !== 'string' || !event.keyId) {
    refuse('LUNA_LAUNCH_UNVERIFIED', 'The launch event is not signed by a named audit key.');
  }
  let record;
  try { record = launchApi.launchFromAuditEvent(event); }
  catch (error) { refuse('LUNA_LAUNCH_UNVERIFIED', 'The canonical launch record is malformed.', { cause: safeErrorCode(error) }); }
  if (!record || record.launchId !== normalized.launchId || record.recordHash !== normalized.recordHash) {
    refuse('LUNA_LAUNCH_UNVERIFIED', 'The launch receipt hash does not match its canonical record.');
  }
  return Object.freeze({
    launchId: normalized.launchId,
    recordHash: normalized.recordHash,
    auditSequence: normalized.auditSequence,
    auditEventHash: normalized.auditEventHash,
    targetAgentId: record.targetAgentId,
    model: record.model,
    objectiveRef: record.objectiveRef,
    executorPayloadHash: record.executorPayloadHash === undefined ? null : record.executorPayloadHash,
    verifiedBy: 'canonical-signed-audit'
  });
}

function normalizeVerifiedLaunch(value, receipt) {
  if (!plain(value) || value.launchId !== receipt.launchId || value.recordHash !== receipt.recordHash
      || value.auditSequence !== receipt.auditSequence || value.auditEventHash !== receipt.auditEventHash) {
    refuse('LUNA_LAUNCH_UNVERIFIED', 'The launch verifier returned an incomplete or mismatched receipt.');
  }
  if (value.targetAgentId !== 'luna' || value.model !== LUNA_MODEL) {
    refuse('LUNA_MODEL_REFUSED', `The signed launch is not a ${LUNA_MODEL} Luna launch.`);
  }
  if (value.executorPayloadHash !== undefined && (typeof value.executorPayloadHash !== 'string' || !HASH_RE.test(value.executorPayloadHash))) {
    refuse('LUNA_LAUNCH_UNVERIFIED', 'The signed launch has an invalid executor authority binding.');
  }
  return Object.freeze({
    launchId: receipt.launchId,
    recordHash: receipt.recordHash,
    auditSequence: receipt.auditSequence,
    auditEventHash: receipt.auditEventHash,
    targetAgentId: value.targetAgentId,
    model: value.model,
    objectiveRef: typeof value.objectiveRef === 'string' ? value.objectiveRef : null,
    executorPayloadHash: value.executorPayloadHash === undefined ? null : value.executorPayloadHash,
    verifiedBy: typeof value.verifiedBy === 'string' ? value.verifiedBy : 'injected-launch-verifier'
  });
}

function verifyRepository(deps, input) {
  const top = gitChecked(deps, ['rev-parse', '--show-toplevel'], input.repoRoot, 'LUNA_REPO_INVALID').trim();
  if (!top || !sameLocalPath(top, input.repoRoot)) {
    refuse('LUNA_REPO_INVALID', 'repoRoot is not the canonical top-level checkout.');
  }
  const resolved = gitChecked(deps, ['rev-parse', '--verify', `${input.baseCommit}^{commit}`], input.repoRoot,
    'LUNA_BASE_INVALID').trim().toLowerCase();
  if (resolved !== input.baseCommit) {
    refuse('LUNA_BASE_INVALID', 'baseCommit did not resolve to the requested immutable commit.');
  }
  return Object.freeze({ repoRoot: path.resolve(input.repoRoot), baseCommit: resolved });
}

function worktreeRegistrationPaths(deps, repoRoot) {
  const listing = gitChecked(deps, ['worktree', 'list', '--porcelain'], repoRoot, 'LUNA_WORKTREE_CHECK_FAILED');
  return listing.split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => path.resolve(line.slice('worktree '.length).trim()))
    .filter(Boolean);
}

function assertLaneAvailable(deps, input) {
  const target = path.resolve(deps.worktreePathFor(input.laneId, input.repoRoot));
  if (deps.fs.existsSync(target)) refuse('LUNA_LANE_COLLISION', 'The lane worktree target already exists.', { target });
  const registered = worktreeRegistrationPaths(deps, input.repoRoot);
  if (registered.some(entry => pathKey(entry) === pathKey(target))) {
    refuse('LUNA_LANE_COLLISION', 'The lane worktree target is already registered with git.', { target });
  }
  return target;
}

function rootFingerprint(deps, repoRoot) {
  const head = gitChecked(deps, ['rev-parse', 'HEAD'], repoRoot, 'LUNA_REPO_CHECK_FAILED').trim();
  const status = gitChecked(deps, ['status', '--porcelain=v1', '--untracked-files=all'], repoRoot,
    'LUNA_REPO_CHECK_FAILED');
  const names = gitChecked(deps, ['diff', '--name-status', '--no-renames', 'HEAD', '--'], repoRoot,
    'LUNA_REPO_CHECK_FAILED');
  return Object.freeze({ digest: sha256(`${head}\n${status}\n${names}`), head, status, names });
}

function parseNul(value) {
  return String(value || '').split('\0').filter(Boolean);
}

function changedPaths(deps, worktreePath, baseCommit) {
  const tracked = parseNul(gitChecked(deps, ['diff', '--name-only', '-z', '--no-renames', baseCommit, '--'], worktreePath,
    'LUNA_DIFF_FAILED'));
  const staged = parseNul(gitChecked(deps, ['diff', '--cached', '--name-only', '-z', '--no-renames', baseCommit, '--'], worktreePath,
    'LUNA_DIFF_FAILED'));
  const untracked = parseNul(gitChecked(deps, ['ls-files', '--others', '--exclude-standard', '-z'], worktreePath,
    'LUNA_DIFF_FAILED'));
  const ignored = parseNul(gitChecked(deps, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], worktreePath,
    'LUNA_DIFF_FAILED'));
  const filter = value => value.map(item => item.replace(/\\/g, '/')).filter(item => item && item !== MARKER_FILE);
  const unique = values => [...new Map(values.map(value => [pathKey(value), value])).values()].sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
  return Object.freeze({
    changed: Object.freeze(unique([...filter(tracked), ...filter(staged), ...filter(untracked)])),
    ignored: Object.freeze(unique(filter(ignored)))
  });
}

function markerMatches(fsImpl, lanePath, expected) {
  try {
    const actual = JSON.parse(fsImpl.readFileSync(path.join(lanePath, MARKER_FILE), 'utf8'));
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch (error) {
    // Absence establishes that the required marker does not match.  Other
    // failures establish no marker state at all and must not be reported as a
    // definite mutation.
    if (error && error.code === 'ENOENT') return false;
    refuse('LUNA_MARKER_UNESTABLISHED', 'The worktree ownership marker could not be established.', {
      cause: safeErrorCode(error, 'MARKER_READ_FAILED')
    });
  }
}

function hashChangedFiles(fsImpl, lanePath, paths) {
  const hashes = {};
  for (const relative of paths) {
    const absolute = path.resolve(lanePath, ...relative.split('/'));
    const relativeCheck = path.relative(path.resolve(lanePath), absolute);
    if (relativeCheck.startsWith(`..${path.sep}`) || relativeCheck === '..' || path.isAbsolute(relativeCheck)) {
      refuse('LUNA_SCOPE_VIOLATION', `Changed path escaped the lane worktree: ${relative}.`);
    }
    let stat;
    try {
      stat = fsImpl.lstatSync(absolute);
    } catch (error) {
      // A null hash means the changed path was measured as absent (a
      // deletion), not merely that lstat could not measure it.  Collapsing
      // permission or I/O failures into null would publish a definite file
      // state in the manifest without having established that state.
      if (error && error.code === 'ENOENT') {
        hashes[relative] = null;
        continue;
      }
      refuse('LUNA_DIFF_FAILED', `Changed path could not be inspected for hashing: ${relative}.`, {
        cause: safeErrorCode(error, 'LSTAT_FAILED')
      });
    }
    if (stat.isSymbolicLink()) refuse('LUNA_SCOPE_VIOLATION', `Changed path is a symbolic link: ${relative}.`);
    if (!stat.isFile()) refuse('LUNA_SCOPE_VIOLATION', `Changed path is not a regular file: ${relative}.`);
    hashes[relative] = sha256(fsImpl.readFileSync(absolute));
  }
  return Object.freeze(hashes);
}

function isWithinPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realpathChecked(fsImpl, candidate, code) {
  try {
    return fsImpl.realpathSync.native ? fsImpl.realpathSync.native(candidate) : fsImpl.realpathSync(candidate);
  } catch (error) {
    refuse(code, 'A required lane path could not be resolved safely.', { cause: safeErrorCode(error, 'REALPATH_FAILED') });
  }
}

// A lexical allowlist is insufficient on Windows: a junction can make
// `src/allowed.js` spell a path outside the detached worktree.  Inspect every
// existing component before the runner and again afterwards, rejecting either
// a link/reparse point or a realpath that escapes the lane root.
function assertAllowedPathAncestors(fsImpl, lanePath, allowedPaths) {
  const root = path.resolve(lanePath);
  let rootStat;
  try { rootStat = fsImpl.lstatSync(root); }
  catch (error) { refuse('LUNA_PATH_REPARSE_ESCAPE', 'The lane root is unavailable for path preflight.', { cause: safeErrorCode(error) }); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    refuse('LUNA_PATH_REPARSE_ESCAPE', 'The lane root is not a real directory.');
  }
  const rootReal = realpathChecked(fsImpl, root, 'LUNA_PATH_REPARSE_ESCAPE');
  for (const allowed of allowedPaths) {
    const segments = allowed.split('/');
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      if (!fsImpl.existsSync(current)) break;
      let stat;
      try { stat = fsImpl.lstatSync(current); }
      catch (error) { refuse('LUNA_PATH_REPARSE_ESCAPE', 'An allowlisted path changed during preflight.', { cause: safeErrorCode(error) }); }
      if (stat.isSymbolicLink()) {
        refuse('LUNA_PATH_REPARSE_ESCAPE', `Allowlisted path traverses a symbolic link or junction: ${allowed}.`);
      }
      const real = realpathChecked(fsImpl, current, 'LUNA_PATH_REPARSE_ESCAPE');
      if (!isWithinPath(rootReal, real)) {
        refuse('LUNA_PATH_REPARSE_ESCAPE', `Allowlisted path resolves outside the detached worktree: ${allowed}.`);
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        refuse('LUNA_PATH_REPARSE_ESCAPE', `Allowlisted path has a non-directory ancestor: ${allowed}.`);
      }
    }
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function receiptMatches(value, receipt) {
  return plain(value) && plain(receipt)
    && value.launchId === receipt.launchId
    && value.recordHash === receipt.recordHash
    && value.auditSequence === receipt.auditSequence
    && value.auditEventHash === receipt.auditEventHash;
}

function verificationCommandMatches(left, right) {
  return plain(left) && plain(right)
    && left.command === right.command
    && Array.isArray(left.args) && Array.isArray(right.args)
    && left.args.length === right.args.length
    && left.args.every((arg, index) => arg === right.args[index]);
}

function reservationPayload(input, authorityHash) {
  return Object.freeze({
    launchReceipt: input.launchReceipt,
    executorPayloadHash: authorityHash,
    laneId: input.laneId,
    itemId: input.itemId,
    baseCommit: input.baseCommit,
    allowedPaths: input.allowedPaths,
    verificationCommand: input.verificationCommand
  });
}

function reservationPayloadMatches(left, right) {
  return plain(left) && plain(right)
    && receiptMatches(left.launchReceipt, right.launchReceipt)
    && left.executorPayloadHash === right.executorPayloadHash
    && left.laneId === right.laneId
    && left.itemId === right.itemId
    && left.baseCommit === right.baseCommit
    && Array.isArray(left.allowedPaths) && Array.isArray(right.allowedPaths)
    && left.allowedPaths.length === right.allowedPaths.length
    && left.allowedPaths.every((entry, index) => entry === right.allowedPaths[index])
    && verificationCommandMatches(left.verificationCommand, right.verificationCommand);
}

function reservationKey(payload) {
  return sha256(JSON.stringify(payload));
}

function reservationRoot(input) {
  return path.join(input.evidenceRoot, RESERVATION_DIRECTORY);
}

function evidenceDirectoryFor(input, launch) {
  return path.join(input.evidenceRoot, `${launch.launchId}-${input.laneId}`);
}

function activeAllowlistsIntersect(left, right) {
  return left.some(current => right.some(proposed => scopePathsOverlap(current, proposed)));
}

function waitForReservationLock(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lockOwnerPath(lockPath) {
  return path.join(lockPath, 'owner.json');
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    if (error && error.code === 'EPERM') return true;
    return null;
  }
}

function defaultProcessStartIdentity(pid) {
  if (!processIsRunning(pid)) return null;
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`
      ], {
        encoding: 'utf8',
        env: safeLaunchEnvironment(),
        shell: false,
        windowsHide: true,
        timeout: 2_000
      });
      const identity = String(result.stdout || '').trim();
      return !result.error && result.status === 0 && /^\d{10,}$/.test(identity) ? `windows:${identity}` : null;
    } catch { return null; }
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    // /proc/<pid>/stat field 22 is starttime; fields[19] after pid/comm.
    return fields[19] && /^\d+$/.test(fields[19]) ? `proc:${fields[19]}` : null;
  } catch { return null; }
}

function lockOwnerIsLive(owner, deps) {
  if (!plain(owner) || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || typeof owner.startIdentity !== 'string' || !owner.startIdentity) return true;
  const running = processIsRunning(owner.pid);
  if (running === false) return false;
  // An unexpected process-probe failure does not establish that the owner is
  // gone.  Retain the lock instead of converting an unmeasured owner into an
  // abandoned one that this process may delete.
  if (running !== true) return true;
  const actual = deps.processStartIdentity(owner.pid);
  // If the identity adapter is unavailable we cannot distinguish a reused PID
  // from the original owner.  Hold the lock rather than deleting another
  // process's live reservation.
  if (typeof actual !== 'string' || !actual) return true;
  return actual === owner.startIdentity;
}

function clearAbandonedReservationLock(deps, lockPath) {
  let owner;
  try { owner = JSON.parse(deps.fs.readFileSync(lockOwnerPath(lockPath), 'utf8')); } catch { return false; }
  if (lockOwnerIsLive(owner, deps)) return false;
  try {
    deps.fs.rmSync(lockPath, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function syncDirectory(fsImpl, directory) {
  // Windows does not permit opening a directory for fsync through Node.  The
  // owner file itself is flushed before the atomic directory rename there;
  // on Unix also flush the containing directory metadata.
  if (process.platform === 'win32') return;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(directory, 'r');
    fsImpl.fsyncSync(descriptor);
  } catch { /* an unsupported directory fsync must not erase the file flush */
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function writePreparedLockOwner(fsImpl, boundary, stagePath, owner) {
  const ownerPath = lockOwnerPath(stagePath);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(ownerPath, 'wx', 0o600);
    assertEvidenceChild(fsImpl, boundary, ownerPath, 'file', 'prepared reservation lock owner file');
    fsImpl.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, { encoding: 'utf8' });
    fsImpl.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
  syncDirectory(fsImpl, stagePath);
}

async function withReservationLock(deps, boundary, root, operation) {
  const fsImpl = deps.fs;
  const lockPath = path.join(root, RESERVATION_LOCK_DIRECTORY);
  const deadline = Date.now() + RESERVATION_LOCK_TIMEOUT_MS;
  let owner = null;
  let ownsLock = false;
  while (true) {
    const stagePath = path.join(root, `${RESERVATION_LOCK_STAGE_PREFIX}${process.pid}-${crypto.randomBytes(12).toString('hex')}`);
    try {
      fsImpl.mkdirSync(stagePath, { recursive: false, mode: 0o700 });
      assertEvidenceChild(fsImpl, boundary, stagePath, 'directory', 'prepared reservation lock staging directory');
      const startIdentity = deps.processStartIdentity(process.pid);
      if (typeof startIdentity !== 'string' || !startIdentity) {
        refuse('LUNA_RESERVATION_FAILED', 'The lock owner process identity could not be established safely.');
      }
      owner = { pid: process.pid, startIdentity, createdAt: new Date().toISOString() };
      writePreparedLockOwner(fsImpl, boundary, stagePath, owner);
      // This is the only publication step.  A crash beforehand leaves a
      // uniquely named staging directory, which readers deliberately ignore.
      fsImpl.renameSync(stagePath, lockPath);
      assertEvidenceChild(fsImpl, boundary, lockPath, 'directory', 'published reservation lock directory');
      syncDirectory(fsImpl, root);
      ownsLock = true;
      break;
    } catch (error) {
      try { if (fsImpl.existsSync(stagePath)) fsImpl.rmSync(stagePath, { recursive: true, force: true }); } catch { /* own staging only */ }
      if (error instanceof LunaExecutorError) throw error;
      // MoveFileEx reports an existing destination as EPERM on some Windows
      // builds; only accept that spelling when the published lock is actually
      // present, otherwise retain the fail-closed error path.
      const publishedLockExists = fsImpl.existsSync(lockPath);
      const publicationConflict = error && (error.code === 'EEXIST'
        || (publishedLockExists && ['EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)));
      if (!publicationConflict) {
        refuse('LUNA_RESERVATION_FAILED', 'The controller reservation lock could not be created.', { cause: safeErrorCode(error) });
      }
      assertEvidenceChild(fsImpl, boundary, lockPath, 'directory', 'pre-existing published reservation lock directory');
      if (clearAbandonedReservationLock(deps, lockPath)) continue;
      if (Date.now() >= deadline) {
        refuse('LUNA_RESERVATION_BUSY', 'The controller reservation lock remained busy; refusing an unsafe concurrent launch.');
      }
      await waitForReservationLock(RESERVATION_LOCK_RETRY_MS);
    }
  }
  try {
    return await operation();
  } finally {
    if (ownsLock) {
      try {
        const current = JSON.parse(fsImpl.readFileSync(lockOwnerPath(lockPath), 'utf8'));
        if (sameJson(current, owner)) fsImpl.rmSync(lockPath, { recursive: true, force: true });
      } catch { /* a later caller must fail closed */ }
    }
  }
}

function canonicalTimestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) {
    refuse('LUNA_RESERVATION_CORRUPT', `${label} is not a canonical timestamp.`);
  }
  return value;
}

function normalizeReservationPayload(value) {
  exactKeys(value,
    ['launchReceipt', 'executorPayloadHash', 'laneId', 'itemId', 'baseCommit', 'allowedPaths', 'verificationCommand'],
    ['launchReceipt', 'executorPayloadHash', 'laneId', 'itemId', 'baseCommit', 'allowedPaths', 'verificationCommand'],
    'reservation payload');
  let receipt;
  let allowedPaths;
  let verificationCommand;
  try {
    receipt = normalizeLaunchReceipt(value.launchReceipt);
    allowedPaths = normalizeAllowedPaths(value.allowedPaths);
    verificationCommand = normalizeVerificationCommand(value.verificationCommand);
  } catch {
    refuse('LUNA_RESERVATION_CORRUPT', 'A controller reservation payload has malformed nested authority.');
  }
  const laneId = asSafeText(value.laneId, 'reservation laneId', { maxBytes: 64 });
  const itemId = asSafeText(value.itemId, 'reservation itemId', { maxBytes: 64 });
  const baseCommit = asSafeText(value.baseCommit, 'reservation baseCommit', { maxBytes: 64 });
  if (!LANE_ID_RE.test(laneId) || !ITEM_ID_RE.test(itemId) || !COMMIT_RE.test(baseCommit)
      || typeof value.executorPayloadHash !== 'string' || !HASH_RE.test(value.executorPayloadHash)
      || !sameJson(value.allowedPaths, allowedPaths)
      || !sameJson(value.verificationCommand, verificationCommand)) {
    refuse('LUNA_RESERVATION_CORRUPT', 'A controller reservation payload is not canonical.');
  }
  assertWindowsUnambiguousSegment(laneId, 'reservation laneId');
  assertWindowsUnambiguousSegment(itemId, 'reservation itemId');
  return Object.freeze({
    launchReceipt: receipt,
    executorPayloadHash: value.executorPayloadHash,
    laneId,
    itemId,
    baseCommit,
    allowedPaths,
    verificationCommand
  });
}

function normalizeReservationRecord(value) {
  exactKeys(value,
    ['schemaVersion', 'kind', 'state', 'consumedAt', 'evidenceDir', 'payload', 'terminalizedAt', 'reconciledAt'],
    ['schemaVersion', 'kind', 'state', 'consumedAt', 'evidenceDir', 'payload'],
    'reservation record');
  if (value.schemaVersion !== RESERVATION_SCHEMA_VERSION || value.kind !== 'luna-controller-reservation'
      || !['active', 'terminal'].includes(value.state)) {
    refuse('LUNA_RESERVATION_CORRUPT', 'A controller reservation record has an invalid outer shape.');
  }
  const consumedAt = canonicalTimestamp(value.consumedAt, 'reservation consumedAt');
  if (typeof value.evidenceDir !== 'string' || !path.isAbsolute(value.evidenceDir)
      || path.resolve(value.evidenceDir) !== value.evidenceDir) {
    refuse('LUNA_RESERVATION_CORRUPT', 'A controller reservation evidence path is invalid.');
  }
  assertWindowsUnambiguousPath(value.evidenceDir, 'reservation evidenceDir');
  if (value.state === 'active' && (value.terminalizedAt !== undefined || value.reconciledAt !== undefined)) {
    refuse('LUNA_RESERVATION_CORRUPT', 'An active reservation carries terminal metadata.');
  }
  if (value.state === 'terminal' && value.terminalizedAt === undefined && value.reconciledAt === undefined) {
    refuse('LUNA_RESERVATION_CORRUPT', 'A terminal reservation is missing terminal metadata.');
  }
  const terminalizedAt = value.terminalizedAt === undefined ? undefined : canonicalTimestamp(value.terminalizedAt, 'reservation terminalizedAt');
  const reconciledAt = value.reconciledAt === undefined ? undefined : canonicalTimestamp(value.reconciledAt, 'reservation reconciledAt');
  const payload = normalizeReservationPayload(value.payload);
  return Object.freeze({
    schemaVersion: RESERVATION_SCHEMA_VERSION,
    kind: 'luna-controller-reservation',
    state: value.state,
    consumedAt,
    evidenceDir: value.evidenceDir,
    payload,
    ...(terminalizedAt === undefined ? {} : { terminalizedAt }),
    ...(reconciledAt === undefined ? {} : { reconciledAt })
  });
}

function readReservationRecords(fsImpl, root) {
  let names;
  try { names = fsImpl.readdirSync(root, { encoding: 'utf8' }); }
  catch (error) { refuse('LUNA_RESERVATION_FAILED', 'The controller reservation registry could not be read.', { cause: safeErrorCode(error) }); }
  const records = [];
  for (const name of names) {
    if (name === RESERVATION_LOCK_DIRECTORY || name.startsWith(RESERVATION_LOCK_STAGE_PREFIX)) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name)) {
      refuse('LUNA_RESERVATION_CORRUPT', 'The controller reservation registry contains an unexpected entry.', { name });
    }
    const recordPath = path.join(root, name);
    let record;
    try {
      const stat = fsImpl.lstatSync(recordPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('RESERVATION_RECORD_NOT_REGULAR');
      record = normalizeReservationRecord(JSON.parse(fsImpl.readFileSync(recordPath, 'utf8')));
    }
    catch (error) { refuse('LUNA_RESERVATION_CORRUPT', `A controller reservation record is unreadable; refusing unsafe dispatch (${safeErrorCode(error)}).`, { recordPath, cause: safeErrorCode(error) }); }
    records.push({ recordPath, record });
  }
  return records;
}

function replaceReservationRecord(fsImpl, boundary, recordPath, record) {
  const temporary = `${recordPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, 'wx', 0o600);
    assertEvidenceChild(fsImpl, boundary, temporary, 'file', 'temporary reservation record');
    fsImpl.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    if (fsImpl.existsSync(recordPath)) {
      assertEvidenceChild(fsImpl, boundary, recordPath, 'file', 'existing reservation record');
    }
    fsImpl.renameSync(temporary, recordPath);
    assertEvidenceChild(fsImpl, boundary, recordPath, 'file', 'published reservation record');
    syncDirectory(fsImpl, path.dirname(recordPath));
  } catch (error) {
    try { if (descriptor !== undefined) fsImpl.closeSync(descriptor); } catch { /* best effort */ }
    try { fsImpl.rmSync(temporary, { force: true }); } catch { /* fail closed below */ }
    if (error instanceof LunaExecutorError) throw error;
    refuse('LUNA_RESERVATION_FAILED', 'The controller reservation record could not be updated atomically.', { cause: safeErrorCode(error) });
  }
}

function createReservationRecord(fsImpl, boundary, recordPath, record) {
  let descriptor;
  try {
    descriptor = fsImpl.openSync(recordPath, 'wx', 0o600);
    assertEvidenceChild(fsImpl, boundary, recordPath, 'file', 'new reservation record');
    fsImpl.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
    fsImpl.fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof LunaExecutorError) throw error;
    refuse(error && error.code === 'EEXIST' ? 'LUNA_RECEIPT_REUSED' : 'LUNA_RESERVATION_FAILED',
      'The controller reservation could not be recorded atomically.', { cause: safeErrorCode(error) });
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch { /* a partial record remains fail-closed */ }
    }
  }
}

function requiredEvidencePaths(evidenceDir) {
  return {
    stdout: path.join(evidenceDir, 'luna.stdout.log'),
    stderr: path.join(evidenceDir, 'luna.stderr.log'),
    verificationStdout: path.join(evidenceDir, 'verification.stdout.log'),
    verificationStderr: path.join(evidenceDir, 'verification.stderr.log'),
    result: path.join(evidenceDir, 'result.json'),
    diff: path.join(evidenceDir, 'final.diff'),
    manifest: path.join(evidenceDir, 'manifest.json'),
    terminal: path.join(evidenceDir, 'terminal-receipt.json')
  };
}

function evidenceArtifactNames() {
  return Object.freeze([
    'luna.stdout.log', 'luna.stderr.log', 'verification.stdout.log', 'verification.stderr.log',
    'result.json', 'final.diff', 'manifest.json'
  ]);
}

function evidenceArtifactHashMap(fsImpl, paths) {
  return Object.freeze(Object.fromEntries(evidenceArtifactNames().map(name => {
    const key = name === 'luna.stdout.log' ? 'stdout'
      : name === 'luna.stderr.log' ? 'stderr'
        : name === 'verification.stdout.log' ? 'verificationStdout'
          : name === 'verification.stderr.log' ? 'verificationStderr'
            : name === 'result.json' ? 'result'
              : name === 'final.diff' ? 'diff' : 'manifest';
    assertRegularArtifact(fsImpl, paths[key]);
    return [name, sha256(fsImpl.readFileSync(paths[key]))];
  })));
}

function exactArtifactHashMap(value, expected) {
  return plain(value)
    && Object.keys(value).length === Object.keys(expected).length
    && Object.keys(expected).every(key => typeof value[key] === 'string' && HASH_RE.test(value[key]) && value[key] === expected[key]);
}

function arrayMatches(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function laneArtifactBindingMatches(value, payload) {
  return plain(value)
    && receiptMatches(value.launch, payload.launchReceipt)
    && value.executorPayloadHash === payload.executorPayloadHash
    && value.laneId === payload.laneId
    && value.itemId === payload.itemId
    && value.baseCommit === payload.baseCommit;
}

function reservationEvidenceComplete(fsImpl, record, boundary = null) {
  try {
    const normalizedRecord = normalizeReservationRecord(record);
    if (boundary) {
      assertEvidenceChild(fsImpl, boundary, normalizedRecord.evidenceDir, 'directory', 'persisted lane evidence directory');
    }
    const paths = requiredEvidencePaths(normalizedRecord.evidenceDir);
    for (const artifact of Object.values(paths)) assertRegularArtifact(fsImpl, artifact);
    const hashes = evidenceArtifactHashMap(fsImpl, paths);
    const result = JSON.parse(fsImpl.readFileSync(paths.result, 'utf8'));
    const manifest = JSON.parse(fsImpl.readFileSync(paths.manifest, 'utf8'));
    const terminal = JSON.parse(fsImpl.readFileSync(paths.terminal, 'utf8'));
    const payload = normalizedRecord.payload;
    return laneArtifactBindingMatches(result, payload)
      && laneArtifactBindingMatches(manifest, payload)
      && laneArtifactBindingMatches(terminal, payload)
      && ['eligible', 'rejected'].includes(result.outcome)
      && manifest.outcome === result.outcome
      && terminal.terminalState === result.outcome
      && arrayMatches(result.rejectionCodes, manifest.rejectionCodes)
      && arrayMatches(result.rejectionCodes, terminal.rejectionCodes)
      && sameJson(manifest.allowedPaths, payload.allowedPaths)
      && verificationCommandMatches(manifest.declaredVerification, payload.verificationCommand)
      && plain(manifest.evidence)
      && evidenceArtifactNames().every(name => Object.values(manifest.evidence).includes(name))
      && exactArtifactHashMap(terminal.artifactHashes, hashes)
      && terminal.manifest === 'manifest.json'
      && terminal.result === 'result.json';
  } catch {
    return false;
  }
}

function reconcileReservations(fsImpl, boundary, root, records) {
  return records.map(({ recordPath, record }) => {
    if (record.state !== 'active' || !reservationEvidenceComplete(fsImpl, record, boundary)) return { recordPath, record };
    const reconciled = { ...record, state: 'terminal', reconciledAt: new Date().toISOString() };
    replaceReservationRecord(fsImpl, boundary, recordPath, reconciled);
    return { recordPath, record: reconciled };
  });
}

async function reserveLanePayload(deps, input, verified, boundary) {
  const root = reservationRoot(input);
  try { deps.fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  catch (error) { refuse('LUNA_EVIDENCE_REPARSE', 'The reservation root could not be created safely.', { cause: safeErrorCode(error) }); }
  assertEvidenceChild(deps.fs, boundary, root, 'directory', 'reservation root');
  const payload = reservationPayload(input, verified.executorPayloadHash);
  const key = reservationKey(payload);
  const evidenceDir = evidenceDirectoryFor(input, verified);
  return withReservationLock(deps, boundary, root, async () => {
    const records = reconcileReservations(deps.fs, boundary, root, readReservationRecords(deps.fs, root));
    if (records.some(({ record }) => receiptMatches(record.payload.launchReceipt, payload.launchReceipt))) {
      refuse('LUNA_RECEIPT_REUSED', 'The signed controller launch receipt has already been consumed.');
    }
    if (records.some(({ record }) => record.state === 'active' && record.payload.laneId === payload.laneId)) {
      refuse('LUNA_LANE_RESERVED', 'The lane id is already held by an active controller reservation.');
    }
    const collision = records.find(({ record }) => record.state === 'active'
      && activeAllowlistsIntersect(record.payload.allowedPaths, payload.allowedPaths));
    if (collision) {
      refuse('LUNA_ALLOWLIST_COLLISION', 'The exact allowlist intersects an active controller reservation.', {
        conflictingLaneId: collision.record.payload.laneId,
        conflictingLaunchId: collision.record.payload.launchReceipt.launchId
      });
    }
    const recordPath = path.join(root, `${key}.json`);
    const record = {
      schemaVersion: RESERVATION_SCHEMA_VERSION,
      kind: 'luna-controller-reservation',
      state: 'active',
      consumedAt: new Date().toISOString(),
      evidenceDir,
      payload
    };
    createReservationRecord(deps.fs, boundary, recordPath, record);
    return Object.freeze({ root, recordPath, record: Object.freeze(record), evidenceDir, boundary });
  });
}

async function finalizeLaneReservation(deps, reservation) {
  return withReservationLock(deps, reservation.boundary, reservation.root, async () => {
    const records = reconcileReservations(deps.fs, reservation.boundary, reservation.root, readReservationRecords(deps.fs, reservation.root));
    const found = records.find(({ recordPath }) => recordPath === reservation.recordPath);
    if (!found || !reservationPayloadMatches(found.record.payload, reservation.record.payload)) {
      refuse('LUNA_RESERVATION_CORRUPT', 'The controller reservation changed before terminalization.');
    }
    if (found.record.state === 'terminal') return true;
    if (!reservationEvidenceComplete(deps.fs, found.record, reservation.boundary)) {
      return false;
    }
    replaceReservationRecord(deps.fs, reservation.boundary, reservation.recordPath, {
      ...found.record,
      state: 'terminal',
      terminalizedAt: new Date().toISOString()
    });
    return true;
  });
}

function createEvidenceTracker() {
  return { failures: [], written: new Set() };
}

function assertRegularArtifact(fsImpl, artifactPath) {
  const stat = fsImpl.lstatSync(artifactPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    const error = new Error('EVIDENCE_ARTIFACT_NOT_REGULAR');
    error.code = 'EVIDENCE_ARTIFACT_NOT_REGULAR';
    throw error;
  }
  return stat;
}

function writeAtomicEvidenceFile(fsImpl, boundary, target, value) {
  assertCanonicalEvidenceBoundary(fsImpl, boundary);
  assertEvidenceChild(fsImpl, boundary, path.dirname(target), 'directory', 'evidence artifact parent directory');
  if (fsImpl.existsSync(target)) {
    assertEvidenceChild(fsImpl, boundary, target, 'file', 'existing evidence artifact path');
  }
  const temporary = path.join(path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, 'wx', 0o600);
    assertEvidenceChild(fsImpl, boundary, temporary, 'file', 'temporary evidence artifact');
    fsImpl.writeFileSync(descriptor, value, { encoding: 'utf8' });
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    assertEvidenceChild(fsImpl, boundary, temporary, 'file', 'temporary evidence artifact');
    fsImpl.renameSync(temporary, target);
    assertEvidenceChild(fsImpl, boundary, target, 'file', 'published evidence artifact');
    syncDirectory(fsImpl, path.dirname(target));
  } catch (error) {
    try { if (descriptor !== undefined) fsImpl.closeSync(descriptor); } catch { /* best effort */ }
    try { fsImpl.rmSync(temporary, { force: true }); } catch { /* own temporary only */ }
    throw error;
  }
}

function writeEvidenceText(fsImpl, boundary, target, value, tracker, artifact) {
  try {
    writeAtomicEvidenceFile(fsImpl, boundary, target, String(value || ''));
    tracker.written.add(artifact);
    return true;
  } catch (error) {
    tracker.failures.push({ artifact, cause: safeErrorCode(error, 'EVIDENCE_WRITE_FAILED') });
    return false;
  }
}

function writeEvidenceJson(fsImpl, boundary, target, value, tracker, artifact) {
  try {
    writeAtomicEvidenceFile(fsImpl, boundary, target, `${JSON.stringify(value, null, 2)}\n`);
    tracker.written.add(artifact);
    return true;
  } catch (error) {
    tracker.failures.push({ artifact, cause: safeErrorCode(error, 'EVIDENCE_WRITE_FAILED') });
    return false;
  }
}

function boundedInputPrompt(input, options = {}) {
  const packetBuilder = options.buildOnboardingPacket || onboarding.buildOnboardingText;
  const packet = packetBuilder({
    projectRoot: options.worktreePath || input.repoRoot,
    scope: 'task',
    profile: 'builder',
    agentId: options.agentId,
    identityBinding: options.agentId ? 'verified-launch' : 'none',
    role: 'builder',
    provider: 'codex',
    model: options.model || LUNA_MODEL,
    tier: 'max',
    launchId: input.launchReceipt.launchId,
    directiveId: /^Q\d{1,3}$/.test(input.itemId) ? input.itemId : undefined,
    territory: input.allowedPaths,
    topic: `${input.itemId} ${input.laneId}`
  }, options.onboardingDependencies || {});
  if (typeof packet !== 'string' || !packet.trim()) refuse('LUNA_ONBOARDING_INVALID', 'The onboarding packet builder returned no context.');
  return [
    'You are the Luna Max builder in an isolated detached git worktree.',
    'Work only in the current worktree. Do not touch the parent checkout, other worktrees, network, credentials, or policy surfaces.',
    `The exact allowed file paths for this lane are: ${input.allowedPaths.join(', ')}.`,
    'Do not create or modify any other path. Do not merge, commit, push, or delete worktrees.',
    'Implement the assigned queue slice and leave the final files in the worktree for controller review.',
    '',
    packet.trimEnd(),
    '',
    input.taskBrief
  ].join('\n');
}

function scrubEnvironment(baseEnv = process.env) {
  /* The heuristic sweep and the two named removals both went through
   * `Object.keys()` + `delete` until 2026-08-11. The casing was already covered
   * here -- the `/i` regex matches every spelling, and a real child reported
   * ABSENT -- but the enumeration was not: `Object.keys()` cannot see an
   * inherited enumerable key, and `delete` is a silent no-op on one, while node
   * enumerates it into the child. Both halves now use the one primitive that
   * walks what the child actually receives. */
  const env = deleteEnvMatching({ ...baseEnv },
    key => /(?:TOKEN|SECRET|API_KEY|PASSWORD|COOKIE|PRIVATE_KEY|CREDENTIAL)/i.test(key));
  // Redundant with the sweep above (both match `API_KEY`), kept because the
  // sweep is a heuristic and these two are the names that must never survive.
  return deleteEnvNames(env, ['OPENAI_API_KEY', 'CODEX_API_KEY']);
}

function appendBounded(state, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  state.seenBytes += buffer.length;
  const remaining = Math.max(0, state.budget - state.capturedBytes);
  if (remaining > 0) {
    const accepted = buffer.subarray(0, remaining);
    state.chunks.push(accepted);
    state.capturedBytes += accepted.length;
  }
  if (state.seenBytes > state.budget) state.exceeded = true;
}

function streamState(budget) {
  return { budget, chunks: [], seenBytes: 0, capturedBytes: 0, exceeded: false };
}

function processGroupContained(pid, processImpl = process) {
  try {
    processImpl.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error && error.code === 'ESRCH') return true;
    if (error && error.code === 'EPERM') return false;
    refuse('LUNA_PROCESS_CONTAINMENT_UNESTABLISHED',
      'The process group could not be inspected; this does NOT claim that the process group is absent.',
      { cause: safeErrorCode(error, 'PROCESS_GROUP_PROBE_FAILED') });
  }
}

function captureWindowsProcessTree(rootPid) {
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'
    ], {
      encoding: 'utf8',
      env: safeLaunchEnvironment(),
      shell: false,
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024
    });
    if (result.error || result.status !== 0) return null;
    const parsed = JSON.parse(String(result.stdout || '[]'));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (!rows.every(row => plain(row) && Number.isSafeInteger(Number(row.ProcessId)) && Number.isSafeInteger(Number(row.ParentProcessId)))) return null;
    const children = new Map();
    for (const row of rows) {
      const parent = Number(row.ParentProcessId);
      const child = Number(row.ProcessId);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(child);
    }
    const captured = new Set([rootPid]);
    const queue = [rootPid];
    while (queue.length) {
      const parent = queue.shift();
      for (const child of children.get(parent) || []) {
        if (!captured.has(child)) {
          captured.add(child);
          queue.push(child);
        }
      }
    }
    return captured;
  } catch { return null; }
}

async function windowsProcessTreeContained(rootPid, captured) {
  if (!(captured instanceof Set) || captured.size === 0) return false;
  const deadline = Date.now() + 10_000;
  const known = new Set(captured);
  while (true) {
    // Re-snapshot as well as checking the pre-kill set.  taskkill's status is
    // merely a request acknowledgement; all captured/root descendants must
    // actually be absent before the executor can emit terminal evidence.
    const current = captureWindowsProcessTree(rootPid);
    if (current === null) return false;
    for (const pid of current) known.add(pid);
    // Only ESRCH establishes absence.  A probe failure must not let the lane
    // report a process tree as contained merely because every probe was
    // coerced to a falsey value.
    if ([...known].every(pid => processIsRunning(pid) === false)) return true;
    if (Date.now() >= deadline) return false;
    await waitForReservationLock(50);
  }
}

async function defaultTerminateProcessTree(child) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1) {
    return { requested: false, contained: false, error: 'NO_CHILD_PID' };
  }
  if (process.platform === 'win32') {
    const captured = captureWindowsProcessTree(child.pid);
    if (captured === null) {
      return { requested: false, contained: false, error: 'PROCESS_SNAPSHOT_FAILED' };
    }
    try {
      const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        encoding: 'utf8',
        env: safeLaunchEnvironment(),
        shell: false,
        windowsHide: true,
        timeout: 10_000
      });
      const stderr = String(result.stderr || '');
      const alreadyGone = /not found|no running instance/i.test(stderr);
      const contained = !result.error && (result.status === 0 || alreadyGone)
        ? await windowsProcessTreeContained(child.pid, captured) : false;
      return {
        requested: true,
        contained,
        error: result.error ? safeErrorCode(result.error, 'TASKKILL_FAILED') : null
      };
    } catch (error) {
      return { requested: true, contained: false, error: safeErrorCode(error, 'TASKKILL_FAILED') };
    }
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (!error || error.code !== 'ESRCH') {
      return { requested: true, contained: false, error: safeErrorCode(error, 'PROCESS_GROUP_KILL_FAILED') };
    }
  }
  await waitForReservationLock(100);
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (!error || error.code !== 'ESRCH') return { requested: true, contained: false, error: safeErrorCode(error, 'PROCESS_GROUP_KILL_FAILED') }; }
  await waitForReservationLock(50);
  return { requested: true, contained: processGroupContained(child.pid), error: null };
}

function runBoundedCommand({
  command,
  args,
  cwd,
  input = '',
  timeoutMs,
  outputBudgetBytes,
  env,
  spawnImpl = spawn,
  terminateTree = defaultTerminateProcessTree
}) {
  return new Promise(resolve => {
    const stdout = streamState(outputBudgetBytes);
    const stderr = streamState(outputBudgetBytes);
    const startedAt = Date.now();
    let child;
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let closed = false;
    let exitCode = null;
    let termination = null;
    let terminationResult = null;
    const outputExceeded = () => stdout.exceeded || stderr.exceeded || stdout.seenBytes + stderr.seenBytes > outputBudgetBytes;
    const finish = () => {
      if (settled || !closed || (termination && !terminationResult)) return;
      settled = true;
      clearTimeout(timer);
      const descendantsContained = termination ? Boolean(terminationResult && terminationResult.contained) : true;
      resolve({
        ok: !timedOut && !spawnError && !outputExceeded() && descendantsContained && exitCode === 0,
        exitCode,
        timedOut,
        outputBudgetExceeded: outputExceeded(),
        descendantsContained,
        terminationRequested: Boolean(termination),
        terminationError: terminationResult && terminationResult.error ? terminationResult.error : null,
        spawnError: spawnError ? safeErrorCode(spawnError, 'SPAWN_FAILED') : null,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        stdoutBytes: stdout.seenBytes,
        stderrBytes: stderr.seenBytes,
        durationMs: Date.now() - startedAt
      });
    };
    const stop = () => {
      if (termination || !child) return;
      termination = Promise.resolve()
        .then(() => terminateTree(child))
        .then(result => { terminationResult = result || { requested: true, contained: false, error: 'TREE_TERMINATION_UNREPORTED' }; })
        .catch(error => { terminationResult = { requested: true, contained: false, error: safeErrorCode(error, 'TREE_TERMINATION_FAILED') }; })
        .finally(finish);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      child = spawnImpl(command, args, {
        cwd,
        env: safeLaunchEnvironment(env),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      spawnError = error;
      closed = true;
      finish();
      return;
    }
    if (child.stdout) child.stdout.on('data', chunk => {
      appendBounded(stdout, chunk);
      if (outputExceeded()) stop();
    });
    if (child.stderr) child.stderr.on('data', chunk => {
      appendBounded(stderr, chunk);
      if (outputExceeded()) stop();
    });
    child.once('error', error => { spawnError = error; });
    child.once('close', code => {
      closed = true;
      exitCode = code;
      finish();
    });
    try {
      if (child.stdin) child.stdin.end(input);
    } catch (error) {
      spawnError = error;
      stop();
    }
  });
}

async function runLunaProcess({ input, worktreePath, evidenceDir, timeoutMs, outputBudgetBytes, verifiedLaunch, deps }) {
  const command = deps.resolveLunaCommand();
  const sessionAgentId = verifiedLaunch && verifiedLaunch.targetAgentId;
  const sessionModel = verifiedLaunch && verifiedLaunch.model || LUNA_MODEL;
  const prompt = boundedInputPrompt(input, {
    worktreePath,
    agentId: sessionAgentId,
    model: sessionModel,
    buildOnboardingPacket: deps.buildOnboardingPacket,
    onboardingDependencies: deps.onboardingDependencies
  });
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    // The Windows workspace-write backend is usable on this host only through
    // its elevated helper. --ignore-user-config deliberately removes the
    // owner's ambient setting, so restore this one sandbox implementation
    // choice explicitly while keeping all user plugins and MCPs excluded.
    '-c', 'windows.sandbox="elevated"',
    // A builder lane must not boot ToolsEnabled's project MCP servers inside
    // its detached worktree. Those servers own runtime state/log/vault paths;
    // starting them relative to the lane creates ignored work products and
    // makes an otherwise exact one-file diff ineligible. User MCPs are removed
    // by --ignore-user-config. Because that flag also removes inherited
    // transport definitions before CLI override validation in this Codex
    // build, each disabled project entry gets an inert command as a complete
    // never-started transport. These overrides cover every MCP declared by
    // this repository's trusted .codex/config.toml layer.
    '-c', 'mcp_servers.playwright.command="disabled"',
    '-c', 'mcp_servers.playwright.enabled=false',
    '-c', 'mcp_servers.toolsenabled-readonly.command="disabled"',
    '-c', 'mcp_servers.toolsenabled-readonly.enabled=false',
    '-c', 'mcp_servers.toolsenabled.command="disabled"',
    '-c', 'mcp_servers.toolsenabled.enabled=false',
    '--sandbox', 'workspace-write', '--cd', worktreePath,
    '--model', LUNA_MODEL, '-c', 'model_reasoning_effort=max', '-'
  ];
  const result = await runBoundedCommand({
    command,
    args,
    cwd: worktreePath,
    input: prompt,
    timeoutMs,
    outputBudgetBytes,
    env: {
      ...scrubEnvironment(),
      ...(sessionAgentId ? { TOOLSENABLED_AGENT_ID: sessionAgentId } : {}),
      TOOLSENABLED_AGENT_ROLE: 'builder',
      TOOLSENABLED_AGENT_MODEL: sessionModel,
      TOOLSENABLED_AGENT_TIER: 'max',
      TOOLSENABLED_PROJECT_ROOT: worktreePath,
      TOOLSENABLED_LAUNCH_ID: input.launchReceipt.launchId,
      TOOLSENABLED_ONBOARDING_PACKET_VERSION: onboarding.PACKET_VERSION,
      TOOLSENABLED_ONBOARDING_PACKET_HASH: sha256(prompt),
      TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE: verifiedLaunch ? 'verified-launch' : 'unverified-direct-runner',
      ...(verifiedLaunch ? {
        TOOLSENABLED_ONBOARDING_ALREADY_INJECTED: '1',
        TOOLSENABLED_LAUNCH_RECORD_HASH: verifiedLaunch.recordHash,
        TOOLSENABLED_LAUNCH_AUDIT_SEQUENCE: String(verifiedLaunch.auditSequence),
        TOOLSENABLED_LAUNCH_AUDIT_EVENT_HASH: verifiedLaunch.auditEventHash
      } : {})
    },
    // THE NO-PROVIDER SWITCH, HONOURED HERE TOO (R38). This is the one
    // real-effect line in the whole builder lane: it starts the actual codex
    // binary. `deps.spawnImpl` is shared with runVerification() below, whose
    // command is the lane's OWN test/build check, never a provider -- so this
    // cannot switch that default to spawnHidden without gating an unrelated
    // command. Instead: when the caller left spawnImpl at its unmodified
    // production default (the raw `spawn` imported above), route through the
    // shared provider gate; a test-injected fake (identity-different) is used
    // exactly as before. See src/lib/proc/hidden-spawn.js for the gate itself.
    spawnImpl: deps.spawnImpl === spawn ? spawnHidden : deps.spawnImpl,
    terminateTree: deps.terminateTree
  });
  const resultMetadata = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'luna-process-result',
    model: LUNA_MODEL,
    command,
    args,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputBudgetExceeded: result.outputBudgetExceeded,
    spawnError: result.spawnError,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    durationMs: result.durationMs,
    evidenceDir
  };
  return { ...result, resultMetadata };
}

async function runVerification({ input, worktreePath, timeoutMs, outputBudgetBytes, deps }) {
  const command = input.verificationCommand.command;
  const args = input.verificationCommand.args;
  const result = await runBoundedCommand({
    command,
    args,
    cwd: worktreePath,
    input: '',
    timeoutMs,
    outputBudgetBytes,
    env: scrubEnvironment(),
    spawnImpl: deps.spawnImpl,
    terminateTree: deps.terminateTree
  });
  return {
    ...result,
    command,
    args,
    declared: { command, args }
  };
}

function stageAndCapturePatch(deps, lanePath, baseCommit, fsImpl = fs) {
  try {
    deps.gitExec('git', ['add', '-A', '--', '.', `:(exclude)${MARKER_FILE}`], {
      cwd: lanePath,
      encoding: 'utf8'
    });
  } catch (error) {
    refuse('LUNA_DIFF_FAILED', 'The final worktree diff could not be staged.', { cause: safeErrorCode(error) });
  }
  const patch = String(deps.gitExec('git', [
    'diff', '--cached', '--binary', '--no-ext-diff', '--no-renames', baseCommit, '--'
  ], { cwd: lanePath, encoding: 'utf8' }));
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    refuse('LUNA_DIFF_TOO_LARGE', 'The portable patch exceeds the evidence bound.');
  }
  const paths = parseNul(gitChecked(deps, [
    'diff', '--cached', '--name-only', '-z', '--no-renames', baseCommit, '--'
  ], lanePath, 'LUNA_DIFF_FAILED')).map(value => value.replace(/\\/g, '/'))
    .filter(value => value && value !== MARKER_FILE);
  const unique = [...new Map(paths.map(value => [pathKey(value), value])).values()]
    .sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
  return Object.freeze({ patch, changedPaths: Object.freeze(unique) });
}

function resolveEvidenceDir(fsImpl, boundary, input, launch) {
  assertCanonicalEvidenceBoundary(fsImpl, boundary);
  const evidenceDir = evidenceDirectoryFor(input, launch);
  if (fsImpl.existsSync(evidenceDir)) {
    assertEvidenceChild(fsImpl, boundary, evidenceDir, 'directory', 'pre-existing lane evidence directory');
    refuse('LUNA_EVIDENCE_COLLISION', 'The lane evidence directory already exists.', { evidenceDir });
  }
  try { fsImpl.mkdirSync(evidenceDir, { recursive: false, mode: 0o700 }); }
  catch (error) { refuse('LUNA_EVIDENCE_REPARSE', 'The lane evidence directory could not be created safely.', { cause: safeErrorCode(error) }); }
  assertEvidenceChild(fsImpl, boundary, evidenceDir, 'directory', 'lane evidence directory');
  return evidenceDir;
}

function failureCodesFor({ runner, initial, final, verification, markerOk, rootUnchanged }) {
  const codes = [];
  if (runner && !runner.ok) {
    if (runner.timedOut) codes.push('TIMEOUT');
    else if (runner.outputBudgetExceeded) codes.push('OUTPUT_BUDGET_EXCEEDED');
    else codes.push('RUNNER_ERROR');
  }
  if (runner && runner.descendantsContained === false) codes.push('PROCESS_TREE_UNCONTAINED');
  if (initial && initial.ignored.length) codes.push('IGNORED_WORK_PRODUCT');
  if (initial && initial.changed.length === 0) codes.push('NO_DIFF');
  if (initial && initial.changed.some(isControllerOnly)) codes.push('CONTROLLER_SCOPE_VIOLATION');
  if (initial && initial.changed.some(path => !initial.allowed.has(pathKey(path)))) codes.push('SCOPE_VIOLATION');
  if (final && final.ignored.length) codes.push('IGNORED_WORK_PRODUCT');
  if (final && final.changed.some(isControllerOnly)) codes.push('CONTROLLER_SCOPE_VIOLATION');
  if (final && final.changed.some(path => !final.allowed.has(pathKey(path)))) codes.push('SCOPE_VIOLATION');
  if (verification && !verification.ok) {
    if (verification.timedOut) codes.push('VERIFICATION_TIMEOUT');
    else if (verification.outputBudgetExceeded) codes.push('OUTPUT_BUDGET_EXCEEDED');
    else codes.push('VERIFICATION_FAILED');
  }
  if (verification && verification.descendantsContained === false) codes.push('PROCESS_TREE_UNCONTAINED');
  if (markerOk === false) codes.push('WORKTREE_MARKER_MUTATED');
  if (rootUnchanged === false) codes.push('SHARED_CHECKOUT_MUTATION');
  return [...new Set(codes)];
}

function compactProcessResult(value) {
  if (!value) return null;
  return {
    ok: Boolean(value.ok),
    exitCode: value.exitCode,
    timedOut: Boolean(value.timedOut),
    outputBudgetExceeded: Boolean(value.outputBudgetExceeded),
    descendantsContained: typeof value.descendantsContained === 'boolean' ? value.descendantsContained : null,
    terminationRequested: Boolean(value.terminationRequested),
    terminationError: value.terminationError || null,
    spawnError: value.spawnError || null,
    stdoutBytes: Number.isSafeInteger(value.stdoutBytes) ? value.stdoutBytes : 0,
    stderrBytes: Number.isSafeInteger(value.stderrBytes) ? value.stderrBytes : 0,
    durationMs: Number.isSafeInteger(value.durationMs) ? value.durationMs : null,
    declared: value.declared || undefined
  };
}

function createDependencies(overrides = {}) {
  return {
    fs: overrides.fs || fs,
    now: overrides.now || Date.now,
    gitRun: overrides.gitRun || defaultGitRun,
    gitExec: overrides.gitExec || defaultGitExec,
    spawnImpl: overrides.spawnImpl || spawn,
    terminateTree: overrides.terminateTree || defaultTerminateProcessTree,
    processStartIdentity: overrides.processStartIdentity || defaultProcessStartIdentity,
    resolveLunaCommand: overrides.resolveLunaCommand || (() => process.platform === 'win32' ? 'codex.exe' : 'codex'),
    verifyLaunch: overrides.verifyLaunch || (receipt => verifyLaunchReceipt(receipt, {
      auditApi: overrides.auditApi || audit,
      launchApi: overrides.launchApi || launchRecords
    })),
    createLaneWorktree: overrides.createLaneWorktree || worktree.createLaneWorktree,
    worktreePathFor: overrides.worktreePathFor || worktree.worktreePathFor,
    runLuna: overrides.runLuna || null,
    runVerification: overrides.runVerification || null,
    buildOnboardingPacket: overrides.buildOnboardingPacket || onboarding.buildOnboardingText,
    onboardingDependencies: overrides.onboardingDependencies || {}
  };
}

async function executeLunaLane(rawInput, overrides = {}) {
  const input = normalizeInput(rawInput);
  const deps = createDependencies(overrides);
  const verified = normalizeVerifiedLaunch(await deps.verifyLaunch(input.launchReceipt, input), input.launchReceipt);
  if (verified.targetAgentId !== 'luna' || verified.model !== LUNA_MODEL) {
    refuse('LUNA_MODEL_REFUSED', `The signed launch is not a ${LUNA_MODEL} Luna launch.`);
  }
  const expectedAuthorityHash = normalizedExecutorPayloadHash(input);
  if (!verified.executorPayloadHash) {
    refuse('LUNA_AUTHORITY_UNBOUND', 'The signed launch record has no executor authority binding.');
  }
  if (verified.executorPayloadHash !== expectedAuthorityHash) {
    refuse('LUNA_AUTHORITY_MISMATCH', 'The signed launch authority does not match this normalized executor input.');
  }
  verifyRepository(deps, input);
  const target = path.resolve(deps.worktreePathFor(input.laneId, input.repoRoot));
  assertLaneAvailable(deps, input);
  const evidenceBoundary = establishCanonicalEvidenceRoot(deps.fs, input);
  const beforeRoot = rootFingerprint(deps, input.repoRoot);
  const reservation = await reserveLanePayload(deps, input, verified, evidenceBoundary);
  let evidenceDir = reservation.evidenceDir;
  try {
    evidenceDir = resolveEvidenceDir(deps.fs, evidenceBoundary, input, verified);
  } catch (error) {
    return Object.freeze({
      outcome: 'rejected',
      rejectionCodes: Object.freeze(['EVIDENCE_WRITE_FAILED']),
      launch: verified,
      laneId: input.laneId,
      itemId: input.itemId,
      model: LUNA_MODEL,
      baseCommit: input.baseCommit,
      worktreePath: target,
      evidenceDir,
      manifestPath: path.join(evidenceDir, 'manifest.json'),
      terminalReceiptPath: path.join(evidenceDir, 'terminal-receipt.json'),
      changedPaths: Object.freeze([]),
      rootUnchanged: null,
      markerOk: null,
      evidenceComplete: false,
      terminalized: false,
      error: safeErrorCode(error, 'EVIDENCE_WRITE_FAILED')
    });
  }
  const paths = {
    stdout: path.join(evidenceDir, 'luna.stdout.log'),
    stderr: path.join(evidenceDir, 'luna.stderr.log'),
    verificationStdout: path.join(evidenceDir, 'verification.stdout.log'),
    verificationStderr: path.join(evidenceDir, 'verification.stderr.log'),
    result: path.join(evidenceDir, 'result.json'),
    diff: path.join(evidenceDir, 'final.diff'),
    manifest: path.join(evidenceDir, 'manifest.json'),
    terminal: path.join(evidenceDir, 'terminal-receipt.json')
  };
  const evidence = createEvidenceTracker();
  let created = null;
  let runner = null;
  let verification = null;
  let initial = { changed: [], ignored: [], allowed: new Set(input.allowedPaths.map(pathKey)) };
  let final = { changed: [], ignored: [], allowed: new Set(input.allowedPaths.map(pathKey)) };
  let markerOk = null;
  let rootUnchanged = null;
  let patch = '';
  let pathHashes = {};
  let unexpected = null;
  const startedAt = deps.now();
  const laneDeadline = Date.now() + input.timeoutMs;

  try {
    created = deps.createLaneWorktree(input.laneId, {
      repoRoot: input.repoRoot,
      ref: input.baseCommit,
      itemId: input.itemId,
      supervisorId: 'luna-executor-v1',
      exec: deps.gitExec,
      fsImpl: deps.fs,
      now: () => new Date(deps.now())
    });
    const createdHead = gitChecked(deps, ['rev-parse', 'HEAD'], created.path, 'LUNA_WORKTREE_CREATE_FAILED').trim().toLowerCase();
    if (createdHead !== input.baseCommit) refuse('LUNA_BASE_INVALID', 'The detached worktree did not resolve to the immutable base commit.');
    assertAllowedPathAncestors(deps.fs, created.path, input.allowedPaths);

    const laneRunner = deps.runLuna || ((options) => runLunaProcess(options, deps));
    runner = await laneRunner({ input, worktreePath: created.path, evidenceDir, timeoutMs: Math.max(1, laneDeadline - Date.now()),
      outputBudgetBytes: input.outputBudgetBytes, verifiedLaunch: verified, deps });
    if (!runner || typeof runner !== 'object') refuse('LUNA_RUNNER_ERROR', 'The Luna runner returned no result.');
    writeEvidenceText(deps.fs, evidenceBoundary, paths.stdout, runner.stdout, evidence, 'luna.stdout.log');
    writeEvidenceText(deps.fs, evidenceBoundary, paths.stderr, runner.stderr, evidence, 'luna.stderr.log');
    assertAllowedPathAncestors(deps.fs, created.path, input.allowedPaths);
    initial = { ...changedPaths(deps, created.path, input.baseCommit), allowed: new Set(input.allowedPaths.map(pathKey)) };

    if (runner.ok && initial.changed.length > 0 && initial.ignored.length === 0
        && initial.changed.every(file => !isControllerOnly(file) && input.allowedPaths.some(allowed => pathKey(allowed) === pathKey(file)))) {
      const remaining = Math.max(1, input.outputBudgetBytes - (runner.stdoutBytes || 0) - (runner.stderrBytes || 0));
      const verifyRunner = deps.runVerification || ((options) => runVerification(options, deps));
      const verificationTimeout = laneDeadline - Date.now();
      if (verificationTimeout <= 0) {
        verification = {
          ok: false,
          exitCode: null,
          timedOut: true,
          outputBudgetExceeded: false,
          stdout: '',
          stderr: '',
          stdoutBytes: 0,
          stderrBytes: 0,
          durationMs: 0,
          declared: input.verificationCommand
        };
      } else {
        verification = await verifyRunner({ input, worktreePath: created.path, timeoutMs: verificationTimeout,
          outputBudgetBytes: remaining, deps });
      }
    }
    if (verification) {
      writeEvidenceText(deps.fs, evidenceBoundary, paths.verificationStdout, verification.stdout, evidence, 'verification.stdout.log');
      writeEvidenceText(deps.fs, evidenceBoundary, paths.verificationStderr, verification.stderr, evidence, 'verification.stderr.log');
    } else {
      writeEvidenceText(deps.fs, evidenceBoundary, paths.verificationStdout, '', evidence, 'verification.stdout.log');
      writeEvidenceText(deps.fs, evidenceBoundary, paths.verificationStderr, '', evidence, 'verification.stderr.log');
    }
    assertAllowedPathAncestors(deps.fs, created.path, input.allowedPaths);
    final = { ...changedPaths(deps, created.path, input.baseCommit), allowed: new Set(input.allowedPaths.map(pathKey)) };
    markerOk = markerMatches(deps.fs, created.path, created.marker);
    rootUnchanged = rootFingerprint(deps, input.repoRoot).digest === beforeRoot.digest;
    if (final.ignored.length === 0) {
      const captured = stageAndCapturePatch(deps, created.path, input.baseCommit, deps.fs);
      patch = captured.patch;
      final = { ...final, changed: [...new Set([...final.changed, ...captured.changedPaths])].sort(), allowed: final.allowed };
      writeEvidenceText(deps.fs, evidenceBoundary, paths.diff, patch, evidence, 'final.diff');
      pathHashes = hashChangedFiles(deps.fs, created.path, final.changed);
    } else {
      writeEvidenceText(deps.fs, evidenceBoundary, paths.diff, '', evidence, 'final.diff');
    }
  } catch (error) {
    unexpected = error;
    if (created) {
      try { initial = { ...changedPaths(deps, created.path, input.baseCommit), allowed: new Set(input.allowedPaths.map(pathKey)) }; } catch { /* preserve what is available */ }
      try { final = initial; } catch { /* no-op */ }
      try { markerOk = markerMatches(deps.fs, created.path, created.marker); } catch { markerOk = null; }
      try { rootUnchanged = rootFingerprint(deps, input.repoRoot).digest === beforeRoot.digest; } catch { rootUnchanged = false; }
      try {
        if (final.ignored.length === 0) {
          const captured = stageAndCapturePatch(deps, created.path, input.baseCommit, deps.fs);
          patch = captured.patch;
          final = { ...final, changed: [...new Set([...final.changed, ...captured.changedPaths])].sort(), allowed: final.allowed };
          pathHashes = hashChangedFiles(deps.fs, created.path, final.changed);
          writeEvidenceText(deps.fs, evidenceBoundary, paths.diff, patch, evidence, 'final.diff');
        } else {
          writeEvidenceText(deps.fs, evidenceBoundary, paths.diff, '', evidence, 'final.diff');
        }
      } catch { /* evidence best effort; the terminal receipt still rejects */ }
    }
  }

  for (const [artifact, artifactPath, value] of [
    ['luna.stdout.log', paths.stdout, runner && runner.stdout],
    ['luna.stderr.log', paths.stderr, runner && runner.stderr],
    ['verification.stdout.log', paths.verificationStdout, verification && verification.stdout],
    ['verification.stderr.log', paths.verificationStderr, verification && verification.stderr],
    ['final.diff', paths.diff, patch]
  ]) {
    if (!evidence.written.has(artifact)) writeEvidenceText(deps.fs, evidenceBoundary, artifactPath, value || '', evidence, artifact);
  }

  const rejectionCodes = failureCodesFor({ runner, initial, final, verification, markerOk, rootUnchanged });
  const addRejection = code => { if (!rejectionCodes.includes(code)) rejectionCodes.push(code); };
  if (unexpected && !runner) {
    addRejection('RUNNER_ERROR');
    addRejection(safeErrorCode(unexpected, 'EXECUTOR_ERROR'));
  }
  if (unexpected && rejectionCodes.length === 0) addRejection(safeErrorCode(unexpected, 'EXECUTOR_ERROR'));
  if (evidence.failures.length) addRejection('EVIDENCE_WRITE_FAILED');
  const processesContained = [runner, verification].every(result => !result || result.descendantsContained !== false);
  if (!processesContained) addRejection('PROCESS_TREE_UNCONTAINED');
  const completedAt = deps.now();
  const outcomeFor = () => rejectionCodes.length ? 'rejected' : 'eligible';
  const buildResult = () => ({
    schemaVersion: SCHEMA_VERSION,
    kind: 'luna-lane-result',
    outcome: outcomeFor(),
    rejectionCodes: [...rejectionCodes],
    launch: verified,
    executorPayloadHash: verified.executorPayloadHash,
    laneId: input.laneId,
    itemId: input.itemId,
    model: LUNA_MODEL,
    baseCommit: input.baseCommit,
    worktreePath: created ? created.path : target,
    runner: compactProcessResult(runner),
    verification: compactProcessResult(verification),
    changedPaths: final.changed,
    ignoredPaths: final.ignored,
    rootUnchanged,
    markerOk,
    processTreesContained: processesContained,
    evidenceWriteFailures: [...evidence.failures],
    durationMs: completedAt - startedAt,
    error: unexpected ? safeErrorCode(unexpected, 'EXECUTOR_ERROR') : null
  });
  const buildManifest = () => ({
    schemaVersion: SCHEMA_VERSION,
    kind: 'luna-lane-manifest',
    outcome: outcomeFor(),
    controllerAcceptanceRequired: true,
    launch: verified,
    executorPayloadHash: verified.executorPayloadHash,
    laneId: input.laneId,
    itemId: input.itemId,
    model: LUNA_MODEL,
    baseCommit: input.baseCommit,
    repoRoot: input.repoRoot,
    worktreePath: created ? created.path : target,
    allowedPaths: input.allowedPaths,
    changedPaths: final.changed,
    pathHashes,
    declaredVerification: input.verificationCommand,
    verification: compactProcessResult(verification),
    runner: compactProcessResult(runner),
    rejectionCodes: [...rejectionCodes],
    rootUnchanged,
    markerOk,
    processTreesContained: processesContained,
    evidenceWriteFailures: [...evidence.failures],
    evidence: {
      stdout: 'luna.stdout.log',
      stderr: 'luna.stderr.log',
      verificationStdout: 'verification.stdout.log',
      verificationStderr: 'verification.stderr.log',
      result: 'result.json',
      diff: 'final.diff',
      manifest: 'manifest.json',
      terminalReceipt: 'terminal-receipt.json'
    },
    createdAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString()
  });
  const writeSummaries = () => {
    const resultWritten = writeEvidenceJson(deps.fs, evidenceBoundary, paths.result, buildResult(), evidence, 'result.json');
    const manifestWritten = writeEvidenceJson(deps.fs, evidenceBoundary, paths.manifest, buildManifest(), evidence, 'manifest.json');
    return resultWritten && manifestWritten;
  };
  let summariesWritten = writeSummaries();
  if (!summariesWritten || evidence.failures.length) {
    addRejection('EVIDENCE_WRITE_FAILED');
    summariesWritten = writeSummaries();
  }

  let evidenceComplete = false;
  let terminalized = false;
  if (processesContained && summariesWritten) {
    const writeTerminal = () => {
      let artifactHashes;
      try { artifactHashes = evidenceArtifactHashMap(deps.fs, paths); }
      catch (error) {
        evidence.failures.push({ artifact: 'terminal-receipt.json', cause: safeErrorCode(error, 'EVIDENCE_HASH_FAILED') });
        return false;
      }
      return writeEvidenceJson(deps.fs, evidenceBoundary, paths.terminal, {
      schemaVersion: SCHEMA_VERSION,
      kind: 'luna-lane-terminal-receipt',
      terminalState: outcomeFor(),
      controllerAcceptanceRequired: true,
      launch: verified,
      executorPayloadHash: verified.executorPayloadHash,
      laneId: input.laneId,
      itemId: input.itemId,
      model: LUNA_MODEL,
      baseCommit: input.baseCommit,
      worktreePath: created ? created.path : target,
      evidenceDir,
      rejectionCodes: [...rejectionCodes],
      artifactHashes,
      manifest: 'manifest.json',
      result: 'result.json',
      createdAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString()
      }, evidence, 'terminal-receipt.json');
    };
    if (!writeTerminal() || evidence.failures.length) {
      addRejection('EVIDENCE_WRITE_FAILED');
      summariesWritten = writeSummaries();
      writeTerminal();
    }
    evidenceComplete = reservationEvidenceComplete(deps.fs, reservation.record, evidenceBoundary);
    if (!evidenceComplete) {
      addRejection('EVIDENCE_WRITE_FAILED');
      summariesWritten = writeSummaries();
      writeTerminal();
      evidenceComplete = reservationEvidenceComplete(deps.fs, reservation.record, evidenceBoundary);
    }
    if (evidenceComplete) {
      try { terminalized = await finalizeLaneReservation(deps, reservation); }
      catch (error) {
        addRejection('LUNA_RESERVATION_FAILED');
        writeSummaries();
        writeTerminal();
        terminalized = false;
      }
    }
  }
  if (!evidenceComplete && !rejectionCodes.includes('EVIDENCE_WRITE_FAILED')) {
    addRejection('EVIDENCE_WRITE_FAILED');
    // A process-containment failure writes no terminal receipt.  Ensure the
    // durable result/manifest cannot nevertheless claim eligibility.
    if (summariesWritten && !deps.fs.existsSync(paths.terminal)) writeSummaries();
  }
  return Object.freeze({
    outcome: evidenceComplete ? outcomeFor() : 'rejected',
    rejectionCodes: Object.freeze([...rejectionCodes]),
    launch: verified,
    laneId: input.laneId,
    itemId: input.itemId,
    model: LUNA_MODEL,
    baseCommit: input.baseCommit,
    worktreePath: created ? created.path : target,
    evidenceDir,
    manifestPath: paths.manifest,
    terminalReceiptPath: paths.terminal,
    changedPaths: Object.freeze(final.changed),
    rootUnchanged,
    markerOk,
    evidenceComplete,
    terminalized
  });
}

module.exports = Object.freeze({
  CONTROLLER_ONLY_EXACT,
  COMMIT_RE,
  LUNA_MODEL,
  LANE_ID_RE,
  MAX_OUTPUT_BUDGET_BYTES,
  MAX_TIMEOUT_MS,
  MIN_OUTPUT_BUDGET_BYTES,
  MIN_TIMEOUT_MS,
  LunaExecutorError,
  assertAllowedPathAncestors,
  changedPaths,
  boundedInputPrompt,
  executorPayloadHash,
  executeLunaLane,
  markerMatches,
  normalizeAllowedPaths,
  normalizeInput,
  normalizeLaunchReceipt,
  normalizeReservationRecord,
  normalizeVerificationCommand,
  processGroupContained,
  runBoundedCommand,
  runLunaProcess,
  // Exported so a test can spawn a REAL child from the environment this file
  // builds. Every scrub in this tree that stayed broken longest was one no test
  // could reach without running the whole lane.
  scrubEnvironment,
  reservationEvidenceComplete,
  verifyLaunchReceipt
});

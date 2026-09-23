'use strict';

// Live agent presence for R1146. This is observed runtime state, not authority.
// Declared roles and relationships remain in config/agent-org.json. Each lane
// runner owns one record for one runId; updates from another run are refused.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isRequestId } = require('./request-id');
const agentOrg = require('./agent-org');
const { ROLES } = agentOrg;

const fleetState = require('./fleet-supervisor/state');
// state/ is per-user runtime data. Installed, it is not the program directory,
// which the next update replaces and a per-machine install makes read-only.
// See src/lib/runtime-state-root.js.
const { statePath } = require('./runtime-state-root');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_VERSION = 1;

function configuredPath(environmentName, fallback) {
  const value = process.env[environmentName];
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  if (value.includes('\0')) {
    const error = new Error(`${environmentName} contains a NUL byte.`);
    error.code = 'AGENT_PRESENCE_PATH_INVALID';
    throw error;
  }
  return path.resolve(value.trim());
}

// The overrides let a packaged deployment or an isolated fixture relocate all
// three coordinated files together. They are resolved once at process start,
// just like the durable task store's TOOLSENABLED_STATE_PATH override.
const DEFAULT_STATE_FILE = configuredPath(
  'TOOLSENABLED_AGENT_PRESENCE_FILE',
  statePath('state', 'agent-presence.json')
);
const DEFAULT_MAILBOX_DIR = configuredPath(
  'TOOLSENABLED_AGENT_MAILBOX_DIR',
  statePath('state', 'agent-mailbox')
);
const DEFAULT_LAUNCH_DIR = configuredPath(
  'TOOLSENABLED_AGENT_LAUNCH_DIR',
  statePath('state', 'agent-launch')
);
const DEFAULT_USEFUL_PROGRESS_DIR = configuredPath(
  'TOOLSENABLED_AGENT_USEFUL_PROGRESS_DIR',
  path.join(path.dirname(DEFAULT_STATE_FILE), 'agent-useful-progress')
);
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RUN_ID_RE = /^[a-f0-9-]{16,64}$/;
const PROCESS_START_TICKS_RE = /^[1-9]\d{0,19}$/;
const STATUS = Object.freeze(['starting', 'running', 'stale', 'finished', 'failed']);
const TERMINAL = new Set(['finished', 'failed']);
// `local` is a model running on the user's own GPU (Ollama, LM Studio,
// llama.cpp, vLLM), dispatched through the mission bridge `local` tier. It takes
// a real seat here for the same reason the cloud kinds do: this registry is what
// refuses a second live lane per identity, and a local node that skipped it
// would be able to collide with itself while looking healthy.
const KINDS = Object.freeze(['codex', 'claude', 'local', 'test-node']);
const USEFUL_PROGRESS_KINDS = Object.freeze(['tool-success', 'checkpoint-change', 'terminal']);
const MAX_RECORDS = 128;
const MAX_STRING = 2048;
const MAX_PROMPT = 8192;
const MAX_USEFUL_PROGRESS_BYTES = 1024;
const USEFUL_PROGRESS_SCHEMA_VERSION = 1;
const DEFAULT_STALE_MS = 45_000;

const SECRET_PATTERNS = Object.freeze([
  /sk_live_[A-Za-z0-9]+/,
  /sk-[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[a-z]?-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bAKIA[0-9A-Z]{16}\b/
]);

class AgentPresenceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AgentPresenceError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new AgentPresenceError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertAgentId(value, field = 'agentId') {
  const text = String(value ?? '');
  if (!AGENT_ID_RE.test(text)) fail('AGENT_PRESENCE_INVALID', `${field} is not a valid agent id.`, { field });
  return text;
}

function assertRunId(value) {
  const text = String(value ?? '');
  if (!RUN_ID_RE.test(text)) fail('AGENT_PRESENCE_INVALID', 'runId is invalid.', { field: 'runId' });
  return text;
}

function assertSafeString(value, field, { nullable = false, max = MAX_STRING } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\0\r\n]/.test(value)) {
    fail('AGENT_PRESENCE_INVALID', `${field} must be a bounded single-line string.`, { field });
  }
  if (SECRET_PATTERNS.some(pattern => pattern.test(value))) {
    fail('AGENT_PRESENCE_SECRET_REJECTED', `${field} contains secret-shaped content.`, { field });
  }
  return value;
}

function optionalEpoch(value, field, { nullable = true } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail('AGENT_PRESENCE_INVALID', `${field} must be epoch milliseconds.`, { field });
  return value;
}

function optionalPid(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) fail('AGENT_PRESENCE_INVALID', 'pid must be a positive integer or null.', { field: 'pid' });
  return value;
}

function optionalProcessStartTicks(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !PROCESS_START_TICKS_RE.test(value)) {
    fail('AGENT_PRESENCE_INVALID', 'processStartTicks must be an exact positive Windows creation-tick string or null.', {
      field: 'processStartTicks'
    });
  }
  return value;
}

function optionalExitCode(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
    fail('AGENT_PRESENCE_INVALID', 'exitCode must be a 32-bit integer or null.', { field: 'exitCode' });
  }
  return value;
}

function usefulProgressDirectory(stateFile = DEFAULT_STATE_FILE, options = {}) {
  if (options.progressDir !== undefined) {
    if (typeof options.progressDir !== 'string' || options.progressDir.trim() === ''
        || options.progressDir.includes('\0')) {
      fail('AGENT_USEFUL_PROGRESS_PATH_INVALID', 'Useful-progress directory is invalid.');
    }
    return path.resolve(options.progressDir.trim());
  }
  const resolvedState = path.resolve(stateFile);
  return resolvedState === path.resolve(DEFAULT_STATE_FILE)
    ? DEFAULT_USEFUL_PROGRESS_DIR
    : `${resolvedState}.useful-progress`;
}

function usefulProgressFile(agentId, options = {}) {
  const id = assertAgentId(agentId);
  const directory = usefulProgressDirectory(options.file || DEFAULT_STATE_FILE, options);
  const candidate = path.resolve(directory, `${id}.json`);
  if (path.dirname(candidate) !== directory) {
    fail('AGENT_USEFUL_PROGRESS_PATH_INVALID', 'Useful-progress path escaped its fixed directory.');
  }
  return candidate;
}

function normalizeUsefulProgress(input) {
  if (!plain(input)) fail('AGENT_USEFUL_PROGRESS_STATE_INVALID', 'Useful-progress state must be an object.');
  const expectedKeys = [
    'agentId', 'lastUsefulProgressAt', 'lastUsefulProgressKind', 'runId', 'schemaVersion', 'usefulProgressSeq'
  ];
  const keys = Object.keys(input).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    fail('AGENT_USEFUL_PROGRESS_STATE_INVALID', 'Useful-progress state has unsupported or missing fields.');
  }
  if (input.schemaVersion !== USEFUL_PROGRESS_SCHEMA_VERSION) {
    fail('AGENT_USEFUL_PROGRESS_STATE_INVALID', 'Useful-progress schema version is unsupported.');
  }
  const usefulProgressSeq = input.usefulProgressSeq;
  if (!Number.isSafeInteger(usefulProgressSeq) || usefulProgressSeq < 0) {
    fail('AGENT_USEFUL_PROGRESS_STATE_INVALID', 'Useful-progress sequence must be a non-negative integer.');
  }
  const lastUsefulProgressAt = optionalEpoch(input.lastUsefulProgressAt, 'lastUsefulProgressAt');
  const lastUsefulProgressKind = input.lastUsefulProgressKind === null
    ? null : String(input.lastUsefulProgressKind);
  if (lastUsefulProgressKind !== null && !USEFUL_PROGRESS_KINDS.includes(lastUsefulProgressKind)) {
    fail('AGENT_USEFUL_PROGRESS_STATE_INVALID', 'Useful-progress kind is unsupported.');
  }
  if ((usefulProgressSeq === 0) !== (lastUsefulProgressAt === null && lastUsefulProgressKind === null)) {
    fail('AGENT_USEFUL_PROGRESS_STATE_INVALID', 'Useful-progress zero/null invariants are invalid.');
  }
  return Object.freeze({
    schemaVersion: USEFUL_PROGRESS_SCHEMA_VERSION,
    agentId: assertAgentId(input.agentId),
    runId: assertRunId(input.runId),
    usefulProgressSeq,
    lastUsefulProgressAt,
    lastUsefulProgressKind
  });
}

function sameFileIdentity(left, right) {
  return Boolean(left && right
    && typeof left.dev === 'bigint' && typeof right.dev === 'bigint'
    && typeof left.ino === 'bigint' && typeof right.ino === 'bigint'
    && typeof left.nlink === 'bigint' && typeof right.nlink === 'bigint'
    && typeof left.size === 'bigint' && typeof right.size === 'bigint'
    && typeof left.mtimeNs === 'bigint' && typeof right.mtimeNs === 'bigint'
    && typeof left.ctimeNs === 'bigint' && typeof right.ctimeNs === 'bigint'
    && left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs);
}

function assertNoReparsePath(candidate, fsImpl, { allowMissing = false } = {}) {
  const resolved = path.resolve(candidate);
  const root = path.parse(resolved).root;
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try { stat = fsImpl.lstatSync(current, { bigint: true }); }
    catch (error) {
      if (allowMissing && error && error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      fail('AGENT_USEFUL_PROGRESS_FILE_REFUSED', 'Useful-progress paths must not traverse reparse points.');
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      fail('AGENT_USEFUL_PROGRESS_PATH_INVALID', 'Useful-progress path has a non-directory parent.');
    }
  }
  return true;
}

function boundedProgressBytes(file, fsImpl) {
  if (!assertNoReparsePath(file, fsImpl, { allowMissing: true })) return null;
  let before;
  try { before = fsImpl.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n
      || before.size < 0n || before.size > BigInt(MAX_USEFUL_PROGRESS_BYTES)) {
    fail('AGENT_USEFUL_PROGRESS_FILE_REFUSED', 'Useful-progress sidecar is not a bounded single-link regular file.');
  }
  let handle;
  try {
    handle = fsImpl.openSync(file, 'r');
    const opened = fsImpl.fstatSync(handle, { bigint: true });
    if (opened.isSymbolicLink() || !opened.isFile() || opened.nlink !== 1n
        || opened.size > BigInt(MAX_USEFUL_PROGRESS_BYTES) || !sameFileIdentity(before, opened)) {
      fail('AGENT_USEFUL_PROGRESS_FILE_REFUSED', 'Useful-progress sidecar changed while it was opened.');
    }
    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = fsImpl.readSync(handle, buffer, offset, buffer.length - offset, offset);
      if (count <= 0) fail('AGENT_USEFUL_PROGRESS_FILE_REFUSED', 'Useful-progress sidecar ended unexpectedly.');
      offset += count;
    }
    const after = fsImpl.fstatSync(handle, { bigint: true });
    const pathAfter = fsImpl.lstatSync(file, { bigint: true });
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(after, pathAfter)) {
      fail('AGENT_USEFUL_PROGRESS_FILE_REFUSED', 'Useful-progress sidecar changed during its read.');
    }
    return buffer;
  } finally {
    if (handle !== undefined) try { fsImpl.closeSync(handle); } catch { /* best effort */ }
  }
}

// A missing or run-mismatched sidecar has no progress for this run. Once a
// sidecar exists, however, an unsafe or unreadable file is not evidence that
// the registry's older progress fields are current: carry that failure to the
// caller rather than reporting a definite stale count.
function readUsefulProgress(agentId, options = {}) {
  const id = assertAgentId(agentId);
  const fsImpl = options.fsImpl || fs;
  const file = usefulProgressFile(id, options);
  const buffer = boundedProgressBytes(file, fsImpl);
  if (buffer === null) return null;
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); }
  catch { fail('AGENT_USEFUL_PROGRESS_STATE_INVALID', `Useful-progress state is not valid JSON: ${file}.`); }
  const progress = normalizeUsefulProgress(parsed);
  if (progress.agentId !== id) return null;
  if (options.expectedRunId !== undefined && progress.runId !== assertRunId(options.expectedRunId)) return null;
  return progress;
}

function requireUsefulProgress(agentId, runId, options = {}) {
  const progress = readUsefulProgress(agentId, { ...options, expectedRunId: runId });
  if (!progress) {
    fail('AGENT_USEFUL_PROGRESS_UNAVAILABLE', 'Matching useful-progress state is missing or unsafe.', {
      agentId: assertAgentId(agentId), runId: assertRunId(runId)
    });
  }
  return progress;
}

function progressRecord(agentId, runId, {
  usefulProgressSeq = 0,
  lastUsefulProgressAt = null,
  lastUsefulProgressKind = null
} = {}) {
  return normalizeUsefulProgress({
    schemaVersion: USEFUL_PROGRESS_SCHEMA_VERSION,
    agentId,
    runId,
    usefulProgressSeq,
    lastUsefulProgressAt,
    lastUsefulProgressKind
  });
}

function assertReplaceableProgressTarget(file, fsImpl) {
  if (!assertNoReparsePath(file, fsImpl, { allowMissing: true })) return;
  let stat;
  try { stat = fsImpl.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    fail('AGENT_USEFUL_PROGRESS_FILE_REFUSED', 'Useful-progress replacement target is unsafe.');
  }
}

function writeUsefulProgress(progress, options = {}) {
  const normalized = normalizeUsefulProgress(progress);
  const fsImpl = options.fsImpl || fs;
  const file = usefulProgressFile(normalized.agentId, options);
  const directory = path.dirname(file);
  assertNoReparsePath(directory, fsImpl, { allowMissing: true });
  fsImpl.mkdirSync(directory, { recursive: true });
  assertNoReparsePath(directory, fsImpl);
  const directoryStat = fsImpl.lstatSync(directory, { bigint: true });
  if (!directoryStat.isDirectory()) {
    fail('AGENT_USEFUL_PROGRESS_PATH_INVALID', 'Useful-progress directory must not be a reparse point.');
  }
  assertReplaceableProgressTarget(file, fsImpl);
  const temporary = path.join(directory, `.${normalized.agentId}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = fsImpl.openSync(temporary, 'wx', 0o600);
    fsImpl.writeFileSync(handle, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8' });
    if (typeof fsImpl.fsyncSync === 'function') fsImpl.fsyncSync(handle);
    fsImpl.closeSync(handle);
    handle = undefined;
    assertReplaceableProgressTarget(file, fsImpl);
    fsImpl.renameSync(temporary, file);
  } finally {
    if (handle !== undefined) try { fsImpl.closeSync(handle); } catch { /* best effort */ }
    try { fsImpl.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
  return normalized;
}

function emptyRegistry() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: null, agents: {} };
}

function normalizeRecord(input, options = {}) {
  if (!plain(input)) fail('AGENT_PRESENCE_INVALID', 'A presence record must be an object.');
  const suppliedRole = String(input.role ?? '');
  // The pre-R1175 persisted vocabulary used `coordinator`. Read it as the
  // fixed `controller` role so one historical row cannot brick the live
  // registry; new records still reject the retired spelling.
  const role = options.allowLegacyRoles && suppliedRole === 'coordinator' ? 'controller' : suppliedRole;
  // Presence is an observation of a lane whose role was already admitted by
  // the declared organisation.  Keep the identifier safe here, but do not
  // re-impose the shipped default vocabulary: operator-defined roles are
  // intentionally additive and must remain readable after launch.  Authority
  // still comes only from a separately normalized agent org.
  if ((!options.allowLegacyRoles && suppliedRole === 'coordinator')
      || !agentOrg.ROLE_ID.test(role) || agentOrg.RESERVED_ROLE_IDS.includes(role)) {
    fail('AGENT_PRESENCE_INVALID', 'role must be a safe declared-role identifier.', { field: 'role' });
  }
  const status = String(input.status ?? '');
  if (!STATUS.includes(status)) fail('AGENT_PRESENCE_INVALID', `status must be one of: ${STATUS.join(', ')}.`, { field: 'status' });
  const recordRevision = Number(input.recordRevision);
  if (!Number.isSafeInteger(recordRevision) || recordRevision < 1) {
    fail('AGENT_PRESENCE_INVALID', 'recordRevision must be a positive integer.', { field: 'recordRevision' });
  }
  const respawnCount = input.respawnCount === undefined ? 0 : input.respawnCount;
  if (!Number.isSafeInteger(respawnCount) || respawnCount < 0 || respawnCount > 100) {
    fail('AGENT_PRESENCE_INVALID', 'respawnCount must be an integer from 0 through 100.', { field: 'respawnCount' });
  }
  const mailboxOffset = input.mailboxOffset === undefined ? 0 : input.mailboxOffset;
  if (!Number.isSafeInteger(mailboxOffset) || mailboxOffset < 0) {
    fail('AGENT_PRESENCE_INVALID', 'mailboxOffset must be a non-negative integer.', { field: 'mailboxOffset' });
  }
  const dispatcher = input.dispatcher === 'owner' ? 'owner' : assertAgentId(input.dispatcher, 'dispatcher');
  const reportsTo = input.reportsTo === null ? null : assertAgentId(input.reportsTo, 'reportsTo');
  const origin = dispatcher === 'owner' ? 'user' : 'self';
  const kind = input.kind === undefined
    ? (String(input.tier || '').startsWith('claude/') ? 'claude' : 'codex')
    : String(input.kind);
  if (!KINDS.includes(kind)) fail('AGENT_PRESENCE_INVALID', `kind must be one of: ${KINDS.join(', ')}.`, { field: 'kind' });
  const terminalAt = optionalEpoch(input.terminalAt, 'terminalAt');
  const legacyTerminalProgress = input.usefulProgressSeq === undefined && TERMINAL.has(status) && terminalAt !== null;
  const usefulProgressSeq = input.usefulProgressSeq === undefined ? (legacyTerminalProgress ? 1 : 0) : input.usefulProgressSeq;
  if (!Number.isSafeInteger(usefulProgressSeq) || usefulProgressSeq < 0) {
    fail('AGENT_PRESENCE_INVALID', 'usefulProgressSeq must be a non-negative integer.', { field: 'usefulProgressSeq' });
  }
  const lastUsefulProgressAt = input.lastUsefulProgressAt === undefined
    ? (legacyTerminalProgress ? terminalAt : null)
    : optionalEpoch(input.lastUsefulProgressAt, 'lastUsefulProgressAt');
  const lastUsefulProgressKind = input.lastUsefulProgressKind === undefined
    ? (legacyTerminalProgress ? 'terminal' : null)
    : (input.lastUsefulProgressKind === null ? null : String(input.lastUsefulProgressKind));
  if (lastUsefulProgressKind !== null && !USEFUL_PROGRESS_KINDS.includes(lastUsefulProgressKind)) {
    fail('AGENT_PRESENCE_INVALID', `lastUsefulProgressKind must be one of: ${USEFUL_PROGRESS_KINDS.join(', ')}, or null.`, {
      field: 'lastUsefulProgressKind'
    });
  }
  if ((usefulProgressSeq === 0) !== (lastUsefulProgressAt === null && lastUsefulProgressKind === null)) {
    fail('AGENT_PRESENCE_INVALID', 'Useful-progress sequence zero requires null progress time/kind, and a positive sequence requires both.', {
      field: 'usefulProgressSeq'
    });
  }
  const normalized = {
    agentId: assertAgentId(input.agentId),
    runId: assertRunId(input.runId),
    recordRevision,
    kind,
    role,
    tier: assertSafeString(input.tier, 'tier', { max: 120 }),
    reportsTo,
    dispatcher,
    origin,
    lane: assertSafeString(input.lane, 'lane', { max: 120 }),
    territory: assertSafeString(input.territory, 'territory'),
    currentTask: input.currentTask === null ? null : assertSafeString(input.currentTask, 'currentTask', { max: 160 }),
    brief: assertSafeString(input.brief, 'brief'),
    consoleLog: assertSafeString(input.consoleLog, 'consoleLog'),
    worktree: assertSafeString(input.worktree, 'worktree'),
    launchSpec: assertSafeString(input.launchSpec, 'launchSpec'),
    pid: optionalPid(input.pid),
    startedAt: optionalEpoch(input.startedAt, 'startedAt', { nullable: false }),
    lastHeartbeat: optionalEpoch(input.lastHeartbeat, 'lastHeartbeat', { nullable: false }),
    status,
    exitCode: optionalExitCode(input.exitCode),
    lastVerdict: assertSafeString(input.lastVerdict, 'lastVerdict', { nullable: true, max: 4096 }),
    terminalAt,
    staleReason: assertSafeString(input.staleReason, 'staleReason', { nullable: true, max: 512 }),
    usefulProgressSeq,
    lastUsefulProgressAt,
    lastUsefulProgressKind,
    mailboxOffset,
    respawnCount,
    verdictConsumedAt: optionalEpoch(input.verdictConsumedAt, 'verdictConsumedAt')
  };
  // Historical and non-Windows rows legitimately lack this field.  A Windows
  // Job Object lane adds it with the first running heartbeat so later process
  // control can fence PID reuse against the retained kernel creation identity.
  if (input.processStartTicks !== undefined) {
    normalized.processStartTicks = optionalProcessStartTicks(input.processStartTicks);
    if (normalized.processStartTicks !== null && normalized.pid === null) {
      fail('AGENT_PRESENCE_INVALID', 'processStartTicks requires the matching positive pid.', {
        field: 'processStartTicks'
      });
    }
  }
  // Optional structured provenance; historical/unrelated lanes legitimately
  // lack it and therefore remain unbound rather than fabricated.
  if (input.directiveId !== undefined) {
    if (!isRequestId(input.directiveId)) {
      fail('AGENT_PRESENCE_INVALID', 'directiveId must be a canonical R/Q request id when provided.', { field: 'directiveId' });
    }
    normalized.directiveId = input.directiveId;
  }
  if (!TERMINAL.has(status) && (normalized.exitCode !== null || normalized.terminalAt !== null)) {
    fail('AGENT_PRESENCE_INVALID', 'Only terminal records may carry exitCode or terminalAt.');
  }
  return Object.freeze(normalized);
}

function normalizeRegistry(input) {
  if (!plain(input) || input.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(input.revision) || input.revision < 0 || !plain(input.agents)) {
    fail('AGENT_PRESENCE_STATE_INVALID', 'Agent presence state is malformed or has an unsupported schema version.');
  }
  const entries = Object.entries(input.agents);
  if (entries.length > MAX_RECORDS) fail('AGENT_PRESENCE_STATE_INVALID', `Agent presence is bounded to ${MAX_RECORDS} records.`);
  const agents = {};
  for (const [key, value] of entries) {
    const record = normalizeRecord(value, { allowLegacyRoles: true });
    if (key !== record.agentId) fail('AGENT_PRESENCE_STATE_INVALID', `Presence key ${key} does not match record agentId ${record.agentId}.`);
    agents[key] = record;
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    revision: input.revision,
    updatedAt: optionalEpoch(input.updatedAt, 'updatedAt'),
    agents: Object.freeze(agents)
  });
}

function overlayUsefulProgress(registry, file, options = {}) {
  const agents = {};
  for (const [agentId, record] of Object.entries(registry.agents)) {
    const progress = readUsefulProgress(agentId, {
      file,
      progressDir: options.progressDir,
      fsImpl: options.fsImpl || fs,
      expectedRunId: record.runId
    });
    agents[agentId] = progress
      ? normalizeRecord({
          ...record,
          usefulProgressSeq: progress.usefulProgressSeq,
          lastUsefulProgressAt: progress.lastUsefulProgressAt,
          lastUsefulProgressKind: progress.lastUsefulProgressKind
        })
      : record;
  }
  return Object.freeze({
    schemaVersion: registry.schemaVersion,
    revision: registry.revision,
    updatedAt: registry.updatedAt,
    agents: Object.freeze(agents)
  });
}

function readRegistry(file = DEFAULT_STATE_FILE, options = {}) {
  const fsImpl = options.fsImpl || fs;
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return overlayUsefulProgress(normalizeRegistry(emptyRegistry()), file, options);
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { fail('AGENT_PRESENCE_STATE_INVALID', `Agent presence state is not valid JSON: ${file}.`); }
  return overlayUsefulProgress(normalizeRegistry(parsed), file, options);
}

function writeAtomic(file, value, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fsImpl.renameSync(temp, file);
  } finally {
    try { fsImpl.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

function withRegistryLock(options, work) {
  const file = options.file || DEFAULT_STATE_FILE;
  const fsImpl = options.fsImpl || fs;
  const lockFile = fleetState.lockFileFor(file);
  fleetState.acquireStateLock(lockFile, {
    fsImpl,
    pid: options.pid || process.pid,
    isAlive: options.isAlive || fleetState.pidAlive,
    timeoutMs: options.lockTimeoutMs,
    sleep: options.sleep
  });
  try { return work({ file, fsImpl }); }
  finally { fleetState.releaseStateLock(lockFile, options.pid || process.pid, fsImpl); }
}

function mutateRegistry(mutator, options = {}) {
  return withRegistryLock(options, ({ file, fsImpl }) => {
    const current = readRegistry(file, { fsImpl, progressDir: options.progressDir });
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      fail('AGENT_PRESENCE_CAS_MISMATCH', `Expected registry revision ${options.expectedRevision}; found ${current.revision}.`, {
        expectedRevision: options.expectedRevision,
        actualRevision: current.revision
      });
    }
    const agents = { ...current.agents };
    const result = mutator({ current, agents });
    const now = (options.clock || Date.now)();
    const next = normalizeRegistry({ schemaVersion: SCHEMA_VERSION, revision: current.revision + 1, updatedAt: now, agents });
    writeAtomic(file, next, { fsImpl });
    return Object.freeze({ registry: next, result });
  });
}

function register(record, options = {}) {
  const prepared = normalizeRecord({
    ...record,
    recordRevision: 1,
    usefulProgressSeq: 0,
    lastUsefulProgressAt: null,
    lastUsefulProgressKind: null
  });
  return mutateRegistry(({ agents }) => {
    const existing = agents[prepared.agentId];
    if (existing && !TERMINAL.has(existing.status) && existing.status !== 'stale') {
      fail('AGENT_PRESENCE_ACTIVE', `Agent ${prepared.agentId} already has an active presence record.`, {
        agentId: prepared.agentId,
        runId: existing.runId,
        status: existing.status
      });
    }
    // The sidecar is committed first while the registry ownership lock is
    // held. Therefore a visible new-run presence record always has a durable
    // zero baseline. If the later registry replacement fails, the stale
    // new-run sidecar is ignored by the still-current old run.
    writeUsefulProgress(progressRecord(prepared.agentId, prepared.runId), {
      ...options,
      file: options.file || DEFAULT_STATE_FILE
    });
    agents[prepared.agentId] = prepared;
    return prepared;
  }, options).result;
}

function update(agentId, runId, patch, options = {}) {
  const id = assertAgentId(agentId);
  const run = assertRunId(runId);
  if (!plain(patch)) fail('AGENT_PRESENCE_INVALID', 'Presence update patch must be an object.');
  const known = new Set([
    'agentId', 'runId', 'recordRevision', 'kind', 'role', 'tier', 'reportsTo', 'dispatcher', 'origin', 'lane', 'territory',
    'currentTask', 'brief', 'consoleLog', 'worktree', 'launchSpec', 'directiveId', 'pid', 'processStartTicks', 'startedAt', 'lastHeartbeat', 'status',
    'exitCode', 'lastVerdict', 'terminalAt', 'staleReason', 'usefulProgressSeq', 'lastUsefulProgressAt',
    'lastUsefulProgressKind', 'mailboxOffset', 'respawnCount', 'verdictConsumedAt'
  ]);
  const unknown = Object.keys(patch).filter(key => !known.has(key));
  if (unknown.length) fail('AGENT_PRESENCE_INVALID', `Presence update has unknown field(s): ${unknown.join(', ')}.`);
  const immutable = [
    'agentId', 'runId', 'recordRevision', 'kind', 'origin', 'startedAt', 'directiveId',
    'usefulProgressSeq', 'lastUsefulProgressAt', 'lastUsefulProgressKind'
  ];
  if (Object.keys(patch).some(key => immutable.includes(key))) {
    fail('AGENT_PRESENCE_INVALID', 'Presence update attempted to change an immutable field.');
  }
  return mutateOwnedRecord(id, run, existing => {
    if (Object.hasOwn(patch, 'processStartTicks')
        && existing.processStartTicks !== undefined
        && existing.processStartTicks !== null
        && patch.processStartTicks !== existing.processStartTicks) {
      fail('AGENT_PRESENCE_WRITER_MISMATCH', 'A running lane cannot change its retained process creation identity.', {
        agentId: id,
        runId: run
      });
    }
    return { ...existing, ...patch };
  }, options);
}

function mutateOwnedRecord(agentId, runId, transform, options = {}) {
  const id = assertAgentId(agentId);
  const run = assertRunId(runId);
  if (typeof transform !== 'function') fail('AGENT_PRESENCE_INVALID', 'Presence transform must be a function.');
  return mutateRegistry(({ agents }) => {
    const existing = agents[id];
    if (!existing) fail('AGENT_PRESENCE_NOT_FOUND', `No presence record exists for ${id}.`, { agentId: id });
    if (existing.runId !== run) fail('AGENT_PRESENCE_WRITER_MISMATCH', `Run ${run} does not own ${id}'s current record.`, { agentId: id });
    if (options.expectedRecordRevision !== undefined && existing.recordRevision !== options.expectedRecordRevision) {
      fail('AGENT_PRESENCE_CAS_MISMATCH', `Expected record revision ${options.expectedRecordRevision}; found ${existing.recordRevision}.`);
    }
    const transformed = transform(existing);
    if (transformed === null) return existing;
    const next = normalizeRecord({ ...transformed, recordRevision: existing.recordRevision + 1 });
    agents[id] = next;
    return next;
  }, options).result;
}

function heartbeat(agentId, runId, { pid, processStartTicks, currentTask, mailboxOffset, at = Date.now() } = {}, options = {}) {
  return update(agentId, runId, {
    status: 'running',
    pid,
    ...(processStartTicks === undefined ? {} : { processStartTicks }),
    currentTask: currentTask === undefined ? null : currentTask,
    mailboxOffset: mailboxOffset === undefined ? 0 : mailboxOffset,
    lastHeartbeat: at,
    exitCode: null,
    terminalAt: null,
    staleReason: null
  }, options);
}

function finish(agentId, runId, { exitCode, verdict = null, at = Date.now() } = {}, options = {}) {
  const id = assertAgentId(agentId);
  const run = assertRunId(runId);
  const code = optionalExitCode(exitCode);
  if (code === null) fail('AGENT_PRESENCE_INVALID', 'A terminal record requires exitCode.');
  const terminalAt = optionalEpoch(at, 'terminalAt', { nullable: false });
  return withRegistryLock(options, ({ file, fsImpl }) => {
    const current = readRegistry(file, { fsImpl, progressDir: options.progressDir });
    const existing = current.agents[id];
    if (!existing) fail('AGENT_PRESENCE_NOT_FOUND', `No presence record exists for ${id}.`, { agentId: id });
    if (existing.runId !== run) {
      fail('AGENT_PRESENCE_WRITER_MISMATCH', `Run ${run} does not own ${id}'s current record.`, { agentId: id });
    }
    if (options.expectedRecordRevision !== undefined && existing.recordRevision !== options.expectedRecordRevision) {
      fail('AGENT_PRESENCE_CAS_MISMATCH', `Expected record revision ${options.expectedRecordRevision}; found ${existing.recordRevision}.`);
    }
    let terminal = existing;
    if (!TERMINAL.has(existing.status)) {
      terminal = normalizeRecord({
        ...existing,
        recordRevision: existing.recordRevision + 1,
        status: code === 0 ? 'finished' : 'failed',
        exitCode: code,
        lastVerdict: verdict,
        terminalAt,
        lastHeartbeat: terminalAt,
        staleReason: null
      });
      const agents = { ...current.agents, [id]: terminal };
      const now = (options.clock || Date.now)();
      const next = normalizeRegistry({
        schemaVersion: SCHEMA_VERSION,
        revision: current.revision + 1,
        updatedAt: now,
        agents
      });
      // Presence terminalizes first. Until the following sidecar replacement
      // succeeds, readers conservatively retain the prior progress sequence.
      writeAtomic(file, next, { fsImpl });
    }

    let progress = requireUsefulProgress(id, run, { file, progressDir: options.progressDir, fsImpl });
    if (progress.lastUsefulProgressKind !== 'terminal') {
      progress = writeUsefulProgress(progressRecord(id, run, {
        usefulProgressSeq: progress.usefulProgressSeq + 1,
        lastUsefulProgressAt: terminal.terminalAt,
        lastUsefulProgressKind: 'terminal'
      }), { file, progressDir: options.progressDir, fsImpl });
    }
    return normalizeRecord({
      ...terminal,
      usefulProgressSeq: progress.usefulProgressSeq,
      lastUsefulProgressAt: progress.lastUsefulProgressAt,
      lastUsefulProgressKind: progress.lastUsefulProgressKind
    });
  });
}

function advanceUsefulProgress(agentId, runId, { kind, at = Date.now() } = {}, options = {}) {
  const id = assertAgentId(agentId);
  const run = assertRunId(runId);
  const progressKind = String(kind || '');
  if (!USEFUL_PROGRESS_KINDS.includes(progressKind) || progressKind === 'terminal') {
    fail('AGENT_PRESENCE_INVALID', 'Only tool-success or checkpoint-change may use the progress-event writer.', {
      field: 'kind'
    });
  }
  const progressAt = optionalEpoch(at, 'lastUsefulProgressAt', { nullable: false });
  return withRegistryLock(options, ({ file, fsImpl }) => {
    const current = readRegistry(file, { fsImpl, progressDir: options.progressDir });
    const existing = current.agents[id];
    if (!existing) fail('AGENT_PRESENCE_NOT_FOUND', `No presence record exists for ${id}.`, { agentId: id });
    if (existing.runId !== run) {
      fail('AGENT_PRESENCE_WRITER_MISMATCH', `Run ${run} does not own ${id}'s current record.`, { agentId: id });
    }
    if (options.expectedRecordRevision !== undefined && existing.recordRevision !== options.expectedRecordRevision) {
      fail('AGENT_PRESENCE_CAS_MISMATCH', `Expected record revision ${options.expectedRecordRevision}; found ${existing.recordRevision}.`);
    }
    if (TERMINAL.has(existing.status)) {
      fail('AGENT_PRESENCE_TERMINAL', 'A terminal presence record cannot accept later useful progress.');
    }
    const progress = requireUsefulProgress(id, run, { file, progressDir: options.progressDir, fsImpl });
    if (progress.lastUsefulProgressKind === 'terminal') {
      fail('AGENT_USEFUL_PROGRESS_STATE_INVALID', 'A running presence record cannot own terminal progress.');
    }
    const next = writeUsefulProgress(progressRecord(id, run, {
      usefulProgressSeq: progress.usefulProgressSeq + 1,
      lastUsefulProgressAt: progressAt,
      lastUsefulProgressKind: progressKind
    }), { file, progressDir: options.progressDir, fsImpl });
    return normalizeRecord({
      ...existing,
      usefulProgressSeq: next.usefulProgressSeq,
      lastUsefulProgressAt: next.lastUsefulProgressAt,
      lastUsefulProgressKind: next.lastUsefulProgressKind
    });
  });
}

function markStale(agentId, runId, reason, options = {}) {
  return update(agentId, runId, {
    status: 'stale',
    staleReason: assertSafeString(reason, 'staleReason', { max: 512 }),
    exitCode: null,
    terminalAt: null
  }, options);
}

function deriveLiveness(record, { now = Date.now(), staleMs = DEFAULT_STALE_MS, isAlive = fleetState.pidAlive } = {}) {
  const normalized = normalizeRecord(record);
  if (TERMINAL.has(normalized.status) || normalized.status === 'stale') return normalized.status;
  const alive = normalized.pid === null ? null : isAlive(normalized.pid);
  const late = now - normalized.lastHeartbeat > staleMs;
  if (late && alive === false) return 'stale';
  if (late && alive === true) return 'heartbeat-fault';
  if (normalized.pid !== null && alive === false) return 'process-gone';
  return normalized.status;
}

function rosterRows(registry, options = {}) {
  const normalized = normalizeRegistry(registry);
  return Object.values(normalized.agents).map(record => Object.freeze({
    agentId: record.agentId,
    kind: record.kind,
    role: record.role,
    tier: record.tier,
    reportsTo: record.reportsTo,
    lane: record.lane,
    territory: record.territory,
    origin: record.origin,
    pid: record.pid,
    startedAt: record.startedAt,
    lastHeartbeat: record.lastHeartbeat,
    usefulProgressSeq: record.usefulProgressSeq,
    lastUsefulProgressAt: record.lastUsefulProgressAt,
    lastUsefulProgressKind: record.lastUsefulProgressKind,
    status: record.status,
    liveness: deriveLiveness(record, options),
    exitCode: record.exitCode,
    verdict: record.lastVerdict
  })).sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function mailboxFile(agentId, mailboxDir = DEFAULT_MAILBOX_DIR) {
  return path.join(mailboxDir, `${assertAgentId(agentId)}.jsonl`);
}

function appendMailbox(agentId, entry, options = {}) {
  const file = options.file || mailboxFile(agentId, options.mailboxDir);
  const from = entry.from === 'owner' ? 'owner' : assertAgentId(entry.from, 'from');
  const prompt = assertSafeString(entry.prompt, 'prompt', { max: MAX_PROMPT });
  const requestId = assertSafeString(entry.requestId || crypto.randomUUID(), 'requestId', { max: 120 });
  const at = optionalEpoch(entry.at === undefined ? Date.now() : entry.at, 'at', { nullable: false });
  const row = Object.freeze({ from, at, prompt, requestId });
  const fsImpl = options.fsImpl || fs;
  const lockFile = fleetState.lockFileFor(file);
  fleetState.acquireStateLock(lockFile, { fsImpl, pid: options.pid || process.pid, isAlive: options.isAlive || fleetState.pidAlive });
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8' });
  } finally {
    fleetState.releaseStateLock(lockFile, options.pid || process.pid, fsImpl);
  }
  return row;
}

function drainMailbox(agentId, offset = 0, options = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) fail('AGENT_PRESENCE_INVALID', 'Mailbox offset must be a non-negative integer.');
  const file = options.file || mailboxFile(agentId, options.mailboxDir);
  const fsImpl = options.fsImpl || fs;
  let buffer;
  try { buffer = fsImpl.readFileSync(file); }
  catch (error) {
    if (error && error.code === 'ENOENT') return Object.freeze({ entries: Object.freeze([]), nextOffset: 0 });
    throw error;
  }
  if (offset > buffer.length) fail('AGENT_MAILBOX_OFFSET_INVALID', 'Mailbox offset is past the end of the append-only file.');
  const slice = buffer.subarray(offset).toString('utf8');
  const lines = slice.split('\n');
  if (lines[lines.length - 1] !== '') fail('AGENT_MAILBOX_PARTIAL', 'Mailbox ended with a partial JSON line; refusing to skip it.');
  lines.pop();
  const entries = lines.filter(Boolean).map((line, index) => {
    let row;
    try { row = JSON.parse(line); }
    catch { fail('AGENT_MAILBOX_INVALID', `Mailbox entry ${index + 1} after offset ${offset} is not JSON.`); }
    return Object.freeze({
      from: row.from === 'owner' ? 'owner' : assertAgentId(row.from, 'from'),
      at: optionalEpoch(row.at, 'at', { nullable: false }),
      prompt: assertSafeString(row.prompt, 'prompt', { max: MAX_PROMPT }),
      requestId: assertSafeString(row.requestId, 'requestId', { max: 120 })
    });
  });
  return Object.freeze({ entries: Object.freeze(entries), nextOffset: buffer.length });
}

function launchSpecFile(agentId, launchDir = DEFAULT_LAUNCH_DIR) {
  return path.join(launchDir, `${assertAgentId(agentId)}.json`);
}

module.exports = Object.freeze({
  AgentPresenceError,
  AGENT_ID_RE,
  DEFAULT_LAUNCH_DIR,
  DEFAULT_MAILBOX_DIR,
  DEFAULT_STALE_MS,
  DEFAULT_STATE_FILE,
  DEFAULT_USEFUL_PROGRESS_DIR,
  MAX_USEFUL_PROGRESS_BYTES,
  ROLES,
  KINDS,
  SCHEMA_VERSION,
  STATUS,
  TERMINAL,
  USEFUL_PROGRESS_SCHEMA_VERSION,
  USEFUL_PROGRESS_KINDS,
  advanceUsefulProgress,
  appendMailbox,
  assertAgentId,
  assertSafeString,
  drainMailbox,
  deriveLiveness,
  emptyRegistry,
  finish,
  heartbeat,
  launchSpecFile,
  mailboxFile,
  markStale,
  mutateRegistry,
  normalizeRecord,
  normalizeRegistry,
  normalizeUsefulProgress,
  readRegistry,
  readUsefulProgress,
  register,
  rosterRows,
  update,
  usefulProgressDirectory,
  usefulProgressFile,
  writeAtomic
});

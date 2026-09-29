'use strict';

// Durable, restart-survivable, cross-process fleet state.
//
// THE BUG THIS FILE EXISTS TO PREVENT: the owner was told ~15 lanes were
// running when zero were. The old fleet runner held everything in one process's
// memory, so "how many lanes are up" was whatever the last person guessed. Here
// every lane transition is written to disk before it is believed, and a lane
// whose true condition cannot be observed is recorded as `unknown` -- never as
// `running`. An overstated running count is treated as a correctness bug, not a
// cosmetic one.
//
// ATOMICITY: claiming a queue item is a read-modify-write across processes, so
// it runs inside an exclusive on-disk lock (O_EXCL create, PID recorded, stale
// holder reclaimed -- the same shape as src/lib/agent-digest/lock.js, which
// already solved this for the digest). The state file itself is replaced by
// write-temp-then-rename so a crash mid-write can never leave a half-written
// file: readers see either the old bytes or the new bytes.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const HISTORY_LIMIT = 200;
const LANE_RECORD_LIMIT = 300;

// Lane conditions.
//   starting/running -> this process launched it and holds the child handle
//   succeeded/failed -> observed terminal outcome
//   unknown          -> we genuinely do not know; NEVER counted as running
const TERMINAL_LANE_STATUSES = new Set(['succeeded', 'failed', 'unknown', 'refused']);

class FleetStateLockError extends Error {
  constructor(message, holderPid) {
    super(message);
    this.name = 'FleetStateLockError';
    this.code = 'FLEET_STATE_LOCKED';
    this.holderPid = holderPid;
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') return true;
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

// A real synchronous sleep. Busy-waiting on Date.now() would pin a core while
// holding nothing useful; Atomics.wait blocks the thread properly.
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function defaultStateFile(repoRoot) {
  return path.join(repoRoot, 'state', 'fleet-supervisor.json');
}

function lockFileFor(stateFile) {
  return `${stateFile}.lock`;
}

function emptyState(now = new Date()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    supervisor: null,
    lanes: {},
    items: {},
    // Per-phase planning-pass records (Q10.1: phase decomposition). Keyed by
    // the BUILD-QUEUE phase id, e.g. "Q21". Never keyed on a subtask id --
    // subtasks live inside `plans[phaseId].subtasks` and get their OWN entries
    // in `items`, keyed `"${phaseId}::${subtaskId}"`, so all existing
    // attempt/park/cooldown bookkeeping in `items` applies to them unchanged.
    plans: {},
    history: []
  };
}

function readState(stateFile, { fsImpl = fs, now = () => new Date() } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(stateFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState(now());
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt state file is a hard stop, not a silent reset: silently
    // starting empty would re-dispatch every in-flight item and duplicate work,
    // which is the exact failure mode this file is supposed to prevent.
    const error = new Error(
      `Fleet state file is not valid JSON: ${stateFile}. Refusing to start empty, because that would ` +
      're-dispatch in-flight work. Inspect the file, then move it aside deliberately.'
    );
    error.code = 'FLEET_STATE_CORRUPT';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object') {
    const error = new Error(`Fleet state file did not contain an object: ${stateFile}`);
    error.code = 'FLEET_STATE_CORRUPT';
    throw error;
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    const error = new Error(
      `Fleet state schema ${parsed.schemaVersion} is not ${SCHEMA_VERSION}; refusing to guess a migration.`
    );
    error.code = 'FLEET_STATE_SCHEMA';
    throw error;
  }
  parsed.lanes = parsed.lanes && typeof parsed.lanes === 'object' ? parsed.lanes : {};
  parsed.items = parsed.items && typeof parsed.items === 'object' ? parsed.items : {};
  // Additive: a state file written before the planning pass existed simply
  // has no `plans` key, and defaults to empty rather than tripping the
  // schema-version hard-stop above.
  parsed.plans = parsed.plans && typeof parsed.plans === 'object' ? parsed.plans : {};
  parsed.history = Array.isArray(parsed.history) ? parsed.history : [];
  return parsed;
}

function writeStateAtomic(stateFile, state, { fsImpl = fs, now = () => new Date() } = {}) {
  state.schemaVersion = SCHEMA_VERSION;
  state.updatedAt = now().toISOString();
  if (state.history.length > HISTORY_LIMIT) state.history = state.history.slice(-HISTORY_LIMIT);
  fsImpl.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fsImpl.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  // Windows can briefly refuse a replace-rename while a reader has the target
  // open (status polling reads outside the lock on purpose, so it never blocks
  // the fleet). Retry a few times before giving up rather than losing the write.
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fsImpl.renameSync(temp, stateFile);
      return state;
    } catch (error) {
      lastError = error;
      if (!error || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) break;
      sleepSync(20);
    }
  }
  try { fsImpl.rmSync(temp, { force: true }); } catch { /* best effort */ }
  throw lastError;
}

function readLockHolder(lockFile, fsImpl = fs) {
  let raw;
  try {
    raw = fsImpl.readFileSync(lockFile, 'utf8');
  } catch (error) {
    // The file can disappear between an EEXIST result and this read when a
    // previous holder releases it. Every other read failure leaves ownership
    // unknown and must stop acquisition rather than masquerade as no holder.
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const error = new FleetStateLockError(
      'The lock holder record is unreadable; refusing to assume no holder exists.',
      null
    );
    error.cause = cause;
    throw error;
  }
  if (!parsed || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
    throw new FleetStateLockError(
      'The lock holder record is unreadable; refusing to assume no holder exists.',
      null
    );
  }
  return parsed;
}

// Publish a complete holder record with an atomic no-overwrite link. Writing
// directly to the public O_EXCL path leaves a brief zero/partial-byte window:
// another contender can observe EEXIST and then fail closed on an unreadable
// holder that is merely still being written. The private inode is flushed
// first, so the public name is either absent or contains the complete record.
function publishLockHolderExclusive(lockFile, holder, fsImpl = fs) {
  const staged = `${lockFile}.publishing.${holder.pid}.${crypto.randomUUID()}`;
  let descriptor = null;
  try {
    descriptor = fsImpl.openSync(staged, 'wx', 0o600);
    fsImpl.writeFileSync(descriptor, JSON.stringify(holder), 'utf8');
    if (typeof fsImpl.fsyncSync === 'function') fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = null;
    try {
      fsImpl.linkSync(staged, lockFile);
      return true;
    } catch (error) {
      if (error && error.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    if (descriptor !== null) {
      try { fsImpl.closeSync(descriptor); } catch { /* preserve the primary error */ }
    }
    try { fsImpl.rmSync(staged, { force: true }); } catch { /* best effort */ }
  }
}

function acquireStateLock(lockFile, {
  fsImpl = fs,
  pid = process.pid,
  isAlive = pidAlive,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  reclaimLiveHolderAfterMs = LOCK_STALE_MS,
  now = () => Date.now(),
  sleep = sleepSync
} = {}) {
  fsImpl.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = now() + timeoutMs;
  for (;;) {
    const published = publishLockHolderExclusive(lockFile, { pid, at: new Date(now()).toISOString() }, fsImpl);
    if (published) {
      return { file: lockFile, pid };
    }
    const holder = readLockHolder(lockFile, fsImpl);
    // A concurrent release won the race after linkSync reported EEXIST.
    if (!holder) continue;
    const holderAt = holder && holder.at ? Date.parse(holder.at) : Number.NaN;
    const expired = Number.isFinite(reclaimLiveHolderAfterMs)
      && Number.isFinite(holderAt) && (now() - holderAt) > reclaimLiveHolderAfterMs;
    if (!isAlive(holder.pid) || expired) {
      // Dead or abandoned holder: reclaim rather than deadlock. An unreadable
      // holder is refused by readLockHolder above and is never reclaimed.
      try { fsImpl.rmSync(lockFile, { force: true }); } catch { /* raced */ }
      continue;
    }
    if (now() >= deadline) {
      throw new FleetStateLockError(
        `Timed out waiting ${timeoutMs}ms for the fleet state lock held by PID ${holder.pid}.`,
        holder.pid
      );
    }
    sleep(25);
  }
}

function releaseStateLock(lockFile, pid = process.pid, fsImpl = fs) {
  const holder = readLockHolder(lockFile, fsImpl);
  if (holder && holder.pid === pid) {
    try { fsImpl.rmSync(lockFile, { force: true }); } catch { /* best effort */ }
  }
}

// Run `mutate(state)` under the exclusive lock and persist whatever it returns
// (or the mutated state). This is the single serialization point for every
// state change, which is what makes claiming atomic across processes.
function withState(stateFile, mutate, options = {}) {
  const {
    fsImpl = fs, pid = process.pid, isAlive = pidAlive,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, now = () => new Date(), sleep = sleepSync
  } = options;
  const lockFile = lockFileFor(stateFile);
  acquireStateLock(lockFile, { fsImpl, pid, isAlive, timeoutMs: lockTimeoutMs, sleep });
  try {
    const state = readState(stateFile, { fsImpl, now });
    const outcome = mutate(state);
    const next = (outcome && outcome.state) || state;
    writeStateAtomic(stateFile, next, { fsImpl, now });
    return outcome && Object.prototype.hasOwnProperty.call(outcome, 'result') ? outcome.result : outcome;
  } finally {
    releaseStateLock(lockFile, pid, fsImpl);
  }
}

function itemRecord(state, itemId) {
  if (!state.items[itemId]) {
    state.items[itemId] = {
      itemId,
      attempts: 0,
      noProgressAttempts: 0,
      condition: 'idle',
      claimedByLaneId: null,
      parkedReason: null,
      parkedAt: null,
      lastOutcome: null,
      lastUpdatedAt: null
    };
  }
  return state.items[itemId];
}

// Recognize both the current hold marker and older persisted runner outcomes.
// A terminal label or missing PID cannot turn unknown cleanup into proof.
function hasUnprovenCleanup(record) {
  if (!record) return false;
  const unknown = value => value && (value.cleanupUnproven === true || value.code === 'CLEANUP_UNPROVEN'
    // runHarnessCommand uses SPAWN_THREW only for synchronous admission
    // refusal before it receives a child. No native receipt exists then.
    || (value.cleanupConfirmed === false && value.code !== 'SPAWN_THREW'));
  return Boolean(unknown(record) || unknown(record.outcome));
}

function laneOccupies(lane) {
  return lane && (!TERMINAL_LANE_STATUSES.has(lane.status) || hasUnprovenCleanup(lane));
}

// Keep the lane map bounded. At 15 lanes turning over for days this would
// otherwise grow without limit and eventually make every claim slow.
//
// A lane is NEVER dropped while it still means something: anything not
// terminal, any orphan still being watched, and any completed lane whose output
// no reviewer has looked at yet all survive regardless of age. Only settled,
// reviewed or empty history is trimmed, oldest first.
function pruneLanes(state, limit = LANE_RECORD_LIMIT) {
  const lanes = Object.values(state.lanes);
  if (lanes.length <= limit) return 0;

  const mustKeep = lane =>
    !TERMINAL_LANE_STATUSES.has(lane.status)
    || hasUnprovenCleanup(lane)
    || lane.orphanWatch === true
    || (lane.verification && lane.verification.state === 'unverified'
      && Number.isFinite(lane.changedFileCount) && lane.changedFileCount > 0);

  const kept = lanes.filter(mustKeep);
  const droppable = lanes.filter(lane => !mustKeep(lane))
    .sort((a, b) => String(a.endedAt || a.startedAt || '').localeCompare(String(b.endedAt || b.startedAt || '')));

  let removed = 0;
  while (kept.length + droppable.length > limit && droppable.length > 0) {
    const victim = droppable.shift();
    delete state.lanes[victim.laneId];
    removed += 1;
  }
  return removed;
}

module.exports = {
  DEFAULT_LOCK_TIMEOUT_MS,
  FleetStateLockError,
  HISTORY_LIMIT,
  LANE_RECORD_LIMIT,
  LOCK_STALE_MS,
  SCHEMA_VERSION,
  TERMINAL_LANE_STATUSES,
  acquireStateLock,
  defaultStateFile,
  emptyState,
  hasUnprovenCleanup,
  itemRecord,
  laneOccupies,
  lockFileFor,
  pidAlive,
  pruneLanes,
  readState,
  releaseStateLock,
  sleepSync,
  withState,
  writeStateAtomic
};

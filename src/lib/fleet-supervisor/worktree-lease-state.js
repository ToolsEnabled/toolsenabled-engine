'use strict';

// Q54 durable reservation layer. It reserves intent only: no git worktree,
// fleet runtime, agent process, or provider call is performed here.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WorktreeLeaseRefused, allocateWorktreeLease, normalizeLease } = require('./worktree-lease.js');

const LEASE_STATE_SCHEMA_VERSION = 1;
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const MAX_LEASE_TTL_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 60 * 1000;
const HOLDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class WorktreeLeaseStateError extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.name = 'WorktreeLeaseStateError'; this.code = code; this.detail = detail; }
}
function fail(code, detail) { throw new WorktreeLeaseStateError(code, detail); }
function repoRootOf(value) {
  if (typeof value !== 'string' || !value.trim()) fail('WORKTREE_LEASE_STATE_INVALID', 'repoRoot is required');
  return path.resolve(value);
}
function stateFileOf(value) {
  if (typeof value !== 'string' || !value.trim()) fail('WORKTREE_LEASE_STATE_INVALID', 'stateFile is required');
  return path.resolve(value);
}
function revisionOf(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('WORKTREE_LEASE_STATE_INVALID', 'expectedRevision must be a non-negative safe integer');
  return value;
}
function holderOf(value) {
  if (typeof value !== 'string' || !HOLDER_ID_PATTERN.test(value)) fail('WORKTREE_LEASE_STATE_INVALID', 'holderId is not a safe identifier');
  return value;
}
function ttlOf(value) {
  const ttl = value === undefined ? DEFAULT_LEASE_TTL_MS : value;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > MAX_LEASE_TTL_MS) fail('WORKTREE_LEASE_STATE_INVALID', `ttlMs must be 1000..${MAX_LEASE_TTL_MS}`);
  return ttl;
}
function nowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(value) || value < 0) fail('WORKTREE_LEASE_STATE_INVALID', 'now must be a non-negative safe integer');
  return value;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function emptyLeaseState(repoRoot) { return { schemaVersion: LEASE_STATE_SCHEMA_VERSION, repoRoot: repoRootOf(repoRoot), revision: 0, leases: {} }; }

function validateRecord(leaseId, record, repoRoot) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('WORKTREE_LEASE_STATE_CORRUPT', `lease ${leaseId} is not an object`);
  let lease;
  try { lease = normalizeLease(record.lease, { repoRoot, existing: true }); }
  catch (error) {
    if (error instanceof WorktreeLeaseRefused) fail('WORKTREE_LEASE_STATE_CORRUPT', `lease ${leaseId}: ${error.detail}`);
    throw error;
  }
  if (lease.leaseId !== leaseId) fail('WORKTREE_LEASE_STATE_CORRUPT', `lease key ${leaseId} does not match leaseId`);
  if (typeof record.holderId !== 'string' || !HOLDER_ID_PATTERN.test(record.holderId)) fail('WORKTREE_LEASE_STATE_CORRUPT', `lease ${leaseId} has an invalid holder`);
  if (!Number.isSafeInteger(record.issuedAtMs) || !Number.isSafeInteger(record.expiresAtMs) || record.issuedAtMs < 0 || record.expiresAtMs <= record.issuedAtMs) fail('WORKTREE_LEASE_STATE_CORRUPT', `lease ${leaseId} has invalid expiry`);
  return { lease, holderId: record.holderId, issuedAtMs: record.issuedAtMs, expiresAtMs: record.expiresAtMs };
}
function validateLeaseState(value, repoRoot) {
  const root = repoRootOf(repoRoot);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('WORKTREE_LEASE_STATE_CORRUPT', 'state is not an object');
  if (value.schemaVersion !== LEASE_STATE_SCHEMA_VERSION) fail('WORKTREE_LEASE_STATE_CORRUPT', 'unsupported schemaVersion');
  if (repoRootOf(value.repoRoot) !== root) fail('WORKTREE_LEASE_STATE_CORRUPT', 'state belongs to another repo');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) fail('WORKTREE_LEASE_STATE_CORRUPT', 'invalid revision');
  if (!value.leases || typeof value.leases !== 'object' || Array.isArray(value.leases)) fail('WORKTREE_LEASE_STATE_CORRUPT', 'leases is not an object');
  const state = { schemaVersion: LEASE_STATE_SCHEMA_VERSION, repoRoot: root, revision: value.revision, leases: {} };
  for (const [leaseId, record] of Object.entries(value.leases)) state.leases[leaseId] = validateRecord(leaseId, record, root);
  return state;
}
function readLeaseState(stateFile, { repoRoot, fsImpl = fs } = {}) {
  const file = stateFileOf(stateFile);
  let raw;
  try { raw = fsImpl.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return emptyLeaseState(repoRoot);
    fail('WORKTREE_LEASE_STATE_UNAVAILABLE', `could not read lease state; this does NOT claim the state is absent: ${error && error.message ? error.message : 'read failed'}`);
  }
  try { return validateLeaseState(JSON.parse(raw), repoRoot); }
  catch (error) {
    if (error instanceof WorktreeLeaseStateError) throw error;
    fail('WORKTREE_LEASE_STATE_CORRUPT', 'state is not valid JSON');
  }
}

function lockFileFor(stateFile) { return `${stateFileOf(stateFile)}.lock`; }
function sleepSync(ms) { const block = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(block, 0, 0, ms); }
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error && error.code === 'EPERM') return true;
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}
function readLock(file, fsImpl) {
  let raw;
  try { raw = fsImpl.readFileSync(file, 'utf8'); }
  catch (error) {
    // A vanished lock is a normal create/read race. Any other read failure
    // leaves ownership unknown and must not be collapsed into a stale lock.
    if (error && error.code === 'ENOENT') return null;
    fail('WORKTREE_LEASE_STATE_LOCKED', `cannot inspect lock: ${error && error.message ? error.message : 'read failed'}`);
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { fail('WORKTREE_LEASE_STATE_LOCKED', 'cannot establish lock ownership because the lock is not valid JSON'); }
  if (!value || !Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.atMs) || typeof value.nonce !== 'string') {
    fail('WORKTREE_LEASE_STATE_LOCKED', 'cannot establish lock ownership because the lock record is invalid');
  }
  return value;
}
function acquireLeaseLock(stateFile, { fsImpl = fs, now = () => Date.now(), isAlive = pidAlive, sleep = sleepSync, timeoutMs = 10_000, pid = process.pid } = {}) {
  const lockFile = lockFileFor(stateFile); fsImpl.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = nowMs(now) + timeoutMs;
  const nonce = crypto.randomBytes(12).toString('hex');
  for (;;) {
    // atMs is stamped at the moment the exclusive create succeeds, not when
    // acquisition STARTED: a spin of up to timeoutMs would otherwise age the
    // lock before its critical section even began, shrinking its
    // LOCK_STALE_MS budget by the entire wait.
    const mine = { pid, atMs: nowMs(now), nonce };
    try { fsImpl.writeFileSync(lockFile, JSON.stringify(mine), { encoding: 'utf8', flag: 'wx' }); return { lockFile, ...mine }; }
    catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const holder = readLock(lockFile, fsImpl);
      if (!holder) continue;
      if (!isAlive(holder.pid) || nowMs(now) - holder.atMs > LOCK_STALE_MS) { fsImpl.rmSync(lockFile, { force: true }); continue; }
      if (nowMs(now) >= deadline) fail('WORKTREE_LEASE_STATE_LOCKED', `lock held by pid ${holder.pid}`);
      sleep(10);
    }
  }
}
// A holder suspended mid-mutation past LOCK_STALE_MS has its lock reclaimed
// by a peer as stale. If it then resumes and writes, it silently overwrites
// the peer's committed revision — both sides read the same base revision, so
// the expectedRevision check cannot see it. Every writer therefore re-checks
// that it STILL owns the lock immediately before the atomic swap and aborts
// if the lock was reclaimed. The check-to-rename window is microseconds
// (versus the whole read-mutate-write section before), and entering it
// requires the same 60s suspension that makes the steal possible at all.
function assertStillHeld(lock, fsImpl) {
  const held = readLock(lock.lockFile, fsImpl);
  if (!held || held.pid !== lock.pid || held.nonce !== lock.nonce) {
    fail('WORKTREE_LEASE_STATE_LOCKED', 'mutation lock was reclaimed as stale mid-mutation; aborting instead of overwriting a peer\'s committed state');
  }
}
function releaseLeaseLock(lock, { fsImpl = fs } = {}) { const holder = readLock(lock.lockFile, fsImpl); if (holder && holder.pid === lock.pid && holder.nonce === lock.nonce) fsImpl.rmSync(lock.lockFile, { force: true }); }
function writeLeaseStateAtomic(stateFile, state, { fsImpl = fs } = {}) {
  const file = stateFileOf(stateFile); fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`; let descriptor;
  try {
    descriptor = fsImpl.openSync(temp, 'wx', 0o600); fsImpl.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8'); fsImpl.fsyncSync(descriptor); fsImpl.closeSync(descriptor); descriptor = undefined; fsImpl.renameSync(temp, file);
  } catch (error) { if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch {} try { fsImpl.rmSync(temp, { force: true }); } catch {} throw error; }
}
function activeRecords(state, atMs) { return Object.values(state.leases).filter(record => record.expiresAtMs > atMs); }
function removeExpired(state, atMs) { const expired = []; for (const [leaseId, record] of Object.entries(state.leases)) if (record.expiresAtMs <= atMs) { delete state.leases[leaseId]; expired.push(leaseId); } return expired.sort(); }
function mutateLeaseState(stateFile, { repoRoot, expectedRevision, now = () => Date.now(), fsImpl = fs, mutate } = {}) {
  if (typeof mutate !== 'function') fail('WORKTREE_LEASE_STATE_INVALID', 'mutate must be a function');
  const expected = revisionOf(expectedRevision); const lock = acquireLeaseLock(stateFile, { fsImpl, now });
  try {
    const state = readLeaseState(stateFile, { repoRoot, fsImpl }); if (state.revision !== expected) fail('WORKTREE_LEASE_REVISION_CONFLICT', `expected ${expected}, found ${state.revision}`);
    const outcome = mutate(state, nowMs(now)); if (!outcome || outcome.changed !== true) return { revision: state.revision, result: outcome && outcome.result, state: clone(state) };
    state.revision += 1; assertStillHeld(lock, fsImpl); writeLeaseStateAtomic(stateFile, state, { fsImpl }); return { revision: state.revision, result: outcome.result, state: clone(state) };
  } finally { releaseLeaseLock(lock, { fsImpl }); }
}
function reserveLease(stateFile, proposal, { repoRoot, holderId, expectedRevision, ttlMs = DEFAULT_LEASE_TTL_MS, now = () => Date.now(), fsImpl = fs } = {}) {
  const holder = holderOf(holderId); const ttl = ttlOf(ttlMs);
  return mutateLeaseState(stateFile, { repoRoot, expectedRevision, now, fsImpl, mutate(state, atMs) {
    const expiredLeaseIds = removeExpired(state, atMs);
    const allocation = allocateWorktreeLease(proposal, { repoRoot: state.repoRoot, activeLeases: activeRecords(state, atMs).map(record => record.lease) });
    const record = { lease: allocation.lease, holderId: holder, issuedAtMs: atMs, expiresAtMs: atMs + ttl }; state.leases[allocation.lease.leaseId] = record;
    return { changed: true, result: { lease: clone(allocation.lease), expiresAtMs: record.expiresAtMs, expiredLeaseIds } };
  }});
}
function heartbeatLease(stateFile, { repoRoot, leaseId, holderId, expectedRevision, ttlMs = DEFAULT_LEASE_TTL_MS, now = () => Date.now(), fsImpl = fs } = {}) {
  const holder = holderOf(holderId); const ttl = ttlOf(ttlMs); if (typeof leaseId !== 'string' || !leaseId) fail('WORKTREE_LEASE_STATE_INVALID', 'leaseId is required');
  return mutateLeaseState(stateFile, { repoRoot, expectedRevision, now, fsImpl, mutate(state, atMs) {
    const record = state.leases[leaseId]; if (!record) fail('WORKTREE_LEASE_NOT_FOUND', `lease ${leaseId} does not exist`); if (record.holderId !== holder) fail('WORKTREE_LEASE_HOLDER_MISMATCH', `lease ${leaseId} belongs to another holder`); if (record.expiresAtMs <= atMs) fail('WORKTREE_LEASE_EXPIRED', `lease ${leaseId} expired and cannot be revived`);
    record.expiresAtMs = atMs + ttl; return { changed: true, result: { lease: clone(record.lease), expiresAtMs: record.expiresAtMs } };
  }});
}
function releaseLease(stateFile, { repoRoot, leaseId, holderId, expectedRevision, now = () => Date.now(), fsImpl = fs } = {}) {
  const holder = holderOf(holderId); if (typeof leaseId !== 'string' || !leaseId) fail('WORKTREE_LEASE_STATE_INVALID', 'leaseId is required'); const lock = acquireLeaseLock(stateFile, { fsImpl, now });
  try {
    const state = readLeaseState(stateFile, { repoRoot, fsImpl }); const record = state.leases[leaseId];
    if (!record) return { revision: state.revision, result: { released: false }, state: clone(state) };
    const expected = revisionOf(expectedRevision); if (state.revision !== expected) fail('WORKTREE_LEASE_REVISION_CONFLICT', `expected ${expected}, found ${state.revision}`); if (record.holderId !== holder) fail('WORKTREE_LEASE_HOLDER_MISMATCH', `lease ${leaseId} belongs to another holder`);
    delete state.leases[leaseId]; state.revision += 1; assertStillHeld(lock, fsImpl); writeLeaseStateAtomic(stateFile, state, { fsImpl }); return { revision: state.revision, result: { released: true }, state: clone(state) };
  } finally { releaseLeaseLock(lock, { fsImpl }); }
}
module.exports = { DEFAULT_LEASE_TTL_MS, HOLDER_ID_PATTERN, LEASE_STATE_SCHEMA_VERSION, LOCK_STALE_MS, MAX_LEASE_TTL_MS, WorktreeLeaseStateError, acquireLeaseLock, activeRecords, emptyLeaseState, heartbeatLease, lockFileFor, mutateLeaseState, readLeaseState, releaseLease, releaseLeaseLock, reserveLease, validateLeaseState, writeLeaseStateAtomic };

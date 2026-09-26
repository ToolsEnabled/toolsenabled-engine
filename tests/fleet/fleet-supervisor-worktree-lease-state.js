'use strict';

// Q54 durable lease tests. Every file is in os.tmpdir(); no git worktree or
// live fleet state is touched.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../../src/lib/fleet-supervisor/worktree-lease-state.js');

let checks = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }
function refuses(fn, code, message) { assert.throws(fn, error => error instanceof api.WorktreeLeaseStateError && error.code === code, message); checks += 1; }
function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-worktree-lease-'));
  const stateFile = path.join(root, 'lease-state.json');
  const repoRoot = path.join(root, 'ToolsEnabled');
  const proposal = { phaseId: 'Q54', laneId: 'q54-alpha', ownedPaths: ['src/q54.js'] };
  try {
    const reserve = api.reserveLease(stateFile, proposal, { repoRoot, holderId: 'coordinator-a', expectedRevision: 0, ttlMs: 10_000, now: () => 10_000 });
    equal(reserve.revision, 1, 'new reservation increments revision');
    equal(reserve.result.lease.leaseId, 'Q54.q54-alpha', 'reservation preserves deterministic lease id');
    equal(reserve.result.expiresAtMs, 20_000, 'expiry uses injected time');
    refuses(() => api.reserveLease(stateFile, { phaseId: 'Q55', laneId: 'q55-alpha', ownedPaths: ['src/q55.js'] }, { repoRoot, holderId: 'coordinator-b', expectedRevision: 0, now: () => 10_000 }), 'WORKTREE_LEASE_REVISION_CONFLICT', 'stale CAS cannot reserve');
    equal(api.readLeaseState(stateFile, { repoRoot }).revision, 1, 'failed CAS leaves state intact');

    const heartbeat = api.heartbeatLease(stateFile, { repoRoot, leaseId: 'Q54.q54-alpha', holderId: 'coordinator-a', expectedRevision: 1, ttlMs: 15_000, now: () => 12_000 });
    equal(heartbeat.revision, 2, 'heartbeat is persisted under CAS');
    equal(heartbeat.result.expiresAtMs, 27_000, 'heartbeat extends lease');
    refuses(() => api.heartbeatLease(stateFile, { repoRoot, leaseId: 'Q54.q54-alpha', holderId: 'other-holder', expectedRevision: 2, now: () => 12_000 }), 'WORKTREE_LEASE_HOLDER_MISMATCH', 'other holder cannot renew');

    const released = api.releaseLease(stateFile, { repoRoot, leaseId: 'Q54.q54-alpha', holderId: 'coordinator-a', expectedRevision: 2, now: () => 12_000 });
    equal(released.revision, 3, 'release increments revision'); equal(released.result.released, true, 'release removes lease');
    const retry = api.releaseLease(stateFile, { repoRoot, leaseId: 'Q54.q54-alpha', holderId: 'coordinator-a', expectedRevision: 2, now: () => 12_000 });
    equal(retry.revision, 3, 'lost-response release retry is idempotent'); equal(retry.result.released, false, 'idempotent no-op is explicit');

    const expiring = api.reserveLease(stateFile, { phaseId: 'Q55', laneId: 'q55-alpha', ownedPaths: ['src/q55.js'] }, { repoRoot, holderId: 'coordinator-a', expectedRevision: 3, ttlMs: 1_000, now: () => 30_000 });
    equal(expiring.revision, 4, 'next reservation is durable');
    refuses(() => api.heartbeatLease(stateFile, { repoRoot, leaseId: 'Q55.q55-alpha', holderId: 'coordinator-a', expectedRevision: 4, now: () => 31_000 }), 'WORKTREE_LEASE_EXPIRED', 'expired lease cannot be revived');
    const replaceExpired = api.reserveLease(stateFile, { phaseId: 'Q56', laneId: 'q56-alpha', ownedPaths: ['src/q56.js'] }, { repoRoot, holderId: 'coordinator-b', expectedRevision: 4, now: () => 31_000 });
    equal(replaceExpired.revision, 5, 'expiry cleanup and reserve are one revision'); assert.deepEqual(replaceExpired.result.expiredLeaseIds, ['Q55.q55-alpha'], 'expired claim is surfaced explicitly'); checks += 1;

    const corrupt = path.join(root, 'corrupt.json'); fs.writeFileSync(corrupt, '{nope', 'utf8');
    refuses(() => api.readLeaseState(corrupt, { repoRoot }), 'WORKTREE_LEASE_STATE_CORRUPT', 'partial/corrupt state refuses rather than resetting');
    const busyState = path.join(root, 'busy.json');
    fs.writeFileSync(busyState, JSON.stringify({ schemaVersion: 1, repoRoot, revision: 7, leases: {} }), 'utf8');
    let busyReads = 0;
    const busyFs = Object.create(fs);
    busyFs.readFileSync = (file, ...args) => {
      busyReads += 1;
      if (busyReads === 1) { const error = new Error('simulated busy filesystem'); error.code = 'EIO'; throw error; }
      return fs.readFileSync(file, ...args);
    };
    assert.throws(() => api.readLeaseState(busyState, { repoRoot, fsImpl: busyFs }), error =>
      error instanceof api.WorktreeLeaseStateError && error.code === 'WORKTREE_LEASE_STATE_UNAVAILABLE' && /NOT claim.*absent/.test(error.detail),
    'a transient read failure reports could-not-tell rather than corrupt or absent'); checks += 1;
    equal(api.readLeaseState(busyState, { repoRoot, fsImpl: busyFs }).revision, 7, 'a could-not-tell result is not cached or latched');
    const absentState = path.join(root, 'absent.json');
    equal(api.readLeaseState(absentState, { repoRoot }).revision, 0, 'control: ENOENT retains the legitimate absent-state answer');
    const foreign = path.join(root, 'foreign.json'); fs.writeFileSync(foreign, JSON.stringify({ schemaVersion: 1, repoRoot: path.join(root, 'other'), revision: 0, leases: {} }), 'utf8');
    refuses(() => api.readLeaseState(foreign, { repoRoot }), 'WORKTREE_LEASE_STATE_CORRUPT', 'foreign repo state cannot be reused');

    const unreadableState = path.join(root, 'unreadable-lock-state.json');
    const unreadableLock = `${unreadableState}.lock`;
    fs.writeFileSync(unreadableLock, JSON.stringify({ pid: process.pid, atMs: 10_000, nonce: 'owner' }), 'utf8');
    const unreadableFs = Object.create(fs);
    unreadableFs.readFileSync = (file, ...args) => {
      if (file === unreadableLock) { const error = new Error('simulated lock I/O failure'); error.code = 'EIO'; throw error; }
      return fs.readFileSync(file, ...args);
    };
    refuses(() => api.acquireLeaseLock(unreadableState, { fsImpl: unreadableFs, now: () => 10_000 }), 'WORKTREE_LEASE_STATE_LOCKED', 'an unreadable lock refuses instead of being reclaimed as stale');
    equal(fs.existsSync(unreadableLock), true, 'an unreadable lock is not deleted');

    const malformedState = path.join(root, 'malformed-lock-state.json');
    const malformedLock = `${malformedState}.lock`; fs.writeFileSync(malformedLock, '{nope', 'utf8');
    refuses(() => api.acquireLeaseLock(malformedState, { now: () => 10_000 }), 'WORKTREE_LEASE_STATE_LOCKED', 'a malformed lock refuses instead of being reclaimed as stale');
    equal(fs.existsSync(malformedLock), true, 'a malformed lock is not deleted');

    const staleState = path.join(root, 'undeletable-stale-lock-state.json');
    const staleLock = `${staleState}.lock`; fs.writeFileSync(staleLock, JSON.stringify({ pid: 999_999, atMs: 1, nonce: 'stale' }), 'utf8');
    const undeletableFs = Object.create(fs);
    undeletableFs.rmSync = file => { if (file === staleLock) { const error = new Error('simulated lock removal failure'); error.code = 'EACCES'; throw error; } return fs.rmSync(file); };
    assert.throws(() => api.acquireLeaseLock(staleState, { fsImpl: undeletableFs, isAlive: () => false, now: () => 100_000 }), error => error && error.code === 'EACCES', 'failure to remove a stale lock is propagated instead of retried forever'); checks += 1;

    const releaseState = path.join(root, 'undeletable-release-lock-state.json');
    const releaseLock = `${releaseState}.lock`; const ownedLock = { lockFile: releaseLock, pid: process.pid, atMs: 10_000, nonce: 'mine' };
    fs.writeFileSync(releaseLock, JSON.stringify(ownedLock), 'utf8');
    const unreleasableFs = Object.create(fs);
    unreleasableFs.rmSync = file => { if (file === releaseLock) { const error = new Error('simulated release failure'); error.code = 'EACCES'; throw error; } return fs.rmSync(file); };
    assert.throws(() => api.releaseLeaseLock(ownedLock, { fsImpl: unreleasableFs }), error => error && error.code === 'EACCES', 'failure to release an owned lock is propagated instead of reporting completion'); checks += 1;

    // Race two isolated Node processes with the same expected revision. One
    // must win, the other must observe a typed CAS conflict; both exit cleanly.
    const raceFile = path.join(root, 'race.json'); const worker = path.join(root, 'race-worker.js');
    const moduleFile = path.resolve(__dirname, '..', '..', 'src', 'lib', 'fleet-supervisor', 'worktree-lease-state.js');
    fs.writeFileSync(worker, [
      `const api = require(${JSON.stringify(moduleFile)});`,
      "try { const r = api.reserveLease(process.argv[2], { phaseId: 'Q57', laneId: process.argv[3], ownedPaths: ['src/' + process.argv[3] + '.js'] }, { repoRoot: process.argv[4], holderId: process.argv[3], expectedRevision: 0, now: () => 50000 }); console.log(JSON.stringify({ok:true,revision:r.revision})); } catch (e) { console.log(JSON.stringify({ok:false,code:e.code || null})); }"
    ].join('\n'), 'utf8');
    const results = await Promise.all([capture(process.execPath, [worker, raceFile, 'q57-a', repoRoot]), capture(process.execPath, [worker, raceFile, 'q57-b', repoRoot])]);
    const outcomes = results.map(result => { equal(result.code, 0, 'race worker exits normally'); return JSON.parse(result.stdout.trim()); });
    equal(outcomes.filter(item => item.ok).length, 1, 'exactly one concurrent reservation wins');
    equal(outcomes.filter(item => item.code === 'WORKTREE_LEASE_REVISION_CONFLICT').length, 1, 'the other concurrent reservation gets CAS conflict');
    const raceState = api.readLeaseState(raceFile, { repoRoot }); equal(raceState.revision, 1, 'race writes one complete revision'); equal(Object.keys(raceState.leases).length, 1, 'race cannot duplicate active claim');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log(`Fleet worktree lease-state tests passed (${checks} checks; temp paths only, no worktrees).`);
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

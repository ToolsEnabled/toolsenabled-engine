'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const {
  DEFAULT_STALENESS_MS, STALLED_PREFIX, lastGateMovementAt,
  projectRequestStatus, projectRequestStatuses, selectGatesMetStatusNotDone, observeLiveRequestOwnership
} = require('../src/lib/owner-request-status-projection');
const presence = require('../src/lib/agent-presence');

const NOW = Date.parse('2026-08-07T12:00:00.000Z');
const OBSERVED = NOW - 1000;
const oldGate = { id: 'R1', status: 'in-progress', gates: [{ met: false }], captureLog: [{ at: '2026-07-28T11:00:00.000Z', gatesAdded: 1 }] };

let presenceSequence = 0;
function presenceRecord(agentId, overrides = {}) {
  presenceSequence += 1;
  return presence.normalizeRecord({
    agentId,
    runId: `11111111-1111-4111-8111-${String(presenceSequence).padStart(12, '0')}`,
    recordRevision: 1,
    kind: 'codex', role: 'worker', tier: 'gpt-5.6-terra', reportsTo: 'manager', dispatcher: 'manager',
    lane: 'fixture', territory: 'tests/**', currentTask: null, brief: 'brief', consoleLog: 'log', worktree: 'worktree', launchSpec: 'spec',
    pid: null, startedAt: NOW - 1_000, lastHeartbeat: NOW - 1_000, status: 'running', exitCode: null, lastVerdict: null, terminalAt: null,
    staleReason: null, usefulProgressSeq: 0, lastUsefulProgressAt: null, lastUsefulProgressKind: null, mailboxOffset: 0, respawnCount: 0,
    verdictConsumedAt: null,
    ...overrides
  });
}

function presenceRegistry(records) {
  return { schemaVersion: presence.SCHEMA_VERSION, revision: 1, updatedAt: NOW, agents: Object.fromEntries(records.map(record => [record.agentId, record])) };
}

function assertSideEffectFreeRefusal(invoke, code) {
  let writes = 0;
  let spawns = 0;
  const originalWriteFileSync = fs.writeFileSync;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  fs.writeFileSync = () => { writes += 1; };
  childProcess.spawn = () => { spawns += 1; };
  childProcess.spawnSync = () => { spawns += 1; };
  try {
    assert.throws(invoke, error => {
      assert.equal(error && error.constructor, TypeError);
      assert.equal(error.message, code);
      return true;
    });
    assert.equal(writes, 0, `${code} must refuse before writing`);
    assert.equal(spawns, 0, `${code} must refuse before spawning`);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }
}

function run() {
  let checks = 0;
  assert.equal(DEFAULT_STALENESS_MS, 10 * 24 * 60 * 60 * 1000); checks += 1;
  assert.equal(lastGateMovementAt({ captureLog: [{ at: '2026-08-01T00:00:00.000Z', gatesAdded: 0 }, { at: '2026-08-02T00:00:00.000Z', gatesAdded: 3 }] }), '2026-08-02T00:00:00.000Z'); checks += 1;
  assert.throws(
    () => lastGateMovementAt({ captureLog: [{ at: 'bad', gatesAdded: 2 }, { at: '2026-08-02T00:00:00.000Z', gatesAdded: 3 }] }),
    /OWNER_STATUS_PROJECTION_INVALID_GATE_MOVEMENT_AT:0/,
    'an unreadable movement timestamp must not be collapsed into an older definite answer'
  ); checks += 1;
  const stalled = projectRequestStatus(oldGate, { nowMs: NOW, ownershipObservedAtMs: OBSERVED, liveOwnerRequestIds: [] });
  assert.equal(stalled.status, 'in-progress', 'the ledger status is retained unchanged'); checks += 1;
  assert.equal(stalled.statusLabel, 'in-progress'); checks += 1;
  assert.equal(stalled.stale, true); checks += 1;
  assert.equal(stalled.derivedLabel, `${STALLED_PREFIX}2026-07-28`); checks += 1;
  assert.equal(projectRequestStatus(oldGate, { nowMs: NOW, ownershipObservedAtMs: OBSERVED, liveOwnerRequestIds: ['R1'] }).derivedLabel, null, 'an observed live owner blocks the label'); checks += 1;
  assert.equal(projectRequestStatus(oldGate, { nowMs: NOW }).derivedLabel, null, 'missing ownership evidence is not silently treated as no owner'); checks += 1;
  assert.equal(projectRequestStatus({ ...oldGate, status: 'done' }, { nowMs: NOW, ownershipObservedAtMs: OBSERVED }).derivedLabel, null, 'terminal status is never relabelled stalled'); checks += 1;
  assert.equal(projectRequestStatus({ id: 'R2', status: 'open', gates: [] }, { nowMs: NOW, ownershipObservedAtMs: OBSERVED }).derivedLabel, null, 'no timestamped gate history is insufficient evidence'); checks += 1;
  assert.equal(projectRequestStatus({ ...oldGate, captureLog: [{ at: '2026-08-01T12:00:01.000Z', gatesAdded: 1 }] }, { nowMs: NOW, ownershipObservedAtMs: OBSERVED }).derivedLabel, null, 'movement inside the window is not stalled'); checks += 1;
  assert.throws(() => projectRequestStatuses([{ id: 'R3', status: 'open' }], { nowMs: NOW, stalenessMs: 0 }), /INVALID_OPTIONS/); checks += 1;
  assertSideEffectFreeRefusal(
    () => projectRequestStatus(oldGate, null),
    'OWNER_STATUS_PROJECTION_INVALID_OPTIONS'
  ); checks += 1;
  assertSideEffectFreeRefusal(
    () => projectRequestStatus(oldGate, { ownershipObservedAtMs: -1 }),
    'OWNER_STATUS_PROJECTION_INVALID_OWNERSHIP_OBSERVATION'
  ); checks += 1;
  assertSideEffectFreeRefusal(
    () => projectRequestStatus(oldGate, { liveOwnerRequestIds: ['R1', 2] }),
    'OWNER_STATUS_PROJECTION_INVALID_LIVE_OWNERS'
  ); checks += 1;
  assertSideEffectFreeRefusal(
    () => projectRequestStatuses(undefined),
    'OWNER_STATUS_PROJECTION_INVALID_REQUESTS'
  ); checks += 1;
  assertSideEffectFreeRefusal(
    () => observeLiveRequestOwnership(presenceRegistry([]), []),
    'OWNER_STATUS_PROJECTION_INVALID_PRESENCE_OPTIONS'
  ); checks += 1;
  const reconciliation = selectGatesMetStatusNotDone([
    { id: 'R4', status: 'open', gates: [{ met: true }] },
    { id: 'R5', status: 'done', gates: [{ met: true }] },
    { id: 'R6', status: 'open', gates: [] },
    { id: 'R7', status: 'open', gates: [{ met: true }, { met: false }] },
    // resolve() (2026-09-07) gave 'superseded' and 'not-possible-as-asked' a
    // writer for the first time; both are terminal, exactly like 'done', so a
    // record already resolved to one must not be flagged as "gates met, still
    // waiting to be marked done" -- that reconciliation nudge is for a record
    // nobody has finished deciding about yet, and these already were.
    { id: 'R8', status: 'superseded', gates: [{ met: true }] },
    { id: 'R9', status: 'not-possible-as-asked', gates: [{ met: true }] }
  ]);
  assert.deepEqual(reconciliation, [{ id: 'R4', status: 'open', gateCount: 1 }],
    'a superseded or not-possible-as-asked record is already terminal and must not reconcile as gates-met-not-done'); checks += 1;

  const zeroLive = observeLiveRequestOwnership(presenceRegistry([]), { nowMs: NOW });
  assert.equal(zeroLive.coverage, 'complete'); checks += 1;
  assert.deepEqual(zeroLive.liveOwnerRequestIds, []); checks += 1;
  const rBound = observeLiveRequestOwnership(presenceRegistry([presenceRecord('worker-r', { directiveId: 'R1162.1' })]), { nowMs: NOW });
  assert.equal(rBound.coverage, 'complete'); checks += 1;
  assert.deepEqual(rBound.liveOwnerRequestIds, ['R1162.1']); checks += 1;
  const qBound = observeLiveRequestOwnership(presenceRegistry([presenceRecord('worker-q', { directiveId: 'Q27' })]), { nowMs: NOW });
  assert.equal(qBound.coverage, 'complete'); checks += 1;
  assert.equal(qBound.qBoundLiveCount, 1); checks += 1;
  assert.deepEqual(qBound.liveOwnerRequestIds, []); checks += 1;
  const staleDead = observeLiveRequestOwnership(presenceRegistry([presenceRecord('worker-dead', { pid: 42, lastHeartbeat: 0 })]), {
    nowMs: NOW, staleMs: 1_000, isAlive: () => false
  });
  assert.equal(staleDead.coverage, 'complete'); checks += 1;
  assert.equal(staleDead.liveRecordCount, 0); checks += 1;
  const unbound = observeLiveRequestOwnership(presenceRegistry([presenceRecord('worker-unbound')]), { nowMs: NOW });
  assert.equal(unbound.coverage, 'partial'); checks += 1;
  assert.equal(unbound.ownershipObservedAtMs, null); checks += 1;
  assert.equal(unbound.unboundLiveCount, 1); checks += 1;
  const mixed = observeLiveRequestOwnership(presenceRegistry([
    presenceRecord('worker-mixed-r', { directiveId: 'R1162.2' }),
    presenceRecord('worker-mixed-unbound')
  ]), { nowMs: NOW });
  assert.equal(mixed.coverage, 'partial'); checks += 1;
  assert.deepEqual(mixed.liveOwnerRequestIds, [], 'partial coverage never exposes a misleading ownership subset'); checks += 1;
  console.log(`owner-request-status-projection tests passed (${checks} checks).`);
}

run();

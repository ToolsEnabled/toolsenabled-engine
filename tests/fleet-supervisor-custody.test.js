'use strict';

require('./lib/isolated-environment').activate('fleet-consumer-custody');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const stateStore = require('../src/lib/fleet-supervisor/state');
const worktrees = require('../src/lib/fleet-supervisor/worktree');
const review = require('../src/lib/fleet-supervisor/review');
const planning = require('../src/lib/fleet-supervisor/planning');
const laneRunner = require('../src/lib/fleet-supervisor/lane-runner');
const queue = require('../src/lib/fleet-supervisor/queue');
const { FleetSupervisor, claimNext, recordLaneStarted, recordLaneOutcome, reconcile,
  occupiedSlots, expandClaimableItems } = require('../src/lib/fleet-supervisor/supervisor');

const UNKNOWN = { ok: false, code: 'CLEANUP_UNPROVEN', cleanupConfirmed: false, detail: 'Fixture has no native cleanup proof.' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-custody-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const queueFile = path.join(root, 'BUILD-QUEUE.md');
  const text = '# BUILD-QUEUE\n\n## Builder protocol (read once per loop)\n\nLowest open.\n\n---\n\n## Q1 - Fixture\n\n**Status:** OPEN\nBuild a fixture.\n';
  fs.writeFileSync(queueFile, text);
  return { root, stateFile, queueFile, phase: queue.parseBuildQueue(text)[0], protocol: queue.builderProtocol(text) };
}
function claim(file, laneId = 'fixture-lane', itemId = 'Q1') {
  return claimNext(file, { openItemIds: [itemId], laneId, supervisorId: 'fixture-supervisor',
    concurrency: 8, maxAttempts: 8, maxNoProgressAttempts: 8 });
}
function seedHold(file, { status = 'unknown', pidKind = null, explicitOutcome = true } = {}) {
  claim(file);
  recordLaneStarted(file, 'fixture-lane', { pid: 912345, worktree: '/fixture-only/worktree' });
  stateStore.withState(file, state => {
    const lane = state.lanes['fixture-lane'];
    lane.status = status;
    if (pidKind) lane.pidKind = pidKind;
    if (explicitOutcome) lane.outcome = { ...UNKNOWN };
    lane.orphanWatch = status === 'unknown';
    const item = state.items.Q1;
    item.condition = status === 'failed' ? 'idle' : 'orphaned';
    item.claimedByLaneId = status === 'failed' ? null : lane.laneId;
    return { state };
  });
}
function supervisor(f, extra = {}) {
  return new FleetSupervisor({ repoRoot: f.root, stateFile: f.stateFile, queueFile: f.queueFile,
    concurrency: 1, isAlive: () => false, killSwitch: { status: () => ({ active: false }) },
    ...extra });
}
function worktreeSeam(t, f, calls) {
  let lanePath;
  t.mock.method(worktrees, 'createLaneWorktree', laneId => {
    lanePath = path.join(f.root, 'worktrees', laneId);
    fs.mkdirSync(lanePath, { recursive: true });
    fs.writeFileSync(path.join(lanePath, 'retained.txt'), 'custody fixture');
    return { path: lanePath, marker: {} };
  });
  t.mock.method(worktrees, 'materializeWorkingTree', () => ({ complete: true, trackedExpected: [], trackedMissing: [], untrackedSkipped: [] }));
  t.mock.method(worktrees, 'captureBaselineTree', () => 'fixture-baseline');
  t.mock.method(worktrees, 'missingBriefedInputs', () => []);
  t.mock.method(worktrees, 'changedSinceBaseline', () => { calls.push('measure'); return 1; });
  t.mock.method(review, 'capturePacket', () => { calls.push('capture'); return { ok: true, dir: path.join(f.root, 'packet') }; });
  t.mock.method(worktrees, 'removeLaneWorktree', target => {
    calls.push('remove'); fs.rmSync(target, { recursive: true, force: true }); return { removed: true };
  });
  return () => lanePath;
}

test('an unproven lane is held without converting unknown effects into failure, progress, or retry', t => {
  const f = fixture(t);
  claim(f.stateFile);
  recordLaneStarted(f.stateFile, 'fixture-lane', { pid: 912345, worktree: path.join(f.root, 'lane') });
  recordLaneOutcome(f.stateFile, 'fixture-lane', { ...UNKNOWN, changedFileCount: 99, maxAttempts: 8, maxNoProgressAttempts: 8 });
  let state = stateStore.readState(f.stateFile);
  const lane = state.lanes['fixture-lane'];
  assert.equal(lane.status, 'unknown');
  assert.equal(lane.orphanWatch, true);
  assert.equal(lane.changedFileCount, null);
  assert.equal(state.items.Q1.condition, 'parked');
  assert.equal(state.items.Q1.claimedByLaneId, lane.laneId);
  assert.equal(state.items.Q1.noProgressAttempts, 0);
  assert.equal(state.items.Q1.attempts, 1);
  assert.equal(occupiedSlots(state), 1);
  assert.equal(claim(f.stateFile, 'retry').claimed, null);
  assert.equal(review.claimLaneForReview(f.stateFile, { supervisorId: 'reviewer', isAlive: () => false }).claimed, null);
  recordLaneOutcome(f.stateFile, 'fixture-lane', { ok: true, changedFileCount: 1 });
  recordLaneStarted(f.stateFile, 'fixture-lane', { pid: 912346 });
  state = stateStore.readState(f.stateFile);
  assert.equal(state.lanes['fixture-lane'].status, 'unknown', 'a late ordinary result cannot release an existing custody hold');
  const contradictory = fixture(t);
  claim(contradictory.stateFile);
  recordLaneOutcome(contradictory.stateFile, 'fixture-lane', { ok: true, cleanupConfirmed: false, changedFileCount: 1 });
  assert.equal(stateStore.readState(contradictory.stateFile).lanes['fixture-lane'].status, 'unknown');
});

for (const priorStatus of ['unknown', 'failed']) test(`restart retains ${priorStatus} cleanup uncertainty even when the wrapper PID is gone`, t => {
  const f = fixture(t);
  seedHold(f.stateFile, { status: priorStatus });
  for (let restart = 0; restart < 2; restart += 1) {
    reconcile(f.stateFile, { supervisorId: `restart-${restart}`, isAlive: () => false });
    const state = stateStore.readState(f.stateFile);
    assert.equal(state.lanes['fixture-lane'].status, 'unknown');
    assert.equal(state.lanes['fixture-lane'].orphanWatch, true);
    assert.equal(state.items.Q1.condition, 'parked');
    assert.equal(claim(f.stateFile, `retry-${restart}`).claimed, null);
  }
});

test('a dead native wrapper is not descendant cleanup proof during crash reconciliation', t => {
  const f = fixture(t);
  seedHold(f.stateFile, { status: 'running', pidKind: 'native-wrapper', explicitOutcome: false });
  reconcile(f.stateFile, { supervisorId: 'restarted', isAlive: () => false });
  const state = stateStore.readState(f.stateFile);
  assert.equal(state.lanes['fixture-lane'].orphanWatch, true);
  assert.equal(state.items.Q1.condition, 'parked');
  assert.equal(claim(f.stateFile, 'retry').claimed, null);
});

test('legacy unproven outcomes survive pruning and refuse direct claims before reconciliation', t => {
  const f = fixture(t);
  seedHold(f.stateFile, { status: 'failed' });
  const state = stateStore.readState(f.stateFile);
  state.lanes.old = { laneId: 'old', status: 'failed', endedAt: '2020-01-01' };
  stateStore.pruneLanes(state, 0);
  assert.ok(state.lanes['fixture-lane'], 'a persisted unproven outcome is not disposable terminal history');
  assert.equal(state.lanes.old, undefined, 'ordinary terminal history remains prunable');
  assert.equal(claim(f.stateFile, 'retry').claimed, null, 'an idle item cannot bypass its old custody hold');
});

test('cleanup holds refuse overlapping whole-phase and subtask claims while allowing independent work', t => {
  for (const [heldItem, candidate] of [['Q1::s1', 'Q1'], ['Q1', 'Q1::s1']]) {
    const f = fixture(t);
    claim(f.stateFile, 'held', heldItem);
    recordLaneOutcome(f.stateFile, 'held', UNKNOWN);
    assert.equal(claim(f.stateFile, 'overlap', candidate).claimed, null);
    assert.ok(claim(f.stateFile, 'independent', 'Q2').claimed);
  }
  const f = fixture(t);
  claim(f.stateFile, 'held', 'Q1::s1');
  recordLaneOutcome(f.stateFile, 'held', UNKNOWN);
  assert.ok(claim(f.stateFile, 'sibling', 'Q1::s2').claimed, 'separate subtasks retain their existing parallel scheduling');
});

test('another supervisor preserves a live owner starting lane before native admission reports a PID', t => {
  const f = fixture(t);
  claim(f.stateFile);
  reconcile(f.stateFile, { supervisorId: 'another-supervisor', isAlive: pid => pid === process.pid });
  let state = stateStore.readState(f.stateFile);
  assert.equal(state.lanes['fixture-lane'].status, 'starting');
  assert.equal(state.items.Q1.condition, 'claimed');
  assert.equal(claim(f.stateFile, 'duplicate').claimed, null);
  recordLaneStarted(f.stateFile, 'fixture-lane', { pid: 912345, pidKind: 'native-wrapper' });
  recordLaneOutcome(f.stateFile, 'fixture-lane', { ok: false, code: 'EXIT_NONZERO', cleanupConfirmed: true,
    changedFileCount: 0, maxAttempts: 8, maxNoProgressAttempts: 8 });
  state = stateStore.readState(f.stateFile);
  assert.equal(state.lanes['fixture-lane'].status, 'failed');
  assert.ok(claim(f.stateFile, 'retry-after-proof').claimed);
});

test('proven failure, never-started refusal, and legacy process orphan retain their prior retry behavior', t => {
  for (const [index, code] of ['EXIT_NONZERO', 'SPAWN_FAILED'].entries()) {
    const f = fixture(t);
    claim(f.stateFile);
    recordLaneOutcome(f.stateFile, 'fixture-lane', { ok: false, code, cleanupConfirmed: true,
      changedFileCount: 0, maxAttempts: 8, maxNoProgressAttempts: 8 });
    assert.equal(stateStore.readState(f.stateFile).lanes['fixture-lane'].status, 'failed');
    assert.ok(claim(f.stateFile, `retry-${index}`).claimed);
  }
  const f = fixture(t);
  seedHold(f.stateFile, { status: 'running', pidKind: 'process', explicitOutcome: false });
  reconcile(f.stateFile, { supervisorId: 'restart', isAlive: () => false });
  assert.equal(stateStore.readState(f.stateFile).items.Q1.condition, 'idle');
});

test('the real spawn refusal remains a never-started retry and planning fallback without a native scope', async t => {
  const f = fixture(t);
  const priorFence = process.env.TOOLSENABLED_REFUSE_PROVIDER_SPAWN;
  process.env.TOOLSENABLED_REFUSE_PROVIDER_SPAWN = '1';
  t.after(() => {
    if (priorFence === undefined) delete process.env.TOOLSENABLED_REFUSE_PROVIDER_SPAWN;
    else process.env.TOOLSENABLED_REFUSE_PROVIDER_SPAWN = priorFence;
  });
  assert.equal(process.env.TOOLSENABLED_REFUSE_PROVIDER_SPAWN, '1', 'the isolated test must prohibit all provider launches');
  let started = 0, scratch;
  const runner = options => laneRunner.runLane({ ...options,
    buildEnvironment: () => ({ env: {}, home: null, billing: { backend: 'fixture' } }),
    buildOnboardingPacket: () => 'Fixture',
    resolveExecutable: () => ({ command: process.execPath, prefixArgs: [] }), execImpl: () => '' });
  claim(f.stateFile);
  const result = await runner({ laneId: path.basename(f.root), itemId: 'Q1', cwd: f.root,
    brief: 'Must not spawn.', onStart: () => { started += 1; } });
  assert.equal(started, 0);
  assert.equal(result.code, 'SPAWN_THREW');
  assert.equal(result.cleanupConfirmed, false, 'no native cleanup receipt exists because the refusal preceded spawn');
  recordLaneOutcome(f.stateFile, 'fixture-lane', result);
  const lane = stateStore.readState(f.stateFile).lanes['fixture-lane'];
  assert.equal(lane.status, 'failed');
  assert.equal(lane.outcome.neverLaunched, true);
  assert.ok(claim(f.stateFile, 'retry').claimed);
  const plan = await planning.planPhase(f.phase, f.protocol, { repoRoot: f.root,
    runPlanningLane: options => { scratch = options.cwd; return runner(options); } });
  assert.equal(plan.status, 'fallback');
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(stateStore.hasUnprovenCleanup({ code: 'SPAWN_THREW', cleanupConfirmed: false, cleanupUnproven: true }), true);
  assert.equal(stateStore.hasUnprovenCleanup({ code: 'SPAWN_THREW', cleanupConfirmed: false, outcome: UNKNOWN }), true,
    'an explicit custody hold dominates a contradictory never-started label');
});

for (const thrown of [false, true]) test(`builder ${thrown ? 'throws' : 'returns'} unknown cleanup without measuring, capturing, or removing its worktree`, async t => {
  const f = fixture(t), calls = [];
  const lanePath = worktreeSeam(t, f, calls);
  let launched = 0;
  const runner = options => {
    launched += 1; options.onStart(912345);
    if (thrown) throw Object.assign(new Error('No cleanup proof.'), { code: 'CLEANUP_UNPROVEN' });
    return { ...UNKNOWN, retainedScratch: { briefFile: path.join(f.root, 'brief'), laneHome: path.join(f.root, 'home') } };
  };
  const first = supervisor(f, { runLane: runner, review: { enabled: true, runReviewer: () => { calls.push('review'); return {}; } } });
  await first.tick(); await first.drain();
  assert.deepEqual(calls, [], 'unknown custody prohibits all post-run worktree operations');
  assert.equal(fs.existsSync(path.join(lanePath(), 'retained.txt')), true);
  if (!thrown) {
    const lane = Object.values(stateStore.readState(f.stateFile).lanes)[0];
    assert.deepEqual(lane.outcome.retainedScratch, { briefFile: path.join(f.root, 'brief'), laneHome: path.join(f.root, 'home') });
  }
  const next = supervisor(f, { runLane: runner });
  await next.tick(); await next.drain();
  assert.equal(launched, 1, 'restart cannot duplicate a lane whose cleanup remains unproven');
});

for (const thrown of [false, true]) test(`a hold recorded during the runner await survives an ordinary ${thrown ? 'exception' : 'result'} without worktree effects`, async t => {
  const f = fixture(t), calls = [];
  const lanePath = worktreeSeam(t, f, calls);
  const first = supervisor(f, { runLane: async input => {
    input.onStart(912345, { pidKind: 'native-wrapper' });
    await Promise.resolve();
    reconcile(f.stateFile, { supervisorId: 'another-supervisor', isAlive: () => false });
    if (thrown) throw new Error('Ordinary runner exception after a durable custody hold.');
    return { ok: false, code: 'EXIT_NONZERO', cleanupConfirmed: true };
  }, review: { enabled: true } });
  await first.tick(); await first.drain();
  assert.deepEqual(calls, [], 'a durable hold observed after await forbids measurement, review capture and disposal');
  assert.equal(fs.existsSync(path.join(lanePath(), 'retained.txt')), true);
  const lane = Object.values(stateStore.readState(f.stateFile).lanes)[0];
  assert.equal(lane.status, 'unknown');
  assert.equal(lane.outcome.code, 'CLEANUP_UNPROVEN');
});

for (const thrown of [false, true]) test(`planner ${thrown ? 'throws' : 'returns'} unknown cleanup and retains scratch instead of exposing fallback`, async t => {
  const f = fixture(t);
  let scratch;
  const result = await planning.planPhase(f.phase, f.protocol, { repoRoot: f.root, runPlanningLane: options => {
    scratch = options.cwd;
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    fs.writeFileSync(path.join(scratch, 'retained.txt'), 'planner fixture');
    if (thrown) throw Object.assign(new Error('No cleanup proof.'), { code: 'CLEANUP_UNPROVEN' });
    return { ...UNKNOWN };
  } });
  assert.equal(fs.existsSync(path.join(scratch, 'retained.txt')), true);
  assert.equal(result.status, 'unknown');
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.scratch, scratch);
});

test('a planning cleanup hold prevents replanning and whole-phase or subtask claims after restart', async t => {
  const f = fixture(t), calls = [];
  worktreeSeam(t, f, calls);
  let planned = 0, built = 0, scratch;
  const options = { runLane: () => { built += 1; return { ok: false, code: 'SPAWN_FAILED' }; }, planning: {
    enabled: true, runPlanningLane: input => {
      planned += 1; scratch = input.cwd;
      t.after(() => fs.rmSync(input.cwd, { recursive: true, force: true }));
      return { ...UNKNOWN };
    }
  } };
  const first = supervisor(f, options);
  await first.tick(); await first.drain();
  const state = stateStore.readState(f.stateFile);
  assert.equal(built, 0, 'a possibly live planner cannot fall through to a whole-phase builder');
  assert.equal(state.plans.Q1.status, 'unknown');
  assert.equal(state.plans.Q1.scratch, scratch);
  assert.equal(state.items.Q1.condition, 'parked');
  assert.equal(first.planningIsRetryable(state.plans.Q1), false);
  assert.equal(first.status().planning.healthy, false);
  assert.deepEqual(first.status().planning.cleanupHeldPhases, ['Q1']);
  assert.deepEqual(expandClaimableItems([f.phase], state.plans, { planningEnabled: false }).ids, []);
  for (const planningEnabled of [true, false]) {
    const next = supervisor(f, { ...options, planning: { ...options.planning, enabled: planningEnabled } });
    await next.tick(); await next.drain();
  }
  assert.equal(planned, 1);
  assert.equal(built, 0);
  assert.equal(claim(f.stateFile, 'whole-retry').claimed, null);
  assert.equal(claim(f.stateFile, 'subtask-retry', 'Q1::s1').claimed, null);
});

test('planning rereads durable plan and lane custody before every invocation after an await', async t => {
  for (const holdKind of ['plan', 'lane']) {
    const f = fixture(t);
    const phases = [f.phase, { ...f.phase, id: 'Q2', number: 2 }];
    const started = [];
    const instance = supervisor(f, { planning: { enabled: true, maxPerTick: 2,
      runPlanningLane: async input => {
        started.push(input.itemId);
        if (input.itemId === 'Q1') {
          await Promise.resolve();
          if (holdKind === 'plan') {
            stateStore.withState(f.stateFile, state => {
              state.plans.Q2 = { phaseId: 'Q2', status: 'unknown', ...UNKNOWN };
              return { state };
            });
          } else {
            claim(f.stateFile, 'held-builder', 'Q2::s1');
            recordLaneOutcome(f.stateFile, 'held-builder', UNKNOWN);
          }
        }
        return { ok: false, code: 'SPAWN_FAILED', cleanupConfirmed: true };
      }
    } });
    await instance.ensurePlans(phases, f.protocol);
    assert.deepEqual(started, ['Q1'], `a newly durable ${holdKind} hold must prevent the next planner call`);
  }
});

test('ordinary planner unavailability and incoherence keep their existing fallback and scratch cleanup', async t => {
  for (const result of [{ ok: false, code: 'SPAWN_FAILED' }, { ok: true, response: 'not a plan' }]) {
    const f = fixture(t);
    let scratch;
    const plan = await planning.planPhase(f.phase, f.protocol, { repoRoot: f.root,
      runPlanningLane: options => { scratch = options.cwd; return result; } });
    assert.equal(plan.status, 'fallback');
    assert.equal(fs.existsSync(scratch), false);
  }
});

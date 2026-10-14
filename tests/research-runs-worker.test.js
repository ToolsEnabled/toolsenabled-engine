// EXECUTABLE CHANGE
// Test-can-fail audit (testcanfail-tests-research-runs-worker-test-js):
// - VACUOUS COLLECTION ASSERTION: FOUND below. With ResearchRunsWorker.runOnce
//   mutated to return true after claiming without calling _execute, the former
//   `after.some(...)` assertion stayed green because the already-completed held
//   sibling satisfied it. The run-specific assertion added below fails under
//   that mutation with: `actual: 'leased'`, `expected: 'succeeded'`.
// - EXIT-STATUS/TRUTHY-RETURN-ONLY: NOT-FOUND; return-value assertions here are
//   accompanied by persisted task-state assertions.
// - SWALLOWED FAILURE: NOT-FOUND.
// - MOCK-OF-SUBJECT: NOT-FOUND; injected agent functions are dependencies, and
//   their effects are checked in persisted worker output.
// - SKIP/PRECONDITION NO-OP: NOT-FOUND.
// - EXPECTED VALUE COMPUTED BY SUBJECT: NOT-FOUND.
// Mutation precondition: Node >=22 is required for node:sqlite; the default
// Node 20 cannot load this file, so mutation and restoration runs used the
// installed /root/.nvm/versions/node/v22.22.2/bin/node.

'use strict';

// The worker's honest execution discipline: settings and project pauses are
// re-decided per execute with named retry codes, admission serializes on
// max_parallel and the shared-workspace mutex, a real declared command runs
// with collected typed results, and an agent dispatch attributes its launch.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createStateStore } = require('../src/lib/state-store');
const { ResearchControl } = require('../src/lib/providers/research');
const { ResearchRunsWorker } = require('../src/lib/research/research-runs-worker');
const tasks = require('../src/lib/providers/tasks');
const collectors = require('../src/lib/research/collectors');
const researchRunners = require('../src/lib/research/runners');

const auditRequire = () => ({ durable: true });
const enabled = { state: 'enabled', why: null };
const withheld = why => ({ state: 'withheld', why });
const onGate = () => ({
  pipelineWithheld: false, pipeline: enabled,
  runners: { agent: enabled, process: enabled, http: withheld('off') }
});
const offGate = () => ({
  pipelineWithheld: true, pipeline: withheld('"research.pipeline" is off.'),
  runners: { agent: withheld('off'), process: withheld('off'), http: withheld('off') }
});

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-worker-'));
  const state = createStateStore({ file: path.join(dir, 'state.sqlite3') });
  state.health();
  const control = new ResearchControl({ state, gate: onGate, auditRequire });
  const { project } = control.projectSave({ actor: 'human', name: 'Demo', enabled: true });
  return { dir, state, control, project };
}

function makeReady(state, taskId) {
  state.transaction(db => db.prepare('UPDATE tasks SET available_at_ms = 0 WHERE id = ?').run(taskId));
}

const PROCESS_SPEC = projectId => ({
  projectId, name: 'grid', runnerKind: 'process',
  runnerConfig: { command: process.execPath, args: ['-e', 'console.log(JSON.stringify({cell:"{a}-{b}",n:{b}}))'], stdin: 'none', envKeys: ['ELECTRON_RUN_AS_NODE'] },
  resultSchema: { fields: { cell: 'string', n: 'number' }, required: ['cell', 'n'] },
  collector: { kind: 'stdout-json', recordKind: 'summary' },
  maxParallel: 1, timeoutMs: 30000
});

test('pausing never burns attempts: settings-off claims nothing, a disabled project is deferred, and re-enabling resumes', async () => {
  const { dir, state, control, project } = build();
  const artifactRoot = path.join(dir, 'artifacts');
  const submitted = control.runSubmit({ actor: 'human', experiment: PROCESS_SPEC(project.projectId), params: { a: 'x', b: '7' } });

  // Pipeline off: the worker must not claim at all. A claim-then-retry pause
  // consumes a task attempt per cycle and the closed retry taxonomy caps
  // local-write retries at two, so pause-by-retry would kill a waiting run on
  // the second cycle -- making the settings row's "jobs already waiting stay
  // waiting instead of failing" sentence false.
  const paused = new ResearchRunsWorker({ state, gate: offGate, artifactRoot, pauseMs: 1000 });
  assert.equal(await paused.runOnce(), false, 'nothing is claimed while the pipeline is off');
  let run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'queued', 'the waiting run genuinely stays waiting');
  assert.equal(run.task.attempt, 0, 'no attempt was consumed by the pause');

  // Project off: the pre-claim sweep defers the run attempt-neutrally.
  control.projectSave({ actor: 'human', projectId: project.projectId, enabled: false });
  const worker = new ResearchRunsWorker({ state, gate: onGate, artifactRoot, pauseMs: 1000 });
  assert.equal(await worker.runOnce(), false, 'a disabled project\'s runs are deferred, not claimed');
  run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'queued');
  assert.equal(run.task.attempt, 0);

  control.projectSave({ actor: 'human', projectId: project.projectId, enabled: true });
  makeReady(state, submitted.run.taskId);
  assert.equal(await worker.runOnce(), true);
  run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'succeeded', JSON.stringify(run.task.error || null));
  assert.equal(run.task.result.evidenceStatus, 'collected');
  assert.equal(run.task.result.recorded, 1);
  assert.match(run.task.result.collectionHash, /^[a-f0-9]{64}$/);
  assert.ok(run.artifactDir.includes(run.runId), 'the artifact folder is scoped by the globally unique run identity');

  const results = control.results({ runId: submitted.run.runId }).results;
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].record, { cell: 'x-7', n: 7 }, 'the declared schema typed the collected record');
  state.close();
});

test('the in-execute backstop still names the pause when a project is disabled mid-claim', async () => {
  const { dir, state, control, project } = build();
  const artifactRoot = path.join(dir, 'artifacts');
  const submitted = control.runSubmit({ actor: 'human', experiment: PROCESS_SPEC(project.projectId), params: { a: 'r', b: '1' } });
  const worker = new ResearchRunsWorker({ state, gate: onGate, artifactRoot, pauseMs: 1000 });
  // Claim first (the race window), THEN disable the project, then execute.
  const wrapped = tasks.internalResearchRunsState(state);
  const claimed = await tasks.claim({ queue: 'research-runs', types: ['research-run'], workerLabel: worker.workerLabel, leaseSeconds: 300 }, { state: wrapped });
  assert.equal(claimed.claimed, true);
  control.projectSave({ actor: 'human', projectId: project.projectId, enabled: false });
  await worker._execute(claimed);
  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'retry_wait');
  assert.equal(run.task.error.code, 'RESEARCH_PROJECT_DISABLED');
  state.close();
});

test('admission serializes on max_parallel attempt-neutrally while another run is leased', async () => {
  const { dir, state, control, project } = build();
  const artifactRoot = path.join(dir, 'artifacts');
  const first = control.runSubmit({ actor: 'human', experiment: PROCESS_SPEC(project.projectId), params: { a: 'x', b: '1' } });
  const second = control.runSubmit({ actor: 'human', experimentId: first.experiment.experimentId, params: { a: 'x', b: '2' } });

  // Hold run A leased the way a busy sibling worker would.
  const wrapped = tasks.internalResearchRunsState(state);
  const held = await tasks.claim({ queue: 'research-runs', types: ['research-run'], workerLabel: 'holder', leaseSeconds: 300 }, { state: wrapped });
  assert.equal(held.claimed, true);
  await tasks.start({ handle: held.handle, leaseSeconds: 300 }, { state: wrapped });

  // The pre-claim sweep defers run B while the experiment is at capacity, so
  // no attempt is burned waiting for the sibling. A burst larger than the
  // retry ceiling would otherwise die on serialize-retries.
  const worker = new ResearchRunsWorker({ state, gate: onGate, artifactRoot, pauseMs: 1000 });
  assert.equal(await worker.runOnce(), false, 'run B is deferred, not claimed, while A holds the only slot');
  const heldRun = control.runs({ runId: second.run.runId }).runs[0];
  assert.equal(heldRun.task.status, 'queued');
  assert.equal(heldRun.task.attempt, 0, 'waiting for capacity consumed no attempt');

  // The sibling finishes; the deferred run becomes claimable and executes.
  await tasks.complete({ handle: held.handle, result: { summary: 'held run done' } }, { state: wrapped });
  makeReady(state, second.run.taskId);
  makeReady(state, first.run.taskId);
  assert.equal(await worker.runOnce(), true);
  const after = control.runs({ experimentId: first.experiment.experimentId }).runs;
  assert.ok(after.some(run => run.task.status === 'succeeded' && run.runId !== undefined),
    'the deferred run executed once capacity cleared');
  const deferredRun = after.find(run => run.runId === second.run.runId);
  assert.equal(deferredRun.task.status, 'succeeded',
    'the specifically deferred run, rather than its already-completed sibling, executed once capacity cleared');
  state.close();
});

test('the in-execute admission backstop names the serialization when capacity vanishes mid-claim', async () => {
  const { dir, state, control, project } = build();
  const artifactRoot = path.join(dir, 'artifacts');
  const first = control.runSubmit({ actor: 'human', experiment: PROCESS_SPEC(project.projectId), params: { a: 'y', b: '1' } });
  const second = control.runSubmit({ actor: 'human', experimentId: first.experiment.experimentId, params: { a: 'y', b: '2' } });
  const wrapped = tasks.internalResearchRunsState(state);
  // Claim B first (the race window), THEN lease A, then execute B.
  const claimedB = await tasks.claim({ queue: 'research-runs', types: ['research-run'], workerLabel: 'racer', leaseSeconds: 300 }, { state: wrapped });
  const claimedA = await tasks.claim({ queue: 'research-runs', types: ['research-run'], workerLabel: 'holder', leaseSeconds: 300 }, { state: wrapped });
  assert.equal(claimedB.claimed && claimedA.claimed, true);
  await tasks.start({ handle: claimedA.handle, leaseSeconds: 300 }, { state: wrapped });
  const worker = new ResearchRunsWorker({ state, gate: onGate, artifactRoot, pauseMs: 1000 });
  await worker._execute(claimedB);
  const runs = control.runs({ experimentId: first.experiment.experimentId }).runs;
  const blocked = runs.find(run => run.task.status === 'retry_wait');
  assert.ok(blocked, 'the raced claim is serialized behind the leased sibling');
  assert.equal(blocked.task.error.code, 'RESEARCH_RUN_SERIALIZED');
  state.close();
});

test('a failing declared command fails the run with its exit detail', async () => {
  const { dir, state, control, project } = build();
  const artifactRoot = path.join(dir, 'artifacts');
  const failing = control.runSubmit({
    actor: 'human',
    experiment: {
      ...PROCESS_SPEC(project.projectId), name: 'fails',
      runnerConfig: { command: process.execPath, args: ['-e', 'console.error("declared failure");process.exit(3)'], stdin: 'none', envKeys: ['ELECTRON_RUN_AS_NODE'] }
    },
    params: { a: 'x', b: '1' }
  });
  const worker = new ResearchRunsWorker({ state, gate: onGate, artifactRoot });
  await worker.runOnce();
  const run = control.runs({ runId: failing.run.runId }).runs[0];
  assert.equal(run.task.status, 'failed');
  assert.equal(run.task.error.code, 'RESEARCH_RUN_PROCESS_FAILED');
  state.close();
});

test('credential-shaped generated run IDs retain their durable links without failing ordinary checkpoints', async t => {
  // Exact ID from a native Electron validation failure, not a credential.
  const runId = 'rr-eaab22346864e533f600cf03edd980127118';
  for (const exitCode of [0, 3]) await t.test(`real command exits ${exitCode}`, async () => {
    const { dir, state, control, project } = build();
    try {
      const originalId = state._researchId.bind(state);
      state._researchId = prefix => prefix === 'rr' ? runId : originalId(prefix);
      const submitted = control.runSubmit({ actor: 'human', experiment: {
        ...PROCESS_SPEC(project.projectId),
        runnerConfig: { command: process.execPath,
          args: ['-e', `console.log(JSON.stringify({cell:"x-1",n:1}));console.error("declared failure");process.exit(${exitCode})`],
          stdin: 'none', envKeys: ['ELECTRON_RUN_AS_NODE'] }
      }, params: { a: 'x', b: '1' } });
      const worker = new ResearchRunsWorker({ state, gate: onGate, artifactRoot: path.join(dir, 'artifacts') });
      assert.equal(await worker.runOnce(), true);
      const run = control.runs({ runId }).runs[0];
      assert.equal(run.runId, runId);
      assert.equal(run.taskId, submitted.run.taskId);
      assert.ok(run.artifactDir.includes(runId), 'the exact path remains in the durable run');
      assert.equal(run.task.status, exitCode === 0 ? 'succeeded' : 'failed', JSON.stringify(run.task.error));
      if (exitCode !== 0) assert.equal(run.task.error.code, 'RESEARCH_RUN_PROCESS_FAILED');
      else assert.equal(control.results({ runId }).results.length, 1);
    } finally { state.close(); }
  });
});

test('an agent run completes as its dispatch receipt with launch attribution and auto-assignment', async () => {
  const { dir, state, control, project } = build();
  const artifactRoot = path.join(dir, 'artifacts');
  const briefs = [];
  const submitted = control.runSubmit({
    actor: 'human',
    experiment: {
      projectId: project.projectId, name: 'agentic', runnerKind: 'agent',
      runnerConfig: { briefTemplate: 'Investigate cell {a}.' },
      resultSchema: { fields: {} }, collector: { kind: 'none' }, timeoutMs: 30000
    },
    params: { a: 'z' }
  });
  const worker = new ResearchRunsWorker({
    state, gate: onGate, artifactRoot,
    runAgent: async ({ experiment, run, project: boundProject, artifactDir, dispatch }) => {
      briefs.push({ experiment: experiment.name, runId: run.runId, project: boundProject.name, artifactDir });
      return { kind: 'agent', launchId: 'launch_feedfacecafebeef', receipt: { ok: true }, durationMs: 3 };
    }
  });
  await worker.runOnce();
  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'succeeded');
  assert.equal(run.task.result.evidenceStatus, 'dispatch-only', 'a launch receipt is not completed research');
  assert.deepEqual(control.results({ runId: submitted.run.runId }).results, []);
  assert.equal(run.sessionRefKind, 'launch');
  assert.equal(run.sessionRef, 'launch_feedfacecafebeef');
  assert.equal(briefs.length, 1);
  const assignments = state.listResearchSessionAssignments({ projectId: project.projectId });
  assert.ok(assignments.some(entry => entry.kind === 'launch' && entry.ref === 'launch_feedfacecafebeef'),
    'the launch is auto-assigned to the project, so the session appears on the project without a manual step');
  state.close();
});

test('a SECOND pause on the same run keeps its pause code instead of dying at the taxonomy ceiling', async () => {
  // The adversarial review reproduced the platform's local-write retry
  // ceiling (2) turning the second claim-while-paused into INVALID_REQUEST.
  // The worker now falls back to the state layer's own retry, so the pause
  // code survives every cycle the task's maxAttempts allows.
  const { dir, state, control, project } = build();
  const artifactRoot = path.join(dir, 'artifacts');
  const submitted = control.runSubmit({
    actor: 'human',
    experiment: {
      projectId: project.projectId, name: 'agentic-repeat', runnerKind: 'agent',
      runnerConfig: { briefTemplate: 'Investigate {a}.' },
      resultSchema: { fields: {} }, collector: { kind: 'none' }, timeoutMs: 30000
    },
    params: { a: 'w' }
  });
  const worker = new ResearchRunsWorker({
    state, gate: onGate, artifactRoot, pauseMs: 1000,
    runAgent: async () => {
      const error = new Error('The mission bridge is not running on this host.');
      error.code = 'RESEARCH_BRIDGE_UNAVAILABLE';
      throw error;
    }
  });
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    worker.bridgeDownUntilMs = 0;
    makeReady(state, submitted.run.taskId);
    await worker.runOnce();
    const run = control.runs({ runId: submitted.run.runId }).runs[0];
    assert.equal(run.task.status, 'retry_wait', `cycle ${cycle}: still held, ${JSON.stringify(run.task.error || null)}`);
    assert.equal(run.task.error.code, 'RESEARCH_BRIDGE_UNAVAILABLE', `cycle ${cycle}: the pause code survives`);
  }
  // And while the bridge is remembered down, the sweep defers agent runs
  // instead of claiming them into the same wall.
  makeReady(state, submitted.run.taskId);
  assert.equal(worker.bridgeDownUntilMs > Date.now(), true);
  assert.equal(await worker.runOnce(), false, 'agent runs are deferred while the bridge is remembered down');
  state.close();
});

test('a bridge-down agent dispatch retries instead of failing terminally', async () => {
  const { dir, state, control, project } = build();
  const artifactRoot = path.join(dir, 'artifacts');
  const submitted = control.runSubmit({
    actor: 'human',
    experiment: {
      projectId: project.projectId, name: 'agentic-down', runnerKind: 'agent',
      runnerConfig: { briefTemplate: 'Investigate {a}.' },
      resultSchema: { fields: {} }, collector: { kind: 'none' }, timeoutMs: 30000
    },
    params: { a: 'q' }
  });
  const worker = new ResearchRunsWorker({
    state, gate: onGate, artifactRoot, pauseMs: 1000,
    runAgent: async () => {
      const error = new Error('The mission bridge is not running on this host.');
      error.code = 'RESEARCH_BRIDGE_UNAVAILABLE';
      throw error;
    }
  });
  await worker.runOnce();
  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'retry_wait', JSON.stringify(run.task.error || null));
  assert.equal(run.task.error.code, 'RESEARCH_BRIDGE_UNAVAILABLE');
  state.close();
});

test('a transient inspection failure is indeterminate without displacing the bridge-down latch', async () => {
  const { dir, state, control, project } = build();
  const submitted = control.runSubmit({ actor: 'human', experiment: PROCESS_SPEC(project.projectId), params: { a: 'busy', b: '1' } });
  const worker = new ResearchRunsWorker({ state, gate: onGate, artifactRoot: path.join(dir, 'artifacts'), pauseMs: 1000 });
  const originalLookup = worker.state.getResearchRunByTask.bind(worker.state);
  worker.state.getResearchRunByTask = () => {
    const error = new Error('temporary input/output failure');
    error.code = 'EIO';
    throw error;
  };

  await worker.runOnce();
  let run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'retry_wait', 'could-not-tell is retryable rather than a definite failed run');
  assert.equal(run.task.error.code, 'RESEARCH_RUN_INDETERMINATE');
  assert.match(run.task.error.message, /does not claim .* absent/i);
  assert.equal(worker.bridgeDownUntilMs, 0, 'an EIO observation is not cached or latched');

  // Control: the pre-existing known bridge-unavailable optimization remains
  // cached; deleting all latching would satisfy the indeterminate assertion
  // while reinstating repeated dispatches into a bridge known to be down.
  worker.state.getResearchRunByTask = originalLookup;
  makeReady(state, submitted.run.taskId);
  worker.runProcess = async () => {
    const error = new Error('bridge unavailable');
    error.code = 'RESEARCH_BRIDGE_UNAVAILABLE';
    throw error;
  };
  await worker.runOnce();
  run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.error.code, 'RESEARCH_BRIDGE_UNAVAILABLE');
  assert.equal(worker.bridgeDownUntilMs > Date.now(), true, 'known bridge unavailability is still latched');
  state.close();
});

process.on('exit', () => { console.log('research runs worker tests passed'); });

test('runner refusals persist their exact code and stop before collection or result writes', async t => {
  const cases = [
    ['RESEARCH_RUN_SPAWN_FAILED', 'process', { spawnError: Object.assign(new Error('could not spawn'), { code: 'ENOENT' }) }],
    ['RESEARCH_RUN_TIMEOUT', 'process', { timedOut: true }],
    ['RESEARCH_RUN_HTTP_FAILED', 'http', { status: 503, body: '{"ignored":true}', durationMs: 1 }],
    ['RESEARCH_RUN_FAILED', 'process', Object.assign(new Error('runner exploded without a code'), { code: undefined })]
  ];
  for (const [expectedCode, runnerKind, outcome] of cases) await t.test(expectedCode, async () => {
    const { dir, state, control, project } = build();
    const spec = runnerKind === 'http' ? {
      projectId: project.projectId, name: `http-${expectedCode}`, runnerKind: 'http',
      runnerConfig: { url: 'https://example.invalid/result' }, timeoutMs: 30000,
      resultSchema: { fields: {} }, collector: { kind: 'none' }, maxParallel: 1
    } : { ...PROCESS_SPEC(project.projectId), name: `process-${expectedCode}` };
    const submitControl = runnerKind === 'http'
      ? new ResearchControl({ state, gate: () => ({ pipelineWithheld: false, pipeline: enabled, runners: { agent: enabled, process: enabled, http: enabled } }), auditRequire })
      : control;
    const submitted = submitControl.runSubmit({ actor: 'human', experiment: spec, params: { a: 'x', b: '1' } });
    let runnerCalls = 0;
    let collectCalls = 0;
    const gate = () => ({ pipelineWithheld: false, pipeline: enabled, runners: { agent: enabled, process: enabled, http: enabled } });
    const run = async () => {
      runnerCalls += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    const worker = new ResearchRunsWorker({
      state, gate, artifactRoot: path.join(dir, 'artifacts'),
      runProcess: run, runHttp: run,
      collect: () => { collectCalls += 1; return { records: [], refused: [], dropped: 0 }; }
    });

    assert.equal(await worker.runOnce(), true, 'the worker claimed and drove the task');
    const persisted = control.runs({ runId: submitted.run.runId }).runs[0];
    assert.equal(persisted.task.status, 'failed');
    assert.equal(persisted.task.error.code, expectedCode);
    assert.equal(runnerCalls, 1, 'exactly one declared runner was invoked');
    assert.equal(collectCalls, 0, 'a refused runner outcome never reaches collection');
    assert.deepEqual(control.results({ runId: submitted.run.runId }).results, [], 'no result was written after refusal');
    state.close();
  });
});

test('missing durable parents refuse a claimed task before any runner is spawned', async t => {
  const cases = [
    ['RESEARCH_RUN_ORPHAN_TASK', worker => { worker.state.getResearchRunByTask = () => null; }],
    ['RESEARCH_EXPERIMENT_ARCHIVED', worker => { worker.state.getResearchExperiment = () => null; }],
    ['RESEARCH_PROJECT_NOT_FOUND', worker => { worker.state.getResearchProject = () => null; }]
  ];
  for (const [expectedCode, removeParent] of cases) await t.test(expectedCode, async () => {
    const { dir, state, control, project } = build();
    const submitted = control.runSubmit({ actor: 'human', experiment: PROCESS_SPEC(project.projectId), params: { a: 'x', b: '2' } });
    let runnerCalls = 0;
    let collectCalls = 0;
    const worker = new ResearchRunsWorker({
      state, gate: onGate, artifactRoot: path.join(dir, 'artifacts'),
      runProcess: async () => { runnerCalls += 1; return { exitCode: 0, stdout: '', durationMs: 1 }; },
      collect: () => { collectCalls += 1; return { records: [], refused: [], dropped: 0 }; }
    });
    removeParent(worker);

    assert.equal(await worker.runOnce(), true);
    const persisted = control.runs({ runId: submitted.run.runId }).runs[0];
    assert.equal(persisted.task.status, 'failed');
    assert.equal(persisted.task.error.code, expectedCode);
    assert.equal(runnerCalls, 0, 'refusal happens before spawning the runner');
    assert.equal(collectCalls, 0, 'refusal happens before collection');
    assert.deepEqual(control.results({ runId: submitted.run.runId }).results, [], 'refusal writes no results');
    state.close();
  });
});

test('a failed pre-claim defer sweep refuses to claim or spawn and reports DEFER_FAILED', async () => {
  const { dir, state, control, project } = build();
  const submitted = control.runSubmit({ actor: 'human', experiment: PROCESS_SPEC(project.projectId), params: { a: 'x', b: '3' } });
  const events = [];
  let runnerCalls = 0;
  const worker = new ResearchRunsWorker({
    state, gate: onGate, artifactRoot: path.join(dir, 'artifacts'), pauseMs: 1234,
    onEvent: event => events.push(event),
    runProcess: async () => { runnerCalls += 1; return { exitCode: 0, stdout: '', durationMs: 1 }; }
  });
  worker.state.deferResearchRuns = () => { throw new Error('sweep unavailable'); };

  assert.equal(await worker.runOnce(), false, 'the unknown sweep result prevents claiming');
  assert.deepEqual(events, [{ type: 'defer_error', code: 'DEFER_FAILED' }]);
  const persisted = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(persisted.task.status, 'queued');
  assert.equal(persisted.task.attempt, 0, 'refusal did not consume an attempt');
  assert.equal(runnerCalls, 0, 'refusal did not spawn a runner');
  assert.deepEqual(control.results({ runId: submitted.run.runId }).results, [], 'refusal wrote no results');
  assert.equal(worker.nextDelayMs, 1234);
  state.close();
});

const allRunnersGate = () => ({ pipelineWithheld: false, pipeline: enabled, runners: { agent: enabled, process: enabled, http: enabled } });
const validProcessOutcome = () => ({ kind: 'process', exitCode: 0, stdout: '{"cell":"fixture","n":1}', stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
  // Dependency fixture only, not a claim of real POSIX or native containment.
  processLifecycle: { schemaVersion: 1, backend: 'posix-process-group', cleanupStatus: 'ROOT_CLOSED', receipt: null, acceptanceReady: true }
});

function integrityWorkerFixture(t, specChanges = {}, workerOptions = {}) {
  const built = build();
  const { dir, state, project } = built;
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const control = new ResearchControl({ state, gate: allRunnersGate, auditRequire });
  const submitted = control.runSubmit({ actor: 'human', experiment: { ...PROCESS_SPEC(project.projectId), ...specChanges }, params: { a: 'fixture', b: '1' } });
  const events = [];
  const worker = new ResearchRunsWorker({
    state, gate: allRunnersGate, artifactRoot: path.join(dir, 'artifacts'), pauseMs: 1000,
    runProcess: async () => validProcessOutcome(), onEvent: event => events.push(event), ...workerOptions
  });
  return { ...built, control, submitted, worker, events };
}

function assertWorkerRefused(fixture, code, status = 'failed') {
  const run = fixture.control.runs({ runId: fixture.submitted.run.runId }).runs[0];
  assert.equal(run.task.status, status, JSON.stringify(run.task.error || null));
  if (code) assert.equal(run.task.error.code, code);
  assert.equal(run.task.result, null);
  assert.deepEqual(fixture.control.results({ runId: run.runId }).results, []);
  return run;
}

test('a real native exit 259 proves cleanup but cannot collect success-shaped research output',
  { skip: process.platform !== 'win32' }, async () => {
    const { dir, state, control, project } = build();
    let outcome;
    let runnerCalls = 0;
    let collectCalls = 0;
    const events = [];
    try {
      const submitted = control.runSubmit({ actor: 'human', experiment: {
        ...PROCESS_SPEC(project.projectId), name: 'native-exit-259',
        runnerConfig: { command: process.execPath, stdin: 'none', envKeys: ['ELECTRON_RUN_AS_NODE'],
          args: ['-e', 'process.stdout.write(JSON.stringify({cell:"finite",n:1}), () => process.exit(259));'] }
      }, params: { a: 'finite', b: '1' } });
      const worker = new ResearchRunsWorker({ state, gate: onGate,
        artifactRoot: path.join(dir, 'artifacts'), onEvent: event => events.push(event),
        runProcess: async context => { runnerCalls += 1; outcome = await researchRunners.runProcess(context); return outcome; },
        collect: input => { collectCalls += 1; return collectors.collect(input); }
      });
      assert.equal(await worker.runOnce(), true);
      assert.equal(runnerCalls, 1, 'the real declared Node command must execute');
      assert.equal(outcome.exitCode, 259, '259 is the measured exit code after root signalling, not STILL_ACTIVE or success');
      assert.equal(outcome.stdout, '{"cell":"finite","n":1}');
      assert.equal(outcome.timedOut, false); assert.equal(outcome.cancelled, false);
      assert.equal(outcome.processLifecycle.backend, 'windows-job');
      assert.equal(outcome.processLifecycle.cleanupStatus, 'EMPTY');
      assert.equal(outcome.processLifecycle.wrapperClosed, true);
      assert.equal(outcome.processLifecycle.wrapperExitCode, 259);
      assert.deepEqual(outcome.processLifecycle.receipt, { type: 'exit', exitCode: 259, activeProcesses: 0 });
      assert.equal(outcome.processLifecycle.acceptanceReady, false);
      const run = assertWorkerRefused({ control, submitted }, 'RESEARCH_RUN_PROCESS_FAILED');
      assert.equal(collectCalls, 0, 'valid-looking output from a failed command must not reach collection');
      assert.equal(events.some(event => event.type === 'completed'), false);
      const checkpoint = state.listTaskCheckpoints({ taskId: run.taskId })
        .map(row => JSON.parse(row.checkpoint.resumeContext)).find(row => row.phase === 'process-stopped');
      assert.equal(checkpoint.processLifecycle.receipt.exitCode, 259, 'durable failure metadata retains the actual cleanup receipt');
    } finally {
      state.close();
      // Preserve the isolated evidence if a native lifetime could not be
      // established. Parent DB closure is not descendant cleanup proof.
      if (runnerCalls === 0 || (outcome?.processLifecycle.cleanupStatus === 'EMPTY' && outcome.processLifecycle.wrapperClosed)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

test('a worker never accepts a partial, empty, duplicated, or non-finite collector set', async t => {
  const cases = [
    ['malformed tail', '{"cell":"ok","n":1}\nnot-json', 'RESEARCH_RUN_RESULTS_INCOMPLETE'],
    ['wrong typed result', '{"cell":"ok","n":1}\n{"cell":"bad","n":"one"}', 'RESEARCH_RUN_RESULTS_INCOMPLETE'],
    ['non-finite', '{"cell":"bad","n":1e999}', 'RESEARCH_RUN_RESULTS_INCOMPLETE'],
    ['empty output', '', 'RESEARCH_RUN_RESULTS_EMPTY'],
    ['omitted observations', Array.from({ length: collectors.MAX_RECORDS + 1 }, (_, n) => JSON.stringify({ cell: `cell-${n}`, n })).join('\n'), 'RESEARCH_RUN_RESULTS_INCOMPLETE'],
    ['duplicate observations', '{"cell":"same","n":1}\n{"cell":"same","n":1}', 'RESEARCH_RESULTS_DUPLICATE_IDENTITY']
  ];
  for (const [name, stdout, code] of cases) await t.test(name, async t => {
    const f = integrityWorkerFixture(t, {}, { runProcess: async () => ({ ...validProcessOutcome(), stdout }) });
    assert.equal(await f.worker.runOnce(), true);
    assertWorkerRefused(f, code);
    assert.equal(f.events.some(event => event.type === 'completed'), false);
  });
});

test('unsupported schemas stop before execution and malformed completeness reports stop before persistence', async t => {
  await t.test('schema language cannot silently expand', async t => {
    let runnerCalls = 0;
    const f = integrityWorkerFixture(t, { resultSchema: { fields: { n: 'number' }, minimum: 0 } }, {
      runProcess: async () => { runnerCalls += 1; return validProcessOutcome(); }
    });
    await f.worker.runOnce();
    assertWorkerRefused(f, 'RESEARCH_RESULT_SCHEMA_UNSUPPORTED');
    assert.equal(runnerCalls, 0);
  });
  for (const report of [null, { records: [], refused: [] }, { records: {}, refused: [], dropped: 0 }, { records: [], refused: {}, dropped: 0 }, { records: [], refused: [], dropped: -1 }]) {
    await t.test(`report ${JSON.stringify(report)}`, async t => {
      const f = integrityWorkerFixture(t, {}, { collect: () => report });
      await f.worker.runOnce();
      assertWorkerRefused(f, 'RESEARCH_RUN_COLLECTION_INVALID');
    });
  }
});

test('runner truncation is refused before even a none collector can claim completion', async t => {
  for (const field of ['stdoutTruncated', 'stderrTruncated', 'truncated']) await t.test(field, async t => {
    const isHttp = field === 'truncated';
    let collectCalls = 0;
    const f = integrityWorkerFixture(t, {
      collector: { kind: 'none' }, ...(isHttp ? { runnerKind: 'http', runnerConfig: { url: 'https://example.test/fixture' } } : {})
    }, {
      runProcess: async () => ({ ...validProcessOutcome(), [field]: true }),
      runHttp: async () => ({ status: 200, body: '{"cell":"fixture","n":1}', durationMs: 1, truncated: true }),
      collect: () => { collectCalls += 1; return { records: [], refused: [], dropped: 0 }; }
    });
    await f.worker.runOnce();
    assertWorkerRefused(f, 'RESEARCH_RUN_OUTPUT_INCOMPLETE');
    assert.equal(collectCalls, 0);
  });
  await t.test('intentional no-collection execution', async t => {
    const f = integrityWorkerFixture(t, { collector: { kind: 'none' } });
    await f.worker.runOnce();
    const run = f.control.runs({ runId: f.submitted.run.runId }).runs[0];
    assert.equal(run.task.status, 'succeeded');
    assert.equal(run.task.result.evidenceStatus, 'execution-only');
    assert.equal(run.task.result.recorded, 0);
    assert.match(run.task.result.summary, /without collecting results/);
    assert.deepEqual(f.control.results({ runId: run.runId }).results, []);
  });
});

test('HTTP status must be an integer 200 through 299 before collection can succeed', async t => {
  for (const status of [199, 200, 299, 300, '200', undefined]) await t.test(String(status), async t => {
    const f = integrityWorkerFixture(t, { runnerKind: 'http', runnerConfig: { url: 'https://example.test/fixture' } }, {
      runHttp: async () => ({ status, body: '{"cell":"http","n":2}', truncated: false, durationMs: 1 })
    });
    await f.worker.runOnce();
    if (status === 200 || status === 299) {
      const run = f.control.runs({ runId: f.submitted.run.runId }).runs[0];
      assert.equal(run.task.status, 'succeeded');
      assert.equal(run.task.result.evidenceStatus, 'collected');
      assert.deepEqual(f.control.results({ runId: run.runId }).results.map(entry => entry.record), [{ cell: 'http', n: 2 }]);
    } else assertWorkerRefused(f, 'RESEARCH_RUN_HTTP_FAILED');
  });
});

test('every retry gets a fresh artifact directory and never collects predecessor or parent files', async t => {
  for (const freshResult of [false, true]) await t.test(freshResult ? 'new results only' : 'no new result is empty', async t => {
    const directories = [];
    const f = integrityWorkerFixture(t, { collector: { kind: 'artifact-glob', pattern: '**/*.json' } }, {
      runProcess: async ({ artifactDir }) => {
        directories.push(artifactDir);
        if (directories.length === 1) {
          fs.writeFileSync(path.join(artifactDir, 'stale.json'), '{"cell":"stale","n":99}');
          fs.writeFileSync(path.join(path.dirname(artifactDir), 'parent.json'), '{"cell":"parent","n":100}');
          throw Object.assign(new Error('fixture transient read failure'), { code: 'EIO' });
        }
        if (freshResult) fs.writeFileSync(path.join(artifactDir, 'fresh.json'), '{"cell":"fresh","n":2}');
        return validProcessOutcome();
      }
    });
    await f.worker.runOnce();
    assertWorkerRefused(f, 'RESEARCH_RUN_INDETERMINATE', 'retry_wait');
    makeReady(f.state, f.submitted.run.taskId);
    await f.worker.runOnce();
    assert.equal(directories.length, 2);
    assert.notEqual(directories[0], directories[1]);
    assert.match(path.basename(directories[0]), /^attempt-1-/);
    assert.match(path.basename(directories[1]), /^attempt-2-/);
    assert.equal(fs.readFileSync(path.join(directories[0], 'stale.json'), 'utf8'), '{"cell":"stale","n":99}', 'old evidence is retained');
    const current = f.control.runs({ runId: f.submitted.run.runId }).runs[0];
    assert.equal(current.artifactDir, directories[1]);
    if (freshResult) {
      assert.equal(current.task.status, 'succeeded');
      assert.equal(current.task.result.attempt, 2);
      const results = f.control.results({ runId: current.runId }).results;
      assert.equal(results.length, 1);
      assert.equal(results[0].record.cell, 'fresh');
      assert.equal(results[0].artifactPath, 'fresh.json');
    } else assertWorkerRefused(f, 'RESEARCH_RUN_RESULTS_EMPTY');
  });
});

test('a long Windows artifact root executes without redundant project and experiment path segments', async t => {
  const { dir, state, control, project } = build();
  t.after(() => state.close());
  // The old layout crosses MAX_PATH; the supplied root itself is ordinary.
  // This is a real declared Node command, collection, and durable completion.
  const artifactRoot = path.join(dir, 'bounded-root-'.padEnd(Math.max(16, 160 - dir.length - 1), 'x'));
  const submitted = control.runSubmit({ actor: 'human', experiment: PROCESS_SPEC(project.projectId), params: { a: 'deep', b: '3' } });
  const oldPrefix = path.join(artifactRoot, project.projectId, submitted.experiment.experimentId, submitted.run.runId, 'attempt-1-XXXXXX');
  assert.ok(oldPrefix.length > 260, 'the regression must exercise the formerly failing layout');
  const oldParent = path.join(artifactRoot, project.projectId, submitted.experiment.experimentId, submitted.run.runId);
  fs.mkdirSync(oldParent, { recursive: true });
  const oldEvidence = path.join(oldParent, 'prior-evidence.txt');
  fs.writeFileSync(oldEvidence, 'preserved prior evidence');
  const worker = new ResearchRunsWorker({ state, gate: onGate, artifactRoot });
  await worker.runOnce();
  const run = control.runs({ runId: submitted.run.runId }).runs[0];
  assert.equal(run.task.status, 'succeeded', JSON.stringify(run.task.error));
  assert.equal(path.dirname(path.dirname(run.artifactDir)), artifactRoot);
  assert.equal(path.basename(path.dirname(run.artifactDir)), run.runId);
  assert.ok(run.artifactDir.length < 260, 'the command gets a normal, portable cwd, not a short-path alias');
  assert.deepEqual(control.results({ runId: run.runId }).results.map(entry => entry.record), [{ cell: 'deep-3', n: 3 }]);
  assert.equal(fs.readFileSync(oldEvidence, 'utf8'), 'preserved prior evidence');
});

test('a linked artifact parent refuses before runner execution', async t => {
  let runnerCalls = 0;
  const f = integrityWorkerFixture(t, {}, { runProcess: async () => { runnerCalls += 1; return validProcessOutcome(); } });
  const target = path.join(f.dir, 'link-target');
  fs.mkdirSync(target);
  fs.mkdirSync(f.worker.artifactRoot);
  fs.symlinkSync(target, path.join(f.worker.artifactRoot, f.submitted.run.runId), 'junction');
  await f.worker.runOnce();
  assertWorkerRefused(f, 'RESEARCH_RUN_ARTIFACT_PATH_REFUSED');
  assert.equal(runnerCalls, 0);
  assert.deepEqual(fs.readdirSync(target), [], 'no scoped directory was created through the link');
});

test('cancellation arriving at collection is acknowledged without leaking records', async t => {
  const f = integrityWorkerFixture(t);
  f.worker.collect = input => {
    const result = collectors.collect(input);
    f.state.cancelTask({ taskId: f.submitted.run.taskId, reason: 'fixture late cancellation' });
    return result;
  };
  await f.worker.runOnce();
  assertWorkerRefused(f, null, 'cancelled');
  assert.equal(f.events.some(event => event.type === 'completed'), false);
});

test('a lost completion fence leaves the successor running and writes no old observations', async t => {
  const f = integrityWorkerFixture(t);
  let handle;
  const startTask = f.state.startTask.bind(f.state);
  f.worker.state.startTask = (claim, options) => { handle = claim; return startTask(claim, options); };
  let successor;
  f.worker.collect = input => {
    const result = collectors.collect(input);
    f.state.failTask(handle, { disposition: 'retry', code: 'FIXTURE_RETRY', message: 'successor takes ownership', retryDelayMs: 0 });
    successor = f.state.claimTask({ queue: 'research-runs', workerLabel: 'new-owner', leaseMs: 300000 }).handle;
    startTask(successor);
    return result;
  };
  await f.worker.runOnce();
  const run = assertWorkerRefused(f, null, 'running');
  assert.equal(run.task.attempt, 2);
  assert.equal(f.events.some(event => event.type === 'completed'), false);
  assert.ok(f.events.some(event => event.type === 'failure_record_error' && event.code === 'TASK_OUTCOME_CONFLICT'));
  f.state.completeResearchRun(successor, { runId: run.runId, records: [{ recordKind: 'fresh', record: { cell: 'new-owner', n: 2 } }], result: { summary: 'new owner', runnerKind: 'process', evidenceStatus: 'collected' } });
  assert.deepEqual(f.control.results({ runId: run.runId }).results.map(entry => entry.record), [{ cell: 'new-owner', n: 2 }]);
});

test('a heartbeat read error does not fabricate a cancellation request', async t => {
  let release;
  let timeout;
  const runnerPending = new Promise((resolve, reject) => {
    release = () => { clearTimeout(timeout); resolve(validProcessOutcome()); };
    timeout = setTimeout(() => reject(new Error('fixture heartbeat was not driven')), 2000);
  });
  t.after(() => clearTimeout(timeout));
  const f = integrityWorkerFixture(t, {}, { heartbeatIntervalMs: 5, runProcess: () => runnerPending,
    onEvent: event => { if (event.type === 'heartbeat_error') release(); }
  });
  f.worker.state.heartbeatTask = () => { throw Object.assign(new Error('fixture heartbeat read failed'), { code: 'EIO' }); };
  await f.worker.runOnce();
  const run = assertWorkerRefused(f, 'RESEARCH_RUN_INDETERMINATE', 'retry_wait');
  assert.equal(f.state.transaction(db => db.prepare('SELECT cancel_requested_at_ms FROM tasks WHERE id = ?').get(run.taskId)).cancel_requested_at_ms, null);
});

test('worker stop and unconfirmed dispatch cannot manufacture completed research or cancellation', async t => {
  await t.test('stopped worker', async t => {
    const f = integrityWorkerFixture(t);
    f.worker.runProcess = async () => { f.worker.stop(); return validProcessOutcome(); };
    await f.worker.runOnce();
    const run = assertWorkerRefused(f, 'RESEARCH_RUN_WORKER_STOPPED');
    assert.equal(f.state.transaction(db => db.prepare('SELECT cancel_requested_at_ms FROM tasks WHERE id = ?').get(run.taskId)).cancel_requested_at_ms, null);
    assert.equal(await f.worker.runOnce(), false, 'a stopped worker cannot claim more work');
  });
  for (const launchId of [undefined, '', '   ']) await t.test(`launch ${JSON.stringify(launchId)}`, async t => {
    const f = integrityWorkerFixture(t, { runnerKind: 'agent', runnerConfig: { briefTemplate: 'fixture only' }, collector: { kind: 'none' } }, {
      runAgent: async () => ({ kind: 'agent', launchId, durationMs: 1 })
    });
    await f.worker.runOnce();
    const run = assertWorkerRefused(f, 'RESEARCH_RUN_DISPATCH_UNCONFIRMED');
    assert.equal(run.sessionRef, null);
  });
});

test('research worker heartbeat failure aborts the runner and concurrent runOnce cannot claim', async t => {
  let sawSignal = false;
  let sawAbort = false;
  let activeClaims = 0;
  const f = integrityWorkerFixture(t, {}, { heartbeatIntervalMs: 5,
    runProcess: ({ signal }) => new Promise(resolve => {
      sawSignal = signal instanceof AbortSignal;
      activeClaims += 1;
      signal.addEventListener('abort', () => {
        sawAbort = true;
        assert.equal(signal.reason.code, 'EIO');
        setTimeout(() => resolve(validProcessOutcome()), 25);
      }, { once: true });
    })
  });
  f.worker.state.heartbeatTask = () => { throw Object.assign(new Error('fixture lease read failed'), { code: 'EIO' }); };
  const pending = f.worker.runOnce();
  assert.equal(await f.worker.runOnce(), false, 'one worker must not claim another task while the first invocation is pending');
  await pending;
  assert.equal(sawSignal, true);
  assert.equal(sawAbort, true);
  assert.equal(activeClaims, 1);
  assertWorkerRefused(f, 'RESEARCH_RUN_INDETERMINATE', 'retry_wait');
});

test('research worker lease loss aborts its runner without overwriting the successor', async t => {
  let originalHandle;
  let sawAbort = false;
  const f = integrityWorkerFixture(t, {}, { heartbeatIntervalMs: 5,
    runProcess: ({ signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => { sawAbort = true; resolve(validProcessOutcome()); }, { once: true });
      f.state.failTask(originalHandle, { disposition: 'retry', code: 'FIXTURE_RETRY', message: 'new attempt', retryDelayMs: 0 });
      const successor = f.state.claimTask({ queue: 'research-runs', workerLabel: 'successor', leaseMs: 300000 }).handle;
      f.state.startTask(successor);
    })
  });
  const originalStart = f.state.startTask.bind(f.state);
  f.worker.state.startTask = (handle, options) => { originalHandle = handle; return originalStart(handle, options); };
  await f.worker.runOnce();
  assert.equal(sawAbort, true);
  const run = assertWorkerRefused(f, null, 'running');
  assert.equal(run.task.attempt, 2);
  assert.equal(f.events.some(event => event.type === 'completed'), false);
});

test('research worker unproved process cleanup halts further claims and preserves its cause', async t => {
  const f = integrityWorkerFixture(t, {}, { runProcess: async () => ({ ...validProcessOutcome(), timedOut: true,
    failure: { code: 'RESEARCH_RUN_TIMEOUT', message: 'fixture timeout' },
    processLifecycle: { schemaVersion: 1, backend: 'windows-job', cleanupStatus: 'UNKNOWN', receipt: null, acceptanceReady: false }
  }) });
  await f.worker.runOnce();
  const run = assertWorkerRefused(f, 'RESEARCH_RUN_CLEANUP_UNPROVEN');
  assert.equal(f.worker.cleanupBlocked, true);
  assert.equal(f.worker.stopped, true);
  assert.equal(await f.worker.runOnce(), false);
  assert.equal(run.task.result, null);
  const checkpoints = f.state.listTaskCheckpoints({ taskId: f.submitted.run.taskId });
  const saved = checkpoints.map(row => JSON.parse(row.checkpoint.resumeContext)).find(row => row.phase === 'cleanup-unproven');
  assert.equal(saved.processLifecycle.cleanupStatus, 'UNKNOWN');
  assert.equal(saved.causeCode, 'RESEARCH_RUN_TIMEOUT');
  assert.equal(f.events.some(event => event.type === 'completed'), false);
});

test('research worker refuses zero-exit outcomes missing a complete lifecycle or marked aborted', async t => {
  for (const [changes, code] of [
    [{ processLifecycle: undefined }, 'RESEARCH_RUN_PROCESS_OUTCOME_INVALID'],
    [{ processLifecycle: { schemaVersion: 1, cleanupStatus: 'EMPTY', acceptanceReady: false } }, 'RESEARCH_RUN_PROCESS_OUTCOME_INVALID'],
    [{ processLifecycle: { schemaVersion: 2, cleanupStatus: 'EMPTY', acceptanceReady: true } }, 'RESEARCH_RUN_PROCESS_OUTCOME_INVALID'],
    [{ cancelled: true }, 'RESEARCH_RUN_ABORTED']
  ]) {
    const f = integrityWorkerFixture(t, {}, { runProcess: async () => ({ ...validProcessOutcome(), ...changes }) });
    await f.worker.runOnce();
    assertWorkerRefused(f, code);
  }
});

test('research worker stop wakes a settings-pause timer instead of exiting around active cleanup', async t => {
  const f = integrityWorkerFixture(t, {}, { gate: offGate, pauseMs: 60000 });
  const pending = f.worker.runForever();
  await new Promise(resolve => setImmediate(resolve));
  const stoppedAt = performance.now();
  f.worker.stop();
  await pending;
  assert.ok(performance.now() - stoppedAt < 1000);
  assert.equal(f.worker.wakeIdle, null);
});

test('worker shutdown drains an already pending heartbeat before the owner may close its DB', async t => {
  let releaseHeartbeat;
  let releaseRunner;
  let heartbeatEntered;
  const entered = new Promise(resolve => { heartbeatEntered = resolve; });
  const f = integrityWorkerFixture(t, {}, { heartbeatIntervalMs: 5,
    runProcess: () => new Promise(resolve => { releaseRunner = () => resolve(validProcessOutcome()); }) });
  const originalHeartbeat = f.state.heartbeatTask.bind(f.state);
  f.worker.state.heartbeatTask = (handle, options) => new Promise((resolve, reject) => {
    releaseHeartbeat = () => { try { resolve(originalHeartbeat(handle, options)); } catch (error) { reject(error); } };
    heartbeatEntered();
  });
  let drained = false;
  const pending = f.worker.runForever().then(() => { drained = true; });
  let timer;
  try {
    await Promise.race([entered, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('heartbeat was not driven')), 2000); })]);
    clearTimeout(timer);
    f.worker.stop(); releaseRunner();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false, 'a pending state operation cannot outlive the worker drain acknowledgement');
    assert.equal(f.worker.busy, true);
    releaseHeartbeat();
    await pending;
    assert.equal(drained, true); assert.equal(f.worker.busy, false);
    assert.equal(f.worker.wakeIdle, null);
  } finally {
    clearTimeout(timer); f.worker.stop(); releaseRunner?.(); releaseHeartbeat?.(); await pending;
  }
});

test('research worker stop and task cancellation clean real native process descendants before returning', { skip: process.platform !== 'win32' }, async t => {
  for (const mode of ['stop', 'cancel']) await t.test(mode, async t => {
    let observedOutcome;
    const f = integrityWorkerFixture(t, {}, { heartbeatIntervalMs: 10, runProcess: async context => {
      const ready = path.join(context.artifactDir, 'worker-leaf.ready');
      const leaf = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>{},10000);`;
      const program = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,windowsHide:true,stdio:'ignore'});c.unref();setTimeout(()=>{},10000);`;
      const timer = setInterval(() => {
        if (!fs.existsSync(ready)) return;
        clearInterval(timer);
        if (mode === 'stop') f.worker.stop();
        else f.state.cancelTask({ taskId: f.submitted.run.taskId, reason: 'fixture cancellation' });
      }, 10);
      try {
        observedOutcome = await researchRunners.runProcess({ ...context,
          experiment: { ...context.experiment, runnerConfig: { command: process.execPath, args: ['-e', program], envKeys: ['ELECTRON_RUN_AS_NODE'] }, timeoutMs: 5000 }
        });
        assert.equal(fs.existsSync(ready), true, 'a real child must start before cancellation is tested');
        const leafPid = Number(fs.readFileSync(ready, 'utf8'));
        assert.throws(() => process.kill(leafPid, 0), error => error.code === 'ESRCH');
        return observedOutcome;
      } finally { clearInterval(timer); }
    } });
    await f.worker.runOnce();
    assert.ok(observedOutcome, 'the actual process runner must finish its bounded cleanup');
    assert.equal(observedOutcome.timedOut, false, JSON.stringify({ durationMs: observedOutcome.durationMs,
      failureCode: observedOutcome.failure?.code, cleanupStatus: observedOutcome.processLifecycle?.cleanupStatus }));
    assert.equal(observedOutcome.processLifecycle.cleanupStatus, 'EMPTY');
    assert.equal(observedOutcome.processLifecycle.wrapperClosed, true);
    assert.equal(observedOutcome.processLifecycle.acceptanceReady, false);
    assertWorkerRefused(f, mode === 'stop' ? 'RESEARCH_RUN_WORKER_STOPPED' : null, mode === 'stop' ? 'failed' : 'cancelled');
    const checkpoints = f.state.listTaskCheckpoints({ taskId: f.submitted.run.taskId });
    const saved = checkpoints.map(row => JSON.parse(row.checkpoint.resumeContext)).find(row => row.phase === 'process-stopped');
    if (mode === 'stop') assert.equal(saved.processLifecycle.cleanupStatus, 'EMPTY');
    else {
      assert.equal(saved, undefined, 'the cancellation fence refuses even a cleanup checkpoint');
      assert.equal(f.events.some(event => event.type === 'process_receipt_record_error' && event.code === 'TASK_CANCEL_REQUESTED'), true);
    }
  });
});

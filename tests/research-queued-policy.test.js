'use strict';

// Evidence-only component: production _execute/tasks/store; all runner and
// audit effects terminate at explicit inert dependencies. No worker loop.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const os = require('node:os');
const test = require('node:test');
const engineRoot = path.resolve(__dirname, '..');
const fixturesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'research-queued-policy-'));
const { configure } = require(path.join(engineRoot, 'tests/lib/isolated-environment.js'));
configure(path.join(fixturesRoot, 'isolated-product-state'));
const { createStateStore } = require(path.join(engineRoot, 'src/lib/state-store.js'));
const { ResearchControl } = require(path.join(engineRoot, 'src/lib/providers/research.js'));
const tasks = require(path.join(engineRoot, 'src/lib/providers/tasks.js'));
const { ResearchRunsWorker } = require(path.join(engineRoot, 'src/lib/research/research-runs-worker.js'));

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceFiles = [
  'src/lib/state-store.js', 'src/lib/providers/research.js',
  'src/lib/providers/tasks.js', 'src/lib/research/research-runs-worker.js',
  'src/lib/research/runners.js', 'src/lib/coordinator-audit-events.js',
  'tests/lib/isolated-environment.js'
];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file =>
  [file, sha(fs.readFileSync(path.join(engineRoot, file)))]));
const beforeSources = sourceHashes();
const BOUNDARY_CODE = 'RESEARCH_RUNNER_CONFIG_INVALID';
const auditObservations = [];
const taskOriginals = new Map();
const cases = [
  { id: 'enabled-control', kind: 'http', control: true, allowed: true },
  { id: 'pre-disabled-control', kind: 'agent', control: true, preDisabled: true },
  { id: 'project-disabled-at-claimed', kind: 'agent', checkpoint: 'claimed', mutation: 'project' },
  { id: 'project-disabled-at-preflight', kind: 'process', checkpoint: 'preflight', mutation: 'project' },
  { id: 'project-disabled-at-running', kind: 'http', checkpoint: 'running', mutation: 'project' },
  { id: 'pipeline-withheld-after-settings-read', kind: 'agent', checkpoint: 'running', mutation: 'pipeline' },
  { id: 'runner-withheld-after-settings-read', kind: 'http', checkpoint: 'running', mutation: 'runner' },
  { id: 'project-disabled-during-process-before-launch', kind: 'process', heartbeatWait: true, mutation: 'project' }
];

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Component deadline: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

function timeoutResources() {
  return process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length;
}

function snapshot(state, runId, projectId) {
  return state.transaction(db => {
    const run = db.prepare('SELECT task_id FROM research_runs WHERE run_id = ?').get(runId);
    const task = db.prepare(`SELECT status, attempt, fence, checkpoint_revision, cancel_requested_at_ms,
      error_code, result_json FROM tasks WHERE id = ?`).get(run.task_id);
    const project = db.prepare('SELECT enabled, status FROM research_projects WHERE project_id = ?').get(projectId);
    const checkpoints = db.prepare(`SELECT revision, fence, checkpoint_json FROM task_checkpoints
      WHERE task_id = ? ORDER BY revision`).all(run.task_id).map(row => ({
      revision: row.revision, fence: row.fence,
      phase: JSON.parse(JSON.parse(row.checkpoint_json).resumeContext).phase
    }));
    const results = db.prepare('SELECT COUNT(*) AS count FROM research_results WHERE run_id = ?').get(runId).count;
    return { project, task, checkpoints, results };
  });
}

async function observeCase(item, index) {
  const directory = path.join(fixturesRoot, item.id);
  fs.mkdirSync(directory, { mode: 0o700 });
  const databaseFile = path.join(directory, 'state.sqlite3');
  const state = createStateStore({ file: databaseFile });
  const policy = { pipeline: true, runner: true };
  const transitions = [], adapterEntries = [], boundaries = [];
  const paused = deferred(), release = deferred();
  let worker, execution, settled = false, waitConsumed = false, heartbeatArmed = false;
  let closed = false, observation;
  const timersBefore = timeoutResources();
  const mark = (event, details = {}) => transitions.push({ sequence: transitions.length + 1, event, ...details });
  const gate = () => {
    const enabled = { state: 'enabled', why: null };
    const withheld = { state: 'withheld', why: 'Disposable component policy is withheld.' };
    const result = {
      pipelineWithheld: !policy.pipeline, pipeline: policy.pipeline ? enabled : withheld,
      runners: Object.fromEntries(['agent', 'process', 'http'].map(kind =>
        [kind, policy.pipeline && (kind !== item.kind || policy.runner) ? enabled : withheld]))
    };
    mark('subject-settings-read', { pipelineEnabled: policy.pipeline, selectedRunnerEnabled: policy.runner });
    return result;
  };
  try {
    state.health();
    const control = new ResearchControl({ state, gate, auditRequire: () => ({ durable: true }) });
    const { project } = control.projectSave({ actor: 'human', name: 'Disposable component project', enabled: true });
    const runnerConfig = item.kind === 'process' ? { command: process.execPath, args: [], stdin: 'none' }
      : item.kind === 'agent' ? { briefTemplate: 'Disposable component {cell}.' }
        : { url: 'https://example.invalid/disposable-component' };
    const submitted = control.runSubmit({ actor: 'human', experiment: {
      projectId: project.projectId, name: 'Disposable checkpoint observation', runnerKind: item.kind,
      runnerConfig, resultSchema: { fields: { value: 'number' }, required: ['value'] },
      collector: { kind: 'none' }, timeoutMs: 1000
    }, params: { cell: 'inert' } });
    const boundary = kind => {
      const liveProject = state.getResearchProject({ projectId: project.projectId });
      const event = { kind, projectEnabled: liveProject.enabled, projectStatus: liveProject.status,
        pipelineEnabled: policy.pipeline, selectedRunnerEnabled: policy.runner };
      boundaries.push(event);
      mark('inert-effect-boundary', event);
      throw Object.assign(new Error('Inert component runner boundary intercepted; no runner executed.'), { code: BOUNDARY_CODE });
    };
    worker = new ResearchRunsWorker({
      state, gate, artifactRoot: path.join(directory, 'artifacts'),
      workerLabel: `research-component-${index}`, leaseSeconds: 300, pauseMs: 1000,
      heartbeatIntervalMs: 3600000,
      runAgent: async () => { adapterEntries.push('agent'); boundary('agent'); },
      runHttp: async () => { adapterEntries.push('http'); boundary('http'); },
      runProcess: async ({ beforeLaunch }) => {
        adapterEntries.push('process');
        mark('inert-process-adapter-entered');
        assert.equal(typeof beforeLaunch, 'function');
        heartbeatArmed = item.heartbeatWait === true;
        await beforeLaunch();
        mark('real-beforeLaunch-returned');
        boundary('process');
      },
      collect: () => { throw new Error('The inert refusal boundary must never reach collection.'); },
      onEvent: event => mark('worker-event', { type: event.type, code: event.code || null, reason: event.reason || null })
    });
    const claimed = await tasks.claim({ queue: 'research-runs', types: ['research-run'],
      workerLabel: worker.workerLabel, leaseSeconds: 300 }, { state: worker.state });
    assert.equal(claimed.claimed, true);
    const before = snapshot(state, submitted.run.runId, project.projectId);
    const originalCheckpoint = worker._checkpoint.bind(worker);
    worker._checkpoint = async (...args) => {
      const revision = await originalCheckpoint(...args);
      const phase = args[3];
      const durable = snapshot(state, submitted.run.runId, project.projectId);
      mark('checkpoint-durable', { phase, revision, lastPersistedPhase: durable.checkpoints.at(-1)?.phase });
      assert.equal(durable.checkpoints.at(-1)?.phase, phase);
      if (!waitConsumed && item.checkpoint === phase) {
        waitConsumed = true;
        mark('declared-checkpoint-wait-entered', { phase });
        paused.resolve({ kind: 'checkpoint', phase, durable });
        await release.promise;
        mark('declared-checkpoint-wait-released', { phase });
      }
      return revision;
    };
    if (item.heartbeatWait) {
      const originalHeartbeat = state.heartbeatTask.bind(state);
      state.heartbeatTask = async (...args) => {
        const result = originalHeartbeat(...args);
        if (heartbeatArmed && !waitConsumed) {
          waitConsumed = true;
          const durable = snapshot(state, submitted.run.runId, project.projectId);
          mark('real-heartbeat-committed-before-acknowledgement');
          paused.resolve({ kind: 'heartbeat-acknowledgement', durable });
          await release.promise;
          mark('declared-heartbeat-wait-released');
        }
        return result;
      };
    }
    if (item.preDisabled) {
      control.projectSave({ actor: 'human', projectId: project.projectId, enabled: false });
      mark('project-disabled-before-execute');
    }
    execution = worker._execute(claimed);
    execution.then(() => { settled = true; }, () => { settled = true; });
    let waitEvidence = null;
    if (item.checkpoint || item.heartbeatWait) {
      waitEvidence = await bounded(Promise.race([paused.promise, execution.then(() => {
        throw new Error('Execution finished before the declared observation wait.');
      })]), `${item.id} wait`);
      if (item.mutation === 'project') control.projectSave({ actor: 'human', projectId: project.projectId, enabled: false });
      else if (item.mutation === 'pipeline') policy.pipeline = false;
      else if (item.mutation === 'runner') policy.runner = false;
      else throw new Error('Unknown component mutation.');
      mark('policy-mutated-during-declared-wait', { mutation: item.mutation });
      release.resolve();
    }
    await bounded(execution, `${item.id} completion`);
    assert.equal(worker.activeController, null, 'Production finally must retire its active controller.');
    const after = snapshot(state, submitted.run.runId, project.projectId);
    const expectedPauseCode = ['pipeline', 'runner'].includes(item.mutation)
      ? 'RESEARCH_PAUSED_BY_SETTINGS' : 'RESEARCH_PROJECT_DISABLED';
    const invariantPassed = item.allowed
      ? boundaries.length === 1 && boundaries[0].kind === item.kind
        && after.task.status === 'failed' && after.task.error_code === BOUNDARY_CODE && after.results === 0
      : boundaries.length === 0 && after.task.status === 'retry_wait'
        && after.task.error_code === expectedPauseCode && after.results === 0;
    observation = { id: item.id, control: item.control === true, runnerKind: item.kind,
      expected: item.allowed ? 'One inert callback boundary; fixture refusal persists, no runner executes.'
        : `No effect-boundary callback; retry_wait with ${expectedPauseCode}.`,
      before, waitEvidence, after, adapterEntries, boundaries, transitions, invariantPassed,
      nativeProcessStarted: false, networkRequestSent: false, providerTurnStarted: false,
      realWorkerLoopStarted: false, activeControllerRetired: true };
  } finally {
    try {
      release.resolve();
      worker?.stop();
      if (execution && !settled) await bounded(execution, `${item.id} final drain`);
    } finally {
      closed = state.close();
      assert.equal(closed, true, 'The actual owned SQLite connection must close.');
    }
  }
  observation.closedSqliteSha256 = sha(fs.readFileSync(databaseFile));
  observation.sqliteCloseReturned = closed;
  observation.refedTimeoutsBefore = timersBefore;
  observation.refedTimeoutsAfter = timeoutResources();
  assert.equal(observation.refedTimeoutsAfter, timersBefore, 'Component/worker timeouts must drain before the next case.');
  fs.writeFileSync(path.join(directory, 'observation.json'), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
  return observation;
}

test('current project and settings policy fence every queued runner admission', async t => {
  const observations = [];
  // Keep the real task adapters and their event construction. Only supply
  // their existing auditRecord dependency, so no default vault/audit host runs.
  const auditRecord = (action, target, details) => {
    auditObservations.push({ action, target, details });
    return { durable: true };
  };
  const adapterNames = ['claim', 'start', 'heartbeat', 'checkpoint', 'fail', 'complete', 'completeResearchRun'];
  try {
    for (const name of adapterNames) {
      if (typeof tasks[name] !== 'function') continue;
      const original = tasks[name];
      taskOriginals.set(name, original);
      tasks[name] = (input, dependencies = {}) => original(input, { ...dependencies, auditRecord });
    }
    for (const [index, item] of cases.entries()) {
      await t.test(item.id, async () => {
        const observation = await observeCase(item, index);
        observations.push(observation);
        assert.equal(observation.invariantPassed, true, JSON.stringify({
          case: item.id, boundaries: observation.boundaries, task: observation.after.task
        }));
      });
    }
  } finally {
    for (const [name, original] of taskOriginals) tasks[name] = original;
  }
  const afterSources = sourceHashes();
  assert.deepEqual(afterSources, beforeSources);
  const result = {
    scope: 'Actual ResearchRunsWorker._execute and task/store methods with disposable SQLite. Real checkpoint writes precede declared waits. Explicit inert runProcess/runHttp/runAgent and supported auditRecord dependencies only. No worker loop, process runner, provider, network, credentials, durable-worker lock or protocol operation.',
    beforeSources, afterSources, observations, auditObservationCount: auditObservations.length,
    taskAdapterFunctionsRestored: [...taskOriginals].every(([name, original]) => tasks[name] === original),
    controlsPassed: observations.filter(row => row.control).every(row => row.invariantPassed),
    violations: observations.filter(row => !row.invariantPassed).map(row => row.id),
    closedSqliteScopes: observations.filter(row => row.sqliteCloseReturned).length
  };
  assert.equal(result.taskAdapterFunctionsRestored, true);
  assert.equal(result.controlsPassed, true, 'Enabled/pre-disabled controls must pass.');
  assert.deepEqual(result.violations, [], 'Current project and settings policy must be checked before the inert effect boundary.');
});

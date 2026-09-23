'use strict';

// Production runner/worker code with explicit inert launch dependencies only.
// Simulated receipts prove consumer ordering, never physical native closure.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { configure } = require('./lib/isolated-environment');
const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'research-policy-admission-'));
configure(path.join(suiteRoot, 'isolated-state'));
const runners = require('../src/lib/research/runners');
const { BACKEND } = require('../src/lib/linux-process-control');
const { createStateStore } = require('../src/lib/state-store');
const { ResearchControl } = require('../src/lib/providers/research');
const { ResearchRunsWorker } = require('../src/lib/research/research-runs-worker');
const tasks = require('../src/lib/providers/tasks');

const POLICY_CODE = 'RESEARCH_PROJECT_DISABLED';
const refuse = () => { throw new runners.ResearchPolicyRefusal(POLICY_CODE, 'The fixture project is disabled.', 'project'); };
const inert = () => { throw new Error('No native process, network request, provider or collection is allowed.'); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function processInput() {
  return { experiment: { runnerConfig: { command: process.execPath, args: [], stdin: 'none' }, timeoutMs: 1000 },
    run: { runId: 'inert-policy-admission', params: {} }, artifactDir: suiteRoot };
}

function ownedFixture(platform, { prepare = () => {}, receipt = 'valid', close = true } = {}) {
  const ready = deferred(), outcome = deferred();
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.jobReady = ready.promise; child.jobOutcome = outcome.promise;
  child.ownershipIdentity = platform === 'linux' ? { backend: BACKEND, scopeId: 'inert-owned-scope' } : undefined;
  child.kill = inert;
  child.unref = () => child;
  child.terminateJob = () => outcome.promise;
  child.terminateRetainedWrapper = () => Promise.resolve({ type: 'wrapper-terminated' });
  const observed = { wrapperCalls: 0, rootAdmissions: 0, refusal: null, closed: false };
  const dispose = () => {
    if (!observed.closed) {
      observed.closed = true;
      child.wrapperExitCode = 0;
      child.emit('close', platform === 'win32' ? 1 : null, null);
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  };
  const launch = (_command, _args, _options, dependencies) => {
    observed.wrapperCalls += 1;
    queueMicrotask(() => {
      prepare();
      try {
        dependencies.beforeRootSpawn();
        observed.rootAdmissions += 1;
        if (platform === 'win32') child.jobIdentity = { jobId: 'inert', wrapperPid: 1,
          wrapperStartTicks: '1', rootPid: 2, rootStartTicks: '2' };
        ready.resolve({});
        child.emit('spawn');
        outcome.resolve(platform === 'linux'
          ? { type: 'exit', backend: BACKEND, activeProcesses: 0, exitCode: 0, exitSignal: null, observedChildren: 1, reapedChildren: 1 }
          : { type: 'exit', activeProcesses: 0, exitCode: 0 });
        child.wrapperExitCode = 0;
        observed.closed = true;
        child.emit('close', 0, null);
      } catch (error) {
        observed.refusal = error.code;
        // Windows wraps the original refusal; only the producer's exact
        // callback observation can retain the named policy diagnostic.
        ready.reject(platform === 'win32' ? Object.assign(new Error('Refused before OWNER.'),
          { code: 'WINDOWS_JOB_LAUNCH_REFUSED' }) : error);
        if (receipt === 'valid') {
          outcome.resolve(platform === 'linux'
            ? { type: 'not-started', backend: BACKEND, activeProcesses: 0, exitCode: null,
              exitSignal: null, observedChildren: 0, reapedChildren: 0, reasonCode: error.code }
            : { type: 'not-started', activeProcesses: 0, exitCode: 1 });
        } else if (receipt === 'invalid') outcome.resolve({ type: 'not-started', activeProcesses: 1, exitCode: 1 });
        else if (receipt === 'rejected') outcome.reject(new Error('Fixture outcome unavailable.'));
        // Match the native helper's ordering: outcome settles, then close is
        // emitted synchronously before promise reactions consume the receipt.
        if (close) dispose();
      }
    });
    return child;
  };
  return { observed, dispose, dependencies: { platform, cleanupMs: 100,
    spawnInJob: platform === 'win32' ? launch : inert,
    spawnLinuxOwned: platform === 'linux' ? launch : inert,
    spawn: inert, killProcessGroup: inert } };
}

for (const platform of ['linux', 'win32']) {
  test(`${platform}: final policy refusal preserves non-start only after its receipt and closure`, async () => {
    let enabled = true;
    const fixture = ownedFixture(platform, { prepare: () => { enabled = false; } });
    try {
      const outcome = await runners.runProcess({ ...processInput(), requirePolicy: () => { if (!enabled) refuse(); } }, fixture.dependencies);
      assert.equal(fixture.observed.rootAdmissions, 0, 'No simulated root admission after policy changed.');
      assert.equal(fixture.observed.refusal, POLICY_CODE);
      assert.equal(outcome.admissionRefusal.code, POLICY_CODE);
      assert.equal(outcome.processLifecycle.cleanupStatus, 'NOT_STARTED');
      assert.equal(outcome.processLifecycle.receipt.type, 'not-started');
      assert.equal(outcome.processLifecycle.receipt.activeProcesses, 0);
      assert.equal(outcome.processLifecycle.started, false);
      assert.equal(outcome.processLifecycle.pipesClosed, true);
      assert.equal(outcome.processLifecycle.acceptanceReady, false);
    } finally { fixture.dispose(); }
  });

  for (const [receipt, close] of [['rejected', true], ['invalid', true], ['valid', false]]) {
    test(`${platform}: policy refusal with ${receipt} receipt and close=${close} keeps cleanup unknown`, async () => {
      let enabled = true;
      const fixture = ownedFixture(platform, { prepare: () => { enabled = false; }, receipt, close });
      try {
        const outcome = await runners.runProcess({ ...processInput(), requirePolicy: () => { if (!enabled) refuse(); } }, fixture.dependencies);
        assert.equal(fixture.observed.rootAdmissions, 0);
        assert.equal(outcome.processLifecycle.cleanupStatus, 'UNKNOWN');
        assert.equal(outcome.processLifecycle.acceptanceReady, false);
        assert.equal(outcome.failure.code, 'RESEARCH_RUN_CLEANUP_UNPROVEN');
      } finally { fixture.dispose(); }
    });
  }

  test(`${platform}: standalone callers preserve normal accepted completion without a policy callback`, async () => {
    const fixture = ownedFixture(platform);
    try {
      const outcome = await runners.runProcess(processInput(), fixture.dependencies);
      assert.equal(fixture.observed.rootAdmissions, 1);
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.processLifecycle.cleanupStatus, 'EMPTY');
      assert.equal(outcome.processLifecycle.acceptanceReady, true);
    } finally { fixture.dispose(); }
  });

  test(`${platform}: cancellation at final preparation still takes precedence over policy refusal`, async () => {
    const controller = new AbortController();
    let enabled = true;
    const fixture = ownedFixture(platform, { prepare: () => { enabled = false; controller.abort(); } });
    try {
      const outcome = await runners.runProcess({ ...processInput(), signal: controller.signal,
        requirePolicy: () => { if (!enabled) refuse(); } }, fixture.dependencies);
      assert.equal(fixture.observed.rootAdmissions, 0);
      assert.equal(fixture.observed.refusal, 'RESEARCH_RUN_ABORTED');
      assert.equal(outcome.cancelled, true);
      assert.equal(outcome.admissionRefusal || null, null);
    } finally { fixture.dispose(); }
  });
}

test('a policy already withheld refuses before an inert wrapper is even requested', async () => {
  let calls = 0;
  await assert.rejects(async () => runners.runProcess({ ...processInput(), requirePolicy: refuse }, {
    platform: 'win32', spawnInJob: () => { calls += 1; throw new Error('Unexpected wrapper request.'); }
  }), error => error.code === POLICY_CODE);
  assert.equal(calls, 0);
});

test('an asynchronous policy callback cannot authorize root creation', async () => {
  let calls = 0;
  await assert.rejects(async () => runners.runProcess({ ...processInput(), requirePolicy: async () => {} }, {
    platform: 'win32', spawnInJob: () => { calls += 1; throw new Error('Unexpected wrapper request.'); }
  }), error => error.code === 'RESEARCH_RUNNER_POLICY_ASYNC');
  assert.equal(calls, 0);
});

async function workerFixture(platform, receipt) {
  const directory = fs.mkdtempSync(path.join(suiteRoot, 'worker-'));
  const state = createStateStore({ file: path.join(directory, 'state.sqlite3') });
  const enabled = { state: 'enabled', why: null };
  const gate = () => ({ pipelineWithheld: false, pipeline: enabled,
    runners: { agent: enabled, process: enabled, http: enabled } });
  const originals = new Map();
  let worker, fixture;
  try {
    for (const name of ['claim', 'start', 'heartbeat', 'checkpoint', 'fail', 'completeResearchRun']) {
      const original = tasks[name];
      originals.set(name, original);
      tasks[name] = (input, dependencies = {}) => original(input, { ...dependencies, auditRecord: () => ({ durable: true }) });
    }
    state.health();
    const control = new ResearchControl({ state, gate, auditRequire: () => ({ durable: true }) });
    const { project } = control.projectSave({ actor: 'human', name: 'Inert policy consumer', enabled: true });
    const submitted = control.runSubmit({ actor: 'human', experiment: {
      projectId: project.projectId, name: 'Inert native preparation', runnerKind: 'process',
      runnerConfig: { command: process.execPath, args: [], stdin: 'none' },
      resultSchema: { fields: { value: 'number' }, required: ['value'] },
      collector: { kind: 'none' }, timeoutMs: 1000
    }, params: {} });
    fixture = ownedFixture(platform, { receipt, prepare: () => {
      control.projectSave({ actor: 'human', projectId: project.projectId, enabled: false });
    } });
    worker = new ResearchRunsWorker({ state, gate, artifactRoot: path.join(directory, 'artifacts'),
      pauseMs: 1000, heartbeatIntervalMs: 3600000,
      runProcess: input => runners.runProcess(input, fixture.dependencies), runAgent: inert, runHttp: inert, collect: inert });
    const claim = await tasks.claim({ queue: 'research-runs', types: ['research-run'],
      workerLabel: worker.workerLabel, leaseSeconds: 300 }, { state: worker.state });
    assert.equal(claim.claimed, true);
    await worker._execute(claim);
    const task = state.transaction(db => db.prepare('SELECT status, error_code FROM tasks WHERE id = ?').get(submitted.run.taskId));
    const count = state.transaction(db => db.prepare('SELECT COUNT(*) AS n FROM research_results WHERE run_id = ?').get(submitted.run.runId).n);
    assert.equal(fixture.observed.rootAdmissions, 0);
    assert.equal(count, 0);
    assert.equal(worker.activeController, null);
    if (receipt === 'valid') {
      assert.equal(task.status, 'retry_wait');
      assert.equal(task.error_code, POLICY_CODE);
      assert.equal(worker.cleanupBlocked, false);
      assert.equal(worker.stopped, false);
    } else {
      assert.equal(task.status, 'failed');
      assert.equal(task.error_code, 'RESEARCH_RUN_CLEANUP_UNPROVEN');
      assert.equal(worker.cleanupBlocked, true);
      assert.equal(worker.stopped, true);
    }
  } finally {
    worker?.stop();
    fixture?.dispose();
    for (const [name, original] of originals) tasks[name] = original;
    assert.equal(state.close(), true, 'Close the actual disposable SQLite connection.');
  }
}

for (const platform of ['linux', 'win32']) {
  for (const receipt of ['valid', 'rejected']) {
    test(`${platform}: actual task consumer ${receipt === 'valid' ? 'pauses a proved non-start' : 'holds unproved cleanup'}`,
      () => workerFixture(platform, receipt));
  }
}

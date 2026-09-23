'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../src/lib/state-store');
const taskService = require('../src/lib/providers/tasks');
const { DelegationTaskProjectionError, submitDelegatedTask } = require('../src/lib/delegation-task-projection');
const { observeDelegatedTask } = require('../src/lib/delegation-task-observation');

const hash = character => character.repeat(64);
const task = {
  schemaVersion: 1,
  delegationId: 'dlg_abcdefghijklmnop',
  goalId: 'gateway-goal',
  phaseId: 'read-observation',
  role: 'read_only_review',
  baseSnapshot: { rootId: 'fixture-root', commitSha1: 'a'.repeat(40), treeSha256: hash('b') },
  acceptanceCriteria: ['fixture-complete'],
  capabilityProfileHash: hash('c'),
  budgets: { maxWallMs: 120_000, maxModelTokens: 0, maxToolCalls: 0, maxEvidenceBytes: 4_096 },
  terminalStates: ['complete', 'blocked', 'failed']
};

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-delegation-observation-'));
  let sequence = 0;
  const state = createStateStore({
    file: path.join(directory, 'state.sqlite3'),
    ownerId: 'delegation-observation-test',
    clock: () => Date.UTC(2026, 6, 29, 14, 0, 0),
    idFactory: prefix => `${prefix}-${String(++sequence).padStart(4, '0')}`
  });
  const dependencies = { state };
  try {
    const submitted = await submitDelegatedTask(taskService, task, { idempotencyKey: 'observation-key-01', queue: 'verify', type: 'projection' }, dependencies);
    assert.equal(submitted.taskId, 'task-0001');

    const observation = await observeDelegatedTask(taskService, submitted.taskId, task, dependencies);
    assert.equal(Object.isFrozen(observation), true);
    assert.equal(Object.isFrozen(observation.projection), true);
    assert.equal(observation.taskId, submitted.taskId);
    assert.equal(observation.status, 'queued');
    assert.equal(observation.maxAttempts, 1);
    assert.equal(observation.expiryPolicy, 'uncertain');
    assert.equal(observation.leaseExpiresAtMs, null);
    assert.equal(observation.cancellationRequested, false);
    assert.equal(observation.contentTrust, 'untrusted');
    assert.equal(observation.grantsAuthority, false);
    assert.equal(observation.payload, undefined);
    assert.equal(observation.result, undefined);
    assert.equal(observation.error, undefined);
    assert.equal(observation.projection.delegationId, task.delegationId);
    assert.equal(JSON.stringify(observation).includes('gateway-goal'), false);
    assert.equal(JSON.stringify(observation).includes('fixture-complete'), false);

    let serviceGetterCalls = 0;
    const accessorService = {};
    Object.defineProperty(accessorService, 'get', {
      enumerable: true,
      get() { serviceGetterCalls += 1; return taskService.get; }
    });
    await assert.rejects(
      observeDelegatedTask(accessorService, submitted.taskId, task, dependencies),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_OBSERVATION_INVALID'
    );
    assert.equal(serviceGetterCalls, 0, 'task service getters must not run');

    let serviceProxyGets = 0;
    const proxyService = new Proxy({ get: (...args) => taskService.get(...args) }, {
      get() { serviceProxyGets += 1; throw new Error('task service get trap must not run'); }
    });
    assert.equal((await observeDelegatedTask(proxyService, submitted.taskId, task, dependencies)).taskId,
      submitted.taskId);
    assert.equal(serviceProxyGets, 0, 'valid task service proxies must be read from descriptors');

    const canonicalTask = await taskService.get({ taskId: submitted.taskId, includePayload: true }, dependencies);
    let taskGetterCalls = 0;
    const accessorTask = { ...canonicalTask };
    Object.defineProperty(accessorTask, 'status', {
      enumerable: true,
      get() { taskGetterCalls += 1; return 'queued'; }
    });
    await assert.rejects(
      observeDelegatedTask({ get: async () => accessorTask }, submitted.taskId, task, dependencies),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_OBSERVATION_INVALID'
    );
    assert.equal(taskGetterCalls, 0, 'canonical task metadata getters must not run');

    let taskProxyGets = 0;
    const proxyTask = new Proxy(canonicalTask, {
      get(target, key) {
        // Await performs one language-level thenable probe before the
        // observation boundary receives the value.
        if (key === 'then') return undefined;
        taskProxyGets += 1;
        throw new Error('canonical task get trap must not run');
      }
    });
    assert.equal((await observeDelegatedTask({ get: async () => proxyTask }, submitted.taskId, task, dependencies)).taskId,
      submitted.taskId);
    assert.equal(taskProxyGets, 0, 'valid canonical task proxies must be read from descriptors');

    await assert.rejects(
      observeDelegatedTask(taskService, 'task-9999', task, dependencies),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_OBSERVATION_NOT_FOUND'
    );
    await assert.rejects(
      observeDelegatedTask(taskService, 'bad id', task, dependencies),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_OBSERVATION_INVALID'
    );
    const stale = { ...task, capabilityProfileHash: hash('d') };
    await assert.rejects(
      observeDelegatedTask(taskService, submitted.taskId, stale, dependencies),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_STALE_OR_MISMATCHED'
    );

    // A generic task is not an observation target even if the canonical store
    // can read it: without an exact opaque projection it fails closed.
    const generic = await taskService.submit({
      queue: 'verify', type: 'generic', idempotencyKey: 'generic-task-01',
      payload: { title: 'generic', objective: 'generic', context: 'untrusted generic context' },
      expiryPolicy: 'uncertain', maxAttempts: 1
    }, dependencies);
    await assert.rejects(
      observeDelegatedTask(taskService, generic.taskId, task, dependencies),
      error => error instanceof DelegationTaskProjectionError && error.code === 'DELEGATION_TASK_PROJECTION_INVALID'
    );

    const source = fs.readFileSync(path.join(__dirname, '../src/lib/delegation-task-observation.js'), 'utf8');
    assert.equal(/\bconsole\./.test(source), false, 'observation may not log canonical task content');
    for (const forbidden of ['state-store', 'providers/tasks', 'tool-registry', 'browser-owner', 'credential-metadata', 'audit-store']) {
      assert.equal(new RegExp(`require\\(['\"](?:\\./)?${forbidden.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}['\"]\\)`).test(source), false, `unexpected runtime import: ${forbidden}`);
    }
    for (const method of ['submit', 'list', 'claim', 'start', 'heartbeat', 'checkpoint', 'complete', 'fail', 'cancel']) {
      assert.equal(source.includes(`taskService.${method}`), false, `forbidden task call: ${method}`);
    }

    console.log('delegation task observation: all tests passed');
  } finally {
    state.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

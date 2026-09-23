/*
 * Mutation check: changed `candidate.name === processEntry.id` to `!==` in scheduling-status.js.
 * The mutation landed: yes (the edited expression was found in the module).
 * The isolated test went red: yes (exit 1; matching durable-job assertion failed).
 * The module was restored to its pre-mutation SHA-256 before the green run.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  digestSchedulingStatus,
  schedulerOwnership,
  windowsTaskObservation
} = require('../src/lib/agent-digest/scheduling-status');

const PROCESS = Object.freeze({ id: 'agent-digest', taskName: '\\ToolsEnabled\\AgentDigest' });

test('schedulerOwnership distinguishes matching durable jobs from an empty inventory', () => {
  assert.deepEqual(schedulerOwnership(PROCESS, {
    listSchedulerJobs: () => [{
      name: 'agent-digest',
      providerState: 'ACTIVE',
      activeGeneration: 'generation-7'
    }]
  }), {
    ownership: 'scheduler-owned',
    jobName: 'agent-digest',
    providerState: 'ACTIVE',
    activeGeneration: 'generation-7'
  });

  assert.deepEqual(schedulerOwnership(PROCESS, { listSchedulerJobs: () => [] }), {
    ownership: 'not-scheduler-owned',
    reason: 'No durable scheduler.* job is recorded for agent-digest. This does not change the Windows-task observation.'
  });
});

test('schedulerOwnership reports invalid and unreadable inventories without throwing', () => {
  assert.deepEqual(schedulerOwnership(PROCESS, { listSchedulerJobs: () => ({}) }), {
    ownership: 'unknown',
    code: 'SCHEDULER_INVENTORY_INVALID',
    reason: 'The durable scheduler inventory could not be read, so scheduler ownership is unknown.'
  });

  assert.deepEqual(schedulerOwnership(PROCESS, {
    listSchedulerJobs: () => { throw Object.assign(new Error('offline'), { code: 'INVALID CODE!' }); }
  }), {
    ownership: 'unknown',
    code: 'SCHEDULER_INVENTORY_UNREADABLE',
    reason: 'The durable scheduler inventory could not be read, so scheduler ownership is unknown.'
  });
});

test('windowsTaskObservation reports registered, absent, unavailable, and inapplicable tasks', () => {
  assert.deepEqual(windowsTaskObservation(PROCESS, {
    collectScheduledTasks: names => {
      assert.deepEqual(names, [PROCESS.taskName]);
      return new Map([[PROCESS.taskName, { state: 'READY' }]]);
    }
  }), { registration: 'registered', taskName: PROCESS.taskName, state: 'READY' });

  assert.deepEqual(windowsTaskObservation(PROCESS, {
    collectScheduledTasks: () => new Map()
  }), {
    registration: 'not-registered',
    taskName: PROCESS.taskName,
    reason: 'The declared Windows task is absent. The digest cannot self-restart after a crash or reboot.'
  });

  assert.deepEqual(windowsTaskObservation(PROCESS, {
    collectScheduledTasks: () => undefined
  }), {
    registration: 'unknown',
    taskName: PROCESS.taskName,
    reason: 'The Windows Task Scheduler could not be read, so task registration is unknown.'
  });

  assert.deepEqual(windowsTaskObservation({ id: 'agent-digest' }), {
    registration: 'not-applicable',
    taskName: null,
    reason: 'agent-digest declares no Windows task.'
  });
});

test('windowsTaskObservation preserves safe failure codes and replaces unsafe ones', () => {
  const observeFailure = code => windowsTaskObservation(PROCESS, {
    collectScheduledTasks: () => { throw Object.assign(new Error('failed'), { code }); }
  });

  assert.equal(observeFailure('TASK_API_OFFLINE').code, 'TASK_API_OFFLINE');
  assert.equal(observeFailure('unsafe code').code, 'SCHEDULED_TASK_OBSERVATION_FAILED');
  assert.equal(observeFailure('x'.repeat(201)).code, 'SCHEDULED_TASK_OBSERVATION_FAILED');
});

test('digestSchedulingStatus composes independent Windows-task and scheduler truths', () => {
  const status = digestSchedulingStatus({
    getProcess: id => {
      assert.equal(id, 'agent-digest');
      return PROCESS;
    },
    collectScheduledTasks: () => new Map([[PROCESS.taskName, { state: 'RUNNING' }]]),
    listSchedulerJobs: () => []
  });

  assert.deepEqual(status, {
    declared: true,
    task: { registration: 'registered', taskName: PROCESS.taskName, state: 'RUNNING' },
    scheduler: {
      ownership: 'not-scheduler-owned',
      reason: 'No durable scheduler.* job is recorded for agent-digest. This does not change the Windows-task observation.'
    }
  });
});

test('digestSchedulingStatus converts an invalid declaration into a bounded unknown result', () => {
  assert.deepEqual(digestSchedulingStatus({ getProcess: () => ({ id: 'another-process' }) }), {
    declared: 'unknown',
    task: {
      registration: 'unknown',
      taskName: null,
      code: 'AGENT_DIGEST_PROCESS_DECLARATION_INVALID'
    },
    scheduler: { ownership: 'unknown', code: 'AGENT_DIGEST_PROCESS_DECLARATION_INVALID' }
  });

  assert.deepEqual(digestSchedulingStatus({
    getProcess: () => { throw Object.assign(new Error('bad'), { code: 'not safe' }); }
  }), {
    declared: 'unknown',
    task: {
      registration: 'unknown',
      taskName: null,
      code: 'AGENT_DIGEST_PROCESS_DECLARATION_UNREADABLE'
    },
    scheduler: { ownership: 'unknown', code: 'AGENT_DIGEST_PROCESS_DECLARATION_UNREADABLE' }
  });
});

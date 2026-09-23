'use strict';

// Read-only scheduling truth for the agent digest.
//
// The digest predates the durable scheduler API and is currently kept alive by
// its own named Windows task. A present Windows task therefore proves only
// task-script registration; it must never be rendered as a scheduler.*-owned
// job. Conversely, an empty scheduler inventory says nothing about whether the
// Windows task is running. Keep both facts in one compact projection.

const managedProcesses = require('../managed-processes');
const observer = require('../supervision/observer');
const { getStateStore } = require('../state-store');

function safeCode(error, fallback) {
  const code = error && error.code;
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(code) ? code : fallback;
}

function schedulerOwnership(processEntry, { listSchedulerJobs } = {}) {
  try {
    const list = listSchedulerJobs || (() => getStateStore().listSchedulerJobs({ includeRemoved: false, limit: 500 }));
    const jobs = list();
    if (!Array.isArray(jobs)) throw Object.assign(new Error('Scheduler inventory was not an array.'), { code: 'SCHEDULER_INVENTORY_INVALID' });
    const job = jobs.find(candidate => candidate && candidate.name === processEntry.id) || null;
    return job
      ? {
        ownership: 'scheduler-owned',
        jobName: job.name,
        providerState: job.providerState || null,
        activeGeneration: job.activeGeneration || null
      }
      : {
        ownership: 'not-scheduler-owned',
        reason: 'No durable scheduler.* job is recorded for agent-digest. This does not change the Windows-task observation.'
      };
  } catch (error) {
    return {
      ownership: 'unknown',
      code: safeCode(error, 'SCHEDULER_INVENTORY_UNREADABLE'),
      reason: 'The durable scheduler inventory could not be read, so scheduler ownership is unknown.'
    };
  }
}

function windowsTaskObservation(processEntry, { collectScheduledTasks } = {}) {
  if (!processEntry || !processEntry.taskName) {
    return { registration: 'not-applicable', taskName: null, reason: 'agent-digest declares no Windows task.' };
  }
  try {
    const collect = collectScheduledTasks || observer.collectScheduledTasks;
    const tasks = collect([processEntry.taskName]);
    if (tasks === undefined) {
      return {
        registration: 'unknown', taskName: processEntry.taskName,
        reason: 'The Windows Task Scheduler could not be read, so task registration is unknown.'
      };
    }
    const task = tasks.get(processEntry.taskName) || null;
    return task
      ? { registration: 'registered', taskName: processEntry.taskName, state: task.state || 'UNKNOWN' }
      : {
        registration: 'not-registered', taskName: processEntry.taskName,
        reason: 'The declared Windows task is absent. The digest cannot self-restart after a crash or reboot.'
      };
  } catch (error) {
    return {
      registration: 'unknown', taskName: processEntry.taskName,
      code: safeCode(error, 'SCHEDULED_TASK_OBSERVATION_FAILED'),
      reason: 'The Windows Task Scheduler could not be read, so task registration is unknown.'
    };
  }
}

function digestSchedulingStatus(options = {}) {
  let processEntry;
  try {
    processEntry = (options.getProcess || managedProcesses.getProcess)('agent-digest');
    if (!processEntry || typeof processEntry !== 'object' || processEntry.id !== 'agent-digest') {
      throw Object.assign(new Error('The agent-digest process declaration was invalid.'), {
        code: 'AGENT_DIGEST_PROCESS_DECLARATION_INVALID'
      });
    }
  } catch (error) {
    const code = safeCode(error, 'AGENT_DIGEST_PROCESS_DECLARATION_UNREADABLE');
    return {
      declared: 'unknown',
      task: { registration: 'unknown', taskName: null, code },
      scheduler: { ownership: 'unknown', code }
    };
  }
  return {
    declared: true,
    task: windowsTaskObservation(processEntry, options),
    scheduler: schedulerOwnership(processEntry, options)
  };
}

module.exports = { digestSchedulingStatus, schedulerOwnership, windowsTaskObservation };

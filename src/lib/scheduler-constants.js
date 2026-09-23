'use strict';

// Task Scheduler terminates an invocation before durable overlap recovery may
// release its run fence. The one-hour margin prevents a still-running process
// from overlapping a later generation after an abrupt runner exit.
const SCHEDULER_TASK_EXECUTION_LIMIT = 'PT23H';
const SCHEDULER_RUN_RECOVERY_MS = 24 * 60 * 60 * 1000;

module.exports = { SCHEDULER_RUN_RECOVERY_MS, SCHEDULER_TASK_EXECUTION_LIMIT };

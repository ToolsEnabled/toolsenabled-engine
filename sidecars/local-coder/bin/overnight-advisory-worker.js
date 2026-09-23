#!/usr/bin/env node
'use strict';

const { OvernightAdvisoryWorker, workerId } = require('../src/overnight-advisory-worker');

const worker = new OvernightAdvisoryWorker({
  workerLabel: process.env.OVERNIGHT_ADVISORY_WORKER_LABEL || workerId(),
  onEvent: event => {
    // Never log prompt text, model output, durable handles, credentials, or
    // private data from the queue.  This is only lifecycle observability.
    process.stdout.write(`${JSON.stringify({ type: event.type, taskId: event.taskId, reason: event.reason, code: event.code, phases: event.phases })}\n`);
  }
});

const stop = () => worker.stop();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

worker.runForever().catch(error => {
  process.stderr.write(`Overnight advisory worker stopped: ${String(error && error.message || error).replace(/\s+/g, ' ').slice(0, 500)}\n`);
  process.exitCode = 1;
});

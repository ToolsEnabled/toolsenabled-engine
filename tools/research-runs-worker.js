'use strict';

// Entry point for the research-runs worker process. Started and stopped only
// through the research lifecycle control (no scheduled task in v1, and never
// at logon — autostart stays opt-in elsewhere by standing order).

const { ResearchRunsWorker } = require('../src/lib/research/research-runs-worker');
const { closeStateStore } = require('../src/lib/state-store');
const { runSupervisedWorker } = require('../src/lib/research/worker-protocol');

let worker = null;
const stopController = new AbortController();
const createWorker = () => (worker = new ResearchRunsWorker({
  onEvent: event => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  }
}));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopController.abort();
    worker?.stop();
    // stop wakes an idle wait and aborts the active runner. Let runForever
    // await bounded cleanup instead of exiting before the native receipt.
  });
}

// No DB is opened and no research is admitted before the retained supervisor's
// private start command. Legacy direct CLI execution remains explicitly unowned.
const args = process.argv.slice(2);
const supervised = args.length === 1 && args[0] === '--supervised-stdio';
const run = args.length && !supervised
  ? Promise.reject(Object.assign(new Error('Research worker arguments are invalid.'), { code: 'RESEARCH_WORKER_ARGUMENT_INVALID' }))
  : supervised
    ? runSupervisedWorker({ createWorker, closeDatabase: closeStateStore, signal: stopController.signal })
    : createWorker().runForever().finally(() => closeStateStore());
run.then(
  () => { process.exitCode = worker?.cleanupBlocked ? 1 : 0; },
  error => {
    process.stderr.write(`${error?.code || 'RESEARCH_WORKER_FAILED'}\n`);
    process.exitCode = 1;
  }
);

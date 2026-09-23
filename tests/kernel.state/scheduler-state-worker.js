'use strict';

const { createStateStore } = require('../../src/lib/state-store');

const [file, name] = process.argv.slice(2);
if (!file || !name) throw new Error('Usage: scheduler-state-worker.js <database> <name>');

const store = createStateStore({ file, busyTimeoutMs: 10000 });
try {
  const created = store.putSchedulerJob({
    name,
    schedule: 'hourly',
    // ACTION CHANGED 2026-08-23: 'telegram.send' left SUPPORTED_SCHEDULED_ACTIONS
    // with the Telegram connector. This worker exists to prove the job cap is atomic
    // across processes, which is indifferent to WHICH allowlisted action is used --
    // it just needs one the allowlist still contains. It must stay in step with
    // tests/kernel.state/scheduler-state.js's own fixture action.
    action: 'gmail.send',
    args: { to: 'owner@example.invalid', subject: name },
    runtime: {
      nodePath: process.execPath,
      runnerPath: require('node:path').resolve(__dirname, '..', '..', 'src', 'job-runner.js'),
      principalId: 'S-1-5-21-111111111-222222222-333333333-1002'
    },
    maxScheduledJobs: 1
  });
  process.stdout.write(`${JSON.stringify({ ok: true, jobId: created.job.jobId })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'ERROR' })}\n`);
} finally {
  store.close();
}

'use strict';

const { assertActive } = require('./lib/policy');
const audit = require('./lib/audit');
const { getStateStore, StateStoreError } = require('./lib/state-store');
const { SUPPORTED_SCHEDULED_ACTIONS } = require('./lib/scheduled-actions');
const { assertValid } = require('./lib/schema-validator');
const { unattendedSession } = require('./lib/dispatch-permission-session');

const FLAGS = Object.freeze({
  '--installation-id': 'installationId',
  '--job-id': 'jobId',
  '--generation': 'generation',
  '--ownership-marker': 'ownershipMarker'
});

function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError('Runner arguments must be an array.');
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const field = FLAGS[flag];
    if (!field || index + 1 >= argv.length || parsed[field] !== undefined) throw new Error(`Invalid scheduled-runner argument '${flag || ''}'.`);
    parsed[field] = argv[index + 1];
  }
  for (const field of Object.values(FLAGS)) if (parsed[field] === undefined || parsed[field] === '') throw new Error(`Scheduled-runner argument ${field} is required.`);
  if (!/^[a-f0-9]{32}$/.test(parsed.installationId)) throw new Error('Scheduled-runner installationId is invalid.');
  if (!/^scheduler-job-[A-Za-z0-9-]{1,180}$/.test(parsed.jobId)) throw new Error('Scheduled-runner jobId is invalid.');
  if (!/^\d+$/.test(parsed.generation)) throw new Error('Scheduled-runner generation is invalid.');
  parsed.generation = Number(parsed.generation);
  if (!Number.isSafeInteger(parsed.generation) || parsed.generation < 1) throw new Error('Scheduled-runner generation is invalid.');
  if (!/^[a-f0-9]{64}$/.test(parsed.ownershipMarker)) throw new Error('Scheduled-runner ownershipMarker is invalid.');
  return parsed;
}

function staleInvocation(error) {
  return error instanceof StateStoreError && [
    'SCHEDULER_STALE_INVOCATION', 'SCHEDULER_INSTALLATION_MISMATCH', 'SCHEDULER_OWNERSHIP_MISMATCH',
    'SCHEDULER_RUN_OVERLAP'
  ].includes(error.code);
}

function schedulerActionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateScheduledAction(action, args, dependencies = {}) {
  if (!SUPPORTED_SCHEDULED_ACTIONS.includes(action)) {
    throw schedulerActionError('SCHEDULER_ACTION_UNSUPPORTED', 'The stored scheduler action is not allowlisted.');
  }
  const getTool = dependencies.getTool || (name => require('./lib/tool-registry').getTool(name));
  const target = getTool(action);
  if (!target || target.effect !== 'external-write') {
    throw schedulerActionError('SCHEDULER_ACTION_INVALID', 'The stored scheduler action is unavailable or has an invalid effect classification.');
  }
  if (args && typeof args === 'object' && Object.prototype.hasOwnProperty.call(args, 'approvalToken')) {
    throw schedulerActionError('SCHEDULER_ACTION_INVALID', 'Stored scheduler arguments must not contain an approval token.');
  }
  // '' (no root label), not '$.arguments': `args` is the durable row's own
  // flat target-tool arguments, the exact object a direct dispatch through
  // tool-registry.js#executeTool would validate -- there is no enclosing
  // "arguments" field on gmail.send (or any other SUPPORTED_SCHEDULED_ACTIONS
  // target) to name. MEASURED 2026-09-03 by direct call: validateAction(
  // 'gmail.send', { to: 'x' }) came back "Invalid input: $.arguments.subject:
  // is required" -- gmail.send's own schema calls that field `subject`, at
  // the top level, and this is the message a failed scheduled run persists
  // via completeSchedulerRun() below for the owner to read. This is the same
  // hardcoded '$.arguments' root already fixed at its sibling call site,
  // providers/scheduler.js#validateAction (create-time validation of the same
  // target schema) -- this one is the run-time re-validation and was missed.
  (dependencies.assertValid || assertValid)(target.baseInputSchema || target.inputSchema, args, { path: '' });
  return target;
}

async function runScheduledInvocation(selector, dependencies = {}) {
  const store = dependencies.state || getStateStore();
  const guard = dependencies.assertActive || assertActive;
  const recorder = dependencies.audit || audit;
  const execute = dependencies.executeTool || ((name, args, context) => require('./lib/tool-registry').executeTool(name, args, context));

  guard('scheduler.job');
  if (typeof store.reapExpiredSchedulerRuns === 'function') store.reapExpiredSchedulerRuns({});
  let started;
  try {
    started = store.startSchedulerRun(selector);
  } catch (error) {
    if (!staleInvocation(error)) throw error;
    recorder.record('scheduler.run.skipped', selector.jobId, { generation: selector.generation, code: error.code });
    return { skipped: true, jobId: selector.jobId, generation: selector.generation, code: error.code };
  }

  const job = started.job;
  // The mutable job row can already contain a pending replacement. Execute
  // only the immutable definition attached to the generation that was
  // atomically admitted by startSchedulerRun.
  const action = started.action;
  const args = started.args;
  try {
    // The state store validates durable registration integrity. Re-check the
    // canonical scheduled-action authority and live schema here before even an
    // injected executor can receive a call.
    validateScheduledAction(action, args, dependencies);
    // THE UNATTENDED PATH GETS THE NARROWEST CEILING, NOT THE ABSENT ONE.
    //
    // This call passed no permission session at all, so the tier check in
    // tool-registry.js#executeTool() never ran for it -- on the one path with
    // nobody watching, executing arguments read back out of a database. That is
    // the worst place in the product for a missing ceiling.
    //
    // Scheduled work is deliberately MORE constrained than interactive work:
    // unattendedSession() clamps a local `full` owner session down to
    // confined/workspace, which still admits every one of the eight
    // SUPPORTED_SCHEDULED_ACTIONS (all `external-write`) while permanently
    // refusing host.exec, the clipboard, and the raw host/repo file surface. A
    // recorded level that is already narrower is honoured as-is and never
    // widened. See src/lib/dispatch-permission-session.js for the reasoning.
    //
    // Not caller-selectable on purpose: `action` and `args` are durable state,
    // and a ceiling that travelled with them could be raised by whatever wrote
    // the row.
    await execute(action, args, {
      requestId: `scheduler:${started.runId}`,
      internal: 'scheduler-runner-v1',
      permissionSession: unattendedSession(dependencies)
    });
  } catch (error) {
    const message = recorder.redact(error && (error.message || String(error))).slice(0, 1000) || 'Scheduled action failed.';
    try {
      store.completeSchedulerRun({ runId: started.runId, fence: started.fence }, {
        status: 'failed', code: String(error.code || 'SCHEDULED_ACTION_FAILED').slice(0, 200), message
      });
    } catch (completionError) {
      recorder.record('scheduler.run.persistence_failed', job.name, {
        runId: started.runId, generation: selector.generation, action,
        error: recorder.redact(completionError.message || String(completionError))
      });
    }
    recorder.record('scheduler.run', job.name, { runId: started.runId, generation: selector.generation, action, success: false, error: message });
    throw error;
  }

  // A successful action and a successfully persisted outcome are separate
  // facts. If the terminal write cannot be established, do not feed that
  // persistence error through the action-failure path and record a definite
  // negative answer about an action that actually completed.
  try {
    store.completeSchedulerRun({ runId: started.runId, fence: started.fence }, {
      status: 'succeeded', result: { success: true, action }
    });
  } catch (completionError) {
    recorder.record('scheduler.run.persistence_failed', job.name, {
      runId: started.runId, generation: selector.generation, action, outcome: 'succeeded',
      error: recorder.redact(completionError.message || String(completionError))
    });
    throw completionError;
  }

  // The effect and its durable success record are already committed. Audit is
  // best-effort here so an audit sink failure cannot report the invocation as
  // failed and induce a retry of the external write.
  try {
    recorder.record('scheduler.run', job.name, { runId: started.runId, generation: selector.generation, action, success: true });
  } catch (_) {}
  return { skipped: false, success: true, runId: started.runId, jobId: job.jobId, generation: selector.generation, action };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const selector = parseArguments(argv);
  const result = await runScheduledInvocation(selector, dependencies);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${audit.redact(error && (error.stack || error.message || String(error)))}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments, runScheduledInvocation, validateScheduledAction };

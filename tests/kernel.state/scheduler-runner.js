// NOTHING FOUND
//
// Assertion discrimination report (testcanfail-tests-kernel-state-scheduler-runner-js):
// - NOT-FOUND (1): there are no assertion-bearing loops or forEach calls, so no
//   assertion can be bypassed by an empty collection.
// - NOT-FOUND (2): the test does not spawn a process or assert an exit status or
//   an otherwise-unqualified truthy process return.
// - NOT-FOUND (3): the test's outer try/finally only performs cleanup and its
//   terminal catch reports the error and sets a failing exit code. The audit-sink
//   failure is deliberately absorbed by the subject and is followed by direct
//   assertions on the returned result, effect count, and persisted run status.
// - NOT-FOUND (4): injected executors, audit recorder, active-policy guard, and
//   tool metadata are dependency boundaries; assertions measure the runner's
//   calls, state transitions, validation, and error handling rather than those
//   fakes' implementations.
// - NOT-FOUND (5): there are no skips or platform precondition guards.
// - NOT-FOUND (6): expected values are literals or independently queried state;
//   none is computed by parseArguments, validateScheduledAction, or
//   runScheduledInvocation and then used to check that same operation.
// - MUTATIONS: none applied because the census found no suspect assertion to
//   strengthen. Consequently there is no RED assertion output to quote.
// - UNMET PRECONDITION: executable mutation and restoration runs require Node
//   >=22.19.0 (node:sqlite); this environment provides Node 20.20.2. The attempted
//   baseline command failed while loading the fixture with
//   "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite".

'use strict';

require('../lib/isolated-environment').activate('scheduler-runner');

/* A SEALED MACHINE RECORD IN THE SCRATCH IDENTITY, BUILT THE PRODUCT'S WAY.
 *
 * The runner's dispatch path ends at dispatch-permission-session's
 * unattendedSession(), which reads the machine record and REFUSES without one:
 * "a level the product could not establish would turn 'not measured' into a
 * definite permission answer." That refusal is correct, and it is why this
 * suite went red the moment the isolated harness stopped borrowing the real
 * machine's identity (fe452d3): the scratch root is honest about having no
 * installation, and a scheduled job may never guess its level.
 *
 * So the test RECORDS one, through the product's own creation path --
 * buildMachineRecord/writeMachineRecord, the exact calls first-run setup makes
 * -- at the services root the harness identity resolves to. Tier `standard`,
 * copying tests/entry/task-stdio.js:57: the narrowest tier permitting the
 * local writes a scheduler legitimately performs, and unattendedSession clamps
 * anything wider to the same ceiling anyway, so no broader tier could change
 * what this suite measures.
 *
 * THIS IS NOT INVENTED INSTALLATION STATE. Nothing here fabricates the OWNER'S
 * topology, registry or credentials -- it constructs a throwaway install
 * inside the test's own scratch identity, exactly as task-stdio and the
 * confinement suite already do at their own roots. The distinction that
 * matters: a fixture the product's own API builds in test space, versus a
 * hand-written record standing in for a real machine's.
 *
 * DELIBERATELY PER-SUITE, NOT IN THE SHARED HARNESS.
 * tests/permission-session-chokepoint.test.js asserts the no-record REFUSAL
 * against the ambient root -- a harness-global record would quietly convert
 * that suite's subject into a different machine. A blast check scoped by the
 * change's author missed exactly such a pair today; this stays opt-in so the
 * refusal path keeps a world to be true in. */
const __machineRecord = require('../../src/lib/setup/machine-record');
{
  const __servicesRoot = __machineRecord.resolveServicesRoot({});
  __machineRecord.writeMachineRecord(__machineRecord.buildMachineRecord({
    tier: 'standard',
    installRoot: require('node:path').resolve(__dirname, '..', '..'),
    servicesRoot: __servicesRoot,
    nodePath: process.execPath,
    workspaceRoots: [__servicesRoot]
  }), { servicesRoot: __servicesRoot });
}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../../src/lib/state-store');
const { parseArguments, runScheduledInvocation, validateScheduledAction } = require('../../src/job-runner');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-scheduler-runner-'));
let now = Date.UTC(2026, 6, 22, 12, 0, 0);
const store = createStateStore({ file: path.join(root, 'state.sqlite3'), clock: () => now, ownerId: 'runner-test' });
const runtime = {
  nodePath: process.execPath,
  runnerPath: path.resolve(__dirname, '..', '..', 'src', 'job-runner.js'),
  principalId: 'S-1-5-21-111111111-222222222-333333333-1001'
};
const events = [];
const recorder = {
  redact: value => String(value).replace(/sensitive/gi, 'REDACTED'),
  record: (event, target, details) => events.push({ event, target, details })
};

function activate(job) {
  const claim = store.claimSchedulerOutbox({ jobId: job.job.jobId });
  assert.equal(claim.claimed, true);
  store.completeSchedulerOutbox(claim.handle, { disposition: 'succeeded', observation: { state: 'present', exact: true } });
  return store.getSchedulerJob({ jobId: job.job.jobId });
}

function selector(registration) {
  return {
    installationId: registration.spec.installationId,
    jobId: registration.jobId,
    generation: registration.generation,
    ownershipMarker: registration.ownershipMarker
  };
}

(async () => {
try {
  const parsed = parseArguments([
    '--installation-id', 'a'.repeat(32), '--job-id', 'scheduler-job-abc',
    '--generation', '4', '--ownership-marker', 'b'.repeat(64)
  ]);
  assert.equal(parsed.generation, 4);
  assert.throws(() => parseArguments(['--job-id', 'scheduler-job-abc']), /required|argument/);
  assert.throws(() => parseArguments([
    '--installation-id', 'a'.repeat(32), '--job-id', 'scheduler-job-abc', '--generation', '1',
    '--ownership-marker', 'b'.repeat(64), '--extra', 'x'
  ]), /Invalid/);
  assert.throws(() => validateScheduledAction('drive.delete', {}, {
    getTool: () => ({ effect: 'external-write', inputSchema: { type: 'object' } })
  }), error => error.code === 'SCHEDULER_ACTION_UNSUPPORTED');
  // FIXTURE ACTION CHANGED 2026-08-23: these drove 'telegram.send' and
  // 'telegram.worker_run', which left SUPPORTED_SCHEDULED_ACTIONS with the Telegram
  // connector. 'gmail.send' is a surviving allowlisted external-write action, so the
  // three rules under test are unchanged: an allowlisted action whose TOOL is not
  // external-write is still refused, an allowlisted action with valid args is still
  // accepted, and an approval token still cannot ride into durable scheduler input.
  //
  // The 'durable Telegram ingress is intentionally schedulable' case is NOT replaced:
  // that classification was about telegram.worker_run specifically and there is no
  // equivalent ingress left to assert it of.
  assert.throws(() => validateScheduledAction('gmail.send', {}, {
    getTool: () => ({ effect: 'local-read', inputSchema: { type: 'object' } })
  }), error => error.code === 'SCHEDULER_ACTION_INVALID');
  assert.doesNotThrow(() => validateScheduledAction('gmail.send', { to: 'owner@example.invalid', subject: 'x' }));
  assert.throws(() => validateScheduledAction('gmail.send', {
    to: 'owner@example.invalid', subject: 'approval capabilities are not durable scheduler input', approvalToken: 'a'.repeat(43)
  }), /approval token/i);

  // A REQUIRED-FIELD REFUSAL FROM validateScheduledAction NAMES ONE OF THE
  // TARGET TOOL'S OWN FIELDS, NOT AN ENVELOPE THIS ROW NEVER HAD.
  //
  // No `getTool` override here: this exercises the real, unstubbed
  // gmail.send schema (required: ['to', 'subject']) through the production
  // require('./lib/tool-registry').getTool() path, the same schema
  // scheduler.create validates against at job-creation time -- see
  // tests/kernel.state/scheduler-provider.js's sibling assertion for that
  // call site. validateScheduledAction is the run-time re-validation
  // job-runner.js performs on every scheduled firing (see its own comment,
  // "Re-check the canonical scheduled-action authority and live schema here
  // before even an injected executor can receive a call"), and a message it
  // throws here is exactly what a failed run persists to the durable row via
  // completeSchedulerRun() for the owner to read.
  //
  // Exact equality, not a substring or /subject.*required/ pattern: before
  // this fix, schema-validator's hardcoded '$.arguments' root printed
  // "Invalid input: $.arguments.subject: is required" -- gmail.send has no
  // field spelled that way, only `subject` at the top level. A substring
  // check for merely "subject: is required" would stay GREEN with that
  // invented prefix still attached, which is exactly the defect this pins
  // against (src/job-runner.js#validateScheduledAction's assertValid call).
  assert.throws(
    () => validateScheduledAction('gmail.send', { to: 'owner@example.invalid' }),
    error => error && error.name === 'SchemaValidationError' && error.code === 'INVALID_PARAMS'
      && error.message === 'Invalid input: subject: is required'
  );

  const first = store.putSchedulerJob({
    name: 'runner', schedule: 'daily', action: 'gmail.send',
    args: { to: 'owner@example.invalid', subject: 'generation one' }, runtime, maxScheduledJobs: 5
  });
  let job = activate(first);
  const gen1 = job.registrations.find(item => item.generation === 1);
  const calls = [];
  const result = await runScheduledInvocation(selector(gen1), {
    state: store,
    assertActive() {},
    audit: recorder,
    executeTool: async (action, args, context) => { calls.push({ action, args, context }); return { provider: 'ignored' }; }
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls[0].args, { to: 'owner@example.invalid', subject: 'generation one' });
  assert.match(calls[0].context.requestId, /^scheduler:scheduler-run-/);
  assert.equal(calls[0].context.internal, 'scheduler-runner-v1');
  let runs = store.transaction(db => db.prepare('SELECT status, result_json FROM scheduler_runs ORDER BY started_at_ms, id').all());
  assert.equal(runs[0].status, 'succeeded');
  assert.doesNotMatch(runs[0].result_json, /provider/, 'Provider output is not persisted into scheduler history.');

  const auditFailureJob = store.putSchedulerJob({
    name: 'runner-audit-failure', schedule: 'daily', action: 'gmail.send',
    args: { to: 'owner@example.invalid', subject: 'audit failure' }, runtime, maxScheduledJobs: 5
  });
  const auditFailureRegistration = activate(auditFailureJob).registrations.find(item => item.generation === 1);
  let auditFailureEffects = 0;
  const auditFailureResult = await runScheduledInvocation(selector(auditFailureRegistration), {
    state: store,
    assertActive() {},
    audit: {
      redact: recorder.redact,
      record(event) {
        if (event === 'scheduler.run') throw new Error('audit sink unavailable');
      }
    },
    executeTool: async () => { auditFailureEffects += 1; }
  });
  assert.equal(auditFailureResult.success, true, 'Committed success is returned even when its audit record fails.');
  assert.equal(auditFailureEffects, 1, 'The scheduled external effect runs exactly once.');
  const auditFailureRun = store.transaction(db => db.prepare(
    'SELECT status FROM scheduler_runs WHERE job_id = ? ORDER BY started_at_ms DESC LIMIT 1'
  ).get(auditFailureResult.jobId));
  assert.equal(auditFailureRun.status, 'succeeded', 'Audit failure cannot rewrite a committed run as failed.');

  const persistenceEventsBefore = events.length;
  let terminalWriteAttempts = 0;
  await assert.rejects(runScheduledInvocation({ jobId: 'scheduler-job-persistence', generation: 1 }, {
    state: {
      reapExpiredSchedulerRuns() {},
      startSchedulerRun: () => ({
        runId: 'scheduler-run-persistence', fence: 1,
        job: { jobId: 'scheduler-job-persistence', name: 'persistence' },
        action: 'gmail.send', args: { to: 'owner@example.invalid', subject: 'completed action' }
      }),
      completeSchedulerRun() {
        terminalWriteAttempts += 1;
        throw new Error('terminal store unavailable');
      }
    },
    assertActive() {}, audit: recorder,
    executeTool: async () => ({ delivered: true })
  }), /terminal store unavailable/);
  assert.equal(terminalWriteAttempts, 1, 'A failed success write must not be retried as a definite action failure.');
  const persistenceEvents = events.slice(persistenceEventsBefore);
  assert.ok(persistenceEvents.some(item => item.event === 'scheduler.run.persistence_failed'
    && item.details.outcome === 'succeeded'));
  assert.equal(persistenceEvents.some(item => item.event === 'scheduler.run' && item.details.success === false), false,
    'An unavailable terminal store cannot turn a completed action into a definite negative outcome.');

  const replacement = store.putSchedulerJob({
    name: 'runner', schedule: 'hourly', action: 'gmail.send',
    args: { to: 'owner@example.invalid', subject: 'generation two' }, runtime, maxScheduledJobs: 5
  });
  job = store.getSchedulerJob({ jobId: replacement.job.jobId });
  assert.equal(job.activeGeneration, 1);
  calls.length = 0;
  await runScheduledInvocation(selector(gen1), {
    state: store, assertActive() {}, audit: recorder,
    executeTool: async (action, args) => calls.push({ action, args })
  });
  assert.deepEqual(calls[0].args, { to: 'owner@example.invalid', subject: 'generation one' }, 'Pending replacement cannot change the active generation arguments.');

  const gen2Claim = store.claimSchedulerOutbox({ jobId: job.jobId });
  assert.equal(gen2Claim.work.registration.generation, 2);
  store.completeSchedulerOutbox(gen2Claim.handle, { disposition: 'succeeded', observation: { state: 'present', exact: true } });
  job = store.getSchedulerJob({ jobId: job.jobId });
  assert.equal(job.activeGeneration, 2);
  calls.length = 0;
  const stale = await runScheduledInvocation(selector(gen1), {
    state: store, assertActive() {}, audit: recorder,
    executeTool: async () => { calls.push('unexpected'); }
  });
  assert.equal(stale.skipped, true);
  assert.equal(stale.code, 'SCHEDULER_STALE_INVOCATION');
  assert.deepEqual(calls, []);

  const gen2 = job.registrations.find(item => item.generation === 2);
  const blocker = store.startSchedulerRun(selector(gen2));
  const overlap = await runScheduledInvocation(selector(gen2), {
    state: store, assertActive() {}, audit: recorder,
    executeTool: async () => { calls.push('unexpected-overlap'); }
  });
  assert.equal(overlap.skipped, true, 'An already-running generation is an expected safe skip.');
  assert.equal(overlap.code, 'SCHEDULER_RUN_OVERLAP');
  assert.equal(calls.includes('unexpected-overlap'), false);
  store.completeSchedulerRun({ runId: blocker.runId, fence: blocker.fence }, {
    status: 'succeeded', result: { success: true, action: blocker.action }
  });

  now += 1;
  await assert.rejects(runScheduledInvocation(selector(gen2), {
    state: store, assertActive() {}, audit: recorder,
    executeTool: async () => { const error = new Error('sensitive provider failure'); error.code = 'PROVIDER_FAILED'; throw error; }
  }), /sensitive provider failure/);
  runs = store.transaction(db => db.prepare("SELECT status, error_code, error_message FROM scheduler_runs WHERE status = 'failed'").all());
  assert.equal(runs.length, 1);
  assert.equal(runs[0].error_code, 'PROVIDER_FAILED');
  assert.doesNotMatch(runs[0].error_message, /sensitive/i);
  assert.ok(events.some(item => item.event === 'scheduler.run.skipped'));

  store.removeSchedulerJob({ name: 'runner' });
  const removed = await runScheduledInvocation(selector(gen2), {
    state: store, assertActive() {}, audit: recorder,
    executeTool: async () => { throw new Error('must not run'); }
  });
  assert.equal(removed.skipped, true, 'Removal invalidates the active generation before OS cleanup.');

  const invalidDefinition = store.putSchedulerJob({
    name: 'runner-invalid-schema', schedule: 'daily', action: 'gmail.send',
    args: {}, runtime, maxScheduledJobs: 5
  });
  const invalidJob = activate(invalidDefinition);
  const invalidRegistration = invalidJob.registrations.find(item => item.generation === 1);
  let invalidExecutorCalls = 0;
  await assert.rejects(runScheduledInvocation(selector(invalidRegistration), {
    state: store, assertActive() {}, audit: recorder,
    executeTool: async () => { invalidExecutorCalls += 1; }
  }), /chatId|required/i);
  assert.equal(invalidExecutorCalls, 0, 'Live tool-schema validation runs before an injected executor.');

  process.stdout.write('scheduler runner tests passed\n');
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

if (process.env.TOOLSENABLED_WINDOWS_SCHEDULER_MUTATION_SMOKE !== '1') {
  process.stdout.write('scheduler Windows mutation smoke skipped (set TOOLSENABLED_WINDOWS_SCHEDULER_MUTATION_SMOKE=1 to enable)\n');
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('The Windows scheduler mutation smoke is available only on Windows.');

const audit = require('../src/lib/audit');
const { assertActive } = require('../src/lib/policy');
const {
  createWindowsSchedulerAdapter,
  resolveCurrentPrincipalId
} = require('../src/lib/scheduler-adapter');

const schedule = process.env.TOOLSENABLED_SCHEDULER_SMOKE_SCHEDULE || 'daily';
if (!['daily', 'hourly', 'minutes'].includes(schedule)) throw new Error('TOOLSENABLED_SCHEDULER_SMOKE_SCHEDULE must be daily, hourly, or minutes.');
const installationId = crypto.randomBytes(16).toString('hex');
const jobId = `scheduler-job-smoke-${schedule}-${crypto.randomUUID()}`;
const generation = 1;
const taskName = `\\ToolsEnabled-v2-${installationId.slice(0, 12)}-${crypto.createHash('sha256').update(jobId, 'utf8').digest('hex').slice(0, 16)}-g${generation}`;
const spec = {
  version: 1,
  installationId,
  jobId,
  generation,
  taskName,
  ownershipMarker: crypto.randomBytes(32).toString('hex'),
  nodePath: process.execPath,
  runnerPath: path.resolve(__dirname, '..', 'src', 'job-runner.js'),
  principalId: resolveCurrentPrincipalId(),
  schedule,
  intervalMinutes: schedule === 'minutes' ? 7 : null,
  action: 'telegram.send',
  args: { chatId: 'scheduler-smoke', text: 'This definition must never reach provider execution.' }
};
const adapter = createWindowsSchedulerAdapter();

function nextRunTimeMs() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$service = New-Object -ComObject 'Schedule.Service'",
    '$service.Connect()',
    "$task = $service.GetFolder('\\').GetTask($env:TOOLSENABLED_SMOKE_TASK_NAME)",
    "[Console]::Out.Write($task.NextRunTime.ToUniversalTime().ToString('o'))"
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, TOOLSENABLED_SMOKE_TASK_NAME: taskName }
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, String(result.stderr || 'Task Scheduler next-run query failed.'));
  const parsed = Date.parse(String(result.stdout).trim());
  assert.ok(Number.isFinite(parsed), `Task Scheduler returned an invalid next-run time: ${String(result.stdout).trim()}`);
  return parsed;
}

function beforeMutation({ operation }) {
  assertActive(`scheduler.smoke.${operation}`);
  const recorded = audit.requireRecord('scheduler.adapter.smoke.intent', taskName, {
    operation, jobId, generation, purpose: 'bounded create-query-delete verification'
  });
  if (!recorded || recorded.durable !== true) throw new Error('Durable scheduler smoke mutation intent was not recorded.');
}

let primaryError;
try {
  assertActive('scheduler.smoke');
  const initial = adapter.inspect(spec);
  assert.equal(initial.state, 'absent', `Unique scheduler smoke task was not absent: ${initial.state}`);
  const created = adapter.ensure(spec, { beforeMutation });
  assert.equal(created.observation.state, 'present');
  assert.equal(adapter.inspect(spec).state, 'present');
  const checkedAt = Date.now();
  const nextRunAtMs = nextRunTimeMs();
  const maxDelayMs = schedule === 'daily' ? 24 * 60 * 60_000
    : schedule === 'hourly' ? 60 * 60_000 : spec.intervalMinutes * 60_000;
  assert.ok(nextRunAtMs >= checkedAt - 60_000, 'Task Scheduler returned a stale next-run time.');
  assert.ok(nextRunAtMs <= checkedAt + maxDelayMs + 2 * 60_000,
    `Task Scheduler next run exceeds the requested ${schedule} cadence.`);
  process.stdout.write(`scheduler Windows ${schedule} task create/query/next-run passed: ${taskName}\n`);
} catch (error) {
  primaryError = error;
} finally {
  let cleanupError;
  try {
    const observed = adapter.inspect(spec);
    if (observed.state === 'present' || observed.state === 'owned-drift') adapter.remove(spec, { beforeMutation });
    const final = adapter.inspect(spec);
    assert.equal(final.state, 'absent', `Scheduler smoke cleanup did not prove absence: ${final.state}`);
    process.stdout.write(`scheduler Windows ${schedule} task cleanup proved absence: ${taskName}\n`);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    if (primaryError) cleanupError.cause = primaryError;
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
}

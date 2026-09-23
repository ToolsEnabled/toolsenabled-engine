'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.env.TOOLSENABLED_WINDOWS_SCHEDULER_LEGACY_MUTATION_SMOKE !== '1') {
  process.stdout.write('scheduler Windows legacy mutation smoke skipped (set TOOLSENABLED_WINDOWS_SCHEDULER_LEGACY_MUTATION_SMOKE=1 to enable)\n');
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('The Windows legacy scheduler mutation smoke is available only on Windows.');

const audit = require('../src/lib/audit');
const { assertActive } = require('../src/lib/policy');
const {
  SchedulerAdapterError, createWindowsSchedulerAdapter, resolveCurrentPrincipalIdentity
} = require('../src/lib/scheduler-adapter');

const adapter = createWindowsSchedulerAdapter();
const identity = resolveCurrentPrincipalIdentity();
const runnerPath = path.resolve(__dirname, '..', 'src', 'job-runner.js');
const sourceDigest = crypto.randomBytes(32).toString('hex');

function command(args) {
  const result = spawnSync('schtasks.exe', args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

function taskExists(taskName) {
  return (command(['/query', '/tn', taskName, '/xml', '/hresult']).status >>> 0) === 0;
}

function auditIntent(taskName, operation, purpose, details = {}) {
  assertActive(`scheduler.legacy.smoke.${operation}`);
  const recorded = audit.requireRecord('scheduler.legacy.smoke.intent', taskName, { operation, purpose, ...details });
  if (!recorded || recorded.durable !== true) throw new Error('Durable legacy scheduler smoke intent was not recorded.');
}

function legacySpec(schedule) {
  const name = `smoke-${schedule}-${crypto.randomUUID()}`;
  return {
    name, schedule, taskName: `\\ToolsEnabled-${name}`, createdAtMs: Date.now(),
    nodePath: process.execPath, runnerPath,
    principalId: identity.principalId, principalName: identity.principalName
  };
}

function createLegacy(spec, { foreign = false } = {}) {
  const taskArgs = foreign
    ? 'cmd.exe /d /c exit 0'
    : `/d /s /c ""${spec.nodePath}" "${spec.runnerPath}" "${spec.name}""`;
  const args = ['/create', '/tn', spec.taskName.slice(1), '/tr', taskArgs, '/sc', spec.schedule, '/f', '/hresult'];
  if (spec.schedule === 'daily') args.splice(args.length - 2, 0, '/st', '00:05');
  auditIntent(spec.taskName, 'create', foreign ? 'foreign-preservation proof' : 'pre-saga cleanup proof');
  const result = command(args);
  assert.equal(result.status, 0, String(result.stderr || result.stdout || 'Legacy smoke creation failed.'));
}

function forceCleanup(spec) {
  if (!taskExists(spec.taskName)) return;
  auditIntent(spec.taskName, 'delete', 'bounded smoke cleanup');
  command(['/delete', '/tn', spec.taskName, '/f', '/hresult']);
  assert.equal(taskExists(spec.taskName), false, `Legacy smoke cleanup did not prove absence: ${spec.taskName}`);
}

for (const schedule of ['hourly', 'daily']) {
  const spec = legacySpec(schedule);
  try {
    createLegacy(spec);
    const before = adapter.inspectLegacy(spec);
    assert.equal(before.state, 'present', `Exact pre-saga ${schedule} task was not recognized (${before.reason}).`);
    const removed = adapter.removeLegacy(spec, {
      beforeMutation(event) {
        assert.match(event.observation.evidenceHash, /^[a-f0-9]{64}$/);
        auditIntent(spec.taskName, 'delete', 'exact pre-saga migration', {
          sourceDigest, matcherVersion: 1, evidenceHash: event.observation.evidenceHash
        });
      }
    });
    assert.equal(removed.changed, true);
    assert.equal(adapter.inspectLegacy(spec).state, 'absent');
    process.stdout.write(`scheduler Windows exact legacy ${schedule} cleanup passed: ${spec.taskName}\n`);
  } finally {
    forceCleanup(spec);
  }
}

{
  const spec = legacySpec('hourly');
  try {
    createLegacy(spec, { foreign: true });
    assert.equal(adapter.inspectLegacy(spec).state, 'foreign');
    let mutationIntents = 0;
    assert.throws(() => adapter.removeLegacy(spec, { beforeMutation() { mutationIntents += 1; } }),
      error => error instanceof SchedulerAdapterError && error.code === 'SCHEDULER_LEGACY_TASK_CONFLICT');
    assert.equal(mutationIntents, 0);
    assert.equal(taskExists(spec.taskName), true, 'Foreign same-name task must survive migration cleanup refusal.');
    process.stdout.write(`scheduler Windows foreign legacy-name preservation passed: ${spec.taskName}\n`);
  } finally {
    forceCleanup(spec);
  }
}

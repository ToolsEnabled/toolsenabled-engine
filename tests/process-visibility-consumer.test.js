'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const consumer = require('../src/lib/supervision/process-visibility-consumer.js');
const health = require('../src/lib/health-invariants.js');
const managedProcesses = require('../src/lib/managed-processes.js');
const observer = require('../src/lib/supervision/observer.js');
const targets = require('../src/lib/supervision/process-visibility-targets.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function fixture(capturedAtMs) {
  return {
    schemaVersion: 1,
    capturedAtMs,
    reader: { kind: 'toolsenabled-uac-process-reader', privilege: 'elevated-read-only' },
    tasks: targets.TASK_NAMES.map(taskName => ({
      taskName,
      state: 'Running',
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['C:\\ToolsEnabled\\tools\\worker.js', '--serve'],
      workingDirectory: 'C:\\ToolsEnabled'
    })),
    processes: [{
      pid: 4812,
      imageName: 'node.exe',
      startedAtMs: capturedAtMs - 1000,
      argv: ['C:\\ToolsEnabled\\tools\\worker.js', '--serve']
    }]
  };
}

function writeSnapshot(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-visibility-consumer-'));
  const file = path.join(directory, 'process-visibility.json');
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return { directory, file };
}

function clean(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

process.stdout.write('process-visibility-consumer\n');

// The shipped registry must declare the observer because its checked-in
// registrar resolves its task, argv, cadence, and entry point from that one
// source of truth. Installation-specific process records remain elsewhere;
// this portable observer is required to watch the portable payload itself.
assert.ok(Object.hasOwn(managedProcesses.loadRegistry().processes, 'health-observer'),
  'the portable registry must declare the observer used by its own registrar');

check('fresh validated snapshots project scheduled tasks and process identity', () => {
  const now = 1785400000000;
  const { directory, file } = writeSnapshot(fixture(now - 1000));
  const loaded = consumer.loadProcessVisibility({ file, now });
  assert.equal(loaded.usable, true);
  assert.equal(loaded.getScheduledTask('ToolsEnabled Health Observer').arguments,
    'C:\\ToolsEnabled\\tools\\worker.js --serve');
  assert.equal(loaded.getScheduledTask('ToolsEnabled Health Observer').workingDirectory, 'C:\\ToolsEnabled');
  assert.equal(loaded.getProcessInfo(4812).commandLine,
    'C:\\ToolsEnabled\\tools\\worker.js --serve');
  assert.equal(loaded.getProcessInfo(4812).startedAt, new Date(now - 2000).toISOString());
  clean(directory);
});

check('NotFound coverage entries project as absent scheduled tasks', () => {
  const now = 1785400000000;
  const value = fixture(now - 1000);
  value.tasks.find(task => task.taskName === 'ToolsEnabled Health Observer').state = 'NotFound';
  const { directory, file } = writeSnapshot(value);
  const loaded = consumer.loadProcessVisibility({ file, now });
  assert.equal(loaded.usable, true);
  assert.equal(loaded.getScheduledTask('ToolsEnabled Health Observer'), null);
  const entry = managedProcesses.getProcess('health-observer');
  const verdict = health.evaluateSubsystem(entry, health.defaultContext({
    getScheduledTask: loaded.getScheduledTask,
    fileExists: () => false
  }));
  assert.equal(verdict.state, health.STATE.DOWN);
  assert.equal(verdict.failedRung, 'registered');
  assert.match(verdict.reason, /NOT registered/);
  clean(directory);
});

check('undeclared scheduled tasks remain unmeasured rather than projecting as absent', () => {
  const now = 1785400000000;
  const { directory, file } = writeSnapshot(fixture(now - 1000));
  const loaded = consumer.loadProcessVisibility({ file, now });
  assert.equal(loaded.usable, true);
  assert.equal(loaded.getScheduledTask('ToolsEnabled Task The Collector Did Not Measure'), undefined);
  clean(directory);
});

check('registered tasks bound to a different checkout fail the root-binding check', () => {
  const now = 1785400000000;
  const value = fixture(now - 1000);
  const task = value.tasks.find(item => item.taskName === 'ToolsEnabled Health Observer');
  task.executable = 'C:\\Users\\owner\\Desktop\\ToolsEnabled\\tools\\health-observer.js';
  task.argv = ['C:\\Users\\owner\\Desktop\\ToolsEnabled\\tools\\health-observer.js', '--once'];
  task.workingDirectory = 'C:\\Users\\owner\\Desktop\\ToolsEnabled';
  const { directory, file } = writeSnapshot(value);
  const loaded = consumer.loadProcessVisibility({ file, now });
  const verdict = health.evaluateSubsystem(
    managedProcesses.getProcess('health-observer'),
    health.defaultContext({ getScheduledTask: loaded.getScheduledTask, fileExists: () => false })
  );
  assert.equal(verdict.state, health.STATE.DOWN);
  assert.equal(verdict.failedRung, 'registered');
  assert.match(verdict.reason, /wrong root/);
  assert.match(verdict.reason, /Execute/);
  assert.match(verdict.reason, /Arguments/);
  assert.match(verdict.reason, /WorkingDirectory/);
  clean(directory);
});

check('missing, malformed, future, and stale snapshots default-deny identity', () => {
  const now = 1785400000000;
  const missing = consumer.loadProcessVisibility({ file: path.join(os.tmpdir(), `missing-${now}.json`), now });
  assert.equal(missing.usable, false);

  const malformed = writeSnapshot({ nope: true });
  assert.equal(consumer.loadProcessVisibility({ file: malformed.file, now }).usable, false);
  clean(malformed.directory);

  const future = writeSnapshot(fixture(now + 1));
  assert.equal(consumer.loadProcessVisibility({ file: future.file, now }).code, 'PROCESS_VISIBILITY_CONSUMER_FUTURE');
  clean(future.directory);

  const stale = writeSnapshot(fixture(now - consumer.DEFAULT_MAX_AGE_MS - 1));
  assert.equal(consumer.loadProcessVisibility({ file: stale.file, now }).code, 'PROCESS_VISIBILITY_CONSUMER_STALE');
  clean(stale.directory);
});

check('TimeClip-limit snapshots remain usable while out-of-range timestamps fail closed without throwing', () => {
  const timeClipLimit = 8640000000000000;
  const atLimit = fixture(timeClipLimit);
  atLimit.processes[0].startedAtMs = timeClipLimit;
  const limitSnapshot = writeSnapshot(atLimit);
  const loadedAtLimit = consumer.loadProcessVisibility({ file: limitSnapshot.file, now: timeClipLimit });
  assert.equal(loadedAtLimit.usable, true);
  assert.equal(loadedAtLimit.getProcessInfo(4812).startedAt, new Date(timeClipLimit).toISOString());
  clean(limitSnapshot.directory);

  for (const invalidTimestamp of [timeClipLimit + 1, 9007199254740991]) {
    const capturedAtOutOfRange = fixture(timeClipLimit);
    capturedAtOutOfRange.capturedAtMs = invalidTimestamp;
    const capturedSnapshot = writeSnapshot(capturedAtOutOfRange);
    let capturedResult;
    assert.doesNotThrow(() => { capturedResult = consumer.loadProcessVisibility({ file: capturedSnapshot.file, now: timeClipLimit }); });
    assert.equal(capturedResult.code, 'PROCESS_VISIBILITY_CONSUMER_INVALID');
    clean(capturedSnapshot.directory);

    const startedAtOutOfRange = fixture(timeClipLimit);
    startedAtOutOfRange.processes[0].startedAtMs = invalidTimestamp;
    const startedSnapshot = writeSnapshot(startedAtOutOfRange);
    let startedResult;
    assert.doesNotThrow(() => { startedResult = consumer.loadProcessVisibility({ file: startedSnapshot.file, now: timeClipLimit }); });
    assert.equal(startedResult.code, 'PROCESS_VISIBILITY_CONSUMER_INVALID');
    clean(startedSnapshot.directory);
  }
});

check('health context uses only fresh snapshot data for cross-session task and process probes', () => {
  const nowMs = 1785400000000;
  const { directory, file } = writeSnapshot(fixture(nowMs - 1000));
  const ctx = observer.buildSystemContext({ now: () => nowMs, processVisibilityFile: file });
  assert.equal(ctx.processVisibility.usable, true);
  assert.equal(ctx.getScheduledTask('ToolsEnabled Health Observer').state, 'Running');
  assert.equal(ctx.getProcessInfo(4812).pid, 4812);
  clean(directory);
});

check('health context suppresses direct listener identity without a fresh snapshot', () => {
  const nowMs = 1785400000000;
  const listenerProbe = () => ({ listeners: [{ pid: 4812, commandLine: 'direct-untrusted.exe', localAddress: '127.0.0.1' }] });
  const ctx = observer.buildSystemContext({
    now: () => nowMs,
    processVisibilityFile: path.join(os.tmpdir(), `missing-${nowMs}.json`),
    listenerProbe
  });
  assert.equal(ctx.getScheduledTask('ToolsEnabled Health Observer'), undefined);
  assert.equal(ctx.getProcessInfo(4812), undefined);
  assert.equal(ctx.getListener(3888).commandLine, null,
    'port presence remains observable, but a direct cross-session argv must not become identity evidence');
});

check('health context attaches identity to a port listener only from the fresh snapshot', () => {
  const nowMs = 1785400000000;
  const { directory, file } = writeSnapshot(fixture(nowMs - 1000));
  const ctx = observer.buildSystemContext({
    now: () => nowMs,
    processVisibilityFile: file,
    listenerProbe: () => ({ listeners: [{ pid: 4812, commandLine: 'direct-untrusted.exe', localAddress: '127.0.0.1' }] })
  });
  assert.equal(ctx.getListener(3888).commandLine, 'C:\\ToolsEnabled\\tools\\worker.js --serve');
  clean(directory);
});

process.stdout.write(`\nprocess-visibility-consumer: ${passed} checks passed\n`);

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const snapshot = require('../src/lib/supervision/process-visibility-snapshot.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function fixture(overrides = {}) {
  return {
    schemaVersion: 1,
    capturedAtMs: 1785360000000,
    reader: { kind: 'toolsenabled-uac-process-reader', privilege: 'elevated-read-only' },
    tasks: [{
      taskName: 'ToolsEnabled Health Observer',
      state: 'Running',
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['C:\\ToolsEnabled\\tools\\health-observer.js', '--once'],
      workingDirectory: 'C:\\ToolsEnabled'
    }],
    processes: [{
      pid: 4812,
      imageName: 'node.exe',
      startedAtMs: 1785359900000,
      argv: ['C:\\ToolsEnabled\\tools\\health-observer.js', '--once']
    }],
    ...overrides
  };
}

function throwsCode(code, fn) {
  assert.throws(fn, error => error instanceof snapshot.ProcessVisibilitySnapshotError && error.code === code);
}

function refusesWithoutSideEffects(code, input) {
  const serializedBefore = JSON.stringify(input);
  const calls = [];
  const replacements = [
    [fs, 'writeFileSync'],
    [fs, 'appendFileSync'],
    [childProcess, 'spawn'],
    [childProcess, 'spawnSync'],
    [childProcess, 'execFile'],
    [childProcess, 'execFileSync']
  ];
  const originals = replacements.map(([owner, method]) => [owner, method, owner[method]]);
  for (const [owner, method] of replacements) {
    owner[method] = (...args) => { calls.push([method, args]); };
  }
  try {
    throwsCode(code, () => snapshot.parseProcessVisibilitySnapshot(input));
    assert.deepEqual(calls, [], 'refusal must not write files or launch a process');
    assert.equal(JSON.stringify(input), serializedBefore, 'refusal must not mutate caller input');
  } finally {
    for (const [owner, method, original] of originals) owner[method] = original;
  }
}

process.stdout.write('process-visibility-snapshot\n');

check('accepts only the fixed reader declaration and deep-freezes its safe projection', () => {
  const actual = snapshot.parseProcessVisibilitySnapshot(JSON.stringify(fixture()), {
    expectedTaskNames: ['ToolsEnabled Health Observer']
  });
  assert.equal(actual.schemaVersion, 1);
  assert.equal(actual.tasks[0].state, 'Running');
  assert.equal(actual.processes[0].pid, 4812);
  assert.ok(Object.isFrozen(actual));
  assert.ok(Object.isFrozen(actual.tasks));
  assert.ok(Object.isFrozen(actual.tasks[0].argv));
  assert.throws(() => { actual.processes[0].pid = 999; }, TypeError);
});

check('rejects schema drift and accessor-bearing objects without evaluating the accessor', () => {
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_UNKNOWN_FIELD', () => snapshot.parseProcessVisibilitySnapshot(fixture({ extra: true })));
  const value = fixture();
  Object.defineProperty(value, 'capturedAtMs', { enumerable: true, get() { throw new Error('must not run'); } });
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_ACCESSOR_REFUSED', () => snapshot.parseProcessVisibilitySnapshot(value));
});

check('drives the public input-shape and schema-version refusals without side effects', () => {
  refusesWithoutSideEffects('PROCESS_VISIBILITY_SNAPSHOT_INVALID_SHAPE', null);
  refusesWithoutSideEffects('PROCESS_VISIBILITY_SNAPSHOT_SCHEMA_VERSION', fixture({ schemaVersion: 2 }));
});

check('drives bounded collection refusals without side effects', () => {
  refusesWithoutSideEffects('PROCESS_VISIBILITY_SNAPSHOT_INVALID_TASKS', fixture({ tasks: {} }));
  refusesWithoutSideEffects('PROCESS_VISIBILITY_SNAPSHOT_INVALID_PROCESSES', fixture({ processes: {} }));
  const invalidArgv = fixture();
  invalidArgv.processes[0].argv = {};
  refusesWithoutSideEffects('PROCESS_VISIBILITY_SNAPSHOT_INVALID_ARGV', invalidArgv);
});

check('drives numeric and positive-pid refusals without side effects', () => {
  refusesWithoutSideEffects('PROCESS_VISIBILITY_SNAPSHOT_INVALID_NUMBER', fixture({ capturedAtMs: -1 }));
  const zeroPid = fixture();
  zeroPid.processes[0].pid = 0;
  refusesWithoutSideEffects('PROCESS_VISIBILITY_SNAPSHOT_INVALID_PID', zeroPid);
});

check('rejects undeclared, missing, and duplicate task entries', () => {
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_INVALID_EXPECTED_TASKS', () => snapshot.parseProcessVisibilitySnapshot(fixture({ tasks: [] }), { expectedTaskNames: [] }));
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_UNDECLARED_TASK', () => snapshot.parseProcessVisibilitySnapshot(fixture(), { expectedTaskNames: ['Other Task'] }));
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_TASK_COVERAGE', () => snapshot.parseProcessVisibilitySnapshot(fixture({ tasks: [] }), { expectedTaskNames: ['ToolsEnabled Health Observer'] }));
  const duplicate = fixture();
  duplicate.tasks.push({ ...duplicate.tasks[0] });
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_DUPLICATE_TASK', () => snapshot.parseProcessVisibilitySnapshot(duplicate));
});

check('rejects unknown raw command-line fields, duplicate pids, and credential-bearing argv forms', () => {
  const rawCommandLine = fixture();
  rawCommandLine.processes[0].commandLine = 'node.exe health-observer.js';
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_UNKNOWN_FIELD', () => snapshot.parseProcessVisibilitySnapshot(rawCommandLine));
  const duplicatePid = fixture();
  duplicatePid.processes.push({ ...duplicatePid.processes[0] });
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_DUPLICATE_PID', () => snapshot.parseProcessVisibilitySnapshot(duplicatePid));
  const secret = fixture();
  secret.processes[0].argv.push('--api-key=not-allowed');
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_SECRET_REFUSED', () => snapshot.parseProcessVisibilitySnapshot(secret));
  const nestedEnvironmentSecret = fixture();
  nestedEnvironmentSecret.processes[0].argv.push('--env=API_KEY=not-allowed');
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_SECRET_REFUSED', () => snapshot.parseProcessVisibilitySnapshot(nestedEnvironmentSecret));
  const clientCredential = fixture();
  clientCredential.processes[0].argv.push('CLIENT_CREDENTIAL=not-allowed');
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_SECRET_REFUSED', () => snapshot.parseProcessVisibilitySnapshot(clientCredential));
  const nestedClientCredential = fixture();
  nestedClientCredential.processes[0].argv.push('--env=CLIENT_CREDENTIAL=not-allowed');
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_SECRET_REFUSED', () => snapshot.parseProcessVisibilitySnapshot(nestedClientCredential));
  const clientCredentials = fixture();
  clientCredentials.processes[0].argv.push('CLIENT_CREDENTIALS=not-allowed');
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_SECRET_REFUSED', () => snapshot.parseProcessVisibilitySnapshot(clientCredentials));
  const nestedClientCredentials = fixture();
  nestedClientCredentials.processes[0].argv.push('--env=CLIENT_CREDENTIALS=not-allowed');
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_SECRET_REFUSED', () => snapshot.parseProcessVisibilitySnapshot(nestedClientCredentials));
  const directCredential = fixture();
  directCredential.processes[0].argv.push('AIzaSyDUMMYVALUE0123456789abcd');
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_SECRET_REFUSED', () => snapshot.parseProcessVisibilitySnapshot(directCredential));
  const benignCredentialLabels = fixture();
  benignCredentialLabels.processes[0].argv.push(
    '--mode=client-credentialless',
    '--mode=client-credentials-helper',
    '--credentials-dir=C:\\ToolsEnabled\\auth'
  );
  assert.doesNotThrow(() => snapshot.parseProcessVisibilitySnapshot(benignCredentialLabels));
});

check('accepts TimeClip-limit timestamps and refuses out-of-range snapshot timestamps', () => {
  const maximum = fixture();
  maximum.capturedAtMs = snapshot.MAX_TIMESTAMP_MS;
  maximum.processes[0].startedAtMs = snapshot.MAX_TIMESTAMP_MS;
  const accepted = snapshot.parseProcessVisibilitySnapshot(maximum);
  assert.equal(accepted.capturedAtMs, snapshot.MAX_TIMESTAMP_MS);
  assert.equal(accepted.processes[0].startedAtMs, snapshot.MAX_TIMESTAMP_MS);

  for (const invalidTimestamp of [snapshot.MAX_TIMESTAMP_MS + 1, 9007199254740991]) {
    const capturedAtOutOfRange = fixture({ capturedAtMs: invalidTimestamp });
    throwsCode('PROCESS_VISIBILITY_SNAPSHOT_INVALID_TIMESTAMP', () => snapshot.parseProcessVisibilitySnapshot(capturedAtOutOfRange));
    const startedAtOutOfRange = fixture();
    startedAtOutOfRange.processes[0].startedAtMs = invalidTimestamp;
    throwsCode('PROCESS_VISIBILITY_SNAPSHOT_INVALID_TIMESTAMP', () => snapshot.parseProcessVisibilitySnapshot(startedAtOutOfRange));
  }
});

check('rejects invalid JSON, reader identity, and invalid Scheduler state', () => {
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_INVALID_JSON', () => snapshot.parseProcessVisibilitySnapshot('{'));
  const untrustedReader = fixture();
  untrustedReader.reader.kind = 'arbitrary-admin-script';
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_UNTRUSTED_READER', () => snapshot.parseProcessVisibilitySnapshot(untrustedReader));
  const badState = fixture();
  badState.tasks[0].state = 'Green';
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_INVALID_TASK_STATE', () => snapshot.parseProcessVisibilitySnapshot(badState));
});

check('the parser is a pure contract with no observer, filesystem, process, or privilege side effects', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'supervision', 'process-visibility-snapshot.js'), 'utf8');
  for (const forbidden of ['node:fs', 'node:child_process', 'execFile', 'spawn(', 'writeFile', 'Get-CimInstance', 'Start-Process']) {
    assert.equal(source.includes(forbidden), false, `contract source must not contain ${forbidden}`);
  }
});

process.stdout.write(`\nprocess-visibility-snapshot: ${passed} checks passed\n`);

// Mutation record:
// Changed the module projection to `capturedAtMs: fields.capturedAtMs + 1`.
// The mutation landed (confirmed by an exact source search).
// This file stayed green at first, then went red after adding the value assertion.
// The module was restored and its original SHA-256 confirmed.

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const producer = require('../src/lib/supervision/process-visibility-producer.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function fixture(overrides = {}) {
  return {
    capturedAtMs: 1785360000000,
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
  assert.throws(fn, error => error && error.code === code);
}

function refusesWithoutEffects(code, message, fn) {
  const calls = [];
  const replacements = [
    [childProcess, 'exec', 'spawn'],
    [childProcess, 'execFile', 'spawn'],
    [childProcess, 'execFileSync', 'spawn'],
    [childProcess, 'execSync', 'spawn'],
    [childProcess, 'spawn', 'spawn'],
    [childProcess, 'spawnSync', 'spawn'],
    [fs, 'appendFileSync', 'write'],
    [fs, 'createWriteStream', 'write'],
    [fs, 'openSync', 'write'],
    [fs, 'renameSync', 'write'],
    [fs, 'writeFileSync', 'write']
  ];
  const originals = replacements.map(([owner, name]) => [owner, name, owner[name]]);
  for (const [owner, name, kind] of replacements) {
    owner[name] = (...args) => {
      calls.push({ kind, name, args });
      throw new Error(`unexpected ${kind}: ${name}`);
    };
  }

  let returned = Symbol('not returned');
  let refusal;
  try {
    try {
      returned = fn();
    } catch (error) {
      refusal = error;
    }
  } finally {
    for (const [owner, name, original] of originals) owner[name] = original;
  }

  assert.equal(returned.description, 'not returned');
  assert.ok(refusal instanceof producer.ProcessVisibilityProducerError);
  assert.equal(refusal.code, code);
  assert.equal(refusal.message, `process-visibility-producer: ${message}`);
  assert.deepEqual(calls, [], 'a refused observation must not write or spawn');
}

process.stdout.write('process-visibility-producer\n');

check('normalizes injected minimized observations to only the parser closed schema', () => {
  const actual = producer.normalizeProcessVisibilityObservation(fixture(), {
    expectedTaskNames: ['ToolsEnabled Health Observer']
  });
  assert.deepEqual(Object.keys(actual).sort(), ['capturedAtMs', 'processes', 'reader', 'schemaVersion', 'tasks']);
  assert.deepEqual(actual.reader, { kind: 'toolsenabled-uac-process-reader', privilege: 'elevated-read-only' });
  assert.equal(actual.capturedAtMs, fixture().capturedAtMs);
  assert.equal(actual.tasks[0].taskName, 'ToolsEnabled Health Observer');
  assert.equal(actual.processes[0].pid, 4812);
  assert.ok(Object.isFrozen(actual));
  assert.ok(Object.isFrozen(actual.tasks));
  assert.ok(Object.isFrozen(actual.processes[0].argv));

  const serialized = producer.serializeProcessVisibilitySnapshot(fixture(), {
    expectedTaskNames: ['ToolsEnabled Health Observer']
  });
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), Object.keys(actual).sort());
});

check('refuses non-object and non-plain observation shapes before producing output or effects', () => {
  refusesWithoutEffects(
    'PROCESS_VISIBILITY_PRODUCER_INVALID_SHAPE',
    'observation must be a plain object',
    () => producer.normalizeProcessVisibilityObservation(null)
  );

  const inheritedObservation = Object.create(fixture());
  refusesWithoutEffects(
    'PROCESS_VISIBILITY_PRODUCER_INVALID_SHAPE',
    'observation must be a plain object',
    () => producer.serializeProcessVisibilitySnapshot(inheritedObservation)
  );
});

check('refuses non-plain, sparse, and property-bearing arrays before producing output or effects', () => {
  refusesWithoutEffects(
    'PROCESS_VISIBILITY_PRODUCER_INVALID_ARRAY',
    'tasks must be a plain array',
    () => producer.normalizeProcessVisibilityObservation(fixture({ tasks: {} }))
  );

  const sparseTasks = fixture().tasks;
  sparseTasks.length = 2;
  refusesWithoutEffects(
    'PROCESS_VISIBILITY_PRODUCER_INVALID_ARRAY',
    'tasks must be dense and contain no extra fields',
    () => producer.serializeProcessVisibilitySnapshot(fixture({ tasks: sparseTasks }))
  );

  const propertyBearingArgv = fixture();
  propertyBearingArgv.processes[0].argv.source = 'collector';
  refusesWithoutEffects(
    'PROCESS_VISIBILITY_PRODUCER_INVALID_ARRAY',
    'processes[0].argv must be dense and contain no extra fields',
    () => producer.normalizeProcessVisibilityObservation(propertyBearingArgv)
  );
});

check('refuses reader injection, raw command lines, credential fields, and undeclared fields', () => {
  throwsCode('PROCESS_VISIBILITY_PRODUCER_UNKNOWN_FIELD', () => producer.normalizeProcessVisibilityObservation(fixture({
    reader: { kind: 'forged', privilege: 'elevated-read-only' }
  })));
  const raw = fixture();
  raw.processes[0].commandLine = 'node.exe health-observer.js';
  throwsCode('PROCESS_VISIBILITY_PRODUCER_RAW_COMMAND_LINE_REFUSED', () => producer.normalizeProcessVisibilityObservation(raw));
  const credential = fixture();
  credential.tasks[0].apiKey = 'not-allowed';
  throwsCode('PROCESS_VISIBILITY_PRODUCER_CREDENTIAL_FIELD_REFUSED', () => producer.normalizeProcessVisibilityObservation(credential));
  throwsCode('PROCESS_VISIBILITY_PRODUCER_UNKNOWN_FIELD', () => producer.normalizeProcessVisibilityObservation(fixture({ extra: true })));
});

check('refuses accessors without evaluating them, including array elements', () => {
  let topLevelTouched = false;
  const topLevel = fixture();
  Object.defineProperty(topLevel, 'capturedAtMs', {
    enumerable: true,
    get() {
      topLevelTouched = true;
      throw new Error('must not run');
    }
  });
  throwsCode('PROCESS_VISIBILITY_PRODUCER_ACCESSOR_REFUSED', () => producer.normalizeProcessVisibilityObservation(topLevel));
  assert.equal(topLevelTouched, false);

  let elementTouched = false;
  const nested = fixture();
  Object.defineProperty(nested.processes[0].argv, '0', {
    configurable: true,
    enumerable: true,
    get() {
      elementTouched = true;
      throw new Error('must not run');
    }
  });
  throwsCode('PROCESS_VISIBILITY_PRODUCER_ACCESSOR_REFUSED', () => producer.normalizeProcessVisibilityObservation(nested));
  assert.equal(elementTouched, false);
});

check('default-denies credential-bearing argv and all configured size limits', () => {
  const secret = fixture();
  secret.processes[0].argv.push('--env=API_KEY=not-allowed');
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_SECRET_REFUSED', () => producer.normalizeProcessVisibilityObservation(secret));

  const tooManyArgs = fixture();
  tooManyArgs.tasks[0].argv = Array.from({ length: 97 }, (_, index) => `arg-${index}`);
  throwsCode('PROCESS_VISIBILITY_PRODUCER_OVERSIZE', () => producer.normalizeProcessVisibilityObservation(tooManyArgs));

  const oversizedText = fixture();
  oversizedText.processes[0].imageName = 'x'.repeat(4097);
  throwsCode('PROCESS_VISIBILITY_SNAPSHOT_INVALID_STRING', () => producer.normalizeProcessVisibilityObservation(oversizedText));
});

check('is a pure boundary with a single parser dependency and no collector capability', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'supervision', 'process-visibility-producer.js'), 'utf8');
  const requires = [...source.matchAll(/require\((['"])(.*?)\1\)/g)].map(match => match[2]);
  assert.deepEqual(requires, ['./process-visibility-snapshot.js']);
  for (const forbidden of ['node:fs', 'node:child_process', 'execFile', 'spawn(', 'writeFile', 'readFile', 'Get-CimInstance', 'Start-Process', 'PowerShell', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, `producer source must not contain ${forbidden}`);
  }
});

process.stdout.write(`\nprocess-visibility-producer: ${passed} checks passed\n`);

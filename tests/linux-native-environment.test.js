'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const ENTRY_PATH = path.join(__dirname, 'linux-native.js');
const ENTRY_SOURCE = fs.readFileSync(ENTRY_PATH, 'utf8');
const NORMAL_CONTROLS = Object.freeze([
  'A28_REGISTRATION_ORIGIN_ONLY',
  'A28_FIXTURE_ROOT',
  'T999_RUNTIME_SOURCE',
  'T1010_SOURCE',
  'T1012_SOURCE',
  'T1018_SOURCE',
  'T850_ENGINE_ROOT',
  'T850_COMPOSITION_LIB',
  'T850_HELPER_PATH',
]);
const MUTATION_SELECTOR = 'CONTINUATION_PRUNE_TEST_MUTATION';
const MUTATION_ARGUMENT = '--mutation-proof=continuation-prune-copy';
const STOP_EVALUATION = Symbol('stop-evaluation');
const REQUIRED_SUITES = Object.freeze([
  'tests/multi-account-registry-write.test.js',
  'tests/action-permission-profiles.test.js',
  'tests/continuation-prune.test.js',
  'tests/t545-permission-provider-separation.test.js',
  'tests/vault-setter-error-boundary.test.js',
  'tests/failover-setting-error-boundary.test.js',
  'tests/audit-admission-error-boundary.test.js',
  'tests/mcp-public-message-boundary.test.js',
]);

function cleanEnvironment() {
  const environment = { ...process.env };
  const controls = new Set([...NORMAL_CONTROLS, MUTATION_SELECTOR]);
  for (const key of Object.keys(environment)) {
    if (controls.has(key.toUpperCase())) delete environment[key];
  }
  return environment;
}

function streamCapture(target) {
  return {
    write(value) {
      target.push(String(value));
      return true;
    },
  };
}

function renderDiagnostic(value, seen = new Set()) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) {
    return [value.name, value.code, value.message, value.stack].filter(Boolean).join(' ');
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  return Object.entries(value)
    .map(([key, entry]) => key + '=' + renderDiagnostic(entry, seen))
    .join(' ');
}

function diagnostics(result) {
  return [
    ...result.consoleError,
    ...result.consoleLog,
    ...result.stdout,
    ...result.stderr,
    result.thrown,
  ].map(value => renderDiagnostic(value)).join('\n');
}

function effectiveStatus(result) {
  if (result.exitCalls.length) return result.exitCalls[result.exitCalls.length - 1];
  if (Number.isInteger(result.exitCode)) return result.exitCode;
  return result.thrown ? 1 : 0;
}

function invokeEntry({ environment, args = [], spawnResult }) {
  const calls = [];
  const consoleError = [];
  const consoleLog = [];
  const stdout = [];
  const stderr = [];
  const exitCalls = [];
  const fakeProcess = {
    platform: 'linux',
    argv: ['node', ENTRY_PATH, ...args],
    execPath: '/virtual/node',
    env: { ...environment },
    hrtime: { bigint: () => 1n },
    stdout: streamCapture(stdout),
    stderr: streamCapture(stderr),
    exitCode: undefined,
    cwd: () => path.resolve(__dirname, '..'),
    exit(code = 0) {
      exitCalls.push(code);
      throw STOP_EVALUATION;
    },
  };
  const fakeChildProcess = {
    spawnSync(command, childArgs, options) {
      const call = { command, args: childArgs, options };
      calls.push(call);
      return typeof spawnResult === 'function' ? spawnResult(call) : spawnResult;
    },
  };
  const fakeConsole = {
    error(...values) {
      consoleError.push(...values);
    },
    log(...values) {
      consoleLog.push(...values);
    },
    warn(...values) {
      consoleError.push(...values);
    },
  };
  const module = { exports: {} };
  const sandboxRequire = specifier => {
    if (specifier === 'node:child_process') return fakeChildProcess;
    if (specifier === 'node:process') return fakeProcess;
    if (specifier.startsWith('node:')) return require(specifier);
    throw new Error('unexpected non-builtin import: ' + specifier);
  };
  sandboxRequire.main = module;
  sandboxRequire.resolve = require.resolve;
  const context = {
    Buffer,
    clearImmediate,
    clearTimeout,
    console: fakeConsole,
    exports: module.exports,
    globalThis: undefined,
    module,
    process: fakeProcess,
    require: sandboxRequire,
    setImmediate,
    setTimeout,
    __dirname,
    __filename: ENTRY_PATH,
  };
  let thrown = null;
  try {
    new vm.Script(ENTRY_SOURCE, { filename: ENTRY_PATH }).runInNewContext(context);
  } catch (error) {
    if (error !== STOP_EVALUATION) thrown = error;
  }
  return {
    calls,
    consoleError,
    consoleLog,
    stdout,
    stderr,
    thrown,
    exitCalls,
    exitCode: fakeProcess.exitCode,
  };
}

function assertRefusal(result, code, selector, marker) {
  const output = diagnostics(result);
  assert.equal(result.calls.length, 0, 'refused input launched a child');
  assert.match(output, new RegExp(code));
  assert.match(output, new RegExp(selector));
  assert.equal(output.includes(marker), false, 'refusal exposed the control value');
  assert.notEqual(effectiveStatus(result), 0, 'refusal returned success');
}

function assertChildEnvironment(call, unrelatedValue) {
  assert.ok(call.options && call.options.env, 'child environment was not supplied');
  assert.equal(call.options.env.W13_UNRELATED_ENV, unrelatedValue);
  for (const selector of [...NORMAL_CONTROLS, MUTATION_SELECTOR]) {
    assert.equal(call.options.env[selector], undefined, selector + ' leaked to a clean child');
  }
}

function mutationTap({ target = true, allGreen = false, includeCode = true } = {}) {
  const lines = ['TAP version 13'];
  for (let index = 1; index <= 15; index += 1) {
    if (allGreen || index !== 7) {
      lines.push('ok ' + index + ' - fixture assertion ' + index);
      continue;
    }
    lines.push('not ok 7 - ' + (target ? 'backup failure prevents removal' : 'unrelated failure'));
    if (includeCode) {
      lines.push('  ---');
      lines.push("  code: 'ERR_ASSERTION'");
      lines.push('  ...');
    }
  }
  const passed = allGreen ? 15 : 14;
  const failed = allGreen ? 0 : 1;
  lines.push(
    '1..15',
    '# tests 15',
    '# pass ' + passed,
    '# fail ' + failed,
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  );
  return lines.join('\n') + '\n';
}

function proofResult(result, expectedOutcome, expectedStatus) {
  const output = diagnostics(result);
  assert.match(output, /linuxNativeMutationProof/);
  assert.match(output, new RegExp(expectedOutcome));
  assert.equal(effectiveStatus(result), expectedStatus);
  assert.notEqual(effectiveStatus(result), 0, 'mutation proof returned success');
}

for (const selector of NORMAL_CONTROLS) {
  test('actual entry refuses normal control ' + selector + ' by value', () => {
    const marker = 'w13-control-marker-' + selector.toLowerCase();
    const environment = cleanEnvironment();
    environment[selector] = marker;
    const result = invokeEntry({
      environment,
      spawnResult: { status: 0, signal: null, error: null },
    });
    assertRefusal(result, 'LINUX_NATIVE_SUITE_CONTROL_REFUSED', selector, marker);
  });
}

test('actual entry refuses unrequested continuation mutation by value', () => {
  const environment = cleanEnvironment();
  environment[MUTATION_SELECTOR] = 'copy';
  const result = invokeEntry({
    environment,
    spawnResult: { status: 0, signal: null, error: null },
  });
  assertRefusal(result, 'LINUX_NATIVE_MUTATION_CONTROL_REFUSED', MUTATION_SELECTOR, 'copy');
});

test('normal actual entry forwards a clean copy and preserves unrelated values', () => {
  const environment = cleanEnvironment();
  environment.W13_UNRELATED_ENV = 'retained-value';
  const result = invokeEntry({
    environment,
    spawnResult: { status: 0, signal: null, error: null },
  });
  assert.equal(result.thrown, null);
  assert.equal(result.calls.length, 1);
  const call = result.calls[0];
  assert.ok(call.command.endsWith(path.join('bin', 'node')) || call.command === '/virtual/node');
  assert.ok(call.args[0].endsWith(path.join('tests', 'run-isolated.js')));
  const suites = call.args.slice(1);
  for (const suite of REQUIRED_SUITES) assert.ok(suites.includes(suite), suite + ' was not selected');
  assert.equal(new Set(suites).size, suites.length, 'ordinary native suite list contains a duplicate');
  assertChildEnvironment(call, 'retained-value');
  assert.equal(effectiveStatus(result), 0);
});

test('explicit continuation mutation proof selects one target and sets only the requested mutation', () => {
  const environment = cleanEnvironment();
  environment.W13_UNRELATED_ENV = 'retained-value';
  const result = invokeEntry({
    environment,
    args: [MUTATION_ARGUMENT],
    spawnResult: {
      status: 1,
      signal: null,
      error: null,
      stdout: mutationTap(),
      stderr: '',
    },
  });
  assert.equal(result.thrown, null);
  assert.equal(result.calls.length, 1);
  const call = result.calls[0];
  assert.deepEqual(Array.from(call.args.slice(1)), ['tests/continuation-prune.test.js']);
  assert.equal(call.options.env.W13_UNRELATED_ENV, 'retained-value');
  assert.equal(call.options.env[MUTATION_SELECTOR], 'copy');
  for (const selector of NORMAL_CONTROLS) assert.equal(call.options.env[selector], undefined);
  proofResult(result, 'expected-behavior-red', 1);
});

test('explicit continuation proof refuses a conflicting inherited mutation', () => {
  const marker = 'unexpected-mutation';
  const environment = cleanEnvironment();
  environment[MUTATION_SELECTOR] = marker;
  const result = invokeEntry({
    environment,
    args: [MUTATION_ARGUMENT],
    spawnResult: { status: 0, signal: null, error: null },
  });
  assertRefusal(result, 'LINUX_NATIVE_MUTATION_CONTROL_REFUSED', MUTATION_SELECTOR, marker);
});

test('mutation proof classifies a wrong target failure as harness-invalid', () => {
  const environment = cleanEnvironment();
  const result = invokeEntry({
    environment,
    args: [MUTATION_ARGUMENT],
    spawnResult: {
      status: 1,
      signal: null,
      error: null,
      stdout: mutationTap({ target: false }),
      stderr: '',
    },
  });
  proofResult(result, 'harness-invalid', 2);
});

test('mutation proof classifies a spawn error as harness-invalid', () => {
  const environment = cleanEnvironment();
  const spawnError = Object.assign(new Error('synthetic spawn failure'), { code: 'ENOENT' });
  const result = invokeEntry({
    environment,
    args: [MUTATION_ARGUMENT],
    spawnResult: {
      status: null,
      signal: null,
      error: spawnError,
      stdout: '',
      stderr: '',
    },
  });
  proofResult(result, 'harness-invalid', 2);
});

test('mutation proof classifies a signal termination as harness-invalid', () => {
  const environment = cleanEnvironment();
  const result = invokeEntry({
    environment,
    args: [MUTATION_ARGUMENT],
    spawnResult: {
      status: null,
      signal: 'SIGTERM',
      error: null,
      stdout: '',
      stderr: '',
    },
  });
  proofResult(result, 'harness-invalid', 2);
});

test('mutation proof classifies a surviving mutation as nonzero survived', () => {
  const environment = cleanEnvironment();
  const result = invokeEntry({
    environment,
    args: [MUTATION_ARGUMENT],
    spawnResult: {
      status: 0,
      signal: null,
      error: null,
      stdout: mutationTap({ allGreen: true }),
      stderr: '',
    },
  });
  proofResult(result, 'survived', 3);
});

test('mutation proof rejects valid target TAP mixed with runner cleanup diagnostics on stderr', () => {
  const environment = cleanEnvironment();
  const result = invokeEntry({
    environment,
    args: [MUTATION_ARGUMENT],
    spawnResult: {
      status: 1,
      signal: null,
      error: null,
      stdout: mutationTap(),
      stderr: 'Isolated scratch preserved because descendant cleanup is unproven: synthetic-root\n',
    },
  });
  proofResult(result, 'harness-invalid', 2);
});

test('mutation proof rejects a TAP failure counter that disagrees with result lines', () => {
  const environment = cleanEnvironment();
  const result = invokeEntry({
    environment,
    args: [MUTATION_ARGUMENT],
    spawnResult: {
      status: 1,
      signal: null,
      error: null,
      stdout: mutationTap().replace('# fail 1', '# fail 2'),
      stderr: '',
    },
  });
  proofResult(result, 'harness-invalid', 2);
});

test('mutation proof rejects non-sequential top-level result ordinals', () => {
  const environment = cleanEnvironment();
  const result = invokeEntry({
    environment,
    args: [MUTATION_ARGUMENT],
    spawnResult: {
      status: 1,
      signal: null,
      error: null,
      stdout: mutationTap().replace('ok 8 - fixture assertion 8', 'ok 10 - fixture assertion 8'),
      stderr: '',
    },
  });
  proofResult(result, 'harness-invalid', 2);
});

test('mutation proof classifies status zero without TAP as harness-invalid', () => {
  const environment = cleanEnvironment();
  const result = invokeEntry({
    environment,
    args: [MUTATION_ARGUMENT],
    spawnResult: {
      status: 0,
      signal: null,
      error: null,
      stdout: '',
      stderr: '',
    },
  });
  proofResult(result, 'harness-invalid', 2);
});

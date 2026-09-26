'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = process.env.T899_RUNNER_SOURCE || path.join(__dirname, 'run-isolated.js');
const ENVIRONMENT_PATH = process.env.T899_ENVIRONMENT_SOURCE
  || path.join(__dirname, 'lib', 'isolated-environment.js');
const RETENTION_KEYS = [
  'TOOLSENABLED_TEST_RETAIN_FIXTURES',
  'TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES'
];
const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');
const environmentSource = fs.readFileSync(ENVIRONMENT_PATH, 'utf8');

function retentionCases() {
  return [
    [{}, false],
    [{ TOOLSENABLED_TEST_RETAIN_FIXTURES: '1' }, true],
    [{ TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: '1' }, true],
    [{ TOOLSENABLED_TEST_RETAIN_FIXTURES: '1', TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: '0' }, true],
    [{ TOOLSENABLED_TEST_RETAIN_FIXTURES: '0', TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: '1' }, true],
    [{ TOOLSENABLED_TEST_RETAIN_FIXTURES: '0', TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: '0' }, false],
    [{ TOOLSENABLED_TEST_RETAIN_FIXTURES: 'true' }, false],
    [{ TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: 'true' }, false],
    [{ TOOLSENABLED_TEST_RETAIN_FIXTURES: '01' }, false],
    [{ TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: 'yes' }, false]
  ];
}

function fakeProcess(platform, environment) {
  const stdout = [];
  const stderr = [];
  const warnings = [];
  const exitHandlers = [];
  const processView = {
    argv: ['node', 'tests/run-isolated.js'],
    env: { ...environment },
    platform,
    execPath: process.execPath,
    exitCode: 0,
    stdin: {
      readableFlowing: null,
      pipe() {},
      unpipe() {},
      pause() {}
    },
    stdout: { write(value) { stdout.push(String(value)); } },
    stderr: { write(value) { stderr.push(String(value)); } },
    once(event, callback) { exitHandlers.push({ event, callback }); },
    on() {},
    removeListener() {},
    emitWarning(value) { warnings.push(String(value)); }
  };
  return {
    processView,
    stdout,
    stderr,
    warnings,
    exitHandlers,
    output() {
      return [...stdout, ...stderr, ...warnings].join('');
    }
  };
}

function fakeFs() {
  let sequence = 0;
  const removals = [];
  const configured = [];
  const created = [];
  return {
    removals,
    configured,
    created,
    mkdtempSync(prefix) {
      const root = path.posix.join('/virtual',
        path.basename(prefix) + String(++sequence).padStart(3, '0'));
      created.push({ prefix, root });
      return root;
    },
    mkdirSync(directory, options) {
      configured.push({ directory, options });
    },
    existsSync() {
      return false;
    },
    rmSync(target, options) {
      removals.push({ target, options });
    },
    readFileSync() {
      return Buffer.from('');
    },
    writeFileSync() {},
    readdirSync() {
      return [];
    },
    lstatSync() {
      return { isSymbolicLink: () => false };
    },
    readlinkSync() {
      return '';
    }
  };
}

function runnerRequired(name, dependencies) {
  if (name === 'node:fs') return dependencies.fs;
  if (name === 'node:os') return {
    tmpdir: () => '/virtual-tmp',
    homedir: () => '/virtual-home'
  };
  if (name === 'node:path') return path;
  if (name === 'node:crypto') return require('node:crypto');
  if (name === 'node:child_process') return {
    spawnSync() {
      throw new Error('the child-process boundary must be controlled by runIsolatedChild');
    }
  };
  if (name === './lib/isolated-child') return {
    runIsolatedChild: dependencies.runIsolatedChild
  };
  if (name === './lib/isolated-environment') {
    return {
      configure: (root, environment) => {
        dependencies.configured.push({ root, environment: { ...environment } });
        return root;
      },
      isolatedTemporaryRoot: () => '/virtual-tmp',
      retainTestStateRequested: dependencies.retainTestStateRequested
    };
  }
  if (name === './lib/suite-list') return {
    readSuiteList: () => ['tests/retained-runner-fixture.cjs']
  };
  if (name === './lib/suite-timeouts') {
    return {
      DEFAULT_TIMEOUT_MS: 30_000,
      timeoutForSuite: (_file, caller) => caller
    };
  }
  if (name === '../tools/lib/test-completion') {
    return {
      OPT_IN_TESTS: [],
      strictRequested: () => false,
      validateCompletion: () => ({
        kind: 'controlled',
        counts: { pass: 1 },
        unexecuted: 0
      })
    };
  }
  if (name === '../src/lib/env-scrub') return {
    deleteEnvNames: value => value
  };
  if (name === '../tools/lib/strict-lifecycle-record') {
    return {
      readContext: () => null,
      assertInvocation() {},
      clearAuthority: () => ({ ...dependencies.processView.env }),
      record() {},
      fileIdentity: () => ({})
    };
  }
  throw new Error('unexpected runner dependency: ' + name);
}

async function runRunnerScenario({
  platform,
  environment,
  outcome,
  mutateAfterChildTo,
  deferChild = false
}) {
  const processState = fakeProcess(platform, environment);
  const fsState = fakeFs();
  const configured = [];
  const childState = { release: null, settled: false };
  const environmentScenario = loadEnvironmentScenario(platform, environment);
  const dependencies = {
    fs: fsState,
    processView: processState.processView,
    configured,
    retainTestStateRequested: environmentScenario.api.retainTestStateRequested,
    runIsolatedChild: async (_command, _args, options) => {
      if (mutateAfterChildTo !== undefined) {
        for (const key of RETENTION_KEYS) {
          options.env[key] = mutateAfterChildTo;
          processState.processView.env[key] = mutateAfterChildTo;
        }
      }
      if (deferChild) {
        return new Promise(resolve => {
          childState.release = () => {
            childState.settled = true;
            resolve({ ...outcome });
          };
        });
      }
      return { ...outcome };
    }
  };
  processState.processView.argv = [
    'node',
    'tests/run-isolated.js',
    'tests/retained-runner-fixture.cjs'
  ];
  const context = {
    __dirname,
    __filename: RUNNER_PATH,
    module: { exports: {} },
    exports: {},
    process: processState.processView,
    require: name => runnerRequired(name, dependencies),
    console: {
      error(value) { processState.stderr.push(String(value)); },
      warn(value) { processState.stderr.push(String(value)); },
      log(value) { processState.stdout.push(String(value)); }
    },
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate
  };
  vm.runInNewContext(runnerSource, context, { filename: RUNNER_PATH });
  await new Promise(resolve => setImmediate(resolve));
  let removalsBeforeChildSettled = null;
  if (deferChild) {
    removalsBeforeChildSettled = fsState.removals.slice();
    assert.equal(typeof childState.release, 'function',
      'the runner must reach the controlled child before awaiting its custody result');
    childState.release();
    await new Promise(resolve => setImmediate(resolve));
  }
  return {
    ...processState,
    fsState,
    configured,
    suiteRoot: fsState.created[0] && fsState.created[0].root,
    testRoot: configured[0] && configured[0].root,
    removalsBeforeChildSettled,
    childSettled: childState.settled
  };
}

function environmentRequired(name, dependencies) {
  if (name === 'node:fs') return dependencies.fs;
  if (name === 'node:os') return {
    tmpdir: () => '/virtual-tmp',
    homedir: () => dependencies.platform === 'win32'
      ? 'C:/T899-synthetic-home'
      : '/virtual-home'
  };
  if (name === 'node:path') return path;
  throw new Error('unexpected isolated-environment dependency: ' + name);
}

function loadEnvironmentScenario(platform, environment) {
  const fsState = fakeFs();
  const processState = fakeProcess(platform, environment);
  const context = {
    __dirname: path.dirname(ENVIRONMENT_PATH),
    __filename: ENVIRONMENT_PATH,
    module: { exports: {} },
    exports: {},
    process: processState.processView,
    require: name => environmentRequired(name, { fs: fsState, platform }),
    console: {
      error(value) { processState.stderr.push(String(value)); },
      warn(value) { processState.stderr.push(String(value)); },
      log(value) { processState.stdout.push(String(value)); }
    },
    Buffer
  };
  vm.runInNewContext(environmentSource, context, { filename: ENVIRONMENT_PATH });
  return { ...processState, fsState, api: context.module.exports };
}

function closeOwnedActivation(scenario, activated) {
  const cleanup = activated.cleanup
    || scenario.exitHandlers.find(entry => entry.event === 'exit')?.callback;
  assert.equal(typeof cleanup, 'function',
    'an owned activation must expose or register cleanup');
  cleanup();
}

test('retention flags are value-driven and platform-independent', () => {
  for (const platform of ['linux', 'win32']) {
    const api = loadEnvironmentScenario(platform, {}).api;
    assert.equal(typeof api.retainTestStateRequested, 'function',
      'isolated-environment must expose the retention decision used by the runner');
    for (const [environment, expected] of retentionCases()) {
      assert.equal(
        api.retainTestStateRequested(environment),
        expected,
        platform + ' value contract: ' + JSON.stringify(environment)
      );
    }
  }
});

test('the runner keeps default cleanup on Linux and win32 and snapshots before child execution', async () => {
  for (const platform of ['linux', 'win32']) {
    for (const environment of [
      {},
      { TOOLSENABLED_TEST_RETAIN_FIXTURES: '0' },
      { TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: 'true' }
    ]) {
      const observed = await runRunnerScenario({
        platform,
        environment,
        mutateAfterChildTo: '1',
        outcome: {
          status: 0,
          signal: null,
          error: undefined,
          stdout: null,
          stderr: null,
          cleanupConfirmed: true
        }
      });
      assert.equal(observed.fsState.removals.length, 2,
        platform + ' default mode must remove the test root and suite root');
      assert.ok(observed.fsState.removals.some(entry => entry.target === observed.testRoot));
      assert.ok(observed.fsState.removals.some(entry => entry.target === observed.suiteRoot));
      assert.equal(observed.processView.exitCode, 0);
    }
  }
});

test('explicit retained mode keeps the runner suite root and announces its value on Linux and win32', async () => {
  for (const platform of ['linux', 'win32']) {
    for (const key of RETENTION_KEYS) {
      const observed = await runRunnerScenario({
        platform,
        environment: { [key]: '1' },
        mutateAfterChildTo: '0',
        outcome: {
          status: 0,
          signal: null,
          error: undefined,
          stdout: null,
          stderr: null,
          cleanupConfirmed: true
        }
      });
      assert.deepEqual(observed.fsState.removals, [],
        platform + ' ' + key + '=1 must attempt no filesystem deletion');
      assert.ok(observed.output().includes(observed.suiteRoot),
        platform + ' retained mode must report the retained suite root');
      assert.equal(observed.processView.exitCode, 0);
    }
  }
});

test('failed or unproven child closure preserves scratch and leaves the runner nonpassing', async () => {
  for (const platform of ['linux', 'win32']) {
    for (const outcome of [
      {
        status: 7,
        signal: null,
        error: undefined,
        stdout: null,
        stderr: null,
        cleanupConfirmed: false
      },
      {
        status: 0,
        signal: null,
        error: Object.assign(new Error('descendant cleanup is unproven'), {
          code: 'ISOLATED_CHILD_CLEANUP_UNPROVEN'
        }),
        stdout: null,
        stderr: null,
        cleanupConfirmed: false
      }
    ]) {
      const observed = await runRunnerScenario({
        platform,
        environment: {},
        outcome,
        mutateAfterChildTo: undefined
      });
      assert.deepEqual(observed.fsState.removals, [],
        platform + ' unproven child closure must not delete scratch');
      assert.notEqual(observed.processView.exitCode, 0);
      assert.ok(observed.output().includes(observed.suiteRoot),
        platform + ' unproven closure must report the preserved suite root');
    }
  }
});

test('runner does not clean before returned child custody settles', async () => {
  for (const platform of ['linux', 'win32']) {
    const observed = await runRunnerScenario({
      platform,
      environment: {},
      outcome: {
        status: 0,
        signal: null,
        error: undefined,
        stdout: null,
        stderr: null,
        cleanupConfirmed: true
      },
      deferChild: true
    });
    assert.deepEqual(observed.removalsBeforeChildSettled, [],
      platform + ' must not clean while child custody is unresolved');
    assert.equal(observed.childSettled, true);
    assert.equal(observed.fsState.removals.length, 2,
      platform + ' default cleanup follows only after custody settles');
  }
});

test('owned activate captures explicit retention at activation and ignores later environment changes', () => {
  for (const platform of ['linux', 'win32']) {
    for (const key of RETENTION_KEYS) {
      const retained = loadEnvironmentScenario(platform, { [key]: '1' });
      const retainedActivation = retained.api.activate('retained-' + platform + '-' + key);
      retained.processView.env[key] = '0';
      closeOwnedActivation(retained, retainedActivation);
      assert.deepEqual(retained.fsState.removals, [],
        platform + ' ' + key + '=1 must retain an owned root after the environment changes');

      const ordinary = loadEnvironmentScenario(platform, {});
      const ordinaryActivation = ordinary.api.activate('ordinary-' + platform);
      ordinary.processView.env[key] = '1';
      closeOwnedActivation(ordinary, ordinaryActivation);
      assert.equal(ordinary.fsState.removals.length, 1,
        platform + ' ordinary activation must preserve default cleanup after a later opt-in');
      assert.equal(ordinary.fsState.removals[0].target, ordinaryActivation.root);
      assert.ok(retained.output().includes(retainedActivation.root),
        platform + ' retained activation must report its retained root');
    }
  }
});

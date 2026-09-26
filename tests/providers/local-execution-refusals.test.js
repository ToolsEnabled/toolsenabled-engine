'use strict';

require('../lib/isolated-environment').activate('local-execution-refusals');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const taxonomy = require('../../src/lib/error-taxonomy');
const runtime = require('../../src/lib/runtime');
const policy = require('../../src/lib/policy');

function loadProvider(name, overrides = {}) {
  const priorRun = runtime.run;
  const priorExists = runtime.commandExists;
  const priorActive = policy.assertActive;
  const filename = require.resolve(`../../src/lib/providers/${name}`);
  const priorModule = require.cache[filename];
  runtime.run = overrides.run || (() => { throw new Error('Unexpected command execution'); });
  runtime.commandExists = () => true;
  policy.assertActive = () => {};
  delete require.cache[filename];
  try { return require(filename); }
  finally {
    runtime.run = priorRun;
    runtime.commandExists = priorExists;
    policy.assertActive = priorActive;
    delete require.cache[filename];
    if (priorModule) require.cache[filename] = priorModule;
  }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-execution-refusal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function actionable(error, code, message) {
  assert.equal(error.code, code);
  const publicFailure = taxonomy.publicFailure(taxonomy.adaptToolError(error));
  assert.equal(publicFailure.code, 'INPUT_REQUIRED');
  assert.equal(publicFailure.retryable, false);
  assert.match(error.message, message);
  return true;
}

test('missing deployment configuration identifies the prerequisite before any command', t => {
  const deployment = loadProvider('deployment');
  assert.throws(() => deployment.deploy({ cwd: fixture(t), provider: 'auto' }),
    error => actionable(error, 'DEPLOYMENT_CONFIG_REQUIRED', /adding its project configuration/));
});

test('missing saved Terraform plan tells the caller how to prepare one', t => {
  const infrastructure = loadProvider('infrastructure');
  assert.throws(() => infrastructure.terraformApply({ cwd: fixture(t), planFile: 'absent.tfplan' }),
    error => actionable(error, 'TERRAFORM_PLAN_REQUIRED', /Run terraform\.plan first/));
});

test('failed project tests expose stage and exit code, without arbitrary child output or automatic retry', async t => {
  const cwd = fixture(t);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'build', test: 'test' } }));
  const commands = [];
  const privateDiagnostic = 'untrusted-child-diagnostic-that-must-not-be-public';
  const launch = loadProvider('launch', { run(command, args) {
    commands.push([command, ...args]);
    return { status: args[0] === 'test' ? 3 : 0, timedOut: false,
      stderr: args[0] === 'test' ? privateDiagnostic : '', stdout: '' };
  } });
  await assert.rejects(launch.execute({ cwd, deploy: false, skipTests: false }), error => {
    actionable(error, 'LAUNCH_STEP_INPUT_REQUIRED', /Running the project tests.*exited with code 3/);
    assert.equal(error.step, 'test');
    assert.equal(error.message.includes(privateDiagnostic), false);
    assert.equal(error.cause.message, privateDiagnostic);
    return true;
  });
  assert.deepEqual(commands, [['npm', 'install'], ['npm', 'run', 'build'], ['npm', 'test']]);
});

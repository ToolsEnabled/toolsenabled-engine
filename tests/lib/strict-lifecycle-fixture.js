'use strict';

// Harmless fixture with the actual harness dependency closure and actual npm
// pre/body/post hooks. All Git and output writes belong to this disposable tree.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { isolatedTemporaryRoot } = require('./isolated-environment');
const records = require('../../tools/lib/strict-lifecycle-record');
const { deleteEnvNames } = require('../../src/lib/env-scrub');
const ROOT = path.resolve(__dirname, '../..');

function git(root, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'user.name=Lifecycle Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...records.clearAuthority(), GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  // A short fresh root avoids accidentally testing Windows MAX_PATH instead
  // of lifecycle evidence when this suite itself has an isolated parent.
  const directory = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'te-proof-fixture-'));
  const root = path.join(directory, 'engine');
  const write = (file, text) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of ['tools/test-strict.js', 'tools/check-chain-runner.js', 'tools/test-ratchet.mjs',
    'tests/lib/isolated-child.js', 'src/lib/linux-process-control.js', 'src/lib/linux-process-supervisor.py',
    'src/lib/windows-job-control.js', 'src/lib/runtime-state-root.js', 'src/lib/account-profile-boundary.js', 'tools/windows-job-wrapper.ps1',
    'tools/lib/test-completion.js', 'tools/lib/strict-lifecycle-record.js', 'tests/run-isolated.js',
    'tests/lib/suite-list.js', 'tests/lib/suite-timeouts.js', 'tests/lib/isolated-environment.js',
    'src/lib/env-scrub.js', 'src/lib/providers/subscription-launch-env.js', 'src/lib/supervision/launch-environment.js']) {
    write(file, fs.readFileSync(path.join(ROOT, file)));
  }
  const chain = (name, command) => `node tools/check-chain-runner.js --name ${name} --then ${command}`;
  const scripts = {
    pretest: chain('pretest', 'node tests/stage.cjs pretest'),
    test: chain('test', '--id nested npm run test:inner --then --id self node tests/run-isolated.js tests/self.test.cjs'),
    posttest: chain('posttest', 'node tests/stage.cjs posttest --then --id metadata node tools/test-ratchet.mjs --from-summary ignored-legacy.json'),
    'pretest:inner': chain('inner-pre', 'node tests/stage.cjs pretest:inner'),
    'test:inner': 'node tests/run-isolated.js tests/pass.test.cjs tests/pass.test.cjs',
    'posttest:inner': chain('inner-post', 'node tests/stage.cjs posttest:inner'),
    'test:key-custody': 'node tests/run-isolated.js'
  };
  write('package.json', JSON.stringify({ private: true, scripts }));
  write('config/fixture.json', '{}');
  write('tests/stage.cjs', [
    "const assert = require('node:assert/strict');",
    "assert.equal(process.env.TOOLSENABLED_TEST_STRICT, '1');",
    "for (const name of require('../tools/lib/strict-lifecycle-record').AUTHORITY) assert.equal(process.env[name], undefined);",
    "require('node:fs').appendFileSync(process.env.TOOLSENABLED_STRICT_FIXTURE_STAGES, process.argv[2] + '\\n');",
    "if (process.argv[2] === process.env.TOOLSENABLED_STRICT_FIXTURE_FAIL_STAGE) process.exitCode = 7;"
  ].join('\n'));
  write('tests/pass.test.cjs', [
    "const { test, describe } = require('node:test');",
    "const assert = require('node:assert/strict');",
    "describe('real fixture suite', () => test('real assertion', () => assert.equal(2 + 2, 4)));"
  ].join('\n'));
  write('tests/self.test.cjs', [
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { spawnSync } = require('node:child_process');",
    "const records = require('../tools/lib/strict-lifecycle-record');",
    "test('harness self-test has strict semantics but no enclosing receipt authority', () => {",
    "  assert.equal(process.env.TOOLSENABLED_TEST_STRICT, '1');",
    "  for (const name of records.AUTHORITY) assert.equal(process.env[name], undefined);",
    "  const child = spawnSync(process.execPath, ['tests/run-isolated.js', 'tests/pass.test.cjs'], { encoding: 'utf8', windowsHide: true });",
    "  assert.equal(child.status, 0, child.stdout + child.stderr);",
    "});"
  ].join('\n'));
  git(root, ['init', '--template=']);
  const commit = () => { git(root, ['add', '.']); git(root, ['commit', '-m', 'Harmless lifecycle fixture']); };
  commit();
  return { directory, root, scripts, write, commit, stages: path.join(directory, 'stages.txt') };
}

function environment(extra = {}) {
  return { ...deleteEnvNames(records.clearAuthority(), ['NODE_TEST_CONTEXT', 'TOOLSENABLED_TEST_STRICT']), ...extra };
}

// A harness self-test emits one TAP document of its own. Capture the actual
// child lifecycle instead of interleaving its several TAP documents into that
// parent stream; its exits and receipts remain the evidence under assertion.
function captureSpawn(file, args, options) {
  return spawnSync(file, args, { ...options, stdio: 'pipe', encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

module.exports = { fixture, environment, git, captureSpawn };

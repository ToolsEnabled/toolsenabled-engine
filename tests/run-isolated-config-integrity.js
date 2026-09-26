'use strict';

// Exercise the real runner in disposable repositories. No test writes the
// active checkout's config, and no cleanup operation restores files from HEAD.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function run(program, args, cwd) {
  const result = spawnSync(program, args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 20_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(cwd, 'no-global-config') }
  });
  if (result.error) throw result.error;
  return result;
}

function git(root, args) {
  const result = run('git', ['-c', 'core.hooksPath=', '-c', 'user.name=Test Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function withFixture(assertion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-isolated-config-'));
  try {
    fs.mkdirSync(path.join(root, 'tests', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config'));
    for (const file of ['run-isolated.js', 'lib/isolated-environment.js', 'lib/suite-list.js', 'lib/suite-timeouts.js']) {
      fs.copyFileSync(path.join(ROOT, 'tests', file), path.join(root, 'tests', file));
    }
    // Keep the copied runner's actual dependency closure; no stubs of its guard.
    for (const file of ['tests/lib/isolated-child.js', 'src/lib/linux-process-control.js', 'src/lib/linux-process-supervisor.py',
      'src/lib/windows-job-control.js', 'src/lib/runtime-state-root.js', 'src/lib/account-profile-boundary.js', 'tools/windows-job-wrapper.ps1',
      'tools/lib/test-completion.js', 'tools/lib/strict-lifecycle-record.js', 'src/lib/env-scrub.js']) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), target);
    }
    fs.writeFileSync(path.join(root, 'config', 'tracked.json'), 'original\n');
    fs.writeFileSync(path.join(root, 'config', 'deleted.json'), 'original\n');
    git(root, ['init', '--template=']);
    git(root, ['add', 'config']);
    git(root, ['commit', '-m', 'Fixture baseline']);
    fs.writeFileSync(path.join(root, 'tests', 'later.js'),
      "require('node:fs').writeFileSync('later-ran', 'yes');\n");
    assertion(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runHarness(root, flags, scripts) {
  const summaryPath = path.join(root, 'summary.json');
  const result = run(process.execPath, [
    path.join(root, 'tests', 'run-isolated.js'), ...flags, '--summary', summaryPath, ...scripts
  ], root);
  return { ...result, summary: JSON.parse(fs.readFileSync(summaryPath, 'utf8')) };
}

for (const flags of [['--config-integrity'], ['--continue']]) {
  withFixture(root => {
    fs.writeFileSync(path.join(root, 'tests', 'mutator.js'), [
      "const fs = require('node:fs');",
      "fs.writeFileSync('config/tracked.json', 'changed during test\\n');",
      "fs.writeFileSync('config/new.json', 'new work\\n');",
      "fs.unlinkSync('config/deleted.json');"
    ].join('\n'));
    const result = runHarness(root, flags, ['tests/mutator.js', 'tests/later.js']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Config changed while tests\/mutator\.js ran:/);
    assert.match(result.stderr, /Files were preserved/);
    assert.equal(result.summary.requested, 2);
    assert.equal(result.summary.files[0].status, 'config-mutation');
    assert.equal(result.summary.files[0].configPreserved, true);
    assert.deepEqual(result.summary.files[0].mutated,
      ['config/deleted.json', 'config/new.json', 'config/tracked.json']);
    assert.equal(result.summary.files[1].status, 'not-run');
    assert.equal(fs.readFileSync(path.join(root, 'config', 'tracked.json'), 'utf8'), 'changed during test\n');
    assert.equal(fs.readFileSync(path.join(root, 'config', 'new.json'), 'utf8'), 'new work\n');
    assert.equal(fs.existsSync(path.join(root, 'config', 'deleted.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'later-ran')), false,
      'later tests must not run against configuration different from the measurement');
    assert.equal(git(root, ['show', 'HEAD:config/tracked.json']), 'original\n');
  });
}

withFixture(root => {
  fs.writeFileSync(path.join(root, 'config', 'tracked.json'), 'staged work\n');
  git(root, ['add', 'config/tracked.json']);
  fs.writeFileSync(path.join(root, 'config', 'tracked.json'), 'unstaged work\n');
  fs.writeFileSync(path.join(root, 'tests', 'readonly.js'),
    "require('node:assert/strict').equal(require('node:fs').readFileSync('config/tracked.json', 'utf8'), 'unstaged work\\n');\n");
  const unchanged = runHarness(root, ['--config-integrity'], ['tests/readonly.js']);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.summary.files[0].status, 'pass');
  fs.writeFileSync(path.join(root, 'tests', 'mutator.js'),
    "require('node:fs').writeFileSync('config/tracked.json', 'changed dirty work\\n');\n");
  const changed = runHarness(root, ['--config-integrity'], ['tests/mutator.js']);
  assert.equal(changed.status, 1, changed.stderr);
  assert.equal(changed.summary.files[0].status, 'config-mutation');
  assert.equal(fs.readFileSync(path.join(root, 'config', 'tracked.json'), 'utf8'), 'changed dirty work\n');
  assert.equal(git(root, ['show', ':config/tracked.json']), 'staged work\n',
    'the index must remain intact as well as working files');
});

withFixture(root => {
  fs.writeFileSync(path.join(root, 'tests', 'failure.js'), "throw new Error('ordinary assertion failure');\n");
  const result = runHarness(root, ['--config-integrity'], ['tests/failure.js', 'tests/later.js']);
  assert.equal(result.status, 1);
  assert.deepEqual(result.summary.files.map(file => file.status), ['fail', 'pass'],
    'ordinary test failures still allow independent suites to run');
  assert.equal(fs.readFileSync(path.join(root, 'later-ran'), 'utf8'), 'yes');
});

console.log('run-isolated config integrity: shared files and index preserved, drift blocks dependent tests, ordinary failures continue.');

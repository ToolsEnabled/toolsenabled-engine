'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'check-dco-test-'));
const cli = path.join(fixture, 'tools', 'check-dco.js');
let checks = 0;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: fixture,
    encoding: 'utf8',
    windowsHide: true,
    ...options
  });
}

function git(args, options = {}) {
  const result = run('git', args, options);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(subject, { date, signoff } = {}) {
  fs.appendFileSync(path.join(fixture, 'history.txt'), `${subject}\n`);
  git(['add', 'history.txt']);
  const args = ['commit', '-m', subject];
  if (signoff) args.push('-m', `Signed-off-by: ${signoff}`);
  git(args, {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date
    }
  });
  return git(['rev-parse', 'HEAD']);
}

function checkDco(range) {
  const result = run(process.execPath, [cli, range]);
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`
  };
}

function check(label, fn) {
  fn();
  checks += 1;
  void label;
}

try {
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'src', 'lib', 'providers'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'check-dco.js'), cli);
  fs.writeFileSync(
    path.join(fixture, 'src', 'lib', 'providers', 'subscription-launch-env.js'),
    "'use strict';\nexports.safeLaunchEnvironment = (env) => env;\n"
  );

  git(['init', '--quiet']);
  git(['config', 'user.name', 'DCO Test Author']);
  git(['config', 'user.email', 'author@example.test']);

  const grandfathered = commit('grandfathered unsigned commit', {
    date: '2026-08-12T12:00:00Z'
  });
  const unsigned = commit('recent unsigned commit', {
    date: '2026-08-13T12:00:00Z'
  });
  const wrongSigner = commit('commit certified by somebody else', {
    date: '2026-08-14T12:00:00Z',
    signoff: 'Other Person <other@example.test>'
  });
  const signed = commit('properly certified commit', {
    date: '2026-08-15T12:00:00Z',
    signoff: 'DCO Test Author <AUTHOR@example.test>'
  });

  check('invalid revision range refuses with the documented exit code', () => {
    const result = checkDco('definitely-not-a-revision');
    assert.equal(result.status, 1, 'git-history refusal must exit 1');
    assert.match(result.output, /DCO GATE: cannot read git history for range "definitely-not-a-revision"/);
  });

  check('a recent commit without a trailer is refused', () => {
    const result = checkDco(`${unsigned}^..${unsigned}`);
    assert.equal(result.status, 1, 'missing-sign-off refusal must exit 1');
    assert.match(result.output, /DCO GATE: FAIL \(1\)/);
    assert.match(result.output, /DCO Test Author: no Signed-off-by trailer/);
    assert.match(result.output, /git commit --amend -s/);
  });

  check('a trailer belonging to somebody other than the author is refused', () => {
    const result = checkDco(`${wrongSigner}^..${wrongSigner}`);
    assert.equal(result.status, 1, 'wrong-signer refusal must exit 1');
    assert.match(result.output, /signed off by <other@example\.test>, but authored by <author@example\.test>/);
    assert.match(result.output, /has to carry that person's own name and address/);
  });

  check('pre-policy commits and author-matching trailers take the success exit', () => {
    const oldResult = checkDco(`${grandfathered}^!`);
    assert.equal(oldResult.status, 0, 'grandfathered history must exit 0');
    assert.match(oldResult.output, /\(0 checked, 1 grandfathered as pre-2026-08-13\)/);

    const signedResult = checkDco(`${signed}^..${signed}`);
    assert.equal(signedResult.status, 0, 'valid sign-off must exit 0');
    assert.match(signedResult.output, /DCO GATE: PASS/);
    assert.match(signedResult.output, /\(1 checked, 0 grandfathered as pre-2026-08-13\)/);
  });

  console.log(`check-dco tests passed (${checks} checks)`);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

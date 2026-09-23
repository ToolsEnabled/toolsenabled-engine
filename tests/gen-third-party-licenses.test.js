'use strict';

// Exercise the generator as a CLI against disposable package trees. Copying
// the real tool is intentional: ROOT is derived from __dirname, so each copy
// can be given hostile inputs without rewriting this checkout's package.json
// or THIRD-PARTY-LICENSES.md.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = path.resolve(__dirname, '..', 'tools', 'gen-third-party-licenses.js');
const sandboxes = [];
let checks = 0;

function check(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}

function fixture(packageJson = { dependencies: {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-third-party-licenses-'));
  sandboxes.push(root);
  fs.mkdirSync(path.join(root, 'tools'));
  fs.copyFileSync(SOURCE, path.join(root, 'tools', 'gen-third-party-licenses.js'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson));
  return root;
}

function run(root, args = []) {
  return spawnSync(process.execPath, [path.join(root, 'tools', 'gen-third-party-licenses.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    windowsHide: true
  });
}

try {
  // The normal write and current-check exits are pinned before testing each
  // refusal, and provide the exact generated value needed by --check.
  {
    const root = fixture();
    const written = run(root);
    check(written.status, 0, 'generation must exit 0');
    check(written.stdout.includes('THIRD-PARTY NOTICES: wrote THIRD-PARTY-LICENSES.md'), true,
      'generation must name the file it wrote');

    const current = run(root, ['--check']);
    check(current.status, 0, '--check must exit 0 for the generated value');
    check(current.stdout.includes('THIRD-PARTY NOTICES: current'), true,
      '--check must identify a current notice file');

    fs.writeFileSync(path.join(root, 'THIRD-PARTY-LICENSES.md'), 'stale value\n');
    const stale = run(root, ['--check']);
    check(stale.status, 1, 'a mismatching notice value must use refusal exit code 1');
    check(stale.stderr.includes('THIRD-PARTY NOTICES: STALE'), true,
      'a mismatching notice value must retain the named stale refusal');
    check(stale.stderr.includes('does not match the installed dependency tree'), true,
      'the mismatch refusal must explain its condition');

    fs.rmSync(path.join(root, 'THIRD-PARTY-LICENSES.md'));
    const absent = run(root, ['--check']);
    check(absent.status, 1, 'a missing notice value must use refusal exit code 1');
    check(absent.stderr.includes('THIRD-PARTY-LICENSES.md does not exist'), true,
      'the missing-file refusal must explain its condition');
  }

  // Dependency-tree refusal: a declaration with no installed value.
  {
    const root = fixture({ dependencies: { absent_package: '1.0.0' } });
    const missing = run(root);
    check(missing.status, 1, 'an uninstalled declared package must use refusal exit code 1');
    check(missing.stderr.includes('cannot describe the dependency tree'), true,
      'the dependency-tree refusal must retain its heading');
    check(missing.stderr.includes('"absent_package" is declared but is not installed'), true,
      'the refusal must name the uninstalled package value');
    check(missing.stderr.includes('Run `npm install` first'), true,
      'the dependency-tree refusal must retain its remedy');
  }

  // The other dependency-tree refusal: resolution succeeds, but its manifest
  // value cannot be read as JSON.
  {
    const root = fixture({ dependencies: { broken_package: '1.0.0' } });
    const packageDir = path.join(root, 'node_modules', 'broken_package');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), '{not json');
    const unreadable = run(root);
    check(unreadable.status, 1, 'an unreadable installed manifest must use refusal exit code 1');
    check(unreadable.stderr.includes('"broken_package" has no readable package.json'), true,
      'the refusal must name the package whose manifest value is unreadable');
  }
} finally {
  for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true });
}

console.log(`gen-third-party-licenses tests passed (${checks} checks: write/current exits and every dependency-tree/stale refusal pinned).`);

// EXECUTABLE CHANGE
// testcanfail-tests-publish-gate-test-js
//
// The old suite proved that a caller holding a literal phrase plus HEAD could
// generate an orphan source tree.  That is no longer a safety property: an
// unrestricted agent can synthesize both values.  The current owner policy is
// private-source-only, so this regression test drives the retired entrypoint as
// a process and as a module and proves that every former mode refuses before a
// target or git repository can be created.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'publish-public.js');
const SOURCE = fs.readFileSync(TOOL, 'utf8');
const retired = require(TOOL);

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

check('the module exposes only a permanent retirement refusal', () => {
  for (const argv of [
    [],
    ['--check'],
    ['--help'],
    ['--publish', '--owner-token', 'publish this commit to the public repository deadbeef', '--target', 'unused']
  ]) {
    assert.throws(
      () => retired.main(argv),
      error => error instanceof retired.PublishRefusal
        && error.code === 'PUBLISH_PUBLIC_RETIRED'
        && /remain private/i.test(error.message),
      `argv ${JSON.stringify(argv)} must hard-refuse`
    );
  }
  assert.equal(Object.hasOwn(retired, 'TOKEN_PHRASE'), false, 'the forgeable token compatibility export must be gone');
  assert.equal(Object.hasOwn(retired, 'preparePublicTree'), false, 'the target-generation compatibility export must be gone');
});

check('the tombstone has no filesystem, process, git, remote, or network capability', () => {
  assert.doesNotMatch(SOURCE, /require\(['"]node:(?:fs|path|child_process|https?|net|dns)['"]\)/);
  assert.doesNotMatch(SOURCE, /\b(?:execFile|spawn|copyFile|mkdir|writeFile|rename|unlink|rm|git)\w*\s*\(/);
});

check('every CLI mode refuses with the same non-zero result and writes nothing', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-publish-retired-'));
  try {
    const sentinel = path.join(scratch, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'unchanged\n', 'utf8');
    const oldHead = '3333333333333333333333333333333333333333';
    const cases = [
      { name: 'no arguments', args: [] },
      { name: 'check', args: ['--check'] },
      { name: 'help', args: ['--help'] },
      { name: 'unknown argument', args: ['--definitely-unknown'] },
      {
        name: 'former owner-token publish',
        args: [
          '--publish',
          '--owner-token', `publish this commit to the public repository ${oldHead}`,
          '--target', path.join(scratch, 'generated-public-tree')
        ]
      }
    ];

    for (const entry of cases) {
      const target = path.join(scratch, 'generated-public-tree');
      const result = spawnSync(process.execPath, [TOOL, ...entry.args], {
        cwd: scratch,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          TOOLSENABLED_PUBLISH_TOKEN: `publish this commit to the public repository ${oldHead}`,
          TOOLSENABLED_ALLOW_PUBLISH: '1'
        }
      });
      assert.equal(result.error, undefined, `${entry.name}: the tombstone must start normally`);
      assert.equal(result.status, 2, `${entry.name}: refusal must be exit 2, got ${result.status}`);
      assert.equal(result.stdout, '', `${entry.name}: refusal must not emit a success report`);
      assert.match(result.stderr, /REFUSED \(PUBLISH_PUBLIC_RETIRED\):/,
        `${entry.name}: refusal must carry the stable retirement code`);
      assert.match(result.stderr, /remain private/i,
        `${entry.name}: refusal must state the current policy`);
      assert.equal(fs.existsSync(target), false,
        `${entry.name}: no target directory or nested .git repository may be created`);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged\n',
        `${entry.name}: an existing file beside the requested target must remain byte-identical`);
    }

    assert.deepEqual(fs.readdirSync(scratch), ['sentinel.txt'],
      'the entire observed directory must contain only the test sentinel after every invocation');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

process.stdout.write(`publish-retirement: ${checks} checks passed\n`);

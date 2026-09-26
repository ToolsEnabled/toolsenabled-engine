'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { STRICT_ENV } = require('../../tools/lib/test-completion');
const mode = process.env.TOOLSENABLED_STRICT_FIXTURE_MODE;

if (process.argv[2]) {
  if (process.env[STRICT_ENV] !== '1') throw new Error('strict inheritance lost');
  fs.appendFileSync(process.env.TOOLSENABLED_STRICT_FIXTURE_STAGES, `${process.argv[2]}\n`);
  if (process.argv[2] === process.env.TOOLSENABLED_STRICT_FIXTURE_FAIL_STAGE) process.exitCode = 7;
} else if (mode === 'nested-chain') {
  const runner = path.resolve(__dirname, '../../tools/check-chain-runner.js');
  const result = spawnSync(process.execPath, [runner, '--name', 'fixture', '--baseline', process.env.TOOLSENABLED_STRICT_FIXTURE_BASELINE,
    '--then', '--id', 'known-red', process.execPath, '-e', 'process.exit(7)'], { stdio: 'inherit', windowsHide: true });
  process.exitCode = result.status ?? 1;
} else if (mode === 'standalone') {
  process.stdout.write('standalone assertions completed\n');
} else if (mode === 'standalone-skip') {
  process.stdout.write('SKIP: optional suite did not run\n');
} else if (mode === 'standalone-stderr-skip') {
  process.stderr.write('SKIP: optional suite did not run\n');
} else if (mode === 'incomplete') {
  process.stdout.write('TAP version 13\nok 1 - premature exit\n');
} else if (mode === 'zero') {
  process.stdout.write('TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
} else if (mode === 'timeout') {
  setInterval(() => {}, 1000);
} else {
  const { test, describe } = require('node:test');
  const assert = require('node:assert/strict');
  if (mode === 'cancelled') test('unfinished promise', () => new Promise(() => {}));
  else if (mode === 'todo') test.todo('not implemented');
  else if (mode === 'all-skip') test.skip('not executed', () => {});
  else if (mode === 'fail') test('real assertion failure', () => assert.fail('fixture failure'));
  else if (mode === 'nested') describe('outer', () => {
    describe('inner', () => test('deep leaf', () => assert.equal(1, 1)));
    test('sibling', () => assert.equal(2, 2));
  });
  else describe('completed suite', () => {
    test('completed assertion', () => assert.equal(1, 1));
    if (mode === 'partial-skip') test.skip('other platform', () => {});
    else test('another completed assertion', () => assert.equal(2, 2));
  });
}

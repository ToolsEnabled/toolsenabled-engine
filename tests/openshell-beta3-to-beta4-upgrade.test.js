'use strict';

require('./lib/isolated-environment').activate('openshell-beta3-to-beta4-upgrade');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const required = ['TOOLSENABLED_BETA3_ARCHIVE', 'TOOLSENABLED_BETA3_SHA256',
  'TOOLSENABLED_BETA4_ARCHIVE', 'TOOLSENABLED_BETA4_SHA256',
  'TOOLSENABLED_CANDIDATE_ISOLATED', 'TOOLSENABLED_CANDIDATE_EXPECT_UID',
  'TOOLSENABLED_CANDIDATE_EXPECT_ACCOUNT_HOME'];

test('published beta 3 installs, upgrades to Fleet, reports status and uninstalls', {
  skip: process.platform !== 'linux' || required.some(name => !process.env[name]),
}, () => {
  const result = spawnSync('/usr/bin/python3', ['-u', '-B', path.join(__dirname, '../installer/openshell/test-upgrade-beta3.py')], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 900_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  console.log(result.stdout);
  console.log(result.stderr);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, 'Exact archive upgrade failed; retained scratch and output precede this verdict');
});

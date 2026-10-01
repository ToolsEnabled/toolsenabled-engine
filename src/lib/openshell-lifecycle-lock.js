'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SCRIPT = path.join(__dirname, 'openshell_lifecycle_lock.py');
const FD = 'TOOLSENABLED_FLEET_LOCK_FD';

function check(action = 'check') {
  const value = process.env[FD];
  if (!/^[0-9]+$/.test(value || '') || Number(value) < 3 || Number(value) > 1024) {
    throw Object.assign(new Error('SCOPE_UNSAFE: a validated Fleet lifecycle handle is required.'), { code: 'SCOPE_UNSAFE' });
  }
  const result = spawnSync('/usr/bin/python3', [SCRIPT, action], {
    env: { ...process.env, [FD]: '3' }, stdio: ['ignore', 'pipe', 'pipe', Number(value)],
    encoding: 'utf8', timeout: 10_000, maxBuffer: 65536
  });
  if (result.error || result.signal || result.status !== 0) {
    throw Object.assign(new Error('SCOPE_UNSAFE: the Fleet lifecycle handle could not be verified.'), { code: 'SCOPE_UNSAFE' });
  }
  return JSON.parse(result.stdout);
}

function runLocked(entry, argv) {
  if (process.env[FD] !== undefined) { check(); return null; }
  const result = spawnSync('/usr/bin/python3', [SCRIPT, 'run', '--', process.execPath, entry, ...argv], {
    env: process.env, stdio: 'inherit', windowsHide: true
  });
  if (result.error || result.signal || !Number.isInteger(result.status)) {
    throw Object.assign(new Error('OUTCOME_UNCERTAIN: Fleet lifecycle command did not settle.'), { code: 'OUTCOME_UNCERTAIN' });
  }
  return result.status;
}

function markMutation() { return check('mark'); }
module.exports = Object.freeze({ runLocked, check, markMutation });

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const policy = require('../src/lib/supervision/policy.js');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'supervision-policy-unreadable-'));
const statePath = path.join(directory, 'state-is-a-directory');
fs.mkdirSync(statePath);

const original = {
  mkdirSync: fs.mkdirSync,
  renameSync: fs.renameSync,
  writeFileSync: fs.writeFileSync,
  execFile: childProcess.execFile,
  execFileSync: childProcess.execFileSync,
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync
};
const calls = { writes: 0, spawns: 0, resolveArgv: 0, checkArgvPreconditions: 0 };

function unexpectedWrite() {
  calls.writes += 1;
  throw new Error('unreadable policy state must not be overwritten');
}
function unexpectedSpawn() {
  calls.spawns += 1;
  throw new Error('an unreadable-state refusal must not spawn a process');
}

fs.mkdirSync = unexpectedWrite;
fs.renameSync = unexpectedWrite;
fs.writeFileSync = unexpectedWrite;
childProcess.execFile = unexpectedSpawn;
childProcess.execFileSync = unexpectedSpawn;
childProcess.spawn = unexpectedSpawn;
childProcess.spawnSync = unexpectedSpawn;

try {
  assert.throws(() => policy.decide({
    id: 'unreadable-state-fixture',
    state: 'DOWN',
    reason: 'fixture',
    correctable: true
  }, {
    file: statePath,
    killSwitchActive: false,
    resolveArgv() {
      calls.resolveArgv += 1;
      return ['should-not-resolve'];
    },
    checkArgvPreconditions() {
      calls.checkArgvPreconditions += 1;
      return { ok: true };
    }
  }), error => {
    assert.equal(error.code, 'SUPERVISION_POLICY_STATE_UNREADABLE');
    assert.match(error.message, /supervision policy state is unreadable/);
    assert.match(error.message, /state-is-a-directory/);
    assert.equal(error.cause && error.cause.code, 'EISDIR');
    return true;
  });

  assert.deepEqual(calls, {
    writes: 0,
    spawns: 0,
    resolveArgv: 0,
    checkArgvPreconditions: 0
  });
  assert.deepEqual(fs.readdirSync(statePath), []);
  process.stdout.write('ok - unreadable durable state refuses before writes, dependency work, or process spawning\n');
} finally {
  fs.mkdirSync = original.mkdirSync;
  fs.renameSync = original.renameSync;
  fs.writeFileSync = original.writeFileSync;
  childProcess.execFile = original.execFile;
  childProcess.execFileSync = original.execFileSync;
  childProcess.spawn = original.spawn;
  childProcess.spawnSync = original.spawnSync;
  fs.rmSync(directory, { recursive: true, force: true });
}

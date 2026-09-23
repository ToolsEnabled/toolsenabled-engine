'use strict';
require('./lib/isolated-environment').activate('windows-resource-admission');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jobs = require('../src/lib/windows-job-control');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, beforeRootSpawn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'root-admission-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const native = new EventEmitter(); native.pid = 4242;
  let kills = 0; native.kill = () => { kills++; return false; };
  const socket = new EventEmitter(); const writes = [];
  socket.setEncoding = () => {}; socket.write = value => { writes.push(value); };
  socket.destroy = () => {};
  const child = jobs.spawnInJob('fixture-never-executed', [], { cwd: scratch, env: {} }, {
    platform: 'win32', spawnImpl: () => native, connectPipeImpl: async () => socket,
    safeLaunchEnvironment, recordDirectory: path.join(scratch, 'records'), assemblyCacheDirectory: null,
    beforeRootSpawn,
  });
  return { native, child, writes, kills: () => kills };
}

test('OWNER refusal preserves its named code and proves no launch only after actual wrapper close', async t => {
  const f = fixture(t, () => { throw Object.assign(new Error('Original sample expired.'), { code: 'AGENT_RESOURCE_GRANT_EXPIRED' }); });
  let outcome = null;
  f.child.jobOutcome.then(value => { outcome = value; });
  f.native.emit('spawn');
  await assert.rejects(f.child.jobReady, { code: 'AGENT_RESOURCE_GRANT_EXPIRED' });
  await turn();
  assert.deepEqual(f.writes, []); assert.equal(f.kills(), 1);
  assert.equal(outcome, null, 'a failed kill request is not cleanup proof');
  f.native.emit('close', 1, null);
  assert.deepEqual(await f.child.jobOutcome, { type: 'not-started', exitCode: 1, activeProcesses: 0 });
  assert.equal((await f.child.jobClosed).failure.code, 'AGENT_RESOURCE_GRANT_EXPIRED');
});

test('an asynchronous OWNER check is refused without sending permission', async t => {
  const f = fixture(t, () => Promise.resolve());
  f.native.emit('spawn');
  await assert.rejects(f.child.jobReady, { code: 'WINDOWS_JOB_INPUT_INVALID' });
  assert.deepEqual(f.writes, []);
  f.native.emit('close', 1, null);
  assert.equal((await f.child.jobOutcome).activeProcesses, 0);
});

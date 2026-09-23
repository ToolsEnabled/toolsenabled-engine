'use strict';
require('./lib/isolated-environment').activate('hidden-spawn-native-containment');
const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const { spawnHidden } = require('../src/lib/proc/hidden-spawn');
const { createCodexProcessTransport } = require('../src/lib/agent-engine/codex-process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const options = { env: process.platform === 'win32'
  ? safeLaunchEnvironment({ ...process.env, ELECTRON_RUN_AS_NODE: '1' })
  : { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] };
const leaf = 'process.stdout.write("LEAF_READY\\n");setInterval(()=>{},1000);';
const program = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,windowsHide:true,stdio:['ignore','pipe','inherit'],env:process.env});child.stdout.once('data',()=>process.stdout.write('TREE_READY\\n'));setInterval(()=>{},1000);`;

async function reclaim(child) {
  if (!child) return;
  if (typeof child.terminateJob === 'function') {
    try { await child.terminateJob(); }
    catch (error) {
      // Windows retains the admission refusal on a later stop request. It is
      // already reclaimed only when the native receipt proves an empty scope.
      const receipt = await child.jobOutcome;
      if (receipt.type !== 'not-started' || receipt.activeProcesses !== 0) throw error;
    }
    await child.jobClosed;
  } else if (child.exitCode === null && child.signalCode === null) {
    // On the red path the assertion runs before this Node root can create its
    // descendant. Only the exact retained fixture ChildProcess is reclaimed.
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
}

test('contained native provider roots retain actual descendant cleanup proof', { skip: !['linux', 'win32'].includes(process.platform), timeout: 20000 }, async t => {
  let retained;
  const transport = createCodexProcessTransport({ command: process.execPath, args: ['-e', program], ...options,
    rootLaunch: { beforeRootSpawn() {}, spawned(child) { retained = child; } } });
  t.after(() => reclaim(retained));
  assert.equal(typeof retained.jobOutcome?.then, 'function', 'containProcessTree fell through to a direct native root');
  let output = '';
  const treeReady = new Promise(resolve => transport.onData(chunk => {
    if (chunk) output += chunk;
    if (output.includes('TREE_READY')) resolve();
  }));
  await transport.rootReady;
  if (process.platform === 'win32') {
    const identity = await retained.jobReady;
    assert.match(identity.wrapperStartTicks, /^[1-9]\d{0,19}$/);
    assert.match(identity.rootStartTicks, /^[1-9]\d{0,19}$/);
  }
  await treeReady;
  transport.close();
  const receipt = await retained.jobOutcome;
  assert.equal(receipt.activeProcesses, 0);
  if (process.platform === 'linux') {
    assert.equal(receipt.backend, 'linux-subreaper-pidfd-v2');
    assert.ok(receipt.observedChildren >= 2, 'the proof must include the real setsid descendant');
    assert.equal(receipt.reapedChildren, receipt.observedChildren);
  }
  assert.equal((await retained.jobClosed).failure, null);
});

test('native final admission refusal retains an empty scope without executing the root', { skip: !['linux', 'win32'].includes(process.platform), timeout: 20000 }, async t => {
  let child;
  const refusal = Object.assign(new Error('owner changed'), { code: 'FIXTURE_OWNER_CHANGED' });
  assert.doesNotThrow(() => {
    child = spawnHidden(process.execPath, ['-e', 'process.stdout.write("MUST_NOT_RUN");'], {
      ...options, containProcessTree: true,
      rootLaunch: { beforeRootSpawn() { throw refusal; }, spawned() {} },
    });
  }, 'the contained handle must exist before final admission is checked');
  t.after(() => reclaim(child));
  child.on('error', () => {});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  await assert.rejects(child.jobReady, process.platform === 'win32'
    ? { name: 'WindowsJobError', code: 'WINDOWS_JOB_LAUNCH_REFUSED', message: refusal.message }
    : error => error === refusal);
  const receipt = await child.jobOutcome;
  assert.equal(receipt.type, 'not-started');
  assert.equal(receipt.activeProcesses, 0);
  if (process.platform === 'linux') assert.equal(receipt.observedChildren, 0);
  assert.equal(output, '');
});

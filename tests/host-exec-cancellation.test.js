'use strict';
require('./lib/isolated-environment').activate('host-exec-cancellation');
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter, getEventListeners } = require('node:events');
const host = require('../src/lib/providers/host-control');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(extra = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const termination = deferred();
  const wrapper = deferred();
  child.jobClosed = wrapper.promise;
  let launches = 0, terminations = 0;
  child.terminateJob = () => { terminations += 1; return termination.promise; };
  const controller = new AbortController();
  const records = [];
  const dependencies = {
    platform: 'win32', signal: controller.signal,
    requireRecordAsync: async () => ({ ok: true }),
    recordAsync: async (...record) => { records.push(record); },
    spawnInJobImpl: () => { launches += 1; return child; },
    ...extra
  };
  return { child, termination, wrapper, controller, records, dependencies,
    launches: () => launches, terminations: () => terminations };
}
const command = { command: 'Write-Output cancellation-fixture' };
const empty = { type: 'terminated', exitCode: 124, activeProcesses: 0 };

test('an already cancelled call never writes admission or launches', async () => {
  const f = fixture({ requireRecordAsync: () => assert.fail('no admission after cancellation') });
  f.controller.abort('private source reason');
  await assert.rejects(host.exec(command, f.dependencies), { code: 'ABORT_ERR', message: 'The operation was cancelled.' });
  assert.equal(f.launches(), 0);
});

test('cancellation during audit admission prevents the later launch', async () => {
  const admission = deferred();
  const f = fixture({ requireRecordAsync: () => admission.promise });
  const pending = host.exec(command, f.dependencies);
  f.controller.abort();
  admission.resolve({ ok: true });
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  assert.equal(f.launches(), 0);
});

test('cancellation waits for the empty Job receipt and retained wrapper closure', async () => {
  const f = fixture();
  const outcome = deferred();
  f.child.jobOutcome = outcome.promise;
  let settled = false;
  const pending = host.exec(command, f.dependencies);
  const answer = pending.then(() => { settled = true; assert.fail('cancelled command resolved'); }, error => { settled = true; return error; });
  await tick();
  f.controller.abort();
  f.child.emit('close', 124);
  await tick();
  assert.equal(f.terminations(), 1);
  assert.equal(settled, false, 'process close alone is not proof of Job cleanup');
  outcome.resolve(empty);
  await tick();
  assert.equal(settled, false, 'the native outcome must not bypass pending cancellation cleanup');
  f.termination.resolve(empty);
  await tick();
  assert.equal(settled, false, 'empty Job alone must still wait for the retained wrapper');
  f.wrapper.resolve({ code: 124, failure: null });
  assert.equal((await answer).code, 'ABORT_ERR');
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
  assert.equal(f.records[0][2].cancelled, true);
  assert.equal(f.records[0][2].ok, false);
});

test('a rejected cleanup remains a failure even if the retained wrapper fallback succeeds', async () => {
  const f = fixture();
  f.child.terminateRetainedWrapper = async () => { f.child.emit('close', 124); return empty; };
  const pending = host.exec(command, f.dependencies);
  const answer = assert.rejects(pending, { code: 'HOST_EXEC_TERMINATION_FAILED', details: { cleanupCode: 'WINDOWS_JOB_CONTROL_UNAVAILABLE' } });
  await tick();
  f.controller.abort();
  f.termination.reject(Object.assign(new Error('private control failure'), { code: 'WINDOWS_JOB_CONTROL_UNAVAILABLE' }));
  await answer;
  assert.equal(f.records[0][2].terminationFailureCode, 'WINDOWS_JOB_CONTROL_UNAVAILABLE');
});

test('an unproved cancellation hits its bounded deadline instead of returning cancelled', async () => {
  const timers = [];
  const f = fixture({
    setTimeoutImpl(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeoutImpl() {}, terminationDeadlineMs: 17
  });
  const pending = host.exec(command, f.dependencies);
  const answer = assert.rejects(pending, { code: 'HOST_EXEC_TERMINATION_FAILED', details: { cleanupCode: 'HOST_EXEC_TERMINATION_DEADLINE' } });
  await tick();
  f.controller.abort();
  timers.find(timer => timer.delay === 17).callback();
  await answer;
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
  f.termination.resolve(empty);
  f.wrapper.resolve({ code: 124, failure: null });
});

test('a command that finished first cannot be cancelled retroactively', async () => {
  const f = fixture();
  const pending = host.exec(command, f.dependencies);
  await tick();
  f.child.emit('close', 0);
  assert.equal((await pending).ok, true);
  f.controller.abort();
  assert.equal(f.terminations(), 0);
});

test('the same signal cancels the Linux owned adapter and awaits its native outcome', async () => {
  const f = fixture({ platform: 'linux' });
  const outcome = deferred();
  f.child.jobOutcome = outcome.promise;
  f.child.kill = () => assert.fail('the owned scope must not fall back to a direct-child signal');
  let settled = false;
  const pending = host.exec(command, f.dependencies);
  const answer = pending.then(() => assert.fail('cancelled command resolved'), error => { settled = true; return error; });
  await tick();
  f.controller.abort();
  f.child.emit('close', null);
  f.termination.resolve(empty);
  await tick();
  assert.equal(f.terminations(), 1);
  assert.equal(settled, false, 'a close event cannot replace the native descendant observation');
  f.wrapper.resolve({ failure: null });
  outcome.resolve(empty);
  assert.equal((await answer).code, 'ABORT_ERR');
});

test('Linux cancellation still waits for child close after all native receipts settle', async () => {
  const f = fixture({ platform: 'linux' });
  f.child.jobOutcome = Promise.resolve(empty);
  f.child.kill = () => assert.fail('the retained Linux scope owns termination');
  let answered = false;
  const pending = host.exec(command, f.dependencies);
  const answer = assert.rejects(pending, { code: 'ABORT_ERR' });
  answer.then(() => { answered = true; });
  await tick();
  f.controller.abort();
  f.termination.resolve(empty);
  f.wrapper.resolve({ failure: null });
  await tick();
  assert.equal(f.terminations(), 1);
  assert.equal(answered, false, 'native cleanup cannot fabricate the child close event');
  f.child.emit('close', null);
  await answer;
});

for (const platform of ['win32', 'linux']) test(`${platform} native cleanup refusal survives close and a successful cancellation receipt`, async () => {
  const f = fixture({ platform });
  const outcome = deferred();
  f.child.jobOutcome = outcome.promise;
  const pending = host.exec(command, f.dependencies);
  const answer = assert.rejects(pending, { code: 'HOST_EXEC_TERMINATION_FAILED',
    details: { cleanupCode: 'FIXTURE_NATIVE_CUSTODY_UNKNOWN' } });
  await tick();
  f.controller.abort();
  f.child.emit('close', 0);
  f.termination.resolve(empty);
  f.wrapper.resolve({ failure: null });
  outcome.resolve({ activeProcesses: null, reasonCode: 'FIXTURE_NATIVE_CUSTODY_UNKNOWN' });
  await answer;
});

test('cancellation arriving inside spawn is observed after lifecycle listeners are attached', async () => {
  const f = fixture();
  f.dependencies.spawnInJobImpl = () => { f.controller.abort(); return f.child; };
  const pending = host.exec(command, f.dependencies);
  const answer = assert.rejects(pending, { code: 'ABORT_ERR' });
  await tick();
  assert.equal(f.terminations(), 1);
  f.termination.resolve(empty);
  f.wrapper.resolve({ code: 124, failure: null });
  f.child.emit('close', 124);
  await answer;
});

test('Stop arriving after an unproved timeout kill still requires an empty Job receipt', async () => {
  const timers = [];
  const f = fixture({
    killTree: () => undefined,
    setTimeoutImpl(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeoutImpl() {}
  });
  const pending = host.exec({ ...command, timeoutMs: 1000 }, f.dependencies);
  const answer = assert.rejects(pending, { code: 'HOST_EXEC_TERMINATION_FAILED', details: { cleanupCode: 'HOST_EXEC_CLEANUP_UNPROVED' } });
  await tick();
  timers.find(timer => timer.delay <= 1000).callback();
  await tick();
  f.controller.abort();
  f.child.emit('close', 0);
  await answer;
});

test('agent executor cancellation reaches a real running owned command', {
  timeout: 45000,
  skip: !['win32', 'linux'].includes(process.platform)
}, async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = process.env.TOOLSENABLED_TEST_ROOT;
  assert.ok(root && path.isAbsolute(root), 'native marker paths must belong to this isolated test');
  const settings = require('../src/lib/settings');
  const settingsFile = settings.resolveValuesPath();
  assert.equal(require('./lib/isolated-environment').within(root, settingsFile), true);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ revision: 1,
    values: { 'agent.tool_approvals': false },
    provenance: { 'agent.tool_approvals': { source: 'user', atMs: Date.now(), directive: 'isolated cancellation fixture' } }
  }));
  const actualExec = host.exec;
  let child;
  host.exec = (args, context) => actualExec(args, {
    ...context,
    requireRecordAsync: async () => ({ ok: true }),
    recordAsync: async () => ({ ok: true }),
    spawnInJobImpl(file, argv, options, dependencies) {
      const spawnOwned = process.platform === 'win32'
        ? require('../src/lib/windows-job-control').spawnInJob
        : require('../src/lib/linux-process-control').spawnLinuxOwned;
      child = spawnOwned(file, argv, options, dependencies);
      child.on('error', () => {});
      return child;
    },
    windowsJobDependencies: { recordDirectory: path.join(root, 'executor-jobs'),
      assemblyCacheDirectory: path.join(root, 'executor-assembly'), cleanupTimeoutMs: 3000 }
  });
  t.after(async () => {
    host.exec = actualExec;
    if (child && !child._closed) await child.terminateJob().catch(() => {});
    if (child) await child.jobClosed;
  });
  const registry = require('../src/lib/tool-registry');
  const marker = path.join(root, 'executor-cancel-marker.txt');
  const script = path.join(root, 'executor-cancel-command.cjs');
  fs.writeFileSync(script, `const fs = require('node:fs'); const marker = ${JSON.stringify(marker)};
    fs.writeFileSync(marker, 'BEFORE\\n');
    setTimeout(() => fs.appendFileSync(marker, 'AFTER\\n'), 1500);\n`);
  const quote = value => process.platform === 'win32'
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
  const commandText = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`;
  const controller = new AbortController();
  const executor = registry.createAgentToolExecutor({
    permissionSession: { origin: 'local', tier: 'full' }
  });
  let answer;
  const pending = executor.execute('host.exec', { command: commandText, timeoutMs: 20000 }, {
    signal: controller.signal
  }).then(value => { answer = { value }; }, error => { answer = { error }; });
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(marker) && !answer && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(answer, undefined, `command refused before its marker: ${answer?.error?.code}`);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'BEFORE\n', 'prove the real command is running before cancellation');
  const cancelledAt = Date.now();
  controller.abort();
  await pending;
  assert.equal(answer.error?.code, 'ABORT_ERR', 'the operation signal must reach the running native command');
  const outcome = await child.jobOutcome;
  assert.equal(outcome.activeProcesses, 0);
  assert.equal((await child.jobClosed).failure, null);
  if (process.platform === 'linux') {
    assert.ok(outcome.observedChildren >= 2, 'the shell and its Node descendant must both be observed');
    assert.equal(outcome.reapedChildren, outcome.observedChildren);
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, cancelledAt + 1700 - Date.now())));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'BEFORE\n', 'a cancelled command cannot publish its delayed effect');
});

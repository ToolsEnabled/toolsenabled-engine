'use strict';

// host.exec's timeout is a process-tree contract, not a cosmetic timer.
// These deliberately use the real exported execution seam with a bounded fake
// process, so they prove the timeout callback reaches the retained Job Object
// rather than a mutable PID walk.  No command, profile, audit ledger, or
// installed state is touched.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// STRICT admission, so the audit stub below is the seam the provider reaches.
// In `fast` mode host.exec admits its intent and result records through the
// group-commit queue (src/lib/audit-admission.js) rather than through
// audit.requireRecord()/audit.record() directly, and this file's whole point
// is that no real ledger is touched. Set before the first read; the mode is
// memoised on first use.
process.env.TOOLSENABLED_TOOLS_THROUGHPUT = 'strict';

const audit = require('../src/lib/audit');
const host = require('../src/lib/providers/host-control');

// The intent record is awaited before the launch (see host-control.js exec),
// so the spawn happens one turn of the event loop after host.exec() returns.
// Every check that reads the launch's side effects waits for that turn first.
const launched = () => new Promise(resolve => setImmediate(resolve));

function fakeChild(pid = 4172, { contained = true } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.terminations = 0;
  child.kill = signal => { child.kills.push(signal); return true; };
  if (contained) child.terminateJob = async () => {
    child.terminations += 1;
    return { type: 'terminated', exitCode: 124, activeProcesses: 0 };
  };
  return child;
}

function fakeTimer() {
  const timers = [];
  return {
    setTimeoutImpl(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) { timer.cleared = true; },
    timers
  };
}

async function withAuditStub(run) {
  const originalRequireRecord = audit.requireRecord;
  const originalRecord = audit.record;
  const records = [];
  audit.requireRecord = (...entry) => { records.push(entry); return { ok: true }; };
  audit.record = (...entry) => { records.push(entry); return { ok: true }; };
  try { return await run(records); }
  finally {
    audit.requireRecord = originalRequireRecord;
    audit.record = originalRecord;
  }
}

async function timeoutKillsTheWindowsTree() {
  await withAuditStub(async records => {
    const command = fakeChild(4172);
    const invocations = [];
    const timer = fakeTimer();
    const pending = host.exec({ command: 'Write-Output timeout-fixture', timeoutMs: 1000 }, {
      platform: 'win32',
      nowImpl: () => 5000,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      spawnInJobImpl(file, args, options) {
        invocations.push({ file, args, options });
        return command;
      }
    });
    await launched();

    assert.equal(timer.timers.length, 1, 'a wall-clock timer must be installed for the spawned command');
    assert.equal(timer.timers[0].delay, 1000, 'the measured timeout must be passed through exactly');
    timer.timers[0].callback();
    assert.equal(invocations.length, 1, 'the command must be launched exactly once through the containment seam');
    assert.equal(command.terminations, 1, 'timeout must terminate the retained Job Object exactly once');
    assert.equal(command.kills.length, 0, 'an exact Job Object termination must not PID-kill the wrapper');
    command.emit('close', 124);

    const result = await pending;
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false, 'a timed-out command can never report success');
    assert.equal(result.exitCode, 124, 'the contained wrapper reports its bounded termination status');
    assert.equal(timer.timers[0].cleared, true, 'the close path must clear the wall-clock timer');
    assert.deepEqual(records.map(entry => entry[0]), ['host.exec.intent', 'host.exec.result']);
    assert.equal(records[1][2].timedOut, true, 'the durable result must say that the cap fired');
  });
}

async function treeKillUsesRetainedJobIdentity() {
  const child = fakeChild(4173);
  const receipt = await host.killExecTree(child, { platform: 'win32' });
  assert.equal(receipt.activeProcesses, 0);
  assert.equal(child.terminations, 1, 'Windows cleanup must address the retained Job Object');
  assert.deepEqual(child.kills, [], 'the mutable PID fallback must not run for a contained Windows child');
}

async function outputCapAlsoStopsTheTree() {
  await withAuditStub(async () => {
    const command = fakeChild(4174);
    const timer = fakeTimer();
    const calls = [];
    const pending = host.exec({ command: 'Write-Output output-fixture', timeoutMs: 1000 }, {
      nowImpl: () => 7000,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      spawnInJobImpl: () => command,
      killTree(child) { calls.push(child.pid); }
    });
    await launched();
    command.stdout.emit('data', Buffer.alloc(host.MAX_OUTPUT_BYTES + 1, 0x61));
    assert.deepEqual(calls, [4174], 'the output ceiling must terminate the same tree, not merely truncate its receipt');
    command.emit('close', 0);
    const result = await pending;
    assert.equal(result.outputTruncated, true);
    assert.equal(result.ok, false, 'an output-capped command has an incomplete result, never a success');
    assert.equal(Buffer.byteLength(result.stdout, 'utf8') <= host.MAX_OUTPUT_BYTES, true);
  });
}

async function brokenControlChannelUsesRetainedWrapper() {
  await withAuditStub(async () => {
    const command = fakeChild(4176);
    const timer = fakeTimer();
    command.terminateJob = async () => {
      command.terminations += 1;
      throw Object.assign(new Error('named pipe unavailable'), { code: 'WINDOWS_JOB_CONTROL_UNAVAILABLE' });
    };
    command.wrapperTerminations = 0;
    command.terminateRetainedWrapper = async () => {
      command.wrapperTerminations += 1;
      command.emit('close', 124);
      return { type: 'wrapper-terminated', exitCode: 124, activeProcesses: 0 };
    };
    const pending = host.exec({ command: 'Write-Output broken-control-fixture', timeoutMs: 1000 }, {
      platform: 'win32',
      nowImpl: () => 9000,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      spawnInJobImpl: () => command
    });
    await launched();
    timer.timers[0].callback();
    command.stdout.emit('data', Buffer.alloc(host.MAX_OUTPUT_BYTES + 1));
    const result = await pending;
    assert.equal(command.terminations, 1);
    assert.equal(command.wrapperTerminations, 1,
      'a rejected control termination must close the retained wrapper handle exactly once');
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
  });
}

async function hangingFallbackStillSettlesByDeadline() {
  await withAuditStub(async records => {
    const command = fakeChild(4177);
    const timer = fakeTimer();
    command.terminateJob = async () => {
      throw Object.assign(new Error('original control failure'), { code: 'WINDOWS_JOB_CONTROL_UNAVAILABLE' });
    };
    command.terminateRetainedWrapper = () => new Promise(() => {});
    const pending = host.exec({ command: 'Write-Output hanging-fallback', timeoutMs: 1000 }, {
      platform: 'win32', nowImpl: () => 10000,
      terminationDeadlineMs: 250,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      spawnInJobImpl: () => command
    });
    await launched();
    timer.timers[0].callback();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(timer.timers.length, 2, 'termination installs one bounded settlement deadline');
    timer.timers[1].callback();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.terminationFailure.code, 'WINDOWS_JOB_CONTROL_UNAVAILABLE',
      'the original termination failure survives a hanging fallback');
    assert.equal(records[1][2].terminationFailureCode, 'WINDOWS_JOB_CONTROL_UNAVAILABLE');
  });
}

function nonWindowsFallbackStopsTheDirectChild() {
  const child = fakeChild(4175, { contained: false });
  host.killExecTree(child, { platform: 'linux' });
  assert.deepEqual(child.kills, ['SIGTERM']);
}

(async () => {
  await timeoutKillsTheWindowsTree();
  await treeKillUsesRetainedJobIdentity();
  await outputCapAlsoStopsTheTree();
  await brokenControlChannelUsesRetainedWrapper();
  await hangingFallbackStillSettlesByDeadline();
  nonWindowsFallbackStopsTheDirectChild();
  process.stdout.write('host.exec timeout-tree: 6 checks passed\n');
})().catch(error => {
  process.stdout.write(`host.exec timeout-tree failure: ${String(error && (error.stack || error)).replace(/[\r\n]+/g, ' | ')}\n`);
  process.exitCode = 1;
});

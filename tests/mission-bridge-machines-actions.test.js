/* Mutation check (2026-08-27):
 * In machines-actions.js, changed statusReport's ['-Status', '-Json'] arguments
 * to ['-Off', '-Json']; the replacement landed and was printed before testing.
 * This isolated test file went red (exit 1), proving it guards the status verb.
 * The module was restored and its original SHA-256 was confirmed afterward.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const {
  createMachinesActions,
  MACHINES_LINK_TIMEOUT_MS
} = require('../src/lib/mission-bridge/machines-actions');

const REPORT = Object.freeze({
  on: true,
  working: true,
  problem: null,
  thisComputer: 'workstation-a',
  otherComputer: 'workstation-b'
});

function scriptedExec(steps) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    const step = steps[calls.length];
    calls.push({ file, args, options });
    process.nextTick(() => callback(step.error || null, step.stdout || '', step.stderr || ''));
  };
  execFile.calls = calls;
  return execFile;
}

const allowingPolicy = { assertActive() {} };

test('status calls the direct-link control with its status timeout and returns its JSON report', async () => {
  const execFile = scriptedExec([{ stdout: `diagnostic prefix\n${JSON.stringify(REPORT)}\n` }]);
  const actions = createMachinesActions({
    execFile, policy: allowingPolicy, root: '/test/product', isOutward: () => true
  });

  const result = await actions.machinesLinkStatus();

  assert.deepEqual(result, {
    ok: true,
    receipt: { action: 'machines-link-status', report: REPORT }
  });
  assert.equal(execFile.calls.length, 1);
  assert.deepEqual(execFile.calls[0].args.slice(-3), [
    /* The product joins its root with the script path, so the expected value must be
       joined the same way. A literal with forward slashes pins POSIX separators and
       fails on Windows against code that is doing exactly the right thing. */
    path.join('/test/product', 'tools', 'direct-link.ps1'), '-Status', '-Json'
  ]);
  assert.equal(execFile.calls[0].options.timeout, MACHINES_LINK_TIMEOUT_MS.status);
});

test('on reports the verb exit outcome, then returns a fresh status report', async () => {
  const nonzeroExit = Object.assign(new Error('exit 7'), { code: 7 });
  const execFile = scriptedExec([
    { error: nonzeroExit, stderr: 'peer did not connect' },
    { stdout: JSON.stringify({ ...REPORT, on: false, working: false }) }
  ]);
  const actions = createMachinesActions({ execFile, policy: allowingPolicy, isOutward: () => true });

  const result = await actions.machinesLinkOn();

  assert.equal(result.ok, true);
  assert.equal(result.receipt.action, 'machines-link-on');
  assert.equal(result.receipt.exitCode, 7);
  assert.equal(result.receipt.completed, false);
  assert.equal(result.receipt.report.working, false);
  assert.ok(execFile.calls[0].args.includes('-On'));
  assert.equal(execFile.calls[0].options.timeout, MACHINES_LINK_TIMEOUT_MS.on);
  assert.ok(execFile.calls[1].args.includes('-Status'));
});

test('policy refusal prevents off from spawning the direct-link control', async () => {
  const execFile = scriptedExec([]);
  const policy = { assertActive() { throw new Error('owner kill switch'); } };
  const actions = createMachinesActions({ execFile, policy, isOutward: () => true });

  await assert.rejects(actions.machinesLinkOff(), error => {
    assert.equal(error.code, 'BRIDGE_GUARD_REFUSED');
    assert.equal(error.status, 409);
    assert.match(error.message, /owner kill switch/);
    return true;
  });
  assert.equal(execFile.calls.length, 0);
});

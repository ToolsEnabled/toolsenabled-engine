'use strict';
require('../lib/isolated-environment').activate('fleet-evidence-process-lifetime');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnHidden } = require('../../src/lib/proc/hidden-spawn');
const { runHarnessCommand } = require('../../src/lib/fleet-supervisor/evidence');

test('fleet evidence timeout waits for a real detached descendant to stop', {
  skip: !['linux', 'win32'].includes(process.platform), timeout: 45000
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-evidence-lifetime-'));
  const marker = path.join(directory, 'effects.txt');
  // The deadline starts before native ownership, root, and detached-leaf cold start.
  // Match the proven Windows allowance so this exercises a real descendant timeout.
  const budget = 10000;
  const leaf = `const fs=require('node:fs');const timer=setInterval(()=>{fs.appendFileSync(${JSON.stringify(marker)},'effect\\n');process.stdout.write('effect\\n')},25);setTimeout(()=>{clearInterval(timer);process.exit(0)},${budget + 1200});`;
  const program = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:['ignore','inherit','inherit'],env:process.env});setInterval(()=>{},1000);`;
  let child, closed;
  t.after(async () => {
    if (child?.terminateJob) { await child.terminateJob(); await child.jobClosed; }
    else if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const result = await runHarnessCommand({ executable: process.execPath, args: ['-e', program] }, {
    workspace: directory, timeoutMs: budget,
    spawnImpl(...args) { child = spawnHidden(...args); closed = once(child, 'close'); return child; }
  });
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(result.ran, false);
  assert.equal(result.cleanupConfirmed, true, 'a timeout must retain ownership until its descendant scope is empty');
  assert.ok(fs.existsSync(marker), 'the fixture must execute real descendant effects before timing out');
  const size = fs.statSync(marker).size;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(fs.statSync(marker).size, size, 'no descendant effect may occur after the terminal result');
  const receipt = await child.jobOutcome;
  assert.equal(receipt.activeProcesses, 0);
  assert.equal((await child.jobClosed).failure, null);
  if (process.platform === 'linux') {
    assert.ok(receipt.observedChildren >= 2);
    assert.equal(receipt.observedChildren, receipt.reapedChildren);
  }
});

test('fleet evidence reads the real root exit status after native scope cleanup', {
  skip: !['linux', 'win32'].includes(process.platform), timeout: 30000
}, async () => {
  const result = await runHarnessCommand({ executable: process.execPath,
    args: ['-e', 'process.stdout.write("root-failure\\n");process.exit(7);'] }, {
    workspace: process.cwd(), timeoutMs: 20000
  });
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 7, 'the wrapper exit cannot replace the command\'s failure');
  assert.equal(result.output, 'root-failure\n');
  assert.equal(result.cleanupConfirmed, true);
});

function heldScope({ receipt = null, closeFailure = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.jobOutcome = receipt ? Promise.resolve(receipt) : new Promise(() => {});
  child.jobClosed = Promise.resolve({ failure: closeFailure });
  child.terminateJob = () => child.jobOutcome;
  return child;
}

test('an empty-scope receipt must still wait for wrapper and pipe closure', async () => {
  let close;
  const child = heldScope({ receipt: { type: 'exit', activeProcesses: 0, exitCode: 7 } });
  child.jobClosed = new Promise(resolve => { close = resolve; });
  let settled = false;
  const pending = runHarnessCommand({ executable: 'fixture', args: [] }, {
    workspace: process.cwd(), timeoutMs: 1000, cleanupTimeoutMs: 1000,
    spawnImpl: () => child
  }).then(value => { settled = true; return value; });
  child.emit('close', 0, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'a receipt alone does not establish that the owned wrapper has closed');
  close({ failure: null });
  const result = await pending;
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 7);
  assert.equal(result.cleanupConfirmed, true);
});

for (const [name, scope] of [
  ['missing receipt', {}],
  ['live descendants', { receipt: { type: 'terminated', activeProcesses: 1, exitCode: 0 } }],
  ['failed wrapper close', { receipt: { type: 'terminated', activeProcesses: 0, exitCode: 0 }, closeFailure: 'fixture failure' }]
]) test(`fleet evidence cannot claim cleanup with ${name}`, async t => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const result = await runHarnessCommand({ executable: 'fixture', args: [] }, {
    workspace: process.cwd(), timeoutMs: 10, cleanupTimeoutMs: 30,
    spawnImpl: () => heldScope(scope)
  });
  assert.equal(result.ran, false);
  assert.equal(result.code, 'CLEANUP_UNPROVEN');
  assert.equal(result.cleanupConfirmed, false);
});

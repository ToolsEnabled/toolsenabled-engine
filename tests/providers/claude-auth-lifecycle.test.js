'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { probeClaudeAuth } = require('../../src/lib/providers/claude-auth-probe');
const { probeLifecycleOf } = require('../../src/lib/multi-account/probe-lifecycle');

const EMPTY = { type: 'exit', activeProcesses: 0, exitCode: 0 };
const STATUS = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
  email: 'synthetic@example.invalid', subscriptionType: 'sample-plan' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function spawnSeam({ receipt = Promise.resolve(EMPTY), status = STATUS } = {}) {
  let options;
  const spawnImpl = (_command, _args, value) => {
    options = value;
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.jobOutcome = receipt;
    let closed = false;
    const close = () => { if (!closed) { closed = true; child.emit('close', 0, null); } };
    child.kill = () => { setImmediate(close); return true; };
    child.terminateJob = async () => { close(); return receipt; };
    setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(status))); close(); });
    return child;
  };
  return { spawnImpl, get options() { return options; } };
}

function probe(seam) {
  const fixture = path.join(path.parse(process.cwd()).root, 'synthetic-claude-auth');
  return probeClaudeAuth({ capability: false, configDir: fixture, cwd: fixture,
    executable: { command: 'synthetic-claude', prefixArgs: [] }, baseEnvironment: { PATH: 'fixture-only' },
    spawnImpl: seam.spawnImpl, statusTimeoutMs: 25 });
}

test('auth status waits for owned tree cleanup after its direct CLI exits', async () => {
  const custody = deferred();
  const seam = spawnSeam({ receipt: custody.promise });
  let settled = false;
  const reading = probe(seam).then(result => { settled = true; return result; });
  await tick(); await tick();
  const settledBeforeCleanup = settled;
  custody.resolve(EMPTY);
  const result = await reading;
  assert.equal(settledBeforeCleanup, false, 'auth identity must not escape while its provider tree remains active');
  assert.equal(result.account, 'synthetic@example.invalid');
  assert.equal(result.capabilityRan, false);
  assert.equal(probeLifecycleOf(result), 'closed');
  assert.equal(seam.options.containProcessTree, true);
  assert.equal(seam.options.windowsHide, true);
});

test('auth rejects unproved cleanup with the same retained cleanup operation', async () => {
  const seam = spawnSeam({ receipt: Promise.resolve({ type: 'exit', activeProcesses: 1 }) });
  await assert.rejects(probe(seam), error => error.code === 'CODEX_PROCESS_CLEANUP_UNPROVEN'
    && typeof error.retryCleanup === 'function');
});

test('an oversized auth reply cannot supply a selectable identity or billing route', async () => {
  const seam = spawnSeam({ status: { ...STATUS, padding: 'x'.repeat(1024 * 1024) } });
  const result = await probe(seam);
  assert.equal(result.state, 'indeterminate');
  assert.equal(result.account, null);
  assert.equal(result.billingSource, null);
  assert.equal(result.usable, false);
  assert.equal(result.canFailover, false);
  assert.ok(JSON.stringify(result).length < 2048);
});

test('a caught auth spawn exception carries no invented never-started receipt', async () => {
  const result = await probe({ spawnImpl() { throw Object.assign(new Error('synthetic spawn failure'), { code: 'ENOENT' }); } });
  assert.equal(result.state, 'indeterminate');
  assert.equal(probeLifecycleOf(result), null);
});

'use strict';

// Synthetic provider protocol and owned-process receipts only. No provider,
// account file, credential, native UI, or network is opened by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { claudeUsageProbe, MAX_STDOUT_CHARS } = require('../../src/lib/providers/claude-usage-probe');
const { claudeProbeFactory, readAccountUsage, resolveAccountForSession } = require('../../src/lib/multi-account/rotation');
const { probeLifecycleOf } = require('../../src/lib/multi-account/probe-lifecycle');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const EMPTY = Object.freeze({ type: 'terminated', activeProcesses: 0, exitCode: 0 });
const REPLY = Object.freeze({ rate_limits_available: true, rate_limits: {
  five_hour: { utilization: 17, resets_at: null }
} });

function ownedChild({ receipt = Promise.resolve(EMPTY), stderrFlood = false, holdClose = null, replyImmediately = false } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.jobOutcome = receipt;
  const fixtureClosed = deferred();
  child.fixtureClosed = fixtureClosed.promise;
  let closed = false;
  const emitClose = () => {
    if (closed) return;
    closed = true;
    child.emit('close', 0, null);
    fixtureClosed.resolve();
  };
  const close = () => { if (holdClose) holdClose.then(emitClose); else emitClose(); };
  child.stdin.write = text => {
    const request = JSON.parse(text);
    const reply = () => {
      if (stderrFlood) child.stderr.emit('data', Buffer.from('x'.repeat(MAX_STDOUT_CHARS + 1)));
      else child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'control_response', response: {
        subtype: 'success', request_id: request.request_id, response: REPLY
      } })}\n`));
    };
    if (replyImmediately) reply(); else setImmediate(reply);
    return true;
  };
  child.stdin.end = () => setImmediate(close);
  child.kill = () => { setImmediate(close); return true; };
  child.terminateJob = async () => { close(); return receipt; };
  return child;
}

function probe(child, extra = {}) {
  const fixture = path.join(path.parse(process.cwd()).root, 'synthetic-claude-home');
  return claudeUsageProbe({ configDir: fixture, cwd: fixture,
    baseEnvironment: { PATH: 'fixture-only' }, executable: { command: 'synthetic-claude', prefixArgs: [] },
    spawnImpl: (_command, _args, options) => { child.options = options; return child; },
    timeoutMs: 25, exitGraceMs: 1, ...extra });
}

test('usage waits for an empty owned tree after the direct CLI closes', async () => {
  const custody = deferred();
  // This case proves ordering after a successful reply, not scheduling inside
  // the request timeout. Deliver the controlled reply explicitly and wait for
  // the simulated close event, instead of racing a 25 ms clock with three ticks.
  const child = ownedChild({ receipt: custody.promise, replyImmediately: true });
  let settled = false;
  const reading = probe(child).then(result => { settled = true; return result; });
  await child.fixtureClosed;
  const settledBeforeReceipt = settled;
  custody.resolve(EMPTY);
  const result = await reading;
  assert.equal(settledBeforeReceipt, false, 'direct close alone cannot release an allowance from an active owned tree');
  assert.equal(result.status, 'MEASURED', JSON.stringify(result));
  assert.equal(probeLifecycleOf(result), 'closed');
  assert.equal(child.options.containProcessTree, true);
  assert.equal(child.options.windowsHide, true);
});

test('a caught usage spawn exception carries no invented never-started receipt', async () => {
  const result = await probe(null, { spawnImpl() { throw Object.assign(new Error('synthetic spawn failure'), { code: 'ENOENT' }); } });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(probeLifecycleOf(result), null);
});

test('a valid allowance is withheld when the owned tree receipt does not prove closure', async () => {
  const child = ownedChild({ receipt: Promise.resolve({ type: 'terminated', activeProcesses: 1 }) });
  await assert.rejects(probe(child), error => error.code === 'CODEX_PROCESS_CLEANUP_UNPROVEN'
    && typeof error.retryCleanup === 'function');
});

function cleanupError(retryCleanup) {
  const error = new Error('synthetic owned cleanup unavailable');
  error.code = 'CODEX_PROCESS_CLEANUP_UNPROVEN';
  Object.defineProperty(error, 'retryCleanup', { value: retryCleanup });
  return error;
}
const signedIn = async () => ({ state: 'indeterminate', capabilityRan: false,
  billingSource: 'subscription', account: 'synthetic@example.invalid', plan: 'sample-plan' });

test('Claude factory propagates cleanup failure while ordinary unavailable quota preserves auth', async () => {
  const fixture = path.join(path.parse(process.cwd()).root, 'synthetic-claude-home');
  const account = { name: 'fixture', provider: 'claude', configDir: fixture, priority: 1 };
  const failure = cleanupError(async () => {});
  const make = usageProbe => claudeProbeFactory({ homeDir: path.parse(process.cwd()).root,
    exhaustedAtPercent: 99, authProbe: signedIn, usageProbe });
  await assert.rejects(make(async () => { throw failure; })(account), error => error === failure);
  const unavailable = await make(async () => ({ status: 'UNKNOWN', reason: 'CLAUDE_USAGE_FETCH_UNAVAILABLE' }))(account);
  assert.equal(unavailable.status, 'healthy');
  assert.equal(unavailable.canServe, true);
  assert.equal(unavailable.usageStatus, 'unavailable');
});

test('two failed Claude children retain both cleanup operations without retrying either automatically', async () => {
  const retried = [];
  const authFailure = cleanupError(async () => { retried.push('auth'); });
  const usageFailure = cleanupError(async () => { retried.push('usage'); });
  const run = claudeProbeFactory({ homeDir: path.parse(process.cwd()).root, exhaustedAtPercent: 99,
    authProbe: async () => { throw authFailure; }, usageProbe: async () => { throw usageFailure; } });
  let failure;
  try { await run({ name: 'fixture', provider: 'claude', priority: 1,
    configDir: path.join(path.parse(process.cwd()).root, 'synthetic-claude-home') }); }
  catch (error) { failure = error; }
  assert.equal(failure?.code, 'CLAUDE_ACCOUNT_CLEANUP_UNPROVEN');
  assert.deepEqual(retried, []);
  await failure.retryCleanup();
  assert.deepEqual(retried.sort(), ['auth', 'usage']);
});

test('Accounts and Start block an unclosed Claude check as transient without invalidating sign-in', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cleanup-rotation-'));
  const servicesRoot = path.join(root, 'services');
  const stateRoot = path.join(root, 'capability');
  const registryPath = path.join(stateRoot, 'config', 'accounts.json');
  const account = { name: 'fixture', provider: 'claude', configDir: '.claude-fixture', priority: 1 };
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.mkdirSync(servicesRoot);
  fs.mkdirSync(path.join(root, account.configDir));
  fs.writeFileSync(path.join(root, account.configDir, '.credentials.json'), '{"fixture":true}');
  fs.writeFileSync(registryPath, JSON.stringify({ accounts: [account] }));
  const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT;
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot;
  let retryCalls = 0;
  let probeCalls = 0;
  const failure = cleanupError(async () => { retryCalls += 1; });
  const check = claudeProbeFactory({ homeDir: root, exhaustedAtPercent: 99, authProbe: signedIn,
    usageProbe: async () => { probeCalls += 1; throw failure; } });
  try {
    const usage = await readAccountUsage({ registryPath, homeDir: root, providers: ['claude'], probeFor: () => check });
    assert.equal(usage.accounts.length, 1);
    const row = usage.accounts[0];
    assert.equal(row.status, 'transient');
    assert.equal(row.canServe, false);
    assert.equal(row.usageStatus, 'unavailable');
    assert.equal(row.usageCode, 'CODEX_PROCESS_CLEANUP_UNPROVEN');
    assert.equal(probeLifecycleOf(row), 'unproven');
    assert.equal(row.usedPercent, null);
    assert.equal(typeof row.retryCleanup, 'function');
    assert.equal(JSON.stringify(row).includes('retryCleanup'), false);
    const start = await resolveAccountForSession({ provider: 'claude', servicesRoot, homeDir: root,
      mode: 'auto', probe: check });
    assert.equal(start.blocked, true);
    assert.equal(start.account, null);
    assert.deepEqual(start.attempts.map(attempt => attempt.status), ['transient']);
    assert.equal(probeCalls, 2, 'each explicit check asked once; no silent provider retry');
    assert.equal(retryCalls, 0);
    await row.retryCleanup();
    assert.equal(retryCalls, 1);
  } finally {
    if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty owned tree still waits for the retained CLI pipes to close', async () => {
  const pipeClosure = deferred();
  const child = ownedChild({ holdClose: pipeClosure.promise });
  let settled = false;
  const reading = probe(child, { exitGraceMs: 0 }).then(result => { settled = true; return result; });
  // Let the zero-duration grace run. Closure remains under explicit control;
  // this asserts ordering, not the machine's execution speed.
  await new Promise(resolve => setTimeout(resolve, 10));
  const settledBeforeClose = settled;
  pipeClosure.resolve();
  const result = await reading;
  assert.equal(settledBeforeClose, false, 'a tree receipt alone does not prove closed provider pipes');
  assert.equal(result.status, 'MEASURED');
});

test('discarded stderr still counts against the bounded output budget', async () => {
  const result = await probe(ownedChild({ stderrFlood: true }));
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.reason, 'CLAUDE_USAGE_MALFORMED');
  assert.ok(JSON.stringify(result).length < 512);
});

test('an auth exception waits for the already-started usage probe to finish cleanup', async () => {
  const finishedUsage = deferred();
  const authFailure = new Error('synthetic auth boundary fault');
  const account = { name: 'fixture', provider: 'claude', priority: 1,
    configDir: path.join(path.parse(process.cwd()).root, 'synthetic-claude-home') };
  let usageEntered = false;
  let settled = false;
  const run = claudeProbeFactory({ homeDir: path.parse(process.cwd()).root, exhaustedAtPercent: 99,
    authProbe: async () => { throw authFailure; },
    usageProbe: async () => { usageEntered = true; await finishedUsage.promise;
      return { status: 'UNKNOWN', reason: 'CLAUDE_USAGE_TIMEOUT' }; } });
  const reading = run(account).then(value => ({ value }), error => ({ error })).then(value => {
    settled = true; return value;
  });
  await tick();
  const settledBeforeCleanup = settled;
  finishedUsage.resolve();
  const result = await reading;
  assert.equal(usageEntered, true);
  assert.equal(settledBeforeCleanup, false, 'auth failure must not abandon the in-flight usage child');
  assert.equal(result.error, authFailure, 'draining usage preserves the original auth fault');
});

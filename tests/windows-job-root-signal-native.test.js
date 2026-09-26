'use strict';

// Explicit, fresh scratch is required. All termination goes through retained
// Job handles; this fixture never kills a process selected by PID or name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const isolated = require('./lib/isolated-environment');

assert.equal(process.platform, 'win32', 'native root signaling requires Windows');
assert.ok(process.env.TOOLSENABLED_TEST_ROOT && path.isAbsolute(process.env.TOOLSENABLED_TEST_ROOT),
  'the native suite requires an explicitly selected isolated test root');
const requestedRoot = process.argv[2] || path.join(process.env.TOOLSENABLED_TEST_ROOT, `windows-job-root-signal-${randomUUID()}`);
assert.ok(typeof requestedRoot === 'string' && path.isAbsolute(requestedRoot), 'an explicit absolute scratch root is required');
const scratch = path.resolve(requestedRoot);
assert.ok(process.env.TOOLSENABLED_TEST_ROOT && isolated.within(process.env.TOOLSENABLED_TEST_ROOT, scratch),
  'scratch must remain inside the explicitly selected test root');
let cursor = path.parse(scratch).root;
for (const segment of path.relative(cursor, path.dirname(scratch)).split(path.sep)) {
  cursor = path.join(cursor, segment);
  assert.equal(fs.lstatSync(cursor).isSymbolicLink(), false, 'fixture ancestors must not be links');
}
fs.mkdirSync(scratch);
isolated.configure(path.join(scratch, 'state'), process.env);
const fixtureTemp = path.join(scratch, 'temp');
fs.mkdirSync(fixtureTemp);
process.env.TEMP = fixtureTemp;
process.env.TMP = fixtureTemp;

const jobs = require('../src/lib/windows-job-control');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const outcomes = [];
let active = null;
let unprovedCleanup = false;
const summaryPath = path.join(scratch, 'result.json');

function publicReceipt(receipt) {
  if (!receipt) return null;
  return { type: receipt.type, exitCode: receipt.exitCode, activeProcesses: receipt.activeProcesses };
}

function persist(failure = null) {
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    scope: 'isolated native wrapper regressions; no promotion or prior-attempt cleanup claim',
    finishedAt: new Date().toISOString(), outcomes, unprovedCleanup, failure
  }, null, 2)}\n`, 'utf8');
}

function bounded(promise, label, timeoutMs = 20_000) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(label), { code: 'FIXTURE_DEADLINE' })), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function start(label, command, args, options = {}) {
  const child = jobs.spawnInJob(command, args, {
    cwd: scratch, env: process.env, windowsHide: true, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'], ...options
  }, {
    safeLaunchEnvironment,
    recordDirectory: path.join(scratch, `${label}-records`),
    assemblyCacheDirectory: path.join(scratch, 'assembly-cache'),
    cleanupTimeoutMs: 2_000
  });
  const current = { label, child, identity: null, failure: null, output: '' };
  active = current;
  child.on('error', error => { current.failure = error.code || 'WRAPPER_ERROR'; });
  child.stdout.on('data', bytes => {
    current.output += bytes.toString();
    fs.appendFileSync(path.join(scratch, `${label}.stdout.log`), bytes);
  });
  child.stderr.on('data', bytes => { fs.appendFileSync(path.join(scratch, `${label}.stderr.log`), bytes); });
  current.identity = await bounded(child.jobReady, `${label} ready`);
  return child;
}

async function finish(expectedCode, expectedType = 'exit') {
  const current = active;
  const outcome = await bounded(current.child.jobOutcome, `${current.label} outcome`);
  const closed = await bounded(current.child.jobClosed, `${current.label} close`);
  const row = {
    label: current.label,
    identity: {
      jobId: current.identity.jobId, rootPid: current.identity.rootPid,
      rootStartTicks: current.identity.rootStartTicks, wrapperPid: current.identity.wrapperPid,
      wrapperStartTicks: current.identity.wrapperStartTicks
    },
    outcome: publicReceipt(outcome), wrapperExitCode: closed.code, wrapperClosed: current.child._closed,
    failure: current.failure
  };
  outcomes.push(row);
  active = null;
  assert.equal(outcome.type, expectedType);
  assert.equal(outcome.exitCode, expectedCode);
  assert.equal(outcome.activeProcesses, 0);
  assert.equal(closed.code, expectedCode);
  assert.equal(closed.failure, null);
  assert.equal(row.wrapperClosed, true);
  persist();
  return current.output;
}

async function main() {
  await start('authored-policy', 'powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'fixtures', 'windows-job-root-signal-policy.ps1'),
    '-WrapperPath', jobs.WRAPPER_SCRIPT
  ]);
  const policy = JSON.parse((await finish(0)).trim());
  assert.equal(policy.assertions, 9);

  for (const code of [0, 7, 259, 0, 7, 259]) {
    await start(`natural-${outcomes.length}`, process.execPath, ['-e', `process.exit(${code})`]);
    await finish(code);
  }

  const cancellation = await start('authenticated-cancellation', process.execPath, [
    '-e', 'setTimeout(() => process.exit(70), 15000);'
  ]);
  const cancellationStarted = performance.now();
  const cancelled = await bounded(cancellation.terminateJob(), 'authenticated cancellation', 5_000);
  assert.deepEqual(cancelled.type, 'terminated');
  assert.equal(cancelled.activeProcesses, 0);
  await finish(124, 'terminated');
  assert.ok(performance.now() - cancellationStarted < 5_000, 'the retained control path stays bounded');

  const polling = await start('control-poll-boundaries', process.execPath, [
    '-e', 'setTimeout(() => process.exit(70), 45000);'
  ]);
  const stale = { ...active.identity,
    rootStartTicks: (BigInt(active.identity.rootStartTicks) + 1n).toString() };
  // Exercise real pipe connections on both sides of the 25 ms control poll.
  // Every stale request must receive a refusal, never a dropped connection.
  for (let i = 0; i < 400; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 17 + (i * 7) % 16));
    await assert.rejects(
      jobs.requestTermination(stale, { handshakeTimeoutMs: 1000, cleanupTimeoutMs: 1000 }),
      error => error && error.code === 'WINDOWS_JOB_IDENTITY_MISMATCH',
      `control connection ${i} must survive the idle polling boundary`
    );
  }
  const pollingReceipt = await bounded(polling.terminateJob(), 'cancellation after idle polls', 5000);
  assert.equal(pollingReceipt.activeProcesses, 0);
  await finish(124, 'terminated');

  for (const authority of [false, true]) {
    const readyFile = path.join(scratch, `descendant-${authority}.ready`);
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setTimeout(() => process.exit(0), ${authority ? 15_000 : 500});`;
    const root = [
      `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: true, windowsHide: true, stdio: 'ignore' });`,
      'child.unref();',
      `const poll = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(readyFile)})) { clearInterval(poll); process.exit(7); } }, 10);`,
      'setTimeout(() => process.exit(71), 10000);'
    ].join('\n');
    await start(`descendant-${authority}`, process.execPath, ['-e', root], { terminateDescendantsOnRootExit: authority });
    await finish(7);
  }
  persist();
  process.stdout.write(`${JSON.stringify({ ok: true, fixtureJobs: outcomes.length, policyAssertions: policy.assertions, summaryPath })}\n`);
}

main().catch(async error => {
  if (active) {
    const current = active;
    let receipt = null;
    try {
      if (!current.child._closed) receipt = await bounded(current.child.terminateJob(), 'failure cleanup', 5_000);
      else receipt = await bounded(current.child.jobOutcome, 'closed fixture outcome', 1_000);
      await bounded(current.child.jobClosed, 'failure wrapper close', 5_000);
    } catch { unprovedCleanup = true; }
    if (!receipt || receipt.activeProcesses !== 0 || !['exit', 'terminated'].includes(receipt.type)) unprovedCleanup = true;
    outcomes.push({ label: current.label, cleanupReceipt: publicReceipt(receipt), wrapperClosed: current.child._closed,
      failure: current.failure || error.code || 'FIXTURE_FAILED' });
  }
  persist(error.code || 'FIXTURE_ASSERTION_FAILED');
  process.stderr.write(`${JSON.stringify({ ok: false, unprovedCleanup, summaryPath, code: error.code || 'FIXTURE_ASSERTION_FAILED' })}\n`);
  process.exitCode = 1;
});

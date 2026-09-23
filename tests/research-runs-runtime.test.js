'use strict';

// The research lifecycle wrapper must never let the reused advisory
// runtime's vocabulary reach a person: the live external-kill drill
// (2026-08-15) surfaced 'The recorded overnight advisory worker no longer
// matches its owned process.' through research lifecycle status, and the
// run board can show that sentence on the research page.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ResearchRunsWorkerRuntime } = require('../src/lib/providers/research-runs-runtime');

function mutationSafeRuntime(options = {}) {
  const calls = { launch: 0, terminate: 0 };
  const runtime = new ResearchRunsWorkerRuntime({
    platform: 'win32',
    spawnJob: () => { calls.launch += 1; throw new Error('refusal must precede native launch'); },
    ...options
  });
  return { runtime, calls };
}

function assertNoLifecycleArtifacts(runtimeDir, calls) {
  assert.equal(calls.launch, 0, 'a refusal must not spawn the worker');
  assert.equal(calls.terminate, 0, 'a refusal before launch must not terminate anything');
  assert.equal(fs.existsSync(path.join(runtimeDir, 'worker.json')), false, 'a refusal must not leave a worker record');
  assert.equal(fs.existsSync(path.join(runtimeDir, 'lifecycle.lock')), false, 'a refusal must not leave a lifecycle lock');
}

test('unsupported platforms are recoded and refuse before writing or spawning', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-runtime-platform-'));
  try {
    const { runtime, calls } = mutationSafeRuntime({ runtimeDir: dir, platform: 'darwin' });
    await assert.rejects(
      runtime.start({ actor: 'test', idempotencyKey: 'platform-refusal' }),
      error => error.code === 'RESEARCH_WORKER_PLATFORM_UNSUPPORTED'
        && /research worker requires qualified native process ownership/.test(error.message)
        && !/overnight|advisory/i.test(error.message)
    );
    assertNoLifecycleArtifacts(dir, calls);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing research worker refuses without a record or spawn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-runtime-missing-'));
  const workerFile = path.join(dir, 'definitely-not-installed.js');
  try {
    const { runtime, calls } = mutationSafeRuntime({ runtimeDir: dir, workerFile });
    await assert.rejects(
      runtime.start({ actor: 'test', idempotencyKey: 'missing-worker-refusal' }),
      error => error.code === 'RESEARCH_WORKER_UNAVAILABLE'
        && error.message.includes(`not installed at ${workerFile}`)
        && error.message.includes('no research run was started')
        && !/overnight|advisory/i.test(error.message)
    );
    assertNoLifecycleArtifacts(dir, calls);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an indeterminate worker presence refuses without claiming absence, writing, or spawning', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-runtime-presence-'));
  const workerFile = path.join(dir, 'worker.js');
  fs.writeFileSync(workerFile, "'use strict';\n", 'utf8');
  const originalStatSync = fs.lstatSync;
  try {
    const { runtime, calls } = mutationSafeRuntime({ runtimeDir: dir, workerFile });
    fs.lstatSync = candidate => {
      if (candidate === workerFile) throw Object.assign(new Error('storage unavailable'), { code: 'EIO' });
      return originalStatSync(candidate);
    };
    await assert.rejects(
      runtime.start({ actor: 'test', idempotencyKey: 'presence-refusal' }),
      error => error.code === 'RESEARCH_WORKER_PRESENCE_UNAVAILABLE'
        && error.message.includes('could not be checked')
        && error.message.includes('does not mean the worker is absent or not installed')
        && !/overnight|advisory/i.test(error.message)
    );
    assertNoLifecycleArtifacts(dir, calls);
  } finally {
    fs.lstatSync = originalStatSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy detached worker remains unknown in research vocabulary, not an absent PID claim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-runtime-'));
  // Injected identity, not a live PID: this test once pointed the record at
  // PID 4 (System), whose start time an UNELEVATED shell cannot read --
  // Get-Process .StartTime on it is access-denied, so the identity probe
  // honestly refused and this test failed everywhere the suite runs
  // unelevated. The runtime's own seams make the stale branch deterministic:
  // the pid is alive, its measured ticks differ from the record's.
  fs.writeFileSync(path.join(dir, 'worker.json'), `${JSON.stringify({
    version: 1, pid: 4, instanceId: 'test-instance', startTicks: '639200000000000000', startedAtMs: Date.now()
  })}\n`, 'utf8');
  const runtime = new ResearchRunsWorkerRuntime({
    runtimeDir: dir,
    platform: 'win32',
    processAlive: () => true,
    processStartTicks: () => '639100000000000000'
  });
  try {
    const status = runtime.status();
    assert.equal(status.running, null);
    assert.equal(status.status, 'unknown');
    assert.match(status.detail, /research worker/);
    assert.doesNotMatch(status.detail, /overnight|advisory/i);
    assert.equal(fs.existsSync(path.join(dir, 'worker.json')), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recoded errors translate the message text, not only the code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-runtime-'));
  const runtime = new ResearchRunsWorkerRuntime({ runtimeDir: dir });
  // A stop with no owned worker refuses through the inner runtime's error
  // path; whatever it throws must not name the advisory worker.
  let thrown = null;
  try { await runtime.stop({ actor: 'human', idempotencyKey: 'k-0123456789abcdef' }); }
  catch (error) { thrown = error; }
  if (thrown) {
    assert.doesNotMatch(String(thrown.code || ''), /OVERNIGHT_ADVISORY_/);
    assert.doesNotMatch(String(thrown.message || ''), /overnight|advisory/i);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an invalid inner lifecycle result refuses instead of becoming an absent answer', () => {
  const runtime = new ResearchRunsWorkerRuntime({ supervisor: { snapshot: () => null } });

  assert.throws(
    () => runtime.status(),
    (error) => error.code === 'RESEARCH_WORKER_RESULT_INVALID'
      && /could not be established/.test(error.message)
  );
});

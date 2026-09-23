'use strict';
require('./lib/isolated-environment').activate('linux-research-worker');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createResearchWorkerSupervisor, readResearchQuiescenceObservation } = require('../src/lib/research/worker-supervisor');

assert.equal(process.platform, 'linux', 'native Linux acceptance, not a simulated Windows Job');
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-supervisor-linux-'));
  const supervisor = createResearchWorkerSupervisor({ runtimeDir: path.join(dir, 'runtime'), stateFile: path.join(dir, 'state.sqlite3'),
    workerFile: path.join(__dirname, 'fixtures/research-supervised-worker.js'),
    environment: { ...process.env, TOOLSENABLED_RESEARCH_FIXTURE_ROOT: dir }, graceMs: 2000, cleanupMs: 5000, ...options });
  return { dir, supervisor };
}
async function cleanup({ dir, supervisor }) {
  const observed = await supervisor.quiesceOwned();
  if (observed.status !== 'unknown' || (supervisor.entry?.nativeClosed?.failure === null
      && supervisor.entry?.nativeOutcome?.activeProcesses === 0)) {
    if (supervisor.entry?.recordFd !== undefined) fs.closeSync(supervisor.entry.recordFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('actual Linux worker starts, closes its database and reaps the owned native scope', async () => {
  const f = fixture();
  try {
    assert.equal((await f.supervisor.start()).running, true);
    const observed = await f.supervisor.quiesceOwned();
    assert.equal(observed.status, 'owned-empty', JSON.stringify(observed));
    assert.equal(observed.workerDbClosed, true);
    assert.equal(observed.nativeCleanup, 'EMPTY');
    assert.equal(readResearchQuiescenceObservation(observed, f.supervisor), observed);
    assert.equal(f.supervisor.entry.nativeOutcome.backend, 'linux-subreaper-pidfd-v2');
    assert.equal(f.supervisor.entry.nativeOutcome.activeProcesses, 0);
    assert.equal(f.supervisor.entry.nativeOutcome.observedChildren, f.supervisor.entry.nativeOutcome.reapedChildren);
    assert.equal(fs.existsSync(f.supervisor.recordFile), false);
    assert.equal(fs.readFileSync(path.join(f.dir, 'worker-db-closed'), 'utf8'), 'closed\n');
  } finally { await cleanup(f); }
});

test('sealing before Linux native admission prevents the worker root and retains exact no-start proof', async () => {
  const f = fixture();
  try {
    const started = f.supervisor.start();
    f.supervisor.sealAdmission();
    await assert.rejects(started, { code: 'RESEARCH_WORKER_ADMISSION_SEALED' });
    const observed = await f.supervisor.quiesceOwned();
    assert.equal(observed.status, 'not-started-in-epoch', JSON.stringify(observed));
    assert.equal(f.supervisor.entry.nativeOutcome.type, 'not-started');
    assert.equal(fs.existsSync(path.join(f.dir, 'worker-started')), false);
    assert.equal(fs.existsSync(f.supervisor.recordFile), false);
  } finally { await cleanup(f); }
});

test('Linux public stop allows a new owned worker, while failed DB close stays unknown and sealed', async () => {
  const f = fixture();
  try {
    await f.supervisor.start();
    assert.equal((await f.supervisor.stop()).running, false);
    assert.equal(f.supervisor.sealed, false);
    f.supervisor.environment.TOOLSENABLED_RESEARCH_FIXTURE_CLOSE_FAIL = '1';
    await f.supervisor.start();
    const observed = await f.supervisor.quiesceOwned();
    assert.equal(observed.status, 'unknown');
    assert.equal(observed.workerDbClosed, false);
    assert.equal(observed.nativeCleanup, 'EMPTY');
    assert.equal(observed.reasonCode, 'RESEARCH_WORKER_DB_CLOSE_FAILED');
    assert.equal(fs.existsSync(f.supervisor.recordFile), true);
    await assert.rejects(f.supervisor.start(), { code: 'RESEARCH_WORKER_ADMISSION_SEALED' });
  } finally { await cleanup(f); }
});

test('actual shipped Linux worker opens the isolated V24 store and completes DB/native shutdown', async () => {
  const f = fixture({ workerFile: path.resolve(__dirname, '../tools/research-runs-worker.js') });
  try {
    assert.equal(fs.existsSync(f.supervisor.stateFile), false);
    await f.supervisor.start();
    const observed = await f.supervisor.quiesceOwned();
    assert.equal(observed.status, 'owned-empty', JSON.stringify(observed));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(f.supervisor.stateFile, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
      assert.equal(db.prepare('SELECT count(*) AS total FROM research_runs').get().total, 0);
    } finally { db.close(); }
  } finally { await cleanup(f); }
});

test('an actual nested Linux research runner and detached leaf are reaped before outer DB shutdown succeeds', async () => {
  const f = fixture();
  f.supervisor.environment.TOOLSENABLED_RESEARCH_FIXTURE_NESTED = '1';
  try {
    await f.supervisor.start();
    const ready = path.join(f.dir, 'nested-leaf-ready');
    const deadline = performance.now() + 4000;
    while (!fs.existsSync(ready) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(ready), true, 'the real nested leaf must start');
    const observed = await f.supervisor.quiesceOwned();
    assert.equal(observed.status, 'owned-empty', JSON.stringify(observed));
    const nested = JSON.parse(fs.readFileSync(path.join(f.dir, 'nested-lifecycle.json'), 'utf8'));
    assert.equal(nested.backend, 'linux-subreaper-pidfd-v2');
    assert.equal(nested.cleanupStatus, 'EMPTY');
    assert.equal(nested.receipt.observedChildren >= 2, true);
    assert.equal(nested.receipt.observedChildren, nested.receipt.reapedChildren);
    assert.equal(nested.groupStopRequested, false);
    assert.equal(fs.existsSync(path.join(f.dir, 'nested-leaf-survived')), false);
  } finally { await cleanup(f); }
});

test('a stalled private quiesce write returns unknown after real native cleanup, never a DB-close claim', async () => {
  const f = fixture();
  try {
    await f.supervisor.start();
    const control = f.supervisor.entry.control;
    f.supervisor.entry.control = { close: control.close, send: () => new Promise(() => {}) };
    const observed = await f.supervisor.quiesceOwned({ graceMs: 25, cleanupMs: 5000 });
    assert.equal(observed.status, 'unknown');
    assert.equal(observed.nativeCleanup, 'EMPTY');
    assert.equal(observed.workerDbClosed, false);
    assert.equal(fs.existsSync(f.supervisor.recordFile), true);
  } finally { await cleanup(f); }
});

test('replaced same-byte record is not removed using an old Linux native completion', async () => {
  const f = fixture();
  try {
    await f.supervisor.start();
    const bytes = fs.readFileSync(f.supervisor.recordFile);
    fs.renameSync(f.supervisor.recordFile, path.join(f.dir, 'old-record'));
    fs.writeFileSync(f.supervisor.recordFile, bytes);
    const observed = await f.supervisor.quiesceOwned();
    assert.equal(observed.status, 'unknown');
    assert.equal(observed.nativeCleanup, 'EMPTY');
    assert.equal(observed.reasonCode, 'RESEARCH_WORKER_RECORD_OWNERSHIP_LOST');
    assert.deepEqual(fs.readFileSync(f.supervisor.recordFile), bytes);
  } finally { await cleanup(f); }
});

test('public stop during Linux preparation admits no old worker and allows a subsequent clean start', async () => {
  const f = fixture();
  try {
    const started = f.supervisor.start();
    const stopped = f.supervisor.stop();
    await assert.rejects(started);
    assert.equal((await stopped).running, false);
    assert.equal(fs.existsSync(path.join(f.dir, 'worker-started')), false);
    assert.equal(f.supervisor.sealed, false);
    await f.supervisor.start();
    assert.equal((await f.supervisor.stop()).running, false);
  } finally { await cleanup(f); }
});

test('late native readiness cannot start the Linux worker database after the monotonic deadline', async () => {
  const original = Object.getOwnPropertyDescriptor(performance, 'now');
  let now = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  const { spawnLinuxOwned } = require('../src/lib/linux-process-control');
  const f = fixture({ startupMs: 30000, spawnJob(...args) {
    const child = spawnLinuxOwned(...args);
    child.jobReady = child.jobReady.then(result => { now = 30001; return result; });
    return child;
  } });
  try {
    await assert.rejects(f.supervisor.start(), { code: 'RESEARCH_WORKER_CLEANUP_TIMEOUT' });
    assert.equal(fs.existsSync(path.join(f.dir, 'worker-started')), false);
    assert.equal(fs.existsSync(f.supervisor.stateFile), false);
  } finally {
    if (original) Object.defineProperty(performance, 'now', original);
    else delete performance.now;
    await cleanup(f);
  }
});

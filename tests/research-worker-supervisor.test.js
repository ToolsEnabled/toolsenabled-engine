'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { performance } = require('node:perf_hooks');
const { spawnInJob } = require('../src/lib/windows-job-control');
const { createResearchWorkerSupervisor, getResearchWorkerSupervisor,
  readResearchQuiescenceObservation } = require('../src/lib/research/worker-supervisor');

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-supervisor-'));
  const supervisor = createResearchWorkerSupervisor({
    runtimeDir: path.join(dir, 'runtime'), stateFile: path.join(dir, 'state.sqlite3'),
    workerFile: path.join(__dirname, 'fixtures', 'research-supervised-worker.js'),
    environment: { ...process.env, TOOLSENABLED_RESEARCH_FIXTURE_ROOT: dir },
    graceMs: 2000, cleanupMs: 5000, ...options
  });
  return { dir, supervisor };
}
function remove(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('an unused sealed epoch opens no DB and an actual different facade cannot borrow its observation', async () => {
  const first = fixture(); const second = fixture();
  try {
    const observation = await first.supervisor.quiesceOwned({ requestId: 'first-request' });
    const other = await second.supervisor.quiesceOwned({ requestId: 'second-request' });
    assert.equal(observation.status, 'not-started-in-epoch');
    assert.equal(fs.existsSync(path.join(first.dir, 'state.sqlite3')), false);
    assert.equal(readResearchQuiescenceObservation(observation, first.supervisor), observation);
    assert.equal(readResearchQuiescenceObservation(other, first.supervisor), null);
    assert.equal(readResearchQuiescenceObservation(observation), null);
    assert.equal(readResearchQuiescenceObservation({ ...observation }, first.supervisor), null);
    assert.equal(await first.supervisor.quiesceOwned({ requestId: 'later-request' }), observation);
    await assert.rejects(first.supervisor.start(), { code: 'RESEARCH_WORKER_ADMISSION_SEALED' });
  } finally { remove(first.dir); remove(second.dir); }
});

test('legacy detached and foreign ownership remain unknown without PID probes, spawning, or record deletion', async () => {
  for (const record of [{ version: 1, pid: 424242 }, { version: 2, kind: 'research-worker-job', hostEpoch: 'elsewhere' }]) {
    let spawns = 0;
    const { dir, supervisor } = fixture({ spawnJob() { spawns += 1; throw new Error('must not spawn'); } });
    try {
      fs.mkdirSync(supervisor.runtimeDir);
      const bytes = JSON.stringify(record);
      fs.writeFileSync(supervisor.recordFile, bytes);
      assert.equal(supervisor.snapshot().running, null);
      await assert.rejects(supervisor.start(), { code: record.version === 1 ? 'RESEARCH_WORKER_LEGACY_DETACHED_UNKNOWN' : 'RESEARCH_WORKER_UNOWNED_RUNTIME_UNKNOWN' });
      const observed = await supervisor.quiesceOwned();
      assert.equal(observed.status, 'unknown'); assert.equal(observed.workerDbClosed, false);
      assert.equal(fs.readFileSync(supervisor.recordFile, 'utf8'), bytes); assert.equal(spawns, 0);
    } finally { remove(dir); }
  }
});

test('registry binding is path scoped, lazy, and refuses directory aliases before following them', () => {
  const { dir } = fixture();
  try {
    const options = { stateFile: path.join(dir, 'state.sqlite3'), runtimeDir: path.join(dir, 'runtime') };
    assert.equal(getResearchWorkerSupervisor(options), getResearchWorkerSupervisor(options));
    assert.equal(fs.existsSync(options.stateFile), false);
    fs.mkdirSync(path.join(dir, 'target'));
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => getResearchWorkerSupervisor({ stateFile: path.join(dir, 'alias', 'state.sqlite3'), runtimeDir: options.runtimeDir }),
      { code: 'RESEARCH_WORKER_PATH_ALIAS_UNSUPPORTED' });
  } finally { remove(dir); }
});

test('record allocation refusals seal admission and stay unknown while preserving any partial record and descriptor', async () => {
  for (const stage of ['open', 'write', 'fsync']) {
    let spawns = 0;
    const { dir, supervisor } = fixture({ platform: 'win32', spawnJob() { spawns += 1; throw new Error('must not spawn'); } });
    const originalOpen = fs.openSync, originalWrite = fs.writeFileSync, originalFsync = fs.fsyncSync;
    let allocatedFd;
    const refusal = () => Object.assign(new Error('fixture record allocation refusal'), { code: 'EACCES' });
    try {
      fs.openSync = (file, ...args) => {
        if (file !== supervisor.recordFile) return originalOpen(file, ...args);
        if (stage === 'open') throw refusal();
        allocatedFd = originalOpen(file, ...args);
        return allocatedFd;
      };
      fs.writeFileSync = (file, ...args) => {
        if (allocatedFd !== undefined && file === allocatedFd && stage === 'write') {
          originalWrite(file, '{"partial":');
          throw refusal();
        }
        return originalWrite(file, ...args);
      };
      fs.fsyncSync = descriptor => {
        if (descriptor === allocatedFd && stage === 'fsync') throw refusal();
        return originalFsync(descriptor);
      };
      await assert.rejects(supervisor.start(), { code: 'RESEARCH_WORKER_RECORD_UNAVAILABLE' });
      const snapshot = supervisor.snapshot();
      assert.equal(snapshot.status, 'unknown', `${stage} refusal is not an active startup`);
      assert.equal(snapshot.running, null);
      assert.equal(snapshot.admissionSealed, true);
      assert.equal(snapshot.reasonCode, 'RESEARCH_WORKER_RECORD_UNAVAILABLE');
      assert.equal(supervisor.entry.child, null);
      const observed = await supervisor.quiesceOwned();
      assert.equal(observed.status, 'unknown');
      assert.equal(observed.reasonCode, 'RESEARCH_WORKER_RECORD_UNAVAILABLE');
      assert.equal(observed.nativeCleanup, 'UNKNOWN');
      if (allocatedFd !== undefined) {
        assert.equal(supervisor.entry.recordFd, allocatedFd, 'retain the exact partially allocated record handle');
        assert.ok(fs.fstatSync(allocatedFd).isFile());
        assert.equal(fs.readFileSync(supervisor.recordFile, 'utf8'), stage === 'write' ? '{"partial":' : supervisor.entry.recordBytes);
      } else assert.equal(fs.existsSync(supervisor.recordFile), false);
      await assert.rejects(supervisor.start(), { code: 'RESEARCH_WORKER_ADMISSION_SEALED' });
      assert.equal(spawns, 0, 'no actual worker may be created on any allocation refusal');
    } finally {
      fs.openSync = originalOpen; fs.writeFileSync = originalWrite; fs.fsyncSync = originalFsync;
      // The fixture refused before spawnJob was called. Only this synthetic
      // record belongs to the test; production preserves its unresolved file.
      if (allocatedFd !== undefined) fs.closeSync(allocatedFd);
      remove(dir);
    }
  }
});

test('real native worker: start, drain, DB close ACK, original Job EMPTY and wrapper close all precede the scoped result',
  { skip: process.platform !== 'win32' }, async () => {
    const { dir, supervisor } = fixture();
    try {
      assert.equal(fs.existsSync(path.join(dir, 'state.sqlite3')), false);
      const started = await supervisor.start();
      assert.equal(started.running, true);
      assert.equal(fs.readFileSync(path.join(dir, 'worker-started'), 'utf8'), 'started\n');
      const observed = await supervisor.quiesceOwned({ requestId: 'native-worker' });
      assert.equal(observed.status, 'owned-empty', JSON.stringify(observed));
      assert.equal(observed.nativeCleanup, 'EMPTY'); assert.equal(observed.workerDbClosed, true);
      assert.equal(fs.readFileSync(path.join(dir, 'worker-db-closed'), 'utf8'), 'closed\n');
      assert.equal(supervisor.entry.nativeOutcome.activeProcesses, 0);
      assert.equal(supervisor.entry.nativeClosed.failure, null);
      assert.equal(fs.existsSync(supervisor.recordFile), false);
      assert.equal(readResearchQuiescenceObservation(observed, supervisor), observed);
    } finally {
      const closed = await supervisor.quiesceOwned();
      if (closed.status !== 'unknown') remove(dir);
    }
  });

test('seal during native startup refuses the actual root before creation and preserves no-start evidence',
  { skip: process.platform !== 'win32' }, async () => {
    const { dir, supervisor } = fixture();
    try {
      const started = supervisor.start();
      supervisor.sealAdmission();
      await assert.rejects(started);
      const observed = await supervisor.quiesceOwned();
      assert.equal(observed.status, 'not-started-in-epoch', JSON.stringify(observed));
      assert.equal(supervisor.entry.nativeOutcome.type, 'not-started');
      assert.equal(fs.existsSync(path.join(dir, 'worker-started')), false);
      assert.equal(fs.existsSync(path.join(dir, 'state.sqlite3')), false);
      assert.equal(fs.existsSync(supervisor.recordFile), false);
    } finally {
      const closed = await supervisor.quiesceOwned();
      if (closed.status !== 'unknown') remove(dir);
    }
  });

test('public stop before readiness seals only the original entry; no late start and a subsequent clean start is allowed',
  { skip: process.platform !== 'win32' }, async () => {
    const { dir, supervisor } = fixture();
    try {
      const firstStart = supervisor.start();
      const stopped = supervisor.stop();
      await assert.rejects(firstStart);
      assert.equal((await stopped).running, false);
      assert.equal(fs.existsSync(path.join(dir, 'worker-started')), false, 'the original root was never created');
      assert.equal(supervisor.sealed, false, 'public stop is not the permanent app shutdown fence');
      assert.equal((await supervisor.start()).running, true);
      assert.equal((await supervisor.stop()).running, false);
      const observed = await supervisor.quiesceOwned();
      assert.equal(observed.status, 'owned-empty', JSON.stringify(observed));
      assert.equal(observed.nativeCleanup, 'EMPTY');
      assert.equal(fs.existsSync(supervisor.recordFile), false);
    } finally {
      const closed = await supervisor.quiesceOwned();
      if (closed.status !== 'unknown') remove(dir);
    }
  });

test('an observed identical-byte pathname replacement cannot be removed as the original owned record',
  { skip: process.platform !== 'win32' }, async () => {
    const { dir, supervisor } = fixture();
    const originalRead = fs.readFileSync;
    let replacement = false;
    try {
      await supervisor.start();
      const bytes = originalRead(supervisor.recordFile, 'utf8');
      // Replace during the final byte recheck, after the first identity check.
      fs.readFileSync = (file, ...args) => {
        const result = originalRead(file, ...args);
        if (file === supervisor.recordFile && !replacement && supervisor.entry.stopping) {
          replacement = true;
          fs.renameSync(file, path.join(dir, 'original-worker-record'));
          fs.writeFileSync(file, bytes);
        }
        return result;
      };
      const observed = await supervisor.quiesceOwned();
      assert.equal(replacement, true);
      assert.equal(observed.status, 'unknown');
      assert.equal(observed.reasonCode, 'RESEARCH_WORKER_RECORD_OWNERSHIP_LOST');
      assert.equal(observed.nativeCleanup, 'EMPTY', 'actual native cleanup is retained separately');
      assert.equal(originalRead(supervisor.recordFile, 'utf8'), bytes, 'replacement is left untouched');
    } finally {
      fs.readFileSync = originalRead;
      await supervisor.quiesceOwned();
      if (supervisor.entry.nativeClosed && supervisor.entry.nativeOutcome?.activeProcesses === 0) {
        if (supervisor.entry.recordFd !== undefined) fs.closeSync(supervisor.entry.recordFd);
        remove(dir);
      }
    }
  });

test('a DB-close refusal stays unknown even when the original native Job is EMPTY',
  { skip: process.platform !== 'win32' }, async () => {
    const { dir, supervisor } = fixture();
    supervisor.environment.TOOLSENABLED_RESEARCH_FIXTURE_CLOSE_FAIL = '1';
    try {
      await supervisor.start();
      const observed = await supervisor.quiesceOwned();
      assert.equal(observed.status, 'unknown'); assert.equal(observed.workerDbClosed, false);
      assert.equal(observed.nativeCleanup, 'EMPTY');
      assert.equal(observed.reasonCode, 'RESEARCH_WORKER_DB_CLOSE_FAILED');
      assert.equal(fs.existsSync(supervisor.recordFile), true);
      await assert.rejects(supervisor.start(), { code: 'RESEARCH_WORKER_ADMISSION_SEALED' });
    } finally {
      await supervisor.quiesceOwned();
      if (supervisor.entry.nativeClosed && supervisor.entry.nativeOutcome?.activeProcesses === 0) {
        if (supervisor.entry.recordFd !== undefined) fs.closeSync(supervisor.entry.recordFd);
        remove(dir);
      }
    }
  });

test('an outer research worker Job contains the actual nested runner and its detached leaf through shutdown',
  { skip: process.platform !== 'win32' }, async () => {
    const { dir, supervisor } = fixture();
    supervisor.environment.TOOLSENABLED_RESEARCH_FIXTURE_NESTED = '1';
    try {
      await supervisor.start();
      const ready = path.join(dir, 'nested-leaf-ready');
      const deadline = performance.now() + 5000;
      while (!fs.existsSync(ready) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(fs.existsSync(ready), true, 'the actual nested runner and detached leaf must have started');
      const observed = await supervisor.quiesceOwned();
      assert.equal(observed.status, 'owned-empty', JSON.stringify(observed));
      assert.equal(observed.nativeCleanup, 'EMPTY');
      const inner = JSON.parse(fs.readFileSync(path.join(dir, 'nested-lifecycle.json'), 'utf8'));
      assert.equal(inner.cleanupStatus, 'EMPTY'); assert.equal(inner.wrapperClosed, true);
      assert.equal(inner.acceptanceReady, false, 'cancellation is cleanup, not research success');
      await new Promise(resolve => setTimeout(resolve, 2100));
      assert.equal(fs.existsSync(path.join(dir, 'nested-leaf-survived')), false, 'no detached leaf survives to write its delayed marker');
    } finally {
      const observed = await supervisor.quiesceOwned();
      if (observed.status !== 'unknown') remove(dir);
    }
  });

test('a stalled private control write reaches bounded native cleanup and cannot fabricate a DB-close ACK',
  { skip: process.platform !== 'win32' }, async () => {
    const { dir, supervisor } = fixture();
    try {
      await supervisor.start();
      const originalControl = supervisor.entry.control;
      supervisor.entry.control = { close: originalControl.close, send: () => new Promise(() => {}) };
      const began = performance.now();
      const observed = await supervisor.quiesceOwned({ graceMs: 25, cleanupMs: 5000 });
      assert.ok(performance.now() - began < 5500, 'a stuck write must not strand the cleanup deadline');
      assert.equal(observed.status, 'unknown'); assert.equal(observed.workerDbClosed, false);
      assert.equal(observed.nativeCleanup, 'EMPTY');
      assert.equal(fs.existsSync(supervisor.recordFile), true);
    } finally {
      await supervisor.quiesceOwned();
      if (supervisor.entry.nativeClosed && supervisor.entry.nativeOutcome?.activeProcesses === 0) {
        if (supervisor.entry.recordFd !== undefined) fs.closeSync(supervisor.entry.recordFd);
        remove(dir);
      }
    }
  });

test('the actual shipped worker entrypoint starts and drains against a fresh isolated V24 store',
  { skip: process.platform !== 'win32' }, async () => {
    const { dir, supervisor } = fixture({ workerFile: path.resolve(__dirname, '..', 'tools', 'research-runs-worker.js') });
    try {
      assert.equal(fs.existsSync(supervisor.stateFile), false);
      await supervisor.start();
      assert.equal(fs.existsSync(supervisor.stateFile), true);
      const observed = await supervisor.quiesceOwned();
      assert.equal(observed.status, 'owned-empty', JSON.stringify(observed));
      assert.equal(observed.workerDbClosed, true); assert.equal(observed.nativeCleanup, 'EMPTY');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(supervisor.stateFile, { readOnly: true });
      try {
        assert.equal(database.prepare('PRAGMA user_version').get().user_version, 24);
        assert.equal(database.prepare('SELECT count(*) AS total FROM research_runs').get().total, 0);
      } finally { database.close(); }
    } finally {
      const observed = await supervisor.quiesceOwned();
      if (observed.status !== 'unknown') remove(dir);
    }
  });

test('late readiness cannot authorize private start merely by winning the event-loop race against the timeout callback',
  { skip: process.platform !== 'win32' }, async () => {
    const originalClock = Object.getOwnPropertyDescriptor(performance, 'now');
    let observedNow = 0;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => observedNow });
    const { dir, supervisor } = fixture({ startupMs: 30000,
      spawnJob(...args) {
        const child = spawnInJob(...args);
        child.jobReady = child.jobReady.then(value => { observedNow = 30001; return value; });
        return child;
      }
    });
    try {
      await assert.rejects(supervisor.start(), { code: 'RESEARCH_WORKER_CLEANUP_TIMEOUT' });
      assert.equal(observedNow, 30001, 'the actual native readiness callback must run before the ordinary real-time timeout');
      assert.equal(fs.existsSync(path.join(dir, 'worker-started')), false, 'late readiness must not construct the worker or open its DB');
      assert.equal(fs.existsSync(supervisor.stateFile), false);
    } finally {
      const observed = await supervisor.quiesceOwned();
      if (originalClock) Object.defineProperty(performance, 'now', originalClock);
      else delete performance.now;
      if (observed.status !== 'unknown') remove(dir);
    }
  });

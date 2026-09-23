'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileControlStore } = require('../src/m1/control-store');

function withTemporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-vcs-m1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function storeAt(root, options = {}) {
  return createFileControlStore({
    root,
    projectionReducers: {
      counts: {
        initialState: () => ({}),
        reduce: (state, event) => ({
          ...state,
          [event.eventType]: (state[event.eventType] || 0) + 1,
        }),
      },
    },
    ...options,
  });
}

function runWorker(worker, args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [worker, ...args], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString('utf8')));
      resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
    });
  });
}

test('append-only events support CAS, historical snapshots, and full projection rebuild', (t) => {
  const root = withTemporaryRoot(t);
  const store = storeAt(root);
  const empty = store.readSnapshot();
  const first = store.compareAndSwap({
    expectedSnapshotId: empty.snapshotId,
    event: { type: 'revision.proposed', payload: { revisionId: 'r1' } },
    dedupeKey: 'proposal-r1',
    occurredAt: '2026-08-06T10:00:00.000Z',
  });
  const second = store.compareAndSwap({
    expectedSnapshotId: first.authoritySnapshotId,
    event: { type: 'revision.proposed', payload: { revisionId: 'r2' } },
    dedupeKey: 'proposal-r2',
    occurredAt: '2026-08-06T10:00:01.000Z',
  });
  assert.equal(store.readSnapshot({ snapshotId: first.authoritySnapshotId }).events.length, 1);
  assert.equal(store.readSnapshot({ snapshotId: second.authoritySnapshotId }).events.length, 2);
  const projection = store.rebuildProjection({ projectionId: 'counts' });
  assert.deepEqual(projection.state, { 'revision.proposed': 2 });
  assert.equal(projection.sourceEventCount, 2);
  assert.equal(projection.freshness, 'FRESH');
  assert.equal(store.verifyIntegrity().state, 'SAFE');
});

test('concurrent compare-and-swap grants exactly one writer', async (t) => {
  const root = withTemporaryRoot(t);
  const expectedSnapshotId = storeAt(root).readSnapshot().snapshotId;
  const worker = path.join(__dirname, 'helpers', 'cas-worker.js');
  const outcomes = await Promise.all([
    runWorker(worker, [root, expectedSnapshotId, 'worker-left']),
    runWorker(worker, [root, expectedSnapshotId, 'worker-right']),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.ok).length, 1);
  assert.deepEqual(outcomes.filter(outcome => !outcome.ok).map(outcome => outcome.code), ['VCS_TXN_PRECONDITION']);
  assert.equal(storeAt(root).readSnapshot().events.length, 1);
});

test('crash before publish leaves an ignored orphan and replay starts from committed state', (t) => {
  const root = withTemporaryRoot(t);
  const crashing = storeAt(root, {
    faultInjector(phase) {
      if (phase === 'beforePublish') throw new Error('simulated crash before publish');
    },
  });
  assert.throws(() => crashing.appendEvent({
    eventType: 'fixture.event',
    payload: { value: 1 },
    dedupeKey: 'crash-before',
    occurredAt: '2026-08-06T10:00:00.000Z',
  }), /simulated crash/);
  const reopened = storeAt(root);
  assert.equal(reopened.readSnapshot().events.length, 0);
  assert.equal(reopened.verifyIntegrity().orphanTemporaryFiles, 1);
  assert.equal(reopened.appendEvent({
    eventType: 'fixture.event',
    payload: { value: 1 },
    dedupeKey: 'crash-before',
    occurredAt: '2026-08-06T10:00:00.000Z',
  }).sequence, 1);
});

test('crash after publish is idempotent when the caller retries its dedupe key', (t) => {
  const root = withTemporaryRoot(t);
  const crashing = storeAt(root, {
    faultInjector(phase) {
      if (phase === 'afterPublish') throw new Error('simulated crash after publish');
    },
  });
  assert.throws(() => crashing.appendEvent({
    eventType: 'fixture.event',
    payload: { value: 2 },
    dedupeKey: 'crash-after',
    occurredAt: '2026-08-06T10:00:00.000Z',
  }), /simulated crash/);
  const reopened = storeAt(root);
  const existing = reopened.readSnapshot().events[0];
  const receipt = reopened.appendEvent({
    eventType: 'fixture.event',
    payload: { value: 2 },
    dedupeKey: 'crash-after',
    occurredAt: '2026-08-06T11:00:00.000Z',
  });
  assert.equal(receipt.eventId, existing.eventId);
  assert.equal(reopened.readSnapshot().events.length, 1);
});

test('hard process crash preserves the stale lock and replays committed state', (t) => {
  const root = withTemporaryRoot(t);
  const worker = path.join(__dirname, 'helpers', 'crash-worker.js');
  const crashed = childProcess.spawnSync(process.execPath, [worker, root, 'afterPublish', 'hard-crash'], {
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(crashed.status, 91);
  assert.ok(fs.existsSync(path.join(root, 'append.lock')));
  const reopened = storeAt(root, { staleLockMs: 0 });
  const receipt = reopened.appendEvent({
    eventType: 'worker.crash-fixture',
    payload: { crashPhase: 'afterPublish' },
    dedupeKey: 'hard-crash',
    occurredAt: '2026-08-06T12:01:00.000Z',
  });
  assert.equal(receipt.sequence, 1);
  assert.equal(reopened.readSnapshot().events.length, 1);
  assert.equal(fs.readdirSync(path.join(root, 'stale-locks')).length, 1);
});

test('event corruption breaks replay instead of becoming an empty or clean result', (t) => {
  const root = withTemporaryRoot(t);
  const store = storeAt(root);
  store.appendEvent({
    eventType: 'fixture.event',
    payload: { value: 'original' },
    dedupeKey: 'corrupt-me',
    occurredAt: '2026-08-06T10:00:00.000Z',
  });
  const eventFile = path.join(root, 'events', fs.readdirSync(path.join(root, 'events'))[0]);
  const parsed = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  parsed.payload.value = 'tampered';
  fs.writeFileSync(eventFile, JSON.stringify(parsed));
  assert.throws(() => store.verifyIntegrity(), { code: 'VCS_INTEGRITY_FAILURE' });
  assert.throws(() => store.rebuildProjection({ projectionId: 'counts' }), { code: 'VCS_INTEGRITY_FAILURE' });
});

test('unclassified material in the event-log directory fails closed', (t) => {
  const root = withTemporaryRoot(t);
  const store = storeAt(root);
  fs.writeFileSync(path.join(root, 'events', 'unclassified.bin'), 'not an event');
  assert.throws(() => store.verifyIntegrity(), { code: 'VCS_INTEGRITY_FAILURE' });
});

test('measured append-only file store remains fully replayable', (t) => {
  const root = withTemporaryRoot(t);
  const store = storeAt(root);
  const eventCount = 200;
  const appendStart = process.hrtime.bigint();
  for (let index = 0; index < eventCount; index += 1) {
    store.appendEvent({
      eventType: 'measurement.event',
      payload: { index, content: 'x'.repeat(64) },
      dedupeKey: `measurement-${index}`,
      occurredAt: '2026-08-06T10:00:00.000Z',
    });
  }
  const appendMs = Number(process.hrtime.bigint() - appendStart) / 1_000_000;
  const replayStart = process.hrtime.bigint();
  const integrity = storeAt(root).verifyIntegrity();
  const replayMs = Number(process.hrtime.bigint() - replayStart) / 1_000_000;
  assert.equal(integrity.eventCount, eventCount);
  assert.equal(storeAt(root).rebuildProjection({ projectionId: 'counts' }).state['measurement.event'], eventCount);
  process.stdout.write(`M1_STORAGE_MEASUREMENT events=${eventCount} bytes=${integrity.bytes} bytesPerEvent=${(integrity.bytes / eventCount).toFixed(2)} appendMs=${appendMs.toFixed(2)} replayMs=${replayMs.toFixed(2)}\n`);
});

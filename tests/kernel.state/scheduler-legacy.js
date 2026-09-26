'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../../src/lib/state-store');

const roots = [];
const stores = [];
const runtime = Object.freeze({
  nodePath: process.execPath,
  runnerPath: path.resolve(__dirname, '..', '..', 'src', 'job-runner.js'),
  principalId: 'S-1-5-21-111111111-222222222-333333333-1003'
});

function fixture(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-scheduler-legacy-${label}-`));
  roots.push(dir);
  const file = path.join(dir, 'state.sqlite3');
  const legacy = path.join(dir, 'jobs.json');
  const store = createStateStore({ file, busyTimeoutMs: 10000 });
  stores.push(store);
  return { dir, file, legacy, store };
}
function write(file, value) {
  const raw = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, raw, 'utf8');
  return raw;
}
function valid(jobs) { return { version: 1, jobs }; }
// FIXTURE ACTION CHANGED 2026-08-23: 'telegram.send' left SUPPORTED_SCHEDULED_ACTIONS
// with the Telegram connector. 'gmail.send' is a surviving external-write action with
// the same shape of use, so the scheduler machinery under test is exercised exactly as
// before against an action the allowlist actually contains.
function telegram(name, extra = {}) {
  return { name, schedule: 'hourly', action: 'gmail.send', args: { to: 'owner@example.invalid', subject: name }, enabled: true, ...extra };
}
function expectCode(fn, code) {
  assert.throws(fn, error => error && error.code === code, `Expected ${code}.`);
}

try {
  // The environment override is honored, valid aliases normalize, disabled
  // definitions are recorded but not scheduled, and exact source bytes move to
  // a digest-named archive only after the database transaction commits.
  {
    const test = fixture('happy');
    const original = write(test.legacy, valid([
      telegram('hourly-owner'),
      {
        name: 'daily-instagram', schedule: 'daily', action: 'instagram.publishImage',
        args: { imageUrl: 'https://example.test/image.jpg', caption: 'safe' }, enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z', lastRunAt: '2026-02-01T00:00:00.000Z',
        lastResult: { success: true, completedAt: '2026-02-01T00:00:00.000Z' }
      },
      telegram('disabled', { enabled: false })
    ]));
    const priorPath = process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH;
    process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH = test.legacy;
    let imported;
    try { imported = test.store.importLegacyScheduler({ runtime, maxScheduledJobs: 10 }); }
    finally {
      if (priorPath === undefined) delete process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH;
      else process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH = priorPath;
    }
    assert.equal(imported.status, 'imported');
    assert.deepEqual(imported.details, { validated: 3, created: 2, replayed: 0, disabled: 1 });
    assert.deepEqual(imported.legacyTasks, [
      { name: 'hourly-owner', schedule: 'hourly', createdAtMs: null },
      { name: 'daily-instagram', schedule: 'daily', createdAtMs: Date.parse('2026-01-01T00:00:00.000Z') },
      { name: 'disabled', schedule: 'hourly', createdAtMs: null }
    ]);
    assert.equal(fs.existsSync(test.legacy), false);
    assert.equal(fs.readFileSync(imported.archivePath, 'utf8'), original);
    assert.match(path.basename(imported.archivePath), /^jobs\.json\.legacy-[a-f0-9]{16}$/);
    const jobs = test.store.listSchedulerJobs();
    assert.deepEqual(jobs.map(job => job.name), ['daily-instagram', 'hourly-owner']);
    const instagram = jobs.find(job => job.name === 'daily-instagram');
    assert.equal(instagram.action, 'instagram.publish_image');
    assert.equal(instagram.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(instagram.lastRunAt, '2026-02-01T00:00:00.000Z');
    assert.deepEqual(instagram.lastResult, { success: true, completedAt: '2026-02-01T00:00:00.000Z' });
    assert.equal(test.store.listSchedulerOutbox({ statuses: ['pending'] }).length, 2);
    const replay = test.store.importLegacyScheduler({ path: test.legacy, runtime, maxScheduledJobs: 10 });
    assert.equal(replay.status, 'already_imported');
    assert.equal(replay.archivePath, imported.archivePath);
    assert.deepEqual(replay.legacyTasks, imported.legacyTasks);
  }

  // Crash after durable commit but before rename is recoverable and does not
  // create a new generation or duplicate an outbox entry.
  {
    const test = fixture('crash');
    const original = write(test.legacy, valid([telegram('recoverable')]));
    const archive = test.store._archiveLegacyScheduler;
    let injected = true;
    test.store._archiveLegacyScheduler = function failOnce(...args) {
      if (injected) { injected = false; throw new Error('injected crash after commit'); }
      return archive.apply(this, args);
    };
    assert.throws(() => test.store.importLegacyScheduler({ path: test.legacy, runtime }), /injected crash/);
    assert.equal(fs.readFileSync(test.legacy, 'utf8'), original);
    assert.equal(test.store.getSchedulerJob({ name: 'recoverable' }).generation, 1);
    const recovered = test.store.importLegacyScheduler({ path: test.legacy, runtime });
    assert.equal(recovered.status, 'already_imported');
    assert.equal(fs.existsSync(test.legacy), false);
    assert.equal(fs.readFileSync(recovered.archivePath, 'utf8'), original);
    assert.equal(test.store.getSchedulerJob({ name: 'recoverable' }).generation, 1);
    assert.equal(test.store.listSchedulerOutbox({ jobId: test.store.getSchedulerJob({ name: 'recoverable' }).jobId }).length, 1);
  }

  // A recreated source with a different digest fails closed after import.
  {
    const test = fixture('changed');
    write(test.legacy, valid([telegram('stable')]));
    test.store.importLegacyScheduler({ path: test.legacy, runtime });
    write(test.legacy, valid([telegram('changed')]));
    expectCode(() => test.store.importLegacyScheduler({ path: test.legacy, runtime }), 'SCHEDULER_LEGACY_CHANGED');
    assert.equal(test.store.getSchedulerJob({ name: 'stable' }).generation, 1);
  }

  // Old checkouts could restore the repository's shipped empty jobs.json after
  // a real source was archived. That inert tombstone is ignored while the
  // exact archive remains mandatory; nonempty replacements still fail closed.
  {
    const test = fixture('restored-stock-tombstone');
    write(test.legacy, valid([telegram('preserved')]));
    const imported = test.store.importLegacyScheduler({ path: test.legacy, runtime });
    write(test.legacy, valid([]));
    const restarted = test.store.importLegacyScheduler({ path: test.legacy, runtime });
    assert.equal(restarted.status, 'already_imported');
    assert.equal(restarted.restoredTombstoneIgnored, true);
    assert.equal(restarted.archivePath, imported.archivePath);
    assert.deepEqual(restarted.legacyTasks, imported.legacyTasks);
    assert.equal(test.store.getSchedulerJob({ name: 'preserved' }).generation, 1);
    fs.unlinkSync(imported.archivePath);
    expectCode(() => test.store.importLegacyScheduler({ path: test.legacy, runtime }), 'SCHEDULER_LEGACY_ARCHIVE_MISSING');
  }

  // Existing durable state is never silently overwritten by legacy input.
  {
    const test = fixture('conflict');
    test.store.putSchedulerJob({ ...telegram('collision'), runtime, maxScheduledJobs: 10 });
    write(test.legacy, valid([telegram('collision', { args: { to: 'owner@example.invalid', subject: 'different' } })]));
    expectCode(() => test.store.importLegacyScheduler({ path: test.legacy, runtime, maxScheduledJobs: 10 }), 'SCHEDULER_LEGACY_CONFLICT');
    assert.equal(fs.existsSync(test.legacy), true);
    assert.equal(test.store.transaction(db => db.prepare('SELECT COUNT(*) AS count FROM scheduler_legacy_import').get().count), 0);
    assert.equal(test.store.getSchedulerJob({ name: 'collision' }).generation, 1);
  }

  // Whole-file and action-argument validation is atomic: no bad fixture leaves
  // behind a job or an import marker.
  const invalid = [
    ['top-field', { version: 1, jobs: [], extra: true }, 'SCHEDULER_LEGACY_INVALID'],
    ['duplicate', valid([telegram('same'), telegram('same')]), 'SCHEDULER_LEGACY_INVALID'],
    ['job-field', valid([{ ...telegram('unknown-field'), surprise: true }]), 'SCHEDULER_LEGACY_INVALID'],
    ['enabled', valid([telegram('enabled-type', { enabled: 'yes' })]), 'SCHEDULER_LEGACY_INVALID'],
    ['minutes', valid([telegram('minutes', { schedule: 'minutes' })]), 'SCHEDULER_LEGACY_INVALID'],
    ['action', valid([telegram('bad-action', { action: 'not.real' })]), 'SCHEDULER_ACTION_UNSUPPORTED'],
    ['args-field', valid([telegram('bad-args', { args: { to: 'owner@example.invalid', subject: 'x', token: 'forbidden' } })]), 'SCHEDULER_SECRET_REJECTED'],
    ['args-required', valid([telegram('missing-subject', { args: { to: 'owner@example.invalid' } })]), 'SCHEDULER_LEGACY_INVALID'],
    ['secret-value', valid([telegram('secret', { args: { to: 'owner@example.invalid', subject: 'Bearer abcdefghijklmnopqrstuvwxyz1234' } })]), 'SCHEDULER_SECRET_REJECTED']
  ];
  for (const [label, value, code] of invalid) {
    const test = fixture(label);
    write(test.legacy, value);
    expectCode(() => test.store.importLegacyScheduler({ path: test.legacy, runtime }), code);
    assert.equal(test.store.listSchedulerJobs().length, 0, label);
    assert.equal(test.store.transaction(db => db.prepare('SELECT COUNT(*) AS count FROM scheduler_legacy_import').get().count), 0, label);
    assert.equal(fs.existsSync(test.legacy), true, label);
  }

  process.stdout.write('scheduler-legacy tests passed\n');
} finally {
  for (const store of stores) {
    try { store.close(); } catch { /* preserve failure */ }
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}

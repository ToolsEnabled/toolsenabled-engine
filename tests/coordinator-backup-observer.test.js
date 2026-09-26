'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const observer = require('../src/lib/coordinator/backup-observer.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const ROOT = path.join(os.tmpdir(), 'backup-root');
function fakeFs(entries, mtimes = {}) {
  return {
    opendirSync: candidate => {
      assert.equal(candidate, ROOT);
      let index = 0;
      return {
        readSync: () => index < entries.length ? entries[index++] : null,
        closeSync: () => {}
      };
    },
    lstatSync: candidate => ({
      mtimeMs: mtimes[candidate],
      isDirectory: () => true,
      isSymbolicLink: () => false
    })
  };
}
function directory(name) { return { name, isDirectory: () => true }; }
function file(name) { return { name, isDirectory: () => false }; }

function run() {
  process.stdout.write('coordinator-backup-observer\n');

  check('uses only the latest recognized direct snapshot-directory metadata', () => {
    const root = ROOT;
    const result = observer.observeBackupDestination(root, {
      nowMs: NOW,
      fsImpl: fakeFs(
        [directory('snapshot-20260728T000000Z'), file('snapshot-20260729T110000Z'), directory('notes'), directory('snapshot-20260729T110000Z')],
        {
          [path.join(root, 'snapshot-20260728T000000Z')]: Date.parse('2026-07-28T10:00:00.000Z'),
          [path.join(root, 'snapshot-20260729T110000Z')]: Date.parse('2026-07-29T11:00:00.000Z')
        })
    });
    assert.deepEqual(result, {
      schemaVersion: 1,
      kind: 'backup-age-observation',
      reportMode: 'report-only',
      observedAt: '2026-07-29T12:00:00.000Z',
      lastBackupAt: '2026-07-29T11:00:00.000Z'
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(JSON.stringify(result).includes('backup-root'), false);
  });

  check('fails closed for empty, inaccessible, future, malformed, or non-snapshot metadata', () => {
    const root = ROOT;
    const unavailable = value => {
      assert.equal(value.lastBackupAt, null);
      assert.equal(value.observedAt, '2026-07-29T12:00:00.000Z');
    };
    unavailable(observer.observeBackupDestination(root, { nowMs: NOW, fsImpl: fakeFs([], {}) }));
    unavailable(observer.observeBackupDestination(root, { nowMs: NOW, fsImpl: fakeFs([directory('snapshot-20260729T110000Z')], {
      [path.join(root, 'snapshot-20260729T110000Z')]: NOW + 1
    }) }));
    unavailable(observer.observeBackupDestination(root, { nowMs: NOW, fsImpl: fakeFs([directory('snapshot-invalid')], {}) }));
    unavailable(observer.observeBackupDestination(root, { nowMs: NOW, fsImpl: fakeFs([directory('snapshot-20260230T110000Z')], {}) }));
    unavailable(observer.observeBackupDestination(root, {
      nowMs: NOW,
      fsImpl: { opendirSync: () => { throw new Error('denied'); }, statSync: () => { throw new Error('must not run'); } }
    }));
  });

  check('distinguishes transient filesystem failures from absence without latching them', () => {
    // EACCES/EPERM are in this list, not the ENOENT list below: a locked or
    // permission-restricted destination is a could-not-look, the same as a
    // machine that is momentarily out of file handles -- never a not-there.
    for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT', 'EACCES', 'EPERM']) {
      const error = Object.assign(new Error('machine could not answer'), { code });
      const result = observer.observeBackupDestination(ROOT, {
        nowMs: NOW,
        fsImpl: { lstatSync() { throw error; }, opendirSync() { throw new Error('must not run'); } }
      });
      assert.equal(result.code, 'BACKUP_OBSERVATION_INDETERMINATE');
      assert.match(result.message, /does NOT claim.*absent/);
      assert.equal(result.lastBackupAt, undefined);
    }

    const absentError = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const absent = observer.observeBackupDestination(ROOT, {
      nowMs: NOW,
      fsImpl: { lstatSync() { throw absentError; }, opendirSync() { throw new Error('must not run'); } }
    });
    assert.deepEqual(absent, observer.unavailableObservation('2026-07-29T12:00:00.000Z'));

    // Control: a failed call is not cached or latched; the next call performs
    // the metadata reads and returns the ordinary successful observation.
    let lstatCalls = 0;
    const healthy = fakeFs([directory('snapshot-20260729T110000Z')], {
      [path.join(ROOT, 'snapshot-20260729T110000Z')]: NOW - 1
    });
    const originalLstat = healthy.lstatSync;
    healthy.lstatSync = candidate => { lstatCalls += 1; return originalLstat(candidate); };
    const recovered = observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: healthy });
    assert.equal(recovered.lastBackupAt, '2026-07-29T11:00:00.000Z');
    assert.equal(lstatCalls, 2);
  });

  check('does not evaluate hostile entry getters or treat them as evidence', () => {
    let accessed = 0;
    const hostile = {};
    Object.defineProperty(hostile, 'name', { enumerable: true, get() { accessed += 1; throw new Error('no'); } });
    const result = observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: fakeFs([hostile], {}) });
    assert.equal(result.lastBackupAt, null);
    assert.equal(accessed, 1, 'the getter is caught and contributes no evidence');
  });

  check('the observer source contains no content-read, write, process, vault, or scheduler primitive', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coordinator', 'backup-observer.js'), 'utf8');
    for (const forbidden of [/readdirSync/, /readFile/, /writeFile/, /copyFile/, /rename/, /unlink/, /rmSync/, /exec(?:File)?Sync/, /spawn(?:Sync)?/, /secrets\.ps1/, /schedule/i]) {
      assert.equal(forbidden.test(source), false, `observer source contains forbidden primitive ${forbidden}`);
    }
    assert.equal(source.includes('opendirSync'), true, 'observer must stream directory entries through a bounded handle');
  });

  process.stdout.write(`\ncoordinator-backup-observer: ${passed} checks passed\n`);
}

try {
  run();
} catch (error) {
  process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`);
  process.exitCode = 1;
}

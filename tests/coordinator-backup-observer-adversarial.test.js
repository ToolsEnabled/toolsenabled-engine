// EXECUTABLE CHANGE
// Report: testcanfail-tests-coordinator-backup-observer-adversarial-test-js
//
// Strengthened assertion: fakeFs.statSync used to throw an assertion that the
// observer caught, allowing an attempted followed-target metadata read to pass
// unnoticed. check() now verifies that the stat-read counter did not change.
// Mutation: after root lstat validation, the observer called fsImpl.statSync
// inside try/catch. RED output:
//   FAILED: must not swallow an attempted stat metadata read
//   2 !== 0
// Restored-source GREEN output:
//   coordinator-backup-observer-adversarial: 11 checks passed
// The source was restored byte-for-byte (SHA-256
// 0df1cdd9a0376416b1c426a7523ef67ee3a5b0f0dd2cf588998886b31372734e).
//
// Shape census:
//   (1) NOT-FOUND: both loops use non-empty inline literal collections.
//   (2) NOT-FOUND: no exit-status or truthy-return assertions.
//   (3) FOUND/FIXED: the subject swallowed fakeFs.statSync's assertion.
//   (4) NOT-FOUND: filesystem fakes are dependencies, not the observer subject.
//   (5) NOT-FOUND: no skips or platform precondition guards.
//   (6) NOT-FOUND: expected observations are fixed independently of the subject.
// Preconditions not met: none.
'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const observer = require('../src/lib/coordinator/backup-observer.js');

let passed = 0;
let followedTargetMetadataReads = 0;
const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const ROOT = path.join(os.tmpdir(), 'backup-root');
const SNAPSHOT = 'snapshot-20260729T110000Z';
const SNAPSHOT_PATH = path.join(ROOT, SNAPSHOT);

function check(name, fn) {
  const readsBefore = followedTargetMetadataReads;
  fn();
  assert.equal(followedTargetMetadataReads, readsBefore, 'must not swallow an attempted stat metadata read');
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function directoryMetadata(mtimeMs, options = {}) {
  return {
    mtimeMs,
    isDirectory: () => options.directory !== false,
    isSymbolicLink: () => options.link === true,
    ...(Object.hasOwn(options, 'reparse') ? { isReparsePoint: () => options.reparse } : {})
  };
}

function directory(name) {
  return { name, isDirectory: () => true };
}

function unavailable(result) {
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: 'backup-age-observation',
    reportMode: 'report-only',
    observedAt: '2026-07-29T12:00:00.000Z',
    lastBackupAt: null
  });
  assert.equal(JSON.stringify(result).includes(ROOT), false);
}

function fakeFs({ entries = [directory(SNAPSHOT)], root = directoryMetadata(NOW), candidate = directoryMetadata(NOW - 1), onLstat = null } = {}) {
  return {
    opendirSync(candidatePath) {
      assert.equal(candidatePath, ROOT);
      let index = 0;
      return {
        readSync() { return index < entries.length ? entries[index++] : null; },
        closeSync() {}
      };
    },
    lstatSync(candidatePath) {
      if (onLstat) return onLstat(candidatePath);
      if (candidatePath === ROOT) return root;
      assert.equal(candidatePath, SNAPSHOT_PATH);
      return candidate;
    },
    statSync() {
      followedTargetMetadataReads += 1;
      throw new Error('followed-target metadata is forbidden');
    }
  };
}

function run() {
  process.stdout.write('coordinator-backup-observer-adversarial\n');

  check('requires root lstat metadata to be a non-link non-reparse directory', () => {
    for (const root of [
      directoryMetadata(NOW, { link: true }),
      directoryMetadata(NOW, { reparse: true }),
      directoryMetadata(NOW, { directory: false }),
      { ...directoryMetadata(NOW), isReparsePoint: false }
    ]) {
      unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: fakeFs({ root }) }));
    }
  });

  check('rejects candidate symlink and junction-like reparse metadata without following it', () => {
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: fakeFs({ candidate: directoryMetadata(NOW - 1, { link: true }) }) }));
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: fakeFs({ candidate: directoryMetadata(NOW - 1, { reparse: true }) }) }));
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: fakeFs({ candidate: { ...directoryMetadata(NOW - 1), isReparsePoint: false } }) }));
  });

  check('fails closed on lstat races and never consults stat metadata', () => {
    let calls = 0;
    const fsImpl = fakeFs({
      onLstat(candidatePath) {
        calls += 1;
        return candidatePath === ROOT
          ? directoryMetadata(NOW)
          : directoryMetadata(NOW - 1, { link: true });
      }
    });
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl }));
    assert.equal(calls, 2);
  });

  check('fails closed on root or candidate lstat errors, hostile accessors, and proxies', () => {
    unavailable(observer.observeBackupDestination(ROOT, {
      nowMs: NOW,
      fsImpl: fakeFs({ onLstat() { throw new Error(`denied: ${ROOT}`); } })
    }));

    const hostileEntry = {};
    Object.defineProperty(hostileEntry, 'name', { get() { throw new Error(`hostile: ${ROOT}`); } });
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: fakeFs({ entries: [hostileEntry] }) }));

    const hostileProxy = new Proxy(directory(SNAPSHOT), {
      get(target, key, receiver) {
        if (key === 'isDirectory') throw new Error('no entry method');
        return Reflect.get(target, key, receiver);
      }
    });
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: fakeFs({ entries: [hostileProxy] }) }));

    const hostileEntries = new Proxy([directory(SNAPSHOT)], {
      get(target, key, receiver) {
        if (key === 'length') throw new Error('no list length');
        return Reflect.get(target, key, receiver);
      }
    });
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: fakeFs({ entries: hostileEntries }) }));
  });

  check('uses lstat only for the root and canonical direct child, and fails closed on future metadata', () => {
    const calls = [];
    const fsImpl = fakeFs({
      entries: [directory('../snapshot-20260729T110000Z'), directory(SNAPSHOT)],
      onLstat(candidatePath) {
        calls.push(candidatePath);
        return candidatePath === ROOT ? directoryMetadata(NOW) : directoryMetadata(NOW + 1);
      }
    });
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl }));
    assert.deepEqual(calls, [ROOT, SNAPSHOT_PATH]);
  });

  check('keeps only a redacted report-only result when a filesystem error carries destination text', () => {
    const result = observer.observeBackupDestination(ROOT, {
      nowMs: NOW,
      fsImpl: {
        lstatSync() { return directoryMetadata(NOW); },
        opendirSync() { throw new Error(`cannot enumerate ${ROOT}`); }
      }
    });
    unavailable(result);
    assert.equal(JSON.stringify(result).includes('cannot enumerate'), false);
  });

  check('snapshots options without property reads and bounds hostile directory inventories', () => {
    let reads = 0;
    const options = new Proxy({ nowMs: NOW, fsImpl: fakeFs() }, {
      get() {
        reads += 1;
        throw new Error('ordinary option reads are forbidden');
      }
    });
    const result = observer.observeBackupDestination(ROOT, options);
    assert.equal(result.lastBackupAt, '2026-07-29T11:00:00.000Z');
    assert.equal(reads, 0);

    let streamReads = 0;
    let streamCloses = 0;
    const streamingFs = {
      lstatSync() { return directoryMetadata(NOW); },
      opendirSync() {
        return {
          readSync() { streamReads += 1; return directory('notes'); },
          closeSync() { streamCloses += 1; }
        };
      }
    };
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: streamingFs }));
    assert.equal(streamReads, observer.MAX_DIRECTORY_ENTRIES + 1);
    assert.equal(streamCloses, 1);

    const hostileFs = new Proxy({}, { get() { throw new Error('hostile filesystem adapter'); } });
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl: hostileFs }));
  });

  check('rejects a future encoded snapshot name before consulting child metadata', () => {
    const calls = [];
    const fsImpl = {
      opendirSync() {
        let used = false;
        return {
          readSync() {
            if (used) return null;
            used = true;
            return directory('snapshot-20260729T120001Z');
          },
          closeSync() {}
        };
      },
      lstatSync(candidatePath) {
        calls.push(candidatePath);
        return directoryMetadata(NOW - 1);
      }
    };
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl }));
    assert.deepEqual(calls, [ROOT]);
  });

  check('closes an opened directory when read-method acquisition is hostile or invalid', () => {
    for (const readShape of ['throwing-getter', 'non-function']) {
      let closes = 0;
      const directoryHandle = {
        closeSync() { closes += 1; }
      };
      if (readShape === 'throwing-getter') {
        Object.defineProperty(directoryHandle, 'readSync', {
          get() { throw new Error('hostile readSync getter'); }
        });
      } else {
        directoryHandle.readSync = 42;
      }
      const fsImpl = {
        lstatSync() { return directoryMetadata(NOW); },
        opendirSync() { return directoryHandle; }
      };
      unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl }));
      assert.equal(closes, 1, readShape);
    }
  });

  check('uses canonical snapshot chronology instead of mutable directory mtime', () => {
    const result = observer.observeBackupDestination(ROOT, {
      nowMs: NOW,
      fsImpl: fakeFs({ candidate: directoryMetadata(NOW - 1) })
    });
    assert.equal(result.lastBackupAt, '2026-07-29T11:00:00.000Z');
  });

  check('closes an opened directory after initial close-method acquisition throws', () => {
    let closeReads = 0;
    let closes = 0;
    const directoryHandle = {
      readSync() { return null; }
    };
    Object.defineProperty(directoryHandle, 'closeSync', {
      get() {
        closeReads += 1;
        if (closeReads === 1) throw new Error('transient closeSync getter failure');
        return () => { closes += 1; };
      }
    });
    const fsImpl = {
      lstatSync() { return directoryMetadata(NOW); },
      opendirSync() { return directoryHandle; }
    };
    unavailable(observer.observeBackupDestination(ROOT, { nowMs: NOW, fsImpl }));
    assert.equal(closeReads, 2);
    assert.equal(closes, 1);
  });

  process.stdout.write(`\ncoordinator-backup-observer-adversarial: ${passed} checks passed\n`);
}

try {
  run();
} catch (error) {
  process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`);
  process.exitCode = 1;
}

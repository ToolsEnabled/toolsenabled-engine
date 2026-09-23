/* Mutation check (2026-08-27):
 * In src/lib/supervision/lock.js, changed the live-holder condition from
 * `processAlive(existing.pid)` to `false`.
 * The edit landed (confirmed in the module), and this test file went red.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lock = require('../src/lib/supervision/lock.js');

let checks = 0;
function check(label, run) {
  run();
  checks += 1;
  process.stdout.write(`  ok ${label}\n`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervision-lock-'));
try {
  check('acquire writes the supplied holder values and inspect reports the live holder', () => {
    const file = path.join(dir, 'nested', 'observer.lock');
    const startedAtMs = 1787800000000;
    const result = lock.acquire(file, { pid: process.pid, startedAtMs });

    assert.deepEqual(result, {
      acquired: true,
      heldBy: { pid: process.pid, startedAt: new Date(startedAtMs).toISOString(), startedAtMs },
      reason: 'lock acquired'
    });
    assert.deepEqual(lock.readLock(file), result.heldBy);
    assert.deepEqual(lock.inspect(file), { present: true, alive: true, holder: result.heldBy });
  });

  check('a live holder refuses another pid and a foreign pid cannot release its lock', () => {
    const file = path.join(dir, 'nested', 'observer.lock');
    const attempt = lock.acquire(file, { pid: process.pid + 1, startedAtMs: 1787800001000 });

    assert.equal(attempt.acquired, false);
    assert.equal(attempt.heldBy.pid, process.pid);
    assert.match(attempt.reason, new RegExp(`another observer is already running \\(pid ${process.pid}, started `));
    assert.deepEqual(lock.release(file, { pid: process.pid + 1 }), {
      released: false,
      reason: `lock is held by pid ${process.pid}, not ${process.pid + 1}`
    });
    assert.equal(fs.existsSync(file), true, 'a foreign release must leave the holder lock intact');
  });

  check('the owner can release and inspect then reports absence', () => {
    const file = path.join(dir, 'nested', 'observer.lock');
    assert.deepEqual(lock.release(file, { pid: process.pid }), { released: true, reason: 'lock released' });
    assert.deepEqual(lock.inspect(file), { present: false, alive: false, holder: null });
    assert.equal(lock.readLock(file), null);
    assert.deepEqual(lock.release(file, { pid: process.pid }), { released: false, reason: 'no lock present' });
  });

  check('a dead holder is reclaimed and force replaces an otherwise live holder', () => {
    const file = path.join(dir, 'takeover.lock');
    const deadPid = 2 ** 30;
    fs.writeFileSync(file, `${JSON.stringify({ pid: deadPid, startedAt: 'old', startedAtMs: 1 })}\n`);
    assert.equal(lock.processAlive(deadPid), false);
    assert.equal(lock.acquire(file, { pid: process.pid, startedAtMs: 2 }).acquired, true);

    const forced = lock.acquire(file, { pid: process.pid + 1, startedAtMs: 3, force: true });
    assert.equal(forced.acquired, true);
    assert.equal(lock.readLock(file).pid, process.pid + 1);
    assert.equal(lock.release(file, { pid: process.pid + 1 }).released, true);
  });

  check('invalid lock contents are surfaced unless force explicitly replaces them', () => {
    const file = path.join(dir, 'invalid.lock');
    fs.writeFileSync(file, '{not json');
    assert.throws(() => lock.readLock(file), SyntaxError);
    const refused = lock.acquire(file, { pid: process.pid });
    assert.equal(refused.acquired, false);
    assert.equal(refused.heldBy, null);
    assert.equal(refused.code, 'LOCK_READ_INDETERMINATE');
    assert.equal(refused.causeCode, undefined);
    assert.match(refused.reason, /^existing lock could not be read safely:/);

    assert.equal(lock.acquire(file, { pid: process.pid, force: true }).acquired, true);
    assert.equal(lock.release(file, { pid: process.pid }).released, true);
  });

  check('a transient lock read failure is indeterminate and is not latched as absence', () => {
    const file = path.join(dir, 'busy.lock');
    const holder = { pid: process.pid, startedAt: 'cached-control', startedAtMs: 4 };
    fs.writeFileSync(file, `${JSON.stringify(holder)}\n`);

    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (candidate, ...args) => {
      if (candidate === file) {
        const error = new Error('device temporarily unavailable');
        error.code = 'EIO';
        throw error;
      }
      return originalReadFileSync(candidate, ...args);
    };
    let refused;
    try {
      refused = lock.acquire(file, { pid: process.pid + 1 });
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    assert.deepEqual(refused, {
      acquired: false,
      heldBy: null,
      code: 'LOCK_READ_INDETERMINATE',
      causeCode: 'EIO',
      reason: 'existing lock could not be read safely: device temporarily unavailable; this does not mean the lock is absent'
    });
    assert.deepEqual(lock.readLock(file), holder,
      'the successful lock record remains readable after the transient failure (no failure latch)');
    assert.equal(lock.readLock(path.join(dir, 'genuinely-absent.lock')), null,
      'ENOENT remains the one definite absent result');
  });

  process.stdout.write(`Supervision lock tests passed (${checks} checks).\n`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

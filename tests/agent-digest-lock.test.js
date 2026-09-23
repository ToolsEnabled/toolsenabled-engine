/* Mutation check (2026-08-27):
 * Changed the live-holder condition from `isAlive(read.holder.pid)` to
 * `!isAlive(read.holder.pid)` in src/lib/agent-digest/lock.js.
 * The mutation landed: yes. This isolated test went red: yes (exit 1).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AgentDigestLockError,
  acquireLock,
  pidAlive,
  releaseLock
} = require('../src/lib/agent-digest/lock');

const sharedMutex = require('../src/lib/process-claim-lock');
assert.strictEqual(sharedMutex, require('../src/lib/agent-digest/lock'),
  'the compatibility entry must share the kernel implementation and error identities');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-digest-lock-behavior-'));

try {
  const liveLockPath = path.join(directory, 'nested', 'digest.lock');
  const holder = sharedMutex.acquireLock(liveLockPath, { pid: 4101, isAlive: pid => pid === 4101 });

  assert.deepEqual(
    JSON.parse(fs.readFileSync(liveLockPath, 'utf8')).pid,
    4101,
    'acquireLock must create the lock and record its holder pid'
  );
  assert.throws(
    () => acquireLock(liveLockPath, { pid: 4102, isAlive: pid => pid === 4101 }),
    error => {
      assert.ok(error instanceof AgentDigestLockError);
      assert.equal(error.code, 'AGENT_DIGEST_ALREADY_RUNNING');
      assert.equal(error.holderPid, 4101);
      return true;
    },
    'a live holder must exclude a contender and identify itself'
  );

  releaseLock(liveLockPath, 9999);
  assert.equal(fs.existsSync(liveLockPath), true, 'releaseLock must preserve another pid\'s lock');
  holder.release();
  assert.equal(fs.existsSync(liveLockPath), false, 'the holder release function must remove its own lock');
  assert.doesNotThrow(() => holder.release(), 'release must be idempotent');

  const staleLockPath = path.join(directory, 'stale.lock');
  fs.writeFileSync(staleLockPath, JSON.stringify({ pid: 5101 }));
  const replacement = acquireLock(staleLockPath, { pid: 5102, isAlive: () => false });
  assert.equal(
    JSON.parse(fs.readFileSync(staleLockPath, 'utf8')).pid,
    5102,
    'acquireLock must reclaim a lock whose holder is dead'
  );
  replacement.release();

  assert.equal(pidAlive(process.pid), true, 'pidAlive must recognize the current process');
  for (const invalidPid of [0, -1, 1.5, NaN]) {
    assert.equal(pidAlive(invalidPid), false, `pidAlive must reject invalid pid ${invalidPid}`);
  }

  process.stdout.write('agent-digest lock export behavior passed\n');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

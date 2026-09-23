'use strict';

/* TWO PROCESSES COULD BOTH HOLD THIS LOCK, AND NEITHER WOULD EVER KNOW.
 *
 * The lock is published with writeFileSync(..., { flag: 'wx' }). `wx` makes the
 * CREATE exclusive, not the publication: the file exists at ZERO BYTES between
 * the create and the write landing. A contender that hit EEXIST inside that
 * window read an empty string, JSON.parse threw, and readHolder answered null --
 * which acquireLock read as "stale, reclaim it". It unlinked a LIVE holder's
 * lock and took its own.
 *
 * Nothing recorded it. On release each side reads a holder pid that is no longer
 * its own and no-ops, so both log a clean acquire and a clean release.
 *
 * THE COST IS NOT THE DIGEST. Five subsystems share this lock -- intent-fidelity,
 * the build-queue writer, the owner-directive relay, IDE session consent, and
 * agent-digest -- and every store behind it is a plain read-modify-write, so a
 * co-held section silently loses one side's update. The build queue is the
 * sharpest: its expectedHash / QUEUE_CONCURRENT_EDIT guard exists to catch
 * exactly a concurrent writer, and because the hash is read INSIDE the lock, two
 * co-holders both read the same pre-state, both match, and both write. That the
 * contended state is expected by design is proved by the product's own error
 * vocabulary: QUEUE_LOCKED, STATE_BUSY, AGENT_DIGEST_ALREADY_RUNNING.
 *
 * HOW THIS IS DRIVEN, AND WHY NOT WITH TWO REAL PROCESSES. The window is real
 * but microseconds wide, so racing two processes would measure the scheduler
 * rather than the lock, and would pass or fail by luck on a loaded box. This
 * reproduces the exact FILE STATE the window produces -- the lock exists and is
 * empty -- and asks what a contender does with it. The holder finishing its
 * write is simulated by the injected `sleep`, which is what a live publisher
 * does microseconds later and what the old code never gave it a chance to do.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { acquireLock, AgentDigestLockError, AgentDigestLockUnreadableError, readHolderState } =
  require('../src/lib/agent-digest/lock.js');

const HOLDER_PID = 424242;
const CONTENDER_PID = 999999;
let checks = 0;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-lock-test-'));
const file = path.join(dir, 'digest.lock');

function halfPublished() {
  /* Byte for byte what `wx` leaves behind between creating the file and writing
     it: the file exists, and it is empty. */
  fs.writeFileSync(file, '', 'utf8');
}

function contend({ finishPublishing }) {
  let finished = false;
  const options = {
    pid: CONTENDER_PID,
    isAlive: pid => pid === HOLDER_PID,
    publishGraceMs: 50,
    polls: 5,
    sleep: () => {
      if (finishPublishing && !finished) {
        finished = true;
        fs.writeFileSync(file, JSON.stringify({ pid: HOLDER_PID, startedAt: '2026-08-27T00:00:00.000Z' }), 'utf8');
      }
    },
  };
  try {
    const held = acquireLock(file, options);
    return { took: true, pid: held.pid };
  } catch (error) {
    if (error instanceof AgentDigestLockError) return { took: false, refusedAbout: error.holderPid };
    if (error instanceof AgentDigestLockUnreadableError) return { took: false, unreadable: true };
    throw error;
  }
}

/* ---- 1. A LIVE HOLDER MID-PUBLICATION KEEPS ITS LOCK ---------------------- */

halfPublished();
const stolen = contend({ finishPublishing: true });

assert.equal(stolen.took, false,
  'a contender took a lock away from a holder that was still writing it; both processes now hold it, '
  + 'and neither will ever find out because each release reads a pid that is not its own and no-ops');
checks += 1;

assert.equal(stolen.refusedAbout, HOLDER_PID,
  'the refusal did not name the process it deferred to, so a person debugging a QUEUE_LOCKED or STATE_BUSY '
  + 'has nothing to look for');
checks += 1;

const afterRefusal = readHolderState(file);
assert.equal(afterRefusal.state, 'held', 'the lock file did not survive the contention');
assert.equal(afterRefusal.holder.pid, HOLDER_PID,
  'the original holder is no longer named in its own lock file');
checks += 2;

/* ---- 2. AN OWNERLESS EMPTY FILE IS UNCERTAINTY, NOT ABSENCE ---------------- */
/* There is no PID or process-start identity in an empty legacy file. Time does
   not manufacture that missing fact: the publisher may be paused, its storage
   may be slow, or the file may be abandoned. Reclaiming it would reopen the
   co-holder race above. Recovery requires explicit legacy evidence rather than
   silently deleting an ownership record whose generation cannot be named. */

fs.rmSync(file, { force: true });
halfPublished();
const uncertain = contend({ finishPublishing: false });

assert.equal(uncertain.took, false,
  'elapsed time was treated as proof that an unreadable legacy lock is absent');
checks += 1;

assert.equal(uncertain.unreadable, true,
  'the refusal did not distinguish unreadable ownership from a known live holder');
assert.equal(readHolderState(file).state, 'unreadable',
  'the uncertain legacy generation was removed or overwritten');
checks += 1;

/* ---- 3. THE ORDINARY CASES ARE UNCHANGED --------------------------------- */

fs.rmSync(file, { force: true });
const fresh = acquireLock(file, { pid: CONTENDER_PID, isAlive: () => false });
assert.equal(fresh.pid, CONTENDER_PID, 'an uncontended lock could no longer be taken');
checks += 1;

const secondWhileHeld = (() => {
  try {
    acquireLock(file, { pid: 111111, isAlive: pid => pid === CONTENDER_PID });
    return 'took it';
  } catch (error) {
    return error instanceof AgentDigestLockError ? 'refused' : 'threw ' + error.constructor.name;
  }
})();
assert.equal(secondWhileHeld, 'refused',
  'a fully published lock held by a live process no longer refuses a second holder');
checks += 1;

fresh.release();
assert.equal(readHolderState(file).state, 'absent', 'releasing did not remove the lock');
checks += 1;

fs.rmSync(dir, { recursive: true, force: true });
console.log(`digest-lock-half-published: ${checks} checks passed on ${process.platform}`);

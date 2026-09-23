'use strict';

// Holds the broker's REAL lock file from another process, so a contention test
// exercises the product's own withStateLock() path rather than a stub of it.
// The broker derives its lock as `${spoolFile}.lock`
// (src/lib/agent-comms/broker.js), so holding that exact path is holding the
// broker's lock.
//
// It reports "held" to its parent only AFTER the lock is actually acquired: a
// contention test that started measuring before the lock existed would be
// measuring an uncontended read and passing for the wrong reason.

const { acquireLock } = require('../../../src/lib/process-claim-lock');

const [lockFile, holdMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw) || 5_000;

let lock;
try {
  lock = acquireLock(lockFile, { pid: process.pid });
} catch (error) {
  if (process.send) process.send({ held: false, reason: error && error.code });
  process.exit(1);
}

if (process.send) process.send({ held: true, pid: process.pid });

setTimeout(() => {
  try { lock.release(); } catch { /* the parent may have killed us first */ }
  process.exit(0);
}, holdMs);

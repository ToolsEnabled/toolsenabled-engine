'use strict';
/* TEMP-AND-RENAME IS NOT THE SAME AS DURABLE, AND A SIBLING FILE ALREADY PAID
 * FOR THE DIFFERENCE.
 *
 * The broker's spool has always been written to a temp file and renamed, so a
 * reader never sees half a file. That says nothing about whether the BYTES
 * reached the disk: without an fsync the rename can be recorded while the data
 * blocks it points at are still only in the cache, and an unclean shutdown
 * then leaves a file of the right length full of zeros.
 *
 * MEASURED 2026-09-03 on this machine: tree-node-directory.js's own state file
 * -- written with this exact temp-and-rename shape and no fsync -- was found as
 * 22,346 bytes of pure NUL and quarantined as
 * tree-nodes.json.corrupt-20260903T182449Z-75624e54.zeros. That was fixed in
 * 4b0a59d94566f307771d70fd67cbdecbfb2e1f96. This file is the broker's own
 * writeState, which had the identical unfsynced shape and was not part of that
 * fix. It is a worse place for the bug to hide: the tree directory only holds
 * roster identity, which is rebuilt as circles re-register, but this file is
 * the broker's spool -- every undelivered packet, dead letter and wake
 * cooldown for agent_comms.send_local lives only here between commits. A torn
 * write here destroys message content with nothing left anywhere to
 * reconstruct it from: a message the sender believes it sent, silently gone,
 * with no answer and no trace. This machine has a recorded history of unclean
 * power events, so the window this closes is not theoretical.
 *
 * broker.js's writeState calls the real `fs` module directly rather than
 * through an injected fsImpl (unlike tree-node-directory.js), so this test
 * instruments the shared fs module in place for the duration of one broker
 * construction and restores it immediately after. Calls are attributed to the
 * broker's OWN state file (by exact temp-name shape, and by rename target)
 * so a passing lock-file fsync/rename pair elsewhere in the same construction
 * can never stand in for the state file's own.
 *
 *   node --test tests/broker-durable-write.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBroker } = require('../src/lib/agent-comms/broker.js');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'broker-durable-'));
}

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Construction alone drives exactly one broker.json write: createBroker reads
   state (ENOENT -> empty), reconciles an empty spool against an empty
   directory, and unconditionally persists the result before returning. No
   send/receive call is needed to reach writeState. */
function buildOnce(stateFile) {
  return createBroker({
    stateFile,
    transport: { deliver: async () => { throw new Error('not used by construction'); } },
    livenessReceiver: { getAgent: () => { throw new Error('not used by construction'); } },
    now: () => 10_000
  });
}

/* Instruments the real fs module (broker.js has no fsImpl seam) and records
   every call to the functions durability depends on, tagged with the path or
   fd each call touches. Restores the original functions in `finally` even if
   the broker construction throws, so one test's patch can never leak into the
   next. */
function withInstrumentedFs(target, { renameSync, hideFsyncForStateFile = false } = {}, run) {
  const calls = [];
  const fdPaths = new Map();
  const originals = {
    openSync: fs.openSync,
    writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync,
    closeSync: fs.closeSync,
    renameSync: fs.renameSync
  };
  const hadFsyncSync = Object.hasOwn(fs, 'fsyncSync') || 'fsyncSync' in fs;
  // Calls belonging to THIS state file only: its temp file is always named
  // "<target>.<pid>.<uuid>.tmp" (all-digit pid segment), which excludes the
  // sibling lock file's own temp-and-rename (named from "<target>.lock").
  const tempShape = new RegExp(`^${escapeRegExp(target)}\\.\\d+\\.[^.]+\\.tmp$`);
  // Set only while the state file's own fd is open, so acquireLock's
  // unrelated, unconditional fsyncSync call (agent-digest/lock.js) -- which
  // runs before and after this window guarding a DIFFERENT file -- is never
  // touched. This isolates "the state write's own guard sees no fsyncSync"
  // from "nothing on the machine has fsyncSync", which would also break the
  // lock and prove nothing about writeState's own fallback.
  let hidingForFd = null;

  fs.openSync = (p, ...rest) => {
    const fd = originals.openSync(p, ...rest);
    fdPaths.set(fd, p);
    calls.push({ op: 'open', path: p, flag: rest[0] });
    if (hideFsyncForStateFile && hidingForFd === null && tempShape.test(p)) {
      hidingForFd = fd;
      delete fs.fsyncSync;
    }
    return fd;
  };
  fs.writeFileSync = (dest, ...rest) => {
    const p = typeof dest === 'number' ? fdPaths.get(dest) : dest;
    calls.push({ op: 'write', path: p });
    return originals.writeFileSync(dest, ...rest);
  };
  if (originals.fsyncSync) {
    fs.fsyncSync = fd => {
      calls.push({ op: 'fsync', path: fdPaths.get(fd) });
      return originals.fsyncSync(fd);
    };
  }
  fs.closeSync = fd => {
    calls.push({ op: 'close', path: fdPaths.get(fd) });
    fdPaths.delete(fd);
    if (hidingForFd === fd) {
      hidingForFd = null;
      fs.fsyncSync = originals.fsyncSync
        ? args => { calls.push({ op: 'fsync', path: fdPaths.get(args) }); return originals.fsyncSync(args); }
        : originals.fsyncSync;
    }
    return originals.closeSync(fd);
  };
  fs.renameSync = (from, to) => {
    calls.push({ op: 'rename', from, to });
    if (renameSync) return renameSync(from, to, originals.renameSync);
    return originals.renameSync(from, to);
  };

  try {
    run(calls);
  } finally {
    fs.openSync = originals.openSync;
    fs.writeFileSync = originals.writeFileSync;
    if (hadFsyncSync) fs.fsyncSync = originals.fsyncSync; else delete fs.fsyncSync;
    fs.closeSync = originals.closeSync;
    fs.renameSync = originals.renameSync;
  }

  return calls.filter(c => (c.op === 'rename' ? c.to === target : tempShape.test(c.path || '')));
}

test('the broker spool is flushed BEFORE the rename, not after it', () => {
  const root = scratch();
  const target = path.resolve(path.join(root, 'broker.json'));

  const stateCalls = withInstrumentedFs(target, {}, () => buildOnce(target));

  const order = stateCalls.map(c => c.op);
  const fsyncAt = order.indexOf('fsync');
  const renameAt = order.indexOf('rename');

  assert.notEqual(fsyncAt, -1, 'the broker spool was renamed into place without ever being flushed');
  assert.notEqual(renameAt, -1, 'nothing was renamed at all');
  assert.ok(fsyncAt < renameAt, `fsync must precede rename; saw ${JSON.stringify(order)}`);

  /* The handle is closed before the rename too: renaming a file that is still
     open is the other way to publish something unfinished. */
  const closeAt = order.indexOf('close');
  assert.ok(closeAt > fsyncAt && closeAt < renameAt, `saw ${JSON.stringify(order)}`);

  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(written.schemaVersion, 1);
  assert.deepEqual(written.spool, []);
});

test('a leftover temp from a dead process is never written through', () => {
  /* 'wx' refuses an existing path. A temp file left behind by a process that
     died mid-write must not be reopened and appended to. */
  const root = scratch();
  const target = path.resolve(path.join(root, 'broker.json'));

  const stateCalls = withInstrumentedFs(target, {}, () => buildOnce(target));

  const openFlags = stateCalls.filter(c => c.op === 'open').map(c => c.flag);
  assert.ok(openFlags.length > 0, 'the state file was never opened');
  assert.ok(openFlags.every(flag => flag === 'wx'), `expected only exclusive creates; saw ${JSON.stringify(openFlags)}`);
});

test('the temp file is not left beside the real one, even when the rename fails', () => {
  const root = scratch();
  const target = path.resolve(path.join(root, 'broker.json'));

  assert.throws(
    () => withInstrumentedFs(target, {
      renameSync(from, to, original) {
        if (to === target) throw Object.assign(new Error('rename refused'), { code: 'EPERM' });
        return original(from, to);
      }
    }, () => buildOnce(target)),
    /rename refused/
  );

  const leftovers = fs.readdirSync(root).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [],
    'a failed write left a temp file beside the broker spool, which the next reader has to guess about');
});

test('a filesystem without fsyncSync still works, and is not pretended to be durable', () => {
  /* Matching tree-node-directory.js and agent-presence.js: the call is made
     only when it exists, so a platform without it still writes correctly
     rather than throwing. Only the state file's own fd is affected (see
     hideFsyncForStateFile above) -- the lock file's own unconditional
     fsyncSync call in agent-digest/lock.js is untouched, because that call
     succeeding or not is a fact about the lock module, not about the guard
     this test exists to prove. */
  const root = scratch();
  const target = path.resolve(path.join(root, 'broker.json'));

  let broker;
  const stateCalls = withInstrumentedFs(target, { hideFsyncForStateFile: true }, () => {
    broker = buildOnce(target);
  });

  assert.ok(broker, 'construction did not complete without fsyncSync');
  assert.equal(stateCalls.some(c => c.op === 'fsync'), false,
    'fsyncSync was called on the state file even though it was hidden for that fd');
  assert.ok(stateCalls.some(c => c.op === 'rename'),
    'the state file was never renamed into place when fsyncSync was unavailable');

  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(written.schemaVersion, 1);
});

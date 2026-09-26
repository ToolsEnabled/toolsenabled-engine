'use strict';
/* TEMP-AND-RENAME IS NOT THE SAME AS DURABLE.
 *
 * The tree directory has always been written to a temp file and renamed, so a
 * reader never sees half a file. That says nothing about whether the BYTES
 * reached the disk: without an fsync the rename can be recorded while the data
 * blocks it points at are still only in the cache, and an unclean shutdown
 * then leaves a file of the right length full of zeros.
 *
 * MEASURED 2026-09-03 on this machine: the live directory was found as 22,346
 * bytes of pure NUL and quarantined as tree-nodes.json.corrupt-...zeros. The
 * reader's guard caught it and rebuilt, but everything in it was gone -- every
 * circle registered at that moment lost its address at once. This file is the
 * single point the whole tree depends on, and a dozen other writers in this
 * engine already fsync before renaming.
 *
 *   node --test tests/tree-directory-durable-write.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directoryModule = require('../src/lib/agent-comms/tree-node-directory.js');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tree-durable-'));
}

/* A filesystem that records the ORDER of the calls that matter, so the test can
   assert the sequence rather than merely that fsync was mentioned somewhere. */
function recordingFs(extra = {}) {
  const calls = [];
  const wrapped = {
    ...fs,
    openSync(...args) { calls.push(['open', args[1]]); return fs.openSync(...args); },
    writeFileSync(target, ...rest) {
      calls.push(['write', typeof target === 'number' ? 'handle' : 'path']);
      return fs.writeFileSync(target, ...rest);
    },
    fsyncSync(handle) { calls.push(['fsync']); return fs.fsyncSync(handle); },
    closeSync(handle) { calls.push(['close']); return fs.closeSync(handle); },
    renameSync(from, to) { calls.push(['rename']); return fs.renameSync(from, to); },
    ...extra,
  };
  return { wrapped, calls };
}

function writeOnce(fsImpl, root) {
  const store = directoryModule.createTreeNodeDirectory
    ? directoryModule.createTreeNodeDirectory({ file: path.join(root, 'tree-nodes.json'), fsImpl })
    : null;
  assert.ok(store, 'the directory factory changed shape; this test needs updating');
  store.registerNode({ sessionId: 'session-a', nodeName: 'Manager', pid: 1234 });
  return path.join(root, 'tree-nodes.json');
}

test('the bytes are flushed BEFORE the rename, not after it', () => {
  const root = scratch();
  const { wrapped, calls } = recordingFs();
  const file = writeOnce(wrapped, root);

  const order = calls.map(([name]) => name);
  const fsyncAt = order.indexOf('fsync');
  const renameAt = order.indexOf('rename');

  assert.notEqual(fsyncAt, -1, 'the directory was renamed into place without ever being flushed');
  assert.notEqual(renameAt, -1, 'nothing was renamed at all');
  assert.ok(fsyncAt < renameAt,
    `fsync must precede rename; saw ${JSON.stringify(order)}`);

  /* And the handle is closed before the rename, because renaming a file that is
     still open is the other way to publish something unfinished. */
  const closeAt = order.indexOf('close');
  assert.ok(closeAt > fsyncAt && closeAt < renameAt, `saw ${JSON.stringify(order)}`);

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.nodes.length, 1);
  assert.equal(written.nodes[0].nodeName, 'Manager');
});

test('a leftover temp from a dead process is never written through', () => {
  /* 'wx' refuses an existing path. A temp file left behind by a process that
     died mid-write must not be reopened and appended to. */
  const root = scratch();
  const { wrapped, calls } = recordingFs();
  writeOnce(wrapped, root);
  const openFlags = calls.filter(([name]) => name === 'open').map(([, flag]) => flag);
  assert.ok(openFlags.includes('wx'), `expected an exclusive create; saw ${JSON.stringify(openFlags)}`);
});

test('the temp file is not left beside the real one, even when the rename fails', () => {
  const root = scratch();
  const { wrapped } = recordingFs({
    renameSync() { throw Object.assign(new Error('rename refused'), { code: 'EPERM' }); },
  });
  assert.throws(() => writeOnce(wrapped, root), /rename refused/);

  const leftovers = fs.readdirSync(root).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [],
    'a failed write left a temp file beside the directory, which the next reader has to guess about');
});

test('a filesystem without fsyncSync still works, and is not pretended to be durable', () => {
  /* Matching agent-presence.js: the call is made only when it exists, so a test
     fake or a platform without it writes correctly rather than throwing. */
  const root = scratch();
  const bare = { ...fs };
  delete bare.fsyncSync;
  const file = writeOnce(bare, root);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.nodes.length, 1);
});

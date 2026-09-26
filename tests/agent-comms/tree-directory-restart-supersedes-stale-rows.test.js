'use strict';

/* ONE CIRCLE, ONE ROW -- ACROSS A CLEAN RESTART AND ACROSS A CRASH.
 *
 * The directory already retires a stale row when a RESUME re-registers the
 * same engine thread (supersededByThread). Page 2 has two other ways a circle
 * comes back under the same name on the same tree, and both left the previous
 * incarnation standing beside the new one for STOPPED_RETENTION_MS (an hour):
 *
 *   - a clean restart: the old session is closed (stoppedAt stamped) and a new
 *     session with a NEW thread registers the saved identity. Nothing shares a
 *     thread, so nothing was retired.
 *   - a crash of the app: the old row has no stoppedAt and no heartbeat; the
 *     relaunched app resumes the circle, and a provider that never bound a
 *     thread id (or a seeded resume) registers a new thread.
 *
 * In both, the roster a Worker reads listed its Manager as reachable AND as
 * "registered-but-session-stopped" at once, for an hour. Names are unique per
 * tree (the app persists a per-tree ordinal on every circle), so a row with
 * the same name and the same tree key is the same circle's earlier session --
 * and when that row is not live, the new registration is its replacement, not
 * its neighbour. A same-name row that IS live is left alone on purpose: that is
 * a real conflict, and the ambiguity refusal is the honest answer to it.
 *
 * The second half is about a crash that the heartbeat window hides. Every row
 * carries the pid of the process that registered it. A process that is gone
 * cannot be running a session, yet a row of a dead process was "live" for the
 * whole 90-second window after a crash -- and a child started under it in that
 * window was told its message was delivered into a spool nobody drains. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');

function directoryFor(t, options = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-directory-restart-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return createTreeNodeDirectory({ file: path.join(workspace, 'tree-nodes.json'), ...options });
}

const rowsNamed = (directory, name) => directory.listNodes().filter(node => node.nodeName === name);

test('a clean restart replaces the circle\'s stopped row instead of standing beside it', t => {
  let now = 1_900_000_000_000;
  const directory = directoryFor(t, { now: () => now, liveWindowMs: 90_000 });

  directory.registerNode({ sessionId: 'manager-1', nodeName: 'Manager', threadId: 'thread-m1', treeKey: 'tree-root' });
  directory.registerNode({
    sessionId: 'worker-1', nodeName: 'Worker', managerName: 'Manager', threadId: 'thread-w1', treeKey: 'tree-root'
  });
  /* The person presses Stop, then Start: the host unregisters the old session
     and a NEW session on a NEW thread registers the saved identity. */
  directory.unregisterNode({ sessionId: 'manager-1' });
  now += 1_000;
  const manager2 = directory.registerNode({ sessionId: 'manager-2', nodeName: 'Manager', threadId: 'thread-m2', treeKey: 'tree-root' });

  assert.equal(rowsNamed(directory, 'Manager').length, 1,
    'the restarted circle must hold one row; its stopped predecessor is the same circle, not a neighbour');
  const roster = directory.reachabilityFrom({ from: 'Worker' });
  assert.equal(roster.ok, true);
  /* The address on the row is the RESTARTED session's, so a caller reading the
     roster cannot address the stopped predecessor (T138). */
  assert.deepEqual(roster.reachable, [{ nodeName: 'Manager', agentId: manager2.agentId, relation: 'manager',
    treeKey: 'tree-root', lastSeenAt: 1_900_000_001_000, transient: false }]);
  assert.deepEqual(roster.unavailable, [],
    'the roster listed the same circle as reachable and as registered-but-session-stopped at once');
  const delivery = directory.resolveDelivery({ from: 'Worker', to: 'Manager' });
  assert.equal(delivery.ok, true);
  assert.equal(delivery.recipient.sessionId, 'manager-2');
});

test('a circle resumed after a crash replaces its lapsed row even when no thread ties them', t => {
  let now = 1_900_000_000_000;
  const directory = directoryFor(t, { now: () => now, liveWindowMs: 90_000 });

  /* No thread id: a provider that binds none, or a row written before the
     field existed. No stoppedAt either: the process died without saying so. */
  directory.registerNode({ sessionId: 'manager-old', nodeName: 'Manager', treeKey: 'tree-root' });
  directory.registerNode({ sessionId: 'worker-1', nodeName: 'Worker', managerName: 'Manager', treeKey: 'tree-root' });
  now += 200_000; // well past the live window, well short of the hour retention
  directory.heartbeatNode({ sessionId: 'worker-1' });
  const managerNew = directory.registerNode({ sessionId: 'manager-new', nodeName: 'Manager', threadId: 'thread-fresh', treeKey: 'tree-root' });

  assert.equal(rowsNamed(directory, 'Manager').length, 1);
  assert.equal(rowsNamed(directory, 'Manager')[0].sessionId, 'manager-new');
  const roster = directory.reachabilityFrom({ from: 'Worker' });
  assert.deepEqual(roster.reachable, [{ nodeName: 'Manager', agentId: managerNew.agentId, relation: 'manager',
    treeKey: 'tree-root', lastSeenAt: 1_900_000_200_000, transient: false }]);
  assert.deepEqual(roster.unavailable, []);
});

test('a same-named row that is still live, on another tree, or on no tree is never superseded', t => {
  let now = 1_900_000_000_000;
  const directory = directoryFor(t, { now: () => now, liveWindowMs: 90_000 });

  directory.registerNode({ sessionId: 'manager-live', nodeName: 'Manager', treeKey: 'tree-a' });
  directory.registerNode({ sessionId: 'manager-other-tree', nodeName: 'Manager', treeKey: 'tree-b' });
  directory.registerNode({ sessionId: 'manager-keyless', nodeName: 'Manager' });
  directory.unregisterNode({ sessionId: 'manager-other-tree' });
  directory.unregisterNode({ sessionId: 'manager-keyless' });
  now += 1_000;
  /* A second live "Manager" on tree-a is a real conflict: both rows stay and
     the refusal names it, exactly as before. The stopped rows on tree-b and on
     no tree are other circles' history and keep their "session ended" answer. */
  directory.registerNode({ sessionId: 'manager-dup', nodeName: 'Manager', treeKey: 'tree-a' });
  directory.registerNode({ sessionId: 'worker-a', nodeName: 'Worker', managerName: 'Manager', treeKey: 'tree-a' });

  const sessions = rowsNamed(directory, 'Manager').map(node => node.sessionId).sort();
  assert.deepEqual(sessions, ['manager-dup', 'manager-keyless', 'manager-live', 'manager-other-tree']);
  assert.equal(directory.resolveDelivery({ from: 'Worker', to: 'Manager' }).code, 'TREE_RECIPIENT_AMBIGUOUS');
});

test('a row whose registering process is gone is not a live recipient, whatever its heartbeat says', t => {
  let now = 1_900_000_000_000;
  const directory = directoryFor(t, {
    now: () => now,
    liveWindowMs: 90_000,
    pidIsAlive: pid => pid !== 4242
  });

  directory.registerNode({ sessionId: 'crashed-manager', nodeName: 'Manager', pid: 4242, treeKey: 'tree-root' });
  directory.registerNode({
    sessionId: 'worker-1', nodeName: 'Worker', managerName: 'Manager', pid: process.pid, treeKey: 'tree-root'
  });
  now += 1_000; // inside the heartbeat window: the only thing saying "gone" is the pid

  const manager = directory.listNodes().find(node => node.sessionId === 'crashed-manager');
  assert.equal(manager.live, false, 'a dead process was still a live recipient for the whole heartbeat window');
  assert.equal(directory.listNodes().find(node => node.sessionId === 'worker-1').live, true);
  /* T255. THE SUBJECT SURVIVES: a dead process is still NOT a live recipient,
     which is what this test is for, and recipientStopped is now how that is
     said. What changed is the consequence. The old wording -- "accepted for
     delivery into a spool nobody will drain" -- was the right fear when nothing
     could drain the spool; a wake drains it, so the message is kept for the
     crashed circle instead of discarded. The thing that must NOT happen is this
     row being treated as live, and that is asserted directly. */
  const delivery = directory.resolveDelivery({ from: 'Worker', to: 'Manager' });
  assert.equal(delivery.ok, true, 'a crashed manager is still addressable, so its message can be held');
  assert.equal(delivery.recipientStopped, true,
    'a dead process must never resolve as a running recipient, whatever its heartbeat says');
  const roster = directory.reachabilityFrom({ from: 'Worker' });
  assert.deepEqual(roster.reachable, []);
  assert.equal(roster.unavailable[0].status, 'registered-but-session-stopped');
});

test('a pid probe that cannot answer never turns a read into a refusal, and a row with no pid is unchanged', t => {
  let now = 1_900_000_000_000;
  const directory = directoryFor(t, {
    now: () => now,
    liveWindowMs: 90_000,
    pidIsAlive: () => { throw new Error('probe unavailable'); }
  });
  directory.registerNode({ sessionId: 'manager-1', nodeName: 'Manager', pid: 4242, treeKey: 'tree-root' });
  directory.registerNode({ sessionId: 'manager-no-pid', nodeName: 'Manager 2', treeKey: 'tree-root' });
  const rows = directory.listNodes();
  assert.equal(rows.find(node => node.sessionId === 'manager-1').live, true, 'an unanswerable probe must read as alive');
  assert.equal(rows.find(node => node.sessionId === 'manager-no-pid').live, true);

  /* The default probe is the real one: this process is alive. */
  const real = directoryFor(t, { now: () => now, liveWindowMs: 90_000 });
  real.registerNode({ sessionId: 'self', nodeName: 'Self', pid: process.pid });
  assert.equal(real.listNodes()[0].live, true);
});

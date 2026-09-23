'use strict';

/* THE SEAM THIS LANE OWNS BOTH HALVES OF: A REWIND MOVES A SESSION'S THREAD
 * WITHOUT TELLING THIS DIRECTORY, AND THE DIRECTORY'S OWN SUPERSESSION
 * COVERS FOR IT ANYWAY -- TRACED END TO END, NOT ASSUMED.
 *
 * The app half of this rotation's HUNT (page2/tree-store) fixed performRewind
 * so a rewind's forked thread reaches the durable transcript record a later
 * Resume reads (8d4adab, tools/test/rewind-thread-persists.test.mjs). Tracing
 * where else that forked thread id goes turned up a second place that never
 * hears about it: shell/agent-host.cjs's rewindSession() --
 *
 *   session.threadId = forked.threadId
 *   session.activeTurnId = null
 *   return Object.freeze({ sessionId: session.sessionId, threadId: forked.threadId, turnId: rewindTurnId })
 *
 * -- moves the SESSION object's own threadId and returns the fork, but calls
 * neither `treeMessaging.directory.registerNode` nor `.bindThread` (grepped:
 * zero call sites for bindThread( in shell/agent-host.cjs at all). So a
 * circle registered on this directory before a rewind keeps naming the
 * PRE-rewind thread in its `threadId` field for the rest of that session's
 * life -- proven below as a fact about THIS module, not inferred from the
 * app source.
 *
 * THE RISK traced, and why it is pinned rather than fixed: findByThreadId is
 * used exactly once, by shell/agent-host.cjs adoptTreeAddressFromThread(), to
 * let a freshly-resumed session (a NEW sessionId, per this module's own
 * "resumed circle" tests) find and retire its circle's earlier row. If that
 * lookup were the ONLY thing standing between a resumed circle and a silent
 * loss of its tree address, a rewind-then-restart-then-resume would strand
 * the circle exactly as the "eighty minutes" and "one circle, unreachable"
 * incidents this file's header documents. It is not the only thing: Page 2
 * supplies `treeIdentity` directly on every start (src/views/computers.js
 * nodeTreeIdentity -- read from the tree store, not from any thread lookup),
 * so shell/agent-host.cjs never depends on findByThreadId succeeding to know
 * WHO the circle is; and registerNode's OWN dedup (supersededByCircle, by
 * name and treeKey) retires the stale row on the very next registration
 * regardless of whether a thread ever tied the two rows together --
 * tree-directory-restart-supersedes-stale-rows.test.js already proves this
 * for an old row with NO thread at all. What that suite never drove is the
 * shape a rewind actually leaves: an old row that DOES carry a thread id,
 * just the WRONG one. Driven here, because "the mismatch branch behaves like
 * the absent-thread branch" was, until this file, a claim resting on reading
 * supersededByThread's `===` rather than on a row that HAS a threadId built
 * by forking one.
 *
 * Refute this pin (not the resume/supersession behavior it protects) if a
 * future engine ever calls bindThread after a rewind and closes the gap named
 * above -- at that point findByThreadId('thread-B') below starts finding a
 * row and the first assertion stops compiling with reality. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');

function directoryFor(t, options = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-directory-rewind-seam-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return createTreeNodeDirectory({ file: path.join(workspace, 'tree-nodes.json'), ...options });
}

test('PIN: a rewind leaves the durable row naming the PRE-fork thread, findByThreadId misses the fork -- and the resume still lands on one row, by name and treeKey, not by thread', t => {
  let now = 1_900_000_000_000;
  const directory = directoryFor(t, { now: () => now, liveWindowMs: 90_000 });

  directory.registerNode({ sessionId: 'manager-1', nodeName: 'Manager', threadId: 'thread-A', treeKey: 'tree-root' });
  directory.registerNode({
    sessionId: 'worker-1', nodeName: 'Worker', managerName: 'Manager', threadId: 'thread-worker', treeKey: 'tree-root',
  });
  assert.equal(directory.findByThreadId('thread-A').sessionId, 'manager-1');

  /* THE REWIND ITSELF. shell/agent-host.cjs's rewindSession moves only
     session.threadId in the in-memory session object; nothing here is called.
     So the row this directory holds for 'manager-1' is untouched -- it still
     says 'thread-A' -- while the conversation the app will persist and later
     resume is now 'thread-B' (tools/test/rewind-thread-persists.test.mjs
     proves that IS what performRewind persists post-fix). */
  assert.equal(directory.findByThreadId('thread-B'), null,
    'the fork is not registered anywhere in this directory -- this is the gap, stated as a fact about the row, not the app');
  const stillOldRow = directory.listNodes().find(node => node.sessionId === 'manager-1');
  assert.equal(stillOldRow.threadId, 'thread-A', 'the row was never rebound to the forked thread');

  /* The window closes (or the app restarts) without ever calling
     unregisterNode for the rewound session -- the crash shape, heartbeat
     simply stops -- and stays unreaped inside the hour of STOPPED_RETENTION_MS. */
  now += 200_000; // well past the 90s live window, nowhere near the hour retention
  directory.heartbeatNode({ sessionId: 'worker-1' });
  assert.equal(directory.listNodes().find(node => node.sessionId === 'manager-1').live, false,
    'setup check: the pre-rewind row must have lapsed, the way a closed window does, before the resume below');

  /* THE RESUME. A fresh session id (this module's own rule: a resumed session
     is a NEW session id -- see "a resumed circle takes its entry over").
     shell/agent-host.cjs's attemptTreeRegistration supplies exactly these
     fields: this session's OWN current thread (the fork, 'thread-B') and the
     treeIdentity Page 2 always carries directly, never discovered through
     findByThreadId. */
  const resumed = directory.registerNode({
    sessionId: 'manager-resumed-after-rewind', nodeName: 'Manager', threadId: 'thread-B', treeKey: 'tree-root',
  });

  const managers = directory.listNodes().filter(node => node.nodeName === 'Manager');
  assert.equal(managers.length, 1,
    `the rewound circle's stale row was left standing beside its resume: ${JSON.stringify(managers.map(m => m.sessionId))}`);
  assert.equal(managers[0].sessionId, 'manager-resumed-after-rewind');

  const roster = directory.reachabilityFrom({ from: 'Worker' });
  /* The address on the row is the RESUMED session's, not the rewound one's, so
     a caller cannot read an address here and deliver into the stale row (T138). */
  assert.deepEqual(roster.reachable, [{ nodeName: 'Manager', agentId: resumed.agentId, relation: 'manager',
    treeKey: 'tree-root', lastSeenAt: 1_900_000_200_000, transient: false }]);
  assert.deepEqual(roster.unavailable, [],
    'the resumed circle was listed as reachable AND as registered-but-session-stopped at once -- the exact shape this module exists to prevent');

  const delivery = directory.resolveDelivery({ from: 'Worker', to: 'Manager' });
  assert.equal(delivery.ok, true, `delivery to the rewound-then-resumed Manager was refused: ${delivery.code}`);
  assert.equal(delivery.recipient.sessionId, 'manager-resumed-after-rewind');
});

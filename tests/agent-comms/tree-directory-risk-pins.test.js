'use strict';

/* FIVE PATHS TRACED AND NOT FIXED -- PINNED SO THE NEXT AUDITOR CAN REFUTE
 * THEM RATHER THAN RE-DERIVE THEM.
 *
 * This lane's HUNT for 2026-09-04 found one structural defect, and it was on
 * the renderer side of the seam this file guards (src/views/computers.js
 * performRewind() never told the tree store's sibling, sessionThreadIds,
 * about the forked thread a rewind moves a session onto -- fixed on
 * page2/tree-store, tools/test/rewind-thread-persists.test.mjs). Inside THIS
 * module -- register/unregister, liveAt, supersede, manager resolution,
 * sameTree -- three paths were traced hard enough to be worth a name and a
 * quote, and none of them turned up a behaviour that contradicts what this
 * file already says about itself. They are pinned here instead of asserted
 * from memory.
 *
 * A SECOND HUNT, ALSO 2026-09-04 (a later rotation), found a second
 * structural defect, again on the renderer side: src/fleet-trees.js refused
 * a nameOrdinal for any node whose canvas role was left blank, so a
 * blank-role circle's DRAWN name was permanently stuck on the unstable
 * peer-count fallback nameOrdinal exists to retire for every other role --
 * it silently renamed ("Agent" -> "Agent 1") the moment a second blank-role
 * circle joined the SAME TREE, anywhere in it. A child briefed with the old
 * name before that moment then addressed a manager this directory could no
 * longer find under that string -- TREE_MANAGER_UNREGISTERED for a manager
 * that never stopped running (fixed on page2/tree-store,
 * tools/test/tree-edges-name-stability.test.mjs). PATH 4 below is what that
 * fix's safety rests on: THIS module's own answer when a live session
 * re-registers under a changed name, which is the mechanism the app fix
 * leans on implicitly and had never been driven directly.
 *
 * AN AUDIT OF THAT SAME ROTATION (still 2026-09-04) re-verified PATH 4 by
 * mutation (reverting its kept-filter's agentId exclusion turns it red alone,
 * as the commit that added it claimed) and then traced one shape PATH 4 does
 * not: a THIRD party. PATH 4 proves the RENAMED row never leaves a ghost of
 * ITSELF standing; it says nothing about a separate CHILD row whose own
 * managerName field still names the OLD string. PATH 5 traces that directly
 * and finds this module is not what protects it -- shell/agent-host.cjs
 * never supplies managerSessionId on any call site, so manager resolution is
 * name-only in production, unconditionally, and a child's cached managerName
 * is never revisited by anyone else's registerNode() write. What actually
 * keeps a live rename from orphaning an existing child is traced to the
 * OTHER side of this seam: src/views/computers.js syncTreeBranchAddresses(),
 * which re-registers every live descendant of a moved or detached branch,
 * not only the node that moved. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');

function directoryFor(t, options = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-directory-risk-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return createTreeNodeDirectory({ file: path.join(workspace, 'tree-nodes.json'), ...options });
}

/* ---------------------------------------------------------------------------
 * PATH 1 -- heartbeatNode ON A ROW THAT IS NOT THERE.
 *
 *   function heartbeatNode({ sessionId } = {}) {
 *     const agentId = agentIdForSession(sessionId);
 *     const at = currentTime();
 *     let found = false;
 *     mutate(record => ({
 *       version: SCHEMA_VERSION,
 *       nodes: record.nodes.map(node => {
 *         if (node.agentId !== agentId) return node;
 *         found = true;
 *         return { ...node, heartbeatAt: at };
 *       })
 *     }));
 *     return Object.freeze({ agentId, found });
 *   }
 *
 * shell/agent-host.cjs pumpTreeSessionOnce() calls this every
 * TREE_HEARTBEAT_MS and discards the answer inside a bare try/catch --
 * `found` is never read there. THE RISK: if a session's own row is ever gone
 * (reaped past STOPPED_RETENTION_MS, or -- theoretically -- superseded by
 * another registration sharing its name and tree while its own heartbeat had
 * lapsed) the host has no signal at all that its heartbeats are landing
 * nowhere; it would keep believing the courier is proof of life. That risk is
 * shell/agent-host.cjs's to close, not this module's -- but it can only be
 * closed safely if THIS function's answer for a missing row stays exactly
 * what is pinned below: a harmless no-op that reports itself honestly and
 * invents nothing. A "helpful" future version that re-created a row from a
 * bare heartbeat would fabricate an entry with no nodeName, no manager, no
 * treeKey -- unaddressable by anyone, and indistinguishable from a real
 * registration to every reader in this file. */
test('PIN: a heartbeat for a session with no row is a harmless no-op, never a fabricated row', t => {
  const directory = directoryFor(t);
  directory.registerNode({ sessionId: 'known', nodeName: 'Manager' });

  const answer = directory.heartbeatNode({ sessionId: 'never-registered' });
  assert.deepEqual(answer, { agentId: directory.agentIdForSession('never-registered'), found: false, live: false });

  const rows = directory.listNodes();
  assert.equal(rows.length, 1, 'a heartbeat for an unknown session must not add a row');
  assert.equal(rows[0].sessionId, 'known', 'the one real row must be untouched');
});

test('PIN: a heartbeat for a row already reaped past STOPPED_RETENTION_MS is the same harmless no-op', t => {
  let now = 1_000_000;
  const { STOPPED_RETENTION_MS } = require('../../src/lib/agent-comms/tree-node-directory');
  const directory = directoryFor(t, { now: () => now });
  directory.registerNode({ sessionId: 'gone', nodeName: 'Manager' });
  directory.unregisterNode({ sessionId: 'gone' });
  now += STOPPED_RETENTION_MS + 1;
  /* Nothing has mutated since the stop, so the reaping filter in
     registerNode/unregisterNode has not run yet -- the row is still in the
     file, only now provably expired. A second session registers to trigger
     the sweep, exactly as production would (some OTHER circle starting). */
  directory.registerNode({ sessionId: 'someone-else', nodeName: 'Worker' });
  assert.equal(directory.listNodes().some(node => node.sessionId === 'gone'), false, 'the expired row must already be swept');

  const answer = directory.heartbeatNode({ sessionId: 'gone' });
  assert.equal(answer.found, false);
  assert.equal(directory.listNodes().length, 1, 'heartbeating a reaped session must not resurrect its row');
});

/* ---------------------------------------------------------------------------
 * PATH 2 -- supersededByCircle REQUIRES BOTH ROWS TO NAME A TREE, AND THE
 * EXISTING SUITE ONLY DROVE THAT REQUIREMENT FROM ONE SIDE.
 *
 *   function supersededByCircle(entry, incoming, isLive) {
 *     if (entry.agentId === incoming.agentId) return false;
 *     if (typeof entry.treeKey !== 'string' || typeof incoming.treeKey !== 'string') return false;
 *     if (entry.treeKey !== incoming.treeKey) return false;
 *     if (nameKey(entry.nodeName) !== nameKey(incoming.nodeName)) return false;
 *     return !isLive(entry);
 *   }
 *
 * tree-directory-restart-supersedes-stale-rows.test.js already proves an OLD
 * row registered WITHOUT a treeKey survives a same-named restart that DOES
 * supply one ("manager-keyless" there). The reverse was never driven: an OLD
 * row that DOES carry a treeKey, restarted by a registration that happens to
 * arrive WITHOUT one. THE RISK: `typeof entry.treeKey !== 'string' ||
 * typeof incoming.treeKey !== 'string'` bails on EITHER side missing the
 * field, so this direction is symmetric with the tested one by construction
 * -- but "by construction" is exactly the kind of claim this file's own
 * comment says a hand-editable, cross-version file must not be trusted on
 * faith. Driven here: the surviving pair reproduces the SAME shape the
 * restart fix exists to prevent -- one circle answering "reachable" and
 * "registered-but-session-stopped" at once -- which is why this is pinned
 * rather than waved through. It is NOT a reopening of that bug: this module's
 * own header documents a row with no tree key as "another circle's history,"
 * on purpose, for compatibility with a row an older payload or a caller that
 * dropped requestKeys left behind, and this pin is what makes that an
 * explicit, checked claim instead of an assumption resting on the other
 * direction's test. */
test('PIN: a same-named restart that arrives without a treeKey does not retire an old row that had one -- documented, not a regression of the restart fix', t => {
  let now = 1_900_000_000_000;
  const directory = directoryFor(t, { now: () => now, liveWindowMs: 90_000 });

  const manager1 = directory.registerNode({ sessionId: 'manager-1', nodeName: 'Manager', treeKey: 'tree-root' });
  directory.registerNode({ sessionId: 'worker-1', nodeName: 'Worker', managerName: 'Manager', treeKey: 'tree-root' });
  directory.unregisterNode({ sessionId: 'manager-1' });
  now += 1_000;
  /* The restart's own registration omits treeKey -- an older caller, or one
     that dropped requestKeys -- unlike every test elsewhere in this suite. */
  const manager2 = directory.registerNode({ sessionId: 'manager-2', nodeName: 'Manager' });

  const rows = directory.listNodes().filter(node => node.nodeName === 'Manager');
  assert.equal(rows.length, 2, 'the keyed stopped row is kept beside the keyless new one -- this module never merges across a missing treeKey, in either direction');

  now += 1_000;
  directory.heartbeatNode({ sessionId: 'worker-1' });
  const roster = directory.reachabilityFrom({ from: 'Worker' });
  /* THE TWO ROWS ARE NOW TELLABLE APART (T138). This pin's whole subject is one
     circle appearing under both headings at once; before the roster carried an
     address the two entries were identical strings, and a caller had no way to
     say which one it meant. They carry different addresses, and the reachable
     one is the live restart. */
  assert.deepEqual(roster.reachable, [{ nodeName: 'Manager', agentId: manager2.agentId, relation: 'manager',
    treeKey: null, lastSeenAt: 1_900_000_001_000, transient: false }]);
  assert.notEqual(manager1.agentId, manager2.agentId);
  assert.deepEqual(roster.unavailable, [{
    nodeName: 'Manager', agentId: manager1.agentId, relation: 'manager', status: 'registered-but-session-stopped', code: 'TREE_RECIPIENT_NOT_RUNNING',
    // T255: stopped but within retention and not superseded, so a message wakes it.
    wakeable: true,
    treeKey: 'tree-root', lastSeenAt: 1_900_000_000_000, transient: false,
  }], 'one circle is listed as both reachable and stopped at once -- the exact shape the restart fix removed for a MATCHED treeKey pair, left standing here because a treeKey went missing on only one side. Refute this pin (not the restart fix) if that is ever judged worth closing.');
});

/* ---------------------------------------------------------------------------
 * PATH 3 -- unresolvedManager, HEALED ON READ FROM AN UNFILTERED NODE LIST,
 * CANNOT TURN INTO A WRONGLY-ACCEPTED DELIVERY.
 *
 *   function unresolvedManager(sender, nodes) {
 *     if (!sender.managerName) return null;
 *     const managerKey = nameKey(sender.managerName);
 *     return nodes.some(node => node.agentId !== sender.agentId
 *       && sameTree(sender, node)
 *       && (node.agentId === sender.managerAgentId || nameKey(node.nodeName) === managerKey))
 *       ? null : sender.managerName;
 *   }
 *
 * readRecord() calls this over `parsed.nodes` -- the FULL list straight off
 * disk, never filtered by expired() the way registerNode/unregisterNode's
 * `kept` filter is. THE RISK traced: a manager whose only matching row is
 * hours past STOPPED_RETENTION_MS and not yet swept (nothing has mutated the
 * file since) still counts as "resolved" here, so TREE_MANAGER_UNREGISTERED
 * is not the refusal a child gets for addressing it. What is pinned is the
 * stronger claim that matters to a person at the keyboard: this can only
 * soften WHICH refusal code and sentence a stale manager produces, never
 * which OUTCOME. isLive() gates delivery on the live heartbeat window
 * independently and unconditionally, on every read, so the same stale row
 * still answers TREE_RECIPIENT_NOT_RUNNING -- true, and actionable -- rather
 * than being accepted for delivery into a spool nobody drains. */
test('PIN: an ancient manager heartbeat still refuses delivery and is reported as overdue', t => {
  let now = 1_000_000;
  const { STOPPED_RETENTION_MS } = require('../../src/lib/agent-comms/tree-node-directory');
  const directory = directoryFor(t, { now: () => now, liveWindowMs: 90_000 });

  /* No unregisterNode: this is the crash shape -- heartbeats simply stop. */
  const crashed = directory.registerNode({ sessionId: 'manager-crashed', nodeName: 'Manager' });
  directory.registerNode({ sessionId: 'worker-1', nodeName: 'Worker', managerName: 'Manager' });
  now += STOPPED_RETENTION_MS * 3;
  directory.heartbeatNode({ sessionId: 'worker-1' });

  /* read() -> readRecord() never swept the ancient row (nothing has mutated
     since); it is still present, unresolvedManager() still calls it a match. */
  assert.equal(directory.listNodes().some(node => node.sessionId === 'manager-crashed'), true,
    'the ancient row must still be on disk for this pin to test what it claims to')

  const roster = directory.reachabilityFrom({ from: 'Worker' });
  assert.equal(roster.ok, true, 'the manager resolves by name, so this is not TREE_MANAGER_UNREGISTERED');
  assert.deepEqual(roster.unavailable, [{
    nodeName: 'Manager', agentId: crashed.agentId, relation: 'manager', status: 'heartbeat-overdue', code: 'TREE_RECIPIENT_NOT_RUNNING',
    /* T255: an OVERDUE heartbeat is wakeable in general -- a crashed circle is
       the one a person most needs to reach -- but this pin's row is ANCIENT,
       past STOPPED_RETENTION_MS, so it no longer describes anything startable
       and reads false. Measured: asserting true here failed with wakeable:
       false, which is the retention boundary doing its job on the roster as
       well as on the delivery path. */
    wakeable: false,
    treeKey: null, lastSeenAt: 1_000_000, transient: true,
  }]);
  assert.deepEqual(roster.reachable, [], 'an ancient, unswept row must never be offered as a live recipient');

  const delivery = directory.resolveDelivery({ from: 'Worker', to: 'Manager' });
  assert.equal(delivery.ok, false);
  assert.equal(delivery.code, 'TREE_RECIPIENT_NOT_RUNNING',
    'a message to a manager stale for hours must refuse as stopped, never be accepted into a spool nobody will ever drain');
});

/* ---------------------------------------------------------------------------
 * PATH 4 -- A LIVE SESSION THAT RE-REGISTERS UNDER A CHANGED NAME REPLACES
 * ITS OWN ROW, NEVER STANDS BESIDE IT AS A GHOST.
 *
 *   mutate(record => {
 *     const kept = record.nodes.filter(node => node.agentId !== agentId
 *       && !expired(node, at)
 *       && !supersededByThread(node, entry.threadId)
 *       && !supersededByCircle(node, entry, candidate => isLive(candidate, at)));
 *     ...
 *
 * WHY THIS IS TRACED NOW. src/fleet-trees.js's nodeDisplayName computed a
 * circle's drawn name fresh on every call for a blank canvas role -- see the
 * header above -- and that name is exactly the `nodeName` this module
 * registers a session under (shell/agent-host.cjs attemptTreeRegistration /
 * updateTreeAddress, both keyed on `session.sessionId`, i.e. one fixed
 * agentId for that session's whole life). THE RISK a fix living entirely in
 * the renderer implicitly depends on: if a session's NAME ever does change
 * between two registrations -- the exact shape a display-name bug produces,
 * and also the ordinary shape of a live drag-rename Page 2 already supports
 * -- does the OLD name's row survive as a second, stale entry answering to
 * both names at once, or does the SAME row simply wear the new one?
 *
 * The kept-filter above answers unconditionally, and by SESSION IDENTITY
 * alone: `node.agentId !== agentId` drops any existing row for this exact
 * session BEFORE the name comparison in supersededByCircle is ever reached
 * -- a rename is not a name-based decision at all here, it is the ordinary
 * one-row-per-session replacement every registration already performs. This
 * is what makes the app-side name-stability fix a full fix rather than a
 * half one: even on a build old enough to have shipped the drawn-name bug,
 * this directory itself was never at risk of accumulating a duplicate,
 * unreachable row FOR THE RENAMED CIRCLE. The blast radius the app bug had
 * was confined to what THIS pin's sibling (PATH 3) already describes for a
 * different cause -- a THIRD party's frozen reference to the old string --
 * never to this module inventing a phantom second circle of its own. */
test('PIN: a live session re-registering under a changed name replaces its own row, not a second one beside it', t => {
  let now = 1_900_000_000_000;
  const directory = directoryFor(t, { now: () => now, liveWindowMs: 90_000 });

  directory.registerNode({ sessionId: 'circle-session', nodeName: 'Agent', treeKey: 'tree-root' });
  assert.equal(directory.listNodes().length, 1);

  now += 1_000;
  /* Same session, same tree, ONLY the name differs -- the shape a shifting
     display-name computation (or an ordinary live rename) produces. */
  const renamed = directory.registerNode({ sessionId: 'circle-session', nodeName: 'Agent 1', treeKey: 'tree-root' });

  const rows = directory.listNodes();
  assert.equal(rows.length, 1,
    'a session that re-registered under a new name left a ghost row under its old one');
  assert.equal(rows[0].nodeName, 'Agent 1');
  assert.equal(rows[0].agentId, renamed.agentId, 'one session, one durable identity, across the rename');

  /* The old name is not merely unlisted -- it is gone as an address. A
     caller still holding it (this pin's sibling, PATH 3's counterpart on
     the other side) gets the SAME honest refusal a genuinely unregistered
     name would, never a stale delivery. */
  assert.equal(directory.resolveDelivery({ from: 'Agent', to: 'Agent 1' }).code, 'TREE_SENDER_UNKNOWN');
  assert.equal(directory.resolveDelivery({ from: 'Agent 1', to: 'Agent' }).code, 'TREE_RECIPIENT_UNKNOWN');
});

/* ---------------------------------------------------------------------------
 * PATH 5 -- A CHILD'S CACHED managerName IS A SNAPSHOT, NOT A LIVE POINTER TO
 * ITS MANAGER'S ROW; ONLY THE RENAMED ROW ITSELF IS PROTECTED BY PATH 4.
 *
 * See the file header above ("AN AUDIT OF THAT SAME ROTATION...") for why
 * this was traced and what it found: registerNode() never revisits another
 * row's stored managerName on write, and shell/agent-host.cjs never supplies
 * managerSessionId, so nothing here reconnects a child to its manager's new
 * name on its own. The two states below are both real and both pinned, not
 * asserted: TREE_RECIPIENT_NOT_CONNECTED is what a still-unsynced child gets
 * (mildly misleading -- read it as "unregistered manager" until proven
 * otherwise), and a full resolve in both directions is what a correct sync
 * (src/views/computers.js syncTreeBranchAddresses) is supposed to produce. */
test('PIN: a child\'s edge to its manager heals only once the child\'s own row is re-registered with the manager\'s new name', t => {
  let now = 1_900_100_000_000;
  const directory = directoryFor(t, { now: () => now, liveWindowMs: 90_000 });

  directory.registerNode({ sessionId: 'manager-session', nodeName: 'Agent', treeKey: 'tree-root' });
  directory.registerNode({
    sessionId: 'child-session', nodeName: 'Worker', managerName: 'Agent', treeKey: 'tree-root',
  });
  assert.equal(directory.resolveDelivery({ from: 'Worker', to: 'Agent' }).ok, true,
    'sanity: the child can reach its manager before any rename');

  now += 1_000;
  // The manager re-registers under a new name -- the shape PATH 4 covers for
  // the row itself (same sessionId, so this REPLACES the row, never stands a
  // ghost beside it).
  directory.registerNode({ sessionId: 'manager-session', nodeName: 'Agent 1', treeKey: 'tree-root' });

  // BEFORE the child re-registers: the manager's new name IS on the tree
  // (PATH 4), but this child's own row still names the old one, so the edge
  // does not resolve. Pinned as today's actual refusal code, not asserted as
  // correct -- see the header above.
  const beforeChildSync = directory.resolveDelivery({ from: 'Worker', to: 'Agent 1' });
  assert.equal(beforeChildSync.ok, false);
  assert.equal(beforeChildSync.code, 'TREE_RECIPIENT_NOT_CONNECTED',
    'an unsynced child addressing its renamed manager gets "not connected", not "unregistered" -- the new name is on the tree, just not yet this child\'s row');

  // AFTER the child re-registers with the manager's current name -- exactly
  // what src/views/computers.js syncTreeBranchAddresses does for every live
  // descendant of a moved or detached branch -- the edge is whole again in
  // both directions. The old word is now a unique shorthand for the new name;
  // it must resolve to that same row, never a second manager.
  now += 1_000;
  directory.registerNode({
    sessionId: 'child-session', nodeName: 'Worker', managerName: 'Agent 1', treeKey: 'tree-root',
  });
  const healed = directory.resolveDelivery({ from: 'Worker', to: 'Agent 1' });
  assert.equal(healed.ok, true, 'a child re-registered with its manager\'s current name must reach it');
  assert.equal(directory.resolveDelivery({ from: 'Agent 1', to: 'Worker' }).ok, true,
    'the manager must be able to reach the child back, by its own current name');
  const shorthand = directory.resolveDelivery({ from: 'Worker', to: 'Agent' });
  assert.equal(shorthand.ok, true);
  assert.deepEqual(shorthand.recipient, healed.recipient, 'a unique shorthand names the current manager row');
  assert.equal(directory.listNodes().filter(row => row.sessionId === 'manager-session').length, 1);
});

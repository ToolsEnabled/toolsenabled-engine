'use strict';
/* T31. AN ADDRESS THAT DIES WITH A SESSION, AND A REFUSAL THAT DENIES THE
 * AGENT EXISTS.
 *
 * MEASURED 2026-09-15 on this computer's live tree.
 *
 * (1) IDENTITY. agentIdForSession() is sha256(sessionId), so a circle that
 *     moves accounts or is restarted becomes a DIFFERENT agent to this
 *     subsystem and its old address is gone. The Controller's node was
 *     tree-e60571a0… until 07:12Z and tree-4b31cd18… from 07:13Z. Anything
 *     addressed to the old id afterwards resolves to nothing, and a message
 *     already spooled under it can never be drained, because no live row will
 *     ever carry that id again.
 *
 *     The stable identity already exists: every one of the 19 live rows
 *     carries a nodeKey (node-7-da02fefa-…), registerNode() already inherits
 *     it across a replacement and already refuses a mismatch. What was missing
 *     was the trail from the retired address to the circle that continues it.
 *
 *     THIS IS NOT A RE-KEYING. Existing agentIds are unchanged, so nothing in
 *     flight breaks and no stored id is migrated. A replaced row is kept as a
 *     tombstone naming its successor, swept by the same retention a stopped
 *     row already gets.
 *
 * (2) NAMING. Two Controllers are registered here, "Controller (850c7379)" in
 *     the math tree and "Controller (da02fefa)" in ours, and neither is named
 *     plainly "Controller". Addressing "Controller" therefore matched no row
 *     and answered "No agent called "Controller" is registered on this
 *     computer's tree" -- false, and in the one situation where the person
 *     most needs it to be true. The math tree's manager, reading its roster,
 *     sent to the Controller in its OWN tree instead of the linked one.
 *
 *     So: a bare name that uniquely prefixes one reachable row resolves to it;
 *     a genuine ambiguity is still refused by name; and a name that matches
 *     nothing says which rows were near, instead of denying they exist.
 *
 *   node --test tests/tree-directory-identity-and-naming.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTreeNodeDirectory, agentIdForSession } = require('../src/lib/agent-comms/tree-node-directory.js');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'tree-nodes.json');
}

/* A clock the test drives, and a pid probe that keeps every row's process
   "alive" so liveness turns only on the heartbeat this test controls. */
function directory(t, { now = () => 1_000 } = {}) {
  return createTreeNodeDirectory({ file: scratch(t), now, pidIsAlive: () => true });
}

const MANAGER = { sessionId: 'session-manager-1', nodeName: 'Manager', nodeKey: 'node-1-manager', treeKey: 'node-1-manager' };

function suffixDrift(t, { addressed = false, now = () => 1_000 } = {}) {
  const dir = directory(t, { now });
  const old = { sessionId: 'controller-before', nodeName: 'Controller (da02fefa)', nodeKey: 'saved-controller', treeKey: 'root' };
  const child = { sessionId: 'report', nodeName: 'Builder', nodeKey: 'saved-builder', treeKey: 'root',
    managerName: old.nodeName, ...(addressed ? { managerSessionId: old.sessionId } : {}) };
  dir.registerNode(old);
  dir.registerNode(child);
  dir.unregisterNode({ sessionId: old.sessionId });
  // This is the app continuation shape: stable nodeKey, no replacesSessionId,
  // and the renderer has dropped the disambiguation suffix from the label.
  const current = { ...old, sessionId: 'controller-after', nodeName: 'Controller' };
  dir.registerNode(current);
  return { dir, old, child, current };
}

for (const addressed of [false, true]) test(`suffix drift preserves both directions for ${addressed ? 'addressed' : 'name-only'} reports`, t => {
  const { dir, old, child, current } = suffixDrift(t, { addressed });
  for (const to of [current.nodeName, old.nodeName, agentIdForSession(old.sessionId)]) {
    const sent = dir.resolveDelivery({ from: child.nodeName, to, senderSessionId: child.sessionId });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.recipient.sessionId, current.sessionId);
    assert.equal(sent.relation, 'manager');
  }
  const reply = dir.resolveDelivery({ from: current.nodeName, to: child.nodeName, senderSessionId: current.sessionId });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.relation, 'reports-to-sender');
  const roster = dir.reachabilityFrom({ from: child.nodeName, senderSessionId: child.sessionId });
  assert.deepEqual(roster.reachable.map(row => [row.nodeName, row.relation]), [['Controller', 'manager']]);
  assert.deepEqual(roster.unavailable, []);
  assert.equal(dir.listNodes().find(row => row.sessionId === child.sessionId).managerUnresolved, null);
});

test('a report re-registering its stale manager label keeps the same saved manager', t => {
  const { dir, child, current } = suffixDrift(t);
  dir.registerNode(child);
  const sent = dir.resolveDelivery({ from: child.nodeName, to: current.nodeName, senderSessionId: child.sessionId });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.recipient.sessionId, current.sessionId);
});

test('an explicit reparent is not undone when the old manager loses its suffix', t => {
  const { dir, child, current } = suffixDrift(t);
  dir.registerNode({ sessionId: 'different-manager', nodeName: 'Other', treeKey: 'root', nodeKey: 'other-node' });
  dir.registerNode({ ...child, managerName: 'Other', managerSessionId: 'different-manager' });
  assert.equal(dir.resolveDelivery({ from: child.nodeName, to: current.nodeName, senderSessionId: child.sessionId }).ok, false);
  assert.equal(dir.resolveDelivery({ from: child.nodeName, to: 'Other', senderSessionId: child.sessionId }).ok, true);
});

test('a different stable circle using the bare manager name cannot adopt the reports', t => {
  const dir = directory(t);
  dir.registerNode({ sessionId: 'old', nodeName: 'Controller (da02fefa)', nodeKey: 'old-circle', treeKey: 'root' });
  dir.registerNode({ sessionId: 'child', nodeName: 'Builder', managerName: 'Controller (da02fefa)', treeKey: 'root' });
  dir.unregisterNode({ sessionId: 'old' });
  dir.registerNode({ sessionId: 'other', nodeName: 'Controller', nodeKey: 'other-circle', treeKey: 'root' });
  assert.equal(dir.resolveDelivery({ from: 'Builder', to: 'Controller', senderSessionId: 'child' }).ok, false);
});

test('read repair reconnects a legacy name-only report without writing the directory', t => {
  const { dir, child, current } = suffixDrift(t);
  const record = JSON.parse(fs.readFileSync(dir.file, 'utf8'));
  const report = record.nodes.find(row => row.sessionId === child.sessionId);
  report.managerAgentId = null;
  report.managerUnresolved = report.managerName;
  const legacy = JSON.stringify(record);
  fs.writeFileSync(dir.file, legacy);
  const sent = dir.resolveDelivery({ from: child.nodeName, to: current.nodeName, senderSessionId: child.sessionId });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.recipient.sessionId, current.sessionId);
  assert.equal(dir.listNodes().find(row => row.sessionId === child.sessionId).managerUnresolved, null);
  assert.equal(fs.readFileSync(dir.file, 'utf8'), legacy, 'read repair must not acquire a write side effect');
});

test('a reused historical label cannot grant another stable circle the manager edge', t => {
  const { dir, child, current, old } = suffixDrift(t);
  const other = dir.registerNode({ sessionId: 'unrelated', nodeName: old.nodeName, nodeKey: 'unrelated-circle', treeKey: 'root' });
  assert.equal(dir.resolveDelivery({ from: child.nodeName, to: other.agentId, senderSessionId: child.sessionId }).ok, false);
  assert.equal(dir.resolveDelivery({ from: other.nodeName, to: child.nodeName, senderSessionId: other.sessionId }).ok, false);
  assert.equal(dir.resolveDelivery({ from: child.nodeName, to: current.nodeName, senderSessionId: child.sessionId }).ok, true);
});

test('a cached registration retains its established manager after the alias expires', t => {
  let at = 1_000;
  const { dir, child, current } = suffixDrift(t, { now: () => at });
  at += 60 * 60 * 1_000 + 1;
  dir.heartbeatNodes([{ sessionId: child.sessionId }, { sessionId: current.sessionId }]);
  dir.registerNode(child);
  const sent = dir.resolveDelivery({ from: child.nodeName, to: current.nodeName, senderSessionId: child.sessionId });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.recipient.sessionId, current.sessionId);
});

test('an expired legacy alias cannot establish a new manager binding on a read', t => {
  let at = 1_000;
  const { dir, child, current } = suffixDrift(t, { now: () => at });
  at += 60 * 60 * 1_000 + 1;
  const record = JSON.parse(fs.readFileSync(dir.file, 'utf8'));
  for (const row of record.nodes) {
    if (row.sessionId === child.sessionId || row.sessionId === current.sessionId) row.heartbeatAt = at;
    if (row.sessionId === child.sessionId) row.managerAgentId = null;
  }
  fs.writeFileSync(dir.file, JSON.stringify(record));
  assert.equal(dir.resolveDelivery({ from: child.nodeName, to: current.nodeName, senderSessionId: child.sessionId }).ok, false);
});

function registerManager(dir) {
  dir.registerNode(MANAGER);
  return agentIdForSession(MANAGER.sessionId);
}

/* ------------------------------------------------------------------ *
 * (1) IDENTITY SURVIVES A SESSION REPLACEMENT
 * ------------------------------------------------------------------ */

test('a message addressed to a retired agentId reaches the circle that continued it', (t) => {
  const dir = directory(t);
  registerManager(dir);
  const first = 'session-worker-before';
  const second = 'session-worker-after';
  dir.registerNode({ sessionId: first, nodeName: 'Worker', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-2-worker', treeKey: 'node-1-manager' });
  const oldAgentId = agentIdForSession(first);

  // The circle moves accounts: a NEW session, the SAME saved circle.
  dir.registerNode({ sessionId: second, nodeName: 'Worker', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-2-worker', treeKey: 'node-1-manager', replacesSessionId: first });
  const newAgentId = agentIdForSession(second);
  assert.notEqual(oldAgentId, newAgentId, 'the replacement must genuinely have a new address, or this proves nothing');

  const resolved = dir.resolveDelivery({ from: 'Manager', to: oldAgentId, senderSessionId: MANAGER.sessionId });
  assert.equal(resolved.ok, true,
    `a delivery addressed to the retired id must be answered, not refused: ${JSON.stringify(resolved)}`);
  assert.equal(resolved.recipient.agentId, newAgentId,
    `it must land on the circle that continued, not the retired session: ${JSON.stringify(resolved)}`);
  assert.equal(resolved.recipient.sessionId, second, 'and on the live session, so a reply goes somewhere real');
});

test('successorOf answers the same question for a caller holding only the old address', (t) => {
  const dir = directory(t);
  registerManager(dir);
  dir.registerNode({ sessionId: 's1', nodeName: 'Worker', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-2-worker' });
  dir.registerNode({ sessionId: 's2', nodeName: 'Worker', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-2-worker', replacesSessionId: 's1' });

  assert.equal(dir.successorOf(agentIdForSession('s1')), agentIdForSession('s2'),
    'a spool entry keyed by the retired id must be re-keyable without guessing');
  assert.equal(dir.successorOf(agentIdForSession('s2')), null,
    'a live address has no successor, and must not report one');
  assert.equal(dir.successorOf('tree-nosuchagentidatall'), null, 'an unknown address has no successor');
});

test('a circle that simply stopped is NOT given a successor, so a stop still reads as a stop', (t) => {
  const dir = directory(t);
  registerManager(dir);
  dir.registerNode({ sessionId: 's1', nodeName: 'Worker', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-2-worker' });
  dir.unregisterNode({ sessionId: 's1' });

  assert.equal(dir.successorOf(agentIdForSession('s1')), null,
    'nothing continued this circle, so nothing may claim its messages');
  /* T255. "A stop still reads as a stop" is still the subject and is still
     pinned -- by successorOf above, and by recipientStopped below. The send is
     no longer refused, because a stopped circle is now held for a wake; what
     must not happen is the stop being papered over as a continuation. So this
     asserts the message resolves to the circle's OWN retired address and NOT
     through a successor, which is the "nothing may claim its messages" rule
     stated on the delivery path rather than only on the lookup. */
  const resolved = dir.resolveDelivery({ from: 'Manager', to: 'Worker', senderSessionId: MANAGER.sessionId });
  assert.equal(resolved.ok, true, 'a stopped circle is addressable so its message can be held for a wake');
  assert.equal(resolved.recipientStopped, true,
    `a stop must still read as a stop, not as a running recipient: ${JSON.stringify(resolved)}`);
  assert.equal(resolved.recipient.agentId, agentIdForSession('s1'),
    'it resolved to the stopped circle itself, not to some other row claiming its messages');
  assert.equal(resolved.succeeded, undefined,
    'nothing continued this circle, so the delivery must not report a succession');
});

/* ------------------------------------------------------------------ *
 * (2) NAMING
 * ------------------------------------------------------------------ */

test('a bare name that uniquely prefixes one reachable circle resolves to it', (t) => {
  const dir = directory(t);
  registerManager(dir);
  dir.registerNode({ sessionId: 's-ctrl', nodeName: 'Controller (da02fefa)', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-7-controller' });

  const resolved = dir.resolveDelivery({ from: 'Manager', to: 'Controller', senderSessionId: MANAGER.sessionId });
  assert.equal(resolved.ok, true,
    `one reachable Controller and a bare "Controller" is not ambiguous; it must resolve: ${JSON.stringify(resolved)}`);
  assert.equal(resolved.recipient.nodeName, 'Controller (da02fefa)');
});

test('two reachable circles sharing a base name are REFUSED, not guessed between', (t) => {
  const dir = directory(t);
  registerManager(dir);
  dir.registerNode({ sessionId: 's-a', nodeName: 'Controller (aaaaaaaa)', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-a' });
  dir.registerNode({ sessionId: 's-b', nodeName: 'Controller (bbbbbbbb)', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-b' });

  const resolved = dir.resolveDelivery({ from: 'Manager', to: 'Controller', senderSessionId: MANAGER.sessionId });
  assert.equal(resolved.ok, false, 'guessing between two Controllers is exactly what must not happen');
  assert.equal(resolved.code, 'TREE_RECIPIENT_AMBIGUOUS', JSON.stringify(resolved));
  assert.match(resolved.message, /Controller \(aaaaaaaa\)/, 'the refusal must name the candidates so the sender can pick');
  assert.match(resolved.message, /Controller \(bbbbbbbb\)/, JSON.stringify(resolved));
});

test('an exact full name still wins outright, even while a second circle shares its base name', (t) => {
  const dir = directory(t);
  registerManager(dir);
  dir.registerNode({ sessionId: 's-a', nodeName: 'Controller (aaaaaaaa)', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-a' });
  dir.registerNode({ sessionId: 's-b', nodeName: 'Controller (bbbbbbbb)', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-b' });

  const resolved = dir.resolveDelivery({ from: 'Manager', to: 'Controller (bbbbbbbb)', senderSessionId: MANAGER.sessionId });
  assert.equal(resolved.ok, true, `an exact name is never ambiguous: ${JSON.stringify(resolved)}`);
  assert.equal(resolved.recipient.nodeName, 'Controller (bbbbbbbb)');
});

test('a name that matches nothing names the near rows instead of denying they exist', (t) => {
  const dir = directory(t);
  registerManager(dir);
  dir.registerNode({ sessionId: 's-a', nodeName: 'Controller (aaaaaaaa)', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-a' });

  const resolved = dir.resolveDelivery({ from: 'Manager', to: 'Contoller', senderSessionId: MANAGER.sessionId });
  assert.equal(resolved.ok, false);
  assert.doesNotMatch(resolved.message, /^No agent called "Contoller" is registered on this computer's tree\.$/,
    'a flat denial sends the person hunting for a typo in the wrong place');
  assert.match(resolved.message, /Controller \(aaaaaaaa\)/,
    `the refusal must show what IS reachable: ${JSON.stringify(resolved)}`);
});

/* ------------------------------------------------------------------ *
 * (3) THE ROSTER SHOWS RELATION AND TREE
 * ------------------------------------------------------------------ */

test('roster rows carry relation and tree, and a linked peer is marked as one', (t) => {
  const dir = directory(t);
  registerManager(dir);
  dir.registerNode({ sessionId: 's-own', nodeName: 'Controller (mine)', managerSessionId: MANAGER.sessionId,
    managerName: 'Manager', nodeKey: 'node-own', treeKey: 'node-1-manager' });
  // A circle in ANOTHER tree, reachable only because the person drew a link.
  dir.registerNode({ sessionId: 's-far', nodeName: 'Controller (theirs)', nodeKey: 'node-far', treeKey: 'node-far' });
  dir.setLink({ from: 'node-1-manager', to: 'node-far' });

  const rows = dir.reachabilityFrom({ from: 'Manager', senderSessionId: MANAGER.sessionId }).reachable;
  const byName = name => rows.find(row => row.nodeName === name);

  const own = byName('Controller (mine)');
  assert.ok(own, `the same-tree Controller must be reachable: ${JSON.stringify(rows)}`);
  assert.equal(own.relation, 'reports-to-sender', `its relation must say it reports to the sender: ${JSON.stringify(own)}`);
  assert.equal(own.treeKey, 'node-1-manager', 'and name the tree it belongs to');

  const far = byName('Controller (theirs)');
  assert.ok(far, `the linked Controller must be reachable: ${JSON.stringify(rows)}`);
  assert.equal(far.relation, 'linked-agent',
    `a linked peer must be MARKED as one, or a sender cannot tell the two Controllers apart: ${JSON.stringify(far)}`);
  assert.equal(far.treeKey, 'node-far', 'and its own tree must be visible beside it');
});

test('a retired address cannot forward outside its saved circle', t => {
  let at = 1000;
  const dir = directory(t, { now: () => at });
  dir.registerNode({ sessionId: 'first', nodeName: 'Worker', nodeKey: 'circle' });
  const replacement = dir.registerNode({ sessionId: 'second', nodeName: 'Worker', nodeKey: 'circle', replacesSessionId: 'first' });
  const other = dir.registerNode({ sessionId: 'other', nodeName: 'Other', nodeKey: 'other-circle' });
  const original = fs.readFileSync(dir.file, 'utf8');
  const record = JSON.parse(original);
  record.nodes.find(row => row.sessionId === 'first').supersededBy = other.agentId;
  fs.writeFileSync(dir.file, JSON.stringify(record));
  assert.equal(dir.successorOf(agentIdForSession('first')), null, 'a different nodeKey cannot inherit messages');
  fs.writeFileSync(dir.file, original);
});

test('a retired address stops forwarding at retention expiry even without a sweep', t => {
  let at = 1000;
  const dir = directory(t, { now: () => at });
  dir.registerNode({ sessionId: 'first', nodeName: 'Worker', nodeKey: 'circle' });
  dir.registerNode({ sessionId: 'second', nodeName: 'Worker', nodeKey: 'circle', replacesSessionId: 'first' });
  at += 60 * 60 * 1000 + 1;
  dir.heartbeatNode({ sessionId: 'second' });
  assert.equal(dir.successorOf(agentIdForSession('first')), null, 'retention applies on reads, without requiring a sweep');
});

test('an exact replacement inherits the saved circle when an older caller omits nodeKey', t => {
  const dir = directory(t);
  dir.registerNode({ sessionId: 'first', nodeName: 'Worker', nodeKey: 'circle' });
  const next = dir.registerNode({ sessionId: 'second', nodeName: 'Worker', replacesSessionId: 'first' });
  assert.equal(next.nodeKey, 'circle');
  assert.equal(dir.successorOf(agentIdForSession('first')), next.agentId);
});

test('a roster distinguishes a lapsed heartbeat from a stopped session and hides replaced rows', t => {
  let at = 1000;
  const dir = directory(t, { now: () => at });
  registerManager(dir);
  const worker = dir.registerNode({ sessionId: 'first', nodeName: 'Worker', nodeKey: 'circle', managerName: 'Manager' });
  at += 90_001;
  dir.heartbeatNode({ sessionId: MANAGER.sessionId });
  let rows = dir.reachabilityFrom({ from: 'Manager' });
  assert.equal(rows.unavailable[0].transient, true);
  assert.equal(rows.unavailable[0].lastSeenAt, worker.heartbeatAt);
  dir.unregisterNode({ sessionId: 'first' });
  rows = dir.reachabilityFrom({ from: 'Manager' });
  assert.equal(rows.unavailable[0].transient, false);
  dir.registerNode({ sessionId: 'second', nodeName: 'Worker', nodeKey: 'circle', managerName: 'Manager', replacesSessionId: 'first' });
  rows = dir.reachabilityFrom({ from: 'Manager' });
  assert.equal(rows.reachable.length, 1);
  assert.equal(rows.unavailable.length, 0, 'the retired row is an address alias, not another stopped agent');
  assert.equal(rows.reachable[0].transient, false);
  assert.equal(dir.listNodes().length, 2, 'aliases do not create phantom agents for existing readers');
});

test('a replacement is not listed as reachable and stopped at the same time', t => {
  const dir = directory(t);
  registerManager(dir);
  dir.registerNode({ sessionId: 'first', nodeName: 'Worker', nodeKey: 'circle', managerName: 'Manager' });
  dir.registerNode({ sessionId: 'second', nodeName: 'Worker', nodeKey: 'circle', managerName: 'Manager', replacesSessionId: 'first' });
  const roster = dir.reachabilityFrom({ from: 'Manager' });
  assert.equal(roster.reachable.length, 1);
  assert.equal(roster.unavailable.length, 0);
});

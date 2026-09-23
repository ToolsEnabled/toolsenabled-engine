'use strict';
/* A ROSTER ROW A SENDER CAN ACTUALLY ADDRESS.
 *
 * THE DEFECT, measured 2026-09-16 03:47Z-05:05Z and filed as T138: circles
 * started through `agent.spawn` with surface "tree" registered under bare role
 * names -- four "Manager" rows and sixteen "Worker" rows on one computer.
 * `agent_comms.local_roster` then answered with rows that were identical apart
 * from a heartbeat, because `agentId` was emitted ONLY for a user-linked peer;
 * a manager and a report never carried one. So the only handle a caller had was
 * the name, `agent_comms.send_local` to "Manager" answered
 * TREE_RECIPIENT_AMBIGUOUS, and sending to the TREE NODE ID a spawn returns
 * (node-4-5ef0084f-...) answered TREE_RECIPIENT_UNKNOWN because that is a
 * different identifier entirely. No manager could reach its own workers.
 *
 * WHAT THIS FILE PINS, and why each half is here:
 *
 *   - resolveDelivery() has accepted an agentId as `to` since direct links
 *     landed. That was never the missing piece and it is pinned here so a later
 *     narrowing of the recipient match is caught by a delivery, not by review.
 *   - reachabilityFrom() must put that agentId on EVERY reachable row and every
 *     unavailable one, not just on a linked peer. This is the half that was
 *     missing, and it is the half that makes duplicate names survivable.
 *
 * IT DOES NOT PIN A SPELLING. Nothing here asserts a particular name format --
 * the app's naming fix (src/views/computers.js circleName) is what stops the
 * duplicates arising, and this file deliberately stays green either way, by
 * addressing circles through the id the roster hands out.
 *
 *   node --test tests/agent-comms/tree-roster-agent-id.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTreeNodeDirectory, AGENT_ID_PREFIX } = require('../../src/lib/agent-comms/tree-node-directory.js');

const AT = 1788400000000;

/* A real directory over a scratch file, with a fixed clock so "live" is a fact
   of the fixture rather than of how fast the suite runs. */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-roster-agent-id-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* scratch */ } });
  return createTreeNodeDirectory({ file: path.join(root, 'tree-nodes.json'), now: () => AT });
}

function register(directory, { session, name, manager = null, tree = 't1', nodeKey = null }) {
  return directory.registerNode({
    sessionId: session,
    nodeName: name,
    managerName: manager,
    pid: process.pid,
    treeKey: tree,
    nodeKey,
  });
}

function rowFor(roster, agentId) {
  return roster.find(row => row.agentId === agentId) || null;
}

test('a manager reading its roster is given an address for every report, not only for a linked peer', t => {
  const directory = fixture(t);
  register(directory, { session: 's-controller', name: 'Controller' });
  const first = register(directory, { session: 's-m1', name: 'Manager', manager: 'Controller', nodeKey: 'node-1' });
  const second = register(directory, { session: 's-m2', name: 'Manager 2', manager: 'Controller', nodeKey: 'node-2' });

  const { reachable } = directory.reachabilityFrom({ from: 'Controller', senderSessionId: 's-controller' });

  assert.equal(reachable.length, 2, 'both reports must be reachable');
  for (const row of reachable) {
    assert.equal(typeof row.agentId, 'string', `a reachable row must carry an address: ${JSON.stringify(row)}`);
    assert.ok(row.agentId.startsWith(AGENT_ID_PREFIX), 'the address must be a tree agent identity');
  }
  assert.equal(rowFor(reachable, first.agentId).relation, 'reports-to-sender');
  assert.equal(rowFor(reachable, second.agentId).relation, 'reports-to-sender');
});

test('a report reading its roster is given its manager\'s address too', t => {
  const directory = fixture(t);
  const controller = register(directory, { session: 's-controller', name: 'Controller' });
  register(directory, { session: 's-m1', name: 'Manager', manager: 'Controller', nodeKey: 'node-1' });

  const { reachable } = directory.reachabilityFrom({ from: 'Manager', senderSessionId: 's-m1' });

  const manager = rowFor(reachable, controller.agentId);
  assert.ok(manager, `the manager must appear by address: ${JSON.stringify(reachable)}`);
  assert.equal(manager.relation, 'manager');
});

test('an address the roster offered delivers, and delivers to that circle and no other', t => {
  const directory = fixture(t);
  register(directory, { session: 's-controller', name: 'Controller' });
  const first = register(directory, { session: 's-m1', name: 'Manager', manager: 'Controller', nodeKey: 'node-1' });
  const second = register(directory, { session: 's-m2', name: 'Manager 2', manager: 'Controller', nodeKey: 'node-2' });

  const { reachable } = directory.reachabilityFrom({ from: 'Controller', senderSessionId: 's-controller' });
  for (const row of reachable) {
    const resolved = directory.resolveDelivery({ from: 'Controller', to: row.agentId, senderSessionId: 's-controller' });
    assert.equal(resolved.ok, true, `the roster offered ${row.agentId} and the send refused it: ${resolved.code}`);
    assert.equal(resolved.recipient.agentId, row.agentId, 'the delivery must land on the circle that was addressed');
  }
  const bySession = new Map(reachable.map(row => [row.agentId, row]));
  assert.equal(
    directory.resolveDelivery({ from: 'Controller', to: bySession.get(first.agentId).agentId, senderSessionId: 's-controller' }).recipient.sessionId,
    's-m1');
  assert.equal(
    directory.resolveDelivery({ from: 'Controller', to: bySession.get(second.agentId).agentId, senderSessionId: 's-controller' }).recipient.sessionId,
    's-m2');
});

test('two live circles sharing one name refuse by name and still deliver by address', t => {
  const directory = fixture(t);
  register(directory, { session: 's-controller', name: 'Controller' });
  const first = register(directory, { session: 's-m1', name: 'Manager', manager: 'Controller', nodeKey: 'node-1' });
  const second = register(directory, { session: 's-m2', name: 'Manager', manager: 'Controller', nodeKey: 'node-2' });

  /* The measured refusal. It stays a refusal: guessing between two live
     circles is the thing the directory must never do. */
  const byName = directory.resolveDelivery({ from: 'Controller', to: 'Manager', senderSessionId: 's-controller' });
  assert.equal(byName.ok, false, 'a name two live circles answer to must not resolve');
  assert.equal(byName.code, 'TREE_RECIPIENT_AMBIGUOUS');
  /* AND THE REFUSAL MUST BE ACTIONABLE. Telling a caller to "use the full name"
     when the full names are what collided sends it round the same loop. Every
     candidate is named with the address that separates it. */
  assert.equal(byName.candidateAgents.length, 2);
  for (const candidate of byName.candidateAgents) {
    assert.ok(candidate.agentId.startsWith(AGENT_ID_PREFIX), `a candidate must carry an address: ${JSON.stringify(candidate)}`);
    assert.ok(byName.message.includes(candidate.agentId), 'the sentence must name the address it is asking for');
    assert.equal(
      directory.resolveDelivery({ from: 'Controller', to: candidate.agentId, senderSessionId: 's-controller' }).ok,
      true,
      'an address the refusal offered must deliver');
  }

  /* And the way out of it, which the roster now supplies. */
  const { reachable } = directory.reachabilityFrom({ from: 'Controller', senderSessionId: 's-controller' });
  assert.equal(new Set(reachable.map(row => row.agentId)).size, 2, 'two circles must be told apart on the roster');
  assert.equal(
    directory.resolveDelivery({ from: 'Controller', to: first.agentId, senderSessionId: 's-controller' }).recipient.sessionId,
    's-m1');
  assert.equal(
    directory.resolveDelivery({ from: 'Controller', to: second.agentId, senderSessionId: 's-controller' }).recipient.sessionId,
    's-m2');
});

test('a tree node id is not an agent address, and is refused by name rather than delivered somewhere', t => {
  const directory = fixture(t);
  register(directory, { session: 's-controller', name: 'Controller' });
  register(directory, { session: 's-m1', name: 'Manager', manager: 'Controller', nodeKey: 'node-4-5ef0084f' });

  const refused = directory.resolveDelivery({
    from: 'Controller',
    to: 'node-4-5ef0084f-a232-4dfa-92c4-0430881176e0',
    senderSessionId: 's-controller',
  });

  assert.equal(refused.code, 'TREE_RECIPIENT_UNKNOWN', 'a saved-circle id addresses nobody on the message fabric');
  /* The refusal has to hand the caller something usable, or the next attempt is
     another guess. The reachable list it names is the same list the roster
     returns, so the caller can read an address straight out of the answer. */
  assert.ok(Array.isArray(refused.reachableAgents) && refused.reachableAgents.length > 0,
    `the refusal must name what is reachable instead: ${JSON.stringify(refused)}`);
  for (const row of refused.reachableAgents) {
    assert.ok(row.agentId.startsWith(AGENT_ID_PREFIX), `a reachable row must carry an address: ${JSON.stringify(row)}`);
    assert.ok(refused.message.includes(row.agentId), 'the sentence must hand over the address, not only the name');
    assert.equal(
      directory.resolveDelivery({ from: 'Controller', to: row.agentId, senderSessionId: 's-controller' }).ok,
      true,
      'the way out the refusal offered must actually work');
  }
});

test('a circle whose session has stopped keeps its address on the unavailable list', t => {
  const directory = fixture(t);
  register(directory, { session: 's-controller', name: 'Controller' });
  const worker = register(directory, { session: 's-w1', name: 'Worker', manager: 'Controller', nodeKey: 'node-9' });
  directory.unregisterNode({ sessionId: 's-w1' });

  const { unavailable } = directory.reachabilityFrom({ from: 'Controller', senderSessionId: 's-controller' });

  const row = rowFor(unavailable, worker.agentId);
  assert.ok(row, `a stopped report must still be named by address: ${JSON.stringify(unavailable)}`);
  assert.equal(row.code, 'TREE_RECIPIENT_NOT_RUNNING');
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const { createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');

function setup(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-orphan-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let at = 1_900_000_000_000;
  const tree = createTreeNodeDirectory({
    file: path.join(workspace, 'tree.json'),
    now: () => at,
    liveWindowMs: 100
  });
  return {
    tree,
    provider(runtimeFactory = undefined) {
      return createLocalAgentMessageProvider({
        directory: tree,
        now: () => at,
        ...(runtimeFactory ? { runtimeFactory } : {})
      });
    },
    advance(amount) { at += amount; }
  };
}

test('an unresolved manager is visible but does not revoke a valid child edge', async t => {
  const { tree, provider } = setup(t);
  const agent = tree.registerNode({
    sessionId: 'agent-session',
    nodeName: 'Agent',
    managerName: 'Manager'
  });
  const worker = tree.registerNode({
    sessionId: 'worker-session',
    nodeName: 'Worker',
    managerName: 'Agent'
  });
  const peer = tree.registerNode({ sessionId: 'peer-session', nodeName: 'Peer' });
  assert.equal(agent.managerUnresolved, 'Manager');
  assert.equal(tree.listNodes().find(node => node.agentId === agent.agentId).managerUnresolved, 'Manager');

  const roster = provider().roster({ from: 'Agent' });
  assert.equal(roster.ok, false);
  assert.equal(roster.code, 'TREE_MANAGER_UNREGISTERED');
  assert.match(roster.reason, /manager "Manager".*not registered/);
  /* Every reachable row carries the address that separates it from a same-named
     circle (T138); the never-registered manager below has no row and so has no
     address to carry. */
  assert.deepEqual(roster.reachable, [{
    nodeName: 'Worker', agentId: worker.agentId, relation: 'reports-to-sender', status: 'reachable-now',
    treeKey: null, lastSeenAt: 1_900_000_000_000, transient: false
  }]);
  assert.deepEqual(roster.unavailable, [{
    nodeName: 'Manager', relation: 'manager', status: 'never-registered', code: 'TREE_MANAGER_UNREGISTERED',
    treeKey: null, lastSeenAt: null, transient: false
  }]);

  const missingManager = tree.resolveDelivery({ from: 'Agent', to: 'Manager' });
  assert.equal(missingManager.code, 'TREE_MANAGER_UNREGISTERED');
  assert.match(missingManager.message, /message to that manager cannot be routed/);

  const childEdge = tree.resolveDelivery({ from: 'Agent', to: 'Worker' });
  assert.equal(childEdge.ok, true);
  assert.equal(childEdge.relation, 'reports-to-sender');
  assert.equal(
    tree.resolveDelivery({ from: 'Agent', to: 'Peer' }).code,
    'TREE_RECIPIENT_NOT_CONNECTED',
    'including the full tree in broker configuration must not create a sideways authority edge'
  );

  let configuredAgentIds = [];
  let runtimeConstructions = 0;
  const local = provider(options => {
    runtimeConstructions += 1;
    configuredAgentIds = options.extraAgentIds;
    return {
      identity(agentId) { return { agentId, machineId: 'machine' }; },
      fabric: {
        async send(input) {
          return {
            accepted: true,
            code: 'FABRIC_SENT',
            message: { id: 'message-child' },
            stream: { sequence: 1 },
            broker: { delivered: true },
            input
          };
        }
      }
    };
  });
  const sideways = await local.send({ from: 'Agent', to: 'Peer', body: 'not authorized' });
  assert.equal(sideways.accepted, false);
  assert.equal(sideways.code, 'TREE_RECIPIENT_NOT_CONNECTED');
  assert.equal(runtimeConstructions, 0, 'a refused edge must not construct a fabric runtime');

  const sent = await local.send({ from: 'Agent', to: 'Worker', body: 'still connected' });
  assert.equal(sent.accepted, true);
  assert.equal(sent.delivered, true);
  assert.equal(runtimeConstructions, 1);
  assert.deepEqual(new Set(configuredAgentIds), new Set([agent.agentId, worker.agentId, peer.agentId]));
});

test('roster gives named refusals for unknown and stopped senders', t => {
  const { tree, provider } = setup(t);
  tree.registerNode({ sessionId: 'known-session', nodeName: 'Known' });
  const local = provider();

  const unknown = local.roster({ from: 'Ghost' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'TREE_SENDER_UNKNOWN');
  assert.match(unknown.reason, /Ghost/);
  assert.deepEqual(unknown.reachable, []);
  assert.deepEqual(unknown.unavailable, []);

  tree.unregisterNode({ sessionId: 'known-session' });
  const stopped = local.roster({ from: 'Known' });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.code, 'TREE_SENDER_NOT_RUNNING');
  assert.match(stopped.reason, /Known/);
  assert.deepEqual(stopped.reachable, []);
  assert.deepEqual(stopped.unavailable, []);
});

test('a manager starting later heals the relationship, while a stopped manager stays distinct', t => {
  const { tree, provider } = setup(t);
  const child = tree.registerNode({ sessionId: 'child', nodeName: 'Agent', managerName: 'Manager' });
  const manager = tree.registerNode({ sessionId: 'manager', nodeName: 'Manager' });

  assert.equal(tree.listNodes().find(node => node.agentId === child.agentId).managerUnresolved, null);
  assert.deepEqual(provider().roster({ from: 'Agent' }), {
    from: 'Agent',
    reachable: [{ nodeName: 'Manager', agentId: manager.agentId, relation: 'manager', status: 'reachable-now',
      treeKey: null, lastSeenAt: 1_900_000_000_000, transient: false }],
    unavailable: [],
    ok: true
  });

  tree.unregisterNode({ sessionId: 'manager' });
  const stopped = provider().roster({ from: 'Agent' });
  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.reachable, []);
  /* A stopped circle keeps its address: it is the same circle, and the address
     is how a caller names it exactly when it comes back (T138). */
  assert.deepEqual(stopped.unavailable, [{
    nodeName: 'Manager', agentId: manager.agentId, relation: 'manager', status: 'registered-but-session-stopped', code: 'TREE_RECIPIENT_NOT_RUNNING',
    /* T255: the row now states whether writing to it would be held for a wake,
       so a roster cannot imply "do not bother" about a circle a message would
       start. This one merely stopped, so it can wake. */
    wakeable: true,
    treeKey: null, lastSeenAt: 1_900_000_000_000, transient: false
  }]);
  /* T255. The roster still lists the stopped manager as unavailable with its
     own code, asserted above, and that row is unchanged. What changed is that
     addressing it is no longer a dead end: the message is held and the circle is
     woken, so the delivery resolves with recipientStopped instead of refusing. */
  const held = tree.resolveDelivery({ from: 'Agent', to: 'Manager' });
  assert.equal(held.ok, true);
  assert.equal(held.recipientStopped, true);
  assert.equal(held.recipient.agentId, manager.agentId,
    'it resolved to the same circle the roster named, by address');
});

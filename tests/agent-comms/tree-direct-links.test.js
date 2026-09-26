'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const { createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');
const { createLocalAgentCommsRuntime } = require('../../src/lib/agent-comms/local-runtime');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-tree-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'nodes.json');
  const directory = createTreeNodeDirectory({ file });
  const a = directory.registerNode({ sessionId: 'a', nodeKey: 'circle-a', treeKey: 'tree-a', nodeName: 'Alpha' });
  const b = directory.registerNode({ sessionId: 'b', nodeKey: 'circle-b', treeKey: 'tree-b', nodeName: 'Beta' });
  directory.registerNode({ sessionId: 'c', nodeKey: 'circle-c', treeKey: 'tree-c', nodeName: 'Gamma' });
  return { root, file, directory, a, b };
}

test('direct peers cross tree boundaries in both directions and survive restarts and reparenting', t => {
  const { directory, file } = fixture(t);
  const send = (from, to) => directory.resolveDelivery({ from, to });
  assert.equal(send('Alpha', 'Beta').code, 'TREE_RECIPIENT_NOT_CONNECTED');
  directory.setLink({ from: 'circle-b', to: 'circle-a' });
  directory.setLink({ from: 'circle-a', to: 'circle-b' });
  assert.equal(directory.listLinks().length, 1, 'reverse selection is idempotent');
  assert.equal(send('Alpha', 'Beta').relation, 'linked-agent');
  assert.equal(send('Beta', 'Alpha').ok, true);
  assert.equal(send('Alpha', 'Gamma').code, 'TREE_RECIPIENT_NOT_CONNECTED');
  directory.heartbeatNode({ sessionId: 'a' });
  directory.bindThread({ sessionId: 'a', threadId: 'thread-a' });
  directory.unregisterNode({ sessionId: 'b' });
  /* T255. A stopped LINKED peer is held for a wake like any other stopped
     circle -- the link is the authority and it did not lapse when the session
     did. The NOT_CONNECTED refusals around this line are untouched: losing the
     link is still a refusal, losing the session is not. */
  const heldPeer = send('Alpha', 'Beta');
  assert.equal(heldPeer.ok, true);
  assert.equal(heldPeer.recipientStopped, true);
  const restarted = createTreeNodeDirectory({ file });
  restarted.registerNode({ sessionId: 'b-new', replacesSessionId: 'b', nodeKey: 'circle-b', treeKey: 'new-tree', nodeName: 'Beta renamed' });
  assert.equal(restarted.resolveDelivery({ from: 'Alpha', to: 'Beta renamed' }).ok, true);
  restarted.setLink({ from: 'circle-a', to: 'circle-b', connected: false });
  assert.equal(restarted.resolveDelivery({ from: 'Alpha', to: 'Beta renamed' }).code, 'TREE_RECIPIENT_NOT_CONNECTED');
  assert.equal(restarted.resolveDelivery({ from: 'Beta renamed', to: 'Alpha' }).code, 'TREE_RECIPIENT_NOT_CONNECTED');
});

test('links can be saved before sessions start; duplicate names have explicit recipient identities', t => {
  const { directory, b } = fixture(t);
  directory.setLink({ from: 'circle-a', to: 'future-circle' });
  assert.equal(directory.reachableFrom({ from: 'Alpha' }).length, 0);
  directory.registerNode({ sessionId: 'future', nodeKey: 'future-circle', treeKey: 'future-tree', nodeName: 'Beta' });
  directory.setLink({ from: 'circle-a', to: 'circle-b' });
  assert.equal(directory.resolveDelivery({ from: 'Alpha', to: 'Beta' }).code, 'TREE_RECIPIENT_AMBIGUOUS');
  assert.equal(directory.resolveDelivery({ from: 'Alpha', to: b.agentId }).recipient.sessionId, 'b');
  assert.equal(directory.reachableFrom({ from: 'Alpha' }).every(peer => peer.agentId), true);
});

test('invalid or malformed links preserve the last durable record', t => {
  const { directory, file } = fixture(t);
  const before = fs.readFileSync(file, 'utf8');
  for (const request of [{ from: 'a', to: 'a' }, { from: ' ', to: 'b' }, { from: 'a', to: 'b', connected: 'yes' }]) {
    assert.throws(() => directory.setLink(request), { code: 'TREE_LINK_INVALID' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  const bad = JSON.parse(before); bad.links = [{ from: 'a', to: 'a' }];
  fs.writeFileSync(file, JSON.stringify(bad));
  assert.throws(() => directory.setLink({ from: 'a', to: 'b' }), { code: 'TREE_DIRECTORY_MALFORMED' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), bad);
});

test('the real local fabric carries linked messages into each inbox and stops accepting after unlink', async t => {
  const { directory, root, a, b } = fixture(t);
  const memory = new Map();
  const store = {
    getMemory({ namespace, key }) { return memory.get(`${namespace}:${key}`) || null; },
    setMemory({ namespace, key, value }) {
      const id = `${namespace}:${key}`;
      const entry = { revision: (memory.get(id)?.revision || 0) + 1, value: structuredClone(value) };
      memory.set(id, entry); return { entry };
    },
  };
  const orgFile = path.join(root, 'org.json');
  fs.writeFileSync(orgFile, '{"agents":[]}');
  const provider = createLocalAgentMessageProvider({
    directory, brokerFile: path.join(root, 'broker.json'),
    runtimeFactory: options => createLocalAgentCommsRuntime({ ...options, store, orgFile, machineId: 'test-machine',
      presenceFile: path.join(root, 'presence.json'), mailboxDir: path.join(root, 'mailboxes') }),
  });
  assert.equal((await provider.send({ from: 'Alpha', to: 'Beta', body: 'Unlinked probe' })).accepted, false);
  directory.setLink({ from: 'circle-a', to: 'circle-b' });
  assert.equal((await provider.send({ from: 'Alpha', to: 'Beta', body: 'Review ready' })).accepted, true);
  assert.equal((await provider.send({ from: 'Beta', to: 'Alpha', body: 'Review received' })).accepted, true);
  assert.match(JSON.stringify(await provider.inbox({ agentId: b.agentId })), /Review ready/);
  assert.match(JSON.stringify(await provider.inbox({ agentId: a.agentId })), /Review received/);
  directory.setLink({ from: 'circle-a', to: 'circle-b', connected: false });
  assert.equal((await provider.send({ from: 'Alpha', to: 'Beta', body: 'No further delivery' })).accepted, false);
});


test('a bound session cannot impersonate a linked circle by choosing its name', t => {
  const { directory } = fixture(t);
  directory.setLink({ from: 'circle-a', to: 'circle-b' });
  assert.equal(directory.resolveDelivery({ from: 'Alpha', to: 'Beta', senderSessionId: 'c' }).code, 'TREE_SENDER_IDENTITY_MISMATCH');
  assert.equal(directory.reachabilityFrom({ from: 'Alpha', senderSessionId: 'c' }).code, 'TREE_SENDER_IDENTITY_MISMATCH');
  assert.equal(directory.resolveDelivery({ from: 'Alpha', to: 'Beta', senderSessionId: 'a' }).ok, true);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');

function directoryFor(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-node-identity-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  let at = 1_900_000_000_000;
  const directory = createTreeNodeDirectory({ file: path.join(scratch, 'directory.json'), now: () => at });
  return { directory, advance: milliseconds => { at += milliseconds; } };
}

test('an exact replacement removes a keyless legacy row from both roster headings', t => {
  const { directory } = directoryFor(t);
  directory.registerNode({ sessionId: 'old-controller', nodeName: 'Controller' });
  directory.unregisterNode({ sessionId: 'old-controller' });
  const controller = directory.registerNode({ sessionId: 'new-controller', nodeName: 'Controller', treeKey: 'root', nodeKey: 'root', replacesSessionId: 'old-controller' });
  directory.registerNode({ sessionId: 'worker', nodeName: 'Worker', managerName: 'Controller', treeKey: 'root', nodeKey: 'worker-node' });
  const roster = directory.reachabilityFrom({ from: 'Worker' });
  /* The address on the row is the SURVIVING controller's, so a caller reading
     this roster cannot be handed the retired session by mistake (T138). */
  assert.deepEqual(roster.reachable, [{ nodeName: 'Controller', agentId: controller.agentId, relation: 'manager',
    treeKey: 'root', lastSeenAt: 1_900_000_000_000, transient: false }]);
  assert.deepEqual(roster.unavailable, []);
  assert.equal(directory.listNodes().length, 2);
});

test('a stopped circle replaces its own renamed or moved row by saved identity', t => {
  const { directory, advance } = directoryFor(t);
  directory.registerNode({ sessionId: 'old', nodeName: 'Manager 5', nodeKey: 'saved-manager', treeKey: 'old-root' });
  advance(100_000);
  directory.registerNode({ sessionId: 'new', nodeName: 'Manager 6', nodeKey: 'saved-manager', treeKey: 'new-root' });
  assert.deepEqual(directory.listNodes().map(row => row.sessionId), ['new']);
  assert.equal(directory.listNodes()[0].nodeKey, 'saved-manager');
});

test('different saved circles cannot erase each other just because their old labels match', t => {
  const { directory } = directoryFor(t);
  directory.registerNode({ sessionId: 'old', nodeName: 'Manager 5', nodeKey: 'first-circle', treeKey: 'root' });
  directory.unregisterNode({ sessionId: 'old' });
  directory.registerNode({ sessionId: 'new', nodeName: 'Manager 5', nodeKey: 'second-circle', treeKey: 'root' });
  assert.equal(directory.listNodes().length, 2);
  assert.throws(() => directory.registerNode({
    sessionId: 'wrong-replacement', nodeName: 'Manager 5', nodeKey: 'second-circle', treeKey: 'root', replacesSessionId: 'old',
  }), error => error.code === 'TREE_REPLACEMENT_IDENTITY_MISMATCH');
  assert.equal(directory.listNodes().length, 2, 'a refused replacement must not write anything');
});

test('a thread copied to another known circle does not retire the first circle', t => {
  const { directory } = directoryFor(t);
  directory.registerNode({ sessionId: 'first', nodeName: 'Manager', nodeKey: 'circle-one', treeKey: 'root-one', threadId: 'copied-thread' });
  directory.registerNode({ sessionId: 'second', nodeName: 'Manager', nodeKey: 'circle-two', treeKey: 'root-two', threadId: 'copied-thread' });
  assert.equal(directory.listNodes().length, 2);
});

test('different live sessions remain ambiguous and are never told to use a nonexistent rename tool', t => {
  const { directory } = directoryFor(t);
  directory.registerNode({ sessionId: 'first', nodeName: 'Manager', nodeKey: 'first-circle', treeKey: 'root' });
  directory.registerNode({ sessionId: 'second', nodeName: 'Manager', nodeKey: 'second-circle', treeKey: 'root' });
  directory.registerNode({ sessionId: 'worker', nodeName: 'Worker', managerName: 'Manager', treeKey: 'root' });
  const refusal = directory.resolveDelivery({ from: 'Worker', to: 'Manager' });
  assert.equal(refusal.code, 'TREE_RECIPIENT_AMBIGUOUS');
  assert.equal(refusal.candidates, 2);
  assert.doesNotMatch(refusal.message, /rename/i);
});

test('restarting one saved circle cannot consume retained-history slots, while unrelated history remains', t => {
  const { directory } = directoryFor(t);
  directory.registerNode({ sessionId: 'unrelated', nodeName: 'Other', nodeKey: 'other-circle', treeKey: 'root' });
  directory.unregisterNode({ sessionId: 'unrelated' });
  for (let index = 0; index < 32; index += 1) {
    directory.registerNode({ sessionId: `restart-${index}`, nodeName: `Manager ${index}`, nodeKey: 'same-circle', treeKey: `tree-${index}` });
    directory.unregisterNode({ sessionId: `restart-${index}` });
  }
  assert.deepEqual(directory.listNodes().map(row => row.sessionId), ['unrelated', 'restart-31']);
});

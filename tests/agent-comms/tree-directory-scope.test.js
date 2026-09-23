'use strict';

// TWO TREES ON ONE COMPUTER SHARE A DIRECTORY, AND UNTIL 2026-09-03 THEY
// SHARED ONE NAMESPACE TOO.
//
// MEASURED 2026-09-03 19:12 local on the owner's own machine: two trees, each
// holding one circle named "Worker" (the app's store numbers a role per tree,
// so the second tree's first Worker is plain "Worker" as well). The directory
// held two live rows named "Worker" and answered TREE_SENDER_AMBIGUOUS to every
// roster and send from either -- including the one from the circle making the
// call. Two trees that use the same role names could not message at all, and
// the two circles could not even coordinate about it.
//
// Every test here drives the real module with values and asks it what it did.
// Nothing reads the source for a spelling.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MAX_TREE_KEY_LENGTH, createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');

function directoryIn(t, label) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, 'tree-nodes.json');
  return { file, directory: createTreeNodeDirectory({ file, now: () => 1_900_000_000_000, liveWindowMs: 90_000 }) };
}

/** Two structurally identical trees: a Manager over a Worker, twice. */
function twoTrees(directory) {
  return {
    managerA: directory.registerNode({ sessionId: 'manager-a', nodeName: 'Manager', treeKey: 'node-top-a' }),
    workerA: directory.registerNode({ sessionId: 'worker-a', nodeName: 'Worker', managerName: 'Manager', treeKey: 'node-top-a' }),
    managerB: directory.registerNode({ sessionId: 'manager-b', nodeName: 'Manager', treeKey: 'node-top-b' }),
    workerB: directory.registerNode({ sessionId: 'worker-b', nodeName: 'Worker', managerName: 'Manager', treeKey: 'node-top-b' }),
  };
}

test('a message stays inside its own tree when two trees use the same role names', t => {
  const { directory } = directoryIn(t, 'tree-scope-two-trees');
  const { workerB } = twoTrees(directory);

  const up = directory.resolveDelivery({ from: 'Worker', to: 'Manager', senderSessionId: 'worker-b' });
  assert.equal(up.ok, true, `worker-b could not reach its own manager: ${up.code} ${up.message}`);
  assert.equal(up.sender.sessionId, 'worker-b');
  assert.equal(up.recipient.sessionId, 'manager-b', 'the Manager in the OTHER tree was chosen, or both were');
  assert.equal(up.relation, 'manager');

  const down = directory.resolveDelivery({ from: 'Manager', to: 'Worker', senderSessionId: 'manager-a' });
  assert.equal(down.ok, true, `manager-a could not reach its own worker: ${down.code} ${down.message}`);
  assert.equal(down.recipient.sessionId, 'worker-a');
  assert.equal(down.relation, 'reports-to-sender');

  const roster = directory.reachabilityFrom({ from: 'Manager', senderSessionId: 'manager-b' });
  assert.equal(roster.ok, true, `${roster.code} ${roster.message}`);
  /* The address is its OWN tree's worker's, so a manager reading this roster and
     sending by address cannot cross into the other tree either (T138). */
  assert.deepEqual(roster.reachable, [{ nodeName: 'Worker', agentId: workerB.agentId, relation: 'reports-to-sender',
    treeKey: 'node-top-b', lastSeenAt: 1_900_000_000_000, transient: false }],
    'a manager\'s roster lists its own tree\'s worker exactly once, never the other tree\'s');
  assert.deepEqual(roster.unavailable, []);
});

test('a manager in another tree does not resolve this circle\'s manager edge', t => {
  const { directory } = directoryIn(t, 'tree-scope-manager-elsewhere');
  directory.registerNode({ sessionId: 'manager-a', nodeName: 'Manager', treeKey: 'node-top-a' });
  directory.registerNode({ sessionId: 'worker-b', nodeName: 'Worker', managerName: 'Manager', treeKey: 'node-top-b' });

  const row = directory.listNodes().find(node => node.sessionId === 'worker-b');
  assert.equal(row.managerUnresolved, 'Manager',
    'the diagnosis was satisfied by a same-named manager in a different tree');
  const roster = directory.reachabilityFrom({ from: 'Worker' });
  assert.equal(roster.ok, false);
  assert.equal(roster.code, 'TREE_MANAGER_UNREGISTERED');
  assert.equal(directory.resolveDelivery({ from: 'Worker', to: 'Manager' }).code, 'TREE_MANAGER_UNREGISTERED');

  /* The manager of tree B starts later, and the edge heals for the right row. */
  directory.registerNode({ sessionId: 'manager-b', nodeName: 'Manager', treeKey: 'node-top-b' });
  assert.equal(directory.listNodes().find(node => node.sessionId === 'worker-b').managerUnresolved, null);
  assert.equal(directory.resolveDelivery({ from: 'Worker', to: 'Manager' }).recipient.sessionId, 'manager-b');
});

test('a caller the tool surface vouched for resolves to its own circle when two live circles share its name', t => {
  const { directory } = directoryIn(t, 'tree-scope-two-workers');
  /* The measured shape: two trees, each with one circle at its top, both
     named "Worker", nothing else on the computer. */
  directory.registerNode({ sessionId: 'worker-one', nodeName: 'Worker', treeKey: 'node-top-one' });
  directory.registerNode({ sessionId: 'worker-two', nodeName: 'Worker', treeKey: 'node-top-two' });

  const unvouched = directory.reachabilityFrom({ from: 'Worker' });
  assert.equal(unvouched.code, 'TREE_SENDER_AMBIGUOUS', 'a caller nobody vouched for is still refused, not guessed');
  assert.equal(unvouched.candidates, 2);

  const own = directory.reachabilityFrom({ from: 'Worker', senderSessionId: 'worker-two' });
  assert.equal(own.ok, true, `${own.code} ${own.message}`);
  assert.deepEqual(own.reachable, [],
    'a circle at the top of its tree with nothing under it reaches nobody, and says so instead of refusing');
  assert.deepEqual(own.unavailable, []);

  const send = directory.resolveDelivery({ from: 'Worker', to: 'Anyone', senderSessionId: 'worker-one' });
  assert.notEqual(send.code, 'TREE_SENDER_AMBIGUOUS', 'the vouched-for caller must get past the sender step');
  assert.equal(send.code, 'TREE_RECIPIENT_UNKNOWN');

  /* A session that matches none of the rows is not steered into somebody
     else's circle: the refusal stands exactly as before. */
  assert.equal(directory.reachabilityFrom({ from: 'Worker', senderSessionId: 'nobody' }).code, 'TREE_SENDER_IDENTITY_MISMATCH');
  assert.equal(directory.resolveDelivery({ from: 'Worker', to: 'Anyone', senderSessionId: 'nobody' }).code,
    'TREE_SENDER_IDENTITY_MISMATCH');

  /* And a vouched-for session whose own row is STOPPED cannot borrow the
     live one that shares its name. */
  directory.unregisterNode({ sessionId: 'worker-two' });
  assert.equal(directory.reachabilityFrom({ from: 'Worker', senderSessionId: 'worker-two' }).code,
    'TREE_SENDER_IDENTITY_MISMATCH', 'the stopped caller cannot borrow the sole live row in another tree');
  assert.equal(directory.resolveDelivery({ from: 'Worker', to: 'Anyone', senderSessionId: 'worker-two' }).code,
    'TREE_SENDER_IDENTITY_MISMATCH');
});

test('a unique circle name cannot override the session making the call', t => {
  const { directory } = directoryIn(t, 'tree-scope-single-sender');
  directory.registerNode({ sessionId: 'manager', nodeName: 'Manager', treeKey: 'root' });
  directory.registerNode({ sessionId: 'worker', nodeName: 'Worker', managerName: 'Manager', treeKey: 'root' });
  const input = { from: 'Manager', to: 'Worker', senderSessionId: 'worker' };
  assert.equal(directory.resolveDelivery(input).code, 'TREE_SENDER_IDENTITY_MISMATCH');
  const roster = directory.reachabilityFrom(input);
  assert.equal(roster.code, 'TREE_SENDER_IDENTITY_MISMATCH');
  assert.deepEqual(roster.reachable, []);
  assert.deepEqual(roster.unavailable, []);
  assert.doesNotMatch(roster.message, /more than one/i, 'a session mismatch is not an ambiguous name');
  assert.equal(directory.resolveDelivery({ ...input, senderSessionId: 'manager' }).ok, true);
  assert.equal(directory.resolveDelivery({ ...input, senderSessionId: null }).ok, true,
    'legacy callers without a bound session keep unambiguous name lookup');
});

test('rows written before the tree key existed still read, and still match by name alone', t => {
  const { file, directory } = directoryIn(t, 'tree-scope-legacy-rows');
  directory.registerNode({ sessionId: 'manager-old', nodeName: 'Manager' });
  directory.registerNode({ sessionId: 'worker-new', nodeName: 'Worker', managerName: 'Manager', treeKey: 'node-top' });

  /* Strip the key from the stored file, the way an older build wrote rows. */
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const node of record.nodes) delete node.treeKey;
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');

  const nodes = directory.listNodes();
  assert.equal(nodes.length, 2, 'a row without a tree key must still read');
  assert.equal(nodes[0].treeKey, undefined);
  const up = directory.resolveDelivery({ from: 'Worker', to: 'Manager' });
  assert.equal(up.ok, true, `${up.code} ${up.message}`);
  assert.equal(up.recipient.sessionId, 'manager-old');

  /* A keyed row and an unkeyed row are not told apart: only two KNOWN keys
     that differ keep circles apart. */
  directory.registerNode({ sessionId: 'worker-keyed', nodeName: 'Worker 2', managerName: 'Manager', treeKey: 'node-top' });
  const roster = directory.reachabilityFrom({ from: 'Manager' });
  assert.equal(roster.ok, true, `${roster.code} ${roster.message}`);
  assert.deepEqual(roster.reachable.map(node => node.nodeName).sort(), ['Worker', 'Worker 2']);

  /* The stored shape is still enforced: a key that is not text refuses the
     row by field name, like every other field. */
  const broken = JSON.parse(fs.readFileSync(file, 'utf8'));
  broken.nodes[0].treeKey = 42;
  fs.writeFileSync(file, JSON.stringify(broken), 'utf8');
  assert.throws(() => directory.listNodes(), error => {
    assert.equal(error.code, 'TREE_DIRECTORY_MALFORMED');
    assert.match(error.message, /"treeKey"/);
    return true;
  });
});

test('the key a registration hands in is the key the row keeps, trimmed and bounded', t => {
  const { directory } = directoryIn(t, 'tree-scope-key-shape');
  assert.equal(directory.registerNode({ sessionId: 'top', nodeName: 'Controller', treeKey: '  node-2-abc  ' }).treeKey, 'node-2-abc');
  assert.equal(directory.registerNode({ sessionId: 'blank', nodeName: 'Blank', treeKey: '   ' }).treeKey, null);
  assert.equal(directory.registerNode({ sessionId: 'none', nodeName: 'None' }).treeKey, null);
  assert.equal(directory.registerNode({ sessionId: 'long', nodeName: 'Long', treeKey: 'x'.repeat(MAX_TREE_KEY_LENGTH + 1) }).treeKey, null,
    'an over-long key is dropped rather than refusing the registration; the row keeps its name-only answer');
  assert.equal(directory.listNodes().length, 4, 'no registration was lost over a scope hint');
});

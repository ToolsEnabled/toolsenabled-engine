'use strict';

// Lane 1-3 (tree-edges), parts (b) and (c): a child's managerName equals its
// parent's registered name, and a manager's roster lists every worker it
// spawned as reports-to-sender -- including once a same-role sibling manager
// has also registered.
//
// THE DEFECT THIS GUARDS, measured by the second tree (m1-REPORT-ready.md 1a
// to 1c, 6c): Manager 1 was registered "Manager", its workers were bound to
// "Manager 1", every send to them was refused TREE_RECIPIENT_NOT_CONNECTED,
// and Manager 1's own roster listed zero of the five workers it created while
// Manager 2's roster listed all three of its own. The cause was upstream of
// this directory (a display name recomputed at read time in the app's
// src/fleet-trees.js, fixed by commit bd80beb -- see the sibling test
// tools/test/tree-edges-name-stability.test.mjs in the app worktree), but
// this directory is the file that has to hold the edge once the names it is
// given are right, and it is the layer agent_comms.local_roster actually
// reads. This test registers a manager and five workers the way the app
// registers them -- by the exact frozen name -- and proves the edge and the
// roster survive a second, same-role manager registering afterward.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');

function workspaceFor(t, label) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

test('a manager\'s roster keeps every worker it spawned, by the worker\'s own managerName, after a same-role sibling manager registers', t => {
  const workspace = workspaceFor(t, 'tree-edges-roster');
  const now = 1_950_000_000_000;
  const directory = createTreeNodeDirectory({
    file: path.join(workspace, 'tree-nodes.json'),
    now: () => now,
  });

  const manager1 = directory.registerNode({ sessionId: 'manager-1-session', nodeName: 'Manager' });

  const workerNames = ['Worker', 'Worker 2', 'Worker 3', 'Worker 4', 'Worker 5'];
  const workers = workerNames.map((name, index) => directory.registerNode({
    sessionId: `worker-${index + 1}-session`,
    nodeName: name,
    managerName: 'Manager',
  }));

  // (b) each worker's stored managerName is the exact string the parent
  // registered under -- not a guess, not a recomputed ordinal.
  for (const worker of workers) {
    assert.equal(worker.managerName, manager1.nodeName,
      `${worker.nodeName}'s managerName must equal its parent's registered nodeName`);
  }

  // A second, same-role manager registers AFTER all five workers are already
  // on the tree, with its own, differently named, workers.
  directory.registerNode({ sessionId: 'manager-2-session', nodeName: 'Manager 2' });
  const helperNames = ['Helper', 'Helper 2', 'Helper 3'];
  for (const [index, name] of helperNames.entries()) {
    directory.registerNode({
      sessionId: `m2-helper-${index + 1}-session`,
      nodeName: name,
      managerName: 'Manager 2',
    });
  }

  // (b) again, behaviourally: each worker still resolves UP to Manager 1 by
  // name, and the recipient the directory hands back is Manager 1's own
  // registered identity.
  for (const name of workerNames) {
    const up = directory.resolveDelivery({ from: name, to: 'Manager' });
    assert.equal(up.ok, true, `${name} must still reach "Manager" after a same-role sibling registers`);
    assert.equal(up.relation, 'manager');
    assert.equal(up.recipient.nodeName, manager1.nodeName);
    assert.equal(up.recipient.agentId, manager1.agentId);
  }

  // (c) Manager's own roster lists every worker it spawned, and only them, as
  // reports-to-sender -- not zero of them, and not the other manager's crew.
  const roster1 = directory.reachabilityFrom({ from: 'Manager' });
  assert.equal(roster1.ok, true);
  assert.deepEqual(
    roster1.reachable.map(entry => entry.nodeName).sort(),
    [...workerNames].sort(),
    'Manager\'s roster must list every worker it spawned, not zero of them'
  );
  assert.ok(
    roster1.reachable.every(entry => entry.relation === 'reports-to-sender'),
    'every one of Manager\'s own workers must be listed as reports-to-sender'
  );
  assert.ok(
    !roster1.reachable.some(entry => helperNames.includes(entry.nodeName)),
    'Manager\'s roster must not include the second manager\'s own workers'
  );

  // And the second manager's roster is its own, undisturbed by the first.
  const roster2 = directory.reachabilityFrom({ from: 'Manager 2' });
  assert.equal(roster2.ok, true);
  assert.deepEqual(
    roster2.reachable.map(entry => entry.nodeName).sort(),
    [...helperNames].sort(),
    'Manager 2\'s roster must list its own three workers'
  );
});

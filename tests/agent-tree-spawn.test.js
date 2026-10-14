'use strict';
/* The seam between a spawn and the person's visible tree.
 *
 * The case this file exists for is the one that is easy to get wrong: a process
 * with no installed tree must REFUSE BY NAME rather than quietly become a lane.
 * The capability layer runs as a separate child with its own empty slot, so
 * that is not a hypothetical -- it is the normal state of half the processes
 * that load this module. */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TREE_ACTIONS,
  TREE_SPAWN_HOST_REQUIRED,
  installTreeSpawnHost,
  clearTreeSpawnHost,
  treeSpawnHost,
  isTreeSession,
  spawnOnTree,
  commandOnTree
} = require('../src/lib/agent-tree-spawn');

const workingHost = (overrides = {}) => ({
  isTreeSession: sessionId => sessionId === 'chat-parent-1',
  spawn: async request => ({ ok: true, nodeId: 'node-1-abc', sessionId: 'chat-child-1', asked: request }),
  ...overrides
});

const codeOf = async promise => {
  try { await promise; return null; } catch (error) { return error.code; }
};

test.beforeEach(() => clearTreeSpawnHost());
test.after(() => clearTreeSpawnHost());

test('a process with no installed tree answers no to every question and refuses a spawn by name', async () => {
  assert.equal(treeSpawnHost(), null);
  assert.equal(isTreeSession('chat-parent-1'), false, 'no tree means no session is on one');
  assert.equal(await codeOf(spawnOnTree({ parentSessionId: 'chat-parent-1' })), 'AGENT_SPAWN_TREE_UNAVAILABLE');
});

test('a host that cannot answer both questions is rejected at install time, where the stack names the installer', () => {
  assert.deepEqual([...TREE_SPAWN_HOST_REQUIRED], ['spawn', 'isTreeSession']);
  for (const bad of [null, undefined, 'tree', 42, {}, { spawn: () => {} }, { isTreeSession: () => true }]) {
    assert.throws(() => installTreeSpawnHost(bad), error => error.code === 'TREE_SPAWN_HOST_INVALID', JSON.stringify(bad));
  }
  assert.equal(treeSpawnHost(), null, 'a rejected host is not installed');
});

test('an installed tree answers both questions and receives the spawn request unchanged', async () => {
  installTreeSpawnHost(workingHost());
  assert.notEqual(treeSpawnHost(), null);
  assert.equal(isTreeSession('chat-parent-1'), true);
  assert.equal(isTreeSession('chat-somebody-else'), false);
  assert.equal(isTreeSession(''), false);
  assert.equal(isTreeSession(undefined), false);

  const request = { parentSessionId: 'chat-parent-1', role: 'worker', tier: 'claude-sonnet', brief: 'do one thing' };
  const answer = await spawnOnTree(request);
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.asked, request);
});

test('a tree that throws when asked is not a tree this session is on, rather than a crash mid-spawn', () => {
  installTreeSpawnHost(workingHost({ isTreeSession: () => { throw new Error('view is gone'); } }));
  assert.equal(isTreeSession('chat-parent-1'), false);
});

test('a spawn with no parent session is refused: a circle is drawn under the one that asked for it', async () => {
  installTreeSpawnHost(workingHost());
  for (const parentSessionId of [undefined, null, '', 7]) {
    assert.equal(await codeOf(spawnOnTree({ parentSessionId })), 'AGENT_SPAWN_TREE_NOT_A_TREE_AGENT', String(parentSessionId));
  }
});

test('one spawn per parent at a time, and the slot is released even when the tree refuses', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  /* Only the first circle's spawn is held open; a different circle's answers at
     once, which is what makes the "unaffected" assertion below mean something. */
  installTreeSpawnHost(workingHost({
    spawn: request => request.parentSessionId === 'chat-parent-1' ? held : Promise.resolve({ ok: true })
  }));

  const first = spawnOnTree({ parentSessionId: 'chat-parent-1' });
  assert.equal(await codeOf(spawnOnTree({ parentSessionId: 'chat-parent-1' })), 'AGENT_SPAWN_TREE_BUSY');
  /* A different circle handing work down at the same time is unaffected. */
  assert.equal(await codeOf(spawnOnTree({ parentSessionId: 'chat-parent-2' })), null);
  release({ ok: true });
  await first;
  assert.equal(await codeOf(spawnOnTree({ parentSessionId: 'chat-parent-1' })), null, 'the slot is free once the first answered');

  installTreeSpawnHost(workingHost({ spawn: async () => { const error = new Error('the view refused'); error.code = 'MC_TREE_SPAWN_PARENT_NOT_RUNNING'; throw error; } }));
  assert.equal(await codeOf(spawnOnTree({ parentSessionId: 'chat-parent-1' })), 'MC_TREE_SPAWN_PARENT_NOT_RUNNING');
  assert.equal(await codeOf(spawnOnTree({ parentSessionId: 'chat-parent-1' })), 'MC_TREE_SPAWN_PARENT_NOT_RUNNING',
    'a refusal releases the slot, so the next attempt reaches the tree instead of answering BUSY forever');
});

test('clearing the slot returns the process to having no tree', async () => {
  installTreeSpawnHost(workingHost());
  clearTreeSpawnHost();
  assert.equal(treeSpawnHost(), null);
  assert.equal(await codeOf(spawnOnTree({ parentSessionId: 'chat-parent-1' })), 'AGENT_SPAWN_TREE_UNAVAILABLE');
});

/* ---------------------------------------------------------------------------
 * commandOnTree -- the stop/restart/remove errand, PINNED.
 *
 * Everything below this line drives commandOnTree() itself, which had no
 * behavioural test anywhere on this branch: tests/agent-lifecycle-tools-
 * registered.test.js pins that agent.stop/restart/remove are REGISTERED and
 * route to treeLifecycle() by matching source text, and
 * tests/confined-tool-surface.test.js pins their CLASSIFICATION, but neither
 * one ever calls commandOnTree with a fake host and reads back what it
 * actually sent. A traced-but-not-found audit is not the same claim as a
 * tested one; these are the three riskiest paths that trace turned up, each
 * pinned with the exact code quoted so the next auditor can tell what would
 * have to change to make one of them wrong.
 *
 * 1. THE VERB -> ACTION MAPPING, AND THE ORDER THE GUARDS RUN IN.
 *
 *      const action = TREE_ACTIONS[verb];
 *      if (!action) fail('AGENT_TREE_COMMAND_UNKNOWN', ...);
 *      const parentSessionId = request && request.parentSessionId;
 *      if (typeof parentSessionId !== 'string' || parentSessionId === '') fail(...);
 *      const nodeId = request && request.nodeId;
 *      if (typeof nodeId !== 'string' || nodeId === '') fail(...);
 *
 *    Four refusals in a fixed order, each answering a different question
 *    (no host installed; the host cannot do this; the verb does not exist;
 *    no caller; no target) -- collapsing any two would make one of them
 *    unreachable exactly the way tools/test/agent-lifecycle-caller-gate's
 *    predecessor collapsed "could not place" into "not below caller" one
 *    lane over.
 *
 * 2. THE EXACT STRING TREE_ACTIONS SENDS FOR EACH VERB.
 *
 *      const TREE_ACTIONS = Object.freeze({
 *        stop: 'stop-node',
 *        restart: 'fresh-start-existing-node',
 *        remove: 'remove-node',
 *      });
 *
 *    host.command's action field is read downstream by src/main.js's
 *    cleanTreeNodeCommand (a DIFFERENT repository, the app one) as a bare
 *    string equality: `value.action === 'stop-node'`, `... ===
 *    'fresh-start-existing-node'`, `... === 'remove-node'`. Nothing type-
 *    checks the two sides against each other across that boundary -- a typo
 *    in either file silently turns a stop into an unreadable request that
 *    times out five minutes later, which is the exact defect class
 *    tools/test/agent-lifecycle-tree-commands.test.mjs was written to catch
 *    on the app side. This is the engine side of that same seam.
 *
 * 3. treeId / expectedSessionId NORMALISATION.
 *
 *      treeId: typeof request.treeId === 'string' && request.treeId !== '' ? request.treeId : null,
 *      expectedSessionId: typeof request.expectedSessionId === 'string' && request.expectedSessionId !== ''
 *        ? request.expectedSessionId
 *        : null,
 *
 *    src/main.js's cleanTreeNodeCommand (app repo) requires treeId to be
 *    EXACTLY `null` or a matching string for every lifecycle verb -- never
 *    `undefined`, an empty string, or any other falsy value -- and the same
 *    for expectedSessionId. treeLifecycle() (src/lib/tool-registry.js) hands
 *    commandOnTree whatever the MCP schema left as `undefined` for an
 *    omitted optional field; this normalisation is the only place that
 *    becomes the `null` the other repository's gate demands.
 */

test('commandOnTree refuses in a fixed order: no host, host cannot command, unknown verb, no caller, no target', async () => {
  assert.equal(await codeOf(commandOnTree('stop', { parentSessionId: 'chat-parent-1', nodeId: 'node-1' })),
    'AGENT_TREE_COMMAND_UNAVAILABLE', 'no installed host must refuse by this name');

  installTreeSpawnHost(workingHost());
  assert.equal(await codeOf(commandOnTree('stop', { parentSessionId: 'chat-parent-1', nodeId: 'node-1' })),
    'AGENT_TREE_COMMAND_UNSUPPORTED', 'a host with no command() must refuse by this name, not throw a TypeError calling it');

  installTreeSpawnHost(workingHost({ command: async request => ({ ok: true, request }) }));
  assert.equal(await codeOf(commandOnTree('teleport', { parentSessionId: 'chat-parent-1', nodeId: 'node-1' })),
    'AGENT_TREE_COMMAND_UNKNOWN', 'a verb outside TREE_ACTIONS must be refused by name, not sent to the application');

  for (const parentSessionId of [undefined, null, '', 9]) {
    assert.equal(await codeOf(commandOnTree('stop', { parentSessionId, nodeId: 'node-1' })),
      'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT', `parentSessionId ${JSON.stringify(parentSessionId)} must refuse before naming a target`);
  }
  for (const nodeId of [undefined, null, '', 9]) {
    assert.equal(await codeOf(commandOnTree('stop', { parentSessionId: 'chat-parent-1', nodeId })),
      'AGENT_TREE_COMMAND_NO_NODE', `nodeId ${JSON.stringify(nodeId)} must refuse once a caller is established`);
  }

  /* THE TWO LOOPS ABOVE NEVER ACTUALLY PROVE AN ORDER. Each varies exactly one
     field while holding the other one VALID, so both would read identically
     whether commandOnTree checked parentSessionId before nodeId or the other
     way around -- either guard fires correctly on its own regardless of which
     line comes first in the function body. Proven by mutation: swapping the
     two guard blocks in src/lib/agent-tree-spawn.js (nodeId's check moved
     above parentSessionId's, everything else byte-identical) left every
     assertion above this comment green. Only a request where BOTH are
     invalid at once can tell the two orderings apart, and this is that
     request: the swapped source answers AGENT_TREE_COMMAND_NO_NODE for it,
     the real source (below) answers AGENT_TREE_COMMAND_NOT_A_TREE_AGENT --
     matching this test's own title, "no caller, no target", in that order. */
  assert.equal(await codeOf(commandOnTree('stop', { parentSessionId: '', nodeId: '' })),
    'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT',
    'with BOTH the caller and the target missing, the caller check must still win -- a target named by an unplaced caller is refused for having no caller, not for the target being unnamed too');
});

test('each real verb reaches host.command as the exact action string the application recognises', async () => {
  const calls = [];
  installTreeSpawnHost(workingHost({ command: async request => { calls.push(request); return { ok: true, nodeId: request.nodeId, sessionId: null, threadId: null }; } }));

  for (const [verb, action] of [['stop', 'stop-node'], ['restart', 'fresh-start-existing-node'], ['remove', 'remove-node']]) {
    calls.length = 0;
    const answer = await commandOnTree(verb, { parentSessionId: 'chat-parent-1', nodeId: 'node-1' });
    assert.equal(answer.ok, true);
    assert.equal(calls.length, 1, `${verb} must reach host.command exactly once`);
    assert.equal(calls[0].action, action, `${verb} must carry the action "${action}" TREE_ACTIONS names for it`);
    assert.equal(TREE_ACTIONS[verb], action, 'the table itself must still name what this test just observed on the wire');
  }
});

test('treeId and expectedSessionId collapse undefined AND empty string to null, and pass a real string through unchanged', async () => {
  const calls = [];
  installTreeSpawnHost(workingHost({ command: async request => { calls.push(request); return { ok: true }; } }));

  await commandOnTree('stop', { parentSessionId: 'chat-parent-1', nodeId: 'node-1' });
  assert.equal(calls[0].treeId, null, 'an omitted treeId must normalise to null, not stay undefined');
  assert.equal(calls[0].expectedSessionId, null, 'an omitted expectedSessionId must normalise to null, not stay undefined');

  await commandOnTree('stop', { parentSessionId: 'chat-parent-1', nodeId: 'node-1', treeId: '', expectedSessionId: '' });
  assert.equal(calls[1].treeId, null, 'an empty-string treeId must normalise to null, exactly like an omitted one');
  assert.equal(calls[1].expectedSessionId, null, 'an empty-string expectedSessionId must normalise to null, exactly like an omitted one');

  await commandOnTree('stop', { parentSessionId: 'chat-parent-1', nodeId: 'node-1', treeId: 'tree-9', expectedSessionId: 'sess-9' });
  assert.equal(calls[2].treeId, 'tree-9', 'a real treeId must reach the application unchanged');
  assert.equal(calls[2].expectedSessionId, 'sess-9', 'a real expectedSessionId must reach the application unchanged');
});

test('commandOnTree carries no single-flight guard: two commands from the same parent both reach the application at once', async () => {
  /* Documented and deliberate ("The single-flight guard a spawn carries is
     deliberately NOT applied here"), unlike spawnOnTree three tests above,
     where a second spawn from the SAME parent is refused BUSY while the
     first is still in flight. A manager stopping two different circles, or
     retrying a stop for the one it already asked about, must not queue
     behind itself the way two spawns do. */
  let releaseFirst;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  installTreeSpawnHost(workingHost({
    command: async request => {
      calls.push(request);
      return request.nodeId === 'node-1' ? held : { ok: true };
    }
  }));

  const first = commandOnTree('stop', { parentSessionId: 'chat-parent-1', nodeId: 'node-1' });
  const second = await commandOnTree('remove', { parentSessionId: 'chat-parent-1', nodeId: 'node-2' });
  assert.equal(second.ok, true, 'a second command from the SAME parent must not be refused BUSY while the first is still open');
  assert.equal(calls.length, 2, 'both commands must have reached the application, not just the second');
  releaseFirst({ ok: true, nodeId: 'node-1' });
  assert.equal((await first).nodeId, 'node-1');
});

/* AUDIT (page2/lifecycle-status-engine, HUNT b477ed5): the test above proves
 * two DIFFERENT nodes never queue behind each other through commandOnTree.
 * It does not say anything about two verbs for the SAME node -- and neither
 * does anything else in this file, or in commandOnTree's own source. This is
 * the other half of that same contract, and it is the reason the guard on
 * the OTHER side of this seam is load-bearing rather than redundant:
 * src/views/computers.js's own nodeReplacementFlight (single-flight sharing
 * between a restart and a resume) and stopStillOwnsNode (a stop's own
 * write, skipped when a concurrent replacement has already moved the node
 * on) are the ONLY things standing between a stop racing a restart on ONE
 * circle and two live agents for it -- exactly the "later bridge.start wins
 * node.sessionId, the earlier keeps running... with nothing on screen able
 * to reach it" failure src/single-flight.js was written to name, reached
 * here by stop racing a replacement rather than two replacements racing
 * each other. Nothing in this file would refuse either half of that race;
 * this test pins that fact so it cannot go unnoticed if it ever changes. */
test('commandOnTree carries no guard for the SAME node either: a stop and a restart for one circle both reach the application at once', async () => {
  let releaseStop;
  const stopHeld = new Promise(resolve => { releaseStop = resolve; });
  const calls = [];
  installTreeSpawnHost(workingHost({
    command: async request => {
      calls.push(request);
      return request.action === 'stop-node' ? stopHeld : { ok: true, nodeId: request.nodeId };
    }
  }));

  const stop = commandOnTree('stop', { parentSessionId: 'chat-parent-1', nodeId: 'node-1' });
  const restart = await commandOnTree('restart', { parentSessionId: 'chat-parent-1', nodeId: 'node-1' });
  assert.equal(restart.ok, true,
    'a restart for the SAME node a stop is still closing must not be refused BUSY here -- commandOnTree carries no such guard, by design');
  assert.equal(calls.length, 2, 'both the stop and the restart must have reached the application, not just the restart');
  assert.deepEqual(calls.map(call => [call.action, call.nodeId]), [['stop-node', 'node-1'], ['fresh-start-existing-node', 'node-1']],
    'both calls really did name the same node under two different verbs, not two different nodes');
  releaseStop({ ok: true, nodeId: 'node-1' });
  assert.equal((await stop).nodeId, 'node-1');
});

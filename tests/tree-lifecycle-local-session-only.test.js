'use strict';
/* A CIRCLE ON THIS COMPUTER'S TREE IS CHANGED FROM THIS COMPUTER.
 *
 * Every other way onto the person's visible tree already says this, and two of
 * the four lifecycle verbs did not:
 *
 *   agent.spawn (tree route)  src/lib/tool-registry.js spawnSubagent calls
 *                             assertConfinedTreeSpawn or
 *                             assertUnrestrictedSpawn; BOTH refuse unless
 *                             `origin === 'local'`.
 *   agent.resume / restart    shell/main.cjs dispatchTreeSpawn reads the
 *                             lifecycle parent's own authority and refuses
 *                             TREE_DELEGATION_REFUSED when its
 *                             permissionSession.origin is not 'local'.
 *   agent.stop / agent.remove NOTHING. The dispatcher's `lifecycle` list names
 *                             only resume-node and fresh-start-existing-node,
 *                             so neither the origin check nor the delegation
 *                             token ever ran for a stop or a removal.
 *
 * MEASURED 2026-09-24 on this checkout, before the guard in treeLifecycle():
 * with a fake tree host installed and a Manifest tier session whose reviewed
 * capability list names the verbs, agent.stop and agent.remove were handed to
 * the application carrying a node id --
 *
 *   host was asked: [["command","stop-node","fra-session-1","node-not-mine"],
 *                    ["command","remove-node","fra-session-1","node-not-mine"]]
 *
 * -- while the two verbs that do carry a delegation token were not. Manifest is
 * origin 'remote' BY CONSTRUCTION (permission-tier-policy.js session() throws
 * PERMISSION_MANIFEST_ORIGIN_REFUSED for a local caller claiming the name), and
 * assertManifestToolAllowed admits whatever a reviewed FRA manifest names that
 * is not in REQUIRED_EXCLUDED_TOOLS or ALWAYS_BLOCKED_NAMESPACES -- the `agent`
 * namespace is in neither. That is the same door
 * tests/agent-spawn-tree-surface.test.js already records agent.spawn passing
 * through before assertUnrestrictedSpawn stops it; stop and remove had nothing
 * standing where assertUnrestrictedSpawn stands.
 *
 * WHAT THIS SUITE DOES NOT CLAIM. It does not claim an agent can stop or remove
 * a circle that is not below it. That question is the application's and it is
 * answered: src/agent-removal-rule.js's callerCircleRefusal (stop, restart,
 * resume) and executeRemoveNode (remove) both resolve where the asker stands
 * from the session the application itself bound and refuse
 * MC_TREE_COMMAND_NOT_BELOW_CALLER / MC_TREE_COMMAND_REMOVE_NOT_BELOW_CALLER,
 * with app/tools/test/agent-lifecycle-caller-gate.test.mjs and
 * app/tools/test/agent-removal-rule.test.mjs driving both. This suite pins the
 * TRANSPORT ceiling only -- who may reach that rule at all -- and the control
 * test below exists so it cannot be satisfied by refusing everybody.
 *
 *   node --test tests/tree-lifecycle-local-session-only.test.js
 */
require('./lib/isolated-environment').activate('tree-lifecycle-local-session-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeTool } = require('../src/lib/tool-registry');
const treeSpawnHostModule = require('../src/lib/agent-tree-spawn');
const permissionTierPolicy = require('../src/lib/permission-tier-policy');
const { toolNameDigest } = require('../src/lib/fra-capability-manifest');

const LOCAL_STANDARD = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
const TREE_ROLE = Object.freeze({
  functions: Object.freeze(['agent.spawn', 'agent.stop', 'agent.restart', 'agent.resume', 'agent.remove']),
  requiresDirectUserAuthorization: false,
});

/* The four verbs and the action each one names to the application, so a
   refusal that never reached the host can be told apart from one that did. */
const VERBS = Object.freeze([
  ['agent.stop', 'stop-node'],
  ['agent.remove', 'remove-node'],
  ['agent.restart', 'fresh-start-existing-node'],
]);

/* A reviewed FRA manifest that DOES name all four verbs. Naming them is the
   point: if the manifest allowlist were what refused them here, this suite
   would prove nothing about the second gate. */
function remoteManifestSession() {
  const names = ['agent.spawn', 'agent.stop', 'agent.restart', 'agent.resume', 'agent.remove'];
  return permissionTierPolicy.manifestSession({
    allowedToolNames: names,
    allowedToolNamesDigest: toolNameDigest(names),
  });
}

/* A host that answers every lifecycle question yes and records what it was
   asked. It must never be asked at all in the refusal tests -- "refused" and
   "refused after the application was told which circle to end" are different
   answers, and only the first one is a ceiling. */
function recordingHost(asked) {
  return {
    confinedTreeLifecycleVersion: 1,
    resumeAssignmentVersion: 1,
    isTreeSession: () => true,
    spawn: async () => { throw new Error('a lifecycle verb must never reach the spawn slot'); },
    command: async request => { asked.push(request); return { ok: true, nodeId: request.nodeId, sessionId: null, threadId: null }; },
    commandConfined: async request => { asked.push(request); return { ok: true, nodeId: request.nodeId, sessionId: null, threadId: null }; },
  };
}

const codeOf = async promise => {
  try { await promise; return null; } catch (error) { return error.code; }
};

test('a remote session is refused every tree lifecycle verb before the application is told which circle it named', async t => {
  const asked = [];
  treeSpawnHostModule.installTreeSpawnHost(recordingHost(asked));
  t.after(() => treeSpawnHostModule.clearTreeSpawnHost());
  const manifest = remoteManifestSession();
  assert.equal(manifest.origin, 'remote');
  for (const name of ['agent.stop', 'agent.remove', 'agent.restart', 'agent.resume']) {
    assert.equal(manifest.manifest.allowed.has(name), true,
      `${name} must actually be named by the fixture manifest, or the allowlist is what refuses it`);
  }

  for (const [tool] of VERBS) {
    const code = await codeOf(executeTool(tool, { nodeId: 'node-not-mine' },
      { agentId: 'remote-controller', agentPrincipal: { sessionId: 'fra-session-1' },
        agentRole: TREE_ROLE, permissionSession: manifest }));
    assert.equal(code, 'TREE_DELEGATION_REFUSED',
      `${tool} from a remote session must be refused by the tree's own transport ceiling`);
  }
  /* agent.resume is refused EARLIER, by the saved action-permission profile in
     executeTool (ACTION_PERMISSION_REQUIRED), before any handler runs. It is
     listed here for the only assertion that holds for all four: the
     application is never asked. Pinning resume's code would pin a different
     lane's gate. */
  assert.equal(await codeOf(executeTool('agent.resume', { nodeId: 'node-not-mine' },
    { agentId: 'remote-controller', agentPrincipal: { sessionId: 'fra-session-1' },
      agentRole: TREE_ROLE, permissionSession: manifest })) === null, false,
  'agent.resume from a remote session must be refused somewhere');

  assert.deepEqual(asked, [],
    'a remote caller must never learn whether the circle it named exists, let alone have it stopped or removed');
});

/* THE CONTROL. Without this the test above is satisfied by a treeLifecycle that
   refuses everyone, which would take the owner's own managers off the tree. */
test('a local session still reaches the application with exactly the circle it named', async t => {
  const asked = [];
  treeSpawnHostModule.installTreeSpawnHost(recordingHost(asked));
  t.after(() => treeSpawnHostModule.clearTreeSpawnHost());

  for (const [tool, action] of VERBS) {
    const answer = await executeTool(tool, { nodeId: 'node-below-me', expectedSessionId: 'old-session' },
      { agentId: 'manager', agentPrincipal: { sessionId: 'circle-A' },
        agentRole: TREE_ROLE, permissionSession: LOCAL_STANDARD });
    assert.equal(answer.ok, true, `${tool} from a local Standard circle must still be carried to the application`);
    const sent = asked.at(-1);
    assert.equal(sent.action, action);
    assert.equal(sent.nodeId, 'node-below-me');
    assert.equal(sent.parentSessionId, 'circle-A',
      'the acting circle is still read from the session the application bound, never from the arguments');
    assert.equal(sent.expectedSessionId, 'old-session');
  }
  assert.equal(asked.length, VERBS.length);
});

/* The ceiling is read from the session, and the session is REQUIRED. An
   absent or malformed one must refuse rather than read as "local enough":
   executeTool already refuses an absent session for every tool, and this pins
   that treeLifecycle's own read cannot be the place a hole reopens. */
test('a lifecycle verb with no stated permission ceiling refuses without asking the application', async t => {
  const asked = [];
  treeSpawnHostModule.installTreeSpawnHost(recordingHost(asked));
  t.after(() => treeSpawnHostModule.clearTreeSpawnHost());

  for (const [tool] of VERBS) {
    const code = await codeOf(executeTool(tool, { nodeId: 'node-1' },
      { agentId: 'manager', agentPrincipal: { sessionId: 'circle-A' }, agentRole: TREE_ROLE }));
    assert.equal(code, 'PERMISSION_SESSION_REQUIRED', `${tool} must refuse a dispatch that states no ceiling`);
  }
  assert.deepEqual(asked, []);
});

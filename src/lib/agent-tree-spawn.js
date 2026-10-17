'use strict';
// Dispatch agent tree operations through the host installed in this process.
// A server without a tree host refuses these operations. The host owns the
// persistent tree, session lifecycle and authorization decisions; this module
// validates the request shape and forwards it without creating an OS process.

const {
  TREE_SPAWN_HOST_REQUIRED,
  installTreeSpawnHost,
  clearTreeSpawnHost: clearInstalledTreeHost,
  treeSpawnHost,
  supportsConfinedTreeSpawn,
  supportsConfinedTreeLifecycle,
  supportsResumeAssignment,
  supportsConfinedSpeedControl,
  supportsConfinedConfigurationControl,
  supportsConfinedContinuationControl,
} = require('./tree-host-registry');

/* The lifecycle verbs an assistant may ask for on a circle BELOW it.

   Product requirement: agents must be able to delete, start and
   restart the agents under them, and message each one. Start and message
   already had a route; these three did not, although the application performs
   every one of them for the person's own press. Each is delivered through the
   SAME broker errand as a spawn, so the delivery clock, the queue and the
   refusals are the ones already proven rather than a second set. */
const TREE_ACTIONS = Object.freeze({
  resume: 'resume-node',
  stop: 'stop-node',
  restart: 'fresh-start-existing-node',
  remove: 'remove-node',
  'set-model': 'set-node-model',
  'set-effort': 'set-node-effort',
  'set-speed': 'set-node-speed',
  'set-continuation': 'set-node-continuation',
  'set-account': 'set-node-account',
  'set-provider': 'set-node-provider',
  'set-role': 'set-node-role',
});

/* One spawn per parent at a time. The application's tree-command broker holds a
   single active command anyway, so a second concurrent spawn from one circle
   would queue behind the first and could outlive the turn that asked for it.
   Refusing by name is the honest answer, and it is keyed on the PARENT so two
   different circles handing work down at once are unaffected. */
const inFlight = new Set();

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function clearTreeSpawnHost() {
  clearInstalledTreeHost();
  inFlight.clear();
}

/**
 * Is this session a circle on the person's tree? False whenever there is no
 * installed tree, which is the honest answer for a process that has none.
 */
function isTreeSession(sessionId) {
  if (!treeSpawnHost() || typeof sessionId !== 'string' || sessionId === '') return false;
  try {
    return treeSpawnHost().isTreeSession(sessionId) === true;
  } catch {
    /* A tree that cannot answer is not a tree this session is on. */
    return false;
  }
}

async function spawnResearchOnTree(request) {
  const current = treeSpawnHost();
  if (current?.researchSpawnVersion !== 1 || typeof current.spawnResearch !== 'function') {
    fail('RESEARCH_DELEGATION_UNAVAILABLE', 'This application cannot enforce restricted research workers. No ordinary worker was started.');
  }
  if (!request?.research || !isTreeSession(request.parentSessionId)) {
    fail('RESEARCH_DELEGATION_REFUSED', 'Restricted research delegation requires its live parent and explicit inputs.');
  }
  const parentSessionId = request.parentSessionId;
  if (inFlight.has(parentSessionId)) {
    fail('AGENT_SPAWN_TREE_BUSY', 'This assistant is already starting an assistant on the tree.');
  }
  inFlight.add(parentSessionId);
  try {
    return await current.spawnResearch(request);
  } finally {
    inFlight.delete(parentSessionId);
  }
}

async function spawnConfinedOnTree(request) {
  if (request?.research !== undefined) return spawnResearchOnTree(request);
  if (!supportsConfinedTreeSpawn()) {
    fail('TREE_DELEGATION_REFUSED', 'This application build cannot safely delegate a Standard tree session.');
  }
  if (!isTreeSession(request?.parentSessionId)) {
    fail('TREE_DELEGATION_REFUSED', 'Confined delegation requires a live parent on this tree.');
  }
  const parentSessionId = request.parentSessionId;
  if (inFlight.has(parentSessionId)) {
    fail('AGENT_SPAWN_TREE_BUSY', 'This assistant is already starting an assistant on the tree.');
  }
  inFlight.add(parentSessionId);
  try {
    // In-process application callback, never a process launch or legacy fallback.
    return await treeSpawnHost().spawnConfined(request);
  } finally {
    inFlight.delete(parentSessionId);
  }
}

/**
 * Ask the application to draw a circle under `parentSessionId` and start it.
 *
 * Refuses rather than falling back: every caller of this function has already
 * been told by src/lib/agent-subagent-route.js that the tree is the route, so a
 * quiet lane here would contradict a decision the person made.
 *
 * THE REQUEST IS CARRIED WHOLE AND ON PURPOSE. Its fields -- parentSessionId,
 * role, tier, brief, objectiveRef, and the effort/provider/model the caller
 * chose -- are validated by tool-registry.js before this is reached, and the
 * application's own gate (src/main.js cleanTreeNodeCommand) decides what it
 * will accept on the other side. Re-listing them here would mean a field the
 * tool validates and the application admits could still be dropped silently in
 * the middle, which is the class of defect this seam exists to avoid.
 */
async function spawnOnTree(request) {
  if (request?.research !== undefined) return spawnResearchOnTree(request);
  if (!treeSpawnHost()) {
    fail(
      'AGENT_SPAWN_TREE_UNAVAILABLE',
      'This assistant is not running inside the application that owns the tree, so it cannot put a new assistant on it.'
    );
  }
  const parentSessionId = request && request.parentSessionId;
  if (typeof parentSessionId !== 'string' || parentSessionId === '') {
    fail(
      'AGENT_SPAWN_TREE_NOT_A_TREE_AGENT',
      'A place on the tree is given under the circle that asked for it, and this request carries no session to put it under.'
    );
  }
  if (inFlight.has(parentSessionId)) {
    fail(
      'AGENT_SPAWN_TREE_BUSY',
      'This assistant is already starting one assistant on the tree. Wait for that one to answer before starting another.'
    );
  }
  inFlight.add(parentSessionId);
  try {
    // host.spawn is the slot installTreeSpawnHost() fills. It is an in-process
    // callback that asks the
    // renderer to draw a circle. It starts no OS process and opens no window
    // -- the marker below is read by tests/spawn-hygiene.test.js, which
    // otherwise has no way to tell this "spawn(" from child_process.spawn's.
    // SPAWN-ALLOWLIST: application-owned in-process adapter, not an OS spawn;
    // windowsHide belongs on the actual CLI launcher, not this request object.
    return await treeSpawnHost().spawn(request); // NOT-A-PROCESS-SPAWN: dispatches to the renderer over in-process IPC (dispatchTreeSpawn); no OS process or window is created.
  } finally {
    inFlight.delete(parentSessionId);
  }
}

/* One errand for every lifecycle verb.
 *
 * The single-flight guard a spawn carries is deliberately NOT applied here.
 * It exists because starting two circles at once from one parent draws two
 * and confuses which answered; stopping or removing two different circles is
 * an ordinary thing for a manager to do, and serialising it would make a
 * manager tidying three finished workers wait for three round trips.
 *
 * WHAT THIS FUNCTION DOES NOT DECIDE: whether the verb is allowed. The
 * application owns that, because the facts it turns on -- whether a person
 * ever spoke to the circle, whether an assistant made it, whether it is still
 * running -- live in the tree store and must never be claimed by the caller.
 * This carries the request and returns the answer, refusal included. */
async function commandOnTree(verb, request) {
  if (!treeSpawnHost()) {
    fail(
      'AGENT_TREE_COMMAND_UNAVAILABLE',
      'This assistant is not running inside the application that owns the tree, so it cannot change a circle on it.'
    );
  }
  const confined = request?.confined === true;
  const speedControl = confined && verb === 'set-speed';
  if (speedControl && !supportsConfinedSpeedControl()) fail('TREE_SPEED_CONTROL_REFUSED', 'This host has no confined speed-control adapter.');
  const configurationControl = confined && ['set-model', 'set-effort', 'set-role'].includes(verb);
  if (configurationControl && !supportsConfinedConfigurationControl()) fail('TREE_CONFIGURATION_CONTROL_REFUSED', 'This host has no confined model, effort or role control adapter.');
  const continuationControl = confined && verb === 'set-continuation';
  if (continuationControl && !supportsConfinedContinuationControl()) fail('TREE_CONTINUATION_CONTROL_REFUSED', 'This host has no confined assigned-task continuation adapter.');
  if (confined && !speedControl && !configurationControl && !continuationControl && (!['resume', 'restart'].includes(verb) || !supportsConfinedTreeLifecycle())) {
    fail('TREE_DELEGATION_REFUSED', 'This build cannot safely replace a Standard tree circle.');
  }
  if (!confined && typeof treeSpawnHost().command !== 'function') {
    fail(
      'AGENT_TREE_COMMAND_UNSUPPORTED',
      'The application that owns the tree does not offer this action in this build.'
    );
  }
  if (verb === 'set-continuation' && treeSpawnHost().ledgerContinuationVersion !== 1)
    fail('CONTINUATION_UNSUPPORTED', 'This host does not provide assigned-task continuation.');
  const action = TREE_ACTIONS[verb];
  if (!action) fail('AGENT_TREE_COMMAND_UNKNOWN', `"${verb}" is not something that can be done to a circle.`);
  const parentSessionId = request && request.parentSessionId;
  if (typeof parentSessionId !== 'string' || parentSessionId === '') {
    fail(
      'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT',
      'A circle is changed by the circle above it, and this request carries no session to act from.'
    );
  }
  const nodeId = request && request.nodeId;
  if (typeof nodeId !== 'string' || nodeId === '') {
    fail('AGENT_TREE_COMMAND_NO_NODE', 'Name the circle to act on.');
  }
  /* agent.resume may carry the next assignment for the resumed circle.
     tool-registry.js has already bounded it and refused credential-shaped
     text. An application that does not say it delivers one would drop it in
     the middle while the caller is told the resume worked, so it is refused. */
  const assignment = request && request.assignment !== undefined && request.assignment !== null ? request.assignment : null;
  if (assignment !== null) {
    if (verb !== 'resume' || typeof assignment !== 'string' || !assignment.trim()) {
      fail('AGENT_RESUME_ASSIGNMENT_REFUSED', 'Only agent.resume carries an assignment, and it must be non-empty text.');
    }
    if (!supportsResumeAssignment()) {
      fail('AGENT_RESUME_ASSIGNMENT_UNSUPPORTED',
        'This application cannot hand an assignment to a resumed circle yet, so nothing was resumed. Resume without an assignment, then send it as a message.');
    }
  }
  const command = speedControl ? treeSpawnHost().commandSpeedConfined.bind(treeSpawnHost())
    : continuationControl ? treeSpawnHost().commandContinuationConfined.bind(treeSpawnHost())
    : configurationControl ? treeSpawnHost().commandConfigurationConfined.bind(treeSpawnHost())
    : confined ? treeSpawnHost().commandConfined.bind(treeSpawnHost()) : treeSpawnHost().command.bind(treeSpawnHost());
  return command({
    action,
    ...(verb.startsWith('set-') ? { choice: request.choice } : {}),
    ...(assignment !== null ? { assignment: assignment.trim() } : {}),
    parentSessionId,
    nodeId,
    treeId: typeof request.treeId === 'string' && request.treeId !== '' ? request.treeId : null,
    expectedSessionId: typeof request.expectedSessionId === 'string' && request.expectedSessionId !== ''
      ? request.expectedSessionId
      : null,
  });
}

async function waitOnTree(request) {
  const current = treeSpawnHost();
  if (!current || typeof current.wait !== 'function') {
    fail('AGENT_WAIT_UNAVAILABLE', 'This tree cannot wait for worker reports. Read its normal inbox on the next tool answer.');
  }
  if (!isTreeSession(request?.parentSessionId)) {
    fail('AGENT_WAIT_TREE_SESSION_REQUIRED', 'Only a live session on this tree can wait for worker reports.');
  }
  return current.wait(request);
}

module.exports = Object.freeze({
  TREE_ACTIONS,
  TREE_SPAWN_HOST_REQUIRED,
  installTreeSpawnHost,
  clearTreeSpawnHost,
  treeSpawnHost,
  isTreeSession,
  supportsConfinedTreeSpawn,
  supportsConfinedTreeLifecycle,
  supportsResumeAssignment,
  spawnConfinedOnTree,
  spawnResearchOnTree,
  commandOnTree,
  waitOnTree,
  spawnOnTree
});

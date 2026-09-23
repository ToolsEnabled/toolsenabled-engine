'use strict';
// THE SEAM BETWEEN A SPAWN AND THE PERSON'S VISIBLE TREE.
//
// An assistant that is a circle on the tree may hand work down to new circles
// beside it (src/lib/agent-subagent-route.js decides when). Drawing a circle is
// something only the application can do -- the tree is a record the Computers
// view keeps, and the session behind a circle is started by the shell -- so
// this file does not draw anything. It holds ONE slot, and the application puts
// its own tree in it at startup.
//
// ---------------------------------------------------------------------------
// WHY A MODULE SINGLETON IS THE WHOLE TRANSPORT, WHICH LOOKS LIKE A SHORTCUT
// AND IS NOT.
//
// The application starts the agent-session authority by REQUIRING it out of the
// installed payload and calling it in process: shell/capability-layer.cjs
// startAppOwnedOwnerHost() does `require(<payload>/src/owner-host.js)` and then
// `host.listen()`. That host answers each MCP line through the same payload's
// src/mcp-server.js, which calls executeTool() in src/lib/tool-registry.js.
//
// So for an agent session hosted by the application, `agent.spawn` runs inside
// the Electron main process, in the same module graph as the code that owns the
// window. Both halves resolve THIS FILE to one absolute path, so Node's module
// cache hands them one object. Nothing has to be serialised, no port is opened,
// and no request crosses a process boundary that would have to be authenticated
// all over again.
//
// THE CASE THIS MUST GET RIGHT is the other one. The capability layer also runs
// as a separate child process for work that is not an application agent
// session, and that child loads its own copy of this module with an EMPTY slot.
// A tree spawn attempted from there finds no host and is refused by name rather
// than silently becoming a lane -- an assistant told "put them on the tree" that
// quietly got detached lanes would report a team the person cannot find.
//
// The slot is deliberately tiny and validated on the way in: a host that does
// not answer both questions is rejected at install time, where the stack names
// the installer, instead of at spawn time, where it would name an assistant.

const {
  TREE_SPAWN_HOST_REQUIRED,
  installTreeSpawnHost,
  clearTreeSpawnHost: clearInstalledTreeHost,
  treeSpawnHost,
  supportsConfinedTreeSpawn,
  supportsConfinedTreeLifecycle,
} = require('./tree-host-registry');

/* The lifecycle verbs an assistant may ask for on a circle BELOW it.

   Owner, 2026-09-03: "THE AGENTS NEED TO BE ABLE TO DELETE AND START AND
   RESTART AGENTS UNDER THEM AND BE ABLE TO MESSAGE EACH". Start and message
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
    // host.spawn is the slot installTreeSpawnHost() fills (shell/main.cjs
    // wires it to dispatchTreeSpawn), an in-process call that asks the
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
  if (confined && (!['resume', 'restart'].includes(verb) || !supportsConfinedTreeLifecycle())) {
    fail('TREE_DELEGATION_REFUSED', 'This build cannot safely replace a Standard tree circle.');
  }
  if (!confined && typeof treeSpawnHost().command !== 'function') {
    fail(
      'AGENT_TREE_COMMAND_UNSUPPORTED',
      'The application that owns the tree does not offer this action in this build.'
    );
  }
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
  const command = confined ? treeSpawnHost().commandConfined.bind(treeSpawnHost()) : treeSpawnHost().command.bind(treeSpawnHost());
  return command({
    action,
    ...(verb.startsWith('set-') ? { choice: request.choice } : {}),
    parentSessionId,
    nodeId,
    treeId: typeof request.treeId === 'string' && request.treeId !== '' ? request.treeId : null,
    expectedSessionId: typeof request.expectedSessionId === 'string' && request.expectedSessionId !== ''
      ? request.expectedSessionId
      : null,
  });
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
  spawnConfinedOnTree,
  spawnResearchOnTree,
  commandOnTree,
  spawnOnTree
});

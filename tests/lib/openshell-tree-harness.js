'use strict';
/* Stand-ins for driving the OpenShell agent tree through the real tool
 * registry, the real tree slot and the real link socket, with only the CLI
 * sessions replaced: the same shapes tests/openshell-agent-host.test.js uses.
 * The caller activates the isolated environment before requiring this. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createOpenShellAgentHost, startOpenShellAgentMode } = require('../../src/lib/openshell-agent-host');
const treeRegistry = require('../../src/lib/tree-host-registry');
const { executeTool } = require('../../src/lib/tool-registry');

const INSIDE = Object.freeze({
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  OPENSHELL_SANDBOX: '1', TOOLSENABLED_OPENSHELL_AGENTS: '1', TOOLSENABLED_AGENT_ACTOR: 'claude',
  TOOLSENABLED_STATE_ROOT: process.env.TOOLSENABLED_STATE_ROOT,
});

const contract = (task, role = 'WORKER') => [
  'CONTRACT/1',
  `role      ${role}`,
  'target    .',
  `do        ${task}`,
  'because   0 of 1 sandboxed round trips have been observed so far',
  'done      the final reply says it is done',
  'report    reply'
].join('\n');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'osth-'));
}

async function settle(rounds = 20) {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setImmediate(resolve));
}

/* A Codex session answers sendTurn with the accepted turn; a Claude session's
   sendTurn is the whole turn. finish() ends the current turn the way each
   adapter reports it. */
function standIns() {
  const sessions = [];
  let turns = 0;
  const launcher = {
    async start(spec) {
      const session = { spec, turns: [], closed: 0, threadId: spec.threadId || `thread-${sessions.length + 1}`, processGroup: null };
      session.emit = event => spec.onEvent(event);
      session.finish = (text, status = 'completed') => {
        const turn = session.turns.at(-1);
        session.emit({ type: 'assistant_text', threadId: session.threadId, turnId: turn.turnId, itemId: `i-${turn.turnId}`, text });
        session.emit({ type: 'turn_completed', threadId: session.threadId, turnId: turn.turnId, status });
        if (turn.resolve) turn.resolve({ status });
      };
      session.adapter = {
        sendTurn(turn) {
          const record = { ...turn, turnId: `turn-${++turns}` };
          session.turns.push(record);
          if (require('../../src/lib/agents/registry').driverOf(require('../../src/lib/agents/registry').activeRegistry(), spec.provider) === 'stream-json') return new Promise(resolve => { record.resolve = resolve; });
          return Promise.resolve({ threadId: turn.threadId, turnId: record.turnId });
        },
        pendingTurnForInterrupt() { return { threadId: session.threadId, turnId: session.turns.at(-1)?.turnId }; },
        async interrupt() {},
        async updateThreadSettings(threadId, settings) { return { threadId, effort: settings.effort }; },
      };
      session.close = () => { session.closed += 1; };
      sessions.push(session);
      return session;
    },
  };
  return { launcher, sessions, last: () => sessions.at(-1) };
}

/** Modes started through one of these are closed by closeAll(). */
function treeModes() {
  const modes = [];
  function startMode(stand, { env = INSIDE, workspace = scratch(), stateRoot = scratch(), listen = true, host = {} } = {}) {
    treeRegistry.clearTreeSpawnHost();
    const mode = startOpenShellAgentMode({
      env, cwd: workspace, stateRoot, listen,
      createLauncher: () => stand.launcher,
      createHost: options => createOpenShellAgentHost({
        ...options,
        watchIntervalMs: 0,
        terminate: async () => ({ signalled: [], survivors: [] }),
        codexEndpoint: () => null,
        ...host,
      }),
    });
    const tracked = { ...mode, workspace, stateRoot };
    modes.push(tracked);
    return tracked;
  }
  /* A worker's own ToolsEnabled server, started from the environment the tree
     gave it and talking to the root over the socket. */
  function workerServer(mode, session) {
    const tokenFile = path.join(scratch(), 'link-token');
    fs.writeFileSync(tokenFile, `${session.spec.linkToken}\n`);
    let installed = null;
    const worker = startOpenShellAgentMode({
      env: {
        ...INSIDE,
        TOOLSENABLED_AGENT_ACTOR: session.spec.provider,
        TOOLSENABLED_OPENSHELL_TREE_SOCKET: mode.socketPath,
        TOOLSENABLED_OPENSHELL_NODE: session.spec.nodeId,
        TOOLSENABLED_OPENSHELL_SESSION: session.spec.sessionId,
        TOOLSENABLED_OPENSHELL_LINK_TOKEN_FILE: tokenFile,
        ...session.spec.serverEnv,
      },
      cwd: mode.workspace,
      installTreeSpawnHost: value => { installed = value; },
    });
    return {
      ...worker,
      async call(tool, args) {
        treeRegistry.installTreeSpawnHost(installed);
        try { return await executeTool(tool, args, worker.context); } finally { treeRegistry.installTreeSpawnHost(mode.host); }
      },
    };
  }
  async function closeAll() {
    while (modes.length > 0) await modes.pop().close().catch(() => {});
    treeRegistry.clearTreeSpawnHost();
  }
  return { startMode, workerServer, closeAll };
}

module.exports = { INSIDE, contract, CONTRACT: contract('reply with the single word pong'), scratch, settle, standIns, treeModes };

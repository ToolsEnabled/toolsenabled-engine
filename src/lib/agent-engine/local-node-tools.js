'use strict';

/* THE CIRCLE'S TOOL SURFACE, REACHED BY A MODEL THAT HAS NO CLI TO REACH IT FOR IT.
 *
 * WHAT THE OTHER TWO ENGINES GET FOR FREE. The confinement plan writes ONE
 * generated document per session -- `.mcp.json`, `{ mcpServers: { name:
 * { command, args, cwd, env } } }` (src/lib/agent-session-confinement.js
 * prepareClaudeToolSurface, src/lib/setup/machine-record.js
 * generateMcpConfig) -- and the Claude CLI reads it off `--mcp-config`,
 * starts every server in it, lists their tools and calls them. Codex does the
 * same from its own home. A model behind Ollama's HTTP route has nobody to do
 * that for it: it can NAME a tool (Ollama's function calling puts
 * `message.tool_calls` on the reply) but it cannot start a process or speak
 * JSON-RPC. This module is that missing half, and nothing more: an MCP
 * stdio client that reads the SAME document the plan already wrote, starts
 * the SAME servers with the SAME environment (the session credential and
 * state root ride in each entry's `env`, exactly as they do for Claude), and
 * exposes `list()` and `call()` to local-node-adapter.js.
 *
 * NOTHING IS INVENTED. The tool names, descriptions and input schemas the
 * model sees are the servers' own tools/list answers, verbatim; the results
 * it is shown are the servers' own tools/call content. A server that fails to
 * start is recorded in `diagnostics` and left out -- the session runs with
 * the tools that really answered, and says which.
 *
 * NEWLINE-DELIMITED JSON-RPC 2.0 OVER STDIO, the MCP stdio transport as
 * src/mcp-server.js speaks it (one JSON object per line; initialize,
 * notifications/initialized, tools/list, tools/call, notifications/cancelled).
 * The client half is proved against that server module in
 * tests/agent-engine/local-node-tools.test.js, in-process, so the two cannot
 * drift without a red test.
 *
 * EVERY CHILD GOES THROUGH ../proc/hidden-spawn LIKE EVERY OTHER CHILD THE
 * ENGINES START, and is closed the way claude-cli-process.js closes its own:
 * a polite stdin end, then a tree kill after four seconds for a child that
 * ignored it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnHidden } = require('../proc/hidden-spawn');
const { killProcessTree } = require('../fleet-supervisor/kill-tree.js');
const { LocalNodeError } = require('../providers/local-node-runtime');

const PROTOCOL_VERSION = '2025-11-25';
const CLIENT_INFO = Object.freeze({ name: 'toolsenabled-local-node', version: String(require('../../../package.json').version || '0') });

/* initialize and tools/list are answered from memory; a minute is generous. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/* A real tool call reads files, drives a browser, waits on a build. The
   Claude engine gives a whole turn thirty minutes; one call gets ten. */
const DEFAULT_CALL_TIMEOUT_MS = 10 * 60 * 1000;
/* What the model is shown of one result. A local model's context is small
   and a 4 MB file listing would evict the conversation it was fetched for;
   the cut is marked so the model knows it saw a prefix. */
const MAX_RESULT_CHARS = 24 * 1024;
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const MAX_TOOL_PAGES = 16;
const MAX_TOOLS = 2_000;
const STDERR_LIMIT = 64 * 1024;
const CLOSE_GRACE_MS = 4_000;
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function fail(code, message, details = {}, cause = null) {
  return new LocalNodeError(code, message, details, cause ? { cause } : {});
}

function appendBounded(current, chunk, limit = STDERR_LIMIT) {
  const combined = current + chunk;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

/* ----------------------------------------------------------- transport -- */

/**
 * One MCP server child, framed as newline-delimited JSON.
 *
 * `onData(handler)` delivers `(packet)` per parsed line and `(null, exit)`
 * once when the child ends -- the same two-shape callback the Claude and
 * Codex transports use, so the client below can be written against a fake
 * in a test and against a real child in the product without knowing which.
 */
function createMcpStdioTransport({ command, args = [], env, cwd } = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw fail('LOCAL_NODE_TOOLS_CONFIG_INVALID', 'A tool server entry names no program to start.');
  }
  const child = spawnHidden(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    containProcessTree: true
  });
  let buffered = '';
  let stderr = '';
  let handler = null;
  let ended = false;
  let spawnError = null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = appendBounded(stderr, String(chunk)); });

  const finish = (code, signal) => {
    if (ended) return;
    ended = true;
    if (handler) {
      try { handler(null, { code, signal, stderr, error: spawnError }); } catch { /* nothing left to tell */ }
    }
  };

  child.stdout.on('data', chunk => {
    buffered += chunk;
    if (buffered.length > MAX_LINE_CHARS) {
      spawnError = fail('LOCAL_NODE_TOOL_SERVER_PROTOCOL', 'A tool server wrote a line longer than the protocol allows.');
      try { child.stdin.end(); } catch { /* already unusable */ }
      finish(null, null);
      return;
    }
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (!line || !handler) continue;
      let packet;
      try {
        packet = JSON.parse(line);
      } catch {
        /* stdout is the protocol, not a terminal. A line that is not JSON
           ends the transport now rather than leaving a request to time out. */
        spawnError = fail('LOCAL_NODE_TOOL_SERVER_PROTOCOL', 'A tool server wrote a response that was not valid JSON.');
        try { child.stdin.end(); } catch { /* already unusable */ }
        finish(null, null);
        return;
      }
      try { handler(packet); } catch { /* a receiver fault is not the server's */ }
    }
  });
  child.on('error', error => { spawnError = error; finish(null, null); });
  child.on('close', (code, signal) => finish(code, signal));

  return {
    child,
    onData(next) { handler = next; },
    send(message) {
      if (ended || !child.stdin.writable) {
        throw fail('LOCAL_NODE_TOOL_SERVER_EXITED', 'The tool server is no longer accepting requests.');
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    get stderr() { return stderr; },
    close() {
      if (ended) return;
      try { child.stdin.end(); } catch { /* already gone */ }
      const timer = setTimeout(() => {
        if (typeof child.terminateJob === 'function') {
          child.terminateJob().catch(() => { /* the wrapper still owns KILL_ON_JOB_CLOSE */ });
        } else {
          killProcessTree(child);
        }
      }, CLOSE_GRACE_MS);
      if (timer.unref) timer.unref();
      child.once('close', () => clearTimeout(timer));
    }
  };
}

/* -------------------------------------------------------------- client -- */

function validTool(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.name !== 'string' || !TOOL_NAME_RE.test(value.name)) return null;
  const schema = value.inputSchema && typeof value.inputSchema === 'object' && !Array.isArray(value.inputSchema)
    ? value.inputSchema
    : { type: 'object', properties: {} };
  return Object.freeze({
    name: value.name,
    description: typeof value.description === 'string' ? value.description.slice(0, 4_096) : '',
    inputSchema: schema
  });
}

/* The text a tools/call result carries for the model: every text block,
   joined; bounded, with the cut stated. */
function resultText(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  let text = parts.join('\n');
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n[result cut at ${MAX_RESULT_CHARS} characters; ${text.length - MAX_RESULT_CHARS} more were not shown]`;
  }
  return text;
}

/**
 * One MCP client over one transport. initialize() must complete before
 * listTools() or callTool(); the server refuses other methods until it has.
 */
function createMcpClient({ name, transport, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
  if (!transport || typeof transport.send !== 'function' || typeof transport.onData !== 'function') {
    throw new TypeError('createMcpClient requires a transport with send() and onData()');
  }
  const serverName = typeof name === 'string' && name ? name : 'tools';
  const pending = new Map();
  let nextId = 1;
  let exit = null;
  let initialized = false;
  let serverInfo = null;

  transport.onData((packet, exitInfo) => {
    if (packet === null) {
      exit = exitInfo || { code: null, signal: null };
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(fail('LOCAL_NODE_TOOL_SERVER_EXITED', `The "${serverName}" tool server stopped (exit ${exit.code}).`, {
          server: serverName, code: exit.code, stderr: typeof exit.stderr === 'string' ? exit.stderr.slice(-2_000) : null
        }));
      }
      pending.clear();
      return;
    }
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;
    if (!Object.prototype.hasOwnProperty.call(packet, 'id')) return; /* a notification from the server */
    const entry = pending.get(packet.id);
    if (!entry) return;
    pending.delete(packet.id);
    clearTimeout(entry.timer);
    if (packet.error) {
      const message = packet.error && typeof packet.error.message === 'string' ? packet.error.message : 'The tool server refused the request.';
      entry.reject(fail('LOCAL_NODE_TOOL_REFUSED', message, { server: serverName, rpcCode: packet.error.code }));
      return;
    }
    entry.resolve(packet.result === undefined ? {} : packet.result);
  });

  function request(method, params, { timeoutMs = requestTimeoutMs, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (exit) return reject(fail('LOCAL_NODE_TOOL_SERVER_EXITED', `The "${serverName}" tool server has stopped.`, { server: serverName }));
      const id = nextId++;
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        if (pending.delete(id)) reject(fail('LOCAL_NODE_TOOL_TIMEOUT', `The "${serverName}" tool server did not answer ${method} in time.`, { server: serverName, method, timeoutMs }));
      }, timeoutMs);
      if (entry.timer.unref) entry.timer.unref();
      pending.set(id, entry);
      if (signal) {
        const abort = () => {
          if (!pending.delete(id)) return;
          clearTimeout(entry.timer);
          /* Best effort: the server is told the answer is no longer wanted,
             and the caller is released now rather than when the tool ends. */
          try { transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'interrupted' } }); } catch { /* gone */ }
          reject(fail('LOCAL_NODE_INTERRUPTED', 'The turn was stopped while a tool was running.', { server: serverName, method }));
        };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
      }
      try {
        transport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(error && error.name === 'LocalNodeError' ? error : fail('LOCAL_NODE_TOOL_SERVER_EXITED', `The "${serverName}" tool server could not be written to.`, { server: serverName }, error));
      }
    });
  }

  return {
    name: serverName,
    get serverInfo() { return serverInfo; },
    get exited() { return exit; },
    async initialize() {
      const result = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { ...CLIENT_INFO } });
      serverInfo = result && result.serverInfo && typeof result.serverInfo === 'object' ? { ...result.serverInfo } : null;
      transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      initialized = true;
      return Object.freeze({ protocolVersion: result && result.protocolVersion, serverInfo });
    },
    async listTools() {
      if (!initialized) throw fail('LOCAL_NODE_TOOLS_NOT_INITIALIZED', `The "${serverName}" tool server was not initialized.`, { server: serverName });
      const tools = [];
      let cursor;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const result = await request('tools/list', cursor === undefined ? {} : { cursor });
        const listed = result && Array.isArray(result.tools) ? result.tools : [];
        for (const entry of listed) {
          const tool = validTool(entry);
          if (tool && tools.length < MAX_TOOLS) tools.push(tool);
        }
        cursor = result && typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
        if (cursor === undefined) break;
      }
      return Object.freeze(tools);
    },
    async callTool(toolName, args, { signal = null } = {}) {
      if (!initialized) throw fail('LOCAL_NODE_TOOLS_NOT_INITIALIZED', `The "${serverName}" tool server was not initialized.`, { server: serverName });
      const result = await request('tools/call', {
        name: toolName,
        arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {}
      }, { timeoutMs: callTimeoutMs, signal });
      return Object.freeze({
        text: resultText(result),
        isError: Boolean(result && result.isError === true),
        content: result && Array.isArray(result.content) ? result.content : []
      });
    },
    close() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(fail('LOCAL_NODE_CLOSED', 'This local model session was closed while a tool was running.'));
      }
      pending.clear();
      try { transport.close(); } catch { /* already gone */ }
    }
  };
}

/* ------------------------------------------------------------- surface -- */

function validEntry(name, entry) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw fail('LOCAL_NODE_TOOLS_CONFIG_INVALID', `"${String(name).slice(0, 60)}" is not a tool server name this session can start.`);
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.command !== 'string' || !entry.command) {
    throw fail('LOCAL_NODE_TOOLS_CONFIG_INVALID', `The "${name}" tool server entry names no program to start.`, { server: name });
  }
  const args = entry.args === undefined ? [] : entry.args;
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    throw fail('LOCAL_NODE_TOOLS_CONFIG_INVALID', `The "${name}" tool server entry's arguments are not a list of words.`, { server: name });
  }
  const env = entry.env === undefined ? {} : entry.env;
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string')) {
    throw fail('LOCAL_NODE_TOOLS_CONFIG_INVALID', `The "${name}" tool server entry's environment is not a table of strings.`, { server: name });
  }
  if (entry.cwd !== undefined && (typeof entry.cwd !== 'string' || !entry.cwd)) {
    throw fail('LOCAL_NODE_TOOLS_CONFIG_INVALID', `The "${name}" tool server entry's working directory is not a path.`, { server: name });
  }
  return { name, command: entry.command, args, env, cwd: entry.cwd };
}

/**
 * Every server in one generated document, started, initialized and listed.
 *
 * `open()` returns the surface itself. A server that cannot be started,
 * initialized or listed is recorded in `diagnostics` (server, code, message)
 * and skipped; the surface then carries the tools of the servers that
 * answered, and `servers` names exactly those. A tool name advertised by
 * two servers goes to the first; the second is recorded as a duplicate.
 */
function createToolSurface({ document, env = null, cwd = null, transportFor = createMcpStdioTransport } = {}) {
  const entries = Object.entries((document && document.mcpServers) || {}).map(([name, entry]) => validEntry(name, entry));
  const clients = new Map();
  const tools = new Map();
  const diagnostics = [];
  let opened = false;
  let closed = false;

  const surface = {
    get servers() { return Object.freeze([...clients.keys()]); },
    get diagnostics() { return Object.freeze(diagnostics.map(entry => Object.freeze({ ...entry }))); },
    async open() {
      if (opened) return surface;
      opened = true;
      for (const entry of entries) {
        let transport = null;
        let client = null;
        try {
          transport = transportFor({
            command: entry.command,
            args: entry.args,
            env: { ...(env && typeof env === 'object' ? env : process.env), ...entry.env },
            cwd: entry.cwd || cwd || undefined
          });
          client = createMcpClient({ name: entry.name, transport });
          await client.initialize();
          const listed = await client.listTools();
          clients.set(entry.name, client);
          for (const tool of listed) {
            if (tools.has(tool.name)) {
              diagnostics.push({ server: entry.name, tool: tool.name, code: 'LOCAL_NODE_TOOL_DUPLICATE', message: `"${tool.name}" is also advertised by "${tools.get(tool.name).server}", which answers it.` });
              continue;
            }
            tools.set(tool.name, { server: entry.name, tool });
          }
        } catch (error) {
          diagnostics.push({
            server: entry.name,
            code: error && error.code ? error.code : 'LOCAL_NODE_TOOL_SERVER_FAILED',
            message: error && error.message ? error.message : 'The tool server could not be started.'
          });
          if (client) { try { client.close(); } catch { /* gone */ } } else if (transport) { try { transport.close(); } catch { /* gone */ } }
        }
      }
      return surface;
    },
    list() {
      return Object.freeze([...tools.values()].map(({ server, tool }) => Object.freeze({ ...tool, server })));
    },
    async call(toolName, args, { signal = null } = {}) {
      if (closed) throw fail('LOCAL_NODE_CLOSED', 'This local model session is closed.');
      const entry = tools.get(toolName);
      if (!entry) {
        /* Told to the model, not thrown at the turn: a name the model made up
           is the model's mistake to correct on its next round. */
        return Object.freeze({ text: `No tool named "${String(toolName).slice(0, 128)}" is available to this session.`, isError: true, content: [] });
      }
      return clients.get(entry.server).callTool(toolName, args, { signal });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const client of clients.values()) {
        try { client.close(); } catch { /* gone */ }
      }
      clients.clear();
    }
  };
  return surface;
}

/**
 * The surface a confinement plan names, or null when the plan names none.
 *
 * The same refusals claude-cli-adapter.js's mcpConfigArgs() makes, for the
 * same reasons: a relative path resolves against the working directory (the
 * person's project) and a rooted-but-driveless one against whatever drive
 * the process is on, and either would read a document the plan never wrote.
 */
async function loadToolSurfaceFromPlan({ plan = null, env = null, cwd = null, dependencies = {} } = {}) {
  if (plan === null || plan === undefined) return null;
  if (typeof plan !== 'object' || Array.isArray(plan)) {
    throw fail('LOCAL_NODE_TOOLS_PLAN_INVALID', 'The confinement plan for this session is not readable, so the session was not started.');
  }
  if (plan.mcpConfig === null || plan.mcpConfig === undefined) return null;
  const named = typeof plan.mcpConfig === 'string' ? plan.mcpConfig.trim() : '';
  if (named.length === 0) {
    throw fail('LOCAL_NODE_TOOLS_CONFIG_INVALID', 'The tool configuration for this session is not a file path, so the session was not started with it.');
  }
  const driveless = process.platform === 'win32' && /^[\\/](?![\\/])/.test(named);
  if (!path.isAbsolute(named) || driveless) {
    throw fail('LOCAL_NODE_TOOLS_CONFIG_RELATIVE', 'The tool configuration has to be named by a full path, so the session reads the file the plan wrote and not one from the project folder.');
  }
  const readFile = dependencies.readFile || (file => fs.readFileSync(file, 'utf8'));
  let document;
  try {
    document = JSON.parse(readFile(path.resolve(named)));
  } catch (error) {
    throw fail('LOCAL_NODE_TOOLS_CONFIG_UNREADABLE', 'The tool configuration the plan wrote could not be read, so the session was not started.', { mcpConfig: named }, error);
  }
  return createToolSurface({ document, env, cwd, transportFor: dependencies.transportFor || createMcpStdioTransport }).open();
}

module.exports = {
  CLIENT_INFO,
  DEFAULT_CALL_TIMEOUT_MS,
  MAX_RESULT_CHARS,
  PROTOCOL_VERSION,
  createMcpClient,
  createMcpStdioTransport,
  createToolSurface,
  loadToolSurfaceFromPlan
};

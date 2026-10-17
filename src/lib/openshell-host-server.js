'use strict';

// THE TOOLSENABLED HOST OUTSIDE THE OPENSHELL SANDBOXES.
// See adapters/openshell/HOST-OUTSIDE.md.
//
// Inside one sandbox, ToolsEnabled's settings, ledger and signed audit live in
// files every agent there can edit. This serves those tools from the machine
// that runs OpenShell instead, over MCP's streamable HTTP transport, so agents
// reach them only as MCP calls to http://host.openshell.internal:<port>/mcp/<grant>.
//
// - Listens on 127.0.0.1 only. With OpenShell's Docker driver the sandbox's
//   traffic leaves through the supervisor, which reaches the host's loopback.
// - Each grant (src/lib/openshell-host-grants.js) has its own path,
//   /mcp/<grant id>, and its own bearer token, which only an OpenShell
//   provider holds. The sandbox holds OpenShell's placeholder for it; the CLI
//   sends the placeholder and OpenShell's proxy swaps it for the token. The
//   sandbox policy binds that provider's credential to that path alone
//   (credential_binding) for one CLI's executable, with `protocol: mcp` rules
//   naming the tools it may call. OpenShell 0.1.2 binds a placeholder to an
//   endpoint, not to a program, so the separate path is what keeps one CLI's
//   placeholder from resolving on another CLI's route.
// - The token must belong to the path's grant. The grant names the actor and
//   the tools; the actor is never read from the request, and a call outside
//   the grant's tools is refused here as well as by OpenShell.
// - What a grant proves is which sandbox rule let the request through, not
//   which agent sent it: OpenShell matches a rule on the calling program OR
//   ANY ANCESTOR, so every process a CLI starts, and any process that can
//   start that CLI, travels under its grant. The host applies its own rules to
//   every call whoever sent it.
// - Calls run through the same dispatcher as the stdio server (src/mcp-server.js):
//   the same schemas, permission level, refusals and signed audit.
//
// Answers are plain JSON (no server-sent events): every host tool answers in
// one reply, and the spec lets a server do that. GET and DELETE are refused
// with 405, which the spec allows for servers that offer neither.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const grantsModule = require('./openshell-host-grants');
const { OPENSHELL_HOST_TOOLS } = require('./openshell-host-tools');

const MCP_PREFIX = '/mcp/';
const PLACEHOLDER_PREFIX = 'openshell:resolve:';
const MAX_BODY_BYTES = 1024 * 1024;
const DRAIN_LIMIT_BYTES = 16 * MAX_BODY_BYTES;
const MAX_SESSIONS = 256;
const { DEFAULT_HOST_PORT: DEFAULT_PORT } = require('./openshell-host-reach');

// Refusals before any tool runs. Each has its own sentence; none echoes what
// the caller sent.
const REFUSALS = Object.freeze({
  HOST_ROUTE_UNKNOWN: [404, 'The ToolsEnabled host serves MCP at /mcp/<grant id> only.'],
  HOST_ORIGIN_REFUSED: [403, 'The ToolsEnabled host does not answer browser requests.'],
  HOST_HOST_REFUSED: [403, 'The ToolsEnabled host answers only requests addressed to it by one of its own names.'],
  HOST_TOKEN_MISSING: [401, 'The ToolsEnabled host needs the bearer token OpenShell\'s proxy swaps in for this CLI\'s placeholder. None arrived: check that the provider for this grant is attached to the sandbox and that the CLI sends its placeholder as a Bearer token.'],
  HOST_TOKEN_PLACEHOLDER: [403, 'OpenShell did not substitute its placeholder, so the host received the placeholder itself. The program that sent it is not one the provider covers, or the request did not go to the provider\'s endpoint.'],
  HOST_TOKEN_REFUSED: [403, 'The ToolsEnabled host does not know this token. It may have been removed with `toolsenabled-authority grant remove`.'],
  HOST_PATH_NOT_GRANTED: [403, 'This token belongs to another grant\'s path on the host. Each agent CLI has its own path, bound to its own OpenShell provider.'],
  HOST_METHOD_NOT_ALLOWED: [405, 'The ToolsEnabled host takes MCP messages by POST only; it offers no event stream and no session deletion.'],
  HOST_CONTENT_TYPE: [415, 'The ToolsEnabled host takes application/json only.'],
  HOST_BODY_TOO_LARGE: [413, `An MCP message to the ToolsEnabled host is at most ${MAX_BODY_BYTES} bytes.`],
  HOST_PARSE_ERROR: [400, 'The request body is not JSON.'],
  HOST_BATCH_REFUSED: [400, 'The ToolsEnabled host takes one JSON-RPC message per request.'],
  HOST_SESSION_REQUIRED: [400, 'Send the Mcp-Session-Id header the host returned from initialize.'],
  HOST_SESSION_UNKNOWN: [404, 'This MCP session is not known to the host (it restarted, or the session belongs to another grant or path). Initialize again.']
});

const RPC_CODES = Object.freeze({ 400: -32600, 401: -32001, 403: -32001, 404: -32001, 405: -32000, 413: -32600, 415: -32600 });

/** The grant a path belongs to: /mcp/<grant id>, and nothing else. */
function routeOf(pathname) {
  if (!pathname.startsWith(MCP_PREFIX)) return null;
  const grant = pathname.slice(MCP_PREFIX.length);
  return grantsModule.GRANT_ID_RE.test(grant) ? Object.freeze({ key: pathname, grant }) : null;
}

function bearerOf(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
  return match ? match[1] : '';
}

function hostInstructions(grant, tools) {
  return [
    'ToolsEnabled host, outside your OpenShell sandbox.',
    'It keeps the person\'s settings, the ledger of asks, tasks and standing rules, and the signed audit record in files no process in your sandbox can reach; these tools are the only way to them.',
    `This connection is the host's grant for ${grant.actor}: OpenShell's proxy swaps your CLI's placeholder for that grant's token, and what you file is labelled ${grant.actor}. Pass actor "${grant.actor}" where a tool asks for one.`,
    `Offered here: ${tools.join(', ')}.`,
    'The person answers questions with `toolsenabled-authority ask` and decides on ledger entries with `toolsenabled-authority ledger` on the machine that runs OpenShell.'
  ].join(' ');
}

// What a client said about itself when it opened a session, for the access
// log: the MCP revision it asked for, the one the host answered with, and its
// name and version. Text only, cut short; never used to decide anything.
function initializeFacts(message, reply) {
  const facts = require('./mcp-revisions').facts(message?.params, reply?.result?.protocolVersion);
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== null));
}

// WHERE THE HOST KEEPS THE PERSON'S RECORDS IS NOT THE SANDBOX'S BUSINESS.
// The stdio tools report their files for a person at their own terminal:
// settings.read names its values file (and each read-only setting's source),
// audit.status its database and state file. Served to a sandbox those are
// paths on the machine that runs OpenShell, under the host's root: no process
// there can open them, and all they give whoever is inside is a map of the host.
// So on this HTTP surface only, any path under the host's root in a tool's
// result (structured or text, success or refusal) becomes HOST_PATH_TEXT.
// Values and everything else in the result are unchanged; the host's own
// pages still show the real paths to the person.
const HOST_PATH_TEXT = 'kept on the ToolsEnabled host';

function rootSpellings(root) {
  const spellings = new Set([path.resolve(root)]);
  try { spellings.add(fs.realpathSync.native(root)); } catch { /* not created yet: the given spelling only */ }
  return [...spellings].filter((spelling) => spelling !== path.parse(spelling).root);
}

// A root ends at a path separator or at the end of the path, so a sibling
// folder whose name merely starts with the root's name is left alone. A path
// ends at white space, a quote or the punctuation that closes a sentence part.
function withoutHostPaths(value, roots) {
  if (typeof value === 'string') {
    return roots.reduce((text, root) => {
      if (!text.includes(root)) return text;
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return text.replace(new RegExp(`${escaped}(?=$|[\\\\/\\s"'\`,;:)\\]}])(?:[\\\\/][^\\s"'\`,;:)\\]}]*)?`, 'g'), HOST_PATH_TEXT);
    }, value);
  }
  if (Array.isArray(value)) return value.map((item) => withoutHostPaths(item, roots));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutHostPaths(item, roots)]));
  }
  return value;
}

// A text block is usually the result as compact JSON (src/mcp-server.js
// toolResult). It is cleaned as JSON, so an escaped path (a Windows root's
// doubled backslashes) is found too, and written back in the same compact form.
function resultWithoutHostPaths(result, roots) {
  const cleaned = withoutHostPaths(result, roots);
  if (!Array.isArray(result.content)) return cleaned;
  cleaned.content = result.content.map((item) => {
    if (!item || item.type !== 'text' || typeof item.text !== 'string'
      || !roots.some((root) => item.text.includes(root) || item.text.includes(JSON.stringify(root).slice(1, -1)))) {
      return withoutHostPaths(item, roots);
    }
    try {
      return { ...item, text: JSON.stringify(withoutHostPaths(JSON.parse(item.text), roots)) };
    } catch {
      return withoutHostPaths(item, roots);
    }
  });
  return cleaned;
}

/**
 * The host server. `root` is the host's state root (never inside a sandbox);
 * the caller has already pointed the engine's state at it
 * (bin/toolsenabled-openshell-host.js does, before any engine module loads).
 */
function createHostServer({
  root,
  port = DEFAULT_PORT,
  served = OPENSHELL_HOST_TOOLS,
  hostNames = ['host.openshell.internal', '127.0.0.1', 'localhost'],
  permissionSession,
  dispatcher,
  readGrants = () => grantsModule.readGrants(root, { served }),
  accessLog = path.join(root, 'openshell-host', 'access.jsonl'),
  now = () => new Date()
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('The host root must be an absolute path.');
  const handle = dispatcher || require('../mcp-server').createLineDispatcher();
  const session = permissionSession || require('./permission-tier-policy').effectiveSession(
    require('./agents/permission-level').leadLevel({ registry: require('./agents/registry').activeRegistry() }).level);
  const allowedHosts = new Set(hostNames.map((name) => `${name}:${port}`.toLowerCase()));
  const hostRoots = rootSpellings(root);
  const sessions = new Map();
  const fileScopes = new Map();
  fs.mkdirSync(path.dirname(accessLog), { recursive: true, mode: 0o700 });

  function logAccess(entry) {
    try {
      fs.appendFileSync(accessLog, `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch { /* the log is evidence, never a reason to refuse a call */ }
  }

  function send(response, status, body, headers = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    response.writeHead(status, {
      'cache-control': 'no-store',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    });
    response.end(text);
  }

  function refuse(response, code, extra = {}, headers = {}) {
    const [status, message] = REFUSALS[code];
    logAccess({ outcome: 'refused', code, http: status, ...extra });
    send(response, status, { jsonrpc: '2.0', id: null, error: { code: RPC_CODES[status] || -32000, message, data: { code } } }, headers);
  }

  function scopeFor(grant) {
    if (!fileScopes.has(grant.id)) fileScopes.set(grant.id, require('./file-tool-context').createFileToolContext({ scopeKind: 'standalone-mcp' }));
    return fileScopes.get(grant.id);
  }

  function remember(sessionId, value) {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    sessions.set(sessionId, value);
  }

  // A body over the limit is read to its end and dropped, so the client gets
  // its 413; past DRAIN_LIMIT_BYTES the connection is simply closed.
  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > DRAIN_LIMIT_BYTES) { request.destroy(); reject(new Error('too large')); return; }
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      request.on('end', () => (size > MAX_BODY_BYTES ? reject(new Error('too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
      request.on('error', reject);
    });
  }

  async function serve(request, response) {
    const url = new URL(request.url, 'http://host.invalid');
    const where = {
      path: url.pathname,
      method: request.method,
      hostHeader: String(request.headers.host || '').slice(0, 120),
      userAgent: String(request.headers['user-agent'] || '').slice(0, 120),
      ...(request.headers['mcp-protocol-version'] === undefined ? {} : { mcpProtocolVersion: String(request.headers['mcp-protocol-version']).slice(0, 40) })
    };
    const route = routeOf(url.pathname);
    if (route === null) return refuse(response, 'HOST_ROUTE_UNKNOWN', where);
    if (request.headers.origin !== undefined) return refuse(response, 'HOST_ORIGIN_REFUSED', where);
    if (!allowedHosts.has(String(request.headers.host || '').toLowerCase())) return refuse(response, 'HOST_HOST_REFUSED', where);

    const presented = bearerOf(request);
    if (presented === null || presented === '') return refuse(response, 'HOST_TOKEN_MISSING', where);
    if (presented.startsWith(PLACEHOLDER_PREFIX)) return refuse(response, 'HOST_TOKEN_PLACEHOLDER', where);
    const grant = grantsModule.grantForToken(readGrants(), presented);
    if (grant === null) return refuse(response, 'HOST_TOKEN_REFUSED', where);
    const who = { ...where, grant: grant.id, actor: grant.actor };
    if (route.grant !== grant.id) return refuse(response, 'HOST_PATH_NOT_GRANTED', { ...who, pathGrant: route.grant });
    const tools = grant.tools;

    if (request.method !== 'POST') return refuse(response, 'HOST_METHOD_NOT_ALLOWED', who, { allow: 'POST' });
    if (!/^application\/json\b/i.test(String(request.headers['content-type'] || ''))) return refuse(response, 'HOST_CONTENT_TYPE', who);
    let body;
    try { body = await readBody(request); } catch { return refuse(response, 'HOST_BODY_TOO_LARGE', who); }
    let message;
    try { message = JSON.parse(body); } catch { return refuse(response, 'HOST_PARSE_ERROR', who); }
    if (Array.isArray(message)) return refuse(response, 'HOST_BATCH_REFUSED', who);

    const method = message && typeof message === 'object' ? message.method : undefined;
    const tool = method === 'tools/call' && message.params && typeof message.params.name === 'string' ? message.params.name.slice(0, 80) : undefined;
    const headers = {};
    if (method === 'initialize') {
      const sessionId = crypto.randomBytes(16).toString('hex');
      remember(sessionId, { grant: grant.id, route: route.key });
      headers['mcp-session-id'] = sessionId;
    } else {
      const sessionId = request.headers['mcp-session-id'];
      if (typeof sessionId !== 'string' || sessionId === '') return refuse(response, 'HOST_SESSION_REQUIRED', { ...who, rpc: method });
      const known = sessions.get(sessionId);
      if (!known || known.grant !== grant.id || known.route !== route.key) return refuse(response, 'HOST_SESSION_UNKNOWN', { ...who, rpc: method });
    }

    const written = [];
    await handle(JSON.stringify(message), (value) => written.push(value), {
      agentActor: grant.actor,
      recordMcpRevision: false,
      personChannelFrom: `${grant.actor} (${grant.id})`,
      // Rotation starts a new instance; an old uncollected answer cannot follow it.
      personChannelScope: grant.tokenSha256,
      allowedToolNames: tools,
      permissionSession: session,
      fileToolContext: scopeFor(grant)
    }, `host:${grant.id}`);

    const reply = written.find((value) => value && Object.prototype.hasOwnProperty.call(value, 'id')) || written[0];
    const opened = method === 'initialize' ? initializeFacts(message, reply) : {};
    if (reply === undefined) {
      logAccess({ ...who, rpc: method, ...opened, outcome: 'accepted', http: 202 });
      response.writeHead(202, { 'cache-control': 'no-store', ...headers });
      return response.end();
    }
    if (method === 'initialize' && reply.result && typeof reply.result === 'object') {
      require('./mcp-revisions').record(grant.actor, message.params, reply.result.protocolVersion, { root: path.join(root, 'state'), now });
      reply.result.instructions = hostInstructions(grant, tools);
      reply.result.serverInfo = { ...(reply.result.serverInfo || {}), name: 'toolsenabled-authority' };
    }
    if (method === 'tools/list' && Array.isArray(reply.result?.tools)) {
      reply.result.tools = reply.result.tools.map(entry => ({ ...entry,
        description: entry.description.replaceAll('toolsenabled approvals', 'toolsenabled-authority ask')
          .replaceAll('toolsenabled watch', 'toolsenabled-authority watch') }));
    }
    if (method === 'tools/call' && reply.result && typeof reply.result === 'object') {
      reply.result = resultWithoutHostPaths(reply.result, hostRoots);
    }
    const failed = reply.error !== undefined;
    const toolFailed = !failed && reply.result && reply.result.isError === true;
    const errorCode = toolFailed && reply.result.structuredContent && reply.result.structuredContent.error
      ? reply.result.structuredContent.error.code : failed ? reply.error.code : undefined;
    logAccess({ ...who, rpc: method, ...opened, ...(tool ? { tool } : {}), outcome: failed ? 'rpc-error' : toolFailed ? 'tool-error' : 'result', ...(errorCode !== undefined ? { code: errorCode } : {}), http: 200 });
    return send(response, 200, reply, headers);
  }

  const server = http.createServer((request, response) => {
    serve(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'The ToolsEnabled host could not answer this request.' } });
      else response.end();
    });
  });
  server.hostSessions = sessions;
  return server;
}

module.exports = Object.freeze({
  DEFAULT_PORT, HOST_PATH_TEXT, MAX_BODY_BYTES, MCP_PREFIX, PLACEHOLDER_PREFIX, REFUSALS,
  bearerOf, createHostServer, hostInstructions, initializeFacts, resultWithoutHostPaths, routeOf
});

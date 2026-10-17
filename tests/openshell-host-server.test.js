'use strict';

// The MCP transport of the ToolsEnabled host outside the OpenShell sandboxes
// (src/lib/openshell-host-server.js), with a stand-in dispatcher: who may
// reach which path with which token, and what the host takes from a request
// (nothing about identity) and what it logs (never the token).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const grantsModule = require('../src/lib/openshell-host-grants');
const hostServer = require('../src/lib/openshell-host-server');

async function started({ toolResult } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-host-server-'));
  const claude = grantsModule.createGrant(root, { id: 'claude-dev', actor: 'claude', tools: 'settings.read,a_ledger.file' });
  const codex = grantsModule.createGrant(root, { id: 'codex-dev', actor: 'codex', tools: 'ledger.read' });
  const seen = [];
  const dispatcher = async (line, write, options, lane) => {
    const message = JSON.parse(line);
    seen.push({ message, options, lane });
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    if (message.method === 'initialize') {
      write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'toolsenabled', version: 'test' } } });
    } else {
      write({ jsonrpc: '2.0', id: message.id, result: toolResult ? toolResult(root, message) : { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } } });
    }
  };
  const port = await new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
  });
  const server = hostServer.createHostServer({ root, port, dispatcher, permissionSession: Object.freeze({ tier: 'test' }) });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { root, port, server, seen, claude, codex };
}

function send(port, { pathname = '/mcp/claude-dev', method = 'POST', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const request = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { host: `host.openshell.internal:${port}`, 'content-type': 'application/json', ...headers }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, raw, json: raw ? JSON.parse(raw) : undefined });
      });
    });
    request.on('error', reject);
    if (text !== undefined) request.write(text);
    request.end();
  });
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '9.9.9' } } };
const bearer = (token) => ({ authorization: `Bearer ${token}` });

test('a grant\'s token on its own path opens a session; calls run as the grant\'s actor with only its tools', async (t) => {
  const context = await started();
  t.after(() => context.server.close());
  const opened = await send(context.port, { headers: bearer(context.claude.token), body: initialize });
  assert.equal(opened.status, 200);
  const sessionId = opened.headers['mcp-session-id'];
  assert.match(sessionId, /^[0-9a-f]{32}$/);
  assert.equal(opened.json.result.serverInfo.name, 'toolsenabled-authority');
  assert.match(opened.json.result.instructions, /grant for claude/);
  assert.match(opened.json.result.instructions, /settings\.read, a_ledger\.file/);

  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'a_ledger.file', arguments: { actor: 'codex', scope: 'global', words: 'x' } } };
  const answered = await send(context.port, { headers: { ...bearer(context.claude.token), 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-11-25' }, body: call });
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.json.result.structuredContent, { ok: true });
  const dispatched = context.seen.find((entry) => entry.message.id === 2);
  assert.equal(dispatched.options.agentActor, 'claude', 'the actor comes from the grant, never from the request');
  assert.deepEqual([...dispatched.options.allowedToolNames], ['settings.read', 'a_ledger.file']);
  assert.equal(dispatched.lane, 'host:claude-dev');

  const note = await send(context.port, { headers: { ...bearer(context.claude.token), 'mcp-session-id': sessionId }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(note.status, 202);
  assert.equal(note.raw, '');
});

test('requests without the grant\'s real token, on the wrong path or from a browser are refused before any tool runs', async (t) => {
  const context = await started();
  t.after(() => context.server.close());
  const refusedWith = async (request, status, code) => {
    const before = context.seen.length;
    const answer = await send(context.port, { body: initialize, ...request });
    assert.equal(answer.status, status, code);
    assert.equal(answer.json.error.data.code, code);
    assert.equal(context.seen.length, before, `${code}: nothing may be dispatched`);
    return answer;
  };
  await refusedWith({}, 401, 'HOST_TOKEN_MISSING');
  await refusedWith({ headers: { authorization: 'Basic abc' } }, 401, 'HOST_TOKEN_MISSING');
  await refusedWith({ headers: bearer('openshell:resolve:env:TE_HOST_CLAUDE') }, 403, 'HOST_TOKEN_PLACEHOLDER');
  await refusedWith({ headers: bearer(`te-host-${'B'.repeat(43)}`) }, 403, 'HOST_TOKEN_REFUSED');
  await refusedWith({ headers: bearer(context.codex.token) }, 403, 'HOST_PATH_NOT_GRANTED');
  await refusedWith({ pathname: '/mcp/../admin', headers: bearer(context.claude.token) }, 404, 'HOST_ROUTE_UNKNOWN');
  await refusedWith({ pathname: '/admin', headers: bearer(context.claude.token) }, 404, 'HOST_ROUTE_UNKNOWN');
  await refusedWith({ headers: { ...bearer(context.claude.token), origin: 'http://evil.example' } }, 403, 'HOST_ORIGIN_REFUSED');
  await refusedWith({ headers: { ...bearer(context.claude.token), host: `evil.example:${context.port}` } }, 403, 'HOST_HOST_REFUSED');
  const get = await refusedWith({ method: 'GET', body: undefined, headers: bearer(context.claude.token) }, 405, 'HOST_METHOD_NOT_ALLOWED');
  assert.equal(get.headers.allow, 'POST');
  await refusedWith({ method: 'DELETE', body: undefined, headers: bearer(context.claude.token) }, 405, 'HOST_METHOD_NOT_ALLOWED');
  await refusedWith({ headers: { ...bearer(context.claude.token), 'content-type': 'text/plain' } }, 415, 'HOST_CONTENT_TYPE');
  await refusedWith({ headers: bearer(context.claude.token), body: 'not json' }, 400, 'HOST_PARSE_ERROR');
  await refusedWith({ headers: bearer(context.claude.token), body: [initialize] }, 400, 'HOST_BATCH_REFUSED');
  await refusedWith({ headers: bearer(context.claude.token), body: 'x'.repeat(hostServer.MAX_BODY_BYTES + 1) }, 413, 'HOST_BODY_TOO_LARGE');
  const call = { jsonrpc: '2.0', id: 3, method: 'tools/list' };
  await refusedWith({ headers: bearer(context.claude.token), body: call }, 400, 'HOST_SESSION_REQUIRED');
  await refusedWith({ headers: { ...bearer(context.claude.token), 'mcp-session-id': 'f'.repeat(32) }, body: call }, 404, 'HOST_SESSION_UNKNOWN');
});

test('a session opened by one grant is unknown to another grant', async (t) => {
  const context = await started();
  t.after(() => context.server.close());
  const opened = await send(context.port, { pathname: '/mcp/codex-dev', headers: bearer(context.codex.token), body: initialize });
  const sessionId = opened.headers['mcp-session-id'];
  const answer = await send(context.port, { headers: { ...bearer(context.claude.token), 'mcp-session-id': sessionId }, body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
  assert.equal(answer.status, 404);
  assert.equal(answer.json.error.data.code, 'HOST_SESSION_UNKNOWN');
});

test('the access log records what each request carried, and never a token', async (t) => {
  const context = await started();
  t.after(() => context.server.close());
  const opened = await send(context.port, { headers: bearer(context.claude.token), body: initialize });
  await send(context.port, { headers: { ...bearer(context.claude.token), 'mcp-session-id': opened.headers['mcp-session-id'], 'mcp-protocol-version': '2025-11-25' }, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'settings.read', arguments: {} } } });
  await send(context.port, { headers: bearer(context.codex.token), body: initialize });
  const text = fs.readFileSync(path.join(context.root, 'openshell-host', 'access.jsonl'), 'utf8');
  for (const token of [context.claude.token, context.codex.token]) assert.equal(text.includes(token.slice(8)), false);
  const lines = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(
    { rpc: lines[0].rpc, grant: lines[0].grant, actor: lines[0].actor, requested: lines[0].requestedProtocolVersion, answered: lines[0].answeredProtocolVersion, client: lines[0].clientName, host: lines[0].hostHeader },
    { rpc: 'initialize', grant: 'claude-dev', actor: 'claude', requested: '2025-11-25', answered: '2025-11-25', client: 'claude-code', host: `host.openshell.internal:${context.port}` }
  );
  assert.equal(lines[1].tool, 'settings.read');
  assert.equal(lines[1].mcpProtocolVersion, '2025-11-25');
  assert.equal(lines[2].code, 'HOST_PATH_NOT_GRANTED');
  assert.equal(lines[2].outcome, 'refused');
  assert.equal(fs.statSync(path.join(context.root, 'openshell-host', 'access.jsonl')).mode & 0o777, 0o600);
});

test('a tool result names no path under the host\'s root; its values and other text are unchanged', async (t) => {
  // What settings.read and audit.status report from the stdio dispatcher: their
  // files under the host's root, here as a stand-in result and a refusal.
  const toolResult = (root, message) => {
    const output = message.params.name === 'settings.read'
      ? { values: { 'audit.enabled': true }, valuesPath: path.join(root, 'data', 'root', 'settings.json'),
        readbacks: { 'capability.tier': { authorityPath: path.join(root, 'state', 'setup.json') } },
        elsewhere: `${root}-other/kept.json`, note: 'Settings change only on the host.' }
      : { ok: true, path: path.join(root, 'state', 'state', 'audit.sqlite3'), durability: { stateFile: root } };
    return message.params.name === 'audit.verify'
      ? { isError: true, content: [{ type: 'text', text: `Could not open ${path.join(root, 'state', 'x.db')}: denied.` }], structuredContent: { error: { code: 'X', message: `Could not open ${path.join(root, 'state', 'x.db')}: denied.` } } }
      : { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  };
  const context = await started({ toolResult });
  t.after(() => context.server.close());
  const grant = grantsModule.createGrant(context.root, { id: 'reader', actor: 'claude', tools: 'settings.read,audit.status,audit.verify' });
  const opened = await send(context.port, { pathname: '/mcp/reader', headers: bearer(grant.token), body: initialize });
  const headers = { ...bearer(grant.token), 'mcp-session-id': opened.headers['mcp-session-id'], 'mcp-protocol-version': '2025-11-25' };
  const call = (id, name) => send(context.port, { pathname: '/mcp/reader', headers, body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } } });
  const settings = await call(2, 'settings.read'), status = await call(3, 'audit.status'), refused = await call(4, 'audit.verify');
  for (const reply of [settings, status, refused]) {
    assert.equal(reply.status, 200);
    assert.equal(reply.raw.includes(context.root + path.sep), false, 'no path under the host root reaches the caller');
  }
  const kept = hostServer.HOST_PATH_TEXT;
  assert.deepEqual(settings.json.result.structuredContent, { values: { 'audit.enabled': true }, valuesPath: kept,
    readbacks: { 'capability.tier': { authorityPath: kept } }, elsewhere: `${context.root}-other/kept.json`, note: 'Settings change only on the host.' });
  assert.deepEqual(JSON.parse(settings.json.result.content[0].text), settings.json.result.structuredContent, 'the text copy says the same');
  assert.deepEqual(status.json.result.structuredContent, { ok: true, path: kept, durability: { stateFile: kept } });
  assert.equal(refused.json.result.structuredContent.error.message, `Could not open ${kept}: denied.`);
  assert.equal(refused.json.result.content[0].text, `Could not open ${kept}: denied.`);
});

test('only /mcp/<grant id> is a route', () => {
  assert.deepEqual({ ...hostServer.routeOf('/mcp/claude-dev') }, { key: '/mcp/claude-dev', grant: 'claude-dev' });
  for (const pathname of ['/mcp/', '/mcp', '/mcp/Claude', '/mcp/claude-dev/', '/mcp/claude-dev/x', '/other/claude-dev']) {
    assert.equal(hostServer.routeOf(pathname), null, pathname);
  }
  assert.throws(() => hostServer.createHostServer({ root: 'relative' }), /absolute/);
});

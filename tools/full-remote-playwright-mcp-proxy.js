#!/usr/bin/env node
'use strict';

// Stdio MCP facade for the peer's reviewed Playwright gateway. Transport is
// the same authenticated/encrypted FRA v2 session used by
// toolsenabled-full-remote. The peer still owns the browser profile, CDP
// endpoint, policy, egress gates, and audit; this adapter never receives a CDP
// URL or credential.

process.env.TOOLSENABLED_FULL_REMOTE_ACCESS_PROFILE = '1';
// The default dial port comes from config/service-registry.json, not from a
// literal here. remote-agent-mcp-proxy's validateTarget() now pins against that
// same declaration, so a literal '8790' would be refused outright the moment the
// registry declared anything else -- the dialler arguing with the configuration
// rather than following it. 8790 remains the fallback for a registry that
// declares nothing, and an explicitly-set env var still wins.
if (!process.env.REMOTE_AGENT_PROXY_PORT) {
  const { declaredPort } = require('../src/lib/service-registry');
  process.env.REMOTE_AGENT_PROXY_PORT = String(declaredPort('full-remote-access', 8790));
}

const readline = require('node:readline');
const { RemoteAgentMcpProxy } = require('./remote-agent-mcp-proxy');
const { redactPlaywrightResponse } = require('../src/playwright-gateway');

const MAX_LINE_BYTES = 1024 * 1024;
const METHODS = new Set([
  'initialize', 'notifications/initialized', 'notifications/cancelled',
  'ping', 'tools/list', 'tools/call'
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return value === null || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Z0-9_.-]{1,80}$/.test(code) ? code : 'REMOTE_PLAYWRIGHT_UNAVAILABLE';
}

function rpcError(id, error) {
  return {
    jsonrpc: '2.0', id: validId(id) ? id : null,
    error: {
      code: -32001,
      message: 'Remote Playwright is unavailable.',
      data: { code: safeCode(error) }
    }
  };
}

function unwrapToolList(remoteResponse) {
  const surface = remoteResponse?.result?.structuredContent?.tools;
  if (!Array.isArray(surface) || surface.some(tool => !plainObject(tool)
      || typeof tool.name !== 'string' || !/^browser_[a-z0-9_]+$/.test(tool.name)
      || !plainObject(tool.inputSchema))) {
    throw codedError('REMOTE_PLAYWRIGHT_TOOL_SURFACE_INVALID');
  }
  if (new Set(surface.map(tool => tool.name)).size !== surface.length) {
    throw codedError('REMOTE_PLAYWRIGHT_TOOL_SURFACE_INVALID');
  }
  return JSON.parse(JSON.stringify(surface));
}

function unwrapToolCall(remoteResponse) {
  const upstream = redactPlaywrightResponse(
    remoteResponse?.result?.structuredContent?.upstreamResponse
  );
  if (!plainObject(upstream) || upstream.jsonrpc !== '2.0') {
    throw codedError('REMOTE_PLAYWRIGHT_RESPONSE_INVALID');
  }
  const hasResult = Object.hasOwn(upstream, 'result');
  const hasError = Object.hasOwn(upstream, 'error');
  if (hasResult === hasError || (hasResult && !plainObject(upstream.result))
      || (hasError && !plainObject(upstream.error))) {
    throw codedError('REMOTE_PLAYWRIGHT_RESPONSE_INVALID');
  }
  return JSON.parse(JSON.stringify(upstream));
}

class FullRemotePlaywrightMcpProxy {
  constructor(options = {}) {
    this.remote = options.remote || new RemoteAgentMcpProxy({ secureProfile: true });
    this.nextRemoteId = 1;
    this.remoteInitialization = null;
    this.closed = false;
  }

  _remoteRequest(method, params = {}) {
    const id = this.nextRemoteId++;
    return this.remote.request({ jsonrpc: '2.0', id, method, params });
  }

  async _ensureRemoteInitialized() {
    if (!this.remoteInitialization) {
      this.remoteInitialization = this._remoteRequest('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'full-remote-playwright-mcp-proxy', version: '1.0' }
      }).then(async response => {
        if (!plainObject(response?.result) || response.result.serverInfo?.name !== 'toolsenabled') {
          throw codedError('REMOTE_PLAYWRIGHT_INITIALIZE_FAILED');
        }
        // FRA refuses every tools/call until this connection has verified the
        // peer's exact tools/list count and digest. Prime that admission state
        // explicitly; never rely on a prior MCP client or session generation.
        const listed = await this._remoteRequest('tools/list', {});
        const names = listed?.result?.tools;
        if (!Array.isArray(names)
            || !names.some(tool => tool?.name === 'browser.playwright_tools')
            || !names.some(tool => tool?.name === 'browser.playwright_call')) {
          throw codedError('REMOTE_PLAYWRIGHT_FRA_SURFACE_INVALID');
        }
        return true;
      });
    }
    return this.remoteInitialization;
  }

  async handle(message) {
    if (!plainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
        || !METHODS.has(message.method)) {
      return rpcError(message && message.id, codedError('REMOTE_PLAYWRIGHT_METHOD_INVALID'));
    }
    if (message.method.startsWith('notifications/')) return null;
    if (!validId(message.id)) return rpcError(null, codedError('REMOTE_PLAYWRIGHT_ID_INVALID'));
    try {
      await this._ensureRemoteInitialized();
      if (message.method === 'initialize') {
        return {
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'toolsenabled-full-remote-playwright', version: '1.0' }
          }
        };
      }
      if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
      if (message.method === 'tools/list') {
        const remote = await this._remoteRequest('tools/call', {
          name: 'browser.playwright_tools', arguments: {}
        });
        return { jsonrpc: '2.0', id: message.id, result: { tools: unwrapToolList(remote) } };
      }
      const name = message.params?.name;
      const args = message.params?.arguments;
      if (typeof name !== 'string' || !/^browser_[a-z0-9_]+$/.test(name) || !plainObject(args)) {
        throw codedError('REMOTE_PLAYWRIGHT_CALL_INVALID');
      }
      const remote = await this._remoteRequest('tools/call', {
        name: 'browser.playwright_call', arguments: { name, arguments: args }
      });
      const upstream = unwrapToolCall(remote);
      return upstream.error
        ? { jsonrpc: '2.0', id: message.id, error: upstream.error }
        : { jsonrpc: '2.0', id: message.id, result: upstream.result };
    } catch (error) {
      return rpcError(message.id, error);
    }
  }

  async close() {
    if (this.closed) return;
    this.remote._dropSocket(codedError('REMOTE_PLAYWRIGHT_PROXY_CLOSED'));
    this.remote.closed = true;
    this.closed = true;
  }

  run() {
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on('line', async line => {
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        process.stdout.write(`${JSON.stringify(rpcError(null, codedError('REMOTE_PLAYWRIGHT_MESSAGE_TOO_LARGE')))}\n`);
        return;
      }
      let message;
      try { message = JSON.parse(line); }
      catch {
        process.stdout.write(`${JSON.stringify(rpcError(null, codedError('REMOTE_PLAYWRIGHT_PARSE_ERROR')))}\n`);
        return;
      }
      const response = await this.handle(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
    input.on('close', () => { void this.close(); });
  }
}

if (require.main === module) new FullRemotePlaywrightMcpProxy().run();

module.exports = Object.freeze({
  MAX_LINE_BYTES,
  METHODS,
  FullRemotePlaywrightMcpProxy,
  unwrapToolList,
  unwrapToolCall
});

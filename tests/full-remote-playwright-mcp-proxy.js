'use strict';

const assert = require('node:assert/strict');
const {
  FullRemotePlaywrightMcpProxy,
  unwrapToolList,
  unwrapToolCall
} = require('../tools/full-remote-playwright-mcp-proxy');

const tools = [{
  name: 'browser_snapshot',
  description: 'snapshot',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
}];

assert.deepEqual(unwrapToolList({ result: { structuredContent: { tools } } }), tools);
assert.deepEqual(unwrapToolCall({ result: { structuredContent: {
  upstreamResponse: { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'ok' }] } }
} } }).result.content[0].text, 'ok');
const fakeCanary = 'PW-CANARY-AUTH-0123456789';
const redactedPeerResponse = unwrapToolCall({ result: { structuredContent: {
  upstreamResponse: { jsonrpc: '2.0', id: 5, result: {
    content: [{ type: 'text', text: `ordinary page text\nAuthorization: Bearer ${fakeCanary}\npassword=${fakeCanary}` }],
    structuredContent: {
      console: `token=${fakeCanary}`,
      network: { headers: { authorization: fakeCanary, cookie: fakeCanary } },
      snapshot: `Account heading remains\napi_key=${fakeCanary}`
    }
  } }
} } });
assert.equal(JSON.stringify(redactedPeerResponse).includes(fakeCanary), false);
assert.match(redactedPeerResponse.result.content[0].text, /ordinary page text/);
assert.match(redactedPeerResponse.result.structuredContent.snapshot, /Account heading remains/);
assert.throws(() => unwrapToolList({ result: { structuredContent: { tools: [{ name: 'bad', inputSchema: {} }] } } }),
  error => error && error.code === 'REMOTE_PLAYWRIGHT_TOOL_SURFACE_INVALID');

class FakeRemote {
  constructor() { this.calls = []; this.closed = false; }
  async request(message) {
    this.calls.push(message);
    if (message.method === 'initialize') {
      return { jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'toolsenabled' } } };
    }
    if (message.method === 'tools/list') {
      return { jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'browser.playwright_tools' }, { name: 'browser.playwright_call' }
      ] } };
    }
    if (message.params?.name === 'browser.playwright_tools') {
      return { jsonrpc: '2.0', id: message.id, result: { structuredContent: { tools } } };
    }
    if (message.params?.name === 'browser.playwright_call') {
      return { jsonrpc: '2.0', id: message.id, result: { structuredContent: {
        upstreamResponse: { jsonrpc: '2.0', id: 9, result: {
          content: [{ type: 'text', text: `peer-ok authorization=${fakeCanary}` }],
          structuredContent: { password: fakeCanary, ordinary: 'kept' }
        } }
      } } };
    }
    throw new Error('unexpected fake request');
  }
  _dropSocket() {}
}

async function run() {
  const remote = new FakeRemote();
  const proxy = new FullRemotePlaywrightMcpProxy({ remote });
  const initialized = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initialized.result.serverInfo.name, 'toolsenabled-full-remote-playwright');
  const listed = await proxy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(listed.result.tools, tools);
  const called = await proxy.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'browser_snapshot', arguments: {} }
  });
  assert.match(called.result.content[0].text, /^peer-ok/);
  assert.equal(JSON.stringify(called).includes(fakeCanary), false);
  assert.equal(called.result.structuredContent.ordinary, 'kept');
  const invalid = await proxy.handle({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'host_exec', arguments: {} }
  });
  assert.equal(invalid.error.data.code, 'REMOTE_PLAYWRIGHT_CALL_INVALID');
  assert.equal(remote.calls.filter(call => call.method === 'initialize').length, 1);
  assert.equal(remote.calls.filter(call => call.method === 'tools/list').length, 1);
  await proxy.close();
  assert.equal(remote.closed, true);

  const failingRemote = new FakeRemote();
  failingRemote._dropSocket = () => { throw new Error('socket cleanup failed'); };
  const failingProxy = new FullRemotePlaywrightMcpProxy({ remote: failingRemote });
  await assert.rejects(failingProxy.close(), /socket cleanup failed/);
  assert.equal(failingProxy.closed, false);
  assert.equal(failingRemote.closed, false);
  console.log('Full remote Playwright MCP facade contracts passed.');
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

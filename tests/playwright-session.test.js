'use strict';
require('./lib/isolated-environment').activate('playwright-session');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { PlaywrightSession } = require('../tools/playwright-call');
const { SAFE_BROWSER_TOOL_NAMES } = require('../src/playwright-gateway');

function fixture() {
  const frames = [], children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.exitCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let buffer = '', snapshot = false;
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        frames.push(message);
        if (message.id === undefined) continue;
        let result = { content: [{ type: 'text', text: 'done' }] };
        if (message.method === 'initialize') result = { serverInfo: { name: 'fixture' } };
        if (message.params?.name === 'browser_snapshot') { snapshot = true; result.content[0].text = '- button "Save" [ref=e7]'; }
        if (message.params?.name === 'browser_click') result.isError = !snapshot;
        queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'));
      }
      callback();
    }, final(callback) { child.exitCode = 0; child.emit('close', 0); callback(); } });
    children.push(child); return child;
  };
  return { frames, children, spawnImpl };
}
test('snapshot refs survive separate calls and concurrent actions remain ordered', async () => {
  const f = fixture(), session = new PlaywrightSession({ spawnImpl: f.spawnImpl });
  try {
    const snapshot = session.call({ tool: 'browser_snapshot', arguments: {} });
    const click = session.call({ tool: 'browser_click', arguments: { element: 'Save', ref: 'e7' } });
    await snapshot;
    assert.equal((await click).result.isError, false);
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.frames.filter(frame => frame.method === 'tools/call').map(frame => frame.params.name), ['browser_snapshot', 'browser_click']);
    assert.equal(f.frames.filter(frame => frame.method === 'initialize').length, 1);
  } finally { await session.close(); }
  await assert.rejects(session.call({ tool: 'browser_snapshot', arguments: {} }), { code: 'PLAYWRIGHT_CALL_SESSION_CLOSED' });
});
test('tab selection primes the current session and unsafe tools never reach transport', async () => {
  const f = fixture(), session = new PlaywrightSession({ spawnImpl: f.spawnImpl });
  try {
    await session.call({ tool: 'browser_tabs', arguments: { action: 'select', index: 1 } });
    assert.deepEqual(f.frames.filter(frame => frame.method === 'tools/call').map(frame => frame.params.arguments.action), ['list', 'select']);
    const count = f.frames.length;
    assert.throws(() => session.call({ tool: 'browser_evaluate', arguments: {} }));
    assert.equal(f.frames.length, count);
  } finally { await session.close(); }
});
// A Playwright MCP version is judged by the tools it offers, not by matching
// one pinned version's list. The recorded 0.0.82 tools/list stands in for the
// server; one optional tool missing limits the browser, one required tool
// missing is refused with a plain "update" reason.
function listingFixture(tools) {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.exitCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let buffer = '';
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.id === undefined) continue;
        const result = message.method === 'initialize' ? { serverInfo: { name: 'fixture' } } : { tools };
        queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'));
      }
      callback();
    }, final(callback) { child.exitCode = 0; child.emit('close', 0); callback(); } });
    return child;
  };
  return spawnImpl;
}
test('a Playwright MCP without an optional browser tool still lists its tools', async () => {
  const recorded = require('./fixtures/playwright-mcp-tools-0.0.82.json').tools
    .filter(tool => SAFE_BROWSER_TOOL_NAMES.includes(tool.name));
  assert.equal(recorded.length, SAFE_BROWSER_TOOL_NAMES.length);
  const withoutResize = recorded.filter(tool => tool.name !== 'browser_resize');
  const session = new PlaywrightSession({ spawnImpl: listingFixture(withoutResize) });
  try {
    const tools = await session.tools();
    assert.deepEqual(tools.map(tool => tool.name), withoutResize.map(tool => tool.name));
  } finally { await session.close(); }
  const missingRequired = recorded.filter(tool => tool.name !== 'browser_snapshot');
  const refused = new PlaywrightSession({ spawnImpl: listingFixture(missingRequired) });
  try {
    await assert.rejects(refused.tools(), error => error.code === 'PLAYWRIGHT_CALL_TOOL_SURFACE_MISMATCH'
      && /Update Playwright MCP/.test(error.message) && !/pinned/.test(error.message));
  } finally { await refused.close(); }
});

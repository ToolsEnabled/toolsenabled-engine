'use strict';
require('./lib/isolated-environment').activate('playwright-session-live');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { PlaywrightSession } = require('../tools/playwright-call');
const { normalizeBrowserArguments } = require('../src/playwright-gateway');

test('pinned Playwright retains selected tabs, refs, form state and visible action hooks', {
  skip: !process.env.TESTKIT_PLAYWRIGHT_ROOT, timeout: 45000
}, async () => {
  const kit = createRequire(path.join(process.env.TESTKIT_PLAYWRIGHT_ROOT, 'package.json'));
  const { chromium } = kit('playwright');
  const cli = path.join(path.dirname(kit.resolve('@playwright/mcp/package.json')), 'cli.js');
  const server = http.createServer((_request, response) => response.end('<html><title>Browser fixture</title><h1>Browser fixture</h1><input aria-label="Name"><button onclick="this.textContent=\'Saved\'">Save</button></html>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const portProbe = net.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-session-browser-'));
  let context, session;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true,
      ...(process.env.TESTKIT_BROWSER_EXECUTABLE ? { executablePath: process.env.TESTKIT_BROWSER_EXECUTABLE } : {}),
      args: [`--remote-debugging-port=${port}`] });
    await context.pages()[0].goto(`http://127.0.0.1:${server.address().port}/first`);
    const second = await context.newPage();
    await second.goto(`http://127.0.0.1:${server.address().port}/second`);
    session = new PlaywrightSession({ timeoutMs: 30000, spawnImpl: (_command, _args, options) =>
      spawn(process.execPath, [cli, '--cdp-endpoint', `http://127.0.0.1:${port}`,
        '--init-page', path.resolve(__dirname, '../src/lib/browser-action-cursor.js'),
        '--output-dir', path.join(profile, 'mcp-output')], options) });
    const call = async (tool, args = {}) => {
      const response = await session.call({ tool, arguments: normalizeBrowserArguments(tool, args) });
      assert.ok(!response.error && !response.result?.isError, JSON.stringify(response));
      return response.result;
    };
    // CDP discovery order can differ from the creating client's pages().
    // Select the actual target from this MCP session's own tab inventory.
    const tabs = await call('browser_tabs', { action: 'list' });
    const target = tabs.content.map(block => block.text || '').join('\n')
      .split('\n').find(line => line.endsWith(`](${second.url()})`));
    const index = /^- (\d+):/.exec(target || '')?.[1];
    assert.notEqual(index, undefined, 'the second page must be in the real MCP tab list');
    await call('browser_tabs', { action: 'select', index: Number(index) });
    const snapshot = await call('browser_snapshot');
    const text = snapshot.content.map(block => block.text || '').join('\n');
    assert.ok(text.split('\n').includes(`- Page URL: ${second.url()}`),
      'the selected page, independently of the tab inventory, must be the second fixture');
    const ref = /button "Save" \[ref=([^\]]+)\]/.exec(text)?.[1];
    assert.ok(ref, text);
    await call('browser_type', { target: 'input', text: 'Persistent session' });
    await call('browser_click', { ref });
    assert.equal(await second.locator('button').textContent(), 'Saved');
    assert.equal(await second.locator('input').inputValue(), 'Persistent session');
    assert.equal(await context.pages()[0].locator('input').inputValue(), '');
    const image = await call('browser_take_screenshot', { type: 'png' });
    assert.ok(image.content.some(block => block.type === 'image'), 'screenshots remain native image content');
  } finally {
    if (session) await session.close();
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

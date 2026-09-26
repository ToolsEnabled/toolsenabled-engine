'use strict';
require('./lib/isolated-environment').activate('mcp-tool-surface');
if (process.platform === 'win32') {
  require('./surface.registry/mcp-tool-surface.js');
} else {
  console.log('SKIP native Windows MCP surface launch contract: requires Windows PowerShell and named-pipe custody');
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

// agent-preflight is deliberately no-MCP and must not present a static
// registration as proof that this client advertised the server.
const root = path.resolve(__dirname, '..');
const fixtureRoot = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'mcp-preflight-'));
const fixtureHome = path.join(fixtureRoot, 'home');
const fixtureMcp = path.join(fixtureRoot, '.mcp.json');

try {
  fs.mkdirSync(fixtureHome, { recursive: true });
  fs.writeFileSync(fixtureMcp, JSON.stringify({
    mcpServers: {
      playwright: { command: 'node', args: ['fixture-playwright-server.js'] }
    }
  }), 'utf8');

  const environment = safeLaunchEnvironment(process.env, { context: 'mcp-tool-surface fixture' });
  environment.TOOLSENABLED_PREFLIGHT_HOME = fixtureHome;
  environment.TOOLSENABLED_PREFLIGHT_MCP_CONFIG_FILE = fixtureMcp;
  const report = JSON.parse(execFileSync(process.execPath, [
    path.join(root, 'tools', 'agent-preflight.js'), '--json'
  ], { cwd: root, env: environment, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000 }));
  assert.equal(report.mcp.connectionEvidence, 'configuration-only');
  assert.ok(report.mcp.unverified.includes('playwright'));
  assert.equal(report.mcp.declared.playwright.connection, 'unverified');
  assert.deepEqual(report.mcp.live, []);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

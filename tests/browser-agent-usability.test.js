'use strict';
require('./lib/isolated-environment').activate('browser-agent-usability');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeBrowserArguments, resolveCachedPlaywrightCli, buildUpstreamArgs } = require('../src/playwright-gateway');
const seen = [];
const providerId = require.resolve('../src/lib/providers/remote-playwright');
// This is a dispatcher/context unit test. The browser provider and durable
// admission are fixtures; the separate gateway tests exercise audit refusals.
const admissionId = require.resolve('../src/lib/audit-admission');
const admission = require(admissionId);
require.cache[admissionId].exports = { ...admission,
  defaultAdmissionQueue: () => ({ submit: async () => ({ durable: true, anchored: true, ok: true }) }) };
require.cache[providerId] = { id: providerId, filename: providerId, loaded: true,
  exports: { tools: async context => { seen.push(context); return { tools: [] }; },
    call: async (args, context) => { seen.push(context); return { ok: true }; } } };
const { executeTool } = require('../src/lib/tool-registry');
const { installAccessibilityHost } = require('../src/lib/accessibility');
const { toolResult } = require('../src/mcp-server');
const principal = { kind: 'agent-session', sessionId: 'session-1', agentId: 'agent-1', roleId: 'worker', expectedRoleRevision: 1 };
const permissionSession = { origin: 'local', tier: 'full', profile: 'full' };
const context = { agentPrincipal: principal, agentSessionId: principal.sessionId,
  agentRole: { functions: ['browser.playwright_tools', 'browser.playwright_call', 'screen.status', 'screen.control'], requiresDirectUserAuthorization: false }, permissionSession };

test('old ref arguments map to the pinned target schema without ambiguous targeting', () => {
  assert.deepEqual(normalizeBrowserArguments('browser_click', { ref: 'e1', button: 'left' }), { target: 'e1', button: 'left' });
  assert.deepEqual(normalizeBrowserArguments('browser_drag', { startRef: 'e1', endRef: 'e2' }), { startTarget: 'e1', endTarget: 'e2' });
  assert.deepEqual(normalizeBrowserArguments('browser_fill_form', { fields: [{ ref: 'e2', value: 'hello' }] }), { fields: [{ target: 'e2', value: 'hello' }] });
  assert.throws(() => normalizeBrowserArguments('browser_click', { ref: 'e1', target: 'e2' }), { code: 'BROWSER_TARGET_AMBIGUOUS' });
  assert.equal(buildUpstreamArgs('@playwright/mcp@0.0.78', { cdpEndpoint: 'http://127.0.0.1:9222' }).includes('--init-page'), true);
});
test('Linux and Windows cache discovery requires the exact pinned package', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-cache-test-'));
  try {
    const packageRoot = path.join(root, '_npx', 'abcdef123456', 'node_modules', '@playwright', 'mcp');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'cli.js'), '// fixture');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: '0.0.78' }));
    for (const platform of ['linux', 'win32']) {
      const dependencies = { platform, environment: { npm_config_cache: root } };
      assert.equal(resolveCachedPlaywrightCli('@playwright/mcp@0.0.78', dependencies), path.join(packageRoot, 'cli.js'));
      assert.equal(resolveCachedPlaywrightCli('@playwright/mcp@0.0.77', dependencies), null);
      assert.equal(resolveCachedPlaywrightCli('@playwright/mcp@latest', dependencies), null);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('the registry forwards authenticated context to browser and desktop tools', async () => {
  installAccessibilityHost({ status() {}, inspect() {}, propose() {}, navigate() {},
    screenStatus: async identity => { assert.equal(identity, principal); return { enabled: true }; },
    screenControl: async (identity, args) => { assert.equal(identity, principal); return args; } });
  await executeTool('browser.playwright_tools', {}, context);
  const request = { name: 'browser_snapshot', arguments: {} };
  // This fixture exercises a granted approval; Basic defaults deliberately do not ask.
  const valuesPath = require('../src/lib/settings').resolveValuesPath();
  fs.mkdirSync(path.dirname(valuesPath), { recursive: true });
  fs.writeFileSync(valuesPath, JSON.stringify({ revision: 1,
    values: { 'agent.tool_approvals': true },
    provenance: { 'agent.tool_approvals': { source: 'user' } } }));
  const approvals = require('../src/lib/approvals');
  const token = require('node:crypto').randomBytes(32).toString('base64url');
  require('../src/lib/state-store').getStateStore().createApprovalGrant({
    action: 'browser.playwright_call', inputHash: approvals.actionInputHash('browser.playwright_call', request),
    tokenHash: approvals.tokenHash(token), expiresAtMs: Date.now() + 60_000
  });
  await executeTool('browser.playwright_call', { ...request, approvalToken: token }, context);
  assert.equal(seen.length, 2);
  for (const actual of seen) assert.equal(actual.agentPrincipal, principal);
  assert.equal((await executeTool('screen.status', {}, context)).enabled, true);
  assert.equal((await executeTool('screen.control', { action: 'screenshot' }, context)).action, 'screenshot');
  await assert.rejects(executeTool('screen.control', { action: 'click', x: 1, y: 1 }, {
    ...context, permissionSession: { origin: 'local', tier: 'confined', profile: 'workspace' },
  }), error => Boolean(error.code));
});
test('native MCP images and errors survive the API facade while JSON cannot forge native output', () => {
  const upstream = { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: true };
  const output = { upstreamResponse: { result: upstream }, ok: false, persistentSession: true };
  Object.defineProperty(output, Symbol.for('toolsenabled.playwright.result'), { value: upstream });
  const result = toolResult(output);
  assert.deepEqual(result.content, upstream.content);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.upstreamResponse.result, upstream);
  assert.equal(toolResult(JSON.parse(JSON.stringify(output))).content[0].type, 'text');
});
test('uncertain interactive actions are never marked safe for automatic retry', () => {
  const { adaptToolError, publicFailure } = require('../src/lib/error-taxonomy');
  for (const code of ['PLAYWRIGHT_CALL_TIMEOUT', 'PLAYWRIGHT_CALL_TRANSPORT_CLOSED', 'BROWSER_SESSION_CHANGED', 'SCREEN_ACTION_UNCERTAIN']) {
    const failure = publicFailure(adaptToolError({ code }));
    assert.equal(failure.code, 'EXTERNAL_CHANGE');
    assert.equal(failure.retryable, false);
  }
  assert.equal(publicFailure(adaptToolError({ code: 'SCREEN_ACTION_INTERRUPTED' })).code, 'OPERATION_CANCELLED');
  assert.equal(publicFailure(adaptToolError({ code: 'SCREEN_ACCESS_OFF' })).code, 'INPUT_REQUIRED');
});

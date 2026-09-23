// EXECUTABLE CHANGE
// Report: testcanfail-tests-desktop-browser-playwright-gateway-js
// Strengthened assertion: resolveNpxInvocation() now has an unconditional
// result-shape/spawn-mode contract; its substantive assertions previously ran
// only when process.platform was win32 and the resolver selected its cache.
// Mutation: temporarily changed resolveNpxInvocation() in
// src/playwright-gateway.js to return
// `{ executable: '', prefix: [], source: 'broken' }`.
// RED (node tests/desktop.browser/playwright-gateway.js, exit 1):
// "AssertionError [ERR_ASSERTION]: npx resolution must identify one of the
// spawn modes understood by upstreamSpawnArgs"
// The source file was restored byte-for-byte (cmp succeeded).
// GREEN after restoration (same command, exit 0):
// "Playwright gateway intent/outcome tests passed."
// NOT-FOUND (1): no assertion iterates a product-supplied collection that can
// be empty; the assertion loops use non-empty literals owned by this test.
// NOT-FOUND (2): no exit-status/truthy-return assertion is used as evidence of
// the subject's own output.
// NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure;
// the final promise catch reports the error and sets a failing exit code.
// NOT-FOUND (4): the harness mocks transport/audit boundaries, not the gateway
// transformations and policy decisions under assertion.
// NOT-FOUND (5): no whole-file platform precondition exists in this file. The
// resolver's conditional assertion gap was found and fixed above.
// NOT-FOUND (6): no expected value is computed by the same subject operation
// it checks; relationship checks also independently pin their operands.
// Preconditions: the client registration is generated from the tracked setup
// source contract; no installation-owned .mcp.json or historical runbook is
// required. Node 20.20.2 was available although package.json declares Node
// >=22.19.0.
'use strict';

require('../lib/isolated-environment').activate('playwright-gateway');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const requestContext = require('../../src/lib/request-context');
const machineRecord = require('../../src/lib/setup/machine-record');
const { ROOT } = require('../../src/lib/runtime');
const {
  PLAYWRIGHT_CDP_CONNECT_TIMEOUT_MS,
  assertSafeBrowserCall,
  assertFileUploadPreflight,
  extractCandidateFilePaths,
  buildUpstreamArgs,
  countOpenTabsFromListResult,
  createGatewaySession,
  extractPlaywrightErrorText,
  redactPlaywrightResponse,
  redactSensitiveUrlText,
  resolveNpxInvocation,
  upstreamSpawnArgs,
  writeUpstreamStderrLine,
  PLAYWRIGHT_TOOL_FEATURES,
  SAFE_BROWSER_TOOL_NAMES,
  checkPlaywrightTools
} = require('../../src/playwright-gateway');

{
  // Client registrations must always start the attachment-only gateway. A raw
  // @playwright/mcp --user-data-dir registration would try to launch a second
  // Chrome against the already-owned profile and fail with profile-in-use.
  const record = machineRecord.buildMachineRecord({
    tier: 'standard',
    installRoot: ROOT,
    servicesRoot: path.join(ROOT, 'scratch', 'playwright-gateway-services'),
    nodePath: process.execPath,
    workspaceRoots: [path.join(ROOT, 'scratch', 'playwright-gateway-workspace')]
  });
  const projectMcp = machineRecord.generateMcpConfig(record, {
    readOnlyTools: () => ['system.health'],
    tierTools: () => ['system.health']
  }).document;
  const projectPlaywright = projectMcp.mcpServers && projectMcp.mcpServers.playwright;
  assert.equal(projectPlaywright.command, process.execPath);
  assert.deepEqual(projectPlaywright.args, [
    path.join(ROOT, 'src', 'playwright-gateway.js'),
    '@playwright/mcp@0.0.82'
  ]);
  assert.doesNotMatch(JSON.stringify(projectPlaywright), /user-data-dir/i);

  const npxInvocation = resolveNpxInvocation('@playwright/mcp@0.0.78');
  // This contract must execute on every platform. Previously the only checks
  // of the resolver lived behind a Windows-and-cache guard, so Linux and a
  // cache miss could return an unusable spawn description without failing.
  assert.match(npxInvocation.source, /^(?:cache|npx|fallback)$/,
    'npx resolution must identify one of the spawn modes understood by upstreamSpawnArgs');
  assert.equal(typeof npxInvocation.executable, 'string');
  assert.notEqual(npxInvocation.executable.length, 0, 'npx resolution must provide an executable');
  assert.equal(Array.isArray(npxInvocation.prefix), true, 'npx resolution must provide an argv prefix');
  if (npxInvocation.source === 'cache') {
    assert.equal(npxInvocation.executable, process.execPath,
      'a cached Playwright CLI must be launched through the current Node executable');
    assert.equal(npxInvocation.prefix.length, 1,
      'a cached Playwright CLI must identify exactly one entry point');
    assert.match(npxInvocation.prefix[0], /[\\/]@playwright[\\/]mcp[\\/]cli\.js$/i);
  }
  if (process.platform === 'win32' && npxInvocation.source === 'cache') {
    assert.equal(npxInvocation.executable, process.execPath);
    assert.match(npxInvocation.prefix[0], /[\\/]@playwright[\\/]mcp[\\/]cli\.js$/i);
  }

  const launcher = fs.readFileSync(path.join(ROOT, 'tools', 'playwright-mcp.cmd'), 'utf8');
  assert.match(launcher, /playwright-gateway\.js/);
  assert.match(launcher, /@playwright\/mcp@0\.0\.82/);
  assert.doesNotMatch(launcher, /user-data-dir/i);

  const codexExample = fs.readFileSync(path.join(ROOT, 'adapters', 'codex', 'config.toml.example'), 'utf8');
  assert.match(codexExample, /\[mcp_servers\.playwright\]/);
  assert.match(codexExample, /playwright-gateway\.js/);
  assert.doesNotMatch(codexExample, /user-data-dir/i);

  assert.equal(projectPlaywright.cwd, ROOT,
    'the production installer binds the browser gateway to the selected install root');
}

function harness(options = {}) {
  const upstream = [];
  const client = [];
  const events = [];
  const intents = [];
  let clock = 1000;
  const auditApi = {
    requireRecord(action, target, details) {
      intents.push({ action, target, details });
      if (options.intentResult !== undefined) return options.intentResult;
      return { durable: true, eventId: `intent-${intents.length}` };
    },
    record(action, target, details) { events.push({ action, target, details }); return { durable: true }; }
  };
  const session = createGatewaySession({
    auditApi,
    assertActiveFn: options.assertActiveFn || (() => {}),
    accountRegistry: options.accountRegistry,
    // The unit harness exercises the gateway's forwarding contract without
    // claiming a live owner request.  Production `start()` keeps the default
    // strict setting; dedicated gate tests below bind the marker explicitly.
    requireOutwardGates: options.requireOutwardGates === undefined ? false : options.requireOutwardGates,
    now: () => clock,
    tabCountQueryTimeoutMs: options.tabCountQueryTimeoutMs,
    writeUpstream: line => upstream.push(line),
    writeClient: line => client.push(line)
  });
  return { session, upstream, client, events, intents, tick: value => { clock += value; } };
}

function call(id, name = 'browser_navigate', args) {
  const input = args === undefined ? (name === 'browser_navigate' ? { url: 'https://example.com/' } : {}) : args;
  const message = { jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: input } };
  if (id !== undefined) message.id = id;
  return JSON.stringify(message);
}

const googleAccounts = {
  resolve() { return 'accta'; },
  load() { return { accounts: { accta: { email: 'accta@example.com' } } }; }
};

// --- Q31 native-gateway owner-instruction binding --------------------------
// The production gateway requires a host-owned active request for an upload;
// a missing marker must not be mistaken for a clean/no-gates request. The
// ordinary harness above opts out so its historical forwarding tests remain
// focused; these cases exercise the strict production setting directly.
{
  const test = harness({ requireOutwardGates: true });
  test.session.clientLine(call('gate-missing', 'browser_file_upload', { paths: ['McNair Current.pdf'] }));
  assert.equal(test.upstream.length, 0);
  assert.equal(test.intents.length, 0);
  assert.equal(JSON.parse(test.client[0]).result.structuredContent.error.code, 'EGRESS_GATES_REQUIRED');
}

{
  const ledgerFile = path.resolve(process.env.TOOLSENABLED_OWNER_LEDGER_FILE);
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.writeFileSync(ledgerFile, JSON.stringify({ requests: [{ id: 'Q31-GATEWAY-MET', gates: [{ instruction: 'verify', met: true, evidence: 'checked' }] }] }));
  requestContext.setActiveRequest('Q31-GATEWAY-MET', { setBy: 'test' });
  try {
    const test = harness({ requireOutwardGates: true });
    test.session.clientLine(call('gate-met', 'browser_file_upload', { paths: ['McNair Current.pdf'] }));
    assert.equal(test.upstream.length, 1);
    assert.equal(test.intents.length, 1);
  } finally {
    requestContext.clearActiveRequest('Q31-GATEWAY-MET');
  }
}

{
  const ledgerFile = path.resolve(process.env.TOOLSENABLED_OWNER_LEDGER_FILE);
  fs.writeFileSync(ledgerFile, JSON.stringify({ requests: [{ id: 'Q31-GATEWAY-UNMET', gates: [{ instruction: 'verify', met: false, evidence: '' }] }] }));
  requestContext.setActiveRequest('Q31-GATEWAY-UNMET', { setBy: 'test' });
  try {
    const test = harness({ requireOutwardGates: true });
    test.session.clientLine(call('gate-unmet', 'browser_file_upload', { paths: ['McNair Current.pdf'] }));
    assert.equal(test.upstream.length, 0);
    assert.equal(JSON.parse(test.client[0]).result.structuredContent.error.code, 'EGRESS_GATES_UNMET');
  } finally {
    requestContext.clearActiveRequest('Q31-GATEWAY-UNMET');
  }
}

{
  const test = harness({ accountRegistry: googleAccounts });
  test.session.clientLine(call(12, 'browser_navigate', { url: 'https://gemini.google.com/app' }));
  const routed = JSON.parse(test.upstream[0]);
  assert.match(routed.params.arguments.url, /authuser=accta%40example\.com/);
  assert.equal(test.intents[0].details.requestId, '12');
  assert.doesNotMatch(JSON.stringify(test.intents), /gemini\.google\.com|accta@example\.com/,
    'The durable intent must not record a navigation URL or account email.');
}

{
  const test = harness({ accountRegistry: googleAccounts });
  const explicit = 'https://drive.google.com/drive/u/0?authuser=acctc%40ucr.edu';
  test.session.clientLine(call(13, 'browser_navigate', { url: explicit }));
  assert.equal(JSON.parse(test.upstream[0]).params.arguments.url, explicit,
    'An explicit account selector must be preserved.');
  test.session.clientLine(call(14, 'browser_navigate', { url: 'https://example.com/' }));
  assert.equal(JSON.parse(test.upstream[1]).params.arguments.url, 'https://example.com/');
}

{
  const canary = 'PLAYWRIGHT-CANARY-CREDENTIAL-0123456789';
  const redacted = redactPlaywrightResponse({
    result: {
      content: [{
        type: 'text',
        text: `ordinary snapshot heading\nAuthorization: Bearer ${canary}\npassword=${canary}`
      }],
      structuredContent: {
        console: `token=${canary}`,
        network: { authorization: canary, cookie: canary },
        snapshot: `ordinary page content\napi_key=${canary}`
      }
    }
  });
  assert.equal(JSON.stringify(redacted).includes(canary), false);
  assert.match(redacted.result.content[0].text, /ordinary snapshot heading/);
  assert.match(redacted.result.structuredContent.snapshot, /ordinary page content/);
}

{
  const test = harness();
  test.session.clientLine(call(undefined));
  assert.equal(test.upstream.length, 0, 'tools/call notifications must never reach the browser');
  assert.equal(test.client.length, 0, 'JSON-RPC notifications have no response channel');
  assert.equal(test.intents.length, 0, 'rejected notifications must not create an executable intent');
  assert.equal(test.events.length, 1);
  assert.equal(test.events[0].action, 'playwright.tool.blocked');
  assert.match(test.events[0].details.error, /request id/i);
}

{
  const test = harness();
  const request = call(7);
  test.session.clientLine(request);
  assert.deepEqual(test.upstream, [request]);
  assert.equal(test.session.pendingCount(), 1);
  test.tick(25);
  test.session.upstreamClosed(17);
  assert.equal(test.session.pendingCount(), 0);
  const failed = test.events.find(event => event.action === 'playwright.tool.failed');
  assert.ok(failed, 'an in-flight call must receive a terminal outcome when upstream exits');
  assert.equal(failed.details.intentEventId, 'intent-1');
  assert.equal(failed.details.durationMs, 25);
  assert.match(failed.details.error, /exited 17/);
}

{
  const test = harness();
  test.session.clientLine(call('same-id'));
  test.session.clientLine(call('same-id', 'browser_click'));
  assert.equal(test.upstream.length, 1, 'duplicate in-flight IDs must not reach upstream');
  assert.equal(test.client.length, 1);
  const duplicate = JSON.parse(test.client[0]);
  assert.equal(duplicate.result.structuredContent.error.code, 'JSONRPC_DUPLICATE_ID');
  test.session.serverLine(JSON.stringify({ jsonrpc: '2.0', id: 'same-id', result: { content: [] } }));
  const succeeded = test.events.find(event => event.action === 'playwright.tool.succeeded');
  assert.equal(succeeded.details.intentEventId, 'intent-1');
}

{
  let policyChecks = 0;
  const test = harness({ assertActiveFn: () => { policyChecks++; throw new Error('must not run'); } });
  test.session.clientLine(call(9, 'browser_close'));
  assert.equal(policyChecks, 0, 'browser_close must be blocked before policy or upstream handling');
  assert.equal(test.intents.length, 0);
  assert.equal(test.upstream.length, 0);
  const blocked = JSON.parse(test.client[0]);
  assert.equal(blocked.result.structuredContent.error.code, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL');
  assert.equal(test.events[0].action, 'playwright.tool.blocked');
}

for (const [name, args] of [
  ['browser_page_close', {}],
  ['browser_context_kill', {}],
  ['browser_restart', {}],
  ['browser_evaluate', { function: '() => window.close()' }],
  ['browser_run_code', { code: 'async page => page.context().browser().close()' }],
  ['browser_run_code_unsafe', { code: 'async page => page.context().browser().close()' }],
  ['browser_press_key', { key: 'Alt+F4' }],
  ['browser_press_key', { key: 'Control+Shift+W' }],
  ['browser_press_key', { key: 'Control+F4' }],
  ['browser_press_key', { key: 'Alt+F' }],
  ['browser_press_key', { key: 'Control+L' }],
  ['browser_press_key', { key: 'F6' }]
]) {
  const test = harness();
  test.session.clientLine(call(`blocked-${name}-${JSON.stringify(args)}`, name, args));
  assert.equal(test.upstream.length, 0, `${name} must never be forwarded`);
  assert.equal(test.intents.length, 0, `${name} must be blocked before audit intent`);
  const blocked = JSON.parse(test.client[0]);
  assert.equal(blocked.result.structuredContent.error.code, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL');
}

{
  const test = harness();
  test.session.clientLine(call(90, 'browser_future_power_tool', {}));
  assert.equal(test.upstream.length, 0, 'an unreviewed future upstream tool must fail closed');
  assert.equal(test.intents.length, 0);
  assert.equal(JSON.parse(test.client[0]).result.structuredContent.error.code, 'BROWSER_TOOL_NOT_ALLOWED');
}

{
  const test = harness();
  test.session.clientLine(call(89, 'browser_press_key', { key: 'Enter' }));
  assert.equal(test.upstream.length, 1, 'a reviewed page key must remain available');
  assert.equal(test.intents.length, 1);
}

{
  const test = harness();
  test.session.serverLine(JSON.stringify({
    jsonrpc: '2.0', id: 88,
    result: {
      tools: [
        { name: 'browser_click', inputSchema: { type: 'object' } },
        { name: 'browser_close', inputSchema: { type: 'object' } },
        { name: 'browser_run_code_unsafe', inputSchema: { type: 'object' } },
        { name: 'browser_future_power_tool', inputSchema: { type: 'object' } }
      ]
    }
  }));
  assert.deepEqual(JSON.parse(test.client[0]).result.tools.map(tool => tool.name), ['browser_click'],
    'tools/list must expose only reviewed positive-allowlist tools');
}

{
  const test = harness();
  const sensitive = {
    jsonrpc: '2.0',
    id: 881,
    result: {
      content: [{
        type: 'text',
        text: [
          'https://dash.cloudflare.com/login/google?oidcJwt=header.payload.signature&authuser=1',
          'https://accounts.google.com/o/oauth2/auth?state=one-time-state&continue=https%3A%2F%2Fexample.com%2Fcallback%3Fcode%3Dnested-secret&project=example-revenue-project',
          'https://example.com/callback#access_token=fragment-secret&scope=openid'
        ].join('\n')
      }],
      structuredContent: {
        url: 'https://example.com/callback?code=authorization-secret&safe=value',
        benign: 'Find dates. Review every event.'
      }
    }
  };
  test.session.serverLine(JSON.stringify(sensitive));
  const forwarded = test.client[0];
  for (const secret of [
    'header.payload.signature',
    'one-time-state',
    'nested-secret',
    'fragment-secret',
    'authorization-secret'
  ]) {
    assert.doesNotMatch(forwarded, new RegExp(secret.replaceAll('.', '\\.')),
      'OAuth/session material in an upstream URL must never reach the client');
  }
  assert.match(forwarded, /oidcJwt=\[REDACTED\]/);
  assert.match(forwarded, /authuser=1/);
  assert.match(forwarded, /project=example-revenue-project/);
  assert.match(forwarded, /safe=value/);
  assert.match(forwarded, /Find dates\. Review every event\./);
}

{
  const raw = 'upstream warning https://example.com/callback?state=raw-secret&safe=value';
  assert.equal(
    redactSensitiveUrlText(raw),
    'upstream warning https://example.com/callback?state=[REDACTED]&safe=value',
    'even a malformed non-JSON upstream line must redact URL-bound session material'
  );
}

{
  const test = harness();
  test.session.clientLine(call(882, 'browser_snapshot', {}));
  test.session.serverLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 882,
    result: {
      content: [{
        type: 'text',
        text: [
          '### Snapshot',
          'safe page content',
          '### Open tabs',
          '- 0: [Unrelated private tab](https://private.example/?token=private-tab-token)',
          '- 1: [Another account](https://accounts.example/session)',
          '### Page',
          '- Page Title: Intended page'
        ].join('\n')
      }]
    }
  }));
  const forwarded = test.client[0];
  assert.match(forwarded, /safe page content/);
  assert.match(forwarded, /Intended page/);
  assert.doesNotMatch(forwarded, /Open tabs|Unrelated private tab|Another account|private\.example|accounts\.example/,
    'incidental tab inventories must not leak through unrelated Playwright responses');
}

{
  const test = harness();
  test.session.clientLine(call(883, 'browser_tabs', { action: 'select', index: 3 }));
  test.session.serverLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 883,
    result: {
      content: [{
        type: 'text',
        text: '### Result\n- 0: [Private tab](https://private.example/?token=private-tab-token)'
      }]
    }
  }));
  const forwarded = JSON.parse(test.client[0]);
  assert.equal(forwarded.result.content[0].text, 'Tab selected.');
  assert.doesNotMatch(JSON.stringify(forwarded), /Private tab|private\.example|private-tab-token/);
}

{
  const test = harness();
  test.session.clientLine(call(884, 'browser_tabs', { action: 'list' }));
  test.session.serverLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 884,
    result: {
      content: [{ type: 'text', text: '### Result\n- 0: [Requested tab list](https://example.com/)' }]
    }
  }));
  assert.match(test.client[0], /Requested tab list/,
    'an explicit tab-list request must remain useful');
}

{
  const written = [];
  writeUpstreamStderrLine(
    'upstream warning https://example.com/callback?state=stderr-secret&safe=value',
    value => written.push(value)
  );
  assert.equal(
    written.join(''),
    'upstream warning https://example.com/callback?state=[REDACTED]&safe=value\n',
    'upstream stderr must use the same URL-secret redaction as client responses'
  );
}

for (const url of [
  'chrome://quit', 'chrome://restart', 'about:blank', 'file:///C:/Windows/win.ini',
  'javascript:window.close()', 'data:text/html,bye',
  'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/page.html',
  'devtools://devtools/bundled/inspector.html', 'https://user:secret@example.com/'
]) {
  const test = harness();
  test.session.clientLine(call(`blocked-url-${url}`, 'browser_navigate', { url }));
  assert.equal(test.upstream.length, 0, `${url} must never be forwarded`);
  assert.equal(test.intents.length, 0, `${url} must be rejected before audit intent`);
  const blocked = JSON.parse(test.client[0]);
  assert.equal(blocked.result.structuredContent.error.code, 'BROWSER_NAVIGATION_URL_FORBIDDEN');
}

{
  const test = harness();
  test.session.clientLine(call(91, 'browser_tabs', { action: 'new', url: 'chrome://quit' }));
  assert.equal(test.upstream.length, 0, 'browser_tabs new must enforce the same URL boundary');
  assert.equal(test.intents.length, 0);
  assert.equal(JSON.parse(test.client[0]).result.structuredContent.error.code, 'BROWSER_NAVIGATION_URL_FORBIDDEN');
}

{
  const args = buildUpstreamArgs('@playwright/mcp@0.0.78', { cdpEndpoint: 'http://127.0.0.1:24567' });
  assert.deepEqual(args.slice(0, 4), ['-y', '@playwright/mcp@0.0.78', '--cdp-endpoint', 'http://127.0.0.1:24567']);
  const actionTimeoutIndex = args.indexOf('--timeout-action');
  assert.notEqual(actionTimeoutIndex, -1, 'gateway must override the upstream five-second action timeout');
  assert.equal(args[actionTimeoutIndex + 1], '20000', 'action wait must stay finite and reviewed');
  const cdpTimeoutIndex = args.indexOf('--cdp-timeout');
  assert.notEqual(cdpTimeoutIndex, -1, 'gateway must allow the owned browser a bounded cold attachment window');
  assert.equal(args[cdpTimeoutIndex + 1], String(PLAYWRIGHT_CDP_CONNECT_TIMEOUT_MS));
  assert.equal(PLAYWRIGHT_CDP_CONNECT_TIMEOUT_MS, 90000, 'owned-browser attachment must remain finite');
  assert.equal(args.includes('--user-data-dir'), false, 'gateway must attach to an owned endpoint, never independently claim a profile');
  assert.throws(() => buildUpstreamArgs('@playwright/mcp@0.0.78', { cdpEndpoint: 'http://localhost:24567' }), /ToolsEnabled-owned loopback CDP/);
}

{
  // Regression: when resolveNpxInvocation() finds the package already cached
  // (source: 'cache'), npx.prefix bypasses npx and points straight at the
  // playwright/mcp CLI's own entry point. Forwarding the npx-only '-y'
  // <package> selection pair to that CLI directly makes it exit immediately
  // with "error: unknown option '-y'" before it ever attaches to the browser.
  const args = buildUpstreamArgs('@playwright/mcp@0.0.78', { cdpEndpoint: 'http://127.0.0.1:24567' });
  const cached = upstreamSpawnArgs({ source: 'cache' }, args);
  assert.deepEqual(cached, args.slice(2), 'a cached direct-CLI invocation must drop the npx-only "-y" <package> prefix');
  assert.equal(cached.includes('-y'), false);
  assert.equal(cached.includes('@playwright/mcp@0.0.78'), false);
  assert.equal(cached[0], '--cdp-endpoint');

  for (const source of ['npx', 'fallback']) {
    const forwarded = upstreamSpawnArgs({ source }, args);
    assert.deepEqual(forwarded, args, `a real npx invocation (source: ${source}) must keep the '-y' <package> selection pair`);
  }
}

{
  const test = harness({ intentResult: { durable: true } });
  test.session.clientLine(call(11));
  assert.equal(test.upstream.length, 0, 'an uncorrelatable intent must fail closed');
  const blocked = JSON.parse(test.client[0]);
  assert.equal(blocked.result.structuredContent.error.code, 'AUDIT_INVALID_RESULT');
}

// --- Q31 build item 2: egress preflight on the actual leaked upload route ---
//
// Adversarial replay of the real incident: the McNair filename reached its
// destination through this exact upstream tool. tools/standing-orders-hook.js
// (the PreToolUse hook) cannot see a native mcp__playwright__browser_file_upload
// call at all -- it only recognizes Bash/PowerShell command shapes. This
// gateway's clientLine() is the real chokepoint every such call already
// passes through before being forwarded upstream.

{
  const test = harness();
  const leakPath = 'C:\\Users\\owner\\Desktop\\Personal Draft 7.28 (agent-reviewed).pdf';
  test.session.clientLine(call(300, 'browser_file_upload', { paths: [leakPath] }));
  assert.equal(test.upstream.length, 0, 'the real incident filename must never be forwarded to the browser');
  assert.equal(test.intents.length, 0, 'a blocked upload must never acquire a durable audit intent');
  const blocked = JSON.parse(test.client[0]);
  assert.equal(blocked.result.structuredContent.error.code, 'EGRESS_PREFLIGHT_BLOCKED');
  assert.match(blocked.result.structuredContent.error.message, /AGENT_PROVENANCE/);
  assert.equal(test.events[0].action, 'playwright.tool.blocked');
}

{
  const test = harness();
  test.session.clientLine(call(301, 'browser_file_upload', { paths: ['C:\\Users\\owner\\Desktop\\McNair Current.pdf'] }));
  assert.equal(test.upstream.length, 1, 'a clean filename must still be forwarded');
  assert.equal(test.intents.length, 1);
}

{
  // One clean path and one dirty path in the same call: the whole call must
  // still refuse, not silently drop the bad entry and upload the rest.
  const test = harness();
  test.session.clientLine(call(302, 'browser_file_upload', {
    paths: ['C:\\Users\\owner\\Desktop\\clean.pdf', 'C:\\Users\\owner\\Desktop\\notes (claude).pdf']
  }));
  assert.equal(test.upstream.length, 0);
  assert.equal(JSON.parse(test.client[0]).result.structuredContent.error.code, 'EGRESS_PREFLIGHT_BLOCKED');
}

{
  // browser_take_screenshot's optional `filename` is included defensively
  // (a locally-saved artifact can still carry a leaking name forward).
  const test = harness();
  test.session.clientLine(call(303, 'browser_take_screenshot', { filename: 'page (agent-generated).png' }));
  assert.equal(test.upstream.length, 0);
  assert.equal(JSON.parse(test.client[0]).result.structuredContent.error.code, 'EGRESS_PREFLIGHT_BLOCKED');
}

{
  // Tools with no file-bearing field of their own are never touched by this
  // check, even though their arguments are attacker/page-influenced text.
  const test = harness();
  test.session.clientLine(call(304, 'browser_type', { element: 'Search', ref: 'e1', text: 'agent-reviewed report' }));
  assert.equal(test.upstream.length, 1);
}

{
  assert.deepEqual(extractCandidateFilePaths('browser_file_upload', { paths: ['a.pdf', 'b.pdf'] }), ['a.pdf', 'b.pdf']);
  assert.deepEqual(extractCandidateFilePaths('browser_file_upload', { paths: [] }), []);
  assert.deepEqual(extractCandidateFilePaths('browser_file_upload', {}), []);
  assert.deepEqual(extractCandidateFilePaths('browser_take_screenshot', { filename: 'x.png' }), ['x.png']);
  assert.deepEqual(extractCandidateFilePaths('browser_click', { element: 'x' }), [],
    'a tool with no registered file-bearing field must yield no candidates');
  assert.doesNotThrow(() => assertFileUploadPreflight({ params: { name: 'browser_click', arguments: {} } }));
  assert.doesNotThrow(() => assertFileUploadPreflight({}));
}

// --- Part 1: browser_tabs close is permitted only after a live re-check ---

{
  // The shared structural validator continues to fail closed for every
  // caller that cannot supply a live re-verified count (e.g. the offline
  // tools/playwright-call.js pre-validator, which never passes an options
  // argument at all).
  const closeMessage = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_tabs', arguments: { action: 'close' } } };
  assert.throws(() => assertSafeBrowserCall(closeMessage), errorCodeMatcher('BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL'));
  assert.throws(() => assertSafeBrowserCall(closeMessage, {}), errorCodeMatcher('BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL'));
  assert.throws(() => assertSafeBrowserCall(closeMessage, { tabCloseAllowed: false }), errorCodeMatcher('BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL'));
  assert.doesNotThrow(() => assertSafeBrowserCall(closeMessage, { tabCloseAllowed: true }));
}

function errorCodeMatcher(code) {
  return error => error && error.code === code;
}

function tabListResult(count) {
  const lines = Array.from({ length: count }, (_, index) => `- ${index}: [Tab ${index}](https://example.com/${index})`);
  return { content: [{ type: 'text', text: ['### Result', ...lines].join('\n') }] };
}

{
  assert.equal(countOpenTabsFromListResult(tabListResult(2)), 2);
  assert.equal(countOpenTabsFromListResult(tabListResult(0)), 0);
  assert.equal(countOpenTabsFromListResult({ isError: true, content: [{ type: 'text', text: '- 0: x' }] }), null,
    'an upstream error result must never be treated as a confirmed tab count');
  assert.equal(countOpenTabsFromListResult({ content: [] }), null);
  assert.equal(countOpenTabsFromListResult(null), null);

  assert.equal(extractPlaywrightErrorText({ content: [{ type: 'text', text: 'Element not found: button#submit' }] }),
    'Element not found: button#submit');
  assert.equal(extractPlaywrightErrorText({ content: [] }), null);
  assert.equal(extractPlaywrightErrorText(null), null);
}

// --- Playwright MCP is accepted by the tools it offers, not by its number ----
// The gateway used to trust one pinned version. A different version is now
// accepted when its own tools/list offers what the gateway relies on, and a
// tool whose guarded argument changed is hidden and refused instead of letting
// a check silently stop applying. The two recorded lists are the real
// tools/list answers of 0.0.78 and 0.0.82 (tests/fixtures).
{
  assert.deepEqual(Object.keys(PLAYWRIGHT_TOOL_FEATURES).sort(), [...SAFE_BROWSER_TOOL_NAMES],
    'every reviewed browser tool has exactly one feature entry');
  for (const version of ['0.0.78', '0.0.82']) {
    const recorded = require(`../fixtures/playwright-mcp-tools-${version}.json`);
    assert.equal(recorded.version, version);
    const check = checkPlaywrightTools(recorded.tools);
    assert.deepEqual({ ...check }, { state: 'ready', hidden: [], missingRequired: [], missingOptional: [] },
      `@playwright/mcp ${version} offers everything the gateway relies on`);
  }
  assert.equal(checkPlaywrightTools(undefined).state, 'unknown');
}

function recordedTools(version, change = tools => tools) {
  return change(JSON.parse(JSON.stringify(require(`../fixtures/playwright-mcp-tools-${version}.json`).tools)));
}

function listThroughGateway(tools, { packageVersion = '9.9.9' } = {}) {
  const notes = [];
  const upstream = [];
  const client = [];
  const events = [];
  const intents = [];
  const session = createGatewaySession({
    auditApi: {
      requireRecord(action, target, details) { intents.push({ action, target, details }); return { durable: true, eventId: `intent-${intents.length}` }; },
      record(action, target, details) { events.push({ action, target, details }); return { durable: true }; }
    },
    assertActiveFn: () => {},
    requireOutwardGates: false,
    writeUpstream: line => upstream.push(line),
    writeClient: line => client.push(line),
    writeDiagnostic: line => notes.push(line),
    packageVersion
  });
  session.serverLine(JSON.stringify({ jsonrpc: '2.0', id: 'init', result: { serverInfo: { name: 'Playwright', version: '1.64.0-alpha' } } }));
  session.serverLine(JSON.stringify({ jsonrpc: '2.0', id: 'list', result: { tools } }));
  const listed = JSON.parse(client[client.length - 1]).result.tools;
  return { session, notes, upstream, client, events, intents, listed };
}

{
  // A newer server that renamed browser_file_upload's `paths` to `files`: the
  // egress preflight reads `paths`, so passing the tool on would let an upload
  // skip it. The tool is hidden, the rest keeps working, and it says so once.
  const tools = recordedTools('0.0.82', list => list.map(tool => {
    if (tool.name !== 'browser_file_upload') return tool;
    const { paths, ...rest } = tool.inputSchema.properties;
    return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...rest, files: paths } } };
  }));
  const test = listThroughGateway(tools);
  assert.equal(test.listed.some(tool => tool.name === 'browser_file_upload'), false,
    'a tool whose guarded argument is gone is not offered to the client');
  assert.equal(test.listed.length, SAFE_BROWSER_TOOL_NAMES.length - 1, 'every other reviewed tool is still offered');
  assert.deepEqual({ ...test.session.featureCheck() }, {
    state: 'ready-with-limits', hidden: ['browser_file_upload'], missingRequired: [], missingOptional: ['browser_file_upload.paths']
  });
  assert.equal(test.notes.length, 1);
  assert.match(test.notes[0], /Playwright MCP 9\.9\.9 works with limits/);
  assert.match(test.notes[0], /turned off browser_file_upload/);
  test.session.clientLine(call('renamed-upload', 'browser_file_upload', { files: ['McNair Current.pdf'] }));
  assert.equal(test.upstream.length, 0, 'a hidden tool is never forwarded');
  assert.equal(test.intents.length, 0);
  assert.equal(JSON.parse(test.client[test.client.length - 1]).result.structuredContent.error.code, 'BROWSER_TOOL_UPDATE_NEEDED');
  test.session.clientLine(call('still-navigates', 'browser_navigate', { url: 'https://example.com/' }));
  assert.equal(test.upstream.length, 1, 'the rest of the browser keeps working');
}

{
  // The same rename, with a client that never listed tools: the call is
  // refused on its unreviewed argument before anything is forwarded.
  const test = harness();
  test.session.clientLine(call('unlisted-upload', 'browser_file_upload', { files: ['McNair Current.pdf'] }));
  assert.equal(test.upstream.length, 0);
  assert.equal(test.intents.length, 0);
  assert.equal(JSON.parse(test.client[0]).result.structuredContent.error.code, 'BROWSER_ARGUMENT_NOT_REVIEWED');
  assert.throws(() => assertSafeBrowserCall(JSON.parse(call(1, 'browser_navigate', { url: 'https://example.com/', target: '_blank' }))),
    { code: 'BROWSER_ARGUMENT_NOT_REVIEWED' });
}

{
  // A new optional argument on a guarded tool is not advertised; a guarded
  // tool that now REQUIRES an unreviewed argument is hidden; an unguarded
  // tool keeps whatever the server offers.
  const tools = recordedTools('0.0.82', list => list.map(tool => {
    const properties = tool.inputSchema.properties || {};
    if (tool.name === 'browser_navigate') return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...properties, waitUntil: { type: 'string' } } } };
    if (tool.name === 'browser_press_key') return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...properties, modifiers: { type: 'array' } }, required: ['key', 'modifiers'] } };
    if (tool.name === 'browser_click') return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...properties, force: { type: 'boolean' } } } };
    return tool;
  }));
  const test = listThroughGateway(tools);
  const byName = new Map(test.listed.map(tool => [tool.name, tool]));
  assert.deepEqual(Object.keys(byName.get('browser_navigate').inputSchema.properties), ['url']);
  assert.equal(byName.has('browser_press_key'), false);
  assert.equal(Object.hasOwn(byName.get('browser_click').inputSchema.properties, 'force'), true);
  assert.equal(test.session.featureCheck().state, 'ready-with-limits');
  assert.deepEqual(test.session.featureCheck().missingOptional, ['browser_press_key.modifiers (not reviewed)']);
}

{
  // A server without a required tool is reported as needing an update.
  const test = listThroughGateway(recordedTools('0.0.82', list => list.filter(tool => tool.name !== 'browser_navigate')));
  assert.equal(test.session.featureCheck().state, 'update-needed');
  assert.deepEqual(test.session.featureCheck().missingRequired, ['browser_navigate']);
  assert.match(test.notes[0], /does not offer what ToolsEnabled's browser tools need \(browser_navigate\)\. Update Playwright MCP\./);
  // The real lists pass untouched, and a ready server writes no note.
  const ready = listThroughGateway(recordedTools('0.0.78'));
  assert.equal(ready.notes.length, 0);
  assert.equal(ready.listed.length, SAFE_BROWSER_TOOL_NAMES.length);
  assert.equal(ready.session.featureCheck().state, 'ready');
}

// --- One default Playwright MCP version everywhere, and a proven one --------
// The version the setup writes is only what gets fetched when ToolsEnabled
// has no copy yet; the gateway accepts a copy by its tools. Every place that
// writes the argument still names ONE version, and it is the newest version
// whose recorded tools/list (tests/fixtures) checks 'ready', so proving a new
// release is what moves the default and nothing needs a hand-kept pin.
{
  const record = machineRecord.buildMachineRecord({
    tier: 'standard',
    installRoot: ROOT,
    servicesRoot: path.join(ROOT, 'scratch', 'playwright-gateway-services'),
    nodePath: process.execPath,
    workspaceRoots: [path.join(ROOT, 'scratch', 'playwright-gateway-workspace')]
  });
  const generatedSpec = machineRecord.generateMcpConfig(record, {
    readOnlyTools: () => ['system.health'],
    tierTools: () => ['system.health']
  }).document.mcpServers.playwright.args[1];
  const match = /^@playwright\/mcp@(\d+\.\d+\.\d+)$/.exec(generatedSpec);
  assert.ok(match, `the generated default ${generatedSpec} names one exact version`);
  const defaultVersion = match[1];
  const writers = {
    'src/lib/providers/workstation.js': require('../../src/lib/providers/workstation').PLAYWRIGHT_PACKAGE,
    'tools/playwright-call.js': require('../../tools/playwright-call').buildSpawnSpec().args[1]
  };
  for (const file of ['tools/playwright-mcp.cmd', 'install.ps1', 'adapters/codex/config.toml.example']) {
    const specs = fs.readFileSync(path.join(ROOT, file), 'utf8').match(/@playwright\/mcp@[0-9A-Za-z.+-]+/g) || [];
    assert.equal(specs.length, 1, `${file} names the Playwright MCP version once`);
    writers[file] = specs[0];
  }
  for (const [file, spec] of Object.entries(writers)) {
    assert.equal(spec, generatedSpec, `${file} names ${spec}, the setup writes ${generatedSpec}`);
  }
  const fixtures = fs.readdirSync(path.join(ROOT, 'tests', 'fixtures'))
    .map(name => /^playwright-mcp-tools-(\d+\.\d+\.\d+)\.json$/.exec(name)?.[1]).filter(Boolean);
  const proven = fixtures.filter(version => checkPlaywrightTools(
    require(`../fixtures/playwright-mcp-tools-${version}.json`).tools).state === 'ready');
  const byVersion = (a, b) => a.split('.').map(Number).reduce((order, part, index) => order || part - Number(b.split('.')[index]), 0);
  proven.sort(byVersion);
  assert.ok(proven.includes(defaultVersion), `the default ${defaultVersion} has a recorded tools/list that checks ready`);
  assert.equal(defaultVersion, proven[proven.length - 1],
    `the default ${defaultVersion} is not the newest proven version (${proven.join(', ')})`);
}

async function testLiveTabCloseAndErrorExtraction() {
  // Permitted: two open tabs. The gateway must issue its own live
  // browser_tabs list preflight before ever forwarding the close, and the
  // eventual close response must be sanitized like tab select (no inventory
  // leak) instead of exposing other tabs' titles/URLs.
  {
    const test = harness();
    const closePromise = test.session.clientLine(call(200, 'browser_tabs', { action: 'close' }));
    assert.equal(test.upstream.length, 1, 'the close must not be forwarded before a live count is confirmed');
    assert.equal(test.intents.length, 0, 'no intent may exist until the live count check passes');
    const preflight = JSON.parse(test.upstream[0]);
    assert.equal(preflight.method, 'tools/call');
    assert.equal(preflight.params.name, 'browser_tabs');
    assert.equal(preflight.params.arguments.action, 'list');
    assert.notEqual(String(preflight.id), '200', 'the internal preflight must use its own id, never the client id');

    test.session.serverLine(JSON.stringify({ jsonrpc: '2.0', id: preflight.id, result: tabListResult(2) }));
    assert.equal(test.client.length, 0, 'the internal preflight response must never reach the client');
    await closePromise;

    assert.equal(test.upstream.length, 2, 'the real close must be forwarded once permitted');
    const forwardedClose = JSON.parse(test.upstream[1]);
    assert.equal(forwardedClose.id, 200);
    assert.equal(forwardedClose.params.arguments.action, 'close');
    assert.equal(test.intents.length, 1, 'a permitted close must record a durable intent like any other forwarded call');

    test.session.serverLine(JSON.stringify({
      jsonrpc: '2.0', id: 200,
      result: { content: [{ type: 'text', text: '### Result\n- 0: [Remaining private tab](https://private.example/?token=leak-me)' }] }
    }));
    const forwarded = JSON.parse(test.client[0]);
    assert.equal(forwarded.result.content[0].text, 'Tab closed.');
    assert.doesNotMatch(JSON.stringify(forwarded), /private\.example|leak-me|Remaining private tab/,
      'a successful close response must never leak the remaining tab inventory');
    const succeeded = test.events.find(event => event.action === 'playwright.tool.succeeded');
    assert.ok(succeeded, 'a permitted, successful close must record a succeeded outcome');
  }

  // Refused: exactly one open tab.
  {
    const test = harness();
    const closePromise = test.session.clientLine(call(201, 'browser_tabs', { action: 'close' }));
    const preflight = JSON.parse(test.upstream[0]);
    test.session.serverLine(JSON.stringify({ jsonrpc: '2.0', id: preflight.id, result: tabListResult(1) }));
    await closePromise;

    assert.equal(test.upstream.length, 1, 'a close that would leave zero tabs must never be forwarded');
    assert.equal(test.intents.length, 0, 'a refused close must never create a durable intent');
    const blocked = JSON.parse(test.client[0]);
    assert.equal(blocked.result.structuredContent.error.code, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL');
    assert.match(blocked.result.content[0].text, /last owned browser tab/i);
    assert.equal(test.events.find(event => event.action === 'playwright.tool.blocked') !== undefined, true);
  }

  // Refused: the live count could not be determined (upstream error result).
  {
    const test = harness();
    const closePromise = test.session.clientLine(call(202, 'browser_tabs', { action: 'close' }));
    const preflight = JSON.parse(test.upstream[0]);
    test.session.serverLine(JSON.stringify({
      jsonrpc: '2.0', id: preflight.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] }
    }));
    await closePromise;

    assert.equal(test.upstream.length, 1, 'an unconfirmed count must never permit a forwarded close');
    const blocked = JSON.parse(test.client[0]);
    assert.equal(blocked.result.structuredContent.error.code, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL');
    assert.match(blocked.result.content[0].text, /could not be confirmed/i);
  }

  // Refused: upstream exits mid-preflight. The waiting close must resolve to
  // a fail-closed blocked result instead of hanging forever.
  {
    const test = harness();
    const closePromise = test.session.clientLine(call(203, 'browser_tabs', { action: 'close' }));
    assert.equal(test.upstream.length, 1);
    test.session.upstreamClosed(1);
    await closePromise;
    const blocked = JSON.parse(test.client[0]);
    assert.equal(blocked.result.structuredContent.error.code, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL');
    assert.match(blocked.result.content[0].text, /could not be confirmed/i);
  }

  // Race safety: two concurrent close requests against a two-tab browser.
  // Both preflights are issued before either is answered; answering them in
  // order must permit exactly one close and refuse the other, because the
  // first close's reservation is subtracted from the second decision's count
  // even though the actual browser has not closed anything yet.
  {
    const test = harness();
    const firstClose = test.session.clientLine(call('race-a', 'browser_tabs', { action: 'close' }));
    const secondClose = test.session.clientLine(call('race-b', 'browser_tabs', { action: 'close' }));
    assert.equal(test.upstream.length, 2, 'both concurrent closes must issue their own live preflight');
    const [firstPreflight, secondPreflight] = test.upstream.map(line => JSON.parse(line));
    assert.notEqual(firstPreflight.id, secondPreflight.id, 'concurrent preflights must use distinct internal ids');

    test.session.serverLine(JSON.stringify({ jsonrpc: '2.0', id: firstPreflight.id, result: tabListResult(2) }));
    test.session.serverLine(JSON.stringify({ jsonrpc: '2.0', id: secondPreflight.id, result: tabListResult(2) }));
    await Promise.all([firstClose, secondClose]);

    assert.equal(test.upstream.length, 3, 'exactly one of the two concurrent closes may be forwarded');
    const forwardedCloseIds = test.upstream.slice(2).map(line => JSON.parse(line).id);
    assert.deepEqual(forwardedCloseIds, ['race-a']);
    assert.equal(test.client.length, 1, 'the losing concurrent close must receive its own blocked response');
    const blocked = JSON.parse(test.client[0]);
    assert.equal(blocked.id, 'race-b');
    assert.equal(blocked.result.structuredContent.error.code, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL');
  }

  // A close id is in flight while its internal list preflight is outstanding,
  // so a second close with that id must be rejected before issuing another
  // query or acquiring an intent.
  {
    const test = harness();
    const firstClose = test.session.clientLine(call('same-close-id', 'browser_tabs', { action: 'close' }));
    test.session.clientLine(call('same-close-id', 'browser_tabs', { action: 'close' }));
    assert.equal(test.upstream.length, 1, 'a duplicate close id must not issue a second preflight');
    assert.equal(JSON.parse(test.client[0]).result.structuredContent.error.code, 'JSONRPC_DUPLICATE_ID');

    const preflight = JSON.parse(test.upstream[0]);
    test.session.serverLine(JSON.stringify({ jsonrpc: '2.0', id: preflight.id, result: tabListResult(2) }));
    await firstClose;
    assert.equal(test.upstream.length, 2, 'only the original close may be forwarded');
    assert.equal(JSON.parse(test.upstream[1]).id, 'same-close-id');
  }

  // An open but unresponsive upstream must not retain the close forever.
  {
    const test = harness({ tabCountQueryTimeoutMs: 10 });
    const closePromise = test.session.clientLine(call('stalled-list', 'browser_tabs', { action: 'close' }));
    const preflight = JSON.parse(test.upstream[0]);
    await closePromise;
    assert.equal(test.upstream.length, 1, 'a timed-out preflight must not forward the close');
    const blocked = JSON.parse(test.client[0]);
    assert.equal(blocked.id, 'stalled-list');
    assert.equal(blocked.result.structuredContent.error.code, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL');
    assert.match(blocked.result.content[0].text, /could not be confirmed/i);
    test.session.serverLine(JSON.stringify({ jsonrpc: '2.0', id: preflight.id, result: tabListResult(2) }));
    assert.equal(test.client.length, 1, 'a late internal response must remain hidden from the client');
  }

  // Part 2: a tool-level isError response must record its real message.
  {
    const test = harness();
    test.session.clientLine(call(210, 'browser_click', { element: 'Submit', ref: 'e1' }));
    test.session.serverLine(JSON.stringify({
      jsonrpc: '2.0', id: 210,
      result: { isError: true, content: [{ type: 'text', text: 'Element is not visible: button#submit' }] }
    }));
    const failed = test.events.find(event => event.action === 'playwright.tool.failed');
    assert.ok(failed, 'an isError tool result must record a failed outcome');
    assert.match(failed.details.error, /Element is not visible: button#submit/);
    assert.doesNotMatch(failed.details.error, /Playwright tool returned an error result\./,
      'the real upstream error text must replace the old generic placeholder');
  }

  // The extracted error text still passes through the existing URL-secret
  // redaction and length bound before it reaches the audit ledger.
  {
    const test = harness();
    test.session.clientLine(call(211, 'browser_navigate', { url: 'https://example.com/' }));
    test.session.serverLine(JSON.stringify({
      jsonrpc: '2.0', id: 211,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'Navigation failed: https://example.com/callback?state=leak-this-secret&safe=value' }]
      }
    }));
    const failed = test.events.find(event => event.action === 'playwright.tool.failed');
    assert.ok(failed);
    assert.doesNotMatch(failed.details.error, /leak-this-secret/, 'URL-bound secrets must be redacted before reaching the audit ledger');
    assert.match(failed.details.error, /state=\[REDACTED\]/);
    assert.match(failed.details.error, /safe=value/);
    assert.ok(failed.details.error.length <= 1000, 'the recorded error text must remain bounded');
  }

  // A protocol-level JSON-RPC error still uses its own message, unaffected by
  // the new result.content extraction path.
  {
    const test = harness();
    test.session.clientLine(call(212, 'browser_navigate', { url: 'https://example.com/' }));
    test.session.serverLine(JSON.stringify({
      jsonrpc: '2.0', id: 212, error: { code: -32000, message: 'upstream transport reset' }
    }));
    const failed = test.events.find(event => event.action === 'playwright.tool.failed');
    assert.ok(failed);
    assert.match(failed.details.error, /upstream transport reset/);
  }
}

testLiveTabCloseAndErrorExtraction().then(() => {
  console.log('Playwright gateway intent/outcome tests passed.');
}).catch(error => {
  process.exitCode = 1;
  console.error(error && error.stack || error);
});
